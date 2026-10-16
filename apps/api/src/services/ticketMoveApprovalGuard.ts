/**
 * Customer work approval (#4617): a ticket with a PENDING approval request
 * cannot change organization. The request's approver and notify lists were
 * frozen from the SOURCE org's contacts when it was raised, and a customer
 * decision requires a portal user of the request's org whose email is on that
 * list. After a move nobody could satisfy both, so the request would sit
 * undecidable until it expired. Both movers therefore refuse with a 409 that
 * names the count. Staff cancel the request (its held time is then re-asked
 * from the new org's contacts after the move) or record the decision first.
 *
 * Decided requests and held entries on them DO move: their figures are
 * history, and an "ask again" after the move resolves the new org's
 * recipients. Org MERGE is not a move: the loser's contacts and portal users
 * move to the survivor with the requests, so a pending request stays decidable.
 *
 * Call INSIDE the mover's transaction, after its `UPDATE tickets`. It takes NO
 * lock: every writer of a pending request (the gate, the decision paths, the
 * sweep) holds the ticket row lock first, and the mover holds it now, so no
 * request can become pending on these tickets until the move commits.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { db } from '../db';
import { ticketApprovalRequests } from '../db/schema';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 409 carrier shared by ticket and device moves (own class, like TicketMoveHourBlockError). */
export class TicketMoveApprovalPendingError extends Error {
  readonly status = 409 as const;
  readonly code = 'APPROVAL_REQUEST_PENDING' as const;
  constructor(public details: { pendingApprovalRequests: number }) {
    super(`${details.pendingApprovalRequests} customer approval ${details.pendingApprovalRequests === 1 ? 'request is' : 'requests are'} ` +
      'still pending on this ticket. Cancel the request or record the customer\'s decision before moving it to another organization');
    this.name = 'TicketMoveApprovalPendingError';
  }
}

export async function assertNoPendingApprovalRequest(tx: Tx, input: { ticketIds: string[] }): Promise<void> {
  if (input.ticketIds.length === 0) return;
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(ticketApprovalRequests)
    .where(and(inArray(ticketApprovalRequests.ticketId, input.ticketIds), eq(ticketApprovalRequests.status, 'pending')));
  const n = row?.n ?? 0;
  if (n > 0) throw new TicketMoveApprovalPendingError({ pendingApprovalRequests: n });
}
