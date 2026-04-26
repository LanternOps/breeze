// e2e-tests/playwright/tests/dashboard.spec.ts
import { test, expect } from '../fixtures';
import { DashboardPage } from '../pages/DashboardPage';

test.describe('Dashboard', () => {
  test('loads with welcome heading and stat cards', async ({ authedPage }) => {
    const dashboard = new DashboardPage(authedPage);
    await dashboard.goto();
    await expect(dashboard.heading()).toContainText('Welcome');
    await expect(dashboard.totalDevicesCard()).toBeVisible();
    await expect(dashboard.onlineCard()).toBeVisible();
  });

  test('shows recent alerts and activity panels', async ({ authedPage }) => {
    const dashboard = new DashboardPage(authedPage);
    await dashboard.goto();
    await expect(dashboard.recentAlertsPanel()).toBeVisible();
    await expect(dashboard.recentActivityPanel()).toBeVisible();
  });
});
