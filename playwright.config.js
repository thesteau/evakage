import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45000,
  expect: { timeout: 15000 },
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: { browserName: 'chromium', trace: 'retain-on-failure' }
});
