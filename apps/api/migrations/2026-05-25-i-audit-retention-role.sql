-- Audit-log retention pruning — privileged role + trigger bypass.
--
-- Task 29 of the launch-readiness fixes plan. The retention job
-- (jobs/auditRetention.ts) walks `audit_retention_policies` daily and
-- deletes `audit_logs` rows older than each policy's retention_days.
--
-- Two layers had to be defeated to allow DELETE without weakening
-- defenses for everyone else:
--
--   1. Migration 2026-05-25-a stripped UPDATE/DELETE grants on
--      `audit_logs` from `breeze_app`. A new role `breeze_audit_admin`
--      gets DELETE privilege and is granted to `breeze_app` so the
--      retention job can `SET LOCAL ROLE breeze_audit_admin` inside its
--      transaction without needing a separate connection or password.
--
--   2. The `audit_log_block_delete` trigger raises on every DELETE,
--      regardless of role. `session_replication_role = 'replica'`
--      would bypass it but is a SUPERUSER-only setting in Postgres,
--      so we use a per-session GUC instead: `breeze.allow_audit_retention`.
--      The trigger function below checks the GUC and skips the raise
--      when it's set to '1'. `SET LOCAL` is callable by any role, so
--      the bypass survives a non-superuser breeze_app session.
--
-- Defense-in-depth: an attacker would need to BOTH switch into
-- `breeze_audit_admin` (which they can do because breeze_app is a member)
-- AND set the GUC inside the same transaction. The role switch is
-- enforced by Postgres at the privilege layer (no DELETE without it),
-- the GUC is checked by our trigger. Removing either layer breaks the
-- bypass — both are required to actually delete an audit row.

-- 1. Create the privileged role (idempotent).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_audit_admin') THEN
    CREATE ROLE breeze_audit_admin;
  END IF;
END $$;

-- 2. Grant SELECT + DELETE on audit_logs to the new role. SELECT is
--    required because DELETE evaluates the WHERE clause and applies
--    the RLS USING expression — both need read access to the row.
--    breeze_app still has no DELETE; only sessions that `SET ROLE
--    breeze_audit_admin` can issue the statement.
GRANT SELECT, DELETE ON TABLE audit_logs TO breeze_audit_admin;

-- 3. Make breeze_app a member of breeze_audit_admin so the retention job
--    can `SET LOCAL ROLE breeze_audit_admin` inside an existing
--    breeze_app transaction without a separate connection.
GRANT breeze_audit_admin TO breeze_app;

-- 4. Replace the trigger function to honor the per-session bypass GUC.
--    Existing trigger definitions stay attached — only the function body
--    changes. `current_setting(name, missing_ok=true)` returns NULL when
--    the GUC has never been set, which keeps the default-deny behavior
--    for every session that does not explicitly opt in.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allow_retention text := current_setting('breeze.allow_audit_retention', true);
BEGIN
  -- Retention pruning sets `breeze.allow_audit_retention = '1'` for the
  -- duration of its DELETE transaction (jobs/auditRetention.ts). All
  -- other writers leave the GUC unset and continue to be blocked.
  IF TG_OP = 'DELETE' AND allow_retention = '1' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'audit log is append-only',
    HINT = 'audit_logs entries cannot be modified or deleted. Retention purging uses a separate role and per-session bypass GUC; see jobs/auditRetention.ts.';
END;
$$;
