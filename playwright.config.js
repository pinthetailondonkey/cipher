import { defineConfig } from '@playwright/test';

// One port for baseURL, readiness and the server itself: a run can never
// report green against a page it did not serve. `reuseExistingServer` is off
// and the preview binds strictly, so a stray server on this port is a loud
// failure instead of a quiet reuse — the exact trap that once let five specs
// pass against another worktree's build.
const PORT = 8081;
const ORIGIN = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: ORIGIN,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      // Records the SHA, the build and the port, and refuses a bundle without
      // the test seam. Every browser project waits for it.
      name: 'run-context',
      testMatch: /runContext\.setup\.js/,
    },
    {
      // Desktop Chromium with a virtual WebAuthn authenticator (PRF).
      name: 'chromium',
      testMatch: /devicePrf\.spec\.js/,
      dependencies: ['run-context'],
      use: { viewport: { width: 1000, height: 700 } },
    },
    {
      name: 'iphone',
      testIgnore: /devicePrf\.spec\.js/,
      dependencies: ['run-context'],
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
    // Built here so a direct `npx playwright test` is as honest as `npm run
    // test:ui`: the specs never run against an older bundle.
    command: 'npm run build:ui-test && npm run preview',
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 180000,
  },
});
