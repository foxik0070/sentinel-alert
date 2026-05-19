# Sentinel-Alert

Single-process LAN monitor + honeypot s živým 3D globusem.
Vše (ARP scan, fail2ban poller, honeypot, REST + WebSocket API) běží
v jednom Python procesu — stačí jeden příkaz.

---

## TL;DR — Spuštění

```bash
cd ~/git/sentinel-alert-claude
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
sudo -v                       # nahrát sudo cache pro arp-scan
python3 app.py
```

Dashboard:  <http://localhost:5056>

Honeypot poslouchá na `:2222` (fake SSH) a `:8080` (fake HTTP).

---

## Prerekvizity

| Co | Proč | Jak ověřit |
|---|---|---|
| Python 3.10+ | FastAPI lifespan, asyncio | `python3 --version` |
| `arp-scan` | LAN scan | `which arp-scan` |
| Passwordless `sudo arp-scan` | Scanner běží jako neroot | `sudo -n arp-scan --localnet` |
| SSH klíč `conf/id_ed25519` | Sběr fail2ban z hostů | `ls conf/id_ed25519` |
| GeoIP DB `data/GeoLite2-City.mmdb` | Obohacení útoků o stát/ISP | `ls -lh data/GeoLite2-City.mmdb` |
| `/etc/hosts` se servery | Auto-discovery cílů pro fail2ban | `cat /etc/hosts` |

### Passwordless sudo pro arp-scan

Pokud nemáš, scanner každých 5 min vyplivne warning a pokračuje.
Pro povolení (volitelné):

```bash
echo "$USER ALL=(ALL) NOPASSWD: /usr/sbin/arp-scan" | sudo tee /etc/sudoers.d/sentinel-alert
sudo chmod 440 /etc/sudoers.d/sentinel-alert
```

---

## Architektura

```
            ┌───────────── python3 app.py ─────────────┐
            │                                          │
WS klient ──┤  FastAPI :5056   ◄── broadcast queue ◄── │
            │     │                                    │
            │     ├─ /  (static dashboard)             │
            │     ├─ /api/devices, /api/attacks, …     │
            │     └─ /ws/live  (živý stream)           │
            │                                          │
            │  Honeypot       :2222 SSH, :8080 HTTP    │
            │  Scanner loop   sudo arp-scan --localnet │
            │  Collector loop ssh root@<host> fail2ban │
            │  Sentinel bridge → SENTINEL_URL (POST)   │
            │                                          │
            │  SQLite: data/alerts.db                  │
            └──────────────────────────────────────────┘
```

Žádné cron joby, žádné systemd unity, žádné samostatné workery —
periodické úlohy jsou `asyncio` smyčky v lifespanu FastAPI.

---

## Konfigurace (env proměnné)

| Proměnná | Default | Význam |
|---|---|---|
| `SCAN_INTERVAL` | `300` | ARP scan každých N sekund |
| `FAIL2BAN_INTERVAL` | `300` | fail2ban poll každých N sekund |
| `FAIL2BAN_CONCURRENCY` | `5` | Souběžné SSH spojení |
| `SENTINEL_SSH_USER` | `root` | SSH uživatel pro fail2ban-client |
| `SENTINEL_HOSTS_FILE` | `/etc/hosts` | Zdroj seznamu hostů |
| `SENTINEL_HOME_LAT` | `49.8209` | Cíl atakových oblouků (lat) |
| `SENTINEL_HOME_LON` | `18.2625` | Cíl atakových oblouků (lon) |
| `SENTINEL_URL` | _(nenastaveno)_ | Sentinel bridge — kam POST eventy |
| `SENTINEL_TOKEN` | _(nenastaveno)_ | Bearer token pro bridge |

Příklad:

```bash
SCAN_INTERVAL=600 FAIL2BAN_INTERVAL=900 python3 app.py
```

---

## API

REST:

| Endpoint | Popis |
|---|---|
| `GET /` | Dashboard (statická HTML) |
| `GET /api/config` | Globe home coords |
| `GET /api/devices` | LAN inventář (online/offline) |
| `GET /api/attacks?limit=200` | Honeypot zásahy |
| `GET /api/bans?limit=200` | fail2ban historie |
| `GET /api/stats/countries` | Top 20 zemí (počet útoků) |

WebSocket `GET /ws/live`:

- po připojení pošle `{"type":"snapshot","attacks":[…50…]}`
- pak streamuje:
  - `{"type":"attack", src_ip, dst_port, protocol, country, lat, lon, isp, ts}` — honeypot
  - `{"type":"ban",    …stejná pole…, source_host}` — nový fail2ban ban
  - `{"type":"device", state, mac, ip, hostname, vendor}` — změna stavu hosta

---

## Otestování za běhu

V druhém terminálu:

```bash
# Honeypot — měl by se objevit v dashboardu i v DB
nc localhost 2222
curl http://localhost:8080/admin

# Co je v DB
sqlite3 data/alerts.db "SELECT ts, src_ip, protocol, country FROM attacks ORDER BY id DESC LIMIT 10;"
sqlite3 data/alerts.db "SELECT hostname, ip, is_online FROM devices ORDER BY is_online DESC;"
```

---

## Soubory

```
app.py            FastAPI server, WS hub, lifespan starter
tasks.py          Periodické asyncio smyčky (scanner + collector)
honeypot.py       Fake SSH/HTTP listenery
scanner.py        arp-scan + hostname resolution
collector.py      SSH → fail2ban-client status sshd, discovery z /etc/hosts
bridge.py         HTTP forwarder do hlavního Sentinelu
geoip.py          Shared MaxMind helper
db_init.py        Schema (volá se i ze startu app.py)
requirements.txt  fastapi, uvicorn, geoip2, httpx
conf/id_ed25519   SSH klíč (musíš mít na cílových hostech)
data/             alerts.db (vytvoří se), GeoLite2-City.mmdb
static/           index.html, style.css, script.js (globe.gl)
```

---

## Troubleshooting

**`arp-scan failed: ... a password is required`**
→ Bez passwordless sudo. Buď ho povol (viz výše), nebo ignoruj —
ostatní funkce běží.

**`Address already in use` na 2222/8080**
→ Něco už na portu visí. `ss -ltnp | grep -E '2222|8080'`.

**Žádné fail2ban bany**
→ Buď cíle nemají fail2ban (`ssh root@gitea fail2ban-client status sshd`),
nebo SSH klíč není autorizovaný (`ssh -i conf/id_ed25519 root@gitea`).

**Dashboard se nepřipojí na WS**
→ Browser console (`F12`). Při nginx/proxy: musí mít WebSocket upgrade.

**Honeypot nezachytává**
→ Test lokálně: `nc localhost 2222`. Pokud i to selže, zkontroluj logy v
terminálu, kde běží `app.py`.

---

## Vývoj

Jednorázové spuštění bez smyčky:

```bash
python3 db_init.py      # jen schema
python3 scanner.py      # jeden ARP sweep
python3 collector.py    # jeden fail2ban poll přes všechny hosty z /etc/hosts
```

Restart při změně kódu — `uvicorn` s `--reload`:

```bash
uvicorn app:app --host 0.0.0.0 --port 5056 --reload
```
