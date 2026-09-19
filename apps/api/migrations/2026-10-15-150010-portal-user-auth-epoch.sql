ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS auth_epoch integer;

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  affected_rows bigint;
BEGIN
  UPDATE portal_users SET auth_epoch = 1 WHERE auth_epoch IS NULL;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RAISE WARNING 'initialized auth_epoch for % portal_users rows', affected_rows;
END $$;

ALTER TABLE portal_users
  ALTER COLUMN auth_epoch SET DEFAULT 1,
  ALTER COLUMN auth_epoch SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'portal_users'::regclass
      AND conname = 'portal_users_auth_epoch_positive_chk'
  ) THEN
    ALTER TABLE portal_users
      ADD CONSTRAINT portal_users_auth_epoch_positive_chk CHECK (auth_epoch > 0);
  END IF;
END $$;
