"""Threat-intel blocklist import.

Stahuje veřejné blocklisty (blocklist.de, Spamhaus DROP, FireHOL level1),
drží set "known bad" IP a prefixů a poskytuje is_known_bad(ip).
Aktualizace každých 6 h na pozadí.
"""
import ipaddress
import threading
import time
import urllib.request

# name → URL (plain text, jedna IP/CIDR na řádek; komentáře ; nebo #)
FEEDS = {
    "blocklist.de": "https://lists.blocklist.de/lists/all.txt",
    "spamhaus-drop": "https://www.spamhaus.org/drop/drop.txt",
    "firehol-1": "https://iplists.firehol.org/files/firehol_level1.netset",
}

_lock = threading.Lock()
_ips: set = set()          # přesné IP
_nets: list = []           # ipaddress.ip_network prefixy
_meta: dict = {"enabled": False, "count": 0, "sources": {}, "updated": None}


def configure(enabled: bool):
    _meta["enabled"] = bool(enabled)


def _parse(text: str):
    ips, nets = set(), []
    for line in text.splitlines():
        line = line.strip()
        if not line or line[0] in ";#":
            continue
        token = line.split(";")[0].split()[0].strip()
        try:
            if "/" in token:
                nets.append(ipaddress.ip_network(token, strict=False))
            else:
                ipaddress.ip_address(token)
                ips.add(token)
        except ValueError:
            continue
    return ips, nets


def _fetch():
    all_ips, all_nets, sources = set(), [], {}
    for name, url in FEEDS.items():
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "sentinel-alert"})
            with urllib.request.urlopen(req, timeout=20) as r:
                ips, nets = _parse(r.read().decode("utf-8", "ignore"))
            all_ips |= ips
            all_nets += nets
            sources[name] = len(ips) + len(nets)
        except Exception as e:
            sources[name] = f"error: {e}"
    with _lock:
        _ips.clear()
        _ips.update(all_ips)
        _nets.clear()
        _nets.extend(all_nets)
        _meta["count"] = len(all_ips) + len(all_nets)
        _meta["sources"] = sources
        _meta["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    print(f"threatintel: loaded {_meta['count']} entries {sources}")


def is_known_bad(ip: str) -> bool:
    if not _meta["enabled"] or not ip:
        return False
    with _lock:
        if ip in _ips:
            return True
        if not _nets:
            return False
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return False
        return any(addr in n for n in _nets)


def stats() -> dict:
    with _lock:
        return dict(_meta)


def start(enabled: bool):
    configure(enabled)
    if not enabled:
        return

    def _worker():
        while True:
            _fetch()
            time.sleep(6 * 3600)

    threading.Thread(target=_worker, daemon=True).start()
