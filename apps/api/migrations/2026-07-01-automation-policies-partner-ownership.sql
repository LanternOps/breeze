-- Partner-owned compliance rule sets / automation policies (epic #2135, issue #2129).
--
-- Until now an automation_policies row (the table behind the config-policy
-- "compliance" feature) was always owned by exactly one org (org_id NOT NULL),
-- so a compliance rule set could not be defined once and evaluated across every
-- org under a partner. This migration makes an automation policy ownable by
-- EITHER an org (org_id set, partner_id NULL — the existing shape) OR a
-- partner (partner_id set, org_id NULL — the "partner-wide / all orgs" shape),
-- enforced by an exactly-one-axis CHECK. Mirrors software_policies (#2126),
-- security_policies (#2127), and alert_rules (#2128).
--
-- automation_policy_compliance (the per-device result child) is unchanged: it
-- has no org_id/partner_id and reaches its tenant through the device join
-- (2026-04-11-bucket-c-phase-5-admin-cold-rls.sql), which is correct for
-- partner-wide policies too — each compliance row belongs to the device's own
-- org, exactly like software_compliance_status.
--
-- RLS: automation_policies moves from the four pure org-axis baseline policies
-- to a single dual-axis policy (org OR partner) with the system short-circuit,
-- matching the software_policies precedent.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS
-- then CREATE. Re-applying is a no-op. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file in a transaction).

-- ============================================
-- Step 1: schema — add partner_id, relax org_id, XOR CHECK
-- ============================================

ALTER TABLE automation_policies
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE automation_policies
  ALTER COLUMN org_id DROP NOT NULL;

-- Exactly one ownership axis must be set. (org_id IS NULL) <> (partner_id IS NULL)
-- is true iff exactly one of the two is NULL — i.e. exactly one is set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automation_policies_one_owner_chk'
      AND conrelid = 'automation_policies'::regclass
  ) THEN
    ALTER TABLE automation_policies
      ADD CONSTRAINT automation_policies_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS automation_policies_partner_id_idx
  ON automation_policies(partner_id);

-- ============================================
-- Step 2: RLS — dual-axis (org OR partner) + system short-circuit
-- ============================================
-- Replaces the four pure org-axis policies from 0001-baseline.sql with a
-- single dual-axis policy, matching the software_policies shape. ENABLE/FORCE
-- are re-asserted for idempotence (the baseline already set them).

ALTER TABLE automation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON automation_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON automation_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON automation_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON automation_policies;
DROP POLICY IF EXISTS automation_policies_isolation ON automation_policies;
CREATE POLICY automation_policies_isolation
  ON automation_policies
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
