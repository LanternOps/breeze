-- Add the `system_protection` config-policy feature type (#4609, W03 #4754).
--
-- Inline settings only: the Windows System Restore checkpoint toggles live in
-- config_policy_feature_links.inline_settings (JSONB), like vulnerability /
-- device_lifecycle. No normalized settings table, so no new RLS policy and no
-- cascade/export registration. The parent configuration_policies row is already
-- dual-axis (org_id XOR partner_id), so partner-wide authoring works unchanged.
--
-- ALTER TYPE ... ADD VALUE is transaction-safe here because the new value is NOT
-- used elsewhere in this file -- Postgres 12+ allows ADD VALUE inside the
-- transaction autoMigrate wraps each file in, as long as the value isn't consumed
-- in that same transaction. That is why this file adds the value and nothing else.
-- Precedent: 2026-06-29-vuln-config-feature-type.sql.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'system_protection'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'config_feature_type')
  ) THEN
    ALTER TYPE config_feature_type ADD VALUE 'system_protection';
  END IF;
END $$;
