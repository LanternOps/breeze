-- Partner-level default markup over distributor cost (percent), used to pre-fill
-- the listed sell price when importing catalog items (TD SYNNEX / external). It
-- feeds the catalog `markup_percent` field, so it shares its numeric(6,2) bounds
-- (0..9999.99). Stored as a percent value (e.g. 30.00). The import view shows
-- the resulting gross margin alongside.
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS default_markup_percent numeric(6,2);
