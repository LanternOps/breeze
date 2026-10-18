-- Connection health W5 (#8849, spec 2026-10-15 §2.4): event outbox for
-- integration.health_opened / integration.health_resolved.
--
-- event_state records what event consumers were last told about the incident:
-- 'opened', 'resolved', or NULL (never told). An event is due when the row's
-- consumer-visible state differs: an open row (opened_at set, resolved_at NULL)
-- is due 'opened'; a resolved row whose consumers were told 'opened' is due
-- 'resolved'. Partner-wide rows (org_id NULL) never emit (W5 plan D10).
-- The publisher (services/connectionHealth/events.ts) publishes after commit
-- and records the state it published.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  added boolean := NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'connection_health_incidents'
      AND column_name = 'event_state'
  );
BEGIN
  IF added THEN
    ALTER TABLE public.connection_health_incidents
      ADD COLUMN event_state text NULL
      CONSTRAINT connection_health_incidents_event_state_chk
        CHECK (event_state IS NULL OR event_state IN ('opened', 'resolved'));

    -- Baseline once, when the column is first added: incidents that already
    -- exist emit no catch-up burst on deploy (W5 plan D8). Initialization-only
    -- on purpose: a re-run must never acknowledge an event that became due
    -- after the column existed.
    UPDATE public.connection_health_incidents
       SET event_state = CASE WHEN resolved_at IS NULL THEN 'opened' ELSE 'resolved' END
     WHERE org_id IS NOT NULL
       AND opened_at IS NOT NULL;
  END IF;
END
$$;

-- The publisher's scan: org rows whose consumer-visible state is ahead of
-- event_state. Same predicate as dueEventsWhere() in events.ts.
CREATE INDEX IF NOT EXISTS connection_health_incidents_event_due_idx
  ON public.connection_health_incidents (id)
  WHERE org_id IS NOT NULL
    AND opened_at IS NOT NULL
    AND (
      (resolved_at IS NULL AND event_state IS DISTINCT FROM 'opened')
      OR (resolved_at IS NOT NULL AND event_state = 'opened')
    );
