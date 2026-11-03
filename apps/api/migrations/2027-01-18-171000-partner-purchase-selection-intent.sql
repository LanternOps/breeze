-- partners.purchase_selection now also stores a signup intent
-- ({"intent":"cloud"|"wisp","offer":"<slug>"}, offer optional). The launch
-- tuple stays valid, so no row is rewritten. NULL remains the legacy default.
-- DROP + ADD is idempotent; replaying the older 2026-12-18-110000 migration
-- afterwards is a no-op because it only adds the constraint when absent.
SET LOCAL lock_timeout = '5s';

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_purchase_selection_valid;

ALTER TABLE partners ADD CONSTRAINT partners_purchase_selection_valid CHECK (
  purchase_selection IS NULL OR COALESCE((
    (
      jsonb_typeof(purchase_selection) = 'object'
      AND purchase_selection ?& ARRAY['catalogVersion', 'capacity', 'billingPeriod']
      AND purchase_selection - ARRAY['catalogVersion', 'capacity', 'billingPeriod'] = '{}'::jsonb
      AND purchase_selection->'catalogVersion' = '"launch-2026-10"'::jsonb
      AND (
        (purchase_selection->'billingPeriod' = '"monthly"'::jsonb AND purchase_selection->'capacity' IN ('100'::jsonb, '150'::jsonb, '200'::jsonb, '250'::jsonb, '300'::jsonb, '350'::jsonb, '400'::jsonb, '450'::jsonb, '500'::jsonb, '750'::jsonb, '1000'::jsonb))
        OR (purchase_selection->'billingPeriod' = '"annual"'::jsonb AND purchase_selection->'capacity' IN ('100'::jsonb, '250'::jsonb, '500'::jsonb, '1000'::jsonb))
      )
    )
    OR (
      jsonb_typeof(purchase_selection) = 'object'
      AND purchase_selection ? 'intent'
      AND purchase_selection - ARRAY['intent', 'offer'] = '{}'::jsonb
      AND purchase_selection->'intent' IN ('"cloud"'::jsonb, '"wisp"'::jsonb)
      AND (
        NOT purchase_selection ? 'offer'
        OR (
          jsonb_typeof(purchase_selection->'offer') = 'string'
          AND purchase_selection->>'offer' ~ '^[a-z][a-z0-9_-]{0,31}$'
        )
      )
    )
  ), false)
);
