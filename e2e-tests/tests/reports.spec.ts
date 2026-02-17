import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('Reports', () => {
  test('reports page loads', async ({ page }) => {
    await page.goto('/reports');
    await waitForApp(page, '/reports');

    // Page heading should say "Reports"
    await expect(page.locator('h1').first()).toContainText('Reports', { timeout: 10_000 });

    // Should show a report list, table, or empty state
    const content = page.locator('table').first()
      .or(page.getByText('No reports').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test('new report page loads', async ({ page }) => {
    await page.goto('/reports/new');
    await waitForApp(page, '/reports/new');

    // Should show a heading for creating a new report
    const headingOrForm = page.locator('h1').first()
      .or(page.locator('form').first());
    await expect(headingOrForm).toBeVisible({ timeout: 10_000 });

    // Verify the heading text
    await expect(page.locator('h1').first()).toContainText('Create Report');
  });
});
