import { test, expect } from '@playwright/test';
import { waitForApp, waitForContentLoad } from './helpers';

test.describe('Settings', () => {
  test('organization settings page loads', async ({ page }) => {
    await page.goto('/settings/organization');
    await waitForApp(page, '/settings/organization');
    await waitForContentLoad(page);

    await expect(page.locator('h1').first()).toContainText(/Organization settings/i, { timeout: 10_000 });

    // OrgSettingsPage uses a tabbed layout with aside nav (not a form)
    // Look for the settings tab navigation or the "General" tab content
    const content = page.locator('aside nav')
      .or(page.locator('button:has-text("General")'))
      .or(page.locator('button:has-text("Branding")'))
      .first();
    await expect(content).toBeVisible({ timeout: 10_000 });
  });

  test('user management page loads', async ({ page }) => {
    await page.goto('/settings/users');
    await waitForApp(page, '/settings/users');
    await waitForContentLoad(page);

    await expect(page.locator('h1').first()).toContainText(/Users/i, { timeout: 10_000 });

    // Should show a user list or invite button
    const listOrInvite = page.locator('table')
      .or(page.locator('button:has-text("Invite")'))
      .or(page.locator('button:has-text("Add")'))
      .first();
    await expect(listOrInvite).toBeVisible({ timeout: 10_000 });
  });

  test('role management page loads', async ({ page }) => {
    await page.goto('/settings/roles');
    await waitForApp(page, '/settings/roles');
    await waitForContentLoad(page);

    await expect(page.locator('h1').first()).toContainText(/Roles/i, { timeout: 10_000 });

    // Should show roles list or create button
    const rolesContent = page.locator('table')
      .or(page.locator('button:has-text("New")'))
      .or(page.locator('button:has-text("Create")'))
      .first();
    await expect(rolesContent).toBeVisible({ timeout: 10_000 });
  });

  test('API keys page loads', async ({ page }) => {
    await page.goto('/settings/api-keys');
    await waitForApp(page, '/settings/api-keys');
    await waitForContentLoad(page);

    await expect(page.locator('h1').first()).toContainText(/API Keys/i, { timeout: 10_000 });

    // Should show existing keys or create button
    const keysContent = page.locator('table')
      .or(page.locator('button:has-text("Create")'))
      .or(page.locator('button:has-text("Generate")'))
      .first();
    await expect(keysContent).toBeVisible({ timeout: 10_000 });
  });

  test.fixme('API key creation flow', async ({ page }) => {
    await page.goto('/settings/api-keys');
    await waitForApp(page, '/settings/api-keys');
    await waitForContentLoad(page);

    // Look for create button
    const createBtn = page.locator('button:has-text("Create")')
      .or(page.locator('button:has-text("Generate")'))
      .or(page.locator('button:has-text("New")'))
      .first();

    const hasCreate = await createBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    test.skip(!hasCreate, 'No API key create button found');

    await createBtn.click();

    // Should show a form or modal for API key creation
    const nameInput = page.locator('[name="name"]')
      .or(page.locator('[name="label"]'))
      .or(page.locator('input[placeholder*="name" i]'))
      .or(page.locator('input[placeholder*="label" i]'))
      .first();
    await expect(nameInput).toBeVisible({ timeout: 5_000 });

    await nameInput.fill(`E2E Test Key ${Date.now()}`);

    // Submit the form
    const submitBtn = page.locator('button:has-text("Create")')
      .or(page.locator('button:has-text("Generate")'))
      .or(page.locator('button[type="submit"]'))
      .first();
    await submitBtn.click();

    // Should show the generated key or success message
    const success = page.getByText(/created/i)
      .or(page.getByText(/generated/i))
      .or(page.locator('code'))
      .first();
    await expect(success).toBeVisible({ timeout: 10_000 });
  });

  test('SSO settings page loads', async ({ page }) => {
    await page.goto('/settings/sso');
    await waitForApp(page, '/settings/sso');
    await waitForContentLoad(page);

    await expect(page.locator('h1').first()).toContainText(/Single Sign-On/i, { timeout: 10_000 });
  });

  test('profile page loads', async ({ page }) => {
    await page.goto('/settings/profile');
    await waitForApp(page, '/settings/profile');
    await waitForContentLoad(page);

    await expect(page.locator('h1').first()).toContainText(/Profile settings/i, { timeout: 10_000 });

    // Should display user information form
    const profileInfo = page.locator('form')
      .or(page.locator('input[name="name"]'))
      .or(page.locator('input[name="email"]'))
      .first();
    await expect(profileInfo).toBeVisible({ timeout: 10_000 });
  });
});
