// 00-ui.js — sdílené UI utility: persist stavu UI (localStorage), toast notifikace
// Načítá se jako první — ostatní moduly používají UIState a showToast.

const UIState = {
    get(key, fallback = null) {
        try {
            const v = localStorage.getItem('sentinel-ui-' + key);
            return v === null ? fallback : JSON.parse(v);
        } catch { return fallback; }
    },
    set(key, val) {
        try { localStorage.setItem('sentinel-ui-' + key, JSON.stringify(val)); } catch {}
    },
};

// ================================================================
// TOAST NOTIFICATIONS — "◤ INCOMING — SSH BRUTE-FORCE from RU"
// ================================================================
const _toastStack = (() => {
    const el = document.createElement('div');
    el.className = 'toast-stack';
    document.body.appendChild(el);
    return el;
})();

const _toastRecent = new Map(); // dedupKey → last shown timestamp
const TOAST_DEDUP_MS = 60000;   // same key max 1× per minute
const TOAST_MAX_VISIBLE = 4;

function showToast({ title, body = '', color = 'var(--accent)', ttl = 6000, dedupKey = null, onClick = null }) {
    if (dedupKey) {
        const last = _toastRecent.get(dedupKey) || 0;
        if (Date.now() - last < TOAST_DEDUP_MS) return;
        _toastRecent.set(dedupKey, Date.now());
        if (_toastRecent.size > 300) {
            const cutoff = Date.now() - TOAST_DEDUP_MS * 2;
            for (const [k, t] of _toastRecent) if (t < cutoff) _toastRecent.delete(k);
        }
    }
    while (_toastStack.children.length >= TOAST_MAX_VISIBLE) _toastStack.firstChild.remove();

    const el = document.createElement('div');
    el.className = 'toast';
    el.style.borderLeftColor = color;
    const titleEl = document.createElement('div');
    titleEl.className = 'toast-title';
    titleEl.style.color = color;
    titleEl.textContent = '◤ ' + title;   // textContent — data mohou obsahovat útočníkem řízené řetězce
    el.appendChild(titleEl);
    if (body) {
        const bodyEl = document.createElement('div');
        bodyEl.className = 'toast-body';
        bodyEl.textContent = body;
        el.appendChild(bodyEl);
    }
    el.addEventListener('click', () => { el.remove(); if (onClick) onClick(); });
    _toastStack.appendChild(el);
    setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => el.remove(), 350);
    }, ttl);
}

// ================================================================
// BROWSER NOTIFIKACE — native Notification API, opt-in
// ================================================================
let _notifyEnabled = UIState.get('browser-notify', false);

function browserNotifyEnabled() { return _notifyEnabled && Notification?.permission === 'granted'; }

async function setBrowserNotify(on) {
    if (on && Notification?.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { _notifyEnabled = false; UIState.set('browser-notify', false); return false; }
    }
    _notifyEnabled = on;
    UIState.set('browser-notify', on);
    return on;
}

// Pošle native notifikaci jen když je záložka na pozadí (jinak stačí toast)
function browserNotify(title, body) {
    if (!browserNotifyEnabled() || !document.hidden) return;
    try {
        const n = new Notification('◤ ' + title, { body, tag: 'sentinel', renotify: false });
        n.onclick = () => { window.focus(); n.close(); };
        setTimeout(() => n.close(), 8000);
    } catch {}
}

// ================================================================
// VISUAL FX MODE — CRT flicker, glitch, hex-grid, přechody tabů
// ================================================================
function applyFx(on) {
    document.body.classList.toggle('fx-on', on);
    UIState.set('fx', on);
}
applyFx(UIState.get('fx', !window.matchMedia('(prefers-reduced-motion: reduce)').matches));

// ================================================================
// SOUND FX — Web Audio, žádné assety. Default OFF.
// ================================================================
let _sndOn = UIState.get('sound', false);
let _audioCtx = null;
let _lastBeep = 0;

function setSound(on) {
    _sndOn = on;
    UIState.set('sound', on);
    if (on) _initAudio();
}

function _initAudio() {
    try { _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch {}
}
// AudioContext smí vzniknout až po prvním uživatelském gestu
document.addEventListener('pointerdown', () => { if (_sndOn) _initAudio(); });

function playBeep(kind = 'blip') {
    if (!_sndOn || !_audioCtx || _audioCtx.state !== 'running') return;
    const now = Date.now();
    if (kind === 'blip' && now - _lastBeep < 2000) return; // burst throttle
    _lastBeep = now;
    const t = _audioCtx.currentTime;
    const osc = _audioCtx.createOscillator();
    const g = _audioCtx.createGain();
    osc.connect(g); g.connect(_audioCtx.destination);
    if (kind === 'alarm') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(220, t);
        osc.frequency.setValueAtTime(160, t + 0.15);
        g.gain.setValueAtTime(0.06, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
        osc.start(t); osc.stop(t + 0.4);
    } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, t);
        g.gain.setValueAtTime(0.04, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        osc.start(t); osc.stop(t + 0.12);
    }
}

// ================================================================
// BOOT SEQUENCE — "SYSTEM INIT" terminálový log při načtení
// ================================================================
(function bootSequence() {
    if (!document.body.classList.contains('fx-on')) return;
    if (new URLSearchParams(location.search).get('solo')) return;
    const ov = document.createElement('div');
    ov.id = 'boot-overlay';
    ov.innerHTML = '<pre id="boot-log"></pre><div id="boot-skip">PRESS ANY KEY TO SKIP</div>';
    document.body.appendChild(ov);
    const lines = [
        '> SENTINEL-ALERT // GRID  v2026.07.001',
        '> CORE ................... OK',
        '> UI MODULES [11/11] ..... OK',
        '> GEOIP DATABASE ......... OK',
        '> THREAT FEED ............ LINK UP',
        '> ALL SYSTEMS NOMINAL',
    ];
    const log = ov.querySelector('#boot-log');
    let i = 0, closed = false;
    const timer = setInterval(() => {
        if (i < lines.length) log.textContent += lines[i++] + '\n';
        else { clearInterval(timer); setTimeout(close, 350); }
    }, 130);
    function close() {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        ov.classList.add('boot-out');
        setTimeout(() => ov.remove(), 400);
        document.removeEventListener('keydown', close, true);
    }
    document.addEventListener('keydown', close, true);
    ov.addEventListener('click', close);
})();

// ================================================================
// GAUGE RING — kruhový progress kolem stat hodnot (conic-gradient)
// ================================================================
function setGauge(id, frac, color) {
    const el = document.getElementById(id);
    if (!el) return;
    const pct = Math.max(0, Math.min(100, Math.round((frac || 0) * 100)));
    el.style.setProperty('--p', pct);
    if (color) el.style.setProperty('--gauge-color', color);
    el.title = pct + '%';
}

// ================================================================
// WATCHLIST — sledované IP/prefixy/CIDR (zvýraznění + alerty)
// ================================================================
let WATCHLIST = new Set();

function _isWatched(ip) {
    if (!ip) return false;
    if (WATCHLIST.has(ip)) return true;
    for (const w of WATCHLIST)
        if (w.endsWith('.') && ip.startsWith(w)) return true;
    return false;
}

function refreshWatchlist() {
    return fetch('/api/watchlist').then(r => r.ok ? r.json() : [])
        .then(l => { WATCHLIST = new Set(l || []); })
        .catch(() => {});
}
refreshWatchlist();

function wlAdd(entry) {
    return fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: entry }),
    }).then(r => r.json()).then(j => {
        if (j.watchlist) WATCHLIST = new Set(j.watchlist);
        return j;
    });
}

function wlDel(entry) {
    return fetch('/api/watchlist/' + encodeURIComponent(entry), { method: 'DELETE' })
        .then(r => r.json()).then(j => {
            if (j.watchlist) WATCHLIST = new Set(j.watchlist);
            return j;
        });
}

// ================================================================
// PWA — registrace service workeru (offline shell, installable)
// ================================================================
if ('serviceWorker' in navigator && !new URLSearchParams(location.search).get('solo')) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {}); // tichý fail (http/localhost bez TLS)
    });
}
