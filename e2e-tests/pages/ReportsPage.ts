import { expect, type Page } from '@playwright/test';
import { waitForAppReady } from './hydration';

/**
 * Reports list (`/reports`) and the template gallery (`/reports/templates`),
 * including the shared business-report options modal (#3198 W03).
 */
export class ReportsPage {
  url = '/reports';
  templatesUrl = '/reports/templates';

  constructor(private page: Page) {}

  // Org switcher (layout) — a focused org hides partner-owned reports.
  orgSwitcherTrigger = () => this.page.getByTestId('org-switcher-trigger');
  orgOptionAll = () => this.page.getByTestId('org-option-all');
  orgOption = (orgId: string) => this.page.getByTestId(`org-option-${orgId}`);

  toasts = () => this.page.getByTestId('toast');

  // Templates gallery
  templatesHeading = () => this.page.getByTestId('reports-templates-heading');
  businessGroup = () => this.page.getByTestId('report-template-group-business');
  templateCard = (type: string) => this.page.getByTestId(`report-template-card-${type}`);
  useTemplate = (type: string) => this.page.getByTestId(`report-template-use-${type}`);

  // Shared business options modal
  optionsModal = () => this.page.getByTestId('business-report-options-modal');
  ownerScope = () => this.page.getByTestId('report-owner-scope');
  ownerScopePartner = () => this.page.getByTestId('report-owner-scope-partner');
  ownerScopeOrg = () => this.page.getByTestId('report-owner-scope-org');
  arAgingGroupBy = () => this.page.getByTestId('ar-aging-group-by');
  arAgingCreate = () => this.page.getByTestId('ar-aging-create-report');

  // Reports list — saved reports tab
  savedTab = () => this.page.getByTestId('reports-tab-saved');
  partnerWideHint = () => this.page.getByTestId('reports-partner-wide-hint');
  reportRow = (id: string) => this.page.getByTestId(`report-row-${id}`);
  scopeBadge = (id: string) => this.page.getByTestId(`report-scope-badge-${id}`);
  generate = (id: string) => this.page.getByTestId(`report-generate-${id}`);

  // Reports list — recent runs tab
  runsTab = () => this.page.getByTestId('reports-tab-runs');
  runRow = (runId: string) => this.page.getByTestId(`report-run-row-${runId}`);
  runStatus = (runId: string) => this.page.getByTestId(`report-run-status-${runId}`);
  runDownload = (runId: string) => this.page.getByTestId(`report-run-download-${runId}`);

  async gotoTemplates() {
    await this.page.goto(this.templatesUrl);
    await waitForAppReady(this.page, 'reports-templates-heading');
    // The business section renders only once the JWT claims resolve to partner scope.
    await this.businessGroup().waitFor({ timeout: 20_000 });
  }

  async gotoList() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'reports-tab-saved');
  }

  /** Switch the layout org switcher to "All organizations" (fleet view). */
  async selectAllOrganizations() {
    if ((await this.orgSwitcherTrigger().getAttribute('data-scope')) === 'all') return;
    await this.orgSwitcherTrigger().click();
    await this.orgOptionAll().click();
    await this.page.waitForFunction(
      () => document.querySelector('[data-testid="org-switcher-trigger"]')?.getAttribute('data-scope') === 'all',
      undefined,
      { timeout: 15_000 },
    );
    await this.waitForToastsCleared();
  }

  /** The org-switch toast sits over the gallery's bottom-right cards and
   *  intercepts clicks until it expires (5 s). */
  async waitForToastsCleared() {
    await expect(this.toasts()).toHaveCount(0, { timeout: 15_000 });
  }

  /** Focus one organization in the layout org switcher. */
  async selectOrganization(orgId: string) {
    await this.orgSwitcherTrigger().click();
    await this.orgOption(orgId).click();
    await this.page.waitForFunction(
      () => document.querySelector('[data-testid="org-switcher-trigger"]')?.getAttribute('data-scope') === 'org',
      undefined,
      { timeout: 15_000 },
    );
  }
}
