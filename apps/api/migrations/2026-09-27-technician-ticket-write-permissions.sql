-- #4251: the seeded 'Partner Technician' role can read tickets but never write
-- them, and therefore never holds time_entries:write.
--
-- The only grant path for time_entries is 2026-06-12-a-ticketing-time-parts.sql,
-- which propagates each time_entries perm off the MATCHING tickets perm:
-- time_entries:read to every role holding tickets:read, time_entries:write to
-- every role holding tickets:write. Partner Technician holds tickets:read only
-- (apps/api/src/db/seed.ts), so it received time_entries:read and nothing else.
-- The #3206 W05 mobile timer renders that technician's timesheet and then 403s
-- on start/stop.
--
-- seed.ts is fixed in the same commit, which repairs FRESH installs. This
-- migration repairs EXISTING ones. Scope is deliberately narrow:
--   * only is_system roles literally named 'Partner Technician' — a
--     partner-authored custom role is theirs to define, never ours to widen;
--   * tickets:manage is NOT granted (reassigning ticket organization and
--     editing another author's comment stay admin actions);
--   * Partner Viewer / Org Viewer are untouched.
--
-- Idempotent: every INSERT is guarded by NOT EXISTS, so re-applying is a no-op.

DO $$
DECLARE
  granted integer;
  total   integer := 0;
  perm    text;
BEGIN
  FOREACH perm IN ARRAY ARRAY['tickets:write', 'time_entries:read', 'time_entries:write']
  LOOP
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id
    FROM roles r
    JOIN permissions p
      ON p.resource = split_part(perm, ':', 1)
     AND p.action   = split_part(perm, ':', 2)
    WHERE r.is_system = true
      AND r.name = 'Partner Technician'
      AND NOT EXISTS (
        SELECT 1 FROM role_permissions x
        WHERE x.role_id = r.id AND x.permission_id = p.id
      );

    GET DIAGNOSTICS granted = ROW_COUNT;
    total := total + granted;

    -- Report even a zero: this migration widens an authorization boundary, so
    -- the count belongs in the Postgres log whether or not it changed anything.
    RAISE WARNING 'granted % to % Partner Technician role(s)', perm, granted;
  END LOOP;

  RAISE WARNING 'technician ticket-write backfill: % role_permission row(s) inserted', total;
END $$;
