-- Spec docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md §4.2
-- Backfill action_intents.release_by for intents that were APPROVED by an
-- instance still running the pre-split code.
--
-- WHY A SEPARATE FILE. The columns themselves ship in
-- 2026-08-14-intent-approval-scope-and-deadlines.sql. `breeze_migrations`
-- keys on FILENAME, so anything appended to that file would never run on a
-- database that already applied it. All new SQL goes in a new file.
--
-- WHY THIS FILENAME (not `2026-08-14-b-...`). CLAUDE.md's same-day rule
-- prescribes an `-a-`/`-b-` infix, but that only works when BOTH files carry
-- one: the shipped file is bare (`2026-08-14-intent-approval-...`), and
-- `'2026-08-14-b-...'.localeCompare('2026-08-14-intent-approval-...')` is -1
-- because 'b' < 'i'. A `-b-` infix would therefore sort BEFORE its own
-- prerequisite and fail on a fresh-DB replay (`column release_by does not
-- exist`). Bare `2026-08-14-intent-release-...` happens to sort after
-- ('r' > 'a' in the slug), but CLAUDE.md explicitly warns against letting the
-- SLUG do the ordering (issue #506). The next date sorts after the whole
-- 2026-08-14 block regardless of any slug or infix, so that is what this uses.
--
-- WHAT GOES WRONG WITHOUT THIS. `transitionIntent(..., requireNotExpired)`
-- claims an approved intent with
--   COALESCE(release_by, expires_at) > now()
-- (services/actionIntents/intentService.ts). For a legacy approved row
-- release_by IS NULL, so the claim falls back to expires_at — which for a
-- supervised chat intent is created_at + 5 minutes (CHAT_EXPIRY_MS) and is
-- very likely ALREADY IN THE PAST by the time the new code is deployed. Such
-- a row can never be claimed: the release worker's CAS matches zero rows and
-- exits silently, and the 30s reaper terminalizes it. The 59:59 trap, applied
-- to the whole pre-existing approved backlog at once.
--
-- LEASE VALUE: GREATEST(expires_at, now() + interval '10 minutes').
--   * The `now() + 10 minutes` term is RELEASE_LEASE_MS
--     (services/actionIntents/intentService.ts:159 — `10 * 60 * 1000`), the
--     same fixed lease routes/approvals.ts stamps on a fresh approval win.
--     Using GREATEST guarantees a legacy row is handed a lease that is never
--     already in the past, which is the entire point of this migration.
--   * The `expires_at` term preserves the OLD effective deadline as a floor,
--     so this migration can only ever lengthen a row's claim window, never
--     shorten one. It matters for mcp_api intents (MCP_EXPIRY_MS = 24h): those
--     already had a long fallback deadline under the COALESCE, and silently
--     cutting them back to 10 minutes would be a behavior regression
--     introduced by a backfill.
--   * expires_at is used rather than approval_expires_at deliberately —
--     expires_at is exactly what the COALESCE fallback reads today, so the
--     floor is the true pre-migration behavior. (They are equal on these rows
--     anyway: 2026-08-14 backfilled approval_expires_at := expires_at.)
--
-- DELIBERATELY NOT DONE — do not "fix" this later:
--   * NO `ALTER TABLE action_intents ALTER COLUMN approval_expires_at SET NOT NULL`.
--   * NO `CHECK (status <> 'approved' OR release_by IS NOT NULL)`.
-- Both break a ROLLING upgrade. During a deploy, old API instances are still
-- serving: they flip intents to status='approved' without knowing about
-- release_by (and insert rows without approval_expires_at). Either constraint
-- would start rejecting those writes mid-deploy, turning an approval fan-in
-- into a 500 for every request that lands on an old pod. The nullability is
-- load-bearing until every instance runs the post-split code; tightening it
-- is a separate, later, expand/contract migration — not this one.
--
-- Idempotent: the WHERE clause is self-limiting (a row that already has a
-- lease is not matched), so re-applying is a no-op. autoMigrate wraps this
-- file in one transaction — no inner BEGIN/COMMIT.
-- No new columns, constraints, indexes, tables or policies: nothing to
-- register in tenantCascade / the export policy / the RLS allowlists, and
-- nothing for db:check-drift to see.

DO $$
DECLARE n INTEGER;
BEGIN
  UPDATE action_intents
     SET release_by = GREATEST(expires_at, now() + interval '10 minutes')
   WHERE status = 'approved'
     AND release_by IS NULL;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled % approved action_intents row(s) with a release_by lease (pre-split rows had none)', n;
  END IF;
END $$;
