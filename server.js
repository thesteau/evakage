import http from 'node:http';
import { createAccounts } from './accounts.js';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createBlobStore, sweepDirectory } from './blobstore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_SIGNAL_BYTES = 256 * 1024;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const WS_OPEN = 1;
const WS_CLOSED = 3;

// Rooms up to this size are a full mesh of direct DataChannels. The mesh costs
// O(n^2) connections and a sender uploads each file once per member, so past
// six a room switches to the server relay instead: one sealed copy per member,
// one upload per file, no mesh.
const MESH_MAX_MEMBERS = 6;
// A share that missed the service worker is read and thrown away up to this size.
const SHARE_DRAIN_LIMIT = 8 * 1024 * 1024;
// The configurable room size (ROOM_MAX_MEMBERS) is clamped to this. Every
// relayed item carries one sealed envelope per member, which bounds how many a
// single item can sensibly address.
const ROOM_MEMBERS_CEILING = 64;
const DEFAULT_ROOM_MAX_MEMBERS = 20;
const MAX_ROOMS = 64;
const MAX_ROOMS_PER_DEVICE = 8;

// Version of the peer-to-peer application protocol spoken over the DataChannel.
// Published on /config.json for diagnostics; the browsers negotiate it directly.
// v3 requires portable chat/history signatures. The server relay does not
// change the DataChannel protocol: it is a separate HTTP path, available to any
// client that publishes a signed seal key at registration.
const PROTOCOL_VERSION = 3;

// Plaintext bytes per sealed body chunk. Published so both sides agree.
const BLOB_CHUNK_SIZE = 256 * 1024;

/** A message from a client. Checked against VALIDATORS before a handler sees
 * it, so handlers read known fields off an otherwise arbitrary object.
 * @typedef {Record<string, any>} Inbound */

/** A registered device's connection state.
 * @typedef {object} Client
 * @property {TinyWebSocket} ws
 * @property {string} deviceId
 * @property {string} code
 * @property {string} name
 * @property {string} platform
 * @property {string} browser
 * @property {number} connectedAt
 * @property {string | null} identityKey opaque to the server; clients verify it
 * @property {string | null} sealKey
 * @property {string | null} sealKeySignature
 * @property {string} ip
 * @property {string} presenceSnapshot
 * @property {string} roomsSnapshot
 * @property {Set<string>} watchedDevices
 * @property {boolean} discoverable
 * @property {boolean} identityVerified
 * @property {string | null} accountSession
 * @property {string} accountSnapshot
 */

/** @typedef {object} Room
 * @property {string} id
 * @property {string} code
 * @property {string} name
 * @property {number} createdAt
 * @property {Set<string>} members connected now
 * @property {Map<string, number>} away device id -> when it dropped off
 * @property {string} [createdBy]
 */

const truthy = (/** @type {unknown} */ value) => /^(1|true|yes|on)$/i.test(String(value || ''));
const splitList = (/** @type {unknown} */ value) => String(value || '').split(',').map(entry => entry.trim()).filter(Boolean);

// Defensive budgets. A cooperating browser stays far below all of them; they
// exist so one misbehaving or hostile client cannot exhaust the server.
const DEFAULT_LIMITS = {
  messagesPerSecond: 40,
  messageBurst: 90,
  signalsPerSecond: 60,
  signalBurst: 140,
  maxInvalidMessages: 20,
  connectionsPerIp: 24,
  registrationsPerMinute: 40,
  maxSdpBytes: 96 * 1024,
  maxCandidateChars: 1024,
  maxNameChars: 64
};

// Simple token bucket: `capacity` burst, refilled at `perSecond`.
class TokenBucket {
  /** @param {number} perSecond @param {number} capacity */
  constructor(perSecond, capacity) {
    this.perSecond = perSecond;
    this.capacity = capacity;
    this.tokens = capacity;
    this.updatedAt = Date.now();
  }

  take(cost = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updatedAt) / 1000) * this.perSecond);
    this.updatedAt = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** @param {unknown} a @param {unknown} b */
function timingSafeEqualString(a, b) {
  // Hash first so differing lengths cannot throw or leak through the comparison.
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

/** @param {string | undefined} header */
function parseCookies(header) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    out.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return out;
}

const AUTH_COOKIE = 'aria_drop_auth';

// Applied to every response, not just static files, so an error or JSON reply is
// not the one path without them. noindex because a homelab tool that ends up
// reachable should not be catalogued.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin'
};

/** @type {Record<string, string>} */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

class TinyWebSocket extends EventEmitter {
  /** @param {import('node:stream').Duplex} socket @param {number} maxPayload */
  constructor(socket, maxPayload = MAX_SIGNAL_BYTES) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = WS_OPEN;
    this.isAlive = true;
    this.buffer = Buffer.alloc(0);
    /** @type {number | null} */
    this.fragmentOpcode = null;
    /** @type {Buffer[]} */
    this.fragments = [];
    this.fragmentBytes = 0;

    socket.on('data', (/** @type {Buffer} */ chunk) => this.#ingest(chunk));
    socket.on('close', () => this.#closed());
    socket.on('end', () => this.#closed());
    socket.on('error', (/** @type {Error} */ err) => this.emit('error', err));
  }

  /** @param {string | Buffer} data */
  send(data) {
    if (this.readyState !== WS_OPEN) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const opcode = Buffer.isBuffer(data) ? 0x2 : 0x1;
    this.#writeFrame(opcode, payload);
  }

  ping() {
    if (this.readyState === WS_OPEN) this.#writeFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== WS_OPEN) return;
    const reasonBytes = Buffer.from(String(reason).slice(0, 120));
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.#writeFrame(0x8, payload);
    this.readyState = WS_CLOSED;
    this.socket.end();
  }

  terminate() {
    this.readyState = WS_CLOSED;
    this.socket.destroy();
  }

  #closed() {
    if (this.readyState !== WS_CLOSED) this.readyState = WS_CLOSED;
    this.emit('close');
  }

  #protocolError() {
    try { this.close(1002, 'Protocol error'); } catch { this.terminate(); }
  }

  #tooLarge() {
    try { this.close(1009, 'Message too large'); } catch { this.terminate(); }
  }

  /** @param {Buffer} chunk */
  #ingest(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (!masked) return this.#protocolError();
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return this.#tooLarge();
        length = Number(big);
        offset = 10;
      }
      if (length > this.maxPayload) return this.#tooLarge();
      if (this.buffer.length < offset + 4 + length) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      if (opcode >= 0x8) {
        if (!fin || payload.length > 125) return this.#protocolError();
        if (opcode === 0x8) {
          if (this.readyState === WS_OPEN) this.#writeFrame(0x8, payload);
          this.readyState = WS_CLOSED;
          this.socket.end();
          return;
        }
        if (opcode === 0x9) {
          this.#writeFrame(0xA, payload);
          continue;
        }
        if (opcode === 0xA) {
          this.isAlive = true;
          this.emit('pong');
          continue;
        }
        continue;
      }

      if (opcode === 0x0) {
        if (this.fragmentOpcode == null) return this.#protocolError();
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxPayload) return this.#tooLarge();
        if (fin) {
          const complete = Buffer.concat(this.fragments, this.fragmentBytes);
          const originalOpcode = this.fragmentOpcode;
          this.fragmentOpcode = null;
          this.fragments = [];
          this.fragmentBytes = 0;
          this.emit('message', complete, originalOpcode === 0x2);
        }
        continue;
      }

      if (opcode !== 0x1 && opcode !== 0x2) return this.#protocolError();
      if (this.fragmentOpcode != null) return this.#protocolError();
      if (fin) {
        this.emit('message', payload, opcode === 0x2);
      } else {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
      }
    }
  }

  /** @param {number} opcode @param {Buffer} payload */
  #writeFrame(opcode, payload) {
    if (!this.socket.writable) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = length;
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, payload]));
  }
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:stream').Duplex} socket */
function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (!key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return new TinyWebSocket(socket);
}

/** @param {TinyWebSocket} ws @param {unknown} payload */
function json(ws, payload) {
  if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(payload));
}

/** @param {unknown} value */
function cleanName(value) {
  if (typeof value !== 'string') return 'Unnamed device';
  const out = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return out || 'Unnamed device';
}

/** @param {string} deviceId @param {Map<string, string>} takenCodes */
function codeForDevice(deviceId, takenCodes) {
  const digest = crypto.createHash('sha256').update(deviceId).digest('base64url').toUpperCase();
  for (let size = 8; size <= 14; size += 2) {
    const compact = digest.replace(/[^A-Z0-9]/g, '').slice(0, size);
    const code = compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
    const owner = takenCodes.get(code);
    if (!owner || owner === deviceId) return code;
  }
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

export const PAIRING_CODE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** Private invitation codes: never include these in discovery records.
 * @param {() => number} [now] */
export function createPairingCodes(now = Date.now) {
  /** @type {Map<string, {code: string, expiresAt: number}>} */
  const records = new Map();
  /** @type {Map<string, string>} */
  const owners = new Map();
  const forget = (/** @type {string} */ id) => {
    const old = records.get(id);
    if (old) owners.delete(old.code);
    records.delete(id);
  };
  return {
    issue(/** @type {string} */ id) {
      const existing = records.get(id);
      if (existing && now() < existing.expiresAt) return existing;
      forget(id);
      let code;
      do {
        const bytes = crypto.randomBytes(8);
        const compact = [...bytes].map(byte => ROOM_CODE_ALPHABET[byte & 31]).join('');
        code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
      } while (owners.has(code));
      const entry = { code, expiresAt: now() + PAIRING_CODE_MAX_AGE_MS };
      records.set(id, entry);
      owners.set(code, id);
      return entry;
    },
    resolve(/** @type {string} */ code) {
      const id = owners.get(code.trim().toUpperCase());
      if (!id) return null;
      const record = records.get(id);
      if (!record || now() >= record.expiresAt) { forget(id); return null; }
      return id;
    },
    prune() { for (const [id, entry] of records) if (now() >= entry.expiresAt) forget(id); }
  };
}

/** @param {Client} client */
function peerPublic(client) {
  return {
    id: client.deviceId,
    code: client.code,
    name: client.name,
    platform: client.platform,
    browser: client.browser,
    connectedAt: client.connectedAt,
    // Opaque to the server. Clients verify that identityKey hashes to id and
    // that sealKey carries a valid signature from it before sealing anything.
    identityKey: client.identityKey,
    sealKey: client.sealKey,
    sealKeySignature: client.sealKeySignature
  };
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** @param {Set<string>} taken */
function makeRoomCode(taken) {
  for (let attempt = 0; attempt < 40; attempt++) {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (!taken.has(code)) return code;
  }
  return `${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

const BLOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A file envelope carries metadata and a key; a message envelope carries the
// message itself, so it may be much larger.
const SEALED_BOX_MAX_CHARS = { file: 4096, message: 64 * 1024 };

/** @param {any} box @param {number} maxChars */
function validSealedBox(box, maxChars) {
  if (!isPlainObject(box)) return false;
  if (box.v !== 1) return false;
  for (const field of ['ephemeral', 'iv', 'ciphertext']) {
    if (!requiredString(box[field], maxChars)) return false;
  }
  return true;
}

// The server never reads the envelopes; it only checks they are the right shape
// and addressed to plausible device ids.
/** @param {any} envelopes @param {'file' | 'message'} kind */
function validEnvelopes(envelopes, kind) {
  if (!isPlainObject(envelopes)) return false;
  const recipients = Object.keys(envelopes);
  if (!recipients.length || recipients.length > ROOM_MEMBERS_CEILING) return false;
  const maxChars = SEALED_BOX_MAX_CHARS[kind];
  return recipients.every(id => matches(DEVICE_ID_PATTERN, id) && validSealedBox(envelopes[id], maxChars));
}

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const isPlainObject = (/** @type {unknown} */ value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalString = (/** @type {unknown} */ value, /** @type {number} */ max) => value == null || (typeof value === 'string' && value.length <= max);
const requiredString = (/** @type {unknown} */ value, /** @type {number} */ max) => typeof value === 'string' && value.length > 0 && value.length <= max;

// RegExp.test() stringifies its argument, and "undefined" happens to satisfy
// the device-id character class — so every pattern check must confirm the type
// first rather than relying on the pattern to reject a non-string.
const matches = (/** @type {RegExp} */ pattern, /** @type {unknown} */ value) => typeof value === 'string' && pattern.test(value);

/** @param {Inbound} data */
function validSdp(data) {
  if (!isPlainObject(data.sdp)) return false;
  // The description's own type has to match the envelope, so an "answer" cannot
  // smuggle an offer past a peer that is not expecting renegotiation.
  if (data.sdp.type !== data.type) return false;
  const sdp = data.sdp.sdp;
  return typeof sdp === 'string' && sdp.length > 0 && Buffer.byteLength(sdp) <= DEFAULT_LIMITS.maxSdpBytes;
}

/** @param {any} candidate */
function validCandidate(candidate) {
  if (!isPlainObject(candidate)) return false;
  if (typeof candidate.candidate !== 'string' || candidate.candidate.length > DEFAULT_LIMITS.maxCandidateChars) return false;
  if (!optionalString(candidate.sdpMid, 64)) return false;
  if (!optionalString(candidate.usernameFragment, 256)) return false;
  const index = candidate.sdpMLineIndex;
  if (index != null && !(Number.isInteger(index) && index >= 0 && index < 16)) return false;
  return true;
}

/** @param {any} data */
function validSignalData(data) {
  if (!isPlainObject(data)) return false;
  if (data.type === 'knock') return true;
  if (data.type === 'offer' || data.type === 'answer') return validSdp(data);
  if (data.type === 'ice') return validCandidate(data.candidate);
  return false;
}

// Every accepted message shape is spelled out here; anything else is a strike
// against the connection rather than something the handlers have to tolerate.
//
// Null-prototype and looked up with hasOwn, because a plain object literal would
// resolve msg.type === 'constructor' to Object (callable, returns truthy, so the
// message passes) and msg.type === '__proto__' to a non-function that throws.
/** @type {Record<string, (m: Inbound) => boolean>} */
const VALIDATOR_TABLE = {
  register: m =>
    matches(DEVICE_ID_PATTERN, m.deviceId) &&
    optionalString(m.name, 512) &&
    optionalString(m.platform, 512) &&
    optionalString(m.browser, 512) &&
    (m.discoverable == null || typeof m.discoverable === 'boolean') &&
    // Relayed verbatim for other clients to verify; the server cannot check
    // these itself and is not trusted to.
    optionalString(m.registrationProof, 128) &&
    optionalString(m.identityKey, 256) &&
    optionalString(m.sealKey, 256) &&
    optionalString(m.sealKeySignature, 256),
  'set-discoverable': m => typeof m.enabled === 'boolean',
  'presence-request': () => true,
  'rooms-request': () => true,
  'resolve-code': m => optionalString(m.requestId, 128) && optionalString(m.code, 32),
  'unpair-device': m => matches(DEVICE_ID_PATTERN, m.deviceId),
  'account-connect': m => typeof m.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(m.token),
  'pair-device': m => optionalString(m.requestId, 128) && optionalString(m.code, 32) && optionalString(m.targetId, 128),
  'create-room': m => optionalString(m.name, 512),
  'join-room': m =>
    (m.roomId == null || matches(ROOM_ID_PATTERN, m.roomId)) &&
    optionalString(m.code, 32) &&
    (m.recreate == null || typeof m.recreate === 'boolean') &&
    optionalString(m.name, 512) &&
    (m.roomId != null || (typeof m.code === 'string' && m.code.trim().length > 0)),
  'leave-room': m => matches(ROOM_ID_PATTERN, m.roomId),
  signal: m => requiredString(m.to, 128) && matches(DEVICE_ID_PATTERN, m.to) && validSignalData(m.data),

  'blob-offer': m =>
    optionalString(m.requestId, 64) &&
    (m.kind == null || m.kind === 'file' || m.kind === 'message') &&
    (m.conv === 'direct' || (typeof m.conv === 'string' && m.conv.startsWith('room:') && matches(ROOM_ID_PATTERN, m.conv.slice(5)))) &&
    Number.isInteger(m.bytes) && m.bytes >= 0 &&
    Number.isInteger(m.chunkSize) && m.chunkSize > 0 && m.chunkSize <= 1024 * 1024 &&
    Number.isInteger(m.totalChunks) && m.totalChunks >= 0 &&
    validEnvelopes(m.envelopes, m.kind || 'file'),
  'blob-claim': m => matches(BLOB_ID_PATTERN, m.blobId),
  'blob-release': m => matches(BLOB_ID_PATTERN, m.blobId),
  'blob-cancel': m => matches(BLOB_ID_PATTERN, m.blobId),
  'blobs-request': () => true,
  'lookup-devices': m =>
    optionalString(m.requestId, 64) &&
    Array.isArray(m.deviceIds) && m.deviceIds.length > 0 && m.deviceIds.length <= 200 &&
    m.deviceIds.every((/** @type {unknown} */ id) => matches(DEVICE_ID_PATTERN, id))
};

const VALIDATORS = Object.assign(Object.create(null), VALIDATOR_TABLE);

/** @param {unknown} type */
function validatorFor(type) {
  if (typeof type !== 'string' || !Object.hasOwn(VALIDATORS, type)) return null;
  const validate = VALIDATORS[type];
  return typeof validate === 'function' ? validate : null;
}

/** Possession proof binds an allowlisted fingerprint to this socket challenge.
 * @param {Inbound} msg @param {string} challenge */
function verifyRegistration(msg, challenge) {
  try {
    if (typeof msg.identityKey !== 'string' || typeof msg.registrationProof !== 'string') return false;
    const raw = Buffer.from(msg.identityKey, 'base64');
    const signature = Buffer.from(msg.registrationProof, 'base64');
    if (raw.length !== 65 || raw[0] !== 4 || signature.length !== 64 ||
        crypto.createHash('sha256').update(raw).digest('base64url') !== msg.deviceId) return false;
    const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
    return crypto.verify('sha256', Buffer.from(JSON.stringify(['aria-drop/register/1', challenge, msg.deviceId])),
      { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch { return false; }
}

// Retain the previous factory export for integrations using the original name.
export { createEvakageServer as createAriaDropServer };

export function createEvakageServer({
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST || '0.0.0.0',
  // Read per instance rather than at import time so a deployment — or a test —
  // can stand up differently configured servers in the same process.
  authToken = process.env.AUTH_TOKEN || '',
  trustProxy = truthy(process.env.TRUST_PROXY),
  allowedOrigins = splitList(process.env.ALLOWED_ORIGINS),
  allowedDevices = splitList(process.env.DEVICE_ALLOWLIST),
  pairingNow = Date.now,
  accountsDb = process.env.ACCOUNTS_DB || '',
  limits: limitOverrides = {},
  blobs: blobOptions = {},
  // How long a device that has disconnected can still be sent to, and how long a
  // room keeps a disconnected member's seat. Matches the relay's maximum age:
  // there is no point addressing something to a device the item cannot outlive.
  // How long a device that has dropped off is still listed as reachable, and
  // still holds its room seat. Deliberately the same as a half-open direct
  // session's life: a device is offered as a target for exactly as long as
  // something left for it would survive, so the list can never advertise a
  // device seen many hours ago.
  recentWindowMs = Number(process.env.BLOB_SOLO_MAX_MS || 3 * 60 * 60 * 1000),
  // A device that reconnects but does not rejoin a room within this long has
  // lost its room state (a reload), so it is dropped from the room's away list.
  rejoinGraceMs = 10000,
  maxRecentDevices = 10000,
  maxRoomMembers = Number(process.env.ROOM_MAX_MEMBERS || DEFAULT_ROOM_MAX_MEMBERS)
} = {}) {
  const deviceAllowlist = new Set(allowedDevices);
  if ([...deviceAllowlist].some(id => !/^[A-Za-z0-9_-]{43}$/.test(id))) throw new Error('DEVICE_ALLOWLIST must contain full device fingerprints.');
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  // Two is the smallest room that means anything; the ceiling bounds envelopes.
  const roomCap = Math.min(ROOM_MEMBERS_CEILING, Math.max(2, Math.floor(maxRoomMembers) || DEFAULT_ROOM_MAX_MEMBERS));
  // `clients` is declared below; the callback only runs once the server is
  // serving, by which point it exists. It is what makes a relayed item live
  // with its conversation rather than on a clock.
  const blobStore = createBlobStore({
    isOnline: (deviceId) => clients.has(deviceId),
    ...blobOptions
  });
  // The cookie carries an HMAC of a constant, so holding it never reveals the
  // token, and it stays valid only while the server keeps the same secret.
  function authCookieValue() {
    return crypto.createHmac('sha256', authToken).update('aria-drop-session-v1').digest('base64url');
  }

  /** @param {import('node:http').IncomingMessage} req */
  function isAuthorized(req) {
    if (!authToken) return true;
    const presented = parseCookies(req.headers.cookie).get(AUTH_COOKIE);
    return timingSafeEqualString(presented ?? '', authCookieValue());
  }

  /** @param {import('node:http').IncomingMessage} req */
  function effectiveHost(req) {
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
      if (forwarded) return forwarded.toLowerCase();
    }
    return String(req.headers.host || '').toLowerCase();
  }

  /** @param {import('node:http').IncomingMessage} req */
  function clientIp(req) {
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  // Browsers always send Origin on a WebSocket handshake, so a mismatch means
  // the upgrade came from a page this server did not hand out. Non-browser
  // clients send none at all.
  /** @param {import('node:http').IncomingMessage} req */
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (allowedOrigins.length) return allowedOrigins.includes(origin);
    let parsed;
    try { parsed = new URL(origin); } catch { return false; }
    const expected = effectiveHost(req);
    return Boolean(expected) && parsed.host.toLowerCase() === expected;
  }

  const clients = new Map();
  const codeOwners = new Map();
  const pairingCodes = createPairingCodes(pairingNow);
  /** @type {Map<string, Set<string>>} */
  const pairedDevices = new Map();
  /** Account relationships require both devices to remain signed in and online.
   * @type {Map<string, Set<string>>} */
  const accountDevices = new Map();
  /** @type {Map<string, Set<string>>} */
  const sessionDevices = new Map();
  /** @type {Map<string, Set<string>>} */
  const pairingRevocations = new Map();
  const sockets = new Set();
  const rooms = new Map();

  const connectionsByIp = new Map();
  const registrationBuckets = new Map();

  const accounts = createAccounts({ file: accountsDb, secure: trustProxy, onRevoke: revokeAccountSession });
  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      // Kept open so the container HEALTHCHECK works without the token; it only
      // ever discloses counts.
      if (reqUrl.pathname === '/healthz') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        const buffered = blobStore.stats();
        res.end(JSON.stringify({
          ok: true,
          peers: clients.size,
          bufferedTransfers: buffered.files,
          bufferedMessages: buffered.messages,
          bufferedBytes: buffered.bytes
        }));
        return;
      }

      // Shares from other apps are meant to be caught by the service worker, so
      // files never reach the server in the clear. If one gets here anyway (no
      // worker in control yet), discard the body unread and let the app say so.
      // The body is drained rather than cut off, because a browser that loses
      // its upload shows a network error instead of following the redirect; past
      // a few MB it is cut off anyway.
      if (reqUrl.pathname === '/share') {
        let seen = 0;
        let answered = false;
        const answer = () => {
          if (answered) return;
          answered = true;
          res.writeHead(303, { ...SECURITY_HEADERS, location: '/?shared=failed', connection: 'close', 'cache-control': 'no-store' });
          res.end();
        };
        req.on('data', chunk => {
          seen += chunk.length;
          if (seen > SHARE_DRAIN_LIMIT) {
            answer();
            req.destroy();
          }
        });
        req.on('end', answer);
        req.on('error', () => res.destroy());
        return;
      }

      if (authToken) {
        // Decided only by the constant-time comparison with the configured
        // secret; a missing token compares as empty, which never matches.
        const presented = reqUrl.searchParams.get('token') ?? '';
        if (timingSafeEqualString(presented, authToken)) {
          // Trade the link for a cookie so the token stops travelling in URLs,
          // and so the WebSocket upgrade carries it automatically.
          reqUrl.searchParams.delete('token');
          const secure = trustProxy || reqUrl.protocol === 'https:';
          res.writeHead(302, {
            location: `${reqUrl.pathname}${reqUrl.search}`,
            'set-cookie': `${AUTH_COOKIE}=${authCookieValue()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? '; Secure' : ''}`,
            'cache-control': 'no-store'
          });
          res.end();
          return;
        }
        if (!isAuthorized(req)) {
          res.writeHead(401, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('This Evakage server requires a token. Open it as https://host/?token=YOUR_TOKEN once.');
          return;
        }
      }

      if (reqUrl.pathname.startsWith('/account/')) {
        accounts.handle(req, res, reqUrl).catch(() => { if (!res.headersSent) res.writeHead(503, { 'cache-control': 'no-store' }); res.end(); });
        return;
      }

      if (reqUrl.pathname === '/config.json') {
        let iceServers = [];
        try {
          const parsed = JSON.parse(process.env.ICE_SERVERS_JSON || '[]');
          if (Array.isArray(parsed)) iceServers = parsed;
        } catch {}
        const maxFileBytes = Math.max(1, Number(process.env.MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES));
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          accountsEnabled: !!accountsDb,
          iceServers,
          maxFileBytes,
          maxRoomMembers: roomCap,
          roomMeshMax: MESH_MAX_MEMBERS,
          protocol: PROTOCOL_VERSION,
          relay: {
            enabled: true,
            chunkSize: BLOB_CHUNK_SIZE,
            // What bounds an item's life: the grace once everyone in its
            // conversation has gone, how long a half-open 1:1 session lasts,
            // and the ceiling nothing passes however alive the session is.
            idleGraceMs: blobStore.config.idleGraceMs,
            soloMaxMs: blobStore.config.soloMaxMs,
            maxAgeMs: blobStore.config.maxAgeMs
          }
        }));
        return;
      }

      // Blob bodies move over HTTP rather than the WebSocket, so they can be
      // streamed. Authorisation is a one-shot token issued over the registered
      // WebSocket connection, which is where identity already lives.
      if (reqUrl.pathname.startsWith('/blob/')) {
        const id = reqUrl.pathname.slice('/blob/'.length);
        const presented = reqUrl.searchParams.get('token') || '';
        if (!BLOB_ID_PATTERN.test(id)) {
          res.writeHead(404, SECURITY_HEADERS).end('Not found');
          return;
        }

        if (req.method === 'PUT' || req.method === 'POST') {
          const receive = reqUrl.searchParams.has('offset')
            ? blobStore.receiveChunk(id, presented, Number(reqUrl.searchParams.get('offset')), req)
            : blobStore.receive(id, presented, req);
          receive.then(result => {
            if (result.status === 204) res.writeHead(204, SECURITY_HEADERS).end();
            else res.writeHead(result.status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end(result.message);
          });
          return;
        }

        if (req.method === 'GET') {
          const opened = blobStore.openForDownload(id, presented);
          if (opened.status !== 200) {
            res.writeHead(opened.status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end(opened.message);
            return;
          }
          const offset = Number(reqUrl.searchParams.get('offset') || 0);
          if (offset !== 0) {
            res.writeHead(416, SECURITY_HEADERS).end('Downloads must start from the beginning.');
            return;
          }
          res.writeHead(offset ? 206 : 200, {
            ...SECURITY_HEADERS,
            'content-type': 'application/octet-stream',
            'content-length': String(opened.blob.written - offset),
            ...(offset ? { 'content-range': `bytes ${offset}-${opened.blob.written - 1}/${opened.blob.written}` } : {}),
            'cache-control': 'no-store'
          });
          const stream = fs.createReadStream(opened.blob.path, { start: offset });
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return;
        }

        res.writeHead(405, { ...SECURITY_HEADERS, allow: 'GET, PUT' }).end('Method not allowed');
        return;
      }

      const requested = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
      const decoded = decodeURIComponent(requested);
      const normalized = path.normalize(decoded).replace(/^([.][.][/\\])+/, '');
      const filePath = path.resolve(PUBLIC_DIR, `.${path.sep}${normalized}`);
      // Compare against PUBLIC_DIR + separator: a bare startsWith would also
      // accept a sibling directory whose name merely begins with it.
      if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403, SECURITY_HEADERS).end('Forbidden');
        return;
      }

      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        /** @type {Record<string, string>} */
        const headers = {
          ...SECURITY_HEADERS,
          'content-type': MIME_TYPES[ext] || 'application/octet-stream',
          'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        };
        if (filePath.endsWith('index.html')) headers['cache-control'] = 'no-store';
        else headers['cache-control'] = 'public, max-age=300';
        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
      });
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end('Bad request');
    }
  });

  /** @param {string} viewer */
  function visiblePeers(viewer) {
    const known = new Set([viewer, ...(pairedDevices.get(viewer) || []), ...(clients.get(viewer)?.watchedDevices || [])]);
    for (const peer of accountPeers(viewer)) known.add(peer.id);
    for (const room of rooms.values()) {
      if (room.members.has(viewer) || room.away.has(viewer)) {
        for (const id of room.members) known.add(id);
      }
    }
    return [...clients.values()].filter(client => client.discoverable || known.has(client.deviceId)).map(peerPublic);
  }
  function broadcastPresence() {
    for (const client of clients.values()) {
      const account = JSON.stringify({ type: 'account-peers', signedIn: !!accountName(client), peers: accountPeers(client.deviceId) });
      for (const peer of accountPeers(client.deviceId)) {
        if (!accountDevices.has(client.deviceId)) accountDevices.set(client.deviceId, new Set());
        accountDevices.get(client.deviceId)?.add(peer.id);
      }
      if (account !== client.accountSnapshot) {
        client.accountSnapshot = account;
        client.ws.send(account);
      }
      const peers = visiblePeers(client.deviceId);
      const snapshot = JSON.stringify(peers);
      if (snapshot === client.presenceSnapshot) continue;
      client.presenceSnapshot = snapshot;
      json(client.ws, { type: 'presence', peers });
    }
  }

  /** @param {Client | undefined} client */
  function accountName(client) {
    return client?.accountSession ? accounts.sessionName(client.accountSession) : null;
  }
  /** @param {string} viewer */
  function accountPeers(viewer) {
    const name = accountName(clients.get(viewer));
    return name ? [...clients.values()].filter(peer => peer.deviceId !== viewer && peer.identityVerified && accountName(peer) === name).map(peerPublic) : [];
  }
  /** Sign-out revokes relationships, room seats, and pending relay copies.
   * @param {string} session */
  function revokeAccountSession(session) {
    const devices = sessionDevices.get(session) || new Set();
    sessionDevices.delete(session);
    for (const id of devices) {
      const client = clients.get(id);
      if (client?.accountSession && client.accountSession !== session) continue;
      const peers = new Set([...(pairedDevices.get(id) || []), ...(accountDevices.get(id) || [])]);
      if (client) {
        client.accountSession = null;
        client.discoverable = false;
        client.watchedDevices.clear();
      }
      pairedDevices.delete(id);
      for (const peer of clients.values()) peer.watchedDevices.delete(id);
      for (const peerId of peers) {
        if (peerId === id) continue;
        pairedDevices.get(peerId)?.delete(id);
        clients.get(peerId)?.watchedDevices.delete(id);
        for (const [a, b] of [[id, peerId], [peerId, id]]) {
          if (!pairingRevocations.has(a)) pairingRevocations.set(a, new Set());
          pairingRevocations.get(a)?.add(b);
        }
        const peer = clients.get(peerId);
        if (peer) json(peer.ws, { type: 'pairing-revoked', deviceId: id });
      }
      for (const room of [...rooms.values()]) dropSeat(room, id);
      blobStore.revokeDevice(id).catch(() => {});
      if (client) json(client.ws, { type: 'account-reset' });
    }
    broadcastPresence();
    broadcastRooms();
  }

  /** @param {string} a @param {string} b */
  function relationshipRevoked(a, b) {
    if (accountPeers(a).some(peer => peer.id === b)) return false;
    if (accountDevices.get(a)?.has(b) && !pairedDevices.get(a)?.has(b)) return true;
    return pairingRevocations.get(a)?.has(b) || pairingRevocations.get(b)?.has(a);
  }

  /* ---------- recently seen devices ---------- */

  // The last signed key record of every device seen within the window, so a
  // message can be sealed to a device that has since gone offline. Safe to keep
  // on an untrusted server: the device id is the fingerprint of the identity
  // key, and the seal key is signed by it, so clients verify a record exactly as
  // they would a live one and a substituted key fails that check.
  /** @type {Map<string, { record: any, lastSeen: number }>} */
  const recentDevices = new Map();

  /** @param {string} deviceId */
  function noteSeen(deviceId) {
    const client = clients.get(deviceId);
    if (!client) return;
    recentDevices.delete(deviceId); // re-insert so Map order tracks recency
    recentDevices.set(deviceId, { record: peerPublic(client), lastSeen: Date.now() });
    // Bounded: evict the longest-unseen offline entries past the cap.
    for (const [id] of recentDevices) {
      if (recentDevices.size <= maxRecentDevices) break;
      if (!clients.has(id)) recentDevices.delete(id);
    }
  }

  /** @param {string} deviceId */
  function isRecent(deviceId) {
    if (clients.has(deviceId)) return true;
    const seen = recentDevices.get(deviceId);
    return seen !== undefined && seen.lastSeen >= Date.now() - recentWindowMs;
  }

  /** Public record for a device, live if connected, otherwise last seen. */
  /** @param {string} deviceId */
  function deviceRecord(deviceId) {
    const client = clients.get(deviceId);
    if (client) return { ...peerPublic(client), online: true, lastSeen: Date.now() };
    const seen = recentDevices.get(deviceId);
    if (!seen || !isRecent(deviceId)) return null;
    return { ...seen.record, online: false, lastSeen: seen.lastSeen };
  }

  /** @param {Room} room */
  function roomPublic(room) {
    return {
      id: room.id,
      code: room.code,
      name: room.name,
      createdAt: room.createdAt,
      maxMembers: roomCap,
      // Small rooms are a direct mesh; larger ones go entirely through the relay.
      transport: roomSeatsTaken(room) > MESH_MAX_MEMBERS ? 'relay' : 'mesh',
      members: [...room.members]
        .map(id => clients.get(id))
        .filter(Boolean)
        .map(peerPublic),
      // Members who dropped off without leaving. They keep their seat and are
      // still sent to (through the relay) until they rejoin or the window ends.
      away: [...room.away.entries()]
        .map(([id, since]) => {
          const record = deviceRecord(id);
          return record ? { ...record, awaySince: since } : null;
        })
        .filter(Boolean)
    };
  }

  /** @param {Room} room */
  function roomSeatsTaken(room) {
    return room.members.size + room.away.size;
  }

  // Room records, including held away seats, are visible only to their members.
  /** @param {string} viewer */
  function listedRooms(viewer) {
    return [...rooms.values()].filter(room => room.members.has(viewer) || room.away.has(viewer)).map(roomPublic);
  }

  function broadcastRooms() {
    for (const client of clients.values()) {
      const list = listedRooms(client.deviceId);
      const snapshot = JSON.stringify(list);
      // Do not announce unrelated room changes, even as repeated empty lists.
      if (snapshot === client.roomsSnapshot) continue;
      client.roomsSnapshot = snapshot;
      json(client.ws, { type: 'rooms', rooms: list });
    }
    broadcastPresence();
  }

  // A disconnect is not a leave. A phone that locks or drops off Wi-Fi keeps its
  // seat as "away", so members keep sending to it and it catches up when it
  // rejoins. Only an explicit leave, a reload (see rejoinGraceMs), or the window
  // running out actually removes it. A room lasts while anyone holds a seat.
  /** @param {string} deviceId */
  function markAway(deviceId) {
    let changed = false;
    for (const room of rooms.values()) {
      if (!room.members.delete(deviceId)) continue;
      room.away.set(deviceId, Date.now());
      changed = true;
    }
    return changed;
  }

  /** @param {Room} room @param {string} deviceId */
  function dropSeat(room, deviceId) {
    const wasMember = room.members.delete(deviceId);
    const wasAway = room.away.delete(deviceId);
    if (roomSeatsTaken(room) === 0) rooms.delete(room.id);
    return wasMember || wasAway;
  }

  /** Away seats past the window, and rooms left with nobody, are removed. */
  function expireAway() {
    const cutoff = Date.now() - recentWindowMs;
    let changed = false;
    for (const room of [...rooms.values()]) {
      for (const [id, since] of room.away) {
        if (since < cutoff) {
          room.away.delete(id);
          changed = true;
        }
      }
      if (roomSeatsTaken(room) === 0) {
        rooms.delete(room.id);
        changed = true;
      }
    }
    for (const [id, seen] of recentDevices) {
      if (!clients.has(id) && seen.lastSeen < cutoff) recentDevices.delete(id);
    }
    return changed;
  }

  /** @param {Inbound} msg */
  function restoreRoom(msg) {
    const id = String(msg.roomId || '');
    if (!ROOM_ID_PATTERN.test(id) || rooms.size >= MAX_ROOMS) return null;
    const requested = String(msg.code || '').trim().toUpperCase();
    const taken = new Set([...rooms.values()].map(r => r.code));
    const code = ROOM_CODE_PATTERN.test(requested) && !taken.has(requested) ? requested : makeRoomCode(taken);
    const room = {
      id,
      code,
      name: cleanName(msg.name || 'Room'),
      createdAt: Date.now(),
      members: new Set(),
      away: new Map()
    };
    rooms.set(id, room);
    return room;
  }

  // A device may buffer a blob only for peers it could already talk to: the
  // other side of a direct session, or the members of a room it has joined.
  // Without this, any client could address a blob at any other device.
  /** @param {string} senderId @param {string} conv @param {string[]} recipients */
  function recipientsAllowed(senderId, conv, recipients) {
    if (!recipients.length) return false;
    if (recipients.includes(senderId)) return conv === 'direct' && recipients.length === 1;
    if (conv === 'direct') {
      // Connected now, or seen within the window: an item addressed to it can
      // still be collected before it ages out.
      return recipients.length === 1 && isRecent(recipients[0]) && !relationshipRevoked(senderId, recipients[0]);
    }
    const room = rooms.get(conv.slice(5));
    if (!room || !room.members.has(senderId)) return false;
    return recipients.every((/** @type {string} */ id) => room.members.has(id) || room.away.has(id));
  }

  /** @param {string} deviceId @param {TinyWebSocket} ws */
  function removeClient(deviceId, ws) {
    const existing = clients.get(deviceId);
    if (!existing || existing.ws !== ws) return;
    noteSeen(deviceId);
    clients.delete(deviceId);
    if (codeOwners.get(existing.code) === deviceId) codeOwners.delete(existing.code);
    const roomsChanged = markAway(deviceId);
    // Start the clock on anything whose conversation this emptied. Items are
    // deliberately not removed here: a device that comes back within the grace
    // still receives what was left for it, and while anyone else party to the
    // item is still connected the item is not idle at all.
    blobStore.refreshLiveness();
    broadcastPresence();
    if (roomsChanged) broadcastRooms();
  }

  /** @param {TinyWebSocket} ws @param {string} deviceId */
  function deliverPending(ws, deviceId) {
    blobStore.pendingFor(deviceId).then(items => {
      for (const item of items) json(ws, { type: 'blob-available', ...item });
    }).catch(err => console.error('Could not list relayed items:', err?.message || err));
  }

  /** @param {import('node:stream').Duplex} socket @param {number} status @param {string} reason */
  function refuseUpgrade(socket, status, reason) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    let pathname = null;
    try { pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname; } catch {}
    if (pathname !== '/') return refuseUpgrade(socket, 404, 'Not Found');
    if (!originAllowed(req)) return refuseUpgrade(socket, 403, 'Forbidden');
    if (!isAuthorized(req)) return refuseUpgrade(socket, 401, 'Unauthorized');

    const ip = clientIp(req);
    const openForIp = connectionsByIp.get(ip) || 0;
    if (openForIp >= limits.connectionsPerIp) return refuseUpgrade(socket, 429, 'Too Many Requests');

    const accepted = acceptWebSocket(req, socket);
    if (!accepted) return;
    // Bound after the check so the handlers below, which are hoisted, see a
    // socket that cannot be null.
    const ws = accepted;
    connectionsByIp.set(ip, openForIp + 1);
    sockets.add(ws);
    if (head?.length) socket.unshift(head);

    const registrationChallenge = crypto.randomBytes(32).toString('base64url');
    json(ws, { type: 'registration-challenge', challenge: registrationChallenge });
    /** @type {string | null} */
    let registeredId = null;
    let released = false;
    let invalidMessages = 0;
    const messageBucket = new TokenBucket(limits.messagesPerSecond, limits.messageBurst);
    const pairBucket = new TokenBucket(1 / 2, 24);
    const signalBucket = new TokenBucket(limits.signalsPerSecond, limits.signalBurst);

    const disconnect = (/** @type {number} */ code, /** @type {string} */ reason) => {
      try { ws.close(code, reason); } catch { ws.terminate(); }
    };

    /** @param {string} reason */
    function strike(reason) {
      if (++invalidMessages >= limits.maxInvalidMessages) disconnect(1008, reason);
    }

    // Defence in depth: whatever a peer sends, a bug in one message handler must
    // cost that connection at most, never the process. Throwing out of the socket
    // 'data' event would otherwise be an unauthenticated remote crash.
    ws.on('message', (/** @type {Buffer} */ raw, /** @type {boolean} */ isBinary) => {
      try {
        handleMessage(raw, isBinary);
      } catch (err) {
        console.error('Dropping a message that threw:', err?.message || err);
        strike('Handler error');
      }
    });

    /** @param {Buffer} raw @param {boolean} isBinary */
    function handleMessage(raw, isBinary) {
      if (isBinary || raw.length > MAX_SIGNAL_BYTES) return strike('Malformed message');
      if (!messageBucket.take()) return disconnect(1008, 'Rate limit exceeded');

      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return strike('Malformed message'); }
      if (!isPlainObject(msg) || typeof msg.type !== 'string') return strike('Malformed message');

      const validate = validatorFor(msg.type);
      if (!validate || !validate(msg)) {
        json(ws, { type: 'error', context: msg.type, message: 'Message rejected by the server schema.' });
        return strike('Schema violation');
      }

      // Signaling is the loudest traffic, so it gets its own stricter budget.
      if (msg.type === 'signal' && !signalBucket.take()) return disconnect(1008, 'Signaling rate limit exceeded');

      if (msg.type === 'register') {
        const deviceId = msg.deviceId;
        const identityVerified = verifyRegistration(msg, registrationChallenge);
        // Real browser identities always prove possession, even without an allowlist.
        if (deviceId.length === 43 && !identityVerified) {
          json(ws, { type: 'error', context: 'register', message: 'This device is not authorized (identity proof failed).' });
          return disconnect(1008, 'Device identity proof failed');
        }
        if (deviceAllowlist.size && (!deviceAllowlist.has(deviceId) || !verifyRegistration(msg, registrationChallenge))) {
          json(ws, { type: 'error', context: 'register', message: 'This device is not authorized.' });
          return disconnect(1008, 'Device authorization failed');
        }
        let bucket = registrationBuckets.get(ip);
        if (!bucket) {
          bucket = new TokenBucket(limits.registrationsPerMinute / 60, limits.registrationsPerMinute);
          registrationBuckets.set(ip, bucket);
        }
        if (!bucket.take()) return disconnect(1008, 'Registration rate limit exceeded');

        const previous = clients.get(deviceId);
        if (previous && previous.ws !== ws) {
          try { previous.ws.close(4001, 'Replaced by reconnect'); } catch {}
        }

        const code = codeForDevice(deviceId, codeOwners);
        codeOwners.set(code, deviceId);
        registeredId = deviceId;
        clients.set(deviceId, {
          ws,
          deviceId,
          code,
          name: `Device ${code}`,
          platform: cleanName(msg.platform || 'Unknown').slice(0, 40),
          browser: cleanName(msg.browser || 'Browser').slice(0, 40),
          connectedAt: Date.now(),
          identityKey: typeof msg.identityKey === 'string' ? msg.identityKey : null,
          sealKey: typeof msg.sealKey === 'string' ? msg.sealKey : null,
          sealKeySignature: typeof msg.sealKeySignature === 'string' ? msg.sealKeySignature : null,
          ip,
          identityVerified,
          accountSession: null,
          accountSnapshot: '',
          discoverable: msg.discoverable === true,
          watchedDevices: new Set(),
          presenceSnapshot: '',
          roomsSnapshot: '[]'
        });
        noteSeen(deviceId);
        // This device is back: anything waiting for a conversation it is party
        // to is live again, and its grace starts over if it empties later.
        blobStore.refreshLiveness();
        json(ws, { type: 'registered', self: { ...peerPublic(clients.get(deviceId)),
          pairingCode: pairingCodes.issue(deviceId).code,
          pairingCodeExpiresAt: pairingCodes.issue(deviceId).expiresAt },
          paired: identityVerified ? [...(pairedDevices.get(deviceId) || [])].map(id => deviceRecord(id)).filter(Boolean) : [],
          revoked: identityVerified ? [...(pairingRevocations.get(deviceId) || [])] : [] });
        broadcastPresence();
        json(ws, { type: 'rooms', rooms: listedRooms(deviceId) });
        // Anything relayed to this device while it was away, oldest first.
        deliverPending(ws, deviceId);

        // A browser that only lost its connection rejoins its rooms straight
        // away. One that does not has reloaded and lost its room state, so it is
        // not coming back to those seats; stop sending to it there.
        const registeredAt = Date.now();
        setTimeout(() => {
          if (!clients.has(deviceId)) return; // dropped again: still genuinely away
          let changed = false;
          for (const room of [...rooms.values()]) {
            const since = room.away.get(deviceId);
            if (since != null && since <= registeredAt) changed = dropSeat(room, deviceId) || changed;
          }
          if (changed) broadcastRooms();
        }, rejoinGraceMs).unref?.();
        return;
      }

      if (!registeredId || !clients.has(registeredId)) return;

      if (msg.type === 'account-connect') {
        const client = clients.get(registeredId);
        const session = client.identityVerified && accounts.consumeTicket(msg.token, registeredId);
        if (!session) { json(ws, { type: 'error', context: 'account-connect', message: 'Account connection rejected. Sign in again.' }); return; }
        for (const devices of sessionDevices.values()) devices.delete(registeredId);
        if (!sessionDevices.has(session)) sessionDevices.set(session, new Set());
        sessionDevices.get(session)?.add(registeredId);
        client.accountSession = session;
        broadcastPresence();
        return;
      }

      if (msg.type === 'create-room') {
        if (rooms.size >= MAX_ROOMS) {
          json(ws, { type: 'error', context: 'create-room', message: 'This server is already hosting the maximum number of rooms.' });
          return;
        }
        // Without a per-device cap one client can claim every room slot and lock
        // everyone else out for as long as it stays connected.
        const owned = [...rooms.values()].filter(room => room.createdBy === registeredId).length;
        if (owned >= MAX_ROOMS_PER_DEVICE) {
          json(ws, { type: 'error', context: 'create-room', message: `Each device may host ${MAX_ROOMS_PER_DEVICE} rooms at a time.` });
          return;
        }
        const room = {
          id: crypto.randomUUID(),
          code: makeRoomCode(new Set([...rooms.values()].map(r => r.code))),
          name: cleanName(msg.name || 'Room'),
          createdAt: Date.now(),
          createdBy: registeredId,
          members: new Set([registeredId]),
          away: new Map()
        };
        rooms.set(room.id, room);
        json(ws, { type: 'room-joined', room: roomPublic(room) });
        broadcastRooms();
        return;
      }

      if (msg.type === 'join-room') {
        const byCode = typeof msg.code === 'string' && msg.code.trim()
          ? [...rooms.values()].find(r => r.code === msg.code.trim().toUpperCase())
          : null;
        let room = byCode || rooms.get(String(msg.roomId || ''));
        // A browser that still holds the room's RAM state may outlive a signaling
        // blip, so let it restore the same room rather than lose it to a reconnect.
        let restoring = false;
        if (!room && msg.recreate === true) {
          room = restoreRoom(msg);
          restoring = Boolean(room);
        }
        if (!room) {
          json(ws, { type: 'error', context: 'join-room', message: 'Unable to join with this invitation.' });
          return;
        }
        // An away member is reclaiming its own seat, so it always fits; anyone
        // else needs a seat that is neither taken nor held for someone away.
        // Restoring a room counts as returning to it: it has nobody connected
        // yet, and the dormant-room rule below must not lock out its restorer.
        const returning = restoring || room.members.has(registeredId) || room.away.has(registeredId);
        if (!returning && !byCode) {
          json(ws, { type: 'error', context: 'join-room', message: 'Unable to join with this invitation.' });
          return;
        }
        // A dormant room is kept only for its own away members; to anyone else
        // it has, in effect, ended.
        if (!returning && room.members.size === 0) {
          json(ws, { type: 'error', context: 'join-room', message: 'Unable to join with this invitation.' });
          return;
        }
        if (!returning && roomSeatsTaken(room) >= roomCap) {
          json(ws, { type: 'error', context: 'join-room', message: 'Unable to join with this invitation.' });
          return;
        }
        room.away.delete(registeredId);
        room.members.add(registeredId);
        json(ws, { type: 'room-joined', room: roomPublic(room) });
        broadcastRooms();
        return;
      }

      if (msg.type === 'leave-room') {
        const room = rooms.get(String(msg.roomId || ''));
        // An explicit leave gives the seat up entirely; it is not "away".
        if (!room || !dropSeat(room, registeredId)) return;
        json(ws, { type: 'room-left', roomId: room.id });
        broadcastRooms();
        return;
      }

      if (msg.type === 'lookup-devices') {
        // Knowing a full fingerprint allows targeted lookup, as before. Keep
        // these subscriptions separate from public advertising so browsers can
        // rediscover locally remembered peers after a signaling-server restart.
        const viewer = clients.get(registeredId);
        for (const id of msg.deviceIds) {
          if (viewer.watchedDevices.size < 200) viewer.watchedDevices.add(id);
        }
        const devices = msg.deviceIds.map(deviceRecord).filter(Boolean);
        json(ws, { type: 'devices-found', requestId: msg.requestId, devices });
        json(ws, { type: 'presence', peers: visiblePeers(registeredId) });
        return;
      }

      if (msg.type === 'rooms-request') {
        json(ws, { type: 'rooms', rooms: listedRooms(registeredId) });
        return;
      }

      if (msg.type === 'blob-offer') {
        // Recipients must be devices the sender could legitimately reach: the
        // other party of a direct session, or fellow members of a joined room.
        const recipients = Object.keys(msg.envelopes);
        if (!recipientsAllowed(registeredId, msg.conv, recipients)) {
          json(ws, { type: 'error', context: 'blob-offer', requestId: msg.requestId, message: 'Those recipients are not reachable from this device.' });
          return;
        }
        const senderId = registeredId;
        const accountSession = clients.get(senderId)?.accountSession;
        blobStore.offer({
          senderId,
          conv: msg.conv,
          kind: msg.kind || 'file',
          bytes: msg.bytes,
          chunkSize: msg.chunkSize,
          totalChunks: msg.totalChunks,
          envelopes: msg.envelopes,
          authorized: () => clients.get(senderId)?.accountSession === accountSession && recipientsAllowed(senderId, msg.conv, recipients)
        }).then(result => {
          if (!result.blob) {
            json(ws, { type: 'error', context: 'blob-offer', requestId: msg.requestId, message: result.error });
            return;
          }
          json(ws, {
            type: 'blob-offered',
            requestId: msg.requestId,
            blobId: result.blob.id,
            uploadToken: result.blob.kind === 'file' ? result.blob.uploadToken : undefined,
            maxAgeMs: blobStore.config.maxAgeMs,
            // So the sender can show the same countdown the recipient sees.
            expiresAt: blobStore.expiresAt(result.blob)
          });
        }).catch(err => {
          console.error('Could not store a relayed item:', err?.message || err);
          json(ws, { type: 'error', context: 'blob-offer', requestId: msg.requestId, message: 'The server could not store that.' });
        });
        return;
      }

      if (msg.type === 'blob-claim') {
        blobStore.claim(msg.blobId, registeredId).then(claimed => {
          if (!claimed.blob) {
            json(ws, { type: 'error', context: 'blob-claim', message: claimed.error || 'That transfer could not be opened.', blobId: msg.blobId });
            return;
          }
          json(ws, {
            type: 'blob-claimed',
            blobId: msg.blobId,
            downloadToken: claimed.downloadToken,
            envelope: claimed.envelope,
            bytes: claimed.blob.bytes
          });
        }).catch(() => json(ws, { type: 'error', context: 'blob-claim', message: 'That transfer could not be opened.', blobId: msg.blobId }));
        return;
      }

      if (msg.type === 'blob-release') {
        blobStore.release(msg.blobId, registeredId).catch(() => {});
        return;
      }

      if (msg.type === 'blob-cancel') {
        const blob = blobStore.blobs.get(msg.blobId);
        if (blob && blob.senderId === registeredId) blobStore.remove(msg.blobId).catch(() => {});
        return;
      }

      if (msg.type === 'blobs-request') {
        deliverPending(ws, registeredId);
        return;
      }

      if (msg.type === 'set-discoverable') {
        clients.get(registeredId).discoverable = msg.enabled;
        noteSeen(registeredId);
        broadcastPresence();
        return;
      }

      if (msg.type === 'presence-request') {
        json(ws, { type: 'presence', peers: visiblePeers(registeredId) });
        return;
      }

      if (msg.type === 'unpair-device') {
        if (!clients.get(registeredId)?.identityVerified || !pairedDevices.get(registeredId)?.has(msg.deviceId)) return;
        pairedDevices.get(registeredId)?.delete(msg.deviceId);
        pairedDevices.get(msg.deviceId)?.delete(registeredId);
        clients.get(registeredId)?.watchedDevices.delete(msg.deviceId);
        clients.get(msg.deviceId)?.watchedDevices.delete(registeredId);
        for (const [a, b] of [[registeredId, msg.deviceId], [msg.deviceId, registeredId]]) {
          if (!pairingRevocations.has(a)) pairingRevocations.set(a, new Set());
          pairingRevocations.get(a)?.add(b);
        }
        const target = clients.get(msg.deviceId);
        if (target) json(target.ws, { type: 'pairing-revoked', deviceId: registeredId });
        json(ws, { type: 'pairing-revoked', deviceId: msg.deviceId });
        broadcastPresence();
        return;
      }

      if (msg.type === 'pair-device') {
        const sender = clients.get(registeredId);
        if (!sender?.identityVerified || !pairBucket.take()) {
          json(ws, { type: 'paired-device', requestId: msg.requestId, peer: null });
          return;
        }
        const id = pairingCodes.resolve(String(msg.code || ''));
        const peer = id ? deviceRecord(id) : null;
        // Codes are bearer invitations, bound to the expected fingerprint when
        // pairing a particular row/QR. Public discovery codes grant nothing.
        if (!id || !peer?.identityKey || peer.id.length !== 43 || id === registeredId || (msg.targetId && msg.targetId !== id)) {
          json(ws, { type: 'paired-device', requestId: msg.requestId, peer: null });
          return;
        }
        for (const [a, b] of [[registeredId, id], [id, registeredId]]) {
          if (!pairedDevices.has(a)) pairedDevices.set(a, new Set());
          pairedDevices.get(a)?.add(b);
          pairingRevocations.get(a)?.delete(b);
        }
        json(ws, { type: 'paired-device', requestId: msg.requestId, peer });
        broadcastPresence();
        const target = clients.get(id);
        if (target?.identityVerified) json(target.ws, { type: 'paired-device', peer: peerPublic(sender) });
        return;
      }

      if (msg.type === 'resolve-code') {
        const code = String(msg.code || '').trim().toUpperCase();
        const id = codeOwners.get(code);
        const target = id ? clients.get(id) : null;
        json(ws, { type: 'resolved-code', requestId: msg.requestId, peer: target && visiblePeers(registeredId).some(peer => peer.id === target.deviceId) ? peerPublic(target) : null });
        return;
      }

      if (msg.type === 'signal') {
        const target = clients.get(msg.to);
        if (!target || target.deviceId === registeredId || relationshipRevoked(registeredId, target.deviceId)) return;
        // Only the validated fields are forwarded, so nothing a peer did not
        // declare rides along inside the signaling envelope.
        const data = msg.data.type === 'ice'
          ? { type: 'ice', candidate: msg.data.candidate }
          : msg.data.type === 'knock'
            ? { type: 'knock' }
            : { type: msg.data.type, sdp: { type: msg.data.sdp.type, sdp: msg.data.sdp.sdp } };
        json(target.ws, { type: 'signal', from: registeredId, data });
      }
    }

    ws.on('close', () => {
      if (!released) {
        released = true;
        const remaining = (connectionsByIp.get(ip) || 1) - 1;
        if (remaining > 0) connectionsByIp.set(ip, remaining);
        else connectionsByIp.delete(ip);
      }
      sockets.delete(ws);
      if (registeredId) removeClient(registeredId, ws);
    });
    ws.on('error', () => {});
  });

  // As soon as an item is ready — a message on arrival, a file once uploaded —
  // tell whichever recipients are online. The rest get it when they register.
  blobStore.onAvailable = (blob) => {
    for (const recipient of blob.recipients) {
      const client = clients.get(recipient);
      if (!client) continue;
      blobStore.describe(blob, recipient)
        .then(item => { if (item) json(client.ws, { type: 'blob-available', ...item }); })
        .catch(() => {});
    }
  };

  // The sweep. Runs often so nothing outlives its conversation by much; items
  // whose conversation is still live are left alone, and empty conversation
  // directories go.
  const blobSweep = setInterval(() => {
    blobStore.sweepAged().then(purged => {
      if (purged.length) console.log(`Swept ${purged.length} relayed item(s) whose session ended or hit the cap`);
    }).catch(() => {});
    // Same window for away seats and remembered devices.
    if (expireAway()) broadcastRooms();
  }, blobStore.config.sweepEveryMs);
  blobSweep.unref?.();

  const rotatePairingCodes = () => {
    for (const client of clients.values()) {
      const entry = pairingCodes.issue(client.deviceId);
      // Owner-only update; access checks still enforce expiry if this timer stalls.
      json(client.ws, { type: 'pairing-code', code: entry.code, expiresAt: entry.expiresAt });
    }
    pairingCodes.prune();
    for (const id of pairingRevocations.keys()) {
      if (!clients.has(id) && !recentDevices.has(id)) pairingRevocations.delete(id);
    }
    for (const id of pairedDevices.keys()) {
      if (!clients.has(id) && !recentDevices.has(id)) {
        pairedDevices.delete(id);
        for (const peers of pairedDevices.values()) peers.delete(id);
      }
    }
    for (const id of accountDevices.keys()) {
      if (!clients.has(id) && !recentDevices.has(id)) accountDevices.delete(id);
    }
  };
  const pairingSweep = setInterval(rotatePairingCodes, 60000);
  pairingSweep.unref?.();

  const heartbeat = setInterval(() => {
    accounts.prune();
    for (const ws of sockets) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
    // Registration buckets are keyed by IP, so drop the ones that have fully
    // refilled and gone quiet rather than letting the map grow without bound.
    const stale = Date.now() - 10 * 60 * 1000;
    for (const [key, bucket] of registrationBuckets) {
      if (bucket.updatedAt < stale) registrationBuckets.delete(key);
    }
  }, 30000);
  heartbeat.unref?.();

  /**
   * Starts listening and returns the bound address.
   * @returns {Promise<import('node:net').AddressInfo>}
   */
  async function start() {
    // Empties the blob directory: any file there predates this process and has
    // no record, so it is unreachable garbage.
    await blobStore.ready();
    if (!server.listening) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(undefined);
        });
      });
    }
    const address = server.address();
    // A string address means a pipe or unix socket, which this server never
    // binds; narrowing here saves every caller from re-checking.
    if (address === null || typeof address === 'string') {
      throw new Error(`Expected a TCP address, got ${JSON.stringify(address)}`);
    }
    return address;
  }

  async function stop({ graceMs = 250, keepBlobs = false } = {}) {
    clearInterval(heartbeat);
    clearInterval(pairingSweep);
    clearInterval(blobSweep);
    // Item records live only in memory, so once this process ends nothing on
    // disk can be delivered again. Erase it now rather than leave it for the
    // next boot. A restart therefore ends relayed items early, never late.
    if (!keepBlobs) await blobStore.wipe('shutdown').catch(() => {});
    for (const ws of sockets) {
      try { ws.close(1001, 'Server stopping'); } catch {}
    }
    await new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(grace);
        resolve(undefined);
      };
      // An upgraded socket whose peer never completes the closing handshake would
      // otherwise hold server.close() open indefinitely — and hang SIGTERM until
      // the container runtime resorts to SIGKILL.
      const grace = setTimeout(() => {
        for (const ws of sockets) {
          try { ws.terminate(); } catch {}
        }
        server.closeAllConnections?.();
        done();
      }, graceMs);
      grace.unref?.();
      server.close(done);
    });
    accounts.close();
  }

  return { server, clients, sockets, rooms, recentDevices, connectionsByIp, limits, blobStore, expireAway, pairingCodes, rotatePairingCodes, start, stop };
}

if (process.argv[1] === __filename) {
  // `node server.js --sweep-blobs [maxAgeMs]` removes relayed items past the
  // given age, removes any conversation directory left empty, and exits — so a
  // host-side cron or systemd timer can drive the sweep as well as the
  // in-process one:
  //   docker exec evakage node server.js --sweep-blobs
  if (process.argv.includes('--sweep-blobs')) {
    const store = createBlobStore();
    const explicit = Number(process.argv[process.argv.indexOf('--sweep-blobs') + 1]);
    const maxAgeMs = Number.isFinite(explicit) ? explicit : store.config.maxAgeMs;
    try {
      const result = await sweepDirectory(store.config.dir, maxAgeMs);
      console.log(`Swept ${result.removed} relayed file(s) older than ${maxAgeMs}ms; kept ${result.kept}; removed ${result.directories} empty director${result.directories === 1 ? 'y' : 'ies'}.`);
      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  }

  const app = createEvakageServer();
  app.start().then(address => {
    const printable = typeof address === 'string' ? address : `${address.address}:${address.port}`;
    console.log(`Evakage listening on ${printable}`);
    console.log(`buffered transfers: ${app.blobStore.config.dir} (max age ${app.blobStore.config.maxAgeMs}ms)`);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });

  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
