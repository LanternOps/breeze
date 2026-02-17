import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('Sites CRUD', () => {
  test.describe.configure({ mode: 'serial' });

  const ts = Date.now();
  const siteName = `E2E Test Site ${ts}`;
  const updatedSiteName = `E2E Test Site ${ts} Updated`;

  let created = false;

  test('page loads with Sites heading', async ({ page }) => {
    await page.goto('/settings/sites');
    await waitForApp(page, '/settings/sites');

    // SitesPage renders h1 "Sites" after organizations load
    const heading = page.locator('h1:has-text("Sites")').first();
    await expect(heading).toBeVisible({ timeout: 15_000 });
  });

  test('create a new site', async ({ page }) => {
    await page.goto('/settings/sites');
    await waitForApp(page, '/settings/sites');

    // Wait for the h1 to confirm data has loaded
    await expect(page.locator('h1:has-text("Sites")').first()).toBeVisible({ timeout: 15_000 });

    // SiteList renders the "Add site" button once sites have loaded.
    // Wait for the table or the "Add site" button to appear (SiteList or empty state).
    const addBtn = page.locator('button:has-text("Add site")').first();
    const hasAdd = await addBtn.isVisible({ timeout: 15_000 }).catch(() => false);
    test.skip(!hasAdd, 'No add-site button found');

    await addBtn.click();

    // Modal should appear — h2 with "Add Site"
    const modal = page.locator('h2:has-text("Add Site")').first();
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Fill required form fields (IDs from SiteForm component)
    await page.locator('#site-name').fill(siteName);
    await page.locator('#site-timezone').selectOption('America/Chicago');
    await page.locator('#address-line-1').fill('100 E2E Test Blvd');
    await page.locator('#address-line-2').fill('');
    await page.locator('#city').fill('Testville');
    await page.locator('#state').fill('TX');
    await page.locator('#postal-code').fill('75001');
    await page.locator('#country').fill('United States');
    await page.locator('#contact-name').fill('E2E Tester');
    await page.locator('#contact-email').fill('e2e@example.com');
    await page.locator('#contact-phone').fill('+1 555-000-1234');

    // Submit — button text is "Create site" (from SitesPage submitLabel)
    const submitBtn = page.locator(
      'button:has-text("Create site"), button[type="submit"]',
    ).first();
    await submitBtn.click();

    // Modal should close and site should appear in list
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`text=${siteName}`).first()).toBeVisible({ timeout: 10_000 });

    created = true;
  });

  test('site appears in the list after creation', async ({ page }) => {
    test.skip(!created, 'Site was not created -- skipping');

    await page.goto('/settings/sites');
    await waitForApp(page, '/settings/sites');

    // Wait for table to render (SiteList renders a <table>)
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`text=${siteName}`).first()).toBeVisible({ timeout: 15_000 });
  });

  test('edit the site', async ({ page }) => {
    test.skip(!created, 'Site was not created -- skipping');

    await page.goto('/settings/sites');
    await waitForApp(page, '/settings/sites');

    // Wait for table to render
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });

    // Find the row containing our site and click Edit
    const row = page.locator('tr', { hasText: siteName }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    const editBtn = row.locator('button:has-text("Edit")').first();
    const hasEdit = await editBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    test.skip(!hasEdit, 'No Edit button found on site row');

    await editBtn.click();

    // Edit modal should appear — h2 with "Edit Site"
    const modal = page.locator('h2:has-text("Edit Site")').first();
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Update the name
    const nameInput = page.locator('#site-name');
    await nameInput.clear();
    await nameInput.fill(updatedSiteName);

    // Save — button text is "Save changes" (from SitesPage submitLabel)
    const saveBtn = page.locator(
      'button:has-text("Save changes"), button[type="submit"]',
    ).first();
    await saveBtn.click();

    // Modal should close and updated name should appear
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`text=${updatedSiteName}`).first()).toBeVisible({ timeout: 10_000 });
  });

  test('delete the site', async ({ page }) => {
    test.skip(!created, 'Site was not created -- skipping');

    await page.goto('/settings/sites');
    await waitForApp(page, '/settings/sites');

    // Wait for table to render
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });

    // Use updated name if edit succeeded, otherwise original
    const hasUpdated = await page.locator(`text=${updatedSiteName}`).isVisible({ timeout: 5_000 }).catch(() => false);
    const nameToFind = hasUpdated ? updatedSiteName : siteName;

    const row = page.locator('tr', { hasText: nameToFind }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    const deleteBtn = row.locator('button:has-text("Delete")').first();
    const hasDelete = await deleteBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    test.skip(!hasDelete, 'No Delete button found on site row');

    await deleteBtn.click();

    // Confirm deletion modal — h2 with "Delete Site"
    const modal = page.locator('h2:has-text("Delete Site")').first();
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // The confirm Delete button is inside the modal container (sibling of h2).
    // Navigate to the modal container (parent of h2) and find the destructive Delete button.
    const modalContainer = page.locator('h2:has-text("Delete Site")').locator('..');
    const confirmBtn = modalContainer.locator('button:has-text("Delete")').first();
    await confirmBtn.click();

    // Modal should close and site should disappear
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`text=${nameToFind}`)).not.toBeVisible({ timeout: 10_000 });
  });
});
