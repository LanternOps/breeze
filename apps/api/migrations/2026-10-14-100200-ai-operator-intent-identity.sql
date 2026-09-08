-- AI Operator W04 (#5205, sub-issue #5209): operation identity on the intent.
--
-- W03 (2026-10-14-100000-ai-operator-thin-slice.sql) created the tables and
-- the three nullable `action_intents` task columns. This migration closes the
-- three gaps W04's code needs and W03's PR body named as deviations:
--
--  1. The `action_intents` immutability trigger's deny-list does NOT yet
--     mention `task_id` / `task_step_key` / `operation_key`, so today a plain
--     UPDATE could re-point a live intent at a DIFFERENT task or rewrite its
--     operation key. That is the whole identity the operation row is keyed
--     on, so it must be as immutable as `argument_digest` and
--     `idempotency_key` already are. All three are set at INSERT and never
--     written again: `action_intents_task_org_fk` is ON DELETE RESTRICT (see
--     the W03 header — SET NULL would strand `task_step_key`/`operation_key`
--     and instantly violate `action_intents_task_link_chk`), so unlike
--     `scope_device_id` / `scope_ticket_id` there is NO non-null -> NULL
--     tombstone transition to carve out. Strict immutability is therefore
--     correct here, not over-tight.
--
--  2. `ai_operator_operations` needs four columns W04 writes:
--       - `plan_revision`        the task revision the approval covers, pinned
--                                at reservation. The dispatch claim requires
--                                `ai_operator_tasks.revision = plan_revision`
--                                in the SAME conditional UPDATE, so a task
--                                whose plan was revised after approval cannot
--                                dispatch the stale operation (spec §7.1,
--                                "revising plan arguments creates a new
--                                operation and approval").
--       - `claimed_lease_epoch`  the scheduler epoch OBSERVED when the claim
--                                was won. Recorded, not fenced on, on the
--                                intent-release path: that path holds no lease,
--                                and spec §6.3 requires results from an
--                                operation a superseded epoch dispatched to be
--                                accepted under their ORIGINAL identity. This
--                                column is how W06 recognises one.
--       - `cancel_requested_at`  cancel-during-`executing` (spec §7.3). The
--                                intent stays `executing` and the effect is
--                                reconciled; this is the durable record that a
--                                human asked for it to stop.
--       - `dispatch_detail`      why a claim was refused (revalidation error
--                                code, tightened policy, lost claim). Bounded
--                                text, never a jsonb container: every jsonb
--                                column is `excludedOpen` in the tenant export
--                                policy, and a refusal reason must be
--                                exportable.
--
--  3. `dispatch_state` gains 'cancelled'. W03's four values
--     ('reserved','dispatched','dispatch_failed','abandoned') cannot express
--     "a human cancelled this before it ever dispatched". Folding that into
--     'abandoned' would make the reconciler's "terminal task with an unsettled
--     operation" scan unable to tell a deliberate cancel from a leaked
--     reservation. 'in_flight' is deliberately NOT added: it would be an exact
--     synonym of the existing 'dispatched', and two names for one state is how
--     a vocabulary rots.
--
-- DDL only. No UPDATE/DELETE/INSERT runs here, so no `breeze.scope` election
-- is required (and none is added — see migrationRlsScope.test.ts).
-- Idempotent throughout. No new RLS policy: `action_intents` and
-- `ai_operator_operations` are both Shape 1 with `breeze_has_org_access(org_id)`
-- policies already declared in their creating migrations, and adding columns
-- does not change a policy.

-- ---------------------------------------------------------------------------
-- 1. ai_operator_operations: the four W04 columns
-- ---------------------------------------------------------------------------

ALTER TABLE ai_operator_operations
  ADD COLUMN IF NOT EXISTS plan_revision integer;
ALTER TABLE ai_operator_operations
  ADD COLUMN IF NOT EXISTS claimed_lease_epoch bigint;
ALTER TABLE ai_operator_operations
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
ALTER TABLE ai_operator_operations
  ADD COLUMN IF NOT EXISTS dispatch_detail text;

-- Bounded like every other exportable text column on this table's siblings.
ALTER TABLE ai_operator_operations
  DROP CONSTRAINT IF EXISTS ai_operator_operations_dispatch_detail_len_chk;
ALTER TABLE ai_operator_operations
  ADD CONSTRAINT ai_operator_operations_dispatch_detail_len_chk
  CHECK (dispatch_detail IS NULL OR length(dispatch_detail) <= 500);

COMMENT ON COLUMN ai_operator_operations.plan_revision IS
  'ai_operator_tasks.revision pinned at reservation. The dispatch claim requires the task''s CURRENT revision to still equal this, in the same conditional UPDATE — a revised plan refuses the stale operation rather than dispatching it (spec §7.1).';
COMMENT ON COLUMN ai_operator_operations.claimed_lease_epoch IS
  'The ai_operator_tasks.lease_epoch OBSERVED when the dispatch claim was won. Recorded for lineage, not fenced on from the intent-release path (which holds no lease): spec §6.3 requires a result from an operation dispatched by a superseded epoch to be accepted under its ORIGINAL identity.';
COMMENT ON COLUMN ai_operator_operations.cancel_requested_at IS
  'Set when a human cancelled a task-linked intent that had already reached `executing`. The intent deliberately STAYS `executing` (spec §7.3: already-executing commands may finish, are shown in flight, and transition only after reconciliation) — this column is the durable "cancel asked for, reconciliation pending" record.';
COMMENT ON COLUMN ai_operator_operations.dispatch_detail IS
  'Why a dispatch claim was refused or a dispatch failed (revalidation error code, tightened policy, lost claim). Bounded text rather than jsonb because every jsonb column is excludedOpen in CORE_TENANT_EXPORT_POLICY and a refusal reason must stay exportable.';

-- ---------------------------------------------------------------------------
-- 2. dispatch_state gains 'cancelled'
-- ---------------------------------------------------------------------------

ALTER TABLE ai_operator_operations
  DROP CONSTRAINT IF EXISTS ai_operator_operations_dispatch_state_chk;
ALTER TABLE ai_operator_operations
  ADD CONSTRAINT ai_operator_operations_dispatch_state_chk CHECK (dispatch_state IN (
    'reserved', 'dispatched', 'dispatch_failed', 'cancelled', 'abandoned'
  ));

-- ---------------------------------------------------------------------------
-- 3. action_intents immutability: the three operation-identity columns
-- ---------------------------------------------------------------------------
-- Extend the ONE immutable-content function. Body copied verbatim from its
-- most recent definition (2026-09-25-ai-agents-ticket-triage.sql, which itself
-- copied 2026-09-23-ai-agents-scheduled-sweeps.sql) plus the three task
-- columns. Strict `IS DISTINCT FROM` for all three — no null-transition carve
-- out, see the header.

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
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.task_step_key IS DISTINCT FROM OLD.task_step_key
     OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
     OR (NEW.scope_device_id IS DISTINCT FROM OLD.scope_device_id AND NEW.scope_device_id IS NOT NULL)
     OR (NEW.scope_ticket_id IS DISTINCT FROM OLD.scope_ticket_id AND NEW.scope_ticket_id IS NOT NULL) THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
