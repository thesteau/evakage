import test from 'node:test';
import assert from 'node:assert/strict';
import { createDropPakServer } from '../server.js';

function waitFor(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = event => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed while waiting'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
  });
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket open failed')), { once: true });
  });
}

test('health, presence, stable codes, and code lookup work', async t => {
  const app = createDropPakServer({ port: 0, host: '127.0.0.1' });
  const address = await app.start();
  t.after(async () => app.stop());
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/healthz`).then(r => r.json());
  assert.deepEqual(health, { ok: true, peers: 0 });

  const config = await fetch(`${base}/config.json`).then(r => r.json());
  assert.deepEqual(config.iceServers, []);
  assert.equal(config.maxFileBytes, 536870912);

  const a = await openWs(wsBase);
  const aRegPromise = waitFor(a, m => m.type === 'registered');
  a.send(JSON.stringify({ type: 'register', deviceId: 'device_A_12345678', name: 'Laptop', platform: 'Linux', browser: 'Firefox' }));
  const aReg = await aRegPromise;
  assert.match(aReg.self.code, /^[A-Z0-9]{4}-[A-Z0-9]+$/);

  const b = await openWs(wsBase);
  const bRegPromise = waitFor(b, m => m.type === 'registered');
  const aPresenceTwo = waitFor(a, m => m.type === 'presence' && m.peers.length === 2);
  b.send(JSON.stringify({ type: 'register', deviceId: 'device_B_12345678', name: 'Phone', platform: 'iOS', browser: 'Safari' }));
  const bReg = await bRegPromise;
  await aPresenceTwo;
  assert.notEqual(aReg.self.code, bReg.self.code);

  const lookupPromise = waitFor(a, m => m.type === 'resolved-code' && m.requestId === 'lookup-1');
  a.send(JSON.stringify({ type: 'resolve-code', requestId: 'lookup-1', code: bReg.self.code }));
  const lookup = await lookupPromise;
  assert.equal(lookup.peer.name, 'Phone');
  assert.equal(lookup.peer.id, 'device_B_12345678');

  a.close();
  b.close();
});
