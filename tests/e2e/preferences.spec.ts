import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../unit/helpers.js';
import { test as peerTest, deviceNames, listedName, chat, sendFile } from './helpers.js';

async function openAccount(page: import('@playwright/test').Page) {
  if (await page.locator('#sessionPanel.open').count()) await page.locator('#closeSession').click();
  await page.locator('#accountBtn').click();
}

test('account deletion confirms the password and clears chats on all signed-in devices', async ({
  browser,
}) => {
  const cleanup = [] as (() => Promise<void>)[];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-browser-delete-'));
  const { base } = await startServer(
    { after: (fn) => cleanup.push(fn) },
    { accountsDb: path.join(dir, 'accounts.sqlite') },
  );
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const [first, second] = pages;
    for (const [index, page] of pages.entries()) {
      await page.goto(base);
      await expect(page.locator('#selfCode')).not.toHaveText('----');
      if (index === 0) {
        await page.route('**/account/session', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await route.continue();
        });
      }
      await openAccount(page);
      if (index === 0) await expect(page.locator('#accountUsername')).toBeDisabled();
      await page.locator('#accountUsername').fill('temporary_owner');
      await page.locator('#accountPassword').fill('correct horse battery staple');
      await page
        .getByRole('button', { name: index === 0 ? 'Create account' : 'Sign in', exact: true })
        .click();
      await expect(page.locator('#accountStatus')).toContainText('Signed in as temporary_owner');
      await page
        .locator('#accountDialog')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
    }
    for (const page of pages) await expect(page.locator('#secureState')).toContainText('Encrypted');
    await chat(first, second, 'Temporary account chat');
    await openAccount(first);
    await first.locator('#accountDeleteDetails summary').click();
    await first.locator('#accountDeletePassword').fill('incorrect password value');
    await first.locator('#accountDelete').click();
    await expect(first.locator('#accountStatus')).toContainText('Incorrect password');
    await expect(first.locator('#accountSignedIn')).toBeVisible();
    await first.locator('#accountDeletePassword').fill('correct horse battery staple');
    await Promise.all([
      first.waitForEvent('load'),
      second.waitForEvent('load'),
      first.locator('#accountDelete').click(),
    ]);
    for (const page of pages) {
      await expect(page.locator('#selfCode')).not.toHaveText('----');
      await expect(page.locator('#timeline')).toBeEmpty();
      await expect(page.locator('#peerRows tr')).toHaveCount(1);
      await openAccount(page);
      await expect(page.locator('#accountForm')).toBeVisible();
    }
    await first.locator('#accountUsername').fill('temporary_owner');
    await first.locator('#accountPassword').fill('correct horse battery staple');
    await first.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(first.locator('#accountStatus')).toContainText('Invalid username or password');
  } finally {
    for (const context of contexts) await context.close();
    for (const fn of cleanup) await fn();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

peerTest(
  'hide and show control the list; blocked devices remain available for history and management',
  async ({ devices }) => {
    const { alice } = devices;
    const name = deviceNames.get('Bob') || '';
    const device = alice.locator('#peerRows tr').filter({ hasText: listedName(name) });
    await device.getByRole('button', { name: `Hide ${name}`, exact: true }).click();
    await expect(device).toHaveCount(0);
    await alice.getByRole('button', { name: 'Known devices', exact: true }).click();
    const record = alice.locator('#knownDeviceList > div').filter({ hasText: name });
    await record.getByRole('button', { name: 'Show', exact: true }).click();
    await alice.locator('#devicesDialog').getByRole('button', { name: 'Close' }).click();
    await expect(device).toHaveCount(1);
    await alice.getByRole('button', { name: 'Known devices', exact: true }).click();
    await record.getByRole('button', { name: `Block ${name}`, exact: true }).click();
    await expect(record).toContainText('Blocked');
    await alice.locator('#devicesDialog').getByRole('button', { name: 'Close' }).click();
    await expect(device).toHaveCount(1);
    await expect(device).toContainText('Blocked');
  },
);

test('account devices connect privately, exchange content, and sign-out destroys local chats without restoring them', async ({
  browser,
}) => {
  const cleanup = [] as (() => Promise<void>)[];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-account-chat-'));
  const { base } = await startServer(
    { after: (fn) => cleanup.push(fn) },
    { accountsDb: path.join(dir, 'accounts.sqlite') },
  );
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  const errors = [] as string[];
  try {
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const [computer, phone, outsider] = pages;
    for (const page of pages) {
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base);
      await expect(page.locator('#selfCode')).not.toHaveText('----');
    }
    const signIn = async (page: import('@playwright/test').Page, register = false) => {
      await openAccount(page);
      await page.locator('#accountUsername').fill('chat_owner');
      await page.locator('#accountPassword').fill('correct horse battery staple');
      await page
        .getByRole('button', { name: register ? 'Create account' : 'Sign in', exact: true })
        .click();
      await expect(page.locator('#accountStatus')).toContainText('Signed in as chat_owner');
      await page.locator('#accountDialog').getByRole('button', { name: 'Close' }).click();
    };
    const ownPhoneId = await phone.locator('#selfCode').getAttribute('data-device-id');
    await computer.evaluate(async (id) => {
      const modulePath = '/identity.js';
      const identity = await import(modulePath);
      identity.hideDevice(id, 'Previously hidden phone', true);
      identity.blockDevice(id, true);
      localStorage.setItem('evakage-verified-only', '1');
    }, ownPhoneId);
    await computer.reload();
    await expect(computer.locator('#selfCode')).not.toHaveText('----');
    await signIn(computer, true);
    await signIn(phone);
    for (const page of [computer, phone]) {
      await expect(page.locator('#sessionPanel')).toBeVisible();
      await expect(page.locator('#peerRows')).toContainText('This is yours');
      expect(await page.evaluate(() => localStorage.getItem('evakage-discoverable'))).toBeNull();
      await expect(page.locator('#secureState')).toContainText('Encrypted');
    }
    expect(
      await computer.evaluate(async (id) => {
        const modulePath = '/identity.js';
        const identity = await import(modulePath);
        const trust = identity.deviceTrust(id);
        return { blocked: trust.blocked, hidden: trust.hidden };
      }, ownPhoneId),
    ).toEqual({ blocked: false, hidden: false });
    await expect(computer.locator('#peerRows').getByRole('button', { name: /^Hide / })).toHaveCount(
      0,
    );
    await expect(outsider.locator('#peerRows tr')).toHaveCount(1);
    const phoneId = await phone.locator('#selfCode').getAttribute('data-device-id');
    const phoneName = (await phone.locator('#selfCode').getAttribute('data-device-name')) || '';
    await chat(computer, phone, 'Before sign-out: private text');
    await sendFile(computer, phone, 'account-file.txt', Buffer.from('private account file'));
    await phone.locator('#messageInput').fill('unsent private draft');
    await phone.locator('#closeSession').click();
    await openAccount(phone);
    await Promise.all([phone.waitForEvent('load'), phone.locator('#accountLogout').click()]);
    await expect(phone.locator('#selfCode')).toHaveAttribute('data-device-id', phoneId || '');
    await expect(phone.locator('#timeline')).toBeEmpty();
    await expect(phone.locator('#messageInput')).toHaveValue('');
    await expect(phone.locator('#peerRows tr')).toHaveCount(1);
    await expect(computer.locator('#timeline')).toContainText('Before sign-out: private text');
    await expect(computer.locator('#timeline')).toContainText('account-file.txt');
    await computer.locator('#closeSession').click();
    await computer
      .locator('#peerRows tr')
      .filter({ hasText: listedName(phoneName) })
      .getByRole('button', { name: /^Open conversation with/ })
      .click();
    await expect(computer.locator('#connectDialog')).toBeVisible();
    await computer.locator('#connectCancel').click();
    await signIn(phone);
    await expect(phone.locator('#sessionPanel')).toBeVisible();
    await expect(phone.locator('#secureState')).toContainText('Encrypted');
    await chat(computer, phone, 'After sign-in: fresh chat');
    await expect(phone.locator('#timeline')).not.toContainText('Before sign-out: private text');
    await expect(phone.locator('#timeline')).not.toContainText('account-file.txt');
    await signIn(outsider);
    await expect(outsider.locator('#peerRows tr')).toHaveCount(3);
    await expect(outsider.locator('#sessionPanel')).toBeHidden();
    await outsider
      .locator('#peerRows tr')
      .filter({ hasText: listedName(phoneName) })
      .getByRole('button', { name: /^Open conversation with/ })
      .click();
    await expect(outsider.locator('#sessionPanel')).toBeVisible();
    await expect(outsider.locator('#secureState')).toContainText('Encrypted');
    // Replaced tabs retain local history, so profile-wide sign-out must clear them too.
    const replacement = await contexts[1].newPage();
    replacement.on('pageerror', (error) => errors.push(error.message));
    await replacement.goto(base);
    await expect(replacement.locator('#selfCode')).not.toHaveText('----');
    await openAccount(replacement);
    await expect(replacement.locator('#accountStatus')).toContainText('Signed in as chat_owner');
    await Promise.all([
      phone.waitForEvent('load'),
      replacement.waitForEvent('load'),
      replacement.locator('#accountLogout').click(),
    ]);
    await expect(phone.locator('#timeline')).toBeEmpty();
    await expect(replacement.locator('#timeline')).toBeEmpty();
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    for (const fn of cleanup) await fn();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('optional account preferences sync between profiles without merging identities or advertising consent', async ({
  browser,
}) => {
  const cleanup = [] as (() => Promise<void>)[];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-browser-accounts-'));
  const { base } = await startServer(
    { after: (fn) => cleanup.push(fn) },
    { accountsDb: path.join(dir, 'accounts.sqlite') },
  );
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const first = await a.newPage();
    const second = await b.newPage();
    for (const page of [first, second]) {
      await page.goto(base);
      await expect(page.locator('#selfCode')).not.toHaveText('----');
    }
    const firstId = await first.locator('#selfCode').getAttribute('data-device-id');
    const secondId = await second.locator('#selfCode').getAttribute('data-device-id');
    expect(firstId).not.toBe(secondId);
    for (const page of [first, second]) {
      await openAccount(page);
      await page.locator('#accountUsername').fill('sync_owner');
      await page.locator('#accountPassword').fill('correct horse battery staple');
      await page
        .getByRole('button', { name: page === first ? 'Create account' : 'Sign in', exact: true })
        .click();
      await expect(page.locator('#accountStatus')).toContainText('Signed in as sync_owner');
      if (page === first) {
        await page.evaluate(() => {
          localStorage.setItem('evakage-theme', 'dark');
          localStorage.setItem('evakage-incoming', 'always');
          localStorage.setItem('evakage-discoverable', '1');
        });
        await page.locator('#accountSave').click();
        await expect(page.locator('#accountStatus')).toContainText('Preferences saved');
        await page.locator('#accountDialog').getByRole('button', { name: 'Close' }).click();
      }
    }
    await Promise.all([second.waitForEvent('load'), second.locator('#accountLoad').click()]);
    await expect(second.locator('#selfCode')).toHaveAttribute('data-device-id', secondId || '');
    await expect
      .poll(() => second.evaluate(() => localStorage.getItem('evakage-theme')))
      .toBe('dark');
    expect(await second.evaluate(() => localStorage.getItem('evakage-discoverable'))).toBeNull();
    await expect(second.locator('#sessionPanel')).toBeVisible();
    await second.locator('#closeSession').click();
    await second.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(second.locator('input[value="always"]')).toBeChecked();
    await expect(second.locator('#discoverableInput')).not.toBeChecked();
    await second.locator('#settingsDialog').getByRole('button', { name: 'Close' }).click();
    await openAccount(second);
    await expect(second.locator('#accountStatus')).toContainText('Signed in as sync_owner');
    await Promise.all([second.waitForEvent('load'), second.locator('#accountLogout').click()]);
    await expect(second.locator('#selfCode')).not.toHaveText('----');
    await openAccount(second);
    await expect(second.locator('#accountForm')).toBeVisible();
  } finally {
    await a.close();
    await b.close();
    for (const fn of cleanup) await fn();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
