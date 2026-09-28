-- Adds bare_metal_recoveries.platform so a recovery row records which
-- rebuild-engine platform its source snapshot targets ('linux' | 'windows').
-- Idempotent; no BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

ALTER TABLE bare_metal_recoveries ADD COLUMN IF NOT EXISTS platform text;

DO $$
BEGIN
  ALTER TABLE bare_metal_recoveries
    ADD CONSTRAINT bare_metal_recoveries_platform_chk
    CHECK (platform IS NULL OR platform IN ('linux', 'windows'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
