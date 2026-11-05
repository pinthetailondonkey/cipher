import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

// Command palette a11y + behavior (master §2 → §14 PR3): ⌘K opens at md+,
// the field filters as it types, arrow keys walk the matches, Enter
// activates, Escape closes and focus goes home. The palette is md+ only, so
// this spec wears a desktop viewport regardless of the project's phone.
test.use({ viewport: { width: 1440, height: 900 } });

test.describe('Command palette', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
    await page.goto('/');
    // The rail is the shell's md+ signature; its presence means the boot
    // got past the lock screen and the shortcuts are live.
    const rail = page.getByRole('navigation', { name: 'Tabs' });
    await expect(rail).toBeVisible({ timeout: 15000 }).catch(async () => {
      await page.reload();
      await expect(rail).toBeVisible({ timeout: 15000 });
    });
  });

  test('Ctrl+K opens the palette and the field takes focus', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Jump to' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByRole('textbox')).toBeFocused();
  });

  test('the two shell destinations are listed without any input', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const list = page.getByRole('listbox', { name: /Jump/i });
    await expect(list.getByRole('option', { name: 'Threads' })).toBeVisible();
    await expect(list.getByRole('option', { name: 'You' })).toBeVisible();
    // Menus and Orders are not destinations any more: Menus is a Threads
    // segment and Orders lives behind You, so neither is a palette screen.
    await expect(list.getByRole('option', { name: 'Menus' })).toHaveCount(0);
    await expect(list.getByRole('option', { name: 'Orders' })).toHaveCount(0);
  });

  test('filtering narrows to the matching row', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const field = page.getByRole('dialog', { name: 'Jump to' }).getByRole('textbox');
    await field.fill('you');
    const list = page.getByRole('listbox', { name: /Jump/i });
    await expect(list.getByRole('option')).toHaveCount(1);
    await expect(list.getByRole('option', { name: 'You' })).toBeVisible();
    await field.fill('zz');
    await expect(page.getByText('Nothing matches that.')).toBeVisible();
  });

  test('arrow keys walk and Enter activates the highlighted destination', async ({ page }) => {
    // Stand on You first so the activation is observable.
    await page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'You' }).click();
    await page.keyboard.press('Control+k');
    const list = page.getByRole('listbox', { name: /Jump/i });
    const threads = list.getByRole('option', { name: 'Threads' });
    const you = list.getByRole('option', { name: 'You' });

    // The walk starts at the top: Threads highlighted.
    await expect(threads).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(you).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(threads).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Jump to' });
    await expect(dialog).toBeHidden({ timeout: 5000 });
    await expect(page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'Threads' })).toHaveAttribute('aria-current', 'page');
  });

  test('Escape closes and focus is not lost', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Jump to' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 5000 });
    const focusAlive = await page.evaluate(() => {
      const el = document.activeElement;
      return el === document.body || (el instanceof HTMLElement && el.matches('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'));
    });
    expect(focusAlive).toBeTruthy();
  });

  test('Ctrl+K toggles the palette closed again', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Jump to' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(dialog).toBeHidden({ timeout: 5000 });
  });
});
