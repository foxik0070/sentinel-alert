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
_cfg = {"enabled": False, "ntfy_url": "", "telegram_token": "", "telegram_chat": "",
        "slack_webhook": "", "discord_webhook": "", "rocketchat_webhook": "",
        "smtp_host": "", "smtp_port": 587, "smtp_user": "", "smtp_pass": "", "smtp_to": "",
        "syslog_host": "", "syslog_port": 514}
_wl_cache = {"mtime": -1.0, "items": []}


def configure(**kwargs):
    """Aktualizuje konfiguraci alerting kanálů (jen známé klíče)."""
    for k, v in kwargs.items():
        if k in _cfg:
            _cfg[k] = v


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
    if _cfg["slack_webhook"]:
        _post_json(_cfg["slack_webhook"], {"text": f"*{title}*\n{message}"})
    if _cfg["discord_webhook"]:
        _post_json(_cfg["discord_webhook"], {"content": f"**{title}**\n{message}"})
    if _cfg["rocketchat_webhook"]:
        _post_json(_cfg["rocketchat_webhook"], {"text": f"*{title}*\n{message}"})
    if _cfg["smtp_host"] and _cfg["smtp_to"]:
        _send_email(title, message)
    if _cfg["syslog_host"]:
        _send_syslog(title, message)


def _send_email(title: str, message: str):
    import smtplib
    from email.message import EmailMessage
    try:
        msg = EmailMessage()
        msg["Subject"] = f"[Sentinel-Alert] {title}"
        msg["From"] = _cfg["smtp_user"] or "sentinel@localhost"
        msg["To"] = _cfg["smtp_to"]
        msg.set_content(message)
        with smtplib.SMTP(_cfg["smtp_host"], int(_cfg["smtp_port"]), timeout=15) as s:
            s.starttls()
            if _cfg["smtp_user"]:
                s.login(_cfg["smtp_user"], _cfg["smtp_pass"])
            s.send_message(msg)
    except Exception:
        pass


def _send_syslog(title: str, message: str):
    # RFC 5424 přes UDP; facility 16 (local0), severity 4 (warning) → pri 132
    import socket
    try:
        host = socket.gethostname()
        ts = __import__("time").strftime("%Y-%m-%dT%H:%M:%SZ", __import__("time").gmtime())
        pkt = f"<132>1 {ts} {host} sentinel-alert - - - {title}: {message}"
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.sendto(pkt.encode(), (_cfg["syslog_host"], int(_cfg["syslog_port"])))
    except Exception:
        pass


def _post_json(url: str, payload: dict):
    try:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).close()
    except Exception:
        pass
