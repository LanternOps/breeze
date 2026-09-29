/**
 * Multi-org report series W01 — org visibility and delivery status through the
 * REAL report routes and the REAL schedule worker, against real Postgres as the
 * forced-RLS `breeze_app` role.
 *
 *  - The worker writes report_runs.delivery_status / recipient_count on a run
 *    nobody receives (the silent skip, spec §1).
 *  - GET /reports and GET /reports/runs carry the owning org (orgName via a
 *    LEFT JOIN that RLS still governs) and the delivery summary.
 *  - An org token still lists only its own org.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { withSystemDbAccessContext } from '../../db';
import { reportRuns } from '../../db/schema';
import { processRunScheduledReport } from '../../jobs/reportScheduleWorker';
import { authMiddleware } from '../../middleware/auth';
import { reportRoutes } from '../../routes/reports';
import { createAccessToken } from '../../services/jwt';
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

const REPORT_PERMISSIONS = [
  { resource: 'reports', action: 'read' },
  { resource: 'reports', action: 'write' },
  { resource: 'reports', action: 'delete' },
  { resource: 'reports', action: 'export' },
];
// ar_aging (the partner-owned Combined case) also needs its data permission.
const AR_PERMISSIONS = [{ resource: 'invoices', action: 'read' }];

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/reports', reportRoutes);
  return app;
}

function uniqueEmail(label: string): string {
  return `reports-org-visibility-${label}-${randomUUID()}@example.com`;
}

async function call(app: Hono, token: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | undefined;
  return e?.cause?.code ?? e?.code;
}

/** Partner P with orgs A and B; an org_access='all' partner admin and an org-scope user of A. */
async function seedFixture() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id, name: `Acme Dental ${randomUUID().slice(0, 8)}` });
  const orgB = await createOrganization({ partnerId: partner.id, name: `Bravo Law ${randomUUID().slice(0, 8)}` });

  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, [...REPORT_PERMISSIONS, ...AR_PERMISSIONS]);
  const admin = await createUser({ partnerId: partner.id, orgId: null, email: uniqueEmail('admin') });
  await assignUserToPartner(admin.id, partner.id, partnerRole.id, 'all');

  const orgRole = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id });
  await grantRolePermissions(orgRole.id, REPORT_PERMISSIONS);
  const orgUser = await createUser({ partnerId: partner.id, orgId: orgA.id, email: uniqueEmail('org') });
  await assignUserToOrganization(orgUser.id, orgA.id, orgRole.id);

  const adminToken = await createAccessToken({
    sub: admin.id, email: admin.email, roleId: partnerRole.id, orgId: null, partnerId: partner.id,
    scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const orgToken = await createAccessToken({
    sub: orgUser.id, email: orgUser.email, roleId: orgRole.id, orgId: orgA.id, partnerId: partner.id,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  return { partner, orgA, orgB, adminToken, orgToken };
}

/** A daily org-owned definition with NO recipients (no contacts, no emailRecipients). */
async function createOrgDefinition(app: Hono, token: string, orgId: string, name: string) {
  const res = await call(app, token, 'POST', '/reports', {
    orgId,
    name,
    type: 'device_inventory',
    schedule: 'daily',
    format: 'csv',
    config: { schedule: { time: '09:00' } },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; orgId: string };
}

async function runSchedule(reportId: string) {
  await withSystemDbAccessContext(() =>
    processRunScheduledReport(
      { type: 'run-scheduled-report', reportId, occurrenceKey: 202609010900 },
      { finalAttempt: true },
    ),
  );
}

async function runsOf(reportId: string) {
  return getTestDb()
    .select({
      id: reportRuns.id,
      status: reportRuns.status,
      deliveryStatus: reportRuns.deliveryStatus,
      recipientCount: reportRuns.recipientCount,
    })
    .from(reportRuns)
    .where(eq(reportRuns.reportId, reportId));
}

describe('scheduled delivery summary (multi-org series W01)', () => {
  runDb('the schedule worker records no_recipients and a zero customer count on a run nobody receives', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const def = await createOrgDefinition(app, f.adminToken, f.orgA.id, 'Acme nightly');

    await runSchedule(def.id);

    const rows = await runsOf(def.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'completed', deliveryStatus: 'no_recipients', recipientCount: 0 });
  });

  runDb('the delivery_status CHECK refuses a value outside the five statuses', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const def = await createOrgDefinition(app, f.adminToken, f.orgA.id, 'Acme nightly');
    await runSchedule(def.id);
    const [row] = await runsOf(def.id);

    let caught: unknown;
    try {
      await getTestDb()
        .update(reportRuns)
        .set({ deliveryStatus: 'delivered' as never })
        .where(eq(reportRuns.id, row!.id));
    } catch (error) {
      caught = error;
    }
    expect(pgCode(caught)).toBe('23514');
  });
});

type ListedDefinition = { id: string; orgId: string | null; orgName: string | null; lastDeliveryStatus: string | null };
type ListedRun = {
  id: string;
  reportId: string;
  orgId: string | null;
  orgName: string | null;
  deliveryStatus: string | null;
  recipientCount: number | null;
};

describe('org visibility on the report lists (multi-org series W01)', () => {
  runDb('a partner admin lists every org\'s definitions and runs with the owning org name and delivery summary', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const a = await createOrgDefinition(app, f.adminToken, f.orgA.id, 'Acme nightly');
    const b = await createOrgDefinition(app, f.adminToken, f.orgB.id, 'Bravo nightly');
    await runSchedule(a.id);
    // A manual run of B's scheduled definition: not_scheduled, and it never
    // becomes B's "latest scheduled delivery".
    expect((await call(app, f.adminToken, 'POST', `/reports/${b.id}/generate`)).status).toBe(200);

    const list = await call(app, f.adminToken, 'GET', '/reports?limit=100');
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { data: ListedDefinition[] }).data;
    expect(rows.find((r) => r.id === a.id)).toMatchObject({
      orgId: f.orgA.id,
      orgName: f.orgA.name,
      lastDeliveryStatus: 'no_recipients',
    });
    expect(rows.find((r) => r.id === b.id)).toMatchObject({
      orgId: f.orgB.id,
      orgName: f.orgB.name,
      lastDeliveryStatus: null,
    });

    const runsRes = await call(app, f.adminToken, 'GET', '/reports/runs?limit=100');
    expect(runsRes.status).toBe(200);
    const runs = ((await runsRes.json()) as { data: ListedRun[] }).data;
    expect(runs.find((r) => r.reportId === a.id)).toMatchObject({
      orgId: f.orgA.id,
      orgName: f.orgA.name,
      deliveryStatus: 'no_recipients',
      recipientCount: 0,
    });
    expect(runs.find((r) => r.reportId === b.id)).toMatchObject({
      orgId: f.orgB.id,
      orgName: f.orgB.name,
      deliveryStatus: 'not_scheduled',
      recipientCount: null,
    });
  });

  runDb('an org token lists only its own org\'s definitions and runs, named, never the sibling org', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const a = await createOrgDefinition(app, f.adminToken, f.orgA.id, 'Acme nightly');
    const b = await createOrgDefinition(app, f.adminToken, f.orgB.id, 'Bravo nightly');
    await runSchedule(a.id);
    await runSchedule(b.id);

    const list = await call(app, f.orgToken, 'GET', '/reports?limit=100');
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { data: ListedDefinition[] }).data;
    expect(rows.map((r) => r.id)).toContain(a.id);
    expect(rows.map((r) => r.id)).not.toContain(b.id);
    expect(rows.every((r) => r.orgId === f.orgA.id && r.orgName === f.orgA.name)).toBe(true);

    const runsRes = await call(app, f.orgToken, 'GET', '/reports/runs?limit=100');
    expect(runsRes.status).toBe(200);
    const runs = ((await runsRes.json()) as { data: ListedRun[] }).data;
    expect(runs.map((r) => r.reportId)).toContain(a.id);
    expect(runs.map((r) => r.reportId)).not.toContain(b.id);
    expect(JSON.stringify(runs)).not.toContain(f.orgB.name);
  });

  runDb('a partner-owned definition lists with orgName null (the Combined kind)', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const created = await call(app, f.adminToken, 'POST', '/reports', {
      ownerScope: 'partner',
      name: 'All-clients AR',
      type: 'ar_aging',
      schedule: 'monthly',
      format: 'csv',
    });
    expect(created.status).toBe(201);
    const partnerOwned = (await created.json()) as { id: string };

    const list = await call(app, f.adminToken, 'GET', '/reports?ownerScope=partner&limit=100');
    expect(list.status).toBe(200);
    const row = ((await list.json()) as { data: ListedDefinition[] }).data.find((r) => r.id === partnerOwned.id);
    expect(row).toMatchObject({ orgId: null, orgName: null, lastDeliveryStatus: null });
  });
});
