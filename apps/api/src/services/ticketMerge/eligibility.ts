/**
 * Merge eligibility (#8972, spec §3.1; D3).
 *
 * Two halves, so every rule is unit-testable without a database:
 *   - `loadMergeEligibilityFacts` reads what the rules need, on the CALLER's
 *     connection (Gate B1: no nested system-context read inside the request
 *     transaction). Under the merge transaction it runs after the ticket row
 *     locks, so the facts are the locked state.
 *   - `evaluateMergeEligibility` applies the rules and returns EVERY refusal
 *     (the preview lists them all; execute throws the first).
 *
 * The site/device restriction (`MERGE_SCOPE_DENIED`) is the caller's own
 * visibility rule, passed in as `canAccessTicket`: the staff route uses the
 * same site axis as `getScopedTicketOr404`, the AI tool its own ticket access
 * check. Org access itself is decided before eligibility (404).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  actionIntents,
  migrationWindows,
  organizations,
  serviceDeliverableOccurrences,
  ticketApprovalRequests,
  tickets,
} from '../../db/schema';
import type { DbExecutor } from '../ticketRowLock';
import { MergeRefusedError, type MergeRefusal, type MergeRefusalSide } from './errors';

/** The ticket columns merge decides on. */
export interface MergeTicketRow {
  id: string;
  orgId: string;
  partnerId: string | null;
  status: (typeof tickets.$inferSelect)['status'];
  statusId: string | null;
  deletedAt: Date | null;
  mergedIntoTicketId: string | null;
  workKind: (typeof tickets.$inferSelect)['workKind'];
  migrationWindowId: string | null;
  budgetMinutes: number | null;
  budgetAmount: string | null;
  deviceId: string | null;
  createdAt: Date;
  requesterContactId: string | null;
  submittedBy: string | null;
  submitterEmail: string | null;
  internalNumber: string | null;
  ticketNumber: string;
}

export const mergeTicketColumns = () => ({
  id: tickets.id,
  orgId: tickets.orgId,
  partnerId: tickets.partnerId,
  status: tickets.status,
  statusId: tickets.statusId,
  deletedAt: tickets.deletedAt,
  mergedIntoTicketId: tickets.mergedIntoTicketId,
  workKind: tickets.workKind,
  migrationWindowId: tickets.migrationWindowId,
  budgetMinutes: tickets.budgetMinutes,
  budgetAmount: tickets.budgetAmount,
  deviceId: tickets.deviceId,
  createdAt: tickets.createdAt,
  requesterContactId: tickets.requesterContactId,
  submittedBy: tickets.submittedBy,
  submitterEmail: tickets.submitterEmail,
  internalNumber: tickets.internalNumber,
  ticketNumber: tickets.ticketNumber,
});

/** Read the merge rows of the given tickets (unlocked; the caller locks first when it must). */
export async function loadMergeTicketRows(
  exec: Pick<DbExecutor, 'select'>,
  ids: readonly string[],
): Promise<Map<string, MergeTicketRow>> {
  if (ids.length === 0) return new Map();
  const rows = (await exec.select(mergeTicketColumns()).from(tickets)
    .where(inArray(tickets.id, [...new Set(ids)]))) as MergeTicketRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** Everything the rules need beyond the two rows. */
export interface MergeEligibilityFacts {
  /** `organizations.status` of the (shared) org; null when unreadable. */
  orgStatus: string | null;
  /** Tickets (of the pair) that have ANY `ticket_approval_requests` row (D3). */
  ticketsWithApprovalRequests: ReadonlySet<string>;
  /** Tickets (of the pair) pinned to a service deliverable occurrence. */
  pinnedTicketIds: ReadonlySet<string>;
  /** Migration window ids (of the pair's tickets) that are open or not visible. */
  openOrHiddenWindowIds: ReadonlySet<string>;
  /** Pending (not terminal) action intents scoped to the SOURCE. */
  pendingSourceIntents: number;
}

/** Action intents a merge would strand on the tombstone (spec §3.1). */
const PENDING_INTENT_STATUSES = ['pending_approval', 'approved', 'executing'] as const;

export async function loadMergeEligibilityFacts(
  exec: DbExecutor,
  src: MergeTicketRow,
  dst: MergeTicketRow,
): Promise<MergeEligibilityFacts> {
  const pair = [src.id, dst.id];
  const [org] = await exec.select({ status: organizations.status }).from(organizations)
    .where(eq(organizations.id, src.orgId)).limit(1);
  const approvals = await exec.selectDistinct({ ticketId: ticketApprovalRequests.ticketId })
    .from(ticketApprovalRequests).where(inArray(ticketApprovalRequests.ticketId, pair));
  const pinned = await exec.selectDistinct({ ticketId: serviceDeliverableOccurrences.ticketId })
    .from(serviceDeliverableOccurrences)
    .where(and(inArray(serviceDeliverableOccurrences.ticketId, pair), eq(serviceDeliverableOccurrences.orgId, src.orgId)));
  const windowIds = [...new Set([src.migrationWindowId, dst.migrationWindowId].filter((w): w is string => !!w))];
  let openOrHidden = new Set<string>();
  if (windowIds.length > 0) {
    // A window this context cannot see (an org-scope caller cannot read
    // partner rows) counts as open: fail closed rather than merge an import
    // that may still be writing to it.
    const visible = await exec.select({ id: migrationWindows.id, status: migrationWindows.status })
      .from(migrationWindows).where(inArray(migrationWindows.id, windowIds));
    const closed = new Set(visible.filter((w) => w.status === 'closed').map((w) => w.id));
    openOrHidden = new Set(windowIds.filter((w) => !closed.has(w)));
  }
  const [intents] = await exec.select({ n: sql<number>`count(*)::int` }).from(actionIntents)
    .where(and(eq(actionIntents.scopeTicketId, src.id), inArray(actionIntents.status, [...PENDING_INTENT_STATUSES])));
  return {
    orgStatus: org?.status ?? null,
    ticketsWithApprovalRequests: new Set(approvals.map((r) => r.ticketId)),
    pinnedTicketIds: new Set(pinned.map((r) => r.ticketId).filter((t): t is string => !!t)),
    openOrHiddenWindowIds: openOrHidden,
    pendingSourceIntents: intents?.n ?? 0,
  };
}

function sideOf(srcHit: boolean, dstHit: boolean): MergeRefusalSide | null {
  if (srcHit && dstHit) return 'both';
  if (srcHit) return 'source';
  if (dstHit) return 'survivor';
  return null;
}

export function hasBudget(t: Pick<MergeTicketRow, 'budgetMinutes' | 'budgetAmount'>): boolean {
  return t.budgetMinutes != null || t.budgetAmount != null;
}

/** The pure rules (§3.1). Returns every refusal, in a stable order. */
export function evaluateMergeEligibility(
  src: MergeTicketRow,
  dst: MergeTicketRow,
  facts: MergeEligibilityFacts,
  scope: { sourceAccessible: boolean; survivorAccessible: boolean },
): MergeRefusal[] {
  const out: MergeRefusal[] = [];
  const push = (code: MergeRefusal['code'], side: MergeRefusalSide, message: string) => out.push({ code, side, message });

  if (src.id === dst.id) {
    push('MERGE_SAME_TICKET', 'both', 'A ticket cannot be merged into itself');
    return out;
  }
  if (src.orgId !== dst.orgId) {
    push('MERGE_CROSS_ORG', 'both', 'Both tickets must belong to the same organization. Move one first, then merge.');
    return out;
  }
  const scopeSide = sideOf(!scope.sourceAccessible, !scope.survivorAccessible);
  if (scopeSide) push('MERGE_SCOPE_DENIED', scopeSide, 'You do not have access to both tickets');
  if (facts.orgStatus === 'merging') {
    push('ORG_MERGING', 'both', 'This organization is being merged; try again when that finishes');
  }
  if (src.deletedAt || src.mergedIntoTicketId) {
    push('MERGE_SOURCE_INELIGIBLE', 'source',
      src.mergedIntoTicketId ? 'This ticket was already merged into another ticket' : 'A deleted ticket cannot be merged');
  }
  if (dst.deletedAt || dst.mergedIntoTicketId || dst.status === 'closed') {
    push('MERGE_SURVIVOR_INELIGIBLE', 'survivor',
      dst.mergedIntoTicketId
        ? 'The target ticket was itself merged into another ticket'
        : dst.deletedAt ? 'The target ticket is deleted' : 'A closed ticket cannot receive a merge; reopen it first');
  }
  const pinSide = sideOf(facts.pinnedTicketIds.has(src.id), facts.pinnedTicketIds.has(dst.id));
  if (pinSide) push('MERGE_DELIVERABLE_PINNED', pinSide, 'A ticket tied to a service deliverable cannot be merged');
  const windowSide = sideOf(
    !!src.migrationWindowId && facts.openOrHiddenWindowIds.has(src.migrationWindowId),
    !!dst.migrationWindowId && facts.openOrHiddenWindowIds.has(dst.migrationWindowId),
  );
  if (windowSide) push('MERGE_IMPORT_WINDOW', windowSide, 'A ticket from an open migration import cannot be merged until the import closes');
  // D3 (a): any approval request or a budget, on EITHER side.
  const approvalSide = sideOf(
    facts.ticketsWithApprovalRequests.has(src.id) || hasBudget(src),
    facts.ticketsWithApprovalRequests.has(dst.id) || hasBudget(dst),
  );
  if (approvalSide) {
    push('MERGE_APPROVAL_STATE', approvalSide, 'A ticket with a customer approval request or a budget cannot be merged');
  }
  if (src.workKind !== dst.workKind) {
    push('MERGE_WORK_KIND_MISMATCH', 'both', 'Planned work and support tickets cannot be merged into each other');
  }
  if (facts.pendingSourceIntents > 0) {
    push('MERGE_PENDING_INTENTS', 'source', 'This ticket has AI actions waiting for approval; resolve them first');
  }
  return out;
}

export interface MergeEligibilityContext {
  /**
   * The caller's site/device visibility rule for one ticket (org access is
   * already decided). Defaults to "visible".
   */
  canAccessTicket?: (ticket: MergeTicketRow) => Promise<boolean>;
}

/** Every refusal, for the preview. */
export async function checkMergeEligibility(
  exec: DbExecutor,
  src: MergeTicketRow,
  dst: MergeTicketRow,
  ctx: MergeEligibilityContext = {},
): Promise<MergeRefusal[]> {
  if (src.id === dst.id || src.orgId !== dst.orgId) {
    return evaluateMergeEligibility(src, dst, EMPTY_FACTS, { sourceAccessible: true, survivorAccessible: true });
  }
  const facts = await loadMergeEligibilityFacts(exec, src, dst);
  const can = ctx.canAccessTicket ?? (async () => true);
  return evaluateMergeEligibility(src, dst, facts, {
    sourceAccessible: await can(src),
    survivorAccessible: await can(dst),
  });
}

/** Throws the first refusal (execute, under the locks). */
export async function assertMergeEligible(
  exec: DbExecutor,
  src: MergeTicketRow,
  dst: MergeTicketRow,
  ctx: MergeEligibilityContext = {},
): Promise<void> {
  const [first] = await checkMergeEligibility(exec, src, dst, ctx);
  if (first) throw MergeRefusedError.from(first);
}

const EMPTY_FACTS: MergeEligibilityFacts = {
  orgStatus: null,
  ticketsWithApprovalRequests: new Set(),
  pinnedTicketIds: new Set(),
  openOrHiddenWindowIds: new Set(),
  pendingSourceIntents: 0,
};
