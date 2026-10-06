import { test, expect, devices } from '@playwright/test';
import fs from 'node:fs/promises';
import { pairDevices, joinRoom } from './helpers.js';
import { performance } from 'node:perf_hooks';
import { signInRoomOwner } from './helpers.js';
import { startRoomServer as startServer } from '../unit/helpers.js';

import type { Page } from '@playwright/test';

type Counters = { created: number; closed: number; connected: number };

async function counters(pages: Page[]): Promise<Counters> {
  const values = await Promise.all(
    pages.map((page) =>
      page.evaluate(
        () =>
          Reflect.get(window, '__roomChurn') as {
            created: number;
            closed: number;
            connected: number;
          },
      ),
    ),
  );
  return values.reduce(
    (sum, value) => ({
      created: sum.created + value.created,
      closed: sum.closed + value.closed,
      connected: sum.connected + value.connected,
    }),
    { created: 0, closed: 0, connected: 0 },
  );
}

async function deliver(sender: Page, recipients: Page[], text: string) {
  const start = performance.now();
  await sender.locator('#messageInput').fill(text);
  await sender.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  await Promise.all(
    recipients.map((page) =>
      expect(page.locator('#timeline').getByText(text, { exact: true })).toHaveCount(1),
    ),
  );
  return Math.round(performance.now() - start);
}

async function measureChurn(
  browser: import('@playwright/test').Browser,
  info: import('@playwright/test').TestInfo,
  transferChurn: boolean,
) {
  test.setTimeout(120000);

  const cleanup: (() => Promise<void>)[] = [];
  const { base } = await startServer({ after: (fn) => cleanup.push(fn) });

  const contexts: import('@playwright/test').BrowserContext[] = [];

  const pages: Page[] = [];

  const errors: string[] = [];
  const samples: any[] = [];
  const turnUrl = process.env.ARIA_CHURN_TURN_URL || '';
  const mobile = process.env.ARIA_CHURN_MOBILE === '1';
  let uploadWaiting = false;

  let uploadGate: Promise<void> | null = null;
  let releaseUpload = () => {};
  try {
    for (let i = 0; i < 7; i++) {
      const context = await browser.newContext(mobile ? devices['Pixel 7'] : {});
      contexts.push(context);
      if (i === 0 && transferChurn) {
        await context.route('**/app.js', async (route) => {
          const response = await route.fetch();
          const source = (await response.text()).replace(/\r\n/g, '\n');
          const anchor =
            'async function sendFileChunk(link, conv, id, transferId, seq, total, bytes) {';
          if (!source.includes(anchor)) throw new Error('Transfer instrumentation anchor moved');
          await route.fulfill({
            response,
            body: source.replace(
              anchor,
              `${anchor}
  if (seq === 1 && Reflect.get(window, '__holdChunks')) {
    Reflect.set(window, '__chunkWaiting', true);
    await Reflect.get(window, '__holdChunks');
  }`,
            ),
          });
        });
        await context.route('**/blob/**', async (route) => {
          if (
            route.request().method() === 'PUT' &&
            Number(new URL(route.request().url()).searchParams.get('offset')) > 0 &&
            uploadGate
          ) {
            uploadWaiting = true;
            await uploadGate;
          }
          await route.continue();
        });
      }
      await context.addInitScript(
        ({ turnUrl, username, credential }) => {
          const metrics = { created: 0, closed: 0, connected: 0 };
          /* */
          const connections: RTCPeerConnection[] = [];
          Object.defineProperty(window, '__roomConnections', { value: connections });
          Object.defineProperty(window, '__roomChurn', { value: metrics });
          const Original = RTCPeerConnection;
          window.RTCPeerConnection = new Proxy(Original, {
            construct(target, args) {
              if (turnUrl) {
                args[0] = {
                  ...args[0],
                  iceTransportPolicy: 'relay',
                  iceServers: [{ urls: turnUrl, username, credential }],
                };
              }
              const pc = new target(...args);
              connections.push(pc);
              metrics.created++;
              const close = pc.close.bind(pc);
              let countedClose = false;
              let countedConnected = false;
              pc.close = () => {
                if (!countedClose) {
                  metrics.closed++;
                  countedClose = true;
                }
                close();
              };
              pc.addEventListener('connectionstatechange', () => {
                if (pc.connectionState === 'connected' && !countedConnected) {
                  metrics.connected++;
                  countedConnected = true;
                }
              });
              return pc;
            },
          });
        },
        {
          turnUrl,
          username: process.env.ARIA_CHURN_TURN_USER || '',
          credential: process.env.ARIA_CHURN_TURN_PASSWORD || '',
        },
      );
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base);
      await expect(page.locator('#selfCode')).not.toHaveText('----');
      pages.push(page);
    }
    for (let i = 1; i < pages.length; i++) {
      for (let j = 0; j < i; j++) await pairDevices(pages[i], pages[j]);
    }
    const [owner] = pages;
    const incumbents = pages.slice(0, 6);
    const seventh = pages[6];
    const roomName = 'Boundary measurement';
    await signInRoomOwner(owner);
    await owner.locator('#roomNameInput').fill(roomName);
    await owner.locator('#createRoomForm').getByRole('button', { name: 'Create' }).click();
    for (const page of incumbents) {
      if (page === owner)
        {await page.getByRole('button', { name: `Open room ${roomName}`, exact: true }).click();}
      else await joinRoom(page, owner, roomName);
      await expect(page.locator('#sessionTitle')).toHaveText(roomName);
    }
    const meshReady = async () => {
      await Promise.all(
        incumbents.map((page) =>
          expect(page.locator('#secureState')).toHaveText('5 of 5 links encrypted'),
        ),
      );
    };
    await meshReady();
    const baseline = await counters(pages);
    const selectedCandidates = async () =>
      Promise.all(
        incumbents.map((page) =>
          page.evaluate(async () => {
            const selected: { local: string; remote: string }[] = [];
            const connections = Reflect.get(window, '__roomConnections') as RTCPeerConnection[];
            for (const pc of connections) {
              if (pc.connectionState !== 'connected') continue;
              const stats = await pc.getStats();
              for (const item of stats.values()) {
                if (item.type !== 'transport' || !item.selectedCandidatePairId) continue;
                const pair = stats.get(item.selectedCandidatePairId);
                selected.push({
                  local: stats.get(pair.localCandidateId)?.candidateType,
                  remote: stats.get(pair.remoteCandidateId)?.candidateType,
                });
              }
            }
            return selected;
          }),
        ),
      );
    const baselineCandidates = (await selectedCandidates()).flat();
    if (turnUrl) {
      expect(baselineCandidates).toHaveLength(30);
      for (const candidate of baselineCandidates)
        {expect(candidate).toEqual({ local: 'relay', remote: 'relay' });}
    }
    const baselineDeliveryMs = await deliver(owner, incumbents, 'Baseline six seats');
    for (let cycle = 1; cycle <= 3; cycle++) {
      for (const phase of ['relay', 'mesh']) {
        const before = await counters(pages);
        const fileName = `boundary-${cycle}-${phase}.bin`;
        const fileBytes = Buffer.alloc(512 * 1024, cycle + (phase === 'relay' ? 10 : 20));
        if (transferChurn) {
          if (phase === 'relay') {
            await owner.evaluate(() => {
              Reflect.set(window, '__chunkWaiting', false);
              Reflect.set(
                window,
                '__holdChunks',
                new Promise((resolve) => Reflect.set(window, '__releaseChunks', resolve)),
              );
            });
          } else {
            uploadWaiting = false;
            uploadGate = new Promise((resolve) => {
              releaseUpload = resolve;
            });
          }
          await owner
            .locator('#fileInput')
            .setInputFiles({
              name: fileName,
              mimeType: 'application/octet-stream',
              buffer: fileBytes,
            });
          if (phase === 'relay') {
            await expect
              .poll(() => owner.evaluate(() => Reflect.get(window, '__chunkWaiting')))
              .toBe(true);
            const receiving = incumbents[1].locator('.file-item').filter({ hasText: fileName });
            await expect
              .poll(() => receiving.locator('progress').getAttribute('value').then(Number))
              .toBeGreaterThan(0);
            await expect(receiving.getByRole('button', { name: 'Save', exact: true })).toHaveCount(
              0,
            );
          } else await expect.poll(() => uploadWaiting).toBe(true);
        }
        const start = performance.now();
        if (phase === 'relay') {
          await joinRoom(seventh, owner, roomName);
          await Promise.all(
            pages.map((page) => expect(page.locator('#secureState')).toContainText('Large room')),
          );
        } else {
          await seventh.locator('#leaveRoomBtn').click();
          // Send once the new transport is visible, without waiting for ICE or identity handshakes.
          await Promise.all(
            incumbents.map((page) =>
              expect(page.locator('#secureState')).toContainText('of 5 links encrypted'),
            ),
          );
        }
        const transportVisibleMs = Math.round(performance.now() - start);
        if (transferChurn) {
          if (phase === 'relay') {
            await owner.evaluate(() => {
              Reflect.get(window, '__releaseChunks')();
              Reflect.set(window, '__holdChunks', null);
            });
          } else {
            releaseUpload();
            uploadGate = null;
          }
        }
        const recipients = phase === 'relay' ? pages : incumbents;
        const ready = (phase === 'mesh' ? meshReady() : Promise.resolve()).then(() =>
          Math.round(performance.now() - start),
        );
        const text = `Cycle ${cycle} ${phase} owner`;
        const deliveryMs = await deliver(owner, recipients, text);
        const readyMs = await ready;
        const receiptPaths = await Promise.all(
          recipients.slice(1).map(async (page) => {
            const time = await page
              .locator('.message-item')
              .filter({
                has: page.getByText(text, { exact: true }),
              })
              .locator('.message-time')
              .innerText();
            return time.includes('via server') ? 'relay' : 'direct';
          }),
        );
        const reverseDeliveryMs = await deliver(
          pages[1],
          recipients,
          `Cycle ${cycle} ${phase} reverse`,
        );
        let transferCompleteMs: any = null;
        if (transferChurn) {
          for (const page of incumbents.slice(1)) {
            const row = page.locator('.file-item').filter({ hasText: fileName });
            await expect(row).toHaveCount(1);
            await expect(row).toContainText('SHA-256 ✓');
            await expect(row.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
          }
          transferCompleteMs = Math.round(performance.now() - start);
          const row = incumbents[1].locator('.file-item').filter({ hasText: fileName });
          const downloading = incumbents[1].waitForEvent('download');
          await row.getByRole('button', { name: 'Save', exact: true }).click();
          expect(await fs.readFile(await (await downloading).path())).toEqual(fileBytes);
        }
        const after = await counters(pages);
        samples.push({
          cycle,
          phase,
          transportVisibleMs,
          deliveryMs,
          reverseDeliveryMs,
          readyMs,
          created: after.created - before.created,
          closed: after.closed - before.closed,
          connected: after.connected - before.connected,
          receiptPaths,
          transferCompleteMs,
        });
      }
    }
    expect(errors).toEqual([]);
    const finalCounters = await counters(pages);
    expect(finalCounters.created - finalCounters.closed).toBe(baseline.created - baseline.closed);
    const finalCandidates = (await selectedCandidates()).flat();
    if (turnUrl) {
      expect(finalCandidates).toHaveLength(30);
      for (const candidate of finalCandidates)
        {expect(candidate).toEqual({ local: 'relay', remote: 'relay' });}
    }
    const report = {
      environment: `Chromium, seven isolated contexts, ${mobile ? 'Pixel 7 emulation (not a physical phone)' : 'desktop'}, ${turnUrl ? 'forced TURN (selected pairs verified)' : 'loopback without TURN'}, no network shaping`,
      timing:
        'Wall time includes Playwright actions, rendering and assertion polling; readyMs starts before membership action and waits for encrypted-link UI. Delivery is measured to the last recipient UI.',
      baseline,
      baselineCandidates,
      finalCandidates,
      baselineDeliveryMs,
      samples,
      errors,
      transferChurn,
      transferBytesPerPhase: transferChurn ? 512 * 1024 : null,
      verifiedDeliveries: 3 * 2 * (7 + 6),
      expectedMessagesPerIncumbent: 13,
    };
    // Every incumbent must retain exactly one copy of all thirteen messages.
    for (const page of incumbents)
      {await expect(page.locator('#timeline .message-item')).toHaveCount(13);}
    const reportPath = info.outputPath('room-churn.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    await info.attach('room-churn', { path: reportPath, contentType: 'application/json' });
    console.log(JSON.stringify(report));
  } finally {
    for (const context of contexts) await context.close();
    for (const fn of cleanup) await fn();
  }
}

test('measure room churn across repeated six/seven-seat transitions', async ({ browser }, info) => {
  await measureChurn(browser, info, false);
});

test('measure room file transfers across repeated six/seven-seat transitions', async ({
  browser,
}, info) => {
  await measureChurn(browser, info, true);
});
