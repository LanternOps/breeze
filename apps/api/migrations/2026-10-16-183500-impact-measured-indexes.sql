-- @no-transaction
-- AI Scorecard W04 (#5761, refs #4182) — cohort indexes for the MEASURED impact
-- band on /ai-agents/impact.
--
-- Indexes only. No DML, therefore no `SELECT set_config('breeze.scope', ...)`
-- and deliberately NO entry in the frozen baseline of
-- apps/api/src/db/migrationRlsScope.test.ts. No new table and no new column, so
-- no cascade-, export-policy- or org-merge-registry entry either.
--
-- CREATE INDEX CONCURRENTLY (autoMigrate's @no-transaction lane, same shape as
-- 2026-05-17-b-alerts-scale-indexes.sql) so building these does not take a SHARE
-- lock on `alerts` or `tickets` at deploy time.
--
-- The four indexes serve the three cohort scans in
-- apps/api/src/services/aiAgents/impactMeasuredCohorts.ts. Each was checked
-- against what already exists on main; a superset of an existing index is not
-- added.

-- The alert cohort scans one org, one rule, one window of triggered_at.
-- alerts_org_status_triggered_at_idx (org_id, status, triggered_at DESC) leads
-- with status, which the cohort scan does not filter on; alerts_rule_id_idx
-- (rule_id) alone forces a heap re-check per org. Neither serves (org, rule, time).
CREATE INDEX CONCURRENTLY IF NOT EXISTS alerts_org_rule_triggered_idx
  ON alerts (org_id, rule_id, triggered_at);

-- The ticket cohort scans one org over a window of created_at. tickets_org_status_idx
-- and tickets_org_work_kind_idx exist, but neither has a created_at leading pair.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tickets_org_created_at_idx
  ON tickets (org_id, created_at);

-- Run-based alert exposure: MIN(started_at) for the runs attached to one alert in
-- one org. Only ai_agent_runs_device_id_idx / _ticket_id_idx / _org_queued_idx
-- exist today — nothing on (org_id, alert_id). Partial, because the vast majority
-- of runs carry no alert_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_agent_runs_org_alert_started_idx
  ON ai_agent_runs (org_id, alert_id, started_at)
  WHERE alert_id IS NOT NULL;

-- Run-based ticket exposure. ai_agent_runs_ticket_id_idx (ticket_id) alone forces
-- a heap re-check per org.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_agent_runs_org_ticket_started_idx
  ON ai_agent_runs (org_id, ticket_id, started_at)
  WHERE ticket_id IS NOT NULL;

-- Deliberately NOT added:
--   ai_alert_verdicts     — already has _org_alert_idx (org_id, alert_id) WHERE
--                           alert_id IS NOT NULL and _org_group_idx (org_id,
--                           correlation_group_id) WHERE correlation_group_id IS
--                           NOT NULL. A MIN(created_at) over the handful of
--                           verdicts for one alert does not justify a superset.
--   alert_correlation_members — already has _org_alert_idx and _org_group_idx.
--   time_entries / ticket_drafts — time_entries_ticket_idx and
--                           ticket_drafts_ticket_idx already exist.
