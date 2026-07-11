import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 30_000,
  use: {
    baseURL: process.env.NGINX_URL || process.env.BASE_URL || 'http://localhost:8080',
    ignoreHTTPSErrors: true,
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
  ],
});
