ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_epoch integer NOT NULL DEFAULT 1;

ALTER TABLE refresh_token_families
  ADD COLUMN IF NOT EXISTS absolute_expires_at timestamptz;

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE refresh_token_families
  SET absolute_expires_at = created_at + interval '30 days'
  WHERE absolute_expires_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled absolute_expires_at on % refresh_token_families row(s)', n;
  END IF;
END $$;

ALTER TABLE refresh_token_families
  ALTER COLUMN absolute_expires_at SET NOT NULL;
