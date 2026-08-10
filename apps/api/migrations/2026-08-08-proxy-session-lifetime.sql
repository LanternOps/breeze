-- Proxy access consolidation (issue #3199): session lifetime + allowlist dedupe.
--
-- Design: docs/superpowers/specs/monitoring/2026-08-08-proxy-access-consolidation-design.md
-- (Architecture A.4, C.2).
--
-- 1. tunnel_sessions.last_activity_at — nullable timestamptz, bumped by
--    tunnelHttp on every authenticated proxied response (throttled >30s).
--    Server-computed idleSeconds = now - COALESCE(last_activity_at, created_at)
--    lets the client show honest session state instead of trusting the
--    browser clock.
ALTER TABLE "tunnel_sessions" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamptz;

-- 2. tunnel_allowlists dedupe ahead of the new expression unique index below.
--    POST /tunnels/proxy-connect (Task 4) upserts against the index key
--    (org_id, direction, pattern, COALESCE(site_id, <nil-uuid>)), so any
--    legacy rows that collide on that key — but differ in description,
--    created_at, or enabled, i.e. NOT necessarily exact duplicates — must be
--    collapsed first or the index build aborts.
--
--    Survivor rule: keep the OLDEST row (by created_at) in each colliding
--    group; before deleting the rest, fold enabled = bool_or(enabled) across
--    the group into the survivor so an enabled duplicate never gets silently
--    dropped in favor of a disabled older row.
DO $$
DECLARE
  n bigint;
BEGIN
  DROP TABLE IF EXISTS pg_temp.tunnel_allowlists_dedup_map;

  CREATE TEMP TABLE tunnel_allowlists_dedup_map ON COMMIT DROP AS
  WITH ranked AS (
    SELECT
      id,
      FIRST_VALUE(id) OVER (
        PARTITION BY org_id, direction, pattern, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid)
        ORDER BY created_at ASC, id ASC
      ) AS winner_id,
      ROW_NUMBER() OVER (
        PARTITION BY org_id, direction, pattern, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid)
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM tunnel_allowlists
  ),
  groups AS (
    SELECT winner_id FROM ranked WHERE rn > 1
  )
  SELECT
    r.id,
    r.winner_id,
    r.rn,
    bool_or(ta.enabled) OVER (PARTITION BY r.winner_id) AS group_enabled
  FROM ranked r
  JOIN tunnel_allowlists ta ON ta.id = r.id
  WHERE r.winner_id IN (SELECT winner_id FROM groups);

  UPDATE tunnel_allowlists ta
     SET enabled = m.group_enabled
    FROM tunnel_allowlists_dedup_map m
   WHERE ta.id = m.winner_id
     AND ta.enabled IS DISTINCT FROM m.group_enabled;

  DELETE FROM tunnel_allowlists
   WHERE id IN (SELECT id FROM tunnel_allowlists_dedup_map WHERE rn > 1);
  GET DIAGNOSTICS n = ROW_COUNT;

  -- Deliberately always-report (no `IF n>0` guard, same as
  -- 2026-06-27-c-default-update-ring-dedup.sql): emitting the count even when
  -- zero preserves a complete forensic trail of this data cleanup in the
  -- Postgres logs (per CLAUDE.md migration guidance).
  RAISE WARNING 'collapsed % duplicate tunnel_allowlists rows', n;
END $$;

-- 3. Dedupe at the DB. Expression unique index (no WHERE clause — this is not
--    a partial index) on the same key the collapse above used, so
--    POST /tunnels/proxy-connect can insert-if-absent against it.
CREATE UNIQUE INDEX IF NOT EXISTS "tunnel_allowlists_org_direction_pattern_site_idx"
  ON "tunnel_allowlists" ("org_id", "direction", "pattern", COALESCE("site_id", '00000000-0000-0000-0000-000000000000'::uuid));
