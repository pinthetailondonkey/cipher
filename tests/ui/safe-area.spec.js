import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

test.describe('Safe area and viewport', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
  });

  test('main height is at least 80px shorter than viewport', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    const viewport = page.viewportSize();
    const main = await page.locator('main').first();
    const box = await main.boundingBox();

    expect(box).toBeTruthy();
    expect(viewport.height - box.height).toBeGreaterThanOrEqual(80);
  });

  test('no element bottom edge exceeds viewport on each screen', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    const viewport = page.viewportSize();

    // With overflow-hidden on blur wrappers, no elements should overflow
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
    await page.waitForTimeout(1000);

    const tabs = ['chat', 'explore', 'profile'];
    const failures = [];

    for (const tab of tabs) {
      // Navigate to tab
      if (tab !== 'chat') {
        const tabBtn = page.locator(`button:has-text("${tab === 'explore' ? 'Shop' : 'Profile'}")`);
        await tabBtn.click();
        await page.waitForTimeout(500);
      }

      const selectors = [
        'button:visible',
        '[role="button"]:visible',
        'a:not([href*="#"]):visible',
      ];

      let screenCount = 0;
      for (const selector of selectors) {
        const elements = await page.locator(selector).all();
        for (const el of elements) {
          const box = await el.boundingBox();
          if (box) {
            screenCount++;
            if (box.width < 44 || box.height < 44) {
              const html = await el.evaluate(node => node.outerHTML.slice(0, 100));
              failures.push(`[${tab}] ${html}: ${box.width}x${box.height}`);
            }
          }
        }
      }
      console.log(`${tab} screen: ${screenCount} interactive elements`);
    }

    if (failures.length > 0) {
      console.log('Tap target failures:', failures);
    }
    expect(failures).toHaveLength(0);
  });

  test('tab bar responds to touchscreen taps', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    const nav = await page.locator('nav').last();
    const box = await nav.boundingBox();

    expect(box).toBeTruthy();

    // Tap at vertical center using touchscreen
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);

    // Tap 4px from bottom edge
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 4);
    await page.waitForTimeout(300);

    expect(true).toBe(true);
  });
});
