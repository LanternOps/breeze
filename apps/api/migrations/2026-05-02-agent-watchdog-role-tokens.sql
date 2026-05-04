ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS watchdog_token_hash varchar(64),
  ADD COLUMN IF NOT EXISTS watchdog_token_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS previous_watchdog_token_hash varchar(64),
  ADD COLUMN IF NOT EXISTS previous_watchdog_token_expires_at timestamptz;
