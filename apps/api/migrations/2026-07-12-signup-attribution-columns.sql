-- Signup/enrollment attribution columns for abuse detection.
-- Nullable; existing rows stay NULL. Idempotent.

ALTER TABLE partners ADD COLUMN IF NOT EXISTS signup_ip varchar(45);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS signup_user_agent text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS enrollment_ip varchar(45);
