-- Add the `vulnerability` config-policy feature type (BE-16 correlation gating).
-- Pattern B (inline settings only): a single `{ enabled: boolean }` toggle that
-- gates per-device vulnerability correlation. No normalized settings table — the
-- toggle lives in config_policy_feature_links.inline_settings (pure JSONB), like
-- warranty/helper/pam. Default behavior with no policy assigned = disabled.
--
-- ALTER TYPE ... ADD VALUE is transaction-safe here because the new value is NOT
-- used elsewhere in this migration (no table references it) — Postgres 12+ allows
-- ADD VALUE inside the transaction autoMigrate wraps each file in, as long as the
-- value isn't consumed in that same transaction. (0029-event-log-policy-settings.sql
-- carries an older "cannot run inside a transaction" note that predates PG12 and is
-- now inaccurate under autoMigrate — don't follow it.) The idempotent pg_enum
-- existence guard below uses the same pattern as 0029.

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
