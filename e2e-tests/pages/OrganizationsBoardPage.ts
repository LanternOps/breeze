import type { Page } from '@playwright/test';
import { waitForAppReady } from './hydration';

/**
 * The organizations account board (`/organizations`, account-board W02).
 * Selectors are `data-testid` only per `e2e-tests/README.md`. Desktop table
 * ids only — the phone cards carry `org-board-card-*` ids and are not modeled.
 */
export class OrganizationsBoardPage {
  constructor(private page: Page) {}

  url = '/organizations';

  root = () => this.page.getByTestId('org-board');
  heading = () => this.page.getByTestId('org-board-heading');
  search = () => this.page.getByTestId('org-board-search');
  row = (orgId: string) => this.page.getByTestId(`org-board-row-${orgId}`);
  chip = (orgId: string, key: string) => this.row(orgId).getByTestId(`org-board-chip-${key}`);
  filter = (key: 'all' | 'setupIncomplete' | 'accountMissing' | 'openTickets' | 'trial' | 'archived') => this.page.getByTestId(`org-board-filter-${key}`);
  lens = (key: 'setup' | 'account' | 'both') => this.page.getByTestId(`org-board-lens-${key}`);
  band = (key: 'all' | 'setupIncomplete' | 'accountMissing' | 'openTickets') => this.page.getByTestId(`org-board-band-${key}`);
  bandCount = (key: 'all' | 'setupIncomplete' | 'accountMissing' | 'openTickets') => this.page.getByTestId(`org-board-band-${key}-count`);
  more = (orgId: string) => this.page.getByTestId(`org-board-more-${orgId}`);
  menuOpenRecord = () => this.page.getByTestId('org-board-menu-open-record');
  columnHeader = (key: 'name' | 'tickets') => this.page.getByTestId(`org-board-sort-${key}`);
  columnIntegrations = () => this.page.getByTestId('org-board-col-integrations');
  badge = (orgId: string, system: string) => this.page.getByTestId(`org-board-badge-${orgId}-${system}`);
  nothingLinked = (orgId: string) => this.page.getByTestId(`org-board-nothing-linked-${orgId}`);
  bandUnlinked = () => this.page.getByTestId('org-board-band-unlinked');
  bandUnlinkedCount = () => this.page.getByTestId('org-board-band-unlinked-count');
  filterUnlinked = () => this.page.getByTestId('org-board-filter-unlinked');
  repairLine = (system: string) => this.page.getByTestId(`org-board-repair-${system}`);

  async goto() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'org-board');
  }
}
