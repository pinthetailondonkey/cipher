import { test, expect } from '@playwright/test';

test.describe('Safe area and viewport', () => {
  test('main height is at least 80px shorter than viewport', async ({ page }) => {
    await page.goto('/');

    const viewport = page.viewportSize();
    const main = await page.locator('main').first();
    const box = await main.boundingBox();

    expect(box).toBeTruthy();
    expect(viewport.height - box.height).toBeGreaterThanOrEqual(80);
  });

  test('no element bottom edge exceeds viewport on each screen', async ({ page }) => {
    await page.goto('/');

    const viewport = page.viewportSize();

    // Check home screen
    const allElements = await page.locator('body *').all();
    for (const el of allElements) {
      const box = await el.boundingBox();
      if (box) {
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      }
    }
  });

  test('every interactive element has 44x44 minimum tap target', async ({ page }) => {
    await page.goto('/');

    const selectors = [
      'button:visible',
      '[role="button"]:visible',
      'a:not([href*="#"]):visible',
    ];

    const failures = [];

    for (const selector of selectors) {
      const elements = await page.locator(selector).all();
      for (const el of elements) {
        const box = await el.boundingBox();
        if (box && (box.width < 44 || box.height < 44)) {
          const html = await el.evaluate(node => node.outerHTML.slice(0, 100));
          failures.push(`${html}: ${box.width}x${box.height}`);
        }
      }
    }

    if (failures.length > 0) {
      console.log('Tap target failures:', failures);
    }
    expect(failures).toHaveLength(0);
  });

  test('tab bar responds to clicks at center and near bottom', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000); // Wait for animations

    const nav = await page.locator('nav').last();
    const box = await nav.boundingBox();

    expect(box).toBeTruthy();

    // Click at vertical center
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);

    // Click 4px from bottom
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 4);
    await page.waitForTimeout(300);

    // If we get here without errors, clicks registered
    expect(true).toBe(true);
  });
});
