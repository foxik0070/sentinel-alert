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
MAX_SESSION = 4096          # session capture — akumulovaný payload celé relace
READ_TIMEOUT = 8.0


def _extract_creds(text: str) -> str:
    """Vytáhne z relace zajímavé stopy: HTTP Basic auth, User-Agent, login pokusy."""
    import base64 as _b64
    import re as _re
    out = []
    m = _re.search(r"Authorization:\s*Basic\s+(\S+)", text, _re.I)
    if m:
        try:
            out.append("basic=" + _b64.b64decode(m.group(1)).decode("utf-8", "replace")[:60])
        except Exception:
            pass
    m = _re.search(r"User-Agent:\s*(.+)", text, _re.I)
    if m:
        out.append("ua=" + m.group(1).strip()[:80])
    # SSH klient banner (SSH-2.0-...) identifikuje nástroj
    m = _re.search(r"SSH-2\.0-\S+", text)
    if m:
        out.append("ssh=" + m.group(0)[:60])
    return " | ".join(out)[:200]


# ── JA3 TLS fingerprint ────────────────────────────────────────────────────────
def _ja3_from_client_hello(data: bytes):
    """Spočítá JA3 fingerprint z TLS ClientHello. Vrací (ja3_str, md5) nebo None."""
    import hashlib as _h
    import struct as _st
    try:
        if len(data) < 44 or data[0] != 0x16:      # TLS handshake record
            return None
        # přeskoč record header (5) + handshake type (1) + length (3)
        p = 5
        if data[p] != 0x01:                          # ClientHello
            return None
        p += 4
        ver = _st.unpack(">H", data[p:p + 2])[0]     # legacy_version
        p += 2 + 32                                  # version + random
        sid_len = data[p]; p += 1 + sid_len          # session id
        cs_len = _st.unpack(">H", data[p:p + 2])[0]; p += 2
        ciphers = [_st.unpack(">H", data[p + i:p + i + 2])[0] for i in range(0, cs_len, 2)]
        p += cs_len
        comp_len = data[p]; p += 1 + comp_len         # compression methods
        exts, curves, ecpf = [], [], []
        if p + 2 <= len(data):
            ext_total = _st.unpack(">H", data[p:p + 2])[0]; p += 2
            end = p + ext_total
            while p + 4 <= end and p + 4 <= len(data):
                etype = _st.unpack(">H", data[p:p + 2])[0]
                elen = _st.unpack(">H", data[p + 2:p + 4])[0]
                exts.append(etype)
                body = data[p + 4:p + 4 + elen]
                if etype == 0x000a and len(body) >= 2:   # supported_groups
                    n = _st.unpack(">H", body[:2])[0]
                    curves = [_st.unpack(">H", body[2 + i:4 + i])[0] for i in range(0, n, 2)]
                elif etype == 0x000b and len(body) >= 1:  # ec_point_formats
                    ecpf = list(body[1:1 + body[0]])
                p += 4 + elen
        _GREASE = {0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a, 0x6a6a, 0x7a7a,
                   0x8a8a, 0x9a9a, 0xaaaa, 0xbaba, 0xcaca, 0xdada, 0xeaea, 0xfafa}
        f = lambda lst: "-".join(str(x) for x in lst if x not in _GREASE)
        ja3 = f"{ver},{f(ciphers)},{f(exts)},{f(curves)},{f(ecpf)}"
        return ja3, _h.md5(ja3.encode()).hexdigest()
    except Exception:
        return None


def _persist(event):
    conn = sqlite3.connect(DB_PATH)
    try:
        # payload = session capture; creds/JA3 přidáme na začátek pro viditelnost v IP intel
        pl = event.get("payload", "")
        if event.get("creds"):
            pl = f"[{event['creds']}] {pl}"[:MAX_SESSION]
        conn.execute(
            "INSERT INTO attacks (ts, src_ip, dst_port, protocol, payload, country, lat, lon, isp) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (
                event["ts"],
                event["src_ip"],
                event["dst_port"],
                event["protocol"],
                pl,
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
    # Session capture — čti víc kol do timeoutu, akumuluj celou relaci
    payload = b""
    try:
        if banner:
            writer.write(banner)
            await writer.drain()
        deadline = asyncio.get_event_loop().time() + READ_TIMEOUT
        while len(payload) < MAX_SESSION:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                chunk = await asyncio.wait_for(reader.read(4096), min(remaining, 2.0))
            except asyncio.TimeoutError:
                break
            if not chunk:
                break
            payload += chunk
    except Exception:
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

    text = payload.decode("utf-8", errors="replace")
    creds = _extract_creds(text)
    # JA3 fingerprint pokud útočník poslal TLS ClientHello
    ja3 = _ja3_from_client_hello(payload)
    if ja3:
        creds = (creds + " | " if creds else "") + f"ja3={ja3[1]}"
    lat, lon, country, isp = geoip.lookup(src_ip)
    event = {
        "ts": datetime.now().isoformat(),
        "src_ip": src_ip,
        "dst_port": port,
        "protocol": protocol,
        "payload": text[:MAX_SESSION],
        "creds": creds,                  # credentials / user-agent / JA3
        "ja3": ja3[1] if ja3 else "",
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
