"""Fake-banner honeypot. Captures SSH (2222) and HTTP (8080) connect attempts.

Each attempt is GeoIP-enriched, persisted to the `attacks` table, broadcast over
the shared asyncio Queue, and (optionally) forwarded via the Sentinel bridge.
"""
import asyncio
import os
import sqlite3
from datetime import datetime

import bridge
import geoip

sqlite3.register_adapter(datetime, lambda val: val.isoformat())

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "alerts.db")

SSH_BANNER = b"SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.4\r\n"
HTTP_RESPONSE = (
    b"HTTP/1.1 401 Unauthorized\r\n"
    b"Server: nginx/1.18.0\r\n"
    b"WWW-Authenticate: Basic realm=\"Admin\"\r\n"
    b"Content-Length: 0\r\n"
    b"Connection: close\r\n\r\n"
)

MAX_PAYLOAD = 512
READ_TIMEOUT = 5.0


def _persist(event):
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "INSERT INTO attacks (ts, src_ip, dst_port, protocol, payload, country, lat, lon, isp) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (
                event["ts"],
                event["src_ip"],
                event["dst_port"],
                event["protocol"],
                event["payload"],
                event["country"],
                event["lat"],
                event["lon"],
                event["isp"],
            ),
        )
        conn.commit()
    finally:
        conn.close()


async def _handle(reader, writer, protocol, port, banner):
    peer = writer.get_extra_info("peername")
    src_ip = peer[0] if peer else "0.0.0.0"
    payload = b""
    try:
        if banner:
            writer.write(banner)
            await writer.drain()
        try:
            payload = await asyncio.wait_for(reader.read(MAX_PAYLOAD), READ_TIMEOUT)
        except asyncio.TimeoutError:
            pass
    except Exception:
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

    lat, lon, country, isp = geoip.lookup(src_ip)
    event = {
        "ts": datetime.now().isoformat(),
        "src_ip": src_ip,
        "dst_port": port,
        "protocol": protocol,
        "payload": payload.decode("utf-8", errors="replace")[:MAX_PAYLOAD],
        "country": country,
        "lat": lat,
        "lon": lon,
        "isp": isp,
    }

    try:
        await asyncio.get_running_loop().run_in_executor(None, _persist, event)
    except Exception as e:
        print(f"honeypot persist failed: {e}")

    queue = _broadcast_queue
    if queue is not None:
        for ev in (
            {"type": "attack", **event},
            {"type": "log", "level": "attack", "source": "honeypot",
             "msg": f"{protocol.upper()} hit :{port} from {src_ip} ({country})",
             "ts": event["ts"]},
        ):
            try:
                queue.put_nowait(ev)
            except asyncio.QueueFull:
                pass

    asyncio.create_task(bridge.forward({"type": "attack", **event}))


_broadcast_queue: asyncio.Queue | None = None


async def start(queue: asyncio.Queue, ssh_port=2222, http_port=8080, host="0.0.0.0"):
    """Start both listeners. Caller passes the WS broadcast queue."""
    global _broadcast_queue
    _broadcast_queue = queue

    async def ssh_cb(r, w):
        await _handle(r, w, "ssh", ssh_port, SSH_BANNER)

    async def http_cb(r, w):
        await _handle(r, w, "http", http_port, HTTP_RESPONSE)

    ssh_server = await asyncio.start_server(ssh_cb, host, ssh_port)
    http_server = await asyncio.start_server(http_cb, host, http_port)
    print(f"Honeypot listening: SSH={ssh_port} HTTP={http_port}")
    return ssh_server, http_server
