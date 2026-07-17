"""
Tests for totp.py (RFC 6238) and API-token access control.
"""
import time

import pytest
from fastapi.testclient import TestClient

import totp


# ── TOTP algoritmus ───────────────────────────────────────────────────────────

def test_secret_format():
    s = totp.generate_secret()
    assert len(s) == 32
    assert s.isalnum() and s.isupper()


def test_verify_current_code():
    s = totp.generate_secret()
    code = totp._hotp(s, int(time.time()) // 30)
    assert totp.verify(s, code) is True


def test_verify_wrong_code():
    s = totp.generate_secret()
    assert totp.verify(s, "000000") is False
    assert totp.verify(s, "abcdef") is False
    assert totp.verify(s, "") is False


def test_verify_window_tolerance():
    s = totp.generate_secret()
    prev = totp._hotp(s, int(time.time()) // 30 - 1)  # předchozí okno
    assert totp.verify(s, prev, window=1) is True


def test_provisioning_uri():
    uri = totp.provisioning_uri("ABC123", "admin")
    assert uri.startswith("otpauth://totp/")
    assert "secret=ABC123" in uri
    assert "issuer=Sentinel-Alert" in uri


# ── API token access control ──────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def tmp_data_dir(monkeypatch, tmp_path):
    import app as _app
    import db_init
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(_app, "DB_PATH", str(data / "alerts.db"))
    monkeypatch.setattr(db_init, "DB_PATH", str(data / "alerts.db"))
    db_init.init()
    return tmp_path


@pytest.fixture
def client(tmp_data_dir):
    import app as _app
    with TestClient(_app.app) as c:
        yield c


def test_token_read_only_get(client, monkeypatch):
    import conf
    monkeypatch.setattr(conf, "AUTH_API_TOKEN", "secret-token")
    # GET non-sensitive endpoint passes with token
    r = client.get("/api/status?token=secret-token")
    assert r.status_code == 200


def test_token_rejected_on_sensitive(client, monkeypatch):
    import conf
    monkeypatch.setattr(conf, "AUTH_API_TOKEN", "secret-token")
    # backup is sensitive → token not allowed
    assert client.get("/api/backup?token=secret-token").status_code == 401
    assert client.get("/api/config/full?token=secret-token").status_code == 401


def test_token_rejected_on_mutation(client, monkeypatch):
    import conf
    monkeypatch.setattr(conf, "AUTH_API_TOKEN", "secret-token")
    # POST is a mutation → token never grants it
    r = client.post("/api/config/update?token=secret-token", json={})
    assert r.status_code == 401


def test_wrong_token_rejected(client, monkeypatch):
    import conf
    monkeypatch.setattr(conf, "AUTH_API_TOKEN", "secret-token")
    assert client.get("/api/status?token=nope").status_code == 401


def test_login_requires_totp_when_enabled(client, monkeypatch):
    import conf
    secret = totp.generate_secret()
    monkeypatch.setattr(conf, "AUTH_USERNAME", "admin")
    monkeypatch.setattr(conf, "AUTH_PASSWORD", "pw")
    monkeypatch.setattr(conf, "AUTH_TOTP_SECRET", secret)
    # correct password but no code → totp_required
    r = client.post("/api/login", json={"username": "admin", "password": "pw"})
    assert r.status_code == 401
    assert r.json().get("totp_required") is True
    # with valid code → ok
    code = totp._hotp(secret, int(time.time()) // 30)
    r = client.post("/api/login", json={"username": "admin", "password": "pw", "totp": code})
    assert r.status_code == 200
