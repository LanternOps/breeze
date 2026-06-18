-- Neutralize orphaned `users` rows left behind by membership-only deletes (#1367).
--
-- Before this release, DELETE /users/:id removed only the membership row
-- (partner_users / organization_users) and left the `users` row behind with
-- its old name, status='active', and password_hash intact. Two consequences:
--
--   1. SECURITY: the "deleted" user could still authenticate. login.ts only
--      bounces on `!user.password_hash` or `status != 'active'`, and
--      resolveCurrentUserTokenContext returns a null-context system-scope token
--      (instead of throwing) for a membership-less user — so a removed employee
--      who still knew their password could log back in.
--   2. RESURRECTION: re-inviting the same email reused the orphaned row with its
--      stale active status + password, blocking the new invitee from setting a
--      password via the magic link ("invite already accepted").
--
-- The `users` row cannot simply be deleted — dozens of created_by/approved_by/
-- triggered_by FKs reference it with ON DELETE RESTRICT. Instead we neutralize
-- every existing orphan: disable it and strip the password + MFA secrets so it
-- can neither authenticate nor be resurrected with old credentials. The next
-- invite of that email resets the row to a clean invited state (handled in the
-- invite route). Going forward the delete route neutralizes on the last
-- membership removal, so this backfill only ever has to run once.
--
-- An orphan is a user with NO row in partner_users AND NO row in
-- organization_users. Idempotent: re-running only touches rows that are still
-- active orphans, and a clean DB neutralizes zero rows.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE users u
  SET status = 'disabled',
      disabled_reason = 'removed',
      password_hash = NULL,
      mfa_enabled = false,
      mfa_secret = NULL,
      mfa_method = NULL,
      mfa_recovery_codes = NULL,
      updated_at = now()
  WHERE NOT EXISTS (SELECT 1 FROM partner_users pu WHERE pu.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM organization_users ou WHERE ou.user_id = u.id)
    -- Only touch rows that still carry login-capable state, so a re-run (or a
    -- row already neutralized by the delete route) is a true no-op.
    AND (u.status <> 'disabled' OR u.password_hash IS NOT NULL);

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    -- Forensic trail: these rows were login-capable accounts with no
    -- membership. A non-zero count post-deploy is worth correlating against
    -- any "deleted user could still sign in" reports.
    RAISE WARNING 'neutralized % orphaned user row(s) (no membership, had login-capable state) [#1367]', n;
  END IF;
END $$;
