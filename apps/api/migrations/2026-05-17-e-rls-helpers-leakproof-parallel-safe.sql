-- RLS helper functions: mark as LEAKPROOF + PARALLEL SAFE.
-- These functions read session GUCs and return scope information. They:
--   - Don't write any state
--   - Don't perform I/O outside reading SET-LOCAL GUCs
--   - Don't surface input values through error messages
-- That meets the LEAKPROOF contract (allows the planner to push the function
-- below security barriers and into index conditions). PARALLEL SAFE because
-- GUC reads are safe in parallel workers.
--
-- All listed functions are already STABLE today; this migration adds the two
-- missing markers.
--
-- Note: only a superuser can ALTER FUNCTION ... LEAKPROOF. The migration runner
-- runs as the DB admin role — if that lacks rolsuper, ALTER LEAKPROOF is a no-op
-- with a warning. We catch and ignore that path so the migration succeeds either way.
--
-- DELIBERATELY NOT in this list: breeze_accessible_org_ids() and
-- breeze_accessible_partner_ids(). At this point in the migration sequence
-- their plpgsql bodies still contain `EXCEPTION WHEN others`, which makes the
-- PARALLEL SAFE marker a lie — the EXCEPTION block creates an implicit
-- subtransaction that Postgres refuses to start in a parallel worker
-- ("cannot start subtransactions during a parallel operation"). Between this
-- migration and `2026-05-18-a-rls-helpers-parallel-safe-rewrite.sql`,
-- autoMigrate commits one file per transaction — so if a deploy were
-- interrupted in that window, /devices would 500 on any plan the planner
-- decided to parallelize. The 2026-05-18-a migration is the authoritative
-- place those two functions get marked PARALLEL SAFE (after the bodies are
-- rewritten to drop the EXCEPTION block in favor of regex pre-validation).
-- Per #753 review (Todd, 2026-05-19).

DO $$
BEGIN
  BEGIN
    ALTER FUNCTION breeze_current_scope() LEAKPROOF PARALLEL SAFE;
    ALTER FUNCTION breeze_has_org_access(uuid) LEAKPROOF PARALLEL SAFE;
    ALTER FUNCTION breeze_has_partner_access(uuid) LEAKPROOF PARALLEL SAFE;
    ALTER FUNCTION breeze_current_user_id() LEAKPROOF PARALLEL SAFE;
  EXCEPTION WHEN insufficient_privilege THEN
    -- Without superuser, fall back to PARALLEL SAFE only (no LEAKPROOF priv required for SAFE).
    ALTER FUNCTION breeze_current_scope() PARALLEL SAFE;
    ALTER FUNCTION breeze_has_org_access(uuid) PARALLEL SAFE;
    ALTER FUNCTION breeze_has_partner_access(uuid) PARALLEL SAFE;
    ALTER FUNCTION breeze_current_user_id() PARALLEL SAFE;
    RAISE NOTICE 'Skipped LEAKPROOF (requires superuser). Applied PARALLEL SAFE only.';
  END;
END $$;
