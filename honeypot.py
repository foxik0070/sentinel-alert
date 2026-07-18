"""Fake-banner honeypot. Captures SSH (2222) and HTTP (8080) connect attempts.

Each attempt is GeoIP-enriched, persisted to the `attacks` table, broadcast over
the shared asyncio Queue, and (optionally) forwarded via the Sentinel bridge.
"""
import asyncio
import ipaddress
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

# Deception bannery pro další protokoly — realistické fake služby lákající útočníky
FTP_BANNER    = b"220 (vsFTPd 3.0.3)\r\n"
TELNET_BANNER = b"\xff\xfb\x01\xff\xfb\x03\r\nUbuntu 22.04.3 LTS\r\nlogin: "
SMTP_BANNER   = b"220 mail.local ESMTP Postfix (Ubuntu)\r\n"
# RDP/SMB jsou binární — jen connect capture bez banneru

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
    try:
        addr = ipaddress.ip_address(src_ip)
        if addr.is_private or addr.is_loopback or addr.is_link_local:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return
    except ValueError:
        pass
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


# Extra deception služby: proto → (default port, banner). Zapnutelné v configu.
EXTRA_SERVICES = {
    "ftp":    (21,   FTP_BANNER),
    "telnet": (23,   TELNET_BANNER),
    "smtp":   (25,   SMTP_BANNER),
    "rdp":    (3389, None),
    "smb":    (445,  None),
}


async def start(queue: asyncio.Queue, ssh_port=2222, http_port=8080, host="0.0.0.0",
                extra=None):
    """Start listeners. `extra` = seznam názvů protokolů z EXTRA_SERVICES."""
    global _broadcast_queue
    _broadcast_queue = queue

    async def ssh_cb(r, w):
        await _handle(r, w, "ssh", ssh_port, SSH_BANNER)

    async def http_cb(r, w):
        await _handle(r, w, "http", http_port, HTTP_RESPONSE)

    servers = [
        await asyncio.start_server(ssh_cb, host, ssh_port),
        await asyncio.start_server(http_cb, host, http_port),
    ]
    started = ["SSH=%d" % ssh_port, "HTTP=%d" % http_port]

    for name in (extra or []):
        svc = EXTRA_SERVICES.get(name)
        if not svc:
            continue
        port, banner = svc

        def _mk(proto, p, b):
            async def _cb(r, w):
                await _handle(r, w, proto, p, b)
            return _cb
        try:
            servers.append(await asyncio.start_server(_mk(name, port, banner), host, port))
            started.append(f"{name.upper()}={port}")
        except Exception as e:
            print(f"honeypot: {name}:{port} bind failed: {e}")

    print("Honeypot listening: " + " ".join(started))
    return servers
