import { test, expect } from '@playwright/test';
import { waitForApp, waitForContentLoad } from './helpers';

test.describe('Policies', () => {
  test.fixme('policies page loads', async ({ page }) => {
    await page.goto('/policies');
    await waitForApp(page, '/policies');
    await waitForContentLoad(page);

    // Page heading should say "Policies" (rendered after loading completes)
    await expect(page.locator('h1').first()).toContainText('Policies', { timeout: 10_000 });

    // Should show a policy list table or empty state
    // PolicyList empty state: "No policies found. Try adjusting your search or filters."
    const content = page.locator('table').first()
      .or(page.locator('text=No policies').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test.fixme('new policy page loads', async ({ page }) => {
    await page.goto('/policies/new');
    await waitForApp(page, '/policies/new');
    await waitForContentLoad(page);

    // PolicyEditPage renders h1 "Create Policy" and a PolicyForm with <form>
    const formOrHeading = page.locator('form').first()
      .or(page.locator('h1:has-text("Create Policy")').first());
    await expect(formOrHeading).toBeVisible({ timeout: 10_000 });
  });

  test.fixme('configuration policies page loads', async ({ page }) => {
    await page.goto('/configuration-policies');
    await waitForApp(page, '/configuration-policies');
    await waitForContentLoad(page);

    // Page heading should say "Configuration Policies"
    await expect(page.locator('h1').first()).toContainText('Configuration Policies', { timeout: 10_000 });

    // Should show a list table or empty state
    // ConfigPolicyList empty state: "No policies found. Try adjusting your search."
    const content = page.locator('table').first()
      .or(page.locator('text=No policies').first())
      .or(page.locator('text=No configuration').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });
});
