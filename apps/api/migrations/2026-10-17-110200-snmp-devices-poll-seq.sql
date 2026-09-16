-- Network device page truth W01 (spec §7.1) — the per-device dispatch counter
-- that W02's `slow` cadence gates on. The column ships in W01 so the wire
-- contract's two waves cannot disagree about the schema; nothing in W01 writes
-- or reads it.
--
-- W02 increments it at dispatch and includes `cadence: 'slow'` specs only when
-- `poll_seq % 12 = 0`, so a 5-minute device refreshes static columns (ifDescr,
-- prtMarkerSuppliesDescription, …) hourly instead of every poll.
--
-- Expansion-only, NOT NULL DEFAULT 0. No DML, so no breeze.scope election.

ALTER TABLE snmp_devices
  ADD COLUMN IF NOT EXISTS poll_seq INTEGER NOT NULL DEFAULT 0;
