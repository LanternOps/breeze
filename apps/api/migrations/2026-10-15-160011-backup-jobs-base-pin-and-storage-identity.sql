-- apps/api/migrations/2026-10-15-160011-backup-jobs-base-pin-and-storage-identity.sql
-- D18 W01 (#5429 family, spec v3 §3.1/§3.6): server-chosen incremental-dedupe
-- base pin with a fixed publish-lease deadline, plus a per-job/per-snapshot
-- storage identity that survives a backup_configs destination edit.
--
-- publish_lease_expires_at is set for EVERY dispatched file/system_image job
-- (base or not) at DISPATCH time only — it is never renewed (no delivery
-- channel exists to renew it; see backupWorker.ts's stampDispatchPinAndIdentity
-- docstring). storage_identity on backup_snapshots is nullable FOREVER: no
-- follow-up NOT NULL migration exists for it, and this migration does NOT
-- backfill it — every existing row is left NULL. The W02 GC sweep self-heals
-- each NULL row by matching it (by row id) against a live bucket listing; no
-- SQL or TS backfill of any kind is required or attempted here.
--
-- DDL only — no UPDATE, no breeze.scope elevation needed. Idempotent:
-- IF NOT EXISTS on every column/index.

DO $$
BEGIN
  ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS base_snapshot_id varchar(255);
  ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS publish_lease_expires_at timestamptz;
  ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS storage_identity text;
  RAISE NOTICE 'backup_jobs: base_snapshot_id / publish_lease_expires_at / storage_identity ensured';
END $$;

CREATE INDEX IF NOT EXISTS backup_jobs_base_snapshot_id_idx
  ON backup_jobs (base_snapshot_id)
  WHERE base_snapshot_id IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE backup_snapshots ADD COLUMN IF NOT EXISTS storage_identity text;
  RAISE NOTICE 'backup_snapshots: storage_identity ensured (nullable, no NOT NULL, no backfill — every row starts NULL and is self-healed by the W02 GC sweep from a live bucket listing)';
END $$;
