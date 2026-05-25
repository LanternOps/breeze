-- Strip DELETE/UPDATE grants from breeze_app on audit_logs. RLS policies allowed
-- these implicitly; this revoke ensures no role + RLS combination can mutate.
REVOKE UPDATE, DELETE ON TABLE audit_logs FROM breeze_app;

-- Belt-and-suspenders: a trigger that raises on any mutation. Survives a future
-- GRANT typo and surfaces a clear error message.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'audit log is append-only',
    HINT = 'audit_logs entries cannot be modified or deleted. Retention purging uses a separate role; see jobs/auditRetention.';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_block_update ON audit_logs;
CREATE TRIGGER audit_log_block_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

DROP TRIGGER IF EXISTS audit_log_block_delete ON audit_logs;
CREATE TRIGGER audit_log_block_delete BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
