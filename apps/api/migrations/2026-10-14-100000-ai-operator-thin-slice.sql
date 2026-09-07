-- 2026-10-14: AI Operator P3-1a thin-slice schema (#5205 W03, sub-issue #5208).
--
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-completion-design.md
--       §6.1 (state contract), §6.5 (operation identity), §11 (data model and
--       tenancy contract), §11.1 (indexes), §11.3 (reference lifecycle matrix).
-- Baseline contracts: .../2026-09-07-ai-operator-p3-0-baseline-contracts.md
--       §5 (identity predicate, hazards H1-H5), §8.4 (export classification),
--       §9 (move/merge semantics).
--
-- Three new Shape-1 (direct, NOT NULL, immutable `org_id`) tenant tables plus
-- additive nullable columns on `action_intents` and `ai_agent_runs`. DDL only:
-- this file writes no rows, so it elects no `breeze.scope` (any future DML in
-- an Operator migration must `SELECT set_config('breeze.scope','system',true)`
-- FIRST — see apps/api/src/db/migrationRlsScope.test.ts).
--
-- Deliberate design points, each traceable to a contract:
--
--  1. Every state/phase/outcome column is `text` + CHECK, never `pgEnum`.
--     Under forced RLS only leakproof operators become index conditions;
--     enum equality is not leakproof, so an enum state column would turn the
--     coordinator poll into a post-policy filter over the whole table
--     (spec §11.1, and the 2026-09-03 US device-feed incident).
--
--  2. Partial-index predicates are written as literal constants, never
--     parameters, so the planner's predicate proof can see them (§11.1).
--
--  3. `ai_operator_tasks.agent_id` is a PLAIN FK to `ai_agents(id)` with
--     ON DELETE RESTRICT, NOT a composite `(agent_id, org_id)` FK. Org merge
--     repoints every loser-org `ai_agents` row to the survivor
--     (orgMergeCustomExecutors.ts mergeAiAgents), while task `org_id` is
--     immutable history — a composite FK would make the merge impossible.
--     Same-org is checked in application code at admission (spec §11.3).
--
--  4. Every OTHER composite FK that references an `org_id` column is
--     DEFERRABLE INITIALLY IMMEDIATE: org merge runs `SET CONSTRAINTS ALL
--     DEFERRED` and re-points parent and child `org_id` in separate
--     statements, and a non-deferrable one aborts the merge with 23503
--     (enforced by orgLifecycleFoundations.integration.test.ts).
--
--  5. Detach semantics never clear `org_id`. Composite FKs that release a
--     reference use the column-scoped form `ON DELETE SET NULL (<column>)`
--     (Postgres 15+; precedent 2026-10-01-100000-ai-agents-graduation-
--     evidence.sql:86) so the row keeps its tenant while losing the pointer.
--     A column-scoped SET NULL may name only columns of the FK, so it is NOT
--     usable where the released pointer is one column of an all-or-none CHECK
--     group: nulling `task_id` alone would leave its siblings set and raise
--     23514 (deferring the FK does not defer the CHECK). Those two edges —
--     `action_intents.task_id` and `ai_agent_runs.task_id` — are ON DELETE
--     RESTRICT instead, matching ticket_drafts_run_org_fk /
--     ticket_drafts_intent_org_fk, which take RESTRICT for the same reason:
--     the parent is history and is never hard-deleted out from under a child.
--
--  5b. `breeze_device_child_orgid_tables()` is DYNAMIC — it returns every
--     table carrying both `device_id` and `org_id` minus an exclusion list —
--     so creating `ai_operator_tasks` silently enrolls it in the device-move
--     re-stamp loop unless it is excluded. Section 7 excludes it.
--
--  6. `ai_operator_task_outbox` is DELIBERATELY RLS-SCOPED. `intent_outbox` is
--     `INTENTIONAL_UNSCOPED` (rls-coverage.integration.test.ts) because the
--     agent WS path drains it, but the task coordinator must respect tenancy.
--     This is the repository's first RLS-scoped outbox and it MUST NEVER be
--     added to that allowlist (baseline contradiction C20).
--
--  7. NO second unique arbiter on `action_intents (org_id, task_id,
--     operation_key)`. `createActionIntent`'s `ON CONFLICT` names
--     `(org_id, idempotency_key)`, and Postgres suppresses conflicts on the
--     named inference target only — a second partial unique would raise a bare
--     23505 instead of an idempotent replay (baseline H1/C6). W04 derives the
--     task-linked `idempotency_key` from task identity so the existing
--     `action_intents_org_idem_uniq` stays the single arbiter. The index added
--     here is deliberately NON-UNIQUE: a lookup aid, never an arbiter.
--     Sequential replay of a confirmed effect is guarded instead by
--     `ai_operator_operations_org_task_op_uq`, which carries NO status
--     predicate (baseline H2/C7).
--
-- Idempotent throughout: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, DROP CONSTRAINT IF EXISTS before each ADD CONSTRAINT, DROP POLICY IF
-- EXISTS before each CREATE POLICY. autoMigrate wraps this file in one
-- transaction — no inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- 1. ai_operator_tasks
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_operator_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),

  -- Identity. Plain FK by design (see header note 3); the frozen snapshot
  -- below is what task evidence renders, so a repointed or renamed agent
  -- cannot rewrite history.
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE RESTRICT,
  agent_kind text NOT NULL
    CONSTRAINT ai_operator_tasks_agent_kind_len_chk CHECK (length(agent_kind) <= 64),
  agent_name text NOT NULL
    CONSTRAINT ai_operator_tasks_agent_name_len_chk CHECK (length(agent_name) <= 255),

  workflow_key text NOT NULL
    CONSTRAINT ai_operator_tasks_workflow_key_len_chk CHECK (length(workflow_key) <= 128),
  workflow_version integer NOT NULL DEFAULT 1,

  -- 'trial' is reserved for P3-4; the thin slice admits 'live' only, but the
  -- CHECK admits both so the trial wave needs no constraint churn.
  mode text NOT NULL DEFAULT 'live'
    CONSTRAINT ai_operator_tasks_mode_chk CHECK (mode IN ('live', 'trial')),

  origin_kind text NOT NULL
    CONSTRAINT ai_operator_tasks_origin_kind_chk
    CHECK (origin_kind IN ('manual', 'alert', 'ticket', 'schedule', 'anomaly', 'sweep', 'chat')),
  requester_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  -- Bounded exportable text. Spec §11: anything a customer must be able to
  -- export lives in a bounded `text` column classified `included`, never only
  -- inside a jsonb container (every json/jsonb column is `excludedOpen`).
  objective text NOT NULL
    CONSTRAINT ai_operator_tasks_objective_len_chk CHECK (length(objective) <= 4000),

  -- Single inline target for the thin slice. P3-2 introduces
  -- `ai_operator_task_targets`; the forward migration copies these columns.
  -- ON DELETE SET NULL and no composite FK: task history stays in its source
  -- org with the device pointer released and the frozen label retained
  -- (spec §11.3). A device MOVE detaches through routes/devices/moveOrg.ts —
  -- `ai_operator_tasks` is in neither device list, because it is neither
  -- delete-cascaded nor org-restamped.
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  target_label text
    CONSTRAINT ai_operator_tasks_target_label_len_chk CHECK (target_label IS NULL OR length(target_label) <= 255),
  target_detached_at timestamptz,
  target_detached_reason text
    CONSTRAINT ai_operator_tasks_target_detached_reason_chk
    CHECK (target_detached_reason IS NULL OR target_detached_reason IN (
      'device_moved', 'device_deleted', 'org_merged', 'scope_invalidated'
    )),
  CONSTRAINT ai_operator_tasks_target_detach_chk CHECK (
    (target_detached_at IS NULL AND target_detached_reason IS NULL)
    OR (target_detached_at IS NOT NULL AND target_detached_reason IS NOT NULL)
  ),

  -- Lifecycle. States are exactly spec §6.1's set.
  state text NOT NULL DEFAULT 'queued'
    CONSTRAINT ai_operator_tasks_state_chk CHECK (state IN (
      'queued', 'running', 'waiting', 'paused', 'stopping',
      'completed', 'partial', 'handed_off', 'cancelled', 'failed', 'expired'
    )),
  phase text
    CONSTRAINT ai_operator_tasks_phase_chk
    CHECK (phase IS NULL OR phase IN ('investigate', 'plan', 'execute', 'verify', 'document')),
  wait_reason text
    CONSTRAINT ai_operator_tasks_wait_reason_chk
    CHECK (wait_reason IS NULL OR wait_reason IN (
      'approval', 'information', 'execution', 'device', 'maintenance_window', 'verification_window'
    )),
  wait_dependency_kind text
    CONSTRAINT ai_operator_tasks_wait_dependency_kind_chk
    CHECK (wait_dependency_kind IS NULL OR wait_dependency_kind IN (
      'intent', 'operation', 'run', 'device_command', 'user_answer', 'verification'
    )),
  wait_dependency_id uuid,
  CONSTRAINT ai_operator_tasks_wait_dependency_chk CHECK (
    (wait_dependency_kind IS NULL AND wait_dependency_id IS NULL)
    OR (wait_dependency_kind IS NOT NULL AND wait_dependency_id IS NOT NULL)
  ),

  -- Monotonic counters. `revision` is the approved-plan revision, `lease_epoch`
  -- the scheduler fencing token, `attempt_ordinal` the reasoning attempt —
  -- three separate clocks that must never be conflated (spec §6.2).
  revision integer NOT NULL DEFAULT 1,
  lease_epoch bigint NOT NULL DEFAULT 0,
  lease_owner text
    CONSTRAINT ai_operator_tasks_lease_owner_len_chk CHECK (lease_owner IS NULL OR length(lease_owner) <= 128),
  lease_expires_at timestamptz,
  attempt_ordinal integer NOT NULL DEFAULT 0,

  current_step_key text
    CONSTRAINT ai_operator_tasks_current_step_key_len_chk
    CHECK (current_step_key IS NULL OR length(current_step_key) <= 128),
  -- Bounded checkpoint. jsonb, therefore `excludedOpen` in the export policy
  -- WITHOUT exception; every field a customer must be able to export has its
  -- own bounded text column above/below.
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT ai_operator_tasks_checkpoint_size_chk CHECK (pg_column_size(checkpoint) <= 65536),

  deadline_at timestamptz,
  next_wake_at timestamptz,

  outcome text
    CONSTRAINT ai_operator_tasks_outcome_chk CHECK (outcome IS NULL OR outcome IN (
      'verified_resolved', 'investigation_complete', 'report_delivered',
      'no_action_needed', 'trial_complete', 'unresolved', 'unknown_effect'
    )),
  outcome_detail text
    CONSTRAINT ai_operator_tasks_outcome_detail_len_chk
    CHECK (outcome_detail IS NULL OR length(outcome_detail) <= 4000),
  handoff_summary text
    CONSTRAINT ai_operator_tasks_handoff_summary_len_chk
    CHECK (handoff_summary IS NULL OR length(handoff_summary) <= 4000),

  -- Lineage. Self-referential composite FKs added after the table exists.
  accounting_root_task_id uuid,
  successor_of_task_id uuid,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Composite parent key: the tuple every task-qualified child FK references.
-- `id` is already PK, so this adds no new tenancy invariant on its own — it
-- exists to give `(x, org_id)` FKs a target (precedent:
-- ai_agent_runs_id_org_uq, action_intents_id_org_uq).
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_tasks_id_org_uq ON ai_operator_tasks (id, org_id);

-- Self-lineage, task-qualified and same-org. ON DELETE SET NULL (<column>) so
-- releasing a pointer never touches `org_id` (header note 5). These edges are
-- self-referential, so tenantCascade's FK-direction contract (which skips
-- `tc.relname = tp.relname`) is unaffected.
ALTER TABLE ai_operator_tasks DROP CONSTRAINT IF EXISTS ai_operator_tasks_root_org_fk;
ALTER TABLE ai_operator_tasks ADD CONSTRAINT ai_operator_tasks_root_org_fk
  FOREIGN KEY (accounting_root_task_id, org_id) REFERENCES ai_operator_tasks (id, org_id)
  ON DELETE SET NULL (accounting_root_task_id)
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE ai_operator_tasks DROP CONSTRAINT IF EXISTS ai_operator_tasks_successor_org_fk;
ALTER TABLE ai_operator_tasks ADD CONSTRAINT ai_operator_tasks_successor_org_fk
  FOREIGN KEY (successor_of_task_id, org_id) REFERENCES ai_operator_tasks (id, org_id)
  ON DELETE SET NULL (successor_of_task_id)
  DEFERRABLE INITIALLY IMMEDIATE;

-- A root task points at no other root (spec §11: "root has no root pointer").
ALTER TABLE ai_operator_tasks DROP CONSTRAINT IF EXISTS ai_operator_tasks_root_self_chk;
ALTER TABLE ai_operator_tasks ADD CONSTRAINT ai_operator_tasks_root_self_chk
  CHECK (accounting_root_task_id IS NULL OR accounting_root_task_id <> id);

ALTER TABLE ai_operator_tasks DROP CONSTRAINT IF EXISTS ai_operator_tasks_successor_self_chk;
ALTER TABLE ai_operator_tasks ADD CONSTRAINT ai_operator_tasks_successor_self_chk
  CHECK (successor_of_task_id IS NULL OR successor_of_task_id <> id);

-- Indexes, spec §11.1. Predicate literals are spelled out (header note 2).
CREATE INDEX IF NOT EXISTS ai_operator_tasks_wake_idx
  ON ai_operator_tasks (next_wake_at) WHERE state = 'waiting';
CREATE INDEX IF NOT EXISTS ai_operator_tasks_org_state_updated_idx
  ON ai_operator_tasks (org_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS ai_operator_tasks_org_root_idx
  ON ai_operator_tasks (org_id, accounting_root_task_id);
CREATE INDEX IF NOT EXISTS ai_operator_tasks_lease_idx
  ON ai_operator_tasks (lease_expires_at) WHERE state IN ('running', 'stopping');
CREATE INDEX IF NOT EXISTS ai_operator_tasks_device_idx
  ON ai_operator_tasks (device_id) WHERE device_id IS NOT NULL;

ALTER TABLE ai_operator_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_tasks FORCE ROW LEVEL SECURITY;

-- Shape 1: direct NOT NULL org_id. The canonical idiom is the plain
-- breeze_has_org_access(org_id) check with NO separate system branch —
-- breeze_has_org_access() already returns TRUE for system scope internally
-- (0001-baseline.sql). Same as action_intents / ticket_drafts.
DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_operator_tasks;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_operator_tasks;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_operator_tasks;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_operator_tasks;

CREATE POLICY breeze_org_isolation_select ON ai_operator_tasks
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_operator_tasks
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_operator_tasks
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_operator_tasks
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_operator_tasks TO breeze_app;

-- ---------------------------------------------------------------------------
-- 2. ai_operator_operations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_operator_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL,
  task_step_key text NOT NULL
    CONSTRAINT ai_operator_operations_step_key_len_chk CHECK (length(task_step_key) <= 128),
  operation_key text NOT NULL
    CONSTRAINT ai_operator_operations_op_key_len_chk CHECK (length(operation_key) <= 200),
  attempt_ordinal integer NOT NULL DEFAULT 0,

  intent_id uuid,
  originating_run_id uuid,

  argument_digest char(64) NOT NULL,

  -- Typed execution reference with NO hard FK (spec §11.3): the referenced row
  -- may be erased first, and `device_commands` has no RLS at all, so every
  -- read goes through an authorized adapter route
  -- (GET /devices/:id/commands/:commandId), never a direct select.
  execution_ref_kind text
    CONSTRAINT ai_operator_operations_exec_kind_chk
    CHECK (execution_ref_kind IS NULL OR execution_ref_kind IN (
      'device_command', 'script_execution', 'patch_job_target',
      'playbook_execution', 'ticket_comment', 'report_delivery'
    )),
  execution_ref_id uuid,
  CONSTRAINT ai_operator_operations_exec_ref_chk CHECK (
    (execution_ref_kind IS NULL AND execution_ref_id IS NULL)
    OR (execution_ref_kind IS NOT NULL AND execution_ref_id IS NOT NULL)
  ),

  dispatch_state text NOT NULL DEFAULT 'reserved'
    CONSTRAINT ai_operator_operations_dispatch_state_chk CHECK (dispatch_state IN (
      'reserved', 'dispatched', 'dispatch_failed', 'abandoned'
    )),
  -- 'unknown' is a first-class result, not an error: between the tool's 30 s
  -- wait and the device command's 5-minute reap the effect may still land
  -- (spec §6.5, "three clocks").
  result_state text NOT NULL DEFAULT 'pending'
    CONSTRAINT ai_operator_operations_result_state_chk CHECK (result_state IN (
      'pending', 'succeeded', 'failed', 'unknown', 'superseded'
    )),
  result jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT ai_operator_operations_result_size_chk CHECK (pg_column_size(result) <= 65536),

  dispatched_at timestamptz,
  result_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- THE sequential-replay guard (baseline C7/H2). Permanent, NO status
-- predicate: `action_intents_org_idem_uniq` covers live statuses only, and a
-- `completed` intent frees its key while the device may still be executing.
-- This is the constraint that makes a confirmed effect un-replayable.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_operations_org_task_op_uq
  ON ai_operator_operations (org_id, task_id, operation_key);

ALTER TABLE ai_operator_operations DROP CONSTRAINT IF EXISTS ai_operator_operations_task_org_fk;
ALTER TABLE ai_operator_operations ADD CONSTRAINT ai_operator_operations_task_org_fk
  FOREIGN KEY (task_id, org_id) REFERENCES ai_operator_tasks (id, org_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

-- ON DELETE SET NULL (<column>) keeps `org_id` intact when the intent or run
-- is erased ahead of the operation. Both parents sort before
-- `ai_operator_operations` alphabetically in CORE_ORG_CASCADE_DELETE_ORDER, so
-- a RESTRICT here would abort org erasure; the topological sorter cannot fix
-- that, because these are genuine parent-first edges made harmless by SET NULL.
ALTER TABLE ai_operator_operations DROP CONSTRAINT IF EXISTS ai_operator_operations_intent_org_fk;
ALTER TABLE ai_operator_operations ADD CONSTRAINT ai_operator_operations_intent_org_fk
  FOREIGN KEY (intent_id, org_id) REFERENCES action_intents (id, org_id)
  ON DELETE SET NULL (intent_id)
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE ai_operator_operations DROP CONSTRAINT IF EXISTS ai_operator_operations_run_org_fk;
ALTER TABLE ai_operator_operations ADD CONSTRAINT ai_operator_operations_run_org_fk
  FOREIGN KEY (originating_run_id, org_id) REFERENCES ai_agent_runs (id, org_id)
  ON DELETE SET NULL (originating_run_id)
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS ai_operator_operations_org_task_result_idx
  ON ai_operator_operations (org_id, task_id, result_state);
CREATE INDEX IF NOT EXISTS ai_operator_operations_intent_idx
  ON ai_operator_operations (intent_id) WHERE intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_operator_operations_exec_ref_idx
  ON ai_operator_operations (execution_ref_kind, execution_ref_id);

ALTER TABLE ai_operator_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_operations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_operator_operations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_operator_operations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_operator_operations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_operator_operations;

CREATE POLICY breeze_org_isolation_select ON ai_operator_operations
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_operator_operations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_operator_operations
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_operator_operations
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_operator_operations TO breeze_app;

-- ---------------------------------------------------------------------------
-- 3. ai_operator_task_outbox
-- ---------------------------------------------------------------------------
--
-- DELIBERATELY RLS-SCOPED (header note 6, baseline C20). Do NOT add this table
-- to `INTENTIONAL_UNSCOPED` in rls-coverage.integration.test.ts, and do NOT
-- copy `intent_outbox`'s unscoped shape here: the task coordinator runs under
-- tenant context, unlike the agent WS path that drains `intent_outbox`.
-- Unlike `intent_outbox` (whose ON DELETE CASCADE to `action_intents` means it
-- needs no cascade entry of its own), this table carries `org_id` and IS
-- therefore registered in CORE_ORG_CASCADE_DELETE_ORDER.

CREATE TABLE IF NOT EXISTS ai_operator_task_outbox (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL,
  source_kind text NOT NULL
    CONSTRAINT ai_operator_task_outbox_source_kind_chk CHECK (source_kind IN (
      'run', 'intent', 'execution', 'verification', 'user_answer', 'target', 'cancellation'
    )),
  -- A typed reference, never an embedded payload (spec §6.3). `text` rather
  -- than `uuid` because not every source id is a uuid (device command ids are,
  -- but a maintenance-window or answer key need not be).
  source_id text NOT NULL
    CONSTRAINT ai_operator_task_outbox_source_id_len_chk CHECK (length(source_id) <= 200),
  transition_seq bigint NOT NULL,
  due_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Wake dedupe identity: org, task, source kind, source id, transition
-- (spec §6.3). Duplicate delivery converges on one row.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_task_outbox_identity_uq
  ON ai_operator_task_outbox (org_id, task_id, source_kind, source_id, transition_seq);

ALTER TABLE ai_operator_task_outbox DROP CONSTRAINT IF EXISTS ai_operator_task_outbox_task_org_fk;
ALTER TABLE ai_operator_task_outbox ADD CONSTRAINT ai_operator_task_outbox_task_org_fk
  FOREIGN KEY (task_id, org_id) REFERENCES ai_operator_tasks (id, org_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

-- Publisher poll. Precedent: intent_outbox_unpublished_idx and ticket_outbox
-- (2026-09-19-ai-agents-ticket-shadow.sql:96).
CREATE INDEX IF NOT EXISTS ai_operator_task_outbox_unpublished_idx
  ON ai_operator_task_outbox (due_at, id) WHERE published_at IS NULL;

ALTER TABLE ai_operator_task_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_task_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_operator_task_outbox;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_operator_task_outbox;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_operator_task_outbox;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_operator_task_outbox;

CREATE POLICY breeze_org_isolation_select ON ai_operator_task_outbox
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_operator_task_outbox
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_operator_task_outbox
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_operator_task_outbox
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_operator_task_outbox TO breeze_app;
GRANT USAGE, SELECT ON SEQUENCE ai_operator_task_outbox_id_seq TO breeze_app;

-- ---------------------------------------------------------------------------
-- 4. action_intents: operation identity columns
-- ---------------------------------------------------------------------------
--
-- No new RLS policy is needed: action_intents is already Shape 1 with
-- breeze_has_org_access(org_id) (2026-07-18-action-intents.sql). But the table
-- IS in CORE_TENANT_EXPORT_POLICY, so all three columns are classified in the
-- same PR — the column-not-table trap (baseline H5).
--
-- These three columns are the reservation of operation identity ON the intent
-- (spec §6.5). W04 makes the creation path populate them and derives the
-- idempotency key from task identity; this wave only lays the shape.

ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS task_id uuid;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS task_step_key text;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS operation_key text;

-- All-or-none (baseline §5.2, verbatim). Legacy rows have all three NULL and
-- are unaffected. Note this enforces all-or-none, NOT all-or-task: the real
-- guarantee that a task-linked admission never yields a null `operation_key`
-- comes from the single task-aware creation path in W04, pinned by its own
-- contract test (hazard H4).
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_task_link_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_task_link_chk CHECK (
  (task_id IS NULL AND task_step_key IS NULL AND operation_key IS NULL)
  OR (task_id IS NOT NULL AND task_step_key IS NOT NULL AND operation_key IS NOT NULL)
);

-- ON DELETE RESTRICT, NOT SET NULL. `ON DELETE SET NULL (task_id)` would clear
-- only `task_id` (a column-scoped SET NULL may name only columns of the FK),
-- leaving `task_step_key` and `operation_key` populated and instantly violating
-- `action_intents_task_link_chk` above with a 23514 — deferring the FK does not
-- defer the CHECK, so the DELETE aborts. RESTRICT states the real invariant
-- instead: an Operator task is never hard-deleted while an intent still names
-- it. Org erasure already deletes `action_intents` before `ai_operator_tasks`
-- (topologicalCascadeOrder reads this very edge), so erasure is unaffected.
-- Same reasoning and same ON DELETE as ticket_drafts_intent_org_fk.
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_task_org_fk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_task_org_fk
  FOREIGN KEY (task_id, org_id) REFERENCES ai_operator_tasks (id, org_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY IMMEDIATE;

-- NON-UNIQUE on purpose (header note 7 / baseline H1, C6). A partial UNIQUE on
-- (org_id, task_id, operation_key) would be a SECOND ON CONFLICT arbiter and
-- would turn an idempotent replay into a bare 23505. Do not "upgrade" this
-- index to unique in a later wave without moving the ON CONFLICT target too.
CREATE INDEX IF NOT EXISTS action_intents_task_operation_idx
  ON action_intents (org_id, task_id, operation_key) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. ai_agent_runs: task-linkage and prompt/model provenance
-- ---------------------------------------------------------------------------
--
-- `task_step_key` (text) rather than the spec's `task_step_id`: the thin slice
-- has no `ai_operator_task_steps` table, so there is no uuid to reference and
-- an unbacked uuid column would be a string "resource id" pretending to be a
-- key. P3-2 adds the steps table and migrates this column to a real FK.

ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS task_id uuid;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS task_step_key text;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS task_attempt_ordinal integer;
-- Spec §6.2: no prompt registry exists yet, so runs 1 and 4 of one task may use
-- different released prompts; that drift is accepted but must be RECORDED.
-- `resolved_model` because runLoop.ts may fall back to the org's LLM default
-- rather than the policy snapshot's configured model.
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS prompt_version text;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS resolved_model text;

ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_task_link_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_task_link_chk CHECK (
  (task_id IS NULL AND task_step_key IS NULL AND task_attempt_ordinal IS NULL)
  OR (task_id IS NOT NULL AND task_step_key IS NOT NULL AND task_attempt_ordinal IS NOT NULL)
);

-- ON DELETE RESTRICT for the same reason as action_intents_task_org_fk above:
-- a column-scoped SET NULL could clear only `task_id`, leaving `task_step_key`
-- and `task_attempt_ordinal` set and violating `ai_agent_runs_task_link_chk`
-- with a 23514. Mirrors ticket_drafts_run_org_fk.
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_task_org_fk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_task_org_fk
  FOREIGN KEY (task_id, org_id) REFERENCES ai_operator_tasks (id, org_id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY IMMEDIATE;

-- Admission identity (spec §6.2): one active reasoning run per task step and
-- attempt. Retries and lease recovery reuse the same tuple.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_runs_task_admission_uq
  ON ai_agent_runs (task_id, task_step_key, task_attempt_ordinal) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. Comments (the durable half of the rationale above)
-- ---------------------------------------------------------------------------

COMMENT ON TABLE ai_operator_tasks IS
  'AI Operator durable task (spec 2026-09-07 §6.1/§11). Shape 1; org_id immutable — task history stays in its source org through device move and org merge. agent_id is a PLAIN FK because org merge repoints ai_agents; same-org is checked at admission.';
COMMENT ON TABLE ai_operator_operations IS
  'One reserved AI Operator operation. The (org_id, task_id, operation_key) unique carries NO status predicate and is the SEQUENTIAL-replay guard; action_intents_org_idem_uniq (live statuses only) guards CONCURRENT duplication.';
COMMENT ON TABLE ai_operator_task_outbox IS
  'Transactional wake outbox for the task coordinator. DELIBERATELY RLS-scoped — unlike intent_outbox, which is INTENTIONAL_UNSCOPED for the agent WS path. Never add this table to that allowlist (baseline C20).';
COMMENT ON COLUMN ai_operator_tasks.device_id IS
  'Inline thin-slice target. Detached (set NULL + target_detached_at/reason) on device move; never restamped, never cascade-deleted.';
COMMENT ON COLUMN action_intents.operation_key IS
  'AI Operator operation identity. W04 derives the intent idempotency_key from (task_id, tool, argument digest, operation_key) so action_intents_org_idem_uniq stays the SINGLE ON CONFLICT arbiter — do not add a unique index on (org_id, task_id, operation_key).';

-- ---------------------------------------------------------------------------
-- 7. breeze_device_child_orgid_tables(): exclude ai_operator_tasks
-- ---------------------------------------------------------------------------
--
-- This helper is DYNAMIC, not a hand-written list: it returns every public
-- table carrying BOTH a uuid `device_id` and a uuid `org_id`, minus an explicit
-- exclusion list. `ai_operator_tasks` has both columns, so creating it above
-- silently enrolled it in the device-move re-stamp loop that
-- breeze_cascade_device_org_id() drives — a loop that would set the task's
-- immutable `org_id` to the destination org and, the moment the task has an
-- operation, a linked run or a linked intent, abort the whole move on a
-- composite (x, org_id) FK.
--
-- The detach statement added in section 8 happens to run BEFORE that loop and
-- leaves `device_id` NULL, so the loop's UPDATE would match no rows today. That
-- is an accident of statement order, not a contract, and it is exactly the kind
-- of silent, reorder-fragile coupling the exclusion list exists to make
-- explicit. Excluded here for the same reason `ai_agent_runs` and
-- `invoice_line_devices` are.
--
-- Body copied VERBATIM from the newest definition,
-- 2026-10-11-170100-offline-transition-effects.sql, with `ai_operator_tasks`
-- added to the NOT IN list and its rationale added to the comment block.
CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  AS $$
  SELECT t.relname::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relkind = 'r'
    AND t.relname <> 'devices'
    -- ai_agent_runs: agent-run history stays with the SOURCE org on a device
    -- move (owner decision 2026-08-23); its org_id is trigger-immutable.
    -- PAM lifecycle and result evidence is likewise source-frozen, but unlike
    -- agent runs its existence blocks the device move entirely.
    -- invoice_line_devices: billing evidence stays in its INVOICE's org on a
    -- device move. The invoice and its lines do not move, so restamping the
    -- evidence row's org_id here trips invoice_line_devices_line_org_fk /
    -- invoice_line_devices_invoice_org_fk (DEFERRABLE INITIALLY IMMEDIATE) at
    -- the end of the trigger's own statement. moveOrg.ts detaches device_id
    -- instead, and that statement is LOAD-BEARING, not a mirror of this loop
    -- (#3205 W07).
    -- ai_operator_tasks: AI Operator task history stays with the SOURCE org
    -- (#5205 W03, #5208). org_id is immutable and anchors three composite
    -- (x, org_id) FKs, so a re-stamp aborts the move as soon as the task has
    -- an operation, a linked run or a linked intent. moveOrg.ts and this
    -- trigger both detach device_id and fence the task instead.
    AND t.relname NOT IN (
      'ai_agent_runs',
      'ai_operator_tasks',
      'pam_actuations',
      'pam_actuation_results',
      'invoice_line_devices',
      'offline_transition_effects'
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'device_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'org_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    );
$$;

-- ---------------------------------------------------------------------------
-- 8. breeze_cascade_device_org_id(): sever AI Operator task lineage too
-- ---------------------------------------------------------------------------
--
-- routes/devices/moveOrg.ts carries an explicit detach statement for
-- `ai_operator_tasks`, but the route is not the only way `devices.org_id`
-- changes: a direct UPDATE (a fix-up script, a future service path) fires this
-- AFTER trigger and nothing else. `agentRunMoveSemantics.integration.test.ts`
-- pins exactly that hole for `ai_agent_runs`; the same hole would strand a task
-- pointing at a device in another tenant.
--
-- Body copied VERBATIM from the newest definition,
-- 2026-10-09-000200-device-group-memberships-composite-tenant-fks.sql (no later
-- migration replaces this function — verified by grepping every file in
-- apps/api/migrations), with exactly ONE statement added: the
-- `UPDATE public.ai_operator_tasks` below. CREATE OR REPLACE is idempotent by
-- construction. The trigger itself (breeze_cascade_device_org_id ON devices,
-- AFTER UPDATE OF org_id) is unchanged and is NOT redeclared here.
--
-- COALESCE on the detach columns and the CASE on `state` make this convergent
-- with moveOrg.ts's statement: whichever runs first wins, the other is a no-op,
-- and a task that had already been detached for another reason keeps its
-- original reason.
CREATE OR REPLACE FUNCTION public.breeze_cascade_device_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
  AS $$
DECLARE
  child_table text;
BEGIN
  -- #3182 -- a device that has LEFT org A cannot remain a member of org A's
  -- device group, and device_group_memberships_group_org_fk ((group_id,
  -- org_id) -> device_groups(id, org_id)) now says so structurally. Delete,
  -- never re-point: device_groups.org_id is NOT NULL with no partner axis,
  -- groups nest and can be site-bound, and there is no deterministic
  -- source-group -> target-group mapping. Dynamic groups in the TARGET org
  -- re-materialize on their own next evaluation.
  --
  -- It has to precede the generic loop below, which would otherwise re-stamp
  -- these rows' org_id to NEW.org_id while their group_id still names a
  -- SOURCE-org group -- 23503 against the group FK, aborting the whole move.
  -- Same class as the action_intents tombstones, but placed FIRST rather than
  -- beside them, for a reason specific to this table: deleting a membership
  -- fires breeze_touch_devices_after_membership_delete, which acquires the
  -- partner-export EXCLUSIVE org lock for the deleted rows' org (the SOURCE
  -- org) before touching devices.partner_export_updated_at. Those locks must
  -- be taken in ascending UUID order across the whole transaction, and
  -- breeze_partner_export_devices_update -- an AFTER STATEMENT trigger on this
  -- same devices UPDATE -- goes on to request BOTH orgs. Letting the touch
  -- trigger set the high-water mark to the source org alone would then abort
  -- the move with 'partner export organization locks must be acquired in
  -- ascending UUID order' whenever the TARGET org's uuid happens to sort
  -- lower: a coin-flip per move. So take both orgs up front, in the order the
  -- helper itself sorts them into, before anything else in this function
  -- acquires one. Every later request for either org then hits the helper's
  -- already-held short-circuit and is a no-op.
  --
  -- Note for a future bulk-move feature: this runs PER ROW, so it sorts one
  -- (OLD, NEW) pair at a time, whereas breeze_partner_export_devices_update
  -- sorts the whole statement's distinct org set in one pass and is therefore
  -- order-independent. Every devices.org_id writer today carries a SINGLE org
  -- pair per statement -- moveOrg.ts updates exactly one device, and the org
  -- merge's bulk repoint is always (loser -> survivor) and is skipped by the
  -- fence below anyway -- so per-row sorting is equivalent. A statement that
  -- moved devices between SEVERAL different org pairs at once could visit rows
  -- in an order that violates the ascending rule; such a feature must either
  -- keep one org pair per statement or pre-acquire the whole set here.
  --
  -- Skipped while the SOURCE org is fenced for a merge: a merge moves the
  -- devices AND their groups to the same survivor together (orgMerge.ts /
  -- orgMergeRegistry.ts REPOINT_TABLES lists devices, device_groups and
  -- device_group_memberships) under SET CONSTRAINTS ALL DEFERRED, so the
  -- memberships stay valid and MUST survive. Same fence, and same reason, as
  -- the tickets requester_contact_id detach below.
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = OLD.org_id AND o.status::text = 'merging'
  ) THEN
    PERFORM public.breeze_partner_export_lock_orgs_exclusive(ARRAY[OLD.org_id, NEW.org_id]);
    DELETE FROM public.device_group_memberships WHERE device_id = NEW.id;
  END IF;
  -- Agent-run history stays with the SOURCE org (owner decision 2026-08-23):
  -- sever the moved device's lineage links instead of re-stamping org_id.
  UPDATE public.ai_agent_runs
    SET device_id = NULL, alert_id = NULL, session_id = NULL, anomaly_incident_id = NULL
    WHERE device_id = NEW.id;
  -- ticket_id is device-lineage too, but unreachable from `WHERE device_id`:
  -- ticket-triggered runs carry a ticket_id with a NULL device_id. Key off the
  -- ticket's device_id instead (#4215).
  UPDATE public.ai_agent_runs
    SET ticket_id = NULL
    WHERE ticket_id IN (SELECT id FROM public.tickets WHERE device_id = NEW.id);
  -- AI Operator task history stays with the SOURCE org (#5205 W03, #5208):
  -- ai_operator_tasks.org_id is immutable and anchors three composite
  -- (x, org_id) FKs, so the generic re-stamp loop below deliberately excludes
  -- it. Sever the device pointer and fence any live task, mirroring
  -- moveOrg.ts's explicit statement so a DIRECT `devices.org_id` UPDATE that
  -- bypasses the route cannot strand a task pointing across tenants.
  UPDATE public.ai_operator_tasks
    SET device_id = NULL,
        target_detached_at = COALESCE(target_detached_at, now()),
        target_detached_reason = COALESCE(target_detached_reason, 'device_moved'),
        state = CASE WHEN state IN ('queued', 'running', 'waiting', 'paused') THEN 'stopping' ELSE state END,
        updated_at = now()
    WHERE device_id = NEW.id;
  -- Reverse pointer: the incident's back-link to the (now-detached) run must
  -- not keep naming a source-org run once the incident itself is re-stamped
  -- to the destination org by the generic loop below.
  UPDATE public.metric_anomaly_incidents
    SET agent_run_id = NULL
    WHERE device_id = NEW.id;
  -- Reverse pointer: ticket_comments.agent_run_id (#4644). ticket_comments has
  -- no org_id of its own (child-via-parent tenancy through tickets), so a
  -- comment on a ticket bound to this device travels to the target org via the
  -- generic loop below while the run it names stays with the SOURCE org —
  -- same class as the metric_anomaly_incidents reverse pointer above, and the
  -- device-axis mirror of moveTicketOrg's ticket_comments detach
  -- (ticketService.ts, #4642) on the ticket axis.
  UPDATE public.ticket_comments
    SET agent_run_id = NULL
    WHERE agent_run_id IS NOT NULL
      AND ticket_id IN (SELECT id FROM public.tickets WHERE device_id = NEW.id);
  -- Typed target scope of a LIVE intent must not keep naming a device that has
  -- just left the intent's org (#4454). Mirrors moveOrg.ts; see the header for
  -- the live-status gate, the immutability-trigger transition, and why this one
  -- takes no merge fence.
  UPDATE public.action_intents
    SET scope_device_id = NULL
    WHERE scope_device_id = NEW.id
      AND status IN ('pending_approval', 'approved', 'executing');
  -- The requester CONTACT is org-pinned and does not travel with the device
  -- (#3258 W03). Skipped while the source org is fenced for a merge, where the
  -- contact moves to the survivor alongside the ticket — see the header of
  -- 2026-10-04-100000-ticket-requester-contact.sql.
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = OLD.org_id AND o.status::text = 'merging'
  ) THEN
    UPDATE public.tickets
      SET requester_contact_id = NULL
      WHERE device_id = NEW.id
        AND requester_contact_id IS NOT NULL
        AND org_id IS DISTINCT FROM NEW.org_id;
  END IF;
  -- Typed target scope of an intent scoped to a TICKET bound to this device
  -- (#4792) must not keep naming a (ticket, OLD org_id) pair once the ticket
  -- is re-stamped to the destination org by the generic loop below — every
  -- status, not just live ones, since action_intents_scope_ticket_org_fk does
  -- not gate on status and would 23503 the loop's own tickets UPDATE
  -- otherwise. See this migration's header for the full mechanism; mirrors
  -- moveOrg.ts and moveTicketOrg (ticketService.ts). Placed after the
  -- requester-contact detach immediately above (order between the two is not
  -- itself load-bearing — they touch disjoint tables — but this makes the
  -- trigger's statement order match moveOrg.ts's exactly, not just
  -- "before the loop").
  UPDATE public.action_intents
    SET scope_ticket_id = NULL
    WHERE scope_ticket_id IN (SELECT id FROM public.tickets WHERE device_id = NEW.id);
  FOR child_table IN SELECT public.breeze_device_child_orgid_tables() LOOP
    EXECUTE format(
      'UPDATE public.%I SET org_id = $1 WHERE device_id = $2 AND org_id IS DISTINCT FROM $1',
      child_table
    ) USING NEW.org_id, NEW.id;
  END LOOP;
  -- #3182 safety net, same merge fence as the detach above. The generic loop
  -- just above blindly re-stamped device_group_memberships.org_id to
  -- NEW.org_id for every row naming this device -- normally none, since the
  -- detach at the top of this function already deleted them all, but the
  -- detach and this loop are two SEPARATE statements (two separate MVCC
  -- snapshots under READ COMMITTED), so a row that gets inserted for this
  -- device in the gap between them survives the detach and is instead
  -- re-stamped by the loop into exactly the forged shape the composite FKs
  -- exist to reject: org_id = NEW.org_id (target), group_id still naming a
  -- group in a DIFFERENT org. device_group_memberships_group_org_fk is
  -- DEFERRABLE INITIALLY DEFERRED (see the migration header) precisely so
  -- that mid-statement re-stamp does not abort the move outright, and this
  -- cleanup gets the chance to delete the row before COMMIT ever checks the
  -- deferred constraint. Same fence as the detach: during a merge the loop's
  -- re-stamp IS how this table's rows correctly follow the survivor (its
  -- group is repointed to the same survivor by a separate REPOINT_TABLES
  -- statement elsewhere in the merge transaction, not by this trigger), so
  -- this cleanup must stay out of that transition exactly like the detach
  -- does.
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = OLD.org_id AND o.status::text = 'merging'
  ) THEN
    DELETE FROM public.device_group_memberships dgm
     WHERE dgm.device_id = NEW.id
       AND EXISTS (
             SELECT 1 FROM public.device_groups g
              WHERE g.id = dgm.group_id AND g.org_id <> dgm.org_id
           );
  END IF;
  -- device_vulnerabilities.ticket_id (#4645): must run AFTER the generic loop
  -- above, not before — see this migration's header for why the ordering is
  -- load-bearing here (it is not for any of the tombstones above, which all
  -- run before the loop precisely because THEIR FK would 23503 otherwise).
  -- device_vulnerabilities.org_id has just been re-stamped to NEW.org_id by
  -- that loop (device_vulnerabilities IS a member of
  -- breeze_device_child_orgid_tables()), so a finding's ticket_id is
  -- compared against the ticket's own (possibly also just re-stamped) org_id
  -- rather than the finding's — a ticket bound to this same device was ALSO
  -- just moved to NEW.org_id by the loop and is correctly left alone; a
  -- ticket that stayed in the source org (the common case: vulnerability
  -- remediation tickets are created org-scoped only, never device-bound) is
  -- correctly detached. Plain FK (`ticket_id` -> `tickets.id` ON DELETE SET
  -- NULL, not composite), so this can never 23503.
  UPDATE public.device_vulnerabilities dv
    SET ticket_id = NULL
    FROM public.tickets t
    WHERE dv.device_id = NEW.id
      AND dv.ticket_id = t.id
      AND t.org_id IS DISTINCT FROM NEW.org_id;
  RETURN NULL; -- AFTER trigger; return value ignored
END;
$$;
