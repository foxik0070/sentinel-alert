// 07-netmap.js — Network map (D3), DB viewer, device search
// ================================================================
// NETWORK MAP (D3 force-directed topology)
// ================================================================
let _netInitDone = false;
let _netData = { nodes: [], links: [] };
let _netDevices = new Map();   // mac -> device (from /api/devices)
let _netSettings = {};         // mac -> {connect, disconnect}
let _netEdit = false;
let _netLinkArm = null;        // null | 'armed' | source-node-id
let _netSelected = null;       // selected node id
let _netSim = null;
let _netSvg = null, _netG = null;

const NODE_TYPES = {
    host:    { shape: 'circle',  r: 10,       color: '#2dffa1', stroke: '#00ffd5' },
    switch:  { shape: 'rect',    w: 28, h: 16, color: '#38bdf8', stroke: '#00b8ff' },
    router:  { shape: 'rect',    w: 28, h: 16, color: '#38bdf8', stroke: '#00b8ff' },
    ap:      { shape: 'rect',    w: 28, h: 16, color: '#38bdf8', stroke: '#00b8ff' },
    cloud:   { shape: 'cloud',   w: 52, h: 30, color: '#0d2035', stroke: '#38bdf8' },
    lxc:     { shape: 'circle',  r: 10,       color: '#b878ff', stroke: '#9b5de5' },
    qemu:    { shape: 'circle',  r: 10,       color: '#3b82f6', stroke: '#60a5fa' },
    nas:     { shape: 'circle',  r: 10,       color: '#ffe83b', stroke: '#fbbf24' },
    mobile:  { shape: 'circle',  r: 10,       color: '#86efac', stroke: '#4ade80' },
    tv:      { shape: 'rect',    w: 28, h: 16, color: '#fb923c', stroke: '#f97316' },
    printer: { shape: 'circle',  r: 10,       color: '#f97316', stroke: '#ea580c' },
    server:  { shape: 'circle',  r: 10,       color: '#22c55e', stroke: '#16a34a' },
    rpi:     { shape: 'circle',  r: 10,       color: '#ef4444', stroke: '#dc2626' },
    other:   { shape: 'circle',  r: 10,       color: '#ea580c', stroke: '#c2410c' },
    iot:     { shape: 'circle',  r: 10,       color: '#06b6d4', stroke: '#0891b2' },
    pc:      { shape: 'circle',  r: 10,       color: '#94a3b8', stroke: '#64748b' },
    network: { shape: 'rect',    w: 28, h: 16, color: '#166534', stroke: '#15803d' },
};

const _NET_RECT_TYPES = new Set(['switch', 'router', 'ap', 'network', 'tv']);

function netNodeColor(n) {
    if (n.type === 'cloud') return NODE_TYPES.cloud.color;
    const dev = _netDevices.get(n.mac);
    const offline = dev && !dev.is_online;
    const devCfg = (_netSettings.devices || {})[n.mac] || {};
    if (_NET_RECT_TYPES.has(n.type)) {
        if (offline) return '#0d1e26';
        return devCfg.is_isp ? '#ffe83b' : (NODE_TYPES[n.type] || NODE_TYPES.host).color;
    }
    // Circle fill = online → green, offline → grey
    return offline ? '#374151' : '#22c55e';
}

function netNodeStroke(n) {
    if (n.type === 'cloud') return NODE_TYPES.cloud.stroke;
    const devCfg = (_netSettings.devices || {})[n.mac] || {};
    if (_NET_RECT_TYPES.has(n.type)) {
        const dev = _netDevices.get(n.mac);
        if (dev && !dev.is_online) return '#1a3040';
        return devCfg.is_isp ? '#f59e0b' : (NODE_TYPES[n.type] || NODE_TYPES.host).stroke;
    }
    // Circle stroke = type color always
    return (NODE_TYPES[n.type] || NODE_TYPES.host).stroke;
}

function _netSyncNodeTypes() {
    if (!_netData) return;
    const devSettings = _netSettings.devices || {};
    _netData.nodes.forEach(n => {
        if (!n.mac) return;
        const cfg = devSettings[n.mac];
        if (cfg?.type) n.type = cfg.type;
    });
}

function _netSyncIspCloud() {
    if (!_netData) return;
    const devSettings = _netSettings.devices || {};
    const ispMac = Object.entries(devSettings).find(([, c]) => c.is_isp)?.[0];

    if (ispMac) {
        const ispNodeId = `h-${ispMac}`;
        if (!_netData.nodes.some(n => n.id === 'isp-cloud')) {
            const rn = _netData.nodes.find(n => n.id === ispNodeId);
            _netData.nodes.push({
                id: 'isp-cloud', type: 'cloud', label: 'ISP', hostname: 'ISP',
                ip: '', mac: '',
                x: (rn?.x || 400) - 180, y: (rn?.y || 300) - 120,
            });
        }
        // Remove stale isp-cloud links (wrong target) and ensure correct one exists
        _netData.links = _netData.links.filter(l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            if (s === 'isp-cloud' || t === 'isp-cloud') {
                return (s === 'isp-cloud' && t === ispNodeId) || (s === ispNodeId && t === 'isp-cloud');
            }
            return true;
        });
        const hasLink = _netData.links.some(l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            return (s === 'isp-cloud' && t === ispNodeId) || (s === ispNodeId && t === 'isp-cloud');
        });
        if (!hasLink) _netData.links.push({ source: 'isp-cloud', target: ispNodeId });
    } else {
        _netData.nodes = _netData.nodes.filter(n => n.id !== 'isp-cloud');
        _netData.links = _netData.links.filter(l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            return s !== 'isp-cloud' && t !== 'isp-cloud';
        });
    }
    if (_netSim) {
        _netSim.nodes(_netData.nodes);
        _netSim.force('link').links(_netData.links);
        _netSim.alpha(0.3).restart();
    }
}

function _topoForSave() {
    return {
        nodes: _netData.nodes,
        links: _netData.links.map(l => {
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            return { ...l, source: s, target: t };
        }),
    };
}

async function netInit() {
    if (_netInitDone) { netRender(); return; }
    _netInitDone = true;

    const svg = d3.select('#net-svg');
    _netSvg = svg;
    const w = document.getElementById('net-svg').clientWidth  || 800;
    const h = document.getElementById('net-svg').clientHeight || 500;

    const defs = svg.append('defs');
    defs.append('marker')
        .attr('id', 'arrowhead')
        .attr('viewBox', '-0 -5 10 10').attr('refX', 18).attr('refY', 0)
        .attr('orient', 'auto').attr('markerWidth', 6).attr('markerHeight', 6)
        .append('path').attr('d', 'M 0,-5 L 10,0 L 0,5').attr('fill', '#14333a');
    const glowFilter = defs.append('filter').attr('id', 'isp-glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    glowFilter.append('feGaussianBlur').attr('stdDeviation', '4').attr('result', 'blur');
    const feMerge = glowFilter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'blur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    _netG = svg.append('g');

    // Zoom + pan
    svg.call(d3.zoom().scaleExtent([0.2, 4]).on('zoom', e => _netG.attr('transform', e.transform)));

    // Load data
    [_netData, _netSettings] = await Promise.all([
        fetch('/api/topo-data').then(r => r.ok ? r.json() : { nodes: [], links: [] }),
        fetch('/api/network/settings').then(r => r.json()),
    ]);
    // Normalize link source/target from saved objects back to string IDs for D3
    _netData.links = _netData.links.map(l => {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const t = typeof l.target === 'object' ? l.target.id : l.target;
        return { ...l, source: s, target: t };
    });
    // Clear saved pins so force simulation can freely organize the layout
    _netData.nodes.forEach(n => { delete n.fx; delete n.fy; });
    // Normalize old double-prefix vsw node IDs: vsw-vsw-X → vsw-X (canonical = sw.id)
    let topoChanged = false;
    _netData.nodes.forEach(n => {
        if (!n.id.startsWith('vsw-vsw-')) return;
        const newId = n.id.slice('vsw-'.length);
        _netData.links.forEach(l => {
            if (l.source === n.id) l.source = newId;
            if (l.target === n.id) l.target = newId;
        });
        n.id = newId;
        topoChanged = true;
    });
    // Deduplicate nodes by id (keep last occurrence to prefer freshest data)
    const _seenIds = new Map();
    _netData.nodes.forEach(n => _seenIds.set(n.id, n));
    _netData.nodes = [..._seenIds.values()];

    const devList = await fetch('/api/devices').then(r => r.json()).catch(() => []);
    _netDevices = new Map(devList.map(d => [d.mac, d]));

    // Helper: convert parent_mac value to node ID
    const _parentNodeId = pm => pm.startsWith('vsw:') ? pm.slice('vsw:'.length) : `h-${pm}`;

    // Sync node types from net_settings (fixes stale type='host' from old topo saves)
    const devSettings = _netSettings.devices || {};
    _netData.nodes.forEach(n => {
        if (!n.mac) return;
        const cfg = devSettings[n.mac];
        if (cfg?.type) n.type = cfg.type;
    });

    // Auto-add devices with visualize=true OR switch/router/ap type
    const w0 = document.getElementById('net-svg').clientWidth  || 800;
    const h0 = document.getElementById('net-svg').clientHeight || 500;
    const AUTO_TYPES = new Set(['switch', 'router', 'ap']);
    for (const [mac, cfg] of Object.entries(devSettings)) {
        if (!cfg.visualize && !AUTO_TYPES.has(cfg.type)) continue;
        const nodeId = `h-${mac}`;
        if (_netData.nodes.some(n => n.id === nodeId)) continue;
        const dev = _netDevices.get(mac);
        const label = cfg.hostname || dev?.hostname || dev?.ip || mac;
        _netData.nodes.push({
            id: nodeId, type: cfg.type || 'host',
            label, hostname: cfg.hostname || dev?.hostname || '',
            ip: dev?.ip || '', mac,
            parent: '',
            x: w0/2 + (Math.random()-0.5)*300, y: h0/2 + (Math.random()-0.5)*300,
        });
        topoChanged = true;
    }
    // Auto-add virtual switches as nodes (canonical id = sw.id, e.g. 'vsw-1779451687')
    for (const sw of (_netSettings.virtual_switches || [])) {
        const nodeId = sw.id;
        if (_netData.nodes.some(n => n.id === nodeId)) continue;
        _netData.nodes.push({
            id: nodeId, type: 'switch',
            label: sw.hostname, hostname: sw.hostname,
            ip: '', mac: '',
            x: w0/2 + (Math.random()-0.5)*300, y: h0/2 + (Math.random()-0.5)*300,
        });
        topoChanged = true;
    }
    // Add links for parent_mac connections (device-to-device or device-to-vsw)
    for (const [mac, cfg] of Object.entries(devSettings)) {
        if ((!cfg.visualize && !AUTO_TYPES.has(cfg.type)) || !cfg.parent_mac) continue;
        const childId = `h-${mac}`;
        const parentId = _parentNodeId(cfg.parent_mac);
        if (!_netData.nodes.some(n => n.id === childId)) continue;
        if (!_netData.nodes.some(n => n.id === parentId)) continue;
        const linked = _netData.links.some(l => {
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            return (s === parentId && t === childId) || (s === childId && t === parentId);
        });
        if (!linked) {
            _netData.links.push({ source: parentId, target: childId, label: cfg.parent_port || '', wifi: cfg.connection_type === 'wifi' });
            topoChanged = true;
        }
    }
    // Add links for virtual switch parent connections
    for (const sw of (_netSettings.virtual_switches || [])) {
        if (!sw.parent_mac) continue;
        const childId = sw.id;
        const parentId = _parentNodeId(sw.parent_mac);
        if (!_netData.nodes.some(n => n.id === childId)) continue;
        if (!_netData.nodes.some(n => n.id === parentId)) continue;
        const linked = _netData.links.some(l => {
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            return (s === parentId && t === childId) || (s === childId && t === parentId);
        });
        if (!linked) {
            _netData.links.push({ source: parentId, target: childId, label: '' });
            topoChanged = true;
        }
    }
    _netSyncIspCloud();
    if (topoChanged) fetch('/api/topo-data', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(_topoForSave()) }).catch(() => {});

    // D3 force simulation
    _netSim = d3.forceSimulation(_netData.nodes)
        .force('link', d3.forceLink(_netData.links).id(d => d.id).distance(65).strength(0.8))
        .force('charge', d3.forceManyBody().strength(-80))
        .force('center', d3.forceCenter(w / 2, h / 2))
        .force('collision', d3.forceCollide(44))
        .alphaDecay(0.012)
        .on('tick', netTick);

    netRender();
    $('net-node-count').textContent = _netData.nodes.length;
    $('net-link-count').textContent = _netData.links.length;
}

function netRender() {
    if (!_netG) return;
    _netG.selectAll('*').remove();

    const _devCfg = _netSettings.devices || {};
    const _linkConn = d => {
        if (d.wifi) return 'wifi';
        const tgt = typeof d.target === 'object' ? d.target : _netData.nodes.find(n => n.id === d.target);
        return tgt?.mac ? (_devCfg[tgt.mac]?.connection_type || 'ethernet') : 'ethernet';
    };
    const _LINK_COLOR = { ethernet: '#14333a', wifi: '#3b82f6', virtual: '#f97316' };
    const linkSel = _netG.selectAll('.net-link')
        .data(_netData.links).enter().append('line')
        .attr('class', 'net-link')
        .style('stroke', d => _LINK_COLOR[_linkConn(d)] || '#14333a')
        .style('stroke-width', 1.5)
        .style('stroke-dasharray', d => _linkConn(d) === 'wifi' ? '5,3' : null);

    const linkLabelSel = _netG.selectAll('.net-link-label')
        .data(_netData.links).enter().append('text')
        .attr('class', 'net-link-label')
        .style('font-size', '9px').style('fill', '#4d7479').style('pointer-events', 'none')
        .style('text-anchor', 'middle');

    const nodeSel = _netG.selectAll('.net-node')
        .data(_netData.nodes).enter().append('g')
        .attr('class', 'net-node')
        .call(d3.drag()
            .on('start', netDragStart)
            .on('drag',  netDragged)
            .on('end',   netDragEnd))
        .on('click',      (ev, d) => { ev.stopPropagation(); netHideTooltip(); netClickNode(d); })
        .on('mouseenter', (ev, d) => { _netHoverTimer = setTimeout(() => netShowTooltip(ev, d), 600); })
        .on('mousemove',  (ev)    => { netMoveTooltip(ev); })
        .on('mouseleave', ()      => { clearTimeout(_netHoverTimer); netHideTooltip(); });

    // Draw shapes
    nodeSel.each(function(d) {
        const g = d3.select(this);
        const cfg = NODE_TYPES[d.type] || NODE_TYPES.host;
        const devCfg = (_netSettings.devices || {})[d.mac] || {};
        if (d.type === 'cloud') {
            g.append('rect')
                .attr('x', -cfg.w/2).attr('y', -cfg.h/2)
                .attr('width', cfg.w).attr('height', cfg.h)
                .attr('rx', cfg.h/2).style('fill', cfg.color).style('stroke', cfg.stroke)
                .style('stroke-width', 1.5).style('stroke-dasharray', '4,2');
            g.append('text').attr('y', 6).style('font-size', '16px').style('text-anchor', 'middle')
                .style('pointer-events', 'none').text('☁');
        } else if (_NET_RECT_TYPES.has(d.type)) {
            if (devCfg.is_isp) {
                g.append('rect')
                    .attr('x', -cfg.w/2 - 5).attr('y', -cfg.h/2 - 5)
                    .attr('width', cfg.w + 10).attr('height', cfg.h + 10)
                    .attr('rx', 4).style('fill', '#ffe83b').style('opacity', 0.25)
                    .attr('filter', 'url(#isp-glow)');
            }
            g.append('rect')
                .attr('x', -cfg.w/2).attr('y', -cfg.h/2)
                .attr('width', cfg.w).attr('height', cfg.h)
                .attr('rx', 2).style('fill', netNodeColor(d)).style('stroke', netNodeStroke(d))
                .style('stroke-width', devCfg.is_isp ? 2.5 : 1.5);
            const _RECT_ICON = { switch: 'SW', router: 'R', ap: 'AP', network: 'N', tv: 'TV' };
            const icon = _RECT_ICON[d.type];
            if (icon) g.append('text').attr('y', 4).style('font-size', '7px').style('font-weight', '800')
                .style('fill', devCfg.is_isp ? '#0d1e26' : '#001830').style('text-anchor', 'middle')
                .style('pointer-events', 'none').style('letter-spacing', '0.5px').text(icon);
        } else {
            g.append('circle').attr('r', cfg.r)
                .style('fill', netNodeColor(d)).style('stroke', netNodeStroke(d)).style('stroke-width', 1.5);
        }
        g.append('text').attr('class', 'net-node-label')
            .attr('y', (d.type === 'cloud' ? cfg.h/2 + 12 : _NET_RECT_TYPES.has(d.type) ? 14 : 18))
            .style('font-size', '10px').style('fill', '#cfe7ec').style('text-anchor', 'middle')
            .style('pointer-events', 'none')
            .text(d.label || d.hostname || d.ip || d.id);
    });

    // Click on canvas = deselect
    _netSvg.on('click', () => { _netSelected = null; netHighlight(); netClosePanel(); });

    _netSim.nodes(_netData.nodes);
    _netSim.force('link').links(_netData.links);
    _netSim.alpha(0.3).restart();

    netHighlight();
}

function netTick() {
    if (!_netG) return;
    _netG.selectAll('.net-link')
        .attr('x1', d => d.source.x || 0).attr('y1', d => d.source.y || 0)
        .attr('x2', d => d.target.x || 0).attr('y2', d => d.target.y || 0);
    _netG.selectAll('.net-link-label')
        .attr('x', d => ((d.source.x||0) + (d.target.x||0)) / 2)
        .attr('y', d => ((d.source.y||0) + (d.target.y||0)) / 2 - 4)
        .text(d => {
            const parts = [];
            if (d.src_port) parts.push(`p${d.src_port}`);
            if (d.tgt_port) parts.push(`p${d.tgt_port}`);
            return parts.join('↔');
        });
    _netG.selectAll('.net-node')
        .attr('transform', d => `translate(${d.x || 0},${d.y || 0})`);
}

function netHighlight() {
    if (!_netG) return;
    _netG.selectAll('.net-node').classed('selected', d => d.id === _netSelected);
}

let _netHoverTimer = null;
const _netTT = (() => { const el = document.createElement('div'); el.id = 'net-tooltip'; document.body.appendChild(el); return el; })();

function netShowTooltip(ev, d) {
    const dev = _netDevices.get(d.mac);
    const ports = dev?.ports || '—';
    const typeLabel = { lxc: 'LXC', qemu: 'QEMU', host: 'HOST', switch: 'SWITCH', router: 'ROUTER', nas: 'NAS', mobile: 'MOBILE', tv: 'TV', printer: 'PRINTER', server: 'SERVER', rpi: 'RPI', other: 'OTHER' }[d.type] || d.type?.toUpperCase() || 'HOST';
    const online = dev ? (dev.is_online ? 'ONLINE' : 'OFFLINE') : '—';
    _netTT.innerHTML =
        `<div class="net-tt-title">${escape(d.label || d.hostname || d.id)}</div>` +
        `<div class="net-tt-row"><span class="lbl">TYPE</span><span>${typeLabel}</span></div>` +
        `<div class="net-tt-row"><span class="lbl">STATUS</span><span style="color:${dev?.is_online?'var(--accent)':'#555'}">${online}</span></div>` +
        `<div class="net-tt-row"><span class="lbl">IP</span><span>${escape(d.ip || dev?.ip || '—')}</span></div>` +
        `<div class="net-tt-row"><span class="lbl">MAC</span><span>${escape(d.mac || '—')}</span></div>` +
        `<div class="net-tt-row"><span class="lbl">PORTS</span><span>${escape(ports)}</span></div>` +
        (dev?.vendor ? `<div class="net-tt-row"><span class="lbl">VENDOR</span><span>${escape(dev.vendor)}</span></div>` : '');
    _netTT.style.display = 'block';
    netMoveTooltip(ev);
}
function netMoveTooltip(ev) {
    if (_netTT.style.display === 'none') return;
    _netTT.style.left = (ev.clientX + 14) + 'px';
    _netTT.style.top  = (ev.clientY - 10) + 'px';
}
function netHideTooltip() { _netTT.style.display = 'none'; }

function netDragStart(ev, d) {
    if (!ev.active) _netSim.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
}
function netDragged(ev, d) {
    d.fx = ev.x; d.fy = ev.y;
}
function netDragEnd(ev, d) {
    if (!ev.active) _netSim.alphaTarget(0);
    d.fx = ev.x; d.fy = ev.y; // pin in place after drop
}

function netClickNode(d) {
    if (_netEdit && _netLinkArm === 'armed') {
        _netLinkArm = d.id;
        $('net-hint').textContent = 'Click second node to complete link...';
        return;
    }
    if (_netEdit && _netLinkArm && _netLinkArm !== 'armed' && _netLinkArm !== d.id) {
        const srcPort = prompt('Source port (leave blank if none):') || '';
        const tgtPort = prompt('Target port (leave blank if none):') || '';
        _netData.links.push({ source: _netLinkArm, target: d.id,
                              src_port: srcPort ? +srcPort : null,
                              tgt_port: tgtPort ? +tgtPort : null });
        _netLinkArm = null;
        $('net-hint').textContent = '';
        $('net-link-count').textContent = _netData.links.length;
        netRender();
        return;
    }
    _netSelected = d.id;
    netHighlight();
    if (d.mac) { openDeviceModal(d.mac); return; }
    netOpenPanel(d);
}

function netOpenPanel(d) {
    const panel = $('net-panel');
    const body  = $('net-panel-body');
    $('net-panel-title').textContent = `◤ ${(d.type || 'HOST').toUpperCase()} — ${d.label || d.id}`;
    panel.classList.remove('hidden');

    const dev = _netDevices.get(d.mac);
    const notif = (_netSettings.notifications || {})[d.mac] || { connect: true, disconnect: true };

    let html = `
        <label>Label<input type="text" id="np-label" value="${escape(d.label || '')}"></label>`;

    if (d.type === 'host' || !d.type) {
        html += `
        <label>IP<input type="text" id="np-ip" value="${escape(d.ip || '')}"></label>
        <label>MAC<input type="text" id="np-mac" value="${escape(d.mac || '')}"></label>
        ${dev ? `<div style="font-size:10px;color:var(--muted)">Status: <span style="color:${dev.is_online?'var(--green)':'#555'}">${dev.is_online?'ONLINE':'OFFLINE'}</span></div>` : ''}
        <div class="net-section-title">Notifications</div>
        <div class="net-notify-row"><span>Connect alert</span>
            <label class="fsc-toggle"><input type="checkbox" id="np-notify-con" ${notif.connect?'checked':''}><span class="fsc-toggle-slider"></span></label></div>
        <div class="net-notify-row"><span>Disconnect alert</span>
            <label class="fsc-toggle"><input type="checkbox" id="np-notify-dis" ${notif.disconnect?'checked':''}><span class="fsc-toggle-slider"></span></label></div>`;
    } else if (d.type === 'switch' || d.type === 'router') {
        html += `
        <label>Ports<input type="number" id="np-ports" value="${d.ports || 8}" min="1" max="48"></label>`;
        // Show port assignments from links
        const myLinks = _netData.links.filter(l => {
            const srcId = (l.source.id || l.source);
            const tgtId = (l.target.id || l.target);
            return srcId === d.id || tgtId === d.id;
        });
        if (myLinks.length) {
            html += `<div class="net-section-title">Port assignments</div><div class="net-port-list">`;
            myLinks.forEach(l => {
                const srcId = (l.source.id || l.source);
                const tgtId = (l.target.id || l.target);
                const isSource = srcId === d.id;
                const otherId  = isSource ? tgtId : srcId;
                const portNum  = isSource ? l.src_port : l.tgt_port;
                const other = _netData.nodes.find(n => n.id === otherId);
                const otherLabel = other ? (other.label || other.hostname || other.ip || otherId) : otherId;
                html += `<div class="net-port-row"><span class="net-port-num">${portNum ?? '—'}</span><span class="net-port-host">${escape(otherLabel)}</span></div>`;
            });
            html += '</div>';
        }
    }

    html += `
        <div style="display:flex;gap:6px;margin-top:4px;">
            <button class="btn primary" id="np-save" style="flex:1">SAVE</button>
            <button class="btn" id="np-del" style="color:#ff2a5e;border-color:#ff2a5e;">DEL</button>
        </div>`;
    body.innerHTML = html;

    $('np-save').addEventListener('click', () => netSaveNode(d));
    $('np-del').addEventListener('click', () => netDeleteNode(d));
}

async function netSaveNode(d) {
    d.label = $('np-label').value.trim() || d.label;
    if (d.type === 'host' || !d.type) {
        d.ip  = ($('np-ip')  || {}).value || d.ip;
        d.mac = ($('np-mac') || {}).value || d.mac;
        const mac = d.mac;
        if (mac) {
            const nc = !!($('np-notify-con')  || {}).checked;
            const nd = !!($('np-notify-dis') || {}).checked;
            await fetch('/api/network/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mac, notify_connect: nc, notify_disconnect: nd })
            });
            _netSettings.notifications = _netSettings.notifications || {};
            _netSettings.notifications[mac] = { connect: nc, disconnect: nd };
        }
    } else {
        const portsEl = $('np-ports');
        if (portsEl) d.ports = +portsEl.value || d.ports;
    }
    netRender();
    netOpenPanel(d);
}

function netDeleteNode(d) {
    if (!confirm(`Delete node "${d.label || d.id}"?`)) return;
    _netData.nodes = _netData.nodes.filter(n => n.id !== d.id);
    _netData.links = _netData.links.filter(l => {
        const s = l.source.id || l.source;
        const t = l.target.id || l.target;
        return s !== d.id && t !== d.id;
    });
    _netSelected = null;
    netClosePanel();
    $('net-node-count').textContent = _netData.nodes.length;
    $('net-link-count').textContent = _netData.links.length;
    netRender();
}

function netClosePanel() { $('net-panel').classList.add('hidden'); }

// Toolbar buttons
$('net-edit-btn').addEventListener('click', () => {
    _netEdit = !_netEdit;
    _netLinkArm = null;
    $('net-edit-btn').classList.toggle('primary', _netEdit);
    $('net-hint').textContent = _netEdit ? 'EDIT MODE — drag nodes, click to configure' : '';
    if (_netSim) { _netEdit ? _netSim.alphaTarget(0.05).restart() : _netSim.alphaTarget(0); }
});

function _netAddHostFromPicker(dev) {
    const w = document.getElementById('net-svg').clientWidth  || 800;
    const h = document.getElementById('net-svg').clientHeight || 500;
    const label = dev.hostname || dev.ip || 'host';
    // Parent: pick from existing topology nodes
    const topoNodes = _netData.nodes.filter(n => n.id !== `h-${dev.mac}`);
    const parentId = topoNodes.length
        ? topoNodes.find(n => n.type === 'router' || n.type === 'switch')?.id || ''
        : '';
    _netData.nodes.push({
        id: `h-${dev.mac || Date.now()}`, type: dev.type || 'host',
        label, hostname: dev.hostname, ip: dev.ip, mac: dev.mac || '',
        parent: parentId,
        x: w/2 + (Math.random()-0.5)*200, y: h/2 + (Math.random()-0.5)*200,
    });
    $('net-node-count').textContent = _netData.nodes.length;
    netRender();
}

$('net-add-host').addEventListener('click', async () => {
    if (!_netEdit) { $('net-hint').textContent = 'Enable EDIT first.'; return; }
    const devices = await fetch('/api/devices').then(r => r.json()).catch(() => []);
    const pickerModal = $('host-picker-modal');
    const pickerList  = $('host-picker-list');

    pickerList.innerHTML = devices.length
        ? devices.map(d => `
            <div class="row dev clickable host-pick-row" data-mac="${escape(d.mac)}"
                 style="cursor:pointer;" title="Click to add">
                <span class="dot ${d.is_online ? 'on' : 'off'}"></span>
                <div style="flex:1;min-width:0;">
                    <div style="display:flex;justify-content:space-between;">
                        <span class="name">${escape(d.hostname || d.ip)}</span>
                        <span class="meta">${d.is_online ? 'online' : 'offline'}</span>
                    </div>
                    <div class="ip">${d.ip} · ${escape(d.vendor || '')}</div>
                </div>
            </div>`).join('')
        : '<div class="empty">No LAN devices found.</div>';

    pickerList.querySelectorAll('.host-pick-row').forEach(row => {
        row.addEventListener('click', () => {
            const mac = unescape(row.dataset.mac);
            const dev = devices.find(d => d.mac === mac) || { mac };
            pickerModal.classList.add('hidden');
            _netAddHostFromPicker(dev);
        });
    });

    $('host-picker-custom').onclick = () => {
        pickerModal.classList.add('hidden');
        const label = prompt('Hostname / label:');
        if (!label) return;
        const ip  = prompt('IP address:') || '';
        const mac = prompt('MAC address (leave blank for virtual):') || '';
        _netAddHostFromPicker({ hostname: label, ip, mac, type: 'host' });
    };

    pickerModal.classList.remove('hidden');
});

$('net-add-switch').addEventListener('click', () => {
    if (!_netEdit) { $('net-hint').textContent = 'Enable EDIT first.'; return; }
    const label = prompt('Switch label:') || 'SW';
    const ports = parseInt(prompt('Number of ports:', '24') || '24');
    const w = document.getElementById('net-svg').clientWidth  || 800;
    const h = document.getElementById('net-svg').clientHeight || 500;
    _netData.nodes.push({ id: `sw-${Date.now()}`, type: 'switch', label, ports,
                          x: w/2 + (Math.random()-0.5)*200, y: h/2 + (Math.random()-0.5)*200 });
    $('net-node-count').textContent = _netData.nodes.length;
    netRender();
});

$('net-add-router').addEventListener('click', () => {
    if (!_netEdit) { $('net-hint').textContent = 'Enable EDIT first.'; return; }
    const label = prompt('Router label:') || 'GW';
    const ip    = prompt('IP / WAN address:') || '';
    const w = document.getElementById('net-svg').clientWidth  || 800;
    const h = document.getElementById('net-svg').clientHeight || 500;
    _netData.nodes.push({ id: `rt-${Date.now()}`, type: 'router', label, ip,
                          x: w/2 + (Math.random()-0.5)*200, y: h/2 + (Math.random()-0.5)*200 });
    $('net-node-count').textContent = _netData.nodes.length;
    netRender();
});

$('net-add-link').addEventListener('click', () => {
    if (!_netEdit) { $('net-hint').textContent = 'Enable EDIT first.'; return; }
    _netLinkArm = 'armed';
    $('net-hint').textContent = 'Click first node...';
});

$('net-save-btn').addEventListener('click', async () => {
    // Freeze positions before save
    _netData.nodes.forEach(n => { n.x = Math.round(n.x || 0); n.y = Math.round(n.y || 0); });
    try {
        await fetch('/api/topo-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_topoForSave())
        });
        $('net-hint').textContent = 'Saved.';
        setTimeout(() => { $('net-hint').textContent = _netEdit ? 'EDIT MODE' : ''; }, 2000);
    } catch { $('net-hint').textContent = 'Save failed.'; }
});

$('net-reseed-btn').addEventListener('click', () => {
    if (!_netSim) return;
    const w = document.getElementById('net-svg').clientWidth  || 800;
    const h = document.getElementById('net-svg').clientHeight || 500;
    _netData.nodes.forEach(n => {
        delete n.fx; delete n.fy;
        n.x = w/2 + (Math.random() - 0.5) * 200;
        n.y = h/2 + (Math.random() - 0.5) * 200;
    });
    _netSim.nodes(_netData.nodes);
    _netSim.alpha(0.9).restart();
});

// ── DB Viewer ─────────────────────────────────────────────────────────────────
const _dbv = { table: 'attacks', page: 0, pageSize: 100, total: 0, cols: [], selected: new Set(), q: '', sortCol: '', sortDir: 'desc' };

function dbvOpen() {
    $('db-viewer').classList.remove('hidden');
    // In work mode the attacks table is empty; start on ban_history which has HTTP/HTTPS/fail2ban
    if (_workMode && _dbv.table === 'attacks') dbvSwitch('ban_history');
    else dbvLoad();
}
function dbvClose() { $('db-viewer').classList.add('hidden'); }

function dbvSwitch(table) {
    _dbv.table = table; _dbv.page = 0; _dbv.selected.clear(); _dbv.q = '';
    $('dbv-search').value = '';
    ['attacks','ban_history','devices','active_users','logs'].forEach(t => {
        const btn = $('dbv-tab-' + t);
        if (btn) btn.style.background = t === table ? 'var(--accent)' : '';
        if (btn) btn.style.color = t === table ? '#0a1a1e' : '';
    });
    dbvLoad();
}

async function dbvLoadLogs() {
    const logs = await fetch('/api/logs?limit=400').then(r => r.json()).catch(() => []);
    const cols = ['ts', 'level', 'source', 'msg'];
    const thead = $('dbv-thead');
    thead.innerHTML = '<tr><th></th>' + cols.map(c => `<th>${c.toUpperCase()}</th>`).join('') + '</tr>';
    const tbody = $('dbv-tbody');
    const q = _dbv.q.toLowerCase();
    const filtered = q ? logs.filter(l => cols.some(c => String(l[c] ?? '').toLowerCase().includes(q))) : logs;
    tbody.innerHTML = filtered.slice(0, 400).map(l => {
        const ts = (l.ts || '').substring(0, 19);
        return `<tr><td></td>` + cols.map(c => {
            const v = c === 'ts' ? ts : (l[c] ?? '');
            return `<td title="${escape(String(v))}">${escape(String(v))}</td>`;
        }).join('') + `</tr>`;
    }).join('');
    $('dbv-page-info').textContent = `${filtered.length} entries`;
    $('dbv-count').textContent = `${filtered.length}`;
    $('dbv-prev').disabled = true;
    $('dbv-next').disabled = true;
    $('dbv-delete-btn').style.display = 'none';
}

async function dbvLoad() {
    if (_dbv.table === 'logs') { await dbvLoadLogs(); return; }
    const params = new URLSearchParams({ limit: _dbv.pageSize, offset: _dbv.page * _dbv.pageSize });
    if (_dbv.q) params.set('q', _dbv.q);
    if (_dbv.sortCol) { params.set('sort_col', _dbv.sortCol); params.set('sort_dir', _dbv.sortDir); }
    const data = await fetch(`/api/db/${_dbv.table}?${params}`).then(r => r.json()).catch(() => null);
    if (!data || data.error) return;
    _dbv.cols = data.columns; _dbv.total = data.total; _dbv.pk = data.pk;

    // Header with sortable columns
    const thead = $('dbv-thead');
    thead.innerHTML = '<tr><th><input type="checkbox" id="dbv-chk-all" title="Select all"></th>'
        + data.columns.map(c => {
            const isActive = c === _dbv.sortCol;
            const arrow = isActive ? (_dbv.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
            return `<th class="dbv-sortable" data-col="${c}" style="cursor:pointer;user-select:none;${isActive?'color:var(--accent)':''}">${c.toUpperCase()}${arrow}</th>`;
        }).join('') + '</tr>';
    $('dbv-chk-all').addEventListener('change', e => {
        document.querySelectorAll('#dbv-tbody .dbv-chk').forEach(chk => {
            chk.checked = e.target.checked;
            const id = chk.dataset.id;
            e.target.checked ? _dbv.selected.add(id) : _dbv.selected.delete(id);
            chk.closest('tr').classList.toggle('selected', e.target.checked);
        });
        dbvUpdateDeleteBtn();
    });

    // Sort on column header click
    thead.querySelectorAll('.dbv-sortable').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (_dbv.sortCol === col) {
                _dbv.sortDir = _dbv.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                _dbv.sortCol = col; _dbv.sortDir = 'desc';
            }
            _dbv.page = 0; dbvLoad();
        });
    });

    // Rows
    const tbody = $('dbv-tbody');
    tbody.innerHTML = '';
    data.rows.forEach(row => {
        const id = String(row[_dbv.pk]);
        const sel = _dbv.selected.has(id);
        const tr = document.createElement('tr');
        if (sel) tr.classList.add('selected');
        tr.innerHTML = `<td><input type="checkbox" class="dbv-chk" data-id="${id}" ${sel ? 'checked' : ''}></td>`
            + data.columns.map(c => {
                const v = row[c] ?? '';
                const cls = c === _dbv.pk ? ' class="dbv-pk"' : '';
                return `<td${cls} title="${v}">${v}</td>`;
            }).join('');
        tr.querySelector('.dbv-chk').addEventListener('change', e => {
            const rid = e.target.dataset.id;
            e.target.checked ? _dbv.selected.add(rid) : _dbv.selected.delete(rid);
            tr.classList.toggle('selected', e.target.checked);
            dbvUpdateDeleteBtn();
        });
        tbody.appendChild(tr);
    });

    const pages = Math.max(1, Math.ceil(_dbv.total / _dbv.pageSize));
    $('dbv-page-info').textContent = `Page ${_dbv.page + 1} / ${pages}  (${_dbv.total} rows)`;
    $('dbv-count').textContent = `${_dbv.total} rows`;
    $('dbv-prev').disabled = _dbv.page === 0;
    $('dbv-next').disabled = (_dbv.page + 1) >= pages;
    dbvUpdateDeleteBtn();
}

function dbvUpdateDeleteBtn() {
    const btn = $('dbv-delete-btn');
    btn.style.display = _dbv.selected.size ? '' : 'none';
    btn.textContent = `DELETE SELECTED (${_dbv.selected.size})`;
}

function dbvPage(dir) { _dbv.page = Math.max(0, _dbv.page + dir); dbvLoad(); }

async function dbvDeleteSelected() {
    if (!_dbv.selected.size) return;
    if (!confirm(`Delete ${_dbv.selected.size} record(s)?`)) return;
    const ids = [..._dbv.selected];
    const r = await fetch(`/api/db/${_dbv.table}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ids),
    }).then(x => x.json()).catch(() => null);
    if (r?.deleted != null) {
        _dbv.selected.clear();
        _dbv.page = 0;
        dbvLoad();
    }
}

let _dbvSearchTimer = null;
$('dbv-search').addEventListener('input', e => {
    clearTimeout(_dbvSearchTimer);
    _dbvSearchTimer = setTimeout(() => { _dbv.q = e.target.value; _dbv.page = 0; dbvLoad(); }, 350);
});
$('db-viewer-btn').addEventListener('click', () => { dbvOpen(); });
$('db-viewer-close').addEventListener('click', dbvClose);
$('db-viewer').addEventListener('click', e => { if (e.target === $('db-viewer')) dbvClose(); });

$('net-panel-close').addEventListener('click', () => { _netSelected = null; netHighlight(); netClosePanel(); });

// ── Network Search Modal ───────────────────────────────────────────────────
let _netSearchDevices = [];

function _netSearchOpen() {
    $('net-search-modal').classList.remove('hidden');
    const inp = $('net-search-input');
    inp.value = '';
    _netSearchRender('');
    inp.focus();
}
function _netSearchClose() { $('net-search-modal').classList.add('hidden'); }

function _netSearchRender(q) {
    const results = $('net-search-results');
    const devSettings = (_netSettings.devices || {});
    const term = q.trim().toLowerCase();
    const matches = _netSearchDevices.filter(d => {
        if (!term) return true;
        const cfg = devSettings[d.mac] || {};
        return (d.ip || '').includes(term)
            || (d.mac || '').toLowerCase().includes(term)
            || (d.hostname || '').toLowerCase().includes(term)
            || (cfg.hostname || '').toLowerCase().includes(term)
            || (d.vendor || '').toLowerCase().includes(term);
    }).sort((a, b) => _ipToNum(a.ip) - _ipToNum(b.ip));

    if (!matches.length) {
        results.innerHTML = '<div class="empty">No devices found.</div>';
        return;
    }
    const devSettings2 = (_netSettings.devices || {});
    results.innerHTML = matches.map(d => {
        const cfg = devSettings2[d.mac] || {};
        const name = cfg.hostname || d.hostname || d.ip;
        const typeBadge = cfg.type === 'lxc'  ? ' <span style="color:#a855f7;font-size:9px;">[LXC]</span>'
                        : cfg.type === 'qemu' ? ' <span style="color:#38bdf8;font-size:9px;">[QEMU]</span>' : '';
        const dot = `<span class="dot ${d.is_online ? 'on' : 'off'}" style="margin-right:6px;"></span>`;
        const ports = (d.ports || '').split(',').filter(Boolean).slice(0, 5)
            .map(p => `<span class="port" style="font-size:9px;padding:0 4px;">${p}</span>`).join('');
        return `<div class="row dev clickable" data-mac="${escape(d.mac)}"
                    style="border-left:2px solid ${d.is_online ? 'var(--accent)' : '#4d7479'};">
            ${dot}
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span class="name">${escape(name)}${typeBadge}</span>
                    <span style="color:var(--muted);font-size:9px;">${escape(d.ip)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;">
                    <span style="color:#4d7479;font-size:9px;font-family:monospace;">${escape(d.mac)}</span>
                    <span style="color:#4d7479;font-size:9px;">${escape(d.vendor || '')}</span>
                </div>
                ${ports ? `<div class="ports" style="margin-top:2px;">${ports}</div>` : ''}
            </div>
        </div>`;
    }).join('');
    results.querySelectorAll('.dev[data-mac]').forEach(row => {
        row.addEventListener('click', () => { _netSearchClose(); openDeviceModal(row.dataset.mac); });
    });
}

$('net-search-btn').addEventListener('click', async () => {
    _netSearchDevices = await fetch('/api/devices').then(r => r.json()).catch(() => []);
    _netSearchOpen();
});
$('net-search-close').addEventListener('click', _netSearchClose);
$('net-search-modal').addEventListener('click', e => { if (e.target === $('net-search-modal')) _netSearchClose(); });
$('net-search-input').addEventListener('input', e => _netSearchRender(e.target.value));

$('ns-refresh-btn').addEventListener('click', async () => {
    $('ns-refresh-btn').textContent = '↺ REFRESHING…';
    _netSearchDevices = await fetch('/api/devices').then(r => r.json()).catch(() => []);
    _netSearchRender($('net-search-input').value);
    $('ns-refresh-btn').textContent = '↺ REFRESH DEVICES';
});

$('ns-export-btn').addEventListener('click', () => {
    const devSettings = (_netSettings.devices || {});
    const rows = [['IP','MAC','Hostname','Vendor','Status','Ports','Type']];
    _netSearchDevices.sort((a, b) => _ipToNum(a.ip) - _ipToNum(b.ip)).forEach(d => {
        const cfg = devSettings[d.mac] || {};
        rows.push([d.ip, d.mac, cfg.hostname || d.hostname || '', d.vendor || '',
                   d.is_online ? 'online' : 'offline', d.ports || '', cfg.type || '']);
    });
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'devices.csv';
    a.click();
});

$('ns-scan-btn').addEventListener('click', () => {
    alert('Port scan: select a device from the list and use the device modal to view/refresh ports.');
});

