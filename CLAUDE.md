# Sentinel-Alert

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

## Honeypot — konfigurace

```ini
[honeypot]
ssh_port  = 2222
http_port = 8080
```

Router (192.168.2.1) přeposílá WAN porty 2222 a 8080 na tento stroj.
Honeypot filtruje všechna privátní/lokální IP (RFC 1918) — zaznamenává pouze skutečné externí útočníky.

## Otevřené TODO

- [x] Responzivita — desktop `no-auth` odstraněn prázdný `users-area` řádek; mobilní `no-auth` override (single col); title skryt na 641–1100px
- [x] Zařízení s více IP — groupování v device listu podle hostname; zobrazuje `[192.168.2.114 / 192.168.2.115]`
- [x] WORK — animace oblouků aktivních uživatelů — `phase` fix + `pointsTransitionDuration(0)`
- [x] Globus se sekl — `pointsTransitionDuration(0)`, `arcsTransitionDuration(0)`
- [x] Závislost na externích JS/CSS — vše je lokálně ve `static/vendor/`
- [x] LXC/QEMU badge — barevné označení `[LXC]`/`[QEMU]` v device listu funguje
- [x] Badge NEW — po odškrtnutí `notify_new` se badge skryje po refreshi device listu
- [x] Grid no-scanner/no-auth konflikt — fixed (`no-scanner` se aplikuje jen když authenticated)

## Fáze vývoje

- [x] Phase 1: Databázové schema (attacks, devices, ban_history, active_users)
- [x] Phase 2: Scanning Engine (ARP + TCP port probe)
- [x] Phase 3: Real-time Backend (WebSockets, event queue)
- [x] Phase 4: Frontend Vizualizace (Globe.gl, Chart.js, attack history)
- [x] Phase 5: Network Map — D3 force-directed graf s IP, hostname, porty, drag & drop, topology save

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
