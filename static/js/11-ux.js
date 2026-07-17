// 11-ux.js — command palette (Ctrl+K), globální search, klávesové zkratky,
// help overlay, skeleton loading. Načítá se poslední — volá funkce všech tabů.

// ================================================================
// COMMAND PALETTE + GLOBAL SEARCH
// ================================================================
const _cp = document.createElement('div');
_cp.id = 'cmd-palette';
_cp.className = 'modal hidden';
_cp.innerHTML = `
    <div id="cp-box">
        <input id="cp-input" type="text" placeholder="Příkaz nebo hledání — zařízení, IP, služby, akce…" spellcheck="false" autocomplete="off">
        <div id="cp-results"></div>
        <div id="cp-hint">↑↓ výběr · ENTER spustit · ESC zavřít</div>
    </div>`;
document.body.appendChild(_cp);
const _cpInput = _cp.querySelector('#cp-input');
const _cpResults = _cp.querySelector('#cp-results');
let _cpItems = [], _cpSel = 0, _cpDevices = [], _cpServices = [];

function _cpTab(name) {
    const b = document.querySelector(`.tab-btn[data-tab="${name}"]`);
    if (b) b.click();
}

function _cpStaticActions() {
    return [
        { label: 'GO → THREAT MAP',      hint: '1', run: () => _cpTab('threat') },
        { label: 'GO → SECURITY CENTER', hint: '2', run: () => _cpTab('security') },
        { label: 'GO → PROXY MONITOR',   hint: '3', run: () => _cpTab('proxy') },
        { label: 'GO → LOCAL NETWORK',   hint: '4', run: () => _cpTab('network') },
        { label: 'GO → SERVICES',        hint: '5', run: () => _cpTab('services') },
        { label: 'GO → PIHOLE',          hint: '6', run: () => _cpTab('pihole') },
        { label: 'FORCE SECURITY SCAN',       run: () => { _cpTab('security'); fscTriggerScan(); } },
        { label: 'CHECK ALL SERVICES',        run: () => { _cpTab('services'); setTimeout(svcCheckAll, 300); } },
        { label: 'OPEN SETTINGS',             run: () => openSettings() },
        { label: 'DATABASE VIEWER',           run: () => dbvOpen() },
        { label: 'GENERATE REPORT',           run: () => generateReport() },
        { label: 'TOGGLE GLOBE ROTATION',     run: () => _setRotation(_rotationLocked) },
        { label: 'GLOBE VIEW — ARCS / HEAT / POINTS', run: () => $('globe-view-btn')?.click() },
        { label: 'DEVICE SEARCH (NETWORK)',   run: () => { _cpTab('network'); $('net-search-btn')?.click(); } },
        { label: 'SCHEME — CYAN',             run: () => applyScheme('default') },
        { label: 'SCHEME — AMBER',            run: () => applyScheme('amber') },
        { label: 'SCHEME — MATRIX',           run: () => applyScheme('matrix') },
        { label: 'SCHEME — RED ALERT',        run: () => applyScheme('red') },
        { label: 'ATTACK TRENDS — 7 / 30 DNÍ', run: () => trendsOpen(30) },
        { label: 'DAILY REPORTS',             run: () => reportsOpen() },
        { label: 'REPLAY 24H NA GLOBUSU',     run: () => { _cpTab('threat'); replayStart(); } },
        { label: 'HELP / SHORTCUTS',    hint: '?', run: () => helpToggle(true) },
    ];
}

function cpOpen() {
    _cp.classList.remove('hidden');
    _cpInput.value = '';
    _cpSel = 0;
    fetch('/api/devices').then(r => r.ok ? r.json() : []).then(d => { _cpDevices = d || []; cpRender(); }).catch(() => {});
    fetch('/api/services').then(r => r.ok ? r.json() : []).then(s => { _cpServices = Array.isArray(s) ? s : []; }).catch(() => {});
    cpRender();
    setTimeout(() => _cpInput.focus(), 30);
}
function cpClose() { _cp.classList.add('hidden'); }

function cpRender() {
    const q = _cpInput.value.trim().toLowerCase();
    let items = [];

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(q)) {
        items.push({ group: 'AKCE', label: `⊘ BLOCK ${q} — MikroTik`, run: () => {
            _cpTab('network');
            setTimeout(() => {
                const i = $('mt-block-ip');
                if (i) { i.value = q; i.scrollIntoView({ block: 'center' }); i.focus(); }
            }, 250);
        } });
    }

    _cpStaticActions()
        .filter(a => !q || a.label.toLowerCase().includes(q))
        .forEach(a => items.push({ group: 'AKCE', ...a }));

    if (q) {
        _cpDevices
            .filter(d => (d.ip || '').includes(q) || (d.hostname || '').toLowerCase().includes(q) || (d.mac || '').toLowerCase().includes(q))
            .slice(0, 8)
            .forEach(d => items.push({
                group: 'ZAŘÍZENÍ',
                label: `${d.hostname || d.ip} — ${d.ip}`,
                hint: d.is_online ? 'online' : 'offline',
                run: () => { _cpTab('network'); openDeviceModal(d.mac); },
            }));

        const seen = new Set();
        (_attackHistory || [])
            .filter(a => a.src_ip && (a.src_ip.includes(q) || (a.country || '').toLowerCase().includes(q)))
            .filter(a => !seen.has(a.src_ip) && seen.add(a.src_ip))
            .slice(0, 6)
            .forEach(a => items.push({
                group: 'ÚTOČNÍCI',
                label: `${a.src_ip} — ${a.country || '?'}`,
                hint: (_ipCounts.get(a.src_ip) || 1) + '×',
                run: () => { _cpTab('threat'); centerGlobeOn(a.lat, a.lon); },
            }));

        _cpServices
            .filter(s => JSON.stringify([s.name, s.url, s.host, s.dns_query]).toLowerCase().includes(q))
            .slice(0, 6)
            .forEach(s => items.push({
                group: 'SLUŽBY',
                label: `${s.name || s.url || s.host} [${(s.type || '?').toUpperCase()}]`,
                hint: s.status || '',
                run: () => { _cpTab('services'); setTimeout(() => svcShowDetail(s.id), 400); },
            }));
    }

    _cpItems = items.slice(0, 18);
    if (_cpSel >= _cpItems.length) _cpSel = Math.max(0, _cpItems.length - 1);

    let lastGroup = null;
    _cpResults.innerHTML = _cpItems.map((it, i) => {
        const head = it.group !== lastGroup ? `<div class="cp-group">${it.group}</div>` : '';
        lastGroup = it.group;
        return `${head}<div class="cp-item${i === _cpSel ? ' sel' : ''}" data-i="${i}">
            <span class="cp-label"></span><span class="cp-hint-r"></span></div>`;
    }).join('') || '<div class="cp-group">ŽÁDNÉ VÝSLEDKY</div>';
    // labely přes textContent — obsahují data z DB/API
    _cpResults.querySelectorAll('.cp-item').forEach(el => {
        const it = _cpItems[+el.dataset.i];
        el.querySelector('.cp-label').textContent = it.label;
        el.querySelector('.cp-hint-r').textContent = it.hint || '';
        el.addEventListener('click', () => { cpClose(); it.run(); });
        el.addEventListener('mousemove', () => {
            if (_cpSel !== +el.dataset.i) { _cpSel = +el.dataset.i; _cpHighlight(); }
        });
    });
}

function _cpHighlight() {
    _cpResults.querySelectorAll('.cp-item').forEach(el =>
        el.classList.toggle('sel', +el.dataset.i === _cpSel));
}

_cpInput.addEventListener('input', () => { _cpSel = 0; cpRender(); });
_cpInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (_cpSel < _cpItems.length - 1) _cpSel++; _cpHighlight(); _scrollSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (_cpSel > 0) _cpSel--; _cpHighlight(); _scrollSel(); }
    else if (e.key === 'Enter') { const it = _cpItems[_cpSel]; if (it) { cpClose(); it.run(); } }
    else if (e.key === 'Escape') cpClose();
});
function _scrollSel() {
    _cpResults.querySelector('.cp-item.sel')?.scrollIntoView({ block: 'nearest' });
}
_cp.addEventListener('click', e => { if (e.target === _cp) cpClose(); });

// ================================================================
// HELP OVERLAY — zkratky + průvodce panely
// ================================================================
const _help = document.createElement('div');
_help.id = 'help-overlay';
_help.className = 'modal hidden';
_help.innerHTML = `
    <div class="modal-box" style="width:640px;max-height:85vh;overflow-y:auto;">
        <div class="ph"><span>◤ HELP // SENTINEL-ALERT</span>
            <button class="btn ghost" onclick="helpToggle(false)">✕</button></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:10px 0;font-size:11px;">
            <div>
                <div class="cp-group" style="padding-left:0;">KLÁVESOVÉ ZKRATKY</div>
                <table style="width:100%;border-collapse:collapse;line-height:2;">
                    <tr><td><b>Ctrl+K</b> / <b>/</b></td><td>Command palette + hledání</td></tr>
                    <tr><td><b>1 – 6</b></td><td>Přepínání záložek</td></tr>
                    <tr><td><b>?</b></td><td>Tato nápověda</td></tr>
                    <tr><td><b>ESC</b></td><td>Zavřít modál / fullscreen</td></tr>
                </table>
            </div>
            <div>
                <div class="cp-group" style="padding-left:0;">ODKUD TEČOU DATA</div>
                <table style="width:100%;border-collapse:collapse;line-height:1.8;">
                    <tr><td><b>THREAT MAP</b></td><td>honeypot (SSH/HTTP) + fail2ban + proxy útoky → globus</td></tr>
                    <tr><td><b>SECURITY CTR</b></td><td>collector — SSH sběr z hostů (OS, CVE, f2b, fw)</td></tr>
                    <tr><td><b>PROXY MON</b></td><td>nginx stream proxy logy (SNI) přes SSH</td></tr>
                    <tr><td><b>LOCAL NET</b></td><td>ARP scanner + port probe + MikroTik API</td></tr>
                    <tr><td><b>SERVICES</b></td><td>service checker (HTTP/TCP/Ping/DNS/Heartbeat)</td></tr>
                    <tr><td><b>PIHOLE</b></td><td>PiHole API (primary/secondary instance)</td></tr>
                </table>
            </div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:8px;font-size:10px;color:var(--muted);">
            Barvy vektorů: <span style="color:#ffbe00;">SSH</span> ·
            <span style="color:#ff6e00;">HTTP</span> ·
            <span style="color:#e6003c;">HTTPS</span> ·
            <span style="color:#d228ff;">FAIL2BAN</span> ·
            <span style="color:#00c8c8;">uživatelská session</span>
        </div>
    </div>`;
document.body.appendChild(_help);

function helpToggle(show) {
    const on = show !== undefined ? show : _help.classList.contains('hidden');
    _help.classList.toggle('hidden', !on);
}
_help.addEventListener('click', e => { if (e.target === _help) helpToggle(false); });

// ================================================================
// GLOBÁLNÍ KLÁVESOVÉ ZKRATKY
// ================================================================
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        _cp.classList.contains('hidden') ? cpOpen() : cpClose();
        return;
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); cpOpen(); }
    else if (e.key === '?') helpToggle();
    else if (e.key >= '1' && e.key <= '6') {
        const btns = [...document.querySelectorAll('.tab-btn')].filter(b => b.offsetParent !== null);
        const b = btns[+e.key - 1];
        if (b) b.click();
    } else if (e.key === 'Escape') { cpClose(); helpToggle(false); }
});

// ================================================================
// SKELETON LOADING — shimmer místo prázdných panelů při startu
// ================================================================
['net-list', 'attack-hist', 'country-list', 'users-list', 'ast-top-ips'].forEach(id => {
    const el = $(id);
    if (el && !el.children.length)
        el.innerHTML = '<div class="skel"></div>'.repeat(5);
});

// ================================================================
// DRAG & DROP PANELŮ — prohození pozic v Threat Map gridu (tažením za hlavičku)
// ================================================================
(function panelDnd() {
    const panels = [...document.querySelectorAll('#tab-threat > .panel')].filter(p => p.id !== 'globe-panel');
    if (!panels.length) return;

    const saved = UIState.get('threat-areas', null);
    if (saved) panels.forEach(p => { if (saved[p.id]) p.style.gridArea = saved[p.id]; });

    let src = null;
    panels.forEach(p => {
        const ph = p.querySelector('.ph');
        if (!ph || !p.id) return;
        ph.setAttribute('draggable', 'true');
        ph.title = (ph.title ? ph.title + ' · ' : '') + 'Táhni za hlavičku pro prohození panelů';
        ph.addEventListener('dragstart', e => {
            src = p;
            e.dataTransfer.effectAllowed = 'move';
            p.classList.add('dnd-src');
        });
        ph.addEventListener('dragend', () => {
            p.classList.remove('dnd-src');
            panels.forEach(x => x.classList.remove('dnd-over'));
        });
        p.addEventListener('dragover', e => {
            if (src && src !== p) { e.preventDefault(); p.classList.add('dnd-over'); }
        });
        p.addEventListener('dragleave', () => p.classList.remove('dnd-over'));
        p.addEventListener('drop', e => {
            e.preventDefault();
            p.classList.remove('dnd-over');
            if (!src || src === p) return;
            // computed grid-row-start = jméno pojmenované oblasti
            const aSrc = getComputedStyle(src).gridRowStart;
            const aDst = getComputedStyle(p).gridRowStart;
            src.style.gridArea = aDst;
            p.style.gridArea = aSrc;
            const map = {};
            panels.forEach(x => { if (x.style.gridArea) map[x.id] = x.style.gridArea; });
            UIState.set('threat-areas', map);
        });
    });
})();

// ================================================================
// IP INTELLIGENCE KARTA — klik na IP kdekoli → detail + akce
// ================================================================
const _ipm = document.createElement('div');
_ipm.id = 'ipintel-modal';
_ipm.className = 'modal hidden';
_ipm.innerHTML = `
    <div class="modal-box" style="width:480px;max-height:85vh;display:flex;flex-direction:column;">
        <div class="ph"><span id="ipm-title">◤ IP INTEL</span>
            <button class="btn ghost" onclick="document.getElementById('ipintel-modal').classList.add('hidden')">✕</button></div>
        <div id="ipm-body" style="flex:1;min-height:0;overflow-y:auto;padding:6px 0;font-size:11px;"></div>
        <div id="ipm-actions" class="modal-actions" style="flex-shrink:0;border-top:1px solid var(--border);padding-top:8px;flex-wrap:wrap;"></div>
    </div>`;
document.body.appendChild(_ipm);
_ipm.addEventListener('click', e => { if (e.target === _ipm) _ipm.classList.add('hidden'); });

async function ipIntelOpen(ip) {
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return;
    $('ipm-title').textContent = '◤ IP INTEL — ' + ip;
    $('ipm-body').innerHTML = '<div class="skel"></div>'.repeat(4);
    $('ipm-actions').innerHTML = '';
    _ipm.classList.remove('hidden');

    let d;
    try { d = await fetch(`/api/ip/${encodeURIComponent(ip)}/intel`).then(r => r.json()); }
    catch { $('ipm-body').innerHTML = '<div class="empty">Lookup failed.</div>'; return; }

    const esc = s => String(s ?? '—').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const protoRows = (d.protocols || []).map(p =>
        `<tr><td style="color:${PROTO_COLOR[p.protocol] || 'var(--fg)'};font-weight:700;">${esc(p.protocol.toUpperCase())}</td>
         <td style="text-align:right;">${p.n}×</td>
         <td style="text-align:right;color:var(--muted);" title="${esc(p.first_ts)} → ${esc(p.last_ts)}">${timeAgo(p.last_ts)}</td></tr>`).join('');
    const portChips = (d.ports || []).map(p =>
        `<span class="port">:${p.dst_port} ×${p.n}</span>`).join(' ');
    const recentRows = (d.recent || []).map(r =>
        `<tr><td style="color:var(--muted);white-space:nowrap;" title="${esc(r.ts)}">${timeAgo(r.ts)}</td>
         <td style="color:${PROTO_COLOR[r.protocol] || 'var(--fg)'};">${esc((r.protocol || '?').toUpperCase())}:${r.dst_port}</td>
         <td style="color:var(--muted);overflow:hidden;text-overflow:ellipsis;max-width:180px;white-space:nowrap;">${esc(r.payload)}</td></tr>`).join('');

    $('ipm-body').innerHTML = `
        <div style="display:grid;grid-template-columns:90px 1fr;gap:3px 10px;padding:4px 0 10px;color:var(--muted);">
            <span>COUNTRY</span><span style="color:var(--fg)">${esc(d.country)}</span>
            <span>ISP</span><span style="color:var(--fg)">${esc(d.isp)}</span>
            <span>ASN</span><span style="color:var(--fg)">${esc(d.asn)}</span>
            <span>COORDS</span><span style="color:var(--fg)">${(+d.lat).toFixed(3)}, ${(+d.lon).toFixed(3)}</span>
            <span>BANS</span><span style="color:var(--red)">${d.bans?.n || 0}×${d.bans?.last ? ' · last ' + timeAgo(d.bans.last) : ''}</span>
            <span>WATCHLIST</span><span id="ipm-watch-state" style="color:${d.watched ? 'var(--yellow)' : 'var(--muted)'}">${d.watched ? '⭐ WATCHED' : '—'}</span>
        </div>
        ${protoRows ? `<div class="cp-group" style="padding-left:0;">ÚTOKY PODLE VEKTORU</div>
        <table style="width:100%;border-collapse:collapse;line-height:1.9;">${protoRows}</table>` : '<div class="empty">Žádné útoky v DB.</div>'}
        ${portChips ? `<div class="cp-group" style="padding-left:0;margin-top:8px;">CÍLOVÉ PORTY</div><div style="display:flex;gap:4px;flex-wrap:wrap;">${portChips}</div>` : ''}
        ${recentRows ? `<div class="cp-group" style="padding-left:0;margin-top:8px;">POSLEDNÍ UDÁLOSTI</div>
        <table style="width:100%;border-collapse:collapse;line-height:1.8;">${recentRows}</table>` : ''}`;

    const watched = d.watched;
    $('ipm-actions').innerHTML = `
        <button class="btn" id="ipm-watch-btn">${watched ? '★ UNWATCH' : '☆ WATCH'}</button>
        <button class="btn" id="ipm-block-btn" style="color:var(--red);border-color:var(--red);">⊘ BLOCK 1W</button>
        <button class="btn" id="ipm-globe-btn">◎ GLOBE</button>
        <a class="btn" href="https://www.abuseipdb.com/check/${ip}" target="_blank" style="text-decoration:none;">ABUSEIPDB ⧉</a>
        <a class="btn" href="https://bgp.he.net/ip/${ip}" target="_blank" style="text-decoration:none;">WHOIS ⧉</a>
        <a class="btn" href="/api/export/attacks?fmt=csv&ip=${encodeURIComponent(ip)}" style="text-decoration:none;">⬇ CSV</a>
        <button class="btn" id="ipm-copy-btn">⎘ COPY</button>`;

    $('ipm-watch-btn').addEventListener('click', async () => {
        const j = await (watched ? wlDel(ip) : wlAdd(ip));
        if (j.error) { showToast({ title: 'AUTH REQUIRED', body: 'Přihlas se pro úpravu watchlistu', color: 'var(--red)' }); return; }
        showToast({ title: watched ? 'WATCHLIST — REMOVED' : 'WATCHLIST — ADDED', body: ip, color: 'var(--yellow)' });
        ipIntelOpen(ip);
    });
    $('ipm-block-btn').addEventListener('click', async () => {
        const j = await fetch('/api/mikrotik/block', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip, comment: 'sentinel-intel', timeout: '1w' }),
        }).then(r => r.json()).catch(() => ({ ok: false, error: 'request failed' }));
        showToast({
            title: j.ok ? 'BLOCKED ON MIKROTIK' : 'BLOCK FAILED',
            body: j.ok ? ip + ' · 1 week' : (j.error || '?'),
            color: j.ok ? 'var(--green)' : 'var(--red)',
        });
    });
    $('ipm-globe-btn').addEventListener('click', () => {
        _ipm.classList.add('hidden');
        _cpTab('threat');
        if (d.lat || d.lon) centerGlobeOn(d.lat, d.lon);
    });
    $('ipm-copy-btn').addEventListener('click', function () {
        navigator.clipboard?.writeText(ip);
        this.textContent = '✓ COPIED';
    });
}

// Hook: klik na IP v attack card (threat map)
$('ac-ip')?.addEventListener('click', () => {
    const ip = $('ac-ip').textContent;
    if (ip && !ip.includes('-')) ipIntelOpen(ip);
});
if ($('ac-ip')) { $('ac-ip').style.cursor = 'pointer'; $('ac-ip').title = 'IP intelligence'; }

// ================================================================
// TRENDY 7/30 DNÍ — dlouhodobé grafy z alerts.db
// ================================================================
const _trm = document.createElement('div');
_trm.id = 'trends-modal';
_trm.className = 'modal hidden';
_trm.innerHTML = `
    <div class="modal-box" style="width:720px;max-width:96vw;display:flex;flex-direction:column;max-height:85vh;">
        <div class="ph"><span>◤ ATTACK TRENDS</span>
            <div style="display:flex;gap:6px;align-items:center;">
                <button class="chip" id="tr-7"  style="cursor:pointer;">7D</button>
                <button class="chip" id="tr-30" style="cursor:pointer;">30D</button>
                <button class="btn ghost" onclick="document.getElementById('trends-modal').classList.add('hidden')">✕</button>
            </div></div>
        <div id="tr-delta" style="padding:6px 0;font-size:11px;color:var(--muted);"></div>
        <div style="height:300px;"><canvas id="tr-chart"></canvas></div>
    </div>`;
document.body.appendChild(_trm);
_trm.addEventListener('click', e => { if (e.target === _trm) _trm.classList.add('hidden'); });
let _trChart = null;

async function trendsOpen(days = 30) {
    _trm.classList.remove('hidden');
    $('tr-7').style.background  = days === 7  ? 'var(--accent)' : '';
    $('tr-7').style.color       = days === 7  ? '#0a1a1e' : '';
    $('tr-30').style.background = days === 30 ? 'var(--accent)' : '';
    $('tr-30').style.color      = days === 30 ? '#0a1a1e' : '';
    let d;
    try { d = await fetch(`/api/stats/trends?days=${days}`).then(r => r.json()); }
    catch { $('tr-delta').textContent = 'Load failed.'; return; }

    const dayList = [];
    for (let i = days - 1; i >= 0; i--) {
        const dt = new Date(Date.now() - i * 86400000);
        dayList.push(dt.toISOString().slice(0, 10));
    }
    const protos = ['ssh', 'http', 'https'];
    const byProto = {};
    protos.forEach(p => byProto[p] = Object.fromEntries(dayList.map(x => [x, 0])));
    const other = Object.fromEntries(dayList.map(x => [x, 0]));
    (d.rows || []).forEach(r => {
        const bucket = byProto[r.protocol] || other;
        if (r.day in bucket) bucket[r.day] += r.n;
    });
    const bansMap = Object.fromEntries(dayList.map(x => [x, 0]));
    (d.bans || []).forEach(r => { if (r.day in bansMap) bansMap[r.day] += r.n; });

    const delta = d.total_previous > 0
        ? Math.round((d.total_current - d.total_previous) / d.total_previous * 100)
        : null;
    $('tr-delta').innerHTML =
        `Posledních ${days} dní: <b style="color:var(--fg)">${d.total_current}</b> útoků` +
        (delta !== null
            ? ` · vs. předchozí období <b style="color:${delta > 0 ? 'var(--red)' : 'var(--green)'}">${delta > 0 ? '+' : ''}${delta}&nbsp;%&nbsp;${delta > 0 ? '↑' : '↓'}</b>`
            : ' · žádná data pro srovnání');

    const labels = dayList.map(x => x.slice(5));
    const ds = [
        { label: 'SSH',      data: dayList.map(x => byProto.ssh[x]),   backgroundColor: '#ffbe00' },
        { label: 'HTTP',     data: dayList.map(x => byProto.http[x]),  backgroundColor: '#ff6e00' },
        { label: 'HTTPS',    data: dayList.map(x => byProto.https[x]), backgroundColor: '#e6003c' },
        { label: 'OTHER',    data: dayList.map(x => other[x]),         backgroundColor: '#4d7479' },
        { label: 'F2B BANS', data: dayList.map(x => bansMap[x]), type: 'line',
          borderColor: '#d228ff', backgroundColor: 'transparent', tension: 0.3, pointRadius: 2 },
    ];
    if (_trChart) _trChart.destroy();
    _trChart = new Chart($('tr-chart'), {
        type: 'bar',
        data: { labels, datasets: ds },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { stacked: true, ticks: { color: '#4d7479', font: { size: 9 } }, grid: { color: 'rgba(20,51,58,0.4)' } },
                y: { stacked: true, ticks: { color: '#4d7479', font: { size: 9 } }, grid: { color: 'rgba(20,51,58,0.4)' } },
            },
            plugins: {
                legend: { labels: { color: '#cfe7ec', font: { size: 9 }, boxWidth: 10 } },
                datalabels: { display: false },
            },
        },
    });
}
$('tr-7').addEventListener('click', () => trendsOpen(7));
$('tr-30').addEventListener('click', () => trendsOpen(30));

// ================================================================
// SCHEDULED REPORTS — výpis denních reportů
// ================================================================
const _rpm = document.createElement('div');
_rpm.id = 'reports-modal';
_rpm.className = 'modal hidden';
_rpm.innerHTML = `
    <div class="modal-box" style="width:380px;max-height:70vh;display:flex;flex-direction:column;">
        <div class="ph"><span>◤ DAILY REPORTS</span>
            <button class="btn ghost" onclick="document.getElementById('reports-modal').classList.add('hidden')">✕</button></div>
        <div id="rp-list" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px;padding:6px 0;"></div>
        <div style="border-top:1px solid var(--border);padding-top:8px;">
            <button class="btn primary" id="rp-gen" style="width:100%;">⚡ GENERATE NOW</button>
        </div>
    </div>`;
document.body.appendChild(_rpm);
_rpm.addEventListener('click', e => { if (e.target === _rpm) _rpm.classList.add('hidden'); });

async function reportsOpen() {
    _rpm.classList.remove('hidden');
    const list = await fetch('/api/reports').then(r => r.json()).catch(() => []);
    $('rp-list').innerHTML = (Array.isArray(list) && list.length)
        ? list.map(n => `
            <a href="/api/reports/${encodeURIComponent(n)}" target="_blank"
               style="display:block;padding:6px 10px;background:var(--input-bg);border:1px solid var(--border);
                      color:var(--fg);text-decoration:none;font-size:11px;">▤ ${n}</a>`).join('')
        : '<div class="empty">Žádné reporty. Denní se generuje v 6:00, nebo klikni GENERATE NOW.</div>';
}
$('rp-gen').addEventListener('click', async () => {
    const j = await fetch('/api/reports/generate', { method: 'POST' }).then(r => r.json()).catch(() => ({}));
    if (j.ok) { showToast({ title: 'REPORT GENERATED', body: j.name, color: 'var(--green)' }); reportsOpen(); }
    else showToast({ title: 'REPORT FAILED', body: j.error || 'auth required', color: 'var(--red)' });
});

// ================================================================
// DASHBOARD SUMMARY BAR — přehled nad Threat Map (dnes vs. včera…)
// ================================================================
const _PROTO_LABEL_SUM = { ssh: 'SSH', http: 'HTTP', https: 'HTTPS', fail2ban: 'F2B' };

async function summaryUpdate() {
    const bar = $('summary-bar');
    if (!bar || bar.classList.contains('hidden')) return;
    let s;
    try { s = await fetch('/api/stats/summary').then(r => r.json()); }
    catch { return; }

    $('sum-today').textContent = (s.attacks_today ?? 0).toLocaleString();
    const dEl = $('sum-delta');
    if (s.attacks_yesterday > 0) {
        const d = Math.round((s.attacks_today - s.attacks_yesterday) / s.attacks_yesterday * 100);
        dEl.textContent = `${d > 0 ? '+' : ''}${d}% ${d > 0 ? '↑' : d < 0 ? '↓' : ''} vs včera`;
        dEl.className = 'sum-delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '');
    } else { dEl.textContent = ''; dEl.className = 'sum-delta'; }

    $('sum-1h').textContent  = (s.attacks_last_hour ?? 0).toLocaleString();
    $('sum-vec').textContent = s.top_vector
        ? `${_PROTO_LABEL_SUM[s.top_vector] || s.top_vector.toUpperCase()} (${s.top_vector_n})` : '—';
    $('sum-vec').style.color = s.top_vector ? (PROTO_COLOR[s.top_vector] || 'var(--accent)') : 'var(--accent)';
    $('sum-hot').textContent = s.hot_country ? `${s.hot_country} (${s.hot_country_n})` : '—';
    $('sum-dev').textContent = `${s.devices_online ?? 0}/${s.devices_total ?? 0}`;

    const phCell = $('sum-ph-cell');
    if (s.pihole_block_pct != null) { phCell.style.display = ''; $('sum-ph').textContent = s.pihole_block_pct + '%'; }
    else phCell.style.display = 'none';
}

// Bar patří jen na Threat Map — sync s aktivním tabem
function summarySyncVisibility() {
    const bar = $('summary-bar');
    if (!bar) return;
    const show = (typeof _activeTab === 'undefined') || _activeTab === 'threat';
    bar.classList.toggle('hidden', !show);
    if (show) summaryUpdate();
}
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', summarySyncVisibility));
summarySyncVisibility();
setInterval(summaryUpdate, 30000);
