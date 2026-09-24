/**
 * #6771 — an active partner reads report history of its own out-of-service
 * orgs through the REAL auth middleware and report routes, against real
 * Postgres as the forced-RLS `breeze_app` role.
 *
 * Route allowance (design quorum, issue #6771):
 *   allowed : GET /reports?orgId=, /reports/templates?orgId=, /reports/:id,
 *             /reports/runs?orgId=, /reports/runs/:id   (metadata only)
 *   refused : GET /reports/:id/recipients (live contact PII),
 *             GET /reports/runs/:id/download and /reports/data/* (exports),
 *             every generate / schedule / mutate route.
 *
 * `resolveRequestReportAuthority` / `resolveRequestReportAuthorityMap` (the
 * live resolvers that escape to a system context on a second pooled
 * connection) are wrapped in spies: a history-org request must never reach
 * them with the history org.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/siteScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/siteScope')>();
  return {
    ...actual,
    resolveRequestReportAuthority: vi.fn(actual.resolveRequestReportAuthority),
    resolveRequestReportAuthorityMap: vi.fn(actual.resolveRequestReportAuthorityMap),
  };
});

import {
  devices,
  organizations,
  organizationUsers,
  partnerUsers,
  reportRuns,
  reports,
  users,
} from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { deviceRoutes } from '../../routes/devices';
import { reportRoutes } from '../../routes/reports';
import { createAccessToken } from '../../services/jwt';
import {
  persistedSiteScopeValues,
  resolveRequestReportAuthority,
  resolveRequestReportAuthorityMap,
  siteScopeFingerprint,
  type LiveSiteScopeV1,
} from '../../services/siteScope';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PERMS = [
  { resource: 'reports', action: 'read' },
  { resource: 'reports', action: 'write' },
  { resource: 'reports', action: 'delete' },
  { resource: 'reports', action: 'export' },
  { resource: 'devices', action: 'read' },
];
const HISTORY_STATUSES = ['suspended', 'churned', 'offboarding', 'archived'] as const;
type HistoryStatus = (typeof HISTORY_STATUSES)[number];

const resolveSpy = vi.mocked(resolveRequestReportAuthority);
const resolveMapSpy = vi.mocked(resolveRequestReportAuthorityMap);

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/reports', reportRoutes);
  app.route('/devices', deviceRoutes);
  return app;
}

function scopeColumns(scope: LiveSiteScopeV1, userId: string) {
  return persistedSiteScopeValues({
    principalKind: 'user',
    scope,
    principalUserId: userId,
    capturedAt: new Date(),
    fingerprint: siteScopeFingerprint(scope),
  });
}

async function setStatus(orgId: string, status: string, deletedAt?: Date) {
  await getTestDb()
    .update(organizations)
    .set({ status: status as never, ...(deletedAt ? { deletedAt } : {}) })
    .where(eq(organizations.id, orgId));
}

async function seedReport(orgId: string, userId: string, opts: { type?: 'device_inventory' | 'ar_aging'; scope?: LiveSiteScopeV1; name?: string } = {}) {
  const scope = opts.scope ?? { version: 1, kind: 'unrestricted', orgId };
  const columns = scopeColumns(scope, userId);
  const [report] = await getTestDb()
    .insert(reports)
    .values({
      orgId,
      name: opts.name ?? `History ${opts.type ?? 'device_inventory'}`,
      type: opts.type ?? 'device_inventory',
      createdBy: userId,
      ...columns,
    })
    .returning({ id: reports.id });
  const [run] = await getTestDb()
    .insert(reportRuns)
    .values({
      reportId: report!.id,
      status: 'completed',
      rowCount: 1,
      result: { rows: [{ hostname: 'stored-result-secret' }] },
      completedAt: new Date(),
      ...columns,
    })
    .returning({ id: reportRuns.id });
  return { reportId: report!.id, runId: run!.id };
}

async function partnerToken(userId: string, email: string, roleId: string, partnerId: string) {
  return createAccessToken({
    sub: userId, email, roleId, orgId: null, partnerId, scope: 'partner',
    mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

async function seedPartnerUser(partnerId: string, orgAccess: 'all' | 'selected' | 'none', orgIds?: string[]) {
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, PERMS);
  const user = await createUser({ partnerId, email: `rh-http-${randomUUID()}@example.com` });
  await assignUserToPartner(user.id, partnerId, role.id, orgAccess);
  if (orgIds) {
    await getTestDb().update(partnerUsers).set({ orgIds }).where(eq(partnerUsers.userId, user.id));
  }
  return { user, roleId: role.id, token: await partnerToken(user.id, user.email, role.id, partnerId) };
}

async function seedFixture(historyStatus: HistoryStatus = 'suspended') {
  const partner = await createPartner();
  const activeOrg = await createOrganization({ partnerId: partner.id });
  const historyOrg = await createOrganization({ partnerId: partner.id });
  const deletedOrg = await createOrganization({ partnerId: partner.id });

  const admin = await seedPartnerUser(partner.id, 'all');
  const historyReport = await seedReport(historyOrg.id, admin.user.id);
  const arReport = await seedReport(historyOrg.id, admin.user.id, { type: 'ar_aging' });
  const activeReport = await seedReport(activeOrg.id, admin.user.id, { name: 'Active inventory' });
  const deletedReport = await seedReport(deletedOrg.id, admin.user.id);
  const site = await createSite({ orgId: historyOrg.id });
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: historyOrg.id, siteId: site.id, agentId: randomUUID(),
      hostname: `rh-${randomUUID().slice(0, 8)}`, osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: '0.0.0-test',
    })
    .returning({ id: devices.id });

  await setStatus(historyOrg.id, historyStatus);
  await setStatus(deletedOrg.id, 'suspended', new Date());

  return { partner, activeOrg, historyOrg, deletedOrg, admin, historyReport, arReport, activeReport, deletedReport, site, deviceId: device!.id };
}

async function call(app: Hono, token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function calledWithOrg(spy: typeof resolveSpy | typeof resolveMapSpy, orgId: string): boolean {
  return spy.mock.calls.some((args) => {
    const target = args[1] as unknown;
    return Array.isArray(target) ? target.includes(orgId) : target === orgId;
  });
}

beforeEach(() => {
  resolveSpy.mockClear();
  resolveMapSpy.mockClear();
});

describe('report history of an inactive org through the real routes (#6771)', () => {
  for (const status of HISTORY_STATUSES) {
    runDb(`${status}: every allowed route answers 200 and stays metadata-only`, async () => {
      const f = await seedFixture(status);
      const app = buildApp();
      const token = f.admin.token;
      const H = f.historyOrg.id;

      const list = await call(app, token, 'GET', `/reports?orgId=${H}`);
      expect(list.status).toBe(200);
      const listIds = ((await list.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);
      expect(listIds).toContain(f.historyReport.reportId);

      const templates = await call(app, token, 'GET', `/reports/templates?orgId=${H}`);
      expect(templates.status).toBe(200);
      expect(((await templates.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id))
        .toContain(f.historyReport.reportId);

      const detail = await call(app, token, 'GET', `/reports/${f.historyReport.reportId}`);
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as { id: string; recentRuns: Array<{ id: string }> };
      expect(detailBody.id).toBe(f.historyReport.reportId);
      expect(detailBody.recentRuns.map((r) => r.id)).toEqual([f.historyReport.runId]);
      expect(JSON.stringify(detailBody)).not.toContain('stored-result-secret');

      const runs = await call(app, token, 'GET', `/reports/runs?orgId=${H}`);
      expect(runs.status).toBe(200);
      const runsText = await runs.text();
      expect((JSON.parse(runsText) as { data: Array<{ id: string }> }).data.map((r) => r.id))
        .toContain(f.historyReport.runId);
      expect(runsText).not.toContain('stored-result-secret');
      expect(runsText).not.toContain('"result"');

      const run = await call(app, token, 'GET', `/reports/runs/${f.historyReport.runId}`);
      expect(run.status).toBe(200);
      const runText = await run.text();
      expect((JSON.parse(runText) as { id: string }).id).toBe(f.historyReport.runId);
      expect(runText).not.toContain('stored-result-secret');
      expect(runText).not.toContain('"result"');

      // The live resolvers (system escape on a second connection) were never
      // asked about the history org.
      expect(calledWithOrg(resolveSpy, H)).toBe(false);
      expect(calledWithOrg(resolveMapSpy, H)).toBe(false);
    });

    runDb(`${status}: recipients, downloads, /data and every mutation stay refused`, async () => {
      const f = await seedFixture(status);
      const app = buildApp();
      const token = f.admin.token;
      const H = f.historyOrg.id;
      const { reportId, runId } = f.historyReport;

      expect((await call(app, token, 'GET', `/reports/${reportId}/recipients`)).status).toBe(404);
      expect((await call(app, token, 'GET', `/reports/runs/${runId}/download`)).status).toBe(404);
      expect((await call(app, token, 'GET', `/reports/runs/${runId}/download?format=json`)).status).toBe(404);
      expect([403, 404]).toContain((await call(app, token, 'GET', `/reports/data/device-inventory?orgId=${H}`)).status);
      expect([403, 404]).toContain((await call(app, token, 'POST', `/reports/${reportId}/generate`, {})).status);
      expect([403, 404]).toContain((await call(app, token, 'POST', '/reports/generate', {
        orgId: H, type: 'device_inventory', format: 'csv',
      })).status);
      expect([403, 404]).toContain((await call(app, token, 'POST', '/reports', {
        orgId: H, name: 'new', type: 'device_inventory', schedule: 'one_time', format: 'csv',
      })).status);
      expect((await call(app, token, 'PUT', `/reports/${reportId}`, { name: 'renamed' })).status).toBe(404);
      expect((await call(app, token, 'POST', `/reports/${reportId}/reauthorize`, {})).status).toBe(404);
      expect((await call(app, token, 'DELETE', `/reports/${reportId}`)).status).toBe(404);
      expect([403, 404]).toContain((await call(app, token, 'POST', `/reports/${reportId}/recipients`, {
        contactId: randomUUID(),
      })).status);

      // Nothing changed underneath.
      const [row] = await getTestDb().select({ name: reports.name }).from(reports).where(eq(reports.id, reportId));
      expect(row?.name).toBe('History device_inventory');
      const runRows = await getTestDb().select({ id: reportRuns.id }).from(reportRuns).where(eq(reportRuns.reportId, reportId));
      expect(runRows).toHaveLength(1);
    });
  }

  runDb('device reads for the inactive org still fail', async () => {
    const f = await seedFixture();
    const app = buildApp();
    expect((await call(app, f.admin.token, 'GET', `/devices?orgId=${f.historyOrg.id}`)).status).toBe(403);
    expect((await call(app, f.admin.token, 'GET', `/devices/${f.deviceId}`)).status).toBe(404);
  });

  runDb('the unfiltered listings are unchanged: no history rows without an explicit orgId', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const list = (await (await call(app, f.admin.token, 'GET', '/reports')).json()) as { data: Array<{ id: string }> };
    const ids = list.data.map((r) => r.id);
    expect(ids).toContain(f.activeReport.reportId);
    expect(ids).not.toContain(f.historyReport.reportId);
    const runs = (await (await call(app, f.admin.token, 'GET', '/reports/runs')).json()) as { data: Array<{ id: string }> };
    expect(runs.data.map((r) => r.id)).not.toContain(f.historyReport.runId);
  });

  runDb('per-type report grants hold: a type needing invoices:read is hidden from a caller without it', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const list = (await (await call(app, f.admin.token, 'GET', `/reports?orgId=${f.historyOrg.id}`)).json()) as {
      data: Array<{ id: string }>;
    };
    expect(list.data.map((r) => r.id)).not.toContain(f.arReport.reportId);
    expect((await call(app, f.admin.token, 'GET', `/reports/${f.arReport.reportId}`)).status).toBe(404);
    expect((await call(app, f.admin.token, 'GET', `/reports/runs/${f.arReport.runId}`)).status).toBe(404);
  });

  runDb('a deleted org is excluded', async () => {
    const f = await seedFixture();
    const app = buildApp();
    expect((await call(app, f.admin.token, 'GET', `/reports?orgId=${f.deletedOrg.id}`)).status).toBe(403);
    expect((await call(app, f.admin.token, 'GET', `/reports/${f.deletedReport.reportId}`)).status).toBe(404);
    expect((await call(app, f.admin.token, 'GET', `/reports/runs/${f.deletedReport.runId}`)).status).toBe(404);
  });

  runDb('selected access: only an inactive org in the curated list; none access: nothing', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const inList = await seedPartnerUser(f.partner.id, 'selected', [f.historyOrg.id]);
    const outOfList = await seedPartnerUser(f.partner.id, 'selected', [f.activeOrg.id]);
    const none = await seedPartnerUser(f.partner.id, 'none');

    expect((await call(app, inList.token, 'GET', `/reports?orgId=${f.historyOrg.id}`)).status).toBe(200);
    expect((await call(app, inList.token, 'GET', `/reports/${f.historyReport.reportId}`)).status).toBe(200);
    expect((await call(app, inList.token, 'GET', `/reports/runs/${f.historyReport.runId}`)).status).toBe(200);

    for (const who of [outOfList, none]) {
      expect((await call(app, who.token, 'GET', `/reports?orgId=${f.historyOrg.id}`)).status).toBe(403);
      expect((await call(app, who.token, 'GET', `/reports/${f.historyReport.reportId}`)).status).toBe(404);
      expect((await call(app, who.token, 'GET', `/reports/runs/${f.historyReport.runId}`)).status).toBe(404);
      const runs = await call(app, who.token, 'GET', `/reports/runs?orgId=${f.historyOrg.id}`);
      expect(runs.status).toBe(403);
    }
  });

  runDb('a foreign partner cannot see the rows', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const foreignPartner = await createPartner();
    const foreign = await seedPartnerUser(foreignPartner.id, 'all');
    expect((await call(app, foreign.token, 'GET', `/reports?orgId=${f.historyOrg.id}`)).status).toBe(403);
    expect((await call(app, foreign.token, 'GET', `/reports/${f.historyReport.reportId}`)).status).toBe(404);
    expect((await call(app, foreign.token, 'GET', `/reports/runs/${f.historyReport.runId}`)).status).toBe(404);
    expect((await call(app, foreign.token, 'GET', `/reports/runs?orgId=${f.historyOrg.id}`)).status).toBe(403);
  });

  runDb('inactive users, inactive partners and org tokens are refused', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const path = `/reports?orgId=${f.historyOrg.id}`;

    const disabled = await seedPartnerUser(f.partner.id, 'all');
    await getTestDb().update(users).set({ status: 'disabled' }).where(eq(users.id, disabled.user.id));
    expect((await call(app, disabled.token, 'GET', path)).status).toBe(403);

    const suspendedPartner = await createPartner({ status: 'suspended' });
    const suspendedOrg = await createOrganization({ partnerId: suspendedPartner.id, status: 'suspended' });
    const inactivePartnerUser = await seedPartnerUser(suspendedPartner.id, 'all');
    expect((await call(app, inactivePartnerUser.token, 'GET', `/reports?orgId=${suspendedOrg.id}`)).status).toBe(403);

    const orgRole = await createRole({ scope: 'organization', orgId: f.historyOrg.id, partnerId: f.partner.id });
    await grantRolePermissions(orgRole.id, PERMS);
    const orgUser = await createUser({ partnerId: f.partner.id, orgId: f.historyOrg.id, email: `rh-org-${randomUUID()}@example.com` });
    await assignUserToOrganization(orgUser.id, f.historyOrg.id, orgRole.id);
    const orgToken = await createAccessToken({
      sub: orgUser.id, email: orgUser.email, roleId: orgRole.id, orgId: f.historyOrg.id,
      partnerId: f.partner.id, scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    expect((await call(app, orgToken, 'GET', path)).status).toBe(403);
    expect((await call(app, orgToken, 'GET', `/reports/${f.historyReport.reportId}`)).status).toBe(403);
  });

  runDb('membership removal takes effect on the next request', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const tech = await seedPartnerUser(f.partner.id, 'all');
    expect((await call(app, tech.token, 'GET', `/reports/${f.historyReport.reportId}`)).status).toBe(200);
    await getTestDb().delete(partnerUsers).where(eq(partnerUsers.userId, tech.user.id));
    expect([401, 403, 404]).toContain((await call(app, tech.token, 'GET', `/reports/${f.historyReport.reportId}`)).status);
  });

  runDb('site restrictions hold: an org membership limited to another site cannot read a site-scoped report', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const otherSite = await createSite({ orgId: f.historyOrg.id });
    const restrictedReport = await seedReport(f.historyOrg.id, f.admin.user.id, {
      scope: { version: 1, kind: 'restricted', orgId: f.historyOrg.id, siteIds: [f.site.id] },
      name: 'Site-scoped',
    });

    const tech = await seedPartnerUser(f.partner.id, 'all');
    const orgRole = await createRole({ scope: 'organization', orgId: f.historyOrg.id, partnerId: f.partner.id });
    await grantRolePermissions(orgRole.id, PERMS);
    await assignUserToOrganization(tech.user.id, f.historyOrg.id, orgRole.id);
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: [otherSite.id] })
      .where(eq(organizationUsers.userId, tech.user.id));

    expect((await call(app, tech.token, 'GET', `/reports/${restrictedReport.reportId}`)).status).toBe(404);
    expect((await call(app, tech.token, 'GET', `/reports/runs/${restrictedReport.runId}`)).status).toBe(404);
    // Same restriction holds on the unrestricted definition (stored scope
    // wider than the caller's live scope).
    expect((await call(app, tech.token, 'GET', `/reports/${f.historyReport.reportId}`)).status).toBe(404);

    // The admin (partner membership, unrestricted) still reads it.
    expect((await call(app, f.admin.token, 'GET', `/reports/${restrictedReport.reportId}`)).status).toBe(200);
  });
});
