import { and, arrayContains, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { ticketApprovalRequests, tickets, type TicketApprovalRequest } from '../../db/schema';
import type { Tx } from '../autopay/types';
import { normalizeApprovalEmail } from './requests';

/**
 * Customer portal read model for work approval requests (#4617 spec §6.2).
 *
 * WHO SEES WHAT
 * - A request is visible to a portal user when it is in the session's org and
 *   the session email (normalised exactly as `resolveRecipients` froze the
 *   lists) is in `approver_emails` (role `approver`) or `notify_emails`
 *   (role `notify`). Ticket OWNERSHIP is deliberately not consulted: a billing
 *   contact decides spend on tickets they did not open (spec §6.2), while the
 *   ticket thread itself stays behind `portalTicketOwnership`.
 * - Only an approver on a still-pending, unexpired request `canDecide`.
 *
 * WHAT IS PROJECTED — an explicit allow-list. Never the recipient lists (a
 * requester would learn the billing contacts' addresses), staff user ids,
 * the on-behalf method/reference/note (the MSP's internal evidence trail, the
 * same rule as quote acceptances), or the decider's IP/user agent. Never any
 * ticket comment. `message` is the staff "message to the customer".
 *
 * The caller passes the session email; it is only ever compared, never trusted
 * as an identity — the decision service re-derives the approver from the
 * portal_users row.
 */

export type PortalApprovalRole = 'approver' | 'notify';

export interface PortalApprovalView {
  id: string;
  ticketId: string;
  ticketNumber: string;
  ticketSubject: string;
  trigger: TicketApprovalRequest['trigger'];
  status: TicketApprovalRequest['status'];
  revision: number;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  decisionOrigin: TicketApprovalRequest['decisionOrigin'];
  message: string | null;
  ask: {
    minutes: number | null;
    amount: string | null;
    currencyCode: string | null;
    coverageStartsAt: Date | null;
    coverageEndsAt: Date | null;
  };
  snapshot: {
    budgetMinutes: number | null;
    consumedMinutes: number | null;
    budgetAmount: string | null;
    consumedAmount: string | null;
  };
  role: PortalApprovalRole;
  canDecide: boolean;
}

type RequestWithTicket = TicketApprovalRequest & { ticketNumber: string | null; ticketSubject: string | null };

export function recipientRoleOf(
  req: Pick<TicketApprovalRequest, 'approverEmails' | 'notifyEmails'>, sessionEmail: string | null | undefined,
): PortalApprovalRole | null {
  const email = normalizeApprovalEmail(sessionEmail);
  if (!email) return null;
  if (req.approverEmails.includes(email)) return 'approver';
  if (req.notifyEmails.includes(email)) return 'notify';
  return null;
}

export function toPortalApprovalView(row: RequestWithTicket, sessionEmail: string, now: Date = new Date()): PortalApprovalView | null {
  const role = recipientRoleOf(row, sessionEmail);
  if (!role) return null;
  return {
    id: row.id,
    ticketId: row.ticketId,
    ticketNumber: row.ticketNumber ?? '',
    ticketSubject: row.ticketSubject ?? '',
    trigger: row.trigger,
    status: row.status,
    revision: row.revision,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    decisionOrigin: row.decisionOrigin,
    message: row.message,
    ask: {
      minutes: row.requestedExtensionMinutes,
      amount: row.requestedExtensionAmount,
      currencyCode: row.currencyCode,
      coverageStartsAt: row.coverageStartsAt,
      coverageEndsAt: row.coverageEndsAt,
    },
    snapshot: {
      budgetMinutes: row.budgetMinutesAtRequest,
      consumedMinutes: row.consumedMinutesAtRequest,
      budgetAmount: row.budgetAmountAtRequest,
      consumedAmount: row.consumedAmountAtRequest,
    },
    role,
    canDecide: role === 'approver' && row.status === 'pending' && row.expiresAt.getTime() > now.getTime(),
  };
}

const LIST_LIMIT = 100;

function selectWithTicket(db: Tx) {
  return db.select({
    request: ticketApprovalRequests,
    ticketNumber: tickets.internalNumber,
    ticketFallbackNumber: tickets.ticketNumber,
    ticketSubject: tickets.subject,
  })
    .from(ticketApprovalRequests)
    // Same-org join on the composite key; a soft-deleted ticket hides its requests.
    .innerJoin(tickets, and(eq(tickets.id, ticketApprovalRequests.ticketId), eq(tickets.orgId, ticketApprovalRequests.orgId)));
}

type JoinedRow = { request: TicketApprovalRequest; ticketNumber: string | null; ticketFallbackNumber: string | null; ticketSubject: string | null };

const flatten = (r: JoinedRow): RequestWithTicket => ({
  ...r.request, ticketNumber: r.ticketNumber ?? r.ticketFallbackNumber, ticketSubject: r.ticketSubject,
});

/** Requests in `orgId` the session email is a recipient of, newest first. */
export async function listPortalApprovals(
  db: Tx, args: { orgId: string; email: string; pendingOnly: boolean; now?: Date },
): Promise<PortalApprovalView[]> {
  const email = normalizeApprovalEmail(args.email);
  if (!email) return [];
  const now = args.now ?? new Date();
  const rows = await selectWithTicket(db)
    .where(and(
      eq(ticketApprovalRequests.orgId, args.orgId),
      isNull(tickets.deletedAt),
      or(arrayContains(ticketApprovalRequests.approverEmails, [email]), arrayContains(ticketApprovalRequests.notifyEmails, [email])),
      ...(args.pendingOnly ? [eq(ticketApprovalRequests.status, 'pending'), gt(ticketApprovalRequests.expiresAt, now)] : []),
    ))
    .orderBy(desc(ticketApprovalRequests.requestedAt), desc(ticketApprovalRequests.id))
    .limit(LIST_LIMIT);
  return rows.map((r) => toPortalApprovalView(flatten(r), email, now)).filter((v): v is PortalApprovalView => v !== null);
}

/** One request, or null when it is not in `orgId`, its ticket is deleted, or the session email is not a recipient. */
export async function findPortalApproval(
  db: Tx, args: { orgId: string; requestId: string; email: string; now?: Date },
): Promise<PortalApprovalView | null> {
  const email = normalizeApprovalEmail(args.email);
  if (!email) return null;
  const [row] = await selectWithTicket(db)
    .where(and(
      eq(ticketApprovalRequests.id, args.requestId),
      eq(ticketApprovalRequests.orgId, args.orgId),
      isNull(tickets.deletedAt),
    ))
    .limit(1);
  return row ? toPortalApprovalView(flatten(row), email, args.now ?? new Date()) : null;
}
