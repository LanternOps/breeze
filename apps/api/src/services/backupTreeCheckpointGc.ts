// #11736 step 2: delete file-index checkpoints no snapshot uses any more (D8).
//
// A snapshot pins its checkpoint through backup_snapshots_file_index_checkpoint_fk
// (ON DELETE RESTRICT), so there is no reference count. A header is collected
// when no snapshot references it and either a newer header of its lineage
// exists, or it has not been referenced for CHECKPOINT_ORPHAN_TTL_MS (a dead
// lineage: a replaced config, a retired device). The newest unreferenced header
// of a live lineage is otherwise kept, so a lineage whose snapshots all retired
// can still diff against it. Its entries go with it (ON DELETE CASCADE).
//
// A header whose device left its org, or was deleted, needs no rule here: the
// database deletes it (the devices move trigger and the composite device FK,
// migration 2027-01-31-120000-backup-tree-checkpoints.sql).
//
// Run by the snapshot cleanup worker, whatever BACKUP_INDEX_DELTA_PUBLISH says:
// checkpoints written while it was on still have to be collected after it is
// turned off.
import { sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { tightenStatementTimeout } from '../db/lockTimeout';
import { isPgForeignKeyViolation, pgErrorCode } from '../utils/pgErrors';
import { captureException } from './sentry';

/** How long an unreferenced newest header of a lineage is kept. */
export const CHECKPOINT_ORPHAN_TTL_MS = 7 * 24 * 3600 * 1000;

/** Headers one run tries at most. Each is one statement plus its entries' cascade. */
export const CHECKPOINT_GC_MAX_HEADERS = 100;

/**
 * The longest one header delete may run, cascade included. A million-entry
 * cascade took under half a second on a warm local Postgres 16; this leaves
 * two orders of magnitude for a cold cache and a busy disk, and stops one
 * huge cascade from holding the cleanup worker. Never longer than what is
 * left of the run's time budget.
 */
export const CHECKPOINT_GC_DELETE_TIMEOUT_MS = 60_000;

export type CheckpointGcResult = {
  deleted: number;
  /** Refused by the snapshot pointer FK: a snapshot pins the header again. */
  refused: number;
  /** The delete passed CHECKPOINT_GC_DELETE_TIMEOUT_MS. */
  timedOut: number;
  /** Any other error. Logged and reported to Sentry with the header's id. */
  failed: number;
};

/** The only foreign key that may refuse a header delete: a snapshot still pins it (R4). */
const SNAPSHOT_POINTER_FK = 'backup_snapshots_file_index_checkpoint_fk';

/** statement_timeout (and any other cancel) raises query_canceled. */
const QUERY_CANCELED = '57014';

/**
 * D8: no snapshot references the header, and either it has not been
 * referenced since `cutoff` or a newer header of its lineage exists.
 */
function collectable(cutoff: Date): SQL {
  return sql`NOT EXISTS (
                SELECT 1 FROM backup_snapshots s WHERE s.file_index_checkpoint_id = c.id
              )
          AND (
                c.last_referenced_at < ${cutoff.toISOString()}::timestamptz
                OR EXISTS (
                  SELECT 1 FROM backup_tree_checkpoints n
                   WHERE n.org_id = c.org_id
                     AND n.device_id = c.device_id
                     AND n.config_id = c.config_id
                     AND n.storage_identity = c.storage_identity
                     AND n.backup_type = c.backup_type
                     AND n.key_layout = c.key_layout
                     AND n.key_prefix IS NOT DISTINCT FROM c.key_prefix
                     -- The publisher's "newest" order (backupSnapshotIndexPublish.ts).
                     AND (n.created_at, n.id) > (c.created_at, c.id)
                )
              )`;
}

/**
 * The run's candidates, oldest first, chosen once: one scan of the headers per
 * run, not one per header. No index serves the order, and none is needed at
 * that rate. Not locked: each is re-checked under its row lock before delete.
 */
async function selectCandidates(cutoff: Date, limit: number): Promise<string[]> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        const rows = (await tx.execute(sql`
          SELECT c.id FROM backup_tree_checkpoints c
           WHERE ${collectable(cutoff)}
           ORDER BY c.created_at, c.id
           LIMIT ${limit}
        `)) as unknown as Array<{ id: string }>;
        return rows.map((r) => r.id);
      }),
    ),
  );
}

/**
 * Deletes one candidate in its own system transaction, if it is still
 * collectable: true when deleted. The row lock is held from the re-check to
 * the delete, so no reference can commit in between. A publisher holds FOR
 * KEY SHARE on the header it diffs against until it commits its reference,
 * and SKIP LOCKED passes over it.
 */
async function deleteCandidate(id: string, cutoff: Date, timeoutMs: number): Promise<boolean> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        const locked = (await tx.execute(sql`
          SELECT c.id FROM backup_tree_checkpoints c
           WHERE c.id = ${id}::uuid
             AND ${collectable(cutoff)}
           FOR UPDATE OF c SKIP LOCKED
        `)) as unknown as Array<{ id: string }>;
        if (locked.length === 0) return false;
        // Local to this transaction, which ends with the delete.
        await tightenStatementTimeout(tx, timeoutMs);
        await tx.execute(sql`DELETE FROM backup_tree_checkpoints WHERE id = ${id}::uuid`);
        return true;
      }),
    ),
  );
}

/**
 * Collects unreferenced checkpoints: up to `maxHeaders` candidates, chosen
 * once, each tried once, until `deadlineMs` (wall clock). `now` sets the TTL
 * cutoff.
 *
 * One header never stops the run. A refusal by the snapshot pointer FK is
 * defensive (a writer that set a pointer without the publisher's lock): it is
 * counted as `refused` and logged. A delete past its statement timeout is
 * counted as `timedOut` and logged. Any other error is counted as `failed`,
 * logged and reported with the header's id. Each is then passed over until the
 * next run, which tries again. Only a failure to select the candidates is
 * thrown.
 */
export async function collectUnreferencedCheckpoints(opts: {
  deadlineMs: number;
  now?: Date;
  maxHeaders?: number;
  /** One header delete's statement timeout; CHECKPOINT_GC_DELETE_TIMEOUT_MS unless a test sets it. */
  deleteTimeoutMs?: number;
}): Promise<CheckpointGcResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - CHECKPOINT_ORPHAN_TTL_MS);
  const maxHeaders = opts.maxHeaders ?? CHECKPOINT_GC_MAX_HEADERS;
  const deleteTimeoutMs = opts.deleteTimeoutMs ?? CHECKPOINT_GC_DELETE_TIMEOUT_MS;
  const result: CheckpointGcResult = { deleted: 0, refused: 0, timedOut: 0, failed: 0 };
  if (Date.now() >= opts.deadlineMs) return result;

  for (const id of await selectCandidates(cutoff, maxHeaders)) {
    const remainingMs = opts.deadlineMs - Date.now();
    if (remainingMs <= 0) break;
    // Each catch is outside the header's transaction: a failed statement has
    // aborted it, and it has rolled back by the time this sees the error.
    try {
      if (await deleteCandidate(id, cutoff, Math.min(deleteTimeoutMs, remainingMs))) {
        result.deleted += 1;
      }
    } catch (err) {
      if (isPgForeignKeyViolation(err, SNAPSHOT_POINTER_FK)) {
        // A snapshot gained a reference after the re-check, without the
        // publisher's lock. Expected to be rare: logged, so a header that keeps
        // being refused is visible.
        console.warn(
          `[BackupTreeCheckpointGc] Checkpoint ${id} is still referenced by a snapshot (${SNAPSHOT_POINTER_FK}); skipped for this run`,
        );
        result.refused += 1;
      } else if (pgErrorCode(err) === QUERY_CANCELED) {
        console.warn(
          `[BackupTreeCheckpointGc] Deleting checkpoint ${id} passed its statement timeout; skipped for this run`,
        );
        result.timedOut += 1;
      } else {
        console.error(`[BackupTreeCheckpointGc] Deleting checkpoint ${id} failed; skipped for this run:`, err);
        captureException(err instanceof Error ? err : new Error(String(err)), undefined, { checkpointId: id });
        result.failed += 1;
      }
    }
  }
  return result;
}
