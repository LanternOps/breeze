import type { Page } from '@playwright/test';

/**
 * Wait for React component loading spinners to disappear.
 *
 * All React page components (AutomationsPage, DevicesPage, PoliciesPage, etc.)
 * use the same loading gate pattern:
 *   if (loading) return <div><div class="animate-spin ..."/><p>Loading...</p></div>
 *
 * This hides ALL content (h1, tables, etc.) until the API fetch completes.
 * Call this after waitForApp() and before content assertions.
 */
export async function waitForContentLoad(page: Page, timeout = 20_000): Promise<void> {
  const spinner = page.locator('.animate-spin').first();
  try {
    // Wait briefly for the spinner to appear; if it never appears, content loaded fast
    await spinner.waitFor({ state: 'visible', timeout: 2_000 });
  } catch {
    // Spinner never appeared — content loaded without a loading state
    return;
  }
  // Spinner is visible — wait for it to disappear (do NOT catch; surface stuck-spinner errors)
  await spinner.waitFor({ state: 'hidden', timeout });
}

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
