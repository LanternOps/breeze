import type { Page, Locator } from '@playwright/test';

export class VulnerabilitiesPage {
  constructor(private page: Page) {}

  goto = (hash = '') => this.page.goto(`/vulnerabilities${hash}`);

  // Stat cards
  statCritical = () => this.page.getByTestId('vuln-stat-critical');
  statKev = () => this.page.getByTestId('vuln-stat-kev');
  statPatchReady = () => this.page.getByTestId('vuln-stat-patch-ready');
  statAcceptedExpiring = () => this.page.getByTestId('vuln-stat-accepted-expiring');

  // Tabs + filters
  tabSoftware = () => this.page.getByTestId('vuln-tab-software');
  tabCves = () => this.page.getByTestId('vuln-tab-cves');
  filterStatus = () => this.page.getByTestId('vuln-filter-status');

  // Tables
  groupRows = (): Locator => this.page.locator('[data-testid^="software-group-row-"]');
  cveRows = (): Locator => this.page.locator('[data-testid^="vulnerability-row-"]');

  // Software drawer
  softwareDrawer = () => this.page.getByTestId('vuln-software-drawer');
  actionAccept = () => this.page.getByTestId('vuln-action-accept');
  actionRemediate = () => this.page.getByTestId('vuln-action-remediate');

  // Bulk modal
  bulkModal = () => this.page.getByTestId('vuln-bulk-modal');
  bulkText = () => this.page.getByTestId('vuln-bulk-text');
  bulkUntil = () => this.page.getByTestId('vuln-bulk-until');
  bulkSubmit = () => this.page.getByTestId('vuln-bulk-submit');

  // CVE drawer
  cveDrawer = () => this.page.getByTestId('vuln-cve-drawer');
  reopenButtons = (): Locator => this.page.locator('[data-testid^="vuln-reopen-"]');

  drawerClose = (drawer: 'vuln-software-drawer' | 'vuln-cve-drawer') => this.page.getByTestId(`${drawer}-close`);
}
