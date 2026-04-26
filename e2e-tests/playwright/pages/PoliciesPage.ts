// e2e-tests/playwright/pages/PoliciesPage.ts
import { BasePage } from './BasePage';

export class PoliciesPage extends BasePage {
  url = '/policies';
  newPolicyUrl = '/policies/new';
  complianceDashboardUrl = '/policies/compliance';

  // Page header
  heading() {
    return this.page.getByRole('heading', { name: 'Policies', exact: true });
  }

  subtitle() {
    return this.page.getByText('Define and enforce compliance policies', { exact: false });
  }

  // Action links/buttons
  complianceDashboardLink() {
    return this.page.getByRole('link', { name: 'Compliance Dashboard' });
  }

  newPolicyLink() {
    return this.page.getByRole('link', { name: 'New Policy' });
  }

  // Table
  tableBody() {
    return this.page.locator('table tbody');
  }

  tableHead() {
    return this.page.locator('table thead');
  }

  policyRow(name: string) {
    return this.page.getByRole('row', { name: new RegExp(name) });
  }

  editButton(rowLocator?: ReturnType<PoliciesPage['policyRow']>) {
    const ctx = rowLocator ?? this.page;
    return ctx.getByRole('button', { name: 'Edit' });
  }

  deleteButton(rowLocator?: ReturnType<PoliciesPage['policyRow']>) {
    const ctx = rowLocator ?? this.page;
    return ctx.getByRole('button', { name: 'Delete' });
  }

  // Filter controls
  searchInput() {
    return this.page.getByPlaceholder('Search policies...');
  }

  // Create / Edit form
  policyNameInput() {
    return this.page.locator('#policy-name');
  }

  policyDescriptionInput() {
    return this.page.locator('#policy-description');
  }

  checkIntervalInput() {
    return this.page.locator('#check-interval');
  }

  createPolicyButton() {
    return this.page.getByRole('button', { name: 'Create Policy' });
  }

  saveChangesButton() {
    return this.page.getByRole('button', { name: 'Save Changes' });
  }

  cancelButton() {
    return this.page.getByRole('button', { name: 'Cancel' });
  }

  addRuleButton() {
    return this.page.getByRole('button', { name: 'Add Rule' });
  }

  // Create/edit headings
  createPolicyHeading() {
    return this.page.getByRole('heading', { name: 'Create Policy' });
  }

  editPolicyHeading() {
    return this.page.getByRole('heading', { name: 'Edit Policy' });
  }

  // Delete modal
  deletePolicyHeading() {
    return this.page.getByRole('heading', { name: 'Delete Policy' });
  }

  // Compliance Dashboard
  complianceDashboardHeading() {
    return this.page.getByRole('heading', { name: 'Compliance Dashboard' });
  }

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  async gotoNew() {
    await this.page.goto(this.newPolicyUrl);
    await this.createPolicyHeading().waitFor();
  }

  async gotoCompliance() {
    await this.page.goto(this.complianceDashboardUrl);
    await this.complianceDashboardHeading().waitFor();
  }
}
