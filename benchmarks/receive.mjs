// Node measurement of the production relay decryptor, not a phone RAM bound.
// node --expose-gc benchmarks/receive.mjs [MiB]
import { performance } from 'node:perf_hooks';
import { hashBlob } from '../public/sha256.js';
import { createBodyDecryptor, encryptBodyChunks, generateContentKey } from '../public/relay.js';

const mib = Number(process.argv[2] || 64);
if (!Number.isInteger(mib) || mib < 1 || mib > 256) throw new Error('Invalid size');
const piece = new Uint8Array(1024 * 1024).fill(37);
const source = new Blob(Array.from({ length: mib }, () => piece));
const expected = await hashBlob(source, 64 * 1024);
const { key } = await generateContentKey();
const decryptor = createBodyDecryptor({ key, fileId: 'receive-measurement', chunkSize: 256 * 1024, size: source.size });
global.gc?.();
const baseline = process.memoryUsage();
let peakBuffers = baseline.arrayBuffers;
let peakRss = baseline.rss;
const start = performance.now();
for await (const part of encryptBodyChunks(source, key, 'receive-measurement', 256 * 1024)) {
  await decryptor.push(new Uint8Array(await part.arrayBuffer()));
  global.gc?.();
  const sample = process.memoryUsage();
  peakBuffers = Math.max(peakBuffers, sample.arrayBuffers);
  peakRss = Math.max(peakRss, sample.rss);
}
const { chunks, sha256 } = decryptor.finish();
const retainedBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
if (sha256 !== expected || retainedBytes !== source.size) throw new Error('Integrity mismatch');
console.log(JSON.stringify({ sourceMiB: mib, retainedPlaintextMiB: retainedBytes / 1024 / 1024,
  peakArrayBuffersIncreaseMiB: Math.round((peakBuffers - baseline.arrayBuffers) / 1024 / 1024),
  peakRssIncreaseMiB: Math.round((peakRss - baseline.rss) / 1024 / 1024),
  encryptAndReceiveMs: Math.round(performance.now() - start), digest: sha256,
  runtime: process.version, platform: process.platform, arch: process.arch }));
