import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('Patch Management', () => {
  test('patches page loads', async ({ page }) => {
    await page.goto('/patches');
    await waitForApp(page, '/patches');

    await expect(page.locator('h1, h2').first()).toContainText(/Patch/i, { timeout: 10_000 });

    // Patch management page has tabs
    const content = page.locator('table').or(page.locator('text=No patches')).or(page.locator('[role="tablist"]'));
    await expect(content.first()).toBeVisible({ timeout: 15_000 });
  });
});
