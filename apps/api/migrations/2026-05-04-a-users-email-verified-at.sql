-- Track which user clicked the verification link.
-- partners.email_verified_at already records "this tenant has verified an
-- email address". Adding the same stamp on users lets us re-verify or
-- block re-resend on a per-user basis when a partner has multiple users
-- (the foreseeable case once we surface a "send another verification
-- email" affordance from the user's profile page).
--
-- Idempotent: column add is gated on IF NOT EXISTS.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamp;
