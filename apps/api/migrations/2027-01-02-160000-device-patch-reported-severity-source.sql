-- #9387 gap 2: record WHERE a device's reported patch severity came from.
--
-- Windows Update leaves IUpdate.MsrcSeverity empty for most updates
-- (cumulative updates, drivers, definitions, feature updates), so nearly every
-- Microsoft row reached device_patches.reported_severity as 'unknown'. The
-- agent now derives a severity from the update's classification and title
-- when MSRC sends none, and says so. This column carries that provenance so
-- the UI can label a derived value as derived and nobody mistakes it for a
-- vendor rating:
--
--   'vendor'  - the vendor's own rating (Windows Update: MSRC severity)
--   'derived' - inferred agent-side from classification/title
--   NULL      - no provenance reported (older agents, non-Windows providers,
--               every row written before this migration) or severity unknown
--
-- Per-device and per-org like reported_severity beside it (device_patches is
-- already RLS-covered); it never touches the shared, un-tenanted patches row.
-- Adding a nullable column with no default is metadata-only: no rewrite, no
-- row writes.
ALTER TABLE device_patches ADD COLUMN IF NOT EXISTS reported_severity_source varchar(16);

DO $$ BEGIN
  ALTER TABLE device_patches
    ADD CONSTRAINT device_patches_reported_severity_source_chk
    CHECK (reported_severity_source IS NULL OR reported_severity_source IN ('vendor', 'derived'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
END $$;
