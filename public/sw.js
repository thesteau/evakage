// Service worker for the installed app.
//
// The app shell is precached so a phone can open aria-drop with no network and
// still reach the UI (it will just report signaling as disconnected). Runtime
// data — /config.json, /healthz — is never cached, because a stale ICE or limit
// config is worse than no answer.
//
// Bump CACHE whenever a precached asset changes; the old cache is deleted on
// activate and the new worker takes over only when the page says to.

/// <reference lib="webworker" />

// `self` in a service worker is a ServiceWorkerGlobalScope, which the default
// DOM lib does not know about.
const worker = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

const CACHE = 'aria-drop-v4';

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/sha256.js',
  '/identity.js',
  '/relay.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png'
];

const NETWORK_ONLY = new Set(['/config.json', '/healthz']);

worker.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, so one missing asset cannot fail the whole install.
    await Promise.all(SHELL.map(async path => {
      try { await cache.add(new Request(path, { cache: 'reload' })); } catch {}
    }));
  })());
});

worker.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await worker.clients.claim();
  })());
});

// The page asks for the update rather than having it applied underneath it, so a
// transfer in progress is never cut off by a reload.
worker.addEventListener('message', event => {
  if (event.data === 'skip-waiting') worker.skipWaiting();
});

worker.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (NETWORK_ONLY.has(url.pathname)) return;
  // Relayed transfers must never touch Cache Storage: that would persist file
  // bodies on the device and could replay a stale one.
  if (url.pathname.startsWith('/blob/')) return;

  // Navigations: network first so an auth redirect or a new build is picked up,
  // falling back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
      }
    })());
    return;
  }

  // Assets: serve from cache immediately, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    const network = fetch(request).then(response => {
      if (response && response.ok && response.type === 'basic') cache.put(request, response.clone());
      return response;
    }).catch(() => null);

    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    return (await network) || Response.error();
  })());
});
