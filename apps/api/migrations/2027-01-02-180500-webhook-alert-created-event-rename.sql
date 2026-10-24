-- #9651: the webhook form offered the event `alert.created`, but alerts are
-- published as `alert.triggered` and nothing ever publishes `alert.created`.
-- Webhooks subscribed to it saved fine and never received a delivery.
-- Rewrite stored subscriptions to the published name. The API also rewrites
-- the legacy name on create/update (routes/webhooks.ts LEGACY_EVENT_ALIASES).
--
-- Idempotent: a second run matches no rows. approval_generation is left
-- alone on purpose: no delivery for `alert.created` can be in flight (the
-- event never fired), so there is nothing to supersede.

SELECT set_config('breeze.scope', 'system', true);

UPDATE public.webhooks
   SET events = CASE
         WHEN 'alert.triggered' = ANY(events) THEN array_remove(events, 'alert.created')
         ELSE array_replace(events, 'alert.created', 'alert.triggered')
       END
 WHERE 'alert.created' = ANY(events);
