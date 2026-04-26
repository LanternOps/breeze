// e2e-tests/playwright/pages/DashboardPage.ts
import { BasePage } from './BasePage';

export class DashboardPage extends BasePage {
  url = '/';
  heading = () => this.page.getByRole('heading', { level: 1 });
  totalDevicesCard = () => this.page.getByText('Total Devices');
  onlineCard = () => this.page.getByText('Online', { exact: true });
  recentAlertsPanel = () => this.page.getByText('Recent Alerts');
  recentActivityPanel = () => this.page.getByText('Recent Activity');

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }
}
