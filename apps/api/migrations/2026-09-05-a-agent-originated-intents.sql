-- Agent-originated action intents (AI agents wave 3, #3824).
--
-- A headless agent proposal has NO human requester. Until now that was
-- impossible three times over: action_intents_one_actor_chk is a two-way XOR
-- that rejects both-NULL, `source` admits only chat/mcp_api, and
-- origin_principal_kind omits 'ai_agent'. This migration widens all three and
-- adds the durable link that replaces the requester: the ai_agent_runs row
-- whose immutable policy_snapshot authorized the proposal.
--
-- Why the RUN and not merely the agent: release reconstruction needs the
-- snapshot, the trigger provenance and the device/site context, all of which
-- live on the run (db/schema/aiAgents.ts). origin_principal_id is untyped text
-- with no FK and cannot carry that.
--
-- INERT ON MERGE: createActionIntent still rejects the ai_agent principal
-- (agent_origin_unsupported). PR 3b removes that guard.
--
-- CHECKs below are added without NOT VALID deliberately: action_intents is a
-- young, Tier-3-gated table with low row counts, matching the convention the
-- original 2026-07-18-action-intents.sql established. On a large/hot table,
-- prefer NOT VALID + a follow-up VALIDATE CONSTRAINT to avoid a long-held lock.

ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS requesting_agent_run_id UUID;

CREATE INDEX IF NOT EXISTS action_intents_requesting_agent_run_id_idx
  ON action_intents (requesting_agent_run_id)
  WHERE requesting_agent_run_id IS NOT NULL;

-- Drop the FKs that depend on ai_agent_runs_id_org_id_key BEFORE touching
-- that constraint below — re-running DROP CONSTRAINT on a UNIQUE constraint
-- while a composite FK still references its backing index fails with
-- "other objects depend on it", so the dependent must go first on every run,
-- not only the first one.
ALTER TABLE action_intents
  DROP CONSTRAINT IF EXISTS action_intents_requesting_agent_run_id_fkey;
ALTER TABLE action_intents
  DROP CONSTRAINT IF EXISTS action_intents_requesting_agent_run_id_org_id_fkey;

-- Composite-FK target: unique on (id, org_id) so action_intents can reference
-- it. `id` is already PK (unique by itself) so this adds no new tenancy
-- invariant — it just declares the tuple the composite FK can reference.
-- Mirrors elevation_requests_id_org_id_key (2026-05-26-a-elevation-requests.sql).
ALTER TABLE ai_agent_runs
  DROP CONSTRAINT IF EXISTS ai_agent_runs_id_org_id_key;
ALTER TABLE ai_agent_runs
  ADD CONSTRAINT ai_agent_runs_id_org_id_key UNIQUE (id, org_id);

-- Composite FK: (action_intents.requesting_agent_run_id, action_intents.org_id)
-- → ai_agent_runs(id, org_id). Both tables carry org_id, but a single-column
-- FK on requesting_agent_run_id alone would not force them to match — an
-- intent in org A could be attributed to a run in org B, and
-- ai_agent_runs_immutable_guard() does not protect org_id, so an
-- application-level same-org check at creation would not permanently
-- establish the invariant either. This is a structural guarantee that an
-- agent proposal can never be filed under the wrong tenant even if
-- application code is buggy. Mirrors the elevation_audit composite-FK
-- pattern (2026-05-26-a-elevation-requests.sql).
ALTER TABLE action_intents
  ADD CONSTRAINT action_intents_requesting_agent_run_id_org_id_fkey
  FOREIGN KEY (requesting_agent_run_id, org_id)
  REFERENCES ai_agent_runs(id, org_id)
  ON DELETE RESTRICT;

-- Exactly ONE actor root. Was a two-way XOR over (user, api_key); now a
-- three-way count so an agent intent (both human columns NULL, run set) is
-- legal and a two-actor row still is not.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_one_actor_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_one_actor_chk
  CHECK (num_nonnulls(requested_by_user_id, requesting_api_key_id, requesting_agent_run_id) = 1);

-- The two halves of an agent intent must agree. Without this, a row could carry
-- a run id while claiming a human origin (or vice versa), and every downstream
-- branch that switches on origin_principal_kind would disagree with the FK.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_agent_origin_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_agent_origin_chk
  CHECK (
    (origin_principal_kind = 'ai_agent') = (requesting_agent_run_id IS NOT NULL)
  );

-- The original CHECK was inline and unnamed (2026-07-18-action-intents.sql:41),
-- so Postgres generated action_intents_source_check on the action_intents
-- relation specifically — DROP CONSTRAINT IF EXISTS is already relation-scoped
-- and idempotent, so no pg_constraint existence probe is needed here.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_source_check;
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_source_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_source_chk
  CHECK (source IN ('chat', 'mcp_api', 'ai_agent'));

ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_origin_principal_kind_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_origin_principal_kind_chk
  CHECK (origin_principal_kind IN (
    'user_session', 'client_user', 'api_key', 'oauth_grant',
    'agent', 'ai_agent', 'helper', 'system', 'unknown'
  ));

-- source and origin_principal_kind must move together. source drives
-- notification and expiry behaviour; origin_principal_kind drives
-- authorization — a row where they disagree would take one path while
-- claiming the other. Both columns are NOT NULL, so there is no
-- three-valued-logic hole in this equivalence.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_agent_source_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_agent_source_chk
  CHECK ((source = 'ai_agent') = (origin_principal_kind = 'ai_agent'));

-- The originating run is part of the intent's immutable content, for exactly
-- the reason the origin fields are: an intent whose attributed run could be
-- swapped after approval would defeat release revalidation. Extend the ONE
-- function that defines "immutable content" rather than adding a second trigger.
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
     OR NEW.effect_digest IS DISTINCT FROM OLD.effect_digest THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
