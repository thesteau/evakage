import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createBlobStore } from './blobstore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_SIGNAL_BYTES = 256 * 1024;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const WS_OPEN = 1;
const WS_CLOSED = 3;

// Full-mesh rooms cost O(n^2) DataChannels and O(n) upload bandwidth per file.
// Six is the practical ceiling for the "small trusted group" this targets.
const MAX_ROOM_MEMBERS = 6;
const MAX_ROOMS = 64;
const MAX_ROOMS_PER_DEVICE = 8;

// Version of the peer-to-peer application protocol spoken over the DataChannel.
// Published on /config.json for diagnostics; the browsers negotiate it directly.
// v2 added signed long-lived device identities.
// v3 added signed static seal keys, which is what makes a server-buffered
// transfer possible without the server being able to read it.
const PROTOCOL_VERSION = 3;

// Plaintext bytes per sealed body chunk. Published so both sides agree.
const BLOB_CHUNK_SIZE = 256 * 1024;

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value || ''));
const splitList = (value) => String(value || '').split(',').map(entry => entry.trim()).filter(Boolean);

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

function timingSafeEqualString(a, b) {
  // Hash first so differing lengths cannot throw or leak through the comparison.
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
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
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin'
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

class TinyWebSocket extends EventEmitter {
  constructor(socket, maxPayload = MAX_SIGNAL_BYTES) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = WS_OPEN;
    this.isAlive = true;
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;

    socket.on('data', chunk => this.#ingest(chunk));
    socket.on('close', () => this.#closed());
    socket.on('end', () => this.#closed());
    socket.on('error', err => this.emit('error', err));
  }

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

function json(ws, payload) {
  if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(payload));
}

function cleanName(value) {
  if (typeof value !== 'string') return 'Unnamed device';
  const out = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return out || 'Unnamed device';
}

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

function makeRoomCode(taken) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const bytes = crypto.randomBytes(8);
    let raw = '';
    for (let i = 0; i < 8; i++) raw += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (!taken.has(code)) return code;
  }
  return `${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

const BLOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEALED_BOX_MAX_CHARS = 4096;

function validSealedBox(box) {
  if (!isPlainObject(box)) return false;
  if (box.v !== 1) return false;
  for (const field of ['ephemeral', 'iv', 'ciphertext']) {
    if (!requiredString(box[field], SEALED_BOX_MAX_CHARS)) return false;
  }
  return true;
}

// The server never reads the envelopes; it only checks they are the right shape
// and addressed to plausible device ids.
function validEnvelopes(envelopes) {
  if (!isPlainObject(envelopes)) return false;
  const recipients = Object.keys(envelopes);
  if (!recipients.length || recipients.length > MAX_ROOM_MEMBERS) return false;
  return recipients.every(id => matches(DEVICE_ID_PATTERN, id) && validSealedBox(envelopes[id]));
}

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalString = (value, max) => value == null || (typeof value === 'string' && value.length <= max);
const requiredString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

// RegExp.test() stringifies its argument, and "undefined" happens to satisfy
// the device-id character class — so every pattern check must confirm the type
// first rather than relying on the pattern to reject a non-string.
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);

function validSdp(data) {
  if (!isPlainObject(data.sdp)) return false;
  // The description's own type has to match the envelope, so an "answer" cannot
  // smuggle an offer past a peer that is not expecting renegotiation.
  if (data.sdp.type !== data.type) return false;
  const sdp = data.sdp.sdp;
  return typeof sdp === 'string' && sdp.length > 0 && Buffer.byteLength(sdp) <= DEFAULT_LIMITS.maxSdpBytes;
}

function validCandidate(candidate) {
  if (!isPlainObject(candidate)) return false;
  if (typeof candidate.candidate !== 'string' || candidate.candidate.length > DEFAULT_LIMITS.maxCandidateChars) return false;
  if (!optionalString(candidate.sdpMid, 64)) return false;
  if (!optionalString(candidate.usernameFragment, 256)) return false;
  const index = candidate.sdpMLineIndex;
  if (index != null && !(Number.isInteger(index) && index >= 0 && index < 16)) return false;
  return true;
}

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
const VALIDATORS = Object.assign(Object.create(null), {
  register: m =>
    matches(DEVICE_ID_PATTERN, m.deviceId) &&
    optionalString(m.name, 512) &&
    optionalString(m.platform, 512) &&
    optionalString(m.browser, 512) &&
    // Relayed verbatim for other clients to verify; the server cannot check
    // these itself and is not trusted to.
    optionalString(m.identityKey, 256) &&
    optionalString(m.sealKey, 256) &&
    optionalString(m.sealKeySignature, 256),
  rename: m => optionalString(m.name, 512),
  'presence-request': () => true,
  'rooms-request': () => true,
  'resolve-code': m => optionalString(m.requestId, 128) && optionalString(m.code, 32),
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
    (m.conv === 'direct' || (typeof m.conv === 'string' && m.conv.startsWith('room:') && matches(ROOM_ID_PATTERN, m.conv.slice(5)))) &&
    Number.isInteger(m.bytes) && m.bytes >= 0 &&
    Number.isInteger(m.chunkSize) && m.chunkSize > 0 && m.chunkSize <= 1024 * 1024 &&
    Number.isInteger(m.totalChunks) && m.totalChunks >= 0 &&
    validEnvelopes(m.envelopes),
  'blob-claim': m => matches(BLOB_ID_PATTERN, m.blobId),
  'blob-release': m => matches(BLOB_ID_PATTERN, m.blobId),
  'blob-cancel': m => matches(BLOB_ID_PATTERN, m.blobId),
  'blobs-request': () => true
});

function validatorFor(type) {
  if (typeof type !== 'string' || !Object.hasOwn(VALIDATORS, type)) return null;
  const validate = VALIDATORS[type];
  return typeof validate === 'function' ? validate : null;
}

export function createAriaDropServer({
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST || '0.0.0.0',
  // Read per instance rather than at import time so a deployment — or a test —
  // can stand up differently configured servers in the same process.
  authToken = process.env.AUTH_TOKEN || '',
  trustProxy = truthy(process.env.TRUST_PROXY),
  allowedOrigins = splitList(process.env.ALLOWED_ORIGINS),
  limits: limitOverrides = {},
  blobs: blobOptions = {}
} = {}) {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const blobStore = createBlobStore(blobOptions);
  // The cookie carries an HMAC of a constant, so holding it never reveals the
  // token, and it stays valid only while the server keeps the same secret.
  function authCookieValue() {
    return crypto.createHmac('sha256', authToken).update('aria-drop-session-v1').digest('base64url');
  }

  function isAuthorized(req) {
    if (!authToken) return true;
    const presented = parseCookies(req.headers.cookie)[AUTH_COOKIE];
    return Boolean(presented) && timingSafeEqualString(presented, authCookieValue());
  }

  function effectiveHost(req) {
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
      if (forwarded) return forwarded.toLowerCase();
    }
    return String(req.headers.host || '').toLowerCase();
  }

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
  const sockets = new Set();
  const rooms = new Map();

  const connectionsByIp = new Map();
  const registrationBuckets = new Map();

  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      // Kept open so the container HEALTHCHECK works without the token; it only
      // ever discloses counts.
      if (reqUrl.pathname === '/healthz') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        const buffered = blobStore.stats();
        res.end(JSON.stringify({
          ok: true,
          peers: clients.size,
          rooms: rooms.size,
          bufferedTransfers: buffered.count,
          bufferedBytes: buffered.bytes
        }));
        return;
      }

      if (authToken) {
        const presented = reqUrl.searchParams.get('token');
        if (presented && timingSafeEqualString(presented, authToken)) {
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
          res.end('This aria-drop server requires a token. Open it as https://host/?token=YOUR_TOKEN once.');
          return;
        }
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
          iceServers,
          maxFileBytes,
          maxRoomMembers: MAX_ROOM_MEMBERS,
          protocol: PROTOCOL_VERSION,
          relay: {
            enabled: true,
            chunkSize: BLOB_CHUNK_SIZE,
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
          blobStore.receive(id, presented, req).then(result => {
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
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'content-type': 'application/octet-stream',
            'content-length': String(opened.blob.written),
            'cache-control': 'no-store'
          });
          const stream = fs.createReadStream(opened.blob.path);
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

  function broadcastPresence() {
    const peers = [...clients.values()].map(peerPublic);
    for (const client of clients.values()) json(client.ws, { type: 'presence', peers });
  }

  function roomPublic(room) {
    return {
      id: room.id,
      code: room.code,
      name: room.name,
      createdAt: room.createdAt,
      maxMembers: MAX_ROOM_MEMBERS,
      members: [...room.members]
        .map(id => clients.get(id))
        .filter(Boolean)
        .map(peerPublic)
    };
  }

  function broadcastRooms() {
    const list = [...rooms.values()].map(roomPublic);
    for (const client of clients.values()) json(client.ws, { type: 'rooms', rooms: list });
  }

  // A room lives exactly as long as at least one member is still connected.
  // The last member leaving destroys the server-side record; the payloads only
  // ever existed in the participants' browsers, so nothing survives either side.
  function dropMembership(deviceId) {
    let changed = false;
    for (const room of [...rooms.values()]) {
      if (!room.members.delete(deviceId)) continue;
      changed = true;
      if (room.members.size === 0) rooms.delete(room.id);
    }
    return changed;
  }

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
      members: new Set()
    };
    rooms.set(id, room);
    return room;
  }

  // A device may buffer a blob only for peers it could already talk to: the
  // other side of a direct session, or the members of a room it has joined.
  // Without this, any client could address a blob at any other device.
  function recipientsAllowed(senderId, conv, recipients) {
    if (!recipients.length) return false;
    if (recipients.includes(senderId)) return false;
    if (conv === 'direct') {
      return recipients.length === 1 && clients.has(recipients[0]);
    }
    const room = rooms.get(conv.slice(5));
    if (!room || !room.members.has(senderId)) return false;
    return recipients.every(id => room.members.has(id));
  }

  function removeClient(deviceId, ws) {
    const existing = clients.get(deviceId);
    if (!existing || existing.ws !== ws) return;
    clients.delete(deviceId);
    if (codeOwners.get(existing.code) === deviceId) codeOwners.delete(existing.code);
    const roomsChanged = dropMembership(deviceId);
    broadcastPresence();
    if (roomsChanged) broadcastRooms();
    // The primary deletion rule: a buffered transfer only lives while someone
    // party to it is still connected.
    blobStore.purgeUnattended(id => clients.has(id));
  }

  function refuseUpgrade(socket, status, reason) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    let pathname = null;
    try { pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; } catch {}
    if (pathname !== '/') return refuseUpgrade(socket, 404, 'Not Found');
    if (!originAllowed(req)) return refuseUpgrade(socket, 403, 'Forbidden');
    if (!isAuthorized(req)) return refuseUpgrade(socket, 401, 'Unauthorized');

    const ip = clientIp(req);
    const openForIp = connectionsByIp.get(ip) || 0;
    if (openForIp >= limits.connectionsPerIp) return refuseUpgrade(socket, 429, 'Too Many Requests');

    const ws = acceptWebSocket(req, socket);
    if (!ws) return;
    connectionsByIp.set(ip, openForIp + 1);
    sockets.add(ws);
    if (head?.length) socket.unshift(head);

    let registeredId = null;
    let released = false;
    let invalidMessages = 0;
    const messageBucket = new TokenBucket(limits.messagesPerSecond, limits.messageBurst);
    const signalBucket = new TokenBucket(limits.signalsPerSecond, limits.signalBurst);

    function disconnect(code, reason) {
      try { ws.close(code, reason); } catch { ws.terminate(); }
    }

    function strike(reason) {
      if (++invalidMessages >= limits.maxInvalidMessages) disconnect(1008, reason);
    }

    // Defence in depth: whatever a peer sends, a bug in one message handler must
    // cost that connection at most, never the process. Throwing out of the socket
    // 'data' event would otherwise be an unauthenticated remote crash.
    ws.on('message', (raw, isBinary) => {
      try {
        handleMessage(raw, isBinary);
      } catch (err) {
        console.error('Dropping a message that threw:', err?.message || err);
        strike('Handler error');
      }
    });

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
          name: cleanName(msg.name),
          platform: cleanName(msg.platform || 'Unknown').slice(0, 40),
          browser: cleanName(msg.browser || 'Browser').slice(0, 40),
          connectedAt: Date.now(),
          identityKey: typeof msg.identityKey === 'string' ? msg.identityKey : null,
          sealKey: typeof msg.sealKey === 'string' ? msg.sealKey : null,
          sealKeySignature: typeof msg.sealKeySignature === 'string' ? msg.sealKeySignature : null,
          ip
        });
        json(ws, { type: 'registered', self: peerPublic(clients.get(deviceId)) });
        broadcastPresence();
        json(ws, { type: 'rooms', rooms: [...rooms.values()].map(roomPublic) });
        // Anything buffered for this device while it was away.
        for (const pending of blobStore.pendingFor(deviceId)) {
          json(ws, { type: 'blob-available', ...pending });
        }
        return;
      }

      if (!registeredId || !clients.has(registeredId)) return;

      if (msg.type === 'rename') {
        clients.get(registeredId).name = cleanName(msg.name);
        broadcastPresence();
        if ([...rooms.values()].some(room => room.members.has(registeredId))) broadcastRooms();
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
          members: new Set([registeredId])
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
        if (!room && msg.recreate === true) room = restoreRoom(msg);
        if (!room) {
          json(ws, { type: 'error', context: 'join-room', message: 'That room is no longer active.' });
          return;
        }
        if (!room.members.has(registeredId) && room.members.size >= MAX_ROOM_MEMBERS) {
          json(ws, { type: 'error', context: 'join-room', message: `Rooms are limited to ${MAX_ROOM_MEMBERS} devices.` });
          return;
        }
        room.members.add(registeredId);
        json(ws, { type: 'room-joined', room: roomPublic(room) });
        broadcastRooms();
        return;
      }

      if (msg.type === 'leave-room') {
        const room = rooms.get(String(msg.roomId || ''));
        if (!room || !room.members.delete(registeredId)) return;
        if (room.members.size === 0) rooms.delete(room.id);
        json(ws, { type: 'room-left', roomId: room.id });
        broadcastRooms();
        return;
      }

      if (msg.type === 'rooms-request') {
        json(ws, { type: 'rooms', rooms: [...rooms.values()].map(roomPublic) });
        return;
      }

      if (msg.type === 'blob-offer') {
        // Recipients must be devices the sender could legitimately reach: the
        // other party of a direct session, or fellow members of a joined room.
        const recipients = Object.keys(msg.envelopes);
        if (!recipientsAllowed(registeredId, msg.conv, recipients)) {
          json(ws, { type: 'error', context: 'blob-offer', message: 'Those recipients are not reachable from this device.' });
          return;
        }
        const result = blobStore.offer({
          senderId: registeredId,
          conv: msg.conv,
          bytes: msg.bytes,
          chunkSize: msg.chunkSize,
          totalChunks: msg.totalChunks,
          envelopes: msg.envelopes
        });
        if (result.error) {
          json(ws, { type: 'error', context: 'blob-offer', message: result.error });
          return;
        }
        json(ws, {
          type: 'blob-offered',
          blobId: result.blob.id,
          uploadToken: result.blob.uploadToken,
          maxAgeMs: blobStore.config.maxAgeMs
        });
        return;
      }

      if (msg.type === 'blob-claim') {
        const claimed = blobStore.claim(msg.blobId, registeredId);
        if (claimed.error) {
          json(ws, { type: 'error', context: 'blob-claim', message: claimed.error, blobId: msg.blobId });
          return;
        }
        json(ws, {
          type: 'blob-claimed',
          blobId: msg.blobId,
          downloadToken: claimed.downloadToken,
          envelope: claimed.envelope,
          bytes: claimed.blob.bytes
        });
        return;
      }

      if (msg.type === 'blob-release') {
        blobStore.release(msg.blobId, registeredId);
        return;
      }

      if (msg.type === 'blob-cancel') {
        const blob = blobStore.blobs.get(msg.blobId);
        if (blob && blob.senderId === registeredId) blobStore.remove(msg.blobId);
        return;
      }

      if (msg.type === 'blobs-request') {
        for (const pending of blobStore.pendingFor(registeredId)) {
          json(ws, { type: 'blob-available', ...pending });
        }
        return;
      }

      if (msg.type === 'presence-request') {
        json(ws, { type: 'presence', peers: [...clients.values()].map(peerPublic) });
        return;
      }

      if (msg.type === 'resolve-code') {
        const code = String(msg.code || '').trim().toUpperCase();
        const id = codeOwners.get(code);
        const target = id ? clients.get(id) : null;
        json(ws, { type: 'resolved-code', requestId: msg.requestId, peer: target ? peerPublic(target) : null });
        return;
      }

      if (msg.type === 'signal') {
        const target = clients.get(msg.to);
        if (!target || target.deviceId === registeredId) return;
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

  // As soon as an upload finishes, tell whichever recipients are online.
  blobStore.onAvailable = (blob) => {
    for (const recipient of blob.recipients) {
      const client = clients.get(recipient);
      if (client) json(client.ws, { type: 'blob-available', ...blobStore.describe(blob, recipient) });
    }
  };

  // The age sweep. Runs often so nothing overshoots its maximum age by much;
  // a blob younger than that is left alone.
  const blobSweep = setInterval(() => {
    blobStore.sweepAged().then(purged => {
      if (purged.length) console.log(`Swept ${purged.length} buffered transfer(s) past ${blobStore.config.maxAgeMs}ms`);
    }).catch(() => {});
  }, blobStore.config.sweepEveryMs);
  blobSweep.unref?.();

  const heartbeat = setInterval(() => {
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
    clearInterval(blobSweep);
    // Shutting down means nobody is connected, so by the primary rule nothing
    // buffered should survive.
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
        resolve();
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
  }

  return { server, clients, sockets, rooms, connectionsByIp, limits, blobStore, start, stop };
}

if (process.argv[1] === __filename) {
  // `node server.js --sweep-blobs [maxAgeMs]` removes buffered transfers past
  // the given age and exits, so a host-side cron or systemd timer can drive the
  // sweep instead of (or as well as) the in-process one:
  //   docker exec aria-drop node server.js --sweep-blobs
  if (process.argv.includes('--sweep-blobs')) {
    const store = createBlobStore();
    const explicit = Number(process.argv[process.argv.indexOf('--sweep-blobs') + 1]);
    const maxAgeMs = Number.isFinite(explicit) ? explicit : store.config.maxAgeMs;
    // Nothing is in memory in a fresh process, so sweep the directory by mtime.
    const { readdir, stat, rm } = await import('node:fs/promises');
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    let kept = 0;
    try {
      for (const entry of await readdir(store.config.dir)) {
        if (!entry.endsWith('.bin')) continue;
        const full = `${store.config.dir}/${entry}`;
        const info = await stat(full).catch(() => null);
        if (!info) continue;
        if (info.mtimeMs < cutoff) {
          await rm(full, { force: true });
          removed++;
        } else {
          kept++;
        }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.error(err);
        process.exit(1);
      }
    }
    console.log(`Swept ${removed} buffered transfer(s) older than ${maxAgeMs}ms; kept ${kept}.`);
    process.exit(0);
  }

  const app = createAriaDropServer();
  app.start().then(address => {
    const printable = typeof address === 'string' ? address : `${address.address}:${address.port}`;
    console.log(`aria-drop listening on ${printable}`);
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
