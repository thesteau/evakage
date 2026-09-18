// Shared test setup. Not a test file itself: node's default patterns only pick
// up `*.test.js`, so this is safe to sit alongside them.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAriaDropServer } from '../server.js';

/**
 * Starts a server on an ephemeral port with its own blob directory.
 *
 * The directory matters: `start()` empties the blob dir, and node runs test
 * files in parallel, so servers sharing the default location would wipe each
 * other's buffered transfers.
 */
export async function startServer(t, options = {}) {
  const dir = path.join(os.tmpdir(), `aria-drop-test-${crypto.randomBytes(6).toString('hex')}`);
  const app = createAriaDropServer({
    port: 0,
    host: '127.0.0.1',
    ...options,
    blobs: { dir, ...(options.blobs || {}) }
  });
  const address = await app.start();
  t.after(async () => {
    await app.stop();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return {
    app,
    dir,
    port: address.port,
    base: `http://127.0.0.1:${address.port}`,
    wsBase: `ws://127.0.0.1:${address.port}`
  };
}

export function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket open failed')), { once: true });
  });
}

export function waitFor(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = event => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };
    const onClose = event => {
      cleanup();
      reject(Object.assign(new Error('WebSocket closed while waiting'), { code: event.code }));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
  });
}

export async function register(wsBase, deviceId, name = 'Device', extra = {}) {
  const ws = await openWs(wsBase);
  const registered = waitFor(ws, m => m.type === 'registered');
  ws.send(JSON.stringify({
    type: 'register',
    deviceId,
    name,
    platform: 'Linux',
    browser: 'Firefox',
    ...extra
  }));
  await registered;
  return ws;
}
