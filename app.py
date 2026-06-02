import asyncio
import hashlib
import hmac
import json as _json_mod
import os
import random
import socket
import sqlite3
import ssl
import time
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Set

from fastapi import Body, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import blocklist
import bridge
import conf
import db_init
import fsc
import geoip
import honeypot
import mikrotik
import pihole
import proxy_monitor
import tasks
import workmode

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
_proxy_attack_history: deque = deque(maxlen=500)  # last 24h proxy attacks
_loop: asyncio.AbstractEventLoop | None = None


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
    global _loop
    _loop = asyncio.get_event_loop()
    proxy_monitor.start(
        server=conf.PROXY_SERVER,
        ssh_user=conf.PROXY_SSH_USER,
        log_files=conf.PROXY_LOG_FILES,
        ssh_key=os.path.join(BASE_DIR, "conf", "id_ed25519"),
    )
    mikrotik.start(
        host=conf.MIKROTIK_HOST,
        ssh_user=conf.MIKROTIK_SSH_USER,
        ssh_key=os.path.join(BASE_DIR, "conf", "id_ed25519"),
    )
    pihole.start(
        hosts=conf.PIHOLE_HOSTS,
        primary=conf.PIHOLE_PRIMARY,
        password=conf.PIHOLE_PASSWORD,
    )

    def _sniproxy_attack(ev: dict):
        entry = {**ev, "source": "proxy"}
        _proxy_attack_history.append(entry)
        # Prune entries older than 24h
        from datetime import timedelta
        cutoff = datetime.now() - timedelta(hours=24)
        while _proxy_attack_history and _proxy_attack_history[0].get("ts", "") < cutoff.isoformat():
            _proxy_attack_history.popleft()
        # Persist to DB so events survive restarts (skip exact duplicates)
        try:
            conn = sqlite3.connect(DB_PATH)
            dup = conn.execute(
                "SELECT 1 FROM attacks WHERE ts=? AND src_ip=? AND dst_port=? AND protocol=? AND payload=?",
                (ev["ts"], ev["src_ip"], ev["dst_port"], ev["protocol"], ev.get("domain", "")),
            ).fetchone()
            if not dup:
                conn.execute(
                    "INSERT INTO attacks "
                    "(ts, src_ip, dst_port, protocol, payload, country, lat, lon, isp) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (ev["ts"], ev["src_ip"], ev["dst_port"], ev["protocol"],
                     ev.get("domain", ""), ev.get("country", ""),
                     ev.get("lat", 0), ev.get("lon", 0), ev.get("isp", "")),
                )
                conn.commit()
            conn.close()
        except Exception:
            pass
        try:
            _broadcast_queue.put_nowait(entry)
            _broadcast_queue.put_nowait({
                "type": "log", "level": "attack", "source": "proxy",
                "ts": ev["ts"],
                "msg": f"{ev['protocol'].upper()} :{ev['dst_port']} ← {ev['src_ip']} ({ev.get('country','?')}) [{ev.get('domain','')}]",
            })
        except asyncio.QueueFull:
            pass

    proxy_monitor.set_attack_callback(_sniproxy_attack)

    def _proxy_warn(ev: dict):
        try:
            _broadcast_queue.put_nowait(ev)
        except asyncio.QueueFull:
            pass
        asyncio.run_coroutine_threadsafe(bridge.forward(ev), _loop)

    proxy_monitor.set_warn_callback(_proxy_warn)

    async def _ban_watcher():
        """Watch ban_history and active_users for changes; emit log events."""
        import sqlite3 as _sl
        prev_bans: dict = {}   # proto -> total count
        prev_users: int = -1
        first_run = True
        while True:
            await asyncio.sleep(60)
            try:
                conn = _sl.connect(DB_PATH, timeout=10)
                ban_rows = conn.execute(
                    "SELECT COALESCE(protocol,'fail2ban') AS proto, COUNT(*) AS n "
                    "FROM ban_history GROUP BY proto"
                ).fetchall()
                user_count = conn.execute("SELECT COUNT(*) FROM active_users").fetchone()[0]
                conn.close()

                now = datetime.now().isoformat()

                # ban_history changes
                cur_bans = {p: n for p, n in ban_rows}
                def _emit(ev):
                    # broadcaster appends log-type events to _log_buffer; avoid double-add
                    try: _broadcast_queue.put_nowait(ev)
                    except asyncio.QueueFull: _log_buffer.append(ev)

                if first_run:
                    for proto, n in cur_bans.items():
                        _emit({"type": "log", "level": "info", "source": proto,
                               "ts": now, "msg": f"{n} {proto.upper()} ban(s) in DB"})
                else:
                    for proto, n in cur_bans.items():
                        diff = n - prev_bans.get(proto, 0)
                        if diff > 0:
                            _emit({"type": "log", "level": "attack", "source": proto,
                                   "ts": now, "msg": f"+{diff} new {proto.upper()} ban(s) added"})
                prev_bans = cur_bans

                # active_users changes
                if user_count != prev_users:
                    if prev_users >= 0:
                        diff = user_count - prev_users
                        sign = "+" if diff > 0 else ""
                        _emit({"type": "log", "level": "info", "source": "who",
                               "ts": now,
                               "msg": f"active users: {user_count} ({sign}{diff} change)"})
                    else:
                        _emit({"type": "log", "level": "good", "source": "who",
                               "ts": now, "msg": f"active users: {user_count} session(s)"})
                prev_users = user_count

                first_run = False
            except Exception:
                pass

    bg = [
        asyncio.create_task(_broadcaster()),
        asyncio.create_task(_heartbeat_loop()),
        asyncio.create_task(tasks.periodic_scanner(_broadcast_queue)),
        asyncio.create_task(tasks.periodic_collector(_broadcast_queue)),
        asyncio.create_task(tasks.enrich_unknown_isp(_broadcast_queue)),
        asyncio.create_task(tasks.periodic_who_collector(_broadcast_queue)),
        asyncio.create_task(_svc_bg_loop()),
        asyncio.create_task(_ban_watcher()),
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

# ── Auth helpers ──────────────────────────────────────────────────────────────
_AUTH_COOKIE = "sa_token"
_TOKEN_TTL   = 86400 * 7  # 7 days


def _make_token() -> str:
    ts = str(int(time.time()))
    sig = hmac.new(conf.AUTH_SECRET.encode(), ts.encode(), hashlib.sha256).hexdigest()
    return f"{ts}.{sig}"


def _verify_token(token: str | None) -> bool:
    if not token:
        return False
    try:
        ts_str, sig = token.rsplit(".", 1)
        if int(time.time()) - int(ts_str) > _TOKEN_TTL:
            return False
        expected = hmac.new(conf.AUTH_SECRET.encode(), ts_str.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, sig)
    except Exception:
        return False


def _is_authed(request: Request) -> bool:
    return _verify_token(request.cookies.get(_AUTH_COOKIE))


@app.post("/api/login")
def login(payload: dict = Body(...), response: Response = None):
    if (payload.get("username") == conf.AUTH_USERNAME
            and payload.get("password") == conf.AUTH_PASSWORD):
        token = _make_token()
        response.set_cookie(_AUTH_COOKIE, token, max_age=_TOKEN_TTL, httponly=True, samesite="lax")
        return {"ok": True}
    return JSONResponse({"ok": False, "error": "Invalid credentials"}, status_code=401)


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(_AUTH_COOKIE)
    return {"ok": True}


@app.get("/api/auth/status")
def auth_status(request: Request):
    return {"authenticated": _is_authed(request)}


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
        "sniproxy_enabled": bool(conf.PROXY_SERVER),
        "mikrotik_enabled": bool(conf.MIKROTIK_HOST),
        "pihole_enabled":   bool(conf.PIHOLE_HOSTS),
        "blocklist_enabled": bool(conf.BLOCKLIST_FILE or conf.MODE_IPS_FILE),
        "blocklist_stats": blocklist.stats(),
        # Work mode
        "work_mode": workmode.is_work(),
        "who_enabled": bool(conf.MODE_WHO_FILE),
    }


@app.get("/api/who")
def get_who():
    """Work mode: return users from WHO file."""
    return workmode.get_users()


@app.get("/api/active_users")
def get_active_users():
    """Work mode: return active users from DB (populated externally by who-collector)."""
    return _query("SELECT * FROM active_users ORDER BY timestamp DESC")


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


@app.delete("/api/device/{mac}")
async def delete_device(request: Request, mac: str):
    if not _is_authed(request):
        return JSONResponse({"error": "unauthorized"}, 401)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM devices WHERE mac = ?", (mac.lower(),))
    conn.commit()
    conn.close()
    data = _load_net_settings()
    data.get("devices", {}).pop(mac.lower(), None)
    _save_net_settings(data)
    return {"ok": True}


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
        "SELECT ip, country, lat, lon, isp, timestamp, protocol FROM ban_history "
        "WHERE lat != 0 OR lon != 0 ORDER BY timestamp DESC LIMIT ?", (limit,),
    )
    for b in bans:
        b["src_ip"] = b.get("ip")
        b["dst_port"] = b.get("dst_port") or (443 if b.get("protocol") == "https" else 22)
        b["protocol"] = b.get("protocol") or "fail2ban"
    return bans


@app.get("/api/stats/countries")
def stats_countries():
    bad = "LOWER(country) NOT IN ('lan','unknown','invalid','nodb','attack','sentinel','local','internal','?')"
    return _query(
        f"SELECT country, SUM(hits) AS hits FROM ("
        f"  SELECT country, COUNT(*) AS hits FROM attacks WHERE {bad} GROUP BY country"
        f"  UNION ALL"
        f"  SELECT country, COUNT(*) AS hits FROM ban_history WHERE {bad} GROUP BY country"
        f") GROUP BY country ORDER BY hits DESC LIMIT 20"
    )


@app.get("/api/logs")
def get_logs(limit: int = 200):
    return list(_log_buffer)[-limit:]


@app.get("/api/config/full")
def config_full(request: Request):
    if not _is_authed(request):
        return JSONResponse({"error": "unauthorized"}, 401)
    import configparser
    c = configparser.ConfigParser(interpolation=None)
    c.read(conf.CONF_PATH)
    result = {}
    for section in c.sections():
        result[section] = dict(c.items(section))
    return result


@app.post("/api/config/update")
async def config_update(request: Request, payload: dict = Body(...)):
    if not _is_authed(request):
        return JSONResponse({"error": "unauthorized"}, 401)
    import configparser
    c = configparser.ConfigParser(interpolation=None)
    c.read(conf.CONF_PATH)
    for section, keys in payload.items():
        if not c.has_section(section):
            c.add_section(section)
        for key, value in keys.items():
            c.set(section, key, str(value))
    try:
        os.makedirs(os.path.dirname(conf.CONF_PATH), exist_ok=True)
        with open(conf.CONF_PATH, "w") as f:
            c.write(f)
        return {"ok": True, "note": "Restart service for changes to take effect."}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.get("/api/config/export")
def config_export(request: Request):
    if not _is_authed(request):
        return JSONResponse({"error": "unauthorized"}, 401)
    from fastapi.responses import FileResponse as FR
    if os.path.exists(conf.CONF_PATH):
        return FR(conf.CONF_PATH, media_type="text/plain",
                  filename="sentinel-alert.conf")
    return JSONResponse({"error": "config file not found"}, status_code=404)


@app.get("/api/status")
def system_status(request: Request):
    if not _is_authed(request):
        return JSONResponse({"error": "unauthorized"}, 401)
    import os as _os
    geoip_ok  = _os.path.exists(geoip.GEOIP_PATH)
    asn_ok    = _os.path.exists(geoip.ASN_PATH)
    db_size   = _os.path.getsize(DB_PATH) if _os.path.exists(DB_PATH) else 0
    counts    = {}
    try:
        conn = sqlite3.connect(DB_PATH)
        counts["attacks"]     = conn.execute("SELECT COUNT(*) FROM attacks").fetchone()[0]
        counts["bans"]        = conn.execute("SELECT COUNT(*) FROM ban_history").fetchone()[0]
        counts["devices"]     = conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
        counts["unknown_isp"] = conn.execute(
            "SELECT COUNT(*) FROM attacks WHERE isp='Unknown'"
            " UNION ALL SELECT COUNT(*) FROM ban_history WHERE isp='Unknown'"
        ).fetchall()
        counts["unknown_isp"] = sum(r[0] for r in counts["unknown_isp"])
        conn.close()
    except Exception:
        pass
    sentinel = bridge.get_status() if hasattr(bridge, "get_status") else {}
    conf_path_exists = _os.path.exists(conf.CONF_PATH)
    isp_cache_size = len(geoip._isp_cache)
    return {
        "geoip": {
            "city_db":  "ok" if geoip_ok  else "missing",
            "asn_db":   "ok" if asn_ok    else "missing",
            "isp_cache": isp_cache_size,
            "unknown_isp_records": counts.get("unknown_isp", 0),
        },
        "database": {
            "path":    DB_PATH,
            "size_kb": round(db_size / 1024, 1),
            "attacks": counts.get("attacks", 0),
            "bans":    counts.get("bans", 0),
            "devices": counts.get("devices", 0),
        },
        "modules": {
            "scanner":         conf.SCANNER_ENABLED,
            "security_center": conf.FSC_ENABLED,
            "sniproxy":        bool(conf.PROXY_SERVER),
            "blocklist":       bool(conf.BLOCKLIST_FILE),
            "sentinel":        bool(conf.SENTINEL_URL),
        },
        "config_file": {
            "path":   conf.CONF_PATH,
            "exists": conf_path_exists,
        },
        "sentinel": sentinel,
    }


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
            if port in (22, 2222):
                proto = "ssh"
            elif port == 443:
                proto = "https"
            else:
                proto = "http"
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
        # Inject 2 demo fail2ban bans
        for _ in range(2):
            ip = random.choice(DEMO_IPS)
            lat, lon, country, isp = geoip.lookup(ip)
            ts = datetime.now().isoformat()
            conn.execute(
                "INSERT INTO ban_history (ip, country, lat, lon, isp, timestamp) VALUES (?,?,?,?,?,?)",
                (ip, country, lat, lon, isp, ts),
            )
            ban_ev = {"type": "ban", "src_ip": ip, "dst_port": 22, "protocol": "fail2ban",
                      "ts": ts, "country": country, "lat": lat, "lon": lon, "isp": isp}
            try:
                _broadcast_queue.put_nowait(ban_ev)
                _broadcast_queue.put_nowait({
                    "type": "log", "level": "attack", "source": "demo",
                    "ts": ts, "msg": f"DEMO FAIL2BAN :22 from {ip} ({country})"})
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


@app.get("/api/report/data")
def report_data():
    """Aggregate all data needed for PDF report generation."""
    from datetime import timedelta
    since_24h = (datetime.now() - timedelta(hours=24)).isoformat()
    attacks_24h = _query(
        "SELECT ts, src_ip, dst_port, protocol, country, isp FROM attacks "
        "WHERE ts >= ? ORDER BY ts DESC LIMIT 500", (since_24h,)
    )
    bans_24h = _query(
        "SELECT ip AS src_ip, country, isp, timestamp AS ts, protocol FROM ban_history "
        "WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 200", (since_24h,)
    )
    for b in bans_24h:
        b["dst_port"] = 443 if b.get("protocol") == "https" else 22
        b["protocol"] = b.get("protocol") or "fail2ban"
    countries = _query(
        "SELECT country, COUNT(*) AS hits FROM attacks "
        "WHERE ts >= ? AND country NOT IN ('LAN','Unknown','Invalid','NoDB') "
        "GROUP BY country ORDER BY hits DESC LIMIT 20", (since_24h,)
    )
    devices = _query(
        "SELECT mac, ip, hostname, vendor, is_online, last_seen, ports FROM devices "
        "ORDER BY is_online DESC, last_seen DESC"
    )
    return {
        "generated_at": datetime.now().isoformat(),
        "attacks_24h":  attacks_24h,
        "bans_24h":     bans_24h,
        "countries":    countries,
        "devices":      devices,
        "proxy":        proxy_monitor.data_store if conf.PROXY_SERVER else {},
        "fsc":          fsc.data_store      if conf.FSC_ENABLED else {},
        "logs":         list(_log_buffer)[-100:],
        "proxy_attacks_24h": list(_proxy_attack_history),
    }


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
        "hostname":          payload.get("hostname",          existing.get("hostname",          "")),
        "notify_connect":    bool(payload.get("notify_connect",    existing.get("notify_connect",    True))),
        "notify_disconnect": bool(payload.get("notify_disconnect", existing.get("notify_disconnect", True))),
        "notify_new":        bool(payload.get("notify_new",        existing.get("notify_new",        True))),
        "type":              payload.get("type",            existing.get("type",            "")),
        "parent_mac":        payload.get("parent_mac",      existing.get("parent_mac",      "")),
        "parent_port":       payload.get("parent_port",     existing.get("parent_port",     "")),
        "connection_type":   payload.get("connection_type", existing.get("connection_type", "ethernet")),
        "visualize":         bool(payload.get("visualize",   existing.get("visualize",   False))),
        "is_isp":            bool(payload.get("is_isp",      existing.get("is_isp",      False))),
    }
    _save_net_settings(data)
    return {"ok": True, "mac": mac, **devices[mac]}


@app.post("/api/virtual-switch")
async def virtual_switch_post(payload: dict = Body(...)):
    """Create or update a virtual switch. Body: { id?, hostname, ports }"""
    import time as _time
    data = _load_net_settings()
    switches = data.setdefault("virtual_switches", [])
    sw_id = payload.get("id") or f"vsw-{int(_time.time())}"
    sw = {
        "id": sw_id,
        "hostname": str(payload.get("hostname", "switch")),
        "ports": int(payload.get("ports", 8)),
        "parent_mac": str(payload.get("parent_mac", "")),
    }
    idx = next((i for i, s in enumerate(switches) if s["id"] == sw_id), None)
    if idx is not None:
        switches[idx] = sw
    else:
        switches.append(sw)
    _save_net_settings(data)
    return {"ok": True, "switch": sw}


@app.delete("/api/virtual-switch/{sw_id}")
async def virtual_switch_delete(sw_id: str):
    data = _load_net_settings()
    data["virtual_switches"] = [s for s in data.get("virtual_switches", []) if s["id"] != sw_id]
    _save_net_settings(data)
    return {"ok": True}


@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    await ws.accept()
    _clients.add(ws)
    try:
        recent = _query(
            "SELECT id, ts, src_ip, dst_port, protocol, country, lat, lon, isp "
            "FROM attacks WHERE ts >= datetime('now', '-24 hours') ORDER BY id DESC LIMIT 500"
        )
        bans = _query(
            "SELECT ip AS src_ip, country, lat, lon, isp, timestamp AS ts, protocol "
            "FROM ban_history WHERE timestamp >= datetime('now', '-24 hours') "
            "ORDER BY timestamp DESC LIMIT 500"
        )
        for b in bans:
            b["dst_port"] = 443 if b.get("protocol") == "https" else 22
            b["protocol"] = b.get("protocol") or "fail2ban"
        await ws.send_json({"type": "snapshot",
                            "attacks": list(reversed(recent)),
                            "bans": list(reversed(bans)),
                            "proxy_attacks": list(_proxy_attack_history),
                            "logs": list(_log_buffer)})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _clients.discard(ws)


_DB_TABLES = {
    "attacks":      ("id",       ["id","ts","src_ip","dst_port","protocol","country","isp","lat","lon"]),
    "ban_history":  ("rowid",    ["rowid","ip","country","isp","timestamp","lat","lon","protocol"]),
    "devices":      ("mac",      ["mac","ip","hostname","vendor","first_seen","last_seen","is_online"]),
    "active_users": ("username", ["username","ip","node","cluster","country","isp","timestamp"]),
}

@app.get("/api/db/{table}")
def db_table(table: str, request: Request, limit: int = 500, offset: int = 0,
             q: str = "", sort_col: str = "", sort_dir: str = "desc"):
    if not _is_authed(request):
        return JSONResponse({"error": "unauthorized"}, 401)
    if table not in _DB_TABLES:
        return JSONResponse({"error": "unknown table"}, 400)
    pk, cols = _DB_TABLES[table]
    col_list = ", ".join(cols)
    where = ""
    params: list = []
    if q:
        text_cols = [c for c in cols if c not in ("lat","lon","is_online","dst_port","id","rowid")]
        where = "WHERE " + " OR ".join(f"{c} LIKE ?" for c in text_cols)
        params = [f"%{q}%" for _ in text_cols]
    if sort_col and sort_col in cols:
        direction = "ASC" if sort_dir.lower() == "asc" else "DESC"
        order = f"ORDER BY {sort_col} {direction}"
    else:
        order = f"ORDER BY {pk} DESC"
    rows = _query(
        f"SELECT {col_list} FROM {table} {where} {order} LIMIT ? OFFSET ?",
        (*params, limit, offset)
    )
    total = _query(f"SELECT COUNT(*) AS n FROM {table} {where}", params)[0]["n"]
    return {"columns": cols, "rows": rows, "total": total, "pk": pk}


@app.delete("/api/db/{table}")
async def db_delete(table: str, request: Request, ids: list = Body(...)):
    if not _is_authed(request):
        return JSONResponse({"error": "unauthorized"}, 401)
    if table not in _DB_TABLES:
        return JSONResponse({"error": "unknown table"}, 400)
    pk, _ = _DB_TABLES[table]
    if not ids:
        return {"deleted": 0}
    placeholders = ",".join("?" * len(ids))
    conn = sqlite3.connect(DB_PATH)
    cur = conn.execute(f"DELETE FROM {table} WHERE {pk} IN ({placeholders})", ids)
    conn.commit()
    deleted = cur.rowcount
    conn.close()
    return {"deleted": deleted}


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
    return proxy_monitor.data_store


@app.get("/api/sniproxy/debug")
def sniproxy_debug():
    """Diagnostic: run SSH now, return raw lines + regex match info."""
    lines = proxy_monitor._fetch_lines(20)
    if lines is None:
        return {"ok": False, "error": proxy_monitor.data_store.get("last_error", "SSH failed"), "lines": []}
    sample = []
    for line in lines[:10]:
        m = proxy_monitor._PATTERN.search(line)
        sample.append({"line": line, "matched": bool(m)})
    return {
        "ok": True,
        "fetched": len(lines),
        "matched": sum(1 for l in lines if proxy_monitor._PATTERN.search(l)),
        "server": proxy_monitor._server,
        "ssh_user": proxy_monitor._ssh_user,
        "ssh_key": proxy_monitor._ssh_key,
        "log_files": proxy_monitor._log_files,
        "sample": sample,
    }


@app.post("/api/sniproxy/ban")
async def sniproxy_ban(payload: dict = Body(...)):
    import time as _time
    payload.setdefault("time", _time.strftime("%d.%m.%Y %H:%M:%S"))
    proxy_monitor.add_ban(payload)
    return {"ok": True}


# ── MikroTik ─────────────────────────────────────────────────────────────────

@app.get("/api/mikrotik/data")
def mikrotik_data():
    return mikrotik.data_store


@app.post("/api/mikrotik/block")
async def mikrotik_block(payload: dict = Body(...)):
    ip      = (payload.get("ip") or "").strip()
    comment = (payload.get("comment") or "sentinel").strip()
    timeout = (payload.get("timeout") or "1w").strip()
    if not ip:
        return JSONResponse({"ok": False, "error": "ip required"}, status_code=400)
    ok, err = mikrotik.block_ip(ip, comment, timeout)
    if ok:
        asyncio.run_coroutine_threadsafe(
            _notify_block(ip, comment, timeout), _loop
        )
    return {"ok": ok, "error": err if not ok else ""}


async def _notify_block(ip: str, comment: str, timeout: str):
    """Send block event to Sentinel bridge + broadcast to WS clients."""
    # Look up attacker info from DB
    rows = _query(
        "SELECT country, isp, lat, lon, protocol, dst_port, ts FROM attacks "
        "WHERE src_ip = ? ORDER BY ts DESC LIMIT 1", (ip,)
    )
    info = rows[0] if rows else {}
    ev = {
        "type":     "log",
        "level":    "warn",
        "source":   "mikrotik",
        "ts":       datetime.now(timezone.utc).isoformat(),
        "msg":      f"BLOCKED {ip} on MikroTik ({comment}, {timeout or 'permanent'})"
                    + (f" — {info.get('country','')} {info.get('isp','')}" if info else ""),
        "ip":       ip,
        "comment":  comment,
        "timeout":  timeout,
        "country":  info.get("country", ""),
        "isp":      info.get("isp", ""),
        "lat":      info.get("lat", 0),
        "lon":      info.get("lon", 0),
        "protocol": info.get("protocol", ""),
        "dst_port": info.get("dst_port", 0),
        "attacker_last_seen": info.get("ts", ""),
    }
    try:
        _broadcast_queue.put_nowait(ev)
    except asyncio.QueueFull:
        pass
    await bridge.forward(ev)


@app.post("/api/mikrotik/unblock")
async def mikrotik_unblock(payload: dict = Body(...)):
    ip = (payload.get("ip") or "").strip()
    if not ip:
        return JSONResponse({"ok": False, "error": "ip required"}, status_code=400)
    ok, err = mikrotik.unblock_ip(ip)
    return {"ok": ok, "error": err if not ok else ""}


@app.post("/api/mikrotik/rule/toggle")
async def mikrotik_rule_toggle(payload: dict = Body(...)):
    rule_type = (payload.get("type") or "").strip()
    index     = payload.get("index")
    enable    = bool(payload.get("enable", True))
    if rule_type not in ("filter", "nat") or index is None:
        return JSONResponse({"ok": False, "error": "type and index required"}, status_code=400)
    ok, err = mikrotik.toggle_rule(rule_type, int(index), enable)
    return {"ok": ok, "error": err if not ok else ""}


# ── PiHole ───────────────────────────────────────────────────────────────────

@app.get("/api/pihole/data")
def pihole_data():
    return pihole.data_store


# ── Service Monitor ───────────────────────────────────────────────────────────

import uuid as _uuid_mod

_SVC_PATH     = os.path.join(BASE_DIR, "data", "services.json")
_SVC_SETTINGS_PATH = os.path.join(BASE_DIR, "data", "svc_settings.json")

def _load_svc_settings() -> dict:
    try:
        with open(_SVC_SETTINGS_PATH) as f:
            return _json_mod.load(f)
    except Exception:
        return {}

def _save_svc_settings(cfg: dict):
    with open(_SVC_SETTINGS_PATH, "w") as f:
        _json_mod.dump(cfg, f, indent=2)

_svc_cfg = _load_svc_settings()
_svc_interval: int = int(_svc_cfg.get("interval_min", 5)) * 60

def _load_services() -> list:
    if os.path.exists(_SVC_PATH):
        try:
            with open(_SVC_PATH) as f:
                return _json_mod.load(f)
        except Exception:
            return []
    # Migrate from old domains.json
    old_path = os.path.join(os.path.dirname(_SVC_PATH), "domains.json")
    if os.path.exists(old_path):
        try:
            with open(old_path) as f:
                old = _json_mod.load(f)
            services = [_migrate_domain(d) for d in old]
            _save_services(services)
            return services
        except Exception:
            pass
    return []

def _migrate_domain(d: dict) -> dict:
    url = d.get("url", "")
    return {
        "id": str(_uuid_mod.uuid4()), "name": d.get("name", url),
        "type": "http", "target": url, "host": "", "port": None,
        "method": "GET", "expected_status": 200, "expected_text": "",
        "dns_query": "", "dns_server": "", "heartbeat_interval": 300,
        "ssl_verify": True, "enabled": True,
    }

def _save_services(services: list):
    os.makedirs(os.path.dirname(_SVC_PATH), exist_ok=True)
    with open(_SVC_PATH, "w") as f:
        _json_mod.dump(services, f, indent=2)

def _svc_db_store(service_id: str, status: str, response_ms, message: str = ""):
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO service_checks (service_id, ts, status, response_ms, message) VALUES (?,?,?,?,?)",
            (service_id, int(time.time()), status, response_ms, message),
        )
        cutoff = int(time.time()) - 30 * 86400
        cur.execute("DELETE FROM service_checks WHERE service_id=? AND ts<?", (service_id, cutoff))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"svc_db_store: {e}")

def _svc_db_history(service_id: str, limit: int = 50) -> list:
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute(
            "SELECT ts, status, response_ms FROM service_checks WHERE service_id=? ORDER BY ts DESC LIMIT ?",
            (service_id, limit),
        )
        rows = cur.fetchall()
        conn.close()
        return [{"ts": r[0], "status": r[1], "response_ms": r[2]} for r in reversed(rows)]
    except Exception:
        return []

def _svc_uptime(service_id: str, hours: int) -> float | None:
    try:
        cutoff = int(time.time()) - hours * 3600
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute(
            "SELECT status FROM service_checks WHERE service_id=? AND ts>=?",
            (service_id, cutoff),
        )
        rows = cur.fetchall()
        conn.close()
        if not rows:
            return None
        up = sum(1 for r in rows if r[0] == "up")
        return round(up / len(rows) * 100, 1)
    except Exception:
        return None

def _svc_last(service_id: str) -> dict | None:
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute(
            "SELECT ts, status, response_ms, message FROM service_checks WHERE service_id=? ORDER BY ts DESC LIMIT 1",
            (service_id,),
        )
        row = cur.fetchone()
        conn.close()
        if not row:
            return None
        return {"ts": row[0], "status": row[1], "response_ms": row[2], "message": row[3]}
    except Exception:
        return None

# ── Check functions ────────────────────────────────────────────────────────────

def _check_ssl_sync(hostname: str, port: int = 443, verify: bool = True) -> dict:
    ctx = ssl.create_default_context() if verify else ssl._create_unverified_context()
    try:
        with socket.create_connection((hostname, port), timeout=8) as sock:
            with ctx.wrap_socket(sock, server_hostname=hostname) as ssock:
                cert = ssock.getpeercert()
                tls_version = ssock.version()
                cipher_name = ssock.cipher()[0] if ssock.cipher() else ""
        not_after = datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
        not_before = datetime.strptime(cert["notBefore"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
        days_left = (not_after - datetime.now(timezone.utc)).days
        issuer = dict(x[0] for x in cert.get("issuer", []))
        subject = dict(x[0] for x in cert.get("subject", []))
        sans = [v for t, v in cert.get("subjectAltName", []) if t == "DNS"]
        return {
            "valid": True, "days_left": days_left,
            "not_before": not_before.strftime("%Y-%m-%d"),
            "not_after": not_after.strftime("%Y-%m-%d"),
            "issuer_org": issuer.get("organizationName", ""),
            "issuer_cn": issuer.get("commonName", ""),
            "subject_cn": subject.get("commonName", ""),
            "sans": sans[:8],
            "tls_version": tls_version,
            "cipher": cipher_name,
        }
    except ssl.SSLCertVerificationError as e:
        return {"valid": False, "error": str(e)}
    except Exception as e:
        return {"valid": False, "error": str(e)}

async def _check_http(svc: dict) -> dict:
    import urllib.request, urllib.error
    import ssl as _ssl_mod
    from urllib.parse import urlparse as _up
    url = (svc.get("target") or "").rstrip("/")
    method = (svc.get("method") or "GET").upper()
    exp_status = int(svc.get("expected_status") or 200)
    exp_text = svc.get("expected_text") or ""
    ssl_verify = svc.get("ssl_verify", True)
    result: dict = {"id": svc["id"], "type": svc.get("type", "http")}
    t0 = time.monotonic()
    try:
        loop = asyncio.get_running_loop()
        def _do():
            ctx = None if ssl_verify else _ssl_mod._create_unverified_context()
            req = urllib.request.Request(url, headers={"User-Agent": "sentinel-monitor/1.0"}, method=method)
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                body = resp.read(8192).decode("utf-8", errors="replace")
                svr = resp.headers.get("Server", "")
                xpb = resp.headers.get("X-Powered-By", "")
                return resp.status, resp.url, body, svr, xpb
        status_code, final_url, body, svr, xpb = await loop.run_in_executor(None, _do)
        result["status_code"] = status_code
        result["redirect_url"] = final_url if final_url != url else None
        status_ok = status_code == exp_status
        text_ok = (not exp_text) or (exp_text in body)
        result["up"] = status_ok and text_ok
        if not text_ok:
            result["message"] = f"text '{exp_text}' not found in body"
        elif not status_ok:
            result["message"] = f"expected {exp_status}, got {status_code}"
        else:
            result["message"] = f"HTTP {status_code}"
        result["server"] = svr
        result["x_powered_by"] = xpb
    except urllib.error.HTTPError as e:
        result["status_code"] = e.code
        result["up"] = False
        result["message"] = f"HTTP {e.code}"
        if e.headers:
            result["server"] = e.headers.get("Server", "")
            result["x_powered_by"] = e.headers.get("X-Powered-By", "")
    except Exception as e:
        result["up"] = False
        result["message"] = str(e)
    result["response_ms"] = round((time.monotonic() - t0) * 1000)
    try:
        p = _up(url)
        if p.scheme == "https":
            loop = asyncio.get_running_loop()
            result["ssl"] = await loop.run_in_executor(None, _check_ssl_sync, p.hostname, p.port or 443, ssl_verify)
    except Exception:
        pass
    return result


async def _check_security(url: str, ssl_verify: bool = True) -> list:
    """Check HTTP security headers and best practices. Returns [{name, status, detail}]."""
    import urllib.request, urllib.error
    import ssl as _ssl_mod
    from urllib.parse import urlparse as _up
    loop = asyncio.get_running_loop()

    def _fetch():
        ctx = None if ssl_verify else _ssl_mod._create_unverified_context()
        req = urllib.request.Request(url, headers={"User-Agent": "sentinel-security/1.0"}, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                hdrs = {k.lower(): v for k, v in resp.headers.items()}
                return hdrs, resp.status, resp.url
        except urllib.error.HTTPError as e:
            hdrs = {k.lower(): v for k, v in e.headers.items()} if e.headers else {}
            return hdrs, e.code, url

    try:
        hdrs, status, final_url = await loop.run_in_executor(None, _fetch)
    except Exception as e:
        return [{"name": "Connection", "status": "fail", "detail": str(e)}]

    findings = []
    is_https = _up(url).scheme == "https"

    # HTTPS redirect check (for http:// URLs)
    if not is_https:
        if final_url.startswith("https://"):
            findings.append({"name": "HTTPS Redirect", "status": "ok", "detail": f"→ {final_url}"})
        else:
            findings.append({"name": "HTTPS Redirect", "status": "fail", "detail": "no redirect to HTTPS"})

    # HSTS (only meaningful on HTTPS)
    hsts = hdrs.get("strict-transport-security", "")
    if is_https:
        if hsts:
            max_age = 0
            for part in hsts.split(";"):
                p = part.strip()
                if p.lower().startswith("max-age="):
                    try: max_age = int(p.split("=")[1])
                    except: pass
            st = "ok" if max_age >= 31536000 else "warn"
            findings.append({"name": "HSTS", "status": st, "detail": hsts[:80]})
        else:
            findings.append({"name": "HSTS", "status": "fail", "detail": "missing"})

    # X-Frame-Options
    xfo = hdrs.get("x-frame-options", "")
    csp_val = hdrs.get("content-security-policy", "")
    if xfo:
        findings.append({"name": "X-Frame-Options", "status": "ok", "detail": xfo})
    elif "frame-ancestors" in csp_val:
        findings.append({"name": "X-Frame-Options", "status": "ok", "detail": "covered by CSP frame-ancestors"})
    else:
        findings.append({"name": "X-Frame-Options", "status": "warn", "detail": "missing"})

    # X-Content-Type-Options
    xcto = hdrs.get("x-content-type-options", "")
    if "nosniff" in xcto.lower():
        findings.append({"name": "X-Content-Type-Options", "status": "ok", "detail": "nosniff"})
    else:
        findings.append({"name": "X-Content-Type-Options", "status": "warn", "detail": "missing"})

    # Content-Security-Policy
    if csp_val:
        findings.append({"name": "CSP", "status": "ok", "detail": csp_val[:100] + ("…" if len(csp_val) > 100 else "")})
    else:
        findings.append({"name": "CSP", "status": "warn", "detail": "missing"})

    # Referrer-Policy
    rp = hdrs.get("referrer-policy", "")
    if rp:
        findings.append({"name": "Referrer-Policy", "status": "ok", "detail": rp})
    else:
        findings.append({"name": "Referrer-Policy", "status": "warn", "detail": "missing"})

    # Server header (version disclosure)
    srv = hdrs.get("server", "")
    if srv:
        import re as _re
        if _re.search(r"\d+\.\d+", srv):
            findings.append({"name": "Server Header", "status": "warn", "detail": f"version exposed: {srv}"})
        else:
            findings.append({"name": "Server Header", "status": "ok", "detail": srv})

    # X-Powered-By (info disclosure)
    xpb = hdrs.get("x-powered-by", "")
    if xpb:
        findings.append({"name": "X-Powered-By", "status": "warn", "detail": f"exposes tech: {xpb}"})

    # Permissions-Policy
    pp = hdrs.get("permissions-policy", "") or hdrs.get("feature-policy", "")
    if pp:
        findings.append({"name": "Permissions-Policy", "status": "ok", "detail": pp[:80]})
    else:
        findings.append({"name": "Permissions-Policy", "status": "warn", "detail": "missing"})

    return findings

async def _check_tcp(svc: dict) -> dict:
    host = svc.get("host") or svc.get("target") or ""
    port = int(svc.get("port") or 80)
    result: dict = {"id": svc["id"], "type": "tcp"}
    t0 = time.monotonic()
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=5)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        result["up"] = True
        result["message"] = f"port {port} open"
    except asyncio.TimeoutError:
        result["up"] = False
        result["message"] = "timeout"
    except Exception as e:
        result["up"] = False
        result["message"] = str(e)
    result["response_ms"] = round((time.monotonic() - t0) * 1000)
    return result

async def _check_ping(svc: dict) -> dict:
    host = svc.get("host") or svc.get("target") or ""
    result: dict = {"id": svc["id"], "type": "ping"}
    t0 = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            "ping", "-c", "1", "-W", "2", host,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        ret = await asyncio.wait_for(proc.wait(), timeout=6)
        result["up"] = (ret == 0)
        result["message"] = "reachable" if ret == 0 else "no response"
    except asyncio.TimeoutError:
        result["up"] = False
        result["message"] = "timeout"
    except Exception as e:
        result["up"] = False
        result["message"] = str(e)
    result["response_ms"] = round((time.monotonic() - t0) * 1000)
    return result

async def _check_dns(svc: dict) -> dict:
    query = svc.get("dns_query") or svc.get("host") or svc.get("target") or ""
    dns_server = svc.get("dns_server") or ""
    result: dict = {"id": svc["id"], "type": "dns"}
    t0 = time.monotonic()
    try:
        if dns_server:
            proc = await asyncio.create_subprocess_exec(
                "dig", "+short", f"@{dns_server}", query,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            out = stdout.decode().strip()
            result["up"] = bool(out)
            result["message"] = out.split("\n")[0][:80] if out else "no answer"
        else:
            loop = asyncio.get_running_loop()
            addrs = await asyncio.wait_for(
                loop.run_in_executor(None, socket.getaddrinfo, query, None), timeout=5
            )
            result["up"] = bool(addrs)
            result["message"] = addrs[0][4][0] if addrs else "no answer"
    except asyncio.TimeoutError:
        result["up"] = False
        result["message"] = "timeout"
    except Exception as e:
        result["up"] = False
        result["message"] = str(e)
    result["response_ms"] = round((time.monotonic() - t0) * 1000)
    return result

_heartbeat_last: dict[str, float] = {}

async def _check_heartbeat(svc: dict) -> dict:
    svc_id = svc["id"]
    interval = int(svc.get("heartbeat_interval") or 300)
    result: dict = {"id": svc_id, "type": "heartbeat"}
    last = _heartbeat_last.get(svc_id)
    if last:
        age = int(time.time() - last)
        result["up"] = age <= interval * 1.5
        result["message"] = f"last ping {age}s ago (max {int(interval * 1.5)}s)"
        result["response_ms"] = age * 1000
    else:
        result["up"] = False
        result["message"] = "no heartbeat received yet"
        result["response_ms"] = None
    return result

async def _run_check(svc: dict) -> dict:
    t = svc.get("type", "http")
    if t in ("http", "https"):
        return await _check_http(svc)
    if t == "tcp":
        return await _check_tcp(svc)
    if t == "ping":
        return await _check_ping(svc)
    if t == "dns":
        return await _check_dns(svc)
    if t == "heartbeat":
        return await _check_heartbeat(svc)
    return {"id": svc["id"], "up": False, "message": f"unknown type: {t}"}

_svc_prev_state: dict[str, str] = {}

async def _store_check_result(svc: dict, result: dict):
    svc_id = svc["id"]
    up = result.get("up", False)
    status = "up" if up else "down"
    msg = result.get("message") or ""
    rms = result.get("response_ms")
    _svc_db_store(svc_id, status, rms, msg)
    # Security scan for HTTP/HTTPS services (stored in last_result.security)
    if svc.get("type") in ("http", "https") and up and svc.get("target"):
        try:
            result["security"] = await _check_security(svc["target"], bool(svc.get("ssl_verify", True)))
        except Exception as _sec_err:
            print(f"security scan failed for {svc.get('target')}: {_sec_err}")
    # Update last_result in services.json
    services = _load_services()
    for s in services:
        if s["id"] == svc_id:
            s["last_result"] = {k: v for k, v in result.items() if k != "id"}
            s["last_checked"] = int(time.time())
            break
    _save_services(services)
    # Bridge notification on state change
    prev = _svc_prev_state.get(svc_id)
    if prev is not None and prev != status:
        await bridge.forward({
            "type": "service",
            "service_id": svc_id,
            "service_name": svc.get("name", svc_id),
            "service_type": svc.get("type", "http"),
            "target": svc.get("target") or svc.get("host", ""),
            "state": status,
            "message": msg,
        })
    _svc_prev_state[svc_id] = status

async def _svc_bg_loop():
    global _svc_interval
    while True:
        await asyncio.sleep(_svc_interval)
        try:
            services = _load_services()
            enabled = [s for s in services if s.get("enabled", True)]
            if enabled:
                results = await asyncio.gather(*[_run_check(s) for s in enabled], return_exceptions=True)
                for svc, res in zip(enabled, results):
                    if isinstance(res, Exception):
                        res = {"id": svc["id"], "up": False, "message": str(res)}
                    await _store_check_result(svc, res)
        except Exception as e:
            print(f"svc_bg_loop: {e}")

# ── Service API ───────────────────────────────────────────────────────────────

@app.get("/api/services")
async def services_list():
    services = _load_services()
    out = []
    for s in services:
        entry = dict(s)
        entry["last_check_db"] = _svc_last(s["id"])
        entry["uptime_24h"]    = _svc_uptime(s["id"], 24)
        entry["uptime_30d"]    = _svc_uptime(s["id"], 720)
        entry["spark"]         = _svc_db_history(s["id"], 50)
        out.append(entry)
    return out

@app.post("/api/services")
async def services_add(payload: dict = Body(...)):
    stype = (payload.get("type") or "http").lower()
    name  = (payload.get("name") or "").strip()
    if stype in ("http", "https"):
        target = (payload.get("target") or "").strip()
        if not target:
            return JSONResponse({"error": "target required"}, status_code=400)
        if not target.startswith(("http://", "https://")):
            target = f"{stype}://" + target
        payload["target"] = target
    elif stype in ("tcp", "ping", "dns"):
        if not (payload.get("host") or "").strip():
            return JSONResponse({"error": "host required"}, status_code=400)
    svc = {
        "id": str(_uuid_mod.uuid4()), "name": name or payload.get("target") or payload.get("host", ""),
        "type": stype, "target": payload.get("target", ""), "host": payload.get("host", ""),
        "port": payload.get("port"), "method": payload.get("method", "GET"),
        "expected_status": int(payload.get("expected_status") or 200),
        "expected_text": payload.get("expected_text", ""),
        "dns_query": payload.get("dns_query", ""), "dns_server": payload.get("dns_server", ""),
        "heartbeat_interval": int(payload.get("heartbeat_interval") or 300),
        "ssl_verify": bool(payload.get("ssl_verify", True)),
        "enabled": True,
    }
    services = _load_services()
    services.append(svc)
    _save_services(services)
    return {"ok": True, "id": svc["id"]}

@app.post("/api/services/preview")
async def services_preview(payload: dict = Body(...)):
    """Run check + security scan on a service definition without saving."""
    stype = (payload.get("type") or "http").lower()
    target = (payload.get("target") or "").strip()
    if stype in ("http", "https") and target and not target.startswith(("http://", "https://")):
        target = f"{stype}://" + target
    svc = {
        "id": "preview",
        "name": payload.get("name", "preview"),
        "type": stype,
        "target": target,
        "host": (payload.get("host") or "").strip(),
        "port": payload.get("port"),
        "method": (payload.get("method") or "GET").upper(),
        "expected_status": int(payload.get("expected_status") or 200),
        "expected_text": payload.get("expected_text") or "",
        "dns_query": (payload.get("dns_query") or "").strip(),
        "dns_server": (payload.get("dns_server") or "").strip(),
        "heartbeat_interval": int(payload.get("heartbeat_interval") or 300),
        "ssl_verify": bool(payload.get("ssl_verify", True)),
        "enabled": True,
    }
    check_result = await _run_check(svc)
    security = []
    if stype in ("http", "https") and target:
        security = await _check_security(target, svc["ssl_verify"])
    return {"check": check_result, "security": security}

@app.delete("/api/services/{sid}")
async def services_delete(sid: str):
    services = _load_services()
    new = [s for s in services if s["id"] != sid]
    if len(new) == len(services):
        return JSONResponse({"error": "not found"}, status_code=404)
    _save_services(new)
    _svc_prev_state.pop(sid, None)
    _heartbeat_last.pop(sid, None)
    return {"ok": True}

@app.post("/api/services/check")
async def services_check_all():
    services = _load_services()
    enabled = [s for s in services if s.get("enabled", True)]
    results = await asyncio.gather(*[_run_check(s) for s in enabled], return_exceptions=True)
    out = []
    for svc, res in zip(enabled, results):
        if isinstance(res, Exception):
            res = {"id": svc["id"], "up": False, "message": str(res)}
        await _store_check_result(svc, res)
        out.append(res)
    return out

@app.post("/api/services/{sid}/check")
async def services_check_one(sid: str):
    services = _load_services()
    svc = next((s for s in services if s["id"] == sid), None)
    if not svc:
        return JSONResponse({"error": "not found"}, status_code=404)
    res = await _run_check(svc)
    await _store_check_result(svc, res)
    return res

@app.get("/api/services/settings")
async def svc_settings_get():
    cfg = _load_svc_settings()
    return {"interval_min": int(cfg.get("interval_min", 5))}

@app.post("/api/services/settings")
async def svc_settings_post(payload: dict = Body(...)):
    global _svc_interval
    cfg = _load_svc_settings()
    if "interval_min" in payload:
        mins = max(1, min(60, int(payload["interval_min"])))
        cfg["interval_min"] = mins
        _svc_interval = mins * 60
    _save_svc_settings(cfg)
    return {"ok": True, "interval_min": cfg["interval_min"]}

@app.post("/api/heartbeat/{sid}")
async def heartbeat_ping(sid: str):
    services = _load_services()
    if not any(s["id"] == sid and s.get("type") == "heartbeat" for s in services):
        return JSONResponse({"error": "not found"}, status_code=404)
    _heartbeat_last[sid] = time.time()
    return {"ok": True, "ts": int(_heartbeat_last[sid])}


@app.exception_handler(404)
async def not_found(_, __):
    return JSONResponse({"error": "not found"}, status_code=404)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=conf.SERVER_HOST, port=conf.SERVER_PORT, reload=False)
