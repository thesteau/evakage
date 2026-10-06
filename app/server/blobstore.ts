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
//      to it — until the conversation's idle/solo deadline or the item's
//      maximum age (3 days by default). Self-chat keeps read copies, with a
//      24-hour offline deadline and an age limit of at most 3 days;
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

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const BLOB_DEFAULTS = {
  dir: process.env.BLOB_DIR || path.join(os.tmpdir(), 'evakage-blobs'),
  maxBlobBytes: Number(process.env.MAX_FILE_BYTES || 512 * 1024 * 1024),
  maxStoreBytes: Number(process.env.BLOB_STORE_BYTES || 4 * 1024 * 1024 * 1024),
  maxBlobsPerDevice: Number(process.env.BLOB_PER_DEVICE || 32),
  // Messages are small and frequent, so they get their own, larger budget.
  maxMessagesPerDevice: Number(process.env.BLOB_MESSAGES_PER_DEVICE || 2000),
  // An item lives with its conversation: while any device party to it is
  // connected, it stays, however old it gets. Once they have all gone it is on
  // borrowed time, and this is how much — long enough to survive a locked
  // phone, a reload or a wifi drop, short enough that an ended session does not
  // leave ciphertext lying around.
  idleGraceMs: Number(process.env.BLOB_IDLE_GRACE_MS || 15 * MINUTE_MS),
  // A one-to-one conversation where only one device is present is a half-open
  // session: someone waiting for a peer that is not here. It is allowed to wait
  // this long, and no longer — otherwise a browser left open keeps a dead
  // pairing, and its ciphertext, alive indefinitely. Rooms are exempt: a room
  // with one member connected is a room, not a stalled transfer.
  soloMaxMs: Number(process.env.BLOB_SOLO_MAX_MS || 3 * HOUR_MS),
  // The ceiling, so "the session never ended" cannot mean "kept forever". A
  // conversation held open for three days has outlived its usefulness; start a
  // new one rather than leaning on this.
  maxAgeMs: Number(process.env.BLOB_MAX_AGE_MS || 3 * DAY_MS),
  // Physical cleanup interval. Access expires independently of this sweep, so
  // this bounds how long expired ciphertext stays on disk.
  sweepEveryMs: Number(process.env.BLOB_SWEEP_MS || MINUTE_MS),
};

const token = () => crypto.randomBytes(32).toString('base64url');

/** * One buffered item. A message is complete when it is offered; a file becomes
 * complete when its body finishes uploading. */
type BlobRecord = {
  id: string;
  kind: 'file' | 'message';
  senderId: string;
  conv: string;
  bytes: number;
  chunkSize: number;
  totalChunks: number;
  recipients: Set<string>;
  participants: Set<string>;
  released: Set<string>;
  uploadToken: string;
  downloadTokens: Map<string, string>;
  convDir: string;
  path: string;
  envelopePath: string;
  envelopeBytes: number;
  written: number;
  complete: boolean;
  createdAt: number;
  idleSince: number | null;
  soloSince: number | null;
};

type BlobStoreOptions = Partial<typeof BLOB_DEFAULTS> & {
  now?: () => number;
  isOnline?: (deviceId: string) => boolean;
};

/** Keyed hash for names written to disk. The key is random per process. */
function diskName(secret: Buffer, value: string) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
}

/** * Directory name for a conversation. A direct conversation is keyed on both
 * devices so it is the same directory whichever of them sends. Keyed with a
 * per-process secret, so someone reading the disk who knows two device IDs
 * cannot confirm that they talked; boot wipes the store, so nothing written
 * under an old secret ever needs finding again. */
export function conversationKey(conv: string, participants: Iterable<string>, secret: Buffer) {
  if (typeof conv === 'string' && conv.startsWith('room:')) return `r-${diskName(secret, conv)}`;
  return `d-${diskName(secret, [...participants].sort().join('|'))}`;
}

async function removeIfEmpty(dir: string) {
  // rmdir refuses a non-empty directory, which is exactly the check we want,
  // done atomically instead of list-then-delete.
  try {
    await fsp.rmdir(dir);
    return true;
  } catch {
    return false;
  }
}

export function createBlobStore(options: BlobStoreOptions = {}) {
  const config = { ...BLOB_DEFAULTS, ...options };
  // Never written anywhere: names on disk mean nothing once this process ends.
  const diskSecret = crypto.randomBytes(32);
  const now = options.now || Date.now;
  // Whether a device is currently connected. The store has no view of the
  // signaling server, so the owner supplies one; with no answer, every
  // conversation counts as gone and items live out the grace and no longer.
  const isOnline = options.isOnline || (() => false);

  /** * When an item stops being collectable: the earliest of its conversation
   * having emptied, having sat half-open with one device, and the absolute cap. */
  function expiresAt(blob: BlobRecord) {
    const self = blob.participants.size === 1;
    const deadlines = [
      blob.createdAt + (self ? Math.min(config.maxAgeMs, 3 * DAY_MS) : config.maxAgeMs),
    ];
    if (blob.idleSince !== null)
      {deadlines.push(blob.idleSince + (self ? DAY_MS : config.idleGraceMs));}
    if (blob.soloSince !== null && blob.participants.size > 1)
      {deadlines.push(blob.soloSince + config.soloMaxMs);}
    return Math.min(...deadlines);
  }

  const expired = (blob: BlobRecord) => now() >= expiresAt(blob);

  /** * Liveness for one item: nobody connected starts the grace, exactly one
   * connected device in a direct conversation starts the half-open clock, and
   * anything else clears both. Timers are left running once started, so
   * reconnecting is what resets them, not a passing sweep. */
  function assess(blob: BlobRecord, at: number) {
    // Reconnecting after the self-chat deadline cannot revive expired copies.
    if (blob.participants.size === 1 && expired(blob)) return;
    const present = [...blob.participants].filter(isOnline).length;
    const direct = !blob.conv.startsWith('room:');
    if (present === 0) {
      if (blob.idleSince === null) blob.idleSince = at;
      blob.soloSince = null;
      return;
    }
    blob.idleSince = null;
    if (direct && present === 1) {
      if (blob.soloSince === null) blob.soloSince = at;
    } else {
      blob.soloSince = null;
    }
  }

  /**
   * Recomputes which items still have someone connected. Called when a device
   * registers or drops, and on every sweep, so `idleSince` is the moment the
   * conversation actually emptied rather than the moment anyone noticed.
   */
  function refreshLiveness() {
    const at = now();
    for (const blob of blobs.values()) assess(blob, at);
  }

  const blobs: Map<string, BlobRecord> = new Map();
  let storeBytes = 0;
  /** Called with an item record once it is ready to deliver. */
  let onAvailable: (blob: BlobRecord) => void = (): void => {};

  async function ready() {
    await fsp.mkdir(config.dir, { recursive: true });
    await wipe('boot');
  }

  /** Erases every conversation directory and forgets every record. */
  async function wipe(reason: string) {
    let removed = 0;

    let entries: string[] = [];
    try {
      entries = await fsp.readdir(config.dir);
    } catch {
      return { removed, reason };
    }
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

  async function remove(id: string) {
    const blob = blobs.get(id);
    if (!blob) return false;
    blobs.delete(id);
    storeBytes = Math.max(0, storeBytes - blob.written - blob.envelopeBytes);
    await fsp.rm(blob.path, { force: true }).catch(() => {});
    await fsp.rm(blob.envelopePath, { force: true }).catch(() => {});
    await removeIfEmpty(blob.convDir);
    return true;
  }

  async function readEnvelope(blob: BlobRecord, deviceId: string) {
    try {
      const all = JSON.parse(await fsp.readFile(blob.envelopePath, 'utf8'));
      return Object.hasOwn(all, diskName(diskSecret, deviceId))
        ? all[diskName(diskSecret, deviceId)]
        : null;
    } catch {
      return null;
    }
  }

  /** * Reserves an item. `envelopes` maps recipient device id -> sealed box; the
   * server treats each box as opaque. A message is complete on arrival; a file
   * waits for its body to be uploaded. */
  async function offer({
    senderId,
    conv,
    kind = 'file',
    bytes,
    chunkSize,
    totalChunks,
    envelopes,
    authorized = () => true,
  }: {
    senderId: string;
    conv: string;
    kind?: 'file' | 'message';
    bytes: number;
    chunkSize: number;
    totalChunks: number;
    envelopes: Record<string, unknown>;
    authorized?: () => boolean;
  }): Promise<{ blob: BlobRecord; error?: undefined } | { error: string; blob?: undefined }> {
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

    // Keyed by a hash of each recipient, so the file on disk does not list who
    // the item is for; the record in memory keeps the real recipient set.
    const envelopeJson = JSON.stringify(
      Object.fromEntries(
        Object.entries(envelopes).map(([id, box]) => [diskName(diskSecret, id), box]),
      ),
    );
    const envelopeBytes = Buffer.byteLength(envelopeJson);
    if (storeBytes + bytes + envelopeBytes > config.maxStoreBytes) {
      return { error: 'The server relay is full. Try again shortly.' };
    }

    const owned = [...blobs.values()].filter(
      (blob) => blob.senderId === senderId && blob.kind === kind,
    ).length;
    const cap = isMessage ? config.maxMessagesPerDevice : config.maxBlobsPerDevice;
    if (owned >= cap) {
      return {
        error: isMessage
          ? `This device already has ${cap} messages waiting on the server.`
          : `Each device may buffer ${cap} transfers at a time.`,
      };
    }

    const recipients = Object.keys(envelopes);
    if (!recipients.length) return { error: 'No recipients.' };

    const id = crypto.randomUUID();
    const participants = new Set([senderId, ...recipients]);
    const convDir = path.join(config.dir, conversationKey(conv, participants, diskSecret));
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
      released: new Set<string>(),
      uploadToken: token(),
      downloadTokens: new Map(),
      convDir,
      path: path.join(convDir, `${id}.bin`),
      envelopePath: path.join(convDir, `${id}.env.json`),
      envelopeBytes,
      written: 0,
      complete: isMessage,
      createdAt: now(),
      idleSince: null,
      soloSince: null,
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
    if (!authorized()) {
      await fsp.rm(blob.envelopePath, { force: true });
      await removeIfEmpty(convDir);
      return { error: 'This connection is no longer authorized.' };
    }
    assess(blob, blob.createdAt);
    blobs.set(id, blob);
    storeBytes += envelopeBytes;
    if (isMessage) onAvailable(blob);
    return { blob };
  }

  /** Streams an upload to disk, enforcing the declared length as a hard cap. */
  function receive(
    id: string,
    presentedToken: string,
    request: import('node:stream').Readable,
  ): Promise<{ status: number; message?: string; blob?: BlobRecord }> {
    return new Promise((resolve) => {
      const blob = blobs.get(id);
      if (!blob || expired(blob) || blob.kind !== 'file')
        {return resolve({ status: 404, message: 'No such transfer.' });}
      if (blob.complete || blob.written > 0)
        {return resolve({
          status: 409,
          message: 'Use chunk resume for a partially committed upload.',
        });}
      if (presentedToken !== blob.uploadToken)
        {return resolve({ status: 403, message: 'Bad upload token.' });}

      if (activeUploads.has(id))
        {return resolve({ status: 409, message: 'Upload already in progress.' });}
      activeUploads.add(id);
      const out = fs.createWriteStream(blob.path, { flags: 'w' });
      let written = 0;
      let failed = false;

      const abort = (status: number, message: string) => {
        if (failed) return;
        failed = true;
        request.unpipe?.(out);
        // Wait for the file handle to close before unlinking, including when
        // expiry happens while createWriteStream is still opening the file.
        out.once('close', () => {
          activeUploads.delete(id);
          remove(id).then(() => resolve({ status, message }));
        });
        out.destroy();
      };

      request.on('data', (chunk: Buffer) => {
        if (expired(blob)) return abort(410, 'That transfer has expired.');
        written += chunk.length;
        // Never write past what was reserved, whatever the Content-Length said.
        if (written > blob.bytes) abort(413, 'Upload exceeded the declared length.');
      });
      request.on('error', () => abort(400, 'Upload failed.'));
      request.on('aborted', () => abort(400, 'Upload interrupted.'));
      out.on('error', () => abort(500, 'Could not buffer that transfer.'));

      out.on('finish', () => {
        if (failed) return;
        if (expired(blob)) return abort(410, 'That transfer has expired.');
        if (written !== blob.bytes) {
          abort(400, 'Upload length did not match the declared length.');
          return;
        }
        activeUploads.delete(id);
        blob.written = written;
        blob.complete = true;
        storeBytes += written;
        resolve({ status: 204, blob });
        onAvailable(blob);
      });

      request.pipe(out);
    });
  }

  // Commit whole ciphertext chunks only. A dropped request never advances offset.
  const activeUploads = new Set();

  function uploadStatus(id: string, presentedToken: string) {
    const blob = blobs.get(id);
    if (!blob || expired(blob) || blob.kind !== 'file') return { status: 404, offset: 0 };
    if (blob.uploadToken !== presentedToken) return { status: 403, offset: 0 };
    return { status: 200, offset: blob.written, complete: blob.complete };
  }

  async function receiveChunk(
    id: string,
    presentedToken: string,
    offset: number,
    request: import('node:stream').Readable,
  ): Promise<{ status: number; message?: string }> {
    const status = uploadStatus(id, presentedToken);
    if (status.status !== 200)
      {return { status: status.status, message: 'Transfer unavailable or bad token.' };}
    const blob = blobs.get(id);
    if (!blob) return { status: 404 };
    if (
      activeUploads.has(id) ||
      offset !== blob.written ||
      blob.complete ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      {return { status: 409, message: 'Upload offset conflict.' };}
    const length = Math.min(blob.chunkSize + 28, blob.bytes - offset);
    if (offset % (blob.chunkSize + 28) !== 0)
      {return { status: 400, message: 'Offset must be a chunk boundary.' };}
    activeUploads.add(id);
    try {
      const parts: any[] = [];
      let received = 0;
      for await (const part of request) {
        received += part.length;
        if (received > length) return { status: 413, message: 'Chunk exceeded declared length.' };
        parts.push(part);
      }
      if (received !== length) return { status: 400, message: 'Incomplete ciphertext chunk.' };
      if (expired(blob) || !blobs.has(id)) return { status: 410, message: 'Transfer expired.' };
      const handle = await fsp.open(blob.path, offset === 0 ? 'w' : 'r+');
      try {
        const bytes = Buffer.concat(parts);
        let done = 0;
        while (done < bytes.length) {
          const result = await handle.write(bytes, done, bytes.length - done, offset + done);
          done += result.bytesWritten;
        }
      } finally {
        await handle.close();
      }
      if (expired(blob) || !blobs.has(id)) return { status: 410, message: 'Transfer expired.' };
      blob.written += received;
      storeBytes += received;
      blob.complete = blob.written === blob.bytes;
      if (blob.complete) onAvailable(blob);
      return { status: 204 };
    } catch {
      return { status: 400, message: 'Chunk upload interrupted; retry from committed offset.' };
    } finally {
      activeUploads.delete(id);
    }
  }

  /** Issues a one-item download token to a participant. */
  async function claim(
    id: string,
    deviceId: string,
  ): Promise<
    | { error: string; blob?: undefined; downloadToken?: undefined; envelope?: undefined }
    | { error?: undefined; blob: BlobRecord; downloadToken: string; envelope: unknown }
  > {
    const blob = blobs.get(id);
    if (!blob || expired(blob)) return { error: 'That transfer is no longer available.' };
    if (!blob.participants.has(deviceId))
      {return { error: 'That transfer is not addressed to this device.' };}
    if (!blob.complete) return { error: 'That transfer is still uploading.' };
    const envelope = await readEnvelope(blob, deviceId);
    if (expired(blob) || !blobs.has(id) || !blob.participants.has(deviceId))
      {return { error: 'That transfer is no longer available.' };}
    const issued = token();
    blob.downloadTokens.set(issued, deviceId);
    return { blob, downloadToken: issued, envelope };
  }

  function openForDownload(
    id: string,
    presentedToken: string,
  ):
    | { status: 404 | 403; message: string; blob?: undefined }
    | { status: 200; blob: BlobRecord; message?: undefined } {
    const blob = blobs.get(id);
    if (!blob || expired(blob) || !blob.complete || blob.kind !== 'file')
      {return { status: 404, message: 'No such transfer.' };}
    if (!blob.downloadTokens.has(presentedToken))
      {return { status: 403, message: 'Bad download token.' };}
    return { status: 200, blob };
  }

  /** A recipient that has its copy; the item goes once every recipient has. */
  async function release(id: string, deviceId: string) {
    const blob = blobs.get(id);
    if (!blob || !blob.recipients.has(deviceId)) return false;
    // Self-addressed copies remain recoverable across reloads until expiry.
    if (blob.participants.size === 1 && !expired(blob)) return true;
    blob.released.add(deviceId);
    const everyoneDone = [...blob.recipients].every((recipient) => blob.released.has(recipient));
    if (everyoneDone) await remove(id);
    return true;
  }

  /** Items addressed to a device that it has not yet taken, oldest first. */
  async function pendingFor(deviceId: string) {
    const ready = [...blobs.values()]
      .filter(
        (blob) =>
          !expired(blob) &&
          blob.complete &&
          blob.recipients.has(deviceId) &&
          !blob.released.has(deviceId),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    return (await Promise.all(ready.map((blob) => describe(blob, deviceId)))).filter(
      (item) => item !== null,
    );
  }

  /** Revoke buffered content and download capabilities when a device signs out.
   * Other room recipients can still collect their copies. */
  async function revokeDevice(deviceId: string) {
    const removals: any[] = [];
    for (const blob of blobs.values()) {
      if (!blob.participants.has(deviceId)) continue;
      if (blob.conv === 'direct' || blob.senderId === deviceId) {
        removals.push(remove(blob.id));
      } else {
        blob.participants.delete(deviceId);
        blob.recipients.delete(deviceId);
        for (const [issued, owner] of blob.downloadTokens)
          {if (owner === deviceId) blob.downloadTokens.delete(issued);}
      }
    }
    await Promise.all(removals);
  }

  async function describe(blob: BlobRecord, deviceId: string) {
    if (expired(blob) || !blobs.has(blob.id)) return null;
    const envelope = await readEnvelope(blob, deviceId);
    if (expired(blob) || !blobs.has(blob.id)) return null;
    return {
      blobId: blob.id,
      kind: blob.kind,
      from: blob.senderId,
      conv: blob.conv,
      bytes: blob.bytes,
      chunkSize: blob.chunkSize,
      totalChunks: blob.totalChunks,
      envelope,
      createdAt: blob.createdAt,
      // So a recipient can show how long it has left rather than guessing.
      expiresAt: expiresAt(blob),
    };
  }

  /**
   * Removes items past the maximum age, then any empty directory left behind,
   * whatever emptied it. Younger items are left alone.
   */
  async function sweepAged(maxAgeMs = config.maxAgeMs) {
    refreshLiveness();
    const cutoff = now() - maxAgeMs;

    const purged: string[] = [];
    for (const blob of [...blobs.values()]) {
      if (expired(blob) || blob.createdAt <= cutoff) {
        await remove(blob.id);
        purged.push(blob.id);
      }
    }
    await removeEmptyDirectories();
    return purged;
  }

  async function removeEmptyDirectories() {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fsp.readdir(config.dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && (await removeIfEmpty(path.join(config.dir, entry.name))))
        {removed++;}
    }
    return removed;
  }

  function stats() {
    const all = [...blobs.values()];
    return {
      count: all.length,
      files: all.filter((blob) => blob.kind === 'file').length,
      messages: all.filter((blob) => blob.kind === 'message').length,
      bytes: storeBytes,
      dir: config.dir,
    };
  }

  return {
    config,
    blobs,
    ready,
    wipe,
    offer,
    receive,
    receiveChunk,
    uploadStatus,
    claim,
    openForDownload,
    release,
    remove,
    pendingFor,
    revokeDevice,
    /** Immediately revoke the items and tokens of an ended room. */
    revokeConversation(conv: string) {
      return Promise.all(
        [...blobs.values()]
          .filter((blob) => blob.conv === conv)
          .map((blob) => {
            blob.createdAt = 0;
            return remove(blob.id);
          }),
      );
    },
    describe,
    sweepAged,
    refreshLiveness,
    expiresAt,
    removeEmptyDirectories,
    stats,
    set onAvailable(handler: (blob: BlobRecord) => void) {
      onAvailable = typeof handler === 'function' ? handler : () => {};
    },
  };
}

/**
 * The one-shot sweep behind `node app/server/server.js --sweep-blobs`, for a host cron.
 * It runs in a separate process with no in-memory records, so it judges age by
 * each file's mtime, then removes any directory it leaves empty.
 */

export async function sweepDirectory(dir: string, maxAgeMs: number) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let kept = 0;
  let directories = 0;

  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return { removed, kept, directories };
    throw err;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const files = entry.isDirectory()
      ? (await fsp.readdir(full).catch(() => [])).map((name) => path.join(full, name))
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
    if (entry.isDirectory() && (await removeIfEmpty(full))) directories++;
  }
  return { removed, kept, directories };
}
