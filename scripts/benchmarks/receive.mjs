// Node measurement of the production relay decryptor, not a phone RAM bound.
// node --expose-gc scripts/benchmarks/receive.mjs [MiB] [single|two-pass]
//
// single:   the in-memory path; plaintext is kept until Save.
// two-pass: the verify pass keeps only per-chunk digests; the save pass yields
//           verified chunks that are discarded as a disk write would consume them.
// Ciphertext is produced a chunk at a time from a resident source Blob, which
// is excluded from the baseline. The save pass re-encrypts the same source
// under the same key, as the server would serve a stored body.
import { performance } from 'node:perf_hooks';
import { hashBlob } from '../../dist/app/public/sha256.js';
import { createBodyDecryptor, encryptBodyChunks, generateContentKey, verifiedPlaintext } from '../../dist/app/public/relay.js';

const mib = Number(process.argv[2] || 64);
const mode = process.argv[3] || 'single';
if (!Number.isInteger(mib) || mib < 1 || mib > 256) throw new Error('Invalid size');
if (mode !== 'single' && mode !== 'two-pass') throw new Error('Mode is single or two-pass');
const chunkSize = 256 * 1024;
const fileId = 'receive-measurement';
const piece = new Uint8Array(1024 * 1024).fill(37);
const source = new Blob(Array.from({ length: mib }, () => piece));
const expected = await hashBlob(source, 64 * 1024);
const { key } = await generateContentKey();

async function* ciphertext() {
  for await (const part of encryptBodyChunks(source, key, fileId, chunkSize)) yield new Uint8Array(await part.arrayBuffer());
}

global.gc?.();
const baseline = process.memoryUsage();
let peakBuffers = baseline.arrayBuffers;
let peakRss = baseline.rss;
const sample = () => {
  global.gc?.();
  const now = process.memoryUsage();
  peakBuffers = Math.max(peakBuffers, now.arrayBuffers);
  peakRss = Math.max(peakRss, now.rss);
};

const start = performance.now();
const decryptor = createBodyDecryptor({ key, fileId, chunkSize, size: source.size, retain: mode === 'single' });
for await (const bytes of ciphertext()) {
  await decryptor.push(bytes);
  sample();
}
const verified = decryptor.finish();
const verifyMs = performance.now() - start;
if (verified.sha256 !== expected) throw new Error('Integrity mismatch');
const retainedBytes = verified.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) +
  verified.digests.reduce((sum, digest) => sum + digest.byteLength, 0);

let savedBytes = retainedBytes;
let saveMs = 0;
if (mode === 'two-pass') {
  const saveStart = performance.now();
  savedBytes = 0;
  for await (const chunk of verifiedPlaintext(ciphertext(),
    { key, fileId, chunkSize, size: source.size, sha256: verified.sha256, digests: verified.digests })) {
    savedBytes += chunk.byteLength;
    sample();
  }
  saveMs = performance.now() - saveStart;
  if (savedBytes !== source.size) throw new Error('Save pass length mismatch');
}

const toMiB = (/** @type {number} */ bytes) => Math.round(bytes / 1024 / 1024 * 100) / 100;
console.log(JSON.stringify({ sourceMiB: mib, mode,
  retainedAfterVerifyMiB: toMiB(retainedBytes), savedMiB: toMiB(savedBytes),
  peakArrayBuffersIncreaseMiB: Math.round((peakBuffers - baseline.arrayBuffers) / 1024 / 1024),
  peakRssIncreaseMiB: Math.round((peakRss - baseline.rss) / 1024 / 1024),
  verifyPassMs: Math.round(verifyMs), savePassMs: Math.round(saveMs), digest: verified.sha256,
  runtime: process.version, platform: process.platform, arch: process.arch }));
