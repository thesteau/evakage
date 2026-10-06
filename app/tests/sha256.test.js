import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Sha256, hashChunks } from '../public/sha256.js';

const reference = (/** @type {Uint8Array} */ bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const hashOnce = (/** @type {Uint8Array} */ bytes) => new Sha256().update(bytes).hex();

test('matches node:crypto across sizes that straddle the block boundary', () => {
  // 0 and 64 are the empty/exact-block cases; 55/56/57 and 119/120/121 straddle
  // the point where the length padding needs an extra block.
  const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 255, 256, 1000, 65536, 65537, 200000];
  for (const size of sizes) {
    const bytes = crypto.randomBytes(size);
    assert.equal(hashOnce(bytes), reference(bytes), `size ${size}`);
  }
});

test('known-answer vectors', () => {
  assert.equal(
    hashOnce(Buffer.from('')),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
  assert.equal(
    hashOnce(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
  assert.equal(
    hashOnce(Buffer.from('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  );
});

test('streaming in arbitrary pieces equals hashing in one go', () => {
  const bytes = crypto.randomBytes(300000);
  for (const step of [1, 7, 63, 64, 65, 1024, 65536]) {
    const hash = new Sha256();
    for (let offset = 0; offset < bytes.length; offset += step) {
      hash.update(bytes.subarray(offset, Math.min(bytes.length, offset + step)));
    }
    assert.equal(hash.hex(), reference(bytes), `step ${step}`);
  }
});

test('hashChunks matches the concatenation of its chunks', () => {
  const chunks = [64, 65536, 3, 65536, 0, 17].map(size => new Uint8Array(crypto.randomBytes(size)));
  const joined = Buffer.concat(chunks.map(Buffer.from));
  assert.equal(hashChunks(chunks), reference(joined));
});

test('updates respect byteOffset on a shared ArrayBuffer', () => {
  // Chunks arrive as subarrays of a larger decrypted frame, so a view that does
  // not start at offset 0 has to hash as itself, not as the whole buffer.
  const backing = crypto.randomBytes(500);
  const slice = new Uint8Array(backing.buffer, backing.byteOffset + 100, 300);
  assert.equal(hashOnce(slice), reference(Buffer.from(backing.subarray(100, 400))));
});

test('a finalised hash refuses further use', () => {
  const hash = new Sha256();
  hash.update(new Uint8Array([1, 2, 3]));
  hash.digest();
  assert.throws(() => hash.update(new Uint8Array([4])), /already finalised/);
  assert.throws(() => hash.digest(), /already finalised/);
});
