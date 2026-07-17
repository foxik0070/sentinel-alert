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
