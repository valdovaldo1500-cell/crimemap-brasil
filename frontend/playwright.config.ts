import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  retries: 1,
  use: {
    baseURL: 'http://localhost:3001',
    headless: true,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
