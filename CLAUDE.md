# Sentinel-Alert

1. Projit zmenu a aktualizovat CLAUDE.md
2. 192.168.2.1 je mikrotik, najit zpusob jak z nej ziskat blokovane IP a take zpusob jak tam pridat IP k zablkovani z f2b, ssh, http a https utoku. Predelat na zalozku lokal network a presunout vse thread map tykajici se local network sem + sem pridat mikrotik napojeni -> vizualizace, blokace (automaticka i rucni) - tato zalozka pouze pro HOME instanci
3. local network v thread map nahradit jinym pohledem tykajici se f2b, http, https a ssh utoku...
4. security crt -> os infrastructure graph zmenit barvy, neprehledne
5. pridat zalozku pihole -> napojeni na pihole instance -> zadani IP kde bezi, muze bezet vice (1, 2, klidne i 3 a vice), definovat primary a secundary u vice adres, vizualizovat data z pihole. toto zobrazeni take pouze pro HOME instanci.
6. zvednout verzi na 2026.06.001
7. dukladna analyza, sepsani readme, dokumentaci, history. commit 

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
4. **sniproxy.py** — SSH monitor vzdáleného SNI proxy, statistiky za posledních 24h.
5. **app.py** — FastAPI server, WebSocket streaming, REST API.
6. **bridge.py** — Odesílání událostí do hlavní Sentinel instance.
7. **geoip.py** — GeoIP lookup (GeoLite2-City.mmdb + ip-api.com fallback).

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
