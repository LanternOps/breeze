import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { ReportsPage } from '../pages/ReportsPage';

/**
 * Multi-org report series (W03), end to end on a real stack:
 * create "One report per organization" (All organizations) from /reports/new →
 * the saved list opens the new series' drill-down → exclude one organization →
 * its line reads Excluded → delete the series (cleanup, and the delete path).
 *
 * Login: E2E_ADMIN_EMAIL, a partner-scope Partner Admin with org_access 'all'
 * — the authority a series owner needs (spec §3.4).
 */
test.beforeEach(clearRefreshState);

test.describe('Multi-org report series', () => {
  test('create, drill down, exclude an organization, delete', async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    const reports = new ReportsPage(page);
    await reports.useAllOrganizationsView();
    const name = `E2E series ${Date.now()}`;

    await test.step('fill the series form', async () => {
      await reports.gotoNewReport();
      await expect(reports.orgSwitcherTrigger()).not.toHaveAttribute('data-scope', 'org');
      await reports.coversModeSeries().click();
      await expect(reports.seriesTargetModeAll()).toBeChecked();
      await reports.builderName().fill(name);
      // W02 makes a new child due immediately (its "Decisions" list), so the
      // worker's next tick could mail this series before the spec deletes it.
      // With the rule off and no internal CC it resolves to nobody: every run
      // records no_recipients and nothing is sent, even on a stack wired to a
      // live mail key. It also keeps the create outside W02's export+MFA
      // delivery gate (its contract concern 4b).
      await reports.seriesRulePrimary().uncheck();
      // The debounced preview resolves against the real reconciler inputs.
      await expect(reports.seriesRecipientPreview()).toHaveAttribute('data-state', /ready|failed/, { timeout: 15_000 });
    });

    const createResponse = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/api/v1/reports/series'),
    );
    await reports.builderSubmit().click();
    const created = await createResponse;
    expect(created.status(), await created.text()).toBe(201);
    const detail = (await created.json()) as { series: { id: string }; orgs: { orgId: string; state: string; childReportId: string | null }[] };
    const seriesId = detail.series.id;
    // Any covered org with a child. With the rule off and a seed without
    // contacts, children are 'blocked_no_recipients' rather than 'active' —
    // still a real copy the drill-down can exclude.
    const COVERED = new Set(['active', 'blocked_no_recipients', 'blocked_no_authority']);
    const target = detail.orgs.find((o) => o.childReportId && COVERED.has(o.state));
    expect(target, `the reconciler created at least one child: ${JSON.stringify(detail.orgs)}`).toBeTruthy();

    await test.step('the list lands on the new series, expanded', async () => {
      await page.waitForURL(`**/reports#series/${seriesId}`);
      await expect(reports.seriesRow(seriesId)).toBeVisible({ timeout: 15_000 });
      await expect(reports.seriesDrilldown(seriesId)).toBeVisible();
      await expect(reports.seriesOrgRow(target!.orgId)).toHaveAttribute('data-state', target!.state);
    });

    await test.step('exclude one organization', async () => {
      const putResponse = page.waitForResponse(
        (res) => res.request().method() === 'PUT' && new URL(res.url()).pathname.endsWith(`/reports/series/${seriesId}/targets`),
      );
      await reports.seriesOrgExclude(target!.orgId).click();
      await reports.confirmExclude().click();
      const put = await putResponse;
      expect(put.status(), await put.text()).toBe(200);
      await expect(reports.seriesOrgRow(target!.orgId)).toHaveAttribute('data-state', 'excluded', { timeout: 15_000 });
    });

    await test.step('delete the series', async () => {
      const deleteResponse = page.waitForResponse(
        (res) => res.request().method() === 'DELETE' && new URL(res.url()).pathname.endsWith(`/reports/series/${seriesId}`),
      );
      await reports.seriesDelete(seriesId).click();
      await reports.confirmDelete().click();
      const deleted = await deleteResponse;
      expect(deleted.ok(), await deleted.text()).toBeTruthy();
      await expect(reports.seriesRow(seriesId)).toHaveCount(0, { timeout: 15_000 });
    });
  });
});
