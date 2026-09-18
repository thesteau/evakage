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
import { startServer, waitFor, register } from './helpers.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BOX = { v: 1, ephemeral: 'e', iv: 'i', ciphertext: 'c' };
const CHUNK = 1024;
const DAY = 24 * 60 * 60 * 1000;

// Ciphertext length for a plaintext of `plain` bytes, matching relay.js.
function layout(plain) {
  const totalChunks = Math.ceil(plain / CHUNK);
  return { totalChunks, bytes: plain + totalChunks * 28 };
}

/** Conversation directories, and every item file inside them. */
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
    envelopes: Object.fromEntries([].concat(to).map(id => [id, BOX]))
  }));
  return { reply: await reply, bytes };
}

const upload = (base, blobId, token, body) =>
  fetch(`${base}/blob/${blobId}?token=${encodeURIComponent(token)}`, { method: 'PUT', body });

const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));

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

test('the age sweep removes items past 24h, keeps younger ones, and removes emptied directories', async t => {
  const { base, wsBase, dir, app } = await startServer(t);
  const a = await register(wsBase, 'device_sender_0003', 'A');
  const b = await register(wsBase, 'device_recver_0003', 'B');
  const c = await register(wsBase, 'device_third_00003', 'C');

  const old = await offer(a, 'device_recver_0003', 100);
  const fresh = await offer(a, 'device_recver_0003', 100);
  for (const item of [old, fresh]) {
    assert.equal((await upload(base, item.reply.blobId, item.reply.uploadToken, crypto.randomBytes(item.bytes))).status, 204);
  }
  // A second conversation whose only item is old: its whole directory should go.
  const otherOld = await offer(a, 'device_third_00003', 0, { kind: 'message' });

  for (const id of [old.reply.blobId, otherOld.reply.blobId]) {
    app.blobStore.blobs.get(id).createdAt = Date.now() - (DAY + 1000);
  }
  assert.equal((await onDisk(dir)).directories.length, 2);

  const purged = await app.blobStore.sweepAged();
  assert.deepEqual(purged.sort(), [old.reply.blobId, otherOld.reply.blobId].sort());
  assert.equal(app.blobStore.blobs.has(fresh.reply.blobId), true, 'an item under 24h must survive the sweep');

  const after = await onDisk(dir);
  assert.equal(after.directories.length, 1, 'the conversation with nothing left is gone entirely');
  assert.equal(after.files.length, 2, 'the young item keeps its body and envelopes');

  // A stray empty directory is removed by the sweep too, whatever emptied it.
  await fsp.mkdir(path.join(dir, 'd-empty-leftover'));
  await app.blobStore.sweepAged();
  assert.equal((await onDisk(dir)).directories.includes('d-empty-leftover'), false);

  for (const ws of [a, b, c]) ws.close();
});

test('the same two devices share one directory whichever sends; others get their own', async t => {
  const { wsBase, dir, app } = await startServer(t);
  const a = await register(wsBase, 'device_pair_aaaa01', 'A');
  const b = await register(wsBase, 'device_pair_bbbb01', 'B');
  const c = await register(wsBase, 'device_pair_cccc01', 'C');

  const ab = await offer(a, 'device_pair_bbbb01', 0, { kind: 'message' });
  const ba = await offer(b, 'device_pair_aaaa01', 0, { kind: 'message' });
  const ac = await offer(a, 'device_pair_cccc01', 0, { kind: 'message' });

  const dirOf = id => app.blobStore.blobs.get(id).convDir;
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
  assert.equal((await offer(a, 'device_sender_0007', 100)).reply.type, 'error');

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
  const twoDaysAgo = new Date(Date.now() - 2 * DAY);
  for (const name of ['a.bin', 'a.env.json']) {
    await fsp.writeFile(path.join(staleDir, name), 'x');
    await fsp.utimes(path.join(staleDir, name), twoDaysAgo, twoDaysAgo);
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
  assert.equal(fs.existsSync(path.join(liveDir, 'b.env.json')), true, 'an item under 24h survives');
});
