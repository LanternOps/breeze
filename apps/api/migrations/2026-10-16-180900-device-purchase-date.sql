-- Hardware Lifecycle report: purchase date on agent devices and manual assets.
--
-- purchase_date_source records who set the value:
--   'manual' — an operator typed it; warranty sync never overwrites it.
--   'vendor' — derived from the vendor ship date on a warranty lookup
--              (Dell shipDate, Lenovo machineInfo.shipDate); sync may refresh it.
-- Both NULL, or both set: a date without provenance cannot be reasoned about
-- by the report, and a source without a date is meaningless.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS purchase_date date;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS purchase_date_source varchar(20);
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_purchase_date_source_chk;
ALTER TABLE devices ADD CONSTRAINT devices_purchase_date_source_chk
  CHECK (
    (purchase_date IS NULL) = (purchase_date_source IS NULL)
    AND (purchase_date_source IS NULL OR purchase_date_source IN ('manual', 'vendor'))
  );

ALTER TABLE manual_assets ADD COLUMN IF NOT EXISTS purchase_date date;
ALTER TABLE manual_assets ADD COLUMN IF NOT EXISTS purchase_date_source varchar(20);
ALTER TABLE manual_assets DROP CONSTRAINT IF EXISTS manual_assets_purchase_date_source_chk;
ALTER TABLE manual_assets ADD CONSTRAINT manual_assets_purchase_date_source_chk
  CHECK (
    (purchase_date IS NULL) = (purchase_date_source IS NULL)
    AND (purchase_date_source IS NULL OR purchase_date_source IN ('manual', 'vendor'))
  );
