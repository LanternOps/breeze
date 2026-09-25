-- #6449: persist per-device "update offers withheld" state so stranded devices
-- are visible in the UI. Nullable, no default: metadata-only ALTER on the hot
-- devices table. Existing RLS policies on devices cover the new columns.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS update_offer_withheld_reason varchar(50);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS update_offer_withheld_since timestamptz;

