-- Rotate recurring sensitive-data approvals with a collision-safe generation.
-- A queued scan is admitted only by the exact policy approval that created it.

ALTER TABLE sensitive_data_policies
  ADD COLUMN IF NOT EXISTS execution_authority_generation uuid;

ALTER TABLE sensitive_data_scans
  ADD COLUMN IF NOT EXISTS policy_authority_generation uuid;

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE sensitive_data_policies
  DROP CONSTRAINT IF EXISTS sensitive_data_policies_execution_authority_shape_chk;

DO $$
DECLARE
  disabled_count bigint;
BEGIN
  UPDATE sensitive_data_policies
  SET is_active = false,
      execution_authority_version = NULL,
      execution_authority_kind = NULL,
      execution_authority_site_ids = NULL,
      execution_authority_user_id = NULL,
      execution_authority_principal_kind = NULL,
      execution_authority_fingerprint = NULL,
      execution_authority_captured_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  WHERE execution_authority_generation IS NULL
    AND (
      execution_authority_version IS NOT NULL
      OR execution_authority_kind IS NOT NULL
      OR execution_authority_site_ids IS NOT NULL
      OR execution_authority_user_id IS NOT NULL
      OR execution_authority_principal_kind IS NOT NULL
      OR execution_authority_fingerprint IS NOT NULL
      OR execution_authority_captured_at IS NOT NULL
    );
  GET DIAGNOSTICS disabled_count = ROW_COUNT;
  RAISE WARNING 'disabled % pre-generation recurring sensitive-data approvals pending reapproval', disabled_count;
END $$;

ALTER TABLE sensitive_data_policies
  ADD CONSTRAINT sensitive_data_policies_execution_authority_shape_chk CHECK ((
    (
      execution_authority_version IS NULL
      AND execution_authority_kind IS NULL
      AND execution_authority_site_ids IS NULL
      AND execution_authority_user_id IS NULL
      AND execution_authority_principal_kind IS NULL
      AND execution_authority_fingerprint IS NULL
      AND execution_authority_captured_at IS NULL
      AND execution_authority_generation IS NULL
    )
    OR
    (
      execution_authority_version = 1
      AND execution_authority_fingerprint ~ '^[0-9a-f]{64}$'
      AND execution_authority_captured_at IS NOT NULL
      AND execution_authority_generation IS NOT NULL
      AND (
        (execution_authority_principal_kind = 'user' AND execution_authority_user_id IS NOT NULL)
        OR
        (execution_authority_principal_kind = 'system' AND execution_authority_user_id IS NULL)
      )
      AND (
        (
          org_id IS NOT NULL AND partner_id IS NULL
          AND execution_authority_kind = 'organization_restricted'
          AND execution_authority_site_ids IS NOT NULL
          AND cardinality(execution_authority_site_ids) > 0
        )
        OR
        (
          org_id IS NOT NULL AND partner_id IS NULL
          AND execution_authority_kind = 'organization_unrestricted'
          AND execution_authority_site_ids IS NULL
        )
        OR
        (
          org_id IS NULL AND partner_id IS NOT NULL
          AND execution_authority_kind = 'partner_unrestricted'
          AND execution_authority_site_ids IS NULL
        )
      )
    )
  ) IS TRUE) NOT VALID;

ALTER TABLE sensitive_data_policies
  VALIDATE CONSTRAINT sensitive_data_policies_execution_authority_shape_chk;
