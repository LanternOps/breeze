import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('Audit Log', () => {
  test('audit page loads', async ({ page }) => {
    await page.goto('/audit');
    await waitForApp(page, '/audit');

    await expect(page.locator('h1, h2').first()).toContainText(/Audit/i, { timeout: 10_000 });

    const content = page.locator('table').or(page.locator('text=No audit'));
    await expect(content.first()).toBeVisible({ timeout: 15_000 });
  });
});
