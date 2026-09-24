import { test as base, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { startServer } from '../tests/helpers.js';

/** @typedef {import('@playwright/test').Page} Page */
const test = base.extend(/** @type {import('@playwright/test').Fixtures<{devices: {alice: Page, bob: Page, disconnect: (name: string) => void}}, {}, import('@playwright/test').PlaywrightTestArgs, import('@playwright/test').PlaywrightWorkerArgs>} */ ({
  devices: async ({ browser }, use) => {
    const cleanup = [];
    const { base: url, app } = await startServer({ after: fn => cleanup.push(fn) });
    const contexts = [];
    const pageErrors = [];
    try {
      const pages = [];
      for (const name of ['Alice', 'Bob']) {
        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(url);
        await expect(page.locator('#selfCode')).not.toHaveText('----');
        await page.getByRole('button', { name: 'Rename device' }).click();
        await page.locator('#renameInput').fill(name);
        await page.locator('#renameSave').click();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.locator('input[value="always"]').check();
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        pages.push(page);
      }
      await use({ alice: pages[0], bob: pages[1], disconnect: name => {
        for (const client of app.clients.values()) if (client.name === name) client.ws.close();
      } });
      expect(pageErrors).toEqual([]);
    } finally {
      for (const context of contexts) await context.close();
      for (const fn of cleanup) await fn();
    }
  }
}));

async function openPeer(page, name) {
  await page.locator('#peerRows tr').filter({ hasText: name })
    .getByRole('button', { name: `Chat with ${name}`, exact: true }).click();
  await expect(page.locator('#secureState')).toContainText('Encrypted');
}

async function chat(sender, receiver, text) {
  await sender.locator('#messageInput').fill(text);
  await sender.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(receiver.locator('#timeline').getByText(text, { exact: true })).toHaveCount(1);
}

async function sendFile(sender, receiver, name, buffer, accept = true) {
  await sender.locator('#fileInput').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await receiver.getByRole('button', { name: `${accept ? 'Accept' : 'Decline'} ${name}`, exact: true }).click();
  const row = receiver.locator('#timeline .file-item').filter({ hasText: name });
  if (!accept) {
    await expect(row.getByRole('button', { name: 'Declined', exact: true })).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    return;
  }
  await expect(row).toContainText('SHA-256 ✓');
  const downloading = receiver.waitForEvent('download');
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(name);
  expect(await fs.readFile(await download.path())).toEqual(buffer);
}

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
  await expect(alice.getByRole('heading', { name: 'aria-drop', exact: true })).toBeVisible();
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
  await alice.locator('#pickTargetList').getByRole('button').filter({ hasText: 'Bob' }).click();
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
      RTCDataChannel.prototype.send = function(data) {
        if (typeof data === 'string') {
          const message = JSON.parse(data);
          if (attack === 'identity' && message.kind === 'crypto-hello') message.identityKey = message.publicKey;
          if (attack === 'signature' && message.kind === 'crypto-proof') message.signature = btoa('\0'.repeat(64));
          data = JSON.stringify(message);
        }
        return send.call(this, data);
      };
    }, attack);
    await bob.getByRole('button', { name: 'Chat with Alice', exact: true }).click();
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

test('room history catches up after an away member reconnects', async ({ devices }) => {
  const { alice, bob } = devices;
  await alice.locator('#roomNameInput').fill('Catch-up room');
  await alice.locator('#createRoomForm').getByRole('button', { name: 'Create' }).click();
  await bob.getByRole('button', { name: 'Join room Catch-up room', exact: true }).click();
  await alice.getByRole('button', { name: 'Open room Catch-up room', exact: true }).click();
  await bob.getByRole('button', { name: 'Open room Catch-up room', exact: true }).click();
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
