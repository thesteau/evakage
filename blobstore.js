// Short-lived server-side buffer for relayed files and chat messages.
//
// Why this exists: the direct DataChannel path needs ICE to succeed and both
// peers to be online at the same moment. On a routed LAN, behind a VPN, or with
// a restrictive firewall it can simply fail, and then nothing gets through at
// all. This gives files and messages a path that works regardless.
//
// What the server can see: item ids, ciphertext lengths, which devices are party
// to each item, and when. Every item carries one sealed envelope per recipient;
// the server cannot read a message, a file, its name, its type, or its hash, and
// it cannot forge one — envelopes are sealed to the recipient and signed by the
// sender.
//
// On disk, one directory per conversation:
//   BLOB_DIR/<conversation>/<item>.env.json   sealed envelopes, one per recipient
//   BLOB_DIR/<conversation>/<item>.bin        ciphertext body (files only)
// Keeping envelopes on disk rather than in memory keeps the server's RAM flat
// however many messages are waiting.
//
// Lifetime:
//   1. once every recipient has taken its copy, the item is unlinked early;
//   2. otherwise it stays — including after every device has disconnected, so a
//      device that comes back within the window still receives what was sent
//      to it — until it passes its maximum age (24h by default);
//   3. the age sweep runs on a short interval, removes aged items, and removes
//      any empty directory it finds, so a conversation whose items have all gone
//      disappears as a whole;
//   4. on boot everything is erased: item records live in memory, so anything on
//      disk from a previous process is unreachable.
// The directory lives inside the container and is never declared as a volume,
// so recreating the container erases it too.

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
  // Messages are small and frequent, so they get their own, larger budget.
  maxMessagesPerDevice: Number(process.env.BLOB_MESSAGES_PER_DEVICE || 2000),
  // Maximum age. Anything younger survives a sweep; anything older is removed
  // whether or not its recipients ever came back.
  maxAgeMs: Number(process.env.BLOB_MAX_AGE_MS || DAY_MS),
  // How often the age sweep runs. Short, so nothing overshoots its maximum age
  // by much — the age is the guarantee, not the interval.
  sweepEveryMs: Number(process.env.BLOB_SWEEP_MS || 15 * 60 * 1000)
};

const token = () => crypto.randomBytes(32).toString('base64url');

/**
 * Directory name for a conversation. A direct conversation is keyed on both
 * devices so it is the same directory whichever of them sends; hashing keeps
 * the name fixed-length and free of anything a path could misread.
 */
export function conversationKey(conv, participants) {
  if (typeof conv === 'string' && conv.startsWith('room:')) {
    return `r-${crypto.createHash('sha256').update(conv).digest('hex').slice(0, 32)}`;
  }
  const pair = [...participants].sort().join('|');
  return `d-${crypto.createHash('sha256').update(pair).digest('hex').slice(0, 32)}`;
}

async function removeIfEmpty(dir) {
  // rmdir refuses a non-empty directory, which is exactly the check we want,
  // done atomically instead of list-then-delete.
  try {
    await fsp.rmdir(dir);
    return true;
  } catch {
    return false;
  }
}

export function createBlobStore(options = {}) {
  const config = { ...BLOB_DEFAULTS, ...options };
  /** @type {Map<string, any>} */
  const blobs = new Map();
  let storeBytes = 0;
  /** Called with an item record once it is ready to deliver. @type {(blob: any) => void} */
  let onAvailable = () => {};

  async function ready() {
    await fsp.mkdir(config.dir, { recursive: true });
    await wipe('boot');
  }

  /** Erases every conversation directory and forgets every record. */
  async function wipe(reason) {
    let removed = 0;
    let entries = [];
    try { entries = await fsp.readdir(config.dir); } catch { return { removed, reason }; }
    for (const entry of entries) {
      try {
        await fsp.rm(path.join(config.dir, entry), { recursive: true, force: true });
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
    storeBytes = Math.max(0, storeBytes - blob.written - blob.envelopeBytes);
    await fsp.rm(blob.path, { force: true }).catch(() => {});
    await fsp.rm(blob.envelopePath, { force: true }).catch(() => {});
    await removeIfEmpty(blob.convDir);
    return true;
  }

  async function readEnvelope(blob, deviceId) {
    try {
      const all = JSON.parse(await fsp.readFile(blob.envelopePath, 'utf8'));
      return all[deviceId] || null;
    } catch {
      return null;
    }
  }

  /**
   * Reserves an item. `envelopes` maps recipient device id -> sealed box; the
   * server treats each box as opaque. A message is complete on arrival; a file
   * waits for its body to be uploaded.
   */
  async function offer({ senderId, conv, kind = 'file', bytes, chunkSize, totalChunks, envelopes }) {
    const isMessage = kind === 'message';
    if (isMessage) {
      if (bytes !== 0 || totalChunks !== 0) return { error: 'A relayed message carries no body.' };
    } else {
      // The limit is on the file, but what arrives is ciphertext: each chunk
      // adds a 12-byte IV and a 16-byte GCM tag. Allow exactly that overhead so
      // a file at the limit still fits.
      const allowed = config.maxBlobBytes + totalChunks * 28;
      if (!Number.isInteger(bytes) || bytes < 0 || bytes > allowed) {
        return { error: 'That file is larger than this server accepts.' };
      }
      if (totalChunks !== Math.ceil(Math.max(0, bytes - totalChunks * 28) / chunkSize)) {
        return { error: 'Chunk count does not match the declared size.' };
      }
    }

    const envelopeJson = JSON.stringify(envelopes);
    const envelopeBytes = Buffer.byteLength(envelopeJson);
    if (storeBytes + bytes + envelopeBytes > config.maxStoreBytes) {
      return { error: 'The server relay is full. Try again shortly.' };
    }

    const owned = [...blobs.values()].filter(blob => blob.senderId === senderId && blob.kind === kind).length;
    const cap = isMessage ? config.maxMessagesPerDevice : config.maxBlobsPerDevice;
    if (owned >= cap) {
      return {
        error: isMessage
          ? `This device already has ${cap} messages waiting on the server.`
          : `Each device may buffer ${cap} transfers at a time.`
      };
    }

    const recipients = Object.keys(envelopes);
    if (!recipients.length) return { error: 'No recipients.' };

    const id = crypto.randomUUID();
    const participants = new Set([senderId, ...recipients]);
    const convDir = path.join(config.dir, conversationKey(conv, participants));
    const blob = {
      id,
      kind,
      senderId,
      conv,
      bytes,
      chunkSize,
      totalChunks,
      recipients: new Set(recipients),
      participants,
      released: new Set(),
      uploadToken: token(),
      downloadTokens: new Map(),
      convDir,
      path: path.join(convDir, `${id}.bin`),
      envelopePath: path.join(convDir, `${id}.env.json`),
      envelopeBytes,
      written: 0,
      complete: isMessage,
      createdAt: Date.now()
    };

    // A release elsewhere in this conversation can remove the directory the
    // instant it empties, which may fall between our mkdir and our write.
    for (let attempt = 0; ; attempt++) {
      await fsp.mkdir(convDir, { recursive: true });
      try {
        await fsp.writeFile(blob.envelopePath, envelopeJson);
        break;
      } catch (err) {
        if (err?.code !== 'ENOENT' || attempt >= 3) throw err;
      }
    }
    blobs.set(id, blob);
    storeBytes += envelopeBytes;
    if (isMessage) onAvailable(blob);
    return { blob };
  }

  /** Streams an upload to disk, enforcing the declared length as a hard cap. */
  function receive(id, presentedToken, request) {
    return new Promise((resolve) => {
      const blob = blobs.get(id);
      if (!blob || blob.kind !== 'file') return resolve({ status: 404, message: 'No such transfer.' });
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

  /** Issues a one-item download token to a participant. */
  async function claim(id, deviceId) {
    const blob = blobs.get(id);
    if (!blob) return { error: 'That transfer is no longer available.' };
    if (!blob.participants.has(deviceId)) return { error: 'That transfer is not addressed to this device.' };
    if (!blob.complete) return { error: 'That transfer is still uploading.' };
    const issued = token();
    blob.downloadTokens.set(issued, deviceId);
    return { blob, downloadToken: issued, envelope: await readEnvelope(blob, deviceId) };
  }

  function openForDownload(id, presentedToken) {
    const blob = blobs.get(id);
    if (!blob || !blob.complete || blob.kind !== 'file') return { status: 404, message: 'No such transfer.' };
    if (!blob.downloadTokens.has(presentedToken)) return { status: 403, message: 'Bad download token.' };
    return { status: 200, blob };
  }

  /** A recipient that has its copy; the item goes once every recipient has. */
  async function release(id, deviceId) {
    const blob = blobs.get(id);
    if (!blob || !blob.recipients.has(deviceId)) return false;
    blob.released.add(deviceId);
    const everyoneDone = [...blob.recipients].every(recipient => blob.released.has(recipient));
    if (everyoneDone) await remove(id);
    return true;
  }

  /** Items addressed to a device that it has not yet taken, oldest first. */
  async function pendingFor(deviceId) {
    const ready = [...blobs.values()]
      .filter(blob => blob.complete && blob.recipients.has(deviceId) && !blob.released.has(deviceId))
      .sort((a, b) => a.createdAt - b.createdAt);
    return Promise.all(ready.map(blob => describe(blob, deviceId)));
  }

  async function describe(blob, deviceId) {
    return {
      blobId: blob.id,
      kind: blob.kind,
      from: blob.senderId,
      conv: blob.conv,
      bytes: blob.bytes,
      chunkSize: blob.chunkSize,
      totalChunks: blob.totalChunks,
      envelope: await readEnvelope(blob, deviceId),
      createdAt: blob.createdAt
    };
  }

  /**
   * Removes items past the maximum age, then any empty directory left behind,
   * whatever emptied it. Younger items are left alone.
   */
  async function sweepAged(maxAgeMs = config.maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    const purged = [];
    for (const blob of [...blobs.values()]) {
      if (blob.createdAt < cutoff) {
        await remove(blob.id);
        purged.push(blob.id);
      }
    }
    await removeEmptyDirectories();
    return purged;
  }

  async function removeEmptyDirectories() {
    let entries = [];
    try { entries = await fsp.readdir(config.dir, { withFileTypes: true }); } catch { return 0; }
    let removed = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && await removeIfEmpty(path.join(config.dir, entry.name))) removed++;
    }
    return removed;
  }

  function stats() {
    const all = [...blobs.values()];
    return {
      count: all.length,
      files: all.filter(blob => blob.kind === 'file').length,
      messages: all.filter(blob => blob.kind === 'message').length,
      bytes: storeBytes,
      dir: config.dir
    };
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
    sweepAged,
    removeEmptyDirectories,
    stats,
    set onAvailable(handler) { onAvailable = typeof handler === 'function' ? handler : () => {}; }
  };
}

/**
 * The one-shot sweep behind `node server.js --sweep-blobs`, for a host cron.
 * It runs in a separate process with no in-memory records, so it judges age by
 * each file's mtime, then removes any directory it leaves empty.
 */
export async function sweepDirectory(dir, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let kept = 0;
  let directories = 0;

  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return { removed, kept, directories };
    throw err;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const files = entry.isDirectory()
      ? (await fsp.readdir(full).catch(() => [])).map(name => path.join(full, name))
      : [full];
    for (const file of files) {
      const info = await fsp.stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      if (info.mtimeMs < cutoff) {
        await fsp.rm(file, { force: true });
        removed++;
      } else {
        kept++;
      }
    }
    if (entry.isDirectory() && await removeIfEmpty(full)) directories++;
  }
  return { removed, kept, directories };
}
