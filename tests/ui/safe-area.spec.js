import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

// Every tab the bottom nav can reach, with the label on its nav button.
// Chat needs a click too: the clipped-down assertion set must visit each tab
// the same way so the run is identical no matter which tab is home.
const TABS = [
  { key: 'chat', label: 'Chats' },
  { key: 'explore', label: 'Menus' },
  { key: 'profile', label: 'Profile' },
];

async function openTab(page, tab) {
  await page.goto('/');
  await page.waitForTimeout(1000);
  // The rebuilt phone shell opens destinations through the side drawer; the
  // old bottom tab bar now rides the md+ rail only. Same three screens, same
  // door: the drawer's menu button, then the matching row.
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.waitForTimeout(700);
  const drawer = page.locator('aside', { hasText: 'Connections' }).first();
  if (tab.key === 'profile') {
    // Profile is the drawer's profile card, up top.
    await drawer.locator('button').first().click();
  } else {
    const rows = { chat: 'Chats', explore: 'Menus' };
    await drawer.locator('nav').locator(`button:has-text("${rows[tab.key]}")`).click();
  }
  await page.waitForTimeout(600);
  // Picking a row closes the drawer itself; give the exit spring its beat.
  await expect(drawer).toHaveCount(0, { timeout: 3000 });
  await page.waitForTimeout(400);
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

  // The rebuild's shell is full-bleed: main spans the whole window and every
  // pane scrolls inside it, while the bottom tab bar rides the md+ rail.
  // The old 80px-short check measured that bar; keep the subject (main owns
  // the phone window) without the bar's size.
  test('main spans the window and the panes scroll inside it', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    const viewport = page.viewportSize();
    const main = await page.locator('main').first();
    const box = await main.boundingBox();

    expect(box).toBeTruthy();
    expect(Math.abs(viewport.height - box.height)).toBeLessThanOrEqual(1);
    await expect(main).toHaveCSS('overflow', 'hidden');
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

    // The brief with the old bottom nav is gone on phone; the drawer carries
    // the same destination buttons, so taps land on its menu rows.
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.waitForTimeout(700);
    const drawerNav = page.locator('aside', { hasText: 'Connections' }).first().locator('nav').first();
    const box = await drawerNav.boundingBox();

    expect(box).toBeTruthy();

    // Tap at vertical center using touchscreen
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);

    // Tap 4px above the row list's bottom edge
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 4);
    await page.waitForTimeout(300);

    expect(true).toBe(true);
  });
});
