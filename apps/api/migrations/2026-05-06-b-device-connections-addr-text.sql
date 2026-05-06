-- Follow-up to 2026-05-06-device-connections-widen-addr.sql.
-- The 64-char widen was insufficient: the agent also surfaces non-IP socket
-- paths in local_addr / remote_addr — notably Linux Unix domain sockets like
-- `/run/containerd/s/<64-hex>` (~78 chars) — misclassified under a `tcp`
-- protocol. Widening to text removes the column as a failure point with zero
-- storage cost (text and varchar share the same on-disk representation in
-- Postgres). The agent will be updated separately to filter / classify these.
--
-- Idempotent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_connections'
      AND column_name = 'local_addr'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE device_connections ALTER COLUMN local_addr TYPE text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_connections'
      AND column_name = 'remote_addr'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE device_connections ALTER COLUMN remote_addr TYPE text;
  END IF;
END $$;
