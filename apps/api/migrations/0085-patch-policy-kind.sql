BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'patch_policy_kind') THEN
    CREATE TYPE patch_policy_kind AS ENUM ('ring', 'legacy');
  END IF;
END $$;

ALTER TABLE patch_policies
  ADD COLUMN IF NOT EXISTS kind patch_policy_kind NOT NULL DEFAULT 'ring';

UPDATE patch_policies
SET kind = 'legacy'
WHERE created_by IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM config_policy_feature_links fl
    WHERE fl.feature_type = 'patch'
      AND fl.feature_policy_id = patch_policies.id
  );

CREATE INDEX IF NOT EXISTS idx_patch_policies_org_kind
  ON patch_policies (org_id, kind);

COMMIT;
