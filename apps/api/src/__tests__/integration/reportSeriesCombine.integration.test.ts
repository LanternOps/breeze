/**
 * Multi-org report series W04 — Combine on real Postgres, as the forced-RLS
 * breeze_app role (spec §3.8, §5 W04).
 *
 * Service half: findCombineCandidates / combineIntoSeries inside the same
 * partner-scope DB access context authMiddleware opens. Route half (Task 5):
 * the mounted routes with real access tokens.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { findDueReports } from '../../jobs/reportScheduleWorker';
import {
  contacts,
  partnerUsers,
  reportRuns,
  reportScheduleRecipients,
  reportSeries,
  reportSeriesOrgTargets,
  reports,
  serviceDeliverableEvidence,
  serviceDeliverableOccurrences,
  serviceDeliverables,
} from '../../db/schema';
import { authMiddleware, buildDbAccessContext } from '../../middleware/auth';
import { reportRoutes } from '../../routes/reports';
import { createAccessToken } from '../../services/jwt';
import { combineIntoSeries, findCombineCandidates, type CombineInput } from '../../services/reportSeries/combine';
import { siteScopeFingerprint } from '../../services/siteScope';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';
import { seedHoldingOrg } from './unassignedPoolFixtures';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const REPORT_PERMISSIONS = [
  { resource: 'reports', action: 'read' },
  { resource: 'reports', action: 'write' },
  { resource: 'reports', action: 'delete' },
  { resource: 'reports', action: 'export' },
];

/** What ReportBuilder persists for a legacy builder type. */
const BASE_CONFIG = {
  builderType: 'template',
  dataSource: 'alerts',
  columns: ['severity', 'title', 'createdAt'],
  filterConditions: [{ id: 'filter-a1', logic: 'and', field: 'severity', operator: 'is', value: 'critical' }],
  schedule: { time: '08:00', day: 'monday' },
  exportFormats: ['pdf'],
};
/** The same report built again elsewhere: new filter id, key order, spelling. */
const TWIN_CONFIG = {
  exportFormats: ['pdf'],
  schedule: { day: 'Monday', time: '8:00' },
  filterConditions: [{ value: 'critical', operator: 'is', field: 'severity', logic: 'and', id: 'filter-zz' }],
  columns: ['severity', 'title', 'createdAt'],
  dataSource: 'alerts',
  builderType: 'template',
};

async function seedFixture() {
  const partner = (await createPartner())!;
  const orgA = (await createOrganization({ partnerId: partner.id, name: 'Acme Dental' }))!;
  const orgB = (await createOrganization({ partnerId: partner.id, name: 'Bravo Law' }))!;
  const orgC = (await createOrganization({ partnerId: partner.id, name: 'Churned Co', status: 'suspended' }))!;
  const orgD = (await createOrganization({ partnerId: partner.id, name: 'Delta Clinic' }))!;
  const role = (await createRole({ scope: 'partner', partnerId: partner.id }))!;
  await grantRolePermissions(role.id, REPORT_PERMISSIONS);
  const admin = (await createUser({ partnerId: partner.id, orgId: null, email: `combine-admin-${randomUUID()}@example.com` }))!;
  await assignUserToPartner(admin.id, partner.id, role.id, 'all');
  const selected = (await createUser({ partnerId: partner.id, orgId: null, email: `combine-selected-${randomUUID()}@example.com` }))!;
  await assignUserToPartner(selected.id, partner.id, role.id, 'selected');
  await getTestDb().update(partnerUsers).set({ orgIds: [orgA.id, orgB.id] }).where(eq(partnerUsers.userId, selected.id));
  const siteB = (await createSite({ orgId: orgB.id }))!;
  return { partner, orgA, orgB, orgC, orgD, admin, selected, roleId: role.id, siteB };
}
type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function seedReport(orgId: string, userId: string, over: Partial<typeof reports.$inferInsert> = {}): Promise<string> {
  const [row] = await getTestDb().insert(reports).values({
    orgId,
    name: 'Weekly critical alerts',
    type: 'alert_summary',
    schedule: 'weekly',
    format: 'pdf',
    config: BASE_CONFIG,
    createdBy: userId,
    executionScopeVersion: 1,
    executionScopeKind: 'unrestricted',
    executionScopeSiteIds: null,
    executionScopeUserId: userId,
    executionScopePrincipalKind: 'user',
    executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId }),
    executionScopeCapturedAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  }).returning({ id: reports.id });
  return row!.id;
}

async function seedContact(orgId: string, email: string): Promise<string> {
  const [row] = await getTestDb().insert(contacts).values({ orgId, name: email.split('@')[0]!, email }).returning({ id: contacts.id });
  return row!.id;
}

async function addRecipient(reportId: string, orgId: string, contactId: string): Promise<void> {
  await getTestDb().insert(reportScheduleRecipients).values({ reportId, orgId, contactId });
}

async function seedRun(reportId: string): Promise<string> {
  const [row] = await getTestDb().insert(reportRuns).values({
    reportId, status: 'completed', startedAt: new Date('2026-09-15T08:00:00Z'), completedAt: new Date('2026-09-15T08:01:00Z'),
  }).returning({ id: reportRuns.id });
  return row!.id;
}

async function seedRunAt(reportId: string, status: 'completed' | 'failed', errorMessage: string | null, createdAt: string): Promise<void> {
  await getTestDb().insert(reportRuns).values({
    reportId, status, errorMessage, completedAt: new Date(createdAt), createdAt: new Date(createdAt),
  });
}

async function seedDeliverable(orgId: string, reportId: string, userId: string): Promise<string> {
  const [row] = await getTestDb().insert(serviceDeliverables).values({
    orgId, name: `Monthly alert review ${randomUUID().slice(0, 8)}`, cadence: 'monthly',
    anchorDueDate: '2026-09-30', effectiveFrom: '2026-09-01', autoEvidenceReportId: reportId, ownerUserId: userId,
  }).returning({ id: serviceDeliverables.id });
  return row!.id;
}

async function seedEvidence(orgId: string, deliverableId: string, reportId: string, runId: string): Promise<string> {
  const [occ] = await getTestDb().insert(serviceDeliverableOccurrences).values({
    orgId, deliverableId, nameSnapshot: 'Monthly alert review', periodStart: '2026-09-01', periodEnd: '2026-09-30',
    dueAt: '2026-09-30', originalDueAt: '2026-09-30', status: 'delivered',
  }).returning({ id: serviceDeliverableOccurrences.id });
  const [ev] = await getTestDb().insert(serviceDeliverableEvidence).values({
    orgId, occurrenceId: occ!.id, kind: 'report_run', reportId, reportRunId: runId,
  }).returning({ id: serviceDeliverableEvidence.id });
  return ev!.id;
}

/**
 * Acme Dental (A): rA1 (newest, linked by dA1, contact ann, CC cc+extra, 2 runs,
 * evidence) and rA2 (older duplicate, linked by dA2, contact bob, CC cc, 1 run,
 * evidence). Bravo Law (B): rB1 (twin config, CC upper-case, contact cara, 1 run)
 * plus a portal row, a site-restricted row and a site-filtered row that must
 * never be touched. Churned Co (C, suspended): a matching row. One-time row in A.
 */
async function seedGroup(f: Fixture) {
  const u = f.admin.id;
  const rA1 = await seedReport(f.orgA.id, u, {
    config: { ...BASE_CONFIG, emailRecipients: ['cc@msp.test', 'extra@msp.test'] },
    lastGeneratedAt: new Date('2026-09-20T08:00:00Z'),
  });
  const rA2 = await seedReport(f.orgA.id, u, {
    name: 'Weekly critical alerts (old)',
    config: { ...BASE_CONFIG, emailRecipients: ['cc@msp.test'] },
    lastGeneratedAt: new Date('2026-09-01T08:00:00Z'),
  });
  const rB1 = await seedReport(f.orgB.id, u, { config: { ...TWIN_CONFIG, emailRecipients: ['CC@msp.test'] } });
  const rC1 = await seedReport(f.orgC.id, u);
  const rPortal = await seedReport(f.orgB.id, u, { portalSelfService: true });
  const rRestricted = await seedReport(f.orgB.id, u, {
    executionScopeKind: 'restricted',
    executionScopeSiteIds: [f.siteB.id],
    executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'restricted', orgId: f.orgB.id, siteIds: [f.siteB.id] }),
  });
  const rSites = await seedReport(f.orgA.id, u, { config: { ...BASE_CONFIG, filters: { siteIds: [randomUUID()] } } });
  const rOneTime = await seedReport(f.orgA.id, u, { schedule: 'one_time' });

  const ann = await seedContact(f.orgA.id, 'ann@acme.test');
  const bob = await seedContact(f.orgA.id, 'bob@acme.test');
  const cara = await seedContact(f.orgB.id, 'cara@bravo.test');
  await addRecipient(rA1, f.orgA.id, ann);
  await addRecipient(rA2, f.orgA.id, bob);
  await addRecipient(rB1, f.orgB.id, cara);

  const runA1a = await seedRun(rA1);
  await seedRun(rA1);
  const runA2 = await seedRun(rA2);
  await seedRun(rB1);
  const dA1 = await seedDeliverable(f.orgA.id, rA1, u);
  const dA2 = await seedDeliverable(f.orgA.id, rA2, u);
  const evA1 = await seedEvidence(f.orgA.id, dA1, rA1, runA1a);
  const evA2 = await seedEvidence(f.orgA.id, dA2, rA2, runA2);

  return { rA1, rA2, rB1, rC1, rPortal, rRestricted, rSites, rOneTime, ann, bob, cara, dA1, dA2, evA1, evA2, runA2 };
}

function asAdmin<T>(f: Fixture, fn: (tx: Tx) => Promise<T>, extraOrgIds: string[] = []): Promise<T> {
  const context = buildDbAccessContext({
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [f.orgA.id, f.orgB.id, f.orgD.id, ...extraOrgIds],
    partnerId: f.partner.id,
    userId: f.admin.id,
  });
  return withDbAccessContext(context, () => db.transaction((tx) => fn(tx)));
}

const adminAuth = (f: Fixture) => ({
  scope: 'partner' as const,
  partnerId: f.partner.id,
  partnerOrgAccess: 'all' as const,
  user: { id: f.admin.id },
});

async function candidatesFor(f: Fixture) {
  return asAdmin(f, (tx) => findCombineCandidates(f.partner.id, tx));
}

async function inputFor(f: Fixture, over: Partial<CombineInput> = {}): Promise<CombineInput> {
  const [group] = await candidatesFor(f);
  return {
    groupKey: group!.groupKey,
    reportIds: group!.orgs.flatMap((o) => o.rows.map((r) => r.reportId)),
    name: 'Weekly critical alerts',
    targetMode: 'selected',
    ccResolution: { include: [], drop: ['extra@msp.test'] },
    callerMaySetEmailRecipients: false,
    ...over,
  };
}

const reportRow = async (id: string) =>
  (await getTestDb().select().from(reports).where(eq(reports.id, id)))[0]!;
const seriesOf = (partnerId: string) =>
  getTestDb().select().from(reportSeries).where(eq(reportSeries.partnerId, partnerId));

describe('Combine service on real Postgres (series W04)', () => {
  runDb('lists exactly one group: twins across A and B, excluded rows absent, CC split', async () => {
    const f = await seedFixture();
    const s = await seedGroup(f);
    const groups = await candidatesFor(f);

    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group!.orgs.map((o) => o.orgName)).toEqual(['Acme Dental', 'Bravo Law']);
    expect(group!.orgs[0]!.rows.map((r) => [r.reportId, r.action])).toEqual([[s.rA1, 'adopt'], [s.rA2, 'archive']]);
    expect(group!.orgs[1]!.rows.map((r) => [r.reportId, r.action])).toEqual([[s.rB1, 'adopt']]);
    expect(group!.orgs[0]!.rows[0]).toMatchObject({ deliverableLinked: true });
    expect(group!.orgs[0]!.rows[0]!.contactRecipients.map((c) => c.contactId)).toEqual([s.ann]);
    expect(group!.sharedCc).toEqual(['cc@msp.test']);
    expect(group!.conflictingCc).toEqual([{ email: 'extra@msp.test', reportIds: [s.rA1] }]);
    const listed = group!.orgs.flatMap((o) => o.rows.map((r) => r.reportId));
    for (const excluded of [s.rC1, s.rPortal, s.rRestricted, s.rSites, s.rOneTime]) {
      expect(listed).not.toContain(excluded);
    }
  });

  runDb('combines in place: ids, runs, evidence and recipients survive; duplicate archived; deliverable repointed', async () => {
    const f = await seedFixture();
    const s = await seedGroup(f);
    const runsBefore = await getTestDb().select().from(reportRuns).where(inArray(reportRuns.reportId, [s.rA1, s.rA2, s.rB1]));
    const evidenceBefore = await getTestDb().select().from(serviceDeliverableEvidence).where(inArray(serviceDeliverableEvidence.id, [s.evA1, s.evA2]));

    const result = await asAdmin(f, async (tx) => combineIntoSeries(await inputFor(f), adminAuth(f), tx));

    const [series] = await seriesOf(f.partner.id);
    expect(series).toMatchObject({
      id: result.seriesId, targetMode: 'selected', internalCc: ['cc@msp.test'],
      recipientRule: { primaryContact: false, roles: [] }, ownerUserId: f.admin.id,
      type: 'alert_summary', schedule: 'weekly', format: 'pdf',
    });
    expect((series!.config as Record<string, unknown>).emailRecipients).toBeUndefined();
    const targets = await getTestDb().select().from(reportSeriesOrgTargets).where(eq(reportSeriesOrgTargets.seriesId, result.seriesId));
    expect(targets.map((t) => t.orgId).sort()).toEqual([f.orgA.id, f.orgB.id].sort());

    for (const id of [s.rA1, s.rB1]) {
      const adopted = await reportRow(id);
      expect(adopted).toMatchObject({ seriesId: result.seriesId, seriesRevision: 1, archivedAt: null });
      expect(adopted.executionScopeUserId).toBe(f.admin.id);
      expect(adopted.executionScopeKind).toBe('unrestricted');
      expect((adopted.config as Record<string, unknown>).emailRecipients).toEqual(['cc@msp.test']);
    }
    const archived = await reportRow(s.rA2);
    expect(archived.seriesId).toBeNull();
    expect(archived.archivedAt).not.toBeNull();
    expect(result.adopted.map((a) => a.reportId).sort()).toEqual([s.rA1, s.rB1].sort());
    expect(result.archived).toEqual([{ reportId: s.rA2, orgId: f.orgA.id }]);

    // Runs and evidence untouched, row for row.
    const runsAfter = await getTestDb().select().from(reportRuns).where(inArray(reportRuns.reportId, [s.rA1, s.rA2, s.rB1]));
    expect(runsAfter.map((r) => [r.id, r.reportId]).sort()).toEqual(runsBefore.map((r) => [r.id, r.reportId]).sort());
    const evidenceAfter = await getTestDb().select().from(serviceDeliverableEvidence).where(inArray(serviceDeliverableEvidence.id, [s.evA1, s.evA2]));
    expect(evidenceAfter.map((e) => [e.id, e.reportId, e.reportRunId]).sort())
      .toEqual(evidenceBefore.map((e) => [e.id, e.reportId, e.reportRunId]).sort());

    // Review Focus #4: the archived duplicate's deliverable now feeds from the adopted row.
    const [dA2] = await getTestDb().select().from(serviceDeliverables).where(eq(serviceDeliverables.id, s.dA2));
    expect(dA2!.autoEvidenceReportId).toBe(s.rA1);
    expect(result.repointedDeliverableIds).toEqual([s.dA2]);

    // Recipients: each org keeps its contacts (A gains the archived duplicate's), all 'add'.
    const recipients = await getTestDb().select().from(reportScheduleRecipients)
      .where(inArray(reportScheduleRecipients.reportId, [s.rA1, s.rB1]));
    expect(recipients.filter((r) => r.reportId === s.rA1).map((r) => r.contactId).sort()).toEqual([s.ann, s.bob].sort());
    expect(recipients.filter((r) => r.reportId === s.rB1).map((r) => r.contactId)).toEqual([s.cara]);
    expect(new Set(recipients.map((r) => r.mode))).toEqual(new Set(['add']));

    // Review Focus #2 and the rest of the exclusion list: untouched.
    for (const id of [s.rC1, s.rPortal, s.rRestricted, s.rSites, s.rOneTime]) {
      expect(await reportRow(id)).toMatchObject({ seriesId: null, archivedAt: null });
    }
    // 'selected' mode sends nothing new: no child in Delta Clinic.
    const deltaChildren = await getTestDb().select().from(reports)
      .where(and(eq(reports.orgId, f.orgD.id), isNotNull(reports.seriesId)));
    expect(deltaChildren).toHaveLength(0);
  });

  runDb("'all' mode: no target rows, the new org gets a child with no customer recipients", async () => {
    const f = await seedFixture();
    await seedGroup(f);
    const result = await asAdmin(f, async (tx) => combineIntoSeries(
      await inputFor(f, { targetMode: 'all', ccResolution: { include: ['extra@msp.test'], drop: [] }, callerMaySetEmailRecipients: true }),
      adminAuth(f), tx,
    ));
    const [series] = await seriesOf(f.partner.id);
    expect(series!.internalCc).toEqual(['cc@msp.test', 'extra@msp.test']);
    expect(await getTestDb().select().from(reportSeriesOrgTargets).where(eq(reportSeriesOrgTargets.seriesId, result.seriesId))).toEqual([]);
    const [delta] = await getTestDb().select().from(reports)
      .where(and(eq(reports.orgId, f.orgD.id), eq(reports.seriesId, result.seriesId)));
    expect(delta).toBeDefined();
    expect(await getTestDb().select().from(reportScheduleRecipients).where(eq(reportScheduleRecipients.reportId, delta!.id))).toEqual([]);
    // The suspended org is never targeted.
    expect(await getTestDb().select().from(reports)
      .where(and(eq(reports.orgId, f.orgC.id), eq(reports.seriesId, result.seriesId)))).toEqual([]);
  });

  runDb('an unresolved CC address blocks the combine and writes nothing', async () => {
    const f = await seedFixture();
    const s = await seedGroup(f);
    const input = await inputFor(f, { ccResolution: { include: [], drop: [] } });
    await expect(asAdmin(f, (tx) => combineIntoSeries(input, adminAuth(f), tx))).rejects.toMatchObject({
      code: 'combine_cc_conflict',
      status: 409,
      body: { error: 'combine_cc_conflict', shared: ['cc@msp.test'], unresolved: [{ email: 'extra@msp.test', reportIds: [s.rA1] }], unexpected: [] },
    });
    expect(await seriesOf(f.partner.id)).toEqual([]);
    expect((await reportRow(s.rA1)).seriesId).toBeNull();
  });

  runDb('a combine that adds a delivery needs export + MFA', async () => {
    const f = await seedFixture();
    await seedGroup(f);
    const input = await inputFor(f, { ccResolution: { include: ['extra@msp.test'], drop: [] }, callerMaySetEmailRecipients: false });
    await expect(asAdmin(f, (tx) => combineIntoSeries(input, adminAuth(f), tx)))
      .rejects.toMatchObject({ code: 'recipients_need_export_and_mfa', status: 403 });
    expect(await seriesOf(f.partner.id)).toEqual([]);
  });

  // Review Focus #5.
  runDb('the second combine of the same group gets 409 combine_group_changed and writes nothing', async () => {
    const f = await seedFixture();
    await seedGroup(f);
    const input = await inputFor(f);
    await asAdmin(f, (tx) => combineIntoSeries(input, adminAuth(f), tx));
    await expect(asAdmin(f, (tx) => combineIntoSeries(input, adminAuth(f), tx)))
      .rejects.toMatchObject({ code: 'combine_group_changed', status: 409 });
    expect(await seriesOf(f.partner.id)).toHaveLength(1);
    expect(await candidatesFor(f)).toEqual([]);
  });

  // W04 final review F7. The auth middleware grants every partner user the
  // partner's Quick Support org, so RLS alone does not hide its rows; the
  // holding org is added to the context too, so only the service's own
  // eligibility rule can leave either out.
  runDb('a report in the holding org or a Quick Support org is never a Combine candidate', async () => {
    const f = await seedFixture();
    const s = await seedGroup(f);
    const holding = await seedHoldingOrg(f.partner.id);
    const quickSupport = (await createOrganization({ partnerId: f.partner.id, name: 'Quick Support', type: 'quick_support' }))!;
    const rHolding = await seedReport(holding.orgId, f.admin.id);
    const rQuickSupport = await seedReport(quickSupport.id, f.admin.id);

    const groups = await asAdmin(f, (tx) => findCombineCandidates(f.partner.id, tx), [holding.orgId, quickSupport.id]);
    expect(groups).toHaveLength(1);
    const listed = groups[0]!.orgs.flatMap((o) => o.rows.map((r) => r.reportId));
    expect(listed.sort()).toEqual([s.rA1, s.rA2, s.rB1].sort());
    expect(listed).not.toContain(rHolding);
    expect(listed).not.toContain(rQuickSupport);
  });

  runDb('a selected-access partner user is refused by the service belt', async () => {
    const f = await seedFixture();
    await seedGroup(f);
    const input = await inputFor(f);
    await expect(asAdmin(f, (tx) => combineIntoSeries(input, { ...adminAuth(f), partnerOrgAccess: 'selected' }, tx)))
      .rejects.toThrow(/org access/i);
    expect(await seriesOf(f.partner.id)).toEqual([]);
  });
});

/**
 * W04 final review F1 — Combine never makes anything new send in 'selected'
 * mode, and never a second copy of an occurrence already sent.
 * A1: stalled (its technician owner lost access, so its latest run is a
 * worker scope denial and its lastGeneratedAt is months old), and
 * deliverable-linked, so it is the Acme row adopted. A2: its live same-org
 * duplicate, which already sent the current occurrence. B1: Bravo's twin,
 * denied once and then run again (so NOT stalled today).
 */
async function seedCombineDay(f: Fixture) {
  const tech = (await createUser({ partnerId: f.partner.id, orgId: null, email: `combine-tech-${randomUUID()}@example.com` }))!;
  const sentAt = new Date();
  const rA1 = await seedReport(f.orgA.id, tech.id, { lastGeneratedAt: new Date('2026-01-05T08:00:00Z') });
  const rA2 = await seedReport(f.orgA.id, f.admin.id, { name: 'Weekly critical alerts (copy)', lastGeneratedAt: sentAt });
  const rB1 = await seedReport(f.orgB.id, f.admin.id, { lastGeneratedAt: sentAt });
  await seedDeliverable(f.orgA.id, rA1, f.admin.id);
  await seedRunAt(rA1, 'completed', null, '2026-01-05T08:00:01Z');
  await seedRunAt(rA1, 'failed', 'scope_membership_removed', '2026-09-21T08:00:01Z');
  await seedRunAt(rA2, 'completed', null, '2026-09-21T08:00:02Z');
  await seedRunAt(rB1, 'failed', 'scope_permission_removed', '2026-09-14T08:00:01Z');
  await seedRunAt(rB1, 'completed', null, '2026-09-21T08:00:03Z');
  return { tech, sentAt, rA1, rA2, rB1 };
}

const dueIds = async (ids: readonly string[]) =>
  (await withSystemDbAccessContext(() => findDueReports(new Date())))
    .map((due) => due.id)
    .filter((id) => ids.includes(id));

describe('Combine on the day of an occurrence (W04 final review F1)', () => {
  runDb('flags a row whose latest run is a scope denial as stalled, and only that row', async () => {
    const f = await seedFixture();
    const d = await seedCombineDay(f);
    const [group] = await candidatesFor(f);
    const rows = new Map(group!.orgs.flatMap((o) => o.rows.map((r) => [r.reportId, r] as const)));
    expect([...rows.keys()].sort()).toEqual([d.rA1, d.rA2, d.rB1].sort());
    expect(rows.get(d.rA1)).toMatchObject({ action: 'adopt', deliverableLinked: true, stalled: true });
    expect(rows.get(d.rA2)).toMatchObject({ action: 'archive', stalled: false });
    expect(rows.get(d.rB1)).toMatchObject({ action: 'adopt', stalled: false });
  });

  runDb("an adopted stalled row carries its duplicate's lastGeneratedAt and is not due again", async () => {
    const f = await seedFixture();
    const d = await seedCombineDay(f);
    // Control: the stalled row is polled and overdue before the combine (the
    // worker then denies it); A2 and B1 already sent this occurrence.
    expect(await dueIds([d.rA1, d.rA2, d.rB1])).toEqual([d.rA1]);

    const result = await asAdmin(f, async (tx) => combineIntoSeries(
      await inputFor(f, { ccResolution: { include: [], drop: [] } }), adminAuth(f), tx,
    ));
    expect(result.adopted.map((a) => a.reportId).sort()).toEqual([d.rA1, d.rB1].sort());
    expect(result.archived).toEqual([{ reportId: d.rA2, orgId: f.orgA.id }]);

    const adopted = await reportRow(d.rA1);
    expect(adopted.seriesId).toBe(result.seriesId);
    expect(adopted.executionScopeUserId).toBe(f.admin.id);
    expect(adopted.lastGeneratedAt?.getTime()).toBe((await reportRow(d.rA2)).lastGeneratedAt?.getTime());
    // Never lowered: B1's own value is untouched.
    expect((await reportRow(d.rB1)).lastGeneratedAt?.getTime()).toBe((await reportRow(d.rA2)).lastGeneratedAt?.getTime());
    expect(await dueIds([d.rA1, d.rA2, d.rB1])).toEqual([]);
  });
});

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/reports', reportRoutes);
  return app;
}

async function tokenFor(user: { id: string; email: string }, roleId: string, partnerId: string) {
  return createAccessToken({
    sub: user.id, email: user.email, roleId, orgId: null, partnerId, scope: 'partner',
    mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

describe('Combine routes on real Postgres (series W04)', () => {
  runDb('GET combine-candidates resolves before /:id and lists the group; POST combines it', async () => {
    const f = await seedFixture();
    const s = await seedGroup(f);
    const app = buildApp();
    const auth = { Authorization: `Bearer ${await tokenFor(f.admin, f.roleId, f.partner.id)}` };

    const listed = await app.request('/reports/series/combine-candidates', { headers: auth });
    expect(listed.status).toBe(200);
    const { data } = await listed.json() as { data: { groupKey: string; orgs: { rows: { reportId: string }[] }[] }[] };
    expect(data).toHaveLength(1);

    const res = await app.request('/reports/series/combine', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupKey: data[0]!.groupKey,
        reportIds: data[0]!.orgs.flatMap((o) => o.rows.map((r) => r.reportId)),
        name: 'Weekly critical alerts',
        ccResolution: { include: [], drop: ['extra@msp.test'] },
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { seriesId: string };
    expect((await reportRow(s.rA1)).seriesId).toBe(created.seriesId);

    const after = await app.request('/reports/series/combine-candidates', { headers: auth });
    expect((await after.json() as { data: unknown[] }).data).toEqual([]);
  });

  runDb("a 'selected' partner user gets 403 on both routes", async () => {
    const f = await seedFixture();
    await seedGroup(f);
    const app = buildApp();
    const auth = { Authorization: `Bearer ${await tokenFor(f.selected, f.roleId, f.partner.id)}` };
    expect((await app.request('/reports/series/combine-candidates', { headers: auth })).status).toBe(403);
    const res = await app.request('/reports/series/combine', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupKey: 'a'.repeat(64), reportIds: [randomUUID(), randomUUID()], name: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(await seriesOf(f.partner.id)).toEqual([]);
  });
});
