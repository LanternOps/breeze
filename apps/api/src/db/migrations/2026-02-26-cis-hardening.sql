BEGIN;

DO $$ BEGIN
  CREATE TYPE cis_baseline_level AS ENUM ('l1', 'l2', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE cis_os_type AS ENUM ('windows', 'macos', 'linux');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE cis_check_status AS ENUM ('pass', 'fail', 'not_applicable', 'error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE cis_check_severity AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE cis_remediation_status AS ENUM ('pending_approval', 'queued', 'in_progress', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE cis_remediation_approval_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.cis_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  name varchar(200) NOT NULL,
  os_type cis_os_type NOT NULL,
  benchmark_version varchar(40) NOT NULL,
  level cis_baseline_level NOT NULL,
  custom_exclusions jsonb NOT NULL DEFAULT '[]'::jsonb,
  scan_schedule jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cis_baselines_org_os_idx
  ON public.cis_baselines(org_id, os_type);
CREATE INDEX IF NOT EXISTS cis_baselines_org_active_idx
  ON public.cis_baselines(org_id, is_active);

CREATE TABLE IF NOT EXISTS public.cis_baseline_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  device_id uuid NOT NULL REFERENCES public.devices(id),
  baseline_id uuid NOT NULL REFERENCES public.cis_baselines(id) ON DELETE CASCADE,
  checked_at timestamp NOT NULL,
  total_checks integer NOT NULL CHECK (total_checks >= 0),
  passed_checks integer NOT NULL CHECK (passed_checks >= 0),
  failed_checks integer NOT NULL CHECK (failed_checks >= 0),
  score integer NOT NULL CHECK (score >= 0 AND score <= 100),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cis_results_org_device_checked_idx
  ON public.cis_baseline_results(org_id, device_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS cis_results_baseline_checked_idx
  ON public.cis_baseline_results(baseline_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS cis_results_score_idx
  ON public.cis_baseline_results(score);

CREATE TABLE IF NOT EXISTS public.cis_check_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  os_type cis_os_type NOT NULL,
  benchmark_version varchar(40) NOT NULL,
  level cis_baseline_level NOT NULL,
  check_id varchar(120) NOT NULL,
  title varchar(400) NOT NULL,
  severity cis_check_severity NOT NULL,
  default_action varchar(80) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT cis_check_catalog_unique_idx UNIQUE (os_type, benchmark_version, level, check_id)
);

CREATE INDEX IF NOT EXISTS cis_check_catalog_os_benchmark_idx
  ON public.cis_check_catalog(os_type, benchmark_version);

CREATE TABLE IF NOT EXISTS public.cis_remediation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  device_id uuid NOT NULL REFERENCES public.devices(id),
  baseline_id uuid REFERENCES public.cis_baselines(id) ON DELETE SET NULL,
  baseline_result_id uuid REFERENCES public.cis_baseline_results(id) ON DELETE SET NULL,
  check_id varchar(120) NOT NULL,
  action varchar(40) NOT NULL,
  status cis_remediation_status NOT NULL DEFAULT 'pending_approval',
  approval_status cis_remediation_approval_status NOT NULL DEFAULT 'pending',
  approved_by uuid REFERENCES public.users(id),
  approved_at timestamp,
  approval_note text,
  requested_by uuid REFERENCES public.users(id),
  command_id uuid,
  executed_at timestamp,
  details jsonb,
  before_state jsonb,
  after_state jsonb,
  rollback_hint text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cis_remediation_org_device_status_idx
  ON public.cis_remediation_actions(org_id, device_id, status);
CREATE INDEX IF NOT EXISTS cis_remediation_org_approval_status_idx
  ON public.cis_remediation_actions(org_id, approval_status, status);
CREATE INDEX IF NOT EXISTS cis_remediation_result_idx
  ON public.cis_remediation_actions(baseline_result_id);
CREATE INDEX IF NOT EXISTS cis_remediation_check_idx
  ON public.cis_remediation_actions(check_id);

ALTER TABLE public.cis_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cis_baselines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.cis_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.cis_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.cis_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.cis_baselines;
CREATE POLICY breeze_org_isolation_select ON public.cis_baselines
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.cis_baselines
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.cis_baselines
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.cis_baselines
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE public.cis_baseline_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cis_baseline_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.cis_baseline_results;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.cis_baseline_results;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.cis_baseline_results;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.cis_baseline_results;
CREATE POLICY breeze_org_isolation_select ON public.cis_baseline_results
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.cis_baseline_results
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.cis_baseline_results
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.cis_baseline_results
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE public.cis_check_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cis_check_catalog FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.cis_check_catalog;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.cis_check_catalog;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.cis_check_catalog;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.cis_check_catalog;
CREATE POLICY breeze_org_isolation_select ON public.cis_check_catalog
  FOR SELECT USING (true);
CREATE POLICY breeze_org_isolation_insert ON public.cis_check_catalog
  FOR INSERT WITH CHECK (true);
CREATE POLICY breeze_org_isolation_update ON public.cis_check_catalog
  FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY breeze_org_isolation_delete ON public.cis_check_catalog
  FOR DELETE USING (true);

ALTER TABLE public.cis_remediation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cis_remediation_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.cis_remediation_actions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.cis_remediation_actions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.cis_remediation_actions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.cis_remediation_actions;
CREATE POLICY breeze_org_isolation_select ON public.cis_remediation_actions
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.cis_remediation_actions
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.cis_remediation_actions
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.cis_remediation_actions
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
