import type { Page } from '@playwright/test';

/**
 * /tickets/import, the ticket import wizard (#8313 W6). data-testid only.
 */
export class TicketImportPage {
  url = '/tickets/import';

  constructor(private page: Page) {}

  heading = () => this.page.getByTestId('ticket-import-heading');
  denied = () => this.page.getByTestId('ticket-import-denied');
  connectNew = () => this.page.getByTestId('ticket-import-connect-new');
  step = (index: number) => this.page.getByTestId(`setup-stepper-step-${index}`);

  // Connect
  connectLabel = () => this.page.getByTestId('ticket-import-connect-label');
  connectBaseUrl = () => this.page.getByTestId('ticket-import-connect-base-url');
  connectToken = () => this.page.getByTestId('ticket-import-connect-token');
  connectSubmit = () => this.page.getByTestId('ticket-import-connect-submit');

  // Preflight
  preflightRun = () => this.page.getByTestId('ticket-import-preflight-run');
  preflightResult = () => this.page.getByTestId('ticket-import-preflight-result');
  preflightWarning = (code: string) => this.page.getByTestId(`ticket-import-preflight-warning-${code}`);
  preflightGroup = (key: string) => this.page.getByTestId(`ticket-import-preflight-group-${key}`);
  preflightContinue = () => this.page.getByTestId('ticket-import-preflight-continue');

  // Mappings
  mappingsFallback = () => this.page.getByTestId('ticket-import-mappings-fallback');
  mappingsCreateContacts = () => this.page.getByTestId('ticket-import-mappings-create-contacts');
  mappingsUpdatedSince = () => this.page.getByTestId('ticket-import-mappings-updated-since');
  mappingsSave = () => this.page.getByTestId('ticket-import-mappings-save');

  // Runs (dry run, bulk, delta)
  runStart = () => this.page.getByTestId('ticket-import-run-start');
  runState = () => this.page.getByTestId('ticket-import-run-state');
  runFrozen = () => this.page.getByTestId('ticket-import-run-frozen');
  runContinue = () => this.page.getByTestId('ticket-import-run-continue');
  reportContactsForOrg = (orgId: string) => this.page.getByTestId(`ticket-import-report-contacts-org-${orgId}`);
  issue = (id: string) => this.page.getByTestId(`ticket-import-issue-${id}`);
  contact = (id: string) => this.page.getByTestId(`ticket-import-contact-${id}`);

  // Window
  windowOpenSubmit = () => this.page.getByTestId('ticket-import-window-open-submit');
  windowOpen = () => this.page.getByTestId('ticket-import-window-open');
  windowContinue = () => this.page.getByTestId('ticket-import-window-continue');
  windowClose = (id: string) => this.page.getByTestId(`ticket-import-window-close-${id}`);
  windowCloseConfirm = () => this.page.getByTestId('ticket-import-window-close-confirm');
  closeSummary = () => this.page.getByTestId('ticket-import-close-summary');
  windowRow = (id: string) => this.page.getByTestId(`ticket-import-window-row-${id}`);

  async goto(hash = '') {
    await this.page.goto(`${this.url}${hash}`);
    await this.heading().waitFor();
  }
}
