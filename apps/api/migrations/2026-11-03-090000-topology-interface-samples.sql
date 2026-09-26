-- M3 Task 2 (W04 #5999, amendment M3-D1): partitioned interface measurement
-- samples plus the telemetry quota window on their collection source.
--
-- Shape 1 (direct org_id). A sample references its canonical interface
-- (id + epoch) and the `if_metrics` telemetry source that produced it, with
-- the source's producer epoch and batch sequence. There are no per-poll
-- collection runs. Both composite FKs are DEFERRABLE INITIALLY IMMEDIATE so a
-- whole-org merge can repoint parent and child org_id in separate statements.
--
-- Partitioning: LIST (resolution) -> raw / 5m / 1h sub-parents, each RANGE
-- (sampled_at) with bounded daily UTC leaves. There is deliberately NO default
-- partition: a sample outside the provisioned window is rejected by the
-- ingest path (partition_unavailable) instead of landing in an unbounded
-- catch-all. breeze_app cannot run DDL, so leaves are created/dropped only by
-- the two SECURITY DEFINER entry points below (metric_rollups precedent,
-- 2026-08-05): they take a resolution and a day, derive the identifier, refuse
-- dates outside the retention/lookahead window and verify attachment through
-- pg_inherits before trusting or dropping a same-name relation. RLS policies
-- and grants are relation-local, so every sub-parent and leaf is converged
-- with ENABLE + FORCE RLS, the four org policies and the breeze_app grant.
--
-- Raw readings are immutable (org_id ownership may move; retention deletes);
-- 5m/1h rows are replaced only by deterministic bucket recomputation (Task 5).
--
-- Writes no rows. Idempotent throughout.

-- ---------------------------------------------------------------------------
-- Telemetry admission window on the shared source row (per-source quota).
-- ---------------------------------------------------------------------------
ALTER TABLE topology_collection_sources ADD COLUMN IF NOT EXISTS telemetry_window_started_at timestamptz;
ALTER TABLE topology_collection_sources ADD COLUMN IF NOT EXISTS telemetry_window_samples integer NOT NULL DEFAULT 0;
ALTER TABLE topology_collection_sources ADD COLUMN IF NOT EXISTS telemetry_window_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE topology_collection_sources DROP CONSTRAINT IF EXISTS topology_sources_telemetry_window_chk;
ALTER TABLE topology_collection_sources ADD CONSTRAINT topology_sources_telemetry_window_chk
  CHECK (telemetry_window_samples >= 0 AND telemetry_window_bytes >= 0);

-- ---------------------------------------------------------------------------
-- Parent and resolution sub-parents.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topology_interface_samples (
  org_id uuid NOT NULL,
  site_id uuid NOT NULL,
  interface_id uuid NOT NULL,
  interface_epoch varchar(255) NOT NULL,
  source_id uuid NOT NULL,
  producer_epoch varchar(255) NOT NULL,
  source_sequence numeric(20,0) NOT NULL,
  sampled_at timestamptz NOT NULL,
  resolution varchar(8) NOT NULL,
  readings jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_duration_ms bigint NOT NULL DEFAULT 0,
  sample_count integer NOT NULL DEFAULT 0,
  gap_duration_ms bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_interface_samples_pkey
    PRIMARY KEY (resolution, sampled_at, org_id, site_id, interface_id, interface_epoch, source_id, producer_epoch),
  CONSTRAINT topology_interface_samples_resolution_chk CHECK (resolution IN ('raw','5m','1h')),
  CONSTRAINT topology_interface_samples_sequence_chk CHECK (source_sequence BETWEEN 0 AND 18446744073709551615),
  CONSTRAINT topology_interface_samples_bounds_chk CHECK (valid_duration_ms >= 0 AND sample_count >= 0 AND gap_duration_ms >= 0),
  CONSTRAINT topology_interface_samples_epochs_chk CHECK (char_length(interface_epoch) > 0 AND char_length(producer_epoch) > 0),
  CONSTRAINT topology_interface_samples_readings_chk CHECK (jsonb_typeof(readings) = 'object' AND octet_length(readings::text) <= 16384)
) PARTITION BY LIST (resolution);

CREATE TABLE IF NOT EXISTS topology_interface_samples_raw PARTITION OF topology_interface_samples
  FOR VALUES IN ('raw') PARTITION BY RANGE (sampled_at);
CREATE TABLE IF NOT EXISTS topology_interface_samples_5m PARTITION OF topology_interface_samples
  FOR VALUES IN ('5m') PARTITION BY RANGE (sampled_at);
CREATE TABLE IF NOT EXISTS topology_interface_samples_1h PARTITION OF topology_interface_samples
  FOR VALUES IN ('1h') PARTITION BY RANGE (sampled_at);

-- Current-measurement and history lookups (partitioned index, cloned per leaf).
CREATE INDEX IF NOT EXISTS topology_interface_samples_lookup_idx
  ON topology_interface_samples (org_id, site_id, interface_id, resolution, sampled_at DESC);
CREATE INDEX IF NOT EXISTS topology_interface_samples_source_idx
  ON topology_interface_samples (source_id, producer_epoch, source_sequence);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'topology_interface_samples_interface_fk'
      AND conrelid = 'public.topology_interface_samples'::regclass) THEN
    ALTER TABLE topology_interface_samples ADD CONSTRAINT topology_interface_samples_interface_fk
      FOREIGN KEY (interface_id, org_id, site_id) REFERENCES topology_interfaces (id, org_id, site_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'topology_interface_samples_source_fk'
      AND conrelid = 'public.topology_interface_samples'::regclass) THEN
    ALTER TABLE topology_interface_samples ADD CONSTRAINT topology_interface_samples_source_fk
      FOREIGN KEY (source_id, org_id, site_id) REFERENCES topology_collection_sources (id, org_id, site_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Raw readings are immutable history. Ownership (org_id) may be repointed by a
-- deferred whole-org merge; retention removes rows by DELETE. Aggregate
-- resolutions are recomputed in place (Task 5) and are not guarded here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION breeze_topology_interface_sample_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolution = 'raw'
    AND to_jsonb(NEW) - ARRAY['org_id','updated_at'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['org_id','updated_at'] THEN
    RAISE EXCEPTION 'Topology raw interface samples are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.topology_interface_samples'::regclass
      AND tgname = 'topology_interface_sample_immutable') THEN
    CREATE TRIGGER topology_interface_sample_immutable BEFORE UPDATE ON topology_interface_samples
      FOR EACH ROW EXECUTE FUNCTION breeze_topology_interface_sample_immutable();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Relation-local RLS convergence for the parent and a (sub-)partition. Not
-- callable by breeze_app: it takes an identifier and is only invoked from this
-- migration and the SECURITY DEFINER entry points, which derive that name.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_converge_topology_interface_sample_rls(p_relation text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE command text; policy_name text; clause text;
BEGIN
  IF p_relation IS NULL OR p_relation !~ '^topology_interface_samples(_(raw|5m|1h)(_p[0-9]{8})?)?$' THEN
    RAISE EXCEPTION 'breeze_converge_topology_interface_sample_rls: % is not an interface sample relation', p_relation;
  END IF;
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_relation);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', p_relation);
  FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
    policy_name := 'breeze_org_isolation_' || lower(command);
    clause := CASE command
      WHEN 'INSERT' THEN 'WITH CHECK (public.breeze_has_org_access(org_id))'
      WHEN 'UPDATE' THEN 'USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))'
      ELSE 'USING (public.breeze_has_org_access(org_id))' END;
    IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public'
        AND p.tablename = p_relation AND p.policyname = policy_name) THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR %s %s', policy_name, p_relation, command, clause);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO breeze_app', p_relation);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.breeze_converge_topology_interface_sample_rls(text) FROM PUBLIC;

SELECT public.breeze_converge_topology_interface_sample_rls(relation)
FROM unnest(ARRAY['topology_interface_samples','topology_interface_samples_raw',
  'topology_interface_samples_5m','topology_interface_samples_1h']) AS relation;

-- ---------------------------------------------------------------------------
-- Ensure one daily leaf, fully converged. Window: from one day before the
-- resolution's retention horizon (7/30/90 days) through 14 days ahead, UTC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_ensure_topology_interface_sample_partition(
  p_resolution text,
  p_day date
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_retention integer;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_parent text;
  v_name text;
  v_from timestamptz;
  v_to timestamptz;
BEGIN
  IF p_resolution IS NULL OR p_day IS NULL THEN
    RAISE EXCEPTION 'breeze_ensure_topology_interface_sample_partition: arguments must not be NULL';
  END IF;
  v_retention := CASE p_resolution WHEN 'raw' THEN 7 WHEN '5m' THEN 30 WHEN '1h' THEN 90 END;
  IF v_retention IS NULL THEN
    RAISE EXCEPTION 'breeze_ensure_topology_interface_sample_partition: unsupported resolution %', p_resolution USING ERRCODE = '22023';
  END IF;
  IF p_day < v_today - (v_retention + 1) OR p_day > v_today + 14 THEN
    RAISE EXCEPTION 'breeze_ensure_topology_interface_sample_partition: % is outside the % partition window', p_day, p_resolution USING ERRCODE = '22023';
  END IF;

  v_parent := 'topology_interface_samples_' || p_resolution;
  v_name := v_parent || '_p' || to_char(p_day, 'YYYYMMDD');
  v_from := p_day::timestamp AT TIME ZONE 'UTC';
  v_to := (p_day + 1)::timestamp AT TIME ZONE 'UTC';

  EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
    v_name, v_parent, v_from, v_to);

  IF NOT EXISTS (
    SELECT 1
    FROM pg_inherits
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE child.relname = v_name AND child_ns.nspname = 'public'
      AND parent.relname = v_parent AND parent_ns.nspname = 'public'
  ) THEN
    RAISE EXCEPTION '% exists but is not attached as a % partition', v_name, v_parent;
  END IF;

  PERFORM public.breeze_converge_topology_interface_sample_rls(v_name);
  RETURN v_name;
END;
$$;

-- ---------------------------------------------------------------------------
-- Drop one expired daily leaf (its whole day is older than the retention
-- horizon). Returns the dropped name, or NULL when nothing is attached.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_drop_topology_interface_sample_partition(
  p_resolution text,
  p_day date
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_retention integer;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_parent text;
  v_name text;
BEGIN
  IF p_resolution IS NULL OR p_day IS NULL THEN
    RAISE EXCEPTION 'breeze_drop_topology_interface_sample_partition: arguments must not be NULL';
  END IF;
  v_retention := CASE p_resolution WHEN 'raw' THEN 7 WHEN '5m' THEN 30 WHEN '1h' THEN 90 END;
  IF v_retention IS NULL THEN
    RAISE EXCEPTION 'breeze_drop_topology_interface_sample_partition: unsupported resolution %', p_resolution USING ERRCODE = '22023';
  END IF;
  IF p_day + 1 > v_today - v_retention THEN
    RAISE EXCEPTION 'breeze_drop_topology_interface_sample_partition: % is still inside % retention', p_day, p_resolution USING ERRCODE = '22023';
  END IF;

  v_parent := 'topology_interface_samples_' || p_resolution;
  v_name := v_parent || '_p' || to_char(p_day, 'YYYYMMDD');
  IF NOT EXISTS (
    SELECT 1
    FROM pg_inherits
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE child.relname = v_name AND child_ns.nspname = 'public'
      AND parent.relname = v_parent AND parent_ns.nspname = 'public'
  ) THEN
    RETURN NULL;
  END IF;

  EXECUTE format('DROP TABLE IF EXISTS public.%I', v_name);
  RETURN v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_ensure_topology_interface_sample_partition(text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_drop_topology_interface_sample_partition(text, date) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_ensure_topology_interface_sample_partition(text, date) TO breeze_app;
    GRANT EXECUTE ON FUNCTION public.breeze_drop_topology_interface_sample_partition(text, date) TO breeze_app;
  END IF;
END $$;

-- Provision yesterday through seven days ahead for every resolution now, so
-- ingest works before the maintenance job (Task 5) first runs.
DO $$
DECLARE resolution text; offset_days integer;
BEGIN
  FOREACH resolution IN ARRAY ARRAY['raw','5m','1h'] LOOP
    FOR offset_days IN -1..7 LOOP
      PERFORM public.breeze_ensure_topology_interface_sample_partition(resolution, (now() AT TIME ZONE 'UTC')::date + offset_days);
    END LOOP;
  END LOOP;
END $$;
