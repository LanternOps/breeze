// e2e-tests/playwright/pages/RemoteAccessPage.ts
import { BasePage } from './BasePage';

export class RemoteAccessPage extends BasePage {
  // Hub page
  heading = () => this.page.getByRole('heading', { name: 'Remote Access' });
  hubDescription = () => this.page.getByText('Launch remote tools for online devices.');

  // Nav cards
  startTerminalCard = () => this.page.getByText('Start Terminal');
  startTerminalDescription = () => this.page.getByText('Select a device to connect');
  fileTransferCard = () => this.page.getByText('File Transfer');
  fileTransferDescription = () => this.page.getByText('Transfer files to/from devices');
  sessionHistoryCard = () => this.page.getByText('Session History');
  sessionHistoryDescription = () => this.page.getByText('View past sessions');

  terminalLink = () => this.page.getByRole('link', { name: 'Start Terminal' });
  filesLink = () => this.page.getByRole('link', { name: 'File Transfer' });
  sessionsLink = () => this.page.getByRole('link', { name: 'Session History' });

  async goto() {
    await this.page.goto('/remote');
    await this.heading().waitFor();
  }

  // Terminal launcher page (/remote/terminal)
  terminalLauncherHeading = () => this.page.getByRole('heading', { name: 'Start Terminal Session' });
  terminalLauncherDescription = () => this.page.getByText('Choose an online device to open a remote terminal.');
  backLink = () => this.page.getByRole('link', { name: 'Back to Remote Access' });
  searchInput = () => this.page.getByRole('textbox', { name: /search online devices/i });
  refreshButton = () => this.page.getByRole('button', { name: 'Refresh' });

  async gotoTerminalLauncher() {
    await this.page.goto('/remote/terminal');
    await this.terminalLauncherHeading().waitFor();
  }

  // File launcher page (/remote/files)
  fileLauncherHeading = () => this.page.getByRole('heading', { name: 'Start File Transfer' });
  fileLauncherDescription = () => this.page.getByText('Choose an online device to open the remote file manager.');

  async gotoFileLauncher() {
    await this.page.goto('/remote/files');
    await this.fileLauncherHeading().waitFor();
  }

  // Session history page (/remote/sessions)
  sessionHistoryHeading = () => this.page.getByRole('heading', { name: 'Session History' });
  sessionHistoryPageDescription = () => this.page.getByText('View and audit remote access sessions');
  totalSessionsCard = () => this.page.getByText('Total Sessions');
  totalDurationCard = () => this.page.getByText('Total Duration');
  avgDurationCard = () => this.page.getByText('Avg Duration');
  dataTransferredCard = () => this.page.getByText('Data Transferred');
  sessionSearchInput = () => this.page.getByRole('textbox', { name: /search by device or user/i });
  exportButton = () => this.page.getByRole('button', { name: 'Export' });
  typeFilterSelect = () => this.page.getByRole('combobox').filter({ has: this.page.getByRole('option', { name: /all/i }) });

  async gotoSessionHistory() {
    await this.page.goto('/remote/sessions');
    await this.sessionHistoryHeading().waitFor();
  }
}
