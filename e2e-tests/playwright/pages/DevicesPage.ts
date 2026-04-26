// e2e-tests/playwright/pages/DevicesPage.ts
import { BasePage } from './BasePage';

export class DevicesPage extends BasePage {
  url = '/devices';

  // Page heading
  heading = () => this.page.getByRole('heading', { name: 'Devices' });

  // Search and filters
  searchInput = () => this.page.getByPlaceholder('Search by hostname');
  statusFilter = () => this.page.getByRole('combobox', { name: 'Filter by status' });
  osFilter = () => this.page.getByRole('combobox', { name: 'Filter by operating system' });

  // View toggles
  listViewButton = () => this.page.getByRole('button', { name: 'List view' });
  gridViewButton = () => this.page.getByRole('button', { name: 'Grid view' });

  // Add device
  addDeviceButton = () => this.page.getByRole('button', { name: 'Add Device' });

  // Table column headers (use getByRole on columnheader)
  hostnameColumnHeader = () => this.page.getByRole('columnheader', { name: 'Hostname' });
  organizationColumnHeader = () => this.page.getByRole('columnheader', { name: 'Organization' });
  siteColumnHeader = () => this.page.getByRole('columnheader', { name: 'Site' });
  osColumnHeader = () => this.page.getByRole('columnheader', { name: 'OS' });
  statusColumnHeader = () => this.page.getByRole('columnheader', { name: 'Status' });
  cpuColumnHeader = () => this.page.getByRole('columnheader', { name: 'CPU %' });
  ramColumnHeader = () => this.page.getByRole('columnheader', { name: 'RAM %' });
  lastSeenColumnHeader = () => this.page.getByRole('columnheader', { name: 'Last Seen' });
  actionsColumnHeader = () => this.page.getByRole('columnheader', { name: 'Actions' });

  // Subtitle text
  subtitleText = () => this.page.getByText('Manage and monitor your fleet');

  // Empty state
  noDevicesText = () => this.page.getByText('No devices found. Try adjusting your search or filters.');

  // Bulk selection
  selectedCountText = (n: number) => this.page.getByText(`${n} selected`);
  bulkActionsButton = () => this.page.getByRole('button', { name: 'Bulk Actions' });
  clearSelectionButton = () => this.page.getByRole('button', { name: 'Clear selection' });

  // Row checkboxes (first row)
  firstRowCheckbox = () => this.page.locator('tbody tr:first-child input[type="checkbox"]');

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  async waitForTable() {
    await this.hostnameColumnHeader().waitFor();
  }
}
