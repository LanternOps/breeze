import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  // Auth tests do NOT use the stored auth state — they exercise the login flow itself.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('login with valid credentials redirects to dashboard', async ({ page }) => {
    const email = process.env.E2E_ADMIN_EMAIL || 'admin@breeze.test';
    const password = process.env.E2E_ADMIN_PASSWORD || 'TestPassword123!';

    await page.goto('/login');

    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.locator('button[type="submit"]').click();

    // Should redirect to dashboard
    await page.waitForURL('/', { timeout: 15_000 });
    await expect(page.locator('h1')).toContainText('Dashboard');
  });

  test('login with invalid credentials shows error', async ({ page }) => {
    await page.goto('/login');

    await page.locator('#email').fill('wrong@example.com');
    await page.locator('#password').fill('WrongPassword123!');
    await page.locator('button[type="submit"]').click();

    // Should show an error message — the API returns "Invalid email or password"
    const errorBanner = page.locator('.text-destructive, [role="alert"]').first();
    await expect(errorBanner).toBeVisible({ timeout: 10_000 });
    await expect(errorBanner).toContainText(/invalid|error|incorrect/i);

    // Should stay on the login page
    await expect(page).toHaveURL(/\/login/);
  });

  test('login with MFA prompts for TOTP code', async ({ page }) => {
    // This test requires an MFA-enabled test account.
    // If E2E_MFA_EMAIL / E2E_MFA_PASSWORD are not set, skip gracefully.
    const mfaEmail = process.env.E2E_MFA_EMAIL;
    const mfaPassword = process.env.E2E_MFA_PASSWORD;
    test.skip(!mfaEmail || !mfaPassword, 'Skipping MFA test — E2E_MFA_EMAIL / E2E_MFA_PASSWORD not set');

    await page.goto('/login');

    await page.locator('#email').fill(mfaEmail!);
    await page.locator('#password').fill(mfaPassword!);
    await page.locator('button[type="submit"]').click();

    // Should show the MFA verification form
    await expect(
      page.locator('text=Enter your verification code'),
    ).toBeVisible({ timeout: 10_000 });

    // The Verify button should be present
    await expect(
      page.locator('button[type="submit"]:has-text("Verify")'),
    ).toBeVisible();
  });

  test('logout redirects to login page', async ({ page }) => {
    // First, log in
    const email = process.env.E2E_ADMIN_EMAIL || 'admin@breeze.test';
    const password = process.env.E2E_ADMIN_PASSWORD || 'TestPassword123!';

    await page.goto('/login');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('/', { timeout: 15_000 });

    // Now log out — look for a user menu or direct logout link
    const logoutTrigger = page.locator(
      '[data-testid="user-menu"], button:has-text("Account"), button:has-text("Profile")',
    ).first();

    if (await logoutTrigger.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await logoutTrigger.click();
    }

    const logoutButton = page.locator(
      'button:has-text("Log out"), button:has-text("Sign out"), a:has-text("Log out"), a:has-text("Sign out")',
    ).first();
    await logoutButton.click({ timeout: 5_000 });

    // Should redirect to login
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test('password reset flow shows confirmation', async ({ page }) => {
    await page.goto('/login');

    // Click "Forgot password?" link
    await page.locator('a:has-text("Forgot password")').click();
    await expect(page).toHaveURL(/\/forgot-password/);

    // Fill the email and submit
    await page.locator('input[type="email"], #email, input[name="email"]').first().fill('test@breeze.test');
    await page.locator('button[type="submit"]').click();

    // Should show confirmation message
    await expect(
      page.locator('text=Check your email').or(page.locator('text=reset link')),
    ).toBeVisible({ timeout: 10_000 });
  });
});
