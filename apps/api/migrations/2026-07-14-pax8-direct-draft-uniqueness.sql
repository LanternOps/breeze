-- Keep at most one mutable direct Pax8 order per partner/customer. Quote
-- staging intentionally remains outside this index so multiple accepted quotes
-- may wait for fulfillment details at the same time.
DO $$
DECLARE
  cleaned_count INTEGER;
BEGIN
  WITH ranked AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY partner_id, org_id
        ORDER BY created_at, id
      ) AS ordinal
    FROM pax8_orders
    WHERE source = 'direct'
      AND status IN ('draft', 'awaiting_details')
  ), cleaned AS (
    UPDATE pax8_orders AS duplicate
    SET
      status = 'cancelled',
      error = CONCAT_WS(
        E'\n',
        NULLIF(duplicate.error, ''),
        'Cancelled duplicate mutable direct draft during 2026-07-14 uniqueness migration.'
      ),
      updated_at = NOW()
    FROM ranked
    WHERE duplicate.id = ranked.id
      AND ranked.ordinal > 1
    RETURNING duplicate.id
  )
  SELECT COUNT(*) INTO cleaned_count FROM cleaned;

  RAISE WARNING 'cancelled % duplicate mutable direct Pax8 draft order(s)', cleaned_count;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS pax8_orders_one_mutable_direct_per_org_uq
  ON pax8_orders(partner_id, org_id)
  WHERE source = 'direct'
    AND status IN ('draft', 'awaiting_details');
