# Sentinel-Alert — TODO roadmap (30 položek)

Cíl: nádherná, moderní, sci-fi aplikace. Položky seřazené do kategorií,
u každé priorita (P1 = největší efekt/poměr práce, P3 = nice-to-have).

## UI — sci-fi vizuál

1. [x] **Theme engine** (P1) — 4 barevná schémata přes CSS variables: CYAN (současné),
   AMBER (Fallout), MATRIX (zelená), RED ALERT. Přepínač v Settings, persist v localStorage.
2. [x] **Boot sekvence** (P2) — animovaná "SYSTEM INIT" obrazovka při načtení:
   terminálový log (moduly, DB, WS handshake) s psacím efektem, přeskočitelná klávesou.
3. [x] **CRT/glitch efekty** (P3) — jemný flicker, chromatická aberace na `.ht-sentinel`
   nadpisu, glitch animace při chybě WS. Přepínatelné (PERFORMANCE MODE off/on).
4. [x] **Radar widget** (P2) — kruhový sonar do Threat Map panelu: rotující paprsek,
   ping (blip) při každém novém útoku, barva podle vektoru (ssh/http/https/f2b).
5. [x] **Animované přechody tabů** (P3) — scanline-wipe / fade při přepnutí tabu,
   respektuje `prefers-reduced-motion`.
6. [x] **SVG gauge / status ringy** (P2) — stat karty (FSC stats, PiHole block %,
   proxy TX/RX) doplnit o kruhový progress ring místo plochého čísla.
7. [x] **Toast notifikace** (P1) — sci-fi styl "◤ INCOMING — SSH BRUTE-FORCE from RU"
   vpravo dole, fronta, auto-dismiss, klik = otevře detail IP.
8. [x] **Globe upgrade** (P1) — heatmap mód (hustota útoků), pulzující ringy v cíli,
   přepínač ARCS / HEAT / POINTS, den/noc textura podle reálného UTC času.
9. [x] **Hex-grid pozadí** (P3) — jemný hexagonální pattern pod panely (CSS only),
   decentní parallax při scrollu.
10. [x] **Zvukové efekty** (P3) — volitelné (default OFF): tiché pípnutí při novém
    útoku, alarm při kritické události (host down, CVE spike). Web Audio API, bez assetů.

## UX

11. [x] **Command palette Ctrl+K** (P1) — fuzzy akce: přepnout tab, najít zařízení,
    block IP, force scan, otevřít nastavení. Jeden overlay, šipky + Enter.
12. [x] **Klávesové zkratky** (P2) — 1–6 přepínání tabů, `/` search, ESC zavře modál,
    `?` zobrazí přehled zkratek.
13. [x] **Globální search** (integrováno do palety Ctrl+K) (P2) — jedno pole prohledá zařízení, útoky (IP/země),
    služby i domény napříč taby; výsledky seskupené podle typu.
14. [x] **Persist stavu UI** (P1) — aktivní tab, filtry Attack History, rotace globusu,
    interval Services do localStorage; po reloadu se člověk vrátí, kde byl.
15. [x] **Relativní časy** (attack history; device list už měl) (P2) — všude jednotně "3m ago" s absolutním časem v title
    tooltipu (teď mix formátů mezi taby).
16. [x] **Skeleton loading** (P2) — místo prázdných panelů při startu shimmer
    placeholdery, ať layout neskáče.
17. [x] **Tooltips metrik** (P3) — vysvětlivky u GRADE, CVE/ALL, EXPOSED ROOT,
    BLOCK % … (title/data-tooltip, žádná knihovna).
18. [x] **Mobile layout** (bottom tab bar, rolovací tabulky) (P2) — bottom tab bar pod 700px, karty místo tabulek
    u FSC matrix a proxy klientů.
19. [x] **Drag&drop panelů** (P3) — přeuspořádání panelů v Threat Map gridu,
    layout persist do localStorage.
20. [x] **Help overlay** (P3) — `?` otevře průvodce: co který panel zobrazuje,
    odkud data tečou (honeypot/scanner/collector).

## Funkcionalita

21. [x] **IP intelligence karta** (P1) — klik na jakoukoli IP (globe, top attackers,
    historie) otevře modál: GeoIP + ASN, historie útoků z DB, whois, tlačítka
    ⊘ BLOCK (MikroTik) a ⧉ AbuseIPDB lookup.
22. [x] **Alerting engine** (P1) — pravidla: nové zařízení v LAN, host offline > N min,
    CVE nárůst, útok z watchlistu → toast + volitelně ntfy/Telegram webhook
    (config v `[alerts]` sekci conf).
23. [x] **Timeline replay** (P2) — time slider pod globusem: přehrání útoků za 24h
    zrychleně (1h/s), pauza, značky špiček.
24. [x] **Watchlist** (P2) — sledované IP/subnety/domény; výskyt kdekoli v UI se
    zvýrazní a vyvolá alert. CRUD v Settings.
25. [x] **Trendy 7/30 dní** (P2) — dlouhodobé grafy z alerts.db: útoky/den podle
    vektoru, srovnání s předchozím obdobím (+12 % ↑), nový panel v Threat Map.
26. [x] **Scheduled reporty** (P3) — denní/týdenní HTML security report (top útočníci,
    změny v LAN, CVE stav) generovaný na disk + odkaz v UI (rozšíření REPORT tlačítka).

## Zlepšení (výkon, kód, provoz)

27. [x] **Rozdělit script.js** (P1) — hotovo: 10 souborů v `static/js/`
    (01-globe … 10-pihole), klasické skripty načítané v pořadí (sdílený globální
    scope kvůli inline onclick handlerům), bez build stepu.
28. [x] **Výkon frontendů** (debounce historie/statistik, radar 25fps, rAF flush globusu už existoval) (P2) — batch DOM updaty přes requestAnimationFrame,
    throttling WS zpráv (max 10/s render), virtualizace dlouhých seznamů
    (attack history, DB viewer).
29. [x] **DB údržba** (P2) — retence alerts.db (config, default 90 dní), indexy na
    ip/timestamp, noční VACUUM job v tasks.py.
30. [x] **Hardening auth** (P2) — rate-limit loginu (5 pokusů / min), indikátor
    expirace session v HUD, audit log akcí (block IP, delete, config save) do DB.

---

### Doporučené pořadí (P1 vlna)

1, 7, 8, 11, 14, 21, 22, 27 — největší viditelný posun k "sci-fi command center"
+ zdravý základ kódu před dalším růstem.

Původní TODO z CLAUDE.md (MikroTik #2, Threat map #3, PiHole #5, dokumentace #7)
— vše hotovo (commity f19e239, cc01762, 5e968d0).

### Náměty do budoucna

- [x] **WebGL fallback** — hotovo: globe init v try/catch, při selhání Proxy stub
  (všechna globe.* volání no-op), v panelu 2D live feed útoků, radar (canvas 2D)
  běží dál. Ověřeno headless: bez WebGL 0 JS chyb + feed, se SwiftShader WebGL
  normální globus.

---

## Druhá vlna námětů (schváleno)

### Robustnost / kvalita
- [x] **WS reconnect s backoffem** — exponenciální backoff + jitter místo fixních 3s, re-sync snapshotu po obnově
- [x] **Health endpoint + gzip** — `/healthz` (DB, moduly, uptime) + GZip middleware na velké JSON
- [x] **Bezpečnostní hlavičky** (+ globe textury self-hosted) — CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy na všechny odpovědi
- [x] **Rozšířit testy** (22 nových: alerts/watchlist, geoip, healthz, trends, rate-limit — celkem 74) — alerts.py (watchlist IP/prefix/CIDR), geoip, trends agregace, auth rate-limit

### Funkce
- [x] **Hot zones na mapě** — červeně pulzující země s nejvíce útoky za poslední hodinu
- [x] **Export CSV/JSON** — z DB vieweru i IP intel karty
- [x] **PWA / installable** — manifest.json + service worker, offline shell
- [x] **Dashboard souhrn** — horní přehledový pruh (dnes vs. včera, top vektor, online, block %)

---

## Třetí vlna námětů (schváleno)

### Provoz / integrace
- [x] **Prometheus /metrics** — útoky podle vektoru, zařízení online, PiHole, uptime
- [x] **Backup & restore DB** — download zálohy alerts.db + noční auto-záloha s retencí
- [x] **Config self-test na startu** — ověřit PiHole/MikroTik/proxy/collector hosty, do logu + /healthz
- [x] **Browser notifikace** — native Notification API, opt-in, watchlist/host offline

### Bezpečnost / display
- [x] **2FA / TOTP login** — volitelné, QR setup v Settings, ověření po hesle
- [x] **Kiosk / auto-cycle** — cyklení tabů, skrytí ovládání, wake-lock (?kiosk)
- [x] **Anomaly alert (spike)** — detekce náhlého nárůstu útoků → toast + push
- [x] **Read-only API token** — token pro read-only /api přístup, správa v Settings

---

## Čtvrtá vlna námětů (schváleno)

### Threat intel / bezpečnost
- [x] **Threat intel blocklist import** — blocklist.de/spamhaus/FireHOL, "known bad" zvýraznění, volitelný auto-block
- [x] **GeoIP blocking (celé země)** — výběr zemí → MikroTik address-list, statistika dopadu
- [x] **Fail2ban jail management** — přehled jailů napříč hosty, unban přes SSH
- [x] **ASN / ISP breakdown** — graf útoků podle ASN/ISP

### Integrace / nasazení
- [x] **Webhook receiver** — příjem externích eventů (token), log/toast/globus
- [x] **Slack / Discord alerty** — rozšíření alerting engine
- [x] **Docker / compose** — Dockerfile + docker-compose.yml
- [x] **Grafana dashboard template** — JSON napojený na /metrics

---

## Pátá vlna — backlog (50 námětů)

Neschválené — čeká na výběr. Rozděleno do 6 kategorií.

### UI / vizuál
- [x] 1. **Attack ticker** — burzovní páska živých útoků pod HUD (scroll)
- [x] 2. **Count-up animace** — stat čísla (summary bar, FSC) se animují při změně
- [x] 3. **Konfigurovatelný dashboard** — skrýt/zobrazit jednotlivé panely (persist)
- [x] 4. **Fullscreen grafů** — každý Chart.js graf na celou obrazovku
- [x] 5. **Export grafu jako PNG** — tlačítko u každého grafu
- [x] 6. **Proxy sankey** — tok doména → backend jako sankey diagram
- [x] 7. **Výběr textury globusu** — blue marble / night / topolografie / vlastní
- [x] 8. **Světlá varianta schémat** — light mode pro AMBER/MATRIX/RED
- [x] 9. **Country timeline** — mini-graf útoků v čase v country modálu
- [x] 10. **Animovaný přechod hodnot gauge** — plynulé dojetí ringu

### UX
- [x] 11. **Bulk block** — multi-select v attack history → hromadná blokace
- [x] 12. **Undo smazání** — vrácení smazaných řádků v DB vieweru (soft delete)
- [x] 13. **Uložené filtry/pohledy** — pojmenované kombinace filtrů
- [x] 14. **Kontextové menu na IP** — pravé tlačítko: block/watch/intel/copy
- [x] 15. **Historie příkazů v palette** — poslední použité akce nahoře
- [x] 16. **Pinned akce v palette** — oblíbené akce připnout
- [x] 17. **Onboarding tour** — první spuštění: průvodce po tabech
- [x] 18. **Rychlé HOME/WORK přepnutí** — přepínač módu přímo v HUD
- [x] 19. **Klávesová navigace tabulek** — šipky + Enter v DB vieweru/matici
- [x] 20. **Drag řazení sloupců** — přeuspořádání sloupců v DB vieweru

### Analytika / data
- [ ] 21. **Heatmapa hodina×den** — kdy útoky nejvíc přicházejí
- [ ] 22. **Korelace IP napříč vektory** — jedna IP na více portech/protokolech
- [ ] 23. **Reputační skóre IP** — threat-intel + historie + ASN → 0–100
- [ ] 24. **Top cílové porty** — graf nejčastěji atakovaných portů
- [ ] 25. **"On this day"** — srovnání s minulým týdnem/měsícem
- [ ] 26. **DB statistiky** — velikost tabulek, tempo růstu, odhad zaplnění
- [ ] 27. **Session/duration analýza** — délka útočných sérií z jedné IP
- [ ] 28. **Predikce trendu** — jednoduchá projekce útoků na příští dny
- [ ] 29. **Geografický clustering** — seskupení útoků do regionů
- [ ] 30. **Export do SIEM** — CEF/LEEF formát pro Splunk/QRadar

### Integrace / feeds
- [ ] 31. **AbuseIPDB API** — lookup skóre + hlášení útočníků (s klíčem)
- [ ] 32. **VirusTotal IP lookup** — v IP intel kartě
- [ ] 33. **Shodan lookup** — otevřené porty/služby útočící IP
- [ ] 34. **GreyNoise** — rozlišení cílený útok vs. internetový šum
- [ ] 35. **E-mail alerty (SMTP)** — vedle ntfy/Telegram/Slack/Discord
- [ ] 36. **Syslog forwarding** — RFC 5424 export eventů do SIEM
- [ ] 37. **MISP feed import** — threat-intel z MISP instance
- [ ] 38. **RSS/Atom feed** — veřejný feed útoků pro čtečky
- [ ] 39. **Matrix / Rocket.Chat** — další notifikační kanály
- [ ] 40. **Alertmanager rules** — export Prometheus alert pravidel

### Bezpečnost / provoz
- [ ] 41. **Multi-user + role** — admin/viewer, oddělené účty
- [ ] 42. **OIDC / LDAP login** — SSO integrace
- [ ] 43. **Env config (12-factor)** — konfigurace přes proměnné prostředí
- [ ] 44. **Šifrování secretů v conf** — hesla/tokeny nešifrované na disku
- [ ] 45. **Obecný API rate-limit** — ne jen login, všechny endpointy
- [ ] 46. **Zálohy na S3/rsync** — offsite kopie DB
- [ ] 47. **Log rotace** — rotace app logů + strukturované logování (JSON)
- [ ] 48. **Graceful shutdown** — persist rozpracovaného stavu při restartu
- [ ] 49. **IPv6 napříč** — honeypot, blocklist, geoip plná podpora
- [ ] 50. **CVE scan scheduling** — plánovaný bezpečnostní sken hostů (cron)

### Honeypot / detekce (bonus)
- [ ] **Rozšíření portů** — FTP(21)/Telnet(23)/RDP(3389)/SMB(445) honeypoty
- [ ] **Payload capture** — co útočníci posílají (příkazy, credentials, user-agenty)
- [ ] **Deception bannery** — realistické fake služby pro delší zdržení útočníka
