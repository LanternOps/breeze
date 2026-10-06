-- #7541: drain metric_rollups_default instead of only pruning it.
--
-- A row lands in metric_rollups_default only when its month had no partition
-- at write time. From then on that month can never be created: CREATE ...
-- PARTITION OF would have to move the row, so it fails, the month is skipped
-- (#7531 made that skip a visible maintenance failure), and the month's writes
-- keep landing in the default. Two costs follow:
--
--   * retention in the default is a row DELETE, whose space is never returned;
--   * creating ANY month scans the whole default under ACCESS EXCLUSIVE on
--     metric_rollups (the attach must prove no default row belongs to it).
--
-- The drain, run by the daily maintenance job whenever the default is
-- non-empty, swaps the default out instead of moving rows inside it:
--
--   1. breeze_swap_metric_rollup_default (one short transaction, bounded by
--      the caller's lock_timeout): DETACH the full default, move it into
--      metric_rollups_staging as metric_rollups_default_drain, CREATE a fresh
--      empty default (no scan: nothing else is a default), and create every
--      blocked month (each CREATE now scans the EMPTY new default). From this
--      commit on, writes for those months route to their partitions.
--   2. breeze_drain_metric_rollup_default_batch (many short transactions):
--      DELETE a page range of the drain table and re-INSERT the still-retained
--      rows through metric_rollups, so they route into their month and bucket
--      leaves; expired rows are simply not re-inserted. Nothing but this
--      function touches the drain table, so the only locks taken on live
--      tables are the ordinary row locks of an INSERT. A key the rollup writer
--      already re-upserted into the new month keeps the NEWER row
--      (updated_at), matching the writer's last-write-wins upsert.
--   3. breeze_finish_metric_rollup_default_drain: DROP the (now empty) drain
--      table, returning every page it held to the OS.
--
-- Between 1 and 3 the drained rows are not visible through metric_rollups
-- (they are in a detached table). The job runs 2 and 3 straight after 1, so
-- that window is the move itself; a run that fails part way leaves the drain
-- table in place and the next run resumes the move before swapping again.
--
-- The swap drops the drain table's FKs (see the function for why), so a
-- device or org deleted mid-drain is neither blocked by nor cascaded into it;
-- the move discards rows whose device no longer exists and re-inserts the rest
-- under their device's current org. The table
-- keeps the default's RLS and
-- grants; metric_rollups_staging is not usable by breeze_app
-- (USAGE revoked from PUBLIC) and is outside the public-schema tenancy
-- tripwire, as for staged compaction leaves.
--
-- breeze_app cannot run DDL, so each step is a SECURITY DEFINER function that
-- derives every identifier itself (precedent: 2026-08-05, 2026-11-10-130000).
--
-- Writes no rows (functions only). Idempotent. autoMigrate wraps this file in
-- a transaction.

-- ---------------------------------------------------------------------------
-- Converge RLS/grants: now also accepts metric_rollups_default, so a default
-- created by the swap gets exactly the policies the original one had.
-- Same signature and body as 2026-11-10-130000 apart from the name check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_converge_metric_rollup_rls(p_relation TEXT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rls    BOOLEAN;
  v_forced BOOLEAN;
  v_cmd    TEXT;
  v_policy TEXT;
  v_clause TEXT;
BEGIN
  IF p_relation IS NULL OR (
    p_relation !~ '^metric_rollups_y[0-9]{4}m[0-9]{2}(_(5m|1h|1d))?$'
    AND p_relation <> 'metric_rollups_default'
  ) THEN
    RAISE EXCEPTION 'breeze_converge_metric_rollup_rls: % is not a metric_rollups partition or leaf', p_relation;
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity INTO v_rls, v_forced
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = p_relation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'breeze_converge_metric_rollup_rls: % does not exist', p_relation;
  END IF;
  IF NOT v_rls THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_relation);
  END IF;
  IF NOT v_forced THEN
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', p_relation);
  END IF;

  FOREACH v_cmd IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    v_policy := 'breeze_org_isolation_' || lower(v_cmd);
    v_clause := CASE v_cmd
      WHEN 'INSERT' THEN 'WITH CHECK (public.breeze_has_org_access(org_id))'
      WHEN 'UPDATE' THEN 'USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))'
      ELSE 'USING (public.breeze_has_org_access(org_id))'
    END;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = p_relation AND p.policyname = v_policy
    ) THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR %s %s', v_policy, p_relation, v_cmd, v_clause);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app')
    AND NOT (
      has_table_privilege('breeze_app', format('public.%I', p_relation), 'SELECT')
      AND has_table_privilege('breeze_app', format('public.%I', p_relation), 'INSERT')
      AND has_table_privilege('breeze_app', format('public.%I', p_relation), 'UPDATE')
      AND has_table_privilege('breeze_app', format('public.%I', p_relation), 'DELETE')
    ) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO breeze_app', p_relation);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_converge_metric_rollup_rls(TEXT) FROM PUBLIC;

-- True while a drain table exists (a swap whose drain has not finished).
CREATE OR REPLACE FUNCTION public.breeze_metric_rollup_default_drain_exists()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'metric_rollups_staging' AND c.relname = 'metric_rollups_default_drain' AND c.relkind = 'r'
  );
$$;
REVOKE ALL ON FUNCTION public.breeze_metric_rollup_default_drain_exists() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 1. Swap the default out and create the months it was blocking.
--
-- p_months: the months the caller saw in the default (read beforehand, outside
-- this lock, so the scan never runs under ACCESS EXCLUSIVE). A month whose end
-- is at or before p_daily_cutoff is not created: all of its rows are expired
-- and the drain discards them. A month that appeared in the default between
-- the caller's read and this swap is not created; its rows re-route into the
-- new default during the move and the next run swaps again.
--
-- Locks: organizations and devices first (the order a cascading delete takes
-- them; detaching and creating a partition rewrites the FK triggers on them),
-- then metric_rollups. All are held for milliseconds — every step is catalog
-- work, the only scan is of the new, empty default.
--
-- Returns the months created. Refuses (55000) while an earlier drain is still
-- pending: the caller must finish that one first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_swap_metric_rollup_default(
  p_months TIMESTAMP[],
  p_daily_cutoff TIMESTAMP
)
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_month   TIMESTAMP;
  v_name    TEXT;
  v_created TEXT[] := ARRAY[]::TEXT[];
  v_con     RECORD;
BEGIN
  IF p_daily_cutoff IS NULL THEN
    RAISE EXCEPTION 'breeze_swap_metric_rollup_default: p_daily_cutoff must not be NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'metric_rollups_staging') THEN
    RAISE EXCEPTION 'breeze_swap_metric_rollup_default: schema metric_rollups_staging does not exist (see migration 2026-11-10-130000)'
      USING ERRCODE = '55000';
  END IF;
  IF public.breeze_metric_rollup_default_drain_exists() THEN
    RAISE EXCEPTION 'breeze_swap_metric_rollup_default: an earlier drain of metric_rollups_default is still pending'
      USING ERRCODE = '55000';
  END IF;
  IF NOT public.breeze_metric_rollup_is_attached('metric_rollups_default', 'metric_rollups') THEN
    RAISE EXCEPTION 'breeze_swap_metric_rollup_default: metric_rollups_default is not attached to metric_rollups'
      USING ERRCODE = '55000';
  END IF;

  LOCK TABLE public.organizations, public.devices IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.metric_rollups IN ACCESS EXCLUSIVE MODE;

  ALTER TABLE public.metric_rollups DETACH PARTITION public.metric_rollups_default;
  ALTER TABLE public.metric_rollups_default SET SCHEMA metric_rollups_staging;
  ALTER TABLE metric_rollups_staging.metric_rollups_default RENAME TO metric_rollups_default_drain;
  -- Drop the drain table's FKs now, under the locks this transaction already
  -- holds: dropping the table later would otherwise need ACCESS EXCLUSIVE on
  -- organizations and devices to remove their FK triggers, queueing every
  -- reader of devices behind it. Without them a device or org deleted during
  -- the drain cannot be blocked by (or cascade into) the drain table; the move
  -- discards rows whose device no longer exists instead (a device row always
  -- references a live org).
  FOR v_con IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'metric_rollups_staging.metric_rollups_default_drain'::regclass AND c.contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE metric_rollups_staging.metric_rollups_default_drain DROP CONSTRAINT %I', v_con.conname);
  END LOOP;

  CREATE TABLE public.metric_rollups_default PARTITION OF public.metric_rollups DEFAULT;
  PERFORM public.breeze_converge_metric_rollup_rls('metric_rollups_default');

  FOR v_month IN
    SELECT DISTINCT date_trunc('month', m) FROM unnest(coalesce(p_months, ARRAY[]::TIMESTAMP[])) AS m
    WHERE m IS NOT NULL
    ORDER BY 1
  LOOP
    IF v_month + INTERVAL '1 month' <= p_daily_cutoff THEN
      CONTINUE;
    END IF;
    v_name := format('metric_rollups_y%sm%s', to_char(v_month, 'YYYY'), to_char(v_month, 'MM'));
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = v_name) THEN
      CONTINUE;
    END IF;
    PERFORM public.breeze_create_metric_rollup_month(v_month);
    v_created := v_created || v_name;
  END LOOP;

  RETURN v_created;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Move one page range [p_from_page, p_from_page + p_pages) of the drain
-- table back through metric_rollups. Returns the next page to process (NULL
-- once past the end), rows re-inserted, and rows discarded (expired, or their
-- device was deleted while they sat in the drain table). A re-inserted row
-- takes its device's current org_id.
--
-- A row is kept when its bucket_start is at or after its bucket's cutoff. The
-- cutoffs come from the caller's retention settings, but are clamped to the
-- minimum retention floors (30 / 365 / 730 days), the same defense in depth as
-- the partition drops: a bad caller clock or config can never discard rows
-- that are still inside the floor.
--
-- Requires system scope: FORCE RLS binds this function's owner too, so outside
-- it the DELETE would see no rows and the move would silently do nothing — or,
-- worse, the re-insert would see a subset.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_drain_metric_rollup_default_batch(
  p_from_page BIGINT,
  p_pages INTEGER,
  p_cutoff_5m TIMESTAMP,
  p_cutoff_1h TIMESTAMP,
  p_cutoff_1d TIMESTAMP,
  OUT next_page BIGINT,
  OUT rows_moved BIGINT,
  OUT rows_discarded BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now         TIMESTAMP := now() AT TIME ZONE 'UTC';
  v_cut_5m      TIMESTAMP;
  v_cut_1h      TIMESTAMP;
  v_cut_1d      TIMESTAMP;
  v_total_pages BIGINT;
  v_to_page     BIGINT;
  v_cols        TEXT;
  v_select      TEXT;
  v_set         TEXT;
  v_batch       BIGINT;
BEGIN
  IF public.breeze_current_scope() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'breeze_drain_metric_rollup_default_batch: requires breeze.scope = system (RLS would hide rows from the move)'
      USING ERRCODE = '42501';
  END IF;
  IF p_from_page IS NULL OR p_from_page < 0 OR p_pages IS NULL OR p_pages < 1
    OR p_cutoff_5m IS NULL OR p_cutoff_1h IS NULL OR p_cutoff_1d IS NULL THEN
    RAISE EXCEPTION 'breeze_drain_metric_rollup_default_batch: invalid arguments' USING ERRCODE = '22023';
  END IF;

  rows_moved := 0;
  rows_discarded := 0;
  next_page := NULL;
  IF NOT public.breeze_metric_rollup_default_drain_exists() THEN
    RETURN;
  END IF;

  v_total_pages := pg_relation_size('metric_rollups_staging.metric_rollups_default_drain'::regclass)
    / current_setting('block_size')::BIGINT;
  IF p_from_page >= v_total_pages THEN
    RETURN;
  END IF;
  v_to_page := p_from_page + p_pages;

  v_cut_5m := least(p_cutoff_5m, v_now - INTERVAL '30 days');
  v_cut_1h := least(p_cutoff_1h, v_now - INTERVAL '365 days');
  v_cut_1d := least(p_cutoff_1d, v_now - INTERVAL '730 days');

  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
  FROM pg_attribute
  WHERE attrelid = 'public.metric_rollups'::regclass AND attnum > 0 AND NOT attisdropped;
  SELECT string_agg(CASE WHEN attname = 'org_id' THEN 'current_org_id' ELSE quote_ident(attname) END, ', ' ORDER BY attnum)
    INTO v_select
  FROM pg_attribute
  WHERE attrelid = 'public.metric_rollups'::regclass AND attnum > 0 AND NOT attisdropped;
  SELECT string_agg(format('%1$I = EXCLUDED.%1$I', attname), ', ' ORDER BY attnum) INTO v_set
  FROM pg_attribute
  WHERE attrelid = 'public.metric_rollups'::regclass AND attnum > 0 AND NOT attisdropped
    AND attname NOT IN ('org_id', 'source_table', 'device_id', 'metric_type', 'metric_name', 'bucket_seconds', 'bucket_start');

  EXECUTE format(
    $q$
      WITH batch AS (
        DELETE FROM metric_rollups_staging.metric_rollups_default_drain
        WHERE ctid >= %L::tid AND ctid < %L::tid
        RETURNING *
      ), keep AS (
        -- A row follows its device's CURRENT org: a device moved to another
        -- org while its rows sat in the drain table must not come back under
        -- the old org (the org move rewrote the live rows, not these).
        SELECT batch.*, d.org_id AS current_org_id
        FROM batch
        JOIN public.devices d ON d.id = batch.device_id
        WHERE batch.bucket_start >= CASE batch.bucket_seconds WHEN 300 THEN $1 WHEN 3600 THEN $2 ELSE $3 END
      ), moved AS (
        INSERT INTO public.metric_rollups AS live (%s)
        SELECT %s FROM keep
        ON CONFLICT (org_id, source_table, device_id, metric_type, metric_name, bucket_seconds, bucket_start)
        DO UPDATE SET %s WHERE live.updated_at < EXCLUDED.updated_at
      )
      -- The INSERT CTE runs whether or not it is referenced. rows_moved counts
      -- every retained row handed back to metric_rollups, including one that
      -- lost the updated_at tie-break to a newer live row (already current).
      SELECT (SELECT count(*) FROM batch), (SELECT count(*) FROM keep)
    $q$,
    format('(%s,0)', p_from_page), format('(%s,0)', v_to_page), v_cols, v_select, v_set
  )
  INTO v_batch, rows_moved
  USING v_cut_5m, v_cut_1h, v_cut_1d;

  rows_discarded := v_batch - rows_moved;
  next_page := CASE WHEN v_to_page >= v_total_pages THEN NULL ELSE v_to_page END;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Drop the drained table. Returns false when there is none. Refuses (55000)
-- while it still holds rows: those rows have not been moved yet.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_finish_metric_rollup_default_drain()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.breeze_current_scope() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'breeze_finish_metric_rollup_default_drain: requires breeze.scope = system (RLS would hide remaining rows)'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.breeze_metric_rollup_default_drain_exists() THEN
    RETURN FALSE;
  END IF;
  IF EXISTS (SELECT 1 FROM metric_rollups_staging.metric_rollups_default_drain) THEN
    RAISE EXCEPTION 'breeze_finish_metric_rollup_default_drain: the drain table still holds rows'
      USING ERRCODE = '55000';
  END IF;
  DROP TABLE metric_rollups_staging.metric_rollups_default_drain;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_swap_metric_rollup_default(TIMESTAMP[], TIMESTAMP) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_drain_metric_rollup_default_batch(BIGINT, INTEGER, TIMESTAMP, TIMESTAMP, TIMESTAMP) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_finish_metric_rollup_default_drain() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_metric_rollup_default_drain_exists() TO breeze_app;
    GRANT EXECUTE ON FUNCTION public.breeze_swap_metric_rollup_default(TIMESTAMP[], TIMESTAMP) TO breeze_app;
    GRANT EXECUTE ON FUNCTION public.breeze_drain_metric_rollup_default_batch(BIGINT, INTEGER, TIMESTAMP, TIMESTAMP, TIMESTAMP) TO breeze_app;
    GRANT EXECUTE ON FUNCTION public.breeze_finish_metric_rollup_default_drain() TO breeze_app;
  END IF;
END $$;
