-- config_policy_backup_settings: normalized schedule/retention for backup feature links
CREATE TABLE IF NOT EXISTS config_policy_backup_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id UUID NOT NULL REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  schedule JSONB NOT NULL DEFAULT '{}',
  retention JSONB NOT NULL DEFAULT '{}',
  paths JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT config_policy_backup_settings_feature_link_id_unique UNIQUE (feature_link_id)
);

CREATE INDEX IF NOT EXISTS idx_config_policy_backup_settings_org
  ON config_policy_backup_settings(org_id);

CREATE INDEX IF NOT EXISTS idx_config_policy_backup_settings_feature_link
  ON config_policy_backup_settings(feature_link_id);

-- Add feature_link_id column to backup_jobs for config policy tracking
DO $$ BEGIN
  ALTER TABLE backup_jobs ADD COLUMN feature_link_id UUID
    REFERENCES config_policy_feature_links(id);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_backup_jobs_feature_link_id
  ON backup_jobs(feature_link_id);

-- Drop old FK from backup_jobs.policy_id → backup_policies
DO $$ BEGIN
  ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_policy_id_backup_policies_id_fk;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- Mark backup_policies as deprecated
COMMENT ON TABLE backup_policies IS 'DEPRECATED: replaced by config_policy_backup_settings + config_policy_feature_links';
