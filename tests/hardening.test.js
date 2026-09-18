import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer, openWs, waitFor, register } from './helpers.js';

function waitForClose(ws, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket stayed open')), timeoutMs);
    ws.addEventListener('close', event => { clearTimeout(timer); resolve(event); }, { once: true });
  });
}

// Raw handshake so we can control the Origin header, which the WebSocket client
// does not let us set.
function rawUpgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '', ''
      ];
      socket.write(lines.join('\r\n'));
    });
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1');
      if (buffer.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(Number(buffer.split(' ')[1]));
      }
    });
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('handshake timed out')); }, 3000);
  });
}

async function withServer(t, options = {}) {
  return startServer(t, options);
}

test('the upgrade rejects a cross-site Origin and accepts a matching one', async t => {
  const { port } = await withServer(t);
  assert.equal(await rawUpgrade(port, { Origin: 'https://evil.example' }), 403);
  assert.equal(await rawUpgrade(port, { Origin: `http://127.0.0.1:${port}` }), 101);
  // Non-browser clients send no Origin at all and stay allowed.
  assert.equal(await rawUpgrade(port), 101);
});

test('ALLOWED_ORIGINS replaces the same-host default', async t => {
  const { port } = await withServer(t, { allowedOrigins: ['https://drop.home.arpa'] });
  assert.equal(await rawUpgrade(port, { Origin: `http://127.0.0.1:${port}` }), 403);
  assert.equal(await rawUpgrade(port, { Origin: 'https://drop.home.arpa' }), 101);
});

test('a malformed or unknown message is rejected and repeated abuse closes the socket', async t => {
  const { wsBase } = await withServer(t);
  const ws = await register(wsBase, 'device_A_12345678');

  const rejected = waitFor(ws, m => m.type === 'error' && m.context === 'signal');
  // `to` is a valid device id but the signal body is not one of the four shapes.
  ws.send(JSON.stringify({ type: 'signal', to: 'device_B_12345678', data: { type: 'evil', payload: 'x' } }));
  assert.match((await rejected).message, /schema/i);

  const closed = waitForClose(ws);
  for (let i = 0; i < 25; i++) ws.send(JSON.stringify({ type: 'not-a-real-type' }));
  assert.equal((await closed).code, 1008);
});

test('oversized SDP and malformed ICE candidates never reach the other peer', async t => {
  const { wsBase } = await withServer(t);
  const a = await register(wsBase, 'device_A_12345678', 'A');
  const b = await register(wsBase, 'device_B_12345678', 'B');

  let delivered = false;
  b.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data));
    if (msg.type === 'signal') delivered = true;
  });

  const rejections = [];
  a.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data));
    if (msg.type === 'error') rejections.push(msg);
  });

  const huge = 'v=0\r\n' + 'a=x'.repeat(50000);
  a.send(JSON.stringify({ type: 'signal', to: 'device_B_12345678', data: { type: 'offer', sdp: { type: 'offer', sdp: huge } } }));
  // An answer envelope carrying an offer description is a mismatch.
  a.send(JSON.stringify({ type: 'signal', to: 'device_B_12345678', data: { type: 'answer', sdp: { type: 'offer', sdp: 'v=0' } } }));
  a.send(JSON.stringify({ type: 'signal', to: 'device_B_12345678', data: { type: 'ice', candidate: { candidate: 'c'.repeat(5000) } } }));
  a.send(JSON.stringify({ type: 'signal', to: 'device_B_12345678', data: { type: 'ice', candidate: { candidate: 'ok', sdpMLineIndex: 99999 } } }));

  await new Promise(r => setTimeout(r, 150));
  assert.equal(delivered, false);
  assert.equal(rejections.length, 4);

  // A well-formed signal still goes through, and only declared fields survive.
  const forwarded = waitFor(b, m => m.type === 'signal');
  a.send(JSON.stringify({
    type: 'signal',
    to: 'device_B_12345678',
    data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0', extra: 'smuggled' }, alsoExtra: 1 }
  }));
  const signal = await forwarded;
  assert.deepEqual(signal.data, { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } });

  a.close();
  b.close();
});

test('flooding messages trips the rate limiter', async t => {
  const { wsBase } = await withServer(t);
  const ws = await register(wsBase, 'device_A_12345678');
  const closed = waitForClose(ws);
  for (let i = 0; i < 400; i++) ws.send(JSON.stringify({ type: 'presence-request' }));
  assert.equal((await closed).code, 1008);
});

test('concurrent connections from one address are capped', async t => {
  const { app, wsBase, port } = await withServer(t);
  const open = [];
  for (let i = 0; i < app.limits.connectionsPerIp; i++) open.push(await openWs(wsBase));
  assert.equal(await rawUpgrade(port), 429);

  // Closing one frees a slot again.
  open[0].close();
  await new Promise(r => setTimeout(r, 150));
  assert.equal(await rawUpgrade(port), 101);
  for (const ws of open.slice(1)) ws.close();
});

test('AUTH_TOKEN gates the page and the upgrade, and the token can be traded for a cookie', async t => {
  const { base, port } = await withServer(t, { authToken: 's3cret-token' });

  // Bodies must be consumed or undici holds the pooled connection open.
  const status = async (url, init) => {
    const response = await fetch(url, init);
    await response.arrayBuffer();
    return response;
  };

  assert.equal((await status(base)).status, 401);
  // healthz stays open so the container healthcheck keeps working.
  assert.equal((await status(`${base}/healthz`)).status, 200);
  assert.equal((await status(`${base}/?token=wrong`)).status, 401);

  const exchanged = await status(`${base}/?token=s3cret-token`, { redirect: 'manual' });
  assert.equal(exchanged.status, 302);
  const setCookie = exchanged.headers.get('set-cookie');
  assert.match(setCookie, /^aria_drop_auth=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  // The redirect target must not carry the token onward.
  assert.equal(exchanged.headers.get('location'), '/');

  const cookie = setCookie.split(';')[0];
  assert.equal((await status(base, { headers: { cookie } })).status, 200);

  assert.equal(await rawUpgrade(port), 401);
  assert.equal(await rawUpgrade(port, { Cookie: cookie }), 101);
  assert.equal(await rawUpgrade(port, { Cookie: 'aria_drop_auth=forged' }), 401);
});

test('static serving refuses traversal and sends security headers everywhere', async t => {
  const { base } = await withServer(t);
  const get = async (pathname) => {
    const response = await fetch(`${base}${pathname}`, { redirect: 'manual' });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body };
  };

  for (const attempt of [
    '/../server.js',
    '/../../server.js',
    '/..%2fserver.js',
    '/..%2F..%2Fserver.js',
    '/%2e%2e/server.js',
    '/./../package.json',
    '/icons/../../server.js',
    '/....//server.js'
  ]) {
    const response = await get(attempt);
    assert.ok(response.status === 403 || response.status === 404, `${attempt} returned ${response.status}`);
    assert.ok(!response.body.includes('createAriaDropServer'), `${attempt} leaked server source`);
    assert.ok(!response.body.includes('"name": "aria-drop"'), `${attempt} leaked package.json`);
  }

  // Every response carries the headers, not just the static-file path.
  for (const pathname of ['/', '/healthz', '/config.json', '/does-not-exist', '/icons/icon-192.png']) {
    const response = await get(pathname);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', pathname);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', pathname);
    assert.match(response.headers.get('x-robots-tag') || '', /noindex/, pathname);
  }

  // The page itself still gets a CSP; JSON endpoints do not need one.
  const page = await get('/');
  assert.match(page.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');

  // Real assets still serve.
  const icon = await get('/icons/icon-192.png');
  assert.equal(icon.status, 200);
});

test('X-Forwarded-* headers only count when TRUST_PROXY is set', async t => {
  const untrusted = await withServer(t, { trustProxy: false });
  assert.equal(await rawUpgrade(untrusted.port, {
    Origin: 'https://drop.home.arpa',
    'X-Forwarded-Host': 'drop.home.arpa'
  }), 403);

  const trusted = await withServer(t, { trustProxy: true });
  assert.equal(await rawUpgrade(trusted.port, {
    Origin: 'https://drop.home.arpa',
    'X-Forwarded-Host': 'drop.home.arpa'
  }), 101);
});

test('a share POSTed to the server is refused unread and redirected, never stored', async t => {
  const { app, port } = await withServer(t);
  const form = new FormData();
  form.append('text', 'hello');
  form.append('files', new Blob([new Uint8Array(64 * 1024)]), 'secret.bin');
  const response = await fetch(`http://127.0.0.1:${port}/share`, { method: 'POST', body: form, redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/?shared=failed');
  assert.equal(app.blobStore.stats().files, 0);
});
