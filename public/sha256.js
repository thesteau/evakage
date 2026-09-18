// Streaming SHA-256 (FIPS 180-4).
//
// WebCrypto's digest() is one-shot: it needs the whole file resident as one
// ArrayBuffer, which defeats the point of chunked transfer for large files.
// This hashes 64 KiB at a time so a 500 MB transfer never materialises more
// than one chunk. It is used only for integrity, never for secrecy — the
// payload encryption stays on crypto.subtle.
//
// tests/sha256.test.js checks this against node:crypto across sizes and
// chunk boundaries.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));

export class Sha256 {
  #h = new Uint32Array(INITIAL);
  #w = new Uint32Array(64);
  #block = new Uint8Array(64);
  #blockView = new DataView(this.#block.buffer);
  #pending = 0;
  #bytes = 0;
  #done = false;

  update(bytes) {
    if (this.#done) throw new Error('Sha256 already finalised');
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.#bytes += input.length;
    let offset = 0;

    if (this.#pending) {
      const wanted = Math.min(64 - this.#pending, input.length);
      this.#block.set(input.subarray(0, wanted), this.#pending);
      this.#pending += wanted;
      offset = wanted;
      if (this.#pending < 64) return this;
      this.#compress(this.#blockView, 0);
      this.#pending = 0;
    }

    // Read whole blocks straight out of the caller's buffer where possible.
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    while (offset + 64 <= input.length) {
      this.#compress(view, offset);
      offset += 64;
    }

    if (offset < input.length) {
      this.#block.set(input.subarray(offset), 0);
      this.#pending = input.length - offset;
    }
    return this;
  }

  digest() {
    if (this.#done) throw new Error('Sha256 already finalised');
    this.#done = true;
    const bits = this.#bytes * 8;
    const tail = new Uint8Array(this.#pending < 56 ? 64 : 128);
    tail.set(this.#block.subarray(0, this.#pending), 0);
    tail[this.#pending] = 0x80;
    const tailView = new DataView(tail.buffer);
    tailView.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
    tailView.setUint32(tail.length - 4, bits >>> 0);
    for (let offset = 0; offset < tail.length; offset += 64) this.#compress(tailView, offset);

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.#h[i]);
    return out;
  }

  hex() {
    return [...this.digest()].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  #compress(view, offset) {
    const w = this.#w;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    const h = this.#h;
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g; g = f; f = e;
      e = (d + t1) | 0;
      d = c; c = b; b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }
}

// Hash a Blob/File without ever holding more than one chunk in memory.
export async function hashBlob(blob, chunkSize = 64 * 1024, onProgress) {
  const hash = new Sha256();
  for (let start = 0; start < blob.size; start += chunkSize) {
    const end = Math.min(blob.size, start + chunkSize);
    hash.update(new Uint8Array(await blob.slice(start, end).arrayBuffer()));
    onProgress?.(end / Math.max(1, blob.size));
  }
  return hash.hex();
}

// Hash an ordered array of chunk buffers, as held by a receiver mid-transfer.
export function hashChunks(chunks) {
  const hash = new Sha256();
  for (const chunk of chunks) hash.update(chunk);
  return hash.hex();
}
