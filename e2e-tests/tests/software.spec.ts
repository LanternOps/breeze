import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('Software', () => {
  test('software page loads', async ({ page }) => {
    await page.goto('/software');
    await waitForApp(page, '/software');

    // Page heading should reference software
    await expect(page.locator('h1, h2').first()).toContainText(/Software/i, { timeout: 10_000 });

    // Should show a software inventory table, list, or empty state
    const content = page.locator(
      'table, [data-testid="software-list"], [data-testid="empty-state"], text=No software',
    ).first()
      .or(page.locator('ul, ol, [role="list"]').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });
});
