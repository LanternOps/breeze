-- TRUNCATE bypasses the row-level audit_log_block_update/delete triggers
-- entirely. The append-only guarantee was therefore relying solely on the
-- absence of a TRUNCATE privilege grant — a single future engineer adding
-- TRUNCATE to a blanket grant (or to a role breeze_app inherits) would
-- silently re-open the bypass. Add an explicit statement-level trigger.
--
-- TRUNCATE triggers MUST be FOR EACH STATEMENT; the row-level function
-- audit_log_immutable receives no OLD/NEW and can't return a row, so we
-- keep a distinct function for it.

CREATE OR REPLACE FUNCTION audit_log_block_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'audit log is append-only',
    HINT = 'TRUNCATE is not permitted on audit_logs. Retention pruning uses per-row DELETE through breeze_audit_admin; see jobs/auditRetention.ts.';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_block_truncate ON audit_logs;
CREATE TRIGGER audit_log_block_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_truncate();

-- Belt-and-suspenders REVOKE — the trigger fires before the privilege check
-- could short-circuit; the REVOKE makes the failure mode clearer (permission
-- denied vs trigger exception) for a future audit-trail forensic review.
REVOKE TRUNCATE ON TABLE audit_logs FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    REVOKE TRUNCATE ON TABLE audit_logs FROM breeze_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_audit_admin') THEN
    REVOKE TRUNCATE ON TABLE audit_logs FROM breeze_audit_admin;
  END IF;
END $$;
