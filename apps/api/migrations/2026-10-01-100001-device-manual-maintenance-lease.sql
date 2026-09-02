-- 2026-10-01-100001: persist the MANUAL device maintenance lease (RMM-QA-176).
--
-- POST /devices/:id/maintenance echoed `durationHours` into an audit detail and
-- threw it away, so "extend the window" was not a distinguishable operation and
-- there was no durable record of who suppressed monitoring on a device, why, or
-- until when. These four columns are that record, written in the SAME
-- transaction as the status change, which is what makes the audit trail's
-- actor/reason/window claim backed rather than best-effort.
--
-- Deliberately NOT indexed: nothing queries maintenance_until yet. RMM-QA-217
-- ("the heartbeat preserves the lease and the suppression consumers honour it")
-- is the ticket that reads this column across the fleet and adds the index it
-- needs. The shape here is chosen so 217 needs no second migration:
-- start / until / reason / actor is exactly its contract.
--
-- started_by is ON DELETE SET NULL, not RESTRICT: erasing a user must never be
-- blocked by a device that happens to be in maintenance. The CHECK below
-- therefore permits a null actor beside a live window, while still forbidding a
-- half-written lease (an `until` with no reason, or a reason with no window).

ALTER TABLE devices ADD COLUMN IF NOT EXISTS maintenance_started_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS maintenance_until timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS maintenance_reason varchar(500);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS maintenance_started_by uuid
  REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_maintenance_lease_chk'
  ) THEN
    ALTER TABLE devices ADD CONSTRAINT devices_maintenance_lease_chk CHECK (
      (maintenance_until IS NULL AND maintenance_started_at IS NULL AND maintenance_reason IS NULL)
      OR (maintenance_until IS NOT NULL AND maintenance_started_at IS NOT NULL AND maintenance_reason IS NOT NULL)
    );
  END IF;
END $$;
