// Shared test setup. Not a test file itself: node's default patterns only pick
// up `*.test.js`, so this is safe to sit alongside them.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createEvakageServer } from '../../app/server/server.js';

/** Room policy tests use synthetic device IDs. Their HTTP account session
 * is attached directly; identity-bound socket login is covered by account tests. */
const roomTestServers: Map<string, Awaited<ReturnType<typeof startServer>>> = new Map();

export async function startRoomServer(
  t: { after: (fn: () => any) => any },
  options: Parameters<typeof startServer>[1] = {},
) {
  const accountDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'evakage-room-accounts-'));
  const env = await startServer(t, {
    ...options,
    accountsDb: path.join(accountDir, 'accounts.sqlite'),
  });
  roomTestServers.set(env.wsBase, env);
  t.after(async () => {
    roomTestServers.delete(env.wsBase);
    await fsp.rm(accountDir, { recursive: true, force: true });
  });
  return env;
}

/** * Starts a server on an ephemeral port with its own blob directory.
 *
 * The directory matters: `start()` empties the blob dir, and node runs test
 * files in parallel, so servers sharing the default location would wipe each
 * other's buffered transfers.
 * */
export async function startServer(
  t: { after: (fn: () => any) => any },
  options: Parameters<typeof createEvakageServer>[0] & { blobs?: object } = {},
) {
  const dir = path.join(os.tmpdir(), `evakage-test-${crypto.randomBytes(6).toString('hex')}`);
  const app = createEvakageServer({
    port: 0,
    host: '127.0.0.1',
    ...options,
    blobs: { dir, ...(options.blobs || {}) },
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
    wsBase: `ws://127.0.0.1:${address.port}`,
  };
}

export function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket open failed')), { once: true });
  });
}

/** Resolves with the first message matching `predicate`. */
export function waitFor(
  ws: WebSocket,
  predicate: (m: any) => boolean,
  timeoutMs: number = 3000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };
    const onClose = (event: CloseEvent) => {
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

export async function register(
  wsBase: string,
  deviceId: string,
  name: string = 'Device',
  extra: Record<string, unknown> = {},
) {
  const ws = await openWs(wsBase);
  const registered = waitFor(ws, (m) => m.type === 'registered');
  ws.send(
    JSON.stringify({
      type: 'register',
      deviceId,
      name,
      platform: 'Linux',
      browser: 'Firefox',
      discoverable: true,
      ...extra,
    }),
  );
  await registered;
  const env = roomTestServers.get(wsBase);
  if (env) {
    const body = JSON.stringify({
      username: deviceId.toLowerCase().slice(0, 40),
      password: 'test room account password',
    });
    const options = {
      method: 'POST',
      headers: { origin: env.base, 'content-type': 'application/json' },
      body,
    };
    let response = await fetch(`${env.base}/account/register`, options);
    if (response.status === 409) response = await fetch(`${env.base}/account/login`, options);
    if (!response.ok) throw new Error(`Room test sign-in failed: ${response.status}`);
    const token = response.headers.get('set-cookie')?.split(';')[0].split('=')[1] || '';
    const client = env.app.clients.get(deviceId);
    if (client) client.accountSession = crypto.createHash('sha256').update(token).digest('hex');
  }
  return ws;
}
