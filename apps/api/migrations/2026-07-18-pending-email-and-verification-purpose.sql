-- Core authentication hardening PR 4 (SR2-17): pending-email workflow.
-- Idempotent. No inner BEGIN/COMMIT (the runner wraps each file in a txn).
--
-- Changing an account email no longer moves users.email immediately. The
-- request records the requested address here and advances users.email_epoch;
-- the VERIFIED address in users.email stays authoritative for login, password
-- reset, CF Access matching and SSO matching until a verification token issued
-- for the pending address is redeemed. That closes the takeover where a stolen
-- session repoints the recovery address and the attacker then owns the account
-- outright, with no proof of control of the new mailbox.
--
-- pending_email is intentionally NOT UNIQUE: two accounts may request the same
-- address concurrently. Exactly one can COMMIT it — the swap runs against the
-- existing users_email_unique constraint, so the loser fails closed (23505).
-- A unique index here would instead let the first requester squat an address
-- they never proved control of.

ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email varchar(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email_requested_at timestamptz;

-- Verification tokens now serve two purposes. 'signup' is the historical one
-- (prove the address on a brand-new partner). 'email_change' proves control of
-- a PENDING address on an existing account; consume() branches on this and the
-- two branches have different live-row checks (signup matches users.email;
-- email_change matches users.pending_email and then SWAPS it in). Defaulting
-- pre-existing rows to 'signup' is correct: every row minted before this
-- migration was a signup token.
ALTER TABLE email_verification_tokens
  ADD COLUMN IF NOT EXISTS purpose varchar(32) NOT NULL DEFAULT 'signup';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_verification_tokens_purpose_chk'
  ) THEN
    ALTER TABLE email_verification_tokens
      ADD CONSTRAINT email_verification_tokens_purpose_chk
      CHECK (purpose IN ('signup', 'email_change'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS users_pending_email_idx ON users (pending_email)
  WHERE pending_email IS NOT NULL;
