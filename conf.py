"""Central config loader.

Reads /etc/sentinel/sentinel-alert.conf (INI format).
Override path via SENTINEL_CONF env var.
Each module may still accept its own env vars as highest priority.
"""
import configparser
import os

CONF_PATH = os.environ.get("SENTINEL_CONF", "/etc/sentinel/sentinel-alert.conf")

_c = configparser.ConfigParser(interpolation=None)
_c.read(CONF_PATH)  # silent if file missing — all values fall back to defaults


def _s(section, key, fallback=""):
    return _c.get(section, key, fallback=fallback)


def _i(section, key, fallback=0):
    return _c.getint(section, key, fallback=fallback)


def _f(section, key, fallback=0.0):
    return _c.getfloat(section, key, fallback=fallback)


# [server]
SERVER_HOST = _s("server", "host", "0.0.0.0")
SERVER_PORT = _i("server", "port", 5056)

# [auth]
AUTH_USERNAME = _s("auth", "username", "admin")
AUTH_PASSWORD = _s("auth", "password", "admin")
AUTH_SECRET   = _s("auth", "secret",   "") or os.urandom(32).hex()

# [home]
HOME_LAT = _f("home", "lat", 0.0)   # 0.0 = auto-detect from public IP
HOME_LON = _f("home", "lon", 0.0)
HOME_IP  = _s("home", "ip",  "")  or None

# [sentinel]
SENTINEL_URL      = _s("sentinel", "url",      "") or None
SENTINEL_TOKEN    = _s("sentinel", "token",    "") or None
SENTINEL_HOSTNAME = _s("sentinel", "hostname", "") or None

# [honeypot]
HONEYPOT_SSH_PORT  = _i("honeypot", "ssh_port",  2222)
HONEYPOT_HTTP_PORT = _i("honeypot", "http_port", 8080)

# [collector]
COLLECTOR_SSH_USER      = _s("collector", "ssh_user",      "root")
COLLECTOR_HOSTS_FILE    = _s("collector", "hosts_file",    "/etc/hosts")
# Explicit host list (comma-separated). If empty, auto-discover from hosts_file.
COLLECTOR_MONITOR_HOSTS = [
    h.strip() for h in _s("collector", "monitor_hosts", "").split(",") if h.strip()
]

# [sniproxy]
SNIPROXY_SERVER   = _s("sniproxy", "server",   "")
SNIPROXY_SSH_USER = _s("sniproxy", "ssh_user", "root")
SNIPROXY_LOG_FILES = [
    f.strip() for f in _s(
        "sniproxy", "log_files",
        "/var/log/sniproxy/https_access.log,/var/log/sniproxy/http_access.log"
    ).split(",") if f.strip()
]

# [scanner]
SCANNER_ENABLED = _c.getboolean("scanner", "enabled", fallback=False)

# [security_center]
FSC_ENABLED   = _c.getboolean("security_center", "enabled", fallback=True)
FSC_HA_URL    = _s("security_center", "ha_url",    "")
FSC_HA_TOKEN  = _s("security_center", "ha_token",  "")
FSC_IGNORE_IPS = [
    ip.strip()
    for ip in _s("security_center", "ignore_ips", "").split(",")
    if ip.strip()
]

# [threat]
BLOCKLIST_FILE = _s("threat", "blocks_ips_file", "")

# [mode]
MODE_TYPE     = _s("mode", "type",     "home")  # 'home' or 'work'
MODE_IPS_FILE = _s("mode", "ips_file", "")      # work: extra blocked-IPs file (same globe viz as blocklist)
MODE_WHO_FILE = _s("mode", "who_file", "")      # work: users file (CSV: name,dept,ip,note)
