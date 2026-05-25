"""
Tests for service monitoring backend.

Covers:
- _load_services / _save_services (JSON persistence)
- _migrate_domain (domains.json → services.json migration)
- _svc_db_store / _svc_db_history / _svc_uptime / _svc_last (SQLite)
- _check_http (HTTP GET, status check, text check)
- _check_tcp (connect to local port)
- _check_ping (ICMP, loopback)
- _check_dns (system resolver)
- _check_heartbeat (in-memory last-ping tracking)
- API: POST /api/services, GET /api/services, DELETE /api/services/{sid}
- API: POST /api/services/check, POST /api/services/{sid}/check
- API: GET/POST /api/services/settings
- API: POST /api/heartbeat/{sid}
- bridge: service event translation
"""

import asyncio
import json
import os
import sqlite3
import tempfile
import time
import uuid
from unittest.mock import patch, AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def tmp_data_dir(monkeypatch, tmp_path):
    """Redirect all data file paths to a temporary directory."""
    import app as _app
    import db_init

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    db_path = str(data_dir / "alerts.db")
    svc_path = str(data_dir / "services.json")
    svc_cfg_path = str(data_dir / "svc_settings.json")

    monkeypatch.setattr(_app, "_SVC_PATH", svc_path)
    monkeypatch.setattr(_app, "_SVC_SETTINGS_PATH", svc_cfg_path)
    monkeypatch.setattr(_app, "DB_PATH", db_path)
    monkeypatch.setattr(db_init, "DB_PATH", db_path)

    # init DB in temp location
    db_init.init()
    return tmp_path


@pytest.fixture
def client(tmp_data_dir):
    import app as _app
    with TestClient(_app.app) as c:
        yield c


# ── Helper: insert a service directly ─────────────────────────────────────────

def _add_svc(app_module, **kwargs) -> dict:
    svc = {
        "id": str(uuid.uuid4()),
        "name": kwargs.get("name", "test"),
        "type": kwargs.get("type", "http"),
        "target": kwargs.get("target", "http://example.com"),
        "host": kwargs.get("host", ""),
        "port": kwargs.get("port", None),
        "method": kwargs.get("method", "GET"),
        "expected_status": kwargs.get("expected_status", 200),
        "expected_text": kwargs.get("expected_text", ""),
        "dns_query": kwargs.get("dns_query", ""),
        "dns_server": kwargs.get("dns_server", ""),
        "heartbeat_interval": kwargs.get("heartbeat_interval", 300),
        "enabled": True,
    }
    services = app_module._load_services()
    services.append(svc)
    app_module._save_services(services)
    return svc


# ══════════════════════════════════════════════════════════════════════════════
# 1. JSON persistence
# ══════════════════════════════════════════════════════════════════════════════

def test_load_services_empty(tmp_data_dir):
    import app as _app
    assert _app._load_services() == []


def test_save_and_load_services(tmp_data_dir):
    import app as _app
    svc = _add_svc(_app, name="MySite", type="http", target="https://example.com")
    loaded = _app._load_services()
    assert len(loaded) == 1
    assert loaded[0]["id"] == svc["id"]
    assert loaded[0]["name"] == "MySite"


def test_migrate_domain(tmp_data_dir):
    import app as _app
    old = {"url": "https://example.com", "name": "Example"}
    migrated = _app._migrate_domain(old)
    assert migrated["type"] == "http"
    assert migrated["target"] == "https://example.com"
    assert migrated["name"] == "Example"
    assert len(migrated["id"]) == 36  # UUID format


def test_migration_from_domains_json(tmp_data_dir, monkeypatch):
    """If services.json absent but domains.json exists, it migrates."""
    import app as _app
    domains_path = os.path.join(os.path.dirname(_app._SVC_PATH), "domains.json")
    with open(domains_path, "w") as f:
        json.dump([{"url": "http://test.local", "name": "Test"}], f)

    os.remove(_app._SVC_PATH) if os.path.exists(_app._SVC_PATH) else None
    services = _app._load_services()
    assert len(services) == 1
    assert services[0]["target"] == "http://test.local"


# ══════════════════════════════════════════════════════════════════════════════
# 2. SQLite helpers
# ══════════════════════════════════════════════════════════════════════════════

def test_svc_db_store_and_last(tmp_data_dir):
    import app as _app
    sid = str(uuid.uuid4())
    _app._svc_db_store(sid, "up", 120, "HTTP 200")
    last = _app._svc_last(sid)
    assert last is not None
    assert last["status"] == "up"
    assert last["response_ms"] == 120
    assert last["message"] == "HTTP 200"


def test_svc_db_history_order(tmp_data_dir):
    import app as _app
    sid = str(uuid.uuid4())
    for i in range(5):
        _app._svc_db_store(sid, "up" if i % 2 == 0 else "down", i * 10, "")
        time.sleep(0.01)
    history = _app._svc_db_history(sid, limit=10)
    assert len(history) == 5
    # oldest first
    assert history[0]["response_ms"] == 0


def test_svc_uptime_all_up(tmp_data_dir):
    import app as _app
    sid = str(uuid.uuid4())
    for _ in range(10):
        _app._svc_db_store(sid, "up", 50, "")
    pct = _app._svc_uptime(sid, 24)
    assert pct == 100.0


def test_svc_uptime_half(tmp_data_dir):
    import app as _app
    sid = str(uuid.uuid4())
    for i in range(10):
        _app._svc_db_store(sid, "up" if i < 5 else "down", 50, "")
    pct = _app._svc_uptime(sid, 24)
    assert pct == 50.0


def test_svc_uptime_no_data(tmp_data_dir):
    import app as _app
    assert _app._svc_uptime("nonexistent", 24) is None


def test_svc_last_no_data(tmp_data_dir):
    import app as _app
    assert _app._svc_last("nonexistent") is None


# ══════════════════════════════════════════════════════════════════════════════
# 3. Check functions
# ══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_check_http_success(tmp_data_dir):
    import app as _app
    svc = {"id": "x", "type": "http", "target": "http://httpbin.org/status/200",
           "method": "GET", "expected_status": 200, "expected_text": ""}

    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.url = svc["target"]
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read = MagicMock(return_value=b"")

    with patch("urllib.request.urlopen", return_value=mock_resp):
        res = await _app._check_http(svc)

    assert res["up"] is True
    assert res["status_code"] == 200


@pytest.mark.asyncio
async def test_check_http_wrong_status(tmp_data_dir):
    import app as _app
    svc = {"id": "x", "type": "http", "target": "http://example.com",
           "method": "GET", "expected_status": 200, "expected_text": ""}

    mock_resp = MagicMock()
    mock_resp.status = 404
    mock_resp.url = svc["target"]
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read = MagicMock(return_value=b"Not Found")

    with patch("urllib.request.urlopen", return_value=mock_resp):
        res = await _app._check_http(svc)

    assert res["up"] is False
    assert res["status_code"] == 404


@pytest.mark.asyncio
async def test_check_http_text_not_found(tmp_data_dir):
    import app as _app
    svc = {"id": "x", "type": "http", "target": "http://example.com",
           "method": "GET", "expected_status": 200, "expected_text": "MUSTBEPRESENT"}

    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.url = svc["target"]
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read = MagicMock(return_value=b"Hello World")

    with patch("urllib.request.urlopen", return_value=mock_resp):
        res = await _app._check_http(svc)

    assert res["up"] is False
    assert "MUSTBEPRESENT" in res.get("message", "")


@pytest.mark.asyncio
async def test_check_ping_success(tmp_data_dir):
    import app as _app
    svc = {"id": "x", "type": "ping", "host": "127.0.0.1"}
    res = await _app._check_ping(svc)
    assert res["up"] is True
    assert res["response_ms"] >= 0


@pytest.mark.asyncio
async def test_check_ping_failure(tmp_data_dir):
    import app as _app
    # 192.0.2.x is TEST-NET, routable but unreachable → ping fails
    svc = {"id": "x", "type": "ping", "host": "192.0.2.1"}
    res = await _app._check_ping(svc)
    assert res["up"] is False


@pytest.mark.asyncio
async def test_check_tcp_success(tmp_data_dir):
    """Open a local socket and verify TCP check reaches it."""
    import app as _app
    import asyncio

    server = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]

    svc = {"id": "x", "type": "tcp", "host": "127.0.0.1", "port": port}
    res = await _app._check_tcp(svc)
    server.close()
    await server.wait_closed()

    assert res["up"] is True
    assert res["response_ms"] >= 0


@pytest.mark.asyncio
async def test_check_tcp_failure(tmp_data_dir):
    import app as _app
    # Port 1 is almost certainly closed
    svc = {"id": "x", "type": "tcp", "host": "127.0.0.1", "port": 1}
    res = await _app._check_tcp(svc)
    assert res["up"] is False


@pytest.mark.asyncio
async def test_check_dns_localhost(tmp_data_dir):
    import app as _app
    svc = {"id": "x", "type": "dns", "dns_query": "localhost", "dns_server": "", "host": "localhost"}
    res = await _app._check_dns(svc)
    assert res["up"] is True


@pytest.mark.asyncio
async def test_check_heartbeat_no_ping(tmp_data_dir):
    import app as _app
    svc = {"id": "hb-no-ping", "type": "heartbeat", "heartbeat_interval": 60}
    res = await _app._check_heartbeat(svc)
    assert res["up"] is False
    assert "no heartbeat" in res["message"]


@pytest.mark.asyncio
async def test_check_heartbeat_recent_ping(tmp_data_dir):
    import app as _app
    svc = {"id": "hb-recent", "type": "heartbeat", "heartbeat_interval": 300}
    _app._heartbeat_last["hb-recent"] = time.time()
    res = await _app._check_heartbeat(svc)
    assert res["up"] is True


@pytest.mark.asyncio
async def test_check_heartbeat_expired(tmp_data_dir):
    import app as _app
    svc = {"id": "hb-old", "type": "heartbeat", "heartbeat_interval": 60}
    _app._heartbeat_last["hb-old"] = time.time() - 200  # 200s ago, max = 90s
    res = await _app._check_heartbeat(svc)
    assert res["up"] is False


# ══════════════════════════════════════════════════════════════════════════════
# 4. API endpoints
# ══════════════════════════════════════════════════════════════════════════════

def test_api_services_list_empty(client):
    r = client.get("/api/services")
    assert r.status_code == 200
    assert r.json() == []


def test_api_services_add_http(client):
    r = client.post("/api/services", json={
        "type": "http", "name": "Example", "target": "https://example.com",
    })
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "id" in data

    r2 = client.get("/api/services")
    assert r2.status_code == 200
    svcs = r2.json()
    assert len(svcs) == 1
    assert svcs[0]["name"] == "Example"
    assert svcs[0]["type"] == "http"


def test_api_services_add_tcp(client):
    r = client.post("/api/services", json={
        "type": "tcp", "name": "SSH", "host": "192.168.2.1", "port": 22,
    })
    assert r.status_code == 200
    svcs = client.get("/api/services").json()
    assert svcs[0]["host"] == "192.168.2.1"
    assert svcs[0]["port"] == 22


def test_api_services_add_missing_target(client):
    r = client.post("/api/services", json={"type": "http", "name": "Bad"})
    assert r.status_code == 400


def test_api_services_add_missing_host(client):
    r = client.post("/api/services", json={"type": "tcp", "name": "Bad"})
    assert r.status_code == 400


def test_api_services_delete(client):
    r = client.post("/api/services", json={
        "type": "ping", "name": "Router", "host": "192.168.2.1",
    })
    sid = r.json()["id"]
    rd = client.delete(f"/api/services/{sid}")
    assert rd.status_code == 200
    assert rd.json()["ok"] is True

    svcs = client.get("/api/services").json()
    assert all(s["id"] != sid for s in svcs)


def test_api_services_delete_notfound(client):
    r = client.delete("/api/services/nonexistent-id")
    assert r.status_code == 404


def test_api_services_check_all(client):
    client.post("/api/services", json={
        "type": "ping", "name": "Loopback", "host": "127.0.0.1",
    })
    r = client.post("/api/services/check")
    assert r.status_code == 200
    results = r.json()
    assert isinstance(results, list)
    assert len(results) == 1
    assert results[0]["up"] is True


def test_api_services_check_one(client):
    r = client.post("/api/services", json={
        "type": "ping", "name": "LB", "host": "127.0.0.1",
    })
    sid = r.json()["id"]
    rc = client.post(f"/api/services/{sid}/check")
    assert rc.status_code == 200
    assert rc.json()["up"] is True


def test_api_services_check_one_notfound(client):
    r = client.post("/api/services/bad-id/check")
    assert r.status_code == 404


def test_api_services_settings_get_default(client):
    r = client.get("/api/services/settings")
    assert r.status_code == 200
    assert "interval_min" in r.json()


def test_api_services_settings_set(client):
    r = client.post("/api/services/settings", json={"interval_min": 15})
    assert r.status_code == 200
    assert r.json()["interval_min"] == 15

    r2 = client.get("/api/services/settings")
    assert r2.json()["interval_min"] == 15


def test_api_services_settings_clamp(client):
    r = client.post("/api/services/settings", json={"interval_min": 999})
    assert r.json()["interval_min"] == 60  # clamped to max


def test_api_heartbeat_ping(client):
    r = client.post("/api/services", json={
        "type": "heartbeat", "name": "Cron", "heartbeat_interval": 300,
    })
    sid = r.json()["id"]
    rh = client.post(f"/api/heartbeat/{sid}")
    assert rh.status_code == 200
    assert rh.json()["ok"] is True


def test_api_heartbeat_not_found(client):
    r = client.post("/api/heartbeat/bad-id")
    assert r.status_code == 404


def test_api_heartbeat_wrong_type(client):
    """Heartbeat endpoint rejects non-heartbeat services."""
    r = client.post("/api/services", json={
        "type": "ping", "name": "Ping", "host": "127.0.0.1",
    })
    sid = r.json()["id"]
    rh = client.post(f"/api/heartbeat/{sid}")
    assert rh.status_code == 404


# ══════════════════════════════════════════════════════════════════════════════
# 5. Bridge — service event translation
# ══════════════════════════════════════════════════════════════════════════════

def test_bridge_service_down_event():
    import bridge
    event = {
        "type": "service",
        "service_id": "abc",
        "service_name": "My API",
        "service_type": "http",
        "target": "https://api.example.com",
        "state": "down",
        "message": "HTTP 503",
    }
    payload = bridge._translate(event)
    assert payload is not None
    assert payload["plugin"] == "service_monitor"
    assert payload["status"] == "active"
    assert "My API" in payload["message"]
    assert "DOWN" in payload["message"]


def test_bridge_service_up_event():
    import bridge
    event = {
        "type": "service",
        "service_id": "abc",
        "service_name": "My API",
        "service_type": "tcp",
        "target": "192.168.2.1",
        "state": "up",
        "message": "port 22 open",
    }
    payload = bridge._translate(event)
    assert payload["status"] == "ok"
    assert "UP" in payload["message"]


# ══════════════════════════════════════════════════════════════════════════════
# 6. store_check_result — state-change tracking
# ══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_store_check_result_first_run(tmp_data_dir):
    """First run: stores result, no bridge notification."""
    import app as _app
    svc = _add_svc(_app, type="ping", host="127.0.0.1")
    _app._svc_prev_state.pop(svc["id"], None)

    bridge_calls = []
    with patch.object(_app.bridge, "forward", new=AsyncMock(side_effect=lambda e: bridge_calls.append(e))):
        await _app._store_check_result(svc, {"id": svc["id"], "up": True, "response_ms": 10, "message": "ok"})

    assert _app._svc_prev_state[svc["id"]] == "up"
    assert len(bridge_calls) == 0  # no previous state → no notification


@pytest.mark.asyncio
async def test_store_check_result_state_change(tmp_data_dir):
    """up→down triggers bridge notification."""
    import app as _app
    svc = _add_svc(_app, type="ping", host="127.0.0.1")
    _app._svc_prev_state[svc["id"]] = "up"

    bridge_calls = []
    with patch.object(_app.bridge, "forward", new=AsyncMock(side_effect=lambda e: bridge_calls.append(e))):
        await _app._store_check_result(svc, {"id": svc["id"], "up": False, "response_ms": None, "message": "no response"})

    assert _app._svc_prev_state[svc["id"]] == "down"
    assert len(bridge_calls) == 1
    assert bridge_calls[0]["state"] == "down"


@pytest.mark.asyncio
async def test_store_check_result_no_change(tmp_data_dir):
    """Same state → no bridge notification."""
    import app as _app
    svc = _add_svc(_app, type="ping", host="127.0.0.1")
    _app._svc_prev_state[svc["id"]] = "up"

    bridge_calls = []
    with patch.object(_app.bridge, "forward", new=AsyncMock(side_effect=lambda e: bridge_calls.append(e))):
        await _app._store_check_result(svc, {"id": svc["id"], "up": True, "response_ms": 5, "message": "ok"})

    assert len(bridge_calls) == 0


# ══════════════════════════════════════════════════════════════════════════════
# 7. SSL verify + security check
# ══════════════════════════════════════════════════════════════════════════════

def test_api_services_add_ssl_verify_false(client):
    """Service can be added with ssl_verify=False."""
    r = client.post("/api/services", json={
        "type": "http", "name": "Internal", "target": "https://internal.local",
        "ssl_verify": False,
    })
    assert r.status_code == 200
    sid = r.json()["id"]
    svcs = client.get("/api/services").json()
    svc = next(s for s in svcs if s["id"] == sid)
    assert svc["ssl_verify"] is False


def test_migrate_domain_has_ssl_verify(tmp_data_dir):
    """Migrated domains include ssl_verify=True by default."""
    import app as _app
    migrated = _app._migrate_domain({"url": "https://example.com", "name": "X"})
    assert migrated.get("ssl_verify") is True


@pytest.mark.asyncio
async def test_check_http_ssl_verify_false(tmp_data_dir):
    """When ssl_verify=False the unverified SSL context is used."""
    import app as _app
    import ssl as ssl_mod
    svc = {"id": "x", "type": "http", "target": "https://self-signed.local",
           "method": "GET", "expected_status": 200, "expected_text": "",
           "ssl_verify": False}

    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.url = svc["target"]
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read = MagicMock(return_value=b"OK")

    used_ctx = []
    original_urlopen = __import__("urllib.request", fromlist=["urlopen"]).urlopen

    def _capture_urlopen(req, timeout=None, context=None):
        used_ctx.append(context)
        return mock_resp

    with patch("urllib.request.urlopen", side_effect=_capture_urlopen):
        # also patch SSL check so it doesn't actually connect
        with patch.object(_app, "_check_ssl_sync", return_value={"valid": False, "error": "skipped"}):
            res = await _app._check_http(svc)

    assert res["up"] is True
    # context should be an unverified SSL context, not None (which means verified)
    ctx_used = used_ctx[0] if used_ctx else None
    assert ctx_used is not None  # ssl_verify=False must pass an unverified context


@pytest.mark.asyncio
async def test_check_security_good_headers(tmp_data_dir):
    """_check_security returns 'ok' for all headers present."""
    import app as _app

    good_headers = {
        "strict-transport-security": "max-age=31536000; includeSubDomains",
        "x-frame-options": "SAMEORIGIN",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'",
        "referrer-policy": "strict-origin-when-cross-origin",
    }

    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.url = "https://example.com"
    mock_resp.headers = good_headers
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read = MagicMock(return_value=b"")

    with patch("urllib.request.urlopen", return_value=mock_resp):
        findings = await _app._check_security("https://example.com", ssl_verify=False)

    by_name = {f["name"]: f for f in findings}
    assert by_name["HSTS"]["status"] == "ok"
    assert by_name["X-Frame-Options"]["status"] == "ok"
    assert by_name["X-Content-Type-Options"]["status"] == "ok"
    assert by_name["CSP"]["status"] == "ok"
    assert by_name["Referrer-Policy"]["status"] == "ok"


@pytest.mark.asyncio
async def test_check_security_missing_headers(tmp_data_dir):
    """_check_security returns fail/warn for missing security headers."""
    import app as _app

    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.url = "https://example.com"
    mock_resp.headers = {}  # no security headers at all
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read = MagicMock(return_value=b"")

    with patch("urllib.request.urlopen", return_value=mock_resp):
        findings = await _app._check_security("https://example.com", ssl_verify=False)

    by_name = {f["name"]: f for f in findings}
    assert by_name["HSTS"]["status"] == "fail"
    assert by_name["X-Frame-Options"]["status"] == "warn"
    assert by_name["X-Content-Type-Options"]["status"] == "warn"
    assert by_name["CSP"]["status"] == "warn"


@pytest.mark.asyncio
async def test_check_security_http_no_redirect(tmp_data_dir):
    """HTTP URL without HTTPS redirect → fail."""
    import app as _app

    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.url = "http://example.com"  # stays http
    mock_resp.headers = {}
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read = MagicMock(return_value=b"")

    with patch("urllib.request.urlopen", return_value=mock_resp):
        findings = await _app._check_security("http://example.com")

    by_name = {f["name"]: f for f in findings}
    assert by_name["HTTPS Redirect"]["status"] == "fail"


@pytest.mark.asyncio
async def test_check_security_hsts_short_maxage(tmp_data_dir):
    """HSTS with max-age < 31536000 → warn."""
    import app as _app

    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.url = "https://example.com"
    mock_resp.headers = {"strict-transport-security": "max-age=3600"}
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read = MagicMock(return_value=b"")

    with patch("urllib.request.urlopen", return_value=mock_resp):
        findings = await _app._check_security("https://example.com", ssl_verify=False)

    by_name = {f["name"]: f for f in findings}
    assert by_name["HSTS"]["status"] == "warn"


# ══════════════════════════════════════════════════════════════════════════════
# 8. Preview endpoint
# ══════════════════════════════════════════════════════════════════════════════

def test_api_preview_http(client):
    """Preview endpoint runs check + security scan without saving."""
    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.url = "https://example.com"
    mock_resp.headers = {"x-frame-options": "DENY", "x-content-type-options": "nosniff"}
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    mock_resp.read = MagicMock(return_value=b"Hello")

    with patch("urllib.request.urlopen", return_value=mock_resp):
        with patch("app._check_ssl_sync", return_value={"valid": True, "days_left": 90}):
            r = client.post("/api/services/preview", json={
                "type": "http",
                "target": "https://example.com",
                "method": "GET",
                "expected_status": 200,
                "ssl_verify": False,
            })

    assert r.status_code == 200
    j = r.json()
    assert "check" in j
    assert "security" in j
    assert j["check"]["up"] is True
    # Service must NOT be saved
    svcs = client.get("/api/services").json()
    assert svcs == []


def test_api_preview_ping_no_security(client):
    """Preview for non-HTTP type returns empty security list."""
    r = client.post("/api/services/preview", json={
        "type": "ping",
        "host": "127.0.0.1",
    })
    assert r.status_code == 200
    j = r.json()
    assert j["check"]["up"] is True
    assert j["security"] == []  # no security scan for ping


def test_api_preview_tcp_no_save(client):
    """Preview TCP check doesn't save the service."""
    import asyncio
    import socket as _sock

    # Find a free port
    s = _sock.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()

    r = client.post("/api/services/preview", json={
        "type": "tcp",
        "host": "127.0.0.1",
        "port": port,  # closed port → down is OK
    })
    assert r.status_code == 200
    # No service saved
    assert client.get("/api/services").json() == []
