-- Wave 6 PR 1 (#3828): covering index for the org-wide keyset-paginated
-- `GET /ai/agents/runs` list (routes/aiAgents.ts, services/aiAgents/runTrace.ts).
--
-- The list walks `(org_id, queued_at DESC, id DESC)` — the id tiebreaker is
-- required because `queued_at` is not unique (two runs can queue in the same
-- millisecond), and a keyset without a tiebreaker can skip or duplicate rows
-- across pages when that happens.
--
-- `ai_agent_runs_org_queued_idx` (2026-09-02-ai-agents.sql, org_id, queued_at
-- DESC — no id column) already exists and is NOT dropped here: dropping an
-- index is a separate decision from adding one, and the old index still
-- serves any planner path that doesn't need the id tiebreaker. Note the
-- redundancy for a future cleanup pass rather than resolving it in this PR.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS. No inner BEGIN/COMMIT — autoMigrate
-- wraps the whole file in one transaction.

CREATE INDEX IF NOT EXISTS ai_agent_runs_org_queued_id_idx
  ON ai_agent_runs (org_id, queued_at DESC, id DESC);
