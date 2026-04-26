// e2e-tests/playwright/pages/ReportsPage.ts
import { BasePage } from './BasePage';

export class ReportsPage extends BasePage {
  // Reports list (/reports)
  heading = () => this.page.getByText('Reports');
  reportsDescription = () => this.page.getByText('Generate and schedule reports for your infrastructure.');
  savedReportsTab = () => this.page.getByRole('button', { name: 'Saved Reports' });
  recentRunsTab = () => this.page.getByRole('button', { name: 'Recent Runs' });
  adhocReportLink = () => this.page.getByRole('link', { name: 'Ad-hoc Report' });
  newReportLink = () => this.page.getByRole('link', { name: 'New Report' });

  async goto() {
    await this.page.goto('/reports');
    await this.heading().waitFor();
  }

  // New Report page (/reports/new)
  createReportHeading = () => this.page.getByText('Create Report');
  createReportDescription = () => this.page.getByText('Configure a new report to track and analyze your infrastructure.');
  devicesTypeCard = () => this.page.getByText('Devices');
  alertsTypeCard = () => this.page.getByText('Alerts');
  patchesTypeCard = () => this.page.getByText('Patches');
  complianceTypeCard = () => this.page.getByText('Compliance');
  activityTypeCard = () => this.page.getByText('Activity');

  async gotoNewReport() {
    await this.page.goto('/reports/new');
    await this.createReportHeading().waitFor();
  }

  // Builder page (/reports/builder)
  reportBuilderHeading = () => this.page.getByText('Report Builder');
  reportBuilderDescription = () => this.page.getByText('Design, schedule, and distribute reports with live previews.');

  async gotoBuilder() {
    await this.page.goto('/reports/builder');
    await this.reportBuilderHeading().waitFor();
  }

  // Analytics (/analytics)
  analyticsHeading = () => this.page.getByText('Analytics');
  analyticsDescription = () => this.page.getByText('Insights across your fleet and services');
  refreshButton = () => this.page.getByRole('button', { name: 'Refresh' });
  dashboardSelector = () => this.page.getByRole('combobox').filter({ has: this.page.getByRole('option', { name: /operations/i }) });
  updatedText = () => this.page.getByText('Updated');

  async gotoAnalytics() {
    await this.page.goto('/analytics');
    await this.analyticsHeading().waitFor();
  }
}
