// e2e-tests/playwright/pages/DashboardComprehensivePage.ts
// Note: This POM is separate from DashboardPage.ts (owned by foundation/Task 3).
// It covers the additional comprehensive smoke-test assertions.
import { BasePage } from './BasePage';

export class DashboardComprehensivePage extends BasePage {
  url = '/';

  // Heading
  welcomeHeading = () => this.page.getByRole('heading', { level: 1 });

  // Stat cards
  totalDevicesCard = () => this.page.getByText('Total Devices');
  onlineCard = () => this.page.getByText('Online', { exact: true });
  warningsCard = () => this.page.getByText('Warnings');
  criticalCard = () => this.page.getByText('Critical');

  // Panels
  deviceStatusPanel = () => this.page.getByText('Device Status');
  recentAlertsPanel = () => this.page.getByText('Recent Alerts');
  viewAllAlertsLink = () => this.page.getByRole('link', { name: 'View all' });
  recentActivityPanel = () => this.page.getByText('Recent Activity');
  viewAuditLogLink = () => this.page.getByRole('link', { name: 'View audit log' });

  // Sidebar nav links
  dashboardNavLink = () => this.page.getByRole('navigation').getByRole('link', { name: 'Dashboard' });
  devicesNavLink = () => this.page.getByRole('navigation').getByRole('link', { name: 'Devices' });
  scriptsNavLink = () => this.page.getByRole('navigation').getByRole('link', { name: 'Scripts' });
  alertsNavLink = () => this.page.getByRole('navigation').getByRole('link', { name: 'Alerts' });
  remoteAccessNavLink = () => this.page.getByRole('navigation').getByRole('link', { name: 'Remote Access' });

  // Command palette
  commandPaletteButton = () =>
    this.page.getByRole('button', { name: 'Search devices, scripts, alerts, users, settings' });
  commandPaletteDialog = () => this.page.getByRole('dialog');

  // User menu
  userMenuButton = () => this.page.getByRole('button', { name: /account menu/i }).or(
    this.page.locator('[aria-haspopup="true"]').first()
  );
  profileMenuLink = () => this.page.getByRole('link', { name: 'Profile' });
  settingsMenuLink = () => this.page.getByRole('link', { name: 'Settings' });
  signOutButton = () => this.page.getByRole('button', { name: 'Sign out' });

  // Dark mode
  darkModeToggle = () =>
    this.page.getByRole('button', { name: 'Switch to dark mode' }).or(
      this.page.getByRole('button', { name: 'Switch to light mode' })
    );

  async goto() {
    await this.page.goto(this.url);
    await this.welcomeHeading().waitFor();
  }
}
