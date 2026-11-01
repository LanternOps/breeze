-- ---------------------------------------------------------------------------
-- #10829: legacy-month compaction deadlocked live requests.
--
-- Two steps of the compaction take ACCESS EXCLUSIVE on the tables that
-- metric_rollups references by FK (devices, organizations):
--
--   * breeze_prepare_metric_rollup_compaction drops a stage left by an earlier
--     run whose compaction never committed. DROP TABLE on a table that holds
--     FKs takes ACCESS EXCLUSIVE on every referenced table, one after the
--     other, so the prepare held organizations while it waited for devices.
--   * breeze_compact_metric_rollup_partition's cutover LOCK TABLE (and its DROP
--     of the flat month, which holds the same FKs).
--
-- Request paths read devices and then organizations (the agent auth lookup's
-- sub-select, the device_metrics FK check). Waiting for those locks in line
-- made the maintenance job one side of a deadlock, and Postgres cancelled the
-- requests: 22 and 17 `deadlock detected` per night on a 235-device install,
-- each a failed agent request. The caller's lock_timeout (5 s) never fires
-- first, because deadlock_timeout (1 s) does. Every failed compaction also
-- left its stage behind, so the next night's prepare paid the drop again.
--
-- Both steps now take those locks up front, all at once, with NOWAIT, retried
-- in a subtransaction (breeze_metric_rollup_lock_nowait). A NOWAIT request
-- never waits, so it can never be part of a deadlock and never queues readers
-- behind it; a failed attempt's subtransaction releases whatever it did get,
-- so nothing is held between attempts. If the locks cannot be had within the
-- retry budget the step raises lock_not_available, the job records the
-- failure, and the next run tries again: a slow compaction, never a cancelled
-- request. When no stage has to be dropped, the prepare takes SHARE ROW
-- EXCLUSIVE, which is all ADD FOREIGN KEY ... NOT VALID needs.
--
-- breeze_drop_metric_rollup_partition gets the same treatment when it drops a
-- stranded stage. Dropping an attached month or bucket leaf takes no lock on
-- the referenced tables, so the plain retention drop is unchanged.
--
-- Bodies are otherwise unchanged from 2026-11-10-130000.
-- ---------------------------------------------------------------------------

-- Lock p_relations in p_mode without ever waiting. Retries a bounded number of
-- times; each attempt is a subtransaction, so a partial grab is released
-- before the next one. Called only from the SECURITY DEFINER maintenance
-- functions below, so it runs with their owner's privileges.
CREATE OR REPLACE FUNCTION public.breeze_metric_rollup_lock_nowait(
  p_relations REGCLASS[],
  p_mode TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_attempts CONSTANT INTEGER := 100;
  v_sleep    CONSTANT DOUBLE PRECISION := 0.1;
  v_list     TEXT;
  v_attempt  INTEGER;
BEGIN
  IF p_mode NOT IN ('SHARE ROW EXCLUSIVE', 'ACCESS EXCLUSIVE') THEN
    RAISE EXCEPTION 'breeze_metric_rollup_lock_nowait: unsupported lock mode %', p_mode
      USING ERRCODE = '22023';
  END IF;
  IF p_relations IS NULL OR cardinality(p_relations) = 0 THEN
    RETURN;
  END IF;
  SELECT string_agg(r::text, ', ' ORDER BY ord) INTO v_list
  FROM unnest(p_relations) WITH ORDINALITY AS t(r, ord);

  FOR v_attempt IN 1..v_attempts LOOP
    BEGIN
      EXECUTE format('LOCK TABLE %s IN %s MODE NOWAIT', v_list, p_mode);
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF v_attempt = v_attempts THEN
        RAISE EXCEPTION 'breeze_metric_rollup_lock_nowait: could not lock % in % mode without waiting after % attempts; the next maintenance run retries',
          v_list, p_mode, v_attempts
          USING ERRCODE = '55P03';
      END IF;
      PERFORM pg_sleep(v_sleep);
    END;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_metric_rollup_lock_nowait(REGCLASS[], TEXT) FROM PUBLIC;

-- The tables metric_rollups references by FK (devices, organizations), in a
-- fixed order. Derived from the catalog so a new FK is covered too.
CREATE OR REPLACE FUNCTION public.breeze_metric_rollup_fk_referenced()
RETURNS REGCLASS[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT array_agg(r ORDER BY r::text)
  FROM (
    SELECT DISTINCT c.confrelid::regclass AS r
    FROM pg_constraint c
    WHERE c.conrelid = 'public.metric_rollups'::regclass AND c.contype = 'f'
  ) refs;
$$;
REVOKE ALL ON FUNCTION public.breeze_metric_rollup_fk_referenced() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.breeze_prepare_metric_rollup_compaction(
  p_month_start TIMESTAMP,
  p_keep_hourly BOOLEAN
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_target    RECORD;
  v_bucket    INTEGER;
  v_leaf      TEXT;
  v_def       TEXT;
  v_new_def   TEXT;
  v_con       RECORD;
  v_need_drop BOOLEAN;
BEGIN
  SELECT * INTO v_target FROM public.breeze_metric_rollup_compaction_target(p_month_start, p_keep_hourly);
  IF NOT public.breeze_metric_rollup_is_legacy_month(v_target.o_name) THEN
    RETURN NULL;
  END IF;

  -- #10829: every lock this transaction needs on the FK-referenced tables, up
  -- front and without waiting. Dropping a stage takes ACCESS EXCLUSIVE on
  -- them; adding the NOT VALID FKs needs SHARE ROW EXCLUSIVE.
  v_need_drop := NOT p_keep_hourly AND public.breeze_metric_rollup_is_staged_leaf(v_target.o_name || '_1h');
  FOREACH v_bucket IN ARRAY v_target.o_keep LOOP
    v_need_drop := v_need_drop OR public.breeze_metric_rollup_is_staged_leaf(
      v_target.o_name || '_' || public.breeze_metric_rollup_bucket_suffix(v_bucket)
    );
  END LOOP;
  PERFORM public.breeze_metric_rollup_lock_nowait(
    public.breeze_metric_rollup_fk_referenced(),
    CASE WHEN v_need_drop THEN 'ACCESS EXCLUSIVE' ELSE 'SHARE ROW EXCLUSIVE' END
  );

  -- A staged hourly leaf from an earlier run that no longer needs one.
  IF NOT p_keep_hourly AND public.breeze_metric_rollup_is_staged_leaf(v_target.o_name || '_1h') THEN
    EXECUTE format('DROP TABLE metric_rollups_staging.%I', v_target.o_name || '_1h');
  END IF;

  FOREACH v_bucket IN ARRAY v_target.o_keep LOOP
    v_leaf := v_target.o_name || '_' || public.breeze_metric_rollup_bucket_suffix(v_bucket);
    IF public.breeze_metric_rollup_is_staged_leaf(v_leaf) THEN
      -- Staged by an earlier run whose compaction rolled back. Rebuild it
      -- rather than reuse it: if metric_rollups gained a column, index or FK
      -- since, a reused stage would no longer match the parent and every
      -- later ATTACH would fail. This is the short prepare transaction, so the
      -- extra FK lock is milliseconds.
      EXECUTE format('DROP TABLE metric_rollups_staging.%I', v_leaf);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = v_leaf) THEN
      RAISE EXCEPTION 'metric_rollups compaction: public.% already exists', v_leaf;
    END IF;

    EXECUTE format(
      'CREATE TABLE metric_rollups_staging.%I (LIKE public.metric_rollups INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',
      v_leaf
    );
    EXECUTE format(
      'ALTER TABLE metric_rollups_staging.%I ADD CONSTRAINT %I CHECK (bucket_seconds = %s AND bucket_start >= %L::timestamp AND bucket_start < %L::timestamp)',
      v_leaf, v_leaf || '_bounds_chk', v_bucket, v_target.o_start, v_target.o_end
    );

    -- The parent's indexes, so ATTACH adopts them instead of building them
    -- under the cutover lock. pg_get_indexdef renders a partitioned index as
    -- `CREATE [UNIQUE] INDEX <name> ON ONLY public.metric_rollups USING ...`.
    FOR v_def IN
      SELECT pg_get_indexdef(i.indexrelid)
      FROM pg_index i
      WHERE i.indrelid = 'public.metric_rollups'::regclass
    LOOP
      v_new_def := regexp_replace(
        v_def,
        '^CREATE (UNIQUE )?INDEX \S+ ON ONLY public\.metric_rollups ',
        'CREATE \1INDEX ON metric_rollups_staging.' || quote_ident(v_leaf) || ' '
      );
      IF v_new_def = v_def THEN
        RAISE EXCEPTION 'metric_rollups compaction: cannot re-target index definition %', v_def;
      END IF;
      EXECUTE v_new_def;
    END LOOP;

    -- The parent's FKs, NOT VALID: validated after the copy, under ROW SHARE.
    FOR v_con IN
      SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      WHERE c.conrelid = 'public.metric_rollups'::regclass AND c.contype = 'f'
    LOOP
      EXECUTE format('ALTER TABLE metric_rollups_staging.%I ADD CONSTRAINT %I %s NOT VALID', v_leaf, v_con.conname, v_con.def);
    END LOOP;
  END LOOP;

  RETURN v_target.o_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_compact_metric_rollup_partition(
  p_month_start TIMESTAMP,
  p_keep_hourly BOOLEAN
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_target RECORD;
  v_bucket INTEGER;
  v_leaf   TEXT;
  v_cols   TEXT;
  v_con    RECORD;
BEGIN
  -- FORCE RLS binds this function's owner too: outside system scope the copy
  -- would silently see zero rows and the month would be dropped with its
  -- retained data.
  IF public.breeze_current_scope() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'breeze_compact_metric_rollup_partition: requires breeze.scope = system (RLS would hide rows from the copy)'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_target FROM public.breeze_metric_rollup_compaction_target(p_month_start, p_keep_hourly);
  IF NOT public.breeze_metric_rollup_is_legacy_month(v_target.o_name) THEN
    RETURN NULL;
  END IF;
  FOREACH v_bucket IN ARRAY v_target.o_keep LOOP
    v_leaf := v_target.o_name || '_' || public.breeze_metric_rollup_bucket_suffix(v_bucket);
    IF NOT public.breeze_metric_rollup_is_staged_leaf(v_leaf) THEN
      RAISE EXCEPTION 'breeze_compact_metric_rollup_partition: % is not staged; call breeze_prepare_metric_rollup_compaction first', v_leaf
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- a. Freeze writes to this month only.
  EXECUTE format('LOCK TABLE public.%I IN SHARE MODE', v_target.o_name);

  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
  FROM pg_attribute
  WHERE attrelid = 'public.metric_rollups'::regclass AND attnum > 0 AND NOT attisdropped;

  -- b. Copy the retained buckets, then validate the FKs.
  FOREACH v_bucket IN ARRAY v_target.o_keep LOOP
    v_leaf := v_target.o_name || '_' || public.breeze_metric_rollup_bucket_suffix(v_bucket);
    EXECUTE format('TRUNCATE TABLE metric_rollups_staging.%I', v_leaf);
    EXECUTE format(
      'INSERT INTO metric_rollups_staging.%I (%s) SELECT %s FROM public.%I WHERE bucket_seconds = %s',
      v_leaf, v_cols, v_cols, v_target.o_name, v_bucket
    );
    FOR v_con IN
      SELECT c.conname FROM pg_constraint c
      WHERE c.conrelid = format('metric_rollups_staging.%I', v_leaf)::regclass AND c.contype = 'f' AND NOT c.convalidated
    LOOP
      EXECUTE format('ALTER TABLE metric_rollups_staging.%I VALIDATE CONSTRAINT %I', v_leaf, v_con.conname);
    END LOOP;
  END LOOP;

  -- c. Cutover, never waiting in line (#10829). Referenced tables first, as a
  -- cascading delete takes them.
  PERFORM public.breeze_metric_rollup_lock_nowait(
    ARRAY['public.organizations', 'public.devices', 'public.metric_rollups']::regclass[],
    'ACCESS EXCLUSIVE'
  );
  EXECUTE format('DROP TABLE public.%I', v_target.o_name);
  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.metric_rollups FOR VALUES FROM (%L) TO (%L) PARTITION BY LIST (bucket_seconds)',
    v_target.o_name, v_target.o_start, v_target.o_end
  );
  PERFORM public.breeze_converge_metric_rollup_rls(v_target.o_name);
  FOREACH v_bucket IN ARRAY v_target.o_keep LOOP
    v_leaf := v_target.o_name || '_' || public.breeze_metric_rollup_bucket_suffix(v_bucket);
    EXECUTE format('ALTER TABLE metric_rollups_staging.%I SET SCHEMA public', v_leaf);
    EXECUTE format('ALTER TABLE public.%I ATTACH PARTITION public.%I FOR VALUES IN (%s)', v_target.o_name, v_leaf, v_bucket);
    PERFORM public.breeze_converge_metric_rollup_rls(v_leaf);
  END LOOP;

  RETURN v_target.o_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.breeze_drop_metric_rollup_partition(
  p_month_start TIMESTAMP
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_start    TIMESTAMP;
  v_name     TEXT;
  v_staged   BOOLEAN;
  v_attached BOOLEAN;
BEGIN
  IF p_month_start IS NULL THEN
    RAISE EXCEPTION 'breeze_drop_metric_rollup_partition: p_month_start must not be NULL';
  END IF;

  v_start := date_trunc('month', p_month_start);
  IF v_start + INTERVAL '1 month' > (now() AT TIME ZONE 'UTC') - INTERVAL '730 days' THEN
    RAISE EXCEPTION 'breeze_drop_metric_rollup_partition: month % is still inside the minimum 730 day daily retention', v_start
      USING ERRCODE = '22023';
  END IF;

  v_name := format('metric_rollups_y%sm%s', to_char(v_start, 'YYYY'), to_char(v_start, 'MM'));

  v_staged := public.breeze_metric_rollup_is_staged_leaf(v_name || '_1h')
           OR public.breeze_metric_rollup_is_staged_leaf(v_name || '_1d');
  v_attached := public.breeze_metric_rollup_is_attached(v_name, 'metric_rollups');
  IF NOT v_staged AND NOT v_attached THEN
    RETURN NULL;
  END IF;

  -- #10829: a stage is a standalone table holding its own FKs, so dropping it
  -- takes ACCESS EXCLUSIVE on the FK-referenced tables. Take them up front,
  -- without waiting. Dropping an attached month does not touch them (its FKs
  -- are partition clones), so a plain retention drop takes no extra lock.
  IF v_staged THEN
    PERFORM public.breeze_metric_rollup_lock_nowait(
      public.breeze_metric_rollup_fk_referenced(),
      'ACCESS EXCLUSIVE'
    );
  END IF;

  -- Staged compaction leaves for this month (a prepare whose compaction never
  -- committed) are empty but would otherwise be stranded forever.
  IF public.breeze_metric_rollup_is_staged_leaf(v_name || '_1h') THEN
    EXECUTE format('DROP TABLE metric_rollups_staging.%I', v_name || '_1h');
  END IF;
  IF public.breeze_metric_rollup_is_staged_leaf(v_name || '_1d') THEN
    EXECUTE format('DROP TABLE metric_rollups_staging.%I', v_name || '_1d');
  END IF;

  IF NOT v_attached THEN
    RETURN NULL;
  END IF;

  EXECUTE format('DROP TABLE IF EXISTS public.%I', v_name);
  RETURN v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_drop_metric_rollup_partition(TIMESTAMP) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_prepare_metric_rollup_compaction(TIMESTAMP, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_compact_metric_rollup_partition(TIMESTAMP, BOOLEAN) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_drop_metric_rollup_partition(TIMESTAMP) TO breeze_app;
    GRANT EXECUTE ON FUNCTION public.breeze_prepare_metric_rollup_compaction(TIMESTAMP, BOOLEAN) TO breeze_app;
    GRANT EXECUTE ON FUNCTION public.breeze_compact_metric_rollup_partition(TIMESTAMP, BOOLEAN) TO breeze_app;
  END IF;
END $$;
