"Chci transformovat tento projekt (sentinel-alert-claude) na komplexni nastroj pro monitoring site a honeypot vizualizaci.

Cilem je:

Scanner/Collector: Rozsirit scanner.py a collector.py o funkcionalitu Pi.Alert (scan site, ARP, monitorovani dostupnosti sluzeb, detekce DHCP, udrzovani stavu zarizeni v DB).

Honeypot: Implementovat modul pro zachytavani utoku (podobne jako Knock-Knock: SSH, HTTP, atd.) a logovani do SQLite.

Frontend: V static/ vybudovat moderni dashboard (FastAPI backend v app.py):

Interaktivni mapa site (vizualizace hostu, online/offline, detail zarizeni).

Honeypot dashboard (zive streamovani utoku pres WebSockets, globalni mapa, statistiky zemi/IP).

Sentinel Integration: Tento nastroj pobezi samostatne na portu 5056 a bude posilat kllicove eventy do hlavni instance 'Sentinel' (priprav rozhrani pro tento export).

Projdi si moje soubory (app.py, scanner.py, collector.py, static/) a navrhni mi, jakou strukturu zvolit, aby to bylo udrzitelne a modularni. Zacni tim, ze mi reknes, jake knihovny budeme potrebovat pro frontendovou vizualizaci (napr. D3.js, Leaflet, nebo Three.js pro 3D globus) a jak upravime FastAPI pro WebSocket streaming."

2. Krok: Iterativni vyvoj (Prace po modulech)
Jakmile ti Claude navrhne strukturu, nedavej mu vse najednou. Postupuj podle tohoto poradi:

Iterace 1 (Data): "Uprav db_init.py a databazove schema, aby zvladlo jak inventar site (zarizeni, MAC, IP), tak logy z honeypotu (utoky, geodata, protokoly)."

Iterace 2 (Scanner): "Implementuj do scanner.py funkci pro pravidelny scan (arp-scan) a ukladani stavu do DB (status online/offline)."

Iterace 3 (WebSocket): "Uprav app.py (FastAPI), aby poskytovalo WebSocket endpoint pro live streamovani utoku z honeypotu do prohlizece."

Iterace 4 (Vizualizace): "Vytvor v static/script.js logiku pro prijem WebSocket dat a jejich zobrazeni v index.html. Pouzij [vybranou knihovnu] pro interaktivni mapu zarizeni."
