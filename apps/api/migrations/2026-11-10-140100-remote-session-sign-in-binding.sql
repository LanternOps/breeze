-- Remote sessions end with the sign-in session that opened them.
--
-- Logout now ends exactly one sign-in session: it durably revokes that
-- sign-in's refresh family (refresh_token_families.revoked_at) and no longer
-- advances the user's auth epoch or writes a user-wide cutoff. A remote
-- desktop/terminal/file-transfer session or a relay tunnel opened from that
-- sign-in records its family here, and the live authority behind every viewer
-- token, WebSocket ticket, continuation and periodic socket recheck refuses a
-- session whose family was revoked. Sessions opened from the user's other
-- sign-ins keep running.
--
-- Nullable, no backfill: rows created before this migration (and sessions
-- opened without a browser/mobile sign-in, e.g. by an API key) record no
-- family and keep only their existing checks. No foreign key: the value is
-- compared by the revocation check only, and a missing family row simply
-- never matches it (same shape as refresh_token_families.mobile_device_id).
-- Adding a nullable column without a default is a catalog-only change.

ALTER TABLE remote_sessions ADD COLUMN IF NOT EXISTS auth_session_id uuid;
ALTER TABLE tunnel_sessions ADD COLUMN IF NOT EXISTS auth_session_id uuid;

COMMENT ON COLUMN remote_sessions.auth_session_id IS
  'refresh_token_families.family_id of the sign-in session that opened this remote session; the session ends when that family is revoked (logout). NULL = not bound to a sign-in.';
COMMENT ON COLUMN tunnel_sessions.auth_session_id IS
  'refresh_token_families.family_id of the sign-in session that opened this tunnel; the tunnel ends when that family is revoked (logout). NULL = not bound to a sign-in.';
