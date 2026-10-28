import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

test.describe('Motion and accessibility', () => {
  // The icon rail is the mounted nav the checks sample, and it shows only at
  // md+ in the rebuild; the assertions read at any width, so the viewport
  // goes desktop-sized for the rail to be visible.
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
  });

  test('respects prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    // Wait for the tab nav: the app lazy-loads past the lock screen, so a
    // fixed timeout races the mount. The nav transform is stable immediately
    // once it exists, because reducedMotion="user" skips the spring. At this
    // width the role matches the md+ rail alone (the below-md bar is
    // display-none and getByRole skips it).
    const nav = page.getByRole('navigation', { name: 'Tabs' });
    await nav.waitFor();

    // Sample nav transform twice 100ms apart - with MotionConfig reducedMotion="user",
    // framer-motion skips transform animations so both samples should be identical
    const transform1 = await nav.evaluate(el => window.getComputedStyle(el).transform);
    await page.waitForTimeout(100);
    const transform2 = await nav.evaluate(el => window.getComputedStyle(el).transform);

    expect(transform1).toBe(transform2);
  });

  test('focusable elements show visible outline on tab', async ({ page }) => {
    await page.goto('/');
    // Wait for the tab nav so the app is mounted before tabbing; a fixed
    // timeout let this race the lazy load and flake under suite load.
    await page.getByRole('navigation', { name: 'Tabs' }).waitFor();

    // Tab through first few focusable elements
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);

    const focused = await page.locator(':focus');
    const outline = await focused.evaluate(el => {
      const style = window.getComputedStyle(el);
      return style.outline || style.outlineWidth;
    });

    expect(outline).toBeTruthy();
    expect(outline).not.toBe('none');
  });
});
