import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairingCodes, PAIRING_CODE_MAX_AGE_MS } from '../server/server.js';

test('private invitation codes resolve before expiry and are refused at the exact boundary', () => {
  let now = 1000;
  const codes = createPairingCodes(() => now);
  const entry = codes.issue('device-a');
  assert.match(entry.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(entry.expiresAt, now + PAIRING_CODE_MAX_AGE_MS);
  assert.equal(codes.resolve(` ${entry.code.toLowerCase()} `), 'device-a');
  now = entry.expiresAt - 1;
  assert.deepEqual(codes.issue('device-a'), entry);
  assert.equal(codes.resolve(entry.code), 'device-a');
  now++;
  assert.equal(codes.resolve(entry.code), null);
  const next = codes.issue('device-a');
  assert.equal(next.expiresAt, now + PAIRING_CODE_MAX_AGE_MS);
  assert.equal(codes.resolve(next.code), 'device-a');
});

test('invitation codes are unique across devices and pruning invalidates expired records', () => {
  let now = 1;
  const codes = createPairingCodes(() => now);
  const entries = Array.from({ length: 100 }, (_, i) => codes.issue(`device-${i}`));
  assert.equal(new Set(entries.map(entry => entry.code)).size, entries.length);
  entries.forEach((entry, i) => assert.equal(codes.resolve(entry.code), `device-${i}`));
  assert.equal(codes.resolve('NOT-A-CODE'), null);
  now += PAIRING_CODE_MAX_AGE_MS;
  codes.prune();
  entries.forEach(entry => assert.equal(codes.resolve(entry.code), null));
});
