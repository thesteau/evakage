import test from 'node:test';
import assert from 'node:assert/strict';
import { startRoomServer as startServer, register, waitFor } from './helpers.js';
import { pairingInvitation } from '../../app/public/scanner.js';

/** @param {WebSocket} ws @param {string} type */
async function list(ws, type) {
  const result = waitFor(ws, msg => msg.type === type);
  ws.send(JSON.stringify({ type: `${type}-request` }));
  return result;
}
test('advertising defaults off and can be enabled and revoked without duplicate entries', async t => {
  const { wsBase, app } = await startServer(t);
  const a = await register(wsBase, 'privacy_device_a', 'A', { discoverable: undefined });
  const b = await register(wsBase, 'privacy_device_b', 'B', { discoverable: false });
  t.after(() => { a.close(); b.close(); });
  assert.deepEqual((await list(a, 'presence')).peers.map((/** @type {any} */ p) => p.id), ['privacy_device_a']);
  const visible = waitFor(a, m => m.type === 'presence' && m.peers.length === 2);
  b.send(JSON.stringify({ type: 'set-discoverable', enabled: true }));
  await visible;
  const hidden = waitFor(a, m => m.type === 'presence' && m.peers.length === 1);
  b.send(JSON.stringify({ type: 'set-discoverable', enabled: false }));
  await hidden;
  const closed = new Promise(resolve => b.addEventListener('close', resolve, { once: true }));
  const replacement = await register(wsBase, 'privacy_device_b', 'B', { discoverable: false });
  t.after(() => replacement.close());
  assert.equal((await closed).code, 4001);
  assert.equal(app.clients.size, 2);
  assert.equal((await list(replacement, 'presence')).peers.length, 1);
});
test('room state is private before joining and after leaving; failed invitations reveal no state', async t => {
  const { wsBase, base } = await startServer(t, { maxRoomMembers: 2 });
  const owner = await register(wsBase, 'private_room_owner');
  const outsider = await register(wsBase, 'private_room_outsider');
  const third = await register(wsBase, 'private_room_third');
  t.after(() => { owner.close(); outsider.close(); third.close(); });
  await list(outsider, 'rooms');
  let roomUpdates = 0;
  outsider.addEventListener('message', event => { if (JSON.parse(String(event.data)).type === 'rooms') roomUpdates++; });
  const created = waitFor(owner, m => m.type === 'room-joined');
  owner.send(JSON.stringify({ type: 'create-room', name: 'Secret membership' }));
  const room = (await created).room;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(roomUpdates, 0, 'outsiders receive no unsolicited room-change notifications');
  assert.deepEqual((await list(outsider, 'rooms')).rooms, []);
  assert.equal(Object.hasOwn(await fetch(`${base}/healthz`).then(r => r.json()), 'rooms'), false);
  const fail = async (/** @type {WebSocket} */ ws, /** @type {object} */ invitation) => {
    const response = waitFor(ws, m => m.type === 'error' && m.context === 'join-room');
    ws.send(JSON.stringify({ type: 'join-room', ...invitation }));
    return (await response).message;
  };
  const noCode = await fail(outsider, { roomId: room.id });
  const absent = await fail(outsider, { code: 'XXXX-XXXX' });
  assert.equal(noCode, absent);
  const joined = waitFor(outsider, m => m.type === 'room-joined');
  outsider.send(JSON.stringify({ type: 'join-room', code: room.code }));
  assert.equal((await joined).room.members.length, 2);
  assert.equal(await fail(third, { code: room.code }), absent);
  const left = waitFor(outsider, m => m.type === 'room-left');
  outsider.send(JSON.stringify({ type: 'leave-room', roomId: room.id }));
  await left;
  assert.deepEqual((await list(outsider, 'rooms')).rooms, []);
});
test('scanner accepts only same-server device invitations', () => {
  const id = 'a'.repeat(43);
  assert.deepEqual(pairingInvitation(`https://example.com/#pair=ABCD-EFGH&device=${id}`, 'https://example.com'), { code: 'ABCD-EFGH', device: id });
  for (const url of [`https://evil.example/#pair=ABCD-EFGH&device=${id}`, 'javascript:alert(1)', 'https://example.com/', 'https://example.com/#pair=ABCD-EFGH&device=invalid']) {
    assert.throws(() => pairingInvitation(url, 'https://example.com'));
  }
});

test('a remembered full fingerprint remains reachable without public advertising', async t => {
  const { wsBase } = await startServer(t);
  const a = await register(wsBase, 'remembered_device_a', 'A', { discoverable: false });
  const b = await register(wsBase, 'remembered_device_b', 'B', { discoverable: false });
  t.after(() => { a.close(); b.close(); });
  assert.equal((await list(a, 'presence')).peers.length, 1);
  const lookup = waitFor(a, msg => msg.type === 'devices-found');
  a.send(JSON.stringify({ type: 'lookup-devices', requestId: 'remembered', deviceIds: ['remembered_device_b'] }));
  assert.equal((await lookup).devices[0].id, 'remembered_device_b');
  assert.equal((await list(a, 'presence')).peers.length, 2);
});
