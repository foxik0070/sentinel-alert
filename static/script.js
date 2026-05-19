// Sentinel-Alert dashboard

const $ = id => document.getElementById(id);
const globeEl    = $('globe-viz');
const netListEl  = $('net-list');
const netCountEl = $('net-count');
const banListEl  = $('ban-list');
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
const MAX_ARCS = 500, MAX_PTS = 500, MAX_LABELS = 30, MAX_FEED = 200;

const arcs = [], points = [], labels = [], rings = [];
const arcTimestamps = []; // track arc creation time for age-based coloring
const homeRings = [];   // permanent target indicator
const homePoints = [];  // permanent target dot

const TX_NIGHT = '//unpkg.com/three-globe/example/img/earth-night.jpg';
const TX_DAY   = '//unpkg.com/three-globe/example/img/earth-blue-marble.jpg';

function pickTexture() {
    const h = new Date().getHours();
    const day = (h >= 7 && h < 19);
    globeModeEl.textContent = day ? 'DAY' : 'NIGHT';
    return day ? TX_DAY : TX_NIGHT;
}

const globe = Globe()(globeEl)
    .globeImageUrl(pickTexture())
    .backgroundColor('rgba(0,0,0,0)')
    .showAtmosphere(true)
    .atmosphereColor('#00ffd5')
    .atmosphereAltitude(0.22)
    .width(globeEl.clientWidth)
    .height(globeEl.clientHeight)
    .arcsData(arcs)
    .arcStartLat(d => d.startLat).arcStartLng(d => d.startLng)
    .arcEndLat(d => d.endLat).arcEndLng(d => d.endLng)
    .arcColor(d => d.color)
    .arcStroke(0.9)
    // Long bright dash, small gap, very fast = smooth flowing trail start→end
    .arcDashLength(0.55).arcDashGap(0.25).arcDashInitialGap(() => Math.random())
    .arcDashAnimateTime(700)
    .arcAltitudeAutoScale(0.7)
    .arcsTransitionDuration(0)
    .pointsData([...points, ...homePoints])
    .pointLat(d => d.lat).pointLng(d => d.lon)
    .pointColor(d => d.color)
    .pointAltitude(d => d.alt ?? 0.01)
    .pointRadius(d => d.radius ?? 0.3)
    .pointLabel(d => d.isHome
        ? `<b>HOME</b><br>${HOME.ip || '—'}<br>${HOME.country || '?'} · ${HOME.isp || '?'}`
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
    .ringRepeatPeriod(d => d.period ?? 800);

globe.controls().autoRotate = true;
globe.controls().autoRotateSpeed = 1.6;
globe.controls().enableDamping = true;

window.addEventListener('resize', () => {
    globe.width(globeEl.clientWidth).height(globeEl.clientHeight);
});

// Refresh texture every 15 min (covers day/night transition).
setInterval(() => globe.globeImageUrl(pickTexture()), 15 * 60 * 1000);

const PROTO_COLOR = {
    ssh:      ['#ff2a5e', '#ffe83b'],
    http:     ['#b878ff', '#00ffd5'],
    fail2ban: ['#ffe83b', '#ff2a5e'],
};

function centerGlobeOn(lat, lon) {
    // Pause rotation for 5 seconds, then resume
    globe.controls().autoRotate = false;
    globe.pointOfView({ lat, lng: lon, altitude: 1.4 }, 900);
    clearTimeout(centerGlobeOn._resumeTimer);
    centerGlobeOn._resumeTimer = setTimeout(() => {
        globe.controls().autoRotate = true;
    }, 5000);
}

function getArcColor(ageSeconds) {
    // Older attacks (>60s) are red, newer attacks fade through to cyan
    // 0-10s: cyan, 10-30s: yellow, 30-60s: orange, >60s: red
    if (ageSeconds < 10) return ['#00ffd5', '#ffe83b']; // cyan to yellow
    if (ageSeconds < 30) return ['#ffaa00', '#ff6600']; // yellow to orange
    if (ageSeconds < 60) return ['#ff6600', '#ff3300']; // orange to red-orange
    return ['#ff2a5e', '#cc0000']; // red
}

function pushAttack(a, isNew = true) {
    if (!a.lat && !a.lon) return; // skip LAN/0,0
    // Calculate age from timestamp if available; for new attacks, age is 0
    let ageSeconds = 0;
    if (a.ts && !isNew) {
        // Old attack from history: calculate actual age from timestamp
        ageSeconds = (Date.now() - new Date(a.ts).getTime()) / 1000;
    }
    // Use age-based color if we have age info, fallback to protocol color
    const [c1, c2] = (ageSeconds !== 0 || a._ageSeconds !== undefined)
        ? getArcColor(ageSeconds)
        : PROTO_COLOR[a.protocol] || ['#00ffd5', '#ffe83b'];

    // Arc: start (origin, dim) → end (HOME, hot). Persistent.
    // Store original attack timestamp for accurate age-based coloring
    const arcObj = { startLat: a.lat, startLng: a.lon, endLat: HOME.lat, endLng: HOME.lon, color: [c1, c2], attackTime: a.ts ? new Date(a.ts).getTime() : Date.now() };
    arcs.push(arcObj);
    arcTimestamps.push(Date.now());
    while (arcs.length > MAX_ARCS) {
        arcs.shift();
        arcTimestamps.shift();
    }
    globe.arcsData([...arcs]);

    points.push({ ...a, color: c1, radius: 0.3, alt: 0.01 });
    while (points.length > MAX_PTS) points.shift();
    globe.pointsData([...points, ...homePoints]);

    if (a.country && !labels.some(l => l.country === a.country)) {
        labels.push({ lat: a.lat, lon: a.lon, country: a.country });
        while (labels.length > MAX_LABELS) labels.shift();
        globe.labelsData([...labels]);
    }

    if (isNew) {
        // Impact ring at origin
        const originRing = { lat: a.lat, lon: a.lon, maxR: 3, speed: 2, period: 600,
                             color: t => `rgba(255,42,94,${1 - t})` };
        // Hit ring at HOME (target flash)
        const hitRing = { lat: HOME.lat, lon: HOME.lon, maxR: 2.2, speed: 3, period: 500,
                          color: t => `rgba(255,232,59,${1 - t})` };
        rings.push(originRing, hitRing);
        globe.ringsData([...rings, ...homeRings]);
        setTimeout(() => {
            rings.splice(rings.indexOf(originRing), 1);
            rings.splice(rings.indexOf(hitRing), 1);
            globe.ringsData([...rings, ...homeRings]);
        }, 2400);

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

function renderDevices(list) {
    const online = list.filter(d => d.is_online).length;
    netCountEl.textContent = `${online} / ${list.length}`;
    hudLan.textContent = `${online} / ${list.length}`;
    if (!list.length) { netListEl.innerHTML = '<div class="empty">No devices.</div>'; return; }

    netListEl.innerHTML = list.map(d => {
        const seen = d.last_seen ? timeAgo(d.last_seen) : '—';
        const ports = (d.ports || '').split(',').filter(Boolean).map(p => {
            const cls = ({22:'ssh',80:'web',443:'web',8080:'web',3306:'db',5432:'db',6379:'db'}[+p]) || '';
            return `<span class="port ${cls}">${p}</span>`;
        }).join('');
        return `
        <div class="row dev clickable ${d.is_online ? '' : 'offline'}" data-mac="${escape(d.mac)}">
            <span class="dot ${d.is_online ? 'on' : 'off'}"></span>
            <div style="flex:1; min-width:0;">
                <div style="display:flex; justify-content:space-between;">
                    <span class="name">${escape(d.hostname || d.ip)}</span>
                    <span class="meta">${seen}</span>
                </div>
                <div class="ip">${d.ip} · ${escape(d.vendor || '')}</div>
                ${ports ? `<div class="ports">${ports}</div>` : ''}
            </div>
        </div>`;
    }).join('');

    // Add click handlers to show device details
    netListEl.querySelectorAll('.dev.clickable').forEach(row => {
        row.addEventListener('click', async () => {
            const mac = row.dataset.mac;
            const d = await fetch(`/api/device/${encodeURIComponent(mac)}`).then(r => r.ok ? r.json() : null);
            if (!d) return;
            const modal = document.getElementById('detail-modal');
            document.getElementById('detail-title').textContent = '◤ ' + (d.hostname || d.ip);
            document.getElementById('detail-body').innerHTML = `
                <div style="display: grid; grid-template-columns: 100px 1fr; gap: 4px 12px; padding: 4px 0; font-size: 11px;">
                    <div style="color: #4d7479;">HOSTNAME</div><div style="color: #cfe7ec;">${escape(d.hostname || '—')}</div>
                    <div style="color: #4d7479;">IP</div><div style="color: #cfe7ec;">${escape(d.ip)}</div>
                    <div style="color: #4d7479;">MAC</div><div style="color: #cfe7ec;">${escape(d.mac)}</div>
                    <div style="color: #4d7479;">VENDOR</div><div style="color: #cfe7ec;">${escape(d.vendor || '—')}</div>
                    <div style="color: #4d7479;">STATUS</div><div style="color: #cfe7ec;">${d.is_online ? 'ONLINE' : 'OFFLINE'}</div>
                    <div style="color: #4d7479;">FIRST SEEN</div><div style="color: #cfe7ec;">${escape(d.first_seen || '—')}</div>
                    <div style="color: #4d7479;">LAST SEEN</div><div style="color: #cfe7ec;">${escape(d.last_seen || '—')}</div>
                    <div style="color: #4d7479;">PORTS</div><div style="color: #cfe7ec;">${escape(d.ports || 'none')}</div>
                </div>`;
            const actionsDiv = document.getElementById('detail-actions');
            actionsDiv.innerHTML = '';
            const copyIpBtn = document.createElement('button');
            copyIpBtn.className = 'btn';
            copyIpBtn.textContent = 'COPY IP';
            copyIpBtn.addEventListener('click', () => navigator.clipboard.writeText(d.ip));
            const copyMacBtn = document.createElement('button');
            copyMacBtn.className = 'btn';
            copyMacBtn.textContent = 'COPY MAC';
            copyMacBtn.addEventListener('click', () => navigator.clipboard.writeText(d.mac));
            const closeBtn = document.createElement('button');
            closeBtn.className = 'btn ghost';
            closeBtn.textContent = 'CLOSE';
            closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
            actionsDiv.appendChild(copyIpBtn);
            actionsDiv.appendChild(copyMacBtn);
            actionsDiv.appendChild(closeBtn);
            modal.classList.remove('hidden');
        });
    });
}

function renderBans(list) {
    if (!list.length) { banListEl.innerHTML = '<div class="empty">No fail2ban data yet.</div>'; return; }
    banListEl.innerHTML = list.map(b => `
        <div class="row ban clickable" data-lat="${b.lat}" data-lon="${b.lon}" data-ip="${b.src_ip || b.ip}"
             data-country="${escape(b.country || '?')}" data-isp="${escape(b.isp || '—')}"
             data-port="${b.dst_port || 22}" data-protocol="${b.protocol || 'fail2ban'}">
            <span class="ip">${b.src_ip || b.ip}</span>
            <span class="country">${b.country || '?'}</span>
        </div>`).join('');
    // Add click handlers to center globe and show details
    banListEl.querySelectorAll('.ban.clickable').forEach(row => {
        row.addEventListener('click', () => {
            const lat = parseFloat(row.dataset.lat);
            const lon = parseFloat(row.dataset.lon);
            const ip = row.dataset.ip;
            const country = row.dataset.country;
            const isp = row.dataset.isp;
            const port = row.dataset.port;
            const protocol = row.dataset.protocol;

            if (lat && lon) {
                globe.pointOfView({ lat, lng: lon, altitude: 1.4 }, 900);
                globe.controls().autoRotate = false;
                clearTimeout(focusOn._t = focusOn._t || {});
                focusOn._t = setTimeout(() => { globe.controls().autoRotate = true; }, 8000);
                // Show ban detail in attack card
                card.classList.add('hot');
                acIp.textContent = ip;
                acCountry.textContent = country;
                acIsp.textContent = isp;
                acVec.textContent = `:${port}/${protocol.toUpperCase()}`;
                clearTimeout(focusOn._t2 = focusOn._t2 || {});
                focusOn._t2 = setTimeout(() => card.classList.remove('hot'), 10000);
            }
        });
    });
}

function renderCountries(list) {
    ctyCountEl.textContent = list.length;
    if (!list.length) { countryListEl.innerHTML = '<div class="empty">No attacks yet.<br>Click <b>INJECT DEMO</b> to test.</div>'; return; }
    const max = Math.max(...list.map(c => c.hits));
    countryListEl.innerHTML = list.map(c => `
        <div class="row cty">
            <span class="name">${escape(c.country)}</span>
            <span class="bar"><i style="width:${(c.hits/max*100)|0}%"></i></span>
            <span class="hits">${c.hits}</span>
        </div>`).join('');
}

function pushLog(l, prepend = true) {
    const ts = (l.ts || new Date().toISOString()).substring(11, 19);
    const row = document.createElement('div');
    row.className = `row level-${l.level || 'info'}`;
    row.innerHTML = `<span class="ts">${ts}</span>
        <span class="src ${l.source || 'system'}">${l.source || 'sys'}</span>
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
    try {
        const cfg = await fetch('/api/config').then(r => r.json());
        HOME = { lat: cfg.home_lat, lon: cfg.home_lon,
                 ip: cfg.home_ip, country: cfg.home_country, isp: cfg.home_isp };
        hudHome.textContent = cfg.home_ip
            ? `${cfg.home_ip} · ${cfg.home_country || '?'}`
            : `${cfg.home_lat},${cfg.home_lon}`;
        // Sentinel status: OFF (no config) → DISCONNECTED (configured but not linked) → LINKED (active)
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
    } catch {}
    const [devs, bans, ctys] = await Promise.all([
        fetch('/api/devices').then(r => r.json()),
        fetch('/api/bans').then(r => r.json()),
        fetch('/api/stats/countries').then(r => r.json()),
    ]);
    renderDevices(devs);
    renderBans(bans);
    renderCountries(ctys);
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
            (m.attacks || []).forEach(a => pushAttack(a, false));
            (m.bans    || []).forEach(b => pushAttack(b, false));
            (m.logs    || []).forEach(l => pushLog(l, false));
        } else if (m.type === 'attack' || m.type === 'ban') {
            pushAttack(m, true);
            pushLog({ level: m.type === 'ban' ? 'attack' : 'attack',
                      source: m.type === 'ban' ? 'fail2ban' : 'honeypot',
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

$('demo-btn').addEventListener('click', () => {
    fetch('/api/demo/attack?count=8', { method: 'POST' });
});

// --- Settings modal ---
const modal = $('settings-modal');
const cfgUrl = $('cfg-url'), cfgToken = $('cfg-token'), cfgHost = $('cfg-hostname');
const cfgResult = $('cfg-result'), settingsStatus = $('settings-status');

let _lastKnownToken = ''; // Track last valid token
async function openSettings() {
    const cfg = await fetch('/api/config').then(r => r.json());
    cfgUrl.value = cfg.sentinel_url || '';
    // If token_set is true, show placeholder; if not, show empty for new entry
    cfgToken.value = cfg.sentinel_token_set ? '••••••••' : '';
    cfgToken.placeholder = 'Paste 64-char token here';
    cfgHost.value = cfg.sentinel_hostname || '';
    settingsStatus.textContent = cfg.sentinel_enabled ? 'CONNECTED' : 'DISCONNECTED';
    settingsStatus.classList.toggle('live', !!cfg.sentinel_enabled);
    cfgResult.textContent = '';
    cfgResult.className = 'cfg-result';
    modal.classList.remove('hidden');
}
function showResult(ok, msg) {
    cfgResult.textContent = msg;
    cfgResult.className = 'cfg-result ' + (ok ? 'ok' : 'err');
}
$('settings-btn').addEventListener('click', openSettings);
$('cfg-close').addEventListener('click', () => modal.classList.add('hidden'));
$('cfg-save').addEventListener('click', async () => {
    const tokenValue = cfgToken.value.trim();
    // If token is the placeholder "••••••••", don't send it (keep existing)
    // If token looks like new/real token (64+ chars), send it
    // If token is empty or short, send as null (clear it)
    let token = undefined;
    if (tokenValue && tokenValue !== '••••••••') {
        // User entered new token
        token = tokenValue;
    } else if (tokenValue === '') {
        // User cleared it
        token = null;
    }
    // else: token stays undefined = keep existing

    const body = { url: cfgUrl.value.trim(),
                   token: token,
                   hostname: cfgHost.value.trim() || undefined };
    const res = await fetch('/api/sentinel/configure', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(r => r.json());
    showResult(res.ok, res.ok ? `OK · HTTP ${res.status}` : `FAIL · ${res.detail}`);
    settingsStatus.textContent = res.ok ? 'CONNECTED' : 'ERROR';
    settingsStatus.classList.toggle('live', !!res.ok);

    // Update Sentinel status from response
    if (res.config) {
        if (!res.config.configured) {
            hudSentinel.textContent = 'OFF';
            hudSentinel.classList.remove('live', 'warn');
        } else if (res.config.enabled) {
            hudSentinel.textContent = res.ok ? 'LINKED' : 'DISCONNECTED';
            hudSentinel.classList.toggle('live', !!res.ok);
            if (!res.ok) hudSentinel.classList.add('warn');
        }
    }

    // Re-fetch config to ensure HUD is updated with actual disk state
    setTimeout(async () => {
        const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
        if (cfg.sentinel_enabled) {
            hudSentinel.textContent = 'LINKED';
            hudSentinel.classList.add('live');
            hudSentinel.classList.remove('warn');
        } else if (cfg.sentinel_url) {
            hudSentinel.textContent = 'DISCONNECTED';
            hudSentinel.classList.remove('live');
            hudSentinel.classList.add('warn');
        }
    }, 500);
});
$('cfg-reset').addEventListener('click', async () => {
    if (!confirm('Reset all Sentinel configuration?')) return;
    const res = await fetch('/api/sentinel/reset', { method: 'POST' }).then(r => r.json());
    if (res.ok) {
        cfgUrl.value = '';
        cfgToken.value = '';
        cfgHost.value = '';
        showResult(true, 'Configuration reset');
        hudSentinel.textContent = 'OFF';
        hudSentinel.classList.remove('live', 'warn');
        settingsStatus.textContent = 'DISCONNECTED';
        settingsStatus.classList.remove('live');
    }
});

$('cfg-test').addEventListener('click', async () => {
    showResult(true, 'testing…');
    try {
        // First show debug info
        const debug = await fetch('/api/sentinel/debug').then(r => r.json());
        const debugMsg = `[DEBUG] URL: ${debug.url_len} chars, Hostname: "${debug.hostname}" (${debug.hostname_len} chars), Token: ${debug.token_len} chars`;
        console.log(debugMsg);

        const res = await fetch('/api/sentinel/test', { method: 'POST' }).then(r => r.json());
        if (res.ok) {
            showResult(true, `✓ Connected · HTTP ${res.status}`);
        } else {
            // Provide detailed error info
            let msg = res.detail || 'Unknown error';
            if (res.status === 401) msg = 'Unauthorized - check hostname and token';
            if (res.status === 400) msg = 'Bad request - check URL format';
            if (res.status === 0) msg = 'Connection failed - check URL and port';
            showResult(false, `FAIL · ${msg}\n\nDEBUG: ${debugMsg}`);
        }
    } catch (e) {
        showResult(false, `ERROR · ${e.message}`);
    }
});
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

setInterval(() => { hudClock.textContent = new Date().toISOString().substring(11, 19); }, 1000);
setInterval(loadStatic, 60000);

loadStatic();
connectWS();

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
const TAB_IDS = { threat: 'tab-threat', security: 'tab-security', proxy: 'tab-proxy' };
let _activeTab = 'threat';

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab === _activeTab) return;
        _activeTab = tab;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        Object.entries(TAB_IDS).forEach(([k, id]) => {
            document.getElementById(id).classList.toggle('hidden', k !== tab);
        });
        if (tab === 'security') {
            fscInit();
            fscUpdate();
            fscLoadHosts();
        }
        if (tab === 'proxy') {
            pscInit();
            pscUpdate();
        }
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
    let needsUpdate = false;
    const now = Date.now();
    arcs.forEach((arc) => {
        // Use original attack timestamp if available, fallback to visualization timestamp
        const ageMs = arc.attackTime ? (now - arc.attackTime) : (now - arcTimestamps[arcs.indexOf(arc)]);
        const ageSeconds = ageMs / 1000;
        const [c1, c2] = getArcColor(ageSeconds);
        if (arc.color[0] !== c1 || arc.color[1] !== c2) {
            arc.color = [c1, c2];
            needsUpdate = true;
        }
    });
    if (needsUpdate) {
        globe.arcsData([...arcs]);
    }
}, 5000);
