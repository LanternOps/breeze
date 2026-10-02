import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  holdsUnsealedBackupProviderSecret,
  sealStoredBackupProviderConfig,
} from './backupProviderConfigSealing';

/**
 * Seal destination credentials in `backup_configs.provider_config` rows stored
 * before the column sealed them on write.
 *
 * Runs detached at API boot (src/index.ts), like the settings-secret sweep
 * (settingsSecretBackfill.ts), and is idempotent: a row is written only while
 * it still holds a plaintext credential, so once every row is sealed a boot
 * costs one scan of a small table and writes nothing.
 *
 * This file reads and writes the STORED form on purpose (raw SQL, not the
 * sealing column type), so it can tell sealed from unsealed values.
 *
 * Safety:
 *   - Each write is a compare-and-set on the exact stored value it read, so a
 *     destination saved concurrently is never overwritten; the row is re-read
 *     and retried instead.
 *   - Only `provider_config` changes. `updated_at` and `approval_generation`
 *     are left alone: the destination is the same, so nothing queued against
 *     it is invalidated.
 *   - Each read and write is its own short system-scope transaction.
 *   - Only ids and counts are logged, never values.
 * Readers open both forms, so the API works while the sweep runs.
 */

export interface BackupProviderConfigBackfillStats {
  /** Rows that still held a plaintext credential when the sweep reached them. */
  scanned: number;
  /** Rows whose plaintext credentials were replaced by ciphertext. */
  sealed: number;
  /** Rows changed by concurrent saves on every attempt; left for the next run. */
  contended: number;
  /** Rows that could not be sealed (error logged, row untouched). */
  failed: number;
}

export interface BackupProviderConfigBackfillOptions {
  batchSize?: number;
  maxAttempts?: number;
  logger?: Pick<Console, 'error'>;
  /**
   * Test seam: runs between reading a row and the compare-and-set write, so a
   * test can land a concurrent save in exactly that window.
   */
  beforeWrite?: (id: string) => Promise<void>;
}

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_ATTEMPTS = 3;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function rowsFromResult(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

function storedValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function inSystemScope<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

async function readStored(id: string): Promise<{ found: boolean; value: unknown }> {
  const rows = rowsFromResult(await inSystemScope(() => db.execute(sql`
    SELECT provider_config AS value FROM backup_configs WHERE id = ${id}::uuid
  `)));
  return rows[0] ? { found: true, value: storedValue(rows[0].value) } : { found: false, value: null };
}

type RowOutcome = 'sealed' | 'contended' | 'clean';

async function sealRow(id: string, firstRead: unknown, options: ResolvedOptions): Promise<RowOutcome> {
  let current = firstRead;
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    if (attempt > 0) {
      const reread = await readStored(id);
      if (!reread.found) return 'clean';
      current = reread.value;
    }
    if (!holdsUnsealedBackupProviderSecret(current)) return 'clean';

    const sealed = sealStoredBackupProviderConfig(current);
    if (holdsUnsealedBackupProviderSecret(sealed)) {
      throw new Error('sealing left a plaintext credential');
    }

    await options.beforeWrite?.(id);
    const updated = rowsFromResult(await inSystemScope(() => db.execute(sql`
      UPDATE backup_configs
      SET provider_config = ${JSON.stringify(sealed)}::jsonb
      WHERE id = ${id}::uuid AND provider_config = ${JSON.stringify(current)}::jsonb
      RETURNING id
    `)));
    if (updated.length > 0) return 'sealed';
  }
  return 'contended';
}

type ResolvedOptions = Required<Omit<BackupProviderConfigBackfillOptions, 'beforeWrite'>>
  & Pick<BackupProviderConfigBackfillOptions, 'beforeWrite'>;

export async function sealUnsealedBackupProviderConfigs(
  options: BackupProviderConfigBackfillOptions = {},
): Promise<BackupProviderConfigBackfillStats> {
  const resolved: ResolvedOptions = {
    batchSize: Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 1000)),
    maxAttempts: Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    logger: options.logger ?? console,
    beforeWrite: options.beforeWrite,
  };
  const stats: BackupProviderConfigBackfillStats = { scanned: 0, sealed: 0, contended: 0, failed: 0 };
  let lastId = NIL_UUID;

  while (true) {
    const batch = rowsFromResult(await inSystemScope(() => db.execute(sql`
      SELECT id::text AS id, provider_config AS value
      FROM backup_configs
      WHERE id > ${lastId}::uuid
      ORDER BY id
      LIMIT ${resolved.batchSize}
    `)));
    if (batch.length === 0) break;

    for (const row of batch) {
      const id = String(row.id);
      lastId = id;
      const value = storedValue(row.value);
      if (!holdsUnsealedBackupProviderSecret(value)) continue;
      stats.scanned += 1;
      try {
        const outcome = await sealRow(id, value, resolved);
        if (outcome === 'sealed') stats.sealed += 1;
        else if (outcome === 'contended') stats.contended += 1;
      } catch (err) {
        stats.failed += 1;
        resolved.logger.error(
          `[backup-provider-config] could not seal backup_configs row ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return stats;
}
