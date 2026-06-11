import { test, expect } from '../fixtures';
import { DashboardPage } from '../pages/DashboardPage';

test.describe('Dashboard', () => {
  test('loads with heading and four stat cards', async ({ authedPage }) => {
    const dashboard = new DashboardPage(authedPage);
    await dashboard.goto();
    await expect(dashboard.heading()).toBeVisible();
    await expect(dashboard.stats()).toBeVisible();
    await expect(dashboard.totalDevicesCard()).toBeVisible();
    await expect(dashboard.onlineCard()).toBeVisible();
    await expect(dashboard.warningsCard()).toBeVisible();
    await expect(dashboard.criticalCard()).toBeVisible();
  });

  test('shows recent alerts and activity panels', async ({ authedPage }) => {
    const dashboard = new DashboardPage(authedPage);
    await dashboard.goto();
    await expect(dashboard.recentAlertsHeading()).toBeVisible();
    await expect(dashboard.recentActivityHeading()).toBeVisible();
  });
});
