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


def _resolve(val):
    """Secret ref: hodnota 'env:VARNAME' se načte z prostředí (12-factor,
    secret nezůstává na disku). Jinak vrací hodnotu beze změny."""
    if isinstance(val, str) and val.startswith("env:"):
        return os.environ.get(val[4:], "")
    return val


def _env(section, key):
    """Přepis přes env: SENTINEL_<SECTION>_<KEY> má přednost před conf souborem."""
    return os.environ.get(f"SENTINEL_{section.upper()}_{key.upper()}")


def _s(section, key, fallback=""):
    ev = _env(section, key)
    if ev is not None:
        return _resolve(ev)
    return _resolve(_c.get(section, key, fallback=fallback))


def _i(section, key, fallback=0):
    ev = _env(section, key)
    if ev is not None:
        try:
            return int(ev)
        except ValueError:
            return fallback
    return _c.getint(section, key, fallback=fallback)


def _f(section, key, fallback=0.0):
    ev = _env(section, key)
    if ev is not None:
        try:
            return float(ev)
        except ValueError:
            return fallback
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
# Viewer účet (read-only, nemůže mutovat) — prázdné = vypnuto
AUTH_VIEWER_USERNAME = _s("auth", "viewer_username", "")
AUTH_VIEWER_PASSWORD = _s("auth", "viewer_password", "")
# Trust reverse-proxy auth (oauth2-proxy/OIDC): hlavička X-Forwarded-User → přihlášený
AUTH_TRUST_PROXY_HEADER = _s("auth", "trust_proxy_header", "")
# Obecný API rate-limit (req/min per IP; 0 = vypnuto)
API_RATE_LIMIT = _i("auth", "api_rate_limit", 0)
# Zálohy na vzdálený cíl přes rsync (user@host:/path; prázdné = jen lokální)
BACKUP_RSYNC_TARGET = _s("db", "backup_rsync_target", "")

# [home]
HOME_LAT = _f("home", "lat", 0.0)   # 0.0 = auto-detect from public IP
HOME_LON = _f("home", "lon", 0.0)
HOME_IP  = _s("home", "ip",  "")  or None

# [sentinel]
SENTINEL_URL      = _s("sentinel", "url",      "") or None
SENTINEL_TOKEN    = _s("sentinel", "token",    "") or None
SENTINEL_HOSTNAME = _s("sentinel", "hostname", "") or None
# Sentinel server má vlastní CA (self-signed) — cesta k jeho certifikátu.
SENTINEL_CA       = _s("sentinel", "ca_bundle", "") or None

# [honeypot]
HONEYPOT_SSH_PORT  = _i("honeypot", "ssh_port",  2222)
HONEYPOT_HTTP_PORT = _i("honeypot", "http_port", 8080)
# Extra deception služby (comma-separated: ftp,telnet,smtp,rdp,smb)
HONEYPOT_EXTRA = [s.strip() for s in _s("honeypot", "extra_services", "").split(",") if s.strip()]

# [collector]
COLLECTOR_SSH_USER      = _s("collector", "ssh_user",      "root")
COLLECTOR_HOSTS_FILE    = _s("collector", "hosts_file",    "/etc/hosts")
# Explicit host list (comma-separated). If empty, auto-discover from hosts_file.
COLLECTOR_MONITOR_HOSTS = [
    h.strip() for h in _s("collector", "monitor_hosts", "").split(",") if h.strip()
]
# Hosts never polled over SSH (who, fail2ban) — e.g. a RouterOS router without root/Linux.
COLLECTOR_EXCLUDE_HOSTS = {
    h.strip() for h in _s("collector", "exclude_hosts", "").split(",") if h.strip()
}

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
# Kam ukladat denni zalohy DB. Prazdne = vedle dat (data/backups).
# Na rpi5 zalohy narostly na 4,3 GB a zaplnovaly SD kartu, proto se daji
# presmerovat na jiny svazek (tam je 419 GB volnych misto 2 GB).
BACKUP_DIR = _s("db", "backup_dir", "")

# [siem] — OpenSearch/Elasticsearch export
SIEM_URL      = _s("siem", "url", "")
SIEM_INDEX    = _s("siem", "index", "sentinel-attacks")
SIEM_USER     = _s("siem", "user", "")
SIEM_PASSWORD = _s("siem", "password", "")

# [mqtt] — publish metrik pro Home Assistant
MQTT_HOST     = _s("mqtt", "host", "")
MQTT_PORT     = _i("mqtt", "port", 1883)
MQTT_USER     = _s("mqtt", "user", "")
MQTT_PASSWORD = _s("mqtt", "password", "")
MQTT_PREFIX   = _s("mqtt", "prefix", "sentinel")

# [alerts]
ALERTS_ENABLED        = _c.getboolean("alerts", "enabled", fallback=False)
ALERTS_NTFY_URL       = _s("alerts", "ntfy_url", "")
ALERTS_TELEGRAM_TOKEN = _s("alerts", "telegram_token", "")
ALERTS_TELEGRAM_CHAT  = _s("alerts", "telegram_chat", "")
ALERTS_SLACK_WEBHOOK  = _s("alerts", "slack_webhook", "")
ALERTS_DISCORD_WEBHOOK = _s("alerts", "discord_webhook", "")
ALERTS_ROCKETCHAT_WEBHOOK = _s("alerts", "rocketchat_webhook", "")
# SMTP e-mail
ALERTS_SMTP_HOST = _s("alerts", "smtp_host", "")
ALERTS_SMTP_PORT = _i("alerts", "smtp_port", 587)
ALERTS_SMTP_USER = _s("alerts", "smtp_user", "")
ALERTS_SMTP_PASS = _s("alerts", "smtp_pass", "")
ALERTS_SMTP_TO   = _s("alerts", "smtp_to", "")
# Syslog forwarding (RFC 5424)
ALERTS_SYSLOG_HOST = _s("alerts", "syslog_host", "")
ALERTS_SYSLOG_PORT = _i("alerts", "syslog_port", 514)

# [integrations] — externí IP lookup služby (klíče)
ABUSEIPDB_KEY  = _s("integrations", "abuseipdb_key", "")
VIRUSTOTAL_KEY = _s("integrations", "virustotal_key", "")
SHODAN_KEY     = _s("integrations", "shodan_key", "")
GREYNOISE_KEY  = _s("integrations", "greynoise_key", "")
MISP_URL       = _s("integrations", "misp_url", "")
MISP_KEY       = _s("integrations", "misp_key", "")

# [mode]
MODE_TYPE     = _s("mode", "type",     "home")  # 'home' or 'work'
MODE_IPS_FILE = _s("mode", "ips_file", "")      # work: extra blocked-IPs file (same globe viz as blocklist)
MODE_WHO_FILE = _s("mode", "who_file", "")      # work: users file (CSV: name,dept,ip,note)
