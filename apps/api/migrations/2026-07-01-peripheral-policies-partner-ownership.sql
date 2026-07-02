-- Partner-owned peripheral-control policies (epic #2135, issue #2131).
--
-- Until now a peripheral_policies row was always owned by exactly one org
-- (org_id NOT NULL), so a USB/peripheral rule could not be defined once and
-- enforced across every org under a partner. This migration makes the policy
-- ownable by EITHER an org (org_id set, partner_id NULL — the existing shape)
-- OR a partner (partner_id set, org_id NULL — "partner-wide / all orgs"),
-- enforced by an exactly-one-axis CHECK. Mirrors software_policies (#2126)
-- and automation_policies (#2129).
--
-- peripheral_events is unchanged: each event carries the reporting DEVICE's
-- own org_id, which is correct for partner-wide policies too.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS
-- then CREATE. Re-applying is a no-op. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file in a transaction).

-- ============================================
-- Step 1: schema — add partner_id, relax org_id, XOR CHECK
-- ============================================

ALTER TABLE peripheral_policies
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE peripheral_policies
  ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'peripheral_policies_one_owner_chk'
      AND conrelid = 'peripheral_policies'::regclass
  ) THEN
    ALTER TABLE peripheral_policies
      ADD CONSTRAINT peripheral_policies_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS peripheral_policy_partner_idx
  ON peripheral_policies(partner_id);

-- ============================================
-- Step 2: RLS — dual-axis (org OR partner) + system short-circuit
-- ============================================
-- Replaces the four per-command org-axis policies from
-- 0050-peripheral-control.sql with a single dual-axis policy.

ALTER TABLE peripheral_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE peripheral_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON peripheral_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON peripheral_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON peripheral_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON peripheral_policies;
DROP POLICY IF EXISTS peripheral_policies_isolation ON peripheral_policies;
CREATE POLICY peripheral_policies_isolation
  ON peripheral_policies
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
