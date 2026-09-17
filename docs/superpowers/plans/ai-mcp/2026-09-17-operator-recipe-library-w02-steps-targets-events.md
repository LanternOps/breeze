---
tracking_issue: PENDING
---

# Operator Recipe Library — Wave E2: task targets, target accounts, steps and events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AI Operator task stops being a single inline device pointer and becomes a real object graph: `ai_operator_task_targets` (device, ticket **or contact**), `ai_operator_task_target_accounts` (the frozen M365/Google identity behind a contact target), `ai_operator_task_steps` (one row per recipe step attempt, carrying `step_kind`), and an append-only `ai_operator_task_events` timeline with a per-task monotonic `transition_seq`. Every existing `service_recovery` task is migrated to one target row plus one step row without changing one byte of its observable behaviour, the inline `device_id`/`target_label` columns stay as a read projection, the agent policy snapshot gains task-wide budgets, and `GET /api/v1/ai/operator/tasks/:id` grows `targets` / `steps` / `events` additively.

**Architecture:** Four new Shape-1 tables in one DDL migration, plus a separate DML backfill migration. Three thin services under `apps/api/src/services/aiOperator/` — `targetService.ts` (create / freeze accounts / detach / resolve a contact and upsert `contact_external_links`), `stepService.ts` (open / settle a step keyed by a unique task+step+target+attempt identity) and `eventService.ts` (`appendTaskEvent`, allocating `transition_seq` from a new `ai_operator_tasks.event_seq` counter under the task's own row lock). All three take a caller-supplied `DbHandle` exactly like `taskOutbox.ts`'s `enqueueTaskOutbox` and `operationService.ts`'s `reserveOperation`, so every write lands in the caller's transaction. The coordinator's three private writers (`writeLeasedStep`, `yieldToWait`, `settle` in `taskCoordinator.ts`) call them from inside the existing `runOutsideDbContext(() => withSystemDbAccessContext(...))` callback — which is already one Postgres transaction (`withDbAccessContext`, `db/index.ts:742`) — so the step row, the event row and the task CAS commit together or not at all.

**Tech Stack:** TypeScript, Hono, Drizzle ORM + hand-written SQL migrations (forced RLS, PostgreSQL 16), Vitest (unit + `vitest.integration.config.ts` against real Postgres), Zod (packages/shared validators).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-operator-recipe-library-design.md` — §5 preamble (tenancy ceremony), §5.1 (`ai_operator_task_targets`, contact class), §5.2 (`ai_operator_task_target_accounts`), §5.3 (**the `step_kind` column only** — `checklist_item_id` and the `ticket_checklist_items` changes are wave E3), §5.5 (`ai_operator_tasks` deltas, inline target kept as a read projection), §6.7 (bounds), §10 row E2. Adopts the column lists of `docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-completion-design.md` §11 (data model table), §11.1 (indexes, `text`+CHECK never pgEnum), §11.3 (reference lifecycle matrix), §7.2 (task-wide budgets, snapshot bump) and its plan `docs/superpowers/plans/ai-mcp/2026-09-07-ai-operator-completion.md` §P3-2.

**Feature tracking:** parent issue and wave sub-issue assigned by `register_feature` after all wave plans exist; branch `feature/<parent#>-operator-recipe-library/wave-<subissue#>`.

---

## Decisions recorded for the orchestrator (deviations from the wave brief and from the spec, with evidence)

These are the four places where the written instruction does not survive contact with the code. Each is decided here; the executor must not "fix" them back.

1. **The policy snapshot bump is 13 → 14, not 9 → 10.** `AI_AGENT_POLICY_SNAPSHOT_VERSION` is `13 as const` at `packages/shared/src/types/aiAgents.ts:617`. The spec's "9 to 10" (`2026-09-07-ai-operator-completion-design.md:63,341`) was written when the constant was 9; v10 (Fleet Designer), v11 (patch agent), v12 (execution plane W04) and v13 (sweeps act mode) have landed since, and every line number that spec cites for this file is stale (`:433` → `:617`). Task 11 bumps 13 → 14 and widens the union to `1 | … | 14`.
2. **`ai_operator_task_targets` does NOT join `TICKET_ORG_DENORMALIZED_TABLES`, `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER` or `CUSTOM_ORG_REWRITE_TABLES`; it takes a DOCUMENTED EXEMPTION instead.** The brief asks for list membership; the code refuses it two ways. (a) `CUSTOM_ORG_REWRITE_TABLES` is documented at `apps/api/src/routes/devices/core.ts:380-404` as *"tables that denormalize `org_id` … but have NO `device_id` column"*, and `moveOrg.coverage.test.ts` asserts the list is disjoint from the device lists — `ai_operator_task_targets` has a `device_id` column, so an entry there fails CI. (b) Re-stamping a target's `org_id` on a ticket move would break `ai_operator_task_targets_task_org_fk` against the task, whose `org_id` is immutable history (`2026-10-14-100000-ai-operator-thin-slice.sql` header note 3 and section 7). The correct treatment is the one `ai_operator_tasks` and `ai_agent_runs` already get: **detach, never re-stamp**. Task 6 adds the hand-written ticket-axis detach inside `moveTicketOrg` (`services/ticketService.ts`, beside the `ai_agent_runs.ticket_id` sever at ~:2730) and the device-axis detach in all three device paths. **Silence is not an option on either axis:** `moveOrg.coverage.test.ts` derives completeness from the Drizzle schema on both, so Task 6 must also add `ai_operator_task_targets` to `INTENTIONALLY_NO_ORG_ID` (device axis) and to the ticket-axis documented exemption set (the `TICKET_ORG_DENORMALIZED_TABLES completeness (#5783)` describe block, ~:543), each with the rationale above. A missing exemption entry reds CI exactly as a missing list entry would — which is the design working.
3. **`target.device_id` and `target.ticket_id` are PLAIN FKs `ON DELETE SET NULL`; only `target.contact_id` is composite.** Operator spec §11.3's matrix says `target → device`: *"`device_id → devices(id)` ON DELETE SET NULL, **no composite**"* and `target → ticket`: *"same shape as device"*. Recipe spec §5.1 explicitly asks for `composite (contact_id, org_id) → contacts(id, org_id)` for the contact only. A composite device/ticket FK would also make the device-move trigger and `moveTicketOrg` 23503 instead of merely leaving a stale pointer. The wave brief's blanket "composite same-org AND same-task FKs" applies to the **parent** edges (`task_id`, `target_id`), which are all composite and all `DEFERRABLE INITIALLY IMMEDIATE`.
4. **`ai_operator_task_events` carries NO foreign keys on `actor_user_id` or `target_id`.** The table is append-only: `REVOKE UPDATE, DELETE … FROM breeze_app` plus a `BEFORE UPDATE OR DELETE` trigger that RAISEs (`script_proposal_reviews` template, `apps/api/migrations/2026-10-16-100100-script-proposals.sql:225-252`). `ON DELETE SET NULL` performs an UPDATE, which that trigger rejects — deleting a user would abort with 55000. `ON DELETE RESTRICT` would instead make a user undeletable. Both pointers are therefore **typed references with no hard FK**, the same ruling `ai_operator_operations.execution_ref_id` already carries (`2026-10-14-100000-ai-operator-thin-slice.sql:294-297`).

Two further findings the orchestrator should carry forward:

- **`google_workspace_connections` has no `(id, org_id)` unique index** (only `google_workspace_connections_org_uniq` on `org_id`, `apps/api/migrations/2026-06-01-google-workspace-connections.sql:28-29`). This wave creates `google_workspace_connections_id_org_uniq` before the composite FK can reference it. `m365_connections_id_org_uniq` already exists (`2026-10-16-170200-m365-tenant-sync-foundation.sql:35-44`).
- **`m365_connections.org_id` is NULLABLE** (`apps/api/src/db/schema/m365.ts:40`) — delegated/user-axis connections have no org. Our referencing columns are both NOT NULL when `m365_connection_id` is set, so a MATCH SIMPLE composite FK is fully checked and a null-org connection simply cannot be named by an org-scoped task account. That is the intended outcome, not a gap: a user-axis delegated connection is not an org's identity plane.

---

## Global Constraints

- **Flag:** everything stays behind `AI_OPERATOR_TASKS_ENABLED` (`aiOperatorTasksEnabled()` in `apps/api/src/config/env.ts`). **This wave introduces no new env var**, so `.env.example`, `deploy/.env.example` and both compose files are untouched and `envComposeParity.test.ts` is unaffected.
- **Tenancy ceremony (recipe spec §5 preamble):** all four tables are Shape 1 — direct `org_id uuid NOT NULL REFERENCES organizations(id)`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, and the four `breeze_org_isolation_{select,insert,update,delete}` policies using the plain `public.breeze_has_org_access(org_id)` idiom **in the creating migration**. Shape 1 is auto-discovered by `rls-coverage.integration.test.ts` — **no allowlist entry for any of the four**, and none of them ever goes into `INTENTIONAL_UNSCOPED`.
- **`text` + CHECK, never `pgEnum`** (Operator spec §11.1): under forced RLS enum equality is not leakproof and cannot become an index condition. Every state/kind/reason column below is `text` with a CHECK whose value list is mirrored by an exported `as const` array in the Drizzle schema **and** in `packages/shared`, pinned by `enumParity.test.ts`.
- **Partial-index predicates are literal constants**, never interpolated (`WHERE device_id IS NOT NULL`, not `WHERE ${col} IS NOT NULL` bound as a parameter).
- **Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`** — org merge runs `SET CONSTRAINTS ALL DEFERRED` and a non-deferrable one aborts it with 23503 (`orgLifecycleFoundations.integration.test.ts`, "merge contract").
- **Detach never clears `org_id`:** optional composite pointers use the PG15+ column-list form `ON DELETE SET NULL (<column>)`. Confirmed available — every compose file pins `pgvector/pgvector:pg16` (`docker-compose.test.yml:20`, `docker-compose.dev.yml:9`, `.env.example:1306` `POSTGRES_IMAGE_REF=pgvector/pgvector:pg16`).
- **Migrations:** two files, `apps/api/migrations/2026-10-18-100000-ai-operator-task-graph.sql` (DDL) and `apps/api/migrations/2026-10-18-100100-ai-operator-inline-target-backfill.sql` (DML). Newest committed migration at planning time is `2026-10-17-140000-snmp-metrics-instance-width.sql`; **Task 3 Step 1 re-runs `ls apps/api/migrations/*.sql | sort | tail -1` and renames both files if anything newer landed.** Idempotent throughout (`CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before each `ADD CONSTRAINT`, `DROP POLICY IF EXISTS` before each `CREATE POLICY`, `DO $$ … EXCEPTION WHEN duplicate_object`). **No inner `BEGIN`/`COMMIT`** — `autoMigrate` wraps each file in one transaction. Never edit a shipped migration.
- **Why two migration files rather than one:** the DDL file writes **no rows**, so it needs no `breeze.scope` election and `migrationRlsScope.test.ts` stays green for it by construction. The backfill file writes rows and therefore **must** open with `SELECT set_config('breeze.scope', 'system', true);` before its first `INSERT` — 425 of 442 tables are `FORCE ROW LEVEL SECURITY`, which binds the table owner, so without that election every backfill INSERT aborts with 42501 (or, for an UPDATE, silently matches zero rows and logs a truthful-looking `0`). Splitting them keeps the scope election visible in a file that is *entirely* DML, makes the backfill independently observable in the Postgres log, and means a backfill failure does not roll back the schema. **Never add a new file to `migrationRlsScope.test.ts`'s frozen 122-offender baseline.**
- **Cascade / export / merge registration is not optional and not a judgement call.** Task 6 is a mechanical checklist; it has shipped broken or reddened CI five times in this repo (#1359, #1351, #1365, #2179, #2514) and code review caught it 0/5 while the contract tests caught it 5/5.
- **Tests:** file beside source. One file: `cd apps/api && npx vitest run src/path/file.test.ts` — **never** `pnpm --filter … test -- --run <path>` (pnpm forwards the literal `--`, vitest swallows `--run` as a positional and runs the whole 1,470-file suite in watch mode). Integration: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>` with a live stack (`pnpm test-stack up` at the repo root; `pnpm test-stack down` when finished — nothing does this for you). Integration tests MUST live under `apps/api/src/__tests__/integration/` — a wrongly placed one runs ZERO tests and reads green. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`. A 0-test run is a stall, not a pass.
- **Red first, every task.** Write the assertion, run it, see it fail for the stated reason, then implement.
- **Assume E1 has landed.** `apps/api/src/services/aiOperator/recipes/types.ts` and `.../recipes/index.ts` export `RECIPES`, `getRecipe(workflowKey, workflowVersion)`, `RecipeDefinition`, `StepKind` and `TargetKind = 'device' | 'ticket' | 'contact'` (recipe spec §6.1). **Consume them; never redefine them.** If `getRecipe` is missing when Task 9 runs, E1 has not merged — stop and report rather than inventing a local copy.
- **Out of scope for this wave, do not add:** `ai_operator_task_steps.checklist_item_id`, the `ticket_checklist_items.operator_task` source value and `operator_step_id` column (all E3); `ai_operator_plan_approvals` (E4); `ai_operator_workflows` (a later wave — `workflow_config_id` is added here as a nullable column **with no FK**, exactly because its parent table does not exist yet); any web UI.
- **Rigor: high.** Tenancy, RLS, migrations, org erasure. One independent code-review round before the PR.
- **Commits:** end every commit message with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Merge with bare `gh pr merge <N>` (merge queue); **never `--admin`**. The final task opens the PR and STOPS.

---

## File Structure

**packages/shared**
- Modify `src/types/aiOperator.ts` — new `as const` value lists (`AI_OPERATOR_TARGET_KINDS`, `AI_OPERATOR_TARGET_STATES`, `AI_OPERATOR_STEP_KINDS`, `AI_OPERATOR_STEP_STATES`, `AI_OPERATOR_ACCOUNT_PROVIDERS`, `AI_OPERATOR_TASK_EVENT_TYPES`, `AI_OPERATOR_EVENT_ACTOR_KINDS`) and the four new DTOs.
- Modify `src/types/aiAgents.ts` — `AiAgentLimits` task fields, `AI_AGENT_LIMIT_DEFAULTS`, snapshot version 13 → 14, union widening.
- Modify `src/validators/aiAgents.ts` — new fields inside `limitsFields`.
- Modify `src/types/aiAgents.test.ts`, `src/validators/aiAgents.test.ts` — re-pin the version and add bounds rows.

**apps/api — data**
- Create `migrations/2026-10-18-100000-ai-operator-task-graph.sql` (DDL).
- Create `migrations/2026-10-18-100100-ai-operator-inline-target-backfill.sql` (DML).
- Create `src/db/schema/aiOperatorTaskGraph.ts`; modify `src/db/schema/index.ts:77` (export it after `./aiOperatorTasks`).
- Modify `src/db/schema/aiOperatorTasks.ts` — `workflowConfigId`, `eventSeq`.
- Modify `src/services/tenantCascade.ts` — `CORE_ORG_CASCADE_DELETE_ORDER`, `AUDIT_ADMIN_REQUIRED_TABLES`.
- Modify `src/services/tenantExportPolicyRegistry.ts` — four new entries + two new `ai_operator_tasks` columns.
- Modify `src/services/orgMergeRegistry.ts` — four new dispositions.
- Modify `src/services/orgMergeCustomExecutors.ts` — extend `fenceAiOperatorTasks` with the target/account detaches.
- Modify `src/routes/devices/core.ts:188` — `DEVICE_DETACH_DEVICE_ID_TABLES`.
- Modify `src/routes/devices/moveOrg.ts:~534` — device-axis target detach mirror.
- Modify `src/services/deviceDeletion.ts:~281` — device-delete target detach.
- Modify `src/services/ticketService.ts` (`moveTicketOrg`, ~:2730) — ticket-axis target detach.
- Modify `src/__tests__/integration/orgMergeRegistry.integration.test.ts:187` — `ORG_ID_BLOCKING_TRIGGERS`.

**apps/api — services/aiOperator/**
- Create `eventService.ts`, `eventService.test.ts`.
- Create `targetService.ts`, `targetService.test.ts`.
- Create `stepService.ts`, `stepService.test.ts`.
- Modify `taskCoordinator.ts` — `writeLeased`, `writeLeasedStep`, `yieldToWait`, `settle`.
- Modify `taskService.ts` — admission writes the target and the first step row.
- Modify `taskReadService.ts`, `taskReadService.test.ts` — `targets` / `steps` / `events` projections.
- Modify `enumParity.test.ts` — six new parity assertions.
- Modify `src/routes/aiOperatorTasks.ts:411-485` — detail route joins.

**apps/api — integration tests (all new, all under `src/__tests__/integration/`)**
- `aiOperatorTaskGraphRls.integration.test.ts`
- `aiOperatorTaskGraphCascade.integration.test.ts`
- `aiOperatorInlineTargetBackfill.integration.test.ts`

---

### Task 1: Shared value lists and DTOs for targets, accounts, steps and events

**Files:**
- Modify: `packages/shared/src/types/aiOperator.ts` (append after line 232, the end of `AiOperatorTaskDto`)
- Create: `packages/shared/src/types/aiOperator.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  export const AI_OPERATOR_TARGET_KINDS: readonly ['device', 'ticket', 'contact'];
  export type AiOperatorTargetKind = (typeof AI_OPERATOR_TARGET_KINDS)[number];
  export const AI_OPERATOR_TARGET_STATES: readonly ['pending','active','succeeded','failed','skipped','detached'];
  export type AiOperatorTargetState = (typeof AI_OPERATOR_TARGET_STATES)[number];
  export const AI_OPERATOR_STEP_KINDS: readonly ['reason','effect','probe','wait','human_work','document'];
  export type AiOperatorStepKind = (typeof AI_OPERATOR_STEP_KINDS)[number];
  export const AI_OPERATOR_STEP_STATES: readonly ['pending','running','waiting','succeeded','failed','skipped'];
  export type AiOperatorStepState = (typeof AI_OPERATOR_STEP_STATES)[number];
  export const AI_OPERATOR_ACCOUNT_PROVIDERS: readonly ['m365', 'google'];
  export type AiOperatorAccountProvider = (typeof AI_OPERATOR_ACCOUNT_PROVIDERS)[number];
  export const AI_OPERATOR_TASK_EVENT_TYPES: readonly [...13 values, see Step 3];
  export type AiOperatorTaskEventType = (typeof AI_OPERATOR_TASK_EVENT_TYPES)[number];
  export const AI_OPERATOR_EVENT_ACTOR_KINDS: readonly ['coordinator','reconciler','user','agent','system'];
  export type AiOperatorEventActorKind = (typeof AI_OPERATOR_EVENT_ACTOR_KINDS)[number];
  export interface AiOperatorTaskTargetAccountDto { provider; connectionId; externalId; principalLabel }
  export interface AiOperatorTaskTargetRowDto { id; targetKind; deviceId; ticketId; contactId; label; ordinal; state; detachedAt; detachedReason; accounts }
  export interface AiOperatorTaskStepDto { id; stepKey; stepKind; targetId; attemptOrdinal; state; planRevision; expectedCriterion; dependency; detail; startedAt; settledAt }
  export interface AiOperatorTaskEventDto { id; transitionSeq; eventType; actorKind; actorUserId; stepKey; targetId; detail; createdAt }
  ```

`AiOperatorTargetKind` here is the **wire/DB** list. E1's `TargetKind` in `services/aiOperator/recipes/types.ts` is the recipe-facing name for the same three values; Task 9 asserts they are equal rather than importing one into the other (`packages/shared` must not import from `apps/api`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/types/aiOperator.test.ts
import { describe, expect, it } from 'vitest';
import {
  AI_OPERATOR_ACCOUNT_PROVIDERS,
  AI_OPERATOR_EVENT_ACTOR_KINDS,
  AI_OPERATOR_STEP_KINDS,
  AI_OPERATOR_STEP_STATES,
  AI_OPERATOR_TARGET_KINDS,
  AI_OPERATOR_TARGET_STATES,
  AI_OPERATOR_TASK_EVENT_TYPES,
} from './aiOperator';

describe('AI Operator task-graph value lists (recipe spec §5.1/§5.2/§5.3)', () => {
  it('target kinds are exactly device, ticket, contact — in that order', () => {
    expect([...AI_OPERATOR_TARGET_KINDS]).toEqual(['device', 'ticket', 'contact']);
  });

  it('step kinds are exactly the six of recipe spec §5.3', () => {
    expect([...AI_OPERATOR_STEP_KINDS]).toEqual([
      'reason', 'effect', 'probe', 'wait', 'human_work', 'document',
    ]);
  });

  it('target states end with detached, which is what a detach stamp sets', () => {
    expect([...AI_OPERATOR_TARGET_STATES]).toEqual([
      'pending', 'active', 'succeeded', 'failed', 'skipped', 'detached',
    ]);
  });

  it('step states are the six lifecycle values', () => {
    expect([...AI_OPERATOR_STEP_STATES]).toEqual([
      'pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped',
    ]);
  });

  it('account providers are exactly m365 and google (recipe spec §5.2)', () => {
    expect([...AI_OPERATOR_ACCOUNT_PROVIDERS]).toEqual(['m365', 'google']);
  });

  it('event actor kinds never include a synthetic human user for a machine actor', () => {
    expect([...AI_OPERATOR_EVENT_ACTOR_KINDS]).toEqual([
      'coordinator', 'reconciler', 'user', 'agent', 'system',
    ]);
  });

  it('event types are unique and cover every task-affecting transition', () => {
    expect(new Set(AI_OPERATOR_TASK_EVENT_TYPES).size).toBe(AI_OPERATOR_TASK_EVENT_TYPES.length);
    for (const required of [
      'task_admitted', 'lease_claimed', 'step_opened', 'step_settled',
      'wait_entered', 'target_attached', 'target_detached', 'task_settled',
    ]) {
      expect(AI_OPERATOR_TASK_EVENT_TYPES).toContain(required);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && npx vitest run src/types/aiOperator.test.ts`
Expected: FAIL — `AI_OPERATOR_TARGET_KINDS` is not exported from `./aiOperator`.

- [ ] **Step 3: Append the value lists and DTOs to `packages/shared/src/types/aiOperator.ts`**

Append at the end of the file (after `AiOperatorTaskDto`, line 232):

```ts
// ---------------------------------------------------------------------------
// Task graph — wave E2 (recipe spec §5.1, §5.2, §5.3).
//
// Same hand-duplication caveat as the six unions at the top of this file:
// `packages/shared` cannot import `apps/api/src/db/schema`, so each list below
// is mirrored by an identically-named export in
// `apps/api/src/db/schema/aiOperatorTaskGraph.ts` and pinned byte-for-byte by
// `apps/api/src/services/aiOperator/enumParity.test.ts`. If you change one,
// that test fails until you change the other.
// ---------------------------------------------------------------------------

/** `ai_operator_task_targets.target_kind`. The DB/wire spelling of E1's
 *  recipe-facing `TargetKind` (`services/aiOperator/recipes/types.ts`);
 *  enumParity.test.ts asserts the two are equal. */
export const AI_OPERATOR_TARGET_KINDS = ['device', 'ticket', 'contact'] as const;
export type AiOperatorTargetKind = (typeof AI_OPERATOR_TARGET_KINDS)[number];

/**
 * `ai_operator_task_targets.state`.
 *
 * `detached` is a STATE, not merely a stamp: a detached target has lost its
 * pointer and can never be acted on again, and the coordinator must be able
 * to see that with one column read rather than by inferring it from a null
 * pointer (which is also what an unresolved onboarding target looks like
 * before its account exists).
 */
export const AI_OPERATOR_TARGET_STATES = [
  'pending', 'active', 'succeeded', 'failed', 'skipped', 'detached',
] as const;
export type AiOperatorTargetState = (typeof AI_OPERATOR_TARGET_STATES)[number];

/** `ai_operator_task_steps.step_kind` — recipe spec §5.3 / §6.1's execution
 *  table. `human_work` has no writer until wave E3; the value ships now so
 *  E3 needs no CHECK-constraint churn (same pattern as `mode = 'trial'`). */
export const AI_OPERATOR_STEP_KINDS = [
  'reason', 'effect', 'probe', 'wait', 'human_work', 'document',
] as const;
export type AiOperatorStepKind = (typeof AI_OPERATOR_STEP_KINDS)[number];

/** `ai_operator_task_steps.state`. `waiting` mirrors the task's own typed
 *  wait: a step that yielded is not the same as a step that has not started. */
export const AI_OPERATOR_STEP_STATES = [
  'pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped',
] as const;
export type AiOperatorStepState = (typeof AI_OPERATOR_STEP_STATES)[number];

/** `ai_operator_task_target_accounts.provider` (recipe spec §5.2). */
export const AI_OPERATOR_ACCOUNT_PROVIDERS = ['m365', 'google'] as const;
export type AiOperatorAccountProvider = (typeof AI_OPERATOR_ACCOUNT_PROVIDERS)[number];

/**
 * `ai_operator_task_events.event_type`.
 *
 * Named for what HAPPENED, matching `TASK_TRANSITION_EVENTS`'
 * (`services/aiOperator/taskTransitions.ts`) own convention. Deliberately NOT
 * the same list: a transition event is "what may move the task", an event row
 * is "what was recorded", and several rows here (`operation_*`,
 * `verification_recorded`) correspond to no state change at all.
 */
export const AI_OPERATOR_TASK_EVENT_TYPES = [
  'task_admitted',
  'lease_claimed',
  'step_opened',
  'step_settled',
  'wait_entered',
  'wait_resolved',
  'target_attached',
  'target_detached',
  'target_account_frozen',
  'operation_reserved',
  'operation_settled',
  'verification_recorded',
  'plan_revision_bumped',
  'task_settled',
] as const;
export type AiOperatorTaskEventType = (typeof AI_OPERATOR_TASK_EVENT_TYPES)[number];

/**
 * `ai_operator_task_events.actor_kind`.
 *
 * `coordinator` and `reconciler` are distinct on purpose: "the reconciler
 * settled this" and "the coordinator settled this" are different operational
 * stories, and conflating them is how a polling fallback masquerades as the
 * event path. Spec §7.1: database context has no synthetic human user id, so
 * a machine actor NEVER carries an `actorUserId`.
 */
export const AI_OPERATOR_EVENT_ACTOR_KINDS = [
  'coordinator', 'reconciler', 'user', 'agent', 'system',
] as const;
export type AiOperatorEventActorKind = (typeof AI_OPERATOR_EVENT_ACTOR_KINDS)[number];

/** One frozen provider account behind a `contact` target (recipe spec §5.2).
 *  `externalId` is the immutable Entra object id / Google user id, never the
 *  UPN — a rename mid-task cannot retarget an effect. */
export interface AiOperatorTaskTargetAccountDto {
  provider: AiOperatorAccountProvider;
  /** The m365_connections / google_workspace_connections row, or null once the
   *  connection has been removed or the org merged away. */
  connectionId: string | null;
  externalId: string;
  principalLabel: string;
}

/** One `ai_operator_task_targets` row, safely projected. */
export interface AiOperatorTaskTargetRowDto {
  id: string;
  targetKind: AiOperatorTargetKind;
  deviceId: string | null;
  ticketId: string | null;
  contactId: string | null;
  /** The label frozen at admission — survives detach, which is the point. */
  label: string;
  ordinal: number;
  state: AiOperatorTargetState;
  detachedAt: string | null;
  detachedReason: AiOperatorTargetDetachReason | null;
  accounts: AiOperatorTaskTargetAccountDto[];
}

/** One `ai_operator_task_steps` row, safely projected. NEVER carries the
 *  step's `checkpoint` jsonb (`excludedOpen`), same rule as
 *  `AiOperatorTaskOperationDto` and `result`. */
export interface AiOperatorTaskStepDto {
  id: string;
  stepKey: string;
  stepKind: AiOperatorStepKind;
  targetId: string | null;
  attemptOrdinal: number;
  state: AiOperatorStepState;
  planRevision: number | null;
  expectedCriterion: string | null;
  dependency: AiOperatorWaitDependencyDto | null;
  detail: string | null;
  startedAt: string | null;
  settledAt: string | null;
}

/** One `ai_operator_task_events` row, safely projected. `detail` is the
 *  BOUNDED text column, not a container — there is no jsonb on this table. */
export interface AiOperatorTaskEventDto {
  id: string;
  transitionSeq: number;
  eventType: AiOperatorTaskEventType;
  actorKind: AiOperatorEventActorKind;
  actorUserId: string | null;
  stepKey: string | null;
  targetId: string | null;
  detail: string | null;
  createdAt: string;
}
```

Then extend the detail DTO — replace the `AiOperatorTaskDto` declaration (lines 227-232) with:

```ts
/** The full task detail DTO — the list-item fields plus safely-projected
 *  `operations`/`runs`, and (wave E2) `targets`/`steps`/`events`.
 *
 *  ADDITIVE ONLY. `AI_OPERATOR_TASK_DTO_SCHEMA_VERSION` stays 1: every field
 *  the pre-E2 client reads is still present with the same shape, including
 *  the inline `target` projection, which recipe spec §5.5 keeps until P3-5
 *  removes the inline columns. A client that ignores the three new arrays
 *  behaves exactly as before. */
export interface AiOperatorTaskDto extends AiOperatorTaskListItemDto {
  operations: AiOperatorTaskOperationDto[];
  runs: AiOperatorTaskRunLinkDto[];
  targets: AiOperatorTaskTargetRowDto[];
  steps: AiOperatorTaskStepDto[];
  events: AiOperatorTaskEventDto[];
}
```

- [ ] **Step 4: Run the test — expect PASS (7 tests)**

Run: `cd packages/shared && npx vitest run src/types/aiOperator.test.ts`
Expected: PASS, 7 tests. If `apps/api` now fails to typecheck because `mapOperatorTask` does not return the three new arrays, that is expected and is fixed in Task 12 — do **not** fix it here by making the fields optional; a detail DTO that may or may not have `steps` is exactly the shape that lets a route forget to join them.

- [ ] **Step 5: Verify the shared package still builds**

Run: `cd packages/shared && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

`git add packages/shared/src/types/aiOperator.ts packages/shared/src/types/aiOperator.test.ts && git commit -m "feat(shared): AI Operator task-graph value lists and target/step/event DTOs"`

---

### Task 2: `ai_operator_tasks` gains `workflow_config_id` and `event_seq` (Drizzle side)

**Files:**
- Modify: `apps/api/src/db/schema/aiOperatorTasks.ts` (columns after `clientIdempotencyKey`, line 209)
- Create: `apps/api/src/db/schema/aiOperatorTasks.test.ts`

**Interfaces:**
- Produces: `aiOperatorTasks.workflowConfigId`, `aiOperatorTasks.eventSeq` (both on the existing exported table).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/db/schema/aiOperatorTasks.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { aiOperatorTasks } from './aiOperatorTasks';

describe('ai_operator_tasks — wave E2 additive columns (recipe spec §5.5)', () => {
  const cols = getTableColumns(aiOperatorTasks);

  it('has workflow_config_id, nullable and with NO foreign key', () => {
    expect(cols.workflowConfigId.name).toBe('workflow_config_id');
    expect(cols.workflowConfigId.notNull).toBe(false);
    // `ai_operator_workflows` does not exist yet (a later wave). A uuid column
    // with no FK is honest about that; a FK to a missing table is a migration
    // that cannot be applied.
    expect(aiOperatorTasks.workflowConfigId.primary).toBe(false);
  });

  it('has event_seq, NOT NULL, defaulting to 0 — the per-task event counter', () => {
    expect(cols.eventSeq.name).toBe('event_seq');
    expect(cols.eventSeq.notNull).toBe(true);
    expect(cols.eventSeq.hasDefault).toBe(true);
  });

  it('keeps the inline target projection (spec §5.5: kept until P3-5)', () => {
    const names = Object.values(cols).map((c) => c.name);
    expect(names).toContain('device_id');
    expect(names).toContain('target_label');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/aiOperatorTasks.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'name')` on `cols.workflowConfigId`.

- [ ] **Step 3: Add the two columns**

In `apps/api/src/db/schema/aiOperatorTasks.ts`, immediately after `clientIdempotencyKey` (line 209) and before `createdAt`:

```ts
    // Wave E2 (recipe spec §5.5). NULLABLE and DELIBERATELY WITHOUT A FOREIGN
    // KEY: `ai_operator_workflows` (Operator spec §11's dual-owner config
    // table) is a later wave, so there is nothing to reference yet. This is
    // the one place in the Operator schema where a bare uuid is acceptable,
    // and only because it is never dereferenced by any code in this wave —
    // the moment a reader resolves it, the FK ships with that reader.
    workflowConfigId: uuid('workflow_config_id'),

    // Wave E2. The per-task monotonic allocator behind
    // `ai_operator_task_events.transition_seq`.
    //
    // WHY A COUNTER COLUMN AND NOT `MAX(transition_seq) + 1`: the events table
    // is append-only with a unique `(task_id, transition_seq)`, so two writers
    // racing a MAX+1 read would collide on 23505 — and a 23505 raised inside
    // the request transaction ABORTS it, turning an ordinary concurrent event
    // into a 500 (the pattern that shipped as a bug before; a SAVEPOINT retry
    // is the only alternative and is strictly more machinery). `UPDATE
    // ai_operator_tasks SET event_seq = event_seq + 1 … RETURNING event_seq`
    // instead takes the task's own row lock, which serialises every event
    // writer for that task with no retry loop and no conflict at all.
    //
    // NOT a second CAS counter: `writeLeased` guards on `revision` and
    // `lease_epoch` and never reads this column, so bumping it can never make
    // an approved plan undispatchable (taskCoordinator.ts invariant 3).
    eventSeq: bigint('event_seq', { mode: 'number' }).notNull().default(0),
```

- [ ] **Step 4: Run the test — expect PASS (3 tests)**

Run: `cd apps/api && npx vitest run src/db/schema/aiOperatorTasks.test.ts`

- [ ] **Step 5: Commit**

`git add apps/api/src/db/schema/aiOperatorTasks.ts apps/api/src/db/schema/aiOperatorTasks.test.ts && git commit -m "feat(api): ai_operator_tasks gains workflow_config_id and event_seq"`

---

### Task 3: DDL migration — the four tables, their RLS, their indexes, and the device-move hooks

**Files:**
- Create: `apps/api/migrations/2026-10-18-100000-ai-operator-task-graph.sql`

**Interfaces:**
- Consumes: `ai_operator_tasks_id_org_uq`, `contacts_id_org_id_uniq`, `tickets_id_org_uq`, `devices_id_org_id_uniq`, `m365_connections_id_org_uniq`, `public.breeze_has_org_access`, `public.breeze_device_child_orgid_tables`, `public.breeze_cascade_device_org_id`.
- Produces: tables `ai_operator_task_targets`, `ai_operator_task_target_accounts`, `ai_operator_task_steps`, `ai_operator_task_events`; index `google_workspace_connections_id_org_uniq`; columns `ai_operator_tasks.workflow_config_id`, `ai_operator_tasks.event_seq`.

- [ ] **Step 1: Re-check the migration slot BEFORE writing the file**

Run: `ls apps/api/migrations/*.sql | sort | tail -3`
Expected at planning time: the newest is `apps/api/migrations/2026-10-17-140000-snmp-metrics-instance-width.sql`. If anything newer than `2026-10-18-100000` is listed, rename **both** this file and Task 5's so they still sort last, keeping the same slugs, and use the new names everywhere below. Shipped migration names in this repo run ahead of real time — never assume today's date sorts last. The pre-push hook re-checks against `origin/main` (`scripts/check-migration-naming.sh --against-ref origin/main`), so re-run this check before pushing too.

- [ ] **Step 2: Write the migration**

```sql
-- apps/api/migrations/2026-10-18-100000-ai-operator-task-graph.sql
--
-- 2026-10-18: AI Operator Recipe Library wave E2 — task targets (incl. the
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
-- backfill lives in 2026-10-18-100100-ai-operator-inline-target-backfill.sql,
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
-- BEFORE WRITING THIS SECTION: re-run
--   grep -ln 'FUNCTION public.breeze_device_child_orgid_tables' apps/api/migrations/*.sql | sort | tail -1
-- and copy from whatever that prints, not from this plan, if it is not the
-- thin-slice file.
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
-- 9. breeze_cascade_device_org_id(): sever target device lineage too
-- ---------------------------------------------------------------------------
--
-- routes/devices/moveOrg.ts carries explicit detach statements, but the route
-- is not the only way devices.org_id changes: a direct UPDATE fires this AFTER
-- trigger and nothing else. The thin slice added the ai_operator_tasks
-- statement here for exactly that reason; this adds its twin for targets.
--
-- Body copied VERBATIM from the newest definition — at planning time
-- 2026-10-14-100000-ai-operator-thin-slice.sql (section 8) — with ONE statement
-- added immediately after the existing `UPDATE public.ai_operator_tasks`.
-- BEFORE WRITING THIS SECTION: re-run
--   grep -ln 'FUNCTION public.breeze_cascade_device_org_id' apps/api/migrations/*.sql | sort | tail -1
-- and copy the body from whatever that prints. DO NOT retype it from memory
-- and DO NOT paste an abridged version — this function is ~200 lines of
-- load-bearing ordering commentary and dropping any of it silently breaks a
-- different subsystem. The trigger itself (breeze_cascade_device_org_id ON
-- devices, AFTER UPDATE OF org_id) is unchanged and is NOT redeclared.
--
-- The statement to insert, directly after the `UPDATE public.ai_operator_tasks`
-- block and before the `UPDATE public.metric_anomaly_incidents` block:
--
--   -- AI Operator task TARGET history stays with the SOURCE org (recipe
--   -- library E2), same rule and same convergence properties as the task
--   -- statement above: COALESCE on the detach stamp and a CASE on `state` so
--   -- whichever of (this trigger, moveOrg.ts, deviceDeletion.ts) runs first
--   -- wins and the others are no-ops. Nulling device_id here also makes the
--   -- generic loop below a no-op for these rows — though the exclusion in
--   -- breeze_device_child_orgid_tables() is the real guarantee, not this.
--   UPDATE public.ai_operator_task_targets
--     SET device_id = NULL,
--         detached_at = COALESCE(detached_at, now()),
--         detached_reason = COALESCE(detached_reason, 'device_moved'),
--         state = 'detached',
--         updated_at = now()
--     WHERE device_id = NEW.id;
--
-- (Written as a comment in this plan only so the surrounding verbatim body is
-- not misrepresented. In the migration it is a real statement.)
```

- [ ] **Step 3: Apply the migration against a live database**

Run (repo root): `pnpm test-stack up`
Then: `cd apps/api && DATABASE_URL="$(grep '^DATABASE_URL=' ../../.env.test | cut -d= -f2-)" npx tsx src/db/migrate.ts` — or whatever `package.json`'s `db:migrate` script resolves to for this worktree (`grep -n '"db:migrate"' package.json`).
Expected: the two new migrations apply with no error, and re-running is a clean no-op.

- [ ] **Step 4: Prove the RLS forge fails as `breeze_app`**

Run:
```
docker exec -i "$(docker compose -f docker-compose.test.yml ps -q postgres)" \
  psql -U breeze_app -d breeze -c \
  "INSERT INTO ai_operator_task_targets (org_id, task_id, target_kind, device_id, target_label, target_ordinal) VALUES (gen_random_uuid(), gen_random_uuid(), 'device', NULL, 'forged', 0);"
```
Expected: FAIL. Two acceptable failures, both proving the boundary: `new row violates row-level security policy for table "ai_operator_task_targets"` (RLS rejected it first), or `new row for relation "ai_operator_task_targets" violates check constraint "ai_operator_task_targets_kind_pointer_chk"` (the CHECK rejected the null pointer first). If it SUCCEEDS, stop — the policies did not apply.

- [ ] **Step 5: Run the migration ordering and RLS-scope guards**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS. `migrationRlsScope.test.ts` must stay green **without** adding either new file to its frozen baseline — the DDL file writes no rows, and Task 5's DML file elects system scope in its first statement.

- [ ] **Step 6: Commit**

`git add apps/api/migrations/2026-10-18-100000-ai-operator-task-graph.sql && git commit -m "feat(api): AI Operator task targets, target accounts, steps and append-only events"`

---

### Task 4: Drizzle schema for the four tables + enum parity

**Files:**
- Create: `apps/api/src/db/schema/aiOperatorTaskGraph.ts`
- Modify: `apps/api/src/db/schema/index.ts:77` (add `export * from './aiOperatorTaskGraph';` after `./aiOperatorTasks`)
- Create: `apps/api/src/db/schema/aiOperatorTaskGraph.test.ts`
- Modify: `apps/api/src/services/aiOperator/enumParity.test.ts`

**Why a sibling file and not `aiOperatorTasks.ts`:** that file is 409 lines today and the four tables plus their commentary add ~350, which clears the ~500-line soft guideline and the wave brief's ~600 ceiling. The split is by lifecycle, not by line count: `aiOperatorTasks.ts` holds the task and its two thin-slice siblings; `aiOperatorTaskGraph.ts` holds the object graph hanging off it. The import direction is one-way (`aiOperatorTaskGraph` imports `aiOperatorTasks`, never the reverse), same rule as the thin slice's own header note.

**Interfaces:**
- Consumes: `aiOperatorTasks` (`./aiOperatorTasks`), `organizations` (`./orgs`), `devices`, `tickets`, `contacts`, `m365Connections` (`./m365`), `googleWorkspaceConnections` (`./google`).
- Produces:
  ```ts
  export const AI_OPERATOR_TARGET_KINDS, AI_OPERATOR_TARGET_STATES, AI_OPERATOR_STEP_KINDS,
    AI_OPERATOR_STEP_STATES, AI_OPERATOR_ACCOUNT_PROVIDERS, AI_OPERATOR_TASK_EVENT_TYPES,
    AI_OPERATOR_EVENT_ACTOR_KINDS;                         // the schema-side copies
  export const aiOperatorTaskTargets, aiOperatorTaskTargetAccounts,
    aiOperatorTaskSteps, aiOperatorTaskEvents;             // pgTable
  export type AiOperatorTaskTargetRow, AiOperatorTaskTargetAccountRow,
    AiOperatorTaskStepRow, AiOperatorTaskEventRow;
  ```

- [ ] **Step 1: Write the failing schema test — the real one, in full**

```ts
// apps/api/src/db/schema/aiOperatorTaskGraph.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import {
  AI_OPERATOR_ACCOUNT_PROVIDERS,
  AI_OPERATOR_STEP_KINDS,
  AI_OPERATOR_TARGET_KINDS,
  aiOperatorTaskEvents,
  aiOperatorTaskSteps,
  aiOperatorTaskTargetAccounts,
  aiOperatorTaskTargets,
} from './aiOperatorTaskGraph';

const names = (t: Parameters<typeof getTableColumns>[0]) =>
  Object.values(getTableColumns(t)).map((c) => c.name).sort();

describe('AI Operator task-graph Drizzle schema (recipe spec §5.1-§5.3)', () => {
  it('ai_operator_task_targets has exactly the spec columns', () => {
    expect(getTableName(aiOperatorTaskTargets)).toBe('ai_operator_task_targets');
    expect(names(aiOperatorTaskTargets)).toEqual([
      'contact_id', 'created_at', 'detached_at', 'detached_reason', 'device_id',
      'id', 'org_id', 'state', 'target_kind', 'target_label', 'target_ordinal',
      'task_id', 'ticket_id', 'updated_at',
    ]);
  });

  it('ai_operator_task_target_accounts splits the connection pointer by provider', () => {
    expect(getTableName(aiOperatorTaskTargetAccounts)).toBe('ai_operator_task_target_accounts');
    const cols = names(aiOperatorTaskTargetAccounts);
    expect(cols).toContain('m365_connection_id');
    expect(cols).toContain('google_connection_id');
    // A single polymorphic connection_id could reference neither table with a
    // real FK — that is how a cross-tenant connection pointer gets in.
    expect(cols).not.toContain('connection_id');
    expect(cols).toEqual([
      'created_at', 'external_id', 'google_connection_id', 'id',
      'm365_connection_id', 'org_id', 'principal_label', 'provider',
      'target_id', 'task_id', 'updated_at',
    ]);
  });

  it('ai_operator_task_steps carries step_kind and no checklist column (that is wave E3)', () => {
    expect(getTableName(aiOperatorTaskSteps)).toBe('ai_operator_task_steps');
    const cols = names(aiOperatorTaskSteps);
    expect(cols).toContain('step_kind');
    expect(cols).not.toContain('checklist_item_id');
  });

  it('ai_operator_task_events has NO jsonb column and NO update timestamp', () => {
    expect(getTableName(aiOperatorTaskEvents)).toBe('ai_operator_task_events');
    const cols = getTableColumns(aiOperatorTaskEvents);
    for (const column of Object.values(cols)) {
      expect(column.columnType).not.toBe('PgJsonb');
    }
    // Append-only: there is nothing to update, so there is no updated_at.
    expect(names(aiOperatorTaskEvents)).not.toContain('updated_at');
  });

  it('every org_id is NOT NULL (Shape 1, auto-discovered by the RLS contract)', () => {
    for (const table of [
      aiOperatorTaskTargets, aiOperatorTaskTargetAccounts,
      aiOperatorTaskSteps, aiOperatorTaskEvents,
    ]) {
      expect(getTableColumns(table).orgId.notNull).toBe(true);
    }
  });

  it('exports the CHECK value lists the migration constrains on', () => {
    expect([...AI_OPERATOR_TARGET_KINDS]).toEqual(['device', 'ticket', 'contact']);
    expect([...AI_OPERATOR_ACCOUNT_PROVIDERS]).toEqual(['m365', 'google']);
    expect(AI_OPERATOR_STEP_KINDS).toHaveLength(6);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/aiOperatorTaskGraph.test.ts`
Expected: FAIL — `Cannot find module './aiOperatorTaskGraph'`. Six tests, all failing to collect. If vitest reports "No test files found", the path is wrong — fix that before continuing; a 0-test run is a stall, not a red.

- [ ] **Step 3: Write `apps/api/src/db/schema/aiOperatorTaskGraph.ts`**

```ts
import { sql } from 'drizzle-orm';
import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { tickets } from './tickets';
import { contacts } from './contacts';
import { m365Connections } from './m365';
import { googleWorkspaceConnections } from './google';
import { aiOperatorTasks } from './aiOperatorTasks';

// AI Operator Recipe Library wave E2 — the task object graph.
// Migration: apps/api/migrations/2026-10-18-100000-ai-operator-task-graph.sql —
// read its header for the full rationale; this file mirrors it, it does not
// re-argue it.
//
// Split out of aiOperatorTasks.ts by LIFECYCLE, not by line count: that module
// owns the task and its two thin-slice siblings, this one owns everything
// hanging off a task. The import direction is one-way — this module imports
// `aiOperatorTasks`, and `aiOperatorTasks.ts` must NEVER import this one, for
// the same module-cycle reason its own header gives.
//
// Tenancy Shape 1 throughout: direct, NOT NULL, immutable `org_id`, ENABLE +
// FORCE RLS with `breeze_has_org_access(org_id)` policies declared in the
// creating migration. Auto-discovered by rls-coverage.integration.test.ts —
// nothing here belongs in any RLS allowlist.
//
// Every state/kind column is `text` + CHECK, never a pgEnum: under forced RLS
// enum equality is not leakproof and cannot become an index condition
// (Operator spec §11.1).

export const AI_OPERATOR_TARGET_KINDS = ['device', 'ticket', 'contact'] as const;
export type AiOperatorTargetKind = (typeof AI_OPERATOR_TARGET_KINDS)[number];

export const AI_OPERATOR_TARGET_STATES = [
  'pending', 'active', 'succeeded', 'failed', 'skipped', 'detached',
] as const;
export type AiOperatorTargetState = (typeof AI_OPERATOR_TARGET_STATES)[number];

export const AI_OPERATOR_STEP_KINDS = [
  'reason', 'effect', 'probe', 'wait', 'human_work', 'document',
] as const;
export type AiOperatorStepKind = (typeof AI_OPERATOR_STEP_KINDS)[number];

export const AI_OPERATOR_STEP_STATES = [
  'pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped',
] as const;
export type AiOperatorStepState = (typeof AI_OPERATOR_STEP_STATES)[number];

export const AI_OPERATOR_ACCOUNT_PROVIDERS = ['m365', 'google'] as const;
export type AiOperatorAccountProvider = (typeof AI_OPERATOR_ACCOUNT_PROVIDERS)[number];

export const AI_OPERATOR_TASK_EVENT_TYPES = [
  'task_admitted', 'lease_claimed', 'step_opened', 'step_settled',
  'wait_entered', 'wait_resolved', 'target_attached', 'target_detached',
  'target_account_frozen', 'operation_reserved', 'operation_settled',
  'verification_recorded', 'plan_revision_bumped', 'task_settled',
] as const;
export type AiOperatorTaskEventType = (typeof AI_OPERATOR_TASK_EVENT_TYPES)[number];

export const AI_OPERATOR_EVENT_ACTOR_KINDS = [
  'coordinator', 'reconciler', 'user', 'agent', 'system',
] as const;
export type AiOperatorEventActorKind = (typeof AI_OPERATOR_EVENT_ACTOR_KINDS)[number];

export const aiOperatorTaskTargets = pgTable(
  'ai_operator_task_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),

    targetKind: text('target_kind').$type<AiOperatorTargetKind>().notNull(),

    // THREE POINTERS, THREE FK SHAPES (migration header note A).
    // device/ticket are PLAIN FKs with no composite: Operator spec §11.3's
    // matrix says so, and a composite one would make the device-move trigger
    // and moveTicketOrg 23503 instead of leaving a stale pointer for the
    // detach statement to clear.
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    // contact is COMPOSITE — declared in the table extras below. A contact
    // never moves between orgs, so the composite costs nothing and buys the
    // guarantee that matters most here: an offboarding task can never name a
    // person in another tenant.
    contactId: uuid('contact_id'),

    targetLabel: text('target_label').notNull(),
    targetOrdinal: integer('target_ordinal').notNull(),

    state: text('state').$type<AiOperatorTargetState>().notNull().default('pending'),

    detachedAt: timestamp('detached_at', { withTimezone: true }),
    // Reuses AI_OPERATOR_TARGET_DETACH_REASONS from ./aiOperatorTasks — the
    // same four values, deliberately NOT forked. Typed as a string here rather
    // than importing the type, to keep this module's import of
    // `aiOperatorTasks` to the table alone; enumParity.test.ts pins the CHECK.
    detachedReason: text('detached_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // The tuple children reference: THREE columns, so a step or an account can
    // never name a target belonging to a different task of the same org
    // (Operator spec §11.3).
    idTaskOrgUq: uniqueIndex('ai_operator_task_targets_id_task_org_uq')
      .on(table.id, table.taskId, table.orgId),
    taskOrdinalUq: uniqueIndex('ai_operator_task_targets_task_ordinal_uq')
      .on(table.orgId, table.taskId, table.targetOrdinal),

    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_task_targets_task_org_fk',
    }).onDelete('cascade'),
    // The migration restricts SET NULL to the referencing column (PG15+) so
    // `org_id` survives; Drizzle cannot model the column list.
    contactOrgFk: foreignKey({
      columns: [table.contactId, table.orgId],
      foreignColumns: [contacts.id, contacts.orgId],
      name: 'ai_operator_task_targets_contact_org_fk',
    }).onDelete('set null'),

    deviceIdx: index('ai_operator_task_targets_device_idx')
      .on(table.deviceId).where(sql`device_id IS NOT NULL`),
    ticketIdx: index('ai_operator_task_targets_ticket_idx')
      .on(table.ticketId).where(sql`ticket_id IS NOT NULL`),
    contactIdx: index('ai_operator_task_targets_contact_idx')
      .on(table.contactId).where(sql`contact_id IS NOT NULL`),
  }),
);

export const aiOperatorTaskTargetAccounts = pgTable(
  'ai_operator_task_target_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),
    targetId: uuid('target_id').notNull(),

    provider: text('provider').$type<AiOperatorAccountProvider>().notNull(),

    // Two nullable columns, not one polymorphic `connection_id`: the two
    // providers live in two tables, and a single column could reference
    // neither with a real FK.
    m365ConnectionId: uuid('m365_connection_id'),
    googleConnectionId: uuid('google_connection_id'),

    /** Immutable Entra object id / Google user id — NEVER the UPN. This is what
     *  every dispatch addresses, so a rename mid-task cannot retarget an
     *  effect (recipe spec §5.2, D2). */
    externalId: text('external_id').notNull(),
    /** UPN / primary email at admission. DISPLAY ONLY. */
    principalLabel: text('principal_label').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    taskProviderUq: uniqueIndex('ai_operator_task_target_accounts_task_provider_uq')
      .on(table.orgId, table.taskId, table.provider),
    targetIdx: index('ai_operator_task_target_accounts_target_idx')
      .on(table.orgId, table.targetId),

    // SAME-ORG *AND* SAME-TASK.
    targetFk: foreignKey({
      columns: [table.targetId, table.taskId, table.orgId],
      foreignColumns: [
        aiOperatorTaskTargets.id,
        aiOperatorTaskTargets.taskId,
        aiOperatorTaskTargets.orgId,
      ],
      name: 'ai_operator_task_target_accounts_target_fk',
    }).onDelete('cascade'),
    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_task_target_accounts_task_org_fk',
    }).onDelete('cascade'),
    m365ConnOrgFk: foreignKey({
      columns: [table.m365ConnectionId, table.orgId],
      foreignColumns: [m365Connections.id, m365Connections.orgId],
      name: 'ai_operator_task_target_accounts_m365_conn_org_fk',
    }).onDelete('set null'),
    googleConnOrgFk: foreignKey({
      columns: [table.googleConnectionId, table.orgId],
      foreignColumns: [googleWorkspaceConnections.id, googleWorkspaceConnections.orgId],
      name: 'ai_operator_task_target_accounts_google_conn_org_fk',
    }).onDelete('set null'),
  }),
);

export const aiOperatorTaskSteps = pgTable(
  'ai_operator_task_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),

    stepKey: text('step_key').notNull(),
    stepKind: text('step_kind').$type<AiOperatorStepKind>().notNull(),

    targetId: uuid('target_id'),
    attemptOrdinal: integer('attempt_ordinal').notNull().default(0),
    state: text('state').$type<AiOperatorStepState>().notNull().default('pending'),
    planRevision: integer('plan_revision'),

    /** Bounded exportable text, never jsonb — Operator spec §11's export rule. */
    expectedCriterion: text('expected_criterion'),

    dependencyKind: text('dependency_kind')
      .$type<'intent' | 'operation' | 'run' | 'device_command' | 'user_answer' | 'verification'>(),
    dependencyId: uuid('dependency_id'),

    /** jsonb, therefore `excludedOpen` in the export policy WITHOUT exception. */
    checkpoint: jsonb('checkpoint').$type<Record<string, unknown>>().notNull().default({}),
    detail: text('detail'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // TWO partial uniques, not one five-column unique: a NULL target_id makes
    // a plain unique index enforce NOTHING for task-wide steps.
    identityUq: uniqueIndex('ai_operator_task_steps_identity_uq')
      .on(table.orgId, table.taskId, table.stepKey, table.targetId, table.attemptOrdinal)
      .where(sql`target_id IS NOT NULL`),
    identityNullTargetUq: uniqueIndex('ai_operator_task_steps_identity_null_target_uq')
      .on(table.orgId, table.taskId, table.stepKey, table.attemptOrdinal)
      .where(sql`target_id IS NULL`),
    taskStateIdx: index('ai_operator_task_steps_task_state_idx')
      .on(table.orgId, table.taskId, table.state),

    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_task_steps_task_org_fk',
    }).onDelete('cascade'),
    targetFk: foreignKey({
      columns: [table.targetId, table.taskId, table.orgId],
      foreignColumns: [
        aiOperatorTaskTargets.id,
        aiOperatorTaskTargets.taskId,
        aiOperatorTaskTargets.orgId,
      ],
      name: 'ai_operator_task_steps_target_fk',
    }).onDelete('set null'),
  }),
);

/**
 * APPEND-ONLY (migration header note C). `breeze_app` holds SELECT and INSERT
 * only; UPDATE and DELETE are revoked and a BEFORE trigger RAISEs 55000.
 * Registered in AUDIT_ADMIN_REQUIRED_TABLES (services/tenantCascade.ts) so org
 * erasure arms `breeze_audit_admin` for it.
 *
 * `actorUserId` and `targetId` carry NO Drizzle (or SQL) foreign key, and that
 * is not an omission: `ON DELETE SET NULL` performs an UPDATE, which the
 * immutability trigger rejects — deleting a user would abort with 55000 —
 * while RESTRICT would make a user undeletable. Typed references only.
 */
export const aiOperatorTaskEvents = pgTable(
  'ai_operator_task_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),

    /** Allocated from `ai_operator_tasks.event_seq`. NOT the outbox's fixed
     *  terminal-status ordinal — see that column's COMMENT. */
    transitionSeq: bigint('transition_seq', { mode: 'number' }).notNull(),

    eventType: text('event_type').$type<AiOperatorTaskEventType>().notNull(),
    actorKind: text('actor_kind').$type<AiOperatorEventActorKind>().notNull(),
    actorUserId: uuid('actor_user_id'),

    stepKey: text('step_key'),
    targetId: uuid('target_id'),

    /** Bounded text. There is deliberately NO jsonb column on this table. */
    detail: text('detail'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    taskSeqUq: uniqueIndex('ai_operator_task_events_task_seq_uq')
      .on(table.taskId, table.transitionSeq),
    orgTaskCreatedIdx: index('ai_operator_task_events_org_task_created_idx')
      .on(table.orgId, table.taskId, table.createdAt.desc()),
    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_task_events_task_org_fk',
    }).onDelete('cascade'),
  }),
);

export type AiOperatorTaskTargetRow = typeof aiOperatorTaskTargets.$inferSelect;
export type AiOperatorTaskTargetAccountRow = typeof aiOperatorTaskTargetAccounts.$inferSelect;
export type AiOperatorTaskStepRow = typeof aiOperatorTaskSteps.$inferSelect;
export type AiOperatorTaskEventRow = typeof aiOperatorTaskEvents.$inferSelect;
```

Add to `apps/api/src/db/schema/index.ts` after `export * from './aiOperatorTasks';` (line 76):

```ts
export * from './aiOperatorTaskGraph';
```

- [ ] **Step 4: Run the schema test — expect PASS (6 tests)**

Run: `cd apps/api && npx vitest run src/db/schema/aiOperatorTaskGraph.test.ts`
If `./tickets` or `./google` is not the module that exports `tickets` / `googleWorkspaceConnections`, run `grep -rn "export const tickets = pgTable\|export const googleWorkspaceConnections" apps/api/src/db/schema/` and use whatever it prints. Do not guess.

- [ ] **Step 5: Extend `enumParity.test.ts`**

Append to the first `describe` block in `apps/api/src/services/aiOperator/enumParity.test.ts` (after the `AI_OPERATOR_EXECUTION_REF_KINDS` case, line 66), and add the imports:

```ts
// add to the '@breeze/shared' import list at line 26:
  AI_OPERATOR_ACCOUNT_PROVIDERS as SHARED_ACCOUNT_PROVIDERS,
  AI_OPERATOR_EVENT_ACTOR_KINDS as SHARED_EVENT_ACTOR_KINDS,
  AI_OPERATOR_STEP_KINDS as SHARED_STEP_KINDS,
  AI_OPERATOR_STEP_STATES as SHARED_STEP_STATES,
  AI_OPERATOR_TARGET_KINDS as SHARED_TARGET_KINDS,
  AI_OPERATOR_TARGET_STATES as SHARED_TARGET_STATES,
  AI_OPERATOR_TASK_EVENT_TYPES as SHARED_TASK_EVENT_TYPES,

// a NEW import block beside the existing schema import at line 34:
import {
  AI_OPERATOR_ACCOUNT_PROVIDERS as SCHEMA_ACCOUNT_PROVIDERS,
  AI_OPERATOR_EVENT_ACTOR_KINDS as SCHEMA_EVENT_ACTOR_KINDS,
  AI_OPERATOR_STEP_KINDS as SCHEMA_STEP_KINDS,
  AI_OPERATOR_STEP_STATES as SCHEMA_STEP_STATES,
  AI_OPERATOR_TARGET_KINDS as SCHEMA_TARGET_KINDS,
  AI_OPERATOR_TARGET_STATES as SCHEMA_TARGET_STATES,
  AI_OPERATOR_TASK_EVENT_TYPES as SCHEMA_TASK_EVENT_TYPES,
} from '../../db/schema/aiOperatorTaskGraph';
import { TARGET_KINDS as RECIPE_TARGET_KINDS } from './recipes/types';
```

```ts
  it('AI_OPERATOR_TARGET_KINDS matches byte-for-byte', () => {
    expect([...SHARED_TARGET_KINDS]).toEqual([...SCHEMA_TARGET_KINDS]);
  });

  it('AI_OPERATOR_TARGET_STATES matches byte-for-byte', () => {
    expect([...SHARED_TARGET_STATES]).toEqual([...SCHEMA_TARGET_STATES]);
  });

  it('AI_OPERATOR_STEP_KINDS matches byte-for-byte', () => {
    expect([...SHARED_STEP_KINDS]).toEqual([...SCHEMA_STEP_KINDS]);
  });

  it('AI_OPERATOR_STEP_STATES matches byte-for-byte', () => {
    expect([...SHARED_STEP_STATES]).toEqual([...SCHEMA_STEP_STATES]);
  });

  it('AI_OPERATOR_ACCOUNT_PROVIDERS matches byte-for-byte', () => {
    expect([...SHARED_ACCOUNT_PROVIDERS]).toEqual([...SCHEMA_ACCOUNT_PROVIDERS]);
  });

  it('AI_OPERATOR_TASK_EVENT_TYPES matches byte-for-byte', () => {
    expect([...SHARED_TASK_EVENT_TYPES]).toEqual([...SCHEMA_TASK_EVENT_TYPES]);
  });

  it('AI_OPERATOR_EVENT_ACTOR_KINDS matches byte-for-byte', () => {
    expect([...SHARED_EVENT_ACTOR_KINDS]).toEqual([...SCHEMA_EVENT_ACTOR_KINDS]);
  });

  // THREE copies now, not two: E1's recipe registry has its own TargetKind
  // (recipe spec §6.1), and a recipe that declares `targetKinds: ['contact']`
  // for a value the CHECK constraint does not permit fails at INSERT time,
  // in production, on a real offboarding. Pin it here with the other two.
  it('the recipe registry TargetKind matches the DB/wire target kinds', () => {
    expect([...RECIPE_TARGET_KINDS].sort()).toEqual([...SCHEMA_TARGET_KINDS].sort());
  });
```

**If `recipes/types.ts` exports the union as a TYPE only** (no runtime array named `TARGET_KINDS`), drop that last `it` and replace it with a compile-time mutual-assignability check in the second half of the file, following the `MutuallyAssignable` pattern already there (line 101):

```ts
type _TargetKindParity =
  MutuallyAssignable<import('./recipes/types').TargetKind, AiOperatorTargetKind> extends true ? true : never;
```
…and add `const targetKindCheck: _TargetKindParity = true;` to the existing runtime anchor test at line 115. Check which shape E1 shipped with `grep -n "TargetKind" apps/api/src/services/aiOperator/recipes/types.ts` before writing either.

- [ ] **Step 6: Run enum parity + schema drift**

Run: `cd apps/api && npx vitest run src/services/aiOperator/enumParity.test.ts`
Expected: PASS (13-14 tests).

Run (repo root, with the test stack up and `DATABASE_URL` set): `pnpm db:check-drift`
Expected: no drift. A mismatch here almost always means the Drizzle table and the migration disagree on a column name or a default — fix the Drizzle side, never the shipped migration.

- [ ] **Step 7: Commit**

`git add apps/api/src/db/schema/aiOperatorTaskGraph.ts apps/api/src/db/schema/aiOperatorTaskGraph.test.ts apps/api/src/db/schema/index.ts apps/api/src/services/aiOperator/enumParity.test.ts && git commit -m "feat(api): Drizzle schema for AI Operator task targets, accounts, steps and events"`

---

### Task 5: Backfill migration — every existing task gets a target row and a step row

**Files:**
- Create: `apps/api/migrations/2026-10-18-100100-ai-operator-inline-target-backfill.sql`

- [ ] **Step 1: Confirm the file sorts after Task 3's**

Run: `ls apps/api/migrations/*.sql | sort | tail -2`
Expected: `…/2026-10-18-100000-ai-operator-task-graph.sql` then nothing newer. This file is `2026-10-18-100100-…` so it sorts after. If Task 3 was renamed in its Step 1, rename this one to match (same date, `+100` on the time component).

- [ ] **Step 2: Write the backfill**

```sql
-- apps/api/migrations/2026-10-18-100100-ai-operator-inline-target-backfill.sql
--
-- 2026-10-18: migrate the AI Operator thin slice's INLINE target and step to
-- rows (recipe spec §5.5, Operator plan P3-2: "migrate P3-1's inline
-- current_step_key/checkpoint to step rows").
--
-- THE INLINE COLUMNS ARE NOT DROPPED. `ai_operator_tasks.device_id`,
-- `target_label`, `target_detached_at`, `target_detached_reason` and
-- `current_step_key` remain as a READ PROJECTION until P3-5 removes them
-- (recipe spec §5.5). Everything that reads them today keeps working, the
-- detail DTO keeps its `target` object, and the three device detach paths keep
-- writing BOTH the task columns and the new target rows. Dropping them here
-- would turn an additive wave into a breaking one for every reader in the
-- repo and in the web app.
--
-- DML ONLY, and therefore SYSTEM SCOPE FIRST. `breeze_current_scope()`
-- defaults to 'none' and 425 of 442 tables are FORCE ROW LEVEL SECURITY, which
-- binds the table OWNER — the role migrations run as. Without the election
-- below, the INSERTs abort with 42501 on any connection that does not bypass
-- RLS, and an UPDATE would silently match zero rows while RAISE WARNING
-- printed a truthful-looking '0'. `is_local = true` scopes it to autoMigrate's
-- per-file transaction. Enforced by apps/api/src/db/migrationRlsScope.test.ts —
-- and NEVER add this file to that test's frozen 122-offender baseline.
--
-- IDEMPOTENT BY CONSTRUCTION, not by IF NOT EXISTS: every INSERT is a
-- `SELECT … WHERE NOT EXISTS (…)` against the row it would create, so a second
-- run inserts nothing and reports 0. Re-running is a true no-op.
--
-- Row counts are reported with RAISE WARNING even when zero. A backfill that
-- silently touches nothing is indistinguishable from a backfill that silently
-- failed, and this one re-parents tenant data — the count belongs in the
-- Postgres log either way (lesson from 2026-06-10-c).
--
-- SCALE NOTE. `ai_operator_tasks` is behind AI_OPERATOR_TASKS_ENABLED and has
-- at most a handful of rows in every environment today, so these are plain
-- single-statement backfills. If that stops being true before this ships,
-- convert each INSERT to a batched `WHERE ctid IN (… LIMIT 5000)` loop — the
-- statements below are already written as set-based inserts with an anti-join,
-- so the conversion is mechanical.

SELECT set_config('breeze.scope', 'system', true);

-- ---------------------------------------------------------------------------
-- 1. One target row per task that has (or had) a device target
-- ---------------------------------------------------------------------------
--
-- Covers the DETACHED case too: a task whose device_id is already NULL but
-- whose target_detached_at is stamped had a real target, and its frozen
-- `target_label` is the evidence of what it was. Skipping those would lose
-- history. A task with neither a device_id nor a detach stamp never had a
-- target (there is no such row today — every admission sets both — but the
-- predicate says so rather than assuming it).

DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO ai_operator_task_targets (
    org_id, task_id, target_kind, device_id, target_label, target_ordinal,
    state, detached_at, detached_reason, created_at, updated_at
  )
  SELECT
    t.org_id,
    t.id,
    'device',
    t.device_id,
    COALESCE(t.target_label, 'device ' || COALESCE(t.device_id::text, '(detached)')),
    0,                       -- recipe spec §5.1: ordinal 0, the only target
    CASE
      WHEN t.target_detached_at IS NOT NULL THEN 'detached'
      WHEN t.state IN ('completed', 'partial') THEN 'succeeded'
      WHEN t.state IN ('failed', 'expired', 'cancelled', 'handed_off') THEN 'failed'
      ELSE 'active'
    END,
    t.target_detached_at,
    t.target_detached_reason,
    t.created_at,            -- the target is as old as the task, not as old as this migration
    now()
  FROM ai_operator_tasks t
  WHERE (t.device_id IS NOT NULL OR t.target_detached_at IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM ai_operator_task_targets x
      WHERE x.task_id = t.id AND x.org_id = t.org_id AND x.target_ordinal = 0
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ai_operator_task_targets: backfilled % target row(s) from the inline device target', n;
END $$;

-- ---------------------------------------------------------------------------
-- 2. One step row per task that has a current_step_key
-- ---------------------------------------------------------------------------
--
-- STEP KIND IS DERIVED FROM THE SERVICE-RECOVERY SPINE, not guessed. The only
-- recipe in existence is `service_recovery`, whose ordered step keys are
-- ['investigate', 'execute', 'observe', 'verify', 'document']
-- (services/aiOperator/recipes/serviceRecovery.ts:50-52). Their kinds under
-- recipe spec §6.1's execution table are: investigate = reason,
-- execute = effect, observe = probe, verify = probe, document = document.
-- Any OTHER workflow_key present in the table would be a row this migration
-- cannot classify, so the ELSE arm below records it as 'reason' AND section 3
-- reports the count separately — a silent misclassification is worse than a
-- logged one.
--
-- attempt_ordinal is taken from the task's own `attempt_ordinal`, so the
-- backfilled step carries the identity the coordinator would have given it,
-- and a live task's next `openStep` call does not collide with it.
--
-- `plan_revision` is the task's current `revision`, and `state` mirrors where
-- the task actually is: a live task's current step is running or waiting; a
-- terminal task's current step is settled.

DO $$
DECLARE
  n integer;
  unknown_recipes integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO ai_operator_task_steps (
    org_id, task_id, step_key, step_kind, target_id, attempt_ordinal,
    state, plan_revision, checkpoint, started_at, settled_at, created_at, updated_at
  )
  SELECT
    t.org_id,
    t.id,
    t.current_step_key,
    CASE
      WHEN t.workflow_key = 'service_recovery' AND t.current_step_key = 'investigate' THEN 'reason'
      WHEN t.workflow_key = 'service_recovery' AND t.current_step_key = 'execute'     THEN 'effect'
      WHEN t.workflow_key = 'service_recovery' AND t.current_step_key = 'observe'     THEN 'probe'
      WHEN t.workflow_key = 'service_recovery' AND t.current_step_key = 'verify'      THEN 'probe'
      WHEN t.workflow_key = 'service_recovery' AND t.current_step_key = 'document'    THEN 'document'
      ELSE 'reason'
    END,
    tgt.id,
    t.attempt_ordinal,
    CASE
      WHEN t.state = 'waiting' THEN 'waiting'
      WHEN t.state IN ('queued', 'running', 'paused', 'stopping') THEN 'running'
      WHEN t.state IN ('completed', 'partial') THEN 'succeeded'
      ELSE 'failed'
    END,
    t.revision,
    -- The task's checkpoint IS this step's checkpoint: the thin slice keeps
    -- exactly one live step, so there is nothing to split.
    t.checkpoint,
    t.created_at,
    CASE WHEN t.state IN ('completed','partial','handed_off','cancelled','failed','expired')
         THEN t.updated_at ELSE NULL END,
    t.created_at,
    now()
  FROM ai_operator_tasks t
  LEFT JOIN ai_operator_task_targets tgt
    ON tgt.task_id = t.id AND tgt.org_id = t.org_id AND tgt.target_ordinal = 0
  WHERE t.current_step_key IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM ai_operator_task_steps s
      WHERE s.org_id = t.org_id
        AND s.task_id = t.id
        AND s.step_key = t.current_step_key
        AND s.attempt_ordinal = t.attempt_ordinal
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ai_operator_task_steps: backfilled % step row(s) from ai_operator_tasks.current_step_key', n;

  SELECT count(*) INTO unknown_recipes
  FROM ai_operator_tasks t
  WHERE t.current_step_key IS NOT NULL
    AND t.workflow_key <> 'service_recovery';
  RAISE WARNING 'ai_operator_task_steps: % backfilled step(s) belonged to a workflow_key other than service_recovery and were classified step_kind = reason by the ELSE arm — review if non-zero', unknown_recipes;
END $$;

-- ---------------------------------------------------------------------------
-- 3. One admission event per backfilled task, so no task has an empty timeline
-- ---------------------------------------------------------------------------
--
-- transition_seq 1 for every one of them, and ai_operator_tasks.event_seq is
-- advanced to match IN THE SAME STATEMENT SEQUENCE — otherwise the first
-- runtime appendTaskEvent would allocate 1 again and collide with this row on
-- ai_operator_task_events_task_seq_uq. That collision would be a 23505 inside
-- a request transaction, i.e. a 500 on the first coordinator tick after
-- deploy: the exact failure this section exists to prevent.
--
-- actor_kind = 'system' with a NULL actor_user_id: a backfill has no human
-- actor, and ai_operator_task_events_actor_chk enforces that pairing.

DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO ai_operator_task_events (
    org_id, task_id, transition_seq, event_type, actor_kind, actor_user_id,
    step_key, target_id, detail, created_at
  )
  SELECT
    t.org_id, t.id, 1, 'task_admitted', 'system', NULL,
    t.current_step_key,
    tgt.id,
    'Timeline opened by the wave E2 backfill. Events before this point were not recorded: the task predates ai_operator_task_events.',
    t.created_at
  FROM ai_operator_tasks t
  LEFT JOIN ai_operator_task_targets tgt
    ON tgt.task_id = t.id AND tgt.org_id = t.org_id AND tgt.target_ordinal = 0
  WHERE NOT EXISTS (
    SELECT 1 FROM ai_operator_task_events e WHERE e.task_id = t.id
  );

  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ai_operator_task_events: opened % task timeline(s) with a backfilled task_admitted event', n;

  UPDATE ai_operator_tasks t
     SET event_seq = GREATEST(t.event_seq, (
           SELECT COALESCE(max(e.transition_seq), 0)
           FROM ai_operator_task_events e
           WHERE e.task_id = t.id
         ))
   WHERE EXISTS (SELECT 1 FROM ai_operator_task_events e WHERE e.task_id = t.id);

  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ai_operator_tasks: advanced event_seq on % task(s) to match their highest event transition_seq', n;
END $$;
```

- [ ] **Step 3: Apply and verify idempotency**

Run the migrator twice (see Task 3 Step 3 for the exact command).
Expected: the first run logs non-zero counts if the database has tasks (zero is also a legitimate result on a clean stack — it proves nothing about the backfill, which is why Task 13's integration test seeds rows first). The **second** run must log `backfilled 0 target row(s)`, `backfilled 0 step row(s)` and `opened 0 task timeline(s)`.

- [ ] **Step 4: Run the guards**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS, with **no** edit to `migrationRlsScope.test.ts`'s baseline.

- [ ] **Step 5: Commit**

`git add apps/api/migrations/2026-10-18-100100-ai-operator-inline-target-backfill.sql && git commit -m "feat(api): backfill AI Operator inline targets and steps into rows"`

---

### Task 6: EVERY registration list — cascade, audit-admin, export policy, org merge, device axis, ticket axis, contact axis

This is the task that has shipped broken five times. **Treat every item as a mechanical grep, not a judgement call.** Do them all, in order, and run the contract suites at the end of the task rather than at the end of the PR.

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts:306-308` (order) and `:1084-1096` (audit admin)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:99-103`
- Modify: `apps/api/src/services/orgMergeRegistry.ts:256-260`
- Modify: `apps/api/src/services/orgMergeCustomExecutors.ts` (`fenceAiOperatorTasks`, ~:306-370)
- Modify: `apps/api/src/routes/devices/core.ts:188-190` and the comment at `:216-222`
- Modify: `apps/api/src/routes/devices/moveOrg.ts` (~:534, after the `ai_operator_tasks` statement)
- Modify: `apps/api/src/services/deviceDeletion.ts` (~:281, after the `ai_operator_tasks` statement)
- Modify: `apps/api/src/services/ticketService.ts` (`moveTicketOrg`, ~:2730)
- Modify: `apps/api/src/routes/devices/moveOrg.coverage.test.ts` (`INTENTIONALLY_NO_ORG_ID` + the ticket-axis exemption set)
- Modify: `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts:187` (`ORG_ID_BLOCKING_TRIGGERS`)

- [ ] **Step 1: `CORE_ORG_CASCADE_DELETE_ORDER` — four entries, localeCompare order**

In `apps/api/src/services/tenantCascade.ts`, replace lines 306-308:

```ts
  'ai_operator_operations',
  'ai_operator_task_outbox',
  'ai_operator_tasks',
```

with:

```ts
  'ai_operator_operations',
  // Recipe Library wave E2. All four are Shape 1 with a NOT NULL org_id, so
  // all four are required here. localeCompare puts '_' ahead of letters (see
  // the contact_external_links note below), which is why
  // …_task_target_accounts precedes …_task_targets and both precede
  // …_tasks — and, conveniently, why every child already sorts ahead of its
  // parent. Do not rely on that luck: topologicalCascadeOrder()'s runtime
  // pg_constraint read is what actually orders the DELETEs, and the
  // alphabetical position here is what tenantCascade.test.ts asserts.
  //
  // ai_operator_task_events is APPEND-ONLY (REVOKE DELETE from breeze_app plus
  // an immutability trigger), so it is ALSO in AUDIT_ADMIN_REQUIRED_TABLES
  // below. Membership here without membership there is a runtime
  // `permission denied` in the middle of a GDPR erasure.
  'ai_operator_task_events',
  'ai_operator_task_outbox',
  'ai_operator_task_steps',
  'ai_operator_task_target_accounts',
  'ai_operator_task_targets',
  'ai_operator_tasks',
```

- [ ] **Step 2: `AUDIT_ADMIN_REQUIRED_TABLES` — one entry**

In the same file, inside the set at lines 1084-1096, after `'script_proposal_reviews',`:

```ts
  // Append-only AI Operator task timeline: REVOKE UPDATE/DELETE from
  // breeze_app plus ai_operator_task_events_append_only()
  // (2026-10-18-100000), so erasure has to run as breeze_audit_admin with
  // breeze.allow_audit_retention=1.
  'ai_operator_task_events',
```

- [ ] **Step 3: `CORE_TENANT_EXPORT_POLICY` — four new entries and TWO new columns on an existing one**

The new-column half is the one that gets missed: `ai_operator_tasks` is already registered, and `ADD COLUMN` on a registered table breaks `tenant-export-policy.integration.test.ts`. Do both halves.

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, insert after line 100 (`"ai_operator_task_outbox": …`) and before the `// lease_owner is a coordinator instance label…` comment at 101:

```ts
  "ai_operator_task_events": tablePolicy("org_id", {"included":["id","org_id","task_id","transition_seq","event_type","actor_kind","actor_user_id","step_key","target_id","detail","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "ai_operator_task_steps": tablePolicy("org_id", {"included":["id","org_id","task_id","step_key","step_kind","target_id","attempt_ordinal","state","plan_revision","expected_criterion","dependency_kind","dependency_id","detail","started_at","settled_at","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["checkpoint"]}),
  "ai_operator_task_target_accounts": tablePolicy("org_id", {"included":["id","org_id","task_id","target_id","provider","m365_connection_id","google_connection_id","external_id","principal_label","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "ai_operator_task_targets": tablePolicy("org_id", {"included":["id","org_id","task_id","target_kind","device_id","ticket_id","contact_id","target_label","target_ordinal","state","detached_at","detached_reason","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

Classification rationale, so a reviewer can check it rather than trust it:
- `ai_operator_task_steps.checkpoint` is the **only** jsonb column across the four tables, and it is `excludedOpen` — the repo rule is that every `json`/`jsonb`/`bytea` column is excluded without exception, because an open container may embed credentials or capabilities. Everything a customer must be able to export therefore has its own bounded `text` column: `expected_criterion`, `detail`.
- `ai_operator_task_target_accounts.external_id` is an **identifier**, not a capability: it is the tenant's own Entra object id / Google user id, which the tenant already holds in their own directory. `included`. It trips no `SUSPICIOUS_NAME_PARTS` entry, so it is plain `included` and not `reviewedIncluded`.
- `m365_connection_id` / `google_connection_id` are row ids of connection records, not tokens — the credential material lives on those connection rows and is classified there. `included`.
- `ai_operator_task_events.detail` is bounded (≤ 4000) prose written by Breeze code, never raw model or tool output — the safe-projection rule of `taskReadService.ts` applies to what gets written here, not only to what gets read.

Then, on line 103, **append two entries to the `ai_operator_tasks` `included` array**, immediately after `"client_idempotency_key"`:

```
"workflow_config_id","event_seq",
```

- [ ] **Step 4: `orgMergeRegistry.ts` — four `leave-for-erasure` entries**

`getOrgMergePolicies()` derives its required set from `getOrgCascadeDeleteOrder()`, so Step 1 makes these **mandatory**: `orgMergeRegistry.integration.test.ts:344` ("every required table has exactly one policy") fails without them, and `:349` ("no policy names an unrequired table") fails if you add them without Step 1. The two edits land together.

In `apps/api/src/services/orgMergeRegistry.ts`, after the `ai_operator_task_outbox` entry (line 260):

```ts
  // Recipe Library wave E2. All four hang off a task that stays with the
  // source org (the ai_operator_tasks disposition above) through composite
  // (task_id, org_id) FKs, so they are erased with it and never repointed.
  // `leave-for-erasure`, NOT `custom`: the fence they need happens inside
  // fenceAiOperatorTasks, which already runs in the resolve phase and now
  // also detaches their device/ticket/contact/connection pointers — adding a
  // second custom executor would only duplicate it, and
  // orgMergeRegistry.integration.test.ts:429 requires every `custom` table to
  // have its own CUSTOM_EXECUTORS entry.
  ai_operator_task_targets: { kind: 'leave-for-erasure', note: 'frozen targets of a task that stays with the source org; fenceAiOperatorTasks detaches their device/ticket/contact pointers in the resolve phase, before devices/tickets/contacts repoint, then the rows are erased with the loser shell' },
  ai_operator_task_target_accounts: { kind: 'leave-for-erasure', note: 'frozen provider identities behind a contact target; the connection pointers are nulled in the resolve phase before m365_connections repoints and google_workspace_connections keeps the survivor, and the immutable external_id is retained as evidence' },
  ai_operator_task_steps: { kind: 'leave-for-erasure', note: 'step attempts of a task that stays with the source org; erased with it' },
  // Append-only: breeze_app has no UPDATE on this table at all, so any
  // repointing policy would 42501 — `leave-for-erasure` is the only legal
  // kind here, and it is also the correct one. Same shape as
  // agent_rollback_events (see the note in REPOINT_TABLES).
  ai_operator_task_events: { kind: 'leave-for-erasure', note: 'append-only task timeline; breeze_app holds no UPDATE grant, and the timeline is source-org evidence — erased with the loser shell under breeze_audit_admin' },
```

- [ ] **Step 5: `ORG_ID_BLOCKING_TRIGGERS` — classify the new append-only trigger**

`orgMergeRegistry.integration.test.ts` enumerates every live `BEFORE UPDATE … FOR EACH ROW` trigger on a table with an `org_id` column and **fails on any it has not been told about**. The new trigger is exactly that. In `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts`, add to `ORG_ID_BLOCKING_TRIGGERS` (line 187), beside the other unconditional append-only guards (after `'ml_feedback_events.ml_feedback_events_block_update'`, line 198):

```ts
  'ai_operator_task_events.ai_operator_task_events_block_update': 'unconditional append-only RAISE',
```

The suite then separately asserts that no `org_id`-mutating policy sits on a table with a blocking trigger — Step 4's `leave-for-erasure` satisfies that, because it is in the `NON_MUTATING` set.

- [ ] **Step 6: Device axis — `DEVICE_DETACH_DEVICE_ID_TABLES` + the exemption**

In `apps/api/src/routes/devices/core.ts`, extend the array at lines 188-190 and its comment:

```ts
// ai_operator_task_targets (recipe library E2) detaches for the same reason one
// level down: a target is the frozen record of WHAT a task was pointed at, and
// its target_label must outlive the device. Three callers stamp more than the
// generic device_id = NULL this list drives — deviceDeletion.ts
// ('device_deleted'), moveOrg.ts ('device_moved') and the merge fence
// ('org_merged') — and all three also set state = 'detached'.
export const DEVICE_DETACH_DEVICE_ID_TABLES = [
  'abuse_endpoint_fingerprints', 'ai_agent_runs', 'ai_operator_task_targets', 'ai_operator_tasks', 'invoice_line_devices', 'support_sessions', 'tickets',
] as const;
```

Then update the stale count in the `CORE_DEVICE_ORG_DENORMALIZED_TABLES` doc comment at line 219 — `"anchors four composite (x, org_id) FKs"` becomes `"anchors seven composite (x, org_id) FKs"` (the thin slice's four plus targets, steps and events) — and add, after line 222:

```
 * ai_operator_task_targets is deliberately ABSENT for exactly the same reason
 * (recipe library E2): a target's org_id IS its task's org_id and anchors
 * ai_operator_task_targets_task_org_fk, so a re-stamp here would 23503 while
 * the task stayed behind. moveOrg detaches instead. It is listed in
 * INTENTIONALLY_NO_ORG_ID in moveOrg.coverage.test.ts.
```

In `apps/api/src/routes/devices/moveOrg.coverage.test.ts`, add `ai_operator_task_targets` to `INTENTIONALLY_NO_ORG_ID` with that same rationale as a comment. Run `grep -n "INTENTIONALLY_NO_ORG_ID" apps/api/src/routes/devices/moveOrg.coverage.test.ts` to find the declaration; copy the shape of the existing `ai_agent_runs` / `ai_operator_tasks` entries verbatim.

- [ ] **Step 7: Device axis — the three detach statements**

(a) `apps/api/src/routes/devices/moveOrg.ts`, immediately after the existing `UPDATE ai_operator_tasks` statement (~line 534-542):

```ts
        // Recipe library E2: the same detach one level down. Normally matches
        // NOTHING — breeze_cascade_device_org_id() already ran when the
        // devices row flipped earlier in this transaction and carries an
        // identical statement (migration 2026-10-18-100000 section 9). Kept as
        // a route-local mirror for the same two reasons the task statement
        // above is: the detach is visible where the move is read, and the
        // route still detaches if the trigger is ever dropped. Both copies are
        // convergent (COALESCE on the stamp), so whichever runs first wins.
        await tx.execute(
          sql`UPDATE ai_operator_task_targets
                 SET device_id = NULL,
                     detached_at = COALESCE(detached_at, now()),
                     detached_reason = COALESCE(detached_reason, 'device_moved'),
                     state = 'detached',
                     updated_at = now()
               WHERE device_id = ${deviceId}::uuid`,
        );
```

(b) `apps/api/src/services/deviceDeletion.ts`, immediately after the existing `UPDATE ai_operator_tasks` statement (~line 281-287) and **before** the `DEVICE_DETACH_DEVICE_ID_TABLES` loop — so the loop's generic `device_id = NULL` is a no-op for these rows rather than clobbering the stamp:

```ts
  // Recipe library E2, same rule as the task statement above: a target whose
  // device is gone must RECORD that, or a detached target is indistinguishable
  // from a target whose pointer was never resolved.
  await tx.execute(sql`
    UPDATE ai_operator_task_targets
       SET device_id = NULL,
           detached_at = COALESCE(detached_at, now()),
           detached_reason = COALESCE(detached_reason, 'device_deleted'),
           state = 'detached',
           updated_at = now()
     WHERE device_id = ${deviceId}`);
```

(c) The trigger copy is already written in Task 3's migration, section 9.

- [ ] **Step 8: Ticket axis — detach inside `moveTicketOrg`, plus the documented exemption**

In `apps/api/src/services/ticketService.ts`, inside `moveTicketOrg`'s transaction, immediately after the `ai_agent_runs.ticket_id` sever (~line 2730) and **before** the `UPDATE tickets` at ~:2806:

```ts
    // Recipe library E2 — the ticket-axis twin of the ai_agent_runs statement
    // above, and for the identical reason. An AI Operator target's org_id is
    // its TASK's org_id, which is immutable source-org history, so the target
    // does NOT travel with the ticket. Leaving the pointer would give the
    // source org a ticket id that now belongs to another tenant.
    //
    // ai_operator_task_targets.ticket_id is a PLAIN single-column FK to
    // tickets(id) ON DELETE SET NULL (migration 2026-10-18-100000 header note
    // A), NOT a composite (ticket_id, org_id) tenant FK, so — exactly like
    // ai_agent_runs.ticket_id — the UPDATE below would complete happily and
    // the stale pointer would survive in silence. There is no trigger on
    // `UPDATE OF org_id ON tickets` either, so this service is the ONLY place
    // the contract is enforced.
    //
    // Ordering: placed with the ai_agent_runs sever, before the tickets
    // UPDATE, for the same lock-order reason stated there.
    await tx.execute(sql`
      UPDATE ai_operator_task_targets
         SET ticket_id = NULL,
             detached_at = COALESCE(detached_at, now()),
             detached_reason = COALESCE(detached_reason, 'scope_invalidated'),
             state = 'detached',
             updated_at = now()
       WHERE ticket_id = ${ticketId}`);
```

`'scope_invalidated'` rather than a new `'ticket_moved'` reason: the existing four-value vocabulary is shared with `ai_operator_tasks.target_detached_reason`, adding a fifth value means a CHECK change on **two** tables plus a shared-package list plus `enumParity.test.ts`, and recipe spec §5.1 already assigns `'scope_invalidated'` to "the target left the task's scope". If a later wave wants the finer reason, it is a one-line CHECK widening then.

Then add the ticket-axis exemption in `apps/api/src/routes/devices/moveOrg.coverage.test.ts` — find the `TICKET_ORG_DENORMALIZED_TABLES completeness (#5783)` describe block (~line 543) and its documented exemption set, and add `ai_operator_task_targets` with this rationale:

```
// ai_operator_task_targets carries ticket_id + org_id but is EXEMPT from
// TICKET_ORG_DENORMALIZED_TABLES / CUSTOM_ORG_REWRITE_TABLES: its org_id is
// its task's immutable org_id, so re-stamping it on a ticket move would
// 23503 against ai_operator_task_targets_task_org_fk. moveTicketOrg detaches
// ticket_id instead (services/ticketService.ts). It also has a device_id
// column, which CUSTOM_ORG_REWRITE_TABLES explicitly excludes.
```

- [ ] **Step 9: Contact axis — there is no list; the FK and the merge fence ARE the contract**

Verified: there is no contact org-move path (`ticketService.ts:2800-2805` — *"contacts are org-pinned and the requester does NOT move with the ticket"*), and `deleteContact` (`services/contacts/crud.ts:634-660`) is a bare `DELETE FROM contacts` with no child-table enumeration and no `CONTACT_CASCADE_*` constant anywhere in the repo. So the only two things that can move a contact out from under a target are (a) `DELETE FROM contacts`, handled by `ai_operator_task_targets_contact_org_fk`'s `ON DELETE SET NULL (contact_id)`, and (b) an org merge, which repoints `contacts` to the survivor (`orgMergeRegistry.ts:576`, executor `mergeContacts` at `orgMergeCustomExecutors.ts:775-800`).

(b) is the dangerous one and is handled in Step 10. (a) has a subtlety the executor must not miss: the FK nulls `contact_id` **without** stamping `detached_at`, which instantly violates `ai_operator_task_targets_one_pointer_chk`. Add a defensive detach so the app path stamps first, in `apps/api/src/services/contacts/crud.ts`'s `deleteContact`, immediately before the `DELETE FROM contacts`:

```ts
  // An AI Operator target frozen against this contact must record that the
  // person record is gone, not merely lose the pointer:
  // ai_operator_task_targets_one_pointer_chk requires a detach stamp whenever
  // no pointer is set, so the FK's own ON DELETE SET NULL would abort the
  // delete with 23514 if this ran after it. Stamp first, then delete.
  await tx.execute(sql`
    UPDATE ai_operator_task_targets
       SET contact_id = NULL,
           detached_at = COALESCE(detached_at, now()),
           detached_reason = COALESCE(detached_reason, 'scope_invalidated'),
           state = 'detached',
           updated_at = now()
     WHERE contact_id = ${contactId} AND org_id = ${orgId}`);
```

If `deleteContact` has no transaction handle today, wrap the two statements in one — a contact deleted with its targets left unstamped is a row that can never be updated again without tripping the CHECK. `grep -n "export async function deleteContact" -A 30 apps/api/src/services/contacts/crud.ts` before editing.

- [ ] **Step 10: Extend `fenceAiOperatorTasks` for targets and accounts**

In `apps/api/src/services/orgMergeCustomExecutors.ts`, inside `fenceAiOperatorTasks` (the executor at ~:306), after the existing `detached` statement (~:338-347) and before the `return`:

```ts
  // Recipe library E2. THREE pointers to sever, all in the RESOLVE phase and
  // all for the same reason the task's device detach above is here: the move
  // phase repoints `devices`, `tickets` and `contacts` to the survivor while
  // these targets stay with the loser. For contact_id that is not merely
  // untidy — ai_operator_task_targets_contact_org_fk is a COMPOSITE
  // (contact_id, org_id) FK, so a contact repointed to the survivor leaves the
  // pair unresolvable and the merge aborts at COMMIT with 23503, exactly like
  // m365_sync_state's resolve-phase DELETE (orgMergeRegistry.ts:440).
  //
  // Deliberately NOT restricted to live tasks: a terminal task's target is
  // leaving the tenant too, and its evidence should say so. Stamping
  // 'org_merged' here first also means the device-move trigger's
  // COALESCE(detached_reason, 'device_moved') preserves the REAL reason when
  // `devices` repoints later in the move phase.
  const targetsDetached = await run(sql`
    UPDATE ai_operator_task_targets
       SET device_id = NULL,
           ticket_id = NULL,
           contact_id = NULL,
           detached_at = COALESCE(detached_at, now()),
           detached_reason = COALESCE(detached_reason, 'org_merged'),
           state = 'detached',
           updated_at = now()
     WHERE org_id = ${uuid(loser)}
       AND (device_id IS NOT NULL OR ticket_id IS NOT NULL OR contact_id IS NOT NULL)`);

  // The frozen provider identity survives — external_id and principal_label are
  // the evidence of WHO the task was about — but the connection pointers must
  // go: m365_connections repoint-dedupes to the survivor and
  // google_workspace_connections keeps the survivor's row, and both FKs here
  // are composite (connection_id, org_id).
  const accountsDetached = await run(sql`
    UPDATE ai_operator_task_target_accounts
       SET m365_connection_id = NULL,
           google_connection_id = NULL,
           updated_at = now()
     WHERE org_id = ${uuid(loser)}
       AND (m365_connection_id IS NOT NULL OR google_connection_id IS NOT NULL)`);
```

…and add the two note strings to the returned `notes` array, following the shape of the two already there:

```ts
      ...(targetsDetached > 0
        ? [
            `ai_operator_task_targets: detached ${targetsDetached} AI Operator task target(s) from their device, ticket or contact — those records move to the surviving organization while the task history stays behind, so each target keeps its frozen label as evidence but no longer points at a live record.`,
          ]
        : []),
      ...(accountsDetached > 0
        ? [
            `ai_operator_task_target_accounts: cleared the provider connection pointer on ${accountsDetached} frozen account(s); the immutable external identifier and principal label are retained as evidence of who the task was about.`,
          ]
        : []),
```

**Do not add a `CUSTOM_EXECUTORS` entry for any of the four new tables** — Step 4 classified them `leave-for-erasure`, and `orgMergeRegistry.integration.test.ts:429` would then demand an executor that does not exist.

- [ ] **Step 11: Run every contract suite this task touches**

Unit (no DB):
```
cd apps/api && npx vitest run \
  src/services/tenantCascade.test.ts \
  src/routes/devices/moveOrg.coverage.test.ts \
  src/routes/devices/moveOrg.test.ts \
  src/routes/devices/cascadeDelete.test.ts \
  src/services/ticketOrgMoveLockOrder.test.ts
```
Expected: PASS. A failure naming one of the four new tables is the registration contract doing its job — read the message, it names the list.

Integration (live DB required — `pnpm test-stack up` at the repo root first):
```
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS, all six. `rls-coverage` must pass with **no** edit to any allowlist in it — if it demands one, a policy or a `FORCE ROW LEVEL SECURITY` is missing from Task 3's migration; fix the migration (it is unshipped and therefore still editable), do not add an allowlist entry.

- [ ] **Step 12: The mechanical grep, as a final check**

```
for t in ai_operator_task_targets ai_operator_task_target_accounts ai_operator_task_steps ai_operator_task_events; do
  echo "== $t"
  grep -rn "$t" apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts | cut -c1-140
done
```
Expected: `ai_operator_task_events` appears in all three files **and twice in `tenantCascade.ts`** (order + audit admin). The other three appear once in each of the three files. Any table missing from any file is a latent GDPR erasure bug — go back and add it.

- [ ] **Step 13: Commit**

`git add -A apps/api/src && git commit -m "feat(api): register AI Operator task graph in every cascade, export, merge and move contract"`

---

### Task 7: `eventService.ts` — `appendTaskEvent` with a monotonic `transition_seq`

**Files:**
- Create: `apps/api/src/services/aiOperator/eventService.ts`
- Create: `apps/api/src/services/aiOperator/eventService.test.ts`

**Interfaces:**
- Consumes: `db` (`../../db`), `aiOperatorTasks` (`../../db/schema/aiOperatorTasks`), `aiOperatorTaskEvents` + `AiOperatorTaskEventType` + `AiOperatorEventActorKind` (`../../db/schema/aiOperatorTaskGraph`).
- Produces:
  ```ts
  export type EventDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;
  export interface AppendTaskEventInput {
    orgId: string; taskId: string;
    eventType: AiOperatorTaskEventType;
    actor: { kind: 'user'; userId: string } | { kind: 'coordinator' | 'reconciler' | 'agent' | 'system' };
    stepKey?: string | null;
    targetId?: string | null;
    detail?: string | null;
  }
  export async function appendTaskEvent(dbh: EventDbHandle, input: AppendTaskEventInput): Promise<number | null>;
  ```
  Returns the allocated `transition_seq`, or `null` when the task row no longer exists (erased or never existed) — an event for a vanished task is a no-op, never a throw.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/eventService.test.ts
import { describe, expect, it, vi } from 'vitest';
import { appendTaskEvent } from './eventService';

/**
 * A minimal drizzle stub. It records what was asked of it rather than
 * simulating SQL: the assertions below are about the CONTRACT (one seq
 * allocation per event, taken from the task row, never from MAX(); a machine
 * actor never carries a user id), not about query shape.
 */
function stubDb(allocated: number | null) {
  const inserted: Array<Record<string, unknown>> = [];
  const update = vi.fn(() => ({
    set: () => ({
      where: () => ({
        returning: async () => (allocated === null ? [] : [{ eventSeq: allocated }]),
      }),
    }),
  }));
  const insert = vi.fn(() => ({
    values: async (v: Record<string, unknown>) => { inserted.push(v); },
  }));
  return { dbh: { insert, update, select: vi.fn() } as never, inserted, update, insert };
}

describe('appendTaskEvent (recipe spec §5, Operator spec §11)', () => {
  it('allocates transition_seq from the task row and writes it onto the event', async () => {
    const { dbh, inserted, update } = stubDb(7);
    const seq = await appendTaskEvent(dbh, {
      orgId: 'org-1', taskId: 'task-1',
      eventType: 'step_opened',
      actor: { kind: 'coordinator' },
      stepKey: 'investigate',
    });
    expect(seq).toBe(7);
    // The allocation is an UPDATE ... RETURNING on ai_operator_tasks, which
    // takes that row's lock and serialises concurrent writers. A MAX()+1 read
    // would instead race to a 23505 and abort the caller's transaction.
    expect(update).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      orgId: 'org-1', taskId: 'task-1', transitionSeq: 7,
      eventType: 'step_opened', actorKind: 'coordinator', stepKey: 'investigate',
    });
  });

  it('never stamps a user id on a machine actor (spec §7.1)', async () => {
    const { dbh, inserted } = stubDb(1);
    await appendTaskEvent(dbh, {
      orgId: 'org-1', taskId: 'task-1',
      eventType: 'task_settled', actor: { kind: 'reconciler' },
    });
    expect(inserted[0].actorUserId).toBeNull();
  });

  it('stamps the user id for a user actor', async () => {
    const { dbh, inserted } = stubDb(2);
    await appendTaskEvent(dbh, {
      orgId: 'org-1', taskId: 'task-1',
      eventType: 'task_settled', actor: { kind: 'user', userId: 'user-9' },
    });
    expect(inserted[0]).toMatchObject({ actorKind: 'user', actorUserId: 'user-9' });
  });

  it('truncates detail to the column bound rather than raising 23514', async () => {
    const { dbh, inserted } = stubDb(3);
    await appendTaskEvent(dbh, {
      orgId: 'org-1', taskId: 'task-1',
      eventType: 'operation_settled', actor: { kind: 'system' },
      detail: 'x'.repeat(9000),
    });
    expect((inserted[0].detail as string).length).toBe(4000);
  });

  it('is a no-op when the task row is gone, and inserts nothing', async () => {
    const { dbh, inserted, insert } = stubDb(null);
    const seq = await appendTaskEvent(dbh, {
      orgId: 'org-1', taskId: 'task-gone',
      eventType: 'task_settled', actor: { kind: 'system' },
    });
    expect(seq).toBeNull();
    expect(insert).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiOperator/eventService.test.ts`
Expected: FAIL — `Cannot find module './eventService'`.

- [ ] **Step 3: Write `eventService.ts`**

```ts
// AI Operator task event timeline (Recipe Library wave E2).
//
// WHY THIS FILE EXISTS: `ai_operator_task_events` is append-only evidence with
// a unique (task_id, transition_seq), and spec §6.2 requires "a monotonic
// transition sequence" persisted with the transition it describes. This is the
// ONE writer, so every caller converges on the same allocation and the same
// atomicity contract instead of each inventing one.
//
// ALLOCATION. `transition_seq` comes from `UPDATE ai_operator_tasks SET
// event_seq = event_seq + 1 … RETURNING event_seq`, never from
// `MAX(transition_seq) + 1`. The UPDATE takes the task's own row lock, so two
// writers for the same task serialise and neither ever sees a conflict. A
// MAX()+1 read would instead race to a 23505 — and a 23505 raised inside the
// request transaction ABORTS it, so an ordinary concurrent event would surface
// as a 500 and the only repair would be a SAVEPOINT retry loop.
//
// ATOMICITY. Callers MUST pass their own handle (`dbh`) — a bare `db` proxy
// that joins the caller's ambient withDbAccessContext/withSystemDbAccessContext
// transaction, or an explicit `tx` — so the event lands in the SAME Postgres
// transaction as the transition it announces. Same contract, and same wording,
// as `enqueueTaskOutbox` (taskOutbox.ts) and `reserveOperation`
// (operationService.ts). An event written in a later statement is not evidence
// of a transition; it is a claim about one.
//
// NOT THE OUTBOX. `ai_operator_task_outbox.transition_seq` is a FIXED terminal
// status ordinal (taskOutbox.ts:92, :127) chosen so a redelivered wake collapses
// onto one row. This counter is the opposite: strictly increasing, one per
// recorded transition. Do not unify them.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import {
  aiOperatorTaskEvents,
  type AiOperatorEventActorKind,
  type AiOperatorTaskEventType,
} from '../../db/schema/aiOperatorTaskGraph';

/** Mirrors `ai_operator_task_events_detail_len_chk`. */
const MAX_EVENT_DETAIL_CHARS = 4000;
/** Mirrors `ai_operator_task_events_step_key_len_chk`. */
const MAX_EVENT_STEP_KEY_CHARS = 128;

/** The subset of drizzle's `db` this helper needs — lets it join a caller's transaction. */
export type EventDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;

/**
 * Who did it. A union rather than two loose fields, because
 * `ai_operator_task_events_actor_chk` requires `actor_user_id` to be non-null
 * for `user` and null for everything else — spec §7.1's "database context has
 * no synthetic human user ID" made structural. Passing a user id with a
 * machine kind is unrepresentable here, so it cannot reach the CHECK.
 */
export type TaskEventActor =
  | { kind: 'user'; userId: string }
  | { kind: Exclude<AiOperatorEventActorKind, 'user'> };

export interface AppendTaskEventInput {
  orgId: string;
  taskId: string;
  eventType: AiOperatorTaskEventType;
  actor: TaskEventActor;
  stepKey?: string | null;
  /** `ai_operator_task_targets.id`. A typed reference with NO FK — see the
   *  table's schema comment for why an append-only row cannot carry one. */
  targetId?: string | null;
  detail?: string | null;
}

/**
 * Append one event. Returns the allocated `transition_seq`, or `null` if the
 * task row is gone.
 *
 * A vanished task is a NO-OP, not a throw: the reconciler and the erasure path
 * can both race an event write against a deleted task, and turning that into an
 * exception would abort the caller's whole transaction to record something
 * nobody can ever read.
 */
export async function appendTaskEvent(
  dbh: EventDbHandle,
  input: AppendTaskEventInput,
): Promise<number | null> {
  const [allocated] = await dbh
    .update(aiOperatorTasks)
    .set({ eventSeq: sql`${aiOperatorTasks.eventSeq} + 1` })
    .where(and(eq(aiOperatorTasks.id, input.taskId), eq(aiOperatorTasks.orgId, input.orgId)))
    .returning({ eventSeq: aiOperatorTasks.eventSeq });

  if (!allocated) return null;

  await dbh.insert(aiOperatorTaskEvents).values({
    orgId: input.orgId,
    taskId: input.taskId,
    transitionSeq: allocated.eventSeq,
    eventType: input.eventType,
    actorKind: input.actor.kind,
    actorUserId: input.actor.kind === 'user' ? input.actor.userId : null,
    stepKey: input.stepKey ? input.stepKey.slice(0, MAX_EVENT_STEP_KEY_CHARS) : null,
    targetId: input.targetId ?? null,
    // Truncate rather than let the CHECK raise: an over-long detail is a
    // logging mistake, and aborting a real state transition to punish it would
    // trade a cosmetic bug for a stuck task.
    detail: input.detail ? input.detail.slice(0, MAX_EVENT_DETAIL_CHARS) : null,
  });

  return allocated.eventSeq;
}
```

- [ ] **Step 4: Run the test — expect PASS (5 tests)**

Run: `cd apps/api && npx vitest run src/services/aiOperator/eventService.test.ts`

- [ ] **Step 5: Commit**

`git add apps/api/src/services/aiOperator/eventService.ts apps/api/src/services/aiOperator/eventService.test.ts && git commit -m "feat(api): appendTaskEvent with a row-lock-allocated monotonic transition_seq"`

---

### Task 8: `targetService.ts` — create, freeze accounts, detach, resolve a contact

**Files:**
- Create: `apps/api/src/services/aiOperator/targetService.ts`
- Create: `apps/api/src/services/aiOperator/targetService.test.ts`

**Interfaces:**
- Consumes: `db`, `aiOperatorTaskTargets`, `aiOperatorTaskTargetAccounts` (`../../db/schema/aiOperatorTaskGraph`), `contacts`, `contactExternalLinks` (`../../db/schema/contacts`), `appendTaskEvent` (`./eventService`).
- Produces:
  ```ts
  export type TargetDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;
  export interface CreateTaskTargetInput {
    orgId; taskId; targetKind: AiOperatorTargetKind;
    deviceId?: string | null; ticketId?: string | null; contactId?: string | null;
    targetLabel: string; targetOrdinal: number;
  }
  export async function createTaskTarget(dbh, input): Promise<{ id: string } | null>;
  export interface FreezeTargetAccountInput {
    orgId; taskId; targetId; provider: AiOperatorAccountProvider;
    connectionId: string | null; externalId: string; principalLabel: string;
  }
  export async function freezeTargetAccount(dbh, input): Promise<{ id: string }>;
  export interface DetachTargetsInput {
    orgId; taskId?: string; targetId?: string;
    reason: 'device_moved' | 'device_deleted' | 'org_merged' | 'scope_invalidated';
    actor: TaskEventActor;
  }
  export async function detachTargets(dbh, input): Promise<number>;
  export interface ResolveContactTargetInput {
    orgId; contactId; links: ReadonlyArray<{ system: 'm365' | 'google'; externalId: string }>;
  }
  export async function upsertContactExternalLinks(dbh, input): Promise<number>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/targetService.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  CONTACT_LINK_SYSTEMS,
  createTaskTarget,
  freezeTargetAccount,
  targetColumnForKind,
} from './targetService';

describe('targetService — kind/pointer agreement (recipe spec §5.1)', () => {
  it('maps each target kind to exactly one pointer column', () => {
    expect(targetColumnForKind('device')).toBe('deviceId');
    expect(targetColumnForKind('ticket')).toBe('ticketId');
    expect(targetColumnForKind('contact')).toBe('contactId');
  });

  it('refuses a target whose pointer does not match its kind, BEFORE the DB sees it', async () => {
    const dbh = { insert: vi.fn(), update: vi.fn(), select: vi.fn() } as never;
    await expect(createTaskTarget(dbh, {
      orgId: 'org-1', taskId: 'task-1', targetKind: 'contact',
      deviceId: 'device-1', contactId: null, targetLabel: 'Dana', targetOrdinal: 0,
    })).rejects.toThrow(/target_kind 'contact' requires contactId/);
    // The CHECK constraint would also catch this, but a 23514 inside the
    // admission transaction aborts it and surfaces as a 500. Refuse first.
    expect((dbh as unknown as { insert: ReturnType<typeof vi.fn> }).insert).not.toHaveBeenCalled();
  });

  it('refuses more than one pointer even when one of them matches the kind', async () => {
    const dbh = { insert: vi.fn(), update: vi.fn(), select: vi.fn() } as never;
    await expect(createTaskTarget(dbh, {
      orgId: 'org-1', taskId: 'task-1', targetKind: 'device',
      deviceId: 'device-1', ticketId: 'ticket-1', targetLabel: 'host', targetOrdinal: 0,
    })).rejects.toThrow(/exactly one pointer/);
  });

  it('truncates target_label to the column bound', async () => {
    const values = vi.fn(() => ({ returning: async () => [{ id: 'target-1' }] }));
    const dbh = { insert: vi.fn(() => ({ values })), update: vi.fn(), select: vi.fn() } as never;
    await createTaskTarget(dbh, {
      orgId: 'org-1', taskId: 'task-1', targetKind: 'device',
      deviceId: 'device-1', targetLabel: 'h'.repeat(400), targetOrdinal: 0,
    });
    expect((values.mock.calls[0][0] as { targetLabel: string }).targetLabel.length).toBe(255);
  });

  it('writes the connection id into the column its provider names, and nulls the other', async () => {
    const values = vi.fn(() => ({ onConflictDoUpdate: () => ({ returning: async () => [{ id: 'acct-1' }] }) }));
    const dbh = { insert: vi.fn(() => ({ values })), update: vi.fn(), select: vi.fn() } as never;
    await freezeTargetAccount(dbh, {
      orgId: 'org-1', taskId: 'task-1', targetId: 'target-1', provider: 'google',
      connectionId: 'conn-1', externalId: '1234567890', principalLabel: 'dana@acme.com',
    });
    expect(values.mock.calls[0][0]).toMatchObject({
      provider: 'google', googleConnectionId: 'conn-1', m365ConnectionId: null,
    });
  });

  it('pins the contact_external_links system vocabulary to m365 and google', () => {
    // `contact_external_links.system` is free-form text with no CHECK
    // (2026-08-19-contacts.sql) and is shared with the CSV/PSA importers, so
    // the Operator's own vocabulary has to be pinned in code or a typo would
    // create a second, silently-unmatched identity for the same person.
    expect([...CONTACT_LINK_SYSTEMS]).toEqual(['m365', 'google']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiOperator/targetService.test.ts`
Expected: FAIL — `Cannot find module './targetService'`.

- [ ] **Step 3: Write `targetService.ts`**

```ts
// AI Operator task targets and their frozen provider accounts
// (Recipe Library wave E2, spec §5.1 and §5.2).
//
// Every function takes the caller's transaction handle for the same reason
// eventService.ts and taskOutbox.ts do: a target created outside the admission
// transaction is a target that can exist without its task.
//
// THE POINT OF THE VALIDATION IN HERE. `ai_operator_task_targets` carries two
// CHECK constraints the database will absolutely enforce
// (…_one_pointer_chk, …_kind_pointer_chk). Relying on them alone is still
// wrong: a 23514 raised inside the admission transaction ABORTS it, so a
// caller cannot read back, cannot answer, and the route returns a 500 instead
// of a refusal. These functions therefore refuse first and let the CHECK be
// the backstop it is meant to be.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  aiOperatorTaskTargetAccounts,
  aiOperatorTaskTargets,
  type AiOperatorAccountProvider,
  type AiOperatorTargetKind,
} from '../../db/schema/aiOperatorTaskGraph';
import { contactExternalLinks } from '../../db/schema/contacts';
import { appendTaskEvent, type TaskEventActor } from './eventService';

/** Mirrors `ai_operator_task_targets_label_len_chk`. */
const MAX_TARGET_LABEL_CHARS = 255;
/** Mirrors `ai_operator_task_target_accounts_external_id_len_chk`. */
const MAX_EXTERNAL_ID_CHARS = 255;
/** Mirrors `ai_operator_task_target_accounts_principal_label_len_chk`. */
const MAX_PRINCIPAL_LABEL_CHARS = 320;

/**
 * The `contact_external_links.system` values the Operator owns.
 *
 * That column is free-form `text` with NO CHECK and NO enum
 * (2026-08-19-contacts.sql:178) and is shared with the CSV and PSA importers
 * ('csv', 'datto_rmm', 'connectwise', …), so nothing in the database stops a
 * typo. A mistyped system would create a SECOND identity row for the same
 * person that no later lookup ever matches — which, for an offboarding recipe,
 * means silently failing to disable an account. Pin it here.
 */
export const CONTACT_LINK_SYSTEMS = ['m365', 'google'] as const;
export type ContactLinkSystem = (typeof CONTACT_LINK_SYSTEMS)[number];

export type TargetDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;

const KIND_TO_COLUMN = {
  device: 'deviceId',
  ticket: 'ticketId',
  contact: 'contactId',
} as const satisfies Record<AiOperatorTargetKind, 'deviceId' | 'ticketId' | 'contactId'>;

/** Which pointer column a target kind must use. Exported so callers and tests
 *  cannot re-derive it differently. */
export function targetColumnForKind(kind: AiOperatorTargetKind): 'deviceId' | 'ticketId' | 'contactId' {
  return KIND_TO_COLUMN[kind];
}

export interface CreateTaskTargetInput {
  orgId: string;
  taskId: string;
  targetKind: AiOperatorTargetKind;
  deviceId?: string | null;
  ticketId?: string | null;
  contactId?: string | null;
  /** Frozen display label. Survives every detach — it is the evidence. */
  targetLabel: string;
  targetOrdinal: number;
  /** Written as a `target_attached` event when supplied. Omit inside a
   *  backfill or a bulk path that writes its own event. */
  actor?: TaskEventActor;
}

export async function createTaskTarget(
  dbh: TargetDbHandle,
  input: CreateTaskTargetInput,
): Promise<{ id: string }> {
  const pointers = {
    deviceId: input.deviceId ?? null,
    ticketId: input.ticketId ?? null,
    contactId: input.contactId ?? null,
  };
  const set = Object.values(pointers).filter((v) => v !== null);
  if (set.length !== 1) {
    throw new Error(
      `[aiOperator] createTaskTarget: exactly one pointer must be set, got ${set.length} `
      + `(device=${pointers.deviceId}, ticket=${pointers.ticketId}, contact=${pointers.contactId})`,
    );
  }
  const required = targetColumnForKind(input.targetKind);
  if (pointers[required] === null) {
    throw new Error(
      `[aiOperator] createTaskTarget: target_kind '${input.targetKind}' requires ${required}`,
    );
  }

  const [row] = await dbh
    .insert(aiOperatorTaskTargets)
    .values({
      orgId: input.orgId,
      taskId: input.taskId,
      targetKind: input.targetKind,
      ...pointers,
      targetLabel: input.targetLabel.slice(0, MAX_TARGET_LABEL_CHARS),
      targetOrdinal: input.targetOrdinal,
      state: 'active',
    })
    .returning({ id: aiOperatorTaskTargets.id });

  if (input.actor) {
    await appendTaskEvent(dbh, {
      orgId: input.orgId,
      taskId: input.taskId,
      eventType: 'target_attached',
      actor: input.actor,
      targetId: row.id,
      detail: `${input.targetKind} target ${input.targetLabel} frozen at ordinal ${input.targetOrdinal}`,
    });
  }

  return row;
}

export interface FreezeTargetAccountInput {
  orgId: string;
  taskId: string;
  targetId: string;
  provider: AiOperatorAccountProvider;
  /** The m365_connections / google_workspace_connections row id, or null when
   *  the recipe resolved the account without a live connection. */
  connectionId: string | null;
  /** Entra object id / Google user id — immutable, NEVER the UPN. */
  externalId: string;
  /** UPN / primary email at admission. Display only. */
  principalLabel: string;
  actor?: TaskEventActor;
}

/**
 * Freeze one provider account onto a target.
 *
 * `ON CONFLICT (org_id, task_id, provider) DO UPDATE` rather than DO NOTHING:
 * re-running intake after the technician corrects the person must replace the
 * frozen account, and DO NOTHING would silently keep the WRONG one — the
 * highest-consequence failure in the whole recipe (spec §11, first risk row).
 * Replacing is safe because nothing has been dispatched yet: the plan approval
 * (wave E4) pins the effect set AFTER accounts are frozen, and any change to
 * the account set bumps `revision` and supersedes an existing approval.
 */
export async function freezeTargetAccount(
  dbh: TargetDbHandle,
  input: FreezeTargetAccountInput,
): Promise<{ id: string }> {
  const values = {
    orgId: input.orgId,
    taskId: input.taskId,
    targetId: input.targetId,
    provider: input.provider,
    m365ConnectionId: input.provider === 'm365' ? input.connectionId : null,
    googleConnectionId: input.provider === 'google' ? input.connectionId : null,
    externalId: input.externalId.slice(0, MAX_EXTERNAL_ID_CHARS),
    principalLabel: input.principalLabel.slice(0, MAX_PRINCIPAL_LABEL_CHARS),
  };

  const [row] = await dbh
    .insert(aiOperatorTaskTargetAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: [
        aiOperatorTaskTargetAccounts.orgId,
        aiOperatorTaskTargetAccounts.taskId,
        aiOperatorTaskTargetAccounts.provider,
      ],
      set: {
        targetId: values.targetId,
        m365ConnectionId: values.m365ConnectionId,
        googleConnectionId: values.googleConnectionId,
        externalId: values.externalId,
        principalLabel: values.principalLabel,
        updatedAt: new Date(),
      },
    })
    .returning({ id: aiOperatorTaskTargetAccounts.id });

  if (input.actor) {
    await appendTaskEvent(dbh, {
      orgId: input.orgId,
      taskId: input.taskId,
      eventType: 'target_account_frozen',
      actor: input.actor,
      targetId: input.targetId,
      // The external id, not the label: the label can change under us, and
      // this line is the audit trail for WHICH account was addressed.
      detail: `${input.provider} account ${values.externalId} (${values.principalLabel}) frozen`,
    });
  }

  return row;
}

export interface DetachTargetsInput {
  orgId: string;
  /** Detach every target of one task… */
  taskId?: string;
  /** …or exactly one target. Supply one of the two, not neither. */
  targetId?: string;
  reason: 'device_moved' | 'device_deleted' | 'org_merged' | 'scope_invalidated';
  actor?: TaskEventActor;
  detail?: string;
}

/**
 * Detach targets, clearing every pointer and stamping the reason.
 *
 * ALL THREE POINTERS ARE CLEARED TOGETHER, and `detached_at` is stamped in the
 * SAME statement. `ai_operator_task_targets_one_pointer_chk` demands exactly
 * one pointer when the row is not detached and exactly zero when it is, so a
 * partial clear is unrepresentable — which is the constraint doing its job,
 * and why every caller that nulls a pointer (moveOrg, deviceDeletion,
 * moveTicketOrg, deleteContact, the merge fence) stamps in the same UPDATE.
 *
 * COALESCE on the stamp makes this convergent with those SQL-level statements:
 * whichever runs first wins the reason, the rest are no-ops.
 */
export async function detachTargets(
  dbh: TargetDbHandle,
  input: DetachTargetsInput,
): Promise<number> {
  if (!input.taskId && !input.targetId) {
    throw new Error('[aiOperator] detachTargets: supply taskId or targetId');
  }

  const rows = await dbh
    .update(aiOperatorTaskTargets)
    .set({
      deviceId: null,
      ticketId: null,
      contactId: null,
      detachedAt: sql`COALESCE(${aiOperatorTaskTargets.detachedAt}, now())`,
      detachedReason: sql`COALESCE(${aiOperatorTaskTargets.detachedReason}, ${input.reason})`,
      state: 'detached',
      updatedAt: new Date(),
    })
    .where(and(
      eq(aiOperatorTaskTargets.orgId, input.orgId),
      input.targetId ? eq(aiOperatorTaskTargets.id, input.targetId) : undefined,
      input.taskId ? eq(aiOperatorTaskTargets.taskId, input.taskId) : undefined,
    ))
    .returning({ id: aiOperatorTaskTargets.id, taskId: aiOperatorTaskTargets.taskId });

  if (input.actor) {
    for (const row of rows) {
      await appendTaskEvent(dbh, {
        orgId: input.orgId,
        taskId: row.taskId,
        eventType: 'target_detached',
        actor: input.actor,
        targetId: row.id,
        detail: input.detail ?? `target detached: ${input.reason}`,
      });
    }
  }

  return rows.length;
}

export interface UpsertContactExternalLinksInput {
  orgId: string;
  contactId: string;
  links: ReadonlyArray<{ system: ContactLinkSystem; externalId: string }>;
}

/**
 * Record a contact's provider identities so the NEXT task can re-identify the
 * same person without asking again (spec §5.2, D2: "Admission resolves or
 * creates the contact, upserts contact_external_links with system ∈
 * ('m365','google'), and freezes the external ids onto the task").
 *
 * `contact_external_links_uniq` is `(org_id, system, external_id)` — ORG-scoped
 * and deliberately not partner-scoped, because one person can work for two of
 * an MSP's customers. `DO NOTHING` on conflict: if the pair already points at
 * a DIFFERENT contact, two contact rows describe one provider account, which
 * is a data-quality problem for the intake step to surface to a human — it is
 * NOT something to resolve by silently repointing a link that other tasks may
 * already rely on.
 */
export async function upsertContactExternalLinks(
  dbh: TargetDbHandle,
  input: UpsertContactExternalLinksInput,
): Promise<number> {
  if (input.links.length === 0) return 0;

  const inserted = await dbh
    .insert(contactExternalLinks)
    .values(input.links.map((link) => ({
      orgId: input.orgId,
      contactId: input.contactId,
      system: link.system,
      externalId: link.externalId,
    })))
    .onConflictDoNothing({
      target: [
        contactExternalLinks.orgId,
        contactExternalLinks.system,
        contactExternalLinks.externalId,
      ],
    })
    .returning({ id: contactExternalLinks.id });

  return inserted.length;
}
```

- [ ] **Step 4: Run the test — expect PASS (6 tests)**

Run: `cd apps/api && npx vitest run src/services/aiOperator/targetService.test.ts`
If the drizzle stub's shape does not match the builder chain the real code uses (e.g. `.returning()` after `.onConflictDoUpdate()`), adjust the stub, not the service — the service's chain is what runs in production.

- [ ] **Step 5: Commit**

`git add apps/api/src/services/aiOperator/targetService.ts apps/api/src/services/aiOperator/targetService.test.ts && git commit -m "feat(api): AI Operator target service — create, freeze provider accounts, detach, contact links"`

---

### Task 9: `stepService.ts` — open, advance and settle step rows

**Files:**
- Create: `apps/api/src/services/aiOperator/stepService.ts`
- Create: `apps/api/src/services/aiOperator/stepService.test.ts`

**Interfaces:**
- Consumes: `db`, `aiOperatorTaskSteps` (`../../db/schema/aiOperatorTaskGraph`), `appendTaskEvent` (`./eventService`), `getRecipe` (`./recipes` — E1).
- Produces:
  ```ts
  export type StepDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;
  export interface OpenStepInput {
    orgId; taskId; stepKey; stepKind: AiOperatorStepKind;
    targetId?: string | null; attemptOrdinal: number; planRevision: number;
    expectedCriterion?: string | null; checkpoint?: Record<string, unknown>;
    actor?: TaskEventActor;
  }
  export async function openStep(dbh, input): Promise<{ id: string }>;
  export async function markStepWaiting(dbh, input): Promise<void>;
  export async function settleStep(dbh, input): Promise<void>;
  export function resolveStepKind(workflowKey: string, workflowVersion: number, stepKey: string): AiOperatorStepKind;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/stepService.test.ts
import { describe, expect, it, vi } from 'vitest';
import { openStep, resolveStepKind, settleStep } from './stepService';

function stubDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const insert = vi.fn(() => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoUpdate: () => ({
        returning: async () => { inserted.push(v); return [{ id: 'step-1' }]; },
      }),
    }),
  }));
  const update = vi.fn(() => ({
    set: (v: Record<string, unknown>) => ({
      where: () => ({ returning: async () => { updated.push(v); return [{ id: 'step-1', taskId: 'task-1' }]; } }),
    }),
  }));
  return { dbh: { insert, update, select: vi.fn() } as never, inserted, updated };
}

describe('stepService (Operator spec §11, recipe spec §5.3)', () => {
  it('opens a step with the full identity tuple the two partial uniques key on', async () => {
    const { dbh, inserted } = stubDb();
    await openStep(dbh, {
      orgId: 'org-1', taskId: 'task-1', stepKey: 'execute', stepKind: 'effect',
      targetId: 'target-1', attemptOrdinal: 2, planRevision: 3,
    });
    expect(inserted[0]).toMatchObject({
      orgId: 'org-1', taskId: 'task-1', stepKey: 'execute', stepKind: 'effect',
      targetId: 'target-1', attemptOrdinal: 2, planRevision: 3, state: 'running',
    });
  });

  it('is idempotent on re-open — a lease reclaim must not create a second row', async () => {
    const { dbh } = stubDb();
    const first = await openStep(dbh, {
      orgId: 'org-1', taskId: 'task-1', stepKey: 'verify', stepKind: 'probe',
      attemptOrdinal: 0, planRevision: 1,
    });
    const second = await openStep(dbh, {
      orgId: 'org-1', taskId: 'task-1', stepKey: 'verify', stepKind: 'probe',
      attemptOrdinal: 0, planRevision: 1,
    });
    // Same identity tuple -> ON CONFLICT DO UPDATE returns the SAME row. A
    // reclaimed lease re-runs the step function from the top (taskCoordinator
    // invariant: "a reclaim re-derives the same verdict"), so a DO NOTHING or
    // a plain insert would either lose the row or duplicate it.
    expect(second.id).toBe(first.id);
  });

  it('settles a step with a terminal state and a settled_at stamp', async () => {
    const { dbh, updated } = stubDb();
    await settleStep(dbh, {
      orgId: 'org-1', taskId: 'task-1', stepKey: 'execute', attemptOrdinal: 0,
      targetId: null, state: 'succeeded', detail: 'restart dispatched and verified',
    });
    expect(updated[0]).toMatchObject({ state: 'succeeded' });
    expect(updated[0].settledAt).toBeInstanceOf(Date);
  });

  it('classifies every service_recovery step key without consulting a model', () => {
    expect(resolveStepKind('service_recovery', 1, 'investigate')).toBe('reason');
    expect(resolveStepKind('service_recovery', 1, 'execute')).toBe('effect');
    expect(resolveStepKind('service_recovery', 1, 'observe')).toBe('probe');
    expect(resolveStepKind('service_recovery', 1, 'verify')).toBe('probe');
    expect(resolveStepKind('service_recovery', 1, 'document')).toBe('document');
  });

  it('falls back to reason for an unknown step key rather than throwing', () => {
    // A step row is EVIDENCE. Refusing to record one because its kind is
    // unknown would lose the transition entirely, which is strictly worse than
    // recording it with a conservative kind.
    expect(resolveStepKind('service_recovery', 1, 'not_a_step')).toBe('reason');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiOperator/stepService.test.ts`
Expected: FAIL — `Cannot find module './stepService'`.

- [ ] **Step 3: Write `stepService.ts`**

```ts
// AI Operator task step rows (Recipe Library wave E2).
//
// One row per (task, step key, target, attempt). Identity is enforced by TWO
// partial uniques rather than one — see the migration header — because a NULL
// target_id makes a plain unique index enforce nothing for task-wide steps.
//
// Same transaction contract as eventService.ts and taskOutbox.ts: the caller
// supplies the handle, so a step row and the task CAS that produced it commit
// together.
//
// EVERY WRITE IS IDEMPOTENT ON THAT IDENTITY. A lease reclaim re-runs the
// coordinator's step function from the top (taskCoordinator.ts: results from a
// superseded epoch are accepted under their original identity), so a plain
// INSERT would raise 23505 and abort the reclaiming coordinator's transaction —
// turning an ordinary, expected race into a stuck task.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  aiOperatorTaskSteps,
  type AiOperatorStepKind,
  type AiOperatorStepState,
} from '../../db/schema/aiOperatorTaskGraph';
import { appendTaskEvent, type TaskEventActor } from './eventService';
import { getRecipe } from './recipes';

/** Mirrors `ai_operator_task_steps_criterion_len_chk`. */
const MAX_CRITERION_CHARS = 2000;
/** Mirrors `ai_operator_task_steps_detail_len_chk`. */
const MAX_STEP_DETAIL_CHARS = 4000;

export type StepDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;

/**
 * Which `step_kind` a recipe's step key is.
 *
 * Reads E1's registry when it can (`getRecipe(workflowKey, workflowVersion)`
 * → `steps[stepKey].kind`, recipe spec §6.1), because the recipe owns this
 * fact and a second hand-maintained table would drift from it the first time a
 * recipe adds a step.
 *
 * The fallback is `'reason'`, deliberately, and it never throws: a step row is
 * EVIDENCE of a transition that has already happened, and refusing to record
 * one because its kind could not be classified would lose the transition
 * outright. A mis-kinded row is visible and fixable; a missing row is not.
 */
export function resolveStepKind(
  workflowKey: string,
  workflowVersion: number,
  stepKey: string,
): AiOperatorStepKind {
  const recipe = getRecipe(workflowKey, workflowVersion);
  const kind = recipe?.steps?.[stepKey]?.kind;
  return (kind as AiOperatorStepKind | undefined) ?? 'reason';
}

export interface OpenStepInput {
  orgId: string;
  taskId: string;
  stepKey: string;
  stepKind: AiOperatorStepKind;
  targetId?: string | null;
  attemptOrdinal: number;
  /** `ai_operator_tasks.revision` at the moment the step opened. */
  planRevision: number;
  expectedCriterion?: string | null;
  checkpoint?: Record<string, unknown>;
  actor?: TaskEventActor;
}

export async function openStep(
  dbh: StepDbHandle,
  input: OpenStepInput,
): Promise<{ id: string }> {
  const now = new Date();
  const [row] = await dbh
    .insert(aiOperatorTaskSteps)
    .values({
      orgId: input.orgId,
      taskId: input.taskId,
      stepKey: input.stepKey,
      stepKind: input.stepKind,
      targetId: input.targetId ?? null,
      attemptOrdinal: input.attemptOrdinal,
      state: 'running',
      planRevision: input.planRevision,
      expectedCriterion: input.expectedCriterion
        ? input.expectedCriterion.slice(0, MAX_CRITERION_CHARS)
        : null,
      checkpoint: input.checkpoint ?? {},
      startedAt: now,
    })
    // The conflict target must repeat the PARTIAL index's predicate, or
    // Postgres cannot match the partial index and raises 42P10 instead of
    // deduplicating — the same trap taskService.ts:224-227 documents for
    // `ai_operator_tasks_client_idempotency_uq`.
    .onConflictDoUpdate({
      target: input.targetId
        ? [
            aiOperatorTaskSteps.orgId, aiOperatorTaskSteps.taskId,
            aiOperatorTaskSteps.stepKey, aiOperatorTaskSteps.targetId,
            aiOperatorTaskSteps.attemptOrdinal,
          ]
        : [
            aiOperatorTaskSteps.orgId, aiOperatorTaskSteps.taskId,
            aiOperatorTaskSteps.stepKey, aiOperatorTaskSteps.attemptOrdinal,
          ],
      targetWhere: input.targetId ? sql`target_id IS NOT NULL` : sql`target_id IS NULL`,
      set: {
        // A reclaim re-opens the same step: refresh what the new epoch knows,
        // never the identity columns and never `started_at`.
        stepKind: input.stepKind,
        planRevision: input.planRevision,
        state: 'running',
        updatedAt: now,
      },
    })
    .returning({ id: aiOperatorTaskSteps.id });

  if (input.actor) {
    await appendTaskEvent(dbh, {
      orgId: input.orgId,
      taskId: input.taskId,
      eventType: 'step_opened',
      actor: input.actor,
      stepKey: input.stepKey,
      targetId: input.targetId ?? null,
      detail: `${input.stepKind} step '${input.stepKey}' opened at attempt ${input.attemptOrdinal}`,
    });
  }

  return row;
}

export interface StepIdentity {
  orgId: string;
  taskId: string;
  stepKey: string;
  targetId?: string | null;
  attemptOrdinal: number;
}

function identityWhere(id: StepIdentity) {
  return and(
    eq(aiOperatorTaskSteps.orgId, id.orgId),
    eq(aiOperatorTaskSteps.taskId, id.taskId),
    eq(aiOperatorTaskSteps.stepKey, id.stepKey),
    eq(aiOperatorTaskSteps.attemptOrdinal, id.attemptOrdinal),
    id.targetId
      ? eq(aiOperatorTaskSteps.targetId, id.targetId)
      : isNull(aiOperatorTaskSteps.targetId),
  );
}

export interface MarkStepWaitingInput extends StepIdentity {
  dependencyKind: 'intent' | 'operation' | 'run' | 'device_command' | 'user_answer' | 'verification' | null;
  dependencyId: string | null;
  actor?: TaskEventActor;
  detail?: string;
}

/** The step's half of a typed wait. Mirrors the task's `wait_reason` /
 *  `wait_dependency_*` columns onto the step, so a reader can see WHICH step
 *  is waiting without replaying the timeline. */
export async function markStepWaiting(
  dbh: StepDbHandle,
  input: MarkStepWaitingInput,
): Promise<void> {
  await dbh
    .update(aiOperatorTaskSteps)
    .set({
      state: 'waiting',
      dependencyKind: input.dependencyKind,
      dependencyId: input.dependencyId,
      updatedAt: new Date(),
    })
    .where(identityWhere(input));

  if (input.actor) {
    await appendTaskEvent(dbh, {
      orgId: input.orgId, taskId: input.taskId,
      eventType: 'wait_entered', actor: input.actor,
      stepKey: input.stepKey, targetId: input.targetId ?? null,
      detail: input.detail
        ?? `step '${input.stepKey}' waiting on ${input.dependencyKind ?? 'a timer'}`,
    });
  }
}

export interface SettleStepInput extends StepIdentity {
  state: Extract<AiOperatorStepState, 'succeeded' | 'failed' | 'skipped'>;
  detail?: string | null;
  actor?: TaskEventActor;
}

export async function settleStep(
  dbh: StepDbHandle,
  input: SettleStepInput,
): Promise<void> {
  const now = new Date();
  await dbh
    .update(aiOperatorTaskSteps)
    .set({
      state: input.state,
      detail: input.detail ? input.detail.slice(0, MAX_STEP_DETAIL_CHARS) : null,
      // The dependency is discharged the moment the step settles; leaving it
      // set would make a settled step look like it is still waiting.
      dependencyKind: null,
      dependencyId: null,
      settledAt: now,
      updatedAt: now,
    })
    .where(identityWhere(input));

  if (input.actor) {
    await appendTaskEvent(dbh, {
      orgId: input.orgId, taskId: input.taskId,
      eventType: 'step_settled', actor: input.actor,
      stepKey: input.stepKey, targetId: input.targetId ?? null,
      detail: input.detail ?? `step '${input.stepKey}' ${input.state}`,
    });
  }
}
```

**Before writing `resolveStepKind`, confirm E1's registry shape:** `grep -n "steps\|StepKind\|StepDefinition\|TARGET_KINDS" apps/api/src/services/aiOperator/recipes/types.ts`. As planned, E1 ships `STEP_KINDS` / `TARGET_KINDS` as frozen runtime arrays in `recipes/types.ts`, `StepDefinition.kind: StepKind`, and `getRecipe(workflowKey, workflowVersion)` in `recipes/index.ts` — which is exactly what the code above assumes. If `StepDefinition` names the field something other than `kind`, use that name. If E1 did not put a kind on `StepDefinition` at all, replace the body with an exported, hand-written `Record<string, Record<string, AiOperatorStepKind>>` keyed by `workflowKey` — and add a step to Task 14 to file a follow-up issue asking E1's owner to move it into the recipe, because a second table WILL drift.

**One more E1 interaction to check before Task 10:** W01 puts `phase` on `StepDefinition` and rewrites `writeLeasedStep` to take the step key alone, deriving the phase from the recipe instead of from a second hardcoded literal. If that has landed, Task 10's `writeLeasedStep` edit applies to the **new** signature — keep whatever parameters E1 left and add only the `alsoInTransaction` block. Do not restore the old `phase` parameter.

- [ ] **Step 4: Run the test — expect PASS (5 tests)**

Run: `cd apps/api && npx vitest run src/services/aiOperator/stepService.test.ts`

- [ ] **Step 5: Commit**

`git add apps/api/src/services/aiOperator/stepService.ts apps/api/src/services/aiOperator/stepService.test.ts && git commit -m "feat(api): AI Operator step service — open, wait and settle step rows"`

---

### Task 10: Wire the coordinator and admission — step rows and events, with zero behaviour change for `service_recovery`

**Files:**
- Modify: `apps/api/src/services/aiOperator/taskCoordinator.ts` (`writeLeased` :174, `yieldToWait` :216, `settle` :250, `writeLeasedStep` :846)
- Modify: `apps/api/src/services/aiOperator/taskService.ts` (`admitServiceRecoveryTask`, the insert at :181-228)
- Create: `apps/api/src/services/aiOperator/taskCoordinatorGraph.test.ts`

**The atomicity fact this task rests on:** `withDbAccessContext` *"resolve[s] a tenant context and run[s] work in the same transaction"* (`apps/api/src/db/index.ts:746-753`), so everything inside one `runOutsideDbContext(() => withSystemDbAccessContext(async () => { … }))` callback is already a single Postgres transaction and the bare `db` proxy joins it. **No `db.transaction()` is added by this task** — adding one would nest a transaction inside that context and is exactly the double-connection-hold pattern the repo has been bitten by. The step and event writes simply move inside the existing callback.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/taskCoordinatorGraph.test.ts
import { describe, expect, it, vi } from 'vitest';

/**
 * These assert the WIRING, not the SQL: that each of the coordinator's three
 * private writers also records a step row and an event, and that nothing about
 * the thin slice's task-column writes changed. The real SQL behaviour is
 * covered by the integration suite (Task 13).
 */
vi.mock('./stepService', () => ({
  openStep: vi.fn(async () => ({ id: 'step-1' })),
  markStepWaiting: vi.fn(async () => {}),
  settleStep: vi.fn(async () => {}),
  resolveStepKind: vi.fn(() => 'effect'),
}));
vi.mock('./eventService', () => ({ appendTaskEvent: vi.fn(async () => 1) }));

import { markStepWaiting, openStep, settleStep } from './stepService';
import { appendTaskEvent } from './eventService';
import { __testOnly } from './taskCoordinator';

const task = {
  id: 'task-1', orgId: 'org-1', revision: 3, leaseEpoch: 4, attemptOrdinal: 0,
  state: 'running', workflowKey: 'service_recovery', workflowVersion: 1,
  currentStepKey: 'execute',
} as never;

describe('taskCoordinator writes the task graph alongside the task row', () => {
  it('writeLeasedStep opens a step row for the step it moves to', async () => {
    await __testOnly.writeLeasedStep(task, 4, 'verify', 'verify', {} as never);
    expect(openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: 'org-1', taskId: 'task-1', stepKey: 'verify',
      attemptOrdinal: 0, planRevision: 3,
    }));
  });

  it('yieldToWait marks the step waiting with the SAME typed dependency as the task', async () => {
    await __testOnly.yieldToWait({
      task, leaseEpoch: 4, reason: 'approval',
      dependency: { kind: 'intent', id: 'intent-9' }, wakeAfterMs: 1000,
    });
    expect(markStepWaiting).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      dependencyKind: 'intent', dependencyId: 'intent-9',
    }));
  });

  it('settle settles the current step and writes a task_settled event', async () => {
    await __testOnly.settle({
      task, leaseEpoch: 4, event: 'complete',
      outcome: 'verified_resolved', detail: 'service running',
    });
    expect(settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'execute', state: 'succeeded',
    }));
    expect(appendTaskEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'task_settled', actor: { kind: 'coordinator' },
    }));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiOperator/taskCoordinatorGraph.test.ts`
Expected: FAIL — `taskCoordinator.ts` exports no `__testOnly`.

- [ ] **Step 3: Wire `taskCoordinator.ts`**

Add the imports:

```ts
import { appendTaskEvent, type TaskEventActor } from './eventService';
import { markStepWaiting, openStep, resolveStepKind, settleStep } from './stepService';
import { aiOperatorTaskTargets } from '../../db/schema/aiOperatorTaskGraph';
```

Add near the top, after `COORDINATOR_OWNER_ID` (line 79):

```ts
/**
 * Every write this module makes is attributed to the coordinator, never to a
 * user. Spec §7.1: "Database context has no synthetic human user ID" — and
 * `ai_operator_task_events_actor_chk` enforces the pairing, so this constant is
 * the only actor shape this file can legally use.
 */
const COORDINATOR_ACTOR: TaskEventActor = { kind: 'coordinator' };

/**
 * The target a step belongs to, or null.
 *
 * Read from `ai_operator_task_targets` rather than from the task's inline
 * `device_id`, because a step's target is a TARGET ROW id — the inline column
 * is the read projection recipe spec §5.5 keeps, not the identity. Ordinal 0
 * is the single-target case, which is every task until the fleet waves.
 */
async function currentTargetId(orgId: string, taskId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: aiOperatorTaskTargets.id })
    .from(aiOperatorTaskTargets)
    .where(and(
      eq(aiOperatorTaskTargets.orgId, orgId),
      eq(aiOperatorTaskTargets.taskId, taskId),
      eq(aiOperatorTaskTargets.targetOrdinal, 0),
    ))
    .limit(1);
  return row?.id ?? null;
}
```

Change `writeLeased` so callers can run extra writes **inside the same context** (this is the atomicity hinge — read this file's header note before changing it):

```ts
async function writeLeased(args: {
  orgId: string;
  taskId: string;
  revision: number;
  leaseEpoch: number;
  patch: Partial<typeof aiOperatorTasks.$inferInsert>;
  /**
   * Extra writes to run in the SAME transaction as the CAS, and ONLY if the
   * CAS won.
   *
   * `withDbAccessContext` already runs its callback in one transaction
   * (db/index.ts:746-753) and the bare `db` proxy joins it, so this needs no
   * `db.transaction()` — and must not grow one: nesting a transaction inside
   * that context double-holds a pooled connection, which hangs at concurrency
   * >= pool size.
   *
   * Gated on the CAS because a stale coordinator that lost its lease must not
   * leave a step row or an event claiming a transition that never committed.
   */
  alsoInTransaction?: () => Promise<void>;
}): Promise<boolean> {
  const committed = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const rows = await db
        .update(aiOperatorTasks)
        .set({ ...args.patch, updatedAt: new Date() })
        .where(and(
          eq(aiOperatorTasks.id, args.taskId),
          eq(aiOperatorTasks.orgId, args.orgId),
          eq(aiOperatorTasks.revision, args.revision),
          eq(aiOperatorTasks.leaseEpoch, args.leaseEpoch),
        ))
        .returning({ id: aiOperatorTasks.id });
      if (rows.length !== 1) return false;
      if (args.alsoInTransaction) await args.alsoInTransaction();
      return true;
    }));

  if (!committed) {
    console.warn('[aiOperator] stale coordinator lost its lease CAS; another holder owns this task', {
      taskId: args.taskId, orgId: args.orgId, revision: args.revision, leaseEpoch: args.leaseEpoch,
    });
  }
  return committed;
}
```

Then, in each of the three writers, pass `alsoInTransaction`:

- `writeLeasedStep(task, leaseEpoch, stepKey, phase, checkpoint)` — after the existing `patch`, add:
  ```ts
    alsoInTransaction: async () => {
      await openStep(db, {
        orgId: task.orgId,
        taskId: task.id,
        stepKey,
        stepKind: resolveStepKind(task.workflowKey, task.workflowVersion, stepKey),
        targetId: await currentTargetId(task.orgId, task.id),
        attemptOrdinal: task.attemptOrdinal,
        planRevision: task.revision,
        checkpoint: checkpoint as unknown as Record<string, unknown>,
        actor: COORDINATOR_ACTOR,
      });
    },
  ```
- `yieldToWait(args)`:
  ```ts
    alsoInTransaction: async () => {
      const stepKey = args.stepKey ?? args.task.currentStepKey;
      if (!stepKey) return;   // nothing to attribute the wait to
      await markStepWaiting(db, {
        orgId: args.task.orgId, taskId: args.task.id, stepKey,
        targetId: await currentTargetId(args.task.orgId, args.task.id),
        attemptOrdinal: args.task.attemptOrdinal,
        dependencyKind: args.dependency?.kind ?? null,
        dependencyId: args.dependency?.id ?? null,
        actor: COORDINATOR_ACTOR,
        detail: `waiting (${args.reason})`,
      });
    },
  ```
- `settle(args)`:
  ```ts
    alsoInTransaction: async () => {
      const targetId = await currentTargetId(args.task.orgId, args.task.id);
      if (args.task.currentStepKey) {
        await settleStep(db, {
          orgId: args.task.orgId, taskId: args.task.id,
          stepKey: args.task.currentStepKey, targetId,
          attemptOrdinal: args.task.attemptOrdinal,
          // The STEP's verdict, not the task's: a task can settle `partial`
          // while the step that ran actually succeeded, and conflating them
          // would make the timeline lie about what happened.
          state: args.event === 'complete' ? 'succeeded'
               : args.event === 'partial' ? 'succeeded'
               : 'failed',
          detail: args.detail,
          // No actor here: settleStep would write its own step_settled event,
          // and the task_settled event below is the one that matters. Two
          // events for one transition is how a timeline stops being readable.
        });
      }
      await appendTaskEvent(db, {
        orgId: args.task.orgId, taskId: args.task.id,
        eventType: 'task_settled', actor: COORDINATOR_ACTOR,
        stepKey: args.task.currentStepKey, targetId,
        detail: `${args.event} -> ${args.outcome}: ${args.detail}`,
      });
    },
  ```

Finally, export the three for the test (at the end of the file):

```ts
/** Test seam. These three are the only writers in this module and the test
 *  that pins their graph writes needs to call them directly — the alternative
 *  is a test that drives `advanceTask` through a fake DB, which would assert
 *  the fake and not the wiring. */
export const __testOnly = { writeLeasedStep, yieldToWait, settle };
```

**Behaviour-change budget for `service_recovery`: zero.** Every task-column write above is byte-identical to today; the only additions are rows in three new tables and one guard (`alsoInTransaction` runs only on a won CAS) that cannot change what the CAS itself writes. Step 5 proves it.

- [ ] **Step 4: Wire admission in `taskService.ts`**

Inside `admitServiceRecoveryTask`'s `withSystemDbAccessContext` callback, after the `inserted.length > 0` branch confirms this call created the task (line ~230), and still inside the same callback:

```ts
        // Wave E2. The target row is the identity; the inline device_id /
        // target_label columns written above stay as the read projection
        // recipe spec §5.5 keeps until P3-5. BOTH are written, deliberately —
        // this wave is additive, and every existing reader of the inline
        // columns keeps working unchanged.
        const target = await createTaskTarget(db, {
          orgId: input.orgId,
          taskId,
          targetKind: 'device',
          deviceId: device.id,
          targetLabel: (device.hostname ?? recipeInput.deviceId).slice(0, 255),
          targetOrdinal: 0,
        });

        await openStep(db, {
          orgId: input.orgId,
          taskId,
          stepKey: 'investigate',
          stepKind: resolveStepKind(SERVICE_RECOVERY_WORKFLOW_KEY, SERVICE_RECOVERY_WORKFLOW_VERSION, 'investigate'),
          targetId: target.id,
          attemptOrdinal: 0,
          planRevision: 1,
          checkpoint: checkpoint as unknown as Record<string, unknown>,
        });

        // ONE event for the whole admission, not three. `createTaskTarget` and
        // `openStep` are called without an `actor` above precisely so they do
        // not each write their own — an admission is one transition.
        await appendTaskEvent(db, {
          orgId: input.orgId,
          taskId,
          eventType: 'task_admitted',
          actor: input.requesterUserId
            ? { kind: 'user', userId: input.requesterUserId }
            : { kind: 'system' },
          stepKey: 'investigate',
          targetId: target.id,
          detail: `${SERVICE_RECOVERY_WORKFLOW_KEY} v${SERVICE_RECOVERY_WORKFLOW_VERSION} admitted against ${target.id}`,
        });
```

Add the imports (`createTaskTarget` from `./targetService`, `openStep`/`resolveStepKind` from `./stepService`, `appendTaskEvent` from `./eventService`).

**Do not run these on the idempotent-replay branch** (the `onConflictDoNothing` path where `inserted.length === 0`): that call did not create the task, and writing a second target/step/event for a task another request already admitted is exactly the duplicate the client idempotency key exists to prevent.

- [ ] **Step 5: Run the wiring test AND the full existing Operator suite**

Run:
```
cd apps/api && npx vitest run \
  src/services/aiOperator/taskCoordinatorGraph.test.ts \
  src/services/aiOperator \
  src/routes/aiOperatorTasks.test.ts
```
Expected: PASS. The bare `src/services/aiOperator` filter is a substring match that picks up every file in the directory — check the reported file count is ≥ 12 and that `taskTransitions.test.ts`, `taskFence.test.ts`, `verification.test.ts`, `operationService.test.ts` and `recipes/serviceRecovery.test.ts` all appear. **Any pre-existing test that changes its expected values is a behaviour change and must be reverted, not updated** — the budget for this task is zero.

- [ ] **Step 6: Typecheck**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: exit 0, except for `mapOperatorTask` not returning `targets`/`steps`/`events` — fixed in Task 12.

- [ ] **Step 7: Commit**

`git add apps/api/src/services/aiOperator && git commit -m "feat(api): coordinator and admission write task step rows and events atomically"`

---

### Task 11: Policy snapshot v14 — task-wide budgets

**Files:**
- Modify: `packages/shared/src/types/aiAgents.ts:33` (`AiAgentLimits`), `:214` (`AI_AGENT_LIMIT_DEFAULTS`), `:521-616` (version docstring), `:617` (the constant), `:620-621` (the union and its comment)
- Modify: `packages/shared/src/validators/aiAgents.ts:36-114` (`limitsFields`)
- Modify: `packages/shared/src/types/aiAgents.test.ts:13,15,18-24`
- Modify: `packages/shared/src/validators/aiAgents.test.ts:163-164,471,485,503,528,551`
- Modify: `apps/api/src/services/aiAgents/runService.ts:53+` (the enforcement inventory)

**THE VERSION IS 13, NOT 9.** See "Decisions recorded for the orchestrator" #1. The bump is **13 → 14**. Verify before editing: `grep -n "AI_AGENT_POLICY_SNAPSHOT_VERSION = " packages/shared/src/types/aiAgents.ts`.

- [ ] **Step 1: Write the failing test edits**

In `packages/shared/src/types/aiAgents.test.ts`, change the pins at `:13`, `:15` and `:18-24` to 14 and add the new limits to the defaults round-trip:

```ts
describe('AI_AGENT_POLICY_SNAPSHOT_VERSION (v14, AI Operator task-wide budgets — recipe library E2)', () => {
  it('is the literal 14', () => {
    expect(AI_AGENT_POLICY_SNAPSHOT_VERSION).toBe(14);
  });

  it('AiAgentPolicySnapshot.schemaVersion type-accepts every historical version 1-14', () => {
    const versions: Array<AiAgentPolicySnapshot['schemaVersion']> =
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });
});
```

In `packages/shared/src/validators/aiAgents.test.ts`, change `:163-164`, `:471`, `:485`, `:503` and `:528` from `.toBe(13)` to `.toBe(14)` (all five — each wave re-pins the current version inside its own historical `describe`, which is why they all move), and add bounds rows to the `it.each` table at `:551`:

```ts
    ['taskMaxReasoningRuns', 0],
    ['taskMaxReasoningRuns', 21],
    ['taskMaxMutationAttemptsPerTarget', 0],
    ['taskMaxMutationAttemptsPerTarget', 11],
    ['taskMaxBudgetCents', 0],
    ['taskMaxBudgetCents', 100001],
    ['taskDeadlineHours', 0],
    ['taskDeadlineHours', 721],
    ['taskMaxActiveTargets', 0],
    ['taskMaxActiveTargets', 101],
    ['taskMaxPendingPerOrg', 0],
    ['taskMaxPendingPerOrg', 1001],
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/shared && npx vitest run src/types/aiAgents.test.ts src/validators/aiAgents.test.ts`
Expected: FAIL — `expected 13 to be 14` and unknown-key rejections for the six new limits.

- [ ] **Step 3: Add the limits**

In `packages/shared/src/types/aiAgents.ts`, add to `AiAgentLimits` (the interface at `:33`), all optional like every post-v1 field:

```ts
  /**
   * AI Operator task-wide budgets (Operator spec §7.2, recipe spec §6.7).
   * v14. All six are OPTIONAL, and every read site resolves them through
   * `?? AI_AGENT_LIMIT_DEFAULTS.x` — that fallback, not a version check, is
   * this repo's entire backward-compatibility mechanism, so a v1-v13 snapshot
   * on an in-flight run keeps executing unchanged.
   *
   * These are the POLICY ceiling. A recipe's own `bounds` may be stricter and
   * never looser (SERVICE_RECOVERY_BOUNDS already is), and the server takes
   * the narrower of the two at admission.
   */
  /** Spec §7.2 "Reasoning runs per task": 4. Identity recipes ask for 6 (recipe spec §6.7). */
  taskMaxReasoningRuns?: number;
  /** Spec §7.2 "Mutation attempts per target across all runs": 3, counting nested playbook mutations. */
  taskMaxMutationAttemptsPerTarget?: number;
  /** Spec §7.2 "Aggregate model budget": 200 cents, also subject to the existing org/day/run limits. */
  taskMaxBudgetCents?: number;
  /** Spec §7.2 "Task deadline": 72 hours. Identity recipes ask for 14 days (recipe spec §6.7). */
  taskDeadlineHours?: number;
  /** Spec §7.2 "Active executable targets": 1 until the fleet gates pass. */
  taskMaxActiveTargets?: number;
  /** Spec §7.2 "pending cap ... 100 per org". A WAITING task consumes no
   *  active-run concurrency but does consume this quota. */
  taskMaxPendingPerOrg?: number;
```

And to `AI_AGENT_LIMIT_DEFAULTS` (`:214`), using spec §7.2's proposed defaults verbatim:

```ts
  taskMaxReasoningRuns: 4,
  taskMaxMutationAttemptsPerTarget: 3,
  taskMaxBudgetCents: 200,
  taskDeadlineHours: 72,
  taskMaxActiveTargets: 1,
  taskMaxPendingPerOrg: 100,
```

Add a `v14` paragraph to the version docstring (`:521-616`), matching the shape of the v13 paragraph, then:
- `:617` → `export const AI_AGENT_POLICY_SNAPSHOT_VERSION = 14 as const;`
- `:620` inline comment → `… 12 (pre-sweep-act-limits), 13 (pre-task-limits), or 14 (current). Read sites must tolerate all fourteen.`
- `:621` → `schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;`

In `packages/shared/src/validators/aiAgents.ts`, add to `limitsFields` (`:36-114`), keeping the file's comment-then-fields convention:

```ts
  // AI Operator task-wide budgets (v14, recipe library E2) — see
  // AiAgentLimits.taskMaxReasoningRuns's docstring. Bounds are generous
  // relative to the defaults because the identity recipes are deliberately
  // longer-horizon than service recovery (14 days vs 24 hours).
  taskMaxReasoningRuns: z.number().int().min(1).max(20),
  taskMaxMutationAttemptsPerTarget: z.number().int().min(1).max(10),
  taskMaxBudgetCents: z.number().int().min(1).max(100000),
  taskDeadlineHours: z.number().int().min(1).max(720),
  taskMaxActiveTargets: z.number().int().min(1).max(100),
  taskMaxPendingPerOrg: z.number().int().min(1).max(1000),
```

- [ ] **Step 4: `MAX_MERGED_LIMIT_KEYS` — check, then leave alone**

Read `apps/api/src/services/aiAgents/effectivePolicy.ts:84`:
```ts
const MAX_MERGED_LIMIT_KEYS: ReadonlySet<keyof AiAgentLimits> = new Set(['promoteThreshold', 'sweepPromoteThreshold']);
```
All six new limits are **ceilings** ("at most N runs", "at most N cents"), so partner/org merge must take the **narrower** value — which is the default min-wins behaviour. **Add nothing here.** A ceiling in the max-wins set would let an org override widen its own budget past the partner's, which is the inverse of spec §3's precedence rule ("workflow configuration can only narrow the effective agent policy").

- [ ] **Step 5: The enforcement inventory — mandatory, not optional**

`runService.ts:53-56` states the rule: *"Which `AiAgentLimits` field is enforced where. Every field must appear in this list — an unenforced cap is an unbounded agent."* Add six entries to that inventory. Five of the six have **no enforcement site in this wave** (the coordinator's budget accounting is P3-3), so they are recorded as explicit deferrals with the issue number, never silently omitted:

```
 * taskMaxReasoningRuns              DEFERRED to P3-3 (#<the E2 wave sub-issue>): admitReasoningRun
 *                                   currently caps on SERVICE_RECOVERY_BOUNDS.maxReasoningRuns only.
 * taskMaxMutationAttemptsPerTarget  DEFERRED to P3-3: same, via SERVICE_RECOVERY_BOUNDS.maxMutationAttempts.
 * taskMaxBudgetCents                DEFERRED to P3-3: task budget rollup does not exist yet.
 * taskDeadlineHours                 ENFORCED at admission (taskService.ts admitServiceRecoveryTask,
 *                                   deadlineMs) — see Step 6.
 * taskMaxActiveTargets              DEFERRED to the fleet waves; admission writes exactly one target.
 * taskMaxPendingPerOrg              DEFERRED to P3-3: admission capacity (spec §12's 429) is not built.
```

**File one follow-up issue** covering the five deferrals, and reference it in the PR body. A deferral with no issue is an omission with a comment.

- [ ] **Step 6: Make `taskDeadlineHours` actually enforce**

In `taskService.ts`'s `admitServiceRecoveryTask`, the deadline is `input.deadlineMs ?? SERVICE_RECOVERY_BOUNDS.deadlineMs` (line ~177). Take the narrower of the recipe bound and the policy ceiling, so at least one of the six limits is real rather than declared:

```ts
      // The recipe may be stricter than the policy and never looser
      // (SERVICE_RECOVERY_BOUNDS' own docstring). The policy ceiling comes
      // from the agent's resolved snapshot; a pre-v14 snapshot has no value
      // and falls back to the default, which is the whole compatibility
      // mechanism (see AiAgentLimits.taskMaxReasoningRuns's docstring).
      const policyDeadlineMs =
        (agentPolicyLimits?.taskDeadlineHours ?? AI_AGENT_LIMIT_DEFAULTS.taskDeadlineHours!) * 3_600_000;
      const deadlineMs = Math.min(
        input.deadlineMs ?? SERVICE_RECOVERY_BOUNDS.deadlineMs,
        policyDeadlineMs,
      );
```

`agentPolicyLimits` is read from the agent row already selected at line ~150 — extend that `select` to include the policy `limits` column (`grep -n "limits" apps/api/src/db/schema/aiAgents.ts` for the exact column name; do not guess). If the agent row does not carry limits directly, call `resolveEffectiveAgentSystem(input.orgId, agent.kind)` (`services/aiAgents/effectivePolicy.ts:464`) and read `.effective.limits` — and add a unit test asserting a 1-hour policy ceiling wins over the recipe's 24-hour default.

- [ ] **Step 7: Run everything that pins the version**

Run:
```
cd packages/shared && npx vitest run src/types/aiAgents.test.ts src/validators/aiAgents.test.ts
cd ../../apps/api && npx vitest run src/services/aiAgents src/services/aiOperator/taskService.test.ts
```
Expected: PASS. The `apps/api/src/routes/aiAgents.test.ts` fixtures that hard-code `schemaVersion: 9` and `schemaVersion: 4` are **deliberate old-snapshot tolerance probes** — leave them exactly as they are. A green run with those fixtures untouched is the proof that v14 readers still accept a v9 snapshot.

- [ ] **Step 8: Commit**

`git add packages/shared apps/api/src && git commit -m "feat(shared): agent policy snapshot v14 — AI Operator task-wide budgets"`

---

### Task 12: Task detail API — `targets`, `steps`, `events`, backward compatible

**Files:**
- Modify: `apps/api/src/services/aiOperator/taskReadService.ts`
- Modify: `apps/api/src/services/aiOperator/taskReadService.test.ts`
- Modify: `apps/api/src/routes/aiOperatorTasks.ts:411-485`
- Modify: `apps/api/src/routes/aiOperatorTasks.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/aiOperator/taskReadService.test.ts`:

```ts
describe('mapOperatorTask — wave E2 graph projections', () => {
  const target = {
    id: 'target-1', targetKind: 'contact' as const, deviceId: null, ticketId: null,
    contactId: 'contact-1', targetLabel: 'Dana Example', targetOrdinal: 0,
    state: 'active' as const, detachedAt: null, detachedReason: null,
  };
  const account = {
    targetId: 'target-1', provider: 'm365' as const, m365ConnectionId: 'conn-1',
    googleConnectionId: null, externalId: 'aaaa-bbbb', principalLabel: 'dana@acme.com',
  };
  const step = {
    id: 'step-1', stepKey: 'investigate', stepKind: 'reason' as const, targetId: 'target-1',
    attemptOrdinal: 0, state: 'running' as const, planRevision: 1,
    expectedCriterion: 'account cannot sign in', dependencyKind: null, dependencyId: null,
    detail: null, startedAt: new Date('2026-09-17T10:00:00Z'), settledAt: null,
  };
  const event = {
    id: 'event-1', transitionSeq: 1, eventType: 'task_admitted' as const,
    actorKind: 'user' as const, actorUserId: 'user-1', stepKey: 'investigate',
    targetId: 'target-1', detail: 'admitted', createdAt: new Date('2026-09-17T10:00:00Z'),
  };

  it('nests accounts under their target', () => {
    const dto = mapOperatorTask(baseTaskRow(), [], [], [target], [account], [step], [event]);
    expect(dto.targets).toHaveLength(1);
    expect(dto.targets[0].accounts).toEqual([{
      provider: 'm365', connectionId: 'conn-1',
      externalId: 'aaaa-bbbb', principalLabel: 'dana@acme.com',
    }]);
  });

  it('collapses the two provider connection columns into one connectionId', () => {
    const dto = mapOperatorTask(baseTaskRow(), [], [], [target],
      [{ ...account, provider: 'google' as const, m365ConnectionId: null, googleConnectionId: 'g-1' }],
      [], []);
    expect(dto.targets[0].accounts[0]).toMatchObject({ provider: 'google', connectionId: 'g-1' });
  });

  it('keeps the inline target projection so a pre-E2 client is unaffected', () => {
    const dto = mapOperatorTask(baseTaskRow(), [], [], [target], [account], [step], [event]);
    // recipe spec §5.5: the inline columns stay until P3-5.
    expect(dto.target).toEqual(expect.objectContaining({ deviceId: expect.anything() }));
    expect(dto.schemaVersion).toBe(1);
  });

  it('never leaks a step checkpoint onto the wire', () => {
    const dto = mapOperatorTask(baseTaskRow(), [], [], [target], [account], [step], [event]);
    assertNoLeakedTripwireKeys(dto);
    expect(JSON.stringify(dto)).not.toContain('checkpoint');
  });

  it('emits events in ascending transition_seq so the timeline reads forwards', () => {
    const dto = mapOperatorTask(baseTaskRow(), [], [], [], [], [], [
      { ...event, id: 'e2', transitionSeq: 2 },
      { ...event, id: 'e1', transitionSeq: 1 },
    ]);
    expect(dto.events.map((e) => e.transitionSeq)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiOperator/taskReadService.test.ts`
Expected: FAIL — `mapOperatorTask` takes three arguments.

- [ ] **Step 3: Extend `taskReadService.ts`**

Add the row input types and named-field mappers, following the file's existing discipline (**never `{ ...row }`**; the step `checkpoint` has no field in `OperatorStepRowInput`, which is what makes the guarantee structural rather than a matter of mapper care):

```ts
export interface OperatorTargetRowInput {
  id: string;
  targetKind: AiOperatorTargetKind;
  deviceId: string | null;
  ticketId: string | null;
  contactId: string | null;
  targetLabel: string;
  targetOrdinal: number;
  state: AiOperatorTargetState;
  detachedAt: Date | null;
  detachedReason: AiOperatorTargetDetachReason | null;
}

export interface OperatorTargetAccountRowInput {
  targetId: string;
  provider: AiOperatorAccountProvider;
  m365ConnectionId: string | null;
  googleConnectionId: string | null;
  externalId: string;
  principalLabel: string;
}

/** NOTE what is absent: `checkpoint`. There is no field for it, so no mapper
 *  can put it on the wire even by accident — the same structural guarantee
 *  this file's header claims for `ai_operator_tasks.checkpoint`. */
export interface OperatorStepRowInput {
  id: string;
  stepKey: string;
  stepKind: AiOperatorStepKind;
  targetId: string | null;
  attemptOrdinal: number;
  state: AiOperatorStepState;
  planRevision: number | null;
  expectedCriterion: string | null;
  dependencyKind: AiOperatorWaitDependencyKind | null;
  dependencyId: string | null;
  detail: string | null;
  startedAt: Date | null;
  settledAt: Date | null;
}

export interface OperatorEventRowInput {
  id: string;
  transitionSeq: number;
  eventType: AiOperatorTaskEventType;
  actorKind: AiOperatorEventActorKind;
  actorUserId: string | null;
  stepKey: string | null;
  targetId: string | null;
  detail: string | null;
  createdAt: Date;
}

/** Named-field mapper. Collapses the two provider connection columns into one
 *  `connectionId`: which table it came from is already said by `provider`, and
 *  a client that had to check both would inevitably check only one. */
export function mapOperatorTargetAccount(
  row: OperatorTargetAccountRowInput,
): AiOperatorTaskTargetAccountDto {
  return {
    provider: row.provider,
    connectionId: row.provider === 'm365' ? row.m365ConnectionId : row.googleConnectionId,
    externalId: row.externalId,
    principalLabel: row.principalLabel,
  };
}

export function mapOperatorTarget(
  row: OperatorTargetRowInput,
  accounts: OperatorTargetAccountRowInput[],
): AiOperatorTaskTargetRowDto {
  return {
    id: row.id,
    targetKind: row.targetKind,
    deviceId: row.deviceId,
    ticketId: row.ticketId,
    contactId: row.contactId,
    label: row.targetLabel,
    ordinal: row.targetOrdinal,
    state: row.state,
    detachedAt: row.detachedAt ? row.detachedAt.toISOString() : null,
    detachedReason: row.detachedReason,
    accounts: accounts
      .filter((a) => a.targetId === row.id)
      .map(mapOperatorTargetAccount),
  };
}

export function mapOperatorStep(row: OperatorStepRowInput): AiOperatorTaskStepDto {
  return {
    id: row.id,
    stepKey: row.stepKey,
    stepKind: row.stepKind,
    targetId: row.targetId,
    attemptOrdinal: row.attemptOrdinal,
    state: row.state,
    planRevision: row.planRevision,
    expectedCriterion: row.expectedCriterion,
    dependency: row.dependencyKind && row.dependencyId
      ? { kind: row.dependencyKind, id: row.dependencyId }
      : null,
    detail: row.detail,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
  };
}

export function mapOperatorEvent(row: OperatorEventRowInput): AiOperatorTaskEventDto {
  return {
    id: row.id,
    transitionSeq: row.transitionSeq,
    eventType: row.eventType,
    actorKind: row.actorKind,
    actorUserId: row.actorUserId,
    stepKey: row.stepKey,
    targetId: row.targetId,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}
```

And replace `mapOperatorTask` with the seven-argument form:

```ts
/**
 * The full task detail DTO. ADDITIVE: every pre-E2 field, including the inline
 * `target` projection (recipe spec §5.5), is produced exactly as before, so
 * `AI_OPERATOR_TASK_DTO_SCHEMA_VERSION` stays 1 and a client that ignores the
 * three new arrays is unaffected.
 */
export function mapOperatorTask(
  row: OperatorTaskRowInput,
  operations: OperatorOperationRowInput[],
  runs: OperatorRunLinkRowInput[],
  targets: OperatorTargetRowInput[] = [],
  targetAccounts: OperatorTargetAccountRowInput[] = [],
  steps: OperatorStepRowInput[] = [],
  events: OperatorEventRowInput[] = [],
): AiOperatorTaskDto {
  return {
    ...mapOperatorTaskListItem_(row),
    operations: operations.map(mapOperatorOperation),
    runs: runs.map(mapOperatorRunLink),
    targets: [...targets]
      .sort((a, b) => a.targetOrdinal - b.targetOrdinal)
      .map((t) => mapOperatorTarget(t, targetAccounts)),
    steps: [...steps].sort((a, b) =>
      a.stepKey.localeCompare(b.stepKey) || a.attemptOrdinal - b.attemptOrdinal),
    // Ascending transition_seq: the timeline reads forwards. The route's own
    // ORDER BY says the same thing; sorting here too means a caller that hands
    // in rows from anywhere still gets a coherent timeline.
    events: [...events]
      .sort((a, b) => a.transitionSeq - b.transitionSeq)
      .map(mapOperatorEvent),
  };
}
```

**`steps` needs `.map(mapOperatorStep)` after the sort** — write it as `.sort(...).map(mapOperatorStep)`. (Stated explicitly because the sort-then-map chain is where a projection most often gets dropped and the raw row, `checkpoint` and all, ships instead. The `assertNoLeakedTripwireKeys` test in Step 1 catches it.)

The four default `= []` parameters keep every existing caller compiling — `taskReadService.test.ts`'s own pre-E2 cases and any future one. They are **not** a licence for the route to omit the joins: Step 4 adds them, and Task 13's integration test asserts a real task detail response carries a non-empty `targets` array.

- [ ] **Step 4: Join in the route**

In `apps/api/src/routes/aiOperatorTasks.ts`, extend the `Promise.all` at `:431-477` with four more queries and pass them through. Each repeats `org_id` in the predicate as defence-in-depth beside RLS, matching the two already there, and each carries the same `.limit(500)` cap:

```ts
    db.select({
      id: aiOperatorTaskTargets.id,
      targetKind: aiOperatorTaskTargets.targetKind,
      deviceId: aiOperatorTaskTargets.deviceId,
      ticketId: aiOperatorTaskTargets.ticketId,
      contactId: aiOperatorTaskTargets.contactId,
      targetLabel: aiOperatorTaskTargets.targetLabel,
      targetOrdinal: aiOperatorTaskTargets.targetOrdinal,
      state: aiOperatorTaskTargets.state,
      detachedAt: aiOperatorTaskTargets.detachedAt,
      detachedReason: aiOperatorTaskTargets.detachedReason,
    })
      .from(aiOperatorTaskTargets)
      .where(and(eq(aiOperatorTaskTargets.taskId, task.id), eq(aiOperatorTaskTargets.orgId, task.orgId)))
      .orderBy(aiOperatorTaskTargets.targetOrdinal)
      .limit(500),
    db.select({
      targetId: aiOperatorTaskTargetAccounts.targetId,
      provider: aiOperatorTaskTargetAccounts.provider,
      m365ConnectionId: aiOperatorTaskTargetAccounts.m365ConnectionId,
      googleConnectionId: aiOperatorTaskTargetAccounts.googleConnectionId,
      externalId: aiOperatorTaskTargetAccounts.externalId,
      principalLabel: aiOperatorTaskTargetAccounts.principalLabel,
    })
      .from(aiOperatorTaskTargetAccounts)
      .where(and(eq(aiOperatorTaskTargetAccounts.taskId, task.id), eq(aiOperatorTaskTargetAccounts.orgId, task.orgId)))
      .limit(500),
    db.select({ /* every OperatorStepRowInput field, and NOT checkpoint */ })
      .from(aiOperatorTaskSteps)
      .where(and(eq(aiOperatorTaskSteps.taskId, task.id), eq(aiOperatorTaskSteps.orgId, task.orgId)))
      .orderBy(aiOperatorTaskSteps.stepKey, aiOperatorTaskSteps.attemptOrdinal)
      .limit(500),
    db.select({ /* every OperatorEventRowInput field */ })
      .from(aiOperatorTaskEvents)
      .where(and(eq(aiOperatorTaskEvents.taskId, task.id), eq(aiOperatorTaskEvents.orgId, task.orgId)))
      // Newest first in SQL, then re-sorted ascending by the mapper — the
      // LIMIT has to keep the MOST RECENT 500 events of a long-running
      // identity task, not the oldest 500. A 14-day offboarding will exceed
      // 500 events; taking the oldest would show an empty-looking "recent"
      // timeline, which is worse than truncation at the far end.
      .orderBy(desc(aiOperatorTaskEvents.transitionSeq))
      .limit(500),
```

`db.select({ … })` for steps must **name every field of `OperatorStepRowInput` and omit `checkpoint`** — a `db.select()` with no projection would pull the jsonb column into the handler, where only the mapper stands between it and the response. Spell the columns out.

- [ ] **Step 5: Run the read tests**

Run: `cd apps/api && npx vitest run src/services/aiOperator/taskReadService.test.ts src/routes/aiOperatorTasks.test.ts`
Expected: PASS, including the existing leak-tripwire assertions unchanged.

- [ ] **Step 6: Typecheck the whole API**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: exit 0, no exceptions this time.

- [ ] **Step 7: Commit**

`git add apps/api/src && git commit -m "feat(api): task detail API returns targets, steps and events"`

---

### Task 13: Integration tests against real Postgres as `breeze_app`

**Files (all NEW, all under `apps/api/src/__tests__/integration/` — a file placed anywhere else runs ZERO tests and reads green):**
- Create: `aiOperatorTaskGraphRls.integration.test.ts`
- Create: `aiOperatorTaskGraphCascade.integration.test.ts`
- Create: `aiOperatorInlineTargetBackfill.integration.test.ts`

Bring the stack up first (repo root): `pnpm test-stack up`. Tear it down at the end of Task 14: `pnpm test-stack down` — nothing does it for you, and five abandoned Breeze stacks were found running on one machine on 2026-09-01.

Copy the fixture/bootstrap helpers from an existing suite rather than inventing them: `grep -ln "ai_operator" apps/api/src/__tests__/integration/*.ts` and read whichever the thin slice shipped (an `aiOperator*.integration.test.ts`), plus `orgLifecycleFoundations.integration.test.ts` for the merge harness and `rls-coverage.integration.test.ts` for the `breeze_app` connection pattern.

- [ ] **Step 1: RLS forge — one per table, as `breeze_app`**

```ts
// apps/api/src/__tests__/integration/aiOperatorTaskGraphRls.integration.test.ts
//
// Every assertion here runs as the UNPRIVILEGED `breeze_app` role with a real
// RLS context, because that is the only role that proves anything: a plan
// captured as the owner proves nothing (spec §11.1), and `breeze_current_scope()`
// defaults to 'none', so a contextless connection already returns nothing.

describe('ai_operator task graph — tenant isolation as breeze_app', () => {
  it.each([
    'ai_operator_task_targets',
    'ai_operator_task_target_accounts',
    'ai_operator_task_steps',
    'ai_operator_task_events',
  ])('%s: a cross-tenant INSERT is refused', async (table) => {
    // Context set to org A; the row names org B.
    await expect(insertAsBreezeApp(table, { orgId: orgB, taskId: taskInOrgB /* … */ }))
      .rejects.toMatchObject({ code: '42501' });
  });

  it.each([...])('%s: a cross-tenant SELECT returns zero rows, not an error', async (table) => {
    // Silence, not refusal, is the SELECT contract — an error would confirm
    // the row exists.
    expect(await selectAsBreezeApp(table, { orgId: orgB })).toHaveLength(0);
  });

  it('a step cannot name a target belonging to a DIFFERENT task of the same org', async () => {
    // The same-org-AND-same-task composite FK (spec §11.3: "Reject task-A/
    // step-B ... links even within one org"). Same org, so RLS permits it —
    // the FK is what refuses.
    await expect(insertStep({ taskId: taskA, targetId: targetOfTaskB }))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('an account cannot name a connection in another org', async () => {
    await expect(insertAccount({ orgId: orgA, m365ConnectionId: connectionInOrgB }))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('a contact target cannot name a contact in another org', async () => {
    await expect(insertTarget({ orgId: orgA, targetKind: 'contact', contactId: contactInOrgB }))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('a target with the wrong pointer for its kind is refused by the CHECK', async () => {
    await expect(insertTarget({ targetKind: 'contact', deviceId: someDevice, contactId: null }))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('events are append-only: UPDATE and DELETE both fail for breeze_app', async () => {
    await expect(updateEventAsBreezeApp(eventId, { detail: 'rewritten' }))
      .rejects.toMatchObject({ code: expect.stringMatching(/^(55000|42501)$/) });
    await expect(deleteEventAsBreezeApp(eventId))
      .rejects.toMatchObject({ code: expect.stringMatching(/^(55000|42501)$/) });
  });

  it('transition_seq is unique per task and strictly increasing under concurrency', async () => {
    // Twenty concurrent appendTaskEvent calls for ONE task. The row lock on
    // ai_operator_tasks serialises them, so this must produce exactly
    // 1..20 with no gap, no duplicate, and — critically — no 23505 surfacing
    // to any caller.
    const seqs = await Promise.all(Array.from({ length: 20 }, () => appendOneEvent(taskA)));
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});
```

- [ ] **Step 2: Cascade, detach and merge**

```ts
// apps/api/src/__tests__/integration/aiOperatorTaskGraphCascade.integration.test.ts

describe('ai_operator task graph — erasure, detach and merge', () => {
  it('org erasure deletes all four tables, including the append-only one', async () => {
    // This is the assertion the cascade registration exists for. It fails with
    // a runtime `permission denied` if ai_operator_task_events is missing from
    // AUDIT_ADMIN_REQUIRED_TABLES, and with an FK violation if any of the four
    // is missing from CORE_ORG_CASCADE_DELETE_ORDER.
    await cascadeDeleteOrg(orgA);
    for (const table of [...]) expect(await countRowsForOrg(table, orgA)).toBe(0);
  });

  it('deleting a contact detaches its targets and keeps the frozen label', async () => {
    await deleteContact(contactId);
    const target = await readTarget(targetId);
    expect(target.contactId).toBeNull();
    expect(target.detachedReason).toBe('scope_invalidated');
    expect(target.state).toBe('detached');
    // The whole point of freezing a label: the evidence survives the person
    // record.
    expect(target.targetLabel).toBe('Dana Example');
  });

  it('moving a device to another org detaches the target through the TRIGGER, not only the route', async () => {
    // Drive a DIRECT `UPDATE devices SET org_id` that bypasses moveOrg.ts, the
    // way agentRunMoveSemantics.integration.test.ts does — the route mirror is
    // convergent, the trigger is the backstop.
    await db.execute(sql`UPDATE devices SET org_id = ${orgB} WHERE id = ${deviceId}`);
    const target = await readTarget(targetId);
    expect(target.deviceId).toBeNull();
    expect(target.detachedReason).toBe('device_moved');
  });

  it('moving a ticket to another org detaches the target', async () => {
    await moveTicketOrg({ ticketId, targetOrgId: orgB });
    expect((await readTarget(ticketTargetId)).ticketId).toBeNull();
  });

  it('an org merge fences the task and detaches targets BEFORE contacts repoint', async () => {
    // Without the resolve-phase detach in fenceAiOperatorTasks, contacts
    // repoint to the survivor in the move phase and
    // ai_operator_task_targets_contact_org_fk becomes unresolvable — the merge
    // aborts at COMMIT with 23503. A green here is the proof the ordering is
    // right, not merely that the code ran.
    await mergeOrgs({ loser: orgA, survivor: orgB });
    const target = await readTarget(targetId);
    expect(target.detachedReason).toBe('org_merged');
    expect(target.contactId).toBeNull();
    expect((await readAccount(accountId)).m365ConnectionId).toBeNull();
    // Still in the loser org: Operator history never follows a merge.
    expect(target.orgId).toBe(orgA);
  });

  it('a merge with a LIVE task and a contact target completes without 23503', async () => {
    // The regression this whole ordering exists for, asserted as an outcome
    // rather than as an internal state.
    await expect(mergeOrgs({ loser: orgA, survivor: orgB })).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 3: Backfill idempotency, with rows seeded first**

```ts
// apps/api/src/__tests__/integration/aiOperatorInlineTargetBackfill.integration.test.ts
//
// Seeding first is the point: running the backfill against an empty table
// proves nothing, and "0 rows backfilled" on a clean stack reads exactly like
// a backfill that silently failed.

describe('inline target/step backfill (2026-10-18-100100)', () => {
  it('gives a task with an inline device target exactly one target row at ordinal 0', async () => {
    await seedTaskWithInlineTargetOnly({ deviceId, targetLabel: 'WS-001', currentStepKey: 'execute' });
    await replayMigration('2026-10-18-100100-ai-operator-inline-target-backfill.sql');
    const targets = await readTargets(taskId);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ targetOrdinal: 0, targetKind: 'device', deviceId, targetLabel: 'WS-001' });
  });

  it('classifies the step kind from the service_recovery spine, not a guess', async () => {
    const steps = await readSteps(taskId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ stepKey: 'execute', stepKind: 'effect' });
  });

  it('carries the DETACHED inline target across rather than dropping it', async () => {
    await seedTaskWithDetachedInlineTarget({ targetLabel: 'WS-GONE', reason: 'device_deleted' });
    await replayMigration('2026-10-18-100100-…');
    const [t] = await readTargets(detachedTaskId);
    expect(t).toMatchObject({ deviceId: null, state: 'detached', detachedReason: 'device_deleted', targetLabel: 'WS-GONE' });
  });

  it('is idempotent — a second replay inserts nothing', async () => {
    const before = await countAll();
    await replayMigration('2026-10-18-100100-…');
    expect(await countAll()).toEqual(before);
  });

  it('advances event_seq so the first runtime event does NOT collide', async () => {
    // The failure this guards is a 23505 on ai_operator_task_events_task_seq_uq
    // inside the first coordinator tick after deploy — i.e. a 500, in
    // production, on every task that existed before this wave.
    const seq = await appendOneEvent(taskId);
    expect(seq).toBeGreaterThan(1);
  });

  it('leaves the inline columns in place (recipe spec §5.5 read projection)', async () => {
    const task = await readTask(taskId);
    expect(task.deviceId).toBe(deviceId);
    expect(task.targetLabel).toBe('WS-001');
    expect(task.currentStepKey).toBe('execute');
  });
});
```

**`replayMigration` trap:** if this suite re-applies a migration file by path, check `grep -rn "replayMigration\|readFileSync.*migrations" apps/api/src/__tests__/integration/ | head` for the existing helper and reuse it. A re-applied file that redefines a `SECURITY DEFINER` function can silently revert a THIRD function's newest body — so replay **only** the backfill file (pure DML), never Task 3's DDL file, which redefines `breeze_device_child_orgid_tables()` and `breeze_cascade_device_org_id()`.

- [ ] **Step 4: Run all three**

```
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiOperatorTaskGraphRls.integration.test.ts \
  src/__tests__/integration/aiOperatorTaskGraphCascade.integration.test.ts \
  src/__tests__/integration/aiOperatorInlineTargetBackfill.integration.test.ts
```
Expected: PASS. **Check the reported test count is non-zero** — a suite in the wrong directory, or one whose `describe` is wrapped in a `runIf` whose condition is false, reports 0 tests and exits 0.

- [ ] **Step 5: Commit**

`git add apps/api/src/__tests__/integration && git commit -m "test(api): integration coverage for the AI Operator task graph — RLS, cascade, merge, backfill"`

---

### Task 14: Full verification sweep, review, PR — then STOP

- [ ] **Step 1: The registration grep, once more, against the final tree**

```
for t in ai_operator_task_targets ai_operator_task_target_accounts ai_operator_task_steps ai_operator_task_events; do
  echo "== $t"
  grep -rln "$t" apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
done
grep -n "workflow_config_id\|event_seq" apps/api/src/services/tenantExportPolicyRegistry.ts | head
```
Expected: each of the four tables present in all three files; both new `ai_operator_tasks` columns present in the export policy. Anything missing is a latent GDPR erasure bug — fix it before going further.

- [ ] **Step 2: Unit suites**

```
cd packages/shared && npx vitest run
cd ../../apps/api && npx vitest run src/services/aiOperator src/db/schema src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/routes/aiOperatorTasks.test.ts src/routes/devices src/services/tenantCascade.test.ts src/services/ticketOrgMoveLockOrder.test.ts
```
Expected: PASS. Note the `src/services/aiOperator` and `src/routes/devices` filters are plain **substring** matches, not directory prefixes — that is intentional here (it sweeps the dotted siblings too), but check the file counts look right rather than trusting the green.

- [ ] **Step 3: Typecheck and lint**

```
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd ../.. && pnpm lint
```

- [ ] **Step 4: Every contract suite, with a live stack**

```
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/aiOperatorTaskGraphRls.integration.test.ts \
  src/__tests__/integration/aiOperatorTaskGraphCascade.integration.test.ts \
  src/__tests__/integration/aiOperatorInlineTargetBackfill.integration.test.ts
```
Expected: PASS, all nine. These are the suites that only run in the **Integration Tests** CI job, so a unit-green branch can still redden `main` — this is the run that prevents it.

- [ ] **Step 5: Schema drift**

Run (repo root, with the stack up): `pnpm db:migrate && pnpm db:check-drift`
Expected: no drift.

- [ ] **Step 6: Independent code review — ONE round**

Run `/pr-review-toolkit:review-pr` against the branch diff, or dispatch a reviewer subagent with the diff and this plan's "Decisions recorded for the orchestrator" section. Act only on confirmed, consequential findings. Per the rigor rule, re-review only if a fix itself touches tenancy, RLS or a migration — which, in this wave, most fixes will, so budget for exactly one re-review of the changed hunks and no more.

- [ ] **Step 7: File the follow-up issue from Task 11 Step 5**

Five of the six new task limits are declared but not yet enforced (their enforcement is P3-3). File one issue titled `AI Operator: enforce task-wide policy limits (v14) at admission and dispatch`, listing all five with the `runService.ts` inventory lines that record the deferral, and reference it in the PR body. A deferral with no issue is an omission with a comment.

- [ ] **Step 8: Tear the stack down**

Run (repo root): `pnpm test-stack down`
Then confirm nothing was left behind:
```
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```

- [ ] **Step 9: Push and open the PR — then STOP**

```
git push -u origin feature/<parent#>-operator-recipe-library/wave-<subissue#>
gh pr create --base main --title "feat(api): AI Operator task targets, accounts, steps and events (recipe library E2)" --body "$(cat <<'EOF'
Wave E2 of the Operator Recipe Library (recipe spec §5.1, §5.2, §5.3 step_kind, §5.5, §6.7, §10 row E2). This IS Operator completion P3-2's schema PR with the recipe-library deltas.

## What lands
- Four Shape-1 tables: `ai_operator_task_targets` (device | ticket | **contact**), `ai_operator_task_target_accounts` (frozen M365/Google identity), `ai_operator_task_steps` (with `step_kind`), `ai_operator_task_events` (append-only, per-task monotonic `transition_seq`).
- `ai_operator_tasks.workflow_config_id` (nullable, no FK — its table is a later wave) and `ai_operator_tasks.event_seq` (the event-sequence allocator).
- A backfill giving every existing task one target row, one step row and an opened timeline. **The inline `device_id`/`target_label`/`current_step_key` columns are kept as a read projection** (spec §5.5) — this wave is additive and no existing reader changes.
- `targetService.ts`, `stepService.ts`, `eventService.ts`; the coordinator and admission now write step rows and events in the same transaction as the task CAS.
- Agent policy snapshot **13 → 14** with six task-wide budgets (spec §7.2).
- `GET /ai/operator/tasks/:id` gains `targets` (with nested `accounts`), `steps`, `events`. `AI_OPERATOR_TASK_DTO_SCHEMA_VERSION` stays 1.

## Tenancy
Every table: forced RLS with the four `breeze_has_org_access(org_id)` policies in the creating migration; `text`+CHECK never `pgEnum`; composite `(x, org_id)` and `(x, task_id, org_id)` FKs all `DEFERRABLE INITIALLY IMMEDIATE`; column-scoped `ON DELETE SET NULL (col)` so detach never clears `org_id`.

Registered in: `CORE_ORG_CASCADE_DELETE_ORDER`, `AUDIT_ADMIN_REQUIRED_TABLES` (events), `CORE_TENANT_EXPORT_POLICY` (four tables + the two new `ai_operator_tasks` columns), `orgMergeRegistry` (`leave-for-erasure` ×4), `ORG_ID_BLOCKING_TRIGGERS`, `DEVICE_DETACH_DEVICE_ID_TABLES`, `breeze_device_child_orgid_tables()`'s exclusion list, and the device/ticket/contact/merge detach paths. **`ai_operator_task_targets` is deliberately EXEMPT** from the device and ticket org-denormalized re-stamp lists, with explicit entries in `moveOrg.coverage.test.ts`: a target's `org_id` is its task's immutable `org_id`, so re-stamping it would 23503 against `ai_operator_task_targets_task_org_fk`. It detaches instead, exactly like `ai_operator_tasks` and `ai_agent_runs`.

## Two spec corrections made here
1. The policy snapshot bump is **13 → 14**, not the spec's 9 → 10 — four waves have landed since that text was written.
2. `target.device_id` / `target.ticket_id` are **plain** FKs (Operator spec §11.3's matrix), not composite; only `contact_id` is composite.

## Verification
Nine integration suites green against real Postgres as `breeze_app`, including cross-tenant forge (42501), same-org/different-task FK rejection (23503), append-only UPDATE/DELETE refusal, 20-way concurrent `transition_seq` allocation with no gap and no 23505, org-merge-with-a-contact-target completing without 23503, and backfill idempotency.

Follow-up: #<issue from Task 14 Step 7> — five of the six v14 limits are declared and recorded in `runService.ts`'s enforcement inventory as deferred to P3-3.

Closes #<wave sub-issue>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Then STOP.** Do not merge. Do not enqueue. Report the PR number and hand back.

---

## Self-review

**Spec coverage.** Recipe spec §5 preamble (tenancy ceremony) → Task 3 + Task 6. §5.1 `ai_operator_task_targets` incl. the contact class → Tasks 1, 3, 4, 8. §5.2 `ai_operator_task_target_accounts` → Tasks 1, 3, 4, 8. §5.3 **`step_kind` column only** → Tasks 1, 3, 4, 9 (the `checklist_item_id` / `ticket_checklist_items` half is explicitly excluded and named as E3 in the Global Constraints, in the migration header, and in Task 4's schema test). §5.5 `ai_operator_tasks` deltas and the inline read projection → Tasks 2, 5, 12. §6.7 bounds → Task 11. §10 row E2 "migrate inline target; policy snapshot v10" → Task 5 (migrate) and Task 11 (snapshot, corrected to v14). Operator spec §11 column lists → Tasks 3, 4. §11.1 indexes and the text+CHECK rule → Task 3. §11.3 reference lifecycle matrix → Tasks 3, 6. §7.2 task-wide budgets → Task 11.

**Placeholder scan.** No `TBD`, no `TODO`, no "similar to", no "add validation". Six places tell the executor to `grep` and use what it prints rather than guess — E1's `StepDefinition` kind field (Task 9 Step 3), the recipe registry's `TargetKind` shape (Task 4 Step 5), the `tickets`/`google` schema module names (Task 4 Step 4), the agent limits column (Task 11 Step 6), `deleteContact`'s transaction handle (Task 6 Step 9), and the newest definitions of the two device functions (Task 3 sections 8-9). Each names the exact grep and what to do with each possible answer; none leaves a choice open.

**Identifier consistency.** Table names, constraint names, index names, column names and exported function signatures are identical across the migration (Task 3), the Drizzle schema (Task 4), the services (Tasks 7-9), the registration lists (Task 6) and the read layer (Task 12). The seven shared value lists are declared once in `packages/shared` and once in the schema, with `enumParity.test.ts` pinning them — plus a third pin against E1's recipe `TargetKind`.

**The two known gaps, stated rather than hidden.** (1) Five of the six v14 limits are declared and not enforced; Task 11 Step 5 records each in the mandatory `runService.ts` inventory as an explicit deferral and Task 14 Step 7 files the issue. (2) `resolveStepKind` depends on E1 having put a `kind` on `StepDefinition`; if it did not, Task 9 Step 3 specifies the fallback and requires a follow-up issue, because a second hand-maintained kind table will drift.




