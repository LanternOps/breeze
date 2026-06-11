-- Audit retention re-anchors the hash chain after pruning.
--
-- Migration -i- gave breeze_audit_admin the DELETE privilege and extended
-- audit_log_immutable() to honor breeze.allow_audit_retention='1' for
-- DELETE. That alone breaks audit_log_verify_chain(): the new oldest
-- surviving row in each org still references the deleted row's checksum
-- via prev_checksum, so the next verifier walk (which starts with
-- prev=NULL) flags it as a break.
--
-- Fix: extend the trigger to also honor the GUC for UPDATE, and grant
-- UPDATE on audit_logs to breeze_audit_admin. The retention worker now
-- runs DELETE + a single re-anchor UPDATE in the same transaction; the
-- GUC + role combo remains required for both statements.
--
-- Defense-in-depth posture is unchanged: a session must BOTH switch into
-- breeze_audit_admin AND set the GUC inside the same transaction. The
-- bypass surface widens by exactly one statement type, and only inside
-- a transaction that already had DELETE-on-audit_logs authority.

GRANT UPDATE ON TABLE audit_logs TO breeze_audit_admin;

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allow_retention text := current_setting('breeze.allow_audit_retention', true);
BEGIN
  IF allow_retention = '1' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'audit log is append-only',
    HINT = 'audit_logs entries cannot be modified or deleted. Retention purging uses a separate role and per-session bypass GUC; see jobs/auditRetention.ts.';
END;
$$;
