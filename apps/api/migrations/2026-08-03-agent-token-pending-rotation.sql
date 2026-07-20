-- Issue #2621 — two-phase agent credential rotation (persist-before-commit).
--
-- Before this migration, POST /agents/:id/rotate-token minted new agent,
-- watchdog and helper credentials AND committed their hashes as current in a
-- single UPDATE. The agent only afterwards attempted to write the plaintext to
-- secrets.yaml. A failed disk write left the server holding hashes the endpoint
-- could not reproduce: the agent kept running on in-memory credentials, then
-- loaded stale ones from disk on restart and 401'd forever once the 5-minute
-- previous-token grace window expired.
--
-- These columns let rotation stage the new hashes as PENDING while the current
-- credentials stay fully valid. The agent durably persists + reads back the new
-- plaintext, then calls /rotate-token/confirm authenticated WITH the new token
-- (proof it holds a durable copy) to promote pending -> current. An abandoned
-- rotation simply expires and the last known durable credentials stay
-- authoritative, so a disk failure can no longer strand the endpoint.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS pending_token_hash varchar(64),
  ADD COLUMN IF NOT EXISTS pending_watchdog_token_hash varchar(64),
  ADD COLUMN IF NOT EXISTS pending_helper_token_hash varchar(64),
  ADD COLUMN IF NOT EXISTS pending_token_expires_at timestamptz;

COMMENT ON COLUMN devices.pending_token_hash IS
  'Issue #2621: staged agent-token hash from a two-phase rotation. Accepted for auth until pending_token_expires_at; promoted to agent_token_hash only once the agent confirms durable persistence.';
COMMENT ON COLUMN devices.pending_token_expires_at IS
  'Issue #2621: expiry for the staged (pending) agent/watchdog/helper token hashes. After this instant an unconfirmed rotation is dead and the current credentials remain authoritative.';

-- Partial index: the auth path only probes rows with a live staged rotation,
-- which is a vanishingly small slice of the fleet at any instant.
CREATE INDEX IF NOT EXISTS devices_pending_token_expires_at_idx
  ON devices (pending_token_expires_at)
  WHERE pending_token_hash IS NOT NULL;
