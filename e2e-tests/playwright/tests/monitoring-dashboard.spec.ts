// e2e-tests/playwright/tests/monitoring-dashboard.spec.ts
import { test, expect } from '../fixtures';
import { MonitoringDashboardPage } from '../pages/MonitoringDashboardPage';

test.describe('Monitoring Dashboard', () => {
  // ── Page loads ──────────────────────────────────────────────────────
  test('monitoring page loads with tabs', async ({ authedPage }) => {
    const mon = new MonitoringDashboardPage(authedPage);
    await mon.goto();
    await expect(mon.heading()).toBeVisible();
    await expect(mon.description()).toBeVisible();
    await expect(mon.assetsTabButton()).toBeVisible();
    await expect(mon.networkChecksTabButton()).toBeVisible();
    await expect(mon.snmpTemplatesTabButton()).toBeVisible();
  });

  // ── Assets tab ──────────────────────────────────────────────────────
  test('assets tab shows summary stat cards', async ({ authedPage }) => {
    const mon = new MonitoringDashboardPage(authedPage);
    await mon.goto();
    await expect(mon.statCard('Configured')).toBeVisible();
    await expect(mon.statCard('Active')).toBeVisible();
    await expect(mon.statCard('Paused')).toBeVisible();
    await expect(mon.statCard('SNMP Warnings')).toBeVisible();
    await expect(mon.statCard('Shown')).toBeVisible();
  });

  test('assets tab shows assets table with correct columns', async ({ authedPage }) => {
    const mon = new MonitoringDashboardPage(authedPage);
    await mon.goto();
    await expect(mon.assetsTableHeading()).toBeVisible();
    await expect(mon.assetsTableDescription()).toBeVisible();
    await expect(mon.columnHeader('Asset')).toBeVisible();
    await expect(mon.columnHeader('IP')).toBeVisible();
    await expect(mon.columnHeader('Type')).toBeVisible();
    await expect(mon.columnHeader('Overall')).toBeVisible();
    await expect(mon.columnHeader('SNMP')).toBeVisible();
    await expect(mon.columnHeader('Network Checks')).toBeVisible();
    await expect(mon.columnHeader('Actions')).toBeVisible();
  });

  test('toggle button and manage network checks link are present', async ({ authedPage }) => {
    const mon = new MonitoringDashboardPage(authedPage);
    await mon.goto();
    await expect(mon.showingMonitoredAssetsButton()).toBeVisible();
    await expect(mon.manageNetworkChecksButton()).toBeVisible();
  });

  test('toggle switches to show all discovered assets', async ({ authedPage }) => {
    const mon = new MonitoringDashboardPage(authedPage);
    await mon.goto();
    await mon.showingMonitoredAssetsButton().click();
    await expect(mon.showingAllAssetsButton()).toBeVisible({ timeout: 10000 });
    await expect(mon.refreshButton()).toBeVisible();
  });

  // ── Network Checks tab ───────────────────────────────────────────────
  test('network checks tab loads via URL param', async ({ authedPage }) => {
    const mon = new MonitoringDashboardPage(authedPage);
    await mon.gotoWithTab('checks');
    await expect(mon.heading()).toBeVisible();
    // The active tab button gets bg-muted styling
    const activeTab = authedPage.locator('button.bg-muted', { hasText: 'Network Checks' });
    await expect(activeTab).toBeVisible({ timeout: 10000 });
  });

  // ── SNMP Templates tab ───────────────────────────────────────────────
  test('SNMP templates tab loads via URL param', async ({ authedPage }) => {
    const mon = new MonitoringDashboardPage(authedPage);
    await mon.gotoWithTab('templates');
    await expect(mon.heading()).toBeVisible();
    const activeTab = authedPage.locator('button.bg-muted', { hasText: 'SNMP Templates' });
    await expect(activeTab).toBeVisible({ timeout: 10000 });
  });

  // ── API ──────────────────────────────────────────────────────────────
  test('monitoring assets API responds', async ({ request, authedPage: _ }) => {
    const baseURL = process.env.E2E_BASE_URL ?? 'https://2breeze.app';
    const response = await request.get(`${baseURL}/api/v1/monitoring/assets`);
    expect(response.ok()).toBeTruthy();
  });

  test('monitoring assets API with includeUnconfigured responds', async ({ request, authedPage: _ }) => {
    const baseURL = process.env.E2E_BASE_URL ?? 'https://2breeze.app';
    const response = await request.get(`${baseURL}/api/v1/monitoring/assets?includeUnconfigured=true`);
    expect(response.ok()).toBeTruthy();
  });

  test('SNMP templates API responds', async ({ request, authedPage: _ }) => {
    const baseURL = process.env.E2E_BASE_URL ?? 'https://2breeze.app';
    const response = await request.get(`${baseURL}/api/v1/snmp/templates`);
    expect(response.ok()).toBeTruthy();
  });
});
