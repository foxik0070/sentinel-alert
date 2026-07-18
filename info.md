## WORK mode — architektura (HPC, 2026-05-26)

Datový tok:
- `f2b-who` (WHO_ISP.py, systemd timer) → `active_users` tabulka → USERS panel + globus oblouky
- `f2b-ips` (F2B_IPS.py, systemd timer) → `F2B_IPS.log` → blocklist arcs; `ban_history` → COUNTRIES
- `periodic_who_collector` v `tasks.py` je ZAKÁZÁN v work módu (mazal by data z f2b-who)
- SQLite WAL mód — souběžný přístup f2b-ips + sentinel-alert bez DB lock
- TOP COUNTRIES počítá z `_attackHistory` (ban_history), ne z prázdné tabulky `attacks`

Viz `HISTORY.md` pro detailní popis oprav z 2026-05-26.

## Otevřené TODO

0. HOME — u zařízení se zaskrtnutou volbou NEW by neměl badge (NEW) svítit poté co je odškrtnut. Chci možnost označit LXC, QEMU — svítit jinou barvou vedle hostname. *(typy zařízení s barvami hotové; badge NEW dořešit)*
1. WORK — animace oblouků aktivních uživatelů se zobrazuje jen občas (vypadává).
2. Responzivita — HOME i WORK nejsou plně responzivní. *(mobile bottom bar + rolovací tabulky doplněny 2026-07; doladit prázdná místa)*
3. Globus se sekne, otáčí se trhaně. *(rAF throttling flushů + pauza při skryté záložce; sledovat)*
4. ~~Závislost na externích JS/CSS (unpkg.com)~~ — **hotovo (2026-07):** globe textury i knihovny lokálně ve `static/vendor/`, CSP bez externího CDN.

> Kompletní přehled prací z 2026-07 viz `HISTORY.md`. Aktuální roadmapa: `todo.md`.

---

## SERVICES tab

Zalozka SERVICES (dostupna pouze v HOME rezimu) umoznuje monitorovat dostupnost sluzeb, SSL certifikaty a bezpecnost HTTP odpovedi.

### Typy sluzeb
| Typ | Popis |
|---|---|
| HTTP / HTTPS | GET/POST/HEAD s kontrolou statusu, textu v tele, SSL certifikatu a security headers |
| TCP | TCP connect na zadany port |
| Ping (ICMP) | ICMP ping na IP/hostname |
| DNS | Rozliseni domeny (volitelne pres zadany DNS server) |
| Heartbeat | Push monitoring — sluzba musi pravidelne pingovat endpoint |

### Konfigurece (modal "ADD SERVICE")
- Vyber typu sluzby
- Volitelny nazev
- Pro HTTP: URL, metoda, ocekavany status, hledany text v tele, **ssl_verify** (odskrtni pro self-signed cert)
- **TEST** — spusti overeni bez ulozeni, zobrazi vysledek + security scan + doporuceni
- **+ ADD SERVICE** — ulozi a ihned zkontroluje

### Security sken (HTTP / HTTPS)
Po kliknuti TEST nebo pri zobrazeni vysledku zobrazi:
- HTTPS Redirect (pro http://)
- HSTS (Strict-Transport-Security)
- X-Frame-Options
- X-Content-Type-Options
- Content-Security-Policy
- Referrer-Policy
- Server header (verze)
- X-Powered-By
- Permissions-Policy

### API endpointy
- `GET  /api/services`              — seznam sluzeb
- `POST /api/services`              — pridani sluzby
- `DELETE /api/services/{id}`       — odstraneni
- `POST /api/services/check`        — zkontroluje vsechny
- `POST /api/services/{id}/check`   — zkontroluje jednu
- `POST /api/services/preview`      — check + security bez ulozeni (pro modal TEST)
- `GET  /api/services/settings`     — globalni interval
- `POST /api/services/settings`     — nastavi interval (1-60 min)
- `POST /api/heartbeat/{id}`        — heartbeat ping z externi sluzby

### Data
- `data/services.json`     — konfigurace sluzeb
- `data/svc_settings.json` — globalni interval

### Typy zarizeni v Network Map
- ROUTER / AP / SWITCH: sitove prvky, vizual jako obdelnik (modra), ikona dle typu
- Router s ISP Gateway: zlatave zvyrazneni, propojeni na uzel "ISP" (oblacek)
- Spojnice: ethernet (zelena), wifi (modra, carkovana), virtual/proxmox (oranzova)
