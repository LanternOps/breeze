-- metric_rollups leaf partitions: keep planner statistics fresh.
--
-- WHY
-- ---
-- Partitions do NOT inherit reloptions from the partitioned parent, so every
-- metric_rollups leaf runs on the global autovacuum defaults: ANALYZE after
-- 10 % of the table changes. The current month's 5-minute leaf holds ~7 M
-- rows by mid-month and gains ~90k rows/hour on the US production primary
-- (2026-10-12), so it is re-analyzed only every ~8 hours and the bucket_start
-- histogram upper bound lags now() by up to that long. Every detector query
-- that asks for "the last 15 minutes" therefore falls beyond the histogram
-- and is estimated at ONE row (actual: 720). On that estimate the planner
-- picks a Nested Loop Left Join over the open-episode exclusion set (376 rows
-- x 192k outer rows) plus an external sort, and the baseline stage takes
-- 23 s per org -- 90 s and cancelled under load (150 timeouts/day on two
-- orgs). The identical query with a window inside the histogram estimates 378
-- rows, uses a Hash Left Join and finishes in 2.3 s.
--
-- WHAT
-- ----
-- (1) breeze_converge_metric_rollup_autovacuum(relation): for a leaf
--     (relkind 'r') set autovacuum_analyze_scale_factor = 0.005 and
--     autovacuum_analyze_threshold = 20000 unless already present. On a 7 M
--     row leaf that is ~55k changed rows, i.e. roughly hourly on US; on a small
--     install the 20k floor keeps ANALYZE from running on every tick. ALTER
--     TABLE ... SET (autovacuum_*) takes SHARE UPDATE EXCLUSIVE, so it never
--     blocks readers or writers. Partitioned parents (relkind 'p') are
--     skipped: Postgres rejects autovacuum options on them.
-- (2) breeze_converge_metric_rollup_rls (2026-11-14 body) calls (1) at the
--     end, so every path that creates or converges a partition -- the daily
--     ensure, breeze_create_metric_rollup_month, the default-partition swap
--     and drain -- carries the setting forward to new months.
-- (3) A DO block applies (1) to every existing leaf under metric_rollups,
--     including metric_rollups_default and any legacy flat month.
--
-- Idempotent: CREATE OR REPLACE, option presence checked before each ALTER.
-- No inner BEGIN/COMMIT (autoMigrate wraps each file). DDL only, so no
-- breeze.scope election.

CREATE OR REPLACE FUNCTION public.breeze_converge_metric_rollup_autovacuum(p_relation TEXT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kind    "char";
  v_options TEXT[];
BEGIN
  IF p_relation IS NULL OR (
    p_relation !~ '^metric_rollups_y[0-9]{4}m[0-9]{2}(_(5m|1h|1d))?$'
    AND p_relation <> 'metric_rollups_default'
  ) THEN
    RAISE EXCEPTION 'breeze_converge_metric_rollup_autovacuum: % is not a metric_rollups partition or leaf', p_relation;
  END IF;

  SELECT c.relkind, c.reloptions INTO v_kind, v_options
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = p_relation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'breeze_converge_metric_rollup_autovacuum: % does not exist', p_relation;
  END IF;

  -- Only leaves hold rows; autovacuum options are rejected on relkind 'p'.
  IF v_kind <> 'r' THEN
    RETURN;
  END IF;

  IF v_options IS NULL
     OR NOT EXISTS (SELECT 1 FROM unnest(v_options) o WHERE o LIKE 'autovacuum_analyze_scale_factor=%')
     OR NOT EXISTS (SELECT 1 FROM unnest(v_options) o WHERE o LIKE 'autovacuum_analyze_threshold=%') THEN
    EXECUTE format(
      'ALTER TABLE public.%I SET (autovacuum_analyze_scale_factor = 0.005, autovacuum_analyze_threshold = 20000)',
      p_relation
    );
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_converge_metric_rollup_autovacuum(TEXT) FROM PUBLIC;

-- 2026-11-14 body + the autovacuum converge at the end.
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

  PERFORM public.breeze_converge_metric_rollup_autovacuum(p_relation);
END;
$$;
REVOKE ALL ON FUNCTION public.breeze_converge_metric_rollup_rls(TEXT) FROM PUBLIC;

-- Converge every existing leaf now.
DO $$
DECLARE
  v_leaf TEXT;
BEGIN
  FOR v_leaf IN
    WITH RECURSIVE tree AS (
      SELECT c.oid
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'metric_rollups'
      UNION ALL
      SELECT i.inhrelid FROM pg_inherits i JOIN tree ON i.inhparent = tree.oid
    )
    SELECT c.relname
    FROM tree JOIN pg_class c ON c.oid = tree.oid
    WHERE c.relkind = 'r'
      AND (c.relname ~ '^metric_rollups_y[0-9]{4}m[0-9]{2}(_(5m|1h|1d))?$'
           OR c.relname = 'metric_rollups_default')
    ORDER BY c.relname
  LOOP
    PERFORM public.breeze_converge_metric_rollup_autovacuum(v_leaf);
  END LOOP;
END $$;
