-- #4628 W03 — spec §3.5 / §4.3.
-- Adds the service-written billable_minutes column and pins it with a CHECK
-- carrying the IDENTICAL expression to billableMinutes.ts, so drift between the
-- TypeScript function and the SQL fragment becomes a 23514 rather than a wrong
-- invoice. Not a generated column: that rewrites this hot billing table under
-- ACCESS EXCLUSIVE, and generated columns are invisible to Drizzle and
-- db:check-drift.
-- autoMigrate wraps this file in a transaction — no BEGIN/COMMIT here.

ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS billable_minutes integer;

COMMENT ON COLUMN time_entries.billable_minutes IS
  'Minutes actually billed after the card''s minimum and rounding (spec §3.5). NULL while a timer runs and on pre-feature rows; money readers use COALESCE(billable_minutes, duration_minutes). Block-hours drawdown (#4547 §5) reads the same coalesced value.';

-- The CHECK. NOT VALID first so the ACCESS EXCLUSIVE lock is held only for the
-- catalog update, then VALIDATE under a weaker lock.
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_billable_minutes_chk;
ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_billable_minutes_chk
  CHECK (
    billable_minutes IS NULL
    OR (
      duration_minutes IS NOT NULL
      AND billable_minutes = GREATEST(
        COALESCE(minimum_minutes, 0),
        CASE WHEN COALESCE(rounding_increment_minutes, 0) > 0
             THEN (CEIL(duration_minutes::numeric / rounding_increment_minutes) * rounding_increment_minutes)::int
             ELSE duration_minutes END
      )
    )
  ) NOT VALID;

-- Backfill the W02→W03 window. Row-writing, so system scope is elected FIRST
-- (breeze_current_scope() defaults to 'none' and time_entries is FORCE ROW
-- LEVEL SECURITY, which binds the owner this migration runs as; without this
-- the UPDATE matches ZERO rows and the RAISE WARNING prints a truthful-looking 0).
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  batch integer;
  total integer := 0;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  LOOP
    UPDATE time_entries t
    SET billable_minutes = GREATEST(
      COALESCE(t.minimum_minutes, 0),
      CASE WHEN COALESCE(t.rounding_increment_minutes, 0) > 0
           THEN (CEIL(t.duration_minutes::numeric / t.rounding_increment_minutes) * t.rounding_increment_minutes)::int
           ELSE t.duration_minutes END
    )
    WHERE t.ctid IN (
      SELECT s.ctid FROM time_entries s
      WHERE s.billable_minutes IS NULL
        AND s.ended_at IS NOT NULL
        AND s.duration_minutes IS NOT NULL
        AND (s.minimum_minutes IS NOT NULL OR s.rounding_increment_minutes IS NOT NULL)
        -- An invoiced row's quantity is already on a customer's document.
        AND s.billing_status <> 'billed'
        -- ...and so is a DRAFT line's. `billing_status` only flips to 'billed'
        -- inside issueInvoice, so an entry already gathered into a draft is
        -- still 'not_billed' here: restamping it would move the billed quantity
        -- out from under a line that keeps quantity = duration/60, and the
        -- draft then issues at the old number while every reader shows the new
        -- one. Nothing reconciles the two afterwards.
        AND NOT EXISTS (
          SELECT 1 FROM invoice_lines il
          WHERE il.source_type = 'time_entry' AND il.source_id = s.id
        )
      LIMIT 5000
    );
    GET DIAGNOSTICS batch = ROW_COUNT;
    total := total + batch;
    EXIT WHEN batch = 0;
  END LOOP;
  -- Always reported, including 0: a zero here is evidence the W02→W03 window
  -- was empty, which is what we want on a fresh database.
  RAISE WARNING 'billing profiles W03: backfilled billable_minutes on % time_entries (W02 stamp window)', total;
END $$;

DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT COUNT(*) INTO n FROM time_entries
  WHERE billable_minutes IS NULL
    AND ended_at IS NOT NULL
    AND billing_status = 'billed'
    AND (minimum_minutes IS NOT NULL OR rounding_increment_minutes IS NOT NULL);
  IF n > 0 THEN
    RAISE WARNING 'billing profiles W03: % already-invoiced entries carry card terms but no billable_minutes and were deliberately LEFT NULL (their invoiced quantity stands)', n;
  END IF;
END $$;

ALTER TABLE time_entries VALIDATE CONSTRAINT time_entries_billable_minutes_chk;
