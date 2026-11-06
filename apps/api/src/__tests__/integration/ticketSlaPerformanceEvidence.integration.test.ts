/**
 * #11018 W2: `ticket_sla_performance` as service-plan evidence, end to end on
 * real Postgres as the forced-RLS `breeze_app` role.
 *
 * What no unit test can establish:
 *
 *  1. a partner-wide template produces the run for the OCCURRENCE's period over
 *     real tickets, clipped at the moment it was generated;
 *  2. the run stays hidden from the portal until the occurrence is delivered, and
 *     is then listed and downloadable. The type is gated on tickets:read for staff
 *     and a portal user has no permission set, so "then listed" is the assertion
 *     that fails if the customer reader's exemption is lost;
 *  3. reads run the way the portal runs them, in `portalOrgDbAccessContext`, so
 *     org A's portal user cannot reach org B's run through the predicate or RLS;
 *  4. a delivered artifact carries no ticket subject, in any format.
 *
 * Date is frozen because `deliverableAutoEvidence` stamps `generatedAt` from the
 * real clock, and the clip in (1) is measured against it. Only Date is faked; the
 * pool's timers keep running.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

import type { TicketSlaPerformanceSummary } from '@breeze/shared';
import { runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  portalBranding, reportRuns, reports, serviceDeliverableEvidence, serviceDeliverableOccurrences,
  serviceDeliverables, tickets,
} from '../../db/schema';
import { runDeliverableSweep } from '../../jobs/deliverableWorker';
import { portalOrgDbAccessContext } from '../../routes/portal/portalDbContext';
import { applyTemplateSet, createTemplateSet, type TemplateActor } from '../../services/deliverableTemplateService';
import {
  listPortalRuns, PortalReportNotFoundError, renderRunCsv, renderRunPdf,
} from '../../services/portal/reportsSelfService';
import { generateManagedEvidenceReport } from '../../services/reportGenerationService';
import { deliverOccurrence, removeEvidence } from '../../services/serviceDeliverableService';
import {
  assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions,
} from './db-utils';

// publishEvent writes to a Redis stream — spy on it (deliverableSweep precedent).
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'test-event-id') };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MANAGED_TYPE = 'ticket_sla_performance' as const;
// The due day of the October occurrence, early enough to leave most of it unmeasured.
const AS_OF = new Date('2026-10-31T05:18:00.000Z');
const SECRET_SUBJECT = 'Payroll export for Dana leaks salaries';

const system = <T>(fn: () => Promise<T>) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, 'ticketSlaPerformanceEvidence.integration'));
/** The context `routes/portal/auth.ts` opens for a portal user of `orgId`. */
const asPortalUserOf = <T>(orgId: string, fn: () => Promise<T>) =>
  runOutsideDbContext(() => withDbAccessContext(portalOrgDbAccessContext(orgId), fn));

interface Tenant { partnerId: string; orgId: string; techId: string }

async function seedTenant(): Promise<Tenant> {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const role = (await createRole({ scope: 'partner', partnerId: partner.id }))!;
  await grantRolePermissions(role.id, [
    { resource: 'reports', action: 'read' }, { resource: 'reports', action: 'write' },
    { resource: 'contracts', action: 'read' }, { resource: 'contracts', action: 'write' },
  ]);
  const tech = (await createUser({
    partnerId: partner.id, orgId: null, email: `tech-${randomUUID()}@example.com`, name: 'Tess Tech',
  }))!;
  await assignUserToPartner(tech.id, partner.id, role.id, 'all');
  await getTestDb().insert(portalBranding).values({ orgId: org.id, enableReports: true, enableService: true });
  return { partnerId: partner.id, orgId: org.id, techId: tech.id };
}

const actorFor = (t: Tenant): TemplateActor => ({
  userId: t.techId, scope: 'partner', partnerId: t.partnerId, partnerOrgAccess: 'all',
  accessibleOrgIds: [t.orgId],
});

type SeedTicket = {
  createdAt: string;
  responseSla?: number;
  resolutionSla?: number;
  firstResponseAt?: string | null;
  resolvedAt?: string | null;
  subject?: string;
};

/** A 24×7 ticket, so its deadlines are plain created + target. */
async function seedTicket(t: Tenant, o: SeedTicket): Promise<string> {
  const id = randomUUID();
  const ticketNumber = `SLA-${id.slice(0, 8)}`;
  const createdAt = new Date(o.createdAt);
  const responseSla = o.responseSla ?? 60;
  const resolutionSla = o.resolutionSla ?? 480;
  await getTestDb().insert(tickets).values({
    id,
    orgId: t.orgId,
    partnerId: t.partnerId,
    ticketNumber,
    subject: o.subject ?? SECRET_SUBJECT,
    source: 'manual',
    status: o.resolvedAt ? 'resolved' : 'open',
    priority: 'high',
    createdAt,
    responseSlaMinutes: responseSla,
    resolutionSlaMinutes: resolutionSla,
    responseDueAt: new Date(createdAt.getTime() + responseSla * 60_000),
    resolutionDueAt: new Date(createdAt.getTime() + resolutionSla * 60_000),
    firstResponseAt: o.firstResponseAt ? new Date(o.firstResponseAt) : null,
    resolvedAt: o.resolvedAt ? new Date(o.resolvedAt) : null,
  });
  return ticketNumber;
}

/** Outcomes on both sides of every boundary the run must respect. */
async function seedOutcomes(t: Tenant): Promise<{ breachedNumber: string }> {
  // Inside the period, both targets met.
  await seedTicket(t, {
    createdAt: '2026-10-10T09:00:00Z', firstResponseAt: '2026-10-10T09:30:00Z', resolvedAt: '2026-10-10T12:00:00Z',
  });
  // Inside the period, both targets missed: the one breach list entry per target.
  const breachedNumber = await seedTicket(t, {
    createdAt: '2026-10-12T09:00:00Z', firstResponseAt: '2026-10-12T11:00:00Z', resolvedAt: '2026-10-13T09:00:00Z',
  });
  // Decided in September: must not count, and is the proof the period is bound.
  await seedTicket(t, {
    createdAt: '2026-09-10T09:00:00Z', firstResponseAt: '2026-09-10T09:30:00Z', resolvedAt: '2026-09-10T12:00:00Z',
  });
  // Response decided in the window; resolution not due until after AS_OF, so it
  // falls past the clip and must not count as a miss.
  await seedTicket(t, {
    createdAt: '2026-10-31T01:00:00Z', firstResponseAt: '2026-10-31T01:30:00Z', resolvedAt: null,
    resolutionSla: 1140,
  });
  return { breachedNumber };
}

async function applyMonthlyTemplate(t: Tenant): Promise<void> {
  const actor = actorFor(t);
  const set = await system(() => createTemplateSet({
    ownerScope: 'partner', name: `Managed SLA plan ${randomUUID().slice(0, 8)}`,
    items: [{
      name: 'Monthly SLA performance', cadence: 'monthly', leadDays: 7, graceDays: 14,
      artifactRequired: true, completionMode: 'explicit', sortOrder: 0,
      autoEvidenceReportType: MANAGED_TYPE,
    }],
  }, actor));
  expect(set.items[0]!.autoEvidenceReportType).toBe(MANAGED_TYPE);
  const applied = await system(() => applyTemplateSet(t.orgId, set.id, { effectiveFrom: '2026-10-01' }, actor));
  expect(applied.created).toHaveLength(1);
}

async function managedRunOf(orgId: string) {
  const [managed] = await getTestDb().select().from(reports)
    .where(and(eq(reports.orgId, orgId), eq(reports.type, MANAGED_TYPE), eq(reports.portalSelfService, true)));
  const runs = await getTestDb().select().from(reportRuns).where(eq(reportRuns.reportId, managed!.id));
  expect(runs).toHaveLength(1);
  return { managed: managed!, run: runs[0]! };
}

async function firstOccurrenceOf(orgId: string) {
  const [d] = await getTestDb().select().from(serviceDeliverables).where(eq(serviceDeliverables.orgId, orgId));
  const [occ] = await getTestDb().select().from(serviceDeliverableOccurrences)
    .where(eq(serviceDeliverableOccurrences.deliverableId, d!.id)).orderBy(serviceDeliverableOccurrences.dueAt);
  return occ!;
}

const deliver = (t: Tenant, occurrenceId: string) => system(() => deliverOccurrence(t.orgId, occurrenceId, { note: 'Reviewed' },
  { userId: t.techId, partnerId: t.partnerId, accessibleOrgIds: [t.orgId] }));

const summaryOf = (run: { result: unknown }) => (run.result as { summary: TicketSlaPerformanceSummary }).summary;
const listIdsAs = async (portalOrgId: string, listedOrgId: string) =>
  (await asPortalUserOf(portalOrgId, () => listPortalRuns(listedOrgId, 'UTC', { page: 1, limit: 50 }))).data.map((r) => r.id);

describe('ticket_sla_performance evidence on real Postgres (#11018 W2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: AS_OF });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  runDb('a due monthly deliverable produces a ticket_sla_performance run for the occurrence period', async () => {
    const t = await seedTenant();
    await seedOutcomes(t);
    await applyMonthlyTemplate(t);

    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ autoEvidence: 1, failed: 0 });

    const { managed, run } = await managedRunOf(t.orgId);
    expect(managed.name).toBe('Service evidence — SLA performance');
    expect(managed.config).toEqual({ includeSubjects: false });
    expect(run).toMatchObject({
      status: 'completed', requestedByKind: 'system', requestedByUserId: null,
      executionScopePrincipalKind: 'system', executionScopeKind: 'unrestricted',
      // One row per priority, whatever the ticket count.
      rowCount: 4,
    });

    const occ = await firstOccurrenceOf(t.orgId);
    expect([occ.periodStart, occ.periodEnd]).toEqual(['2026-10-01', '2026-10-31']);

    const s = summaryOf(run);
    expect(s.period.kind).toBe('custom');
    expect(s.period.label).toBe('2026-10-01 to 2026-10-31');
    expect(s.generatedAt).toBe(AS_OF.toISOString());
    // The window stops at generation, not at the end of the due day.
    expect(s.period.measuredThrough).toBe(AS_OF.toISOString());
    expect(s.notes).toContain(
      'This service report was generated on 2026-10-31 and covers outcomes decided through that time.',
    );
    // September is outside the period. The three October tickets answered in it:
    // two on time, one late.
    expect(s.overall.responseMeasured).toBe(3);
    expect(s.overall.responseMet).toBe(2);
    expect(s.overall.responseMissed).toBe(1);
    // The third ticket's resolution is due after the clip: not measured, not missed.
    expect(s.overall.resolutionMeasured).toBe(2);
    expect(s.overall.resolutionMet).toBe(1);
    expect(s.overall.resolutionMissed).toBe(1);
    // The occurrence's own work ticket is work_kind 'deliverable', so it is not opened volume.
    expect(s.overall.ticketsOpened).toBe(3);
    expect(s.breaches.rows).toHaveLength(2);
  });

  runDb('the run is hidden from the portal until the occurrence is delivered, then listed', async () => {
    const t = await seedTenant();
    await seedOutcomes(t);
    await applyMonthlyTemplate(t);
    await runDeliverableSweep(AS_OF);

    const { run } = await managedRunOf(t.orgId);
    const occ = await firstOccurrenceOf(t.orgId);
    expect(run.status).toBe('completed');

    expect(await listIdsAs(t.orgId, t.orgId)).not.toContain(run.id);
    await expect(asPortalUserOf(t.orgId, () => renderRunPdf(run.id, t.orgId, 'UTC'))).rejects.toThrow(PortalReportNotFoundError);
    await expect(asPortalUserOf(t.orgId, () => renderRunCsv(run.id, t.orgId))).rejects.toThrow(PortalReportNotFoundError);

    await deliver(t, occ.id);

    const after = await asPortalUserOf(t.orgId, () => listPortalRuns(t.orgId, 'UTC', { page: 1, limit: 50 }));
    const listed = after.data.find((r) => r.id === run.id);
    expect(listed?.type).toBe(MANAGED_TYPE);
    expect(listed?.csvAvailable).toBe(true);

    // Through the SLA arm of buildReportPdf, not the generic table renderer.
    const pdf = await asPortalUserOf(t.orgId, () => renderRunPdf(run.id, t.orgId, 'UTC'));
    expect(pdf.toString('latin1')).toContain('Service Level Performance');
    const csv = await asPortalUserOf(t.orgId, () => renderRunCsv(run.id, t.orgId));
    // Customer-facing header row, not the raw row keys.
    const header = csv.split('\n')[0]!;
    expect(header).toContain('Response within SLA (0-1)');
    expect(header).not.toMatch(/responseAttainment|[a-z][A-Z]/);
  });

  // Delivery is the customer's only grant. A run whose evidence row was removed was
  // never delivered, so it must not read as an ordinary self-service run.
  runDb('removing the evidence from an undelivered occurrence does not publish the run', async () => {
    const t = await seedTenant();
    await seedOutcomes(t);
    await applyMonthlyTemplate(t);
    await runDeliverableSweep(AS_OF);

    const { run } = await managedRunOf(t.orgId);
    const occ = await firstOccurrenceOf(t.orgId);
    expect(occ.status).not.toBe('delivered');
    const [evidence] = await getTestDb().select().from(serviceDeliverableEvidence)
      .where(eq(serviceDeliverableEvidence.occurrenceId, occ.id));
    await system(() => removeEvidence(t.orgId, occ.id, evidence!.id,
      { userId: t.techId, partnerId: t.partnerId, accessibleOrgIds: [t.orgId] }));
    const remaining = await getTestDb().select().from(serviceDeliverableEvidence)
      .where(eq(serviceDeliverableEvidence.occurrenceId, occ.id));
    expect(remaining).toEqual([]);

    expect(await listIdsAs(t.orgId, t.orgId)).not.toContain(run.id);
    await expect(asPortalUserOf(t.orgId, () => renderRunPdf(run.id, t.orgId, 'UTC'))).rejects.toThrow(PortalReportNotFoundError);
    await expect(asPortalUserOf(t.orgId, () => renderRunCsv(run.id, t.orgId))).rejects.toThrow(PortalReportNotFoundError);
  });

  runDb("org A's portal user never sees org B's run", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await seedOutcomes(a);
    await seedOutcomes(b);
    await applyMonthlyTemplate(a);
    await applyMonthlyTemplate(b);
    await runDeliverableSweep(AS_OF);

    const runA = (await managedRunOf(a.orgId)).run;
    const runB = (await managedRunOf(b.orgId)).run;
    await deliver(a, (await firstOccurrenceOf(a.orgId)).id);
    await deliver(b, (await firstOccurrenceOf(b.orgId)).id);

    // Positive control: each portal user sees their own delivered run.
    expect(await listIdsAs(a.orgId, a.orgId)).toEqual([runA.id]);
    expect(await listIdsAs(b.orgId, b.orgId)).toEqual([runB.id]);

    // The explicit org predicate, under org A's own context.
    await expect(asPortalUserOf(a.orgId, () => renderRunPdf(runB.id, a.orgId, 'UTC'))).rejects.toThrow(PortalReportNotFoundError);
    await expect(asPortalUserOf(a.orgId, () => renderRunCsv(runB.id, a.orgId))).rejects.toThrow(PortalReportNotFoundError);
    // RLS as the backstop: org A's context asking for org B directly gets nothing.
    expect(await listIdsAs(a.orgId, b.orgId)).toEqual([]);
    await expect(asPortalUserOf(a.orgId, () => renderRunPdf(runB.id, b.orgId, 'UTC'))).rejects.toThrow(PortalReportNotFoundError);
  });

  runDb('the delivered artifact contains no ticket subject strings', async () => {
    const t = await seedTenant();
    const { breachedNumber } = await seedOutcomes(t);
    await applyMonthlyTemplate(t);
    await runDeliverableSweep(AS_OF);

    const { run } = await managedRunOf(t.orgId);
    await deliver(t, (await firstOccurrenceOf(t.orgId)).id);

    // Control: with the option on, the same seed DOES carry the subject, so its
    // absence below is a property of the config rather than of the fixture.
    const optedIn = await system(() => generateManagedEvidenceReport(MANAGED_TYPE, t.orgId, { includeSubjects: true }, {
      periodStart: '2026-10-01', periodEnd: '2026-10-31',
      generatedAt: AS_OF.toISOString(), deliverableId: randomUUID(),
    }));
    expect(JSON.stringify(optedIn)).toContain(SECRET_SUBJECT);

    const summary = summaryOf(run);
    expect(summary.includeSubjects).toBe(false);
    expect(JSON.stringify(run.result)).not.toContain(SECRET_SUBJECT);
    // The breach is still reported, by customer-facing number.
    expect(summary.breaches.rows.map((r) => r.ticketNumber)).toContain(breachedNumber);
    expect(summary.breaches.rows.every((r) => r.subject === null)).toBe(true);

    const pdf = await asPortalUserOf(t.orgId, () => renderRunPdf(run.id, t.orgId, 'UTC'));
    const pdfText = pdf.toString('latin1');
    expect(pdfText).toContain(breachedNumber);
    expect(pdfText).not.toContain(SECRET_SUBJECT);
    expect(pdfText).not.toContain('Payroll');

    const csv = await asPortalUserOf(t.orgId, () => renderRunCsv(run.id, t.orgId));
    expect(csv).not.toContain(SECRET_SUBJECT);
    expect(csv).not.toContain('Payroll');
  });
});
