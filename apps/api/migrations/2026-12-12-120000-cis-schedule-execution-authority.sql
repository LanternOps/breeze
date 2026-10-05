-- CIS hardening: recurring baseline scans carry a stored execution authority,
-- and the CIS write/remediate/approve routes now require devices:execute + MFA.
--
-- 1. cis_baselines gains the same creator-bound authority envelope as
--    sensitive_data_policies (version, kind, site ceiling, approving user,
--    fingerprint, capture time, generation). The scheduler re-resolves it live
--    before every scheduled dispatch.
-- 2. Rows that exist when this runs carry no envelope and are marked
--    execution_authority_legacy = 'grandfathered'. No authority is invented:
--    the scheduler checks the row's created_by LIVE at each dispatch (active +
--    devices:execute for the owner) and flips the row to 'revoked' — paused,
--    re-approval required — the first time that fails. Any save (which always
--    requires devices:execute + MFA) clears the marker for good. The marker is
--    written only in the same run that adds the column, so a replay never
--    re-grandfathers a row that has since left the legacy path.
--
-- Remediation actions need no column: dispatch re-checks the approver live.
--
-- Idempotent. Elects system scope before any write (FORCE ROW LEVEL SECURITY).

ALTER TABLE cis_baselines
  ADD COLUMN IF NOT EXISTS execution_authority_version integer,
  ADD COLUMN IF NOT EXISTS execution_authority_kind varchar(32),
  ADD COLUMN IF NOT EXISTS execution_authority_site_ids uuid[],
  ADD COLUMN IF NOT EXISTS execution_authority_user_id uuid,
  ADD COLUMN IF NOT EXISTS execution_authority_principal_kind varchar(16),
  ADD COLUMN IF NOT EXISTS execution_authority_fingerprint varchar(64),
  ADD COLUMN IF NOT EXISTS execution_authority_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_authority_generation uuid;

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE cis_baselines
  DROP CONSTRAINT IF EXISTS cis_baselines_execution_authority_shape_chk;

ALTER TABLE cis_baselines
  ADD CONSTRAINT cis_baselines_execution_authority_shape_chk CHECK ((
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

ALTER TABLE cis_baselines
  VALIDATE CONSTRAINT cis_baselines_execution_authority_shape_chk;

DO $$
DECLARE
  grandfathered bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'cis_baselines'
       AND column_name = 'execution_authority_legacy'
  ) THEN
    ALTER TABLE cis_baselines ADD COLUMN execution_authority_legacy varchar(16);

    UPDATE cis_baselines
       SET execution_authority_legacy = 'grandfathered'
     WHERE execution_authority_generation IS NULL;
    GET DIAGNOSTICS grandfathered = ROW_COUNT;
    RAISE WARNING 'cis: % existing baseline(s) grandfathered on their creator pending re-approval', grandfathered;
  END IF;
END $$;

ALTER TABLE cis_baselines
  DROP CONSTRAINT IF EXISTS cis_baselines_execution_authority_legacy_chk;

-- A stamped row is never on the legacy path.
ALTER TABLE cis_baselines
  ADD CONSTRAINT cis_baselines_execution_authority_legacy_chk CHECK (
    execution_authority_legacy IS NULL
    OR (execution_authority_legacy IN ('grandfathered', 'revoked') AND execution_authority_generation IS NULL)
  );
