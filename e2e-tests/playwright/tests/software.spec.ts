// e2e-tests/playwright/tests/software.spec.ts
// Converted from e2e-tests/tests/software_management.yaml
import { test, expect } from '../fixtures';
import { SoftwarePage } from '../pages/SoftwarePage';

test.describe('Software Management', () => {
  // ── Software Library (catalog) ─────────────────────────────────────────────
  test('Software Library page loads with heading and controls', async ({ authedPage }) => {
    const software = new SoftwarePage(authedPage);
    await software.gotoCatalog();

    await expect(software.catalogHeading()).toBeVisible();
    await expect(software.catalogSearchInput()).toBeVisible();
    await expect(software.addPackageButton()).toBeVisible();
    await expect(software.bulkDeployButton()).toBeVisible();
    await expect(software.categoryFilterSelect()).toBeVisible();
  });

  // ── Catalog search and filter ──────────────────────────────────────────────
  test('Software Library search and category filter respond', async ({ authedPage }) => {
    const software = new SoftwarePage(authedPage);
    await software.gotoCatalog();

    await software.catalogSearchInput().fill('chrome');
    await expect(authedPage.getByText(/Browse and deploy/i)).toBeVisible({ timeout: 5000 });

    await software.catalogSearchInput().fill('');
    await software.categoryFilterSelect().selectOption('browser');
    await expect(software.catalogHeading()).toBeVisible({ timeout: 5000 });
  });

  // ── Add Package form ───────────────────────────────────────────────────────
  test('Add Package form opens and can be cancelled', async ({ authedPage }) => {
    const software = new SoftwarePage(authedPage);
    await software.gotoCatalog();
    await software.openAddPackageForm();

    await expect(authedPage.getByText('Add Package').first()).toBeVisible();
    await expect(software.packageNameInput()).toBeVisible();

    await software.packageNameInput().fill('E2E Test Package');
    // Cancel without saving
    const cancelBtn = software.cancelFormButton();
    if ((await cancelBtn.count()) > 0) {
      await cancelBtn.click();
    }
  });

  // ── Software Inventory page ────────────────────────────────────────────────
  test('Software Inventory page loads with Inventory and Policies tabs', async ({ authedPage }) => {
    const software = new SoftwarePage(authedPage);
    await software.gotoInventory();

    await expect(software.inventoryTab()).toBeVisible({ timeout: 10000 });
    await expect(software.policiesTab()).toBeVisible();
  });

  // ── Software Policies page ─────────────────────────────────────────────────
  test('Software Policies page loads and Policies tab is navigable', async ({ authedPage }) => {
    const software = new SoftwarePage(authedPage);
    await software.gotoPolicies();

    await expect(software.policiesTab()).toBeVisible({ timeout: 10000 });
    await software.openPoliciesTab();
    await expect(authedPage.getByText('Software').first()).toBeVisible();
  });

  // ── Windows inventory: page navigation (no live agent required) ────────────
  test('Software Inventory page accessible from /software-inventory', async ({ authedPage }) => {
    const software = new SoftwarePage(authedPage);
    await software.gotoInventory();
    await expect(authedPage.getByText('Software').first()).toBeVisible();
  });
});
