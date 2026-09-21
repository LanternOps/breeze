/**
 * Advisory locks for caller verification.
 *
 * Lock order (spec D14): identity namespace (`caller-identity:<org>`), then
 * contact locks (`caller-contact:<org>:<contact>`), then binding locks
 * (deduplicated, sorted ascending by UUID). Gate, rejection, rebinding and
 * W05 dispatch all share `withSubjectLocks`; callers re-read mutable state
 * after acquiring locks. All locks are transaction-scoped (`_xact_`).
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db';

export type Tx = Pick<typeof db, 'execute'>;

export async function withSubjectLocks<T>(tx: Tx, bindingIds: Array<string | null | undefined>, fn: () => Promise<T>): Promise<T> {
  const ids = [...new Set(bindingIds.filter((id): id is string => typeof id === 'string' && id.length > 0))].sort();
  for (const id of ids) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
  }
  return fn();
}

export async function lockContact(orgId: string, contactId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-contact:${orgId}:${contactId}`}))`);
}

export async function lockIdentityNamespace(orgId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${orgId}`}))`);
}
