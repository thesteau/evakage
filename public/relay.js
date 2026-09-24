// Cryptography for server-relayed transfers. Pure functions over WebCrypto, so
// they run unchanged in the browser and in the Node test suite.
//
// Layout of a relayed file:
//   envelope  sealed to the recipient's long-lived seal key, one per recipient.
//             Inside: file metadata, the random content key, the plaintext
//             SHA-256, all signed by the sender's identity key.
//   body      the file in chunks, each  IV(12) || AES-256-GCM(chunk) || tag(16),
//             with the file id, chunk index and chunk count bound as AAD so
//             chunks cannot be reordered, swapped between files, or dropped.
//
// The server holds only the body and the sealed envelopes. It learns sizes and
// who is talking to whom; it cannot read the file, its name, type or hash, and
// it cannot forge a file that verifies as coming from someone else.

import {
  seal,
  unseal,
  generateContentKey,
  importContentKey,
  signTranscript,
  verifyTranscript,
  fingerprintOf,
  bytesToBase64,
  base64ToBytes
} from './identity.js';
import { Sha256 } from './sha256.js';

const ENVELOPE_CONTEXT = 'aria-drop/envelope/1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const CHUNK_OVERHEAD = IV_BYTES + TAG_BYTES;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Ciphertext size and chunk count for a plaintext of `size` bytes.
 * @param {number} size @param {number} chunkSize */
export function cipherLayout(size, chunkSize) {
  const totalChunks = Math.ceil(size / chunkSize);
  return { totalChunks, bytes: size + totalChunks * CHUNK_OVERHEAD };
}

/** @param {string} fileId @param {number} index @param {number} totalChunks */
function chunkAad(fileId, index, totalChunks) {
  return encoder.encode(`aria-drop/blob/1|${fileId}|${index}|${totalChunks}`);
}

/**
 * Seals a signed payload to one recipient. The signed payload is carried as the
 * exact string that was signed, so the recipient verifies bytes rather than a
 * re-serialisation of parsed JSON. `kind` is inside the signature, so a message
 * can never be replayed as a file or the other way round.

 * @param {import('./types.js').SealOptions & {kind: string, body: object}} options */
async function sealSigned({ identity, recipientId, recipientSealRaw, conv, kind, body }) {
  const inner = JSON.stringify({
    v: 1,
    kind,
    to: recipientId,
    from: identity.deviceId,
    senderIdentityKey: identity.identityKey,
    conv,
    ...body
  });
  const signature = await signTranscript(identity.privateKey, `${ENVELOPE_CONTEXT}|${inner}`);
  return seal(recipientSealRaw, encoder.encode(JSON.stringify({ inner, signature })));
}

/**
 * Opens a signed envelope and checks everything a hostile server could tamper
 * with: that it was addressed to us, that it is the kind we expected, that the
 * claimed sender's key hashes to the sender id the server reported, and that the
 * sender actually signed it.

 * @param {import('./types.js').OpenOptions & {kind: string}} options */
async function openSigned({ sealPrivateKey, box, selfId, expectedFrom, kind }) {
  const outer = JSON.parse(decoder.decode(await unseal(sealPrivateKey, box)));
  if (typeof outer?.inner !== 'string' || typeof outer?.signature !== 'string') {
    throw new Error('Malformed envelope');
  }
  const meta = JSON.parse(outer.inner);
  if (meta.v !== 1) throw new Error('Unsupported envelope version');
  if (meta.kind !== kind) throw new Error(`Expected a ${kind} envelope`);
  if (meta.to !== selfId) throw new Error('Envelope is addressed to another device');
  if (meta.from !== expectedFrom) throw new Error('Envelope sender does not match the relaying server');

  const senderKeyRaw = base64ToBytes(meta.senderIdentityKey);
  if (await fingerprintOf(senderKeyRaw) !== meta.from) {
    throw new Error("Sender key does not match the sender's device id");
  }
  const signed = await verifyTranscript(senderKeyRaw, outer.signature, `${ENVELOPE_CONTEXT}|${outer.inner}`);
  if (!signed) throw new Error('Envelope signature does not verify');
  return meta;
}

/** Sealed, signed envelope carrying a file's metadata and content key.
 * @param {import('./types.js').SealOptions & {meta: import('./types.js').FileMeta & {chunkSize: number}, contentKeyRaw: Uint8Array}} options */
export function buildEnvelope({ identity, recipientId, recipientSealRaw, meta, contentKeyRaw, conv }) {
  return sealSigned({
    identity,
    recipientId,
    recipientSealRaw,
    conv,
    kind: 'file',
    body: {
      fileId: meta.id,
      name: meta.name,
      size: meta.size,
      type: meta.type,
      sha256: meta.sha256,
      chunkSize: meta.chunkSize,
      totalChunks: meta.totalChunks,
      addedAt: meta.addedAt,
      fromName: meta.fromName || '',
      contentKey: bytesToBase64(contentKeyRaw)
    }
  });
}

/** Sealed, signed envelope carrying one chat message.
 * @param {import('./types.js').SealOptions & {message: Omit<import('./types.js').Message, 'from'>}} options */
export function buildMessageEnvelope({ identity, recipientId, recipientSealRaw, conv, message }) {
  return sealSigned({
    identity,
    recipientId,
    recipientSealRaw,
    conv,
    kind: 'message',
    body: {
      message: {
        id: message.id,
        text: message.text,
        at: message.at,
        fromName: message.fromName || ''
      }
    }
  });
}

/**
 * Opens a message envelope. The author is taken from the verified signature,
 * never from the message body, so a relayed message cannot claim to be from
 * anyone other than the device that signed it.

 * @param {import('./types.js').OpenOptions & {maxChars?: number}} options */
export async function openMessageEnvelope({ sealPrivateKey, box, selfId, expectedFrom, maxChars = 20000 }) {
  const meta = await openSigned({ sealPrivateKey, box, selfId, expectedFrom, kind: 'message' });
  const message = meta.message;
  if (!message || typeof message !== 'object') throw new Error('Envelope carries no message');
  if (typeof message.id !== 'string' || !message.id || message.id.length > 64) throw new Error('Bad message id');
  if (typeof message.text !== 'string' || message.text.length > maxChars) throw new Error('Bad message text');
  return {
    conv: meta.conv,
    message: {
      id: message.id,
      text: message.text,
      at: Number(message.at) || Date.now(),
      from: meta.from,
      fromName: typeof message.fromName === 'string' ? message.fromName.slice(0, 64) : ''
    }
  };
}

/** Opens a file envelope and validates the metadata it carries.
 * @param {import('./types.js').OpenOptions} options */
export async function openEnvelope({ sealPrivateKey, box, selfId, expectedFrom }) {
  const meta = await openSigned({ sealPrivateKey, box, selfId, expectedFrom, kind: 'file' });

  if (!Number.isInteger(meta.size) || meta.size < 0) throw new Error('Bad size');
  if (!Number.isInteger(meta.chunkSize) || meta.chunkSize <= 0) throw new Error('Bad chunk size');
  if (meta.totalChunks !== Math.ceil(meta.size / meta.chunkSize)) throw new Error('Chunk count mismatch');
  if (!/^[0-9a-f]{64}$/.test(meta.sha256 || '')) throw new Error('Bad digest');

  if (typeof meta.fileId !== 'string' || !meta.fileId || meta.fileId.length > 64) throw new Error('Bad file id');

  const contentKey = await importContentKey(base64ToBytes(meta.contentKey));
  // Return the same shape the rest of the app uses for file records (`id`, not
  // the envelope's `fileId`), and never hand the raw content key back out.
  const { contentKey: _contentKey, fileId, ...rest } = meta;
  return { meta: { ...rest, id: fileId }, contentKey };
}

export { generateContentKey };

/** Encrypts a Blob chunk by chunk; returns the ciphertext as a Blob.
 * @param {Blob} blob @param {CryptoKey} key @param {string} fileId @param {number} chunkSize @param {(fraction: number) => void} [onProgress] */
export async function encryptBody(blob, key, fileId, chunkSize, onProgress) {
  const totalChunks = Math.ceil(blob.size / chunkSize);
  /** @type {BlobPart[]} */
  const parts = [];
  for (let index = 0; index < totalChunks; index++) {
    const start = index * chunkSize;
    const plain = new Uint8Array(await blob.slice(start, Math.min(blob.size, start + chunkSize)).arrayBuffer());
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: chunkAad(fileId, index, totalChunks) },
      key,
      plain
    );
    parts.push(iv, new Uint8Array(cipher));
    onProgress?.((index + 1) / totalChunks);
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

/**
 * Incremental decryptor: feed it ciphertext as it arrives from the network and
 * it decrypts each chunk as soon as the chunk is complete. Peak memory is the
 * plaintext plus one chunk, rather than the whole ciphertext and plaintext.

 * @param {{key: CryptoKey, fileId: string, chunkSize: number, size: number}} options */
export function createBodyDecryptor({ key, fileId, chunkSize, size }) {
  const totalChunks = Math.ceil(size / chunkSize);
  const hash = new Sha256();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let pending = new Uint8Array(0);
  let index = 0;

  const nextLength = () => IV_BYTES + Math.min(chunkSize, size - index * chunkSize) + TAG_BYTES;

  async function drain() {
    while (index < totalChunks && pending.length >= nextLength()) {
      const length = nextLength();
      const iv = pending.subarray(0, IV_BYTES);
      const cipher = pending.subarray(IV_BYTES, length);
      const plain = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: chunkAad(fileId, index, totalChunks) },
        key,
        cipher
      ));
      hash.update(plain);
      chunks.push(plain);
      pending = pending.slice(length);
      index++;
    }
  }

  return {
    get progress() { return totalChunks ? index / totalChunks : 1; },
    async push(/** @type {Uint8Array} */ bytes) {
      const merged = new Uint8Array(pending.length + bytes.length);
      merged.set(pending, 0);
      merged.set(bytes, pending.length);
      pending = merged;
      await drain();
      if (index >= totalChunks && pending.length) throw new Error('Trailing bytes after the last chunk');
    },
    finish() {
      if (index !== totalChunks || pending.length) throw new Error('Transfer ended before every chunk arrived');
      return { chunks, sha256: hash.hex() };
    }
  };
}
