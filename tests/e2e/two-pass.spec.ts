import { test, deviceNames, whenControlled } from './helpers.js';
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';

import type { Page } from '@playwright/test';

/** Counts body downloads as the server sees them, whatever the browser routes. */
function countDownloads(server: any) {
  const initial = server.downloads;
  return { get gets() { return server.downloads - initial; } };
}

const storedFiles = (server: any) =>
  [...server.blobStore.blobs.values()].filter((blob) => blob.kind === 'file');

/** * How a download ended: null only if it completed. An errored stream is
 * cancelled by Chromium and failed by WebKit; Firefox never completes it, but
 * Playwright's Firefox driver never reports the failure either. */
function outcome(download: import('@playwright/test').Download) {
  return Promise.race([
    download.failure(),
    new Promise((resolve) => setTimeout(() => resolve('did not complete within 5s'), 5000)),
  ]);
}

/** Every toast the page shows, kept after the toast itself times out. */
async function recordToasts(page: Page) {
  await page.evaluate(() => {
    const seen = ((window as any).__toasts = []) as string[];
    new MutationObserver((records) => {
      for (const record of records)
        {for (const node of record.addedNodes) seen.push(node.textContent || '');}
    }).observe(document.querySelector('#toastRegion') as Element, { childList: true });
  });
  return () => page.evaluate(() => ((window as any).__toasts as string[]).join('\n'));
}

/** Relays a file from Alice to Bob and waits for Bob's verify pass. Opens the
 * conversations without waiting for a direct channel, which not every engine
 * under test can make; the file goes through the server either way. */
async function relayAndVerify(
  { alice, bob }: { alice: Page; bob: Page },
  name: string,
  bytes: Buffer,
) {
  for (const [page, peer] of [
    [alice, 'Bob'],
    [bob, 'Alice'],
  ] as const) {
    await page
      .getByRole('button', { name: `Open conversation with ${deviceNames.get(peer)}`, exact: true })
      .click();
    await expect(page.locator('#sessionPanel')).toBeVisible();
  }
  await whenControlled(bob);
  await alice.locator('#forceRelayInput').check();
  await alice
    .locator('#fileInput')
    .setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
  await bob.getByRole('button', { name: `Accept ${name}`, exact: true }).click();
  const row = bob.locator('#timeline .file-item').filter({ hasText: name });
  await expect(row).toContainText('SHA-256 ✓');
  return row;
}

test('two-pass: verify discards, Save refetches and streams exact bytes, then releases', async ({
  devices,
}) => {
  const seen = countDownloads(devices.server);
  const bytes = Buffer.alloc(800000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
  const row = await relayAndVerify(devices, 'two-pass.bin', bytes);
  expect(seen.gets).toBe(1);
  // Verified but not yet saved: the server still holds the only copy.
  expect(storedFiles(devices.server)).toHaveLength(1);
  await expect(row).toContainText('left');

  const downloading = devices.bob.waitForEvent('download');
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloading;
  expect(download.url()).toContain('/save-stream/');
  expect(download.suggestedFilename()).toBe('two-pass.bin');
  expect(await download.failure()).toBeNull();
  expect(await fs.readFile(await download.path())).toEqual(bytes);
  expect(seen.gets).toBe(2);
  await expect(row.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  await expect.poll(() => storedFiles(devices.server).length).toBe(0);
});

for (const fault of ['tampered', 'truncated']) {
  test(`two-pass: a ${fault} second pass fails the download and Save can be retried`, async ({
    devices,
  }) => {
    const { bob } = devices;
    const seen = countDownloads(devices.server);
    const bytes = Buffer.alloc(800000, 57);
    const row = await relayAndVerify(devices, `${fault}.bin`, bytes);
    const toasts = await recordToasts(bob);
    // The server alters the ciphertext it serves after the verify pass: the
    // hostile-server case, done on disk so it works the same in every engine.
    const [stored] = storedFiles(devices.server);
    const original = await fs.readFile(stored.path);
    const altered = Buffer.from(original);
    altered[256 * 1024 + 28 + 20] ^= 1;
    await fs.writeFile(stored.path, fault === 'tampered' ? altered : original.subarray(0, 300000));

    // Whether an engine reports the failed attempt as a download at all varies;
    // what must hold is that none of them completes.

    const downloads: import('@playwright/test').Download[] = [];
    bob.on('download', (download) => downloads.push(download));
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(toasts).toContain(`Could not save ${fault}.bin`);
    await expect(row.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    const failedAttempts = downloads.length;
    for (const failed of downloads) expect(await outcome(failed)).not.toBeNull();
    // Nothing was released: the verified copy can still be fetched again.
    expect(storedFiles(devices.server)).toHaveLength(1);
    expect(seen.gets).toBe(2);

    await fs.writeFile(stored.path, original);
    // Playwright's Firefox driver can drop a synthesized click while it still
    // tracks the failed download, so the retry is dispatched to the button directly.
    await row.getByRole('button', { name: 'Save', exact: true }).dispatchEvent('click');
    await expect(row.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    await expect.poll(() => downloads.length).toBe(failedAttempts + 1);
    const download = downloads.at(-1) as import('@playwright/test').Download;
    expect(download.url()).toContain('/save-stream/');
    expect(await download.failure()).toBeNull();
    expect(await fs.readFile(await download.path())).toEqual(bytes);
    expect(seen.gets).toBe(3);
  });
}

test('two-pass: an item that expires between the passes cannot be saved', async ({ devices }) => {
  const seen = countDownloads(devices.server);
  const row = await relayAndVerify(devices, 'expired.bin', Buffer.alloc(300000, 5));
  const toasts = await recordToasts(devices.bob);
  for (const blob of storedFiles(devices.server)) await devices.server.blobStore.remove(blob.id);
  let downloads = 0;
  devices.bob.on('download', () => downloads++);
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(toasts).toContain('expired.bin is no longer on the server');
  await expect(row.getByRole('button', { name: 'Gone', exact: true })).toBeDisabled();
  expect(seen.gets).toBe(1);
  expect(downloads).toBe(0);
});

test('two-pass: blocking the sender between the passes refuses Save', async ({ devices }) => {
  const { bob } = devices;
  const seen = countDownloads(devices.server);
  const row = await relayAndVerify(devices, 'blocked.bin', Buffer.alloc(300000, 6));
  const toasts = await recordToasts(bob);
  await bob.locator('#closeSession').click();
  await bob.getByRole('button', { name: 'Known devices', exact: true }).click();
  await bob
    .locator('#knownDeviceList .device-row')
    .filter({ hasText: deviceNames.get('Alice') })
    .getByRole('button', { name: `Block ${deviceNames.get('Alice')}`, exact: true })
    .click();
  await bob.locator('#devicesDialog').getByRole('button', { name: 'Close', exact: true }).click();
  let downloads = 0;
  bob.on('download', () => downloads++);
  // The conversation, and its verified row, can still be reopened after blocking.
  await bob
    .getByRole('button', {
      name: `Open conversation with ${deviceNames.get('Alice')}`,
      exact: true,
    })
    .click();
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(toasts).toContain('Cannot save blocked.bin');
  expect(seen.gets).toBe(1);
  expect(downloads).toBe(0);
});

test('two-pass: blocking the sender during the save pass fails the download', async ({
  devices,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'throttles through the Chrome DevTools Protocol');
  const { bob } = devices;
  const row = await relayAndVerify(devices, 'revoked-save.bin', Buffer.alloc(800000, 8));
  const toasts = await recordToasts(bob);
  // Slow the save pass enough that the block lands while bytes are streaming.
  const cdp = await bob.context().newCDPSession(bob);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: 100 * 1024,
    uploadThroughput: -1,
  });
  const downloading = bob.waitForEvent('download');
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloading;
  expect(download.url()).toContain('/save-stream/');
  await expect(row.getByRole('button', { name: 'Saving…', exact: true })).toBeVisible();
  await bob.locator('#closeSession').click();
  await bob.getByRole('button', { name: 'Known devices', exact: true }).click();
  await bob
    .locator('#knownDeviceList .device-row')
    .filter({ hasText: deviceNames.get('Alice') })
    .getByRole('button', { name: `Block ${deviceNames.get('Alice')}`, exact: true })
    .click();
  await bob.locator('#devicesDialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(toasts).toContain('Sender authorization was revoked');
  expect(await outcome(download)).not.toBeNull();
  expect(storedFiles(devices.server)).toHaveLength(1);
});

test.describe('without a streamed save', () => {
  test.use({
    appPatch: {
      device: 'Bob',
      patch: (source) =>
        source.replace('const twoPass = streamSaveAvailable();', 'const twoPass = false;'),
    },
  });
  test('a relayed file is verified in one pass, kept for Save and released at once', async ({
    devices,
  }) => {
    const seen = countDownloads(devices.server);
    const bytes = Buffer.alloc(800000, 66);
    const row = await relayAndVerify(devices, 'single-pass.bin', bytes);
    await expect.poll(() => storedFiles(devices.server).length).toBe(0);
    const downloading = devices.bob.waitForEvent('download');
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    const download = await downloading;
    expect(download.url()).toMatch(/^blob:/);
    expect(await fs.readFile(await download.path())).toEqual(bytes);
    expect(seen.gets).toBe(1);
  });
});

test.describe('when the worker cannot take the save', () => {
  test.use({
    appPatch: {
      device: 'Bob',
      patch: (source) =>
        source.replace(
          /await saveStream\(\{\s*name: record\.name/,
          "if (record.name.startsWith('fallback')) throw new StreamSaveUnavailable('test');\n      await saveStream({ name: record.name",
        ),
    },
  });
  test('Save falls back to the same verified second pass, held in memory', async ({ devices }) => {
    const seen = countDownloads(devices.server);
    const bytes = Buffer.alloc(800000, 67);
    const row = await relayAndVerify(devices, 'fallback.bin', bytes);
    expect(storedFiles(devices.server)).toHaveLength(1);
    const downloading = devices.bob.waitForEvent('download');
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    const download = await downloading;
    expect(download.url()).toMatch(/^blob:/);
    expect(await fs.readFile(await download.path())).toEqual(bytes);
    expect(seen.gets).toBe(2);
    await expect(row.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    await expect.poll(() => storedFiles(devices.server).length).toBe(0);
  });
});
