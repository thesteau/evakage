import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame, CONTROL_KIND, FILE_CHUNK_KIND } from '../../app/client/ts/frames.js';

const limits = { controlBytes: 1024, chunkBytes: 64, fileChunks: 32 };
const valid = { conv: 'direct', id: 'file', t: 'transfer', seq: 0, total: 2 };

function chunk(header: unknown = valid, size = 3) {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(5 + json.length + size);
  frame[0] = FILE_CHUNK_KIND;
  new DataView(frame.buffer).setUint32(1, json.length);
  frame.set(json, 5);
  frame.fill(123, 5 + json.length);
  return frame;
}

test('malformed file frames are rejected without modifying input', () => {
  const bad = [
    new Uint8Array(),
    new Uint8Array([99]),
    ...[1, 2, 3, 4].map((n) => {
      const frame = new Uint8Array(n);
      frame[0] = FILE_CHUNK_KIND;
      return frame;
    }),
  ];
  for (const header of [
    null,
    [],
    42,
    'bad',
    {},
    { ...valid, seq: -1 },
    { ...valid, seq: 2 },
    { ...valid, seq: 0.5 },
    { ...valid, total: 33 },
    { ...valid, total: 0 },
    { ...valid, total: '2' },
    { ...valid, id: null },
  ])
    {bad.push(chunk(header));}
  bad.push(chunk(valid, 65));
  for (const length of [0, 1, 1025, 0xffffffff]) {
    const frame = chunk();
    new DataView(frame.buffer).setUint32(1, length);
    bad.push(frame);
  }
  for (const frame of bad) {
    const before = frame.slice();
    assert.equal(parseFrame(frame, limits), null);
    assert.deepEqual(frame, before);
  }
  // A malformed frame cannot poison the next valid frame.
  const parsed = parseFrame(chunk(), limits);
  assert.equal(parsed?.kind, 'chunk');
  assert.deepEqual(parsed?.header, valid);
  assert.deepEqual([...parsed.bytes], [123, 123, 123]);
});

test('control frames are bounded JSON objects and offsets are respected', () => {
  for (const json of ['null', '[]', '42', '"bad"', '{broken']) {
    assert.equal(
      parseFrame(Uint8Array.of(CONTROL_KIND, ...new TextEncoder().encode(json)), limits),
      null,
    );
  }
  const oversized = new Uint8Array(1025).fill(32);
  oversized[0] = CONTROL_KIND;
  assert.equal(parseFrame(oversized, limits), null);
  const control = Uint8Array.of(
    CONTROL_KIND,
    ...new TextEncoder().encode('{"type":"chat","conv":"direct"}'),
  );
  assert.equal(parseFrame(control, limits)?.message.type, 'chat');
  const padded = new Uint8Array(chunk().length + 15);
  padded.set(chunk(), 7);
  assert.deepEqual(
    parseFrame(padded.subarray(7, padded.length - 8), limits),
    parseFrame(chunk(), limits),
  );
});

test('seeded arbitrary bytes and every truncation are safe to decode', () => {
  let seed = 20260924;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 3000; i++) {
    const frame = Uint8Array.from({ length: random() % 256 }, () => random() & 255);
    assert.doesNotThrow(() => parseFrame(frame, limits));
  }
  const frame = chunk();
  const headerEnd = frame.length - 3;
  for (let end = 0; end < headerEnd; end++)
    {assert.equal(parseFrame(frame.subarray(0, end), limits), null);}
});
