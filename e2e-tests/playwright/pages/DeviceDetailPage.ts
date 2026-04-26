// e2e-tests/playwright/pages/DeviceDetailPage.ts
//
// The tab labels from the live component (DeviceDetails.tsx) are used here, not
// the YAML descriptions. Key differences vs the old YAML:
//   YAML "Device Details"   → live label "Details"
//   YAML "Hardware Inventory" → live label "Hardware"
//   YAML "Software Inventory" → live label "Software"
//   YAML "Patch Status"       → live label "Patches"
//   YAML "Script History"     → live label "Scripts"
//   YAML "Alert History"      → live label "Alerts"
//   YAML "Network Connections" → live label "Connections"
//   YAML "Effective Config"   → live label "Config"
//   YAML "Boot Performance"   → live label "Boot Perf"
import { BasePage } from './BasePage';

export class DeviceDetailPage extends BasePage {
  // Navigation
  backButton = () => this.page.getByRole('button', { name: 'Back to devices' });

  // Status badge — device can be Online / Offline / Maintenance
  statusBadge = () =>
    this.page.getByText(/Online|Offline|Maintenance/).first();

  // Overview tab metric cards
  cpuCard = () => this.page.getByText('CPU').first();
  ramCard = () => this.page.getByText('RAM').first();
  lastSeenCard = () => this.page.getByText('Last Seen').first();
  uptimeCard = () => this.page.getByText('Uptime').first();
  loggedInUserCard = () => this.page.getByText('Logged-in User').first();

  // Performance time-range buttons (Performance tab)
  btn24h = () => this.page.getByRole('button', { name: '24h' });
  btn7d = () => this.page.getByRole('button', { name: '7d' });
  btn30d = () => this.page.getByRole('button', { name: '30d' });

  // Error state
  deviceNotFoundText = () => this.page.getByText('Device not found');
  goBackButton = () => this.page.getByRole('button', { name: 'Go back' });

  // Tab navigation — use the live label names from DeviceDetails.tsx
  tab(label: string) {
    // Tabs are rendered via OverflowTabs inside a <nav>.
    // Use exact:false to handle labels that appear in other contexts too.
    return this.page.getByRole('button', { name: label, exact: true });
  }

  async goto(deviceId: string) {
    await this.page.goto(`/devices/${deviceId}`);
    await this.tab('Overview').waitFor();
  }

  async clickTab(label: string) {
    await this.tab(label).click();
  }
}
