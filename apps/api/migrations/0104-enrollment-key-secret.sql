BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'enrollment_keys'
      AND column_name = 'key_secret_hash'
  ) THEN
    ALTER TABLE enrollment_keys ADD COLUMN key_secret_hash varchar(64);
  END IF;
END $$;

COMMIT;
