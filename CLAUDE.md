# Sentinel-Alert

## TODO

1. ✅ Aktualizovat CLAUDE.md (hotovo)
2. ✅ **MikroTik (192.168.2.1)** — vizualizace, ruční blokace i auto-block hotové (`[mikrotik] auto_block` + `auto_block_threshold`; f2b ban blokuje hned, honeypot/proxy po N zásazích) — pouze HOME instance
3. ✅ **Threat map** — pohled zaměřený na útoky: vektorový filtr F2B/SSH/HTTP/HTTPS filtruje globus i seznam, LAN prvky přesunuty do LOCAL NETWORK
4. ✅ Security CRT → OS infrastructure graph — barvy opraveny (hotovo)
5. ✅ **PiHole záložka** — ověřeno proti reálné instanci 192.168.2.204 (PiHole v6.4.3, v6 REST API + SID auth). Data, grafy i top domény sedí; opraveny chybové stavy (síťová chyba vs. špatné heslo, pád polling threadu při string erroru) — pouze HOME instance
6. ✅ Verze → 2026.07.001 (hotovo)
7. ✅ README, dokumentace, commit (hotovo)

Rozšířená roadmapa (30 položek UI/UX/funkcionalita): viz `todo.md`.

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
8. **collector.py** — SSH sběr dat z hostů (OS, CVE, fail2ban, firewall, zdroje). Fail2ban jail management (jails/unban).
9. **blocklist.py** — Správa IP blocklists (GeoIP + fail2ban bans).
10. **workmode.py** — Přepínání home/work módu (mění accent barvu a layout).
11. **alerts.py** — Alerting engine + watchlist (`data/watchlist.json`). Push přes ntfy/Telegram/Slack/Discord (`[alerts]` sekce).
12. **totp.py** — 2FA (TOTP, RFC 6238) čistě ze stdlib. Login flow + `[auth] totp_secret`.
13. **threatintel.py** — Import veřejných blocklistů (blocklist.de/Spamhaus/FireHOL), `is_known_bad(ip)`, `[threat] intel_enabled`.
14. **mikrotik.py** — MikroTik firewall (address-list, filter/NAT rules) přes SSH; ruční/auto/batch blokace, GeoIP country block.
15. **pihole.py** — PiHole v6 REST API (multi-instance, primary/secondary).

Frontend je rozdělen do modulů `static/js/00-ui.js … 11-ux.js` (klasické skripty načítané v pořadí, sdílený globální scope — žádný build step). 00 = sdílené utility (toasty, UIState, zvuk, boot, notifikace, gauge, watchlist), 01–10 = per-tab logika, 11 = command palette/UX/IP intel/trends/reports/kiosk/f2b.

Testy: `.venv/bin/python -m pytest tests/` (84 testů). Dev závislosti: `requirements-dev.txt`.
Nasazení: systemd (`setup.sh`) nebo Docker (`docker-compose.yml`). Monitoring: `/healthz`, `/metrics` (+ `grafana-dashboard.json`).

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
