// e2e-tests/playwright/pages/DiscoveryPage.ts
import { BasePage } from './BasePage';

export class DiscoveryPage extends BasePage {
  url = '/discovery';

  // Page heading / subtitle
  heading = () => this.page.getByRole('heading', { name: 'Network Discovery' });
  subtitle = () => this.page.getByText('Configure discovery profiles, monitor scans, and manage network assets.');

  // Tab buttons — labels from DiscoveryPage.tsx tabLabels map
  assetsTab = () => this.page.getByRole('button', { name: 'Assets', exact: true });
  profilesTab = () => this.page.getByRole('button', { name: 'Profiles', exact: true });
  jobsTab = () => this.page.getByRole('button', { name: 'Jobs', exact: true });
  topologyTab = () => this.page.getByRole('button', { name: 'Topology', exact: true });
  changesTab = () => this.page.getByRole('button', { name: 'Changes', exact: true });

  // Profiles tab content
  discoveryProfilesHeading = () => this.page.getByRole('heading', { name: 'Discovery Profiles' });
  newProfileButton = () => this.page.getByRole('button', { name: 'New Profile' });

  // New profile modal
  newProfileModalHeading = () => this.page.getByText('New Discovery Profile');
  profileNameInput = () => this.page.getByPlaceholder('Headquarters scan');
  profileSubnetInput = () => this.page.locator('textarea[placeholder*="10.0.0.0/24"]');
  icmpPingCheckbox = () => this.page.getByLabel('ICMP Ping');
  tcpPortScanCheckbox = () => this.page.getByLabel('TCP Port Scan');
  createProfileButton = () => this.page.getByRole('button', { name: 'Create Profile' });

  // Profiles count text (e.g. "3 profiles configured")
  profilesConfiguredText = () => this.page.getByText(/profiles configured/);

  // Run now button (in profile list row)
  runNowButton = () => this.page.getByRole('button', { name: 'Run now' }).first();

  // Jobs tab content
  discoveryJobsHeading = () => this.page.getByRole('heading', { name: 'Discovery Jobs' });
  jobsProfileColumn = () => this.page.getByRole('columnheader', { name: 'Profile' });
  jobsStatusColumn = () => this.page.getByRole('columnheader', { name: 'Status' });
  jobsHostsDiscoveredColumn = () => this.page.getByRole('columnheader', { name: 'Hosts discovered' });
  jobsNewAssetsColumn = () => this.page.getByRole('columnheader', { name: 'New assets' });

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  async clickTab(label: 'Assets' | 'Profiles' | 'Jobs' | 'Topology' | 'Changes') {
    await this.page.getByRole('button', { name: label, exact: true }).click();
  }
}
