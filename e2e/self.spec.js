import { test } from './helpers.js';
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';

test('self-chat recovers encrypted messages and uploads after reload', async ({ devices }) => {
  const { alice, bob } = devices;
  await bob.close();
  await expect(alice.locator('#peerRows tr')).toHaveCount(0);
  await alice.getByRole('button', { name: 'Message yourself', exact: true }).click();
  await alice.locator('#messageInput').fill('A note to myself');
  await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(alice.locator('#timeline')).toContainText('via server');
  const uploaded = alice.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/blob/') && response.status() === 204);
  await alice.locator('#fileInput').setInputFiles({ name: 'self.txt', mimeType: 'text/plain', buffer: Buffer.from('private self upload') });
  await uploaded;
  await alice.reload();
  await expect(alice.locator('#selfCode')).not.toHaveText('----');
  await alice.getByRole('button', { name: 'Message yourself', exact: true }).click();
  await expect(alice.locator('#timeline')).toContainText('A note to myself');
  await expect(alice.locator('#timeline')).toContainText('self.txt');
  await expect(alice.locator('#timeline')).toContainText('SHA-256');
  const downloading = alice.waitForEvent('download');
  await alice.locator('#timeline .file-item').getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloading;
  expect(await fs.readFile(await download.path())).toEqual(Buffer.from('private self upload'));
});
