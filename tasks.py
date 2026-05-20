"""Background periodic tasks. Started from app.py lifespan."""
import asyncio
import os
import sqlite3
from datetime import datetime

import bridge
import collector
import conf
import geoip
import scanner

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "alerts.db")

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
            for ev in events or []:
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
    """One-shot: enrich DB rows that have isp='Unknown', 1 per 2.5s (< 45/min)."""
    loop = asyncio.get_running_loop()
    await asyncio.sleep(10)  # let the app fully start first
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            "SELECT 'attack', id, src_ip FROM attacks WHERE isp='Unknown' AND country NOT IN ('LAN','NoDB','Invalid')"
            " UNION ALL "
            "SELECT 'ban', rowid, ip FROM ban_history WHERE isp='Unknown' AND country NOT IN ('LAN','NoDB','Invalid')"
        ).fetchall()
        conn.close()
    except Exception as e:
        await _publish(queue, {"type": "log", "level": "warn", "source": "isp-enrich", "msg": f"read failed: {e}"})
        return

    enriched = 0
    for table, row_id, ip in rows:
        isp = await loop.run_in_executor(None, geoip._lookup_isp_api, ip)
        if isp:
            try:
                conn = sqlite3.connect(DB_PATH)
                if table == "attack":
                    conn.execute("UPDATE attacks SET isp=? WHERE id=?", (isp, row_id))
                else:
                    conn.execute("UPDATE ban_history SET isp=? WHERE rowid=?", (isp, row_id))
                conn.commit()
                conn.close()
                enriched += 1
            except Exception:
                pass
        await asyncio.sleep(2.5)

    if enriched:
        await _publish(queue, {"type": "log", "level": "info", "source": "isp-enrich",
                               "msg": f"enriched ISP for {enriched} records"})


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
