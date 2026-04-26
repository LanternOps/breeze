// e2e-tests/playwright/pages/CisHardeningPage.ts
import { BasePage } from './BasePage';

export class CisHardeningPage extends BasePage {
  readonly url = '/cis-hardening';

  // ── Navigation ────────────────────────────────────────────────────────────
  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }

  // ── Page-level locators ───────────────────────────────────────────────────
  heading() {
    return this.page.getByRole('heading', { name: /CIS Hardening/i });
  }

  description() {
    return this.page.getByText('Configuration baselines, compliance scoring, and remediation tracking.');
  }

  // ── Summary stat cards ────────────────────────────────────────────────────
  averageScoreCard() {
    return this.page.getByText('Average Score');
  }

  failingDevicesCard() {
    return this.page.getByText('Failing Devices');
  }

  activeBaselinesCard() {
    return this.page.getByText('Active Baselines');
  }

  pendingRemediationsCard() {
    return this.page.getByText('Pending Remediations');
  }

  // ── Tab buttons ───────────────────────────────────────────────────────────
  complianceTab() {
    return this.page.getByRole('button', { name: 'Compliance' });
  }

  baselinesTab() {
    return this.page.getByRole('button', { name: 'Baselines' });
  }

  remediationsTab() {
    return this.page.getByRole('button', { name: 'Remediations' });
  }

  refreshButton() {
    return this.page.getByRole('button', { name: 'Refresh' });
  }

  // ── Compliance tab ────────────────────────────────────────────────────────
  async openComplianceTab() {
    await this.complianceTab().click();
    await this.page.getByRole('table').waitFor();
  }

  complianceTable() {
    return this.page.getByRole('table');
  }

  complianceTableHead() {
    return this.page.getByRole('table').locator('thead');
  }

  searchInput() {
    return this.page.getByPlaceholder('Search hostname or baseline...');
  }

  osFilterSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="windows"]') });
  }

  // ── Baselines tab ─────────────────────────────────────────────────────────
  async openBaselinesTab() {
    await this.baselinesTab().click();
    await this.page.getByRole('heading', { name: 'Baselines' }).waitFor();
  }

  newBaselineButton() {
    return this.page.getByRole('button', { name: 'New Baseline' });
  }

  baselinesTableHead() {
    return this.page.getByRole('table').locator('thead');
  }

  // ── Baseline form ─────────────────────────────────────────────────────────
  async openNewBaselineForm() {
    await this.newBaselineButton().click();
    await this.page.locator('form').waitFor();
  }

  baselineNameInput() {
    return this.page.locator('#bl-name');
  }

  baselineOsSelect() {
    return this.page.locator('#bl-os');
  }

  baselineLevelSelect() {
    return this.page.locator('#bl-level');
  }

  baselineVersionInput() {
    return this.page.locator('#bl-version');
  }

  saveButton() {
    return this.page.getByRole('button', { name: 'Save' });
  }

  cancelButton() {
    return this.page.getByRole('button', { name: 'Cancel' });
  }

  async fillAndSaveBaseline(name: string, os: string, level: string, version: string) {
    await this.baselineNameInput().fill(name);
    await this.baselineOsSelect().selectOption(os);
    await this.baselineLevelSelect().selectOption(level);
    await this.baselineVersionInput().fill(version);
    await this.saveButton().click();
    await this.page.locator('form').waitFor({ state: 'detached', timeout: 15000 });
  }

  // ── Remediations tab ──────────────────────────────────────────────────────
  async openRemediationsTab() {
    await this.remediationsTab().click();
    await this.page.getByRole('heading', { name: 'Remediations' }).waitFor();
  }

  remediationsTableHead() {
    return this.page.getByRole('table').locator('thead');
  }

  statusFilterSelect() {
    return this.page.locator('select').filter({
      has: this.page.locator('option[value="pending_approval"]'),
    });
  }
}
