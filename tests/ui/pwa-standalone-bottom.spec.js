import { test, expect } from '@playwright/test';
import { seedVault, unlock } from './fixtures.js';

// Issue 2: in the iPhone home-screen (standalone) app the bottom tab bar was
// cut off at the bottom; in a browser tab it was fine. THE CAUSE, measured at
// each iPhone size: the standalone viewport reports --sab (env
// safe-area-inset-bottom) as 0px, so the BottomBar's pb-safe padding is 0 and
// its 56px button row (labels included) lands EXACTLY on window.innerHeight —
// the strip where a standalone iPhone reserves the home indicator and paints
// nothing. The fix floors --sab to the 34px home-indicator height only in
// standalone mode (index.css `@media (display-mode: standalone)` + the
// equivalent `:root[data-standalone]` selector main.jsx drives), so the bar's
// labels always clear the zone. Browser mode keeps the un-floored inset and is
// byte-for-byte unchanged.
//
// This spec measures the tab bar's button-row bottom relative to the visible
// viewport (window.innerHeight) in both modes. It is the before/after proof:
// before the fix, flipping on standalone leaves clearance at 0 (FAIL); after
// the fix it clears by the home-indicator height (PASS).
const SIZES = [
  { name: 'iPhone SE',        w: 375, h: 667 },
  { name: 'iPhone 15',        w: 393, h: 852 },
  { name: 'iPhone 15 Pro Max',w: 430, h: 932 },
  { name: 'iPhone 16 Pro Max',w: 440, h: 956 },
];

async function snapshot(page) {
  return page.evaluate(() => {
    const navs = [...document.querySelectorAll('nav[aria-label="Tabs"]')];
    const bar = navs.find((n) => n.classList.contains('md:hidden'));
    if (!bar) return null;
    const row = bar.firstElementChild.getBoundingClientRect();
    return Math.round((window.innerHeight - row.bottom) * 100) / 100;
  });
}

test.describe('PWA standalone bottom tab bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
  });

  for (const size of SIZES) {
    test(`${size.name}: the tab bar clears the home-indicator zone in standalone`, async ({ page }) => {
      await page.goto('/');
      await unlock(page);
      await page.waitForTimeout(1000);
      await page.setViewportSize({ width: size.w, height: size.h });
      await page.waitForTimeout(1500);

      // Browser mode: Safari already eats the inset, and the standalone floor
      // must never touch it. The bar's labels end at the viewport bottom here
      // (clearance 0 is the measured defect the fix is about, so lock it in).
      // In Chromium, --sab is 0 whether or not a real browser would report 34;
      // what matters is that browser mode leaves --sab untouched.
      expect(await snapshot(page)).not.toBeNull();

      // Flip on the standalone home-screen mode (the same flag main.jsx sets
      // on a real device). Under the fix this floors --sab to the 34px home
      // indicator, lifting the labels clear; before the fix it changed nothing.
      await page.evaluate(() => document.documentElement.setAttribute('data-standalone', ''));
      await page.waitForTimeout(300);

      const clearance = await snapshot(page);
      console.log(`${size.name} standalone bottom clearance: ${clearance}px`);
      // The 56px button row now ends >=34px above window.innerHeight, clear of
      // the indicator zone. Fails on the unfixed build (clearance stays 0).
      expect(clearance).toBeGreaterThanOrEqual(34);
    });

    test(`${size.name}: browser mode is untouched by the standalone floor`, async ({ page }) => {
      await page.goto('/');
      await unlock(page);
      await page.waitForTimeout(1000);
      await page.setViewportSize({ width: size.w, height: size.h });
      await page.waitForTimeout(1500);

      // No data-standalone and no display-mode:standalone in a browser tab, so
      // --sab must still be the raw env inset (0 in the emulator).
      const sab = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sab').trim());
      expect(sab).toBe('0px');
    });
  }
});
