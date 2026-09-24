import { test as base, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { startServer } from '../tests/helpers.js';

/** @typedef {import('@playwright/test').Page} Page */
const test = base.extend(/** @type {import('@playwright/test').Fixtures<{devices: {alice: Page, bob: Page}}, {}, import('@playwright/test').PlaywrightTestArgs, import('@playwright/test').PlaywrightWorkerArgs>} */ ({
  devices: async ({ browser }, use) => {
    const cleanup = [];
    const { base: url } = await startServer({ after: fn => cleanup.push(fn) });
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
      await use({ alice: pages[0], bob: pages[1] });
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
