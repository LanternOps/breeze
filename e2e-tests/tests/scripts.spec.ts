import { test, expect } from '@playwright/test';
import { waitForApp, waitForContentLoad } from './helpers';

test.describe('Script Management', () => {
  test('script library loads', async ({ page }) => {
    await page.goto('/scripts');
    await waitForApp(page, '/scripts');
    await waitForContentLoad(page);

    // Page heading (rendered after loading completes)
    await expect(page.locator('h1').first()).toContainText('Script Library');

    // Should show script list or empty state
    // ScriptList empty state: "No scripts found. Try adjusting your search or filters."
    const listOrEmpty = page.locator('table').first()
      .or(page.locator('text=No scripts').first());
    await expect(listOrEmpty).toBeVisible({ timeout: 15_000 });
  });

  test.fixme('create new script page loads', async ({ page }) => {
    await page.goto('/scripts');
    await waitForApp(page, '/scripts');
    await waitForContentLoad(page);

    // Click the "New Script" button (or navigate directly)
    const newBtn = page.locator(
      'a[href="/scripts/new"], button:has-text("New Script"), button:has-text("Create"), a:has-text("New Script")',
    ).first();

    const hasNewBtn = await newBtn.isVisible({ timeout: 5_000 }).catch(() => false);

    if (hasNewBtn) {
      await newBtn.click();
    } else {
      // Navigate directly
      await page.goto('/scripts/new');
      await waitForApp(page, '/scripts/new');
    }

    await expect(page).toHaveURL(/\/scripts\/new/);

    // Should show a script editor form
    const formOrEditor = page.locator('form').first()
      .or(page.locator('.monaco-editor').first())
      .or(page.locator('#script-name').first());
    await expect(formOrEditor).toBeVisible({ timeout: 15_000 });
  });

  test('create and save a script', async ({ page }) => {
    await page.goto('/scripts/new');
    await waitForApp(page, '/scripts/new');

    // Wait for the form to render (ScriptEditPage with isNew has no loading gate)
    const form = page.locator('form').first();
    await expect(form).toBeVisible({ timeout: 15_000 });

    // Fill in script name — ScriptForm uses id="script-name"
    const nameInput = page.locator('#script-name');
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(`E2E Test Script ${Date.now()}`);

    // Fill in optional description — ScriptForm uses id="script-description"
    const descInput = page.locator('#script-description');
    if (await descInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await descInput.fill('Created by Playwright E2E test');
    }

    // Fill script content — Monaco editor loaded via lazy import in ScriptForm
    const monacoEditor = page.locator('.monaco-editor');
    const monacoVisible = await monacoEditor.first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);

    if (monacoVisible) {
      await monacoEditor.first().click();
      await page.keyboard.insertText('#!/bin/bash\necho "E2E test script"');
    } else {
      // Fallback: try any textarea within the form
      const fallbackEditor = page.locator('textarea').first();
      const fallbackVisible = await fallbackEditor.isVisible({ timeout: 3_000 }).catch(() => false);
      expect(fallbackVisible, 'No script content editor found (Monaco or textarea)').toBe(true);
      await fallbackEditor.fill('#!/bin/bash\necho "E2E test script"');
    }

    // Click Save — "Create Script" for new scripts
    const saveBtn = page.locator('button:has-text("Create Script")').first()
      .or(page.locator('button[type="submit"]').first());
    await saveBtn.click();

    // Should redirect back to /scripts on success
    await expect(page).toHaveURL(/\/scripts(?!\/new)/, { timeout: 15_000 });
  });

  test.fixme('script execution results page is accessible', async ({ page }) => {
    await page.goto('/scripts');
    await waitForApp(page, '/scripts');
    await waitForContentLoad(page);

    // If scripts exist, click the first one to see its detail
    const firstScript = page.locator('table tbody tr').first();
    const hasScripts = await firstScript.isVisible({ timeout: 5_000 }).catch(() => false);

    test.skip(!hasScripts, 'No scripts found — skipping execution results test');

    await firstScript.click();

    // Should show script detail with execution history or run button
    const runOrHistory = page.locator('button:has-text("Run")').first()
      .or(page.locator('button:has-text("Execute")').first())
      .or(page.locator('text=Execution').first())
      .or(page.locator('text=History').first());
    await expect(runOrHistory).toBeVisible({ timeout: 10_000 });
  });
});
