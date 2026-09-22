-- apps/api/migrations/2026-10-26-160000-ai-operator-task-graph.sql
--
-- 2026-10-26: AI Operator Recipe Library wave E2 — task targets (incl. the
-- `contact` class), frozen provider accounts, steps and the append-only event
-- timeline. This IS Operator P3-2's first PR with the deltas of recipe spec
-- §5.1/§5.2/§5.3/§5.5.
--
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-17-operator-recipe-library-design.md
--       §5 (tenancy ceremony), §5.1, §5.2, §5.3 (step_kind only), §5.5.
-- Adopts: docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-completion-design.md
--       §11 (column lists), §11.1 (indexes), §11.3 (reference lifecycle matrix).
--
-- DDL ONLY. This file writes NO rows, so it elects no `breeze.scope`; the
-- backfill lives in 2026-10-26-160100-ai-operator-inline-target-backfill.sql,
-- which does (apps/api/src/db/migrationRlsScope.test.ts).
--
-- Deliberate design points, each traceable to a contract. The four numbered
-- points in 2026-10-14-100000-ai-operator-thin-slice.sql's header still apply
-- verbatim (text+CHECK never pgEnum; literal partial-index predicates;
-- DEFERRABLE INITIALLY IMMEDIATE on every composite org FK; column-scoped
-- ON DELETE SET NULL so detach never clears org_id). What is NEW here:
--
--  A. TARGET POINTERS HAVE THREE DIFFERENT FK SHAPES, on purpose.
--     - device_id: PLAIN `REFERENCES devices(id) ON DELETE SET NULL`, no
--       composite — spec §11.3's matrix says so, and a composite one would
--       make breeze_cascade_device_org_id() 23503 instead of merely leaving a
--       stale pointer (the trigger re-stamps child org_id BEFORE anything
--       could repair the pair).
--     - ticket_id: same shape, same reason, on the ticket axis
--       (services/ticketService.ts moveTicketOrg).
--     - contact_id: COMPOSITE `(contact_id, org_id) -> contacts(id, org_id)`
--       with `ON DELETE SET NULL (contact_id)`. A contact never moves between
--       orgs (ticketService.ts:2800-2805: "contacts are org-pinned and the
--       requester does NOT move with the ticket"), so the composite FK costs
--       nothing and buys the guarantee that matters most in this wave: an
--       offboarding task can NEVER name a person in another tenant. Precedent:
--       tickets_requester_contact_org_fk (2026-10-04-100000-ticket-requester-
--       contact.sql:42-47).
--
--  B. `ai_operator_task_targets` EXPOSES (id, task_id, org_id), not just
--     (id, org_id). Spec §11.3: "targets/steps expose (id, task_id, org_id),
--     and run/step/target/operation links use task-qualified composite FKs …
--     Reject task-A/step-B and operation-A/intent-B links even within one
--     org." Same-org alone is NOT sufficient for task lineage, so the step and
--     account children below reference the three-column tuple.
--
--  C. `ai_operator_task_events` IS APPEND-ONLY: REVOKE UPDATE/DELETE from
--     breeze_app plus a BEFORE UPDATE OR DELETE trigger that RAISEs, copied
--     from script_proposal_reviews (2026-10-16-100100-script-proposals.sql:
--     225-252). Consequences that are easy to get wrong:
--       - it MUST be registered in AUDIT_ADMIN_REQUIRED_TABLES
--         (services/tenantCascade.ts:1084) or org erasure 42501s on it;
--       - its `actor_user_id` and `target_id` carry NO foreign key. An
--         `ON DELETE SET NULL` performs an UPDATE, which the trigger rejects
--         with 55000 — deleting a user would abort. RESTRICT would instead make
--         a user undeletable. Typed reference with no hard FK, exactly like
--         ai_operator_operations.execution_ref_id;
--       - the trigger's DELETE arm permits `pg_trigger_depth() > 1`, so the
--         ON DELETE CASCADE from the parent task still works.
--
--  D. `transition_seq` IS ALLOCATED FROM ai_operator_tasks.event_seq, under
--     the task's own row lock, never from MAX()+1. See that column's comment
--     in db/schema/aiOperatorTasks.ts. NOTE the name collision and do not
--     conflate them: ai_operator_task_OUTBOX.transition_seq is a fixed
--     "terminal status ordinal" (taskOutbox.ts:92, :127), deliberately NOT a
--     counter, because its job is to make a redelivered wake collapse onto one
--     row. The EVENTS counter is the opposite: strictly increasing, one per
--     recorded transition.
--
--  E. `google_workspace_connections` HAS NO (id, org_id) UNIQUE INDEX today
--     (only google_workspace_connections_org_uniq on org_id alone,
--     2026-06-01-google-workspace-connections.sql:28-29), so section 2 creates
--     one before the account table's FK can reference it. m365_connections
--     already has m365_connections_id_org_uniq
--     (2026-10-16-170200-m365-tenant-sync-foundation.sql:35-44).
--     m365_connections.org_id is NULLABLE (delegated/user-axis rows), so a
--     null-org connection simply has no (id, org_id) tuple to match and cannot
--     be named by an org-scoped task account. That is the intended outcome.
--
--  F. `ai_operator_task_targets` CARRIES device_id AND org_id, which enrols it
--     in breeze_device_child_orgid_tables() automatically — the helper is
--     DYNAMIC. Section 8 excludes it for exactly the reason ai_operator_tasks
--     is excluded: Operator history stays in its source org, and the re-stamp
--     would 23503 against ai_operator_task_targets_task_org_fk.
--
-- Idempotent throughout: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, DROP CONSTRAINT IF EXISTS before each ADD CONSTRAINT, DROP POLICY IF
-- EXISTS before each CREATE POLICY, CREATE OR REPLACE for the two functions.
-- autoMigrate wraps this file in one transaction — no inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- 1. ai_operator_tasks: workflow_config_id and event_seq (recipe spec §5.5)
-- ---------------------------------------------------------------------------

ALTER TABLE ai_operator_tasks ADD COLUMN IF NOT EXISTS workflow_config_id uuid;
ALTER TABLE ai_operator_tasks ADD COLUMN IF NOT EXISTS event_seq bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN ai_operator_tasks.workflow_config_id IS
  'Saved workflow configuration (Operator spec §11 ai_operator_workflows). NO FK: that table is a later wave. The first reader of this column ships the FK with it.';
COMMENT ON COLUMN ai_operator_tasks.event_seq IS
  'Monotonic allocator for ai_operator_task_events.transition_seq. Bumped with UPDATE ... SET event_seq = event_seq + 1 RETURNING, which takes the task row lock and serialises event writers without a 23505 retry.';

-- ---------------------------------------------------------------------------
-- 2. google_workspace_connections: the (id, org_id) tuple a composite FK needs
-- ---------------------------------------------------------------------------
--
-- Header note E. org_id is already NOT NULL and singly unique here, so this
-- index is redundant for uniqueness and exists purely to give the account
-- table's FK a target.

CREATE UNIQUE INDEX IF NOT EXISTS google_workspace_connections_id_org_uniq
  ON public.google_workspace_connections (id, org_id);

-- ---------------------------------------------------------------------------
-- 3. ai_operator_task_targets  (recipe spec §5.1)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_operator_task_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL,

  target_kind text NOT NULL
    CONSTRAINT ai_operator_task_targets_kind_chk
    CHECK (target_kind IN ('device', 'ticket', 'contact')),

  -- Header note A: three pointers, three FK shapes. All three nullable so a
  -- detached target keeps its row, its label and its tenant.
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  contact_id uuid,

  -- Frozen at admission. Survives every detach — it is the evidence that says
  -- WHO or WHAT the task was pointed at after the pointer is gone.
  target_label text NOT NULL
    CONSTRAINT ai_operator_task_targets_label_len_chk CHECK (length(target_label) <= 255),
  target_ordinal integer NOT NULL,

  state text NOT NULL DEFAULT 'pending'
    CONSTRAINT ai_operator_task_targets_state_chk CHECK (state IN (
      'pending', 'active', 'succeeded', 'failed', 'skipped', 'detached'
    )),

  -- Same reason vocabulary as ai_operator_tasks.target_detached_reason
  -- (AI_OPERATOR_TARGET_DETACH_REASONS) — reused verbatim, not forked:
  -- 'scope_invalidated' is what a merged-away or deleted contact gets
  -- (recipe spec §5.1).
  detached_at timestamptz,
  detached_reason text
    CONSTRAINT ai_operator_task_targets_detached_reason_chk
    CHECK (detached_reason IS NULL OR detached_reason IN (
      'device_moved', 'device_deleted', 'org_merged', 'scope_invalidated'
    )),
  CONSTRAINT ai_operator_task_targets_detach_chk CHECK (
    (detached_at IS NULL AND detached_reason IS NULL)
    OR (detached_at IS NOT NULL AND detached_reason IS NOT NULL)
  ),

  -- Recipe spec §5.1: "exactly one of (device_id, ticket_id, contact_id) is
  -- set, or the row is detached". Written as a count so a future fourth
  -- pointer cannot slip past a hand-written pairwise condition.
  CONSTRAINT ai_operator_task_targets_one_pointer_chk CHECK (
    (
      (device_id IS NOT NULL)::int
      + (ticket_id IS NOT NULL)::int
      + (contact_id IS NOT NULL)::int
    ) = CASE WHEN detached_at IS NULL THEN 1 ELSE 0 END
  ),

  -- The pointer that IS set must be the one target_kind names. Without this a
  -- 'contact' target could carry a device_id and satisfy the count above,
  -- which is precisely the wrong-person-offboarded failure mode (recipe spec
  -- §11, first risk row).
  CONSTRAINT ai_operator_task_targets_kind_pointer_chk CHECK (
    detached_at IS NOT NULL
    OR (target_kind = 'device'  AND device_id  IS NOT NULL)
    OR (target_kind = 'ticket'  AND ticket_id  IS NOT NULL)
    OR (target_kind = 'contact' AND contact_id IS NOT NULL)
  ),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Header note B: the tuple the step and account children reference. Three
-- columns, not two, so a step can never name a target belonging to a
-- different task of the same org.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_task_targets_id_task_org_uq
  ON ai_operator_task_targets (id, task_id, org_id);

-- Stable ordering of a task's targets (recipe spec §5.1 target_ordinal).
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_task_targets_task_ordinal_uq
  ON ai_operator_task_targets (org_id, task_id, target_ordinal);

ALTER TABLE ai_operator_task_targets DROP CONSTRAINT IF EXISTS ai_operator_task_targets_task_org_fk;
ALTER TABLE ai_operator_task_targets ADD CONSTRAINT ai_operator_task_targets_task_org_fk
  FOREIGN KEY (task_id, org_id) REFERENCES ai_operator_tasks (id, org_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

-- Header note A, contact arm. Column-scoped SET NULL keeps org_id; legal here
-- because contact_id is a column of this FK and is NOT a member of an
-- all-or-none CHECK group (the two CHECKs above both tolerate an all-null
-- pointer set once detached_at is stamped — and the detach writer stamps
-- detached_at in the SAME statement, see services/aiOperator/targetService.ts.
-- A bare contact delete with no detach stamp would violate
-- ai_operator_task_targets_one_pointer_chk, which is why `contacts` delete is
-- routed through detachTargetsForContact rather than left to the FK alone).
ALTER TABLE ai_operator_task_targets DROP CONSTRAINT IF EXISTS ai_operator_task_targets_contact_org_fk;
ALTER TABLE ai_operator_task_targets ADD CONSTRAINT ai_operator_task_targets_contact_org_fk
  FOREIGN KEY (contact_id, org_id) REFERENCES contacts (id, org_id)
  ON DELETE SET NULL (contact_id)
  DEFERRABLE INITIALLY IMMEDIATE;

-- Spec §11.1's "(device_id) WHERE device_id IS NOT NULL; same for ticket",
-- plus the contact twin. Literal predicates (header note 2 of the thin slice).
-- These serve the three detach paths and the #5022 device-page feed.
CREATE INDEX IF NOT EXISTS ai_operator_task_targets_device_idx
  ON ai_operator_task_targets (device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_operator_task_targets_ticket_idx
  ON ai_operator_task_targets (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_operator_task_targets_contact_idx
  ON ai_operator_task_targets (contact_id) WHERE contact_id IS NOT NULL;

-- Detach-stamp backstop. Every pointer FK above ends in ON DELETE SET NULL,
-- and a referential SET NULL nulls the pointer WITHOUT stamping detached_at —
-- which ai_operator_task_targets_one_pointer_chk rejects with 23514, aborting
-- the parent DELETE (a device, ticket or contact would become undeletable
-- while any task targeted it). The app-level detach statements (moveOrg.ts,
-- deviceDeletion.ts, moveTicketOrg, the merge fence) all stamp explicitly
-- with the precise reason; this BEFORE trigger covers every path that does
-- not — e.g. services/contacts/compat.ts's contact delete, or any future
-- delete path — by stamping in the same row write, before the CHECK runs.
-- It never touches org_id, so it is BENIGN to the org-merge repoint
-- (orgMergeRegistry.integration.test.ts ORG_ID_BENIGN_TRIGGERS).
CREATE OR REPLACE FUNCTION ai_operator_task_targets_stamp_detach()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.detached_at IS NULL
     AND NEW.device_id IS NULL AND NEW.ticket_id IS NULL AND NEW.contact_id IS NULL
     AND (OLD.device_id IS NOT NULL OR OLD.ticket_id IS NOT NULL OR OLD.contact_id IS NOT NULL)
  THEN
    NEW.detached_at := now();
    NEW.detached_reason := COALESCE(
      NEW.detached_reason,
      CASE WHEN OLD.device_id IS NOT NULL THEN 'device_deleted' ELSE 'scope_invalidated' END
    );
    NEW.state := 'detached';
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_operator_task_targets_stamp_detach ON ai_operator_task_targets;
CREATE TRIGGER ai_operator_task_targets_stamp_detach
  BEFORE UPDATE OF device_id, ticket_id, contact_id ON ai_operator_task_targets
  FOR EACH ROW EXECUTE FUNCTION ai_operator_task_targets_stamp_detach();

ALTER TABLE ai_operator_task_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_task_targets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_operator_task_targets;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_operator_task_targets;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_operator_task_targets;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_operator_task_targets;

CREATE POLICY breeze_org_isolation_select ON ai_operator_task_targets
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_operator_task_targets
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_operator_task_targets
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_operator_task_targets
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ai_operator_task_targets TO breeze_app;

-- ---------------------------------------------------------------------------
-- 4. ai_operator_task_target_accounts  (recipe spec §5.2)
-- ---------------------------------------------------------------------------
--
-- "Provider accounts are NOT target rows. They are frozen facts about the
-- contact target" (recipe spec §5.1/§5.2). Two nullable connection columns
-- rather than one polymorphic `connection_id`, because the two providers live
-- in two different tables and a single column could reference neither with a
-- real FK — which is how a cross-tenant connection pointer gets in.

CREATE TABLE IF NOT EXISTS ai_operator_task_target_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL,
  target_id uuid NOT NULL,

  provider text NOT NULL
    CONSTRAINT ai_operator_task_target_accounts_provider_chk
    CHECK (provider IN ('m365', 'google')),

  m365_connection_id uuid,
  google_connection_id uuid,

  -- Exactly the connection column the provider names, and no other. Nullable
  -- so the row survives a removed or merged-away connection with its frozen
  -- external_id intact — the id is what a later dispatch addresses, and it
  -- stays true even when the connection row is gone.
  CONSTRAINT ai_operator_task_target_accounts_provider_conn_chk CHECK (
    (provider = 'm365'   AND google_connection_id IS NULL)
    OR (provider = 'google' AND m365_connection_id IS NULL)
  ),

  -- Recipe spec §5.2: "Entra object id / Google user id: immutable, never the
  -- UPN". This is what every dispatch addresses, so a rename mid-task cannot
  -- retarget an effect (D2).
  external_id text NOT NULL
    CONSTRAINT ai_operator_task_target_accounts_external_id_len_chk
    CHECK (length(external_id) BETWEEN 1 AND 255),
  -- UPN / primary email at admission. DISPLAY ONLY — never used to address an
  -- effect. Bounded text, exportable.
  principal_label text NOT NULL
    CONSTRAINT ai_operator_task_target_accounts_principal_label_len_chk
    CHECK (length(principal_label) BETWEEN 1 AND 320),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Recipe spec §5.2, verbatim: UNIQUE (org_id, task_id, provider). One account
-- per provider per task — a person has at most one M365 identity and one
-- Google identity within a customer, and two would mean the intake resolved
-- the wrong person.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_task_target_accounts_task_provider_uq
  ON ai_operator_task_target_accounts (org_id, task_id, provider);

CREATE INDEX IF NOT EXISTS ai_operator_task_target_accounts_target_idx
  ON ai_operator_task_target_accounts (org_id, target_id);

-- SAME-ORG *AND* SAME-TASK (header note B). The three-column tuple is what
-- makes a task-A/target-B link unrepresentable rather than merely wrong.
ALTER TABLE ai_operator_task_target_accounts DROP CONSTRAINT IF EXISTS ai_operator_task_target_accounts_target_fk;
ALTER TABLE ai_operator_task_target_accounts ADD CONSTRAINT ai_operator_task_target_accounts_target_fk
  FOREIGN KEY (target_id, task_id, org_id)
  REFERENCES ai_operator_task_targets (id, task_id, org_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

-- Belt as well as braces: the target FK above already implies the task, but a
-- direct edge to the task is what topologicalCascadeOrder() reads to order
-- erasure, and what makes `WHERE task_id = ?` a legal scan.
ALTER TABLE ai_operator_task_target_accounts DROP CONSTRAINT IF EXISTS ai_operator_task_target_accounts_task_org_fk;
ALTER TABLE ai_operator_task_target_accounts ADD CONSTRAINT ai_operator_task_target_accounts_task_org_fk
  FOREIGN KEY (task_id, org_id) REFERENCES ai_operator_tasks (id, org_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE ai_operator_task_target_accounts DROP CONSTRAINT IF EXISTS ai_operator_task_target_accounts_m365_conn_org_fk;
ALTER TABLE ai_operator_task_target_accounts ADD CONSTRAINT ai_operator_task_target_accounts_m365_conn_org_fk
  FOREIGN KEY (m365_connection_id, org_id) REFERENCES m365_connections (id, org_id)
  ON DELETE SET NULL (m365_connection_id)
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE ai_operator_task_target_accounts DROP CONSTRAINT IF EXISTS ai_operator_task_target_accounts_google_conn_org_fk;
ALTER TABLE ai_operator_task_target_accounts ADD CONSTRAINT ai_operator_task_target_accounts_google_conn_org_fk
  FOREIGN KEY (google_connection_id, org_id) REFERENCES google_workspace_connections (id, org_id)
  ON DELETE SET NULL (google_connection_id)
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE ai_operator_task_target_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_task_target_accounts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_operator_task_target_accounts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_operator_task_target_accounts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_operator_task_target_accounts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_operator_task_target_accounts;

CREATE POLICY breeze_org_isolation_select ON ai_operator_task_target_accounts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_operator_task_target_accounts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_operator_task_target_accounts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_operator_task_target_accounts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_operator_task_target_accounts TO breeze_app;

-- ---------------------------------------------------------------------------
-- 5. ai_operator_task_steps  (Operator spec §11 + recipe spec §5.3 step_kind)
-- ---------------------------------------------------------------------------
--
-- NOT IN THIS WAVE: `checklist_item_id` and the ticket_checklist_items
-- changes of recipe spec §5.3 — those are wave E3, together with the
-- `ALTER TYPE ticket_checklist_item_source ADD VALUE 'operator_task'` that
-- must ship in its OWN migration sorted ahead of any file that uses the value
-- (a new enum value cannot be used in the transaction that adds it).

CREATE TABLE IF NOT EXISTS ai_operator_task_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL,

  step_key text NOT NULL
    CONSTRAINT ai_operator_task_steps_step_key_len_chk CHECK (length(step_key) <= 128),
  step_kind text NOT NULL
    CONSTRAINT ai_operator_task_steps_step_kind_chk CHECK (step_kind IN (
      'reason', 'effect', 'probe', 'wait', 'human_work', 'document'
    )),

  -- Nullable: a task-wide step (`document`, an intake `reason`) has no target.
  target_id uuid,

  attempt_ordinal integer NOT NULL DEFAULT 0,

  state text NOT NULL DEFAULT 'pending'
    CONSTRAINT ai_operator_task_steps_state_chk CHECK (state IN (
      'pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped'
    )),

  -- `ai_operator_tasks.revision` pinned when the step was opened (spec §11's
  -- "revision" on the steps row). A step whose plan revision no longer matches
  -- the task's is stale by construction.
  plan_revision integer,

  -- Spec §11's "expected criterion", as BOUNDED TEXT rather than jsonb, so it
  -- survives tenant export (§11: "anything a customer must be able to export
  -- lives in bounded text columns classified `included`").
  expected_criterion text
    CONSTRAINT ai_operator_task_steps_criterion_len_chk
    CHECK (expected_criterion IS NULL OR length(expected_criterion) <= 2000),

  -- Spec §11's "typed dependencies". Same vocabulary as
  -- ai_operator_tasks.wait_dependency_kind, all-or-none like it.
  dependency_kind text
    CONSTRAINT ai_operator_task_steps_dependency_kind_chk
    CHECK (dependency_kind IS NULL OR dependency_kind IN (
      'intent', 'operation', 'run', 'device_command', 'user_answer', 'verification'
    )),
  dependency_id uuid,
  CONSTRAINT ai_operator_task_steps_dependency_chk CHECK (
    (dependency_kind IS NULL AND dependency_id IS NULL)
    OR (dependency_kind IS NOT NULL AND dependency_id IS NOT NULL)
  ),

  -- Spec §11's "typed checkpoint". jsonb, therefore `excludedOpen` in the
  -- export policy WITHOUT exception — every field a customer must export has
  -- its own bounded text column above.
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT ai_operator_task_steps_checkpoint_size_chk CHECK (pg_column_size(checkpoint) <= 65536),

  detail text
    CONSTRAINT ai_operator_task_steps_detail_len_chk
    CHECK (detail IS NULL OR length(detail) <= 4000),

  started_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Spec §11: "unique task/step/target identity". TWO partial uniques, not one
-- five-column unique, because a NULL `target_id` makes a plain unique index
-- enforce NOTHING for task-wide steps — every `(task, 'document', NULL, 0)`
-- would be permitted again and again, which is exactly the duplicate-step bug
-- the constraint exists to stop.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_task_steps_identity_uq
  ON ai_operator_task_steps (org_id, task_id, step_key, target_id, attempt_ordinal)
  WHERE target_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_task_steps_identity_null_target_uq
  ON ai_operator_task_steps (org_id, task_id, step_key, attempt_ordinal)
  WHERE target_id IS NULL;

CREATE INDEX IF NOT EXISTS ai_operator_task_steps_task_state_idx
  ON ai_operator_task_steps (org_id, task_id, state);

ALTER TABLE ai_operator_task_steps DROP CONSTRAINT IF EXISTS ai_operator_task_steps_task_org_fk;
ALTER TABLE ai_operator_task_steps ADD CONSTRAINT ai_operator_task_steps_task_org_fk
  FOREIGN KEY (task_id, org_id) REFERENCES ai_operator_tasks (id, org_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

-- SAME-TASK target link (header note B). ON DELETE SET NULL (target_id) so a
-- detached-then-erased target does not take the step's evidence with it;
-- target_id is not part of any all-or-none CHECK group here, so the
-- column-scoped form is legal.
ALTER TABLE ai_operator_task_steps DROP CONSTRAINT IF EXISTS ai_operator_task_steps_target_fk;
ALTER TABLE ai_operator_task_steps ADD CONSTRAINT ai_operator_task_steps_target_fk
  FOREIGN KEY (target_id, task_id, org_id)
  REFERENCES ai_operator_task_targets (id, task_id, org_id)
  ON DELETE SET NULL (target_id)
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE ai_operator_task_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_task_steps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_operator_task_steps;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_operator_task_steps;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_operator_task_steps;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_operator_task_steps;

CREATE POLICY breeze_org_isolation_select ON ai_operator_task_steps
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_operator_task_steps
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_operator_task_steps
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_operator_task_steps
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_operator_task_steps TO breeze_app;

-- ---------------------------------------------------------------------------
-- 6. ai_operator_task_events  (Operator spec §11, APPEND-ONLY — header note C)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_operator_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL,

  -- Header note D. Allocated from ai_operator_tasks.event_seq under the task's
  -- row lock. Strictly increasing per task; NOT the outbox's fixed ordinal.
  transition_seq bigint NOT NULL,

  event_type text NOT NULL
    CONSTRAINT ai_operator_task_events_event_type_chk CHECK (event_type IN (
      'task_admitted', 'lease_claimed', 'step_opened', 'step_settled',
      'wait_entered', 'wait_resolved', 'target_attached', 'target_detached',
      'target_account_frozen', 'operation_reserved', 'operation_settled',
      'verification_recorded', 'plan_revision_bumped', 'task_settled'
    )),

  actor_kind text NOT NULL
    CONSTRAINT ai_operator_task_events_actor_kind_chk CHECK (actor_kind IN (
      'coordinator', 'reconciler', 'user', 'agent', 'system'
    )),
  -- NO FOREIGN KEY (header note C): ON DELETE SET NULL is an UPDATE, which the
  -- append-only trigger below rejects with 55000, and RESTRICT would make a
  -- user undeletable. Typed reference only, same ruling as
  -- ai_operator_operations.execution_ref_id.
  actor_user_id uuid,
  -- Spec §7.1: "Database context has no synthetic human user ID." A machine
  -- actor never carries one, and this CHECK makes that structural.
  CONSTRAINT ai_operator_task_events_actor_chk CHECK (
    (actor_kind = 'user' AND actor_user_id IS NOT NULL)
    OR (actor_kind <> 'user' AND actor_user_id IS NULL)
  ),

  step_key text
    CONSTRAINT ai_operator_task_events_step_key_len_chk
    CHECK (step_key IS NULL OR length(step_key) <= 128),
  -- NO FOREIGN KEY, same reason as actor_user_id.
  target_id uuid,

  -- BOUNDED TEXT, NOT jsonb (recipe spec §5.5's rule applied to this table):
  -- an event a customer must be able to export cannot live in an open
  -- container, because every json/jsonb column is `excludedOpen` without
  -- exception. There is deliberately NO jsonb column on this table at all.
  detail text
    CONSTRAINT ai_operator_task_events_detail_len_chk
    CHECK (detail IS NULL OR length(detail) <= 4000),

  created_at timestamptz NOT NULL DEFAULT now()
);

-- Spec §11.1: "(task_id, sequence) unique". task_id is globally unique, so the
-- pair needs no org_id; the org-scoped read index below is separate.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_task_events_task_seq_uq
  ON ai_operator_task_events (task_id, transition_seq);

CREATE INDEX IF NOT EXISTS ai_operator_task_events_org_task_created_idx
  ON ai_operator_task_events (org_id, task_id, created_at DESC);

ALTER TABLE ai_operator_task_events DROP CONSTRAINT IF EXISTS ai_operator_task_events_task_org_fk;
ALTER TABLE ai_operator_task_events ADD CONSTRAINT ai_operator_task_events_task_org_fk
  FOREIGN KEY (task_id, org_id) REFERENCES ai_operator_tasks (id, org_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

-- Append-only guard. Body and shape copied from
-- 2026-10-16-100100-script-proposals.sql:225-252 (script_proposal_reviews).
-- The DELETE arm permits the retention role and cascading deletes from the
-- parent task; everything else RAISEs.
CREATE OR REPLACE FUNCTION ai_operator_task_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allow_retention text := current_setting('breeze.allow_audit_retention', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Erasure (breeze_audit_admin with the retention flag set) and the
    -- ON DELETE CASCADE from ai_operator_tasks are the only permitted removals.
    IF allow_retention = '1' OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'AI Operator task events are append-only',
    HINT = 'A task timeline is evidence. It cannot be modified or deleted. Retention uses breeze_audit_admin plus breeze.allow_audit_retention=1.';
END;
$$;

DROP TRIGGER IF EXISTS ai_operator_task_events_block_update ON ai_operator_task_events;
CREATE TRIGGER ai_operator_task_events_block_update
  BEFORE UPDATE ON ai_operator_task_events
  FOR EACH ROW EXECUTE FUNCTION ai_operator_task_events_append_only();
DROP TRIGGER IF EXISTS ai_operator_task_events_block_delete ON ai_operator_task_events;
CREATE TRIGGER ai_operator_task_events_block_delete
  BEFORE DELETE ON ai_operator_task_events
  FOR EACH ROW EXECUTE FUNCTION ai_operator_task_events_append_only();

ALTER TABLE ai_operator_task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_task_events FORCE ROW LEVEL SECURITY;

-- All four commands still get a policy: rls-coverage.integration.test.ts's
-- REQUIRED_CMDS demands SELECT/INSERT/UPDATE/DELETE on every Shape-1 table,
-- and there is no bucket to opt out into. The GRANTs below are what actually
-- make the table append-only for breeze_app; the policies merely say "even if
-- you had the grant, only your own tenant".
DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_operator_task_events;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_operator_task_events;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_operator_task_events;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_operator_task_events;

CREATE POLICY breeze_org_isolation_select ON ai_operator_task_events
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_operator_task_events
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_operator_task_events
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_operator_task_events
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, REFERENCES ON ai_operator_task_events TO breeze_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ai_operator_task_events FROM breeze_app;
GRANT SELECT, DELETE ON ai_operator_task_events TO breeze_audit_admin;
REVOKE INSERT, UPDATE, TRUNCATE ON ai_operator_task_events FROM breeze_audit_admin;

-- ---------------------------------------------------------------------------
-- 7. Table comments — the durable half of the rationale above
-- ---------------------------------------------------------------------------

COMMENT ON TABLE ai_operator_task_targets IS
  'One frozen AI Operator task target: a device, a ticket, or a CONTACT (recipe spec 2026-09-17 §5.1). Detach never clears org_id and never clears target_label — the label is the evidence that outlives the pointer. Exposes (id, task_id, org_id) so children cannot link across tasks.';
COMMENT ON TABLE ai_operator_task_target_accounts IS
  'Frozen provider identity behind a contact target (recipe spec §5.2). external_id is the immutable Entra object id / Google user id and is what every dispatch addresses; principal_label is display only, so a rename mid-task cannot retarget an effect.';
COMMENT ON TABLE ai_operator_task_steps IS
  'One AI Operator recipe step attempt (Operator spec §11). Identity is (org_id, task_id, step_key, target_id, attempt_ordinal), enforced by TWO partial uniques because a NULL target_id makes a single unique index enforce nothing.';
COMMENT ON TABLE ai_operator_task_events IS
  'Append-only AI Operator task timeline. REVOKE UPDATE/DELETE from breeze_app plus an immutability trigger, so it is registered in AUDIT_ADMIN_REQUIRED_TABLES. actor_user_id and target_id carry NO foreign key: ON DELETE SET NULL is an UPDATE the trigger rejects.';
COMMENT ON COLUMN ai_operator_task_events.transition_seq IS
  'Per-task monotonic counter allocated from ai_operator_tasks.event_seq. NOT the same thing as ai_operator_task_outbox.transition_seq, which is a fixed terminal-status ordinal chosen so redelivery collapses onto one row.';

-- ---------------------------------------------------------------------------
-- 8. breeze_device_child_orgid_tables(): exclude ai_operator_task_targets
-- ---------------------------------------------------------------------------
--
-- Header note F. The helper is DYNAMIC — it returns every public table with
-- both a uuid `device_id` and a uuid `org_id`, minus an exclusion list — so
-- section 3 above silently enrolled ai_operator_task_targets in the device-move
-- re-stamp loop. That loop would set the target's org_id to the destination
-- org while its task_id still names a SOURCE-org task, aborting the entire move
-- on ai_operator_task_targets_task_org_fk. Excluded for exactly the reason
-- ai_operator_tasks is.
--
-- Body copied VERBATIM from the newest definition,
-- 2026-10-14-100000-ai-operator-thin-slice.sql (section 7) — verified by
-- grepping every later file in apps/api/migrations for
-- `breeze_device_child_orgid_tables` — with `ai_operator_task_targets` added to
-- the NOT IN list and its rationale added to the comment block.
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
    -- (#5205 W03, #5208). org_id is immutable and anchors composite
    -- (x, org_id) FKs, so a re-stamp aborts the move as soon as the task has
    -- an operation, an outbox wake, a target, a step, an event, a linked run
    -- or a linked intent. moveOrg.ts and this trigger both detach device_id
    -- and fence the task instead.
    -- ai_operator_task_targets (recipe library E2): same rule one level down.
    -- The target's org_id is its TASK's org_id and anchors
    -- ai_operator_task_targets_task_org_fk, so re-stamping it to the
    -- destination org while the task stays behind aborts the move with 23503.
    -- Section 9 detaches device_id and stamps the reason instead.
    AND t.relname NOT IN (
      'ai_agent_runs',
      'ai_operator_tasks',
      'ai_operator_task_targets',
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
-- 9. breeze_cascade_device_org_id(): sever target device/ticket lineage too
-- ---------------------------------------------------------------------------
--
-- routes/devices/moveOrg.ts carries explicit detach statements, but the route
-- is not the only way devices.org_id changes: a direct UPDATE fires this AFTER
-- trigger and nothing else. The thin slice added the ai_operator_tasks
-- statement here for exactly that reason; this adds its twins for targets.
--
-- Body copied VERBATIM from the newest definition,
-- 2026-10-16-182100-ai-origin-attribution.sql (verified by grepping every
-- later file in apps/api/migrations for breeze_cascade_device_org_id), with
-- exactly TWO statements added immediately after the existing
-- `UPDATE public.ai_operator_tasks` block: the target device_id detach and
-- its ticket-axis twin. The trigger itself (breeze_cascade_device_org_id ON
-- devices, AFTER UPDATE OF org_id) is unchanged and is NOT redeclared.
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
  -- ai_operator_tasks.org_id is immutable and anchors four composite
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
  -- AI Operator task TARGET history stays with the SOURCE org (recipe
  -- library E2), same rule and same convergence properties as the task
  -- statement above: COALESCE on the detach stamp so whichever of (this
  -- trigger, moveOrg.ts, deviceDeletion.ts, the merge fence) runs first wins
  -- the reason and the others are no-ops. Nulling device_id here also makes
  -- the generic loop below a no-op for these rows — though the table's
  -- exclusion from the device-child org_id table list (section 8) is the
  -- real guarantee, not this.
  -- device_id is the target's only pointer (one_pointer_chk), so the detach
  -- stamp is written in the same statement.
  UPDATE public.ai_operator_task_targets
    SET device_id = NULL,
        detached_at = COALESCE(detached_at, now()),
        detached_reason = COALESCE(detached_reason, 'device_moved'),
        state = 'detached',
        updated_at = now()
    WHERE device_id = NEW.id;
  -- The ticket-axis twin, keyed off the ticket's device_id exactly like the
  -- ai_agent_runs.ticket_id sever above: a ticket bound to this device is
  -- re-stamped to NEW.org_id by the generic loop below, while a target naming
  -- it stays with its source-org task. ai_operator_task_targets.ticket_id is a
  -- PLAIN FK (no composite), so without this the stale cross-tenant pointer
  -- would survive in silence rather than 23503.
  UPDATE public.ai_operator_task_targets
    SET ticket_id = NULL,
        detached_at = COALESCE(detached_at, now()),
        detached_reason = COALESCE(detached_reason, 'scope_invalidated'),
        state = 'detached',
        updated_at = now()
    WHERE ticket_id IN (SELECT id FROM public.tickets WHERE device_id = NEW.id);
  -- #5022 W01: script_executions IS re-stamped to the target org (it is in
  -- CORE_DEVICE_ORG_DENORMALIZED_TABLES), but ai_agent_runs deliberately is
  -- NOT, and ai_sessions is re-stamped only when it is device-bound -- a
  -- device-less chat session stays behind. Either way a moved execution can
  -- end up pointing at a session or run in a DIFFERENT tenant. Sever both
  -- pointers and RETAIN ai_initiator_kind: the fact that an AI did the work
  -- survives the move; the cross-tenant pointer does not. Mirrored in
  -- moveOrg.ts; both copies are convergent -- the second to run matches
  -- nothing. This copy additionally covers a DIRECT devices.org_id UPDATE that
  -- bypasses the route.
  UPDATE public.script_executions
    SET ai_session_id = NULL, ai_agent_run_id = NULL
    WHERE device_id = NEW.id
      AND (ai_session_id IS NOT NULL OR ai_agent_run_id IS NOT NULL);
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
