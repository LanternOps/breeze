// e2e-tests/playwright/tests/dashboard-comprehensive.spec.ts
import { test, expect } from '../fixtures';
import { DashboardComprehensivePage } from '../pages/DashboardComprehensivePage';

test.describe('Dashboard Comprehensive Smoke Test', () => {
  test('dashboard heading renders after login', async ({ authedPage }) => {
    const page = new DashboardComprehensivePage(authedPage);
    await page.goto();
    await expect(page.welcomeHeading()).toContainText('Welcome');
  });

  test('all four stat cards are visible', async ({ authedPage }) => {
    const page = new DashboardComprehensivePage(authedPage);
    await page.goto();
    await expect(page.totalDevicesCard()).toBeVisible();
    await expect(page.onlineCard()).toBeVisible();
    await expect(page.warningsCard()).toBeVisible();
    await expect(page.criticalCard()).toBeVisible();
  });

  test('dashboard panels are visible', async ({ authedPage }) => {
    const page = new DashboardComprehensivePage(authedPage);
    await page.goto();
    await expect(page.deviceStatusPanel()).toBeVisible();
    await expect(page.recentAlertsPanel()).toBeVisible();
    await expect(page.recentActivityPanel()).toBeVisible();
  });

  test('sidebar navigation links are present', async ({ authedPage }) => {
    const page = new DashboardComprehensivePage(authedPage);
    await page.goto();
    await expect(page.dashboardNavLink()).toBeVisible();
    await expect(page.devicesNavLink()).toBeVisible();
    await expect(page.scriptsNavLink()).toBeVisible();
    await expect(page.alertsNavLink()).toBeVisible();
    await expect(page.remoteAccessNavLink()).toBeVisible();
  });

  test('devices roundtrip navigation works', async ({ authedPage }) => {
    const page = new DashboardComprehensivePage(authedPage);
    await page.goto();
    await page.devicesNavLink().click();
    await expect(authedPage.getByText('Devices')).toBeVisible({ timeout: 10000 });
    await page.dashboardNavLink().click();
    await expect(page.welcomeHeading()).toBeVisible({ timeout: 10000 });
  });

  test('command palette opens and closes with Escape', async ({ authedPage }) => {
    const page = new DashboardComprehensivePage(authedPage);
    await page.goto();
    await expect(page.commandPaletteButton()).toBeVisible({ timeout: 10000 });
    await page.commandPaletteButton().click();
    await expect(page.commandPaletteDialog()).toBeVisible({ timeout: 5000 });
    await authedPage.keyboard.press('Escape');
    await expect(page.commandPaletteDialog()).toBeHidden({ timeout: 5000 });
  });

  test('user menu shows profile, settings, and sign out options', async ({ authedPage }) => {
    const page = new DashboardComprehensivePage(authedPage);
    await page.goto();
    // Click the aria-haspopup button (user/account menu)
    await authedPage.locator('[aria-haspopup="true"]').first().click();
    await expect(authedPage.getByRole('link', { name: 'Profile' })).toBeVisible({ timeout: 5000 });
    await expect(authedPage.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await authedPage.keyboard.press('Escape');
  });

  test('dark mode toggle is present', async ({ authedPage }) => {
    const page = new DashboardComprehensivePage(authedPage);
    await page.goto();
    await expect(page.darkModeToggle()).toBeVisible();
    await page.darkModeToggle().click();
    // Toggle again to restore state
    await page.darkModeToggle().click();
  });

  // Uses cleanPage so the logout doesn't poison the worker-scoped authedPage
  // for subsequent tests in this worker.
  test('sign out redirects to login page', async ({ cleanPage }) => {
    await cleanPage.goto('/login');
    await cleanPage.locator('#email').fill(process.env.E2E_ADMIN_EMAIL!);
    await cleanPage.locator('#password').fill(process.env.E2E_ADMIN_PASSWORD!);
    await cleanPage.locator('button[type="submit"]').click();
    await cleanPage.waitForURL('/', { timeout: 15_000 });

    await cleanPage.locator('[aria-haspopup="true"]').first().click();
    await cleanPage.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 5000 });
    await cleanPage.getByRole('button', { name: 'Sign out' }).click();
    await cleanPage.waitForURL('**/login**', { timeout: 10000 });
    expect(cleanPage.url()).toContain('/login');
  });
});
