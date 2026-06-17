import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { QuoteServiceError } from './quoteTypes';

export function formatQuoteNumber(prefix: string, year: number, counter: number): string {
  return `${prefix}-${year}-${String(counter).padStart(4, '0')}`;
}

/**
 * Allocate the next partner-scoped quote counter for `year`, gaplessly. Race-safe
 * via INSERT ... ON CONFLICT DO UPDATE ... RETURNING — two concurrent sends can
 * never read the same counter. Mirrors `allocateInvoiceCounter`: runs in a
 * system-scope context outside the caller's request transaction because
 * `partner_quote_sequences` is partner-axis (an org-scoped request context can't
 * satisfy its RLS policy), and a gap from a failed standalone allocation is
 * harmless. Self-wraps in `runOutsideDbContext → withSystemDbAccessContext`, so
 * it is safe to call standalone.
 */
export async function allocateQuoteCounter(partnerId: string, year: number): Promise<number> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO partner_quote_sequences (partner_id, year, counter)
        VALUES (${partnerId}, ${year}, 1)
        ON CONFLICT (partner_id, year)
        DO UPDATE SET counter = partner_quote_sequences.counter + 1
        RETURNING counter
      `)
    )
  );
  const counter = Number((rows as unknown as Array<{ counter: number }>)[0]?.counter);
  if (!Number.isFinite(counter) || counter < 1) throw new QuoteServiceError('Failed to allocate quote number', 500, 'INVALID_STATE');
  return counter;
}
