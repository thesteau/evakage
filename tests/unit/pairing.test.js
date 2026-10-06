import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairingCodes, PAIRING_CODE_MAX_AGE_MS } from '../../app/server/server.js';
import { fingerprintOf, bytesToBase64, signTranscript } from '../../app/public/identity.js';
import { startServer, openWs, waitFor } from './helpers.js';

async function identity() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  return { deviceId: await fingerprintOf(raw), identityKey: bytesToBase64(raw), privateKey: keys.privateKey };
}
/** @param {{after: (fn: () => void) => void}} t @param {string} wsBase
 * @param {Awaited<ReturnType<typeof identity>>} id */
async function connect(t, wsBase, id) {
  const ws = await openWs(wsBase);
  t.after(() => ws.close());
  const challenge = (await waitFor(ws, m => m.type === 'registration-challenge')).challenge;
  const registrationProof = await signTranscript(id.privateKey, JSON.stringify(['evakage/register/1', challenge, id.deviceId]));
  const reply = waitFor(ws, m => m.type === 'registered');
  ws.send(JSON.stringify({ type: 'register', discoverable: true, deviceId: id.deviceId, identityKey: id.identityKey, registrationProof }));
  return { ws, registered: await reply };
}
/** @param {WebSocket} ws @param {string} code @param {string} [targetId] */
async function pair(ws, code, targetId) {
  const requestId = crypto.randomUUID();
  const reply = waitFor(ws, m => m.type === 'paired-device' && m.requestId === requestId);
  ws.send(JSON.stringify({ type: 'pair-device', requestId, code, targetId }));
  return reply;
}

test('pairing codes expire exactly at three days, rotate lazily and persist within their window', () => {
  let now = 1000;
  const codes = createPairingCodes(() => now);
  const first = codes.issue('alice');
  assert.equal(PAIRING_CODE_MAX_AGE_MS, 259200000);
  assert.equal(first.expiresAt, now + PAIRING_CODE_MAX_AGE_MS);
  assert.match(first.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(codes.issue('alice').code, first.code);
  assert.equal(codes.resolve(first.code.toLowerCase()), 'alice');
  now = first.expiresAt - 1;
  assert.equal(codes.resolve(first.code), 'alice');
  now++;
  assert.equal(codes.resolve(first.code), null, 'no cleanup timer needed');
  const rotated = codes.issue('alice');
  assert.notEqual(rotated.code, first.code);
  assert.equal(codes.resolve(first.code), null);
  assert.equal(codes.resolve(rotated.code), 'alice');
  assert.equal(rotated.expiresAt, now + PAIRING_CODE_MAX_AGE_MS);
});

test('private pairing codes are absent from presence and cannot be replaced with public discovery codes', async t => {
  const { wsBase } = await startServer(t);
  const alice = await identity(), bob = await identity();
  const a = await connect(t, wsBase, alice);
  const presence = waitFor(a.ws, m => m.type === 'presence' && m.peers.length === 2);
  const b = await connect(t, wsBase, bob);
  const published = (await presence).peers;
  for (const peer of published) {
    assert.equal(peer.pairingCode, undefined);
    assert.equal(peer.pairingCodeExpiresAt, undefined);
  }
  assert.ok(!JSON.stringify(published).includes(b.registered.self.pairingCode));
  assert.equal((await pair(a.ws, b.registered.self.code)).peer, null);
  assert.equal((await pair(a.ws, b.registered.self.pairingCode, alice.deviceId)).peer, null);
  const approved = waitFor(b.ws, m => m.type === 'paired-device' && m.peer?.id === alice.deviceId);
  assert.equal((await pair(a.ws, b.registered.self.pairingCode, bob.deviceId)).peer.id, bob.deviceId);
  assert.equal((await approved).peer.pairingCode, undefined);
});

test('expired codes fail without a sweep; rotation reaches only the owner and does not revoke established pairing', async t => {
  let now = 1000;
  const { wsBase, app } = await startServer(t, { pairingNow: () => now });
  const alice = await identity(), bob = await identity();
  const a = await connect(t, wsBase, alice), b = await connect(t, wsBase, bob);
  const oldCode = b.registered.self.pairingCode;
  assert.equal((await pair(a.ws, oldCode)).peer.id, bob.deviceId);
  now = b.registered.self.pairingCodeExpiresAt;
  assert.equal((await pair(a.ws, oldCode)).peer, null);
  const rotated = waitFor(b.ws, m => m.type === 'pairing-code');
  app.rotatePairingCodes();
  const update = await rotated;
  assert.notEqual(update.code, oldCode);
  assert.equal(update.expiresAt, now + PAIRING_CODE_MAX_AGE_MS);
  assert.equal((await pair(a.ws, update.code)).peer.id, bob.deviceId);
  const reconnected = await connect(t, wsBase, alice);
  assert.equal(reconnected.registered.paired[0].id, bob.deviceId);
  assert.equal(reconnected.registered.paired[0].pairingCode, undefined);
});

test('fingerprint identities must prove possession on registration even without an allowlist', async t => {
  const { wsBase } = await startServer(t);
  const alice = await identity();
  const attacker = await openWs(wsBase);
  t.after(() => attacker.close());
  const rejected = waitFor(attacker, m => m.type === 'error' && m.context === 'register');
  attacker.send(JSON.stringify({ type: 'register', deviceId: alice.deviceId, identityKey: alice.identityKey }));
  assert.match((await rejected).message, /identity proof failed/);
});

test('pairing guesses have a separate budget from ordinary signaling traffic', async t => {
  const { wsBase } = await startServer(t);
  const alice = await identity(), bob = await identity();
  const a = await connect(t, wsBase, alice), b = await connect(t, wsBase, bob);
  for (let i = 0; i < 24; i++) assert.equal((await pair(a.ws, 'WRONG-CODE')).peer, null);
  assert.equal((await pair(a.ws, b.registered.self.pairingCode)).peer, null);
});

test('forgetting a pair revokes both server associations and prevents automatic reconnect approval', async t => {
  const { wsBase } = await startServer(t);
  const alice = await identity(), bob = await identity();
  const a = await connect(t, wsBase, alice), b = await connect(t, wsBase, bob);
  await pair(a.ws, b.registered.self.pairingCode);
  const removed = waitFor(a.ws, m => m.type === 'pairing-revoked' && m.deviceId === bob.deviceId);
  const notified = waitFor(b.ws, m => m.type === 'pairing-revoked' && m.deviceId === alice.deviceId);
  a.ws.send(JSON.stringify({ type: 'unpair-device', deviceId: bob.deviceId }));
  await removed; await notified;
  const again = await connect(t, wsBase, alice);
  assert.deepEqual(again.registered.paired, []);
});

test('a paired device that was offline during forgetting learns the revocation on reconnect', async t => {
  const { wsBase } = await startServer(t);
  const alice = await identity(), bob = await identity();
  const a = await connect(t, wsBase, alice), b = await connect(t, wsBase, bob);
  await pair(a.ws, b.registered.self.pairingCode);
  const closed = new Promise(resolve => b.ws.addEventListener('close', () => resolve(undefined), { once: true }));
  b.ws.close(); await closed;
  const removed = waitFor(a.ws, m => m.type === 'pairing-revoked');
  a.ws.send(JSON.stringify({ type: 'unpair-device', deviceId: bob.deviceId }));
  await removed;
  const again = await connect(t, wsBase, bob);
  assert.deepEqual(again.registered.paired, []);
  assert.deepEqual(again.registered.revoked, [alice.deviceId]);
});
