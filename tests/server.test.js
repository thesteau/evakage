import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(config.maxRoomMembers, 6);
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
  assert.equal(lookup.peer.name, 'Phone');
  assert.equal(lookup.peer.id, 'device_B_12345678');

  a.close();
  b.close();
});

test('rooms advertise membership, cap size, and close when their last member leaves', async t => {
  const { app, ...env } = await startServer(t);
  const wsBase = env.wsBase;

  const a = await register(wsBase, 'device_A_12345678', 'Laptop');
  const b = await register(wsBase, 'device_B_12345678', 'Phone');

  const created = waitFor(a, m => m.type === 'room-joined');
  a.send(JSON.stringify({ type: 'create-room', name: 'Kitchen table' }));
  const room = (await created).room;
  assert.equal(room.name, 'Kitchen table');
  assert.match(room.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(room.maxMembers, 6);
  assert.deepEqual(room.members.map(m => m.id), ['device_A_12345678']);

  // Rooms are advertised to every connected client, joined or not.
  const bSeesRoom = waitFor(b, m => m.type === 'rooms' && m.rooms.some(r => r.id === room.id));
  a.send(JSON.stringify({ type: 'rooms-request' }));
  await bSeesRoom;

  const bJoined = waitFor(b, m => m.type === 'room-joined');
  const aSeesTwo = waitFor(a, m => m.type === 'rooms' && m.rooms[0]?.members.length === 2);
  b.send(JSON.stringify({ type: 'join-room', code: room.code }));
  const joined = (await bJoined).room;
  await aSeesTwo;
  assert.deepEqual(joined.members.map(m => m.name).sort(), ['Laptop', 'Phone']);

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
