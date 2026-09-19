-- apps/api/migrations/2026-09-30-ai-budget-alert-events.sql
-- #4388 Pre-cap AI budget alerts (spec: docs/superpowers/specs/ai-mcp/2026-09-01-ai-budget-threshold-alerts-design.md §4.1, §4.3)

-- 1. Per-org threshold ladder. NULL = inherit the default (50,80,95); '{}' = pre-cap warnings off.
ALTER TABLE ai_budgets ADD COLUMN IF NOT EXISTS alert_threshold_pcts integer[];

-- 2. One row per (org, period, period_key, rung) crossing. Durable outbox for delivery.
CREATE TABLE IF NOT EXISTS ai_budget_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period text NOT NULL CONSTRAINT ai_budget_alert_events_period_chk CHECK (period IN ('daily', 'monthly')),
  period_key varchar(10) NOT NULL,
  threshold_pct smallint NOT NULL CONSTRAINT ai_budget_alert_events_pct_chk CHECK (threshold_pct BETWEEN 1 AND 100),
  cap_cents integer NOT NULL,
  used_cents integer NOT NULL,
  billing_source text NOT NULL CONSTRAINT ai_budget_alert_events_source_chk CHECK (billing_source IN ('platform', 'partner_key')),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0,
  last_delivery_error text,
  recipient_count integer
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_budget_alert_events_org_period_rung_uidx
  ON ai_budget_alert_events (org_id, period, period_key, threshold_pct);
CREATE INDEX IF NOT EXISTS ai_budget_alert_events_undelivered_idx
  ON ai_budget_alert_events (created_at)
  WHERE delivered_at IS NULL;

-- 3. RLS shape 1 (direct NOT NULL org_id). breeze_has_org_access already grants
-- system scope, so no separate system branch (same idiom as ticket_drafts,
-- 2026-09-25-ai-agents-ticket-triage.sql).
ALTER TABLE ai_budget_alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_budget_alert_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_budget_alert_events;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_budget_alert_events;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_budget_alert_events;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_budget_alert_events;

CREATE POLICY breeze_org_isolation_select ON ai_budget_alert_events
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_budget_alert_events
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_budget_alert_events
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_budget_alert_events
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_budget_alert_events TO breeze_app;
