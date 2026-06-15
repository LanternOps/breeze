import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { InvoiceServiceError } from './invoiceTypes';

export function formatInvoiceNumber(prefix: string, year: number, counter: number): string {
  return `${prefix}-${year}-${String(counter).padStart(4, '0')}`;
}

/**
 * Allocate the next partner-scoped invoice counter for `year`. Race-safe via
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING — two concurrent issues can
 * never read the same counter. Mirrors `allocateInternalTicketNumber`: runs in
 * a system-scope context outside the caller's request transaction because
 * `partner_invoice_sequences` is partner-axis (an org-scoped request context
 * can't satisfy its RLS policy) and a gap from a failed standalone allocation is
 * harmless.
 *
 * NOTE: `issueInvoice` does NOT call this helper; to keep counter allocation
 * atomic with the invoice-number write and source-row flip it inlines the same
 * upsert inside its single system transaction (calling this here would
 * `runOutsideDbContext`-exit that transaction and open a separate one). This
 * export exists for standalone allocation paths and its own coverage.
 */
export async function allocateInvoiceCounter(partnerId: string, year: number): Promise<number> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO partner_invoice_sequences (partner_id, year, counter)
        VALUES (${partnerId}, ${year}, 1)
        ON CONFLICT (partner_id, year)
        DO UPDATE SET counter = partner_invoice_sequences.counter + 1
        RETURNING counter
      `)
    )
  );
  const counter = Number((rows as unknown as Array<{ counter: number }>)[0]?.counter);
  if (!Number.isFinite(counter) || counter < 1) throw new InvoiceServiceError('Failed to allocate invoice number', 500, 'NUMBER_ALLOCATION_FAILED');
  return counter;
}
