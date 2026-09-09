-- Durable least-authority provenance for recurring sensitive-data scans.
-- Historical recurring policies are disabled rather than inheriting the
-- scheduler's system authority. An execute-authorized MFA reapproval is
-- required to re-enable them through the API.

ALTER TABLE sensitive_data_policies
  ADD COLUMN IF NOT EXISTS execution_authority_version integer,
  ADD COLUMN IF NOT EXISTS execution_authority_kind varchar(32),
  ADD COLUMN IF NOT EXISTS execution_authority_site_ids uuid[],
  ADD COLUMN IF NOT EXISTS execution_authority_user_id uuid,
  ADD COLUMN IF NOT EXISTS execution_authority_principal_kind varchar(16),
  ADD COLUMN IF NOT EXISTS execution_authority_fingerprint varchar(64),
  ADD COLUMN IF NOT EXISTS execution_authority_captured_at timestamptz;

-- The policy table is FORCE-RLS. Migrations run as its owner in some
-- deployments, so elect the system policy for the bounded legacy transition.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  disabled_count bigint;
BEGIN
  UPDATE sensitive_data_policies
  SET is_active = false,
      updated_at = CURRENT_TIMESTAMP
  WHERE is_active = true
    AND COALESCE(schedule->>'enabled', 'true') <> 'false'
    AND schedule->>'type' IN ('interval', 'cron')
    AND execution_authority_version IS NULL
    AND execution_authority_kind IS NULL
    AND execution_authority_site_ids IS NULL
    AND execution_authority_user_id IS NULL
    AND execution_authority_principal_kind IS NULL
    AND execution_authority_fingerprint IS NULL
    AND execution_authority_captured_at IS NULL;

  GET DIAGNOSTICS disabled_count = ROW_COUNT;
  RAISE WARNING 'disabled % legacy recurring sensitive-data policies pending execute-authorized reapproval', disabled_count;
END $$;

ALTER TABLE sensitive_data_policies
  DROP CONSTRAINT IF EXISTS sensitive_data_policies_execution_authority_shape_chk;
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
    )
    OR
    (
      execution_authority_version = 1
      AND execution_authority_fingerprint ~ '^[0-9a-f]{64}$'
      AND execution_authority_captured_at IS NOT NULL
      AND (
        (
          execution_authority_principal_kind = 'user'
          AND execution_authority_user_id IS NOT NULL
        )
        OR
        (
          execution_authority_principal_kind = 'system'
          AND execution_authority_user_id IS NULL
        )
      )
      AND (
        (
          org_id IS NOT NULL
          AND partner_id IS NULL
          AND execution_authority_kind = 'organization_restricted'
          AND execution_authority_site_ids IS NOT NULL
          AND cardinality(execution_authority_site_ids) > 0
        )
        OR
        (
          org_id IS NOT NULL
          AND partner_id IS NULL
          AND execution_authority_kind = 'organization_unrestricted'
          AND execution_authority_site_ids IS NULL
        )
        OR
        (
          org_id IS NULL
          AND partner_id IS NOT NULL
          AND execution_authority_kind = 'partner_unrestricted'
          AND execution_authority_site_ids IS NULL
        )
      )
    )
  ) IS TRUE) NOT VALID;

ALTER TABLE sensitive_data_policies
  VALIDATE CONSTRAINT sensitive_data_policies_execution_authority_shape_chk;
