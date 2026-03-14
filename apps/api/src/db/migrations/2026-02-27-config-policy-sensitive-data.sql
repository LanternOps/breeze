-- Add sensitive_data to config_feature_type enum
ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'sensitive_data';

-- Normalized settings table for sensitive_data feature links
CREATE TABLE IF NOT EXISTS config_policy_sensitive_data_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id UUID NOT NULL UNIQUE
    REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  detection_classes TEXT[] NOT NULL DEFAULT ARRAY['credential'],
  include_paths TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  exclude_paths TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  file_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  max_file_size_bytes INTEGER NOT NULL DEFAULT 104857600,
  workers INTEGER NOT NULL DEFAULT 4,
  timeout_seconds INTEGER NOT NULL DEFAULT 300,
  suppress_pattern_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  schedule_type VARCHAR(20) NOT NULL DEFAULT 'manual',
  interval_minutes INTEGER,
  cron VARCHAR(120),
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
