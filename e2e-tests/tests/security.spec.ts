import { test, expect } from '@playwright/test';

test.describe('Security', () => {
  test('security overview page loads', async ({ page }) => {
    await page.goto('/security');

    // Page heading should reference security
    await expect(page.locator('h1, h2').first()).toContainText(/Security/i, { timeout: 10_000 });

    // Should show security dashboard content or empty state
    const content = page.locator(
      'table, [data-testid="security-overview"], [data-testid="empty-state"], text=No security, [data-testid="security-score"]',
    ).first()
      .or(page.locator('div[class*="card"], div[class*="panel"], section').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test('security score page loads', async ({ page }) => {
    await page.goto('/security/score');

    // Page heading should reference score or security
    await expect(page.locator('h1, h2').first()).toContainText(/Score|Security/i, { timeout: 10_000 });

    // Should show score content, chart, or summary
    const content = page.locator(
      '[data-testid="security-score"], [data-testid="score-card"], table, text=score',
    ).first()
      .or(page.locator('div[class*="card"], div[class*="chart"], section').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test('security vulnerabilities page loads', async ({ page }) => {
    await page.goto('/security/vulnerabilities');

    // Page heading should reference vulnerabilities or security
    await expect(page.locator('h1, h2').first()).toContainText(/Vulnerabilit|Security/i, { timeout: 10_000 });

    // Should show a vulnerability list, table, or empty state
    const content = page.locator(
      'table, [data-testid="vulnerability-list"], [data-testid="empty-state"], text=No vulnerabilities',
    ).first()
      .or(page.locator('ul, ol, [role="list"]').first());
    await expect(content).toBeVisible({ timeout: 15_000 });
  });
});
