BEGIN;

-- Bind C2C OAuth consent sessions to the initiating user when available.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'c2c_consent_sessions'
      AND column_name = 'user_id'
  ) THEN
    ALTER TABLE c2c_consent_sessions ADD COLUMN user_id uuid REFERENCES users(id);
  END IF;
END $$;

COMMIT;
