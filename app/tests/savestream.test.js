// The service worker's streamed-save route, run as the real worker source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://drop.test';

function workerHarness() {
  const handlers = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    self: { addEventListener: (/** @type {string} */ type, /** @type {Function} */ handler) => handlers.set(type, handler) },
    location: { origin }, File, Blob, URL, crypto, Date, Response, ReadableStream, Uint8Array,
    setTimeout: (/** @type {Function} */ callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (/** @type {number} */ id) => timers.delete(id)
  });
  vm.runInContext(source, context);
  const message = (/** @type {any} */ data, /** @type {any[]} */ ports = [], eventOrigin = origin) =>
    handlers.get('message')({ origin: eventOrigin, data, ports });
  return {
    timers,
    message,
    pending: () => vm.runInContext('pendingSaves.size', context),
    active: () => vm.runInContext('activeSaves.size', context),
    /** @param {string} id @param {string} name @param {number} size */
    register(id, name, size) {
      /** @type {any[]} */
      const port = [];
      message({ type: 'save-stream', id, name, size }, [{ postMessage: (/** @type {any} */ value) => port.push(JSON.parse(JSON.stringify(value))) }]);
      return port;
    },
    /** @param {string} id @returns {Promise<Response>} */
    async claim(id) {
      /** @type {Promise<Response> | Response | undefined} */
      let response;
      handlers.get('fetch')({ request: new Request(`${origin}/save-stream/${id}`),
        respondWith: (/** @type {any} */ value) => { response = value; } });
      assert.ok(response);
      return response;
    }
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('a registered save streams once, pulling one chunk at a time, as an attachment', async () => {
  const worker = workerHarness();
  const id = crypto.randomUUID();
  const port = worker.register(id, 'résumé "final"\r\n.pdf', 6);
  assert.deepEqual(port, [{ type: 'registered' }]);

  const response = await worker.claim(id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '6');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  const disposition = response.headers.get('content-disposition') || '';
  assert.match(disposition, /^attachment; filename="r_sum_ _final___\.pdf"; filename\*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22%0D%0A\.pdf$/);
  assert.equal((await worker.claim(id)).status, 204, 'a save is claimed once');

  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  const reading = reader.read();
  await flush();
  // Only one request for data is outstanding until that data arrives.
  assert.deepEqual(port.slice(1), [{ type: 'pull' }]);
  worker.message({ type: 'save-chunk', id, chunk: new Uint8Array([1, 2, 3]) });
  assert.deepEqual([...(await reading).value || []], [1, 2, 3]);
  const next = reader.read();
  await flush();
  worker.message({ type: 'save-chunk', id, chunk: new Uint8Array([4, 5, 6]) });
  assert.deepEqual([...(await next).value || []], [4, 5, 6]);
  const end = reader.read();
  await flush();
  worker.message({ type: 'save-done', id });
  assert.equal((await end).done, true);
  assert.equal(port.filter(m => m.type === 'pull').length, 3);
  assert.equal(worker.active(), 0);
  assert.equal(worker.pending(), 0);
});

test('a page error fails the download body rather than ending it', async () => {
  const worker = workerHarness();
  const id = crypto.randomUUID();
  worker.register(id, 'x.bin', 10);
  const reader = /** @type {ReadableStream<Uint8Array>} */ ((await worker.claim(id)).body).getReader();
  const reading = reader.read();
  await flush();
  worker.message({ type: 'save-error', id, message: 'Chunk 0 does not match the verified copy' });
  await assert.rejects(reading, /does not match the verified copy/);
  assert.equal(worker.active(), 0);
});

test('a download cancelled in the browser tells the page', async () => {
  const worker = workerHarness();
  const id = crypto.randomUUID();
  const port = worker.register(id, 'x.bin', 10);
  const body = /** @type {ReadableStream<Uint8Array>} */ ((await worker.claim(id)).body);
  await body.cancel();
  assert.ok(port.some(m => m.type === 'cancel'));
  assert.equal(worker.active(), 0);
});

test('abandoned, lapsed, foreign and malformed saves serve nothing', async () => {
  const worker = workerHarness();
  const abandoned = crypto.randomUUID();
  worker.register(abandoned, 'a.bin', 1);
  worker.message({ type: 'save-abandon', id: abandoned });
  assert.equal((await worker.claim(abandoned)).status, 204);

  const lapsed = crypto.randomUUID();
  worker.register(lapsed, 'b.bin', 1);
  for (const callback of worker.timers.values()) callback();
  assert.equal((await worker.claim(lapsed)).status, 204);

  const foreign = crypto.randomUUID();
  /** @type {any[]} */
  const port = [];
  worker.message({ type: 'save-stream', id: foreign, name: 'c.bin', size: 1 },
    [{ postMessage: (/** @type {any} */ value) => port.push(JSON.parse(JSON.stringify(value))) }], 'https://other.test');
  assert.deepEqual(port, []);
  assert.equal((await worker.claim(foreign)).status, 204);

  for (const [id, name, size] of [['not-a-uuid', 'd.bin', 1], [crypto.randomUUID(), '', 1], [crypto.randomUUID(), 'e.bin', -1]]) {
    assert.deepEqual(worker.register(/** @type {string} */ (id), /** @type {string} */ (name), /** @type {number} */ (size)), [{ type: 'refused' }]);
  }
  assert.equal(worker.pending(), 0);
});
