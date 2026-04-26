// e2e-tests/playwright/pages/SoftwarePage.ts
// Covers /software (catalog), /software-inventory (inventory), and /software-policies
import { BasePage } from './BasePage';

export class SoftwarePage extends BasePage {
  // ── Navigation helpers ────────────────────────────────────────────────────
  async gotoCatalog() {
    await this.page.goto('/software');
    await this.catalogHeading().waitFor();
  }

  async gotoInventory() {
    await this.page.goto('/software-inventory');
    await this.page.getByText('Software').first().waitFor();
  }

  async gotoPolicies() {
    await this.page.goto('/software-policies');
    await this.page.getByText('Software').first().waitFor();
  }

  // ── Software Library (catalog) page ──────────────────────────────────────
  catalogHeading() {
    return this.page.getByText('Software Library').first();
  }

  catalogSearchInput() {
    return this.page.getByPlaceholder(/Search software/i);
  }

  addPackageButton() {
    return this.page.getByRole('button', { name: 'Add Package' });
  }

  bulkDeployButton() {
    return this.page.getByRole('button', { name: 'Bulk Deploy' });
  }

  categoryFilterSelect() {
    // generic select on the catalog page
    return this.page.locator('select').first();
  }

  // ── Add Package form ──────────────────────────────────────────────────────
  async openAddPackageForm() {
    await this.addPackageButton().click();
    await this.page.getByText('Add Package').first().waitFor({ timeout: 10000 });
  }

  packageNameInput() {
    // The form may use placeholder or name attribute
    return this.page.locator('input[placeholder*="Package name"], input[name="name"]').first();
  }

  cancelFormButton() {
    return this.page.getByRole('button', { name: 'Cancel' });
  }

  // ── Software Inventory page ───────────────────────────────────────────────
  inventoryTab() {
    return this.page.getByRole('button', { name: 'Inventory' });
  }

  policiesTab() {
    return this.page.getByRole('button', { name: 'Policies' });
  }

  async openPoliciesTab() {
    await this.policiesTab().click();
    await this.page.getByText('Software').first().waitFor({ timeout: 10000 });
  }
}
