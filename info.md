0. HOME - lokalni sken site pokud ma zaskrnoto NEW, nesviti vedle hostname (NEW), kdyz odskrtnu ze neni NEW, pak vedle hostname nebude nic jineho nez IP adresa. Navic chci u zarizeni moznost zaskrnout LXC, QEMU a to bude taky pak svitit jinou barvou vedle hostname.
1. WORK - ma stale problemy, ma neustale prazdnou tabulku TOP COUNTRIES a vraci No attacks yet. Attack history a vizualizace na globusu utoku funguje. Ale jak koukam do DB v UI, tak jsou zaznamy jen v BAN HISTORY. Misto Devices by melo by USERS. 
2. WORK - USER tabulka je OK, ale neustale vypadava animace z mista pripojeni na misto pripojeni, objevuje se jen obcas...
3. Respozitivita, HOME i WORK nejsou responivni, bud se nevyplni cela obrazovka, nebo je cast obrazovky prazdna, nebo jsou prvky pres sebe a dokonce i SENTINEL ALERT logo prekryva jine prvky.
4. Globus se seka, otaci se trhane
5. Zavislost na externich javascriptech a style je nevhodna, predelat vse na lokalni

---

## SERVICES tab (domain monitoring)

Zalozka SERVICES (dostupna pouze v HOME rezimu, ve WORK rezimu je skryta) umoznuje monitorovat dostupnost domen a platnost SSL certifikatu.

### Funkce
- Pridani domeny ve formatu `http://example.com` nebo `https://example.com`
- Rucni overeni vsech domen tlacitkem CHECK ALL
- Pro HTTP: meri dobu odezvy a HTTP status kod
- Pro HTTPS: navic overuje SSL certifikat (platnost, vydavatel, SAN, pocet dni do expirace)

### API endpointy
- `GET  /api/domains`         — seznam domen
- `POST /api/domains`         — pridani domeny ({"url": "https://example.com"})
- `DELETE /api/domains/{idx}` — odstraneni domeny podle indexu
- `POST /api/domains/check`   — spusti kontrolu vsech domen (async, vraci vysledky)

### Data
- Ulozeno v `data/domains.json`
- Vytvori se automaticky pri instalaci (setup.sh)

### Typy zarizeni v Network Map
- ROUTER / AP / SWITCH: sitove prvky, vizual jako obdelnik (modra), ikona dle typu
- Router s ISP Gateway: zlatave zvyrazneni, propojeni na uzel "ISP" (oblacek)
- Spojnice: ethernet (zelena), wifi (modra, carkovana), virtual/proxmox (oranzova)
