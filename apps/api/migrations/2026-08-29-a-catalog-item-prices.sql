-- Multi-currency wave 3 (#3775, spec §6): per-currency sell-price book.
-- Partner-axis RLS (shape 3) — partner_id is the isolation axis, mirroring
-- catalog_items / catalog_item_images. Composite ownership FK proves the row's
-- partner_id is the item's partner_id. Idempotent.
CREATE TABLE IF NOT EXISTS catalog_item_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id),
  currency_code char(3) NOT NULL REFERENCES supported_currencies(code),
  unit_price numeric(12,2) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_item_prices_item_currency_uq ON catalog_item_prices (item_id, currency_code);
CREATE INDEX IF NOT EXISTS catalog_item_prices_partner_idx ON catalog_item_prices (partner_id);

DO $$ BEGIN
  ALTER TABLE catalog_item_prices
    ADD CONSTRAINT catalog_item_prices_item_partner_fk
    FOREIGN KEY (item_id, partner_id) REFERENCES catalog_items(id, partner_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE catalog_item_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_item_prices FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'catalog_item_prices'
      AND policyname = 'catalog_item_prices_partner_access'
  ) THEN
    CREATE POLICY catalog_item_prices_partner_access ON catalog_item_prices
      FOR ALL
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;

-- Seed: every existing item gets ONE price-book row in its partner's current
-- currency, copied from the legacy unit_price. ON CONFLICT keeps re-runs a no-op.
-- Wave 1 left off-list partner currency codes in place (partners FK is NOT VALID,
-- 2026-08-27-b-org-currency-and-fks.sql §3) — those items are SKIPPED (counted),
-- never rewritten, so one legacy code cannot abort this migration.
DO $$
DECLARE n integer; skipped integer; odd integer;
BEGIN
  INSERT INTO catalog_item_prices (item_id, partner_id, currency_code, unit_price)
  SELECT ci.id, ci.partner_id, upper(trim(p.currency_code)), ci.unit_price
  FROM catalog_items ci
  JOIN partners p ON p.id = ci.partner_id
  JOIN supported_currencies sc ON sc.code = upper(trim(p.currency_code))
  ON CONFLICT (item_id, currency_code) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: seeded % catalog_item_prices rows from catalog_items.unit_price', n; END IF;

  SELECT count(*) INTO skipped
  FROM catalog_items ci JOIN partners p ON p.id = ci.partner_id
  WHERE NOT EXISTS (SELECT 1 FROM supported_currencies sc WHERE sc.code = upper(trim(p.currency_code)));
  IF skipped > 0 THEN RAISE WARNING 'multi-currency: % catalog_items NOT seeded — partner currency is off-list (left without a price-book row; fix the partner currency, then PUT /catalog/:id/prices/:code)', skipped; END IF;

  -- Zero-decimal partner currencies (JPY, KRW, CLP, ...) with a legacy cents
  -- value: seeded as-is (snapshots rule), counted for forensics.
  SELECT count(*) INTO odd
  FROM catalog_item_prices cp
  WHERE cp.currency_code IN ('BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF')
    AND cp.unit_price <> trunc(cp.unit_price);
  IF odd > 0 THEN RAISE WARNING 'multi-currency: % seeded price-book rows carry sub-unit amounts in a zero-decimal currency (left as-is; PRICE_NOT_REPRESENTABLE blocks new writes)', odd; END IF;
END $$;

COMMENT ON COLUMN catalog_items.unit_price IS
  'DEPRECATED (multi-currency wave 3): read-mirror of the partner-currency catalog_item_prices row. Readers use catalog_item_prices; dropped by a later cleanup migration.';
