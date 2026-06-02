# Sentinel-Alert

## TODO

1. ✅ Aktualizovat CLAUDE.md (hotovo)
2. **MikroTik (192.168.2.1)** — získat blokované IP, přidat IP z f2b/ssh/http/https, přesunout vše kolem LAN do záložky LOCAL NETWORK, MikroTik vizualizace + ruční/auto blokace — pouze HOME instance
3. **Threat map** — local network pohled nahradit pohledem zaměřeným na f2b/http/https/ssh útoky
4. ✅ Security CRT → OS infrastructure graph — barvy opraveny (hotovo)
5. **PiHole záložka** — napojení na PiHole instance (zadání IP, primary/secondary pro více instancí), vizualizace dat — pouze HOME instance
6. ✅ Verze → 2026.06.001 (hotovo)
7. README, dokumentace, commit

## Popis

Sentinel-Alert je nástroj pro monitoring domácí sítě a vizualizaci honeypot útoků. Kombinuje LAN skenování (Pi.Alert styl) s detekcí hrozeb přes honeypot (Knock-Knock styl). Běží na Ubuntu/Debian/Raspberry Pi OS.

## Architektura

- **Backend:** Python / FastAPI
- **Databáze:** SQLite (`data/alerts.db`)
- **Frontend:** HTML5, CSS3, Vanilla JS + Globe.gl (3D globus), Chart.js
- **Komunikace:** WebSockets pro live streaming dat
- **Port:** 5056

## Moduly

1. **honeypot.py** — Fake SSH (port 2222) a HTTP (port 8080) server. Každé připojení z externí IP zaznamená, obohatí o GeoIP data a uloží do DB.
2. **scanner.py** — ARP sweep + TCP port probe. Detekuje zařízení v síti, jejich dostupnost a otevřené porty.
3. **fsc.py** — Service checker (HTTP/TCP/Ping/DNS/Heartbeat). Konfigurace v `data/services.json`.
4. **proxy_monitor.py** — Monitor nginx stream proxy (SNI). Čte logy z `/var/log/nginx/proxy_*.log` přes SSH, statistiky za posledních 24h. Log formát: `IP [datum] "doména" -> backend:port tx/rx durace s`.
5. **app.py** — FastAPI server, WebSocket streaming, REST API.
6. **bridge.py** — Odesílání událostí do hlavní Sentinel instance.
7. **geoip.py** — GeoIP lookup (GeoLite2-City.mmdb + ip-api.com fallback).
8. **collector.py** — SSH sběr dat z hostů (OS, CVE, fail2ban, firewall, zdroje).
9. **blocklist.py** — Správa IP blocklists (GeoIP + fail2ban bans).
10. **workmode.py** — Přepínání home/work módu (mění accent barvu a layout).

## Konfigurace

`/etc/sentinel/sentinel-alert.conf` — hlavní konfigurace (INI formát):
- `[proxy]` server, ssh_user, log_files
- `[auth]` username, password, secret (persistentní — nesmí chybět, jinak se generuje random secret a uživatel je vylogován po každém restartu)
- `[honeypot]` ssh_port, http_port
- `[collector]` ssh_user, monitor_hosts
- `[security_center]` ha_url, ha_token, ignore_ips
- `[scanner]` enabled
- `[mode]` type (home/work), ips_file, who_file

---

## Guidelines for Behavior (Strict)

### 1. Think before you code
- Don't assume. If you're not sure, stop and ask.
- Explicitly emphasize trade-offs.
- If there are multiple interpretations, present them - don't silently choose.

### 2. Simplicity First
- Minimal code that solves the problem. No speculative functions.
- No abstractions for disposable code.
- "Would the lead engineer say this is too complicated?" If so, rewrite.

### 3. Surgical Changes
- Touch only what is necessary.
- Do not improve or refactor existing code unless it is an explicit task.
- Adapt existing style.
- Every changed line must directly reference the requirement.

### 4. Goal-Oriented Execution
- Before coding, provide a plan:
1. [Step] → verify: [check]
2. [Step] → verify: [check]
- Before implementing, write tests/checks that reproduce the goal.

---

**These guidelines work if:** fewer unnecessary changes, fewer reworked solutions, and questions come *before* implementation.
