-- Wave 6 Task 4 (security remediation): agent outbound-network-policy
-- capability handshake.
--
-- Tasks 1-3 hardened agent/internal/netpolicy to refuse loopback/link-local/
-- metadata/CGNAT/reserved destinations outright and gate RFC1918/ULA
-- destinations on an exact-origin allowlist. Task 5 (next) will send that
-- allowlist to devices and gate dispatch on whether the AGENT build actually
-- enforces it — an old agent that doesn't understand the policy must not be
-- silently trusted to enforce it.
--
-- This column is the capability the heartbeat reports: 0 (default) means
-- "unknown / not enforcing" — every pre-existing row and every heartbeat
-- from an agent build that omits `securityCapabilities` entirely. Only the
-- API-recognized integer version 1 is ever written as anything other than 0
-- (see apps/api/src/routes/agents/heartbeat.ts). Expand-only: no backfill,
-- no data migration, existing readers already tolerate an unknown column
-- because nothing reads it until Task 5 lands.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. No inner BEGIN/COMMIT — autoMigrate
-- wraps this file in one transaction.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS outbound_network_policy_version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN devices.outbound_network_policy_version IS
  'Wave 6 Task 4: agent outbound-network-policy capability version reported by the last heartbeat. 0 = unknown/not enforcing (default; also what an old agent that omits securityCapabilities reports). 1 = agent/internal/netpolicy enforcement (Tasks 1-3) is active. Written unconditionally every heartbeat, not sticky, so a downgrade to an older build correctly reports back down to 0.';
