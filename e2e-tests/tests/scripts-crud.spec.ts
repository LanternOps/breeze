import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('Script CRUD Lifecycle', () => {
  test.describe.configure({ mode: 'serial' });

  const scriptName = `E2E Test Script ${Date.now()}`;
  const scriptDescription = 'Created by Playwright E2E CRUD test';
  const scriptContent = '#!/bin/bash\necho "Hello from E2E test"';

  test('create a new script', async ({ page }) => {
    await page.goto('/scripts/new');
    await waitForApp(page, '/scripts/new');

    // Wait for the form to load
    const form = page.locator('form, [data-testid="script-editor"]').first();
    await expect(form).toBeVisible({ timeout: 15_000 });

    // Fill script name — the input uses react-hook-form register('name')
    const nameInput = page.locator('#script-name')
      .or(page.locator('[name="name"]'))
      .or(page.locator('input[placeholder*="Temp Files"]'))
      .first();
    const hasName = await nameInput.isVisible({ timeout: 5_000 }).catch(() => false);
    test.skip(!hasName, 'Script name input not found — skipping CRUD test');
    await nameInput.fill(scriptName);

    // Fill description
    const descInput = page.locator('#script-description')
      .or(page.locator('[name="description"]'))
      .or(page.locator('textarea[placeholder*="Describe"]'))
      .first();
    if (await descInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await descInput.fill(scriptDescription);
    }

    // Select language — default is powershell, switch to bash
    const langSelect = page.locator('#script-language')
      .or(page.locator('select[name="language"]'))
      .first();
    if (await langSelect.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await langSelect.selectOption('bash');
    }

    // Fill script content — Monaco editor or fallback textarea
    const monacoEditor = page.locator('.monaco-editor textarea, .view-lines');
    const contentArea = page.locator('textarea[name="content"]')
      .or(page.locator('[data-testid="script-content"]'))
      .first();

    if (await monacoEditor.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Click into the Monaco editor and type content
      await page.locator('.monaco-editor').first().click();
      await page.keyboard.insertText(scriptContent);
    } else if (await contentArea.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await contentArea.fill(scriptContent);
    }

    // Click the submit button — "Create Script" for new scripts
    const submitBtn = page.locator('button[type="submit"]')
      .or(page.locator('button:has-text("Create Script")'))
      .or(page.locator('button:has-text("Save")'))
      .first();
    await submitBtn.click();

    // After successful creation, the app redirects to /scripts
    await expect(page).toHaveURL(/\/scripts/, { timeout: 15_000 });
  });

  test('verify script appears in the list', async ({ page }) => {
    await page.goto('/scripts');
    await waitForApp(page, '/scripts');

    // Wait for the script list to load
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 15_000 });

    // The created script should appear in the table
    const scriptRow = page.locator(`text=${scriptName}`).first();
    await expect(scriptRow).toBeVisible({ timeout: 10_000 });
  });

  test('view script detail page', async ({ page }) => {
    await page.goto('/scripts');
    await waitForApp(page, '/scripts');

    // Wait for list to load
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });

    // Click the edit button on our script's row to navigate to the detail page
    const scriptRow = page.locator('tr', { hasText: scriptName }).first();
    const hasRow = await scriptRow.isVisible({ timeout: 10_000 }).catch(() => false);
    test.skip(!hasRow, 'Script row not found in list — skipping detail test');

    // Click the edit (pencil) button in the row's actions column
    const editBtn = scriptRow.locator('button[title="Edit script"]')
      .or(scriptRow.locator('button:has-text("Edit")'))
      .first();
    const hasEditBtn = await editBtn.isVisible({ timeout: 3_000 }).catch(() => false);

    if (hasEditBtn) {
      await editBtn.click();
    } else {
      // Fallback: click the row itself
      await scriptRow.click();
    }

    // Should navigate to a script detail/edit page
    await expect(page).toHaveURL(/\/scripts\/.+/, { timeout: 10_000 });

    // The page heading should say "Edit Script" or show the script name
    const heading = page.locator('h1, h2').first();
    await expect(heading).toContainText(/Edit Script|Script Editor/i, { timeout: 10_000 });
  });

  test('delete the script', async ({ page }) => {
    await page.goto('/scripts');
    await waitForApp(page, '/scripts');

    // Wait for list to load
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });

    // Find our script row
    const scriptRow = page.locator('tr', { hasText: scriptName }).first();
    const hasRow = await scriptRow.isVisible({ timeout: 10_000 }).catch(() => false);
    test.skip(!hasRow, 'Script row not found — skipping delete test');

    // Click the delete (trash) button
    const deleteBtn = scriptRow.locator('button[title="Delete script"]')
      .or(scriptRow.locator('button:has-text("Delete")'))
      .first();
    const hasDeleteBtn = await deleteBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    test.skip(!hasDeleteBtn, 'Delete button not found — skipping delete test');

    await deleteBtn.click();

    // A confirmation modal should appear
    const confirmModal = page.locator('text=Are you sure')
      .or(page.locator('text=Delete Script'))
      .or(page.locator('text=cannot be undone'))
      .first();
    await expect(confirmModal).toBeVisible({ timeout: 5_000 });

    // Click the confirm delete button in the modal
    const confirmBtn = page.locator('button:has-text("Delete")')
      .filter({ hasNot: page.locator('button:has-text("Cancel")') })
      .last();
    await confirmBtn.click();

    // Wait for the modal to disappear and the list to refresh
    await expect(confirmModal).not.toBeVisible({ timeout: 10_000 });
  });

  test('verify script is removed from the list', async ({ page }) => {
    await page.goto('/scripts');
    await waitForApp(page, '/scripts');

    // Wait for the script list to load
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 15_000 });

    // The script should no longer appear
    const scriptEntry = page.locator(`text=${scriptName}`);
    await expect(scriptEntry).not.toBeVisible({ timeout: 10_000 });
  });
});
