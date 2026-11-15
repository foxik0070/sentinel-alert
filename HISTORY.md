# Sentinel-Alert — Change History

## 2026-11-15 — Potvrzovací dialogy a verzované skripty

### Proč služba pořád nešla smazat

Oprava z minula nepomohla, protože **požadavek vůbec neodešel**. `svcDelete()` začíná `if (!confirm(…)) return;` a nativní `confirm()` se ve vestavěných prohlížečích — Android WebView bez `onJsConfirm`, HA Companion, Fully Kiosk — **nezobrazí a vrátí `false`**. Akce tedy tiše skončí: žádný požadavek, žádná hláška. Přesně to bylo vidět.

Týkalo se to **všech 27** nativních dialogů v aplikaci (10× `confirm`, 11× `prompt`, 6× `alert`), ne jen mazání služby. Nahradily je vlastní HTML dialogy (`uiConfirm`, `uiPrompt`, `uiAlert`), které fungují všude. Funkce, které je volají, jsou nově `async`; u všech jsem ověřil, že na jejich návratové hodnotě nikdo nestaví.

### Zastaralé skripty z cache

Skripty se načítaly bez verze a statické soubory nemají `Cache-Control`, takže prohlížeč je mohl držet z heuristické cache — zařízení pak běželo na kódu z doby před opravou a vypadalo to, že oprava nefunguje.

Verze se nově vkládá do URL až při odeslání stránky (`?v=<verze>`), soubory na disku zůstávají beze změny. Název cache service workeru nese verzi taky, takže se při vydání zahodí starý shell.

Testy 158 → **161**, mezi nimi hlídač, že se nativní dialog nevrátí.

## 2026-11-15 — Přihlášení uživatelé podle clusteru

Seznam byl plochý: 61 jmen pod sebou, cluster jen jako drobné šedé písmo vpravo. Na pracovní instanci se přihlašují lidé na Karolinu, Barboru, Barboru2 i CS a nedalo se rozeznat, kdo je kde.

Uživatelé jsou nově **seskupení podle clusteru**, každá skupina má hlavičku s názvem, barevnou tečkou a počtem. Řádky nesou barevný proužek a jméno uživatele má barvu svého clusteru. Stejnou barvu dostaly i oblouky a body na globusu, takže je na první pohled vidět, odkud se kam lidé hlásí — dřív byly všechny stejné.

Pořadí skupin je pevné (Karolina, Barbora, CS, Barbora2, Karolina2), zbytek abecedně, aby skupiny mezi obnoveními neposkakovaly.

### K barvám

Paleta je **ověřená validátorem** proti tmavému podkladu, ne vybraná od oka: nejhorší sousední dvojice má pro barvosleposti ΔE 8,4 a všechny barvy mají proti podkladu kontrast ≥ 3:1. Barvy se **necyklují** — devátý cluster by jinak dostal barvu někoho jiného; spadne do neutrální „ostatní".

Identita nikdy nestojí jen na barvě: název clusteru je vždy vypsaný vedle, takže to funguje i pro barvosleposti a v tisku.

Testy 152 → **158**.

## 2026-11-15 — Service checky za přihlášením, honeypot přestal křičet

### Service check nešel smazat

Tlačítko `✕` je poslední sloupec tabulky, která má `white-space: nowrap`. Na telefonu tabulka přeteče a poslední sloupec zůstane **mimo obrazovku** — dosažitelný jen vodorovným posunem uvnitř rámečku, což na řádku, který sám reaguje na klik, nikdo netrefí.

Mazání je proto nově i v detailu služby vedle *Recheck*, kde na něj není potřeba scrollovat.

`svcDelete()` navíc výsledek ignoroval, takže neúspěch nebyl poznat. Teď hlásí rozdíl mezi „vyžaduje přihlášení", „služba už neexistuje" a jinou chybou.

### `/api/services/*` bylo bez přihlášení

Stejný případ jako `/api/fsc/*`: kdokoliv v síti mohl service checky mazat i přidávat. Osm cest zavřeno — čtení admin/viewer/token, zápis jen admin.

### Zásahy honeypotu už nejsou „high"

Honeypot je vystavený právě proto, aby ho skenery trefovaly; za jedno dopoledne 254 zásahů. Jako *high* v Sentinelu překrývaly skutečné problémy.

Běžný zásah jde nově jako `hit_severity` (výchozí **low**). Vyšší stupeň dostane jen to, kde útočník něco **dokázal** — zadané přihlašovací údaje, spuštěný příkaz, stažený payload — nebo zásah z vlastní sítě, což není běžný internetový šum. Obojí je konfigurovatelné v `[sentinel]`.

Vyžaduje Sentinel 2026.11.012 a vyšší, který `severity` v hlášení přijímá; se starším se nic nerozbije, jen se hodnota ignoruje.

### Oprava téhož ještě před nasazením do praxe

První verze brala přítomnost `payload` jako známku interakce. Jenže **payload má každý záchyt** — i holý protokolový pozdrav (`SSH-2.0-libssh_0.9.6`), takže by se jako neobvyklý označil úplně každý zásah a změna by byla k ničemu. Odhaleno kontrolou proti živé databázi, kde první zásah po nasazení vyšel jako `medium`.

Rozhoduje nově obsah: známky interakce (`wget`, `chmod`, `/bin/sh`, `base64`, …), payload delší než 200 znaků, nebo zadané údaje a příkazy. Banner a krátké HTTP pozdravy jsou běžný šum.

Testy 126 → **152**.

## 2026-11-15 — Security Center za přihlášením

`/api/fsc/*` byly přístupné bez přihlášení. `data` přitom vrací **inventář
hostů** — OS, jádro, otevřené problémy, otevřené porty a stav firewallu —
a `scan` uměl spustit sken komukoliv, kdo dosáhl na port.

Důvod, proč to tak bylo, mezitím odpadl: sken spouštěl systemd časovač přes
`POST /api/fsc/scan` bez přihlášení, takže zavření cesty by ho rozbilo. Od
`[security_center] scan_interval_minutes` (2026.11.001) si sken plánuje
aplikace sama a časovač už na instanci není.

Zavřené jsou **všechny čtyři** cesty, ne jen dvě z hlášení:

| cesta | kdo smí |
|---|---|
| `GET /api/fsc/data` | admin, viewer, read-only token |
| `GET /api/fsc/hosts` | admin, viewer, read-only token |
| `POST /api/fsc/scan` | jen admin |
| `POST /api/fsc/hosts/toggle` | jen admin |

`hosts/toggle` v hlášení nebyl, ale **mění stav** — vypnutí hosta ze skenu je
tišší způsob, jak oslepit monitoring, než spuštění skenu navíc.

Frontend se nemění; volá je stejným `fetch()` jako ostatní chráněné cesty,
takže session cookie chodí s nimi.

Testy 115 → **126**.

## 2026-11-15 — Security: aktuální stav, střízlivá závažnost, data mimo kód

### Záložka Security ukazovala stav před aktualizacemi

Skenovalo se jen ve 2:00, zatímco týdenní aktualizace OS běží v neděli ve 4:00.
Záložka tak celý den svítila stavem *před* aktualizací — ráno 28 security
alertů na 10 hostech, přitom ve 4:02 už bylo všechno nainstalované; ruční sken
vrátil nulu.

Nově `[security_center] scan_interval_minutes` (výchozí **60**). `0` zachová
původní chování, tedy jediný sken ve 2:00. Údaj „next scan" v hlavičce se řídí
stejným intervalem, aby neukazoval 02:00, když se skenuje každou hodinu.

### Závažnost podle názvu balíčku, ne podřetězce

`linux-libc-dev` se počítal jako **critical**, protože jeho název obsahuje
„linux" i „libc" — jsou to přitom jen hlavičky jádra pro kompilaci, za běhu
se nepoužívají. Stejně tak `libcares2` kvůli „libc". Z jedné aktualizace tak
vznikalo „critical CVE" na devíti kontejnerech.

Závažnost se nově určuje podle **prefixu** názvu (`classify_package()`):

| balíček | dřív | nově |
|---|---|---|
| `linux-libc-dev` | crit | med |
| `libcares2` | crit | high |
| `linux-image-*`, `proxmox-kernel-*`, `openssh-*`, `libssl*`, `libc6`, `sudo`, `bash` | crit | crit |
| `apache2-bin`, `libpq5`, `python3-*` | high/med | high |

Pořád se počítá balíček, ne CVE — čtyři balíčky Apache z jedné aktualizace jsou
dál čtyři položky.

### Běhová data a SSH klíč mimo adresář s kódem

Cesty byly natvrdo `data/` a `conf/` vedle kódu. Při běhu z gitu to nevadí, ale
instalace z balíčku má kód v `/opt`, který každý upgrade přepíše — včetně
databáze útoků, inventářů a nastavení. SSH klíč pro sken hostů by navíc ležel
vedle kódu.

Nově `[paths] data_dir` a `[scanner] ssh_key`; bez nich platí původní chování,
takže běh z gitu se nemění. Balíček data nevozí vůbec — výchozí soubory jsou
v `/usr/share/sentinel-alert/data-defaults/` a `postinst` je zkopíruje do
`/var/lib/sentinel-alert/` jen tehdy, když tam ještě nejsou.

### Testy

76 → **115**. Dřívějších „19 selhávajících testů v main" se netýkalo kódu:
chybělo `pytest-asyncio` z `requirements-dev.txt`, bez něj se async testy
neumí spustit. Po doinstalování je sada zelená.

## 2026-07-20 — šestá vlna: detekce, integrace + code-review hardening

Osm nových funkcí + oprava 9 nálezů z workflow code-review (high effort).

### Detekce / response
- **Response playbooky** (`playbooks.py`) — pravidla match(known_bad/watchlist/
  protocol/country/min_hits) → actions(block/notify/tag), `data/playbooks.json`,
  editor v paletě; vyhodnocení na každý attack/ban.
- **Honeypot session capture** — víc read kol, akumulace celé relace (4 KB),
  extrakce credentials (HTTP Basic), User-Agent, SSH klient banner.
- **JA3/TLS fingerprint** — z ClientHello (verze+ciphers+ext+curves+ecpf, GREASE
  filtr, MD5); funguje na jakémkoli portu s TLS handshake.
- **ML anomálie** — `/api/analytics/anomaly` z-score posledních 10 min vs. 7denní baseline.

### Vizualizace / integrace
- **Attack network graf** — `/api/analytics/graph` + D3 force graf IP→ISP→země.
- **PDF reporty** — HTML→PDF přes headless Chromium.
- **MQTT / Home Assistant** (`mqtt_pub.py`) — minimální QoS0 publisher (stdlib), metriky á 60 s.
- **OpenSearch/Elastic export** (`siem_export.py`) — stream útoků přes _bulk API.
- **Externí lookup** (`intel_ext.py`) — AbuseIPDB/VirusTotal/Shodan/GreyNoise.

### Code-review hardening
- viewer role nemůže číst config/full/export/backup (secrets) — `require_admin`;
  prázdné viewer heslo odmítnuto; trust-proxy header jen z privátní IP;
  API rate-limit evikce jen prošlých oken; opravy globe labelů (mobil/centroid/debounce)
  a sanitizačních regresí (AP lookup dle typu, generický domain strip). 95 testů.

---

## 2026-07-18 — pátá vlna: 53 vylepšení (6 kategorií)

Rozšíření napříč celou aplikací, commity `116a2f4` … `4822450`. Vše ověřeno
headless Chromiem (0 JS chyb), 84 pytest testy a live proti běžící službě.

### A — UI/vizuál
Attack ticker (páska živých útoků), count-up animace, konfigurovatelný dashboard
(skrytí panelů), fullscreen + PNG export grafů, proxy domain→backend flow, výběr
textury globusu (NIGHT/DAY/TOPO), světlé varianty schémat, country timeline sparkline,
animovaný gauge (@property).

### B — UX
Kontextové menu na IP (pravé tlačítko), palette historie + připnuté akce + uložené
pohledy, bulk block (BLOCK ALL + `/api/mikrotik/block-batch`), undo mazání v DB
vieweru (`/api/db/{table}/restore`), onboarding tour, HOME/WORK indikátor, klávesová
navigace tabulek, řazení sloupců.

### C — Analytika
Heatmapa hodina×den, top cílové porty, korelace IP (koordinovaní útočníci), /24 subnet
clustering (botnety), on-this-day, DB statistiky, lineární predikce útoků, reputační
skóre IP 0-100, SIEM CEF export, ANALYTICS modál.

### D — Integrace/feeds
`intel_ext.py` (AbuseIPDB/VirusTotal/Shodan/GreyNoise lookup), SMTP e-mail, Syslog
RFC 5424, Rocket.Chat webhook, MISP feed import, RSS feed (`/feed.xml`), Alertmanager
pravidla (`/alertmanager-rules.yml`).

### E — Bezpečnost/provoz
Multi-user role (viewer read-only), reverse-proxy auth trust (OIDC), env config
(12-factor `SENTINEL_<SECTION>_<KEY>` + `env:VAR` secret refs), obecný API rate-limit,
rsync offsite zálohy, strukturovaný JSON audit log s rotací, graceful shutdown,
CVE scan scheduling.

### F — Honeypot
Extra deception služby (FTP/Telnet/SMTP/RDP/SMB) s realistickými bannery, payload
capture, per-služba ošetření bind chyb.

---

## 2026-07-17 / 18 — velký sci-fi upgrade (verze 2026.07.001)

Přepracování na moderní "sci-fi command center". 18 commitů (`f19e239` … `7458ade`),
rozděleno do roadmapy a čtyř vln námětů. Vše ověřeno headless Chromiem (0 JS chyb),
84 pytest testy a live proti běžící službě i reálné síti.

### Architektura — refaktor
- **Frontend rozdělen** z jednoho `static/script.js` (4442 řádků) na 13 modulů
  `static/js/00-ui.js` … `11-ux.js` (klasické skripty načítané v pořadí, sdílený
  globální scope kvůli inline `onclick` handlerům, bez build stepu).
- **Nové backend moduly:** `alerts.py` (alerting + watchlist), `totp.py` (2FA, stdlib),
  `threatintel.py` (blocklist import). Rozšířeny `conf.py`, `collector.py`, `mikrotik.py`.
- **Globe textury self-hosted** ve `static/vendor/` (dřív unpkg.com) — offline provoz + CSP.

### Roadmapa (30 položek — UI/UX/funkce/technika)
- **Theme engine** — 4 schémata (CYAN/AMBER/MATRIX/RED ALERT), 8 accent barev, light mode.
- **Sci-fi efekty** — boot sekvence, CRT/glitch, radar widget (sonar dle azimutu/vzdálenosti
  útočníka), hex-grid, přechody tabů, volitelné Web Audio zvuky.
- **Globe** — módy ARCS/HEAT/POINTS, pulzující ringy, den/noc dle UTC, 24h timeline replay,
  hot zones (top země za poslední hodinu).
- **Toasty**, gauge ringy, persist stavu UI (tab/filtry/rotace).
- **UX** — command palette Ctrl+K s globálním hledáním, klávesové zkratky, help overlay,
  skeleton loading, relativní časy, tooltips, mobile bottom bar, drag&drop panelů.
- **Funkce** — IP intelligence karta, alerting engine (ntfy/Telegram), watchlist,
  trendy 7/30 dní, scheduled HTML reporty.
- **Technika** — DB údržba (retence/VACUUM/indexy), rate-limit loginu, audit log,
  debounce renderů, session expiry indikátor.

### CLAUDE.md TODO
- **MikroTik auto-block** (`[mikrotik] auto_block`) — f2b ban hned, honeypot/proxy po N zásazích.
- **Threat map vektorový filtr** (F2B/SSH/HTTP/HTTPS) filtruje globus i seznam.
- **PiHole** ověřeno proti reálné instanci (v6.4.3), opraveny chybové stavy.

### WebGL fallback
- Globe init v `try/catch`; při selhání Proxy stub (globe.* → no-op), 2D live feed útoků
  v panelu, radar (canvas 2D) běží dál — dashboard přežije chybějící WebGL.

### 2. vlna — robustnost & funkce
- **WS reconnect** s exponenciálním backoffem + jitter, re-sync snapshotu.
- **/healthz**, GZip middleware, bezpečnostní hlavičky (CSP/X-Frame/nosniff/Referrer).
- **Dashboard summary bar** (dnes vs. včera, top vektor, hot zone, block %).
- **Export CSV/JSON** (DB viewer + IP intel), **PWA** (manifest + service worker offline shell).
- 22 nových testů (watchlist/geoip/healthz/trends/rate-limit).

### 3. vlna — provoz & bezpečnost
- **Prometheus /metrics**, **backup DB** (+ noční auto-záloha retence 7),
  **config self-test** na startu (TCP dostupnost hostů → /healthz), **browser notifikace**.
- **Anomaly spike detekce** (≥3× baseline), **kiosk mód** (`?kiosk`, wake-lock),
  **2FA/TOTP** (RFC 6238), **read-only API token** (GET-only, ne backup/config).

### 4. vlna — threat intel & integrace
- **Threat intel import** (blocklist.de/Spamhaus/FireHOL, ☠ marker, opt-in auto-block).
- **GeoIP country blocking** (blok útočníků z vybraných zemí na MikroTik + náhled dopadu).
- **Fail2ban jail management** (jaily napříč hosty přes SSH, one-click unban).
- **ASN/ISP breakdown**, **webhook receiver**, **Slack/Discord alerty**,
  **Docker** (Dockerfile + compose), **Grafana dashboard** (`grafana-dashboard.json`).

---

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
