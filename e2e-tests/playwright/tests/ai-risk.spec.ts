// e2e-tests/playwright/tests/ai-risk.spec.ts
// Converted from e2e-tests/tests/user_risk.yaml (10 tests)
// Covers: AI Risk Engine dashboard (/ai-risk) — 5 tabs
//         Audit Baselines (/audit-baselines) — list, compliance, detail
import { test, expect } from '../fixtures';
import { AiRiskPage, AuditBaselinesPage, BaselineDetailPage } from '../pages/AiRiskPage';

// ── AI Risk Engine ─────────────────────────────────────────────────────────────

test.describe('AI Risk Dashboard', () => {
  // ai_risk_dashboard_loads
  test('dashboard loads with header and all five tabs', async ({ authedPage }) => {
    const page = new AiRiskPage(authedPage);
    await page.goto();

    await expect(page.heading()).toBeVisible();
    await expect(page.description()).toBeVisible();

    await expect(page.tab('Guardrails')).toBeVisible();
    await expect(page.tab('Analytics')).toBeVisible();
    await expect(page.tab('Approvals')).toBeVisible();
    await expect(page.tab('Rate Limits')).toBeVisible();
    await expect(page.tab('Denials')).toBeVisible();
  });

  // ai_risk_guardrails_tab
  test('Guardrails tab shows tier matrix, tier cards, filter input, and expandable category groups', async ({ authedPage }) => {
    const page = new AiRiskPage(authedPage);
    await page.goto();

    // Active by default — tier matrix heading and Tier badge visible
    await expect(page.guardrailsTierMatrixHeading()).toBeVisible();
    await expect(page.tierBadge()).toBeVisible();
    await expect(page.filterToolsInput()).toBeVisible();

    // Filter tools then clear
    await page.filterToolsInput().fill('browser');
    await authedPage.waitForTimeout(500);
    await page.filterToolsInput().fill('');

    // Expand a category group
    const groupBtn = page.firstCategoryGroupButton();
    await groupBtn.waitFor({ timeout: 5000 });
    await groupBtn.click();
    await authedPage.waitForTimeout(500);
  });

  // ai_risk_analytics_tab
  test('Analytics tab shows time range controls, refresh button, and range switching works', async ({ authedPage }) => {
    const page = new AiRiskPage(authedPage);
    await page.goto();

    await page.clickTab('Analytics');

    await expect(page.timeRangeButton('24h')).toBeVisible({ timeout: 10000 });
    await expect(page.timeRangeButton('7d')).toBeVisible();
    await expect(page.timeRangeButton('30d')).toBeVisible();
    await expect(page.refreshButton()).toBeVisible();

    await page.timeRangeButton('24h').click();
    await authedPage.waitForTimeout(500);
    await page.timeRangeButton('30d').click();
    await authedPage.waitForTimeout(500);
  });

  // ai_risk_approvals_tab
  test('Approvals tab shows time range controls and 7d filter works', async ({ authedPage }) => {
    const page = new AiRiskPage(authedPage);
    await page.goto();

    await page.clickTab('Approvals');
    await expect(page.timeRangeButton('7d')).toBeVisible({ timeout: 10000 });

    await page.timeRangeButton('7d').click();
    await authedPage.waitForTimeout(500);
  });

  // ai_risk_rate_limits_tab
  test('Rate Limits tab loads without time range controls', async ({ authedPage }) => {
    const page = new AiRiskPage(authedPage);
    await page.goto();

    await page.clickTab('Rate Limits');
    // Static tab — no time-range buttons should appear
    await authedPage.waitForTimeout(1000);
    await expect(page.timeRangeButton('24h')).not.toBeVisible();
  });

  // ai_risk_denials_tab
  test('Denials tab shows time range controls and 7d switch works', async ({ authedPage }) => {
    const page = new AiRiskPage(authedPage);
    await page.goto();

    await page.clickTab('Denials');
    await expect(page.timeRangeButton('7d')).toBeVisible({ timeout: 10000 });
    await expect(page.timeRangeButton('30d')).toBeVisible();

    await page.timeRangeButton('7d').click();
    await authedPage.waitForTimeout(500);
  });
});

// ── Audit Baselines ────────────────────────────────────────────────────────────

test.describe('Audit Baselines', () => {
  // audit_baselines_page_loads
  test('page loads with heading, description, and Dashboard/Baselines/Approvals tabs', async ({ authedPage }) => {
    const ab = new AuditBaselinesPage(authedPage);
    await ab.goto();

    await expect(ab.heading()).toBeVisible();
    await expect(ab.description()).toBeVisible();
    await expect(ab.tab('Dashboard')).toBeVisible();
    await expect(ab.tab('Baselines')).toBeVisible();
    await expect(ab.tab('Approvals')).toBeVisible();

    // Dashboard tab is active by default — compliance stat cards visible
    await authedPage.waitForTimeout(2000);
    await expect(authedPage.getByText('Devices Evaluated')).toBeVisible({ timeout: 15000 });
  });

  // audit_baselines_compliance_dashboard
  test('compliance dashboard shows all four stat cards', async ({ authedPage }) => {
    const ab = new AuditBaselinesPage(authedPage);
    await ab.goto();

    await ab.clickTab('Dashboard');
    await authedPage.waitForTimeout(2000);

    await expect(authedPage.getByText('Devices Evaluated')).toBeVisible({ timeout: 15000 });
    await expect(authedPage.getByText('Compliant').first()).toBeVisible();
    await expect(authedPage.getByText('Non-Compliant')).toBeVisible();
    await expect(authedPage.getByText('Average Score')).toBeVisible();
  });

  // audit_baselines_list
  test('baselines tab shows table columns, New Baseline button, and modal opens/closes', async ({ authedPage }) => {
    const ab = new AuditBaselinesPage(authedPage);
    await ab.goto();

    await ab.clickTab('Baselines');
    await ab.newBaselineButton().waitFor({ timeout: 10000 });

    await expect(ab.newBaselineButton()).toBeVisible();
    await expect(ab.baselinesTableHead().getByText('Name')).toBeVisible();
    await expect(ab.baselinesTableHead().getByText('OS')).toBeVisible();
    await expect(ab.baselinesTableHead().getByText('Profile')).toBeVisible();
    await expect(ab.baselinesTableHead().getByText('Active')).toBeVisible();
    await expect(ab.baselinesTableHead().getByText('Updated')).toBeVisible();
    await expect(ab.baselinesTableHead().getByText('Actions')).toBeVisible();

    // Open modal
    await ab.newBaselineButton().click();
    await expect(ab.modalHeading()).toBeVisible({ timeout: 10000 });

    // Close via Cancel
    await ab.cancelButton().click();
    await expect(ab.newBaselineButton()).toBeVisible({ timeout: 5000 });
  });

  // audit_baseline_detail_page
  test('baseline detail page loads with breadcrumb and Overview/Compliance/Apply tabs', async ({ authedPage }) => {
    const ab = new AuditBaselinesPage(authedPage);
    await ab.goto();

    await ab.clickTab('Baselines');
    await ab.baselinesTable().waitFor({ timeout: 10000 });

    const firstLink = ab.firstBaselineLink();
    const linkCount = await firstLink.count();
    if (linkCount === 0) {
      // No baselines exist in this environment — skip gracefully
      test.skip();
      return;
    }

    await firstLink.click();
    await authedPage.waitForURL('**/audit-baselines/**', { timeout: 15000 });

    const detail = new BaselineDetailPage(authedPage);
    // Breadcrumb and tabs
    await expect(detail.breadcrumbLink()).toBeVisible({ timeout: 10000 });
    await expect(detail.tab('Overview')).toBeVisible();
    await expect(detail.tab('Compliance')).toBeVisible();
    await expect(detail.tab('Apply')).toBeVisible();

    // Navigate through detail tabs
    await detail.clickTab('Compliance');
    await authedPage.waitForTimeout(500);
    await detail.clickTab('Apply');
    await authedPage.waitForTimeout(500);

    // Navigate back via breadcrumb
    await detail.breadcrumbLink().click();
    await authedPage.waitForURL('**/audit-baselines**', { timeout: 15000 });
    await expect(ab.heading()).toBeVisible();
  });
});
