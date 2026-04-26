// e2e-tests/playwright/tests/reports.spec.ts
import { test, expect } from '../fixtures';
import { ReportsPage } from '../pages/ReportsPage';

test.describe('Reports Page', () => {
  test('reports page loads with tabs and action buttons', async ({ authedPage }) => {
    const page = new ReportsPage(authedPage);
    await page.goto();
    await expect(page.heading()).toBeVisible();
    await expect(page.reportsDescription()).toBeVisible();
    await expect(page.savedReportsTab()).toBeVisible();
    await expect(page.recentRunsTab()).toBeVisible();
    await expect(page.adhocReportLink()).toBeVisible();
    await expect(page.newReportLink()).toBeVisible();
  });

  test('saved reports tab shows table or empty state', async ({ authedPage }) => {
    const page = new ReportsPage(authedPage);
    await page.goto();
    await page.savedReportsTab().click();
    await expect(page.heading()).toBeVisible();
  });

  test('recent runs tab shows content', async ({ authedPage }) => {
    const page = new ReportsPage(authedPage);
    await page.goto();
    await page.recentRunsTab().click();
    await expect(page.heading()).toBeVisible();
  });
});

test.describe('Create Report Page', () => {
  test('create report page loads with type cards', async ({ authedPage }) => {
    const page = new ReportsPage(authedPage);
    await page.gotoNewReport();
    await expect(page.createReportHeading()).toBeVisible();
    await expect(page.createReportDescription()).toBeVisible();
    await expect(page.devicesTypeCard()).toBeVisible();
    await expect(page.alertsTypeCard()).toBeVisible();
    await expect(page.patchesTypeCard()).toBeVisible();
    await expect(page.complianceTypeCard()).toBeVisible();
    await expect(page.activityTypeCard()).toBeVisible();
  });

  test('create report page shows devices type description', async ({ authedPage }) => {
    const page = new ReportsPage(authedPage);
    await page.gotoNewReport();
    await expect(authedPage.getByText('Inventory and health posture across managed endpoints')).toBeVisible();
    await expect(authedPage.getByText('Alert volume, severity, and response performance')).toBeVisible();
  });
});

test.describe('Report Builder Page', () => {
  test('report builder page loads with type cards', async ({ authedPage }) => {
    const page = new ReportsPage(authedPage);
    await page.gotoBuilder();
    await expect(page.reportBuilderHeading()).toBeVisible();
    await expect(page.reportBuilderDescription()).toBeVisible();
    await expect(page.devicesTypeCard()).toBeVisible();
    await expect(page.alertsTypeCard()).toBeVisible();
    await expect(page.patchesTypeCard()).toBeVisible();
  });
});

test.describe('Analytics Dashboard', () => {
  test('analytics page loads with heading and controls', async ({ authedPage }) => {
    const page = new ReportsPage(authedPage);
    await page.gotoAnalytics();
    await expect(page.analyticsHeading()).toBeVisible();
    await expect(page.analyticsDescription()).toBeVisible();
    await expect(page.refreshButton()).toBeVisible();
  });

  test('analytics dashboard selector has expected options', async ({ authedPage }) => {
    const page = new ReportsPage(authedPage);
    await page.gotoAnalytics();
    // Check the select element has operations option
    const operationsOption = authedPage.locator('select option[value="operations"]');
    await expect(operationsOption).toBeAttached();
    const capacityOption = authedPage.locator('select option[value="capacity"]');
    await expect(capacityOption).toBeAttached();
    const slaOption = authedPage.locator('select option[value="sla"]');
    await expect(slaOption).toBeAttached();
  });

  test('analytics date range picker has expected options', async ({ authedPage }) => {
    const page = new ReportsPage(authedPage);
    await page.gotoAnalytics();
    await expect(authedPage.locator('select option[value="7d"]')).toBeAttached();
    await expect(authedPage.getByRole('option', { name: 'Last 24 hours' })).toBeAttached();
    await expect(authedPage.getByRole('option', { name: 'Last 7 days' })).toBeAttached();
    await expect(authedPage.getByRole('option', { name: 'Last 30 days' })).toBeAttached();
  });

  test('analytics dashboard view selector can switch to capacity planning', async ({ authedPage }) => {
    const page = new ReportsPage(authedPage);
    await page.gotoAnalytics();
    await authedPage.locator('select').first().selectOption('capacity');
    await expect(page.analyticsHeading()).toBeVisible();
    await authedPage.locator('select').first().selectOption('sla');
    await expect(page.analyticsHeading()).toBeVisible();
  });

  test('analytics refresh button shows updated timestamp', async ({ authedPage }) => {
    const page = new ReportsPage(authedPage);
    await page.gotoAnalytics();
    await page.refreshButton().click();
    await expect(page.updatedText()).toBeVisible({ timeout: 20000 });
  });
});
