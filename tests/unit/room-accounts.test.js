import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, openWs, waitFor } from './helpers.js';
import { fingerprintOf, signTranscript, bytesToBase64 } from '../../app/public/identity.js';

test('room creation requires login, anonymous guests can join, and account-wide replacement destroys the oldest room', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-room-policy-'));
  const { base, wsBase, app } = await startServer(t, { accountsDb: path.join(dir, 'accounts.sqlite') });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const credentials = { username: 'room_owner', password: 'correct horse battery staple' };
  const registered = await fetch(`${base}/account/register`, { method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(credentials) });
  const cookie = registered.headers.get('set-cookie')?.split(';')[0] || '';
  /** @param {boolean} signedIn */
  async function device(signedIn) {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const id = await fingerprintOf(raw);
    const ws = await openWs(wsBase);
    t.after(() => ws.close());
    const challenge = (await waitFor(ws, m => m.type === 'registration-challenge')).challenge;
    const ready = waitFor(ws, m => m.type === 'registered');
    ws.send(JSON.stringify({ type: 'register', deviceId: id, identityKey: bytesToBase64(raw),
      registrationProof: await signTranscript(keys.privateKey, JSON.stringify(['evakage/register/1', challenge, id])) }));
    await ready;
    if (signedIn) {
      const response = await fetch(`${base}/account/connect`, { method: 'POST',
        headers: { origin: base, 'content-type': 'application/json', cookie }, body: JSON.stringify({ deviceId: id }) });
      const { token } = await response.json();
      const connected = waitFor(ws, m => m.type === 'account-peers' && m.signedIn);
      ws.send(JSON.stringify({ type: 'account-connect', token }));
      await connected;
    }
    return { id, ws };
  }
  /** @param {{ws: WebSocket}} device @param {string} name */
  async function create(device, name) {
    const joined = waitFor(device.ws, m => m.type === 'room-joined');
    device.ws.send(JSON.stringify({ type: 'create-room', name }));
    return joined;
  }
  const first = await device(true);
  const second = await device(true);
  const guest = await device(false);
  const denied = waitFor(guest.ws, m => m.type === 'error' && m.context === 'create-room');
  guest.ws.send(JSON.stringify({ type: 'create-room', name: 'Anonymous room' }));
  assert.match((await denied).message, /Log in to create a room/);
  assert.equal(app.rooms.size, 0);
  const oldest = (await create(first, 'First')).room;
  const joined = waitFor(guest.ws, m => m.type === 'room-joined');
  guest.ws.send(JSON.stringify({ type: 'join-room', code: oldest.code }));
  assert.equal((await joined).room.id, oldest.id);
  const newer = (await create(first, 'Second')).room;
  const buffered = await app.blobStore.offer({ senderId: first.id, conv: `room:${oldest.id}`, kind: 'message',
    bytes: 0, chunkSize: 1, totalChunks: 0, envelopes: { [guest.id]: { v: 1, ephemeral: 'e', iv: 'i', ciphertext: 'c' } } });
  assert.ok(buffered.blob);
  const creatorEnded = waitFor(first.ws, m => m.type === 'room-destroyed' && m.roomId === oldest.id);
  const guestEnded = waitFor(guest.ws, m => m.type === 'room-destroyed' && m.roomId === oldest.id);
  const third = await create(second, 'Third');
  await Promise.all([creatorEnded, guestEnded]);
  assert.equal(third.replacedRoomName, 'First');
  assert.equal(app.rooms.size, 2);
  assert.ok(app.rooms.has(newer.id));
  assert.ok(app.rooms.has(third.room.id));
  assert.ok(!app.rooms.has(oldest.id));
  assert.ok(!app.blobStore.blobs.has(buffered.blob.id));
  assert.ok((await app.blobStore.claim(buffered.blob.id, guest.id)).error);
  for (const request of [{ code: oldest.code }, { roomId: oldest.id, code: oldest.code, name: oldest.name, recreate: true }]) {
    const rejected = waitFor(guest.ws, m => m.type === 'error' && m.context === 'join-room');
    guest.ws.send(JSON.stringify({ type: 'join-room', ...request }));
    await rejected;
    assert.equal(app.rooms.size, 2);
  }
  const fourth = await create(first, 'Fourth');
  assert.equal(fourth.replacedRoomName, 'Second');
  assert.deepEqual([...app.rooms.values()].map(room => room.name), ['Third', 'Fourth']);
});
