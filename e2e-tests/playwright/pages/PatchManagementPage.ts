// e2e-tests/playwright/pages/PatchManagementPage.ts
import { BasePage } from './BasePage';

export class PatchManagementPage extends BasePage {
  readonly url = '/patches';

  // ── Navigation ────────────────────────────────────────────────────────────
  async goto() {
    await this.page.goto(this.url);
    await this.page.getByText('Patch Management').first().waitFor();
  }

  // ── Page-level locators ───────────────────────────────────────────────────
  heading() {
    return this.page.getByText('Patch Management').first();
  }

  description() {
    return this.page.getByText('Manage update rings, approvals, compliance, and patch deployments.');
  }

  // ── Action buttons ────────────────────────────────────────────────────────
  runScanButton() {
    return this.page.getByRole('button', { name: 'Run Scan' });
  }

  newRingButton() {
    return this.page.getByRole('button', { name: 'New Ring' });
  }

  // ── Tab buttons ───────────────────────────────────────────────────────────
  updateRingsTab() {
    return this.page.getByRole('button', { name: 'Update Rings' });
  }

  patchesTab() {
    return this.page.getByRole('button', { name: 'Patches' });
  }

  complianceTab() {
    return this.page.getByRole('button', { name: 'Compliance' });
  }

  // ── Update Rings tab ──────────────────────────────────────────────────────
  async openUpdateRingsTab() {
    await this.updateRingsTab().click();
    await this.page.getByRole('table').waitFor();
  }

  ringsTableHead() {
    return this.page.getByRole('table').locator('thead');
  }

  ringsTable() {
    return this.page.getByRole('table');
  }

  // ── Create Ring modal ─────────────────────────────────────────────────────
  async openNewRingModal() {
    await this.newRingButton().click();
    await this.page.getByText('Create Update Ring').waitFor({ timeout: 5000 });
  }

  createRingModalTitle() {
    return this.page.getByText('Create Update Ring');
  }

  closeModalButton() {
    return this.page.getByRole('button', { name: '×' });
  }

  // ── Patches tab ───────────────────────────────────────────────────────────
  async openPatchesTab() {
    await this.patchesTab().click();
    await this.page.getByRole('columnheader', { name: 'Patch' }).waitFor({ timeout: 10000 });
  }

  patchListTableHead() {
    return this.page.getByRole('table').locator('thead');
  }

  patchSearchInput() {
    return this.page.getByPlaceholder('Search patches...');
  }

  severityFilterSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="critical"]') });
  }

  statusFilterSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="pending"]') });
  }

  firstReviewButton() {
    return this.page.getByRole('button', { name: 'Review' }).first();
  }

  // ── Compliance tab ────────────────────────────────────────────────────────
  async openComplianceTab() {
    await this.complianceTab().click();
    await this.page.getByText('Compliance').first().waitFor({ timeout: 10000 });
  }

  complianceStatCards() {
    return {
      compliance: this.page.getByText('Compliance').first(),
      patchedDevices: this.page.getByText('Patched Devices'),
      needsPatches: this.page.getByText('Needs Patches'),
    };
  }

  criticalPatchesCard() {
    return this.page.getByText('Critical Patches');
  }

  importantPatchesCard() {
    return this.page.getByText('Important Patches');
  }

  devicesNeedingPatchesSection() {
    return this.page.getByText('Devices needing patches');
  }

  devicesNeedingPatchesTableHead() {
    return this.page.getByRole('table').last().locator('thead');
  }
}
