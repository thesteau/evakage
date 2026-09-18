// The relay's crypto runs in Node unchanged, so it is tested here directly —
// including the tampering a hostile server could attempt.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fingerprintOf, bytesToBase64, signTranscript } from '../public/identity.js';
import {
  buildEnvelope,
  openEnvelope,
  buildMessageEnvelope,
  openMessageEnvelope,
  generateContentKey,
  encryptBody,
  createBodyDecryptor,
  cipherLayout
} from '../public/relay.js';

// A device identity without IndexedDB: the same key shapes loadIdentity makes.
async function makeIdentity() {
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const sealing = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey));
  const sealRaw = new Uint8Array(await crypto.subtle.exportKey('raw', sealing.publicKey));
  const deviceId = await fingerprintOf(raw);
  return {
    deviceId,
    identityKey: bytesToBase64(raw),
    privateKey: signing.privateKey,
    sealPrivateKey: sealing.privateKey,
    sealRaw
  };
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function sealedFile(sender, recipient, bytes, chunkSize = 1024) {
  const { raw, key } = await generateContentKey();
  const meta = {
    id: crypto.randomUUID(),
    name: 'report.pdf',
    size: bytes.length,
    type: 'application/pdf',
    sha256: sha256(bytes),
    chunkSize,
    totalChunks: Math.ceil(bytes.length / chunkSize),
    addedAt: Date.now(),
    fromName: 'Sender'
  };
  const box = await buildEnvelope({
    identity: sender,
    recipientId: recipient.deviceId,
    recipientSealRaw: recipient.sealRaw,
    meta,
    contentKeyRaw: raw,
    conv: 'direct'
  });
  const body = new Uint8Array(await (await encryptBody(new Blob([bytes]), key, meta.id, chunkSize)).arrayBuffer());
  return { meta, box, body, key };
}

test('a sealed envelope and body round-trip, fed in arbitrary network-sized pieces', async () => {
  const sender = await makeIdentity();
  const recipient = await makeIdentity();
  const bytes = crypto.randomBytes(10_000);
  const { box, body } = await sealedFile(sender, recipient, bytes);

  assert.equal(body.length, cipherLayout(bytes.length, 1024).bytes);

  const opened = await openEnvelope({
    sealPrivateKey: recipient.sealPrivateKey,
    box,
    selfId: recipient.deviceId,
    expectedFrom: sender.deviceId
  });
  assert.equal(opened.meta.name, 'report.pdf');
  assert.equal(opened.meta.contentKey, undefined, 'the content key must not leak back out in the metadata');

  for (const step of [1, 7, 1040, 3000, body.length]) {
    const decryptor = createBodyDecryptor({ key: opened.contentKey, fileId: opened.meta.id, chunkSize: 1024, size: bytes.length });
    for (let offset = 0; offset < body.length; offset += step) {
      await decryptor.push(body.subarray(offset, offset + step));
    }
    const result = decryptor.finish();
    assert.equal(result.sha256, sha256(bytes), `step ${step}`);
    assert.deepEqual(Buffer.concat(result.chunks.map(c => Buffer.from(c))), Buffer.from(bytes));
  }
});

test('a zero-byte file relays cleanly', async () => {
  const sender = await makeIdentity();
  const recipient = await makeIdentity();
  const { box, body } = await sealedFile(sender, recipient, new Uint8Array(0));
  assert.equal(body.length, 0);
  const opened = await openEnvelope({ sealPrivateKey: recipient.sealPrivateKey, box, selfId: recipient.deviceId, expectedFrom: sender.deviceId });
  const decryptor = createBodyDecryptor({ key: opened.contentKey, fileId: opened.meta.id, chunkSize: 1024, size: 0 });
  assert.equal(decryptor.finish().sha256, sha256(new Uint8Array(0)));
});

test('only the addressed recipient can open an envelope', async () => {
  const sender = await makeIdentity();
  const recipient = await makeIdentity();
  const bystander = await makeIdentity();
  const { box } = await sealedFile(sender, recipient, crypto.randomBytes(100));
  await assert.rejects(
    openEnvelope({ sealPrivateKey: bystander.sealPrivateKey, box, selfId: bystander.deviceId, expectedFrom: sender.deviceId })
  );
});

test('an envelope is refused if the server misreports who sent it', async () => {
  const sender = await makeIdentity();
  const recipient = await makeIdentity();
  const other = await makeIdentity();
  const { box } = await sealedFile(sender, recipient, crypto.randomBytes(100));
  await assert.rejects(
    openEnvelope({ sealPrivateKey: recipient.sealPrivateKey, box, selfId: recipient.deviceId, expectedFrom: other.deviceId }),
    /does not match the relaying server/
  );
});

test('an envelope claiming a sender it was not signed by is refused', async () => {
  const victim = await makeIdentity();
  const forger = await makeIdentity();
  const recipient = await makeIdentity();

  // The forger writes an envelope naming the victim as sender and presenting the
  // victim's public key, but can only sign with its own private key.
  const inner = JSON.stringify({
    v: 1, kind: 'file', to: recipient.deviceId, from: victim.deviceId, senderIdentityKey: victim.identityKey,
    conv: 'direct', fileId: crypto.randomUUID(), name: 'x', size: 1, type: 'x',
    sha256: '0'.repeat(64), chunkSize: 1024, totalChunks: 1, addedAt: 0, fromName: 'Victim',
    contentKey: bytesToBase64(crypto.randomBytes(32))
  });
  const signature = await signTranscript(forger.privateKey, `aria-drop/envelope/1|${inner}`);
  const { seal } = await import('../public/identity.js');
  const box = await seal(recipient.sealRaw, new TextEncoder().encode(JSON.stringify({ inner, signature })));

  await assert.rejects(
    openEnvelope({ sealPrivateKey: recipient.sealPrivateKey, box, selfId: recipient.deviceId, expectedFrom: victim.deviceId }),
    /signature does not verify/
  );
});

test('tampered, reordered, or truncated bodies fail to decrypt', async () => {
  const sender = await makeIdentity();
  const recipient = await makeIdentity();
  const bytes = crypto.randomBytes(5000);
  const { box, body } = await sealedFile(sender, recipient, bytes);
  const { meta, contentKey } = await openEnvelope({ sealPrivateKey: recipient.sealPrivateKey, box, selfId: recipient.deviceId, expectedFrom: sender.deviceId });
  const fresh = () => createBodyDecryptor({ key: contentKey, fileId: meta.id, chunkSize: 1024, size: bytes.length });

  const flipped = body.slice();
  flipped[100] ^= 0x01;
  await assert.rejects(fresh().push(flipped), 'a flipped byte must fail authentication');

  // Swap the first two chunks: each is bound to its index through the AAD.
  const chunkLength = 1024 + 28;
  const swapped = new Uint8Array(body.length);
  swapped.set(body.subarray(chunkLength, chunkLength * 2), 0);
  swapped.set(body.subarray(0, chunkLength), chunkLength);
  swapped.set(body.subarray(chunkLength * 2), chunkLength * 2);
  await assert.rejects(fresh().push(swapped), 'reordered chunks must fail');

  const truncated = fresh();
  await truncated.push(body.subarray(0, body.length - chunkLength));
  assert.throws(() => truncated.finish(), /ended before every chunk/);

  const padded = fresh();
  await assert.rejects(padded.push(new Uint8Array([...body, 1, 2, 3])), /Trailing bytes/);
});

/* ---------- relayed chat messages ---------- */

async function sealedMessage(sender, recipient, text, conv = 'direct') {
  return buildMessageEnvelope({
    identity: sender,
    recipientId: recipient.deviceId,
    recipientSealRaw: recipient.sealRaw,
    conv,
    message: { id: crypto.randomUUID(), text, at: 1700000000000, fromName: 'Sender' }
  });
}

test('a relayed message round-trips and its author comes from the signature', async () => {
  const sender = await makeIdentity();
  const recipient = await makeIdentity();
  const box = await sealedMessage(sender, recipient, 'hello over the relay', 'room:abc');

  const opened = await openMessageEnvelope({
    sealPrivateKey: recipient.sealPrivateKey,
    box,
    selfId: recipient.deviceId,
    expectedFrom: sender.deviceId
  });
  assert.equal(opened.message.text, 'hello over the relay');
  assert.equal(opened.message.from, sender.deviceId, 'author must be the verified signer');
  assert.equal(opened.conv, 'room:abc');
});

test('a message and a file envelope cannot be passed off as each other', async () => {
  const sender = await makeIdentity();
  const recipient = await makeIdentity();
  const args = { sealPrivateKey: recipient.sealPrivateKey, selfId: recipient.deviceId, expectedFrom: sender.deviceId };

  const messageBox = await sealedMessage(sender, recipient, 'x');
  await assert.rejects(openEnvelope({ ...args, box: messageBox }), /Expected a file envelope/);

  const { box: fileBox } = await sealedFile(sender, recipient, crypto.randomBytes(10));
  await assert.rejects(openMessageEnvelope({ ...args, box: fileBox }), /Expected a message envelope/);
});

test('a relayed message claiming an author who did not sign it is refused', async () => {
  const victim = await makeIdentity();
  const forger = await makeIdentity();
  const recipient = await makeIdentity();

  const inner = JSON.stringify({
    v: 1, kind: 'message', to: recipient.deviceId, from: victim.deviceId,
    senderIdentityKey: victim.identityKey, conv: 'direct',
    message: { id: crypto.randomUUID(), text: 'I am the victim', at: 1, fromName: 'Victim' }
  });
  const signature = await signTranscript(forger.privateKey, `aria-drop/envelope/1|${inner}`);
  const { seal } = await import('../public/identity.js');
  const box = await seal(recipient.sealRaw, new TextEncoder().encode(JSON.stringify({ inner, signature })));

  await assert.rejects(
    openMessageEnvelope({ sealPrivateKey: recipient.sealPrivateKey, box, selfId: recipient.deviceId, expectedFrom: victim.deviceId }),
    /signature does not verify/
  );
});

test('an oversized relayed message is refused on open', async () => {
  const sender = await makeIdentity();
  const recipient = await makeIdentity();
  const box = await sealedMessage(sender, recipient, 'y'.repeat(50));
  await assert.rejects(
    openMessageEnvelope({ sealPrivateKey: recipient.sealPrivateKey, box, selfId: recipient.deviceId, expectedFrom: sender.deviceId, maxChars: 10 }),
    /Bad message text/
  );
});
