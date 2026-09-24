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
    self: { addEventListener: (type, handler) => handlers.set(type, handler) },
    location: { origin }, File, URL, crypto,
    Date: { now: () => now },
    Response: { redirect: (url, status) => Response.redirect(new URL(url, origin), status) },
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(source, context);
  return {
    advance: ms => { now += ms; },
    timers,
    count: () => vm.runInContext('pendingShares.size', context),
    async post() {
      const form = new FormData();
      form.set('text', 'shared text');
      form.set('files', new File(['file bytes'], 'shared.txt'));
      /** @type {Promise<Response> | undefined} */
      let response;
      handlers.get('fetch')({ request: { url: `${origin}/share`, method: 'POST', formData: async () => form },
        respondWith: value => { response = value; } });
      const result = await response;
      assert.ok(result);
      const location = result.headers.get('location');
      assert.ok(location);
      return new URL(location).searchParams.get('shared');
    },
    take(id, eventOrigin = origin) {
      /** @type {{text: string, files: File[]} | null | undefined} */
      let received;
      handlers.get('message')({ origin: eventOrigin, data: { type: 'take-share', id },
        ports: [{ postMessage: value => { received = value; } }] });
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
