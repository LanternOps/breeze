-- Companion to 2026-07-17-a: VALIDATE the NOT VALID FK in its own transaction.
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, so agent reports and
-- correlation writes proceed during the scan (unlike a validating ADD
-- CONSTRAINT, which would hold the ALTER's exclusive lock for the duration).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'device_vulnerabilities_software_inventory_id_fkey'
      AND conrelid = 'device_vulnerabilities'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE device_vulnerabilities
      VALIDATE CONSTRAINT device_vulnerabilities_software_inventory_id_fkey;
  END IF;
END $$;
