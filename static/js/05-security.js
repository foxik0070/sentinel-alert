// 05-security.js — Security Center (FSC)
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
            datasets: [{ data: [], backgroundColor: ['#38bdf8','#f97316','#2dffa1','#ffe83b','#b878ff','#ff2a5e'], borderWidth: 0 }]
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

        // Gauge ringy — podíl vůči počtu monitorovaných hostů
        if (stats.total > 0) {
            setGauge('fsc-g-online', stats.online / stats.total, 'var(--green)');
            setGauge('fsc-g-sec',    stats.sec_alerts / stats.total, 'var(--red)');
            setGauge('fsc-g-fw',     stats.firewalls_active / stats.total, '#38bdf8');
        }

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

