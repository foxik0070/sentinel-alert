# Sentinel-Alert

Real-time network monitoring, honeypot visualization and LAN security scanner for home-labs and small networks. Runs on **Debian / Ubuntu / Raspbian** and **RHEL 8 / 9 / 10** (AlmaLinux, Rocky Linux).

---

## Features

| Tab / Feature | Description | Requires auth | Requires config |
|---------------|-------------|:-------------:|-----------------|
| **Threat Map** | 3D globe — live attack arcs, country heatmap, fail2ban bans, top countries, attack history | no | — |
| **Security Center** | SSH-based host security matrix (OS, CVEs, firewall, fail2ban) | yes | `security_center.enabled = true` |
| **Proxy Monitor** | Sniproxy log reader — throughput, top domains, live feed | yes | `sniproxy.server` set |
| **Network Map** | Interactive D3.js topology (drag & drop, switches, routers, ports) | yes | `scanner.enabled = true` |
| **Database Viewer** | Browse, search and delete records from attacks / bans / devices tables | yes | — |
| **Settings** | Live config editor, system health status, export config | yes | — |
| **Report** | Markdown report of last 24 h — attacks, bans, devices, logs (downloaded) | yes | — |

Additional capabilities:

- **Globe solo mode** — open `/?solo=globe` in a new tab for a fullscreen globe-only view
- **Blocked IPs** — load a static file of banned IPs onto the globe (geo-resolved with ISP)
- **Sentinel Bridge** — forward events to a central Sentinel server
- **Honeypot** — fake SSH (port 2222) and HTTP (port 8080) services that capture attacks
- **ISP enrichment** — background task enriches existing records via ip-api.com

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
server    = 192.168.2.203
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
ignore_ips = 192.168.2.1,192.168.2.202

[threat]
# File with one blocked IP per line — visualized on the globe as fail2ban arcs
blocks_ips_file =
```

Config is read at startup. After editing, restart the service:

```bash
sudo systemctl restart sentinel-alert
```

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

**Node types:** `host` (circle), `switch` (rectangle), `router` (diamond)

**Edit mode** (click EDIT):
- Drag nodes to reposition
- Click node → side panel: edit label, IP, MAC; set connect/disconnect notifications
- `+ HOST`, `+ SWITCH`, `+ ROUTER` — add nodes
- `+ LINK` → click two nodes to connect (optionally assign port numbers)
- RESEED — auto-populate from current LAN scan
- SAVE — persists to `data/topo.json`

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
| WS | `/ws/live` | no | Live event stream |

---

## Data files

| Path | Description |
|------|-------------|
| `data/alerts.db` | SQLite — attacks, bans, devices |
| `data/topo.json` | Network topology |
| `data/net_settings.json` | Host notification settings |
| `data/fsc_hosts.json` | Security Center host enable/disable |
| `data/sniproxy_stats.json` | Proxy monitor persisted stats |
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
