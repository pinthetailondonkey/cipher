import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

// Item 1 of the native-feel brief: in the installed home-screen PWA
// (display-mode: standalone) the app chrome must not grab a text-selection,
// while text fields stay copyable. The browser build must be unchanged.
//
// Chromium cannot emulate `display-mode: standalone` (Playwright's
// emulateMedia has no displayMode), and overriding window.matchMedia only
// affects page JS, not CSS @media evaluation. So this spec proves what IS
// measurable in headless Chromium and matters:
//
//   (a) CONTROL — the browser (non-standalone) build leaves chrome fully
//       selectable. If this ever turns red the standalone work leaked into
//       the browser build.
//   (b) RULE BEHAVIOUR — the exact standalone rules, applied as if the media
//       query matched, make chrome user-select:none and the filter textbox
//       stay selectable. This measures the substance of the fix; whether the
//       media query matches on a real iPhone is confirmed on-device by the
//       founder because no headless Chromium can force standalone mode.
//
// The seeded app loads to the chat list: the chrome is the bottom tab bar
// (navigation "Tabs") and its buttons; the editable surface is the "Filter
// chats" textbox. Those are what we assert on.

const PHONE_SIZES = [
  { name: 'SE', width: 375, height: 667 },
  { name: 'iPhone 15', width: 393, height: 852 },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932 },
  { name: 'iPhone 16 Pro Max', width: 440, height: 956 },
];

// The exact declarations inside the src/index.css `@media (display-mode:
// standalone)` block, injected verbatim so the rules behave as they would if
// the installed app matched the query. These MUST track src/index.css.
const STANDALONE_RULES = `nav[aria-label="Tabs"],nav[aria-label="Tabs"] *,header,header *,button,[role="button"],[role="menuitem"],.menu-item,.chip,[data-chrome],[data-chrome] *{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.message-body,.message-body *,input,textarea,[contenteditable="true"],[contenteditable=""]{-webkit-user-select:text;user-select:text}`;

for (const size of PHONE_SIZES) {
  test.describe(`standalone selection — ${size.name} (${size.width}x${size.height})`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(seedVault);
      await page.goto('/');
      await page.waitForTimeout(1200);
    });

    test('CONTROL: the browser build leaves chrome selectable (nothing leaked)', async ({ page }) => {
      const nav = page.getByRole('navigation', { name: 'Tabs' });
      await expect(nav).toBeVisible();
      const navSelect = await nav.evaluate((el) => getComputedStyle(el).userSelect);
      const btnSelect = await nav.getByRole('button', { name: 'Chats' }).evaluate((el) => getComputedStyle(el).userSelect);
      expect(navSelect).toBe('auto');
      expect(btnSelect).toBe('auto');
    });

    test('standalone rules: chrome is not selectable, the text field stays selectable', async ({ page }) => {
      const nav = page.getByRole('navigation', { name: 'Tabs' });
      const filter = page.getByRole('textbox', { name: 'Filter chats' });
      await expect(nav).toBeVisible();
      await expect(filter).toBeVisible();

      // Apply the standalone rules as the media-query block would.
      await page.addStyleTag({ content: STANDALONE_RULES });

      const navSelect = await nav.evaluate((el) => getComputedStyle(el).userSelect);
      expect(navSelect).toBe('none');
      const btnSelect = await nav.getByRole('button', { name: 'Chats' }).evaluate((el) => getComputedStyle(el).userSelect);
      expect(btnSelect).toBe('none');
      // Item 2: iOS long-press link callout is off on chrome too.
      const navCallout = await nav.evaluate((el) => getComputedStyle(el).webkitTouchCallout);
      expect(navCallout).toBe('none');
      const filterSelect = await filter.evaluate((el) => getComputedStyle(el).userSelect);
      expect(filterSelect).toBe('text');
    });
  });
}

// Prove the media query is genuinely scoped: the browser CSS (parsed from the
// live stylesheets) must not contain a top-level user-select:none on chrome.
test('the live stylesheet keeps user-select:none inside the standalone media query only', async ({ page }) => {
  await page.addInitScript(seedVault);
  await page.goto('/');
  await page.waitForTimeout(1200);
  const leaked = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules || [])) {
        // A top-level (non-media) style rule that would disable selection on
        // the tab bar. Inside a media rule, cssRules entries are CSSMediaRule
        // with a nested cssRules list, so a direct STYLE_RULE here means leak.
        if (rule.type === CSSRule.STYLE_RULE && rule.cssText.includes('user-select:none')) {
          return rule.cssText.slice(0, 80);
        }
      }
    }
    return null;
  });
  expect(leaked).toBeNull();
});