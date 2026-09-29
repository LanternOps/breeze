-- Multi-org report series W01 (spec docs/superpowers/specs/reports/
-- 2026-09-28-multi-org-report-series-design.md §3.2): what a scheduled run's
-- email did, recorded on the run itself. A run whose recipients resolved to
-- nobody used to be skipped silently.
--
--   delivery_status  NULL for ad-hoc runs and every run before this migration;
--                    'not_scheduled' for a manual run of a scheduled
--                    definition; otherwise the schedule worker's outcome:
--                    'sent' | 'partial' | 'no_recipients' | 'failed'.
--   recipient_count  the customer recipients the run resolved. For a
--                    non-series report that is its contacts plus its valid
--                    config.emailRecipients (there is no internal CC); a W02
--                    series child excludes its series' internal CC.
--
-- report_runs has no org_id (its tenancy is its parent report's) and is a
-- pre-clear entry outside CORE_ORG_CASCADE_DELETE_ORDER, so these columns need
-- no CORE_TENANT_EXPORT_POLICY classification (tenantExportPolicy.test.ts pins
-- report_runs' absence from the export policy). The existing FK-join RLS
-- policies on report_runs cover the new columns.
--
-- The index serves GET /reports' per-row "latest scheduled delivery" lookup
-- and every other per-report run read; report_runs had no report_id index.
--
-- Idempotent; no inner BEGIN/COMMIT; writes no rows (no scope elevation).

ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS delivery_status text;
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS recipient_count integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'report_runs_delivery_status_chk'
      AND conrelid = 'report_runs'::regclass
  ) THEN
    ALTER TABLE report_runs ADD CONSTRAINT report_runs_delivery_status_chk
      CHECK (
        delivery_status IS NULL
        OR delivery_status IN ('sent', 'partial', 'no_recipients', 'failed', 'not_scheduled')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'report_runs_recipient_count_chk'
      AND conrelid = 'report_runs'::regclass
  ) THEN
    ALTER TABLE report_runs ADD CONSTRAINT report_runs_recipient_count_chk
      CHECK (recipient_count IS NULL OR recipient_count >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS report_runs_report_id_created_at_idx
  ON report_runs (report_id, created_at DESC, id DESC);
