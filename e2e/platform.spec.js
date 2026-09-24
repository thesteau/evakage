import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { startServer } from '../tests/helpers.js';

test('engine smoke: identity, relay chat and verified file download', async ({ browser }) => {
  /** @type {(() => Promise<void>)[]} */
  const cleanup = [];
  const { base } = await startServer({ after: (/** @type {() => Promise<void>} */ fn) => cleanup.push(fn) });
  const contexts = [];
  const pages = [];
  /** @type {string[]} */
  const errors = [];
  try {
    for (const name of ['Alice', 'Bob']) {
      const context = await browser.newContext();
      contexts.push(context);
      await context.addInitScript(name => {
        localStorage.setItem('aria-drop-device-name', name);
        localStorage.setItem('aria-drop-force-relay', '1');
        localStorage.setItem('aria-drop-incoming', 'auto');
      }, name);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await expect(page.locator('#selfCode')).not.toHaveText('----');
      pages.push(page);
    }
    const [alice, bob] = pages;
    await alice.getByRole('button', { name: 'Chat with Bob', exact: true }).click();
    await bob.getByRole('button', { name: 'Chat with Alice', exact: true }).click();
    await alice.locator('#messageInput').fill('Across browser engines');
    await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
    await expect(bob.locator('#timeline')).toContainText('Across browser engines');
    const bytes = Buffer.alloc(200000, 37);
    await alice.locator('#fileInput').setInputFiles({ name: 'engine.bin', mimeType: 'application/octet-stream', buffer: bytes });
    const row = bob.locator('.file-item').filter({ hasText: 'engine.bin' });
    await expect(row).toContainText('SHA-256 ✓');
    const downloading = bob.waitForEvent('download');
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    expect(await fs.readFile(await (await downloading).path())).toEqual(bytes);
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    for (const fn of cleanup) await fn();
  }
});
