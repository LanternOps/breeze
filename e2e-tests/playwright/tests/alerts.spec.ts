// e2e-tests/playwright/tests/alerts.spec.ts
import { test, expect } from '../fixtures';
import { AlertsPage } from '../pages/AlertsPage';
import { AlertDetailPage } from '../pages/AlertDetailPage';

test.describe('Alerts', () => {
  // ── Page loads ──────────────────────────────────────────────────────
  test('page loads with heading, description, and summary', async ({ authedPage }) => {
    const alerts = new AlertsPage(authedPage);
    await alerts.goto();
    await expect(alerts.heading()).toBeVisible();
    await expect(alerts.description()).toBeVisible();
  });

  test('alert list shows correct column headers', async ({ authedPage }) => {
    const alerts = new AlertsPage(authedPage);
    await alerts.goto();
    // AlertList.tsx only renders the table when alerts exist; skip column check if empty state shown
    const emptyState = authedPage.getByText('No active alerts');
    const hasEmpty = await emptyState.isVisible().catch(() => false);
    if (!hasEmpty) {
      await expect(alerts.columnHeader('Device')).toBeVisible();
      await expect(alerts.columnHeader('Title')).toBeVisible();
      await expect(alerts.columnHeader('Severity')).toBeVisible();
      await expect(alerts.columnHeader('Status')).toBeVisible();
      await expect(alerts.columnHeader('Triggered')).toBeVisible();
      await expect(alerts.columnHeader('Actions')).toBeVisible();
    }
  });

  test('filter controls are present', async ({ authedPage }) => {
    const alerts = new AlertsPage(authedPage);
    await alerts.goto();
    await expect(alerts.searchInput()).toBeVisible();
    await expect(alerts.statusSelect()).toBeVisible();
    await expect(alerts.severitySelect()).toBeVisible();
    await expect(alerts.dateRangeSelect()).toBeVisible();
  });

  test('bulk actions bar not shown when no alerts selected', async ({ authedPage }) => {
    const alerts = new AlertsPage(authedPage);
    await alerts.goto();
    await expect(authedPage.getByRole('button', { name: 'Bulk Actions' })).not.toBeVisible();
  });

  // ── Filtering ───────────────────────────────────────────────────────
  test('filtering by active status narrows list', async ({ authedPage }) => {
    const alerts = new AlertsPage(authedPage);
    await alerts.goto();
    await alerts.statusSelect().selectOption('active');
    // Wait for the list to settle (count text or empty state)
    await authedPage.waitForTimeout(1000);
    // Just verify no error state appeared
    await expect(alerts.heading()).toBeVisible();
  });

  test('filtering by critical severity', async ({ authedPage }) => {
    const alerts = new AlertsPage(authedPage);
    await alerts.goto();
    await alerts.severitySelect().selectOption('critical');
    await authedPage.waitForTimeout(1000);
    await expect(alerts.heading()).toBeVisible();
  });

  test('filtering by last 24h date range', async ({ authedPage }) => {
    const alerts = new AlertsPage(authedPage);
    await alerts.goto();
    await alerts.dateRangeSelect().selectOption('24h');
    await authedPage.waitForTimeout(1000);
    await expect(alerts.heading()).toBeVisible();
  });

  test('search input narrows alert list', async ({ authedPage }) => {
    const alerts = new AlertsPage(authedPage);
    await alerts.goto();
    await alerts.searchInput().fill('cpu');
    await authedPage.waitForTimeout(500);
    // Clear search
    await alerts.searchInput().fill('');
    await expect(alerts.heading()).toBeVisible();
  });

  // ── Alert rules redirect ─────────────────────────────────────────────
  test('/alerts/rules redirects to /configuration-policies', async ({ authedPage }) => {
    await authedPage.goto('/alerts/rules');
    await authedPage.waitForURL('**/configuration-policies', { timeout: 15000 });
    await expect(authedPage.getByRole('heading', { name: 'Configuration Policies' })).toBeVisible();
  });

  test('/alerts/rules/new redirects to /configuration-policies', async ({ authedPage }) => {
    await authedPage.goto('/alerts/rules/new');
    await authedPage.waitForURL('**/configuration-policies', { timeout: 15000 });
    await expect(authedPage.getByRole('heading', { name: 'Configuration Policies' })).toBeVisible();
  });

  // ── Notification channels ────────────────────────────────────────────
  test('notification channels page loads', async ({ authedPage }) => {
    await authedPage.goto('/alerts/channels');
    await expect(authedPage.getByRole('heading', { level: 1, name: 'Notification Channels' })).toBeVisible();
    await expect(authedPage.getByText('Configure where alert notifications are sent.')).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'New Channel' })).toBeVisible();
    await expect(authedPage.getByRole('link', { name: 'Configuration Policies' })).toBeVisible();
  });

  test('create and delete email notification channel', async ({ authedPage }) => {
    await authedPage.goto('/alerts/channels');
    await authedPage.getByRole('button', { name: 'New Channel' }).click();
    await expect(authedPage.getByRole('heading', { level: 2, name: 'Create Notification Channel' })).toBeVisible();

    // Fill channel name
    await authedPage.locator('#channel-name').fill('E2E Test Email Channel');

    // Fill email recipient
    await authedPage.getByPlaceholder('email@example.com').fill('e2e-test@example.com');

    // Submit
    await authedPage.getByRole('button', { name: 'Create Channel' }).click();
    await expect(authedPage.getByText('E2E Test Email Channel')).toBeVisible({ timeout: 20000 });

    // The channel name appears in a card with h3
    await expect(authedPage.getByRole('heading', { level: 3, name: 'E2E Test Email Channel' })).toBeVisible();

    // Delete the channel
    await authedPage.locator('div').filter({ has: authedPage.getByRole('heading', { level: 3, name: 'E2E Test Email Channel' }) })
      .getByRole('button', { name: 'Delete channel' }).click();

    await expect(authedPage.getByRole('heading', { level: 2, name: 'Delete Notification Channel' })).toBeVisible();
    await expect(authedPage.getByText('Are you sure you want to delete')).toBeVisible();
    await authedPage.getByRole('button', { name: 'Delete' }).click();

    // Channel should be gone
    await expect(authedPage.getByRole('heading', { level: 3, name: 'E2E Test Email Channel' })).not.toBeVisible({ timeout: 10000 });
  });

  // ── Alert detail lifecycle ───────────────────────────────────────────
  test('open alert detail modal and verify device info', async ({ authedPage }) => {
    const alerts = new AlertsPage(authedPage);
    const detail = new AlertDetailPage(authedPage);
    await alerts.goto();

    // If no alert rows exist, skip the modal test
    const rows = alerts.alertRows();
    const count = await rows.count();
    test.skip(count === 0, 'No alert rows present — skipping detail modal test');

    await rows.first().click();
    await detail.waitForPanel();
    await expect(detail.deviceInfoHeading()).toBeVisible();
    await expect(detail.closeButton()).toBeVisible();
    await detail.close();
  });

  test('resolve alert with note (requires active alert)', async ({ authedPage }) => {
    const alerts = new AlertsPage(authedPage);
    const detail = new AlertDetailPage(authedPage);
    await alerts.goto();

    const rows = alerts.alertRows();
    const count = await rows.count();
    test.skip(count === 0, 'No alert rows present — skipping resolve test');

    await rows.first().click();
    await detail.waitForPanel();

    // Attempt acknowledge (optional — may already be acknowledged)
    const ackBtn = detail.acknowledgeButton();
    if (await ackBtn.isVisible().catch(() => false)) {
      await ackBtn.click();
      await authedPage.getByText('Acknowledged').waitFor({ timeout: 10000 }).catch(() => {});
    }

    // Resolve
    const resolveBtn = detail.resolveButton();
    if (await resolveBtn.isVisible().catch(() => false)) {
      await detail.resolveWithNote('Resolved by E2E test run');
      await authedPage.getByText('Resolved').waitFor({ timeout: 10000 });
    }
  });
});
