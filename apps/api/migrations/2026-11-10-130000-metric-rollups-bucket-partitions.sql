-- #7531: enforce each metric_rollups bucket size's retention by dropping a
-- partition, never by row DELETE.
--
-- Before: metric_rollups is RANGE (bucket_start) with one FLAT monthly
-- partition holding 300s, 3600s and 86400s buckets together. A month was only
-- dropped at the daily cutoff (>= 730 days); 5-minute and hourly rows (~92% of
-- the volume) were trimmed by a capped row DELETE. A DELETE frees space inside
-- an old month that new writes (which go to the current month) never reuse, so
-- disk grew ~8 GB/month per 100 agents and was never returned.
--
-- After: each monthly partition is itself PARTITION BY LIST (bucket_seconds)
-- with three leaves:
--
--   metric_rollups                       RANGE (bucket_start)   (unchanged)
--   ├─ metric_rollups_default            DEFAULT                (unchanged)
--   └─ metric_rollups_yYYYYmMM           LIST (bucket_seconds)
--      ├─ metric_rollups_yYYYYmMM_5m     IN (300)
--      ├─ metric_rollups_yYYYYmMM_1h     IN (3600)
--      └─ metric_rollups_yYYYYmMM_1d     IN (86400)
--
-- The parent, its name, indexes, unique key, FKs and RLS are unchanged, so no
-- reader changes and the tenant cascade / export / merge registries (which
-- list only metric_rollups + metric_rollups_default) are unaffected. Retention
-- drops the `_5m` leaf once the whole month is past the 5-minute cutoff, the
-- `_1h` leaf past the hourly cutoff, and the whole month past the daily one.
--
-- Existing installs (legacy flat months):
--   * EMPTY flat months (the ones pre-created up to 3 months ahead) are
--     converted to the new shape right here, and by the ensure function below
--     whenever it meets one. "Empty" is decided by pg_relation_size() = 0 — no
--     heap pages at all — so it cannot be fooled by RLS hiding rows.
--   * Flat months WITH data (the current month and older) stay flat and keep
--     working. Once a month's 5-minute rows are past retention the daily
--     maintenance job rewrites it with breeze_compact_metric_rollup_partition:
--     only the still-retained hourly/daily rows (~8% of the month) are copied
--     into new leaves, then the old flat table is dropped, which returns its
--     whole footprint (including the bloat left by the old row DELETEs) to the
--     OS. See that function for the lock profile.
--
-- breeze_app cannot run DDL, so every structural change goes through a
-- SECURITY DEFINER function that takes a month (and a bucket size), derives
-- every identifier itself and verifies attachment via pg_inherits before
-- touching anything (precedent: 2026-08-05 and topology_interface_samples).
--
-- Writes no rows (DDL only). Idempotent throughout. autoMigrate wraps this
-- file in a transaction.

-- ---------------------------------------------------------------------------
-- Bucket size -> leaf suffix. The single mapping every function below uses.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_metric_rollup_bucket_suffix(p_bucket_seconds INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN CASE p_bucket_seconds
    WHEN 300 THEN '5m'
    WHEN 3600 THEN '1h'
    WHEN 86400 THEN '1d'
    ELSE NULL
  END;
END;
$$;

-- ---------------------------------------------------------------------------
-- Relation-local RLS + grant convergence for a month partition or a leaf.
-- NOT callable by breeze_app (it takes an identifier); only the SECURITY
-- DEFINER entry points below call it, with names they derived themselves.
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
  IF p_relation IS NULL OR p_relation !~ '^metric_rollups_y[0-9]{4}m[0-9]{2}(_(5m|1h|1d))?$' THEN
    RAISE EXCEPTION 'breeze_converge_metric_rollup_rls: % is not a metric_rollups month partition or leaf', p_relation;
  END IF;

  -- Only issue DDL that changes something: every ALTER/CREATE POLICY takes
  -- ACCESS EXCLUSIVE on the relation, and the daily ensure converges the hot
  -- current month, so a no-op run must take no lock at all.
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

-- ---------------------------------------------------------------------------
-- Is `p_child` attached directly under `p_parent` (both in public)?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_metric_rollup_is_attached(p_child TEXT, p_parent TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_inherits
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE child.relname = p_child
      AND child_ns.nspname = 'public'
      AND parent.relname = p_parent
      AND parent_ns.nspname = 'public'
  );
$$;
REVOKE ALL ON FUNCTION public.breeze_metric_rollup_is_attached(TEXT, TEXT) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Create one month in the per-bucket shape (sub-parent + three leaves), fully
-- converged. Owner-only helper: callers pass a normalized month start.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_create_metric_rollup_month(p_month_start TIMESTAMP)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_start  TIMESTAMP := date_trunc('month', p_month_start);
  v_end    TIMESTAMP := date_trunc('month', p_month_start) + INTERVAL '1 month';
  v_name   TEXT := format('metric_rollups_y%sm%s', to_char(date_trunc('month', p_month_start), 'YYYY'), to_char(date_trunc('month', p_month_start), 'MM'));
  v_bucket INTEGER;
  v_leaf   TEXT;
BEGIN
  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.metric_rollups FOR VALUES FROM (%L) TO (%L) PARTITION BY LIST (bucket_seconds)',
    v_name, v_start, v_end
  );
  PERFORM public.breeze_converge_metric_rollup_rls(v_name);
  FOREACH v_bucket IN ARRAY ARRAY[300, 3600, 86400] LOOP
    v_leaf := v_name || '_' || public.breeze_metric_rollup_bucket_suffix(v_bucket);
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES IN (%s)',
      v_leaf, v_name, v_bucket
    );
    PERFORM public.breeze_converge_metric_rollup_rls(v_leaf);
  END LOOP;
  RETURN v_name;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_create_metric_rollup_month(TIMESTAMP) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Ensure one month exists (replaces the 2026-08-05 definition, same
-- signature, same NULL-means-skipped contract).
--   * missing           -> create it in the per-bucket shape.
--   * per-bucket shape  -> re-converge RLS on the month and its leaves. Never
--                          recreates a leaf that retention already dropped.
--   * legacy flat, EMPTY (no heap pages at all, so RLS cannot hide a row from
--     the check) -> convert to the per-bucket shape. That is a DROP of an
--     empty partition plus CREATEs: metadata only, but it needs ACCESS
--     EXCLUSIVE on metric_rollups. The wait is bounded (5 s); on timeout, or if
--     metric_rollups_default holds rows for the month, the conversion is rolled
--     back and the month stays flat (still fully functional) with a WARNING,
--     to be retried on the next run. It can therefore never fail a boot.
--   * legacy flat with data -> converged and left alone; the maintenance job
--     compacts it once its 5-minute rows are past retention.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_ensure_metric_rollup_partition(
  p_month_start TIMESTAMP
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_start  TIMESTAMP;
  v_end    TIMESTAMP;
  v_name   TEXT;
  v_kind   "char";
  v_oid    OID;
  v_leaf   TEXT;
  v_prior_lock_timeout TEXT;
BEGIN
  IF p_month_start IS NULL THEN
    RAISE EXCEPTION 'breeze_ensure_metric_rollup_partition: p_month_start must not be NULL';
  END IF;

  v_start := date_trunc('month', p_month_start);
  v_end   := v_start + INTERVAL '1 month';
  v_name  := format('metric_rollups_y%sm%s', to_char(v_start, 'YYYY'), to_char(v_start, 'MM'));

  SELECT c.oid, c.relkind INTO v_oid, v_kind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = v_name;

  IF v_oid IS NOT NULL AND NOT public.breeze_metric_rollup_is_attached(v_name, 'metric_rollups') THEN
    RAISE EXCEPTION '% exists but is not attached as a metric_rollups partition', v_name;
  END IF;

  IF v_oid IS NULL THEN
    BEGIN
      PERFORM public.breeze_create_metric_rollup_month(v_start);
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM LIKE '%updated partition constraint for default partition%'
        AND SQLERRM LIKE '%would be violated by some row%' THEN
        RAISE WARNING
          'Skipping %, metric_rollups_default already contains rows for [% - %)',
          v_name, v_start, v_end;
        RETURN NULL;
      END IF;
      RAISE;
    END;
    RETURN v_name;
  END IF;

  IF v_kind = 'p' THEN
    PERFORM public.breeze_converge_metric_rollup_rls(v_name);
    FOR v_leaf IN
      SELECT child.relname
      FROM pg_inherits
      JOIN pg_class child ON child.oid = pg_inherits.inhrelid
      WHERE pg_inherits.inhparent = v_oid
        AND child.relname ~ '^metric_rollups_y[0-9]{4}m[0-9]{2}_(5m|1h|1d)$'
    LOOP
      PERFORM public.breeze_converge_metric_rollup_rls(v_leaf);
    END LOOP;
    RETURN v_name;
  END IF;

  -- Legacy flat month.
  IF pg_relation_size(v_oid) = 0 THEN
    v_prior_lock_timeout := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout', '5s', true);
    BEGIN
      -- Root first, as every INSERT takes it, so this cannot invert lock order
      -- with a writer routing into the month.
      LOCK TABLE public.metric_rollups IN ACCESS EXCLUSIVE MODE;
      -- Re-check under the lock: a row may have landed before we got it.
      IF pg_relation_size(v_oid) = 0 THEN
        EXECUTE format('DROP TABLE public.%I', v_name);
        PERFORM public.breeze_create_metric_rollup_month(v_start);
        PERFORM set_config('lock_timeout', v_prior_lock_timeout, true);
        RETURN v_name;
      END IF;
    EXCEPTION
      WHEN lock_not_available THEN
        RAISE WARNING
          'breeze_ensure_metric_rollup_partition: could not lock metric_rollups within 5s to convert empty legacy month %; it stays flat until the next run',
          v_name;
      WHEN check_violation THEN
        RAISE WARNING
          'breeze_ensure_metric_rollup_partition: metric_rollups_default holds rows for %; it stays flat',
          v_name;
    END;
    PERFORM set_config('lock_timeout', v_prior_lock_timeout, true);
  END IF;

  PERFORM public.breeze_converge_metric_rollup_rls(v_name);
  RETURN v_name;
END;
$$;

-- ---------------------------------------------------------------------------
-- Drop one expired bucket leaf of a per-bucket month. Takes the month and the
-- bucket size, never a name. Refuses a month still inside that bucket's
-- MINIMUM retention (METRIC_ROLLUP_5M/HOURLY_RETENTION_DAYS floors: 30/365
-- days) as defense in depth against a bad caller clock or config. Daily
-- buckets are removed with the whole month (breeze_drop_metric_rollup_partition).
-- Returns the dropped leaf, or NULL when nothing is attached for it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_drop_metric_rollup_bucket_partition(
  p_month_start TIMESTAMP,
  p_bucket_seconds INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_start TIMESTAMP;
  v_end   TIMESTAMP;
  v_name  TEXT;
  v_leaf  TEXT;
  v_floor INTERVAL;
BEGIN
  IF p_month_start IS NULL OR p_bucket_seconds IS NULL THEN
    RAISE EXCEPTION 'breeze_drop_metric_rollup_bucket_partition: arguments must not be NULL';
  END IF;
  v_floor := CASE p_bucket_seconds WHEN 300 THEN INTERVAL '30 days' WHEN 3600 THEN INTERVAL '365 days' END;
  IF v_floor IS NULL THEN
    RAISE EXCEPTION 'breeze_drop_metric_rollup_bucket_partition: unsupported bucket_seconds %', p_bucket_seconds
      USING ERRCODE = '22023';
  END IF;

  v_start := date_trunc('month', p_month_start);
  v_end   := v_start + INTERVAL '1 month';
  IF v_end > (now() AT TIME ZONE 'UTC') - v_floor THEN
    RAISE EXCEPTION 'breeze_drop_metric_rollup_bucket_partition: month % is still inside the minimum % retention for % s buckets',
      v_start, v_floor, p_bucket_seconds
      USING ERRCODE = '22023';
  END IF;

  v_name := format('metric_rollups_y%sm%s', to_char(v_start, 'YYYY'), to_char(v_start, 'MM'));
  v_leaf := v_name || '_' || public.breeze_metric_rollup_bucket_suffix(p_bucket_seconds);
  IF NOT public.breeze_metric_rollup_is_attached(v_name, 'metric_rollups')
    OR NOT public.breeze_metric_rollup_is_attached(v_leaf, v_name) THEN
    RETURN NULL;
  END IF;

  EXECUTE format('DROP TABLE public.%I', v_leaf);
  RETURN v_leaf;
END;
$$;

-- ---------------------------------------------------------------------------
-- Compacting a LEGACY flat month whose 5-minute rows are past retention.
--
-- The month is rewritten into the per-bucket shape, copying only the
-- still-retained buckets (hourly when p_keep_hourly, and daily: ~8% of the
-- month), and the old flat table is dropped, which returns its whole footprint
-- (including the dead space the old row DELETEs left behind) to the OS.
--
-- Two calls, each in its OWN transaction (the maintenance job does this):
--
--   1. breeze_prepare_metric_rollup_compaction: creates the future leaves as
--      EMPTY standalone tables in schema metric_rollups_staging with the
--      parent's CHECKs, a CHECK implying the
--      leaf's partition bounds, the parent's indexes, and the parent's FKs as
--      NOT VALID. Adding an FK takes SHARE ROW EXCLUSIVE on devices and
--      organizations; doing it on an empty table in a short transaction of its
--      own releases that lock within milliseconds instead of holding it for
--      the whole copy.
--   2. breeze_compact_metric_rollup_partition:
--        a. SHARE on the legacy month only: every read continues, writes to
--           this months-old month wait. Tenant cascade/merge writes to it
--           therefore serialise with the copy instead of racing it.
--        b. INSERT the retained buckets into the leaves (the NOT VALID FKs are
--           still enforced per row, taking only row KEY SHARE locks), then
--           VALIDATE the FKs (ROW SHARE on devices/organizations: their
--           writers are not blocked).
--        c. Cutover: ACCESS EXCLUSIVE on organizations, devices and
--           metric_rollups (bounded by the caller's lock_timeout), DROP the
--           flat month, CREATE the empty sub-parent, move the leaves into
--           public and ATTACH them. ATTACH
--           adopts the pre-built indexes and the validated FKs (it replaces
--           the leaves' own FK triggers, hence the lock on the referenced
--           tables) and the bounds CHECK lets it skip the validation scan.
--           CREATE ... PARTITION OF still scans metric_rollups_default for
--           rows in the month, exactly as creating any month does today.
--           Then converge RLS/policies/grants and commit.
--
-- Everything in 2 is one transaction, so a failure (lock timeout, deadlock)
-- rolls back to the untouched flat month and the job retries the next day.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_metric_rollup_compaction_target(
  p_month_start TIMESTAMP,
  p_keep_hourly BOOLEAN,
  OUT o_start TIMESTAMP,
  OUT o_end TIMESTAMP,
  OUT o_name TEXT,
  OUT o_keep INTEGER[]
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_month_start IS NULL OR p_keep_hourly IS NULL THEN
    RAISE EXCEPTION 'metric_rollups compaction: arguments must not be NULL';
  END IF;
  o_start := date_trunc('month', p_month_start);
  o_end   := o_start + INTERVAL '1 month';
  -- Defense in depth against a bad caller clock or config: never below the
  -- METRIC_ROLLUP_5M/HOURLY_RETENTION_DAYS floors (30 / 365 days).
  IF o_end > (now() AT TIME ZONE 'UTC') - INTERVAL '30 days' THEN
    RAISE EXCEPTION 'metric_rollups compaction: month % is still inside the minimum 30 day 5-minute retention', o_start
      USING ERRCODE = '22023';
  END IF;
  IF NOT p_keep_hourly AND o_end > (now() AT TIME ZONE 'UTC') - INTERVAL '365 days' THEN
    RAISE EXCEPTION 'metric_rollups compaction: month % is still inside the minimum 365 day hourly retention', o_start
      USING ERRCODE = '22023';
  END IF;
  o_name := format('metric_rollups_y%sm%s', to_char(o_start, 'YYYY'), to_char(o_start, 'MM'));
  o_keep := CASE WHEN p_keep_hourly THEN ARRAY[3600, 86400] ELSE ARRAY[86400] END;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_metric_rollup_compaction_target(TIMESTAMP, BOOLEAN) FROM PUBLIC;

-- True when `p_name` is an attached, flat (relkind 'r') metric_rollups month.
CREATE OR REPLACE FUNCTION public.breeze_metric_rollup_is_legacy_month(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = p_name AND c.relkind = 'r'
  ) AND public.breeze_metric_rollup_is_attached(p_name, 'metric_rollups');
$$;
REVOKE ALL ON FUNCTION public.breeze_metric_rollup_is_legacy_month(TEXT) FROM PUBLIC;

-- Staged leaves live in their own schema until the cutover moves them into
-- public. Not public, because a standalone org_id table in public that no
-- schema declares makes the extension tenancy tripwire
-- (extensions/tenancyTripwire.ts assertNoUnaccountedPublicTables) refuse to
-- boot, and a staged leaf outlives a compaction that rolled back until the
-- next run. Owner-only: nothing but these functions touches it.
CREATE SCHEMA IF NOT EXISTS metric_rollups_staging;
REVOKE ALL ON SCHEMA metric_rollups_staging FROM PUBLIC;

-- A standalone table in metric_rollups_staging named like one of this month's
-- leaves: left by a prepare step whose compaction has not committed yet.
CREATE OR REPLACE FUNCTION public.breeze_metric_rollup_is_staged_leaf(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'metric_rollups_staging' AND c.relname = p_name AND c.relkind = 'r' AND NOT c.relispartition
  );
$$;
REVOKE ALL ON FUNCTION public.breeze_metric_rollup_is_staged_leaf(TEXT) FROM PUBLIC;

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
  v_target  RECORD;
  v_bucket  INTEGER;
  v_leaf    TEXT;
  v_def     TEXT;
  v_new_def TEXT;
  v_con     RECORD;
BEGIN
  SELECT * INTO v_target FROM public.breeze_metric_rollup_compaction_target(p_month_start, p_keep_hourly);
  IF NOT public.breeze_metric_rollup_is_legacy_month(v_target.o_name) THEN
    RETURN NULL;
  END IF;

  -- A staged hourly leaf from an earlier run that no longer needs one.
  IF NOT p_keep_hourly AND public.breeze_metric_rollup_is_staged_leaf(v_target.o_name || '_1h') THEN
    EXECUTE format('DROP TABLE metric_rollups_staging.%I', v_target.o_name || '_1h');
  END IF;

  FOREACH v_bucket IN ARRAY v_target.o_keep LOOP
    v_leaf := v_target.o_name || '_' || public.breeze_metric_rollup_bucket_suffix(v_bucket);
    IF public.breeze_metric_rollup_is_staged_leaf(v_leaf) THEN
      -- Staged by an earlier run whose compaction rolled back: reuse it. A
      -- rolled-back copy leaves no visible rows; TRUNCATE also drops the dead
      -- ones. Re-creating it would re-take the FK lock for nothing.
      EXECUTE format('TRUNCATE TABLE metric_rollups_staging.%I', v_leaf);
      CONTINUE;
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

  -- c. Cutover. Referenced tables first, as a cascading delete takes them.
  LOCK TABLE public.organizations, public.devices, public.metric_rollups IN ACCESS EXCLUSIVE MODE;
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

-- ---------------------------------------------------------------------------
-- Drop one expired month (replaces the 2026-08-05 definition, same signature
-- and contract). Works for both shapes: dropping the per-bucket sub-parent
-- drops its leaves. New here: it refuses a month still inside the minimum
-- daily retention (METRIC_ROLLUP_DAILY_RETENTION_DAYS floor, 730 days), the
-- same defense in depth as the bucket-leaf drop.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_drop_metric_rollup_partition(
  p_month_start TIMESTAMP
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_start TIMESTAMP;
  v_name  TEXT;
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
  IF NOT public.breeze_metric_rollup_is_attached(v_name, 'metric_rollups') THEN
    RETURN NULL;
  END IF;

  EXECUTE format('DROP TABLE IF EXISTS public.%I', v_name);
  RETURN v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_ensure_metric_rollup_partition(TIMESTAMP) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_drop_metric_rollup_partition(TIMESTAMP) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_drop_metric_rollup_bucket_partition(TIMESTAMP, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_prepare_metric_rollup_compaction(TIMESTAMP, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_compact_metric_rollup_partition(TIMESTAMP, BOOLEAN) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_ensure_metric_rollup_partition(TIMESTAMP) TO breeze_app;
    GRANT EXECUTE ON FUNCTION public.breeze_drop_metric_rollup_partition(TIMESTAMP) TO breeze_app;
    GRANT EXECUTE ON FUNCTION public.breeze_drop_metric_rollup_bucket_partition(TIMESTAMP, INTEGER) TO breeze_app;
    GRANT EXECUTE ON FUNCTION public.breeze_prepare_metric_rollup_compaction(TIMESTAMP, BOOLEAN) TO breeze_app;
    GRANT EXECUTE ON FUNCTION public.breeze_compact_metric_rollup_partition(TIMESTAMP, BOOLEAN) TO breeze_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Converge now, so new writes land in the per-bucket shape without waiting for
-- the 03:15 maintenance run: convert every attached EMPTY flat month (the
-- pre-created future ones), then ensure the default window (this month .. +3).
-- Flat months with data are left for the maintenance job. Every conversion is
-- bounded and falls back to "stay flat" (see ensure), so this cannot fail or
-- stall a boot on a busy table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  anchor_month TIMESTAMP := date_trunc('month', now() AT TIME ZONE 'UTC');
  offset_months INTEGER;
  v_month TEXT;
BEGIN
  FOR v_month IN
    SELECT child.relname
    FROM pg_inherits
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_namespace n ON n.oid = parent.relnamespace
    WHERE n.nspname = 'public' AND parent.relname = 'metric_rollups'
      AND child.relkind = 'r'
      AND child.relname ~ '^metric_rollups_y[0-9]{4}m[0-9]{2}$'
      AND pg_relation_size(child.oid) = 0
  LOOP
    PERFORM public.breeze_ensure_metric_rollup_partition(
      make_timestamp(substr(v_month, 17, 4)::int, substr(v_month, 22, 2)::int, 1, 0, 0, 0)
    );
  END LOOP;
  FOR offset_months IN 0..3 LOOP
    PERFORM public.breeze_ensure_metric_rollup_partition(
      anchor_month + make_interval(months => offset_months)
    );
  END LOOP;
END $$;
