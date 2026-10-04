import { test, openPeer, deviceNames } from './helpers.js';
import { expect } from '@playwright/test';
import jsQR from 'jsqr';

/** @param {import('@playwright/test').Page} page @param {string} name */
async function verify(page, name) {
  await page.locator('#closeSession').click();
  await page.getByRole('button', { name: 'Known devices', exact: true }).click();
  await page.getByRole('button', { name: `Verify ${name}`, exact: true }).click();
  const code = await page.locator('#pairingCode').innerText();
  await page.locator('#pairingInput').fill('123');
  await page.locator('#pairingForm').getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.locator('#pairingFeedback')).toContainText('do not match');
  await page.locator('#pairingInput').fill(code);
  await page.locator('#pairingForm').getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.locator('#pairingDialog')).not.toBeVisible();
  await expect(page.locator('#knownDeviceList')).toContainText('Verified');
  await page.locator('#devicesDialog').getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: `Open conversation with ${name}`, exact: true }).click();
  return code;
}

test('verification gates sending, compares matching codes, persists, and blocking stops exchanges', async ({ devices }) => {
  const { alice, bob } = devices;
  await openPeer(alice, 'Bob'); await openPeer(bob, 'Alice');
  await alice.getByRole('button', { name: 'Settings', exact: true }).click();
  await alice.locator('#verifiedOnlyInput').check();
  await alice.locator('#settingsDialog').getByRole('button', { name: 'Done', exact: true }).click();
  await alice.locator('#messageInput').fill('Blocked until verified');
  await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(alice.locator('#toastRegion')).toContainText('Verify or unblock');
  await expect(bob.locator('#timeline')).not.toContainText('Blocked until verified');
  const codeA = await verify(alice, deviceNames.get('Bob'));
  const codeB = await verify(bob, deviceNames.get('Alice'));
  expect(codeA).toBe(codeB);
  await alice.locator('#messageInput').fill('Verified delivery');
  await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(bob.locator('#timeline')).toContainText('Verified delivery');
  await alice.reload();
  await expect(alice.locator('#selfCode')).not.toHaveText('----');
  await openPeer(alice, 'Bob');
  await alice.locator('#closeSession').click();
  await alice.getByRole('button', { name: 'Known devices', exact: true }).click();
  await expect(alice.locator('#knownDeviceList')).toContainText('Verified');
  await alice.getByRole('button', { name: `Block ${deviceNames.get('Bob')}`, exact: true }).click();
  await expect(alice.locator('#knownDeviceList')).toContainText('Blocked');
  await alice.locator('#devicesDialog').getByRole('button', { name: 'Done', exact: true }).click();
  await alice.getByRole('button', { name: `Open conversation with ${deviceNames.get('Bob')}`, exact: true }).click();
  await alice.locator('#messageInput').fill('Blocked device cannot receive');
  await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(alice.locator('#toastRegion')).toContainText('Verify or unblock');
  await expect(bob.locator('#timeline')).not.toContainText('Blocked device cannot receive');
});

test('rendered QR canvases decode to the server URL and device code', async ({ devices }) => {
  const { alice } = devices;
  await alice.getByRole('button', { name: 'QR codes', exact: true }).click();
  for (const [id, label] of [['serverQr', 'qrServerUrl'], ['deviceQr', 'qrDeviceCode']]) {
    const raster = await alice.locator(`#${id}`).evaluate(element => {
      const canvas = /** @type {HTMLCanvasElement} */ (element);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      return { width: canvas.width, height: canvas.height,
        pixels: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data) };
    });
    expect(jsQR(new Uint8ClampedArray(raster.pixels), raster.width, raster.height)?.data)
      .toBe(await alice.locator(`#${label}`).innerText());
  }
});

