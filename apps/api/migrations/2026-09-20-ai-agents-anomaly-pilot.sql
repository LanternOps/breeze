-- Wave 6 PR 4 (#3828) — metric-anomaly pilot: schema foundation (Task 1).
-- docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-4-anomaly-pilot.md
--
-- metric_anomaly_incidents is the CANONICAL incident row per
-- (org_id, device_id, anomaly_type, bucket_seconds, window_start) — the same
-- collapsing key as metricAnomalyPromotion.ts's findDedupeSiblings, with
-- metric_name deliberately excluded so every sibling detector row for the
-- same device/window/type collapses onto one incident. Direct org_id
-- (Tenancy Shape 1, auto-discovered by rls-coverage.integration.test.ts).
--
-- The incident row IS the dispatch outbox: dispatched_at / dispatch_attempts
-- / agent_run_id. Task 2's detector upsert's DO UPDATE SET list will refresh
-- ONLY last_seen_at / peak_score / row_count / metric_names and must NEVER
-- touch dispatched_at — that omission is what makes a bulk re-upsert
-- publish-inert by construction (see Task 2's regression test). This
-- migration only creates the columns; the upsert statement itself is Task 2.
--
-- agent_run_id (the dispatch marker's best-effort back-link, Task 3) carries
-- NO FOREIGN KEY constraint at all, in Drizzle OR in SQL here — deliberately,
-- and NOT for the reason ticket_comments.agent_run_id skips a Drizzle-side
-- `.references()` (that one avoids only an import cycle and still gets a
-- real SQL-level FK, safely, because ticket_comments has no org_id column and
-- is outside the org-cascade graph entirely).
--
-- metric_anomaly_incidents DOES have org_id and IS in that graph — a real
-- mutual FK pair here (this column -> ai_agent_runs, plus
-- ai_agent_runs.anomaly_incident_id -> this table below) forms a genuine
-- 2-node cycle in tenantCascade.ts's `topologicalCascadeOrder()`, which
-- walks pg_constraint directly (not the Drizzle schema) and THROWS on any
-- cycle regardless of ON DELETE action — confirmed by running the
-- integration suite against this exact migration. Breaking the cycle means
-- exactly one direction may be a real constraint; `anomaly_incident_id`
-- below keeps it (same treatment as this table's sibling trigger columns
-- alert_id/device_id/ticket_id), and agent_run_id stays a plain UUID with
-- app-level consistency only (Task 3 sets it best-effort and never depends
-- on DB-enforced integrity for it — see metricAnomalyIncidents.ts).
--
-- Dossier correction vs the plan's original assumption ("a mutual SET NULL
-- pair is fine for cascade order... the runtime topo-sort resolves the real
-- FK edges"): the topo-sort resolves EDGE DIRECTION, not EDGE EXISTENCE — it
-- has no special case for SET NULL and cannot order a true cycle no matter
-- which ON DELETE action either side uses. Recorded here since the plan
-- explicitly called this out as something to verify, not assume.
--
-- peak_score is unconstrained `numeric` (no precision/scale): the detector's
-- raw `score` column (metric_anomalies.score, doublePrecision) is an
-- unbounded magnitude, not the 0-1 `confidence` domain — see
-- AiAgentTriggers.minAnomalyScore's docstring for why the trigger filter
-- validates against this same unbounded domain rather than 0-1.
--
-- ai_agent_runs.anomaly_incident_id: the triggering incident for a
-- triggerKind='anomaly' run (Task 3). ON DELETE SET NULL — run history
-- survives incident deletion, mirroring alert_id/device_id/ticket_id's
-- treatment on this same table.
--
-- Idempotent throughout: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, DROP CONSTRAINT/POLICY IF EXISTS before each re-add. autoMigrate
-- wraps this file in one transaction — no inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS metric_anomaly_incidents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id          uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  anomaly_type       text NOT NULL,
  bucket_seconds     integer NOT NULL,
  window_start       timestamptz NOT NULL,
  first_seen_at      timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL,
  peak_score         numeric NOT NULL,
  row_count          integer NOT NULL DEFAULT 1,
  metric_names       text[] NOT NULL DEFAULT '{}',
  dispatched_at      timestamptz,
  dispatch_attempts  integer NOT NULL DEFAULT 0,
  agent_run_id       uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Explicitly no agent_run_id FK constraint — see the file header for why
-- (breaking a real FK cycle in tenantCascade's topological sort).
ALTER TABLE metric_anomaly_incidents DROP CONSTRAINT IF EXISTS metric_anomaly_incidents_agent_run_id_fkey;

CREATE UNIQUE INDEX IF NOT EXISTS metric_anomaly_incidents_key_uq ON metric_anomaly_incidents (
  org_id, device_id, anomaly_type, bucket_seconds, window_start
);

-- Task 2's publisher claim query (`dispatched_at IS NULL ... FOR UPDATE SKIP
-- LOCKED`) walks this partial index.
CREATE INDEX IF NOT EXISTS metric_anomaly_incidents_undispatched_idx
  ON metric_anomaly_incidents (org_id, id) WHERE dispatched_at IS NULL;

CREATE INDEX IF NOT EXISTS metric_anomaly_incidents_org_last_seen_idx
  ON metric_anomaly_incidents (org_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS metric_anomaly_incidents_device_id_idx
  ON metric_anomaly_incidents (device_id);

CREATE INDEX IF NOT EXISTS metric_anomaly_incidents_agent_run_id_idx
  ON metric_anomaly_incidents (agent_run_id);

-- RLS: direct org_id (Shape 1) — standard org isolation, same policy shape
-- as ticket_outbox / metric_anomalies. breeze_has_org_access already grants
-- system scope, so Task 2's publisher (withSystemDbAccessContext) and Task
-- 3's subscriber need no separate branch.
ALTER TABLE metric_anomaly_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_anomaly_incidents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON metric_anomaly_incidents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON metric_anomaly_incidents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON metric_anomaly_incidents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON metric_anomaly_incidents;

CREATE POLICY breeze_org_isolation_select ON metric_anomaly_incidents
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON metric_anomaly_incidents
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON metric_anomaly_incidents
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON metric_anomaly_incidents
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ai_agent_runs: nullable anomaly_incident_id link for triggerKind='anomaly'
-- runs (Task 3 writes it).
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS anomaly_incident_id UUID
  REFERENCES metric_anomaly_incidents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ai_agent_runs_anomaly_incident_id_idx ON ai_agent_runs (anomaly_incident_id);
