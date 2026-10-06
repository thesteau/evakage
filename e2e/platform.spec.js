import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { pairDevices, whenControlled } from './helpers.js';
import { startServer } from '../tests/helpers.js';

for (const twoPass of [false, true]) {
  test(twoPass ? 'engine smoke: two-pass relay receive with a streamed save'
    : 'engine smoke: identity, relay chat and verified file download', async ({ browser }, info) => {
    /** @type {(() => Promise<void>)[]} */
    const cleanup = [];
    const { base } = await startServer({ after: (/** @type {() => Promise<void>} */ fn) => cleanup.push(fn) });
    const contexts = [];
    const pages = [];
    /** @type {string[]} */
    const errors = [];
    try {
      for (let i = 0; i < 2; i++) {
        const context = await browser.newContext();
        contexts.push(context);
        await context.addInitScript(() => {
          localStorage.setItem('evakage-force-relay', '1');
          localStorage.setItem('evakage-incoming', 'auto');
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        // Test app readiness below rather than waiting for every page resource.
        await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await expect(page.locator('#selfCode')).not.toHaveText('----');
        pages.push(page);
      }
      const [alice, bob] = pages;
      if (twoPass) await whenControlled(bob);
      await pairDevices(alice, bob);
      await alice.getByRole('button', { name: `Open conversation with ${await bob.locator('#selfCode').getAttribute('data-device-name')}`, exact: true }).click();
      await bob.getByRole('button', { name: `Open conversation with ${await alice.locator('#selfCode').getAttribute('data-device-name')}`, exact: true }).click();
      await alice.locator('#messageInput').fill('Across browser engines');
      await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
      await expect(bob.locator('#timeline')).toContainText('Across browser engines');
      const bytes = Buffer.alloc(200000, 37);
      await alice.locator('#fileInput').setInputFiles({ name: 'engine.bin', mimeType: 'application/octet-stream', buffer: bytes });
      const row = bob.locator('.file-item').filter({ hasText: 'engine.bin' });
      await expect(row).toContainText('SHA-256 ✓');
      const downloading = bob.waitForEvent('download');
      await row.getByRole('button', { name: 'Save', exact: true }).click();
      const download = await downloading;
      expect(await fs.readFile(await download.path())).toEqual(bytes);
      if (twoPass) expect(download.url()).toContain('/save-stream/');
      info.annotations.push({ type: 'save', description: download.url().replace(/[0-9a-f-]{36}$/, '<id>') });
      expect(errors).toEqual([]);
    } finally {
      for (const context of contexts) await context.close();
      for (const fn of cleanup) await fn();
    }
  });
}
