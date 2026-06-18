-- Bootstrap metric_rollups monthly partitions so fresh installs are not left on
-- the default partition until the maintenance worker runs. Idempotent
-- throughout. autoMigrate wraps this file in a transaction.

DO $$
DECLARE
  anchor_month TIMESTAMP := date_trunc('month', now() AT TIME ZONE 'UTC');
  offset_months INTEGER;
  partition_start TIMESTAMP;
  partition_end TIMESTAMP;
  partition_name TEXT;
BEGIN
  FOR offset_months IN -1..3 LOOP
    partition_start := anchor_month + make_interval(months => offset_months);
    partition_end := partition_start + interval '1 month';
    partition_name := format(
      'metric_rollups_y%sm%s',
      to_char(partition_start, 'YYYY'),
      to_char(partition_start, 'MM')
    );

    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF metric_rollups FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        partition_start,
        partition_end
      );
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM LIKE '%updated partition constraint for default partition%'
        AND SQLERRM LIKE '%would be violated by some row%' THEN
        RAISE WARNING
          'Skipping %, metric_rollups_default already contains rows for [% - %)',
          partition_name,
          partition_start,
          partition_end;
        CONTINUE;
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
      WHERE child.relname = partition_name
        AND child_ns.nspname = 'public'
        AND parent.relname = 'metric_rollups'
        AND parent_ns.nspname = 'public'
    ) THEN
      RAISE EXCEPTION '% exists but is not attached as a metric_rollups partition', partition_name;
    END IF;

    -- PARTITION OF inherits parent checks and partitioned indexes. RLS policies
    -- and grants are relation-local, so converge them here for each child.
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', partition_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON %I', partition_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON %I', partition_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON %I', partition_name);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON %I', partition_name);

    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_select ON %I FOR SELECT USING (public.breeze_has_org_access(org_id))',
      partition_name
    );
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_insert ON %I FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))',
      partition_name
    );
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_update ON %I FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))',
      partition_name
    );
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_delete ON %I FOR DELETE USING (public.breeze_has_org_access(org_id))',
      partition_name
    );

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO breeze_app', partition_name);
  END LOOP;
END $$;
