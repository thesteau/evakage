import { expect } from '@playwright/test';
import { test, signInRoomOwner } from './helpers.js';

test('device and room filters and sorting update the displayed rows', async ({ devices }) => {
  const { alice } = devices;
  const rows = alice.locator('#peerRows tr:visible');
  await expect(rows).toHaveCount(2);
  const bobCode = await alice.locator('#peerRows tr:not(.self-device) .peer-code').innerText();
  await alice.locator('#deviceFilter').fill(bobCode);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(bobCode);
  await alice.locator('#deviceFilter').fill('no matching device');
  await expect(rows).toHaveCount(0);
  await alice.locator('#deviceFilter').fill('');
  await alice.locator('#deviceScope').selectOption('yours');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('This is you');
  await alice.locator('#deviceScope').selectOption('all');
  await alice.locator('#deviceSort').selectOption('name-desc');
  const descending = await rows.locator('.device-name > span:nth-child(2)').allTextContents();
  expect(descending).toEqual([...descending].sort((a, b) => b.localeCompare(a)));
  await alice.locator('#deviceSort').selectOption('name');
  await expect(rows.locator('.device-name > span:nth-child(2)')).toHaveText([...descending].reverse());
  await signInRoomOwner(alice);
  for (const name of ['Zulu room', 'Alpha room']) {
    await alice.locator('#roomNameInput').fill(name);
    await alice.locator('#createRoomForm button').click();
    await expect(alice.locator('#roomRows')).toContainText(name);
  }
  await alice.locator('#roomSort').selectOption('name');
  await expect(alice.locator('#roomRows tr').first()).toContainText('Alpha room');
  await alice.locator('#roomSort').selectOption('oldest');
  await expect(alice.locator('#roomRows tr').first()).toContainText('Zulu room');
  await alice.locator('#roomFilter').fill('Alpha');
  await expect(alice.locator('#roomRows tr')).toHaveCount(1);
  await expect(alice.locator('#roomRows')).toContainText('Alpha room');
});
