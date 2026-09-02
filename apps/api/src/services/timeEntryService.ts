import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { timeEntries, ticketParts, tickets, ticketCategories, organizations, partners, users, ticketComments } from '../db/schema';
import { emitTimeEntryEvent } from './timeEntryEvents';
import { getOrgBillingDefaults } from './ticketConfigService';
import { readOrgStampingDefaults } from './orgCurrencyCore';
import { CURRENCY_CODES, isZeroDecimal, isRepresentableInCurrency, minorUnitExponent, roundToCurrency, multiplyToCurrency, toMinorUnits, fromMinorUnits } from '@breeze/shared';
import type { CreateTimeEntryInput, UpdateTimeEntryInput, TicketPartInput, BillingStatus, TimeEntrySource } from '@breeze/shared';

export type TimeEntryServiceErrorCode =
  | 'TICKET_NOT_FOUND'
  | 'TICKET_WRONG_PARTNER'
  | 'TICKET_ORG_DENIED'
  | 'ENTRY_NOT_FOUND'
  | 'PART_NOT_FOUND'
  | 'NOT_OWN_ENTRY'
  | 'ADMIN_REQUIRED'
  | 'APPROVED_IMMUTABLE'
  | 'NO_RUNNING_TIMER'
  | 'ENTRY_RUNNING'
  | 'PARTNER_UNRESOLVABLE'
  | 'INVALID_RANGE'
  | 'CURRENCY_MISMATCH'
  /** 409 — issueInvoice already flipped the row to `billed`; only description-class fields may change. */
  | 'ENTRY_BILLED'
  | 'PART_BILLED'
  // Wave-6 release gate (W6-G4-2/3): a rate or part price that cannot be expressed
  // in the row's stamped currency (¥100.50). Refused, never silently rounded.
  | 'PRICE_NOT_REPRESENTABLE'
  // W06 (#3900) auto-suggested entries
  | 'SUGGESTIONS_DISABLED'
  | 'SIGNAL_NOT_FOUND'
  | 'SIGNAL_NOT_ENDED'
  | 'SUGGESTION_DISMISSED'
  // Distinct from SUGGESTION_DISMISSED: SOME members of a merged suggestion
  // are already confirmed to a different entry. `code` is the machine-readable
  // half of the contract, so the two 409s must not share one (review W06A).
  | 'SUGGESTION_PARTIALLY_LOGGED'
  | 'SUGGESTION_ENTRY_DELETED'
  | 'ORG_MISMATCH'
  | 'ENDED_AT_REQUIRED'
  | 'RANGE_OUTSIDE_SIGNAL'
  | 'INVALID_TZ'
  | 'ORG_DENIED';

export class TimeEntryServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 410 | 422 = 400,
    public code?: TimeEntryServiceErrorCode
  ) {
    super(message);
    this.name = 'TimeEntryServiceError';
  }
}

export type TimeEntryAuditMutation = {
  action:
    | 'time_entry.created'
    | 'time_entry.started'
    | 'time_entry.stopped'
    | 'time_entry.updated'
    | 'time_entry.deleted'
    | 'time_entry.approved'
    | 'time_entry.unapproved'
    // W06 (#3900): the suggestions ledger writes, filed under resourceType
    // 'time_suggestion' by the route audit writers — a dismissal is not a
    // time entry.
    | 'time_suggestion.dismissed'
    | 'time_suggestion.undismissed';
  entryId: string;
  orgId: string | null;
  /** W06 (#3900): the server-stamped provenance of the affected entry. */
  source?: TimeEntrySource;
};

export interface TimeEntryActor {
  userId: string;
  name?: string;
  email?: string;
  /** auth.partnerId — null only for system scope */
  partnerId: string | null;
  /** wildcard-permission holders (computed in routes): may manage others' entries + approve */
  manageAll: boolean;
  /**
   * auth.accessibleOrgIds — the org-axis allowlist. `null` = system scope
   * (unrestricted). A partner user with orgAccess='selected' carries only the
   * granted org ids here, so a ticket in a non-granted org under the same
   * partner is denied (org-axis check in resolveTicketLink). Threaded from the
   * route's AuthContext so the system-context ticket read can't be used to
   * write onto a ticket the caller can't actually see.
   */
  accessibleOrgIds: string[] | null;
  recordAuditMutation?: (mutation: TimeEntryAuditMutation) => void;
}

function recordAuditMutation(
  actor: TimeEntryActor,
  action: TimeEntryAuditMutation['action'],
  entry: { id: string; orgId?: string | null; source?: string | null },
): void {
  actor.recordAuditMutation?.({
    action,
    entryId: entry.id,
    orgId: entry.orgId ?? null,
    ...(entry.source ? { source: entry.source as TimeEntrySource } : {}),
  });
}

/** Floored whole minutes — matches the SLA pause-folding convention. */
export function computeDurationMinutes(startedAt: Date, endedAt: Date): number {
  return Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000);
}

const toRate = (rate: number | null | undefined): string | null =>
  rate == null ? null : rate.toFixed(2);

/**
 * Wave-6 release gate (W6-G4-2 / W6-G4-3): money persisted on a time entry or a
 * ticket part must be representable in that row's OWN stamped currency snapshot
 * (spec §7 — a snapshot is never reinterpreted, and never re-rounded).
 * `currencyCode` null = a standalone, money-less row; nothing to validate.
 */
function assertRepresentable(value: string | null, currencyCode: string | null): void {
  if (value == null || currencyCode == null) return;
  if (!isRepresentableInCurrency(value, currencyCode)) {
    throw new TimeEntryServiceError(
      `${value} is not representable in ${currencyCode} — this currency has ${minorUnitExponent(currencyCode)} decimal place(s)`,
      400, 'PRICE_NOT_REPRESENTABLE'
    );
  }
}

interface TicketForTimeTracking {
  id: string;
  partnerId: string | null;
  orgId: string;
  categoryId: string | null;
}

// System-context read: org-scoped RLS would hide cross-boundary rows during
// validation (ticketService.ts / PR #1243 lesson).
async function getTicketForTimeTracking(ticketId: string): Promise<TicketForTimeTracking> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: tickets.id, partnerId: tickets.partnerId, orgId: tickets.orgId, categoryId: tickets.categoryId })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .limit(1)
    )
  );
  const ticket = rows[0];
  if (!ticket) throw new TimeEntryServiceError('Ticket not found', 404, 'TICKET_NOT_FOUND');
  return ticket;
}

/**
 * Resolves the ticket's org: its partner (legacy tickets carry no partner_id
 * and fall back to the org's) and — always — its currency. Every monetary
 * value on a ticket-linked row is expressed in this currency (spec §7), so the
 * org read is unconditional even when the ticket already names its partner.
 * System-context read for the same reason as getTicketForTimeTracking.
 */
async function resolveTicketOrg(
  ticket: TicketForTimeTracking
): Promise<{ partnerId: string | null; currencyCode: string } | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ partnerId: organizations.partnerId, currencyCode: organizations.currencyCode })
        .from(organizations)
        .where(eq(organizations.id, ticket.orgId))
        .limit(1)
    )
  );
  const org = rows[0];
  if (!org) return null;
  return { partnerId: ticket.partnerId ?? org.partnerId ?? null, currencyCode: org.currencyCode };
}

async function getCategoryDefaults(
  categoryId: string
): Promise<{ defaultBillable: boolean; defaultHourlyRate: string | null; rateCurrency: string | null } | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: ticketCategories.id,
          partnerId: ticketCategories.partnerId,
          defaultBillable: ticketCategories.defaultBillable,
          defaultHourlyRate: ticketCategories.defaultHourlyRate,
          rateCurrency: ticketCategories.rateCurrency
        })
        .from(ticketCategories)
        .where(eq(ticketCategories.id, categoryId))
        .limit(1)
    )
  );
  return rows[0] ?? null;
}

/**
 * Validates a ticket link for the acting partner AND org axis, then resolves
 * billing defaults (spec D2: category default + manual override). Returns the
 * denormalization payload for the time-entry/part row.
 *
 * The ticket is read under system scope (see getTicketForTimeTracking), so the
 * request's org-axis RLS does NOT gate it. We therefore re-apply the caller's
 * org-axis allowlist here: a partner user with orgAccess='selected' can target
 * only tickets in granted orgs, never an arbitrary org under the same partner.
 * `accessibleOrgIds === null` is system scope (unrestricted) — behavior
 * unchanged. Mirrors getScopedTicketOr404 / auth.canAccessOrg semantics.
 */
/** Spec §1.6 / §7 match-or-skip: a default rate applies only when it was
 *  entered under the org's currency. Never converts, never falls through to a
 *  wrong-currency number. */
export function resolveDefaultRate(
  orgCurrency: string,
  org: { defaultHourlyRate: string | null; rateCurrency: string } | null,
  category: { defaultHourlyRate: string | null; rateCurrency: string | null } | null
): string | null {
  if (org?.defaultHourlyRate != null && org.rateCurrency === orgCurrency) return org.defaultHourlyRate;
  if (category?.defaultHourlyRate != null && category.rateCurrency === orgCurrency) return category.defaultHourlyRate;
  return null;
}

async function resolveTicketLink(ticketId: string, actor: TimeEntryActor) {
  const ticket = await getTicketForTimeTracking(ticketId);
  const org = await resolveTicketOrg(ticket);
  const ticketPartnerId = org?.partnerId ?? null;
  if (!ticketPartnerId) {
    throw new TimeEntryServiceError('Ticket partner is unresolvable', 400, 'PARTNER_UNRESOLVABLE');
  }
  if (actor.partnerId && ticketPartnerId !== actor.partnerId) {
    throw new TimeEntryServiceError('Ticket must belong to the same partner', 400, 'TICKET_WRONG_PARTNER');
  }
  // Org-axis gate: non-system callers must have access to the ticket's org.
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(ticket.orgId)) {
    throw new TimeEntryServiceError('Ticket not found', 404, 'TICKET_ORG_DENIED');
  }
  const [orgSettings, category] = await Promise.all([
    getOrgBillingDefaults(ticket.orgId),
    ticket.categoryId ? getCategoryDefaults(ticket.categoryId) : Promise.resolve(null)
  ]);
  return {
    ticket,
    partnerId: ticketPartnerId,
    // The currency every monetary value on this link is expressed in (spec §7).
    currencyCode: org!.currencyCode,
    // D6: per-entry explicit override (applied by callers) → org default → category default → false
    defaultBillable: orgSettings?.defaultBillable ?? category?.defaultBillable ?? false,
    // D6 + match-or-skip: a default rate is used only when entered in the org's currency.
    defaultHourlyRate: resolveDefaultRate(org!.currencyCode, orgSettings, category)
  };
}

/**
 * Lock the ticket row on the REQUEST transaction (global order: tickets →
 * time_entries → ticket_parts). Held until request commit (withDbAccessContext
 * is one transaction, db/index.ts), so a concurrent moveTicketOrg / device move
 * — which UPDATE tickets first — queues behind this create/relink and then sees
 * the new row under its guard. RLS still scopes the read to the caller's axis.
 */
async function lockTicketRow(ticketId: string): Promise<{ id: string; orgId: string }> {
  const rows = await db
    .select({ id: tickets.id, orgId: tickets.orgId })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1)
    .for('update');
  const row = rows[0];
  if (!row) throw new TimeEntryServiceError('Ticket not found', 404, 'TICKET_NOT_FOUND');
  return row;
}

/**
 * resolveTicketLink (access gates, unlocked system-context reads) THEN the
 * lock; if the ticket moved between the two, resolve once more under the lock
 * so the stamped currency is the org the row will actually land in.
 */
async function resolveAndLockTicketLink(ticketId: string, actor: TimeEntryActor) {
  let link = await resolveTicketLink(ticketId, actor);
  // Creation barrier (#3778), ticket-child protocol:
  //   organizations FOR SHARE -> tickets FOR UPDATE -> time/part INSERT.
  // resolveTicketLink's reads run in a SYSTEM context (a separate transaction),
  // so they take no lock here — this SHARE is the request transaction's FIRST
  // lock, which is what keeps `organizations` outermost. Held to commit, so a
  // concurrent changeOrgCurrency either counts the row it is about to see or
  // this stamp is already the new currency.
  let org = await readOrgStampingDefaults(db, link.ticket.orgId);
  const locked = await lockTicketRow(ticketId);
  if (locked.orgId !== link.ticket.orgId) {
    // The ticket moved org between the unlocked resolve and the ticket lock.
    // The second org SHARE is taken while holding the ticket lock, which cannot
    // cycle: every other holder of an org lock takes SHARE too (SHARE/SHARE do
    // not conflict) and the only FOR UPDATE holder, changeOrgCurrency, locks
    // nothing else at all.
    org = await readOrgStampingDefaults(db, locked.orgId);
    link = await resolveTicketLink(ticketId, actor);
  }
  // The locked value is authoritative. A disagreement means a currency change
  // committed between the unlocked resolve and the barrier; re-resolve so the
  // stamp AND the match-or-skip default rate come from the new currency.
  if (org.currencyCode !== link.currencyCode) link = await resolveTicketLink(ticketId, actor);
  return link;
}

/** Supported zero-decimal codes (JPY, KRW, …) — every other supported currency has 2 minor-unit digits (spec §12). */
const ZERO_DECIMAL_CODES: string[] = CURRENCY_CODES.filter((code) => isZeroDecimal(code));

/**
 * SQL scale for a per-row ROUND at the row's own currency minor unit — the
 * SQL twin of `roundToCurrency` (PG `ROUND(numeric, int)` is half away from
 * zero, which is half-up for the non-negative amounts these rows carry).
 */
function minorUnitScaleSql(currencyColumn: AnyColumn): SQL<number> {
  return ZERO_DECIMAL_CODES.length > 0
    ? sql<number>`CASE WHEN ${currencyColumn} IN (${sql.join(ZERO_DECIMAL_CODES.map((code) => sql`${code}`), sql`, `)}) THEN 0 ELSE 2 END`
    : sql<number>`2`;
}

/** Standalone entries: money still needs a currency (CHECK time_entries_currency_required_when_rate_chk). */
async function getPartnerCurrency(partnerId: string): Promise<string> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.select({ currencyCode: partners.currencyCode }).from(partners).where(eq(partners.id, partnerId)).limit(1)
    )
  );
  const code = rows[0]?.currencyCode;
  if (!code) throw new TimeEntryServiceError('Partner is unresolvable for this entry', 400, 'PARTNER_UNRESOLVABLE');
  return code;
}

/** Fields a `billed` row refuses to change (issueInvoice froze the money). */
const BILLED_LOCKED_ENTRY_FIELDS = ['startedAt', 'endedAt', 'isBillable', 'hourlyRate', 'billingStatus', 'ticketId'] as const;
const BILLED_LOCKED_PART_FIELDS = ['quantity', 'unitPrice', 'costBasis', 'isBillable', 'billingStatus', 'catalogItemId'] as const;

/** "45m", "1h 30m", "2h" — shared wording for feed comments. */
function fmtMinutes(minutes: number | null): string {
  const m = Math.max(0, minutes ?? 0);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

/** D4: internal-only system feed line; never isPublic. No-op without a ticket.
 *  Swallows insert errors so a failed comment never rolls back a committed mutation. */
async function insertTimeEntryFeedComment(
  ticketId: string | null,
  actor: TimeEntryActor,
  content: string
): Promise<void> {
  if (!ticketId) return;
  try {
    await db.insert(ticketComments).values({
      ticketId,
      userId: actor.userId,
      authorName: actor.name ?? null,
      authorType: 'internal',
      commentType: 'time_entry',
      content,
      isPublic: false,
      oldValue: null,
      newValue: null
    });
  } catch (err) {
    console.error('[timeEntryService] feed comment insert failed', err);
  }
}

/**
 * Internal-only provenance for createTimeEntry. Never part of a public zod
 * schema (spec D5): routes call createTimeEntry(input, actor) and get
 * 'manual'; only timeSuggestionService passes a source. `orgLink` is used
 * when there is no ticket — a ticket always wins because its path holds the
 * ticket + org locks (creation barrier #3778).
 */
export interface TimeEntryProvenance {
  source: TimeEntrySource;
  orgLink?: { orgId: string; currencyCode: string } | null;
}

/**
 * Org-only link for standalone entries that still know their org (a remote
 * session's org, later the location wave's `/start {orgId}`). Mirrors the
 * access half of resolveTicketLink, then takes the same `organizations FOR
 * SHARE` the ticket path takes so time_entries_currency_required_when_org_chk
 * holds against a concurrent currency change.
 *
 * Lock order: the ownership SELECT below takes NO row lock, so the SHARE inside
 * readOrgStampingDefaults is still this transaction's FIRST lock and
 * `organizations` stays outermost (same reasoning as resolveAndLockTicketLink,
 * whose access reads run unlocked in a separate system transaction).
 */
export async function resolveAndLockOrgLink(
  orgId: string,
  actor: TimeEntryActor,
): Promise<{ orgId: string; currencyCode: string }> {
  if (!entryOrgAllowed({ orgId }, actor.accessibleOrgIds)) {
    throw new TimeEntryServiceError('Access to this organization denied', 403, 'ORG_DENIED');
  }
  const [org] = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org || (actor.partnerId && org.partnerId !== actor.partnerId)) {
    throw new TimeEntryServiceError('Access to this organization denied', 403, 'ORG_DENIED');
  }
  const stamped = await readOrgStampingDefaults(db, orgId);
  return { orgId, currencyCode: stamped.currencyCode };
}

export async function createTimeEntry(
  input: CreateTimeEntryInput,
  actor: TimeEntryActor,
  provenance: TimeEntryProvenance = { source: 'manual' },
) {
  let partnerId = actor.partnerId;
  let orgId: string | null = null;
  let defaultBillable = false;
  let defaultRate: string | null = null;
  let currencyCode: string | null = null;

  if (input.ticketId) {
    // Lock order tickets → time_entries: the ticket row is held until request
    // commit, so a concurrent org-move cannot slip between stamping and insert.
    const link = await resolveAndLockTicketLink(input.ticketId, actor);
    partnerId = link.partnerId;
    orgId = link.ticket.orgId;
    currencyCode = link.currencyCode;
    defaultBillable = link.defaultBillable;
    defaultRate = link.defaultHourlyRate;
  } else if (provenance.orgLink) {
    // W06 (#3900): no ticket, but the signal knows its org — stamp org and the
    // org's locked currency so time_entries_currency_required_when_org_chk holds.
    orgId = provenance.orgLink.orgId;
    currencyCode = provenance.orgLink.currencyCode;
  }
  if (!partnerId) {
    throw new TimeEntryServiceError('Partner is unresolvable for this entry', 400, 'PARTNER_UNRESOLVABLE');
  }

  if (input.endedAt.getTime() <= input.startedAt.getTime()) {
    throw new TimeEntryServiceError('endedAt must be after startedAt', 400, 'INVALID_RANGE');
  }
  if (!input.ticketId && currencyCode == null && input.hourlyRate != null) {
    // Standalone money is entered in the technician's partner currency. An
    // org-linked suggestion (W06) already carries the ORG's locked currency —
    // never overwrite that with the partner's, or the row's money would be
    // denominated in a currency the org never uses.
    currencyCode = await getPartnerCurrency(partnerId);
  }

  const hourlyRate = input.hourlyRate !== undefined ? toRate(input.hourlyRate) : defaultRate;
  assertRepresentable(hourlyRate, currencyCode);

  const rows = await db
    .insert(timeEntries)
    .values({
      partnerId,
      orgId,
      ticketId: input.ticketId ?? null,
      userId: actor.userId,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMinutes: computeDurationMinutes(input.startedAt, input.endedAt),
      description: input.description ?? null,
      // D2: apply category defaults only when input omits the field
      isBillable: input.isBillable !== undefined ? input.isBillable : defaultBillable,
      hourlyRate,
      // Snapshot (spec §7): null only for standalone, money-less entries; never restamped.
      currencyCode,
      billingStatus: input.billingStatus ?? 'not_billed',
      // W06 (#3900): server-stamped provenance; no public schema accepts it.
      source: provenance.source
    })
    .returning();
  const entry = rows[0]!;
  recordAuditMutation(actor, 'time_entry.created', entry);

  await insertTimeEntryFeedComment(
    entry.ticketId,
    actor,
    `${actor.name ?? 'Technician'} logged ${fmtMinutes(entry.durationMinutes)}${entry.isBillable ? ' (billable)' : ''}`
  );

  await emitTimeEntryEvent({
    type: 'time_entry.created',
    timeEntryId: entry.id,
    partnerId,
    ticketId: entry.ticketId,
    actorUserId: actor.userId,
    payload: {
      userId: actor.userId,
      durationMinutes: entry.durationMinutes,
      isBillable: entry.isBillable,
      source: provenance.source
    }
  });
  return entry;
}

/** An entry exactly as this service returns it. Exported so callers (the
 *  suggestions confirm path) can name it without re-deriving the selection. */
export type TimeEntryRow = Awaited<ReturnType<typeof createTimeEntry>>;

/**
 * Re-read one entry with the SAME selection createTimeEntry returns. Runs in
 * the caller's DB context, so the partner-axis time_entries policy is the
 * tenant wall; callers that need org-axis narrowing still apply
 * `entryOrgAllowed`. Used by the confirm replay branch so `200 {entry,
 * replay:true}` and `201 {entry}` are shape-identical — a raw `SELECT *` would
 * return snake_case columns and silently break `entry.durationMinutes` on
 * every client.
 */
export async function readTimeEntryById(id: string): Promise<TimeEntryRow | null> {
  const [row] = await db.select().from(timeEntries).where(eq(timeEntries.id, id)).limit(1);
  return (row as TimeEntryRow | undefined) ?? null;
}

/** Stops the actor's running entry if any (CAS on ended_at IS NULL). Returns the stopped row or null. */
async function stopRunningEntry(
  actor: TimeEntryActor,
  overrides: { description?: string; isBillable?: boolean } = {}
) {
  const now = new Date();
  // CAS on ended_at IS NULL: two concurrent stops -> one winner, one no-op.
  // Duration computed in SQL from the row's own started_at (avoids a pre-select round-trip).
  const rows = await db
    .update(timeEntries)
    .set({
      endedAt: now,
      durationMinutes: sql`FLOOR(EXTRACT(EPOCH FROM (${now.toISOString()}::timestamp - ${timeEntries.startedAt})) / 60)::int`,
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      ...(overrides.isBillable !== undefined ? { isBillable: overrides.isBillable } : {})
    })
    .where(and(eq(timeEntries.userId, actor.userId), isNull(timeEntries.endedAt)))
    .returning();
  return rows[0] ?? null;
}

export async function startTimer(input: { ticketId?: string; description?: string }, actor: TimeEntryActor) {
  let partnerId = actor.partnerId;
  let orgId: string | null = null;
  let defaultBillable = false;
  let defaultRate: string | null = null;
  let currencyCode: string | null = null;

  if (input.ticketId) {
    // Same lock discipline as createTimeEntry (tickets → time_entries).
    const link = await resolveAndLockTicketLink(input.ticketId, actor);
    partnerId = link.partnerId;
    orgId = link.ticket.orgId;
    currencyCode = link.currencyCode;
    defaultBillable = link.defaultBillable;
    defaultRate = link.defaultHourlyRate;
  }
  if (!partnerId) {
    throw new TimeEntryServiceError('Partner is unresolvable for this entry', 400, 'PARTNER_UNRESOLVABLE');
  }
  if (!input.ticketId && defaultRate != null) {
    currencyCode = await getPartnerCurrency(partnerId);
  }
  // Wave-6 review: startTimer persists a resolved DEFAULT rate, so it is a money
  // write seam exactly like createTimeEntry — validate it against the snapshot
  // currency the row is about to carry. A legacy fractional default in a
  // zero-decimal currency is a 400 here, never a silently rounded time entry.
  assertRepresentable(defaultRate, currencyCode);

  const attempt = async () => {
    // D3: auto-stop the previous timer, then start the new one. The partial
    // unique index time_entries_one_running_per_user_uq is the race backstop.
    const autoStopped = await stopRunningEntry(actor);
    if (autoStopped) {
      recordAuditMutation(actor, 'time_entry.stopped', autoStopped);
      await insertTimeEntryFeedComment(
        autoStopped.ticketId,
        actor,
        `${actor.name ?? 'Technician'} logged ${fmtMinutes(autoStopped.durationMinutes)}${autoStopped.isBillable ? ' (billable)' : ''}`
      );
    }
    // ON CONFLICT DO NOTHING instead of catch-and-retry (issue #2189): the
    // request runs inside the withDbAccessContext transaction, so a raised
    // 23505 on time_entries_one_running_per_user_uq ABORTED that transaction —
    // the old catch-then-retry re-ran attempt() inside the aborted transaction,
    // the retry failed with 25P02 (not a unique violation), and postgres.js
    // substituted the original raw error back in at commit, so the intended
    // 409 below was unreachable and callers always got a raw 500. Suppressing
    // the conflict at the statement level keeps the transaction healthy: zero
    // rows back means we lost the one-running-timer-per-user race (including
    // to a running entry that partner-axis RLS hides from this context, which
    // stopRunningEntry can never see or stop).
    const rows = await db
      .insert(timeEntries)
      .values({
        partnerId: partnerId!,
        orgId,
        ticketId: input.ticketId ?? null,
        userId: actor.userId,
        startedAt: new Date(),
        endedAt: null,
        durationMinutes: null,
        description: input.description ?? null,
        isBillable: defaultBillable,
        hourlyRate: defaultRate,
        // Snapshot (spec §7): the ticket org's currency, or null for a
        // standalone timer (no rate yet); never restamped.
        currencyCode,
        billingStatus: 'not_billed',
        // W06 (#3900): a timer-started entry is provenance 'timer'.
        source: 'timer'
      })
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  };

  let entry = await attempt();
  if (!entry) {
    // Lost the race: another start slipped in between the auto-stop and our
    // insert — stop that one too and retry once.
    console.error('[timeEntryService.startTimer] running-timer conflict, retrying once');
    entry = await attempt();
  }
  if (!entry) {
    throw new TimeEntryServiceError('Timer start conflicted with a concurrent request — try again', 409, 'ENTRY_RUNNING');
  }

  recordAuditMutation(actor, 'time_entry.started', entry);
  await emitTimeEntryEvent({
    type: 'time_entry.created',
    timeEntryId: entry.id,
    partnerId,
    ticketId: entry.ticketId,
    actorUserId: actor.userId,
    payload: { userId: actor.userId, durationMinutes: null, isBillable: entry.isBillable, source: 'timer' }
  });
  return entry;
}

export async function stopTimer(input: { description?: string; isBillable?: boolean }, actor: TimeEntryActor) {
  const stopped = await stopRunningEntry(actor, input);
  if (!stopped) {
    throw new TimeEntryServiceError('No running timer', 404, 'NO_RUNNING_TIMER');
  }

  recordAuditMutation(actor, 'time_entry.stopped', stopped);
  await insertTimeEntryFeedComment(
    stopped.ticketId,
    actor,
    `${actor.name ?? 'Technician'} logged ${fmtMinutes(stopped.durationMinutes)}${stopped.isBillable ? ' (billable)' : ''}`
  );

  await emitTimeEntryEvent({
    type: 'time_entry.updated',
    timeEntryId: stopped.id,
    partnerId: stopped.partnerId,
    ticketId: stopped.ticketId,
    actorUserId: actor.userId,
    payload: { changed: ['endedAt', 'durationMinutes'] }
  });
  return stopped;
}

// ── Update / Delete ──────────────────────────────────────────────────────

/**
 * Org-axis SQL predicate for the partner-axis `time_entries` table. RLS scopes
 * this table by partner only (Shape 3) — a partner user with orgAccess='selected'
 * is NOT confined to their granted orgs by RLS, so the org allowlist must be
 * applied at the app layer (mirrors resolveTicketLink's existing check, which
 * only fires on the ticket-link path). `null` accessibleOrgIds = system scope
 * (no filter). Null-org (unlinked) entries carry no org to leak and stay in
 * scope. (#sec-review-1)
 */
function orgAxisSql(accessibleOrgIds: string[] | null): SQL | undefined {
  if (accessibleOrgIds === null) return undefined;
  if (accessibleOrgIds.length === 0) return isNull(timeEntries.orgId);
  return or(isNull(timeEntries.orgId), inArray(timeEntries.orgId, accessibleOrgIds));
}

/** In-memory counterpart of orgAxisSql for an already-fetched row. */
export function entryOrgAllowed(entry: { orgId: string | null }, accessibleOrgIds: string[] | null): boolean {
  if (accessibleOrgIds === null) return true;
  if (entry.orgId === null) return true;
  return accessibleOrgIds.includes(entry.orgId);
}

async function getEntryOr404(id: string, actor: TimeEntryActor) {
  // RLS (partner-axis) scopes this read to the actor's partner; the org-axis
  // allowlist is enforced here because RLS does not constrain it.
  // FOR UPDATE on the request transaction: every mutation locks-and-re-reads
  // the row, so an edit cannot resume on stale state after issueInvoice has
  // locked, validated and flipped it to `billed` (wave 2 lock discipline).
  const rows = await db.select().from(timeEntries).where(eq(timeEntries.id, id)).limit(1).for('update');
  const entry = rows[0];
  if (!entry) throw new TimeEntryServiceError('Time entry not found', 404, 'ENTRY_NOT_FOUND');
  if (!entryOrgAllowed(entry, actor.accessibleOrgIds)) {
    throw new TimeEntryServiceError('Time entry not found', 404, 'ENTRY_NOT_FOUND');
  }
  return entry;
}

function assertCanMutate(entry: { userId: string; isApproved: boolean }, actor: TimeEntryActor) {
  if (entry.userId !== actor.userId && !actor.manageAll) {
    throw new TimeEntryServiceError('You can only manage your own time entries', 403, 'NOT_OWN_ENTRY');
  }
  if (entry.isApproved && !actor.manageAll) {
    throw new TimeEntryServiceError('Approved entries can only be changed by an approver', 403, 'APPROVED_IMMUTABLE');
  }
}

export async function updateTimeEntry(id: string, input: UpdateTimeEntryInput, actor: TimeEntryActor) {
  // Global lock order: the TARGET ticket (relink) before the entry row.
  const link = typeof input.ticketId === 'string' ? await resolveAndLockTicketLink(input.ticketId, actor) : null;
  const entry = await getEntryOr404(id, actor); // FOR UPDATE — re-read under lock
  assertCanMutate(entry, actor);
  if (entry.billingStatus === 'billed' && BILLED_LOCKED_ENTRY_FIELDS.some((k) => input[k] !== undefined)) {
    throw new TimeEntryServiceError('This entry has been invoiced; only its description can change', 409, 'ENTRY_BILLED');
  }

  const startedAt = input.startedAt ?? entry.startedAt;
  const endedAt = input.endedAt !== undefined ? input.endedAt : entry.endedAt;
  if (endedAt && endedAt.getTime() <= startedAt.getTime()) {
    throw new TimeEntryServiceError('endedAt must be after startedAt', 400, 'INVALID_RANGE');
  }

  const set: Record<string, unknown> = {};
  const changed: string[] = [];
  if (input.startedAt !== undefined) { set.startedAt = input.startedAt; changed.push('startedAt'); }
  if (input.endedAt !== undefined) { set.endedAt = input.endedAt; changed.push('endedAt'); }
  if (input.description !== undefined) { set.description = input.description; changed.push('description'); }
  if (input.isBillable !== undefined) { set.isBillable = input.isBillable; changed.push('isBillable'); }
  if (input.hourlyRate !== undefined) { set.hourlyRate = toRate(input.hourlyRate); changed.push('hourlyRate'); }
  if (input.billingStatus !== undefined) { set.billingStatus = input.billingStatus; changed.push('billingStatus'); }

  if (input.ticketId !== undefined) {
    if (input.ticketId === null) {
      set.ticketId = null;
      set.orgId = null;
    } else {
      if (link!.partnerId !== entry.partnerId) {
        throw new TimeEntryServiceError('Ticket must belong to the same partner as the time entry', 400, 'TICKET_WRONG_PARTNER');
      }
      set.ticketId = input.ticketId;
      set.orgId = link!.ticket.orgId;
      if (entry.currencyCode == null) {
        set.currencyCode = link!.currencyCode; // first attach stamps the snapshot
      } else if (entry.currencyCode !== link!.currencyCode) {
        // Snapshots are never restamped — relinking across currencies is an error, not a conversion.
        throw new TimeEntryServiceError(
          `This entry is in ${entry.currencyCode}; the ticket's organization bills in ${link!.currencyCode} — snapshots are never restamped`,
          409, 'CURRENCY_MISMATCH'
        );
      }
    }
    // Detach leaves currencyCode untouched (the snapshot outlives the link).
    changed.push('ticketId');
  }
  // Standalone after this edit: either detached in the same call or never linked.
  const endsStandalone = input.ticketId === null || (input.ticketId === undefined && entry.ticketId == null);
  if (input.hourlyRate != null && endsStandalone && entry.currencyCode == null) {
    // First money on a standalone entry stamps the partner currency; later
    // rate edits never touch the snapshot.
    set.currencyCode = await getPartnerCurrency(entry.partnerId);
  }
  if ((input.startedAt !== undefined || input.endedAt !== undefined) && endedAt) {
    set.durationMinutes = computeDurationMinutes(startedAt, endedAt);
    changed.push('durationMinutes');
  }

  // W6-G4-2: validate the rate against the currency this row will actually carry
  // after the edit — the freshly stamped one when this call stamps it, otherwise
  // the existing snapshot.
  if (set.hourlyRate !== undefined) {
    assertRepresentable(
      set.hourlyRate as string | null,
      (set.currencyCode as string | undefined) ?? entry.currencyCode
    );
  }

  // Spec §3: any edit clears approval — re-approval required, including for approvers.
  set.isApproved = false;
  set.approvedBy = null;
  set.approvedAt = null;

  const rows = await db.update(timeEntries).set(set).where(eq(timeEntries.id, id)).returning();
  const mutated = rows[0];
  const updated = mutated ?? entry;

  if (mutated) {
    recordAuditMutation(actor, 'time_entry.updated', mutated);
  }
  await emitTimeEntryEvent({
    type: 'time_entry.updated',
    timeEntryId: id,
    partnerId: entry.partnerId,
    ticketId: (updated as typeof entry).ticketId ?? entry.ticketId,
    actorUserId: actor.userId,
    payload: { changed }
  });
  return updated;
}

export async function deleteTimeEntry(id: string, actor: TimeEntryActor) {
  const entry = await getEntryOr404(id, actor);
  assertCanMutate(entry, actor);
  const deleted = await db
    .delete(timeEntries)
    .where(eq(timeEntries.id, id))
    .returning({ id: timeEntries.id, orgId: timeEntries.orgId });
  if (deleted[0]) {
    recordAuditMutation(actor, 'time_entry.deleted', deleted[0]);
  }

  await insertTimeEntryFeedComment(
    entry.ticketId,
    actor,
    `${actor.name ?? 'Technician'} removed a${entry.durationMinutes != null ? ` ${fmtMinutes(entry.durationMinutes)}` : ''} time entry`
  );

  await emitTimeEntryEvent({
    type: 'time_entry.deleted',
    timeEntryId: id,
    partnerId: entry.partnerId,
    ticketId: entry.ticketId,
    actorUserId: actor.userId,
    payload: { userId: entry.userId }
  });
}

// ── Approval ─────────────────────────────────────────────────────────────

export interface BulkApproveResult {
  updated: number;
  skipped: number;
  skippedReasons: Partial<Record<TimeEntryServiceErrorCode, number>>;
}

export async function approveTimeEntries(ids: string[], approve: boolean, actor: TimeEntryActor): Promise<BulkApproveResult> {
  if (!actor.manageAll) {
    throw new TimeEntryServiceError('Approving time entries requires an admin role', 403, 'ADMIN_REQUIRED');
  }
  // RLS scopes to the actor's partner — out-of-partner ids look "missing", by
  // design. The org-axis allowlist is applied here too (RLS is partner-axis
  // only), so an orgAccess='selected' admin can't approve entries in a
  // non-granted org under the same partner — those ids also look "missing".
  const orgAxis = orgAxisSql(actor.accessibleOrgIds);
  const candidates = await db
    .select({ id: timeEntries.id, endedAt: timeEntries.endedAt, partnerId: timeEntries.partnerId, ticketId: timeEntries.ticketId })
    .from(timeEntries)
    .where(orgAxis ? and(inArray(timeEntries.id, ids), orgAxis) : inArray(timeEntries.id, ids));

  const found = new Map(candidates.map((c) => [c.id, c]));
  const skippedReasons: Partial<Record<TimeEntryServiceErrorCode, number>> = {};
  const skip = (reason: TimeEntryServiceErrorCode) => { skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1; };
  const eligible: string[] = [];
  for (const id of ids) {
    const row = found.get(id);
    if (!row) { skip('ENTRY_NOT_FOUND'); continue; }
    if (!row.endedAt) { skip('ENTRY_RUNNING'); continue; }
    eligible.push(id);
  }

  let updated: {
    id: string;
    partnerId: string;
    orgId: string | null;
    ticketId: string | null;
  }[] = [];
  if (eligible.length > 0) {
    updated = await db
      .update(timeEntries)
      .set(approve
        ? { isApproved: true, approvedBy: actor.userId, approvedAt: new Date() }
        : { isApproved: false, approvedBy: null, approvedAt: null })
      .where(inArray(timeEntries.id, eligible))
      .returning({
        id: timeEntries.id,
        partnerId: timeEntries.partnerId,
        orgId: timeEntries.orgId,
        ticketId: timeEntries.ticketId,
      });
  }

  for (const entry of updated) {
    recordAuditMutation(
      actor,
      approve ? 'time_entry.approved' : 'time_entry.unapproved',
      entry,
    );
  }

  if (updated.length > 0 && approve) {
    // One lifecycle event represents the bulk approval; payload.ids carries the full approved set.
    await emitTimeEntryEvent({
      type: 'time_entry.approved',
      timeEntryId: updated[0]!.id,
      partnerId: updated[0]!.partnerId,
      ticketId: updated[0]!.ticketId,
      actorUserId: actor.userId,
      payload: { ids: updated.map((u) => u.id), approvedBy: actor.userId }
    });
  }

  return {
    updated: updated.length,
    skipped: ids.length - updated.length,
    skippedReasons
  };
}

// ── Parts ────────────────────────────────────────────────────────────────

export async function addTicketPart(ticketId: string, input: TicketPartInput, actor: TimeEntryActor) {
  // Lock order tickets → ticket_parts (see lockTicketRow).
  const link = await resolveAndLockTicketLink(ticketId, actor);
  const partUnitPrice = (input.unitPrice ?? 0).toFixed(2);
  const partCostBasis = input.costBasis != null ? input.costBasis.toFixed(2) : null;
  assertRepresentable(partUnitPrice, link.currencyCode);
  assertRepresentable(partCostBasis, link.currencyCode);
  const rows = await db
    .insert(ticketParts)
    .values({
      ticketId,
      orgId: link.ticket.orgId,
      // Snapshot of the org currency at creation; never restamped.
      currencyCode: link.currencyCode,
      description: input.description,
      partNumber: input.partNumber ?? null,
      vendor: input.vendor ?? null,
      catalogItemId: input.catalogItemId ?? null,
      quantity: input.quantity.toFixed(2),
      unitPrice: partUnitPrice,
      costBasis: partCostBasis,
      isBillable: input.isBillable ?? link.defaultBillable,
      billingStatus: input.billingStatus ?? 'not_billed',
      addedBy: actor.userId,
      notes: input.notes ?? null
    })
    .returning();
  const part = rows[0];
  if (!part) {
    throw new Error('Failed to create ticket part');
  }
  return part;
}

async function getPartOr404(id: string) {
  // FOR UPDATE — lock-and-re-read before every part mutation (see getEntryOr404).
  const rows = await db.select().from(ticketParts).where(eq(ticketParts.id, id)).limit(1).for('update');
  const part = rows[0];
  if (!part) throw new TimeEntryServiceError('Part not found', 404, 'PART_NOT_FOUND');
  return part;
}

/** `set` must never contain currencyCode: the part's currency is a creation-time snapshot. */
export async function updateTicketPart(id: string, input: Partial<TicketPartInput>, _actor: TimeEntryActor) {
  const part = await getPartOr404(id);
  if (part.billingStatus === 'billed' && BILLED_LOCKED_PART_FIELDS.some((k) => input[k] !== undefined)) {
    throw new TimeEntryServiceError('This part has been invoiced; only its description, vendor, part number and notes can change', 409, 'PART_BILLED');
  }
  const set: Record<string, unknown> = {};
  if (input.description !== undefined) set.description = input.description;
  if (input.partNumber !== undefined) set.partNumber = input.partNumber;
  if (input.vendor !== undefined) set.vendor = input.vendor;
  if (input.catalogItemId !== undefined) set.catalogItemId = input.catalogItemId;
  if (input.quantity !== undefined) set.quantity = input.quantity.toFixed(2);
  if (input.unitPrice !== undefined) {
    set.unitPrice = input.unitPrice.toFixed(2);
    assertRepresentable(set.unitPrice as string, part.currencyCode);
  }
  if (input.costBasis !== undefined) {
    set.costBasis = input.costBasis != null ? input.costBasis.toFixed(2) : null;
    assertRepresentable(set.costBasis as string | null, part.currencyCode);
  }
  if (input.isBillable !== undefined) set.isBillable = input.isBillable;
  if (input.billingStatus !== undefined) set.billingStatus = input.billingStatus;
  if (input.notes !== undefined) set.notes = input.notes;
  const rows = await db.update(ticketParts).set(set).where(eq(ticketParts.id, id)).returning();
  return rows[0] ?? part;
}

export async function deleteTicketPart(id: string, _actor: TimeEntryActor) {
  await getPartOr404(id);
  await db.delete(ticketParts).where(eq(ticketParts.id, id));
}

// ── Queries ──────────────────────────────────────────────────────────────

export interface ListTimeEntriesFilters {
  userId?: string;
  ticketId?: string;
  orgId?: string;
  /**
   * The caller's org-axis allowlist (auth.accessibleOrgIds). `null`/omitted =
   * system scope (no org filter). For partner scope this confines the
   * partner-axis time_entries list to the caller's granted orgs — RLS does not
   * do it. (#sec-review-1)
   */
  accessibleOrgIds?: string[] | null;
  from?: Date;
  to?: Date;
  running?: boolean;
  billingStatus?: 'not_billed' | 'billed' | 'no_charge' | 'contract';
  approved?: boolean;
  limit: number;
  offset: number;
}

/** Lazy column-selection factory — avoids module-scope Drizzle column derefs
 *  that crash any test file mocking db/schema without a timeEntries stub.
 *  Pattern: portalSettingsColumns() in orgPortalSettings.ts. */
function entrySelection() {
  return {
    id: timeEntries.id,
    partnerId: timeEntries.partnerId,
    orgId: timeEntries.orgId,
    ticketId: timeEntries.ticketId,
    userId: timeEntries.userId,
    startedAt: timeEntries.startedAt,
    endedAt: timeEntries.endedAt,
    durationMinutes: timeEntries.durationMinutes,
    description: timeEntries.description,
    isBillable: timeEntries.isBillable,
    hourlyRate: timeEntries.hourlyRate,
    currencyCode: timeEntries.currencyCode,
    billingStatus: timeEntries.billingStatus,
    // W06 (#3900): read-only provenance on GET /, /timesheet and the
    // per-ticket list. Never accepted on a write.
    source: timeEntries.source,
    isApproved: timeEntries.isApproved,
    approvedBy: timeEntries.approvedBy,
    approvedAt: timeEntries.approvedAt,
    createdAt: timeEntries.createdAt,
    // decorations (additive, Phase 1b pattern)
    ticketNumber: tickets.internalNumber,
    ticketSubject: tickets.subject,
    userName: users.name
  };
}

function listConditions(filters: ListTimeEntriesFilters) {
  const conditions = [];
  if (filters.userId) conditions.push(eq(timeEntries.userId, filters.userId));
  if (filters.ticketId) conditions.push(eq(timeEntries.ticketId, filters.ticketId));
  if (filters.orgId) conditions.push(eq(timeEntries.orgId, filters.orgId));
  // Org-axis allowlist (partner scope): RLS is partner-axis only, so confine
  // the list to the caller's granted orgs here. Skipped for system scope
  // (accessibleOrgIds null/undefined) and when a specific in-scope orgId is set.
  if (!filters.orgId && filters.accessibleOrgIds != null) {
    const orgAxis = orgAxisSql(filters.accessibleOrgIds);
    if (orgAxis) conditions.push(orgAxis);
  }
  if (filters.from) conditions.push(gte(timeEntries.startedAt, filters.from));
  if (filters.to) conditions.push(lt(timeEntries.startedAt, filters.to));
  if (filters.running !== undefined) {
    conditions.push(filters.running ? isNull(timeEntries.endedAt) : sql`${timeEntries.endedAt} IS NOT NULL`);
  }
  if (filters.billingStatus) conditions.push(eq(timeEntries.billingStatus, filters.billingStatus));
  if (filters.approved !== undefined) conditions.push(eq(timeEntries.isApproved, filters.approved));
  return conditions;
}

export async function listTimeEntries(filters: ListTimeEntriesFilters) {
  const conditions = listConditions(filters);
  const entries = await db
    .select(entrySelection())
    .from(timeEntries)
    .leftJoin(tickets, eq(timeEntries.ticketId, tickets.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(timeEntries.startedAt), desc(timeEntries.id))
    .limit(filters.limit)
    .offset(filters.offset);

  const totalRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(timeEntries)
    .where(conditions.length ? and(...conditions) : undefined);

  return { entries, total: totalRows[0]?.count ?? 0 };
}

export async function getRunningTimer(userId: string) {
  const rows = await db
    .select(entrySelection())
    .from(timeEntries)
    .leftJoin(tickets, eq(timeEntries.ticketId, tickets.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(and(eq(timeEntries.userId, userId), isNull(timeEntries.endedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export interface TimesheetDay {
  date: string; // YYYY-MM-DD
  totalMinutes: number;
  billableMinutes: number;
  entries: Awaited<ReturnType<typeof listTimeEntries>>['entries'];
}

export interface CurrencyAmount {
  currencyCode: string;
  amount: string;
}

export async function getTimesheet(userId: string, weekStart: Date, accessibleOrgIds: string[] | null = null) {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60_000);
  // Org-axis allowlist: time_entries is partner-axis RLS only, so an
  // orgAccess='selected' partner user would otherwise see timesheet entries
  // across all orgs under the partner. Apply the same orgAxisSql predicate used
  // in listConditions / approveTimeEntries. `null` = system scope (no filter).
  // (#sec-review-1)
  const orgAxis = orgAxisSql(accessibleOrgIds);
  const baseCondition = and(
    eq(timeEntries.userId, userId),
    gte(timeEntries.startedAt, weekStart),
    lt(timeEntries.startedAt, weekEnd),
    ...(orgAxis ? [orgAxis] : [])
  );
  const entries = await db
    .select(entrySelection())
    .from(timeEntries)
    .leftJoin(tickets, eq(timeEntries.ticketId, tickets.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(baseCondition)
    .orderBy(asc(timeEntries.startedAt));

  const days = new Map<string, TimesheetDay>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getTime() + i * 24 * 60 * 60_000);
    const key = d.toISOString().slice(0, 10);
    days.set(key, { date: key, totalMinutes: 0, billableMinutes: 0, entries: [] });
  }
  for (const entry of entries) {
    const key = entry.startedAt.toISOString().slice(0, 10);
    const day = days.get(key);
    if (!day) continue; // boundary rows from TZ edges — still in totals below
    day.entries.push(entry);
    const minutes = entry.durationMinutes ?? 0;
    day.totalMinutes += minutes;
    if (entry.isBillable) day.billableMinutes += minutes;
  }
  const allDays = [...days.values()];
  const money = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.isBillable || entry.hourlyRate == null || entry.currencyCode == null) continue;
    // Labor rule: hours to 2 dp, then ONE round per row at the currency's minor
    // unit — the same per-line figure invoice assembly produces, so the sum of
    // rounded rows equals the invoice total (never "round the sum"). The product
    // is exact decimal (review #2: 0.02 × 7.25 = 0.145 → 0.15, same as the SQL
    // summary) and rows are summed as integer minor units, never as floats.
    const hours = ((entry.durationMinutes ?? 0) / 60).toFixed(2);
    const amount = multiplyToCurrency(hours, entry.hourlyRate, entry.currencyCode);
    money.set(entry.currencyCode, (money.get(entry.currencyCode) ?? 0) + toMinorUnits(amount, entry.currencyCode));
  }
  const billableAmounts: CurrencyAmount[] = [...money].map(([currencyCode, minor]) => ({
    currencyCode,
    amount: fromMinorUnits(minor, currencyCode)
  }));
  return {
    weekStart: weekStart.toISOString().slice(0, 10),
    days: allDays,
    totals: {
      totalMinutes: allDays.reduce((s, d) => s + d.totalMinutes, 0),
      billableMinutes: allDays.reduce((s, d) => s + d.billableMinutes, 0),
      billableAmounts
    }
  };
}

export async function getTicketBillingSummary(ticketId: string) {
  const timeRows = await db
    .select({
      totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)::int`,
      billableMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}) FILTER (WHERE ${timeEntries.isBillable}), 0)::int`
    })
    .from(timeEntries)
    .where(eq(timeEntries.ticketId, ticketId));

  // Money is grouped per currency — never summed across currencies.
  const timeMoney = await db
    .select({
      currencyCode: timeEntries.currencyCode,
      // Labor rule: round hours to 2 dp first, then × rate, then ONE round per
      // row at the currency's minor unit (the invoice-line figure) before summing.
      amount: sql<string>`COALESCE(SUM(ROUND(ROUND(${timeEntries.durationMinutes}::numeric / 60, 2) * ${timeEntries.hourlyRate}, ${minorUnitScaleSql(timeEntries.currencyCode)})), 0)::numeric(12,2)`
    })
    .from(timeEntries)
    .where(and(
      eq(timeEntries.ticketId, ticketId),
      eq(timeEntries.isBillable, true),
      isNotNull(timeEntries.hourlyRate),
      isNotNull(timeEntries.currencyCode)
    ))
    .groupBy(timeEntries.currencyCode)
    .orderBy(timeEntries.currencyCode);

  const partsRows = await db
    .select({ partsCount: sql<number>`COUNT(*)::int` })
    .from(ticketParts)
    .where(eq(ticketParts.ticketId, ticketId));

  const partsMoney = await db
    .select({
      currencyCode: ticketParts.currencyCode,
      // One round per row at the currency's minor unit (the invoice-line figure) before summing.
      amount: sql<string>`COALESCE(SUM(ROUND(${ticketParts.quantity} * ${ticketParts.unitPrice}, ${minorUnitScaleSql(ticketParts.currencyCode)})), 0)::numeric(12,2)`
    })
    .from(ticketParts)
    .where(and(eq(ticketParts.ticketId, ticketId), eq(ticketParts.isBillable, true)))
    .groupBy(ticketParts.currencyCode)
    .orderBy(ticketParts.currencyCode);

  const toAmounts = (rows: Array<{ currencyCode: string | null; amount: string }>): CurrencyAmount[] =>
    rows
      .filter((row): row is { currencyCode: string; amount: string } => row.currencyCode != null)
      .map((row) => ({
        currencyCode: row.currencyCode,
        amount: roundToCurrency(row.amount, row.currencyCode)
      }));

  return {
    time: {
      ...(timeRows[0] ?? { totalMinutes: 0, billableMinutes: 0 }),
      billableAmounts: toAmounts(timeMoney)
    },
    parts: {
      ...(partsRows[0] ?? { partsCount: 0 }),
      billableTotals: toAmounts(partsMoney)
    }
  };
}

interface BillableRowBase {
  date: Date;
  orgName: string | null;
  ticketNumber: string | null;
  description: string | null;
  technician: string | null;
  quantity: string;       // hours for time rows, qty for parts
  rate: string | null;    // hourly rate / unit price
  amount: string;
  currencyCode: string | null;
  billingStatus: BillingStatus;
}

export type BillableRow =
  | (BillableRowBase & { kind: 'time'; isApproved: boolean })
  | (BillableRowBase & { kind: 'part'; isApproved: null });

const toFinite = (v: string | null): number | null => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error('[timeEntryService.listBillables] non-numeric value in DB', v);
    return null;
  }
  return n;
};

export async function listBillables(
  from: Date,
  to: Date,
  orgId?: string,
  accessibleOrgIds?: string[] | null
): Promise<{ rows: BillableRow[]; totalsByCurrency: CurrencyAmount[] }> {
  // Org-axis allowlist for the partner-axis time_entries half. RLS scopes
  // time_entries by partner only, so without this an orgAccess='selected'
  // partner admin omitting `orgId` would export billing data for every org
  // under the partner. ticket_parts carries a direct org_id and is already
  // org-axis RLS-scoped, but we constrain it too for defense-in-depth.
  // `accessibleOrgIds` null/undefined = system scope (no filter). (#sec-review-1)
  const applyOrgAxis = !orgId && accessibleOrgIds != null;
  const timeConditions = [
    eq(timeEntries.isBillable, true),
    sql`${timeEntries.endedAt} IS NOT NULL`,
    gte(timeEntries.startedAt, from),
    lte(timeEntries.startedAt, to)
  ];
  if (orgId) timeConditions.push(eq(timeEntries.orgId, orgId));
  if (applyOrgAxis) {
    const orgAxis = orgAxisSql(accessibleOrgIds);
    if (orgAxis) timeConditions.push(orgAxis);
  }

  const timeRows = await db
    .select({
      date: timeEntries.startedAt,
      orgName: organizations.name,
      ticketNumber: tickets.internalNumber,
      description: timeEntries.description,
      technician: users.name,
      minutes: timeEntries.durationMinutes,
      rate: timeEntries.hourlyRate,
      currencyCode: timeEntries.currencyCode,
      billingStatus: timeEntries.billingStatus,
      isApproved: timeEntries.isApproved
    })
    .from(timeEntries)
    .leftJoin(tickets, eq(timeEntries.ticketId, tickets.id))
    .leftJoin(organizations, eq(timeEntries.orgId, organizations.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(and(...timeConditions))
    .orderBy(asc(timeEntries.startedAt));

  const partConditions = [
    eq(ticketParts.isBillable, true),
    gte(ticketParts.createdAt, from),
    lte(ticketParts.createdAt, to)
  ];
  if (orgId) partConditions.push(eq(ticketParts.orgId, orgId));
  if (applyOrgAxis && accessibleOrgIds != null) {
    // ticket_parts.org_id is NOT NULL; an empty allowlist matches nothing.
    partConditions.push(inArray(ticketParts.orgId, accessibleOrgIds));
  }

  const partRows = await db
    .select({
      date: ticketParts.createdAt,
      orgName: organizations.name,
      ticketNumber: tickets.internalNumber,
      description: ticketParts.description,
      technician: users.name,
      quantity: ticketParts.quantity,
      unitPrice: ticketParts.unitPrice,
      currencyCode: ticketParts.currencyCode,
      billingStatus: ticketParts.billingStatus
    })
    .from(ticketParts)
    .leftJoin(tickets, eq(ticketParts.ticketId, tickets.id))
    .leftJoin(organizations, eq(ticketParts.orgId, organizations.id))
    .leftJoin(users, eq(ticketParts.addedBy, users.id))
    .where(and(...partConditions))
    .orderBy(asc(ticketParts.createdAt));

  const rows: BillableRow[] = [];
  for (const r of timeRows) {
    const hours = ((r.minutes ?? 0) / 60).toFixed(2);
    const rate = toFinite(r.rate);
    rows.push({
      kind: 'time',
      date: r.date,
      orgName: r.orgName,
      ticketNumber: r.ticketNumber,
      description: r.description,
      technician: r.technician,
      quantity: hours,
      rate: r.rate,
      // Labor rule (one rule everywhere): hours to 2 dp first, then ONE exact
      // half-up round of the product at the snapshot currency's minor unit
      // (review #2 — never through a double). Standalone entries with no
      // currency fall back to the 2-decimal exponent.
      amount: rate != null
        ? multiplyToCurrency(hours, rate, r.currencyCode ?? 'USD')
        : '0.00',
      currencyCode: r.currencyCode,
      billingStatus: r.billingStatus,
      isApproved: r.isApproved
    });
  }
  for (const r of partRows) {
    const quantity = toFinite(r.quantity);
    const unitPrice = toFinite(r.unitPrice);
    rows.push({
      kind: 'part',
      date: r.date,
      orgName: r.orgName,
      ticketNumber: r.ticketNumber,
      description: r.description,
      technician: r.technician,
      quantity: r.quantity,
      rate: r.unitPrice,
      amount: quantity != null && unitPrice != null
        ? multiplyToCurrency(quantity, unitPrice, r.currencyCode ?? 'USD')
        : '0.00',
      currencyCode: r.currencyCode,
      billingStatus: r.billingStatus,
      isApproved: null
    });
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  // Sum as integer minor units — never float-add 2-dp strings and re-round.
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.currencyCode == null) continue;
    totals.set(r.currencyCode, (totals.get(r.currencyCode) ?? 0) + toMinorUnits(r.amount, r.currencyCode));
  }
  const totalsByCurrency: CurrencyAmount[] = [...totals].map(([currencyCode, minor]) => ({
    currencyCode,
    amount: fromMinorUnits(minor, currencyCode)
  }));
  return { rows, totalsByCurrency };
}
