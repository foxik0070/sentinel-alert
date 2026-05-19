"""Sentinel Bridge — forwards events to Sentinel /api/v1/agent/ingest.

URL/token/hostname can be set via env vars (SENTINEL_URL, SENTINEL_TOKEN,
SENTINEL_AGENT_HOSTNAME) or at runtime via configure(). Settings are
persisted in data/sentinel.json so they survive restarts.
"""
import json
import os
import socket
from pathlib import Path

import conf as _conf

BASE_DIR = Path(__file__).resolve().parent
CFG_PATH = BASE_DIR / "data" / "sentinel.json"


def _load():
    if CFG_PATH.exists():
        try:
            return json.loads(CFG_PATH.read_text())
        except Exception:
            return {}
    return {}


_disk = _load()

SENTINEL_URL = (os.environ.get("SENTINEL_URL") or _disk.get("url") or _conf.SENTINEL_URL or "").rstrip("/") or None
SENTINEL_TOKEN = os.environ.get("SENTINEL_TOKEN") or _disk.get("token") or _conf.SENTINEL_TOKEN
SENTINEL_HOSTNAME = (os.environ.get("SENTINEL_AGENT_HOSTNAME")
                     or _disk.get("hostname")
                     or _conf.SENTINEL_HOSTNAME
                     or socket.gethostname())


def configure(url: str | None, token: str | None, hostname: str | None = None):
    """Update runtime config and persist to disk. Empty url disables."""
    global SENTINEL_URL, SENTINEL_TOKEN, SENTINEL_HOSTNAME
    SENTINEL_URL = (url or "").rstrip("/") or None
    SENTINEL_TOKEN = token or None
    if hostname:
        SENTINEL_HOSTNAME = hostname
    CFG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CFG_PATH.write_text(json.dumps({
        "url": SENTINEL_URL or "",
        "token": SENTINEL_TOKEN or "",
        "hostname": SENTINEL_HOSTNAME,
    }, indent=2))


def status():
    return {"url": SENTINEL_URL, "hostname": SENTINEL_HOSTNAME,
            "token_set": bool(SENTINEL_TOKEN), "enabled": bool(SENTINEL_URL),
            "configured": bool(SENTINEL_URL)}


async def ping():
    """Send a tiny health event; return (ok, status_code, message)."""
    if not SENTINEL_URL:
        return False, 0, "URL not set"
    try:
        import httpx
        import json as json_module

        headers = {
            "Authorization": f"Bearer {SENTINEL_TOKEN}" if SENTINEL_TOKEN else "",
            "Content-Type": "application/json"
        }
        payload = {
            "hostname": SENTINEL_HOSTNAME,
            "events": [{
                "plugin": "sentinel_alert",
                "check_name": "connectivity_test",
                "status": "ok",
                "message": "sentinel-alert connectivity test"
            }]
        }

        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(SENTINEL_URL, json=payload, headers=headers)

            # Expect HTTP 200 with {"status":"success","processed":1}
            if r.status_code == 200:
                try:
                    resp_json = r.json()
                    if resp_json.get("status") == "success":
                        return True, 200, f"OK - {resp_json.get('processed', 1)} events processed"
                except:
                    pass
                return True, 200, "OK"
            elif r.status_code == 401:
                return False, 401, "Unauthorized - check hostname or token"
            elif r.status_code == 400:
                return False, 400, "Bad request - invalid JSON or missing fields"
            else:
                return False, r.status_code, f"HTTP {r.status_code}: {r.text[:200]}"

    except Exception as e:
        return False, 0, f"Connection error: {str(e)}"


def _translate(event: dict):
    t = event.get("type")
    if t == "attack":
        return {
            "plugin": "fail2ban_honeypot",
            "check_name": "honeypot_hit",
            "status": "active",
            "message": (f"{(event.get('protocol') or '?').upper()} hit :"
                        f"{event.get('dst_port')} from {event.get('src_ip')} "
                        f"({event.get('country','?')}, {event.get('isp','?')})"),
            "details": event,
        }
    if t == "ban":
        return {
            "plugin": "fail2ban",
            "check_name": "fail2ban_ban",
            "status": "active",
            "message": (f"banned {event.get('src_ip')} on "
                        f"{event.get('source_host','?')} "
                        f"({event.get('country','?')})"),
            "details": event,
        }
    if t == "device":
        state = event.get("state")
        ports = ",".join(str(p) for p in (event.get("ports") or [])) or "none"
        name = event.get("hostname") or event.get("ip")
        if state == "new":
            return {"plugin": "port_security", "check_name": "lan_inventory",
                    "status": "active",
                    "message": f"NEW host {name} ({event.get('ip')}) ports={ports}",
                    "details": event}
        if state == "online":
            return {"plugin": "port_security", "check_name": "lan_inventory",
                    "status": "ok",
                    "message": f"host back online: {name} ({event.get('ip')})",
                    "details": event}
        if state == "offline":
            return {"plugin": "port_security", "check_name": "lan_inventory",
                    "status": "active",
                    "message": f"host offline: {name} ({event.get('ip')})",
                    "details": event}
    return None


async def send_heartbeat():
    """Send heartbeat ping to keep agent ONLINE in Sentinel. Call every 60 seconds."""
    if not SENTINEL_URL:
        return
    event = {
        "plugin": "sentinel_alert",
        "check_name": "heartbeat",
        "status": "ok",
        "message": "Sentinel-Alert heartbeat"
    }
    try:
        import httpx
        headers = {
            "Authorization": f"Bearer {SENTINEL_TOKEN}" if SENTINEL_TOKEN else "",
            "Content-Type": "application/json"
        }
        payload = {
            "hostname": SENTINEL_HOSTNAME,
            "events": [event]
        }
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(SENTINEL_URL, json=payload, headers=headers)
            if r.status_code == 200:
                print(f"bridge: heartbeat OK - agent {SENTINEL_HOSTNAME} is ONLINE")
            else:
                print(f"bridge: heartbeat failed: HTTP {r.status_code}")
    except Exception as e:
        print(f"bridge: heartbeat failed: {e}")


async def forward(event: dict):
    if not SENTINEL_URL:
        return
    payload = _translate(event)
    if not payload:
        return
    try:
        import httpx
        headers = {
            "Authorization": f"Bearer {SENTINEL_TOKEN}" if SENTINEL_TOKEN else "",
            "Content-Type": "application/json"
        }
        ingest_payload = {
            "hostname": SENTINEL_HOSTNAME,
            "events": [payload]
        }
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(SENTINEL_URL, json=ingest_payload, headers=headers)
            if r.status_code != 200:
                print(f"bridge: forward failed: HTTP {r.status_code}")
                if r.status_code == 401:
                    print("  → Check hostname and token in settings")
                elif r.status_code == 400:
                    print(f"  → Invalid payload: {payload}")
    except Exception as e:
        print(f"bridge: forward failed: {e}")
