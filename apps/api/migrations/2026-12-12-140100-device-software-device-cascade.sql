-- @no-transaction
-- Org erasure: device_software.device_id -> devices gets ON DELETE CASCADE.
--
-- device_software has no org_id of its own, so cascadeDeleteOrg() never
-- deletes from it directly, and its baseline FK into devices has no ON DELETE
-- action (NO ACTION). The first inventory row for any of an org's devices
-- therefore made org erasure abort with 23503 at `DELETE FROM devices`,
-- leaving the tenant half-erased. Inventory rows are meaningless without their
-- device, so CASCADE is the correct action. Same change as
-- 2026-12-12-140000-org-erasure-fk-child-cascade.sql, split out because of the
-- table's size.
--
-- device_software is a large, agent-written table and devices takes a write on
-- every heartbeat. Re-adding the FK inside a transaction would hold
-- SHARE ROW EXCLUSIVE on devices (blocking heartbeat updates) for the whole
-- validation scan. Instead:
--   1. swap the constraint NOT VALID in one ALTER TABLE statement (catalog
--      only, no scan). It still needs ACCESS EXCLUSIVE on device_software and
--      SHARE ROW EXCLUSIVE on devices, and a lock request queued behind a
--      long-running transaction blocks every later writer on that table, so
--      lock_timeout bounds the wait: the statement fails after 5s instead of
--      stalling heartbeats, and the file is safe to re-run. The constraint
--      being replaced already guaranteed every row is valid, and a NOT VALID
--      FK still checks new rows and still fires its ON DELETE action;
--   2. VALIDATE it as a separate statement, which takes only
--      SHARE UPDATE EXCLUSIVE on device_software and ROW SHARE on devices, so
--      agent writes continue during the scan.
-- lock_timeout is set per session here (each statement is sent on its own)
-- and RESET at the end so it does not leak into later migrations.
--
-- Idempotent: re-applying re-swaps and re-validates the same definition. An
-- interruption between the two statements leaves an enforcing NOT VALID
-- constraint that the next run validates. No row is written here.

SET lock_timeout = '5s';

ALTER TABLE public.device_software
  DROP CONSTRAINT IF EXISTS device_software_device_id_devices_id_fk,
  ADD CONSTRAINT device_software_device_id_devices_id_fk
    FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.device_software
  VALIDATE CONSTRAINT device_software_device_id_devices_id_fk;

RESET lock_timeout;
