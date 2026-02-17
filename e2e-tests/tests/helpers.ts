import type { Page } from '@playwright/test';

/**
 * Wait for the authenticated app shell to finish loading.
 *
 * Most pages use DashboardLayout (sidebar + header). We wait for the sidebar
 * `<aside>` element. For pages that use the bare Layout (e.g. /settings/organization),
 * we fall back to waiting for any h1 or main content to appear.
 *
 * If the page ends up on /login (auth failed), it re-authenticates and
 * navigates back to the target path.
 */
export async function waitForApp(page: Page, targetPath?: string): Promise<void> {
  // Wait for network to settle and React to hydrate
  const sidebar = page.locator('aside').first();
  const mainContent = page.locator('main, h1, [role="main"]').first();

  try {
    // Try sidebar first (DashboardLayout pages)
    await sidebar.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    // Check if we got redirected to /login
    if (page.url().includes('/login')) {
      const email = process.env.E2E_ADMIN_EMAIL || 'admin@breeze.local';
      const password = process.env.E2E_ADMIN_PASSWORD || 'BreezeAdmin123!';

      await page.locator('#email').fill(email);
      await page.locator('#password').fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL('/', { timeout: 15_000 });

      if (targetPath && targetPath !== '/' && targetPath !== '') {
        await page.goto(targetPath);
        try {
          await sidebar.waitFor({ state: 'visible', timeout: 10_000 });
        } catch {
          // Page may not have a sidebar (e.g. /settings/organization)
          await mainContent.waitFor({ state: 'visible', timeout: 10_000 });
        }
      }
    } else {
      // No sidebar — page may use bare Layout. Wait for main content instead.
      try {
        await mainContent.waitFor({ state: 'visible', timeout: 10_000 });
      } catch {
        throw new Error(`App did not load within timeout (current URL: ${page.url()})`);
      }
    }
  }
}
