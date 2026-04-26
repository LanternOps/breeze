// e2e-tests/playwright/tests/auth.spec.ts
//
// Converted from:
//   e2e-tests/tests/authentication.yaml
//   e2e-tests/tests/auth_flows.yaml
//
// Uses `cleanPage` for real login/logout flows (no pre-seeded storage state).
// Uses `authedPage` only where a pre-authenticated context is appropriate.

import { test, expect } from '../fixtures';
import { LoginPage } from '../pages/LoginPage';

// ---------------------------------------------------------------------------
// Authentication flows (authentication.yaml)
// ---------------------------------------------------------------------------

test.describe('Authentication', () => {
  test('login and logout flow', async ({ cleanPage: page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Login
    await loginPage.login(
      process.env.E2E_ADMIN_EMAIL!,
      process.env.E2E_ADMIN_PASSWORD!,
    );
    await page.waitForURL('**/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome');

    // Verify dashboard loaded
    await expect(page.getByText('Dashboard')).toBeVisible();

    // Logout via account menu
    // Use title "Account menu" to disambiguate from the Theme menu (both have
    // aria-haspopup; Theme is rendered first — see authentication.yaml comment).
    await page.getByRole('button', { name: 'Account menu' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/login**');
  });

  test('invalid login attempt shows error and stays on login page', async ({ cleanPage: page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    await loginPage.login('invalid@example.com', 'WrongPassword123!');

    // Error message contains "Invalid"
    await expect(page.getByText(/invalid/i)).toBeVisible({ timeout: 10_000 });

    // Still on login page — submit button still present
    await expect(loginPage.submitButton()).toBeVisible();
  });

  test('forgot password client-side email validation', async ({ cleanPage: page }) => {
    await page.goto('/forgot-password');
    await page.getByRole('button', { name: /send reset link/i }).waitFor();

    // Fill invalid email and submit — zod triggers "Enter a valid email address"
    await page.getByLabel('Email').fill('notanemail');
    await page.getByRole('button', { name: /send reset link/i }).click();
    await expect(page.getByText('Enter a valid email address')).toBeVisible({ timeout: 5_000 });
  });

  test('reset password page without token shows invalid link', async ({ cleanPage: page }) => {
    await page.goto('/reset-password');
    await expect(page.getByText('Invalid Link')).toBeVisible({ timeout: 10_000 });

    // Heading
    await expect(page.getByRole('heading', { name: /invalid link/i })).toBeVisible();
    // Explanatory text
    await expect(page.getByText(/invalid or has expired/i)).toBeVisible();
  });

  test('accept invite page without token shows invalid link', async ({ cleanPage: page }) => {
    await page.goto('/accept-invite');
    await expect(page.getByText('Invalid Link')).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole('heading', { name: /invalid link/i })).toBeVisible();
    await expect(page.getByText(/invite link is invalid or has expired/i)).toBeVisible();
  });

  test('accept invite page with token shows set-password form', async ({ cleanPage: page }) => {
    await page.goto('/accept-invite?token=test-invite-token-123');
    await page.getByRole('button', { name: /set password/i }).waitFor({ timeout: 10_000 });

    await expect(page.getByLabel('New password')).toBeVisible();
    await expect(page.getByLabel('Confirm password')).toBeVisible();
    await expect(page.getByRole('button', { name: /set password/i })).toBeVisible();
  });

  test('session persists across page navigations', async ({ cleanPage: page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(
      process.env.E2E_ADMIN_EMAIL!,
      process.env.E2E_ADMIN_PASSWORD!,
    );
    await page.waitForURL('**/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome');

    // Navigate to several sections — should remain authenticated throughout
    await page.goto('/devices');
    await expect(page.getByText(/device/i)).toBeVisible({ timeout: 10_000 });

    await page.goto('/scripts');
    await expect(page.getByText(/script/i)).toBeVisible({ timeout: 10_000 });

    await page.goto('/alerts');
    await expect(page.getByText(/alert/i)).toBeVisible({ timeout: 10_000 });

    await page.goto('/settings');
    await expect(page.getByText(/settings/i)).toBeVisible({ timeout: 10_000 });

    // Back to dashboard — still logged in
    await page.goto('/');
    await expect(page.getByText('Dashboard')).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Auth flows — page renders and client-side validation (auth_flows.yaml)
// ---------------------------------------------------------------------------

test.describe('Auth Flows', () => {
  // --- Forgot Password ---

  test('forgot password page renders form and sign-in link', async ({ cleanPage: page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').waitFor({ timeout: 15_000 });

    // Input attributes
    const emailInput = page.getByLabel('Email');
    await expect(emailInput).toHaveAttribute('type', 'email');
    await expect(emailInput).toHaveAttribute('placeholder', 'you@company.com');

    // Submit button
    await expect(page.getByRole('button', { name: /send reset link/i })).toBeVisible();

    // Back to sign-in link
    await expect(page.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
  });

  test('forgot password client-side validation — invalid and empty email', async ({ cleanPage: page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').waitFor({ timeout: 15_000 });

    // Invalid email
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByRole('button', { name: /send reset link/i }).click();
    await expect(page.getByText('Enter a valid email address')).toBeVisible({ timeout: 5_000 });

    // Empty email
    await page.getByLabel('Email').fill('');
    await page.getByRole('button', { name: /send reset link/i }).click();
    await expect(page.getByText('Enter a valid email address')).toBeVisible({ timeout: 5_000 });
  });

  // --- Reset Password ---

  test('reset password page without token shows invalid link with request-new-link CTA', async ({ cleanPage: page }) => {
    await page.goto('/reset-password');
    await expect(page.getByText('Invalid Link')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole('heading', { name: /invalid link/i })).toBeVisible();
    await expect(page.getByText(/invalid or has expired/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /request a new link/i })).toBeVisible();
  });

  test('reset password form renders correctly with token', async ({ cleanPage: page }) => {
    await page.goto('/reset-password?token=test-token-abc123');
    await page.getByLabel('New password').waitFor({ timeout: 15_000 });

    // Labels and inputs
    await expect(page.getByLabel('New password')).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('Confirm password')).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: /reset password/i })).toBeVisible();
  });

  test('reset password form — password mismatch validation', async ({ cleanPage: page }) => {
    await page.goto('/reset-password?token=test-token-abc123');
    await page.getByLabel('New password').waitFor({ timeout: 15_000 });

    await page.getByLabel('New password').fill('NewPass123!');
    await page.getByLabel('Confirm password').fill('DifferentPass456!');
    await page.getByRole('button', { name: /reset password/i }).click();
    await expect(page.getByText('Passwords do not match')).toBeVisible({ timeout: 5_000 });
  });

  test('reset password form — short password validation', async ({ cleanPage: page }) => {
    await page.goto('/reset-password?token=test-token-abc123');
    await page.getByLabel('New password').waitFor({ timeout: 15_000 });

    await page.getByLabel('New password').fill('short');
    await page.getByLabel('Confirm password').fill('short');
    await page.getByRole('button', { name: /reset password/i }).click();
    await expect(page.getByText('Password must be at least 8 characters')).toBeVisible({ timeout: 5_000 });
  });

  // --- Register Partner ---

  test('register partner page renders all form fields', async ({ cleanPage: page }) => {
    await page.goto('/register-partner');
    await page.getByLabel('Company name').waitFor({ timeout: 15_000 });

    await expect(page.getByLabel('Company name')).toHaveAttribute('placeholder', 'Acme IT Services');
    await expect(page.getByLabel('Full name')).toHaveAttribute('placeholder', 'Jane Doe');
    await expect(page.getByLabel('Work email')).toHaveAttribute('type', 'email');
    // Use exact:false because password field label is "Password" but confirm label
    // is "Confirm password" — getByLabel('Password') would match both; target by id.
    await expect(page.locator('#password')).toHaveAttribute('type', 'password');
    await expect(page.locator('#confirmPassword')).toHaveAttribute('type', 'password');
    await expect(page.locator('#acceptTerms')).toHaveAttribute('type', 'checkbox');
    await expect(page.getByRole('button', { name: /create company account/i })).toBeVisible();
  });

  test('register partner page renders terms and privacy links', async ({ cleanPage: page }) => {
    await page.goto('/register-partner');
    await page.getByLabel('Company name').waitFor({ timeout: 15_000 });

    await expect(page.getByRole('link', { name: /terms of service/i })).toHaveAttribute(
      'href',
      'https://breezermm.com/legal/terms-of-service',
    );
    await expect(page.getByRole('link', { name: /privacy policy/i })).toHaveAttribute(
      'href',
      'https://breezermm.com/legal/privacy-policy',
    );
  });

  test('register partner form validation — password mismatch', async ({ cleanPage: page }) => {
    // NOTE: PartnerRegisterForm uses mode:'onBlur' and only renders error text
    // when a field has been touched (blurred). The YAML's "submit empty form"
    // step won't show errors for untouched fields. Instead we fill + blur each
    // required field, then test password mismatch which fires on submit.
    await page.goto('/register-partner');
    await page.getByLabel('Company name').waitFor({ timeout: 15_000 });

    await page.getByLabel('Company name').fill('Acme IT');
    await page.getByLabel('Full name').fill('Jane Doe');
    await page.getByLabel('Work email').fill('jane@acmeit.com');
    await page.locator('#password').fill('SecurePass123!');
    await page.locator('#confirmPassword').fill('DifferentPass456!');
    // Blur confirmPassword to mark it as touched before submitting
    await page.locator('#confirmPassword').blur();
    await page.getByRole('button', { name: /create company account/i }).click();
    await expect(page.getByText('Passwords do not match')).toBeVisible({ timeout: 5_000 });
  });

  test('register partner form validation — terms not accepted', async ({ cleanPage: page }) => {
    await page.goto('/register-partner');
    await page.getByLabel('Company name').waitFor({ timeout: 15_000 });

    await page.getByLabel('Company name').fill('Acme IT');
    await page.getByLabel('Full name').fill('Jane Doe');
    await page.getByLabel('Work email').fill('jane@acmeit.com');
    await page.locator('#password').fill('SecurePass123!');
    await page.locator('#confirmPassword').fill('SecurePass123!');
    await page.getByRole('button', { name: /create company account/i }).click();
    await expect(page.getByText('You must accept the terms of service')).toBeVisible({ timeout: 5_000 });
  });

  // --- Accept Invite ---

  test('accept invite page without token shows invalid link', async ({ cleanPage: page }) => {
    await page.goto('/accept-invite');
    await expect(page.getByText('Invalid Link')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole('heading', { name: /invalid link/i })).toBeVisible();
    await expect(page.getByText(/invite link is invalid or has expired/i)).toBeVisible();
  });

  test('accept invite form renders with token', async ({ cleanPage: page }) => {
    await page.goto('/accept-invite?token=invite-token-xyz789');
    await page.getByLabel('New password').waitFor({ timeout: 15_000 });

    await expect(page.getByLabel('New password')).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('Confirm password')).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: /set password & sign in/i })).toBeVisible();
  });

  // --- Register redirect ---

  test('/register redirects to /register-partner', async ({ cleanPage: page }) => {
    await page.goto('/register');
    await page.waitForURL('**/register-partner**', { timeout: 10_000 });
  });
});
