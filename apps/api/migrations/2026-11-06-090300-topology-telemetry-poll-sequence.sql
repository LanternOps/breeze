-- Topology M3 Task 7 / M3-D1+D2: the standing interface poll carries a
-- server-owned batch sequence, strictly increasing per arm (and so per arm
-- generation's producer epoch). Allocated under the arm row lock at dispatch;
-- the telemetry sink's sequence acceptance is the replay fence.
-- Schema only; no rows are written.
ALTER TABLE topology_telemetry_arms ADD COLUMN IF NOT EXISTS poll_sequence numeric(20,0) NOT NULL DEFAULT 0;
ALTER TABLE topology_telemetry_arms DROP CONSTRAINT IF EXISTS topology_telemetry_arms_poll_sequence_chk;
ALTER TABLE topology_telemetry_arms ADD CONSTRAINT topology_telemetry_arms_poll_sequence_chk
  CHECK (poll_sequence BETWEEN 0 AND 18446744073709551615);
