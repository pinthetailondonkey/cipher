import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { seedVault } from './fixtures.js';

// The UI contract (DESIGN.md, docs/DESIGN.md). Every Phase-1 rebuilt surface
// is held to the visual system of record here, in two halves:
//   1. source checks — tokens, type scale, no literal colours, no glass;
//   2. live checks — the Chats header and a dialog measured in the running app.
// Written against roles and computed styles, never against one screen's luck.

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const REBUILT = [
  'src/components/ui/Avatar.jsx',
  'src/components/ui/ListRow.jsx',
  'src/components/ui/Badge.jsx',
  'src/components/ui/Button.jsx',
  'src/components/ui/ScreenHeader.jsx',
  'src/components/ui/BottomBar.jsx',
  'src/components/ui/Sheet.jsx',
  'src/components/ui/Composer.jsx',
  'src/components/ui/Bubble.jsx',
  'src/components/ui/SystemCard.jsx',
  'src/components/ui/Rail.jsx',
];

// DESIGN.md's type scale. 10 is not on it; 11 is the floor.
const SCALE = [11, 12, 13, 14, 15, 16, 17, 20, 28];

test.describe('design tokens (source)', () => {
  const css = read('src/index.css');
  const token = (name) => {
    const hit = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
    return hit ? hit[1].trim().toLowerCase() : null;
  };

  test('the DESIGN.md palette is the palette', () => {
    expect(token('bg')).toBe('#000000');
    expect(token('bg-soft')).toBe('#05070a');
    expect(token('panel')).toBe('#0d1116');
    expect(token('panel-strong')).toBe('#12161d');
    expect(token('panel-alt')).toBe('#1b2028');
    expect(token('header')).toBe('#000000');
    expect(token('bubble-in')).toBe('#1f1f23');
    expect(token('bubble-out')).toBe('#005dfd');
    expect(token('accent')).toBe('#005dfd');
    expect(token('accent-text')).toBe('#7fb0ff');
    expect(token('accent-soft')).toBe('rgba(0, 93, 253, 0.16)');
  });

  test('no glass, no glow, no neon survives in the stylesheet', () => {
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).not.toMatch(/\.linear-glow/);
    expect(css).not.toMatch(/\.neon-/);
    expect(css).not.toMatch(/--glass-/);
    // The glow tokens may exist (other screens draw them inline), but only
    // as transparent.
    expect(token('glow-a')).toBe('transparent');
    expect(token('glow-b')).toBe('transparent');
  });

  test('focus-visible and reduced-motion floors are present', () => {
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  test('the system font stack is the product font', () => {
    const cfg = read('tailwind.config.cjs');
    const sans = cfg.match(/sans:\s*\[([^\]]+)\]/);
    expect(sans, 'tailwind sans stack').not.toBeNull();
    expect(sans[1]).toMatch(/system-ui/);
    expect(sans[1]).not.toMatch(/Inter/);
    for (const key of ['header', 'bubbleIn', 'bubbleOut']) {
      expect(cfg).toMatch(new RegExp(`${key}:\\s*'var\\(--`));
    }
  });
});

test.describe('rebuilt components follow the spec (source)', () => {
  for (const path of REBUILT) {
    test(`${path}: scale-only type, no literal colour, no glass`, () => {
      const src = read(path);
      for (const [, px] of src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        expect(SCALE, `${path} size ${px}`).toContain(Number(px));
      }
      expect(src, `${path} hex colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, `${path} glass`).not.toMatch(/backdrop-blur|backdrop-filter/);
      expect(src, `${path} arbitrary z`).not.toMatch(/z-\[/);
    });
  }

  test('no banned reveal label survives in a row', () => {
    // DESIGN.md, Never list: a hidden preview is a blurred line plus one
    // small eye icon; the labelled reveal pill is banned by name.
    // The row moved to ChatRow.jsx (a73f56d) and this pin went stale with
    // it: the eye moved, so the assertion kept reading a file that no longer
    // renders a row. The ban follows the row, and the screen that renders it
    // is held to it as well so neither file can carry the pill back.
    // The population is those two files and nothing else — a third row
    // renderer would sit outside the ban until someone adds it here, which is
    // the shape of an allow-list that only widens by hand.
    const row = read('src/components/chat/ChatRow.jsx');
    const screen = read('src/components/chat/ChatList.jsx');
    expect(row).not.toMatch(/Tap to show/);
    expect(screen).not.toMatch(/Tap to show/);
    expect(row).toMatch(/<Eye size=\{14\}/);
  });

  test('Avatar: 7 token gradients, charCodeAt(0) % 7', () => {
    const src = read('src/components/ui/Avatar.jsx');
    expect(src.match(/\['var\(--[^']+', 'var\(--[^']+'\]/g)).toHaveLength(7);
    expect(src).toMatch(/charCodeAt\(0\) % PAIRS\.length/);
    expect(src).toMatch(/h-\[52px\] w-\[52px\]/);
  });

  test('ListRow: 72px row, 52px lead, 76px inset divider', () => {
    const src = read('src/components/ui/ListRow.jsx');
    expect(src).toMatch(/min-h-\[72px\]/);
    expect(src).toMatch(/w-\[52px\]/);
    expect(src).toMatch(/left-\[76px\]/);
  });

  test('ScreenHeader: 56px, header ground, 20px title, 44px doors', () => {
    const src = read('src/components/ui/ScreenHeader.jsx');
    expect(src).toMatch(/min-h-\[56px\]/);
    expect(src).toMatch(/bg-header/);
    expect(src).toMatch(/text-\[20px\]/);
    expect(src).toMatch(/min-h-\[44px\] min-w-\[44px\]/);
  });

  test('Sheet: centred, max 420, radius 20 — never a bottom sheet', () => {
    const src = read('src/components/ui/Sheet.jsx');
    expect(src).toMatch(/items-center justify-center/);
    expect(src).toMatch(/max-w-\[420px\]/);
    expect(src).toMatch(/rounded-\[20px\]/);
    // The bottom-rising shell is gone for good (founder ruling 2026-10-29).
    expect(src).not.toMatch(/items-end|rounded-t-\[|translateY\(100%\)/);
  });

  test('Composer: floating pill, 16px field, 44px round controls', () => {
    const src = read('src/components/ui/Composer.jsx');
    expect(src).toMatch(/rounded-full/);
    expect(src).toMatch(/text-\[16px\]/);
    expect(src).toMatch(/h-11 w-11/);
    expect(src).toMatch(/from 'lucide-react'/);
  });

  test('Bubble: 78% wide, radius 18, 16px text, 11px time', () => {
    const src = read('src/components/ui/Bubble.jsx');
    expect(src).toMatch(/max-w-\[78%\]/);
    expect(src).toMatch(/rounded-\[18px\]/);
    expect(src).toMatch(/text-\[16px\]/);
    expect(src).toMatch(/text-\[11px\]/);
    expect(src).toMatch(/rounded-br-\[6px\]|rounded-bl-\[6px\]/);
  });

  test('SystemCard: the five-beat rail, in order', () => {
    const src = read('src/components/ui/SystemCard.jsx');
    expect(src).toMatch(/DEFAULT_BEATS = \['Placed', 'Address', 'Seen', 'Confirmed', 'Released'\]/);
    expect(src).toMatch(/border border-line bg-panel/);
  });
});

test.describe('live: Chats header', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
    await page.goto('/');
  });

  test('logo 28px + "Chats" at 20px, in a 56px header on the header ground', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Chats', exact: true });
    await expect(heading).toBeVisible({ timeout: 30000 });

    const logo = page.locator('header img[alt="Cipher Logo"], img[alt="Cipher Logo"]').first();
    if (await logo.count()) {
      const box = await logo.boundingBox();
      expect(Math.round(box.width)).toBe(28);
      expect(Math.round(box.height)).toBe(28);
      // 8px gap between the mark and the name.
      const hbox = await heading.boundingBox();
      expect(Math.round(hbox.x - (box.x + box.width))).toBe(8);
    }

    const size = await heading.evaluate((el) => getComputedStyle(el).fontSize);
    expect(size).toBe('20px');

    const band = heading.locator('xpath=ancestor::*[self::header or (self::div and contains(@class,"bg-header"))][1]');
    const bg = await band.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(0, 0, 0)');
    const h = await band.boundingBox();
    expect(Math.round(h.height)).toBeGreaterThanOrEqual(56);
  });

  test('bottom bar labels are 12px and every target is 44px', async ({ page }) => {
    const tabs = page.getByRole('navigation', { name: 'Tabs' });
    await expect(tabs).toBeVisible({ timeout: 30000 });
    const labels = tabs.locator('button > span:last-child');
    const sizes = await labels.evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize));
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBe('12px');
    const boxes = await tabs.locator('button').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    for (const b of boxes) expect(b).toBeGreaterThanOrEqual(44);
  });
});

test.describe('live: the founder ruling — dialogs sit in the middle', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
    await page.goto('/');
  });

  // The Burn-note sheet is a real Sheet-class surface reachable from Chats.
  // (Saved messages and Notifications are still full-screen panes on the old
  // shell, so they prove nothing about the ruling.)
  const openSheet = async (page) => {
    await page.getByRole('button', { name: 'Chat list menu' }).click();
    await page.getByRole('button', { name: 'Burn note', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    return dialog;
  };

  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    test(`centred at ${viewport.width}x${viewport.height}, max 420 wide, radius 20`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const dialog = await openSheet(page);
      const box = await dialog.boundingBox();
      const centre = box.y + box.height / 2;
      expect(Math.abs(centre - viewport.height / 2)).toBeLessThanOrEqual(4);
      expect(box.width).toBeLessThanOrEqual(420);
      // Centred, not glued to the bottom edge: the air above the panel and
      // below it are the same, and neither is zero. A tall panel legitimately
      // fills the screen — the ruling is about the middle, not about height.
      const above = box.y;
      const below = viewport.height - (box.y + box.height);
      expect(below).toBeGreaterThanOrEqual(4);
      expect(Math.abs(above - below)).toBeLessThanOrEqual(4);
      const radius = await dialog.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
      expect(radius).toBe('20px');
      const scrim = await dialog.locator('xpath=..').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(scrim).toBe('rgba(0, 0, 0, 0.6)');
    });
  }
});

test.describe('live: the md+ rail holds its own 72px', () => {
  // No node test can see where anything lands in the flex row. The panes used
  // to carry `md:left-[72px]`, compensation for a rail that was `fixed` and so
  // held none of the row; once those offsets came off, the rail had to be the
  // flex sibling §3.2 says it is, or `main` starts at x=0 and the strip is
  // drawn over it. The column itself was never under the strip: `--col` is
  // 30rem and it centred at x=452 before and x=400 after. The needle is the
  // wide viewport and the rail's own measured box; the control is a phone,
  // where the rail is not rendered at all — if the wide assertions could pass
  // on a tree with no rail, they measure nothing.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
    await page.goto('/');
  });

  // Both navs answer to "Tabs"; only the rail carries the 72px width, and
  // only one of the two is in the tree at a given width.
  const RAIL = 'nav[aria-label="Tabs"][class*="w-[72px]"]';

  test('at 1280x800 the rail is in the flow and the column starts beside it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const rail = page.locator(RAIL);
    await expect(rail).toBeVisible({ timeout: 30000 });

    const position = await rail.evaluate((el) => getComputedStyle(el).position);
    expect(['fixed', 'absolute'], 'the rail is out of the flex flow').not.toContain(position);

    const railBox = await rail.boundingBox();
    expect(Math.round(railBox.x)).toBe(0);
    expect(Math.round(railBox.width)).toBe(72);

    // main is the flex sibling the rail leaves behind: its left edge is the
    // rail's right edge. This is the assertion that discriminates — 0 against
    // 72 while the rail was fixed.
    const mainBox = await page.locator('main').boundingBox();
    expect(Math.round(mainBox.x)).toBe(Math.round(railBox.x + railBox.width));
    const columnBox = await page.locator('main > div.col-w').first().boundingBox();
    expect(columnBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width);
  });

  test('at 390x844 the control: no rail, and the column starts at 0', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(RAIL)).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible({ timeout: 30000 });
    const columnBox = await page.locator('main > div.col-w').first().boundingBox();
    expect(Math.round(columnBox.x)).toBe(0);
  });

  test('a sheet scrim paints over the rail, not under it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: 'Chat list menu' }).click();
    await page.getByRole('button', { name: 'Burn note', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15000 });

    // The sheet portals its overlay to document.body with `fixed inset-0
    // z-sheet`, and z-sheet is 60 against the rail's z-fab 40: a higher layer
    // in a different stacking context, so where the rail sits in the app's
    // DOM cannot lift it over the scrim. This asks the compositor rather than
    // trusting that reasoning, and prints the tag it hit if it ever reds.
    const hit = await page.evaluate((selector) => {
      const rail = document.querySelector(selector);
      const box = rail.getBoundingClientRect();
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { onRail: Boolean(at) && (at === rail || rail.contains(at)), tag: at ? at.tagName : null };
    }, RAIL);
    expect(hit.onRail, `the rail is the topmost element at its centre (${hit.tag})`).toBe(false);
  });
});
