-- Clear the unused password_hash on portal logins that sign in through Entra.
--
-- A portal login provisioned by AI for Office has auth_method = 'entra' and
-- signs in through Entra ID only. Since #5471, every password path requires
-- auth_method = 'password' before it reads or writes password_hash: portal
-- login, password-reset request and completion, invite acceptance and
-- browser-session hydration (the session middleware refuses non-password rows,
-- which also keeps them off the password-change route). A password_hash stored
-- on an 'entra' row is therefore never read. Rows written before that change
-- can still hold one. This clears it, so the stored data matches the rule and
-- no unused credential material is kept.
--
-- Predicate: auth_method = 'entra' AND password_hash IS NOT NULL.
-- auth_method is NOT NULL with CHECK (auth_method IN ('password', 'entra'))
-- (2026-06-12-b-client-ai-foundation.sql), the Entra sign-in path is the only
-- writer of 'entra' rows, and no code path changes auth_method after insert.
-- A password login (auth_method = 'password') can never match.
--
-- Only password_hash (and updated_at) changes. auth_epoch is left alone on
-- purpose: bumping it would sign every affected user out of AI for Office,
-- and browser portal sessions for these rows are already refused by the
-- session middleware. Password-reset tokens (1 h) and invite tokens (7 d) live
-- in Redis, or in process memory without Redis, never in the database, and
-- both are refused for 'entra' rows when they are consumed.
--
-- WRITES ROWS: system scope is set first, because FORCE RLS applies to the
-- migration role. The count is logged either way: WARNING when rows changed,
-- NOTICE when none did. Idempotent: a re-run matches nothing.
-- autoMigrate wraps this file in a transaction, so there is no BEGIN/COMMIT here.
DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE public.portal_users
     SET password_hash = NULL,
         updated_at = now()
   WHERE auth_method = 'entra'
     AND password_hash IS NOT NULL;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'portal_users: cleared an unused password_hash on % auth_method=entra row(s)', n;
  ELSE
    RAISE NOTICE 'portal_users: cleared an unused password_hash on % auth_method=entra row(s)', n;
  END IF;
END $$;
