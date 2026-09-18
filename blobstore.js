// Short-lived server-side buffer for file transfers.
//
// Why this exists: the direct DataChannel path needs ICE to succeed and both
// peers to be online at the same moment. On a routed LAN, behind a VPN, or with
// a restrictive firewall it can simply fail, and then nothing transfers at all.
// This gives every transfer a path that works regardless, and lets a sender
// hand off a file to a device that is not connected yet.
//
// What the server can see: the blob id, its ciphertext length, which devices are
// party to it, and one sealed envelope per recipient. It cannot read the file,
// the file name, its type, or its hash — all of that is inside the envelope,
// sealed to the recipient's long-lived key.
//
// Lifetime, in layers, deliberately overlapping:
//   1. the moment the last participant disconnects, the blob is unlinked;
//   2. once every recipient has saved its copy, it is unlinked;
//   3. an age sweep runs on a short interval and removes anything past its
//      maximum age (24h by default), so a blob whose participants never came
//      back cannot linger indefinitely — but a fresh blob is left alone;
//   4. on boot the directory is emptied, because any file on disk without an
//      in-memory record is unreachable garbage from a dead process.
// The directory lives inside the container and is never declared as a volume,
// so recreating the container is itself a fifth layer.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

export const BLOB_DEFAULTS = {
  dir: process.env.BLOB_DIR || path.join(os.tmpdir(), 'aria-drop-blobs'),
  maxBlobBytes: Number(process.env.MAX_FILE_BYTES || 512 * 1024 * 1024),
  maxStoreBytes: Number(process.env.BLOB_STORE_BYTES || 4 * 1024 * 1024 * 1024),
  maxBlobsPerDevice: Number(process.env.BLOB_PER_DEVICE || 32),
  // Maximum age. A blob younger than this survives a sweep; anything older is
  // removed whether or not its participants ever returned.
  maxAgeMs: Number(process.env.BLOB_MAX_AGE_MS || DAY_MS),
  // How often the age sweep runs. Short, so nothing overshoots its maximum age
  // by much — the age is the guarantee, not the interval.
  sweepEveryMs: Number(process.env.BLOB_SWEEP_MS || 15 * 60 * 1000)
};

const token = () => crypto.randomBytes(32).toString('base64url');

export function createBlobStore(options = {}) {
  const config = { ...BLOB_DEFAULTS, ...options };
  /** @type {Map<string, any>} */
  const blobs = new Map();
  let storeBytes = 0;
  /** Called with the blob record once an upload completes. @type {(blob: any) => void} */
  let onAvailable = () => {};

  function blobPath(id) {
    return path.join(config.dir, `${id}.bin`);
  }

  async function ready() {
    await fsp.mkdir(config.dir, { recursive: true });
    // Anything already here outlived the process that made it.
    await wipe('boot');
  }

  /** Deletes every file in the directory and forgets every record. */
  async function wipe(reason) {
    let removed = 0;
    let entries = [];
    try { entries = await fsp.readdir(config.dir); } catch { return { removed, reason }; }
    for (const entry of entries) {
      if (!entry.endsWith('.bin')) continue;
      try {
        await fsp.rm(path.join(config.dir, entry), { force: true });
        removed++;
      } catch {}
    }
    blobs.clear();
    storeBytes = 0;
    return { removed, reason };
  }

  async function remove(id) {
    const blob = blobs.get(id);
    if (!blob) return false;
    blobs.delete(id);
    storeBytes -= blob.written;
    if (storeBytes < 0) storeBytes = 0;
    try { await fsp.rm(blob.path, { force: true }); } catch {}
    return true;
  }

  /**
   * Reserves a blob. `envelopes` maps recipient device id -> sealed box; the
   * server treats each box as opaque bytes.
   */
  function offer({ senderId, conv, bytes, chunkSize, totalChunks, envelopes }) {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > config.maxBlobBytes) {
      return { error: 'That file is larger than this server accepts.' };
    }
    if (storeBytes + bytes > config.maxStoreBytes) {
      return { error: 'The server transfer buffer is full. Try again shortly.' };
    }
    const owned = [...blobs.values()].filter(blob => blob.senderId === senderId).length;
    if (owned >= config.maxBlobsPerDevice) {
      return { error: `Each device may buffer ${config.maxBlobsPerDevice} transfers at a time.` };
    }
    const recipients = Object.keys(envelopes);
    if (!recipients.length) return { error: 'No recipients for that transfer.' };

    const id = crypto.randomUUID();
    const blob = {
      id,
      senderId,
      conv,
      bytes,
      chunkSize,
      totalChunks,
      envelopes,
      recipients: new Set(recipients),
      // The sender counts as a participant: it may want to cancel or re-offer,
      // and its presence alone keeps the blob alive.
      participants: new Set([senderId, ...recipients]),
      released: new Set(),
      uploadToken: token(),
      downloadTokens: new Map(),
      path: blobPath(id),
      written: 0,
      complete: false,
      createdAt: Date.now()
    };
    blobs.set(id, blob);
    return { blob };
  }

  /** Streams an upload to disk, enforcing the declared length as a hard cap. */
  function receive(id, presentedToken, request) {
    return new Promise((resolve) => {
      const blob = blobs.get(id);
      if (!blob) return resolve({ status: 404, message: 'No such transfer.' });
      if (blob.complete) return resolve({ status: 409, message: 'That transfer is already uploaded.' });
      if (presentedToken !== blob.uploadToken) return resolve({ status: 403, message: 'Bad upload token.' });

      const out = fs.createWriteStream(blob.path, { flags: 'w' });
      let written = 0;
      let failed = false;

      const abort = (status, message) => {
        if (failed) return;
        failed = true;
        request.unpipe?.(out);
        out.destroy();
        remove(id);
        resolve({ status, message });
      };

      request.on('data', chunk => {
        written += chunk.length;
        // Never write past what was reserved, whatever the Content-Length said.
        if (written > blob.bytes) abort(413, 'Upload exceeded the declared length.');
      });
      request.on('error', () => abort(400, 'Upload failed.'));
      out.on('error', () => abort(500, 'Could not buffer that transfer.'));

      out.on('finish', () => {
        if (failed) return;
        if (written !== blob.bytes) {
          abort(400, 'Upload length did not match the declared length.');
          return;
        }
        blob.written = written;
        blob.complete = true;
        storeBytes += written;
        resolve({ status: 204, blob });
        onAvailable(blob);
      });

      request.pipe(out);
    });
  }

  /** Issues a one-blob download token to a participant. */
  function claim(id, deviceId) {
    const blob = blobs.get(id);
    if (!blob) return { error: 'That transfer is no longer available.' };
    if (!blob.participants.has(deviceId)) return { error: 'That transfer is not addressed to this device.' };
    if (!blob.complete) return { error: 'That transfer is still uploading.' };
    const issued = token();
    blob.downloadTokens.set(issued, deviceId);
    return {
      blob,
      downloadToken: issued,
      envelope: blob.envelopes[deviceId] || null
    };
  }

  function openForDownload(id, presentedToken) {
    const blob = blobs.get(id);
    if (!blob || !blob.complete) return { status: 404, message: 'No such transfer.' };
    if (!blob.downloadTokens.has(presentedToken)) return { status: 403, message: 'Bad download token.' };
    return { status: 200, blob };
  }

  /** A recipient that has saved its copy; the blob goes once all have. */
  async function release(id, deviceId) {
    const blob = blobs.get(id);
    if (!blob || !blob.participants.has(deviceId)) return false;
    blob.released.add(deviceId);
    const everyoneDone = [...blob.recipients].every(recipient => blob.released.has(recipient));
    if (everyoneDone) await remove(id);
    return true;
  }

  /** Blobs addressed to a device and ready to fetch. */
  function pendingFor(deviceId) {
    return [...blobs.values()]
      .filter(blob => blob.complete && blob.recipients.has(deviceId) && !blob.released.has(deviceId))
      .map(blob => describe(blob, deviceId));
  }

  function describe(blob, deviceId) {
    return {
      blobId: blob.id,
      from: blob.senderId,
      conv: blob.conv,
      bytes: blob.bytes,
      chunkSize: blob.chunkSize,
      totalChunks: blob.totalChunks,
      envelope: blob.envelopes[deviceId] || null,
      createdAt: blob.createdAt
    };
  }

  /**
   * The primary rule: a blob exists only while someone party to it is present.
   * `isConnected` is asked per device rather than cached, so this stays correct
   * regardless of how presence is tracked.
   */
  async function purgeUnattended(isConnected) {
    const purged = [];
    for (const blob of [...blobs.values()]) {
      const anyoneHere = [...blob.participants].some(deviceId => isConnected(deviceId));
      if (!anyoneHere) {
        await remove(blob.id);
        purged.push(blob.id);
      }
    }
    return purged;
  }

  /** Removes blobs past the maximum age; leaves younger ones in place. */
  async function sweepAged(maxAgeMs = config.maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    const purged = [];
    for (const blob of [...blobs.values()]) {
      if (blob.createdAt < cutoff) {
        await remove(blob.id);
        purged.push(blob.id);
      }
    }
    return purged;
  }

  function stats() {
    return { count: blobs.size, bytes: storeBytes, dir: config.dir };
  }

  return {
    config,
    blobs,
    ready,
    wipe,
    offer,
    receive,
    claim,
    openForDownload,
    release,
    remove,
    pendingFor,
    describe,
    purgeUnattended,
    sweepAged,
    stats,
    set onAvailable(handler) { onAvailable = typeof handler === 'function' ? handler : () => {}; }
  };
}
