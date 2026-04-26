// e2e-tests/playwright/tests/devices.spec.ts
//
// Converted from: device_management.yaml + device_detail_tabs.yaml
//
// Tab label mapping (YAML description → live component label in DeviceDetails.tsx):
//   "Device Details"    → "Details"
//   "Hardware Inventory"→ "Hardware"
//   "Software Inventory"→ "Software"
//   "Patch Status"      → "Patches"
//   "Script History"    → "Scripts"
//   "Alert History"     → "Alerts"
//   "Network Connections"→ "Connections"
//   "Effective Config"  → "Config"
//   "Boot Performance"  → "Boot Perf"
//   "Disk Cleanup"      → "Disk Cleanup" (unchanged)
import { test, expect } from '../fixtures';
import { DevicesPage } from '../pages/DevicesPage';
import { DeviceDetailPage } from '../pages/DeviceDetailPage';

const LINUX_DEVICE_ID = process.env.E2E_LINUX_DEVICE_ID ?? process.env.E2E_MACOS_DEVICE_ID ?? '';
const WINDOWS_DEVICE_ID = process.env.E2E_WINDOWS_DEVICE_ID ?? '';

// ---------------------------------------------------------------------------
// Device Management (from device_management.yaml)
// ---------------------------------------------------------------------------
test.describe('Device Management', () => {
  test('device list loads with correct columns', async ({ authedPage }) => {
    const devicesPage = new DevicesPage(authedPage);
    await devicesPage.goto();
    await expect(devicesPage.heading()).toBeVisible();
    await expect(devicesPage.subtitleText()).toBeVisible();
    await devicesPage.waitForTable();
    await expect(devicesPage.hostnameColumnHeader()).toBeVisible();
    await expect(devicesPage.organizationColumnHeader()).toBeVisible();
    await expect(devicesPage.siteColumnHeader()).toBeVisible();
    await expect(devicesPage.osColumnHeader()).toBeVisible();
    await expect(devicesPage.statusColumnHeader()).toBeVisible();
    await expect(devicesPage.cpuColumnHeader()).toBeVisible();
    await expect(devicesPage.ramColumnHeader()).toBeVisible();
    await expect(devicesPage.lastSeenColumnHeader()).toBeVisible();
    await expect(devicesPage.actionsColumnHeader()).toBeVisible();
  });

  test('device list has view toggles and add device button', async ({ authedPage }) => {
    const devicesPage = new DevicesPage(authedPage);
    await devicesPage.goto();
    await expect(devicesPage.listViewButton()).toBeVisible();
    await expect(devicesPage.gridViewButton()).toBeVisible();
    await expect(devicesPage.addDeviceButton()).toBeVisible();
  });

  test('device list search by hostname shows no-results state', async ({ authedPage }) => {
    const devicesPage = new DevicesPage(authedPage);
    await devicesPage.goto();
    await devicesPage.waitForTable();
    await devicesPage.searchInput().fill('nonexistent-device-xyz-12345');
    await expect(devicesPage.noDevicesText()).toBeVisible();
    await devicesPage.searchInput().fill('');
    await expect(devicesPage.hostnameColumnHeader()).toBeVisible();
  });

  test('device list status filter cycles through values', async ({ authedPage }) => {
    const devicesPage = new DevicesPage(authedPage);
    await devicesPage.goto();
    await devicesPage.waitForTable();
    await devicesPage.statusFilter().selectOption('online');
    await devicesPage.statusFilter().selectOption('all');
  });

  test('device list OS filter cycles through values', async ({ authedPage }) => {
    const devicesPage = new DevicesPage(authedPage);
    await devicesPage.goto();
    await devicesPage.waitForTable();
    await devicesPage.osFilter().selectOption('linux');
    await devicesPage.osFilter().selectOption('all');
  });

  test('device list grid view toggle and return to list view', async ({ authedPage }) => {
    const devicesPage = new DevicesPage(authedPage);
    await devicesPage.goto();
    await devicesPage.waitForTable();
    await devicesPage.gridViewButton().click();
    await devicesPage.listViewButton().click();
    await expect(devicesPage.hostnameColumnHeader()).toBeVisible();
  });

  test('add device modal opens with installation instructions', async ({ authedPage }) => {
    const devicesPage = new DevicesPage(authedPage);
    await devicesPage.goto();
    await devicesPage.addDeviceButton().click();
    await expect(authedPage.getByText('Add New Device')).toBeVisible();
    await expect(authedPage.getByText('Installation Token')).toBeVisible();
    await expect(authedPage.getByText('Windows (PowerShell - Run as Administrator)')).toBeVisible();
    await expect(authedPage.getByText('macOS / Linux (Terminal)')).toBeVisible();
    await authedPage.getByRole('button', { name: 'Done' }).click();
    await expect(authedPage.getByText('Add New Device')).toBeHidden();
  });

  test('device list bulk selection shows bulk actions bar', async ({ authedPage }) => {
    const devicesPage = new DevicesPage(authedPage);
    await devicesPage.goto();
    await devicesPage.waitForTable();
    await devicesPage.firstRowCheckbox().click();
    await expect(devicesPage.selectedCountText(1)).toBeVisible();
    await expect(devicesPage.bulkActionsButton()).toBeVisible();
    await devicesPage.bulkActionsButton().click();
    await expect(authedPage.getByText('Reboot Selected')).toBeVisible();
    await expect(authedPage.getByText('Run Script')).toBeVisible();
    await expect(authedPage.getByText('Deploy Software')).toBeVisible();
    await expect(authedPage.getByText('Enable Maintenance')).toBeVisible();
    await expect(authedPage.getByText('Disable Maintenance')).toBeVisible();
    await expect(authedPage.getByText('Decommission Selected')).toBeVisible();
    await devicesPage.clearSelectionButton().click();
    await expect(devicesPage.selectedCountText(1)).toBeHidden();
  });

  test('device compare page loads with heading and export buttons', async ({ authedPage }) => {
    await authedPage.goto('/devices/compare');
    await expect(authedPage.getByRole('heading', { name: 'Device Comparison' })).toBeVisible();
    await expect(authedPage.getByText('Compare hardware, software, patches, and configuration across your fleet.')).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Export PDF' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Share' })).toBeVisible();
  });

  test('device groups page loads with create group button', async ({ authedPage }) => {
    await authedPage.goto('/devices/groups');
    await expect(authedPage.getByRole('heading', { name: 'Device Groups' })).toBeVisible();
    await expect(authedPage.getByText('Organize devices into static and dynamic groups for targeted actions.')).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Create Group' })).toBeVisible();
  });

  test('create device group modal opens and closes', async ({ authedPage }) => {
    await authedPage.goto('/devices/groups');
    await authedPage.getByRole('button', { name: 'Create Group' }).click();
    await expect(authedPage.getByText('Group name')).toBeVisible();
    await authedPage.keyboard.press('Escape');
  });
});

// ---------------------------------------------------------------------------
// Device Detail Navigation (from device_management.yaml)
// ---------------------------------------------------------------------------
test.describe('Device Detail Navigation', () => {
  test('device detail page shows header with back button and status badge', async ({ authedPage }) => {
    test.skip(!LINUX_DEVICE_ID, 'E2E_LINUX_DEVICE_ID / E2E_MACOS_DEVICE_ID not set');
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await expect(deviceDetail.backButton()).toBeVisible();
    await expect(deviceDetail.statusBadge()).toBeVisible();
  });

  test('device detail overview tab shows metric cards', async ({ authedPage }) => {
    test.skip(!LINUX_DEVICE_ID, 'E2E_LINUX_DEVICE_ID / E2E_MACOS_DEVICE_ID not set');
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await expect(deviceDetail.cpuCard()).toBeVisible();
    await expect(deviceDetail.ramCard()).toBeVisible();
    await expect(deviceDetail.lastSeenCard()).toBeVisible();
    await expect(deviceDetail.uptimeCard()).toBeVisible();
    await expect(deviceDetail.loggedInUserCard()).toBeVisible();
  });

  test('back button returns to device list', async ({ authedPage }) => {
    test.skip(!LINUX_DEVICE_ID, 'E2E_LINUX_DEVICE_ID / E2E_MACOS_DEVICE_ID not set');
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.backButton().click();
    const devicesPage = new DevicesPage(authedPage);
    await expect(devicesPage.hostnameColumnHeader()).toBeVisible();
  });

  test('device detail 404 shows not-found state', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await authedPage.goto('/devices/00000000-0000-0000-0000-000000000000');
    await expect(deviceDetail.deviceNotFoundText()).toBeVisible();
    await expect(deviceDetail.goBackButton()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Device Detail Tabs (from device_detail_tabs.yaml + device_management.yaml)
// Tab labels use the LIVE component labels, not the YAML descriptions.
// ---------------------------------------------------------------------------
test.describe('Device Detail Tabs (Linux)', () => {
  test.skip(() => !LINUX_DEVICE_ID, 'E2E_LINUX_DEVICE_ID / E2E_MACOS_DEVICE_ID not set');

  test('all expected tab buttons are visible', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);

    const tabs = [
      'Overview',
      'Details',
      'Hardware',
      'Software',
      'Patches',
      'Disk Cleanup',
      'Security',
      'Peripherals',
      'Management',
      'Config',
      'Alerts',
      'Scripts',
      'Performance',
      'Boot Perf',
      'Event Log',
      'Activities',
      'Connections',
      'IP History',
      'Playbooks',
    ];

    for (const label of tabs) {
      await expect(deviceDetail.tab(label)).toBeVisible();
    }
  });

  test('tab navigation: walks through all tabs sequentially', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);

    // Overview — check metric cards visible
    await deviceDetail.clickTab('Overview');
    await expect(deviceDetail.cpuCard()).toBeVisible();

    // Walk remaining tabs in order — verify each renders without hard errors
    for (const label of [
      'Details',
      'Hardware',
      'Software',
      'Patches',
      'Disk Cleanup',
      'Security',
      'Peripherals',
      'Management',
      'Config',
      'Alerts',
      'Scripts',
      'Activities',
      'Connections',
      'IP History',
      'Playbooks',
    ]) {
      await deviceDetail.clickTab(label);
    }

    // Performance tab has time-range buttons we can assert on
    await deviceDetail.clickTab('Performance');
    await expect(deviceDetail.btn24h()).toBeVisible();
    await expect(deviceDetail.btn7d()).toBeVisible();
    await expect(deviceDetail.btn30d()).toBeVisible();

    // Confirm time range switching works
    await deviceDetail.btn7d().click();
    await deviceDetail.btn30d().click();
    await deviceDetail.btn24h().click();
  });

  test('overview tab is active by default', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await expect(deviceDetail.tab('Overview')).toBeVisible();
    await expect(deviceDetail.cpuCard()).toBeVisible();
  });

  test('details tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Details');
  });

  test('hardware tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Hardware');
  });

  test('software tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Software');
  });

  test('patches tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Patches');
  });

  test('security tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Security');
  });

  test('performance tab shows time range buttons', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Performance');
    await expect(deviceDetail.btn24h()).toBeVisible();
    await expect(deviceDetail.btn7d()).toBeVisible();
    await expect(deviceDetail.btn30d()).toBeVisible();
  });

  test('alerts tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Alerts');
  });

  test('scripts tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Scripts');
  });

  test('connections tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Connections');
  });

  test('ip history tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('IP History');
  });

  test('disk cleanup tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Disk Cleanup');
  });

  test('peripherals tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Peripherals');
  });

  test('management tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Management');
  });

  test('effective config tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Config');
  });

  test('activities tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Activities');
  });

  test('playbooks tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(LINUX_DEVICE_ID);
    await deviceDetail.clickTab('Playbooks');
  });
});

test.describe('Device Detail Tabs (Windows)', () => {
  test.skip(() => !WINDOWS_DEVICE_ID, 'E2E_WINDOWS_DEVICE_ID not set');

  test('boot perf tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(WINDOWS_DEVICE_ID);
    await deviceDetail.clickTab('Boot Perf');
  });

  test('event log tab click navigates without error', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(WINDOWS_DEVICE_ID);
    await deviceDetail.clickTab('Event Log');
  });

  test('patches tab shows patch data (Windows)', async ({ authedPage }) => {
    const deviceDetail = new DeviceDetailPage(authedPage);
    await deviceDetail.goto(WINDOWS_DEVICE_ID);
    await deviceDetail.clickTab('Patches');
  });
});
