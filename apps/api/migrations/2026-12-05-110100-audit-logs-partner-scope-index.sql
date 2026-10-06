-- @no-transaction
-- audit_logs: partial index for the partner-scope read branch + VALIDATE of the
-- partner/org CHECK (#7696). Companion to 2026-12-05-110000-audit-logs-partner-scope.sql.
--
-- The Audit Trail's partner-scope branch is
--   org_id IS NULL AND partner_id = <caller partner>  ORDER BY timestamp DESC
-- Partner-attributed rows are a small slice of audit_logs (agent telemetry,
-- the bulk of the table, is always org-scoped), so a partial index over exactly
-- those rows stays small and turns the branch into an index range scan instead
-- of walking the org_id-IS-NULL heap.
--
-- CREATE INDEX CONCURRENTLY: every agent request inserts into audit_logs.
-- IF NOT EXISTS keeps re-application a no-op. An interrupted CONCURRENTLY build
-- leaves an INVALID index that IF NOT EXISTS would silently accept, so the DO
-- block fails loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY audit_logs_partner_scope_idx, then let
-- autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_partner_scope_idx
  ON public.audit_logs (partner_id, "timestamp" DESC)
  WHERE org_id IS NULL AND partner_id IS NOT NULL;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.audit_logs'::regclass
     AND c.relname = 'audit_logs_partner_scope_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'audit_logs partner-scope index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;

-- VALIDATE takes SHARE UPDATE EXCLUSIVE, which does not block INSERTs, so the
-- scan runs alongside live audit writes. Re-validating an already-valid
-- constraint is a no-op.
ALTER TABLE public.audit_logs VALIDATE CONSTRAINT audit_logs_partner_only_without_org_chk;
