import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { fromMinorUnits, toMinorUnits } from '@breeze/shared';
import { db as ambientDb, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, portalUsers, ticketApprovalRequests, tickets, timeEntries, type TicketApprovalRequest, type TicketApprovalTrigger } from '../../db/schema';
import { readOrgStampingDefaults } from '../orgCurrencyCore';
import { captureException } from '../sentry';
import type { Tx } from '../autopay/types';
import type { TimeEntryActor } from '../timeEntryService';
import { evaluateApprovalGate } from './gate';
import {
  acquirePendingRequest, approvalDecidedEvent, approvalRequestedEvent, billedMinutes, holdEntryOnRequest,
  insertApprovalComment, loadGateContext, loadPlainApprovalSettings, refreshRequestAsk,
  type ApprovalCommentAuthor, type ApprovalEvent, type PlainApprovalSettings,
} from './requests';

/**
 * Customer work approval decisions (#4617 spec §5.6): approve, deny, cancel,
 * re-ask, write-off, staff-raised requests and the expiry sweep.
 *
 * LOCK ORDER — every function receives an id, never a locked row, and runs:
 *   1. read the request (or entry) UNLOCKED to learn its ticket and org;
 *   2. `organizations FOR SHARE` (readOrgStampingDefaults), then
 *      `tickets FOR UPDATE`;
 *   3. the request `FOR UPDATE`, then its entries `FOR UPDATE ORDER BY id`;
 *   4. re-check: a request that moved ticket/org between 1 and 3 is re-read
 *      once, then refused (409 REQUEST_CHANGED).
 * The same order as the time-entry writers (timeEntryService.ts) and the org
 * movers, which all take the ticket row first — so no decision can deadlock
 * against a writer, a mover, or another decision on the same ticket.
 *
 * Errors are thrown BEFORE any write wherever possible: a decision runs inside
 * the caller's request transaction, so anything thrown after a write rolls it
 * back with the rest (an expired request found by `decide` is therefore left
 * for the sweep to stamp, rather than stamped and then rolled back).
 *
 * Events are RETURNED; the caller emits them once its transaction is done.
 */

export type DecisionErrorCode =
  | 'REQUEST_NOT_FOUND' | 'REQUEST_NOT_PENDING' | 'REQUEST_CHANGED' | 'REQUEST_EXPIRED' | 'REQUEST_NOT_REASKABLE'
  | 'REQUEST_ALREADY_PENDING' | 'NOTHING_HELD' | 'NOT_AN_APPROVER' | 'INVALID_DECISION' | 'MANAGE_BILLING_REQUIRED'
  | 'ENTRY_NOT_FOUND' | 'ENTRY_NOT_RESOLVABLE' | 'APPROVALS_DISABLED' | 'TICKET_NOT_FOUND';

export class ApprovalDecisionError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409, public code: DecisionErrorCode) {
    super(message);
    this.name = 'ApprovalDecisionError';
  }
}

export type DecisionActor =
  | { kind: 'customer'; portalUserId: string; signerName: string; ip?: string; userAgent?: string }
  | {
    kind: 'on_behalf'; userId: string; method: 'verbal' | 'email' | 'signed_document' | 'other';
    reference: string; signerName: string; signerEmail?: string;
  };

export interface DecisionResult {
  /** Entries this transition moved to `not_billed`. */
  released: string[];
  /** Entries still `awaiting_approval` afterwards (on this request, or re-held on a new one). */
  stillHeld: string[];
  events: ApprovalEvent[];
}

type LockedScope = { req: TicketApprovalRequest; partnerId: string | null };

async function partnerOfTicket(db: Tx, ticketId: string): Promise<string | null> {
  const [t] = await db.select({ partnerId: tickets.partnerId, orgPartnerId: organizations.partnerId })
    .from(tickets).innerJoin(organizations, eq(organizations.id, tickets.orgId))
    .where(eq(tickets.id, ticketId)).limit(1);
  return t?.partnerId ?? t?.orgPartnerId ?? null;
}

/**
 * Steps 1–4 of the lock order for a request. `skipLocked` (the sweep) takes
 * the ticket with SKIP LOCKED and returns null instead of queueing behind an
 * in-flight writer.
 */
async function lockRequestScope(db: Tx, requestId: string, opts: { skipLocked?: boolean } = {}): Promise<LockedScope | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [peek] = await db.select({ ticketId: ticketApprovalRequests.ticketId, orgId: ticketApprovalRequests.orgId })
      .from(ticketApprovalRequests).where(eq(ticketApprovalRequests.id, requestId)).limit(1);
    if (!peek) throw new ApprovalDecisionError('Approval request not found', 404, 'REQUEST_NOT_FOUND');
    await readOrgStampingDefaults(db, peek.orgId);
    const ticketLock = db.select({ id: tickets.id, orgId: tickets.orgId }).from(tickets)
      .where(eq(tickets.id, peek.ticketId)).limit(1);
    const [ticket] = opts.skipLocked
      ? await ticketLock.for('update', { skipLocked: true })
      : await ticketLock.for('update');
    if (!ticket) {
      if (opts.skipLocked) return null;
      throw new ApprovalDecisionError('Ticket not found', 404, 'TICKET_NOT_FOUND');
    }
    const [req] = await db.select().from(ticketApprovalRequests).where(eq(ticketApprovalRequests.id, requestId)).limit(1).for('update');
    if (!req) throw new ApprovalDecisionError('Approval request not found', 404, 'REQUEST_NOT_FOUND');
    if (req.ticketId !== peek.ticketId || req.orgId !== peek.orgId || ticket.orgId !== req.orgId) continue;
    return { req, partnerId: await partnerOfTicket(db, req.ticketId) };
  }
  throw new ApprovalDecisionError('The request changed while it was being decided — reload and retry', 409, 'REQUEST_CHANGED');
}

async function lockHeldEntries(db: Tx, requestId: string) {
  return db.select().from(timeEntries)
    .where(and(eq(timeEntries.approvalRequestId, requestId), eq(timeEntries.billingStatus, 'awaiting_approval')))
    .orderBy(asc(timeEntries.id)).for('update');
}

async function settingsFor(db: Tx, scope: LockedScope): Promise<PlainApprovalSettings> {
  if (!scope.partnerId) throw new Error(`[ticketApproval] ticket ${scope.req.ticketId} has no resolvable partner`);
  return loadPlainApprovalSettings(db, { partnerId: scope.partnerId, orgId: scope.req.orgId });
}

/**
 * Re-run the gate for each entry of `requestId` that is still held, in id
 * order, recomputing consumption after every release (spec §5.6). A passing
 * entry becomes `not_billed` (`unlink` clears its link — cancel; approve keeps
 * it as provenance). One that still crosses is held on the ticket's pending
 * request for its trigger, created if none.
 */
async function regateHeldEntries(
  db: Tx, scope: LockedScope, entries: Array<typeof timeEntries.$inferSelect>, opts: { unlink: boolean },
): Promise<DecisionResult> {
  const settings = await settingsFor(db, scope);
  const out: DecisionResult = { released: [], stillHeld: [], events: [] };
  const requestedEvents = new Map<string, ApprovalEvent>();
  for (const entry of entries) {
    const ctx = await loadGateContext(db, {
      ticketId: scope.req.ticketId, partnerId: scope.partnerId!, orgId: scope.req.orgId, settings,
      excludeEntryId: entry.id, ignoreRequestId: scope.req.id, currentRequestId: scope.req.id,
      entryStartedAt: entry.startedAt, workTypeId: entry.workTypeId, afterHoursFactsUnchanged: true,
    });
    const result = evaluateApprovalGate({
      ...ctx,
      entry: {
        isBillable: entry.isBillable, coverage: entry.coverage ?? (entry.isBillable ? 'billable' : 'non_billable'),
        minutes: entry.endedAt ? billedMinutes(entry) : null, hourlyRate: entry.hourlyRate, currencyCode: entry.currencyCode,
        isAfterHoursWorkType: ctx.isAfterHoursWorkType,
      },
      operation: 'update',
    });
    if (result.kind === 'hold') {
      const held = await holdEntryOnRequest(db, {
        ticketId: scope.req.ticketId, orgId: scope.req.orgId, trigger: result.trigger, enforcement: settings.enforcement,
        ttlHours: settings.requestTtlHours, currencyCode: ctx.budgetCurrencyCode ?? entry.currencyCode, entryId: entry.id,
        afterHoursWorkTypeId: result.trigger === 'after_hours' ? entry.workTypeId : null,
      });
      out.stillHeld.push(entry.id);
      const prior = requestedEvents.get(held.requestId);
      requestedEvents.set(held.requestId, approvalRequestedEvent(
        { id: held.requestId, ticketId: scope.req.ticketId, orgId: scope.req.orgId, trigger: result.trigger },
        held.revision, (prior?.type === 'ticket.approval_requested' && prior.payload.created) || held.created, scope.partnerId));
    } else {
      await db.update(timeEntries)
        .set({ billingStatus: 'not_billed', ...(opts.unlink ? { approvalRequestId: null } : {}), updatedAt: new Date() })
        .where(eq(timeEntries.id, entry.id));
      out.released.push(entry.id);
    }
  }
  out.events.push(...requestedEvents.values());
  return out;
}

function assertDecidable(req: TicketApprovalRequest, revision: number, now: Date): void {
  if (req.status !== 'pending') {
    throw new ApprovalDecisionError(`This request is already ${req.status}`, 409, 'REQUEST_NOT_PENDING');
  }
  if (req.revision !== revision) {
    throw new ApprovalDecisionError('The request changed since it was opened — reload to see the current amount', 409, 'REQUEST_CHANGED');
  }
  if (req.expiresAt.getTime() <= now.getTime()) {
    throw new ApprovalDecisionError('This request has expired', 409, 'REQUEST_EXPIRED');
  }
}

const commentAuthorOf = (actor: DecisionActor): ApprovalCommentAuthor => actor.kind === 'customer'
  ? { kind: 'portal', portalUserId: actor.portalUserId, name: actor.signerName }
  : { kind: 'staff', userId: actor.userId, name: actor.signerName };

export async function decideApprovalRequest(db: Tx, args: {
  requestId: string; decision: 'approved' | 'denied'; revision: number; note?: string; actor: DecisionActor;
}): Promise<DecisionResult> {
  const { actor } = args;
  if (actor.kind === 'on_behalf' && !actor.reference?.trim()) {
    throw new ApprovalDecisionError('A decision recorded on behalf of the customer needs a reference', 400, 'INVALID_DECISION');
  }
  if (!actor.signerName?.trim()) {
    throw new ApprovalDecisionError('The signer\'s name is required', 400, 'INVALID_DECISION');
  }
  const now = new Date();
  const scope = (await lockRequestScope(db, args.requestId))!;
  const { req } = scope;
  assertDecidable(req, args.revision, now);

  let signerEmail: string | null = null;
  if (actor.kind === 'customer') {
    // The approver identity comes from the stored portal user, never from the caller.
    const [pu] = await db.select({ orgId: portalUsers.orgId, email: portalUsers.email, status: portalUsers.status })
      .from(portalUsers).where(eq(portalUsers.id, actor.portalUserId)).limit(1);
    const email = pu?.email.trim().toLowerCase() ?? '';
    if (!pu || pu.status !== 'active' || pu.orgId !== req.orgId || !req.approverEmails.includes(email)) {
      throw new ApprovalDecisionError('You are not an approver for this request', 403, 'NOT_AN_APPROVER');
    }
    signerEmail = email;
  } else {
    signerEmail = actor.signerEmail?.trim().toLowerCase() || null;
  }

  const entries = await lockHeldEntries(db, req.id);
  const approved = args.decision === 'approved';
  await db.update(ticketApprovalRequests).set({
    status: args.decision,
    decidedAt: now,
    decisionOrigin: actor.kind,
    decidedByPortalUserId: actor.kind === 'customer' ? actor.portalUserId : null,
    decidedByUserId: actor.kind === 'on_behalf' ? actor.userId : null,
    signerName: actor.signerName.trim(),
    signerEmail,
    decisionMethod: actor.kind === 'on_behalf' ? actor.method : null,
    decisionReference: actor.kind === 'on_behalf' ? actor.reference.trim() : null,
    decisionNote: args.note?.trim() || null,
    decidedRevision: req.revision,
    approvedExtensionMinutes: approved ? req.requestedExtensionMinutes : null,
    approvedExtensionAmount: approved ? req.requestedExtensionAmount : null,
    ipAddress: actor.kind === 'customer' ? actor.ip ?? null : null,
    userAgent: actor.kind === 'customer' ? actor.userAgent ?? null : null,
    updatedAt: now,
  }).where(eq(ticketApprovalRequests.id, req.id));

  const who = actor.kind === 'customer' ? `${actor.signerName.trim()} (customer)` : `${actor.signerName.trim()} (recorded on the customer's behalf)`;
  await insertApprovalComment(db, req.ticketId, commentAuthorOf(actor),
    approved ? `Customer approval granted by ${who}.` : `Customer approval denied by ${who}.`);
  const decided = approvalDecidedEvent(req, args.decision, actor.kind === 'on_behalf' ? actor.userId : null, scope.partnerId);

  if (!approved) {
    // Deny stamps only (Open Decision D2): staff write off or ask again, per entry.
    return { released: [], stillHeld: entries.map((e) => e.id), events: [decided] };
  }
  // Status is stamped FIRST, so the re-run sees this approval: its extension
  // lifts the ceiling, and an approved auto after-hours link covers its entries.
  const result = await regateHeldEntries(db, scope, entries, { unlink: false });
  return { ...result, events: [decided, ...result.events] };
}

export async function cancelApprovalRequest(db: Tx, args: { requestId: string; userId: string }): Promise<DecisionResult> {
  const scope = (await lockRequestScope(db, args.requestId))!;
  const { req } = scope;
  if (req.status !== 'pending') {
    throw new ApprovalDecisionError(`This request is already ${req.status}`, 409, 'REQUEST_NOT_PENDING');
  }
  const entries = await lockHeldEntries(db, req.id);
  const now = new Date();
  await db.update(ticketApprovalRequests).set({ status: 'cancelled', updatedAt: now }).where(eq(ticketApprovalRequests.id, req.id));
  await insertApprovalComment(db, req.ticketId, { kind: 'staff', userId: args.userId }, 'Customer approval request withdrawn.');
  // Each entry re-runs the gate with the cancelled request no longer heading
  // the queue: what fits is released and unlinked, the rest re-held (spec §5.6).
  const result = await regateHeldEntries(db, scope, entries, { unlink: true });
  return { ...result, events: [approvalDecidedEvent(req, 'cancelled', args.userId, scope.partnerId), ...result.events] };
}

const REASKABLE = new Set(['denied', 'expired', 'cancelled']);

/** Staff "Ask again" / re-send: the still-held entries of a closed request move to a new `staff` request. */
export async function reaskApprovalRequest(db: Tx, args: {
  requestId: string; userId: string; message?: string; extensionMinutes?: number; extensionAmount?: string;
}): Promise<{ newRequestId: string; events: ApprovalEvent[] }> {
  const scope = (await lockRequestScope(db, args.requestId))!;
  const { req } = scope;
  if (!REASKABLE.has(req.status)) {
    throw new ApprovalDecisionError(`A ${req.status} request cannot be asked again`, 409, 'REQUEST_NOT_REASKABLE');
  }
  const entries = await lockHeldEntries(db, req.id);
  if (entries.length === 0) {
    throw new ApprovalDecisionError('No held time remains on this request', 409, 'NOTHING_HELD');
  }
  const settings = await settingsFor(db, scope);
  const acquired = await acquirePendingRequest(db, {
    ticketId: req.ticketId, orgId: req.orgId, trigger: req.trigger, origin: 'staff', enforcement: settings.enforcement,
    ttlHours: settings.requestTtlHours, currencyCode: req.currencyCode, afterHoursWorkTypeId: req.afterHoursWorkTypeId,
    requestedByUserId: args.userId, message: args.message ?? null,
  });
  await db.update(timeEntries).set({ approvalRequestId: acquired.requestId, updatedAt: new Date() })
    .where(inArray(timeEntries.id, entries.map((e) => e.id)));
  const { revision } = await refreshRequestAsk(db, acquired.requestId, { bump: !acquired.created, ttlHours: settings.requestTtlHours });
  await applyStaffAskFloor(db, acquired.requestId, args);
  await insertApprovalComment(db, req.ticketId, { kind: 'staff', userId: args.userId }, 'Customer approval requested again.');
  return {
    newRequestId: acquired.requestId,
    events: [approvalRequestedEvent({ id: acquired.requestId, ticketId: req.ticketId, orgId: req.orgId, trigger: req.trigger },
      revision, acquired.created, scope.partnerId)],
  };
}

/** A staff-specified extension raises the computed ask; it never lowers it below what the held work needs. */
async function applyStaffAskFloor(db: Tx, requestId: string, ask: { extensionMinutes?: number; extensionAmount?: string }) {
  if (ask.extensionMinutes == null && ask.extensionAmount == null) return;
  const [r] = await db.select({ minutes: ticketApprovalRequests.requestedExtensionMinutes, amount: ticketApprovalRequests.requestedExtensionAmount,
    currencyCode: ticketApprovalRequests.currencyCode })
    .from(ticketApprovalRequests).where(eq(ticketApprovalRequests.id, requestId)).limit(1);
  if (!r) return;
  const set: Partial<typeof ticketApprovalRequests.$inferInsert> = {};
  if (ask.extensionMinutes != null && ask.extensionMinutes > (r.minutes ?? 0)) set.requestedExtensionMinutes = ask.extensionMinutes;
  if (ask.extensionAmount != null && r.currencyCode) {
    const want = toMinorUnits(ask.extensionAmount, r.currencyCode);
    if (want > (r.amount ? toMinorUnits(r.amount, r.currencyCode) : 0)) set.requestedExtensionAmount = fromMinorUnits(want, r.currencyCode);
  }
  if (Object.keys(set).length) await db.update(ticketApprovalRequests).set(set).where(eq(ticketApprovalRequests.id, requestId));
}

const RESOLVABLE = new Set(['denied', 'expired', 'cancelled']);

/** Staff "Write off": a held entry on a closed request becomes `no_charge`, audited. Requires manage billing. */
export async function writeOffHeldEntry(db: Tx, args: { entryId: string; actor: TimeEntryActor }): Promise<void> {
  if (!args.actor.manageBilling) {
    throw new ApprovalDecisionError('Writing off held time requires manage billing permission', 403, 'MANAGE_BILLING_REQUIRED');
  }
  {
    const [peek] = await db.select({ ticketId: timeEntries.ticketId, orgId: timeEntries.orgId, approvalRequestId: timeEntries.approvalRequestId })
      .from(timeEntries).where(eq(timeEntries.id, args.entryId)).limit(1);
    if (!peek || !peek.ticketId || !peek.orgId) throw new ApprovalDecisionError('Time entry not found', 404, 'ENTRY_NOT_FOUND');
    if (args.actor.accessibleOrgIds !== null && !args.actor.accessibleOrgIds.includes(peek.orgId)) {
      throw new ApprovalDecisionError('Time entry not found', 404, 'ENTRY_NOT_FOUND');
    }
    await readOrgStampingDefaults(db, peek.orgId);
    await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, peek.ticketId)).limit(1).for('update');
    const [req] = peek.approvalRequestId
      ? await db.select().from(ticketApprovalRequests).where(eq(ticketApprovalRequests.id, peek.approvalRequestId)).limit(1).for('update')
      : [];
    const [entry] = await db.select().from(timeEntries).where(eq(timeEntries.id, args.entryId)).limit(1).for('update');
    if (!entry) throw new ApprovalDecisionError('Time entry not found', 404, 'ENTRY_NOT_FOUND');
    // Changed between the read and the locks: refused, not retried (a retry
    // would lock another ticket while holding this entry).
    if (entry.ticketId !== peek.ticketId || entry.approvalRequestId !== peek.approvalRequestId) {
      throw new ApprovalDecisionError('This entry changed while it was being written off — reload and retry', 409, 'ENTRY_NOT_RESOLVABLE');
    }
    // Re-checked under the lock: a concurrent re-ask may have moved the entry
    // onto a pending request, which is not resolvable.
    if (entry.billingStatus !== 'awaiting_approval' || !req || !RESOLVABLE.has(req.status)) {
      throw new ApprovalDecisionError('Only held time on a denied, expired or cancelled request can be written off', 409, 'ENTRY_NOT_RESOLVABLE');
    }
    await db.update(timeEntries).set({ billingStatus: 'no_charge', isApproved: false, approvedBy: null, approvedAt: null, updatedAt: new Date() })
      .where(eq(timeEntries.id, entry.id));
    await insertApprovalComment(db, entry.ticketId!, { kind: 'staff', userId: args.actor.userId, name: args.actor.name ?? null },
      'Held time written off as no charge.');
    args.actor.recordAuditMutation?.({
      action: 'time_entry.approval_written_off', entryId: entry.id, orgId: entry.orgId, workTypeId: entry.workTypeId,
    });
  }
}

const HOUR_MS = 3_600_000;
const MAX_COVERAGE_MS = 14 * 24 * HOUR_MS;

/** Staff raise an ask ahead of the work (`origin = 'staff'`): a budget extension or an after-hours window. */
export async function createStaffApprovalRequest(db: Tx, args: {
  ticketId: string; userId: string; trigger: TicketApprovalTrigger; message?: string;
  extensionMinutes?: number; extensionAmount?: string; coverageStartsAt?: Date; coverageEndsAt?: Date;
}): Promise<{ requestId: string; events: ApprovalEvent[] }> {
  // Validated before any lock or write (a CHECK violation would abort the caller's transaction).
  if (args.trigger === 'budget') {
    const minutesOk = args.extensionMinutes != null && Number.isInteger(args.extensionMinutes) && args.extensionMinutes > 0;
    const amountOk = args.extensionAmount != null && Number(args.extensionAmount) > 0;
    if (!minutesOk && !amountOk) {
      throw new ApprovalDecisionError('A budget request needs a positive extension in minutes or money', 400, 'INVALID_DECISION');
    }
  } else {
    const s = args.coverageStartsAt; const e = args.coverageEndsAt;
    if (!s || !e || e.getTime() <= s.getTime() || e.getTime() - s.getTime() > MAX_COVERAGE_MS) {
      throw new ApprovalDecisionError('An after-hours request needs a coverage window of at most 14 days', 400, 'INVALID_DECISION');
    }
  }
  const [peek] = await db.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, args.ticketId)).limit(1);
  if (!peek) throw new ApprovalDecisionError('Ticket not found', 404, 'TICKET_NOT_FOUND');
  await readOrgStampingDefaults(db, peek.orgId);
  const [ticket] = await db.select({ orgId: tickets.orgId, budgetCurrencyCode: tickets.budgetCurrencyCode })
    .from(tickets).where(eq(tickets.id, args.ticketId)).limit(1).for('update');
  if (!ticket) throw new ApprovalDecisionError('Ticket not found', 404, 'TICKET_NOT_FOUND');
  if (ticket.orgId !== peek.orgId) await readOrgStampingDefaults(db, ticket.orgId);
  const partnerId = await partnerOfTicket(db, args.ticketId);
  if (!partnerId) throw new ApprovalDecisionError('Ticket not found', 404, 'TICKET_NOT_FOUND');
  const settings = await loadPlainApprovalSettings(db, { partnerId, orgId: ticket.orgId });
  if (!settings.enabled) {
    throw new ApprovalDecisionError('Customer approval is not enabled for this organization', 409, 'APPROVALS_DISABLED');
  }
  const [pending] = await db.select({ id: ticketApprovalRequests.id }).from(ticketApprovalRequests)
    .where(and(eq(ticketApprovalRequests.ticketId, args.ticketId), eq(ticketApprovalRequests.trigger, args.trigger),
      eq(ticketApprovalRequests.status, 'pending'))).limit(1).for('update');
  if (pending) {
    throw new ApprovalDecisionError('This ticket already has a pending request of this kind', 409, 'REQUEST_ALREADY_PENDING');
  }
  const [org] = await db.select({ currencyCode: organizations.currencyCode }).from(organizations).where(eq(organizations.id, ticket.orgId)).limit(1);
  const currencyCode = ticket.budgetCurrencyCode ?? org?.currencyCode ?? null;
  // In the currency's own minor units: '0.001' is not a positive ask.
  if (args.trigger === 'budget' && !(args.extensionMinutes != null && args.extensionMinutes > 0)
    && !(currencyCode && args.extensionAmount != null && toMinorUnits(args.extensionAmount, currencyCode) > 0)) {
    throw new ApprovalDecisionError('A budget request needs a positive extension in minutes or money', 400, 'INVALID_DECISION');
  }
  const acquired = await acquirePendingRequest(db, {
    ticketId: args.ticketId, orgId: ticket.orgId, trigger: args.trigger, origin: 'staff', enforcement: settings.enforcement,
    ttlHours: settings.requestTtlHours, currencyCode, requestedByUserId: args.userId, message: args.message ?? null,
  });
  await refreshRequestAsk(db, acquired.requestId, { bump: false, ttlHours: settings.requestTtlHours });
  if (args.trigger === 'budget') {
    await applyStaffAskFloor(db, acquired.requestId, args);
  } else {
    await db.update(ticketApprovalRequests).set({ coverageStartsAt: args.coverageStartsAt!, coverageEndsAt: args.coverageEndsAt! })
      .where(eq(ticketApprovalRequests.id, acquired.requestId));
  }
  await insertApprovalComment(db, args.ticketId, { kind: 'staff', userId: args.userId },
    args.trigger === 'budget' ? 'Customer approval requested for additional work on this ticket.' : 'Customer approval requested for after-hours work on this ticket.');
  return {
    requestId: acquired.requestId,
    events: [approvalRequestedEvent({ id: acquired.requestId, ticketId: args.ticketId, orgId: ticket.orgId, trigger: args.trigger }, 1, true, partnerId)],
  };
}

const EXPIRY_BATCH = 200;

/**
 * The 5-minute sweep (jobs/ticketSlaWorker.ts). Selects due ids, then expires
 * EACH in its own system transaction under the full lock order, the ticket
 * taken with SKIP LOCKED so the sweep never queues behind an in-flight writer
 * (that request is picked up next run). Never one bulk UPDATE: that would
 * take request locks without their ticket lock, out of order. Entries stay
 * held (spec §5.6). Opens its own contexts — call it outside any.
 */
export async function expireDueApprovalRequests(now: Date): Promise<{ expired: number; events: ApprovalEvent[] }> {
  const due = await runOutsideDbContext(() => withSystemDbAccessContext(() => ambientDb
    .select({ id: ticketApprovalRequests.id }).from(ticketApprovalRequests)
    .where(and(eq(ticketApprovalRequests.status, 'pending'), lte(ticketApprovalRequests.expiresAt, now)))
    // Most overdue first, so a row skipped this run cannot starve newer ones.
    .orderBy(asc(ticketApprovalRequests.expiresAt), asc(ticketApprovalRequests.id)).limit(EXPIRY_BATCH)));
  const events: ApprovalEvent[] = [];
  for (const { id } of due) {
    try {
      const ev = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        const scope = await lockRequestScope(ambientDb, id, { skipLocked: true });
        if (!scope) return null;
        const { req } = scope;
        if (req.status !== 'pending' || req.expiresAt.getTime() > now.getTime()) return null;
        await ambientDb.update(ticketApprovalRequests).set({ status: 'expired', updatedAt: new Date() })
          .where(eq(ticketApprovalRequests.id, req.id));
        await insertApprovalComment(ambientDb, req.ticketId, { kind: 'system' },
          'Customer approval request expired without a decision. The held time stays on hold.');
        return approvalDecidedEvent(req, 'expired', null, scope.partnerId);
      }));
      if (ev) events.push(ev);
    } catch (err) {
      // Deleted (ticket erased) between the due-list read and the lock: nothing to expire.
      if (err instanceof ApprovalDecisionError && err.code === 'REQUEST_NOT_FOUND') continue;
      // One bad row must not stall the sweep; it is retried next run — and
      // reported, since a row that fails every run would otherwise only log.
      console.error('[ticketApproval] expiry failed for request', id, err instanceof Error ? err.message : err);
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'ticketApprovalExpiry', requestId: id });
    }
  }
  if (due.length === EXPIRY_BATCH) console.warn(`[ticketApproval] expiry hit the ${EXPIRY_BATCH}-row cap — backlog may be growing`);
  return { expired: events.length, events };
}
