// The server relay's lifecycle, against a live server. Envelopes are opaque to
// the server, so well-shaped placeholders are enough here; the crypto inside
// them is covered by relay.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { startServer, waitFor, register } from './helpers.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BOX = { v: 1, ephemeral: 'e', iv: 'i', ciphertext: 'c' };
const CHUNK = 1024;
const DAY = 24 * 60 * 60 * 1000;

// Ciphertext length for a plaintext of `plain` bytes, matching relay.js.
/** @param {number} plain */
function layout(plain) {
  const totalChunks = Math.ceil(plain / CHUNK);
  return { totalChunks, bytes: plain + totalChunks * 28 };
}

/** Conversation directories, and every item file inside them. */
/** @param {string} dir */
async function onDisk(dir) {
  const directories = [];
  const files = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    directories.push(entry.name);
    for (const name of await fsp.readdir(path.join(dir, entry.name)).catch(() => [])) {
      files.push(path.join(entry.name, name));
    }
  }
  return { directories, files };
}

/** @param {WebSocket} ws @param {string | string[]} to @param {number} plain
 * @param {{conv?: string, kind?: 'file' | 'message'}} [options] */
async function offer(ws, to, plain, { conv = 'direct', kind = 'file' } = {}) {
  const { totalChunks, bytes } = kind === 'message' ? { totalChunks: 0, bytes: 0 } : layout(plain);
  const requestId = crypto.randomUUID();
  const reply = waitFor(ws, m => m.requestId === requestId);
  ws.send(JSON.stringify({
    type: 'blob-offer',
    requestId,
    kind,
    conv,
    bytes,
    chunkSize: CHUNK,
    totalChunks,
    envelopes: Object.fromEntries([to].flat().map(id => [id, BOX]))
  }));
  return { reply: await reply, bytes };
}

/** @param {string} base @param {string} blobId @param {string} token @param {BodyInit} body */
const upload = (base, blobId, token, body) =>
  fetch(`${base}/blob/${blobId}?token=${encodeURIComponent(token)}`, { method: 'PUT', body });

const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));

test('relay access expires at the deadline before the physical sweep', async t => {
  let now = 1000;
  const { app, base, wsBase, dir } = await startServer(t, { blobs: { now: () => now, maxAgeMs: 1000 } });
  const a = await register(wsBase, 'device_exp_sender', 'A');
  const b = await register(wsBase, 'device_exp_recver', 'B');
  const { reply, bytes } = await offer(a, 'device_exp_recver', 100);
  assert.equal((await upload(base, reply.blobId, reply.uploadToken, Buffer.alloc(bytes))).status, 204);
  const message = await offer(a, 'device_exp_recver', 0, { kind: 'message' });
  const incomplete = await offer(a, 'device_exp_recver', 100);
  now = 1999;
  const claim = await app.blobStore.claim(reply.blobId, 'device_exp_recver');
  assert.ok(claim.downloadToken);
  assert.equal((await app.blobStore.pendingFor('device_exp_recver')).length, 2);
  assert.equal(app.blobStore.openForDownload(reply.blobId, claim.downloadToken).status, 200);
  now = 2000;
  assert.deepEqual(await app.blobStore.pendingFor('device_exp_recver'), []);
  assert.ok((await app.blobStore.claim(reply.blobId, 'device_exp_recver')).error);
  assert.ok((await app.blobStore.claim(message.reply.blobId, 'device_exp_recver')).error);
  assert.equal((await fetch(`${base}/blob/${reply.blobId}?token=${claim.downloadToken}`)).status, 404);
  assert.equal((await upload(base, incomplete.reply.blobId, incomplete.reply.uploadToken, Buffer.alloc(incomplete.bytes))).status, 404);
  assert.ok((await onDisk(dir)).files.length, 'disk cleanup is separate from access expiry');
  assert.equal((await app.blobStore.sweepAged()).length, 3);
  assert.deepEqual(await onDisk(dir), { directories: [], files: [] });
  a.close();
  b.close();
});

test('an upload crossing the expiry deadline is not published', async t => {
  let now = 1000;
  const { app } = await startServer(t, { blobs: { now: () => now, maxAgeMs: 1000 } });
  const result = await app.blobStore.offer({ senderId: 'sender', conv: 'direct',
    bytes: 128, chunkSize: 100, totalChunks: 1, envelopes: { recipient: BOX } });
  assert.ok(result.blob);
  let published = false;
  app.blobStore.onAvailable = () => { published = true; };
  const request = new PassThrough();
  const receiving = app.blobStore.receive(result.blob.id, result.blob.uploadToken, request);
  request.write(Buffer.alloc(64));
  now = 2000;
  request.end(Buffer.alloc(64));
  assert.equal((await receiving).status, 410);
  assert.equal(published, false);
  assert.equal(app.blobStore.blobs.has(result.blob.id), false);
});

test('offer, upload, notify, claim, download, release — and the directory goes with it', async t => {
  const { base, wsBase, dir } = await startServer(t);
  const a = await register(wsBase, 'device_sender_0001', 'A');
  const b = await register(wsBase, 'device_recver_0001', 'B');

  const { reply, bytes } = await offer(a, 'device_recver_0001', 5000);
  assert.equal(reply.type, 'blob-offered');
  const body = crypto.randomBytes(bytes);

  const available = waitFor(b, m => m.type === 'blob-available');
  assert.equal((await upload(base, reply.blobId, reply.uploadToken, body)).status, 204);

  const notice = await available;
  assert.equal(notice.blobId, reply.blobId);
  assert.equal(notice.kind, 'file');
  assert.equal(notice.from, 'device_sender_0001', 'the sender id comes from the server, not the uploader');
  assert.deepEqual(notice.envelope, BOX);

  const stored = await onDisk(dir);
  assert.equal(stored.directories.length, 1, 'one directory for the conversation');
  assert.equal(stored.files.length, 2, 'body and envelopes');

  const claimed = waitFor(b, m => m.type === 'blob-claimed');
  b.send(JSON.stringify({ type: 'blob-claim', blobId: reply.blobId }));
  const claim = await claimed;

  const got = await fetch(`${base}/blob/${reply.blobId}?token=${encodeURIComponent(claim.downloadToken)}`);
  assert.equal(got.status, 200);
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(body), 'downloaded bytes must match exactly');

  // The last recipient taking its copy removes the item, and the now-empty
  // conversation directory with it.
  b.send(JSON.stringify({ type: 'blob-release', blobId: reply.blobId }));
  await settle();
  assert.deepEqual(await onDisk(dir), { directories: [], files: [] });

  a.close();
  b.close();
});

test('an item outlives both devices disconnecting and is delivered when one comes back', async t => {
  const { base, wsBase, dir, app } = await startServer(t);
  const a = await register(wsBase, 'device_sender_0002', 'A');
  const b = await register(wsBase, 'device_recver_0002', 'B');

  const { reply, bytes } = await offer(a, 'device_recver_0002', 2000);
  assert.equal((await upload(base, reply.blobId, reply.uploadToken, crypto.randomBytes(bytes))).status, 204);
  const message = await offer(a, 'device_recver_0002', 0, { kind: 'message' });

  // B drops before taking either item, then A leaves too: nobody is connected.
  b.close();
  await settle();
  a.close();
  await settle();
  assert.equal(app.blobStore.blobs.has(reply.blobId), true, 'the file must dangle, not be deleted');
  assert.equal(app.blobStore.blobs.has(message.reply.blobId), true, 'the message must dangle, not be deleted');
  assert.equal((await onDisk(dir)).files.length, 3);

  // B returns within the window: both arrive on registration, oldest first.
  const back = new WebSocket(wsBase);
  await new Promise(resolve => back.addEventListener('open', resolve, { once: true }));
  /** @type {any[]} */
  const seen = [];
  const bothArrived = new Promise(resolve => {
    back.addEventListener('message', event => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === 'blob-available') seen.push(msg);
      if (seen.length === 2) resolve(undefined);
    });
  });
  back.send(JSON.stringify({ type: 'register', deviceId: 'device_recver_0002', name: 'B' }));
  await bothArrived;
  assert.deepEqual(seen.map(item => item.kind), ['file', 'message']);

  back.close();
});

test('the sweep keeps items while their session is live and removes them once it ends', async t => {
  // A short grace so the end of a session can be observed without waiting.
  const { base, wsBase, dir, app } = await startServer(t, { blobs: { idleGraceMs: 40 } });
  const a = await register(wsBase, 'device_sender_0003', 'A');
  const b = await register(wsBase, 'device_recver_0003', 'B');
  await register(wsBase, 'device_third_00003', 'C');

  const first = await offer(a, 'device_recver_0003', 100);
  const second = await offer(a, 'device_recver_0003', 100);
  for (const item of [first, second]) {
    assert.equal((await upload(base, item.reply.blobId, item.reply.uploadToken, crypto.randomBytes(item.bytes))).status, 204);
  }
  // A second conversation, with a device that stays connected throughout.
  const withC = await offer(a, 'device_third_00003', 0, { kind: 'message' });
  assert.equal((await onDisk(dir)).directories.length, 2);

  // Age alone means nothing: a day-old item whose session is still live stays.
  for (const id of [first.reply.blobId, withC.reply.blobId]) {
    const record = app.blobStore.blobs.get(id);
    assert.ok(record);
    record.createdAt = Date.now() - (DAY + 1000);
  }
  assert.deepEqual(await app.blobStore.sweepAged(), [], 'a day-old item survives while its session is live');

  // End the A-B session. C stays, so the conversation it is party to does not.
  a.close();
  b.close();
  for (let i = 0; i < 40 && app.clients.size !== 1; i++) await settle(25);
  assert.equal(app.clients.size, 1, 'only C should still be connected');
  await settle(60); // past the 40ms grace

  const purged = await app.blobStore.sweepAged();
  assert.deepEqual(purged.sort(), [first.reply.blobId, second.reply.blobId].sort());
  assert.equal(app.blobStore.blobs.has(withC.reply.blobId), true, 'an item whose session still has someone in it survives');

  const after = await onDisk(dir);
  assert.equal(after.directories.length, 1, 'the conversation whose session ended is gone entirely');

  // A stray empty directory is removed by the sweep too, whatever emptied it.
  await fsp.mkdir(path.join(dir, 'd-empty-leftover'));
  await app.blobStore.sweepAged();
  assert.equal((await onDisk(dir)).directories.includes('d-empty-leftover'), false);
});

test('a half-open direct session expires on its own clock; a room with one member does not', async t => {
  // soloMaxMs is what a 1:1 conversation gets when only one device is present.
  const { wsBase, app } = await startServer(t, { blobs: { soloMaxMs: 60, idleGraceMs: 60_000 } });
  const a = await register(wsBase, 'device_solo_aaaa01', 'A');
  const b = await register(wsBase, 'device_solo_bbbb01', 'B');

  const created = waitFor(a, m => m.type === 'room-joined');
  a.send(JSON.stringify({ type: 'create-room', name: 'Room' }));
  const room = (await created).room;
  const bJoined = waitFor(b, m => m.type === 'room-joined');
  b.send(JSON.stringify({ type: 'join-room', roomId: room.id }));
  await bJoined;

  const direct = await offer(a, 'device_solo_bbbb01', 0, { kind: 'message' });
  const inRoom = await offer(a, ['device_solo_bbbb01'], 0, { kind: 'message', conv: `room:${room.id}` });

  // B leaves. A is still here, so neither item is idle — but the direct
  // conversation is now half-open, and only that one is on a clock.
  b.close();
  for (let i = 0; i < 40 && app.clients.size !== 1; i++) await settle(25);
  app.blobStore.refreshLiveness();

  const directRecord = app.blobStore.blobs.get(direct.reply.blobId);
  const roomRecord = app.blobStore.blobs.get(inRoom.reply.blobId);
  assert.ok(directRecord && roomRecord);
  assert.equal(directRecord.idleSince, null, 'A is still connected, so nothing is idle');
  assert.notEqual(directRecord.soloSince, null, 'the direct conversation is half-open');
  assert.equal(roomRecord.soloSince, null, 'a room is exempt from the half-open clock');

  await settle(80); // past soloMaxMs
  const purged = await app.blobStore.sweepAged();
  assert.deepEqual(purged, [direct.reply.blobId]);
  assert.equal(app.blobStore.blobs.has(inRoom.reply.blobId), true, 'the room item is untouched');

  a.close();
});

test('an item carries the moment it expires, so a recipient can count down to it', async t => {
  const { wsBase, app } = await startServer(t);
  const a = await register(wsBase, 'device_when_aaaa01', 'A');
  const b = await register(wsBase, 'device_when_bbbb01', 'B');

  const available = waitFor(b, m => m.type === 'blob-available');
  const item = await offer(a, 'device_when_bbbb01', 0, { kind: 'message' });
  const notice = await available;

  assert.equal(notice.blobId, item.reply.blobId);
  assert.equal(typeof notice.expiresAt, 'number');
  // Both devices are here, so only the absolute cap applies.
  const record = app.blobStore.blobs.get(item.reply.blobId);
  assert.ok(record);
  assert.equal(notice.expiresAt, record.createdAt + app.blobStore.config.maxAgeMs);

  for (const ws of [a, b]) ws.close();
});

test('the same two devices share one directory whichever sends; others get their own', async t => {
  const { wsBase, dir, app } = await startServer(t);
  const a = await register(wsBase, 'device_pair_aaaa01', 'A');
  const b = await register(wsBase, 'device_pair_bbbb01', 'B');
  const c = await register(wsBase, 'device_pair_cccc01', 'C');

  const ab = await offer(a, 'device_pair_bbbb01', 0, { kind: 'message' });
  const ba = await offer(b, 'device_pair_aaaa01', 0, { kind: 'message' });
  const ac = await offer(a, 'device_pair_cccc01', 0, { kind: 'message' });

  /** @param {string} id */
  const dirOf = id => {
    const record = app.blobStore.blobs.get(id);
    assert.ok(record);
    return record.convDir;
  };
  assert.equal(dirOf(ab.reply.blobId), dirOf(ba.reply.blobId), 'A->B and B->A are one conversation');
  assert.notEqual(dirOf(ab.reply.blobId), dirOf(ac.reply.blobId), 'A->C is a different conversation');

  // A room gets its own directory, distinct from any pair within it.
  const created = waitFor(a, m => m.type === 'room-joined');
  a.send(JSON.stringify({ type: 'create-room', name: 'R' }));
  const room = (await created).room;
  const bJoined = waitFor(b, m => m.type === 'room-joined');
  b.send(JSON.stringify({ type: 'join-room', roomId: room.id }));
  await bJoined;
  const inRoom = await offer(a, 'device_pair_bbbb01', 0, { kind: 'message', conv: `room:${room.id}` });
  assert.notEqual(dirOf(inRoom.reply.blobId), dirOf(ab.reply.blobId));

  assert.equal((await onDisk(dir)).directories.length, 3);
  for (const ws of [a, b, c]) ws.close();
});

test('a relayed message is delivered on arrival with no upload, and cannot be downloaded as a file', async t => {
  const { base, wsBase, dir } = await startServer(t);
  const a = await register(wsBase, 'device_sender_0005', 'A');
  const b = await register(wsBase, 'device_recver_0005', 'B');

  const available = waitFor(b, m => m.type === 'blob-available');
  const { reply } = await offer(a, 'device_recver_0005', 0, { kind: 'message' });
  assert.equal(reply.type, 'blob-offered');
  assert.equal(reply.uploadToken, undefined, 'a message has nothing to upload');

  const notice = await available;
  assert.equal(notice.kind, 'message');
  assert.deepEqual(notice.envelope, BOX);

  assert.equal((await upload(base, reply.blobId, 'anything', crypto.randomBytes(10))).status, 404);

  b.send(JSON.stringify({ type: 'blob-release', blobId: reply.blobId }));
  await settle();
  assert.deepEqual(await onDisk(dir), { directories: [], files: [] });

  // A message offer that claims a body is refused.
  const requestId = crypto.randomUUID();
  const refused = waitFor(a, m => m.requestId === requestId);
  a.send(JSON.stringify({
    type: 'blob-offer', requestId, kind: 'message', conv: 'direct',
    bytes: 128, chunkSize: CHUNK, totalChunks: 1,
    envelopes: { device_recver_0005: BOX }
  }));
  const answer = await refused;
  assert.equal(answer.type, 'error');
  assert.match(answer.message, /carries no body/);
  a.close();
  b.close();
});

test('uploads and downloads are gated by their own tokens and the declared length', async t => {
  const { base, wsBase } = await startServer(t);
  const a = await register(wsBase, 'device_sender_0006', 'A');
  const b = await register(wsBase, 'device_recver_0006', 'B');

  const { reply, bytes } = await offer(a, 'device_recver_0006', 1000);
  assert.equal((await upload(base, reply.blobId, 'wrong-token', crypto.randomBytes(bytes))).status, 403);
  assert.equal((await upload(base, reply.blobId, reply.uploadToken, crypto.randomBytes(bytes + 50))).status, 413);

  const second = await offer(a, 'device_recver_0006', 1000);
  assert.equal((await upload(base, second.reply.blobId, second.reply.uploadToken, crypto.randomBytes(10))).status, 400);

  const third = await offer(a, 'device_recver_0006', 1000);
  assert.equal((await upload(base, third.reply.blobId, third.reply.uploadToken, crypto.randomBytes(third.bytes))).status, 204);
  assert.equal((await upload(base, third.reply.blobId, third.reply.uploadToken, crypto.randomBytes(third.bytes))).status, 409);
  assert.equal((await fetch(`${base}/blob/${third.reply.blobId}?token=${encodeURIComponent(third.reply.uploadToken)}`)).status, 403);

  const c = await register(wsBase, 'device_snoop_00006', 'C');
  const refused = waitFor(c, m => m.type === 'error' && m.context === 'blob-claim');
  c.send(JSON.stringify({ type: 'blob-claim', blobId: third.reply.blobId }));
  assert.match((await refused).message, /not addressed to this device/);

  for (const ws of [a, b, c]) ws.close();
});

test('a sender cannot address devices it has no session with', async t => {
  const { wsBase } = await startServer(t);
  const a = await register(wsBase, 'device_sender_0007', 'A');

  assert.equal((await offer(a, 'device_nobody_00007', 100)).reply.type, 'error');
  assert.equal((await offer(a, 'device_sender_0007', 100)).reply.type, 'blob-offered');

  const b = await register(wsBase, 'device_member_0007', 'B');
  const created = waitFor(b, m => m.type === 'room-joined');
  b.send(JSON.stringify({ type: 'create-room', name: 'Private' }));
  const room = (await created).room;
  assert.equal((await offer(a, 'device_member_0007', 0, { kind: 'message', conv: `room:${room.id}` })).reply.type, 'error');

  a.close();
  b.close();
});

test('file and message quotas are separate, and the file size limit holds', async t => {
  const { wsBase } = await startServer(t, { blobs: { maxBlobsPerDevice: 2, maxMessagesPerDevice: 3, maxBlobBytes: 4096 } });
  const a = await register(wsBase, 'device_sender_0008', 'A');
  const b = await register(wsBase, 'device_recver_0008', 'B');

  assert.equal((await offer(a, 'device_recver_0008', 4096)).reply.type, 'blob-offered', 'exactly at the limit fits');
  assert.equal((await offer(a, 'device_recver_0008', 4097)).reply.type, 'error');
  assert.equal((await offer(a, 'device_recver_0008', 10)).reply.type, 'blob-offered');
  const thirdFile = await offer(a, 'device_recver_0008', 10);
  assert.match(thirdFile.reply.message, /buffer 2 transfers/);

  // Files being full does not stop messages, which have their own budget.
  for (let i = 0; i < 3; i++) {
    assert.equal((await offer(a, 'device_recver_0008', 0, { kind: 'message' })).reply.type, 'blob-offered');
  }
  const extraMessage = await offer(a, 'device_recver_0008', 0, { kind: 'message' });
  assert.match(extraMessage.reply.message, /3 messages waiting/);

  a.close();
  b.close();
});

test('starting the server erases everything a previous process left, directories included', async t => {
  const dir = path.join(os.tmpdir(), `aria-drop-stale-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.mkdir(path.join(dir, 'd-leftover'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'd-leftover', 'item.bin'), 'orphaned bytes');
  await startServer(t, { blobs: { dir } });
  assert.deepEqual(await onDisk(dir), { directories: [], files: [] });
});

test('`node server.js --sweep-blobs` removes only items past the age, then emptied directories', async t => {
  const dir = path.join(os.tmpdir(), `aria-drop-cron-${crypto.randomBytes(6).toString('hex')}`);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  // One conversation holding only old items, one holding a young item, and one
  // directory that is already empty.
  const staleDir = path.join(dir, 'd-stale');
  const liveDir = path.join(dir, 'd-live');
  await fsp.mkdir(staleDir, { recursive: true });
  await fsp.mkdir(liveDir, { recursive: true });
  await fsp.mkdir(path.join(dir, 'd-empty'), { recursive: true });
  const longAgo = new Date(Date.now() - 4 * DAY);
  for (const name of ['a.bin', 'a.env.json']) {
    await fsp.writeFile(path.join(staleDir, name), 'x');
    await fsp.utimes(path.join(staleDir, name), longAgo, longAgo);
  }
  await fsp.writeFile(path.join(liveDir, 'b.env.json'), 'x');

  const result = spawnSync(process.execPath, ['server.js', '--sweep-blobs'], {
    cwd: ROOT,
    env: { ...process.env, BLOB_DIR: dir },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Swept 2 relayed file\(s\).*kept 1; removed 2 empty directories/);
  assert.equal(fs.existsSync(staleDir), false, 'a conversation with only old items disappears entirely');
  assert.equal(fs.existsSync(path.join(dir, 'd-empty')), false, 'an empty directory is removed');
  assert.equal(fs.existsSync(path.join(liveDir, 'b.env.json')), true, 'an item under the cap survives');
});


test('self-chat survives delivery and reconnects, expires after 24h away, and has a 3-day cap', async t => {
  let now = 1000;
  const { app, wsBase, base } = await startServer(t, { blobs: { now: () => now } });
  const id = 'device_self_00001';
  const a = await register(wsBase, id, 'Me');
  const message = await offer(a, id, 0, { kind: 'message' });
  const file = await offer(a, id, 100);
  assert.equal(message.reply.type, 'blob-offered');
  assert.equal((await upload(base, file.reply.blobId, file.reply.uploadToken, Buffer.alloc(file.bytes))).status, 204);
  await app.blobStore.release(message.reply.blobId, id);
  await app.blobStore.release(file.reply.blobId, id);
  assert.equal((await app.blobStore.pendingFor(id)).length, 2);
  const blob = app.blobStore.blobs.get(message.reply.blobId);
  assert.ok(blob);
  assert.equal(app.blobStore.expiresAt(blob), 1000 + 3 * DAY);
  a.close();
  await settle();
  assert.equal(app.blobStore.expiresAt(blob), 1000 + DAY);
  now += DAY - 1;
  const b = await register(wsBase, id, 'Me');
  assert.equal((await app.blobStore.pendingFor(id)).length, 2);
  assert.equal(app.blobStore.expiresAt(blob), 1000 + 3 * DAY);
  b.close();
  await settle();
  now += DAY;
  const c = await register(wsBase, id, 'Me');
  assert.deepEqual(await app.blobStore.pendingFor(id), []);
  c.close();
  await app.blobStore.sweepAged();
  assert.equal(app.blobStore.blobs.size, 0);
});

test('chunk uploads commit boundaries and downloads refuse nonzero offsets', async t => {
  const { base, wsBase, app } = await startServer(t);
  const sender = await register(wsBase, 'device_chunk_sender');
  const receiver = await register(wsBase, 'device_chunk_receiver');
  t.after(() => { sender.close(); receiver.close(); });
  const { reply, bytes } = await offer(sender, 'device_chunk_receiver', 2500);
  const url = `${base}/blob/${reply.blobId}?token=${reply.uploadToken}`;
  const body = Buffer.alloc(bytes, 37);
  const put = (/** @type {number} */ offset, /** @type {Buffer<ArrayBuffer>} */ part) => fetch(`${url}&offset=${offset}`, { method: 'PUT', body: part });
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 405);
  assert.equal((await put(0, body.subarray(0, 100))).status, 400);
  assert.equal((await put(0, body.subarray(0, CHUNK + 28))).status, 204);
  assert.equal((await put(0, body.subarray(0, CHUNK + 28))).status, 409);
  assert.equal((await put(10, body.subarray(0, CHUNK + 28))).status, 409);

  const denied = await fetch(`${base}/blob/${reply.blobId}?token=wrong&offset=${CHUNK + 28}`, { method: 'PUT', body: body.subarray(CHUNK + 28, 2 * (CHUNK + 28)) });
  assert.equal(denied.status, 403);
  assert.equal((await put(CHUNK + 28, body.subarray(CHUNK + 28, 2 * (CHUNK + 28)))).status, 204);
  assert.equal((await put(2 * (CHUNK + 28), body.subarray(2 * (CHUNK + 28)))).status, 204);
  const claim = await app.blobStore.claim(reply.blobId, 'device_chunk_receiver');
  assert.ok(claim.downloadToken);
  const getUrl = `${base}/blob/${reply.blobId}?token=${claim.downloadToken}`;
  assert.equal((await fetch(`${getUrl}&offset=1`)).status, 416);
  const resumed = await fetch(`${getUrl}&offset=${CHUNK + 28}`);
  assert.equal(resumed.status, 416);
  assert.deepEqual(Buffer.from(await (await fetch(getUrl)).arrayBuffer()), body);
});
