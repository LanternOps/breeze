-- #7038: per-version vendor-documented installer success exit codes (winget's
-- InstallerSuccessCodes analog, e.g. Veeam Agent's 1000/1101). They ADD to the
-- agent's built-in success codes (0; 3010/1641 for exe/msi); the empty default
-- keeps every existing version on the historical behavior.
--
-- bigint[] because Windows exit codes are 32-bit DWORDs: the API stores the
-- unsigned spelling (0..4294967295), which overflows integer. The constant
-- default makes this a metadata-only ALTER. software_versions has no org_id
-- (it is reached through software_catalog), so no cascade/export registration
-- applies; existing RLS policies on the table cover the new column.
ALTER TABLE software_versions
  ADD COLUMN IF NOT EXISTS success_exit_codes bigint[] NOT NULL DEFAULT '{}'::bigint[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'software_versions_success_exit_codes_chk'
      AND conrelid = 'public.software_versions'::regclass
  ) THEN
    ALTER TABLE software_versions
      ADD CONSTRAINT software_versions_success_exit_codes_chk CHECK (
        cardinality(success_exit_codes) <= 32
        AND 0 <= ALL (success_exit_codes)
        AND 4294967295 >= ALL (success_exit_codes)
      );
  END IF;
END $$;
