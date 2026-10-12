/* IP Tracker — service worker
 * - Precaches the app shell so the app opens offline
 * - Pages: network-first, falling back to the cached shell
 * - Static assets + CDN libraries: stale-while-revalidate
 * - Never touches Supabase / API calls, non-GET requests or map tiles
 * Bump VERSION to force clients to refresh their caches.
 */
const VERSION = 'v1';
const SHELL_CACHE = `ipt-shell-${VERSION}`;
const RUNTIME_CACHE = `ipt-runtime-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './banner.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png',
  './icons/splash-logo.png',
];

// Third-party libraries index.html depends on (cached opaque, so they work offline too)
const CDN_LIBS = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
];

const CDN_HOSTS = [
  'cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
  'fonts.googleapis.com', 'fonts.gstatic.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // add one-by-one so a missing optional file (e.g. banner.png) doesn't abort install
    await Promise.all(SHELL.map((u) => shell.add(u).catch(() => {})));
    await Promise.all(CDN_LIBS.map(async (u) => {
      try { await shell.put(u, await fetch(new Request(u, { mode: 'no-cors' }))); } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, RUNTIME_CACHE];
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('ipt-') && !keep.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirstPage(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) (await caches.open(SHELL_CACHE)).put('./index.html', res.clone());
    return res;
  } catch (_) {
    return (await caches.match('./index.html')) || (await caches.match('./')) ||
      new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = (await caches.match(request)) || (await cache.match(request));
  const network = fetch(request).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || new Response('', { status: 504 });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Page navigations (the SPA shell; routing is hash-based)
  if (req.mode === 'navigate') {
    if (url.origin === self.location.origin) event.respondWith(networkFirstPage(req));
    return;
  }

  // Same-origin static files
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Known CDN libraries / fonts
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Everything else (Supabase, geo APIs, map tiles…) goes straight to the network.
});
