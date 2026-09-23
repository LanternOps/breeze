import type { APIRequestContext, Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { ReportsPage } from '../pages/ReportsPage';

/**
 * Business reports (#3198 W03) — a partner-owned AR aging report, end to end:
 * template gallery → shared options modal (partner ownership) → list row with
 * the all-organizations badge → generate (async, BullMQ worker) → the run
 * completes → download.
 *
 * The login is E2E_ADMIN_EMAIL: a partner-scope Partner Admin with org_access
 * 'all', which is exactly the authority a partner-owned report requires.
 *
 * Partner-owned reports are listed only on the All organizations view (the
 * list's `GET /reports` carries the focused org's `?orgId=`), and the org
 * switcher offers All organizations only when the partner has more than one
 * org. The spec therefore guarantees a second org exists before it starts.
 */
test.beforeEach(clearRefreshState);

/** Recover the access token the app itself is using (see organization-record.spec.ts). */
async function readAccessToken(page: Page): Promise<string> {
  let token: string | null = null;
  const onRequest = (req: Request) => {
    if (token) return;
    const header = req.headers()['authorization'];
    if (header?.startsWith('Bearer ') && req.url().includes('/api/v1/')) token = header.slice(7);
  };
  page.on('request', onRequest);
  try {
    await page.goto('/');
    await expect.poll(() => token, {
      message: 'an authenticated /api/v1 request from the app',
      timeout: 30_000,
    }).toBeTruthy();
  } finally {
    page.off('request', onRequest);
  }
  return token!;
}

async function apiJson<T>(
  request: APIRequestContext, token: string, method: 'get' | 'post',
  path: string, data?: unknown,
): Promise<T> {
  const res = await request[method](path, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method.toUpperCase()} ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

type OrgList = { data?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>;

/** The partner's org ids, creating a second org when there is only one. */
async function ensureTwoOrgs(page: Page, token: string, stamp: string): Promise<string[]> {
  const list = await apiJson<OrgList>(page.request, token, 'get', '/api/v1/orgs/organizations?limit=100');
  const orgs = Array.isArray(list) ? list : list.data ?? [];
  if (orgs.length >= 2) return orgs.map((o) => o.id);
  const created = await apiJson<{ id: string }>(
    page.request, token, 'post', '/api/v1/orgs/organizations',
    { name: `E2E Reports Org ${stamp}`, slug: `e2e-reports-org-${stamp}` },
  );
  return [...orgs.map((o) => o.id), created.id];
}

test.describe('Business reports — partner-owned AR aging', () => {
  test('create from the Business template, generate, and download the run', async ({ authedPage: page }, testInfo) => {
    test.setTimeout(180_000);
    const reports = new ReportsPage(page);
    const token = await readAccessToken(page);
    await ensureTwoOrgs(page, token, `${Date.now()}-${testInfo.retry}`);

    // Fleet view — the only view that lists partner-owned reports.
    await reports.gotoList();
    await reports.selectAllOrganizations();

    await test.step('create a partner-owned AR aging report from the Business template', async () => {
      await reports.gotoTemplates();
      await expect(reports.businessGroup()).toBeVisible();
      await expect(reports.templateCard('ar_aging')).toBeVisible();

      // The shared business options modal opens — not the freeform builder.
      await reports.useTemplate('ar_aging').click();
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

  test('with an organization focused, the list points at the All organizations view', async ({ authedPage: page }) => {
    const reports = new ReportsPage(page);
    const token = await readAccessToken(page);
    const list = await apiJson<OrgList>(page.request, token, 'get', '/api/v1/orgs/organizations?limit=100');
    const orgs = Array.isArray(list) ? list : list.data ?? [];
    expect(orgs.length).toBeGreaterThan(0);

    await reports.gotoList();
    // With one org it is auto-focused; with several, focus the first explicitly.
    if (orgs.length > 1) await reports.selectOrganization(orgs[0].id);
    await expect(reports.partnerWideHint()).toBeVisible({ timeout: 15_000 });
  });
});
