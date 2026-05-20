"""Blocked-IPs visualizer.

Reads a flat file (one IP per line) configured via threat.blocks_ips_file.
Enriches each IP with GeoIP + ASN data and serves the result via /api/blocklist.
Reloads automatically when the file changes (checked every 60 s).
"""
import os
import threading
import time

import conf as _conf
import geoip

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

_entries: list = []
_lock = threading.Lock()
_last_mtime: float = 0
_total: int = 0
MAX_GLOBE = 500  # max arcs shown on globe


def _read_ips_from_file(path: str) -> list[str]:
    """Return list of IPs from a flat file (one per line, # comments)."""
    if not path or not os.path.exists(path):
        return []
    with open(path) as f:
        return [l.strip() for l in f if l.strip() and not l.startswith("#")]


def _load():
    global _last_mtime, _entries, _total

    paths = [p for p in (_conf.BLOCKLIST_FILE, _conf.MODE_IPS_FILE) if p]
    if not paths:
        return

    # Reload only when any source file changed
    try:
        mtime = max(os.path.getmtime(p) for p in paths if os.path.exists(p))
    except ValueError:
        return  # no files exist yet
    if mtime == _last_mtime:
        return
    _last_mtime = mtime

    try:
        ips: list[str] = []
        for p in paths:
            ips.extend(_read_ips_from_file(p))

        _total = len(ips)
        entries = []
        for ip in ips:
            lat, lon, country, isp = geoip.lookup(ip)
            if lat == 0.0 and lon == 0.0:
                continue
            entries.append({
                "ip": ip, "src_ip": ip,
                "lat": lat, "lon": lon,
                "country": country, "isp": isp,
                "protocol": "fail2ban", "dst_port": 22,
            })
            if len(entries) >= MAX_GLOBE:
                break

        with _lock:
            _entries = entries
        print(f"blocklist: loaded {len(entries)} geo-resolved entries (total {_total})")
    except Exception as e:
        print(f"blocklist: load error: {e}")


def get() -> list:
    with _lock:
        return list(_entries)


def stats() -> dict:
    with _lock:
        return {"total": _total, "resolved": len(_entries)}


def start():
    if not _conf.BLOCKLIST_FILE and not _conf.MODE_IPS_FILE:
        return
    _load()
    def _worker():
        while True:
            time.sleep(60)
            _load()
    threading.Thread(target=_worker, daemon=True).start()
