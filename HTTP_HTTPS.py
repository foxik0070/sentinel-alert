#!/usr/bin/env python3
"""
SENTINEL HPC HTTP/HTTPS ATTACK EXTRACTOR + DB SYNC
============================================================
1. Queries Wazuh OpenSearch for last 24h HTTP/HTTPS attacks
2. Writes http-attacks.jsonl (atomic, rewritten each run)
3. Aggregates unique src_ip+protocol combos, geolocates them,
   and syncs into sentinel-alert ban_history (with protocol column)
4. Writes HTTP_IPS.log for blocklist backward-compat

Run from /root/sentinel-user/git via timer: .venv/bin/python HTTP_HTTPS.py
Env config: /etc/siem-test/siem.env
"""

import ipaddress
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from requests.auth import HTTPBasicAuth
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ── paths ──────────────────────────────────────────────────────────────────
BASE_DIR  = Path(__file__).parent          # /root/sentinel-user/git
SENTINEL  = BASE_DIR / "sentinel-alert"
DB_PATH   = SENTINEL / "data" / "alerts.db"
OUT_JSONL = BASE_DIR / "http-attacks.jsonl"
OUT_LOG   = BASE_DIR / "HTTP_IPS.log"
ENV_FILE  = "/etc/siem-test/siem.env"

# OpenSearch
ALERT_INDEX = "wazuh-alerts-*"
PAGE_SIZE   = 5000
SCROLL_TTL  = "2m"
LOOKBACK_H  = 24

sys.path.insert(0, str(SENTINEL))
try:
    import geoip as _geoip
    GEOIP_OK = True
except ImportError:
    GEOIP_OK = False


# ── helpers ────────────────────────────────────────────────────────────────

def _load_env() -> dict:
    if not os.path.exists(ENV_FILE):
        sys.exit(f"[FATAL] env file not found: {ENV_FILE}")
    env = {}
    for ln in open(ENV_FILE):
        ln = ln.strip()
        if not ln or ln.startswith("#") or "=" not in ln:
            continue
        k, v = ln.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def _is_public(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
        return not (addr.is_private or addr.is_loopback or addr.is_link_local
                    or addr.is_reserved or addr.is_unspecified)
    except ValueError:
        return False


def _build_query(since_iso: str) -> dict:
    return {
        "size": PAGE_SIZE,
        "_source": [
            "@timestamp", "agent.name",
            "data.srcip", "data.dstip", "data.srcport", "data.dstport",
            "data.action", "data.url", "data.protocol",
            "rule.id", "rule.level", "rule.groups", "rule.description",
            "full_log",
        ],
        "sort": [{"@timestamp": {"order": "asc"}}],
        "query": {
            "bool": {
                "must": [{"range": {"@timestamp": {"gte": since_iso}}}],
                "should": [
                    {"terms": {"rule.groups": ["web_appsec", "attack", "web", "modsecurity"]}},
                    {"bool": {"must": [
                        {"term": {"rule.groups": "fortigate"}},
                        {"terms": {"data.dstport": ["80", "443"]}},
                    ]}},
                ],
                "minimum_should_match": 1,
            }
        },
    }


def _flatten(src: dict) -> dict:
    rule  = src.get("rule") or {}
    data  = src.get("data") or {}
    agent = src.get("agent") or {}
    dstport = data.get("dstport")
    protocol = None
    if dstport in ("80", 80):
        protocol = "http"
    elif dstport in ("443", 443):
        protocol = "https"
    raw_method = data.get("protocol")
    full = src.get("full_log") or ""
    return {
        "ts":               src.get("@timestamp"),
        "agent":            agent.get("name"),
        "src_ip":           data.get("srcip"),
        "dst_ip":           data.get("dstip"),
        "src_port":         data.get("srcport"),
        "dst_port":         dstport,
        "protocol":         protocol,
        "http_method":      raw_method if raw_method and raw_method.upper() in (
            "GET","POST","HEAD","PUT","DELETE","PATCH","OPTIONS","CONNECT","TRACE"
        ) else None,
        "action":           data.get("action"),
        "url":              data.get("url"),
        "rule_id":          rule.get("id"),
        "rule_level":       rule.get("level"),
        "rule_groups":      rule.get("groups"),
        "rule_description": rule.get("description"),
        "full_log_snippet": full[:300] if full else None,
    }


# ── Step 1: OpenSearch → jsonl ─────────────────────────────────────────────

def fetch_and_write_jsonl(os_url: str, auth: HTTPBasicAuth, verify: bool) -> int:
    since   = (datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_H)).isoformat()
    headers = {"Content-Type": "application/json"}
    print(f"[INFO] fetching last {LOOKBACK_H}h from {os_url}")

    r = requests.post(
        f"{os_url}/{ALERT_INDEX}/_search?scroll={SCROLL_TTL}",
        auth=auth, headers=headers, json=_build_query(since),
        verify=verify, timeout=60,
    )
    r.raise_for_status()
    body      = r.json()
    scroll_id = body.get("_scroll_id")
    hits      = body.get("hits", {}).get("hits", [])
    total     = body.get("hits", {}).get("total", {}).get("value", 0)
    print(f"[INFO] OS reports {total} matching docs")

    tmp = OUT_JSONL.with_suffix(".jsonl.tmp")
    written = 0
    with open(tmp, "w") as f:
        while hits:
            for h in hits:
                rec = _flatten(h.get("_source", {}))
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                written += 1
            r = requests.post(
                f"{os_url}/_search/scroll",
                auth=auth, headers=headers,
                json={"scroll": SCROLL_TTL, "scroll_id": scroll_id},
                verify=verify, timeout=60,
            )
            r.raise_for_status()
            body      = r.json()
            scroll_id = body.get("_scroll_id")
            hits      = body.get("hits", {}).get("hits", [])

    try:
        requests.delete(
            f"{os_url}/_search/scroll",
            auth=auth, headers=headers,
            json={"scroll_id": [scroll_id]},
            verify=verify, timeout=15,
        )
    except Exception:
        pass

    os.replace(tmp, OUT_JSONL)
    size_mb = OUT_JSONL.stat().st_size / 1024 / 1024
    print(f"[OK] wrote {written} records ({size_mb:.2f} MB) → {OUT_JSONL}")
    return written


# ── Step 2: jsonl → geoip → ban_history ───────────────────────────────────

def _ensure_protocol_col(conn: sqlite3.Connection):
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(ban_history)")
    if "protocol" not in {r[1] for r in cur.fetchall()}:
        cur.execute("ALTER TABLE ban_history ADD COLUMN protocol TEXT")
        conn.commit()


def _aggregate_jsonl() -> dict:
    """Return {(ip, proto): latest_ts} for all public IPs with known protocol."""
    seen: dict = {}
    with open(OUT_JSONL) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ip    = rec.get("src_ip") or ""
            proto = rec.get("protocol") or ""
            if not ip or not proto or not _is_public(ip):
                continue
            ts  = rec.get("ts") or ""
            key = (ip, proto)
            if key not in seen or ts > seen[key]:
                seen[key] = ts
    return seen


def sync_to_db(seen: dict):
    if not GEOIP_OK:
        print("[WARN] geoip module unavailable — skipping DB sync")
        return
    if not DB_PATH.exists():
        print(f"[WARN] DB not found at {DB_PATH} — skipping DB sync")
        return

    print(f"[INFO] syncing {len(seen)} unique (ip, protocol) combos to DB")
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    _ensure_protocol_col(conn)
    cur = conn.cursor()
    now = datetime.now().isoformat()
    inserted = updated = skipped = 0

    for (ip, proto), _ts in seen.items():
        cur.execute(
            "SELECT rowid, lat, lon FROM ban_history WHERE ip = ? AND protocol = ?",
            (ip, proto),
        )
        row = cur.fetchone()
        if row:
            # Refresh timestamp so it stays in the 24h live window
            cur.execute("UPDATE ban_history SET timestamp = ? WHERE rowid = ?", (now, row[0]))
            updated += 1
        else:
            lat, lon, country, isp = _geoip.lookup(ip)
            if lat == 0.0 and lon == 0.0:
                skipped += 1
                continue
            cur.execute(
                "INSERT INTO ban_history "
                "(ip, country, lat, lon, isp, timestamp, protocol) VALUES (?,?,?,?,?,?,?)",
                (ip, country, lat, lon, isp, now, proto),
            )
            inserted += 1

    conn.commit()
    conn.close()
    print(f"[OK] DB sync: {inserted} new, {updated} refreshed, {skipped} unresolved")


# ── Step 3: write HTTP_IPS.log ─────────────────────────────────────────────

def write_http_ips_log(seen: dict):
    ts      = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    entries = sorted(f"{proto}:{ip}" for (ip, proto) in seen)
    tmp     = OUT_LOG.with_suffix(".log.tmp")
    with open(tmp, "w") as f:
        f.write(f"# Sentinel HTTP/HTTPS blocklist — {ts}\n")
        f.write(f"# {len(entries)} unique entries\n\n")
        for e in entries:
            f.write(e + "\n")
    os.replace(tmp, OUT_LOG)
    print(f"[OK] {len(entries)} entries → {OUT_LOG}")


# ── main ───────────────────────────────────────────────────────────────────

def main():
    env    = _load_env()
    os_url = env.get("SIEM_OPENSEARCH_URL", "https://10.5.21.21:9200")
    user   = env.get("SIEM_OPENSEARCH_USER", "apitester")
    pw     = env.get("SIEM_OPENSEARCH_PASS", "")
    verify = env.get("SIEM_VERIFY_SSL", "false").lower() in ("1", "true", "yes")
    if not pw:
        sys.exit("[FATAL] SIEM_OPENSEARCH_PASS not set")

    auth = HTTPBasicAuth(user, pw)

    try:
        fetch_and_write_jsonl(os_url, auth, verify)
    except requests.HTTPError as e:
        body = ""
        try:
            body = e.response.text[:400]
        except Exception:
            pass
        sys.exit(f"[FATAL] OpenSearch error: {e} | {body}")

    seen = _aggregate_jsonl()
    sync_to_db(seen)
    write_http_ips_log(seen)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.exit(f"[FATAL] {type(e).__name__}: {e}")
