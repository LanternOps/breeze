-- D17: backup_snapshots row deletion aborts on referencing history rows (#5384 family).
--
-- THE DEFECT. cleanupExpiredSnapshots (apps/api/src/jobs/backupRetention.ts)
-- hard-deletes an expired backup_snapshots row. Five FKs reference
-- backup_snapshots(id) with the default NO ACTION delete behavior:
--   restore_jobs.snapshot_id, recovery_tokens.snapshot_id,
--   backup_chains.full_snapshot_id, backup_verifications.snapshot_id,
--   backup_snapshots.parent_snapshot_id (self-FK).
-- Reproduced live against the lab DB: deleting a snapshot that had ever been
-- restored raised 23503 ("update or delete on table backup_snapshots violates
-- foreign key constraint restore_jobs_snapshot_id_backup_snapshots_id_fk...
-- Key is still referenced from table restore_jobs"). The BullMQ
-- cleanup-expired-snapshots job then failed as a whole, so no other expired
-- row in the run was processed and the mark-and-sweep object GC
-- (sweepUnreferencedBackupObjects, which runs after cleanup in the same job)
-- never ran. Any deployment where an expired snapshot was ever restored,
-- verified, or tokened stops reclaiming storage entirely.
--
-- THE FIX. These five rows are history/lineage records: a restore job,
-- recovery token, chain-continuity pointer, verification record, or an
-- incremental snapshot's parent pointer legitimately outlives the snapshot it
-- refers to once retention expires it. ON DELETE SET NULL lets the snapshot
-- row go while the history row survives with its pointer cleared, instead of
-- blocking the delete. This is data-preserving, not data-discarding: nothing
-- is removed here, only the dangling reference.
--
-- backup_verifications.snapshot_id, backup_chains.full_snapshot_id, and
-- backup_snapshots.parent_snapshot_id are already nullable columns, so only
-- the FK action changes for them. restore_jobs.snapshot_id and
-- recovery_tokens.snapshot_id are `NOT NULL` today and must have that
-- constraint dropped first, or SET NULL would itself raise 23502 the first
-- time it fires.
--
-- DDL only (no UPDATE/DELETE — existing rows already satisfy referential
-- integrity under the current NO ACTION constraints, so recreating the FK
-- with a wider ON DELETE action cannot fail against present data). No
-- breeze.scope elevation required. Idempotent: DROP CONSTRAINT IF EXISTS
-- followed by ADD CONSTRAINT is a no-op to re-apply — the second run drops
-- the identical constraint this migration just added and re-adds the same
-- definition. DROP NOT NULL is already idempotent (no-op if already nullable).

DO $$
BEGIN
  ALTER TABLE restore_jobs ALTER COLUMN snapshot_id DROP NOT NULL;

  ALTER TABLE restore_jobs
    DROP CONSTRAINT IF EXISTS restore_jobs_snapshot_id_backup_snapshots_id_fk;
  ALTER TABLE restore_jobs
    ADD CONSTRAINT restore_jobs_snapshot_id_backup_snapshots_id_fk
    FOREIGN KEY (snapshot_id) REFERENCES backup_snapshots(id) ON DELETE SET NULL;

  RAISE NOTICE 'restore_jobs_snapshot_id_backup_snapshots_id_fk: snapshot_id now nullable, FK now ON DELETE SET NULL';
END $$;

DO $$
BEGIN
  ALTER TABLE recovery_tokens ALTER COLUMN snapshot_id DROP NOT NULL;

  ALTER TABLE recovery_tokens
    DROP CONSTRAINT IF EXISTS recovery_tokens_snapshot_id_fkey;
  ALTER TABLE recovery_tokens
    ADD CONSTRAINT recovery_tokens_snapshot_id_fkey
    FOREIGN KEY (snapshot_id) REFERENCES backup_snapshots(id) ON DELETE SET NULL;

  RAISE NOTICE 'recovery_tokens_snapshot_id_fkey: snapshot_id now nullable, FK now ON DELETE SET NULL';
END $$;

DO $$
BEGIN
  ALTER TABLE backup_chains
    DROP CONSTRAINT IF EXISTS backup_chains_full_snapshot_id_fkey;
  ALTER TABLE backup_chains
    ADD CONSTRAINT backup_chains_full_snapshot_id_fkey
    FOREIGN KEY (full_snapshot_id) REFERENCES backup_snapshots(id) ON DELETE SET NULL;

  RAISE NOTICE 'backup_chains_full_snapshot_id_fkey: FK now ON DELETE SET NULL';
END $$;

DO $$
BEGIN
  ALTER TABLE backup_verifications
    DROP CONSTRAINT IF EXISTS backup_verifications_snapshot_id_backup_snapshots_id_fk;
  ALTER TABLE backup_verifications
    ADD CONSTRAINT backup_verifications_snapshot_id_backup_snapshots_id_fk
    FOREIGN KEY (snapshot_id) REFERENCES backup_snapshots(id) ON DELETE SET NULL;

  RAISE NOTICE 'backup_verifications_snapshot_id_backup_snapshots_id_fk: FK now ON DELETE SET NULL';
END $$;

DO $$
BEGIN
  ALTER TABLE backup_snapshots
    DROP CONSTRAINT IF EXISTS backup_snapshots_parent_snapshot_id_backup_snapshots_id_fk;
  ALTER TABLE backup_snapshots
    ADD CONSTRAINT backup_snapshots_parent_snapshot_id_backup_snapshots_id_fk
    FOREIGN KEY (parent_snapshot_id) REFERENCES backup_snapshots(id) ON DELETE SET NULL;

  RAISE NOTICE 'backup_snapshots_parent_snapshot_id_backup_snapshots_id_fk: FK now ON DELETE SET NULL';
END $$;
