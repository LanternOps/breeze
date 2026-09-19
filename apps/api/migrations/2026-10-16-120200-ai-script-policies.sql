-- AI script authoring W04 (#5612): the unattended lane's policy ceiling/grant
-- and its per-org circuit state.
--
-- ai_script_policies is dual-owner (#2135 Partner-Wide First): the PARTNER row
-- is a CEILING (may any org under this partner use the lane, and how far), the
-- ORG row is an explicit GRANT. A missing org row means the lane is OFF for
-- that org regardless of the partner row (spec D10) — which is why
-- unattended_enabled has no partner-row meaning and unattended_allowed has no
-- org-row meaning, each pinned to false on the wrong side by a CHECK.
--
-- ai_script_lane_state is shape 1 with PK org_id. It is per ORG, not per
-- (org, agent), because a chat session has no agent key to close a circuit on
-- (spec §4.1); agents remain subject to ai_agent_circuit_state as well.
--
-- Idempotent (IF NOT EXISTS / guarded CHECK / DROP POLICY IF EXISTS).
-- No inner BEGIN/COMMIT — autoMigrate wraps each file in a transaction.
-- Writes NO rows, so no breeze.scope elevation is needed or wanted.
--
-- Rollback: a new migration DROPping both tables. No app code depends on them
-- until the W04 service layer lands in the same PR.

CREATE TABLE IF NOT EXISTS ai_script_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  proposing_enabled boolean NOT NULL DEFAULT true,
  unattended_allowed boolean NOT NULL DEFAULT false,
  unattended_enabled boolean NOT NULL DEFAULT false,
  max_unattended_risk_tier text NOT NULL DEFAULT 'low',
  unattended_allowed_classes text[] NOT NULL
    DEFAULT ARRAY['services','processes','temp_files','dns_cache','printing']::text[],
  max_unattended_per_hour integer NOT NULL DEFAULT 10,
  protected_resources jsonb NOT NULL DEFAULT '{"services":[],"paths":[],"registryKeys":[],"deviceTags":[]}'::jsonb,
  reviewer_model text,
  unattended_enabled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  unattended_enabled_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_policies_one_owner_chk') THEN
    ALTER TABLE ai_script_policies
      ADD CONSTRAINT ai_script_policies_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  -- unattended_enabled is an ORG grant; a partner row must never carry one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_policies_org_grant_chk') THEN
    ALTER TABLE ai_script_policies
      ADD CONSTRAINT ai_script_policies_org_grant_chk
      CHECK (org_id IS NOT NULL OR unattended_enabled = false);
  END IF;
  -- unattended_allowed is a PARTNER ceiling; an org row must never carry one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_policies_partner_ceiling_chk') THEN
    ALTER TABLE ai_script_policies
      ADD CONSTRAINT ai_script_policies_partner_ceiling_chk
      CHECK (partner_id IS NOT NULL OR unattended_allowed = false);
  END IF;
  -- high/critical are NEVER lane-eligible (spec §4.6 invariant 3).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_policies_tier_chk') THEN
    ALTER TABLE ai_script_policies
      ADD CONSTRAINT ai_script_policies_tier_chk
      CHECK (max_unattended_risk_tier IN ('low', 'medium'));
  END IF;
  -- Closed set: the classifier's TOUCH_CLASSES (roadmap §3.1). A class the
  -- classifier cannot emit must not be storable in an allowlist.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_policies_classes_chk') THEN
    ALTER TABLE ai_script_policies
      ADD CONSTRAINT ai_script_policies_classes_chk
      CHECK (unattended_allowed_classes <@ ARRAY[
        'registry','services','processes','files_system','files_user','temp_files',
        'network_egress','firewall','credentials','users_groups','packages',
        'scheduled_tasks','disk','boot','security_tooling','dns_cache','printing',
        'browser','shell_eval'
      ]::text[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_policies_per_hour_chk') THEN
    ALTER TABLE ai_script_policies
      ADD CONSTRAINT ai_script_policies_per_hour_chk
      CHECK (max_unattended_per_hour BETWEEN 0 AND 100);
  END IF;
END $$;

-- One row per owner. TOTAL (non-partial) uniques on purpose: Postgres never
-- treats two NULLs as equal in a unique index, so the partner rows (org_id
-- NULL) and org rows (partner_id NULL) coexist freely — and a total UNIQUE on
-- exactly (org_id) is what the org-merge `keep-survivor` policy requires
-- (orgMergeRegistry.integration.test.ts: the survivor's grant wins, the
-- loser's is dropped, exactly like ai_budgets / portal_branding).
CREATE UNIQUE INDEX IF NOT EXISTS ai_script_policies_org_uq
  ON ai_script_policies (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_script_policies_partner_uq
  ON ai_script_policies (partner_id);

ALTER TABLE ai_script_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_script_policies FORCE ROW LEVEL SECURITY;

-- ONE dual-axis FOR ALL policy. org_id is NULLABLE here, so the explicit
-- system branch IS required (unlike a shape-1 table).
DROP POLICY IF EXISTS ai_script_policies_isolation ON ai_script_policies;
CREATE POLICY ai_script_policies_isolation ON ai_script_policies
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

-- SEPARATE, additive, SELECT-ONLY partner-wide read branch
-- (template: 2026-10-05-110000-config-policy-partner-wide-select.sql). NEVER
-- appended to the FOR ALL policy's USING: Postgres consults FOR SELECT
-- policies only for reads, so this ORs into reads and nothing else —
-- appending it would also widen UPDATE/DELETE row targeting and let an org
-- admin delete their MSP's ceiling. LOAD-BEARING on the agent path:
-- middleware/agentAuth.ts sets currentPartnerId = device.partnerId (#4673
-- W02), so an agent-scoped read of the partner ceiling resolves through
-- exactly this branch. `=` not `IS NOT DISTINCT FROM`, so a NULL partner
-- never matches.
DROP POLICY IF EXISTS ai_script_policies_partner_wide_select ON ai_script_policies;
CREATE POLICY ai_script_policies_partner_wide_select
  ON ai_script_policies
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_script_policies TO breeze_app;

CREATE TABLE IF NOT EXISTS ai_script_lane_state (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  consecutive_failed_verifications integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'closed',
  opened_at timestamptz,
  opened_reason text,
  reset_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reset_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_lane_state_state_chk') THEN
    ALTER TABLE ai_script_lane_state
      ADD CONSTRAINT ai_script_lane_state_state_chk
      CHECK (state IN ('closed', 'open'));
  END IF;
END $$;

ALTER TABLE ai_script_lane_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_script_lane_state FORCE ROW LEVEL SECURITY;

-- Shape 1, org_id NOT NULL: the bare breeze_has_org_access(org_id) check with
-- NO separate system branch — that helper already returns TRUE for system
-- scope internally.
DROP POLICY IF EXISTS ai_script_lane_state_select ON ai_script_lane_state;
CREATE POLICY ai_script_lane_state_select ON ai_script_lane_state
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS ai_script_lane_state_insert ON ai_script_lane_state;
CREATE POLICY ai_script_lane_state_insert ON ai_script_lane_state
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS ai_script_lane_state_update ON ai_script_lane_state;
CREATE POLICY ai_script_lane_state_update ON ai_script_lane_state
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS ai_script_lane_state_delete ON ai_script_lane_state;
CREATE POLICY ai_script_lane_state_delete ON ai_script_lane_state
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_script_lane_state TO breeze_app;
