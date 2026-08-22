-- Multi-currency wave 3 (#3775, spec §6): cost currency on catalog items;
-- org price overrides carry their currency + a denormalized partner_id with
-- composite FKs proving item, org, and override share one partner.
-- Depends on 2026-08-29-a-catalog-item-prices.sql (same-date -a-/-b- infix).

-- 1) catalog_items.cost_currency: add nullable, backfill from partner, SET NOT NULL, FK.
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS cost_currency char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE catalog_items ci
  SET cost_currency = upper(trim(p.currency_code))
  FROM partners p
  WHERE p.id = ci.partner_id AND ci.cost_currency IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled cost_currency on % catalog_items from partner default', n; END IF;
END $$;

ALTER TABLE catalog_items ALTER COLUMN cost_currency SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_cost_currency_fkey
    FOREIGN KEY (cost_currency) REFERENCES supported_currencies(code) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE catalog_items VALIDATE CONSTRAINT catalog_items_cost_currency_fkey;
EXCEPTION WHEN foreign_key_violation THEN
  RAISE WARNING 'multi-currency: catalog_items has off-list cost_currency rows; catalog_items_cost_currency_fkey left NOT VALID';
END $$;

-- 2) catalog_item_org_pricing.partner_id: add, backfill from the item, audit
--    cross-partner overrides (isolation-breach artifacts — counted, then
--    deleted so the composite FKs can be added), SET NOT NULL.
ALTER TABLE catalog_item_org_pricing ADD COLUMN IF NOT EXISTS partner_id uuid;

DO $$
DECLARE n integer;
BEGIN
  UPDATE catalog_item_org_pricing op
  SET partner_id = ci.partner_id
  FROM catalog_items ci
  WHERE ci.id = op.catalog_item_id AND op.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled partner_id on % catalog_item_org_pricing rows from catalog_items', n; END IF;

  DELETE FROM catalog_item_org_pricing op
  USING organizations o
  WHERE o.id = op.org_id AND o.partner_id <> op.partner_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Unconditional: a recorded 0 is the forensic evidence that no cross-tenant
  -- override ever existed (CLAUDE.md cleanup-statement rule).
  RAISE WARNING 'multi-currency: deleted % cross-partner catalog_item_org_pricing rows (org partner <> item partner) — tenant-isolation audit', n;
END $$;

ALTER TABLE catalog_item_org_pricing ALTER COLUMN partner_id SET NOT NULL;

-- 3) catalog_item_org_pricing.currency_code: backfill from the org's currency.
ALTER TABLE catalog_item_org_pricing ADD COLUMN IF NOT EXISTS currency_code char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE catalog_item_org_pricing op
  SET currency_code = o.currency_code
  FROM organizations o
  WHERE o.id = op.org_id AND op.currency_code IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled currency_code on % catalog_item_org_pricing rows from organizations', n; END IF;
END $$;

ALTER TABLE catalog_item_org_pricing ALTER COLUMN currency_code SET NOT NULL;

-- NOT VALID + guarded validation: an org carrying a legacy off-list currency
-- (wave 1 left those in place) must not abort the migration.
DO $$ BEGIN
  ALTER TABLE catalog_item_org_pricing ADD CONSTRAINT catalog_item_org_pricing_currency_code_fkey
    FOREIGN KEY (currency_code) REFERENCES supported_currencies(code) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE catalog_item_org_pricing VALIDATE CONSTRAINT catalog_item_org_pricing_currency_code_fkey;
EXCEPTION WHEN foreign_key_violation THEN
  RAISE WARNING 'multi-currency: catalog_item_org_pricing has off-list currency_code rows; catalog_item_org_pricing_currency_code_fkey left NOT VALID';
END $$;

-- 4) Composite same-partner FKs + partner index.
DO $$ BEGIN
  ALTER TABLE catalog_item_org_pricing ADD CONSTRAINT catalog_item_org_pricing_item_partner_fk
    FOREIGN KEY (catalog_item_id, partner_id) REFERENCES catalog_items(id, partner_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE catalog_item_org_pricing ADD CONSTRAINT catalog_item_org_pricing_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS catalog_item_org_pricing_partner_idx ON catalog_item_org_pricing (partner_id);
