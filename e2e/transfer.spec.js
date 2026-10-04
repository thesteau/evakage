import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { deviceNames, test, openPeer, chat, sendFile } from './helpers.js';

for (const relay of [false, true]) {
  test(`${relay ? 'forced relay' : 'direct'}: chat both ways, consent and exact file bytes`, async ({ devices }) => {
    const { alice, bob } = devices;
    await openPeer(alice, 'Bob');
    await openPeer(bob, 'Alice');
    if (relay) {
      await alice.locator('#forceRelayInput').check();
      await bob.locator('#forceRelayInput').check();
    }
    await chat(alice, bob, 'Hello Bob');
    await chat(bob, alice, 'Hello Alice');
    await sendFile(alice, bob, 'multi.bin', Buffer.from(Array.from({ length: 200000 }, (_, i) => i % 251)));
    await sendFile(bob, alice, 'empty.bin', Buffer.alloc(0));
    await sendFile(alice, bob, 'declined.bin', Buffer.from('decline me'), false);
    if (relay) await expect(bob.locator('#timeline')).toContainText('via server');
    else await expect(bob.locator('#timeline')).not.toContainText('via server');
  });
}

test('reload restores identity and history from the surviving peer', async ({ devices }) => {
  const { alice, bob } = devices;
  await openPeer(alice, 'Bob');
  await openPeer(bob, 'Alice');
  const code = await alice.locator('#selfCode').innerText();
  await chat(alice, bob, 'Keep this while I reload');
  const bytes = Buffer.from('Retrieve these bytes from the surviving peer');
  await sendFile(alice, bob, 'recovered.bin', bytes);
  await alice.reload();
  await expect(alice.locator('#selfCode')).toHaveText(code);
  await openPeer(alice, 'Bob');
  await expect(alice.locator('#timeline').getByText('Keep this while I reload', { exact: true })).toHaveCount(1);
  const row = alice.locator('#timeline .file-item').filter({ hasText: 'recovered.bin' });
  await row.getByRole('button', { name: 'Request', exact: true }).click();
  await row.getByRole('button', { name: 'Accept recovered.bin', exact: true }).click();
  await expect(row).toContainText('SHA-256 ✓');
  const downloading = alice.waitForEvent('download');
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloading;
  expect(await fs.readFile(await download.path())).toEqual(bytes);
});

test('installed worker serves the app shell offline without caching config', async ({ devices }) => {
  const { alice } = devices;
  await alice.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
  await alice.context().setOffline(true);
  await alice.reload();
  await expect(alice.getByRole('heading', { name: 'Evakage', exact: true })).toBeVisible();
  expect(await alice.evaluate(async () => Boolean(await caches.match('/config.json')))).toBe(false);
});

test('shared text and files pass through the worker once and reach the chosen peer', async ({ devices }) => {
  const { alice, bob } = devices;
  await alice.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
  // Fetch follows the share redirect without loading the app, leaving the
  // bundle queued until navigation below consumes it through MessageChannel.
  const destination = await alice.evaluate(async () => {
    const form = new FormData();
    form.set('text', 'Text from the share sheet');
    form.set('files', new File(['Shared file bytes'], 'shared.txt', { type: 'text/plain' }));
    return (await fetch('/share', { method: 'POST', body: form })).url;
  });
  expect(destination).toMatch(/shared=[a-f0-9-]+/);
  await alice.goto(destination);
  await expect(alice.locator('#shareBanner')).toBeVisible();
  await expect(alice.locator('#messageInput')).toHaveValue('Text from the share sheet');
  await openPeer(alice, 'Bob');
  await openPeer(bob, 'Alice');
  await alice.locator('#shareSendBtn').click();
  await alice.locator('#pickTargetList').getByRole('button').filter({ hasText: deviceNames.get('Bob') }).click();
  await bob.getByRole('button', { name: 'Accept shared.txt', exact: true }).click();
  const row = bob.locator('.file-item').filter({ hasText: 'shared.txt' });
  await expect(row).toContainText('SHA-256 ✓');
  const downloading = bob.waitForEvent('download');
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await fs.readFile(await (await downloading).path(), 'utf8')).toBe('Shared file bytes');
  await alice.goto(destination);
  await expect(alice.locator('#toastRegion')).toContainText('That share expired');
  await expect(alice.locator('#shareBanner')).toBeHidden();
});

for (const attack of ['identity', 'signature']) {
  test(`direct handshake rejects a forged ${attack}`, async ({ devices }) => {
    const { alice, bob } = devices;
    // Alter one peer's outgoing handshake, leaving the receiving app untouched.
    await alice.evaluate(attack => {
      const send = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function(/** @type {any} */ data) {
        if (typeof data === 'string') {
          const message = JSON.parse(data);
          if (attack === 'identity' && message.kind === 'crypto-hello') message.identityKey = message.publicKey;
          if (attack === 'signature' && message.kind === 'crypto-proof') message.signature = btoa('\0'.repeat(64));
          data = JSON.stringify(message);
        }
        return send.call(this, data);
      };
    }, attack);
    await bob.getByRole('button', { name: `Open conversation with ${deviceNames.get('Alice')}`, exact: true }).click();
    await expect(bob.locator('#toastRegion')).toContainText(attack === 'identity' ? 'does not match its device ID' : 'failed to prove ownership');
    await expect(bob.locator('#secureState')).not.toContainText('Encrypted');
  });
}

test('a share past its worker deadline is refused by the app', async ({ devices }) => {
  const { alice } = devices;
  await alice.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
  const destination = await alice.evaluate(async () => {
    const form = new FormData();
    form.set('text', 'Expired text');
    form.set('files', new File(['Expired bytes'], 'expired.txt'));
    return (await fetch('/share', { method: 'POST', body: form })).url;
  });
  expect(destination).toMatch(/shared=[a-f0-9-]+/);
  const worker = alice.context().serviceWorkers()[0];
  // Advance only the worker's wall clock; leave its cleanup timer pending.
  await worker.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 10 * 60 * 1000;
  });
  await alice.goto(destination);
  await expect(alice.locator('#toastRegion')).toContainText('That share expired');
  await expect(alice.locator('#shareBanner')).toBeHidden();
  await expect(alice.locator('#messageInput')).toHaveValue('');
});

test('a cancelled direct transfer resumes retained chunks and verifies the file', async ({ devices }) => {
  const { alice, bob } = devices;
  await openPeer(alice, 'Bob');
  await openPeer(bob, 'Alice');
  await alice.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function() {
      await new Promise(resolve => setTimeout(resolve, 15));
      return read.call(this);
    };
  });
  const bytes = Buffer.alloc(4 * 1024 * 1024, 123);
  await alice.locator('#fileInput').setInputFiles({ name: 'resume.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await bob.getByRole('button', { name: 'Accept resume.bin', exact: true }).click();
  const row = bob.locator('.file-item').filter({ hasText: 'resume.bin' });
  await expect.poll(() => row.locator('progress').evaluate(node => Number(node.getAttribute('value')))).toBeGreaterThan(0);
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  const retained = await row.locator('progress').evaluate(node => Number(node.getAttribute('value')));
  expect(retained).toBeGreaterThan(0);
  expect(retained).toBeLessThan(1);
  await row.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(row).toContainText('SHA-256 ✓');
  await expect(row).not.toContainText('via server');
  const downloading = bob.waitForEvent('download');
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await fs.readFile(await (await downloading).path())).toEqual(bytes);
});

// Regression: `file.chunks` is allocated with `new Array(total)`, so a missing
// chunk leaves a hole, and Array.prototype.some skips holes. A completeness
// check written as `chunks.some(chunk => !chunk)` therefore reported a truncated
// file as complete. A declared hash would still catch it, so the case that
// reached the user was a peer that declared none: the bytes that did arrive were
// concatenated and offered as the whole file.
test.describe('a transfer with a gap in the chunks', () => {
  /** @param {string} source @param {string} from @param {string} to */
  const must = (source, from, to) => {
    if (!source.includes(from)) throw new Error(`patch anchor moved: ${from.slice(0, 48)}…`);
    return source.replace(from, to);
  };

  test.use({
    appPatch: {
      device: 'Bob',
      patch: source => {
        // Drop one chunk in the middle, as a lossy peer would.
        const patched = must(
          source,
          'function receiveFileChunk(link, conv, header, bytes) {\n  const file = conv.files.get(header.id);',
          'function receiveFileChunk(link, conv, header, bytes) {\n  if (header.seq === 1) return;\n  const file = conv.files.get(header.id);'
        );
        // And declare no hash anywhere, so only the completeness check stands
        // between the user and a silently truncated file.
        return must(
          patched,
          "const expected = typeof declaredHash === 'string' ? declaredHash : file.sha256;",
          'const expected = null;'
        );
      }
    }
  });

  test('is refused as incomplete rather than saved truncated', async ({ devices }) => {
    const { alice, bob } = devices;
    await openPeer(alice, 'Bob');
    await openPeer(bob, 'Alice');

    const bytes = Buffer.alloc(4 * 64 * 1024, 7); // four chunks; the second is dropped
    await alice.locator('#fileInput').setInputFiles({ name: 'gap.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await bob.getByRole('button', { name: 'Accept gap.bin', exact: true }).click();

    await expect(bob.locator('#toastRegion')).toContainText('Transfer incomplete: gap.bin');
    const row = bob.locator('.file-item').filter({ hasText: 'gap.bin' });
    await expect(row.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(row).not.toContainText('SHA-256 ✓');
  });
});

test('room history catches up after an away member reconnects', async ({ devices }) => {
  const { alice, bob } = devices;
  await alice.locator('#roomNameInput').fill('Catch-up room');
  await alice.locator('#createRoomForm').getByRole('button', { name: 'Create' }).click();
  await bob.getByRole('button', { name: 'Open room Catch-up room', exact: true }).click();
  await alice.getByRole('button', { name: 'Open room Catch-up room', exact: true }).click();
  await expect(bob.locator('#sessionTitle')).toHaveText('Catch-up room');
  await chat(alice, bob, 'Before going away');
  // Disconnect signaling while retaining the page's RAM state. Prevent the
  // reconnect timer from succeeding until the test restores the network.
  await bob.context().setOffline(true);
  devices.disconnect('Bob');
  await expect(alice.locator('#sessionMembers')).toContainText('away');
  await alice.locator('#messageInput').fill('While you were away');
  await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await bob.context().setOffline(false);
  await bob.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(bob.locator('#timeline').getByText('While you were away', { exact: true })).toHaveCount(1);
  await expect(alice.locator('#sessionMembers')).not.toContainText('away');
});

for (const rejection of ['too-large', 'too-many-files', 'queue-full']) {
  test(`share admission rejection ${rejection} reaches the user`, async ({ devices }) => {
    const { alice } = devices;
    await alice.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      }
    });
    const destination = await alice.evaluate(async reason => {
      const post = async () => {
        const form = new FormData();
        if (reason === 'too-large') form.set('files', new File([new Uint8Array(16 * 1024 * 1024)], 'large.bin'));
        else if (reason === 'too-many-files') {
          for (let i = 0; i < 33; i++) form.append('files', new File(['x'], `${i}.txt`));
        } else form.set('text', 'Queued share');
        return (await fetch('/share', { method: 'POST', body: form })).url;
      };
      if (reason === 'queue-full') for (let i = 0; i < 8; i++) await post();
      return post();
    }, rejection);
    expect(new URL(destination).searchParams.get('shared')).toBe(rejection);
    await alice.goto(destination);
    const message = rejection === 'too-large' ? '16 MiB share-sheet limit'
      : rejection === 'too-many-files' ? 'Share at most 32 files' : 'The share queue is full';
    await expect(alice.locator('#toastRegion')).toContainText(message);
    await expect(alice.locator('#shareBanner')).toBeHidden();
    expect(await alice.evaluate(() => new URL(location.href).searchParams.has('shared'))).toBe(false);
  });
}
