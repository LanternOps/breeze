import { test, expect } from '@playwright/test';
import { waitForApp, waitForContentLoad } from './helpers';

test.describe('Device Management', () => {
  test('device list page loads', async ({ page }) => {
    await page.goto('/devices');
    await waitForApp(page, '/devices');
    await waitForContentLoad(page);

    // Page heading should reference devices
    await expect(page.locator('h1, h2').first()).toContainText(/Device/i);

    // The page should have some kind of list/table or empty state
    const listOrEmpty = page.locator('table')
      .or(page.locator('text=No devices'))
      .first();
    await expect(listOrEmpty).toBeVisible({ timeout: 15_000 });
  });

  test.fixme('device list shows enrolled devices or empty state', async ({ page }) => {
    await page.goto('/devices');
    await waitForApp(page, '/devices');
    await waitForContentLoad(page);

    // Either we see table rows for devices, or an empty-state message
    // DeviceList empty state: "No devices found. Try adjusting your search or filters."
    const deviceRow = page.locator('table tbody tr').first();
    const emptyState = page.locator('text=No devices found')
      .or(page.locator('text=No devices'))
      .or(page.locator('text=Get started'))
      .first();

    // One of these should be visible (table always renders, even with empty-state row)
    await expect(
      deviceRow.or(emptyState),
    ).toBeVisible({ timeout: 15_000 });
  });

  test.fixme('device detail page shows tabs', async ({ page }) => {
    await page.goto('/devices');
    await waitForApp(page, '/devices');
    await waitForContentLoad(page);

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
    await waitForContentLoad(page);

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

  test.fixme('device groups page loads', async ({ page }) => {
    await page.goto('/devices/groups');
    await waitForApp(page, '/devices/groups');
    await waitForContentLoad(page);

    // Should show "Device Groups" heading
    await expect(
      page.locator('h1').first(),
    ).toContainText(/Device Groups/i, { timeout: 10_000 });

    // DeviceGroupsPage uses a card layout (not table).
    // Should have a "Create Group" button, existing group cards, or empty state.
    const createOrList = page.locator('button:has-text("Create Group")')
      .or(page.locator('button:has-text("Create your first group")'))
      .or(page.locator('text=No device groups yet'))
      .first();
    await expect(createOrList).toBeVisible({ timeout: 10_000 });
  });
});
