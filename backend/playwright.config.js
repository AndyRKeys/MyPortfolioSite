import { defineConfig, devices } from '@playwright/test';

// In Docker (Alpine), Playwright cannot download its own browsers due to
// PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1. Use the system Chromium installed via
// apk, pointed to by PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH in the Dockerfile.
//
// Firefox cross-browser testing requires a Debian-based image (Playwright's
// Firefox driver is a patched build that won't run against system firefox-esr
// on Alpine). Tracked in #527 — add firefox project when base image changes.
const chromiumExec = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

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
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumExec ? { launchOptions: { executablePath: chromiumExec } } : {}),
      },
    },
    // firefox: deferred until base image moves off Alpine (#527)
  ],
});
