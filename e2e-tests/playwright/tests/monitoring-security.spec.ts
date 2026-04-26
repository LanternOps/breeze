// e2e-tests/playwright/tests/monitoring-security.spec.ts
import { test, expect } from '../fixtures';
import { MonitoringSecurityPage } from '../pages/MonitoringSecurityPage';

test.describe('Security Dashboard', () => {
  test('security dashboard loads with heading and refresh button', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoSecurity();
    await expect(sec.securityHeading()).toBeVisible();
    await expect(sec.trackProtectionText()).toBeVisible();
    await expect(sec.refreshButton()).toBeVisible();
    await sec.refreshButton().click(); // verify it's clickable
  });

  test('security score card is present with /100 and view details link', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoSecurity();
    await expect(sec.securityScoreCard()).toBeVisible();
    await expect(sec.scoreOf100()).toBeVisible();
    await expect(authedPage.getByRole('link', { name: 'View details' }).first()).toBeVisible();
  });

  test('security trend, vuln, antivirus, firewall, encryption cards are present', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoSecurity();
    await expect(sec.securityScoreTrendText()).toBeVisible();
    await expect(sec.vulnerabilitiesText()).toBeVisible();
    await expect(sec.antivirusCoverageText()).toBeVisible();
    await expect(sec.firewallStatusText()).toBeVisible();
    await expect(sec.encryptionStatusText()).toBeVisible();
  });

  test('password policy, admin audit, and recommendations cards are present', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoSecurity();
    await expect(sec.passwordPolicyText()).toBeVisible();
    await expect(sec.adminAuditText()).toBeVisible();
    await expect(sec.securityRecommendationsText()).toBeVisible();
  });
});

test.describe('Security Score Detail', () => {
  test('score detail page shows stat cards and breakdown table', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoSecurityScore();
    await expect(authedPage.getByText('Security Score').first()).toBeVisible();
    await expect(authedPage.getByText(/Score breakdown by category/)).toBeVisible();
    await expect(authedPage.getByText('Overall Score')).toBeVisible();
    await expect(authedPage.getByText('Grade')).toBeVisible();
    await expect(authedPage.getByText('Devices Audited')).toBeVisible();
  });

  test('score breakdown table has expected columns', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoSecurityScore();
    const thead = sec.tableHead();
    await expect(thead.getByText('Category')).toBeVisible();
    await expect(thead.getByText('Score')).toBeVisible();
    await expect(thead.getByText('Weight')).toBeVisible();
    await expect(thead.getByText('Status')).toBeVisible();
    await expect(thead.getByText('Affected')).toBeVisible();
  });
});

test.describe('Antivirus Coverage Page', () => {
  test('antivirus page shows stat cards and table columns', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoAntivirus();
    await expect(authedPage.getByText('Antivirus Coverage').first()).toBeVisible();
    await expect(authedPage.getByText(/Endpoint protection status/)).toBeVisible();
    await expect(authedPage.getByText('Total Devices')).toBeVisible();
    await expect(authedPage.getByText('Protected').first()).toBeVisible();
    await expect(authedPage.getByText('Unprotected').first()).toBeVisible();
    await expect(authedPage.getByText('Coverage')).toBeVisible();
  });

  test('antivirus table has correct columns', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoAntivirus();
    const thead = sec.tableHead();
    await expect(thead.getByText('Device')).toBeVisible();
    await expect(thead.getByText('OS')).toBeVisible();
    await expect(thead.getByText('Provider')).toBeVisible();
    await expect(thead.getByText('Status')).toBeVisible();
    await expect(thead.getByText('Real-time')).toBeVisible();
  });

  test('filter by protected status', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoAntivirus();
    await authedPage.locator('select').filter({ has: authedPage.locator("option[value='protected']") }).selectOption('protected');
    await authedPage.waitForTimeout(1000);
    await expect(authedPage.locator('table tbody')).toBeVisible();
  });
});

test.describe('Firewall Status Page', () => {
  test('firewall page shows stat cards and table columns', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoFirewall();
    await expect(authedPage.getByText('Total Devices').first()).toBeVisible();
    await expect(authedPage.getByText('Enabled').first()).toBeVisible();
    await expect(authedPage.getByText('Disabled').first()).toBeVisible();
    await expect(authedPage.getByText('Coverage').first()).toBeVisible();
    const thead = sec.tableHead();
    await expect(thead.getByText('Device')).toBeVisible();
    await expect(thead.getByText('OS')).toBeVisible();
    await expect(thead.getByText('Firewall')).toBeVisible();
    await expect(thead.getByText('Rules')).toBeVisible();
  });
});

test.describe('Encryption Status Page', () => {
  test('encryption page shows stat cards and table columns', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoEncryption();
    await expect(authedPage.getByText('Total Devices').first()).toBeVisible();
    await expect(authedPage.getByText('Fully Encrypted')).toBeVisible();
    await expect(authedPage.getByText('Partial')).toBeVisible();
    await expect(authedPage.getByText('Unencrypted')).toBeVisible();
    await expect(authedPage.getByText('BitLocker')).toBeVisible();
    await expect(authedPage.getByText('FileVault')).toBeVisible();
    await expect(authedPage.getByText('LUKS')).toBeVisible();
    const thead = sec.tableHead();
    await expect(thead.getByText('Method')).toBeVisible();
    await expect(thead.getByText('Status')).toBeVisible();
    await expect(thead.getByText('TPM')).toBeVisible();
    await expect(thead.getByText('Recovery Key')).toBeVisible();
  });
});

test.describe('Password Policy Page', () => {
  test('password policy page shows stat cards and table columns', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoPasswordPolicy();
    await expect(authedPage.getByText('Total Devices').first()).toBeVisible();
    await expect(authedPage.getByText('Compliant').first()).toBeVisible();
    await expect(authedPage.getByText('Non-compliant')).toBeVisible();
    await expect(authedPage.getByText('Compliance').first()).toBeVisible();
    const thead = sec.tableHead();
    await expect(thead.getByText('Device')).toBeVisible();
    await expect(thead.getByText('OS')).toBeVisible();
    await expect(thead.getByText('Status')).toBeVisible();
    await expect(thead.getByText('Local Accts')).toBeVisible();
    await expect(thead.getByText('Admin Accts')).toBeVisible();
  });
});

test.describe('Vulnerabilities Page', () => {
  test('vulnerabilities page shows stat cards', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoVulnerabilities();
    await expect(authedPage.getByText('Total').first()).toBeVisible();
    await expect(authedPage.getByText('Critical').first()).toBeVisible();
    await expect(authedPage.getByText('Active').first()).toBeVisible();
    await expect(authedPage.getByText('Quarantined').first()).toBeVisible();
  });

  test('vulnerabilities table has correct columns', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoVulnerabilities();
    const thead = sec.tableHead();
    await expect(thead.getByText('Device')).toBeVisible();
    await expect(thead.getByText('Threat')).toBeVisible();
    await expect(thead.getByText('Category')).toBeVisible();
    await expect(thead.getByText('Severity')).toBeVisible();
    await expect(thead.getByText('Status')).toBeVisible();
    await expect(thead.getByText('Detected')).toBeVisible();
  });

  test('filter by critical severity', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoVulnerabilities();
    await authedPage.locator('select').filter({ has: authedPage.locator("option[value='critical']") }).first().selectOption('critical');
    await authedPage.waitForTimeout(1000);
    await expect(authedPage.locator('table tbody')).toBeVisible();
  });
});

test.describe('Security Trends Page', () => {
  test('trends page shows stat cards and period toggles', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoTrends();
    await expect(authedPage.getByText(/Score movement over time/)).toBeVisible();
    await expect(authedPage.getByText('Current Score')).toBeVisible();
    await expect(authedPage.getByText('Previous Score')).toBeVisible();
    await expect(authedPage.getByText('Change')).toBeVisible();
    await expect(authedPage.getByText('Trend')).toBeVisible();
    await expect(sec.periodButton('7 Days')).toBeVisible();
    await expect(sec.periodButton('30 Days')).toBeVisible();
    await expect(sec.periodButton('90 Days')).toBeVisible();
  });

  test('period toggle 7 Days is clickable', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoTrends();
    await sec.periodButton('7 Days').click();
    await authedPage.waitForTimeout(500);
    await expect(authedPage.getByText('Security Trends').first()).toBeVisible();
  });

  test('line toggles are present (Overall, Antivirus, Firewall, Encryption)', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoTrends();
    await expect(authedPage.getByRole('button', { name: 'Overall' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Antivirus' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Firewall' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Encryption' })).toBeVisible();
  });
});

test.describe('Security Recommendations Page', () => {
  test('recommendations page shows stat cards and filters', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoRecommendations();
    await expect(authedPage.getByText(/Prioritized remediation guidance/)).toBeVisible();
    await expect(authedPage.getByText('Total').first()).toBeVisible();
    await expect(authedPage.getByText('Open').first()).toBeVisible();
    await expect(authedPage.getByText('Critical').first()).toBeVisible();
    await expect(authedPage.getByText('Completed').first()).toBeVisible();
  });

  test('filter by critical priority', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoRecommendations();
    await authedPage.locator('select').filter({ has: authedPage.locator("option[value='critical']") }).first().selectOption('critical');
    await authedPage.waitForTimeout(1000);
    await expect(authedPage.getByText('Security Recommendations').first()).toBeVisible();
  });
});

test.describe('Admin Account Audit Page', () => {
  test('admin audit page shows stat cards and table columns', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoAdminAudit();
    await expect(sec.adminAuditPrivilegedText()).toBeVisible();
    await expect(authedPage.getByText('Total Devices').first()).toBeVisible();
    await expect(authedPage.getByText('With Issues')).toBeVisible();
    await expect(authedPage.getByText('Total Admins')).toBeVisible();
    await expect(authedPage.getByText('Default Accts')).toBeVisible();
    await expect(authedPage.getByText('Weak Passwords')).toBeVisible();
    await expect(authedPage.getByText('Stale Accts')).toBeVisible();
    const thead = sec.tableHead();
    await expect(thead.getByText('Device')).toBeVisible();
    await expect(thead.getByText('OS')).toBeVisible();
    await expect(thead.getByText('Admins')).toBeVisible();
    await expect(thead.getByText('Issues')).toBeVisible();
  });

  test('search input works on admin audit page', async ({ authedPage }) => {
    const sec = new MonitoringSecurityPage(authedPage);
    await sec.gotoAdminAudit();
    await sec.adminSearchInput().fill('admin');
    await authedPage.waitForTimeout(1000);
    await expect(authedPage.locator('table tbody')).toBeVisible();
    await sec.adminSearchInput().fill('');
  });
});

test.describe('Security Sub-page Navigation', () => {
  const pages: Array<{ path: string; waitText: string }> = [
    { path: '/security/score', waitText: 'Security Score' },
    { path: '/security/antivirus', waitText: 'Antivirus Coverage' },
    { path: '/security/firewall', waitText: 'Firewall Status' },
    { path: '/security/encryption', waitText: 'Encryption Status' },
    { path: '/security/password-policy', waitText: 'Password Policy' },
    { path: '/security/vulnerabilities', waitText: 'Vulnerabilities' },
    { path: '/security/trends', waitText: 'Security Trends' },
    { path: '/security/recommendations', waitText: 'Security Recommendations' },
    { path: '/security/admin-audit', waitText: 'Admin Account Audit' },
  ];

  for (const { path, waitText } of pages) {
    test(`navigates to ${path}`, async ({ authedPage }) => {
      await authedPage.goto(path);
      await expect(authedPage.getByText(waitText).first()).toBeVisible({ timeout: 15000 });
    });
  }
});
