ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS helper_token_hash varchar(64),
  ADD COLUMN IF NOT EXISTS helper_token_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS previous_helper_token_hash varchar(64),
  ADD COLUMN IF NOT EXISTS previous_helper_token_expires_at timestamptz;
