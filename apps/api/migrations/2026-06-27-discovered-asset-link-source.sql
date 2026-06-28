-- Records how a discovered asset became linked to a managed device:
-- 'manual' (user action) or 'auto' (discovery worker MAC/IP match).
-- NULL = not linked, or link predates this column. NULL is treated as
-- non-manual and is NOT unlinkable. No backfill by design.

DO $$
BEGIN
  CREATE TYPE discovered_asset_link_source AS ENUM ('manual', 'auto');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE discovered_assets
  ADD COLUMN IF NOT EXISTS link_source discovered_asset_link_source;
