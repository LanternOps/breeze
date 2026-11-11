-- Service Catalog item configuration (#8325, spec §4).
-- Adds only the item fields accepted for this wave: grouping (pillar, service line),
-- portal visibility and sort order. ITIL class, delivery, SLA target, form, category
-- and work type are deferred to the waves that use them (maintainer sign-off on #8784).
-- Idempotent; no RLS change (service_catalog_items already has forced RLS, ownership
-- policies and grants).

ALTER TABLE service_catalog_items
  ADD COLUMN IF NOT EXISTS pillar varchar(120),
  ADD COLUMN IF NOT EXISTS service_line varchar(120),
  ADD COLUMN IF NOT EXISTS show_in_portal boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  -- Descriptive grouping only (pillar -> service line -> activity); no taxonomy tables.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_catalog_items_grouping_chk') THEN
    ALTER TABLE service_catalog_items ADD CONSTRAINT service_catalog_items_grouping_chk CHECK (
      (pillar IS NULL OR btrim(pillar) <> '')
      AND (service_line IS NULL OR btrim(service_line) <> '')
      -- A service line only exists inside a pillar.
      AND (service_line IS NULL OR pillar IS NOT NULL)
    );
  END IF;
END $$;
