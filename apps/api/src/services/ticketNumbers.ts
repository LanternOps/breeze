import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';

export function formatInternalNumber(year: number, counter: number): string {
  return `T-${year}-${String(counter).padStart(4, '0')}`;
}

// Race-safe per-partner allocation: a single upsert with RETURNING means two
// concurrent creates can never get the same counter.
export async function allocateInternalTicketNumber(partnerId: string, now: Date = new Date()): Promise<string> {
  const year = now.getFullYear();
  // Allocation must run in a system-scope DB context for three reasons:
  //   1. RLS. org-scoped request contexts have empty accessiblePartnerIds, so
  //      the `partner_ticket_sequences` policy (partner-axis) would reject the
  //      upsert with a row-level security violation.
  //   2. Tx isolation. Running outside the caller's request transaction means a
  //      failed ticket insert leaves a counter gap (harmless — gaps in ticket
  //      numbers are acceptable) rather than aborting the caller's whole tx.
  //   3. Lock scope. The per-partner row lock acquired by the upsert is held
  //      only for the short system transaction wrapping this statement, not the
  //      caller's request transaction, reducing contention under concurrent creates.
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.execute(sql`
        INSERT INTO partner_ticket_sequences (partner_id, year, counter)
        VALUES (${partnerId}, ${year}, 1)
        ON CONFLICT (partner_id, year)
        DO UPDATE SET counter = partner_ticket_sequences.counter + 1
        RETURNING counter
      `)
    )
  );
  const counter = Number((rows as unknown as Array<{ counter: number }>)[0]?.counter);
  if (!Number.isFinite(counter) || counter < 1) {
    throw new Error('Failed to allocate ticket number');
  }
  return formatInternalNumber(year, counter);
}
