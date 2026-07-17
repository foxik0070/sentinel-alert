"""Alerting engine + watchlist.

Watchlist: data/watchlist.json — pole položek: přesná IP ("1.2.3.4"),
prefix ("1.2.3.") nebo CIDR ("1.2.3.0/24").
Notifikace: ntfy (POST na topic URL) a/nebo Telegram bot — sekce [alerts] v konfiguraci.
"""
import ipaddress
import json
import os
import threading
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WATCHLIST_PATH = os.path.join(BASE_DIR, "data", "watchlist.json")

_lock = threading.Lock()
_cfg = {"enabled": False, "ntfy_url": "", "telegram_token": "", "telegram_chat": ""}
_wl_cache = {"mtime": -1.0, "items": []}


def configure(enabled=False, ntfy_url="", telegram_token="", telegram_chat=""):
    _cfg.update(enabled=enabled, ntfy_url=ntfy_url,
                telegram_token=telegram_token, telegram_chat=telegram_chat)


def load_watchlist() -> list:
    """Vrací watchlist; cache invalidovaná přes mtime souboru."""
    try:
        m = os.path.getmtime(WATCHLIST_PATH)
    except OSError:
        return []
    if m != _wl_cache["mtime"]:
        try:
            with open(WATCHLIST_PATH) as f:
                data = json.load(f)
            _wl_cache.update(mtime=m, items=data if isinstance(data, list) else [])
        except Exception:
            _wl_cache.update(mtime=m, items=[])
    return list(_wl_cache["items"])


def save_watchlist(items: list):
    with _lock:
        with open(WATCHLIST_PATH, "w") as f:
            json.dump(sorted({str(i).strip() for i in items if str(i).strip()}), f, indent=1)


def is_watched(ip: str) -> bool:
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for entry in load_watchlist():
        entry = str(entry).strip()
        if not entry:
            continue
        if "/" in entry:
            try:
                if addr in ipaddress.ip_network(entry, strict=False):
                    return True
            except ValueError:
                continue
        elif entry.endswith("."):
            if ip.startswith(entry):
                return True
        elif entry == ip:
            return True
    return False


def notify(title: str, message: str):
    """Fire-and-forget push — nikdy neblokuje volajícího."""
    if not _cfg["enabled"]:
        return
    threading.Thread(target=_notify_sync, args=(title, message), daemon=True).start()


def _notify_sync(title: str, message: str):
    if _cfg["ntfy_url"]:
        try:
            req = urllib.request.Request(
                _cfg["ntfy_url"], data=message.encode(),
                headers={"Title": title.encode("ascii", "ignore").decode(), "Priority": "high"})
            urllib.request.urlopen(req, timeout=10).close()
        except Exception:
            pass
    if _cfg["telegram_token"] and _cfg["telegram_chat"]:
        try:
            url = f"https://api.telegram.org/bot{_cfg['telegram_token']}/sendMessage"
            data = json.dumps({"chat_id": _cfg["telegram_chat"],
                               "text": f"{title}\n{message}"}).encode()
            req = urllib.request.Request(url, data=data,
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10).close()
        except Exception:
            pass
