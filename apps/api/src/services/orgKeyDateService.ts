import { and, asc, eq, gte, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import type { CreateKeyDateInput, UpdateKeyDateInput } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { addMonthsClamped } from './contractMath';
import { createPlannedWorkTicket } from './plannedWorkTicket';
import { captureException } from './sentry';
import { buildAutomationEligibleOrgPredicate } from './tenantStatus';
import { contracts, organizationKeyDates, organizations, users, type OrganizationKeyDateRow } from '../db/schema';
import type { DeliverableActor } from './serviceDeliverableService';
import { DeliverableServiceError } from './serviceDeliverableService';

/**
 * Spec #5573 §4.5 / plan W01 Task 9. Org key dates plus, on read, the end
 * dates of live contracts so the org record shows one chronological list.
 * Every query filters by orgId — defence in depth on top of RLS.
 */
export interface KeyDateView {
  source: 'key_date' | 'contract_end';
  id: string;
  label: string;
  kind: string;
  date: string;
  recursAnnually: boolean;
  remindDaysBefore: number | null;
  ownerUserId: string | null;
  portalVisible: boolean;
  notes: string | null;
  contractId: string | null;
}

// Same shape as serviceDeliverableService's helper, kept local so this module
// has no runtime dependency on that file's internals. 404 (not 403): spec §12
// forbids an existence leak across orgs.
function requireOrgAccess(actor: DeliverableActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new DeliverableServiceError('Not found', 404, 'NOT_FOUND');
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The owner must be a user of the org's partner. Resolved via the org's
 *  partner_id (never the actor's — a platform actor may carry none). */
async function assertOwnerInOrgPartner(orgId: string, ownerUserId: string): Promise<void> {
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new DeliverableServiceError('Not found', 404, 'NOT_FOUND');

  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, ownerUserId), eq(users.partnerId, org.partnerId)))
    .limit(1);
  if (!owner) {
    throw new DeliverableServiceError('Owner must be a user of this organization\'s partner', 400, 'OWNER_NOT_ALLOWED', { ownerUserId });
  }
}

function toKeyDateView(row: OrganizationKeyDateRow): KeyDateView {
  return {
    source: 'key_date',
    id: row.id,
    label: row.label,
    kind: row.kind,
    date: row.date,
    recursAnnually: row.recursAnnually,
    remindDaysBefore: row.remindDaysBefore,
    ownerUserId: row.ownerUserId,
    portalVisible: row.portalVisible,
    notes: row.notes,
    contractId: null,
  };
}

function toContractEndView(c: { id: string; name: string; endDate: string }): KeyDateView {
  return {
    source: 'contract_end',
    id: c.id,
    label: c.name,
    kind: 'contract_end',
    date: c.endDate,
    recursAnnually: false,
    remindDaysBefore: null,
    ownerUserId: null,
    portalVisible: true,
    notes: null,
    contractId: c.id,
  };
}

export async function listKeyDates(
  orgId: string,
  actor: DeliverableActor,
  opts?: { includeContractEnds?: boolean },
): Promise<KeyDateView[]> {
  requireOrgAccess(actor, orgId);
  const includeContractEnds = opts?.includeContractEnds ?? true;

  const rows = await db
    .select()
    .from(organizationKeyDates)
    .where(eq(organizationKeyDates.orgId, orgId))
    .orderBy(asc(organizationKeyDates.date));
  const views: KeyDateView[] = rows.map(toKeyDateView);

  if (includeContractEnds) {
    const today = todayISO();
    const ends = await db
      .select({ id: contracts.id, name: contracts.name, endDate: contracts.endDate, status: contracts.status })
      .from(contracts)
      .where(and(
        eq(contracts.orgId, orgId),
        isNotNull(contracts.endDate),
        gte(contracts.endDate, today),
        notInArray(contracts.status, ['draft', 'cancelled']),
      ))
      .orderBy(asc(contracts.endDate));
    for (const c of ends) {
      // The SQL predicate is authoritative; re-check in memory so a caller
      // (or a mock) that hands back unfiltered rows cannot surface a stale
      // or draft contract end.
      if (!c.endDate || c.endDate < today) continue;
      if (c.status === 'draft' || c.status === 'cancelled') continue;
      views.push(toContractEndView({ id: c.id, name: c.name, endDate: c.endDate }));
    }
  }

  return views.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function createKeyDate(
  orgId: string,
  input: CreateKeyDateInput,
  actor: DeliverableActor,
): Promise<OrganizationKeyDateRow> {
  requireOrgAccess(actor, orgId);
  const ownerUserId = input.ownerUserId ?? null;
  if (ownerUserId !== null) await assertOwnerInOrgPartner(orgId, ownerUserId);

  const [row] = await db
    .insert(organizationKeyDates)
    .values({
      orgId,
      label: input.label,
      kind: input.kind,
      date: input.date,
      recursAnnually: input.recursAnnually,
      remindDaysBefore: input.remindDaysBefore ?? null,
      ownerUserId,
      portalVisible: input.portalVisible,
      notes: input.notes ?? null,
    })
    .returning();
  if (!row) throw new DeliverableServiceError('Key date insert returned no row', 500, 'INSERT_FAILED');
  return row;
}

export async function updateKeyDate(
  orgId: string,
  id: string,
  patch: UpdateKeyDateInput,
  actor: DeliverableActor,
): Promise<OrganizationKeyDateRow> {
  requireOrgAccess(actor, orgId);
  if (patch.ownerUserId != null) await assertOwnerInOrgPartner(orgId, patch.ownerUserId);

  const set: Partial<typeof organizationKeyDates.$inferInsert> = { updatedAt: new Date() };
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.date !== undefined) set.date = patch.date;
  if (patch.recursAnnually !== undefined) set.recursAnnually = patch.recursAnnually;
  if (patch.remindDaysBefore !== undefined) set.remindDaysBefore = patch.remindDaysBefore;
  if (patch.ownerUserId !== undefined) set.ownerUserId = patch.ownerUserId;
  if (patch.portalVisible !== undefined) set.portalVisible = patch.portalVisible;
  if (patch.notes !== undefined) set.notes = patch.notes;

  const [row] = await db
    .update(organizationKeyDates)
    .set(set)
    .where(and(eq(organizationKeyDates.id, id), eq(organizationKeyDates.orgId, orgId)))
    .returning();
  if (!row) throw new DeliverableServiceError('Not found', 404, 'NOT_FOUND');
  return row;
}

export async function deleteKeyDate(orgId: string, id: string, actor: DeliverableActor): Promise<void> {
  requireOrgAccess(actor, orgId);
  const [row] = await db
    .delete(organizationKeyDates)
    .where(and(eq(organizationKeyDates.id, id), eq(organizationKeyDates.orgId, orgId)))
    .returning({ id: organizationKeyDates.id });
  if (!row) throw new DeliverableServiceError('Not found', 404, 'NOT_FOUND');
}

// ---------------------------------------------------------------------------
// W02 — daily sweep (system callers, no actor)
// ---------------------------------------------------------------------------

/**
 * Synthetic actor: only ever written to audit_logs.actor_id (NOT NULL, no FK
 * to users). createTicket writes no `tickets` column from it.
 */
const KEY_DATE_SWEEP_ACTOR = { userId: '00000000-0000-0000-0000-000000000000', name: 'Key dates' } as const;

/**
 * Spec §5.3 step 5. Runs the annual roll-forward FIRST, so a recurring date
 * that passed while the sweep was down advances to next year and is reminded
 * for that — never a reminder ticket for a date already gone. Then reminders:
 * `date - remind_days_before <= today <= date`, and `reminded_for_date IS
 * DISTINCT FROM date`. The stamp IS the claim: a CAS UPDATE in the same
 * transaction as the ticket, so a concurrent sweep or a crash can neither
 * double the ticket nor strand the stamp without one.
 */
export async function sweepKeyDateReminders(today: string): Promise<number> {
  await rollForwardAnnualKeyDates(today);

  const due = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({
        id: organizationKeyDates.id, orgId: organizationKeyDates.orgId,
        label: organizationKeyDates.label, kind: organizationKeyDates.kind,
        date: organizationKeyDates.date, ownerUserId: organizationKeyDates.ownerUserId,
      })
      .from(organizationKeyDates)
      .where(and(
        isNotNull(organizationKeyDates.remindDaysBefore),
        sql`${organizationKeyDates.date} - ${organizationKeyDates.remindDaysBefore} <= ${today}::date`,
        gte(organizationKeyDates.date, today),
        sql`${organizationKeyDates.remindedForDate} IS DISTINCT FROM ${organizationKeyDates.date}`,
        // An archived tenant inside its purge countdown gets no tickets.
        buildAutomationEligibleOrgPredicate(organizationKeyDates.orgId),
      )), 'keyDateSweep.selectDue'));

  let created = 0;
  for (const row of due) {
    // Per row, like the roll-forward above: one tenant's failure must not cost
    // every other tenant its reminders for the day.
    try {
      created += await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        const claimed = await db.update(organizationKeyDates)
          .set({ remindedForDate: row.date, updatedAt: new Date() })
          .where(and(eq(organizationKeyDates.id, row.id),
            sql`${organizationKeyDates.remindedForDate} IS DISTINCT FROM ${row.date}::date`))
          .returning({ id: organizationKeyDates.id });
        if (claimed.length === 0) return 0;

        const ticket = await createPlannedWorkTicket({
          orgId: row.orgId, workKind: 'deliverable',
          subject: `Key date: ${row.label} — ${row.date}`,
          description: `This ${String(row.kind).replace(/_/g, ' ')} key date falls on ${row.date}.`,
          dueDate: new Date(`${row.date}T00:00:00.000Z`),
          assigneeId: row.ownerUserId ?? null,
          categoryId: null,
        }, KEY_DATE_SWEEP_ACTOR, { orgId: row.orgId, keyDateId: row.id });
        if (ticket.kind === 'service_management_off') {
          console.warn('[deliverables] key-date reminder recorded without a ticket (Service Management off)',
            `orgId=${row.orgId}`, `keyDateId=${row.id}`);
          return 1;
        }
        await db.update(organizationKeyDates)
          .set({ reminderTicketId: ticket.ticketId, updatedAt: new Date() })
          .where(eq(organizationKeyDates.id, row.id));
        return 1;
      }, 'keyDateSweep.remind'));
    } catch (err) {
      // The claim rolled back with the transaction, so tomorrow's run retries
      // this key date; every other org's reminder still goes out today.
      console.error('[deliverables] key-date reminder failed', `orgId=${row.orgId}`, `keyDateId=${row.id}`,
        err instanceof Error ? err.message : String(err));
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return created;
}

/** First anniversary of `date` on or after `today`, stepping from the stored
 *  date so a Feb 29 anniversary lands back on Feb 29 in leap years. */
function nextAnniversary(date: string, today: string): string {
  for (let years = 1; ; years++) {
    const next = addMonthsClamped(date, 12 * years);
    if (next >= today) return next;
  }
}

/**
 * A recurring key date in the past advances to its next anniversary and drops
 * its reminder stamps, so next year's reminder can fire at all. CAS'd on the
 * date that was read: a concurrent edit by a technician wins.
 */
export async function rollForwardAnnualKeyDates(today: string): Promise<number> {
  const stale = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ id: organizationKeyDates.id, orgId: organizationKeyDates.orgId, date: organizationKeyDates.date })
      .from(organizationKeyDates)
      .where(and(
        eq(organizationKeyDates.recursAnnually, true),
        lt(organizationKeyDates.date, today),
        buildAutomationEligibleOrgPredicate(organizationKeyDates.orgId),
      )),
    'keyDateSweep.selectStale'));

  let rolled = 0;
  for (const row of stale) {
    // One transaction per row, and one failure per row: this is a fleet-wide
    // loop, so a single tenant's bad row must not roll back every other
    // tenant's roll-forward — nor abort the reminder pass that follows.
    try {
      const updated = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.update(organizationKeyDates)
          .set({ date: nextAnniversary(row.date, today), remindedForDate: null, reminderTicketId: null, updatedAt: new Date() })
          .where(and(eq(organizationKeyDates.id, row.id), eq(organizationKeyDates.date, row.date)))
          .returning({ id: organizationKeyDates.id }),
        'keyDateSweep.rollForward'));
      rolled += updated.length;
    } catch (err) {
      console.error('[deliverables] key-date roll-forward failed', `orgId=${row.orgId}`, `keyDateId=${row.id}`,
        err instanceof Error ? err.message : String(err));
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return rolled;
}
