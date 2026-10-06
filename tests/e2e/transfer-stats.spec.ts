import { expect } from '@playwright/test';
import { test, openPeer } from './helpers.js';

test('a measured relay upload shows speed and remaining time, then clears the estimate', async ({
  devices,
}) => {
  const { alice, bob } = devices;
  await openPeer(alice, 'Bob');
  await openPeer(bob, 'Alice');
  await alice.locator('#forceRelayInput').check();
  await alice.route('**/blob/**', async (route) => {
    if (route.request().method() === 'PUT')
      {await new Promise((resolve) => setTimeout(resolve, 350));}
    await route.continue();
  });
  await alice.locator('#fileInput').setInputFiles({
    name: 'measured.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(2 * 1024 * 1024, 7),
  });
  const estimate = alice.locator('.file-estimate');
  await expect(estimate).toContainText('/s');
  await expect(estimate).toContainText('remaining');
  await expect(bob.locator('#timeline')).toContainText('measured.bin');
  await expect(alice.locator('.file-download')).toHaveText('Save');
  await expect(estimate).toHaveText('');
});
