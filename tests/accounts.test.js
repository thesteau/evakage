import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, openWs, waitFor } from './helpers.js';
import { fingerprintOf, signTranscript, bytesToBase64 } from '../public/identity.js';

/** @param {string} base @param {string} route @param {object} body @param {string} [cookie] @param {string} [method] */
function request(base, route, body, cookie = '', method = 'POST') {
  return fetch(`${base}/account/${route}`, { method, headers: { origin: base, 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
}

test('account discovery requires identity-bound one-use tickets; sign-out revokes sockets and unused tickets', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-account-devices-'));
  const { base, wsBase, app } = await startServer(t, { accountsDb: path.join(dir, 'accounts.sqlite') });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const credentials = { username: 'device_owner', password: 'correct horse battery staple' };
  const a = await request(base, 'register', credentials);
  const b = await request(base, 'login', credentials);
  const cookies = [a, b].map(response => response.headers.get('set-cookie')?.split(';')[0] || '');
  const devices = [];
  for (let i = 0; i < 3; i++) {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const id = await fingerprintOf(raw);
    const ws = await openWs(wsBase);
    t.after(() => ws.close());
    const challenge = (await waitFor(ws, message => message.type === 'registration-challenge')).challenge;
    const proof = await signTranscript(keys.privateKey, JSON.stringify(['evakage/register/1', challenge, id]));
    const registered = waitFor(ws, message => message.type === 'registered');
    ws.send(JSON.stringify({ type: 'register', deviceId: id, identityKey: bytesToBase64(raw), registrationProof: proof }));
    await registered;
    devices.push({ id, ws });
  }
  const [first, second, outsider] = devices;
  const outsiderMessages = /** @type {any[]} */ ([]);
  outsider.ws.addEventListener('message', event => outsiderMessages.push(JSON.parse(String(event.data))));
  assert.equal((await request(base, 'connect', { deviceId: first.id })).status, 401);
  const firstTicket = await request(base, 'connect', { deviceId: first.id }, cookies[0]).then(response => response.json());
  const wrongDevice = waitFor(outsider.ws, message => message.type === 'error' && message.context === 'account-connect');
  outsider.ws.send(JSON.stringify({ type: 'account-connect', token: firstTicket.token }));
  await wrongDevice;
  for (const [index, device] of [first, second].entries()) {
    const { token } = await request(base, 'connect', { deviceId: device.id }, cookies[index]).then(response => response.json());
    const connected = waitFor(device.ws, message => message.type === 'account-peers' && message.signedIn);
    device.ws.send(JSON.stringify({ type: 'account-connect', token }));
    const result = await connected;
    if (index === 1) assert.deepEqual(result.peers.map((/** @type {{id: string}} */ peer) => peer.id), [first.id]);
    const replay = waitFor(device.ws, message => message.type === 'error' && message.context === 'account-connect');
    device.ws.send(JSON.stringify({ type: 'account-connect', token }));
    await replay;
  }
  const unused = await request(base, 'connect', { deviceId: first.id }, cookies[0]).then(response => response.json());
  const joined = waitFor(first.ws, message => message.type === 'room-joined');
  first.ws.send(JSON.stringify({ type: 'create-room', name: 'Account room' }));
  const { room } = await joined;
  assert.ok(app.rooms.get(room.id)?.members.has(first.id));
  const reset = waitFor(first.ws, message => message.type === 'account-reset');
  const disconnected = waitFor(second.ws, message => message.type === 'account-peers' && message.signedIn && !message.peers.length);
  await request(base, 'logout', {}, cookies[0]);
  await reset; await disconnected;
  assert.ok(!app.rooms.get(room.id)?.members.has(first.id));
  const rejected = waitFor(first.ws, message => message.type === 'error' && message.context === 'account-connect');
  first.ws.send(JSON.stringify({ type: 'account-connect', token: unused.token }));
  await rejected;
  assert.equal((await fetch(`${base}/account/session`, { headers: { cookie: cookies[1] } }).then(response => response.json())).username, credentials.username);
  assert.ok(!outsiderMessages.some(message => JSON.stringify(message).includes(first.id) || JSON.stringify(message).includes(second.id)));
  const secondJoined = waitFor(second.ws, message => message.type === 'room-joined');
  second.ws.send(JSON.stringify({ type: 'create-room', name: 'Offline sign-out room' }));
  const secondRoom = (await secondJoined).room;
  const buffered = await app.blobStore.offer({ senderId: second.id, conv: 'direct', kind: 'message', bytes: 0,
    chunkSize: 1024, totalChunks: 0, envelopes: { [second.id]: { v: 1, ephemeral: 'e', iv: 'i', ciphertext: 'c' } } });
  assert.ok(buffered.blob);
  await new Promise(resolve => { app.clients.get(second.id)?.ws.once('close', resolve); second.ws.close(); });
  assert.ok(app.rooms.get(secondRoom.id)?.away.has(second.id));
  await request(base, 'logout', {}, cookies[1]);
  assert.ok(!app.rooms.has(secondRoom.id));
  assert.ok(!app.blobStore.blobs.has(buffered.blob.id));
});
test('accounts are optional; durable preferences sync with conflict protection and session isolation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-accounts-'));

  const file = path.join(dir, 'accounts.sqlite');
  const { base, app } = await startServer(t, { accountsDb: file });
  const credentials = { username: 'my_account', password: 'correct horse battery staple' };
  const created = await request(base, 'register', credentials);
  assert.equal(created.status, 200);
  const cookie = created.headers.get('set-cookie')?.split(';')[0] || '';
  assert.match(created.headers.get('set-cookie') || '', /HttpOnly; SameSite=Strict/);
  assert.equal((await created.json()).username, 'my_account');
  const stored = await fs.readFile(file);
  assert.equal(stored.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.ok(!stored.includes(Buffer.from(credentials.password)));
  assert.equal((await request(base, 'login', { ...credentials, password: 'wrong password value' })).status, 401);
  const other = await request(base, 'login', credentials);
  assert.equal(other.status, 200);
  const otherCookie = other.headers.get('set-cookie')?.split(';')[0] || '';
  const preferences = { 'evakage-theme': 'dark', 'evakage-incoming': 'always', 'evakage-verified-only': '1' };
  const saved = await request(base, 'preferences', { preferences, revision: 0 }, cookie, 'PUT');
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);
  const synced = await fetch(`${base}/account/session`, { headers: { cookie: otherCookie } }).then(r => r.json());
  assert.deepEqual(synced.preferences, preferences);
  assert.equal((await request(base, 'preferences', { preferences, revision: 0 }, otherCookie, 'PUT')).status, 409);
  assert.equal((await request(base, 'preferences', { preferences: { 'evakage-known-devices': 'secret' }, revision: 1 }, cookie, 'PUT')).status, 400);
  assert.equal((await request(base, 'preferences', { preferences: { 'evakage-discoverable': '1' }, revision: 1 }, cookie, 'PUT')).status, 400);
  assert.equal((await fetch(`${base}/account/preferences`, { method: 'PUT', headers: { origin: 'https://evil.example', 'content-type': 'application/json', cookie }, body: '{}' })).status, 403);
  assert.equal((await request(base, 'preferences', { preferences, revision: 1 }, '', 'PUT')).status, 401);
  await request(base, 'logout', {}, cookie);
  assert.equal((await fetch(`${base}/account/session`, { headers: { cookie } }).then(r => r.json())).username, null);
  assert.equal((await fetch(`${base}/account/session`, { headers: { cookie: otherCookie } }).then(r => r.json())).username, credentials.username);
  await app.stop();
  const restarted = await startServer(t, { accountsDb: file });
  const login = await request(restarted.base, 'login', credentials);
  assert.equal(login.status, 200);
  assert.deepEqual((await login.json()).preferences, preferences);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
});
test('disabled accounts leave ordinary anonymous app access available', async t => {
  const { base } = await startServer(t);
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/account/session`)).status, 503);
});

test('SQLite coordinates independent connections without duplicate accounts or lost preference updates', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-sqlite-'));
  const file = path.join(dir, 'accounts.sqlite');
  const first = await startServer(t, { accountsDb: file });
  const second = await startServer(t, { accountsDb: file });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const credentials = { username: 'shared_owner', password: 'correct horse battery staple' };
  const registered = await Promise.all([request(first.base, 'register', credentials), request(second.base, 'register', credentials)]);
  assert.deepEqual(registered.map(response => response.status).sort(), [200, 409]);
  const signedIn = await Promise.all([request(first.base, 'login', credentials), request(second.base, 'login', credentials)]);
  const cookies = signedIn.map(response => response.headers.get('set-cookie')?.split(';')[0] || '');
  const writes = await Promise.all([
    request(first.base, 'preferences', { preferences: { 'evakage-theme': 'dark' }, revision: 0 }, cookies[0], 'PUT'),
    request(second.base, 'preferences', { preferences: { 'evakage-theme': 'light' }, revision: 0 }, cookies[1], 'PUT')
  ]);
  assert.deepEqual(writes.map(response => response.status).sort(), [200, 409]);
  const winner = await writes.find(response => response.status === 200)?.json();
  for (const [index, server] of [first, second].entries()) {
    const session = await fetch(`${server.base}/account/session`, { headers: { cookie: cookies[index] } }).then(response => response.json());
    assert.deepEqual(session.preferences, winner.preferences);
    assert.equal(session.revision, 1);
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name), ['accounts']);
    assert.deepEqual(db.prepare('PRAGMA table_info(accounts)').all().map(row => row.name), ['username', 'salt', 'hash', 'preferences', 'revision']);
    const rows = db.prepare('SELECT * FROM accounts').all();
    assert.equal(rows.length, 1);
    assert.match(String(rows[0].hash), /^[a-f0-9]{128}$/);
    assert.ok(!JSON.stringify(rows).includes(credentials.password));
  } finally { db.close(); }
  const forbidden = await request(first.base, 'preferences', { preferences: { text: 'private message', file: 'private bytes' }, revision: 1 }, cookies[0], 'PUT');
  assert.equal(forbidden.status, 400);
});
