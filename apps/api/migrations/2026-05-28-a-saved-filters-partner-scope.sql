-- Allow partner-scope users to save partner-wide filters (visible across
-- all orgs in their partner). Previously saved_filters.org_id was NOT NULL,
-- so the only way to save was to pin a filter to one org — partner-scope
-- users with >1 org got a 400 "orgId is required" error on every save.
--
-- Dual-axis pattern follows deployment_invites (see 2026-04-20-b). One row
-- is EITHER org-scoped (org_id set, partner_id NULL) OR partner-scoped
-- (partner_id set, org_id NULL). CHECK constraint enforces XOR.

-- 1. Add partner_id column (nullable; FK to partners with cascade).
ALTER TABLE saved_filters
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id) ON DELETE CASCADE;

-- 2. Allow org_id to be NULL (it's NULL when partner_id is set).
ALTER TABLE saved_filters
  ALTER COLUMN org_id DROP NOT NULL;

-- 3. Exactly one of (org_id, partner_id) must be set.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_filters_scope_xor') THEN
    ALTER TABLE saved_filters
      ADD CONSTRAINT saved_filters_scope_xor
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

-- 4. Replace the org-only policies with a single dual-axis policy.
DROP POLICY IF EXISTS breeze_org_isolation_select ON saved_filters;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON saved_filters;
DROP POLICY IF EXISTS breeze_org_isolation_update ON saved_filters;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON saved_filters;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'saved_filters_dual_axis_access'
      AND tablename = 'saved_filters'
  ) THEN
    CREATE POLICY saved_filters_dual_axis_access ON saved_filters
      USING (breeze_has_partner_access(partner_id) OR breeze_has_org_access(org_id))
      WITH CHECK (breeze_has_partner_access(partner_id) OR breeze_has_org_access(org_id));
  END IF;
END $$;
