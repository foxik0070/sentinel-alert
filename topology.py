"""Network topology: user-defined nodes + links, persisted in data/topology.json.

Schema:
{
  "nodes": [
    {"id": "mikrotik", "type": "router|switch|ap|host|server",
     "ip": "192.168.2.1", "label": "Main Router", "x": 0.5, "y": 0.1}
  ],
  "links": [{"source": "mikrotik", "target": "proxmox01", "port": "eth1"}]
}

If the file is missing, _autoseed() builds a star topology from current devices.
"""
import json
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PATH = BASE_DIR / "data" / "topology.json"
DB = BASE_DIR / "data" / "alerts.db"


def _autoseed() -> dict:
    """Star topology: one auto-router (192.168.x.1) with all devices around."""
    nodes, links = [], []
    if not DB.exists():
        return {"nodes": [], "links": []}
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    rows = list(conn.execute(
        "SELECT mac, ip, hostname, vendor FROM devices ORDER BY ip"))
    conn.close()
    if not rows:
        return {"nodes": [], "links": []}

    # Pick the lowest .1 / mikrotik-ish as router. Fallback: first IP.
    router = next((r for r in rows if (r["ip"] or "").endswith(".1")), rows[0])
    nodes.append({
        "id": "router", "type": "router",
        "ip": router["ip"], "label": router["hostname"] or "router",
        "x": 0.5, "y": 0.5,
    })

    import math
    others = [r for r in rows if r["mac"] != router["mac"]]
    for i, r in enumerate(others):
        angle = 2 * math.pi * i / max(1, len(others))
        nodes.append({
            "id": r["mac"], "type": "host",
            "ip": r["ip"], "label": r["hostname"] or r["ip"],
            "x": 0.5 + 0.35 * math.cos(angle),
            "y": 0.5 + 0.35 * math.sin(angle),
        })
        links.append({"source": "router", "target": r["mac"], "port": ""})
    return {"nodes": nodes, "links": links}


def load() -> dict:
    if PATH.exists():
        try:
            return json.loads(PATH.read_text())
        except Exception:
            pass
    topo = _autoseed()
    save(topo)
    return topo


def save(data: dict) -> dict:
    PATH.parent.mkdir(parents=True, exist_ok=True)
    nodes = data.get("nodes") or []
    links = data.get("links") or []
    PATH.write_text(json.dumps({"nodes": nodes, "links": links}, indent=2))
    return {"nodes": nodes, "links": links}


def reseed() -> dict:
    """Force-regenerate from current devices."""
    topo = _autoseed()
    save(topo)
    return topo
