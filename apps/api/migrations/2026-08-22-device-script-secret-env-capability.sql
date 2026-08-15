-- #3409 PR4a — agent capability handshake for encrypted secret-env delivery.
--
-- 0 = the agent does not understand `secretEnv` (any build predating PR4b, or a
-- downgrade back to one). An agent that ignores the field runs the script with
-- the credential env var UNSET, which can mean anonymous access, an auth
-- fallback, account lockouts, or a destructive operation against the wrong
-- target — so the PR4c dispatch gate refuses to send a secret-bearing script to
-- a 0 device rather than letting it run without the secret.
--
-- Gated on an explicit capability version, never on semver: the agent declares
-- what it can do. Written unconditionally on every heartbeat (non-sticky, same
-- contract as outbound_network_policy_version), so a downgrade self-heals back
-- to 0 instead of leaving a stale capability claim the gate would trust.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS script_secret_env_version integer NOT NULL DEFAULT 0;
