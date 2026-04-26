// e2e-tests/playwright/pages/AuditPage.ts
// Covers AuditLogViewer.tsx on /audit
import { BasePage } from './BasePage';

export class AuditPage extends BasePage {
  readonly url = '/audit';

  // AuditLogViewer renders "Audit Trail" heading text (not h1/h2 level guaranteed)
  heading() {
    return this.page.getByText('Audit Trail', { exact: true });
  }

  description() {
    return this.page.getByText('Track user actions, sensitive operations, and system changes.');
  }

  filtersButton() {
    return this.page.getByRole('button', { name: 'Filters' });
  }

  exportButton() {
    return this.page.getByRole('button', { name: 'Export Logs' });
  }

  clearButton() {
    return this.page.getByRole('button', { name: 'Clear' });
  }

  // Sortable column headers are <th><button>
  columnHeaderButton(name: string) {
    return this.page.locator('th').getByRole('button', { name });
  }

  table() {
    return this.page.locator('table');
  }

  tableRows() {
    return this.page.locator('tbody tr');
  }

  firstRowExpandButton() {
    return this.page.locator('tbody tr').first().locator('button').first();
  }

  firstRowViewDetailsButton() {
    return this.page.locator('tbody tr').first().getByRole('button', { name: 'View details' });
  }

  // After expanding a row
  fullDetailsText() {
    return this.page.getByText('Full Details');
  }

  auditLogDetailModal() {
    return this.page.getByText('Audit Log Detail');
  }

  // AuditFilters panel
  filterPanelHeading() {
    return this.page.getByText('Audit Filters');
  }

  filterPanelDescription() {
    return this.page.getByText('Refine audit entries by user, action, and resource.');
  }

  applyFiltersButton() {
    return this.page.getByRole('button', { name: 'Apply Filters' });
  }

  todayButton() {
    return this.page.getByRole('button', { name: 'Today' });
  }

  userSearchInput() {
    return this.page.getByPlaceholder('Search users');
  }

  detailsSearchInput() {
    return this.page.getByPlaceholder('Search activity details');
  }

  loginCheckbox() {
    return this.page.locator("label:has-text('login') input[type='checkbox']");
  }

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor({ timeout: 15000 });
  }

  async openFilterPanel() {
    await this.filtersButton().click();
    await this.filterPanelHeading().waitFor({ timeout: 5000 });
  }
}
