import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getEnrollmentKeyPepper } from './enrollmentKeyPepper';
import { hashBootstrapToken } from './installerBootstrapToken';

/**
 * Hash installer bootstrap tokens stored as plaintext before hashing shipped:
 * for each row with `token IS NOT NULL AND token_hash IS NULL`, write
 * `token_hash = hashBootstrapToken(token)` and clear `token`.
 *
 * Runs detached at API boot (src/index.ts), like the backup-destination
 * credential sweep (backupProviderConfigBackfill.ts). Idempotent: once no
 * legacy row is left, a boot costs one indexed-empty scan and writes nothing.
 *
 * Expired legacy rows are hashed too, not skipped. They are already refused at
 * redemption by `expires_at`, so hashing changes nothing about what they can
 * do — it only means no plaintext token is left on disk at all, and leaves the
 * `token_or_hash_present` CHECK satisfied without a special case.
 *
 * Safety:
 *   - Each write is a compare-and-set on the exact plaintext it read and on
 *     `token_hash IS NULL`, so a row changed in between is never overwritten
 *     (counted `contended`, left for the next boot).
 *   - Each read and write is its own short system-scope transaction.
 *   - Only ids and counts are logged, never token values.
 *   - The pepper is resolved BEFORE any database access: with no pepper the
 *     sweep rejects up front (the boot caller logs and reports it) instead of
 *     failing per row.
 * Redemption matches both forms (`routes/installer.ts`), so installers keep
 * working while the sweep runs.
 */

export interface InstallerBootstrapTokenHashBackfillStats {
  /** Legacy plaintext rows the sweep reached. */
  scanned: number;
  /** Rows whose plaintext was replaced by the keyed hash. */
  hashed: number;
  /** Rows changed concurrently between read and write; left for the next run. */
  contended: number;
  /** Rows that could not be hashed (error logged by id, row untouched). */
  failed: number;
}

export interface InstallerBootstrapTokenHashBackfillOptions {
  batchSize?: number;
  logger?: Pick<Console, 'error'>;
}

const DEFAULT_BATCH_SIZE = 200;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function rowsFromResult(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

function inSystemScope<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

export async function hashLegacyInstallerBootstrapTokens(
  options: InstallerBootstrapTokenHashBackfillOptions = {},
): Promise<InstallerBootstrapTokenHashBackfillStats> {
  // Throws when ENROLLMENT_KEY_PEPPER is missing outside tests — fail the
  // whole sweep loudly rather than every row quietly.
  getEnrollmentKeyPepper();

  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 1000));
  const logger = options.logger ?? console;
  const stats: InstallerBootstrapTokenHashBackfillStats = { scanned: 0, hashed: 0, contended: 0, failed: 0 };
  let lastId = NIL_UUID;

  while (true) {
    const batch = rowsFromResult(await inSystemScope(() => db.execute(sql`
      SELECT id::text AS id, token
      FROM installer_bootstrap_tokens
      WHERE token IS NOT NULL AND token_hash IS NULL AND id > ${lastId}::uuid
      ORDER BY id
      LIMIT ${batchSize}
    `)));
    if (batch.length === 0) break;

    for (const row of batch) {
      const id = String(row.id);
      const token = String(row.token);
      lastId = id;
      stats.scanned += 1;
      try {
        const updated = rowsFromResult(await inSystemScope(() => db.execute(sql`
          UPDATE installer_bootstrap_tokens
          SET token_hash = ${hashBootstrapToken(token)}, token = NULL
          WHERE id = ${id}::uuid AND token = ${token} AND token_hash IS NULL
          RETURNING id
        `)));
        if (updated.length > 0) stats.hashed += 1;
        else stats.contended += 1;
      } catch (err) {
        stats.failed += 1;
        logger.error(
          `[installer-bootstrap-token] could not hash installer_bootstrap_tokens row ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return stats;
}
