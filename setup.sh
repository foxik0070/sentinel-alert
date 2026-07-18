#!/usr/bin/env bash
# Sentinel-Alert — installer / configurator
# Supports: Debian/Ubuntu/Raspbian, RHEL 8/9/10, AlmaLinux, Rocky Linux
#
# Usage:
#   sudo ./setup.sh            — first install
#   sudo ./setup.sh --reconf   — overwrite existing config
#   sudo ./setup.sh --uninstall
#   sudo ./setup.sh --deps     — install system dependencies only

set -euo pipefail

# ── colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; CYN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GRN}[OK]${NC}  $*"; }
info() { echo -e "${CYN}[..] $*${NC}"; }
warn() { echo -e "${YLW}[!!]${NC}  $*"; }
die()  { echo -e "${RED}[ERR]${NC} $*" >&2; exit 1; }

# ── sanity checks ──────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root: sudo $0"

MODE="install"
[[ "${1:-}" == "--reconf" ]]    && MODE="reconf"
[[ "${1:-}" == "--uninstall" ]] && MODE="uninstall"
[[ "${1:-}" == "--deps" ]]      && MODE="deps"

# ── paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
CONF_DIR="/etc/sentinel"
CONF_FILE="$CONF_DIR/sentinel-alert.conf"
SERVICE_FILE="/etc/systemd/system/sentinel-alert.service"
SSH_KEY_PATH="$APP_DIR/conf/id_ed25519"
VENV_DIR="$APP_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"

# Pick the best available Python (prefer 3.12, fall back to system python3)
pick_python() {
    for py in python3.12 python3.11 python3.10 python3.9 python3; do
        if command -v "$py" &>/dev/null; then
            local ver
            ver=$("$py" -c "import sys; print(sys.version_info[:2])" 2>/dev/null)
            echo "$py"
            return
        fi
    done
    echo "python3"
}
SYS_PYTHON="$(pick_python)"

# ── distro detection ───────────────────────────────────────────────────────
detect_distro() {
    if [[ -f /etc/os-release ]]; then
        # shellcheck source=/dev/null
        source /etc/os-release
        echo "${ID:-unknown}"
    elif command -v apt-get &>/dev/null; then echo "debian"
    elif command -v dnf     &>/dev/null; then echo "fedora"
    elif command -v yum     &>/dev/null; then echo "rhel"
    else echo "unknown"; fi
}

DISTRO="$(detect_distro)"
info "Detected distro: $DISTRO"

# ── system dependency installer ────────────────────────────────────────────
install_system_deps() {
    info "Installing system dependencies..."
    case "$DISTRO" in
        ubuntu|debian|raspbian|linuxmint)
            apt-get update -qq
            apt-get install -y python3 python3-pip python3-venv python3-dev \
                               openssh-client nmap arp-scan curl
            ;;
        rhel|centos|almalinux|rocky)
            if ! rpm -q epel-release &>/dev/null; then
                dnf install -y epel-release 2>/dev/null || \
                yum install -y epel-release 2>/dev/null || true
            fi
            # Prefer Python 3.12 (required for modern async features); fall back to python3
            if dnf list available python3.12 &>/dev/null 2>&1 | grep -q python3.12; then
                dnf install -y python3.12 python3.12-pip python3.12-devel \
                               openssh-clients nmap arp-scan curl 2>/dev/null || true
            else
                dnf install -y python3 python3-pip python3-devel \
                               openssh-clients nmap arp-scan curl 2>/dev/null || \
                yum install -y python3 python3-pip python3-devel \
                               openssh-clients nmap arp-scan curl
            fi
            # Ensure venv support
            python3.12 -m venv --help &>/dev/null 2>&1 || \
                python3 -m venv --help &>/dev/null 2>&1 || \
                dnf install -y python3-virtualenv 2>/dev/null || true
            ;;
        fedora)
            dnf install -y python3 python3-pip python3-devel openssh-clients nmap curl
            ;;
        *)
            warn "Unknown distro '$DISTRO' — skipping system dep install."
            warn "Ensure python3, pip, venv, openssh-client, nmap are installed."
            ;;
    esac
    ok "System dependencies installed."
}

# ── GeoIP downloader ───────────────────────────────────────────────────────
download_geoip() {
    local key="$1"
    local data_dir="$APP_DIR/data"
    mkdir -p "$data_dir"
    local failed=0
    for edition in GeoLite2-City GeoLite2-ASN; do
        local mmdb="$data_dir/${edition}.mmdb"
        if [[ -f "$mmdb" ]]; then
            ok "$edition already present — skipping."
            continue
        fi
        info "Downloading ${edition}..."
        local tmp_tar="/tmp/${edition}-$$.tar.gz"
        local url="https://download.maxmind.com/app/geoip_download?edition_id=${edition}&license_key=${key}&suffix=tar.gz"
        if curl -fsSL "$url" -o "$tmp_tar" 2>/dev/null; then
            tar -xzf "$tmp_tar" -C /tmp/ 2>/dev/null || true
            local extracted
            extracted=$(find /tmp -name "${edition}.mmdb" 2>/dev/null | head -1)
            if [[ -n "$extracted" ]]; then
                mv "$extracted" "$mmdb"
                ok "$edition installed → $mmdb"
            else
                warn "$edition: could not find .mmdb in archive (wrong license key?)"
                failed=1
            fi
            rm -rf /tmp/GeoLite2-*/
        else
            warn "$edition: download failed — check license key and internet access."
            failed=1
        fi
        rm -f "$tmp_tar"
    done
    return $failed
}

# ── venv setup ─────────────────────────────────────────────────────────────
setup_venv() {
    info "Setting up Python virtual environment (using $SYS_PYTHON)..."
    if [[ ! -d "$VENV_DIR" ]]; then
        "$SYS_PYTHON" -m venv "$VENV_DIR" || die "Failed to create venv. Install python3-venv / python3.12 first."
    fi
    "$VENV_DIR/bin/pip" install --quiet --upgrade pip
    "$VENV_DIR/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"
    ok "Python venv ready: $VENV_DIR ($("$VENV_PYTHON" --version 2>&1))"
}

# ── deps-only mode ─────────────────────────────────────────────────────────
if [[ "$MODE" == "deps" ]]; then
    install_system_deps
    setup_venv
    ok "Done. Run setup.sh without --deps to configure and install."
    exit 0
fi

# ── uninstall ──────────────────────────────────────────────────────────────
if [[ "$MODE" == "uninstall" ]]; then
    info "Stopping and disabling sentinel-alert service..."
    systemctl stop sentinel-alert 2>/dev/null || true
    systemctl disable sentinel-alert 2>/dev/null || true
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
    warn "Service removed. Config at $CONF_FILE was NOT deleted."
    warn "To also remove config: rm -rf $CONF_DIR"
    exit 0
fi

# ── header ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYN}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${CYN}║      SENTINEL-ALERT  —  Setup & Install       ║${NC}"
echo -e "${CYN}╚═══════════════════════════════════════════════╝${NC}"
echo ""
echo "  App dir : $APP_DIR"
echo "  Config  : $CONF_FILE"
echo "  Service : $SERVICE_FILE"
echo ""

# ── ensure system deps + venv ──────────────────────────────────────────────
if [[ ! -x "$VENV_PYTHON" ]]; then
    info "Virtual environment not found — installing dependencies first..."
    install_system_deps
    setup_venv
else
    info "Updating Python dependencies..."
    "$VENV_DIR/bin/pip" install --quiet --upgrade pip
    "$VENV_DIR/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"
    ok "Dependencies up to date."
fi

echo "  Python  : $VENV_PYTHON"
echo ""

# ── helpers ────────────────────────────────────────────────────────────────
ask() {
    local var="$1" prompt="$2" default="${3:-}"
    local label="$prompt"
    [[ -n "$default" ]] && label="$prompt [${default}]"
    read -rp "  $label: " val
    val="${val:-$default}"
    printf -v "$var" '%s' "$val"
}

ask_secret() {
    local var="$1" prompt="$2" default="${3:-}"
    local label="$prompt"
    [[ -n "$default" ]] && label="$prompt [leave blank = keep '${default}']"
    read -rsp "  $label: " val
    echo ""
    val="${val:-$default}"
    printf -v "$var" '%s' "$val"
}

# ── vylepšené interaktivní helpery s vysvětlením ─────────────────────────────
# section "NÁZEV" "popis co sekce nastavuje"
section() {
    echo ""
    echo -e "${CYN}── $1 ──────────────────────────────────────${NC}"
    [[ -n "${2:-}" ]] && echo -e "${YLW}  ${2}${NC}"
}
# explain "text" — víceřádkové vysvětlení k jednotlivé volbě
explain() { echo -e "     ${CYN}› ${1}${NC}"; }
# ask_yn VAR "otázka" default(y/n) — vrací true/false
ask_yn() {
    local var="$1" prompt="$2" def="${3:-n}"
    local hint="[y/N]"; [[ "$def" == "y" ]] && hint="[Y/n]"
    read -rp "  $prompt $hint: " _yn
    _yn="${_yn:-$def}"
    [[ "${_yn,,}" == "y" ]] && printf -v "$var" 'true' || printf -v "$var" 'false'
}

# ── skip config if exists and not --reconf ──────────────────────────────────
if [[ -f "$CONF_FILE" && "$MODE" == "install" ]]; then
    warn "Config already exists at $CONF_FILE"
    warn "Use --reconf to overwrite, or edit it manually."
    SKIP_CONF=true
else
    SKIP_CONF=false
fi

# ── interactive config ──────────────────────────────────────────────────────
if [[ "$SKIP_CONF" == "false" ]]; then

    echo -e "${CYN}── Deployment Mode ──────────────────────────────${NC}"
    warn "Choose 'work' for a work/corporate deployment."
    warn "  work: hides Local Network, Security Center, Proxy Monitor, Network Map, Settings"
    warn "        shows USERS panel (from who_file) and IPS attackers on globe"
    read -rp "  Deployment mode [home/work, default: home]: " _mode
    _mode="${_mode:-home}"
    [[ "$_mode" == "work" ]] && MODE_TYPE="work" || MODE_TYPE="home"

    MODE_IPS_FILE=""
    MODE_WHO_FILE=""
    if [[ "$MODE_TYPE" == "work" ]]; then
        warn "IPS file: one blocked IP per line — visualized on globe as attackers."
        ask MODE_IPS_FILE "Path to IPS file (empty to skip)" ""
        warn "WHO file: CSV — name,department,ip,note"
        ask MODE_WHO_FILE "Path to WHO file (empty to skip)" ""
    fi

    echo ""
    echo -e "${CYN}── Authentication ───────────────────────────────${NC}"
    warn "Dashboard login credentials (default: admin / admin)."
    warn "Change before exposing to any network!"
    ask        AUTH_USER   "Username" "admin"
    ask_secret AUTH_PASS   "Password" "admin"
    AUTH_SECRET=""   # generated randomly at runtime if empty

    echo ""
    echo -e "${CYN}── Server ──────────────────────────────────────${NC}"
    ask SERVER_HOST "Listen address" "0.0.0.0"
    ask SERVER_PORT "Web UI port"    "5056"

    echo ""
    echo -e "${CYN}── GeoIP (MaxMind GeoLite2) ─────────────────────${NC}"
    warn "GeoLite2 databáze zajistí přesné souřadnice útočníků."
    warn "Bez klíče se používá ip-api.com (online, zdarma, 45 req/min)."
    warn "Zadarmo: https://www.maxmind.com/en/geolite2/signup"
    _EXISTING_MM_KEY=""
    if [[ -f "$CONF_FILE" ]]; then
        _EXISTING_MM_KEY=$(awk -F'=' '/^\[geoip\]/,/^\[/ { if (/^license_key/) print $2 }' \
            "$CONF_FILE" | tr -d ' ' | head -1)
    fi
    ask MAXMIND_KEY "MaxMind license key (empty = skip)" "$_EXISTING_MM_KEY"

    echo ""
    echo -e "${CYN}── Home Location (leave blank for auto-detect) ─${NC}"
    ask HOME_LAT "Latitude  (e.g. 49.8209, 0 = auto)" "0"
    ask HOME_LON "Longitude (e.g. 18.2625, 0 = auto)" "0"
    ask HOME_IP  "Public IP (empty = auto-detect)"     ""

    echo ""
    echo -e "${CYN}── Sentinel Central (optional) ─────────────────${NC}"
    ask SENTINEL_URL      "Sentinel URL (empty to skip)" ""
    if [[ -n "$SENTINEL_URL" ]]; then
        ask_secret SENTINEL_TOKEN    "Sentinel token" ""
        ask SENTINEL_HOSTNAME "Agent hostname" "$(hostname -s)"
    else
        SENTINEL_TOKEN=""; SENTINEL_HOSTNAME="$(hostname -s)"
    fi

    echo ""
    echo -e "${CYN}── Honeypot Ports ───────────────────────────────${NC}"
    ask HONEYPOT_SSH_PORT  "Fake SSH port"  "2222"
    ask HONEYPOT_HTTP_PORT "Fake HTTP port" "8080"

    echo ""
    echo -e "${CYN}── Collector (fail2ban polling) ─────────────────${NC}"
    ask COLLECTOR_SSH_USER   "SSH user for fail2ban polling" "root"
    ask COLLECTOR_HOSTS_FILE "Hosts file to scan"            "/etc/hosts"
    warn "Explicit host list for fail2ban polling (comma-separated, e.g. gitea,proxy)."
    warn "Leave empty to auto-discover all hosts from hosts file."
    ask COLLECTOR_MONITOR_HOSTS "Monitor hosts (empty = auto)" ""

    if [[ "$MODE_TYPE" == "home" ]]; then
        echo ""
        echo -e "${CYN}── Proxy Monitor — Sniproxy ─────────────────────${NC}"
        warn "Sniproxy reads access logs from a REMOTE proxy server via SSH."
        ask SNIPROXY_SERVER   "Proxy server hostname/IP (empty to disable)" ""
        if [[ -n "$SNIPROXY_SERVER" ]]; then
            ask SNIPROXY_SSH_USER  "SSH user on proxy server" "root"
            ask SNIPROXY_LOG_FILES "Log files (comma-separated)" \
                "/var/log/sniproxy/https_access.log,/var/log/sniproxy/http_access.log"
        else
            SNIPROXY_SSH_USER="root"
            SNIPROXY_LOG_FILES="/var/log/sniproxy/https_access.log,/var/log/sniproxy/http_access.log"
        fi

        echo ""
        echo -e "${CYN}── LAN Scanner (Network Map tab) ────────────────${NC}"
        warn "Enable ARP-based LAN scanning and the Network Map tab."
        read -rp "  Enable LAN scanner? [y/N]: " _scan
        [[ "${_scan,,}" == "y" ]] && SCANNER_ENABLED=true || SCANNER_ENABLED=false

        echo ""
        echo -e "${CYN}── Security Center ──────────────────────────────${NC}"
        read -rp "  Enable Security Center tab? [Y/n]: " _fsc
        [[ "${_fsc,,}" == "n" ]] && FSC_ENABLED=false || FSC_ENABLED=true

        ask FSC_HA_URL "Home Assistant URL (empty to disable)" ""
        if [[ -n "$FSC_HA_URL" ]]; then
            ask_secret FSC_HA_TOKEN "HA long-lived token" ""
        else
            FSC_HA_TOKEN=""
        fi

        echo ""
        echo -e "${CYN}── Security Center — Ignored IPs ───────────────${NC}"
        warn "Enter IPs to exclude from SSH security scan (comma-separated)."
        warn "Typically: gateway, switches, printers, HA."
        ask FSC_IGNORE_IPS "Ignore IPs" "192.168.2.1"

        echo ""
        echo -e "${CYN}── Blocked IPs Visualization ────────────────────${NC}"
        warn "Path to a file with one IP per line to visualize on the globe."
        ask BLOCKS_IPS_FILE "Blocked IPs file (empty to disable)" ""

        section "MikroTik Router" "Firewall na MikroTiku přes SSH — ruční i automatická blokace útočníků."
        explain "Prázdný host = MikroTik integrace vypnutá (záložka LOCAL NETWORK bez firewallu)."
        ask MIKROTIK_HOST "MikroTik IP/hostname (empty = disable)" ""
        if [[ -n "$MIKROTIK_HOST" ]]; then
            ask MIKROTIK_SSH_USER "SSH uživatel na MikroTiku" "admin"
            explain "Auto-block: fail2ban ban se zablokuje hned, honeypot/proxy útok po N zásazích."
            ask_yn MIKROTIK_AUTO_BLOCK "Zapnout automatickou blokaci?" "n"
            ask MIKROTIK_AB_THRESHOLD "  Práh zásahů pro honeypot/proxy útok" "3"
        else
            MIKROTIK_SSH_USER="admin"; MIKROTIK_AUTO_BLOCK=false; MIKROTIK_AB_THRESHOLD=3
        fi

        section "PiHole" "DNS statistiky z PiHole v6 (dotazy, blokace, top domény)."
        explain "Více instancí odděl čárkou; primary je ta, ze které se berou grafy."
        ask PIHOLE_HOSTS "PiHole IP/hostname(y), comma-sep (empty = disable)" ""
        if [[ -n "$PIHOLE_HOSTS" ]]; then
            ask PIHOLE_PRIMARY "Primární instance" "${PIHOLE_HOSTS%%,*}"
            ask_secret PIHOLE_PASSWORD "PiHole heslo (web admin)" ""
        else
            PIHOLE_PRIMARY=""; PIHOLE_PASSWORD=""
        fi

        section "Threat Intel" "Import veřejných blocklistů (blocklist.de/Spamhaus/FireHOL) — known-bad IP se značí ☠."
        ask_yn THREAT_INTEL_ENABLED "Zapnout import threat-intel blocklistů?" "n"
        if [[ "$THREAT_INTEL_ENABLED" == "true" && "$MIKROTIK_AUTO_BLOCK" == "true" ]]; then
            explain "Auto-block known-bad IP na MikroTiku (4 týdny)."
            ask_yn THREAT_INTEL_AUTOBLOCK "Auto-blokovat known-bad na MikroTiku?" "n"
        else
            THREAT_INTEL_AUTOBLOCK=false
        fi

        section "Honeypot deception (extra služby)" "Volitelné fake služby lákající útočníky (vyžadují root — porty pod 1024)."
        explain "Zadej comma-sep: ftp,telnet,smtp,rdp,smb — nebo nech prázdné (jen SSH+HTTP)."
        ask HONEYPOT_EXTRA "Extra služby (empty = žádné)" ""
    else
        # Work mode — home-only features disabled
        SNIPROXY_SERVER=""; SNIPROXY_SSH_USER="root"
        SNIPROXY_LOG_FILES="/var/log/sniproxy/https_access.log,/var/log/sniproxy/http_access.log"
        SCANNER_ENABLED=false
        FSC_ENABLED=false
        FSC_HA_URL=""; FSC_HA_TOKEN=""
        FSC_IGNORE_IPS=""
        BLOCKS_IPS_FILE=""
        MIKROTIK_HOST=""; MIKROTIK_SSH_USER="admin"; MIKROTIK_AUTO_BLOCK=false; MIKROTIK_AB_THRESHOLD=3
        PIHOLE_HOSTS=""; PIHOLE_PRIMARY=""; PIHOLE_PASSWORD=""
        THREAT_INTEL_ENABLED=false; THREAT_INTEL_AUTOBLOCK=false
        HONEYPOT_EXTRA=""
        ok "Work mode: LAN scanner, Security Center, Proxy Monitor, MikroTik, PiHole disabled."
    fi

    # ── Alerting (obě módy) ──────────────────────────────────────────────────
    section "Alerting" "Push notifikace: nové zařízení v LAN, host offline, watchlist hit, attack spike."
    ask_yn ALERTS_ENABLED "Zapnout alerting?" "n"
    ALERTS_NTFY_URL=""; ALERTS_TG_TOKEN=""; ALERTS_TG_CHAT=""
    ALERTS_SLACK=""; ALERTS_DISCORD=""; ALERTS_ROCKET=""
    ALERTS_SMTP_HOST=""; ALERTS_SMTP_PORT=587; ALERTS_SMTP_USER=""; ALERTS_SMTP_PASS=""; ALERTS_SMTP_TO=""
    ALERTS_SYSLOG_HOST=""; ALERTS_SYSLOG_PORT=514
    if [[ "$ALERTS_ENABLED" == "true" ]]; then
        explain "ntfy: veřejný/self-hosted topic URL, např. https://ntfy.sh/muj-sentinel"
        ask ALERTS_NTFY_URL "ntfy topic URL (empty = skip)" ""
        explain "Telegram bot: token od @BotFather + chat_id příjemce."
        ask ALERTS_TG_TOKEN "Telegram bot token (empty = skip)" ""
        [[ -n "$ALERTS_TG_TOKEN" ]] && ask ALERTS_TG_CHAT "Telegram chat ID" ""
        explain "Webhooky (Slack/Discord/Rocket.Chat) — vlož incoming webhook URL."
        ask ALERTS_SLACK   "Slack webhook URL (empty = skip)" ""
        ask ALERTS_DISCORD "Discord webhook URL (empty = skip)" ""
        ask ALERTS_ROCKET  "Rocket.Chat webhook URL (empty = skip)" ""
        explain "E-mail přes SMTP (STARTTLS)."
        ask ALERTS_SMTP_HOST "SMTP server (empty = skip)" ""
        if [[ -n "$ALERTS_SMTP_HOST" ]]; then
            ask ALERTS_SMTP_PORT "SMTP port" "587"
            ask ALERTS_SMTP_USER "SMTP uživatel" ""
            ask_secret ALERTS_SMTP_PASS "SMTP heslo" ""
            ask ALERTS_SMTP_TO "Příjemce (To)" ""
        fi
        explain "Syslog forwarding do SIEM (RFC 5424, UDP)."
        ask ALERTS_SYSLOG_HOST "Syslog host (empty = skip)" ""
        [[ -n "$ALERTS_SYSLOG_HOST" ]] && ask ALERTS_SYSLOG_PORT "Syslog port" "514"
    fi

    # ── Externí IP lookup (obě módy) ─────────────────────────────────────────
    section "External IP Lookup" "Obohacení IP intel karty o externí reputaci (nepovinné, potřebují API klíč)."
    ask_yn WANT_INTEGRATIONS "Nakonfigurovat externí lookup služby?" "n"
    INTEG_ABUSE=""; INTEG_VT=""; INTEG_SHODAN=""; INTEG_GREY=""
    if [[ "$WANT_INTEGRATIONS" == "true" ]]; then
        explain "AbuseIPDB — skóre zneužití + hlášení (abuseipdb.com/account/api)."
        ask_secret INTEG_ABUSE "AbuseIPDB API key" ""
        explain "VirusTotal — počet detekcí malicious/harmless."
        ask_secret INTEG_VT "VirusTotal API key" ""
        explain "Shodan — otevřené porty/služby útočící IP."
        ask_secret INTEG_SHODAN "Shodan API key" ""
        explain "GreyNoise — cílený útok vs. internetový šum."
        ask_secret INTEG_GREY "GreyNoise API key" ""
    fi

    # ── DB údržba (obě módy) ─────────────────────────────────────────────────
    section "Database Maintenance" "Automatická údržba SQLite: retence, VACUUM, noční záloha."
    ask DB_RETENTION "Retence útoků/banů ve dnech" "90"
    explain "Offsite kopie zálohy přes rsync (user@host:/cesta) — prázdné = jen lokální."
    ask DB_RSYNC "rsync cíl zálohy (empty = jen lokální)" ""

    # ── Zabezpečení navíc (obě módy) ─────────────────────────────────────────
    section "Extra Security" "Read-only účet, rate-limit API, důvěra reverse-proxy autentizaci."
    explain "Viewer účet vidí vše, ale nemůže nic měnit (žádné blokace/mazání/config)."
    ask AUTH_VIEWER_USER "Viewer username (empty = disable)" ""
    [[ -n "$AUTH_VIEWER_USER" ]] && ask_secret AUTH_VIEWER_PASS "Viewer password" "" || AUTH_VIEWER_PASS=""
    explain "Rate-limit /api na IP (0 = vypnuto). Chrání před zahlcením."
    ask AUTH_RATE_LIMIT "API rate-limit (req/min, 0 = off)" "0"
    explain "Za oauth2-proxy/OIDC: hlavička s ověřeným uživatelem = auto-login (např. X-Forwarded-User). Prázdné = vypnuto."
    ask AUTH_TRUST_HEADER "Trust proxy auth header (empty = off)" ""

    # ── write config ───────────────────────────────────────────────────────
    info "Creating $CONF_DIR ..."
    mkdir -p "$CONF_DIR"
    chmod 750 "$CONF_DIR"

    info "Writing $CONF_FILE ..."
    cat > "$CONF_FILE" << CONF
# Sentinel-Alert configuration
# /etc/sentinel/sentinel-alert.conf
#
# Edit this file and restart the service:
#   sudo systemctl restart sentinel-alert
#
# Re-run setup:   sudo $APP_DIR/setup.sh --reconf
# Uninstall:      sudo $APP_DIR/setup.sh --uninstall

[mode]
# Deployment type: 'home' or 'work'
# work: hides Local Network, Security Center, Proxy Monitor, Network Map, Settings
#       shows USERS panel (who_file) and IPS file attackers on the globe
type     = ${MODE_TYPE}
# Path to file with one blocked/monitored IP per line (visualized on globe)
ips_file = ${MODE_IPS_FILE}
# Path to CSV file with users: name,department,ip,note
who_file = ${MODE_WHO_FILE}

[auth]
# Dashboard login credentials
# Change before exposing to any network!
username = ${AUTH_USER}
password = ${AUTH_PASS}
# HMAC secret for session tokens — leave blank to auto-generate on each start
secret   =
# 2FA (TOTP) and read-only API token — managed from Settings UI
totp_secret =
api_token   =
# Optional read-only viewer account (can view, cannot change anything)
viewer_username = ${AUTH_VIEWER_USER}
viewer_password = ${AUTH_VIEWER_PASS}
# Trust reverse-proxy auth header (oauth2-proxy/OIDC), e.g. X-Forwarded-User. Empty = off.
trust_proxy_header = ${AUTH_TRUST_HEADER}
# General API rate-limit (requests/min per IP; 0 = off)
api_rate_limit = ${AUTH_RATE_LIMIT}

[server]
# Address and port for the web UI
host     = ${SERVER_HOST}
port     = ${SERVER_PORT}

[home]
# Geographic coordinates of this installation (0 = auto-detect from public IP)
lat      = ${HOME_LAT}
lon      = ${HOME_LON}
# Pin your public IP instead of auto-detecting (optional):
#ip      = ${HOME_IP}

[sentinel]
# Sentinel central server — leave url blank to disable forwarding
url      = ${SENTINEL_URL}
token    = ${SENTINEL_TOKEN}
hostname = ${SENTINEL_HOSTNAME}

[honeypot]
# Ports the fake services listen on (must be > 1024 unless running as root)
ssh_port  = ${HONEYPOT_SSH_PORT}
http_port = ${HONEYPOT_HTTP_PORT}
# Extra deception services (comma-separated: ftp,telnet,smtp,rdp,smb). Need root for <1024.
extra_services = ${HONEYPOT_EXTRA}

[collector]
# SSH settings for fail2ban ban polling across hosts
ssh_user      = ${COLLECTOR_SSH_USER}
hosts_file    = ${COLLECTOR_HOSTS_FILE}
# Explicit poll targets (comma-separated hostnames). Empty = auto-discover from hosts_file.
# Example: gitea,proxy,nas
monitor_hosts = ${COLLECTOR_MONITOR_HOSTS}

[sniproxy]
# Proxy server running sniproxy — logs are read via SSH
# Leave server empty to disable the Proxy Monitor tab
server    = ${SNIPROXY_SERVER}
ssh_user  = ${SNIPROXY_SSH_USER}
log_files = ${SNIPROXY_LOG_FILES}

[scanner]
# Enable ARP-based LAN scanning and the Network Map tab
enabled = ${SCANNER_ENABLED}

[security_center]
# Set enabled = false to hide the Security Center tab
enabled  = ${FSC_ENABLED}
# Home Assistant notifications (leave blank to disable)
ha_url   = ${FSC_HA_URL}
ha_token = ${FSC_HA_TOKEN}
# IPs excluded from the SSH security scan (comma-separated)
ignore_ips = ${FSC_IGNORE_IPS}

[threat]
# Optional: path to a file with one blocked IP per line (visualized on the globe)
blocks_ips_file = ${BLOCKS_IPS_FILE}
# Import public threat-intel blocklists (blocklist.de/Spamhaus/FireHOL) → known-bad ☠
intel_enabled   = ${THREAT_INTEL_ENABLED}
# Auto-block known-bad IPs on MikroTik (needs mikrotik.auto_block)
intel_autoblock = ${THREAT_INTEL_AUTOBLOCK}

[mikrotik]
# MikroTik firewall integration over SSH (address lists, filter/NAT, blocking).
# Empty host = disabled. HOME instance only.
host                 = ${MIKROTIK_HOST}
ssh_user             = ${MIKROTIK_SSH_USER}
# Auto-block: fail2ban ban → immediately, honeypot/proxy → after N hits
auto_block           = ${MIKROTIK_AUTO_BLOCK}
auto_block_threshold = ${MIKROTIK_AB_THRESHOLD}

[pihole]
# PiHole v6 DNS stats (comma-separated hosts, one primary). Empty = disabled.
hosts    = ${PIHOLE_HOSTS}
primary  = ${PIHOLE_PRIMARY}
password = ${PIHOLE_PASSWORD}

[alerts]
# Push notifications: new LAN device, host offline, watchlist hit, attack spike
enabled            = ${ALERTS_ENABLED}
ntfy_url           = ${ALERTS_NTFY_URL}
telegram_token     = ${ALERTS_TG_TOKEN}
telegram_chat      = ${ALERTS_TG_CHAT}
slack_webhook      = ${ALERTS_SLACK}
discord_webhook    = ${ALERTS_DISCORD}
rocketchat_webhook = ${ALERTS_ROCKET}
# E-mail (SMTP, STARTTLS)
smtp_host = ${ALERTS_SMTP_HOST}
smtp_port = ${ALERTS_SMTP_PORT}
smtp_user = ${ALERTS_SMTP_USER}
smtp_pass = ${ALERTS_SMTP_PASS}
smtp_to   = ${ALERTS_SMTP_TO}
# Syslog forwarding (RFC 5424, UDP) to a SIEM
syslog_host = ${ALERTS_SYSLOG_HOST}
syslog_port = ${ALERTS_SYSLOG_PORT}

[integrations]
# External IP lookup services (blank = disabled). Shown on-demand in the IP card.
abuseipdb_key  = ${INTEG_ABUSE}
virustotal_key = ${INTEG_VT}
shodan_key     = ${INTEG_SHODAN}
greynoise_key  = ${INTEG_GREY}
# MISP threat-intel feed (imported alongside public blocklists)
misp_url =
misp_key =

[db]
# Retention for attacks + ban history (daily prune at 04:30 + VACUUM)
retention_days = ${DB_RETENTION}
# Optional offsite backup target (rsync over SSH); empty = local only
backup_rsync_target = ${DB_RSYNC}

[geoip]
# MaxMind license key for automatic GeoLite2 database download
# Free sign-up: https://www.maxmind.com/en/geolite2/signup
# Leave empty to rely on ip-api.com fallback (online, rate-limited)
license_key = ${MAXMIND_KEY}
CONF

    chmod 640 "$CONF_FILE"
    ok "Config written to $CONF_FILE"
fi

# ── initialise database ────────────────────────────────────────────────────
echo ""
echo -e "${CYN}── Database ──────────────────────────────────────${NC}"
info "Initialising SQLite database..."
SENTINEL_CONF="$CONF_FILE" "$VENV_PYTHON" "$APP_DIR/db_init.py"
ok "Database ready."

# ── GeoIP databases ────────────────────────────────────────────────────────
echo ""
echo -e "${CYN}── GeoIP Databases ──────────────────────────────────${NC}"
_MM_KEY=""
if [[ -f "$CONF_FILE" ]]; then
    _MM_KEY=$(awk -F'=' '/^\[geoip\]/,/^\[/ { if (/^license_key/) print $2 }' \
        "$CONF_FILE" | tr -d ' ' | head -1)
fi
if [[ -n "$_MM_KEY" ]]; then
    download_geoip "$_MM_KEY" || warn "Některé GeoIP soubory se nestáhly — fallback na ip-api.com."
else
    info "MaxMind klíč nebyl zadán — používá se ip-api.com fallback."
    info "Přidej klíč do $CONF_FILE ([geoip] license_key) a spusť znovu setup.sh."
fi

# ── Data directory and default files ──────────────────────────────────────
mkdir -p "$APP_DIR/data"
[[ -f "$APP_DIR/data/domains.json" ]] || echo '[]' > "$APP_DIR/data/domains.json"
[[ -f "$APP_DIR/data/services.json" ]] || echo '[]' > "$APP_DIR/data/services.json"
[[ -f "$APP_DIR/data/svc_settings.json" ]] || echo '{"interval_min":5}' > "$APP_DIR/data/svc_settings.json"

# ── SSH key for collector ──────────────────────────────────────────────────
echo ""
echo -e "${CYN}── SSH Key (fail2ban collector) ─────────────────${NC}"
mkdir -p "$APP_DIR/conf"
if [[ -f "$SSH_KEY_PATH" ]]; then
    ok "SSH key already exists: $SSH_KEY_PATH"
    if [[ ! -f "${SSH_KEY_PATH}.pub" ]]; then
        info "Public key missing — regenerating from private key..."
        ssh-keygen -y -f "$SSH_KEY_PATH" > "${SSH_KEY_PATH}.pub" \
            || die "Failed to extract public key from $SSH_KEY_PATH"
        ok "Public key recovered: ${SSH_KEY_PATH}.pub"
    fi
else
    info "Generating ed25519 SSH key for fail2ban collector..."
    ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "sentinel-alert-collector" -q
    ok "Key generated: $SSH_KEY_PATH"
fi

PUB_KEY="$(cat "${SSH_KEY_PATH}.pub")"
echo ""
echo -e "${YLW}  Distribute this public key to every host you want to monitor:${NC}"
echo ""
echo "  $PUB_KEY"
echo ""
echo "  Quick deploy command (replace HOST):"
echo "    ssh-copy-id -i ${SSH_KEY_PATH}.pub ${COLLECTOR_SSH_USER:-root}@HOST"
echo ""

# ── detect run user ─────────────────────────────────────────────────────────
echo -e "${CYN}── Service User ─────────────────────────────────${NC}"
SUGGESTED_USER=$(stat -c '%U' "$APP_DIR" 2>/dev/null || logname 2>/dev/null || echo root)
ask RUN_USER "User to run the service as" "$SUGGESTED_USER"

id "$RUN_USER" &>/dev/null || die "User '$RUN_USER' does not exist."
RUN_GROUP=$(id -gn "$RUN_USER")

# Config readable by the run user
chown root:"$RUN_GROUP" "$CONF_DIR" "$CONF_FILE" 2>/dev/null || true

# Data dir writable by the run user
chown -R "$RUN_USER":"$RUN_GROUP" "$APP_DIR/data" 2>/dev/null || true

# ── write systemd unit ─────────────────────────────────────────────────────
echo ""
echo -e "${CYN}── Systemd Service ──────────────────────────────${NC}"
info "Writing $SERVICE_FILE ..."

cat > "$SERVICE_FILE" << UNIT
[Unit]
Description=Sentinel Alert — Network Monitoring & Honeypot Visualization
Documentation=file://${APP_DIR}/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory=${APP_DIR}
Environment=SENTINEL_CONF=${CONF_FILE}
ExecStart=${VENV_PYTHON} ${APP_DIR}/app.py
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=sentinel-alert

# Hardening
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
UNIT

ok "Service file written."

# ── enable & start ─────────────────────────────────────────────────────────
echo ""
echo -e "${CYN}── Enabling Service ─────────────────────────────${NC}"
systemctl daemon-reload
systemctl enable sentinel-alert
ok "Enabled (will start on boot)."

echo ""
read -rp "  Start sentinel-alert now? [Y/n]: " START_NOW
START_NOW="${START_NOW:-y}"
if [[ "${START_NOW,,}" == "y" ]]; then
    systemctl restart sentinel-alert
    sleep 2
    if systemctl is-active --quiet sentinel-alert; then
        ok "Service is running."
    else
        warn "Service failed to start. Check logs:"
        warn "  journalctl -u sentinel-alert -n 40 --no-pager"
        exit 1
    fi
else
    info "Start manually: sudo systemctl start sentinel-alert"
fi

# ── summary ────────────────────────────────────────────────────────────────
# Read port from config if available, fallback to what was configured
_PORT="${SERVER_PORT:-5056}"
if [[ -f "$CONF_FILE" ]]; then
    _PORT=$(awk -F'=' '/^\[server\]/,/^\[/ { if (/^port/) print $2 }' "$CONF_FILE" | tr -d ' ' | head -1)
    _PORT="${_PORT:-5056}"
fi

echo ""
echo -e "${CYN}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${CYN}║              Setup complete!                  ║${NC}"
echo -e "${CYN}╚═══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Web UI   : ${GRN}http://$(hostname -I | awk '{print $1}'):${_PORT}${NC}"
echo -e "  Login    : ${GRN}${AUTH_USER:-admin} / (your password)${NC}"
echo -e "  Config   : ${CYN}$CONF_FILE${NC}"
echo -e "  Logs     : ${CYN}journalctl -u sentinel-alert -f${NC}"
echo -e "  Status   : ${CYN}systemctl status sentinel-alert${NC}"
echo -e "  Restart  : ${CYN}sudo systemctl restart sentinel-alert${NC}"
echo ""
if [[ -f "$APP_DIR/data/GeoLite2-City.mmdb" ]]; then
    echo -e "  GeoIP    : ${GRN}GeoLite2-City nainstalován${NC}"
else
    echo -e "  GeoIP    : ${YLW}Není — zadej MaxMind klíč v $CONF_FILE ([geoip] license_key)${NC}"
    echo -e "             ${YLW}a spusť: sudo $APP_DIR/setup.sh --reconf${NC}"
fi
echo ""
