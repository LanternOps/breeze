import type { Page } from '@playwright/test';
import { waitForAppReady } from './hydration';

/**
 * Reports list (`/reports`) and the template gallery (`/reports/templates`),
 * including the shared business-report options modal (#3198 W03).
 */
export class ReportsPage {
  url = '/reports';
  templatesUrl = '/reports/templates';

  constructor(private page: Page) {}

  // Org switcher (layout) — `data-scope` is 'org' when an organization is focused.
  orgSwitcherTrigger = () => this.page.getByTestId('org-switcher-trigger');

  // Templates gallery
  templatesHeading = () => this.page.getByTestId('reports-templates-heading');
  businessGroup = () => this.page.getByTestId('report-template-group-business');
  templateCard = (type: string) => this.page.getByTestId(`report-template-card-${type}`);
  useTemplate = (type: string) => this.page.getByTestId(`report-template-use-${type}`);
  /** The first business card of a report type. A saved org report with a
   *  curated name replaces that curated slot under its OWN id, so a card is
   *  found by its type marker rather than by `report-template-card-<type>`. */
  businessCardOfType = (type: string) =>
    this.businessGroup()
      .getByTestId(/^report-template-card-/)
      .filter({ has: this.page.getByTestId(`report-template-type-${type}`) })
      .first();
  useBusinessTemplateOfType = (type: string) =>
    this.businessCardOfType(type).getByTestId(/^report-template-use-/);

  // Shared business options modal
  optionsModal = () => this.page.getByTestId('business-report-options-modal');
  ownerScope = () => this.page.getByTestId('report-owner-scope');
  ownerScopePartner = () => this.page.getByTestId('report-owner-scope-partner');
  ownerScopeOrg = () => this.page.getByTestId('report-owner-scope-org');
  arAgingGroupBy = () => this.page.getByTestId('ar-aging-group-by');
  arAgingCreate = () => this.page.getByTestId('ar-aging-create-report');

  // Reports list — saved reports tab
  savedTab = () => this.page.getByTestId('reports-tab-saved');
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
}
