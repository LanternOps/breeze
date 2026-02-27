-- BE-21: Create audit baseline tables for compliance evaluation, drift detection,
-- and approval-gated remediation workflows.
BEGIN;

CREATE TABLE IF NOT EXISTS public.audit_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  name varchar(200) NOT NULL,
  os_type varchar(20) NOT NULL,
  profile varchar(20) NOT NULL,
  settings jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit_baseline_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  device_id uuid NOT NULL REFERENCES public.devices(id),
  baseline_id uuid NOT NULL REFERENCES public.audit_baselines(id) ON DELETE CASCADE,
  compliant boolean NOT NULL,
  score integer NOT NULL,
  deviations jsonb NOT NULL,
  checked_at timestamp NOT NULL,
  remediated_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit_policy_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  device_id uuid NOT NULL REFERENCES public.devices(id),
  os_type varchar(20) NOT NULL,
  settings jsonb NOT NULL,
  raw jsonb,
  collected_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit_baseline_apply_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  baseline_id uuid NOT NULL REFERENCES public.audit_baselines(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES public.users(id),
  approved_by uuid REFERENCES public.users(id),
  status varchar(20) NOT NULL DEFAULT 'pending',
  request_payload jsonb NOT NULL,
  expires_at timestamp NOT NULL,
  approved_at timestamp,
  consumed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_baselines_org_os_idx
  ON public.audit_baselines(org_id, os_type);
CREATE INDEX IF NOT EXISTS audit_baselines_org_active_idx
  ON public.audit_baselines(org_id, is_active);

CREATE INDEX IF NOT EXISTS audit_results_org_device_idx
  ON public.audit_baseline_results(org_id, device_id);
CREATE INDEX IF NOT EXISTS audit_results_checked_at_idx
  ON public.audit_baseline_results(checked_at);
CREATE INDEX IF NOT EXISTS audit_results_baseline_checked_idx
  ON public.audit_baseline_results(baseline_id, checked_at);

CREATE INDEX IF NOT EXISTS audit_policy_states_org_device_collected_idx
  ON public.audit_policy_states(org_id, device_id, collected_at);
CREATE INDEX IF NOT EXISTS audit_policy_states_device_collected_idx
  ON public.audit_policy_states(device_id, collected_at);
CREATE INDEX IF NOT EXISTS audit_policy_states_org_collected_idx
  ON public.audit_policy_states(org_id, collected_at);

CREATE INDEX IF NOT EXISTS audit_baseline_apply_approvals_org_status_idx
  ON public.audit_baseline_apply_approvals(org_id, status);
CREATE INDEX IF NOT EXISTS audit_baseline_apply_approvals_baseline_idx
  ON public.audit_baseline_apply_approvals(baseline_id);
CREATE INDEX IF NOT EXISTS audit_baseline_apply_approvals_expires_at_idx
  ON public.audit_baseline_apply_approvals(expires_at);

-- CHECK constraints
ALTER TABLE public.audit_baseline_results
  ADD CONSTRAINT audit_baseline_results_score_check CHECK (score >= 0 AND score <= 100);
ALTER TABLE public.audit_baseline_apply_approvals
  ADD CONSTRAINT audit_baseline_apply_approvals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'consumed'));

-- Partial unique index: one active baseline per org + OS type
CREATE UNIQUE INDEX audit_baselines_one_active_per_org_os
  ON public.audit_baselines(org_id, os_type) WHERE is_active = true;

-- Unique constraint for seed idempotency (INSERT ... ON CONFLICT DO NOTHING)
CREATE UNIQUE INDEX audit_baselines_org_name_os_profile_uniq
  ON public.audit_baselines(org_id, name, os_type, profile);

ALTER TABLE public.audit_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_baselines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.audit_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.audit_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.audit_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.audit_baselines;
CREATE POLICY breeze_org_isolation_select ON public.audit_baselines
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.audit_baselines
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.audit_baselines
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.audit_baselines
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE public.audit_baseline_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_baseline_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.audit_baseline_results;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.audit_baseline_results;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.audit_baseline_results;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.audit_baseline_results;
CREATE POLICY breeze_org_isolation_select ON public.audit_baseline_results
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.audit_baseline_results
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.audit_baseline_results
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.audit_baseline_results
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE public.audit_policy_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_policy_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.audit_policy_states;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.audit_policy_states;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.audit_policy_states;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.audit_policy_states;
CREATE POLICY breeze_org_isolation_select ON public.audit_policy_states
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.audit_policy_states
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.audit_policy_states
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.audit_policy_states
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE public.audit_baseline_apply_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_baseline_apply_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.audit_baseline_apply_approvals;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.audit_baseline_apply_approvals;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.audit_baseline_apply_approvals;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.audit_baseline_apply_approvals;
CREATE POLICY breeze_org_isolation_select ON public.audit_baseline_apply_approvals
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.audit_baseline_apply_approvals
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.audit_baseline_apply_approvals
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.audit_baseline_apply_approvals
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
