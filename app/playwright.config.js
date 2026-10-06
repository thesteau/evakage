import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../tests/e2e',
  outputDir: '../test-results/chromium',
  timeout: 45000,
  expect: { timeout: 15000 },
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: { browserName: 'chromium', trace: 'retain-on-failure' }
});
