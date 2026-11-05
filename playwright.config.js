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
  // Every spec now opens a real vault through the PIN gate: a 600k-iteration
  // PBKDF2 derivation and a WebAuthn round trip to wrap it, and a spec that
  // reloads pays both again. The stock 30s was a fit for a boot that restored
  // a session key for free; a test that also types and waits a few times
  // crosses it on a loaded machine.
  timeout: 60_000,
  // The stock 5s expect wait, twice over: a wrong PIN's alert lands after a
  // 600k-iteration derivation, and the wrap another derivation later. A
  // loaded two-core box crosses 5s often enough to look like a product bug.
  expect: { timeout: 15_000 },
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
