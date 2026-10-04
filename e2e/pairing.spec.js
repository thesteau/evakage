import { expect } from '@playwright/test';
import { test, deviceNames, openPeer, chat, pairDevices } from './helpers.js';
import { startServer } from '../tests/helpers.js';
import { PAIRING_CODE_MAX_AGE_MS } from '../server.js';

test.describe('mandatory code pairing', () => {
  test.use({ autoPair: false });

  test('unknown devices require the private code and established pairing survives reload', async ({ devices }) => {
    const { alice, bob } = devices;
    const code = await bob.locator('#selfCode').innerText();
    await expect(alice.locator('#peerRows')).not.toContainText(code);
    await alice.getByRole('button', { name: `Open conversation with ${deviceNames.get('Bob')}`, exact: true }).click();
    await expect(alice.locator('#connectDialog')).toBeVisible();
    await expect(alice.locator('#sessionPanel')).toBeHidden();
    await alice.locator('#connectCode').fill('WRONG-CODE');
    await alice.locator('#connectForm').getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(alice.locator('#connectFeedback')).toContainText('Code invalid or expired');
    await alice.locator('#connectCode').fill(code);
    await alice.locator('#connectForm').getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(alice.locator('#connectDialog')).toBeHidden();
    await openPeer(bob, 'Alice');
    await chat(alice, bob, 'Paired by private code');
    await alice.reload();
    await expect(alice.locator('#selfCode')).not.toHaveText('----');
    await openPeer(alice, 'Bob');
    await expect(alice.locator('#connectDialog')).toBeHidden();
    await chat(alice, bob, 'Still paired after reload');
    await alice.locator('#closeSession').click();
    await expect(alice.locator('#sessionPanel')).toBeHidden();
    await alice.getByRole('button', { name: 'Known devices', exact: true }).click();
    const row = alice.locator('#knownDeviceList > div').filter({ hasText: deviceNames.get('Bob') });
    await row.getByRole('button', { name: 'Forget', exact: true }).click();
    await alice.locator('#devicesDialog').getByRole('button', { name: 'Done', exact: true }).click();
    await alice.reload();
    await expect(alice.locator('#selfCode')).not.toHaveText('----');
    await alice.getByRole('button', { name: `Open conversation with ${deviceNames.get('Bob')}`, exact: true }).click();
    await expect(alice.locator('#connectDialog')).toBeVisible();

  });

  test('a device QR link uses the same code pairing flow and removes the secret fragment', async ({ devices }) => {
    const { alice, bob } = devices;
    await alice.getByRole('button', { name: 'QR codes', exact: true }).click();
    const invitation = await alice.locator('#qrDeviceCode').innerText();
    const params = new URLSearchParams(new URL(invitation).hash.slice(1));
    expect(params.get('pair')).toBe(await alice.locator('#selfCode').innerText());
    expect(params.get('device')).toBe(await alice.locator('#selfCode').getAttribute('data-device-id'));
    await alice.locator('#qrDialog').getByRole('button', { name: 'Done', exact: true }).click();
    await bob.goto(invitation);
    await expect(bob.locator('#codeFeedback')).toContainText('Paired with');
    expect(await bob.evaluate(() => location.hash)).toBe('');
    await openPeer(alice, 'Bob');
    await chat(bob, alice, 'Paired through QR');
  });
});

test.describe('unsolicited payload from an unpaired device', () => {
  test.use({ autoPair: false, appPatch: { device: 'Alice', patch: source => source.replace(
    'if (!notice?.blobId || !deviceAllowed(notice.from)) return;',
    "if (!notice?.blobId || !deviceAllowed(notice.from)) { document.documentElement.dataset.refusedUnknown = notice?.from || ''; return; }"
  ) } });

  test('is refused until an actual code pairing authorizes the sender', async ({ devices }) => {
    const { alice, bob } = devices;
    // Model a hostile sender bypassing its own UI. The receiving browser must
    // enforce its own pairing policy independently of the sender's policy.
    const id = await alice.locator('#selfCode').getAttribute('data-device-id');
    const senderId = await bob.locator('#selfCode').getAttribute('data-device-id');
    if (!id || !senderId) throw new Error('Registered device IDs are required');
    if (!id) throw new Error('Device registration did not provide a fingerprint.');
    await bob.evaluate(async ({ id, name }) => {
      const path = '/identity.js';
      const { pairDevice } = await import(path);
      pairDevice(id, name);
    }, { id, name: deviceNames.get('Alice') });
    await bob.getByRole('button', { name: `Open conversation with ${deviceNames.get('Alice')}`, exact: true }).click();
    await bob.locator('#forceRelayInput').check();
    await bob.locator('#messageInput').fill('Held until you pair this sender');
    await bob.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
    await expect(alice.locator('html')).toHaveAttribute('data-refused-unknown', senderId);
    await expect(alice.locator('#timeline')).not.toContainText('Held until you pair this sender');
    await alice.getByRole('button', { name: `Open conversation with ${deviceNames.get('Bob')}`, exact: true }).click();
    await alice.locator('#connectCode').fill(await bob.locator('#selfCode').innerText());
    await alice.locator('#connectForm').getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(alice.locator('#timeline').getByText('Held until you pair this sender', { exact: true })).toHaveCount(1);
  });
});

test('server rotation updates the owner, rejects the old code and preserves established pairing', async ({ browser }) => {
  let now = 1000;
  /** @type {(() => Promise<void>)[]} */
  const cleanup = [];
  const { base, app } = await startServer({ after: fn => cleanup.push(fn) }, { pairingNow: () => now });
  /** @type {import('@playwright/test').BrowserContext[]} */
  const contexts = [];
  /** @type {import('@playwright/test').Page[]} */
  const pages = [];
  try {
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(base);
      await expect(page.locator('#selfCode')).not.toHaveText('----');
      pages.push(page);
    }
    const [alice, bob, newcomer] = pages;
    await pairDevices(alice, bob);
    const oldCode = await bob.locator('#selfCode').innerText();
    now += PAIRING_CODE_MAX_AGE_MS;
    app.rotatePairingCodes();
    await expect(bob.locator('#selfCode')).not.toHaveText(oldCode);
    const newCode = await bob.locator('#selfCode').innerText();
    await expect(alice.locator('#peerRows')).not.toContainText(newCode);
    await newcomer.locator('#codeInput').fill(oldCode);
    await newcomer.locator('#codeForm').getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(newcomer.locator('#codeFeedback')).toContainText('invalid, expired');
    await pairDevices(newcomer, bob);
    const bobName = await bob.locator('#selfCode').getAttribute('data-device-name');
    const aliceName = await alice.locator('#selfCode').getAttribute('data-device-name');
    await alice.getByRole('button', { name: `Open conversation with ${bobName}`, exact: true }).click();
    await bob.getByRole('button', { name: `Open conversation with ${aliceName}`, exact: true }).click();
    await chat(alice, bob, 'Pairing survives code rotation');
    await expect(alice.locator('#connectDialog')).toBeHidden();
  } finally {
    for (const context of contexts) await context.close();
    for (const fn of cleanup) await fn();
  }
});
