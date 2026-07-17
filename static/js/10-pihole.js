// 10-pihole.js — PiHole tab
// ================================================================
// PIHOLE
// ================================================================
let _phCharts = {};
let _phInitDone = false;
let _phInterval = null;

function phInit() {
    if (_phInitDone) return;
    _phInitDone = true;

    _phCharts.overtime = new Chart($('ph-overtime-chart'), {
        type: 'line',
        data: { labels: [], datasets: [
            { label: 'Total',   data: [], borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.08)', fill: true, tension: 0.3, pointRadius: 0 },
            { label: 'Blocked', data: [], borderColor: '#ff2a5e', backgroundColor: 'rgba(255,42,94,0.08)',  fill: true, tension: 0.3, pointRadius: 0 },
        ]},
        options: {
            maintainAspectRatio: false, animation: false,
            plugins: { legend: { labels: { color: '#4d7479', font: { size: 9 }, boxWidth: 10 } }, datalabels: { display: false } },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#4d7479', font: { size: 9 }, maxTicksLimit: 12 } },
                y: { min: 0, grid: { color: 'var(--grid-line)' }, ticks: { color: '#4d7479', font: { size: 9 } } }
            }
        }
    });

    _phCharts.breakdown = new Chart($('ph-breakdown-chart'), {
        type: 'doughnut',
        data: { labels: ['Allowed', 'Blocked', 'Cached'], datasets: [{ data: [], backgroundColor: ['#38bdf8','#ff2a5e','#ffe83b'], borderWidth: 0 }] },
        options: {
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: '#4d7479', font: { size: 9 }, boxWidth: 10 } },
                datalabels: { color: '#fff', font: { weight: 'bold', size: 9 },
                    formatter: (v, ctx) => { const s = ctx.dataset.data.reduce((a,b)=>a+b,0); const p=v*100/s; return p>5?Math.round(p)+'%':''; } }
            },
            cutout: '65%'
        }
    });

    _phInterval = setInterval(phUpdate, 30000);
}

async function phUpdate() {
    try {
        const data = await fetch('/api/pihole/data').then(r => r.json());
        const instances = Object.values(data.instances || {});

        $('ph-instance-count').textContent = instances.length;

        // Aggregate from primary (or first connected)
        const primary = instances.find(i => i.primary && i.connected) || instances.find(i => i.connected);
        if (primary?.stats) {
            const s = primary.stats;
            $('ph-queries').textContent  = s.queries_today?.toLocaleString() || '0';
            $('ph-blocked').textContent  = s.blocked_today?.toLocaleString() || '0';
            $('ph-pct').textContent      = s.percent_blocked + '%';
            setGauge('ph-g-pct', (s.percent_blocked || 0) / 100, 'var(--yellow)');
            $('ph-domains').textContent  = s.domains_blocked?.toLocaleString() || '0';
            $('ph-error-cell').style.display = 'none';
        }

        // Instance cards
        $('ph-instances').innerHTML = instances.map(inst => {
            const s = inst.stats || {};
            const color = inst.connected ? 'var(--green)' : 'var(--red)';
            const badge = inst.primary ? ' <span style="font-size:8px;color:var(--accent);border:1px solid var(--accent);padding:0 4px;">PRIMARY</span>' : '';
            return `<div class="panel" style="flex:1;min-width:200px;padding:10px 14px;">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                    <span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;"></span>
                    <span style="font-size:10px;font-weight:700;color:var(--fg);">${inst.host}</span>${badge}
                    ${inst.version ? `<span style="font-size:9px;color:var(--muted);margin-left:auto;">${inst.version}</span>` : ''}
                </div>
                ${inst.connected ? `
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:10px;">
                    <span style="color:var(--muted);">Queries</span><span style="color:var(--fg);text-align:right;">${(s.queries_today||0).toLocaleString()}</span>
                    <span style="color:var(--muted);">Blocked</span><span style="color:var(--red);text-align:right;">${(s.blocked_today||0).toLocaleString()} (${s.percent_blocked||0}%)</span>
                    <span style="color:var(--muted);">Clients</span><span style="color:var(--fg);text-align:right;">${s.unique_clients||0}</span>
                    <span style="color:var(--muted);">Status</span><span style="color:${s.status==='enabled'?'var(--green)':'var(--red)'};text-align:right;">${s.status||'?'}</span>
                </div>` : `<div style="color:var(--red);font-size:10px;">${inst.last_error||'Disconnected'}</div>`}
            </div>`;
        }).join('');

        // Overtime chart (from primary)
        if (primary?.overtime?.length) {
            const ot = primary.overtime;
            _phCharts.overtime.data.labels = ot.map(e => {
                const d = new Date(e.ts * 1000);
                return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
            });
            _phCharts.overtime.data.datasets[0].data = ot.map(e => e.total);
            _phCharts.overtime.data.datasets[1].data = ot.map(e => e.blocked);
            _phCharts.overtime.update('none');
        }

        // Breakdown doughnut
        if (primary?.stats) {
            const s = primary.stats;
            const allowed = (s.queries_today || 0) - (s.blocked_today || 0) - (s.queries_cached || 0);
            _phCharts.breakdown.data.datasets[0].data = [Math.max(0,allowed), s.blocked_today||0, s.queries_cached||0];
            _phCharts.breakdown.update('none');
        }

        // Top domains
        const tops  = primary?.top_domains  || [];
        const topbl = primary?.top_blocked  || [];
        $('ph-top-domains').innerHTML = tops.map(d =>
            `<tr><td style="color:var(--fg);">${escape(d.domain||d.name||d)}</td>
             <td style="text-align:right;color:#38bdf8;font-weight:bold;">${(d.count||d.hits||0).toLocaleString()}</td></tr>`
        ).join('') || '<tr><td colspan="2" class="empty">No data.</td></tr>';
        $('ph-top-blocked').innerHTML = topbl.map(d =>
            `<tr><td style="color:var(--fg);">${escape(d.domain||d.name||d)}</td>
             <td style="text-align:right;color:var(--red);font-weight:bold;">${(d.count||d.hits||0).toLocaleString()}</td></tr>`
        ).join('') || '<tr><td colspan="2" class="empty">No data.</td></tr>';

    } catch(e) { console.error('phUpdate failed:', e); }
}
