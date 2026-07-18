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
        { label: 'FAIL2BAN JAILS',            run: () => f2bOpen() },
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
        { label: 'KIOSK MÓD — AUTO-CYKLENÍ TABŮ', run: () => kioskToggle() },
        { label: 'BACKUP DATABÁZE',           run: () => { window.location.href = '/api/backup'; } },
        { label: 'ULOŽIT POHLED',             run: () => viewSave() },
        ...(_views().map(v => ({ label: 'POHLED — ' + v.name, run: () => viewApply(v) }))),
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

    const allActions = _cpStaticActions();
    if (!q) {
        // Připnuté + nedávné akce nahoře (jen bez dotazu)
        _cpPinned().forEach(label => {
            const a = allActions.find(x => x.label === label);
            if (a) items.push({ group: '★ PŘIPNUTÉ', ...a });
        });
        _cpHistory().forEach(label => {
            const a = allActions.find(x => x.label === label);
            if (a && !_cpPinned().includes(label)) items.push({ group: 'NEDÁVNÉ', ...a });
        });
    }
    allActions
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
        // pin toggle jen u akcí (mají v allActions)
        if (it.group !== 'ZAŘÍZENÍ' && it.group !== 'ÚTOČNÍCI' && it.group !== 'SLUŽBY') {
            const pin = document.createElement('span');
            pin.className = 'cp-pin';
            pin.textContent = _cpPinned().includes(it.label) ? '★' : '☆';
            pin.title = 'Připnout';
            pin.addEventListener('click', e => { e.stopPropagation(); cpTogglePin(it.label); });
            el.querySelector('.cp-hint-r').replaceWith(pin);
        } else {
            el.querySelector('.cp-hint-r').textContent = it.hint || '';
        }
        el.addEventListener('click', () => { cpClose(); _cpPushHistory(it.label); it.run(); });
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
    else if (e.key === 'Enter') { const it = _cpItems[_cpSel]; if (it) { cpClose(); _cpPushHistory(it.label); it.run(); } }
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
        <div style="height:260px;"><canvas id="tr-chart"></canvas></div>
        <div class="cp-group" style="padding-left:0;margin-top:10px;">TOP ISP / ASN SÍTĚ <span style="color:var(--muted);font-weight:400;">(zdroje útoků)</span></div>
        <div id="tr-asn" style="max-height:200px;overflow-y:auto;"></div>
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

    // ASN / ISP breakdown pod grafem
    try {
        const asn = await fetch(`/api/stats/asn?days=${days}`).then(r => r.json());
        const rows = asn.rows || [];
        const max = rows.length ? rows[0].n : 1;
        $('tr-asn').innerHTML = rows.map(r => {
            const pct = Math.round(r.n / max * 100);
            return `<div style="display:flex;align-items:center;gap:8px;padding:3px 2px;font-size:11px;">
                <span class="tr-asn-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
                <div style="width:120px;height:10px;background:var(--bg-1);border:1px solid var(--border);flex-shrink:0;">
                    <div style="height:100%;width:${pct}%;background:var(--accent);opacity:0.8;"></div></div>
                <span style="width:52px;text-align:right;font-weight:700;color:var(--accent);flex-shrink:0;">${r.n.toLocaleString()}</span>
                <span style="width:44px;text-align:right;color:var(--muted);flex-shrink:0;" title="unikátní IP">${r.ips} IP</span>
            </div>`;
        }).join('') || '<div class="empty">Žádná data.</div>';
        // názvy ISP přes textContent (data z GeoIP)
        const names = [...$('tr-asn').querySelectorAll('.tr-asn-name')];
        rows.forEach((r, i) => { if (names[i]) { names[i].textContent = r.isp; names[i].title = r.isp; } });
    } catch { $('tr-asn').innerHTML = '<div class="empty">Load failed.</div>'; }
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

    countUp($('sum-today'), s.attacks_today ?? 0);
    const dEl = $('sum-delta');
    if (s.attacks_yesterday > 0) {
        const d = Math.round((s.attacks_today - s.attacks_yesterday) / s.attacks_yesterday * 100);
        dEl.textContent = `${d > 0 ? '+' : ''}${d}% ${d > 0 ? '↑' : d < 0 ? '↓' : ''} vs včera`;
        dEl.className = 'sum-delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '');
    } else { dEl.textContent = ''; dEl.className = 'sum-delta'; }

    countUp($('sum-1h'), s.attacks_last_hour ?? 0);
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

// ================================================================
// KIOSK MÓD — auto-cyklení tabů pro nástěnný display (?kiosk nebo palette)
// ================================================================
const _kiosk = { active: false, timer: null, wakeLock: null, idx: 0, intervalS: 20 };

async function kioskStart(intervalS = 20) {
    if (_kiosk.active) return;
    _kiosk.active = true;
    _kiosk.intervalS = intervalS;
    document.body.classList.add('kiosk-mode');
    // Wake lock — display neusne (podpora jen v secure contextu)
    try { _kiosk.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}

    const tabs = () => [...document.querySelectorAll('.tab-btn')].filter(b => b.offsetParent !== null);
    _kiosk.idx = Math.max(0, tabs().findIndex(b => b.classList.contains('active')));
    _kiosk.timer = setInterval(() => {
        const t = tabs();
        if (!t.length) return;
        _kiosk.idx = (_kiosk.idx + 1) % t.length;
        t[_kiosk.idx].click();
    }, intervalS * 1000);

    showToast({ title: 'KIOSK MÓD', body: `Auto-cyklení tabů po ${intervalS}s · ESC ukončí`, color: 'var(--accent)' });
}

function kioskStop() {
    if (!_kiosk.active) return;
    _kiosk.active = false;
    clearInterval(_kiosk.timer);
    document.body.classList.remove('kiosk-mode');
    _kiosk.wakeLock?.release?.().catch(() => {});
    _kiosk.wakeLock = null;
}

function kioskToggle() { _kiosk.active ? kioskStop() : kioskStart(); }

// Re-acquire wake lock po návratu na záložku (browser ho při skrytí uvolní)
document.addEventListener('visibilitychange', async () => {
    if (_kiosk.active && !document.hidden && !_kiosk.wakeLock) {
        try { _kiosk.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && _kiosk.active) kioskStop(); });

// Auto-start přes ?kiosk nebo ?kiosk=30
{
    const kp = new URLSearchParams(location.search).get('kiosk');
    if (kp !== null) window.addEventListener('load', () => kioskStart(parseInt(kp) || 20));
}

// ================================================================
// FAIL2BAN JAIL MANAGEMENT — přehled jailů napříč hosty + unban
// ================================================================
const _f2b = document.createElement('div');
_f2b.id = 'f2b-modal';
_f2b.className = 'modal hidden';
_f2b.innerHTML = `
    <div class="modal-box" style="width:640px;max-width:96vw;max-height:85vh;display:flex;flex-direction:column;">
        <div class="ph"><span>◤ FAIL2BAN JAILS</span>
            <div style="display:flex;gap:6px;align-items:center;">
                <span class="chip" id="f2b-total">—</span>
                <button class="btn" id="f2b-refresh" style="font-size:10px;">↺</button>
                <button class="btn ghost" onclick="document.getElementById('f2b-modal').classList.add('hidden')">✕</button>
            </div></div>
        <div id="f2b-body" style="flex:1;min-height:0;overflow-y:auto;padding:6px 0;font-size:11px;"></div>
    </div>`;
document.body.appendChild(_f2b);
_f2b.addEventListener('click', e => { if (e.target === _f2b) _f2b.classList.add('hidden'); });
$('f2b-refresh').addEventListener('click', f2bOpen);

async function f2bOpen() {
    _f2b.classList.remove('hidden');
    $('f2b-body').innerHTML = '<div class="skel"></div>'.repeat(4);
    let d;
    try { d = await fetch('/api/fail2ban/jails').then(r => r.json()); }
    catch { $('f2b-body').innerHTML = '<div class="empty">Load failed.</div>'; return; }
    if (d.error) { $('f2b-body').innerHTML = '<div class="empty">Vyžaduje přihlášení.</div>'; return; }
    $('f2b-total').textContent = (d.total_banned ?? 0) + ' banned';

    const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    // jen hosty s aspoň jedním banem nebo chybou; OK bez banů skryjeme do souhrnu
    const withBans = d.hosts.filter(h => h.ok && h.jails.some(j => j.banned_count > 0));
    const errored = d.hosts.filter(h => !h.ok);
    const clean = d.hosts.filter(h => h.ok && !h.jails.some(j => j.banned_count > 0)).length;

    $('f2b-body').innerHTML = (withBans.map(h => `
        <div style="margin:0 0 10px;border:1px solid var(--border);">
            <div style="padding:5px 10px;background:var(--panel-2);font-weight:700;color:var(--accent);">${esc(h.host)}</div>
            ${h.jails.filter(j => j.banned_count > 0).map(j => `
                <div style="padding:6px 10px;border-top:1px solid var(--border);">
                    <div style="color:var(--muted);margin-bottom:4px;">jail <b style="color:var(--fg)">${esc(j.name)}</b> — ${j.banned_count} banned</div>
                    <div style="display:flex;flex-wrap:wrap;gap:4px;">
                        ${j.banned.map(ip => `<span class="f2b-ip" data-host="${esc(h.host)}" data-jail="${esc(j.name)}" data-ip="${esc(ip)}"
                            title="Klikni pro unban">${esc(ip)} ✕</span>`).join('')}
                    </div>
                </div>`).join('')}
        </div>`).join('') || '<div class="empty">Žádné aktivní bany.</div>')
        + `<div style="padding:6px 10px;color:var(--muted);font-size:10px;border-top:1px dashed var(--border);">
            ${clean} hostů bez banů${errored.length ? ` · ${errored.length} nedostupných (${errored.slice(0,3).map(h=>esc(h.host)).join(', ')}${errored.length>3?'…':''})` : ''}</div>`;

    $('f2b-body').querySelectorAll('.f2b-ip').forEach(el => {
        el.addEventListener('click', async () => {
            if (!confirm(`Unban ${el.dataset.ip} z jailu ${el.dataset.jail} na ${el.dataset.host}?`)) return;
            el.style.opacity = '0.5';
            const r = await fetch('/api/fail2ban/unban', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host: el.dataset.host, jail: el.dataset.jail, ip: el.dataset.ip }),
            }).then(x => x.json()).catch(() => ({ ok: false }));
            if (r.ok) { el.remove(); showToast({ title: 'UNBANNED', body: el.dataset.ip, color: 'var(--green)' }); }
            else { el.style.opacity = '1'; showToast({ title: 'UNBAN FAILED', body: r.error || '?', color: 'var(--red)' }); }
        });
    });
}

// ================================================================
// ATTACK TICKER — burzovní páska živých útoků (jen Threat Map)
// ================================================================
function tickerRebuild() {
    const track = $('tk-track');
    if (!track) return;
    const items = (_attackHistory || []).slice(0, 30);
    if (!items.length) { track.innerHTML = '<span class="tk-item">Čekám na data…</span>'; return; }
    track.innerHTML = '';
    items.forEach(a => {
        const el = document.createElement('span');
        el.className = 'tk-item';
        const proto = document.createElement('span');
        proto.style.color = PROTO_COLOR[a.protocol] || 'var(--accent)';
        proto.textContent = (a.protocol || '?').toUpperCase() + ' ';
        const ip = document.createElement('b');
        ip.textContent = a.src_ip;
        el.append(proto, ip, document.createTextNode(` ${a.country || '?'}`));
        track.appendChild(el);
    });
}
function tickerSyncVisibility() {
    const t = $('attack-ticker');
    if (!t) return;
    const show = (typeof _activeTab === 'undefined') || _activeTab === 'threat';
    t.classList.toggle('hidden', !show);
    if (show) tickerRebuild();
}
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', tickerSyncVisibility));
setInterval(tickerSyncVisibility, 20000);
tickerSyncVisibility();

// ================================================================
// DASHBOARD TOOLS — skrytí panelů (Threat Map) + fullscreen/PNG grafů
// ================================================================
(function dashboardTools() {
    // 1) Skrývání panelů v Threat Map gridu (persist)
    const hidden = new Set(UIState.get('threat-hidden', []));
    const panels = [...document.querySelectorAll('#tab-threat > .panel')].filter(p => p.id && p.id !== 'globe-panel');
    panels.forEach(p => {
        if (hidden.has(p.id)) p.classList.add('panel-collapsed');
        const ph = p.querySelector('.ph');
        if (!ph || ph.querySelector('.panel-hide')) return;
        const btn = document.createElement('button');
        btn.className = 'panel-hide';
        btn.title = 'Skrýt panel';
        btn.textContent = '–';
        btn.addEventListener('click', e => {
            e.stopPropagation();
            p.classList.toggle('panel-collapsed');
            const h = p.classList.contains('panel-collapsed');
            if (h) hidden.add(p.id); else hidden.delete(p.id);
            UIState.set('threat-hidden', [...hidden]);
            _syncPanelMenu();
        });
        ph.appendChild(btn);
    });

    // Menu pro obnovení skrytých panelů (v summary baru)
    function _syncPanelMenu() {
        let menu = document.getElementById('panel-restore');
        const collapsed = panels.filter(p => p.classList.contains('panel-collapsed'));
        if (!collapsed.length) { menu?.remove(); return; }
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'panel-restore';
            document.getElementById('summary-bar')?.appendChild(menu);
        }
        menu.innerHTML = '';
        const lbl = document.createElement('span');
        lbl.className = 'sum-lbl'; lbl.textContent = 'SKRYTÉ';
        menu.appendChild(lbl);
        collapsed.forEach(p => {
            const name = p.querySelector('.ph span')?.textContent?.replace(/^◤\s*/, '') || p.id;
            const b = document.createElement('button');
            b.className = 'geo-chip'; b.textContent = '+ ' + name;
            b.addEventListener('click', () => {
                p.classList.remove('panel-collapsed');
                hidden.delete(p.id); UIState.set('threat-hidden', [...hidden]); _syncPanelMenu();
            });
            menu.appendChild(b);
        });
    }
    _syncPanelMenu();

    // 2) Chart panely — fullscreen + PNG export
    document.querySelectorAll('.fsc-chart-panel .ph, .panel > .ph').forEach(ph => {
        const canvas = ph.parentElement.querySelector('canvas');
        if (!canvas || ph.querySelector('.chart-tools')) return;
        const tools = document.createElement('span');
        tools.className = 'chart-tools';
        const png = document.createElement('button');
        png.textContent = '⇩'; png.title = 'Uložit graf jako PNG';
        png.addEventListener('click', e => {
            e.stopPropagation();
            const a = document.createElement('a');
            a.href = canvas.toDataURL('image/png');
            a.download = (canvas.id || 'chart') + '.png';
            a.click();
        });
        const fs = document.createElement('button');
        fs.textContent = '⛶'; fs.title = 'Fullscreen grafu';
        fs.addEventListener('click', e => {
            e.stopPropagation();
            const wrap = canvas.closest('.fsc-chart-wrap') || canvas.parentElement;
            wrap.classList.toggle('chart-fullscreen');
            document.body.classList.toggle('has-fullscreen', wrap.classList.contains('chart-fullscreen'));
        });
        tools.append(png, fs);
        ph.appendChild(tools);
    });
})();

// ESC zavře fullscreen grafu
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        const f = document.querySelector('.chart-fullscreen');
        if (f) { f.classList.remove('chart-fullscreen'); document.body.classList.remove('has-fullscreen'); }
    }
});

// ================================================================
// KONTEXTOVÉ MENU NA IP — pravé tlačítko kdekoli na IP adrese
// ================================================================
const _ctxMenu = document.createElement('div');
_ctxMenu.id = 'ip-ctx-menu';
_ctxMenu.className = 'hidden';
document.body.appendChild(_ctxMenu);

const _IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

function _extractIP(el) {
    // najdi IP v textu elementu nebo jeho data atributech
    const cand = el.dataset?.ip || el.textContent || '';
    const m = cand.match(_IP_RE);
    return m ? m[0] : null;
}

document.addEventListener('contextmenu', e => {
    const el = e.target.closest('[data-ip], .ip, .tk-item, .cp-item, td');
    if (!el) return;
    const ip = _extractIP(el);
    if (!ip) return;
    e.preventDefault();
    _ctxShow(e.clientX, e.clientY, ip);
});

function _ctxShow(x, y, ip) {
    const watched = typeof _isWatched === 'function' && _isWatched(ip);
    const items = [
        ['⧉ IP intel', () => ipIntelOpen(ip)],
        ['⊘ Block (MikroTik)', () => {
            _cpTab('network');
            setTimeout(() => { const i = $('mt-block-ip'); if (i) { i.value = ip; i.focus(); } }, 250);
        }],
        [watched ? '★ Unwatch' : '☆ Watch', async () => {
            const j = await (watched ? wlDel(ip) : wlAdd(ip));
            if (j.error) showToast({ title: 'AUTH REQUIRED', color: 'var(--red)' });
            else showToast({ title: watched ? 'UNWATCHED' : 'WATCHED', body: ip, color: 'var(--yellow)' });
        }],
        ['◎ Globe', () => {
            const a = (_attackHistory || []).find(x => x.src_ip === ip);
            _cpTab('threat'); if (a) centerGlobeOn(a.lat, a.lon);
        }],
        ['⎘ Copy', () => navigator.clipboard?.writeText(ip)],
        ['⬇ Export útoků (CSV)', () => { window.location.href = `/api/export/attacks?fmt=csv&ip=${encodeURIComponent(ip)}`; }],
    ];
    _ctxMenu.innerHTML = `<div class="ctx-head">${ip}</div>`;
    items.forEach(([label, fn]) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', () => { _ctxHide(); fn(); });
        _ctxMenu.appendChild(b);
    });
    _ctxMenu.classList.remove('hidden');
    const w = _ctxMenu.offsetWidth, h = _ctxMenu.offsetHeight;
    _ctxMenu.style.left = Math.min(x, innerWidth - w - 8) + 'px';
    _ctxMenu.style.top = Math.min(y, innerHeight - h - 8) + 'px';
}
function _ctxHide() { _ctxMenu.classList.add('hidden'); }
document.addEventListener('click', _ctxHide);
document.addEventListener('scroll', _ctxHide, true);

// ================================================================
// PALETTE — historie a připnuté akce
// ================================================================
function _cpHistory() { return UIState.get('cp-history', []); }
function _cpPushHistory(label) {
    let h = _cpHistory().filter(l => l !== label);
    h.unshift(label);
    UIState.set('cp-history', h.slice(0, 8));
}
function _cpPinned() { return UIState.get('cp-pinned', []); }
function cpTogglePin(label) {
    let p = _cpPinned();
    p = p.includes(label) ? p.filter(l => l !== label) : [...p, label];
    UIState.set('cp-pinned', p);
    cpRender();
}

// ================================================================
// ONBOARDING TOUR — jednoduchý průvodce při prvním spuštění
// ================================================================
(function onboarding() {
    if (UIState.get('onboarded', false)) return;
    if (new URLSearchParams(location.search).get('solo') || new URLSearchParams(location.search).get('kiosk')) return;
    setTimeout(() => {
        const ov = document.createElement('div');
        ov.id = 'onboard-overlay';
        ov.className = 'modal';
        ov.innerHTML = `
            <div class="modal-box" style="width:460px;">
                <div class="ph"><span>◤ VÍTEJ V SENTINEL-ALERT</span></div>
                <div style="padding:10px 0;font-size:12px;line-height:1.9;color:var(--fg);">
                    <p style="margin:0 0 10px;color:var(--muted);">Rychlý přehled:</p>
                    <div><b style="color:var(--accent)">Ctrl+K</b> — příkazová paleta + hledání</div>
                    <div><b style="color:var(--accent)">1–6</b> — přepínání záložek</div>
                    <div><b style="color:var(--accent)">?</b> — nápověda &amp; zkratky</div>
                    <div><b style="color:var(--accent)">Pravé tlačítko na IP</b> — block / watch / intel</div>
                    <div><b style="color:var(--accent)">Settings → Appearance</b> — barevná schémata, 2FA</div>
                    <div style="margin-top:8px;color:var(--muted);">Globus vpravo nahoře: ⟳ rotace · ARCS/HEAT/POINTS · ▶ 24H replay.</div>
                </div>
                <div class="modal-actions">
                    <button class="btn primary" id="onboard-done" style="width:100%;">ZAČÍT</button>
                </div>
            </div>`;
        document.body.appendChild(ov);
        ov.querySelector('#onboard-done').addEventListener('click', () => {
            UIState.set('onboarded', true); ov.remove();
        });
    }, 1500);
})();

// ================================================================
// HOME/WORK indikátor v HUD — klik otevře nastavení módu
// ================================================================
(function modeIndicator() {
    const el = $('hud-home');
    if (!el) return;
    el.style.cursor = 'pointer';
    el.title = 'Režim HOME/WORK — klikni pro nastavení';
    el.addEventListener('click', () => {
        if (typeof openSettings === 'function' && document.querySelector('.auth-only')?.offsetParent !== null)
            openSettings();
    });
})();

// ================================================================
// ULOŽENÉ POHLEDY — snapshot tab + filtr + schéma
// ================================================================
function _views() { return UIState.get('saved-views', []); }
function viewSave() {
    const name = prompt('Název pohledu:');
    if (!name) return;
    const v = {
        name,
        tab: (typeof _activeTab !== 'undefined') ? _activeTab : 'threat',
        filter: (typeof _attackHistFilter !== 'undefined') ? _attackHistFilter : 'all',
        scheme: localStorage.getItem('sentinel-scheme') || 'default',
    };
    UIState.set('saved-views', [..._views().filter(x => x.name !== name), v]);
    showToast({ title: 'POHLED ULOŽEN', body: name, color: 'var(--green)' });
}
function viewApply(v) {
    if (v.scheme) applyScheme(v.scheme);
    const tb = document.querySelector(`.tab-btn[data-tab="${v.tab}"]`);
    if (tb) tb.click();
    if (v.filter) {
        const fb = document.querySelector(`.hist-filter-btn[data-filter="${v.filter}"]`);
        if (fb) fb.click();
    }
}

// ================================================================
// KLÁVESOVÁ NAVIGACE TABULEK — DB viewer (j/k + Enter)
// ================================================================
let _dbvKbRow = -1;
document.addEventListener('keydown', e => {
    const dbv = $('db-viewer');
    if (!dbv || dbv.classList.contains('hidden')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const rows = [...dbv.querySelectorAll('#dbv-tbody tr')];
    if (!rows.length) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); _dbvKbRow = Math.min(rows.length - 1, _dbvKbRow + 1); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); _dbvKbRow = Math.max(0, _dbvKbRow - 1); }
    else return;
    rows.forEach((r, i) => r.classList.toggle('kb-row', i === _dbvKbRow));
    rows[_dbvKbRow]?.scrollIntoView({ block: 'nearest' });
});
