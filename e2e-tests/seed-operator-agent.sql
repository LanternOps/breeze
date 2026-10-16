-- Seeds the ONE enabled AI agent that `POST /ai/operator/tasks` resolves for
-- the dev org (#5205 W08, #5246).
--
-- The route refuses with 422 OPERATOR_NO_AGENT when an org has no enabled
-- EFFECTIVE agent, and `pnpm db:seed` creates none. The effective agent is
-- the PARTNER-WIDE baseline (org_id NULL) of the kind; an org-owned row is only
-- an override merged onto it and cannot self-enable (resolveEffectiveAgentInner
-- returns null with no baseline — #4170/#7015), so the seed is the baseline,
-- one per partner that owns an organization. Seeding the AGENT (not the task) is
-- deliberate: everything downstream of the button must be produced by the real
-- route, or the test proves nothing about it.
--
-- Idempotent: `ai_agents_partner_kind_uq` is a PARTIAL unique index on
-- (partner_id, kind) WHERE org_id IS NULL AND disabled_at IS NULL, so the
-- conflict target must repeat that predicate or Postgres raises 42P10. A rerun
-- updates the existing row instead of failing.

SELECT set_config('breeze.scope', 'system', true);

INSERT INTO ai_agents (org_id, partner_id, kind, name, enabled, mode, tool_allowlist, created_by)
SELECT
  NULL,
  p.partner_id,
  'triage',
  'Operator',
  true,
  'shadow',
  '["manage_services", "list_services"]'::jsonb,
  u.id
FROM (SELECT DISTINCT partner_id FROM organizations WHERE partner_id IS NOT NULL) p
CROSS JOIN LATERAL (SELECT id FROM users ORDER BY created_at LIMIT 1) u
ON CONFLICT (partner_id, kind) WHERE org_id IS NULL AND disabled_at IS NULL DO UPDATE SET enabled = true;

SELECT 'OPERATOR_AGENT_ID=' || id FROM ai_agents WHERE kind = 'triage' AND org_id IS NULL LIMIT 1;
