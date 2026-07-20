"""
Tests for analytics endpoints, CEF export, and alert channel fan-out.
"""
import sqlite3
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def tmp_data_dir(monkeypatch, tmp_path):
    import app as _app
    import db_init
    data = tmp_path / "data"
    data.mkdir()
    db_path = str(data / "alerts.db")
    monkeypatch.setattr(_app, "DB_PATH", db_path)
    monkeypatch.setattr(db_init, "DB_PATH", db_path)
    db_init.init()
    return db_path


@pytest.fixture
def client(tmp_data_dir):
    import app as _app
    with TestClient(_app.app) as c:
        yield c


def _seed(db_path, n=5, ip="203.0.113.7", proto="ssh", country="US"):
    conn = sqlite3.connect(db_path)
    ts = datetime.now().isoformat()
    for i in range(n):
        conn.execute(
            "INSERT INTO attacks (ts, src_ip, dst_port, protocol, country, lat, lon, isp) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (ts, ip, 22 + i, proto, country, 1.0, 2.0, "TestISP"))
    conn.commit()
    conn.close()


# ── analytics ─────────────────────────────────────────────────────────────────

def test_heatmap_shape(client):
    j = client.get("/api/analytics/heatmap?days=30").json()
    assert len(j["grid"]) == 7
    assert all(len(row) == 24 for row in j["grid"])


def test_ports(client, tmp_data_dir):
    _seed(tmp_data_dir, n=3)
    rows = client.get("/api/analytics/ports").json()["rows"]
    assert isinstance(rows, list)
    assert all("dst_port" in r and "n" in r for r in rows)


def test_correlation_multi_port(client, tmp_data_dir):
    # jedna IP na 5 portech → korelace ji chytí (ports > 3)
    _seed(tmp_data_dir, n=5, ip="203.0.113.9")
    rows = client.get("/api/analytics/correlation").json()["rows"]
    assert any(r["src_ip"] == "203.0.113.9" for r in rows)


def test_subnets_clustering(client, tmp_data_dir):
    _seed(tmp_data_dir, n=4, ip="45.83.12.5")
    _seed(tmp_data_dir, n=2, ip="45.83.12.99")
    rows = client.get("/api/analytics/subnets").json()["rows"]
    assert any(r["subnet"] == "45.83.12.0/24" and r["unique_ips"] == 2 for r in rows)


def test_prediction_forecast(client, tmp_data_dir):
    _seed(tmp_data_dir, n=10)
    j = client.get("/api/analytics/prediction").json()
    assert "forecast" in j and isinstance(j["forecast"], list)


def test_onthisday(client, tmp_data_dir):
    _seed(tmp_data_dir, n=3)
    j = client.get("/api/analytics/onthisday").json()
    assert j["today"] >= 3


# ── CEF export ────────────────────────────────────────────────────────────────

def test_cef_export(client, tmp_data_dir, monkeypatch):
    import conf
    monkeypatch.setattr(conf, "AUTH_API_TOKEN", "")
    _seed(tmp_data_dir, n=2, ip="198.51.100.4")
    # potřebuje auth — přihlas se
    import conf as _c
    monkeypatch.setattr(_c, "AUTH_USERNAME", "admin")
    monkeypatch.setattr(_c, "AUTH_PASSWORD", "pw")
    client.post("/api/login", json={"username": "admin", "password": "pw"})
    r = client.get("/api/export/attacks?fmt=cef")
    assert r.status_code == 200
    assert "CEF:0|Sentinel" in r.text
    assert "src=198.51.100.4" in r.text


# ── RSS feed ──────────────────────────────────────────────────────────────────

def test_rss_feed(client, tmp_data_dir):
    _seed(tmp_data_dir, n=1, ip="203.0.113.55")
    r = client.get("/feed.xml")
    assert r.status_code == 200
    assert "<rss" in r.text and "203.0.113.55" in r.text


# ── alert channel fan-out ─────────────────────────────────────────────────────

def test_alerts_slack_discord_fanout(monkeypatch):
    import alerts
    posted = []
    monkeypatch.setattr(alerts, "_post_json", lambda url, payload: posted.append((url, payload)))
    monkeypatch.setattr(alerts, "_send_email", lambda t, m: posted.append(("email", None)))
    monkeypatch.setattr(alerts, "_send_syslog", lambda t, m: posted.append(("syslog", None)))
    alerts.configure(enabled=True, slack_webhook="https://slack/x",
                     discord_webhook="https://discord/x", rocketchat_webhook="https://rc/x",
                     smtp_host="mail", smtp_to="a@b.c", syslog_host="1.2.3.4")
    alerts._notify_sync("T", "M")
    urls = [p[0] for p in posted]
    assert "https://slack/x" in urls
    assert "https://discord/x" in urls
    assert "https://rc/x" in urls
    assert "email" in urls
    assert "syslog" in urls
