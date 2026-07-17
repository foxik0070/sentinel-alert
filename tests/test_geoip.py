"""
Tests for geoip.lookup — private/invalid IP handling without network.
"""
import geoip


def test_private_ip_is_lan():
    lat, lon, country, isp = geoip.lookup("192.168.2.10")
    assert (lat, lon) == (0.0, 0.0)
    assert country == "LAN"
    assert isp == "Local"


def test_loopback_is_lan():
    _, _, country, _ = geoip.lookup("127.0.0.1")
    assert country == "LAN"


def test_link_local_is_lan():
    _, _, country, _ = geoip.lookup("169.254.1.1")
    assert country == "LAN"


def test_invalid_ip():
    lat, lon, country, isp = geoip.lookup("not-an-ip")
    assert (lat, lon) == (0.0, 0.0)
    assert country == "Invalid"
    assert isp == "Invalid"


def test_lookup_asn_bad_ip_returns_none():
    # No exception even when ASN reader missing or IP malformed
    assert geoip.lookup_asn("not-an-ip") is None
