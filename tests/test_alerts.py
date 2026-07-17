"""
Tests for alerts.py — watchlist matching + persistence + notify gating.
"""
import json

import pytest


@pytest.fixture
def wl(monkeypatch, tmp_path):
    """Redirect watchlist path to temp file, reset cache and config."""
    import alerts
    path = str(tmp_path / "watchlist.json")
    monkeypatch.setattr(alerts, "WATCHLIST_PATH", path)
    alerts._wl_cache["mtime"] = -1.0
    alerts._wl_cache["items"] = []
    alerts._cfg.update(enabled=False, ntfy_url="", telegram_token="", telegram_chat="")
    return alerts


# ── watchlist persistence ─────────────────────────────────────────────────────

def test_empty_watchlist(wl):
    assert wl.load_watchlist() == []


def test_save_dedup_sorted(wl):
    wl.save_watchlist(["1.2.3.4", "1.2.3.4", " 5.6.7.8 ", ""])
    assert wl.load_watchlist() == ["1.2.3.4", "5.6.7.8"]


def test_cache_invalidated_on_write(wl):
    wl.save_watchlist(["10.0.0.1"])
    assert wl.load_watchlist() == ["10.0.0.1"]
    wl.save_watchlist(["10.0.0.2"])
    assert wl.load_watchlist() == ["10.0.0.2"]


# ── watchlist matching ────────────────────────────────────────────────────────

def test_exact_match(wl):
    wl.save_watchlist(["203.0.113.5"])
    assert wl.is_watched("203.0.113.5") is True
    assert wl.is_watched("203.0.113.6") is False


def test_prefix_match(wl):
    wl.save_watchlist(["203.0.113."])
    assert wl.is_watched("203.0.113.5") is True
    assert wl.is_watched("203.0.113.250") is True
    assert wl.is_watched("203.0.114.5") is False


def test_cidr_match(wl):
    wl.save_watchlist(["10.0.0.0/24"])
    assert wl.is_watched("10.0.0.1") is True
    assert wl.is_watched("10.0.0.255") is True
    assert wl.is_watched("10.0.1.1") is False


def test_cidr_larger_block(wl):
    wl.save_watchlist(["172.16.0.0/12"])
    assert wl.is_watched("172.16.5.5") is True
    assert wl.is_watched("172.31.255.255") is True
    assert wl.is_watched("172.32.0.1") is False


def test_invalid_ip_never_matches(wl):
    wl.save_watchlist(["1.2.3.4"])
    assert wl.is_watched("not-an-ip") is False
    assert wl.is_watched("") is False
    assert wl.is_watched(None) is False


def test_malformed_cidr_ignored(wl):
    wl.save_watchlist(["999.999.0.0/8", "1.2.3.4"])
    # bad CIDR must not raise, valid entry still matches
    assert wl.is_watched("1.2.3.4") is True


# ── notify gating ─────────────────────────────────────────────────────────────

def test_notify_disabled_is_noop(wl, monkeypatch):
    called = []
    monkeypatch.setattr(wl, "_notify_sync", lambda t, m: called.append((t, m)))
    wl.notify("title", "msg")  # enabled=False → must not spawn
    assert called == []


def test_notify_enabled_spawns(wl, monkeypatch):
    import threading
    started = []
    real_thread = threading.Thread

    def fake_thread(*a, **k):
        started.append(k.get("args"))
        t = real_thread(*a, **k)
        return t

    wl.configure(enabled=True, ntfy_url="https://ntfy.sh/x")
    monkeypatch.setattr(wl, "_notify_sync", lambda t, m: None)
    monkeypatch.setattr(threading, "Thread", fake_thread)
    wl.notify("T", "M")
    assert started and started[0] == ("T", "M")
