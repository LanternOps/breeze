-- 2026-05-15: Allow is_system=true scripts to be visible to partner-scope
-- and org-scope readers.
--
-- Background: the SELECT policy at apps/api/migrations/0001-baseline.sql:17710
-- is breeze_org_isolation_select USING (breeze_has_org_access(org_id)).
-- System scripts are stored with is_system=true, org_id=NULL, and
-- breeze_has_org_access(NULL) returns FALSE for every non-system scope
-- (function body at 0001-baseline.sql, definition near line 1663). System
-- scripts were therefore invisible to partner-scope and org-scope readers —
-- they could only be SELECTed under system DB context.
--
-- INSERT/UPDATE/DELETE policies are unchanged; system-row writes continue
-- via withSystemDbAccessContext from system-scope handlers (the existing
-- pattern that scripts.is_system writes already use today).
--
-- Idempotent: same-name drop-and-recreate of a deterministic policy.
-- Re-running converges to the same final state. autoMigrate wraps each
-- migration file in a transaction, so no inner BEGIN/COMMIT.

DROP POLICY IF EXISTS breeze_org_isolation_select ON scripts;
CREATE POLICY breeze_org_isolation_select ON scripts
  FOR SELECT USING (
    is_system = true
    OR breeze_has_org_access(org_id)
  );
