import { expect } from '@playwright/test';
import { signInRoomOwner } from './helpers.js';
import { test, chat, deviceNames, openPeer, pairDevices, joinRoom } from './helpers.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @param {{alice: Page, bob: Page, disconnect: (name: string) => void}} devices
 * @param {import('@playwright/test').Browser} browser
 * @param {(recipient: Page) => Promise<void>} inspect */
async function recoverFromSurvivingPeer(devices, browser, inspect) {
  const { alice, bob } = devices;
  const room = 'Signed history room';
  await signInRoomOwner(alice);
  await alice.locator('#roomNameInput').fill(room);
  await alice.locator('#createRoomForm').getByRole('button', { name: 'Create' }).click();
  await alice.getByRole('button', { name: `Open room ${room}`, exact: true }).click();
  await joinRoom(bob, alice, room);
  await expect(alice.locator('#secureState')).toHaveText('1 of 1 links encrypted');
  await expect(bob.locator('#secureState')).toHaveText('1 of 1 links encrypted');
  await chat(alice, bob, 'Original message signed by Alice');
  await alice.context().setOffline(true);
  devices.disconnect('Alice');
  await expect(bob.locator('#sessionMembers')).toContainText('away');
  // This recipient did not exist when Alice sent. Alice is offline, so only
  // Bob can supply her message; no author link or server envelope can mask sync.
  const context = await browser.newContext();
  const recipient = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  recipient.on('pageerror', error => errors.push(error.message));

  try {
    await recipient.goto(new URL(alice.url()).origin);
    await expect(recipient.locator('#selfCode')).not.toHaveText('----');
    await pairDevices(recipient, alice, false);
    await pairDevices(recipient, bob, false);
    await joinRoom(recipient, bob, room);
    await expect(recipient.locator('#timeline').getByText('Original message signed by Alice', { exact: true })).toHaveCount(1);
    const original = recipient.locator('.message-item').filter({ hasText: 'Original message signed by Alice' });
    await expect(original.locator('.message-author')).toHaveText(deviceNames.get('Alice'));
    await expect(original.locator('.message-author')).not.toHaveClass(/unverified/);
    await inspect(recipient);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}

test('room history verifies an offline author through a different surviving peer', async ({ devices, browser }) => {
  await recoverFromSurvivingPeer(devices, browser, async recipient => {
    await expect(recipient.locator('#timeline .message-item')).toHaveCount(1);
  });
});

test.describe('a hostile room history relayer', () => {
  test.use({ appPatch: { device: 'Bob', patch: source => {
    const anchor = 'async function sendControl(link, obj) {\n';
    return source.replace(anchor, `${anchor}
  if (obj.type === 'sync-state' && obj.conv?.startsWith('room:')) {
    const original = obj.messages.find(m => m.text === 'Original message signed by Alice');
    if (original) {
      const unsigned = { ...original, id: 'unsigned-history', text: 'Unsigned fake', proof: undefined, verifiedAuthor: true };
      const changed = { ...original, id: 'tampered-history', text: 'Tampered fake' };
      const rewritten = { ...original, id: 'rewritten-history', text: 'Rewritten fake' };
      const inner = JSON.parse(original.proof.inner);
      inner.id = rewritten.id;
      inner.text = rewritten.text;
      rewritten.proof = { ...original.proof, inner: JSON.stringify(inner) };
      const impersonated = { ...original, id: 'impersonated-history', text: 'Impersonated fake' };
      inner.id = impersonated.id;
      inner.text = impersonated.text;
      const forgedInner = JSON.stringify(inner);
      impersonated.proof = { inner: forgedInner, identityKey: state.identity.identityKey,
        signature: await signTranscript(state.identity.privateKey, JSON.stringify(['evakage/message/1', forgedInner])) };
      const wrongRoom = await signMessage(state.identity, 'room:another-room', {
        id: 'wrong-room-history', text: 'Wrong room fake', from: state.self.id, fromName: state.self.name, at: Date.now()
      });
      const sentinel = await signMessage(state.identity, obj.conv, {
        id: original.id, text: 'Valid history after rejected entries', from: state.self.id, fromName: original.fromName, at: Date.now()
      });
      // An authentic Bob message using Alice’s ID must not shadow her history.
      // Replay genuine entries too: accepted author/ID pairs remain idempotent.
      obj.messages = [sentinel, original, unsigned, changed, rewritten, impersonated, wrongRoom, original];
    }
  }
`);
  } } });

  test('rejects unsigned, altered, impersonated and cross-room history without losing genuine entries', async ({ devices, browser }) => {
    await recoverFromSurvivingPeer(devices, browser, async recipient => {
      await expect(recipient.locator('#timeline')).toContainText('Valid history after rejected entries');
      await expect(recipient.locator('#timeline .message-item')).toHaveCount(2);
      const sentinel = recipient.locator('.message-item').filter({ hasText: 'Valid history after rejected entries' });
      await expect(sentinel.locator('.message-author')).toHaveText(deviceNames.get('Bob'));
      await expect(recipient.locator('#toastRegion')).toContainText('Ignored 5 history messages with invalid or missing author signatures.');
      for (const fake of ['Unsigned fake', 'Tampered fake', 'Rewritten fake', 'Impersonated fake', 'Wrong room fake']) {
        await expect(recipient.locator('#timeline').getByText(fake, { exact: true })).toHaveCount(0);
      }
    });
  });
});

test('signed history larger than one control frame survives reload with every proof intact', async ({ devices }) => {
  const { alice, bob } = devices;
  await openPeer(alice, 'Bob');
  await openPeer(bob, 'Alice');
  const texts = Array.from({ length: 18 }, (_, i) => `History ${i}: ` + 'x'.repeat(19970));
  for (const text of texts) {
    await alice.locator('#messageInput').fill(text);
    await alice.locator('#messageForm').getByRole('button', { name: 'Send', exact: true }).click();
  }
  await expect(bob.locator('#timeline .message-item')).toHaveCount(texts.length);
  await alice.reload();
  await expect(alice.locator('#selfCode')).not.toHaveText('----');
  await openPeer(alice, 'Bob');
  await expect(alice.locator('#timeline .message-item')).toHaveCount(texts.length);
  for (const text of texts) await expect(alice.locator('#timeline').getByText(text, { exact: true })).toHaveCount(1);
  await expect(alice.locator('#toastRegion')).not.toContainText('Ignored');
});

test.describe('legacy unsigned-chat protocol', () => {
  test.use({ autoPair: false, appPatch: { device: 'Bob', patch: source => source
    .replace('const PROTOCOL_VERSION = 3;', 'const PROTOCOL_VERSION = 2;')
    .replace('const MIN_PROTOCOL = 3;', 'const MIN_PROTOCOL = 2;') } });
  test('refuses the legacy peer before accepting a direct channel', async ({ devices }) => {
    const { alice, bob } = devices;
    await pairDevices(alice, bob, false);
    await expect(alice.locator('#toastRegion')).toContainText('this build speaks 3–3');
    await expect(alice.locator('#peerRows')).toContainText('Version mismatch');
    await expect(alice.locator('#secureState')).not.toContainText('Encrypted');
  });
});
