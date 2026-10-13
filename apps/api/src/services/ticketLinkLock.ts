import { sql } from 'drizzle-orm';

type SqlExecutor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/**
 * The per-org `ticket_links` advisory lock (#7900 W02), held until the
 * OUTERMOST transaction ends (xact-scoped; request paths run as savepoints).
 *
 * - Link writers (add/remove, services/ticketLinkService.ts) take it
 *   EXCLUSIVE, before any row lock: under READ COMMITTED, locking only the two
 *   endpoint tickets does not stop two concurrent adds from jointly closing a
 *   cycle, breaking the duplicate_of depth rule, or overshooting the cap.
 * - Both org movers (moveTicketOrg, moveDeviceOrgInTransaction) take it
 *   SHARED for the SOURCE org, before any row lock. Movers never block each
 *   other, but a mover and a link writer of one org never interleave. Without
 *   this they lock ticket rows and link rows in opposite orders (a mover:
 *   ticket row(s), then the link row it deletes; a writer: link row, then each
 *   ticket row through the comment feed re-stamp trigger; the device cascade
 *   locks a device's tickets in its own scan order), which is a 40P01.
 *
 * Both sides acquire it FIRST, holding no row lock while they wait, so it
 * cannot itself close a wait cycle.
 */
export async function lockOrgTicketLinks(tx: SqlExecutor, orgId: string, mode: 'exclusive' | 'shared'): Promise<void> {
  const key = `ticket_links:${orgId}`;
  await tx.execute(mode === 'exclusive'
    ? sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
    : sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`);
}
