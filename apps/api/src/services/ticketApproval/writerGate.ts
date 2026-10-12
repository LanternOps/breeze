import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { timeEntries } from '../../db/schema';
import type { BillingStatus } from '@breeze/shared';
import { evaluateApprovalGate, type GateOperation, type GateTrigger } from './gate';
import {
  acquirePendingRequest, afterEntryLeftRequest, approvalRequestedEvent, insertApprovalComment, loadGateContext,
  loadPlainApprovalSettings, refreshRequestAsk, type ApprovalCommentAuthor, type ApprovalEvent,
} from './requests';

/**
 * The approval gate as the time-entry writers use it (#4617 spec §5.1–§5.5).
 * timeEntryService.ts is the only caller; this module exists so the service's
 * lock/write sequence stays readable and so its large queue-mocked unit suite
 * can stub the gate wholesale (the gate itself is proven against real
 * Postgres in __tests__/integration/ticketApproval.*.integration.test.ts).
 *
 * Every function runs on the caller's request transaction AFTER the caller
 * took `organizations FOR SHARE -> tickets FOR UPDATE` on every ticket the
 * write touches (both tickets on a relink or a cross-ticket auto-stop, in
 * ascending id order).
 */

type StoredBillingStatus = typeof timeEntries.$inferSelect['billingStatus'];

export interface EntryPeek {
  id: string;
  ticketId: string | null;
  endedAt: Date | null;
  approvalRequestId: string | null;
}

const peekColumns = {
  id: timeEntries.id, ticketId: timeEntries.ticketId, endedAt: timeEntries.endedAt,
  approvalRequestId: timeEntries.approvalRequestId,
};

/** UNLOCKED read of the entry's ticket, so the writer can lock the ticket BEFORE the entry (spec §5.2). */
export async function peekEntry(id: string): Promise<EntryPeek | null> {
  const [row] = await db.select(peekColumns).from(timeEntries).where(eq(timeEntries.id, id)).limit(1);
  return row ?? null;
}

/** UNLOCKED read of the user's running timer (stop / auto-stop lock its ticket first). */
export async function peekRunningEntry(userId: string): Promise<EntryPeek | null> {
  const [row] = await db.select(peekColumns).from(timeEntries)
    .where(and(eq(timeEntries.userId, userId), isNull(timeEntries.endedAt))).limit(1);
  return row ?? null;
}

export interface GatedWriteInput {
  operation: GateOperation;
  /** Ticket and org the row will carry after the write. */
  ticketId: string | null;
  partnerId: string;
  orgId: string | null;
  /** Null for an INSERT. */
  before: { id: string; billingStatus: StoredBillingStatus; approvalRequestId: string | null; ticketId: string | null; orgId: string | null } | null;
  after: {
    startedAt: Date;
    workTypeId: string | null;
    isBillable: boolean;
    coverage: 'billable' | 'included' | 'non_billable';
    hourlyRate: string | null;
    currencyCode: string | null;
    /** The billing stamp's status (never 'billed' on a gated write). */
    billingStatus: StoredBillingStatus;
    /** Billed quantity as written, COALESCE(billable, duration); null while running. */
    minutes: number | null;
  };
  /** Work type and start time unchanged by this write (after-hours provenance, requests.ts). */
  afterHoursFactsUnchanged: boolean;
}

export type GatedWritePlan =
  | { kind: 'refuse'; trigger: GateTrigger; pendingRequestId: string | null }
  | {
    kind: 'write';
    /** Final status to write. */
    billingStatus: BillingStatus;
    /** undefined = leave the column as it is. */
    approvalRequestId: string | null | undefined;
    hold: { requestId: string; trigger: GateTrigger; created: boolean } | null;
    /** A pending request the entry is leaving; settled after the row write. */
    leftRequestId: string | null;
    ttlHours: number;
  };

const HELD: StoredBillingStatus = 'awaiting_approval';

/** Whether this write can be held at all (spec §5.1). Cheap: no queries. */
function isCandidate(i: GatedWriteInput): boolean {
  return i.ticketId != null && i.orgId != null && i.after.isBillable && i.after.coverage === 'billable'
    && (i.after.billingStatus === 'not_billed' || i.after.billingStatus === HELD);
}

/**
 * Decide the row's billing status BEFORE it is written. On a hold the pending
 * request is locked (or created) here so the INSERT/UPDATE itself carries the
 * link; the ask is recomputed by {@link settleGatedWrite} once the row exists.
 */
export async function planGatedWrite(i: GatedWriteInput): Promise<GatedWritePlan> {
  const wasHeld = i.before?.billingStatus === HELD;
  const sameTicket = i.before != null && i.before.ticketId === i.ticketId;
  const ownRequestId = sameTicket ? i.before!.approvalRequestId : null;
  // A stamp that still reads 'awaiting_approval' (an edit that did not touch
  // billing) is not a decision: the gate below is the only writer of that value.
  const settledStatus: BillingStatus = i.after.billingStatus === HELD ? 'not_billed' : i.after.billingStatus;

  let settings: Awaited<ReturnType<typeof loadPlainApprovalSettings>> | null = null;
  if (isCandidate(i)) {
    settings = await loadPlainApprovalSettings(db, { partnerId: i.partnerId, orgId: i.orgId! });
    if (settings.enabled) {
      const ctx = await loadGateContext(db, {
        ticketId: i.ticketId!, partnerId: i.partnerId, orgId: i.orgId!, settings,
        excludeEntryId: i.before?.id ?? null,
        // The entry's own pending request is not a queue head for it: an edit
        // is re-evaluated as if new (spec §5.5), and leaving re-asks the rest.
        ignoreRequestId: ownRequestId,
        currentRequestId: ownRequestId,
        entryStartedAt: i.after.startedAt,
        workTypeId: i.after.workTypeId,
        afterHoursFactsUnchanged: sameTicket && i.afterHoursFactsUnchanged,
      });
      const result = evaluateApprovalGate({
        ...ctx,
        entry: { ...i.after, isAfterHoursWorkType: ctx.isAfterHoursWorkType },
        operation: i.operation,
      });
      if (result.kind === 'refuse') {
        return { kind: 'refuse', trigger: result.trigger, pendingRequestId: ctx.pendingRequestIds[result.trigger] };
      }
      if (result.kind === 'hold') {
        const acquired = await acquirePendingRequest(db, {
          ticketId: i.ticketId!, orgId: i.orgId!, trigger: result.trigger, enforcement: settings.enforcement,
          ttlHours: settings.requestTtlHours, currencyCode: ctx.budgetCurrencyCode ?? i.after.currencyCode,
          afterHoursWorkTypeId: result.trigger === 'after_hours' ? i.after.workTypeId : null,
        });
        const prev = i.before?.approvalRequestId ?? null;
        return {
          kind: 'write', billingStatus: 'awaiting_approval', approvalRequestId: acquired.requestId,
          hold: { requestId: acquired.requestId, trigger: result.trigger, created: acquired.created },
          leftRequestId: wasHeld && prev && prev !== acquired.requestId ? prev : null,
          ttlHours: settings.requestTtlHours,
        };
      }
    }
  }
  // Pass. A held entry is released and unlinked; a settled entry keeps its
  // provenance link unless it changes ticket — the link FK is
  // (approval_request_id, ticket_id), so it cannot survive a relink.
  const prev = i.before?.approvalRequestId ?? null;
  const ttlHours = settings?.requestTtlHours
    ?? (wasHeld && prev ? (await loadPlainApprovalSettings(db, {
      partnerId: i.partnerId, orgId: i.before!.orgId ?? i.orgId!,
    })).requestTtlHours : 0);
  return {
    kind: 'write',
    billingStatus: settledStatus,
    approvalRequestId: wasHeld || (prev != null && !sameTicket) ? null : undefined,
    hold: null,
    leftRequestId: wasHeld ? prev : null,
    ttlHours,
  };
}

const HOLD_COMMENT: Record<GateTrigger, string> = {
  budget: 'Time over this ticket\'s budget is on hold until the customer approves the extra work.',
  after_hours: 'After-hours time is on hold until the customer approves it.',
};

/**
 * After the row is written: recompute the hold request's ask (bumping
 * `revision` unless it was created by this write) and settle a request the
 * entry left. Returns the events to emit.
 */
export async function settleGatedWrite(
  plan: Extract<GatedWritePlan, { kind: 'write' }>,
  ctx: { ticketId: string | null; orgId: string | null; partnerId: string; author: ApprovalCommentAuthor },
): Promise<ApprovalEvent[]> {
  const events: ApprovalEvent[] = [];
  if (plan.hold && ctx.ticketId && ctx.orgId) {
    const { revision } = await refreshRequestAsk(db, plan.hold.requestId, { bump: !plan.hold.created, ttlHours: plan.ttlHours });
    if (plan.hold.created) await insertApprovalComment(db, ctx.ticketId, ctx.author, HOLD_COMMENT[plan.hold.trigger]);
    events.push(approvalRequestedEvent(
      { id: plan.hold.requestId, ticketId: ctx.ticketId, orgId: ctx.orgId, trigger: plan.hold.trigger },
      revision, plan.hold.created, ctx.partnerId));
  }
  if (plan.leftRequestId) {
    const ev = await afterEntryLeftRequest(db, plan.leftRequestId, { ttlHours: plan.ttlHours, author: ctx.author });
    if (ev) events.push({ ...ev, partnerId: ctx.partnerId });
  }
  return events;
}

/**
 * A held entry was deleted: settle the request it was held on — cancel an
 * emptied `auto` request, else re-ask over what remains. Caller holds the
 * ticket lock.
 */
export async function settleRemovedEntry(
  entry: { billingStatus: StoredBillingStatus; approvalRequestId: string | null; partnerId: string; orgId: string | null },
  author: ApprovalCommentAuthor,
): Promise<ApprovalEvent[]> {
  if (entry.billingStatus !== HELD || !entry.approvalRequestId || !entry.orgId) return [];
  const { requestTtlHours } = await loadPlainApprovalSettings(db, { partnerId: entry.partnerId, orgId: entry.orgId });
  const ev = await afterEntryLeftRequest(db, entry.approvalRequestId, { ttlHours: requestTtlHours, author });
  return ev ? [{ ...ev, partnerId: entry.partnerId }] : [];
}
