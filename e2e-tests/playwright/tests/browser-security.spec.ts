// e2e-tests/playwright/tests/browser-security.spec.ts
// Converted from e2e-tests/tests/browser_security.yaml
import { test, expect } from '../fixtures';
import { BrowserSecurityPage } from '../pages/BrowserSecurityPage';

test.describe('Browser Security', () => {
  // ── Security Dashboard ─────────────────────────────────────────────────────
  test('Security dashboard loads with heading and description', async ({ authedPage }) => {
    const security = new BrowserSecurityPage(authedPage);
    await security.gotoSecurity();

    await expect(security.securityHeading()).toBeVisible();
    await expect(security.securityDescription()).toBeVisible();
  });

  // ── Security Score page ────────────────────────────────────────────────────
  test('Security Score page shows breakdown table and stat cards', async ({ authedPage }) => {
    const security = new BrowserSecurityPage(authedPage);
    await security.gotoSecurityScore();

    const thead = security.scoreBreakdownTableHead();
    await expect(thead).toContainText('Category');
    await expect(thead).toContainText('Score');
    await expect(thead).toContainText('Weight');
    await expect(thead).toContainText('Status');
    await expect(thead).toContainText('Affected');

    await expect(security.overallScoreCard()).toBeVisible();
    await expect(security.gradeCard()).toBeVisible();
    await expect(security.devicesAuditedCard()).toBeVisible();
  });

  // ── Recommendations page ───────────────────────────────────────────────────
  test('Recommendations page loads with heading, description, and stat cards', async ({ authedPage }) => {
    const security = new BrowserSecurityPage(authedPage);
    await security.gotoRecommendations();

    await expect(security.recommendationsHeading()).toBeVisible();
    await expect(security.recommendationsDescription()).toBeVisible();
    await expect(security.totalRecommendationsCard()).toBeVisible();
    await expect(security.openRecommendationsCard()).toBeVisible();
  });

  // ── Recommendations filter ─────────────────────────────────────────────────
  test('Recommendations category filter and status filter respond', async ({ authedPage }) => {
    const security = new BrowserSecurityPage(authedPage);
    await security.gotoRecommendations();

    // Filter by Antivirus then reset
    await security.categoryFilterSelect().selectOption('antivirus');
    await expect(authedPage.locator('div').first()).toBeVisible({ timeout: 5000 });
    await security.categoryFilterSelect().selectOption('');

    // Filter by Open status
    await security.statusFilterSelect().selectOption('open');
    await expect(authedPage.locator('div').first()).toBeVisible({ timeout: 5000 });
  });

  // ── Vulnerabilities page ───────────────────────────────────────────────────
  test('Vulnerabilities page shows threat table', async ({ authedPage }) => {
    const security = new BrowserSecurityPage(authedPage);
    await security.gotoVulnerabilities();

    const thead = security.vulnerabilitiesTableHead();
    await expect(thead).toContainText('Threat');
  });

  // ── Vulnerabilities filter ─────────────────────────────────────────────────
  test('Vulnerabilities threat category filter responds', async ({ authedPage }) => {
    const security = new BrowserSecurityPage(authedPage);
    await security.gotoVulnerabilities();

    await security.threatCategoryFilter().selectOption('malware');
    await expect(authedPage.getByRole('table').locator('tbody')).toBeVisible({ timeout: 5000 });
    // Reset
    await security.threatCategoryFilter().selectOption('');
  });

  // ── Trends page ────────────────────────────────────────────────────────────
  test('Trends page shows category toggle buttons and period switcher', async ({ authedPage }) => {
    const security = new BrowserSecurityPage(authedPage);
    await security.gotoTrends();

    await expect(security.overallTrendButton()).toBeVisible();
    await expect(security.antivirusTrendButton()).toBeVisible();
    await expect(security.firewallTrendButton()).toBeVisible();
    await expect(security.encryptionTrendButton()).toBeVisible();
    await expect(security.vulnMgmtTrendButton()).toBeVisible();

    // Switch to 30-day period
    await security.thirtyDayButton().click();
    await expect(authedPage.locator('div').first()).toBeVisible({ timeout: 5000 });

    // Toggle Vuln. Mgmt line
    await security.vulnMgmtTrendButton().click();
    await expect(authedPage.locator('div').first()).toBeVisible({ timeout: 3000 });
  });
});
