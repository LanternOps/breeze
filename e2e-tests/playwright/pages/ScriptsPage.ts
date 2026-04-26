// e2e-tests/playwright/pages/ScriptsPage.ts
import { BasePage } from './BasePage';

export class ScriptsPage extends BasePage {
  url = '/scripts';
  newScriptUrl = '/scripts/new';

  // Page header
  heading() {
    return this.page.getByRole('heading', { name: 'Script Library' });
  }

  subtitle() {
    return this.page.getByText('Manage and execute scripts across your devices.');
  }

  // Action buttons
  newScriptLink() {
    return this.page.getByRole('link', { name: 'New Script' });
  }

  importFromLibraryButton() {
    return this.page.getByRole('button', { name: 'Import from Library' });
  }

  // Table headers
  tableColumnHeader(name: string) {
    return this.page.getByRole('columnheader', { name });
  }

  // Search / filter controls
  searchInput() {
    return this.page.getByPlaceholder('Search scripts...');
  }

  // Script row locators
  scriptRow(scriptName: string) {
    return this.page.getByRole('row', { name: new RegExp(scriptName) });
  }

  runScriptButton(scriptName: string) {
    return this.scriptRow(scriptName).getByRole('button', { name: 'Run script' });
  }

  editScriptButton(scriptName: string) {
    return this.scriptRow(scriptName).getByRole('button', { name: 'Edit script' });
  }

  deleteScriptButton(scriptName: string) {
    return this.scriptRow(scriptName).getByRole('button', { name: 'Delete script' });
  }

  // New/Edit script form
  scriptNameInput() {
    return this.page.locator('#script-name');
  }

  scriptDescriptionInput() {
    return this.page.locator('#script-description');
  }

  scriptCategorySelect() {
    return this.page.locator('#script-category');
  }

  scriptLanguageSelect() {
    return this.page.locator('#script-language');
  }

  createScriptButton() {
    return this.page.getByRole('button', { name: 'Create Script' });
  }

  saveChangesButton() {
    return this.page.getByRole('button', { name: 'Save Changes' });
  }

  // Edit script page
  executionHistoryLink() {
    return this.page.getByRole('link', { name: 'Execution History' });
  }

  // Execute modal
  executeScriptHeading() {
    return this.page.getByRole('heading', { name: 'Execute Script' });
  }

  selectAllOnlineButton() {
    return this.page.getByRole('button', { name: 'Select all online' });
  }

  executeButton() {
    return this.page.getByRole('button', { name: 'Execute' });
  }

  confirmExecuteButton() {
    return this.page.getByRole('button', { name: 'Confirm Execute' });
  }

  // Delete modal
  deleteScriptHeading() {
    return this.page.getByRole('heading', { name: 'Delete Script' });
  }

  deleteConfirmButton() {
    return this.page.getByRole('button', { name: 'Delete' });
  }

  cancelButton() {
    return this.page.getByRole('button', { name: 'Cancel' });
  }

  // Import library modal
  systemLibraryHeading() {
    return this.page.getByRole('heading', { name: 'System Script Library' });
  }

  librarySearchInput() {
    return this.page.getByPlaceholder('Search system scripts...');
  }

  doneButton() {
    return this.page.getByRole('button', { name: 'Done' });
  }

  // Execution history page
  executionHistoryHeading() {
    return this.page.getByRole('heading', { name: 'Execution History' });
  }

  viewDetailsButton() {
    return this.page.getByRole('button', { name: 'View details' }).first();
  }

  executionDetailsHeading() {
    return this.page.getByRole('heading', { name: 'Execution Details' });
  }

  closeButton() {
    return this.page.getByRole('button', { name: 'Close' });
  }

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  async gotoNew() {
    await this.page.goto(this.newScriptUrl);
    await this.page.getByRole('heading', { name: 'New Script' }).waitFor();
  }
}
