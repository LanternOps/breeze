-- Remote-session consent/notification: per-policy settings + denied session state.

-- 1) Settings table (mirrors config_policy_monitoring_settings shape)
CREATE TABLE IF NOT EXISTS config_policy_remote_access_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id UUID NOT NULL UNIQUE REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  session_prompt_mode TEXT NOT NULL DEFAULT 'notify',
  consent_unavailable_behavior TEXT NOT NULL DEFAULT 'proceed',
  notify_on_session_end BOOLEAN NOT NULL DEFAULT TRUE,
  show_active_indicator BOOLEAN NOT NULL DEFAULT TRUE,
  technician_identity_level TEXT NOT NULL DEFAULT 'name_email',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Value guards (idempotent: drop-then-add)
DO $$ BEGIN
  ALTER TABLE config_policy_remote_access_settings DROP CONSTRAINT IF EXISTS chk_ras_prompt_mode;
  ALTER TABLE config_policy_remote_access_settings ADD CONSTRAINT chk_ras_prompt_mode
    CHECK (session_prompt_mode IN ('off','notify','consent'));
  ALTER TABLE config_policy_remote_access_settings DROP CONSTRAINT IF EXISTS chk_ras_unavailable;
  ALTER TABLE config_policy_remote_access_settings ADD CONSTRAINT chk_ras_unavailable
    CHECK (consent_unavailable_behavior IN ('proceed','block'));
  ALTER TABLE config_policy_remote_access_settings DROP CONSTRAINT IF EXISTS chk_ras_identity;
  ALTER TABLE config_policy_remote_access_settings ADD CONSTRAINT chk_ras_identity
    CHECK (technician_identity_level IN ('name_email','name','generic'));
END $$;

-- 2) RLS: reach org via feature_link_id → config_policy_feature_links.config_policy_id
--    → configuration_policies.org_id (scalar subqueries keep EXISTS FROM = configuration_policies)
ALTER TABLE config_policy_remote_access_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_remote_access_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_remote_access_settings;
CREATE POLICY breeze_org_isolation_select ON config_policy_remote_access_settings FOR SELECT USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON config_policy_remote_access_settings FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_update ON config_policy_remote_access_settings FOR UPDATE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON config_policy_remote_access_settings FOR DELETE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);

-- 3) New terminal session state for an end-user-denied connection
-- Using top-level ADD VALUE IF NOT EXISTS (safer than DO $$ block inside transaction)
ALTER TYPE remote_session_status ADD VALUE IF NOT EXISTS 'denied';
