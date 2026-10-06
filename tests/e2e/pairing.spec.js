import { expect } from '@playwright/test';
import { test, deviceNames, openPeer, chat, pairDevices } from './helpers.js';
import { startServer } from '../unit/helpers.js';
import { PAIRING_CODE_MAX_AGE_MS } from '../../app/server/server.js';

test.describe('pairing restoration ordering', () => {
  test.use({ appPatch: { device: 'Both', patch: source => source
    .replace('for (const peer of msg.paired || []) {', `
      if (sessionStorage.getItem('delay-pair-restore')) await new Promise(resolve => { window.releasePairRestore = resolve; });
      for (const peer of msg.paired || []) {`)
    .replace('document.title = `${msg.self.name} · Evakage`;', `
      document.documentElement.dataset.pairRestoreDone = '1';
      document.title = \`\${msg.self.name} · Evakage\`;`)
    .replace("signal(peerId, { type: 'answer', sdp: pc.localDescription });", `
      signal(peerId, { type: 'answer', sdp: pc.localDescription });
      document.documentElement.dataset.answerSent = '1';`) } });

  test('an incoming reconnect survives delayed pairing restoration before the chat is opened', async ({ devices }) => {
    const { alice, bob, server } = devices;
    await openPeer(alice, 'Bob'); await openPeer(bob, 'Alice');
    const aliceId = await alice.locator('#selfCode').getAttribute('data-device-id') || '';
    const bobId = await bob.locator('#selfCode').getAttribute('data-device-id') || '';
    const reloadAlice = aliceId.localeCompare(bobId) > 0;
    const reloading = reloadAlice ? alice : bob;
    const survivor = reloadAlice ? bob : alice;
    await chat(reloading, survivor, 'Before delayed pairing restore');
    await reloading.evaluate(() => sessionStorage.setItem('delay-pair-restore', '1'));
    const recipient = server.clients.get(reloadAlice ? bobId : aliceId);
    if (!recipient) throw new Error('Surviving device is not registered');
    const send = recipient.ws.send.bind(recipient.ws);
    let droppedAnswer = false;
    recipient.ws.send = (/** @type {string | Buffer} */ payload) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'signal' && message.data.type === 'answer' && !droppedAnswer) {
        droppedAnswer = true;
        return;
      }
      send(payload);
    };
    await reloading.reload();
    await expect(reloading.locator('html')).toHaveAttribute('data-answer-sent', '1');
    await reloading.evaluate(() => {
      const testWindow = /** @type {Window & {releasePairRestore: () => void}} */ (/** @type {unknown} */ (window));
      testWindow.releasePairRestore();
    });
    await expect(reloading.locator('html')).toHaveAttribute('data-pair-restore-done', '1');
    await openPeer(reloading, reloadAlice ? 'Bob' : 'Alice');
    await chat(reloading, survivor, 'After delayed pairing restore');
    expect(droppedAnswer).toBe(true);
  });
});

test.describe('abandoned SDP negotiation', () => {
  test.use({ appPatch: { device: 'Both', patch: source => source
    .replace('for (const peer of msg.paired || []) {', `
      if (sessionStorage.getItem('stall-offer-on-reload')) await new Promise(resolve => { window.releasePairRestore = resolve; });
      for (const peer of msg.paired || []) {`)
    .replace('const offer = await transportTask(pc, pc.createOffer());', `
      const stall = sessionStorage.getItem('stall-offer-on-reload');
      if (stall) {
        sessionStorage.removeItem('stall-offer-on-reload');
        document.documentElement.dataset.offerStalled = '1';
      }
      const offer = await transportTask(pc, stall ? new Promise(() => {}) : pc.createOffer());`) } });

  test('closing a transport unblocks signaling even if its SDP promise never settles', async ({ devices }) => {
    const { alice, bob } = devices;
    await openPeer(alice, 'Bob'); await openPeer(bob, 'Alice');
    const aliceId = await alice.locator('#selfCode').getAttribute('data-device-id') || '';
    const bobId = await bob.locator('#selfCode').getAttribute('data-device-id') || '';
    const reloadAlice = aliceId.localeCompare(bobId) < 0;
    const reloading = reloadAlice ? alice : bob;
    const survivor = reloadAlice ? bob : alice;
    await reloading.evaluate(() => sessionStorage.setItem('stall-offer-on-reload', '1'));
    await reloading.reload();
    await expect(reloading.locator('html')).toHaveAttribute('data-offer-stalled', '1');
    await reloading.evaluate(() => {
      const testWindow = /** @type {Window & {releasePairRestore: () => void}} */ (/** @type {unknown} */ (window));
      testWindow.releasePairRestore();
    });
    await openPeer(reloading, reloadAlice ? 'Bob' : 'Alice');
    await chat(reloading, survivor, 'Recovered from abandoned SDP');
    await chat(survivor, reloading, 'Signaling queue is available');
  });
});

test.describe('slow identity handshake', () => {
  test.use({ appPatch: { device: 'Alice', patch: source => source
    .replace("const keyPair = await crypto.subtle.generateKey({ name: 'ECDH'", `
      document.documentElement.dataset.handshakeKeys = String(Number(document.documentElement.dataset.handshakeKeys || 0) + 1);
      await new Promise(resolve => setTimeout(resolve, 300));
      const keyPair = await crypto.subtle.generateKey({ name: 'ECDH'`)
    .replace('const remoteKey = await crypto.subtle.importKey(', `
      await new Promise(resolve => setTimeout(resolve, 350));
      const remoteKey = await crypto.subtle.importKey(`) } });
  test('a concurrent incoming hello uses one keypair and waits for verification before accepting its proof', async ({ devices }) => {
    const { alice, bob } = devices;
    await alice.evaluate(() => { document.documentElement.dataset.handshakeKeys = '0'; });
    await openPeer(alice, 'Bob'); await openPeer(bob, 'Alice');
    await chat(alice, bob, 'Ordered ownership proof');
    await chat(bob, alice, 'Ordered return proof');
    await expect(alice.locator('html')).toHaveAttribute('data-handshake-keys', '1');
  });
});

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
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await alice.locator('#devicesDialog').getByRole('button', { name: 'Close', exact: true }).click();
    await alice.reload();
    await expect(alice.locator('#selfCode')).not.toHaveText('----');
    await alice.getByRole('button', { name: `Open conversation with ${deviceNames.get('Bob')}`, exact: true }).click();
    await expect(alice.locator('#connectDialog')).toBeVisible();

  });

  test('a device QR link uses the same code pairing flow and removes the secret fragment', async ({ devices }) => {
    const { alice, bob } = devices;
    await alice.getByRole('button', { name: 'QR code', exact: true }).click();
    await alice.locator('#qrDialog summary').click();
    const invitation = await alice.locator('#qrDeviceCode').innerText();
    const params = new URLSearchParams(new URL(invitation).hash.slice(1));
    expect(params.get('pair')).toBe(await alice.locator('#selfCode').innerText());
    expect(params.get('device')).toBe(await alice.locator('#selfCode').getAttribute('data-device-id'));
    await alice.locator('#qrDialog').getByRole('button', { name: 'Close', exact: true }).click();
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
    await newcomer.locator('#addDeviceBtn').click();
    await newcomer.locator('#codeInput').fill(oldCode);
    await newcomer.locator('#codeForm').getByRole('button', { name: 'Join', exact: true }).click();
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
