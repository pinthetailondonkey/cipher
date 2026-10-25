import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

test.describe('Motion and accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
  });

  test('respects prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Sample nav transform twice 100ms apart - with MotionConfig reducedMotion="user",
    // framer-motion skips transform animations so both samples should be identical
    const nav = await page.locator('nav').last();
    const transform1 = await nav.evaluate(el => window.getComputedStyle(el).transform);
    await page.waitForTimeout(100);
    const transform2 = await nav.evaluate(el => window.getComputedStyle(el).transform);

    expect(transform1).toBe(transform2);
  });

  test('focusable elements show visible outline on tab', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

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
