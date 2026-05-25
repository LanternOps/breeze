-- Task 18 (launch-readiness): Auto-suspend agent tokens after repeated
-- cross-tenant probe attempts.
--
-- agentWs's `crossTenantDrops` counter previously only emitted a Sentry
-- breadcrumb; a compromised token could spray cross-tenant result IDs
-- indefinitely. We now persist suspension in two columns so the suspension
-- survives reconnects and is enforced at every auth gate (REST middleware
-- and the agent WS validateAgentToken path). Clearing these columns
-- (manual SQL or future admin endpoint) re-enables the token.
--
-- Idempotent: safe to re-run.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS agent_token_suspended_at timestamp;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS agent_token_suspended_reason varchar(100);

-- Partial index — most devices have NULL so the index stays tiny while
-- still letting ops queries (e.g. "show all suspended tokens") use it.
CREATE INDEX IF NOT EXISTS idx_devices_agent_token_suspended_at
  ON devices(agent_token_suspended_at)
  WHERE agent_token_suspended_at IS NOT NULL;
