import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../tests/helpers.js';
import { test as peerTest, deviceNames, chat, sendFile } from './helpers.js';

peerTest('hide and show control the list; blocked devices remain available for history and management', async ({ devices }) => {
  const { alice } = devices;
  const name = deviceNames.get('Bob') || '';
  const device = alice.locator('#peerRows tr').filter({ hasText: name });
  await device.getByRole('button', { name: `Hide ${name}`, exact: true }).click();
  await expect(device).toHaveCount(0);
  await alice.getByRole('button', { name: 'Known devices', exact: true }).click();
  const record = alice.locator('#knownDeviceList > div').filter({ hasText: name });
  await record.getByRole('button', { name: 'Show', exact: true }).click();
  await alice.locator('#devicesDialog').getByRole('button', { name: 'Done' }).click();
  await expect(device).toHaveCount(1);
  await alice.getByRole('button', { name: 'Known devices', exact: true }).click();
  await record.getByRole('button', { name: `Block ${name}`, exact: true }).click();
  await expect(record).toContainText('Blocked');
  await alice.locator('#devicesDialog').getByRole('button', { name: 'Done' }).click();
  await expect(device).toHaveCount(1);
  await expect(device).toContainText('Blocked');
});

test('account devices connect privately, exchange content, and sign-out destroys local chats without restoring them', async ({ browser }) => {
  const cleanup = /** @type {(() => Promise<void>)[]} */ ([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-account-chat-'));
  const { base } = await startServer({ after: fn => cleanup.push(fn) }, { accountsDb: path.join(dir, 'accounts.sqlite') });
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const errors = /** @type {string[]} */ ([]);
  try {
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    const [computer, phone, outsider] = pages;
    for (const page of pages) {
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await expect(page.locator('#selfCode')).not.toHaveText('----');
    }
    const signIn = async (/** @type {import('@playwright/test').Page} */ page, register = false) => {
      await page.getByRole('button', { name: 'Account (optional)', exact: true }).click();
      await page.locator('#accountUsername').fill('chat_owner');
      await page.locator('#accountPassword').fill('correct horse battery staple');
      await page.getByRole('button', { name: register ? 'Create account' : 'Sign in', exact: true }).click();
      await expect(page.locator('#accountStatus')).toContainText('Signed in as chat_owner');
      await page.locator('#accountDialog').getByRole('button', { name: 'Done' }).click();
    };
    await signIn(computer, true); await signIn(phone);
    for (const page of [computer, phone]) {
      await expect(page.locator('#sessionPanel')).toBeVisible();
      await expect(page.locator('#peerRows')).toContainText('Your account');
      expect(await page.evaluate(() => localStorage.getItem('aria-drop-discoverable'))).toBeNull();
      await expect(page.locator('#secureState')).toContainText('Encrypted');
    }
    await expect(outsider.locator('#peerRows tr')).toHaveCount(1);
    const phoneId = await phone.locator('#selfCode').getAttribute('data-device-id');
    const phoneName = await phone.locator('#selfCode').getAttribute('data-device-name') || '';
    await chat(computer, phone, 'Before sign-out: private text');
    await sendFile(computer, phone, 'account-file.txt', Buffer.from('private account file'));
    await phone.locator('#messageInput').fill('unsent private draft');
    await phone.locator('#closeSession').click();
    await phone.getByRole('button', { name: 'Account (optional)', exact: true }).click();
    await Promise.all([phone.waitForEvent('load'), phone.locator('#accountLogout').click()]);
    await expect(phone.locator('#selfCode')).toHaveAttribute('data-device-id', phoneId || '');
    await expect(phone.locator('#timeline')).toBeEmpty();
    await expect(phone.locator('#messageInput')).toHaveValue('');
    await expect(phone.locator('#peerRows tr')).toHaveCount(1);
    await expect(computer.locator('#timeline')).toContainText('Before sign-out: private text');
    await expect(computer.locator('#timeline')).toContainText('account-file.txt');
    await computer.locator('#closeSession').click();
    await computer.locator('#peerRows tr').filter({ hasText: phoneName }).getByRole('button', { name: /^Open conversation with/ }).click();
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
    await outsider.locator('#peerRows tr').filter({ hasText: phoneName }).getByRole('button', { name: /^Open conversation with/ }).click();
    await expect(outsider.locator('#sessionPanel')).toBeVisible();
    await expect(outsider.locator('#secureState')).toContainText('Encrypted');
    // Replaced tabs retain local history, so profile-wide sign-out must clear them too.
    const replacement = await contexts[1].newPage();
    replacement.on('pageerror', error => errors.push(error.message));
    await replacement.goto(base);
    await expect(replacement.locator('#selfCode')).not.toHaveText('----');
    await replacement.getByRole('button', { name: 'Account (optional)', exact: true }).click();
    await expect(replacement.locator('#accountStatus')).toContainText('Signed in as chat_owner');
    await Promise.all([phone.waitForEvent('load'), replacement.waitForEvent('load'), replacement.locator('#accountLogout').click()]);
    await expect(phone.locator('#timeline')).toBeEmpty();
    await expect(replacement.locator('#timeline')).toBeEmpty();
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    for (const fn of cleanup) await fn();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('optional account preferences sync between profiles without merging identities or advertising consent', async ({ browser }) => {
  const cleanup = /** @type {(() => Promise<void>)[]} */ ([]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-browser-accounts-'));
  const { base } = await startServer({ after: fn => cleanup.push(fn) }, { accountsDb: path.join(dir, 'accounts.sqlite') });
  const a = await browser.newContext(); const b = await browser.newContext();
  try {
    const first = await a.newPage(); const second = await b.newPage();
    for (const page of [first, second]) { await page.goto(base); await expect(page.locator('#selfCode')).not.toHaveText('----'); }
    const firstId = await first.locator('#selfCode').getAttribute('data-device-id');
    const secondId = await second.locator('#selfCode').getAttribute('data-device-id');
    expect(firstId).not.toBe(secondId);
    for (const page of [first, second]) {
      await page.getByRole('button', { name: 'Account (optional)', exact: true }).click();
      await page.locator('#accountUsername').fill('sync_owner');
      await page.locator('#accountPassword').fill('correct horse battery staple');
      await page.getByRole('button', { name: page === first ? 'Create account' : 'Sign in', exact: true }).click();
      await expect(page.locator('#accountStatus')).toContainText('Signed in as sync_owner');
      if (page === first) {
        await page.evaluate(() => { localStorage.setItem('aria-drop-theme', 'dark'); localStorage.setItem('aria-drop-incoming', 'always'); localStorage.setItem('aria-drop-discoverable', '1'); });
        await page.locator('#accountSave').click();
        await expect(page.locator('#accountStatus')).toContainText('Preferences saved');
        await page.locator('#accountDialog').getByRole('button', { name: 'Done' }).click();
      }
    }
    await Promise.all([second.waitForEvent('load'), second.locator('#accountLoad').click()]);
    await expect(second.locator('#selfCode')).toHaveAttribute('data-device-id', secondId || '');
    await expect.poll(() => second.evaluate(() => localStorage.getItem('aria-drop-theme'))).toBe('dark');
    expect(await second.evaluate(() => localStorage.getItem('aria-drop-discoverable'))).toBeNull();
    await expect(second.locator('#sessionPanel')).toBeVisible();
    await second.locator('#closeSession').click();
    await second.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(second.locator('input[value="always"]')).toBeChecked();
    await expect(second.locator('#discoverableInput')).not.toBeChecked();
    await second.locator('#settingsDialog').getByRole('button', { name: 'Done' }).click();
    await second.getByRole('button', { name: 'Account (optional)', exact: true }).click();
    await expect(second.locator('#accountStatus')).toContainText('Signed in as sync_owner');
    await Promise.all([second.waitForEvent('load'), second.locator('#accountLogout').click()]);
    await expect(second.locator('#selfCode')).not.toHaveText('----');
    await second.getByRole('button', { name: 'Account (optional)', exact: true }).click();
    await expect(second.locator('#accountForm')).toBeVisible();
  } finally {
    await a.close(); await b.close();
    for (const fn of cleanup) await fn();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
