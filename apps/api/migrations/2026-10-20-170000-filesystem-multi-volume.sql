-- Disk Cleanup v2 W02 — the scan-path axis for filesystem analysis (spec §4,
-- as amended by the Codex quorum findings in spec §13 #7, #8 and #18).
--
-- WHAT THIS FIXES (spec §2 defect 6). Scan state is keyed per DEVICE and
-- snapshots record no path, so a `D:\` scan resets the `C:\` baseline,
-- pollutes its hotDirectories, and becomes the "latest" snapshot that a `C:\`
-- cleanup preview then deletes from.
--
-- EXPAND ONLY (§13 #7). Every column added here is NULLABLE or defaulted, and
-- there is no primary key and no nullability contraction. An old API replica still
-- draining during the deploy supplies no `scan_path`; a NOT NULL column would
-- fail its snapshot INSERT with 23502 and lose a completed scan outright.
-- W03 ships the contract half — `2026-10-20-170200-filesystem-scan-path-not-null.sql`
-- — once W02 is deployed everywhere.
--
-- SHIPS WITH ITS CODE. `upsertFilesystemScanState` uses
-- `onConflictDoUpdate({ target: deviceId })`; the single-column key is dropped
-- below, so that target names no unique index and every upsert raises 42P10.
-- The API release that carries this migration MUST also carry the writer
-- change. During a multi-replica window old replicas' snapshot inserts keep
-- working (the column is nullable) while their scan-state upserts fail with
-- 42P10 until they drain; a re-run scan repairs that state.
--
-- IDEMPOTENT. Every DDL statement is guarded and every backfill is gated on
-- `scan_path IS NULL`. No inner BEGIN/COMMIT: autoMigrate wraps each file in
-- one transaction.

-- ---------------------------------------------------------------------------
-- Transient normalisation helper
-- ---------------------------------------------------------------------------
-- The SQL mirror of `normalizeScanPath(osType, path)` (packages/shared). Both
-- backfills below call it, so the two provably agree instead of carrying two
-- hand-copied CASE chains that can drift. Created and dropped inside this
-- migration: it is a migration-local tool, never part of the schema.
--
-- It does NOT resolve `.`/`..` — impractical set-based SQL. A recorded path
-- carrying a dot segment is returned UNCHANGED, which makes it inert (it
-- matches no normalised read) and lets the next scan supersede it.
-- Deliberately not re-keyed to the OS root, which would fold another volume's
-- cleanup candidates into the root preview.
--
-- A NULL or blank path yields the OS root, so `…(os_type, NULL)` is also how
-- the callers below spell "this device's OS root".
DROP FUNCTION IF EXISTS public.breeze_w02_normalize_scan_path(text, text);
CREATE FUNCTION public.breeze_w02_normalize_scan_path(os_type text, raw_path text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN raw_path IS NULL OR btrim(raw_path) = ''
      THEN CASE WHEN os_type = 'windows' THEN 'C:\' ELSE '/' END
    WHEN raw_path ~ '(^|^[A-Za-z]:|[\\/])\.\.?([\\/]|$)'
      THEN raw_path
    WHEN os_type = 'windows' THEN (
      -- Preserve UNC's two leading separators before collapsing the rest.
      -- Bare drives and drive-relative inputs both become absolute roots.
      SELECT CASE
               WHEN d ~ '^[A-Za-z]:\\$' OR d = '\\' THEN d
               WHEN length(d) > 1 AND right(d, 1) = '\' THEN left(d, length(d) - 1)
               ELSE d
             END
        FROM (
          SELECT CASE WHEN w ~ '^[A-Za-z]:'
                      THEN upper(left(w, 1)) || ':\' || ltrim(substr(w, 3), '\')
                      ELSE w END AS d
            FROM (
              SELECT CASE WHEN left(slashed, 2) = '\\'
                          THEN '\\' || regexp_replace(ltrim(slashed, '\'), '\\{2,}', '\\', 'g')
                          ELSE regexp_replace(slashed, '\\{2,}', '\\', 'g') END AS w
                FROM (SELECT replace(btrim(raw_path), '/', '\') AS slashed) s0
            ) w0
        ) d0
    )
    ELSE (
      SELECT CASE
               WHEN p = '/' THEN '/'
               WHEN length(p) > 1 AND right(p, 1) = '/' THEN left(p, length(p) - 1)
               ELSE p
             END
        FROM (SELECT regexp_replace(btrim(raw_path), '/{2,}', '/', 'g') AS p) p0
    )
  END
$fn$;

-- ---------------------------------------------------------------------------
-- device_filesystem_snapshots
-- ---------------------------------------------------------------------------

ALTER TABLE public.device_filesystem_snapshots
  ADD COLUMN IF NOT EXISTS scan_path text;

DO $$
DECLARE
  n bigint;
  verbatim_rows bigint;
  skipped_rows bigint;
BEGIN
  -- 425 of 442 public tables are FORCE ROW LEVEL SECURITY, which binds the
  -- table OWNER — the role migrations run as. Without this election the UPDATE
  -- below matches ZERO rows with no error and the RAISE WARNING prints a
  -- truthful-looking 0; the JOIN to `devices` is policy-filtered the same way.
  -- `is_local = true` scopes it to autoMigrate's per-file transaction.
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT count(*) INTO verbatim_rows
    FROM public.device_filesystem_snapshots
   WHERE scan_path IS NULL
     AND raw_payload->>'path' ~ '(^|^[A-Za-z]:|[\\/])\.\.?([\\/]|$)';

  UPDATE public.device_filesystem_snapshots s
     SET scan_path = public.breeze_w02_normalize_scan_path(
                       d.os_type::text,
                       NULLIF(s.raw_payload->>'path', ''))
    FROM public.devices d
   WHERE d.id = s.device_id
     AND s.scan_path IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'backfilled % device_filesystem_snapshots.scan_path (% stored verbatim: recorded path carries a dot segment)', n, verbatim_rows;

  SELECT count(*) INTO skipped_rows
    FROM public.device_filesystem_snapshots s
   WHERE s.scan_path IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.id = s.device_id);
  RAISE WARNING 'skipped % device_filesystem_snapshots rows because the device row is missing', skipped_rows;
END $$;

-- scan_path remains nullable here (§13 #7). W03 contracts it.

-- New index FIRST, old index second: never leave the latest-snapshot lookup
-- without a supporting index, even for the length of one transaction.
CREATE INDEX IF NOT EXISTS idx_device_filesystem_snapshots_device_path_captured
  ON public.device_filesystem_snapshots (device_id, scan_path, captured_at DESC);

DROP INDEX IF EXISTS idx_device_filesystem_snapshots_device_captured;

-- ---------------------------------------------------------------------------
-- device_filesystem_scan_state — the volume axis and the scan generation
-- ---------------------------------------------------------------------------

ALTER TABLE public.device_filesystem_scan_state
  ADD COLUMN IF NOT EXISTS scan_path text;

-- The `filesystem_analysis` command id that started the run currently owning
-- this row (§13 #18). Every producer sets it when queuing; the result handler
-- claims it, which makes result application both exclusive (a superseded scan
-- cannot overwrite a newer checkpoint) and idempotent (a duplicate delivery of
-- the same command id is dropped). No FK: device_commands rows are pruned on
-- their own schedule and a pruned command must not take the state with it.
ALTER TABLE public.device_filesystem_scan_state
  ADD COLUMN IF NOT EXISTS scan_generation uuid;

-- Durable receipt: NULL generation is also valid for pre-W02 dispatches, so
-- duplicate results are identified by command id independently of ownership.
ALTER TABLE public.device_filesystem_scan_state
  ADD COLUMN IF NOT EXISTS last_applied_command_id uuid;

DO $$
DECLARE
  matched_rows bigint;
  reset_rows bigint;
  skipped_rows bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  -- PASS A — the device's newest snapshot names a path that is still one of
  -- this device's volumes (or its OS root). That row's checkpoint, aggregate
  -- and hot directories genuinely belong to that volume, so they are kept.
  -- The snapshot backfill above already ran, so `s.scan_path` is normalised
  -- and the two passes agree by construction.
  UPDATE public.device_filesystem_scan_state st
     SET scan_path = n.scan_path
    FROM public.devices d,
         LATERAL (
           SELECT s.scan_path, NULLIF(btrim(s.raw_payload->>'path'), '') AS original_path
             FROM public.device_filesystem_snapshots s
            WHERE s.device_id = d.id
              AND s.scan_path IS NOT NULL
            ORDER BY s.captured_at DESC
            LIMIT 1
         ) n
   WHERE d.id = st.device_id
     AND st.scan_path IS NULL
     AND n.original_path IS NOT NULL
     AND (
       n.scan_path = public.breeze_w02_normalize_scan_path(d.os_type::text, NULL)
       OR EXISTS (
         SELECT 1
           FROM public.device_disks dd
          WHERE dd.device_id = st.device_id
            AND public.breeze_w02_normalize_scan_path(d.os_type::text, dd.mount_point) = n.scan_path
       )
     );
  GET DIAGNOSTICS matched_rows = ROW_COUNT;

  -- PASS B — everything else (§13 #8). Labelling these rows the OS root is the
  -- only defensible choice, but their resume state may belong to a DIFFERENT
  -- volume: a device whose last scan was `D:\` carries a `D:\` checkpoint,
  -- `D:\` aggregate and `D:\` hot directories, and relabelling that row `C:\`
  -- makes the next `C:\` scan resume into `D:\` paths — defect 6 reintroduced
  -- by the migration that fixes it. So the label is applied and the resume
  -- state is CLEARED. Cost: one full re-scan of that volume.
  -- `last_baseline_completed_at` and `last_disk_used_percent` are kept: a
  -- stale percent costs at most one baseline, and the completion timestamp is
  -- what stops the tab reading as "never scanned".
  UPDATE public.device_filesystem_scan_state st
     SET scan_path = public.breeze_w02_normalize_scan_path(d.os_type::text, NULL),
         checkpoint = '{}'::jsonb,
         aggregate = '{}'::jsonb,
         hot_directories = '[]'::jsonb
    FROM public.devices d
   WHERE d.id = st.device_id
     AND st.scan_path IS NULL;
  GET DIAGNOSTICS reset_rows = ROW_COUNT;

  RAISE WARNING 'backfilled % device_filesystem_scan_state rows from their newest snapshot volume', matched_rows;
  RAISE WARNING 'reset % device_filesystem_scan_state rows to the OS root and cleared checkpoint/aggregate/hot_directories (volume unknown)', reset_rows;

  SELECT count(*) INTO skipped_rows
    FROM public.device_filesystem_scan_state st
   WHERE st.scan_path IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.id = st.device_id);
  RAISE WARNING 'skipped % device_filesystem_scan_state rows because the device row is missing', skipped_rows;
END $$;

-- scan_path remains nullable here (§13 #7). W03 contracts it.

DO $$
BEGIN
  -- The single-column key has to go NOW, not in W03: it permits exactly one
  -- row per device, and multi-volume scan state is the point of the wave.
  -- Dropping a PRIMARY KEY does NOT drop its columns' NOT NULL in Postgres, so
  -- device_id stays non-nullable.
  ALTER TABLE public.device_filesystem_scan_state
    DROP CONSTRAINT IF EXISTS device_filesystem_scan_state_pkey;
END $$;

-- A nullable-tolerant UNIQUE INDEX, not a primary key (§13 #7, plan amendment
-- 16): a primary key would require the NOT NULL that W03 owns. `ON CONFLICT
-- (device_id, scan_path)` infers this index exactly as it would a constraint,
-- so the writer contract is identical. W03 promotes it in place with
-- `ADD CONSTRAINT device_filesystem_scan_state_pkey PRIMARY KEY USING INDEX
-- device_filesystem_scan_state_device_path_uidx`, which restores the baseline
-- constraint name.
CREATE UNIQUE INDEX IF NOT EXISTS device_filesystem_scan_state_device_path_uidx
  ON public.device_filesystem_scan_state (device_id, scan_path);

-- ---------------------------------------------------------------------------
-- device_filesystem_cleanup_runs
-- ---------------------------------------------------------------------------

-- Nullable on purpose: a W04 `kind='system'` run cleans the machine, not a
-- path, so it is not scan-path scoped.
ALTER TABLE public.device_filesystem_cleanup_runs
  ADD COLUMN IF NOT EXISTS scan_path text;

ALTER TABLE public.device_filesystem_cleanup_runs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'files';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'device_filesystem_cleanup_runs_kind_chk'
       AND conrelid = 'public.device_filesystem_cleanup_runs'::regclass
  ) THEN
    ALTER TABLE public.device_filesystem_cleanup_runs
      ADD CONSTRAINT device_filesystem_cleanup_runs_kind_chk
      CHECK (kind IN ('files', 'system'));
  END IF;
END $$;

-- The queued system_cleanup_run command (W04). No FK: device_commands rows are
-- pruned independently, and a pruned command must not delete the run that
-- records what was done.
ALTER TABLE public.device_filesystem_cleanup_runs
  ADD COLUMN IF NOT EXISTS command_id uuid;

-- ---------------------------------------------------------------------------
-- Clean up the migration-local helper
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.breeze_w02_normalize_scan_path(text, text);
