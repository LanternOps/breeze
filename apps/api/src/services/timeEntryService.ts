import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { timeEntries, ticketParts, tickets, ticketCategories, organizations, partners, users, ticketComments } from '../db/schema';
import { workTypes } from '../db/schema/workTypes';
import { emitTimeEntryEvent } from './timeEntryEvents';
import { loadCardsForOrg } from './billingProfileService';
import { resolveBillingRule, type BillingRule } from './billingRuleResolver';
import { getActiveWorkType } from './workTypeService';
import { computeBillableMinutes, billableMinutesSql, BILLABLE_MINUTES_CHECK_NAME } from './billableMinutes';
import { pgErrorCode, pgErrorConstraint } from '../utils/pgErrors';
import { captureException } from './sentry';
import { readOrgStampingDefaults } from './orgCurrencyCore';
import { isMissingRateGap } from './invoiceAssembly';
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
  /** 409 — `billed` is written only by the locked invoice-issue transition. */
  | 'BILLING_STATUS_RESERVED'
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
  | 'ORG_DENIED'
  /** 400 — a caller-supplied work_type_id that is not an ACTIVE row of the acting partner. */
  | 'WORK_TYPE_NOT_FOUND'
  | 'RATE_REQUIRES_BILLABLE'
  | 'MANAGE_BILLING_REQUIRED'
  /** 409 — UPDATE ... RETURNING matched zero rows (entry re-pointed/deleted between the read and the write). */
  | 'ENTRY_UPDATE_LOST'
  /** 409 — UPDATE ... RETURNING matched zero rows (part re-pointed/deleted between the read and the write). */
  | 'PART_UPDATE_LOST'
  /** 409 — DELETE ... RETURNING matched zero rows (part re-pointed between the lock-read and the delete). */
  | 'PART_DELETE_LOST'
  /**
   * 422 — `time_entries_billable_minutes_chk` rejected the write (#6463): the
   * TypeScript `computeBillableMinutes()` and the SQL `billableMinutesSql()`
   * disagree about this row's billed quantity. A server-side defect, not the
   * caller's payload — but it is deterministic for the offending row, so it is
   * reported as a verdict rather than a retryable fault (see
   * {@link refuseBillableMinutesDrift}).
   */
  | 'BILLABLE_MINUTES_DRIFT';

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

/**
 * #6463 — the missing half of the #4628 W03 contract.
 *
 * W03's premise is that a disagreement between `computeBillableMinutes()` (TS)
 * and `billableMinutesSql()` (SQL) becomes a `23514` on
 * `time_entries_billable_minutes_chk` rather than a wrong invoice. That was
 * honoured at the database and nowhere above it: `handleServiceError` rethrows
 * anything that is not a `TimeEntryServiceError`, so the violation escaped as a
 * bare postgres error — no report, no code, and nothing telling the technician
 * their stop did not land while the timer kept running.
 *
 * Wraps a statement that writes `billable_minutes` and converts ONLY that
 * constraint's 23514 into a typed refusal. Every other error (including a
 * 23514 from a different CHECK on the same table) propagates untouched.
 *
 * Reporting is `captureException`, NOT console alone. `handleServiceError`
 * answers a `TimeEntryServiceError` with `c.json(...)` instead of rethrowing,
 * so this error never reaches Hono's `app.onError` — and `Sentry.init` here
 * installs no `captureConsoleIntegration`, so a `console.error` would page
 * nobody. Reporting from inside the catch is the only thing that makes a real
 * drift visible without waiting for a technician to phone it in. The original
 * error travels with it: postgres's own message/detail for a CHECK on a
 * computed expression is the single most useful diagnostic here.
 *
 * Status is 422, deliberately, and not the 500 this class of defect would
 * usually earn. The drift is deterministic for the offending row, and
 * `apps/mobile/src/services/timeEntryQueue.ts` parks only
 * `PERMANENT_STATUSES = {400, 404, 409, 422}` in needs-attention — a 5xx is
 * read as transient and retried forever, wedging every write queued behind it
 * and losing far more billable work than the one row.
 *
 * The CHECK is IMMEDIATE (see the 2026-10-24-210000 migration), so the error is
 * raised by the offending statement itself rather than substituted at COMMIT.
 */
type BillableMinutesDriftContext = {
  op: 'createTimeEntry' | 'stopRunningEntry' | 'updateTimeEntry';
  entryId: string | null;
  /** Tenant + actor identity: the first triage question on a multi-tenant drift. */
  userId: string;
  partnerId: string | null;
  orgId: string | null;
  /**
   * `'computed-in-sql'` on the plain-stop path, where the minute count lives
   * only inside the UPDATE's own expression (see `durationExpr`). `at` is
   * logged alongside so that row is still findable without an id.
   */
  durationMinutes: number | 'computed-in-sql' | null;
  minimumMinutes: number | null;
  roundingIncrementMinutes: number | null;
  at?: string;
};

/** Per-op wording: only `createTimeEntry`/`stopRunningEntry` lose the whole entry. */
const BILLABLE_MINUTES_DRIFT_MESSAGE: Record<BillableMinutesDriftContext['op'], string> = {
  createTimeEntry:
    'This time entry could not be recorded — the billed-minutes calculation disagrees with the database. '
    + 'Your work was not saved; report this to support.',
  stopRunningEntry:
    'Your timer could not be stopped — the billed-minutes calculation disagrees with the database. '
    + 'The timer is still running; report this to support.',
  updateTimeEntry:
    'This change could not be saved — the billed-minutes calculation disagrees with the database. '
    + 'The entry itself is unchanged; report this to support.',
};

async function refuseBillableMinutesDrift<T>(
  context: BillableMinutesDriftContext,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (pgErrorCode(err) !== '23514' || pgErrorConstraint(err) !== BILLABLE_MINUTES_CHECK_NAME) throw err;
    const detail = {
      constraint: BILLABLE_MINUTES_CHECK_NAME,
      op: context.op,
      entryId: context.entryId,
      userId: context.userId,
      partnerId: context.partnerId,
      orgId: context.orgId,
      durationMinutes: context.durationMinutes,
      minimumMinutes: context.minimumMinutes,
      roundingIncrementMinutes: context.roundingIncrementMinutes,
      ...(context.at === undefined ? {} : { at: context.at }),
    };
    console.error('[timeEntryService] BILLABLE_MINUTES_DRIFT', detail, err);
    captureException(err, undefined, {
      service: 'timeEntryService',
      code: 'BILLABLE_MINUTES_DRIFT',
      ...Object.fromEntries(
        Object.entries(detail).map(([key, value]) => [key, value === null ? 'null' : String(value)]),
      ),
    });
    throw new TimeEntryServiceError(
      BILLABLE_MINUTES_DRIFT_MESSAGE[context.op],
      422,
      'BILLABLE_MINUTES_DRIFT',
    );
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
  workTypeId?: string | null;
};

export interface TimeEntryActor {
  userId: string;
  name?: string;
  email?: string;
  /** auth.partnerId — null only for system scope */
  partnerId: string | null;
  /** wildcard-permission holders (computed in routes): may manage others' entries + approve */
  manageAll: boolean;
  /** May change card-resolved billing terms; never granted to a system writer. */
  manageBilling: boolean;
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
  entry: { id: string; orgId?: string | null; source?: string | null; workTypeId?: string | null },
): void {
  actor.recordAuditMutation?.({
    action,
    entryId: entry.id,
    orgId: entry.orgId ?? null,
    ...(entry.source ? { source: entry.source as TimeEntrySource } : {}),
    ...(entry.workTypeId !== undefined ? { workTypeId: entry.workTypeId } : {}),
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

/** Reject a forged invoice lifecycle fact at every routine service entrypoint. */
function assertRoutineBillingStatus(status: BillingStatus | undefined): void {
  if (status === 'billed') {
    throw new TimeEntryServiceError(
      'Billed status is assigned only when an invoice is issued',
      409,
      'BILLING_STATUS_RESERVED',
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

async function getCategoryDefaults(categoryId: string): Promise<{ defaultWorkTypeId: string | null } | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => db
      .select({ defaultWorkTypeId: ticketCategories.defaultWorkTypeId })
      .from(ticketCategories).where(eq(ticketCategories.id, categoryId)).limit(1))
  );
  return rows[0] ?? null;
}

type BillingStamp = Omit<BillingRule, 'fellBackToNoCard' | 'billingStatus'> & { billingStatus: BillingStatus };

function billingStampFromEntry(entry: typeof timeEntries.$inferSelect): BillingStamp {
  return {
    billingProfileId: entry.billingProfileId,
    coverage: entry.coverage ?? (entry.isBillable ? 'billable' : 'non_billable'),
    hourlyRate: entry.hourlyRate, minimumMinutes: entry.minimumMinutes,
    roundingIncrementMinutes: entry.roundingIncrementMinutes,
    isBillable: entry.isBillable, billingStatus: entry.billingStatus,
  };
}

async function resolveEntryBilling(
  orgId: string | null, partnerId: string, currencyCode: string | null, workTypeId: string | null,
): Promise<BillingStamp> {
  const cards = orgId && currencyCode
    ? await loadCardsForOrg(orgId, partnerId, currencyCode)
    : { assignedCard: null, partnerDefaultCard: null };
  const { fellBackToNoCard, ...stamp } = resolveBillingRule({
    orgCurrency: orgId ? currencyCode : null, workTypeId, ...cards,
  });
  if (orgId && fellBackToNoCard) {
    console.warn('[timeEntryService] no billing profile for organization', { orgId, partnerId, currencyCode });
  }
  // Standalone work has no org/card and stays unpriced and non-billable by default.
  return orgId ? stamp : { ...stamp, isBillable: false, coverage: 'non_billable' };
}

function assertManageBilling(actor: TimeEntryActor): void {
  if (!actor.manageBilling) {
    throw new TimeEntryServiceError('Changing billing terms requires manage billing permission', 403, 'MANAGE_BILLING_REQUIRED');
  }
}

/** Compare against the stamp being edited, so an ordinary edit never reloads
 * configuration or silently turns a config change into a retroactive price. */
function applyBillingInput(
  base: BillingStamp, input: Pick<CreateTimeEntryInput, 'hourlyRate' | 'billingStatus' | 'isBillable' | 'minimumMinutes'>,
  actor: TimeEntryActor, alreadyOverridden = false,
): BillingStamp & { billingOverridden: boolean } {
  const rate = input.hourlyRate !== undefined ? toRate(input.hourlyRate) : base.hourlyRate;
  const rateDiffers = input.hourlyRate !== undefined && (rate === null || base.hourlyRate === null
    ? rate !== base.hourlyRate : Number(rate) !== Number(base.hourlyRate));
  // Explicit money is a request to bill even previously unpriced standalone
  // work. Never accept that request and then silently discard its rate.
  const pricesNonBillable = input.hourlyRate != null && !base.isBillable;
  const billableDiffers = (input.isBillable !== undefined && input.isBillable !== base.isBillable)
    || pricesNonBillable;
  const deviates = rateDiffers || (input.billingStatus !== undefined && input.billingStatus !== base.billingStatus)
    || (input.minimumMinutes !== undefined && input.minimumMinutes !== base.minimumMinutes) || billableDiffers;
  if (deviates) assertManageBilling(actor);
  if (input.hourlyRate != null && input.isBillable === false) {
    throw new TimeEntryServiceError('An hourly rate requires a billable entry; omit the rate or mark it billable',
      400, 'RATE_REQUIRES_BILLABLE');
  }
  const stamp = { ...base, hourlyRate: rate,
    minimumMinutes: input.minimumMinutes !== undefined ? input.minimumMinutes : base.minimumMinutes,
    billingStatus: input.billingStatus ?? base.billingStatus,
    isBillable: input.isBillable ?? (pricesNonBillable ? true : base.isBillable),
    billingOverridden: alreadyOverridden || deviates,
  };
  // A manager may price previously included work as out-of-scope labour.
  // It ceases to be included; included stamps must never carry money.
  if (base.coverage === 'included' && ((rateDiffers && rate !== null) ||
    (input.billingStatus !== undefined && input.billingStatus !== 'contract'))) {
    stamp.coverage = 'billable';
    stamp.billingStatus = input.billingStatus ?? 'not_billed';
  }
  if (stamp.isBillable && stamp.coverage === 'non_billable') {
    stamp.coverage = 'billable';
    stamp.billingStatus = input.billingStatus ?? 'not_billed';
  }
  if (!stamp.isBillable) {
    stamp.coverage = 'non_billable';
    stamp.billingStatus = 'not_billed';
    stamp.hourlyRate = null;
    stamp.minimumMinutes = null;
  }
  if (stamp.billingStatus === 'contract') stamp.coverage = 'included';
  if (stamp.coverage === 'included') {
    stamp.hourlyRate = null;
    stamp.minimumMinutes = null;
  }
  return stamp;
}

/**
 * Refuse a caller-supplied work type that is not an ACTIVE row of the acting
 * partner, BEFORE any write.
 *
 * `(work_type_id, partner_id) -> work_types(id, partner_id)` is a composite FK,
 * so a foreign id raises 23503 — inside the request-long
 * `withDbAccessContext` transaction, which that violation ABORTS. Mapping it
 * afterwards is impossible (every follow-up statement fails with 25P02 and the
 * driver substitutes the raw error back in at commit — exactly the #2189 trap
 * startTimer documents), so the caller receives a raw 500. Hence: validate
 * first, never catch 23503.
 *
 * Only a caller-supplied, non-null id is checked. `undefined` means "apply the
 * server-side default" and an explicit `null` means "no work type" — neither
 * references a row. The CATEGORY default is deliberately exempt too: spec §3.1
 * keeps retired categories supplying their default, and that id is already
 * partner-consistent by the category's own composite FK.
 */
async function assertWorkTypeUsable(
  workTypeId: string | null | undefined,
  partnerId: string,
): Promise<void> {
  if (workTypeId == null) return;
  if (await getActiveWorkType(workTypeId, partnerId)) return;
  throw new TimeEntryServiceError('Unknown work type', 400, 'WORK_TYPE_NOT_FOUND');
}

async function resolveTicketLink(ticketId: string, actor: TimeEntryActor, requestedWorkTypeId?: string | null) {
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
  const category = ticket.categoryId ? await getCategoryDefaults(ticket.categoryId) : null;
  // Retired categories retain their converted work-type pricing. Only explicit
  // picker input is active-validated; the persisted default is partner-safe by FK.
  const workTypeId = requestedWorkTypeId !== undefined ? requestedWorkTypeId : category?.defaultWorkTypeId ?? null;
  const billing = await resolveEntryBilling(ticket.orgId, ticketPartnerId, org!.currencyCode, workTypeId);
  return { ticket, partnerId: ticketPartnerId, currencyCode: org!.currencyCode, workTypeId, billing };
}

/**
 * The billing defaults the server WOULD stamp on a new ticket-linked time entry
 * — the resolved profile terms and the org currency (#5321).
 *
 * Read-only (no ticket lock): a UI prefill must not queue behind, or contend
 * with, a concurrent org move. The value is advisory — `createTimeEntry` always
 * re-resolves under its own lock, so a stale prefill can never write a rate in
 * the wrong currency.
 *
 * Exists because a NULL rate is invisible at log time and only surfaces much
 * later as the ALL_MISSING_RATE 409 on "Create invoice". Exposing the default
 * lets the ticket quick-add prefill the rate and warn when there is none.
 */
export async function getTicketTimeEntryDefaults(
  ticketId: string,
  actor: TimeEntryActor,
): Promise<BillingStamp & { currencyCode: string; workTypeId: string | null }> {
  const link = await resolveTicketLink(ticketId, actor);
  return {
    ...link.billing,
    currencyCode: link.currencyCode,
    workTypeId: link.workTypeId,
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
async function resolveAndLockTicketLink(ticketId: string, actor: TimeEntryActor, workTypeId?: string | null) {
  let link = await resolveTicketLink(ticketId, actor, workTypeId);
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
    link = await resolveTicketLink(ticketId, actor, workTypeId);
  }
  // The locked value is authoritative. A disagreement means a currency change
  // committed between the unlocked resolve and the barrier; re-resolve so the
  // stamp AND the match-or-skip default rate come from the new currency.
  if (org.currencyCode !== link.currencyCode) link = await resolveTicketLink(ticketId, actor, workTypeId);
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
const BILLED_LOCKED_ENTRY_FIELDS = ['startedAt', 'endedAt', 'isBillable', 'hourlyRate', 'billingStatus', 'ticketId',
  'workTypeId', 'billingProfileId', 'coverage', 'minimumMinutes', 'roundingIncrementMinutes', 'billingOverridden', 'resetBilling'] as const;
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
  assertRoutineBillingStatus(input.billingStatus);
  let partnerId = actor.partnerId;
  let orgId: string | null = null;
  let billing: BillingStamp | null = null;
  let workTypeId = input.workTypeId ?? null;
  let currencyCode: string | null = null;

  if (input.ticketId) {
    // Lock order tickets → time_entries: the ticket row is held until request
    // commit, so a concurrent org-move cannot slip between stamping and insert.
    const link = await resolveAndLockTicketLink(input.ticketId, actor, input.workTypeId);
    partnerId = link.partnerId;
    orgId = link.ticket.orgId;
    currencyCode = link.currencyCode;
    billing = link.billing;
    workTypeId = link.workTypeId;
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

  await assertWorkTypeUsable(input.workTypeId, partnerId);
  billing ??= await resolveEntryBilling(orgId, partnerId, currencyCode, workTypeId);
  const stamp = applyBillingInput(billing, input, actor);
  assertRepresentable(stamp.hourlyRate, currencyCode);

  const rows = await refuseBillableMinutesDrift({
    op: 'createTimeEntry',
    entryId: null,
    userId: actor.userId,
    partnerId,
    orgId,
    durationMinutes: computeDurationMinutes(input.startedAt, input.endedAt),
    minimumMinutes: stamp.minimumMinutes ?? null,
    roundingIncrementMinutes: stamp.roundingIncrementMinutes ?? null,
  }, () => db
    .insert(timeEntries)
    .values({
      partnerId,
      orgId,
      ticketId: input.ticketId ?? null,
      workTypeId,
      userId: actor.userId,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMinutes: computeDurationMinutes(input.startedAt, input.endedAt),
      // Spec §3.5 — the billed quantity, from the SAME terms this row stamps
      // (the applied stamp, so a manager's override drives it too).
      billableMinutes: computeBillableMinutes({
        durationMinutes: computeDurationMinutes(input.startedAt, input.endedAt),
        minimumMinutes: stamp.minimumMinutes,
        roundingIncrementMinutes: stamp.roundingIncrementMinutes,
      }),
      description: input.description ?? null,
      ...stamp,
      // Snapshot (spec §7): null only for standalone, money-less entries; never restamped.
      currencyCode,
      // W06 (#3900): server-stamped provenance; no public schema accepts it.
      source: provenance.source
    })
    .returning());
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
  let billingOverride: ReturnType<typeof applyBillingInput> | undefined;
  let entryId: string | undefined;
  if (overrides.isBillable !== undefined) {
    // A billing edit needs the persisted stamp, not today's card. Serialize
    // this branch with entry edits and pin the CAS to this timer so a concurrent
    // start cannot receive the old timer's override. Plain stops stay one UPDATE.
    const [entry] = await db.select().from(timeEntries)
      .where(and(eq(timeEntries.userId, actor.userId), isNull(timeEntries.endedAt)))
      .limit(1).for('update');
    if (!entry) return null;
    billingOverride = applyBillingInput(billingStampFromEntry(entry), overrides, actor, entry.billingOverridden);
    entryId = entry.id;
  }
  // CAS on ended_at IS NULL: two concurrent stops -> one winner, one no-op.
  // Duration computed in SQL from the row's own started_at (avoids a pre-select round-trip).
  // Built ONCE and inlined by billableMinutesSql in both of its branches: the
  // column is being assigned in this same UPDATE, so a `duration_minutes`
  // reference inside the fragment would read the OLD (NULL) value and the
  // CHECK would reject the row (23514). For the same reason, a stop that also
  // rewrites the terms must hand billableMinutesSql the NEW ones — SET reads
  // the old row, the CHECK validates the new one.
  const durationExpr = sql`FLOOR(EXTRACT(EPOCH FROM (${now.toISOString()}::timestamp - ${timeEntries.startedAt})) / 60)::int`;
  const rows = await refuseBillableMinutesDrift({
    op: 'stopRunningEntry',
    // Undefined on the plain-stop path: the CAS is pinned to the actor, not to
    // a pre-read row. `at` is the statement's own `now`, so the row this
    // refused is still findable from the log.
    entryId: entryId ?? null,
    userId: actor.userId,
    partnerId: actor.partnerId,
    orgId: null,
    // Computed by the statement itself (see durationExpr above), so the service
    // never holds the value the CHECK disagreed about.
    durationMinutes: 'computed-in-sql',
    minimumMinutes: billingOverride?.minimumMinutes ?? null,
    roundingIncrementMinutes: billingOverride?.roundingIncrementMinutes ?? null,
    at: now.toISOString(),
  }, () => db
    .update(timeEntries)
    .set({
      endedAt: now,
      durationMinutes: durationExpr,
      // Spec §3.5 — same arithmetic as computeBillableMinutes(), pinned by
      // time_entries_billable_minutes_chk.
      billableMinutes: billableMinutesSql(durationExpr, billingOverride
        ? {
          minimumMinutes: billingOverride.minimumMinutes,
          roundingIncrementMinutes: billingOverride.roundingIncrementMinutes,
        }
        : {}),
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      ...(billingOverride ?? {})
    })
    .where(and(eq(timeEntries.userId, actor.userId), isNull(timeEntries.endedAt),
      entryId ? eq(timeEntries.id, entryId) : undefined))
    .returning());
  return rows[0] ?? null;
}

export async function startTimer(input: { ticketId?: string; description?: string; workTypeId?: string | null }, actor: TimeEntryActor) {
  let partnerId = actor.partnerId;
  let orgId: string | null = null;
  let billing: BillingStamp | null = null;
  let workTypeId = input.workTypeId ?? null;
  let currencyCode: string | null = null;

  if (input.ticketId) {
    // Same lock discipline as createTimeEntry (tickets → time_entries).
    const link = await resolveAndLockTicketLink(input.ticketId, actor, input.workTypeId);
    partnerId = link.partnerId;
    orgId = link.ticket.orgId;
    currencyCode = link.currencyCode;
    billing = link.billing;
    workTypeId = link.workTypeId;
  }
  if (!partnerId) {
    throw new TimeEntryServiceError('Partner is unresolvable for this entry', 400, 'PARTNER_UNRESOLVABLE');
  }
  await assertWorkTypeUsable(input.workTypeId, partnerId);
  billing ??= await resolveEntryBilling(orgId, partnerId, currencyCode, workTypeId);
  assertRepresentable(billing.hourlyRate, currencyCode);
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
        workTypeId,
        userId: actor.userId,
        startedAt: new Date(),
        endedAt: null,
        durationMinutes: null,
        // A running timer has no billed quantity yet; stopRunningEntry lands it.
        billableMinutes: null,
        description: input.description ?? null,
        ...billing,
        billingOverridden: false,
        // Snapshot (spec §7): the ticket org's currency, or null for a
        // standalone timer (no rate yet); never restamped.
        currencyCode,
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
  assertRoutineBillingStatus(input.billingStatus);
  // Global lock order: the TARGET ticket (relink) before the entry row.
  const link = typeof input.ticketId === 'string' ? await resolveAndLockTicketLink(input.ticketId, actor, input.workTypeId) : null;
  const entry = await getEntryOr404(id, actor); // FOR UPDATE — re-read under lock
  assertCanMutate(entry, actor);
  await assertWorkTypeUsable(input.workTypeId, entry.partnerId);
  if (entry.billingStatus === 'billed' && BILLED_LOCKED_ENTRY_FIELDS.some((k) => (input as Record<string, unknown>)[k] !== undefined)) {
    throw new TimeEntryServiceError('This entry has been invoiced; only its description can change', 409, 'ENTRY_BILLED');
  }

  const startedAt = input.startedAt ?? entry.startedAt;
  const endedAt = input.endedAt !== undefined ? input.endedAt : entry.endedAt;
  if (endedAt && endedAt.getTime() <= startedAt.getTime()) {
    throw new TimeEntryServiceError('endedAt must be after startedAt', 400, 'INVALID_RANGE');
  }

  const set: Record<string, unknown> = {};
  const changed: string[] = [];
  if (input.workTypeId !== undefined) { set.workTypeId = input.workTypeId; changed.push('workTypeId'); }
  if (input.startedAt !== undefined) { set.startedAt = input.startedAt; changed.push('startedAt'); }
  if (input.endedAt !== undefined) { set.endedAt = input.endedAt; changed.push('endedAt'); }
  if (input.description !== undefined) { set.description = input.description; changed.push('description'); }
  if (input.isBillable !== undefined) { set.isBillable = input.isBillable; changed.push('isBillable'); }

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
  if (input.resetBilling) assertManageBilling(actor);
  const relinked = input.ticketId !== undefined && input.ticketId !== entry.ticketId;
  const workTypeChanged = input.workTypeId !== undefined && input.workTypeId !== entry.workTypeId;
  const reprice = input.resetBilling || (!entry.billingOverridden && (relinked || workTypeChanged));
  let base = billingStampFromEntry(entry);
  if (reprice) {
    const nextWorkType = input.workTypeId !== undefined ? input.workTypeId
      : relinked && link ? link.workTypeId : entry.workTypeId ?? null;
    if (relinked && link) {
      base = link.billing;
      set.workTypeId = nextWorkType;
    } else {
      const nextOrgId = input.ticketId === null ? null : entry.orgId;
      base = await resolveEntryBilling(nextOrgId, entry.partnerId, entry.currencyCode, nextWorkType);
    }
    Object.assign(set, base, { billingOverridden: false });
    changed.push('billingProfileId', 'coverage', 'hourlyRate', 'minimumMinutes', 'roundingIncrementMinutes', 'billingStatus');
  }
  if (reprice || input.hourlyRate !== undefined || input.minimumMinutes !== undefined ||
      input.billingStatus !== undefined || input.isBillable !== undefined) {
    const stamp = applyBillingInput(base, input, actor, reprice ? false : entry.billingOverridden);
    // Unchanged identity/config stamps remain intact on routine field edits.
    const { billingProfileId: _profile, roundingIncrementMinutes: _rounding, ...editable } = stamp;
    Object.assign(set, editable);
    for (const key of ['hourlyRate', 'minimumMinutes', 'billingStatus'] as const) {
      if (input[key] !== undefined && !changed.includes(key)) changed.push(key);
    }
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
  // Spec §3.5 — recompute the billed quantity whenever EITHER the duration or
  // the card terms on this row move. Mobile replays a stop as PATCH { endedAt }
  // (apps/mobile/src/services/timeEntryReplay.test.ts), so this branch — not
  // just stopRunningEntry — is a real stop path. Placed after the re-price and
  // override blocks so a re-price and a duration change in one PATCH both feed
  // the same recompute.
  // #6465: gate on a VALUE change, not key presence. applyBillingInput returns a
  // full stamp, so `editable` re-writes minimumMinutes on every billing-ish PATCH
  // — including a rate-only edit. Keying off presence restamped billable_minutes
  // on legacy rows whose quantity was deliberately NULL, silently moving the
  // invoice quantity when the technician only corrected a rate.
  const nextMinimum = set.minimumMinutes !== undefined
    ? (set.minimumMinutes as number | null) : entry.minimumMinutes;
  const nextIncrement = set.roundingIncrementMinutes !== undefined
    ? (set.roundingIncrementMinutes as number | null) : entry.roundingIncrementMinutes;
  if (
    set.durationMinutes !== undefined ||
    nextMinimum !== entry.minimumMinutes ||
    nextIncrement !== entry.roundingIncrementMinutes
  ) {
    const nextDuration = (set.durationMinutes as number | undefined) ?? entry.durationMinutes;
    set.billableMinutes = computeBillableMinutes({
      durationMinutes: nextDuration ?? null,
      minimumMinutes: nextMinimum ?? null,
      roundingIncrementMinutes: nextIncrement ?? null,
    });
    changed.push('billableMinutes');
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

  const rows = await refuseBillableMinutesDrift({
    op: 'updateTimeEntry',
    entryId: id,
    userId: actor.userId,
    partnerId: entry.partnerId,
    orgId: entry.orgId,
    durationMinutes: (set.durationMinutes as number | undefined) ?? entry.durationMinutes ?? null,
    minimumMinutes: (set.minimumMinutes as number | null | undefined) ?? entry.minimumMinutes ?? null,
    roundingIncrementMinutes:
      (set.roundingIncrementMinutes as number | null | undefined) ?? entry.roundingIncrementMinutes ?? null,
  }, () => db.update(timeEntries).set(set).where(eq(timeEntries.id, id)).returning());
  const mutated = rows[0];
  if (!mutated) {
    // The row existed at the top of this call (getEntryOr404) but the UPDATE
    // matched zero rows — it was re-pointed or deleted in between (org move,
    // RLS context change, concurrent delete). Returning the stale pre-update
    // row here would tell the caller (including mobile's stop-timer replay,
    // see the recompute comment above) that the write succeeded when it did not.
    throw new TimeEntryServiceError(
      'Entry could not be updated — reload and retry',
      409,
      'ENTRY_UPDATE_LOST'
    );
  }

  recordAuditMutation(actor, 'time_entry.updated', mutated);
  await emitTimeEntryEvent({
    type: 'time_entry.updated',
    timeEntryId: id,
    partnerId: entry.partnerId,
    ticketId: mutated.ticketId ?? entry.ticketId,
    actorUserId: actor.userId,
    payload: { changed }
  });
  return mutated;
}

export async function deleteTimeEntry(id: string, actor: TimeEntryActor) {
  const entry = await getEntryOr404(id, actor);
  assertCanMutate(entry, actor);
  if (entry.billingStatus === 'billed') {
    throw new TimeEntryServiceError(
      'This entry has been invoiced and cannot be deleted; void the invoice first',
      409,
      'ENTRY_BILLED',
    );
  }
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
  assertRoutineBillingStatus(input.billingStatus);
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
      isBillable: input.isBillable ?? link.billing.isBillable,
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
  assertRoutineBillingStatus(input.billingStatus);
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
  const mutated = rows[0];
  if (!mutated) {
    // The part existed at the top of this call (getPartOr404) but the UPDATE
    // matched zero rows — it was re-pointed or deleted in between (org move,
    // RLS context change, concurrent delete). Returning the stale pre-update
    // part here would tell the caller the write succeeded when it did not,
    // and unlike updateTimeEntry there's no audit/event call to skip either —
    // the write loss would otherwise be purely silent.
    throw new TimeEntryServiceError(
      'Part could not be updated — reload and retry',
      409,
      'PART_UPDATE_LOST'
    );
  }
  return mutated;
}

export async function deleteTicketPart(id: string, _actor: TimeEntryActor) {
  const part = await getPartOr404(id);
  if (part.billingStatus === 'billed') {
    throw new TimeEntryServiceError(
      'This part has been invoiced and cannot be deleted; void the invoice first',
      409,
      'PART_BILLED',
    );
  }
  const deleted = await db.delete(ticketParts).where(eq(ticketParts.id, id)).returning({ id: ticketParts.id });
  if (deleted.length === 0) {
    // The part existed at the top of this call (getPartOr404's FOR UPDATE
    // re-read) but the DELETE matched zero rows — it was re-pointed out of
    // this caller's visibility in between (org move, RLS context change).
    // Reporting `{ deleted: true }` here would tell the caller the row is
    // gone when it is not. Same race class as updateTicketPart (#6568/#6588),
    // with its own code so callers can tell the two write paths apart.
    throw new TimeEntryServiceError(
      'Part could not be deleted — reload and retry',
      409,
      'PART_DELETE_LOST',
    );
  }
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
    workTypeId: timeEntries.workTypeId,
    billingProfileId: timeEntries.billingProfileId,
    coverage: timeEntries.coverage,
    billingOverridden: timeEntries.billingOverridden,
    minimumMinutes: timeEntries.minimumMinutes,
    roundingIncrementMinutes: timeEntries.roundingIncrementMinutes,
    // §3.5 billed quantity. Read by the timesheet money loop and by the web
    // "worked vs billed" line; day totals deliberately stay on durationMinutes.
    billableMinutes: timeEntries.billableMinutes,
    // Keep archived labels on historical entries. The correlated read preserves
    // entry cardinality and stays in the ambient partner RLS context.
    workType: sql<{ id: string; name: string; isActive: boolean } | null>`(
      SELECT json_build_object('id', ${workTypes.id}, 'name', ${workTypes.name}, 'isActive', ${workTypes.isActive})
      FROM ${workTypes}
      WHERE ${workTypes.id} = ${timeEntries.workTypeId}
        AND ${workTypes.partnerId} = ${timeEntries.partnerId}
    )`,
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
    // Billed quantity (§3.5): COALESCE(billable_minutes, duration_minutes),
    // same rule as the money loop below — NOT actual duration. totalMinutes
    // above deliberately stays on actual minutes (utilization).
    if (entry.isBillable) day.billableMinutes += (entry.billableMinutes ?? entry.durationMinutes) ?? 0;
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
    // Only the minutes source moved to the billed quantity (§3.5). The day-total
    // loop above deliberately keeps ACTUAL minutes — that figure is utilization.
    const hours = (((entry.billableMinutes ?? entry.durationMinutes) ?? 0) / 60).toFixed(2);
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
      // §3.4 contract-covered time, in ACTUAL minutes. The W03 plan proposed
      // COALESCE here "for uniformity, not for effect", on the premise that an
      // included row never carries card terms. It can: resolveBillingRule()
      // stamps roundingIncrementMinutes from the card regardless of coverage,
      // so COALESCE would have moved this number — and would then disagree with
      // the portal's coveredByContract bucket, which §3.5 keeps on actual
      // minutes. W02's timeEntryMoneyReaders.test.ts pins this form.
      includedMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}) FILTER (WHERE ${timeEntries.coverage} = 'included'), 0)::int`,
      // Utilization figure — ACTUAL minutes worked (§3.5). Not the billed quantity.
      totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)::int`,
      // Billed quantity (§3.5): the minimum/rounding result when the row has one.
      billableMinutes: sql<number>`COALESCE(SUM(COALESCE(${timeEntries.billableMinutes}, ${timeEntries.durationMinutes})) FILTER (WHERE ${timeEntries.isBillable}), 0)::int`
    })
    .from(timeEntries)
    .where(eq(timeEntries.ticketId, ticketId));

  // Money is grouped per currency — never summed across currencies.
  const timeMoney = await db
    .select({
      currencyCode: timeEntries.currencyCode,
      // Labor rule unchanged: round hours to 2 dp first, then × rate, then ONE
      // round per row at the currency's minor unit (the invoice-line figure)
      // before summing. Only the MINUTES source changed (§3.5).
      amount: sql<string>`COALESCE(SUM(ROUND(ROUND(COALESCE(${timeEntries.billableMinutes}, ${timeEntries.durationMinutes})::numeric / 60, 2) * ${timeEntries.hourlyRate}, ${minorUnitScaleSql(timeEntries.currencyCode)})), 0)::numeric(12,2)`
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
      ...(timeRows[0] ?? { totalMinutes: 0, billableMinutes: 0, includedMinutes: 0 }),
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
  /** Null when `missingRate` is true — an unresolved rate is reported as an
   *  explicit gap, never a fabricated '0.00' line (#6461). */
  amount: string | null;
  /** True for a TIME row with no resolvable hourly rate, for ANY billing
   *  status except `contract`/`no_charge` (those are an intentional zero,
   *  never a gap) — see invoiceAssembly.isMissingRateGap, the same predicate
   *  invoiceAssembly.partitionTimeEntries uses to route the identical
   *  `not_billed` row to its `missingRate` bucket instead of a line. Unlike
   *  partitionTimeEntries (which only ever sees `not_billed` rows), this
   *  export sees every billing_status, so a `billed` row can be a gap too:
   *  no resolvable rate means no amount to report or sum, regardless of
   *  whether it was previously marked billed. Ticket parts have no gap
   *  concept (`ticket_parts.unit_price` is NOT NULL) and are always false. */
  missingRate: boolean;
  currencyCode: string | null;
  billingStatus: BillingStatus;
  /** #4628 W04 — the labour label as stamped; null for a part or an entry with none. */
  workTypeName: string | null;
  /** #4628 §3.4 — the card row's coverage as stamped; null for a part or a pre-feature entry. */
  coverage: 'billable' | 'included' | 'non_billable' | null;
  /**
   * #4628 W04 — contract-covered time in ACTUAL minutes worked; 0 for every
   * row that is not `included`, and for parts, so the column sums cleanly.
   * Deliberately not the billed quantity: an included row can still carry the
   * card's rounding, and getTicketBillingSummary / the portal's
   * coveredByContract bucket report included time as worked time (§3.5).
   */
  includedMinutes: number;
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
      billableMinutes: timeEntries.billableMinutes,
      rate: timeEntries.hourlyRate,
      currencyCode: timeEntries.currencyCode,
      billingStatus: timeEntries.billingStatus,
      isApproved: timeEntries.isApproved,
      coverage: timeEntries.coverage,
      // Correlated read, keyed on the entry's partner like entrySelection():
      // keeps one row per entry and keeps archived labels on history.
      workTypeName: sql<string | null>`(
        SELECT ${workTypes.name} FROM ${workTypes}
        WHERE ${workTypes.id} = ${timeEntries.workTypeId}
          AND ${workTypes.partnerId} = ${timeEntries.partnerId}
      )`
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
    // Billed quantity (§3.5). NULL billable_minutes = pre-feature row or a row
    // with no card terms — bill the actual duration.
    const hours = (((r.billableMinutes ?? r.minutes) ?? 0) / 60).toFixed(2);
    const rate = toFinite(r.rate);
    // A row with no resolvable rate is a genuine assembly gap (#6461),
    // regardless of billing_status, EXCEPT `contract`/`no_charge` where a
    // null rate is an intentional zero — includes `billed` rows: a
    // previously-billed entry that has since lost its rate (or never had a
    // resolvable one) still has no amount to report or sum.
    const missingRate = isMissingRateGap(rate, r.billingStatus);
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
      // currency fall back to the 2-decimal exponent. Never a fabricated
      // '0.00' for a missingRate gap — null instead (#6461).
      amount: missingRate
        ? null
        : rate != null
          ? multiplyToCurrency(hours, rate, r.currencyCode ?? 'USD')
          : '0.00',
      missingRate,
      currencyCode: r.currencyCode,
      billingStatus: r.billingStatus,
      isApproved: r.isApproved,
      workTypeName: r.workTypeName ?? null,
      coverage: r.coverage ?? null,
      includedMinutes: r.coverage === 'included' ? (r.minutes ?? 0) : 0
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
      // ticket_parts.unit_price/quantity are NOT NULL — this branch is only
      // the corrupt-numeric-string defensive fallback (toFinite already
      // logged it), never a real gap, so parts have no missingRate concept.
      amount: quantity != null && unitPrice != null
        ? multiplyToCurrency(quantity, unitPrice, r.currencyCode ?? 'USD')
        : '0.00',
      missingRate: false,
      currencyCode: r.currencyCode,
      billingStatus: r.billingStatus,
      isApproved: null,
      // A part has no labour dimension.
      workTypeName: null,
      coverage: null,
      includedMinutes: 0
    });
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  // Sum as integer minor units — never float-add 2-dp strings and re-round.
  // A missingRate gap contributes no money at all, not even a zero entry
  // under its currency (#6461) — it has no amount to sum.
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.currencyCode == null || r.missingRate || r.amount == null) continue;
    totals.set(r.currencyCode, (totals.get(r.currencyCode) ?? 0) + toMinorUnits(r.amount, r.currencyCode));
  }
  const totalsByCurrency: CurrencyAmount[] = [...totals].map(([currencyCode, minor]) => ({
    currencyCode,
    amount: fromMinorUnits(minor, currencyCode)
  }));
  return { rows, totalsByCurrency };
}
