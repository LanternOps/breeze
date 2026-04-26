// e2e-tests/playwright/tests/backup.spec.ts
// Converted from e2e-tests/tests/backup_lifecycle.yaml
import { test, expect } from '../fixtures';
import { BackupDashboardPage } from '../pages/BackupDashboardPage';

test.describe('Backup Dashboard', () => {
  // ── Smoke: page loads ──────────────────────────────────────────────────────
  test('Backup Overview page loads with heading, description, and action buttons', async ({ authedPage }) => {
    const backup = new BackupDashboardPage(authedPage);
    await backup.goto();

    await expect(backup.heading()).toBeVisible();
    await expect(backup.description()).toBeVisible();
    await expect(backup.runAllBackupsButton()).toBeVisible();
    await expect(backup.viewFailedButton()).toBeVisible();
  });

  // ── Stat cards and sections ────────────────────────────────────────────────
  test('Recent Jobs section and Storage by Provider section render', async ({ authedPage }) => {
    const backup = new BackupDashboardPage(authedPage);
    await backup.goto();

    await expect(backup.recentJobsHeading()).toBeVisible();
    await expect(backup.recentJobsDescription()).toBeVisible();
    await expect(backup.viewAllButton()).toBeVisible();

    await expect(backup.storageByProviderHeading()).toBeVisible();
    await expect(backup.storageByProviderDescription()).toBeVisible();
  });

  // ── Overdue devices and Attention Needed sections ──────────────────────────
  test('Devices Needing Backup and Attention Needed sections render', async ({ authedPage }) => {
    const backup = new BackupDashboardPage(authedPage);
    await backup.goto();

    await expect(backup.overdueDevicesHeading()).toBeVisible();
    await expect(backup.overdueScheduleText()).toBeVisible();
    await expect(backup.runOverdueBackupsButton()).toBeVisible();

    await expect(backup.attentionNeededHeading()).toBeVisible();
    await expect(backup.attentionNeededDescription()).toBeVisible();
    await expect(backup.resolveAllButton()).toBeVisible();
  });

  // ── Action buttons are clickable ───────────────────────────────────────────
  test('Run all backups button is interactive', async ({ authedPage }) => {
    const backup = new BackupDashboardPage(authedPage);
    await backup.goto();

    // Just verify it is enabled and clickable — no hard assertion on side effects
    await expect(backup.runAllBackupsButton()).toBeEnabled();
  });

  // ── All major sections present on single page load ─────────────────────────
  test('all dashboard sections present in one page load', async ({ authedPage }) => {
    const backup = new BackupDashboardPage(authedPage);
    await backup.goto();

    await expect(backup.heading()).toBeVisible();
    await expect(backup.recentJobsHeading()).toBeVisible();
    await expect(backup.storageByProviderHeading()).toBeVisible();
    await expect(backup.overdueDevicesHeading()).toBeVisible();
    await expect(backup.attentionNeededHeading()).toBeVisible();
  });
});
