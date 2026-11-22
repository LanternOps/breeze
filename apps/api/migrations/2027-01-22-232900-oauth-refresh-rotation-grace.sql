-- #10301: refresh-token rotation grace window (apps/api/src/oauth/refreshRotationGrace.ts).
--
-- consume() writes both columns in the SAME UPDATE that consumes a refresh
-- token during rotation:
--   rotated_at       rotation provenance. revoked_at alone cannot tell a
--                    rotation from destroy() or a family revocation.
--   successor_sealed the successor token, AES-256-GCM sealed under a key derived
--                    from this row's RAW token (never stored) and the server
--                    secret. Cleared by the client's next rotation once older
--                    than the 30 s cap (REFRESH_ROTATION_GRACE_MAX_MS).
--
-- Additive and nullable. Rows consumed before this change, with
-- OAUTH_REFRESH_ROTATION_GRACE_MS=0, without a sealing key, or by anything other
-- than a refresh_token rotation leave both NULL, and a later presentation takes
-- the strict reuse path. No rows are written here, so no system scope is needed.

ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS rotated_at timestamptz;
ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS successor_sealed text;

-- Serves the per-client clearing of stale seals. Only rows that still carry a
-- seal are indexed: roughly one per recently active client.
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_sealed_client_idx
  ON oauth_refresh_tokens (client_id, rotated_at)
  WHERE successor_sealed IS NOT NULL;
