-- Multi-currency wave 3 follow-up (#3775 review #7): a bundle component's
-- revenue_allocation is a monetary amount, so it must carry the currency it
-- was authored in. Before this, one allocation (say a 60/40 USD split) was
-- compared with the bundle's headline in EVERY currency and copied unchanged
-- into EUR invoice lines. Now each allocation is stamped with
-- allocation_currency at write time (the price currency being edited) and is
-- only used when it matches the target currency; otherwise it is unavailable
-- (null on the invoice line, economics report allocationAvailable=false) —
-- never relabelled, never converted.
--
-- catalog_bundle_components is partner-axis (no org_id): no tenant export
-- policy entry. RLS + policies unchanged (2026-07-xx catalog migrations).
-- Sorts after 2026-08-31-b-stripe-account-currency-cache.sql.
ALTER TABLE catalog_bundle_components ADD COLUMN IF NOT EXISTS allocation_currency char(3);

-- Backfill: an existing allocation was authored against the only price the
-- bundle had at the time — the partner's currency (wave-3 seeded the partner
-- currency price-book row from unit_price). Snapshots rule: stamped once,
-- here, and never re-read from partners.currency_code afterwards.
DO $$
DECLARE n integer;
BEGIN
  UPDATE catalog_bundle_components cbc
  SET allocation_currency = upper(trim(p.currency_code))
  FROM partners p
  WHERE p.id = cbc.partner_id
    AND cbc.revenue_allocation IS NOT NULL
    AND cbc.allocation_currency IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled allocation_currency on % catalog_bundle_components rows from partner default', n; END IF;
END $$;

-- An allocation without a currency is meaningless; a currency without an
-- allocation is allowed (the stamp describes the allocation, nothing else).
DO $$ BEGIN
  ALTER TABLE catalog_bundle_components ADD CONSTRAINT catalog_bundle_components_allocation_currency_chk
    CHECK (revenue_allocation IS NULL OR allocation_currency IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- NOT VALID + guarded validation: a partner carrying a legacy off-list
-- currency (wave 1 left those in place) must not abort the migration.
DO $$ BEGIN
  ALTER TABLE catalog_bundle_components ADD CONSTRAINT catalog_bundle_components_allocation_currency_fkey
    FOREIGN KEY (allocation_currency) REFERENCES supported_currencies(code) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE catalog_bundle_components VALIDATE CONSTRAINT catalog_bundle_components_allocation_currency_fkey;
EXCEPTION WHEN foreign_key_violation THEN
  RAISE WARNING 'multi-currency: catalog_bundle_components has off-list allocation_currency rows; catalog_bundle_components_allocation_currency_fkey left NOT VALID';
END $$;
