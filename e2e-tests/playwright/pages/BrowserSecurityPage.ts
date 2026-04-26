// e2e-tests/playwright/pages/BrowserSecurityPage.ts
// Covers the Security dashboard + sub-pages: /security, /security/score,
// /security/recommendations, /security/vulnerabilities, /security/trends
import { BasePage } from './BasePage';

export class BrowserSecurityPage extends BasePage {
  // ── Navigation helpers ────────────────────────────────────────────────────
  async gotoSecurity() {
    await this.page.goto('/security');
    await this.securityHeading().waitFor();
  }

  async gotoSecurityScore() {
    await this.page.goto('/security/score');
    await this.page.getByText('Security Score').first().waitFor();
  }

  async gotoRecommendations() {
    await this.page.goto('/security/recommendations');
    await this.page.getByText('Security Recommendations').first().waitFor();
  }

  async gotoVulnerabilities() {
    await this.page.goto('/security/vulnerabilities');
    await this.page.getByText('Vulnerabilities').first().waitFor();
  }

  async gotoTrends() {
    await this.page.goto('/security/trends');
    await this.page.getByText('Security Trends').first().waitFor();
  }

  // ── Security Dashboard ────────────────────────────────────────────────────
  securityHeading() {
    return this.page.getByRole('heading', { name: /Security/i }).first();
  }

  securityDescription() {
    return this.page.getByText('Track protection coverage', { exact: false });
  }

  // ── Security Score page ───────────────────────────────────────────────────
  scoreBreakdownTableHead() {
    return this.page.getByRole('table').locator('thead');
  }

  overallScoreCard() {
    return this.page.getByText('Overall Score');
  }

  gradeCard() {
    return this.page.getByText('Grade');
  }

  devicesAuditedCard() {
    return this.page.getByText('Devices Audited');
  }

  // ── Recommendations page ──────────────────────────────────────────────────
  recommendationsHeading() {
    return this.page.getByRole('heading', { name: /Security Recommendations/i });
  }

  recommendationsDescription() {
    return this.page.getByText('Prioritized remediation guidance', { exact: false });
  }

  totalRecommendationsCard() {
    return this.page.getByText('Total');
  }

  openRecommendationsCard() {
    return this.page.getByText('Open');
  }

  categoryFilterSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="antivirus"]') });
  }

  statusFilterSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="open"]') });
  }

  // ── Vulnerabilities page ──────────────────────────────────────────────────
  vulnerabilitiesTableHead() {
    return this.page.getByRole('table').locator('thead');
  }

  threatCategoryFilter() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="malware"]') });
  }

  // ── Trends page ───────────────────────────────────────────────────────────
  overallTrendButton() {
    return this.page.getByRole('button', { name: 'Overall' });
  }

  antivirusTrendButton() {
    return this.page.getByRole('button', { name: 'Antivirus' });
  }

  firewallTrendButton() {
    return this.page.getByRole('button', { name: 'Firewall' });
  }

  encryptionTrendButton() {
    return this.page.getByRole('button', { name: 'Encryption' });
  }

  vulnMgmtTrendButton() {
    return this.page.getByRole('button', { name: 'Vuln. Mgmt' });
  }

  thirtyDayButton() {
    return this.page.getByRole('button', { name: '30 Days' });
  }
}
