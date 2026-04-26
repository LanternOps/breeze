// e2e-tests/playwright/pages/AlertsPage.ts
import { BasePage } from './BasePage';

export class AlertsPage extends BasePage {
  readonly url = '/alerts';

  heading() {
    return this.page.getByRole('heading', { level: 1, name: 'Alerts' });
  }

  description() {
    return this.page.getByText('Monitor alerts across your devices.');
  }

  // AlertsSummary.tsx renders "Active Alerts" h2
  activeSummaryHeading() {
    return this.page.getByRole('heading', { level: 2, name: 'Active Alerts' });
  }

  // AlertList.tsx renders "Alerts" h2 inside the list panel
  listHeading() {
    return this.page.getByRole('heading', { level: 2, name: 'Alerts' });
  }

  // Table column headers
  columnHeader(name: string) {
    return this.page.getByRole('columnheader', { name });
  }

  // Filters: search input
  searchInput() {
    return this.page.getByPlaceholder('Search alerts...');
  }

  // Status/severity/date-range selects
  statusSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="active"]') });
  }

  severitySelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="critical"]') });
  }

  dateRangeSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="1h"]') });
  }

  // Alert table rows
  alertRows() {
    return this.page.locator('tbody tr');
  }

  firstAlertRow() {
    return this.page.locator('tbody tr').first();
  }

  // Results count text (e.g. "5 of 12 alerts")
  resultsCount() {
    return this.page.getByText(/alerts/);
  }

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  async navigateToChannels() {
    await this.page.goto('/alerts/channels');
    await this.page.getByRole('heading', { level: 1, name: 'Notification Channels' }).waitFor();
  }
}
