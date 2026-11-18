/**
 * The ticket row lock every ticket-child writer takes FIRST (#8972 W0, spec
 * "Ticketing: merge, SLA calendars, routing" §3.5).
 *
 * Invariant: a writer of a ticket child row (`TICKET_CHILD_TABLES` in
 * ./ticketChildWriters.ts) locks the ticket row before it locks or writes the
 * child row. The shape is the approval spec's §5.2 pattern:
 *
 *   read unlocked → lock the ticket → lock / write the child → re-check
 *
 * Why it matters: `ticket_comments` carries an AFTER trigger
 * (`breeze_ticket_comments_touch_parent_feed`) that UPDATEs the parent ticket,
 * and every child INSERT takes a FOR KEY SHARE lock on the ticket through its
 * FK. A writer that locks a child row and only then reaches the ticket (an
 * edited comment, a deleted alert link followed by its feed comment) forms an
 * AB-BA cycle with any writer that holds the ticket and then touches the same
 * child row (moveTicketOrg, the device mover, and — from W1 — ticket merge).
 * Postgres resolves that cycle by killing one side with 40P01.
 *
 * Global order this lock sits in (#3778, ticketService.moveTicketOrg):
 *   ticket_links per-org advisory lock → organizations FOR SHARE →
 *   action_intents → ticket_drafts → ai_agent_runs → ai_operator_task_targets →
 *   tickets → ticket_comments → TICKET_CHILD_ORG_REWRITE_LOCK_ORDER.
 * So a caller that also needs an org SHARE or a draft lock takes it BEFORE
 * calling this helper, and nothing below `tickets` is locked before it.
 *
 * The lock is `FOR UPDATE` (the same SQL `timeEntryService.lockTicketRow` used
 * since #3778) and is held until the TOP-LEVEL transaction ends (the request
 * transaction from `withDbAccessContext`, or a system transaction). Taking it
 * inside a `db.transaction` savepoint does not shorten that: a released
 * savepoint keeps its row locks; only a savepoint rolled back frees them.
 * RLS still applies: a ticket the
 * caller's context cannot see (or cannot lock — FOR UPDATE is checked against
 * the UPDATE policy) reads as missing, and the caller maps `null` to the same
 * not-found error it raised before this helper existed.
 */
import { inArray, eq, asc } from 'drizzle-orm';
import { db } from '../db';
import { tickets } from '../db/schema';
import { readOrgStampingDefaultsMany } from './orgCurrencyCore';

/** Per-file executor type (repo precedent: routes/backup/providers.ts). */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Only `select` is needed to take the lock, so narrower connections (a `Pick` of db) qualify. */
type LockExecutor = Pick<typeof db, 'select'>;

/**
 * The ticket state a writer re-checks under the lock. `mergedIntoTicketId`
 * (#8972 W1) is the tombstone guard's input: `assertTicketNotMerged(row)`
 * (services/ticketMerge/errors.ts) right after the lock.
 */
export interface LockedTicketRow {
  id: string;
  orgId: string;
  partnerId: string | null;
  status: (typeof tickets.$inferSelect)['status'];
  deletedAt: Date | null;
  workKind: (typeof tickets.$inferSelect)['workKind'];
  mergedIntoTicketId: string | null;
}

// Built per call, not at module load: suites that partially mock
// `../db/schema` must not fail on import (see ticketChecklistService's note).
const lockedTicketColumns = () => ({
  id: tickets.id,
  orgId: tickets.orgId,
  partnerId: tickets.partnerId,
  status: tickets.status,
  deletedAt: tickets.deletedAt,
  workKind: tickets.workKind,
  mergedIntoTicketId: tickets.mergedIntoTicketId,
});

/**
 * Lock one ticket row `FOR UPDATE` on `tx`. Returns `null` when the row does
 * not exist or is not visible to the caller's RLS context; the caller throws
 * its own not-found error so every writer keeps its existing 404 shape.
 * Re-locking a row this transaction already holds is a no-op.
 *
 * `skipLocked` (a background sweep that must not queue behind a request)
 * returns `null` for a row another transaction holds, instead of waiting.
 */
export async function lockTicketForWrite(
  tx: LockExecutor,
  ticketId: string,
  opts: { skipLocked?: boolean } = {},
): Promise<LockedTicketRow | null> {
  const query = tx
    .select(lockedTicketColumns())
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  const rows = opts.skipLocked ? await query.for('update', { skipLocked: true }) : await query.for('update');
  return (rows[0] as LockedTicketRow | undefined) ?? null;
}

/**
 * Lock several ticket rows for a writer that touches more than one ticket
 * (#4617 spec §5.2, generalized from timeEntryService.lockTicketsInOrder):
 *
 *   1. `orgShare` — every named organization `FOR SHARE`, ascending, FIRST
 *      (`organizations` is outermost in the global order). Pass it only when
 *      it is the transaction's first lock (the time-entry creation barrier
 *      `organizations SHARE → tickets FOR UPDATE`). A writer that already
 *      holds a row below `organizations` (the billing chain: invoice and
 *      contract rows) must not take it late.
 *   2. the ticket rows `FOR UPDATE` in ascending id order, in ONE statement
 *      (rows are locked in the order the sort emits them), so two writers that
 *      cross the same tickets serialize instead of deadlocking.
 *
 * Returns the locked rows keyed by id; ids missing from the map were not
 * visible. Null / duplicate ids are ignored.
 */
export async function lockTicketsForWrite(
  tx: DbExecutor,
  ticketIds: ReadonlyArray<string | null | undefined>,
  opts: { orgShare?: readonly string[] } = {},
): Promise<Map<string, LockedTicketRow>> {
  if (opts.orgShare && opts.orgShare.length > 0) {
    await readOrgStampingDefaultsMany(tx, [...opts.orgShare]);
  }
  const ids = [...new Set(ticketIds.filter((id): id is string => !!id))].sort();
  if (ids.length === 0) return new Map();
  const rows = (await tx
    .select(lockedTicketColumns())
    .from(tickets)
    .where(inArray(tickets.id, ids))
    .orderBy(asc(tickets.id))
    .for('update')) as LockedTicketRow[];
  return new Map(rows.map((r) => [r.id, r]));
}
