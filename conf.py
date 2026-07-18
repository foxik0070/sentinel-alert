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
AUTH_TOTP_SECRET = _s("auth", "totp_secret", "")          # prázdné = 2FA vypnuté
AUTH_API_TOKEN   = _s("auth", "api_token",   "")          # read-only token pro GET /api

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

# [pihole]
PIHOLE_HOSTS    = [h.strip() for h in _s("pihole", "hosts",    "").split(",") if h.strip()]
PIHOLE_PRIMARY  = _s("pihole", "primary",  "")
PIHOLE_PASSWORD = _s("pihole", "password", "")

# [mikrotik]
MIKROTIK_HOST      = _s("mikrotik", "host",       "")
MIKROTIK_SSH_USER  = _s("mikrotik", "ssh_user",   "sentinel-user")
MIKROTIK_AUTO_BLOCK = _c.getboolean("mikrotik", "auto_block", fallback=False)
# Honeypot/proxy útoky: blokovat po N zásazích z jedné IP (fail2ban ban blokuje hned)
MIKROTIK_AUTO_BLOCK_THRESHOLD = _i("mikrotik", "auto_block_threshold", 3)

# [proxy]
PROXY_SERVER   = _s("proxy", "server",   "")
PROXY_SSH_USER = _s("proxy", "ssh_user", "root")
PROXY_LOG_FILES = [
    f.strip() for f in _s(
        "proxy", "log_files",
        "/var/log/nginx/proxy_public.log,/var/log/nginx/proxy_internal.log"
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
# Import veřejných threat-intel blocklistů (blocklist.de, Spamhaus, FireHOL)
THREATINTEL_ENABLED = _c.getboolean("threat", "intel_enabled", fallback=False)
# Auto-block known-bad IP na MikroTiku (vyžaduje mikrotik.auto_block)
THREATINTEL_AUTOBLOCK = _c.getboolean("threat", "intel_autoblock", fallback=False)

# [db]
DB_RETENTION_DAYS = _i("db", "retention_days", 90)

# [alerts]
ALERTS_ENABLED        = _c.getboolean("alerts", "enabled", fallback=False)
ALERTS_NTFY_URL       = _s("alerts", "ntfy_url", "")
ALERTS_TELEGRAM_TOKEN = _s("alerts", "telegram_token", "")
ALERTS_TELEGRAM_CHAT  = _s("alerts", "telegram_chat", "")
ALERTS_SLACK_WEBHOOK  = _s("alerts", "slack_webhook", "")
ALERTS_DISCORD_WEBHOOK = _s("alerts", "discord_webhook", "")

# [mode]
MODE_TYPE     = _s("mode", "type",     "home")  # 'home' or 'work'
MODE_IPS_FILE = _s("mode", "ips_file", "")      # work: extra blocked-IPs file (same globe viz as blocklist)
MODE_WHO_FILE = _s("mode", "who_file", "")      # work: users file (CSV: name,dept,ip,note)
