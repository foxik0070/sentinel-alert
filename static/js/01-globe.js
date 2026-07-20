// 01-globe.js — Threat Map: 3D globus, oblouky, země, attack card
// Sentinel-Alert dashboard

const $ = id => document.getElementById(id);

// Solo globe mode: ?solo=globe hides everything except the globe panel
const _SOLO_GLOBE = new URLSearchParams(location.search).get('solo') === 'globe';
if (_SOLO_GLOBE) {
    const style = document.createElement('style');
    style.textContent = `
        header, .grid > :not(#globe-panel) { display: none !important; }
        body { overflow: hidden; background: #000; }
        .grid { display: block !important; height: 100vh !important; margin: 0 !important; padding: 0 !important; }
        #globe-panel { height: 100vh !important; width: 100vw !important;
                       border: none !important; border-radius: 0 !important;
                       position: relative !important; }
        #globe-panel .ph { background: rgba(2,10,14,0.7) !important; }
        .globe-legend { opacity: 0.85 !important; pointer-events: auto !important; }
    `;
    document.head.appendChild(style);
}
const globeEl    = $('globe-viz');
const netListEl  = $('net-list');
const netCountEl = $('net-count');
const attackHistEl = $('attack-hist');
const countryListEl = $('country-list');
const ctyCountEl = $('cty-count');
const logListEl  = $('log-list');
const logCountEl = $('log-count');
const wsStatusEl = $('ws-status');
const hudLan     = $('hud-lan');
const hudAttacks = $('hud-attacks');
const hudClock   = $('hud-clock');
const hudHome    = $('hud-home');
const hudSentinel = $('hud-sentinel');
const acHomeIp   = null;
const globeModeEl = $('globe-mode');
const card       = $('attack-card');
const acIp       = $('ac-ip');
const acCountry  = $('ac-country');
const acIsp      = $('ac-isp');
const acVec      = $('ac-vec');
const acHits     = $('ac-hits');

$('ac-copy')?.addEventListener('click', () => {
    const ip = acIp?.textContent;
    if (!ip || ip.includes('-')) return;
    navigator.clipboard?.writeText(ip).then(() => {
        const btn = $('ac-copy');
        if (btn) { btn.textContent = '✓'; setTimeout(() => { btn.textContent = '⎘'; }, 1200); }
    });
});

let HOME = { lat: 49.8209, lon: 18.2625 };
let attackCount = 0;
const MAX_ARCS = 300, MAX_PTS = 300, MAX_LABELS = 50, MAX_FEED = 10;
let _globePaused = false, _histPaused = false;
let _countryCounts = new Map(); // country → attack arc count (for stroke width)

let _globeViewMode = UIState.get('globe-view', 'arcs'); // arcs | heat | points

function _globeFlush() {
    // Vector filter (ALL/F2B/SSH/HTTP/HTTPS) filtruje i globus — threat map
    // se zaměří na zvolený typ útoku; user session arcs zůstávají vždy.
    const f = (typeof _attackHistFilter !== 'undefined') ? _attackHistFilter : 'all';
    const atkArcs = f === 'all' ? arcs : arcs.filter(a => (a.protocol || 'fail2ban') === f);
    const atkPts  = f === 'all' ? points : points.filter(p => (p.protocol || 'fail2ban') === f);
    const allArcs = [...atkArcs, ...userArcs];
    _countryCounts = new Map();
    allArcs.forEach(a => {
        if (a.country && a.protocol !== 'who')
            _countryCounts.set(a.country, (_countryCounts.get(a.country) || 0) + 1);
    });
    const hex = typeof globe.hexBinPointsData === 'function';
    if (_globeViewMode === 'heat' && hex) {
        globe.arcsData([...userArcs]);
        globe.hexBinPointsData([...atkPts]);
        globe.pointsData([...homePoints, ...userPoints]);
    } else if (_globeViewMode === 'points' || _globeViewMode === 'heat') {
        globe.arcsData([...userArcs]);
        if (hex) globe.hexBinPointsData([]);
        globe.pointsData([...atkPts, ...homePoints, ...userPoints]);
    } else {
        globe.arcsData(allArcs);
        if (hex) globe.hexBinPointsData([]);
        globe.pointsData([...atkPts, ...homePoints, ...userPoints]);
    }
    globe.labelsData([...labels]);
}

// Lightweight arc-only refresh — for periodic recolor (avoids re-uploading points/labels)
function _globeFlushArcsOnly() {
    const f = (typeof _attackHistFilter !== 'undefined') ? _attackHistFilter : 'all';
    const atkArcs = f === 'all' ? arcs : arcs.filter(a => (a.protocol || 'fail2ban') === f);
    globe.arcsData([...atkArcs, ...userArcs]);
}

// Throttled flush — coalesces rapid calls into one per animation frame
let _flushScheduled = false;
function _scheduleGlobeFlush() {
    if (_flushScheduled || _globePaused) return;
    _flushScheduled = true;
    requestAnimationFrame(() => { _flushScheduled = false; if (!_globePaused) _globeFlush(); });
}

const arcs = [], points = [], labels = [], rings = [];
const userArcs = [], userPoints = [];
const arcTimestamps = []; // track arc creation time for age-based coloring
const homeRings = [];   // permanent target indicator
const homePoints = [];  // permanent target dot
const hotRings = [];     // pulzující "hot zones" — země s nejvíce útoky za 1h

function _allRings() { return [...rings, ...homeRings, ...hotRings]; }

let _countriesGeo = null;
let _countryAttackMap = {};
let _lastCfg = {};

// Textury self-hosted (dřív unpkg.com) — offline provoz + CSP bez externího CDN
const TX_NIGHT = '/static/vendor/earth-night.jpg';
const TX_DAY   = '/static/vendor/earth-blue-marble.jpg';
const TX_TOPO  = '/static/vendor/earth-topology.png';
const TX_LIST  = [
    { name: 'NIGHT', url: TX_NIGHT },
    { name: 'DAY',   url: TX_DAY },
    { name: 'TOPO',  url: TX_TOPO },
];

let _manualDay = UIState.get('globe-day', null); // null = auto (time-based), true/false = user override
let _texIdx = UIState.get('globe-tex', null);    // null = auto den/noc; jinak index do TX_LIST

function pickTexture() {
    if (_texIdx !== null && TX_LIST[_texIdx]) {
        globeModeEl.textContent = TX_LIST[_texIdx].name;
        return TX_LIST[_texIdx].url;
    }
    const autoDay = new Date().getHours() >= 7 && new Date().getHours() < 19;
    const isDay = _manualDay !== null ? _manualDay : autoDay;
    globeModeEl.textContent = isDay ? 'DAY' : 'NIGHT';
    return isDay ? TX_DAY : TX_NIGHT;
}

const _isMobile = window.innerWidth <= 1100;

// ── WebGL fallback ────────────────────────────────────────────────
// Bez WebGL kontextu (staré/headless prohlížeče) globe init vyhodí výjimku.
// Stub udělá ze všech globe.* volání no-op, dashboard běží dál a v panelu
// se místo globusu zobrazí 2D live feed útoků (radar je canvas 2D — funguje).
let GLOBE_OK = true;

function _makeGlobeStub() {
    const stub = new Proxy(function () {}, {
        get: (_t, prop) => {
            if (prop === 'controls') return () => ({});
            return () => stub;
        },
        apply: () => stub,
    });
    return stub;
}

function _globeFallbackInit() {
    globeEl.innerHTML = `
        <div id="globe-fallback">
            <div class="gf-title">◤ WEBGL UNAVAILABLE</div>
            <div class="gf-sub">3D globus vyžaduje WebGL — zobrazuji 2D live feed. Statistiky běží v okolních panelech.</div>
            <div id="gf-feed"></div>
        </div>`;
    ['globe-rotate-btn', 'globe-view-btn', 'globe-replay-btn', 'globe-mode'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
}

function _globeFallbackPush(a) {
    const feed = document.getElementById('gf-feed');
    if (!feed) return;
    const row = document.createElement('div');
    row.className = 'gf-row';
    const proto = document.createElement('span');
    proto.style.color = PROTO_COLOR[a.protocol] || 'var(--accent)';
    proto.style.fontWeight = '700';
    proto.textContent = (a.protocol || '?').toUpperCase();
    const ip = document.createElement('span');
    ip.className = 'gf-ip';
    ip.textContent = a.src_ip || '?';
    const meta = document.createElement('span');
    meta.className = 'gf-meta';
    meta.textContent = `${a.country || '?'}${a.isp ? ' · ' + a.isp : ''}`;
    row.append(proto, ip, meta);
    feed.prepend(row);
    while (feed.children.length > 14) feed.lastChild.remove();
}

function _initGlobe() {
    return Globe()(globeEl)
    .globeImageUrl(pickTexture())
    .backgroundColor('rgba(0,0,0,0)')
    .showAtmosphere(!_isMobile)
    .atmosphereColor('#00ffd5')
    .atmosphereAltitude(0.22)
    .width(globeEl.clientWidth)
    .height(globeEl.clientHeight)
    .arcsData(arcs)
    .arcStartLat(d => d.startLat).arcStartLng(d => d.startLng)
    .arcEndLat(d => d.endLat).arcEndLng(d => d.endLng)
    .arcColor(d => d.color)
    .arcStroke(d => d.protocol === 'who' ? 0.4 : 0.7)
    .arcDashLength(d => {
        if (d.protocol === 'who') return 0.3;
        const n = _countryCounts.get(d.country) || 1;
        return n <= 1 ? 1.0 : 0.25; // solid arc when only 1 attack from country
    })
    .arcDashGap(d => {
        if (d.protocol === 'who') return 0.7;
        const n = _countryCounts.get(d.country) || 1;
        return n <= 1 ? 0.0 : 0.75;
    })
    .arcDashInitialGap(d => d.phase)
    .arcDashAnimateTime(d => {
        if (d.protocol === 'who') return 1400;
        // solid (dashLen=1, dashGap=0) arcs look static regardless of animateTime,
        // but 0 avoids unnecessary GPU work for single-country arcs
        const n = _countryCounts.get(d.country) || 1;
        if (n <= 1) return 0;
        const base = _isMobile ? 3000 : 2400;
        const minMs = _isMobile ? 800 : 350;
        return Math.max(minMs, Math.round(base / Math.log2(n + 2)));
    })
    .arcAltitudeAutoScale(0.75)
    .arcsTransitionDuration(0)
    .pointsTransitionDuration(0)
    .pointsData([...points, ...homePoints])
    .pointLat(d => d.lat).pointLng(d => d.lon)
    .pointColor(d => d.color)
    .pointAltitude(d => d.alt ?? 0.01)
    .pointRadius(d => d.radius ?? 0.3)
    .pointLabel(d => d.isHome
        ? `<b>HOME</b><br>${HOME.ip || '—'}<br>${HOME.country || '?'} · ${HOME.isp || '?'}`
        : d.protocol === 'who'
            ? `<b>${d.username}</b><br>${d.ip}<br>${d.country} · ${d.node}`
            : `<b>${d.src_ip}</b><br>${d.country} · ${d.isp || '?'}<br>:${d.dst_port}/${d.protocol}`)
    .labelsData(labels)
    .labelLat(d => d.lat).labelLng(d => d.lon)
    .labelText(d => d.count ? `${d.country} (${d.count})` : d.country)
    .labelSize(d => d.count ? Math.min(1.4, 0.7 + Math.log10(d.count + 1) * 0.4) : 0.45)
    .labelDotRadius(d => d.count ? 0.3 : 0.12)
    .labelColor(d => d.quiet ? 'rgba(120,190,150,0.55)' : '#ffe322')
    .labelResolution(2)
    .ringsData(_allRings())
    .ringLat(d => d.lat).ringLng(d => d.lon)
    .ringColor(d => d.color || (t => `rgba(255,42,94,${1 - t})`))
    .ringMaxRadius(d => d.maxR ?? 4)
    .ringPropagationSpeed(d => d.speed ?? 2)
    .ringRepeatPeriod(d => d.period ?? 800)
    .onPointClick((pt) => {
        if (!pt || pt.isHome) return;
        acIp.textContent      = pt.src_ip || '?';
        acCountry.textContent = pt.country || '?';
        acIsp.textContent     = pt.isp || '—';
        acVec.textContent     = `:${pt.dst_port}/${(pt.protocol||'').toUpperCase()}`;
        if (acHits) acHits.textContent = (_ipCounts.get(pt.src_ip) || 1) + '×';
        card.classList.add('hot');
        clearTimeout(pushAttack._t);
        pushAttack._t = setTimeout(() => card.classList.remove('hot'), 10000);
        centerGlobeOn(pt.lat, pt.lon);
    })
    .onArcClick((arc) => {
        if (!arc) return;
        acIp.textContent      = arc.src_ip || '?';
        acCountry.textContent = arc.country || '?';
        acIsp.textContent     = arc.isp || '—';
        acVec.textContent     = `:${arc.dst_port}/${(arc.protocol||'').toUpperCase()}`;
        if (acHits) acHits.textContent = (_ipCounts.get(arc.src_ip) || 1) + '×';
        card.classList.add('hot');
        clearTimeout(pushAttack._t);
        pushAttack._t = setTimeout(() => card.classList.remove('hot'), 10000);
        centerGlobeOn(arc.startLat, arc.startLng);
    });
}

let globe;
try {
    globe = _initGlobe();
} catch (e) {
    console.warn('WebGL unavailable — globe fallback active:', e);
    GLOBE_OK = false;
    globe = _makeGlobeStub();
    _globeFallbackInit();
}

globe.controls().autoRotate = true;
globe.controls().autoRotateSpeed = 0.8;
globe.controls().enableDamping = true;

// Restore persisted rotation state (default: on)
if (UIState.get('globe-rotate', true) === false) _setRotation(false);

// Restore autoRotate when mouse leaves the globe panel (OrbitControls may pause it during interaction)
globeEl.addEventListener('mouseleave', () => {
    if (!_rotationLocked) globe.controls().autoRotate = true;
});

window.addEventListener('resize', () => {
    globe.width(globeEl.clientWidth).height(globeEl.clientHeight);
});
if (_SOLO_GLOBE) {
    const _soloResize = () => {
        globe.width(globeEl.clientWidth).height(globeEl.clientHeight);
    };
    setTimeout(_soloResize, 50);
    window.addEventListener('resize', _soloResize);
}

// Refresh texture every 15 min (auto mode covers day/night transition).
setInterval(() => { if (_manualDay === null) globe.globeImageUrl(pickTexture()); }, 15 * 60 * 1000);

// Pause globe when browser tab is hidden (GPU + battery savings)
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        globe.pauseAnimation();
        _globePaused = true;
    } else if (_activeTab === 'threat') {
        globe.resumeAnimation();
        _globePaused = false;
        _globeFlush();
    }
});

globeModeEl.title = 'Cyklit texturu: NIGHT → DAY → TOPO → AUTO';
globeModeEl.addEventListener('click', () => {
    // cyklus: (auto) → NIGHT(0) → DAY(1) → TOPO(2) → auto
    if (_texIdx === null) _texIdx = 0;
    else if (_texIdx >= TX_LIST.length - 1) _texIdx = null;
    else _texIdx++;
    _manualDay = null;
    UIState.set('globe-tex', _texIdx);
    UIState.set('globe-day', null);
    globe.globeImageUrl(pickTexture());
});

// Protocol colors [r,g,b] at full brightness — age dims them
// Warm tones = attacks/threats; cool cyan = active users
const PROTO_RGB = {
    ssh:      [255, 190,   0],  // amber  — SSH brute-force
    http:     [255, 110,   0],  // orange — HTTP web attack
    https:    [230,   0,  60],  // crimson — HTTPS web attack
    fail2ban: [210,  40, 255],  // magenta-purple — Fail2Ban ban
    blocked:  [120,  20, 200],  // dark purple — blocked IP
    who:      [  0, 200, 200],  // cyan — active user session
    // honeypot deception služby (kat. F)
    ftp:      [ 46, 255, 161],  // spring green — FTP
    telnet:   [ 56, 189, 248],  // sky blue — Telnet
    smtp:     [255, 105, 180],  // hot pink — SMTP
    rdp:      [148, 130, 255],  // periwinkle — RDP
    smb:      [255, 232,  59],  // yellow — SMB
    webhook:  [  0, 255, 213],  // teal — externí webhook event
};
const _DEFAULT_RGB = [0, 220, 180];  // teal fallback

// CSS hex colors matching PROTO_RGB — used in panels so colors match the globe
const PROTO_COLOR = {
    ssh:      '#ffbe00',
    http:     '#ff6e00',
    https:    '#e6003c',
    fail2ban: '#d228ff',
    blocked:  '#7814c8',
    who:      '#00c8c8',
    ftp:      '#2effa1',
    telnet:   '#38bdf8',
    smtp:     '#ff69b4',
    rdp:      '#9482ff',
    smb:      '#ffe83b',
    webhook:  '#00ffd5',
};

const MAX_AGE_S = 24 * 3600;

function getArcColor(protocol, ageSeconds) {
    const ageFactor = Math.min(ageSeconds / MAX_AGE_S, 1.0);
    const alpha1 = Math.max(0.9 - ageFactor * 0.55, 0.15);
    const alpha2 = Math.max(alpha1 - 0.2, 0.05);
    const [r, g, b] = PROTO_RGB[protocol] || _DEFAULT_RGB;
    return [
        `rgba(${r},${g},${b},${alpha1.toFixed(2)})`,
        `rgba(${r},${g},${b},${alpha2.toFixed(2)})`,
    ];
}

let _rotationLocked = false; // true = user manually stopped rotation

function _setRotation(on) {
    _rotationLocked = !on;
    UIState.set('globe-rotate', on);
    globe.controls().autoRotate = on;
    const btn = $('globe-rotate-btn');
    if (btn) {
        btn.textContent = on ? '⟳ ROT' : '⏸ ROT';
        btn.style.background = on ? 'var(--accent)' : '#4d7479';
        btn.style.color = '#0a1a1e';
    }
}

function centerGlobeOn(lat, lon) {
    globe.controls().autoRotate = false;
    globe.pointOfView({ lat, lng: lon, altitude: 1.4 }, 900);
    clearTimeout(centerGlobeOn._resumeTimer);
    // Only auto-resume if user hasn't manually locked rotation off
    centerGlobeOn._resumeTimer = setTimeout(() => {
        if (!_rotationLocked) globe.controls().autoRotate = true;
    }, 6000);
}

function _polyName(d) {
    const p = d.properties;
    return p.ADMIN || p.NAME || p.name || '';
}

// GeoIP DB names → Natural Earth GeoJSON ADMIN names
const COUNTRY_NORM = {
    'United States':   'United States of America',
    'The Netherlands': 'Netherlands',
    'Russia':          'Russia',
};

let _polyRefreshTimer = null;
let _countryCentroids = {};   // name → {lat, lon} pro umístění názvu na globusu

function refreshCountryPolygons() {
    _countryAttackMap = {};
    _attackHistory.forEach(a => {
        if (!a.country || a.country === '?' || a.country === 'Unknown') return;
        const key = COUNTRY_NORM[a.country] || a.country;
        if (!_countryAttackMap[key]) _countryAttackMap[key] = [];
        _countryAttackMap[key].push(a);
    });
    _updateCountryLabels();
    // Debounce — each polygonsData() call rebuilds all meshes, causing a flash.
    // Long delay keeps it rare; color functions read from _countryAttackMap live.
    clearTimeout(_polyRefreshTimer);
    _polyRefreshTimer = setTimeout(() => {
        if (_countriesGeo && !_globePaused) globe.polygonsData(_countriesGeo);
    }, 1000);
}

// Trvalé názvy zemí na globusu: útočící výrazně (žlutě, s počtem útoků),
// neútočící tlumeně zeleně. labelColor/labelSize rozliší přes flag `count`.
let _labelsAllCountries = UIState.get('globe-labels-all', true); // všechny země vs. jen útočící
function _updateCountryLabels() {
    labels.length = 0;
    // útočící země — výrazné popisky s počtem
    for (const [name, hits] of Object.entries(_countryAttackMap)) {
        const c = _countryCentroids[name];
        if (!c) continue;
        const a = hits[0];
        labels.push({ lat: c.lat, lon: c.lon, country: name, count: hits.length,
                      src_ip: a.src_ip, isp: a.isp, protocol: a.protocol });
    }
    // neútočící země — tlumené názvy pro orientaci (volitelné)
    if (_labelsAllCountries) {
        for (const [name, c] of Object.entries(_countryCentroids)) {
            if (_countryAttackMap[name]) continue; // útočící už přidané
            labels.push({ lat: c.lat, lon: c.lon, country: name, count: 0, quiet: true });
        }
    }
    if (!_globePaused) globe.labelsData([...labels]);
}

// Centroid GeoJSON geometrie (průměr vrcholů — dost přesné pro umístění popisku)
function _geoCentroid(geometry) {
    let sx = 0, sy = 0, n = 0;
    const walk = (coords, depth) => {
        if (depth > 0) { coords.forEach(c => walk(c, depth - 1)); return; }
        // coords = [lon, lat]
        sx += coords[0]; sy += coords[1]; n++;
    };
    try {
        if (geometry.type === 'Polygon') geometry.coordinates.forEach(ring => walk(ring, 1));
        else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(poly => poly.forEach(ring => walk(ring, 1)));
    } catch { return null; }
    return n ? { lat: sy / n, lon: sx / n } : null;
}

async function loadCountryPolygons() {
    if (!GLOBE_OK) return;     // fallback mód — bez WebGL nemá smysl stahovat geojson
    if (_countriesGeo) return; // already loaded, skip
    if (window.innerWidth <= 700) return;  // skip jen na opravdových mobilech
    try {
        const geo = await fetch('/static/vendor/countries.geojson').then(r => r.json());
        _countriesGeo = geo.features;
        // Předpočítej centroidy pro umístění názvů zemí na globusu
        _countryCentroids = {};
        _countriesGeo.forEach(f => {
            const c = _geoCentroid(f.geometry);
            if (c) _countryCentroids[_polyName(f)] = c;
        });
        globe
            .polygonsData(_countriesGeo)
            .polygonGeoJsonGeometry(d => d.geometry)
            .polygonAltitude(d => _countryAttackMap[_polyName(d)] ? 0.026 : 0.02)
            .polygonCapColor(d => {
                const hits = _countryAttackMap[_polyName(d)];
                // neútočící = zřetelně zelená; útočící = červená sílící s počtem
                if (!hits) return 'rgba(0,200,90,0.45)';
                const intensity = Math.min(0.88, 0.45 + hits.length * 0.05);
                return `rgba(235,25,55,${intensity.toFixed(2)})`;
            })
            .polygonSideColor(() => 'rgba(0,0,0,0)')
            .polygonStrokeColor(d => {
                const hits = _countryAttackMap[_polyName(d)];
                return hits ? 'rgba(255,60,40,1)' : 'rgba(0,220,100,0.65)';
            })
            .polygonLabel(d => {
                const name = _polyName(d);
                const hits = _countryAttackMap[name] || [];
                if (!hits.length) return `<div style="background:rgba(2,10,14,0.92);padding:5px 9px;border:1px solid #1a4046;font-size:11px;color:#4d7479;">${name}</div>`;
                const ipMap = {};
                hits.forEach(h => { if (h.src_ip) ipMap[h.src_ip] = (ipMap[h.src_ip]||0)+1; });
                const topIPs = Object.entries(ipMap).sort((a,b)=>b[1]-a[1]).slice(0,5);
                return `<div style="background:rgba(2,10,14,0.95);padding:6px 10px;border:1px solid #ff2a5e;font-size:11px;color:#cfe7ec;line-height:1.8;">
                    <b style="color:#ff2a5e;">${name}</b>&nbsp;<span style="color:#4d7479;">${hits.length} hit${hits.length!==1?'s':''} — click for details</span><br>
                    ${topIPs.map(([ip,cnt])=>`<span style="color:#ffe83b;">${ip}</span>&nbsp;<span style="color:#4d7479;font-size:10px;">×${cnt}</span>`).join('<br>')}
                </div>`;
            })
            .onPolygonClick(d => {
                if (!d) return;
                _openCountryModal(_polyName(d));
            });
        // Přebarvi hned podle už načtených útoků (mapa mohla vzniknout dřív než geojson)
        refreshCountryPolygons();
    } catch(e) {
        console.warn('countries.geojson unavailable:', e);
    }
}

function _openCountryModal(name) {
    const hits = _countryAttackMap[name] || [];
    if (!hits.length) return;
    const ipMap = {};
    hits.forEach(h => { if (h.src_ip) ipMap[h.src_ip] = (ipMap[h.src_ip]||0)+1; });
    const sorted = Object.entries(ipMap).sort((a,b)=>b[1]-a[1]);

    $('cmod-title').textContent = name.toUpperCase();
    $('cmod-stats').innerHTML = `${hits.length} attack${hits.length!==1?'s':''} from ${sorted.length} unique IP${sorted.length!==1?'s':''}`
        + _countrySparkline(hits);
    $('cmod-list').innerHTML = sorted.map(([ip, cnt]) => {
        const col = PROTO_COLOR[(_attackHistory.find(a=>a.src_ip===ip)||{}).protocol||'fail2ban'] || '#d228ff';
        return `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:#02060a;border:1px solid #14333a;border-radius:2px;">
            <span style="flex:1;font-family:monospace;font-size:12px;color:#ffe83b;">${ip}</span>
            <span style="color:#4d7479;font-size:11px;min-width:28px;text-align:right;">×${cnt}</span>
            <button onclick="navigator.clipboard?.writeText('${ip}');this.textContent='✓';setTimeout(()=>this.textContent='⎘',1200);"
                style="background:none;border:1px solid #1a4046;color:#00c8c8;font-size:11px;padding:2px 6px;cursor:pointer;border-radius:2px;">⎘</button>
        </div>`;
    }).join('');
    $('country-modal').classList.remove('hidden');
}

// Mini timeline útoků za 24h po hodinách (inline SVG sparkline)
function _countrySparkline(hits) {
    const buckets = new Array(24).fill(0);
    const now = Date.now();
    hits.forEach(h => {
        if (!h.ts) return;
        const age = (now - new Date(h.ts).getTime()) / 3600000;
        if (age >= 0 && age < 24) buckets[23 - Math.floor(age)]++;
    });
    const max = Math.max(...buckets, 1);
    const W = 300, H = 40, bw = W / 24;
    const bars = buckets.map((v, i) =>
        `<rect x="${(i * bw).toFixed(1)}" y="${(H - v / max * H).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${(v / max * H).toFixed(1)}" fill="var(--accent)" opacity="0.8"/>`).join('');
    return `<div style="margin-top:8px;"><div style="font-size:8px;letter-spacing:1px;color:var(--muted);margin-bottom:2px;">POSLEDNÍCH 24H</div>
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:40px;display:block;">${bars}</svg></div>`;
}

$('cmod-close').addEventListener('click', () => $('country-modal').classList.add('hidden'));
$('country-modal').addEventListener('click', e => { if (e.target === $('country-modal')) $('country-modal').classList.add('hidden'); });

function pushAttack(a, isNew = true) {
    if (!a.lat && !a.lon) return; // no arc without valid coordinates
    const ageSeconds = a.ts ? (Date.now() - new Date(a.ts).getTime()) / 1000 : (isNew ? 0 : MAX_AGE_S);
    if (!isNew && ageSeconds > MAX_AGE_S) return; // skip attacks older than 24h
    const proto = a.protocol || 'ssh';
    const [c1, c2] = getArcColor(proto, ageSeconds);

    // Arc: start (origin, dim) → end (HOME, hot). Persistent.
    const arcObj = { startLat: a.lat, startLng: a.lon, endLat: HOME.lat, endLng: HOME.lon,
                     color: [c1, c2], phase: Math.random(), fresh: isNew,
                     attackTime: a.ts ? new Date(a.ts).getTime() : Date.now(),
                     src_ip: a.src_ip, country: a.country, isp: a.isp,
                     dst_port: a.dst_port, protocol: a.protocol };
    arcs.push(arcObj);
    arcTimestamps.push(Date.now());
    if (isNew) setTimeout(() => { arcObj.fresh = false; }, 8000);
    while (arcs.length > MAX_ARCS) { arcs.shift(); arcTimestamps.shift(); }

    points.push({ ...a, color: c1, radius: 0.3, alt: 0.01 });
    while (points.length > MAX_PTS) points.shift();

    // Názvy zemí na globusu řídí _updateCountryLabels (u centroidu s počtem).
    // Fallback pro mobil/bez geojson: label u místa útoku.
    if (!_countriesGeo && a.country && !labels.some(l => l.country === a.country)) {
        labels.push({ lat: a.lat, lon: a.lon, country: a.country });
        while (labels.length > MAX_LABELS) labels.shift();
    }

    if (!_globePaused) _scheduleGlobeFlush();
    if (!GLOBE_OK) _globeFallbackPush(a); // 2D feed plní i historie ze snapshotu

    if (isNew) {
        const [r, g, b] = PROTO_RGB[proto] || _DEFAULT_RGB;
        if (!_isMobile) {
            const addRing = (ring, ttl) => {
                rings.push(ring);
                globe.ringsData(_allRings());
                setTimeout(() => {
                    const i = rings.indexOf(ring); if (i >= 0) rings.splice(i, 1);
                    globe.ringsData(_allRings());
                }, ttl);
            };
            // 3-wave shockwave burst at attack origin
            [
                { delay:   0, maxR: 2.0, speed: 5.0, period: 380, ttl: 1600 },
                { delay: 160, maxR: 3.8, speed: 3.2, period: 560, ttl: 2400 },
                { delay: 340, maxR: 5.5, speed: 2.0, period: 800, ttl: 3500 },
            ].forEach(({ delay, maxR, speed, period, ttl }) => setTimeout(() => addRing(
                { lat: a.lat, lon: a.lon, maxR, speed, period,
                  color: t => `rgba(${r},${g},${b},${((1 - t) * 0.92).toFixed(2)})` }, ttl
            ), delay));
            // 2-wave shield-hit at HOME
            [
                { delay:   0, maxR: 1.8, speed: 6.0, period: 320, ttl: 1400 },
                { delay: 280, maxR: 3.2, speed: 3.5, period: 550, ttl: 2200 },
            ].forEach(({ delay, maxR, speed, period, ttl }) => setTimeout(() => addRing(
                { lat: HOME.lat, lon: HOME.lon, maxR, speed, period,
                  color: t => `rgba(255,232,59,${((1 - t) * 0.95).toFixed(2)})` }, ttl
            ), delay));
        }

        acIp.textContent = a.src_ip;
        acCountry.textContent = a.country || '?';
        acIsp.textContent = a.isp || '—';
        acVec.textContent = `:${a.dst_port}/${(a.protocol||'').toUpperCase()}`;
        if (acHits) acHits.textContent = (_ipCounts.get(a.src_ip) || 1) + '×';
        card.classList.add('hot');
        clearTimeout(pushAttack._t);
        pushAttack._t = setTimeout(() => card.classList.remove('hot'), 10000);

        // Auto-centering removed — disrupts flow when many attacks arrive in batch

        radarBlip(a);
        playBeep('blip');

        const VEC_LABEL = { ssh: 'SSH BRUTE-FORCE', http: 'HTTP ATTACK', https: 'HTTPS ATTACK', fail2ban: 'FAIL2BAN BAN' };
        showToast({
            title: `INCOMING — ${VEC_LABEL[proto] || proto.toUpperCase()}`,
            body: `${a.src_ip} · ${a.country || '?'}${a.isp ? ' · ' + a.isp : ''}`,
            color: PROTO_COLOR[proto] || 'var(--accent)',
            dedupKey: 'atk:' + a.src_ip,
            onClick: () => {
                const btn = document.querySelector('.tab-btn[data-tab="threat"]');
                if (btn && _activeTab !== 'threat') btn.click();
                centerGlobeOn(a.lat, a.lon);
            },
        });

        attackCount++;
        if (hudAttacks) hudAttacks.textContent = attackCount;
    }
}

function attackStatsUpdate() {
    const barsEl  = $('ast-proto-bars');
    const ipsEl   = $('ast-top-ips');
    const totalEl = $('ast-total');
    if (!barsEl) return;

    const counts = { ssh: 0, http: 0, https: 0, fail2ban: 0 };
    const ipMap = {};
    _attackHistory.forEach(a => {
        const p = a.protocol || 'fail2ban';
        counts[p] = (counts[p] || 0) + 1;
        if (a.src_ip) ipMap[a.src_ip] = (ipMap[a.src_ip] || { count: 0, country: a.country, protocol: p });
        if (a.src_ip) ipMap[a.src_ip].count++;
    });
    const total = Object.values(counts).reduce((s, v) => s + v, 0);
    if (totalEl) totalEl.textContent = total;

    const maxCount = Math.max(...Object.values(counts), 1);
    const PROTO_BAR_COLOR = PROTO_COLOR;  // sdílená paleta (vč. honeypot protokolů)
    barsEl.innerHTML = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([p, n]) => {
            const pct = Math.round(n / maxCount * 100);
            const color = PROTO_BAR_COLOR[p] || 'var(--accent)';
            return `<div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:9px;letter-spacing:1px;color:var(--muted);width:52px;">${p.toUpperCase()}</span>
                <div style="flex:1;height:12px;background:#06121a;position:relative;border:1px solid #14333a;">
                    <div style="height:100%;width:${pct}%;background:${color};opacity:0.8;"></div>
                </div>
                <span style="font-size:10px;font-weight:700;color:${color};width:38px;text-align:right;">${n}</span>
            </div>`;
        }).join('');

    const topIps = Object.entries(ipMap)
        .sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    ipsEl.innerHTML = topIps.map(([ip, v]) => {
        const color = PROTO_BAR_COLOR[v.protocol] || 'var(--accent)';
        const star = (typeof _isWatched === 'function' && _isWatched(ip)) ? '<span style="color:var(--yellow);">⭐</span> ' : '';
        return `<div style="display:flex;align-items:center;gap:6px;padding:3px 8px;border-bottom:1px solid #06121a;cursor:pointer;"
                     onclick="ipIntelOpen('${ip}')" title="IP intelligence">
            <span style="flex:1;font-family:monospace;font-size:10px;color:var(--accent);">${star}${ip}</span>
            <span style="font-size:9px;color:#4d7479;">${v.country || '?'}</span>
            <span style="font-size:10px;font-weight:700;color:${color};">×${v.count}</span>
        </div>`;
    }).join('') || '<div style="padding:8px;color:#4d7479;font-size:10px;">No attacks recorded yet.</div>';
}


// Periodically recolor arcs based on age (every 30 seconds)
setInterval(() => {
    if (_globePaused) return;
    const now = Date.now();
    const cutoff = now - MAX_AGE_S * 1000;
    // Prune arcs older than 24h
    for (let i = arcs.length - 1; i >= 0; i--) {
        const attackTime = arcs[i].attackTime || arcTimestamps[i];
        if (attackTime && attackTime < cutoff) {
            arcs.splice(i, 1);
            arcTimestamps.splice(i, 1);
        }
    }
    // Recolor remaining arcs by age — only push arc data, not points/labels
    arcs.forEach((arc, i) => {
        const attackTime = arc.attackTime || arcTimestamps[i];
        const ageSeconds = attackTime ? (now - attackTime) / 1000 : MAX_AGE_S;
        const [c1, c2] = getArcColor(arc.protocol || 'ssh', ageSeconds);
        arc.color = [c1, c2];
    });
    _globeFlushArcsOnly();
}, 30000);

// ================================================================
// RADAR WIDGET — sonar sweep, blip = nový útok (směr/vzdálenost od HOME)
// ================================================================
const _radarCv = $('radar-canvas');
const _radarBlips = []; // { angle, dist, color, t }
let _radarAngle = -Math.PI / 2;
let _radarLast = 0;

function _bearingFromHome(lat, lon) {
    const f1 = HOME.lat * Math.PI / 180, f2 = lat * Math.PI / 180;
    const dl = (lon - HOME.lon) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return Math.atan2(y, x) - Math.PI / 2; // canvas: 0 rad = východ, sever nahoru
}

function _distFromHome(lat, lon) {
    const R = 6371;
    const f1 = HOME.lat * Math.PI / 180, f2 = lat * Math.PI / 180;
    const df = (lat - HOME.lat) * Math.PI / 180, dl = (lon - HOME.lon) * Math.PI / 180;
    const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function radarBlip(a) {
    if (!_radarCv || (!a.lat && !a.lon)) return;
    _radarBlips.push({
        angle: _bearingFromHome(a.lat, a.lon),
        dist: Math.min(1, _distFromHome(a.lat, a.lon) / 17000) * 0.92 + 0.06,
        color: PROTO_COLOR[a.protocol] || '#00ffd5',
        t: performance.now(),
    });
    if (_radarBlips.length > 40) _radarBlips.shift();
}

const RADAR_BLIP_TTL = 8000;

function _radarFrame(ts) {
    requestAnimationFrame(_radarFrame);
    if (!_radarCv || document.hidden) return;
    // _activeTab žije v 04-topology.js — rAF může vystřelit před jeho načtením
    if (typeof _activeTab !== 'undefined' && _activeTab !== 'threat') return;
    if (ts - _radarLast < 40) return; // ~25 fps stačí
    _radarLast = ts;
    const w = _radarCv.clientWidth, h = _radarCv.clientHeight;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    if (_radarCv.width !== Math.round(w * dpr)) { _radarCv.width = Math.round(w * dpr); _radarCv.height = Math.round(h * dpr); }
    const ctx = _radarCv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 4;
    const acc = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#00ffd5';

    // mřížka
    ctx.strokeStyle = 'rgba(77,116,121,0.35)';
    ctx.lineWidth = 1;
    [0.33, 0.66, 1].forEach(f => { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, 7); ctx.stroke(); });
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();

    // sweep — trailing glow za paprskem
    _radarAngle += 0.035;
    if (ctx.createConicGradient) {
        const grad = ctx.createConicGradient(_radarAngle - Math.PI * 2, cx, cy);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(0.82, 'rgba(0,0,0,0)');
        grad.addColorStop(1, acc);
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = grad;
        ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
        ctx.restore();
    }
    ctx.strokeStyle = acc;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(_radarAngle) * R, cy + Math.sin(_radarAngle) * R);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // blipy
    const now = performance.now();
    for (let i = _radarBlips.length - 1; i >= 0; i--) {
        const b = _radarBlips[i];
        const age = now - b.t;
        if (age > RADAR_BLIP_TTL) { _radarBlips.splice(i, 1); continue; }
        const alpha = 1 - age / RADAR_BLIP_TTL;
        const bx = cx + Math.cos(b.angle) * b.dist * R;
        const by = cy + Math.sin(b.angle) * b.dist * R;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = b.color;
        ctx.beginPath(); ctx.arc(bx, by, 2.5, 0, 7); ctx.fill();
        // expandující kroužek u čerstvých blipů
        if (age < 1200) {
            ctx.strokeStyle = b.color;
            ctx.globalAlpha = alpha * (1 - age / 1200);
            ctx.beginPath(); ctx.arc(bx, by, 3 + age / 90, 0, 7); ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }
    // střed = HOME
    ctx.fillStyle = acc;
    ctx.beginPath(); ctx.arc(cx, cy, 2, 0, 7); ctx.fill();
}
requestAnimationFrame(_radarFrame);

// ================================================================
// GLOBE VIEW MODES — ARCS / HEAT (hex-bin density) / POINTS
// ================================================================
if (typeof globe.hexBinPointsData === 'function') {
    globe.hexBinPointLat(d => d.lat).hexBinPointLng(d => d.lon)
        .hexBinResolution(3)
        .hexBinMerge(true)
        .hexBinPointWeight(1)
        .hexAltitude(d => Math.min(0.3, 0.02 + d.sumWeight * 0.01))
        .hexTopColor(d => `rgba(255,${Math.max(0, 200 - d.sumWeight * 14)},0,0.85)`)
        .hexSideColor(d => `rgba(255,${Math.max(0, 200 - d.sumWeight * 14)},0,0.45)`);
}
// větší body v POINTS módu
globe.pointRadius(d => (_globeViewMode === 'points' ? 1.8 : 1) * (d.radius ?? 0.3));

function _setGlobeView(mode) {
    _globeViewMode = mode;
    UIState.set('globe-view', mode);
    const btn = $('globe-view-btn');
    if (btn) btn.textContent = mode.toUpperCase();
    _globeFlush();
}

$('globe-view-btn')?.addEventListener('click', () => {
    const order = ['arcs', 'heat', 'points'];
    _setGlobeView(order[(order.indexOf(_globeViewMode) + 1) % order.length]);
});
if ($('globe-view-btn')) $('globe-view-btn').textContent = _globeViewMode.toUpperCase();

// ================================================================
// TIMELINE REPLAY — přehrání útoků za 24h (1h ≈ 1s)
// ================================================================
const _replay = { active: false, timer: null };

function replayStart() {
    if (_replay.active) return;
    const hist = [..._attackHistory]
        .filter(a => a.ts && (a.lat || a.lon))
        .sort((a, b) => (a.ts < b.ts ? -1 : 1));
    if (!hist.length) {
        showToast({ title: 'REPLAY', body: 'Žádná data za posledních 24h', color: 'var(--muted)' });
        return;
    }
    _replay.active = true;
    _globePaused = true; // pozastav live flushe po dobu replaye
    $('replay-bar').classList.remove('hidden');
    $('globe-replay-btn').textContent = '■ 24H';

    const t0 = Date.now() - 24 * 3600 * 1000, t1 = Date.now();
    let simT = t0, idx = 0, lastPush = 0;
    const rArcs = [], rPts = [];
    globe.arcsData([]);
    globe.pointsData([...homePoints]);
    globe.labelsData([]);

    _replay.timer = setInterval(() => {
        simT += 3600 * 1000 / 4; // tick 250 ms → 1h за 1s
        while (idx < hist.length && new Date(hist[idx].ts).getTime() <= simT) {
            const a = hist[idx++];
            const [c1, c2] = getArcColor(a.protocol || 'ssh', 0);
            rArcs.push({ startLat: a.lat, startLng: a.lon, endLat: HOME.lat, endLng: HOME.lon,
                         color: [c1, c2], phase: Math.random(), protocol: a.protocol, country: a.country,
                         src_ip: a.src_ip, isp: a.isp, dst_port: a.dst_port });
            rPts.push({ ...a, color: c1, radius: 0.35, alt: 0.01 });
            radarBlip(a);
            lastPush = simT;
        }
        globe.arcsData([...rArcs]);
        globe.pointsData([...rPts, ...homePoints]);
        const d = new Date(simT);
        $('replay-time').textContent =
            d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
        $('replay-progress').style.width = ((simT - t0) / (t1 - t0) * 100).toFixed(1) + '%';
        if (simT >= t1) replayStop();
    }, 250);
}

function replayStop() {
    if (!_replay.active) return;
    clearInterval(_replay.timer);
    _replay.active = false;
    $('replay-bar').classList.add('hidden');
    $('globe-replay-btn').textContent = '▶ 24H';
    _globePaused = false;
    _globeFlush();
}

$('globe-replay-btn')?.addEventListener('click', () => _replay.active ? replayStop() : replayStart());
$('replay-stop')?.addEventListener('click', replayStop);

// ================================================================
// HOT ZONES — pulzující červené kroužky u top zemí za poslední hodinu
// ================================================================
function updateHotZones() {
    if (_replay.active) return; // během replaye nerušit
    const cutoff = Date.now() - 3600 * 1000;
    const byCountry = new Map(); // country → { n, lat, lon }
    for (const a of _attackHistory || []) {
        if (!a.country || a.protocol === 'who') continue;
        if (a.ts && new Date(a.ts).getTime() < cutoff) continue;
        if (!a.lat && !a.lon) continue;
        const e = byCountry.get(a.country) || { n: 0, lat: a.lat, lon: a.lon };
        e.n++;
        byCountry.set(a.country, e);
    }
    const top = [...byCountry.entries()]
        .sort((x, y) => y[1].n - x[1].n)
        .slice(0, 5)
        .filter(([, e]) => e.n >= 2); // aspoň 2 útoky, ať to není šum

    hotRings.length = 0;
    const maxN = top.length ? top[0][1].n : 1;
    top.forEach(([, e]) => {
        const intensity = 0.4 + 0.5 * (e.n / maxN);
        hotRings.push({
            lat: e.lat, lon: e.lon,
            maxR: 3 + 4 * (e.n / maxN), speed: 1.6, period: 1400,
            color: t => `rgba(255,40,60,${((1 - t) * intensity).toFixed(2)})`,
        });
    });
    if (GLOBE_OK && !_globePaused) globe.ringsData(_allRings());
}
setInterval(updateHotZones, 20000);

// Přepínač zobrazení názvů zemí: všechny (s tlumenými neútočícími) / jen útočící
$('globe-labels-btn')?.addEventListener('click', () => {
    _labelsAllCountries = !_labelsAllCountries;
    UIState.set('globe-labels-all', _labelsAllCountries);
    const btn = $('globe-labels-btn');
    if (btn) btn.style.background = _labelsAllCountries ? 'var(--accent)' : '';
    if (btn) btn.style.color = _labelsAllCountries ? '#0a1a1e' : '';
    _updateCountryLabels();
});
if ($('globe-labels-btn') && _labelsAllCountries) {
    $('globe-labels-btn').style.background = 'var(--accent)';
    $('globe-labels-btn').style.color = '#0a1a1e';
}
