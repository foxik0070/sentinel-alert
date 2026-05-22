"""ARP-scan + lightweight TCP port probe.

Returns events for new/online/offline devices + per-device open-ports updates.
Port scan runs async with a small concurrency budget so it doesn't stall the
event loop or hammer the LAN.
"""
import asyncio
import os
import socket
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta

sqlite3.register_adapter(datetime, lambda val: val.isoformat())

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "alerts.db")

OFFLINE_AFTER = timedelta(minutes=10)

# Common-port menu — short on purpose. Tweak via env if needed.
PORTS = [int(p) for p in os.environ.get(
    "SCAN_PORTS",
    "22,53,80,123,139,443,445,3306,3389,5432,5900,6379,8080,8443,9100"
).split(",")]
PORT_TIMEOUT = float(os.environ.get("PORT_TIMEOUT", "0.4"))
PORT_CONCURRENCY = int(os.environ.get("PORT_CONCURRENCY", "64"))


def resolve_hostname(ip):
    try:
        return socket.gethostbyaddr(ip)[0]
    except (socket.herror, socket.gaierror):
        return None


def _arp_sweep():
    try:
        out = subprocess.check_output(
            ["sudo", "-n", "arp-scan", "--localnet"],
            stderr=subprocess.STDOUT, text=True, timeout=30,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        msg = getattr(e, "output", str(e))
        print(f"arp-scan failed: {msg}".strip(), file=sys.stderr)
        return None

    seen = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        ip, mac = parts[0], parts[1]
        if ip.count(".") != 3 or ":" not in mac:
            continue
        vendor = " ".join(parts[2:]) if len(parts) > 2 else None
        seen.append((ip, mac, vendor))
    return seen


async def _probe_port(ip, port):
    try:
        fut = asyncio.open_connection(ip, port)
        reader, writer = await asyncio.wait_for(fut, timeout=PORT_TIMEOUT)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return port
    except Exception:
        return None


async def _scan_ports(ip, sem):
    async def one(p):
        async with sem:
            return await _probe_port(ip, p)
    results = await asyncio.gather(*[one(p) for p in PORTS])
    return [p for p in results if p is not None]


async def _scan_all_ports(ips):
    sem = asyncio.Semaphore(PORT_CONCURRENCY)
    out = await asyncio.gather(*[_scan_ports(ip, sem) for ip in ips])
    return dict(zip(ips, out))


async def scan_async():
    """Run one ARP sweep + port scan. Returns list of WS-style events."""
    loop = asyncio.get_running_loop()
    seen = await loop.run_in_executor(None, _arp_sweep)
    if seen is None:
        return [{"type": "log", "level": "warn",
                 "source": "scanner", "msg": "arp-scan failed (sudo?)"}]

    events = [{"type": "log", "level": "info", "source": "scanner",
               "msg": f"ARP sweep: {len(seen)} hosts up"}]
    if not seen:
        return events

    ip_to_ports = await _scan_all_ports([ip for ip, _, _ in seen])

    now = datetime.now()
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    try:
        for ip, mac, vendor in seen:
            cur.execute("SELECT is_online, ip FROM devices WHERE mac=?", (mac,))
            prev = cur.fetchone()
            is_new = prev is None
            came_online = prev is not None and prev[0] == 0
            ip_changed = prev is not None and prev[1] != ip
            hostname = resolve_hostname(ip)
            ports = ip_to_ports.get(ip, [])
            ports_str = ",".join(str(p) for p in ports) if ports else ""
            cur.execute(
                """
                INSERT INTO devices
                    (mac, ip, hostname, vendor, first_seen, last_seen,
                     is_online, ports, ports_checked_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
                ON CONFLICT(mac) DO UPDATE SET
                    ip = excluded.ip,
                    hostname = COALESCE(excluded.hostname, devices.hostname),
                    vendor = COALESCE(excluded.vendor, devices.vendor),
                    last_seen = excluded.last_seen,
                    is_online = 1,
                    ports = excluded.ports,
                    ports_checked_at = excluded.ports_checked_at
                """,
                (mac, ip, hostname, vendor, now, now, ports_str, now),
            )
            if ip_changed:
                old_ip = prev[1]
                events.append({
                    "type": "device",
                    "state": "ip_changed",
                    "mac": mac, "ip": ip, "old_ip": old_ip,
                    "hostname": hostname, "vendor": vendor,
                })
                events.append({
                    "type": "log", "level": "warn", "source": "scanner",
                    "msg": f"IP CHANGE  {hostname or ip}  {old_ip} → {ip}",
                })
            if is_new or came_online:
                events.append({
                    "type": "device",
                    "state": "new" if is_new else "online",
                    "mac": mac, "ip": ip,
                    "hostname": hostname, "vendor": vendor, "ports": ports,
                })
                events.append({
                    "type": "log",
                    "level": "info" if not is_new else "good",
                    "source": "scanner",
                    "msg": f"{'NEW' if is_new else 'UP'}  {hostname or ip} ({ip})"
                           + (f"  ports={ports_str}" if ports_str else ""),
                })

        cutoff = now - OFFLINE_AFTER
        cur.execute("SELECT mac, ip, hostname FROM devices WHERE is_online=1 AND last_seen < ?", (cutoff,))
        going_offline = cur.fetchall()
        cur.execute("UPDATE devices SET is_online=0 WHERE is_online=1 AND last_seen < ?", (cutoff,))
        for mac, ip, hostname in going_offline:
            events.append({"type": "device", "state": "offline",
                           "mac": mac, "ip": ip, "hostname": hostname})
            events.append({"type": "log", "level": "warn", "source": "scanner",
                           "msg": f"DOWN  {hostname or ip} ({ip})"})
        conn.commit()
    finally:
        conn.close()
    return events


def scan():
    """Sync wrapper for CLI / executor calls."""
    return asyncio.run(scan_async())


if __name__ == "__main__":
    for e in scan():
        print(e)
