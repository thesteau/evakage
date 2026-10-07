import { expect } from '@playwright/test';
import { test, signInRoomOwner, joinRoom, roomCode } from './helpers.js';

test('room creation stays visible, login errors use toasts, and replacing a room removes it for anonymous guests', async ({
  devices,
}) => {
  const { alice, bob } = devices;
  const create = alice
    .locator('#createRoomForm')
    .getByRole('button', { name: 'Create', exact: true });
  await expect(create).toBeVisible();
  await alice.locator('#roomNameInput').fill('First room');
  await create.click();
  await expect(alice.locator('#toastRegion')).toContainText('Log in to create a room');
  await expect(alice.locator('#roomRows tr')).toHaveCount(0);
  await expect(alice.locator('#roomNameInput')).toHaveValue('First room');
  await signInRoomOwner(alice);
  await create.click();
  await expect(alice.locator('#roomRows')).toContainText('First room');
  await expect(alice.locator('#toastRegion')).toContainText('Created First room');
  const oldCode = await roomCode(alice, 'First room');
  await joinRoom(bob, alice, 'First room');
  await expect(bob.locator('#accountBtn')).toHaveAccessibleName('Login');
  for (const name of ['Second room', 'Third room']) {
    await alice.locator('#roomNameInput').fill(name);
    await create.click();
    await expect(alice.locator('#roomRows')).toContainText(name);
  }
  await expect(alice.locator('#roomRows tr')).toHaveCount(2);
  await expect(alice.locator('#roomRows')).not.toContainText('First room');
  await expect(alice.locator('#toastRegion')).toContainText(
    'Your oldest room, First room, was destroyed',
  );
  await expect(bob.locator('#sessionPanel')).toBeHidden();
  await expect(bob.locator('#roomRows tr')).toHaveCount(0);
  await expect(bob.locator('#toastRegion')).toContainText('First room was destroyed');
  await bob.locator('#roomCodeInput').fill(oldCode);
  await bob.locator('#joinRoomForm').getByRole('button', { name: 'Join', exact: true }).click();
  await expect(bob.locator('#toastRegion')).toContainText('Unable to join with this invitation');
  await joinRoom(bob, alice, 'Third room');
  await expect(bob.locator('#sessionTitle')).toHaveText('Third room');
});

test('a private room waits for its creator, who alone sees its settings', async ({ devices }) => {
  const { alice, bob } = devices;
  const room = 'Approval room';
  await signInRoomOwner(alice, 'private');
  await alice.locator('#roomNameInput').fill(room);
  await alice.locator('#createRoomForm').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(alice.locator('#roomRows')).toContainText(room);
  const code = await roomCode(alice, room);
  const bobName = (await bob.locator('#selfCode').getAttribute('data-device-name')) || '';

  await bob.locator('#roomCodeInput').fill(code);
  await bob.locator('#joinRoomForm').getByRole('button', { name: 'Join', exact: true }).click();
  await expect(bob.locator('#roomRows')).toContainText('Waiting for approval');
  await expect(bob.locator('#roomRows')).not.toContainText(code);
  await expect(bob.locator('#sessionPanel')).toBeHidden();
  await expect(alice.locator('#toastRegion')).toContainText(`${bobName} wants to join ${room}`);
  await expect(alice.locator('#roomRows')).toContainText('1 waiting');

  // The request is answered from the room's chat.
  await alice.getByRole('button', { name: `Open room ${room}`, exact: true }).click();
  await alice.getByRole('button', { name: `Approve ${bobName}`, exact: true }).click();
  await expect(alice.locator('#joinRequests')).toBeHidden();
  await expect(bob.locator('#sessionTitle')).toHaveText(room);
  await expect(bob.locator('#roomCodeLine')).toHaveText(`Code: ${code}`);
  await expect(bob.locator('#relayToggle')).toBeHidden();

  await bob.getByRole('button', { name: 'Show room QR code', exact: true }).click();
  await expect(bob.locator('#roomQrDialog')).toBeVisible();
  await expect(bob.locator('#roomQrCode')).toHaveText(code);
  await bob.locator('#roomQrDialog').getByRole('button', { name: 'Close' }).click();

  // Room settings are the creator's alone.
  await bob.locator('#closeSession').click();
  await expect(bob.getByRole('button', { name: `Settings for room ${room}` })).toHaveCount(0);
  await alice.locator('#closeSession').click();
  await alice.getByRole('button', { name: `Settings for room ${room}`, exact: true }).click();
  await expect(alice.getByRole('menuitemradio', { name: /^Private/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(bob.locator('#roomRows')).toContainText('private');
  await alice.getByRole('menuitemradio', { name: /^Protected/ }).click();
  const row = alice.locator('#roomRows tr').filter({ hasText: room });
  await expect(row).toContainText('protected');
  await expect(bob.locator('#roomRows')).toContainText('protected');
  await row.getByRole('button', { name: `Settings for room ${room}`, exact: true }).click();
  await expect(alice.getByRole('menuitemradio', { name: /^Protected/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});
