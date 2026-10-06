import { test, openPeer, deviceNames, pairDevices, whenControlled } from './helpers.js';
import { test as engineTest, expect, devices as profiles } from '@playwright/test';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { startServer } from '../unit/helpers.js';

for (const action of ['Block', 'Delete']) {
  test(`${action.toLowerCase()} during a relay download prevents accepting or saving it`, async ({
    devices,
  }) => {
    const { alice, bob } = devices;
    await openPeer(alice, 'Bob');
    await openPeer(bob, 'Alice');
    await alice.locator('#forceRelayInput').check();
    let waiting = false;
    let release = () => {};

    const gate: Promise<void> = new Promise((resolve) => {
      release = resolve;
    });
    await bob.route('**/blob/**', async (route: import('@playwright/test').Route) => {
      if (route.request().method() === 'GET') {
        waiting = true;
        await gate;
      }
      await route.continue();
    });
    try {
      await alice
        .locator('#fileInput')
        .setInputFiles({
          name: 'revoked.bin',
          mimeType: 'application/octet-stream',
          buffer: Buffer.alloc(800000, 42),
        });
      await bob.getByRole('button', { name: 'Accept revoked.bin', exact: true }).click();
      await expect.poll(() => waiting).toBe(true);
      await bob.locator('#closeSession').click();
      await bob.getByRole('button', { name: 'Known devices', exact: true }).click();
      const deviceRow = bob
        .locator('#knownDeviceList .device-row')
        .filter({ hasText: deviceNames.get('Alice') });
      await deviceRow
        .getByRole('button', {
          name: action === 'Delete' ? action : `${action} ${deviceNames.get('Alice')}`,
          exact: true,
        })
        .click();
      await bob
        .locator('#devicesDialog')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      release();
      await expect(bob.locator('#toastRegion')).toContainText('Sender authorization was revoked');
      const row = bob.locator('#timeline .file-item').filter({ hasText: 'revoked.bin' });
      await expect(row.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
      await expect(row).not.toContainText('SHA-256 ✓');
    } finally {
      release();
    }
  });
}

test('tampered relay ciphertext is refused before Save', async ({ devices }) => {
  const { alice, bob } = devices;
  await openPeer(alice, 'Bob');
  await openPeer(bob, 'Alice');
  await alice.locator('#forceRelayInput').check();
  await bob.route('**/blob/**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const bytes = await response.body();
    bytes[256 * 1024 + 28 + 20] ^= 1;
    await route.fulfill({ response, body: bytes });
  });
  await alice
    .locator('#fileInput')
    .setInputFiles({
      name: 'tampered.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(800000, 71),
    });
  await bob.getByRole('button', { name: 'Accept tampered.bin', exact: true }).click();
  const row = bob.locator('#timeline .file-item').filter({ hasText: 'tampered.bin' });
  await expect(row.getByRole('button', { name: 'Restart download', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(row).not.toContainText('SHA-256 ✓');
});

engineTest(
  'simulated phone verifies a 32 MiB relay file before Save',
  async ({ browser }, info) => {
    engineTest.setTimeout(120000);
    /* */
    const cleanup: (() => Promise<void>)[] = [];
    const { base } = await startServer({ after: (fn) => cleanup.push(fn) });

    const contexts: import('@playwright/test').BrowserContext[] = [];

    const errors: string[] = [];
    let release = () => {};
    let waiting = false;

    const gate: Promise<void> = new Promise((resolve) => {
      release = resolve;
    });
    try {
      const pages: any[] = [];
      for (let i = 0; i < 2; i++) {
        const context = await browser.newContext(profiles['Pixel 7']);
        contexts.push(context);
        await context.addInitScript(() => {
          localStorage.setItem('evakage-force-relay', '1');
          localStorage.setItem('evakage-incoming', 'auto');
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(base);
        await expect(page.locator('#selfCode')).not.toHaveText('----');
        pages.push(page);
      }
      const [sender, receiver] = pages;
      await whenControlled(receiver);
      await pairDevices(sender, receiver);
      for (const [page, peer] of [
        [sender, receiver],
        [receiver, sender],
      ]) {
        const name = await peer.locator('#selfCode').getAttribute('data-device-name');
        await page
          .getByRole('button', { name: `Open conversation with ${name}`, exact: true })
          .click();
      }
      let gets = 0;
      await receiver.route('**/blob/**', async (route: import('@playwright/test').Route) => {
        if (route.request().method() === 'GET') {
          gets++;
          waiting = true;
          await gate;
        }
        await route.continue();
      });
      const bytes = Buffer.alloc(32 * 1024 * 1024, 93);
      await sender
        .locator('#fileInput')
        .setInputFiles({
          name: 'phone-32MiB.bin',
          mimeType: 'application/octet-stream',
          buffer: bytes,
        });
      await expect.poll(() => waiting, { timeout: 60000 }).toBe(true);
      const row = receiver.locator('.file-item').filter({ hasText: 'phone-32MiB.bin' });
      await expect(row.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
      release();
      await expect(row).toContainText('SHA-256 ✓', { timeout: 60000 });
      expect(gets).toBe(1);
      const downloading = receiver.waitForEvent('download');
      await row.getByRole('button', { name: 'Save', exact: true }).click();
      const download = await downloading;
      expect(download.url()).toContain('/save-stream/');
      expect(await download.failure()).toBeNull();
      // Deep equality enumerates tens of millions of Buffer indices in the test
      // worker. Stream the saved file so validation memory stays chunk-sized.
      const savedPath = await download.path();
      if (!savedPath) throw new Error('The completed download has no saved path');
      expect((await fs.stat(savedPath)).size).toBe(bytes.length);
      const savedHash = createHash('sha256');
      for await (const chunk of createReadStream(savedPath)) savedHash.update(chunk);
      expect(savedHash.digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(gets).toBe(2);
      expect(errors).toEqual([]);
      await info.attach('receiving-validation', {
        contentType: 'application/json',
        body: JSON.stringify(
          {
            profile: 'Chromium Pixel 7 simulation; not physical hardware',
            bytes: bytes.length,
            saveUnavailableBeforeReceipt: true,
            finalHashVerified: true,
            exactSavedBytes: true,
            twoPass: true,
            streamedSave: true,
            bodyFetches: gets,
            // Memory is measured in benchmarks/receive.mjs, not in this browser run.
            browserMemoryMeasured: false,
            pageErrors: errors,
          },
          null,
          2,
        ),
      });
    } finally {
      release();
      for (const context of contexts) await context.close();
      for (const fn of cleanup) await fn();
    }
  },
);
