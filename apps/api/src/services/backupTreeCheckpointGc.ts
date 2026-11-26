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
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { isPgForeignKeyViolation } from '../utils/pgErrors';

/** How long an unreferenced newest header of a lineage is kept. */
export const CHECKPOINT_ORPHAN_TTL_MS = 7 * 24 * 3600 * 1000;

/** Headers one run deletes at most. Each is one statement plus its entries' cascade. */
export const CHECKPOINT_GC_MAX_HEADERS = 100;

export type CheckpointGcResult = { deleted: number; refused: number };

/** The only foreign key that may refuse a header delete: a snapshot still pins it (R4). */
const SNAPSHOT_POINTER_FK = 'backup_snapshots_file_index_checkpoint_fk';

/**
 * Deletes one collectable header in its own system transaction, returning its
 * id, or null when none is left. The row lock is held from selection to
 * delete, so no reference can commit in between. A publisher holds FOR KEY
 * SHARE on the header it diffs against until it commits its reference, and
 * SKIP LOCKED passes over it.
 */
async function deleteOneCandidate(cutoff: Date, skip: string[], attempted: { id: string | null }): Promise<string | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        const rows = (await tx.execute(sql`
          SELECT c.id FROM backup_tree_checkpoints c
           WHERE NOT EXISTS (
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
                 )
             ${skip.length > 0 ? sql`AND c.id NOT IN (${sql.join(skip.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
           ORDER BY c.created_at, c.id
           LIMIT 1
           FOR UPDATE OF c SKIP LOCKED
        `)) as unknown as Array<{ id: string }>;
        const id = rows[0]?.id ?? null;
        if (!id) return null;
        attempted.id = id;
        await tx.execute(sql`DELETE FROM backup_tree_checkpoints WHERE id = ${id}::uuid`);
        return id;
      }),
    ),
  );
}

/**
 * Collects unreferenced checkpoints until none is left, `maxHeaders` have been
 * tried, or `deadlineMs` (wall clock) has passed. `now` sets the TTL cutoff.
 *
 * A foreign-key refusal is defensive: a writer that set a pointer without the
 * publisher's lock either is refused itself or makes this delete fail. It is
 * counted as `refused`, that header is skipped for the rest of the run, and
 * the sweep continues. Any other error is thrown.
 */
export async function collectUnreferencedCheckpoints(opts: {
  deadlineMs: number;
  now?: Date;
  maxHeaders?: number;
}): Promise<CheckpointGcResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - CHECKPOINT_ORPHAN_TTL_MS);
  const maxHeaders = opts.maxHeaders ?? CHECKPOINT_GC_MAX_HEADERS;
  const skip: string[] = [];
  let deleted = 0;
  let refused = 0;

  while (deleted + refused < maxHeaders && Date.now() < opts.deadlineMs) {
    // The catch is outside the transaction: the refused statement has
    // aborted it, and it has rolled back by the time this sees the error.
    const attempted: { id: string | null } = { id: null };
    try {
      const id = await deleteOneCandidate(cutoff, skip, attempted);
      if (!id) break;
      deleted += 1;
    } catch (err) {
      if (!isPgForeignKeyViolation(err, SNAPSHOT_POINTER_FK) || !attempted.id) throw err;
      // A snapshot gained a reference after the candidate was selected,
      // without the publisher's lock. Expected to be rare: logged, so a header
      // that keeps being refused is visible.
      console.warn(
        `[BackupTreeCheckpointGc] Checkpoint ${attempted.id} is still referenced by a snapshot (${SNAPSHOT_POINTER_FK}); skipped for this run`,
      );
      refused += 1;
      skip.push(attempted.id);
    }
  }
  return { deleted, refused };
}
