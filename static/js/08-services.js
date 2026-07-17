// 08-services.js — Services tab
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
        await svcCheckOne(j.id);
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

// Single table row
function _svcRow(svc) {
    const lr  = svc.last_result;
    const ldb = svc.last_check_db;
    const up  = lr ? lr.up : (ldb ? ldb.status === 'up' : null);
    const cls = up === true ? 'up' : up === false ? 'down' : '';
    const dot = up === true ? '<span class="svc-status-dot up">● UP</span>'
              : up === false ? '<span class="svc-status-dot down">✖ DOWN</span>'
              : '<span class="svc-status-dot pending">—</span>';

    const rms    = lr?.response_ms ?? ldb?.response_ms;
    const rmsStr = rms != null ? (rms >= 1000 ? `${(rms/1000).toFixed(1)}s` : `${rms}ms`) : '—';
    const rmsCol = rms == null ? '#4d7479' : rms < 300 ? '#22c55e' : rms < 800 ? '#ffe83b' : '#ef4444';
    const u24    = svc.uptime_24h != null ? `${svc.uptime_24h}%` : '—';
    const u30    = svc.uptime_30d != null ? `${svc.uptime_30d}%` : '—';
    const u24col = svc.uptime_24h == null ? '#4d7479' : svc.uptime_24h >= 99 ? '#22c55e' : svc.uptime_24h >= 95 ? '#ffe83b' : '#ef4444';
    const u30col = svc.uptime_30d == null ? '#4d7479' : svc.uptime_30d >= 99 ? '#22c55e' : svc.uptime_30d >= 95 ? '#ffe83b' : '#ef4444';

    // SSL cell
    const isHttps = (svc.target || '').startsWith('https://') || svc.type === 'https';
    let sslTd = '<td style="color:#4d7479;">—</td>';
    if (isHttps) {
        const s = lr?.ssl;
        if (!s) sslTd = '<td style="color:#4d7479;font-size:10px;">pending</td>';
        else if (!s.valid) sslTd = '<td style="color:#ef4444;font-weight:700;">✗ invalid</td>';
        else {
            const col = s.days_left < 14 ? '#ef4444' : s.days_left < 30 ? '#fb923c' : '#22c55e';
            sslTd = `<td style="color:${col};" title="${s.issuer_org||s.issuer_cn||''} · ${s.not_after}">🔒 ${s.days_left}d</td>`;
        }
    }

    // Target / name cell
    const isHttp = svc.type === 'http' || svc.type === 'https';
    const tgtStr = isHttp
        ? `<a href="${_esc(svc.target)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="svc-row-target-link">${_esc(svc.target)}</a>`
        : `<span class="svc-row-target-text">${_esc(svc.host || svc.dns_query || (svc.type === 'heartbeat' ? `POST /api/heartbeat/${svc.id}` : ''))}</span>`;

    const server = lr?.server || '';
    const xpb    = lr?.x_powered_by || '';
    const soft   = [server, xpb].filter(Boolean).join(' · ');

    const codeHint = lr?.status_code ? `<span style="color:#4d7479;font-size:9px;margin-left:6px;">HTTP ${lr.status_code}</span>` : '';

    return `<tr class="svc-row ${cls}" onclick="svcShowDetail('${svc.id}')">
        <td class="svc-row-status">${dot}</td>
        <td>${_svcTypeBadge(svc.type)}${codeHint}</td>
        <td>
            <div class="svc-row-name" title="${_esc(svc.name)}">${_esc(svc.name)}</div>
            <div class="svc-row-sub">${tgtStr}${soft ? `<span class="svc-row-soft"> · ${_esc(soft)}</span>` : ''}</div>
        </td>
        <td><span style="color:${rmsCol};font-weight:700;">${rmsStr}</span></td>
        <td><span style="color:${u24col};">${u24}</span></td>
        <td><span style="color:${u30col};">${u30}</span></td>
        ${sslTd}
        <td style="color:#4d7479;">${_svcLastChecked(svc)}</td>
        <td class="svc-row-spark">${_svcDots(svc.spark)}</td>
        <td class="svc-row-actions" onclick="event.stopPropagation()">
            ${_svcSecBadge(lr?.security)}
            <button class="btn" onclick="svcCheckOne('${svc.id}')" style="font-size:9px;padding:2px 5px;" title="Check now">⟳</button>
            <button class="btn" onclick="svcDelete('${svc.id}')" style="font-size:9px;padding:2px 5px;color:#ef4444;border-color:#ef4444;" title="Remove">✕</button>
        </td>
    </tr>`;
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

    // Table
    const grid = $('svc-card-grid');
    if (!_svcData.length) {
        grid.innerHTML = '<div style="color:#4d7479;padding:30px;text-align:center;">No services configured. Click + ADD SERVICE to start monitoring.</div>';
        return;
    }
    grid.innerHTML = `<div class="fsc-table-wrap"><table class="fsc-table svc-table">
        <thead><tr>
            <th style="width:70px;">STATUS</th>
            <th style="width:90px;">TYPE</th>
            <th>SERVICE / TARGET</th>
            <th style="width:70px;">RESP</th>
            <th style="width:60px;">24H</th>
            <th style="width:60px;">30D</th>
            <th style="width:80px;">SSL</th>
            <th style="width:90px;">LAST CHECK</th>
            <th style="width:130px;">HISTORY</th>
            <th style="width:140px;text-align:right;padding-right:10px;">ACTIONS</th>
        </tr></thead>
        <tbody>${_svcData.map(_svcRow).join('')}</tbody>
    </table></div>`;
}

