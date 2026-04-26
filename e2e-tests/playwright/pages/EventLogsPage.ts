// e2e-tests/playwright/pages/EventLogsPage.ts
// Covers LogSearch.tsx on /logs
import { BasePage } from './BasePage';

export class EventLogsPage extends BasePage {
  readonly url = '/logs';

  // LogSearch.tsx: main search input
  searchInput() {
    return this.page.getByPlaceholder('error code, source, stack trace...');
  }

  sourceInput() {
    return this.page.getByPlaceholder('e.g. kernel');
  }

  searchButton() {
    return this.page.getByRole('button', { name: 'Search Fleet Logs' });
  }

  saveQueryButton() {
    return this.page.getByRole('button', { name: 'Save Query' });
  }

  exportCsvButton() {
    return this.page.getByRole('button', { name: 'Export CSV' });
  }

  // Level checkboxes: Info, Warning, Error, Critical
  levelCheckbox(level: 'Info' | 'Warning' | 'Error' | 'Critical') {
    return this.page.locator(`label:has-text('${level}') input[type='checkbox']`);
  }

  levelLabel(level: string) {
    return this.page.getByText(level, { exact: true });
  }

  // Form labels
  searchLabel() {
    return this.page.locator('section').getByText('Search', { exact: true });
  }

  sourceLabel() {
    return this.page.locator('section').getByText('Source', { exact: true });
  }

  startLabel() {
    return this.page.locator('section').getByText('Start', { exact: true });
  }

  endLabel() {
    return this.page.locator('section').getByText('End', { exact: true });
  }

  rowsLabel() {
    return this.page.locator('section').getByText('Rows', { exact: true });
  }

  // Results section
  resultsHeading() {
    return this.page.getByRole('heading', { level: 2, name: 'Search Results' });
  }

  columnHeader(name: string) {
    return this.page.getByRole('columnheader', { name });
  }

  // Results count text
  resultsCountText() {
    return this.page.getByText(/shown of/);
  }

  async goto() {
    await this.page.goto(this.url);
    await this.searchInput().waitFor({ timeout: 20000 });
  }

  async search(query: string) {
    await this.searchInput().fill(query);
    await this.searchButton().click();
    await this.resultsCountText().waitFor({ timeout: 20000 });
  }
}
