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
  fleetStatusCard = () => this.page.getByTestId('dashboard-fleet-status');

  patchCard = () => this.page.getByTestId('dashboard-patch-card');
  /** Any dashboard element by its data-testid (tiles and links share one registry). */
  link = (testId: string) => this.page.getByTestId(testId);
  noncompliantLink = () => this.page.getByTestId('dashboard-patch-noncompliant-link');
  vulnOpenLink = () => this.page.getByTestId('dashboard-vuln-open-link');

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }
}
