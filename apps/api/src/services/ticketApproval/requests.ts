import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { fromMinorUnits, toMinorUnits } from '@breeze/shared';
import {
  contacts, contactRoles, ticketApprovalRequests, ticketComments, tickets, timeEntries,
  type TicketApprovalEnforcement, type TicketApprovalOrigin, type TicketApprovalRequest,
  type TicketApprovalStatus, type TicketApprovalTrigger,
} from '../../db/schema';
import { workTypes } from '../../db/schema/workTypes';
import type { Tx } from '../autopay/types';
import type { TicketEventInput } from '../ticketEvents';
import { resolveTicketApprovalSettings } from './settings';
import { entryAmountMinor, type GateInput } from './gate';

/**
 * Customer work approval: gate context and the pending-request lifecycle
 * shared by the time-entry writers (timeEntryService.ts) and the decision
 * service (decisions.ts). Spec §5.2–§5.6, §6.1.
 *
 * LOCK CONTRACT — every function here runs on the caller's transaction and
 * assumes the caller already holds `organizations FOR SHARE -> tickets FOR
 * UPDATE` on the ticket. Every path that creates, locks or rewrites a
 * ticket_approval_requests row takes that ticket lock first, so within one
 * ticket the request and entry locks below can never form a cycle.
 */

/** Settled entries count toward a budget; held ones are the overage being asked about (§5.3). */
const CONSUMED_STATUSES = ['not_billed', 'billed', 'contract'] as const;
/** Pending lifetime is fixed at creation and reset on every join (spec §5.3). */
const HOUR_MS = 3_600_000;

export type ApprovalEvent = Extract<TicketEventInput, { type: 'ticket.approval_requested' | 'ticket.approval_decided' }>;

export interface PlainApprovalSettings {
  enabled: boolean;
  budgetTrigger: boolean;
  afterHoursTrigger: boolean;
  enforcement: TicketApprovalEnforcement;
  requestTtlHours: number;
}

export async function loadPlainApprovalSettings(
  db: Tx, args: { partnerId: string; orgId: string },
): Promise<PlainApprovalSettings> {
  const s = await resolveTicketApprovalSettings(db, args);
  return {
    enabled: s.enabled.value,
    budgetTrigger: s.budgetTrigger.value,
    afterHoursTrigger: s.afterHoursTrigger.value,
    enforcement: s.enforcement.value,
    requestTtlHours: s.requestTtlHours.value,
  };
}

/** Billed quantity of a stored row: COALESCE(billable_minutes, duration_minutes). */
export function billedMinutes(r: { billableMinutes: number | null; durationMinutes: number | null }): number {
  return r.billableMinutes ?? r.durationMinutes ?? 0;
}

export interface TicketBudget {
  budgetMinutes: number | null;
  budgetAmount: string | null;
  budgetCurrencyCode: string | null;
}

export async function readTicketBudget(db: Tx, ticketId: string): Promise<TicketBudget & { orgId: string; partnerId: string | null }> {
  const [t] = await db.select({
    orgId: tickets.orgId, partnerId: tickets.partnerId,
    budgetMinutes: tickets.budgetMinutes, budgetAmount: tickets.budgetAmount, budgetCurrencyCode: tickets.budgetCurrencyCode,
  }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!t) throw new Error(`[ticketApproval] ticket ${ticketId} not visible under the caller's lock`);
  return t;
}

/** Σ consumption over the ticket's settled billable entries (spec §5.3), excluding `excludeEntryIds`. */
export async function sumConsumption(
  db: Tx, ticketId: string, budgetCurrencyCode: string | null, excludeEntryIds: string[] = [],
): Promise<{ minutes: number; amountMinor: number }> {
  const rows = await db.select({
    id: timeEntries.id, billableMinutes: timeEntries.billableMinutes, durationMinutes: timeEntries.durationMinutes,
    hourlyRate: timeEntries.hourlyRate, currencyCode: timeEntries.currencyCode,
  }).from(timeEntries).where(and(
    eq(timeEntries.ticketId, ticketId),
    eq(timeEntries.isBillable, true),
    eq(timeEntries.coverage, 'billable'),
    isNotNull(timeEntries.endedAt),
    inArray(timeEntries.billingStatus, [...CONSUMED_STATUSES]),
  ));
  let minutes = 0;
  let amountMinor = 0;
  for (const r of rows) {
    if (excludeEntryIds.includes(r.id)) continue;
    const m = billedMinutes(r);
    minutes += m;
    // Consumed rows with no rate count 0 toward money: they were let through
    // and surface to staff as a rate gap (spec §5.3).
    if (budgetCurrencyCode) amountMinor += entryAmountMinor({ ...r, minutes: m }, budgetCurrencyCode) ?? 0;
  }
  return { minutes, amountMinor };
}

type RequestSummary = Pick<TicketApprovalRequest,
  'id' | 'trigger' | 'origin' | 'status' | 'currencyCode' | 'approvedExtensionMinutes' | 'approvedExtensionAmount'
  | 'coverageStartsAt' | 'coverageEndsAt'>;

async function listTicketRequests(db: Tx, ticketId: string): Promise<RequestSummary[]> {
  return db.select({
    id: ticketApprovalRequests.id, trigger: ticketApprovalRequests.trigger, origin: ticketApprovalRequests.origin,
    status: ticketApprovalRequests.status, currencyCode: ticketApprovalRequests.currencyCode,
    approvedExtensionMinutes: ticketApprovalRequests.approvedExtensionMinutes,
    approvedExtensionAmount: ticketApprovalRequests.approvedExtensionAmount,
    coverageStartsAt: ticketApprovalRequests.coverageStartsAt, coverageEndsAt: ticketApprovalRequests.coverageEndsAt,
  }).from(ticketApprovalRequests).where(eq(ticketApprovalRequests.ticketId, ticketId));
}

function approvedExtensionsOf(requests: RequestSummary[], budgetCurrencyCode: string | null) {
  let minutes = 0;
  let amountMinor = 0;
  for (const r of requests) {
    if (r.status !== 'approved' || r.trigger !== 'budget') continue;
    minutes += r.approvedExtensionMinutes ?? 0;
    // An extension granted in another currency cannot lift this ceiling.
    if (r.approvedExtensionAmount != null && budgetCurrencyCode && r.currencyCode === budgetCurrencyCode) {
      amountMinor += toMinorUnits(r.approvedExtensionAmount, budgetCurrencyCode);
    }
  }
  return { minutes, amountMinor };
}

export interface GateContextArgs {
  ticketId: string;
  partnerId: string;
  orgId: string;
  /** The entry being written: never counted as its own consumption. */
  excludeEntryId?: string | null;
  /** A request being decided/cancelled, or the edited entry's own request: not a queue head. */
  ignoreRequestId?: string | null;
  entryStartedAt: Date;
  workTypeId: string | null;
  /** The entry's CURRENT approval_request_id (after-hours provenance, spec §5.4). */
  currentRequestId?: string | null;
  /**
   * The write leaves work type and start time as they were. An entry only ever
   * reaches a BUDGET request after clearing the after-hours check, so while
   * those two are unchanged that clearance still stands — without this an
   * entry that needed both consents would bounce between the two requests
   * forever (after-hours approve → budget hold → budget approve → after-hours
   * hold …). A later after-hours flag on the work type does not re-hold it.
   */
  afterHoursFactsUnchanged?: boolean;
  /** Pre-resolved policy (callers short-circuit on !enabled before loading anything else). */
  settings?: PlainApprovalSettings;
}

export type GateContext = Omit<GateInput, 'entry' | 'operation'> & {
  settings: PlainApprovalSettings;
  isAfterHoursWorkType: boolean;
  budgetCurrencyCode: string | null;
};

/** MUST be called while the ticket row lock is held (spec §5.2). */
export async function loadGateContext(db: Tx, args: GateContextArgs): Promise<GateContext> {
  const settings = args.settings ?? await loadPlainApprovalSettings(db, { partnerId: args.partnerId, orgId: args.orgId });
  const ticket = await readTicketBudget(db, args.ticketId);
  const consumed = await sumConsumption(db, args.ticketId, ticket.budgetCurrencyCode,
    args.excludeEntryId ? [args.excludeEntryId] : []);
  const requests = await listTicketRequests(db, args.ticketId);
  let isAfterHoursWorkType = false;
  if (args.workTypeId) {
    const [wt] = await db.select({ isAfterHours: workTypes.isAfterHours }).from(workTypes)
      .where(eq(workTypes.id, args.workTypeId)).limit(1);
    isAfterHoursWorkType = wt?.isAfterHours ?? false;
  }
  const current = args.currentRequestId ? requests.find((r) => r.id === args.currentRequestId) : undefined;
  const at = args.entryStartedAt.getTime();
  const afterHoursCovered =
    requests.some((r) => r.status === 'approved' && r.trigger === 'after_hours'
      && r.coverageStartsAt != null && r.coverageEndsAt != null
      && r.coverageStartsAt.getTime() <= at && at < r.coverageEndsAt.getTime())
    || (current != null && current.status === 'approved' && current.trigger === 'after_hours' && current.origin === 'auto')
    || (current != null && current.trigger === 'budget' && args.afterHoursFactsUnchanged === true);
  return {
    settings,
    ticket: { budgetMinutes: ticket.budgetMinutes, budgetAmount: ticket.budgetAmount, budgetCurrencyCode: ticket.budgetCurrencyCode },
    consumed,
    approvedExtensions: approvedExtensionsOf(requests, ticket.budgetCurrencyCode),
    afterHoursCovered,
    pendingBudgetRequest: requests.some((r) => r.status === 'pending' && r.trigger === 'budget' && r.id !== args.ignoreRequestId),
    isAfterHoursWorkType,
    budgetCurrencyCode: ticket.budgetCurrencyCode,
  };
}

// ── Recipients (spec §6.1) ───────────────────────────────────────────────

const normEmail = (e: string | null | undefined): string | null => {
  const v = e?.trim().toLowerCase();
  return v ? v : null;
};

/**
 * Approvers: contacts holding an ORGANIZATION-scoped `billing` responsibility
 * in the canonical contact_roles table (the same reading orgAccountReadiness
 * uses — a site- or group-scoped billing role does not commit the org's
 * spend). Notify: the ticket requester (contact email, else submitter email),
 * plus `after_hours` contacts for that trigger, minus every approver.
 * Lower-cased and de-duplicated. With no approver the list is empty — there is
 * no requester fallback (Open Decision D8).
 */
export async function resolveRecipients(
  db: Tx, args: { orgId: string; ticketId: string; trigger: TicketApprovalTrigger },
): Promise<{ approverEmails: string[]; notifyEmails: string[] }> {
  const roleRows = await db.select({ email: contacts.email, role: contactRoles.role, siteId: contactRoles.siteId, deviceGroupId: contactRoles.deviceGroupId })
    .from(contactRoles)
    .innerJoin(contacts, and(eq(contacts.id, contactRoles.contactId), eq(contacts.orgId, contactRoles.orgId)))
    .where(and(eq(contactRoles.orgId, args.orgId), inArray(contactRoles.role, ['billing', 'after_hours'])));
  const approvers = new Set<string>();
  const notify = new Set<string>();
  for (const r of roleRows) {
    const email = normEmail(r.email);
    if (!email) continue;
    if (r.role === 'billing' && r.siteId == null && r.deviceGroupId == null) approvers.add(email);
    if (r.role === 'after_hours' && args.trigger === 'after_hours') notify.add(email);
  }
  const [t] = await db.select({ submitterEmail: tickets.submitterEmail, requesterEmail: contacts.email })
    .from(tickets)
    .leftJoin(contacts, and(eq(contacts.id, tickets.requesterContactId), eq(contacts.orgId, tickets.orgId)))
    .where(eq(tickets.id, args.ticketId)).limit(1);
  const requester = normEmail(t?.requesterEmail) ?? normEmail(t?.submitterEmail);
  if (requester) notify.add(requester);
  for (const a of approvers) notify.delete(a);
  return { approverEmails: [...approvers].sort(), notifyEmails: [...notify].sort() };
}

// ── Pending request lifecycle ────────────────────────────────────────────

const ceil15 = (minutes: number): number => Math.ceil(minutes / 15) * 15;

export interface AcquireArgs {
  ticketId: string;
  orgId: string;
  trigger: TicketApprovalTrigger;
  origin?: TicketApprovalOrigin;
  enforcement: TicketApprovalEnforcement;
  ttlHours: number;
  /** The ticket's labour currency (budget currency, else the org's). */
  currencyCode: string | null;
  afterHoursWorkTypeId?: string | null;
  requestedByUserId?: string | null;
  message?: string | null;
  now?: Date;
}

/**
 * Lock the ticket's pending request for `trigger`, or create it. The partial
 * UNIQUE `ticket_approval_requests_one_pending_uq` is the backstop, suppressed
 * at the STATEMENT level: a raised 23505 would abort the caller's request
 * transaction (#2189), and the ticket lock already serializes every creator.
 */
export async function acquirePendingRequest(db: Tx, args: AcquireArgs): Promise<{ requestId: string; created: boolean }> {
  const lockPending = async () => {
    const [row] = await db.select({ id: ticketApprovalRequests.id }).from(ticketApprovalRequests)
      .where(and(eq(ticketApprovalRequests.ticketId, args.ticketId), eq(ticketApprovalRequests.trigger, args.trigger),
        eq(ticketApprovalRequests.status, 'pending')))
      .limit(1).for('update');
    return row?.id ?? null;
  };
  const existing = await lockPending();
  if (existing) return { requestId: existing, created: false };
  const now = args.now ?? new Date();
  const recipients = await resolveRecipients(db, { orgId: args.orgId, ticketId: args.ticketId, trigger: args.trigger });
  const inserted = await db.insert(ticketApprovalRequests).values({
    orgId: args.orgId,
    ticketId: args.ticketId,
    trigger: args.trigger,
    origin: args.origin ?? 'auto',
    status: 'pending',
    revision: 1,
    enforcement: args.enforcement,
    requestedByUserId: args.requestedByUserId ?? null,
    requestedAt: now,
    expiresAt: new Date(now.getTime() + args.ttlHours * HOUR_MS),
    message: args.message ?? null,
    currencyCode: args.currencyCode,
    afterHoursWorkTypeId: args.trigger === 'after_hours' ? args.afterHoursWorkTypeId ?? null : null,
    approverEmails: recipients.approverEmails,
    notifyEmails: recipients.notifyEmails,
  }).onConflictDoNothing().returning({ id: ticketApprovalRequests.id });
  if (inserted[0]) return { requestId: inserted[0].id, created: true };
  const raced = await lockPending();
  if (!raced) throw new Error('[ticketApproval] pending request insert conflicted but no pending row is visible');
  return { requestId: raced, created: false };
}

export interface RefreshOptions {
  /** Bump `revision` (the ask changed under a pending request). False only for a request created in this transaction. */
  bump: boolean;
  ttlHours: number;
  now?: Date;
}

/**
 * Recompute a pending request's ask over the WHOLE ticket (spec §5.3):
 * `ceil15(max(0, consumed + Σ held on this request − ceiling))`, the same in
 * minor units for money. Never a sum of per-entry overages — each of those
 * excludes the others from `consumed` and so under-asks. An axis whose ask is
 * 0 is stored NULL (the column CHECK is `IS NULL OR > 0`). Resets `expires_at`.
 * The caller holds the request row lock (acquirePendingRequest or a decision
 * path's FOR UPDATE).
 */
export async function refreshRequestAsk(db: Tx, requestId: string, opts: RefreshOptions): Promise<{ revision: number }> {
  const [req] = await db.select().from(ticketApprovalRequests).where(eq(ticketApprovalRequests.id, requestId)).limit(1);
  if (!req) throw new Error(`[ticketApproval] request ${requestId} vanished under its lock`);
  if (req.status !== 'pending') throw new Error(`[ticketApproval] refreshRequestAsk on a ${req.status} request`);
  const now = opts.now ?? new Date();
  const set: Partial<typeof ticketApprovalRequests.$inferInsert> = {
    expiresAt: new Date(now.getTime() + opts.ttlHours * HOUR_MS),
    updatedAt: now,
    ...(opts.bump ? { revision: req.revision + 1 } : {}),
  };
  if (req.trigger === 'budget') {
    const ticket = await readTicketBudget(db, req.ticketId);
    const cur = ticket.budgetCurrencyCode;
    const consumed = await sumConsumption(db, req.ticketId, cur);
    const ext = approvedExtensionsOf(await listTicketRequests(db, req.ticketId), cur);
    const held = await db.select({ billableMinutes: timeEntries.billableMinutes, durationMinutes: timeEntries.durationMinutes,
      hourlyRate: timeEntries.hourlyRate, currencyCode: timeEntries.currencyCode })
      .from(timeEntries).where(and(eq(timeEntries.approvalRequestId, requestId), eq(timeEntries.billingStatus, 'awaiting_approval')));
    let heldMinutes = 0;
    let heldMinor = 0;
    for (const h of held) {
      const m = billedMinutes(h);
      heldMinutes += m;
      // An unpriced held entry adds nothing the customer can be shown; the ask
      // is then a lower bound and the entry stays held after approval.
      if (cur) heldMinor += entryAmountMinor({ ...h, minutes: m }, cur) ?? 0;
    }
    const ceilMinutes = ticket.budgetMinutes == null ? null : ticket.budgetMinutes + ext.minutes;
    const ceilMinor = ticket.budgetAmount == null || cur == null ? null : toMinorUnits(ticket.budgetAmount, cur) + ext.amountMinor;
    const askMinutes = ceilMinutes == null ? 0 : ceil15(Math.max(0, consumed.minutes + heldMinutes - ceilMinutes));
    const askMinor = ceilMinor == null ? 0 : Math.max(0, consumed.amountMinor + heldMinor - ceilMinor);
    Object.assign(set, {
      budgetMinutesAtRequest: ticket.budgetMinutes,
      consumedMinutesAtRequest: consumed.minutes,
      budgetAmountAtRequest: ticket.budgetAmount,
      consumedAmountAtRequest: cur && ticket.budgetAmount != null ? fromMinorUnits(consumed.amountMinor, cur) : null,
      currencyCode: cur ?? req.currencyCode,
      requestedExtensionMinutes: askMinutes > 0 ? askMinutes : null,
      requestedExtensionAmount: askMinor > 0 && cur ? fromMinorUnits(askMinor, cur) : null,
    });
  }
  await db.update(ticketApprovalRequests).set(set).where(eq(ticketApprovalRequests.id, requestId));
  return { revision: (set.revision as number | undefined) ?? req.revision };
}

/** Count of entries still held on a request. */
export async function countHeldEntries(db: Tx, requestId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(timeEntries)
    .where(and(eq(timeEntries.approvalRequestId, requestId), eq(timeEntries.billingStatus, 'awaiting_approval')));
  return r?.n ?? 0;
}

export interface HoldArgs extends AcquireArgs {
  entryId: string;
}

/**
 * Hold an EXISTING entry on the ticket's pending request for `trigger`
 * (creating it if none), then recompute the ask. Used by the decision paths;
 * the writers inline the same three steps so the entry write itself carries
 * the status and the link.
 */
export async function holdEntryOnRequest(db: Tx, args: HoldArgs): Promise<{ requestId: string; created: boolean; revision: number }> {
  const acquired = await acquirePendingRequest(db, args);
  await db.update(timeEntries)
    .set({ billingStatus: 'awaiting_approval', approvalRequestId: acquired.requestId, updatedAt: new Date() })
    .where(eq(timeEntries.id, args.entryId));
  const { revision } = await refreshRequestAsk(db, acquired.requestId, { bump: !acquired.created, ttlHours: args.ttlHours, now: args.now });
  return { ...acquired, revision };
}

/**
 * An entry left `requestId` (released by an edit, deleted, or moved to another
 * request). A still-pending request is either cancelled — `auto` and now empty
 * (spec §5.5) — or re-asked over what remains. Returns the event to emit.
 */
export async function afterEntryLeftRequest(
  db: Tx, requestId: string, opts: { ttlHours: number; author: ApprovalCommentAuthor; now?: Date },
): Promise<ApprovalEvent | null> {
  const [req] = await db.select({ id: ticketApprovalRequests.id, status: ticketApprovalRequests.status, origin: ticketApprovalRequests.origin,
    trigger: ticketApprovalRequests.trigger, ticketId: ticketApprovalRequests.ticketId, orgId: ticketApprovalRequests.orgId })
    .from(ticketApprovalRequests).where(eq(ticketApprovalRequests.id, requestId)).limit(1).for('update');
  if (!req || req.status !== 'pending') return null;
  const remaining = await countHeldEntries(db, requestId);
  const now = opts.now ?? new Date();
  if (remaining === 0 && req.origin === 'auto') {
    await db.update(ticketApprovalRequests).set({ status: 'cancelled', updatedAt: now }).where(eq(ticketApprovalRequests.id, requestId));
    await insertApprovalComment(db, req.ticketId, opts.author, 'Customer approval request withdrawn: no held time remains on it.');
    return approvalDecidedEvent(req, 'cancelled', opts.author.kind === 'staff' ? opts.author.userId : null);
  }
  const { revision } = await refreshRequestAsk(db, requestId, { bump: true, ttlHours: opts.ttlHours, now });
  return approvalRequestedEvent(req, revision, false);
}

// ── Comments + events ────────────────────────────────────────────────────

/**
 * Who a transition's feed line is attributed to. RLS on ticket_comments only
 * admits an author-less row in SYSTEM scope (the expiry sweep); a request-path
 * transition is attributed to the staff user or the portal user who caused it.
 */
export type ApprovalCommentAuthor =
  | { kind: 'staff'; userId: string; name?: string | null }
  | { kind: 'portal'; portalUserId: string; name?: string | null }
  | { kind: 'system' };

/** Public `system` feed line (spec §5.6). Emits no ticket.commented event: W04 owns notification. */
export async function insertApprovalComment(db: Tx, ticketId: string, author: ApprovalCommentAuthor, content: string): Promise<void> {
  await db.insert(ticketComments).values({
    ticketId,
    userId: author.kind === 'staff' ? author.userId : null,
    portalUserId: author.kind === 'portal' ? author.portalUserId : null,
    authorName: author.kind === 'system' ? null : author.name ?? null,
    authorType: author.kind === 'staff' ? 'internal' : author.kind === 'portal' ? 'portal' : 'system',
    commentType: 'system', content, isPublic: true, oldValue: null, newValue: null,
  });
}

interface EventSubject { id: string; ticketId: string; orgId: string; trigger: TicketApprovalTrigger }

export function approvalRequestedEvent(req: EventSubject, revision: number, created: boolean, partnerId: string | null = null): ApprovalEvent {
  return { type: 'ticket.approval_requested', ticketId: req.ticketId, orgId: req.orgId, partnerId, actorUserId: null,
    payload: { requestId: req.id, trigger: req.trigger, revision, created } };
}

export function approvalDecidedEvent(
  req: EventSubject, status: Exclude<TicketApprovalStatus, 'pending'>, actorUserId: string | null, partnerId: string | null = null,
): ApprovalEvent {
  return { type: 'ticket.approval_decided', ticketId: req.ticketId, orgId: req.orgId, partnerId, actorUserId,
    payload: { requestId: req.id, trigger: req.trigger, status } };
}

/** Entries linked to a request, locked in id order (spec §5.2: request lock first, then entries). */
export async function lockRequestEntries(db: Tx, requestId: string) {
  return db.select().from(timeEntries).where(eq(timeEntries.approvalRequestId, requestId))
    .orderBy(asc(timeEntries.id)).for('update');
}
