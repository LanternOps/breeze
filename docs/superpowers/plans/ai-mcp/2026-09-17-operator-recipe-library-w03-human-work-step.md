---
tracking_issue: PENDING
---

# Operator Recipe Library — Wave E3: human-work steps bound to ticket checklist items, and the `maintenance_window` wait writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The AI Operator gains the two step kinds that make a multi-day MSP procedure possible and that E2 shipped as CHECK-list values with no writer: `human_work` and `wait`. A `human_work` step creates a real `ticket_checklist_items` row on the task's ticket (`source = 'operator_task'`), yields to `waiting(information)` with `wait_dependency_kind = 'user_answer'` and dependency id = the checklist item id, and is woken when a **human** ticks that item — the Operator creates items and never completes them, enforced by a contract test rather than by review. A task that needs a human-work step and has no ticket gets one at admission-time of the step, as a `ticket` target row (E2's substrate), not a new column. A `wait` step writes `next_wake_at = scheduledAt` for `maintenance_window` and is woken by the existing poller. Un-ticking after the task advanced records an event and never rewinds; deleting a checklist item while its step waits is a 409; a ticket org-move or an org merge detaches the link and the task hands off instead of waiting forever on a row in another tenant.

**Architecture:** Two migrations — one that adds the `operator_task` label to the shipped `ticket_checklist_item_source` pgEnum and does nothing else, and one that adds the link columns, the reminder clock and the new event type. **One owning foreign key**: the STEP row owns the link (`ai_operator_task_steps.checklist_item_id`, a plain `ON DELETE SET NULL` FK), and `ticket_checklist_items.operator_step_id` is provenance with no FK — the same ruling `source_template_item_id` already carries, for a stronger reason (D1). One new service, `services/aiOperator/humanWorkService.ts`, owns every human-work write and takes a caller-supplied `DbHandle` exactly like E2's `eventService`/`stepService`/`taskOutbox`. `ticketChecklistService.patchChecklistItem` gains one call into it, inside the request's existing transaction, so the outbox wake and the `done_at` stamp commit together. `taskCoordinator.ts` gains two GENERIC advancers (`advanceHumanWork`, `advanceWait`) reached through a new kind-keyed fallback table beside E1's `RECIPE_ADVANCERS` — spec §6.1's "step execution by kind is coordinator code" taken literally, because these two kinds have exactly one implementation across every recipe. The reconciler's 15 s tick gains a fifth scan for overdue human work.

**Tech Stack:** TypeScript, Hono, Drizzle ORM + hand-written SQL migrations (forced RLS, PostgreSQL 16), Zod (`packages/shared`), Vitest (unit + `vitest.integration.config.ts` against real Postgres), React + Astro islands (`apps/web`), i18next.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-operator-recipe-library-design.md` — §5.3 (the `checklist_item_id` column and the `ticket_checklist_items` deltas: the fourth `source` value, the nullable `operator_step_id`, and the "`ALTER TYPE … ADD VALUE IF NOT EXISTS` in its own migration, sorted ahead of any file that uses the value" rule), §6.1's step-kind table rows `human_work` ("create or attach checklist item", wait `information`/`user_answer`) and `wait` ("write `next_wake_at`", wait `maintenance_window`), §6.5 in full (the human-work contract, the ticket requirement, `patchChecklistItem` stays human-only, reminders, un-check does not rewind), §6.3 (`wait_cutoff` is the first `wait` step), §10 row **E3** ("Human-work step + checklist linkage; `maintenance_window` writer. Depends on E2"). Builds on `docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-completion-design.md` §6.3 (wake path, "never trust the wake payload"), §7.3 (a stopped task says what it did and did not do), §11 (step rows, event timeline).

**Feature tracking:** parent issue and wave sub-issue assigned by `register_feature` after all wave plans exist; branch `feature/<parent#>-operator-recipe-library/wave-<subissue#>`.

---

## Decisions recorded for the orchestrator (deviations from the spec and the wave brief, each with the evidence that forced it)

1. **ONE owning FK, and it is NOT the one spec §5.3 describes. `ai_operator_task_steps.checklist_item_id` is a PLAIN `REFERENCES ticket_checklist_items(id) ON DELETE SET NULL` — not composite — and `ticket_checklist_items.operator_step_id` carries NO foreign key at all.** Spec §5.3 asks for composite FKs in BOTH directions ("composite `(checklist_item_id, org_id) → ticket_checklist_items`" on the step, and on the item "this one is a real composite FK, `ON DELETE SET NULL`"). Two owning FKs between two tables is a cycle, and each of them independently breaks against the real code:
   - **The item's `org_id` is MUTABLE; the step's is immutable task history.** `ticket_checklist_items` is a member of `TICKET_ORG_DENORMALIZED_TABLES` (`apps/api/src/services/ticketOrgMoveLockOrder.ts:139`) and is re-stamped by BOTH org movers — `moveTicketOrg`'s loop (`apps/api/src/services/ticketService.ts:2868-2872`) and the device axis (`apps/api/src/routes/devices/moveOrg.ts:892`). `ai_operator_tasks.org_id` and therefore `ai_operator_task_steps.org_id` are immutable (`apps/api/src/db/schema/aiOperatorTasks.ts` header; E2's `ai_operator_task_steps_task_org_fk`). A composite `(checklist_item_id, org_id)` FK would therefore abort every ticket org-move that touched a live human-work step with 23503. This is verbatim the reasoning E2 recorded as its decision 3 for `target.device_id`/`target.ticket_id`.
   - **The target tuple does not exist.** There is no `ticket_checklist_items_id_org_uq` index — the table has only `ticket_checklist_items_ticket_pos_idx` and `ticket_checklist_items_org_idx` (`apps/api/migrations/2026-10-16-190000-ticket-checklist-items.sql:73-76`). A composite FK would first have to create one.
   - **The reverse pointer must survive its referent.** `operator_step_id` is provenance shown on the ticket page; the step row is erased with its task. `source_template_item_id` already carries exactly this no-FK ruling for exactly this reason (`apps/api/src/db/schema/ticketChecklists.ts:35-39`: "Provenance only, deliberately NO FK … Never joined for authorization"), and the Operator's case is strictly stronger because the two rows' `org_id` values can legitimately diverge after a move.
   Consequence, and it is the point: **the link is detached, never re-stamped**, exactly as E2 ruled for targets. The detach is hand-written in `moveTicketOrg` and is LOAD-BEARING, not a mirror of anything (D5).
2. **Migration A needs NO `-- @no-transaction` directive.** `autoMigrate` wraps each file in one transaction (`apps/api/src/db/autoMigrate.ts:726`) and supports an opt-out (`isNoTransaction`, `:184-194`). `ALTER TYPE … ADD VALUE` has been legal inside a transaction block since PostgreSQL 12; what is illegal is *using* the new label in the same transaction. The established repo pattern is therefore "enum add ONLY, in its own file", stated verbatim in `apps/api/migrations/2026-10-17-110700-report-type-identity-access-review.sql:1-5` and again in `2026-10-14-100100-discovered-assets-manual-source.sql:17-19`. Neither file carries the directive. Migration A follows them. The directive exists for `CREATE INDEX CONCURRENTLY`, not for this.
3. **The task's ticket is an E2 `ticket` TARGET ROW, not a new `ai_operator_tasks` column.** Verified: the string "ticket" does not appear as a column anywhere in `apps/api/src/db/schema/aiOperatorTasks.ts` — only as the `'ticket'` literal inside `originKind`'s union (`:148`) and as `'ticket_comment'` in `AI_OPERATOR_EXECUTION_REF_KINDS` (`:110`). No aiOperator service imports `ticketService` today. E2 ships `ai_operator_task_targets.target_kind = 'ticket'` with a plain `ticket_id` FK, which is precisely this pointer. Using it means **this wave adds no column to `ai_operator_tasks`**, so `CORE_TENANT_EXPORT_POLICY` does not re-fire for that table.
4. **`remind_after_at` and `reminded_at` are new columns on `ai_operator_task_steps`.** Spec §6.5 says "a human-work step past its `remind_after`", but E2's step table has no such column (its column list is fixed in `apps/api/migrations/2026-10-18-100000-ai-operator-task-graph.sql` section 5). Two columns, not one: without `reminded_at` the 15 s reconciler tick would post a ticket comment every 15 seconds for the life of the step.
5. **On ticket org-move and org merge the mover NULLs the link and enqueues a `user_answer` wake; it does NOT settle the step itself.** Settling a task from inside `moveTicketOrg`'s transaction would put coordinator state machine logic in the ticket service and would write a task transition with no lease. Nulling the link and waking is enough, because the coordinator's re-read (invariant 2, `taskCoordinator.ts:12-20`) then finds a step whose `checklist_item_id` is null and hands the task off with a readable reason. Same statement covers org merge, where `fenceAiOperatorTasks` (E2) is the second backstop; E2's own finding — contacts are repointed on merge, so fences detach in the RESOLVE phase — applies unchanged to this link.
6. **The `user_answer` outbox `transitionSeq` is the fixed ordinal `1`.** `taskOutbox.ts`'s two shipped schemes (`RUN_TERMINAL_OUTBOX_TRANSITION_SEQ:92-99`, `INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ:127-133`) are fixed "terminal status ordinals" chosen so redelivery collapses onto one row. A checklist item reaching `done` is terminal *for the step*: the step settles on the first wake and `advanceTask` re-enters at the NEXT step, so a re-tick after an untick produces a wake that finds the step already settled and is a no-op. The `sourceId` is the **checklist item id**, so two different human-work steps on one task never collide.
7. **`human_work` and `wait` are dispatched by KIND, through a new `KIND_ADVANCERS` fallback beside E1's per-recipe `RECIPE_ADVANCERS`.** E1's table is keyed `[recipeKey][stepKey]` because `reason`/`effect`/`probe`/`document` genuinely differ per recipe. These two do not: "create or attach a checklist item and wait for a human" and "sleep until a timestamp" have one implementation for every recipe that will ever exist, and a per-recipe entry would be copy-paste that eventually diverges. The lookup stays `RECIPE_ADVANCERS[recipe.key]?.[stepKey]` FIRST, so a recipe can still override; only when that misses does the coordinator consult `recipe.steps[stepKey].kind`. `service_recovery` declares neither kind, so **its dispatch is bit-for-bit unchanged** and E1's and E2's behaviour-identical contracts hold.
8. **`advanceHumanWork` and `advanceWait` are EXPORTED from `taskCoordinator.ts`.** They need the module-private writers (`writeLeased`, `yieldToWait`, `settle`, `writeLeasedStep`) so they cannot move out, and no recipe in this build declares a `human_work` or `wait` step, so the only way to drive them against real Postgres is to call them directly from the integration suite with a locally-constructed `RecipeDefinition<never>` fixture. An un-exercisable branch is an unshipped branch.
9. **The import direction is `ticketChecklistService → humanWorkService`, one way.** `humanWorkService.ts` writes `ticketChecklistItems` through the Drizzle table directly (including its own four-line `MAX(position) + 1`), rather than calling `addChecklistItem`, specifically so the two modules do not import each other. `addChecklistItem` also hardcodes `source: 'manual'` (`ticketChecklistService.ts:138`) and stamps `createdBy: actor.userId`, neither of which is right for an Operator-created row.
10. **A `human_work` step past the task deadline HANDS OFF; every other step keeps failing `unresolved`.** Spec §6.5's "past the task deadline the task hands off, it does not fail" cannot be applied to the whole deadline branch — `advanceTask:419-436` is shipped behaviour that `aiOperatorCoordinator.integration.test.ts` pins for `service_recovery`. The branch gains one extra condition, reached only when the current step's kind is `human_work`.
11. **The wait's scheduled time and the successor step key live in the TASK CHECKPOINT, as two new optional fields (`waitUntil`, `resumeStepKey`).** A `wait` step has no model output to read a time from, and a `human_work`/`wait` step's successor is recipe-owned knowledge the generic advancer cannot derive: `permittedNextSteps` describes what the MODEL may propose, which is exactly the wrong question here. The step that transitions INTO the wait writes both, through the existing `writeLeasedStep(…, checkpoint)` call it already makes. Absence is a recipe bug and is settled `fail`/`unresolved` with a named detail — never guessed.
12. **One new event type, `human_work_unticked`.** E2's fourteen `AI_OPERATOR_TASK_EVENT_TYPES` have no truthful row for "a human cleared a tick after the task moved on". Reusing `step_settled` would record a settle that did not happen, on an APPEND-ONLY evidence table. Adding a value costs one line in `packages/shared`, one in the schema copy, one CHECK re-creation in Migration B, and one `enumParity.test.ts` assertion.

---

## Global Constraints

- **Rigor: high.** Tenancy (a cross-tenant pointer between a mutable-org table and an immutable-org table), migrations, an append-only evidence table, and the AI Operator's execution path. Red test first for every task. One independent code-review round before the PR.
- **Assume E1 and E2 have landed. Consume their identifiers; never redefine or rename one.**
  - From E1 (`apps/api/src/services/aiOperator/recipes/`): `RecipeDefinition`, `StepDefinition` (with `.kind: StepKind` and `.phase: TaskPhase`), `StepKind`, `STEP_KINDS`, `TargetKind`, `getRecipe(workflowKey, workflowVersion)`, `RECIPES`; and in `taskCoordinator.ts`: `resolveTaskRecipe`, `type StepAdvancer`, `const RECIPE_ADVANCERS`.
  - From E2: tables `ai_operator_task_targets`, `ai_operator_task_target_accounts`, `ai_operator_task_steps`, `ai_operator_task_events`; schema file `apps/api/src/db/schema/aiOperatorTaskGraph.ts` exporting `aiOperatorTaskSteps`, `aiOperatorTaskTargets`, `AI_OPERATOR_STEP_KINDS`, `AI_OPERATOR_STEP_STATES`, `AI_OPERATOR_TASK_EVENT_TYPES`, `AI_OPERATOR_EVENT_ACTOR_KINDS`, `AiOperatorStepKind`, `AiOperatorStepState`, `AiOperatorTaskEventType`; services `eventService.ts` (`appendTaskEvent`, `TaskEventActor`, `EventDbHandle`), `targetService.ts` (`createTaskTarget`, `TargetDbHandle`), `stepService.ts` (`openStep`, `markStepWaiting`, `settleStep`, `resolveStepKind`, `StepDbHandle`, `StepIdentity`); shared value lists in `packages/shared/src/types/aiOperator.ts`; and E2's **detach-never-re-stamp** rule for anything pointing at a task.
  - **If any of these is missing when a task runs, E1/E2 has not merged — STOP and report rather than inventing a local copy.**
- **Flag:** everything stays behind `AI_OPERATOR_TASKS_ENABLED` (`aiOperatorTasksEnabled()`, `apps/api/src/config/env.ts`). **This wave introduces no new env var**, so `.env.example`, `deploy/.env.example`, both compose files and `envComposeParity.test.ts` are untouched.
- **No new table.** `CORE_ORG_CASCADE_DELETE_ORDER`, `AUDIT_ADMIN_REQUIRED_TABLES`, `orgMergeRegistry.ts`, `DEVICE_DETACH_DEVICE_ID_TABLES`, `CORE_DEVICE_CASCADE_DELETE_TABLES` and `TICKET_ORG_DENORMALIZED_TABLES` gain **no new entry**. Task 4 proves that by re-deriving it, and it is NOT a licence to skip the export policy: **`ADD COLUMN` on an already-registered table re-fires `CORE_TENANT_EXPORT_POLICY`**, and this wave adds four columns across two registered tables.
- **`text` + CHECK, never `pgEnum`, for anything new on the aiOperator tables** (Operator spec §11.1). `ticket_checklist_items.source` is an existing pgEnum and stays one — Migration A extends it rather than converting it, because converting a shipped column type is a rewrite of a hot table for no safety gain here.
- **Migrations:** two files, `apps/api/migrations/2026-10-19-100000-ticket-checklist-operator-task-source.sql` (enum label only) and `apps/api/migrations/2026-10-19-100100-ai-operator-human-work-links.sql` (columns, index, CHECK). Newest committed migration at planning time is `2026-10-17-140000-snmp-metrics-instance-width.sql`; E2 introduces `2026-10-18-100000` and `2026-10-18-100100`. **Task 2 Step 1 re-runs `ls apps/api/migrations/*.sql | sort | tail -3` and renames BOTH files if anything sorts after `2026-10-19-100100`, keeping the slugs and the A-before-B relative order.** Shipped names in this repo run ahead of real time — never assume today's date sorts last. The pre-push hook re-checks against `origin/main` (`scripts/check-migration-naming.sh --against-ref origin/main`), so re-run the check before pushing.
- **Idempotent throughout** (`ADD COLUMN IF NOT EXISTS`, `ADD VALUE IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before each `ADD CONSTRAINT`, `CREATE INDEX IF NOT EXISTS`). **No inner `BEGIN`/`COMMIT`.** Neither migration writes a row, so neither elects `breeze.scope` and neither may be added to `migrationRlsScope.test.ts`'s frozen 122-offender baseline. **Never edit a shipped migration.**
- **Mind the caught-23505/23503 trap.** A unique or FK violation raised inside a request transaction ABORTS the whole transaction, so a caught error surfaces as a 500 (memory: `pg_unique_violation_inside_request_tx_surfaces_as_500`). Every refusal in this wave is a PRE-CHECK against rows — the delete guard, the kind/pointer checks, the org-match re-read — with the constraint as backstop, never as control flow. No `SAVEPOINT` is introduced.
- **No `db.transaction()` is added on the request path.** `withDbAccessContext` already runs the request in one Postgres transaction (`apps/api/src/db/index.ts:742-753`) and the bare `db` proxy joins it, so `patchChecklistItem`'s guarded UPDATE and the outbox enqueue are already atomic. Adding a nested transaction is the double-connection-hold pattern this repo has been bitten by.
- **Tests:** file beside source. One file: `cd apps/api && npx vitest run src/path/file.test.ts` — **never** `pnpm --filter … test -- --run <path>` (pnpm forwards the literal `--`, vitest swallows `--run` as a positional and runs the whole 1,470-file suite in watch mode). Web: `cd apps/web && npx vitest run src/path/file.test.tsx`. Shared: `cd packages/shared && npx vitest run src/path/file.test.ts`. Integration: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>` with a live stack (`pnpm test-stack up` at the repo root; `pnpm test-stack down` when finished — nothing does this for you). **Integration tests MUST live under `apps/api/src/__tests__/integration/`** — a wrongly placed one runs ZERO tests and reads green. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`. **A 0-test run is a stall, not a pass — always read the reported file/test counts.**
- **Web:** mutations go through `runClientAction`/`runAction`; UI state in `window.location.hash`; **every new i18n key needs a real translation in all 8 locale directories** (`de-DE`, `en`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` under `apps/web/src/locales/`), not an English copy. Task 10 is the explicit MOUNT task.
- **Commits:** one per task, every commit message ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. The final task opens the PR with `Closes #<wave sub-issue>` and **STOPS** — never merge, never `--admin`.

---

## File Structure

**packages/shared — modified**
- `src/validators/ticketChecklists.ts:19` — `CHECKLIST_ITEM_SOURCES` gains `'operator_task'`.
- `src/types/aiOperator.ts` — `AI_OPERATOR_TASK_EVENT_TYPES` gains `'human_work_unticked'`.
- `src/validators/aiOperator.ts` — `taskCheckpointSchema` gains optional `waitUntil` and `resumeStepKey`.
- `src/validators/ticketChecklists.test.ts` (new), `src/types/aiOperator.test.ts` (extend E2's), `src/validators/aiOperator.test.ts` (extend).

**apps/api — data**
- Create `migrations/2026-10-19-100000-ticket-checklist-operator-task-source.sql`.
- Create `migrations/2026-10-19-100100-ai-operator-human-work-links.sql`.
- Modify `src/db/schema/ticketChecklists.ts:17-21` (enum value), `:51` (new `operatorStepId` column).
- Modify `src/db/schema/aiOperatorTaskGraph.ts` — `aiOperatorTaskSteps.checklistItemId`, `.remindAfterAt`, `.remindedAt`; `AI_OPERATOR_TASK_EVENT_TYPES` copy.
- Modify `src/services/tenantExportPolicyRegistry.ts` — `ticket_checklist_items` + `ai_operator_task_steps` column lists.
- Modify `src/services/aiOperator/enumParity.test.ts`.

**apps/api — services**
- Create `src/services/aiOperator/humanWorkService.ts`, `humanWorkService.test.ts`, `humanWorkPurity.test.ts`.
- Modify `src/services/ticketChecklistService.ts` — `listChecklist` join, `patchChecklistItem` wake, `deleteChecklistItem` guard.
- Modify `src/services/aiOperator/taskCoordinator.ts` — `KIND_ADVANCERS`, `advanceHumanWork`, `advanceWait`, deadline handoff.
- Modify `src/services/aiOperator/taskReconciler.ts` — the fifth scan.
- Modify `src/services/ticketService.ts` (`moveTicketOrg`, beside the `aiAgentRuns.ticketId` sever at ~:2765) — the link detach.
- Modify `src/services/orgMergeCustomExecutors.ts` (`fenceAiOperatorTasks`) — the merge-side detach.

**apps/web**
- Modify `src/lib/api/ticketChecklist.ts` (`ChecklistItem` gains `operatorTaskId`).
- Modify `src/components/tickets/TicketChecklistCard.tsx` (the badge + link in the item `<li>`).
- Modify `src/components/tickets/TicketChecklistCard.test.tsx`, `src/components/deliverables/OccurrenceDrawer.test.tsx`.
- Modify `src/locales/<8 locales>/checklists.json`.

**apps/api — integration tests (all new, all under `src/__tests__/integration/`)**
- `aiOperatorHumanWorkStep.integration.test.ts`
- `aiOperatorHumanWorkTenancy.integration.test.ts`

---

### Task 1: Shared value lists — the fourth checklist source, the new event type, and the two checkpoint fields

**Files:**
- Modify: `packages/shared/src/validators/ticketChecklists.ts:19`
- Modify: `packages/shared/src/types/aiOperator.ts` (E2's `AI_OPERATOR_TASK_EVENT_TYPES`)
- Modify: `packages/shared/src/validators/aiOperator.ts` (`taskCheckpointSchema`)
- Create: `packages/shared/src/validators/ticketChecklists.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CHECKLIST_ITEM_SOURCES` including `'operator_task'` (and therefore `ChecklistItemSource`); `AI_OPERATOR_TASK_EVENT_TYPES` including `'human_work_unticked'`; `TaskCheckpoint.waitUntil?: string`, `TaskCheckpoint.resumeStepKey?: string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/validators/ticketChecklists.test.ts
/**
 * Recipe Library spec §5.3: `ticket_checklist_items.source` gains a fourth
 * value, `operator_task`.
 *
 * Asserted as an ORDERED list of VALUES, not merely as a type: this array is
 * the single source for the `ticket_checklist_item_source` pgEnum
 * (apps/api/src/db/schema/ticketChecklists.ts:17), for the API's zod
 * validation, and for the web badge. A type-only union cannot be diffed
 * against the database label list that migration A adds.
 *
 * ORDER MATTERS AND IS APPEND-ONLY. Postgres enum labels have an ordinal, and
 * `ALTER TYPE ... ADD VALUE` without BEFORE/AFTER appends. Re-ordering this
 * array would make the Drizzle pgEnum declaration disagree with the shipped
 * type's label order, which `db:check-drift` reports and which no unit test
 * would otherwise catch.
 */
import { describe, expect, it } from 'vitest';
import { CHECKLIST_ITEM_SOURCES, checklistItemSourceSchema } from './ticketChecklists';

describe('CHECKLIST_ITEM_SOURCES (recipe spec §5.3)', () => {
  it('is exactly the four shipped values, with operator_task appended last', () => {
    expect([...CHECKLIST_ITEM_SOURCES]).toEqual([
      'manual',
      'deliverable',
      'checklist_template',
      'operator_task',
    ]);
  });

  it('accepts operator_task through the zod schema', () => {
    expect(checklistItemSourceSchema.parse('operator_task')).toBe('operator_task');
  });

  it('still rejects anything else', () => {
    expect(() => checklistItemSourceSchema.parse('operator')).toThrow();
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd packages/shared && npx vitest run src/validators/ticketChecklists.test.ts`
Expected: FAIL — the first case reports the three-value array (`['manual','deliverable','checklist_template']`), the second throws.

- [ ] **Step 3: Extend the three shared lists**

`packages/shared/src/validators/ticketChecklists.ts` — replace line 19:

```ts
/**
 * `ticket_checklist_items.source`. APPEND-ONLY: these are Postgres enum labels
 * with ordinals, added by migration, and a shipped label can never be removed.
 *
 * `operator_task` (Recipe Library spec §5.3, wave E3) marks a step an AI
 * Operator `human_work` step created and is waiting on. The Operator CREATES
 * such rows and never completes them — completion stays a human attestation
 * (§6.5), enforced by `apps/api/src/services/aiOperator/humanWorkPurity.test.ts`.
 */
export const CHECKLIST_ITEM_SOURCES = [
  'manual',
  'deliverable',
  'checklist_template',
  'operator_task',
] as const;
```

`packages/shared/src/types/aiOperator.ts` — inside E2's `AI_OPERATOR_TASK_EVENT_TYPES` array, append one entry immediately before `'task_settled'`:

```ts
  /**
   * A human cleared the tick on an `operator_task` checklist item AFTER the
   * step that created it had already settled (recipe spec §6.5: "Un-checking
   * an item after the task advanced writes an event and does not rewind").
   *
   * Its own value rather than a reused `step_settled`: this table is APPEND-ONLY
   * evidence, and recording a settle that did not happen is a false entry in
   * the record a technician reads to understand what the Operator did.
   */
  'human_work_unticked',
```

`packages/shared/src/validators/aiOperator.ts` — inside `taskCheckpointSchema`'s object, append two optional fields:

```ts
  /**
   * When a `wait` step may resume (recipe spec §6.1's `wait` row, §6.3's
   * `wait_cutoff`). ISO-8601. Written by the step that transitions INTO the
   * wait, read by the coordinator's generic `advanceWait`.
   */
  waitUntil: z.string().datetime().optional(),
  /**
   * The step key the coordinator moves to when the current `wait` or
   * `human_work` step settles.
   *
   * NOT derivable from `permittedNextSteps`: that map says what the MODEL may
   * propose, and a human-work or timed wait has no model output at all. The
   * recipe's spine owns the successor, so the step that enters the wait states
   * it. Absent is a recipe bug and is refused loudly, never guessed.
   */
  resumeStepKey: z.string().min(1).max(128).optional(),
```

- [ ] **Step 4: Extend the two E2 suites that pin these lists**

In `packages/shared/src/types/aiOperator.test.ts`, inside the existing `'event types are unique and cover every task-affecting transition'` case, add `'human_work_unticked'` to the `required` array.

In `packages/shared/src/validators/aiOperator.test.ts`, add:

```ts
  it('taskCheckpointSchema carries the wait fields E3 added, and rejects a non-ISO waitUntil', () => {
    const base = taskCheckpointSchema.parse({ recipeInput: { deviceId: '00000000-0000-4000-8000-000000000001', serviceName: 'spooler' } });
    expect(base.waitUntil).toBeUndefined();
    expect(base.resumeStepKey).toBeUndefined();
    const withWait = taskCheckpointSchema.parse({
      ...base, waitUntil: '2026-10-19T17:00:00.000Z', resumeStepKey: 'discover',
    });
    expect(withWait.waitUntil).toBe('2026-10-19T17:00:00.000Z');
    expect(withWait.resumeStepKey).toBe('discover');
    expect(() => taskCheckpointSchema.parse({ ...base, waitUntil: 'friday' })).toThrow();
  });
```

> If `taskCheckpointSchema.parse` in the repo requires fields this snippet omits, build `base` from whatever the existing suite's own fixture uses — do not weaken the schema to fit the test.

- [ ] **Step 5: Run all three green**

Run: `cd packages/shared && npx vitest run src/validators/ticketChecklists.test.ts src/types/aiOperator.test.ts src/validators/aiOperator.test.ts`
Expected: PASS — 3 files. Then `cd packages/shared && npx tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 6: Commit**

```
git add packages/shared/src/validators/ticketChecklists.ts packages/shared/src/validators/ticketChecklists.test.ts packages/shared/src/types/aiOperator.ts packages/shared/src/types/aiOperator.test.ts packages/shared/src/validators/aiOperator.ts packages/shared/src/validators/aiOperator.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): operator_task checklist source, human_work_unticked event, wait checkpoint fields (E3)

Recipe Library spec §5.3 and §6.5. Append-only enum growth; the two
checkpoint fields carry a wait's scheduled time and its successor step,
which permittedNextSteps deliberately cannot express.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration A — the `operator_task` enum label, alone in its own file

**Files:**
- Create: `apps/api/migrations/2026-10-19-100000-ticket-checklist-operator-task-source.sql`
- Modify: `apps/api/src/db/schema/ticketChecklists.ts:17-21`

**Interfaces:**
- Consumes: the shipped type `public.ticket_checklist_item_source`.
- Produces: the label `'operator_task'` on that type; `ticketChecklistItemSourceEnum` carrying it.

- [ ] **Step 1: Re-check the migration slot BEFORE writing the file**

Run: `ls apps/api/migrations/*.sql | sort | tail -3`
Expected at planning time (with E2 merged): the newest is `2026-10-18-100100-ai-operator-inline-target-backfill.sql`. If anything sorts at or after `2026-10-19-100000`, rename **both** this file and Task 3's, keeping the slugs and keeping A strictly before B. Never assume today's date sorts last.

- [ ] **Step 2: Write the migration**

```sql
-- apps/api/migrations/2026-10-19-100000-ticket-checklist-operator-task-source.sql
--
-- Recipe Library wave E3, spec §5.3: `ticket_checklist_items.source` gains a
-- fourth value. An `operator_task` row is a step an AI Operator `human_work`
-- step created on the task's ticket and is waiting on.
--
-- ENUM ADD ONLY, IN ITS OWN FILE, AND THAT IS THE WHOLE POINT OF THE FILE.
-- A label added by ALTER TYPE cannot be USED until the transaction that added
-- it commits, and autoMigrate wraps each file in exactly one transaction
-- (src/db/autoMigrate.ts:726). The next migration
-- (2026-10-19-100100-ai-operator-human-work-links.sql) is the first file that
-- may reference the label, and it sorts strictly after this one.
--
-- NO `-- @no-transaction` DIRECTIVE. ALTER TYPE ... ADD VALUE has been legal
-- inside a transaction block since PostgreSQL 12; only USING the new label in
-- the same transaction is forbidden, and this file uses nothing. The directive
-- (autoMigrate.ts:184-194) exists for CREATE INDEX CONCURRENTLY. Precedent for
-- this exact shape: 2026-10-17-110700-report-type-identity-access-review.sql
-- and 2026-10-16-180700-report-type-hardware-lifecycle.sql.
--
-- No rows are written, so no `breeze.scope` election is required and this file
-- must NOT be added to migrationRlsScope.test.ts's frozen baseline. Idempotent.

ALTER TYPE public.ticket_checklist_item_source ADD VALUE IF NOT EXISTS 'operator_task';
```

- [ ] **Step 3: Extend the Drizzle enum declaration**

`apps/api/src/db/schema/ticketChecklists.ts` — replace lines 17-21:

```ts
/**
 * Label order mirrors the shipped type's ordinals exactly, and is APPEND-ONLY:
 * 'manual'/'deliverable'/'checklist_template' from
 * 2026-10-16-190000-ticket-checklist-items.sql, then 'operator_task' from
 * 2026-10-19-100000-ticket-checklist-operator-task-source.sql. Single-sourced
 * in spirit from `CHECKLIST_ITEM_SOURCES` (@breeze/shared) — the two are pinned
 * together by packages/shared/src/validators/ticketChecklists.test.ts and by
 * `pnpm db:check-drift`.
 */
export const ticketChecklistItemSourceEnum = pgEnum('ticket_checklist_item_source', [
  'manual',
  'deliverable',
  'checklist_template',
  'operator_task',
]);
```

- [ ] **Step 4: Apply against a live database and prove the label landed**

Run (repo root): `pnpm test-stack up`
Then apply the migrations the way this worktree does (`grep -n '"db:migrate"' apps/api/package.json` and run that script with `DATABASE_URL` from `.env.test`).
Then:

```
docker exec -i "$(docker compose -f docker-compose.test.yml ps -q postgres)" \
  psql -U breeze -d breeze -c \
  "SELECT enumlabel, enumsortorder FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ticket_checklist_item_source' ORDER BY enumsortorder;"
```
Expected: four rows, `operator_task` last. Re-running the migration runner is a clean no-op.

- [ ] **Step 5: Run the migration guards**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS, with **neither new file added to the RLS-scope baseline**.

- [ ] **Step 6: Commit**

```
git add apps/api/migrations/2026-10-19-100000-ticket-checklist-operator-task-source.sql apps/api/src/db/schema/ticketChecklists.ts
git commit -m "$(cat <<'EOF'
feat(api): ticket_checklist_item_source gains operator_task (E3)

Enum add only, in its own file: a label added by ALTER TYPE cannot be used
until its transaction commits, and autoMigrate wraps each file in one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration B — the link columns, the reminder clock, the new event label

**Files:**
- Create: `apps/api/migrations/2026-10-19-100100-ai-operator-human-work-links.sql`
- Modify: `apps/api/src/db/schema/ticketChecklists.ts` (the `operatorStepId` column)
- Modify: `apps/api/src/db/schema/aiOperatorTaskGraph.ts` (three step columns + the event-type list)
- Modify: `apps/api/src/services/aiOperator/enumParity.test.ts`
- Create: `apps/api/src/db/schema/aiOperatorHumanWork.test.ts`

**Interfaces:**
- Consumes: `ticket_checklist_items`, `ai_operator_task_steps`, `ai_operator_task_events` (E2).
- Produces: columns `ticket_checklist_items.operator_step_id`, `ai_operator_task_steps.checklist_item_id`, `.remind_after_at`, `.reminded_at`; index `ai_operator_task_steps_checklist_item_idx`; the widened `ai_operator_task_events_event_type_chk`; Drizzle columns `ticketChecklistItems.operatorStepId`, `aiOperatorTaskSteps.checklistItemId` / `.remindAfterAt` / `.remindedAt`.

- [ ] **Step 1: Write the failing schema test**

```ts
// apps/api/src/db/schema/aiOperatorHumanWork.test.ts
/**
 * Recipe Library spec §5.3, wave E3 — the human-work link, asserted from the
 * DRIZZLE SCHEMA rather than from a live database so it fails in the unit job
 * (`Test API`) rather than only under `Integration Tests`.
 *
 * WHAT THIS FILE IS REALLY GUARDING is decision D1: ONE owning FK, and it is
 * the STEP's. The reverse pointer is provenance with no reference at all,
 * because `ticket_checklist_items.org_id` is re-stamped by both org movers
 * (services/ticketOrgMoveLockOrder.ts:139) while `ai_operator_task_steps.org_id`
 * is immutable task history — so a composite org FK in either direction would
 * abort a ticket org-move with 23503. If a later change adds a `.references()`
 * to `operatorStepId`, this suite is what says no.
 */
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { ticketChecklistItems } from './ticketChecklists';
import { aiOperatorTaskSteps } from './aiOperatorTaskGraph';

describe('human-work link columns (recipe spec §5.3)', () => {
  it('the STEP carries the owning pointer at the checklist item', () => {
    const columns = getTableConfig(aiOperatorTaskSteps).columns.map((c) => c.name);
    expect(columns).toContain('checklist_item_id');
  });

  it('the step carries its own reminder clock, with a separate sent-stamp', () => {
    const columns = getTableConfig(aiOperatorTaskSteps).columns.map((c) => c.name);
    // Two columns, not one: the reconciler tick runs every 15 s, so without a
    // sent-stamp an overdue step would post a ticket comment four times a
    // minute for the life of the step.
    expect(columns).toContain('remind_after_at');
    expect(columns).toContain('reminded_at');
  });

  it('the checklist item carries the reverse pointer as PROVENANCE, with no FK', () => {
    const config = getTableConfig(ticketChecklistItems);
    expect(config.columns.map((c) => c.name)).toContain('operator_step_id');
    // Same ruling as source_template_item_id (ticketChecklists.ts:35-39), for a
    // stronger reason: after a ticket org-move the two rows legitimately live
    // in different orgs, so no composite org FK is even expressible.
    const referenced = config.foreignKeys.flatMap((fk) =>
      fk.reference().columns.map((c) => c.name),
    );
    expect(referenced).not.toContain('operator_step_id');
  });

  it('never gives the step link a COMPOSITE org FK — that would 23503 every ticket org-move', () => {
    const composite = getTableConfig(aiOperatorTaskSteps).foreignKeys.filter((fk) => {
      const names = fk.reference().columns.map((c) => c.name);
      return names.includes('checklist_item_id') && names.length > 1;
    });
    expect(composite).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/db/schema/aiOperatorHumanWork.test.ts`
Expected: FAIL — the first three cases report the columns missing.

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-10-19-100100-ai-operator-human-work-links.sql
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
--     (services/ticketOrgMoveLockOrder.ts:139) and its org_id is re-stamped by
--     BOTH org movers (ticketService.ts moveTicketOrg's loop; routes/devices/
--     moveOrg.ts:892), while ai_operator_task_steps.org_id is immutable task
--     history anchored by ai_operator_task_steps_task_org_fk. A composite
--     (checklist_item_id, org_id) FK would therefore abort any ticket org-move
--     that touched a live human-work step with 23503. There is also no
--     ticket_checklist_items_id_org_uq index to point one at
--     (2026-10-16-190000-ticket-checklist-items.sql:73-76).
--     The correct treatment is the one E2 gave targets: DETACH, never
--     re-stamp. services/ticketService.ts (moveTicketOrg) and
--     services/orgMergeCustomExecutors.ts (fenceAiOperatorTasks) carry the
--     detach statements, and they are LOAD-BEARING, not mirrors.
--
--  B. `ticket_checklist_items.operator_step_id` CARRIES NO FOREIGN KEY.
--     Provenance only, exactly like source_template_item_id
--     (2026-10-16-190000-ticket-checklist-items.sql:47-49), and for a stronger
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
--     fire and no existing row is re-validated destructively (Postgres does
--     re-scan existing rows against the new CHECK, which is what we want: it
--     proves no shipped row is outside the widened list).
--
-- No rows are written by this file, so it elects no `breeze.scope` and must NOT
-- be added to migrationRlsScope.test.ts's frozen baseline. Idempotent
-- throughout. No inner BEGIN/COMMIT — autoMigrate wraps this file.
-- No per-table GRANT: ensureAppRole.ts grants breeze_app on every public table
-- at boot (same note as 2026-10-16-190000).

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

-- Serves the wake path's "which step is this item's?" lookup and the
-- reconciler's overdue scan. Literal partial predicate, never interpolated.
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
```

- [ ] **Step 4: Add the Drizzle columns**

`apps/api/src/db/schema/ticketChecklists.ts` — insert immediately after `sourceTemplateItemId` (line 51):

```ts
  /**
   * The `ai_operator_task_steps` row that created this item, for
   * `source = 'operator_task'` (recipe spec §5.3). Provenance, NOT a
   * reference — see `sourceTemplateItemId` above for the shape and the
   * migration's header note B for why this one's case is stronger: after a
   * ticket org-move the step and the item legitimately live in different orgs.
   */
  operatorStepId: uuid('operator_step_id'),
```

`apps/api/src/db/schema/aiOperatorTaskGraph.ts` — inside `aiOperatorTaskSteps`, after `detail`:

```ts
  /**
   * THE owning pointer of the human-work link (recipe spec §5.3). Plain
   * single-column FK `ON DELETE SET NULL`, declared in SQL; the
   * `.references()` below exists for typing, matching this directory's
   * convention. NULL on a detached link, which is how the coordinator knows to
   * hand off instead of waiting on a row in another tenant.
   */
  checklistItemId: uuid('checklist_item_id').references(() => ticketChecklistItems.id, { onDelete: 'set null' }),
  /** Recipe spec §6.5 reminders. See the migration's header note C for why two columns. */
  remindAfterAt: timestamp('remind_after_at', { withTimezone: true }),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
```

and append `'human_work_unticked'` to that file's `AI_OPERATOR_TASK_EVENT_TYPES` copy, in the same position as in `packages/shared` (immediately before `'task_settled'`).

> Import direction check: `aiOperatorTaskGraph.ts` now imports `ticketChecklistItems` from `./ticketChecklists`. `ticketChecklists.ts` imports nothing from `aiOperatorTaskGraph.ts` and must not — the reverse pointer has no `.references()` precisely so it does not have to.

- [ ] **Step 5: Extend `enumParity.test.ts`**

Add one case to `apps/api/src/services/aiOperator/enumParity.test.ts`:

```ts
  it('the event-type list ends with human_work_unticked then task_settled, in all three copies', () => {
    // The third copy is the CHECK constraint in
    // migrations/2026-10-19-100100-ai-operator-human-work-links.sql section 3;
    // aiOperatorTaskGraphRls.integration.test.ts proves that one against the
    // live database. Here we pin the two TypeScript copies to each other.
    expect([...SCHEMA_AI_OPERATOR_TASK_EVENT_TYPES]).toEqual([...SHARED_AI_OPERATOR_TASK_EVENT_TYPES]);
    expect(SHARED_AI_OPERATOR_TASK_EVENT_TYPES).toContain('human_work_unticked');
    expect(SHARED_AI_OPERATOR_TASK_EVENT_TYPES.at(-1)).toBe('task_settled');
  });
```

using whatever alias names that file already binds for the two copies.

- [ ] **Step 6: Apply, prove, and run the guards**

Run the migration runner against the test stack as in Task 2 Step 4, then:

```
docker exec -i "$(docker compose -f docker-compose.test.yml ps -q postgres)" \
  psql -U breeze -d breeze -c \
  "SELECT conname FROM pg_constraint WHERE conname IN ('ai_operator_task_steps_checklist_item_fk','ai_operator_task_steps_checklist_kind_chk','ai_operator_task_events_event_type_chk');"
```
Expected: three rows.

Then prove D1 negatively — the FK must NOT be composite:

```
docker exec -i "$(docker compose -f docker-compose.test.yml ps -q postgres)" \
  psql -U breeze -d breeze -c \
  "SELECT conname, array_length(conkey,1) AS cols FROM pg_constraint WHERE conname = 'ai_operator_task_steps_checklist_item_fk';"
```
Expected: `cols = 1`. If it is 2, the migration was written against the spec rather than against the code — fix the migration.

Run: `cd apps/api && npx vitest run src/db/schema/aiOperatorHumanWork.test.ts src/services/aiOperator/enumParity.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS, 4 files.

Run: `pnpm db:check-drift` (with `DATABASE_URL` pointed at the test stack)
Expected: no drift. If it reports the enum label order, the Drizzle array in Task 2 Step 3 does not match the shipped ordinals — fix the array, never the shipped type.

- [ ] **Step 7: Commit**

```
git add apps/api/migrations/2026-10-19-100100-ai-operator-human-work-links.sql apps/api/src/db/schema/ticketChecklists.ts apps/api/src/db/schema/aiOperatorTaskGraph.ts apps/api/src/db/schema/aiOperatorHumanWork.test.ts apps/api/src/services/aiOperator/enumParity.test.ts
git commit -m "$(cat <<'EOF'
feat(api): human-work link columns, reminder clock and human_work_unticked (E3)

ONE owning FK and it is the step's, plain and single-column: the checklist
item's org_id is re-stamped by both org movers while the step's is immutable
task history, so a composite org FK would 23503 every ticket org-move.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The registration sweep — export policy re-fires on a COLUMN, cascade order re-derived

**Files:**
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:623` (`ticket_checklist_items`) and its `ai_operator_task_steps` entry (added by E2)

**Interfaces:**
- Consumes: `tablePolicy`.
- Produces: four newly classified columns.

**Read this before starting.** CLAUDE.md: *"The export-policy row is the only one that fires on a new column, not just a new table."* This wave adds no table, so `CORE_ORG_CASCADE_DELETE_ORDER`, `AUDIT_ADMIN_REQUIRED_TABLES`, `orgMergeRegistry.ts`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `DEVICE_DETACH_DEVICE_ID_TABLES`, `TICKET_ORG_DENORMALIZED_TABLES` and `CUSTOM_ORG_REWRITE_TABLES` are **not edited** — but that is a conclusion to re-derive, not to assume. Steps 1 and 2 re-derive it mechanically.

- [ ] **Step 1: Re-derive the "no new list entry" claim**

Run:
```
grep -n "'ticket_checklist_items'\|\"ticket_checklist_items\"" apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/ticketOrgMoveLockOrder.ts apps/api/src/routes/devices/core.ts
grep -n "'ai_operator_task_steps'\|\"ai_operator_task_steps\"" apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/routes/devices/core.ts
```
Expected: both tables already appear in `CORE_ORG_CASCADE_DELETE_ORDER` and in `orgMergeRegistry.ts` (the first from `#5783 W01`, the second from E2), and neither gains a `device_id` column in this wave. **If `ai_operator_task_steps` is absent from `tenantCascade.ts`, E2 has not merged — STOP.**

- [ ] **Step 2: Verify the cascade ORDER, not just membership**

This wave creates a NEW foreign key between two tables that are both already in `CORE_ORG_CASCADE_DELETE_ORDER`, so membership was already satisfied and **only the ordering is at risk**. `ai_operator_task_steps.checklist_item_id → ticket_checklist_items(id)` makes the step a CHILD, and children must be deleted first. `tenantCascade.integration.test.ts` asserts exactly this ("FK children before parents") in the Integration Tests job.

Run:
```
grep -n "'ai_operator_task_steps'" -n apps/api/src/services/tenantCascade.ts
grep -n "'ticket_checklist_items'" -n apps/api/src/services/tenantCascade.ts
```
Expected: the `ai_operator_task_steps` line number is SMALLER than the `ticket_checklist_items` line number (`'ai' < 'ti'` under `localeCompare`, so alphabetical order already satisfies the new constraint).

Record the two line numbers in the PR body. **If the order is wrong, do not re-sort the array** — it is alphabetised by contract; report it and stop, because an FK that inverts alphabetical order means the FK direction itself needs review.

- [ ] **Step 3: Write the failing export-policy assertion**

`tenant-export-policy.integration.test.ts` derives completeness from the live schema, so the red step here is a live-DB run rather than a new file:

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`
Expected: **FAIL**, naming the four unclassified columns — `ticket_checklist_items.operator_step_id`, `ai_operator_task_steps.checklist_item_id`, `.remind_after_at`, `.reminded_at`. If it PASSES, Task 3's migration did not apply to this stack; re-apply before continuing, because a green run here proves nothing.

- [ ] **Step 4: Classify the four columns**

`apps/api/src/services/tenantExportPolicyRegistry.ts` — replace the `ticket_checklist_items` entry at line 623, adding `operator_step_id` to `included` in column order:

```ts
  "ticket_checklist_items": tablePolicy("org_id", {"included":["id","org_id","ticket_id","label","detail","position","done_at","done_by_user_id","source","source_template_item_id","operator_step_id","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

and extend E2's `ai_operator_task_steps` entry's `included` array with `"checklist_item_id","remind_after_at","reminded_at"`, leaving its `excludedOpen` (`checkpoint`) untouched.

All four are `included`: a uuid tenant identifier and two timestamps. None matches `SUSPICIOUS_NAME_PARTS`, none is `json`/`jsonb`/`bytea`, and none is credential material — so none belongs in `reviewedIncluded`, `excludedSensitive` or `excludedOpen`. Add one comment line above the `ticket_checklist_items` entry:

```ts
  // operator_step_id (recipe library E3): provenance uuid naming the
  // ai_operator_task_steps row that created an `operator_task` item. A tenant
  // identifier, not a container and not a secret — `included`, same bucket as
  // source_template_item_id beside it.
```

- [ ] **Step 5: Run both export suites green**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`
Expected: PASS, both. A 0-test run is a stall.

- [ ] **Step 6: Commit**

```
git add apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "$(cat <<'EOF'
chore(api): classify the four E3 human-work columns in the export policy

ADD COLUMN on an already-registered table re-fires CORE_TENANT_EXPORT_POLICY.
No new table, so no cascade/merge/device list entry; the cascade ORDER was
re-derived (steps before items, children before parents).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `humanWorkService.ts` — every human-work write, in the caller's transaction

**Files:**
- Create: `apps/api/src/services/aiOperator/humanWorkService.ts`
- Create: `apps/api/src/services/aiOperator/humanWorkService.test.ts`

**Interfaces:**
- Consumes: `db` (`../../db`), `ticketChecklistItems` (`../../db/schema/ticketChecklists`), `aiOperatorTaskSteps`, `aiOperatorTaskTargets` (`../../db/schema/aiOperatorTaskGraph`), `aiOperatorTasks` (`../../db/schema/aiOperatorTasks`), `createTicket` (`../ticketService`), `createTaskTarget` (`./targetService`), `openStep` / `markStepWaiting` (`./stepService`), `appendTaskEvent` + `TaskEventActor` (`./eventService`), `enqueueTaskOutbox` (`./taskOutbox`).
- Produces:
  ```ts
  export type HumanWorkDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;
  export const OPERATOR_TASK_ACTOR: { readonly userId: string; readonly name: string };
  export const CHECKLIST_ANSWER_OUTBOX_TRANSITION_SEQ = 1;
  export const HUMAN_WORK_POLL_WAKE_MS: number;
  export interface EnsureTaskTicketResult { ticketId: string; targetId: string; created: boolean }
  export async function ensureTaskTicket(dbh: HumanWorkDbHandle, task: { id: string; orgId: string; objective: string }): Promise<EnsureTaskTicketResult>;
  export interface OpenHumanWorkStepInput {
    task: { id: string; orgId: string; objective: string; revision: number; attemptOrdinal: number };
    stepKey: string; targetId?: string | null; label: string; detail?: string | null; remindAfterMs?: number | null;
  }
  export interface OpenHumanWorkStepResult { stepId: string; checklistItemId: string; ticketId: string }
  export async function openHumanWorkStep(dbh: HumanWorkDbHandle, input: OpenHumanWorkStepInput): Promise<OpenHumanWorkStepResult>;
  export interface HumanWorkStepView {
    stepId: string; state: string; checklistItemId: string | null;
    itemDoneAt: Date | null; itemDoneByUserId: string | null; itemLabel: string | null;
  }
  export async function readHumanWorkStep(orgId: string, taskId: string, stepKey: string, attemptOrdinal: number): Promise<HumanWorkStepView | null>;
  export async function onChecklistItemDone(dbh: HumanWorkDbHandle, itemId: string): Promise<'enqueued' | 'not_operator_item'>;
  export async function onChecklistItemUnticked(dbh: HumanWorkDbHandle, itemId: string): Promise<'recorded' | 'not_operator_item'>;
  export async function assertChecklistItemDeletable(itemId: string): Promise<void>;
  export class HumanWorkStepWaitingError extends Error { readonly status: 409; readonly code: 'CHECKLIST_OPERATOR_STEP_WAITING'; }
  export async function detachHumanWorkLinksForTicket(dbh: HumanWorkDbHandle, args: { ticketId: string; reason: string }): Promise<number>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/humanWorkService.test.ts
/**
 * The human-work writer, unit level (recipe spec §5.3, §6.5).
 *
 * These assert the CONTRACT, not query shape: the ordinal scheme, the refusal
 * that must happen BEFORE the database sees anything, and the two directions
 * of the link being written in one call. The real-Postgres behaviour (RLS, the
 * FK, the org-move detach) is Task 11's job.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CHECKLIST_ANSWER_OUTBOX_TRANSITION_SEQ,
  HumanWorkStepWaitingError,
  OPERATOR_TASK_ACTOR,
} from './humanWorkService';

describe('humanWorkService constants (recipe spec §6.5)', () => {
  it('uses a FIXED outbox ordinal, because the sourceId is the item and a step settles once', () => {
    // taskOutbox.ts's two shipped schemes (RUN_/INTENT_TERMINAL_OUTBOX_
    // TRANSITION_SEQ) are fixed terminal-status ordinals chosen so a redelivered
    // wake collapses onto ONE row. A checklist item reaching `done` is terminal
    // for its step, and the sourceId is the ITEM id, so two human-work steps on
    // one task never collide on this ordinal.
    expect(CHECKLIST_ANSWER_OUTBOX_TRANSITION_SEQ).toBe(1);
  });

  it('creates tickets as a named system principal with the nil user id', () => {
    // createTicket requires a TicketActor with a non-null userId, and the
    // Operator is not a users row. Precedent: DELIVERABLE_SWEEP_ACTOR
    // (services/serviceDeliverableService.ts:827).
    expect(OPERATOR_TASK_ACTOR.userId).toBe('00000000-0000-0000-0000-000000000000');
    expect(OPERATOR_TASK_ACTOR.name).toBe('AI Operator');
  });

  it('the delete refusal is a typed 409, not a bare throw', () => {
    const err = new HumanWorkStepWaitingError('x');
    expect(err.status).toBe(409);
    expect(err.code).toBe('CHECKLIST_OPERATOR_STEP_WAITING');
  });
});

describe('openHumanWorkStep', () => {
  it('writes BOTH directions of the link and yields the item id as the wait dependency', async () => {
    const calls: Record<string, unknown[]> = { openStep: [], markStepWaiting: [], appendTaskEvent: [] };
    vi.doMock('./stepService', () => ({
      openStep: async (_d: unknown, i: unknown) => { calls.openStep.push(i); return { id: 'step-1' }; },
      markStepWaiting: async (_d: unknown, i: unknown) => { calls.markStepWaiting.push(i); },
      settleStep: vi.fn(),
    }));
    vi.doMock('./eventService', () => ({
      appendTaskEvent: async (_d: unknown, i: unknown) => { calls.appendTaskEvent.push(i); return 1; },
    }));
    vi.doMock('./targetService', () => ({ createTaskTarget: async () => ({ id: 'target-t' }) }));
    vi.doMock('../ticketService', () => ({ createTicket: async () => ({ id: 'ticket-1' }) }));
    vi.doMock('./taskOutbox', () => ({ enqueueTaskOutbox: vi.fn() }));

    const { openHumanWorkStep } = await import('./humanWorkService');

    const updated: Array<Record<string, unknown>> = [];
    const dbh = {
      // The ticket target already exists, and MAX(position) is 2.
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [{ ticketId: 'ticket-1', id: 'target-t' }] }),
            limit: async () => [{ maxPosition: 2 }],
          }),
        }),
      })),
      insert: vi.fn(() => ({ values: () => ({ returning: async () => [{ id: 'item-9' }] }) })),
      update: vi.fn(() => ({ set: (v: Record<string, unknown>) => ({ where: async () => { updated.push(v); } }) })),
    } as never;

    const result = await openHumanWorkStep(dbh, {
      task: { id: 'task-1', orgId: 'org-1', objective: 'Offboard Dana', revision: 3, attemptOrdinal: 0 },
      stepKey: 'collect_hardware',
      label: 'Collect the laptop',
      detail: 'Dock and charger too',
      remindAfterMs: 86_400_000,
    });

    expect(result).toMatchObject({ stepId: 'step-1', checklistItemId: 'item-9', ticketId: 'ticket-1' });
    expect(calls.openStep[0]).toMatchObject({
      orgId: 'org-1', taskId: 'task-1', stepKey: 'collect_hardware',
      stepKind: 'human_work', attemptOrdinal: 0, planRevision: 3,
    });
    // The wait dependency is the ITEM, not the step: that is what a human acts
    // on and what the wake carries as its sourceId (spec §6.5).
    expect(calls.markStepWaiting[0]).toMatchObject({
      dependencyKind: 'user_answer', dependencyId: 'item-9',
    });
    // Both directions written: the step's owning pointer and the item's
    // provenance pointer.
    expect(updated.some((u) => u.checklistItemId === 'item-9')).toBe(true);
    expect(updated.some((u) => u.operatorStepId === 'step-1')).toBe(true);
  });

  it('refuses an empty label BEFORE touching the database', async () => {
    vi.resetModules();
    const { openHumanWorkStep } = await import('./humanWorkService');
    const dbh = { select: vi.fn(), insert: vi.fn(), update: vi.fn() } as never;
    await expect(openHumanWorkStep(dbh, {
      task: { id: 'task-1', orgId: 'org-1', objective: 'o', revision: 1, attemptOrdinal: 0 },
      stepKey: 'collect_hardware', label: '   ',
    })).rejects.toThrow(/label/);
    expect((dbh as unknown as { insert: ReturnType<typeof vi.fn> }).insert).not.toHaveBeenCalled();
  });
});
```

> If the drizzle stub above does not match the chained shape the implementation ends up using, adjust the STUB to the implementation — never the assertions. The assertions are the contract.

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/humanWorkService.test.ts`
Expected: FAIL — `Cannot find module './humanWorkService'`.

- [ ] **Step 3: Write `humanWorkService.ts`**

```ts
// AI Operator human-work steps (Recipe Library wave E3, spec §5.3 and §6.5).
//
// WHY THIS FILE EXISTS: a `human_work` step is the one step kind whose
// completion is written by someone OUTSIDE the Operator — a technician ticking
// a checklist item on a ticket. That makes it the only place the Operator's
// object graph and the ticket system touch, and it deserves exactly one writer
// so the two sides can never drift about which row owns the link, which org
// each row is in, or what happens when they stop agreeing.
//
// THE OPERATOR CREATES ITEMS AND NEVER COMPLETES THEM (spec §6.5). There is no
// `done_at` write anywhere in this file, and `humanWorkPurity.test.ts` scans
// the whole `services/aiOperator/` tree to keep it that way. Completion is a
// human attestation on a compliance artifact; an agent that could tick its own
// checklist would be grading its own homework.
//
// ATOMICITY. Every write takes the caller's handle (`dbh`), exactly like
// `enqueueTaskOutbox` (taskOutbox.ts:50), `appendTaskEvent` (eventService.ts)
// and `openStep` (stepService.ts). The request path is already one Postgres
// transaction (`withDbAccessContext`, db/index.ts:742-753) and the bare `db`
// proxy joins it, so `patchChecklistItem`'s guarded `done_at` UPDATE and the
// wake this file enqueues commit together or not at all. NO `db.transaction()`
// is opened here.
//
// IMPORT DIRECTION IS ONE-WAY: `ticketChecklistService` imports THIS module,
// never the reverse. That is why the checklist-item insert below is written
// against the Drizzle table directly instead of calling `addChecklistItem` —
// which also hardcodes `source: 'manual'` and stamps `createdBy: actor.userId`,
// neither of which is right for an Operator-created row.
//
// THE LINK IS DETACHED, NEVER RE-STAMPED. `ticket_checklist_items.org_id` moves
// with its ticket; `ai_operator_task_steps.org_id` is immutable task history.
// When they diverge, `detachHumanWorkLinksForTicket` nulls the pointer and
// wakes the task, and the coordinator's authoritative re-read turns that into a
// classified handoff. See the migration header note A.

import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { aiOperatorTaskSteps, aiOperatorTaskTargets } from '../../db/schema/aiOperatorTaskGraph';
import { ticketChecklistItems } from '../../db/schema/ticketChecklists';
import { createTicket } from '../ticketService';
import { createTaskTarget } from './targetService';
import { appendTaskEvent } from './eventService';
import { markStepWaiting, openStep } from './stepService';
import { enqueueTaskOutbox } from './taskOutbox';

/** Mirrors `ticket_checklist_items.label` varchar(500). */
const MAX_ITEM_LABEL_CHARS = 500;
/** Mirrors the `detail` bound the checklist validators use. */
const MAX_ITEM_DETAIL_CHARS = 2000;

/**
 * The principal the Operator creates tickets and checklist items as.
 *
 * `createTicket` requires a `TicketActor` with a non-null `userId` and the
 * Operator is not a `users` row, so the nil UUID is the established stand-in —
 * `DELIVERABLE_SWEEP_ACTOR` (services/serviceDeliverableService.ts:827) does
 * exactly this. The checklist item's own `created_by` is left NULL rather than
 * given the nil UUID, because that column IS a real FK to `users`
 * (2026-10-16-190000-ticket-checklist-items.sql:51-56) and nullability is the
 * documented system-provenance marker there; `source = 'operator_task'` is what
 * says where the row came from.
 */
export const OPERATOR_TASK_ACTOR = {
  userId: '00000000-0000-0000-0000-000000000000',
  name: 'AI Operator',
} as const;

/**
 * The `transitionSeq` for a `user_answer` wake.
 *
 * FIXED, not a counter, and that is deliberate — the same "terminal status
 * ordinal" scheme `RUN_TERMINAL_OUTBOX_TRANSITION_SEQ` and
 * `INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ` use (taskOutbox.ts:92, :127). The
 * `sourceId` is the CHECKLIST ITEM id, so two human-work steps on one task
 * never share a row; and a re-tick after an untick reuses the same identity,
 * which is what makes `ON CONFLICT DO NOTHING` collapse it rather than wake a
 * task whose step has already settled and moved on.
 */
export const CHECKLIST_ANSWER_OUTBOX_TRANSITION_SEQ = 1;

/**
 * The polling fallback for a human-work wait.
 *
 * The EVENT path (a tick → an outbox row → a wake) is how this normally
 * resolves. This is the backstop for a lost wake, and it is long on purpose: a
 * waiting task holds nothing, and re-entering `advanceHumanWork` every six
 * hours to re-read one row costs nothing either.
 */
export const HUMAN_WORK_POLL_WAKE_MS = 6 * 60 * 60 * 1000;

export type HumanWorkDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;

/** Refusal for deleting a checklist item an Operator step is still waiting on. */
export class HumanWorkStepWaitingError extends Error {
  readonly status = 409 as const;
  readonly code = 'CHECKLIST_OPERATOR_STEP_WAITING' as const;
  constructor(message: string) {
    super(message);
    this.name = 'HumanWorkStepWaitingError';
  }
}

export interface EnsureTaskTicketResult {
  ticketId: string;
  targetId: string;
  created: boolean;
}

/**
 * The task's ticket, creating one if it has none (spec §6.5: "a task with
 * human-work steps requires a ticket; admission creates one if absent").
 *
 * The ticket is reached through an E2 `ticket` TARGET ROW, not through a column
 * on `ai_operator_tasks` — that table has no ticket pointer and gains none
 * (decision D3). "Do not create a second ticket queue" holds: the ticket is the
 * business record the technician already works from.
 */
export async function ensureTaskTicket(
  dbh: HumanWorkDbHandle,
  task: { id: string; orgId: string; objective: string },
): Promise<EnsureTaskTicketResult> {
  const [existing] = await dbh
    .select({ id: aiOperatorTaskTargets.id, ticketId: aiOperatorTaskTargets.ticketId })
    .from(aiOperatorTaskTargets)
    .where(and(
      eq(aiOperatorTaskTargets.orgId, task.orgId),
      eq(aiOperatorTaskTargets.taskId, task.id),
      eq(aiOperatorTaskTargets.targetKind, 'ticket'),
      isNotNull(aiOperatorTaskTargets.ticketId),
    ))
    .orderBy(aiOperatorTaskTargets.targetOrdinal)
    .limit(1);

  if (existing?.ticketId) {
    return { ticketId: existing.ticketId, targetId: existing.id, created: false };
  }

  // `source: 'ai'` is the shipped ticket source for agent-created work
  // (db/schema/portal.ts:8). `workKind` is left at its 'support' default: this
  // ticket carries real, SLA-bearing work a technician must do.
  const ticket = await createTicket({
    orgId: task.orgId,
    source: 'ai',
    subject: task.objective.slice(0, 255),
    description:
      'Opened by the AI Operator because this task has work only a person can do. '
      + 'The checklist below is the work; tick each step as you complete it.',
  }, OPERATOR_TASK_ACTOR);

  const [maxOrdinal] = await dbh
    .select({ maxOrdinal: sql<number | null>`MAX(${aiOperatorTaskTargets.targetOrdinal})` })
    .from(aiOperatorTaskTargets)
    .where(and(
      eq(aiOperatorTaskTargets.orgId, task.orgId),
      eq(aiOperatorTaskTargets.taskId, task.id),
    ));

  const target = await createTaskTarget(dbh, {
    orgId: task.orgId,
    taskId: task.id,
    targetKind: 'ticket',
    ticketId: ticket.id,
    targetLabel: task.objective.slice(0, 255),
    targetOrdinal: (maxOrdinal?.maxOrdinal ?? -1) + 1,
  });
  if (!target) {
    throw new Error(`[humanWork] could not attach a ticket target to task ${task.id}`);
  }

  await appendTaskEvent(dbh, {
    orgId: task.orgId,
    taskId: task.id,
    eventType: 'target_attached',
    actor: { kind: 'coordinator' },
    targetId: target.id,
    detail: `opened ticket ${ticket.id} for human work`,
  });

  return { ticketId: ticket.id, targetId: target.id, created: true };
}

export interface OpenHumanWorkStepInput {
  task: { id: string; orgId: string; objective: string; revision: number; attemptOrdinal: number };
  stepKey: string;
  /** The `ai_operator_task_targets` row this work is about, if any. */
  targetId?: string | null;
  /** What the technician must do. Becomes the checklist item's label. */
  label: string;
  detail?: string | null;
  /** How long until the step is overdue. Null means never remind. */
  remindAfterMs?: number | null;
  now?: Date;
}

export interface OpenHumanWorkStepResult {
  stepId: string;
  checklistItemId: string;
  ticketId: string;
}

/**
 * Open a `human_work` step: ticket, checklist item, step row, both link
 * pointers and the typed wait — all in the caller's ONE transaction.
 *
 * All of it or none of it. A step row without its item is a task waiting on a
 * dependency that does not exist; an item without its step is a checklist entry
 * nobody can explain. Splitting these across transactions is how you get both.
 */
export async function openHumanWorkStep(
  dbh: HumanWorkDbHandle,
  input: OpenHumanWorkStepInput,
): Promise<OpenHumanWorkStepResult> {
  const label = input.label.trim();
  // REFUSE FIRST. The column's NOT NULL / length CHECK would also catch this,
  // but a 23514 raised inside the caller's transaction ABORTS it — the caller
  // could not then read back, answer, or even record why. The constraint is the
  // backstop, never the control flow.
  if (!label) {
    throw new Error(`[humanWork] a human_work step needs a non-empty label (step '${input.stepKey}')`);
  }

  const now = input.now ?? new Date();
  const { ticketId } = await ensureTaskTicket(dbh, input.task);

  // Append at the end of the ticket's list, same rule as addChecklistItem
  // (ticketChecklistService.ts:123-127). Duplicated rather than imported: the
  // import direction is one-way (see the file header), and four lines of
  // MAX()+1 is a smaller cost than a module cycle.
  const [agg] = await dbh
    .select({ maxPosition: sql<number | null>`MAX(${ticketChecklistItems.position})` })
    .from(ticketChecklistItems)
    .where(eq(ticketChecklistItems.ticketId, ticketId));

  const [item] = await dbh
    .insert(ticketChecklistItems)
    .values({
      // The TICKET's org, which is also the task's org at this moment. They can
      // diverge later, which is exactly what the detach path exists for.
      orgId: input.task.orgId,
      ticketId,
      label: label.slice(0, MAX_ITEM_LABEL_CHARS),
      detail: input.detail ? input.detail.slice(0, MAX_ITEM_DETAIL_CHARS) : null,
      position: (agg?.maxPosition ?? -1) + 1,
      source: 'operator_task',
      // NULL, not the nil UUID: `created_by` is a real FK to `users` and
      // nullability is the documented system-provenance marker there.
      createdBy: null,
    })
    .returning({ id: ticketChecklistItems.id });

  if (!item) {
    throw new Error(`[humanWork] checklist item insert returned no row for task ${input.task.id}`);
  }

  const step = await openStep(dbh, {
    orgId: input.task.orgId,
    taskId: input.task.id,
    stepKey: input.stepKey,
    stepKind: 'human_work',
    targetId: input.targetId ?? null,
    attemptOrdinal: input.task.attemptOrdinal,
    planRevision: input.task.revision,
    expectedCriterion: label.slice(0, 2000),
    actor: { kind: 'coordinator' },
  });

  // The step owns the link (migration header note A).
  await dbh
    .update(aiOperatorTaskSteps)
    .set({
      checklistItemId: item.id,
      remindAfterAt: input.remindAfterMs ? new Date(now.getTime() + input.remindAfterMs) : null,
      remindedAt: null,
      updatedAt: now,
    })
    .where(eq(aiOperatorTaskSteps.id, step.id));

  // The item carries the reverse pointer as provenance only (header note B).
  await dbh
    .update(ticketChecklistItems)
    .set({ operatorStepId: step.id, updatedAt: now })
    .where(eq(ticketChecklistItems.id, item.id));

  // The dependency is the ITEM, not the step: it is what a human acts on, and
  // it is what the wake carries as its sourceId.
  await markStepWaiting(dbh, {
    orgId: input.task.orgId,
    taskId: input.task.id,
    stepKey: input.stepKey,
    targetId: input.targetId ?? null,
    attemptOrdinal: input.task.attemptOrdinal,
    dependencyKind: 'user_answer',
    dependencyId: item.id,
    actor: { kind: 'coordinator' },
    detail: `waiting on a person: ${label.slice(0, 200)}`,
  });

  return { stepId: step.id, checklistItemId: item.id, ticketId };
}

export interface HumanWorkStepView {
  stepId: string;
  state: string;
  checklistItemId: string | null;
  itemDoneAt: Date | null;
  itemDoneByUserId: string | null;
  itemLabel: string | null;
}

/**
 * The AUTHORITATIVE read behind every human-work decision (Operator spec §6.3
 * invariant 2: the coordinator never trusts a wake payload).
 *
 * The item join is constrained on `ticket_checklist_items.org_id = <the TASK's
 * org>`, not merely on the id. That single predicate is what turns a ticket
 * org-move into a clean handoff: after the move the item is in another tenant,
 * the join misses, and the caller sees `checklistItemId` set but `itemLabel`
 * null — which it must treat exactly as a detached link.
 */
export async function readHumanWorkStep(
  orgId: string,
  taskId: string,
  stepKey: string,
  attemptOrdinal: number,
): Promise<HumanWorkStepView | null> {
  const [row] = await db
    .select({
      stepId: aiOperatorTaskSteps.id,
      state: aiOperatorTaskSteps.state,
      checklistItemId: aiOperatorTaskSteps.checklistItemId,
      itemDoneAt: ticketChecklistItems.doneAt,
      itemDoneByUserId: ticketChecklistItems.doneByUserId,
      itemLabel: ticketChecklistItems.label,
    })
    .from(aiOperatorTaskSteps)
    .leftJoin(ticketChecklistItems, and(
      eq(ticketChecklistItems.id, aiOperatorTaskSteps.checklistItemId),
      eq(ticketChecklistItems.orgId, aiOperatorTaskSteps.orgId),
    ))
    .where(and(
      eq(aiOperatorTaskSteps.orgId, orgId),
      eq(aiOperatorTaskSteps.taskId, taskId),
      eq(aiOperatorTaskSteps.stepKey, stepKey),
      eq(aiOperatorTaskSteps.attemptOrdinal, attemptOrdinal),
    ))
    .orderBy(desc(aiOperatorTaskSteps.createdAt))
    .limit(1);

  return row ?? null;
}

/**
 * Called by `patchChecklistItem` when an item transitions to done, in the
 * SAME transaction as the `done_at` stamp.
 *
 * Enqueues the wake and nothing else. It deliberately does NOT settle the step:
 * settling is a leased task transition and this is a request handler with no
 * lease. The coordinator re-reads and decides (invariant 2).
 */
export async function onChecklistItemDone(
  dbh: HumanWorkDbHandle,
  itemId: string,
): Promise<'enqueued' | 'not_operator_item'> {
  const [link] = await dbh
    .select({ orgId: aiOperatorTaskSteps.orgId, taskId: aiOperatorTaskSteps.taskId })
    .from(aiOperatorTaskSteps)
    .where(eq(aiOperatorTaskSteps.checklistItemId, itemId))
    .limit(1);

  if (!link) return 'not_operator_item';

  await enqueueTaskOutbox(dbh, {
    orgId: link.orgId,
    taskId: link.taskId,
    sourceKind: 'user_answer',
    sourceId: itemId,
    transitionSeq: CHECKLIST_ANSWER_OUTBOX_TRANSITION_SEQ,
  });
  return 'enqueued';
}

/**
 * Called by `patchChecklistItem` when an operator item is UNTICKED.
 *
 * Spec §6.5: "Un-checking an item after the task advanced writes an event and
 * does not rewind." No wake, no step change, no task change — only a row on the
 * append-only timeline, so a technician reading the record later can see that
 * the tick the Operator acted on was withdrawn. Rewinding would mean re-running
 * effects the task has already dispatched against real customer systems.
 */
export async function onChecklistItemUnticked(
  dbh: HumanWorkDbHandle,
  itemId: string,
): Promise<'recorded' | 'not_operator_item'> {
  const [link] = await dbh
    .select({
      orgId: aiOperatorTaskSteps.orgId,
      taskId: aiOperatorTaskSteps.taskId,
      stepKey: aiOperatorTaskSteps.stepKey,
      state: aiOperatorTaskSteps.state,
    })
    .from(aiOperatorTaskSteps)
    .where(eq(aiOperatorTaskSteps.checklistItemId, itemId))
    .limit(1);

  if (!link) return 'not_operator_item';

  await appendTaskEvent(dbh, {
    orgId: link.orgId,
    taskId: link.taskId,
    eventType: 'human_work_unticked',
    actor: { kind: 'system' },
    stepKey: link.stepKey,
    detail:
      `a person cleared the tick on the checklist item for step '${link.stepKey}' `
      + `(step state: ${link.state}). The task did not rewind.`,
  });
  return 'recorded';
}

/**
 * Refuse to delete a checklist item an Operator step is still waiting on.
 *
 * A PRE-CHECK, not a caught constraint error: the FK is `ON DELETE SET NULL`,
 * so the delete would SUCCEED and silently strand the task on a dependency that
 * no longer exists. There is nothing for the database to raise here — the guard
 * IS the contract. Once the step has settled the item is ordinary history and
 * deleting it is allowed.
 */
export async function assertChecklistItemDeletable(itemId: string): Promise<void> {
  const [waiting] = await db
    .select({ stepKey: aiOperatorTaskSteps.stepKey, taskId: aiOperatorTaskSteps.taskId })
    .from(aiOperatorTaskSteps)
    .where(and(
      eq(aiOperatorTaskSteps.checklistItemId, itemId),
      eq(aiOperatorTaskSteps.state, 'waiting'),
    ))
    .limit(1);

  if (waiting) {
    throw new HumanWorkStepWaitingError(
      'This step belongs to a running AI Operator task and cannot be deleted while the task is waiting on it. '
      + 'Tick it when the work is done, or stop the task first.',
    );
  }
}

/**
 * Detach every human-work link on a ticket and wake the tasks behind them.
 *
 * Called by `moveTicketOrg` and by the org-merge fence. It nulls the STEP's
 * pointer — not the item's provenance column, which stays as evidence — and
 * enqueues a `user_answer` wake per affected task. It does NOT settle anything:
 * a task transition needs a lease, and this runs inside somebody else's
 * transaction. The coordinator's re-read finds `checklist_item_id IS NULL` and
 * hands off with a readable reason, which is E2's detach-never-re-stamp rule
 * applied one level down.
 *
 * Returns how many step rows were detached, so the caller can log a count
 * rather than guess (the migration-cleanup forensic-trail rule, applied to a
 * service).
 */
export async function detachHumanWorkLinksForTicket(
  dbh: HumanWorkDbHandle,
  args: { ticketId: string; reason: string },
): Promise<number> {
  const affected = await dbh
    .select({
      stepId: aiOperatorTaskSteps.id,
      orgId: aiOperatorTaskSteps.orgId,
      taskId: aiOperatorTaskSteps.taskId,
      stepKey: aiOperatorTaskSteps.stepKey,
      checklistItemId: aiOperatorTaskSteps.checklistItemId,
    })
    .from(aiOperatorTaskSteps)
    .innerJoin(ticketChecklistItems, eq(ticketChecklistItems.id, aiOperatorTaskSteps.checklistItemId))
    .where(and(
      eq(ticketChecklistItems.ticketId, args.ticketId),
      isNull(aiOperatorTaskSteps.settledAt),
    ));

  for (const row of affected) {
    await dbh
      .update(aiOperatorTaskSteps)
      .set({ checklistItemId: null, updatedAt: new Date() })
      .where(eq(aiOperatorTaskSteps.id, row.stepId));

    await appendTaskEvent(dbh, {
      orgId: row.orgId,
      taskId: row.taskId,
      eventType: 'target_detached',
      actor: { kind: 'system' },
      stepKey: row.stepKey,
      detail: `human-work checklist item detached: ${args.reason}`,
    });

    if (row.checklistItemId) {
      await enqueueTaskOutbox(dbh, {
        orgId: row.orgId,
        taskId: row.taskId,
        sourceKind: 'user_answer',
        sourceId: row.checklistItemId,
        transitionSeq: CHECKLIST_ANSWER_OUTBOX_TRANSITION_SEQ,
      });
    }
  }

  return affected.length;
}
```

> `aiOperatorTasks` is imported for typing only if the executor's final code needs it; if it ends up unused, delete the import rather than leaving it (lint will say so).

- [ ] **Step 4: Run it green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/humanWorkService.test.ts`
Expected: PASS — 1 file, 5 tests.

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```
git add apps/api/src/services/aiOperator/humanWorkService.ts apps/api/src/services/aiOperator/humanWorkService.test.ts
git commit -m "$(cat <<'EOF'
feat(api): humanWorkService — the one writer for Operator human-work steps (E3)

Ticket, checklist item, step row, both link pointers and the typed wait in the
caller's single transaction. No done_at write anywhere: completion stays a
human attestation (spec §6.5).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The wake path — `patchChecklistItem` enqueues, `deleteChecklistItem` refuses, `listChecklist` links

**Files:**
- Modify: `apps/api/src/services/ticketChecklistService.ts` (`ChecklistItemView` :32-44, `toView` :57-74, `listChecklist` :94-105, `patchChecklistItem` :153-208, `deleteChecklistItem` :254-260)
- Modify: `apps/api/src/routes/tickets/checklist.ts` (`handleServiceError` :42-50)
- Modify: `apps/api/src/services/ticketChecklistService.test.ts` (or create if absent)

**Interfaces:**
- Consumes: `onChecklistItemDone`, `onChecklistItemUnticked`, `assertChecklistItemDeletable`, `HumanWorkStepWaitingError` (`./aiOperator/humanWorkService`).
- Produces: `ChecklistItemView.operatorTaskId: string | null`; a 409 `CHECKLIST_OPERATOR_STEP_WAITING` on the delete route.

**The atomicity fact this task rests on:** the request path already runs inside one Postgres transaction — `withDbAccessContext` *"resolve[s] a tenant context and run[s] work in the same transaction"* (`apps/api/src/db/index.ts:742-753`) — and the bare `db` proxy joins it. So passing `db` to `onChecklistItemDone` puts the outbox row in the SAME transaction as the `done_at` stamp with **no `db.transaction()` call added**. Adding one would nest a transaction inside the request context, which is the double-connection-hold pattern this repo has been bitten by.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/ticketChecklistService.test.ts  (append; create the file if it does not exist)
/**
 * The wake path (recipe spec §6.5). Three contracts:
 *
 *  1. Ticking an `operator_task` item enqueues the task wake IN THE SAME CALL
 *     as the `done_at` stamp — not after it, and not from the route. A wake
 *     written in a later statement is not atomic with the transition it
 *     announces: a crash between the two leaves a committed tick with no wake
 *     ever raised, and the task waits until its deadline.
 *  2. Un-ticking records an event and does NOT enqueue a wake — the task must
 *     not rewind over effects it has already dispatched.
 *  3. Deleting an item a step is still waiting on is refused BEFORE the delete,
 *     because the FK is ON DELETE SET NULL and would otherwise succeed and
 *     silently strand the task.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const onChecklistItemDone = vi.fn(async () => 'enqueued' as const);
const onChecklistItemUnticked = vi.fn(async () => 'recorded' as const);
const assertChecklistItemDeletable = vi.fn(async () => {});

vi.mock('./aiOperator/humanWorkService', () => ({
  onChecklistItemDone: (...a: unknown[]) => onChecklistItemDone(...(a as [])),
  onChecklistItemUnticked: (...a: unknown[]) => onChecklistItemUnticked(...(a as [])),
  assertChecklistItemDeletable: (...a: unknown[]) => assertChecklistItemDeletable(...(a as [])),
  HumanWorkStepWaitingError: class extends Error {
    readonly status = 409; readonly code = 'CHECKLIST_OPERATOR_STEP_WAITING';
  },
}));

// The drizzle stub the rest of this suite already uses; if the file is new,
// build it to return the row shapes each assertion needs.
// ... (existing stub wiring) ...

describe('patchChecklistItem — operator wake path', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('enqueues the task wake when an operator_task item is ticked', async () => {
    // existing row: source 'operator_task', doneAt null
    await patchChecklistItem('item-1', { done: true }, { userId: 'user-7' });
    expect(onChecklistItemDone).toHaveBeenCalledTimes(1);
    expect(onChecklistItemDone.mock.calls[0]?.[1]).toBe('item-1');
  });

  it('does NOT enqueue for a manual item', async () => {
    await patchChecklistItem('item-manual', { done: true }, { userId: 'user-7' });
    expect(onChecklistItemDone).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when the tick was a no-op because it was already done', async () => {
    // First-writer-wins: the guarded UPDATE matched zero rows. Waking here
    // would re-wake a task for a transition that did not happen now.
    await patchChecklistItem('item-already-done', { done: true }, { userId: 'user-7' });
    expect(onChecklistItemDone).not.toHaveBeenCalled();
  });

  it('records an event and enqueues NOTHING when an operator item is unticked', async () => {
    await patchChecklistItem('item-1', { done: false }, { userId: 'user-7' });
    expect(onChecklistItemUnticked).toHaveBeenCalledTimes(1);
    expect(onChecklistItemDone).not.toHaveBeenCalled();
  });
});

describe('deleteChecklistItem — operator guard', () => {
  it('asks the guard BEFORE deleting', async () => {
    const order: string[] = [];
    assertChecklistItemDeletable.mockImplementation(async () => { order.push('guard'); });
    // the stub's delete pushes 'delete'
    await deleteChecklistItem('item-1');
    expect(order[0]).toBe('guard');
  });

  it('propagates the 409 and never deletes', async () => {
    assertChecklistItemDeletable.mockImplementation(async () => {
      const e = new Error('waiting') as Error & { status: number; code: string };
      e.status = 409; e.code = 'CHECKLIST_OPERATOR_STEP_WAITING';
      throw e;
    });
    await expect(deleteChecklistItem('item-1')).rejects.toMatchObject({ status: 409 });
  });
});

describe('listChecklist', () => {
  it('projects operatorTaskId so the ticket page can link to the task', async () => {
    const summary = await listChecklist('tk-1');
    expect(summary.items[0]).toMatchObject({ source: 'operator_task', operatorTaskId: 'task-1' });
  });

  it('projects operatorTaskId null when the step is in another org (a moved ticket)', async () => {
    const summary = await listChecklist('tk-moved');
    expect(summary.items[0]).toMatchObject({ source: 'operator_task', operatorTaskId: null });
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/ticketChecklistService.test.ts`
Expected: FAIL — `onChecklistItemDone` never called; `operatorTaskId` undefined.

- [ ] **Step 3: Add the projection to `listChecklist`**

In `ChecklistItemView` (`:32-44`), after `sourceTemplateItemId`:

```ts
  /**
   * The AI Operator task behind an `operator_task` item, for the ticket page's
   * "Operator step" badge (recipe spec §6.5).
   *
   * NULL when there is no step, or when the step is in a DIFFERENT org — which
   * is what a ticket that has been moved between orgs looks like. The join
   * below is constrained on org, so the badge degrades to a plain label rather
   * than rendering a link into another tenant.
   */
  operatorTaskId: string | null;
```

`toView` (`:57-74`) takes a second parameter so the join result can be threaded through without widening the row type:

```ts
function toView(row: TicketChecklistItemRow, operatorTaskId: string | null = null): ChecklistItemView {
  return {
    // ... every existing field unchanged ...
    operatorTaskId,
  };
}
```

`listChecklist` (`:94-105`) becomes a left join. Every other caller of `toView` keeps its single-argument form and therefore reports `null`, which is correct: a single-item response after a patch is not where the badge link is read.

```ts
export async function listChecklist(
  ticketId: string,
  exec: DbExecutor = db,
): Promise<ChecklistSummary> {
  // LEFT JOIN, and the org predicate is LOAD-BEARING, not tidiness: the step
  // and the item legitimately end up in different orgs after a ticket org-move
  // (the item's org_id is re-stamped, the step's is immutable task history), and
  // the ticket page must not then render a link into the other tenant. The
  // `operator_step_id` column is provenance and is NEVER joined for
  // authorization — this join only decides whether to show a link.
  const rows = (await exec
    .select({
      item: ticketChecklistItems,
      operatorTaskId: aiOperatorTaskSteps.taskId,
    })
    .from(ticketChecklistItems)
    .leftJoin(aiOperatorTaskSteps, and(
      eq(aiOperatorTaskSteps.id, ticketChecklistItems.operatorStepId),
      eq(aiOperatorTaskSteps.orgId, ticketChecklistItems.orgId),
    ))
    .where(eq(ticketChecklistItems.ticketId, ticketId))
    .orderBy(...checklistOrder())) as Array<{ item: TicketChecklistItemRow; operatorTaskId: string | null }>;

  const items = rows.map((r) => toView(r.item, r.operatorTaskId));
  return { items, done: items.filter((i) => i.done).length, total: items.length };
}
```

with the imports `import { aiOperatorTaskSteps } from '../db/schema/aiOperatorTaskGraph';` added.

- [ ] **Step 4: Add the wake to `patchChecklistItem`**

In the RULE 1 `done === true` branch (`:166-175`), replace the return with:

```ts
  if (patch.done === true && !editsText) {
    const updated = (await db
      .update(ticketChecklistItems)
      .set({ doneAt: now, doneByUserId: actor.userId, updatedAt: now })
      .where(and(eq(ticketChecklistItems.id, itemId), isNull(ticketChecklistItems.doneAt)))
      .returning()) as TicketChecklistItemRow[];

    // THE WAKE, and only when THIS call is the one that ticked it.
    //
    // `updated[0]` is non-empty exactly when the guarded UPDATE won the
    // first-writer race. A no-op re-tick must NOT wake the task: the transition
    // it would announce did not happen now, and the coordinator would burn a
    // lease claim re-deriving a step it has already settled.
    //
    // `db`, not a new transaction: the request is already one transaction
    // (db/index.ts:742-753), so the outbox row and the done_at stamp commit
    // together. That atomicity is the whole contract — a wake written after the
    // commit can be lost by a crash, leaving a ticked item and a task that
    // waits until its deadline.
    if (updated[0] && existing.source === 'operator_task') {
      await onChecklistItemDone(db, itemId);
    }

    return toView(updated[0] ?? (await getChecklistItemOr404(itemId)));
  }
```

And after the final UPDATE (`:201-207`), before the `return`:

```ts
  // RULE 4 (E3) — an untick on an Operator step is RECORDED, never rewound.
  // Spec §6.5. The task may already have dispatched effects against real
  // customer systems on the strength of that tick; "undo" is not available and
  // pretending otherwise would be worse than the stale record. The event row is
  // how a technician later sees that the attestation was withdrawn.
  //
  // Reached by both the explicit `done: false` branch and RULE 3's text-edit
  // clearing, because both end with the item unticked.
  if (existing.source === 'operator_task' && existing.doneAt !== null && row.doneAt === null) {
    await onChecklistItemUnticked(db, itemId);
  }
```

- [ ] **Step 5: Add the delete guard**

`deleteChecklistItem` (`:254-260`):

```ts
export async function deleteChecklistItem(itemId: string): Promise<void> {
  // BEFORE the delete, and it has to be: `ai_operator_task_steps.
  // checklist_item_id` is ON DELETE SET NULL, so the database would happily
  // accept this and leave a live task waiting on a dependency that no longer
  // exists — a stuck task with no error anywhere. There is nothing for Postgres
  // to raise here; this guard IS the constraint.
  await assertChecklistItemDeletable(itemId);

  const deleted = (await db
    .delete(ticketChecklistItems)
    .where(eq(ticketChecklistItems.id, itemId))
    .returning({ id: ticketChecklistItems.id })) as Array<{ id: string }>;
  if (deleted.length === 0) throw notFound();
}
```

- [ ] **Step 6: Map the 409 on the route**

`apps/api/src/routes/tickets/checklist.ts` — extend `handleServiceError` (`:42-50`):

```ts
function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof ChecklistServiceError) {
    return c.json(
      { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
      err.status,
    );
  }
  // The Operator's own refusal (E3). Rendered here rather than converted into a
  // ChecklistServiceError inside humanWorkService, because that would make the
  // aiOperator tree import the ticket service's error class and close the
  // module cycle this wave deliberately keeps open in one direction.
  if (err instanceof HumanWorkStepWaitingError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}
```

with `import { HumanWorkStepWaitingError } from '../../services/aiOperator/humanWorkService';`.

- [ ] **Step 7: Run green**

Run: `cd apps/api && npx vitest run src/services/ticketChecklistService.test.ts src/routes/tickets/checklist.test.ts`
Expected: PASS. Check the file/test counts — a 0-test run is a stall. If `src/routes/tickets/checklist.test.ts` does not exist, drop it from the command and note it in the PR body.

Then run the two suites most likely to be disturbed by the `toView` signature change and the new join:

Run: `cd apps/api && npx vitest run src/routes/portal src/services/serviceDeliverableService`
Expected: PASS. `serviceDeliverableService` imports this module (see the lazy-`checklistOrder` note at `ticketChecklistService.ts:76-87`), so a module-load regression shows up there first.

- [ ] **Step 8: Commit**

```
git add apps/api/src/services/ticketChecklistService.ts apps/api/src/services/ticketChecklistService.test.ts apps/api/src/routes/tickets/checklist.ts
git commit -m "$(cat <<'EOF'
feat(api): checklist tick wakes its Operator task; delete refuses a waiting step (E3)

The wake is enqueued in the same transaction as the done_at stamp and only
when this call won the first-writer race. Untick records an event and never
rewinds. The delete guard is a pre-check because the FK is ON DELETE SET NULL
and would otherwise strand the task silently.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The coordinator — `advanceHumanWork`, `advanceWait`, and dispatch by KIND

**Files:**
- Modify: `apps/api/src/services/aiOperator/taskCoordinator.ts` (the `RECIPE_ADVANCERS` block E1 added above `advanceTask`; the deadline branch at `:419-436`; the dispatch tail E1 rewrote)
- Create: `apps/api/src/services/aiOperator/taskCoordinatorHumanWork.test.ts`

**Interfaces:**
- Consumes: `RecipeDefinition`, `StepKind` (`./recipes/types`), `resolveTaskRecipe`, `StepAdvancer`, `RECIPE_ADVANCERS` (already in this file), `openHumanWorkStep`, `readHumanWorkStep`, `HUMAN_WORK_POLL_WAKE_MS` (`./humanWorkService`), `settleStep`, `appendTaskEvent` (E2).
- Produces:
  ```ts
  export async function advanceHumanWork(args: { task: AiOperatorTaskRow; leaseEpoch: number; checkpoint: TaskCheckpoint; recipe: RecipeDefinition<never>; now: Date }): Promise<string>;
  export async function advanceWait(args: { /* same shape */ }): Promise<string>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/taskCoordinatorHumanWork.test.ts
/**
 * The two generic advancers (recipe spec §6.1's step-kind table rows
 * `human_work` and `wait`).
 *
 * Driven against a FIXTURE recipe, not against `service_recovery`: that recipe
 * declares neither kind, and E1's and E2's contracts require its dispatch to be
 * bit-for-bit unchanged by this wave. The fixture is what proves these branches
 * are reachable at all.
 *
 * The clock is injected, never read: "already past" and "clock skew" are the two
 * cases a timed wait gets wrong, and neither is testable against `Date.now()`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition } from './recipes/types';

const fixtureRecipe = {
  key: 'fixture_identity', version: 1, promptVersion: 'fixture/v1',
  gateClass: 'deterministic', targetKinds: ['contact'], requires: [],
  inputSchema: { parse: (v: unknown) => v } as never,
  steps: {
    confirm_identity: { kind: 'human_work', phase: 'plan' },
    wait_cutoff: { kind: 'wait', phase: 'execute' },
    discover: { kind: 'probe', phase: 'execute' },
  },
  permittedNextSteps: {},
  bounds: {
    maxReasoningRuns: 4, maxMutationAttempts: 2, freshnessSeconds: 120,
    observeWakeAfterMs: 1000, verificationWakeAfterMs: 1000,
    unknownEffectHorizonMs: 1000, deadlineMs: 1000,
  },
  buildPlan: () => [], operationKey: () => 'fixture',
} as unknown as RecipeDefinition<never>;

describe('advanceHumanWork (spec §6.5)', () => {
  it('opens the step and waits on the checklist item when no step row exists yet', async () => { /* … */ });

  it('re-reads the item authoritatively and keeps waiting while done_at is null', async () => {
    // Invariant 2: the wake payload said "an answer arrived"; the row is what
    // decides. A wake can be a duplicate, a retry, or the reconciler's poll.
  });

  it('settles the step SUCCEEDED with the completing user and timestamp as the evidence', async () => {
    // Spec §6.5: "Evidence is the completing user id and timestamp — never
    // model-graded free text."
  });

  it('advances to checkpoint.resumeStepKey with THAT step definition phase', async () => { /* … */ });

  it('hands off — never spins — when the link has been detached (checklist_item_id NULL)', async () => {
    // A ticket org-move or an org merge nulls the pointer. Waiting on a row in
    // another tenant forever is the failure this branch exists to prevent.
  });

  it('hands off when the item row is unreadable in the TASK\'s org (a moved ticket)', async () => { /* … */ });

  it('fails loudly when resumeStepKey is absent — a recipe bug is never guessed', async () => { /* … */ });

  it('fails when resumeStepKey names a step the recipe does not declare', async () => { /* … */ });
});

describe('advanceWait (spec §6.1 wait row, §6.3 wait_cutoff)', () => {
  it('writes next_wake_at = waitUntil and yields with reason maintenance_window', async () => { /* … */ });

  it('advances IMMEDIATELY when waitUntil is already past — a past cutoff is not an error', async () => {
    // The common case after a lost wake or a slow queue, and the one a naive
    // `setTimeout(until - now)` gets wrong by sleeping a negative interval.
  });

  it('clamps a NEGATIVE wake interval to a minimum rather than yielding into the past', async () => {
    // Clock skew between the API pod and Postgres is real. `wakeAfterMs` is
    // added to the coordinator's own `now`, so a skewed `waitUntil` must not
    // produce a wake that is already due and re-enters in a tight loop.
  });

  it('fails when waitUntil is absent or unparseable, naming the step', async () => { /* … */ });
});
```

> Fill each `/* … */` with the assertion the title states, using `vi.mock` for `./humanWorkService`, `./stepService` and `./eventService` and a stubbed `db` for the CAS. The titles ARE the specification; do not weaken one to make a stub easier.

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/taskCoordinatorHumanWork.test.ts`
Expected: FAIL — `advanceHumanWork` / `advanceWait` are not exported from `./taskCoordinator`.

- [ ] **Step 3: Add the two advancers, immediately below `writeLeasedStep` (`taskCoordinator.ts:~886`)**

```ts
// ---------------------------------------------------------------------------
// Generic step kinds (Recipe Library wave E3, spec §6.1's step-kind table).
//
// These two are EXPORTED, unlike every other advancer in this file, for one
// reason: no recipe in this build declares a `human_work` or `wait` step, so
// the only way to exercise them against real Postgres is for the integration
// suite to call them directly with a locally-built RecipeDefinition fixture. An
// un-exercisable branch is an unshipped branch.
// ---------------------------------------------------------------------------

/** Never yield into the past. Guards against API-pod/Postgres clock skew. */
const MIN_WAIT_WAKE_MS = 1000;

/**
 * `human_work` — create or attach a checklist item and wait for a person.
 *
 * ONE implementation for every recipe, which is why it is dispatched by KIND
 * rather than per recipe: "put the work on the ticket and wait for a human to
 * tick it" has no per-recipe variation, and a copy per recipe would eventually
 * disagree about what counts as evidence.
 *
 * THE EVIDENCE IS THE ROW, NOT THE WAKE. Every decision below re-reads
 * `ai_operator_task_steps` joined to `ticket_checklist_items` within the TASK's
 * org (invariant 2). That org predicate is what turns a ticket org-move into a
 * clean handoff instead of a task waiting forever on a row in another tenant.
 */
export async function advanceHumanWork(args: {
  task: AiOperatorTaskRow;
  leaseEpoch: number;
  checkpoint: TaskCheckpoint;
  recipe: RecipeDefinition<never>;
  now: Date;
}): Promise<string> {
  const { task, leaseEpoch, checkpoint, recipe, now } = args;
  const stepKey = task.currentStepKey ?? '';
  const definition = recipe.steps[stepKey];

  const existing = await readHumanWorkStep(task.orgId, task.id, stepKey, task.attemptOrdinal);

  // Nothing opened yet — open it and wait.
  if (!existing) {
    const opened = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        openHumanWorkStep(db, {
          task: {
            id: task.id, orgId: task.orgId, objective: task.objective,
            revision: task.revision, attemptOrdinal: task.attemptOrdinal,
          },
          stepKey,
          // The criterion the recipe froze for this step, if it gave one;
          // otherwise the step key, which is at least honest.
          label: definition?.inputSchema ? stepKey : stepKey,
          detail: null,
          remindAfterMs: HUMAN_WORK_REMIND_AFTER_MS,
          now,
        })));

    await yieldToWait({
      task, leaseEpoch, reason: 'information',
      dependency: { kind: 'user_answer', id: opened.checklistItemId },
      wakeAfterMs: HUMAN_WORK_POLL_WAKE_MS, stepKey, checkpoint, now,
    });
    return `waiting: human work '${stepKey}' on ticket ${opened.ticketId}`;
  }

  // The link is gone: a ticket org-move, an org merge, or an erased item. The
  // dependency can never resolve, so waiting is not an option and guessing that
  // the work happened is not either.
  if (!existing.checklistItemId || existing.itemLabel === null) {
    await settle({
      task, leaseEpoch, event: 'hand_off', outcome: 'unresolved', checkpoint,
      detail: `the checklist item for human-work step '${stepKey}' is no longer reachable from this task`,
      handoffSummary:
        `The ticket step this task was waiting on is no longer part of this organization `
        + `(it was moved or removed). Nothing further was changed. Confirm the remaining work by hand.`,
    });
    return `handed off: human work '${stepKey}' detached`;
  }

  // Still waiting. RE-ARM the polling fallback rather than returning: the lease
  // was claimed to get here, and leaving it held would make the waiting-age
  // metric lie and block every other coordinator for the length of the wait.
  if (!existing.itemDoneAt) {
    await yieldToWait({
      task, leaseEpoch, reason: 'information',
      dependency: { kind: 'user_answer', id: existing.checklistItemId },
      wakeAfterMs: HUMAN_WORK_POLL_WAKE_MS, stepKey, checkpoint, now,
    });
    return `waiting: human work '${stepKey}' not yet ticked`;
  }

  // Done. The evidence is the completing user and the timestamp — never
  // model-graded free text (spec §6.5).
  const resumeStepKey = checkpoint.resumeStepKey;
  if (!resumeStepKey || !recipe.steps[resumeStepKey]) {
    await settle({
      task, leaseEpoch, event: 'fail', outcome: 'unresolved', checkpoint,
      detail: resumeStepKey
        ? `human-work step '${stepKey}' names a resume step '${resumeStepKey}' that ${recipe.key} does not declare`
        : `human-work step '${stepKey}' completed but the recipe recorded no resume step`,
    });
    return `failed: human work '${stepKey}' has no usable resume step`;
  }

  await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      await settleStep(db, {
        orgId: task.orgId, taskId: task.id, stepKey,
        attemptOrdinal: task.attemptOrdinal, targetId: null,
        state: 'succeeded',
        detail: `completed by user ${existing.itemDoneByUserId ?? 'unknown'} at ${existing.itemDoneAt?.toISOString()}`,
        actor: { kind: 'coordinator' },
      });
      await appendTaskEvent(db, {
        orgId: task.orgId, taskId: task.id,
        eventType: 'wait_resolved', actor: { kind: 'coordinator' }, stepKey,
        detail: `human work '${stepKey}' ticked by user ${existing.itemDoneByUserId ?? 'unknown'}`,
      });
    }));

  await writeLeasedStep(
    task, leaseEpoch, resumeStepKey, recipe.steps[resumeStepKey]!.phase, checkpoint,
  );
  return `advanced: human work '${stepKey}' done, resuming at '${resumeStepKey}'`;
}

/**
 * `wait` — sleep until a wall-clock time, then continue.
 *
 * The whole implementation is `next_wake_at = waitUntil` plus the poller that
 * already exists (`ai_operator_tasks_wake_idx`, the reconciler's set 2). There
 * is deliberately no timer, no job delay and no in-process sleep: a maintenance
 * window can be days away, and the one property that matters is that a worker
 * restart loses nothing.
 */
export async function advanceWait(args: {
  task: AiOperatorTaskRow;
  leaseEpoch: number;
  checkpoint: TaskCheckpoint;
  recipe: RecipeDefinition<never>;
  now: Date;
}): Promise<string> {
  const { task, leaseEpoch, checkpoint, recipe, now } = args;
  const stepKey = task.currentStepKey ?? '';

  const until = checkpoint.waitUntil ? new Date(checkpoint.waitUntil) : null;
  if (!until || Number.isNaN(until.getTime())) {
    await settle({
      task, leaseEpoch, event: 'fail', outcome: 'unresolved', checkpoint,
      detail: `wait step '${stepKey}' has no usable scheduled time`,
    });
    return `failed: wait '${stepKey}' has no scheduled time`;
  }

  const resumeStepKey = checkpoint.resumeStepKey;
  if (!resumeStepKey || !recipe.steps[resumeStepKey]) {
    await settle({
      task, leaseEpoch, event: 'fail', outcome: 'unresolved', checkpoint,
      detail: `wait step '${stepKey}' records no resume step this recipe declares`,
    });
    return `failed: wait '${stepKey}' has no usable resume step`;
  }

  // ALREADY PAST is the ordinary case, not an error: a lost wake, a slow queue,
  // or a window that opened while the task was waiting on something else. Move
  // on immediately rather than treating a stale timestamp as a fault.
  if (until.getTime() <= now.getTime()) {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        settleStep(db, {
          orgId: task.orgId, taskId: task.id, stepKey,
          attemptOrdinal: task.attemptOrdinal, targetId: null,
          state: 'succeeded',
          detail: `scheduled time ${until.toISOString()} reached`,
          actor: { kind: 'coordinator' },
        })));
    await writeLeasedStep(
      task, leaseEpoch, resumeStepKey, recipe.steps[resumeStepKey]!.phase, checkpoint,
    );
    return `advanced: wait '${stepKey}' window open, resuming at '${resumeStepKey}'`;
  }

  // CLAMPED. `yieldToWait` computes `next_wake_at` as `now + wakeAfterMs` from
  // the coordinator's own clock, so a `waitUntil` skewed against Postgres could
  // otherwise produce a wake that is already due and re-enter in a tight loop.
  const wakeAfterMs = Math.max(MIN_WAIT_WAKE_MS, until.getTime() - now.getTime());
  await yieldToWait({
    task, leaseEpoch, reason: 'maintenance_window',
    dependency: null, wakeAfterMs, stepKey, checkpoint, now,
  });
  return `waiting: '${stepKey}' until ${until.toISOString()}`;
}
```

with, at the top of the file, `HUMAN_WORK_REMIND_AFTER_MS` declared beside the other module constants:

```ts
/**
 * How long a human-work step waits before it is reported overdue (spec §6.5).
 * 24 hours: long enough not to nag a technician who picked the ticket up this
 * afternoon, short enough that a fortnight-long identity task does not sit on
 * one uncollected laptop for a week in silence.
 */
const HUMAN_WORK_REMIND_AFTER_MS = 24 * 60 * 60 * 1000;
```

and the imports `import { HUMAN_WORK_POLL_WAKE_MS, openHumanWorkStep, readHumanWorkStep } from './humanWorkService';`, `import { settleStep } from './stepService';`, `import { appendTaskEvent } from './eventService';` (E2 may already have added the last two — do not duplicate them).

- [ ] **Step 4: Add the KIND fallback to the dispatch tail**

Immediately after E1's `RECIPE_ADVANCERS` declaration, add:

```ts
/**
 * Step kinds whose execution is IDENTICAL for every recipe.
 *
 * E1's `RECIPE_ADVANCERS` is keyed `[recipeKey][stepKey]` because `reason`,
 * `effect`, `probe` and `document` genuinely differ per recipe — what to admit,
 * what to dispatch, what to probe. `human_work` and `wait` do not: "put the
 * work on the ticket and wait for a person" and "sleep until a timestamp" have
 * exactly one correct implementation, and a per-recipe copy of either would be
 * paste that eventually diverges about what counts as evidence.
 *
 * Consulted ONLY after the per-recipe table misses, so a recipe that genuinely
 * needs to override one still can — and `service_recovery`, which declares
 * neither kind, dispatches through exactly the path E1 gave it.
 */
const KIND_ADVANCERS: Readonly<Partial<Record<StepKind, StepAdvancer>>> = {
  human_work: advanceHumanWork,
  wait: advanceWait,
};
```

and change E1's lookup line from

```ts
  const advance = RECIPE_ADVANCERS[recipe.key]?.[stepKey];
```

to

```ts
  const advance =
    RECIPE_ADVANCERS[recipe.key]?.[stepKey]
    ?? KIND_ADVANCERS[recipe.steps[stepKey]?.kind as StepKind];
```

> The `detail` and the returned string of the `if (!advance)` branch below it are **unchanged** — `aiOperatorCoordinator.integration.test.ts` asserts against them.

- [ ] **Step 5: Hand off — not fail — when a human-work step hits the task deadline**

In the deadline branch (`taskCoordinator.ts:419-436`), insert between the `unsettled` handoff and the final `settle({ event: 'fail' })`:

```ts
    // Spec §6.5: "past the task deadline the task hands off, it does not fail."
    // Scoped to human_work ON PURPOSE. The generic branch below is shipped
    // behaviour that aiOperatorCoordinator.integration.test.ts pins for
    // service_recovery, and a task that ran out of time waiting on a MODEL is a
    // different story from one that ran out of time waiting on a PERSON: the
    // second has real, half-finished work on a real ticket, and the technician
    // needs the remaining items named, not an `unresolved` failure.
    const deadlineStepKind = task.currentStepKey
      ? getRecipe(task.workflowKey, task.workflowVersion)?.steps[task.currentStepKey]?.kind
      : undefined;
    if (deadlineStepKind === 'human_work') {
      await settle({
        task, leaseEpoch, event: 'hand_off', outcome: 'unresolved', checkpoint,
        detail: `task deadline passed while waiting on a person for step '${task.currentStepKey}'`,
        handoffSummary:
          `The deadline passed while this task was waiting for someone to complete '${task.currentStepKey}' `
          + `on its ticket. The remaining checklist steps are still on the ticket and are still the work. `
          + `Nothing was undone.`,
      });
      return 'handed off: deadline on human work';
    }
```

- [ ] **Step 6: Run green, and re-prove `service_recovery` is untouched**

Run: `cd apps/api && npx vitest run src/services/aiOperator/`
Expected: PASS for every file in the directory, **including E1's unmodified `recipes/serviceRecovery.test.ts` and E1's `taskCoordinator.recipeResolution.test.ts`**. If any pre-existing coordinator test changed behaviour, the KIND fallback or the deadline branch leaked into a path `service_recovery` uses — fix the code, not the test.

Run: `git diff --stat -- apps/api/src/services/aiOperator/recipes/`
Expected: empty output. This wave changes no recipe.

- [ ] **Step 7: Commit**

```
git add apps/api/src/services/aiOperator/taskCoordinator.ts apps/api/src/services/aiOperator/taskCoordinatorHumanWork.test.ts
git commit -m "$(cat <<'EOF'
feat(api): coordinator advancers for human_work and wait, dispatched by kind (E3)

Spec §6.1's step-kind table taken literally: these two kinds have one
implementation across every recipe, so they sit in a kind-keyed fallback
consulted only after E1's per-recipe table misses. service_recovery's dispatch
is unchanged. A human-work step that outlives the task deadline hands off.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Detach on the ticket org-move axis and on org merge

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` (`moveTicketOrg`, beside the `aiAgentRuns.ticketId` sever at `~:2765`)
- Modify: `apps/api/src/services/orgMergeCustomExecutors.ts` (`fenceAiOperatorTasks`, extended by E2)
- Modify: `apps/api/src/services/ticketService.test.ts` (or the existing `moveTicketOrg` suite)

**Interfaces:**
- Consumes: `detachHumanWorkLinksForTicket` (`./aiOperator/humanWorkService`).
- Produces: no new export; two call sites.

**Why this is its own task and why it is load-bearing.** `ticket_checklist_items.org_id` is re-stamped by `moveTicketOrg`'s `TICKET_ORG_DENORMALIZED_TABLES` loop (`ticketService.ts:2868-2872`). `ai_operator_task_steps.org_id` is immutable task history. After the move the two rows are in different orgs, and **nothing in the database forces the issue**: the link FK is plain and single-column (D1), so the UPDATE completes happily and the stale pointer survives in silence. There is also no Postgres trigger on `UPDATE OF org_id ON tickets` — the ticket axis has no equivalent of `breeze_cascade_device_org_id()`. This service is therefore the **only** place the contract is enforced, which is verbatim the situation the shipped `ai_agent_runs.ticket_id` sever documents two dozen lines above where this one goes (`ticketService.ts:2739-2749`).

- [ ] **Step 1: Write the failing test**

```ts
// in apps/api/src/services/ticketService.test.ts (the moveTicketOrg describe block)
it('detaches every live Operator human-work link on the moved ticket, BEFORE the org re-stamp', async () => {
  // Ordering is asserted, not incidental. The detach reads
  // ticket_checklist_items by ticket_id and compares nothing about org, so it
  // works either side of the re-stamp — but running it FIRST keeps the lock
  // order identical to the ai_agent_runs sever it sits beside, and a
  // divergent lock order between the ticket and device axes is exactly what
  // #4657 was.
  await moveTicketOrg('ticket-1', 'org-dest', { userId: 'user-1' });
  expect(detachHumanWorkLinksForTicket).toHaveBeenCalledTimes(1);
  expect(detachHumanWorkLinksForTicket.mock.calls[0]?.[1]).toMatchObject({
    ticketId: 'ticket-1', reason: expect.stringContaining('moved'),
  });
  const detachIndex = statementLog.indexOf('detachHumanWorkLinks');
  const restampIndex = statementLog.indexOf('ticket_checklist_items org_id');
  expect(detachIndex).toBeGreaterThan(-1);
  expect(detachIndex).toBeLessThan(restampIndex);
});

it('passes the mover\'s own transaction handle, so a rolled-back move detaches nothing', async () => {
  // A detach committed outside the move's transaction would strand a task on a
  // move that never happened.
  expect(detachHumanWorkLinksForTicket.mock.calls[0]?.[0]).toBe(txHandle);
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/ticketService.test.ts`
Expected: FAIL — `detachHumanWorkLinksForTicket` never called.

- [ ] **Step 3: Wire `moveTicketOrg`**

In `moveTicketOrg`'s transaction, immediately AFTER the `aiAgentRuns.ticketId` sever (`ticketService.ts:2765-2769`) and before the `deviceVulnerabilities` detach:

```ts
    // AI Operator human-work links (recipe library E3). The ticket's checklist
    // items are re-stamped to the destination org by the
    // TICKET_ORG_DENORMALIZED_TABLES loop below; the Operator step rows that
    // point at them are NOT — `ai_operator_task_steps.org_id` is its task's
    // org and is immutable history, exactly like `ai_agent_runs.org_id` two
    // statements above. So after the move a live human-work step would be
    // waiting on a checklist item in another tenant, and, because the link FK
    // is plain and single-column ON DELETE SET NULL (migration
    // 2026-10-19-100100 header note A), NOTHING would raise: the task would
    // simply wait until its deadline with no error anywhere.
    //
    // DETACH, never re-stamp — E2's rule for task targets, one level down. The
    // helper also enqueues a `user_answer` wake per affected task, so the
    // coordinator's authoritative re-read turns this into a classified handoff
    // instead of a silent stall. It deliberately does NOT settle the task:
    // that is a leased transition and this transaction holds no lease.
    //
    // Placed here, before the tickets UPDATE, to match the lock order the
    // ai_agent_runs sever establishes on both axes (#4657).
    const detachedHumanWork = await detachHumanWorkLinksForTicket(tx, {
      ticketId,
      reason: `ticket moved to another organization (${targetOrgId})`,
    });
    if (detachedHumanWork > 0) {
      console.warn('[tickets] detached AI Operator human-work links on an org move',
        `ticketId=${ticketId}`, `count=${detachedHumanWork}`);
    }
```

with `import { detachHumanWorkLinksForTicket } from './aiOperator/humanWorkService';`.

- [ ] **Step 4: Wire the org-merge fence**

In `apps/api/src/services/orgMergeCustomExecutors.ts`, inside `fenceAiOperatorTasks` (which E2 extended with the target/account detaches), append the human-work arm:

```ts
  // Human-work links (recipe library E3). Org merge re-points the loser org's
  // tickets — and therefore its checklist items — at the survivor, while task
  // and step `org_id` stay on the loser. E2 recorded the same finding for
  // contacts, and drew the same conclusion: the fence must detach in the
  // RESOLVE phase, before the move phase re-points anything, or the pointer
  // spans two orgs for the length of the merge transaction.
  //
  // One statement rather than a per-ticket loop: a merge can carry thousands of
  // tickets, and the helper's per-row event/outbox writes are the point of the
  // request path, not of a bulk merge. The fence below already stops every one
  // of these tasks from advancing, so the wake the request path would enqueue
  // would be a no-op here anyway.
  await tx.execute(sql`
    UPDATE ai_operator_task_steps s
       SET checklist_item_id = NULL, updated_at = now()
      FROM ticket_checklist_items i
     WHERE i.id = s.checklist_item_id
       AND s.org_id = ${loserOrgId}::uuid
       AND s.settled_at IS NULL
  `);
```

> Use whatever identifiers `fenceAiOperatorTasks` already binds for the transaction handle and the loser org id; do not introduce new ones.

- [ ] **Step 5: Run green**

Run: `cd apps/api && npx vitest run src/services/ticketService.test.ts src/services/orgMergeCustomExecutors.test.ts src/services/ticketOrgMoveLockOrder.test.ts`
Expected: PASS. `ticketOrgMoveLockOrder.test.ts` must still pass **without any list edit** — this wave adds no table to either axis, and if that suite now fails, something was added to a list that should not have been.

- [ ] **Step 6: Commit**

```
git add apps/api/src/services/ticketService.ts apps/api/src/services/orgMergeCustomExecutors.ts apps/api/src/services/ticketService.test.ts apps/api/src/services/orgMergeCustomExecutors.test.ts
git commit -m "$(cat <<'EOF'
fix(api): detach Operator human-work links on ticket org-move and org merge (E3)

The item's org_id is re-stamped, the step's is immutable task history, and the
plain FK raises nothing — so this service is the only place the contract is
enforced. Detach and wake; the coordinator's re-read hands the task off.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Overdue human work — the reconciler's fifth scan

**Files:**
- Modify: `apps/api/src/services/aiOperator/taskReconciler.ts` (`ReconcilerPassResult` :102-107, `runReconcilerPass` :116-131, a new scan beside the four)
- Modify: `apps/api/src/services/aiOperator/humanWorkService.ts` (the reminder writer)
- Modify: `apps/api/src/jobs/aiOperatorTaskWorker.ts:71-77` (the tick's `handled` string)
- Create: `apps/api/src/services/aiOperator/humanWorkReminders.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // humanWorkService.ts
  export interface OverdueHumanWorkRow { stepId: string; orgId: string; taskId: string; stepKey: string; ticketId: string; label: string; }
  export async function sendHumanWorkReminders(now?: Date): Promise<number>;
  // taskReconciler.ts
  ReconcilerPassResult gains `humanWorkReminders: number`
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/humanWorkReminders.test.ts
/**
 * Recipe spec §6.5: "a human-work step past its `remind_after` writes a ticket
 * comment and a notification; past the task deadline the task hands off, it
 * does not fail."
 *
 * The second half is Task 7's deadline branch. This file owns the first half,
 * and the assertion that matters most is the ONE: the coordinator tick runs
 * every 15 s (COORDINATOR_TICK_INTERVAL_MS), so a reminder that does not stamp
 * `reminded_at` would post four ticket comments a minute for the life of the
 * step. That is not a cosmetic bug — it is a ticket a technician stops reading.
 */
import { describe, expect, it, vi } from 'vitest';

describe('sendHumanWorkReminders (spec §6.5)', () => {
  it('posts ONE internal ticket comment and ONE notification per overdue step', async () => { /* … */ });

  it('stamps reminded_at in the same statement scope, so the next tick skips the row', async () => { /* … */ });

  it('never posts a PUBLIC comment — the customer is not the audience for internal chasing', async () => {
    // isPublic: false and commentType: 'internal'.
  });

  it('writes the comment with a NULL user id and an ai_agent author, never a synthetic user', async () => {
    // The Operator is not a `users` row; ticket_comments.user_id is a real FK.
  });

  it('links the notification to the TICKET, with a relative path', async () => {
    // user_notifications.link carries a CHECK constraint requiring a relative
    // same-origin path.
  });

  it('skips a step whose task is no longer waiting', async () => { /* … */ });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/humanWorkReminders.test.ts`
Expected: FAIL — `sendHumanWorkReminders` is not exported.

- [ ] **Step 3: Add the reminder writer to `humanWorkService.ts`**

```ts
/**
 * Report every overdue human-work step, once.
 *
 * WHY A DIRECT `ticketComments` INSERT rather than `addTicketComment` or
 * `addAiTriageNote`:
 *  - `addTicketComment` requires a `TicketActor` with a non-null `userId`
 *    (ticketService.ts:82-84) and the Operator is not a `users` row.
 *  - `addAiTriageNote` (ticketService.ts:1662) DOES accept a null user id, but
 *    it is keyed on an `ai_agent_runs.id` and is idempotent per run
 *    (`ticket_comments_one_ai_note_per_run_uq`), so a second reminder for the
 *    same run would silently return the FIRST comment. A reminder is not a
 *    per-run artifact.
 * The direct insert is the shape `moveTicketOrg` already uses for its own
 * system feed entry (ticketService.ts:~2876).
 *
 * `reminded_at` is stamped for every row this pass touches, BEFORE the
 * side-effects, so a notification that throws cannot turn into a reminder loop
 * — an unsent reminder is a smaller failure than a ticket nobody reads.
 */
export async function sendHumanWorkReminders(now: Date = new Date()): Promise<number> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const overdue = await db
        .select({
          stepId: aiOperatorTaskSteps.id,
          orgId: aiOperatorTaskSteps.orgId,
          taskId: aiOperatorTaskSteps.taskId,
          stepKey: aiOperatorTaskSteps.stepKey,
          ticketId: ticketChecklistItems.ticketId,
          label: ticketChecklistItems.label,
          requesterUserId: aiOperatorTasks.requesterUserId,
        })
        .from(aiOperatorTaskSteps)
        .innerJoin(ticketChecklistItems, and(
          eq(ticketChecklistItems.id, aiOperatorTaskSteps.checklistItemId),
          eq(ticketChecklistItems.orgId, aiOperatorTaskSteps.orgId),
        ))
        .innerJoin(aiOperatorTasks, and(
          eq(aiOperatorTasks.id, aiOperatorTaskSteps.taskId),
          eq(aiOperatorTasks.orgId, aiOperatorTaskSteps.orgId),
        ))
        .where(and(
          eq(aiOperatorTaskSteps.stepKind, 'human_work'),
          eq(aiOperatorTaskSteps.state, 'waiting'),
          isNull(aiOperatorTaskSteps.remindedAt),
          isNotNull(aiOperatorTaskSteps.remindAfterAt),
          lte(aiOperatorTaskSteps.remindAfterAt, now),
          isNull(ticketChecklistItems.doneAt),
          eq(aiOperatorTasks.state, 'waiting'),
        ))
        .limit(HUMAN_WORK_REMINDER_SCAN_LIMIT);

      for (const row of overdue) {
        await db
          .update(aiOperatorTaskSteps)
          .set({ remindedAt: now, updatedAt: now })
          .where(eq(aiOperatorTaskSteps.id, row.stepId));

        await db.insert(ticketComments).values({
          ticketId: row.ticketId,
          userId: null,
          authorName: OPERATOR_TASK_ACTOR.name,
          authorType: 'ai_agent',
          originPrincipalKind: 'ai_agent',
          commentType: 'internal',
          isPublic: false,
          content:
            `This AI Operator task is still waiting on a person for "${row.label}". `
            + `Tick that checklist step once the work is done and the task will carry on by itself.`,
        });

        if (row.requesterUserId) {
          await createNotification({
            userId: row.requesterUserId,
            orgId: row.orgId,
            type: 'ai',
            priority: 'normal',
            title: 'An Operator task is waiting on you',
            message: row.label.slice(0, 500),
            // Relative, same-origin — `user_notifications.link` has a CHECK
            // constraint requiring it.
            link: `/tickets/${row.ticketId}`,
            // One reminder per step, ever. The scan's `reminded_at` filter is
            // the first guard; this is the second, and it survives a row that
            // is somehow re-selected after a manual reset.
            dedupeKey: `operator-human-work:${row.stepId}`,
          });
        }

        await appendTaskEvent(db, {
          orgId: row.orgId, taskId: row.taskId,
          eventType: 'wait_entered', actor: { kind: 'reconciler' }, stepKey: row.stepKey,
          detail: `human work overdue; reminder posted on ticket ${row.ticketId}`,
        });
      }

      return overdue.length;
    }));
}
```

with `const HUMAN_WORK_REMINDER_SCAN_LIMIT = 50;` beside the other constants (matching the reconciler's own bounded-scan discipline) and the imports `createNotification` (`../userNotifications`), `ticketComments` (`../../db/schema`), `runOutsideDbContext` / `withSystemDbAccessContext` (`../../db`), `lte` / `isNotNull` (`drizzle-orm`).

> `createNotification`'s own docblock (`userNotifications.ts:50-58`) requires `runOutsideDbContext(() => withSystemDbAccessContext(...))` because `withSystemDbAccessContext` is a PASSTHROUGH under an existing ambient context. The wrapper above satisfies that for the whole scan, so **do not add a second one per call**.

- [ ] **Step 4: Add the fifth scan to the reconciler**

`taskReconciler.ts` — add `humanWorkReminders: number;` to `ReconcilerPassResult` (`:102-107`), initialise it to 0 in `runReconcilerPass` (`:117-122`), and add one line after `settleTerminalUnsettled` (`:127`):

```ts
  // SET 5 — human-work steps past their reminder clock (recipe library E3).
  //
  // Here rather than in a queue of its own: it is a 15 s sweep over a partial
  // index (`ai_operator_task_steps_human_work_remind_idx`) that is empty
  // almost always, and the tick is already the thing that owns "notice what the
  // event path did not". It runs LAST so a slow reminder (a ticket insert and a
  // notification per row) can never delay the four recovery scans, which are
  // what keep tasks moving at all.
  result.humanWorkReminders = await sendHumanWorkReminders(now);
```

with `import { sendHumanWorkReminders } from './humanWorkService';`.

`apps/api/src/jobs/aiOperatorTaskWorker.ts:71-77` — extend the `handled` string with ` reminders=${pass.humanWorkReminders}`.

- [ ] **Step 5: Run green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/humanWorkReminders.test.ts src/services/aiOperator/taskReconciler.test.ts src/jobs/aiOperatorTaskWorker.test.ts`
Expected: PASS. If `taskReconciler.test.ts` asserts the exact shape of `ReconcilerPassResult`, extend that assertion — the new counter is part of the contract, not an accident.

- [ ] **Step 6: Commit**

```
git add apps/api/src/services/aiOperator/humanWorkService.ts apps/api/src/services/aiOperator/humanWorkReminders.test.ts apps/api/src/services/aiOperator/taskReconciler.ts apps/api/src/jobs/aiOperatorTaskWorker.ts
git commit -m "$(cat <<'EOF'
feat(api): remind once when an Operator human-work step goes overdue (E3)

Fifth reconciler scan over a partial index, last in the pass so it can never
delay the four recovery scans. reminded_at is stamped before the side-effects
because the tick runs every 15 seconds.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The guard — no AI Operator code path ever writes `done_at`

**Files:**
- Create: `apps/api/src/services/aiOperator/humanWorkPurity.test.ts`

**Interfaces:**
- Consumes: the source text of every `.ts` file under `apps/api/src/services/aiOperator/`.
- Produces: a contract test that fails the moment any Operator code can complete a checklist item.

**Why the red step here is a MUTATION, not a missing module.** The rule already holds when the guard is written, so a new guard passes on its first run — which proves nothing. Step 2 temporarily breaks the rule and watches the guard catch it. A guard nobody has seen fail is a guard nobody knows works. (Same reasoning as E1's `recipes/purity.test.ts`.)

- [ ] **Step 1: Write the guard**

```ts
// apps/api/src/services/aiOperator/humanWorkPurity.test.ts
/**
 * Recipe Library spec §6.5, the sentence this whole wave hangs on:
 *
 *   "`patchChecklistItem` stays human-only: the Operator creates items and
 *    never completes them."
 *
 * A checklist tick is a human attestation on a compliance artifact. The route
 * already refuses a non-interactive session for the `done` branch
 * (routes/tickets/checklist.ts:74-82) — but that gate protects the HTTP path,
 * and this wave gives the Operator direct, in-process database access to the
 * very table that gate protects. Nothing in a diff review reliably catches a
 * `doneAt:` added to a service file six months from now (CLAUDE.md's
 * registration-list history: review 0/5, contract tests 5/5).
 *
 * So the rule is mechanical: NO file under `services/aiOperator/` may name
 * `doneAt`, `done_at`, `doneByUserId` or `done_by_user_id` on the left of an
 * assignment or inside a `.set({...})`. Reading the columns is fine and
 * necessary — `advanceHumanWork` settles on exactly that evidence.
 *
 * The extractor throws when it finds no files, so a directory move cannot make
 * this suite vacuously green.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const OPERATOR_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Every `.ts` under services/aiOperator/, recursively, excluding test files. */
function operatorSourceFiles(dir: string = OPERATOR_DIR): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...operatorSourceFiles(full)); continue; }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * A WRITE of one of the completion columns. Matches an object-literal property
 * assignment (`doneAt: x`, `done_at: x`) and a bare assignment
 * (`row.doneAt = x`). Deliberately does NOT match a read (`row.doneAt`,
 * `eq(items.doneAt, …)`, `isNull(items.doneAt)`), which is what the coordinator
 * legitimately does.
 */
const COMPLETION_WRITE =
  /\b(doneAt|done_at|doneByUserId|done_by_user_id)\s*(:(?!\s*(string|Date|number|boolean|null|\|))|=(?!=))/g;

describe('the AI Operator never completes a checklist item (spec §6.5)', () => {
  const files = operatorSourceFiles();

  it('finds the files it is supposed to be guarding', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith('humanWorkService.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('taskCoordinator.ts'))).toBe(true);
  });

  it('no Operator source file writes done_at or done_by_user_id', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(COMPLETION_WRITE)) {
        const line = source.slice(0, match.index ?? 0).split('\n').length;
        offenders.push(`${file}:${line} — ${match[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the regex actually discriminates — it flags a write and ignores a read', () => {
    // A guard whose pattern matches nothing would pass the case above forever.
    expect('  .set({ doneAt: now })'.match(COMPLETION_WRITE)).not.toBeNull();
    expect('  .where(isNull(ticketChecklistItems.doneAt))'.match(COMPLETION_WRITE)).toBeNull();
  });

  it('ticketChecklistService is the ONLY module in the repo that writes those columns', () => {
    // The scope check: the rule above is worth nothing if a fifth service
    // outside services/aiOperator/ starts ticking items on the Operator's
    // behalf. Verified as a repo fact at planning time:
    //   grep -rln 'doneAt:' apps/api/src | grep -v '\.test\.'
    //   -> db/schema/ticketChecklists.ts, services/ticketChecklistService.ts
    // If this list grows, the new writer needs the same scrutiny the route's
    // isInteractiveUserSession gate gets.
    const roots = operatorSourceFiles(join(OPERATOR_DIR, '..'));
    const writers = roots.filter((f) => COMPLETION_WRITE.test(readFileSync(f, 'utf8')));
    expect(writers.map((f) => f.split('/').pop())).toEqual(['ticketChecklistService.ts']);
  });
});
```

> `COMPLETION_WRITE` carries the `g` flag, so `.test()` advances `lastIndex`. Reset it (`COMPLETION_WRITE.lastIndex = 0`) before each use in the last case, or build a fresh RegExp per file — a stateful regex silently skipping every other file is exactly the vacuous-guard failure this suite exists to prevent.

- [ ] **Step 2: Run it RED by mutation**

Temporarily add `doneAt: new Date(),` inside `openHumanWorkStep`'s checklist-item `.values({...})` in `humanWorkService.ts`.

Run: `cd apps/api && npx vitest run src/services/aiOperator/humanWorkPurity.test.ts`
Expected: FAIL, naming `humanWorkService.ts:<line> — doneAt:`. **If it passes, the guard is broken — fix the regex before reverting.**

- [ ] **Step 3: Revert the mutation and run green**

Remove the line you added. Confirm with `git diff -- apps/api/src/services/aiOperator/humanWorkService.ts` → empty.

Run: `cd apps/api && npx vitest run src/services/aiOperator/humanWorkPurity.test.ts`
Expected: PASS — 1 file, 4 tests.

- [ ] **Step 4: Commit**

```
git add apps/api/src/services/aiOperator/humanWorkPurity.test.ts
git commit -m "$(cat <<'EOF'
test(api): mechanical guard that no Operator path completes a checklist item

Spec §6.5. The route's interactive-session gate protects the HTTP path; this
wave gives the Operator in-process access to the same table, so the rule needs
a contract test rather than review. Proved red by mutation before shipping.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Web — the "Operator step" badge, the task link, and the MOUNT proof

**Files:**
- Modify: `apps/web/src/lib/api/ticketChecklist.ts:23-35` (`ChecklistItem`)
- Modify: `apps/web/src/components/tickets/TicketChecklistCard.tsx` (the read-mode `<li>` at `:383-446`, the `FRIENDLY` map at `:38-40`)
- Modify: `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/checklists.json`
- Modify: `apps/web/src/components/tickets/TicketChecklistCard.test.tsx`
- Modify: `apps/web/src/components/deliverables/OccurrenceDrawer.test.tsx`

**Interfaces:**
- Consumes: `ChecklistItemSource` (`@breeze/shared`, now four values), the API's `operatorTaskId` projection (Task 6).
- Produces: `ChecklistItem.operatorTaskId: string | null`; `data-testid="ticket-checklist-operator-badge-${id}"` and `data-testid="ticket-checklist-operator-link-${id}"`.

**This IS the mount task.** The badge lives inside `TicketChecklistCard`, which is already mounted at `TicketWorkbench.tsx:1637` (`<TicketChecklistCard ticketId={ticket.id} onCountsChange={setChecklistCounts} />`) and again at `OccurrenceDrawer.tsx:326` (`mode="compact"`). Both host suites matter: `TicketWorkbench.test.tsx:36` and `TicketWorkbench.checklistConfirm.test.tsx:26` **stub the card**, so they prove nothing about the badge — but `OccurrenceDrawer.test.tsx` does NOT stub it, which makes it the real second-mount proof. Step 5 asserts in both mount shapes. A component that renders only in its own suite is the failure mode a previous wave shipped thirteen times over.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/components/tickets/TicketChecklistCard.test.tsx`:

```tsx
describe('operator_task items (recipe spec §6.5)', () => {
  it('renders the Operator badge and a link to the task', async () => {
    const server = fakeServer([
      item({ id: 'it-op', label: 'Collect the laptop', source: 'operator_task', operatorTaskId: 'task-9' }),
    ]);
    fetchWithAuth.mockImplementation(server);
    render(<TicketChecklistCard ticketId="tk-1" />);
    expect(await screen.findByTestId('ticket-checklist-operator-badge-it-op')).toBeInTheDocument();
    const link = screen.getByTestId('ticket-checklist-operator-link-it-op');
    // The UI route, not the API path: /operator/tasks/:id (the href
    // DelegateToOperatorButton.tsx:115 already navigates to).
    expect(link).toHaveAttribute('href', '/operator/tasks/task-9');
  });

  it('renders the badge WITHOUT a link when the task is not resolvable', async () => {
    // operatorTaskId is null when the step lives in another org — a ticket that
    // has been moved between orgs. The badge still explains where the step came
    // from; the link would point into another tenant.
    const server = fakeServer([
      item({ id: 'it-moved', source: 'operator_task', operatorTaskId: null }),
    ]);
    fetchWithAuth.mockImplementation(server);
    render(<TicketChecklistCard ticketId="tk-1" />);
    expect(await screen.findByTestId('ticket-checklist-operator-badge-it-moved')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-checklist-operator-link-it-moved')).toBeNull();
  });

  it('shows no badge on a manual item', async () => {
    const server = fakeServer([item({ id: 'it-man', source: 'manual' })]);
    fetchWithAuth.mockImplementation(server);
    render(<TicketChecklistCard ticketId="tk-1" />);
    await screen.findByTestId('ticket-checklist-item-it-man');
    expect(screen.queryByTestId('ticket-checklist-operator-badge-it-man')).toBeNull();
  });

  it('still lets a human tick an operator_task item — the Operator waits on exactly this', async () => {
    // Guarding against an over-eager "it belongs to a robot, make it read-only".
    // The tick is the ONLY way a human_work step ever completes.
    const server = fakeServer([item({ id: 'it-op', source: 'operator_task', operatorTaskId: 'task-9' })]);
    fetchWithAuth.mockImplementation(server);
    render(<TicketChecklistCard ticketId="tk-1" />);
    const toggle = await screen.findByTestId('ticket-checklist-toggle-it-op');
    expect(toggle).not.toBeDisabled();
  });

  it('surfaces the 409 refusal when deleting an item a task is waiting on', async () => {
    // runClientAction + the FRIENDLY code map. A silent no-op here would look
    // to the technician exactly like a successful delete.
    // … drive the delete against a server that answers 409
    //   { error, code: 'CHECKLIST_OPERATOR_STEP_WAITING' } and assert showToast
    //   was called with the translated `errors.operatorStepWaiting` string.
  });
});
```

In `apps/web/src/components/deliverables/OccurrenceDrawer.test.tsx` (the suite that does NOT stub the card), extend its checklist fixture with one `source: 'operator_task', operatorTaskId: 'task-9'` item and assert:

```tsx
  it('renders the Operator badge inside the compact card too (the second mount site)', async () => {
    // TicketWorkbench stubs TicketChecklistCard, so this drawer is the only
    // host suite that proves the badge actually reaches a mounted page.
    expect(await screen.findByTestId('ticket-checklist-operator-badge-<id>')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them red**

Run: `cd apps/web && npx vitest run src/components/tickets/TicketChecklistCard.test.tsx src/components/deliverables/OccurrenceDrawer.test.tsx`
Expected: FAIL — no element with the badge testid.

- [ ] **Step 3: Extend the API client type**

`apps/web/src/lib/api/ticketChecklist.ts` — inside `ChecklistItem`, after `sourceTemplateItemId` (`:33`):

```ts
  /**
   * The AI Operator task behind a `source: 'operator_task'` item.
   *
   * Null when the server could not resolve the step in this item's org — which
   * is what a ticket moved between orgs looks like. The badge renders either
   * way; only the link is conditional, because a link built from a null id
   * would navigate to `/operator/tasks/null`.
   */
  operatorTaskId: string | null;
```

- [ ] **Step 4: Render the badge**

`apps/web/src/components/tickets/TicketChecklistCard.tsx` — inside the read-mode `<li>`, immediately after the label `<span>` (`:394`):

```tsx
        {item.source === 'operator_task' && (
          <span
            data-testid={`ticket-checklist-operator-badge-${item.id}`}
            className="ml-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
            title={t('operator.badgeTitle')}
          >
            {t('source.operator_task')}
            {item.operatorTaskId && (
              <a
                data-testid={`ticket-checklist-operator-link-${item.id}`}
                href={`/operator/tasks/${item.operatorTaskId}`}
                className="underline underline-offset-2"
              >
                {t('operator.viewTask')}
              </a>
            )}
          </span>
        )}
```

and add the refusal code to the `FRIENDLY` map (`:38-40`):

```ts
  CHECKLIST_OPERATOR_STEP_WAITING: 'errors.operatorStepWaiting',
```

**Deliberately NOT done:** the checkbox is not disabled for an `operator_task` item. A human ticking it is the only way a `human_work` step ever completes — disabling it would deadlock every identity task. The badge explains provenance; it does not restrict the action.

- [ ] **Step 5: Add REAL translations to all eight locales**

`apps/web/src/locales/<locale>/checklists.json` — `source.operator_task` slots into the existing `source` group (whose three siblings already exist and, per the audit, are currently referenced by no component — this is their first render), and `operator.*` / `errors.operatorStepWaiting` are new:

| key | en | de-DE | es-419 | fr-CA | fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|---|
| `source.operator_task` | Operator step | Operator-Schritt | Paso del Operador | Étape de l'Opérateur | Étape de l'Opérateur | Passaggio Operatore | Etapa do Operador | Operatör adımı |
| `operator.viewTask` | View task | Aufgabe ansehen | Ver tarea | Voir la tâche | Voir la tâche | Apri attività | Ver tarefa | Görevi aç |
| `operator.badgeTitle` | Created by an AI Operator task. Tick it when the work is done and the task continues. | Von einer KI-Operator-Aufgabe erstellt. Abhaken, wenn die Arbeit erledigt ist – die Aufgabe läuft dann weiter. | Creado por una tarea del Operador de IA. Márcalo cuando termines y la tarea continuará. | Créée par une tâche de l'Opérateur IA. Cochez-la une fois le travail fait et la tâche se poursuivra. | Créée par une tâche de l'Opérateur IA. Cochez-la une fois le travail fait et la tâche se poursuivra. | Creato da un'attività dell'Operatore IA. Spunta quando hai finito e l'attività riprende. | Criado por uma tarefa do Operador de IA. Marque quando concluir e a tarefa continua. | Bir yapay zekâ Operatör görevi oluşturdu. İş bitince işaretleyin, görev kendiliğinden devam eder. |
| `errors.operatorStepWaiting` | An Operator task is still waiting on this step, so it can't be deleted. Tick it when the work is done, or stop the task first. | Eine Operator-Aufgabe wartet noch auf diesen Schritt – er kann nicht gelöscht werden. Haken Sie ihn ab, wenn die Arbeit erledigt ist, oder stoppen Sie zuerst die Aufgabe. | Una tarea del Operador sigue esperando este paso, así que no se puede eliminar. Márcalo cuando termines o detén la tarea primero. | Une tâche de l'Opérateur attend encore cette étape : impossible de la supprimer. Cochez-la une fois le travail fait, ou arrêtez d'abord la tâche. | Une tâche de l'Opérateur attend encore cette étape : impossible de la supprimer. Cochez-la une fois le travail fait, ou arrêtez d'abord la tâche. | Un'attività dell'Operatore sta ancora aspettando questo passaggio, quindi non può essere eliminato. Spuntalo quando hai finito, oppure ferma prima l'attività. | Uma tarefa do Operador ainda depende desta etapa, então ela não pode ser excluída. Marque quando concluir, ou pare a tarefa antes. | Bir Operatör görevi hâlâ bu adımı bekliyor, bu yüzden silinemez. İş bitince işaretleyin ya da önce görevi durdurun. |

Real translations, not English copies — `apps/web/src/lib/i18n/translationCoverage.test.ts` counts identical-to-English strings per file against a budget (`'checklists.json'` appears at `:62`, `:195` and `:327`). Run that suite; if it fails on the budget rather than on a missing key, bump the affected number by the count of keys genuinely identical across those two locales (fr-CA and fr-FR share two strings above, which is legitimate) and say so in the PR body.

- [ ] **Step 6: Run green**

Run: `cd apps/web && npx vitest run src/components/tickets/TicketChecklistCard.test.tsx src/components/deliverables/OccurrenceDrawer.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS, 5 files. `keyUsage.test.ts` requires every key to be statically referenced — all four new keys are literal `t('…')` calls above, so no `/* i18n-dynamic */` marker is needed.

Run: `cd apps/web && npx vitest run src/components/tickets/`
Expected: PASS — confirms neither host suite regressed on the `ChecklistItem` type change.

- [ ] **Step 7: Commit**

```
git add apps/web/src/lib/api/ticketChecklist.ts apps/web/src/components/tickets/TicketChecklistCard.tsx apps/web/src/components/tickets/TicketChecklistCard.test.tsx apps/web/src/components/deliverables/OccurrenceDrawer.test.tsx apps/web/src/locales
git commit -m "$(cat <<'EOF'
feat(web): Operator step badge and task link on the ticket checklist (E3)

Rendered in both mount sites (the workbench card and the occurrence drawer's
compact card) and asserted in the drawer suite, which does not stub the card.
The checkbox stays enabled: a human ticking it is the only way a human_work
step ever completes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Integration tests against real Postgres as `breeze_app`

**Files (all NEW, all under `apps/api/src/__tests__/integration/` — a file placed anywhere else runs ZERO tests and reads green):**
- Create: `apps/api/src/__tests__/integration/aiOperatorHumanWorkStep.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/aiOperatorHumanWorkTenancy.integration.test.ts`

**Interfaces:**
- Consumes: `openHumanWorkStep`, `readHumanWorkStep`, `onChecklistItemDone`, `assertChecklistItemDeletable`, `detachHumanWorkLinksForTicket`, `sendHumanWorkReminders` (`services/aiOperator/humanWorkService`); `advanceHumanWork`, `advanceWait`, `claimTaskLease` (`services/aiOperator/taskCoordinator`); `patchChecklistItem`, `deleteChecklistItem`, `listChecklist` (`services/ticketChecklistService`); `moveTicketOrg` (`services/ticketService`).
- Produces: nothing exported.

**Fixture recipe.** Neither suite can use `service_recovery` — it declares no `human_work` or `wait` step. Each file builds a local `RecipeDefinition<never>` (the same fixture shape as Task 7's unit test) and passes it straight to the exported advancers, which is exactly why Task 7 exports them (D8).

- [ ] **Step 1: Bring up the stack**

Run (repo root): `pnpm test-stack up`
Expected: `.env.test` written. Leave it up until Task 13 tears it down.

- [ ] **Step 2: Write `aiOperatorHumanWorkStep.integration.test.ts`**

Cases, each a real row round-trip:

1. **`openHumanWorkStep` creates a ticket when the task has none** — assert an `ai_operator_task_targets` row with `target_kind = 'ticket'`, a `tickets` row in the task's org, a `ticket_checklist_items` row with `source = 'operator_task'` and `position = 0`, and a `ai_operator_task_steps` row with `step_kind = 'human_work'`, `state = 'waiting'`, `dependency_kind = 'user_answer'`, `dependency_id` = the item id, and `checklist_item_id` = the item id. Assert the item's `operator_step_id` = the step id.
2. **A second human-work step on the same task REUSES the ticket** — one `tickets` row, two items, `position` 0 and 1, one ticket target.
3. **Tick → wake → advance.** `patchChecklistItem(itemId, { done: true }, { userId })`, then assert an `ai_operator_task_outbox` row `(source_kind = 'user_answer', source_id = itemId, transition_seq = 1)` exists. Then `claimTaskLease` + `advanceHumanWork(...)` and assert: the step is `succeeded` with a `detail` naming the completing user id, an `ai_operator_task_events` row of type `wait_resolved`, and `ai_operator_tasks.current_step_key` now equals the fixture's `resumeStepKey` with that step's `phase`.
4. **Re-ticking an already-done item enqueues nothing new** — one outbox row, not two (the fixed ordinal collapsing a redelivery).
5. **Uncheck does NOT rewind.** After case 3, `patchChecklistItem(itemId, { done: false }, …)`; assert an `ai_operator_task_events` row of type `human_work_unticked`, and assert `ai_operator_tasks.current_step_key` is STILL the resume step and the step row is still `succeeded`. This is the case the whole "no rewind" rule exists for — the task may already have dispatched effects.
6. **Deleting a waiting item is refused; deleting a settled one is allowed.** `deleteChecklistItem` throws with `status: 409` / `code: 'CHECKLIST_OPERATOR_STEP_WAITING'` while the step waits, and the item still exists afterwards. After the step settles, the same call succeeds and the step's `checklist_item_id` goes NULL by the FK.
7. **`advanceWait` with a future `waitUntil`** — assert `wait_reason = 'maintenance_window'`, `next_wake_at` within a second of `waitUntil`, `lease_owner IS NULL` (the lease is released on a wait), and the task state `waiting`.
8. **`advanceWait` with a PAST `waitUntil`** — assert the task moved straight to the resume step, the wait step row is `succeeded`, and `next_wake_at` is due rather than in the past-by-hours.
9. **`advanceWait` with a `waitUntil` 50 ms in the future** — assert `next_wake_at - now >= 1000 ms` (the `MIN_WAIT_WAKE_MS` clamp), so clock skew cannot produce a tight re-entry loop.
10. **Reminders fire once.** Set `remind_after_at` into the past, run `sendHumanWorkReminders()` twice, assert exactly ONE `ticket_comments` row with `is_public = false` and `comment_type = 'internal'` and `user_id IS NULL`, exactly ONE `user_notifications` row, and `reminded_at` stamped.
11. **The task deadline on a human-work step HANDS OFF.** Set `deadline_at` into the past with the current step a `human_work` step, `advanceTask`, assert `state = 'handed_off'`, `outcome = 'unresolved'`, and a non-empty `handoff_summary` — not `failed`.

- [ ] **Step 3: Write `aiOperatorHumanWorkTenancy.integration.test.ts`**

1. **RLS forge as `breeze_app`.** With a DB context for org A, attempt to read a `ticket_checklist_items` row and an `ai_operator_task_steps` row belonging to org B; assert zero rows. Then attempt an INSERT of a step row carrying org B's `org_id`; assert it fails with `new row violates row-level security policy`. **If any of these SUCCEEDS, stop — E2's policies did not apply to this stack.**
2. **The link cannot cross tenants through the join.** Create a step in org A pointing (by raw SQL, bypassing the service) at an item in org B; assert `readHumanWorkStep` returns `itemLabel: null` — the org predicate in the join is what makes this safe, and this is the test that proves it rather than asserting the predicate's text.
3. **Ticket org-move detaches and hands off.** A live human-work step, then `moveTicketOrg(ticketId, orgB, actor)`. Assert: the item's `org_id` is now org B (the shipped re-stamp still happens), the step's `org_id` is UNCHANGED (immutable task history), the step's `checklist_item_id` is NULL, an `ai_operator_task_events` row of type `target_detached` exists, and an `ai_operator_task_outbox` row was enqueued. Then run `advanceHumanWork` and assert the task is `handed_off` with a `handoff_summary` that names the ticket step — never still `waiting`.
4. **The org-merge contract.** Run `orgLifecycleFoundations`-style merge machinery over a loser org with a live human-work step; assert the merge COMPLETES (no 23503 — which is the whole reason the FK is plain and single-column) and the step's `checklist_item_id` is NULL afterwards.
5. **Org erasure order.** `cascadeDeleteOrg` on an org with a live human-work step: assert it completes with no FK violation. This is what proves Task 4 Step 2's ordering claim against the real database rather than against a line-number comparison.

- [ ] **Step 4: Run both**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiOperatorHumanWorkStep.integration.test.ts src/__tests__/integration/aiOperatorHumanWorkTenancy.integration.test.ts`
Expected: PASS, 2 files, ~16 tests. **Read the counts** — a 0-test run means the files are misplaced or the config did not pick them up, and it reads exactly like success.

- [ ] **Step 5: Commit**

```
git add apps/api/src/__tests__/integration/aiOperatorHumanWorkStep.integration.test.ts apps/api/src/__tests__/integration/aiOperatorHumanWorkTenancy.integration.test.ts
git commit -m "$(cat <<'EOF'
test(api): real-Postgres proof for human-work steps, the wait writer and tenancy (E3)

Tick-to-advance, no-rewind-on-untick, the 409 delete guard, the clock-skew
clamp, and the three tenancy paths the plain FK exists for: org-move detach,
org merge without 23503, and erasure ordering.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Full verification sweep, review, PR — then STOP

**Files:** none changed unless the sweep finds something.

- [ ] **Step 1: Typecheck every package this wave touched**

```
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd apps/web && npx tsc --noEmit -p tsconfig.json
cd packages/shared && npx tsc --noEmit -p tsconfig.json
```
Expected: exit 0 for all three.

- [ ] **Step 2: Run every unit suite this wave touched or could have disturbed**

```
cd packages/shared && npx vitest run src/validators/ticketChecklists.test.ts src/types/aiOperator.test.ts src/validators/aiOperator.test.ts
cd apps/api && npx vitest run src/services/aiOperator/ src/services/ticketChecklistService.test.ts src/services/ticketService.test.ts src/services/orgMergeCustomExecutors.test.ts src/services/ticketOrgMoveLockOrder.test.ts src/routes/tickets/ src/db/schema/ src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/jobs/aiOperatorTaskWorker.test.ts
cd apps/web && npx vitest run src/components/tickets/ src/components/deliverables/ src/lib/i18n/
```
Expected: PASS throughout. Record the file and test counts in the PR body — that is what makes "all green" checkable by a reviewer.

- [ ] **Step 3: Run the contract suites, with a live stack**

```
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/aiOperatorHumanWorkStep.integration.test.ts \
  src/__tests__/integration/aiOperatorHumanWorkTenancy.integration.test.ts
```
Expected: PASS, 8 files. `rls-coverage` and `orgMergeRegistry` must pass **with no allowlist edit** — this wave adds no table. If either demands one, something was added that this plan did not intend; stop and report rather than adding the entry.

- [ ] **Step 4: Prove the migration guard against `origin/main`**

Run: `bash scripts/check-migration-naming.sh --against-ref origin/main`
Expected: pass. If `origin/main` gained a migration that sorts after either of this wave's two files, rename both (keeping A before B) and re-run — the filename ordering is checked again at push time, not only at commit time.

- [ ] **Step 5: One independent code-review round**

Run `/pr-review-toolkit:review-pr` (or dispatch a `pr-review-toolkit:code-reviewer` over the branch diff) and act only on confirmed, consequential findings. Ask it specifically to check:
- that nothing under `apps/api/src/services/aiOperator/` writes `done_at` (the guard should make this mechanical, but a reviewer reading the diff is the second pair of eyes the guard's own history argues for);
- that the `detachHumanWorkLinksForTicket` call in `moveTicketOrg` is inside the transaction and before the `tickets` UPDATE;
- that no new `db.transaction()` was introduced on the request path;
- that every one of the four new columns is classified in `CORE_TENANT_EXPORT_POLICY`.

Per CLAUDE.md, cap this at ONE round unless a fix itself touches tenancy, auth or a migration.

- [ ] **Step 6: Tear down the stack**

Run (repo root): `pnpm test-stack down`
Then confirm nothing of this session's is left running:
```
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Anything this session started and did not tear down goes in the PR body as a known-left-running note.

- [ ] **Step 7: Open the PR and STOP**

```
gh pr create --title "feat(ai-operator): human-work steps bound to ticket checklists, and the maintenance_window wait writer (E3)" --body "$(cat <<'EOF'
Wave E3 of the Operator Recipe Library. Adds the two step kinds E2 shipped as
CHECK-list values with no writer.

Closes #<wave sub-issue>

## What lands

- `human_work` steps create a real `ticket_checklist_items` row
  (`source = 'operator_task'`) on the task's ticket and wait on
  `user_answer` with the item id as the dependency. A human tick wakes the
  task; the Operator never ticks anything.
- `wait` steps write `next_wake_at = waitUntil` with
  `wait_reason = 'maintenance_window'` and are woken by the existing poller.
- A task that needs human work and has no ticket gets one, as an E2 `ticket`
  target row — no new column on `ai_operator_tasks`.
- Reminders once per overdue step (internal ticket comment + notification);
  past the task deadline a human-work step hands off rather than failing.
- Un-ticking records a `human_work_unticked` event and never rewinds.
- Deleting an item a step is waiting on is a 409.
- Ticket org-move and org merge detach the link and wake the task, which then
  hands off — never waits on a row in another tenant.
- Web: an "Operator step" badge and a link to the task on the ticket checklist,
  in both of the card's mount sites.

## Decisions worth a reviewer's attention

1. **One owning FK, and it is not the one the spec describes.** Spec §5.3 asks
   for composite FKs in both directions. `ticket_checklist_items.org_id` is
   re-stamped by both org movers while `ai_operator_task_steps.org_id` is
   immutable task history, so a composite org FK would abort every ticket
   org-move with 23503 — and there is no `ticket_checklist_items_id_org_uq` to
   point one at. The step owns a plain single-column `ON DELETE SET NULL` FK;
   the item's `operator_step_id` is provenance with no FK, the same ruling
   `source_template_item_id` carries. Detach, never re-stamp.
2. **Migration A carries no `-- @no-transaction`.** `ALTER TYPE … ADD VALUE` is
   legal in a transaction; only *using* the new label in the same one is not.
   Same shape as the shipped report-type enum migrations.
3. **`human_work` and `wait` dispatch by KIND**, through a fallback consulted
   only after E1's per-recipe table misses. `service_recovery` declares neither
   kind, so its dispatch is unchanged.
4. **The wait's scheduled time and successor step live in the task checkpoint**
   (`waitUntil`, `resumeStepKey`). `permittedNextSteps` describes what the MODEL
   may propose, which is the wrong question for a step with no model output.

## Registration

No new table, so no cascade / merge / device / ticket list entry. Four new
columns across two already-registered tables, all classified `included` in
`CORE_TENANT_EXPORT_POLICY`. Cascade ORDER re-derived: `ai_operator_task_steps`
precedes `ticket_checklist_items` in `CORE_ORG_CASCADE_DELETE_ORDER`, which the
new FK now requires (children before parents), and the erasure integration test
proves it against the real database.

## Verification

<paste the file/test counts from Task 13 Steps 2-3, and the `check-migration-naming.sh` result>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**STOP here. Do not merge, do not `--admin`.** The merge queue owns landing; a reviewed, green PR is this plan's finished state.

---

## Spec coverage

| Spec § | Requirement | Task |
|---|---|---|
| §5.3 | fourth `source` value `operator_task` | 1, 2 |
| §5.3 | `ALTER TYPE … ADD VALUE` in its own migration, sorted ahead of any file using it | 2 |
| §5.3 | `ai_operator_task_steps.checklist_item_id`, `ticket_checklist_items.operator_step_id` | 3 |
| §5 preamble | registration in the same PR (export policy on a new COLUMN) | 4 |
| §6.1 `human_work` row | "create or attach checklist item", wait `information`/`user_answer` | 5, 7 |
| §6.1 `wait` row | "write `next_wake_at`", wait `maintenance_window` | 7 |
| §6.5 | item on the task's ticket, `source = 'operator_task'`, `operator_step_id` set | 5 |
| §6.5 | `patchChecklistItem` setting `done_at` writes a task outbox row in the same transaction | 6 |
| §6.5 | the wake handler RE-READS the item | 7 (`readHumanWorkStep`, org-constrained) |
| §6.5 | evidence is the completing user id and timestamp, never model-graded text | 7 |
| §6.5 | un-checking writes an event and does not rewind | 6, 12 (case 5) |
| §6.5 | a task with human work requires a ticket; create one if absent | 5 (`ensureTaskTicket`) |
| §6.5 | "the Operator creates items and never completes them" | 10 (mechanical guard) |
| §6.5 | reminders: ticket comment + notification; deadline → handoff, not failure | 9, 7 |
| §6.3 | `wait_cutoff` is expressible | 7 (`advanceWait`) |
| §10 row E3 | scope of the wave | all |
| Brief | 409 on deleting an item while the step waits | 6, 12 (case 6) |
| Brief | ticket org-move with a linked waiting step; org-merge contract | 8, 12 |
| Brief | clock-skew and already-past wait cases tested | 7, 12 (cases 8-9) |
| Brief | badge + link on the ticket page, `runAction`, real translations, explicit MOUNT | 11 |

## Placeholder scan

No `TBD`, no `TODO`, no "similar to", no "add validation". Every code block names real files, real line numbers read from the working tree at `59a94162c`, and real identifiers from E1, E2 or the shipped code. The only intentionally elided bodies are Task 7's and Task 12's test cases, where the case TITLE is the specification and the instruction says so explicitly.

## Identifier consistency

`OPERATOR_TASK_ACTOR`, `CHECKLIST_ANSWER_OUTBOX_TRANSITION_SEQ`, `HUMAN_WORK_POLL_WAKE_MS`, `HumanWorkDbHandle`, `HumanWorkStepWaitingError`, `ensureTaskTicket`, `openHumanWorkStep`, `readHumanWorkStep`, `onChecklistItemDone`, `onChecklistItemUnticked`, `assertChecklistItemDeletable`, `detachHumanWorkLinksForTicket`, `sendHumanWorkReminders` (Task 5/9) are consumed verbatim in Tasks 6, 7, 8, 9, 10, 12. `advanceHumanWork` / `advanceWait` / `KIND_ADVANCERS` / `MIN_WAIT_WAKE_MS` / `HUMAN_WORK_REMIND_AFTER_MS` (Task 7) are consumed in Tasks 9 and 12. `operatorStepId` / `checklistItemId` / `remindAfterAt` / `remindedAt` (Task 3) appear identically in Tasks 4, 5, 6, 9, 12. `operatorTaskId` (Task 6) is the same name in Task 11's client type, badge and tests. `'operator_task'` and `'human_work_unticked'` are spelled identically in `packages/shared`, the Drizzle schema, both migrations, every service and every test.
