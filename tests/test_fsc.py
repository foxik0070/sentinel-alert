"""Zavaznost bezpecnostnich aktualizaci a interval skenu.

Drive se zavaznost urcovala podrezetezcem nazvu balicku, takze 'libc'
chytalo libcares2 a 'linux' chytalo linux-libc-dev (hlavicky jadra pro
kompilaci, za behu se nepouzivaji) — z obojiho bylo "critical".
"""
import pytest

import conf as _conf
import fsc


@pytest.mark.parametrize("pkg,expected", [
    # skutecne kriticke: jadro, SSH, TLS, zakladni knihovny a eskalace prav
    ("linux-image-6.12.116-amd64", "crit"),
    ("linux-headers-6.1.0-18-amd64", "crit"),
    ("proxmox-kernel-7.0", "crit"),
    ("openssh-server", "crit"),
    ("libssl3t64", "crit"),
    ("libc6", "crit"),
    ("sudo", "crit"),
    ("bash", "crit"),
    # sluzby a bezne knihovny
    ("apache2-bin", "high"),
    ("libpq5", "high"),
    ("python3-pil", "high"),
    ("libcares2", "high"),
    # zbytek
    ("linux-libc-dev", "med"),
    ("bashtop", "med"),
    ("vim", "med"),
])
def test_classify_package(pkg, expected):
    assert fsc.classify_package(pkg) == expected


def test_prefix_not_substring():
    """Jadro ano, hlavicky jadra ne — to je cely rozdil oproti puvodnimu chovani."""
    assert fsc.classify_package("linux-image-6.1.0") == "crit"
    assert fsc.classify_package("linux-libc-dev") != "crit"
    assert fsc.classify_package("libcares2") != "crit"


def test_classify_is_case_and_space_insensitive():
    """Nazvy chodi ze vzdalenych hostu jako carkou oddeleny seznam."""
    assert fsc.classify_package("  OpenSSH-Server ") == "crit"


def test_scan_interval_default_is_hourly(monkeypatch):
    monkeypatch.setattr(_conf, "FSC_SCAN_INTERVAL_MIN", 60, raising=False)
    assert fsc._scan_interval_seconds() == 3600


def test_scan_interval_zero_keeps_daily_schedule(monkeypatch):
    """0 = puvodni chovani, tedy jediny sken ve 2:00."""
    monkeypatch.setattr(_conf, "FSC_SCAN_INTERVAL_MIN", 0, raising=False)
    assert fsc._scan_interval_seconds() == 0


def test_scan_interval_ignores_nonsense(monkeypatch):
    monkeypatch.setattr(_conf, "FSC_SCAN_INTERVAL_MIN", -5, raising=False)
    assert fsc._scan_interval_seconds() == 0
