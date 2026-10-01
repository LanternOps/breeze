/**
 * Non-blocking per-partner lock for W04 /ai/models registry writes (#7602).
 *
 * Same key as W03's lockPartnerRegistryReconcile (cutover, compatRemap and the
 * /ai/provider facade), so a W04 write still serialises with them. It TRIES
 * instead of waiting: a W04 write holds the request connection plus this
 * system connection, and blocking here would park pooled connections behind
 * a holder that may itself need another one (pool starvation). A busy partner
 * gets a 503 registry_busy and retries; W03's own writers keep the blocking lock.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { partnerRegistryReconcileLockKey } from './legacyReconcile';

/** Must run inside the write's system transaction; the lock releases at commit/rollback. */
export async function tryLockPartnerRegistryWrite(partnerId: string): Promise<boolean> {
  const [row] = await db.execute<{ acquired: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${partnerRegistryReconcileLockKey(partnerId)}, 0)) AS acquired`,
  );
  return row?.acquired === true;
}
