import { expect, type Page } from '@playwright/test';
import { test, deviceNames, signInRoomOwner, roomCode } from './helpers.js';

// Hold real outgoing requests so pending UI can be inspected before an acknowledgement.
async function holdRequests(page: Page, types: string[]) {
  await page.evaluate((heldTypes) => {
    const send = WebSocket.prototype.send;
    const held: (() => void)[] = [];
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string' && heldTypes.includes(JSON.parse(data).type)) {
        held.push(() => send.call(this, data));
        return;
      }
      send.call(this, data);
    };
    (window as Window & { releaseFeedbackRequests?: () => void }).releaseFeedbackRequests = () => {
      WebSocket.prototype.send = send;
      for (const request of held) request();
    };
  }, types);
}

async function releaseRequests(page: Page) {
  await page.evaluate(() =>
    (window as Window & { releaseFeedbackRequests?: () => void }).releaseFeedbackRequests?.(),
  );
}

test('refresh shows progress, waits for both lists, and reports disconnection', async ({ devices }) => {
  const { alice } = devices;
  await holdRequests(alice, ['presence-request', 'rooms-request']);
  await alice.locator('#refreshBtn').click();
  await expect(alice.locator('#refreshBtn')).toBeDisabled();
  await expect(alice.locator('#refreshBtn')).toHaveAttribute('aria-busy', 'true');
  await expect(alice.locator('#toastRegion')).toContainText('Refreshing devices and rooms');
  await expect(alice.locator('#toastRegion')).not.toContainText('Devices and rooms refreshed');
  await releaseRequests(alice);
  await expect(alice.locator('#refreshBtn')).toBeEnabled();
  await expect(alice.locator('#toastRegion')).toContainText('Devices and rooms refreshed');

  await holdRequests(alice, ['presence-request', 'rooms-request']);
  await alice.locator('#refreshBtn').click();
  await alice.context().setOffline(true);
  devices.disconnect('Alice');
  await expect(alice.locator('#refreshBtn')).toBeEnabled();
  await expect(alice.locator('#toastRegion')).toContainText('Connection lost');
  await alice.locator('#refreshBtn').click();
  await expect(alice.locator('#toastRegion')).toContainText('Reconnect to the server');
  await alice.context().setOffline(false);
});

test('an unanswered refresh times out, restores its control, and can be retried', async ({ devices }) => {
  const { alice } = devices;
  await alice.clock.install();
  await holdRequests(alice, ['presence-request', 'rooms-request']);
  await alice.locator('#refreshBtn').click();
  await expect(alice.locator('#refreshBtn')).toBeDisabled();
  await alice.clock.runFor(10001);
  await expect(alice.locator('#refreshBtn')).toBeEnabled();
  await expect(alice.locator('#toastRegion')).toContainText('The server did not answer in time');
  await expect(alice.locator('#toastRegion')).not.toContainText('Refreshing devices and rooms');
  await releaseRequests(alice);
  await alice.locator('#refreshBtn').click();
  await expect(alice.locator('#toastRegion')).toContainText('Devices and rooms refreshed');
});

test('room creation and access changes show pending and confirmed results', async ({ devices }) => {
  const { alice } = devices;
  await signInRoomOwner(alice);
  await holdRequests(alice, ['create-room']);
  await alice.locator('#roomNameInput').fill('Feedback room');
  await alice.locator('#createRoomForm button').click();
  await expect(alice.locator('#roomFeedback')).toHaveText('Creating room…');
  await expect(alice.locator('#createRoomForm button')).toBeDisabled();
  await alice.locator('#createRoomForm').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await releaseRequests(alice);
  const room = alice.locator('#roomRows tr').filter({ hasText: 'Feedback room' });
  await expect(room).toHaveCount(1);
  await expect(alice.locator('#createRoomForm button')).toBeEnabled();
  await expect(alice.locator('#roomFeedback')).toHaveText('Created Feedback room.');

  await holdRequests(alice, ['room-access']);
  await room.getByRole('button', { name: 'Settings for room Feedback room' }).click();
  await alice.getByRole('menuitemradio', { name: 'Public · listed for everyone' }).click();
  await expect(alice.locator('#roomFeedback')).toHaveText('Saving room access…');
  await expect(room.getByRole('button', { name: 'Settings for room Feedback room' })).toBeDisabled();
  await expect(room).not.toContainText('public');
  await releaseRequests(alice);
  await expect(room).toContainText('public');
  await expect(alice.locator('#toastRegion')).toContainText('Feedback room is now public');

  await room.getByRole('button', { name: 'Delete local room Feedback room' }).click();
  await alice.locator('#deleteCancel').click();
  await expect(room).toContainText('Waiting for members');
  await holdRequests(alice, ['leave-room']);
  await room.getByRole('button', { name: 'Delete local room Feedback room' }).click();
  await alice.locator('#deleteConfirm').click();
  await expect(alice.locator('#roomFeedback')).toHaveText('Leaving room…');
  await expect(room.getByRole('button', { name: 'Delete local room Feedback room' })).toBeDisabled();
  await releaseRequests(alice);
  await expect(alice.locator('#toastRegion')).toContainText('Left Feedback room and deleted its local history');
});

test('code copying reports clipboard rejection and success accurately', async ({ devices }) => {
  const { alice } = devices;
  await alice.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } },
    });
  });
  await alice.locator('#selfCode').click();
  await expect(alice.locator('#toastRegion')).toContainText('Could not copy the code');
  await expect(alice.locator('#toastRegion')).not.toContainText('Your connection code copied');
  await alice.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => {
        (window as Window & { copiedFeedbackCode?: string }).copiedFeedbackCode = value;
      } },
    });
  });
  await alice.locator('#selfCode').click();
  await expect(alice.locator('#toastRegion')).toContainText('Your connection code copied');
  expect(await alice.evaluate(() =>
    (window as Window & { copiedFeedbackCode?: string }).copiedFeedbackCode,
  )).toBe(await alice.locator('#selfCode').innerText());
});

test('room approval and decline show pending feedback and the confirmed outcome', async ({ devices }) => {
  const { alice, bob } = devices;
  await signInRoomOwner(alice, 'private');
  await alice.locator('#roomNameInput').fill('Private feedback room');
  await alice.locator('#createRoomForm button').click();
  await expect(alice.locator('#roomRows')).toContainText('Private feedback room');
  const code = await roomCode(alice, 'Private feedback room');
  const name = deviceNames.get('Bob')!;
  await alice.getByRole('button', { name: 'Open room Private feedback room', exact: true }).click();
  await bob.locator('#roomCodeInput').fill(code);
  await bob.locator('#joinRoomForm button[type="submit"]').click();
  await expect(alice.locator('#joinRequests')).toContainText(`${name} wants to join`);
  await holdRequests(alice, ['room-approve']);
  await alice.getByRole('button', { name: `Decline ${name}`, exact: true }).click();
  await expect(alice.locator('#sessionFeedback')).toHaveText(`Declining ${name}…`);
  await expect(alice.getByRole('button', { name: `Approve ${name}`, exact: true })).toBeDisabled();
  await releaseRequests(alice);
  await expect(alice.locator('#sessionFeedback')).toHaveText(`Declined ${name}’s join request.`);
  await expect(bob.locator('#roomFeedback')).toContainText('declined your request');

  await bob.locator('#roomCodeInput').fill(code);
  await bob.locator('#joinRoomForm button[type="submit"]').click();
  await expect(alice.locator('#joinRequests')).toContainText(`${name} wants to join`);
  await holdRequests(alice, ['room-approve']);
  await alice.getByRole('button', { name: `Approve ${name}`, exact: true }).click();
  await expect(alice.locator('#sessionFeedback')).toHaveText(`Approving ${name}…`);
  await releaseRequests(alice);
  await expect(alice.locator('#sessionFeedback')).toHaveText(`Approved ${name}’s join request.`);
  await expect(bob.locator('#sessionTitle')).toHaveText('Private feedback room');
});

test('attaching a file shows preparation while the secure connection is pending', async ({ devices }) => {
  const { alice, bob } = devices;
  test.skip(!(await alice.evaluate(() => typeof RTCPeerConnection !== 'undefined')),
    'This engine does not expose direct peer connections.');
  for (const page of [alice, bob]) {
    await page.evaluate(() => {
      const original = RTCPeerConnection.prototype.setRemoteDescription;
      const describe = original as (this: RTCPeerConnection, description: RTCSessionDescriptionInit) => Promise<void>;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      RTCPeerConnection.prototype.setRemoteDescription = async function (description: RTCSessionDescriptionInit) {
        await waiting;
        return describe.call(this, description);
      };
      (window as Window & { releaseFeedbackConnection?: () => void }).releaseFeedbackConnection = () => {
        RTCPeerConnection.prototype.setRemoteDescription = original;
        release();
      };
    });
  }
  await alice.getByRole('button', { name: `Open conversation with ${deviceNames.get('Bob')}`, exact: true }).click();
  await alice.locator('#fileInput').setInputFiles({
    name: 'feedback.txt', mimeType: 'text/plain', buffer: Buffer.from('file feedback'),
  });
  await expect(alice.locator('#sessionFeedback')).toContainText('Preparing file · connecting to recipients');
  await expect(alice.locator('#pickFileBtn')).toBeDisabled();
  for (const page of [alice, bob]) {
    await page.evaluate(() =>
      (window as Window & { releaseFeedbackConnection?: () => void }).releaseFeedbackConnection?.(),
    );
  }
  await expect(alice.locator('#pickFileBtn')).toBeEnabled();
  await expect(alice.locator('#timeline')).toContainText('feedback.txt');
  await bob.getByRole('button', { name: `Open conversation with ${deviceNames.get('Alice')}`, exact: true }).click();
  await bob.getByRole('button', { name: 'Accept feedback.txt', exact: true }).click();
  await expect(bob.locator('#toastRegion')).toContainText('Received feedback.txt');
});

test('settings show saving, sync failures, and a successful retry in Settings', async ({ devices }) => {
  const { alice } = devices;
  await signInRoomOwner(alice);
  await expect(alice.locator('#settingsFeedback')).toHaveText('Settings saved to your account.');
  // Gate fetch directly: WebKit can bypass Playwright routes once the service worker controls the page.
  await alice.evaluate(() => {
    const original = window.fetch;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    window.fetch = async function (input, init) {
      if (typeof input === 'string' && input === '/account/preferences') {
        await waiting;
        return new Response('{"error":"Unavailable"}', {
          status: 503, headers: { 'content-type': 'application/json' },
        });
      }
      return original.call(this, input, init);
    };
    (window as Window & { releaseFeedbackPreferences?: () => void }).releaseFeedbackPreferences = () => {
      window.fetch = original;
      release();
    };
  });
  await alice.locator('#settingsBtn').click();
  await alice.locator('input[name="incomingPolicy"][value="auto"]').check();
  await expect(alice.locator('#settingsFeedback')).toHaveText('Saving settings to your account…');
  await alice.evaluate(() =>
    (window as Window & { releaseFeedbackPreferences?: () => void }).releaseFeedbackPreferences?.(),
  );
  await expect(alice.locator('#settingsFeedback')).toContainText('could not be saved to your account');
  await expect(alice.locator('#settingsFeedback')).toBeVisible();
  await expect(alice.locator('#accountDialog')).not.toBeVisible();
  await alice.locator('input[name="incomingPolicy"][value="new"]').check();
  await expect(alice.locator('#settingsFeedback')).toHaveText('Settings saved to your account.');
  await expect(alice.locator('#settingsFeedback')).not.toHaveClass(/danger/);
});

test.describe('device-specific pairing feedback', () => {
  test.use({ autoPair: false });
  test('the Connect dialog shows lookup progress and prevents duplicate submissions', async ({ devices }) => {
    const { alice, bob } = devices;
    await alice.getByRole('button', { name: `Open conversation with ${deviceNames.get('Bob')}`, exact: true }).click();
    await holdRequests(alice, ['pair-device']);
    await alice.locator('#connectCode').fill(await bob.locator('#selfCode').innerText());
    await alice.locator('#connectForm button[type="submit"]').click();
    await expect(alice.locator('#connectFeedback')).toHaveText('Looking up device…');
    await expect(alice.locator('#connectForm button[type="submit"]')).toBeDisabled();
    await expect(alice.locator('#connectDialog')).toBeVisible();
    await releaseRequests(alice);
    await expect(alice.locator('#connectDialog')).not.toBeVisible();
    await expect(alice.locator('#sessionPanel')).toBeVisible();
    await expect(alice.locator('#toastRegion')).toContainText(`Paired with ${deviceNames.get('Bob')}`);
  });
});
