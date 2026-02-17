import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('Dashboard', () => {
  test('dashboard loads with key stats', async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);

    await expect(page.locator('h1')).toContainText('Dashboard');

    // Wait for React components to hydrate and render stats
    const statsContent = page.locator('text=Devices')
      .or(page.locator('text=Total Devices'))
      .or(page.locator('text=Alerts'));
    await expect(statsContent.first()).toBeVisible({ timeout: 15_000 });
  });

  test('navigation to devices page works', async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);

    // Click Devices in the sidebar navigation
    const devicesLink = page.locator('aside a[href="/devices"]')
      .or(page.locator('aside >> text=Devices'))
      .first();
    await devicesLink.click({ timeout: 10_000 });

    await expect(page).toHaveURL(/\/devices/, { timeout: 10_000 });
    await expect(page.locator('h1').first()).toContainText(/Device/i, { timeout: 15_000 });
  });

  test('navigation to scripts page works', async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);

    const scriptsLink = page.locator('aside a[href="/scripts"]')
      .or(page.locator('aside >> text=Scripts'))
      .first();
    await scriptsLink.click({ timeout: 10_000 });

    await expect(page).toHaveURL(/\/scripts/, { timeout: 10_000 });
    await expect(page.locator('h1').first()).toContainText(/Script/i, { timeout: 15_000 });
  });
});
