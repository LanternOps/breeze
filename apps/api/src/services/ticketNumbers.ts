import { sql } from 'drizzle-orm';
import { db } from '../db';

export function formatInternalNumber(year: number, counter: number): string {
  return `T-${year}-${String(counter).padStart(4, '0')}`;
}

// Race-safe per-partner allocation: a single upsert with RETURNING means two
// concurrent creates can never get the same counter.
export async function allocateInternalTicketNumber(partnerId: string, now: Date = new Date()): Promise<string> {
  const year = now.getFullYear();
  const rows = await db.execute(sql`
    INSERT INTO partner_ticket_sequences (partner_id, year, counter)
    VALUES (${partnerId}, ${year}, 1)
    ON CONFLICT (partner_id, year)
    DO UPDATE SET counter = partner_ticket_sequences.counter + 1
    RETURNING counter
  `);
  const counter = Number((rows as unknown as Array<{ counter: number }>)[0]?.counter);
  if (!Number.isFinite(counter) || counter < 1) {
    throw new Error('Failed to allocate ticket number');
  }
  return formatInternalNumber(year, counter);
}
