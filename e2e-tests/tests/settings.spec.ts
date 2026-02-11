import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test('organization settings page loads', async ({ page }) => {
    await page.goto('/settings/organization');

    await expect(page.locator('h1, h2').first()).toContainText(/Organization|Settings/i, { timeout: 10_000 });

    // Should show org settings form or information
    const content = page.locator(
      'form, [data-testid="org-settings"], text=Organization, input[name]',
    ).first();
    await expect(content).toBeVisible({ timeout: 10_000 });
  });

  test('user management page loads', async ({ page }) => {
    await page.goto('/settings/users');

    await expect(page.locator('h1, h2').first()).toContainText(/User|Team|Member/i, { timeout: 10_000 });

    // Should show a user list or invite button
    const listOrInvite = page.locator(
      'table, [data-testid="user-list"], button:has-text("Invite"), button:has-text("Add"), text=No users',
    ).first();
    await expect(listOrInvite).toBeVisible({ timeout: 10_000 });
  });

  test('role management page loads', async ({ page }) => {
    await page.goto('/settings/roles');

    await expect(page.locator('h1, h2').first()).toContainText(/Role|Permission/i, { timeout: 10_000 });

    // Should show roles list or create button
    const rolesContent = page.locator(
      'table, [data-testid="roles-list"], button:has-text("New"), button:has-text("Create"), text=No roles',
    ).first();
    await expect(rolesContent).toBeVisible({ timeout: 10_000 });
  });

  test('API keys page loads', async ({ page }) => {
    await page.goto('/settings/api-keys');

    await expect(page.locator('h1, h2').first()).toContainText(/API|Key/i, { timeout: 10_000 });

    // Should show existing keys or create button
    const keysContent = page.locator(
      'table, [data-testid="api-keys-list"], button:has-text("Create"), button:has-text("Generate"), text=No API keys',
    ).first();
    await expect(keysContent).toBeVisible({ timeout: 10_000 });
  });

  test('API key creation flow', async ({ page }) => {
    await page.goto('/settings/api-keys');

    // Look for create button
    const createBtn = page.locator(
      'button:has-text("Create"), button:has-text("Generate"), button:has-text("New")',
    ).first();

    const hasCreate = await createBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    test.skip(!hasCreate, 'No API key create button found');

    await createBtn.click();

    // Should show a form or modal for API key creation
    const nameInput = page.locator(
      '[name="name"], [name="label"], input[placeholder*="name" i], input[placeholder*="label" i]',
    ).first();
    await expect(nameInput).toBeVisible({ timeout: 5_000 });

    await nameInput.fill(`E2E Test Key ${Date.now()}`);

    // Submit the form
    const submitBtn = page.locator(
      'button:has-text("Create"), button:has-text("Generate"), button[type="submit"]',
    ).first();
    await submitBtn.click();

    // Should show the generated key or success message
    const success = page.locator(
      'text=created, text=generated, [data-testid="api-key-value"], code',
    ).first();
    await expect(success).toBeVisible({ timeout: 10_000 });
  });

  test('SSO settings page loads', async ({ page }) => {
    await page.goto('/settings/sso');

    await expect(page.locator('h1, h2').first()).toContainText(/SSO|Single Sign|SAML|OIDC/i, { timeout: 10_000 });
  });

  test('profile page loads', async ({ page }) => {
    await page.goto('/settings/profile');

    await expect(page.locator('h1, h2').first()).toContainText(/Profile|Account/i, { timeout: 10_000 });

    // Should display user information
    const profileInfo = page.locator(
      'form, input[name="name"], input[name="email"], [data-testid="profile-form"]',
    ).first();
    await expect(profileInfo).toBeVisible({ timeout: 10_000 });
  });
});
