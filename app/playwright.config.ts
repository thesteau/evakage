import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../tests/e2e',
  outputDir: '../../test-results/chromium',
  timeout: 45000,
  expect: { timeout: 15000 },
  fullyParallel: true,
  workers: 2,
  // One retry on CI absorbs runner timing noise in the WebRTC races. A test
  // that only passes on retry is still listed as "flaky" in the report, so
  // a real race stays visible instead of failing the build outright.
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { browserName: 'chromium', trace: 'retain-on-failure' },
});
