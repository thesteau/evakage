import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EvakageClient, FileStore, MemoryStore, type Device, type IncomingFile, type ClientOptions } from '../../app/sdk/index.js';
import { base64ToBytes } from '../../app/core/identity.js';
import { buildEnvelope, buildMessageEnvelope, generateContentKey } from '../../app/core/relay.js';
import { startServer } from './helpers.js';

function event<T = any>(client: EvakageClient, name: string): Promise<T> {
  return once(client, name, { signal: AbortSignal.timeout(5000) }).then(([value]) => value);
}
function device(t: { after(fn: () => any): void }, url: string, options: Partial<ClientOptions> = {}) {
  const client = new EvakageClient({ url, store: new MemoryStore(), autoReconnect: false, timeoutMs: 3000, ...options });
  t.after(() => client.disconnect());
  return client;
}

test('API-only hosting supports authenticated registered devices and encrypted text', async t => {
  const { base, app } = await startServer(t, { apiOnly: true, authToken: 'api-access' });
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/config.json`)).status, 401);
  const sender = device(t, base, { token: 'api-access' });
  const recipient = device(t, base, { token: 'api-access' });
  const [first, second] = await Promise.all([sender.connect(), recipient.connect()]);
  assert.equal(sender.online, true);
  assert.equal(first.relayOnly, true);
  assert.equal(app.clients.size, 2);
  await assert.rejects(sender.sendText(second.id, 'unpaired'), /Pair/);
  await sender.pair(second.pairingCode!, second.id);
  const incoming = event(recipient, 'message');
  await sender.sendText(second.id, 'Hello from the API');
  assert.equal((await incoming).text, 'Hello from the API');
  const back = event(sender, 'message');
  await recipient.sendText(first.id, 'Reply from the API');
  assert.equal((await back).from, second.id);
  await recipient.disconnect();
  assert.equal(recipient.online, false);
  assert.equal(app.clients.has(second.id), false);
});

test('relay sends offline text to the same identity on its next connection', async t => {
  const { base } = await startServer(t);
  const store = new MemoryStore();
  const sender = device(t, base), recipient = device(t, base, { store });
  await sender.connect(); const second = await recipient.connect();
  await sender.pair(second.pairingCode!);
  await recipient.disconnect();
  await sender.sendText(second.id, 'Waiting for your connection');
  const reconnected = device(t, base, { store });
  const incoming = event(reconnected, 'message');
  assert.equal((await reconnected.connect()).id, second.id);
  assert.equal((await incoming).text, 'Waiting for your connection');
});

test('API file receiving verifies bytes, refuses overwrite, and supports empty files', async t => {
  const { base } = await startServer(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-api-files-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sender = device(t, base), recipient = device(t, base);
  await sender.connect(); const second = await recipient.connect();
  await sender.pair(second.pairingCode!);
  const bytes = Buffer.from(Array.from({ length: 600000 }, (_, i) => i % 251));
  const notice = event<IncomingFile>(recipient, 'file');
  await sender.sendFile(second.id, new Blob([bytes]), { name: '../../unsafe.bin' });
  const file = await notice;
  const existing = path.join(directory, 'existing.bin');
  await fs.writeFile(existing, 'keep this');
  await assert.rejects(file.save(existing), { code: 'EEXIST' });
  assert.equal(await fs.readFile(existing, 'utf8'), 'keep this');
  const saved = path.join(directory, 'chosen.bin');
  await file.save(saved);
  assert.deepEqual(await fs.readFile(saved), bytes);
  const empty = event<IncomingFile>(recipient, 'file');
  await sender.sendFile(second.id, new Blob(), { name: 'empty.bin' });
  await (await empty).save(path.join(directory, 'empty.bin'));
  assert.equal((await fs.stat(path.join(directory, 'empty.bin'))).size, 0);
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('API reconnect maintains identity and stops when its identity is replaced', async t => {
  const { base, app } = await startServer(t);
  const store = new MemoryStore();
  const client = device(t, base, { store, autoReconnect: true });
  const first = await client.connect();
  const offline = event(client, 'offline'), online = event<Device>(client, 'online');
  app.clients.get(first.id)!.ws.close(1001, 'test network loss');
  assert.equal((await offline).code, 1001);
  assert.equal((await online).id, first.id);
  const replaced = event(client, 'offline');
  const replacement = device(t, base, { store });
  await replacement.connect();
  assert.equal((await replaced).code, 4001);
  assert.equal(client.online, false);
});

test('tampered relay ciphertext never publishes an API download', async t => {
  const { base, dir } = await startServer(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-api-tampering-'));
  const sender = device(t, base), recipient = device(t, base);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await sender.connect(); const second = await recipient.connect();
  await sender.pair(second.pairingCode!);
  const incoming = event<IncomingFile>(recipient, 'file');
  await sender.sendFile(second.id, new Blob(['Authenticated file']), { name: 'file.txt' });
  const file = await incoming;
  const [conversation] = await fs.readdir(dir);
  const body = path.join(dir, conversation, `${file.blobId}.bin`);
  const bytes = await fs.readFile(body); bytes[0] ^= 1;
  await fs.writeFile(body, bytes);
  const destination = path.join(directory, 'unverified.txt');
  await assert.rejects(file.save(destination));
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('API relay handlers verify signed kinds and message proofs before emitting payloads', async t => {
  const { base, app } = await startServer(t);
  const store = new MemoryStore();
  const sender = device(t, base, { store }), recipient = device(t, base);
  const first = await sender.connect(), second = await recipient.connect();
  await sender.pair(second.pairingCode!);
  const identity = await store.identity();
  const options = { identity, recipientId: second.id, recipientSealRaw: base64ToBytes(second.sealKey!), conv: 'direct' };
  const key = await generateContentKey();
  const fileBox = await buildEnvelope({ ...options, contentKeyRaw: key.raw, meta: {
    id: crypto.randomUUID(), name: 'empty.bin', size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', chunkSize: 262144, totalChunks: 0,
  } });
  const unsignedMessageBox = await buildMessageEnvelope({ ...options, message: { id: crypto.randomUUID(), text: 'Missing message proof', fromName: first.name, at: Date.now() } });
  let messages = 0, files = 0;
  recipient.on('message', () => messages++);
  recipient.on('file', () => files++);
  for (const [kind, envelope, expected] of [
    ['message', fileBox, /Expected a message envelope/],
    ['file', unsignedMessageBox, /Expected a file envelope/],
    ['message', unsignedMessageBox, /Message signature did not verify/],
    ['unsupported', unsignedMessageBox, /Unsupported relay item kind/],
  ] as const) {
    const failure = event<Error>(recipient, 'client-error');
    app.clients.get(second.id)!.ws.send(JSON.stringify({ type: 'blob-available', blobId: crypto.randomUUID(), from: first.id, conv: 'direct', kind, envelope }));
    assert.match((await failure).message, expected);
  }
  assert.equal(messages, 0);
  assert.equal(files, 0);
});

test('filesystem identities initialize atomically and paired devices survive reload', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-api-identity-'));
  const a = new FileStore(directory), b = new FileStore(directory);
  const [first, second] = await Promise.all([a.identity(), b.identity()]);
  assert.equal(first.deviceId, second.deviceId);
  assert.equal(first.privateKey.extractable, false);
  const { base } = await startServer(t);
  const client = device(t, base, { store: a }), peer = device(t, base);
  let next: EvakageClient | undefined;
  t.after(async () => { await client.disconnect(); await peer.disconnect(); await next?.disconnect(); await fs.rm(directory, { recursive: true, force: true }); });
  await client.connect(); const other = await peer.connect();
  await client.pair(other.pairingCode!);
  await client.disconnect();
  next = device(t, base, { store: new FileStore(directory) });
  await next.connect();
  assert.equal(next.peers()[0].id, other.id);
  assert.equal(next.self!.id, first.deviceId);
});

test('identity reads retain the validated file when its path is replaced', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-api-identity-race-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identity = await new FileStore(directory).identity();
  const file = path.join(directory, 'identity.json');
  const lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const entry = await lstat(...args);
    if (args[0] === file) {
      await fs.rename(file, path.join(directory, 'original.json'));
      await fs.writeFile(file, 'replaced after validation');
    }
    return entry;
  });
  assert.equal((await new FileStore(directory).identity()).deviceId, identity.deviceId);
});

test('identity reads refuse symbolic links', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-api-identity-link-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'target');
  await new FileStore(target).identity();
  try { await fs.symlink(path.join(target, 'identity.json'), path.join(directory, 'identity.json'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Creating symlinks requires Windows developer mode or elevated permissions'); return; }
    throw error;
  }
  await assert.rejects(new FileStore(directory).identity(), error => error instanceof Error && (('code' in error && error.code === 'ELOOP') || /symbolic link/.test(error.message)));
});

test('API accounts attach verified sockets and room messages retain their scope', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-api-account-'));
  const { base } = await startServer(t, { accountsDb: path.join(directory, 'accounts.sqlite') });
  const owner = device(t, base), guest = device(t, base);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await Promise.all([owner.connect(), guest.connect()]);
  await owner.login('api_owner', 'a sufficiently long password', true);
  const room = await owner.createRoom('API room', 'protected');
  const joined = await guest.joinRoom(room.code!);
  assert.equal(joined.id, room.id);
  const incoming = event(guest, 'message');
  await owner.sendText(`room:${room.id}`, 'Room text');
  assert.equal((await incoming).conv, `room:${room.id}`);
});
