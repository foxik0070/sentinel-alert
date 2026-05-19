import ipaddress
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GEOIP_PATH = os.path.join(BASE_DIR, "data", "GeoLite2-City.mmdb")

_reader = None


def _get_reader():
    global _reader
    if _reader is not None:
        return _reader
    if not os.path.exists(GEOIP_PATH):
        return None
    try:
        import geoip2.database
        _reader = geoip2.database.Reader(GEOIP_PATH)
        return _reader
    except Exception as e:
        print(f"GeoIP reader init failed: {e}")
        return None


def lookup(ip):
    """Return (lat, lon, country, isp). Safe for private/invalid IPs."""
    try:
        addr = ipaddress.ip_address(ip)
        if addr.is_private or addr.is_loopback or addr.is_link_local:
            return 0.0, 0.0, "LAN", "Local"
    except ValueError:
        return 0.0, 0.0, "Invalid", "Invalid"

    reader = _get_reader()
    if reader is None:
        return 0.0, 0.0, "NoDB", "NoDB"
    try:
        res = reader.city(ip)
        return (
            float(res.location.latitude or 0.0),
            float(res.location.longitude or 0.0),
            res.country.name or "Unknown",
            res.traits.isp or "Unknown",
        )
    except Exception:
        return 0.0, 0.0, "Unknown", "Unknown"
