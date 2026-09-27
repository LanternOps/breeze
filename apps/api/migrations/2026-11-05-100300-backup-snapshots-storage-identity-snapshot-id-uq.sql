-- @no-transaction
-- Bind a backup snapshot id to the storage destination it was written to,
-- at the database layer as well as in application code. A (storage_identity,
-- snapshot_id) pair now names exactly one backup_snapshots row. The index is
-- enforced across every org: a second INSERT of the same pair fails with
-- 23505 whatever the inserting session's RLS context can see, including when
-- the existing row belongs to another org on a shared destination (which an
-- application-layer check running under an org-scoped RLS context cannot
-- see).
--
-- Scope choice — (storage_identity, snapshot_id), not a bare global
-- snapshot_id: storage_identity (provider + bucket/endpoint + credential
-- identity) is the destination a run actually writes objects to, and is the
-- same scope backupSnapshotReconcile.ts and the base-snapshot fence in
-- backupResultPersistence.ts already use for every other snapshot-identity
-- comparison in this codebase. Snapshot ids are agent-chosen (observed format:
-- a timestamp plus a short hex suffix, NOT a full-width random/hash id), so a
-- bare global unique index risks refusing two INDEPENDENT destinations that
-- coincidentally generate the same id with zero real collision — scoping by
-- storage_identity keeps the constraint meaningful (two runs claiming the
-- SAME id against the SAME destination) without that false-positive risk.
--
-- Partial (WHERE storage_identity IS NOT NULL): the column is nullable
-- FOREVER (see schema/backup.ts's own comment — self-healed by a later sweep,
-- no NOT NULL migration planned), and a NULL row must not be forced into one
-- shared all-NULLs uniqueness bucket with every other NULL row.
--
-- CONCURRENTLY: backup result ingest inserts into this table continuously
-- (agent WS traffic). IF NOT EXISTS keeps re-application a no-op. A UNIQUE
-- index cannot be created NOT VALID (that option only exists for CHECK/FK
-- constraints) — Postgres always validates a unique index's data at build
-- time, so if the diagnostic below reports existing duplicates this
-- CONCURRENTLY build will itself fail with Postgres's own duplicate-key error
-- and the migration aborts with NO index created and NO data touched or
-- deleted; autoMigrate will keep retrying this file on every boot until the
-- reported duplicates are triaged and resolved by hand (merge or retire the
-- losing row via the product's own backup-snapshot tooling, never a direct
-- DELETE from a migration). An interrupted CONCURRENTLY build can also leave
-- an INVALID index that IF NOT EXISTS would silently accept; the second DO
-- block below fails loudly in that state instead.
-- Recovery if that happens: DROP INDEX CONCURRENTLY
-- backup_snapshots_storage_identity_snapshot_id_uq, then let autoMigrate
-- re-run this file.

DO $$
DECLARE
  dup_count integer;
BEGIN
  -- Diagnostic read only (no write in this file) — still needs system scope
  -- to see every org's rows, since backup_snapshots is FORCE ROW LEVEL
  -- SECURITY and migrations run as the table owner, which FORCE RLS binds
  -- too. is_local (the `true` third argument) scopes this to the current
  -- statement, which is this whole DO block.
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT count(*) INTO dup_count FROM (
    SELECT storage_identity, snapshot_id
    FROM backup_snapshots
    WHERE storage_identity IS NOT NULL
    GROUP BY storage_identity, snapshot_id
    HAVING count(*) > 1
  ) dupes;

  IF dup_count > 0 THEN
    RAISE WARNING 'backup_snapshots has % existing (storage_identity, snapshot_id) duplicate group(s) — the unique index build below will fail until these are triaged and resolved by hand (no automatic delete/merge)', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS backup_snapshots_storage_identity_snapshot_id_uq
  ON public.backup_snapshots (storage_identity, snapshot_id)
  WHERE storage_identity IS NOT NULL;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.backup_snapshots'::regclass
     AND c.relname = 'backup_snapshots_storage_identity_snapshot_id_uq'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'backup_snapshots storage-identity/snapshot-id unique index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
