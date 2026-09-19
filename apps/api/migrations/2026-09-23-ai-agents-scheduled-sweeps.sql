-- Phase 2 wave P2-2 (#4187 / #4189): scheduled sweeps.
--   1. ai_agent_schedules — dual-owner config (partner baseline XOR org override).
--   2. ai_agent_runs.schedule_id + profile CHECK admits 'sweep'.
--   3. action_intents typed target scope (scope_kind / scope_device_id) so an
--      intent minted by a device-less run is still bound to one device.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- 1. ai_agent_schedules -------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_agent_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- INVARIANT (review round 1, Important 3, #4189) — enforced in the WRITE
  -- PATH, not by a DB constraint: both parents (ai_agents, ai_agent_schedules
  -- itself) are dual-owner, so a composite FK that must tolerate a NULL leg
  -- for one shape cannot also express "same owner" for the other — a
  -- NULL-bearing composite FK is simply unenforced for org rows. The
  -- invariant is:
  --   - an org override's baseline must be a partner row belonging to the
  --     org's OWN partner, with the SAME agent_id as the override;
  --   - a partner row's agent must itself be a partner-wide triage agent
  --     under that SAME partner_id.
  -- Enforced by services/aiAgents/scheduleService.ts (Task A8) under a
  -- SELECT ... FOR SHARE on the baseline row at write time, with an
  -- integration test there covering the forge cases a DB constraint can't
  -- express here.
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  -- Org override → the partner baseline it tightens. NULL iff partner row.
  -- Same cross-tenant-pointer invariant as agent_id above — see that comment.
  baseline_schedule_id uuid NULL REFERENCES ai_agent_schedules(id) ON DELETE CASCADE,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  sweep_kinds text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  last_enqueued_at timestamptz NULL,
  -- Local wall-clock occurrence key ("2026-08-29T06:00@Europe/Berlin"); the
  -- tick fires once per DISTINCT key, which is what makes DST fall-back a
  -- single fire (see services/aiAgents/sweepOccurrence.ts).
  last_occurrence_key text NULL,
  -- Aggregate counters only ({ occurrenceKey, orgsTotal, runsAdmitted,
  -- runsSkipped, skipReasons }). Never per-org detail: partner rows are
  -- readable by every org under the partner via the effective resolver.
  last_run_summary jsonb NULL,
  created_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_schedules_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
  CONSTRAINT ai_agent_schedules_baseline_chk CHECK ((org_id IS NULL) = (baseline_schedule_id IS NULL)),
  CONSTRAINT ai_agent_schedules_cron_len_chk CHECK (char_length(cron) BETWEEN 9 AND 120),
  CONSTRAINT ai_agent_schedules_kinds_chk CHECK (
    sweep_kinds <@ ARRAY['disk_pressure','stale_agents','pending_reboots','failed_backups','service_down','unpatched_critical']::text[]
  )
);
CREATE INDEX IF NOT EXISTS ai_agent_schedules_partner_idx ON ai_agent_schedules (partner_id) WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_agent_schedules_org_idx ON ai_agent_schedules (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_agent_schedules_agent_idx ON ai_agent_schedules (agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_schedules_org_baseline_uq
  ON ai_agent_schedules (org_id, baseline_schedule_id) WHERE org_id IS NOT NULL;

ALTER TABLE ai_agent_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_schedules_isolation ON ai_agent_schedules;
CREATE POLICY ai_agent_schedules_isolation ON ai_agent_schedules
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_schedules TO breeze_app;

-- 2. ai_agent_runs -------------------------------------------------------------
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS schedule_id uuid NULL
  REFERENCES ai_agent_schedules(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ai_agent_runs_schedule_idx ON ai_agent_runs (schedule_id) WHERE schedule_id IS NOT NULL;
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk CHECK (profile IN ('full', 'verdict', 'sweep'));

-- 3. action_intents typed target scope ----------------------------------------
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS scope_kind text NULL;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS scope_device_id uuid NULL
  REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_scope_kind_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_scope_kind_chk
  CHECK (scope_kind IS NULL OR scope_kind = 'device');
-- A device id without a kind is meaningless; a kind without a device id is a
-- TOMBSTONE (the device was deleted after the intent was created) and release
-- must fail closed on it — see services/actionIntents/intentTargetScope.ts.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_scope_device_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_scope_device_chk
  CHECK (scope_device_id IS NULL OR scope_kind = 'device');
CREATE INDEX IF NOT EXISTS action_intents_scope_device_idx ON action_intents (scope_device_id) WHERE scope_device_id IS NOT NULL;

-- Extend the ONE immutable-content function (2026-09-05-a): scope_kind is
-- immutable; scope_device_id may only make the tombstone transition
-- non-null -> NULL (the FK's ON DELETE SET NULL), never be retargeted.
-- The IF-list below is the CURRENT (2026-09-05-a) definition copied verbatim
-- plus these two new lines — see
-- apps/api/src/testUtils/actionIntentsTriggerDenyList.ts for why the RAISE
-- text must stay byte-identical to the previous definition.
CREATE OR REPLACE FUNCTION action_intents_block_content_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requesting_api_key_id IS DISTINCT FROM OLD.requesting_api_key_id
     OR NEW.requesting_agent_run_id IS DISTINCT FROM OLD.requesting_agent_run_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.origin_principal_kind IS DISTINCT FROM OLD.origin_principal_kind
     OR NEW.origin_principal_id IS DISTINCT FROM OLD.origin_principal_id
     OR NEW.action_name IS DISTINCT FROM OLD.action_name
     OR NEW.action_version IS DISTINCT FROM OLD.action_version
     OR NEW.arguments IS DISTINCT FROM OLD.arguments
     OR NEW.argument_digest IS DISTINCT FROM OLD.argument_digest
     OR NEW.target_summary IS DISTINCT FROM OLD.target_summary
     OR NEW.impact_summary IS DISTINCT FROM OLD.impact_summary
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.approval_scope IS DISTINCT FROM OLD.approval_scope
     OR NEW.classification_version IS DISTINCT FROM OLD.classification_version
     OR NEW.effect_digest IS DISTINCT FROM OLD.effect_digest
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
     OR (NEW.scope_device_id IS DISTINCT FROM OLD.scope_device_id AND NEW.scope_device_id IS NOT NULL) THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
