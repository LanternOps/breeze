-- SEC-2026-09-05-026: bind each local vault's tenant axis to its device.
--
-- Older application code admitted caller-org rows that named another org's
-- device. Delete those unusable configurations before enforcing the invariant;
-- report both the parent and cascaded inventory counts for forensic follow-up.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  mismatch_vault_count bigint;
  mismatch_inventory_count bigint;
BEGIN
  SELECT count(*) INTO mismatch_inventory_count
  FROM vault_snapshot_inventory AS inventory
  JOIN local_vaults AS vault ON vault.id = inventory.vault_id
  JOIN devices AS device ON device.id = vault.device_id
  WHERE vault.org_id <> device.org_id;

  DELETE FROM local_vaults AS vault
  WHERE EXISTS (
    SELECT 1
    FROM devices AS device
    WHERE device.id = vault.device_id
      AND device.org_id <> vault.org_id
  );
  GET DIAGNOSTICS mismatch_vault_count = ROW_COUNT;

  RAISE WARNING
    'SEC-026 cleanup removed % mismatched local vault(s) and cascaded % snapshot inventory row(s)',
    mismatch_vault_count,
    mismatch_inventory_count;
END $$;

DO $$
BEGIN
  ALTER TABLE local_vaults
    ADD CONSTRAINT local_vaults_device_org_fkey
    FOREIGN KEY (device_id, org_id)
    REFERENCES devices(id, org_id)
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE local_vaults
  VALIDATE CONSTRAINT local_vaults_device_org_fkey;
