// 06-proxy.js — Proxy Monitor (PSC)
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

    _pscCharts.extint = new Chart(document.getElementById('psc-ext-int-chart'), {
        type: 'bar',
        data: { labels: [], datasets: [
            { label: 'Internal', data: [], backgroundColor: 'rgba(77,116,121,0.85)', borderRadius: 2 },
            { label: 'External', data: [], backgroundColor: 'rgba(249,115,22,0.90)', borderRadius: 2 },
        ]},
        options: {
            maintainAspectRatio: false, animation: false,
            plugins: {
                legend: { labels: { color: '#4d7479', font: { size: 9 }, boxWidth: 10 } },
                datalabels: {
                    color: '#fff', font: { size: 8, weight: 'bold' },
                    display: ctx => ctx.dataset.data[ctx.dataIndex] > 0,
                    formatter: v => v > 0 ? v : ''
                }
            },
            scales: {
                x: { stacked: true, grid: { display: false },
                     ticks: { color: '#4d7479', font: { size: 9 }, maxRotation: 35, minRotation: 15 } },
                y: { stacked: true, grid: { color: '#0e2226' },
                     ticks: { color: '#4d7479', font: { size: 9 } } }
            }
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
        _pscCharts.speed.update('none');

        // Conn chart
        _pscCharts.conn.data.labels = h.labels;
        _pscCharts.conn.data.datasets[0].data = h.conn;
        _pscCharts.conn.update('none');

        // Domain chart — top 10 by bytes
        const domSorted = Object.entries(data.top_domains)
            .sort((a, b) => b[1] - a[1]).slice(0, 10);
        _pscCharts.domain.data.labels = domSorted.map(([d]) => d);
        _pscCharts.domain.data.datasets[0].data = domSorted.map(([, v]) => (v / 1024 / 1024).toFixed(2));
        _pscCharts.domain.update('none');

        // Ext/Int stacked bar — top 15 domains by total connections
        const domStatsSorted = Object.entries(data.domain_stats || {})
            .sort((a, b) => (b[1].ext + b[1].int) - (a[1].ext + a[1].int))
            .slice(0, 15);
        _pscCharts.extint.data.labels = domStatsSorted.map(([d]) => d.replace('.foxik-iot.cz', ''));
        _pscCharts.extint.data.datasets[0].data = domStatsSorted.map(([, v]) => v.int);
        _pscCharts.extint.data.datasets[1].data = domStatsSorted.map(([, v]) => v.ext);
        _pscCharts.extint.update('none');

        // IP doughnut — top 8 clients by total bytes
        const ipSorted = Object.entries(data.top_ips)
            .sort((a, b) => (b[1].tx + b[1].rx) - (a[1].tx + a[1].rx)).slice(0, 8);
        _pscCharts.ip.data.labels = ipSorted.map(([ip]) => ip);
        _pscCharts.ip.data.datasets[0].data = ipSorted.map(([, v]) => v.tx + v.rx);
        _pscCharts.ip.update('none');

        // Clients table
        document.getElementById('psc-clients').innerHTML = ipSorted.map(([ip, v]) => `
            <tr>
                <td style="color:var(--accent);font-weight:bold;">${escape(ip)}</td>
                <td style="text-align:right;color:#38bdf8">${(v.tx / 1024 / 1024).toFixed(2)}</td>
                <td style="text-align:right;color:var(--green)">${(v.rx / 1024 / 1024).toFixed(2)}</td>
                <td style="text-align:right;color:var(--fg);font-weight:bold">${((v.tx + v.rx) / 1024 / 1024).toFixed(2)}</td>
                <td style="text-align:right;color:var(--muted)">${v.hits}</td>
            </tr>`).join('');

        // Live feed table
        document.getElementById('psc-live').innerHTML = (data.recent_connections || []).map(c => `
            <tr>
                <td style="color:var(--muted)">${escape(c.time)}</td>
                <td style="color:var(--accent)">${escape(c.src_ip)}</td>
                <td style="color:var(--fg);font-weight:bold">${escape(c.domain)}</td>
                <td style="text-align:right;color:#38bdf8">${pscFmtBytes(c.tx)}</td>
                <td style="text-align:right;color:var(--green)">${pscFmtBytes(c.rx)}</td>
                <td style="text-align:right;color:var(--yellow)">${escape(String(c.duration))}</td>
            </tr>`).join('') || `<tr><td colspan="6" class="empty">No connections recorded yet.</td></tr>`;

        // Domain → backend flow (agregace z recent_connections)
        const flowEl = document.getElementById('psc-flow');
        if (flowEl) {
            const flow = {};
            (data.recent_connections || []).forEach(c => {
                const key = `${c.domain} → ${c.dest}`;
                flow[key] = (flow[key] || 0) + 1;
            });
            const sorted = Object.entries(flow).sort((a, b) => b[1] - a[1]).slice(0, 15);
            const max = sorted.length ? sorted[0][1] : 1;
            flowEl.innerHTML = sorted.map(([k, n]) => {
                const [dom, backend] = k.split(' → ');
                const pct = Math.round(n / max * 100);
                return `<div style="display:flex;align-items:center;gap:8px;font-size:11px;">
                    <span style="flex:1;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escape(dom)}</span>
                    <span style="color:var(--muted);">→</span>
                    <span style="width:150px;color:#38bdf8;font-family:monospace;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escape(backend)}</span>
                    <div style="width:90px;height:8px;background:var(--bg-1);border:1px solid var(--border);flex-shrink:0;">
                        <div style="height:100%;width:${pct}%;background:var(--accent);opacity:0.8;"></div></div>
                    <span style="width:36px;text-align:right;color:var(--accent);font-weight:700;">${n}</span>
                </div>`;
            }).join('') || '<div class="empty">Žádná data.</div>';
        }

    } catch (e) {
        console.error('PSC update failed:', e);
    }
}

