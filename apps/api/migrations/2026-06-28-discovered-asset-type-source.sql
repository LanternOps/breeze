-- Type provenance for a discovered asset: 'manual' (a user set the type by hand)
-- or 'auto' (the discovery scan classified it). Once 'manual', re-scans never
-- overwrite asset_type. detected_asset_type always records what the most recent
-- scan WOULD have assigned, so "reset to auto" can restore it instantly.
-- Mirrors the link_source provenance pattern. discovered_asset_type enum already
-- exists (created with the table); reuse it for detected_asset_type.

DO $$
BEGIN
  CREATE TYPE discovered_asset_type_source AS ENUM ('manual', 'auto');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE discovered_assets
  ADD COLUMN IF NOT EXISTS type_source discovered_asset_type_source NOT NULL DEFAULT 'auto';

ALTER TABLE discovered_assets
  ADD COLUMN IF NOT EXISTS detected_asset_type discovered_asset_type;
