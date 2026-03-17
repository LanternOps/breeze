-- Add event_log feature type to config policies and create normalized settings table.
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block,
-- so we run it first outside the main transaction.

-- Step 1: Add enum value (idempotent, outside transaction)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'event_log'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'config_feature_type')
  ) THEN
    ALTER TYPE config_feature_type ADD VALUE 'event_log';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'software_policy'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'config_feature_type')
  ) THEN
    ALTER TYPE config_feature_type ADD VALUE 'software_policy';
  END IF;
END $$;

-- Step 2: Create the normalized settings table
CREATE TABLE IF NOT EXISTS config_policy_event_log_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id uuid NOT NULL UNIQUE
                  REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  retention_days              integer NOT NULL DEFAULT 30,
  max_events_per_cycle        integer NOT NULL DEFAULT 100,
  collect_categories          text[]  NOT NULL DEFAULT ARRAY['security','hardware','application','system'],
  minimum_level               event_log_level NOT NULL DEFAULT 'info',
  collection_interval_minutes integer NOT NULL DEFAULT 5,
  rate_limit_per_hour         integer NOT NULL DEFAULT 12000,
  enable_full_text_search     boolean NOT NULL DEFAULT true,
  enable_correlation          boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Step 3: RLS policy (join through feature_links → configuration_policies.org_id)
ALTER TABLE config_policy_event_log_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS config_policy_event_log_settings_org_isolation ON config_policy_event_log_settings;
CREATE POLICY config_policy_event_log_settings_org_isolation
  ON config_policy_event_log_settings
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1
      FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_event_log_settings.feature_link_id
        AND public.breeze_has_org_access(cp.org_id)
    )
  );

-- Step 4: Indexes
CREATE INDEX IF NOT EXISTS cpels_feature_link_id_idx
  ON config_policy_event_log_settings(feature_link_id);
