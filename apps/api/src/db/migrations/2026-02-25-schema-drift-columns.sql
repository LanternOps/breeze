-- Add columns that were defined in Drizzle schema but never migrated.
-- Detected by scripts/check-schema-drift.ts

-- ai_budgets: approval_mode
ALTER TABLE ai_budgets ADD COLUMN IF NOT EXISTS approval_mode ai_approval_mode NOT NULL DEFAULT 'per_step';

-- automation_policy_compliance: config_policy_id, config_item_name
ALTER TABLE automation_policy_compliance ADD COLUMN IF NOT EXISTS config_policy_id UUID;
ALTER TABLE automation_policy_compliance ADD COLUMN IF NOT EXISTS config_item_name VARCHAR(200);
CREATE INDEX IF NOT EXISTS apc_config_policy_id_idx ON automation_policy_compliance (config_policy_id);

-- automation_runs: config_policy_id, config_item_name
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS config_policy_id UUID;
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS config_item_name VARCHAR(200);

-- patch_jobs: config_policy_id
ALTER TABLE patch_jobs ADD COLUMN IF NOT EXISTS config_policy_id UUID;
