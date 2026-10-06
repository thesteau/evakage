import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToBase64, fingerprintOf, signTranscript } from '../../app/client/ts/identity.js';
import {
  messageScope,
  signMessage,
  verifyMessage,
  historyFrames,
  messageKey,
} from '../../app/client/ts/messages.js';
import { buildMessageEnvelope, openMessageEnvelope } from '../../app/client/ts/relay.js';

async function identity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    privateKey: pair.privateKey,
    identityKey: bytesToBase64(raw),
    deviceId: await fingerprintOf(raw),
  };
}
const alice = await identity();
const bob = await identity();
const mallory = await identity();
const scope = messageScope('direct', [alice.deviceId, bob.deviceId]);

const message = (): import('../../app/client/ts/types.js').Message => ({
  id: crypto.randomUUID(),
  from: alice.deviceId,
  fromName: 'Alice',
  text: 'A | B\n"quoted" 🦊',
  at: 0,
});

async function rawProof(
  value: import('../../app/client/ts/types.js').Message,
  conversation: string,
  signer: Awaited<ReturnType<typeof identity>>,
) {
  const inner = JSON.stringify({
    v: 1,
    scope: conversation,
    id: value.id,
    from: value.from,
    fromName: value.fromName,
    at: value.at,
    text: value.text,
  });
  return {
    ...value,
    proof: {
      inner,
      identityKey: signer.identityKey,
      signature: await signTranscript(
        signer.privateKey,
        JSON.stringify(['evakage/message/1', inner]),
      ),
    },
  };
}

test('portable message proof round-trips independent of relayer and ignores unsigned trust flags', async () => {
  const signed = await signMessage(alice, scope, message());
  const verified = await verifyMessage(
    { ...signed, verifiedAuthor: false, relayedBy: mallory.deviceId, via: 'relay' },
    scope,
  );
  assert.ok(verified);
  assert.equal(verified.text, signed.text);
  assert.equal(verified.at, 0);
  assert.equal(verified.verifiedAuthor, true);
  assert.equal(verified.relayedBy, null);
  assert.equal(verified.via, undefined);
  assert.equal(messageScope('direct', [bob.deviceId, alice.deviceId]), scope);
  assert.deepEqual(await verifyMessage(JSON.parse(JSON.stringify(signed)), scope), verified);
});

test('every author/content/time/id field is signed, including attempts to rewrite the inner JSON', async () => {
  const signed = await signMessage(alice, scope, message());
  const changes = {
    id: 'forged-id',
    from: bob.deviceId,
    fromName: 'Bob',
    at: 1,
    text: 'Forged history',
  };
  for (const [key, value] of Object.entries(changes)) {
    const changed = { ...signed, [key]: value };
    assert.equal(await verifyMessage(changed, scope), null, key);
    assert.ok(signed.proof);
    const inner = JSON.parse(signed.proof.inner);
    inner[key] = value;
    assert.equal(
      await verifyMessage(
        { ...changed, proof: { ...signed.proof, inner: JSON.stringify(inner) } },
        scope,
      ),
      null,
      `inner ${key}`,
    );
  }
});

test('a relayer cannot use its own key or signature to impersonate the original author', async () => {
  const value = message();
  assert.equal(await verifyMessage(await rawProof(value, scope, mallory), scope), null);
  const signed = await signMessage(alice, scope, value);
  assert.ok(signed.proof);
  assert.equal(
    await verifyMessage(
      { ...signed, proof: { ...signed.proof, identityKey: mallory.identityKey } },
      scope,
    ),
    null,
  );
  assert.equal(
    await verifyMessage(
      { ...signed, proof: { ...signed.proof, signature: 'A'.repeat(86) + '==' } },
      scope,
    ),
    null,
  );
  await assert.rejects(signMessage(mallory, scope, value), /Invalid message/);
});

test('proofs cannot be replayed into another room or direct pair', async () => {
  const signed = await signMessage(alice, scope, message());
  assert.equal(
    await verifyMessage(signed, messageScope('direct', [alice.deviceId, mallory.deviceId])),
    null,
  );
  assert.equal(await verifyMessage(signed, 'room:room-one'), null);
  const roomSigned = await signMessage(alice, 'room:room-one', message());
  assert.equal(await verifyMessage(roomSigned, 'room:room-two'), null);
  assert.equal(await verifyMessage(roomSigned, scope), null);
  assert.ok(await verifyMessage(roomSigned, 'room:room-one'));
});

test('a valid outsider signature does not authorize messages in someone else’s direct conversation', async () => {
  const outsider = { ...message(), from: mallory.deviceId };
  assert.equal(await verifyMessage(await rawProof(outsider, scope, mallory), scope), null);
  await assert.rejects(signMessage(mallory, scope, outsider), /Invalid message/);
  const selfScope = messageScope('direct', [alice.deviceId, alice.deviceId]);
  assert.ok(await verifyMessage(await signMessage(alice, selfScope, message()), selfScope));
});

test('unsigned legacy, malformed, oversized and unknown-version proofs fail closed', async () => {
  const signed = await signMessage(alice, scope, message());
  assert.ok(signed.proof);
  const invalid = [
    null,
    [],
    {},
    message(),
    { ...message(), verifiedAuthor: true },
    { ...signed, at: -1 },
    { ...signed, at: 0.5 },
    { ...signed, id: '' },
    { ...signed, text: 'x'.repeat(20001) },
    { ...signed, proof: null },
    { ...signed, proof: { ...signed.proof, inner: 'x'.repeat(130001) } },
    { ...signed, proof: { ...signed.proof, inner: signed.proof.inner.replace('"v":1', '"v":2') } },
    { ...signed, proof: { ...signed.proof, identityKey: '!'.repeat(88) } },
    { ...signed, proof: { ...signed.proof, signature: '!'.repeat(88) } },
  ];
  for (const value of invalid) assert.equal(await verifyMessage(value, scope), null);
});

test('signature context prevents unrelated identity signatures being used as message proofs', async () => {
  const signed = await signMessage(alice, scope, message());
  assert.ok(signed.proof);
  const signature = await signTranscript(alice.privateKey, signed.proof.inner);
  assert.equal(
    await verifyMessage({ ...signed, proof: { ...signed.proof, signature } }, scope),
    null,
  );
});

test('relay preserves portable proofs and the exact signed timestamp for later peer recovery', async () => {
  const sealing = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ]);
  const signed = await signMessage(alice, scope, message());
  const box = await buildMessageEnvelope({
    identity: alice,
    recipientId: bob.deviceId,
    recipientSealRaw: await crypto.subtle.exportKey('raw', sealing.publicKey),
    conv: 'direct',
    message: signed,
  });
  const opened = await openMessageEnvelope({
    sealPrivateKey: sealing.privateKey,
    box,
    selfId: bob.deviceId,
    expectedFrom: alice.deviceId,
  });
  assert.deepEqual(await verifyMessage(opened.message, scope), await verifyMessage(signed, scope));
});

test('signed history is split by encoded byte budget and batch count without dropping proofs or files', async () => {
  const signed = await signMessage(alice, scope, { ...message(), text: '🦊\\\n'.repeat(1000) });
  const messages = Array.from({ length: 40 }, () => signed);
  const files = [{ id: 'file', name: 'f.txt', size: 1 }];
  const limit = 60000;
  const frames = [...historyFrames('direct', messages, files, limit)];
  assert.ok(frames.length > 1);
  for (const frame of frames) {
    assert.ok(new TextEncoder().encode(JSON.stringify(frame)).length + 1 <= limit);
    assert.ok(frame.messages.length + frame.files.length <= 16);
  }
  assert.deepEqual(
    frames.flatMap((frame) => frame.messages),
    messages,
  );
  assert.deepEqual(
    frames.flatMap((frame) => frame.files),
    files,
  );
  assert.equal([...historyFrames('direct', [], [], limit)].length, 1);
  const small = await signMessage(alice, scope, message());
  assert.deepEqual(
    [...historyFrames('direct', Array(40).fill(small), [], 512 * 1024)].map(
      (frame) => frame.messages.length,
    ),
    [16, 16, 8],
  );
  assert.throws(() => [...historyFrames('direct', [signed], [], 100)], /exceeds channel limit/);
});

test('replay IDs are scoped to their author', () => {
  const original = message();
  assert.equal(messageKey(original), messageKey({ ...original }));
  assert.notEqual(messageKey(original), messageKey({ ...original, from: bob.deviceId }));
});
