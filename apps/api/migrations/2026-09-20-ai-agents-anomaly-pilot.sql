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

-- Branch-review blocker 1 (#3828): ai_agent_runs_trigger_kind_chk was created
-- inside an `IF NOT EXISTS` guard in the shipped 2026-09-02-ai-agents.sql, so
-- an already-migrated database never picked up 'anomaly' when it was added to
-- AI_AGENT_TRIGGER_KINDS above — every anomaly-triggered admission attempt
-- failed 23514. Drop and re-add so the DB-side CHECK stays in lockstep with
-- the shared trigger-kind enum. Contract test:
-- aiAgentRuns.integration.test.ts's "ai_agent_runs_trigger_kind_chk — DB
-- constraint matches AI_AGENT_TRIGGER_KINDS" reads pg_get_constraintdef back
-- and asserts value-set equality against AI_AGENT_TRIGGER_KINDS in both
-- directions, so the next new trigger kind cannot repeat this silently.
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_trigger_kind_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_trigger_kind_chk
  CHECK (trigger_kind IN ('alert', 'manual', 'schedule', 'ticket', 'anomaly'));

-- Branch-review blocker 2 (#3828): breeze_cascade_device_org_id() (last
-- replaced in 2026-09-06-a-agent-runs-org-immutable.sql) detaches
-- ai_agent_runs' device-lineage pointers on a device org-move but was never
-- extended for anomaly_incident_id (added above, after that migration
-- shipped) — a source-org run kept pointing at a now-foreign incident once
-- the generic denormalized-table loop re-stamped metric_anomaly_incidents to
-- the destination org, and GET /runs/:id would project a cross-tenant
-- incident id. Also null the reverse pointer
-- (metric_anomaly_incidents.agent_run_id, no FK) for the moved device BEFORE
-- the generic loop re-stamps its org_id, for the same reason: left alone, it
-- keeps naming a source-org run after the move. Full function body copied
-- from 2026-09-06-a (the newest definition; no later migration replaces this
-- function) with both fixes added — only the two new statements are new.
CREATE OR REPLACE FUNCTION public.breeze_cascade_device_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
  AS $$
DECLARE
  child_table text;
BEGIN
  -- Agent-run history stays with the SOURCE org (owner decision 2026-08-23):
  -- sever the moved device's lineage links instead of re-stamping org_id.
  UPDATE public.ai_agent_runs
    SET device_id = NULL, alert_id = NULL, session_id = NULL, anomaly_incident_id = NULL
    WHERE device_id = NEW.id;
  -- Reverse pointer: the incident's back-link to the (now-detached) run must
  -- not keep naming a source-org run once the incident itself is re-stamped
  -- to the destination org by the generic loop below.
  UPDATE public.metric_anomaly_incidents
    SET agent_run_id = NULL
    WHERE device_id = NEW.id;
  FOR child_table IN SELECT public.breeze_device_child_orgid_tables() LOOP
    EXECUTE format(
      'UPDATE public.%I SET org_id = $1 WHERE device_id = $2 AND org_id IS DISTINCT FROM $1',
      child_table
    ) USING NEW.org_id, NEW.id;
  END LOOP;
  RETURN NULL; -- AFTER trigger; return value ignored
END;
$$;
