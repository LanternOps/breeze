-- Broaden the email_verification_tokens INSERT/UPDATE RLS policies so a user can
-- mint and supersede their OWN verification token from their own request context.
--
-- The mint path (services/pendingEmail.ts -> invalidateOpenTokens +
-- generateVerificationToken) runs in the CALLER's request context on
-- PATCH /users/me. The table's partner-axis policy
-- (breeze_has_partner_access(partner_id)) is satisfied for partner- and
-- system-scope callers, but DENIES an ORG-scoped caller (its
-- accessible_partner_ids is empty) -> the token INSERT raised 42501 and the
-- email-change request 500'd for every org-scoped user.
--
-- Fix: add a `user_id = breeze_current_user_id()` branch. The row belongs to
-- that user, and the request context sets breeze.current_user_id
-- (middleware/auth.ts), so the caller may write their own token in-context —
-- no system-context escalation, so the write stays in the caller's transaction
-- (atomic with the pending-email write, and the mint reads the email_epoch this
-- same operation advances). The partner/system branch is unchanged; SELECT and
-- DELETE stay partner-axis (consume runs under a system context).
--
-- Idempotent: DROP IF EXISTS + CREATE re-applies to the same broadened policy.
-- The partner-axis contract test still passes — the predicate still references
-- breeze_has_partner_access (rls-coverage.integration.test.ts:149).

DO $$ BEGIN
  DROP POLICY IF EXISTS breeze_evt_isolation_insert ON email_verification_tokens;
  CREATE POLICY breeze_evt_isolation_insert ON email_verification_tokens
    FOR INSERT
    WITH CHECK (breeze_has_partner_access(partner_id) OR user_id = breeze_current_user_id());

  DROP POLICY IF EXISTS breeze_evt_isolation_update ON email_verification_tokens;
  CREATE POLICY breeze_evt_isolation_update ON email_verification_tokens
    FOR UPDATE
    USING      (breeze_has_partner_access(partner_id) OR user_id = breeze_current_user_id())
    WITH CHECK (breeze_has_partner_access(partner_id) OR user_id = breeze_current_user_id());
END $$;
