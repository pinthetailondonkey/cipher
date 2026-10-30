import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

// Witness for the live modal-typing bug (2026-10-30): a Sheet's close
// callback reached the focus hook as a fresh inline identity on every render,
// so the first keystroke's re-render re-focused the panel, ripping focus off
// the field — one character, then the keyboard was gone. The fix keeps the
// callback in a ref (src/components/ui/modal.js). This spec types TWO
// characters into real modal fields and asserts both characters land AND
// focus is still on the field: the exact user report, at the field.
test.describe('typing in modals', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
    await page.goto('/');
    // The app boots past the lock screen into the shell; one reload guards
    // against a cold boot that paints nothing (session restore races).
    const shellButton = page.getByRole('button', { name: 'Chat list menu' }).first();
    await expect(shellButton).toBeVisible({ timeout: 15000 }).catch(async () => {
      await page.reload();
      await expect(shellButton).toBeVisible({ timeout: 15000 });
    });
  });

  const focusedFieldStillHoldsFocus = async (field) => {
    const stillFocused = await field.evaluate((el) => document.activeElement === el);
    expect(stillFocused, 'focus must still sit on the field after typing').toBe(true);
  };

  test('burn note sheet: two characters land and focus stays on the field', async ({ page }) => {
    await page.getByRole('button', { name: 'Chat list menu' }).click();
    await page.getByRole('button', { name: 'Burn note' }).click();
    const dialog = page.getByRole('dialog', { name: 'Burn note' });
    await expect(dialog).toBeVisible();
    const field = dialog.locator('textarea, input').first();
    await field.click();
    // The delay is the point: the re-render after the first character is
    // what used to steal focus, so the second character must arrive after it.
    await field.pressSequentially('ab', { delay: 250 });
    await expect(field).toHaveValue('ab');
    await focusedFieldStillHoldsFocus(field);
  });

  test('create-space modal: two characters land and focus stays on the field', async ({ page }) => {
    await page.getByRole('button', { name: 'Chat list menu' }).click();
    await page.getByRole('button', { name: 'New group' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a space' });
    await expect(dialog).toBeVisible();
    const field = dialog.locator('input').first();
    await field.click();
    await field.pressSequentially('ab', { delay: 250 });
    await expect(field).toHaveValue('ab');
    await focusedFieldStillHoldsFocus(field);
  });
});
