import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('Policies', () => {
  test('policies page loads', async ({ page }) => {
    await page.goto('/policies');
    await waitForApp(page, '/policies');

    // Page heading should say "Policies"
    await expect(page.locator('h1').first()).toContainText('Policies', { timeout: 10_000 });

    // Should show a policy list, table, or empty state
    const content = page.locator('table').first()
      .or(page.getByText('No policies').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test('new policy page loads', async ({ page }) => {
    await page.goto('/policies/new');
    await waitForApp(page, '/policies/new');

    // Should show a form for creating a new policy
    const formOrHeading = page.locator('form').first()
      .or(page.locator('h1').first());
    await expect(formOrHeading).toBeVisible({ timeout: 10_000 });
  });

  test('configuration policies page loads', async ({ page }) => {
    await page.goto('/configuration-policies');
    await waitForApp(page, '/configuration-policies');

    // Page heading should say "Configuration Policies"
    await expect(page.locator('h1').first()).toContainText('Configuration Policies', { timeout: 10_000 });

    // Should show a list, table, or empty state
    const content = page.locator('table').first()
      .or(page.getByText('No policies').first())
      .or(page.getByText('No configuration').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });
});
