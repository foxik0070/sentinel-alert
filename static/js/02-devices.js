// 02-devices.js — LAN zařízení, device/vsw modály, aktivní uživatelé, attack history, země, log, utils
function _ipToNum(ip) {
    return (ip || '').split('.').reduce((n, o) => n * 256 + (parseInt(o) || 0), 0);
}

function renderDevices(list) {
    const now = Date.now();
    const newThreshold = 48 * 3600 * 1000;
    const devSettings = (_netSettings.devices || {});
    const vswitches = (_netSettings.virtual_switches || []);

    // Switch/router first, virtual (lxc/qemu) last, then by IP
    const _TYPE_PRI = { switch: 0, router: 0, ap: 0, lxc: 2, qemu: 2 };
    list = [...list].sort((a, b) => {
        const pa = _TYPE_PRI[(devSettings[a.mac] || {}).type] ?? 1;
        const pb = _TYPE_PRI[(devSettings[b.mac] || {}).type] ?? 1;
        return pa !== pb ? pa - pb : _ipToNum(a.ip) - _ipToNum(b.ip);
    });

    // Group by display name — multi-homed devices (eth+wifi, dual-NIC) appear as one row
    const _nameToGroup = new Map();
    const _groups = [];
    for (const d of list) {
        const name = (devSettings[d.mac] || {}).hostname || d.hostname;
        if (name && _nameToGroup.has(name)) {
            _groups[_nameToGroup.get(name)].push(d);
        } else {
            const idx = _groups.length;
            _groups.push([d]);
            if (name) _nameToGroup.set(name, idx);
        }
    }

    const onlineGroups = _groups.filter(g => g.some(d => d.is_online)).length;
    const totalGroups = _groups.length + vswitches.length;
    netCountEl.textContent = `${onlineGroups} / ${totalGroups}`;
    if (hudLan) hudLan.textContent = `${onlineGroups} / ${totalGroups}`;

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

    const _BADGE = { router:'#38bdf8', ap:'#38bdf8', switch:'#38bdf8', lxc:'#a855f7', qemu:'#60a5fa', nas:'#ffe83b', mobile:'#86efac', tv:'#fb923c', printer:'#f97316', server:'#22c55e', rpi:'#ef4444', other:'#ea580c', iot:'#06b6d4', pc:'#94a3b8', network:'#166534' };

    const devHtml = _groups.length ? _groups.map(group => {
        const primary = group.find(d => d.is_online) || group[0];
        const cfg = devSettings[primary.mac] || {};
        const displayName = cfg.hostname || primary.hostname;
        const isOnline = group.some(d => d.is_online);
        const typeBadge = _BADGE[cfg.type] ? ` <span style="color:${_BADGE[cfg.type]};font-size:9px;font-weight:700;">[${cfg.type.toUpperCase()}]</span>` : '';
        const vizDot = cfg.visualize ? ' <span style="color:var(--accent);font-size:9px;" title="Visualize on map">◉</span>' : '';
        const ipList = group.length > 1 ? group.map(d => escape(d.ip)).join(' / ') : escape(primary.ip);
        const label = displayName
            ? `${escape(displayName)}${typeBadge}${vizDot} <span style="color:#4d7479;font-size:10px;">[${ipList}]</span>`
            : ipList;
        const seen = group.reduce((best, d) => (!best || (d.last_seen && d.last_seen > best)) ? d.last_seen : best, null);
        const allPorts = [...new Set(group.flatMap(d => (d.ports || '').split(',').filter(Boolean)))].sort((a,b)=>+a-+b);
        const ports = allPorts.map(p => {
            const cls = ({22:'ssh',80:'web',443:'web',8080:'web',3306:'db',5432:'db',6379:'db'}[+p]) || '';
            return `<span class="port ${cls}">${p}</span>`;
        }).join('');
        const notifyNew = cfg.notify_new !== false;
        const isNew = notifyNew && primary.first_seen &&
                      (now - new Date(primary.first_seen).getTime()) < newThreshold;
        const newBadge = isNew ? ' <span class="badge-new">(NEW)</span>' : '';
        return `
        <div class="row dev clickable ${isOnline ? '' : 'offline'}" data-mac="${escape(primary.mac)}">
            <span class="dot ${isOnline ? 'on' : 'off'}"></span>
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;">
                    <span class="name">${label}${newBadge}</span>
                    <span class="meta">${seen ? timeAgo(seen) : '—'}</span>
                </div>
                <div class="ip">${escape(primary.vendor || primary.ip)}</div>
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
let _ipCounts = new Map(); // ip → total attack count across _attackHistory

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
        const wifiApMac = (_allDevices.find(x => x.ip === '192.168.1.90') || {}).mac || '';
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
let _globeInitialized = false; // prevent loadStatic from resetting camera on periodic refresh

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
        users.sort((a, b) => (b.timestamp || '') > (a.timestamp || '') ? 1 : -1);
        userArcs.length = 0;
        userPoints.length = 0;
        users.forEach((u, i) => {
            if (!u.lat && !u.lon) return; // show in panel but no arc without coordinates
            const colorBase = PROTO_COLOR.who;
            userArcs.push({
                startLat: u.lat, startLng: u.lon, endLat: HOME.lat, endLng: HOME.lon,
                color: [colorBase, colorBase], phase: Math.random(),
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

const _knownBadIPs = new Set(); // IP označené threat-intel feedem

function pushAttackHistory(entry) {
    const ts = entry.ts || entry.timestamp || null;
    const src_ip = entry.src_ip || entry.ip || '?';
    if (!src_ip || src_ip === '?') return;
    if (entry.known_bad) _knownBadIPs.add(src_ip);
    _attackHistory.unshift({
        ts, src_ip,
        country:  entry.country  || '?',
        isp:      entry.isp      || '—',
        dst_port: entry.dst_port || 22,
        protocol: entry.protocol || 'fail2ban',
        lat: entry.lat || 0,
        lon: entry.lon || 0,
        known_bad: !!entry.known_bad,
    });
    _ipCounts.set(src_ip, (_ipCounts.get(src_ip) || 0) + 1);
    // Prune to 24h
    if (ts) {
        const cutoff = Date.now() - _ATTACK_HIST_MAX_S * 1000;
        _attackHistory = _attackHistory.filter(e => !e.ts || new Date(e.ts).getTime() >= cutoff);
    } else if (_attackHistory.length > 200) {
        _attackHistory.length = 200;
    }
    if (!_histPaused) _scheduleHistRender();
}

// Debounce — při dávce eventů max 1 render / 250 ms
let _histRenderTimer = null;
function _scheduleHistRender() {
    if (_histRenderTimer) return;
    _histRenderTimer = setTimeout(() => {
        _histRenderTimer = null;
        renderAttackHistory();
        attackStatsUpdate();
    }, 250);
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
    const _sorted = [...filtered].sort((a, b) => (b.ts || '') > (a.ts || '') ? 1 : -1);
    const showBlock = !_workMode && _lastCfg?.mikrotik_enabled;
    attackHistEl.innerHTML = _sorted.slice(0, 10).map(b => {
        const { time, date } = _fmtLocalTs(b.ts);
        const proto = b.protocol || 'fail2ban';
        const label = _PROTO_LABEL[proto] || proto.toUpperCase();
        const col   = PROTO_COLOR[proto] || 'var(--accent)';
        const cnt   = _ipCounts.get(b.src_ip) || 1;
        const blockBtn = showBlock
            ? `<button class="hist-block-btn" data-ip="${escape(b.src_ip)}" data-proto="${proto}"
                       style="flex-shrink:0;background:none;border:1px solid #14333a;color:#4d7479;
                              font-size:9px;padding:1px 6px;cursor:pointer;font-family:inherit;
                              letter-spacing:1px;align-self:center;" title="Block on MikroTik">⊘</button>`
            : '';
        return `<div class="row ban clickable" data-lat="${b.lat}" data-lon="${b.lon}"
                     data-ip="${escape(b.src_ip)}" data-country="${escape(b.country)}"
                     data-isp="${escape(b.isp)}" data-port="${b.dst_port}" data-protocol="${proto}">
            <span class="port" style="min-width:38px;text-align:center;align-self:center;color:${col};border-color:${col}44;">${label}</span>
            <div style="flex:1;min-width:0;padding-left:4px;">
                <div style="display:flex;justify-content:space-between;gap:4px;">
                    <span class="ip" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${(typeof _isWatched==='function'&&_isWatched(b.src_ip))?'<span style="color:var(--yellow);">⭐</span> ':''}${(b.known_bad||_knownBadIPs.has(b.src_ip))?'<span style="color:var(--red);" title="Known bad — threat intel feed">☠</span> ':''}${escape(b.src_ip)}</span>
                    <span class="meta" style="white-space:nowrap;color:${cnt>1?col:'#4d7479'};" title="${cnt} hit(s) from this IP">${cnt>1?'×'+cnt:time}</span>
                </div>
                <div style="display:flex;justify-content:space-between;gap:4px;">
                    <span style="color:#4d7479;font-size:10px;">${escape(b.country)}</span>
                    <span style="color:#4d7479;font-size:10px;white-space:nowrap;" title="${time} ${date}">${timeAgo(b.ts)}</span>
                </div>
            </div>
            ${blockBtn}
        </div>`;
    }).join('');
    attackHistEl.querySelectorAll('.ban.clickable').forEach(row => {
        row.addEventListener('click', e => {
            if (e.target.closest('.hist-block-btn')) return;
            _attackHistClick(row);
        });
    });
    attackHistEl.querySelectorAll('.hist-block-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            _histBlockConfirm(btn);
        });
    });
}

function _histBlockConfirm(btn) {
    const ip    = btn.dataset.ip;
    const proto = btn.dataset.proto;
    if (btn.dataset.confirming) {
        // Second click = confirm
        clearTimeout(btn._confirmTimer);
        btn.textContent = '…';
        btn.style.color = '#4d7479';
        btn.disabled = true;
        fetch('/api/mikrotik/block', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ ip, comment: `sentinel-hist-${proto}`, timeout: '1w' })
        }).then(r => r.json()).then(r => {
            if (r.ok) {
                btn.textContent = '✓';
                btn.style.color = 'var(--green)';
                btn.style.borderColor = 'var(--green)';
            } else {
                btn.textContent = '✗';
                btn.style.color = 'var(--red)';
                btn.disabled = false;
                btn.dataset.confirming = '';
            }
        }).catch(() => {
            btn.textContent = '✗'; btn.style.color = 'var(--red)'; btn.disabled = false;
        });
    } else {
        // First click = ask for confirmation
        btn.dataset.confirming = '1';
        btn.textContent = 'BLOCK?';
        btn.style.color = 'var(--red)';
        btn.style.borderColor = 'var(--red)';
        // Auto-cancel after 4s
        btn._confirmTimer = setTimeout(() => {
            btn.textContent = '⊘';
            btn.style.color = '#4d7479';
            btn.style.borderColor = '#14333a';
            btn.dataset.confirming = '';
        }, 4000);
    }
}

// Wire attack history filter buttons
document.querySelectorAll('.hist-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        _attackHistFilter = btn.dataset.filter;
        UIState.set('hist-filter', _attackHistFilter);
        document.querySelectorAll('.hist-filter-btn').forEach(b => {
            const active = b.dataset.filter === _attackHistFilter;
            b.style.background = active ? '#0e2228' : '#02060a';
            b.style.color      = active ? 'var(--accent)' : '#4d7479';
        });
        renderAttackHistory();
        if (!_globePaused) _globeFlush();
    });
});

// Restore persisted history filter
{
    const _savedHist = UIState.get('hist-filter', 'all');
    if (_savedHist !== 'all') {
        const b = document.querySelector(`.hist-filter-btn[data-filter="${_savedHist}"]`);
        if (b) b.click();
    }
}

const _BAD_COUNTRIES = new Set(['?','unknown','lan','invalid','nodb','attack','sentinel','local','internal']);

function _computeCountriesFromHistory() {
    const map = {};
    _attackHistory.forEach(a => {
        if (!a.country || _BAD_COUNTRIES.has(a.country.toLowerCase())) return;
        map[a.country] = (map[a.country] || 0) + 1;
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 20)
        .map(([country, hits]) => ({ country, hits }));
}

function renderCountries(list) {
    list = list.filter(c => c.country && !_BAD_COUNTRIES.has((c.country).toLowerCase()));
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


// Bulk block — zablokuje všechny aktuálně zobrazené útočníky (filtr-aware)
async function bulkBlockVisible() {
    const filtered = _attackHistFilter === 'all'
        ? _attackHistory
        : _attackHistory.filter(b => (b.protocol || 'fail2ban') === _attackHistFilter);
    const ips = [...new Set(filtered.map(b => b.src_ip).filter(Boolean))].slice(0, 200);
    if (!ips.length) return;
    if (!confirm(`Zablokovat ${ips.length} IP na MikroTiku (1 týden)?`)) return;
    const r = await fetch('/api/mikrotik/block-batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ips, timeout: '1w' }),
    }).then(x => x.json()).catch(() => ({ ok: false, error: 'request failed' }));
    showToast({
        title: r.ok ? 'BULK BLOCK' : 'BULK BLOCK FAILED',
        body: r.ok ? `${r.blocked} IP zablokováno` : (r.error || '?'),
        color: r.ok ? 'var(--green)' : 'var(--red)',
    });
}
