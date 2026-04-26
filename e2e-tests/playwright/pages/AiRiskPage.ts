// e2e-tests/playwright/pages/AiRiskPage.ts
// Covers AiRiskDashboard.tsx on /ai-risk and AuditBaselinesPage.tsx on /audit-baselines
import { BasePage } from './BasePage';

export class AiRiskPage extends BasePage {
  readonly url = '/ai-risk';

  // ── Page header ────────────────────────────────────────────────────────

  heading() {
    return this.page.getByRole('heading', { name: 'AI Risk Engine' });
  }

  description() {
    return this.page.getByText('Tool execution guardrails, approval history, and analytics');
  }

  // ── Tab nav (rendered as buttons inside a <nav aria-label="Tabs">) ────

  tab(name: 'Guardrails' | 'Analytics' | 'Approvals' | 'Rate Limits' | 'Denials') {
    return this.page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name });
  }

  async clickTab(name: 'Guardrails' | 'Analytics' | 'Approvals' | 'Rate Limits' | 'Denials') {
    await this.tab(name).click();
  }

  // ── Time-range controls (only on data-driven tabs) ────────────────────

  timeRangeButton(range: '24h' | '7d' | '30d') {
    return this.page.getByRole('button', { name: range, exact: true });
  }

  refreshButton() {
    return this.page.getByRole('button', { name: 'Refresh' });
  }

  // ── Guardrails tab ────────────────────────────────────────────────────

  guardrailsTierMatrixHeading() {
    return this.page.getByRole('heading', { name: 'Guardrail Tier Matrix' });
  }

  filterToolsInput() {
    return this.page.getByPlaceholder('Filter tools...');
  }

  // A "Tier N" badge is a span inside a tier card
  tierBadge() {
    return this.page.getByText(/^Tier \d/, { exact: false }).first();
  }

  // Category group toggle button (has chevron icon + category label text)
  firstCategoryGroupButton() {
    return this.page.locator('div.border-b button').first();
  }

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor({ timeout: 15000 });
  }
}

export class AuditBaselinesPage extends BasePage {
  readonly url = '/audit-baselines';

  // ── Page header ────────────────────────────────────────────────────────

  heading() {
    return this.page.getByRole('heading', { name: 'Audit Baselines' });
  }

  description() {
    return this.page.getByText('Define compliance baselines, evaluate device drift');
  }

  // ── Tabs (rendered as plain buttons, not inside a <nav>) ─────────────

  tab(name: 'Dashboard' | 'Baselines' | 'Approvals') {
    return this.page.getByRole('button', { name, exact: true });
  }

  async clickTab(name: 'Dashboard' | 'Baselines' | 'Approvals') {
    await this.tab(name).click();
  }

  // ── Compliance Dashboard tab ──────────────────────────────────────────

  statCard(label: string) {
    return this.page.getByText(label, { exact: true });
  }

  // ── Baselines tab ─────────────────────────────────────────────────────

  newBaselineButton() {
    return this.page.getByRole('button', { name: 'New Baseline' });
  }

  baselinesTable() {
    return this.page.locator('table');
  }

  baselinesTableHead() {
    return this.page.locator('table thead');
  }

  firstBaselineLink() {
    return this.page.locator('table tbody tr:first-child td:first-child a');
  }

  // ── BaselineFormModal ─────────────────────────────────────────────────

  modalHeading() {
    // h2 inside the modal
    return this.page.getByRole('heading', { name: /Baseline/ });
  }

  cancelButton() {
    return this.page.getByRole('button', { name: 'Cancel' });
  }

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor({ timeout: 15000 });
  }
}

export class BaselineDetailPage extends BasePage {
  // ── Breadcrumb ────────────────────────────────────────────────────────

  breadcrumbLink() {
    return this.page.getByRole('link', { name: 'Audit Baselines' });
  }

  // ── Tabs ──────────────────────────────────────────────────────────────

  tab(name: 'Overview' | 'Compliance' | 'Apply') {
    return this.page.getByRole('button', { name, exact: true });
  }

  async clickTab(name: 'Overview' | 'Compliance' | 'Apply') {
    await this.tab(name).click();
  }
}
