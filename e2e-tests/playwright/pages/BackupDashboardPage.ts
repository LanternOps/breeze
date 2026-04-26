// e2e-tests/playwright/pages/BackupDashboardPage.ts
import { BasePage } from './BasePage';

export class BackupDashboardPage extends BasePage {
  readonly url = '/backup';

  // ── Navigation ────────────────────────────────────────────────────────────
  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  // ── Page-level locators ───────────────────────────────────────────────────
  heading() {
    return this.page.getByRole('heading', { name: 'Backup Overview' });
  }

  description() {
    return this.page.getByText('Monitor protection coverage, storage trends, and recent activity.');
  }

  // ── Action buttons ────────────────────────────────────────────────────────
  runAllBackupsButton() {
    return this.page.getByRole('button', { name: 'Run all backups' });
  }

  viewFailedButton() {
    return this.page.getByRole('button', { name: 'View failed' });
  }

  // ── Recent Jobs section ───────────────────────────────────────────────────
  recentJobsHeading() {
    return this.page.getByRole('heading', { name: 'Recent Jobs' });
  }

  recentJobsDescription() {
    return this.page.getByText('Latest backup activity across sites.');
  }

  viewAllButton() {
    return this.page.getByRole('button', { name: 'View all' });
  }

  // ── Storage by Provider section ───────────────────────────────────────────
  storageByProviderHeading() {
    return this.page.getByRole('heading', { name: 'Storage by Provider' });
  }

  storageByProviderDescription() {
    return this.page.getByText('Current usage and capacity.');
  }

  // ── Overdue Devices section ───────────────────────────────────────────────
  overdueDevicesHeading() {
    return this.page.getByRole('heading', { name: 'Devices Needing Backup' });
  }

  overdueScheduleText() {
    return this.page.getByText('Overdue based on schedule.');
  }

  runOverdueBackupsButton() {
    return this.page.getByRole('button', { name: 'Run overdue backups' });
  }

  // ── Attention Needed section ──────────────────────────────────────────────
  attentionNeededHeading() {
    return this.page.getByRole('heading', { name: 'Attention Needed' });
  }

  attentionNeededDescription() {
    return this.page.getByText('Alerts for backup performance and coverage.');
  }

  resolveAllButton() {
    return this.page.getByRole('button', { name: 'Resolve all' });
  }
}
