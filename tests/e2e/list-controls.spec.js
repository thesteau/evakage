import { expect } from '@playwright/test';
import { test, signInRoomOwner } from './helpers.js';

test('column filters and header sorting update the displayed rows', async ({ devices }) => {
  const { alice } = devices;
  const rows = alice.locator('#peerRows tr:visible');
  const names = rows.locator('.device-name > span:nth-child(2)');
  const deviceSort = alice.locator('#peersSection th[aria-sort]').first();
  await expect(rows).toHaveCount(2);
  const bobCode = await alice.locator('#peerRows tr:not(.self-device) .peer-code').innerText();
  const codeFilter = alice.getByRole('searchbox', { name: 'Filter by code' }).first();
  await codeFilter.fill(bobCode);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(bobCode);
  // A filter on one column does not match text from another.
  await codeFilter.fill('Windows');
  await expect(rows).toHaveCount(0);
  await expect(alice.locator('#emptyPeers')).toBeVisible();
  await alice.locator('#peersSection .clear-filters').click();
  await expect(rows).toHaveCount(2);
  await expect(codeFilter).toHaveValue('');
  await alice.locator('#deviceScope').selectOption('yours');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('This is you');
  await alice.locator('#deviceScope').selectOption('all');

  await deviceSort.getByRole('button').click();
  await expect(deviceSort).toHaveAttribute('aria-sort', 'ascending');
  const ascending = await names.allTextContents();
  expect(ascending).toEqual([...ascending].sort((a, b) => a.localeCompare(b)));
  await deviceSort.getByRole('button').click();
  await expect(deviceSort).toHaveAttribute('aria-sort', 'descending');
  await expect(names).toHaveText([...ascending].reverse());

  await signInRoomOwner(alice);
  for (const name of ['Zulu room', 'Alpha room']) {
    await alice.locator('#roomNameInput').fill(name);
    await alice.locator('#createRoomForm button').click();
    await expect(alice.locator('#roomRows')).toContainText(name);
  }
  const roomRows = alice.locator('#roomRows tr:visible');
  // Unsorted, rooms are oldest first.
  await expect(roomRows.first()).toContainText('Zulu room');
  await alice.getByRole('button', { name: 'Room', exact: true }).click();
  await expect(roomRows.first()).toContainText('Alpha room');
  await alice.locator('#roomFilter').fill('Zulu');
  await expect(roomRows).toHaveCount(1);
  await expect(roomRows).toContainText('Zulu room');
});
