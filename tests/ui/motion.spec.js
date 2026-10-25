import { test, expect } from '@playwright/test';

test.describe('Motion and accessibility', () => {
  test('respects prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.waitForTimeout(500);

    // Check that animated nav has no active transition
    const nav = await page.locator('nav').last();
    const hasTransition = await nav.evaluate(el => {
      const style = window.getComputedStyle(el);
      return style.transitionDuration !== '0s';
    });

    // With reduced motion, transitions should be instant or disabled
    // In practice, motion.div from framer-motion should respect this
    expect(hasTransition).toBe(false);
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
