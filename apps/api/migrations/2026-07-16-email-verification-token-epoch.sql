-- Bind email-verification tokens to the email generation they were issued for
-- (issue #2428). Idempotent.
--
-- `users.email_epoch` (added 2026-07-15) advances on every committed email
-- change. Until now nothing READ it, so a verification link issued for the OLD
-- address stayed redeemable after the address moved — consuming it stamped
-- `users.email_verified_at` and marked the NEW, never-proven address verified.
--
-- The token row now carries the `email_epoch` it was minted under, and
-- `consumeVerificationToken` rejects a token whose epoch no longer matches the
-- live user row (reported as 'superseded'). This mirrors the reset-token
-- envelope, which binds `password_reset_epoch` + the exact normalized email and
-- fails closed the same way (routes/auth/password.ts).
--
-- Nullable on purpose: rows minted before this migration carry NULL and fall
-- back to the exact-address match alone, so in-flight signup links keep working
-- across the deploy instead of hard-failing every pending verification.
ALTER TABLE email_verification_tokens
  ADD COLUMN IF NOT EXISTS email_epoch integer;

COMMENT ON COLUMN email_verification_tokens.email_epoch IS
  'users.email_epoch at mint time. Consume requires a match (NULL = pre-2026-07-16 row, address-match only).';
