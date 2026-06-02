"""PiHole monitor — polls PiHole v6 REST API for statistics.

Supports multiple instances (primary + secondary).
PiHole v6 auth: POST /api/auth → session SID, used in X-FTL-SID header.
"""
import threading
import time
import urllib.request
import urllib.error
import json
import ssl

_hosts: list[str] = []
_primary: str = ""
_password: str = ""

data_store = {
    "instances": {},   # host → {connected, stats, top_domains, top_blocked, overtime, version}
    "primary": "",
}

_lock = threading.Lock()
_sessions: dict[str, str] = {}  # host → SID
_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE


def _api(host: str, path: str, method: str = "GET", body: dict | None = None) -> tuple[bool, dict]:
    url = f"https://{host}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    sid = _sessions.get(host)
    if sid:
        headers["X-FTL-SID"] = sid
    try:
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, context=_ctx, timeout=8) as r:
            return True, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            body_err = json.loads(e.read())
        except Exception:
            body_err = {}
        return False, body_err
    except Exception as e:
        return False, {"error": str(e)}


def _auth(host: str) -> bool:
    """Authenticate and store session SID. Returns True on success."""
    if not _password:
        return True  # no-auth mode (open PiHole)
    ok, resp = _api(host, "/api/auth", "POST", {"password": _password})
    if ok and resp.get("session", {}).get("sid"):
        _sessions[host] = resp["session"]["sid"]
        return True
    _sessions.pop(host, None)
    return False


def _fetch_host(host: str) -> dict:
    """Fetch all stats for one host. Returns instance dict."""
    inst = {"connected": False, "last_error": "", "host": host,
            "primary": host == _primary}

    # Authenticate if needed
    if host not in _sessions:
        if not _auth(host):
            inst["last_error"] = "Authentication failed"
            return inst

    def get(path):
        ok, data = _api(host, path)
        if not ok and data.get("error", {}).get("key") == "unauthorized":
            _sessions.pop(host, None)
            if _auth(host):
                ok, data = _api(host, path)
        return ok, data

    ok_s, stats = get("/api/stats/summary")
    if not ok_s:
        inst["last_error"] = stats.get("error", {}).get("message", "Failed to fetch stats")
        return inst

    ok_t, top    = get("/api/stats/top_domains?blocked=false&count=10")
    ok_b, top_bl = get("/api/stats/top_domains?blocked=true&count=10")
    ok_o, over   = get("/api/history")
    ok_v, ver    = get("/api/info/version")
    ok_bl, blk   = get("/api/dns/blocking")

    inst["connected"] = True
    inst["stats"] = {
        "queries_today":   stats.get("queries", {}).get("total", 0),
        "blocked_today":   stats.get("queries", {}).get("blocked", 0),
        "percent_blocked": round(stats.get("queries", {}).get("percent_blocked", 0), 1),
        "domains_blocked": stats.get("gravity", {}).get("domains_being_blocked", 0),
        "unique_clients":  stats.get("clients", {}).get("active", 0),
        "queries_cached":  stats.get("queries", {}).get("cached", 0),
        "status":          blk.get("blocking", "unknown") if ok_bl else "unknown",
    }
    inst["top_domains"]  = (top.get("domains")    or []) if ok_t else []
    inst["top_blocked"]  = (top_bl.get("domains") or []) if ok_b else []

    # overtime: list of {timestamp, total, blocked} — 10-min intervals
    if ok_o:
        history = over.get("history") or []
        inst["overtime"] = [
            {"ts": e.get("timestamp", 0),
             "total": e.get("total", 0),
             "blocked": e.get("blocked", 0)}
            for e in history[-144:]
        ]
    else:
        inst["overtime"] = []

    # version: core.local.version
    inst["version"] = ver.get("version", {}).get("core", {}).get("local", {}).get("version", "") if ok_v else ""
    return inst


def _poll_worker():
    while True:
        results = {}
        for host in _hosts:
            results[host] = _fetch_host(host)
        with _lock:
            data_store["instances"] = results
        time.sleep(30)


def start(hosts: list[str], primary: str, password: str):
    global _hosts, _primary, _password
    _hosts   = [h.strip() for h in hosts if h.strip()]
    _primary = primary.strip()
    _password = password.strip()

    if not _hosts:
        return

    data_store["primary"] = _primary
    threading.Thread(target=_poll_worker, daemon=True).start()
    print(f"pihole: monitoring {', '.join(_hosts)} (primary={_primary})")
