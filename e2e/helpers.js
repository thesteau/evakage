import { test as base, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { startServer } from '../tests/helpers.js';

/** @typedef {import('@playwright/test').Page} Page */
export const test = base.extend(/** @type {import('@playwright/test').Fixtures<{devices: {alice: Page, bob: Page, disconnect: (name: string) => void}}, {}, import('@playwright/test').PlaywrightTestArgs, import('@playwright/test').PlaywrightWorkerArgs>} */ ({
  devices: async ({ browser }, use) => {
    /** @type {(() => Promise<void>)[]} */
    const cleanup = [];
    const { base: url, app } = await startServer({ after: fn => cleanup.push(fn) });
    const contexts = [];
    /** @type {string[]} */
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

/** @param {Page} page @param {string} name */
export async function openPeer(page, name) {
  await page.locator('#peerRows tr').filter({ hasText: name })
    .getByRole('button', { name: `Chat with ${name}`, exact: true }).click();
  await expect(page.locator('#secureState')).toContainText('Encrypted');
}

/** @param {Page} sender @param {Page} receiver @param {string} text */
export async function chat(sender, receiver, text) {
  await sender.locator('#messageInput').fill(text);
  await sender.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(receiver.locator('#timeline').getByText(text, { exact: true })).toHaveCount(1);
}

/** @param {Page} sender @param {Page} receiver @param {string} name @param {Buffer} buffer */
export async function sendFile(sender, receiver, name, buffer, accept = true) {
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

