// e2e-tests/playwright/tests/cis.spec.ts
// Converted from e2e-tests/tests/cis_hardening.yaml
import { test, expect } from '../fixtures';
import { CisHardeningPage } from '../pages/CisHardeningPage';

test.describe('CIS Hardening', () => {
  // ── Smoke: page loads ──────────────────────────────────────────────────────
  test('page loads with summary cards and tabs', async ({ authedPage }) => {
    const cis = new CisHardeningPage(authedPage);
    await cis.goto();

    await expect(cis.heading()).toBeVisible();
    await expect(cis.description()).toBeVisible();

    await expect(cis.averageScoreCard()).toBeVisible();
    await expect(cis.failingDevicesCard()).toBeVisible();
    await expect(cis.activeBaselinesCard()).toBeVisible();
    await expect(cis.pendingRemediationsCard()).toBeVisible();

    await expect(cis.complianceTab()).toBeVisible();
    await expect(cis.baselinesTab()).toBeVisible();
    await expect(cis.remediationsTab()).toBeVisible();
    await expect(cis.refreshButton()).toBeVisible();
  });

  // ── Compliance tab ─────────────────────────────────────────────────────────
  test('Compliance tab shows table, search input, and OS filter', async ({ authedPage }) => {
    const cis = new CisHardeningPage(authedPage);
    await cis.goto();
    await cis.openComplianceTab();

    const thead = cis.complianceTableHead();
    await expect(thead).toContainText('Device');
    await expect(thead).toContainText('Baseline');
    await expect(thead).toContainText('OS');
    await expect(thead).toContainText('Score');
    await expect(thead).toContainText('Failed Checks');
    await expect(thead).toContainText('Last Scanned');

    await expect(cis.searchInput()).toBeVisible();

    // OS filter: verify all platform options exist
    const osFilter = cis.osFilterSelect();
    await expect(osFilter.locator('option[value="windows"]')).toHaveCount(1);
    await expect(osFilter.locator('option[value="macos"]')).toHaveCount(1);
    await expect(osFilter.locator('option[value="linux"]')).toHaveCount(1);

    // Filter by Linux — table body should still be present
    await osFilter.selectOption('linux');
    await expect(authedPage.getByRole('table').locator('tbody')).toBeVisible();
  });

  // ── Baselines tab ──────────────────────────────────────────────────────────
  test('Baselines tab shows table columns and New Baseline button', async ({ authedPage }) => {
    const cis = new CisHardeningPage(authedPage);
    await cis.goto();
    await cis.openBaselinesTab();

    await expect(cis.newBaselineButton()).toBeVisible();

    const thead = cis.baselinesTableHead();
    await expect(thead).toContainText('Name');
    await expect(thead).toContainText('OS');
    await expect(thead).toContainText('Level');
    await expect(thead).toContainText('Version');
    await expect(thead).toContainText('Schedule');
    await expect(thead).toContainText('Status');
    await expect(thead).toContainText('Actions');
  });

  // ── Remediations tab ───────────────────────────────────────────────────────
  test('Remediations tab shows table columns and status filter', async ({ authedPage }) => {
    const cis = new CisHardeningPage(authedPage);
    await cis.goto();
    await cis.openRemediationsTab();

    const thead = cis.remediationsTableHead();
    await expect(thead).toContainText('Check ID');
    await expect(thead).toContainText('Device');
    await expect(thead).toContainText('Baseline');
    await expect(thead).toContainText('Action');
    await expect(thead).toContainText('Status');
    await expect(thead).toContainText('Approval');
    await expect(thead).toContainText('Requested');
    await expect(thead).toContainText('Completed');

    const statusFilter = cis.statusFilterSelect();
    await expect(statusFilter.locator('option[value="pending_approval"]')).toHaveCount(1);
    await expect(statusFilter.locator('option[value="queued"]')).toHaveCount(1);
    await expect(statusFilter.locator('option[value="completed"]')).toHaveCount(1);
    await expect(statusFilter.locator('option[value="failed"]')).toHaveCount(1);

    // Filter by pending_approval — table body should still be present
    await statusFilter.selectOption('pending_approval');
    await expect(authedPage.getByRole('table').locator('tbody')).toBeVisible();
  });

  // ── Baseline CRUD: create via UI ───────────────────────────────────────────
  test('creates a new baseline via the form, verifies in table', async ({ authedPage }) => {
    const cis = new CisHardeningPage(authedPage);
    await cis.goto();
    await cis.openBaselinesTab();
    await cis.openNewBaselineForm();
    await cis.fillAndSaveBaseline('E2E Linux CIS L1', 'linux', 'l1', '2.0.0');

    await expect(authedPage.getByText('E2E Linux CIS L1')).toBeVisible({ timeout: 10000 });
  });

  // ── Baseline edit: open form, verify pre-populated, cancel ────────────────
  test('edit form opens pre-populated and can be cancelled', async ({ authedPage }) => {
    const cis = new CisHardeningPage(authedPage);
    await cis.goto();
    await cis.openBaselinesTab();

    // Need at least one baseline row — skip gracefully if none exist yet
    const editButton = authedPage.locator('table tbody button[title="Edit"]').first();
    const count = await editButton.count();
    test.skip(count === 0, 'No baselines to edit; skipping edit form test');

    await editButton.click();
    await authedPage.locator('form').waitFor({ timeout: 10000 });

    await expect(authedPage.getByText('Edit Baseline')).toBeVisible({ timeout: 5000 });
    await expect(authedPage.locator('#bl-name')).toBeVisible();
    await expect(authedPage.locator('#bl-os')).toBeVisible();
    await expect(authedPage.locator('#bl-level')).toBeVisible();
    await expect(authedPage.locator('#bl-version')).toBeVisible();

    await cis.cancelButton().click();
    await authedPage.locator('form').waitFor({ state: 'detached', timeout: 5000 });
  });

  // ── Full scan lifecycle (non-live gate) ────────────────────────────────────
  // This test creates a Windows baseline, triggers a scan, and checks UI state.
  // It intentionally does NOT poll agent diagnostic logs — that requires a live agent.
  test('can create baseline and trigger scan from UI', async ({ authedPage }) => {
    const cis = new CisHardeningPage(authedPage);
    await cis.goto();
    await cis.openBaselinesTab();
    await cis.openNewBaselineForm();
    await cis.fillAndSaveBaseline('E2E Win Scan Lifecycle', 'windows', 'l1', '3.0.0');

    await expect(authedPage.getByText('E2E Win Scan Lifecycle')).toBeVisible({ timeout: 10000 });

    // Trigger Scan button may not exist if no agents are enrolled for windows
    const triggerScanBtn = authedPage
      .locator('tr')
      .filter({ hasText: 'E2E Win Scan Lifecycle' })
      .getByRole('button', { name: /Trigger Scan/i });

    if ((await triggerScanBtn.count()) > 0) {
      await triggerScanBtn.click();
    }

    // Compliance tab should still render
    await cis.complianceTab().click();
    await authedPage.getByRole('table').waitFor({ timeout: 30000 });

    // Refresh does not break the page
    await cis.refreshButton().click();
    await expect(cis.averageScoreCard()).toBeVisible({ timeout: 10000 });
    await expect(cis.activeBaselinesCard()).toBeVisible();
  });

  // ── Remediation workflow ───────────────────────────────────────────────────
  test('Remediations tab is navigable and table renders', async ({ authedPage }) => {
    const cis = new CisHardeningPage(authedPage);
    await cis.goto();
    await cis.openRemediationsTab();
    await expect(authedPage.getByRole('table').locator('tbody')).toBeVisible();
  });
});
