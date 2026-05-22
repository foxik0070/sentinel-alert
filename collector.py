#!/usr/bin/env python3
"""Pulls fail2ban bans from a set of remote hosts over SSH.

Discovers hosts from /etc/hosts (loopback skipped). For each host, runs
`fail2ban-client status sshd`, parses banned IPs, enriches with GeoIP, and
upserts into ban_history.
"""
import os
import re
import socket
import sqlite3
import subprocess
from datetime import datetime

import conf
import geoip

sqlite3.register_adapter(datetime, lambda val: val.isoformat())

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "alerts.db")
SSH_KEY = os.path.join(BASE_DIR, "conf", "id_ed25519")
SSH_USER = os.environ.get("SENTINEL_SSH_USER") or conf.COLLECTOR_SSH_USER
HOSTS_FILE = os.environ.get("SENTINEL_HOSTS_FILE") or conf.COLLECTOR_HOSTS_FILE


def discover_hosts():
    """Return hostnames to poll.

    If collector.monitor_hosts is set in conf, use that list explicitly.
    Otherwise auto-discover from hosts_file (loopback/IPv6 skipped).
    """
    if conf.COLLECTOR_MONITOR_HOSTS:
        return list(conf.COLLECTOR_MONITOR_HOSTS)

    if not os.path.exists(HOSTS_FILE):
        return []
    hosts = []
    with open(HOSTS_FILE) as f:
        for raw in f:
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            ip, names = parts[0], parts[1:]
            if ip.startswith("127.") or ip.startswith("::") or ip.startswith("fe80") or ip.startswith("ff"):
                continue
            for name in names:
                if name in ("localhost",) or name.startswith("ip6-"):
                    continue
                hosts.append(name)
                break
    return hosts


def poll_host(host, timeout=5):
    """Return list of newly-recorded ban events for `host`.

    Skips IPs we've already enriched. Quietly returns [] on SSH/parse failure.
    """
    try:
        cmd = [
            "ssh", "-i", SSH_KEY,
            "-o", "BatchMode=yes",
            "-o", f"ConnectTimeout={timeout}",
            "-o", "StrictHostKeyChecking=accept-new",
            f"{SSH_USER}@{host}",
            "fail2ban-client status sshd",
        ]
        output = subprocess.check_output(
            cmd, stderr=subprocess.STDOUT, text=True, timeout=timeout + 3
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return []

    match = re.search(r"Banned IP list:\s*(.*)", output, re.DOTALL)
    if not match:
        return []
    ips = [ip.strip() for ip in match.group(1).split() if ip.strip()]
    if not ips:
        return []

    events = []
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    try:
        for ip in ips:
            cur.execute(
                "SELECT rowid, country FROM ban_history WHERE ip=? ORDER BY timestamp DESC LIMIT 1",
                (ip,),
            )
            row = cur.fetchone()
            if row and row[1] not in (None, "Unknown", "NoDB"):
                continue
            lat, lon, country, isp = geoip.lookup(ip)
            ts = datetime.now()
            if row:
                cur.execute(
                    "UPDATE ban_history SET lat=?, lon=?, country=?, isp=? WHERE rowid=?",
                    (lat, lon, country, isp, row[0]),
                )
            else:
                cur.execute(
                    "INSERT INTO ban_history (ip, country, lat, lon, isp, timestamp) "
                    "VALUES (?,?,?,?,?,?)",
                    (ip, country, lat, lon, isp, ts),
                )
            events.append({
                "ts": ts.isoformat(),
                "src_ip": ip,
                "dst_port": 22,
                "protocol": "fail2ban",
                "country": country,
                "lat": lat,
                "lon": lon,
                "isp": isp,
                "source_host": host,
            })
        conn.commit()
    finally:
        conn.close()
    return events


def poll_host_with_log(host):
    """Return (ban_events, log_event) for a host. log_event always present."""
    try:
        events = poll_host(host)
    except Exception as e:
        return [], {"type": "log", "level": "warn", "source": "fail2ban",
                    "msg": f"{host}: error {e}"}
    if events:
        return events, {"type": "log", "level": "attack", "source": "fail2ban",
                        "msg": f"{host}: {len(events)} new ban(s) — "
                               + ", ".join(e["src_ip"] for e in events[:3])
                               + ("…" if len(events) > 3 else "")}
    return [], None  # silent on hosts with no new data


def _parse_who(output, node):
    """Parse `who` output, return list of {username, ip, node} dicts."""
    sessions = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        username = parts[0]
        src = None
        for p in reversed(parts):
            if p.startswith('(') and p.endswith(')') and len(p) > 2:
                src = p[1:-1]
                break
        if not src or src.startswith(':'):  # :0, :1 = local console/display
            continue
        ip = src
        if not re.match(r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$', src):
            try:
                ip = socket.gethostbyname(src)
            except Exception:
                continue
        sessions.append({'username': username, 'ip': ip, 'node': node})
    return sessions


def poll_local_sessions():
    """Return active SSH sessions on the local machine."""
    try:
        out = subprocess.check_output(['who'], text=True, timeout=5,
                                      stderr=subprocess.DEVNULL)
        return _parse_who(out, socket.gethostname())
    except Exception:
        return []


def poll_active_sessions(host):
    """Return active SSH sessions on a remote host via `who` over SSH."""
    try:
        cmd = [
            "ssh", "-i", SSH_KEY,
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=5",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR",
            f"{SSH_USER}@{host}",
            "who",
        ]
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL,
                                      text=True, timeout=8)
        return _parse_who(out, host)
    except Exception:
        return []


def poll_all():
    total = 0
    for host in discover_hosts():
        evts = poll_host(host)
        if evts:
            print(f"{host}: {len(evts)} new ban(s)")
            total += len(evts)
    print(f"Done. {total} new ban event(s).")


if __name__ == "__main__":
    poll_all()
