-- apps/api/migrations/2026-10-26-170100-ai-operator-human-work-links.sql
--
-- Recipe Library wave E3, spec §5.3 and §6.5: a `human_work` step and the
-- ticket checklist item a human ticks to complete it.
--
-- DELIBERATE DESIGN POINTS
--
--  A. ONE OWNING FOREIGN KEY, AND IT IS THE STEP'S — decision D1.
--     `ai_operator_task_steps.checklist_item_id` is a PLAIN
--     `REFERENCES ticket_checklist_items(id) ON DELETE SET NULL`. It is NOT
--     composite, for the reason E2 recorded for target.device_id/ticket_id:
--     `ticket_checklist_items` is in TICKET_ORG_DENORMALIZED_TABLES
--     (services/ticketOrgMoveLockOrder.ts) and its org_id is re-stamped by
--     BOTH org movers (ticketService.ts moveTicketOrg's loop; routes/devices/
--     moveOrg.ts), while ai_operator_task_steps.org_id is immutable task
--     history anchored by ai_operator_task_steps_task_org_fk. A composite
--     (checklist_item_id, org_id) FK would therefore abort any ticket org-move
--     that touched a live human-work step with 23503. There is also no
--     ticket_checklist_items_id_org_uq index to point one at
--     (2026-10-16-190000-ticket-checklist-items.sql).
--     The correct treatment is the one E2 gave targets: DETACH, never
--     re-stamp. services/ticketService.ts (moveTicketOrg) and
--     services/orgMergeCustomExecutors.ts (fenceAiOperatorTasks) carry the
--     detach statements, and they are LOAD-BEARING, not mirrors.
--
--  B. `ticket_checklist_items.operator_step_id` CARRIES NO FOREIGN KEY.
--     Provenance only, exactly like source_template_item_id
--     (2026-10-16-190000-ticket-checklist-items.sql), and for a stronger
--     reason: after a move the two rows legitimately live in different orgs, so
--     no composite org FK is expressible, and the step row is erased with its
--     task while the item must keep saying where it came from. NEVER joined for
--     authorization — every read re-checks org_id explicitly.
--
--  C. TWO REMINDER COLUMNS. `remind_after_at` is when the step becomes
--     overdue; `reminded_at` is when the reconciler said so. The coordinator
--     tick runs every 15 s (jobs/aiOperatorTaskWorker.ts
--     COORDINATOR_TICK_INTERVAL_MS), so a single column would post a ticket
--     comment and a notification four times a minute, forever.
--
--  D. THE EVENT-TYPE CHECK IS RE-CREATED, NOT ALTERED. `ai_operator_task_events`
--     uses text + CHECK, never a pgEnum (Operator spec §11.1), so widening the
--     vocabulary is DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT with the full
--     fifteen-value list. The list below must stay byte-identical to
--     AI_OPERATOR_TASK_EVENT_TYPES in packages/shared/src/types/aiOperator.ts
--     and to the copy in db/schema/aiOperatorTaskGraph.ts; enumParity.test.ts
--     is what pins all three together.
--     The table is APPEND-ONLY with a BEFORE UPDATE/DELETE trigger, but a CHECK
--     constraint is DDL on the table, not a row write — the trigger does not
--     fire, and Postgres re-scans existing rows against the new CHECK, which
--     proves no shipped row is outside the widened list.
--
-- No rows are written by this file, so it elects no `breeze.scope` and must NOT
-- be added to migrationRlsScope.test.ts's frozen baseline. Idempotent
-- throughout. No inner BEGIN/COMMIT — autoMigrate wraps this file.
-- No per-table GRANT: breeze_app already holds SELECT/INSERT/UPDATE/DELETE on
-- both tables (2026-10-16-190000 and 2026-10-26-160000); a new column inherits
-- table-level privileges.

-- ---------------------------------------------------------------------------
-- 1. ai_operator_task_steps: the owning link and the reminder clock
-- ---------------------------------------------------------------------------

ALTER TABLE ai_operator_task_steps
  ADD COLUMN IF NOT EXISTS checklist_item_id uuid;
ALTER TABLE ai_operator_task_steps
  ADD COLUMN IF NOT EXISTS remind_after_at timestamptz;
ALTER TABLE ai_operator_task_steps
  ADD COLUMN IF NOT EXISTS reminded_at timestamptz;

-- Header note A: PLAIN, single-column, ON DELETE SET NULL.
ALTER TABLE ai_operator_task_steps
  DROP CONSTRAINT IF EXISTS ai_operator_task_steps_checklist_item_fk;
ALTER TABLE ai_operator_task_steps
  ADD CONSTRAINT ai_operator_task_steps_checklist_item_fk
  FOREIGN KEY (checklist_item_id) REFERENCES ticket_checklist_items (id)
  ON DELETE SET NULL;

-- Serves the wake path's "which step is this item's?" lookup and the org-move
-- detach. Literal partial predicate, never interpolated.
CREATE INDEX IF NOT EXISTS ai_operator_task_steps_checklist_item_idx
  ON ai_operator_task_steps (checklist_item_id)
  WHERE checklist_item_id IS NOT NULL;

-- The overdue-human-work scan (services/aiOperator/taskReconciler.ts, set 5).
-- Partial on exactly the rows it selects, so the sweep never reads a settled
-- step or a step with no reminder configured.
CREATE INDEX IF NOT EXISTS ai_operator_task_steps_human_work_remind_idx
  ON ai_operator_task_steps (remind_after_at)
  WHERE step_kind = 'human_work' AND state = 'waiting' AND reminded_at IS NULL;

-- Only a human_work step may name a checklist item. Without this, an `effect`
-- step could carry one and the reminder sweep's partial index would silently
-- disagree with the wake path's lookup about which rows are human work.
ALTER TABLE ai_operator_task_steps
  DROP CONSTRAINT IF EXISTS ai_operator_task_steps_checklist_kind_chk;
ALTER TABLE ai_operator_task_steps
  ADD CONSTRAINT ai_operator_task_steps_checklist_kind_chk
  CHECK (checklist_item_id IS NULL OR step_kind = 'human_work');

COMMENT ON COLUMN ai_operator_task_steps.checklist_item_id IS
  'The ticket_checklist_items row a human_work step is waiting on (recipe spec §5.3). THE owning pointer of the link; the reverse column on the item is provenance with no FK. Plain single-column FK on purpose: the item''s org_id is re-stamped by both org movers while this row''s is immutable, so a composite org FK would 23503 the move. NULL means the link was detached (org move, org merge, or the item was erased) and the task must hand off.';
COMMENT ON COLUMN ai_operator_task_steps.remind_after_at IS
  'When a waiting human_work step becomes overdue (recipe spec §6.5). The reconciler posts ONE internal ticket comment and ONE notification and stamps reminded_at; past the TASK deadline the task hands off rather than failing.';
COMMENT ON COLUMN ai_operator_task_steps.reminded_at IS
  'When the overdue reminder was sent. Separate from remind_after_at because the coordinator tick runs every 15 s.';

-- ---------------------------------------------------------------------------
-- 2. ticket_checklist_items: the provenance pointer (header note B)
-- ---------------------------------------------------------------------------

ALTER TABLE ticket_checklist_items
  ADD COLUMN IF NOT EXISTS operator_step_id uuid;

COMMENT ON COLUMN ticket_checklist_items.operator_step_id IS
  'The ai_operator_task_steps row that created this item, for source = ''operator_task'' (recipe spec §5.3). PROVENANCE ONLY, deliberately NO FK — same ruling as source_template_item_id, for a stronger reason: after a ticket org-move the two rows legitimately live in different orgs, so no composite org FK is expressible, and the step is erased with its task. Every reader re-checks org_id explicitly; this column is NEVER joined for authorization.';

-- ---------------------------------------------------------------------------
-- 3. ai_operator_task_events: the fifteenth event type (header note D)
-- ---------------------------------------------------------------------------

ALTER TABLE ai_operator_task_events
  DROP CONSTRAINT IF EXISTS ai_operator_task_events_event_type_chk;
ALTER TABLE ai_operator_task_events
  ADD CONSTRAINT ai_operator_task_events_event_type_chk CHECK (event_type IN (
    'task_admitted', 'lease_claimed', 'step_opened', 'step_settled',
    'wait_entered', 'wait_resolved', 'target_attached', 'target_detached',
    'target_account_frozen', 'operation_reserved', 'operation_settled',
    'verification_recorded', 'plan_revision_bumped', 'human_work_unticked',
    'task_settled'
  ));
