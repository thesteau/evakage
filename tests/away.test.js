// Devices that drop off without leaving: remembered devices can still be sent
// to, and room members keep their seat as "away" until they rejoin, reload, or
// the window runs out.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, waitFor, register } from './helpers.js';

const BOX = { v: 1, ephemeral: 'e', iv: 'i', ciphertext: 'c' };
const KEYS = { identityKey: 'identity-key-b64', sealKey: 'seal-key-b64', sealKeySignature: 'sig-b64' };
const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));

async function createRoom(ws, name = 'Room') {
  const created = waitFor(ws, m => m.type === 'room-joined');
  ws.send(JSON.stringify({ type: 'create-room', name }));
  return (await created).room;
}

async function joinRoom(ws, roomId) {
  const joined = waitFor(ws, m => m.type === 'room-joined');
  ws.send(JSON.stringify({ type: 'join-room', roomId }));
  return (await joined).room;
}

async function sendMessage(ws, to, conv = 'direct') {
  const requestId = crypto.randomUUID();
  const reply = waitFor(ws, m => m.requestId === requestId);
  ws.send(JSON.stringify({
    type: 'blob-offer', requestId, kind: 'message', conv,
    bytes: 0, chunkSize: 1, totalChunks: 0,
    envelopes: Object.fromEntries([].concat(to).map(id => [id, BOX]))
  }));
  return reply;
}

async function lookup(ws, deviceIds) {
  const requestId = crypto.randomUUID();
  const reply = waitFor(ws, m => m.type === 'devices-found' && m.requestId === requestId);
  ws.send(JSON.stringify({ type: 'lookup-devices', requestId, deviceIds }));
  return (await reply).devices;
}

/* ---------- offline devices ---------- */

test('a device that went offline can still be looked up and sent to', async t => {
  const { wsBase } = await startServer(t);
  const a = await register(wsBase, 'device_alice_00001', 'Alice');
  const b = await register(wsBase, 'device_bob_0000001', 'Bob', KEYS);

  b.close();
  await settle();

  // The signed key record survives the disconnect, so B can still be sealed to.
  const [record] = await lookup(a, ['device_bob_0000001']);
  assert.equal(record.id, 'device_bob_0000001');
  assert.equal(record.online, false);
  assert.equal(record.name, 'Bob');
  assert.equal(record.sealKey, KEYS.sealKey);
  assert.equal(record.sealKeySignature, KEYS.sealKeySignature);
  assert.equal(record.identityKey, KEYS.identityKey);
  assert.ok(record.lastSeen > Date.now() - 5000);

  // And the server accepts a direct send to it.
  const sent = await sendMessage(a, 'device_bob_0000001');
  assert.equal(sent.type, 'blob-offered');

  // A device the server has never seen cannot be addressed.
  assert.deepEqual(await lookup(a, ['device_never_seen_01']), []);
  const refused = await sendMessage(a, 'device_never_seen_01');
  assert.equal(refused.type, 'error');

  a.close();
});

test('the message waits for the offline device and arrives when it reconnects', async t => {
  const { wsBase } = await startServer(t);
  const a = await register(wsBase, 'device_alice_00002', 'Alice');
  const b = await register(wsBase, 'device_bob_0000002', 'Bob', KEYS);
  b.close();
  await settle();

  const sent = await sendMessage(a, 'device_bob_0000002');
  a.close(); // the sender can go too; the item waits on the server
  await settle();

  const back = new WebSocket(wsBase);
  await new Promise(resolve => back.addEventListener('open', resolve, { once: true }));
  const delivered = waitFor(back, m => m.type === 'blob-available');
  back.send(JSON.stringify({ type: 'register', deviceId: 'device_bob_0000002', name: 'Bob', ...KEYS }));
  assert.equal((await delivered).blobId, sent.blobId);
  back.close();
});

test('a device not seen within the window can no longer be sent to', async t => {
  const { app, wsBase } = await startServer(t);
  const a = await register(wsBase, 'device_alice_00003', 'Alice');
  const b = await register(wsBase, 'device_bob_0000003', 'Bob', KEYS);
  b.close();
  await settle();

  app.recentDevices.get('device_bob_0000003').lastSeen = Date.now() - (24 * 60 * 60 * 1000 + 1000);
  assert.deepEqual(await lookup(a, ['device_bob_0000003']), [], 'stale record is not served');
  assert.equal((await sendMessage(a, 'device_bob_0000003')).type, 'error');

  // The sweep also forgets it entirely.
  app.expireAway();
  assert.equal(app.recentDevices.has('device_bob_0000003'), false);
  a.close();
});

/* ---------- rooms ---------- */

test('a member who drops off keeps its seat as away, and the room survives', async t => {
  const { app, wsBase } = await startServer(t);
  const a = await register(wsBase, 'device_alice_00004', 'Alice');
  const b = await register(wsBase, 'device_bob_0000004', 'Bob', KEYS);
  const room = await createRoom(a, 'Kitchen');
  await joinRoom(b, room.id);

  const aSeesAway = waitFor(a, m => m.type === 'rooms' && m.rooms[0]?.away.length === 1);
  b.close();
  const update = (await aSeesAway).rooms[0];
  assert.deepEqual(update.members.map(m => m.id), ['device_alice_00004']);
  assert.equal(update.away[0].id, 'device_bob_0000004');
  assert.equal(update.away[0].sealKey, KEYS.sealKey, 'away members carry their key record, so senders can seal to them');
  assert.ok(update.away[0].awaySince > 0);

  // Everyone gone: the room is dormant, not deleted.
  a.close();
  await settle();
  assert.equal(app.rooms.has(room.id), true);
  assert.equal(app.rooms.get(room.id).away.size, 2);
});

test('a room message can be addressed to an away member, who gets it on rejoining', async t => {
  const { wsBase } = await startServer(t);
  const a = await register(wsBase, 'device_alice_00005', 'Alice');
  const b = await register(wsBase, 'device_bob_0000005', 'Bob', KEYS);
  const room = await createRoom(a);
  await joinRoom(b, room.id);
  b.close();
  await settle();

  const sent = await sendMessage(a, 'device_bob_0000005', `room:${room.id}`);
  assert.equal(sent.type, 'blob-offered', 'an away member is a valid room recipient');

  const back = new WebSocket(wsBase);
  await new Promise(resolve => back.addEventListener('open', resolve, { once: true }));
  const delivered = waitFor(back, m => m.type === 'blob-available');
  back.send(JSON.stringify({ type: 'register', deviceId: 'device_bob_0000005', name: 'Bob', ...KEYS }));
  assert.equal((await delivered).blobId, sent.blobId);

  // Rejoining turns the away seat back into membership.
  const rejoined = await joinRoom(back, room.id);
  assert.deepEqual(rejoined.members.map(m => m.id).sort(), ['device_alice_00005', 'device_bob_0000005']);
  assert.equal(rejoined.away.length, 0);

  a.close();
  back.close();
});

test('an away seat is held in a full room and only its owner can reclaim it', async t => {
  const { wsBase } = await startServer(t, { maxRoomMembers: 6 });
  const owner = await register(wsBase, 'device_owner_00006', 'Owner');
  const room = await createRoom(owner);
  const members = [];
  for (let i = 0; i < 5; i++) {
    const ws = await register(wsBase, `device_member_0006${i}`, `M${i}`);
    await joinRoom(ws, room.id);
    members.push(ws);
  }
  members[0].close(); // now 5 connected + 1 away = 6 seats
  await settle();

  const outsider = await register(wsBase, 'device_outsider_006', 'Outsider');
  const refused = waitFor(outsider, m => m.type === 'error' && m.context === 'join-room');
  outsider.send(JSON.stringify({ type: 'join-room', roomId: room.id }));
  assert.match((await refused).message, /limited to 6 devices/);

  const returning = await register(wsBase, 'device_member_00060', 'M0');
  const back = await joinRoom(returning, room.id);
  assert.equal(back.members.length, 6);

  for (const ws of [owner, outsider, returning, ...members.slice(1)]) ws.close();
});

test('a device that reconnects but does not rejoin (a reload) loses its away seat', async t => {
  const { app, wsBase } = await startServer(t, { rejoinGraceMs: 150 });
  const a = await register(wsBase, 'device_alice_00007', 'Alice');
  const b = await register(wsBase, 'device_bob_0000007', 'Bob');
  const room = await createRoom(a);
  await joinRoom(b, room.id);
  b.close();
  await settle();
  assert.equal(app.rooms.get(room.id).away.has('device_bob_0000007'), true);

  // B comes back as a fresh page: registers, never rejoins the room.
  const reloaded = await register(wsBase, 'device_bob_0000007', 'Bob');
  await settle(400);
  assert.equal(app.rooms.get(room.id).away.has('device_bob_0000007'), false);
  assert.equal(app.rooms.get(room.id).members.has('device_bob_0000007'), false);

  a.close();
  reloaded.close();
});

test('an explicit leave gives the seat up rather than going away', async t => {
  const { app, wsBase } = await startServer(t);
  const a = await register(wsBase, 'device_alice_00008', 'Alice');
  const b = await register(wsBase, 'device_bob_0000008', 'Bob');
  const room = await createRoom(a);
  await joinRoom(b, room.id);

  const left = waitFor(b, m => m.type === 'room-left');
  b.send(JSON.stringify({ type: 'leave-room', roomId: room.id }));
  await left;
  b.close();
  await settle();
  assert.equal(app.rooms.get(room.id).away.has('device_bob_0000008'), false);
  assert.equal((await sendMessage(a, 'device_bob_0000008', `room:${room.id}`)).type, 'error');
  a.close();
});

test('away seats expire with the window, and a room with no seats left closes', async t => {
  const { app, wsBase } = await startServer(t);
  const a = await register(wsBase, 'device_alice_00009', 'Alice');
  const room = await createRoom(a, 'Short-lived');
  a.close();
  await settle();
  assert.equal(app.rooms.has(room.id), true, 'dormant while the seat is held');

  app.rooms.get(room.id).away.set('device_alice_00009', Date.now() - (24 * 60 * 60 * 1000 + 1000));
  app.expireAway();
  assert.equal(app.rooms.has(room.id), false);

  // A browser that still holds the room can restore it with the same id and
  // code; without asking to, a vanished room stays gone.
  const back = await register(wsBase, 'device_alice_00009', 'Alice');
  const restored = waitFor(back, m => m.type === 'room-joined');
  back.send(JSON.stringify({ type: 'join-room', roomId: room.id, recreate: true, name: 'Short-lived', code: room.code }));
  const again = (await restored).room;
  assert.equal(again.id, room.id);
  assert.equal(again.code, room.code);

  const refused = waitFor(back, m => m.type === 'error' && m.context === 'join-room');
  back.send(JSON.stringify({ type: 'join-room', roomId: '11111111-2222-3333-4444-555555555555' }));
  assert.match((await refused).message, /no longer active/);
  back.close();
});

test('a dormant room is kept for its away members but hidden from everyone else', async t => {
  const { app, wsBase } = await startServer(t);
  const a = await register(wsBase, 'device_alice_00010', 'Alice');
  const room = await createRoom(a, 'Everyone left');
  a.close();
  await settle();
  assert.equal(app.rooms.has(room.id), true, 'kept, so Alice can come back to it');

  // A newcomer does not see it and cannot walk into it.
  const outsider = new WebSocket(wsBase);
  await new Promise(resolve => outsider.addEventListener('open', resolve, { once: true }));
  const listing = waitFor(outsider, m => m.type === 'rooms');
  outsider.send(JSON.stringify({ type: 'register', deviceId: 'device_outsider_010', name: 'Outsider' }));
  assert.deepEqual((await listing).rooms, [], 'a room nobody is connected to is not advertised');
  const refused = waitFor(outsider, m => m.type === 'error' && m.context === 'join-room');
  outsider.send(JSON.stringify({ type: 'join-room', roomId: room.id }));
  assert.match((await refused).message, /no longer active/);
  const byCode = waitFor(outsider, m => m.type === 'error' && m.context === 'join-room');
  outsider.send(JSON.stringify({ type: 'join-room', code: room.code }));
  assert.match((await byCode).message, /no longer active/);

  // Alice, returning, reclaims it and it is listed again.
  const back = await register(wsBase, 'device_alice_00010', 'Alice');
  const rejoined = await joinRoom(back, room.id);
  assert.equal(rejoined.id, room.id);
  const relisted = waitFor(outsider, m => m.type === 'rooms' && m.rooms.some(r => r.id === room.id));
  back.send(JSON.stringify({ type: 'rooms-request' }));
  outsider.send(JSON.stringify({ type: 'rooms-request' }));
  await relisted;

  outsider.close();
  back.close();
});
