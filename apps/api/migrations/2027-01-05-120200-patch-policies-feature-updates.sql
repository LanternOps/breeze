-- Update Rings decide whether their devices receive Windows feature releases
-- ("Windows 11, version 25H2"): block (default), allow, or pin to one release.
--
-- Shape (validated by @breeze/shared ringFeatureUpdatesSchema):
--   {"mode":"block"} | {"mode":"allow"}
--   | {"mode":"pin","product":"windows-11"|"windows-10","targetVersion":"25H2"}
--
-- The default is block, which is exactly what the agent did before this
-- control existed (its local patch_exclude_feature_updates defaulted to true),
-- so every existing ring and every device without a ring keeps its behaviour.
--
-- DDL only, no row writes, so no breeze.scope elevation is needed.
-- patch_policies is partner-axis (shape 3: partner_id, no org_id, no
-- device_id); no org cascade / merge / export registration applies to it.
ALTER TABLE patch_policies
  ADD COLUMN IF NOT EXISTS feature_updates jsonb NOT NULL DEFAULT '{"mode":"block"}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'patch_policies_feature_updates_object_chk'
      AND conrelid = 'public.patch_policies'::regclass
  ) THEN
    ALTER TABLE patch_policies
      ADD CONSTRAINT patch_policies_feature_updates_object_chk CHECK (jsonb_typeof(feature_updates) = 'object');
  END IF;
END $$;
