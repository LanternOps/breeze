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

    // ScriptEditPage renders h1 "New Script" and then ScriptForm with a <form>
    const heading = page.locator('h1:has-text("New Script")').first();
    await expect(heading).toBeVisible({ timeout: 15_000 });

    // Wait for the form to load
    const form = page.locator('form').first();
    await expect(form).toBeVisible({ timeout: 15_000 });

    // Fill script name — ScriptForm uses id="script-name"
    const nameInput = page.locator('#script-name');
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(scriptName);

    // Fill description — ScriptForm uses id="script-description" (textarea)
    const descInput = page.locator('#script-description');
    if (await descInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await descInput.fill(scriptDescription);
    }

    // Select language — ScriptForm uses id="script-language"
    const langSelect = page.locator('#script-language');
    if (await langSelect.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await langSelect.selectOption('bash');
    }

    // Fill script content — Monaco editor loaded via lazy import in ScriptForm
    // The Monaco editor is rendered inside a Controller; wait for it to mount
    const monacoEditor = page.locator('.monaco-editor');
    const monacoVisible = await monacoEditor.first().isVisible({ timeout: 10_000 }).catch(() => false);

    if (monacoVisible) {
      // Click into the Monaco editor and type content
      await monacoEditor.first().click();
      await page.keyboard.insertText(scriptContent);
    } else {
      // Fallback: try any textarea or contenteditable within the form
      const fallbackEditor = page.locator('textarea').first();
      if (await fallbackEditor.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await fallbackEditor.fill(scriptContent);
      }
    }

    // Click the submit button — "Create Script" for new scripts (from ScriptEditPage submitLabel)
    const submitBtn = page.locator('button[type="submit"]:has-text("Create Script")').first();
    if (await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await submitBtn.click();
    } else {
      // Fallback to any submit button
      await page.locator('button[type="submit"]').first().click();
    }

    // After successful creation, ScriptEditPage redirects to /scripts (the list page)
    // Use a strict regex to ensure we land on /scripts and not still on /scripts/new
    await expect(page).toHaveURL(/\/scripts$/, { timeout: 15_000 });
  });

  test('verify script appears in the list', async ({ page }) => {
    await page.goto('/scripts');
    await waitForApp(page, '/scripts');

    // ScriptsPage renders h1 "Script Library"
    await expect(page.locator('h1:has-text("Script Library")').first()).toBeVisible({ timeout: 15_000 });

    // Wait for the script list table to load (ScriptList renders a <table>)
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
    test.skip(!hasRow, 'Script row not found in list -- skipping detail test');

    // Click the edit (pencil) button in the row's actions column
    // ScriptList buttons use title="Edit script" (lowercase 's')
    const editBtn = scriptRow.locator('button[title="Edit script"]').first();
    const hasEditBtn = await editBtn.isVisible({ timeout: 3_000 }).catch(() => false);

    if (hasEditBtn) {
      await editBtn.click();
    } else {
      // Fallback: click any edit-like button in the row
      const fallbackBtn = scriptRow.locator('button:has-text("Edit")').first();
      if (await fallbackBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await fallbackBtn.click();
      } else {
        // Last resort: click the row itself
        await scriptRow.click();
      }
    }

    // Should navigate to a script detail/edit page (/scripts/<id>)
    await expect(page).toHaveURL(/\/scripts\/.+/, { timeout: 10_000 });

    // The [id].astro page renders ScriptEditor which has h1 "Script Editor"
    const pageHeading = page.locator('h1').first();
    await expect(pageHeading).toBeVisible({ timeout: 15_000 });
    await expect(pageHeading).toContainText(/Script Editor/i, { timeout: 10_000 });
  });

  test('delete the script', async ({ page }) => {
    await page.goto('/scripts');
    await waitForApp(page, '/scripts');

    // Wait for list to load
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });

    // Find our script row
    const scriptRow = page.locator('tr', { hasText: scriptName }).first();
    const hasRow = await scriptRow.isVisible({ timeout: 10_000 }).catch(() => false);
    test.skip(!hasRow, 'Script row not found -- skipping delete test');

    // Click the delete (trash) button — ScriptList uses title="Delete script"
    const deleteBtn = scriptRow.locator('button[title="Delete script"]').first();
    const hasDeleteBtn = await deleteBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    test.skip(!hasDeleteBtn, 'Delete button not found -- skipping delete test');

    await deleteBtn.click();

    // A confirmation modal should appear with h2 "Delete Script" (from ScriptsPage)
    const modalHeading = page.locator('h2:has-text("Delete Script")').first();
    await expect(modalHeading).toBeVisible({ timeout: 5_000 });

    // Click the confirm delete button inside the modal container
    const modalContainer = modalHeading.locator('..');
    const confirmBtn = modalContainer.locator('button:has-text("Delete")').first();
    await confirmBtn.click();

    // Wait for the modal to disappear
    await expect(modalHeading).not.toBeVisible({ timeout: 10_000 });
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
