import { eq } from 'drizzle-orm';
import { db, withDbTransaction } from '../db';
import { aiSessions } from '../db/schema';

/**
 * Set a chat session's auto-generated title from inside the request
 * transaction that just inserted the user's message (#7074).
 *
 * Callers treat a title failure as cosmetic: they catch, log and carry on. That
 * is only safe if the failure cannot reach the enclosing transaction. A plain
 * UPDATE that fails at the SQL level (deadlock, RLS denial, connection blip)
 * aborts the whole transaction, and postgres.js re-throws the swallowed error at
 * COMMIT, rolling back the user-message insert after the assistant's turn has
 * already started. `withDbTransaction` runs the UPDATE in a driver-owned
 * savepoint with the ambient `db` rebound to it, so a failure rolls back to the
 * savepoint and the outer transaction still commits.
 *
 * Must be called inside a DB access context (it throws otherwise).
 */
export async function persistAutoSessionTitle(sessionId: string, title: string): Promise<void> {
  await withDbTransaction(async () => {
    await db.update(aiSessions).set({ title }).where(eq(aiSessions.id, sessionId));
  });
}
