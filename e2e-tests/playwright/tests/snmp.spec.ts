// e2e-tests/playwright/tests/snmp.spec.ts
import { test, expect } from '../fixtures';
import { SnmpPage } from '../pages/SnmpPage';

test.describe('SNMP Templates', () => {
  test('/snmp redirects to /monitoring', async ({ authedPage }) => {
    await authedPage.goto('/snmp');
    await authedPage.waitForURL('**/monitoring**');
    expect(authedPage.url()).toContain('/monitoring');
  });

  test('monitoring page loads with tab navigation', async ({ authedPage }) => {
    const page = new SnmpPage(authedPage);
    await page.gotoMonitoring();
    await expect(page.monitoringHeading()).toBeVisible();
    await expect(page.assetsTab()).toBeVisible();
    await expect(page.networkChecksTab()).toBeVisible();
    await expect(page.snmpTemplatesTab()).toBeVisible();
  });

  test('snmp templates tab loads with table columns', async ({ authedPage }) => {
    const page = new SnmpPage(authedPage);
    await page.gotoSnmpTemplates();
    await expect(page.snmpTemplatesHeading()).toBeVisible();
    await expect(page.addTemplateButton()).toBeVisible();
    // Table headers
    await expect(authedPage.getByRole('columnheader', { name: /name/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /vendor/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /device type/i })).toBeVisible();
    await expect(authedPage.getByRole('columnheader', { name: /oid count/i })).toBeVisible();
  });

  test('add template button opens editor panel', async ({ authedPage }) => {
    const page = new SnmpPage(authedPage);
    await page.gotoSnmpTemplates();
    await page.addTemplateButton().click();
    // Editor should open with a name field or search field
    const nameOrSearchInput = authedPage
      .getByRole('textbox', { name: /name/i })
      .or(authedPage.locator('input[placeholder*="name" i]'))
      .or(authedPage.locator('input[placeholder*="search" i]'))
      .first();
    await expect(nameOrSearchInput).toBeVisible();
  });
});

test.describe('Partner Portal', () => {
  test('partner portal page loads with heading and description', async ({ authedPage }) => {
    const page = new SnmpPage(authedPage);
    await page.gotoPartner();
    await expect(page.partnerPortalHeading()).toBeVisible();
    await expect(page.partnerPortalDescription()).toBeVisible();
  });

  test('partner portal shows action buttons', async ({ authedPage }) => {
    const page = new SnmpPage(authedPage);
    await page.gotoPartner();
    await expect(page.addCustomerLink()).toBeVisible();
    await expect(page.viewAllAlertsLink()).toBeVisible();
    await expect(page.runReportLink()).toBeVisible();
  });

  test('partner portal shows customer health section with search', async ({ authedPage }) => {
    const page = new SnmpPage(authedPage);
    await page.gotoPartner();
    await expect(page.customerHealthSection()).toBeVisible();
    await expect(page.customerSearchInput()).toBeVisible();
  });

  test('partner portal shows billing summary section', async ({ authedPage }) => {
    const page = new SnmpPage(authedPage);
    await page.gotoPartner();
    await expect(page.billingSummarySection()).toBeVisible();
    await expect(authedPage.getByText('Monthly recurring revenue')).toBeVisible();
  });

  test('partner portal shows portfolio snapshot section', async ({ authedPage }) => {
    const page = new SnmpPage(authedPage);
    await page.gotoPartner();
    await expect(page.portfolioSnapshotSection()).toBeVisible();
    await expect(authedPage.getByText('Customers')).toBeVisible();
    await expect(authedPage.getByText('Total devices')).toBeVisible();
    await expect(authedPage.getByText('Open alerts')).toBeVisible();
  });

  test('partner portal customer search shows empty state for unknown customer', async ({ authedPage }) => {
    const page = new SnmpPage(authedPage);
    await page.gotoPartner();
    await page.customerSearchInput().fill('NonExistentCustomerXYZ12345');
    await expect(authedPage.getByText('No customers match this filter yet.')).toBeVisible({
      timeout: 10000,
    });
    // clear
    await page.customerSearchInput().fill('');
  });
});

test.describe('Admin Quarantined Devices', () => {
  test('quarantined devices page loads with heading and description', async ({ authedPage }) => {
    const page = new SnmpPage(authedPage);
    await page.gotoQuarantined();
    await expect(page.quarantinedHeading()).toBeVisible();
    await expect(page.quarantinedDescription()).toBeVisible();
  });

  test('refresh button is present on quarantined page', async ({ authedPage }) => {
    const page = new SnmpPage(authedPage);
    await page.gotoQuarantined();
    await expect(page.refreshButton()).toBeVisible();
    await page.refreshButton().click();
    // Page should still show heading after refresh
    await expect(page.quarantinedHeading()).toBeVisible();
  });

  test('quarantined page shows table or empty state', async ({ authedPage }) => {
    const page = new SnmpPage(authedPage);
    await page.gotoQuarantined();
    // Either a table or an h3 empty-state heading should be present
    const tableOrEmptyState = authedPage
      .locator('table')
      .or(authedPage.getByRole('heading', { level: 3 }));
    await expect(tableOrEmptyState.first()).toBeVisible({ timeout: 10000 });
  });
});
