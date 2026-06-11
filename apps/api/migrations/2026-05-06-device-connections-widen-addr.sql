-- device_connections.local_addr / remote_addr — widen from varchar(45) to
-- varchar(64). IPv6 max textual length is 39, but Linux link-local addresses
-- carry a zone id suffix (e.g. `fe80::abcd:1234%eno12345`) which routinely
-- exceeds 45 chars and was causing every PUT /agents/:id/connections from
-- such hosts to 500 with Postgres error 22001.
--
-- (Superseded by 2026-05-06-b-device-connections-addr-text.sql, which
-- widens further to text after we discovered the agent also surfaces Unix
-- socket paths up to ~80 chars in this column. This file is kept as the
-- migration tracker has already recorded it on some clusters.)
--
-- Idempotent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_connections'
      AND column_name = 'local_addr'
      AND data_type = 'character varying'
      AND character_maximum_length < 64
  ) THEN
    ALTER TABLE device_connections
      ALTER COLUMN local_addr TYPE varchar(64);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_connections'
      AND column_name = 'remote_addr'
      AND data_type = 'character varying'
      AND character_maximum_length < 64
  ) THEN
    ALTER TABLE device_connections
      ALTER COLUMN remote_addr TYPE varchar(64);
  END IF;
END $$;
