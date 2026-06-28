-- Link provenance for a discovered asset: 'manual' (user action) or 'auto'
-- (discovery worker MAC/IP match). Nullable; NULL = not linked, or a link that
-- predates this column. No backfill by design. (The unlink-eligibility policy
-- keyed off this value lives in the API route, the source of truth for it.)

DO $$
BEGIN
  CREATE TYPE discovered_asset_link_source AS ENUM ('manual', 'auto');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE discovered_assets
  ADD COLUMN IF NOT EXISTS link_source discovered_asset_link_source;

-- link_source is a property of a link, so it is only meaningful when a device
-- is linked. Forbid the nonsensical "source without a link" state. Satisfiable
-- with no backfill: existing rows have link_source NULL.
DO $$
BEGIN
  ALTER TABLE discovered_assets
    ADD CONSTRAINT discovered_assets_link_source_requires_link
    CHECK (link_source IS NULL OR linked_device_id IS NOT NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
