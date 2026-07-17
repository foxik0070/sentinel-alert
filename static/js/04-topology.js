// 04-topology.js — topology modál + přepínání tabů
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
const TAB_IDS = { threat: 'tab-threat', security: 'tab-security', proxy: 'tab-proxy', network: 'tab-network', services: 'tab-services', pihole: 'tab-pihole' };
let _activeTab = 'threat';

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab === _activeTab) return;
        // Pause globe WebGL loop when leaving threat tab, resume on return
        if (_activeTab === 'threat') {
            globe.pauseAnimation();
            _globePaused = true;
        } else if (tab === 'threat') {
            globe.resumeAnimation();
            _globePaused = false;
            _globeFlush();
        }
        _activeTab = tab;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        Object.entries(TAB_IDS).forEach(([k, id]) => {
            document.getElementById(id).classList.toggle('hidden', k !== tab);
        });
        if (tab === 'security') { fscInit(); fscUpdate(); fscLoadHosts(); }
        if (tab === 'proxy')    { pscInit(); pscUpdate(); }
        if (tab === 'threat')   { attackStatsUpdate(); }
        if (tab === 'network')  { netInit(); mtUpdate(); }
        if (tab === 'services') { svcInit(); }
        if (tab === 'pihole')   { phInit(); phUpdate(); }
        UIState.set('tab', tab);
    });
});

// Restore last active tab — až po načtení všech tab skriptů (klik volá jejich init funkce)
document.addEventListener('DOMContentLoaded', () => {
    const saved = UIState.get('tab', 'threat');
    if (saved && saved !== 'threat') {
        const btn = document.querySelector(`.tab-btn[data-tab="${saved}"]`);
        // hidden tab (work mode / not authenticated) → stay on threat
        if (btn && btn.offsetParent !== null) btn.click();
    }
});

