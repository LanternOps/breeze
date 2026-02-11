import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test('dashboard loads with key stats', async ({ page }) => {
    await page.goto('/');

    // The page title / heading should contain "Dashboard"
    await expect(page.locator('h1')).toContainText('Dashboard');

    // Expect the DashboardStats component to render
    // It should display device count and alert summary widgets
    await expect(
      page.locator('[data-testid="stat-devices"]').or(page.locator('text=Devices')).or(page.locator('text=Total Devices')).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Expect the RecentAlerts section to render
    await expect(
      page.locator('[data-testid="recent-alerts"]').or(page.locator('text=Alerts')).or(page.locator('text=Recent Alerts')).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('navigation to devices page works', async ({ page }) => {
    await page.goto('/');

    // Click on the Devices link in the sidebar or nav
    const devicesLink = page.locator(
      'a[href="/devices"], nav a:has-text("Devices"), [data-testid="nav-devices"]',
    ).first();
    await devicesLink.click();

    await expect(page).toHaveURL(/\/devices/);
    await expect(page.locator('h1, h2').first()).toContainText(/Device/i);
  });

  test('navigation to scripts page works', async ({ page }) => {
    await page.goto('/');

    // Click on the Scripts link in the sidebar or nav
    const scriptsLink = page.locator(
      'a[href="/scripts"], nav a:has-text("Scripts"), [data-testid="nav-scripts"]',
    ).first();
    await scriptsLink.click();

    await expect(page).toHaveURL(/\/scripts/);
    await expect(page.locator('h1, h2').first()).toContainText(/Script/i);
  });
});
