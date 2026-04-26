// e2e-tests/playwright/pages/MonitoringDashboardPage.ts
// Covers MonitoringPage.tsx and MonitoringAssetsDashboard.tsx on /monitoring
import { BasePage } from './BasePage';

export class MonitoringDashboardPage extends BasePage {
  readonly url = '/monitoring';

  heading() {
    return this.page.getByText('Monitoring', { exact: true });
  }

  description() {
    return this.page.getByText('SNMP polling and network checks.');
  }

  // Tab buttons
  assetsTabButton() {
    return this.page.getByRole('button', { name: 'Assets' });
  }

  networkChecksTabButton() {
    return this.page.getByRole('button', { name: 'Network Checks' });
  }

  snmpTemplatesTabButton() {
    return this.page.getByRole('button', { name: 'SNMP Templates' });
  }

  // Summary stat cards (MonitoringAssetsDashboard)
  statCard(name: string) {
    return this.page.getByText(name, { exact: true });
  }

  // Assets table heading
  assetsTableHeading() {
    return this.page.getByRole('heading', { level: 2, name: 'Assets' });
  }

  assetsTableDescription() {
    return this.page.getByText('Unified view of SNMP polling and network checks per discovered asset.');
  }

  columnHeader(name: string) {
    return this.page.getByRole('columnheader', { name });
  }

  showingMonitoredAssetsButton() {
    return this.page.getByRole('button', { name: 'Showing monitored assets' });
  }

  showingAllAssetsButton() {
    return this.page.getByRole('button', { name: 'Showing all discovered assets' });
  }

  manageNetworkChecksButton() {
    return this.page.getByRole('button', { name: 'Manage network checks' });
  }

  refreshButton() {
    return this.page.getByRole('button', { name: 'Refresh' });
  }

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor({ timeout: 15000 });
  }

  async gotoWithTab(tab: 'checks' | 'templates') {
    await this.page.goto(`${this.url}?tab=${tab}`);
    await this.heading().waitFor({ timeout: 15000 });
  }
}
