import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOf, bytesToBase64, signTranscript } from '../public/identity.js';
import { startServer, openWs, waitFor, register } from './helpers.js';

test('health, presence, stable codes, and code lookup work', async t => {
  const env = await startServer(t);
  const base = env.base;
  const wsBase = env.wsBase;

  const health = await fetch(`${base}/healthz`).then(r => r.json());
  assert.deepEqual(health, { ok: true, peers: 0, rooms: 0, bufferedTransfers: 0, bufferedMessages: 0, bufferedBytes: 0 });

  const config = await fetch(`${base}/config.json`).then(r => r.json());
  assert.deepEqual(config.iceServers, []);
  assert.equal(config.maxFileBytes, 536870912);
  assert.equal(config.maxRoomMembers, 20, 'rooms default to 20 devices');
  assert.equal(config.roomMeshMax, 6, 'and switch to the relay past 6');
  assert.equal(config.relay.enabled, true);
  assert.ok(config.relay.chunkSize > 0);

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
  assert.equal(lookup.peer.name, `Device ${bReg.self.code}`);
  assert.equal(lookup.peer.id, 'device_B_12345678');

  a.close();
  b.close();
});

test('rooms advertise membership, cap size, and close when their last member leaves', async t => {
  // A cap of 6 keeps the full-room case quick to reach.
  const { app, ...env } = await startServer(t, { maxRoomMembers: 6 });
  const wsBase = env.wsBase;

  const a = await register(wsBase, 'device_A_12345678', 'Laptop');
  const b = await register(wsBase, 'device_B_12345678', 'Phone');

  const created = waitFor(a, m => m.type === 'room-joined');
  a.send(JSON.stringify({ type: 'create-room', name: 'Kitchen table' }));
  const room = (await created).room;
  assert.equal(room.name, 'Kitchen table');
  assert.match(room.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(room.maxMembers, 6);
  assert.deepEqual(room.members.map((/** @type {any} */ m) => m.id), ['device_A_12345678']);

  // Rooms are advertised to every connected client, joined or not.
  const bSeesRoom = waitFor(b, m => m.type === 'rooms' && m.rooms.some((/** @type {any} */ r) => r.id === room.id));
  a.send(JSON.stringify({ type: 'rooms-request' }));
  await bSeesRoom;

  const bJoined = waitFor(b, m => m.type === 'room-joined');
  const aSeesTwo = waitFor(a, m => m.type === 'rooms' && m.rooms[0]?.members.length === 2);
  b.send(JSON.stringify({ type: 'join-room', code: room.code }));
  const joined = (await bJoined).room;
  await aSeesTwo;
  assert.deepEqual(joined.members.map((/** @type {any} */ m) => m.name).sort(), joined.members.map((/** @type {any} */ m) => `Device ${m.code}`).sort());

  // Sixth device is the last that fits; a seventh is refused.
  const extras = [];
  for (let i = 0; i < 4; i++) {
    const ws = await register(wsBase, `device_X${i}_12345678`, `Extra ${i}`);
    extras.push(ws);
    const ok = waitFor(ws, m => m.type === 'room-joined');
    ws.send(JSON.stringify({ type: 'join-room', roomId: room.id }));
    await ok;
  }
  const overflow = await register(wsBase, 'device_Z_12345678', 'Too many');
  const refused = waitFor(overflow, m => m.type === 'error' && m.context === 'join-room');
  overflow.send(JSON.stringify({ type: 'join-room', roomId: room.id }));
  assert.match((await refused).message, /limited to 6 devices/);
  assert.equal(app.rooms.get(room.id).members.size, 6);

  // Leaving drops membership but the room survives while anyone remains.
  const bLeft = waitFor(b, m => m.type === 'room-left');
  b.send(JSON.stringify({ type: 'leave-room', roomId: room.id }));
  await bLeft;
  assert.equal(app.rooms.get(room.id).members.size, 5);

  // The last participant leaving destroys it.
  const remaining = [a, ...extras];
  for (const ws of remaining) {
    const left = waitFor(ws, m => m.type === 'room-left');
    ws.send(JSON.stringify({ type: 'leave-room', roomId: room.id }));
    await left;
  }
  assert.equal(app.rooms.has(room.id), false);

  for (const ws of [a, b, overflow, ...extras]) ws.close();
});

test('one device cannot claim every room slot', async t => {
  const { app, ...env } = await startServer(t);
  const wsBase = env.wsBase;

  const hog = await register(wsBase, 'device_hog_12345678', 'Hog');
  for (let i = 0; i < 8; i++) {
    const created = waitFor(hog, m => m.type === 'room-joined');
    hog.send(JSON.stringify({ type: 'create-room', name: `Room ${i}` }));
    await created;
  }
  const refused = waitFor(hog, m => m.type === 'error' && m.context === 'create-room');
  hog.send(JSON.stringify({ type: 'create-room', name: 'One too many' }));
  assert.match((await refused).message, /8 rooms at a time/);
  assert.equal(app.rooms.size, 8);

  // Another device is unaffected.
  const other = await register(wsBase, 'device_other_1234567', 'Other');
  const ok = waitFor(other, m => m.type === 'room-joined');
  other.send(JSON.stringify({ type: 'create-room', name: 'Mine' }));
  await ok;
  assert.equal(app.rooms.size, 9);

  hog.close();
  other.close();
});

test('rooms past the mesh size switch to the relay, up to the configured cap', async t => {
  const { wsBase } = await startServer(t, { maxRoomMembers: 8 });
  const owner = await register(wsBase, 'device_large_owner0', 'Owner');
  const created = waitFor(owner, m => m.type === 'room-joined');
  owner.send(JSON.stringify({ type: 'create-room', name: 'Big' }));
  const room = (await created).room;
  assert.equal(room.maxMembers, 8);
  assert.equal(room.transport, 'mesh', 'a small room is a direct mesh');

  const members = [];
  let last;
  for (let i = 1; i < 8; i++) {
    const ws = await register(wsBase, `device_large_mem00${i}`, `M${i}`);
    const joined = waitFor(ws, m => m.type === 'room-joined');
    ws.send(JSON.stringify({ type: 'join-room', roomId: room.id }));
    last = (await joined).room;
    members.push(ws);
    // Six seats is still a mesh; the seventh tips it over.
    assert.equal(last.transport, i + 1 > 6 ? 'relay' : 'mesh', `at ${i + 1} members`);
  }
  assert.equal(last.members.length, 8);

  const ninth = await register(wsBase, 'device_large_nine00', 'Ninth');
  const refused = waitFor(ninth, m => m.type === 'error' && m.context === 'join-room');
  ninth.send(JSON.stringify({ type: 'join-room', roomId: room.id }));
  assert.match((await refused).message, /limited to 8 devices/);

  for (const ws of [owner, ninth, ...members]) ws.close();
});

test('the room cap is clamped to a sane range', async t => {
  for (const [asked, expected] of [[1, 2], [500, 64], [Number.NaN, 20]]) {
    const { base } = await startServer(t, { maxRoomMembers: asked });
    const config = await fetch(`${base}/config.json`).then(r => r.json());
    assert.equal(config.maxRoomMembers, expected, `asked for ${asked}`);
  }
});

test('device names ignore supplied names and reject rename requests', async t => {
  const { wsBase } = await startServer(t);
  const ws = await openWs(wsBase);
  t.after(() => ws.close());
  const payload = { type: 'register', deviceId: 'device_fixed_12345678', name: 'Trusted administrator' };
  const registered = waitFor(ws, m => m.type === 'registered');
  ws.send(JSON.stringify(payload));
  const { self } = await registered;
  assert.equal(self.name, `Device ${self.code}`);

  const rejected = waitFor(ws, m => m.type === 'error' && m.context === 'rename');
  ws.send(JSON.stringify({ type: 'rename', name: 'Support' }));
  await rejected;
  const presence = waitFor(ws, m => m.type === 'presence');
  ws.send(JSON.stringify({ type: 'presence-request' }));
  assert.equal((await presence).peers[0].name, self.name);

  const reregistered = waitFor(ws, m => m.type === 'registered');
  ws.send(JSON.stringify({ ...payload, name: 'Someone else' }));
  assert.equal((await reregistered).self.name, self.name);
});

test('allowlist requires possession of the identity key and a fresh socket challenge', async t => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const id = await fingerprintOf(raw);
  const { wsBase } = await startServer(t, { allowedDevices: [id] });
  const ws = await openWs(wsBase);
  t.after(() => ws.close());
  const challenge = (await waitFor(ws, m => m.type === 'registration-challenge')).challenge;
  const proof = await signTranscript(keys.privateKey, JSON.stringify(['aria-drop/register/1', challenge, id]));
  const registered = waitFor(ws, m => m.type === 'registered');
  ws.send(JSON.stringify({ type: 'register', deviceId: id, identityKey: bytesToBase64(raw), registrationProof: proof }));
  assert.equal((await registered).self.id, id);

  for (const payload of [
    { deviceId: id, identityKey: bytesToBase64(raw), registrationProof: proof },
    { deviceId: id, identityKey: bytesToBase64(raw) },
    { deviceId: 'x'.repeat(43), identityKey: bytesToBase64(raw), registrationProof: proof }
  ]) {
    const attacker = await openWs(wsBase);
    const rejected = waitFor(attacker, m => m.type === 'error' && m.context === 'register');
    attacker.send(JSON.stringify({ type: 'register', ...payload }));
    assert.match((await rejected).message, /not authorized/);
    attacker.close();
  }
});
