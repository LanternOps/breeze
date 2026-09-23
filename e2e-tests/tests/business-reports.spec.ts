import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { ReportsPage } from '../pages/ReportsPage';

/**
 * Business reports (#3198 W03) — a partner-owned AR aging report, end to end:
 * template gallery → shared options modal (partner ownership) → list row with
 * the all-organizations badge → generate → the run completes → download.
 *
 * The login is E2E_ADMIN_EMAIL: a partner-scope Partner Admin with org_access
 * 'all', which is exactly the authority a partner-owned report requires.
 *
 * The spec runs from the default view, where an organization is focused (the
 * web auto-focuses the first org, and a single-org partner has no All
 * organizations option at all). A partner-owned report covers that org too,
 * so the list must show it there — the regression this spec pins.
 */
test.beforeEach(clearRefreshState);

test.describe('Business reports — partner-owned AR aging', () => {
  test('create from the Business template, generate, and download the run', async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    const reports = new ReportsPage(page);
    // An organization is focused — not the All organizations view.
    await reports.gotoList();
    await expect(reports.orgSwitcherTrigger()).toHaveAttribute('data-scope', 'org');

    await test.step('create a partner-owned AR aging report from the Business template', async () => {
      await reports.gotoTemplates();
      await expect(reports.businessGroup()).toBeVisible();
      await expect(reports.businessCardOfType('ar_aging')).toBeVisible();

      // The shared business options modal opens — not the freeform builder.
      await reports.useBusinessTemplateOfType('ar_aging').click();
      await expect(reports.optionsModal()).toBeVisible();
      await expect(reports.arAgingCreate()).toBeVisible();

      // A partner-scope login is offered the ownership choice; assert it rather
      // than skipping past it (its absence means the login is org-scoped).
      await expect(reports.ownerScope()).toBeVisible();
      await reports.ownerScopePartner().check();
      await reports.arAgingGroupBy().selectOption('currency');
    });

    // The modal has no name field, so the new row is identified by the id the
    // create response returns — never by position in a list that other runs
    // have already populated.
    const createResponse = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/api/v1/reports'),
    );
    await reports.arAgingCreate().click();
    const created = await createResponse;
    expect(created.status(), await created.text()).toBe(201);
    const body = (await created.json()) as { id?: string; data?: { id?: string } };
    const reportId = body.data?.id ?? body.id;
    expect(reportId, 'POST /reports returned an id').toBeTruthy();

    await page.waitForURL('**/reports');

    await test.step('the row carries the all-organizations scope badge', async () => {
      await expect(reports.reportRow(reportId!)).toBeVisible({ timeout: 15_000 });
      await expect(reports.scopeBadge(reportId!)).toBeVisible();
      await expect(reports.scopeBadge(reportId!).getByTestId('scope-badge')).toBeVisible();
    });

    // Generate. A partner-owned generate exercises the W01 path end to end:
    // partner authority, the live organization fan-out, and the partner branch
    // of the report_runs RLS policy.
    const generateResponse = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith(`/reports/${reportId}/generate`),
    );
    await reports.generate(reportId!).click();
    const generated = await generateResponse;
    expect(generated.ok(), `generate → ${generated.status()} ${await generated.text()}`).toBeTruthy();
    const genBody = (await generated.json()) as { runId?: string; id?: string; data?: { runId?: string; id?: string } };
    const runId = genBody.runId ?? genBody.data?.runId ?? genBody.data?.id ?? genBody.id;
    expect(runId, `generate response carries the run id: ${JSON.stringify(genBody)}`).toBeTruthy();

    await test.step('the run completes (async worker) — polled by reloading the runs tab', async () => {
      await expect(async () => {
        await reports.gotoList();
        await reports.runsTab().click();
        await expect(reports.runStatus(runId!)).toHaveAttribute('data-status', 'completed', { timeout: 3_000 });
      }).toPass({ timeout: 90_000, intervals: [2_000, 3_000, 5_000] });
      await expect(reports.runRow(runId!)).toBeVisible();
    });

    await test.step('download: the stored snapshot is fetched and rendered to a PDF', async () => {
      const downloadResponse = page.waitForResponse(
        (res) => new URL(res.url()).pathname.endsWith(`/reports/runs/${runId}/download`),
      );
      const downloadEvent = page.waitForEvent('download', { timeout: 30_000 });
      await reports.runDownload(runId!).click();
      const res = await downloadResponse;
      expect(res.status(), await res.text()).toBe(200);
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    });
  });
});
