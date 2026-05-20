"""Background periodic tasks. Started from app.py lifespan."""
import asyncio
import os
from datetime import datetime

import bridge
import collector
import conf
import scanner

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
