import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Log in as the admin user defined by environment variables.
 * After calling this the page will be on the dashboard.
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  const email = process.env.E2E_ADMIN_EMAIL || 'admin@breeze.test';
  const password = process.env.E2E_ADMIN_PASSWORD || 'TestPassword123!';
  await loginAsUser(page, email, password);
}

/**
 * Log in with arbitrary credentials.
 * Navigates to /login, fills the form, clicks submit, and waits for the
 * dashboard to load.
 */
export async function loginAsUser(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('button[type="submit"]').click();

  // Wait for redirect to dashboard
  await page.waitForURL('/', { timeout: 15_000 });
  await expect(page.locator('h1')).toContainText('Dashboard');
}

/**
 * Log out the current user via the UI.
 * Assumes the user is on any authenticated page with a profile/user menu.
 */
export async function logout(page: Page): Promise<void> {
  // Open user menu (adjust selector if needed based on actual UI)
  const userMenu = page.locator('[data-testid="user-menu"], button:has-text("Account"), button:has-text("Profile")').first();
  if (await userMenu.isVisible()) {
    await userMenu.click();
  }

  const logoutButton = page.locator('button:has-text("Log out"), button:has-text("Sign out"), a:has-text("Log out"), a:has-text("Sign out")').first();
  await logoutButton.click();

  // Should redirect to login
  await page.waitForURL('**/login', { timeout: 10_000 });
}
