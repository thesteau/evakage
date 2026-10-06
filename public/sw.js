// Service worker for the installed app.
//
// The app shell is precached so a phone can open Evakage with no network and
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

const CACHE = 'evakage-v27';

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/frames.js',
  '/messages.js',
  '/qr.js',
  '/scanner.js',
  '/preferences.js',
  '/vendor/jsqr.js',
  '/vendor/qrcode.mjs',
  '/sha256.js',
  '/identity.js',
  '/relay.js',
  '/savestream.js',
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

// Files shared from another app (the manifest's share_target) are POSTed to
// /share. They are caught here and never reach the server: the server would only
// ever see plaintext, and it has no business holding it. They wait in this
// worker's memory — not Cache Storage, so nothing is written to disk — until the
// page it redirects to collects them, which happens as soon as that page loads.
const SHARE_TTL_MS = 10 * 60 * 1000;
// Includes multipart overhead and text, not just file sizes. In-flight reads
// reserve the same budget as queued shares, so concurrent POSTs cannot bypass it.
const SHARE_BODY_BYTES = 16 * 1024 * 1024;
const SHARE_QUEUE_BYTES = 32 * 1024 * 1024;
const SHARE_QUEUE_ENTRIES = 8;
const SHARE_FILES = 32;
let shareBytes = 0;
let incomingShares = 0;
/** @type {Map<string, {title: string, text: string, url: string, files: File[], at: number, bytes: number, timer: ReturnType<typeof setTimeout>}>} */
const pendingShares = new Map();

/** @param {string} id */
function forgetShare(id) {
  const share = pendingShares.get(id);
  if (share) {
    clearTimeout(share.timer);
    shareBytes -= share.bytes;
  }
  pendingShares.delete(id);
}

/** @param {Request} request */
async function receiveShare(request) {
  const now = Date.now();
  for (const [id, share] of pendingShares) {
    if (now - share.at >= SHARE_TTL_MS) forgetShare(id);
  }
  if (pendingShares.size + incomingShares >= SHARE_QUEUE_ENTRIES) {
    await request.body?.cancel().catch(() => {});
    return Response.redirect('/?shared=queue-full', 303);
  }
  incomingShares++;
  let bytes = 0;
  let queued = false;
  const reader = request.body?.getReader();
  try {
    if (!reader) return Response.redirect('/?shared=failed', 303);
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const reason = bytes + value.byteLength > SHARE_BODY_BYTES ? 'too-large'
        : shareBytes + value.byteLength > SHARE_QUEUE_BYTES ? 'queue-full' : null;
      if (reason) {
        await reader.cancel().catch(() => {});
        return Response.redirect(`/?shared=${reason}`, 303);
      }
      bytes += value.byteLength;
      shareBytes += value.byteLength;
      chunks.push(value);
    }
    // The body is bounded before invoking the multipart parser.
    const form = await new Response(new Blob(chunks), { headers: request.headers }).formData();
    const field = (/** @type {string} */ name) => {
      const value = form.get(name);
      return typeof value === 'string' ? value : '';
    };
    const files = form.getAll('files').filter(value => value instanceof File);
    if (files.length > SHARE_FILES) return Response.redirect('/?shared=too-many-files', 303);
    const id = crypto.randomUUID();
    // Cleanup is best effort; retrieval checks age even after suspension.
    const timer = setTimeout(() => forgetShare(id), SHARE_TTL_MS);
    pendingShares.set(id, { title: field('title'), text: field('text'), url: field('url'), files,
      at: Date.now(), bytes, timer });
    queued = true;
    return Response.redirect(`/?shared=${id}`, 303);
  } catch {
    await reader?.cancel().catch(() => {});
    return Response.redirect('/?shared=failed', 303);
  } finally {
    reader?.releaseLock();
    incomingShares--;
    if (!queued) shareBytes -= bytes;
  }
}

// Streamed saves (see savestream.js). A page registers a save, then navigates a
// hidden iframe to /save-stream/<id>; the response body is pulled from that page
// a chunk at a time, so the worker never holds more than a chunk or two. Each
// registration is single-use and lapses if no navigation claims it.
const SAVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAVE_CLAIM_MS = 60 * 1000;
/** @type {Map<string, {name: string, size: number, port: MessagePort, timer: ReturnType<typeof setTimeout>}>} */
const pendingSaves = new Map();
/** @type {Map<string, {controller: ReadableStreamDefaultController<Uint8Array>, port: MessagePort, pulled: (() => void) | null}>} */
const activeSaves = new Map();

/** @param {any} data @param {MessagePort | undefined} port */
function registerSave(data, port) {
  if (!port) return;
  const ok = SAVE_ID.test(data.id) && !pendingSaves.has(data.id) && !activeSaves.has(data.id) &&
    typeof data.name === 'string' && data.name.length > 0 && data.name.length <= 1024 &&
    Number.isSafeInteger(data.size) && data.size >= 0;
  if (!ok) { port.postMessage({ type: 'refused' }); return; }
  const timer = setTimeout(() => pendingSaves.delete(data.id), SAVE_CLAIM_MS);
  pendingSaves.set(data.id, { name: data.name, size: data.size, port, timer });
  port.postMessage({ type: 'registered' });
}

/** @param {string} name */
function contentDisposition(name) {
  // Header values cannot carry control characters; the ASCII fallback is for
  // engines that ignore filename*.
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** @param {string} id */
function claimSave(id) {
  const save = pendingSaves.get(id);
  pendingSaves.delete(id);
  // 204 leaves the iframe where it was rather than navigating it anywhere.
  if (!save) return new Response(null, { status: 204 });
  clearTimeout(save.timer);
  const { port } = save;
  const body = new ReadableStream({
    start(controller) { activeSaves.set(id, { controller, port, pulled: null }); },
    pull() {
      const active = activeSaves.get(id);
      if (!active) return;
      return new Promise(resolve => {
        active.pulled = () => resolve(undefined);
        port.postMessage({ type: 'pull' });
      });
    },
    cancel() {
      activeSaves.delete(id);
      port.postMessage({ type: 'cancel' });
    }
  }, { highWaterMark: 1 });
  return new Response(body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': contentDisposition(save.name),
      'content-length': String(save.size),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    }
  });
}

/** @param {any} data */
function feedSave(data) {
  if (data.type === 'save-abandon') {
    const pending = pendingSaves.get(data.id);
    if (pending) clearTimeout(pending.timer);
    pendingSaves.delete(data.id);
  }
  const active = activeSaves.get(data.id);
  if (!active) return;
  const wake = () => { const pulled = active.pulled; active.pulled = null; pulled?.(); };
  if (data.type === 'save-chunk' && data.chunk instanceof Uint8Array) {
    active.controller.enqueue(data.chunk);
    wake();
  } else if (data.type === 'save-done') {
    activeSaves.delete(data.id);
    active.controller.close();
    wake();
  } else if (data.type === 'save-error' || data.type === 'save-abandon') {
    activeSaves.delete(data.id);
    active.controller.error(new Error(typeof data.message === 'string' ? data.message : 'Save failed'));
    wake();
  }
}

worker.addEventListener('message', event => {
  // Only this origin's own pages can talk to its worker, but say so explicitly:
  // a share is handed to whoever asks with its ID.
  if (event.origin !== location.origin) return;
  if (event.data?.type === 'save-stream') {
    registerSave(event.data, event.ports[0]);
    return;
  }
  if (typeof event.data?.type === 'string' && event.data.type.startsWith('save-')) {
    feedSave(event.data);
    return;
  }
  // The page asks for the update rather than having it applied underneath it,
  // so a transfer in progress is never cut off by a reload.
  if (event.data === 'skip-waiting') {
    worker.skipWaiting();
    return;
  }
  // Handed over once, then forgotten.
  if (event.data?.type === 'take-share' && event.ports[0]) {
    const share = pendingShares.get(event.data.id);
    forgetShare(event.data.id);
    const bundle = share && Date.now() - share.at < SHARE_TTL_MS
      ? { title: share.title, text: share.text, url: share.url, files: share.files }
      : null;
    event.ports[0].postMessage(bundle);
  }
});

worker.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/save-stream/')) {
    event.respondWith(claimSave(url.pathname.slice('/save-stream/'.length)));
    return;
  }
  if (NETWORK_ONLY.has(url.pathname)) return;
  // Relayed transfers must never touch Cache Storage: that would persist file
  // bodies on the device and could replay a stale one.
  if (url.pathname.startsWith('/blob/') || url.pathname.startsWith('/account/')) return;

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
