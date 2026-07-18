// 09-mikrotik.js — MikroTik tab
// ================================================================
// MIKROTIK
// ================================================================
let _mtInterval = null;
let _mtActiveList = null;
let _mtData = null;

let _geoLoaded = false;

async function mtUpdate() {
    const section = $('mikrotik-section');
    if (!section || section.classList.contains('hidden')) return;
    if (!_geoLoaded) { _geoLoaded = true; geoLoadCountries(); }
    try {
        const data = await fetch('/api/mikrotik/data').then(r => r.json());
        _mtData = data;

        $('mt-host').textContent = data.server || 'not configured';
        const statusEl = $('mt-status');
        if (data.connected) {
            statusEl.textContent = 'CONNECTED'; statusEl.style.color = 'var(--green)';
        } else {
            statusEl.textContent = data.last_error ? 'ERROR' : 'CONNECTING...';
            statusEl.style.color = 'var(--red)';
        }
        const errCell = $('mt-error-cell');
        if (data.last_error) {
            $('mt-error-msg').textContent = data.last_error;
            errCell.style.display = '';
        } else {
            errCell.style.display = 'none';
        }

        const s = data.summary || {};
        $('mt-blocked-count').textContent  = s['blocked_ips'] || 0;
        $('mt-portscan-count').textContent = s['Port_Scanner'] || 0;
        $('mt-syn-count').textContent      = s['Syn_Flooder'] || 0;

        // Summary cards
        const sumEl = $('mt-summary');
        const listColors = { 'blocked_ips': 'var(--red)', 'Port_Scanner': 'var(--yellow)',
                             'Syn_Flooder': 'var(--purple)', 'spammers': 'var(--accent)' };
        sumEl.innerHTML = Object.entries(s)
            .sort((a, b) => b[1] - a[1])
            .map(([name, cnt]) => `
            <div class="mt-sum-card">
                <span class="lbl">${escape(name.replace('_',' '))}</span>
                <span class="val" style="color:${listColors[name]||'var(--fg)'}">${cnt}</span>
            </div>`).join('');

        // List tabs
        const lists = [...new Set((data.lists || []).map(e => e.list))];
        if (!_mtActiveList || !lists.includes(_mtActiveList)) _mtActiveList = lists[0] || null;
        $('mt-list-tabs').innerHTML = lists.map(l => `
            <button class="mt-list-tab${l === _mtActiveList ? ' active' : ''}"
                    onclick="mtSetList('${escape(l)}')">${escape(l.replace('_',' '))}</button>`).join('');

        mtRenderTable(data.lists || []);
        if (_mtMainTab === 'filter') mtRenderFilter(data.filter_rules || []);
        if (_mtMainTab === 'nat')    mtRenderNat(data.nat_rules || []);

        if (!_mtInterval) _mtInterval = setInterval(mtUpdate, 15000);
    } catch (e) {
        console.error('mtUpdate failed:', e);
    }
}

function mtSetList(list) {
    _mtActiveList = list;
    if (_mtData) mtRenderTable(_mtData.lists || []);
    document.querySelectorAll('.mt-list-tab').forEach(b => {
        b.classList.toggle('active', b.textContent.trim() === list.replace('_', ' '));
    });
}

function mtRenderTable(entries) {
    const filtered = _mtActiveList ? entries.filter(e => e.list === _mtActiveList) : entries;
    $('mt-list-tbody').innerHTML = filtered.map(e => `
        <tr>
            <td style="color:var(--accent);font-weight:bold;">${escape(e.address)}</td>
            <td style="color:var(--muted);">${escape(e.list)}</td>
            <td style="color:var(--muted);font-size:10px;">${escape(e.creation_time)}</td>
            <td style="color:${e.timeout ? 'var(--yellow)' : 'var(--muted)'};">${escape(e.timeout || '∞')}</td>
            <td style="color:var(--muted);font-size:10px;">${escape(e.comment || '')}</td>
            <td style="text-align:right;">
                ${e.list === 'blocked_ips' && !e.dynamic
                    ? `<button class="btn ghost" style="font-size:9px;padding:2px 6px;"
                               onclick="mtUnblockIP('${escape(e.address)}')">UNBLOCK</button>`
                    : `<button class="btn ghost" style="font-size:9px;padding:2px 6px;"
                               onclick="mtBlockFromList('${escape(e.address)}')">+ BLOCK</button>`}
            </td>
        </tr>`).join('') || `<tr><td colspan="6" class="empty">No entries.</td></tr>`;
}

async function mtBlockIP() {
    const ip      = ($('mt-block-ip').value || '').trim();
    const timeout = $('mt-block-timeout').value;
    const res     = $('mt-block-result');
    if (!ip) { res.textContent = 'Enter an IP address.'; res.style.color = 'var(--red)'; return; }
    res.textContent = 'Blocking...'; res.style.color = 'var(--muted)';
    try {
        const r = await fetch('/api/mikrotik/block', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ ip, comment: 'sentinel-manual', timeout: timeout || '' })
        }).then(r => r.json());
        if (r.ok) {
            res.textContent = `✓ ${ip} blocked`; res.style.color = 'var(--green)';
            $('mt-block-ip').value = '';
            setTimeout(mtUpdate, 1500);
        } else {
            res.textContent = `✗ ${r.error}`; res.style.color = 'var(--red)';
        }
    } catch (e) { res.textContent = `✗ ${e}`; res.style.color = 'var(--red)'; }
}

async function mtBlockFromList(ip) {
    const timeout = '1w';
    try {
        const r = await fetch('/api/mikrotik/block', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ ip, comment: 'sentinel-from-list', timeout })
        }).then(r => r.json());
        if (r.ok) { setTimeout(mtUpdate, 1500); }
    } catch {}
}

async function mtUnblockIP(ip) {
    try {
        const r = await fetch('/api/mikrotik/unblock', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ ip })
        }).then(r => r.json());
        if (r.ok) { setTimeout(mtUpdate, 1500); }
    } catch {}
}

// MikroTik main tab switching (LISTS | FILTER | NAT)
let _mtMainTab = 'lists';

function mtSetMainTab(tab) {
    _mtMainTab = tab;
    ['lists','filter','nat'].forEach(t => {
        const pane = $('mt-pane-' + t);
        const btn  = $('mt-tab-' + t);
        if (pane) pane.style.display = t === tab ? '' : 'none';
        if (btn)  btn.classList.toggle('active', t === tab);
    });
    if (_mtData) {
        if (tab === 'filter') mtRenderFilter(_mtData.filter_rules || []);
        if (tab === 'nat')    mtRenderNat(_mtData.nat_rules || []);
    }
}

function _mtRuleMatch(r) {
    const parts = [];
    if (r.protocol)        parts.push(`proto:${r.protocol}`);
    if (r.src_address)     parts.push(`src:${r.src_address}`);
    if (r.dst_address)     parts.push(`dst:${r.dst_address}`);
    if (r.dst_port)        parts.push(`:${r.dst_port}`);
    if (r.src_port)        parts.push(`src-port:${r.src_port}`);
    if (r.in_interface)    parts.push(`in:${r.in_interface}`);
    if (r.out_interface)   parts.push(`out:${r.out_interface}`);
    if (r.src_address_list) parts.push(`src-list:${r.src_address_list}`);
    if (r.dst_address_list) parts.push(`dst-list:${r.dst_address_list}`);
    if (r.address_list)    parts.push(`list:${r.address_list}`);
    if (r.connection_state) parts.push(`state:${r.connection_state}`);
    return parts.join(' · ') || '—';
}

function _mtRuleTarget(r) {
    const parts = [];
    if (r.to_addresses) parts.push(r.to_addresses);
    if (r.to_ports)     parts.push(`:${r.to_ports}`);
    return parts.join(' ') || '—';
}

function _mtToggleBtn(type, r) {
    if (r.dynamic) return '<span style="font-size:9px;color:#4d7479;">DYNAMIC</span>';
    const enabled = !r.disabled;
    const color = enabled ? 'var(--green)' : 'var(--muted)';
    const label = enabled ? 'ON' : 'OFF';
    return `<button class="btn ghost" style="font-size:9px;padding:2px 8px;color:${color};border-color:${color};"
                    onclick="mtToggleRule('${type}',${r.index},${!enabled})">${label}</button>`;
}

function mtRenderFilter(rules) {
    const ACTION_COLOR = { accept:'var(--green)', drop:'var(--red)', reject:'var(--red)',
        'add-src-to-address-list':'var(--yellow)', jump:'var(--accent)',
        passthrough:'var(--muted)', fasttrack_connection:'#38bdf8' };
    $('mt-filter-tbody').innerHTML = rules.map(r => {
        const ac = ACTION_COLOR[r.action] || 'var(--fg)';
        const rowStyle = r.disabled ? 'opacity:0.4;' : '';
        return `<tr style="${rowStyle}">
            <td style="color:var(--muted);">${r.index}</td>
            <td style="color:#38bdf8;">${r.chain || '—'}</td>
            <td style="color:${ac};font-weight:bold;">${(r.action||'').replace(/_/g,'-')}</td>
            <td style="font-size:10px;color:var(--muted);">${escape(_mtRuleMatch(r))}</td>
            <td style="font-size:10px;color:#4d7479;font-style:italic;">${escape(r.comment||'')}</td>
            <td style="text-align:right;">${_mtToggleBtn('filter', r)}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">No rules.</td></tr>';
}

function mtRenderNat(rules) {
    const ACTION_COLOR = { 'dst-nat':'var(--accent)', masquerade:'var(--yellow)',
        'src-nat':'#38bdf8', redirect:'var(--purple)' };
    $('mt-nat-tbody').innerHTML = rules.map(r => {
        const ac = ACTION_COLOR[r.action] || 'var(--fg)';
        const rowStyle = r.disabled ? 'opacity:0.4;' : '';
        return `<tr style="${rowStyle}">
            <td style="color:var(--muted);">${r.index}</td>
            <td style="color:#38bdf8;">${r.chain || '—'}</td>
            <td style="color:${ac};font-weight:bold;">${r.action || '—'}</td>
            <td style="font-size:10px;color:var(--muted);">${escape(_mtRuleMatch(r))}</td>
            <td style="font-size:10px;color:var(--accent);">${escape(_mtRuleTarget(r))}</td>
            <td style="font-size:10px;color:#4d7479;font-style:italic;">${escape(r.comment||'')}</td>
            <td style="text-align:right;">${_mtToggleBtn('nat', r)}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">No rules.</td></tr>';
}

async function mtToggleRule(type, index, enable) {
    try {
        const r = await fetch('/api/mikrotik/rule/toggle', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ type, index, enable })
        }).then(r => r.json());
        if (r.ok) {
            setTimeout(() => {
                mtUpdate().then(() => {
                    if (_mtMainTab === 'filter') mtRenderFilter(_mtData?.filter_rules || []);
                    if (_mtMainTab === 'nat')    mtRenderNat(_mtData?.nat_rules || []);
                });
            }, 1500);
        }
    } catch {}
}


// ================================================================
// GEOIP BLOCK — blokace útočníků z vybraných zemí
// ================================================================
const _geoSelected = new Set();

async function geoLoadCountries() {
    const box = document.getElementById('geo-country-list');
    if (!box) return;
    let d;
    try { d = await fetch('/api/geoblock/preview?days=7').then(r => r.json()); }
    catch { return; }
    box.innerHTML = (d.top || []).map(c => {
        const on = _geoSelected.has(c.country);
        return `<button class="geo-chip${on ? ' on' : ''}" data-c="${escape(c.country)}"
            title="${c.n} útoků / ${c.ips} IP">${escape(c.country)} <span style="opacity:.6">${c.ips}</span></button>`;
    }).join('') || '<span style="font-size:10px;color:var(--muted);">Žádná data.</span>';
    box.querySelectorAll('.geo-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            const c = btn.dataset.c;
            if (_geoSelected.has(c)) { _geoSelected.delete(c); btn.classList.remove('on'); }
            else { _geoSelected.add(c); btn.classList.add('on'); }
            geoPreview();
        });
    });
    geoPreview();
}

async function geoPreview() {
    const el = document.getElementById('geo-preview');
    if (!el) return;
    if (!_geoSelected.size) { el.textContent = 'Vyber země…'; return; }
    const q = encodeURIComponent([..._geoSelected].join(','));
    try {
        const d = await fetch(`/api/geoblock/preview?countries=${q}&days=7`).then(r => r.json());
        el.textContent = `${d.ips} IP · ${d.attacks} útoků za 7 dní`;
    } catch {}
}

async function geoApply() {
    if (!_geoSelected.size) return;
    const countries = [..._geoSelected];
    if (!confirm(`Zablokovat útočící IP ze zemí ${countries.join(', ')} na MikroTiku?`)) return;
    const btn = document.getElementById('geo-apply-btn');
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    const r = await fetch('/api/geoblock/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countries, days: 7, limit: 200 }),
    }).then(x => x.json()).catch(() => ({ ok: false, error: 'request failed' }));
    if (btn) { btn.disabled = false; btn.textContent = '⊘ BLOCK COUNTRIES'; }
    showToast({
        title: r.ok ? 'GEOIP BLOCK' : 'GEOIP BLOCK FAILED',
        body: r.ok ? `${r.blocked} IP zablokováno (${countries.join(', ')})` : (r.error || '?'),
        color: r.ok ? 'var(--green)' : 'var(--red)',
    });
    if (r.ok) { _geoSelected.clear(); geoLoadCountries(); mtUpdate(); }
}
