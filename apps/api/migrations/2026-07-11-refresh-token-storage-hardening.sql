-- MCP-OAUTH-04: hashed refresh-token storage + forced legacy revocation.
--
-- Before this change `oauth_refresh_tokens.id` stored the RAW oidc-provider
-- refresh-token model id in plaintext — it equals the opaque token the client
-- holds, so a DB / backup / diagnostic-export read granted account access for
-- the token's remaining lifetime. The adapter now stores sha256(rawId) (lower
-- hex) as the row id and omits `jti` from the persisted payload.
--
-- This migration force-retires every legacy plaintext row: revoke its grant
-- family, delete the row, then add constraints that (a) require a 64-hex digest
-- id and (b) forbid a `jti` key in the payload — so an older application node
-- in a mixed-version deploy fails closed rather than reintroducing plaintext
-- storage. Existing clients reconnect after deploy (explicitly approved).
--
-- NOTE: bearer auth checks Redis grant/jti markers, not DB revoked_at — access
-- JWTs minted just before deploy remain valid up to their ~10-minute TTL. That
-- residual window is the accepted rollout tradeoff (design §2 / §Rollout).
--
-- Idempotent: re-running finds no non-digest rows (0 revoked / 0 deleted) and
-- the DROP-then-ADD constraint dance is a net no-op.

DO $$
DECLARE
  n_grants integer;
  n_tokens integer;
BEGIN
  -- 1. Revoke the grant family of every legacy (non-digest-id) refresh row.
  UPDATE oauth_grants g
     SET revoked_at = now(),
         revoked_reason = 'refresh_token_storage_hardening'
   WHERE g.revoked_at IS NULL
     AND g.id IN (
       SELECT rt.payload->>'grantId'
         FROM oauth_refresh_tokens rt
        WHERE rt.id !~ '^[0-9a-f]{64}$'
     );
  GET DIAGNOSTICS n_grants = ROW_COUNT;
  RAISE WARNING 'refresh-token hardening: revoked % legacy grant(s)', n_grants;

  -- 2. Delete the legacy plaintext refresh rows themselves.
  DELETE FROM oauth_refresh_tokens WHERE id !~ '^[0-9a-f]{64}$';
  GET DIAGNOSTICS n_tokens = ROW_COUNT;
  RAISE WARNING 'refresh-token hardening: deleted % legacy refresh-token row(s)', n_tokens;
END $$;

-- 4. Row id must be a lowercase 64-char hex digest.
ALTER TABLE oauth_refresh_tokens DROP CONSTRAINT IF EXISTS oauth_refresh_tokens_id_digest_chk;
ALTER TABLE oauth_refresh_tokens ADD CONSTRAINT oauth_refresh_tokens_id_digest_chk CHECK (id ~ '^[0-9a-f]{64}$');

-- 5. Persisted payload must never carry a `jti` key (it equals the raw token).
ALTER TABLE oauth_refresh_tokens DROP CONSTRAINT IF EXISTS oauth_refresh_tokens_no_jti_chk;
ALTER TABLE oauth_refresh_tokens ADD CONSTRAINT oauth_refresh_tokens_no_jti_chk CHECK (NOT (payload ? 'jti'));
