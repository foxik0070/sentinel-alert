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
                               openssh-client nmap curl
            ;;
        rhel|centos|almalinux|rocky)
            if ! rpm -q epel-release &>/dev/null; then
                dnf install -y epel-release 2>/dev/null || \
                yum install -y epel-release 2>/dev/null || true
            fi
            dnf install -y python3 python3-pip python3-devel \
                           openssh-clients nmap curl 2>/dev/null || \
            yum install -y python3 python3-pip python3-devel \
                           openssh-clients nmap curl
            # python3-venv is part of python3 on RHEL 8+; virtualenv as fallback
            python3 -m venv --help &>/dev/null || \
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

# ── venv setup ─────────────────────────────────────────────────────────────
setup_venv() {
    info "Setting up Python virtual environment..."
    if [[ ! -d "$VENV_DIR" ]]; then
        python3 -m venv "$VENV_DIR" || die "Failed to create venv. Install python3-venv first."
    fi
    "$VENV_DIR/bin/pip" install --quiet --upgrade pip
    "$VENV_DIR/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"
    ok "Python venv ready: $VENV_DIR"
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

[auth]
# Dashboard login credentials
# Change before exposing to any network!
username = ${AUTH_USER}
password = ${AUTH_PASS}
# HMAC secret for session tokens — leave blank to auto-generate on each start
secret   =

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
echo -e "  GeoIP    : ${YLW}Place GeoLite2-City.mmdb in $APP_DIR/data/${NC}"
echo -e "             ${YLW}(free download from maxmind.com — account required)${NC}"
echo ""
