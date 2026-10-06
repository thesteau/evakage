import { test as base, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { startRoomServer as startServer } from '../tests/helpers.js';

export const deviceNames = new Map();

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {{device: string, patch: (source: string) => string} | null} AppPatch */

export const test = base.extend(/** @type {import('@playwright/test').Fixtures<{devices: {alice: Page, bob: Page, disconnect: (name: string) => void, server: ReturnType<typeof import('../server/server.js').createEvakageServer>}, appPatch: AppPatch, autoPair: boolean}, {}, import('@playwright/test').PlaywrightTestArgs, import('@playwright/test').PlaywrightWorkerArgs>} */ ({
  // Serves one device a rewritten app.js, so a test can play a peer that
  // misbehaves in a way the honest client never would. Set with
  // test.use({ appPatch: { device: 'Bob', patch: source => ... } }).
  appPatch: [null, { option: true }],
  autoPair: [true, { option: true }],

  devices: async ({ browser, appPatch, autoPair }, use) => {
    /** @type {(() => Promise<void>)[]} */
    const cleanup = [];
    deviceNames.clear();
    const { base: url, app } = await startServer({ after: (/** @type {() => Promise<void>} */ fn) => cleanup.push(fn) });
    const contexts = [];
    /** @type {string[]} */
    const pageErrors = [];
    try {
      const pages = [];
      for (const name of ['Alice', 'Bob']) {
        const context = await browser.newContext();
        contexts.push(context);
        if (appPatch?.device === name || appPatch?.device === 'Both') {
          await context.route('**/app.js', async route => {
            const response = await route.fetch();
            // Normalise line endings: patches anchor on multi-line snippets and
            // a Windows checkout with autocrlf serves CRLF.
            const source = (await response.text()).replace(/\r\n/g, '\n');
            const patched = appPatch.patch(source);
            if (patched === source) throw new Error(`appPatch for ${name} matched nothing; the anchor moved`);
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
              body: patched
            });
          });
        }
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(url);
        await expect(page.locator('#selfCode')).not.toHaveText('----');
        deviceNames.set(name, await page.locator('#selfCode').getAttribute('data-device-name'));
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.locator('input[value="always"]').check();
        await page.locator('#discoverableInput').check();
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        pages.push(page);
      }
      if (autoPair) await pairDevices(pages[0], pages[1]);
      await use({ alice: pages[0], bob: pages[1], server: app, disconnect: name => {
        for (const client of app.clients.values()) if (client.name === deviceNames.get(name)) client.ws.close();
      } });
      expect(pageErrors).toEqual([]);
    } finally {
      for (const context of contexts) await context.close();
      for (const fn of cleanup) await fn();
    }
  }
}));

/** Pair through the real owner-only code flow; never seed approval storage.
 * @param {Page} first @param {Page} second @param {boolean} [closeConversations] */
export async function pairDevices(first, second, closeConversations = true) {
  if (!await first.locator('#addDeviceDialog').isVisible()) await first.locator('#addDeviceBtn').click();
  await first.locator('#codeInput').fill(await second.locator('#selfCode').innerText());
  await first.locator('#codeForm').getByRole('button', { name: 'Join', exact: true }).click();
  await expect(first.locator('#codeFeedback')).toContainText('Paired with');
  await expect(first.locator('#sessionPanel')).toBeVisible();
  const id = await first.locator('#selfCode').getAttribute('data-device-id');
  if (await second.evaluate(() => navigator.onLine)) {
    await expect.poll(() => second.evaluate(async other => {
    const modulePath = '/identity.js';
    const { deviceTrust } = await import(modulePath);
    return Boolean(deviceTrust(other)?.pairedAt);
    }, id)).toBe(true);
  }
  await first.locator('#closeSession').click();
  await expect(first.locator('#sessionPanel')).toBeHidden();
  // Pairing opens a temporary direct conversation; close it so room-only tests
  // measure room links rather than direct conversations that also hold links.
  if (!closeConversations) return;
  for (const [page, peer] of [[first, second], [second, first]]) {
    if (await page.locator('#sessionPanel').isVisible()) continue;
    const name = await peer.locator('#selfCode').getAttribute('data-device-name');
    const exit = page.getByRole('button', { name: `Delete conversation with ${name}`, exact: true });
    if (await exit.count()) await exit.click();
  }
}

/** @param {Page} page @param {string} name */
export async function openPeer(page, name) {
  name = deviceNames.get(name) || name;
  await page.locator('#peerRows tr').filter({ hasText: name })
    .getByRole('button', { name: `Open conversation with ${name}`, exact: true }).click();
  await expect(page.locator('#secureState')).toContainText('Encrypted');
}

/** Sign in only the room creator; guests remain anonymous.
 * @param {Page} page */
export async function signInRoomOwner(page) {
  if (await page.locator('#sessionPanel.open').count()) await page.locator('#closeSession').click();
  await page.locator('#accountBtn').click();
  if (await page.locator('#accountForm').isVisible()) {
    await page.locator('#accountUsername').fill(`room_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`);
    await page.locator('#accountPassword').fill('test room account password');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
  }
  await expect(page.locator('#accountStatus')).toContainText('Signed in as');
  await page.locator('#accountDialog').getByRole('button', { name: 'Close', exact: true }).click();
}

/** Waits until the service worker controls the page, so relayed files are
 * received in two passes with a streamed Save.
 * @param {Page} page */
export async function whenControlled(page) {
  await expect.poll(() => page.evaluate(() =>
    navigator.serviceWorker?.controller?.state === 'activated'), {
    timeout: 15000,
    message: 'The receiving page must be controlled by an activated service worker'
  }).toBe(true);
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


/** Join using an invitation shared by a current member.
 * @param {Page} page @param {Page} owner @param {string} name */
export async function joinRoom(page, owner, name) {
  const row = owner.locator('#roomRows tr').filter({ hasText: name });
  const code = await row.locator('.peer-code').innerText();
  await page.locator('#roomCodeInput').fill(code);
  await page.locator('#joinRoomForm').getByRole('button', { name: 'Join' }).click();
  await expect(page.locator('#sessionTitle')).toHaveText(name);
}
