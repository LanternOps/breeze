ALTER TABLE enrollment_keys
  ADD COLUMN IF NOT EXISTS short_code VARCHAR(12),
  ADD COLUMN IF NOT EXISTS installer_platform VARCHAR(16);

CREATE UNIQUE INDEX IF NOT EXISTS enrollment_keys_short_code_key
  ON enrollment_keys(short_code)
  WHERE short_code IS NOT NULL;
