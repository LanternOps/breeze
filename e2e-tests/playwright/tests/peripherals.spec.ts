// e2e-tests/playwright/tests/peripherals.spec.ts
// Converted from e2e-tests/tests/peripherals_and_data.yaml
import { test, expect } from '../fixtures';
import { PeripheralsPage } from '../pages/PeripheralsPage';

test.describe('Peripheral Control', () => {
  // ── Smoke: page loads ──────────────────────────────────────────────────────
  test('Peripheral Control page loads with heading and tab buttons', async ({ authedPage }) => {
    const peripherals = new PeripheralsPage(authedPage);
    await peripherals.gotoPeripherals();

    await expect(peripherals.peripheralHeading()).toBeVisible();
    await expect(peripherals.policiesTab()).toBeVisible();
    await expect(peripherals.activityLogTab()).toBeVisible();
  });

  // ── Policies tab ───────────────────────────────────────────────────────────
  test('Policies tab shows filter bar, Create Policy button, and table columns', async ({ authedPage }) => {
    const peripherals = new PeripheralsPage(authedPage);
    await peripherals.gotoPeripherals();

    await expect(peripherals.deviceClassFilterSelect()).toBeVisible();
    await expect(peripherals.actionFilterSelect()).toBeVisible();
    await expect(peripherals.statusFilterSelect()).toBeVisible();
    await expect(peripherals.createPolicyButton()).toBeVisible();

    const thead = peripherals.policiesTableHead();
    await expect(thead).toContainText('Name');
    await expect(thead).toContainText('Device Class');
    await expect(thead).toContainText('Action');
    await expect(thead).toContainText('Active');
    await expect(thead).toContainText('Exceptions');
    await expect(thead).toContainText('Created');
  });

  // ── Policies tab: filters ──────────────────────────────────────────────────
  test('Policies tab filters by device class and action', async ({ authedPage }) => {
    const peripherals = new PeripheralsPage(authedPage);
    await peripherals.gotoPeripherals();

    await peripherals.deviceClassFilterSelect().selectOption('storage');
    await expect(authedPage.getByRole('table')).toBeVisible({ timeout: 5000 });

    await peripherals.actionFilterSelect().selectOption('block');
    await expect(authedPage.getByRole('table')).toBeVisible({ timeout: 5000 });
  });

  // ── Create Policy modal ────────────────────────────────────────────────────
  test('Create Policy button opens the policy form modal', async ({ authedPage }) => {
    const peripherals = new PeripheralsPage(authedPage);
    await peripherals.gotoPeripherals();

    await peripherals.createPolicyButton().click();
    await expect(authedPage.getByText('Create Policy').first()).toBeVisible({ timeout: 5000 });
  });

  // ── Activity Log tab ───────────────────────────────────────────────────────
  test('Activity Log tab shows filter bar and table columns', async ({ authedPage }) => {
    const peripherals = new PeripheralsPage(authedPage);
    await peripherals.gotoPeripherals();
    await peripherals.openActivityLogTab();

    await expect(peripherals.eventTypeFilterSelect()).toBeVisible();
    await expect(peripherals.peripheralTypeInput()).toBeVisible();
    await expect(peripherals.vendorInput()).toBeVisible();

    const thead = peripherals.activityTableHead();
    await expect(thead).toContainText('Occurred At');
    await expect(thead).toContainText('Event Type');
    await expect(thead).toContainText('Peripheral Type');
    await expect(thead).toContainText('Vendor');
    await expect(thead).toContainText('Product');
    await expect(thead).toContainText('Serial Number');
    await expect(thead).toContainText('Policy');
  });

  // ── Activity Log tab: event filter ────────────────────────────────────────
  test('Activity Log event type filter responds', async ({ authedPage }) => {
    const peripherals = new PeripheralsPage(authedPage);
    await peripherals.gotoPeripherals();
    await peripherals.openActivityLogTab();

    await peripherals.eventTypeFilterSelect().selectOption('connected');
    await expect(authedPage.getByRole('table')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Sensitive Data Discovery', () => {
  // ── Smoke: page loads ──────────────────────────────────────────────────────
  test('Sensitive Data Discovery page loads with heading and four tabs', async ({ authedPage }) => {
    const peripherals = new PeripheralsPage(authedPage);
    await peripherals.gotoSensitiveData();

    await expect(peripherals.sensitiveDataHeading()).toBeVisible();
    await expect(peripherals.dashboardTab()).toBeVisible();
    await expect(peripherals.findingsTab()).toBeVisible();
    await expect(peripherals.scansTab()).toBeVisible();
    await expect(peripherals.sdPoliciesTab()).toBeVisible();
  });

  // ── Dashboard tab ──────────────────────────────────────────────────────────
  test('Dashboard tab shows four stat cards and two charts', async ({ authedPage }) => {
    const peripherals = new PeripheralsPage(authedPage);
    await peripherals.gotoSensitiveData();

    await expect(peripherals.totalFindingsCard()).toBeVisible();
    await expect(peripherals.criticalOpenCard()).toBeVisible();
    await expect(peripherals.remediatedCard()).toBeVisible();
    await expect(peripherals.openFindingsCard()).toBeVisible();

    await expect(peripherals.findingsByDataTypeChart()).toBeVisible();
    await expect(peripherals.riskDistributionChart()).toBeVisible();
  });

  // ── Findings tab ───────────────────────────────────────────────────────────
  test('Findings tab shows filter dropdowns, search input, and table columns', async ({ authedPage }) => {
    const peripherals = new PeripheralsPage(authedPage);
    await peripherals.gotoSensitiveDataFindings();

    await expect(peripherals.dataTypeFilterSelect()).toBeVisible();
    await expect(peripherals.riskFilterSelect()).toBeVisible();
    await expect(peripherals.findingsStatusFilterSelect()).toBeVisible();
    await expect(peripherals.findingsSearchInput()).toBeVisible();

    const thead = peripherals.findingsTableHead();
    await expect(thead).toContainText('File Path');
    await expect(thead).toContainText('Type');
    await expect(thead).toContainText('Pattern');
    await expect(thead).toContainText('Risk');
    await expect(thead).toContainText('Confidence');
    await expect(thead).toContainText('Status');
    await expect(thead).toContainText('Device');
    await expect(thead).toContainText('Found');
  });

  // ── Findings tab: search ───────────────────────────────────────────────────
  test('Findings search input filters the table', async ({ authedPage }) => {
    const peripherals = new PeripheralsPage(authedPage);
    await peripherals.gotoSensitiveDataFindings();

    await peripherals.findingsSearchInput().fill('/home');
    await expect(authedPage.getByRole('table')).toBeVisible({ timeout: 5000 });
  });

  // ── Scans tab ──────────────────────────────────────────────────────────────
  test('Scans tab shows heading, Refresh and New Scan buttons, and table columns', async ({ authedPage }) => {
    const peripherals = new PeripheralsPage(authedPage);
    await peripherals.gotoSensitiveDataScans();

    await expect(peripherals.scansHeading()).toBeVisible();
    await expect(peripherals.refreshButton()).toBeVisible();
    await expect(peripherals.newScanButton()).toBeVisible();

    const thead = peripherals.scansTableHead();
    await expect(thead).toContainText('Scan ID');
    await expect(thead).toContainText('Device');
    await expect(thead).toContainText('Status');
    await expect(thead).toContainText('Findings');
    await expect(thead).toContainText('Started');
    await expect(thead).toContainText('Duration');
  });

  // ── Scans tab: New Scan modal ──────────────────────────────────────────────
  test('New Scan button opens the create scan modal', async ({ authedPage }) => {
    const peripherals = new PeripheralsPage(authedPage);
    await peripherals.gotoSensitiveDataScans();

    await peripherals.newScanButton().click();
    await expect(authedPage.getByText('New Scan').first()).toBeVisible({ timeout: 5000 });
  });
});
