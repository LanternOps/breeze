-- 2026-04-24: oauth_authorization_codes — relax partner_id to nullable.
--
-- E2E browser testing surfaced that oidc-provider's authorization endpoint
-- creates auth codes (short-lived, 10-min TTL) without any awareness of our
-- partner concept. Partner identity flows through the Grant (which survives
-- as the long-lived authorization record), so the auth code's partner_id is
-- informational at best and impossible to populate at code-mint time.
--
-- Without this change, every successful /oauth/auth → /oauth/token flow
-- 500s with "null value in column partner_id violates not-null constraint"
-- because the AuthorizationCode adapter upsert leaves partner_id undefined.
--
-- Idempotent. Safe to re-run.

BEGIN;

ALTER TABLE oauth_authorization_codes
  ALTER COLUMN partner_id DROP NOT NULL;

COMMIT;
