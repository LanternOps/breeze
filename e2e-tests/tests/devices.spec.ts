import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('Device Management', () => {
  test('device list page loads', async ({ page }) => {
    await page.goto('/devices');
    await waitForApp(page, '/devices');

    // Page heading should reference devices
    await expect(page.locator('h1, h2').first()).toContainText(/Device/i);

    // The page should have some kind of list/table or empty state
    const listOrEmpty = page.locator('table')
      .or(page.locator('text=No devices'))
      .first();
    await expect(listOrEmpty).toBeVisible({ timeout: 15_000 });
  });

  test('device list shows enrolled devices or empty state', async ({ page }) => {
    await page.goto('/devices');
    await waitForApp(page, '/devices');

    // Either we see table rows for devices, or an empty-state message
    const deviceRow = page.locator('table tbody tr').first();
    const emptyState = page.locator('text=No devices found')
      .or(page.locator('text=No devices'))
      .or(page.locator('text=Get started'))
      .first();

    // One of these should be visible
    await expect(
      deviceRow.or(emptyState),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('device detail page shows tabs', async ({ page }) => {
    await page.goto('/devices');
    await waitForApp(page, '/devices');

    // If there are devices, click the first one to go to detail view
    const firstDevice = page.locator('table tbody tr').first();
    const hasDevices = await firstDevice.isVisible({ timeout: 5_000 }).catch(() => false);

    test.skip(!hasDevices, 'No devices enrolled — skipping detail view test');

    await firstDevice.click();

    // Should navigate to a device detail page
    await expect(page).toHaveURL(/\/devices\/.+/);

    // Detail page should show tab navigation (Overview, Hardware, Software, etc.)
    const tabs = page.locator('[role="tablist"]')
      .or(page.locator('nav:has(button:has-text("Overview"))'))
      .first();
    await expect(tabs).toBeVisible({ timeout: 10_000 });

    // At minimum, an "Overview" tab should exist
    await expect(
      page.locator('button:has-text("Overview")')
        .or(page.locator('[role="tab"]:has-text("Overview")'))
        .or(page.locator('a:has-text("Overview")'))
        .first(),
    ).toBeVisible();
  });

  test('device filtering works', async ({ page }) => {
    await page.goto('/devices');
    await waitForApp(page, '/devices');

    // Look for a search / filter input
    const searchInput = page.locator(
      'input[placeholder*="Search"], input[placeholder*="Filter"]',
    ).first();

    const hasSearch = await searchInput.isVisible({ timeout: 5_000 }).catch(() => false);
    test.skip(!hasSearch, 'No search input found — skipping filter test');

    // Type a filter query
    await searchInput.fill('nonexistent-device-xyz');

    // Should show no results or an empty state
    await expect(
      page.locator('text=No devices found')
        .or(page.locator('text=No results'))
        .or(page.locator('text=0 devices'))
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    // Clear the filter
    await searchInput.clear();
  });

  test('device groups page loads', async ({ page }) => {
    await page.goto('/devices/groups');
    await waitForApp(page, '/devices/groups');

    // Should show group management UI
    await expect(
      page.locator('h1, h2').first(),
    ).toContainText(/Group|Device/i, { timeout: 10_000 });

    // Should have a create button or existing groups list or empty state
    const createOrList = page.locator('button:has-text("New")')
      .or(page.locator('button:has-text("Create")'))
      .or(page.locator('table'))
      .or(page.locator('text=No device groups yet'))
      .or(page.locator('text=No groups'))
      .first();
    await expect(createOrList).toBeVisible({ timeout: 10_000 });
  });
});
