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

/** One group of unbilled monetary rows sharing an actual `currency_code`
 *  snapshot that differs from the target org's currency. */
export interface MoveCurrencyBlockedGroup {
  currencyCode: string;
  timeEntries: number;
  parts: number;
}

/** Defensive bucket for a null snapshot (impossible for ticket-linked rows
 *  while the DB CHECK holds). Mirrors invoiceAssembly's UNKNOWN_CURRENCY_KEY. */
export const UNKNOWN_MOVE_CURRENCY_KEY = 'UNKNOWN';

export interface MoveCurrencyGuardDetails {
  /** The source org's CURRENT currency — context only. Rows are grouped by
   *  their own snapshot (`blockedByCurrency`), never attributed to this. */
  sourceCurrency: string;
  targetCurrency: string;
  /** Totals across `blockedByCurrency` (rows whose snapshot ≠ target). Rows
   *  already snapshotted in the target currency are never counted. */
  unbilledTimeEntries: number;
  unbilledParts: number;
  /** Real per-snapshot groups, sorted by currency code. Empty when nothing blocks. */
  blockedByCurrency: MoveCurrencyBlockedGroup[];
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
    .select({ id: timeEntries.id, currencyCode: timeEntries.currencyCode })
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
    .select({ id: ticketParts.id, currencyCode: ticketParts.currencyCode })
    .from(ticketParts)
    .where(and(inArray(ticketParts.ticketId, input.ticketIds), eq(ticketParts.billingStatus, 'not_billed')))
    .orderBy(ticketParts.id)
    .for('update');

  // Group by each row's OWN snapshot. After an accepted USD→EUR move the
  // preserved rows are still USD; moving that ticket on to a USD org must not
  // block (they already match), and a mixed ticket must report its real groups
  // rather than attributing every row to the source org's current currency.
  const groups = new Map<string, MoveCurrencyBlockedGroup>();
  const bump = (currency: string | null, field: 'timeEntries' | 'parts') => {
    const code = currency ?? UNKNOWN_MOVE_CURRENCY_KEY;
    if (code === input.targetCurrency) return;
    const g = groups.get(code) ?? { currencyCode: code, timeEntries: 0, parts: 0 };
    g[field] += 1;
    groups.set(code, g);
  };
  for (const r of lockedTime) bump(r.currencyCode, 'timeEntries');
  for (const r of lockedParts) bump(r.currencyCode, 'parts');
  const blockedByCurrency = [...groups.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
  const unbilledTimeEntries = blockedByCurrency.reduce((n, g) => n + g.timeEntries, 0);
  const unbilledParts = blockedByCurrency.reduce((n, g) => n + g.parts, 0);

  const details: MoveCurrencyGuardDetails = {
    sourceCurrency: input.sourceCurrency,
    targetCurrency: input.targetCurrency,
    unbilledTimeEntries,
    unbilledParts,
    blockedByCurrency,
    accepted: input.acceptCurrencyMismatch
  };
  if (blockedByCurrency.length === 0) return details;
  // Snapshots keep their currency; rows stay locked until commit.
  if (input.acceptCurrencyMismatch) return details;
  const codes = blockedByCurrency.map((g) => g.currencyCode).join(', ');
  throw new TicketMoveCurrencyBlockedError(
    `Cannot move: ${unbilledTimeEntries} unbilled time entries and ${unbilledParts} unbilled parts are in ` +
      `${codes} but ${input.targetOrgName} bills in ${input.targetCurrency}. Invoice them first ` +
      `(or assemble a draft in that currency), or move anyway and accept that they stay in ` +
      `${codes} and can only be invoiced on a draft in that currency.`,
    details
  );
}
