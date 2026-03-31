BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'devices'
      AND column_name = 'token_issued_at'
  ) THEN
    ALTER TABLE devices ADD COLUMN token_issued_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'devices'
      AND column_name = 'previous_token_hash'
  ) THEN
    ALTER TABLE devices ADD COLUMN previous_token_hash varchar(64);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'devices'
      AND column_name = 'previous_token_expires_at'
  ) THEN
    ALTER TABLE devices ADD COLUMN previous_token_expires_at timestamptz;
  END IF;
END $$;

COMMIT;
