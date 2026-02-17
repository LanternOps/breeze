import type { Page } from '@playwright/test';

/**
 * Wait for the authenticated app shell to finish loading.
 *
 * After navigating to an authenticated page, the AuthOverlay component checks
 * auth state and may briefly show a loading spinner. This helper waits for the
 * sidebar `<aside>` element to become visible, which confirms that auth
 * succeeded and the DashboardLayout has fully rendered.
 *
 * If the page ends up on /login (auth failed), it re-authenticates and
 * navigates back to the target path.
 */
export async function waitForApp(page: Page, targetPath?: string): Promise<void> {
  const sidebar = page.locator('aside').first();

  try {
    await sidebar.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    // AuthOverlay may have redirected to /login
    if (page.url().includes('/login')) {
      const email = process.env.E2E_ADMIN_EMAIL || 'admin@breeze.local';
      const password = process.env.E2E_ADMIN_PASSWORD || 'BreezeAdmin123!';

      await page.locator('#email').fill(email);
      await page.locator('#password').fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL('/', { timeout: 15_000 });

      // Navigate back to the originally requested page
      if (targetPath && targetPath !== '/' && targetPath !== '') {
        await page.goto(targetPath);
        await sidebar.waitFor({ state: 'visible', timeout: 15_000 });
      }
    } else {
      // Not a login redirect — re-throw so the test fails with the real error
      throw new Error(`App did not load within timeout (current URL: ${page.url()})`);
    }
  }
}
