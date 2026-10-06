import { test as base, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { startRoomServer as startServer } from '../unit/helpers.js';

export const deviceNames = new Map();

import type { Page } from '@playwright/test';

/**
 * The app.js text a patch edits. Each replace() must match its anchor exactly
 * once, so a refactor that moves an anchor fails the test at once by name,
 * instead of silently skipping the edit and testing something else.
 */
export class PatchSource {
  constructor(readonly text: string) {}

  replace(from: string | RegExp, to: string) {
    const count =
      typeof from === 'string'
        ? this.text.split(from).length - 1
        : (this.text.match(new RegExp(from.source, from.flags.replace('g', '') + 'g')) || []).length;
    if (count !== 1) {
      throw new Error(
        `appPatch anchor ${count ? `matched ${count} times` : 'not found'} in app.js: ${String(from).slice(0, 120)}`,
      );
    }
    // A replacer function keeps `$` in the replacement literal.
    return new PatchSource(this.text.replace(from, () => to));
  }
}

type AppPatch = { device: string; patch: (source: PatchSource) => PatchSource } | null;

// Patch before any browser starts, so a moved anchor fails in milliseconds
// with its name rather than as a 15-second page-load timeout.
async function patchedAppScript(url: string, appPatch: NonNullable<AppPatch>) {
  const response = await fetch(new URL('/app.js', url));
  if (!response.ok) throw new Error(`Could not fetch app.js to patch: ${response.status}`);
  // Normalise line endings: patches anchor on multi-line snippets and a
  // Windows checkout with autocrlf serves CRLF.
  const source = (await response.text()).replace(/\r\n/g, '\n');
  return appPatch.patch(new PatchSource(source)).text;
}

export const test = base.extend({
  // Serves one device a rewritten app.js, so a test can play a peer that
  // misbehaves in a way the honest client never would. Set with
  // test.use({ appPatch: { device: 'Bob', patch: source => ... } }).
  appPatch: [null, { option: true }],
  autoPair: [true, { option: true }],

  devices: async ({ browser, appPatch, autoPair }, use) => {
    const cleanup: (() => Promise<void>)[] = [];
    deviceNames.clear();
    const { base: url, app } = await startServer({
      after: (fn: () => Promise<void>) => cleanup.push(fn),
    });
    const contexts: any[] = [];

    const pageErrors: string[] = [];
    try {
      const patched = appPatch ? await patchedAppScript(url, appPatch) : null;
      const pages: any[] = [];
      for (const name of ['Alice', 'Bob']) {
        const context = await browser.newContext();
        contexts.push(context);
        if (patched !== null && (appPatch?.device === name || appPatch?.device === 'Both')) {
          await context.route('**/app.js', async (route) => {
            await route.fulfill({
              status: 200,
              headers: {
                'content-type': 'text/javascript; charset=utf-8',
                'cache-control': 'no-store',
              },
              body: patched,
            });
          });
        }
        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(error.message));
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
      await use({
        alice: pages[0],
        bob: pages[1],
        server: app,
        disconnect: (name) => {
          for (const client of app.clients.values())
            {if (client.name === deviceNames.get(name)) client.ws.close();}
        },
      });
      expect(pageErrors).toEqual([]);
    } finally {
      for (const context of contexts) await context.close();
      for (const fn of cleanup) await fn();
    }
  },
} as import('@playwright/test').Fixtures<
  {
    devices: {
      alice: Page;
      bob: Page;
      disconnect: (name: string) => void;
      server: ReturnType<typeof import('../../app/server/server.js').createEvakageServer>;
    };
    appPatch: AppPatch;
    autoPair: boolean;
  },
  {},
  import('@playwright/test').PlaywrightTestArgs,
  import('@playwright/test').PlaywrightWorkerArgs
>);

/** Pair through the real owner-only code flow; never seed approval storage. */
export async function pairDevices(first: Page, second: Page, closeConversations: boolean = true) {
  if (!(await first.locator('#addDeviceDialog').isVisible()))
    {await first.locator('#addDeviceBtn').click();}
  await first.locator('#codeInput').fill(await second.locator('#selfCode').innerText());
  await first.locator('#codeForm').getByRole('button', { name: 'Join', exact: true }).click();
  await expect(first.locator('#codeFeedback')).toContainText('Paired with');
  await expect(first.locator('#sessionPanel')).toBeVisible();
  const id = await first.locator('#selfCode').getAttribute('data-device-id');
  if (await second.evaluate(() => navigator.onLine)) {
    await expect
      .poll(() =>
        second.evaluate(async (other) => {
          const modulePath = '/identity.js';
          const { deviceTrust } = await import(modulePath);
          return Boolean(deviceTrust(other)?.pairedAt);
        }, id),
      )
      .toBe(true);
  }
  await first.locator('#closeSession').click();
  await expect(first.locator('#sessionPanel')).toBeHidden();
  // Pairing opens a temporary direct conversation; close it so room-only tests
  // measure room links rather than direct conversations that also hold links.
  if (!closeConversations) return;
  for (const [page, peer] of [
    [first, second],
    [second, first],
  ]) {
    if (await page.locator('#sessionPanel').isVisible()) continue;
    const name = await peer.locator('#selfCode').getAttribute('data-device-name');
    const exit = page.getByRole('button', {
      name: `Delete conversation with ${name}`,
      exact: true,
    });
    if (await exit.count()) await exit.click();
  }
}

/** The device table shows names without the "Device " prefix. */
export function listedName(name: string) {
  return name.replace(/^Device /, '');
}

export async function openPeer(page: Page, name: string) {
  name = deviceNames.get(name) || name;
  await page
    .locator('#peerRows tr')
    .filter({ hasText: listedName(name) })
    .getByRole('button', { name: `Open conversation with ${name}`, exact: true })
    .click();
  await expect(page.locator('#secureState')).toContainText('Encrypted');
}

/** Sign in only the room creator; guests remain anonymous. */
export async function signInRoomOwner(page: Page) {
  if (await page.locator('#sessionPanel.open').count()) await page.locator('#closeSession').click();
  await page.locator('#accountBtn').click();
  if (await page.locator('#accountForm').isVisible()) {
    await page
      .locator('#accountUsername')
      .fill(`room_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`);
    await page.locator('#accountPassword').fill('test room account password');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
  }
  await expect(page.locator('#accountStatus')).toContainText('Signed in as');
  await page.locator('#accountDialog').getByRole('button', { name: 'Close', exact: true }).click();
}

/** Waits until the service worker controls the page, so relayed files are
 * received in two passes with a streamed Save. */
export async function whenControlled(page: Page) {
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker?.controller?.state === 'activated'), {
      timeout: 15000,
      message: 'The receiving page must be controlled by an activated service worker',
    })
    .toBe(true);
}

export async function chat(sender: Page, receiver: Page, text: string) {
  await sender.locator('#messageInput').fill(text);
  await sender.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(receiver.locator('#timeline').getByText(text, { exact: true })).toHaveCount(1);
}

export async function sendFile(
  sender: Page,
  receiver: Page,
  name: string,
  buffer: Buffer,
  accept = true,
) {
  await sender
    .locator('#fileInput')
    .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await receiver
    .getByRole('button', { name: `${accept ? 'Accept' : 'Decline'} ${name}`, exact: true })
    .click();
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

/** Join using an invitation shared by a current member. */
export async function joinRoom(page: Page, owner: Page, name: string) {
  const row = owner.locator('#roomRows tr').filter({ hasText: name });
  const code = await row.locator('.peer-code').innerText();
  await page.locator('#roomCodeInput').fill(code);
  await page.locator('#joinRoomForm').getByRole('button', { name: 'Join' }).click();
  await expect(page.locator('#sessionTitle')).toHaveText(name);
}
