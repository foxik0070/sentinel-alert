# Sentinel-Alert

Real-time network monitoring, honeypot visualization and LAN security scanner for home-labs and small networks. Runs on **Debian / Ubuntu / Raspbian** and **RHEL 8 / 9 / 10** (AlmaLinux, Rocky Linux).

---

## Features

| Tab / Feature | Description | Requires auth | Requires config |
|---------------|-------------|:-------------:|-----------------|
| **Threat Map** | 3D globe — live attack arcs, country heatmap, fail2ban bans, top countries, attack history | no | — |
| **Security Center** | SSH-based host security matrix (OS, CVEs, firewall, fail2ban) | yes | `security_center.enabled = true` |
| **Proxy Monitor** | Sniproxy log reader — throughput, top domains, live feed | yes | `sniproxy.server` set |
| **Network Map** | Interactive D3.js topology — LAN devices, switches, routers, ISP gateway, virtual switches | yes | `scanner.enabled = true` |
| **Services** | Uptime monitoring — HTTP/HTTPS, TCP, Ping, DNS, Heartbeat; SSL cert check, response graphs, uptime stats | yes (home only) | — |
| **Database Viewer** | Browse, search and delete records from attacks / bans / devices tables | yes | — |
| **Settings** | Live config editor, system health status, export config | yes | — |
| **Report** | Markdown report of last 24 h — attacks, bans, devices, logs (downloaded) | yes | — |

Additional capabilities:

- **Globe solo mode** — open `/?solo=globe` in a new tab for a fullscreen globe-only view
- **Blocked IPs** — load a static file of banned IPs onto the globe (geo-resolved with ISP)
- **Sentinel Bridge** — forward events to a central Sentinel server
- **Honeypot** — fake SSH (port 2222) and HTTP (port 8080) services that capture attacks
- **ISP enrichment** — background task enriches existing records via ip-api.com
- **Command palette** — `Ctrl+K` (or `/`): fuzzy actions + global search across devices,
  attackers, services; type an IP to get a one-click MikroTik block
- **Keyboard shortcuts** — `1–6` switch tabs, `?` help overlay, `ESC` closes modals
- **Themes** — 4 color schemes (CYAN / AMBER / MATRIX / RED ALERT), 8 accent colors,
  light mode; optional CRT/glitch FX, boot sequence and sound FX (Settings → Appearance)
- **Globe view modes** — ARCS / HEAT (hex-bin density) / POINTS + vector filter
  (F2B/SSH/HTTP/HTTPS) + **24 h timeline replay** (1 h ≈ 1 s)
- **Radar widget** — sonar sweep with blips at the real bearing/distance of attackers
- **IP intelligence** — click any IP: GeoIP/ASN, attack history, ports, bans,
  watch/block buttons, AbuseIPDB & whois links
- **Watchlist** — track IPs/prefixes/CIDRs; highlighted everywhere, alarm on hit
- **Alerting** — ntfy / Telegram push for new LAN devices, offline devices, watchlist hits
- **MikroTik auto-block** — automatically blocks attackers on the router (see `[mikrotik]`)
- **Trends & reports** — 7/30-day stacked attack charts with period comparison;
  daily HTML report generated at 06:00 (`data/reports/`)
- **Toast notifications** — live "INCOMING" toasts with per-IP dedup
- **DB maintenance** — nightly retention prune + VACUUM; **audit log** of all
  sensitive actions (login, block, config) browsable in the DB viewer
- **Login rate-limit** — max 5 attempts/minute per IP
- **Dashboard summary bar** — today vs. yesterday attacks, top vector, hot zone,
  devices online, PiHole block % — above the Threat Map
- **Hot zones** — pulsing red rings on the countries with most attacks in the last hour
- **CSV / JSON export** — from the DB viewer and IP intelligence card (all attacks of an IP)
- **PWA** — installable (manifest + service worker); app shell works offline,
  API/WebSocket always go to the network
- **Health check** — `GET /healthz` (DB, modules, uptime, WS clients) for monitoring
- **Security headers** — CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy;
  globe textures self-hosted (no external CDN); gzip on large JSON responses
- **WebGL fallback** — if the browser can't create a WebGL context, the globe panel
  shows a 2D live attack feed and the rest of the dashboard keeps working
- **Prometheus metrics** — `GET /metrics` (attacks by vector, devices, PiHole, uptime)
- **DB backup** — one-click download + nightly auto-backup (keeps last 7)
- **Config self-test** — on startup checks MikroTik/proxy/PiHole reachability
- **Browser notifications** — native alerts even when the tab is in the background (opt-in)
- **Attack spike detection** — anomaly watcher flags sudden bursts (≥3× baseline)
- **Kiosk mode** — `?kiosk` (or `?kiosk=30`) auto-cycles tabs with a wake-lock for wall displays
- **2FA (TOTP)** — optional, RFC 6238, works with Google/Aegis Authenticator; setup in Settings
- **Read-only API token** — grants GET `/api` access (dashboard embeds, scripts) without
  sharing the password; excludes backup/config/export; managed in Settings
- **Threat intel import** — public blocklists (blocklist.de / Spamhaus DROP / FireHOL);
  known-bad IPs marked ☠ everywhere, optional auto-block on MikroTik
- **GeoIP country blocking** — block attacking IPs from selected countries on MikroTik,
  with impact preview (IPs/attacks covered)
- **Fail2ban jail management** — jails across all monitored hosts (SSH), one-click unban
- **ASN / ISP breakdown** — top attacking networks (in the Trends modal)
- **Webhook receiver** — `POST /api/webhook/{token}` ingests external events onto the feed/globe
- **Slack / Discord alerts** — in addition to ntfy / Telegram
- **Docker** — `Dockerfile` + `docker-compose.yml` (host network, data/conf volumes)
- **Grafana** — ready-made dashboard (`grafana-dashboard.json`) wired to `/metrics`
- **Attack ticker** — live scrolling attack feed above the Threat Map
- **Analytics** — hour×day heatmap, top ports, IP correlation, /24 botnet clustering,
  attack prediction, on-this-day (ANALYTICS modal)
- **IP reputation** — 0-100 score (attacks + vectors + bans + threat-intel) in the IP card
- **External lookups** — AbuseIPDB / VirusTotal / Shodan / GreyNoise (API keys in `[integrations]`)
- **IP context menu** — right-click any IP: intel / block / watch / globe / copy / export
- **Command palette** — recent + pinned actions, saved views (tab + filter + scheme)
- **Bulk block** — block all visible attackers on MikroTik in one call
- **Undo delete** — restore records removed in the DB viewer
- **SIEM export** — ArcSight CEF format; RSS feed (`/feed.xml`)
- **More alert channels** — Slack / Discord / Rocket.Chat / SMTP e-mail / Syslog (RFC 5424)
- **Multi-user** — optional read-only *viewer* account; reverse-proxy auth trust (OIDC)
- **12-factor config** — any value overridable via `SENTINEL_<SECTION>_<KEY>`; `env:VAR` secret refs
- **General API rate-limit**, **rsync offsite backups**, **rotating JSON audit log**
- **Honeypot deception** — optional FTP/Telnet/SMTP/RDP/SMB fake services with realistic banners
- **Honeypot session capture** — full session payload, HTTP Basic creds, User-Agent, SSH client banner
- **JA3 fingerprint** — TLS ClientHello fingerprint (spots the same tool/botnet across IPs)
- **Response playbooks** — rules (known_bad/watchlist/protocol/country/min_hits) → actions (block/notify/tag)
- **ML anomaly** — `/api/analytics/anomaly` z-score of last 10 min vs. 7-day baseline
- **Attack network graph** — D3 force graph IP→ISP→country (spots coordinated campaigns)
- **PDF reports** — daily report as PDF via headless Chromium
- **MQTT / Home Assistant** — publishes metrics for HA sensors (`[mqtt]`)
- **OpenSearch / Elasticsearch export** — streams attacks via `_bulk` (`[siem]`)
- **Country names on the globe** — attacking countries labelled with hit counts, toggleable

---

## Requirements

- Python 3.9+
- `openssh-client`, `nmap` (for Security Center and collector)
- GeoLite2-City.mmdb (free from MaxMind — place in `data/`)
- GeoLite2-ASN.mmdb (optional — better ISP lookup; place in `data/`)

---

## Installation

```bash
# 1. Clone
git clone https://github.com/youruser/sentinel-alert.git
cd sentinel-alert

# 2. Full install: system deps + venv + config + systemd service
sudo ./setup.sh

# — or — install deps only, configure later:
sudo ./setup.sh --deps    # installs system packages + Python venv
sudo ./setup.sh           # configure + install service
```

The setup script:
1. Detects distro (Debian/Ubuntu/RHEL/Fedora) and installs system packages
2. Creates `.venv/` and installs Python dependencies
3. Walks you through interactive configuration
4. Writes `/etc/sentinel/sentinel-alert.conf`
5. Initialises the SQLite database (`data/alerts.db`)
6. Generates an ed25519 SSH key for the fail2ban collector
7. Installs and enables a systemd unit

### Reconfigure

```bash
sudo ./setup.sh --reconf   # overwrite existing config interactively
```

### Uninstall

```bash
sudo ./setup.sh --uninstall   # removes systemd service, keeps config
sudo rm -rf /etc/sentinel     # remove config
```

### Manual / development setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
python3 db_init.py
SENTINEL_CONF=/etc/sentinel/sentinel-alert.conf .venv/bin/python app.py
```

---

## Authentication

The dashboard is split into two access levels:

| Without login | With login |
|---------------|-----------|
| Threat Map (globe, top countries, attack history) | All tabs |
| — | Settings, Report, Database Viewer |
| — | System Logs panel |
| — | Local Network panel |

Default credentials: **admin / admin** — change in `/etc/sentinel/sentinel-alert.conf` under `[auth]` before exposing to any network.

Sessions use HMAC-SHA256 signed cookies (7-day TTL). The `secret` key is auto-generated on first start if not set.

---

## Configuration

All settings live in `/etc/sentinel/sentinel-alert.conf` (INI format).

```ini
[auth]
# Dashboard login credentials — change before exposing to any network
username = admin
password = admin
# HMAC secret for session tokens — leave blank to auto-generate on each start
secret   =
# 2FA (TOTP) — managed from Settings; blank = disabled
totp_secret =
# Read-only API token — managed from Settings; blank = disabled
api_token   =

[threat]
# Import public threat-intel blocklists (blocklist.de / Spamhaus / FireHOL)
intel_enabled   = false
# Auto-block known-bad IPs on MikroTik (needs mikrotik.auto_block)
intel_autoblock = false

[alerts]
# Slack / Discord webhooks (alongside ntfy / Telegram)
slack_webhook   =
discord_webhook =

[mode]
# Deployment mode: "home" (default) or "work"
# In work mode: Security Center, Proxy Monitor, Network Map and Settings
# tabs are hidden; the USERS panel replaces Local Network.
type     = home
# Path to a file of blocked IPs (one per line, # comments allowed).
# These are visualized as attack arcs on the globe exactly like fail2ban bans.
ips_file =
# Path to a CSV file listing known users (name,dept,ip,note).
# Shown in the USERS panel when authenticated.
who_file =

[server]
host     = 0.0.0.0
port     = 5056

[home]
# Geographic coordinates of this installation (0 = auto-detect from public IP)
lat      = 49.8209
lon      = 18.2625
# Uncomment to pin your public IP:
#ip      = 1.2.3.4

[sentinel]
# Central Sentinel server — leave url blank to disable
url      = https://sentinel.example.com
token    = <64-char-token>
hostname = my-node
# ca_bundle = /etc/sentinel/tls/sentinel.crt   # self-signed Sentinel server CA

[honeypot]
# Ports the fake services listen on (must be > 1024 unless running as root)
ssh_port  = 2222
http_port = 8080

[collector]
# SSH-based fail2ban polling
ssh_user      = root
hosts_file    = /etc/hosts
# Explicit hosts to poll (comma-separated). Empty = auto-discover from hosts_file.
monitor_hosts =

[sniproxy]
# Remote proxy running sniproxy — logs read via SSH
# Leave server blank to hide the Proxy Monitor tab
server    = 192.168.1.203
ssh_user  = root
log_files = /var/log/sniproxy/https_access.log,/var/log/sniproxy/http_access.log

[scanner]
# ARP-based LAN scanning — enables the Network Map tab
enabled = false

[security_center]
# enabled = false hides the Security Center tab
enabled    = true
ha_url     =          # Home Assistant URL for push notifications
ha_token   =
ignore_ips = 192.168.1.1,192.168.1.202

[threat]
# File with one blocked IP per line — visualized on the globe as fail2ban arcs
blocks_ips_file =

[mikrotik]
# MikroTik router integration (HOME instance only) — address lists, firewall
# rules, manual + automatic blocking. Leave host blank to disable.
host       = 192.168.1.1
ssh_user   = admin
# Auto-block attackers: fail2ban ban → immediately, honeypot/proxy attack
# → after auto_block_threshold hits from the same IP (1 week timeout).
auto_block           = false
auto_block_threshold = 3

[pihole]
# PiHole instances (HOME instance only) — comma-separated hosts, one primary
hosts    = 192.168.1.5,192.168.1.6
primary  = 192.168.1.5
password =

[alerts]
# Push notifications: new LAN device, device offline, watchlist hit
enabled        = false
# ntfy topic URL, e.g. https://ntfy.sh/my-sentinel-topic
ntfy_url       =
# Or a Telegram bot:
telegram_token =
telegram_chat  =

[db]
# Retention for attacks + ban history (daily prune at 04:30 + VACUUM)
retention_days = 90
# Optional offsite backup target (rsync over SSH); empty = local only
backup_rsync_target =

[integrations]
# External IP lookup services (blank = disabled). Shown on-demand in the IP card.
abuseipdb_key  =
virustotal_key =
shodan_key     =
greynoise_key  =
# MISP threat-intel feed (imported alongside blocklist.de/Spamhaus/FireHOL)
misp_url =
misp_key =

[siem]
# Stream attacks to OpenSearch/Elasticsearch via _bulk (blank url = disabled)
url      =
index    = sentinel-attacks
user     =
password =

[mqtt]
# Publish metrics to an MQTT broker for Home Assistant (blank host = disabled)
host     =
port     = 1883
user     =
password =
prefix   = sentinel
```

Response playbooks are edited in the UI (command palette → *Response playbooks*)
and stored in `data/playbooks.json`. `[honeypot] extra_services` also enables
session capture + JA3 fingerprinting on those listeners.

Extra `[auth]` keys: `viewer_username` / `viewer_password` (read-only account),
`trust_proxy_header` (trust reverse-proxy auth header, e.g. `X-Forwarded-User`),
`api_rate_limit` (req/min per IP; 0 = off). `[honeypot] extra_services` enables extra
deception listeners (`ftp,telnet,smtp,rdp,smb`). `[alerts]` adds `rocketchat_webhook`,
`smtp_*`, `syslog_*`. Any value may be overridden with an env var
`SENTINEL_<SECTION>_<KEY>`, or point to a secret with `env:VARNAME`.

Config is read at startup. After editing, restart the service:

```bash
sudo systemctl restart sentinel-alert
```

---

## Work Mode

Work mode adapts the dashboard for office deployments where LAN scanning and security auditing are not available or not needed.

### Enable

```ini
[mode]
type     = work
ips_file = /etc/sentinel/blocked.txt
who_file = /etc/sentinel/users.csv
```

### UI differences

| Feature | Home mode | Work mode |
|---------|-----------|-----------|
| Threat Map (globe) | visible to all | visible to all |
| SYSTEM LOGS panel | auth required | auth required |
| **LOCAL NETWORK panel** | auth required | **hidden** |
| **USERS panel** | hidden | auth required |
| Security Center tab | auth + config | **hidden** |
| Proxy Monitor tab | auth + config | **hidden** |
| Network Map tab | auth + config | **hidden** |
| Settings tab | auth required | **hidden** |

### IPS file format

One IP address per line. Lines starting with `#` are ignored. The IPs are geo-resolved and visualised on the globe exactly like fail2ban bans (attack arcs, country coloring, attack cards).

```
# Blocklist for office network
1.2.3.4
5.6.7.8
# Another block
10.20.30.40
```

### WHO file format

CSV with a header row. Fields: `name,dept,ip,note`.

```csv
name,dept,ip,note
Alice Smith,Engineering,192.168.1.10,workstation
Bob Jones,Marketing,192.168.1.11,laptop
```

All fields except `name` are optional. The USERS panel shows a searchable table of all entries.

---

## GeoIP databases

Required for geographic attack visualization:

```bash
# Download from maxmind.com (free account required)
# Place both files in data/
data/GeoLite2-City.mmdb   # required — country, coordinates
data/GeoLite2-ASN.mmdb    # optional — ISP / org name
```

Without `GeoLite2-City.mmdb` the globe will not display attacks. ISP is also looked up via [ip-api.com](http://ip-api.com) as a fallback (free, 45 req/min, no key). Existing records with unknown ISP are enriched in a background task on startup.

---

## SSH key setup

The collector and sniproxy reader use `conf/id_ed25519` (generated by setup.sh).

```bash
# Distribute public key to all monitored hosts:
ssh-copy-id -i conf/id_ed25519.pub root@<HOST>

# Test connection:
ssh -i conf/id_ed25519 root@<HOST> 'fail2ban-client status'
```

---

## Threat Map — Globe

| Control | Action |
|---------|--------|
| Drag | Rotate globe |
| Scroll | Zoom |
| Click arc or point | Show attack card (IP, country, ISP, port/protocol) |
| Click country (polygon) | Centre globe on that country |
| Click row in Top Countries | Centre globe on that country |
| `⟳ ROT` button | Toggle auto-rotation on/off |
| `⛶` button | Panel fullscreen |
| `⧉` button | Open globe solo in new tab (`/?solo=globe`) |

Country polygons are colored:
- **Red fill + red border** — countries from which attacks were detected (fill intensity scales with hit count)
- **Green fill + green border** — no attacks detected

Attack arcs use age-based coloring (bright and thick when fresh, fading over 24 h). Each new attack triggers a 3-wave shockwave ring at the origin and a 2-wave shield-hit ring at home.

---

## Security Center

SSH-based scanner. For each host in `/etc/hosts` (excluding `ignore_ips`):

- OS / kernel / distro / EOL status
- CPU, RAM, disk usage
- Pending updates split by CVE severity
- fail2ban status, firewall status
- Root SSH login allowed / passwordless users
- LXC / VM container detection

Hosts can be enabled/disabled individually from the UI.

---

## Proxy Monitor

Reads sniproxy access logs from a remote server via SSH every 5 seconds:

- Live TX/RX throughput (KB/s)
- Top domains by data transfer
- Top clients by data transfer
- Live connection feed

---

## Network Map

Interactive D3.js force-directed topology.

**Node types** and shapes:

| Type | Shape | Color | Notes |
|------|-------|-------|-------|
| host | circle | green stroke | fill = online/offline state |
| lxc / qemu | circle | purple / blue | virtual machines |
| nas / server / rpi | circle | yellow / green / red | |
| mobile / pc / iot | circle | light green / grey / cyan | |
| printer / other | circle | orange / dark orange | |
| switch / router / ap | rectangle | blue | network equipment |
| tv | rectangle | orange | TV/media device |
| network | rectangle | dark green | network segment |
| cloud | pill shape | dark | ISP gateway node (auto-created) |

**Link types:** ethernet (green), wifi (blue dashed), virtual/Proxmox (orange)

**Device settings** (click any device):
- Type, connection type, hostname alias
- ISP Gateway flag (router only) — shows yellow glow + cloud node
- Online/offline notifications → forwarded to Sentinel Bridge
- LXC / QEMU flag

**AUTO button** — re-seeds force layout to compact positions.

**SAVE** — persists topology to `data/topo.json`.

---

## Services (Uptime Monitor)

Available in **home mode only**. Monitors availability and health of services in your network and on the internet.

### Monitor types

| Type | What it checks |
|------|----------------|
| **HTTP / HTTPS** | GET or POST request — status code, optional text match, response time, SSL cert validity/expiry/issuer |
| **TCP** | TCP connect to host:port — confirms port is open |
| **Ping** | ICMP ping — basic IP reachability |
| **DNS** | Resolves a domain — optionally against a specific DNS server |
| **Heartbeat** | Reverse monitoring — your script POSTs to `/api/heartbeat/{id}`, alert fires if no ping arrives within interval |

### Display columns

`NAME | TYPE | TARGET | STATUS | RESP | 24H uptime | 30D uptime | SSL/INFO | HISTORY (sparkline) | actions`

- **Status** — `● UP` / `✖ DOWN` with HTTP status code where applicable
- **RESP** — response time (green < 200 ms, yellow < 800 ms, red ≥ 800 ms)
- **24H / 30D** — uptime percentage from check history
- **HISTORY** — mini SVG sparkline: green bar = up, red = down, height = response time
- **SSL** — cert validity + expiry date + days remaining + issuer (HTTPS only)

### Interval

Global check interval (1–60 min) saved in `data/svc_settings.json`. Change in the INTERVAL dropdown.

### Sentinel Bridge notifications

When a service changes state (up→down or down→up), the event is forwarded to the configured Sentinel server (`plugin: service_monitor`).

### Heartbeat URL

After adding a heartbeat service, call its URL from a cron job or script:

```bash
curl -X POST https://your-sentinel-alert:5056/api/heartbeat/<id>
```

### API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/services` | List all services with last status, uptime, sparkline |
| POST | `/api/services` | Add a service |
| DELETE | `/api/services/{id}` | Remove a service |
| POST | `/api/services/check` | Manual check — all services |
| POST | `/api/services/{id}/check` | Manual check — single service |
| GET | `/api/services/settings` | Get check interval |
| POST | `/api/services/settings` | Set check interval (`{"interval_min": 5}`) |
| POST | `/api/heartbeat/{id}` | Receive heartbeat ping |

### Data files

| Path | Description |
|------|-------------|
| `data/services.json` | Service config + last check result |
| `data/svc_settings.json` | Global interval setting |
| `data/alerts.db` table `service_checks` | Check history (30 days retained) |

---

## Database Viewer

Open via **⊞ DB** button (requires login). Supports:

- Tables: **ATTACKS**, **BAN HISTORY**, **DEVICES**
- Fulltext search (debounced)
- Checkbox row selection + "Select all"
- Paginated (100 rows/page)
- `DELETE SELECTED` — with confirmation dialog

---

## API reference

All endpoints returning sensitive data require authentication (session cookie).

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| GET | `/api/config` | no | Feature flags, home geo, sentinel status |
| GET | `/api/auth/status` | no | `{ authenticated: bool }` |
| POST | `/api/login` | no | `{ username, password }` → sets cookie |
| POST | `/api/logout` | no | Clears session cookie |
| GET | `/api/status` | yes | System health — GeoIP, modules, DB stats |
| GET | `/api/config/full` | yes | Full INI config as JSON |
| POST | `/api/config/update` | yes | Update config file |
| GET | `/api/config/export` | yes | Download raw `.conf` file |
| GET | `/api/who` | no | Work mode user list (from WHO file) |
| GET | `/api/devices` | no | LAN devices |
| GET | `/api/attacks` | no | Recent honeypot attacks |
| GET | `/api/bans` | no | fail2ban ban history |
| GET | `/api/stats/countries` | no | Country hit counts |
| GET | `/api/blocklist` | no | Blocked IPs with geo data |
| GET | `/api/db/{table}` | yes | Browse DB table (attacks/ban_history/devices) |
| DELETE | `/api/db/{table}` | yes | Delete records by PK list |
| GET | `/api/report/data` | no | Aggregate data for report generation |
| GET | `/api/topo-data` | no | Network topology |
| POST | `/api/topo-data` | no | Save topology |
| GET | `/api/network/settings` | no | Host notification settings |
| POST | `/api/network/settings` | no | Update host notification settings |
| GET | `/api/fsc/data` | no | Security Center scan data |
| POST | `/api/fsc/scan` | no | Trigger manual scan |
| GET | `/api/fsc/hosts` | no | Host list with enabled/disabled status |
| POST | `/api/fsc/hosts/toggle` | no | Toggle host scan |
| GET | `/api/sniproxy/data` | no | Proxy monitor metrics |
| GET | `/api/services` | no | Service monitor list (with uptime + sparkline) |
| POST | `/api/services` | no | Add monitored service |
| DELETE | `/api/services/{id}` | no | Remove service |
| POST | `/api/services/check` | no | Manual check — all services |
| POST | `/api/services/{id}/check` | no | Manual check — single service |
| GET | `/api/services/settings` | no | Get check interval |
| POST | `/api/services/settings` | no | Set check interval |
| POST | `/api/heartbeat/{id}` | no | Receive heartbeat ping |
| GET | `/api/watchlist` | no | Watchlist entries (IP / prefix / CIDR) |
| POST | `/api/watchlist` | yes | Add entry `{"ip": "1.2.3.4"}` |
| DELETE | `/api/watchlist/{entry}` | yes | Remove entry |
| GET | `/api/ip/{ip}/intel` | no | IP intelligence — GeoIP, ASN, attack/ban history |
| GET | `/api/stats/trends?days=30` | no | Attacks per day per vector + period comparison |
| GET | `/api/reports` | yes | List generated daily reports |
| GET | `/api/reports/{name}` | yes | Serve a daily HTML report |
| POST | `/api/reports/generate` | yes | Generate today's report now |
| GET | `/api/mikrotik/data` | no | MikroTik address lists + firewall rules |
| POST | `/api/mikrotik/block` | no | Block IP on MikroTik |
| POST | `/api/mikrotik/unblock` | no | Remove IP from address list |
| GET | `/api/pihole/data` | no | PiHole instance stats |
| GET | `/healthz` | no | Health check — DB, modules, uptime |
| GET | `/api/stats/summary` | no | Dashboard summary — today vs. yesterday, top vector, hot zone |
| GET | `/api/export/{table}` | yes | Export table to CSV/JSON (`fmt`, optional `ip` filter) |
| GET | `/metrics` | no | Prometheus metrics exposition |
| GET | `/api/backup` | yes | Download a consistent SQLite backup |
| GET | `/api/2fa/status` | yes | Whether TOTP 2FA is enabled |
| POST | `/api/2fa/setup` `enable` `disable` | yes | TOTP setup / confirm / disable |
| GET/POST | `/api/token`, `/api/token/generate\|revoke` | yes | Read-only API token management |
| GET | `/api/threatintel/status` | no | Threat-intel feed status |
| GET | `/api/stats/asn` | no | Top attacking ISP/ASN networks |
| GET | `/api/geoblock/preview` | no | Impact of blocking selected countries |
| POST | `/api/geoblock/apply` | yes | Block attacking IPs from countries on MikroTik |
| GET | `/api/fail2ban/jails` | yes | Fail2ban jails across hosts |
| POST | `/api/fail2ban/unban` | yes | Unban an IP from a jail |
| POST | `/api/webhook/{token}` | token | Ingest an external event |
| WS | `/ws/live` | no | Live event stream |

---

## Data files

| Path | Description |
|------|-------------|
| `data/alerts.db` | SQLite — attacks, bans, devices, service_checks |
| `data/topo.json` | Network topology |
| `data/net_settings.json` | Network Map device settings |
| `data/services.json` | Service Monitor config + last results |
| `data/svc_settings.json` | Service Monitor check interval |
| `data/fsc_hosts.json` | Security Center host enable/disable |
| `data/sniproxy_stats.json` | Proxy monitor persisted stats |
| `data/domains.json` | Legacy (migrated to services.json on first start) |
| `data/GeoLite2-City.mmdb` | GeoIP city database (required) |
| `data/GeoLite2-ASN.mmdb` | GeoIP ASN/ISP database (optional) |
| `conf/id_ed25519` | SSH private key for remote access |
| `/etc/sentinel/sentinel-alert.conf` | Main configuration |

---

## Logs & diagnostics

```bash
# Live logs
journalctl -u sentinel-alert -f

# Last 100 lines
journalctl -u sentinel-alert -n 100 --no-pager

# Service status
systemctl status sentinel-alert

# Restart
sudo systemctl restart sentinel-alert
```

System logs are also visible in the dashboard **SYSTEM LOGS** panel (requires login).
