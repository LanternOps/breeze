/**
 * The per-partner AI model registry lock (W03 cutover, W04 writes, W08 #7606).
 *
 * One transaction-scoped advisory lock per partner serialises every registry
 * writer: the bootstrap (registryCutover.ts), the compat connection writes, the
 * W06 env bootstrap and W04's /ai/models writes. W03/W06/W08 writers BLOCK on
 * it; W04 writes TRY it and answer 503 registry_busy, because a W04 write
 * already holds the request connection and blocking there could park pooled
 * connections behind a holder that needs another one.
 *
 * The key text predates W08 (`ai_model_registry_reconcile:<partnerId>`) and is
 * kept so processes of two releases serialise on the same lock during a deploy.
 */
import { sql } from 'drizzle-orm';
import { db, getCurrentDbAccessContext } from '../../db';

export function partnerRegistryLockKey(partnerId: string): string {
  return `ai_model_registry_reconcile:${partnerId}`;
}

/**
 * Blocking; releases at commit/rollback. The caller must hold a system DB
 * context. Re-entrant within the session (pg_advisory_xact_lock), so a writer
 * that already holds it may take it again in the same transaction.
 */
export async function lockPartnerRegistry(partnerId: string): Promise<void> {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('lockPartnerRegistry requires a held system DB context');
  }
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${partnerRegistryLockKey(partnerId)}, 0))`);
}

/** Must run inside the write's system transaction; the lock releases at commit/rollback. */
export async function tryLockPartnerRegistryWrite(partnerId: string): Promise<boolean> {
  const [row] = await db.execute<{ acquired: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${partnerRegistryLockKey(partnerId)}, 0)) AS acquired`,
  );
  return row?.acquired === true;
}
