import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

// P0: the installed iOS PWA showed a black band under the bottom bar, in
// standalone only.
//
// THE CAUSE (WebKit bug 313800, reproduced by its reporter on iPhone 16 Pro /
// iOS 26 and again on iOS 27 beta): a fresh home-screen install gets a layout
// viewport SHORTER than the physical screen by the status-bar inset —
// screen.height 874 vs visualViewport.height 812, delta 62 = the reported
// env(safe-area-inset-top). That band sits below every layout viewport, so no
// element can be placed onto it; only the canvas reaches it. The app was laid
// out correctly (the bar's bottom edge was already at window.innerHeight) and
// the band below it painted as html/body ground, i.e. a black gap the width of
// the status bar.
//
// The fix, standalone only and in two parts:
//   1. --strip is measured in main.jsx (screen.height minus the tallest
//      viewport seen) and drives the canvas to the bar's own ground, so the
//      band reads as the bar reaching the physical bottom.
//   2. --sab loses --strip, because that band already covers the home-indicator
//      zone; flooring the inset as well would lift the labels by both.
//
// This spec forces the platform geometry Chromium cannot: matchMedia reports
// standalone and screen.height is set taller than the viewport. Both are
// install-time constants here, exactly as they are on a device, so the arms
// below can shrink the viewport the way a keyboard does without the "screen"
// moving with it. It is simulation, not a device — see the report for the
// on-device procedure.
const SIZES = [
  { name: 'iPhone SE', w: 375, h: 667, sat: 20 },
  { name: 'iPhone 15', w: 393, h: 852, sat: 59 },
  { name: 'iPhone 15 Pro Max', w: 430, h: 932, sat: 59 },
  { name: 'iPhone 16 Pro Max', w: 440, h: 956, sat: 62 },
];

// The harness models the platform, not the app: standalone mode (matchMedia)
// and a screen taller than the viewport by the status-bar delta. Both are given
// rather than read from window, because addInitScript runs before the per-test
// viewport applies and innerHeight there is the harness default. screen.height
// is then fixed at install time, as a device's is, so the arms below can change
// the viewport (a keyboard, a rotation) without the screen moving with it. window.innerHeight
// is left alone: it is a non-configurable own property of window in Chromium and
// shadowing it broke the app, so the arms drive it with setViewportSize.
const harness = (height, delta) => `
  (() => {
    window.matchMedia = (q) => ({
      matches: /display-mode\\s*:\\s*standalone/.test(String(q)),
      media: String(q), onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    });
    const screenH = ${height + delta};
    Object.defineProperty(window.screen, 'height', { configurable: true, get: () => screenH });
  })()
`;

const resize = (page) => page.evaluate(() => window.dispatchEvent(new Event('resize')));

const read = (page) => page.evaluate(() => {
  const nav = [...document.querySelectorAll('nav[aria-label="Tabs"]')].find((n) => n.classList.contains('md:hidden'));
  if (!nav || !nav.firstElementChild) return null;
  const row = nav.firstElementChild.getBoundingClientRect();
  const cs = getComputedStyle(document.documentElement);
  return {
    strip: cs.getPropertyValue('--strip').trim(),
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    navPaddingBottom: getComputedStyle(nav).paddingBottom,
    rowBottom: Math.round(row.bottom),
    innerHeight: window.innerHeight,
    barGround: getComputedStyle(nav).backgroundColor,
  };
});

// The app mounts asynchronously; a fixed sleep raced it once (the bar was not
// there yet). Poll instead of sleeping.
const bar = async (page) => {
  await expect.poll(() => read(page), { timeout: 15000 }).not.toBeNull();
  return read(page);
};

const BAR_GROUND = 'rgb(18, 22, 29)'; // --panel-strong

for (const size of SIZES) {
  test.describe(`standalone strip — ${size.name}`, () => {
    test.use({ viewport: { width: size.w, height: size.h } });

    test('the strip below the viewport is measured, painted as the bar, and not double-padded', async ({ page }) => {
      await page.addInitScript(seedVault);
      await page.addInitScript(harness(size.h, size.sat));
      await page.goto('/');

      const m = await bar(page);
      expect(m.strip).toBe(`${size.sat}px`);

      // 1. The band is painted the bar's own ground, so there is no black gap.
      expect(m.barGround).toBe(BAR_GROUND);
      expect(m.htmlBg).toBe(BAR_GROUND);
      // The body stays black: it owns the viewport, the canvas owns the band.
      expect(m.bodyBg).toBe('rgb(0, 0, 0)');

      // 2. The band already covers the home-indicator zone, so the bar's own
      //    padding for that zone is reduced by the strip's height and no more.
      //    The label row therefore sits max(34, strip) above the PHYSICAL
      //    bottom: a 59px strip consumes the floor entirely (0 padding), a
      //    20px strip leaves 14px of it.
      const expectedPadding = Math.max(0, 34 - size.sat);
      expect(m.navPaddingBottom).toBe(`${expectedPadding}px`);
      expect(m.rowBottom).toBe(m.innerHeight - expectedPadding);
      expect(m.innerHeight - m.rowBottom + size.sat).toBe(Math.max(34, size.sat));
    });

    test('a browser tab measures no strip and is untouched', async ({ page }) => {
      await page.addInitScript(seedVault);
      // no harness: not standalone, so screen.height is left honest.
      await page.goto('/');

      const m = await bar(page);
      expect(m.strip).toBe('0px');
      expect(m.htmlBg).toBe('rgb(0, 0, 0)');
      // The un-floored env inset stays in charge in a browser tab: Chromium
      // reports it as 0, so the bar keeps its honest zero padding.
      expect(m.navPaddingBottom).toBe('0px');
    });
  });
}

test('the strip survives the software keyboard, because the screen does not move', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.addInitScript(seedVault);
  await page.addInitScript(harness(852, 59));
  await page.goto('/');

  expect((await bar(page)).strip).toBe('59px');

  // Type: `interactive-widget=resizes-content` shrinks the viewport by a
  // keyboard. Two things must hold. The strip must not grow (a naive
  // screen.height - innerHeight would read 59 + keyboard), AND the bar must not
  // jump: at a real keyboard height the viewport is narrower than it is tall is
  // false — 393 wide over a 320 keyboard — so a portrait test written against
  // the CURRENT innerHeight calls it landscape and drops the band mid-sentence.
  // That is why the height here goes below the width.
  await page.setViewportSize({ width: 393, height: 320 });
  await resize(page);
  const typed = await bar(page);
  expect(typed.strip).toBe('59px');
  expect(typed.navPaddingBottom).toBe('0px');

  // Keyboard closed: back to where it started, not drifting upward.
  await page.setViewportSize({ width: 393, height: 852 });
  await resize(page);
  expect((await bar(page)).strip).toBe('59px');
});

test('landscape falls back to the 34px floor instead of billing the viewport', async ({ page }) => {
  // iPhone SE geometry: 667x375 rotated stays under the md breakpoint, so the
  // bottom bar is still the thing being measured. (At 852px wide the bar is
  // correctly hidden and there would be nothing to assert.)
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(seedVault);
  await page.addInitScript(harness(667, 59));
  await page.goto('/');
  expect((await bar(page)).strip).toBe('59px');

  // Rotate. screen.height here deliberately does NOT rotate (the device that
  // makes this arm necessary is the one where it does not): a strip read
  // straight off screen.height - innerHeight would be 667 - 375 = 292px and
  // would eat the floor entirely.
  await page.setViewportSize({ width: 667, height: 375 });
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  await resize(page);

  const land = await bar(page);
  expect(land.strip).toBe('0px');
  expect(land.navPaddingBottom).toBe('34px');
  expect(land.innerHeight - land.rowBottom).toBe(34);

  // Back to portrait: the band is measured again, and the floor still applies.
  await page.setViewportSize({ width: 375, height: 667 });
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  await resize(page);
  const back = await bar(page);
  expect(back.strip).toBe('59px');
  expect(back.navPaddingBottom).toBe('0px');
});

test('a window-sized delta keeps the floor, because it is not an inset', async ({ page }) => {
  // A desktop PWA window or an iPad in Split View is simply smaller than the
  // display, so screen.height - innerHeight is a window size, not a band.
  // Pinning the floor away there would be a regression the fix introduced.
  await page.setViewportSize({ width: 393, height: 852 });
  await page.addInitScript(seedVault);
  await page.addInitScript(harness(852, 250));
  await page.goto('/');

  const m = await bar(page);
  expect(m.strip).toBe('0px');
  expect(m.navPaddingBottom).toBe('34px');
});

test('a standalone install with no strip keeps the 34px home-indicator floor', async ({ page }) => {
  // The honest case: standalone but edge-to-edge, no letterbox. The floor must
  // still apply exactly as it did before this change.
  await page.setViewportSize({ width: 393, height: 852 });
  await page.addInitScript(seedVault);
  await page.addInitScript(harness(852, 0));
  await page.goto('/');

  const m = await bar(page);
  expect(m.strip).toBe('0px');
  expect(m.navPaddingBottom).toBe('34px');
  expect(m.rowBottom).toBe(m.innerHeight - 34);
});
