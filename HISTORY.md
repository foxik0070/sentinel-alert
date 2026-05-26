# Sentinel-Alert — Change History

## 2026-05-26

### Work mode — opraveny kritické chyby

#### Problémy
- **Globus malý, bez renderování** — layout race condition před přihlášením
- **TOP COUNTRIES prázdné** — i po přihlášení, přes celou šířku obrazovky
- **USERS panel vždy prázdný** — i po běhu `f2b-who`, 110 uživatelů mizelo
- **f2b-ips: "database is locked"** — selhal sync ban_history do SQLite

#### Příčiny a opravy

**1. Layout race condition — globus 280px místo full-width** (`static/script.js`)

`checkAuth()` běží asynchronně *před* `loadStatic()`. V době volání `applyAuthState(false)` je
`_workMode` ještě `false`, takže se přidá CSS třída `no-auth` (2 sloupce: `1fr 280px`).
Teprve poté `loadStatic()` přidá `work-layout` (3-sloupcový grid-area template).
Výsledek obou tříd zároveň: `yellow` (globus) skončí v 280px sloupci, `red` (countries)
bez platné oblasti → auto-placement přes celou šířku.

**Oprava:** `applyTabVisibility()` nyní explicitně odstraní `no-auth` před přidáním `work-layout`.
Po změně layoutu synchronizuje rozměry globe canvasu přes `requestAnimationFrame`.

```js
// applyTabVisibility() — work mode branch
mainGrid.classList.remove('no-auth');   // ← nový řádek
mainGrid.classList.add('work-layout');
requestAnimationFrame(() => globe.width(globeEl.clientWidth).height(globeEl.clientHeight));
```

---

**2. TOP COUNTRIES prázdné v work mode** (`static/script.js`)

`/api/stats/countries` počítá jen z tabulky `attacks`. V work módu jsou útoky v `ban_history`
(z fail2ban), tabulka `attacks` má 0 řádků → countries panel prázdný.

**Oprava:** Nová funkce `_computeCountriesFromHistory()` počítá statistiky zemí z `_attackHistory`
(sdílené pole pro bany + proxy útoky). V work módu se používá místo API odpovědi kdykoliv je
`/api/stats/countries` prázdné:

```js
function _computeCountriesFromHistory() { /* počítá z _attackHistory */ }

// v loadStatic():
const effectiveCts = (_workMode && !ctys.length) ? _computeCountriesFromHistory() : ctys;
renderCountries(effectiveCts);

// ve WS snapshot handleru:
if (_workMode) renderCountries(_computeCountriesFromHistory());
```

HOME mode není dotčen — `_workMode = false` podmínka nikdy nevyhoví.

---

**3. USERS panel vždy prázdný — `periodic_who_collector` mazal external data** (`tasks.py`)

`periodic_who_collector` v `tasks.py` spouštěl každých 60 sekund `DELETE FROM active_users`
a nahrazoval data výsledky lokálního SSH skenu (který na HPC serveru nic nenajde).
Výsledek: data zapsaná externím `f2b-who` (WHO_ISP.py, 110 uživatelů) byla smazána hned po 60 s.

**Oprava:** Interní collector se v work módu s externím WHO souborem okamžitě ukončí.
Správu `active_users` přebírá výhradně externí `f2b-who` service.

```python
# tasks.py — periodic_who_collector()
if conf.MODE_TYPE.strip().lower() == 'work' and conf.MODE_WHO_FILE:
    return  # active_users managed externally by WHO_ISP.py
```

HOME mode není dotčen — `MODE_TYPE = 'home'` podmínka nevyhoví.

---

**4. f2b-ips: "database is locked"** (`db_init.py`)

`f2b-ips` (F2B_IPS.py) se pokoušel zapsat do `ban_history` ve stejný okamžik kdy
`sentinel-alert` držel write lock (periodic scan, broadcast). SQLite bez WAL módu
neuměl přístupy paralelizovat.

**Oprava:** SQLite spuštěn v WAL módu s timeoutem 30 s. WAL umožňuje souběžné čtení
i při probíhajícím zápisu a výrazně snižuje lock contention.

```python
# db_init.py — init()
conn = sqlite3.connect(DB_PATH, timeout=30)
conn.execute("PRAGMA journal_mode=WAL")
```

---

**5. CSS — work-layout pro tablet a mobil** (`static/style.css`)

Chyběly `@media` pravidla pro `work-layout` při šířkách ≤1100px a ≤640px.
Přidány 2-sloupcový tablet layout a 1-sloupcový mobilní layout pro work mode.

---

#### Ověření HOME mode

| Změna | HOME mode |
|-------|-----------|
| `tasks.py` guard | `MODE_TYPE = 'home'` → podmínka nevyhoví, collector běží normálně |
| `db_init.py` WAL | Bezpečné pro oba módy, jen zlepšuje souběžnost |
| `script.js` — layout | `else` větev `applyTabVisibility` nedotčena |
| `script.js` — countries | `_workMode = false` → `effectiveCts = ctys` (původní chování) |
| `script.js` — WS handler | `if (_workMode)` guard, home přeskočí |
| `style.css` | `work-layout` třída v home módu nikdy nevzniká |

---

#### Architektura work módu (HPC)

```
f2b-who (WHO_ISP.py)    →  active_users table  →  /api/active_users  →  USERS panel + globus oblouky
f2b-ips (F2B_IPS.py)    →  F2B_IPS.log         →  /api/blocklist     →  globus oblouky (blocklist)
                        →  ban_history table    →  /api/bans          →  globus oblouky + COUNTRIES
sentinel-alert          →  (čte, nemazat)
periodic_who_collector  →  ZAKÁZÁN v work módu (mazal by external data)
```

Systemd timery: `f2b-who.timer`, `f2b-ips.timer` — spouští WHO_ISP.py a F2B_IPS.py
z `/root/sentinel-user/git/`.

---

## 2026-05 (předchozí)

### Service Monitor
- HTTP/HTTPS, TCP, Ping, DNS, Heartbeat monitoring
- SSL certifikáty, security headers scan
- Sparkline grafy, uptime 24h/30d
- Dostupné pouze v HOME módu

### Network Map
- D3.js force-directed topology
- Typy uzlů: router, switch, AP, LXC, QEMU, NAS, server, RPi, mobile, TV, printer, IoT, PC
- ISP Gateway s cloud uzlem
- Ethernet / WiFi / virtual spojnice

### Bezpečnostní centrum
- SSH audit hostů z `/etc/hosts`
- CVE, EOL, firewall, fail2ban, root SSH, LXC/VM detekce

### Sentinel Bridge
- Přeposílání eventů na centrální Sentinel server
- Heartbeat každých 60 s

### Honeypot
- Fake SSH (port 2222) a HTTP (port 8080/8888)
- GeoIP obohacení, live stream přes WebSocket
