import type { Page } from '@playwright/test';

export class PamPage {
  url = '/pam';

  constructor(private page: Page) {}

  heading = () => this.page.getByTestId('pam-heading');
  liveIndicator = () => this.page.getByTestId('pam-live-indicator');

  tabOverview = () => this.page.getByTestId('pam-tab-overview');
  tabRequests = () => this.page.getByTestId('pam-tab-requests');
  tabRules = () => this.page.getByTestId('pam-tab-rules');
  tabAudit = () => this.page.getByTestId('pam-tab-audit');

  statActive = () => this.page.getByTestId('pam-stat-active');
  filterStatus = () => this.page.getByTestId('pam-filter-status');
  auditExportButton = () => this.page.getByTestId('pam-audit-export-btn');

  addRuleButton = () => this.page.getByTestId('pam-add-rule-btn');
  ruleName = () => this.page.getByTestId('pam-rule-name');
  ruleSigner = () => this.page.getByTestId('pam-rule-signer');
  rulePriority = () => this.page.getByTestId('pam-rule-priority');
  ruleVerdict = () => this.page.getByTestId('pam-rule-verdict');
  ruleSubmit = () => this.page.getByTestId('pam-rule-submit');
  ruleRows = () => this.page.locator('[data-testid^="pam-rule-row-"]');
  ruleDeleteButtons = () => this.page.locator('[data-testid^="pam-rule-delete-"]');
}
