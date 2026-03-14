import { test, expect } from '@playwright/test';
import { waitForApp, waitForContentLoad } from './helpers';

test.describe('Alert Lifecycle', () => {
  test('alert rules page redirects to configuration policies', async ({ page }) => {
    await page.goto('/alerts/rules');
    await waitForApp(page);

    // /alerts/rules 301-redirects to /configuration-policies
    await expect(page).toHaveURL(/\/configuration-policies/, { timeout: 10_000 });

    await waitForContentLoad(page);

    // Heading should say "Configuration Policies" (alert rules were merged here)
    await expect(page.locator('h1').first()).toContainText(/Configuration Policies/i, { timeout: 10_000 });

    // Should see a table or an empty state message
    const listOrEmpty = page
      .locator('table')
      .or(page.locator('text=No policies'))
      .first();
    await expect(listOrEmpty).toBeVisible({ timeout: 15_000 });
  });

  test('create alert rule page redirects to configuration policies', async ({ page }) => {
    // /alerts/rules/new also redirects to /configuration-policies
    await page.goto('/alerts/rules/new');
    await waitForApp(page);

    await expect(page).toHaveURL(/\/configuration-policies/, { timeout: 10_000 });

    await waitForContentLoad(page);

    // Should land on configuration policies page
    await expect(page.locator('h1').first()).toContainText(/Configuration Policies/i, { timeout: 10_000 });
  });

  test('active alerts page loads', async ({ page }) => {
    await page.goto('/alerts');
    await waitForApp(page, '/alerts');
    await waitForContentLoad(page);

    // Heading should say "Alerts"
    await expect(page.locator('h1').first()).toContainText(/Alerts/i, { timeout: 10_000 });

    // Alert list or empty state
    const listOrEmpty = page
      .locator('table')
      .or(page.locator('text=No alerts'))
      .or(page.locator('text=No active alerts'))
      .first();
    await expect(listOrEmpty).toBeVisible({ timeout: 15_000 });
  });

  test.fixme('alert detail shows acknowledge and resolve actions', async ({ page }) => {
    await page.goto('/alerts');
    await waitForApp(page, '/alerts');
    await waitForContentLoad(page);

    // If there are active alerts, click the first one
    const firstAlert = page.locator('table tbody tr').first();
    const hasAlerts = await firstAlert.isVisible({ timeout: 5_000 }).catch(() => false);

    test.skip(!hasAlerts, 'No active alerts — skipping acknowledge/resolve test');

    await firstAlert.click();

    // Should show alert detail with action buttons
    await expect(page).toHaveURL(/\/alerts\/.+/);

    // Acknowledge and/or Resolve buttons should be present
    const actionBtn = page.locator(
      'button:has-text("Acknowledge"), button:has-text("Resolve"), button:has-text("Close")',
    ).first();
    await expect(actionBtn).toBeVisible({ timeout: 10_000 });
  });

  test('alert channels page loads', async ({ page }) => {
    await page.goto('/alerts/channels');
    await waitForApp(page, '/alerts/channels');
    await waitForContentLoad(page);

    // Heading should say "Notification Channels"
    await expect(page.locator('h1').first()).toContainText(/Notification Channels/i, { timeout: 10_000 });
  });
});
