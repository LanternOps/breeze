-- Seeds the ONE enabled AI agent that `POST /ai/operator/tasks` resolves for
-- the dev org (#5205 W08, #5246).
--
-- The route refuses with 422 OPERATOR_NO_AGENT when an org has no enabled
-- agent, and `pnpm db:seed` creates none — so without this the Playwright
-- delegate flow cannot reach admission at all. Seeding the AGENT (not the
-- task) is deliberate: everything downstream of the button must be produced
-- by the real route, or the test proves nothing about it.
--
-- Idempotent: `ai_agents_org_kind_uq` is a PARTIAL unique index on (org_id,
-- kind) WHERE disabled_at IS NULL, so the conflict target must repeat that
-- predicate or Postgres raises 42P10. A rerun
-- updates the existing row instead of failing.

SELECT set_config('breeze.scope', 'system', true);

INSERT INTO ai_agents (org_id, partner_id, kind, name, enabled, mode, tool_allowlist, created_by)
SELECT
  o.id,
  NULL,
  'triage',
  'Operator',
  true,
  'shadow',
  '["manage_services", "list_services"]'::jsonb,
  u.id
FROM organizations o
CROSS JOIN LATERAL (SELECT id FROM users ORDER BY created_at LIMIT 1) u
ON CONFLICT (org_id, kind) WHERE disabled_at IS NULL DO UPDATE SET enabled = true;

SELECT 'OPERATOR_AGENT_ID=' || id FROM ai_agents WHERE kind = 'triage' LIMIT 1;
