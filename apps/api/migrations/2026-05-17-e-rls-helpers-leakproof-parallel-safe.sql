-- RLS helper functions: mark as LEAKPROOF + PARALLEL SAFE.
-- These functions read session GUCs and return scope information. They:
--   - Don't write any state
--   - Don't perform I/O outside reading SET-LOCAL GUCs
--   - Don't surface input values through error messages
-- That meets the LEAKPROOF contract (allows the planner to push the function
-- below security barriers and into index conditions). PARALLEL SAFE because
-- GUC reads are safe in parallel workers.
--
-- All 5 are already STABLE today; this migration adds the two missing markers.
-- Note: only a superuser can ALTER FUNCTION ... LEAKPROOF. The migration runner
-- runs as the DB admin role — if that lacks rolsuper, ALTER LEAKPROOF is a no-op
-- with a warning. We catch and ignore that path so the migration succeeds either way.

DO $$
BEGIN
  BEGIN
    ALTER FUNCTION breeze_current_scope() LEAKPROOF PARALLEL SAFE;
    ALTER FUNCTION breeze_accessible_org_ids() LEAKPROOF PARALLEL SAFE;
    ALTER FUNCTION breeze_has_org_access(uuid) LEAKPROOF PARALLEL SAFE;
    ALTER FUNCTION breeze_has_partner_access(uuid) LEAKPROOF PARALLEL SAFE;
    ALTER FUNCTION breeze_current_user_id() LEAKPROOF PARALLEL SAFE;
  EXCEPTION WHEN insufficient_privilege THEN
    -- Without superuser, fall back to PARALLEL SAFE only (no LEAKPROOF priv required for SAFE).
    ALTER FUNCTION breeze_current_scope() PARALLEL SAFE;
    ALTER FUNCTION breeze_accessible_org_ids() PARALLEL SAFE;
    ALTER FUNCTION breeze_has_org_access(uuid) PARALLEL SAFE;
    ALTER FUNCTION breeze_has_partner_access(uuid) PARALLEL SAFE;
    ALTER FUNCTION breeze_current_user_id() PARALLEL SAFE;
    RAISE NOTICE 'Skipped LEAKPROOF (requires superuser). Applied PARALLEL SAFE only.';
  END;
END $$;
