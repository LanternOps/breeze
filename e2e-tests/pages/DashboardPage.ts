import { BasePage } from './BasePage';

export class DashboardPage extends BasePage {
  url = '/';

  heading = () => this.page.getByTestId('dashboard-heading');
  stats = () => this.page.getByTestId('dashboard-stats');
  totalDevicesCard = () => this.page.getByTestId('dashboard-total-devices-card');
  onlineCard = () => this.page.getByTestId('dashboard-online-card');
  warningsCard = () => this.page.getByTestId('dashboard-warnings-card');
  criticalCard = () => this.page.getByTestId('dashboard-critical-card');
  recentAlertsHeading = () => this.page.getByTestId('dashboard-recent-alerts-heading');
  recentActivityHeading = () => this.page.getByTestId('dashboard-recent-activity-heading');

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }
}
