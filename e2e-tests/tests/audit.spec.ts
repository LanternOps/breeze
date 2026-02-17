import { test, expect } from '@playwright/test';

test.describe('Audit Log', () => {
  test('audit page loads', async ({ page }) => {
    await page.goto('/audit');

    // Page heading should reference audit
    await expect(page.locator('h1, h2').first()).toContainText(/Audit/i, { timeout: 10_000 });

    // Should show an audit log table, list, or empty state
    const tableOrList = page.locator(
      'table, [data-testid="audit-log"], [data-testid="audit-list"], [data-testid="empty-state"], text=No audit',
    ).first()
      .or(page.locator('ul, ol, [role="list"]').first());
    await expect(tableOrList).toBeVisible({ timeout: 15_000 });
  });
});
