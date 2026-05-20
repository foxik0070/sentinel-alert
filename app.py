import asyncio
import os
import random
import sqlite3
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Set

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import blocklist
import bridge
import conf
import db_init
import fsc
import geoip
import honeypot
import sniproxy
import tasks

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.path.join(BASE_DIR, "data", "alerts.db")

# Priority: env var > conf file > auto-detect
_env_lat = os.environ.get("SENTINEL_HOME_LAT")
_env_lon = os.environ.get("SENTINEL_HOME_LON")
_lat = float(_env_lat) if _env_lat else conf.HOME_LAT
_lon = float(_env_lon) if _env_lon else conf.HOME_LON
HOME_LAT = _lat if _lat else 49.8209
HOME_LON = _lon if _lon else 18.2625
HOME_IP = os.environ.get("SENTINEL_HOME_IP") or conf.HOME_IP or None
HOME_COUNTRY = None
HOME_ISP = None
HOME_AUTODETECT = not (_lat and _lon)


async def _detect_home():
    """Public-IP lookup → GeoIP → set HOME_*. Env values win when both set."""
    global HOME_IP, HOME_LAT, HOME_LON, HOME_COUNTRY, HOME_ISP
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as client:
            for url in ("https://api.ipify.org?format=json",
                        "https://ifconfig.co/json"):
                try:
                    r = await client.get(url)
                    ip = (r.json() or {}).get("ip")
                    if ip:
                        HOME_IP = HOME_IP or ip
                        break
                except Exception:
                    continue
    except Exception as e:
        print(f"home: public-IP lookup failed: {e}")
        return
    if not HOME_IP:
        return
    lat, lon, country, isp = geoip.lookup(HOME_IP)
    HOME_COUNTRY, HOME_ISP = country, isp
    if HOME_AUTODETECT and (lat or lon):
        HOME_LAT, HOME_LON = lat, lon
    print(f"HOME = {HOME_IP} ({HOME_COUNTRY}) @ {HOME_LAT},{HOME_LON}")

_clients: Set[WebSocket] = set()
_broadcast_queue: asyncio.Queue = asyncio.Queue(maxsize=2048)
_log_buffer: deque = deque(maxlen=400)


def _query(sql, params=()):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


async def _heartbeat_loop():
    """Send heartbeat to Sentinel every 60 seconds to keep agent ONLINE."""
    while True:
        await asyncio.sleep(60)
        await bridge.send_heartbeat()


async def _broadcaster():
    while True:
        ev = await _broadcast_queue.get()
        if ev.get("type") == "log":
            _log_buffer.append(ev)
        dead = []
        for ws in list(_clients):
            try:
                await ws.send_json(ev)
            except Exception:
                dead.append(ws)
        for ws in dead:
            _clients.discard(ws)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db_init.init()
    await _detect_home()
    await honeypot.start(_broadcast_queue,
                        ssh_port=conf.HONEYPOT_SSH_PORT,
                        http_port=conf.HONEYPOT_HTTP_PORT)
    fsc.start()
    blocklist.start()
    sniproxy.start(
        server=conf.SNIPROXY_SERVER,
        ssh_user=conf.SNIPROXY_SSH_USER,
        log_files=conf.SNIPROXY_LOG_FILES,
        ssh_key=os.path.join(BASE_DIR, "conf", "id_ed25519"),
    )

    def _sniproxy_attack(ev: dict):
        try:
            _broadcast_queue.put_nowait({**ev, "source": "proxy"})
            _broadcast_queue.put_nowait({
                "type": "log", "level": "attack", "source": "proxy",
                "ts": ev["ts"],
                "msg": f"{ev['protocol'].upper()} :{ev['dst_port']} ← {ev['src_ip']} ({ev.get('country','?')}) [{ev.get('domain','')}]",
            })
        except asyncio.QueueFull:
            pass

    sniproxy.set_attack_callback(_sniproxy_attack)
    bg = [
        asyncio.create_task(_broadcaster()),
        asyncio.create_task(_heartbeat_loop()),
        asyncio.create_task(tasks.periodic_scanner(_broadcast_queue)),
        asyncio.create_task(tasks.periodic_collector(_broadcast_queue)),
    ]
    _log_buffer.append({"type": "log", "level": "good", "source": "system",
                        "ts": datetime.now().isoformat(), "msg": "Sentinel-Alert online"})
    try:
        yield
    finally:
        for t in bg:
            t.cancel()


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/config")
def get_config():
    s = bridge.status()
    return {
        "home_lat": HOME_LAT, "home_lon": HOME_LON,
        "home_ip": HOME_IP, "home_country": HOME_COUNTRY, "home_isp": HOME_ISP,
        "sentinel_configured": s["configured"],
        "sentinel_enabled": s["enabled"],
        "sentinel_url": s["url"],
        "sentinel_hostname": s["hostname"],
        "sentinel_token_set": s["token_set"],
        # Feature flags for tab visibility
        "scanner_enabled": conf.SCANNER_ENABLED,
        "fsc_enabled": conf.FSC_ENABLED,
        "sniproxy_enabled": bool(conf.SNIPROXY_SERVER),
        "blocklist_enabled": bool(conf.BLOCKLIST_FILE),
        "blocklist_stats": blocklist.stats(),
    }


@app.post("/api/sentinel/configure")
async def sentinel_configure(payload: dict = Body(...)):
    bridge.configure(
        url=payload.get("url"),
        token=payload.get("token"),
        hostname=payload.get("hostname"),
    )
    ok, code, msg = await bridge.ping()
    return {"ok": ok, "status": code, "detail": msg, "config": bridge.status()}


@app.post("/api/sentinel/test")
async def sentinel_test():
    ok, code, msg = await bridge.ping()
    return {"ok": ok, "status": code, "detail": msg}


@app.get("/api/sentinel/debug")
def sentinel_debug():
    """Debug endpoint - show current config (safe, no secrets)."""
    return {
        "url": bridge.SENTINEL_URL,
        "url_len": len(bridge.SENTINEL_URL or ""),
        "hostname": bridge.SENTINEL_HOSTNAME,
        "hostname_len": len(bridge.SENTINEL_HOSTNAME or ""),
        "token_set": bool(bridge.SENTINEL_TOKEN),
        "token_len": len(bridge.SENTINEL_TOKEN or "") if bridge.SENTINEL_TOKEN else 0,
        "token_first_10": (bridge.SENTINEL_TOKEN or "")[:10] + "...",
    }


@app.post("/api/sentinel/reset")
def sentinel_reset():
    """Reset Sentinel configuration."""
    bridge.configure(url=None, token=None, hostname=None)
    return {"ok": True, "config": bridge.status()}


@app.get("/api/devices")
def get_devices():
    return _query(
        "SELECT mac, ip, hostname, vendor, first_seen, last_seen, is_online, ports "
        "FROM devices ORDER BY is_online DESC, last_seen DESC"
    )


@app.get("/api/device/{mac}")
def get_device(mac: str):
    result = _query(
        "SELECT mac, ip, hostname, vendor, first_seen, last_seen, is_online, ports, ports_checked_at "
        "FROM devices WHERE mac = ?", (mac,)
    )
    if not result:
        return JSONResponse({"error": "not found"}, status_code=404)
    return result[0]


@app.get("/api/attacks")
def get_attacks(limit: int = 200):
    return _query(
        "SELECT id, ts, src_ip, dst_port, protocol, country, lat, lon, isp "
        "FROM attacks WHERE lat != 0 OR lon != 0 "
        "ORDER BY id DESC LIMIT ?", (limit,),
    )


@app.get("/api/bans")
def get_bans(limit: int = 200):
    bans = _query(
        "SELECT ip, country, lat, lon, isp, timestamp FROM ban_history "
        "WHERE lat != 0 OR lon != 0 ORDER BY timestamp DESC LIMIT ?", (limit,),
    )
    # Add fail2ban-specific fields for display
    for b in bans:
        b["src_ip"] = b.get("ip")
        b["dst_port"] = 22
        b["protocol"] = "fail2ban"
    return bans


@app.get("/api/stats/countries")
def stats_countries():
    return _query(
        "SELECT country, COUNT(*) AS hits FROM attacks "
        "WHERE country NOT IN ('LAN','Unknown','Invalid','NoDB') "
        "GROUP BY country ORDER BY hits DESC LIMIT 20"
    )


@app.get("/api/logs")
def get_logs(limit: int = 200):
    return list(_log_buffer)[-limit:]


# Demo IPs for visual testing (real public ranges, geo-resolvable).
DEMO_IPS = [
    "1.1.1.1", "8.8.8.8", "77.88.8.8", "114.114.114.114",
    "200.160.2.3", "196.10.10.10", "210.7.32.5", "203.0.113.45",
    "185.220.101.1", "45.155.205.233",
]


@app.post("/api/demo/attack")
async def demo_attack(count: int = 5):
    """Inject N random demo attacks (for visual testing)."""
    out = []
    conn = sqlite3.connect(DB_PATH)
    try:
        for _ in range(max(1, min(count, 20))):
            ip = random.choice(DEMO_IPS)
            port = random.choice([22, 80, 443, 3389, 2222, 8080])
            proto = "ssh" if port in (22, 2222) else "http"
            lat, lon, country, isp = geoip.lookup(ip)
            ts = datetime.now().isoformat()
            conn.execute(
                "INSERT INTO attacks (ts, src_ip, dst_port, protocol, payload, "
                "country, lat, lon, isp) VALUES (?,?,?,?,?,?,?,?,?)",
                (ts, ip, port, proto, "demo", country, lat, lon, isp),
            )
            ev = {"ts": ts, "src_ip": ip, "dst_port": port, "protocol": proto,
                  "country": country, "lat": lat, "lon": lon, "isp": isp}
            out.append(ev)
            try:
                _broadcast_queue.put_nowait({"type": "attack", **ev})
                _broadcast_queue.put_nowait({
                    "type": "log", "level": "attack", "source": "demo",
                    "ts": ts, "msg": f"DEMO {proto.upper()} :{port} from {ip} ({country})"})
            except asyncio.QueueFull:
                pass
        conn.commit()
    finally:
        conn.close()
    return {"injected": len(out), "events": out}


@app.get("/api/topo-data")
def get_topo_data():
    try:
        import json
        with open(os.path.join(BASE_DIR, "data", "topo.json")) as f:
            return json.load(f)
    except:
        return {"nodes": [], "links": []}


@app.post("/api/topo-data")
async def save_topo_data(data: dict = Body(...)):
    try:
        import json
        os.makedirs(os.path.join(BASE_DIR, "data"), exist_ok=True)
        with open(os.path.join(BASE_DIR, "data", "topo.json"), "w") as f:
            json.dump(data, f, indent=2)
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/blocklist")
def get_blocklist():
    return {"entries": blocklist.get(), "stats": blocklist.stats()}


_NET_SETTINGS_FILE = os.path.join(BASE_DIR, "data", "net_settings.json")


def _load_net_settings() -> dict:
    try:
        import json
        with open(_NET_SETTINGS_FILE) as f:
            return json.load(f)
    except Exception:
        return {"notifications": {}}


def _save_net_settings(data: dict):
    import json
    os.makedirs(os.path.join(BASE_DIR, "data"), exist_ok=True)
    with open(_NET_SETTINGS_FILE, "w") as f:
        json.dump(data, f, indent=2)


@app.get("/api/network/settings")
def net_settings_get():
    return _load_net_settings()


@app.post("/api/network/settings")
async def net_settings_post(payload: dict = Body(...)):
    """Update device settings for a host MAC.
    Body: { mac, notify_connect, notify_disconnect, notify_new, type, parent_mac, parent_port }
    """
    mac = payload.get("mac", "").lower()
    if not mac:
        return JSONResponse({"error": "mac required"}, status_code=400)
    data = _load_net_settings()
    devices = data.setdefault("devices", {})
    existing = devices.get(mac, {})
    devices[mac] = {
        "notify_connect":    bool(payload.get("notify_connect",    existing.get("notify_connect",    True))),
        "notify_disconnect": bool(payload.get("notify_disconnect", existing.get("notify_disconnect", True))),
        "notify_new":        bool(payload.get("notify_new",        existing.get("notify_new",        True))),
        "type":        payload.get("type",        existing.get("type",        "host")),
        "parent_mac":  payload.get("parent_mac",  existing.get("parent_mac",  "")),
        "parent_port": payload.get("parent_port", existing.get("parent_port", "")),
    }
    _save_net_settings(data)
    return {"ok": True, "mac": mac, **devices[mac]}


@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    await ws.accept()
    _clients.add(ws)
    try:
        recent = _query(
            "SELECT id, ts, src_ip, dst_port, protocol, country, lat, lon, isp "
            "FROM attacks WHERE lat != 0 OR lon != 0 ORDER BY id DESC LIMIT 100"
        )
        bans = _query(
            "SELECT ip AS src_ip, country, lat, lon, isp, timestamp AS ts "
            "FROM ban_history WHERE lat != 0 OR lon != 0 ORDER BY timestamp DESC LIMIT 200"
        )
        # Mark bans with protocol for display
        for b in bans:
            b["dst_port"] = 22
            b["protocol"] = "fail2ban"
        await ws.send_json({"type": "snapshot",
                            "attacks": list(reversed(recent)),
                            "bans": list(reversed(bans)),
                            "logs": list(_log_buffer)})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _clients.discard(ws)


@app.get("/api/fsc/data")
def fsc_data():
    return fsc.data_store


@app.post("/api/fsc/scan")
def fsc_scan():
    import threading as _threading
    if not fsc.data_store["system"]["scan_in_progress"]:
        _threading.Thread(target=fsc.run_full_scan, daemon=True).start()
    return {"status": "started"}


@app.get("/api/fsc/hosts")
def fsc_hosts():
    return {"hosts": fsc.get_all_hosts_with_status()}


@app.post("/api/fsc/hosts/toggle")
async def fsc_hosts_toggle(payload: dict = Body(...)):
    ip = payload.get("ip", "")
    if not ip:
        return JSONResponse({"error": "ip required"}, status_code=400)
    enabled = fsc.toggle_host(ip)
    return {"ip": ip, "enabled": enabled}


@app.get("/api/sniproxy/data")
def sniproxy_data():
    return sniproxy.data_store


@app.get("/api/sniproxy/debug")
def sniproxy_debug():
    """Diagnostic: run SSH now, return raw lines + regex match info."""
    lines = sniproxy._fetch_lines(20)
    if lines is None:
        return {"ok": False, "error": sniproxy.data_store.get("last_error", "SSH failed"), "lines": []}
    sample = []
    for line in lines[:10]:
        m = sniproxy._PATTERN.search(line)
        sample.append({"line": line, "matched": bool(m)})
    return {
        "ok": True,
        "fetched": len(lines),
        "matched": sum(1 for l in lines if sniproxy._PATTERN.search(l)),
        "server": sniproxy._server,
        "ssh_user": sniproxy._ssh_user,
        "ssh_key": sniproxy._ssh_key,
        "log_files": sniproxy._log_files,
        "sample": sample,
    }


@app.post("/api/sniproxy/ban")
async def sniproxy_ban(payload: dict = Body(...)):
    import time as _time
    payload.setdefault("time", _time.strftime("%d.%m.%Y %H:%M:%S"))
    sniproxy.add_ban(payload)
    return {"ok": True}


@app.exception_handler(404)
async def not_found(_, __):
    return JSONResponse({"error": "not found"}, status_code=404)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=conf.SERVER_HOST, port=conf.SERVER_PORT, reload=False)
