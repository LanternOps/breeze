import { test, expect } from '@playwright/test';

test.describe('Alert Lifecycle', () => {
  test('alert rules page loads', async ({ page }) => {
    await page.goto('/alerts/rules');

    // Heading should reference alerts or rules
    await expect(page.locator('h1, h2').first()).toContainText(/Alert|Rule/i, { timeout: 10_000 });

    // Should see a list or empty state
    const listOrEmpty = page.locator(
      'table, [data-testid="rules-list"], text=No rules, [data-testid="empty-state"], text=No alert rules',
    ).first();
    await expect(listOrEmpty).toBeVisible({ timeout: 15_000 });
  });

  test('create alert rule page loads', async ({ page }) => {
    await page.goto('/alerts/rules');

    const newBtn = page.locator(
      'a[href="/alerts/rules/new"], button:has-text("New Rule"), button:has-text("Create"), a:has-text("New Rule")',
    ).first();

    const hasBtn = await newBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasBtn) {
      await newBtn.click();
    } else {
      await page.goto('/alerts/rules/new');
    }

    await expect(page).toHaveURL(/\/alerts\/rules\/new/);

    // Should show form for creating a rule
    const form = page.locator('form, [data-testid="rule-form"], [name="name"]').first();
    await expect(form).toBeVisible({ timeout: 10_000 });
  });

  test('active alerts page loads', async ({ page }) => {
    await page.goto('/alerts');

    await expect(page.locator('h1, h2').first()).toContainText(/Alert/i, { timeout: 10_000 });

    // Alert list or empty state
    const listOrEmpty = page.locator(
      'table, [data-testid="alerts-list"], text=No alerts, [data-testid="empty-state"], text=No active alerts',
    ).first();
    await expect(listOrEmpty).toBeVisible({ timeout: 15_000 });
  });

  test('alert detail shows acknowledge and resolve actions', async ({ page }) => {
    await page.goto('/alerts');

    // If there are active alerts, click the first one
    const firstAlert = page.locator('table tbody tr, [data-testid="alert-row"]').first();
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

    // Should show notification channels configuration
    await expect(page.locator('h1, h2').first()).toContainText(/Channel|Notification|Alert/i, { timeout: 10_000 });
  });
});
