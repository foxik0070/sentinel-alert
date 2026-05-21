import ipaddress
import os
import urllib.request
import json
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GEOIP_PATH = os.path.join(BASE_DIR, "data", "GeoLite2-City.mmdb")
ASN_PATH   = os.path.join(BASE_DIR, "data", "GeoLite2-ASN.mmdb")

_reader     = None
_asn_reader = None
_isp_cache: dict = {}   # ip -> isp string
_geo_cache: dict = {}   # ip -> (lat, lon, country, isp)
_isp_lock = threading.Lock()


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


def _get_asn_reader():
    global _asn_reader
    if _asn_reader is not None:
        return _asn_reader
    if not os.path.exists(ASN_PATH):
        return None
    try:
        import geoip2.database
        _asn_reader = geoip2.database.Reader(ASN_PATH)
        return _asn_reader
    except Exception as e:
        print(f"GeoIP ASN reader init failed: {e}")
        return None


def _lookup_isp_api(ip: str) -> str | None:
    """Cached ISP lookup via ip-api.com (free, 45 req/min, no key needed).
    Returns None on failure so callers can retry later."""
    with _isp_lock:
        if ip in _isp_cache:
            return _isp_cache[ip]
    try:
        url = f"http://ip-api.com/json/{ip}?fields=isp,org"
        with urllib.request.urlopen(url, timeout=4) as resp:
            d = json.loads(resp.read())
        isp = d.get("isp") or d.get("org") or None
    except Exception:
        isp = None
    if isp:
        with _isp_lock:
            if len(_isp_cache) > 5000:
                _isp_cache.clear()
            _isp_cache[ip] = isp
    return isp


def _lookup_api_full(ip: str):
    """Full GeoIP via ip-api.com: (lat, lon, country, isp) or None on failure."""
    with _isp_lock:
        if ip in _geo_cache:
            return _geo_cache[ip]
    try:
        url = f"http://ip-api.com/json/{ip}?fields=status,lat,lon,country,isp,org"
        with urllib.request.urlopen(url, timeout=4) as resp:
            d = json.loads(resp.read())
        if d.get("status") == "fail":
            return None
        result = (
            float(d.get("lat") or 0.0),
            float(d.get("lon") or 0.0),
            d.get("country") or "Unknown",
            d.get("isp") or d.get("org") or "Unknown",
        )
    except Exception:
        return None
    if result[0] or result[1]:  # only cache if we got coordinates
        with _isp_lock:
            if len(_geo_cache) > 5000:
                _geo_cache.clear()
            _geo_cache[ip] = result
    return result


def lookup_asn(ip: str) -> str | None:
    """Return ISP/org from ASN database, or None if unavailable."""
    asn = _get_asn_reader()
    if asn is None:
        return None
    try:
        r = asn.asn(ip)
        return r.autonomous_system_organization or None
    except Exception:
        return None


def lookup(ip):
    """Return (lat, lon, country, isp). Safe for private/invalid IPs."""
    try:
        addr = ipaddress.ip_address(ip)
        if addr.is_private or addr.is_loopback or addr.is_link_local:
            return 0.0, 0.0, "LAN", "Local"
    except ValueError:
        return 0.0, 0.0, "Invalid", "Invalid"

    lat, lon, country, isp = 0.0, 0.0, "Unknown", None

    reader = _get_reader()
    if reader is not None:
        try:
            res = reader.city(ip)
            lat = float(res.location.latitude or 0.0)
            lon = float(res.location.longitude or 0.0)
            country = res.country.name or "Unknown"
            isp = (getattr(res.traits, "isp", None)
                   or getattr(res.traits, "organization", None)
                   or lookup_asn(ip))
        except Exception:
            pass

    # If GeoLite2 gave no coordinates, try ip-api.com for a complete lookup
    if not lat and not lon:
        full = _lookup_api_full(ip)
        if full:
            lat, lon = full[0], full[1]
            if country == "Unknown":
                country = full[2]
            if not isp:
                isp = full[3]
    elif not isp:
        isp = _lookup_isp_api(ip)

    return lat, lon, country, isp or "Unknown"
