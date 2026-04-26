// e2e-tests/playwright/pages/MonitoringSecurityPage.ts
// Covers SecurityDashboard.tsx and all security sub-pages (/security/*)
import { BasePage } from './BasePage';

export class MonitoringSecurityPage extends BasePage {
  // ── Security Dashboard ──────────────────────────────────────────────
  async gotoSecurity() {
    await this.page.goto('/security');
    await this.page.getByRole('heading', { name: 'Security' }).waitFor({ timeout: 15000 });
  }

  securityHeading() {
    return this.page.getByRole('heading', { name: 'Security' });
  }

  trackProtectionText() {
    return this.page.getByText(/Track protection coverage/);
  }

  refreshButton() {
    return this.page.getByRole('button', { name: 'Refresh' });
  }

  securityScoreCard() {
    return this.page.getByText('Security Score', { exact: true });
  }

  scoreOf100() {
    return this.page.getByText(/\/ 100/);
  }

  securityScoreDetailLink() {
    return this.page.getByRole('link', { name: 'View details' }).first();
  }

  securityScoreTrendText() {
    return this.page.getByText('Security Score Trend');
  }

  vulnerabilitiesText() {
    return this.page.getByText('Vulnerabilities', { exact: true });
  }

  antivirusCoverageText() {
    return this.page.getByText('Antivirus Coverage');
  }

  firewallStatusText() {
    return this.page.getByText('Firewall Status');
  }

  encryptionStatusText() {
    return this.page.getByText('Encryption Status');
  }

  passwordPolicyText() {
    return this.page.getByText('Password Policy');
  }

  adminAuditText() {
    return this.page.getByText('Admin Account Audit');
  }

  securityRecommendationsText() {
    return this.page.getByText('Security Recommendations');
  }

  // ── Security Score Detail (/security/score) ─────────────────────────
  async gotoSecurityScore() {
    await this.page.goto('/security/score');
    await this.page.getByText('Security Score').waitFor({ timeout: 15000 });
  }

  // ── Security sub-page generic navigate + wait ──────────────────────
  async gotoSubPage(path: string, waitForText: string) {
    await this.page.goto(path);
    await this.page.getByText(waitForText).waitFor({ timeout: 15000 });
  }

  // ── Antivirus (/security/antivirus) ────────────────────────────────
  async gotoAntivirus() {
    await this.gotoSubPage('/security/antivirus', 'Antivirus Coverage');
  }

  antivirusSearchInput() {
    return this.page.getByRole('searchbox', { name: /search/i });
  }

  // ── Firewall (/security/firewall) ──────────────────────────────────
  async gotoFirewall() {
    await this.gotoSubPage('/security/firewall', 'Firewall Status');
  }

  // ── Encryption (/security/encryption) ─────────────────────────────
  async gotoEncryption() {
    await this.gotoSubPage('/security/encryption', 'Encryption Status');
  }

  // ── Password Policy (/security/password-policy) ───────────────────
  async gotoPasswordPolicy() {
    await this.gotoSubPage('/security/password-policy', 'Password Policy');
  }

  // ── Vulnerabilities (/security/vulnerabilities) ───────────────────
  async gotoVulnerabilities() {
    await this.gotoSubPage('/security/vulnerabilities', 'Vulnerabilities');
  }

  // ── Security Trends (/security/trends) ────────────────────────────
  async gotoTrends() {
    await this.gotoSubPage('/security/trends', 'Security Trends');
  }

  // ── Recommendations (/security/recommendations) ───────────────────
  async gotoRecommendations() {
    await this.gotoSubPage('/security/recommendations', 'Security Recommendations');
  }

  // ── Admin Audit (/security/admin-audit) ───────────────────────────
  async gotoAdminAudit() {
    await this.gotoSubPage('/security/admin-audit', 'Admin Account Audit');
  }

  adminAuditPrivilegedText() {
    return this.page.getByText(/Privileged account review/);
  }

  adminSearchInput() {
    return this.page.getByPlaceholder('Search devices or users...');
  }

  tableHead() {
    return this.page.locator('table thead');
  }

  select(optionValue: string) {
    return this.page.locator(`select option[value='${optionValue}']`);
  }

  periodButton(label: string) {
    return this.page.getByRole('button', { name: label });
  }
}
