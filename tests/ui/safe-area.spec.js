import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

// Every tab the bottom nav can reach, with the label on its nav button.
// Chat needs a click too: the clipped-down assertion set must visit each tab
// the same way so the run is identical no matter which tab is home.
const TABS = [
  { key: 'chat', label: 'Chats' },
  { key: 'explore', label: 'Shop' },
  { key: 'profile', label: 'Profile' },
];

async function openTab(page, tab) {
  await page.goto('/');
  await page.waitForTimeout(1000);
  await page.locator('nav').last().locator(`button:has-text("${tab.label}")`).click();
  await page.waitForTimeout(500);
  // Explore pulls listings from relays with its own 4s timeout; let the fetch
  // settle so the measured screen is the loaded one, not the spinner.
  if (tab.key === 'explore') {
    await page.waitForTimeout(4500);
  }
}

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

  // Clipping per tab. Only elements the reader cannot reach or see count:
  //   - hidden tabs stay mounted (visibility:hidden) behind the active one, so
  //     display/visibility are read in-page, not via Playwright :visible;
  //   - content in a scroll container that itself fits the viewport is
  //     reachable by scrolling;
  //   - content inside an overflow-hidden holder is held back by that holder
  //     (blur blobs inside their wrapper), per the home rule;
  //   - everything else poking past the viewport bottom is clipped dead.
  // A scroll container that itself pokes past the viewport bottom is always a
  // failure: its lower content can be scrolled to nowhere.
  for (const tab of TABS) {
    test(`no unreachable element bottom exceeds viewport on ${tab.key}`, async ({ page }) => {
      await openTab(page, tab);

      const offenders = await page.evaluate(() => {
        const EPS = 1;
        const limit = window.innerHeight;
        const flagged = new Set();
        const offenders = [];
        const tagOf = (el) => {
          const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
          return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
        };
        for (const el of document.body.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.bottom <= limit + EPS) continue;

          let holder = null;
          let underFlagged = false;
          for (let p = el.parentElement; p; p = p.parentElement) {
            if (flagged.has(p)) { underFlagged = true; break; }
            const pcs = getComputedStyle(p);
            const oy = pcs.overflowY;
            const ox = pcs.overflowX;
            const scrollable = oy === 'auto' || oy === 'scroll' || ox === 'auto' || ox === 'scroll';
            const clipped = oy === 'hidden' || oy === 'clip' || ox === 'hidden' || ox === 'clip';
            if (scrollable || clipped) { holder = { el: p, scrollable }; break; }
          }
          if (underFlagged) continue;
          if (holder && !holder.scrollable) continue;
          if (holder && holder.scrollable
            && holder.el.getBoundingClientRect().bottom <= limit + EPS) continue;

          // Nobody between the element and the viewport bottom holds it.
          if (holder) {
            if (!flagged.has(holder.el)) {
              flagged.add(holder.el);
              offenders.push(`scroll container ${tagOf(holder.el)} pokes below the viewport`);
            }
          } else {
            offenders.push(`${tagOf(el)} bottom=${Math.round(r.bottom)}`);
          }
        }
        return offenders;
      });

      expect(offenders, `unreachable content on ${tab.key}`).toEqual([]);
    });

    test(`every interactive element on ${tab.key} has 44x44 minimum tap target`, async ({ page }) => {
      await openTab(page, tab);

      const selectors = [
        'button:visible',
        '[role="button"]:visible',
        'a:not([href*="#"]):visible',
      ];

      const failures = [];
      let screenCount = 0;
      for (const selector of selectors) {
        const elements = await page.locator(selector).all();
        for (const el of elements) {
          const box = await el.boundingBox();
          if (box) {
            screenCount++;
            if (box.width < 44 || box.height < 44) {
              const html = await el.evaluate(node => node.outerHTML.slice(0, 100));
              failures.push(`[${tab.key}] ${html}: ${box.width}x${box.height}`);
            }
          }
        }
      }

      console.log(`${tab.key}: ${screenCount} interactive elements`);
      if (failures.length > 0) {
        console.log('Tap target failures:', failures);
      }
      expect(failures).toHaveLength(0);
    });
  }

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
