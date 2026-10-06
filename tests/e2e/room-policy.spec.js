import { expect } from '@playwright/test';
import { test, signInRoomOwner, joinRoom } from './helpers.js';

test('room creation stays visible, login errors use toasts, and replacing a room removes it for anonymous guests', async ({ devices }) => {
  const { alice, bob } = devices;
  const create = alice.locator('#createRoomForm').getByRole('button', { name: 'Create', exact: true });
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
  const oldCode = await alice.locator('#roomRows .peer-code').innerText();
  await joinRoom(bob, alice, 'First room');
  await expect(bob.locator('#accountBtn')).toHaveText('Login');
  for (const name of ['Second room', 'Third room']) {
    await alice.locator('#roomNameInput').fill(name);
    await create.click();
    await expect(alice.locator('#roomRows')).toContainText(name);
  }
  await expect(alice.locator('#roomRows tr')).toHaveCount(2);
  await expect(alice.locator('#roomRows')).not.toContainText('First room');
  await expect(alice.locator('#toastRegion')).toContainText('Your oldest room, First room, was destroyed');
  await expect(bob.locator('#sessionPanel')).toBeHidden();
  await expect(bob.locator('#roomRows tr')).toHaveCount(0);
  await expect(bob.locator('#toastRegion')).toContainText('First room was destroyed');
  await bob.locator('#roomCodeInput').fill(oldCode);
  await bob.locator('#joinRoomForm').getByRole('button', { name: 'Join', exact: true }).click();
  await expect(bob.locator('#toastRegion')).toContainText('Unable to join with this invitation');
  await joinRoom(bob, alice, 'Third room');
  await expect(bob.locator('#sessionTitle')).toHaveText('Third room');
});
