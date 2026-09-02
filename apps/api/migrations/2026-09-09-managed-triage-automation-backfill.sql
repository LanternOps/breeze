-- AI agents wave 3d (#3824): seed the managed triage automation for triage
-- agents that already existed when this wave shipped.
--
-- ensureManagedTriageAutomation has exactly one production call site
-- (services/aiAgents/agentService.ts createAgent), so a triage agent created
-- during waves 3a-3c has no alert.triggered wiring at all: it produces zero
-- alert-driven runs forever, with no error anywhere, and the tenant cannot
-- self-heal it — updateAgent rejects a disabled agent and the partial unique
-- index ai_agents_org_kind_uq forbids a second live triage agent, so the only
-- other remedy is disable + recreate, losing the agent's configuration and its
-- run history.
--
-- The seeded row mirrors services/aiAgents/managedAutomation.ts EXACTLY:
--   * owner axis copied from the agent (org XOR partner, per
--     automations_one_owner_chk);
--   * NO trigger filter — severity/site/tag/maintenance/cooldown filtering
--     lives on the agent policy and is applied by the wave-3c admission gate;
--   * enabled = the agent's own flag, never a hardcoded true, so an off agent
--     never gets live wiring in front of it.
--
-- Idempotent: ON CONFLICT DO NOTHING against the partial unique index
-- automations_managed_by_agent_uq (2026-09-08-managed-by-agent.sql), so
-- re-applying is a no-op and an agent seeded by createAgent is skipped.
-- Runtime drift after this point (a restore from an older dump, a lost seed
-- race) is repaired by syncManagedAutomation's ensure-then-update path.

DO $$
DECLARE
  seeded integer;
BEGIN
  -- automations and ai_agents are both FORCE ROW LEVEL SECURITY, and FORCE
  -- applies to the table owner too. A migration is not a request, so it carries
  -- no tenant context: take the documented system branch of the isolation
  -- policies explicitly. `true` = transaction-local, reverted with this block.
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO automations (
    org_id, partner_id, name, description, enabled,
    trigger, actions, on_failure, created_by, managed_by_agent_id
  )
  SELECT
    a.org_id,
    a.partner_id,
    a.name || ' — alert triage',
    'System-managed: wakes the AI triage agent on alerts. Edit the agent, not this automation.',
    a.enabled,
    '{"type": "event", "eventType": "alert.triggered"}'::jsonb,
    '[{"type": "ai_triage"}]'::jsonb,
    'stop',
    a.created_by,
    a.id
  FROM ai_agents a
  WHERE a.kind = 'triage'
    AND a.disabled_at IS NULL
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS seeded = ROW_COUNT;
  IF seeded > 0 THEN
    RAISE WARNING 'wave 3d backfill: seeded % managed triage automation(s) for pre-existing agents', seeded;
  END IF;
END $$;
