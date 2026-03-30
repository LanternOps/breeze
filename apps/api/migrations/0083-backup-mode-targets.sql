-- Add backup_mode enum and targets column to config_policy_backup_settings
-- Idempotent: safe to re-run

DO $$ BEGIN
  CREATE TYPE backup_mode_enum AS ENUM ('file', 'hyperv', 'mssql', 'system_image');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE config_policy_backup_settings
  ADD COLUMN IF NOT EXISTS backup_mode backup_mode_enum NOT NULL DEFAULT 'file';

ALTER TABLE config_policy_backup_settings
  ADD COLUMN IF NOT EXISTS targets jsonb NOT NULL DEFAULT '{}';

-- Migrate existing rows: copy paths into targets for file mode
UPDATE config_policy_backup_settings
SET targets = jsonb_build_object('paths', COALESCE(paths, '[]'::jsonb))
WHERE paths IS NOT NULL AND paths != '[]'::jsonb
  AND (targets = '{}'::jsonb);
