"""
Tests for newer API surface: /healthz, /api/stats/trends, login rate-limit.
"""
import sqlite3
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def tmp_data_dir(monkeypatch, tmp_path):
    import app as _app
    import db_init

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    db_path = str(data_dir / "alerts.db")
    monkeypatch.setattr(_app, "DB_PATH", db_path)
    monkeypatch.setattr(db_init, "DB_PATH", db_path)
    db_init.init()
    _app._login_attempts.clear()
    return db_path


@pytest.fixture
def client(tmp_data_dir):
    import app as _app
    with TestClient(_app.app) as c:
        yield c


def _insert_attack(db_path, ts, protocol="ssh", ip="9.9.9.9"):
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO attacks (ts, src_ip, dst_port, protocol, country, lat, lon, isp) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (ts, ip, 22, protocol, "US", 1.0, 2.0, "X"))
    conn.commit()
    conn.close()


# ── /healthz ──────────────────────────────────────────────────────────────────

def test_healthz_ok(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "ok"
    assert j["db"]["ok"] is True
    assert "uptime_s" in j


def test_security_headers_present(client):
    r = client.get("/healthz")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "SAMEORIGIN"
    assert "content-security-policy" in r.headers


# ── /api/stats/trends ─────────────────────────────────────────────────────────

def test_trends_aggregation(client, tmp_data_dir):
    today = datetime.now()
    _insert_attack(tmp_data_dir, today.isoformat(), "ssh")
    _insert_attack(tmp_data_dir, today.isoformat(), "ssh")
    _insert_attack(tmp_data_dir, today.isoformat(), "http")
    _insert_attack(tmp_data_dir, (today - timedelta(days=2)).isoformat(), "https")

    j = client.get("/api/stats/trends?days=7").json()
    assert j["days"] == 7
    # today: 2 ssh + 1 http, 2 days ago: 1 https
    by = {(r["day"], r["protocol"]): r["n"] for r in j["rows"]}
    day = today.strftime("%Y-%m-%d")
    assert by[(day, "ssh")] == 2
    assert by[(day, "http")] == 1
    assert j["total_current"] == 4


def test_trends_days_clamped(client):
    assert client.get("/api/stats/trends?days=999").json()["days"] == 90
    assert client.get("/api/stats/trends?days=0").json()["days"] == 1


# ── login rate-limit ──────────────────────────────────────────────────────────

def test_login_rate_limit(client):
    # 5 failed attempts allowed, 6th returns 429
    for _ in range(5):
        r = client.post("/api/login", json={"username": "x", "password": "wrong"})
        assert r.status_code == 401
    r = client.post("/api/login", json={"username": "x", "password": "wrong"})
    assert r.status_code == 429


def test_login_success_resets_counter(client, monkeypatch):
    import conf
    monkeypatch.setattr(conf, "AUTH_USERNAME", "admin")
    monkeypatch.setattr(conf, "AUTH_PASSWORD", "secret")
    for _ in range(3):
        client.post("/api/login", json={"username": "admin", "password": "wrong"})
    r = client.post("/api/login", json={"username": "admin", "password": "secret"})
    assert r.status_code == 200
    # counter cleared → can attempt again without hitting limit
    r = client.post("/api/login", json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401


# --- Security Center: inventar hostu patri za prihlaseni ---------------------
# Endpointy /api/fsc/* byly verejne, protoze sken spoustel systemd casovac bez
# prihlaseni. Od [security_center] scan_interval_minutes si sken plánuje
# aplikace sama, takze duvod odpadl. /api/fsc/data pritom vraci OS, jadro,
# otevrene problemy a porty vsech monitorovanych hostu.

FSC_READ = ["/api/fsc/data", "/api/fsc/hosts"]
FSC_WRITE = [("/api/fsc/scan", None), ("/api/fsc/hosts/toggle", {"ip": "192.0.2.1"})]


@pytest.mark.parametrize("path", FSC_READ)
def test_fsc_read_requires_auth(client, path):
    assert client.get(path).status_code == 401


@pytest.mark.parametrize("path,payload", FSC_WRITE)
def test_fsc_write_requires_auth(client, path, payload):
    r = client.post(path, json=payload) if payload else client.post(path)
    assert r.status_code == 401


@pytest.mark.parametrize("path", FSC_READ)
def test_fsc_read_allowed_for_admin(client, path):
    import app as _app
    client.cookies.set(_app._AUTH_COOKIE, _app._make_token("a"))
    assert client.get(path).status_code == 200


def test_fsc_scan_allowed_for_admin(client):
    import app as _app
    client.cookies.set(_app._AUTH_COOKIE, _app._make_token("a"))
    assert client.post("/api/fsc/scan").json() == {"status": "started"}


@pytest.mark.parametrize("path", FSC_READ)
def test_fsc_read_allowed_for_viewer(client, path):
    """Viewer smi cist, ne menit."""
    import app as _app
    client.cookies.set(_app._AUTH_COOKIE, _app._make_token("v"))
    assert client.get(path).status_code == 200


def test_fsc_scan_denied_for_viewer(client):
    import app as _app
    client.cookies.set(_app._AUTH_COOKIE, _app._make_token("v"))
    assert client.post("/api/fsc/scan").status_code == 401


def test_fsc_toggle_denied_for_viewer(client):
    """Prepnuti hosta meni stav — viewer na to nema."""
    import app as _app
    client.cookies.set(_app._AUTH_COOKIE, _app._make_token("v"))
    assert client.post("/api/fsc/hosts/toggle", json={"ip": "192.0.2.1"}).status_code == 401


# --- Service checky: zapis jen pro prihlasene -------------------------------
# Stejny pripad jako /api/fsc/*: kdokoliv v siti mohl service checky mazat
# nebo pridavat. Cteni smi i viewer a read-only token, zapis jen admin.

SVC_READ = ["/api/services", "/api/services/settings"]
SVC_WRITE = [
    ("post", "/api/services", {"type": "http", "name": "x", "target": "http://example.invalid"}),
    ("post", "/api/services/check", None),
    ("post", "/api/services/settings", {"interval_min": 5}),
    ("delete", "/api/services/does-not-exist", None),
]


@pytest.mark.parametrize("path", SVC_READ)
def test_services_read_requires_auth(client, path):
    assert client.get(path).status_code == 401


@pytest.mark.parametrize("method,path,payload", SVC_WRITE)
def test_services_write_requires_auth(client, method, path, payload):
    fn = getattr(client, method)
    r = fn(path, json=payload) if payload else fn(path)
    assert r.status_code == 401


@pytest.mark.parametrize("path", SVC_READ)
def test_services_read_allowed_for_viewer(client, path):
    import app as _app
    client.cookies.set(_app._AUTH_COOKIE, _app._make_token("v"))
    assert client.get(path).status_code == 200


def test_services_delete_denied_for_viewer(client):
    import app as _app
    client.cookies.set(_app._AUTH_COOKIE, _app._make_token("v"))
    assert client.delete("/api/services/does-not-exist").status_code == 401


def test_services_delete_reports_missing_for_admin(client):
    """Admin dostane 404, ne ticho — frontend na tom stavi hlasku."""
    import app as _app
    client.cookies.set(_app._AUTH_COOKIE, _app._make_token("a"))
    r = client.delete("/api/services/does-not-exist")
    assert r.status_code == 404
    assert r.json() == {"error": "not found"}


# --- Dialogy a cache: oprava "sluzbu nejde smazat" -------------------------
# Nativni confirm() se ve vestavenych prohlizecich (Android WebView bez
# onJsConfirm, HA Companion, Fully Kiosk) NEZOBRAZI a vrati false. Akce pak
# skonci bez pozadavku i bez hlasky. Druha cast: skripty se nacitaly bez verze,
# takze zarizeni mohlo bezet na stare JS z cache.

def test_index_adds_version_to_assets(client):
    import app as _app
    client.cookies.set(_app._AUTH_COOKIE, _app._make_token("a"))
    html = client.get("/").text
    assert "/static/js/08-services.js?v=" in html, "skripty musi nest verzi"
    assert f"?v={_app.conf.VERSION}" in html


def test_service_worker_cache_carries_version(client):
    import app as _app
    js = client.get("/sw.js").text
    assert f"sentinel-shell-{_app.conf.VERSION}" in js, \
        "nazev cache musi nest verzi, jinak SW drzi stary shell"


def test_no_native_dialogs_left_in_frontend():
    """Zadne confirm()/alert()/prompt() — ve WebView tise selzou."""
    import os, re
    js_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          'static', 'js')
    offenders = []
    for f in sorted(os.listdir(js_dir)):
        if not f.endswith('.js'):
            continue
        src = open(os.path.join(js_dir, f), encoding='utf-8').read()
        # 00-ui.js je definuje jako nahradu, tam je zminka v komentari v poradku
        for m in re.finditer(r'(?<![\w.$])(confirm|alert|prompt)\(', src):
            line = src[:m.start()].count('\n') + 1
            ctx = src.split('\n')[line - 1].strip()
            if ctx.startswith(('//', '*', '/*')):
                continue
            offenders.append(f"{f}:{line} {ctx[:60]}")
    assert not offenders, "nativni dialogy zustaly:\n" + "\n".join(offenders)
