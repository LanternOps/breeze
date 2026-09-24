/**
 * Partner-owned report definitions through the REAL report routes and the
 * REAL schedule worker (#3198 W01, Task 7).
 *
 * `reportsPartnerRls.integration.test.ts` proves the database layer (RLS, the
 * XOR CHECK, the execution-scope CHECK). This suite proves the application
 * layer on top of it: a Hono app with the production `authMiddleware` and
 * `reportRoutes`, driven with real access tokens against real Postgres (as the
 * forced-RLS `breeze_app` role), plus `findDueReports` /
 * `processRunScheduledReport` under the system context the worker runs in.
 *
 * `generateReport` is wrapped in a spy (the real implementation still runs) so
 * the generate routes and the worker can be shown to reach the partner-scope
 * generator with the live partner org list (#3198 W02 removed W01's refusals),
 * and to be refused BEFORE it when the caller or the execution user lacks the
 * type's underlying read permission (ruling P8).
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/reportGenerationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/reportGenerationService')>();
  return { ...actual, generateReport: vi.fn(actual.generateReport) };
});

import { withSystemDbAccessContext } from '../../db';
import {
  partners,
  partnerUsers,
  permissions,
  reportRuns,
  reportScheduleRecipients,
  reports,
  rolePermissions,
  users,
} from '../../db/schema';
import { findDueReports, processRunScheduledReport } from '../../jobs/reportScheduleWorker';
import { reportRoutes } from '../../routes/reports';
import { authMiddleware } from '../../middleware/auth';
import { createAccessToken } from '../../services/jwt';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { resolveLivePartnerReportAuthority, siteScopeFingerprint } from '../../services/siteScope';
import { generateReport } from '../../services/reportGenerationService';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const REPORT_PERMISSIONS = [
  { resource: 'reports', action: 'read' },
  { resource: 'reports', action: 'write' },
  { resource: 'reports', action: 'delete' },
  { resource: 'reports', action: 'export' },
];
/** ar_aging's registry requiredPermissions (#3198 W02, ruling P8). */
const AR_PERMISSIONS = [{ resource: 'invoices', action: 'read' }];

const generateReportSpy = vi.mocked(generateReport);

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/reports', reportRoutes);
  return app;
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

function uniqueEmail(label: string): string {
  return `reports-partner-owned-${label}-${randomUUID()}@example.com`;
}

async function partnerToken(user: { id: string; email: string }, roleId: string, partnerId: string) {
  return createAccessToken({
    sub: user.id,
    email: user.email,
    roleId,
    orgId: null,
    partnerId,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
}

/**
 * One partner P with two orgs, and three users of P:
 *  - `admin`: partner scope, org_access='all', reports:read|write|delete|export
 *  - `selected`: partner scope, org_access='selected' (orgA only), same perms
 *  - `orgUser`: organization scope in orgA, same perms
 */
async function seedFixture() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });

  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, [...REPORT_PERMISSIONS, ...AR_PERMISSIONS]);

  // A full-access (org_access='all') partner user whose role holds every
  // reports:* grant but NOT invoices:read (ruling P8).
  const reportsOnlyRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(reportsOnlyRole.id, REPORT_PERMISSIONS);
  const reportsOnly = await createUser({ partnerId: partner.id, orgId: null, email: uniqueEmail('reports-only') });
  await assignUserToPartner(reportsOnly.id, partner.id, reportsOnlyRole.id, 'all');

  const admin = await createUser({ partnerId: partner.id, orgId: null, email: uniqueEmail('admin') });
  await assignUserToPartner(admin.id, partner.id, partnerRole.id, 'all');

  const selected = await createUser({ partnerId: partner.id, orgId: null, email: uniqueEmail('selected') });
  await assignUserToPartner(selected.id, partner.id, partnerRole.id, 'selected');
  await getTestDb()
    .update(partnerUsers)
    .set({ orgIds: [orgA.id] })
    .where(eq(partnerUsers.userId, selected.id));

  const orgRole = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id });
  await grantRolePermissions(orgRole.id, REPORT_PERMISSIONS);
  const orgUser = await createUser({ partnerId: partner.id, orgId: orgA.id, email: uniqueEmail('org') });
  await assignUserToOrganization(orgUser.id, orgA.id, orgRole.id);

  const orgToken = await createAccessToken({
    sub: orgUser.id,
    email: orgUser.email,
    roleId: orgRole.id,
    orgId: orgA.id,
    partnerId: partner.id,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });

  return {
    partner,
    partnerRole,
    orgRole,
    orgA,
    orgB,
    admin,
    selected,
    orgUser,
    reportsOnlyToken: await partnerToken(reportsOnly, reportsOnlyRole.id, partner.id),
    adminToken: await partnerToken(admin, partnerRole.id, partner.id),
    selectedToken: await partnerToken(selected, partnerRole.id, partner.id),
    orgToken,
  };
}

async function call(
  app: Hono,
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Creates a partner-owned monthly ar_aging definition through POST /reports as the admin. */
async function createPartnerDefinition(app: Hono, fixture: Fixture, name = 'Partner AR aging') {
  const res = await call(app, fixture.adminToken, 'POST', '/reports', {
    ownerScope: 'partner',
    name,
    type: 'ar_aging',
    schedule: 'monthly',
    format: 'csv',
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; partnerId: string | null; orgId: string | null };
  return body;
}

async function readDefinition(id: string) {
  const [row] = await getTestDb()
    .select({
      id: reports.id,
      orgId: reports.orgId,
      partnerId: reports.partnerId,
      name: reports.name,
      type: reports.type,
      schedule: reports.schedule,
      createdBy: reports.createdBy,
      executionScopeKind: reports.executionScopeKind,
      executionScopePrincipalKind: reports.executionScopePrincipalKind,
      executionScopeUserId: reports.executionScopeUserId,
      executionScopeSiteIds: reports.executionScopeSiteIds,
      lastGeneratedAt: reports.lastGeneratedAt,
    })
    .from(reports)
    .where(eq(reports.id, id));
  return row;
}

async function runsFor(reportId: string) {
  return getTestDb()
    .select({
      id: reportRuns.id,
      status: reportRuns.status,
      errorMessage: reportRuns.errorMessage,
      requestedByKind: reportRuns.requestedByKind,
      requestedByUserId: reportRuns.requestedByUserId,
      executionScopeKind: reportRuns.executionScopeKind,
      executionScopeUserId: reportRuns.executionScopeUserId,
    })
    .from(reportRuns)
    .where(eq(reportRuns.reportId, reportId));
}

describe('partner-owned report definitions through the real routes (#3198 W01/W02)', () => {
  beforeEach(() => {
    generateReportSpy.mockClear();
  });

  runDb('partner admin (org_access=all) creates a partner-owned ar_aging definition, lists it, gets it, and an org user of the same partner gets 404', async () => {
    const fixture = await seedFixture();
    const app = buildApp();

    const created = await createPartnerDefinition(app, fixture);
    expect(created).toMatchObject({
      partnerId: fixture.partner.id,
      orgId: null,
      name: 'Partner AR aging',
      type: 'ar_aging',
      schedule: 'monthly',
      executionScopeKind: 'partner_wide',
      executionScopePrincipalKind: 'user',
      executionScopeUserId: fixture.admin.id,
    });

    // The stored row, read back as superuser: owned by the partner (never an
    // org), created by the admin, with a complete partner_wide envelope.
    expect(await readDefinition(created.id)).toEqual({
      id: created.id,
      orgId: null,
      partnerId: fixture.partner.id,
      name: 'Partner AR aging',
      type: 'ar_aging',
      schedule: 'monthly',
      createdBy: fixture.admin.id,
      executionScopeKind: 'partner_wide',
      executionScopePrincipalKind: 'user',
      executionScopeUserId: fixture.admin.id,
      executionScopeSiteIds: null,
      lastGeneratedAt: null,
    });

    // #3198 W02 (ruling T4c): a client-supplied orgId on the partner branch is
    // a 400 (the partner arm declares `orgId: z.never()`), never an owner...
    const rejectedOrg = await call(app, fixture.adminToken, 'POST', '/reports', {
      ownerScope: 'partner',
      orgId: fixture.orgA.id,
      name: 'Still partner-owned',
      type: 'ar_aging',
    });
    expect(rejectedOrg.status).toBe(400);
    // ...and the same body without it is an ordinary partner-owned create.
    const withOrg = await call(app, fixture.adminToken, 'POST', '/reports', {
      ownerScope: 'partner',
      name: 'Still partner-owned',
      type: 'ar_aging',
    });
    expect(withOrg.status).toBe(201);
    const withOrgBody = (await withOrg.json()) as { id: string; orgId: string | null; partnerId: string | null };
    expect(withOrgBody).toMatchObject({ orgId: null, partnerId: fixture.partner.id });

    const list = await call(app, fixture.adminToken, 'GET', '/reports?limit=100');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: Array<{ id: string; partnerId: string | null }> };
    expect(listBody.data.map((r) => r.id)).toEqual(expect.arrayContaining([created.id, withOrgBody.id]));
    expect(listBody.data.find((r) => r.id === created.id)?.partnerId).toBe(fixture.partner.id);

    const got = await call(app, fixture.adminToken, 'GET', `/reports/${created.id}`);
    expect(got.status).toBe(200);
    const gotBody = (await got.json()) as Record<string, unknown>;
    expect(gotBody).toMatchObject({
      id: created.id,
      partnerId: fixture.partner.id,
      orgId: null,
      type: 'ar_aging',
      recentRuns: [],
    });
    // The internal owner discriminator is not leaked into the response.
    expect(gotBody).not.toHaveProperty('owner');

    // An ORG token of the same partner (it carries partnerId) must not see it.
    const orgGet = await call(app, fixture.orgToken, 'GET', `/reports/${created.id}`);
    expect(orgGet.status).toBe(404);
    expect(await orgGet.json()).toEqual({ error: 'Report not found' });

    const orgList = await call(app, fixture.orgToken, 'GET', '/reports?limit=100');
    expect(orgList.status).toBe(200);
    const orgListBody = (await orgList.json()) as { data: Array<{ id: string }> };
    expect(orgListBody.data.map((r) => r.id)).not.toContain(created.id);
    expect(orgListBody.data.map((r) => r.id)).not.toContain(withOrgBody.id);

    // Nor can the org user create one.
    const orgCreate = await call(app, fixture.orgToken, 'POST', '/reports', {
      ownerScope: 'partner',
      name: 'org forging partner ownership',
      type: 'ar_aging',
    });
    expect(orgCreate.status).toBe(403);
    expect(await orgCreate.json()).toEqual({ error: 'partner_scope_required' });

    // Partner-owned list contents under system context: exactly the two above.
    const owned = await getTestDb()
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.partnerId, fixture.partner.id));
    expect(owned.map((r) => r.id).sort()).toEqual([created.id, withOrgBody.id].sort());
  });

  runDb('partner user with org_access=selected gets 403 on create and 404 on get/put/delete of an existing partner-owned definition', async () => {
    const fixture = await seedFixture();
    const app = buildApp();
    const created = await createPartnerDefinition(app, fixture);

    const create = await call(app, fixture.selectedToken, 'POST', '/reports', {
      ownerScope: 'partner',
      name: 'selected user partner report',
      type: 'ar_aging',
    });
    expect(create.status).toBe(403);
    expect(await create.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });

    // The tenant condition hides partner-owned rows from a 'selected' caller,
    // so every by-id operation is an ordinary 404, not a disclosing 403.
    const get = await call(app, fixture.selectedToken, 'GET', `/reports/${created.id}`);
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: 'Report not found' });

    const put = await call(app, fixture.selectedToken, 'PUT', `/reports/${created.id}`, { name: 'renamed by selected' });
    expect(put.status).toBe(404);
    expect(await put.json()).toEqual({ error: 'Report not found' });

    const del = await call(app, fixture.selectedToken, 'DELETE', `/reports/${created.id}`);
    expect(del.status).toBe(404);
    expect(await del.json()).toEqual({ error: 'Report not found' });

    const list = await call(app, fixture.selectedToken, 'GET', '/reports?limit=100');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.map((r) => r.id)).not.toContain(created.id);

    // Nothing changed: same name, row still present, and no partner-owned row
    // was created for the selected user.
    const after = await readDefinition(created.id);
    expect(after?.name).toBe('Partner AR aging');
    const owned = await getTestDb()
      .select({ id: reports.id, createdBy: reports.createdBy })
      .from(reports)
      .where(eq(reports.partnerId, fixture.partner.id));
    expect(owned).toEqual([{ id: created.id, createdBy: fixture.admin.id }]);

    // Positive control: the admin CAN mutate the same row through the same routes.
    const adminPut = await call(app, fixture.adminToken, 'PUT', `/reports/${created.id}`, { name: 'Renamed by admin' });
    expect(adminPut.status).toBe(200);
    expect(await adminPut.json()).toMatchObject({ id: created.id, name: 'Renamed by admin', partnerId: fixture.partner.id });

    // ...but may not re-home it onto an org.
    const rehome = await call(app, fixture.adminToken, 'PUT', `/reports/${created.id}`, {
      name: 'rehome',
      orgId: fixture.orgA.id,
    });
    expect(rehome.status).toBe(400);
    expect(await rehome.json()).toEqual({ error: 'report_ownership_immutable' });
    expect(await readDefinition(created.id)).toMatchObject({
      name: 'Renamed by admin',
      orgId: null,
      partnerId: fixture.partner.id,
    });

    const adminDelete = await call(app, fixture.adminToken, 'DELETE', `/reports/${created.id}`);
    expect(adminDelete.status).toBe(200);
    expect(await adminDelete.json()).toEqual({ success: true });
    expect(await readDefinition(created.id)).toBeUndefined();
  });

  runDb('GET /reports?ownerScope= narrows by owner axis and never widens (#3198 W03)', async () => {
    const fixture = await seedFixture();
    const app = buildApp();
    const partnerOwned = await createPartnerDefinition(app, fixture, 'Partner-owned for ownerScope filter');
    const orgRes = await call(app, fixture.adminToken, 'POST', '/reports', {
      ownerScope: 'organization',
      orgId: fixture.orgA.id,
      name: 'Org-owned for ownerScope filter',
      type: 'device_inventory',
    });
    expect(orgRes.status, await orgRes.clone().text()).toBe(201);
    const orgOwned = (await orgRes.json()) as { id: string };

    type ListBody = { data: Array<{ id: string; orgId: string | null; partnerId: string | null }>; pagination: { total: number } };
    const list = async (token: string, path: string) => {
      const res = await call(app, token, 'GET', path);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json()) as ListBody;
    };

    // All-access partner admin: partner → only the partner-owned row, and the
    // total counts the filtered set; organization → only org-owned rows.
    const adminPartner = await list(fixture.adminToken, '/reports?ownerScope=partner&limit=100');
    expect(adminPartner.data.map((r) => r.id)).toEqual([partnerOwned.id]);
    expect(adminPartner.pagination.total).toBe(1);
    expect(adminPartner.data[0]).toMatchObject({ orgId: null, partnerId: fixture.partner.id });
    const adminOrg = await list(fixture.adminToken, '/reports?ownerScope=organization&limit=100');
    expect(adminOrg.data.map((r) => r.id)).toEqual([orgOwned.id]);
    // Unfiltered listing: both (the filter is the only difference).
    const adminAll = await list(fixture.adminToken, '/reports?limit=100');
    expect(adminAll.data.map((r) => r.id).sort()).toEqual([partnerOwned.id, orgOwned.id].sort());
    // An explicit orgId excludes partner-owned rows, so partner + orgId is empty.
    const adminPartnerOrg = await list(fixture.adminToken, `/reports?ownerScope=partner&orgId=${fixture.orgA.id}&limit=100`);
    expect(adminPartnerOrg.data).toEqual([]);

    // 'selected' partner user and org token: partner → nothing, never widened.
    const selectedPartner = await list(fixture.selectedToken, '/reports?ownerScope=partner&limit=100');
    expect(selectedPartner).toMatchObject({ data: [], pagination: { total: 0 } });
    const orgPartner = await list(fixture.orgToken, '/reports?ownerScope=partner&limit=100');
    expect(orgPartner).toMatchObject({ data: [], pagination: { total: 0 } });
    // ...while their organization view still sees the org-owned row.
    const selectedOrg = await list(fixture.selectedToken, '/reports?ownerScope=organization&limit=100');
    expect(selectedOrg.data.map((r) => r.id)).toEqual([orgOwned.id]);
    const orgOrg = await list(fixture.orgToken, '/reports?ownerScope=organization&limit=100');
    expect(orgOrg.data.map((r) => r.id)).toEqual([orgOwned.id]);

    const bad = await call(app, fixture.adminToken, 'GET', '/reports?ownerScope=everyone');
    expect(bad.status).toBe(400);
  });

  runDb('a selected partner user cannot list, read or download partner-owned RUNS; an all admin can (#3198 W02, addendum B2)', async () => {
    // RLS admits a 'selected' partner user to every report_runs row of the
    // partner (breeze_has_partner_access is flat membership); the app-layer
    // run predicates are the only thing hiding partner-owned runs from them.
    const fixture = await seedFixture();
    const app = buildApp();
    const created = await createPartnerDefinition(app, fixture);
    const generated = await call(app, fixture.adminToken, 'POST', `/reports/${created.id}/generate`);
    expect(generated.status).toBe(200);
    const { runId } = (await generated.json()) as { runId: string };

    // An org-owned run in orgA (the selected user's one org) as the positive
    // control on the SAME token: the list is not simply empty.
    const orgDef = await call(app, fixture.adminToken, 'POST', '/reports', {
      name: 'orgA inventory', type: 'device_inventory', orgId: fixture.orgA.id,
    });
    expect(orgDef.status).toBe(201);
    const orgDefId = ((await orgDef.json()) as { id: string }).id;
    const orgGen = await call(app, fixture.adminToken, 'POST', `/reports/${orgDefId}/generate`);
    expect(orgGen.status, await orgGen.clone().text()).toBe(200);
    const orgRunId = ((await orgGen.json()) as { runId: string }).runId;

    const runIdsOf = async (res: Response) => ((await res.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);

    // --- 'selected': hidden everywhere, as an ordinary 404 ---
    const selectedList = await call(app, fixture.selectedToken, 'GET', '/reports/runs?limit=100');
    expect(selectedList.status).toBe(200);
    const selectedIds = await runIdsOf(selectedList);
    expect(selectedIds).not.toContain(runId);
    expect(selectedIds).toContain(orgRunId);

    const selectedFiltered = await call(app, fixture.selectedToken, 'GET', `/reports/runs?reportId=${created.id}&limit=100`);
    expect(selectedFiltered.status).toBe(200);
    expect(await runIdsOf(selectedFiltered)).toEqual([]);

    const selectedGet = await call(app, fixture.selectedToken, 'GET', `/reports/runs/${runId}`);
    expect(selectedGet.status).toBe(404);
    expect(await selectedGet.json()).toEqual({ error: 'Report run not found' });

    const selectedDownload = await call(app, fixture.selectedToken, 'GET', `/reports/runs/${runId}/download?format=json`);
    expect(selectedDownload.status).toBe(404);
    expect(await selectedDownload.json()).toEqual({ error: 'Report run not found' });

    // ...while their own org's run stays readable through the same routes.
    const selectedOrgGet = await call(app, fixture.selectedToken, 'GET', `/reports/runs/${orgRunId}`);
    expect(selectedOrgGet.status).toBe(200);

    // --- 'all' admin: the positive control on the partner-owned run ---
    const adminList = await call(app, fixture.adminToken, 'GET', `/reports/runs?reportId=${created.id}&limit=100`);
    expect(adminList.status).toBe(200);
    expect(await runIdsOf(adminList)).toEqual([runId]);

    const adminGet = await call(app, fixture.adminToken, 'GET', `/reports/runs/${runId}`);
    expect(adminGet.status).toBe(200);
    expect(await adminGet.json()).toMatchObject({ id: runId, reportId: created.id, status: 'completed' });

    // JSON snapshot: the partner AR run over empty fixture orgs has no tabular
    // rows (CSV would be a 409 after authorization), but it has a summary.
    const adminDownload = await call(app, fixture.adminToken, 'GET', `/reports/runs/${runId}/download?format=json`);
    expect(adminDownload.status, await adminDownload.clone().text()).toBe(200);
    expect(await adminDownload.json()).toMatchObject({ type: 'ar_aging', format: 'json' });
  });

  runDb('a platform admin (system token) lists partner-owned definitions and their runs (#3198 W02, addendum B7)', async () => {
    const fixture = await seedFixture();
    const app = buildApp();
    const created = await createPartnerDefinition(app, fixture, `System-visible AR ${randomUUID()}`);
    const generated = await call(app, fixture.adminToken, 'POST', `/reports/${created.id}/generate`);
    expect(generated.status).toBe(200);
    const { runId } = (await generated.json()) as { runId: string };

    await withSystemDbAccessContext(() => getTestDb()
      .update(users).set({ isPlatformAdmin: true }).where(eq(users.id, fixture.admin.id)));
    const systemToken = await createAccessToken({
      sub: fixture.admin.id,
      email: fixture.admin.email,
      roleId: fixture.partnerRole.id,
      orgId: null,
      partnerId: fixture.partner.id,
      scope: 'system',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    });

    // Newest-updated first, so the just-created row is on the first page.
    const list = await call(app, systemToken, 'GET', '/reports?limit=100');
    expect(list.status, await list.clone().text()).toBe(200);
    const listed = ((await list.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);
    expect(listed).toContain(created.id);

    const runs = await call(app, systemToken, 'GET', `/reports/runs?reportId=${created.id}&limit=100`);
    expect(runs.status, await runs.clone().text()).toBe(200);
    const runIds = ((await runs.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);
    expect(runIds).toEqual([runId]);
  });

  runDb('POST /reports/:id/generate on the partner-owned definition generates over the live partner org list (#3198 W02)', async () => {
    const fixture = await seedFixture();
    const app = buildApp();
    const created = await createPartnerDefinition(app, fixture);
    const partnerOrgIds = [fixture.orgA.id, fixture.orgB.id].sort();

    const res = await call(app, fixture.adminToken, 'POST', `/reports/${created.id}/generate`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; status: string };
    expect(body.status).toBe('completed');

    // The partner-scope generator ran under the request's own (partner) RLS
    // context, over every active org of the partner — resolved live.
    expect(generateReportSpy).toHaveBeenCalledTimes(1);
    const [type, scope, , authority] = generateReportSpy.mock.calls[0]!;
    expect(type).toBe('ar_aging');
    expect(scope).toEqual({ kind: 'partner', partnerId: fixture.partner.id, orgIds: partnerOrgIds });
    expect(authority.scope).toMatchObject({ kind: 'partner_wide', partnerId: fixture.partner.id });

    // One completed run, stamped with the admin's partner_wide envelope.
    const runs = await runsFor(created.id);
    expect(runs).toEqual([expect.objectContaining({
      id: body.runId,
      status: 'completed',
      errorMessage: null,
      requestedByKind: 'user',
      requestedByUserId: fixture.admin.id,
      executionScopeKind: 'partner_wide',
      executionScopeUserId: fixture.admin.id,
    })]);
    expect((await readDefinition(created.id))?.lastGeneratedAt).toBeInstanceOf(Date);

    // A 'selected' partner user does not learn the definition exists.
    const selected = await call(app, fixture.selectedToken, 'POST', `/reports/${created.id}/generate`);
    expect(selected.status).toBe(404);
    expect(await selected.json()).toEqual({ error: 'Report not found' });

    // Ad-hoc partner-wide generation runs the same generator.
    generateReportSpy.mockClear();
    const adhoc = await call(app, fixture.adminToken, 'POST', '/reports/generate', {
      ownerScope: 'partner',
      type: 'ar_aging',
      format: 'csv',
    });
    expect(adhoc.status).toBe(200);
    expect(await adhoc.json()).toMatchObject({ type: 'ar_aging', data: expect.any(Object) });
    expect(generateReportSpy.mock.calls[0]?.[1])
      .toEqual({ kind: 'partner', partnerId: fixture.partner.id, orgIds: partnerOrgIds });

    // ...and still refuses an org-only type at partner scope.
    const orgOnly = await call(app, fixture.adminToken, 'POST', '/reports/generate', {
      ownerScope: 'partner',
      type: 'device_inventory',
    });
    expect(orgOnly.status).toBe(400);
    expect(await orgOnly.json()).toEqual({ error: 'unsupported_report_scope', type: 'device_inventory' });
  });

  runDb('a full-access partner user with reports:* but WITHOUT invoices:read cannot create, generate or schedule-run ar_aging (ruling P8)', async () => {
    const fixture = await seedFixture();
    const app = buildApp();

    const create = await call(app, fixture.reportsOnlyToken, 'POST', '/reports', {
      ownerScope: 'partner',
      name: 'AR by email',
      type: 'ar_aging',
      schedule: 'monthly',
      config: { emailRecipients: ['me@example.com'] },
    });
    expect(create.status).toBe(403);
    expect(await create.json()).toEqual({ error: 'Insufficient permissions' });
    const owned = await getTestDb()
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.partnerId, fixture.partner.id));
    expect(owned).toEqual([]);

    const adhoc = await call(app, fixture.reportsOnlyToken, 'POST', '/reports/generate', {
      ownerScope: 'partner',
      type: 'ar_aging',
    });
    expect(adhoc.status).toBe(403);
    expect(await adhoc.json()).toEqual({ error: 'Insufficient permissions' });

    // An existing definition (the admin's) is HIDDEN from them (ruling P8b):
    // absent from the list, 404 by id, and 404 on every by-id write — the
    // same answer as a row outside their tenancy.
    const created = await createPartnerDefinition(app, fixture);
    const list = await call(app, fixture.reportsOnlyToken, 'GET', '/reports');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id)).not.toContain(created.id);
    const read = await call(app, fixture.reportsOnlyToken, 'GET', `/reports/${created.id}`);
    expect(read.status).toBe(404);
    const byId = await call(app, fixture.reportsOnlyToken, 'POST', `/reports/${created.id}/generate`);
    expect(byId.status).toBe(404);
    const put = await call(app, fixture.reportsOnlyToken, 'PUT', `/reports/${created.id}`, {
      config: { emailRecipients: ['me@example.com'] },
    });
    expect(put.status).toBe(404);
    expect(await runsFor(created.id)).toEqual([]);
    expect(generateReportSpy).not.toHaveBeenCalled();

    // Positive control: the reports-only user may still run a legacy type.
    const legacy = await call(app, fixture.reportsOnlyToken, 'POST', '/reports', {
      name: 'Inventory', type: 'device_inventory', orgId: fixture.orgA.id,
    });
    expect(legacy.status).toBe(201);

    // Worker: the ADMIN (execution user) loses invoices:read → the scheduled
    // run is a deny, not a generation. The worker re-reads role grants live
    // (no permission cache on this path).
    const [invoicesRead] = await getTestDb()
      .select({ id: permissions.id })
      .from(permissions)
      .where(and(eq(permissions.resource, 'invoices'), eq(permissions.action, 'read')));
    await getTestDb()
      .delete(rolePermissions)
      .where(and(
        eq(rolePermissions.roleId, fixture.partnerRole.id),
        eq(rolePermissions.permissionId, invoicesRead!.id),
      ));
    await expect(
      withSystemDbAccessContext(() =>
        processRunScheduledReport(
          { type: 'run-scheduled-report', reportId: created.id, occurrenceKey: 202609010900 },
          { finalAttempt: true },
        ),
      ),
    ).resolves.toBeUndefined();
    const denied = await runsFor(created.id);
    expect(denied).toEqual([expect.objectContaining({
      status: 'failed',
      errorMessage: 'scope_permission_missing',
      // #3198 W02 (addendum B3): stamped with the owner's partner_wide
      // envelope, so the refusal is not an invisible row.
      executionScopeKind: 'partner_wide',
      executionScopeUserId: fixture.admin.id,
    })]);
    expect(generateReportSpy).not.toHaveBeenCalled();

    // The admin still holds reports:read, so the refusal is listed and
    // readable by id — the answer to "why did my AR aging stop arriving?".
    const deniedList = await call(app, fixture.adminToken, 'GET', `/reports/runs?reportId=${created.id}&limit=100`);
    expect(deniedList.status).toBe(200);
    expect(((await deniedList.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual([denied[0]!.id]);
    const deniedGet = await call(app, fixture.adminToken, 'GET', `/reports/runs/${denied[0]!.id}`);
    expect(deniedGet.status).toBe(200);
    expect(await deniedGet.json()).toMatchObject({ id: denied[0]!.id, status: 'failed', errorMessage: 'scope_permission_missing' });
  });

  runDb('POST /reports/:id/recipients on the partner-owned definition answers 409 partner_owned_report', async () => {
    const fixture = await seedFixture();
    const app = buildApp();
    const created = await createPartnerDefinition(app, fixture);

    const res = await call(app, fixture.adminToken, 'POST', `/reports/${created.id}/recipients`, {
      contactId: randomUUID(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'partner_owned_report' });

    // The read side stays answerable and empty.
    const list = await call(app, fixture.adminToken, 'GET', `/reports/${created.id}/recipients`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ data: [] });

    const stored = await getTestDb()
      .select({ id: reportScheduleRecipients.id })
      .from(reportScheduleRecipients)
      .where(eq(reportScheduleRecipients.reportId, created.id));
    expect(stored).toEqual([]);

    // A 'selected' partner user gets the 404, not the 409.
    const selected = await call(app, fixture.selectedToken, 'POST', `/reports/${created.id}/recipients`, {
      contactId: randomUUID(),
    });
    expect(selected.status).toBe(404);
    expect(await selected.json()).toEqual({ error: 'Report not found' });
  });

  runDb('findDueReports returns the partner-owned monthly definition and processRunScheduledReport completes it under a partner scope (#3198 W02)', async () => {
    const fixture = await seedFixture();
    const app = buildApp();
    const created = await createPartnerDefinition(app, fixture);

    // Never generated → due now under the partner's timezone.
    const due = await withSystemDbAccessContext(() => findDueReports(new Date()));
    const entry = due.find((d) => d.id === created.id);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ id: created.id, lastGeneratedAt: null });
    expect(typeof entry!.occurrenceKey).toBe('number');

    await expect(
      withSystemDbAccessContext(() =>
        processRunScheduledReport(
          { type: 'run-scheduled-report', reportId: created.id, occurrenceKey: entry!.occurrenceKey },
          { finalAttempt: false },
        ),
      ),
    ).resolves.toBeUndefined();
    // The worker's system context resolves the same live org list the
    // request path does (ruling P6: one shared org-list query).
    expect(generateReportSpy).toHaveBeenCalledTimes(1);
    expect(generateReportSpy.mock.calls[0]?.[1]).toEqual({
      kind: 'partner',
      partnerId: fixture.partner.id,
      orgIds: [fixture.orgA.id, fixture.orgB.id].sort(),
    });

    // Exactly one run row: completed, executed under the admin's live
    // partner_wide authority.
    const runs = await runsFor(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'completed',
      errorMessage: null,
      requestedByKind: 'user',
      requestedByUserId: fixture.admin.id,
      executionScopeKind: 'partner_wide',
      executionScopeUserId: fixture.admin.id,
    });

    // The occurrence is stamped, so the next tick does not re-run it.
    const stamped = await readDefinition(created.id);
    expect(stamped?.lastGeneratedAt).toBeInstanceOf(Date);
    const dueAgain = await withSystemDbAccessContext(() => findDueReports(new Date()));
    expect(dueAgain.map((d) => d.id)).not.toContain(created.id);

    // Live reauthorization: demote the acting user to 'selected' and the worker
    // refuses with the partner reason instead of running.
    await getTestDb()
      .update(partnerUsers)
      .set({ orgAccess: 'selected', orgIds: [fixture.orgA.id] })
      .where(and(eq(partnerUsers.userId, fixture.admin.id), eq(partnerUsers.partnerId, fixture.partner.id)));
    await withSystemDbAccessContext(() =>
      processRunScheduledReport(
        { type: 'run-scheduled-report', reportId: created.id, occurrenceKey: entry!.occurrenceKey },
        { finalAttempt: true },
      ),
    );
    const afterDemotion = await runsFor(created.id);
    expect(afterDemotion).toHaveLength(2);
    expect(afterDemotion.map((r) => `${r.status}:${r.errorMessage}`).sort()).toEqual(
      ['completed:null', 'failed:scope_partner_access_not_all'].sort(),
    );
    // The demoted run never reached the generator.
    expect(generateReportSpy).toHaveBeenCalledTimes(1);

    // #3198 W02 (addendum B3): the refusal carries the owner's partner_wide
    // envelope (the demoted creator is still the principal it is about)...
    const refusal = afterDemotion.find((r) => r.status === 'failed')!;
    expect(refusal).toMatchObject({
      requestedByKind: 'user',
      requestedByUserId: fixture.admin.id,
      executionScopeKind: 'partner_wide',
      executionScopeUserId: fixture.admin.id,
    });
    // ...so ANOTHER partner admin with org_access='all' sees it in the run list
    // and by id (it used to be an invisible NULL-envelope row: never listed,
    // and a 404 by id because decodeSiteScope threw on it).
    const otherAdmin = await createUser({ partnerId: fixture.partner.id, orgId: null, email: uniqueEmail('admin2') });
    await assignUserToPartner(otherAdmin.id, fixture.partner.id, fixture.partnerRole.id, 'all');
    const otherAdminToken = await partnerToken(otherAdmin, fixture.partnerRole.id, fixture.partner.id);
    const listed = await call(app, otherAdminToken, 'GET', `/reports/runs?reportId=${created.id}&limit=100`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id).sort())
      .toEqual(afterDemotion.map((r) => r.id).sort());
    const byId = await call(app, otherAdminToken, 'GET', `/reports/runs/${refusal.id}`);
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject({
      id: refusal.id,
      status: 'failed',
      errorMessage: 'scope_partner_access_not_all',
    });
    // The demoted ('selected') creator no longer sees either run.
    const demotedToken = await partnerToken(fixture.admin, fixture.partnerRole.id, fixture.partner.id);
    const demotedGet = await call(app, demotedToken, 'GET', `/reports/runs/${refusal.id}`);
    expect(demotedGet.status).toBe(404);
  });
});

/**
 * #3198 W02, ruling F1 — business report types (registry audience
 * 'msp_staff') are internal to the MSP. Against real Postgres (breeze_app,
 * forced RLS), through the production auth middleware and routes: an ORG-scope
 * token holding reports:* never lists, reads, downloads, edits or generates an
 * org-owned business definition or run that a partner user made in its own
 * org, while the partner user (positive control) and the org token's legacy
 * types are unaffected. And the schedule worker re-checks an org-owned
 * business report on the partner axis only, so a customer user's org role —
 * however it is configured — cannot run one.
 */
describe('business report types are MSP-staff-only (#3198 W02, ruling F1)', () => {
  beforeEach(() => {
    generateReportSpy.mockClear();
  });

  runDb('an org token cannot list, get or download an org-owned ar_aging run a partner user made; the partner user can', async () => {
    const fixture = await seedFixture();
    const app = buildApp();

    // The partner admin makes an org-owned ar_aging definition in orgA and runs it.
    const arDef = await call(app, fixture.adminToken, 'POST', '/reports', {
      name: 'orgA AR aging', type: 'ar_aging', orgId: fixture.orgA.id, schedule: 'monthly', format: 'csv',
    });
    expect(arDef.status, await arDef.clone().text()).toBe(201);
    const arDefId = ((await arDef.json()) as { id: string }).id;
    const arGen = await call(app, fixture.adminToken, 'POST', `/reports/${arDefId}/generate`);
    expect(arGen.status, await arGen.clone().text()).toBe(200);
    const arRunId = ((await arGen.json()) as { runId: string }).runId;

    // Positive control on the SAME org token: an org-owned device_inventory
    // definition + run in orgA stay visible.
    const invDef = await call(app, fixture.adminToken, 'POST', '/reports', {
      name: 'orgA inventory', type: 'device_inventory', orgId: fixture.orgA.id,
    });
    expect(invDef.status).toBe(201);
    const invDefId = ((await invDef.json()) as { id: string }).id;
    const invGen = await call(app, fixture.adminToken, 'POST', `/reports/${invDefId}/generate`);
    expect(invGen.status, await invGen.clone().text()).toBe(200);
    const invRunId = ((await invGen.json()) as { runId: string }).runId;

    const idsOf = async (res: Response) => ((await res.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);

    // --- org token: hidden everywhere, as an ordinary 404 ---
    const list = await call(app, fixture.orgToken, 'GET', '/reports?limit=100');
    expect(list.status).toBe(200);
    const listIds = await idsOf(list);
    expect(listIds).toContain(invDefId);
    expect(listIds).not.toContain(arDefId);

    const byType = await call(app, fixture.orgToken, 'GET', '/reports?type=ar_aging&limit=100');
    expect(byType.status).toBe(200);
    expect(await idsOf(byType)).toEqual([]);

    const get = await call(app, fixture.orgToken, 'GET', `/reports/${arDefId}`);
    expect(get.status).toBe(404);

    const runs = await call(app, fixture.orgToken, 'GET', '/reports/runs?limit=100');
    expect(runs.status).toBe(200);
    const runIds = await idsOf(runs);
    expect(runIds).toContain(invRunId);
    expect(runIds).not.toContain(arRunId);

    const runGet = await call(app, fixture.orgToken, 'GET', `/reports/runs/${arRunId}`);
    expect(runGet.status).toBe(404);
    expect(await runGet.json()).toEqual({ error: 'Report run not found' });

    const download = await call(app, fixture.orgToken, 'GET', `/reports/runs/${arRunId}/download?format=json`);
    expect(download.status).toBe(404);
    expect(await download.json()).toEqual({ error: 'Report run not found' });

    const invRunGet = await call(app, fixture.orgToken, 'GET', `/reports/runs/${invRunId}`);
    expect(invRunGet.status).toBe(200);

    // Mutations and generation by id: the row does not exist for them.
    const put = await call(app, fixture.orgToken, 'PUT', `/reports/${arDefId}`, {
      config: { emailRecipients: ['customer@example.com'] },
    });
    expect(put.status).toBe(404);
    const regen = await call(app, fixture.orgToken, 'POST', `/reports/${arDefId}/generate`);
    expect(regen.status).toBe(404);
    expect(await runsFor(arDefId)).toHaveLength(1);

    // Create and ad-hoc generate of a business type: 403.
    const create = await call(app, fixture.orgToken, 'POST', '/reports', {
      name: 'customer AR', type: 'ar_aging', schedule: 'monthly',
    });
    expect(create.status).toBe(403);
    expect(await create.json()).toEqual({ error: 'Insufficient permissions' });
    const adhoc = await call(app, fixture.orgToken, 'POST', '/reports/generate', { type: 'ticket_sla_attainment' });
    expect(adhoc.status).toBe(403);
    expect(await adhoc.json()).toEqual({ error: 'Insufficient permissions' });

    // --- partner admin: the positive control on the same run ---
    const adminRunGet = await call(app, fixture.adminToken, 'GET', `/reports/runs/${arRunId}`);
    expect(adminRunGet.status).toBe(200);
    expect(await adminRunGet.json()).toMatchObject({ id: arRunId, reportId: arDefId, status: 'completed' });
    const adminDownload = await call(app, fixture.adminToken, 'GET', `/reports/runs/${arRunId}/download?format=json`);
    expect(adminDownload.status, await adminDownload.clone().text()).toBe(200);
    expect(await adminDownload.json()).toMatchObject({ type: 'ar_aging', format: 'json' });
    const adminList = await call(app, fixture.adminToken, 'GET', `/reports/runs?reportId=${arDefId}&limit=100`);
    expect(await idsOf(adminList)).toEqual([arRunId]);
  });

  runDb('the worker denies an org-owned technician_time_billability report whose execution user holds the permissions only through an org role', async () => {
    // I1: an org role holding time_entries:read + tickets:read (the 2026-06-12-a
    // migration grants time_entries:read to every tickets:read role). The row
    // is inserted directly, as a pre-F1 create would have left it.
    const fixture = await seedFixture();
    await grantRolePermissions(fixture.orgRole.id, [
      { resource: 'time_entries', action: 'read' },
      { resource: 'tickets', action: 'read' },
    ]);
    const scope = { version: 1 as const, kind: 'unrestricted' as const, orgId: fixture.orgA.id };
    const [row] = await getTestDb()
      .insert(reports)
      .values({
        orgId: fixture.orgA.id,
        name: 'customer-made time report',
        type: 'technician_time_billability',
        config: { emailRecipients: ['customer@example.com'] },
        schedule: 'monthly',
        format: 'csv',
        createdBy: fixture.orgUser.id,
        executionScopeVersion: 1,
        executionScopeKind: 'unrestricted',
        executionScopeSiteIds: null,
        executionScopeUserId: fixture.orgUser.id,
        executionScopeFingerprint: siteScopeFingerprint(scope),
        executionScopeCapturedAt: new Date(),
        executionScopePrincipalKind: 'user',
      })
      .returning({ id: reports.id });

    await expect(
      withSystemDbAccessContext(() =>
        processRunScheduledReport(
          { type: 'run-scheduled-report', reportId: row!.id, occurrenceKey: 202609010900 },
          { finalAttempt: true },
        ),
      ),
    ).resolves.toBeUndefined();
    expect(await runsFor(row!.id)).toEqual([expect.objectContaining({
      status: 'failed',
      errorMessage: 'scope_permission_missing',
      requestedByKind: 'user',
      requestedByUserId: fixture.orgUser.id,
    })]);
    expect(generateReportSpy).not.toHaveBeenCalled();
  });

  runDb('positive control: the same org-owned business report runs when its execution user is a covering partner user', async () => {
    const fixture = await seedFixture();
    const app = buildApp();
    const created = await call(app, fixture.adminToken, 'POST', '/reports', {
      name: 'orgA AR aging', type: 'ar_aging', orgId: fixture.orgA.id, schedule: 'monthly', format: 'csv',
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    await withSystemDbAccessContext(() =>
      processRunScheduledReport(
        { type: 'run-scheduled-report', reportId: id, occurrenceKey: 202609010900 },
        { finalAttempt: true },
      ),
    );
    expect(await runsFor(id)).toEqual([expect.objectContaining({ status: 'completed', executionScopeUserId: fixture.admin.id })]);
    expect(generateReportSpy).toHaveBeenCalledTimes(1);
  });

  // #6699 - abuse containment. Same definition, same still-'active' admin with
  // org_access='all'; only the owning partner is suspended. The worker must
  // refuse at the live-authority step with a permanent reason, never reaching
  // the generator, and must not rethrow. The deny row carries W02's
  // partner_wide visibility envelope (partnerDenyEnvelope), so the refusal
  // stays readable in the partner's run history.
  runDb('processRunScheduledReport refuses a partner-owned definition once its partner is suspended (#6699)', async () => {
    const fixture = await seedFixture();
    const app = buildApp();
    const created = await createPartnerDefinition(app, fixture, 'Suspended partner AR aging');

    await getTestDb()
      .update(partners)
      .set({ status: 'suspended' })
      .where(eq(partners.id, fixture.partner.id));

    await expect(
      withSystemDbAccessContext(() =>
        processRunScheduledReport(
          { type: 'run-scheduled-report', reportId: created.id, occurrenceKey: 1 },
          { finalAttempt: false },
        ),
      ),
    ).resolves.toBeUndefined();
    expect(generateReportSpy).not.toHaveBeenCalled();

    const runs = await runsFor(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'failed',
      errorMessage: 'scope_tenant_inactive',
      requestedByKind: 'user',
      requestedByUserId: fixture.admin.id,
      executionScopeKind: 'partner_wide',
    });
  });

  // #6699 decision B: the suspended partner's definitions and run history stay
  // readable ('read_history'); every producing action is refused.
  runDb('a suspended partner keeps read_history but loses read/write/export/delete (#6699 decision B)', async () => {
    const fixture = await seedFixture();
    await getTestDb()
      .update(partners)
      .set({ status: 'suspended' })
      .where(eq(partners.id, fixture.partner.id));

    await expect(
      resolveLivePartnerReportAuthority(fixture.admin.id, fixture.partner.id, 'read_history'),
    ).resolves.toMatchObject({ ok: true, authority: { scope: { kind: 'partner_wide' } } });
    for (const action of ['read', 'write', 'export', 'delete'] as const) {
      await expect(
        resolveLivePartnerReportAuthority(fixture.admin.id, fixture.partner.id, action),
      ).resolves.toEqual({ ok: false, reason: 'tenant_inactive' });
    }
  });
});
