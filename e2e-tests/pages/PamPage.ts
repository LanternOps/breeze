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
  ruleRow = (id: string) => this.page.getByTestId(`pam-rule-row-${id}`);
  ruleNameCells = () => this.page.locator('[data-testid^="pam-rule-name-"]');
  ruleDeleteButton = (id: string) => this.page.getByTestId(`pam-rule-delete-${id}`);
  ruleDeleteConfirmButton = () => this.page.getByTestId('pam-rule-delete-confirm');

  /**
   * Resolve a rule's id from its (unique) name without text-based locators:
   * walk the `pam-rule-name-<id>` testid cells and compare textContent.
   */
  async ruleIdByName(name: string): Promise<string | null> {
    const cells = this.ruleNameCells();
    const count = await cells.count();
    for (let i = 0; i < count; i++) {
      const cell = cells.nth(i);
      if ((await cell.textContent())?.trim() === name) {
        const testId = await cell.getAttribute('data-testid');
        return testId ? testId.replace('pam-rule-name-', '') : null;
      }
    }
    return null;
  }
}
