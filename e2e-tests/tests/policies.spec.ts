import { test, expect } from '@playwright/test';

test.describe('Policies', () => {
  test('policies page loads', async ({ page }) => {
    await page.goto('/policies');

    // Page heading should reference policies
    await expect(page.locator('h1, h2').first()).toContainText(/Polic/i, { timeout: 10_000 });

    // Should show a policy list, table, or empty state
    const content = page.locator(
      'table, [data-testid="policy-list"], [data-testid="empty-state"], text=No policies',
    ).first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test('new policy page loads', async ({ page }) => {
    await page.goto('/policies/new');

    // Should show a form or heading for creating a new policy
    const formOrHeading = page.locator('form, [data-testid="policy-form"], h1, h2').first();
    await expect(formOrHeading).toBeVisible({ timeout: 10_000 });
  });

  test('configuration policies page loads', async ({ page }) => {
    await page.goto('/configuration-policies');

    // Page heading should reference configuration or policies
    await expect(page.locator('h1, h2').first()).toContainText(/Config|Polic/i, { timeout: 10_000 });

    // Should show a list, table, or empty state
    const content = page.locator(
      'table, [data-testid="config-policy-list"], [data-testid="empty-state"], text=No policies, text=No configuration',
    ).first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });
});
