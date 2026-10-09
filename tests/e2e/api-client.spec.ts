import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { EvakageClient, MemoryStore, type IncomingFile } from '../../app/sdk/index.js';
import { startServer } from '../unit/helpers.js';

test('API and browser devices chat and exchange verified files in both directions', async ({ page }) => {
  const cleanup: (() => any)[] = [];
  const { base, app } = await startServer({ after: fn => cleanup.push(fn) });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-api-browser-'));
  const client = new EvakageClient({ url: base, store: new MemoryStore(), autoReconnect: false });
  const errors: string[] = [];
  client.on('client-error', error => errors.push(error.message));
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base);
    await expect(page.locator('#selfCode')).not.toHaveText('----');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('input[value="always"]').check();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const browserId = (await page.locator('#selfCode').getAttribute('data-device-id'))!;
    const self = await client.connect();
    await client.pair(await page.locator('#selfCode').innerText(), browserId);
    await page.getByRole('button', { name: `Open conversation with ${self.name}`, exact: true }).click();
    await expect(page.locator('#secureState')).toHaveText('Encrypted · via server');
    await expect(page.locator('#peerRows tr').filter({ hasText: 'Node · API' })).toContainText('Online · via server');
    await client.sendText(browserId, 'Hello browser, from the API');
    await expect(page.locator('#timeline').getByText('Hello browser, from the API', { exact: true })).toHaveCount(1);
    const incoming = once(client, 'message', { signal: AbortSignal.timeout(15000) });
    await page.locator('#messageInput').fill('Hello API, from the browser');
    await page.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
    expect((await incoming)[0].text).toBe('Hello API, from the browser');

    const outgoing = Buffer.from(Array.from({ length: 600000 }, (_, i) => i % 251));
    await client.sendFile(browserId, new Blob([outgoing]), { name: 'from-api.bin' });
    await page.getByRole('button', { name: 'Accept from-api.bin', exact: true }).click();
    const row = page.locator('#timeline .file-item').filter({ hasText: 'from-api.bin' });
    await expect(row).toContainText('SHA-256 ✓');
    const downloadPromise = page.waitForEvent('download');
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    const download = await downloadPromise;
    expect(await fs.readFile((await download.path())!)).toEqual(outgoing);

    const filePromise = once(client, 'file', { signal: AbortSignal.timeout(15000) });
    const browserBytes = Buffer.from('An encrypted file sent by the browser');
    await page.locator('#fileInput').setInputFiles({ name: 'from-browser.txt', mimeType: 'text/plain', buffer: browserBytes });
    const [file] = await filePromise as [IncomingFile];
    const saved = path.join(directory, 'received.txt');
    await file.save(saved);
    expect(await fs.readFile(saved)).toEqual(browserBytes);
    await client.disconnect();
    await expect.poll(() => app.clients.has(self.id)).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await client.disconnect();
    for (const fn of cleanup) await fn();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
