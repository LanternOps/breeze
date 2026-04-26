// e2e-tests/playwright/tests/scripts.spec.ts
import { test, expect } from '../fixtures';
import { ScriptsPage } from '../pages/ScriptsPage';

test.describe('Scripts', () => {
  test('page loads with Script Library heading, table columns, and action buttons', async ({ authedPage }) => {
    const page = new ScriptsPage(authedPage);
    await page.goto();

    await expect(page.heading()).toBeVisible();
    await expect(page.subtitle()).toBeVisible();
    await expect(page.newScriptLink()).toBeVisible();
    await expect(page.importFromLibraryButton()).toBeVisible();
  });

  test('script table has expected column headers', async ({ authedPage }) => {
    const page = new ScriptsPage(authedPage);
    await page.goto();

    for (const col of ['Name', 'Language', 'Category', 'OS Types', 'Last Run', 'Status', 'Actions']) {
      await expect(page.tableColumnHeader(col)).toBeVisible();
    }
  });

  test('filter controls are present', async ({ authedPage }) => {
    const page = new ScriptsPage(authedPage);
    await page.goto();

    await expect(page.searchInput()).toBeVisible();
  });

  test('new script page renders form with all required fields', async ({ authedPage }) => {
    const page = new ScriptsPage(authedPage);
    await page.gotoNew();

    await expect(authedPage.getByRole('heading', { name: 'New Script' })).toBeVisible();
    await expect(authedPage.getByText('Create a new script for your devices.')).toBeVisible();
    await expect(authedPage.getByRole('link', { name: /scripts/i })).toBeVisible();
    await expect(page.scriptNameInput()).toBeVisible();
    await expect(page.scriptDescriptionInput()).toBeVisible();
    await expect(page.scriptCategorySelect()).toBeVisible();
    await expect(page.scriptLanguageSelect()).toBeVisible();
    await expect(page.createScriptButton()).toBeVisible();
  });

  test('create script, verify it appears in list, edit description, delete', async ({ authedPage }) => {
    const page = new ScriptsPage(authedPage);
    const scriptName = `E2E Hostname Check ${Date.now()}`;

    // Create
    await page.gotoNew();
    await page.scriptNameInput().fill(scriptName);
    await page.scriptDescriptionInput().fill('Returns hostname for E2E testing');
    await page.scriptCategorySelect().selectOption('Monitoring');
    await page.scriptLanguageSelect().selectOption('bash');
    // Submit without Monaco content (content is optional for form save)
    await page.createScriptButton().click();
    await authedPage.waitForURL('**/scripts', { timeout: 20_000 });

    // Verify in list
    await expect(authedPage.getByRole('cell', { name: scriptName })).toBeVisible({ timeout: 10_000 });

    // Edit
    await page.editScriptButton(scriptName).click();
    await expect(authedPage.getByRole('heading', { name: 'Edit Script' })).toBeVisible({ timeout: 15_000 });
    await page.scriptDescriptionInput().fill('Updated description for E2E test');
    await page.saveChangesButton().click();
    await authedPage.waitForURL('**/scripts', { timeout: 20_000 });

    // Delete: open modal, cancel first, then confirm
    await page.deleteScriptButton(scriptName).click();
    await expect(page.deleteScriptHeading()).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.getByText('Are you sure you want to delete')).toBeVisible();
    await page.cancelButton().click();
    await expect(page.deleteScriptHeading()).not.toBeVisible();

    // Confirm delete
    await page.deleteScriptButton(scriptName).click();
    await expect(page.deleteScriptHeading()).toBeVisible({ timeout: 5_000 });
    await page.deleteConfirmButton().click();
    await expect(authedPage.getByRole('cell', { name: scriptName })).not.toBeVisible({ timeout: 10_000 });
  });

  test('import from system library modal opens and allows search', async ({ authedPage }) => {
    const page = new ScriptsPage(authedPage);
    await page.goto();

    await page.importFromLibraryButton().click();
    await expect(page.systemLibraryHeading()).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.getByText('Import scripts into your organization', { exact: false })).toBeVisible();
    await expect(page.librarySearchInput()).toBeVisible();
    await expect(page.doneButton()).toBeVisible();

    // Search
    await page.librarySearchInput().fill('disk');
    await expect(authedPage.getByText(/script.s. available/, { exact: false })).toBeVisible({ timeout: 5_000 });

    // Close
    await page.doneButton().click();
    await expect(page.systemLibraryHeading()).not.toBeVisible({ timeout: 5_000 });
  });

  test('execution history page is accessible from script edit page', async ({ authedPage }) => {
    const page = new ScriptsPage(authedPage);
    await page.goto();

    // If any scripts exist, navigate into the first one's edit page and verify execution history link
    const firstEditBtn = authedPage.getByRole('button', { name: 'Edit script' }).first();
    const count = await firstEditBtn.count();
    if (count === 0) {
      test.skip(true, 'No scripts available — skipping execution history navigation test');
      return;
    }

    await firstEditBtn.click();
    await expect(authedPage.getByRole('heading', { name: 'Edit Script' })).toBeVisible({ timeout: 15_000 });
    await expect(page.executionHistoryLink()).toBeVisible();

    await page.executionHistoryLink().click();
    await expect(page.executionHistoryHeading()).toBeVisible({ timeout: 10_000 });
  });
});
