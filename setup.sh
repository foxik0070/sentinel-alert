#!/usr/bin/env bash
# Sentinel-Alert — installer / configurator
# Creates /etc/sentinel/sentinel-alert.conf and systemd service.
#
# Usage:
#   sudo ./setup.sh          — first install
#   sudo ./setup.sh --reconf — overwrite existing config
#   sudo ./setup.sh --uninstall

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

# ── paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
CONF_DIR="/etc/sentinel"
CONF_FILE="$CONF_DIR/sentinel-alert.conf"
SERVICE_FILE="/etc/systemd/system/sentinel-alert.service"
SSH_KEY_PATH="$APP_DIR/conf/id_ed25519"

# Detect Python (prefer venv)
if [[ -x "$APP_DIR/.venv/bin/python" ]]; then
    PYTHON="$APP_DIR/.venv/bin/python"
elif command -v python3 &>/dev/null; then
    PYTHON="$(command -v python3)"
else
    die "Python not found. Run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
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
echo "  Python  : $PYTHON"
echo "  Config  : $CONF_FILE"
echo "  Service : $SERVICE_FILE"
echo ""

# ── helpers ────────────────────────────────────────────────────────────────
ask() {
    # ask VAR "Prompt" "default"
    local var="$1" prompt="$2" default="${3:-}"
    local label="$prompt"
    [[ -n "$default" ]] && label="$prompt [${default}]"
    read -rp "  $label: " val
    val="${val:-$default}"
    printf -v "$var" '%s' "$val"
}

ask_secret() {
    local var="$1" prompt="$2"
    read -rsp "  $prompt: " val
    echo ""
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
        ask_secret SENTINEL_TOKEN    "Sentinel token"
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
    echo -e "${CYN}── Security Center — Home Assistant (optional) ──${NC}"
    ask FSC_HA_URL "HA URL (empty to disable)" ""
    if [[ -n "$FSC_HA_URL" ]]; then
        ask_secret FSC_HA_TOKEN "HA long-lived token"
    else
        FSC_HA_TOKEN=""
    fi

    echo ""
    echo -e "${CYN}── Security Center — Ignored IPs ───────────────${NC}"
    warn "Enter IPs to exclude from SSH security scan (comma-separated)."
    warn "Typically: gateway, switches, printers, HA."
    ask FSC_IGNORE_IPS "Ignore IPs" "192.168.2.1,192.168.2.202"

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

[server]
# Address and port for the web UI
host     = ${SERVER_HOST}
port     = ${SERVER_PORT}

[home]
# Geographic coordinates of this installation (0 = auto-detect from public IP)
lat      = ${HOME_LAT}
lon      = ${HOME_LON}
# Uncomment to pin your public IP instead of auto-detecting:
#ip      = ${HOME_IP}

[sentinel]
# Sentinel central server (leave blank to disable forwarding)
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

[security_center]
# Home Assistant notifications (leave blank to disable)
ha_url   = ${FSC_HA_URL}
ha_token = ${FSC_HA_TOKEN}
# IPs excluded from the SSH security scan (comma-separated)
ignore_ips = ${FSC_IGNORE_IPS}
CONF

    chmod 640 "$CONF_FILE"
    ok "Config written to $CONF_FILE"
fi

# ── SSH key for collector ──────────────────────────────────────────────────
echo ""
echo -e "${CYN}── SSH Key (fail2ban collector) ─────────────────${NC}"
mkdir -p "$APP_DIR/conf"
if [[ -f "$SSH_KEY_PATH" ]]; then
    ok "SSH key already exists: $SSH_KEY_PATH"
    # Recover missing .pub from private key (happens when only private key was committed)
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
# Suggest the owner of the app directory as the run user
SUGGESTED_USER=$(stat -c '%U' "$APP_DIR" 2>/dev/null || echo "$(logname 2>/dev/null || echo root)")
ask RUN_USER "User to run the service as" "$SUGGESTED_USER"

# Verify user exists
id "$RUN_USER" &>/dev/null || die "User '$RUN_USER' does not exist."
RUN_GROUP=$(id -gn "$RUN_USER")

# Make sure config is readable by that user
chown root:"$RUN_GROUP" "$CONF_DIR" "$CONF_FILE" 2>/dev/null || true

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
ExecStart=${PYTHON} ${APP_DIR}/app.py
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
echo ""
echo -e "${CYN}╔═══════════════════════════════════════════════╗${NC}"
echo -e "${CYN}║              Setup complete!                  ║${NC}"
echo -e "${CYN}╚═══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Web UI   : ${GRN}http://$(hostname -I | awk '{print $1}'):${SERVER_PORT:-5056}${NC}"
echo -e "  Config   : ${CYN}$CONF_FILE${NC}"
echo -e "  Logs     : ${CYN}journalctl -u sentinel-alert -f${NC}"
echo -e "  Status   : ${CYN}systemctl status sentinel-alert${NC}"
echo -e "  Restart  : ${CYN}sudo systemctl restart sentinel-alert${NC}"
echo ""
