// Local WebCrypto memory/timing measurement. Run modes in separate processes.
// node --expose-gc scripts/benchmarks/relay.mjs [buffered|chunked] [MiB]
import { performance } from 'node:perf_hooks';
import { hashBlob } from '../../dist/app/public/sha256.js';
import { encryptBody, encryptBodyChunks, generateContentKey } from '../../dist/app/public/relay.js';
const mode = process.argv[2] || 'chunked';
const mib = Number(process.argv[3] || 64);
if (!['buffered', 'chunked'].includes(mode) || !Number.isInteger(mib) || mib < 1 || mib > 256) throw new Error('Invalid benchmark parameters');
const piece = new Uint8Array(1024 * 1024).fill(37);
const source = new Blob(Array.from({ length: mib }, () => piece));
const { key } = await generateContentKey();
global.gc?.();
let baseline = process.memoryUsage().rss;
let bufferBaseline = process.memoryUsage().arrayBuffers;
let peakBuffers = bufferBaseline;
let peak = baseline;
const sample = () => {
  global.gc?.();
  const memory = process.memoryUsage();
  peak = Math.max(peak, memory.rss);
  peakBuffers = Math.max(peakBuffers, memory.arrayBuffers);
};
const beginHash = performance.now();
const digest = await hashBlob(source, 64 * 1024);
const hashMs = performance.now() - beginHash;
global.gc?.();
baseline = process.memoryUsage().rss;
bufferBaseline = process.memoryUsage().arrayBuffers;
peak = baseline; peakBuffers = bufferBaseline;
const start = performance.now();
let encryptedBytes = 0;
if (mode === 'buffered') {
  const body = await encryptBody(source, key, 'benchmark-file', 256 * 1024, sample);
  encryptedBytes = body.size;
  sample();
} else {
  for await (const part of encryptBodyChunks(source, key, 'benchmark-file', 256 * 1024)) {
    encryptedBytes += part.size;
    // Materialize just the current HTTP body, as the browser does for a PUT.
    await part.arrayBuffer();
    sample();
    global.gc?.();
  }
}
console.log(JSON.stringify({ mode, sourceMiB: mib, chunkKiB: 256,
  hashMs: Math.round(hashMs), encryptMs: Math.round(performance.now() - start),
  peakArrayBuffersIncreaseMiB: Math.round((peakBuffers - bufferBaseline) / 1024 / 1024),
  peakRssIncreaseMiB: Math.round((peak - baseline) / 1024 / 1024), encryptedBytes,
  digest, runtime: process.version, platform: process.platform, arch: process.arch }));
