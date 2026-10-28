import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:8081',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      // Desktop Chromium with a virtual WebAuthn authenticator (PRF).
      name: 'chromium',
      testMatch: /devicePrf\.spec\.js/,
      use: { viewport: { width: 1000, height: 700 } },
    },
    {
      name: 'iphone',
      testIgnore: /devicePrf\.spec\.js/,
      use: {
        viewport: { width: 390, height: 844 },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    },
  ],
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:8081',
    reuseExistingServer: true,
    timeout: 10000,
  },
});
