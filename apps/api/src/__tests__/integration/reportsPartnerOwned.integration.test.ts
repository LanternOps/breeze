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
 * the generate route and the worker can be shown to refuse a partner-owned
 * definition BEFORE reaching the org-only generator.
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
import { partnerUsers, reportRuns, reportScheduleRecipients, reports } from '../../db/schema';
import { findDueReports, processRunScheduledReport } from '../../jobs/reportScheduleWorker';
import { reportRoutes } from '../../routes/reports';
import { authMiddleware } from '../../middleware/auth';
import { createAccessToken } from '../../services/jwt';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
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
  await grantRolePermissions(partnerRole.id, REPORT_PERMISSIONS);

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
    orgA,
    orgB,
    admin,
    selected,
    orgUser,
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

describe('partner-owned report definitions through the real routes (#3198 W01)', () => {
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

    // A client-supplied orgId on the partner branch is ignored, never an owner.
    const withOrg = await call(app, fixture.adminToken, 'POST', '/reports', {
      ownerScope: 'partner',
      orgId: fixture.orgA.id,
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

  runDb('POST /reports/:id/generate on the partner-owned definition answers 400 unsupported_report_scope (W02 turns this green)', async () => {
    const fixture = await seedFixture();
    const app = buildApp();
    const created = await createPartnerDefinition(app, fixture);

    const res = await call(app, fixture.adminToken, 'POST', `/reports/${created.id}/generate`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_report_scope', type: 'ar_aging' });

    // Refused before any run row is created, and before the org-only generator.
    expect(await runsFor(created.id)).toEqual([]);
    expect(generateReportSpy).not.toHaveBeenCalled();
    expect((await readDefinition(created.id))?.lastGeneratedAt).toBeNull();

    // A 'selected' partner user does not learn the definition exists.
    const selected = await call(app, fixture.selectedToken, 'POST', `/reports/${created.id}/generate`);
    expect(selected.status).toBe(404);
    expect(await selected.json()).toEqual({ error: 'Report not found' });

    // Ad-hoc partner-wide generation is refused the same way.
    const adhoc = await call(app, fixture.adminToken, 'POST', '/reports/generate', {
      ownerScope: 'partner',
      type: 'ar_aging',
      format: 'csv',
    });
    expect(adhoc.status).toBe(400);
    expect(await adhoc.json()).toEqual({ error: 'unsupported_report_scope', type: 'ar_aging' });
    expect(generateReportSpy).not.toHaveBeenCalled();
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

  runDb('findDueReports returns the partner-owned monthly definition and processRunScheduledReport records a failed run with unsupported_report_scope', async () => {
    const fixture = await seedFixture();
    const app = buildApp();
    const created = await createPartnerDefinition(app, fixture);

    // Never generated → due now under the partner's timezone.
    const due = await withSystemDbAccessContext(() => findDueReports(new Date()));
    const entry = due.find((d) => d.id === created.id);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ id: created.id, lastGeneratedAt: null });
    expect(typeof entry!.occurrenceKey).toBe('number');

    // Resolves (no rethrow → no BullMQ retry) and never calls the generator.
    await expect(
      withSystemDbAccessContext(() =>
        processRunScheduledReport(
          { type: 'run-scheduled-report', reportId: created.id, occurrenceKey: entry!.occurrenceKey },
          { finalAttempt: false },
        ),
      ),
    ).resolves.toBeUndefined();
    expect(generateReportSpy).not.toHaveBeenCalled();

    // Exactly one run row: failed with the stable reason, executed under the
    // admin's live partner_wide authority (not a deny() row, which carries no
    // execution scope).
    const runs = await runsFor(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'failed',
      errorMessage: 'unsupported_report_scope',
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
    expect(afterDemotion.map((r) => r.errorMessage).sort()).toEqual(
      ['scope_partner_access_not_all', 'unsupported_report_scope'].sort(),
    );
    expect(generateReportSpy).not.toHaveBeenCalled();
  });
});
