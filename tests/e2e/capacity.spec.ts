import { expect } from '@playwright/test';
import { test } from './helpers.js';

test('near-capacity relay warnings appear for both connected participants', async ({ devices }) => {
  const { alice, bob, server } = devices;
  const [sender, recipient] = [...server.clients.values()];
  server.blobStore.config.maxConversationFileBytes = 240;
  const result = await server.blobStore.offer({
    senderId: sender.deviceId,
    conv: 'direct',
    kind: 'file',
    bytes: 128,
    chunkSize: 100,
    totalChunks: 1,
    envelopes: { [recipient.deviceId]: { v: 1, ephemeral: 'e', iv: 'i', ciphertext: 'c' } },
  });
  expect(result.blob).toBeTruthy();
  for (const page of [alice, bob])
    {await expect(page.getByText(/Temporary file delivery capacity is nearly full/)).toBeVisible();}
});
