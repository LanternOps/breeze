/**
 * Block hours (#8181, Open Decision 11 A): time drawn by a block of prepaid
 * hours is pinned to the block's org by the composite
 * (contract_line_id, org_id) → contract_lines(id, org_id) FK. A ticket or device
 * org move would rewrite the entry's org_id and fail that FK at commit (23503);
 * detaching the line instead would leave a 'contract' entry with no line —
 * editable and billable again in the target org. Both movers refuse with a 409
 * that names the count. Already-paid-for hours never change org.
 *
 * Call INSIDE the mover's transaction, after its `UPDATE tickets` and BEFORE
 * assertTicketMoveCurrencyCompatible — same lock order (tickets → time_entries,
 * ORDER BY id). It locks EVERY time entry of the moving tickets: if a block
 * close holds them, the move waits and then sees contract_line_id (clean 409);
 * if the move holds them first, the close's FOR UPDATE re-evaluates
 * `org_id = <old org>` after the move commits (READ COMMITTED) and drops the
 * moved rows. Either way a clean outcome, never a 23503 at commit. The currency
 * guard then re-locks a subset of the same rows — a no-op for locks held.
 */
import { inArray } from 'drizzle-orm';
import type { db } from '../db';
import { timeEntries } from '../db/schema';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 409 carrier shared by ticket and device moves (own class, like TicketMoveCurrencyBlockedError). */
export class TicketMoveHourBlockError extends Error {
  readonly status = 409 as const;
  readonly code = 'HOUR_BLOCK_DRAWN_TIME' as const;
  constructor(public details: { drawnTimeEntries: number }) {
    super(`${details.drawnTimeEntries} time ${details.drawnTimeEntries === 1 ? 'entry was' : 'entries were'} ` +
      'drawn from a block of prepaid hours and cannot move to another organization');
    this.name = 'TicketMoveHourBlockError';
  }
}

export async function assertNoHourBlockDrawnTime(tx: Tx, input: { ticketIds: string[] }): Promise<void> {
  if (input.ticketIds.length === 0) return;
  const rows = await tx.select({ id: timeEntries.id, contractLineId: timeEntries.contractLineId })
    .from(timeEntries).where(inArray(timeEntries.ticketId, input.ticketIds))
    .orderBy(timeEntries.id).for('update');
  const drawn = rows.filter((r) => r.contractLineId !== null).length;
  if (drawn > 0) throw new TicketMoveHourBlockError({ drawnTimeEntries: drawn });
}
