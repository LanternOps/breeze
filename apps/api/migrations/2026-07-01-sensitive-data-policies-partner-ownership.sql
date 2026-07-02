-- Partner-owned sensitive-data policies (epic #2135, issue #2131).
--
-- Until now a sensitive_data_policies row was always owned by exactly one org
-- (org_id NOT NULL), so a data-discovery policy could not be defined once and
-- scanned across every org under a partner. This migration makes the policy
-- ownable by EITHER an org (org_id set, partner_id NULL — the existing shape)
-- OR a partner (partner_id set, org_id NULL — "partner-wide / all orgs"),
-- enforced by an exactly-one-axis CHECK. Mirrors software_policies (#2126) and
-- automation_policies (#2129).
--
-- sensitive_data_scans and sensitive_data_findings are unchanged: each row
-- carries the scanned DEVICE's own org_id (the scheduler now sources scan
-- org_id from the device, not the policy), so their org-axis RLS stays
-- correct for partner-wide policies too.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS
-- then CREATE. Re-applying is a no-op. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file in a transaction).

-- ============================================
-- Step 1: schema — add partner_id, relax org_id, XOR CHECK
-- ============================================

ALTER TABLE sensitive_data_policies
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE sensitive_data_policies
  ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sensitive_data_policies_one_owner_chk'
      AND conrelid = 'sensitive_data_policies'::regclass
  ) THEN
    ALTER TABLE sensitive_data_policies
      ADD CONSTRAINT sensitive_data_policies_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sensitive_policy_partner_idx
  ON sensitive_data_policies(partner_id);

-- ============================================
-- Step 2: RLS — dual-axis (org OR partner) + system short-circuit
-- ============================================
-- Drops every legacy policy-name candidate: the four per-command
-- breeze_org_isolation_* from the baseline AND the combined
-- sensitive_data_policies_org_isolation from 0051 (which also had no
-- WITH CHECK — the replacement adds it).

ALTER TABLE sensitive_data_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensitive_data_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON sensitive_data_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON sensitive_data_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON sensitive_data_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON sensitive_data_policies;
DROP POLICY IF EXISTS sensitive_data_policies_org_isolation ON sensitive_data_policies;
DROP POLICY IF EXISTS sensitive_data_policies_isolation ON sensitive_data_policies;
CREATE POLICY sensitive_data_policies_isolation
  ON sensitive_data_policies
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
