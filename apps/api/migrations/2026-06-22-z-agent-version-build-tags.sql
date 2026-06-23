DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'devices'
      AND column_name = 'agent_version'
      AND data_type = 'character varying'
      AND character_maximum_length < 128
  ) THEN
    ALTER TABLE devices ALTER COLUMN agent_version TYPE varchar(128);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'devices'
      AND column_name = 'watchdog_version'
      AND data_type = 'character varying'
      AND character_maximum_length < 128
  ) THEN
    ALTER TABLE devices ALTER COLUMN watchdog_version TYPE varchar(128);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_logs'
      AND column_name = 'agent_version'
      AND data_type = 'character varying'
      AND character_maximum_length < 128
  ) THEN
    ALTER TABLE agent_logs ALTER COLUMN agent_version TYPE varchar(128);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_versions'
      AND column_name = 'version'
      AND data_type = 'character varying'
      AND character_maximum_length < 128
  ) THEN
    ALTER TABLE agent_versions ALTER COLUMN version TYPE varchar(128);
  END IF;
END $$;
