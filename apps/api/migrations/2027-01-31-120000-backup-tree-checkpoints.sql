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
-- Both are DEFERRABLE INITIALLY IMMEDIATE (org merge repoints the header, its
-- config and its snapshots in separate statements under SET CONSTRAINTS ALL
-- DEFERRED). RESTRICT itself is never deferred, which is the point.
--
-- The header names its device through (device_id, org_id) -> devices (id, org_id),
-- so its org is always its device's org, and ON DELETE CASCADE: a header never
-- blocks deleting its device (a device delete or another org's erasure). This one
-- is DEFERRABLE INITIALLY DEFERRED, like device_external_links_device_org_fk: a
-- device org UPDATE is checked at commit, after the trigger in section 6 has
-- deleted the device's headers. INITIALLY IMMEDIATE cannot work: the FK's own
-- check on devices is an AFTER ROW trigger whose name (RI_ConstraintTrigger_...)
-- sorts before every breeze_* trigger, so it runs at the end of the devices UPDATE,
-- before any AFTER trigger could delete the headers, and refuses the move.
--
-- Device org move: the header is deleted, not restamped, and the moved delta
-- snapshots fall back to 'rows' with no rows and re-hydrate on next use. Section 4
-- makes the database reset the snapshots on every path that changes a snapshot's
-- org or device; section 6 deletes the headers on every path that changes a
-- device's org (the app move, a raw UPDATE devices), except an org merge, which
-- repoints them.
--
-- Deleting a device with its snapshots and headers in one statement: no FK into
-- backup_snapshots cascades from devices (its device, org and config FKs are all
-- NO ACTION), so a cascade from devices never has to delete a snapshot. A header
-- reaches the pointer FK's RESTRICT check only once its snapshots are already
-- gone (the earlier statements of the same delete), or while one still names it,
-- in which case the snapshot's own NO ACTION device FK would refuse that delete
-- anyway. RESTRICT reports 23001 on Postgres 18 and 23503 before;
-- FOREIGN_KEY_VIOLATION_SQLSTATES matches both.
--
-- LOCKS
-- -----
-- One transaction; every lock is held until it commits. In order:
--   1. backup_snapshot_files, ACCESS EXCLUSIVE: ADD COLUMN, catalog-only (nullable,
--      no default), no scan.
--   2. backup_snapshots, ACCESS EXCLUSIVE (blocks its readers and writers until
--      commit): two ADD COLUMNs, catalog-only (nullable, or a constant default: no
--      rewrite), then the two CHECKs, one full scan each.
--   3. The two new tables: no lock on an existing table.
--   4. The snapshot pointer FK: SHARE ROW EXCLUSIVE on the new header table, and a
--      third full scan of backup_snapshots to validate it (every pointer is NULL,
--      so every row passes; MATCH SIMPLE).
--   5. RLS, grants and functions: no lock on an existing table.
--   6. Last: backup_configs ACCESS EXCLUSIVE (its UNIQUE (id, org_id), an index
--      build over that small table); then SHARE ROW EXCLUSIVE on organizations and
--      on devices for the header's FKs (validated against the empty header, no
--      scan of either) and for the trigger on devices.
-- So devices and organizations writes are blocked only for the last few
-- statements and the commit, not across the backup_snapshots scans, and
-- backup_configs readers likewise. Readers of devices and organizations are never
-- blocked (SHARE ROW EXCLUSIVE does not conflict with ACCESS SHARE).
--
-- The three backup_snapshots constraints are not added NOT VALID with a VALIDATE in
-- the next file: integration replays follow constraint names into later files, and
-- they refuse a `-- @no-transaction` follower.
--
-- lock_timeout bounds each wait: if a long transaction holds one of these tables,
-- the file fails after 5 s instead of queueing every later reader behind it, and
-- re-runs on next start. It bounds waits only, not holds. A transaction that has
-- written devices, organizations or backup_configs and then needs backup_snapshots
-- (a device org move from another process restamps snapshots) can deadlock with
-- step 6; Postgres aborts one of the two, and either the move or the migration
-- (re-run on next start) is retried.
--
-- Idempotent throughout (IF NOT EXISTS, guarded ADD CONSTRAINT and CREATE TRIGGER,
-- CREATE OR REPLACE, DROP POLICY IF EXISTS then CREATE). Writes no rows, so no
-- breeze.scope election; the trigger bodies in sections 4 and 6 elect system scope
-- in-body and restore the caller's. No inner BEGIN/COMMIT.

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
-- 2. The checkpoint tables. The header's FKs to organizations, devices and
--    backup_configs are added in section 6, so this transaction locks those
--    tables only at its end.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_tree_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  device_id uuid NOT NULL,
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
  CONSTRAINT backup_tree_checkpoints_entry_count_chk CHECK (entry_count >= 0)
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

-- ---------------------------------------------------------------------------
-- 3. The snapshot pointer FK, RLS, grants and the analyze function
-- ---------------------------------------------------------------------------
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
-- which a device move deletes (section 6) and an org merge leaves unreferenced.
-- In the same row update the snapshot becomes 'rows' with a NULL pointer and status
-- 'none' whatever its old status, and its backup_snapshot_files rows (adds and
-- tombstones, which without the checkpoint would read as a partial tree) are
-- deleted. It re-hydrates on next use. Because the new pointer is NULL, the
-- composite pointer FK is never checked mid-move (MATCH SIMPLE). This function
-- never deletes a checkpoint header; section 6's trigger and the app's move-delete
-- list do.
--
-- System scope is elected around the delete and then restored, so the delete sees
-- every file row of the snapshot whatever the mover's context can see
-- (backup_snapshot_files is FORCE ROW LEVEL SECURITY, which binds a definer too).
-- SECURITY DEFINER, with a pinned search_path, makes the delete independent of the
-- mover's own privileges on backup_snapshot_files. Shape copied from
-- breeze_learned_networks_device_moved() (2027-01-29-100000-learned-networks.sql),
-- with pg_catalog first in search_path so no object in public can shadow
-- set_config()/current_setting(). It deletes only the file rows of the snapshot
-- whose UPDATE fired it (an UPDATE that passed that snapshot's RLS). A trigger
-- function cannot be called directly, so this widens nothing.
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
    DELETE FROM public.backup_snapshot_files WHERE snapshot_db_id = OLD.id;
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
    -- statement. Instead the AFTER UPDATE OF org_id trigger
    -- breeze_device_moved_backup_tree_checkpoints (2027-01-31-120000) deletes the
    -- device's headers once this loop has restamped its snapshots (the snapshot
    -- tenancy reset clears every pointer to them); the app move's delete list
    -- (CORE_DEVICE_ORG_MOVE_DELETE_TABLES) is the fallback. A BEFORE UPDATE
    -- delete (the learned-networks shape) cannot work: the snapshots still point
    -- at the header until their own restamp, and ON DELETE RESTRICT refuses it.
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

-- ---------------------------------------------------------------------------
-- 6. Last, so the locks they take on existing tables are held only briefly
--    (see LOCKS): the header's FKs to backup_configs, organizations and devices,
--    and the device-move trigger.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE public.backup_configs ADD CONSTRAINT backup_configs_id_org_uq UNIQUE (id, org_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.backup_tree_checkpoints ADD CONSTRAINT backup_tree_checkpoints_config_org_fk
    FOREIGN KEY (config_id, org_id) REFERENCES public.backup_configs (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.backup_tree_checkpoints ADD CONSTRAINT backup_tree_checkpoints_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.organizations (id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Target: devices_id_org_id_uniq (2026-07-23-partner-export-material-state-hardening.sql).
-- ON DELETE CASCADE (an action, never deferred): the header is derived, rebuildable
-- data, and must not block deleting its device. INITIALLY DEFERRED: see COHERENCE.
-- The lineage index (device_id, ...) serves the cascade's lookup by device.
DO $$ BEGIN
  ALTER TABLE public.backup_tree_checkpoints ADD CONSTRAINT backup_tree_checkpoints_device_org_fk
    FOREIGN KEY (device_id, org_id) REFERENCES public.devices (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Device org move: delete the device's checkpoint headers (their entries cascade).
-- AFTER UPDATE OF org_id on devices, named to sort after breeze_cascade_device_org_id:
-- AFTER ROW triggers on one event fire in name order, and that restamp's UPDATE of
-- backup_snapshots is what clears every pointer to these headers (section 4), so
-- RESTRICT no longer applies. It runs on every path that changes a device's org: the
-- app move (whose delete list then matches nothing) and a raw UPDATE devices.
--
-- Only headers still in another org and named by no snapshot are deleted. A header
-- some snapshot still names stays, and backup_tree_checkpoints_device_org_fk then
-- refuses the move at commit, rather than this trigger failing with RESTRICT.
--
-- Skipped while the source org is fenced for a merge: the merge repoints the headers
-- with the org (orgMergeRegistry REPOINT_TABLES) under deferred constraints, as
-- breeze_learned_networks_device_moved() skips. A forged 'merging' status only keeps
-- the headers, and the device FK then refuses the move at commit.
--
-- SECURITY DEFINER with in-body system scope, saved and restored, so the delete does
-- not depend on the mover's RLS context or privileges. It deletes only rows of the
-- device whose UPDATE fired it. Trigger-only; it cannot be called directly.
CREATE OR REPLACE FUNCTION public.breeze_backup_tree_checkpoints_device_moved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o WHERE o.id = OLD.org_id AND o.status::text = 'merging'
  ) THEN
    DELETE FROM public.backup_tree_checkpoints c
     WHERE c.device_id = OLD.id
       AND c.org_id IS DISTINCT FROM NEW.org_id
       AND NOT EXISTS (
         SELECT 1 FROM public.backup_snapshots s WHERE s.file_index_checkpoint_id = c.id
       );
  END IF;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.breeze_backup_tree_checkpoints_device_moved() IS
  '#11736: after a device''s org_id changes (outside an org merge), deletes its unreferenced backup_tree_checkpoints left in another org; entries cascade.';

REVOKE ALL ON FUNCTION public.breeze_backup_tree_checkpoints_device_moved() FROM PUBLIC;

-- Guarded CREATE, not DROP TRIGGER IF EXISTS: DROP TRIGGER takes ACCESS EXCLUSIVE on
-- devices (blocking its readers) even when the trigger does not exist; CREATE
-- TRIGGER takes SHARE ROW EXCLUSIVE, which this transaction already holds.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.devices'::regclass
       AND tgname = 'breeze_device_moved_backup_tree_checkpoints'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER breeze_device_moved_backup_tree_checkpoints
      AFTER UPDATE OF org_id ON public.devices FOR EACH ROW
      WHEN (NEW.org_id IS DISTINCT FROM OLD.org_id)
      EXECUTE FUNCTION public.breeze_backup_tree_checkpoints_device_moved();
  END IF;
END $$;
