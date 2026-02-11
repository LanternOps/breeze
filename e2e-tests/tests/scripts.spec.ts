import { test, expect } from '@playwright/test';

test.describe('Script Management', () => {
  test('script library loads', async ({ page }) => {
    await page.goto('/scripts');

    // Page heading
    await expect(page.locator('h1, h2').first()).toContainText(/Script/i);

    // Should show script list or empty state
    const listOrEmpty = page.locator(
      'table, [data-testid="script-list"], text=No scripts, [data-testid="empty-state"]',
    ).first();
    await expect(listOrEmpty).toBeVisible({ timeout: 15_000 });
  });

  test('create new script page loads', async ({ page }) => {
    await page.goto('/scripts');

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
    }

    await expect(page).toHaveURL(/\/scripts\/new/);

    // Should show a script editor form
    const formOrEditor = page.locator(
      'form, [data-testid="script-editor"], textarea, [name="name"]',
    ).first();
    await expect(formOrEditor).toBeVisible({ timeout: 10_000 });
  });

  test('create and save a script', async ({ page }) => {
    await page.goto('/scripts/new');

    // Fill in script name
    const nameInput = page.locator('[name="name"], #name, input[placeholder*="name" i]').first();
    await nameInput.fill(`E2E Test Script ${Date.now()}`);

    // Fill in optional description
    const descInput = page.locator('[name="description"], #description, textarea[placeholder*="description" i]').first();
    if (await descInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await descInput.fill('Created by Playwright E2E test');
    }

    // Fill script content (textarea or code editor)
    const contentArea = page.locator(
      '[data-testid="script-content"], textarea[name="content"], .cm-content, textarea',
    ).first();
    if (await contentArea.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await contentArea.fill('#!/bin/bash\necho "E2E test script"');
    }

    // Click Save
    const saveBtn = page.locator('button:has-text("Save"), button:has-text("Create"), button[type="submit"]').first();
    await saveBtn.click();

    // Should see success message or redirect
    const success = page.locator(
      'text=saved, text=created, text=Script saved, text=success',
    ).first();
    await expect(success).toBeVisible({ timeout: 10_000 });
  });

  test('script execution results page is accessible', async ({ page }) => {
    await page.goto('/scripts');

    // If scripts exist, click the first one to see its detail
    const firstScript = page.locator('table tbody tr, [data-testid="script-row"]').first();
    const hasScripts = await firstScript.isVisible({ timeout: 5_000 }).catch(() => false);

    test.skip(!hasScripts, 'No scripts found — skipping execution results test');

    await firstScript.click();

    // Should show script detail with execution history or run button
    const runOrHistory = page.locator(
      'button:has-text("Run"), button:has-text("Execute"), text=Execution, text=History',
    ).first();
    await expect(runOrHistory).toBeVisible({ timeout: 10_000 });
  });
});
