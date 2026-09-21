-- W09 (#6464) Task 2 — server-side file-index state on backup_snapshots, plus
-- a new backup_snapshot_origins table recording verified provenance for every
-- OLDER snapshot an incremental manifest references. See Part 0 §2/§3 and
-- docs/superpowers/plans/backup/_w09-part0.md for the full contract.
--
-- Idempotent throughout. No inner BEGIN/COMMIT — autoMigrate wraps each file
-- in one transaction. Row-writing (the backfill UPDATE below) elects system
-- scope first, same as 2026-10-24-210000-time-entries-billable-minutes.sql.
-- No per-table GRANT: ensureAppRole.ts grants breeze_app on every public
-- table (plus ALTER DEFAULT PRIVILEGES) at boot — backup_snapshot_files
-- itself carries no explicit GRANT either; mirror that, not an explicit one.

-- ============================================
-- 1. backup_snapshots: file-index state columns
-- ============================================
ALTER TABLE backup_snapshots
  ADD COLUMN IF NOT EXISTS file_index_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS file_index_manifest_sha256 text,
  ADD COLUMN IF NOT EXISTS file_index_hydrated_at timestamptz,
  ADD COLUMN IF NOT EXISTS file_index_external_count integer,
  ADD COLUMN IF NOT EXISTS file_index_error text;

DO $$ BEGIN
  ALTER TABLE backup_snapshots
    ADD CONSTRAINT backup_snapshots_file_index_status_chk
    CHECK (file_index_status IN ('none', 'agent', 'hydrating', 'complete', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN backup_snapshots.file_index_status IS
  'W09 (#6464): none = never assessed; agent = rows came from the (possibly truncated) agent-reported index, not proof of completeness; hydrating = server-side re-index in flight; complete = server verified against the stored manifest, safe to authorize external-reference downloads against; failed = hydration attempted and could not complete (see file_index_error).';

-- Backfill: every snapshot whose backup_snapshot_files rows came from the
-- agent-reported index (persistence's metadata.hasIndexedFiles=true, written
-- at backupResultPersistence.ts:1303) starts life at 'agent', never 'complete'
-- — the agent index is NOT proof of completeness (Part 0 §0 "the helper
-- replaces snapshot.files with [] when the result exceeds the 5MB delivery
-- budget"). Every other row stays 'none', its default.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE backup_snapshots
  SET file_index_status = 'agent'
  WHERE file_index_status = 'none'
    AND (metadata ->> 'hasIndexedFiles') = 'true';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'W09 backup-snapshot-file-index: backfilled file_index_status=agent on % snapshots with a pre-existing agent-reported index', n;
  END IF;
END $$;

-- ============================================
-- 2. backup_snapshot_files: index the column the download-authorization
--    membership check filters on. Not built CONCURRENTLY — autoMigrate
--    wraps this file in a transaction, and CREATE INDEX CONCURRENTLY cannot
--    run inside one. This takes a SHARE lock on backup_snapshot_files for
--    the duration of the build (blocks writers, not readers); the table is
--    written only at backup-result-persistence time and by this wave's own
--    hydration job, both low-frequency compared to request traffic.
-- ============================================
CREATE INDEX IF NOT EXISTS backup_snapshot_files_snapshot_backup_path_idx
  ON backup_snapshot_files (snapshot_db_id, backup_path);

-- ============================================
-- 3. backup_snapshot_origins — verified provenance for every OLDER snapshot
--    an incremental manifest references. Snapshot-keyed like
--    backup_snapshot_files: no org_id/device_id columns of its own (this
--    table records ANOTHER snapshot's identity, and that snapshot may no
--    longer have a live row — see origin_org_id/origin_device_id below), so
--    it reaches its own tenant only through snapshot_db_id -> backup_snapshots
--    — Shape 5 / PARENT_FK_JOIN_POLICY_TABLES, exactly like
--    backup_snapshot_files (2026-06-23-sec-review-1-fk-child-rls-backstop.sql).
-- ============================================
CREATE TABLE IF NOT EXISTS backup_snapshot_origins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_db_id uuid NOT NULL REFERENCES backup_snapshots(id) ON DELETE CASCADE,
  -- origin_snapshot_id is the AGENT id (varchar, matches backup_snapshots.snapshot_id
  -- / backup_snapshot_retirements.snapshot_id), not a FK to backup_snapshots.id:
  -- the origin's own backup_snapshots row may already be gone (retention
  -- deleted it — see origin_org_id/origin_device_id below, captured from
  -- whichever of the live row or the retirement record still existed at
  -- hydration time).
  origin_snapshot_id varchar(255) NOT NULL,
  -- origin_org_id / origin_device_id are DELIBERATELY NOT FKs: provenance
  -- must not vanish (or silently NULL) with the origin device row's own
  -- lifecycle — the referencing snapshot's own snapshot_db_id FK (above)
  -- governs this row's lifetime, cascading when THIS snapshot is deleted,
  -- never when the ORIGIN's device is.
  origin_org_id uuid NOT NULL,
  origin_device_id uuid NOT NULL,
  origin_storage_identity text NOT NULL,
  origin_storage_prefix text,
  provenance text NOT NULL,
  object_count integer NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE backup_snapshot_origins
    ADD CONSTRAINT backup_snapshot_origins_provenance_chk
    CHECK (provenance IN ('live', 'retired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS backup_snapshot_origins_snapshot_origin_uq
  ON backup_snapshot_origins (snapshot_db_id, origin_snapshot_id);
CREATE INDEX IF NOT EXISTS backup_snapshot_origins_snapshot_idx
  ON backup_snapshot_origins (snapshot_db_id);

ALTER TABLE backup_snapshot_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_snapshot_origins FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_snapshot_origins;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_snapshot_origins;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_snapshot_origins;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_snapshot_origins;
CREATE POLICY breeze_org_isolation_select ON backup_snapshot_origins FOR SELECT USING (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_origins.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON backup_snapshot_origins FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_origins.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
);
CREATE POLICY breeze_org_isolation_update ON backup_snapshot_origins FOR UPDATE USING (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_origins.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_origins.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON backup_snapshot_origins FOR DELETE USING (
  EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.id = backup_snapshot_origins.snapshot_db_id AND public.breeze_has_org_access(s.org_id))
);
