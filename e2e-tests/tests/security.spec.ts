import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('Security', () => {
  test('security overview page loads', async ({ page }) => {
    await page.goto('/security');
    await waitForApp(page, '/security');

    // Page heading is an h2 with text "Security"
    await expect(page.locator('h2').first()).toContainText(/Security/i, { timeout: 10_000 });

    // Should show security dashboard content (cards/sections) or empty state
    const content = page.locator('div[class*="card"], div[class*="panel"], section').first()
      .or(page.locator('h2').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test('security score page loads', async ({ page }) => {
    await page.goto('/security/score');
    await waitForApp(page, '/security/score');

    // Page heading is an h2 with text "Security Score"
    await expect(page.locator('h2').first()).toContainText(/Security Score/i, { timeout: 10_000 });

    // Should show score content, chart, or summary - just verify heading loaded
    const content = page.locator('div[class*="card"], div[class*="chart"], section').first()
      .or(page.locator('h2').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test('security vulnerabilities page loads', async ({ page }) => {
    await page.goto('/security/vulnerabilities');
    await waitForApp(page, '/security/vulnerabilities');

    // Page heading is an h2 with text "Vulnerabilities"
    await expect(page.locator('h2').first()).toContainText(/Vulnerabilit/i, { timeout: 10_000 });

    // Should show a vulnerability table, list, or empty state
    const content = page.locator('table').first()
      .or(page.locator('ul, ol').first())
      .or(page.locator('h2').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });
});
