// 03-core.js — loadStatic, WebSocket, report, settings modál, auth, theme
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
        if (!_globeInitialized) {
            globe.pointOfView({ lat: HOME.lat, lng: HOME.lon, altitude: 2.2 }, 0);
            _globeInitialized = true;
        }

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
    // In work mode the attacks table is empty; derive countries from ban_history instead.
    const effectiveCts = (_workMode && !ctys.length) ? _computeCountriesFromHistory() : ctys;
    renderCountries(effectiveCts);
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
        if (settingsBtn) settingsBtn.style.display  = "none";
        const btnPihole = $("tab-btn-pihole");
        if (btnPihole)   btnPihole.style.display   = "none";
        const btnMikrotik = $("tab-btn-mikrotik");
        if (btnMikrotik) btnMikrotik.style.display = "none";
        const btnBlockAll = document.querySelector('button[onclick="bulkBlockVisible()"]');
        if (btnBlockAll) btnBlockAll.style.display = "none";
        // In work mode attacks table is empty — hide the tab, ban_history is the default
        const dbvTabAttacks = $('dbv-tab-attacks');
        if (dbvTabAttacks) dbvTabAttacks.style.display = 'none';
        // lan-panel is inside tab-network which is hidden in work mode — no explicit action needed
        // Auth-gated panels
        if (usersPanel)  usersPanel.style.display  = _isAuthenticated ? SHOW : 'none';
        if (logPanel)    logPanel.style.display    = _isAuthenticated ? SHOW : 'none';
        // Grid: swap countries to left, users to right.
        // Remove no-auth FIRST — it may have been applied by applyAuthState() before
        // _workMode was known (checkAuth runs before loadStatic sets _workMode).
        // Leaving no-auth+work-layout together creates a 2-column grid with 3-column
        // area names, which collapses the globe to 280px and auto-places countries.
        if (mainGrid) {
            mainGrid.classList.remove('no-scanner');
            mainGrid.classList.remove('no-auth');
            mainGrid.classList.add('work-layout');
        }
        document.body.classList.add('work-mode');
        // Sync globe canvas to new container size after layout change.
        requestAnimationFrame(() => globe.width(globeEl.clientWidth).height(globeEl.clientHeight));
    } else {
        // Home mode: auth + config flags
        if (btnSecurity) btnSecurity.style.display = (_isAuthenticated && cfg.fsc_enabled !== false) ? '' : 'none';
        if (btnProxy)    btnProxy.style.display    = (_isAuthenticated && cfg.sniproxy_enabled)      ? '' : 'none';
        if (btnNetwork)  btnNetwork.style.display  = (_isAuthenticated && (cfg.scanner_enabled || cfg.mikrotik_enabled)) ? '' : 'none';
        const btnPihole = $('tab-btn-pihole');
        if (btnPihole) btnPihole.style.display = (_isAuthenticated && cfg.pihole_enabled) ? '' : 'none';
        if (settingsBtn) settingsBtn.style.display  = _isAuthenticated ? '' : 'none';
        // lan-panel is now inside tab-network — show/hide based on scanner_enabled
        if (lanPanel) lanPanel.style.display = cfg.scanner_enabled ? '' : 'none';
        const mtSection = $('mikrotik-section');
        if (mtSection) mtSection.classList.toggle('hidden', !(_isAuthenticated && cfg.mikrotik_enabled));
        if (usersPanel)  usersPanel.style.display  = _isAuthenticated ? SHOW : 'none';
        if (logPanel)    logPanel.style.display    = _isAuthenticated ? SHOW : 'none';
        if (mainGrid) {
            mainGrid.classList.remove('work-layout');
            mainGrid.classList.toggle('no-scanner', !cfg.scanner_enabled && _isAuthenticated);
        }
        document.body.classList.remove('work-mode');
    }
}

async function loadBlocklist() {
    try {
        const data = await fetch('/api/blocklist').then(r => r.json());
        const ts48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
        (data.entries || []).forEach(e => pushAttack({
            ...e, src_ip: e.ip || e.src_ip,
            protocol: e.protocol || 'fail2ban',
            dst_port: e.dst_port || (e.protocol === 'https' ? 443 : 22),
            ts: ts48h,
        }, false));
    } catch {}
}

let _wsRetries = 0;
let _wsReconnectTimer = null;

function connectWS() {
    clearTimeout(_wsReconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/live`);
    ws.onopen = () => {
        if (wsStatusEl.textContent === 'OFFLINE')
            showToast({ title: 'SYS LINK RESTORED', color: 'var(--green)', ttl: 4000 });
        _wsRetries = 0;
        document.body.classList.remove('sys-offline');
        wsStatusEl.textContent = 'ONLINE'; wsStatusEl.classList.add('live');
    };
    ws.onclose = () => {
        if (wsStatusEl.textContent === 'ONLINE') {
            showToast({ title: 'SYS LINK LOST', body: 'Reconnecting…', color: 'var(--red)', ttl: 4000, dedupKey: 'ws-lost' });
            playBeep('alarm');
        }
        document.body.classList.add('sys-offline');
        wsStatusEl.textContent = 'OFFLINE'; wsStatusEl.classList.remove('live');
        // Exponenciální backoff 1→30 s + jitter; server po připojení pošle fresh snapshot
        const base = Math.min(30000, 1000 * 2 ** Math.min(_wsRetries, 5));
        const delay = base + Math.random() * 1000;
        _wsRetries++;
        _wsReconnectTimer = setTimeout(connectWS, delay);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'snapshot') {
            _globePaused = true; _histPaused = true;
            // Re-sync: vyčisti stav, aby snapshot po reconnectu nezdvojoval data
            arcs.length = 0; arcTimestamps.length = 0; points.length = 0; labels.length = 0;
            _attackHistory = []; _ipCounts.clear();
            // Per-type quota: each type gets MAX_ARCS/3 slots so all are visible
            const _q = Math.floor(MAX_ARCS / 3);
            (m.bans          || []).slice(-_q).forEach(b => { pushAttack(b, false); pushAttackHistory(b); });
            (m.attacks       || []).slice(-_q).forEach(a => { pushAttack(a, false); pushAttackHistory(a); });
            (m.proxy_attacks || []).slice(-_q).forEach(a => { pushAttack(a, false); pushAttackHistory(a); });
            _globePaused = false; _histPaused = false;
            _globeFlush(); renderAttackHistory();
            refreshCountryPolygons();
            attackStatsUpdate();
            if (typeof updateHotZones === 'function') updateHotZones();
            // In work mode the attacks table is empty; recompute countries from ban data.
            if (_workMode) renderCountries(_computeCountriesFromHistory());
            (m.logs          || []).forEach(l => pushLog(l, false));
        } else if (m.type === 'attack' || m.type === 'ban') {
            pushAttack(m, true);
            if (m.type === 'ban' || m.type === 'attack' || m.source === 'proxy') pushAttackHistory(m);
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
            // Alerting engine + watchlist — výrazný toast, alarm, browser notifikace
            if (m.source === 'watchlist') {
                showToast({ title: 'WATCHLIST HIT', body: m.msg, color: 'var(--yellow)', ttl: 10000 });
                playBeep('alarm');
                browserNotify('WATCHLIST HIT', m.msg);
            } else if (m.source === 'alerts') {
                showToast({ title: 'ALERT', body: m.msg, color: 'var(--red)', ttl: 10000, dedupKey: 'al:' + m.msg });
                playBeep('alarm');
                browserNotify('ALERT', m.msg);
            } else if (m.source === 'selftest' && m.level === 'warn') {
                showToast({ title: 'SELF-TEST', body: m.msg, color: 'var(--yellow)', ttl: 8000, dedupKey: 'st:' + m.msg });
            } else if (m.source === 'anomaly') {
                showToast({ title: 'ATTACK SPIKE', body: m.msg, color: 'var(--red)', ttl: 12000, dedupKey: 'anom:' + m.msg });
                playBeep('alarm');
                browserNotify('ATTACK SPIKE', m.msg);
            } else if (m.source && m.source.startsWith('wh:')) {
                showToast({ title: 'WEBHOOK — ' + m.source.slice(3).toUpperCase(), body: m.msg, color: 'var(--accent)', ttl: 8000 });
            }
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

function _cfgThemeBlock() {
    const curTheme  = localStorage.getItem('sentinel-theme')  || 'dark';
    const curAccent = localStorage.getItem('sentinel-accent') || 'orange';
    const curScheme = localStorage.getItem('sentinel-scheme') || 'default';
    const swatches = ACCENT_PALETTE.map(c => {
        const sel = c.name === curAccent ? `outline:2px solid #fff;outline-offset:2px;` : '';
        return `<div onclick="applyAccent('${c.name}');applyScheme('default');document.querySelectorAll('.scheme-btn').forEach(b=>b.style.outline=b.dataset.scheme==='default'?'2px solid #fff':'');document.querySelectorAll('.accent-swatch').forEach(s=>s.style.outline='');this.style.outline='2px solid #fff';this.style.outlineOffset='2px';"
                     class="accent-swatch" title="${c.name}"
                     style="width:24px;height:24px;border-radius:3px;background:${c.hex};cursor:pointer;border:1px solid rgba(255,255,255,0.2);${sel}flex-shrink:0;"></div>`;
    }).join('');
    const schemeBtns = [
        ['default', 'CYAN',      '#00ffd5'],
        ['amber',   'AMBER',     '#ffb000'],
        ['matrix',  'MATRIX',    '#00ff66'],
        ['red',     'RED ALERT', '#ff2a3c'],
    ].map(([id, lbl, col]) =>
        `<button class="scheme-btn" data-scheme="${id}"
             onclick="applyScheme('${id}');document.querySelectorAll('.scheme-btn').forEach(b=>b.style.outline='');this.style.outline='2px solid #fff';"
             style="border:1px solid ${col};color:${col};${id===curScheme?'outline:2px solid #fff;':''}">${lbl}</button>`
    ).join('');
    return `
    <div class="cfg-field-group">
        <div class="cfg-field-group-title">APPEARANCE</div>
        <div class="cfg-toggle-row" style="margin-bottom:10px;">
            <span class="cfg-toggle-label">LIGHT MODE</span>
            <label class="cfg-toggle">
                <input type="checkbox" id="cfg-theme-toggle"${curTheme==='light'?' checked':''}
                       onchange="applyTheme(this.checked?'light':'dark')">
                <span class="cfg-toggle-slider"></span>
            </label>
        </div>
        <div class="cfg-toggle-row" style="margin-bottom:10px;">
            <span class="cfg-toggle-label">VISUAL FX <span style="color:var(--muted);font-weight:400;">(boot, CRT, glitch, hex-grid)</span></span>
            <label class="cfg-toggle">
                <input type="checkbox"${document.body.classList.contains('fx-on')?' checked':''}
                       onchange="applyFx(this.checked)">
                <span class="cfg-toggle-slider"></span>
            </label>
        </div>
        <div class="cfg-toggle-row" style="margin-bottom:10px;">
            <span class="cfg-toggle-label">SOUND FX <span style="color:var(--muted);font-weight:400;">(pípnutí při útoku, alarm)</span></span>
            <label class="cfg-toggle">
                <input type="checkbox"${UIState.get('sound', false)?' checked':''}
                       onchange="setSound(this.checked)">
                <span class="cfg-toggle-slider"></span>
            </label>
        </div>
        <div class="cfg-toggle-row" style="margin-bottom:10px;">
            <span class="cfg-toggle-label">BROWSER NOTIFIKACE <span style="color:var(--muted);font-weight:400;">(alerty i na pozadí)</span></span>
            <label class="cfg-toggle">
                <input type="checkbox"${UIState.get('browser-notify', false)?' checked':''}
                       onchange="setBrowserNotify(this.checked).then(ok=>{if(!ok)this.checked=false;})">
                <span class="cfg-toggle-slider"></span>
            </label>
        </div>
        <div style="margin-bottom:4px;font-size:9px;letter-spacing:1px;color:var(--muted);">COLOR SCHEME</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;padding:4px 0 10px;">${schemeBtns}</div>
        <div style="margin-bottom:4px;font-size:9px;letter-spacing:1px;color:var(--muted);">ACCENT COLOR</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;padding:4px 0 8px;">${swatches}</div>
    </div>`;
}

function _cfgSecurityBlock() {
    setTimeout(_cfgSecRender, 50);
    return `
    <div class="cfg-field-group">
        <div class="cfg-field-group-title">SECURITY — 2FA & API TOKEN</div>
        <div id="cfg-2fa-box" style="padding:4px 0 8px;font-size:11px;color:var(--muted);">Načítám…</div>
        <div id="cfg-token-box" style="padding:4px 0 8px;font-size:11px;color:var(--muted);border-top:1px dashed var(--border);margin-top:6px;"></div>
    </div>`;
}

async function _cfgSecRender() {
    const box = $('cfg-2fa-box'), tbox = $('cfg-token-box');
    if (!box) return;
    const st = await fetch('/api/2fa/status').then(r => r.json()).catch(() => ({}));
    if (st.enabled) {
        box.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="color:var(--green);">✓ 2FA (TOTP) je aktivní</span>
            <button class="btn ghost" style="color:var(--red);font-size:10px;" onclick="_cfg2faDisable()">VYPNOUT</button></div>`;
    } else {
        box.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;">
            <span>2FA (TOTP) vypnuté</span>
            <button class="btn" style="font-size:10px;" onclick="_cfg2faSetup()">NASTAVIT 2FA</button></div>
            <div id="cfg-2fa-setup"></div>`;
    }
    const tk = await fetch('/api/token').then(r => r.json()).catch(() => ({}));
    tbox.innerHTML = `<div style="font-size:9px;letter-spacing:1px;color:var(--muted);margin-bottom:4px;">READ-ONLY API TOKEN <span style="color:var(--muted);">(GET /api, ne backup/config)</span></div>`
        + (tk.token
            ? `<div style="display:flex;gap:6px;align-items:center;">
                 <input readonly value="${escape(tk.token)}" style="flex:1;background:var(--input-bg);border:1px solid var(--border);color:var(--fg);padding:4px 8px;font-family:monospace;font-size:10px;">
                 <button class="btn" style="font-size:9px;" onclick="navigator.clipboard?.writeText('${escape(tk.token)}');this.textContent='✓'">⎘</button>
                 <button class="btn ghost" style="color:var(--red);font-size:9px;" onclick="_cfgTokenRevoke()">REVOKE</button></div>`
            : `<button class="btn" style="font-size:10px;" onclick="_cfgTokenGen()">VYGENEROVAT TOKEN</button>`);
}

async function _cfg2faSetup() {
    const d = await fetch('/api/2fa/setup', { method: 'POST' }).then(r => r.json());
    const el = $('cfg-2fa-setup');
    if (!el || !d.secret) return;
    el.innerHTML = `<div style="margin-top:8px;padding:8px;background:var(--input-bg);border:1px solid var(--border-2);">
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">1) Přidej do authenticatoru (secret nebo otpauth URI):</div>
        <div style="font-family:monospace;font-size:12px;color:var(--yellow);word-break:break-all;margin-bottom:6px;">${escape(d.secret)}</div>
        <div style="font-size:9px;color:var(--muted);word-break:break-all;margin-bottom:8px;">${escape(d.uri)}</div>
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">2) Zadej vygenerovaný kód pro potvrzení:</div>
        <div style="display:flex;gap:6px;">
            <input id="cfg-2fa-code" type="text" inputmode="numeric" maxlength="6" placeholder="000000"
                style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--fg);padding:5px 8px;font-family:monospace;font-size:14px;letter-spacing:4px;text-align:center;">
            <button class="btn primary" style="font-size:10px;" onclick="_cfg2faEnable()">POTVRDIT</button>
        </div>
        <div id="cfg-2fa-err" style="font-size:10px;color:var(--red);min-height:14px;margin-top:4px;"></div>
    </div>`;
    $('cfg-2fa-code')?.focus();
}

async function _cfg2faEnable() {
    const code = $('cfg-2fa-code')?.value || '';
    const r = await fetch('/api/2fa/enable', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
    }).then(x => x.json()).catch(() => ({}));
    if (r.ok) { showToast({ title: '2FA AKTIVOVÁNO', color: 'var(--green)' }); _cfgSecRender(); }
    else { const e = $('cfg-2fa-err'); if (e) e.textContent = r.error || 'Chyba'; }
}

async function _cfg2faDisable() {
    if (!confirm('Vypnout 2FA?')) return;
    await fetch('/api/2fa/disable', { method: 'POST' });
    showToast({ title: '2FA VYPNUTO', color: 'var(--yellow)' });
    _cfgSecRender();
}

async function _cfgTokenGen() {
    await fetch('/api/token/generate', { method: 'POST' });
    _cfgSecRender();
}
async function _cfgTokenRevoke() {
    await fetch('/api/token/revoke', { method: 'POST' });
    _cfgSecRender();
}

function _cfgWatchlistBlock() {
    // seznam se plní async po vykreslení (viz _cfgWlRender)
    setTimeout(_cfgWlRender, 50);
    return `
    <div class="cfg-field-group">
        <div class="cfg-field-group-title">WATCHLIST <span style="color:var(--muted);font-weight:400;">(IP / prefix „1.2.3." / CIDR)</span></div>
        <div style="display:flex;gap:6px;padding:4px 0 8px;">
            <input id="cfg-wl-input" type="text" placeholder="1.2.3.4"
                style="flex:1;background:var(--input-bg);border:1px solid var(--border-2);color:var(--fg);padding:5px 8px;font-family:inherit;font-size:11px;outline:none;">
            <button class="btn" onclick="_cfgWlAdd()">+ ADD</button>
        </div>
        <div id="cfg-wl-list" style="display:flex;flex-direction:column;gap:3px;max-height:140px;overflow-y:auto;"></div>
    </div>`;
}

async function _cfgWlRender() {
    const box = $('cfg-wl-list');
    if (!box) return;
    await refreshWatchlist();
    box.innerHTML = [...WATCHLIST].map(w => `
        <div style="display:flex;align-items:center;gap:8px;padding:3px 8px;background:var(--input-bg);border:1px solid var(--border);">
            <span style="flex:1;font-family:monospace;font-size:11px;color:var(--yellow);">⭐ ${escape(w)}</span>
            <button class="btn ghost" style="font-size:9px;padding:1px 6px;color:var(--red);" onclick="_cfgWlDel('${escape(w)}')">✕</button>
        </div>`).join('') || '<div style="color:var(--muted);font-size:10px;padding:2px 0;">Watchlist je prázdný.</div>';
}

async function _cfgWlAdd() {
    const inp = $('cfg-wl-input');
    const v = (inp?.value || '').trim();
    if (!v) return;
    const j = await wlAdd(v);
    if (j.error) { showToast({ title: 'AUTH REQUIRED', body: 'Přihlas se pro úpravu watchlistu', color: 'var(--red)' }); return; }
    inp.value = '';
    _cfgWlRender();
    renderAttackHistory();
}

async function _cfgWlDel(entry) {
    await wlDel(entry);
    _cfgWlRender();
    renderAttackHistory();
}

function _cfgField(section, key, val) {
    const SENSITIVE = new Set(['token', 'ha_token', 'password', 'secret', 'api_key', 'key', 'totp_secret', 'api_token']);
    const BOOLEANS  = new Set(['enabled', 'auto_block', 'intel_enabled', 'intel_autoblock']);
    const isBool = BOOLEANS.has(key);
    const isPass = SENSITIVE.has(key);
    const checked = String(val).toLowerCase() === 'true';
    if (isBool) return `
        <div class="cfg-toggle-row">
            <span class="cfg-toggle-label">${key.toUpperCase().replace(/_/g,' ')}</span>
            <label class="cfg-toggle">
                <input type="checkbox" data-section="${section}" data-key="${key}" data-bool="1"${checked?' checked':''}>
                <span class="cfg-toggle-slider"></span>
            </label>
        </div>`;
    return `
        <div class="cfg-field">
            <label>${key.toUpperCase().replace(/_/g,' ')}</label>
            <input type="${isPass?'password':'text'}" data-section="${section}" data-key="${key}"
                   value="${escape(String(val))}">
        </div>`;
}

function _cfgGroup(title, sections, data) {
    const inner = sections.flatMap(sec => {
        const keys = data[sec];
        if (!keys) return [];
        const SEC_LABELS = { server:'SERVER', auth:'AUTHENTICATION', home:'HOME LOCATION', threat:'THREAT INTEL',
            scanner:'SCANNER', mikrotik:'MIKROTIK ROUTER', pihole:'PIHOLE', honeypot:'HONEYPOT',
            security_center:'SECURITY CENTER', threat:'THREAT INTEL',
            sentinel:'SENTINEL LINK', proxy:'NGINX PROXY', collector:'COLLECTOR', integrations:'EXTERNAL LOOKUP', alerts:'ALERTING' };
        return [`<div class="cfg-field-group">
            <div class="cfg-field-group-title">${SEC_LABELS[sec]||sec.toUpperCase()}</div>
            ${Object.entries(keys).map(([k,v])=>_cfgField(sec,k,v)).join('')}
        </div>`];
    });
    return inner.join('');
}

async function openSettings() {
    const cfgBody   = $('cfg-body');
    const cfgResult = $('cfg-result');
    cfgBody.innerHTML = '<div style="padding:16px;color:#4d7479;">Loading…</div>';
    cfgResult.textContent = ''; cfgResult.className = 'cfg-result';
    _settingsModal.classList.remove('hidden');

    const [data, status] = await Promise.all([
        fetch('/api/config/full').then(r => r.json()).catch(() => null),
        fetch('/api/status').then(r => r.json()).catch(() => null),
    ]);
    if (!data) { cfgBody.innerHTML = `<div style="color:var(--red);padding:16px;">Failed to load config.</div>`; return; }

    // STATUS pane
    let statusPane = '<div style="color:#4d7479;font-size:11px;">No status data.</div>';
    if (status && !status.error) {
        const m = status.modules || {}, g = status.geoip || {}, db = status.database || {}, cf = status.config_file || {};
        statusPane = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 20px;margin-bottom:14px;">
                ${_statusDot(g.city_db==='ok',  'GeoIP City DB',         'GeoIP City DB MISSING')}
                ${_statusDot(g.asn_db==='ok',   'GeoIP ASN DB',          'GeoIP ASN DB MISSING')}
                ${_statusDot(m.scanner,          'Scanner ON',            'Scanner OFF')}
                ${_statusDot(m.security_center,  'Security Center ON',    'Security Center OFF')}
                ${_statusDot(m.sniproxy,         'Proxy Monitor ON',      'Proxy Monitor OFF')}
                ${_statusDot(m.sentinel,         'Sentinel link ON',      'Sentinel link OFF')}
                ${_statusDot(m.blocklist,        'Blocklist ON',          'Blocklist — not configured')}
                ${_statusDot(cf.exists,          'Config file OK',        'Config file MISSING')}
            </div>
            <div style="font-size:10px;color:#4d7479;display:flex;gap:14px;flex-wrap:wrap;border-top:1px solid #14333a;padding-top:10px;">
                <span>DB: <b style="color:var(--fg)">${db.size_kb} KB</b></span>
                <span>Attacks: <b style="color:var(--fg)">${db.attacks}</b></span>
                <span>Bans: <b style="color:var(--fg)">${db.bans}</b></span>
                <span>Devices: <b style="color:var(--fg)">${db.devices}</b></span>
                <span>ISP cache: <b style="color:var(--fg)">${g.isp_cache}</b></span>
                ${g.unknown_isp_records > 0 ? `<span style="color:#ffb347;">⚠ ${g.unknown_isp_records} missing ISP</span>` : ''}
            </div>`;
    }

    // Tab definitions — network tab hidden in work mode
    const isWork = _workMode;
    const tabs = [
        { id: 'status',      label: 'STATUS',      html: statusPane },
        { id: 'system',      label: 'SYSTEM',      html: _cfgThemeBlock() + _cfgSecurityBlock() + _cfgWatchlistBlock() + _cfgGroup('SYSTEM', ['server','auth','alerts','integrations'], data) },
        { id: 'network',     label: 'NETWORK',     html: _cfgGroup('NETWORK',     ['home','scanner','mikrotik','pihole','threat'], data), homeOnly: true },
        { id: 'security',    label: 'SECURITY',    html: _cfgGroup('SECURITY',    ['honeypot','security_center','threat'], data) },
        { id: 'connectivity',label: 'CONNECTIVITY',html: _cfgGroup('CONNECTIVITY',['sentinel','proxy','collector'], data) },
    ].filter(t => !t.homeOnly || !isWork);

    const tabBtns  = tabs.map((t,i) => `<button class="cfg-tab-btn${i===0?' active':''}" data-tab="${t.id}">${t.label}</button>`).join('');
    const tabPanes = tabs.map((t,i) => `<div class="cfg-tab-pane${i===0?' active':''}" id="cfg-pane-${t.id}">${t.html}</div>`).join('');

    cfgBody.innerHTML = `<div class="cfg-tabs">${tabBtns}</div>${tabPanes}`;

    cfgBody.querySelectorAll('.cfg-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            cfgBody.querySelectorAll('.cfg-tab-btn').forEach(b => b.classList.remove('active'));
            cfgBody.querySelectorAll('.cfg-tab-pane').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const pane = cfgBody.querySelector(`#cfg-pane-${btn.dataset.tab}`);
            if (pane) pane.classList.add('active');
        });
    });
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
        payload[s][k] = inp.dataset.bool ? String(inp.checked) : inp.value;
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
$('cfg-backup')?.addEventListener('click', () => {
    showResult(true, 'Připravuji zálohu DB…');
    window.location.href = '/api/backup';
});

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

    const lanPanel        = $('lan-panel');
    const logPanel        = $('log-panel');
    const usersPanel      = $('users-panel');
    const attackStatsPanel = $('attack-stats-panel');
    const SHOW = 'flex';

    if (!authenticated) {
        if (lanPanel)         lanPanel.style.display         = 'none';
        if (logPanel)         logPanel.style.display         = 'none';
        if (usersPanel)       usersPanel.style.display       = 'none';
        if (attackStatsPanel) attackStatsPanel.style.display = 'none';
    } else {
        if (attackStatsPanel) attackStatsPanel.style.display = SHOW;
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
    // Adjust grid layout for logged-out state (hides empty left column).
    // In work mode the 3-column work-layout is always active — don't override it.
    const gridEl = document.querySelector('.grid');
    if (gridEl && !_workMode) gridEl.classList.toggle('no-auth', !authenticated);
}

async function checkAuth() {
    const r = await fetch('/api/auth/status').then(x => x.json()).catch(() => ({ authenticated: false }));
    applyAuthState(r.authenticated);
    // Indikátor expirace session na LOGOUT tlačítku
    if (r.authenticated && r.expires_in > 0) {
        const d = Math.floor(r.expires_in / 86400), h = Math.floor((r.expires_in % 86400) / 3600);
        const btn = $('logout-btn');
        if (btn) btn.title = `Session vyprší za ${d}d ${h}h`;
    }
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
    const body = { username: $('login-user').value, password: $('login-pass').value };
    const totpEl = $('login-totp');
    if (totpEl && totpEl.value) body.totp = totpEl.value;
    const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(x => x.json()).catch(() => ({ ok: false, error: 'Network error' }));
    _loginSubmit.disabled = false;
    _loginSubmit.textContent = 'LOGIN';
    if (r.ok) {
        if (totpEl) totpEl.style.display = 'none';
        applyAuthState(true);
        applyTabVisibility(_lastCfg);
    } else if (r.totp_required) {
        // Zobraz pole pro 2FA kód
        if (totpEl) { totpEl.style.display = ''; totpEl.focus(); }
        _loginErr.textContent = r.error || 'Zadej 2FA kód z authenticatoru';
    } else {
        _loginErr.textContent = r.error || 'Invalid credentials';
    }
});
$('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') _loginSubmit.click(); });
$('login-totp')?.addEventListener('keydown', e => { if (e.key === 'Enter') _loginSubmit.click(); });

$('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    applyAuthState(false);
});

checkAuth().then(() => loadStatic().then(connectWS));

// ================================================================
// THEME + ACCENT COLOR
// ================================================================
const ACCENT_PALETTE = [
    { name: 'orange',  hex: '#f97316', rgb: '249,115,22',   hex2: '#fb923c' },
    { name: 'teal',    hex: '#00ffd5', rgb: '0,255,213',    hex2: '#18ffff' },
    { name: 'blue',    hex: '#38bdf8', rgb: '56,189,248',   hex2: '#7dd3fc' },
    { name: 'green',   hex: '#2dffa1', rgb: '45,255,161',   hex2: '#4fffb8' },
    { name: 'yellow',  hex: '#ffe83b', rgb: '255,232,59',   hex2: '#ffed70' },
    { name: 'purple',  hex: '#b878ff', rgb: '184,120,255',  hex2: '#cc99ff' },
    { name: 'pink',    hex: '#ec4899', rgb: '236,72,153',   hex2: '#f472b6' },
    { name: 'red',     hex: '#ff2a5e', rgb: '255,42,94',    hex2: '#ff5580' },
];

function applyAccent(name) {
    const c = ACCENT_PALETTE.find(p => p.name === name) || ACCENT_PALETTE[0];
    const r = document.documentElement;
    r.style.setProperty('--accent',     c.hex);
    r.style.setProperty('--accent-2',   c.hex2);
    r.style.setProperty('--accent-rgb', c.rgb);
    localStorage.setItem('sentinel-accent', name);
}

function applyTheme(theme) {
    document.body.classList.toggle('light-mode', theme === 'light');
    localStorage.setItem('sentinel-theme', theme);
}

// Sci-fi barevná schémata — override celé palety přes body class (viz style.css)
const SCHEMES = ['default', 'amber', 'matrix', 'red'];

function applyScheme(name) {
    if (!SCHEMES.includes(name)) name = 'default';
    document.body.classList.remove('scheme-amber', 'scheme-matrix', 'scheme-red');
    const r = document.documentElement;
    if (name === 'default') {
        if (!document.body.classList.contains('work-mode'))
            applyAccent(localStorage.getItem('sentinel-accent') || 'orange');
    } else {
        document.body.classList.add('scheme-' + name);
        // inline accent proměnné by přebily schéma — pryč s nimi
        ['--accent', '--accent-2', '--accent-rgb'].forEach(p => r.style.removeProperty(p));
    }
    localStorage.setItem('sentinel-scheme', name);
}

function loadThemePrefs() {
    const theme  = localStorage.getItem('sentinel-theme')  || 'dark';
    const accent = localStorage.getItem('sentinel-accent') || 'orange';
    applyTheme(theme);
    // Don't override work-mode accent; it's set by applyTabVisibility
    if (!document.body.classList.contains('work-mode')) applyAccent(accent);
    applyScheme(localStorage.getItem('sentinel-scheme') || 'default');
}

loadThemePrefs();

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

