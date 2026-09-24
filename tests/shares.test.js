import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://drop.test';
const ttl = 10 * 60 * 1000;

// Run the actual worker with a controllable clock, including delayed timers.
function workerHarness() {
  const handlers = new Map();
  const timers = new Map();
  let now = 1000;
  let nextTimer = 0;
  const context = vm.createContext({
    self: { addEventListener: (/** @type {string} */ type, /** @type {Function} */ handler) => handlers.set(type, handler) },
    location: { origin }, File, Blob, URL, crypto,
    Date: { now: () => now },
    Response: class extends Response {
      /** @override */
      static redirect(/** @type {string} */ url, /** @type {number} */ status) { return Response.redirect(new URL(url, origin), status); }
    },
    setTimeout: (/** @type {Function} */ callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (/** @type {number} */ id) => timers.delete(id)
  });
  vm.runInContext(source, context);
  return {
    advance: (/** @type {number} */ ms) => { now += ms; },
    timers,
    count: () => vm.runInContext('pendingShares.size', context),
    bytes: () => vm.runInContext('shareBytes', context),
    async post(size = 10, fileCount = 1) {
      const form = new FormData();
      form.set('text', 'shared text');
      for (let i = 0; i < fileCount; i++) form.append('files', new File([size === 10 ? 'file bytes' : new Uint8Array(size)], 'shared.txt'));
      /** @type {Promise<Response> | undefined} */
      let response;
      // Encode before handing the body to the worker. This avoids Node's
      // multipart producer racing cancellation; browsers supply encoded bytes.
      const encoded = new Request(`${origin}/share`, { method: 'POST', body: form });
      const request = new Request(encoded.url, { method: 'POST', headers: encoded.headers, body: await encoded.arrayBuffer() });
      handlers.get('fetch')({ request,
        respondWith: (/** @type {any} */ value) => { response = value; } });
      const result = await response;
      assert.ok(result);
      const location = result.headers.get('location');
      assert.ok(location);
      return new URL(location).searchParams.get('shared');
    },
    /** @param {string | null} id @param {string} [eventOrigin] */
    take(id, eventOrigin = origin) {
      /** @type {{text: string, files: File[]} | null | undefined} */
      let received;
      handlers.get('message')({ origin: eventOrigin, data: { type: 'take-share', id },
        ports: [{ postMessage: (/** @type {any} */ value) => { received = value; } }] });
      return received;
    }
  };
}

test('shared text and file bytes are handed over exactly once, only to this origin', async () => {
  const worker = workerHarness();
  const id = await worker.post();
  assert.equal(worker.take(id, 'https://other.test'), undefined);
  worker.advance(ttl - 1);
  const bundle = worker.take(id);
  assert.ok(bundle);
  assert.equal(bundle.text, 'shared text');
  assert.equal(await bundle.files[0].text(), 'file bytes');
  assert.equal(worker.take(id), null);
  assert.equal(worker.count(), 0);
  assert.equal(worker.timers.size, 0);
});

test('share expires at the deadline even when worker timers have not run', async () => {
  const worker = workerHarness();
  const id = await worker.post();
  worker.advance(ttl);
  assert.equal(worker.take(id), null);
  assert.equal(worker.count(), 0);
  assert.equal(worker.timers.size, 0);
});

test('cleanup releases unclaimed shares without another share arriving', async () => {
  const worker = workerHarness();
  await worker.post();
  worker.advance(ttl);
  for (const callback of worker.timers.values()) callback();
  assert.equal(worker.count(), 0);
  assert.equal(worker.timers.size, 0);
});

test('entry and file-count limits reject cleanly and release reservations', async () => {
  const worker = workerHarness();
  assert.equal(await worker.post(10, 33), 'too-many-files');
  assert.equal(worker.bytes(), 0);
  const ids = await Promise.all(Array.from({ length: 9 }, () => worker.post()));
  assert.equal(ids.filter(id => id === 'queue-full').length, 1);
  assert.equal(worker.count(), 8);
  for (const id of ids.filter(id => id !== 'queue-full')) worker.take(id);
  assert.equal(worker.bytes(), 0);
  assert.notEqual(await worker.post(), 'queue-full');
});

test('byte budgets include in-flight bodies and recover after rejection and expiry', async () => {
  const worker = workerHarness();
  assert.equal(await worker.post(16 * 1024 * 1024), 'too-large', 'multipart overhead also counts');
  assert.equal(worker.bytes(), 0);
  const ids = await Promise.all(Array.from({ length: 3 }, () => worker.post(15 * 1024 * 1024)));
  assert.ok(ids.includes('queue-full'));
  assert.ok(worker.bytes() <= 32 * 1024 * 1024);
  worker.advance(ttl);
  for (const callback of worker.timers.values()) callback();
  assert.equal(worker.bytes(), 0);
  assert.notEqual(await worker.post(), 'queue-full');
});
