import { test, expect } from '@playwright/test';

test.describe('Patch Management', () => {
  test('patches page loads', async ({ page }) => {
    await page.goto('/patches');

    // Page heading should reference patches
    await expect(page.locator('h1, h2').first()).toContainText(/Patch/i, { timeout: 10_000 });

    // Should show a patch list, table, or empty state
    const content = page.locator(
      'table, [data-testid="patch-list"], [data-testid="empty-state"], text=No patches',
    ).first()
      .or(page.locator('ul, ol, [role="list"]').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });
});
