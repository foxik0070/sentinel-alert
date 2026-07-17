// Service worker — offline shell pro Sentinel-Alert.
// Strategie: app shell (statické soubory) cache-first; API a WS vždy z network.
const CACHE = 'sentinel-shell-v1';
const SHELL = [
    '/',
    '/static/style.css',
    '/static/manifest.webmanifest',
    '/static/js/00-ui.js',
    '/static/js/01-globe.js',
    '/static/js/02-devices.js',
    '/static/js/03-core.js',
    '/static/js/04-topology.js',
    '/static/js/05-security.js',
    '/static/js/06-proxy.js',
    '/static/js/07-netmap.js',
    '/static/js/08-services.js',
    '/static/js/09-mikrotik.js',
    '/static/js/10-pihole.js',
    '/static/js/11-ux.js',
    '/static/vendor/globe.gl.min.js',
    '/static/vendor/chart.umd.min.js',
    '/static/vendor/d3.min.js',
    '/static/vendor/icon-192.png',
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // API a WS nikdy z cache — potřebují živá data
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

    // App shell: network-first s fallbackem na cache (offline), staticke assety
    // se aktualizují za běhu, ale při výpadku sítě appka nabootuje z cache.
    e.respondWith(
        fetch(req)
            .then(resp => {
                if (resp.ok && (url.origin === location.origin)) {
                    const copy = resp.clone();
                    caches.open(CACHE).then(c => c.put(req, copy));
                }
                return resp;
            })
            .catch(() => caches.match(req).then(r => r || caches.match('/')))
    );
});
