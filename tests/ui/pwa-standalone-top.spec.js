// Item 4 witness (founder's native-feel list): in standalone the top of the
// app is ONE black surface. The status bar draws over the app (black-translucent
// + viewport-fit=cover), so "one surface" means: the document paints --bg black,
// and the first chrome row starts at y=0 with the header ground (--header, also
// black) behind it — no white/grey strip between the iOS status text and the
// header. This is computed-style evidence in the standalone model (matchMedia
// overridden), not a pixel probe: colour and geometry, asserted, every size.
import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

const PHONE_SIZES = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 15', width: 393, height: 852 },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932 },
  { name: 'iPhone 16 Pro Max', width: 440, height: 956 },
];

for (const size of PHONE_SIZES) {
  test.describe(`standalone top surface — ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(seedVault);
      // Force the standalone media query the way the installed app matches it.
      await page.addInitScript(`
        (() => {
          const real = window.matchMedia.bind(window);
          window.matchMedia = (q) => Object.assign(real(q), {
            matches: /display-mode\\s*:\\s*standalone/.test(q),
          });
        })()
      `);
      await page.goto('/');
      await page.waitForTimeout(1200);
    });

    test('the top is one black surface: body and first chrome row, no gap above chrome', async ({ page }) => {
      const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bodyBg).toBe('rgb(0, 0, 0)');

      // The first chrome row (chat list header block) must sit at the very top:
      // the status bar overlays it, nothing else lives above it. The chat
      // screen's content wrapper is the outermost element at the top pixel.
      const chrome = page.locator('#root div.relative.min-h-\\[100dvh\\]').first();
      await chrome.waitFor({ state: 'visible' });
      const box = await chrome.boundingBox();
      expect(box.y).toBe(0);

      const chromeBg = await chrome.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(chromeBg).toBe('rgb(0, 0, 0)');
    });
  });
}
