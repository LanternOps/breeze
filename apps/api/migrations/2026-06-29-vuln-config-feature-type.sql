-- Add the `vulnerability` config-policy feature type (BE-16 correlation gating).
-- Pattern B (inline settings only): a single `{ enabled: boolean }` toggle that
-- gates per-device vulnerability correlation. No normalized settings table — the
-- toggle lives in config_policy_feature_links.inline_settings (pure JSONB), like
-- warranty/helper/pam. Default behavior with no policy assigned = disabled.
--
-- ALTER TYPE ... ADD VALUE is transaction-safe here because the new value is NOT
-- used elsewhere in this migration (no table references it). Idempotent guard via
-- pg_enum existence check, mirroring 0029-event-log-policy-settings.sql.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'vulnerability'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'config_feature_type')
  ) THEN
    ALTER TYPE config_feature_type ADD VALUE 'vulnerability';
  END IF;
END $$;
