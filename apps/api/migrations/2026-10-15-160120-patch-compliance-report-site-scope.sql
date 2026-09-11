-- Persist the exact report-export authority used by asynchronous patch
-- compliance reports. Historical rows are deliberately non-executable and
-- non-downloadable: there is no safe way to infer their original site scope.

ALTER TABLE patch_compliance_reports
  ADD COLUMN IF NOT EXISTS execution_scope_version integer,
  ADD COLUMN IF NOT EXISTS execution_scope_kind varchar(32),
  ADD COLUMN IF NOT EXISTS execution_scope_site_ids uuid[],
  ADD COLUMN IF NOT EXISTS execution_scope_user_id uuid,
  ADD COLUMN IF NOT EXISTS execution_scope_fingerprint varchar(64),
  ADD COLUMN IF NOT EXISTS execution_scope_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_scope_principal_kind text;

-- patch_compliance_reports is ENABLE + FORCE RLS. autoMigrate may run as a
-- non-superuser table owner, so elect the explicit system scope before either
-- reconciliation UPDATE; otherwise both can silently match zero rows.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  classified_count bigint;
BEGIN
  UPDATE patch_compliance_reports
  SET execution_scope_version = 1,
      execution_scope_kind = 'legacy_unscoped',
      execution_scope_site_ids = NULL,
      execution_scope_user_id = requested_by,
      execution_scope_fingerprint = encode(
        sha256(convert_to(
          '{"version":1,"kind":"legacy_unscoped","orgId":"' || org_id::text || '"}',
          'UTF8'
        )),
        'hex'
      ),
      execution_scope_captured_at = CURRENT_TIMESTAMP,
      execution_scope_principal_kind = CASE
        WHEN requested_by IS NULL THEN NULL
        ELSE 'user'
      END
  WHERE execution_scope_version IS NULL
    AND execution_scope_kind IS NULL
    AND execution_scope_site_ids IS NULL
    AND execution_scope_user_id IS NULL
    AND execution_scope_fingerprint IS NULL
    AND execution_scope_captured_at IS NULL
    AND execution_scope_principal_kind IS NULL;

  GET DIAGNOSTICS classified_count = ROW_COUNT;
  RAISE WARNING 'classified % historical patch compliance reports as legacy_unscoped', classified_count;
END $$;

DO $$
DECLARE
  failed_count bigint;
BEGIN
  UPDATE patch_compliance_reports
  SET status = 'failed',
      completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
      updated_at = CURRENT_TIMESTAMP,
      error_message = 'Report must be regenerated after the authorization-scope upgrade'
  WHERE execution_scope_kind = 'legacy_unscoped'
    AND status IN ('pending', 'running');

  GET DIAGNOSTICS failed_count = ROW_COUNT;
  RAISE WARNING 'failed % pending or running legacy patch compliance reports', failed_count;
END $$;

-- The 'restricted' and 'unrestricted' arms below deliberately admit ONLY
-- execution_scope_principal_kind = 'user'. services/siteScope.ts can also emit
-- 'system' (a platform-authored report) and 'portal_user', and the `reports`
-- table's own shape check permits both — but nothing creates a patch compliance
-- report except GET /patches/compliance/report, which always resolves a staff
-- user. Restricting the shape here is the fail-closed choice: a forged
-- non-user envelope cannot be inserted at all. A future scheduled or
-- portal-initiated compliance report MUST widen this constraint (and the
-- worker's principal assertion) in a new migration rather than work around it.
ALTER TABLE patch_compliance_reports
  DROP CONSTRAINT IF EXISTS patch_compliance_reports_execution_scope_shape_chk;
ALTER TABLE patch_compliance_reports
  ADD CONSTRAINT patch_compliance_reports_execution_scope_shape_chk CHECK ((
    (
      execution_scope_version IS NULL
      AND execution_scope_kind IS NULL
      AND execution_scope_site_ids IS NULL
      AND execution_scope_user_id IS NULL
      AND execution_scope_fingerprint IS NULL
      AND execution_scope_captured_at IS NULL
      AND execution_scope_principal_kind IS NULL
    )
    OR
    (
      execution_scope_version = 1
      AND execution_scope_fingerprint ~ '^[0-9a-f]{64}$'
      AND execution_scope_captured_at IS NOT NULL
      AND (
        (
          execution_scope_kind = 'restricted'
          AND execution_scope_site_ids IS NOT NULL
          AND cardinality(execution_scope_site_ids) > 0
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_user_id = requested_by
          AND execution_scope_principal_kind = 'user'
        )
        OR
        (
          execution_scope_kind = 'unrestricted'
          AND execution_scope_site_ids IS NULL
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_user_id = requested_by
          AND execution_scope_principal_kind = 'user'
        )
        OR
        (
          execution_scope_kind = 'legacy_unscoped'
          AND execution_scope_site_ids IS NULL
          AND execution_scope_user_id IS NOT DISTINCT FROM requested_by
          AND execution_scope_principal_kind IS NOT DISTINCT FROM
            CASE WHEN requested_by IS NULL THEN NULL ELSE 'user' END
        )
      )
    )
  ) IS TRUE);
