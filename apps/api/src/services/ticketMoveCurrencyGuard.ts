/**
 * Shared locked currency guard for ticket org-moves (multi-currency wave 4,
 * #3776). Used by BOTH movers that rewrite `time_entries` / `ticket_parts`
 * `org_id` through a ticket:
 *   - `moveTicketOrg` (services/ticketService.ts)
 *   - the device org-move (routes/devices/moveOrg.ts — tickets bound to the
 *     moved device travel with it)
 *
 * Snapshots rule: `currency_code` on entries/parts is written once and never
 * restamped. A move into an org that bills in a different currency therefore
 * strands every unbilled monetary row in the OLD currency under the NEW org.
 * That is allowed only when the caller explicitly accepts it
 * (`acceptCurrencyMismatch: true`, gated on `invoices:write` at the route);
 * otherwise the move is blocked with a 409 and nothing moves.
 *
 * Global lock order: tickets → time_entries → ticket_parts. Call this INSIDE
 * the mover's transaction, AFTER its `UPDATE tickets` (which holds the ticket
 * row lock) and BEFORE the child `org_id` rewrites. `issueInvoice` never locks
 * `tickets` (wave-2 order invoices → invoice_lines → contracts →
 * contract_lines → time_entries → ticket_parts), so no cycle is possible.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { db } from '../db';
import { timeEntries, ticketParts } from '../db/schema';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface MoveCurrencyGuardDetails {
  sourceCurrency: string;
  targetCurrency: string;
  unbilledTimeEntries: number;
  unbilledParts: number;
  accepted: boolean;
}

/**
 * 409 carrier shared by ticket and device moves. Own class — importing
 * TicketServiceError here would make ticketService ⇄ guard an import cycle.
 */
export class TicketMoveCurrencyBlockedError extends Error {
  readonly status = 409 as const;
  readonly code = 'TICKET_MOVE_CURRENCY_BLOCKED' as const;
  constructor(message: string, public details: MoveCurrencyGuardDetails) {
    super(message);
    this.name = 'TicketMoveCurrencyBlockedError';
  }
}

export interface MoveCurrencyGuardInput {
  ticketIds: string[];
  sourceCurrency: string;
  targetCurrency: string;
  targetOrgName: string;
  acceptCurrencyMismatch: boolean;
}

/**
 * Returns null when the currencies match (no locks taken, nothing to report),
 * otherwise the locked counts. Throws TicketMoveCurrencyBlockedError when
 * unbilled monetary rows exist and the caller did not accept the mismatch.
 *
 * Guards EVERY unbilled monetary snapshot regardless of current billability —
 * `isBillable` can be flipped later (updateTimeEntrySchema), and a row that
 * moved while non-billable would otherwise surface as an old-currency amount
 * under the new org. Locked rows stay locked until the mover commits, so a
 * concurrent issueInvoice / edit of the same rows serializes behind the move.
 */
export async function assertTicketMoveCurrencyCompatible(
  tx: Tx,
  input: MoveCurrencyGuardInput
): Promise<MoveCurrencyGuardDetails | null> {
  if (input.sourceCurrency === input.targetCurrency || input.ticketIds.length === 0) return null;

  const lockedTime = await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(
      and(
        inArray(timeEntries.ticketId, input.ticketIds),
        eq(timeEntries.billingStatus, 'not_billed'),
        isNotNull(timeEntries.hourlyRate)
      )
    )
    .orderBy(timeEntries.id)
    .for('update');
  // unit_price is NOT NULL — every unbilled part is money.
  const lockedParts = await tx
    .select({ id: ticketParts.id })
    .from(ticketParts)
    .where(and(inArray(ticketParts.ticketId, input.ticketIds), eq(ticketParts.billingStatus, 'not_billed')))
    .orderBy(ticketParts.id)
    .for('update');

  const details: MoveCurrencyGuardDetails = {
    sourceCurrency: input.sourceCurrency,
    targetCurrency: input.targetCurrency,
    unbilledTimeEntries: lockedTime.length,
    unbilledParts: lockedParts.length,
    accepted: input.acceptCurrencyMismatch
  };
  if (lockedTime.length === 0 && lockedParts.length === 0) return details;
  // Snapshots keep sourceCurrency; rows stay locked until commit.
  if (input.acceptCurrencyMismatch) return details;
  throw new TicketMoveCurrencyBlockedError(
    `Cannot move: ${lockedTime.length} unbilled time entries and ${lockedParts.length} unbilled parts are in ` +
      `${input.sourceCurrency} but ${input.targetOrgName} bills in ${input.targetCurrency}. Invoice them first ` +
      `(or assemble a ${input.sourceCurrency} draft), or move anyway and accept that they stay in ` +
      `${input.sourceCurrency} and can only be invoiced on a ${input.sourceCurrency} draft.`,
    details
  );
}
