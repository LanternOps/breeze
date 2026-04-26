// e2e-tests/playwright/pages/PeripheralsPage.ts
// Covers /peripherals (Peripheral Control) and /sensitive-data (Sensitive Data Discovery)
import { BasePage } from './BasePage';

export class PeripheralsPage extends BasePage {
  // ── Navigation helpers ────────────────────────────────────────────────────
  async gotoPeripherals() {
    await this.page.goto('/peripherals');
    await this.peripheralHeading().waitFor();
  }

  async gotoSensitiveData() {
    await this.page.goto('/sensitive-data');
    await this.sensitiveDataHeading().waitFor();
  }

  async gotoSensitiveDataFindings() {
    await this.page.goto('/sensitive-data#findings');
    await this.sensitiveDataHeading().waitFor();
    await this.findingsSearchInput().waitFor({ timeout: 10000 });
  }

  async gotoSensitiveDataScans() {
    await this.page.goto('/sensitive-data#scans');
    await this.sensitiveDataHeading().waitFor();
    await this.page.getByRole('heading', { name: 'Scans' }).waitFor({ timeout: 10000 });
  }

  // ── Peripheral Control page ───────────────────────────────────────────────
  peripheralHeading() {
    return this.page.getByText('Peripheral Control').first();
  }

  policiesTab() {
    return this.page.getByRole('button', { name: 'Policies' });
  }

  activityLogTab() {
    return this.page.getByRole('button', { name: 'Activity Log' });
  }

  // ── Peripheral Policies tab ───────────────────────────────────────────────
  createPolicyButton() {
    return this.page.getByRole('button', { name: 'Create Policy' });
  }

  deviceClassFilterSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="storage"]') });
  }

  actionFilterSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="allow"]') });
  }

  statusFilterSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="true"]') });
  }

  policiesTableHead() {
    return this.page.getByRole('table').first().locator('thead');
  }

  // ── Activity Log tab ──────────────────────────────────────────────────────
  async openActivityLogTab() {
    await this.activityLogTab().click();
    await this.page.getByRole('table').waitFor({ timeout: 10000 });
  }

  eventTypeFilterSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option[value="connected"]') });
  }

  peripheralTypeInput() {
    return this.page.getByPlaceholder('Peripheral type');
  }

  vendorInput() {
    return this.page.getByPlaceholder('Vendor');
  }

  activityTableHead() {
    return this.page.getByRole('table').locator('thead');
  }

  // ── Sensitive Data Discovery page ─────────────────────────────────────────
  sensitiveDataHeading() {
    return this.page.getByText('Sensitive Data Discovery').first();
  }

  dashboardTab() {
    return this.page.getByRole('button', { name: 'Dashboard' });
  }

  findingsTab() {
    return this.page.getByRole('button', { name: 'Findings' });
  }

  scansTab() {
    return this.page.getByRole('button', { name: 'Scans' });
  }

  sdPoliciesTab() {
    return this.page.getByRole('button', { name: 'Policies' });
  }

  // ── Sensitive Data Dashboard tab ──────────────────────────────────────────
  totalFindingsCard() {
    return this.page.getByText('Total Findings');
  }

  criticalOpenCard() {
    return this.page.getByText('Critical Open');
  }

  remediatedCard() {
    return this.page.getByText('Remediated (24h)');
  }

  openFindingsCard() {
    return this.page.getByText('Open Findings');
  }

  findingsByDataTypeChart() {
    return this.page.getByText('Findings by Data Type');
  }

  riskDistributionChart() {
    return this.page.getByText('Risk Distribution');
  }

  // ── Sensitive Data Findings tab ───────────────────────────────────────────
  findingsSearchInput() {
    return this.page.getByPlaceholder('Search file paths...');
  }

  dataTypeFilterSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option', { hasText: 'All Types' }) });
  }

  riskFilterSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option', { hasText: 'All Risks' }) });
  }

  findingsStatusFilterSelect() {
    return this.page.locator('select').filter({ has: this.page.locator('option', { hasText: 'All Statuses' }) });
  }

  findingsTableHead() {
    return this.page.getByRole('table').locator('thead');
  }

  // ── Sensitive Data Scans tab ──────────────────────────────────────────────
  scansHeading() {
    return this.page.getByRole('heading', { name: 'Scans' });
  }

  refreshButton() {
    return this.page.getByRole('button', { name: 'Refresh' });
  }

  newScanButton() {
    return this.page.getByRole('button', { name: 'New Scan' });
  }

  scansTableHead() {
    return this.page.getByRole('table').locator('thead');
  }
}
