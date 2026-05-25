// Sentinel-Alert dashboard

const $ = id => document.getElementById(id);

// Solo globe mode: ?solo=globe hides everything except the globe panel
const _SOLO_GLOBE = new URLSearchParams(location.search).get('solo') === 'globe';
if (_SOLO_GLOBE) {
    const style = document.createElement('style');
    style.textContent = `
        header, .grid > :not(#globe-panel) { display: none !important; }
        body { overflow: hidden; background: #000; }
        .grid { display: block !important; height: 100vh !important; }
        #globe-panel { height: 100vh !important; width: 100vw !important;
                       border: none !important; border-radius: 0 !important; }
        #globe-panel .ph { background: rgba(2,10,14,0.7) !important; }
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

let HOME = { lat: 49.8209, lon: 18.2625 };
let attackCount = 0;
const MAX_ARCS = 300, MAX_PTS = 300, MAX_LABELS = 50, MAX_FEED = 10;
let _globePaused = false, _histPaused = false;
let _countryCounts = new Map(); // country → attack arc count (for stroke width)

function _globeFlush() {
    // Filter arcs by active attack-history filter (ALL shows everything)
    const visibleArcs = (_attackHistFilter && _attackHistFilter !== 'all')
        ? arcs.filter(a => (a.protocol || 'fail2ban') === _attackHistFilter)
        : arcs;
    const allArcs = [...visibleArcs, ...userArcs];
    _countryCounts = new Map();
    allArcs.forEach(a => {
        if (a.country && a.protocol !== 'who')
            _countryCounts.set(a.country, (_countryCounts.get(a.country) || 0) + 1);
    });
    globe.arcsData(allArcs);
    globe.pointsData([...points, ...homePoints, ...userPoints]);
    globe.labelsData([...labels]);
}

// Lightweight arc-only refresh — for periodic recolor (avoids re-uploading points/labels)
function _globeFlushArcsOnly() {
    const visibleArcs = (_attackHistFilter && _attackHistFilter !== 'all')
        ? arcs.filter(a => (a.protocol || 'fail2ban') === _attackHistFilter)
        : arcs;
    globe.arcsData([...visibleArcs, ...userArcs]);
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

let _countriesGeo = null;
let _countryAttackMap = {};
let _lastCfg = {};

const TX_NIGHT = '//unpkg.com/three-globe/example/img/earth-night.jpg';
const TX_DAY   = '//unpkg.com/three-globe/example/img/earth-blue-marble.jpg';

let _manualDay = null; // null = auto (time-based), true/false = user override

function pickTexture() {
    const autoDay = new Date().getHours() >= 7 && new Date().getHours() < 19;
    const isDay = _manualDay !== null ? _manualDay : autoDay;
    globeModeEl.textContent = isDay ? 'DAY' : 'NIGHT';
    return isDay ? TX_DAY : TX_NIGHT;
}

const _isMobile = window.innerWidth <= 1100;
const globe = Globe()(globeEl)
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
    .arcStroke(d => d.protocol === 'who' ? 1.1 : 0.7)
    .arcDashLength(0.25).arcDashGap(0.75).arcDashInitialGap(d => d.phase)
    .arcDashAnimateTime(d => {
        if (d.protocol === 'who') return 1400;
        // More attacks from same country → faster animation (lower ms = faster)
        // On mobile use slower animation (less GPU work)
        const n = _countryCounts.get(d.country) || 1;
        const base = _isMobile ? 3000 : 2400;
        const minMs = _isMobile ? 800 : 350;
        return Math.max(minMs, Math.round(base / Math.log2(n + 2)));
    })
    .arcAltitudeAutoScale(0.75)
    .arcsTransitionDuration(0)
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
    .labelText(d => d.country)
    .labelSize(0.6).labelDotRadius(0.25)
    .labelColor(() => '#ffe83b').labelResolution(2)
    .ringsData([...rings, ...homeRings])
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
        card.classList.add('hot');
        clearTimeout(pushAttack._t);
        pushAttack._t = setTimeout(() => card.classList.remove('hot'), 10000);
        centerGlobeOn(arc.startLat, arc.startLng);
    });

globe.controls().autoRotate = true;
globe.controls().autoRotateSpeed = 0.8;
globe.controls().enableDamping = true;

window.addEventListener('resize', () => {
    globe.width(globeEl.clientWidth).height(globeEl.clientHeight);
});
if (_SOLO_GLOBE) setTimeout(() => globe.width(globeEl.clientWidth).height(globeEl.clientHeight), 50);

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

globeModeEl.addEventListener('click', () => {
    _manualDay = globeModeEl.textContent !== 'DAY';
    globe.globeImageUrl(pickTexture());
});

// Protocol colors [r,g,b] at full brightness — age dims them
const PROTO_RGB = {
    ssh:      [255, 200,   0],  // yellow
    http:     [  0, 200,  80],  // green
    https:    [255, 220,   0],  // yellow
    fail2ban: [160,  40, 255],  // purple
    blocked:  [120,  20, 200],  // dark purple
};
const _DEFAULT_RGB = [0, 220, 180];  // green-cyan fallback

// CSS hex colors matching PROTO_RGB — used in panels so colors match the globe
const PROTO_COLOR = {
    ssh:      '#ffc800',
    http:     '#00c850',
    https:    '#ffdc00',
    fail2ban: '#a028ff',
    blocked:  '#7814c8',
    who:      '#38bdf8',
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
function refreshCountryPolygons() {
    _countryAttackMap = {};
    _attackHistory.forEach(a => {
        if (!a.country || a.country === '?' || a.country === 'Unknown') return;
        const key = COUNTRY_NORM[a.country] || a.country;
        if (!_countryAttackMap[key]) _countryAttackMap[key] = [];
        _countryAttackMap[key].push(a);
    });
    // Debounce — each polygonsData() call rebuilds all meshes, causing a flash.
    // Long delay keeps it rare; color functions read from _countryAttackMap live.
    clearTimeout(_polyRefreshTimer);
    _polyRefreshTimer = setTimeout(() => {
        if (_countriesGeo && !_globePaused) globe.polygonsData(_countriesGeo);
    }, 10000);
}

async function loadCountryPolygons() {
    if (_countriesGeo) return; // already loaded, skip
    if (_isMobile) return;     // skip on mobile — 180 country meshes are too heavy
    try {
        const geo = await fetch('/static/vendor/countries.geojson').then(r => r.json());
        _countriesGeo = geo.features;
        globe
            .polygonsData(_countriesGeo)
            .polygonGeoJsonGeometry(d => d.geometry)
            .polygonAltitude(0.02)
            .polygonCapColor(d => {
                const hits = _countryAttackMap[_polyName(d)];
                if (!hits) return 'rgba(0,160,70,0.12)';
                const intensity = Math.min(0.75, 0.35 + hits.length * 0.05);
                return `rgba(210,25,55,${intensity.toFixed(2)})`;
            })
            .polygonSideColor(() => 'rgba(0,0,0,0)')
            .polygonStrokeColor(d => {
                const hits = _countryAttackMap[_polyName(d)];
                return hits ? 'rgba(255,50,30,0.9)' : 'rgba(0,200,90,0.5)';
            })
            .polygonLabel(d => {
                const name = _polyName(d);
                const hits = _countryAttackMap[name] || [];
                const uniqIPs = [...new Set(hits.map(a => a.src_ip))].slice(0, 6);
                if (!hits.length) return `<div style="background:rgba(2,10,14,0.92);padding:5px 9px;border:1px solid #1a4046;font-size:11px;color:#4d7479;">${name}</div>`;
                return `<div style="background:rgba(2,10,14,0.95);padding:6px 10px;border:1px solid #ff2a5e;font-size:11px;color:#cfe7ec;line-height:1.5;">
                    <b style="color:#ff2a5e;">${name}</b><br>
                    <span style="color:#4d7479;">${hits.length} attack${hits.length!==1?'s':''}</span><br>
                    ${uniqIPs.map(ip=>`<span style="color:#ffe83b;">${ip}</span>`).join('<br>')}
                </div>`;
            })
            .onPolygonClick(d => {
                if (!d) return;
                const name = _polyName(d);
                const hit = _attackHistory.find(a => a.country === name && (a.lat || a.lon));
                if (hit) centerGlobeOn(hit.lat, hit.lon);
            });
    } catch(e) {
        console.warn('countries.geojson unavailable:', e);
    }
}


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

    if (a.country && !labels.some(l => l.country === a.country)) {
        labels.push({ lat: a.lat, lon: a.lon, country: a.country });
        while (labels.length > MAX_LABELS) labels.shift();
    }

    if (!_globePaused) _scheduleGlobeFlush();

    if (isNew) {
        const [r, g, b] = PROTO_RGB[proto] || _DEFAULT_RGB;
        if (!_isMobile) {
            const addRing = (ring, ttl) => {
                rings.push(ring);
                globe.ringsData([...rings, ...homeRings]);
                setTimeout(() => {
                    const i = rings.indexOf(ring); if (i >= 0) rings.splice(i, 1);
                    globe.ringsData([...rings, ...homeRings]);
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
        card.classList.add('hot');
        clearTimeout(pushAttack._t);
        pushAttack._t = setTimeout(() => card.classList.remove('hot'), 10000);

        // For new fail2ban events, center globe
        if (a.protocol === 'fail2ban') {
            centerGlobeOn(a.lat, a.lon);
        }

        attackCount++;
        hudAttacks.textContent = attackCount;
    }
}

function _ipToNum(ip) {
    return (ip || '').split('.').reduce((n, o) => n * 256 + (parseInt(o) || 0), 0);
}

function renderDevices(list) {
    const online = list.filter(d => d.is_online).length;
    const vswitches = (_netSettings.virtual_switches || []);
    netCountEl.textContent = `${online} / ${list.length + vswitches.length}`;
    hudLan.textContent = `${online} / ${list.length + vswitches.length}`;

    const now = Date.now();
    const newThreshold = 48 * 3600 * 1000;
    const devSettings = (_netSettings.devices || {});

    // Switch/router first, virtual (lxc/qemu) last, then by IP
    const _TYPE_PRI = { switch: 0, router: 0, ap: 0, lxc: 2, qemu: 2 };
    list = [...list].sort((a, b) => {
        const pa = _TYPE_PRI[(devSettings[a.mac] || {}).type] ?? 1;
        const pb = _TYPE_PRI[(devSettings[b.mac] || {}).type] ?? 1;
        return pa !== pb ? pa - pb : _ipToNum(a.ip) - _ipToNum(b.ip);
    });

    const vswHtml = vswitches.map(sw => `
        <div class="row dev clickable" data-vsw="${escape(sw.id)}" style="border-left:2px solid #38bdf8;">
            <span class="dot" style="background:#38bdf8;box-shadow:0 0 4px #38bdf8;"></span>
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;">
                    <span class="name">${escape(sw.hostname)} <span style="color:#38bdf8;font-size:9px;font-weight:700;">[SW]</span></span>
                    <span class="meta">${sw.ports}p</span>
                </div>
                <div class="ip">Virtual Switch · ${sw.ports} ports</div>
            </div>
        </div>`).join('');

    const devHtml = list.length ? list.map(d => {
        const cfg = devSettings[d.mac] || {};
        const displayName = cfg.hostname || d.hostname;
        const _BADGE = { router:'#38bdf8', ap:'#38bdf8', switch:'#38bdf8', lxc:'#a855f7', qemu:'#60a5fa', nas:'#ffe83b', mobile:'#86efac', tv:'#fb923c', printer:'#f97316', server:'#22c55e', rpi:'#ef4444', other:'#ea580c', iot:'#06b6d4', pc:'#94a3b8', network:'#166534' };
        const typeBadge = _BADGE[cfg.type] ? ` <span style="color:${_BADGE[cfg.type]};font-size:9px;font-weight:700;">[${cfg.type.toUpperCase()}]</span>` : '';
        const vizDot = cfg.visualize ? ' <span style="color:var(--accent);font-size:9px;" title="Visualize on map">◉</span>' : '';
        const label = displayName
            ? `${escape(displayName)}${typeBadge}${vizDot} <span style="color:#4d7479;font-size:10px;">[${escape(d.ip)}]</span>`
            : escape(d.ip);
        const seen = d.last_seen ? timeAgo(d.last_seen) : '—';
        const ports = (d.ports || '').split(',').filter(Boolean).map(p => {
            const cls = ({22:'ssh',80:'web',443:'web',8080:'web',3306:'db',5432:'db',6379:'db'}[+p]) || '';
            return `<span class="port ${cls}">${p}</span>`;
        }).join('');
        const notifyNew = cfg.notify_new !== false;
        const isNew = notifyNew && d.first_seen &&
                      (now - new Date(d.first_seen).getTime()) < newThreshold;
        const newBadge = isNew ? ' <span class="badge-new">(NEW)</span>' : '';
        return `
        <div class="row dev clickable ${d.is_online ? '' : 'offline'}" data-mac="${escape(d.mac)}">
            <span class="dot ${d.is_online ? 'on' : 'off'}"></span>
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;">
                    <span class="name">${label}${newBadge}</span>
                    <span class="meta">${seen}</span>
                </div>
                <div class="ip">${escape(d.vendor || d.ip)}</div>
                ${ports ? `<div class="ports">${ports}</div>` : ''}
            </div>
        </div>`;
    }).join('') : '<div class="empty">No devices.</div>';

    netListEl.innerHTML = devHtml + vswHtml;

    netListEl.querySelectorAll('.dev[data-vsw]').forEach(row => {
        row.addEventListener('click', () => openVswModal(row.dataset.vsw));
    });
    netListEl.querySelectorAll('.dev[data-mac]').forEach(row => {
        row.addEventListener('click', () => openDeviceModal(row.dataset.mac));
    });
}

let _allDevices = [];    // cache for parent selector
let _attackHistory = []; // combined fail2ban + proxy attacks, last 24h

async function openDeviceModal(mac) {
    const [d, netCfg] = await Promise.all([
        fetch(`/api/device/${encodeURIComponent(mac)}`).then(r => r.ok ? r.json() : null),
        fetch('/api/network/settings').then(r => r.json()),
    ]);
    if (!d) return;

    _allDevices = await fetch('/api/devices').then(r => r.json()).catch(() => []);

    const modal  = document.getElementById('detail-modal');
    const cfg    = (netCfg.devices || {})[mac] || {};
    const devType       = cfg.type           || '';
    const parentMac     = cfg.parent_mac     || '';
    const parentPort    = cfg.parent_port    || '';
    const connType      = cfg.connection_type || 'ethernet';
    const visualize     = cfg.visualize      === true;

    const effectiveName = cfg.hostname || d.hostname || d.ip;
    document.getElementById('detail-title').textContent = '◤ ' + effectiveName;

    // Parent selector: real devices + virtual switches
    const parentOpts = [
        ..._allDevices.filter(x => x.mac !== mac).map(x => {
            const n = ((netCfg.devices || {})[x.mac] || {}).hostname || x.hostname || x.ip;
            return `<option value="${escape(x.mac)}" ${x.mac === parentMac ? 'selected' : ''}>${escape(n)} [${escape(x.ip)}]</option>`;
        }),
        ...(_netSettings.virtual_switches || []).map(s =>
            `<option value="vsw:${escape(s.id)}" ${'vsw:'+s.id === parentMac ? 'selected' : ''}>${escape(s.hostname)} [SW]</option>`)
    ].join('');

    document.getElementById('detail-body').innerHTML = `
        <div style="margin-bottom:10px;">
            <div style="font-size:9px;letter-spacing:1px;color:#4d7479;margin-bottom:3px;">HOSTNAME</div>
            <input type="text" id="dd-hostname" value="${escape(cfg.hostname || d.hostname || '')}"
                placeholder="${escape(d.ip)}"
                style="width:100%;padding:5px 8px;background:#0a1418;color:var(--fg);border:1px solid #1a4046;font-family:inherit;font-size:12px;outline:none;">
        </div>
        <div style="display:grid;grid-template-columns:90px 1fr;gap:3px 10px;padding:4px 0;font-size:10px;margin-bottom:10px;color:#4d7479;">
            <span>IP</span><span style="color:#cfe7ec">${escape(d.ip)}</span>
            <span>MAC</span><span style="color:#cfe7ec">${escape(d.mac)}</span>
            <span>VENDOR</span><span style="color:#cfe7ec">${escape(d.vendor||'—')}</span>
            <span>STATUS</span><span style="color:${d.is_online?'var(--green)':'#555'}">${d.is_online?'ONLINE':'OFFLINE'}</span>
            <span>FIRST SEEN</span><span style="color:#cfe7ec">${escape(d.first_seen||'—')}</span>
            <span>PORTS</span><span style="color:#cfe7ec">${escape(d.ports||'none')}</span>
        </div>

        <div style="border-top:1px solid #14333a;padding-top:10px;display:flex;flex-direction:column;gap:8px;">
            <div style="font-size:9px;font-weight:800;letter-spacing:2px;color:#4d7479;">DEVICE TYPE</div>
            <div id="dd-type-grp" data-value="${devType}"
                style="display:grid;grid-template-columns:repeat(5,1fr);gap:2px;">
                ${[['','NONE','#cfe7ec','#0e2228'],['router','ROUTER','#38bdf8','#001830'],['ap','AP','#38bdf8','#001830'],['switch','SWITCH','#38bdf8','#001830'],['lxc','LXC','#a855f7','#1a0030'],['qemu','QEMU','#60a5fa','#00101a'],['nas','NAS','#ffe83b','#1a1500'],['mobile','MOBILE','#86efac','#001a08'],['tv','TV','#fb923c','#1a0800'],['printer','PRINT','#f97316','#150800'],['server','SERVER','#22c55e','#001508'],['rpi','RPI','#ef4444','#1a0000'],['other','OTHER','#ea580c','#120400'],['iot','IoT','#06b6d4','#001a1f'],['pc','PC','#94a3b8','#0d1117']].map(([val,lbl,col,bg]) =>
                    `<button data-val="${val}" style="padding:4px 2px;font-size:9px;border:1px solid #14333a;font-family:inherit;cursor:pointer;letter-spacing:0.5px;transition:background .15s,color .15s;background:${devType===val?bg:'#02060a'};color:${devType===val?col:'#4d7479'};">${lbl}</button>`
                ).join('')}
            </div>
            <label style="font-size:10px;color:#4d7479;display:flex;flex-direction:column;gap:3px;">Connected to (parent)
                <select id="dd-parent" style="background:#02060a;border:1px solid #14333a;color:#cfe7ec;padding:4px 6px;font-family:inherit;font-size:11px;">
                    <option value="">— none —</option>
                    ${parentOpts}
                </select>
            </label>
            <label style="font-size:10px;color:#4d7479;display:flex;flex-direction:column;gap:3px;">Port on parent (e.g. 5)
                <input type="text" id="dd-port" value="${escape(String(parentPort))}"
                    style="background:#02060a;border:1px solid #14333a;color:#cfe7ec;padding:4px 6px;font-family:inherit;font-size:11px;width:80px;">
            </label>

            <div style="font-size:9px;font-weight:800;letter-spacing:2px;color:#4d7479;margin-top:4px;">CONNECTION TYPE</div>
            <div id="dd-conn-grp" data-value="${connType}" style="display:flex;gap:2px;">
                <button data-val="ethernet" style="flex:1;padding:4px;font-size:10px;border:1px solid #14333a;font-family:inherit;cursor:pointer;letter-spacing:1px;transition:background .15s,color .15s;background:${connType==='ethernet'?'#0a1418':'#02060a'};color:${connType==='ethernet'?'#2dffa1':'#4d7479'};">ETHERNET</button>
                <button data-val="wifi" style="flex:1;padding:4px;font-size:10px;border:1px solid #14333a;font-family:inherit;cursor:pointer;letter-spacing:1px;transition:background .15s,color .15s;background:${connType==='wifi'?'#00183a':'#02060a'};color:${connType==='wifi'?'#38bdf8':'#4d7479'};">WiFi</button>
                <button data-val="virtual" style="flex:1;padding:4px;font-size:10px;border:1px solid #14333a;font-family:inherit;cursor:pointer;letter-spacing:1px;transition:background .15s,color .15s;background:${connType==='virtual'?'#1a0d00':'#02060a'};color:${connType==='virtual'?'#fb923c':'#4d7479'};">VIRT</button>
            </div>

            <div id="dd-isp-row" style="display:${devType==='router'?'flex':'none'};align-items:center;justify-content:space-between;font-size:11px;margin-top:6px;">
                <span style="color:#ffe83b;font-weight:700;">&#9733; ISP Gateway</span>
                <label class="fsc-toggle"><input type="checkbox" id="dd-isp" ${cfg.is_isp?'checked':''}><span class="fsc-toggle-slider"></span></label>
            </div>

            <div style="font-size:9px;font-weight:800;letter-spacing:2px;color:#4d7479;margin-top:4px;">DISPLAY</div>
            <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;">
                <span>Visualize on map</span>
                <label class="fsc-toggle"><input type="checkbox" id="dd-viz" ${visualize?'checked':''}><span class="fsc-toggle-slider"></span></label>
            </div>

            <div style="font-size:9px;font-weight:800;letter-spacing:2px;color:#4d7479;margin-top:4px;">SENTINEL ALERTS</div>
            <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;">
                <span>Connected</span>
                <label class="fsc-toggle"><input type="checkbox" id="dd-nc" ${cfg.notify_connect!==false?'checked':''}><span class="fsc-toggle-slider"></span></label>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;">
                <span>Disconnected</span>
                <label class="fsc-toggle"><input type="checkbox" id="dd-nd" ${cfg.notify_disconnect!==false?'checked':''}><span class="fsc-toggle-slider"></span></label>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;">
                <span>New device</span>
                <label class="fsc-toggle"><input type="checkbox" id="dd-nn" ${cfg.notify_new!==false?'checked':''}><span class="fsc-toggle-slider"></span></label>
            </div>
        </div>`;

    // Type button selection handler (generalized)
    const _TYPE_COLORS = { '':['#0e2228','#cfe7ec'], router:['#001830','#38bdf8'], ap:['#001830','#38bdf8'], switch:['#001830','#38bdf8'], lxc:['#1a0030','#a855f7'], qemu:['#00101a','#60a5fa'], nas:['#1a1500','#ffe83b'], mobile:['#001a08','#86efac'], tv:['#1a0800','#fb923c'], printer:['#150800','#f97316'], server:['#001508','#22c55e'], rpi:['#1a0000','#ef4444'], other:['#120400','#ea580c'], iot:['#001a1f','#06b6d4'], pc:['#0d1117','#94a3b8'], network:['#001a0a','#166534'] };
    const typeGrp = document.getElementById('dd-type-grp');
    typeGrp.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.val;
            typeGrp.dataset.value = val;
            typeGrp.querySelectorAll('button').forEach(b => {
                const sel = b.dataset.val === val;
                const [bg, col] = _TYPE_COLORS[b.dataset.val] || ['#02060a','#4d7479'];
                b.style.background = sel ? bg : '#02060a';
                b.style.color = sel ? col : '#4d7479';
            });
            const ispRow = document.getElementById('dd-isp-row');
            if (ispRow) ispRow.style.display = val === 'router' ? 'flex' : 'none';
        });
    });

    // Connection type toggle (ethernet / wifi / virtual)
    const _CONN_STYLE = { ethernet: ['#0a1418','#2dffa1'], wifi: ['#00183a','#38bdf8'], virtual: ['#1a0d00','#fb923c'] };
    const connGrp = document.getElementById('dd-conn-grp');
    if (connGrp) {
        const wifiApMac = (_allDevices.find(x => x.ip === '192.168.2.90') || {}).mac || '';
        connGrp.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                const val = btn.dataset.val;
                connGrp.dataset.value = val;
                connGrp.querySelectorAll('button').forEach(b => {
                    const sel = b.dataset.val === val;
                    const [bg, col] = _CONN_STYLE[b.dataset.val] || ['#02060a','#4d7479'];
                    b.style.background = sel ? bg : '#02060a';
                    b.style.color = sel ? col : '#4d7479';
                });
                if (val === 'wifi' && wifiApMac) {
                    const parentSel = document.getElementById('dd-parent');
                    if (parentSel && !parentSel.value) parentSel.value = wifiApMac;
                }
            });
        });
    }

    const actionsDiv = document.getElementById('detail-actions');
    actionsDiv.innerHTML = '';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn primary';
    saveBtn.textContent = 'SAVE';
    saveBtn.addEventListener('click', async () => {
        await fetch('/api/network/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mac,
                hostname:          document.getElementById('dd-hostname').value.trim(),
                type:              document.getElementById('dd-type-grp').dataset.value,
                parent_mac:        document.getElementById('dd-parent').value,
                parent_port:       document.getElementById('dd-port').value,
                connection_type:   document.getElementById('dd-conn-grp')?.dataset.value || 'ethernet',
                visualize:         document.getElementById('dd-viz').checked,
                notify_connect:    document.getElementById('dd-nc').checked,
                notify_disconnect: document.getElementById('dd-nd').checked,
                notify_new:        document.getElementById('dd-nn').checked,
                is_isp:            !!(document.getElementById('dd-isp')?.checked),
            })
        });
        _netSettings = await fetch('/api/network/settings').then(r => r.json()).catch(() => _netSettings);
        saveBtn.textContent = 'SAVED ✓';
        setTimeout(() => { saveBtn.textContent = 'SAVE'; }, 1500);
        fetch('/api/devices').then(r => r.json()).then(renderDevices);
        if (_netInitDone) { _netSyncNodeTypes(); _netSyncIspCloud(); netRender(); }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn danger';
    deleteBtn.textContent = 'DELETE';
    deleteBtn.style.cssText = 'color:#ff2a5e;border-color:#ff2a5e;margin-right:auto;';
    deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete device ${d.ip} (${mac}) from DB? It will reappear on next scan if still online.`)) return;
        await fetch(`/api/device/${encodeURIComponent(mac)}`, { method: 'DELETE' });
        // Remove from topo
        _netData.nodes = _netData.nodes.filter(n => n.mac !== mac);
        _netData.links = _netData.links.filter(l => {
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            return s !== `h-${mac}` && t !== `h-${mac}`;
        });
        fetch('/api/topo-data', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(_topoForSave()) }).catch(() => {});
        modal.classList.add('hidden');
        _netSettings = await fetch('/api/network/settings').then(r => r.json()).catch(() => _netSettings);
        fetch('/api/devices').then(r => r.json()).then(renderDevices);
        if (_netInitDone) netRender();
    });

    const copyIpBtn = document.createElement('button');
    copyIpBtn.className = 'btn';
    copyIpBtn.textContent = 'COPY IP';
    copyIpBtn.addEventListener('click', () => navigator.clipboard.writeText(d.ip));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn ghost';
    closeBtn.textContent = 'CLOSE';
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));

    actionsDiv.appendChild(deleteBtn);
    actionsDiv.appendChild(saveBtn);
    actionsDiv.appendChild(copyIpBtn);
    actionsDiv.appendChild(closeBtn);
    modal.classList.remove('hidden');
}

// Virtual switch modal
let _vswEditing = null;
async function openVswModal(swId) {
    _vswEditing = swId || null;
    const sw = swId ? (_netSettings.virtual_switches || []).find(s => s.id === swId) : null;
    document.getElementById('vsw-hostname').value = sw ? sw.hostname : '';
    document.getElementById('vsw-ports').value = sw ? sw.ports : 8;
    document.getElementById('vsw-del').style.display = swId ? '' : 'none';
    // Ensure device list is loaded
    if (!_allDevices.length) {
        _allDevices = await fetch('/api/devices').then(r => r.json()).catch(() => []);
    }
    // Populate parent select
    const parentSel = document.getElementById('vsw-parent');
    const curParent = sw ? (sw.parent_mac || '') : '';
    const devCfgs = (_netSettings.devices || {});
    const physOpts = _allDevices.map(x => {
        const n = (devCfgs[x.mac] || {}).hostname || x.hostname || x.ip;
        return `<option value="${escape(x.mac)}" ${x.mac === curParent ? 'selected' : ''}>${escape(n)} [${escape(x.ip)}]</option>`;
    }).join('');
    const vswOpts = (_netSettings.virtual_switches || [])
        .filter(s => s.id !== swId)
        .map(s => `<option value="vsw:${escape(s.id)}" ${'vsw:'+s.id === curParent ? 'selected' : ''}>${escape(s.hostname)} [SW]</option>`)
        .join('');
    parentSel.innerHTML = `<option value="">— none —</option>${physOpts}${vswOpts}`;
    document.getElementById('vsw-modal').classList.remove('hidden');
}
document.getElementById('add-switch-btn').addEventListener('click', () => openVswModal(null));
document.getElementById('vsw-save').addEventListener('click', async () => {
    const hostname = document.getElementById('vsw-hostname').value.trim();
    if (!hostname) { alert('Hostname required'); return; }
    const payload = {
        id: _vswEditing || undefined,
        hostname,
        ports: parseInt(document.getElementById('vsw-ports').value) || 8,
        parent_mac: document.getElementById('vsw-parent')?.value || '',
    };
    await fetch('/api/virtual-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    _netSettings = await fetch('/api/network/settings').then(r => r.json()).catch(() => _netSettings);
    document.getElementById('vsw-modal').classList.add('hidden');
    fetch('/api/devices').then(r => r.json()).then(renderDevices);
});
document.getElementById('vsw-del').addEventListener('click', async () => {
    if (!_vswEditing || !confirm('Delete this virtual switch?')) return;
    await fetch(`/api/virtual-switch/${encodeURIComponent(_vswEditing)}`, { method: 'DELETE' });
    _netSettings = await fetch('/api/network/settings').then(r => r.json()).catch(() => _netSettings);
    document.getElementById('vsw-modal').classList.add('hidden');
    fetch('/api/devices').then(r => r.json()).then(renderDevices);
});
document.getElementById('vsw-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('vsw-modal')) document.getElementById('vsw-modal').classList.add('hidden');
});

// ── Work mode ─────────────────────────────────────────────────────────────
let _workMode = false;

function renderActiveUsers(users) {
    const el = $('users-list');
    const countEl = $('users-count');
    if (!el) return;
    if (countEl) countEl.textContent = users.length;
    if (!users.length) { el.innerHTML = '<div class="empty">No active users.</div>'; return; }
    el.innerHTML = users.map(u => `
        <div class="row ban clickable" data-lat="${u.lat}" data-lon="${u.lon}"
              data-ip="${escape(u.ip)}" data-country="${escape(u.country)}"
              data-isp="${escape(u.isp)}" data-user="${escape(u.username)}" data-node="${escape(u.node)}">
            <span class="port" style="min-width:48px;background:#06121a;color:var(--accent);">${escape(u.username)}</span>
            <div style="flex:1;min-width:0;padding-left:4px;">
                <div style="display:flex;justify-content:space-between;">
                    <span class="ip">${escape(u.ip)}</span>
                    <span class="meta" style="color:var(--muted);font-size:9px;">${escape(u.node)}</span>
                </div>
                <div style="color:#4d7479;font-size:10px;">${escape(u.country)}</div>
            </div>
        </div>`).join('');
    el.querySelectorAll('.ban.clickable').forEach(row => {
        row.addEventListener('click', () => {
            const lat = parseFloat(row.dataset.lat);
            const lon = parseFloat(row.dataset.lon);
            if (lat && lon) centerGlobeOn(lat, lon);
        });
    });
}

async function fetchActiveUsers() {
    try {
        const users = await fetch('/api/active_users').then(r => r.json());
        userArcs.length = 0;
        userPoints.length = 0;
        users.forEach((u, i) => {
            if (!u.lat && !u.lon) return; // show in panel but no arc without coordinates
            const colorBase = '#3b82f6';
            userArcs.push({
                startLat: u.lat, startLng: u.lon, endLat: HOME.lat, endLng: HOME.lon,
                color: [colorBase, colorBase],
                src_ip: u.ip, country: u.country, isp: u.isp, dst_port: 22,
                protocol: 'who', username: u.username, node: u.node,
            });
            userPoints.push({
                lat: u.lat, lon: u.lon, color: colorBase,
                radius: 0.4, alt: 0.01, protocol: 'who',
                username: u.username, node: u.node, ip: u.ip, country: u.country,
            });
        });
        renderActiveUsers(users);
        if (!_globePaused) _globeFlush();
    } catch {}
}
setInterval(() => { fetchActiveUsers(); }, 30000);

// ── Attack history ─────────────────────────────────────────────────────────
const _ATTACK_HIST_MAX_S = 24 * 3600;

function pushAttackHistory(entry) {
    const ts = entry.ts || entry.timestamp || null;
    const src_ip = entry.src_ip || entry.ip || '?';
    if (!src_ip || src_ip === '?') return;
    _attackHistory.unshift({
        ts, src_ip,
        country:  entry.country  || '?',
        isp:      entry.isp      || '—',
        dst_port: entry.dst_port || 22,
        protocol: entry.protocol || 'fail2ban',
        lat: entry.lat || 0,
        lon: entry.lon || 0,
    });
    // Prune to 24h
    if (ts) {
        const cutoff = Date.now() - _ATTACK_HIST_MAX_S * 1000;
        _attackHistory = _attackHistory.filter(e => !e.ts || new Date(e.ts).getTime() >= cutoff);
    } else if (_attackHistory.length > 200) {
        _attackHistory.length = 200;
    }
    if (!_histPaused) renderAttackHistory();
}

function _attackHistClick(row) {
    const lat = parseFloat(row.dataset.lat);
    const lon = parseFloat(row.dataset.lon);
    if (lat && lon) centerGlobeOn(lat, lon);
    card.classList.add('hot');
    acIp.textContent      = row.dataset.ip;
    acCountry.textContent = unescape(row.dataset.country);
    acIsp.textContent     = unescape(row.dataset.isp);
    acVec.textContent     = `:${row.dataset.port}/${row.dataset.protocol.toUpperCase()}`;
    clearTimeout(pushAttack._t);
    pushAttack._t = setTimeout(() => card.classList.remove('hot'), 10000);
}

function _fmtLocalTs(ts) {
    if (!ts) return { time: '—', date: '' };
    const d = new Date(ts);
    if (isNaN(d)) return { time: '—', date: '' };
    return {
        time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        date: d.toLocaleDateString([], { month: '2-digit', day: '2-digit' }),
    };
}

let _attackHistFilter = 'all';

function renderAttackHistory() {
    const filtered = _attackHistFilter === 'all'
        ? _attackHistory
        : _attackHistory.filter(b => (b.protocol || 'fail2ban') === _attackHistFilter);
    if (!filtered.length) {
        attackHistEl.innerHTML = `<div class="empty">No ${_attackHistFilter === 'all' ? '' : _attackHistFilter + ' '}attacks yet.</div>`;
        return;
    }
    const _PROTO_LABEL = { fail2ban: 'F2B', ssh: 'SSH', http: 'HTTP', https: 'HTTPS' };
    attackHistEl.innerHTML = filtered.slice(0, 10).map(b => {
        const { time, date } = _fmtLocalTs(b.ts);
        const proto = b.protocol || 'fail2ban';
        const label = _PROTO_LABEL[proto] || proto.toUpperCase();
        const col   = PROTO_COLOR[proto] || 'var(--accent)';
        return `<div class="row ban clickable" data-lat="${b.lat}" data-lon="${b.lon}"
                     data-ip="${escape(b.src_ip)}" data-country="${escape(b.country)}"
                     data-isp="${escape(b.isp)}" data-port="${b.dst_port}" data-protocol="${proto}">
            <span class="port" style="min-width:38px;text-align:center;align-self:center;color:${col};border-color:${col}44;">${label}</span>
            <div style="flex:1;min-width:0;padding-left:4px;">
                <div style="display:flex;justify-content:space-between;gap:4px;">
                    <span class="ip" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escape(b.src_ip)}</span>
                    <span class="meta" style="white-space:nowrap;">${time}</span>
                </div>
                <div style="display:flex;justify-content:space-between;gap:4px;">
                    <span style="color:#4d7479;font-size:10px;">${escape(b.country)}</span>
                    <span style="color:#4d7479;font-size:10px;white-space:nowrap;">${date}</span>
                </div>
            </div>
        </div>`;
    }).join('');
    attackHistEl.querySelectorAll('.ban.clickable').forEach(row => {
        row.addEventListener('click', () => _attackHistClick(row));
    });
}

// Wire attack history filter buttons
document.querySelectorAll('.hist-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        _attackHistFilter = btn.dataset.filter;
        document.querySelectorAll('.hist-filter-btn').forEach(b => {
            const active = b.dataset.filter === _attackHistFilter;
            b.style.background = active ? '#0e2228' : '#02060a';
            b.style.color      = active ? 'var(--accent)' : '#4d7479';
        });
        renderAttackHistory();
        if (!_globePaused) _globeFlush();
    });
});

function renderCountries(list) {
    ctyCountEl.textContent = list.length;
    if (!list.length) { countryListEl.innerHTML = '<div class="empty">No attacks yet.</div>'; return; }
    const max = Math.max(...list.map(c => c.hits));
    countryListEl.innerHTML = list.map(c => `
        <div class="row cty clickable" data-country="${escape(c.country)}">
            <span class="name">${escape(c.country)}</span>
            <span class="bar"><i style="width:${(c.hits/max*100)|0}%"></i></span>
            <span class="hits">${c.hits}</span>
        </div>`).join('');
    countryListEl.querySelectorAll('.cty.clickable').forEach(row => {
        row.addEventListener('click', () => {
            const country = row.dataset.country;
            const hit = _attackHistory.find(a => a.country === country && (a.lat || a.lon));
            if (hit) centerGlobeOn(hit.lat, hit.lon);
        });
    });
}

function pushLog(l, prepend = true) {
    const ts = new Date(l.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const row = document.createElement('div');
    row.className = `row level-${l.level || 'info'}`;
    const protoCol = l.proto ? (PROTO_COLOR[l.proto] || '') : '';
    const srcStyle = protoCol ? ` style="color:${protoCol}"` : '';
    row.innerHTML = `<span class="ts">${ts}</span>
        <span class="src ${l.source || 'system'}"${srcStyle}>${l.source || 'sys'}</span>
        <span class="msg">${escape(l.msg || '')}</span>`;
    if (prepend) logListEl.prepend(row); else logListEl.appendChild(row);
    while (logListEl.children.length > MAX_FEED) logListEl.lastChild.remove();
    logCountEl.textContent = logListEl.children.length;
}

function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function timeAgo(iso) {
    const t = new Date(iso).getTime();
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return `${s|0}s`;
    if (s < 3600) return `${(s/60)|0}m`;
    if (s < 86400) return `${(s/3600)|0}h`;
    return `${(s/86400)|0}d`;
}

function installHomeMarker() {
    homePoints.length = 0;
    homePoints.push({ lat: HOME.lat, lon: HOME.lon, color: '#00ffd5',
                      alt: 0.012, radius: 0.55, isHome: true });
    homeRings.length = 0;
    // Slow outer pulse (always visible) + fast inner blip
    homeRings.push({ lat: HOME.lat, lon: HOME.lon, maxR: 3.0, speed: 1.2,
                     period: 1600, color: t => `rgba(0,255,213,${0.55 * (1 - t)})` });
    homeRings.push({ lat: HOME.lat, lon: HOME.lon, maxR: 1.2, speed: 1.8,
                     period: 700,  color: t => `rgba(255,232,59,${0.6 * (1 - t)})` });
    globe.pointsData([...points, ...homePoints]);
    globe.ringsData([...rings, ...homeRings]);
}

async function loadStatic() {
    let cfg = {};
    try {
        cfg = await fetch('/api/config').then(r => r.json());
        _lastCfg = cfg;
        HOME = { lat: cfg.home_lat, lon: cfg.home_lon,
                 ip: cfg.home_ip, country: cfg.home_country, isp: cfg.home_isp };
        hudHome.textContent = cfg.home_ip
            ? `${cfg.home_ip} · ${cfg.home_country || '?'}`
            : `${cfg.home_lat},${cfg.home_lon}`;
        if (!cfg.sentinel_configured) {
            hudSentinel.textContent = 'OFF';
            hudSentinel.classList.remove('live', 'warn');
        } else if (cfg.sentinel_enabled) {
            hudSentinel.textContent = 'LINKED';
            hudSentinel.classList.remove('warn');
            hudSentinel.classList.add('live');
        } else {
            hudSentinel.textContent = 'DISCONNECTED';
            hudSentinel.classList.remove('live');
            hudSentinel.classList.add('warn');
        }
        installHomeMarker();
        globe.pointOfView({ lat: HOME.lat, lng: HOME.lon, altitude: 2.2 }, 0);

        // Tab visibility based on config flags
        applyTabVisibility(cfg);

        // Load blocklist / work IPS onto globe
        if (cfg.blocklist_enabled) loadBlocklist();
        // Load active users from DB
        fetchActiveUsers();
    } catch {}
    const fetches = [
        fetch('/api/bans').then(r => r.json()),
        fetch('/api/stats/countries').then(r => r.json()),
    ];
    // Only fetch devices and network settings in home mode
    if (!_workMode) {
        fetches.push(fetch('/api/devices').then(r => r.json()));
        fetches.push(fetch('/api/network/settings').then(r => r.json()).catch(() => ({})));
    }
    const results = await Promise.all(fetches);
    const [bans, ctys] = results;
    if (!_workMode) {
        const [, , devs, netCfgInit] = results;
        _netSettings = netCfgInit || {};
        renderDevices(devs || []);
    }
    bans.forEach(b => pushAttackHistory(b));
    renderCountries(ctys);
    loadCountryPolygons();
}

function applyTabVisibility(cfg) {
    _workMode = cfg.work_mode === true;

    const btnSecurity = $('tab-btn-security');
    const btnProxy    = $('tab-btn-proxy');
    const btnNetwork  = $('tab-btn-network');
    const settingsBtn = $('settings-btn');
    const lanPanel    = $('lan-panel');
    const usersPanel  = $('users-panel');
    const logPanel    = $('log-panel');
    const mainGrid    = document.querySelector('.grid');

    // Panels that use CSS `display:none` as default must be shown with explicit 'flex',
    // not '' (empty string), because '' just removes inline style and CSS default wins.
    const SHOW = 'flex';

    if (_workMode) {
        // Work mode: hide home-only tabs entirely
        if (btnSecurity) btnSecurity.style.display = 'none';
        if (btnProxy)    btnProxy.style.display    = 'none';
        if (btnNetwork)  btnNetwork.style.display  = 'none';
        if (settingsBtn) settingsBtn.style.display  = 'none';
        // lan-panel never shows in work mode
        if (lanPanel)    lanPanel.style.display    = 'none';
        // Auth-gated panels
        if (usersPanel)  usersPanel.style.display  = _isAuthenticated ? SHOW : 'none';
        if (logPanel)    logPanel.style.display    = _isAuthenticated ? SHOW : 'none';
        // Grid: swap countries to left, users to right
        if (mainGrid) {
            mainGrid.classList.remove('no-scanner');
            mainGrid.classList.add('work-layout');
        }
    } else {
        // Home mode: auth + config flags
        if (btnSecurity) btnSecurity.style.display = (_isAuthenticated && cfg.fsc_enabled !== false) ? '' : 'none';
        if (btnProxy)    btnProxy.style.display    = (_isAuthenticated && cfg.sniproxy_enabled)      ? '' : 'none';
        if (btnNetwork)  btnNetwork.style.display  = (_isAuthenticated && cfg.scanner_enabled)       ? '' : 'none';
        if (settingsBtn) settingsBtn.style.display  = _isAuthenticated ? '' : 'none';
        if (lanPanel)    lanPanel.style.display    = (_isAuthenticated && cfg.scanner_enabled)       ? SHOW : 'none';
        if (usersPanel)  usersPanel.style.display  = _isAuthenticated ? SHOW : 'none';
        if (logPanel)    logPanel.style.display    = _isAuthenticated ? SHOW : 'none';
        if (mainGrid) {
            mainGrid.classList.remove('work-layout');
            mainGrid.classList.toggle('no-scanner', !cfg.scanner_enabled || !_isAuthenticated);
        }
    }
}

async function loadBlocklist() {
    try {
        const data = await fetch('/api/blocklist').then(r => r.json());
        // Give blocklist entries a fixed 48h-old timestamp → orange-red color range
        const ts48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
        (data.entries || []).forEach(e => pushAttack({
            ...e, src_ip: e.ip, protocol: 'fail2ban', dst_port: 22, ts: ts48h
        }, false));
    } catch {}
}

function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/live`);
    ws.onopen = () => { wsStatusEl.textContent = 'ONLINE'; wsStatusEl.classList.add('live'); };
    ws.onclose = () => { wsStatusEl.textContent = 'OFFLINE'; wsStatusEl.classList.remove('live'); setTimeout(connectWS, 3000); };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'snapshot') {
            _globePaused = true; _histPaused = true;
            // Per-type quota: each type gets MAX_ARCS/3 slots so all are visible
            const _q = Math.floor(MAX_ARCS / 3);
            (m.bans          || []).slice(-_q).forEach(b => { pushAttack(b, false); pushAttackHistory(b); });
            (m.attacks       || []).slice(-_q).forEach(a => pushAttack(a, false));
            (m.proxy_attacks || []).slice(-_q).forEach(a => { pushAttack(a, false); pushAttackHistory(a); });
            _globePaused = false; _histPaused = false;
            _globeFlush(); renderAttackHistory();
            refreshCountryPolygons();
            (m.logs          || []).forEach(l => pushLog(l, false));
        } else if (m.type === 'attack' || m.type === 'ban') {
            pushAttack(m, true);
            if (m.type === 'ban' || m.source === 'proxy') pushAttackHistory(m);
            refreshCountryPolygons();
            pushLog({ level: 'attack',
                      source: m.type === 'ban' ? 'fail2ban' : m.source || 'honeypot',
                      proto: m.protocol || (m.type === 'ban' ? 'fail2ban' : 'ssh'),
                      ts: m.ts,
                      msg: `${(m.protocol||'?').toUpperCase()} :${m.dst_port} ← ${m.src_ip} (${m.country})` });
            // refresh stats every few attacks
            if (attackCount % 3 === 0) fetch('/api/stats/countries').then(r => r.json()).then(renderCountries);
        } else if (m.type === 'device') {
            fetch('/api/devices').then(r => r.json()).then(renderDevices);
        } else if (m.type === 'log') {
            pushLog(m, true);
        }
    };
}

$('report-btn').addEventListener('click', generateReport);

async function generateReport() {
    const btn = $('report-btn');
    if (btn) { btn.textContent = 'GENERATING…'; btn.disabled = true; }
    try {
        const d = await fetch('/api/report/data').then(r => r.json());
        const now = new Date();
        const lines = [
            `# SENTINEL-ALERT Report`,
            `**Generated:** ${now.toLocaleString()}`,
            '',
            '---',
            '',
            '## Summary (last 24 h)',
            `- Attacks: ${(d.attacks_24h||[]).length}`,
            `- Fail2ban bans: ${(d.bans_24h||[]).length}`,
            `- Proxy attacks (80/443): ${(d.proxy_attacks_24h||[]).length}`,
            '',
            ...(d.countries||[]).length ? ['### Top Attack Origins', '', ...(d.countries||[]).map(c=>`- ${c.country}: ${c.hits} hits`), ''] : [],
            '---',
            '',
            '## Attacks',
            '',
            '| Timestamp | IP | Protocol | Port | Country | ISP |',
            '|-----------|----|---------:|-----:|---------|-----|',
            ...(d.attacks_24h||[]).map(a=>`| ${(a.ts||'').substring(0,19)} | \`${a.src_ip}\` | ${a.protocol||'?'} | :${a.dst_port} | ${a.country||'?'} | ${a.isp||'—'} |`),
            '',
            '## Fail2ban Bans',
            '',
            '| Timestamp | IP | Country |',
            '|-----------|----|---------:|',
            ...(d.bans_24h||[]).map(b=>`| ${(b.ts||'').substring(0,19)} | \`${b.src_ip}\` | ${b.country||'?'} |`),
            '',
            '## Proxy Attacks (80/443)',
            '',
            '| Timestamp | IP | Protocol | Domain | Country |',
            '|-----------|----|---------:|--------|---------|',
            ...(d.proxy_attacks_24h||[]).map(a=>`| ${(a.ts||'').substring(0,19)} | \`${a.src_ip}\` | ${a.protocol||'?'} | ${a.domain||'—'} | ${a.country||'?'} |`),
            '',
            '## Devices',
            '',
            '| Hostname | IP | Status | Last Seen |',
            '|----------|----|--------|-----------|',
            ...(d.devices||[]).map(dv=>`| ${dv.hostname||'?'} | ${dv.ip} | ${dv.is_online?'ONLINE':'OFFLINE'} | ${(dv.last_seen||'—').substring(0,16)} |`),
            '',
            '---',
            '',
            '## System Logs',
            '',
            ...(d.logs||[]).map(l=>`- \`${(l.ts||'').substring(11,19)}\` [${l.level||'info'}] ${l.source||'sys'}: ${l.msg||''}`),
            '',
            '---',
            '_Sentinel-Alert — automated security report_',
        ];
        const md = lines.join('\n');
        const blob = new Blob([md], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `sentinel-${now.toISOString().substring(0,10)}.md`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) { alert('Report failed: ' + e.message); }
    if (btn) { btn.textContent = 'REPORT'; btn.disabled = false; }
}

// --- Settings modal ---
const _settingsModal = $('settings-modal');

function showResult(ok, msg) {
    const el = $('cfg-result');
    el.textContent = msg;
    el.className = 'cfg-result ' + (ok ? 'ok' : 'err');
}

function _statusDot(ok, labelOn, labelOff) {
    const color = ok ? 'var(--green)' : '#ff2a5e';
    const label = ok ? labelOn : labelOff;
    return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;color:${color};">
        <span style="width:7px;height:7px;border-radius:50%;background:${color};display:inline-block;"></span>${label}</span>`;
}

async function openSettings() {
    const cfgBody = $('cfg-body');
    const cfgResult = $('cfg-result');
    cfgBody.innerHTML = '<div style="padding:16px;color:#4d7479;">Loading…</div>';
    cfgResult.textContent = ''; cfgResult.className = 'cfg-result';
    _settingsModal.classList.remove('hidden');

    const [data, status] = await Promise.all([
        fetch('/api/config/full').then(r => r.json()).catch(() => null),
        fetch('/api/status').then(r => r.json()).catch(() => null),
    ]);

    if (!data) {
        cfgBody.innerHTML = `<div style="color:#ff2a5e;padding:16px;">Failed to load config.</div>`; return;
    }

    // Status section
    let statusHtml = '';
    if (status && !status.error) {
        const m = status.modules || {}, g = status.geoip || {}, db = status.database || {}, cf = status.config_file || {};
        statusHtml = `
        <div style="margin-bottom:16px;">
            <div style="font-size:9px;font-weight:800;letter-spacing:3px;color:#4d7479;border-bottom:1px solid #14333a;padding-bottom:3px;margin-bottom:10px;">SYSTEM STATUS</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;">
                <div>${_statusDot(g.city_db==='ok',  'GeoIP DB OK',        'GeoIP DB MISSING')}</div>
                <div>${_statusDot(g.asn_db==='ok',   'ASN DB OK',          'ASN DB MISSING')}</div>
                <div>${_statusDot(m.scanner,          'Scanner ON',         'Scanner OFF')}</div>
                <div>${_statusDot(m.security_center,  'Security Center ON', 'Security Center OFF')}</div>
                <div>${_statusDot(m.sniproxy,         'SNIProxy ON',        'SNIProxy OFF')}</div>
                <div>${_statusDot(m.sentinel,         'Sentinel ON',        'Sentinel OFF')}</div>
                <div>${_statusDot(m.blocklist,        'Blocklist ON',       'Blocklist OFF')}</div>
                <div>${_statusDot(cf.exists,          'Config file found',  'Config file missing — using defaults')}</div>
            </div>
            <div style="margin-top:10px;font-size:10px;color:#4d7479;display:flex;gap:16px;flex-wrap:wrap;">
                <span>DB: <b style="color:var(--fg)">${db.size_kb} KB</b></span>
                <span>Attacks: <b style="color:var(--fg)">${db.attacks}</b></span>
                <span>Bans: <b style="color:var(--fg)">${db.bans}</b></span>
                <span>Devices: <b style="color:var(--fg)">${db.devices}</b></span>
                <span>ISP cache: <b style="color:var(--fg)">${g.isp_cache}</b></span>
                ${g.unknown_isp_records > 0 ? `<span style="color:#ffb347;">⚠ ${g.unknown_isp_records} records missing ISP</span>` : ''}
            </div>
        </div>`;
    }

    const SENSITIVE = new Set(['token', 'ha_token', 'password', 'api_key', 'key']);
    const LABELS = { server:'SERVER', home:'HOME LOCATION', sentinel:'SENTINEL LINK',
        honeypot:'HONEYPOT', collector:'COLLECTOR', sniproxy:'SNIPROXY PROXY',
        scanner:'SCANNER', security_center:'SECURITY CENTER', threat:'THREAT INTEL' };
    const configHtml = Object.entries(data).map(([section, keys]) => `
        <div style="margin-bottom:14px;">
            <div style="font-size:9px;font-weight:800;letter-spacing:3px;color:#4d7479;border-bottom:1px solid #14333a;padding-bottom:3px;margin-bottom:8px;">${LABELS[section]||section.toUpperCase()}</div>
            ${Object.entries(keys).map(([key, val]) => `
                <div style="margin-bottom:6px;">
                    <div style="font-size:9px;letter-spacing:1px;color:#4d7479;margin-bottom:2px;">${key.toUpperCase()}</div>
                    <input type="${SENSITIVE.has(key)?'password':'text'}" data-section="${section}" data-key="${key}"
                        value="${escape(String(val))}"
                        style="width:100%;padding:4px 7px;background:#0a1418;color:var(--fg);border:1px solid #1a4046;font-family:inherit;font-size:11px;outline:none;">
                </div>`).join('')}
        </div>`).join('');

    cfgBody.innerHTML = statusHtml + configHtml;
}

$('settings-btn').addEventListener('click', openSettings);
$('cfg-close').addEventListener('click', () => _settingsModal.classList.add('hidden'));
$('cfg-close2').addEventListener('click', () => _settingsModal.classList.add('hidden'));
_settingsModal.addEventListener('click', (e) => { if (e.target === _settingsModal) _settingsModal.classList.add('hidden'); });

$('cfg-save').addEventListener('click', async () => {
    const payload = {};
    $('cfg-body').querySelectorAll('input[data-section]').forEach(inp => {
        const s = inp.dataset.section, k = inp.dataset.key;
        if (!payload[s]) payload[s] = {};
        payload[s][k] = inp.value;
    });
    try {
        const res = await fetch('/api/config/update', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).then(r => r.json());
        showResult(res.ok, res.ok ? '✓ Saved — restart service for changes to take effect' : `Error: ${res.error||'unknown'}`);
    } catch (e) { showResult(false, e.message); }
});

$('cfg-test').addEventListener('click', async () => {
    showResult(true, 'Testing Sentinel connection…');
    try {
        const res = await fetch('/api/sentinel/test', { method: 'POST' }).then(r => r.json());
        showResult(res.ok, res.ok ? `✓ Connected · HTTP ${res.status}` : `FAIL · ${res.detail||''}`);
    } catch (e) { showResult(false, e.message); }
});

$('cfg-export').addEventListener('click', () => { window.location.href = '/api/config/export'; });

setInterval(() => { hudClock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }, 1000);
setInterval(loadStatic, 60000);

// ── Auth ─────────────────────────────────────────────────────────────────────
const _loginOverlay = $('login-overlay');
const _loginErr     = $('login-err');
const _loginSubmit  = $('login-submit');

let _isAuthenticated = false;

function applyAuthState(authenticated) {
    _isAuthenticated = authenticated;

    // Show/hide auth-only header elements
    document.querySelectorAll('.auth-only').forEach(el => {
        el.style.display = authenticated ? '' : 'none';
    });

    // Tab buttons (except Threat Map) require auth
    document.querySelectorAll('.tab-btn:not([data-tab="threat"])').forEach(btn => {
        btn.style.display = authenticated ? '' : 'none';
    });

    const lanPanel   = $('lan-panel');
    const logPanel   = $('log-panel');
    const usersPanel = $('users-panel');

    if (!authenticated) {
        // Explicit hide of auth-gated panels (CSS default already hides them,
        // this ensures they're re-hidden after logout)
        if (lanPanel)   lanPanel.style.display   = 'none';
        if (logPanel)   logPanel.style.display   = 'none';
        if (usersPanel) usersPanel.style.display = 'none';
    }

    if (_workMode) {
        // Work mode overrides: home-only tabs/panels stay hidden regardless of auth
        ['settings-btn', 'tab-btn-security', 'tab-btn-proxy', 'tab-btn-network', 'tab-btn-services'].forEach(id => {
            const el = $(id); if (el) el.style.display = 'none';
        });
        if (lanPanel) lanPanel.style.display = 'none';
        // Auth-gated work panels (must use 'flex', not '', to override CSS default none)
        if (authenticated) {
            if (usersPanel) usersPanel.style.display = 'flex';
            if (logPanel)   logPanel.style.display   = 'flex';
            fetchActiveUsers();
        }
    } else if (authenticated) {
        // Home mode: show users panel when authenticated
        if (usersPanel) usersPanel.style.display = 'flex';
        fetchActiveUsers();
    }

    const loginHeaderBtn = $('login-btn');
    if (loginHeaderBtn) loginHeaderBtn.style.display = authenticated ? 'none' : '';
    if (authenticated) _loginOverlay.classList.add('hidden');
    // Adjust grid layout for logged-out state (hides empty left column)
    const gridEl = document.querySelector('.grid');
    if (gridEl) gridEl.classList.toggle('no-auth', !authenticated);
}

async function checkAuth() {
    const r = await fetch('/api/auth/status').then(x => x.json()).catch(() => ({ authenticated: false }));
    applyAuthState(r.authenticated);
    return r.authenticated;
}

// Open login modal
$('login-btn').addEventListener('click', () => {
    $('login-user').value = '';
    $('login-pass').value = '';
    _loginErr.textContent = '';
    _loginOverlay.classList.remove('hidden');
    setTimeout(() => $('login-user').focus(), 50);
});
$('login-close').addEventListener('click', () => _loginOverlay.classList.add('hidden'));
_loginOverlay.addEventListener('click', e => { if (e.target === _loginOverlay) _loginOverlay.classList.add('hidden'); });

_loginSubmit.addEventListener('click', async () => {
    _loginErr.textContent = '';
    _loginSubmit.disabled = true;
    _loginSubmit.textContent = '…';
    const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('login-user').value, password: $('login-pass').value }),
    }).then(x => x.json()).catch(() => ({ ok: false, error: 'Network error' }));
    _loginSubmit.disabled = false;
    _loginSubmit.textContent = 'LOGIN';
    if (r.ok) {
        applyAuthState(true);
        applyTabVisibility(_lastCfg);
    } else {
        _loginErr.textContent = r.error || 'Invalid credentials';
    }
});
$('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') _loginSubmit.click(); });

$('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    applyAuthState(false);
});

checkAuth().then(() => loadStatic().then(connectWS));

// Globe rotation toggle
$('globe-rotate-btn').addEventListener('click', () => _setRotation(_rotationLocked));

// Fullscreen button handlers
document.querySelectorAll('.btn-fullscreen').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const panelId = btn.dataset.target;
        const panel = document.getElementById(panelId);
        if (!panel) return;
        const isFullscreen = panel.classList.toggle('fullscreen');
        document.body.classList.toggle('has-fullscreen', isFullscreen);
        btn.textContent = isFullscreen ? '⤢' : '⛶';
        // Resize globe if needed
        setTimeout(() => {
            if (panelId === 'globe-panel' && globe) {
                globe.width(document.getElementById('globe-viz').clientWidth)
                    .height(document.getElementById('globe-viz').clientHeight);
            }
        }, 50);
    });
});

// ESC to exit fullscreen
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const fullscreen = document.querySelector('.panel.fullscreen');
        if (fullscreen) {
            const btn = fullscreen.querySelector('.btn-fullscreen');
            if (btn) btn.click();
        }
    }
});

// ===== TOPOLOGY MAP =====
let topoData = { nodes: [], links: [] };
let topoDevices = new Map();
let topoEdit = false;
let topoLinkArm = null;
let topoDragging = null;

const topoModal = document.getElementById('topo-modal');
const topoSvg = document.getElementById('topo-svg');

// Load topology from API
async function loadTopology() {
    try {
        topoData = await fetch('/api/topo-data').then(r => r.ok ? r.json() : { nodes: [], links: [] }).catch(() => ({ nodes: [], links: [] }));
        const devs = await fetch('/api/devices').then(r => r.json()).catch(() => []);
        topoDevices = new Map(devs.map(d => [d.mac, d]));
        renderTopology();
    } catch (e) {
        console.error('Load topology failed:', e);
    }
}

function renderTopology() {
    if (!topoData.nodes.length) return;

    const width = topoSvg.clientWidth || 800;
    const height = topoSvg.clientHeight || 600;
    topoSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    let svg = `<g>`;

    // Draw links
    (topoData.links || []).forEach((link, i) => {
        const a = topoData.nodes.find(n => n.id === link.source);
        const b = topoData.nodes.find(n => n.id === link.target);
        if (a && b) {
            svg += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#00ffd5" stroke-width="1" class="topo-link" data-i="${i}"/>`;
        }
    });

    // Draw nodes
    (topoData.nodes || []).forEach(n => {
        const dev = topoDevices.get(n.mac);
        const online = !dev || dev.is_online;
        const color = online ? '#2dffa1' : '#999';
        svg += `<g class="topo-node" data-mac="${n.mac}" data-x="${n.x}" data-y="${n.y}">
            <circle cx="${n.x}" cy="${n.y}" r="8" fill="${color}" stroke="#00ffd5" stroke-width="1.5"/>
            <text x="${n.x}" y="${n.y + 16}" text-anchor="middle" font-size="10" fill="#cfe7ec">${n.label || n.hostname || 'host'}</text>
        </g>`;
    });

    svg += `</g>`;
    topoSvg.innerHTML = svg;

    // Add link deletion listeners
    topoSvg.querySelectorAll('.topo-link').forEach(line => {
        line.style.cursor = topoEdit ? 'pointer' : 'default';
        line.addEventListener('click', (e) => {
            if (!topoEdit) return;
            e.stopPropagation();
            const i = parseInt(line.dataset.i);
            topoData.links.splice(i, 1);
            renderTopology();
        });
    });

    // Add event listeners
    topoSvg.querySelectorAll('.topo-node').forEach(g => {
        g.style.cursor = topoEdit ? 'grab' : 'pointer';
        g.addEventListener('mousedown', (e) => {
            if (!topoEdit) return;
            e.preventDefault();
            const mac = g.dataset.mac;
            const node = topoData.nodes.find(n => n.mac === mac);
            if (!node) return;
            topoDragging = { node, startX: e.clientX, startY: e.clientY, x: node.x, y: node.y };
        });
        g.addEventListener('click', (e) => {
            if (topoDragging) return;
            const mac = g.dataset.mac;
            // Link creation mode
            if (topoLinkArm === 'armed') {
                topoLinkArm = mac;
                document.getElementById('topo-hint').textContent = 'Click second node to complete link...';
                return;
            }
            if (topoLinkArm && topoLinkArm !== 'armed' && topoLinkArm !== mac) {
                topoData.links.push({ source: topoLinkArm, target: mac });
                topoLinkArm = null;
                document.getElementById('topo-hint').textContent = '';
                renderTopology();
                return;
            }
            // Show device details
            const dev = topoDevices.get(mac);
            if (dev) alert(`${dev.hostname || dev.ip}\nIP: ${dev.ip}\nMAC: ${dev.mac}`);
        });
    });

    document.addEventListener('mousemove', (e) => {
        if (topoDragging) {
            const rect = topoSvg.getBoundingClientRect();
            const dx = e.clientX - topoDragging.startX;
            const dy = e.clientY - topoDragging.startY;
            topoDragging.node.x = topoDragging.x + dx / (rect.width / 800);
            topoDragging.node.y = topoDragging.y + dy / (rect.height / 600);
            renderTopology();
        }
    });

    document.addEventListener('mouseup', () => { topoDragging = null; });
}

// Topology button handlers
document.getElementById('topo-close').addEventListener('click', () => {
    topoModal.classList.add('hidden');
});

document.getElementById('topo-edit-btn').addEventListener('click', () => {
    topoEdit = !topoEdit;
    topoLinkArm = null;
    document.getElementById('topo-edit-btn').classList.toggle('primary', topoEdit);
    document.getElementById('topo-hint').textContent = topoEdit ? 'EDIT MODE' : '';
    renderTopology();
});

document.getElementById('topo-add-node').addEventListener('click', () => {
    const hostname = prompt('Hostname:');
    if (hostname) {
        topoData.nodes.push({
            id: `node-${Date.now()}`,
            mac: `${Math.random().toString(16).slice(2, 10)}`,
            hostname: hostname,
            x: Math.random() * 600 + 100,
            y: Math.random() * 400 + 100,
            label: hostname
        });
        renderTopology();
    }
});

document.getElementById('topo-add-link').addEventListener('click', () => {
    topoLinkArm = 'armed';
    document.getElementById('topo-hint').textContent = 'Click first node to start link...';
});

document.getElementById('topo-save-btn').addEventListener('click', async () => {
    try {
        await fetch('/api/topo-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(topoData)
        });
        alert('Topology saved!');
    } catch (e) {
        alert('Save failed: ' + e.message);
    }
});

document.getElementById('topo-reseed-btn').addEventListener('click', () => {
    if (!confirm('Reseed topology from current devices?')) return;
    const devs = Array.from(topoDevices.values());
    topoData.nodes = devs.map((d, i) => ({
        id: `node-${d.mac}`,
        mac: d.mac,
        hostname: d.hostname || d.ip,
        label: d.hostname || d.ip,
        x: 100 + (i % 5) * 150,
        y: 100 + Math.floor(i / 5) * 150
    }));
    topoData.links = [];
    renderTopology();
});

topoModal.addEventListener('click', (e) => {
    if (e.target === topoModal) topoModal.classList.add('hidden');
});

// Detail modal click outside to close
const detailModal = document.getElementById('detail-modal');
detailModal.addEventListener('click', (e) => {
    if (e.target === detailModal) detailModal.classList.add('hidden');
});

// ================================================================
// TAB SWITCHING
// ================================================================
const TAB_IDS = { threat: 'tab-threat', security: 'tab-security', proxy: 'tab-proxy', network: 'tab-network', services: 'tab-services' };
let _activeTab = 'threat';

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab === _activeTab) return;
        // Pause globe WebGL loop when leaving threat tab, resume on return
        if (_activeTab === 'threat') {
            globe.pauseAnimation();
            _globePaused = true;
        } else if (tab === 'threat') {
            globe.resumeAnimation();
            _globePaused = false;
            _globeFlush();
        }
        _activeTab = tab;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        Object.entries(TAB_IDS).forEach(([k, id]) => {
            document.getElementById(id).classList.toggle('hidden', k !== tab);
        });
        if (tab === 'security') { fscInit(); fscUpdate(); fscLoadHosts(); }
        if (tab === 'proxy')    { pscInit(); pscUpdate(); }
        if (tab === 'network')  { netInit(); }
        if (tab === 'services') { svcInit(); }
    });
});

// ================================================================
// SECURITY CENTER (FSC)
// ================================================================
let _fscCharts = {};
let _fscInterval = null;
let _fscInitDone = false;

function fscInit() {
    if (_fscInitDone) return;
    _fscInitDone = true;
    Chart.register(ChartDataLabels);

    _fscCharts.upd = new Chart(document.getElementById('fsc-upd-chart').getContext('2d'), {
        type: 'bar',
        data: {
            labels: [],
            datasets: [
                { label: 'Normal', data: [], backgroundColor: '#38bdf8', borderRadius: 2, stack: 'S' },
                { label: 'Low CVE', data: [], backgroundColor: '#ffe83b', borderRadius: 2, stack: 'S' },
                { label: 'High CVE', data: [], backgroundColor: '#f97316', borderRadius: 2, stack: 'S' },
                { label: 'Critical CVE', data: [], backgroundColor: '#ff2a5e', borderRadius: 2, stack: 'S' },
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#4d7479', font: { size: 9 }, boxWidth: 10 } },
                datalabels: { color: '#fff', font: { weight: 'bold', size: 9 }, formatter: v => v > 0 ? v : '' }
            },
            scales: {
                x: { stacked: true, grid: { display: false }, ticks: { color: '#4d7479', font: { size: 9 } } },
                y: { stacked: true, grid: { color: '#0e2226' }, ticks: { color: '#4d7479', font: { size: 9 } } }
            }
        }
    });

    _fscCharts.os = new Chart(document.getElementById('fsc-os-chart').getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: [],
            datasets: [{ data: [], backgroundColor: ['#00ffd5','#2dffa1','#ffe83b','#b878ff','#ff2a5e','#38bdf8'], borderWidth: 0 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: '#4d7479', font: { size: 9 }, boxWidth: 10 } },
                datalabels: {
                    color: '#fff', font: { weight: 'bold', size: 9 },
                    formatter: (v, ctx) => { const s = ctx.dataset.data.reduce((a, b) => a + b, 0); return Math.round(v / s * 100) + '%'; }
                }
            },
            cutout: '65%'
        }
    });

    _fscInterval = setInterval(fscUpdate, 2000);
}

function fscHealthScore(s) {
    if (!s.online || String(s.os).startsWith('ERR')) return { score: 0, grade: 'F', cls: 'fsc-grade-f' };
    let score = 100;
    const eol = s.eol_status;
    if (eol && eol !== 'supported' && eol !== 'unknown') score -= 60;
    if (s.reboot_req === 'yes') score -= 10;
    score -= (s.cve_crit * 8);
    score -= (s.cve_high * 4);
    score -= (s.cve_med * 1);
    if (String(s.root_ssh).toLowerCase() === 'yes') score -= 15;
    if (s.fail2ban !== 'active') score -= 15;
    if (s.nopass_users > 0) score -= 30;
    if (s.firewall === 'inactive') score -= 15;
    if (s.mac === 'none') score -= 5;
    if (score < 0) score = 0;
    if (eol && eol !== 'supported' && eol !== 'unknown') return { score, grade: 'EOL', cls: 'fsc-grade-eol' };
    if (score >= 90) return { score, grade: 'A', cls: 'fsc-grade-a' };
    if (score >= 70) return { score, grade: 'B', cls: 'fsc-grade-b' };
    if (score >= 40) return { score, grade: 'C', cls: 'fsc-grade-c' };
    return { score, grade: 'D', cls: 'fsc-grade-d' };
}

function fscRecommendations(s) {
    const recs = [];
    if (!s.online) {
        recs.push(['warn', 'Server offline (ping failed).']);
    } else if (String(s.os).startsWith('ERR')) {
        recs.push(['crit', `SSH error: ${s.os}`]);
    } else {
        const eol = s.eol_status;
        if (eol && eol !== 'supported' && eol !== 'unknown')
            recs.push(['crit', 'OS is END OF LIFE — no more security patches! Plan distribution upgrade immediately.']);
        if (s.reboot_req === 'yes')
            recs.push(['warn', 'Reboot required (new kernel or libs installed).']);
        if (String(s.root_ssh).toLowerCase() === 'yes')
            recs.push(['high', 'Root SSH login enabled. Set PermitRootLogin prohibit-password in sshd_config.']);
        if (s.nopass_users > 0)
            recs.push(['crit', 'User without password found in /etc/shadow.']);
        if (s.cve_crit > 0)
            recs.push(['crit', `Critical CVEs present (kernel/ssh/ssl). Run apt upgrade immediately.`]);
        else if (s.sec_updates > 0)
            recs.push(['high', `${s.sec_updates} security updates pending. Run apt upgrade.`]);
        if (s.fail2ban !== 'active')
            recs.push(['crit', 'Fail2Ban not running — brute force protection absent.']);
        else if (!s.f2b_jails || s.f2b_jails === 'none')
            recs.push(['warn', 'Fail2Ban running but no active jails defined (e.g. sshd).']);
        if (s.firewall === 'inactive')
            recs.push(['high', 'No local firewall active (UFW/nftables/iptables).']);
        if (s.mac === 'none')
            recs.push(['warn', 'No MAC module active (AppArmor/SELinux).']);
        if (parseInt(s.disk) > 90)
            recs.push(['warn', `Disk usage at ${s.disk}% — clean up storage.`]);
        if (parseInt(s.mem) > 90)
            recs.push(['warn', `RAM usage at ${s.mem}% — system under pressure.`]);
        if (recs.length === 0)
            recs.push(['good', `Grade A — no issues detected. Score: ${fscHealthScore(s).score}/100.`]);
    }
    return recs.map(([lvl, msg]) =>
        `<li><span class="fsc-rec-${lvl}">[${lvl.toUpperCase()}]</span> ${escape(msg)}</li>`
    ).join('');
}

function fscPkgBadge(pkg) {
    if (!pkg) return '';
    const p = pkg.toLowerCase();
    const crit = ['linux', 'kernel', 'ssh', 'ssl', 'sudo', 'bash', 'systemd', 'libc', 'crypt', 'pve'];
    const high = ['apache', 'nginx', 'php', 'python', 'curl', 'wget', 'mysql', 'maria', 'postgre', 'docker', 'qemu', 'bind'];
    if (crit.some(k => p.includes(k))) return `<span class="fsc-pkg-item fsc-pkg-crit"><b>CRIT:</b> ${escape(pkg)}</span>`;
    if (high.some(k => p.includes(k))) return `<span class="fsc-pkg-item fsc-pkg-high"><b>HIGH:</b> ${escape(pkg)}</span>`;
    return `<span class="fsc-pkg-item fsc-pkg-low"><b>LOW:</b> ${escape(pkg)}</span>`;
}

function fscResColor(v) {
    if (v > 90) return '#ff2a5e';
    if (v > 75) return '#ffe83b';
    return '#2dffa1';
}

function fscRenderRow(s, idx) {
    const h = fscHealthScore(s);
    const rowId = `fsc-det-${idx}`;

    if (!s.online) {
        return `
        <tr onclick="fscToggle('${rowId}')">
            <td style="color:#4d7479;font-weight:bold;">${escape(s.name)}<br><span style="font-size:9px;color:#4d7479">${escape(s.ip)}</span></td>
            <td><span class="fsc-badge fsc-b-red">OFFLINE</span></td>
            <td colspan="7"></td>
        </tr>
        <tr id="${rowId}" class="fsc-detail-row hidden">
            <td colspan="9" style="color:#4d7479">Cannot connect (ping failed).</td>
        </tr>`;
    }

    const eol = s.eol_status;
    const isEol = eol && eol !== 'supported' && eol !== 'unknown';
    const eolTag = isEol ? `<span class="fsc-badge fsc-b-red" style="margin-right:4px;animation:pulse 1.5s infinite">EOL</span>` : '';
    const osHtml = String(s.os).startsWith('ERR')
        ? `<span style="color:var(--red);font-size:9px">${escape(s.os)}</span>`
        : `${eolTag}<span style="color:var(--muted);font-size:10px" title="${escape(s.os)}">${escape(s.os)}</span><br><span style="font-size:9px;color:#38bdf8">KER: ${escape(s.kernel)}</span>`;

    let uptStr = escape(s.uptime);
    if (s.reboot_req === 'yes') uptStr += ' <span style="color:var(--yellow)" title="Reboot req">⚠</span>';

    const resHtml = `
        <div style="font-size:9px;color:var(--muted);min-width:80px">
            <div>CPU: ${escape(s.load)} | UP: ${uptStr}</div>
            <div>RAM: ${s.mem}%<div class="fsc-res-bar"><i style="width:${s.mem}%;background:${fscResColor(s.mem)}"></i></div></div>
            <div>DSK: ${s.disk}%<div class="fsc-res-bar"><i style="width:${s.disk}%;background:${fscResColor(s.disk)}"></i></div></div>
        </div>`;

    const rootBadge = String(s.root_ssh).toLowerCase() === 'yes'
        ? `<span class="fsc-badge fsc-b-red">EXPOSED</span>`
        : `<span class="fsc-badge fsc-b-green">SECURE</span>`;

    const f2bBadge = s.fail2ban === 'active'
        ? `<span class="fsc-badge fsc-b-green" title="Jails: ${escape(s.f2b_jails || '?')}">ACTIVE</span>`
        : `<span class="fsc-badge fsc-b-red">INACTIVE</span>`;

    const secVal = s.sec_updates > 0
        ? `<span style="color:var(--red);font-weight:900">${s.sec_updates}</span>`
        : `<span style="color:var(--green)">0</span>`;

    const srvBadges = [];
    if (s.firewall && s.firewall !== 'inactive') srvBadges.push(`<span class="fsc-badge fsc-b-blue">FW:${escape(s.firewall)}</span>`);
    if (s.mac && s.mac !== 'none') srvBadges.push(`<span class="fsc-badge fsc-b-green">MAC:${escape(s.mac)}</span>`);
    if (s.lxcs > 0) srvBadges.push(`<span class="fsc-badge fsc-b-purple">${s.lxcs}LXC</span>`);
    if (s.vms > 0) srvBadges.push(`<span class="fsc-badge fsc-b-purple">${s.vms}VM</span>`);

    // Detail section
    const portsHtml = s.ports_list
        ? s.ports_list.split(',').map(p => {
            const [num, svc] = p.split(':');
            return `<div class="fsc-port-item"><span class="fsc-port-num">${escape(num)}</span><span class="fsc-port-svc">${escape(svc || '?')}</span></div>`;
          }).join('')
        : `<span style="color:var(--muted);font-size:10px">No listening ports</span>`;

    const pkgsHtml = s.sec_packages
        ? s.sec_packages.split(',').map(fscPkgBadge).join('')
        : `<span style="color:var(--green);font-size:10px">✔ System fully up to date</span>`;

    return `
    <tr onclick="fscToggle('${rowId}')">
        <td>
            <div style="color:var(--accent);font-weight:bold">${escape(s.name)}</div>
            <div style="font-size:9px;color:var(--muted)">${escape(s.ip)}</div>
        </td>
        <td>${osHtml}</td>
        <td>${resHtml}</td>
        <td>
            <span style="color:var(--fg);font-weight:bold;font-size:14px">${s.updates}</span>
            <span style="font-size:9px;color:var(--muted)"> (${secVal})</span>
        </td>
        <td><span class="fsc-grade ${h.cls}">${h.grade}</span></td>
        <td>${rootBadge}</td>
        <td>${f2bBadge}</td>
        <td><div style="display:flex;flex-direction:column;gap:2px">${srvBadges.join('') || '<span style="color:#4d7479">—</span>'}</div></td>
        <td style="text-align:right;color:var(--muted);font-size:9px">${escape(s.last_check)}</td>
    </tr>
    <tr id="${rowId}" class="fsc-detail-row hidden">
        <td colspan="9">
            <div class="fsc-detail-grid">
                <div class="fsc-detail-box">
                    <h4 style="color:var(--accent)">◤ PORT MAP</h4>
                    <div class="fsc-port-list">${portsHtml}</div>
                </div>
                <div class="fsc-detail-box">
                    <h4 style="color:var(--red)">◤ VULNERABLE PACKAGES</h4>
                    <div class="fsc-pkg-scroll">${pkgsHtml}</div>
                </div>
                <div class="fsc-detail-box">
                    <h4 style="color:#f97316">◤ SOC RECOMMENDATIONS (${h.score}/100)</h4>
                    <ul class="fsc-rec-list">${fscRecommendations(s)}</ul>
                </div>
            </div>
        </td>
    </tr>`;
}

function fscToggle(id) {
    document.getElementById(id)?.classList.toggle('hidden');
}

async function fscUpdate() {
    try {
        const data = await fetch('/api/fsc/data').then(r => r.json());
        const sys = data.system;
        const stats = data.stats;

        // Toolbar
        const scanning = sys.scan_in_progress;
        const statusEl = document.getElementById('fsc-scan-status');
        statusEl.textContent = scanning ? 'SCANNING...' : 'IDLE';
        statusEl.style.color = scanning ? 'var(--yellow)' : 'var(--green)';
        document.getElementById('fsc-last-scan').textContent = sys.last_scan_time;
        document.getElementById('fsc-next-scan').textContent = sys.next_scan_time;
        const scanBtn = document.getElementById('fsc-scan-btn');
        scanBtn.disabled = scanning;
        scanBtn.style.opacity = scanning ? '0.5' : '1';

        // Stats
        document.getElementById('fsc-st-total').textContent  = stats.total;
        document.getElementById('fsc-st-online').textContent = stats.online;
        document.getElementById('fsc-st-offline').textContent = stats.offline;
        document.getElementById('fsc-st-sec').textContent    = stats.sec_alerts;
        document.getElementById('fsc-st-root').textContent   = stats.exposed_roots;
        document.getElementById('fsc-st-fw').textContent     = stats.firewalls_active;
        document.getElementById('fsc-st-lxc').textContent    = stats.lxcs;
        document.getElementById('fsc-st-vm').textContent     = stats.vms;

        const hosts = Object.values(data.inventory);

        // OS chart
        const osCounts = {};
        hosts.filter(h => h.online).forEach(h => {
            let name = String(h.os).startsWith('ERR') ? 'Connection Failed'
                : (() => {
                    const clean = h.os.replace(/ GNU\/Linux/i, '').replace(/ LTS/i, '');
                    const parts = clean.split(' ');
                    let n = parts.length > 1 ? parts[0] + ' ' + parts[1] : parts[0] || 'Unknown';
                    if (h.eol_status && h.eol_status !== 'supported' && h.eol_status !== 'unknown') n += ' (EOL)';
                    return n;
                })();
            osCounts[name] = (osCounts[name] || 0) + 1;
        });
        _fscCharts.os.data.labels = Object.keys(osCounts);
        _fscCharts.os.data.datasets[0].data = Object.values(osCounts);
        _fscCharts.os.update();

        // Update chart
        const hostsWithUpd = hosts.filter(h => h.online && (h.updates > 0 || h.sec_updates > 0))
                                   .sort((a, b) => b.updates - a.updates);
        _fscCharts.upd.data.labels = hostsWithUpd.map(h => h.name);
        _fscCharts.upd.data.datasets[0].data = hostsWithUpd.map(h => Math.max(0, h.updates - h.sec_updates));
        _fscCharts.upd.data.datasets[1].data = hostsWithUpd.map(h => h.cve_med);
        _fscCharts.upd.data.datasets[2].data = hostsWithUpd.map(h => h.cve_high);
        _fscCharts.upd.data.datasets[3].data = hostsWithUpd.map(h => h.cve_crit);
        _fscCharts.upd.update();

        // Remember which detail rows are open
        const openIds = new Set();
        document.querySelectorAll('.fsc-detail-row:not(.hidden)').forEach(r => openIds.add(r.id));

        // Render table
        document.getElementById('fsc-tbody').innerHTML = hosts.map((s, i) => fscRenderRow(s, i)).join('');

        // Re-open previously open rows
        openIds.forEach(id => document.getElementById(id)?.classList.remove('hidden'));

    } catch (e) {
        console.error('FSC update failed:', e);
    }
}

function fscTriggerScan() {
    const btn = document.getElementById('fsc-scan-btn');
    btn.disabled = true;
    btn.style.opacity = '0.5';
    fetch('/api/fsc/scan', { method: 'POST' }).then(() => fscUpdate());
}

// ================================================================
// FSC HOST PANEL
// ================================================================
let _fscHostsPanelOpen = false;

function fscToggleHostsPanel() {
    _fscHostsPanelOpen = !_fscHostsPanelOpen;
    document.getElementById('fsc-hosts-list').classList.toggle('hidden', !_fscHostsPanelOpen);
    const icon = document.getElementById('fsc-hosts-chevron');
    if (icon) icon.style.transform = _fscHostsPanelOpen ? 'rotate(180deg)' : '';
    if (_fscHostsPanelOpen) fscLoadHosts();
}

async function fscLoadHosts() {
    try {
        const data = await fetch('/api/fsc/hosts').then(r => r.json());
        const hosts = data.hosts || [];
        const countEl = document.getElementById('fsc-hosts-count');
        const enabled = hosts.filter(h => h.enabled).length;
        if (countEl) countEl.textContent = `${enabled} / ${hosts.length} enabled`;

        if (!_fscHostsPanelOpen) return;
        const list = document.getElementById('fsc-hosts-list');
        list.innerHTML = hosts.map(h => `
            <div class="fsc-host-item ${h.enabled ? 'enabled' : 'disabled'}" id="fsc-host-${h.ip.replace(/\./g, '-')}">
                <label class="fsc-toggle" title="${h.enabled ? 'Click to disable' : 'Click to enable'}">
                    <input type="checkbox" ${h.enabled ? 'checked' : ''} onchange="fscToggleHost('${escape(h.ip)}', this)">
                    <span class="fsc-toggle-slider"></span>
                </label>
                <span class="fsc-host-name">${escape(h.name)}</span>
                <span class="fsc-host-ip">${escape(h.ip)}</span>
            </div>`).join('');
    } catch (e) {
        console.error('fscLoadHosts failed:', e);
    }
}

async function fscToggleHost(ip, checkbox) {
    try {
        const r = await fetch('/api/fsc/hosts/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip }),
        }).then(r => r.json());

        const key = ip.replace(/\./g, '-');
        const item = document.getElementById(`fsc-host-${key}`);
        if (item) {
            item.classList.toggle('enabled',  r.enabled);
            item.classList.toggle('disabled', !r.enabled);
        }
        // Refresh count
        const countEl = document.getElementById('fsc-hosts-count');
        if (countEl) {
            const list = document.getElementById('fsc-hosts-list');
            const total   = list.querySelectorAll('.fsc-host-item').length;
            const checked = list.querySelectorAll('input[type=checkbox]:checked').length;
            countEl.textContent = `${checked} / ${total} enabled`;
        }
    } catch (e) {
        checkbox.checked = !checkbox.checked; // revert on error
    }
}

// ================================================================
// PROXY MONITOR (PSC)
// ================================================================
let _pscCharts = {};
let _pscInterval = null;
let _pscInitDone = false;

const PSC_COLORS = ['#00ffd5','#2dffa1','#ffe83b','#b878ff','#ff2a5e','#38bdf8','#f97316','#ec4899'];

function pscInit() {
    if (_pscInitDone) return;
    _pscInitDone = true;
    Chart.register(ChartDataLabels);

    const lineOpts = (label, color) => ({
        type: 'line',
        data: { labels: [], datasets: [{ label, data: [], borderColor: color,
            backgroundColor: color.replace(')', ',0.12)').replace('rgb', 'rgba'),
            fill: true, tension: 0.4, pointRadius: 0 }] },
        options: {
            maintainAspectRatio: false, animation: false,
            plugins: {
                legend: { labels: { color: '#4d7479', font: { size: 9 }, boxWidth: 10 } },
                datalabels: { display: false }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#4d7479', font: { size: 9 }, maxTicksLimit: 10 } },
                y: { min: 0, grid: { color: '#0e2226' }, ticks: { color: '#4d7479', font: { size: 9 } } }
            }
        }
    });

    // Speed chart has two datasets
    _pscCharts.speed = new Chart(document.getElementById('psc-speed-chart'), {
        type: 'line',
        data: { labels: [], datasets: [
            { label: 'TX (KB/s)', data: [], borderColor: '#38bdf8',
              backgroundColor: 'rgba(56,189,248,0.10)', fill: true, tension: 0.4, pointRadius: 0 },
            { label: 'RX (KB/s)', data: [], borderColor: '#2dffa1',
              backgroundColor: 'rgba(45,255,161,0.10)', fill: true, tension: 0.4, pointRadius: 0 }
        ]},
        options: {
            maintainAspectRatio: false, animation: false,
            plugins: {
                legend: { labels: { color: '#4d7479', font: { size: 9 }, boxWidth: 10 } },
                datalabels: { display: false }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#4d7479', font: { size: 9 }, maxTicksLimit: 10 } },
                y: { min: 0, grid: { color: '#0e2226' }, ticks: { color: '#4d7479', font: { size: 9 } } }
            }
        }
    });

    _pscCharts.conn = new Chart(document.getElementById('psc-conn-chart'),
        lineOpts('Conns/s', '#ffe83b'));

    _pscCharts.domain = new Chart(document.getElementById('psc-domain-chart'), {
        type: 'bar',
        data: { labels: [], datasets: [{ data: [], backgroundColor: PSC_COLORS, borderRadius: 2 }] },
        options: {
            maintainAspectRatio: false, animation: false,
            plugins: {
                legend: { display: false },
                datalabels: {
                    color: '#fff', anchor: 'end', align: 'top', font: { size: 9, weight: 'bold' },
                    formatter: v => v > 0 ? v + ' MB' : ''
                }
            },
            scales: {
                x: { grid: { display: false },
                     ticks: { color: '#4d7479', font: { size: 9 }, maxRotation: 35, minRotation: 15 } },
                y: { grid: { color: '#0e2226' }, ticks: { color: '#4d7479', font: { size: 9 } } }
            }
        }
    });

    _pscCharts.ip = new Chart(document.getElementById('psc-ip-chart'), {
        type: 'doughnut',
        data: { labels: [], datasets: [{ data: [], backgroundColor: PSC_COLORS, borderWidth: 0 }] },
        options: {
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: '#4d7479', font: { size: 9 }, boxWidth: 10 } },
                datalabels: {
                    color: '#fff', font: { weight: 'bold', size: 9 },
                    formatter: (v, ctx) => {
                        const s = ctx.dataset.data.reduce((a, b) => a + b, 0);
                        const pct = v * 100 / s;
                        return pct > 5 ? (v / 1024 / 1024).toFixed(1) + ' MB' : '';
                    }
                }
            },
            cutout: '65%'
        }
    });

    _pscInterval = setInterval(pscUpdate, 2000);
}

function pscFmtBytes(b) {
    if (!b) return '0 B';
    const k = 1024, s = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i];
}

async function pscUpdate() {
    try {
        const data = await fetch('/api/sniproxy/data').then(r => r.json());

        // Toolbar
        document.getElementById('psc-server').textContent    = data.server || 'not configured';
        document.getElementById('psc-total-conn').textContent = data.total_connections;
        document.getElementById('psc-tx').textContent         = data.speed_tx + ' KB/s';
        document.getElementById('psc-rx').textContent         = data.speed_rx + ' KB/s';
        document.getElementById('psc-connrate').textContent   = data.speed_conn;

        const statusEl = document.getElementById('psc-status');
        const errCell  = document.getElementById('psc-error-cell');
        const errMsg   = document.getElementById('psc-error-msg');
        if (!data.server) {
            statusEl.textContent = 'NOT CONFIGURED';
            statusEl.style.color = 'var(--muted)';
            errCell.style.display = 'none';
        } else if (data.connected) {
            statusEl.textContent = 'CONNECTED';
            statusEl.style.color = 'var(--green)';
            errCell.style.display = 'none';
        } else {
            statusEl.textContent = data.last_error ? 'ERROR' : 'CONNECTING...';
            statusEl.style.color = 'var(--red)';
            if (data.last_error) {
                errMsg.textContent = data.last_error;
                errCell.style.display = '';
            } else {
                errCell.style.display = 'none';
            }
        }

        // Speed chart
        const h = data.speed_history;
        _pscCharts.speed.data.labels = h.labels;
        _pscCharts.speed.data.datasets[0].data = h.tx;
        _pscCharts.speed.data.datasets[1].data = h.rx;
        _pscCharts.speed.update();

        // Conn chart
        _pscCharts.conn.data.labels = h.labels;
        _pscCharts.conn.data.datasets[0].data = h.conn;
        _pscCharts.conn.update();

        // Domain chart — top 10 by bytes
        const domSorted = Object.entries(data.top_domains)
            .sort((a, b) => b[1] - a[1]).slice(0, 10);
        _pscCharts.domain.data.labels = domSorted.map(([d]) => d);
        _pscCharts.domain.data.datasets[0].data = domSorted.map(([, v]) => (v / 1024 / 1024).toFixed(2));
        _pscCharts.domain.update();

        // IP doughnut — top 8 clients by total bytes
        const ipSorted = Object.entries(data.top_ips)
            .sort((a, b) => (b[1].tx + b[1].rx) - (a[1].tx + a[1].rx)).slice(0, 8);
        _pscCharts.ip.data.labels = ipSorted.map(([ip]) => ip);
        _pscCharts.ip.data.datasets[0].data = ipSorted.map(([, v]) => v.tx + v.rx);
        _pscCharts.ip.update();

        // Clients table
        document.getElementById('psc-clients').innerHTML = ipSorted.map(([ip, v]) => `
            <tr>
                <td style="color:var(--accent);font-weight:bold;">${escape(ip)}</td>
                <td style="text-align:right;color:#38bdf8">${(v.tx / 1024 / 1024).toFixed(2)}</td>
                <td style="text-align:right;color:var(--green)">${(v.rx / 1024 / 1024).toFixed(2)}</td>
                <td style="text-align:right;color:var(--fg);font-weight:bold">${((v.tx + v.rx) / 1024 / 1024).toFixed(2)}</td>
                <td style="text-align:right;color:var(--muted)">${v.hits}</td>
            </tr>`).join('');

        // Bans table
        document.getElementById('psc-bans').innerHTML = (data.bans || []).map(b => `
            <tr>
                <td style="color:var(--muted);white-space:nowrap">${escape(b.time || '')}</td>
                <td style="color:#f97316;font-weight:bold">${escape(b.server || '?')}</td>
                <td style="color:var(--yellow)">${escape(b.jail || '?')}</td>
                <td style="color:var(--red);font-weight:bold">${escape(b.ip || '?')}</td>
                <td style="text-align:right;font-weight:bold;color:var(--fg)">${b.failures ?? '?'}</td>
            </tr>`).join('') || `<tr><td colspan="5" class="empty">No bans recorded yet.</td></tr>`;

        // Live feed table
        document.getElementById('psc-live').innerHTML = (data.recent_connections || []).map(c => `
            <tr>
                <td style="color:var(--muted)">${escape(c.time)}</td>
                <td style="color:var(--accent)">${escape(c.src_ip)}:${escape(c.src_port)}</td>
                <td style="color:var(--fg);font-weight:bold">${escape(c.domain)}</td>
                <td style="text-align:right;color:#38bdf8">${pscFmtBytes(c.tx)}</td>
                <td style="text-align:right;color:var(--green)">${pscFmtBytes(c.rx)}</td>
                <td style="text-align:right;color:var(--yellow)">${escape(String(c.duration))}</td>
            </tr>`).join('') || `<tr><td colspan="6" class="empty">No connections recorded yet.</td></tr>`;

    } catch (e) {
        console.error('PSC update failed:', e);
    }
}

// ================================================================
// Periodically recolor arcs based on age (every 5 seconds)
// ================================================================
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
// NETWORK MAP (D3 force-directed topology)
// ================================================================
let _netInitDone = false;
let _netData = { nodes: [], links: [] };
let _netDevices = new Map();   // mac -> device (from /api/devices)
let _netSettings = {};         // mac -> {connect, disconnect}
let _netEdit = false;
let _netLinkArm = null;        // null | 'armed' | source-node-id
let _netSelected = null;       // selected node id
let _netSim = null;
let _netSvg = null, _netG = null;

const NODE_TYPES = {
    host:    { shape: 'circle',  r: 10,       color: '#2dffa1', stroke: '#00ffd5' },
    switch:  { shape: 'rect',    w: 28, h: 16, color: '#38bdf8', stroke: '#00b8ff' },
    router:  { shape: 'rect',    w: 28, h: 16, color: '#38bdf8', stroke: '#00b8ff' },
    ap:      { shape: 'rect',    w: 28, h: 16, color: '#38bdf8', stroke: '#00b8ff' },
    cloud:   { shape: 'cloud',   w: 52, h: 30, color: '#0d2035', stroke: '#38bdf8' },
    lxc:     { shape: 'circle',  r: 10,       color: '#b878ff', stroke: '#9b5de5' },
    qemu:    { shape: 'circle',  r: 10,       color: '#3b82f6', stroke: '#60a5fa' },
    nas:     { shape: 'circle',  r: 10,       color: '#ffe83b', stroke: '#fbbf24' },
    mobile:  { shape: 'circle',  r: 10,       color: '#86efac', stroke: '#4ade80' },
    tv:      { shape: 'rect',    w: 28, h: 16, color: '#fb923c', stroke: '#f97316' },
    printer: { shape: 'circle',  r: 10,       color: '#f97316', stroke: '#ea580c' },
    server:  { shape: 'circle',  r: 10,       color: '#22c55e', stroke: '#16a34a' },
    rpi:     { shape: 'circle',  r: 10,       color: '#ef4444', stroke: '#dc2626' },
    other:   { shape: 'circle',  r: 10,       color: '#ea580c', stroke: '#c2410c' },
    iot:     { shape: 'circle',  r: 10,       color: '#06b6d4', stroke: '#0891b2' },
    pc:      { shape: 'circle',  r: 10,       color: '#94a3b8', stroke: '#64748b' },
    network: { shape: 'rect',    w: 28, h: 16, color: '#166534', stroke: '#15803d' },
};

const _NET_RECT_TYPES = new Set(['switch', 'router', 'ap', 'network', 'tv']);

function netNodeColor(n) {
    if (n.type === 'cloud') return NODE_TYPES.cloud.color;
    const dev = _netDevices.get(n.mac);
    const offline = dev && !dev.is_online;
    const devCfg = (_netSettings.devices || {})[n.mac] || {};
    if (_NET_RECT_TYPES.has(n.type)) {
        if (offline) return '#0d1e26';
        return devCfg.is_isp ? '#ffe83b' : (NODE_TYPES[n.type] || NODE_TYPES.host).color;
    }
    // Circle fill = online → green, offline → grey
    return offline ? '#374151' : '#22c55e';
}

function netNodeStroke(n) {
    if (n.type === 'cloud') return NODE_TYPES.cloud.stroke;
    const devCfg = (_netSettings.devices || {})[n.mac] || {};
    if (_NET_RECT_TYPES.has(n.type)) {
        const dev = _netDevices.get(n.mac);
        if (dev && !dev.is_online) return '#1a3040';
        return devCfg.is_isp ? '#f59e0b' : (NODE_TYPES[n.type] || NODE_TYPES.host).stroke;
    }
    // Circle stroke = type color always
    return (NODE_TYPES[n.type] || NODE_TYPES.host).stroke;
}

function _netSyncNodeTypes() {
    if (!_netData) return;
    const devSettings = _netSettings.devices || {};
    _netData.nodes.forEach(n => {
        if (!n.mac) return;
        const cfg = devSettings[n.mac];
        if (cfg?.type) n.type = cfg.type;
    });
}

function _netSyncIspCloud() {
    if (!_netData) return;
    const devSettings = _netSettings.devices || {};
    const ispMac = Object.entries(devSettings).find(([, c]) => c.is_isp)?.[0];

    if (ispMac) {
        const ispNodeId = `h-${ispMac}`;
        if (!_netData.nodes.some(n => n.id === 'isp-cloud')) {
            const rn = _netData.nodes.find(n => n.id === ispNodeId);
            _netData.nodes.push({
                id: 'isp-cloud', type: 'cloud', label: 'ISP', hostname: 'ISP',
                ip: '', mac: '',
                x: (rn?.x || 400) - 180, y: (rn?.y || 300) - 120,
            });
        }
        // Remove stale isp-cloud links (wrong target) and ensure correct one exists
        _netData.links = _netData.links.filter(l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            if (s === 'isp-cloud' || t === 'isp-cloud') {
                return (s === 'isp-cloud' && t === ispNodeId) || (s === ispNodeId && t === 'isp-cloud');
            }
            return true;
        });
        const hasLink = _netData.links.some(l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            return (s === 'isp-cloud' && t === ispNodeId) || (s === ispNodeId && t === 'isp-cloud');
        });
        if (!hasLink) _netData.links.push({ source: 'isp-cloud', target: ispNodeId });
    } else {
        _netData.nodes = _netData.nodes.filter(n => n.id !== 'isp-cloud');
        _netData.links = _netData.links.filter(l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            return s !== 'isp-cloud' && t !== 'isp-cloud';
        });
    }
    if (_netSim) {
        _netSim.nodes(_netData.nodes);
        _netSim.force('link').links(_netData.links);
        _netSim.alpha(0.3).restart();
    }
}

function _topoForSave() {
    return {
        nodes: _netData.nodes,
        links: _netData.links.map(l => {
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            return { ...l, source: s, target: t };
        }),
    };
}

async function netInit() {
    if (_netInitDone) { netRender(); return; }
    _netInitDone = true;

    const svg = d3.select('#net-svg');
    _netSvg = svg;
    const w = document.getElementById('net-svg').clientWidth  || 800;
    const h = document.getElementById('net-svg').clientHeight || 500;

    const defs = svg.append('defs');
    defs.append('marker')
        .attr('id', 'arrowhead')
        .attr('viewBox', '-0 -5 10 10').attr('refX', 18).attr('refY', 0)
        .attr('orient', 'auto').attr('markerWidth', 6).attr('markerHeight', 6)
        .append('path').attr('d', 'M 0,-5 L 10,0 L 0,5').attr('fill', '#14333a');
    const glowFilter = defs.append('filter').attr('id', 'isp-glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    glowFilter.append('feGaussianBlur').attr('stdDeviation', '4').attr('result', 'blur');
    const feMerge = glowFilter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'blur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    _netG = svg.append('g');

    // Zoom + pan
    svg.call(d3.zoom().scaleExtent([0.2, 4]).on('zoom', e => _netG.attr('transform', e.transform)));

    // Load data
    [_netData, _netSettings] = await Promise.all([
        fetch('/api/topo-data').then(r => r.ok ? r.json() : { nodes: [], links: [] }),
        fetch('/api/network/settings').then(r => r.json()),
    ]);
    // Normalize link source/target from saved objects back to string IDs for D3
    _netData.links = _netData.links.map(l => {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const t = typeof l.target === 'object' ? l.target.id : l.target;
        return { ...l, source: s, target: t };
    });
    // Clear saved pins so force simulation can freely organize the layout
    _netData.nodes.forEach(n => { delete n.fx; delete n.fy; });
    // Normalize old double-prefix vsw node IDs: vsw-vsw-X → vsw-X (canonical = sw.id)
    let topoChanged = false;
    _netData.nodes.forEach(n => {
        if (!n.id.startsWith('vsw-vsw-')) return;
        const newId = n.id.slice('vsw-'.length);
        _netData.links.forEach(l => {
            if (l.source === n.id) l.source = newId;
            if (l.target === n.id) l.target = newId;
        });
        n.id = newId;
        topoChanged = true;
    });
    // Deduplicate nodes by id (keep last occurrence to prefer freshest data)
    const _seenIds = new Map();
    _netData.nodes.forEach(n => _seenIds.set(n.id, n));
    _netData.nodes = [..._seenIds.values()];

    const devList = await fetch('/api/devices').then(r => r.json()).catch(() => []);
    _netDevices = new Map(devList.map(d => [d.mac, d]));

    // Helper: convert parent_mac value to node ID
    const _parentNodeId = pm => pm.startsWith('vsw:') ? pm.slice('vsw:'.length) : `h-${pm}`;

    // Sync node types from net_settings (fixes stale type='host' from old topo saves)
    const devSettings = _netSettings.devices || {};
    _netData.nodes.forEach(n => {
        if (!n.mac) return;
        const cfg = devSettings[n.mac];
        if (cfg?.type) n.type = cfg.type;
    });

    // Auto-add devices with visualize=true OR switch/router/ap type
    const w0 = document.getElementById('net-svg').clientWidth  || 800;
    const h0 = document.getElementById('net-svg').clientHeight || 500;
    const AUTO_TYPES = new Set(['switch', 'router', 'ap']);
    for (const [mac, cfg] of Object.entries(devSettings)) {
        if (!cfg.visualize && !AUTO_TYPES.has(cfg.type)) continue;
        const nodeId = `h-${mac}`;
        if (_netData.nodes.some(n => n.id === nodeId)) continue;
        const dev = _netDevices.get(mac);
        const label = cfg.hostname || dev?.hostname || dev?.ip || mac;
        _netData.nodes.push({
            id: nodeId, type: cfg.type || 'host',
            label, hostname: cfg.hostname || dev?.hostname || '',
            ip: dev?.ip || '', mac,
            parent: '',
            x: w0/2 + (Math.random()-0.5)*300, y: h0/2 + (Math.random()-0.5)*300,
        });
        topoChanged = true;
    }
    // Auto-add virtual switches as nodes (canonical id = sw.id, e.g. 'vsw-1779451687')
    for (const sw of (_netSettings.virtual_switches || [])) {
        const nodeId = sw.id;
        if (_netData.nodes.some(n => n.id === nodeId)) continue;
        _netData.nodes.push({
            id: nodeId, type: 'switch',
            label: sw.hostname, hostname: sw.hostname,
            ip: '', mac: '',
            x: w0/2 + (Math.random()-0.5)*300, y: h0/2 + (Math.random()-0.5)*300,
        });
        topoChanged = true;
    }
    // Add links for parent_mac connections (device-to-device or device-to-vsw)
    for (const [mac, cfg] of Object.entries(devSettings)) {
        if ((!cfg.visualize && !AUTO_TYPES.has(cfg.type)) || !cfg.parent_mac) continue;
        const childId = `h-${mac}`;
        const parentId = _parentNodeId(cfg.parent_mac);
        if (!_netData.nodes.some(n => n.id === childId)) continue;
        if (!_netData.nodes.some(n => n.id === parentId)) continue;
        const linked = _netData.links.some(l => {
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            return (s === parentId && t === childId) || (s === childId && t === parentId);
        });
        if (!linked) {
            _netData.links.push({ source: parentId, target: childId, label: cfg.parent_port || '', wifi: cfg.connection_type === 'wifi' });
            topoChanged = true;
        }
    }
    // Add links for virtual switch parent connections
    for (const sw of (_netSettings.virtual_switches || [])) {
        if (!sw.parent_mac) continue;
        const childId = sw.id;
        const parentId = _parentNodeId(sw.parent_mac);
        if (!_netData.nodes.some(n => n.id === childId)) continue;
        if (!_netData.nodes.some(n => n.id === parentId)) continue;
        const linked = _netData.links.some(l => {
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            return (s === parentId && t === childId) || (s === childId && t === parentId);
        });
        if (!linked) {
            _netData.links.push({ source: parentId, target: childId, label: '' });
            topoChanged = true;
        }
    }
    _netSyncIspCloud();
    if (topoChanged) fetch('/api/topo-data', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(_topoForSave()) }).catch(() => {});

    // D3 force simulation
    _netSim = d3.forceSimulation(_netData.nodes)
        .force('link', d3.forceLink(_netData.links).id(d => d.id).distance(65).strength(0.8))
        .force('charge', d3.forceManyBody().strength(-80))
        .force('center', d3.forceCenter(w / 2, h / 2))
        .force('collision', d3.forceCollide(44))
        .alphaDecay(0.012)
        .on('tick', netTick);

    netRender();
    $('net-node-count').textContent = _netData.nodes.length;
    $('net-link-count').textContent = _netData.links.length;
}

function netRender() {
    if (!_netG) return;
    _netG.selectAll('*').remove();

    const _devCfg = _netSettings.devices || {};
    const _linkConn = d => {
        if (d.wifi) return 'wifi';
        const tgt = typeof d.target === 'object' ? d.target : _netData.nodes.find(n => n.id === d.target);
        return tgt?.mac ? (_devCfg[tgt.mac]?.connection_type || 'ethernet') : 'ethernet';
    };
    const _LINK_COLOR = { ethernet: '#14333a', wifi: '#3b82f6', virtual: '#f97316' };
    const linkSel = _netG.selectAll('.net-link')
        .data(_netData.links).enter().append('line')
        .attr('class', 'net-link')
        .style('stroke', d => _LINK_COLOR[_linkConn(d)] || '#14333a')
        .style('stroke-width', 1.5)
        .style('stroke-dasharray', d => _linkConn(d) === 'wifi' ? '5,3' : null);

    const linkLabelSel = _netG.selectAll('.net-link-label')
        .data(_netData.links).enter().append('text')
        .attr('class', 'net-link-label')
        .style('font-size', '9px').style('fill', '#4d7479').style('pointer-events', 'none')
        .style('text-anchor', 'middle');

    const nodeSel = _netG.selectAll('.net-node')
        .data(_netData.nodes).enter().append('g')
        .attr('class', 'net-node')
        .call(d3.drag()
            .on('start', netDragStart)
            .on('drag',  netDragged)
            .on('end',   netDragEnd))
        .on('click',      (ev, d) => { ev.stopPropagation(); netHideTooltip(); netClickNode(d); })
        .on('mouseenter', (ev, d) => { _netHoverTimer = setTimeout(() => netShowTooltip(ev, d), 3000); })
        .on('mousemove',  (ev)    => { netMoveTooltip(ev); })
        .on('mouseleave', ()      => { clearTimeout(_netHoverTimer); netHideTooltip(); });

    // Draw shapes
    nodeSel.each(function(d) {
        const g = d3.select(this);
        const cfg = NODE_TYPES[d.type] || NODE_TYPES.host;
        const devCfg = (_netSettings.devices || {})[d.mac] || {};
        if (d.type === 'cloud') {
            g.append('rect')
                .attr('x', -cfg.w/2).attr('y', -cfg.h/2)
                .attr('width', cfg.w).attr('height', cfg.h)
                .attr('rx', cfg.h/2).style('fill', cfg.color).style('stroke', cfg.stroke)
                .style('stroke-width', 1.5).style('stroke-dasharray', '4,2');
            g.append('text').attr('y', 6).style('font-size', '16px').style('text-anchor', 'middle')
                .style('pointer-events', 'none').text('☁');
        } else if (_NET_RECT_TYPES.has(d.type)) {
            if (devCfg.is_isp) {
                g.append('rect')
                    .attr('x', -cfg.w/2 - 5).attr('y', -cfg.h/2 - 5)
                    .attr('width', cfg.w + 10).attr('height', cfg.h + 10)
                    .attr('rx', 4).style('fill', '#ffe83b').style('opacity', 0.25)
                    .attr('filter', 'url(#isp-glow)');
            }
            g.append('rect')
                .attr('x', -cfg.w/2).attr('y', -cfg.h/2)
                .attr('width', cfg.w).attr('height', cfg.h)
                .attr('rx', 2).style('fill', netNodeColor(d)).style('stroke', netNodeStroke(d))
                .style('stroke-width', devCfg.is_isp ? 2.5 : 1.5);
            const _RECT_ICON = { switch: 'SW', router: 'R', ap: 'AP', network: 'N', tv: 'TV' };
            const icon = _RECT_ICON[d.type];
            if (icon) g.append('text').attr('y', 4).style('font-size', '7px').style('font-weight', '800')
                .style('fill', devCfg.is_isp ? '#0d1e26' : '#001830').style('text-anchor', 'middle')
                .style('pointer-events', 'none').style('letter-spacing', '0.5px').text(icon);
        } else {
            g.append('circle').attr('r', cfg.r)
                .style('fill', netNodeColor(d)).style('stroke', netNodeStroke(d)).style('stroke-width', 1.5);
        }
        g.append('text').attr('class', 'net-node-label')
            .attr('y', (d.type === 'cloud' ? cfg.h/2 + 12 : _NET_RECT_TYPES.has(d.type) ? 14 : 18))
            .style('font-size', '10px').style('fill', '#cfe7ec').style('text-anchor', 'middle')
            .style('pointer-events', 'none')
            .text(d.label || d.hostname || d.ip || d.id);
    });

    // Click on canvas = deselect
    _netSvg.on('click', () => { _netSelected = null; netHighlight(); netClosePanel(); });

    _netSim.nodes(_netData.nodes);
    _netSim.force('link').links(_netData.links);
    _netSim.alpha(0.3).restart();

    netHighlight();
}

function netTick() {
    if (!_netG) return;
    _netG.selectAll('.net-link')
        .attr('x1', d => d.source.x || 0).attr('y1', d => d.source.y || 0)
        .attr('x2', d => d.target.x || 0).attr('y2', d => d.target.y || 0);
    _netG.selectAll('.net-link-label')
        .attr('x', d => ((d.source.x||0) + (d.target.x||0)) / 2)
        .attr('y', d => ((d.source.y||0) + (d.target.y||0)) / 2 - 4)
        .text(d => {
            const parts = [];
            if (d.src_port) parts.push(`p${d.src_port}`);
            if (d.tgt_port) parts.push(`p${d.tgt_port}`);
            return parts.join('↔');
        });
    _netG.selectAll('.net-node')
        .attr('transform', d => `translate(${d.x || 0},${d.y || 0})`);
}

function netHighlight() {
    if (!_netG) return;
    _netG.selectAll('.net-node').classed('selected', d => d.id === _netSelected);
}

let _netHoverTimer = null;
const _netTT = (() => { const el = document.createElement('div'); el.id = 'net-tooltip'; document.body.appendChild(el); return el; })();

function netShowTooltip(ev, d) {
    const dev = _netDevices.get(d.mac);
    const ports = dev?.ports || '—';
    const typeLabel = { lxc: 'LXC', qemu: 'QEMU', host: 'HOST', switch: 'SWITCH', router: 'ROUTER', nas: 'NAS', mobile: 'MOBILE', tv: 'TV', printer: 'PRINTER', server: 'SERVER', rpi: 'RPI', other: 'OTHER' }[d.type] || d.type?.toUpperCase() || 'HOST';
    const online = dev ? (dev.is_online ? 'ONLINE' : 'OFFLINE') : '—';
    _netTT.innerHTML =
        `<div class="net-tt-title">${escape(d.label || d.hostname || d.id)}</div>` +
        `<div class="net-tt-row"><span class="lbl">TYPE</span><span>${typeLabel}</span></div>` +
        `<div class="net-tt-row"><span class="lbl">STATUS</span><span style="color:${dev?.is_online?'var(--accent)':'#555'}">${online}</span></div>` +
        `<div class="net-tt-row"><span class="lbl">IP</span><span>${escape(d.ip || dev?.ip || '—')}</span></div>` +
        `<div class="net-tt-row"><span class="lbl">MAC</span><span>${escape(d.mac || '—')}</span></div>` +
        `<div class="net-tt-row"><span class="lbl">PORTS</span><span>${escape(ports)}</span></div>` +
        (dev?.vendor ? `<div class="net-tt-row"><span class="lbl">VENDOR</span><span>${escape(dev.vendor)}</span></div>` : '');
    _netTT.style.display = 'block';
    netMoveTooltip(ev);
}
function netMoveTooltip(ev) {
    if (_netTT.style.display === 'none') return;
    _netTT.style.left = (ev.clientX + 14) + 'px';
    _netTT.style.top  = (ev.clientY - 10) + 'px';
}
function netHideTooltip() { _netTT.style.display = 'none'; }

function netDragStart(ev, d) {
    if (!ev.active) _netSim.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
}
function netDragged(ev, d) {
    d.fx = ev.x; d.fy = ev.y;
}
function netDragEnd(ev, d) {
    if (!ev.active) _netSim.alphaTarget(0);
    d.fx = ev.x; d.fy = ev.y; // pin in place after drop
}

function netClickNode(d) {
    if (_netEdit && _netLinkArm === 'armed') {
        _netLinkArm = d.id;
        $('net-hint').textContent = 'Click second node to complete link...';
        return;
    }
    if (_netEdit && _netLinkArm && _netLinkArm !== 'armed' && _netLinkArm !== d.id) {
        const srcPort = prompt('Source port (leave blank if none):') || '';
        const tgtPort = prompt('Target port (leave blank if none):') || '';
        _netData.links.push({ source: _netLinkArm, target: d.id,
                              src_port: srcPort ? +srcPort : null,
                              tgt_port: tgtPort ? +tgtPort : null });
        _netLinkArm = null;
        $('net-hint').textContent = '';
        $('net-link-count').textContent = _netData.links.length;
        netRender();
        return;
    }
    _netSelected = d.id;
    netHighlight();
    if (d.mac) { openDeviceModal(d.mac); return; }
    netOpenPanel(d);
}

function netOpenPanel(d) {
    const panel = $('net-panel');
    const body  = $('net-panel-body');
    $('net-panel-title').textContent = `◤ ${(d.type || 'HOST').toUpperCase()} — ${d.label || d.id}`;
    panel.classList.remove('hidden');

    const dev = _netDevices.get(d.mac);
    const notif = (_netSettings.notifications || {})[d.mac] || { connect: true, disconnect: true };

    let html = `
        <label>Label<input type="text" id="np-label" value="${escape(d.label || '')}"></label>`;

    if (d.type === 'host' || !d.type) {
        html += `
        <label>IP<input type="text" id="np-ip" value="${escape(d.ip || '')}"></label>
        <label>MAC<input type="text" id="np-mac" value="${escape(d.mac || '')}"></label>
        ${dev ? `<div style="font-size:10px;color:var(--muted)">Status: <span style="color:${dev.is_online?'var(--green)':'#555'}">${dev.is_online?'ONLINE':'OFFLINE'}</span></div>` : ''}
        <div class="net-section-title">Notifications</div>
        <div class="net-notify-row"><span>Connect alert</span>
            <label class="fsc-toggle"><input type="checkbox" id="np-notify-con" ${notif.connect?'checked':''}><span class="fsc-toggle-slider"></span></label></div>
        <div class="net-notify-row"><span>Disconnect alert</span>
            <label class="fsc-toggle"><input type="checkbox" id="np-notify-dis" ${notif.disconnect?'checked':''}><span class="fsc-toggle-slider"></span></label></div>`;
    } else if (d.type === 'switch' || d.type === 'router') {
        html += `
        <label>Ports<input type="number" id="np-ports" value="${d.ports || 8}" min="1" max="48"></label>`;
        // Show port assignments from links
        const myLinks = _netData.links.filter(l => {
            const srcId = (l.source.id || l.source);
            const tgtId = (l.target.id || l.target);
            return srcId === d.id || tgtId === d.id;
        });
        if (myLinks.length) {
            html += `<div class="net-section-title">Port assignments</div><div class="net-port-list">`;
            myLinks.forEach(l => {
                const srcId = (l.source.id || l.source);
                const tgtId = (l.target.id || l.target);
                const isSource = srcId === d.id;
                const otherId  = isSource ? tgtId : srcId;
                const portNum  = isSource ? l.src_port : l.tgt_port;
                const other = _netData.nodes.find(n => n.id === otherId);
                const otherLabel = other ? (other.label || other.hostname || other.ip || otherId) : otherId;
                html += `<div class="net-port-row"><span class="net-port-num">${portNum ?? '—'}</span><span class="net-port-host">${escape(otherLabel)}</span></div>`;
            });
            html += '</div>';
        }
    }

    html += `
        <div style="display:flex;gap:6px;margin-top:4px;">
            <button class="btn primary" id="np-save" style="flex:1">SAVE</button>
            <button class="btn" id="np-del" style="color:#ff2a5e;border-color:#ff2a5e;">DEL</button>
        </div>`;
    body.innerHTML = html;

    $('np-save').addEventListener('click', () => netSaveNode(d));
    $('np-del').addEventListener('click', () => netDeleteNode(d));
}

async function netSaveNode(d) {
    d.label = $('np-label').value.trim() || d.label;
    if (d.type === 'host' || !d.type) {
        d.ip  = ($('np-ip')  || {}).value || d.ip;
        d.mac = ($('np-mac') || {}).value || d.mac;
        const mac = d.mac;
        if (mac) {
            const nc = !!($('np-notify-con')  || {}).checked;
            const nd = !!($('np-notify-dis') || {}).checked;
            await fetch('/api/network/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mac, notify_connect: nc, notify_disconnect: nd })
            });
            _netSettings.notifications = _netSettings.notifications || {};
            _netSettings.notifications[mac] = { connect: nc, disconnect: nd };
        }
    } else {
        const portsEl = $('np-ports');
        if (portsEl) d.ports = +portsEl.value || d.ports;
    }
    netRender();
    netOpenPanel(d);
}

function netDeleteNode(d) {
    if (!confirm(`Delete node "${d.label || d.id}"?`)) return;
    _netData.nodes = _netData.nodes.filter(n => n.id !== d.id);
    _netData.links = _netData.links.filter(l => {
        const s = l.source.id || l.source;
        const t = l.target.id || l.target;
        return s !== d.id && t !== d.id;
    });
    _netSelected = null;
    netClosePanel();
    $('net-node-count').textContent = _netData.nodes.length;
    $('net-link-count').textContent = _netData.links.length;
    netRender();
}

function netClosePanel() { $('net-panel').classList.add('hidden'); }

// Toolbar buttons
$('net-edit-btn').addEventListener('click', () => {
    _netEdit = !_netEdit;
    _netLinkArm = null;
    $('net-edit-btn').classList.toggle('primary', _netEdit);
    $('net-hint').textContent = _netEdit ? 'EDIT MODE — drag nodes, click to configure' : '';
    if (_netSim) { _netEdit ? _netSim.alphaTarget(0.05).restart() : _netSim.alphaTarget(0); }
});

function _netAddHostFromPicker(dev) {
    const w = document.getElementById('net-svg').clientWidth  || 800;
    const h = document.getElementById('net-svg').clientHeight || 500;
    const label = dev.hostname || dev.ip || 'host';
    // Parent: pick from existing topology nodes
    const topoNodes = _netData.nodes.filter(n => n.id !== `h-${dev.mac}`);
    const parentId = topoNodes.length
        ? topoNodes.find(n => n.type === 'router' || n.type === 'switch')?.id || ''
        : '';
    _netData.nodes.push({
        id: `h-${dev.mac || Date.now()}`, type: dev.type || 'host',
        label, hostname: dev.hostname, ip: dev.ip, mac: dev.mac || '',
        parent: parentId,
        x: w/2 + (Math.random()-0.5)*200, y: h/2 + (Math.random()-0.5)*200,
    });
    $('net-node-count').textContent = _netData.nodes.length;
    netRender();
}

$('net-add-host').addEventListener('click', async () => {
    if (!_netEdit) { $('net-hint').textContent = 'Enable EDIT first.'; return; }
    const devices = await fetch('/api/devices').then(r => r.json()).catch(() => []);
    const pickerModal = $('host-picker-modal');
    const pickerList  = $('host-picker-list');

    pickerList.innerHTML = devices.length
        ? devices.map(d => `
            <div class="row dev clickable host-pick-row" data-mac="${escape(d.mac)}"
                 style="cursor:pointer;" title="Click to add">
                <span class="dot ${d.is_online ? 'on' : 'off'}"></span>
                <div style="flex:1;min-width:0;">
                    <div style="display:flex;justify-content:space-between;">
                        <span class="name">${escape(d.hostname || d.ip)}</span>
                        <span class="meta">${d.is_online ? 'online' : 'offline'}</span>
                    </div>
                    <div class="ip">${d.ip} · ${escape(d.vendor || '')}</div>
                </div>
            </div>`).join('')
        : '<div class="empty">No LAN devices found.</div>';

    pickerList.querySelectorAll('.host-pick-row').forEach(row => {
        row.addEventListener('click', () => {
            const mac = unescape(row.dataset.mac);
            const dev = devices.find(d => d.mac === mac) || { mac };
            pickerModal.classList.add('hidden');
            _netAddHostFromPicker(dev);
        });
    });

    $('host-picker-custom').onclick = () => {
        pickerModal.classList.add('hidden');
        const label = prompt('Hostname / label:');
        if (!label) return;
        const ip  = prompt('IP address:') || '';
        const mac = prompt('MAC address (leave blank for virtual):') || '';
        _netAddHostFromPicker({ hostname: label, ip, mac, type: 'host' });
    };

    pickerModal.classList.remove('hidden');
});

$('net-add-switch').addEventListener('click', () => {
    if (!_netEdit) { $('net-hint').textContent = 'Enable EDIT first.'; return; }
    const label = prompt('Switch label:') || 'SW';
    const ports = parseInt(prompt('Number of ports:', '24') || '24');
    const w = document.getElementById('net-svg').clientWidth  || 800;
    const h = document.getElementById('net-svg').clientHeight || 500;
    _netData.nodes.push({ id: `sw-${Date.now()}`, type: 'switch', label, ports,
                          x: w/2 + (Math.random()-0.5)*200, y: h/2 + (Math.random()-0.5)*200 });
    $('net-node-count').textContent = _netData.nodes.length;
    netRender();
});

$('net-add-router').addEventListener('click', () => {
    if (!_netEdit) { $('net-hint').textContent = 'Enable EDIT first.'; return; }
    const label = prompt('Router label:') || 'GW';
    const ip    = prompt('IP / WAN address:') || '';
    const w = document.getElementById('net-svg').clientWidth  || 800;
    const h = document.getElementById('net-svg').clientHeight || 500;
    _netData.nodes.push({ id: `rt-${Date.now()}`, type: 'router', label, ip,
                          x: w/2 + (Math.random()-0.5)*200, y: h/2 + (Math.random()-0.5)*200 });
    $('net-node-count').textContent = _netData.nodes.length;
    netRender();
});

$('net-add-link').addEventListener('click', () => {
    if (!_netEdit) { $('net-hint').textContent = 'Enable EDIT first.'; return; }
    _netLinkArm = 'armed';
    $('net-hint').textContent = 'Click first node...';
});

$('net-save-btn').addEventListener('click', async () => {
    // Freeze positions before save
    _netData.nodes.forEach(n => { n.x = Math.round(n.x || 0); n.y = Math.round(n.y || 0); });
    try {
        await fetch('/api/topo-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_topoForSave())
        });
        $('net-hint').textContent = 'Saved.';
        setTimeout(() => { $('net-hint').textContent = _netEdit ? 'EDIT MODE' : ''; }, 2000);
    } catch { $('net-hint').textContent = 'Save failed.'; }
});

$('net-reseed-btn').addEventListener('click', () => {
    if (!_netSim) return;
    const w = document.getElementById('net-svg').clientWidth  || 800;
    const h = document.getElementById('net-svg').clientHeight || 500;
    _netData.nodes.forEach(n => {
        delete n.fx; delete n.fy;
        n.x = w/2 + (Math.random() - 0.5) * 200;
        n.y = h/2 + (Math.random() - 0.5) * 200;
    });
    _netSim.nodes(_netData.nodes);
    _netSim.alpha(0.9).restart();
});

// ── DB Viewer ─────────────────────────────────────────────────────────────────
const _dbv = { table: 'attacks', page: 0, pageSize: 100, total: 0, cols: [], selected: new Set(), q: '' };

function dbvOpen() { $('db-viewer').classList.remove('hidden'); dbvLoad(); }
function dbvClose() { $('db-viewer').classList.add('hidden'); }

function dbvSwitch(table) {
    _dbv.table = table; _dbv.page = 0; _dbv.selected.clear(); _dbv.q = '';
    $('dbv-search').value = '';
    ['attacks','ban_history','devices','active_users','logs'].forEach(t => {
        const btn = $('dbv-tab-' + t);
        if (btn) btn.style.background = t === table ? 'var(--accent)' : '';
        if (btn) btn.style.color = t === table ? '#0a1a1e' : '';
    });
    dbvLoad();
}

async function dbvLoadLogs() {
    const logs = await fetch('/api/logs?limit=400').then(r => r.json()).catch(() => []);
    const cols = ['ts', 'level', 'source', 'msg'];
    const thead = $('dbv-thead');
    thead.innerHTML = '<tr><th></th>' + cols.map(c => `<th>${c.toUpperCase()}</th>`).join('') + '</tr>';
    const tbody = $('dbv-tbody');
    const q = _dbv.q.toLowerCase();
    const filtered = q ? logs.filter(l => cols.some(c => String(l[c] ?? '').toLowerCase().includes(q))) : logs;
    tbody.innerHTML = filtered.slice(0, 400).map(l => {
        const ts = (l.ts || '').substring(0, 19);
        return `<tr><td></td>` + cols.map(c => {
            const v = c === 'ts' ? ts : (l[c] ?? '');
            return `<td title="${escape(String(v))}">${escape(String(v))}</td>`;
        }).join('') + `</tr>`;
    }).join('');
    $('dbv-page-info').textContent = `${filtered.length} entries`;
    $('dbv-count').textContent = `${filtered.length}`;
    $('dbv-prev').disabled = true;
    $('dbv-next').disabled = true;
    $('dbv-delete-btn').style.display = 'none';
}

async function dbvLoad() {
    if (_dbv.table === 'logs') { await dbvLoadLogs(); return; }
    const params = new URLSearchParams({ limit: _dbv.pageSize, offset: _dbv.page * _dbv.pageSize });
    if (_dbv.q) params.set('q', _dbv.q);
    const data = await fetch(`/api/db/${_dbv.table}?${params}`).then(r => r.json()).catch(() => null);
    if (!data || data.error) return;
    _dbv.cols = data.columns; _dbv.total = data.total; _dbv.pk = data.pk;

    // Header
    const thead = $('dbv-thead');
    thead.innerHTML = '<tr><th><input type="checkbox" id="dbv-chk-all" title="Select all"></th>'
        + data.columns.map(c => `<th>${c.toUpperCase()}</th>`).join('') + '</tr>';
    $('dbv-chk-all').addEventListener('change', e => {
        document.querySelectorAll('#dbv-tbody .dbv-chk').forEach(chk => {
            chk.checked = e.target.checked;
            const id = chk.dataset.id;
            e.target.checked ? _dbv.selected.add(id) : _dbv.selected.delete(id);
            chk.closest('tr').classList.toggle('selected', e.target.checked);
        });
        dbvUpdateDeleteBtn();
    });

    // Rows
    const tbody = $('dbv-tbody');
    tbody.innerHTML = '';
    data.rows.forEach(row => {
        const id = String(row[_dbv.pk]);
        const sel = _dbv.selected.has(id);
        const tr = document.createElement('tr');
        if (sel) tr.classList.add('selected');
        tr.innerHTML = `<td><input type="checkbox" class="dbv-chk" data-id="${id}" ${sel ? 'checked' : ''}></td>`
            + data.columns.map(c => {
                const v = row[c] ?? '';
                const cls = c === _dbv.pk ? ' class="dbv-pk"' : '';
                return `<td${cls} title="${v}">${v}</td>`;
            }).join('');
        tr.querySelector('.dbv-chk').addEventListener('change', e => {
            const rid = e.target.dataset.id;
            e.target.checked ? _dbv.selected.add(rid) : _dbv.selected.delete(rid);
            tr.classList.toggle('selected', e.target.checked);
            dbvUpdateDeleteBtn();
        });
        tbody.appendChild(tr);
    });

    const pages = Math.max(1, Math.ceil(_dbv.total / _dbv.pageSize));
    $('dbv-page-info').textContent = `Page ${_dbv.page + 1} / ${pages}  (${_dbv.total} rows)`;
    $('dbv-count').textContent = `${_dbv.total} rows`;
    $('dbv-prev').disabled = _dbv.page === 0;
    $('dbv-next').disabled = (_dbv.page + 1) >= pages;
    dbvUpdateDeleteBtn();
}

function dbvUpdateDeleteBtn() {
    const btn = $('dbv-delete-btn');
    btn.style.display = _dbv.selected.size ? '' : 'none';
    btn.textContent = `DELETE SELECTED (${_dbv.selected.size})`;
}

function dbvPage(dir) { _dbv.page = Math.max(0, _dbv.page + dir); dbvLoad(); }

async function dbvDeleteSelected() {
    if (!_dbv.selected.size) return;
    if (!confirm(`Delete ${_dbv.selected.size} record(s)?`)) return;
    const ids = [..._dbv.selected];
    const r = await fetch(`/api/db/${_dbv.table}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ids),
    }).then(x => x.json()).catch(() => null);
    if (r?.deleted != null) {
        _dbv.selected.clear();
        _dbv.page = 0;
        dbvLoad();
    }
}

let _dbvSearchTimer = null;
$('dbv-search').addEventListener('input', e => {
    clearTimeout(_dbvSearchTimer);
    _dbvSearchTimer = setTimeout(() => { _dbv.q = e.target.value; _dbv.page = 0; dbvLoad(); }, 350);
});
$('db-viewer-btn').addEventListener('click', () => { dbvOpen(); dbvSwitch('attacks'); });
$('db-viewer-close').addEventListener('click', dbvClose);
$('db-viewer').addEventListener('click', e => { if (e.target === $('db-viewer')) dbvClose(); });

$('net-panel-close').addEventListener('click', () => { _netSelected = null; netHighlight(); netClosePanel(); });

// ── Network Search Modal ───────────────────────────────────────────────────
let _netSearchDevices = [];

function _netSearchOpen() {
    $('net-search-modal').classList.remove('hidden');
    const inp = $('net-search-input');
    inp.value = '';
    _netSearchRender('');
    inp.focus();
}
function _netSearchClose() { $('net-search-modal').classList.add('hidden'); }

function _netSearchRender(q) {
    const results = $('net-search-results');
    const devSettings = (_netSettings.devices || {});
    const term = q.trim().toLowerCase();
    const matches = _netSearchDevices.filter(d => {
        if (!term) return true;
        const cfg = devSettings[d.mac] || {};
        return (d.ip || '').includes(term)
            || (d.mac || '').toLowerCase().includes(term)
            || (d.hostname || '').toLowerCase().includes(term)
            || (cfg.hostname || '').toLowerCase().includes(term)
            || (d.vendor || '').toLowerCase().includes(term);
    }).sort((a, b) => _ipToNum(a.ip) - _ipToNum(b.ip));

    if (!matches.length) {
        results.innerHTML = '<div class="empty">No devices found.</div>';
        return;
    }
    const devSettings2 = (_netSettings.devices || {});
    results.innerHTML = matches.map(d => {
        const cfg = devSettings2[d.mac] || {};
        const name = cfg.hostname || d.hostname || d.ip;
        const typeBadge = cfg.type === 'lxc'  ? ' <span style="color:#a855f7;font-size:9px;">[LXC]</span>'
                        : cfg.type === 'qemu' ? ' <span style="color:#38bdf8;font-size:9px;">[QEMU]</span>' : '';
        const dot = `<span class="dot ${d.is_online ? 'on' : 'off'}" style="margin-right:6px;"></span>`;
        const ports = (d.ports || '').split(',').filter(Boolean).slice(0, 5)
            .map(p => `<span class="port" style="font-size:9px;padding:0 4px;">${p}</span>`).join('');
        return `<div class="row dev clickable" data-mac="${escape(d.mac)}"
                    style="border-left:2px solid ${d.is_online ? 'var(--accent)' : '#4d7479'};">
            ${dot}
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span class="name">${escape(name)}${typeBadge}</span>
                    <span style="color:var(--muted);font-size:9px;">${escape(d.ip)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;">
                    <span style="color:#4d7479;font-size:9px;font-family:monospace;">${escape(d.mac)}</span>
                    <span style="color:#4d7479;font-size:9px;">${escape(d.vendor || '')}</span>
                </div>
                ${ports ? `<div class="ports" style="margin-top:2px;">${ports}</div>` : ''}
            </div>
        </div>`;
    }).join('');
    results.querySelectorAll('.dev[data-mac]').forEach(row => {
        row.addEventListener('click', () => { _netSearchClose(); openDeviceModal(row.dataset.mac); });
    });
}

$('net-search-btn').addEventListener('click', async () => {
    _netSearchDevices = await fetch('/api/devices').then(r => r.json()).catch(() => []);
    _netSearchOpen();
});
$('net-search-close').addEventListener('click', _netSearchClose);
$('net-search-modal').addEventListener('click', e => { if (e.target === $('net-search-modal')) _netSearchClose(); });
$('net-search-input').addEventListener('input', e => _netSearchRender(e.target.value));

$('ns-refresh-btn').addEventListener('click', async () => {
    $('ns-refresh-btn').textContent = '↺ REFRESHING…';
    _netSearchDevices = await fetch('/api/devices').then(r => r.json()).catch(() => []);
    _netSearchRender($('net-search-input').value);
    $('ns-refresh-btn').textContent = '↺ REFRESH DEVICES';
});

$('ns-export-btn').addEventListener('click', () => {
    const devSettings = (_netSettings.devices || {});
    const rows = [['IP','MAC','Hostname','Vendor','Status','Ports','Type']];
    _netSearchDevices.sort((a, b) => _ipToNum(a.ip) - _ipToNum(b.ip)).forEach(d => {
        const cfg = devSettings[d.mac] || {};
        rows.push([d.ip, d.mac, cfg.hostname || d.hostname || '', d.vendor || '',
                   d.is_online ? 'online' : 'offline', d.ports || '', cfg.type || '']);
    });
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'devices.csv';
    a.click();
});

$('ns-scan-btn').addEventListener('click', () => {
    alert('Port scan: select a device from the list and use the device modal to view/refresh ports.');
});

// ================================================================
// SERVICES TAB — domain / HTTP / HTTPS monitor
// ================================================================

// ── Service Monitor ───────────────────────────────────────────────────────────

function _esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let _svcInitDone = false;
let _svcData     = [];  // full list from /api/services

function svcInit() {
    if (_svcInitDone) { svcLoad(); return; }
    _svcInitDone = true;

    $('svc-check-btn').addEventListener('click', svcCheckAll);
    $('svc-add-btn').addEventListener('click', svcOpenModal);

    const intervalSel = $('svc-interval');
    fetch('/api/services/settings').then(r => r.json()).then(cfg => {
        intervalSel.value = String(cfg.interval_min || 5);
    }).catch(() => {});
    intervalSel.addEventListener('change', () => {
        fetch('/api/services/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interval_min: Number(intervalSel.value) }),
        });
    });

    $('svc-modal-overlay').addEventListener('click', e => {
        if (e.target === $('svc-modal-overlay')) svcCloseModal();
    });
    $('svc-detail-overlay').addEventListener('click', e => {
        if (e.target === $('svc-detail-overlay')) $('svc-detail-overlay').style.display = 'none';
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            if ($('svc-detail-overlay').style.display !== 'none') $('svc-detail-overlay').style.display = 'none';
            else if ($('svc-modal-overlay').style.display !== 'none') svcCloseModal();
        }
    });

    svcLoad();
}

function svcOpenModal() {
    // Reset form
    ['m-svc-name','m-f-url','m-f-text','m-f-hostval','m-f-port','m-f-dnsq','m-f-dnssrv'].forEach(id => {
        const el = $(id); if (el) el.value = '';
    });
    $('m-svc-type').value = 'http';
    $('m-f-status').value = '200';
    $('m-f-hbint').value = '300';
    $('m-f-ssl-verify').checked = true;
    $('m-results').style.display = 'none';
    $('m-test-status').textContent = '';
    $('m-add-status').textContent = '';
    svcModalUpdateFields();
    $('svc-modal-overlay').style.display = 'flex';
    setTimeout(() => { const u = $('m-f-url'); if (u && u.offsetParent) u.focus(); }, 50);
}

function svcCloseModal() {
    $('svc-modal-overlay').style.display = 'none';
}

function svcModalUpdateFields() {
    const t = $('m-svc-type').value;
    const isHttp = t === 'http';
    const isHostType = t === 'tcp' || t === 'ping';
    // http group uses display:contents — toggle child elements
    const httpEls = $('m-f-http').children;
    for (const el of httpEls) el.style.display = isHttp ? '' : 'none';
    $('m-f-host').style.display    = isHostType ? 'grid' : 'none';
    $('m-f-portrow').style.display  = (t === 'tcp') ? 'flex' : 'none';
    $('m-f-dns').style.display     = (t === 'dns') ? 'grid' : 'none';
    $('m-f-hb').style.display      = (t === 'heartbeat') ? 'block' : 'none';
}

function _svcModalPayload() {
    const type = $('m-svc-type').value;
    const payload = { type, name: ($('m-svc-name').value || '').trim() };
    if (type === 'http') {
        payload.target         = ($('m-f-url').value || '').trim();
        payload.method         = $('m-f-method').value;
        payload.expected_status = Number($('m-f-status').value) || 200;
        payload.expected_text  = ($('m-f-text').value || '').trim();
        payload.ssl_verify     = $('m-f-ssl-verify').checked;
    } else if (type === 'tcp' || type === 'ping') {
        payload.host = ($('m-f-hostval').value || '').trim();
        if (type === 'tcp') payload.port = Number($('m-f-port').value) || 80;
    } else if (type === 'dns') {
        payload.dns_query  = ($('m-f-dnsq').value || '').trim();
        payload.dns_server = ($('m-f-dnssrv').value || '').trim();
        payload.host = payload.dns_query;
    } else if (type === 'heartbeat') {
        payload.heartbeat_interval = Number($('m-f-hbint').value) || 300;
    }
    return payload;
}

async function svcTestPreview() {
    const btn = $('m-test-btn');
    btn.textContent = '⟳ TESTING…';
    btn.disabled = true;
    $('m-test-status').textContent = '';
    $('m-results').style.display = 'none';
    try {
        const res = await fetch('/api/services/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_svcModalPayload()),
        });
        const j = await res.json();
        _svcRenderPreviewResult(j);
        $('m-results').style.display = 'block';
        $('m-test-status').textContent = j.check?.up ? '✓ UP' : '✗ DOWN';
        $('m-test-status').style.color = j.check?.up ? '#2dffa1' : '#f87171';
    } catch (e) {
        $('m-test-status').textContent = `Error: ${e.message}`;
        $('m-test-status').style.color = '#f87171';
    }
    btn.textContent = '▶ TEST';
    btn.disabled = false;
}

function _svcRenderPreviewResult(j) {
    const chk = j.check || {};
    const up = chk.up;
    const colUp = up ? '#2dffa1' : '#f87171';
    let html = `<span style="font-weight:700;color:${colUp};">${up ? '▲ UP' : '▼ DOWN'}</span>`;
    if (chk.message) html += ` &nbsp;·&nbsp; <span style="color:#a0c8cc;">${_esc(chk.message)}</span>`;
    if (chk.response_ms != null) html += ` &nbsp;·&nbsp; <span style="color:#4d7479;">${chk.response_ms} ms</span>`;
    if (chk.status_code) html += ` &nbsp;·&nbsp; HTTP ${chk.status_code}`;
    if (chk.ssl) {
        const s = chk.ssl;
        const sc = s.valid ? '#2dffa1' : '#f87171';
        html += `<br><span style="color:#4d7479;">SSL:</span> <span style="color:${sc};">${s.valid ? '✓' : '✗'}</span>`;
        if (s.valid) html += ` ${_esc(s.issuer_cn || s.issuer_org || '')} · expires ${s.not_after} (${s.days_left}d) · ${s.tls_version || ''} · ${s.cipher || ''}`;
        else if (s.error) html += ` <span style="color:#f87171;">${_esc(s.error)}</span>`;
        if (s.sans?.length) html += `<br><span style="color:#4d7479;">SANs:</span> ${s.sans.map(_esc).join(', ')}`;
    }
    if (chk.server) html += `<br><span style="color:#4d7479;">Server:</span> <span style="color:#a0c8cc;">${_esc(chk.server)}</span>`;
    if (chk.x_powered_by) html += ` &nbsp;·&nbsp; <span style="color:#4d7479;">Powered-By:</span> <span style="color:#a0c8cc;">${_esc(chk.x_powered_by)}</span>`;
    $('m-check-result').innerHTML = html;

    // Security findings
    const sec = j.security || [];
    if (sec.length) {
        const rows = sec.map(f => {
            const icon = f.status === 'ok' ? '<span style="color:#2dffa1;">✓</span>' :
                         f.status === 'warn' ? '<span style="color:#ffe83b;">⚠</span>' :
                         '<span style="color:#f87171;">✗</span>';
            return `<tr>
                <td style="padding:3px 8px;color:#4d7479;white-space:nowrap;">${icon} ${_esc(f.name)}</td>
                <td style="padding:3px 8px;color:#a0c8cc;">${_esc(f.detail)}</td>
            </tr>`;
        }).join('');
        $('m-security-result').innerHTML = `
            <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:#4d7479;margin-bottom:4px;">SECURITY SCAN</div>
            <table style="width:100%;border-collapse:collapse;background:#010b0f;border:1px solid #0e2c30;">${rows}</table>`;

        // Recommendations
        const recs = _svcSecurityRecs(sec);
        if (recs.length) {
            $('m-recommendations').innerHTML = '<div style="font-size:9px;font-weight:700;letter-spacing:1px;color:#4d7479;margin:8px 0 4px;">RECOMMENDATIONS</div>'
                + recs.map(r => `<div style="margin-bottom:3px;">· ${r}</div>`).join('');
        } else {
            $('m-recommendations').innerHTML = '<div style="color:#2dffa1;margin-top:6px;">· All security checks passed.</div>';
        }
    } else {
        $('m-security-result').innerHTML = '';
        $('m-recommendations').innerHTML = '';
    }
}

function _svcSecurityRecs(findings) {
    const recs = [];
    const map = {
        'HSTS':                    'Add <code>Strict-Transport-Security: max-age=31536000; includeSubDomains</code>',
        'X-Frame-Options':         'Add <code>X-Frame-Options: SAMEORIGIN</code> or CSP <code>frame-ancestors \'self\'</code>',
        'X-Content-Type-Options':  'Add <code>X-Content-Type-Options: nosniff</code>',
        'CSP':                     'Add <code>Content-Security-Policy</code> header to restrict resource loading',
        'Referrer-Policy':         'Add <code>Referrer-Policy: strict-origin-when-cross-origin</code>',
        'HTTPS Redirect':          'Configure HTTP→HTTPS redirect (301) on your server',
        'Server Header':           'Hide server version: remove or genericize the <code>Server</code> header',
        'X-Powered-By':            'Remove <code>X-Powered-By</code> header to prevent tech fingerprinting',
        'Permissions-Policy':      'Add <code>Permissions-Policy</code> to restrict browser feature access',
    };
    for (const f of findings) {
        if (f.status !== 'ok' && map[f.name]) recs.push(map[f.name]);
    }
    return recs;
}

async function svcSubmitFromModal() {
    const payload = _svcModalPayload();
    $('m-add-status').textContent = '';
    const res = await fetch('/api/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) {
        const j = await res.json();
        svcCloseModal();
        await svcLoad();
        svcCheckOne(j.id);
    } else {
        const j = await res.json().catch(() => ({}));
        $('m-add-status').textContent = j.error || 'Error adding service.';
    }
}

async function svcLoad() {
    _svcData = await fetch('/api/services').then(r => r.json()).catch(() => []);
    svcRender();
}

async function svcCheckAll() {
    const btn = $('svc-check-btn');
    btn.textContent = '⟳ CHECKING…';
    btn.disabled = true;
    $('svc-status').textContent = '';
    try {
        await fetch('/api/services/check', { method: 'POST' });
        await svcLoad();
        $('svc-status').textContent = `Checked: ${new Date().toLocaleTimeString()}`;
    } catch (e) {
        $('svc-status').textContent = 'Check failed.';
    }
    btn.textContent = '⟳ CHECK ALL';
    btn.disabled = false;
}

async function svcCheckOne(sid) {
    await fetch(`/api/services/${sid}/check`, { method: 'POST' });
    await svcLoad();
}

async function svcDelete(sid) {
    if (!confirm('Remove this service?')) return;
    await fetch(`/api/services/${sid}`, { method: 'DELETE' });
    await svcLoad();
}

// ── Render helpers ─────────────────────────────────────────────────────────────

const _SVC_TYPE_COLOR = { http:'#38bdf8', https:'#38bdf8', tcp:'#b878ff', ping:'#2dffa1', dns:'#ffe83b', heartbeat:'#fb923c' };
const _SVC_TYPE_LABEL = { http:'HTTP', https:'HTTPS', tcp:'TCP', ping:'PING', dns:'DNS', heartbeat:'BEAT' };

function _svcTypeBadge(type) {
    const col = _SVC_TYPE_COLOR[type] || '#4d7479';
    const lbl = _SVC_TYPE_LABEL[type] || type.toUpperCase();
    return `<span style="background:${col}18;color:${col};border:1px solid ${col}44;padding:1px 5px;font-size:9px;font-weight:700;letter-spacing:1px;">${lbl}</span>`;
}

function _svcTarget(svc) {
    const t = svc.type;
    if (t === 'http' || t === 'https') {
        const url = svc.target || '';
        return `<a href="${_esc(url)}" target="_blank" rel="noopener" style="color:#38bdf8;text-decoration:none;">${_esc(url)}</a>`;
    }
    if (t === 'tcp')  return `<span style="color:#cfe7ec;">${_esc(svc.host)}:${svc.port}</span>`;
    if (t === 'ping') return `<span style="color:#cfe7ec;">${_esc(svc.host)}</span>`;
    if (t === 'dns')  return `<span style="color:#cfe7ec;">${_esc(svc.dns_query || svc.host)}${svc.dns_server ? ' @'+_esc(svc.dns_server) : ''}</span>`;
    if (t === 'heartbeat') return `<span style="color:#fb923c;font-size:10px;word-break:break-all;">POST /api/heartbeat/${svc.id}</span>`;
    return '—';
}

function _svcLastChecked(svc) {
    const ts = svc.last_checked || svc.last_check_db?.ts;
    if (!ts) return '<span style="color:#4d7479;">never</span>';
    return `<span style="color:#4d7479;">${new Date(ts*1000).toLocaleTimeString()}</span>`;
}

// Uptime Kuma-style bar sparkline
function _svcDots(spark) {
    if (!spark?.length) return '<span style="color:#4d7479;font-size:9px;">no data yet</span>';
    const last = spark.slice(-45);
    return last.map(p => {
        const up = p.status === 'up';
        const col = up
            ? (p.response_ms < 300 ? '#22c55e' : p.response_ms < 800 ? '#ffe83b' : '#fb923c')
            : '#ef4444';
        const tip = up ? `UP · ${p.response_ms}ms` : 'DOWN';
        return `<span title="${tip}" style="display:inline-block;width:6px;height:20px;border-radius:1px;background:${col};margin:0 1px;opacity:0.85;cursor:default;flex-shrink:0;"></span>`;
    }).join('');
}

// Security score badge for card footer
function _svcSecBadge(sec) {
    if (!sec?.length) return '';
    const fail = sec.filter(f => f.status === 'fail').length;
    const warn = sec.filter(f => f.status === 'warn').length;
    const ok   = sec.filter(f => f.status === 'ok').length;
    if (fail > 0) return `<span class="svc-sec-badge fail" title="${ok} ok · ${warn} warn · ${fail} fail">✗ ${fail} issue${fail > 1 ? 's' : ''}</span>`;
    if (warn > 0) return `<span class="svc-sec-badge warn" title="${ok} ok · ${warn} warn · 0 fail">⚠ ${warn} warning${warn > 1 ? 's' : ''}</span>`;
    return `<span class="svc-sec-badge ok" title="${ok}/9 checks passed">✓ secure</span>`;
}

// Compact SSL cell for card stats bar
function _svcSslStatCell(svc) {
    const isHttps = (svc.target || '').startsWith('https://') || svc.type === 'https';
    if (!isHttps) return '';
    const s = svc.last_result?.ssl;
    if (!s) return `<div class="svc-stat-cell"><span class="val" style="color:#4d7479;font-size:10px;">— SSL</span><span class="lbl">CERT</span></div>`;
    if (!s.valid) return `<div class="svc-stat-cell"><span class="val" style="color:#ef4444;font-size:10px;">✗ CERT</span><span class="lbl">INVALID</span></div>`;
    const col = s.days_left < 14 ? '#ef4444' : s.days_left < 30 ? '#fb923c' : '#22c55e';
    return `<div class="svc-stat-cell" title="${s.issuer_org||s.issuer_cn||''} · ${s.not_after}"><span class="val" style="color:${col};">🔒 ${s.days_left}d</span><span class="lbl">CERT</span></div>`;
}

// Single card HTML
function _svcCard(svc) {
    const lr  = svc.last_result;
    const ldb = svc.last_check_db;
    const up  = lr ? lr.up : (ldb ? ldb.status === 'up' : null);
    const cls = up === true ? 'up' : up === false ? 'down' : '';
    const dot = up === true ? '<span class="svc-status-dot up">● UP</span>'
              : up === false ? '<span class="svc-status-dot down">✖ DOWN</span>'
              : '<span class="svc-status-dot pending">— PENDING</span>';

    const rms    = lr?.response_ms ?? ldb?.response_ms;
    const rmsStr = rms != null ? (rms >= 1000 ? `${(rms/1000).toFixed(1)}s` : `${rms}ms`) : '—';
    const rmsCol = rms == null ? '#4d7479' : rms < 300 ? '#22c55e' : rms < 800 ? '#ffe83b' : '#ef4444';
    const u24    = svc.uptime_24h != null ? `${svc.uptime_24h}%` : '—';
    const u30    = svc.uptime_30d != null ? `${svc.uptime_30d}%` : '—';
    const u24col = svc.uptime_24h == null ? '#4d7479' : svc.uptime_24h >= 99 ? '#22c55e' : svc.uptime_24h >= 95 ? '#ffe83b' : '#ef4444';
    const u30col = svc.uptime_30d == null ? '#4d7479' : svc.uptime_30d >= 99 ? '#22c55e' : svc.uptime_30d >= 95 ? '#ffe83b' : '#ef4444';

    const sslCell = _svcSslStatCell(svc);

    // Server software display
    const server = lr?.server || '';
    const xpb    = lr?.x_powered_by || '';
    const softwareStr = [server, xpb].filter(Boolean).join(' · ');

    // Target display for card
    const isHttp = svc.type === 'http' || svc.type === 'https';
    const tgt = isHttp
        ? `<a href="${_esc(svc.target)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:#38bdf8;text-decoration:none;">${_esc(svc.target)}</a>`
        : `<span style="color:#cfe7ec;">${_esc(svc.host || svc.dns_query || '')}</span>`;

    // Status code hint
    const codeHint = lr?.status_code ? `<span style="color:#4d7479;font-size:9px;">HTTP ${lr.status_code}</span>` : '';

    return `<div class="svc-card ${cls}" onclick="svcShowDetail('${svc.id}')">
        <div class="svc-card-head">
            ${dot}
            ${_svcTypeBadge(svc.type)}
            ${codeHint}
            <div class="svc-card-head-right">
                <button class="btn" onclick="event.stopPropagation();svcCheckOne('${svc.id}')" style="font-size:9px;padding:2px 5px;" title="Check now">⟳</button>
                <button class="btn" onclick="event.stopPropagation();svcDelete('${svc.id}')" style="font-size:9px;padding:2px 5px;color:#ef4444;border-color:#ef4444;" title="Remove">✕</button>
            </div>
        </div>
        <div class="svc-card-name" title="${_esc(svc.name)}">${_esc(svc.name)}</div>
        <div class="svc-card-target">${tgt}</div>
        <div class="svc-card-stats">
            <div class="svc-stat-cell"><span class="val" style="color:${rmsCol};">${rmsStr}</span><span class="lbl">RESP</span></div>
            <div class="svc-stat-cell"><span class="val" style="color:${u24col};">${u24}</span><span class="lbl">24H</span></div>
            <div class="svc-stat-cell"><span class="val" style="color:${u30col};">${u30}</span><span class="lbl">30D</span></div>
            ${sslCell}
        </div>
        <div class="svc-card-spark">${_svcDots(svc.spark)}</div>
        <div class="svc-card-footer">
            ${softwareStr ? `<span style="color:#a0c8cc;">${_esc(softwareStr)}</span>` : ''}
            ${_svcSecBadge(lr?.security)}
            <span style="margin-left:auto;">⏱ ${_svcLastChecked(svc)}</span>
        </div>
    </div>`;
}

// ── Detail modal ───────────────────────────────────────────────────────────────

function svcShowDetail(svcId) {
    const svc = _svcData.find(s => s.id === svcId);
    if (!svc) return;
    const lr  = svc.last_result;
    const ldb = svc.last_check_db;
    const up  = lr ? lr.up : (ldb ? ldb.status === 'up' : null);
    const upCol = up === true ? '#22c55e' : up === false ? '#ef4444' : '#4d7479';
    const upLbl = up === true ? '● UP' : up === false ? '✖ DOWN' : '— PENDING';
    const rms   = lr?.response_ms ?? ldb?.response_ms;
    const rmsCol = rms == null ? '#4d7479' : rms < 300 ? '#22c55e' : rms < 800 ? '#ffe83b' : '#ef4444';

    function _statBlock(lbl, val, col) {
        return `<div style="text-align:center;padding:0 16px;">
            <div style="font-size:9px;color:#4d7479;letter-spacing:1px;">${lbl}</div>
            <div style="font-size:20px;font-weight:900;color:${col};margin-top:2px;">${val}</div>
        </div>`;
    }

    const u24col = svc.uptime_24h == null ? '#4d7479' : svc.uptime_24h >= 99 ? '#22c55e' : svc.uptime_24h >= 95 ? '#ffe83b' : '#ef4444';
    const u30col = svc.uptime_30d == null ? '#4d7479' : svc.uptime_30d >= 99 ? '#22c55e' : svc.uptime_30d >= 95 ? '#ffe83b' : '#ef4444';

    let html = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #0e2c30;">
        <div>
            <div style="font-size:9px;color:#4d7479;letter-spacing:1px;margin-bottom:2px;">◤ SERVICE DETAIL · ${_svcTypeBadge(svc.type)}</div>
            <div style="font-size:15px;font-weight:800;color:#cfe7ec;">${_esc(svc.name)}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
            <button class="btn" onclick="_svcDetailRecheck('${svc.id}')" style="font-size:10px;">⟳ RECHECK</button>
            <button onclick="$('svc-detail-overlay').style.display='none'" style="background:none;border:none;color:#4d7479;cursor:pointer;font-size:18px;line-height:1;padding:0 4px;">✕</button>
        </div>
    </div>
    <div style="padding:18px;">

    <!-- Status metrics row -->
    <div style="display:flex;align-items:center;justify-content:space-around;padding:14px 0;border:1px solid #0e2c30;margin-bottom:16px;background:#010b0f;flex-wrap:wrap;gap:8px;">
        ${_statBlock('STATUS', upLbl, upCol)}
        ${rms != null ? _statBlock('RESPONSE', rms + ' ms', rmsCol) : ''}
        ${lr?.status_code ? _statBlock('HTTP', lr.status_code, '#cfe7ec') : ''}
        ${svc.uptime_24h != null ? _statBlock('24H UPTIME', svc.uptime_24h + '%', u24col) : ''}
        ${svc.uptime_30d != null ? _statBlock('30D UPTIME', svc.uptime_30d + '%', u30col) : ''}
    </div>

    ${lr?.message && !lr.up ? `<div style="margin-bottom:14px;padding:8px 12px;background:#140808;border:1px solid #3a1010;font-size:11px;color:#ef4444;word-break:break-all;">✗ ${_esc(lr.message)}</div>` : ''}

    <!-- Target -->
    <div style="margin-bottom:14px;">
        <div style="font-size:9px;color:#4d7479;letter-spacing:1px;margin-bottom:4px;">TARGET</div>
        <div style="font-size:11px;">${_svcTarget(svc)}</div>
        ${svc.type === 'heartbeat' ? `<div style="margin-top:8px;padding:8px 12px;background:#010b0f;border:1px solid #0e2c30;font-size:10px;color:#4d7479;">Send periodic pings to: <span style="color:#fb923c;font-family:monospace;">POST /api/heartbeat/${svc.id}</span></div>` : ''}
    </div>

    <!-- Server software -->
    ${(lr?.server || lr?.x_powered_by) ? `
    <div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #0e2c30;">
        <div style="font-size:9px;color:#4d7479;letter-spacing:1px;margin-bottom:6px;">SERVER SOFTWARE</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:11px;">
            ${lr.server ? `<div><span style="color:#4d7479;font-size:9px;">SERVER · </span><span style="color:#a0c8cc;">${_esc(lr.server)}</span></div>` : ''}
            ${lr.x_powered_by ? `<div><span style="color:#4d7479;font-size:9px;">X-POWERED-BY · </span><span style="color:#a0c8cc;">${_esc(lr.x_powered_by)}</span></div>` : ''}
        </div>
    </div>` : ''}

    ${lr?.ssl ? _svcDetailSsl(lr.ssl) : ''}
    ${lr?.security?.length ? _svcDetailSecurity(lr.security) : (svc.type === 'http' || svc.type === 'https') && up ? '<div style="color:#4d7479;font-size:10px;margin-bottom:14px;">Security scan runs on next check.</div>' : ''}

    <!-- History sparkline -->
    <div style="padding-top:14px;border-top:1px solid #0e2c30;">
        <div style="font-size:9px;color:#4d7479;letter-spacing:1px;margin-bottom:8px;">HISTORY — LAST 45 CHECKS</div>
        <div style="display:flex;align-items:flex-end;gap:1px;min-height:22px;">${_svcDots(svc.spark)}</div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:9px;color:#4d7479;">
            <span>older</span><span>recent</span>
        </div>
    </div>

    </div>`;

    $('svc-detail-body').innerHTML = html;
    $('svc-detail-overlay').style.display = 'flex';
}

async function _svcDetailRecheck(svcId) {
    const btn = document.querySelector('#svc-detail-body .btn');
    if (btn) { btn.textContent = '⟳ CHECKING…'; btn.disabled = true; }
    await svcCheckOne(svcId);
    svcShowDetail(svcId);
}

function _svcDetailSsl(s) {
    if (!s) return '';
    if (!s.valid) {
        return `<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #0e2c30;">
            <div style="font-size:9px;color:#4d7479;letter-spacing:1px;margin-bottom:6px;">SSL CERTIFICATE</div>
            <div style="color:#ef4444;font-weight:700;">✗ INVALID${s.error ? ' — ' + _esc(s.error) : ''}</div>
        </div>`;
    }
    const col = s.days_left < 14 ? '#ef4444' : s.days_left < 30 ? '#fb923c' : '#22c55e';
    const fields = [
        ['STATUS', `<span style="color:${col};font-weight:700;">✓ Valid · ${s.days_left} days left</span>`],
        ['EXPIRES', _esc(s.not_after || '—')],
        s.issuer_org || s.issuer_cn ? ['ISSUER', _esc(s.issuer_org || s.issuer_cn)] : null,
        s.subject_cn ? ['SUBJECT', _esc(s.subject_cn)] : null,
        s.tls_version ? ['TLS VERSION', _esc(s.tls_version)] : null,
        s.cipher ? ['CIPHER', `<span style="font-size:10px;">${_esc(s.cipher)}</span>`] : null,
    ].filter(Boolean);
    return `<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #0e2c30;">
        <div style="font-size:9px;color:#4d7479;letter-spacing:1px;margin-bottom:8px;">SSL CERTIFICATE</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:${s.sans?.length ? '8px':'0'};">
            ${fields.map(([l,v])=>`<div><div style="font-size:9px;color:#4d7479;">${l}</div><div style="color:#cfe7ec;margin-top:2px;">${v}</div></div>`).join('')}
        </div>
        ${s.sans?.length ? `<div><div style="font-size:9px;color:#4d7479;margin-bottom:2px;">SANS</div><div style="color:#38bdf8;font-size:10px;word-break:break-all;">${s.sans.map(_esc).join(', ')}</div></div>` : ''}
    </div>`;
}

function _svcDetailSecurity(sec) {
    if (!sec?.length) return '';
    const rows = sec.map(f => {
        const icon = f.status === 'ok'   ? '<span style="color:#22c55e;">✓</span>'
                   : f.status === 'warn' ? '<span style="color:#ffe83b;">⚠</span>'
                   : '<span style="color:#ef4444;">✗</span>';
        const bg = f.status === 'fail' ? 'background:#120808;' : '';
        return `<tr style="border-bottom:1px solid #070f12;${bg}">
            <td style="padding:5px 10px;white-space:nowrap;">${icon} <span style="color:#cfe7ec;font-size:10px;">${_esc(f.name)}</span></td>
            <td style="padding:5px 10px;color:#a0c8cc;font-size:10px;">${_esc(f.detail)}</td>
        </tr>`;
    }).join('');
    const recs = _svcSecurityRecs(sec);
    return `<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #0e2c30;">
        <div style="font-size:9px;color:#4d7479;letter-spacing:1px;margin-bottom:6px;">SECURITY SCAN</div>
        <table style="width:100%;border-collapse:collapse;background:#010b0f;border:1px solid #0e2c30;">${rows}</table>
        ${recs.length
            ? `<div style="margin-top:10px;padding:8px 12px;background:#0a1418;border:1px solid #14333a;">
                <div style="font-size:9px;color:#4d7479;letter-spacing:1px;margin-bottom:6px;">RECOMMENDATIONS</div>
                ${recs.map(r=>`<div style="font-size:10px;color:#a0c8cc;margin-bottom:3px;">· ${r}</div>`).join('')}
               </div>`
            : `<div style="font-size:10px;color:#22c55e;margin-top:6px;">· All security checks passed.</div>`}
    </div>`;
}

// ── Main render ────────────────────────────────────────────────────────────────

function svcRender() {
    // Stats row
    let total = _svcData.length, upCnt = 0, downCnt = 0, pendCnt = 0;
    for (const s of _svcData) {
        const lr = s.last_result, ldb = s.last_check_db;
        const up = lr ? lr.up : (ldb ? ldb.status === 'up' : null);
        if (up === true) upCnt++;
        else if (up === false) downCnt++;
        else pendCnt++;
    }
    $('svc-stats-row').innerHTML = total ? `
        <div class="svc-stat-card"><span class="lbl">TOTAL</span><span class="val">${total}</span></div>
        <div class="svc-stat-card green"><span class="lbl">UP</span><span class="val">${upCnt}</span></div>
        <div class="svc-stat-card red"><span class="lbl">DOWN</span><span class="val">${downCnt}</span></div>
        ${pendCnt ? `<div class="svc-stat-card grey"><span class="lbl">PENDING</span><span class="val">${pendCnt}</span></div>` : ''}
    ` : '';

    // Cards
    const grid = $('svc-card-grid');
    if (!_svcData.length) {
        grid.innerHTML = '<div style="color:#4d7479;padding:30px;text-align:center;grid-column:1/-1;">No services configured. Click + ADD SERVICE to start monitoring.</div>';
        return;
    }
    grid.innerHTML = _svcData.map(_svcCard).join('');
}
