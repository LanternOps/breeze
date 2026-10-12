import { and, eq, inArray } from 'drizzle-orm';
import { fromMinorUnits, toMinorUnits } from '@breeze/shared';
import { ticketApprovalRequests, tickets, timeEntries, users, type TicketApprovalRequest } from '../../db/schema';
import type { Tx } from '../autopay/types';
import { entryAmountMinor } from './gate';
import { approvedExtensionsOf, billedMinutes } from './requests';
import { resolveTicketApprovalSettings, type EffectiveTicketApprovalSettings } from './settings';

/**
 * Staff read model for a ticket's customer work approval state (#4617 spec
 * §6.3): the policy, the budget, consumption, held time, the ceiling
 * (budget + approved extensions) and every request with its revision and
 * recipient split. READ-ONLY and lock-free: it is a display snapshot, never
 * an input to a decision (decisions re-read everything under the ticket lock
 * and bind to the revision the staff member saw).
 *
 * Figures use the gate's own definitions (requests.ts sumConsumption,
 * approvedExtensionsOf, gate.ts entryAmountMinor) so the bar the technician
 * sees is the bar the gate measures against.
 */

const CONSUMED_STATUSES = new Set(['not_billed', 'billed', 'contract']);

export interface SummaryEntry {
  id: string;
  approvalRequestId: string | null;
  billingStatus: string;
  isBillable: boolean;
  coverage: string | null;
  endedAt: Date | null;
  billableMinutes: number | null;
  durationMinutes: number | null;
  hourlyRate: string | null;
  currencyCode: string | null;
}

export interface SummaryInput {
  policy: EffectiveTicketApprovalSettings;
  ticket: { budgetMinutes: number | null; budgetAmount: string | null; budgetCurrencyCode: string | null };
  requests: TicketApprovalRequest[];
  entries: SummaryEntry[];
  /** Staff display names for requested_by / decided_by user ids. */
  userNames: Map<string, string>;
}

export type TicketApprovalRequestView = Omit<TicketApprovalRequest, 'ipAddress' | 'userAgent' | 'createdAt' | 'updatedAt'> & {
  heldEntryCount: number;
  requestedByUserName: string | null;
  decidedByUserName: string | null;
};

export interface TicketApprovalSummary {
  policy: EffectiveTicketApprovalSettings;
  budget: { minutes: number | null; amount: string | null; currency: string | null };
  consumed: { minutes: number; amount: string | null };
  held: { minutes: number; amount: string | null; entryCount: number; unpricedEntryCount: number };
  approvedExtensions: { minutes: number; amount: string | null };
  /** Budget + approved extensions, per axis; null where the ticket has no budget on that axis. */
  ceiling: { minutes: number | null; amount: string | null };
  /** Newest first. */
  requests: TicketApprovalRequestView[];
}

export function buildTicketApprovalSummary(input: SummaryInput): TicketApprovalSummary {
  const { ticket } = input;
  const cur = ticket.budgetCurrencyCode;
  const money = (minor: number): string | null => (cur ? fromMinorUnits(minor, cur) : null);

  let consumedMinutes = 0; let consumedMinor = 0;
  let heldMinutes = 0; let heldMinor = 0; let heldCount = 0; let unpriced = 0;
  const heldByRequest = new Map<string, number>();
  for (const e of input.entries) {
    if (!e.endedAt) continue;
    const minutes = billedMinutes(e);
    const amount = cur ? entryAmountMinor({ minutes, hourlyRate: e.hourlyRate, currencyCode: e.currencyCode }, cur) : null;
    if (e.billingStatus === 'awaiting_approval') {
      heldMinutes += minutes; heldCount += 1;
      if (amount == null) unpriced += 1; else heldMinor += amount;
      if (e.approvalRequestId) heldByRequest.set(e.approvalRequestId, (heldByRequest.get(e.approvalRequestId) ?? 0) + 1);
      continue;
    }
    if (e.isBillable && e.coverage === 'billable' && CONSUMED_STATUSES.has(e.billingStatus)) {
      consumedMinutes += minutes;
      consumedMinor += amount ?? 0;
    }
  }

  const ext = approvedExtensionsOf(input.requests, cur);
  const budgetMinor = ticket.budgetAmount != null && cur ? toMinorUnits(ticket.budgetAmount, cur) : null;

  const requests = [...input.requests]
    .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || b.id.localeCompare(a.id))
    .map(({ ipAddress: _ip, userAgent: _ua, createdAt: _c, updatedAt: _u, ...r }): TicketApprovalRequestView => ({
      ...r,
      heldEntryCount: heldByRequest.get(r.id) ?? 0,
      requestedByUserName: r.requestedByUserId ? input.userNames.get(r.requestedByUserId) ?? null : null,
      decidedByUserName: r.decidedByUserId ? input.userNames.get(r.decidedByUserId) ?? null : null,
    }));

  return {
    policy: input.policy,
    budget: { minutes: ticket.budgetMinutes, amount: ticket.budgetAmount, currency: cur },
    consumed: { minutes: consumedMinutes, amount: money(consumedMinor) },
    held: { minutes: heldMinutes, amount: money(heldMinor), entryCount: heldCount, unpricedEntryCount: unpriced },
    approvedExtensions: { minutes: ext.minutes, amount: money(ext.amountMinor) },
    ceiling: {
      minutes: ticket.budgetMinutes != null ? ticket.budgetMinutes + ext.minutes : null,
      amount: budgetMinor != null ? money(budgetMinor + ext.amountMinor) : null,
    },
    requests,
  };
}

/** Loads and builds the summary. The caller has already authorized the ticket. */
export async function getTicketApprovalSummary(
  db: Tx, args: { ticketId: string; partnerId: string; orgId: string },
): Promise<TicketApprovalSummary> {
  const [ticket] = await db.select({
    budgetMinutes: tickets.budgetMinutes, budgetAmount: tickets.budgetAmount, budgetCurrencyCode: tickets.budgetCurrencyCode,
  }).from(tickets).where(eq(tickets.id, args.ticketId)).limit(1);
  const policy = await resolveTicketApprovalSettings(db, { partnerId: args.partnerId, orgId: args.orgId });
  const requests = await db.select().from(ticketApprovalRequests)
    .where(and(eq(ticketApprovalRequests.ticketId, args.ticketId), eq(ticketApprovalRequests.orgId, args.orgId)));
  const entries = await db.select({
    id: timeEntries.id, approvalRequestId: timeEntries.approvalRequestId, billingStatus: timeEntries.billingStatus,
    isBillable: timeEntries.isBillable, coverage: timeEntries.coverage, endedAt: timeEntries.endedAt,
    billableMinutes: timeEntries.billableMinutes, durationMinutes: timeEntries.durationMinutes,
    hourlyRate: timeEntries.hourlyRate, currencyCode: timeEntries.currencyCode,
  }).from(timeEntries).where(eq(timeEntries.ticketId, args.ticketId));
  const userIds = [...new Set(requests.flatMap((r) => [r.requestedByUserId, r.decidedByUserId]).filter((v): v is string => !!v))];
  const names = userIds.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
    : [];
  return buildTicketApprovalSummary({
    policy,
    ticket: ticket ?? { budgetMinutes: null, budgetAmount: null, budgetCurrencyCode: null },
    requests,
    entries,
    userNames: new Map(names.map((u) => [u.id, u.name])),
  });
}
