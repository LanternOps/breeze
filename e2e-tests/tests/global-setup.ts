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
 */
setup('authenticate as admin', async ({ page }) => {
  // Ensure .auth directory exists
  fs.mkdirSync(authDir, { recursive: true });

  const email = process.env.E2E_ADMIN_EMAIL || 'admin@breeze.local';
  const password = process.env.E2E_ADMIN_PASSWORD || 'BreezeAdmin123!';

  // Intercept the login API response to capture the access token.
  // The Zustand persist middleware only stores `user` to localStorage,
  // so subsequent tests would need a refresh-cookie round trip to get
  // an access token. That cross-port fetch is unreliable in CI, so we
  // inject the token into localStorage directly.
  let capturedTokens: { accessToken: string; expiresInSeconds: number } | null = null;

  page.on('response', async (response) => {
    if (response.url().includes('/auth/login') && response.ok()) {
      try {
        const body = await response.json();
        if (body.tokens?.accessToken) {
          capturedTokens = body.tokens;
        }
      } catch {
        // ignore parse errors
      }
    }
  });

  await page.goto('/login');

  // Fill the login form
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('button[type="submit"]').click();

  // Wait for successful redirect to the dashboard
  await page.waitForURL('/', { timeout: 15_000 }).catch(async () => {
    // Capture diagnostic info on failure
    const url = page.url();
    const body = await page.locator('body').textContent().catch(() => '(unreadable)');
    throw new Error(
      `Login did not redirect to dashboard.\n` +
      `  Current URL: ${url}\n` +
      `  Page text: ${body?.substring(0, 500)}`
    );
  });

  await expect(page.locator('h1')).toContainText('Dashboard');

  // Inject the captured access token into the Zustand localStorage state.
  // This ensures subsequent tests have a valid access token immediately,
  // without needing a refresh-cookie round trip that can fail in CI.
  if (capturedTokens) {
    await page.evaluate((tokens) => {
      const key = 'breeze-auth';
      const raw = localStorage.getItem(key);
      if (!raw) return;

      const store = JSON.parse(raw);
      if (store.state) {
        store.state.tokens = tokens;
        store.state.isAuthenticated = true;
        localStorage.setItem(key, JSON.stringify(store));
      }
    }, capturedTokens);
  }

  // Persist signed-in state so other tests reuse it
  await page.context().storageState({ path: authFile });
});
