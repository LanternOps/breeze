import { test as setup, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.join(__dirname, '..', '.auth', 'user.json');

/**
 * Global setup: authenticate as the admin user and persist the storage state
 * so that every subsequent test starts already logged in.
 */
setup('authenticate as admin', async ({ page }) => {
  const email = process.env.E2E_ADMIN_EMAIL || 'admin@breeze.test';
  const password = process.env.E2E_ADMIN_PASSWORD || 'TestPassword123!';

  await page.goto('/login');

  // Fill the login form — fields use react-hook-form `register('email')` / `register('password')`
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('button[type="submit"]').click();

  // Wait for successful redirect to the dashboard
  await page.waitForURL('/', { timeout: 15_000 });
  await expect(page.locator('h1')).toContainText('Dashboard');

  // Persist signed-in state so other tests reuse it
  await page.context().storageState({ path: authFile });
});
