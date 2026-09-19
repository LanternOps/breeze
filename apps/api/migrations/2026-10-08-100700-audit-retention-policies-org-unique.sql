-- Add a UNIQUE constraint on audit_retention_policies.org_id (#4633 review
-- follow-up).
--
-- The settings route added alongside this migration originally upserted via
-- `SELECT ... FOR UPDATE` inside a transaction, reasoning that the lock made
-- concurrent saves for the same org safe. That reasoning was wrong for the
-- exact case #4633 exists to fix: `SELECT ... FOR UPDATE` only locks rows
-- that already exist. For an org with NO policy row yet, two concurrent
-- `PUT /organizations/:id/audit-retention` requests (a double-click, two
-- admins, a client retry after a timeout) both see zero rows and both
-- INSERT — nothing was there to lock or conflict against. The result is two
-- rows for one org, which is silently wrong rather than an error:
--   - the prune worker (jobs/auditRetention.ts) has no dedup and loops over
--     EVERY row, so the shorter of the two retention_days values ends up
--     governing pruning;
--   - the settings GET (`.limit(1)`, no ORDER BY) can show either row,
--     which need not be the one actually enforced.
-- The service now upserts via `INSERT ... ON CONFLICT (org_id) DO UPDATE`
-- (matching org_ticket_settings' proven pattern), which requires this real
-- uniqueness guarantee at the database level to be atomic.
--
-- Dedup first: a fresh install has zero rows so this should never fire, but
-- guard against a duplicate having been inserted before this constraint
-- existed (this table shipped in 0001-baseline.sql with no constraint at
-- all, and manual `INSERT` was the only way to create a row until this PR).
-- Keeps the most recently updated row per org; logs the count per the
-- migrations/README cleanup-statement convention rather than silently
-- discarding data.
DO $$
DECLARE
  n integer;
BEGIN
  WITH ranked AS (
    SELECT id, row_number() OVER (
      PARTITION BY org_id ORDER BY updated_at DESC, created_at DESC, id
    ) AS rn
    FROM audit_retention_policies
  )
  DELETE FROM audit_retention_policies
  WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'removed % duplicate audit_retention_policies row(s) before adding the org_id unique constraint', n;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_retention_policies_org_id_key'
  ) THEN
    ALTER TABLE audit_retention_policies
      ADD CONSTRAINT audit_retention_policies_org_id_key UNIQUE (org_id);
  END IF;
END $$;
