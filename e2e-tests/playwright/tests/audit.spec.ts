// e2e-tests/playwright/tests/audit.spec.ts
import { test, expect } from '../fixtures';
import { AuditPage } from '../pages/AuditPage';
import { EventLogsPage } from '../pages/EventLogsPage';

test.describe('Audit Log', () => {
  // ── Page loads ──────────────────────────────────────────────────────
  test('audit log page loads with heading and action buttons', async ({ authedPage }) => {
    const audit = new AuditPage(authedPage);
    await audit.goto();
    await expect(audit.heading()).toBeVisible();
    await expect(audit.description()).toBeVisible();
    await expect(audit.filtersButton()).toBeVisible({ timeout: 20000 });
    await expect(audit.exportButton()).toBeVisible();
  });

  test('audit log table has correct column headers', async ({ authedPage }) => {
    const audit = new AuditPage(authedPage);
    await audit.goto();
    await audit.table().waitFor({ timeout: 20000 });
    await expect(audit.columnHeaderButton('Timestamp')).toBeVisible();
    await expect(audit.columnHeaderButton('User')).toBeVisible();
    await expect(audit.columnHeaderButton('Action')).toBeVisible();
    await expect(audit.columnHeaderButton('Resource')).toBeVisible();
    await expect(audit.columnHeaderButton('Details')).toBeVisible();
    await expect(audit.columnHeaderButton('IP')).toBeVisible();
  });

  // ── Filter panel ────────────────────────────────────────────────────
  test('filter panel opens and shows all filter sections', async ({ authedPage }) => {
    const audit = new AuditPage(authedPage);
    await audit.goto();
    await audit.filtersButton().waitFor({ timeout: 20000 });
    await audit.openFilterPanel();

    await expect(audit.filterPanelDescription()).toBeVisible();
    await expect(authedPage.getByText('Date Range')).toBeVisible();
    await expect(audit.todayButton()).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Last 7 days' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Last 30 days' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Custom' })).toBeVisible();
    await expect(authedPage.getByText('User', { exact: true })).toBeVisible();
    await expect(audit.userSearchInput()).toBeVisible();
    await expect(authedPage.getByText('Action Types')).toBeVisible();
    await expect(authedPage.getByText('Resource Types')).toBeVisible();
    await expect(authedPage.getByText('Search Details')).toBeVisible();
    await expect(audit.detailsSearchInput()).toBeVisible();
  });

  test('apply login filter and clear it', async ({ authedPage }) => {
    const audit = new AuditPage(authedPage);
    await audit.goto();
    await audit.filtersButton().waitFor({ timeout: 20000 });
    await audit.openFilterPanel();

    // Select login checkbox
    await audit.loginCheckbox().click();
    await audit.applyFiltersButton().click();
    await audit.heading().waitFor({ timeout: 10000 });

    // Clear button should appear when filters are active
    await expect(audit.clearButton()).toBeVisible();
    await audit.clearButton().click();
    await audit.heading().waitFor({ timeout: 5000 });
  });

  // ── Sorting ─────────────────────────────────────────────────────────
  test('column headers sort the table', async ({ authedPage }) => {
    const audit = new AuditPage(authedPage);
    await audit.goto();
    await audit.table().waitFor({ timeout: 20000 });

    // Click User column
    await audit.columnHeaderButton('User').click();
    await audit.table().waitFor({ timeout: 5000 });

    // Click Action column
    await audit.columnHeaderButton('Action').click();
    await audit.table().waitFor({ timeout: 5000 });

    // Click Timestamp again to reverse sort
    await audit.columnHeaderButton('Timestamp').click();
    await audit.table().waitFor({ timeout: 5000 });

    await expect(audit.table()).toBeVisible();
  });

  // ── Row detail ───────────────────────────────────────────────────────
  test('expand first row and open detail modal', async ({ authedPage }) => {
    const audit = new AuditPage(authedPage);
    await audit.goto();

    const rows = audit.tableRows();
    await rows.first().waitFor({ timeout: 20000 });

    // Expand first row via chevron button
    await audit.firstRowExpandButton().click();
    await expect(audit.fullDetailsText()).toBeVisible({ timeout: 5000 });
    await expect(authedPage.getByText('Session')).toBeVisible();

    // Open full detail modal
    await audit.firstRowViewDetailsButton().click();
    await expect(audit.auditLogDetailModal()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Event Logs', () => {
  // ── Page loads ──────────────────────────────────────────────────────
  test('event logs page loads with search form', async ({ authedPage }) => {
    const logs = new EventLogsPage(authedPage);
    await logs.goto();
    await expect(logs.searchInput()).toBeVisible();
    await expect(logs.searchButton()).toBeVisible();
    await expect(logs.saveQueryButton()).toBeVisible();
    await expect(logs.exportCsvButton()).toBeVisible();
  });

  test('search form has all fields', async ({ authedPage }) => {
    const logs = new EventLogsPage(authedPage);
    await logs.goto();
    await expect(logs.sourceInput()).toBeVisible();
    await expect(logs.searchLabel()).toBeVisible();
    await expect(logs.sourceLabel()).toBeVisible();
    await expect(logs.startLabel()).toBeVisible();
    await expect(logs.endLabel()).toBeVisible();
    await expect(logs.rowsLabel()).toBeVisible();
  });

  test('level checkboxes are present', async ({ authedPage }) => {
    const logs = new EventLogsPage(authedPage);
    await logs.goto();
    await expect(logs.levelLabel('Info')).toBeVisible();
    await expect(logs.levelLabel('Warning')).toBeVisible();
    await expect(logs.levelLabel('Error')).toBeVisible();
    await expect(logs.levelLabel('Critical')).toBeVisible();
  });

  test('results section has correct column headers', async ({ authedPage }) => {
    const logs = new EventLogsPage(authedPage);
    await logs.goto();
    await expect(logs.resultsHeading()).toBeVisible();
    await expect(logs.columnHeader('Timestamp')).toBeVisible();
    await expect(logs.columnHeader('Level')).toBeVisible();
    await expect(logs.columnHeader('Category')).toBeVisible();
    await expect(logs.columnHeader('Source')).toBeVisible();
    await expect(logs.columnHeader('Message')).toBeVisible();
    await expect(logs.columnHeader('Device')).toBeVisible();
  });

  test('search with level filters returns results', async ({ authedPage }) => {
    const logs = new EventLogsPage(authedPage);
    await logs.goto();

    await logs.searchInput().fill('error');
    await logs.levelCheckbox('Error').click();
    await logs.levelCheckbox('Warning').click();
    await logs.sourceInput().fill('system');
    await logs.searchButton().click();

    await expect(logs.resultsCountText()).toBeVisible({ timeout: 20000 });
  });
});
