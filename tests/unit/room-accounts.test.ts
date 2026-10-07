import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, openWs, waitFor } from './helpers.js';
import { fingerprintOf, signTranscript, bytesToBase64 } from '../../app/client/ts/identity.js';

/** A server with accounts, a signed-in owner account and a device factory. */
async function roomWorld(t: import('node:test').TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-room-policy-'));
  const { base, wsBase, app } = await startServer(t, {
    accountsDb: path.join(dir, 'accounts.sqlite'),
  });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const credentials = { username: 'room_owner', password: 'correct horse battery staple' };
  const registered = await fetch(`${base}/account/register`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  const cookie = registered.headers.get('set-cookie')?.split(';')[0] || '';

  async function device(signedIn: boolean) {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const id = await fingerprintOf(raw);
    const ws = await openWs(wsBase);
    t.after(() => ws.close());
    const challenge = (await waitFor(ws, (m) => m.type === 'registration-challenge')).challenge;
    const ready = waitFor(ws, (m) => m.type === 'registered');
    ws.send(
      JSON.stringify({
        type: 'register',
        deviceId: id,
        identityKey: bytesToBase64(raw),
        registrationProof: await signTranscript(
          keys.privateKey,
          JSON.stringify(['evakage/register/1', challenge, id]),
        ),
      }),
    );
    await ready;
    if (signedIn) {
      const response = await fetch(`${base}/account/connect`, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json', cookie },
        body: JSON.stringify({ deviceId: id }),
      });
      const { token } = await response.json();
      const connected = waitFor(ws, (m) => m.type === 'account-peers' && m.signedIn);
      ws.send(JSON.stringify({ type: 'account-connect', token }));
      await connected;
    }
    return { id, ws };
  }

  async function create(device: { ws: WebSocket }, name: string, access = 'protected') {
    const joined = waitFor(device.ws, (m) => m.type === 'room-joined');
    device.ws.send(JSON.stringify({ type: 'create-room', access, name }));
    return joined;
  }
  return { app, device, create };
}

test('room creation requires login, anonymous guests can join, and account-wide replacement destroys the oldest room', async (t) => {
  const { app, device, create } = await roomWorld(t);
  const first = await device(true);
  const second = await device(true);
  const guest = await device(false);
  const denied = waitFor(guest.ws, (m) => m.type === 'error' && m.context === 'create-room');
  guest.ws.send(JSON.stringify({ type: 'create-room', access: 'protected', name: 'Anonymous room' }));
  assert.match((await denied).message, /Log in to create a room/);
  assert.equal(app.rooms.size, 0);
  const oldest = (await create(first, 'First')).room;
  const joined = waitFor(guest.ws, (m) => m.type === 'room-joined');
  guest.ws.send(JSON.stringify({ type: 'join-room', code: oldest.code }));
  assert.equal((await joined).room.id, oldest.id);
  const newer = (await create(first, 'Second')).room;
  const buffered = await app.blobStore.offer({
    senderId: first.id,
    conv: `room:${oldest.id}`,
    kind: 'message',
    bytes: 0,
    chunkSize: 1,
    totalChunks: 0,
    envelopes: { [guest.id]: { v: 1, ephemeral: 'e', iv: 'i', ciphertext: 'c' } },
  });
  assert.ok(buffered.blob);
  const creatorEnded = waitFor(
    first.ws,
    (m) => m.type === 'room-destroyed' && m.roomId === oldest.id,
  );
  const guestEnded = waitFor(
    guest.ws,
    (m) => m.type === 'room-destroyed' && m.roomId === oldest.id,
  );
  const third = await create(second, 'Third');
  await Promise.all([creatorEnded, guestEnded]);
  assert.equal(third.replacedRoomName, 'First');
  assert.equal(app.rooms.size, 2);
  assert.ok(app.rooms.has(newer.id));
  assert.ok(app.rooms.has(third.room.id));
  assert.ok(!app.rooms.has(oldest.id));
  assert.ok(!app.blobStore.blobs.has(buffered.blob.id));
  assert.ok((await app.blobStore.claim(buffered.blob.id, guest.id)).error);
  for (const request of [
    { code: oldest.code },
    { roomId: oldest.id, code: oldest.code, name: oldest.name, recreate: true },
  ]) {
    const rejected = waitFor(guest.ws, (m) => m.type === 'error' && m.context === 'join-room');
    guest.ws.send(JSON.stringify({ type: 'join-room', ...request }));
    await rejected;
    assert.equal(app.rooms.size, 2);
  }
  const fourth = await create(first, 'Fourth');
  assert.equal(fourth.replacedRoomName, 'Second');
  assert.deepEqual(
    [...app.rooms.values()].map((room) => room.name),
    ['Third', 'Fourth'],
  );
});

test('private rooms wait for the creator, protected rooms admit by code, public rooms are listed without the code', async (t) => {
  const { device, create } = await roomWorld(t);
  const owner = await device(true);
  const guest = await device(false);
  const other = await device(false);
  const rooms = (ws: WebSocket, test: (rooms: any[]) => boolean) =>
    waitFor(ws, (m) => m.type === 'rooms' && test(m.rooms));

  // An omitted access setting is the safe default: private.
  const created = waitFor(owner.ws, (m) => m.type === 'room-joined');
  owner.ws.send(JSON.stringify({ type: 'create-room', name: 'Default' }));
  const room = (await created).room;
  assert.equal(room.access, 'private');
  assert.equal(room.owned, true);

  // A code join waits; the requester sees only the name, the creator sees who.
  const pending = waitFor(guest.ws, (m) => m.type === 'room-pending');
  const ownerSees = rooms(owner.ws, (list) => list[0]?.requests?.length === 1);
  const guestSees = rooms(guest.ws, (list) => list[0]?.awaiting === true);
  guest.ws.send(JSON.stringify({ type: 'join-room', code: room.code }));
  assert.equal((await pending).roomId, room.id);
  assert.equal((await ownerSees).rooms[0].requests[0].id, guest.id);
  const listing = (await guestSees).rooms[0];
  assert.equal(listing.code, undefined);
  assert.deepEqual(listing.members, []);

  // Only the creator's account may answer or change access.
  other.ws.send(JSON.stringify({ type: 'join-room', code: room.code }));
  await waitFor(other.ws, (m) => m.type === 'room-pending');
  guest.ws.send(JSON.stringify({ type: 'room-approve', roomId: room.id, deviceId: other.id, approve: true }));
  guest.ws.send(JSON.stringify({ type: 'room-access', roomId: room.id, access: 'public' }));

  const declined = waitFor(other.ws, (m) => m.type === 'error' && m.context === 'join-room');
  owner.ws.send(JSON.stringify({ type: 'room-approve', roomId: room.id, deviceId: other.id, approve: false }));
  assert.match((await declined).message, /declined/);
  const admitted = waitFor(guest.ws, (m) => m.type === 'room-joined');
  owner.ws.send(JSON.stringify({ type: 'room-approve', roomId: room.id, deviceId: guest.id, approve: true }));
  const seated = (await admitted).room;
  assert.equal(seated.code, room.code);
  assert.equal(seated.owned, undefined);
  assert.equal(seated.members.length, 2);

  // Switching off approval admits whoever is still waiting.
  other.ws.send(JSON.stringify({ type: 'join-room', code: room.code }));
  await waitFor(other.ws, (m) => m.type === 'room-pending');
  const opened = waitFor(other.ws, (m) => m.type === 'room-joined');
  owner.ws.send(JSON.stringify({ type: 'room-access', roomId: room.id, access: 'protected' }));
  assert.equal((await opened).room.id, room.id);

  // A protected room admits by code straight away.
  const protectedRoom = (await create(owner, 'Open door', 'protected')).room;
  const direct = waitFor(other.ws, (m) => m.type === 'room-joined' && m.room.id === protectedRoom.id);
  other.ws.send(JSON.stringify({ type: 'join-room', code: protectedRoom.code }));
  await direct;

  // A public room is listed to everyone, joinable without the code, and never shows it.
  const stranger = await device(false);
  const listed = rooms(stranger.ws, (list) =>
    list.some((r) => r.id === protectedRoom.id && r.access === 'public'),
  );
  owner.ws.send(JSON.stringify({ type: 'room-access', roomId: protectedRoom.id, access: 'public' }));
  const shown = (await listed).rooms.find((r: any) => r.id === protectedRoom.id);
  assert.equal(shown.code, undefined);
  assert.deepEqual(shown.members, []);
  assert.equal(shown.seats, 2);
  const joinedPublic = waitFor(stranger.ws, (m) => m.type === 'room-joined');
  stranger.ws.send(JSON.stringify({ type: 'join-room', roomId: protectedRoom.id }));
  assert.equal((await joinedPublic).room.code, protectedRoom.code);
});

test('a pending request ends when the requester cancels or disconnects', async (t) => {
  const { app, device, create } = await roomWorld(t);
  const owner = await device(true);
  const room = (await create(owner, 'Quiet', 'private')).room;
  const guest = await device(false);
  guest.ws.send(JSON.stringify({ type: 'join-room', code: room.code }));
  await waitFor(guest.ws, (m) => m.type === 'room-pending');
  const cancelled = waitFor(guest.ws, (m) => m.type === 'room-left' && m.roomId === room.id);
  guest.ws.send(JSON.stringify({ type: 'leave-room', roomId: room.id }));
  await cancelled;
  await waitFor(owner.ws, (m) => m.type === 'rooms' && !m.rooms[0].requests.length);
  assert.ok(app.rooms.has(room.id));

  guest.ws.send(JSON.stringify({ type: 'join-room', code: room.code }));
  await waitFor(owner.ws, (m) => m.type === 'rooms' && m.rooms[0].requests.length === 1);
  const gone = waitFor(owner.ws, (m) => m.type === 'rooms' && !m.rooms[0].requests.length);
  guest.ws.close();
  await gone;
});
