-- IOC scans: auto-quarantine dispatches only under a stored execution authority.
--
-- 1. config_policy_feature_links gains the creator-bound authority envelope
--    used by recurring sensitive-data policies (owner = the link's policy).
--    A `security` link carries one while auto-quarantine is on and it was
--    saved by a user with devices:execute + MFA.
-- 2. Links that exist when this runs are marked execution_authority_legacy =
--    'grandfathered'. No authority is invented: dispatch checks the policy's
--    created_by LIVE (active + devices:execute for the owner); while it holds,
--    quarantine keeps working, and the first failure flips the link to
--    'revoked' (detect-only, re-approval required). Any later write through
--    the feature-link service clears the marker for good. The marker is
--    written only in the run that adds the column, so a replay never
--    re-grandfathers a link.
-- 3. security_scans.auto_quarantine_suppressed_reason records, per scan, why
--    a requested auto-quarantine was dropped at dispatch.
--
-- config_policy_feature_links has no org_id (tenanted through its policy), so
-- it carries no tenant-export classification. Idempotent; system scope is
-- elected before any write under FORCE ROW LEVEL SECURITY.

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
  grandfathered bigint;
  lock_orgs uuid[];
  lock_partners uuid[];
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'config_policy_feature_links'
       AND column_name = 'execution_authority_legacy'
  ) THEN
    ALTER TABLE config_policy_feature_links ADD COLUMN execution_authority_legacy varchar(16);

    -- Configuration-family partner-export pre-locks (#5912): partners
    -- exclusive, then their orgs, before the write. The set is every org the
    -- config_policy_feature_links trigger touches for the links marked below
    -- (the policy's own org, or every org of its partner for a partner-wide
    -- policy) and those orgs' partners. Empty (a no-op) on a clean table.
    SELECT
      COALESCE(array_agg(DISTINCT o.id ORDER BY o.id), ARRAY[]::uuid[]),
      COALESCE(array_agg(DISTINCT o.partner_id ORDER BY o.partner_id), ARRAY[]::uuid[])
      INTO lock_orgs, lock_partners
      FROM config_policy_feature_links l
      JOIN configuration_policies cp ON cp.id = l.config_policy_id
      JOIN organizations o
        ON o.id = cp.org_id OR (cp.org_id IS NULL AND o.partner_id = cp.partner_id)
     WHERE l.feature_type = 'security';
    PERFORM public.breeze_partner_export_lock_partners_exclusive(lock_partners);
    PERFORM public.breeze_partner_export_lock_orgs_under_exclusive_partners(lock_orgs, lock_partners);

    -- Only links where auto-quarantine is effectively on (absent = the shared
    -- default, on) need grandfathering; others never consult authority.
    UPDATE config_policy_feature_links
       SET execution_authority_legacy = 'grandfathered'
     WHERE feature_type = 'security'
       AND execution_authority_generation IS NULL
       AND COALESCE(
         CASE WHEN jsonb_typeof(inline_settings->'autoQuarantine') = 'boolean'
              THEN (inline_settings->>'autoQuarantine')::boolean END,
         true) = true;
    GET DIAGNOSTICS grandfathered = ROW_COUNT;
    RAISE WARNING 'security: % auto-quarantine link(s) grandfathered on their policy creator pending re-approval', grandfathered;
  END IF;
END $$;

ALTER TABLE config_policy_feature_links
  DROP CONSTRAINT IF EXISTS config_policy_feature_links_execution_authority_legacy_chk;

-- A stamped link is never on the legacy path.
ALTER TABLE config_policy_feature_links
  ADD CONSTRAINT config_policy_feature_links_execution_authority_legacy_chk CHECK (
    execution_authority_legacy IS NULL
    OR (execution_authority_legacy IN ('grandfathered', 'revoked') AND execution_authority_generation IS NULL)
  );
