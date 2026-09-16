/**
 * Threat Detection Review evidence, end to end on real Postgres (#5784 W02,
 * #5812 / #5814).
 *
 * W01's `managedEvidenceFoundations.integration.test.ts` proved the machinery
 * with a stand-in type (`device_inventory`, via `vi.mock`). THIS suite proves
 * the same path with the wave's REAL registry entry and no registry mock at
 * all, plus the three things that are specific to this report type and cannot
 * be established by any unit test:
 *
 *  1. a partner-wide template applied to two orgs produces one artifact per
 *     org, against that org's own definition, with nothing wired by hand;
 *  2. an org whose partner has NO active Huntress integration still gets an
 *     artifact, and its incident counts are NULL rather than 0 — if this case
 *     ever reads 0, the feature is shipping a lie and must not merge;
 *  3. the occurrence's period — not `now()` — is what the artifact reports on;
 *  4. OD-12: the run is invisible until delivery, and the server-side
 *     `renderRunPdf` path reaches the new `buildReportPdf` arm (the rendered
 *     bytes contain the coverage sentence) rather than falling silently
 *     through to `renderGenericReport`.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  devices, huntressAgents, huntressIncidents, huntressIntegrations, portalBranding,
  reportRuns, reports, serviceDeliverableEvidence, serviceDeliverableOccurrences,
  serviceDeliverables,
} from '../../db/schema';
import {
  assignUserToPartner, createOrganization, createPartner, createRole, createSite, createUser,
  grantRolePermissions,
} from './db-utils';
import { runDeliverableSweep } from '../../jobs/deliverableWorker';
import { applyTemplateSet, createTemplateSet, type TemplateActor } from '../../services/deliverableTemplateService';
import { deliverOccurrence } from '../../services/serviceDeliverableService';
import { listPortalRuns, renderRunPdf } from '../../services/portal/reportsSelfService';
import { generateThreatDetectionReport } from '../../services/threatDetectionReport';
import { siteScopeFingerprint } from '../../services/siteScope';
import type { ThreatDetectionSummary } from '@breeze/shared';

// publishEvent writes to a Redis stream — spy on it (deliverableSweep precedent).
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'test-event-id') };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MANAGED_TYPE = 'threat_detection_review' as const;
const DUE = '2026-10-31';
const AS_OF = new Date('2026-10-31T05:18:00Z');
const system = <T>(fn: () => Promise<T>, label = 'threatDetectionEvidence.integration') =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

interface Tenant { partnerId: string; orgId: string; otherOrgId: string; techId: string }

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const other = await createOrganization({ partnerId: partner.id });
  const role = (await createRole({ scope: 'partner', partnerId: partner.id }))!;
  await grantRolePermissions(role.id, [
    { resource: 'reports', action: 'read' }, { resource: 'reports', action: 'write' },
    { resource: 'contracts', action: 'read' }, { resource: 'contracts', action: 'write' },
  ]);
  const tech = (await createUser({
    partnerId: partner.id, orgId: null, email: `tech-${randomUUID()}@example.com`, name: 'Tess Tech',
  }))!;
  await assignUserToPartner(tech.id, partner.id, role.id, 'all');
  return { partnerId: partner.id, orgId: org.id, otherOrgId: other.id, techId: tech.id };
}

const actorFor = (t: Tenant): TemplateActor => ({
  userId: t.techId, scope: 'partner', partnerId: t.partnerId, partnerOrgAccess: 'all',
  accessibleOrgIds: [t.orgId, t.otherOrgId],
});

async function seedIntegration(partnerId: string, lastSyncAt: Date | null): Promise<string> {
  const [row] = await getTestDb().insert(huntressIntegrations).values({
    partnerId, name: 'Huntress', apiKeyEncrypted: 'enc', isActive: true,
    lastSyncAt, lastSyncStatus: lastSyncAt ? 'ok' : null,
  }).returning({ id: huntressIntegrations.id });
  return row!.id;
}

async function seedDevice(orgId: string, hostname: string): Promise<string> {
  const site = await createSite({ orgId });
  const [row] = await getTestDb().insert(devices).values({
    orgId, siteId: site!.id, agentId: `td-${randomUUID()}`, hostname,
    osType: 'windows', osVersion: 'Windows 11 Pro', architecture: 'amd64',
    agentVersion: '0.113.0', status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedIncident(
  orgId: string, integrationId: string, deviceId: string | null,
  over: Partial<typeof huntressIncidents.$inferInsert> = {},
): Promise<void> {
  await getTestDb().insert(huntressIncidents).values({
    orgId, integrationId, deviceId,
    huntressIncidentId: `hi-${randomUUID().slice(0, 12)}`,
    severity: 'high', category: 'malware', title: 'Suspicious process',
    recommendation: 'Isolate the host and reimage.',
    // The raw payload the artifact must never print.
    details: { secret: 'do-not-render' },
    status: 'open', reportedAt: new Date('2026-10-12T00:00:00Z'), resolvedAt: null,
    ...over,
  });
}

const occurrencesOf = (deliverableId: string) => getTestDb().select().from(serviceDeliverableOccurrences)
  .where(eq(serviceDeliverableOccurrences.deliverableId, deliverableId)).orderBy(serviceDeliverableOccurrences.dueAt);
const evidenceOf = (occurrenceId: string) => getTestDb().select().from(serviceDeliverableEvidence)
  .where(eq(serviceDeliverableEvidence.occurrenceId, occurrenceId));
const runsOf = (reportId: string) => getTestDb().select().from(reportRuns).where(eq(reportRuns.reportId, reportId));
const managedDefinitionsOf = (orgId: string) => getTestDb().select().from(reports)
  .where(and(eq(reports.orgId, orgId), eq(reports.type, MANAGED_TYPE), eq(reports.portalSelfService, true)));

async function applyMonthlyTemplate(t: Tenant, orgIds: string[]): Promise<void> {
  const actor = actorFor(t);
  const set = await system(() => createTemplateSet({
    ownerScope: 'partner', name: `Managed detection plan ${randomUUID().slice(0, 8)}`,
    items: [{
      name: 'Monthly threat detection review', cadence: 'monthly', leadDays: 7, graceDays: 14,
      artifactRequired: true, completionMode: 'explicit', sortOrder: 0,
      autoEvidenceReportType: MANAGED_TYPE,
    }],
  }, actor));
  // W02 is the first wave to put a REAL value in this column — the shared
  // validator's tuple is no longer empty, so no `as never` cast is needed.
  expect(set.items[0]!.autoEvidenceReportType).toBe(MANAGED_TYPE);
  for (const orgId of orgIds) {
    const applied = await system(() => applyTemplateSet(orgId, set.id, { effectiveFrom: '2026-10-01' }, actor));
    expect(applied.created).toHaveLength(1);
  }
}

function summaryOfRun(row: { result: unknown }): ThreatDetectionSummary {
  return (row.result as { summary: ThreatDetectionSummary }).summary;
}

describe('threat detection review evidence on real Postgres (#5784 W02)', () => {
  runDb('1. a partner-wide template produces one artifact per org, against that org’s own definition', async () => {
    const t = await seedTenant();
    const integrationId = await seedIntegration(t.partnerId, new Date('2026-10-31T05:00:00Z'));
    for (const orgId of [t.orgId, t.otherOrgId]) {
      const deviceId = await seedDevice(orgId, `host-${orgId.slice(0, 8)}`);
      await getTestDb().insert(huntressAgents).values({
        orgId, integrationId, huntressAgentId: `ha-${randomUUID().slice(0, 12)}`,
        deviceId, hostname: 'host', status: 'online',
      });
      await seedIncident(orgId, integrationId, deviceId);
    }

    await applyMonthlyTemplate(t, [t.orgId, t.otherOrgId]);
    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ autoEvidence: 2, failed: 0 });

    const runIds = new Set<string>();
    const reportIds = new Set<string>();
    for (const orgId of [t.orgId, t.otherOrgId]) {
      const managed = await managedDefinitionsOf(orgId);
      expect(managed).toHaveLength(1);
      expect(managed[0]!.name).toBe('Service evidence — Threat detection review');
      const runs = await runsOf(managed[0]!.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: 'completed', requestedByKind: 'system', requestedByUserId: null,
        executionScopePrincipalKind: 'system', executionScopeKind: 'unrestricted',
      });
      runIds.add(runs[0]!.id);
      reportIds.add(managed[0]!.id);

      const summary = summaryOfRun(runs[0]!);
      expect(summary.incidents?.opened).toBe(1);
      expect(summary.agentCoverage?.huntressAgents).toBe(1);
      // The raw details jsonb never reaches the artifact.
      expect(JSON.stringify(runs[0]!.result)).not.toContain('do-not-render');

      const [d] = await getTestDb().select().from(serviceDeliverables).where(eq(serviceDeliverables.orgId, orgId));
      const [occ] = await occurrencesOf(d!.id);
      const ev = await evidenceOf(occ!.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ kind: 'report_run', reportId: managed[0]!.id, reportRunId: runs[0]!.id });
    }
    // Two orgs, two definitions, two runs — never one shared row.
    expect(runIds.size).toBe(2);
    expect(reportIds.size).toBe(2);
  });

  runDb('2. no Huntress integration produces a data-gap artifact, NOT zeros', async () => {
    // A partner with no integration at all — the exact case a "0 incidents"
    // report would misrepresent as a clean month.
    const t = await seedTenant();
    await seedDevice(t.orgId, 'unmonitored-1');
    await applyMonthlyTemplate(t, [t.orgId]);
    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ autoEvidence: 1, failed: 0 });

    const [managed] = await managedDefinitionsOf(t.orgId);
    const [run] = await runsOf(managed!.id);
    expect(run!.status).toBe('completed');
    const summary = summaryOfRun(run!);

    // THE assertion that stops this feature shipping a lie. If it reads 0, stop.
    expect(summary.incidents?.opened).toBeNull();
    expect(summary.incidents?.resolved).toBeNull();
    expect(summary.agentCoverage?.huntressAgents).toBeNull();
    expect(summary.coverage?.sourceStatus).toBe('not_connected');
    expect(summary.dataGaps?.length).toBeGreaterThan(0);
    expect(summary.dataGaps!.join(' ')).toMatch(/not connected/i);
    expect(summary.dataGaps!.join(' ')).not.toMatch(/\bno incidents\b/i);
    // Breeze's own fleet count IS measured, so the reader learns the size of
    // the unmonitored fleet rather than being shown nothing.
    expect(summary.agentCoverage?.breezeDevices).toBe(1);
  });

  runDb('3. the coverage window is the occurrence period, not now()', async () => {
    const t = await seedTenant();
    const integrationId = await seedIntegration(t.partnerId, new Date('2026-10-31T05:00:00Z'));
    const deviceId = await seedDevice(t.orgId, 'host-3');
    // Inside the period.
    await seedIncident(t.orgId, integrationId, deviceId, { reportedAt: new Date('2026-10-12T00:00:00Z') });
    // Outside it — proves the window is bound, not ignored.
    await seedIncident(t.orgId, integrationId, deviceId, { reportedAt: new Date('2026-09-02T00:00:00Z') });

    await applyMonthlyTemplate(t, [t.orgId]);
    await runDeliverableSweep(AS_OF);

    const [managed] = await managedDefinitionsOf(t.orgId);
    const [run] = await runsOf(managed!.id);
    const summary = summaryOfRun(run!);
    const [d] = await getTestDb().select().from(serviceDeliverables).where(eq(serviceDeliverables.orgId, t.orgId));
    const [occ] = await occurrencesOf(d!.id);

    expect(summary.coverage?.periodStart).toBe(occ!.periodStart);
    expect(summary.coverage?.periodEnd).toBe(occ!.periodEnd);
    // Generation happens ON the due day, so it precedes the end of the period.
    expect(Date.parse(summary.coverage!.generatedAt!))
      .toBeLessThan(Date.parse(`${occ!.periodEnd}T23:59:59.999Z`));
    // Only the in-period incident is counted, and the earliest held row is
    // disclosed as the start of what the data actually covers.
    expect(summary.incidents?.opened).toBe(1);
    expect(summary.coverage?.coveredFrom?.slice(0, 10)).toBe('2026-09-02');
    // The held data starts BEFORE the period and the last sync is after its
    // end, so there is genuinely no shortfall to print — an empty note is the
    // correct output here, not a missing one.
    expect(summary.coverage?.note).toBe('');
    expect(summary.dataGaps).toEqual([]);
    expect(summary.coverage?.sourceStatus).toBe('ok');
  });

  // The bug this case exists for: the site predicate is evaluated against a
  // LEFT JOIN, so an incident with `device_id IS NULL` yields
  // `devices.site_id = NULL`, `NULL IN (...)` is UNKNOWN, and POSTGRES drops
  // the row before Node ever sees it. Counting the excluded rows by filtering
  // the query's own result set therefore reports 0 forever and the disclosure
  // never prints — a silent drop, which is the one thing this report type may
  // not do. Only a real database shows this; the chainable db mock cannot.
  runDb('5. an unattributable incident is excluded under a site scope AND the count is disclosed', async () => {
    const t = await seedTenant();
    const integrationId = await seedIntegration(t.partnerId, new Date('2026-10-31T05:00:00Z'));
    const deviceId = await seedDevice(t.orgId, 'host-5');
    const [device] = await getTestDb().select({ siteId: devices.siteId })
      .from(devices).where(eq(devices.id, deviceId));
    const siteId = device!.siteId as string;

    await seedIncident(t.orgId, integrationId, deviceId);
    // Two incidents Huntress could not attribute to a device.
    await seedIncident(t.orgId, integrationId, null);
    await seedIncident(t.orgId, integrationId, null);

    const scope = { version: 1 as const, kind: 'restricted' as const, orgId: t.orgId, siteIds: [siteId] };
    const authority = {
      principalKind: 'user' as const,
      principalUserId: t.techId,
      scope,
      capturedAt: new Date('2026-10-31T05:18:00Z'),
      fingerprint: siteScopeFingerprint(scope),
    };

    const res = await system(() => generateThreatDetectionReport(
      t.orgId, {}, authority,
      {
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        generatedAt: '2026-10-31T05:18:00.000Z',
        deliverableId: randomUUID(),
      },
    ));
    const summary = res.summary as unknown as ThreatDetectionSummary;

    // Only the attributable incident is counted and listed...
    expect(summary.incidents?.opened).toBe(1);
    expect(res.rowCount).toBe(1);
    // ...and the two the database silently dropped are DISCLOSED, in the
    // artifact's own words, not merely absent.
    expect(summary.coverage?.unattributableExcluded).toBe(2);
    expect(summary.dataGaps?.join(' ')).toMatch(/could not be attributed/i);
    expect(summary.dataGaps?.join(' ')).toMatch(/2/);
  });

  runDb('4. OD-12: invisible until delivered, then rendered through the threat detection PDF arm', async () => {
    const t = await seedTenant();
    await getTestDb().insert(portalBranding).values({ orgId: t.orgId, enableReports: true, enableService: true });
    const integrationId = await seedIntegration(t.partnerId, new Date('2026-10-31T05:00:00Z'));
    const deviceId = await seedDevice(t.orgId, 'host-4');
    await seedIncident(t.orgId, integrationId, deviceId);

    await applyMonthlyTemplate(t, [t.orgId]);
    await runDeliverableSweep(AS_OF);

    const [managed] = await managedDefinitionsOf(t.orgId);
    const [run] = await runsOf(managed!.id);
    const [d] = await getTestDb().select().from(serviceDeliverables).where(eq(serviceDeliverables.orgId, t.orgId));
    const [occ] = await occurrencesOf(d!.id);
    expect(run!.status).toBe('completed');

    // Completed and portal_self_service — and still not the customer's to see.
    const before = await system(() => listPortalRuns(t.orgId, 'UTC', { page: 1, limit: 50 }));
    expect(before.data.map((r) => r.id)).not.toContain(run!.id);
    await expect(system(() => renderRunPdf(run!.id, t.orgId, 'UTC'))).rejects.toThrow();

    await system(() => deliverOccurrence(t.orgId, occ!.id, { note: 'Reviewed' },
      { userId: t.techId, partnerId: t.partnerId, accessibleOrgIds: [t.orgId] }));

    const after = await system(() => listPortalRuns(t.orgId, 'UTC', { page: 1, limit: 50 }));
    expect(after.data.map((r) => r.id)).toContain(run!.id);
    expect(after.data.find((r) => r.id === run!.id)?.type).toBe(MANAGED_TYPE);

    const pdf = await system(() => renderRunPdf(run!.id, t.orgId, 'UTC'));
    expect(Buffer.isBuffer(pdf) && pdf.length > 0).toBe(true);
    // The proof that the SERVER-SIDE path reached the new buildReportPdf arm
    // rather than falling silently through to renderGenericReport, which would
    // print the rows as a plain table and drop the whole designed summary.
    const text = pdf.toString('latin1');
    expect(text).toContain('Threat Detection Review');
    expect(text).toContain('What this covers');
    // The generic renderer has no such section and no coverage line.
    expect(text).not.toContain('do-not-render');
  });
});
