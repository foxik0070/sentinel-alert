# Sentinel-Alert

Network monitoring, honeypot visualization and LAN security scanner for home-labs and small networks. Runs on **Debian / Ubuntu / Raspbian** and **RHEL 8 / 9 / 10** (AlmaLinux, Rocky Linux).

---

## Features

| Tab | Description | Requires |
|-----|-------------|---------|
| **Threat Map** | Real-time 3D globe with live attack arcs, fail2ban bans, country stats | always on |
| **Security Center** | SSH-based host security matrix (OS, CVEs, firewall, fail2ban) | `security_center.enabled = true` |
| **Proxy Monitor** | Sniproxy log reader — throughput, top domains, live connection feed | `sniproxy.server` set |
| **Network Map** | Interactive D3.js topology (drag & drop, switches, routers, ports) | `scanner.enabled = true` |

Additional:
- **Blocked IPs** visualization on the globe — load a file of banned IPs with GeoIP+ASN enrichment
- **Sentinel Bridge** — forward events to a central Sentinel server
- **Honeypot** — fake SSH (port 2222) and HTTP (port 8080) services that capture attacks

---

## Requirements

- Python 3.9+
- `openssh-client`, `nmap`
- GeoLite2-City.mmdb (free from MaxMind — place in `data/`)
- GeoLite2-ASN.mmdb (optional, for ISP lookup — place in `data/`)

---

## Installation

```bash
# 1. Clone
git clone https://github.com/youruser/sentinel-alert.git
cd sentinel-alert

# 2. Install system deps + Python venv
sudo ./setup.sh --deps

# 3. Configure + install systemd service
sudo ./setup.sh
```

### Manual venv setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### Running without systemd

```bash
SENTINEL_CONF=/etc/sentinel/sentinel-alert.conf .venv/bin/python app.py
```

---

## Configuration

All settings live in `/etc/sentinel/sentinel-alert.conf` (INI format).
Re-run `sudo ./setup.sh --reconf` to reconfigure interactively.

```ini
[server]
host = 0.0.0.0
port = 5056

[home]
lat = 49.8209      # 0 = auto-detect from public IP
lon = 18.2625

[sentinel]
url      = https://sentinel.example.com
token    = <64-char-token>
hostname = my-node

[honeypot]
ssh_port  = 2222
http_port = 8080

[scanner]
# Enables ARP LAN scan and the Network Map tab
enabled = false

[collector]
# SSH-based fail2ban polling across hosts
ssh_user      = root
hosts_file    = /etc/hosts
monitor_hosts =          # empty = auto-discover from hosts_file

[sniproxy]
# Remote proxy running sniproxy - logs read via SSH
# Leave server empty to hide the Proxy Monitor tab
server    = 192.168.2.203
ssh_user  = root
log_files = /var/log/sniproxy/https_access.log,/var/log/sniproxy/http_access.log

[security_center]
enabled    = true         # false hides the Security Center tab
ha_url     =              # Home Assistant URL for push notifications
ha_token   =
ignore_ips = 192.168.2.1,192.168.2.202

[threat]
# Visualize blocked IPs from a file on the globe (one IP per line)
# IPs are geo-resolved with GeoIP+ASN; shown as fail2ban/port-22 arcs
blocks_ips_file =
```

---

## GeoIP databases

Download free databases from [maxmind.com](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data) (account required):

```bash
# Place in data/
data/GeoLite2-City.mmdb   # required for country + coordinates
data/GeoLite2-ASN.mmdb    # optional - ISP / org name lookup
```

---

## SSH key setup

The collector and sniproxy reader use `conf/id_ed25519` to SSH into remote hosts.

```bash
# Generated automatically by setup.sh
# Distribute public key to all monitored hosts:
ssh-copy-id -i conf/id_ed25519.pub root@<HOST>
```

---

## Tabs in detail

### Threat Map

- **Globe** — arcs represent attacks; age-based coloring (cyan to yellow to orange to red)
- **LOCAL NETWORK** — ARP scan results with online/offline status and open ports
- **FAIL2BAN HISTORY** — recent ban events from all monitored hosts
- **TOP COUNTRIES** — hit count bar chart
- **SYSTEM LOGS** — live event feed

**Blocked IPs file**: set `threat.blocks_ips_file` to load a static list of blocked IPs onto the globe. Each IP is geo-resolved once and rendered as a fail2ban arc.

### Security Center

SSH-based host scanner. For each host in `/etc/hosts` (excluding `ignore_ips`):

- OS / kernel / distro / EOL status
- CPU, RAM, disk usage
- Pending updates split by CVE severity
- fail2ban status, firewall status
- Root SSH login allowed / passwordless users
- LXC / VM container detection

Hosts can be enabled/disabled individually from the UI.

### Proxy Monitor

Reads sniproxy access logs from a remote server via SSH every 5 seconds.

- Live TX/RX throughput (KB/s)
- Top domains by data transfer
- Top clients by data transfer
- Live connection feed
- fail2ban bans forwarded from the collector

### Network Map

Interactive D3.js force-directed topology.

**Node types:**
- `host` — circle, green if online / grey if offline
- `switch` — rectangle (blue), define port count
- `router` — diamond (purple)

**Edit mode** (click EDIT):
- Drag nodes to reposition
- Click node to open side panel: edit label, IP, MAC; set connect/disconnect notification per host
- Add nodes with `+ HOST`, `+ SWITCH`, `+ ROUTER`
- Add links with `+ LINK`, then click two nodes (optionally assign port numbers)
- RESEED: auto-populate from current LAN devices
- SAVE: persists to `data/topo.json`

**Per-host notifications** (connect/disconnect) are stored in `data/net_settings.json`.

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Feature flags, home geo, sentinel status |
| GET | `/api/devices` | LAN devices |
| GET | `/api/attacks` | Recent honeypot attacks |
| GET | `/api/bans` | fail2ban ban history |
| GET | `/api/stats/countries` | Country hit counts |
| GET | `/api/blocklist` | Blocked IPs with geo data |
| GET | `/api/topo-data` | Network topology |
| POST | `/api/topo-data` | Save topology |
| GET | `/api/network/settings` | Host notification settings |
| POST | `/api/network/settings` | Update host notification settings |
| GET | `/api/fsc/data` | Security Center scan data |
| POST | `/api/fsc/scan` | Trigger manual scan |
| GET | `/api/fsc/hosts` | Host list with enabled/disabled status |
| POST | `/api/fsc/hosts/toggle` | Toggle host scan enable/disable |
| GET | `/api/sniproxy/data` | Proxy monitor metrics |
| GET | `/api/sniproxy/debug` | SSH diagnostic for sniproxy |
| WS | `/ws/live` | Live event stream |

---

## Data files

| Path | Description |
|------|-------------|
| `data/alerts.db` | SQLite - attacks, bans, devices |
| `data/topo.json` | Network topology |
| `data/net_settings.json` | Host notification settings |
| `data/fsc_hosts.json` | Security Center host enable/disable |
| `data/sniproxy_stats.json` | Proxy monitor persisted stats |
| `data/settings.json` | Sentinel bridge credentials |
| `data/GeoLite2-City.mmdb` | GeoIP city database |
| `data/GeoLite2-ASN.mmdb` | GeoIP ASN/ISP database |
| `conf/id_ed25519` | SSH private key for remote access |

---

## Uninstall

```bash
sudo ./setup.sh --uninstall   # removes service, keeps config
sudo rm -rf /etc/sentinel     # remove config
```
