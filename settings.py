"""User-toggleable runtime settings, persisted in data/settings.json."""
import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PATH = BASE_DIR / "data" / "settings.json"

DEFAULTS = {
    "lan_scan_enabled": True,
    "honeypot_enabled": True,
    "fail2ban_enabled": True,
}


def load() -> dict:
    if PATH.exists():
        try:
            data = json.loads(PATH.read_text())
            return {**DEFAULTS, **data}
        except Exception:
            pass
    return dict(DEFAULTS)


def save(updates: dict) -> dict:
    current = load()
    for k, v in (updates or {}).items():
        if k in DEFAULTS and isinstance(v, type(DEFAULTS[k])):
            current[k] = v
    PATH.parent.mkdir(parents=True, exist_ok=True)
    PATH.write_text(json.dumps(current, indent=2))
    return current
