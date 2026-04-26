// e2e-tests/playwright/pages/ConfigurationPoliciesPage.ts
import { BasePage } from './BasePage';

export class ConfigurationPoliciesPage extends BasePage {
  url = '/configuration-policies';
  newPolicyUrl = '/configuration-policies/new';

  // Page header
  heading() {
    return this.page.getByRole('heading', { name: 'Configuration Policies', exact: true });
  }

  subtitle() {
    return this.page.getByText('Bundle feature settings into reusable policies', { exact: false });
  }

  // New Policy link
  newPolicyLink() {
    return this.page.getByRole('link', { name: 'New Policy' });
  }

  // Policy rows
  policyRow(name: string) {
    return this.page.getByRole('row', { name: new RegExp(name) });
  }

  editButton(policyName: string) {
    return this.policyRow(policyName).getByRole('button', { name: 'Edit' });
  }

  deleteButton(policyName?: string) {
    if (policyName) {
      return this.policyRow(policyName).getByRole('button', { name: 'Delete' });
    }
    return this.page.getByRole('button', { name: 'Delete' }).first();
  }

  // Create page
  newConfigPolicyHeading() {
    return this.page.getByRole('heading', { name: 'New Configuration Policy' });
  }

  // Mode selection
  configureNewButton() {
    return this.page.getByRole('button', { name: 'Configure New', exact: false });
  }

  linkToExistingButton() {
    return this.page.getByRole('button', { name: 'Link to Existing', exact: false });
  }

  cancelLink() {
    return this.page.getByRole('link', { name: 'Cancel' });
  }

  // Policy details form (step 2 - Configure New)
  policyNameInput() {
    return this.page.getByPlaceholder(/Standard Workstation Policy/);
  }

  backButton() {
    return this.page.getByRole('button', { name: 'Back' });
  }

  createPolicyButton() {
    return this.page.getByRole('button', { name: 'Create Policy' });
  }

  // Delete modal
  deletePolicyText() {
    return this.page.getByText('Delete Policy', { exact: false });
  }

  deleteConfirmButton() {
    return this.page.getByRole('button', { name: 'Delete' }).last();
  }

  cancelButton() {
    return this.page.getByRole('button', { name: 'Cancel' });
  }

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  async gotoNew() {
    await this.page.goto(this.newPolicyUrl);
    await this.newConfigPolicyHeading().waitFor();
  }
}
