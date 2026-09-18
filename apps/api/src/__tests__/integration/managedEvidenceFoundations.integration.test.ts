/**
 * Evidence reports for service plans — W01 foundation (#5784, #5812 / #5813),
 * proven end to end on real Postgres.
 *
 * The closed `MANAGED_EVIDENCE_REGISTRY` is EMPTY in W01 (W02 adds the first
 * type), so this suite stands in one entry — `device_inventory`, the one shipped
 * generator that accepts a `ReportGenerationAuthority` — via `vi.mock`. Every
 * path below is otherwise the real code: template apply, apply-time
 * provisioning, the sweep, the system execution path, the refusal state, the
 * prior-occurrence baseline selector, the org-merge dedupe and the OD-12
 * publication gate. W02's task is to delete the mock and use its real type,
 * not to invent these cases.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  partnerUsers, portalBranding, reportRuns, reports, serviceDeliverableEvidence,
  serviceDeliverableOccurrences, serviceDeliverables, ticketComments,
} from '../../db/schema';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { runDeliverableSweep } from '../../jobs/deliverableWorker';
import { applyTemplateSet, createTemplateSet, type TemplateActor } from '../../services/deliverableTemplateService';
import { resolveManagedEvidenceDefinition } from '../../services/managedEvidenceDefinitions';
import { previousOccurrenceBaselineFor } from '../../services/evidenceBaseline';
import { previousBaselineFor } from '../../services/reportGenerationService';
import { deliverOccurrence } from '../../services/serviceDeliverableService';
import { listPortalRuns, renderRunPdf } from '../../services/portal/reportsSelfService';
import { deliverableOccurrences } from '../../services/portal/serviceReadModel';
import { AUTO_EVIDENCE_REFUSAL_NOTES } from '../../services/deliverableAutoEvidence';
import { persistedSystemSiteScopeValues, siteScopeFingerprint, systemReportAuthority } from '../../services/siteScope';
import * as orgMergeModule from '../../services/orgMerge';

// W01 stand-in for the registry (see the header). The real module is frozen and
// empty; W02 removes this mock.
vi.mock('../../services/managedEvidenceRegistry', () => {
  const entry = { type: 'device_inventory', defaultConfig: { filters: { siteIds: [] } }, definitionName: 'Service evidence — Device inventory (W01 stand-in)' };
  const registry = Object.freeze({ device_inventory: entry });
  return {
    MANAGED_EVIDENCE_REGISTRY: registry,
    isManagedEvidenceType: (v: string) => v === 'device_inventory',
    managedEvidenceEntry: (t: string) => { if (t !== 'device_inventory') throw new Error(`${t} is not a managed evidence type`); return entry; },
    MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX: 'Service evidence — ',
  };
});
// publishEvent writes to a Redis stream — spy on it (deliverableSweep precedent).
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'test-event-id') };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MANAGED_TYPE = 'device_inventory' as const;
const DUE = '2026-10-31';
const AS_OF = new Date('2026-10-31T05:18:00Z');
const system = <T>(fn: () => Promise<T>, label = 'managedEvidence.integration') =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

interface Tenant { partnerId: string; orgId: string; otherOrgId: string; techId: string }

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const other = await createOrganization({ partnerId: partner.id });
  const role = (await createRole({ scope: 'partner', partnerId: partner.id }))!;
  await grantRolePermissions(role.id, [
    { resource: 'tickets', action: 'read' }, { resource: 'tickets', action: 'write' },
    { resource: 'reports', action: 'read' }, { resource: 'reports', action: 'write' },
    { resource: 'contracts', action: 'read' }, { resource: 'contracts', action: 'write' },
  ]);
  const tech = (await createUser({ partnerId: partner.id, orgId: null, email: `tech-${randomUUID()}@example.com`, name: 'Tess Tech' }))!;
  await assignUserToPartner(tech.id, partner.id, role.id, 'all');
  return { partnerId: partner.id, orgId: org.id, otherOrgId: other.id, techId: tech.id };
}

const actorFor = (t: Tenant): TemplateActor => ({
  userId: t.techId, scope: 'partner', partnerId: t.partnerId, partnerOrgAccess: 'all', accessibleOrgIds: [t.orgId, t.otherOrgId],
});

async function seedDeliverable(orgId: string, techId: string, over: Partial<typeof serviceDeliverables.$inferInsert> = {}): Promise<string> {
  const [row] = await getTestDb().insert(serviceDeliverables).values({
    orgId, name: `Threat detection review ${randomUUID().slice(0, 8)}`, cadence: 'monthly',
    anchorDueDate: DUE, effectiveFrom: '2026-10-01',
    leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve',
    ownerUserId: techId,
    ...over,
  }).returning({ id: serviceDeliverables.id });
  return row!.id;
}

/** A NON-managed (user-authored) device_inventory definition owned by `userId`. */
async function seedUserDefinition(orgId: string, userId: string): Promise<string> {
  const [row] = await getTestDb().insert(reports).values({
    orgId, name: 'My device inventory', type: MANAGED_TYPE, config: {}, schedule: 'one_time', format: 'csv',
    portalSelfService: false, createdBy: userId,
    executionScopeVersion: 1, executionScopeKind: 'unrestricted', executionScopeSiteIds: null,
    executionScopeUserId: userId, executionScopePrincipalKind: 'user',
    executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId }),
    executionScopeCapturedAt: new Date('2026-10-01T00:00:00Z'),
  }).returning({ id: reports.id });
  return row!.id;
}

const occurrencesOf = (deliverableId: string) => getTestDb().select().from(serviceDeliverableOccurrences)
  .where(eq(serviceDeliverableOccurrences.deliverableId, deliverableId)).orderBy(serviceDeliverableOccurrences.dueAt);
const evidenceOf = (occurrenceId: string) => getTestDb().select().from(serviceDeliverableEvidence)
  .where(eq(serviceDeliverableEvidence.occurrenceId, occurrenceId));
const runsOf = (reportId: string) => getTestDb().select().from(reportRuns).where(eq(reportRuns.reportId, reportId));
const managedDefinitionsOf = (orgId: string) => getTestDb().select().from(reports)
  .where(and(eq(reports.orgId, orgId), eq(reports.type, MANAGED_TYPE), eq(reports.portalSelfService, true)));
const internalNotesOf = (ticketId: string, content: string) => getTestDb().select().from(ticketComments)
  .where(and(eq(ticketComments.ticketId, ticketId), eq(ticketComments.commentType, 'internal'), eq(ticketComments.content, content)));

describe('managed evidence foundations on real Postgres (#5784 W01)', () => {
  runDb('1. end to end from a partner-wide template apply: two orgs, two managed definitions, two completed runs — never wired by hand', async () => {
    const t = await seedTenant();
    const actor = actorFor(t);
    const set = await system(() => createTemplateSet({
      ownerScope: 'partner', name: `Best plan ${randomUUID().slice(0, 8)}`,
      items: [{
        name: 'Threat detection review', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true,
        completionMode: 'on_ticket_resolve', sortOrder: 0,
        // The shared validator refuses this until W02 fills the tuple; the
        // service is called directly, which is exactly what W02's route will do.
        autoEvidenceReportType: MANAGED_TYPE as never,
      }],
    }, actor));
    expect(set.items[0]!.autoEvidenceReportType).toBe(MANAGED_TYPE);

    for (const orgId of [t.orgId, t.otherOrgId]) {
      const applied = await system(() => applyTemplateSet(orgId, set.id, { effectiveFrom: '2026-10-01' }, actor));
      expect(applied.created).toHaveLength(1);
      // Apply-time resolution (OD-6 = A): the deliverable is concrete and the
      // org now has exactly one managed definition of the type.
      const [d] = await getTestDb().select().from(serviceDeliverables).where(eq(serviceDeliverables.id, applied.created[0]!.id));
      const managed = await managedDefinitionsOf(orgId);
      expect(managed).toHaveLength(1);
      expect(d!.autoEvidenceReportId).toBe(managed[0]!.id);
      expect(managed[0]).toMatchObject({ createdBy: t.techId, executionScopePrincipalKind: 'user', config: { filters: { siteIds: [] } } });
    }
    // A second apply to the same org ADOPTS the existing definition (insert-if-absent).
    await expect(system(() => applyTemplateSet(t.orgId, set.id, { effectiveFrom: '2026-10-01', onCollision: 'skip' }, actor)))
      .resolves.toMatchObject({ created: [] });
    expect(await managedDefinitionsOf(t.orgId)).toHaveLength(1);

    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ autoEvidence: 2, failed: 0 });

    const runIds = new Set<string>();
    const reportIds = new Set<string>();
    for (const orgId of [t.orgId, t.otherOrgId]) {
      const [managed] = await managedDefinitionsOf(orgId);
      const runs = await runsOf(managed!.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: 'completed', requestedByKind: 'system', requestedByUserId: null,
        // The SYSTEM authority ran, org-wide — not the technician who applied the template.
        executionScopePrincipalKind: 'system', executionScopeKind: 'unrestricted', executionScopeUserId: null,
      });
      runIds.add(runs[0]!.id); reportIds.add(managed!.id);
      const [d] = await getTestDb().select().from(serviceDeliverables).where(eq(serviceDeliverables.orgId, orgId));
      const [occ] = await occurrencesOf(d!.id);
      const ev = await evidenceOf(occ!.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ kind: 'report_run', reportId: managed!.id, reportRunId: runs[0]!.id });
      expect(occ).toMatchObject({ status: 'open', autoEvidenceRefusal: null });
      expect(occ!.autoEvidenceAttemptedAt).not.toBeNull();
    }
    expect(runIds.size).toBe(2);
    expect(reportIds.size).toBe(2);
  });

  runDb('2. the managed definition survives owner departure (the case OD-5 exists for)', async () => {
    const t = await seedTenant();
    const managed = await system(() => resolveManagedEvidenceDefinition(t.orgId, MANAGED_TYPE as never, t.techId));
    expect(managed.adopted).toBe(false);
    const d = await seedDeliverable(t.orgId, t.techId, { autoEvidenceReportId: managed.id });
    // The owner loses every partner grant.
    await getTestDb().delete(partnerUsers).where(eq(partnerUsers.userId, t.techId));

    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ autoEvidence: 1, failed: 0 });
    const runs = await runsOf(managed.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'completed', executionScopePrincipalKind: 'system', executionScopeUserId: null });
    const [occ] = await occurrencesOf(d);
    expect(await evidenceOf(occ!.id)).toHaveLength(1);
    expect(occ!.autoEvidenceRefusal).toBeNull();
  });

  runDb('3. a refusal produces a visible, de-duplicated state — not a console.warn', async () => {
    const t = await seedTenant();
    // A NON-managed definition whose owner has lost access takes the user path
    // and is refused; this is the positive control for case 2.
    const reportId = await seedUserDefinition(t.orgId, t.techId);
    const d = await seedDeliverable(t.orgId, t.techId, { autoEvidenceReportId: reportId });
    await getTestDb().delete(partnerUsers).where(eq(partnerUsers.userId, t.techId));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = await runDeliverableSweep(AS_OF);
      expect(first).toMatchObject({ autoEvidence: 0, failed: 0 });
      const [occ1] = await occurrencesOf(d);
      expect(occ1).toMatchObject({ status: 'open', autoEvidenceRefusal: 'scope_unverifiable' });
      expect(occ1!.autoEvidenceAttemptedAt).not.toBeNull();
      expect(occ1!.ticketId).not.toBeNull();
      expect(await internalNotesOf(occ1!.ticketId!, AUTO_EVIDENCE_REFUSAL_NOTES.scope_unverifiable!)).toHaveLength(1);
      expect(await runsOf(reportId)).toHaveLength(0);

      // Tomorrow's sweep: same reason, state refreshed, still ONE comment.
      const second = await runDeliverableSweep(new Date('2026-11-01T05:18:00Z'));
      expect(second).toMatchObject({ autoEvidence: 0 });
      const [occ2] = await occurrencesOf(d);
      expect(occ2!.autoEvidenceRefusal).toBe('scope_unverifiable');
      expect(occ2!.autoEvidenceAttemptedAt!.getTime()).toBeGreaterThan(occ1!.autoEvidenceAttemptedAt!.getTime());
      expect(await internalNotesOf(occ1!.ticketId!, AUTO_EVIDENCE_REFUSAL_NOTES.scope_unverifiable!)).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  runDb('4. org merge: two orgs each holding a managed definition of one type end as one', async () => {
    const t = await seedTenant();
    const a = await system(() => resolveManagedEvidenceDefinition(t.otherOrgId, MANAGED_TYPE as never, t.techId));
    const b = await system(() => resolveManagedEvidenceDefinition(t.orgId, MANAGED_TYPE as never, t.techId));
    expect(a.id).not.toBe(b.id);
    // A run on the loser's definition must be re-homed, never deleted.
    const [loserRun] = await getTestDb().insert(reportRuns).values({ reportId: a.id, status: 'completed' }).returning({ id: reportRuns.id });

    const result = await orgMergeModule.executeOrgMerge({
      loserOrgId: t.otherOrgId, survivorOrgId: t.orgId, partnerId: t.partnerId,
      performedBy: t.techId, performedByEmail: 'merge@evidence.test',
    });
    expect(result).toBeTruthy();
    const survivors = await managedDefinitionsOf(t.orgId);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.id).toBe(b.id);
    expect(await managedDefinitionsOf(t.otherOrgId)).toHaveLength(0);
    const [rehomed] = await getTestDb().select().from(reportRuns).where(eq(reportRuns.id, loserRun!.id));
    expect(rehomed!.reportId).toBe(b.id);
  }, 120_000);

  runDb('5. OD-11: a monthly and a quarterly deliverable on ONE shared definition do not compare each other’s runs', async () => {
    const t = await seedTenant();
    const managed = await system(() => resolveManagedEvidenceDefinition(t.orgId, MANAGED_TYPE as never, t.techId));
    const monthly = await seedDeliverable(t.orgId, t.techId, { autoEvidenceReportId: managed.id, cadence: 'monthly', anchorDueDate: '2026-09-30', effectiveFrom: '2026-09-01' });
    const quarterly = await seedDeliverable(t.orgId, t.techId, { autoEvidenceReportId: managed.id, cadence: 'quarterly', anchorDueDate: '2026-12-31', effectiveFrom: '2026-10-01' });
    const fingerprint = siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId: t.orgId });

    // Seed the prior periods' runs the way the sweep files them: run + evidence
    // on the occurrence, summaries in `result`.
    const seedPrior = async (deliverableId: string, periodStart: string, periodEnd: string, summary: Record<string, unknown>, completedAt: Date) => {
      const [occ] = await getTestDb().insert(serviceDeliverableOccurrences).values({
        orgId: t.orgId, deliverableId, nameSnapshot: 'x', periodStart, periodEnd, dueAt: periodEnd, originalDueAt: periodEnd, status: 'delivered',
      }).returning({ id: serviceDeliverableOccurrences.id });
      const [run] = await getTestDb().insert(reportRuns).values({
        reportId: managed.id, status: 'completed', completedAt,
        result: { rows: [], rowCount: 0, summary, generatedAt: completedAt.toISOString() },
        requestedByKind: 'system',
        ...persistedSystemSiteScopeValues(systemReportAuthority(t.orgId)),
      }).returning({ id: reportRuns.id });
      await getTestDb().insert(serviceDeliverableEvidence).values({
        orgId: t.orgId, occurrenceId: occ!.id, kind: 'report_run', reportId: managed.id, reportRunId: run!.id,
      });
      return run!.id;
    };
    await seedPrior(monthly, '2026-08-01', '2026-08-31', { n: 'aug' }, new Date('2026-08-31T05:18:00Z'));
    await seedPrior(monthly, '2026-09-01', '2026-09-30', { n: 'sep' }, new Date('2026-09-30T05:18:00Z'));
    // The quarterly's own run is the MOST RECENT completed run of the shared definition.
    await seedPrior(quarterly, '2026-07-01', '2026-09-30', { n: 'q3' }, new Date('2026-10-05T05:18:00Z'));

    // The October monthly compares against September, not the quarterly's Q3.
    expect(await system(() => previousOccurrenceBaselineFor({ deliverableId: monthly, currentPeriodStart: '2026-10-01' })))
      .toEqual({ generatedAt: '2026-09-30T05:18:00.000Z', summary: { n: 'sep' } });
    // Q4 compares against Q3, not against September.
    expect(await system(() => previousOccurrenceBaselineFor({ deliverableId: quarterly, currentPeriodStart: '2026-10-01' })))
      .toEqual({ generatedAt: '2026-10-05T05:18:00.000Z', summary: { n: 'q3' } });
    // A first period has no baseline.
    expect(await system(() => previousOccurrenceBaselineFor({ deliverableId: quarterly, currentPeriodStart: '2026-07-01' }))).toBeUndefined();
    // Positive control — the defect this selector exists for: the shipped
    // report-keyed helper hands the monthly the QUARTERLY's run.
    expect((await system(() => previousBaselineFor(managed.id, fingerprint)))?.summary).toEqual({ n: 'q3' });
  });

  runDb('6. OD-12: a managed evidence run is customer-invisible until the occurrence is delivered', async () => {
    const t = await seedTenant();
    await getTestDb().insert(portalBranding).values({ orgId: t.orgId, enableReports: true, enableService: true });
    const managed = await system(() => resolveManagedEvidenceDefinition(t.orgId, MANAGED_TYPE as never, t.techId));
    const d = await seedDeliverable(t.orgId, t.techId, { autoEvidenceReportId: managed.id });
    await runDeliverableSweep(AS_OF);
    const [occ] = await occurrencesOf(d);
    const [run] = await runsOf(managed.id);
    expect(run!.status).toBe('completed');

    // Generated at 05:18 on the due day, completed, portal_self_service — and
    // NOT visible to the customer.
    const before = await system(() => listPortalRuns(t.orgId, 'UTC', { page: 1, limit: 50 }));
    expect(before.data.map((r) => r.id)).not.toContain(run!.id);
    await expect(system(() => renderRunPdf(run!.id, t.orgId, 'UTC'))).rejects.toThrow();
    const scorecardBefore = await system(() => deliverableOccurrences(t.orgId, d, { timezone: 'UTC', now: AS_OF }));
    expect(scorecardBefore!.occurrences[0]!.evidence).toEqual([]);

    // The technician reviews and delivers.
    await system(() => deliverOccurrence(t.orgId, occ!.id, { note: 'Reviewed' },
      { userId: t.techId, partnerId: t.partnerId, accessibleOrgIds: [t.orgId] }));
    const [delivered] = await occurrencesOf(d);
    expect(delivered!.status).toBe('delivered');

    const after = await system(() => listPortalRuns(t.orgId, 'UTC', { page: 1, limit: 50 }));
    expect(after.data.map((r) => r.id)).toContain(run!.id);
    const pdf = await system(() => renderRunPdf(run!.id, t.orgId, 'UTC'));
    expect(Buffer.isBuffer(pdf) && pdf.length > 0).toBe(true);
    const scorecardAfter = await system(() => deliverableOccurrences(t.orgId, d, { timezone: 'UTC', now: new Date('2026-11-01T00:00:00Z') }));
    expect(scorecardAfter!.occurrences[0]!.evidence[0]).toMatchObject({ kind: 'report_run', reportRunId: run!.id });

    // An ordinary self-service run no deliverable references stays visible throughout.
    const [plain] = await getTestDb().insert(reports).values({
      orgId: t.orgId, name: 'Customer portal — Executive summary', type: 'executive_summary', config: {}, schedule: 'one_time', format: 'pdf', portalSelfService: true,
    }).returning({ id: reports.id });
    const [plainRun] = await getTestDb().insert(reportRuns).values({ reportId: plain!.id, status: 'completed', completedAt: new Date(), result: { rows: [] } }).returning({ id: reportRuns.id });
    const withPlain = await system(() => listPortalRuns(t.orgId, 'UTC', { page: 1, limit: 50 }));
    expect(withPlain.data.map((r) => r.id)).toContain(plainRun!.id);
  });
});
