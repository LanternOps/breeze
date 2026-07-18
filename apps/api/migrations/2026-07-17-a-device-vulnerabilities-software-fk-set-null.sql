-- device_vulnerabilities.software_inventory_id had no ON DELETE action, so the
-- agent software report (PUT /agents/:id/software), which wipes and reinserts a
-- device's software_inventory rows, failed with FK violation 23503 for any
-- device that had correlated software findings — freezing that device's
-- software inventory permanently (Sentry BREEZE-3). SET NULL matches the
-- correlation service's semantics: upsertDeviceVulnerability re-links the
-- finding to the current inventory row on the next scan, and the report route
-- re-links surviving software in the same transaction.
--
-- The constraint is added NOT VALID to skip the full-table validation scan
-- while ALTER TABLE holds its lock on both tables (agent reports and
-- correlation writes would queue behind it during deploy). Existing rows are
-- guaranteed valid — the dropped constraint enforced the same reference — and
-- the companion -b- migration VALIDATEs in a separate transaction under the
-- weaker SHARE UPDATE EXCLUSIVE lock.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'device_vulnerabilities_software_inventory_id_fkey'
      AND conrelid = 'device_vulnerabilities'::regclass
      AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE device_vulnerabilities
      DROP CONSTRAINT device_vulnerabilities_software_inventory_id_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'device_vulnerabilities_software_inventory_id_fkey'
      AND conrelid = 'device_vulnerabilities'::regclass
  ) THEN
    ALTER TABLE device_vulnerabilities
      ADD CONSTRAINT device_vulnerabilities_software_inventory_id_fkey
      FOREIGN KEY (software_inventory_id) REFERENCES software_inventory(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

-- The SET NULL referential trigger fires once per deleted software_inventory
-- row (up to 10k per software report) and executes
-- `UPDATE device_vulnerabilities SET software_inventory_id = NULL WHERE
-- software_inventory_id = $1` — RI triggers bypass RLS, so without an index
-- each firing is a scan of the whole multi-tenant table. The same index serves
-- the report route's finding-snapshot join.
CREATE INDEX IF NOT EXISTS device_vuln_software_inventory_idx
  ON device_vulnerabilities (software_inventory_id)
  WHERE software_inventory_id IS NOT NULL;
