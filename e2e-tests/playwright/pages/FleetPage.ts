// e2e-tests/playwright/pages/FleetPage.ts
import { BasePage } from './BasePage';

export class FleetPage extends BasePage {
  url = '/fleet';

  // Page heading
  heading = () => this.page.getByRole('heading', { name: 'Fleet Orchestration' });
  subtitle = () => this.page.getByText('Manage policies, deployments, patches, and automations across your fleet');

  // Refresh
  refreshButton = () => this.page.getByRole('button', { name: 'Refresh' });

  // Stat card titles (rendered via title prop, visible as text)
  policiesCard = () => this.page.getByText('Policies', { exact: true });
  deploymentsCard = () => this.page.getByText('Deployments', { exact: true });
  patchesCard = () => this.page.getByText('Patches', { exact: true });
  alertsCard = () => this.page.getByText('Alerts', { exact: true });
  groupsCard = () => this.page.getByText('Groups', { exact: true });
  automationsCard = () => this.page.getByText('Automations', { exact: true });
  maintenanceCard = () => this.page.getByText('Maintenance', { exact: true });
  reportsCard = () => this.page.getByText('Reports', { exact: true });

  // AI Fleet Actions panel
  aiFleetActionsHeading = () => this.page.getByText('AI Fleet Actions');

  // Quick action chip buttons
  checkComplianceButton = () => this.page.getByRole('button', { name: 'Check compliance' });
  activeDeploymentsButton = () => this.page.getByRole('button', { name: 'Active deployments' });
  criticalPatchesButton = () => this.page.getByRole('button', { name: 'Critical patches' });
  alertOverviewButton = () => this.page.getByRole('button', { name: 'Alert overview' });
  maintenanceWindowsButton = () => this.page.getByRole('button', { name: 'Maintenance windows' });
  runAutomationsButton = () => this.page.getByRole('button', { name: 'Run automations' });
  deviceGroupsButton = () => this.page.getByRole('button', { name: 'Device groups' });
  generateReportButton = () => this.page.getByRole('button', { name: 'Generate report' });

  // Status overview panel headings
  deploymentStatusPanel = () => this.page.getByText('Deployment Status');
  alertBreakdownPanel = () => this.page.getByText('Alert Breakdown');
  patchPosturePanel = () => this.page.getByText('Patch Posture');
  policyCompliancePanel = () => this.page.getByText('Policy Compliance');

  // Deployment status bar labels
  activeLabel = () => this.page.getByText('Active', { exact: true }).first();
  pendingLabel = () => this.page.getByText('Pending', { exact: true }).first();
  completedLabel = () => this.page.getByText('Completed', { exact: true }).first();
  failedLabel = () => this.page.getByText('Failed', { exact: true }).first();

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }
}
