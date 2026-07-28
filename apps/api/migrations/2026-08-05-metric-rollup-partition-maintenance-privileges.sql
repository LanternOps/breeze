-- Metric-rollup partition maintenance could never work at runtime (BREEZE-10).
--
-- ensureMetricRollupPartitions()/dropExpiredMetricRollupPartitions() issue pure
-- DDL — CREATE TABLE ... PARTITION OF, ALTER TABLE ... FORCE RLS, CREATE POLICY,
-- GRANT, DROP TABLE — but the API connects as the unprivileged `breeze_app`,
-- which has no CREATE on schema public and does not own metric_rollups. The
-- daily job therefore aborted on its first statement with
--   42501 permission denied for schema public
-- and never reached dropExpiredMetricRollupPartitions() or pruneMetricRollups(),
-- so metric_rollups retention has not run at all in production. Postgres
-- ACL-checks the schema BEFORE the IF NOT EXISTS short-circuit, so the failure
-- fires even for a month whose partition already exists — which is why the
-- symptom was a permanent daily abort rather than a missing-partition error.
--
-- Granting breeze_app CREATE on public would not fix it and is not wanted:
-- `CREATE TABLE ... PARTITION OF metric_rollups` requires ownership of the
-- PARENT, and ENABLE/FORCE ROW LEVEL SECURITY requires ownership of the child.
-- Instead, relocate the DDL into SECURITY DEFINER functions owned by the
-- migration role (which owns metric_rollups), and let breeze_app call those.
--
-- Both functions take a month TIMESTAMP, never an identifier: they derive the
-- partition name internally and verify attachment to metric_rollups before
-- touching anything. A SECURITY DEFINER function that accepted a caller-supplied
-- table name would be a privilege-escalation primitive (drop/alter any table as
-- the owner) — deriving the name is what keeps that impossible.
--
-- No breeze.scope elevation is involved: these do DDL only, never row access,
-- so there is no custom-GUC function attribute here (that form needs superuser
-- and crash-looped EU in v0.97.0 — see migrationGucAttributes.test.ts).
--
-- Idempotent throughout. autoMigrate wraps this file in a transaction.

-- ---------------------------------------------------------------------------
-- Ensure one monthly partition exists, fully converged (RLS + policies + grant).
-- Returns the partition name, or NULL when the month was skipped because
-- metric_rollups_default already holds rows for it (the attach would fail the
-- default partition's updated constraint). Callers treat NULL as "skipped".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_ensure_metric_rollup_partition(
  p_month_start TIMESTAMP
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned search_path: a SECURITY DEFINER function without this can be hijacked
-- by a caller-controlled search_path.
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_start TIMESTAMP;
  v_end   TIMESTAMP;
  v_name  TEXT;
BEGIN
  IF p_month_start IS NULL THEN
    RAISE EXCEPTION 'breeze_ensure_metric_rollup_partition: p_month_start must not be NULL';
  END IF;

  -- Normalize to the month boundary so the derived name and the range can never
  -- disagree, whatever instant the caller passes.
  v_start := date_trunc('month', p_month_start);
  v_end   := v_start + INTERVAL '1 month';
  v_name  := format(
    'metric_rollups_y%sm%s',
    to_char(v_start, 'YYYY'),
    to_char(v_start, 'MM')
  );

  BEGIN
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.metric_rollups FOR VALUES FROM (%L) TO (%L)',
      v_name,
      v_start,
      v_end
    );
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM LIKE '%updated partition constraint for default partition%'
      AND SQLERRM LIKE '%would be violated by some row%' THEN
      RAISE WARNING
        'Skipping %, metric_rollups_default already contains rows for [% - %)',
        v_name,
        v_start,
        v_end;
      RETURN NULL;
    END IF;
    RAISE;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_inherits
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE child.relname = v_name
      AND child_ns.nspname = 'public'
      AND parent.relname = 'metric_rollups'
      AND parent_ns.nspname = 'public'
  ) THEN
    RAISE EXCEPTION '% exists but is not attached as a metric_rollups partition', v_name;
  END IF;

  -- PARTITION OF inherits parent checks and partitioned indexes. RLS policies
  -- and grants are relation-local, so converge them here for each child.
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_name);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON public.%I', v_name);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.%I', v_name);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON public.%I', v_name);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.%I', v_name);

  EXECUTE format(
    'CREATE POLICY breeze_org_isolation_select ON public.%I FOR SELECT USING (public.breeze_has_org_access(org_id))',
    v_name
  );
  EXECUTE format(
    'CREATE POLICY breeze_org_isolation_insert ON public.%I FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))',
    v_name
  );
  EXECUTE format(
    'CREATE POLICY breeze_org_isolation_update ON public.%I FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))',
    v_name
  );
  EXECUTE format(
    'CREATE POLICY breeze_org_isolation_delete ON public.%I FOR DELETE USING (public.breeze_has_org_access(org_id))',
    v_name
  );

  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO breeze_app', v_name);

  RETURN v_name;
END;
$$;

-- ---------------------------------------------------------------------------
-- Drop one expired monthly partition. Takes the month, not a name, and refuses
-- anything that is not currently attached to metric_rollups — so it can never
-- be aimed at metric_rollups_default (whose name no month can produce) or at
-- an unrelated table. Returns the dropped name, or NULL when there was nothing
-- attached for that month.
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
  v_name  := format(
    'metric_rollups_y%sm%s',
    to_char(v_start, 'YYYY'),
    to_char(v_start, 'MM')
  );

  IF NOT EXISTS (
    SELECT 1
    FROM pg_inherits
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE child.relname = v_name
      AND child_ns.nspname = 'public'
      AND parent.relname = 'metric_rollups'
      AND parent_ns.nspname = 'public'
  ) THEN
    RETURN NULL;
  END IF;

  EXECUTE format('DROP TABLE IF EXISTS public.%I', v_name);
  RETURN v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_ensure_metric_rollup_partition(TIMESTAMP) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_drop_metric_rollup_partition(TIMESTAMP) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.breeze_ensure_metric_rollup_partition(TIMESTAMP) TO breeze_app;
GRANT EXECUTE ON FUNCTION public.breeze_drop_metric_rollup_partition(TIMESTAMP) TO breeze_app;

-- ---------------------------------------------------------------------------
-- Converge the current partition window now rather than waiting for the 03:15
-- job. The runtime defaults are monthsBack=0/monthsAhead=3; the bootstrap in
-- 2026-06-18-n only ran once at install time, so every DB that has been up
-- since then is missing the months that the (broken) worker should have added.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  anchor_month TIMESTAMP := date_trunc('month', now() AT TIME ZONE 'UTC');
  offset_months INTEGER;
BEGIN
  FOR offset_months IN 0..3 LOOP
    PERFORM public.breeze_ensure_metric_rollup_partition(
      anchor_month + make_interval(months => offset_months)
    );
  END LOOP;
END $$;
