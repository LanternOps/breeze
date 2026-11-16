-- #10102: the signed offline release token key an episode was started with.
-- release_token_public_key: base64 of the 32-byte Ed25519 public key sent to the agent at start and
--   pinned there for the episode. Public material. NULL when the episode has no token release (no
--   signing key configured, or the agent does not accept the fields).
-- release_token_required: the containment policy's requireSignedReleaseToken, as sent at start. The
--   agent then refuses break-glass codes for the episode. Never true without a key.
-- Both are written once, at start, and re-sent unchanged on every heartbeat, like allow_snapshot.
ALTER TABLE device_network_isolations
  ADD COLUMN IF NOT EXISTS release_token_public_key text,
  ADD COLUMN IF NOT EXISTS release_token_required boolean NOT NULL DEFAULT false;

ALTER TABLE device_network_isolations DROP CONSTRAINT IF EXISTS device_network_isolations_release_token_chk;
ALTER TABLE device_network_isolations ADD CONSTRAINT device_network_isolations_release_token_chk
  CHECK (
    (release_token_public_key IS NULL OR release_token_public_key ~ '^[A-Za-z0-9+/]{43}=$')
    AND (NOT release_token_required OR release_token_public_key IS NOT NULL)
  );
