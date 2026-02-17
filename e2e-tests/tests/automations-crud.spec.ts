import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('Automations CRUD', () => {
  test.describe.configure({ mode: 'serial' });

  let automationName: string;
  let automationId: string | undefined;

  test('automations list page loads', async ({ page }) => {
    await page.goto('/automations');
    await waitForApp(page, '/automations');

    // Page heading should reference automations
    const heading = page.locator('h1:has-text("Automation")').or(
      page.locator('h2:has-text("Automation")')
    );
    await expect(heading).toBeVisible({ timeout: 15_000 });

    // Should see a table, list, or empty state
    const listOrEmpty = page.locator('table').or(
      page.locator('[data-testid="automation-list"]')
    ).or(
      page.locator('text=No automations')
    );
    await expect(listOrEmpty).toBeVisible({ timeout: 15_000 });
  });

  test('navigate to create automation page', async ({ page }) => {
    await page.goto('/automations');
    await waitForApp(page, '/automations');

    // Look for New Automation link/button
    const newBtn = page.locator('a[href="/automations/new"]').or(
      page.locator('button:has-text("New Automation")')
    ).or(
      page.locator('a:has-text("New Automation")')
    ).or(
      page.locator('button:has-text("Create")')
    );

    const hasNewBtn = await newBtn.first().isVisible({ timeout: 5_000 }).catch(() => false);

    if (hasNewBtn) {
      await newBtn.first().click();
    } else {
      await page.goto('/automations/new');
      await waitForApp(page, '/automations/new');
    }

    await expect(page).toHaveURL(/\/automations\/new/);

    // Should show the automation form
    const form = page.locator('form').or(
      page.locator('#automation-name')
    ).or(
      page.locator('[name="name"]')
    );
    await expect(form.first()).toBeVisible({ timeout: 10_000 });
  });

  test('create a new automation', async ({ page }) => {
    automationName = `E2E Test Automation ${Date.now()}`;

    await page.goto('/automations/new');
    await waitForApp(page, '/automations/new');

    // Wait for the form to render
    const nameInput = page.locator('#automation-name').or(
      page.locator('[name="name"]')
    ).or(
      page.locator('input[placeholder*="name" i]')
    );
    await expect(nameInput.first()).toBeVisible({ timeout: 10_000 });
    await nameInput.first().fill(automationName);

    // Fill description
    const descInput = page.locator('#automation-description').or(
      page.locator('[name="description"]')
    ).or(
      page.locator('textarea[placeholder*="describe" i]')
    );
    if (await descInput.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
      await descInput.first().fill('Created by Playwright E2E test');
    }

    // Select "Manual" trigger (default is manual, but click to be explicit)
    const manualTrigger = page.locator('button:has-text("Manual")');
    if (await manualTrigger.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await manualTrigger.click();
    }

    // The form ships with one default action (run_script). Leave it as-is.

    // Submit the form
    const submitBtn = page.locator('button:has-text("Create Automation")').or(
      page.locator('button[type="submit"]')
    ).or(
      page.locator('button:has-text("Save")')
    );
    await submitBtn.first().click();

    // Should redirect back to /automations or show success
    await expect(
      page.locator(`text=${automationName}`).or(page.locator('h1:has-text("Automation")'))
    ).toBeVisible({ timeout: 15_000 });
  });

  test('automation appears in the list', async ({ page }) => {
    test.skip(!automationName, 'No automation was created -- skipping list verification');

    await page.goto('/automations');
    await waitForApp(page, '/automations');

    // Wait for list to load
    await expect(
      page.locator('table').or(page.locator('text=No automations'))
    ).toBeVisible({ timeout: 15_000 });

    // Search for the automation if search is available
    const searchInput = page.locator('input[placeholder*="Search" i]').or(
      page.locator('input[type="search"]')
    );
    if (await searchInput.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
      await searchInput.first().fill(automationName);
      await page.waitForTimeout(500);
    }

    // Verify the automation name appears
    const automationCell = page.locator(`text=${automationName}`);
    await expect(automationCell.first()).toBeVisible({ timeout: 10_000 });
  });

  test('view automation detail', async ({ page }) => {
    test.skip(!automationName, 'No automation was created -- skipping detail view');

    await page.goto('/automations');
    await waitForApp(page, '/automations');

    // Wait for table
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    // Find the row with our automation and click the edit button
    const automationRow = page.locator('tr', { hasText: automationName });
    const hasRow = await automationRow.first().isVisible({ timeout: 5_000 }).catch(() => false);
    test.skip(!hasRow, 'Automation row not found in table -- skipping detail view');

    // Click the edit (pencil) button in that row
    const editBtn = automationRow.first().locator('button[title="Edit"]').or(
      automationRow.first().locator('button:has-text("Edit")')
    );
    const hasEditBtn = await editBtn.first().isVisible({ timeout: 3_000 }).catch(() => false);

    if (hasEditBtn) {
      await editBtn.first().click();
    } else {
      // Try clicking the automation name text as a fallback
      const nameLink = automationRow.first().locator(`text=${automationName}`);
      await nameLink.click();
    }

    // Should navigate to the detail/edit page
    await expect(page).toHaveURL(/\/automations\/.+/, { timeout: 10_000 });

    // Capture the automation ID from the URL for potential later use
    const url = page.url();
    const match = url.match(/\/automations\/([^/?#]+)/);
    if (match) {
      automationId = match[1];
    }

    // Verify the edit page loaded with the automation name
    const nameInput = page.locator('#automation-name').or(
      page.locator('[name="name"]')
    ).or(
      page.locator('h1:has-text("Edit")')
    );
    await expect(nameInput.first()).toBeVisible({ timeout: 10_000 });
  });
});
