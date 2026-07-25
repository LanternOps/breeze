-- Persist immutable site-scope provenance for report definitions and runs.
-- All columns remain nullable during the mixed-version old-writer window.

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS execution_scope_version integer,
  ADD COLUMN IF NOT EXISTS execution_scope_kind varchar(32),
  ADD COLUMN IF NOT EXISTS execution_scope_site_ids uuid[],
  ADD COLUMN IF NOT EXISTS execution_scope_user_id uuid,
  ADD COLUMN IF NOT EXISTS execution_scope_fingerprint varchar(64),
  ADD COLUMN IF NOT EXISTS execution_scope_captured_at timestamptz;

ALTER TABLE report_runs
  ADD COLUMN IF NOT EXISTS execution_scope_version integer,
  ADD COLUMN IF NOT EXISTS execution_scope_kind varchar(32),
  ADD COLUMN IF NOT EXISTS execution_scope_site_ids uuid[],
  ADD COLUMN IF NOT EXISTS execution_scope_user_id uuid,
  ADD COLUMN IF NOT EXISTS execution_scope_fingerprint varchar(64),
  ADD COLUMN IF NOT EXISTS execution_scope_captured_at timestamptz;

DO $$
DECLARE
  classified_count bigint;
BEGIN
  UPDATE reports
  SET execution_scope_version = 1,
      execution_scope_kind = 'legacy_unscoped',
      execution_scope_site_ids = NULL,
      execution_scope_user_id = created_by,
      execution_scope_fingerprint = encode(
        sha256(convert_to(
          '{"version":1,"kind":"legacy_unscoped","orgId":"' || org_id::text || '"}',
          'UTF8'
        )),
        'hex'
      ),
      execution_scope_captured_at = CURRENT_TIMESTAMP
  WHERE execution_scope_version IS NULL
    AND execution_scope_kind IS NULL
    AND execution_scope_site_ids IS NULL
    AND execution_scope_user_id IS NULL
    AND execution_scope_fingerprint IS NULL
    AND execution_scope_captured_at IS NULL;

  GET DIAGNOSTICS classified_count = ROW_COUNT;
  RAISE WARNING 'classified % historical reports as legacy_unscoped', classified_count;
END $$;

DO $$
DECLARE
  classified_count bigint;
BEGIN
  UPDATE report_runs AS run
  SET execution_scope_version = 1,
      execution_scope_kind = 'legacy_unscoped',
      execution_scope_site_ids = NULL,
      execution_scope_user_id = report.created_by,
      execution_scope_fingerprint = encode(
        sha256(convert_to(
          '{"version":1,"kind":"legacy_unscoped","orgId":"' || report.org_id::text || '"}',
          'UTF8'
        )),
        'hex'
      ),
      execution_scope_captured_at = CURRENT_TIMESTAMP
  FROM reports AS report
  WHERE run.report_id = report.id
    AND run.execution_scope_version IS NULL
    AND run.execution_scope_kind IS NULL
    AND run.execution_scope_site_ids IS NULL
    AND run.execution_scope_user_id IS NULL
    AND run.execution_scope_fingerprint IS NULL
    AND run.execution_scope_captured_at IS NULL;

  GET DIAGNOSTICS classified_count = ROW_COUNT;
  RAISE WARNING 'classified % historical report runs as legacy_unscoped', classified_count;
END $$;

ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_execution_scope_shape_chk;
ALTER TABLE reports ADD CONSTRAINT reports_execution_scope_shape_chk CHECK ((
  (
    execution_scope_version IS NULL
    AND execution_scope_kind IS NULL
    AND execution_scope_site_ids IS NULL
    AND execution_scope_user_id IS NULL
    AND execution_scope_fingerprint IS NULL
    AND execution_scope_captured_at IS NULL
  )
  OR
  (
    execution_scope_version = 1
    AND execution_scope_fingerprint IS NOT NULL
    AND execution_scope_captured_at IS NOT NULL
    AND (
      (
        execution_scope_kind = 'restricted'
        AND execution_scope_site_ids IS NOT NULL
        AND execution_scope_user_id IS NOT NULL
      )
      OR
      (
        execution_scope_kind = 'unrestricted'
        AND execution_scope_site_ids IS NULL
        AND execution_scope_user_id IS NOT NULL
      )
      OR
      (
        execution_scope_kind = 'legacy_unscoped'
        AND execution_scope_site_ids IS NULL
      )
    )
  )
) IS TRUE);

ALTER TABLE report_runs DROP CONSTRAINT IF EXISTS report_runs_execution_scope_shape_chk;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_execution_scope_shape_chk CHECK ((
  (
    execution_scope_version IS NULL
    AND execution_scope_kind IS NULL
    AND execution_scope_site_ids IS NULL
    AND execution_scope_user_id IS NULL
    AND execution_scope_fingerprint IS NULL
    AND execution_scope_captured_at IS NULL
  )
  OR
  (
    execution_scope_version = 1
    AND execution_scope_fingerprint IS NOT NULL
    AND execution_scope_captured_at IS NOT NULL
    AND (
      (
        execution_scope_kind = 'restricted'
        AND execution_scope_site_ids IS NOT NULL
        AND execution_scope_user_id IS NOT NULL
      )
      OR
      (
        execution_scope_kind = 'unrestricted'
        AND execution_scope_site_ids IS NULL
        AND execution_scope_user_id IS NOT NULL
      )
      OR
      (
        execution_scope_kind = 'legacy_unscoped'
        AND execution_scope_site_ids IS NULL
      )
    )
  )
) IS TRUE);
