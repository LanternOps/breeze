/**
 * Service deliverables W02 (#5573) — the daily sweep, the ticket bridge and
 * auto-evidence, proven end to end on real Postgres.
 *
 * Every case here proves something a mocked suite structurally cannot: that
 * the sweep's system-context transactions commit what the service claims, that
 * the claim/ticket pairing is atomic, that the report-run CHECK accepts the
 * `system` requester stamp, that the real `ticket.status_changed` payload
 * resolves to a delivery, that the move-org guard actually fires inside
 * moveTicketOrg's transaction (with a positive control), and that re-running
 * the sweep is a no-op.
 *
 * Code under test runs through the real driver as the unprivileged app role
 * (the integration setup's DATABASE_URL); fixtures are seeded through the
 * privileged test connection and re-seeded per test (setup truncates tenant
 * data between tests).
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  contracts, organizationKeyDates, partners, reportRuns, reports, serviceDeliverableEvidence,
  serviceDeliverableOccurrences, serviceDeliverables, ticketCategories, ticketComments, tickets,
} from '../../db/schema';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { runDeliverableSweep, handleContractEvent } from '../../jobs/deliverableWorker';
import { handleDeliverableTicketStatusChanged } from '../../services/deliverableStatusSubscriber';
import { addEvidence } from '../../services/serviceDeliverableService';
import { rollForwardAnnualKeyDates } from '../../services/orgKeyDateService';
import { changeTicketStatus, createTicket, moveTicketOrg } from '../../services/ticketService';
import { cancelContract } from '../../services/contractService';
import { addDaysISO } from '../../services/contractMath';
import { siteScopeFingerprint } from '../../services/siteScope';
import type { BreezeEvent } from '../../services/eventBus';

// publishEvent writes to a Redis stream — spy on it so nothing needs a live
// stream consumer (same precedent as aiAgentTicketTriage.integration.test.ts).
const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});
// Lets one test force a genuine (non-refusal) failure at the exact point
// between the occurrence claim and the ticket, to prove the claim rolls back
// with it on real Postgres — the one thing a mocked db cannot show.
const { failTicketCreation } = vi.hoisted(() => ({ failTicketCreation: { value: false } }));
vi.mock('../../services/plannedWorkTicket', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/plannedWorkTicket')>();
  return {
    ...actual,
    createPlannedWorkTicket: async (...args: Parameters<typeof actual.createPlannedWorkTicket>) => {
      if (failTicketCreation.value) throw new Error('connection reset');
      return actual.createPlannedWorkTicket(...args);
    },
  };
});
// cancelContract emits to the contract-events BullMQ queue; the consumer's job
// body is called directly below instead.
vi.mock('../../services/contractEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/contractEvents')>();
  return { ...actual, emitContractEvent: vi.fn(async () => {}) };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);

const AS_OF = new Date('2026-10-25T05:18:00Z');
const TODAY = '2026-10-25';
const system = <T>(fn: () => Promise<T>, label = 'deliverableSweep.integration') =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

interface Tenant {
  partnerId: string; orgId: string; otherOrgId: string;
  techId: string; tech: { userId: string; name: string };
}

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const other = await createOrganization({ partnerId: partner.id });
  const role = (await createRole({ scope: 'partner', partnerId: partner.id }))!;
  await grantRolePermissions(role.id, [
    { resource: 'tickets', action: 'read' }, { resource: 'tickets', action: 'write' },
    { resource: 'reports', action: 'read' }, { resource: 'reports', action: 'write' },
  ]);
  const tech = (await createUser({ partnerId: partner.id, orgId: null, email: `tech-${randomUUID()}@example.com`, name: 'Tess Tech' }))!;
  await assignUserToPartner(tech.id, partner.id, role.id, 'all');
  return { partnerId: partner.id, orgId: org.id, otherOrgId: other.id, techId: tech.id, tech: { userId: tech.id, name: 'Tess Tech' } };
}

async function seedDeliverable(t: Tenant, over: Partial<typeof serviceDeliverables.$inferInsert> = {}): Promise<string> {
  const [row] = await getTestDb().insert(serviceDeliverables).values({
    orgId: t.orgId, name: 'Sign-in log review', cadence: 'monthly',
    anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01',
    leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve',
    ownerUserId: t.techId,
    ...over,
  }).returning({ id: serviceDeliverables.id });
  return row!.id;
}

async function seedReportRun(orgId: string): Promise<{ reportId: string; runId: string }> {
  const [report] = await getTestDb().insert(reports).values({
    orgId, name: 'Evidence', type: 'device_inventory', config: {}, schedule: 'one_time', format: 'csv',
  }).returning({ id: reports.id });
  const [run] = await getTestDb().insert(reportRuns).values({ reportId: report!.id, status: 'completed' })
    .returning({ id: reportRuns.id });
  return { reportId: report!.id, runId: run!.id };
}

const occurrencesOf = (deliverableId: string) => getTestDb().select().from(serviceDeliverableOccurrences)
  .where(eq(serviceDeliverableOccurrences.deliverableId, deliverableId)).orderBy(serviceDeliverableOccurrences.dueAt);
const ticketsOf = (orgId: string) => getTestDb().select().from(tickets).where(eq(tickets.orgId, orgId));
const statusChangedEvent = (orgId: string, ticketId: string, from: string, to: string): BreezeEvent => ({
  id: randomUUID(), type: 'ticket.status_changed', orgId, source: 'ticket-outbox', priority: 'normal',
  payload: { ticketId, from, to }, metadata: { timestamp: new Date().toISOString() },
} as unknown as BreezeEvent);

describe('deliverable sweep on real Postgres (#5573 W02)', () => {
  beforeEach(() => { publishEventMock.mockClear(); });

  runDb('1. materialize → open: one SLA-free deliverable ticket, due on the due date, linked to the occurrence', async () => {
    const t = await seedTenant();
    // A category WITH both SLA minutes — otherwise the null assertions are vacuous.
    const [cat] = await getTestDb().insert(ticketCategories).values({
      partnerId: t.partnerId, name: 'Compliance', responseSlaMinutes: 60, resolutionSlaMinutes: 480,
    }).returning({ id: ticketCategories.id });
    const d = await seedDeliverable(t, { ticketCategoryId: cat!.id });

    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ deliverables: 1, materialized: 1, opened: 1, failed: 0 });

    const [occ] = await occurrencesOf(d);
    expect(occ).toMatchObject({ status: 'open', dueAt: '2026-10-31', periodStart: '2026-10-01', nameSnapshot: 'Sign-in log review' });
    expect(occ!.ticketId).not.toBeNull();
    const [ticket] = await getTestDb().select().from(tickets).where(eq(tickets.id, occ!.ticketId!));
    expect(ticket).toMatchObject({
      workKind: 'deliverable', source: 'api', categoryId: cat!.id, assignedTo: t.techId,
      responseSlaMinutes: null, resolutionSlaMinutes: null, subject: 'Sign-in log review — Oct 2026',
    });
    expect(ticket!.dueDate!.toISOString().slice(0, 10)).toBe(occ!.dueAt);
  });

  runDb('2. the real ticket.status_changed payload → awaiting_evidence → delivered', async () => {
    const t = await seedTenant();
    const d = await seedDeliverable(t);
    await runDeliverableSweep(AS_OF);
    const [occ] = await occurrencesOf(d);
    const ticketId = occ!.ticketId!;

    await system(() => changeTicketStatus(ticketId, { status: 'resolved' }, { resolutionNote: 'Reviewed, no findings' }, t.tech));
    await handleDeliverableTicketStatusChanged(statusChangedEvent(t.orgId, ticketId, 'open', 'resolved'));
    const [awaiting] = await occurrencesOf(d);
    expect(awaiting).toMatchObject({ status: 'awaiting_evidence', deliveredAt: null, deliveryNote: 'Reviewed, no findings' });

    // A duplicate delivery of the same event is a no-op.
    await handleDeliverableTicketStatusChanged(statusChangedEvent(t.orgId, ticketId, 'open', 'resolved'));
    expect((await occurrencesOf(d))[0]!.status).toBe('awaiting_evidence');

    const { runId } = await seedReportRun(t.orgId);
    await system(() => addEvidence(t.orgId, occ!.id, { kind: 'report_run', reportRunId: runId },
      { userId: t.techId, partnerId: t.partnerId, accessibleOrgIds: null }));
    const [delivered] = await occurrencesOf(d);
    expect(delivered).toMatchObject({
      status: 'delivered', deliveredVia: 'ticket', deliveryNote: 'Reviewed, no findings', deliveredByUserId: t.techId,
    });
  });

  runDb('2b. reopening the ticket undoes a ticket-driven delivery', async () => {
    const t = await seedTenant();
    const d = await seedDeliverable(t, { artifactRequired: false });
    await runDeliverableSweep(AS_OF);
    const ticketId = (await occurrencesOf(d))[0]!.ticketId!;
    await system(() => changeTicketStatus(ticketId, { status: 'resolved' }, { resolutionNote: 'Done' }, t.tech));
    await handleDeliverableTicketStatusChanged(statusChangedEvent(t.orgId, ticketId, 'open', 'resolved'));
    expect((await occurrencesOf(d))[0]).toMatchObject({ status: 'delivered', deliveredVia: 'ticket', deliveredByUserId: t.techId });

    await system(() => changeTicketStatus(ticketId, { status: 'open' }, {}, t.tech));
    await handleDeliverableTicketStatusChanged(statusChangedEvent(t.orgId, ticketId, 'resolved', 'open'));
    expect((await occurrencesOf(d))[0]).toMatchObject({ status: 'open', deliveredAt: null, deliveredVia: null, deliveryNote: null });
  });

  runDb('3. miss after grace: status missed, ticket_id untouched', async () => {
    const t = await seedTenant();
    const due = addDaysISO(TODAY, -15);             // due + 14 grace < today
    const d = await seedDeliverable(t, { anchorDueDate: due, effectiveFrom: addDaysISO(due, -30), cadence: 'one_time' });
    const ticket = await system(() => createTicket({ orgId: t.orgId, source: 'api', subject: 'Pre-existing work', workKind: 'deliverable' }, t.tech));
    const [occ] = await getTestDb().insert(serviceDeliverableOccurrences).values({
      orgId: t.orgId, deliverableId: d, nameSnapshot: 'Sign-in log review',
      periodStart: due, periodEnd: due, dueAt: due, originalDueAt: due, status: 'open', ticketId: ticket.id,
    }).returning({ id: serviceDeliverableOccurrences.id });

    const res = await runDeliverableSweep(AS_OF);
    expect(res.missed).toBe(1);
    const [row] = await getTestDb().select().from(serviceDeliverableOccurrences).where(eq(serviceDeliverableOccurrences.id, occ!.id));
    expect(row).toMatchObject({ status: 'missed', ticketId: ticket.id });
  });

  runDb('4. idempotent: a second sweep with the same asOf changes nothing', async () => {
    const t = await seedTenant();
    const d = await seedDeliverable(t);
    await runDeliverableSweep(AS_OF);
    const before = { occ: await occurrencesOf(d), tickets: await ticketsOf(t.orgId) };
    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ materialized: 0, opened: 0, missed: 0, failed: 0 });
    const after = { occ: await occurrencesOf(d), tickets: await ticketsOf(t.orgId) };
    expect(after.occ.map((o) => [o.id, o.status, o.ticketId])).toEqual(before.occ.map((o) => [o.id, o.status, o.ticketId]));
    expect(after.tickets.map((x) => x.id).sort()).toEqual(before.tickets.map((x) => x.id).sort());
    expect(after.tickets).toHaveLength(1);
  });

  runDb('5. downtime catch-up: capped at 12, past-grace rows inserted as missed, no ticket for any missed row', async () => {
    const t = await seedTenant();
    const anchor = '2025-02-28';                     // ~20 months before AS_OF
    const d = await seedDeliverable(t, { anchorDueDate: anchor, effectiveFrom: '2025-02-01' });
    await runDeliverableSweep(AS_OF);
    const rows = await occurrencesOf(d);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ dueAt: anchor, status: 'missed', ticketId: null });
    expect(rows.filter((r) => r.status === 'missed').every((r) => r.ticketId === null)).toBe(true);
    expect(await ticketsOf(t.orgId)).toHaveLength(0);
  });

  runDb('6. Service Management off: the occurrence opens with no ticket and no ticket row exists', async () => {
    const t = await seedTenant();
    await getTestDb().update(partners).set({ serviceManagementMode: 'off' }).where(eq(partners.id, t.partnerId));
    const d = await seedDeliverable(t);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runDeliverableSweep(AS_OF);
      expect(res).toMatchObject({ opened: 1, failed: 0 });
    } finally { warn.mockRestore(); }
    const [occ] = await occurrencesOf(d);
    expect(occ).toMatchObject({ status: 'open', ticketId: null });
    expect(await ticketsOf(t.orgId)).toHaveLength(0);
  });

  runDb('7. contract.cancelled closes the effective window; a replay after un-cancelling changes nothing', async () => {
    const t = await seedTenant();
    const [contract] = await getTestDb().insert(contracts).values({
      partnerId: t.partnerId, orgId: t.orgId, name: 'Managed services', status: 'active',
      intervalMonths: 1, startDate: '2026-01-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    const d = await seedDeliverable(t, { contractId: contract!.id });
    const untouched = await seedDeliverable(t, { contractId: contract!.id, name: 'Quarterly review', effectiveUntil: '2027-06-30' });

    await system(() => cancelContract(contract!.id, { userId: t.techId, partnerId: t.partnerId, accessibleOrgIds: null }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleContractEvent({ type: 'contract.cancelled', contractId: contract!.id, orgId: t.orgId, partnerId: t.partnerId }, AS_OF);
    } finally { log.mockRestore(); }
    const read = (id: string) => getTestDb().select({ effectiveUntil: serviceDeliverables.effectiveUntil })
      .from(serviceDeliverables).where(eq(serviceDeliverables.id, id));
    expect((await read(d))[0]!.effectiveUntil).toBe(TODAY);
    expect((await read(untouched))[0]!.effectiveUntil).toBe('2027-06-30');   // an MSP-set window is never overwritten

    // Replay safety: the cancel was reversed; the stale event must not close a live deliverable.
    await getTestDb().update(contracts).set({ status: 'active' }).where(eq(contracts.id, contract!.id));
    await getTestDb().update(serviceDeliverables).set({ effectiveUntil: null }).where(eq(serviceDeliverables.id, d));
    await handleContractEvent({ type: 'contract.cancelled', contractId: contract!.id, orgId: t.orgId, partnerId: t.partnerId }, AS_OF);
    expect((await read(d))[0]!.effectiveUntil).toBeNull();
  });

  runDb('8. auto-evidence: one system-requested run, one evidence row, one internal note — and never twice', async () => {
    const t = await seedTenant();
    const [report] = await getTestDb().insert(reports).values({
      orgId: t.orgId, name: 'Device inventory', type: 'device_inventory', config: {}, schedule: 'one_time', format: 'csv',
      executionScopeVersion: 1, executionScopeKind: 'unrestricted', executionScopeSiteIds: null,
      executionScopeUserId: t.techId, executionScopePrincipalKind: 'user',
      executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId: t.orgId }),
      executionScopeCapturedAt: new Date('2026-10-01T00:00:00Z'),
    }).returning({ id: reports.id });
    // Due today: materialized, opened and evidenced in the same run.
    const d = await seedDeliverable(t, { anchorDueDate: TODAY, autoEvidenceReportId: report!.id });

    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ opened: 1, autoEvidence: 1, failed: 0 });

    const counts = async () => {
      const [occ] = await occurrencesOf(d);
      const runs = await getTestDb().select().from(reportRuns).where(eq(reportRuns.reportId, report!.id));
      const evidence = await getTestDb().select().from(serviceDeliverableEvidence).where(eq(serviceDeliverableEvidence.occurrenceId, occ!.id));
      const notes = await getTestDb().select().from(ticketComments)
        .where(and(eq(ticketComments.ticketId, occ!.ticketId!), eq(ticketComments.content, 'Report attached, review and resolve')));
      return { occ: occ!, runs, evidence, notes };
    };
    const first = await counts();
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]).toMatchObject({
      status: 'completed', requestedByKind: 'system', requestedByUserId: null, requestedByPortalUserId: null,
      executionScopePrincipalKind: 'user', executionScopeUserId: t.techId,
    });
    expect(first.evidence).toHaveLength(1);
    expect(first.evidence[0]).toMatchObject({ kind: 'report_run', reportId: report!.id, reportRunId: first.runs[0]!.id, createdByUserId: null });
    expect(first.notes).toHaveLength(1);
    expect(first.notes[0]).toMatchObject({ commentType: 'internal', isPublic: false, originPrincipalKind: 'system', userId: null });
    expect(first.occ.status).toBe('open');                  // evidence does not deliver; the technician resolves

    await runDeliverableSweep(AS_OF);
    const second = await counts();
    expect([second.runs.length, second.evidence.length, second.notes.length]).toEqual([1, 1, 1]);
  });

  runDb('9. key-date reminder fires once; the annual roll-forward clears both stamps', async () => {
    const t = await seedTenant();
    const date = addDaysISO(TODAY, 30);
    const [kd] = await getTestDb().insert(organizationKeyDates).values({
      orgId: t.orgId, label: 'Cyber insurance renewal', kind: 'insurance_renewal', date,
      recursAnnually: true, remindDaysBefore: 60, ownerUserId: t.techId,
    }).returning({ id: organizationKeyDates.id });

    const first = await runDeliverableSweep(AS_OF);
    const second = await runDeliverableSweep(AS_OF);
    expect([first.keyDateReminders, second.keyDateReminders]).toEqual([1, 0]);
    const reminders = (await ticketsOf(t.orgId)).filter((x) => x.subject.startsWith('Key date:'));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ workKind: 'deliverable', assignedTo: t.techId, responseSlaMinutes: null });
    const [stamped] = await getTestDb().select().from(organizationKeyDates).where(eq(organizationKeyDates.id, kd!.id));
    expect(stamped).toMatchObject({ remindedForDate: date, reminderTicketId: reminders[0]!.id });

    const past = addDaysISO(TODAY, -1);
    await getTestDb().update(organizationKeyDates).set({ date: past }).where(eq(organizationKeyDates.id, kd!.id));
    expect(await rollForwardAnnualKeyDates(TODAY)).toBe(1);
    const [rolled] = await getTestDb().select().from(organizationKeyDates).where(eq(organizationKeyDates.id, kd!.id));
    expect(rolled).toMatchObject({ date: `${Number(past.slice(0, 4)) + 1}${past.slice(4)}`, remindedForDate: null, reminderTicketId: null });
  });

  runDb('10. move-org is refused for a pinned deliverable ticket — and succeeds once unpinned (positive control)', async () => {
    const t = await seedTenant();
    const d = await seedDeliverable(t);
    await runDeliverableSweep(AS_OF);
    const [occ] = await occurrencesOf(d);
    const ticketId = occ!.ticketId!;

    await expect(system(() => moveTicketOrg(ticketId, t.otherOrgId, t.tech)))
      .rejects.toMatchObject({ status: 409, code: 'DELIVERABLE_TICKET_PINNED' });
    expect((await getTestDb().select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, ticketId)))[0]!.orgId).toBe(t.orgId);

    await getTestDb().update(serviceDeliverableOccurrences).set({ ticketId: null }).where(eq(serviceDeliverableOccurrences.id, occ!.id));
    const moved = await system(() => moveTicketOrg(ticketId, t.otherOrgId, t.tech));
    expect(moved.orgId).toBe(t.otherOrgId);
  });

  runDb('11. a ticket failure rolls the claim back: the occurrence stays scheduled and retries next run', async () => {
    const t = await seedTenant();
    const d = await seedDeliverable(t);
    failTicketCreation.value = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await runDeliverableSweep(AS_OF);
      expect(res).toMatchObject({ materialized: 1, opened: 0 });
    } finally { err.mockRestore(); failTicketCreation.value = false; }

    // The claim UPDATE committed nothing: no half-open occurrence, no ticket.
    expect((await occurrencesOf(d))[0]).toMatchObject({ status: 'scheduled', ticketId: null });
    expect(await ticketsOf(t.orgId)).toHaveLength(0);

    // ... and the next run picks it up normally.
    const second = await runDeliverableSweep(AS_OF);
    expect(second).toMatchObject({ opened: 1, failed: 0 });
    expect((await occurrencesOf(d))[0]!.status).toBe('open');
    expect(await ticketsOf(t.orgId)).toHaveLength(1);
  });

  runDb('12. two sweeps racing the same deliverable produce exactly one occurrence and one ticket', async () => {
    const t = await seedTenant();
    const d = await seedDeliverable(t);
    const [a, b] = await Promise.all([runDeliverableSweep(AS_OF), runDeliverableSweep(AS_OF)]);
    expect(a.failed + b.failed).toBe(0);
    expect(a.materialized + b.materialized).toBe(1);   // the UNIQUE (deliverable_id, period_start) claim
    expect(a.opened + b.opened).toBeLessThanOrEqual(1); // the status CAS claim
    const occ = await occurrencesOf(d);
    expect(occ).toHaveLength(1);
    const madeTickets = await ticketsOf(t.orgId);
    expect(madeTickets).toHaveLength(occ[0]!.ticketId ? 1 : 0);
  });

  runDb('the sweep skips an archived tenant inside its purge countdown (automation-eligible predicate)', async () => {
    const t = await seedTenant();
    const d = await seedDeliverable(t);
    await getTestDb().execute(sql`UPDATE organizations SET status = 'archived' WHERE id = ${t.orgId}::uuid`);
    const res = await runDeliverableSweep(AS_OF);
    expect(res.deliverables).toBe(0);
    expect(await occurrencesOf(d)).toHaveLength(0);
  });
});
