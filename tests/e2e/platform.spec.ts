import { test as baseTest, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { pairDevices, whenControlled } from './helpers.js';
import { startServer } from '../unit/helpers.js';

import type { Page } from '@playwright/test';

type Peers = { alice: Page; bob: Page; errors: string[] };

type Fixtures = { platformServer: Awaited<ReturnType<typeof startServer>>; peers: Peers };

// Fixture teardown runs separately from test actions, preserving the original
// assertion or navigation error when a test fails before cleanup.
const test = baseTest.extend({
  platformServer: async ({}, use) => {
    const cleanup = [] as (() => Promise<void>)[];
    const server = await startServer({ after: (fn) => cleanup.push(fn) });
    try {
      await use(server);
    } finally {
      for (const fn of cleanup) await fn();
    }
  },
  peers: async (
    { browser, platformServer, serviceWorkers, actionTimeout, navigationTimeout },
    use,
  ) => {
    // Keep the server alive until both contexts have closed.
    void platformServer;
    const contexts: any[] = [];
    const pages: any[] = [];
    const errors = [] as string[];
    try {
      for (const name of ['Alice', 'Bob']) {
        const context = await browser.newContext({ serviceWorkers });
        contexts.push(context);
        context.setDefaultTimeout(actionTimeout);
        context.setDefaultNavigationTimeout(navigationTimeout);
        await context.addInitScript(() => {
          localStorage.setItem('evakage-force-relay', '1');
          localStorage.setItem('evakage-incoming', 'auto');
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
        pages.push(page);
      }
      await use({ alice: pages[0], bob: pages[1], errors });
    } finally {
      const results = await Promise.allSettled(contexts.map((context) => context.close()));
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length)
        {throw new AggregateError(
          failures.map((result) => result.reason),
          'Platform browser cleanup failed',
        );}
    }
  },
} as import('@playwright/test').Fixtures<
  Fixtures,
  {},
  import('@playwright/test').PlaywrightTestArgs & import('@playwright/test').PlaywrightTestOptions,
  import('@playwright/test').PlaywrightWorkerArgs
>);

for (const twoPass of [false, true]) {
  test.describe(twoPass ? 'streamed receive' : 'in-memory receive', () => {
    // Fix the receive path regardless of how fast the worker installs.
    test.use({ serviceWorkers: twoPass ? 'allow' : 'block' });

    test(
      twoPass
        ? 'engine smoke: two-pass relay receive with a streamed save'
        : 'engine smoke: identity, relay chat and verified file download',
      async ({ platformServer, peers }, info) => {
        const { alice, bob, errors } = peers;
        for (const [name, page] of [
          ['Alice', alice],
          ['Bob', bob],
        ] as [string, Page][]) {
          await test.step(`${name}: open the app and register its identity`, async () => {
            const response = await page.goto(platformServer.base, {
              waitUntil: 'domcontentloaded',
            });
            expect(response?.ok(), `${name}: app document should load successfully`).toBe(true);
            await expect(page.locator('#selfCode')).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
            await expect(page.locator('#selfCode')).toHaveAttribute(
              'data-device-id',
              /^[A-Za-z0-9_-]{43}$/,
            );
            await expect(page.locator('#serverState')).toHaveClass(/\bonline\b/);
          });
        }

        await test.step('Confirm the receiver uses the intended download path', async () => {
          if (twoPass) await whenControlled(bob);
          else
            {expect(await bob.evaluate(() => Boolean(navigator.serviceWorker?.controller))).toBe(
              false,
            );}
        });

        await test.step('Pair the devices and open their conversation', async () => {
          await pairDevices(alice, bob);
          for (const [page, other] of [
            [alice, bob],
            [bob, alice],
          ]) {
            const name = await other.locator('#selfCode').getAttribute('data-device-name');
            await page
              .getByRole('button', { name: `Open conversation with ${name}`, exact: true })
              .click();
            await expect(page.locator('#sessionPanel')).toBeVisible();
          }
        });

        await test.step('Deliver a chat message through the relay', async () => {
          await alice.locator('#messageInput').fill('Across browser engines');
          await alice
            .locator('#messageForm')
            .getByRole('button', { name: 'Send', exact: true })
            .click();
          await expect(bob.locator('#timeline')).toContainText('Across browser engines');
        });

        await test.step('Verify and download the relayed file', async () => {
          const bytes = Buffer.alloc(200000, 37);
          await alice
            .locator('#fileInput')
            .setInputFiles({
              name: 'engine.bin',
              mimeType: 'application/octet-stream',
              buffer: bytes,
            });
          const row = bob.locator('.file-item').filter({ hasText: 'engine.bin' });
          await expect(row).toContainText('SHA-256 ✓');
          const [download] = await Promise.all([
            bob.waitForEvent('download', { timeout: 15000 }),
            row.getByRole('button', { name: 'Save', exact: true }).click(),
          ]);
          expect(await download.failure()).toBeNull();
          expect(download.suggestedFilename()).toBe('engine.bin');
          expect(await fs.readFile(await download.path())).toEqual(bytes);
          if (twoPass) expect(download.url()).toContain('/save-stream/');
          else expect(download.url()).toMatch(/^blob:/);
          info.annotations.push({
            type: 'save',
            description: download.url().replace(/[0-9a-f-]{36}$/, '<id>'),
          });
        });
        expect(errors).toEqual([]);
      },
    );
  });
}
