"""Proxy Monitor — reads nginx stream access logs from a remote server via SSH.

Runs two daemon threads:
  - _poll_worker: every 5 s fetches new log lines via SSH, deduplicates, updates stats
  - _speed_worker: every 2 s computes KB/s metrics and appends to speed_history

Log format (nginx stream):
  1.2.3.4 [01/Jun/2026:18:38:37 +0000] "git.example.com" -> 192.168.1.212:443 15234/8432 0.456s
"""
import ipaddress
import json
import os
import re
import subprocess
import threading
import time

import geoip

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

_on_attack = None   # callback(dict) — set by app.py to push to WebSocket
_on_warn   = None   # callback(dict) — fires on connected state transitions
_prev_connected: bool | None = None


def set_attack_callback(fn):
    global _on_attack
    _on_attack = fn


def set_warn_callback(fn):
    global _on_warn
    _on_warn = fn


def _notify_status_change(connected: bool, error: str = ""):
    global _prev_connected
    if _prev_connected == connected:
        return
    prev, _prev_connected = _prev_connected, connected
    if prev is None:
        return  # skip initial state, don't spam on startup
    if _on_warn is None:
        return
    if not connected:
        _on_warn({"type": "log", "level": "warn", "source": "proxy",
                  "msg": f"nginx proxy unreachable ({_server}): {error}" if error
                         else f"nginx proxy connection lost ({_server})"})
    else:
        _on_warn({"type": "log", "level": "info", "source": "proxy",
                  "msg": f"nginx proxy reconnected ({_server})"})


def _is_external(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
        return not (a.is_private or a.is_loopback or a.is_link_local)
    except ValueError:
        return False

_STATS_FILE = os.path.join(BASE_DIR, "data", "proxy_stats.json")

_PATTERN = re.compile(
    r"(?P<src_ip>[0-9a-fA-F.:]+)\s+"
    r"\[(?P<date>\d{2}/\w+/\d{4}):(?P<time>\d{2}:\d{2}:\d{2})[^\]]*\]\s+"
    r'"(?P<domain>[^"]+)"\s+->\s+'
    r"(?P<dest_ip>[^:]+):(?P<dest_port>\d+)\s+"
    r"(?P<tx>\d+)/(?P<rx>\d+)\s+"
    r"(?P<duration>[0-9.]+)s"
)

data_store = {
    "total_tx": 0, "total_rx": 0,
    "last_tx": 0, "last_rx": 0, "last_conn": 0,
    "speed_tx": 0.0, "speed_rx": 0.0, "speed_conn": 0.0,
    "total_connections": 0,
    "top_domains": {}, "top_ips": {},
    "domain_stats": {},   # {domain: {"ext": int, "int": int}}
    "recent_connections": [],
    "bans": [],
    "speed_history": {"labels": [], "tx": [], "rx": [], "conn": []},
    "connected": False,
    "server": "",
    "last_error": "",
}

_lock = threading.Lock()
_seen: set = set()

_server = ""
_ssh_user = "root"
_ssh_key = ""
_log_files: list = []


def _fetch_lines(n=500):
    """Return list of lines on success, None on any SSH failure."""
    if not _server or not _log_files:
        return None
    files = " ".join(_log_files)
    cmd = [
        "ssh", "-i", _ssh_key,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        f"{_ssh_user}@{_server}",
        f"cat {files} 2>/dev/null | tail -n {n}",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            err = (r.stderr.strip() or f"SSH exit {r.returncode}")[:200]
            with _lock:
                data_store["connected"] = False
                data_store["last_error"] = err
            return None
        return r.stdout.splitlines()
    except Exception as e:
        with _lock:
            data_store["connected"] = False
            data_store["last_error"] = str(e)[:200]
        return None


def _process_lines(lines: list[str]) -> int:
    count = 0
    for line in lines:
        h = hash(line)
        if h in _seen:
            continue
        _seen.add(h)
        if len(_seen) > 20000:
            _seen.clear()

        m = _PATTERN.search(line)
        if not m:
            continue
        d = m.groupdict()
        tx, rx = int(d["tx"]), int(d["rx"])
        src_ip_for_check = d["src_ip"]
        if tx == 0 and rx == 0 and not _is_external(src_ip_for_check):
            continue
        domain = d["domain"] or d.get("dest_ip") or "unknown"
        src_ip = d["src_ip"]
        dest = f"{d['dest_ip']}:{d['dest_port']}"
        dest_port = int(d.get("dest_port") or 0)
        # nginx stream proxy listens exclusively on port 443 → all connections are HTTPS
        # dest_port is the upstream backend port, not the listener port
        proto = "https"

        now = time.time()
        conn = {
            "time": d["time"],
            "date": d["date"],
            "epoch": now,
            "src_ip": src_ip,
            "proxy_port": dest_port,
            "dest": dest,
            "domain": domain,
            "tx": tx,
            "rx": rx,
            "duration": d["duration"],
            "protocol": proto,
        }
        with _lock:
            data_store["total_tx"] += tx
            data_store["total_rx"] += rx
            data_store["total_connections"] += 1
            data_store["recent_connections"].insert(0, conn)
            if len(data_store["recent_connections"]) > 5000:
                data_store["recent_connections"].pop()

        # Push external connections as attack events for globe + log
        if _on_attack and _is_external(src_ip):
            try:
                lat, lon, country, isp = geoip.lookup(src_ip)
                if lat or lon:
                    ts = f"{d['date']}T{d['time']}"
                    _on_attack({
                        "type": "attack",
                        "ts": ts,
                        "src_ip": src_ip,
                        "dst_port": dest_port,
                        "protocol": proto,
                        "country": country,
                        "lat": lat, "lon": lon,
                        "isp": isp,
                        "domain": domain,
                    })
            except Exception:
                pass
        count += 1
    return count


def _load_stats():
    try:
        with open(_STATS_FILE) as f:
            s = json.load(f)
        with _lock:
            for k in ("total_tx", "total_rx", "total_connections", "bans"):
                if k in s:
                    data_store[k] = s[k]
    except Exception:
        pass


def _recompute_24h():
    """Prune connections older than 24h and recompute top_domains / top_ips. Lock must be held."""
    cutoff = time.time() - 86400
    data_store["recent_connections"] = [
        c for c in data_store["recent_connections"] if c.get("epoch", 0) >= cutoff
    ]
    top_d: dict = {}
    top_i: dict = {}
    dom_stats: dict = {}
    for c in data_store["recent_connections"]:
        d = c["domain"]
        ip = c["src_ip"]
        top_d[d] = top_d.get(d, 0) + c["tx"] + c["rx"]
        if ip not in top_i:
            top_i[ip] = {"tx": 0, "rx": 0, "hits": 0}
        top_i[ip]["tx"] += c["tx"]
        top_i[ip]["rx"] += c["rx"]
        top_i[ip]["hits"] += 1
        if d not in dom_stats:
            dom_stats[d] = {"ext": 0, "int": 0}
        if _is_external(ip):
            dom_stats[d]["ext"] += 1
        else:
            dom_stats[d]["int"] += 1
    data_store["top_domains"] = top_d
    data_store["top_ips"] = top_i
    data_store["domain_stats"] = dom_stats


def save_state():
    """Jednorázový flush stavu na disk (volá se i při graceful shutdown)."""
    try:
        with _lock:
            snapshot = {k: data_store[k] for k in
                        ("total_tx", "total_rx", "total_connections", "bans")}
        os.makedirs(os.path.dirname(_STATS_FILE), exist_ok=True)
        with open(_STATS_FILE, "w") as f:
            json.dump(snapshot, f)
    except Exception:
        pass


def _save_stats():
    while True:
        time.sleep(60)
        save_state()


def _poll_worker():
    lines = _fetch_lines(1000)
    if lines is not None:
        _process_lines(lines)
        with _lock:
            data_store["connected"] = True
            data_store["last_error"] = ""
            _recompute_24h()
    _notify_status_change(lines is not None,
                          data_store.get("last_error", "") if lines is None else "")

    while True:
        time.sleep(5)
        lines = _fetch_lines(200)
        if lines is not None:
            _process_lines(lines)
        with _lock:
            if lines is not None:
                data_store["connected"] = True
                data_store["last_error"] = ""
            _recompute_24h()
        _notify_status_change(lines is not None,
                              data_store.get("last_error", "") if lines is None else "")


def _speed_worker():
    first = True
    while True:
        time.sleep(2)
        with _lock:
            ctx = data_store["total_tx"]
            crx = data_store["total_rx"]
            cconn = data_store["total_connections"]
            if first:
                data_store["last_tx"] = ctx
                data_store["last_rx"] = crx
                data_store["last_conn"] = cconn
                first = False
            else:
                data_store["speed_tx"] = round((ctx - data_store["last_tx"]) / 1024 / 2, 2)
                data_store["speed_rx"] = round((crx - data_store["last_rx"]) / 1024 / 2, 2)
                data_store["speed_conn"] = round((cconn - data_store["last_conn"]) / 2, 1)
                data_store["last_tx"] = ctx
                data_store["last_rx"] = crx
                data_store["last_conn"] = cconn

                ts = time.strftime("%H:%M:%S")
                h = data_store["speed_history"]
                h["labels"].append(ts)
                h["tx"].append(data_store["speed_tx"])
                h["rx"].append(data_store["speed_rx"])
                h["conn"].append(data_store["speed_conn"])
                if len(h["labels"]) > 40:
                    for k in ("labels", "tx", "rx", "conn"):
                        h[k].pop(0)


def add_ban(ban_dict: dict):
    """Called by fail2ban webhook or collector to register a new ban."""
    with _lock:
        data_store["bans"].insert(0, ban_dict)
        data_store["bans"] = data_store["bans"][:50]


def start(server: str, ssh_user: str, log_files: list, ssh_key: str):
    global _server, _ssh_user, _log_files, _ssh_key
    _server = server
    _ssh_user = ssh_user
    _log_files = log_files if isinstance(log_files, list) else [log_files]
    _ssh_key = ssh_key
    data_store["server"] = server

    if not _server:
        data_store["last_error"] = "No proxy server configured — set proxy.server in sentinel-alert.conf"
        return

    _load_stats()
    threading.Thread(target=_poll_worker,  daemon=True).start()
    threading.Thread(target=_speed_worker, daemon=True).start()
    threading.Thread(target=_save_stats,   daemon=True).start()
    print(f"proxy: monitoring {_server} logs: {', '.join(_log_files)}")
