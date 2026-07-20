"""Response playbooky — pravidla → řetězce akcí na příchozí útoky.

Pravidlo: {name, enabled, match:{...}, actions:[...]}.
Match klíče (AND): known_bad(bool), watchlist(bool), protocol(str/list),
  country(str/list), min_hits(int — počet zásahů z IP za session).
Akce: "block" (MikroTik), "notify" (alerts), "tag" (log event), "webhook".
Uloženo v data/playbooks.json. Vyhodnocuje se na attack/ban event.

Callbacky (block/notify) injektuje app.py, aby modul neměl závislosti.
"""
import json
import os
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PLAYBOOKS_PATH = os.path.join(BASE_DIR, "data", "playbooks.json")

_lock = threading.Lock()
_cache = {"mtime": -1.0, "rules": []}
_hits: dict = {}  # ip -> počet zásahů (pro min_hits)

# callbacky injektované z app.py
_cb = {"block": None, "notify": None, "tag": None}


def set_callbacks(block=None, notify=None, tag=None):
    if block:  _cb["block"] = block
    if notify: _cb["notify"] = notify
    if tag:    _cb["tag"] = tag


def load_rules() -> list:
    try:
        m = os.path.getmtime(PLAYBOOKS_PATH)
    except OSError:
        return []
    if m != _cache["mtime"]:
        try:
            with open(PLAYBOOKS_PATH) as f:
                data = json.load(f)
            _cache.update(mtime=m, rules=data if isinstance(data, list) else [])
        except Exception:
            _cache.update(mtime=m, rules=[])
    return list(_cache["rules"])


def save_rules(rules: list):
    with _lock:
        os.makedirs(os.path.dirname(PLAYBOOKS_PATH), exist_ok=True)
        with open(PLAYBOOKS_PATH, "w") as f:
            json.dump(rules, f, indent=1)
    _cache["mtime"] = -1.0  # invalidace


def _as_list(v):
    if v is None:
        return None
    return v if isinstance(v, list) else [v]


def _matches(rule: dict, ev: dict, ip: str) -> bool:
    m = rule.get("match", {})
    if m.get("known_bad") and not ev.get("known_bad"):
        return False
    if m.get("watchlist") and not ev.get("_watched"):
        return False
    protos = _as_list(m.get("protocol"))
    if protos and (ev.get("protocol") or "") not in protos:
        return False
    countries = _as_list(m.get("country"))
    if countries and (ev.get("country") or "") not in countries:
        return False
    mh = m.get("min_hits")
    if mh and _hits.get(ip, 0) < int(mh):
        return False
    return True


def evaluate(ev: dict):
    """Vyhodnotí event proti pravidlům a spustí akce. Vrací seznam provedených akcí."""
    ip = ev.get("src_ip") or ev.get("ip") or ""
    if not ip:
        return []
    _hits[ip] = _hits.get(ip, 0) + 1
    if len(_hits) > 20000:
        _hits.clear()
    done = []
    for rule in load_rules():
        if not rule.get("enabled", True):
            continue
        if not _matches(rule, ev, ip):
            continue
        for action in rule.get("actions", []):
            try:
                if action == "block" and _cb["block"]:
                    _cb["block"](ip, "playbook:" + rule.get("name", "rule"))
                    done.append("block")
                elif action == "notify" and _cb["notify"]:
                    _cb["notify"]("PLAYBOOK " + rule.get("name", ""),
                                  f"{ip} — {ev.get('protocol', '?')} ({ev.get('country', '?')})")
                    done.append("notify")
                elif action == "tag" and _cb["tag"]:
                    _cb["tag"](ip, rule.get("name", "tagged"))
                    done.append("tag")
            except Exception:
                pass
    return done
