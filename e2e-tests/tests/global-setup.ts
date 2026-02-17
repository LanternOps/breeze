import { test as setup, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authDir = path.join(__dirname, '..', '.auth');
const authFile = path.join(authDir, 'user.json');

/**
 * Global setup: authenticate as the admin user and persist the storage state
 * so that every subsequent test starts already logged in.
 *
 * The Zustand auth store now persists tokens via partialize, so the storage
 * state saved here includes the access token automatically.
 */
setup('authenticate as admin', async ({ page }) => {
  // Ensure .auth directory exists
  fs.mkdirSync(authDir, { recursive: true });

  const email = process.env.E2E_ADMIN_EMAIL || 'admin@breeze.local';
  const password = process.env.E2E_ADMIN_PASSWORD || 'BreezeAdmin123!';

  await page.goto('/login');

  // Fill the login form
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('button[type="submit"]').click();

  // Wait for successful redirect to the dashboard
  await page.waitForURL('/', { timeout: 15_000 }).catch(async () => {
    const url = page.url();
    const body = await page.locator('body').textContent().catch(() => '(unreadable)');
    throw new Error(
      `Login did not redirect to dashboard.\n` +
      `  Current URL: ${url}\n` +
      `  Page text: ${body?.substring(0, 500)}`
    );
  });

  await expect(page.locator('h1')).toContainText('Dashboard');

  // Wait briefly for Zustand to persist the full auth state (user + tokens)
  await page.waitForTimeout(500);

  // Persist signed-in state so other tests reuse it
  await page.context().storageState({ path: authFile });
});
