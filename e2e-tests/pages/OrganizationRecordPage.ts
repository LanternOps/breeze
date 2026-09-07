import type { Page } from '@playwright/test';
import { waitForAppReady } from './hydration';

/**
 * The organization record (`/organizations/:id`, #5075).
 *
 * Selectors are `data-testid` only per `e2e-tests/README.md`. Tab content
 * beyond Overview/Tickets/Contracts & Billing (Contacts, Sites, Devices,
 * Activity) belongs to a parallel wave (W02) and isn't modeled here yet — add
 * it alongside that work rather than guessing at testids that don't exist.
 */
export class OrganizationRecordPage {
  constructor(private page: Page) {}

  url = (orgId: string, hash = '') => `/organizations/${orgId}${hash}`;

  header = () => this.page.getByTestId('org-record-header');
  scopeChip = () => this.page.getByTestId('org-record-scope-chip');
  workHereButton = () => this.page.getByTestId('org-record-work-here');

  overviewTab = () => this.page.getByTestId('org-overview-tab');

  ticketsTab = () => this.page.getByTestId('org-tickets-tab');
  ticketsStatusTab = (id: 'open' | 'all' | 'closed') => this.page.getByTestId(`org-tickets-tab-${id}`);
  ticketsNewButton = () => this.page.getByTestId('org-tickets-new');
  ticketsError = () => this.page.getByTestId('org-tickets-error');

  billingTab = () => this.page.getByTestId('org-billing-tab');
  billingSection = (id: 'contracts' | 'invoices' | 'quotes') => this.page.getByTestId(`org-billing-section-${id}`);

  async goto(orgId: string, hash = '') {
    await this.page.goto(this.url(orgId, hash));
    await waitForAppReady(this.page, 'org-record-header');
  }
}
