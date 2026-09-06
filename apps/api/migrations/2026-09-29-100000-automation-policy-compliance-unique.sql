-- automation_policy_compliance: dedupe + unique indexes (#4122)
--
-- The table has always been an "upsert" target but never had a uniqueness
-- constraint to upsert against, and `policyEvaluationService.ts` wrote it with a
-- non-atomic select-then-insert. Two concurrent evaluations of the same policy
-- (scheduled sweep + manual "Evaluate now", or two workers on the same policy)
-- both saw "no row" and both inserted, so duplicates accumulate for a single
-- (policy, device) pair. Readers then pick an arbitrary one:
--   * `policyAlertBridge.handlePolicyViolation`'s reconcile guard reads this
--     table to decide whether a violation is still current (mitigated in #4117
--     with `ORDER BY updated_at DESC`, which is a tiebreak, not a guarantee).
--   * The evaluation upsert itself kept writing to whichever duplicate its
--     unordered SELECT happened to return, so status could ping-pong.
--
-- Two shapes live in this table and exactly one axis is populated per row:
--   1. automation policy   -> (policy_id, device_id)
--   2. config policy item  -> (config_policy_id, config_item_name, device_id)
-- Both key columns are nullable, so uniqueness is expressed as two PARTIAL
-- unique indexes rather than table constraints.
--
-- Index creation is deliberately NOT `CONCURRENTLY`: autoMigrate wraps each file
-- in a transaction, and splitting the dedupe from the index build would leave a
-- window in which a racing writer re-creates a duplicate and the concurrent
-- build finishes INVALID. Doing both in one transaction is the atomic option.

-- `automation_policy_compliance` is ENABLE + FORCE ROW LEVEL SECURITY
-- (2026-04-11-bucket-c-phase-5-admin-cold-rls.sql), so the policies apply to the
-- table OWNER too — and `breeze_current_scope()` defaults to 'none', not
-- 'system' (0012-tenant-rls-deny-default.sql supersedes 0008: missing scope
-- DENIES). autoMigrate sets no scope. On the containerised deployment
-- DATABASE_URL is a superuser and bypasses RLS anyway, but on managed Postgres
-- (DigitalOcean/RDS) the admin role is NOT a superuser — there the DELETEs
-- below would match zero rows, the RAISE WARNING would report a truthful-looking
-- "removed 0" that is actually an RLS artifact, and CREATE UNIQUE INDEX would
-- then abort on the surviving duplicates and refuse the API's boot.
--
-- `is_local = true` scopes this to autoMigrate's per-file transaction. Same
-- one-liner as 2026-04-13-fix-uuid-hostnames.sql and ~10 later migrations.
SELECT set_config('breeze.scope', 'system', true);

-- ---------------------------------------------------------------------------
-- 1. Dedupe the automation-policy shape, keeping the freshest row per pair.
--    "Freshest" = highest updated_at, id DESC as a deterministic tiebreak.
--    The surviving row carries its own remediation_attempts; counters on the
--    discarded duplicates are intentionally not merged — the freshest row is
--    the one every reader was already trying to read.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  removed_policy_dupes INTEGER;
BEGIN
  WITH ranked AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY policy_id, device_id
        ORDER BY updated_at DESC, id DESC
      ) AS ordinal
    FROM automation_policy_compliance
    WHERE policy_id IS NOT NULL
  )
  DELETE FROM automation_policy_compliance
   WHERE id IN (SELECT id FROM ranked WHERE ordinal > 1);
  GET DIAGNOSTICS removed_policy_dupes = ROW_COUNT;

  -- Deliberately always-report (no `IF n > 0` guard): a zero is evidence too.
  -- These rows drive compliance state and alert reconciliation, so the count of
  -- what this cleanup discarded belongs in the Postgres log unconditionally.
  RAISE WARNING 'automation_policy_compliance dedupe: removed % duplicate (policy_id, device_id) row(s)',
    removed_policy_dupes;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Dedupe the config-policy-item shape.
--    Scoped to rows where BOTH key columns are populated: NULLs never collide
--    in a btree unique index, so a row missing config_item_name cannot be keyed
--    and must not be deleted on a key we cannot actually form.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  removed_config_dupes INTEGER;
BEGIN
  WITH ranked AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY config_policy_id, config_item_name, device_id
        ORDER BY updated_at DESC, id DESC
      ) AS ordinal
    FROM automation_policy_compliance
    WHERE config_policy_id IS NOT NULL
      AND config_item_name IS NOT NULL
  )
  DELETE FROM automation_policy_compliance
   WHERE id IN (SELECT id FROM ranked WHERE ordinal > 1);
  GET DIAGNOSTICS removed_config_dupes = ROW_COUNT;

  RAISE WARNING 'automation_policy_compliance dedupe: removed % duplicate (config_policy_id, config_item_name, device_id) row(s)',
    removed_config_dupes;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The uniqueness the writers upsert against.
--    The predicates below are reproduced verbatim as `targetWhere` in
--    `policyEvaluationService.ts` — Postgres only infers a partial index as an
--    ON CONFLICT arbiter when the statement's inference predicate implies the
--    index predicate, so the two must be kept in lockstep.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS apc_policy_device_uq
  ON automation_policy_compliance (policy_id, device_id)
  WHERE policy_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS apc_config_policy_item_device_uq
  ON automation_policy_compliance (config_policy_id, config_item_name, device_id)
  WHERE config_policy_id IS NOT NULL
    AND config_item_name IS NOT NULL;
