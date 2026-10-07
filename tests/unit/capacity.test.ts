import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { startRoomServer, startServer, openWs, waitFor, register } from './helpers.js';

const box = { v: 1, ephemeral: 'e', iv: 'i', ciphertext: 'c' };
const file = {
  senderId: 'sender', conv: 'direct', kind: 'file' as const,
  bytes: 128, chunkSize: 100, totalChunks: 1, envelopes: { recipient: box },
};
const message = { ...file, kind: 'message' as const, bytes: 0, totalChunks: 0 };

test('concurrent offers reserve whole uploads and file saturation leaves text capacity', async (t) => {
  const { app } = await startServer(t, { blobs: { maxStoreBytes: 500, textReserveBytes: 125 } });
  const store = app.blobStore;
  const offers = await Promise.all([store.offer(file), store.offer(file), store.offer(file)]);
  assert.equal(offers.filter((result) => result.blob).length, 1);
  assert.ok(offers.slice(1).every((result) => result.error));
  const text = await store.offer(message);
  assert.ok(text.blob, 'pending file uploads must not consume the text reserve');
  assert.ok(store.stats().reservedFileBytes + store.stats().reservedTextBytes <= 500);
});

test('chat capacity evicts oldest completed files, warns participants, and protects downloads', async (t) => {
  const { app } = await startServer(t, { blobs: { maxConversationFileBytes: 240 } });
  const store = app.blobStore;
  const notices: string[] = [];
  store.onNotice = (participants, notice) => {
    assert.deepEqual([...participants].sort(), ['recipient', 'sender']);
    notices.push(notice);
  };
  const first = await store.offer(file);
  assert.ok(first.blob);
  const body = new PassThrough();
  body.end(Buffer.alloc(128));
  assert.equal((await store.receive(first.blob.id, first.blob.uploadToken, body)).status, 204);
  const finish = store.beginDownload(first.blob.id);
  assert.ok((await store.offer(file)).error, 'an active download cannot be evicted');
  assert.ok(store.blobs.has(first.blob.id));
  finish();
  finish();
  const second = await store.offer(file);
  assert.ok(second.blob);
  assert.ok(!store.blobs.has(first.blob.id));
  assert.ok((await store.claim(first.blob.id, 'recipient')).error);
  assert.ok(notices.some((notice) => notice.includes('nearly full')));
  assert.ok(notices.some((notice) => notice.includes('were removed')));
});

test('message eviction is independent of files and rejected oversized offers preserve pending content', async (t) => {
  const { app } = await startServer(t, { blobs: { maxConversationTextBytes: 100 } });
  const store = app.blobStore;
  const upload = await store.offer(file);
  const first = await store.offer(message);
  assert.ok(upload.blob);
  assert.ok(first.blob);
  const rejected = await store.offer({ ...message, envelopes: { recipient: { ...box, ciphertext: 'x'.repeat(200) } } });
  assert.ok(rejected.error);
  assert.ok(store.blobs.has(first.blob.id));
  const second = await store.offer(message);
  assert.ok(second.blob);
  assert.ok(!store.blobs.has(first.blob.id));
  assert.ok(store.blobs.has(upload.blob.id), 'text eviction must not remove file uploads');
});

test('global file pressure evicts across chats while preserving the message budget', async (t) => {
  const { app } = await startServer(t, { blobs: { maxStoreBytes: 500, textReserveBytes: 125 } });
  const store = app.blobStore;
  const first = await store.offer(file);
  assert.ok(first.blob);
  const body = new PassThrough();
  body.end(Buffer.alloc(128));
  await store.receive(first.blob.id, first.blob.uploadToken, body);
  const text = await store.offer(message);
  assert.ok(text.blob);
  const second = await store.offer({ ...file, senderId: 'other-sender' });
  assert.ok(second.blob);
  assert.ok(!store.blobs.has(first.blob.id));
  assert.ok(store.blobs.has(text.blob.id));
  assert.ok(store.stats().reservedFileBytes + store.stats().reservedTextBytes <= 500);
});

test('device cap allows replacement but rejects new identities, and exposes configured limits', async (t) => {
  const { base, wsBase } = await startServer(t, { maxDevices: 1, maxRooms: 3 });
  const first = await register(wsBase, 'first-device');
  t.after(() => first.close());
  const replacement = await register(wsBase, 'first-device');
  t.after(() => replacement.close());
  const extra = await openWs(wsBase);
  t.after(() => extra.close());
  const denied = waitFor(extra, (m) => m.type === 'error' && m.context === 'register');
  extra.send(JSON.stringify({ type: 'register', deviceId: 'second-device' }));
  assert.match((await denied).message, /1-device limit/);
  const config = await fetch(`${base}/config.json`).then((response) => response.json());
  assert.equal(config.maxDevices, 1);
  assert.equal(config.maxRooms, 3);
});

test('room cap rejects another owner without removing existing rooms', async (t) => {
  const { wsBase, app } = await startRoomServer(t, { maxRooms: 1 });
  const first = await register(wsBase, 'owner-one');
  const second = await register(wsBase, 'owner-two');
  t.after(() => { first.close(); second.close(); });
  const joined = waitFor(first, (m) => m.type === 'room-joined');
  first.send(JSON.stringify({ type: 'create-room', access: 'protected', name: 'First' }));
  await joined;
  const denied = waitFor(second, (m) => m.type === 'error' && m.context === 'create-room');
  second.send(JSON.stringify({ type: 'create-room', access: 'protected', name: 'Second' }));
  assert.match((await denied).message, /maximum number of rooms/);
  assert.equal(app.rooms.size, 1);
});
