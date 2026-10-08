import { test, deviceNames } from './helpers.js';
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';

test.use({ autoPair: false });

test('self-chat recovers encrypted messages and uploads after reload', async ({ devices }) => {
  const { alice, bob } = devices;
  await expect(alice.locator('#peerRows tr.self-device')).toContainText('This is you');
  await bob.close();
  await expect(alice.locator('#peerRows tr')).toHaveCount(1);
  await alice.getByRole('button', { name: 'Open conversation with yourself', exact: true }).click();
  await expect(alice.locator('#secureState')).toHaveText('Encrypted');
  await expect(alice.locator('#secureState')).toHaveAttribute(
    'title',
    /24h reconnect window · 3-day limit/,
  );
  await alice.locator('#messageInput').fill('A note to myself');
  await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(alice.locator('#timeline')).toContainText('via server');
  const uploaded = alice.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/blob/') &&
      response.status() === 204,
  );
  await alice
    .locator('#fileInput')
    .setInputFiles({
      name: 'self.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('private self upload'),
    });
  await uploaded;
  await alice.reload();
  await expect(alice.locator('#selfCode')).not.toHaveText('----');
  await alice.getByRole('button', { name: 'Open conversation with yourself', exact: true }).click();
  await expect(alice.locator('#timeline')).toContainText('A note to myself');
  await expect(alice.locator('#timeline')).toContainText('self.txt');
  await expect(alice.locator('#timeline')).toContainText('SHA-256');
  const downloading = alice.waitForEvent('download');
  await alice
    .locator('#timeline .file-item')
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  const download = await downloading;
  expect(await fs.readFile(await download.path())).toEqual(Buffer.from('private self upload'));
});

// Self-notes are kept on the server so they survive a reload. Deleting the
// conversation only dropped the local copy, so everything came back on reload.
test('deleting self notes removes them from the server too', async ({ devices }) => {
  const { alice } = devices;
  await alice.getByRole('button', { name: 'Open conversation with yourself', exact: true }).click();
  await alice.locator('#messageInput').fill('A note to delete');
  await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(alice.locator('#timeline')).toContainText('via server');
  const uploaded = alice.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/blob/') &&
      response.status() === 204,
  );
  await alice
    .locator('#fileInput')
    .setInputFiles({ name: 'delete-me.txt', mimeType: 'text/plain', buffer: Buffer.from('gone') });
  await uploaded;
  await alice.locator('#closeSession').click();
  await alice
    .getByRole('button', { name: 'Delete conversation with yourself', exact: true })
    .click();
  await expect(alice.locator('#deleteDialog')).toBeVisible();
  await expect(alice.locator('#deleteCancel')).toBeFocused();
  await alice.locator('#deleteCancel').click();
  await alice.getByRole('button', { name: 'Open conversation with yourself', exact: true }).click();
  await expect(alice.locator('#timeline')).toContainText('A note to delete');
  await expect(alice.locator('#timeline')).toContainText('delete-me.txt');
  await alice.locator('#closeSession').click();
  await alice.getByRole('button', { name: 'Delete conversation with yourself', exact: true }).click();
  await alice.keyboard.press('Escape');
  await expect(alice.locator('#deleteDialog')).not.toBeVisible();
  await alice.getByRole('button', { name: 'Delete conversation with yourself', exact: true }).click();
  await alice.locator('#deleteConfirm').click();
  await expect(alice.locator('#toastRegion')).toContainText('Deleted your self notes');
  await alice.getByRole('button', { name: 'Open conversation with yourself', exact: true }).click();
  await expect(alice.locator('#timeline')).toContainText('Send yourself a message');
  await alice.reload();
  await expect(alice.locator('#selfCode')).not.toHaveText('----');
  await alice.getByRole('button', { name: 'Open conversation with yourself', exact: true }).click();
  await expect(alice.locator('#timeline')).toContainText('Send yourself a message');
  await expect(alice.locator('#timeline')).not.toContainText('A note to delete');
  await expect(alice.locator('#timeline')).not.toContainText('delete-me.txt');
});

test('self notes require a server connection and retain the draft for retry', async ({
  devices,
}) => {
  const { alice } = devices;
  await alice.getByRole('button', { name: 'Open conversation with yourself', exact: true }).click();
  await alice.context().setOffline(true);
  devices.disconnect('Alice');
  await expect(alice.locator('#secureState')).toContainText('server disconnected');
  await alice.locator('#messageInput').fill('Offline draft to myself');
  await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(alice.locator('#toastRegion')).toContainText('Reconnect to the server');
  await expect(alice.locator('#timeline')).not.toContainText('Offline draft to myself');
  await expect(alice.locator('#messageInput')).toHaveValue('Offline draft to myself');
  await alice.context().setOffline(false);
  await expect(alice.locator('#serverState')).toHaveText('Ready');
  await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(alice.locator('#timeline')).toContainText('Offline draft to myself');
  await expect(alice.locator('#timeline')).toContainText('via server');
});

// The browser's online event reconnects at once while the close handler's
// backoff timer is still pending. Only one socket may come of that: a second
// would replace the first, which the server then closes with 4001.
test('an online event during reconnect backoff opens a single socket', async ({ devices }) => {
  const { alice, server } = devices;
  await alice.evaluate(() => {
    const Native = window.WebSocket;
    (window as any).socketsOpened = 0;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as any).socketsOpened++;
      }
    } as any;
  });
  await alice.getByRole('button', { name: 'Open conversation with yourself', exact: true }).click();
  devices.disconnect('Alice');
  await expect(alice.locator('#serverState')).toHaveText('Not Ready');
  await alice.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(alice.locator('#serverState')).toHaveText('Ready');
  await expect(alice.locator('#selfCode')).not.toHaveText('----');
  // Outlast the backoff timer the close handler scheduled.
  await alice.waitForTimeout(1500);
  expect(await alice.evaluate(() => (window as any).socketsOpened)).toBe(1);
  await expect(alice.locator('#serverState')).toHaveText('Ready');
  expect(
    [...server.clients.values()].filter((client) => client.name === deviceNames.get('Alice')),
  ).toHaveLength(1);
  await alice.locator('#messageInput').fill('After a double reconnect');
  await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(alice.locator('#timeline')).toContainText('After a double reconnect');
  await expect(alice.locator('#timeline')).toContainText('via server');
});
