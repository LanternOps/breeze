-- IOC scans: auto-quarantine dispatches only under a stored execution authority.
--
-- 1. config_policy_feature_links gains the creator-bound authority envelope
--    used by recurring sensitive-data policies (owner = the link's policy).
--    A `security` link carries one while auto-quarantine is on and it was
--    saved by a user with devices:execute + MFA. Not backfilled: every
--    existing security link with auto-quarantine on (the shared default) runs
--    detect-only until it is saved once more by such a user.
-- 2. security_scans.auto_quarantine_suppressed_reason records, per scan, why
--    a requested auto-quarantine was dropped at dispatch.
--
-- config_policy_feature_links has no org_id (tenanted through its policy), so
-- it carries no tenant-export classification. Idempotent; system scope is
-- elected before the (read-only) count under FORCE ROW LEVEL SECURITY.

ALTER TABLE config_policy_feature_links
  ADD COLUMN IF NOT EXISTS execution_authority_version integer,
  ADD COLUMN IF NOT EXISTS execution_authority_kind varchar(32),
  ADD COLUMN IF NOT EXISTS execution_authority_site_ids uuid[],
  ADD COLUMN IF NOT EXISTS execution_authority_user_id uuid,
  ADD COLUMN IF NOT EXISTS execution_authority_principal_kind varchar(16),
  ADD COLUMN IF NOT EXISTS execution_authority_fingerprint varchar(64),
  ADD COLUMN IF NOT EXISTS execution_authority_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_authority_generation uuid;

ALTER TABLE security_scans
  ADD COLUMN IF NOT EXISTS auto_quarantine_suppressed_reason varchar(64);

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE config_policy_feature_links
  DROP CONSTRAINT IF EXISTS config_policy_feature_links_execution_authority_shape_chk;

-- Owner-axis consistency (org vs partner kind) is verified by the fingerprint
-- at dispatch; the owner lives on configuration_policies, not on this row.
ALTER TABLE config_policy_feature_links
  ADD CONSTRAINT config_policy_feature_links_execution_authority_shape_chk CHECK ((
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
          execution_authority_kind = 'organization_restricted'
          AND execution_authority_site_ids IS NOT NULL
          AND cardinality(execution_authority_site_ids) > 0
        )
        OR
        (
          execution_authority_kind IN ('organization_unrestricted', 'partner_unrestricted')
          AND execution_authority_site_ids IS NULL
        )
      )
    )
  ) IS TRUE) NOT VALID;

ALTER TABLE config_policy_feature_links
  VALIDATE CONSTRAINT config_policy_feature_links_execution_authority_shape_chk;

DO $$
DECLARE
  detect_only_links bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT count(*) INTO detect_only_links
    FROM config_policy_feature_links
   WHERE feature_type = 'security'
     AND execution_authority_generation IS NULL
     AND COALESCE(
       CASE WHEN jsonb_typeof(inline_settings->'autoQuarantine') = 'boolean'
            THEN (inline_settings->>'autoQuarantine')::boolean END,
       true) = true;
  IF detect_only_links > 0 THEN
    RAISE WARNING 'security: % security feature link(s) with auto-quarantine run detect-only until re-approved', detect_only_links;
  END IF;
END $$;
