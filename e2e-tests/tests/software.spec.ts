import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('Software', () => {
  test('software page loads', async ({ page }) => {
    await page.goto('/software');
    await waitForApp(page, '/software');

    await expect(page.locator('h1, h2').first()).toContainText(/Software/i, { timeout: 10_000 });

    // Software catalog uses a grid, not a table
    const content = page.locator('h1:has-text("Software")').or(page.locator('text=No software'));
    await expect(content.first()).toBeVisible({ timeout: 15_000 });
  });
});
