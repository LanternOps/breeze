-- Partner-owned standalone automations (epic #2135, issue #2133).
--
-- Until now an automations row was always owned by exactly one org (org_id
-- NOT NULL), so an automation (e.g. "on device.offline run diagnostic
-- script") could not be defined once and fire across every org under a
-- partner — even though the scripts it invokes are already dual-ownership.
-- This migration makes an automation ownable by EITHER an org (org_id set,
-- partner_id NULL — the existing shape) OR a partner (partner_id set, org_id
-- NULL — "partner-wide / all orgs"), enforced by an exactly-one-axis CHECK.
-- Mirrors automation_policies (#2129) and maintenance_windows (#2131).
--
-- automation_runs has no ownership columns and reaches its tenant through a
-- parent join (2026-05-30-fk-child-tables-rls.sql): EITHER
-- automation_id -> automations OR config_policy_id -> configuration_policies.
-- The automations branch checked breeze_has_org_access(a.org_id) only, which
-- is FALSE for a partner-owned parent (org_id NULL) — so the policies are
-- re-issued here with the dual-axis parent predicate on the automations
-- branch (same shape as maintenance_occurrences Step 3 in
-- 2026-07-01-maintenance-windows-partner-ownership.sql). The
-- configuration_policies branch is untouched.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS
-- then CREATE. Re-applying is a no-op. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file in a transaction).

-- ============================================
-- Step 1: schema — add partner_id, relax org_id, XOR CHECK
-- ============================================

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE automations
  ALTER COLUMN org_id DROP NOT NULL;

-- Exactly one ownership axis must be set. (org_id IS NULL) <> (partner_id IS NULL)
-- is true iff exactly one of the two is NULL — i.e. exactly one is set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automations_one_owner_chk'
      AND conrelid = 'automations'::regclass
  ) THEN
    ALTER TABLE automations
      ADD CONSTRAINT automations_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS automations_partner_id_idx
  ON automations(partner_id);

-- ============================================
-- Step 2: RLS — automations dual-axis (org OR partner) + system short-circuit
-- ============================================
-- Replaces the four pure org-axis policies from 0001-baseline.sql with a
-- single dual-axis policy, matching the automation_policies shape. ENABLE/FORCE
-- are re-asserted for idempotence (the baseline already set them).

ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON automations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON automations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON automations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON automations;
DROP POLICY IF EXISTS automations_isolation ON automations;
CREATE POLICY automations_isolation
  ON automations
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- ============================================
-- Step 3: RLS — automation_runs parent join gains the partner branch
-- ============================================
-- Same EXISTS shape and per-command policy names as the 2026-05-30 backstop,
-- with the automations-parent predicate widened to the dual-axis form so runs
-- of a partner-owned automation stay visible to the owning partner. The
-- configuration_policies OR-branch is re-issued verbatim (unchanged).

ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON automation_runs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON automation_runs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON automation_runs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON automation_runs;
CREATE POLICY breeze_org_isolation_select ON automation_runs FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM automations a
    WHERE a.id = automation_runs.automation_id
      AND (
        (a.org_id IS NOT NULL AND public.breeze_has_org_access(a.org_id))
        OR (a.partner_id IS NOT NULL AND public.breeze_has_partner_access(a.partner_id))
      )
  )
  OR EXISTS (SELECT 1 FROM configuration_policies cp WHERE cp.id = automation_runs.config_policy_id AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON automation_runs FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM automations a
    WHERE a.id = automation_runs.automation_id
      AND (
        (a.org_id IS NOT NULL AND public.breeze_has_org_access(a.org_id))
        OR (a.partner_id IS NOT NULL AND public.breeze_has_partner_access(a.partner_id))
      )
  )
  OR EXISTS (SELECT 1 FROM configuration_policies cp WHERE cp.id = automation_runs.config_policy_id AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_update ON automation_runs FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM automations a
    WHERE a.id = automation_runs.automation_id
      AND (
        (a.org_id IS NOT NULL AND public.breeze_has_org_access(a.org_id))
        OR (a.partner_id IS NOT NULL AND public.breeze_has_partner_access(a.partner_id))
      )
  )
  OR EXISTS (SELECT 1 FROM configuration_policies cp WHERE cp.id = automation_runs.config_policy_id AND public.breeze_has_org_access(cp.org_id))
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM automations a
    WHERE a.id = automation_runs.automation_id
      AND (
        (a.org_id IS NOT NULL AND public.breeze_has_org_access(a.org_id))
        OR (a.partner_id IS NOT NULL AND public.breeze_has_partner_access(a.partner_id))
      )
  )
  OR EXISTS (SELECT 1 FROM configuration_policies cp WHERE cp.id = automation_runs.config_policy_id AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON automation_runs FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM automations a
    WHERE a.id = automation_runs.automation_id
      AND (
        (a.org_id IS NOT NULL AND public.breeze_has_org_access(a.org_id))
        OR (a.partner_id IS NOT NULL AND public.breeze_has_partner_access(a.partner_id))
      )
  )
  OR EXISTS (SELECT 1 FROM configuration_policies cp WHERE cp.id = automation_runs.config_policy_id AND public.breeze_has_org_access(cp.org_id))
);
