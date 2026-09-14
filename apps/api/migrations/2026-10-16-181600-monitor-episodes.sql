-- #5287 W03 (#5290) — monitor breach episodes and recurrence state.
--
-- Shape 1 tenancy on both tables: org_id is DENORMALISED FROM THE DEVICE, never
-- from the monitor definition. A partner-wide monitor (org_id NULL) produces
-- org-scoped episodes, so these rows are always reachable by the device's org
-- and by org erasure.
--
-- end_reason 'device_deleted' is declared for completeness but has no writer in
-- W03: the device cascade deletes these rows outright. Do not add one without
-- also adding a soft-retire path.
--
-- This migration writes no rows, so it needs no breeze.scope elevation.

DO $$ BEGIN
  CREATE TYPE monitor_device_last_state AS ENUM ('ok', 'breach', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE monitor_episode_end_reason AS ENUM ('recovered', 'device_deleted', 'monitor_detached');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE monitor_response_outcome AS ENUM (
    'queued', 'completed', 'failed', 'skipped_paused', 'skipped_no_response'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS monitor_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id uuid NOT NULL REFERENCES monitor_definitions(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  org_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason monitor_episode_end_reason,
  alert_id uuid,
  response_run_id uuid,
  response_outcome monitor_response_outcome,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monitor_episodes_device_org_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
    ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT monitor_episodes_end_chk
    CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);

-- At most ONE open episode per (monitor, device). This index is the real
-- idempotency guarantee behind the FOR UPDATE in episodeService: a concurrent
-- sweep that races past the lock still cannot insert a second open episode.
CREATE UNIQUE INDEX IF NOT EXISTS monitor_episodes_open_uidx
  ON monitor_episodes (monitor_id, device_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS monitor_episodes_org_idx ON monitor_episodes (org_id);
CREATE INDEX IF NOT EXISTS monitor_episodes_device_idx ON monitor_episodes (device_id);
CREATE INDEX IF NOT EXISTS monitor_episodes_window_idx
  ON monitor_episodes (monitor_id, device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS monitor_episodes_alert_idx
  ON monitor_episodes (alert_id) WHERE alert_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS monitor_device_state (
  monitor_id uuid NOT NULL REFERENCES monitor_definitions(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  org_id uuid NOT NULL,
  current_episode_id uuid REFERENCES monitor_episodes(id) ON DELETE SET NULL,
  episodes_in_window integer NOT NULL DEFAULT 0,
  window_started_at timestamptz,
  escalated_at timestamptz,
  -- Deliberately NO FK to alerts: the escalation alert outlives the monitor.
  escalation_alert_id uuid,
  responses_paused boolean NOT NULL DEFAULT false,
  reset_at timestamptz,
  reset_by uuid REFERENCES users(id) ON DELETE SET NULL,
  last_evaluated_at timestamptz,
  last_state monitor_device_last_state NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monitor_device_state_pkey PRIMARY KEY (monitor_id, device_id),
  CONSTRAINT monitor_device_state_device_org_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
    ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT monitor_device_state_window_chk CHECK (episodes_in_window >= 0)
);

CREATE INDEX IF NOT EXISTS monitor_device_state_org_idx ON monitor_device_state (org_id);
CREATE INDEX IF NOT EXISTS monitor_device_state_device_idx ON monitor_device_state (device_id);
CREATE INDEX IF NOT EXISTS monitor_device_state_escalated_idx
  ON monitor_device_state (monitor_id) WHERE escalated_at IS NOT NULL;

ALTER TABLE monitor_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_episodes FORCE ROW LEVEL SECURITY;
ALTER TABLE monitor_device_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_device_state FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'monitor_episodes'
      AND policyname = 'monitor_episodes_isolation'
  ) THEN
    CREATE POLICY monitor_episodes_isolation ON monitor_episodes
      FOR ALL
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'monitor_device_state'
      AND policyname = 'monitor_device_state_isolation'
  ) THEN
    CREATE POLICY monitor_device_state_isolation ON monitor_device_state
      FOR ALL
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
  END IF;
END $$;

-- Additions to existing tables.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS episode_id uuid
  REFERENCES monitor_episodes(id) ON DELETE SET NULL;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS requires_human boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS alerts_episode_idx ON alerts (episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_requires_human_idx
  ON alerts (org_id, status) WHERE requires_human;

-- #5290 — a queued ai_triage child run is NOT a completed action. Correlate the
-- action result to the agent run so the ai.agent.run.completed/failed events can
-- terminalise it (see automationActionResults.ts).
ALTER TABLE automation_action_results ADD COLUMN IF NOT EXISTS agent_run_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS automation_action_results_agent_run_uq
  ON automation_action_results (agent_run_id) WHERE agent_run_id IS NOT NULL;

DO $$ BEGIN
  ALTER TYPE automation_action_terminal_source ADD VALUE IF NOT EXISTS 'agent_run';
EXCEPTION WHEN others THEN NULL; END $$;
