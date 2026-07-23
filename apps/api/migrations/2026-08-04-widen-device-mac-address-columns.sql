-- Widen device MAC-address columns from varchar(17) to varchar(64).
--
-- Standard Ethernet MACs are 17 chars (XX:XX:XX:XX:XX:XX), but Windows
-- pseudo-interfaces (Teredo, ISATAP tunnels) and InfiniBand report longer
-- EUI-64 / tunnel hardware addresses (up to ~53 chars). The agent network
-- inventory payload schema already accepts macAddress up to 64 chars
-- (apps/api/src/routes/agents/schemas.ts), but these DB columns were left at
-- varchar(17). As a result, device_network inserts for any device with such
-- an interface failed with PostgresError 22001 ("value too long for type
-- character varying(17)"), rolling back the whole network-inventory
-- transaction and permanently blocking that device's network updates
-- (Sentry BREEZE-3, ~4k events). device_ip_history silently truncated the
-- same MACs to 17 chars instead of failing.
--
-- Increasing a varchar length is a metadata-only change in PostgreSQL (no
-- table rewrite, no index rebuild), safe to run on hot tables. Idempotent:
-- guarded on the current column width so re-applying is a no-op.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_network'
      AND column_name = 'mac_address'
      AND character_maximum_length < 64
  ) THEN
    ALTER TABLE device_network ALTER COLUMN mac_address TYPE varchar(64);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'device_ip_history'
      AND column_name = 'mac_address'
      AND character_maximum_length < 64
  ) THEN
    ALTER TABLE device_ip_history ALTER COLUMN mac_address TYPE varchar(64);
  END IF;
END $$;
