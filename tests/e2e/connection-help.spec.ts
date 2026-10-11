import { expect, type Page } from '@playwright/test';
import { test, deviceNames, chat, sendFile } from './helpers.js';

// Keep production timeouts; shorten only the retry budget so exhaustion can
// be checked without waiting several minutes for eight background attempts.
test.use({
  appPatch: {
    device: 'Both',
    patch: (source) => source
      .replace('reconnectAttempts: 8,', 'reconnectAttempts: 1,')
      .replace('link.gaveUp = true;', "link.gaveUp = true; document.documentElement.dataset.directRetriesExhausted = '1';"),
  },
});

async function blockDirect(page: Page) {
  await page.evaluate(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string' && JSON.parse(data).type === 'signal') return;
      return send.call(this, data);
    };
    (window as Window & { restoreDirect?: () => void }).restoreDirect = () => {
      WebSocket.prototype.send = send;
    };
  });
}

async function openConversation(page: Page, name: string) {
  await page.getByRole('button', {
    name: `Open conversation with ${deviceNames.get(name)}`, exact: true,
  }).click();
  await expect(page.locator('#sessionPanel')).toBeVisible();
}

test('a stalled Mac connection shows permission help, relays content, and recovers on retry', async ({ devices }, info) => {
  const { alice, bob } = devices;
  // Advertise a Mac peer to a non-Mac browser. The Mac itself needs the same
  // guidance even though its peer is on another platform.
  await bob.context().addInitScript(() => Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/150.0.0.0 Safari/537.36',
  }));
  await bob.reload();
  await expect(bob.locator('#selfCode')).not.toHaveText('----');
  for (const page of [alice, bob]) await blockDirect(page);
  await openConversation(alice, 'Bob');
  await openConversation(bob, 'Alice');
  await expect(alice.locator('#connectionHelp')).toBeVisible();
  await expect(alice.locator('#connectionHelpAdvice')).toContainText('System Settings → Privacy & Security → Local Network');
  await expect(alice.locator('#connectionHelpAdvice')).toContainText('Quit and reopen');
  await expect(bob.locator('#connectionHelpAdvice')).toContainText('System Settings → Privacy & Security → Local Network');
  await expect(alice.locator('#connectionHelpText')).toContainText('encrypted through the server');
  await expect(alice.locator('#secureState')).toHaveText('Via server · direct connection unavailable');
  const row = alice.locator('#peerRows tr').filter({ has: alice.getByRole('button', {
    name: `Open conversation with ${deviceNames.get('Bob')}`, exact: true,
  }) });
  await expect(row.locator('[data-label="Status"]')).toHaveText('Online · via server');
  await alice.screenshot({ path: info.outputPath('connection-help-desktop.png') });
  const viewport = alice.viewportSize()!;
  await alice.setViewportSize({ width: 390, height: 844 });
  await expect(alice.locator('#retryConnectionBtn')).toBeInViewport();
  await expect(alice.locator('#messageForm button[type="submit"]')).toBeInViewport();
  await alice.screenshot({ path: info.outputPath('connection-help-mobile.png') });
  await alice.setViewportSize(viewport);
  await expect(alice.locator('#forceRelayInput')).not.toBeChecked();
  await chat(alice, bob, 'Automatic fallback with blocked direct connection');
  await chat(bob, alice, 'Return message via encrypted relay');
  await sendFile(alice, bob, 'fallback.txt', Buffer.from('Encrypted fallback file'));

  // The notice stays useful after the retry budget has been exhausted.
  await expect(alice.locator('html')).toHaveAttribute('data-direct-retries-exhausted', '1');
  await expect(bob.locator('html')).toHaveAttribute('data-direct-retries-exhausted', '1');
  await expect(alice.locator('#connectionHelp')).toBeVisible();
  await expect(alice.locator('#secureState')).toHaveText('Via server · direct connection unavailable');
  await expect(row.locator('[data-label="Status"]')).not.toHaveClass(/danger/);
  for (const page of [alice, bob]) {
    await page.evaluate(() =>
      (window as Window & { restoreDirect?: () => void }).restoreDirect?.(),
    );
  }
  // The larger fingerprint cannot send an offer itself. Its retry must wake
  // the other browser, which has also exhausted its retry budget.
  const aliceId = (await alice.locator('#selfCode').getAttribute('data-device-id'))!;
  const bobId = (await bob.locator('#selfCode').getAttribute('data-device-id'))!;
  const retrying = aliceId.localeCompare(bobId) > 0 ? alice : bob;
  await retrying.locator('#retryConnectionBtn').click();
  await expect(alice.locator('#secureState')).toContainText('Encrypted ·');
  await expect(bob.locator('#secureState')).toContainText('Encrypted ·');
  await expect(alice.locator('#connectionHelp')).toBeHidden();
  await expect(bob.locator('#connectionHelp')).toBeHidden();
  await expect(row.locator('[data-label="Status"]')).toHaveText('Connected');
  await chat(alice, bob, 'Direct delivery after allowing the connection');
});

test('a browser refusing peer connections shows help and allows encrypted server delivery', async ({ devices }) => {
  const { alice, bob } = devices;
  for (const page of [alice, bob]) {
    await page.evaluate(() => Object.defineProperty(navigator, 'userAgent', {
      configurable: true, value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0',
    }));
  }
  await alice.evaluate(() => {
    window.RTCPeerConnection = class extends RTCPeerConnection {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        this.close();
        throw new DOMException('Blocked by browser policy', 'NotAllowedError');
      }
    };
  });
  await openConversation(alice, 'Bob');
  await openConversation(bob, 'Alice');
  await expect(alice.locator('#connectionHelp')).toBeVisible();
  await expect(alice.locator('#connectionHelpAdvice')).toContainText('browser’s site settings');
  await expect(alice.locator('#connectionHelpAdvice')).not.toContainText('System Settings');
  await expect(alice.locator('#secureState')).not.toContainText('Connecting');
  await chat(alice, bob, 'Delivered despite a browser policy refusing the direct connection');
});
