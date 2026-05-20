// Sentinel-Alert dashboard

const $ = id => document.getElementById(id);
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
const MAX_ARCS = 100, MAX_PTS = 200, MAX_LABELS = 30, MAX_FEED = 200;
let _globePaused = false, _histPaused = false;
function _globeFlush() {
    globe.arcsData([...arcs]);
    globe.pointsData([...points, ...homePoints]);
    globe.labelsData([...labels]);
}

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
    .arcStroke(1.2)
    .arcDashLength(1).arcDashGap(0).arcDashInitialGap(0)
    .arcDashAnimateTime(0)
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

// Refresh texture every 15 min (covers day/night transition).
setInterval(() => globe.globeImageUrl(pickTexture()), 15 * 60 * 1000);

// Protocol colors [r,g,b] at full brightness — age dims them
const PROTO_RGB = {
    ssh:      [180,  60, 255],  // purple
    http:     [255, 200,   0],  // yellow
    https:    [255,  42,  94],  // red
    fail2ban: [255, 140,   0],  // orange
    blocked:  [255,  80,   0],  // deep orange
};
const _DEFAULT_RGB = [0, 220, 180];  // green-cyan fallback

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

function centerGlobeOn(lat, lon) {
    globe.controls().autoRotate = false;
    globe.pointOfView({ lat, lng: lon, altitude: 1.4 }, 900);
    clearTimeout(centerGlobeOn._resumeTimer);
    centerGlobeOn._resumeTimer = setTimeout(() => {
        globe.controls().autoRotate = true;
    }, 6000);
}


function pushAttack(a, isNew = true) {
    if (!a.lat && !a.lon) return; // skip LAN/0,0
    const ageSeconds = a.ts ? (Date.now() - new Date(a.ts).getTime()) / 1000 : (isNew ? 0 : MAX_AGE_S);
    if (!isNew && ageSeconds > MAX_AGE_S) return; // skip attacks older than 24h
    const proto = a.protocol || 'ssh';
    const [c1, c2] = getArcColor(proto, ageSeconds);

    // Arc: start (origin, dim) → end (HOME, hot). Persistent.
    // Store original attack timestamp for accurate age-based coloring
    const arcObj = { startLat: a.lat, startLng: a.lon, endLat: HOME.lat, endLng: HOME.lon,
                     color: [c1, c2], attackTime: a.ts ? new Date(a.ts).getTime() : Date.now(),
                     src_ip: a.src_ip, country: a.country, isp: a.isp,
                     dst_port: a.dst_port, protocol: a.protocol };
    arcs.push(arcObj);
    arcTimestamps.push(Date.now());
    while (arcs.length > MAX_ARCS) { arcs.shift(); arcTimestamps.shift(); }

    points.push({ ...a, color: c1, radius: 0.3, alt: 0.01 });
    while (points.length > MAX_PTS) points.shift();

    if (a.country && !labels.some(l => l.country === a.country)) {
        labels.push({ lat: a.lat, lon: a.lon, country: a.country });
        while (labels.length > MAX_LABELS) labels.shift();
    }

    if (!_globePaused) _globeFlush();

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
    const vswitches = (_netSettings.virtual_switches || []);
    netCountEl.textContent = `${online} / ${list.length + vswitches.length}`;
    hudLan.textContent = `${online} / ${list.length + vswitches.length}`;

    const now = Date.now();
    const newThreshold = 48 * 3600 * 1000;
    const devSettings = (_netSettings.devices || {});

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
        const label = displayName
            ? `${escape(displayName)} <span style="color:#4d7479;font-size:10px;">[${escape(d.ip)}]</span>`
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

    netListEl.innerHTML = vswHtml + devHtml;

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
    const devType    = cfg.type        || 'host';
    const parentMac  = cfg.parent_mac  || '';
    const parentPort = cfg.parent_port || '';

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
            <div style="font-size:9px;font-weight:800;letter-spacing:2px;color:#4d7479;">DEVICE ROLE</div>
            <label style="font-size:10px;color:#4d7479;display:flex;flex-direction:column;gap:3px;">Type
                <select id="dd-type" style="background:#02060a;border:1px solid #14333a;color:#cfe7ec;padding:4px 6px;font-family:inherit;font-size:11px;">
                    <option value="host"    ${devType==='host'?'selected':''}>Host</option>
                    <option value="router"  ${devType==='router'?'selected':''}>Router / Gateway</option>
                    <option value="switch"  ${devType==='switch'?'selected':''}>Switch</option>
                    <option value="ap"      ${devType==='ap'?'selected':''}>Access Point</option>
                    <option value="gateway" ${devType==='gateway'?'selected':''}>Internet Gateway</option>
                    <option value="printer" ${devType==='printer'?'selected':''}>Printer</option>
                    <option value="iot"     ${devType==='iot'?'selected':''}>IoT Device</option>
                </select>
            </label>
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
                type:              document.getElementById('dd-type').value,
                parent_mac:        document.getElementById('dd-parent').value,
                parent_port:       document.getElementById('dd-port').value,
                notify_connect:    document.getElementById('dd-nc').checked,
                notify_disconnect: document.getElementById('dd-nd').checked,
                notify_new:        document.getElementById('dd-nn').checked,
            })
        });
        _netSettings = await fetch('/api/network/settings').then(r => r.json()).catch(() => _netSettings);
        saveBtn.textContent = 'SAVED ✓';
        setTimeout(() => { saveBtn.textContent = 'SAVE'; }, 1500);
        fetch('/api/devices').then(r => r.json()).then(renderDevices);
    });

    const copyIpBtn = document.createElement('button');
    copyIpBtn.className = 'btn';
    copyIpBtn.textContent = 'COPY IP';
    copyIpBtn.addEventListener('click', () => navigator.clipboard.writeText(d.ip));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn ghost';
    closeBtn.textContent = 'CLOSE';
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));

    actionsDiv.appendChild(saveBtn);
    actionsDiv.appendChild(copyIpBtn);
    actionsDiv.appendChild(closeBtn);
    modal.classList.remove('hidden');
}

// Virtual switch modal
let _vswEditing = null;
function openVswModal(swId) {
    _vswEditing = swId || null;
    const sw = swId ? (_netSettings.virtual_switches || []).find(s => s.id === swId) : null;
    document.getElementById('vsw-hostname').value = sw ? sw.hostname : '';
    document.getElementById('vsw-ports').value = sw ? sw.ports : 8;
    document.getElementById('vsw-del').style.display = swId ? '' : 'none';
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
    // ts stored as local time "YYYY-MM-DDTHH:MM:SS..." — extract directly, no timezone confusion
    return {
        time: ts.length > 15 ? ts.substring(11, 16) : '—',
        date: ts.length > 9  ? ts.substring(5, 10).replace('-', '/') : '',
    };
}

function renderAttackHistory() {
    if (!_attackHistory.length) {
        attackHistEl.innerHTML = '<div class="empty">No attack history yet.</div>';
        return;
    }
    const _PROTO_LABEL = { fail2ban: 'F2B', ssh: 'SSH', http: 'HTTP', https: 'HTTPS' };
    attackHistEl.innerHTML = _attackHistory.map(b => {
        const { time, date } = _fmtLocalTs(b.ts);
        const proto   = b.protocol || 'fail2ban';
        const label   = _PROTO_LABEL[proto] || proto.toUpperCase();
        const portCls = proto === 'fail2ban' ? 'port ssh' : proto === 'https' ? 'port web' : 'port';
        return `<div class="row ban clickable" data-lat="${b.lat}" data-lon="${b.lon}"
                     data-ip="${escape(b.src_ip)}" data-country="${escape(b.country)}"
                     data-isp="${escape(b.isp)}" data-port="${b.dst_port}" data-protocol="${proto}">
            <span class="${portCls}" style="min-width:38px;text-align:center;align-self:center;">${label}</span>
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
    let cfg = {};
    try {
        cfg = await fetch('/api/config').then(r => r.json());
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

        // Load blocklist onto globe
        if (cfg.blocklist_enabled) loadBlocklist();
    } catch {}
    const [devs, bans, ctys, netCfgInit] = await Promise.all([
        fetch('/api/devices').then(r => r.json()),
        fetch('/api/bans').then(r => r.json()),
        fetch('/api/stats/countries').then(r => r.json()),
        fetch('/api/network/settings').then(r => r.json()).catch(() => ({})),
    ]);
    _netSettings = netCfgInit;
    renderDevices(devs);
    bans.forEach(b => pushAttackHistory(b));
    renderCountries(ctys);
}

function applyTabVisibility(cfg) {
    const btnSecurity = $('tab-btn-security');
    const btnProxy    = $('tab-btn-proxy');
    const btnNetwork  = $('tab-btn-network');
    const lanPanel    = $('lan-panel');
    if (btnSecurity) btnSecurity.style.display = cfg.fsc_enabled === false ? 'none' : '';
    if (btnProxy)    btnProxy.style.display    = cfg.sniproxy_enabled     ? ''     : 'none';
    if (btnNetwork)  btnNetwork.style.display  = cfg.scanner_enabled      ? ''     : 'none';
    if (lanPanel)    lanPanel.style.display    = cfg.scanner_enabled      ? ''     : 'none';
    const mainGrid = document.querySelector('.grid');
    if (mainGrid) mainGrid.classList.toggle('no-scanner', !cfg.scanner_enabled);
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
            (m.attacks       || []).forEach(a => pushAttack(a, false));
            (m.bans          || []).forEach(b => { pushAttack(b, false); pushAttackHistory(b); });
            (m.proxy_attacks || []).forEach(a => { pushAttack(a, false); pushAttackHistory(a); });
            _globePaused = false; _histPaused = false;
            _globeFlush(); renderAttackHistory();
            (m.logs          || []).forEach(l => pushLog(l, false));
        } else if (m.type === 'attack' || m.type === 'ban') {
            pushAttack(m, true);
            if (m.type === 'ban' || m.source === 'proxy') pushAttackHistory(m);
            pushLog({ level: 'attack',
                      source: m.type === 'ban' ? 'fail2ban' : m.source || 'honeypot',
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

async function openSettings() {
    const cfgBody = $('cfg-body');
    const cfgResult = $('cfg-result');
    cfgBody.innerHTML = '<div style="padding:16px;color:#4d7479;">Loading…</div>';
    cfgResult.textContent = ''; cfgResult.className = 'cfg-result';
    _settingsModal.classList.remove('hidden');
    let data = {};
    try { data = await fetch('/api/config/full').then(r => r.json()); } catch(e) {
        cfgBody.innerHTML = `<div style="color:var(--red)">Failed to load config: ${e.message}</div>`; return;
    }
    const SENSITIVE = new Set(['token', 'ha_token', 'password', 'api_key', 'key']);
    const LABELS = { server:'SERVER', home:'HOME LOCATION', sentinel:'SENTINEL LINK',
        honeypot:'HONEYPOT', collector:'COLLECTOR', sniproxy:'SNIPROXY PROXY',
        scanner:'SCANNER', security_center:'SECURITY CENTER', threat:'THREAT INTEL' };
    cfgBody.innerHTML = Object.entries(data).map(([section, keys]) => `
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

loadStatic().then(connectWS);

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
const TAB_IDS = { threat: 'tab-threat', security: 'tab-security', proxy: 'tab-proxy', network: 'tab-network' };
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
        if (tab === 'security') { fscInit(); fscUpdate(); fscLoadHosts(); }
        if (tab === 'proxy')    { pscInit(); pscUpdate(); }
        if (tab === 'network')  { netInit(); }
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
    const now = Date.now();
    const cutoff = now - MAX_AGE_S * 1000;
    const before = arcs.length;
    // Prune arcs older than 24h
    for (let i = arcs.length - 1; i >= 0; i--) {
        const attackTime = arcs[i].attackTime || arcTimestamps[i];
        if (attackTime && attackTime < cutoff) {
            arcs.splice(i, 1);
            arcTimestamps.splice(i, 1);
        }
    }
    // Recolor remaining arcs by age
    arcs.forEach((arc, i) => {
        const attackTime = arc.attackTime || arcTimestamps[i];
        const ageSeconds = attackTime ? (now - attackTime) / 1000 : MAX_AGE_S;
        const [c1, c2] = getArcColor(arc.protocol || 'ssh', ageSeconds);
        arc.color = [c1, c2];
    });
    globe.arcsData([...arcs]);
}, 5000);

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
    host:   { shape: 'circle', r: 10, color: '#2dffa1', stroke: '#00ffd5', icon: '⬤' },
    switch: { shape: 'rect',   w: 28, h: 16, color: '#38bdf8', stroke: '#00b8ff', icon: '▬' },
    router: { shape: 'diamond',r: 12, color: '#b878ff', stroke: '#9b5de5', icon: '◈' },
};

function netNodeColor(n) {
    const dev = _netDevices.get(n.mac);
    const base = (NODE_TYPES[n.type] || NODE_TYPES.host).color;
    if (n.type === 'host' && dev && !dev.is_online) return '#555';
    return base;
}

async function netInit() {
    if (_netInitDone) { netRender(); return; }
    _netInitDone = true;

    const svg = d3.select('#net-svg');
    _netSvg = svg;
    const w = document.getElementById('net-svg').clientWidth  || 800;
    const h = document.getElementById('net-svg').clientHeight || 500;

    svg.append('defs').append('marker')
        .attr('id', 'arrowhead')
        .attr('viewBox', '-0 -5 10 10').attr('refX', 18).attr('refY', 0)
        .attr('orient', 'auto').attr('markerWidth', 6).attr('markerHeight', 6)
        .append('path').attr('d', 'M 0,-5 L 10,0 L 0,5').attr('fill', '#14333a');

    _netG = svg.append('g');

    // Zoom + pan
    svg.call(d3.zoom().scaleExtent([0.2, 4]).on('zoom', e => _netG.attr('transform', e.transform)));

    // Load data
    [_netData, _netSettings] = await Promise.all([
        fetch('/api/topo-data').then(r => r.ok ? r.json() : { nodes: [], links: [] }),
        fetch('/api/network/settings').then(r => r.json()),
    ]);
    const devList = await fetch('/api/devices').then(r => r.json()).catch(() => []);
    _netDevices = new Map(devList.map(d => [d.mac, d]));

    // D3 force simulation
    _netSim = d3.forceSimulation(_netData.nodes)
        .force('link', d3.forceLink(_netData.links).id(d => d.id).distance(120))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(w / 2, h / 2))
        .force('collision', d3.forceCollide(30))
        .on('tick', netTick);

    netRender();
    $('net-node-count').textContent = _netData.nodes.length;
    $('net-link-count').textContent = _netData.links.length;
}

function netRender() {
    if (!_netG) return;
    _netG.selectAll('*').remove();

    const linkSel = _netG.selectAll('.net-link')
        .data(_netData.links).enter().append('line')
        .attr('class', 'net-link')
        .style('stroke', '#14333a').style('stroke-width', 1.5);

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
        .on('click', (ev, d) => { ev.stopPropagation(); netClickNode(d); });

    // Draw shapes
    nodeSel.each(function(d) {
        const g = d3.select(this);
        const cfg = NODE_TYPES[d.type] || NODE_TYPES.host;
        if (d.type === 'switch') {
            g.append('rect')
                .attr('x', -cfg.w/2).attr('y', -cfg.h/2)
                .attr('width', cfg.w).attr('height', cfg.h)
                .attr('rx', 2).style('fill', netNodeColor(d)).style('stroke', cfg.stroke).style('stroke-width', 1.5);
        } else if (d.type === 'router') {
            const r = cfg.r;
            g.append('polygon')
                .attr('points', `0,${-r} ${r},0 0,${r} ${-r},0`)
                .style('fill', netNodeColor(d)).style('stroke', cfg.stroke).style('stroke-width', 1.5);
        } else {
            g.append('circle').attr('r', cfg.r)
                .style('fill', netNodeColor(d)).style('stroke', cfg.stroke).style('stroke-width', 1.5);
        }
        g.append('text').attr('class', 'net-node-label')
            .attr('y', (d.type === 'switch' ? 14 : 18))
            .style('font-size', '10px').style('fill', '#cfe7ec').style('text-anchor', 'middle')
            .style('pointer-events', 'none')
            .text(d.label || d.hostname || d.ip || d.id);
    });

    // Click on canvas = deselect
    _netSvg.on('click', () => { _netSelected = null; netHighlight(); netClosePanel(); });

    _netSim.nodes(_netData.nodes);
    _netSim.force('link').links(_netData.links);
    _netSim.alpha(0.1).restart();

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

function netDragStart(ev, d) {
    if (!_netEdit) return;
    if (!ev.active) _netSim.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
}
function netDragged(ev, d) {
    if (!_netEdit) return;
    d.fx = ev.x; d.fy = ev.y;
}
function netDragEnd(ev, d) {
    if (!_netEdit) return;
    if (!ev.active) _netSim.alphaTarget(0);
    d.fx = null; d.fy = null;
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
            body: JSON.stringify(_netData)
        });
        $('net-hint').textContent = 'Saved.';
        setTimeout(() => { $('net-hint').textContent = _netEdit ? 'EDIT MODE' : ''; }, 2000);
    } catch { $('net-hint').textContent = 'Save failed.'; }
});

$('net-reseed-btn').addEventListener('click', async () => {
    if (!confirm('Reseed from /api/devices? Current topology will be replaced.')) return;
    const devs = await fetch('/api/devices').then(r => r.json()).catch(() => []);
    const w = document.getElementById('net-svg').clientWidth  || 800;
    const h = document.getElementById('net-svg').clientHeight || 500;
    _netData.nodes = devs.map((d, i) => ({
        id: `h-${d.mac}`, type: 'host', label: d.hostname || d.ip,
        hostname: d.hostname, ip: d.ip, mac: d.mac,
        x: 80 + (i % 6) * 130, y: 80 + Math.floor(i / 6) * 130
    }));
    _netData.links = [];
    $('net-node-count').textContent = _netData.nodes.length;
    $('net-link-count').textContent = 0;
    netRender();
});

$('net-panel-close').addEventListener('click', () => { _netSelected = null; netHighlight(); netClosePanel(); });
