-- #8184 W01 (#8185): Update Rings own per-app block/pin rules.
--
-- Expand step only: adds the column, which nothing writes yet. The approval
-- evaluator reads it alongside the policy link's `apps` list (stricter verdict
-- wins), so an empty list changes no decision.
--
-- DDL only, no row writes, so no breeze.scope elevation is needed.
-- patch_policies is partner-axis (shape 3: partner_id, no org_id, no
-- device_id); no org cascade / merge / export registration applies to it.
ALTER TABLE patch_policies
  ADD COLUMN IF NOT EXISTS app_rules jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'patch_policies_app_rules_array_chk'
      AND conrelid = 'public.patch_policies'::regclass
  ) THEN
    ALTER TABLE patch_policies
      ADD CONSTRAINT patch_policies_app_rules_array_chk CHECK (jsonb_typeof(app_rules) = 'array');
  END IF;
END $$;
