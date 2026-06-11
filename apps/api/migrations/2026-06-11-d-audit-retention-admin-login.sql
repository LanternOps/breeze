-- Audit-retention privilege separation (issue #915) — step 1 of 2.
--
-- Background: migration 2026-05-25-i created role `breeze_audit_admin`
-- (DELETE on audit_logs) and GRANTed it TO `breeze_app` so the retention
-- worker could `SET LOCAL ROLE breeze_audit_admin` from the shared
-- breeze_app connection. That means an attacker with SQLi/RCE inside the
-- API process can replicate the exact two-gate bypass and wipe audit rows
-- from the same connection — the role membership is the hole.
--
-- The fix is to run retention on a SEPARATE pool that logs in *directly*
-- as `breeze_audit_admin`, then REVOKE the membership from breeze_app
-- (step 2, migration 2026-06-11-e, which is NOT auto-applied — see that
-- file). This migration only makes the role connectable: it flips the
-- NOLOGIN attribute to LOGIN so an operator-supplied password can be used
-- for AUDIT_ADMIN_DATABASE_URL.
--
-- SECURITY / OPERATOR NOTE: this migration deliberately sets NO password.
-- Committing a credential to the repo would defeat the entire point. The
-- operator MUST, out-of-band, set a strong password on the role and supply
-- it to the API via AUDIT_ADMIN_DATABASE_URL:
--
--     ALTER ROLE breeze_audit_admin PASSWORD '<strong-random-secret>';
--
-- and then set, in /opt/breeze/.env AND map in the api service
-- `environment:` block of docker-compose.yml (compose only interpolates
-- vars listed there):
--
--     AUDIT_ADMIN_DATABASE_URL=postgresql://breeze_audit_admin:<secret>@<host>:5432/breeze
--
-- Until AUDIT_ADMIN_DATABASE_URL is set, the worker runs in legacy
-- shared-credential mode and logs a startup warning. LOGIN with no password
-- is harmless on its own: Postgres rejects password auth for a passwordless
-- role, and the role still has no membership chain beyond what 2026-05-25-i
-- granted.
--
-- Idempotent: only ALTERs when the role exists and isn't already LOGIN.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_audit_admin' AND rolcanlogin = false) THEN
    ALTER ROLE breeze_audit_admin WITH LOGIN;
  END IF;
END $$;
