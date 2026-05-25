0. HOME - lokalni sken site pokud ma zaskrnoto NEW, nesviti vedle hostname (NEW), kdyz odskrtnu ze neni NEW, pak vedle hostname nebude nic jineho nez IP adresa. Navic chci u zarizeni moznost zaskrnout LXC, QEMU a to bude taky pak svitit jinou barvou vedle hostname.
1. WORK - ma stale problemy, ma neustale prazdnou tabulku TOP COUNTRIES a vraci No attacks yet. Attack history a vizualizace na globusu utoku funguje. Ale jak koukam do DB v UI, tak jsou zaznamy jen v BAN HISTORY. Misto Devices by melo by USERS. 
2. WORK - USER tabulka je OK, ale neustale vypadava animace z mista pripojeni na misto pripojeni, objevuje se jen obcas...
3. Respozitivita, HOME i WORK nejsou responivni, bud se nevyplni cela obrazovka, nebo je cast obrazovky prazdna, nebo jsou prvky pres sebe a dokonce i SENTINEL ALERT logo prekryva jine prvky.
4. Globus se seka, otaci se trhane
5. Zavislost na externich javascriptech a style je nevhodna, predelat vse na lokalni

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
