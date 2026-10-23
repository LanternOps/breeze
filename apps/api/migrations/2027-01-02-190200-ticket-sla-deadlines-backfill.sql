-- @no-transaction
-- #8973 W3 (spec §4.6, Gate B11): backfill the stored SLA deadline columns
-- added by 2027-01-02-190100-ticket-sla-deadlines.sql.
--
-- Values reproduce today's wall-clock rule exactly (no calendar exists yet):
--   *_due_at  = created_at + (target + sla_paused_minutes) minutes
--   *_warn_at = created_at + sla_paused_minutes minutes + 0.8 * target minutes
--   sla_paused_business_minutes = sla_paused_minutes
-- The warn expression is written in the same operand order as the pre-W3
-- staff-queue SQL (routes/tickets/tickets.ts SLA_AT_RISK), so the 0.8 fraction
-- rounds identically and the at-risk set is reproduced to the microsecond.
-- A NULL target leaves its due/warn columns NULL.
--
-- ONE-TIME PARTNER API FEED RE-DELIVERY (Gate B3, accepted): the
-- breeze_tickets_partner_feed_xid BEFORE INSERT OR UPDATE trigger restamps
-- partner_feed_xid on every row this file updates, so Partner API tickets-feed
-- consumers re-receive each backfilled ticket once, now carrying the four new
-- due/warn fields. The trigger is deliberately left enabled.
--
-- Shape (Gate B11): a procedure that UPDATEs at most `batch` rows per
-- iteration and COMMITs after each, so row locks are released per batch and an
-- interrupted run resumes where it stopped (the predicate only matches rows
-- still missing a value). autoMigrate sends each statement of a
-- `-- @no-transaction` file separately, so the CALL runs at top level, where
-- PL/pgSQL transaction control is allowed. The procedure has no SET clause
-- (a SET clause forbids COMMIT), so every name is schema-qualified.
--
-- RLS: tickets is FORCE ROW LEVEL SECURITY, which binds the migration role.
-- COMMIT ends the transaction that a transaction-local set_config belongs to,
-- so system scope is re-elected at the top of EVERY iteration, before the
-- UPDATE. Without it each UPDATE would match zero rows and the loop would end
-- with a truthful-looking total of 0.
--
-- Idempotent: re-running matches only rows still missing a value. The
-- procedure is dropped at the end of the file.

CREATE OR REPLACE PROCEDURE public.breeze_backfill_ticket_sla_deadlines(batch int)
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
  total bigint := 0;
BEGIN
  LOOP
    PERFORM set_config('breeze.scope', 'system', true);

    UPDATE public.tickets t
       SET response_due_at = t.created_at
             + (t.response_sla_minutes + COALESCE(t.sla_paused_minutes, 0)) * interval '1 minute',
           response_warn_at = t.created_at
             + COALESCE(t.sla_paused_minutes, 0) * interval '1 minute'
             + t.response_sla_minutes * interval '1 minute' * 0.8,
           resolution_due_at = t.created_at
             + (t.resolution_sla_minutes + COALESCE(t.sla_paused_minutes, 0)) * interval '1 minute',
           resolution_warn_at = t.created_at
             + COALESCE(t.sla_paused_minutes, 0) * interval '1 minute'
             + t.resolution_sla_minutes * interval '1 minute' * 0.8,
           sla_paused_business_minutes = COALESCE(t.sla_paused_minutes, 0)
     WHERE t.ctid IN (
       SELECT s.ctid
         FROM public.tickets s
        WHERE (s.response_sla_minutes IS NOT NULL AND s.response_due_at IS NULL)
           OR (s.resolution_sla_minutes IS NOT NULL AND s.resolution_due_at IS NULL)
           OR (s.sla_paused_business_minutes = 0 AND COALESCE(s.sla_paused_minutes, 0) > 0)
        LIMIT batch
     );

    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
    total := total + n;
    COMMIT;
    RAISE NOTICE 'ticket SLA deadline backfill: % rows so far', total;
  END LOOP;
  RAISE NOTICE 'ticket SLA deadline backfill complete: % rows', total;
END;
$$;

CALL public.breeze_backfill_ticket_sla_deadlines(5000);

DROP PROCEDURE IF EXISTS public.breeze_backfill_ticket_sla_deadlines(int);
