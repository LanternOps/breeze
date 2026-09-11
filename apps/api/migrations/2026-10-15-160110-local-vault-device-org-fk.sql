-- SEC-2026-09-05-026: bind each local vault's tenant axis to its device.
--
-- Older application code admitted caller-org rows that named another org's
-- device. Repair those rows the way the rest of the repo repairs this shape:
-- restamp org_id FROM THE DEVICE, which is exactly what the dynamic
-- breeze_cascade_device_org_id() trigger has done on every device move since
-- 2026-05-18 (2026-05-18-device-child-orgid-cascade.sql). Two reasons not to
-- delete:
--
--   1. A mismatch here is indistinguishable from a benign pre-2026-05-18
--      device move that predates that trigger's backfill window. The migration
--      cannot tell that apart from the SEC-026 abuse path, so it must not pick
--      the destructive reading.
--   2. Deleting a local_vault cascades vault_snapshot_inventory
--      (ON DELETE CASCADE), which is recovery metadata describing backups of
--      data that lives on the VICTIM org's device. Destroying it to repair an
--      attacker-created pointer would compound the harm.
--
-- The vault is deactivated as well: an attacker-chosen vault_path must not
-- start syncing under the victim's org just because the tenant axis got
-- corrected. A human re-enables it after confirming the path.
--
-- vault_snapshot_inventory keys on vault_id, not device_id, so the device
-- trigger never covers it — it is restamped here explicitly, after the parent.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  restamped_vault_count bigint;
  restamped_inventory_count bigint;
  restamped_vault_ids uuid[];
  restamped_inventory_ids uuid[];
BEGIN
  -- Capture the affected ids BEFORE each repair; the predicates stop matching
  -- once the rows are corrected. Capped at 200 so a large historical drift
  -- cannot flood the server log; the counts are always exact and uncapped.
  SELECT (array_agg(vault.id ORDER BY vault.id))[1:200]
  INTO restamped_vault_ids
  FROM local_vaults AS vault
  JOIN devices AS device ON device.id = vault.device_id
  WHERE vault.org_id <> device.org_id;

  UPDATE local_vaults AS vault
  SET org_id = device.org_id,
      is_active = false,
      updated_at = now()
  FROM devices AS device
  WHERE device.id = vault.device_id
    AND device.org_id <> vault.org_id;
  GET DIAGNOSTICS restamped_vault_count = ROW_COUNT;

  -- Runs after the parent restamp so it observes the corrected vault org.
  SELECT (array_agg(inventory.id ORDER BY inventory.id))[1:200]
  INTO restamped_inventory_ids
  FROM vault_snapshot_inventory AS inventory
  JOIN local_vaults AS vault ON vault.id = inventory.vault_id
  WHERE inventory.org_id <> vault.org_id;

  UPDATE vault_snapshot_inventory AS inventory
  SET org_id = vault.org_id
  FROM local_vaults AS vault
  WHERE vault.id = inventory.vault_id
    AND inventory.org_id <> vault.org_id;
  GET DIAGNOSTICS restamped_inventory_count = ROW_COUNT;

  RAISE WARNING
    'SEC-026 cleanup restamped and deactivated % mismatched local vault(s) (ids, first 200: %) and restamped % vault_snapshot_inventory row(s) (ids, first 200: %)',
    restamped_vault_count,
    coalesce(restamped_vault_ids, ARRAY[]::uuid[]),
    restamped_inventory_count,
    coalesce(restamped_inventory_ids, ARRAY[]::uuid[]);
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
