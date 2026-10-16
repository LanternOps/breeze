-- #7969: optional pinned scan agent on a discovery profile.
--
-- NULL = unpinned: the dispatcher picks an online agent in the profile's site,
-- preferring one with an interface inside a profile subnet. Set = only that
-- device may run the profile's scans; if it is offline the job fails with a
-- reason instead of falling back to another device.
--
-- Named `pinned_device_id`, not `device_id`: the profile is not owned by the
-- device, so it must not enrol in the device cascade / child-org-id machinery
-- (`breeze_device_child_orgid_tables()`, CORE_DEVICE_CASCADE_DELETE_TABLES).
--
-- Composite FK (pinned_device_id, org_id) -> devices(id, org_id): the database
-- itself refuses a pin onto another org's device. ON DELETE SET NULL names the
-- link column only — a plain composite SET NULL would also null the NOT NULL
-- org_id and abort device/org deletion with 23502
-- (orgCascadeFkOnDelete.integration.test.ts reads confdelsetcols).
-- DEFERRABLE INITIALLY IMMEDIATE so org merge (SET CONSTRAINTS ALL DEFERRED)
-- can re-point both tables. A device org-move detaches the pin before the
-- devices.org_id flip (services/deviceOrgMove/moveDeviceOrgInTransaction.ts).
--
-- No row writes, so no breeze.scope election is needed.

ALTER TABLE discovery_profiles
  ADD COLUMN IF NOT EXISTS pinned_device_id uuid;

DO $$ BEGIN
  ALTER TABLE discovery_profiles
    ADD CONSTRAINT discovery_profiles_pinned_device_org_fk
    FOREIGN KEY (pinned_device_id, org_id) REFERENCES devices(id, org_id)
    ON DELETE SET NULL (pinned_device_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS discovery_profiles_pinned_device_idx
  ON discovery_profiles(pinned_device_id) WHERE pinned_device_id IS NOT NULL;
