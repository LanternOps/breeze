-- A durable signup preference, independent of paid plan/entitlement authority.
-- Existing partners retain NULL and their current billing behavior.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS purchase_selection jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'partners'::regclass AND conname = 'partners_purchase_selection_valid'
  ) THEN
    ALTER TABLE partners ADD CONSTRAINT partners_purchase_selection_valid CHECK (
      purchase_selection IS NULL OR COALESCE((
    jsonb_typeof(purchase_selection) = 'object'
    AND purchase_selection ?& ARRAY['catalogVersion', 'capacity', 'billingPeriod']
    AND purchase_selection - ARRAY['catalogVersion', 'capacity', 'billingPeriod'] = '{}'::jsonb
    AND purchase_selection->'catalogVersion' = '"launch-2026-10"'::jsonb
    AND (
      (purchase_selection->'billingPeriod' = '"monthly"'::jsonb AND purchase_selection->'capacity' IN ('100'::jsonb, '150'::jsonb, '200'::jsonb, '250'::jsonb, '300'::jsonb, '350'::jsonb, '400'::jsonb, '450'::jsonb, '500'::jsonb, '750'::jsonb, '1000'::jsonb))
      OR (purchase_selection->'billingPeriod' = '"annual"'::jsonb AND purchase_selection->'capacity' IN ('100'::jsonb, '250'::jsonb, '500'::jsonb, '1000'::jsonb))
    )
  ), false)
    );
  END IF;
END $$;
