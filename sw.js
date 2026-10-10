// Loop Knight service worker. Bump VERSION on every release so old caches are dropped.
// All URLs are relative to this file, so it works at / and under /loop-knight/.
const VERSION = 'v1.0.1';
const CACHE = 'loop-knight-' + VERSION;
const PRECACHE = [
  './',
  './index.html',
  './audio.js',
  './game.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // one by one so a missing optional file (e.g. game.js) doesn't fail the whole install
      .then((cache) => Promise.all(PRECACHE.map((url) =>
        cache.add(new Request(url, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('loop-knight-') && k !== CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function store(event, request, response) {
  if (response && response.status === 200 && response.type === 'basic') {
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // network-first for everything so index.html and game.js never mismatch after a deploy.
  // no-cache revalidates past GitHub Pages' max-age=600; after 4s on a weak connection
  // we serve the cached copy instead of hanging the launch.
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  const network = fetch(req, { cache: 'no-cache' }).then((res) => store(event, req, res));
  event.waitUntil(network.catch(() => {})); // keep the SW alive so a late response still updates the cache
  const fromCache = () => caches.match(req, { ignoreSearch: true })
    .then((hit) => hit || (isHTML ? caches.match('./index.html') : undefined))
    .then((hit) => hit || (isHTML ? caches.match('./') : undefined));
  const timeout = new Promise((_, reject) => setTimeout(reject, 4000));
  event.respondWith(
    Promise.race([network, timeout])
      .catch(() => fromCache().then((hit) => hit || network))
      .catch(() => Response.error())
  );
});
