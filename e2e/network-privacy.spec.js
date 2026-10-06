import { test, expect } from '@playwright/test';
import { startServer } from '../tests/helpers.js';

/** @param {import('@playwright/test').Page} page */
async function advertise(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#discoverableInput').check();
  await page.locator('#settingsDialog').getByRole('button', { name: 'Done' }).click();
}
test('fresh profiles are private; room details appear only after code join', async ({ browser }) => {
  const cleanup = /** @type {(() => Promise<void>)[]} */ ([]);
  const { base } = await startServer({ after: fn => cleanup.push(fn) });
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const first = await a.newPage();
    const second = await b.newPage();
    for (const page of [first, second]) {
      await page.goto(base);
      await expect(page.locator('#selfCode')).not.toHaveText('----');
      await expect(page.locator('#peerRows tr')).toHaveCount(1);
    }
    await advertise(second);
    await expect(first.locator('#peerRows tr')).toHaveCount(2);
    await second.getByRole('button', { name: 'Settings', exact: true }).click();
    await second.locator('#discoverableInput').uncheck();
    await second.locator('#settingsDialog').getByRole('button', { name: 'Done' }).click();
    await expect(first.locator('#peerRows tr')).toHaveCount(1);
    await first.locator('#roomNameInput').fill('Private room');
    await first.locator('#createRoomForm').getByRole('button', { name: 'Create' }).click();
    await expect(first.locator('#roomRows tr')).toHaveCount(1);
    await expect(second.locator('#roomRows tr')).toHaveCount(0);
    const code = await first.locator('#roomRows .peer-code').innerText();
    await second.locator('#roomCodeInput').fill(code);
    await second.locator('#joinRoomForm').getByRole('button', { name: 'Join by code' }).click();
    await expect(second.locator('#roomRows tr')).toHaveCount(1);
    await second.locator('#leaveRoomBtn').click();
    await expect(second.locator('#roomRows tr')).toHaveCount(0);
    await expect(first.locator('#roomRows tr')).toHaveCount(1);
  } finally {
    await a.close(); await b.close();
    for (const fn of cleanup) await fn();
  }
});
test('simultaneous first-use tabs share one identity and replacement stops reconnecting', async ({ browser }) => {
  const cleanup = /** @type {(() => Promise<void>)[]} */ ([]);
  const { base, app } = await startServer({ after: fn => cleanup.push(fn) });
  const context = await browser.newContext();
  try {
    const first = await context.newPage();
    const second = await context.newPage();
    await Promise.all([first.goto(base), second.goto(base)]);
    for (const page of [first, second]) await expect(page.locator('#selfCode')).not.toHaveText('----');
    const id = await first.locator('#selfCode').getAttribute('data-device-id');
    await expect(second.locator('#selfCode')).toHaveAttribute('data-device-id', id || '');
    await expect.poll(() => app.clients.size).toBe(1);
    await expect.poll(async () => [await first.locator('#serverState').innerText(), await second.locator('#serverState').innerText()].filter(s => s.includes('another tab')).length).toBe(1);
    for (const page of [first, second]) await expect(page.locator('#peerRows tr')).toHaveCount(1);
  } finally {
    await context.close();
    for (const fn of cleanup) await fn();
  }
});
test('camera QR scanning pairs in the app and stops camera tracks', async ({ browser }) => {
  const cleanup = /** @type {(() => Promise<void>)[]} */ ([]);
  const { base } = await startServer({ after: fn => cleanup.push(fn) });
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const first = await a.newPage(); const second = await b.newPage();
    for (const page of [first, second]) { await page.goto(base); await expect(page.locator('#selfCode')).not.toHaveText('----'); }
    const code = await second.locator('#selfCode').innerText();
    const device = await second.locator('#selfCode').getAttribute('data-device-id');
    await first.evaluate(async invitation => {
      const modulePath = '/qr.js';
      const { drawQr } = await import(modulePath);
      const canvas = document.createElement('canvas');
      drawQr(canvas, invitation);
      const stream = canvas.captureStream(10);
      const timer = setInterval(() => {
        if (stream.getVideoTracks()[0].readyState === 'ended') { clearInterval(timer); return; }
        canvas.getContext('2d')?.drawImage(canvas, 0, 0);
      }, 100);
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => stream });
    }, `${base}/#${new URLSearchParams({ pair: code, device: device || '' })}`);
    await first.getByRole('button', { name: 'Add a device', exact: true }).click();
    await first.getByRole('button', { name: 'Scan a QR code', exact: true }).click();
    await expect(first.locator('#sessionPanel')).toBeVisible();
    await expect(first.locator('#scanQrDialog')).not.toBeVisible();
    await expect(first.locator('#addDeviceDialog')).not.toBeVisible();
    await expect.poll(() => first.locator('#scanQrVideo').evaluate(video => /** @type {HTMLVideoElement} */ (video).srcObject === null)).toBe(true);
    // The camera stub always returns the same stream, including after it stops.
    await expect.poll(() => first.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      return stream.getTracks().every(track => track.readyState === 'ended');
    })).toBe(true);
    await first.locator('#closeSession').click();
    await first.getByRole('button', { name: 'Known devices', exact: true }).click();
    await expect(first.locator('#knownDeviceList')).toContainText('Paired');
  } finally {
    await a.close(); await b.close();
    for (const fn of cleanup) await fn();
  }
});
