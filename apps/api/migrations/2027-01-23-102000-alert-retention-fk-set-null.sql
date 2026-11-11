-- @no-transaction
-- #4342 W3 (closed-alert retention): two nullable back-pointers into `alerts`
-- were declared with no ON DELETE action (NO ACTION):
--
--   log_correlations.alert_id       -> alerts(id)
--   network_change_events.alert_id  -> alerts(id)
--
-- so deleting any alert one of them pointed at aborted with 23503. Both rows
-- are history with their own owner that must outlive the alert, so the pointer
-- is cleared instead: ON DELETE SET NULL. That is what
-- services/siteOwnedAlerts.ts already does by hand before it deletes an alert;
-- that code keeps working and is now redundant. Every other reference into
-- alerts is already CASCADE or SET NULL.
--
-- Neither constraint names an org_id column, so the DEFERRABLE rule for
-- composite org FKs does not apply.
--
-- Schema-only (no row writes).
--
-- Locking. `alerts` takes writes on every alert raise and close, and both
-- children can be large. So, outside a transaction (same shape as
-- 2026-12-13-110200-org-erasure-fk-child-actions.sql):
--   1. One DO block per child swaps its constraint NOT VALID (catalog only,
--      no scan), each its own statement and so its own short transaction.
--      Dropping an FK removes its RI triggers from BOTH tables, so this takes
--      ACCESS EXCLUSIVE on the child AND on alerts for the duration of the
--      statement -- milliseconds once granted. lock_timeout bounds the wait
--      behind a long-running transaction: the statement fails after 5s
--      instead of queueing every later reader and writer of alerts behind it,
--      autoMigrate aborts boot, and the file re-runs cleanly on the next
--      start. The replaced constraint already guaranteed every existing row is
--      valid, and a NOT VALID FK still checks new rows and still fires its ON
--      DELETE action.
--   2. VALIDATE each constraint separately. That scans the child under SHARE
--      UPDATE EXCLUSIVE on the child and ROW SHARE on alerts, so writes to
--      both tables continue during the scan. Duration is one sequential scan
--      of each child (seconds on a large table); nothing waits on it.
--
-- Idempotent: each column's FKs into alerts are dropped, whatever their name,
-- unless already the canonical SET NULL constraint, which is then added only
-- if missing. Re-applying changes nothing and VALIDATE of a valid constraint
-- is a no-op. An interruption between the two steps leaves an enforcing NOT
-- VALID constraint that the next run validates.

SET lock_timeout = '5s';

-- One statement per child table, so the ACCESS EXCLUSIVE lock on alerts and
-- one child is never held while waiting for the other child's lock.
DO $$
DECLARE
  spec record;
  con record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('log_correlations', 'alert_id', 'log_correlations_alert_id_alerts_id_fk')
    ) AS s(tbl, col, con_name)
  LOOP
    FOR con IN
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f'
         AND c.conrelid = format('public.%I', spec.tbl)::regclass
         AND c.confrelid = 'public.alerts'::regclass
         AND array_length(c.conkey, 1) = 1
         AND a.attname = spec.col
         AND (c.confdeltype <> 'n' OR c.conname <> spec.con_name)
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', spec.tbl, con.conname);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('public.%I', spec.tbl)::regclass
         AND conname = spec.con_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.alerts(id) ON DELETE SET NULL NOT VALID',
        spec.tbl, spec.con_name, spec.col
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  spec record;
  con record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('network_change_events', 'alert_id', 'network_change_events_alert_id_alerts_id_fk')
    ) AS s(tbl, col, con_name)
  LOOP
    FOR con IN
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f'
         AND c.conrelid = format('public.%I', spec.tbl)::regclass
         AND c.confrelid = 'public.alerts'::regclass
         AND array_length(c.conkey, 1) = 1
         AND a.attname = spec.col
         AND (c.confdeltype <> 'n' OR c.conname <> spec.con_name)
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', spec.tbl, con.conname);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('public.%I', spec.tbl)::regclass
         AND conname = spec.con_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.alerts(id) ON DELETE SET NULL NOT VALID',
        spec.tbl, spec.con_name, spec.col
      );
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.log_correlations VALIDATE CONSTRAINT log_correlations_alert_id_alerts_id_fk;
ALTER TABLE public.network_change_events VALIDATE CONSTRAINT network_change_events_alert_id_alerts_id_fk;

RESET lock_timeout;
