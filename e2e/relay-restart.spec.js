import { test, openPeer } from './helpers.js';
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';

test('interrupted relay uploads and downloads restart from byte zero', async ({ devices }) => {
  const { alice, bob } = devices;
  await openPeer(alice, 'Bob'); await openPeer(bob, 'Alice');
  await alice.locator('#forceRelayInput').check();
  const bytes = Buffer.alloc(800000, 91);
  let allowUpload = false;
  /** @type {number[]} */
  const offsets = [];
  /** @type {string[]} */
  const uploadIds = [];
  await alice.route('**/blob/**', async route => {
    const request = route.request();
    const offset = Number(new URL(request.url()).searchParams.get('offset'));
    if (request.method() === 'PUT') {
      offsets.push(offset);
      uploadIds.push(new URL(request.url()).pathname);
      if (offset > 0 && !allowUpload) { await route.abort('failed'); return; }
    }
    await route.continue();
  });
  let partial = false;
  /** @type {number[]} */
  const downloads = [];
  await bob.route('**/blob/**', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    downloads.push(offset);
    if (!partial) {
      partial = true;
      const response = await route.fetch();
      const ciphertext = await response.body();
      const truncated = ciphertext.subarray(0, 300000);
      await route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: truncated });
    } else await route.continue();
  });
  await alice.locator('#fileInput').setInputFiles({ name: 'restart.bin', mimeType: 'application/octet-stream', buffer: bytes });
  const sent = alice.locator('#timeline .file-item');
  await expect(sent.getByRole('button', { name: 'Restart upload', exact: true })).toBeVisible();
  expect(offsets.filter(offset => offset === 0)).toHaveLength(1);
  allowUpload = true;
  await sent.getByRole('button', { name: 'Restart upload', exact: true }).click();
  const received = bob.locator('#timeline .file-item');
  await received.getByRole('button', { name: 'Accept restart.bin', exact: true }).click();
  await expect(received.getByRole('button', { name: 'Restart download', exact: true })).toBeVisible();
  await expect(received.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  const registration = bob.waitForEvent('websocket').then(socket => new Promise(resolve => {
    socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === 'registered') resolve(message);
    });
  }));
  devices.disconnect('Bob');
  await registration;
  await expect(received.getByRole('button', { name: 'Restart download', exact: true })).toBeVisible();
  expect(downloads).toEqual([0]);
  await received.getByRole('button', { name: 'Restart download', exact: true }).click();
  await expect(received.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(received).toContainText('SHA-256');
  expect(offsets.filter(offset => offset === 0)).toHaveLength(2);
  expect(downloads).toEqual([0, 0]);
  expect(new Set(uploadIds).size).toBe(2);
  const downloading = bob.waitForEvent('download');
  await received.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await fs.readFile(await (await downloading).path())).toEqual(bytes);
});
