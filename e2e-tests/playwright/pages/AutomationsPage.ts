// e2e-tests/playwright/pages/AutomationsPage.ts
import { BasePage } from './BasePage';

export class AutomationsPage extends BasePage {
  url = '/automations';
  newAutomationUrl = '/automations/new';

  // Page header
  heading() {
    return this.page.getByRole('heading', { name: 'Automations', exact: true });
  }

  subtitle() {
    return this.page.getByText('Create and manage automated workflows.');
  }

  // New Automation link
  newAutomationLink() {
    return this.page.getByRole('link', { name: 'New Automation' });
  }

  // Table column headers
  tableColumnHeader(name: string) {
    return this.page.getByRole('columnheader', { name });
  }

  // Filter controls
  searchInput() {
    return this.page.getByPlaceholder('Search automations...');
  }

  // Automation row helpers
  automationRow(name: string) {
    return this.page.getByRole('row', { name: new RegExp(name) });
  }

  editButton(automationName: string) {
    return this.automationRow(automationName).getByRole('button', { name: 'Edit' });
  }

  runNowButton(automationName: string) {
    return this.automationRow(automationName).getByRole('button', { name: 'Run now' });
  }

  toggleCheckbox(automationName: string) {
    return this.automationRow(automationName).getByRole('checkbox');
  }

  // Create/Edit form
  automationNameInput() {
    return this.page.locator('#automation-name');
  }

  automationDescriptionInput() {
    return this.page.locator('#automation-description');
  }

  cronExpressionInput() {
    return this.page.locator('#cron-expression');
  }

  createAutomationButton() {
    return this.page.getByRole('button', { name: 'Create Automation' });
  }

  saveChangesButton() {
    return this.page.getByRole('button', { name: 'Save Changes' });
  }

  // Delete modal
  deleteAutomationHeading() {
    return this.page.getByRole('heading', { name: 'Delete Automation' });
  }

  deleteConfirmButton() {
    // The destructive delete button (not Cancel or heading)
    return this.page.getByRole('button', { name: 'Delete' }).last();
  }

  cancelButton() {
    return this.page.getByRole('button', { name: 'Cancel' });
  }

  // Run history modal
  runHistoryHeading() {
    return this.page.getByRole('heading', { name: 'Run History' });
  }

  // Create automation heading
  createAutomationHeading() {
    return this.page.getByRole('heading', { name: 'Create Automation' });
  }

  editAutomationHeading() {
    return this.page.getByRole('heading', { name: 'Edit Automation' });
  }

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  async gotoNew() {
    await this.page.goto(this.newAutomationUrl);
    await this.createAutomationHeading().waitFor();
  }
}
