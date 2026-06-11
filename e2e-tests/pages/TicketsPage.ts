import type { Page } from '@playwright/test';

export class TicketsPage {
  url = '/tickets';

  constructor(private page: Page) {}

  heading = () => this.page.getByTestId('tickets-heading');
  queue = () => this.page.getByTestId('tickets-queue');
  empty = () => this.page.getByTestId('tickets-empty');
  createButton = () => this.page.getByTestId('tickets-create-button');
  tab = (id: string) => this.page.getByTestId(`tickets-tab-${id}`);
  row = (id: string) => this.page.getByTestId(`ticket-row-${id}`);
  workbench = () => this.page.getByTestId('ticket-workbench');
  workbenchNumber = () => this.page.getByTestId('ticket-workbench-number');
  statusSelect = () => this.page.getByTestId('ticket-workbench-status');
  resolveNote = () => this.page.getByTestId('ticket-workbench-resolve-note');
  resolveSubmit = () => this.page.getByTestId('ticket-workbench-resolve-submit');
  composerInput = () => this.page.getByTestId('ticket-composer-input');
  composerInternalTab = () => this.page.getByTestId('ticket-composer-tab-internal');
  composerInternalBanner = () => this.page.getByTestId('ticket-composer-internal-banner');
  composerSend = () => this.page.getByTestId('ticket-composer-send');

  // Create form
  formOrg = () => this.page.getByTestId('create-ticket-org-input');
  formSubject = () => this.page.getByTestId('create-ticket-subject-input');
  formSubmit = () => this.page.getByTestId('create-ticket-submit');

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }
}
