-- Backup snapshot file index, checkpoint plus delta (#11736 step 2, W2): tables,
-- columns, RLS and move coherence. Nothing writes these tables or columns yet.
-- Plan: docs/superpowers/plans/backup/2026-11-25-backup-snapshot-index-checkpoint-delta.md
--
-- WHAT
-- ----
--   backup_tree_checkpoints         a full file-index entry set owned by one backup
--                                   lineage of one device (header row; RLS shape 1)
--   backup_tree_checkpoint_entries  its entries (no org_id; parent-join RLS through
--                                   the header, the shape backup_snapshot_files has)
--   backup_snapshots                + file_index_format ('rows' | 'delta')
--                                   + file_index_checkpoint_id (set exactly when 'delta')
--   backup_snapshot_files           + checkpoint_entry_no (NULL = an entry of this
--                                   snapshot; set = a tombstone of that checkpoint entry)
--   backup_configs                  + UNIQUE (id, org_id), the target of the header's
--                                   composite config FK
--
-- org_id NOT NULL on the header: a checkpoint is derived data, a copy of one
-- device's verified backup manifest, rebuildable from that manifest. It always
-- belongs to exactly one device of one org, like backup_snapshots. It is not a
-- policy, template or other config a partner defines once for many orgs.
--
-- COHERENCE
-- ---------
-- A delta snapshot names its checkpoint through (file_index_checkpoint_id, org_id,
-- device_id) -> backup_tree_checkpoints (id, org_id, device_id), so it can never
-- reference, or pin through ON DELETE RESTRICT, another org's or another device's
-- checkpoint. The header names its backup config through (config_id, org_id), so
-- a header cannot be restamped into another org while its config stays behind.
-- Both composite FKs are DEFERRABLE INITIALLY IMMEDIATE (org merge repoints the
-- header, its config and its snapshots in separate statements under SET
-- CONSTRAINTS ALL DEFERRED). RESTRICT itself is never deferred, which is the point.
--
-- On a device org move the header is deleted, not restamped (the app's move-delete
-- list), and the moved delta snapshots fall back to 'rows' with no rows and
-- re-hydrate on next use. Section 4 below makes the database do the snapshot half
-- on every path that changes a snapshot's org or device.
--
-- LOCKS
-- -----
-- The new columns are nullable or carry a constant default, so adding them does not
-- rewrite either table. Adding the three backup_snapshots constraints scans
-- backup_snapshots once each under the ALTER's lock; every row passes ('rows' and
-- NULL everywhere). They are not added NOT VALID with a VALIDATE in the next file:
-- integration replays follow constraint names into later files, and they refuse a
-- `-- @no-transaction` follower. The two hot tables are altered first, before this
-- transaction requests any lock on devices or organizations, and lock_timeout bounds
-- the wait for each lock: if a long transaction holds one, the file fails after 5 s
-- instead of queueing every reader behind it, and re-runs on next start. It bounds
-- waits only: the locks taken are held until the file commits. A transaction that
-- locks devices and then backup_snapshots (a device org move from another process)
-- inside that short window can deadlock with this file; Postgres aborts one of the
-- two, and either the move or the migration (re-run on next start) is retried.
--
-- Idempotent throughout (IF NOT EXISTS, guarded ADD CONSTRAINT, CREATE OR REPLACE,
-- DROP ... IF EXISTS then CREATE). Writes no rows, so no breeze.scope election; the
-- trigger body in section 4 elects system scope in-body and restores the caller's.
-- No inner BEGIN/COMMIT.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The existing hot tables, altered first: columns (catalog-only) and two CHECKs
--    (one scan of backup_snapshots each)
-- ---------------------------------------------------------------------------
ALTER TABLE public.backup_snapshot_files ADD COLUMN IF NOT EXISTS checkpoint_entry_no integer;

ALTER TABLE public.backup_snapshots ADD COLUMN IF NOT EXISTS file_index_format text NOT NULL DEFAULT 'rows';
ALTER TABLE public.backup_snapshots ADD COLUMN IF NOT EXISTS file_index_checkpoint_id uuid;

DO $$ BEGIN
  ALTER TABLE public.backup_snapshots ADD CONSTRAINT backup_snapshots_file_index_format_chk
    CHECK (file_index_format IN ('rows', 'delta'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.backup_snapshots ADD CONSTRAINT backup_snapshots_file_index_checkpoint_chk
    CHECK ((file_index_format = 'delta') = (file_index_checkpoint_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. backup_configs (id, org_id): the header's config FK target
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE public.backup_configs ADD CONSTRAINT backup_configs_id_org_uq UNIQUE (id, org_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 3. The checkpoint tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_tree_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  device_id uuid NOT NULL REFERENCES public.devices(id),
  config_id uuid NOT NULL,
  -- Lineage key (R5): with org, device and config, the snapshots that may share
  -- this checkpoint. Copied from the source snapshot at publish.
  storage_identity text NOT NULL,
  backup_type public.backup_type NOT NULL,
  key_layout text NOT NULL,
  key_prefix text,
  entry_count integer NOT NULL,
  -- Provenance only: a plain uuid, not an FK, because the source snapshot retires
  -- independently of the checkpoint built from it.
  source_snapshot_db_id uuid,
  source_manifest_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_referenced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_tree_checkpoints_id_org_device_uq UNIQUE (id, org_id, device_id),
  CONSTRAINT backup_tree_checkpoints_entry_count_chk CHECK (entry_count >= 0),
  CONSTRAINT backup_tree_checkpoints_config_org_fk FOREIGN KEY (config_id, org_id)
    REFERENCES public.backup_configs (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS backup_tree_checkpoints_lineage_idx
  ON public.backup_tree_checkpoints (device_id, config_id, storage_identity, created_at DESC);
CREATE INDEX IF NOT EXISTS backup_tree_checkpoints_org_id_idx
  ON public.backup_tree_checkpoints (org_id);

-- No id and no created_at: entries are the bulk of the bytes.
CREATE TABLE IF NOT EXISTS public.backup_tree_checkpoint_entries (
  checkpoint_id uuid NOT NULL REFERENCES public.backup_tree_checkpoints(id) ON DELETE CASCADE,
  -- Unique within the checkpoint; a delta snapshot's tombstone names an entry by
  -- this number, because source_path is not unique within a manifest.
  entry_no integer NOT NULL,
  source_path text NOT NULL,
  backup_path text NOT NULL,
  size bigint,
  modified_at timestamp,
  kind text,
  CONSTRAINT backup_tree_checkpoint_entries_pkey PRIMARY KEY (checkpoint_id, entry_no)
);

CREATE INDEX IF NOT EXISTS backup_tree_checkpoint_entries_checkpoint_source_idx
  ON public.backup_tree_checkpoint_entries (checkpoint_id, source_path);
CREATE INDEX IF NOT EXISTS backup_tree_checkpoint_entries_checkpoint_backup_path_idx
  ON public.backup_tree_checkpoint_entries (checkpoint_id, backup_path);

-- A snapshot pins its checkpoint (R4): RESTRICT, no reference count. Composite so
-- the pointer can only name a checkpoint of the snapshot's own org and device.
-- MATCH SIMPLE (the default): a NULL pointer is never checked.
DO $$ BEGIN
  ALTER TABLE public.backup_snapshots ADD CONSTRAINT backup_snapshots_file_index_checkpoint_fk
    FOREIGN KEY (file_index_checkpoint_id, org_id, device_id)
    REFERENCES public.backup_tree_checkpoints (id, org_id, device_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS. Header: shape 1, the backup_snapshots policy names and shape
-- (2026-04-11-bucket-a-rls-policies.sql). Entries: parent-join through the header,
-- the backup_snapshot_files block of 2026-06-23-sec-review-1-fk-child-rls-backstop.sql.
ALTER TABLE public.backup_tree_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_tree_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE public.backup_tree_checkpoint_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_tree_checkpoint_entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.backup_tree_checkpoints;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.backup_tree_checkpoints;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.backup_tree_checkpoints;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.backup_tree_checkpoints;
CREATE POLICY breeze_org_isolation_select ON public.backup_tree_checkpoints
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.backup_tree_checkpoints
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.backup_tree_checkpoints
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.backup_tree_checkpoints
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.backup_tree_checkpoint_entries;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.backup_tree_checkpoint_entries;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.backup_tree_checkpoint_entries;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.backup_tree_checkpoint_entries;
CREATE POLICY breeze_org_isolation_select ON public.backup_tree_checkpoint_entries FOR SELECT USING (
  EXISTS (SELECT 1 FROM backup_tree_checkpoints c WHERE c.id = backup_tree_checkpoint_entries.checkpoint_id AND public.breeze_has_org_access(c.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON public.backup_tree_checkpoint_entries FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM backup_tree_checkpoints c WHERE c.id = backup_tree_checkpoint_entries.checkpoint_id AND public.breeze_has_org_access(c.org_id))
);
CREATE POLICY breeze_org_isolation_update ON public.backup_tree_checkpoint_entries FOR UPDATE USING (
  EXISTS (SELECT 1 FROM backup_tree_checkpoints c WHERE c.id = backup_tree_checkpoint_entries.checkpoint_id AND public.breeze_has_org_access(c.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM backup_tree_checkpoints c WHERE c.id = backup_tree_checkpoint_entries.checkpoint_id AND public.breeze_has_org_access(c.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON public.backup_tree_checkpoint_entries FOR DELETE USING (
  EXISTS (SELECT 1 FROM backup_tree_checkpoints c WHERE c.id = backup_tree_checkpoint_entries.checkpoint_id AND public.breeze_has_org_access(c.org_id))
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.backup_tree_checkpoints TO breeze_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.backup_tree_checkpoint_entries TO breeze_app;
  END IF;
END $$;

-- Planner statistics after a large checkpoint publish. breeze_app does not own the
-- table, so a plain ANALYZE from it is skipped; same contract as
-- breeze_analyze_backup_snapshot_files() (2027-01-22-210200-backup-snapshot-files-analyze.sql):
-- owner check, NOWAIT lock (never queues behind or cancels autovacuum), true once
-- analyzed, false if the table is busy. It analyzes this one table only.
CREATE OR REPLACE FUNCTION public.breeze_analyze_backup_tree_checkpoint_entries()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid = 'public.backup_tree_checkpoint_entries'::regclass
      AND pg_has_role(current_user, c.relowner, 'USAGE')
  ) THEN
    RAISE EXCEPTION 'breeze_analyze_backup_tree_checkpoint_entries: % does not own backup_tree_checkpoint_entries', current_user
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    LOCK TABLE public.backup_tree_checkpoint_entries IN SHARE UPDATE EXCLUSIVE MODE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN FALSE;
  END;

  ANALYZE public.backup_tree_checkpoint_entries;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_analyze_backup_tree_checkpoint_entries() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_analyze_backup_tree_checkpoint_entries() TO breeze_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. The snapshot tenancy reset also resets a delta snapshot.
-- Replaces the body from 2026-10-31-100700-backup-snapshot-file-index-org-move-reset.sql
-- (#6488); the trigger definition there (BEFORE UPDATE OF org_id, device_id, WHEN
-- either actually changes) is unchanged. It fires on every path that changes a
-- snapshot's org or device: the app's device move, breeze_cascade_device_org_id()
-- on a raw UPDATE devices, and org merge.
--
-- Kept unchanged: a 'complete' or 'hydrating' index drops to 'none', so origin
-- provenance pinned to the old org/device is re-verified before it authorizes again.
--
-- New: a 'delta' snapshot's tree depends on a checkpoint of its OLD org and device,
-- which a move deletes (or, on a raw UPDATE devices, leaves behind unreferenced).
-- In the same row update the snapshot becomes 'rows' with a NULL pointer and status
-- 'none' whatever its old status, and its backup_snapshot_files rows (adds and
-- tombstones, which without the checkpoint would read as a partial tree) are
-- deleted. It re-hydrates on next use. Because the new pointer is NULL, the
-- composite pointer FK is never checked mid-move (MATCH SIMPLE).
--
-- SECURITY DEFINER with a pinned search_path, and system scope elected around the
-- delete then restored (backup_snapshot_files is FORCE ROW LEVEL SECURITY, which a
-- definer is still bound by): the delete must not depend on what the mover's
-- context can see. Shape copied from breeze_learned_networks_device_moved()
-- (2027-01-29-100000-learned-networks.sql), with pg_catalog first in search_path so
-- no object in public can shadow set_config()/current_setting(). It deletes only
-- the file rows of the snapshot whose UPDATE fired it (an UPDATE that passed that
-- snapshot's RLS). A trigger function cannot be called directly, so this widens
-- nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_backup_snapshot_file_index_tenancy_reset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text;
BEGIN
  IF NEW.file_index_status IN ('complete', 'hydrating') THEN
    NEW.file_index_status := 'none';
  END IF;

  IF OLD.file_index_format = 'delta' THEN
    NEW.file_index_format := 'rows';
    NEW.file_index_checkpoint_id := NULL;
    NEW.file_index_status := 'none';
    _prev_scope := current_setting('breeze.scope', true);
    PERFORM set_config('breeze.scope', 'system', true);
    DELETE FROM public.backup_snapshot_files WHERE snapshot_db_id = NEW.id;
    PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.breeze_backup_snapshot_file_index_tenancy_reset() IS
  '#6488, #11736: when a backup_snapshots row''s org_id or device_id changes, resets a complete/hydrating file index to none, and resets a delta-format index to rows (NULL checkpoint pointer, status none, its backup_snapshot_files rows deleted) so it re-hydrates under the new org/device.';

-- Trigger-only body; nobody calls it directly.
REVOKE ALL ON FUNCTION public.breeze_backup_snapshot_file_index_tenancy_reset() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 5. Generic device-move restamp: exclude backup_tree_checkpoints.
-- Body copied VERBATIM from the newest prior definition,
-- 2026-12-27-170000-pam-org-move-unactuated-elevation-restamp.sql, with only
-- backup_tree_checkpoints added to the NOT IN list.
-- deviceOwnershipEpochs.integration.test.ts pins the full exclusion set.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  AS $$
  SELECT t.relname::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relkind = 'r'
    AND t.relname <> 'devices'
    -- ai_agent_runs: agent-run history stays with the SOURCE org on a device
    -- move (owner decision 2026-08-23); its org_id is trigger-immutable.
    -- PAM lifecycle and result evidence is likewise source-frozen, but unlike
    -- agent runs its existence blocks the device move entirely.
    -- invoice_line_devices: billing evidence stays in its INVOICE's org on a
    -- device move. The invoice and its lines do not move, so restamping the
    -- evidence row's org_id here trips invoice_line_devices_line_org_fk /
    -- invoice_line_devices_invoice_org_fk (DEFERRABLE INITIALLY IMMEDIATE) at
    -- the end of the trigger's own statement. moveOrg.ts detaches device_id
    -- instead, and that statement is LOAD-BEARING, not a mirror of this loop
    -- (#3205 W07).
    -- ai_operator_tasks: AI Operator task history stays with the SOURCE org
    -- (#5205 W03, #5208). org_id is immutable and anchors composite
    -- (x, org_id) FKs, so a re-stamp aborts the move as soon as the task has
    -- an operation, an outbox wake, a target, a step, an event, a linked run
    -- or a linked intent. moveOrg.ts and this trigger both detach device_id
    -- and fence the task instead.
    -- ai_operator_task_targets (recipe library E2): same rule one level down.
    -- The target's org_id is its TASK's org_id and anchors
    -- ai_operator_task_targets_task_org_fk, so re-stamping it to the
    -- destination org while the task stays behind aborts the move with 23503.
    -- Section 9 detaches device_id and stamps the reason instead.
    -- fix_outcomes (AI Suggested Fixes W1): attempt history stays with the org
    -- the attempt ran in; (org_id, partner_id) composite FK would 23503 on a
    -- cross-partner move. The outcome sweeper cancels in-flight rows whose
    -- device left the org.
    -- device_ownership_epochs / device_ownership_epoch_closures: ownership
    -- lineage is append-only; an org change appends a new epoch through
    -- breeze_device_ownership_epoch_advance() instead (PAM ownership epochs
    -- #8203, spec §4). pam_ledger_retirements has no org_id; listed for clarity.
    -- elevation_requests (PAM ownership epochs W6-pre, #8746): an ACTUATED
    -- request is PAM-chain evidence frozen at its (org_id, device_epoch);
    -- breeze_pam_chain_epoch_guard() refuses (42501) any restamp of it, so a
    -- move of a device whose earlier epoch holds one aborted here. Un-actuated
    -- requests still follow the device: breeze_restamp_unactuated_elevation_
    -- requests() (its own AFTER UPDATE OF org_id trigger on devices) restamps
    -- exactly those, and the guard re-anchors them into the new epoch.
    -- backup_tree_checkpoints (#11736): (config_id, org_id) names a SOURCE-org
    -- backup config, so a restamp here would 23503 at the end of this
    -- statement. The app move deletes the device's headers after its snapshots
    -- are restamped (CORE_DEVICE_ORG_MOVE_DELETE_TABLES); on a raw UPDATE
    -- devices the header stays in the source org, unreferenced (the snapshot
    -- tenancy reset clears every pointer to it), until the checkpoint GC the
    -- writer wave adds deletes it.
    -- A BEFORE UPDATE delete trigger on devices (the learned-networks shape)
    -- cannot work here: the snapshots still point at the header until their own
    -- restamp, and ON DELETE RESTRICT refuses the delete.
    AND t.relname NOT IN (
      'ai_agent_runs',
      'ai_operator_tasks',
      'ai_operator_task_targets',
      'pam_actuations',
      'pam_actuation_results',
      'invoice_line_devices',
      'offline_transition_effects',
      'fix_outcomes',
      'device_ownership_epochs',
      'device_ownership_epoch_closures',
      'pam_ledger_retirements',
      'elevation_requests',
      'backup_tree_checkpoints'
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'device_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'org_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    );
$$;
