-- Bind rotation grace to the immediately previous refresh JTI. The digest is
-- advanced in the same transaction as current_refresh_jti_digest/last_used_at,
-- so PostgreSQL can distinguish a concurrent predecessor from an older replay
-- without relying on a post-commit Redis marker.
ALTER TABLE refresh_token_families
  ADD COLUMN IF NOT EXISTS previous_refresh_jti_digest varchar(64);
