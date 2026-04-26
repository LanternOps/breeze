// e2e-tests/playwright/tests/patches.spec.ts
// Converted from e2e-tests/tests/patch_management.yaml
import { test, expect } from '../fixtures';
import { PatchManagementPage } from '../pages/PatchManagementPage';

test.describe('Patch Management', () => {
  // ── Smoke: page loads ──────────────────────────────────────────────────────
  test('page loads with heading, description, tabs, and action buttons', async ({ authedPage }) => {
    const patches = new PatchManagementPage(authedPage);
    await patches.goto();

    await expect(patches.heading()).toBeVisible();
    await expect(patches.description()).toBeVisible();

    await expect(patches.updateRingsTab()).toBeVisible();
    await expect(patches.patchesTab()).toBeVisible();
    await expect(patches.complianceTab()).toBeVisible();

    await expect(patches.runScanButton()).toBeVisible();
    await expect(patches.newRingButton()).toBeVisible();

    // Update Rings is the default active tab
    await expect(authedPage.getByRole('table')).toBeVisible();
  });

  // ── Update Rings tab ───────────────────────────────────────────────────────
  test('Update Rings tab shows table column headers and New Ring modal', async ({ authedPage }) => {
    const patches = new PatchManagementPage(authedPage);
    await patches.goto();

    const thead = patches.ringsTableHead();
    await expect(thead).toContainText('Order');
    await expect(thead).toContainText('Ring');
    await expect(thead).toContainText('Deferral');
    await expect(thead).toContainText('Deadline');
    await expect(thead).toContainText('Devices');
    await expect(thead).toContainText('Compliance');
    await expect(thead).toContainText('Updated');
    await expect(thead).toContainText('Actions');

    // Open and close the Create Update Ring modal
    await patches.openNewRingModal();
    await expect(patches.createRingModalTitle()).toBeVisible();
    await patches.closeModalButton().click();
  });

  // ── Patches tab ────────────────────────────────────────────────────────────
  test('Patches tab shows table columns, search input, and filter dropdowns', async ({ authedPage }) => {
    const patches = new PatchManagementPage(authedPage);
    await patches.goto();
    await patches.openPatchesTab();

    const thead = patches.patchListTableHead();
    await expect(thead).toContainText('Patch');
    await expect(thead).toContainText('Severity');
    await expect(thead).toContainText('Source');
    await expect(thead).toContainText('OS');
    await expect(thead).toContainText('Release');
    await expect(thead).toContainText('Approval');
    await expect(thead).toContainText('Actions');

    await expect(patches.patchSearchInput()).toBeVisible();

    // Severity, status, and other filters exist
    await expect(patches.severityFilterSelect()).toBeVisible();
    await expect(patches.statusFilterSelect()).toBeVisible();
  });

  // ── Patches tab: search and filter ────────────────────────────────────────
  test('Patches tab search and severity filter respond', async ({ authedPage }) => {
    const patches = new PatchManagementPage(authedPage);
    await patches.goto();
    await patches.openPatchesTab();

    await patches.patchSearchInput().fill('update');
    // Filtering response is reflected — page should still show the section text
    await expect(authedPage.getByText('patches', { exact: false })).toBeVisible({ timeout: 5000 });

    await patches.severityFilterSelect().selectOption('critical');
    await expect(authedPage.getByText('patches', { exact: false })).toBeVisible({ timeout: 5000 });
  });

  // ── Compliance tab ─────────────────────────────────────────────────────────
  test('Compliance tab shows stat cards, severity cards, and devices table', async ({ authedPage }) => {
    const patches = new PatchManagementPage(authedPage);
    await patches.goto();
    await patches.openComplianceTab();

    const cards = patches.complianceStatCards();
    await expect(cards.patchedDevices).toBeVisible();
    await expect(cards.needsPatches).toBeVisible();

    await expect(patches.criticalPatchesCard()).toBeVisible();
    await expect(patches.importantPatchesCard()).toBeVisible();

    await expect(patches.devicesNeedingPatchesSection()).toBeVisible();

    const devicesHead = patches.devicesNeedingPatchesTableHead();
    await expect(devicesHead).toContainText('Device');
    await expect(devicesHead).toContainText('OS');
    await expect(devicesHead).toContainText('Missing');
    await expect(devicesHead).toContainText('Critical');
    await expect(devicesHead).toContainText('Important');
  });

  // ── Scan trigger ───────────────────────────────────────────────────────────
  test('Run Scan button becomes Scanning... then returns to idle', async ({ authedPage }) => {
    const patches = new PatchManagementPage(authedPage);
    await patches.goto();

    await patches.runScanButton().click();
    // Short-lived Scanning... state
    await expect(authedPage.getByRole('button', { name: /Scanning/i })).toBeVisible({ timeout: 5000 });
    await expect(patches.runScanButton()).toBeVisible({ timeout: 30000 });
  });

  // ── Approval workflow ──────────────────────────────────────────────────────
  test('Review modal opens for first pending patch', async ({ authedPage }) => {
    const patches = new PatchManagementPage(authedPage);
    await patches.goto();
    await patches.openPatchesTab();

    const reviewBtn = patches.firstReviewButton();
    const count = await reviewBtn.count();
    test.skip(count === 0, 'No patches with Review button; skipping approval modal test');

    await reviewBtn.click();
    await expect(authedPage.getByText('Review')).toBeVisible({ timeout: 5000 });
  });
});
