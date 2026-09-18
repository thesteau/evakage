import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_SIGNAL_BYTES = 256 * 1024;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const WS_OPEN = 1;
const WS_CLOSED = 3;

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
    connectedAt: client.connectedAt
  };
}

export function createDropPakServer({ port = Number(process.env.PORT || 3000), host = process.env.HOST || '0.0.0.0' } = {}) {
  const clients = new Map();
  const codeOwners = new Map();
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (reqUrl.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, peers: clients.size }));
        return;
      }

      if (reqUrl.pathname === '/config.json') {
        let iceServers = [];
        try {
          const parsed = JSON.parse(process.env.ICE_SERVERS_JSON || '[]');
          if (Array.isArray(parsed)) iceServers = parsed;
        } catch {}
        const maxFileBytes = Math.max(1, Number(process.env.MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ iceServers, maxFileBytes }));
        return;
      }

      const requested = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
      const decoded = decodeURIComponent(requested);
      const normalized = path.normalize(decoded).replace(/^([.][.][/\\])+/, '');
      const filePath = path.join(PUBLIC_DIR, normalized);
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const headers = {
          'content-type': MIME_TYPES[ext] || 'application/octet-stream',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'permissions-policy': 'camera=(), microphone=(), geolocation=()',
          'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        };
        if (filePath.endsWith('index.html')) headers['cache-control'] = 'no-store';
        else headers['cache-control'] = 'public, max-age=300';
        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
      });
    } catch {
      res.writeHead(400).end('Bad request');
    }
  });

  function broadcastPresence() {
    const peers = [...clients.values()].map(peerPublic);
    for (const client of clients.values()) json(client.ws, { type: 'presence', peers });
  }

  function removeClient(deviceId, ws) {
    const existing = clients.get(deviceId);
    if (!existing || existing.ws !== ws) return;
    clients.delete(deviceId);
    if (codeOwners.get(existing.code) === deviceId) codeOwners.delete(existing.code);
    broadcastPresence();
  }

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ws = acceptWebSocket(req, socket);
    if (!ws) return;
    sockets.add(ws);
    if (head?.length) socket.unshift(head);
    let registeredId = null;

    ws.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > MAX_SIGNAL_BYTES) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'register') {
        const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId.slice(0, 128) : '';
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(deviceId)) {
          json(ws, { type: 'error', message: 'Invalid device identity.' });
          return;
        }

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
          ip: req.socket.remoteAddress
        });
        json(ws, { type: 'registered', self: peerPublic(clients.get(deviceId)) });
        broadcastPresence();
        return;
      }

      if (!registeredId || !clients.has(registeredId)) return;

      if (msg.type === 'rename') {
        clients.get(registeredId).name = cleanName(msg.name);
        broadcastPresence();
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
        const target = clients.get(String(msg.to || ''));
        if (!target || target.deviceId === registeredId) return;
        json(target.ws, { type: 'signal', from: registeredId, data: msg.data });
      }
    });

    ws.on('close', () => {
      sockets.delete(ws);
      if (registeredId) removeClient(registeredId, ws);
    });
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30000);
  heartbeat.unref?.();

  async function start() {
    if (server.listening) return server.address();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server.address();
  }

  async function stop() {
    clearInterval(heartbeat);
    for (const ws of sockets) {
      try { ws.close(1001, 'Server stopping'); } catch {}
    }
    await new Promise(resolve => server.close(() => resolve()));
  }

  return { server, clients, sockets, start, stop };
}

if (process.argv[1] === __filename) {
  const app = createDropPakServer();
  app.start().then(address => {
    const printable = typeof address === 'string' ? address : `${address.address}:${address.port}`;
    console.log(`drop-pak listening on ${printable}`);
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
