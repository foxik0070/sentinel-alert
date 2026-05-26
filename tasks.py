"""Background periodic tasks. Started from app.py lifespan."""
import asyncio
import ipaddress
import json as _json
import os
import sqlite3
from datetime import datetime

import bridge
import collector
import conf
import geoip
import scanner

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "alerts.db")
_NET_SETTINGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "net_settings.json")


def _device_notify_allowed(mac: str, state: str) -> bool:
    if not mac:
        return True
    try:
        with open(_NET_SETTINGS_PATH) as f:
            cfg = _json.load(f).get("devices", {}).get(mac.lower(), {})
        if state == "online"  and not cfg.get("notify_connect",    True): return False
        if state == "offline" and not cfg.get("notify_disconnect",  True): return False
        if state == "new"     and not cfg.get("notify_new",         True): return False
    except Exception:
        pass
    return True

SCAN_INTERVAL = int(os.environ.get("SCAN_INTERVAL", "300"))
FAIL2BAN_INTERVAL = int(os.environ.get("FAIL2BAN_INTERVAL", "300"))
FAIL2BAN_CONCURRENCY = int(os.environ.get("FAIL2BAN_CONCURRENCY", "5"))


def _stamp(ev):
    ev.setdefault("ts", datetime.now().isoformat())
    return ev


async def _publish(queue: asyncio.Queue, event: dict):
    try:
        queue.put_nowait(_stamp(event))
    except asyncio.QueueFull:
        pass
    # Only forward non-log events to Sentinel.
    if event.get("type") != "log":
        asyncio.create_task(bridge.forward(event))


async def periodic_scanner(queue: asyncio.Queue):
    if not conf.SCANNER_ENABLED:
        return
    while True:
        try:
            events = await scanner.scan_async()
            skip_next_log = False
            for ev in events or []:
                if ev.get("type") == "device":
                    allowed = _device_notify_allowed(ev.get("mac", ""), ev.get("state", ""))
                    skip_next_log = not allowed
                    if not allowed:
                        continue
                elif ev.get("type") == "log" and skip_next_log:
                    skip_next_log = False
                    continue
                else:
                    skip_next_log = False
                await _publish(queue, ev)
        except Exception as e:
            await _publish(queue, {"type": "log", "level": "warn",
                                   "source": "scanner", "msg": f"loop error: {e}"})
        await asyncio.sleep(SCAN_INTERVAL)


async def _poll_one(host: str, sem: asyncio.Semaphore, queue: asyncio.Queue):
    loop = asyncio.get_running_loop()
    async with sem:
        bans, log = await loop.run_in_executor(None, collector.poll_host_with_log, host)
    for b in bans:
        await _publish(queue, {"type": "ban", **b})
    if log is not None:
        await _publish(queue, log)


async def enrich_unknown_isp(queue: asyncio.Queue):
    """One-shot: enrich DB rows missing isp or coordinates via ip-api.com, 1 per 2.5s."""
    loop = asyncio.get_running_loop()
    await asyncio.sleep(10)  # let the app fully start first
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            "SELECT 'attack', id, src_ip FROM attacks "
            "WHERE (isp='Unknown' OR lat=0) AND country NOT IN ('LAN','NoDB','Invalid')"
            " UNION ALL "
            "SELECT 'ban', rowid, ip FROM ban_history "
            "WHERE (isp='Unknown' OR lat=0) AND country NOT IN ('LAN','NoDB','Invalid')"
        ).fetchall()
        conn.close()
    except Exception as e:
        await _publish(queue, {"type": "log", "level": "warn", "source": "enrich", "msg": f"read failed: {e}"})
        return

    enriched = 0
    for table, row_id, ip in rows:
        full = await loop.run_in_executor(None, geoip._lookup_api_full, ip)
        if full:
            lat, lon, country, isp = full
            try:
                conn = sqlite3.connect(DB_PATH)
                if table == "attack":
                    conn.execute(
                        "UPDATE attacks SET lat=?, lon=?, country=?, isp=? WHERE id=?",
                        (lat, lon, country, isp, row_id))
                else:
                    conn.execute(
                        "UPDATE ban_history SET lat=?, lon=?, country=?, isp=? WHERE rowid=?",
                        (lat, lon, country, isp, row_id))
                conn.commit()
                conn.close()
                enriched += 1
            except Exception:
                pass
        await asyncio.sleep(2.5)

    if enriched:
        await _publish(queue, {"type": "log", "level": "info", "source": "enrich",
                               "msg": f"enriched {enriched} records with GeoIP data"})


async def periodic_collector(queue: asyncio.Queue):
    sem = asyncio.Semaphore(FAIL2BAN_CONCURRENCY)
    while True:
        try:
            hosts = collector.discover_hosts()
            if hosts:
                await asyncio.gather(*[_poll_one(h, sem, queue) for h in hosts])
        except Exception as e:
            await _publish(queue, {"type": "log", "level": "warn",
                                   "source": "fail2ban", "msg": f"loop error: {e}"})
        await asyncio.sleep(FAIL2BAN_INTERVAL)


async def _who_one(host: str, sem: asyncio.Semaphore) -> list:
    loop = asyncio.get_running_loop()
    async with sem:
        return await loop.run_in_executor(None, collector.poll_active_sessions, host)


async def periodic_who_collector(queue: asyncio.Queue):
    """Every 60 s: collect active SSH sessions (local + remote) into active_users."""
    # In work mode with an external WHO service (e.g. WHO_ISP.py), active_users is
    # managed externally. Running the internal collector would delete that data every 60s.
    if conf.MODE_TYPE.strip().lower() == 'work' and conf.MODE_WHO_FILE:
        return
    WHO_INTERVAL = 60
    while True:
        await asyncio.sleep(WHO_INTERVAL)
        try:
            loop = asyncio.get_running_loop()
            # Local sessions
            sessions = await loop.run_in_executor(None, collector.poll_local_sessions)
            # Remote hosts
            hosts = collector.discover_hosts()
            if hosts:
                sem = asyncio.Semaphore(FAIL2BAN_CONCURRENCY)
                results = await asyncio.gather(*[_who_one(h, sem) for h in hosts])
                for r in results:
                    sessions.extend(r)

            # Filter out local network sessions (only show external users)
            def _is_private(ip):
                try:
                    return ipaddress.ip_address(ip).is_private
                except ValueError:
                    return True
            sessions = [s for s in sessions if not _is_private(s['ip'])]

            # GeoIP enrich + replace active_users table
            enriched = []
            for s in sessions:
                try:
                    lat, lon, country, isp = await loop.run_in_executor(
                        None, geoip.lookup, s['ip'])
                except Exception:
                    lat, lon, country, isp = 0.0, 0.0, 'Unknown', 'Unknown'
                enriched.append({**s, 'lat': lat, 'lon': lon,
                                 'country': country, 'isp': isp})

            now = datetime.now().isoformat()
            conn = sqlite3.connect(DB_PATH)
            conn.execute("DELETE FROM active_users")
            for s in enriched:
                conn.execute(
                    "INSERT INTO active_users "
                    "(username, ip, node, cluster, country, lat, lon, isp, timestamp) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (s['username'], s['ip'], s['node'], 'home',
                     s['country'], s['lat'], s['lon'], s['isp'], now))
            conn.commit()
            conn.close()

            if sessions:
                await _publish(queue, {"type": "log", "level": "info", "source": "who",
                                       "msg": f"active sessions: {len(sessions)} user(s) on "
                                              f"{len(set(s['node'] for s in sessions))} host(s)"})
        except Exception as e:
            await _publish(queue, {"type": "log", "level": "warn", "source": "who",
                                   "msg": f"session collector error: {e}"})
