import { test, expect } from '@playwright/test';

test.describe('Reports', () => {
  test('reports page loads', async ({ page }) => {
    await page.goto('/reports');

    // Page heading should reference reports
    await expect(page.locator('h1, h2').first()).toContainText(/Report/i, { timeout: 10_000 });

    // Should show a report list, table, or empty state
    const content = page.locator(
      'table, [data-testid="report-list"], [data-testid="empty-state"], text=No reports',
    ).first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test('new report page loads', async ({ page }) => {
    await page.goto('/reports/new');

    // Should show a heading or form for creating a new report
    const headingOrForm = page.locator('h1, h2').first()
      .or(page.locator('form, [data-testid="report-form"]').first());
    await expect(headingOrForm).toBeVisible({ timeout: 10_000 });
  });
});
