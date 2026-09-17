---
tracking_issue: PENDING
---

# Operator Recipe Library — Wave R1: `identity_offboarding`, the Recipe Library surface, readiness, and the deterministic release gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technician opens a ticket that says "Dana's last day is Friday", picks **Offboard a person** from a Recipe Library that already knows whether this org can run it, confirms who Dana is and who inherits her mail, approves one plan, and the Operator carries the whole procedure across Microsoft 365 and Google Workspace — mailbox effects first, disable/suspend last, each effect probe→write→probe, each unavailable capability degraded into a ticket checklist item instead of a failure — then verifies the outcome and writes a bounded completion record onto the ticket. The recipe is `gateClass: 'deterministic'`: the model resolves identities, flags exceptions and writes prose, and never chooses, orders or parameterizes an effect. The feature flag `AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED` ships **off** and stays off until the lab run in R1c passes.

**Architecture:** Three PR-sized parts inside this one plan (see *PR split*). `recipes/identityOffboarding.ts` is a pure `RecipeDefinition` (E1's contract) whose `buildPlan(input, facts)` emits an ordered `PlannedEffect[]` over the **granular** Google tools and the **eight M1** M365 actions — never `google_offboard_user`, and never `google_wipe_mobile_device` (which is a full factory reset; this wave adds the selective `google_account_wipe_mobile_device`). `services/aiOperator/identityDiscovery.ts` issues coordinator-driven deterministic reads against both providers and returns a typed, bounded `IdentityDiscoveryFacts`; `services/aiOperator/recipeReadiness.ts` turns connection rows, `permission_manifest_version`, `m365RoleReadiness`, Google connection health and the `helpdesk` agent's `toolAllowlist` into `ready | setup_required | unavailable` plus named missing capabilities, and turns each missing capability into a generated human-work item instead of a blocked recipe. `taskService.admitServiceRecoveryTask` becomes a thin wrapper over a generalized `admitTask`, which resolves-or-creates the `contacts` row, upserts `contact_external_links`, freezes the provider accounts onto the task (E2's `freezeTargetAccount`), and enforces one live task per `(contact, recipe)` under a per-contact transaction-scoped advisory lock. E1's `StepDefinition` gains one optional, additive field — `next` — so deterministic spine sequencing is recipe data rather than coordinator `if`s.

**Tech Stack:** TypeScript, Zod, Hono, Drizzle ORM, Vitest (unit + `vitest.integration.config.ts` against real Postgres), Astro + React + react-i18next (`apps/web`), Playwright (`e2e-tests`).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-operator-recipe-library-design.md` — §1 (the outcome), §4 + §4.1 (Library, readiness, per-provider degradation), §6.2 (where the model is used), §6.3 (the spine and its ordering contract), §6.5 (degrade-to-human-work), §6.6 (probe→write→probe, unobservable effects and the subsuming criterion, the completion record), §6.7 (bounds), §6.8 / D3 (runs under the `helpdesk` agent, no new agent kind), §8 (API and web), §9 (the `deterministic` gate class), §10 row **R1**, §11 (risks: wrong person, half-offboarded identity). Builds on `docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-completion-design.md` §7.1, §12, §13.

**Feature tracking:** parent issue and wave sub-issue assigned by `register_feature` after all wave plans exist; branch `feature/<parent#>-operator-recipe-library/wave-<subissue#>`.

---

## PR split — this plan is THREE PRs, not one

A single PR here would be ~60 files across api + shared + web + e2e + docs. The parts are cut where the seams are real (server contract → UI over that contract → gate over the shipped behaviour), each is independently green, and each opens its own PR and STOPS.

| Part | Tasks | Content | Ends at |
|---|---|---|---|
| **R1a** | 1–15 | `StepDefinition.next`; the recipe; the selective Google mobile wipe tool; discovery; reason-step prompts + validation; readiness + degradation; `admitTask`; `GET /workflows`; `POST /task-drafts`; the coordinator advancers; the completion record; the flag; integration suites; contract suites | PR "R1a — identity_offboarding recipe, discovery, readiness and admission" |
| **R1b** | 16–22 | Library tab + `/operator` index page; start form from a ticket and from a contact; task page step list / plan / timeline; i18n ×8; MOUNT tasks with page-level tests; `data-testid`s + one e2e spec | PR "R1b — Operator Recipe Library web surface" |
| **R1c** | 23–28 | Per-effect contract tests against recorded provider fixtures; the ordering gate test over dispatch prefixes; plan-membership tests; the eval harness + ≥ 20 intake/discovery cases; the lab-run checklist doc; the gate summary | PR "R1c — identity_offboarding deterministic release gate" (flag stays OFF) |

R1b's branch is cut from R1a's; R1c's from R1b's. **Stacked PRs run NO CI** (`ci.yml` triggers on `pull_request: branches: [main]`), so `gh pr checks` reads green while nothing ran — dispatch each branch explicitly with `gh workflow run CI --ref <branch>` before asking for a merge, and re-target each PR to `main` once its parent lands.

---

## Global Constraints

- **Rigor: high.** This wave destroys a person's access to their employer's systems. Red test first for every task: write the test, run it, *see it fail for the stated reason*, then implement, then run it green. A test that passes on its first run is a broken test — fix the test before writing code. One independent code-review round per part before its PR.
- **Assume E1 (W01), E2 (W02), E3 (W03), E4 (W04) and M1 (W05) have all landed.** Consume their identifiers; never rename, redefine or locally re-implement one. If any is missing when a task runs, the wave it belongs to has not merged — **STOP and report**. The complete consumed surface is listed under *Consumed surface* below.
- **The recipe is PURE.** `apps/api/src/services/aiOperator/recipes/identityOffboarding.ts` may import only `zod`, `@breeze/shared`, `../operationKey`, and other files inside `recipes/`. E1's `recipes/purity.test.ts` scans the directory mechanically and will fail on anything else. No `../../db`, no `../../config/env`, no service module, no `node:fs`, no network. Discovery, readiness, admission and dispatch all live OUTSIDE `recipes/`.
- **Step EXECUTION stays coordinator code** (spec §6.1). `recipes/identityOffboarding.ts` declares *what* the steps are, which the model may propose, and (new, this wave) which step deterministically follows which. `taskCoordinator.ts`'s `RECIPE_ADVANCERS['identity_offboarding']` declares *how* each one runs.
- **`StepDefinition.next` is OPTIONAL and ADDITIVE.** E1's `StepDefinition` gains one field. `permittedNextSteps` keeps its exact meaning — the **model-proposal** set — and is untouched. `service_recovery` declares no `next` and its dispatch, its `serviceRecovery.test.ts` and `aiOperatorServiceRecoveryE2E.integration.test.ts` must stay bit-for-bit green; Task 1 Step 5 proves that by running them unmodified.
- **The mandatory `confirm_identity` human-work step is NOT skippable by policy** (spec §11, risk row 1). There is no input, flag, agent-policy value, env var or admission argument that omits it. Task 3's `identityOffboarding.test.ts` and Task 14's integration suite each assert it, from opposite directions (the recipe's own step graph, and a real admitted task that cannot reach `discover` without it).
- **`google_offboard_user` is never called by this recipe**, and neither is `google_wipe_mobile_device`. Task 3's test greps the recipe's compiled plan output for both names and fails on either. `google_wipe_mobile_device` is a **full factory reset** (`admin_remote_wipe`, `aiToolsGoogle.ts:1149` — *"This is NOT for offboarding"*); the selective corporate-account wipe (`admin_account_wipe`) exists today only inside the composite, and Task 4 lifts it into its own granular tool.
- **Flag:** `AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED` (default **false**), read at call time by `aiOperatorIdentityOffboardingEnabled()` in `apps/api/src/config/env.ts`, checked in `admitTask` and in the library route's readiness computation. It nests under the existing `AI_OPERATOR_TASKS_ENABLED` kill switch exactly as `AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED` does (`env.ts:219-223`). **This PR does not enable it anywhere** — not in `.env.example`'s live assignments, not in either compose default. Env parity: `.env.example` ↔ `docker-compose.yml` and `deploy/.env.example` ↔ `deploy/docker-compose.prod.yml` are the two pairs `apps/api/src/config/envComposeParity.test.ts` guards; add the var to **both** pairs (Task 13).
- **Tenancy.** This wave creates **no new table and no new column on any existing table** except two additive optional fields on `packages/shared`'s `taskCheckpointSchema` (jsonb inside an already-registered column — no DDL) — so `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, `orgMergeRegistry.ts`, `TICKET_ORG_DENORMALIZED_TABLES`, `CUSTOM_ORG_REWRITE_TABLES` and the device-axis lists gain **no entry**. Task 15 re-derives that rather than assuming it. **There is no migration in this wave.** If a step appears to need one, STOP and report instead of writing it.
- **Every DB read/write in this wave is inside an existing context helper.** Admission continues to run under `runOutsideDbContext(() => withSystemDbAccessContext(...))` exactly as `admitServiceRecoveryTask` does today (`taskService.ts:142-268`, with the comment at `:144-149` explaining why). Discovery runs under the coordinator's own system context. The two routes run on the request path under `withDbAccessContext`. The bare pool is never used.
- **Mind the caught-23505/23503 trap.** A unique or FK violation raised inside a request transaction ABORTS it, so a caught error surfaces as a 500 (memory: `pg_unique_violation_inside_request_tx_surfaces_as_500`). Every refusal in this wave is a pre-check against rows with the constraint as backstop, never as control flow — including the one-live-task-per-`(contact, recipe)` rule, which is why it takes an advisory lock (Task 9, Decision 6) rather than racing an insert.
- **Tests:** file beside source. One file: `cd apps/api && npx vitest run src/path/file.test.ts` — **never** `pnpm --filter … test -- --run <path>` (pnpm forwards the literal `--`, vitest swallows `--run` as a positional and runs the whole 1,470-file suite in watch mode), and never a trailing-slash directory filter (it silently skips dotted siblings). Web: `cd apps/web && npx vitest run src/path/file.test.tsx`. Shared: `cd packages/shared && npx vitest run src/path/file.test.ts`. Integration: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>` with a live stack (`pnpm test-stack up` at the repo root writes `.env.test`; `pnpm test-stack down` when finished — nothing does this for you). **Integration tests MUST live under `apps/api/src/__tests__/integration/`** — a wrongly placed one runs ZERO tests and reads green. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`, plus `cd packages/shared && npx tsc --noEmit -p tsconfig.json` and `cd apps/web && npx tsc --noEmit -p tsconfig.json` after touching those. **A 0-test run is a stall, not a pass** — always read the reported file/test counts.
- **Web:** every mutation goes through `runAction` (`apps/web/src/lib/runAction.ts`); selected tab / step / recipe state lives in `window.location.hash`, never a query param; every new i18n key needs a **real translation** in all eight locale directories under `apps/web/src/locales/` (`de-DE`, `en`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) — an English string copied into `tr-TR` fails `apps/web/src/lib/i18n/localeParity.test.ts`'s intent and is rejected in review. Every new surface gets an explicit **MOUNT** task with a page-level test: a previous wave shipped 13 green components that were never wired into a page.
- **Commits:** one per task, every message ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Each part's final task opens its PR with `Closes #<wave sub-issue>` and **STOPS** — never merge, never `--admin`.

---

## Consumed surface (from E1–E4 and M1 — never redefine)

**E1 — `apps/api/src/services/aiOperator/recipes/`**
`STEP_KINDS` / `StepKind` (`'reason'|'effect'|'probe'|'wait'|'human_work'|'document'`), `TARGET_KINDS` / `TargetKind`, `RECIPE_GATE_CLASSES` / `RecipeGateClass`, `TaskPhase`, `EffectProvider` (`'breeze'|'m365'|'google'`), `StepDefinition { kind; phase; inputSchema?; terminal? }`, `RecipeBounds { maxReasoningRuns; maxMutationAttempts; freshnessSeconds; observeWakeAfterMs; verificationWakeAfterMs; unknownEffectHorizonMs; deadlineMs }`, `CapabilityRequirement { key; kind: 'provider_connection'|'permission_grant'|'tool_source'|'agent_tool'; provider; detail; toolNames? }`, `PlannedEffect { ordinal; toolName; provider; targetId; accountExternalId; canonicalArguments }`, `DiscoveryFacts = Readonly<Record<string, unknown>>`, `NextStepValidation`, `NextStepFailureReason`, `CrossCheckResult`, `RecipeDefinition<Input>`, `validateRecipeNextStep(recipe, currentStepKey, proposed, frozenInput)`, `RECIPES`, `RECIPE_KEYS`, `getRecipe(key, version)`, `getRecipeByKey(key)`, `resolveAdmissionRecipe(key, version)` → `RecipeResolution`.
In `taskCoordinator.ts`: `resolveTaskRecipe(task)`, `type StepAdvancer`, `const RECIPE_ADVANCERS`.

**E2 — `apps/api/src/db/schema/aiOperatorTaskGraph.ts` + services**
Tables `ai_operator_task_targets`, `ai_operator_task_target_accounts`, `ai_operator_task_steps`, `ai_operator_task_events`; `aiOperatorTaskTargets`, `aiOperatorTaskTargetAccounts`, `aiOperatorTaskSteps`, `aiOperatorTaskEvents`, `AI_OPERATOR_STEP_KINDS`, `AI_OPERATOR_STEP_STATES`, `AI_OPERATOR_TASK_EVENT_TYPES`, `AI_OPERATOR_EVENT_ACTOR_KINDS`.
`eventService.ts`: `appendTaskEvent`, `TaskEventActor`, `EventDbHandle`.
`targetService.ts`: `TargetDbHandle`, `createTaskTarget(dbh, CreateTaskTargetInput)`, `freezeTargetAccount(dbh, FreezeTargetAccountInput)`, `detachTargets(dbh, DetachTargetsInput)`, `upsertContactExternalLinks(dbh, ResolveContactTargetInput)`, `targetColumnForKind`, `CONTACT_LINK_SYSTEMS`.
`stepService.ts`: `StepDbHandle`, `openStep(dbh, OpenStepInput)`, `markStepWaiting`, `settleStep`, `resolveStepKind(workflowKey, workflowVersion, stepKey)`.

**E3 — `apps/api/src/services/aiOperator/humanWorkService.ts` + coordinator**
`HumanWorkDbHandle`, `OPERATOR_TASK_ACTOR`, `HUMAN_WORK_POLL_WAKE_MS`, `ensureTaskTicket(dbh, task)` → `{ ticketId; targetId; created }`, `openHumanWorkStep(dbh, OpenHumanWorkStepInput)` → `{ stepId; checklistItemId; ticketId }`, `readHumanWorkStep(orgId, taskId, stepKey, attemptOrdinal)` → `HumanWorkStepView | null`, `onChecklistItemDone`, `onChecklistItemUnticked`, `assertChecklistItemDeletable`, `HumanWorkStepWaitingError`, `detachHumanWorkLinksForTicket`.
In `taskCoordinator.ts`: `advanceHumanWork(args)`, `advanceWait(args)`, the `KIND_ADVANCERS` fallback consulted **after** `RECIPE_ADVANCERS[recipe.key]?.[stepKey]`.
In `packages/shared`: `taskCheckpointSchema` gained `waitUntil?: string` (ISO) and `resumeStepKey?: string`; `CHECKLIST_ITEM_SOURCES` gained `'operator_task'`; `AI_OPERATOR_TASK_EVENT_TYPES` gained `'human_work_unticked'`. `ai_operator_task_steps` gained `remind_after_at` / `reminded_at`.

**E4 — plan approval and effect dispatch**
`planApproval.ts`: `PlanDbHandle`, `PlanSplit`, `splitSecretBearingEffects(effects)`, `toDigestProjection`, `effectArgumentDigest(effect)`, `proposePlanApproval(ProposePlanApprovalInput)` → `ProposePlanApprovalResult`, `markPlanApproved(args)`, `bumpPlanRevision(dbh, args)`, `checkPlanEffectMembership(dbh, args)` → `PlanMembershipResult`, `advancePlanApprovalStep(task, leaseEpoch, checkpoint, stepKey)`.
`effectProbes/index.ts`: `EffectProbeState` (`'satisfied'|'unsatisfied'|'unknown'`), `EffectProbeResult { state; observedAt: Date; detail }`, `EffectProbeContext { orgId; taskId; planRevision; effectRequestedAt; phase: 'pre'|'post' }`, `EffectProbe`, `registerEffectProbe(toolName, probe)`, `getEffectProbe`, `listProbedTools`, `probeEffect(effect, ctx)`. Eight Google probes registered in `effectProbes/google.ts`; the M365 adapter in `effectProbes/m365.ts` maps tool name → action id via `M365_HEADLESS_ACTIONS` and wraps `probeM365Effect`.
`effectDispatch.ts`: `EffectDispatchOutcome`, `dispatchPlannedEffect(args)`, `EffectVerificationOutcome`, `verifyDispatchedEffect(args)`, `advanceEffectStep(task, leaseEpoch, checkpoint, stepKey)`.
`packages/shared`: `AI_OPERATOR_PLAN_APPROVAL_STATES`, `AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES`, `AiOperatorEffectIdempotencyClass`, `AiOperatorPlanApprovalDto`, `AiOperatorPlanEffectDto`; `computeEffectSetDigest`, `canonicalizeEffectSet`, `PlannedEffectForDigest`.
Tables `ai_operator_plan_approvals`, `ai_operator_plan_approval_effects`. Tool `operator_plan`. Error codes `plan_approval_revoked`, `tool_not_in_agent_allowlist`.

**M1 — M365 write catalog**
`packages/shared/src/m365/writeActions.ts`: `M365_WRITE_ACTION_IDS`, `M365_PROBE_ACTION_IDS`, `M365WriteActionId`, `M365ProbeActionId`, `M365ExecutorActionId`, `M365_WRITE_ACTION_IDEMPOTENCY`, `M365_WRITE_ACTION_REQUIRED_ROLES`.
Action ids ↔ agent tool names: `m365.user.revoke_sessions`↔`m365_revoke_sessions`, `m365.user.license.remove`↔`m365_remove_license`, `m365.user.license.assign`↔`m365_assign_license`, `m365.group.membership.remove`↔`m365_remove_from_group`, `m365.group.membership.add`↔`m365_add_to_group`, `m365.intune.device.retire`↔`m365_retire_intune_device`, `m365.user.create`↔`m365_create_user`, `m365.user.mailbox.auto_reply`↔`m365_set_auto_reply`. Pre-existing: `m365.user.disable`↔`m365_disable_user`, `m365.user.reset_password`↔`m365_reset_password`.
`m365ControlPlane/effectProbes.ts`: `probeM365Effect(actionId, args, ctx)`.
`m365ControlPlane/readActionService.ts`: `executeM365ReadActionByOrg(orgId, action, opts?)` → `M365ReadActionServiceResult`.
`m365ControlPlane/writeActionService.ts`: `M365WriteActionRefusalCode` incl. `'consent_upgrade_required'`, `executeM365WriteActionForAuth`.
`m365ControlPlane/connectionService.ts`: `m365RoleReadiness(connection, profile)` → `Record<string, boolean>`, `listStaleManifestConnectionsForPartner(profile)`.
Profile `customer-graph-actions` is at **version 2** (`packages/shared/src/m365/profiles.ts`).

---

## Decisions recorded for the orchestrator

Each is a place where the wave brief, the spec, or the obvious design does not survive contact with the shipped code. The executor must **not** "fix" these back.

### D-R1-1 — `google_wipe_mobile_device` is a FULL FACTORY RESET and this recipe must not call it; R1 adds `google_account_wipe_mobile_device`

The wave brief says to use `google_wipe_mobile_device` with "selective account wipe semantics". The shipped tool does the opposite. Verified first-hand:

- `apps/api/src/services/aiAgentSdkTools.ts:1149` — the tool's own description: *"STOLEN/LOST DEVICE ONLY: issue a FULL factory reset (admin_remote_wipe) to every mobile device enrolled to a user. This erases the ENTIRE device, not just corporate data. **This is NOT for offboarding** — offboard uses a selective account wipe."*
- `apps/api/src/services/aiToolsGoogle.ts` — the handler calls `wipeMobileDevices(dir, resolved.deviceIds, 'admin_remote_wipe')`.
- `aiToolsGoogle.ts:147-155` — `wipeMobileDevices(dir, deviceIds, action)` already takes `'admin_account_wipe' | 'admin_remote_wipe'` and documents the former as *"remove ONLY the managed corporate account + its data (mail/Drive) from the device. Safe for BYOD; the personal device is intact."* Today that branch is reachable **only** through `google_offboard_user`'s `accountWipeMobile` option — the composite this recipe is forbidden to call.

So the selective effect exists, is already exercised, and has no granular tool. Task 4 adds `google_account_wipe_mobile_device` (`admin_account_wipe`) through the full Google-tool registry sweep and registers it with the same probe body E4 wrote for `google_wipe_mobile_device` (the observable end state is identical — the device list reports `status ∈ ('WIPING','WIPED')`). The recipe plans that tool and nothing else. Wiping a leaver's personal phone because a plan named the wrong tool is precisely the irreversible harm spec §11 exists to prevent, and no amount of approval-card wording makes a factory reset the right default.

### D-R1-2 — `StepDefinition.next` is a pure resolver, and `permittedNextSteps` is untouched

The orchestrator's decision, implemented literally. `next?: StepKey | ((ctx) => StepKey)` where `ctx = { input: unknown; facts: Readonly<Record<string, unknown>>; readiness: Readonly<Record<string, boolean>> }`, pure, and resolved by the coordinator when a **non-`reason`** step settles. It is written into E3's checkpoint `resumeStepKey` by the transition, which is exactly the field E3's decision 11 created for this ("a `human_work`/`wait` step's successor is recipe-owned knowledge the generic advancer cannot derive: `permittedNextSteps` describes what the MODEL may propose, which is exactly the wrong question here"). `permittedNextSteps` keeps its meaning and its sparseness; `service_recovery` declares no `next` and is unaffected.

Why a function and not just a key: three of this recipe's transitions genuinely branch on facts the recipe cannot know at authoring time — `wait_cutoff` is skipped when no `cutoffAt` was given, `device_actions` is skipped when the technician selected no devices, and `manual_work` is skipped when readiness degraded nothing and discovery flagged nothing. Expressing those as coordinator `if`s would put the recipe's shape in two files.

### D-R1-3 — `createOperatorTaskSchema` and `taskCheckpointSchema` are still service-recovery-shaped; R1 generalizes both, and E1's 400 is preserved

Read at planning time, `packages/shared/src/validators/aiOperator.ts`:

- `:234-264` — `createOperatorTaskSchema` has `deviceId: z.string().guid()` **required** and `inputs: z.object({ serviceName: z.string().min(1).max(255) }).strict()`. E1's decision 6 relaxed only `recipeKey` (to `z.string().min(1).max(128)`, so the route's 400 can name the supported keys).
- `:185-205` — `taskCheckpointSchema.recipeInput` is literally `serviceRecoveryInputSchema`.

Neither admits a second recipe. The generalization deliberately does **not** convert the body into a `z.discriminatedUnion('recipeKey', …)`: that would make an unknown key a generic zod 400 and undo E1's decision 6, whose whole point is a refusal that lists `RECIPE_KEYS`. Instead (Task 8):

- `deviceId` becomes `.optional()`; `inputs` becomes `z.record(z.string(), z.unknown())`; the outer object keeps `.strict()` (spec §12: "Requests cannot supply a principal, effective policy, approval result, or trusted continuation token" — `.strict()` is what turns each into a 400).
- Strictness moves to the recipe: the route resolves the recipe with `resolveAdmissionRecipe` first (400 / 422 unchanged), then parses `{ ...body.inputs, ...(body.deviceId ? { deviceId: body.deviceId } : {}) }` with `recipe.inputSchema`, which is itself `.strict()`. `service_recovery`'s existing wire shape (`{ deviceId, inputs: { serviceName } }`, sent by `apps/web/src/components/aiOperator/DelegateToOperatorButton.tsx`) therefore composes to exactly the `{ deviceId, serviceName }` object `parseServiceRecoveryInput` already receives. **The shipped web client is not changed and its test is not touched.**
- `taskCheckpointSchema.recipeInput` becomes `z.union([serviceRecoveryInputSchema, identityOffboardingInputSchema])`, service-recovery arm first. Both are `.strict()`, so neither can absorb the other's object. E3's `taskCheckpointSchema.parse({ recipeInput: { deviceId, serviceName } })` at its Task 1 stays green.

### D-R1-4 — the checkpoint gains three bounded fields; discovery facts live on the `discover` STEP row, not on the task

`IdentityDiscoveryFacts` is up to a few kilobytes of groups, licences and devices. Putting it in the task checkpoint would inflate every coordinator read of every task, and spec §5.5 is explicit that anything a customer must be able to export lives in bounded `text`, never only inside a checkpoint container. Discovery facts are transient working state, not the evidence artifact (the completion record is). So they are written to the `discover` step row's existing `checkpoint` jsonb (E2's `openStep(dbh, { …, checkpoint })`), and the **task** checkpoint gains only three bounded scalars:

```ts
discoveryStepId: z.string().uuid().nullable().default(null),   // where the facts are
effectCursor:    z.number().int().min(0).max(64).default(0),   // next PlannedEffect ordinal to dispatch
manualWorkCursor:z.number().int().min(0).max(64).default(0),   // next manual item to bind a step to
```

All three are `.default()`ed, so every shipped checkpoint row keeps parsing.

### D-R1-5 — manual items are all created UP FRONT; the step rows bind to them one at a time

E3's `openHumanWorkStep` creates exactly one checklist item per step row, and its wake is per item. Applied naively that serializes the technician's work: "collect the laptop" would not appear until "transfer file ownership" was ticked, which is wrong — those are parallel real-world jobs and an MSP will do them in whatever order the person is available.

R1 therefore adds a small additive module `services/aiOperator/manualWork.ts` with two functions that reuse E2/E3's writers and redefine nothing:

- `ensureManualWorkItems(dbh, task, items)` — inserts every outstanding manual item onto the task's ticket as `source: 'operator_task'` with `operator_step_id` NULL, idempotently, on first entry to `manual_work`. The whole list is visible on the ticket immediately.
- `attachHumanWorkStep(dbh, input & { checklistItemId })` — opens a step row bound to an item that already exists (E2's `openStep` + `markStepWaiting` + `appendTaskEvent`, and stamps the item's `operator_step_id`), instead of creating a new one.

The advancer then walks `checkpoint.manualWorkCursor` over the list, skipping anything already `done_at`, so a technician who tickets out of order simply advances the cursor faster. `patchChecklistItem` stays human-only — the Operator creates items and **never** completes one (E3's Task 10 guard covers this and Task 15 re-runs it).

### D-R1-6 — one live task per `(contact, recipe)` is a transaction-scoped ADVISORY LOCK, not `SELECT … FOR UPDATE` on the contact

Spec §8: "One live task per `(contact, recipe)` is enforced at admission, serialized per contact; the contact lives on the target row, so this is an admission check in the same transaction as the insert, not an index on `ai_operator_tasks`." Three candidates were weighed against the shipped code:

1. **A partial unique index.** Impossible: the contact is on `ai_operator_task_targets`, the liveness is on `ai_operator_tasks.state`, and a unique index cannot span two tables. Rejected on feasibility.
2. **`SELECT … FROM contacts WHERE id = ? FOR UPDATE`.** Rejected on blast radius: an `UPDATE` of any FK column that points at `contacts` takes `FOR KEY SHARE` on the parent row (memory: `fk_column_write_takes_key_share_on_parent`), so holding `FOR UPDATE` for the length of an admission would block ordinary contact edits and every child-row write in the org for that person. It also only serializes against other writers who take the same lock, which nothing else in the codebase does.
3. **ADOPTED — `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`** with `$1 = 'ai_operator:' || recipeKey || ':' || contactId`, taken as the first statement inside the admission's existing `withSystemDbAccessContext` transaction, before the liveness read. It is transaction-scoped (auto-released on commit or rollback — no leak path), touches no user table, blocks nothing else, and gives exactly the mutual exclusion the rule needs. The liveness check that follows is a plain `SELECT` over `ai_operator_tasks JOIN ai_operator_task_targets` for a non-terminal state; because the lock is held, a second admitter sees the first's committed row. The refusal is `duplicate_live_task` and is returned as a refusal, never as a caught constraint error — a 23505 inside the transaction would abort it and surface as a 500.

### D-R1-7 — M365 group **ownership** has no read action, so sole-ownership is detected from the members read plus an explicit unknown

Verified: `packages/shared/src/m365/readActions.ts`'s `M365_INTERACTIVE_READ_ACTION_IDS` contains `m365.group.list`, `m365.group.get`, `m365.group.members.list` — and **no owners action**; there is no `m365_groups` table anywhere in `apps/api/src/db/schema/` (groups are Graph-live-read only, never synced). Spec §6.2 asks discovery to flag "sole owner of a group or Team".

R1 does **not** add a new Graph read action for this — M1 is merged, a new read action id is a change to a shipped executor contract, and the fallback is honest and safe. Instead `IdentityDiscoveryFacts.m365.groups[].ownership` is `'sole' | 'shared' | 'none' | 'unknown'`, populated `'unknown'` for every M365 group in this wave, and **every `'unknown'` ownership on a group whose membership the plan removes produces a human-work item** ("confirm <group> has another owner before removing Dana"). Google's `groups.list({ userKey })` does expose the role, so Google groups get a real `'sole'|'shared'|'none'`. The asymmetry is recorded in the discovery module's header and filed as a follow-up (`m365.group.owners.list`, Task 15).

### D-R1-8 — the Breeze device ↔ person link does not exist; `devices.last_user` is a HINT for the start form and is never an effect target

The brief asks to find how a device links to a person. Answer, verified: it does not. `apps/api/src/db/schema/devices.ts` has no contact, person, primary-user or assigned-user column and there is no `device_users` table; the only column in the neighbourhood is `lastUser: varchar('last_user', { length: 255 })` at `devices.ts:143`, written straight from the agent heartbeat (`routes/agents/heartbeat.ts:841`, `data.lastUser ?? null`) — an unvalidated OS username string, not an identity.

Consequences, all deliberate:
- **Discovery reports Breeze devices as `suggested`, never as `resolved`.** `IdentityDiscoveryFacts.breeze.suggestedDevices` is an `ILIKE` match of `devices.last_user` against the local part of each frozen account's `principalLabel`, capped at 25 rows, each carrying `matchBasis: 'last_user_ilike'`.
- **`buildPlan` NEVER derives a device effect from a suggestion.** Device effects come only from `input.deviceIds`, which the technician chose in the start form (where the suggestions are shown, pre-checked off).
- **The hardware step is always human-work**, regardless of whether anything matched, exactly as the brief requires.

### D-R1-9 — the reason steps' prompts are TypeScript rendering, not prompt files, because that is what the Operator has

There is no `runService.ts` and there are no `.md` prompt files anywhere in `services/aiOperator/`. `SERVICE_RECOVERY_PROMPT_VERSION = 'service_recovery/v1'` (`recipes/serviceRecovery.ts:47`) is a constant whose docstring says to bump it whenever `taskContext.ts`'s **rendering** changes, and it is read once, at `taskCoordinator.ts:360`, as `promptVersion` on the admitted reasoning run. R1 follows that shape exactly: `IDENTITY_OFFBOARDING_PROMPT_VERSION = 'identity_offboarding/v1'` on the recipe, and the rendering in a new sibling `services/aiOperator/taskContextIdentity.ts` (outside `recipes/` — it reads discovery facts, so it is not pure).

The model's output rides in the existing `submit_task_step` envelope (`services/aiAgents/tools/submitTaskStep.ts`, `SUBMIT_TASK_STEP_SHAPE`, shared `submitTaskStepSchema`, `validateSubmitTaskStep`; enabled per-run by `outcomeToolsForRun` when `run.taskId` is set). A reason step's structured output is therefore `nextStep.inputs`, validated by the **next** step's `inputSchema` through E1's `validateRecipeNextStep` — which is the seam that already exists and needs no new tool.

### D-R1-10 — `plan_approval` is a `probe`-kind step named with the `plan_` prefix E4 routes on

E4 Task 12's coordinator arm is `if (kind === 'probe' && stepKey.startsWith('plan_')) return advancePlanApprovalStep(...)`, with a written instruction to check what E1 actually named the step before writing it. This recipe's step key is **`plan_approval`**, kind **`probe`** — it matches that arm as shipped, so E4's coordinator code needs no edit. `STEP_KINDS` is **not** widened (it is pinned by E1's `types.test.ts` and E2's `step_kind` CHECK).

### D-R1-12 — `setup_required` means "something this tenant can fix"; a product gap is `always_manual` and does not block (orchestrator decision)

An earlier draft of this plan had a fully-consented org reading `setup_required` **forever**, because the three Exchange capabilities can never be satisfied before M2 ships. That is wrong in two ways: it misstates whose problem it is (the tenant has done everything they can), and a badge that is permanently on is a badge technicians learn to ignore — so the one time it means "re-consent Microsoft 365" it will not be read.

`CapabilityRequirement` therefore gains an optional `availability: 'tenant_fixable' | 'always_manual'` (Task 1 Step 3b), and `computeRecipeReadiness` partitions unsatisfied capabilities by it:

- **`tenant_fixable`** → `RecipeReadiness.missing`, and its presence is what makes the state `setup_required`. There is an action: connect a provider, re-consent to profile v2, add the identity tools to the helpdesk agent.
- **`always_manual`** → `RecipeReadiness.alwaysManualCapabilities` + `manualStepCount`, and it **never** changes the state.

So a fully-consented org reads `ready` with `manualStepCount: 3`, and the card reads *"Ready · 3 steps will be done by hand"*. **Degradation is unchanged** — a tool behind either kind of unsatisfied capability is still in `degradedEffects` and still becomes a human-work item with generated instructions. The distinction is only about what the badge claims, which is why `degradedEffects` deliberately spans both partitions.

Absent means `tenant_fixable`, and that direction is the safe one: an unclassified capability is assumed fixable and therefore blocking, so forgetting the field can only over-report setup, never hide it. Task 8 case 12 pins that.

**When M2 (the Exchange Online executor) ships:** flip those three declarations in `recipes/identityOffboarding.ts` to `availability: 'tenant_fixable'` and nothing else changes. Readiness, the card's two blocks, the degradation map and the i18n copy all already key off this single field, and Task 3's "the ONLY always_manual ones" assertion will fail until the test's expected list is emptied — which is the correct prompt to re-read this decision at that point.

### D-R1-11 — `google_signout` is declared `unobservable` with a named subsuming criterion

Spec §6.6 and E4's D-E4-7 agree that `google_signout` can never be probed (the Directory API exposes no session-validity field; `lastLoginTime` is not one). The recipe declares it in `IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS` with the criterion `google_suspend_user` — a verified suspend makes live Google sessions moot, which is exactly the "names the outcome criterion that subsumes it" the spec asks for. Therefore: `google_signout`'s post-probe result stays `unknown`; the task can still reach `verified_resolved` **provided** the subsuming effect's post-probe is `satisfied`; and the completion record says "dispatched, not independently verifiable". If suspend is unsatisfied or absent from the plan (the `keepMailbox` + "suspend later" shape), the outcome is `partial` with `google_signout` listed. `m365.user.reset_password` is not in this recipe's catalog at all (it is R2's).

---

## File Structure

**packages/shared**
- Create `src/types/aiOperatorRecipes.ts` — readiness DTOs and value lists.
- Create `src/validators/aiOperatorIdentity.ts` — `identityOffboardingInputSchema` and the reason-step output schemas.
- Modify `src/validators/aiOperator.ts` — `taskCheckpointSchema` (+3 fields, `recipeInput` union), `createOperatorTaskSchema` (deviceId optional, inputs generic), new `operatorTaskDraftSchema`.
- Modify `src/index.ts` / the relevant barrel — export both new modules.

**apps/api — recipe and pure code**
- Modify `src/services/aiOperator/recipes/types.ts` — `StepDefinition.next`, `NextStepResolver`, `NextStepContext`.
- Create `src/services/aiOperator/recipes/resolveNextStep.ts` (+ `.test.ts`) — the one pure resolver.
- Create `src/services/aiOperator/recipes/identityOffboarding.ts` (+ `.test.ts`, + `.ordering.test.ts`).
- Modify `src/services/aiOperator/recipes/index.ts` — register `identityOffboardingRecipe` in `RECIPES`.

**apps/api — services**
- Create `src/services/aiOperator/identityDiscovery.ts` (+ `.test.ts`).
- Create `src/services/aiOperator/recipeReadiness.ts` (+ `.test.ts`).
- Create `src/services/aiOperator/taskContextIdentity.ts` (+ `.test.ts`).
- Create `src/services/aiOperator/contactResolution.ts` (+ `.test.ts`).
- Create `src/services/aiOperator/manualWork.ts` (+ `.test.ts`).
- Create `src/services/aiOperator/completionRecord.ts` (+ `.test.ts`).
- Create `src/services/aiOperator/identityAdvancers.ts` (+ `.test.ts`) — the recipe's `RECIPE_ADVANCERS` entries.
- Modify `src/services/aiOperator/taskService.ts` — `admitTask`, `admitServiceRecoveryTask` wrapper.
- Modify `src/services/aiOperator/taskCoordinator.ts` — register `RECIPE_ADVANCERS['identity_offboarding']` (one added table entry, nothing else).
- Modify `src/services/aiToolsGoogle.ts`, `src/services/aiAgentSdkTools.ts`, `src/services/aiGuardrails.ts`, `src/services/googleToolsHeadless.ts`, `src/services/aiOperator/effectProbes/google.ts`, `apps/web/src/components/ai-risk/tierConfig.ts` — the `google_account_wipe_mobile_device` sweep.
- Modify `src/config/env.ts` — `aiOperatorIdentityOffboardingEnabled()`.
- Modify `src/config/validate.ts` — `ENV_SCHEMA_KEYS`.
- Modify `src/routes/aiOperatorTasks.ts` — `GET /workflows`, `POST /task-drafts`, generalized `POST /tasks`.

**apps/api — integration tests (all under `src/__tests__/integration/`)**
- `aiOperatorIdentityOffboardingE2E.integration.test.ts`
- `aiOperatorIdentityAdmission.integration.test.ts`
- `aiOperatorRecipeReadiness.integration.test.ts`

**apps/web**
- Create `src/components/aiOperator/RecipeLibrary.tsx`, `RecipeCard.tsx`, `StartRecipeForm.tsx`, `OperatorTaskSteps.tsx`, `OperatorTaskPlan.tsx`, `OperatorTaskEvents.tsx` (+ tests).
- Create `src/pages/operator/index.astro`.
- Modify `src/components/aiOperator/OperatorTaskDetail.tsx` (the MOUNT), the ticket detail page and the contact panel (the two launch points).
- Modify `src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/aiOperator.json`.

**e2e-tests**
- Create `tests/operator-recipe-library.spec.ts`, `pages/OperatorLibraryPage.ts`.

**apps/api — gate (R1c)**
- Create `src/services/aiOperator/__fixtures__/providers/*.json` — recorded provider responses.
- Create `src/services/aiOperator/effectContracts.test.ts`.
- Create `src/services/aiOperator/evals/identityIntake.cases.json` + `evals/identityIntake.eval.test.ts` + `evals/README.md`.
- Create `docs/superpowers/qa/2026-09-17-identity-offboarding-lab-run.md`.

**root**
- Modify `.env.example`, `docker-compose.yml`, `deploy/.env.example`, `deploy/docker-compose.prod.yml`.

---

# PART R1a — recipe, discovery, readiness, admission, API

### Task 1: Three additive fields on E1's recipe contract — `StepDefinition.next`, `CapabilityRequirement.availability`, `operationKey`'s `toolName`

**Files:**
- Modify: `apps/api/src/services/aiOperator/recipes/types.ts`
- Create: `apps/api/src/services/aiOperator/recipes/resolveNextStep.ts`
- Create: `apps/api/src/services/aiOperator/recipes/resolveNextStep.test.ts`
- Modify: `apps/api/src/services/aiOperator/recipes/types.test.ts`
- Modify: `apps/api/src/services/aiOperator/recipes/serviceRecovery.ts` — **one line**, `operationKey`'s pass-through (see Step 3c)

All three are **optional and additive**, and all three exist because R1 is the first wave with a second recipe: nothing here changes a shipped behaviour, and `serviceRecovery.test.ts` and `aiOperatorServiceRecoveryE2E.integration.test.ts` are **not edited by this wave**.

**Interfaces:**
- Consumes: `StepDefinition`, `CapabilityRequirement`, `RecipeDefinition` (`./types`, E1); `buildTaskOperationKey` (`../operationKey`).
- Produces:
  ```ts
  // recipes/types.ts — additive only
  export interface NextStepContext {
    readonly input: unknown;
    readonly facts: Readonly<Record<string, unknown>>;
    readonly readiness: Readonly<Record<string, boolean>>;
  }
  export type NextStepResolver = (ctx: NextStepContext) => string;
  export interface StepDefinition {
    kind: StepKind;
    phase: TaskPhase;
    inputSchema?: z.ZodTypeAny;
    terminal?: boolean;
    /** NEW (R1). Deterministic successor. See recipes/resolveNextStep.ts. */
    next?: string | NextStepResolver;
  }

  export const CAPABILITY_AVAILABILITIES = ['tenant_fixable', 'always_manual'] as const;
  export type CapabilityAvailability = (typeof CAPABILITY_AVAILABILITIES)[number];
  export interface CapabilityRequirement {
    key: string;
    kind: 'provider_connection' | 'permission_grant' | 'tool_source' | 'agent_tool';
    provider: EffectProvider | null;
    detail: string;
    toolNames?: readonly string[];
    /** NEW (R1). Absent means `tenant_fixable`. */
    availability?: CapabilityAvailability;
  }

  export interface RecipeDefinition<Input = unknown> {
    /* …unchanged… */
    operationKey(args: {
      stepKey: string;
      targetId: string | null;
      planRevision: number;
      ordinal: number;
      /** NEW (R1). The EFFECT's tool name. Absent → the recipe's own key. */
      toolName?: string;
    }): string;
  }

  // recipes/resolveNextStep.ts
  export type NextStepResolution =
    | { ok: true; key: string }
    | { ok: false; reason: 'no_next_declared' | 'terminal_step' | 'unknown_step' | 'resolver_threw'; detail: string };
  export function resolveDeterministicNextStep(
    recipe: RecipeDefinition<never>,
    stepKey: string,
    ctx: NextStepContext,
  ): NextStepResolution;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/recipes/resolveNextStep.test.ts
/**
 * The ONE resolver for `StepDefinition.next` (Recipe Library spec §6.3's
 * deterministic spine).
 *
 * `next` answers a different question from `permittedNextSteps`. The latter is
 * the set a MODEL may propose from a `reason` step; this is what the SERVER
 * does when a non-reason step settles. Conflating them is how a deterministic
 * recipe grows a model-chosen branch, so the two never read each other and
 * this file asserts that separation directly.
 *
 * Every failure is CLASSIFIED, never guessed: a recipe that forgets a `next`
 * is a recipe bug, and the coordinator settles the task with a readable reason
 * rather than falling through to some plausible-looking step.
 */
import { describe, expect, it } from 'vitest';
import { resolveDeterministicNextStep } from './resolveNextStep';
import type { NextStepContext, RecipeDefinition } from './types';

const EMPTY_CTX: NextStepContext = { input: {}, facts: {}, readiness: {} };

function fixture(steps: RecipeDefinition<never>['steps']): RecipeDefinition<never> {
  return {
    key: 'fixture', version: 1, promptVersion: 'fixture/v1',
    gateClass: 'deterministic', targetKinds: ['contact'], requires: [],
    inputSchema: { parse: (v: unknown) => v } as never,
    steps,
    permittedNextSteps: {},
    bounds: {
      maxReasoningRuns: 1, maxMutationAttempts: 1, freshnessSeconds: 1,
      observeWakeAfterMs: 1, verificationWakeAfterMs: 1,
      unknownEffectHorizonMs: 1, deadlineMs: 1,
    },
    buildPlan: () => [],
    operationKey: () => 'fixture',
  } as unknown as RecipeDefinition<never>;
}

describe('resolveDeterministicNextStep', () => {
  it('resolves a literal successor', () => {
    const r = fixture({ a: { kind: 'probe', phase: 'plan', next: 'b' }, b: { kind: 'document', phase: 'document', terminal: true } });
    expect(resolveDeterministicNextStep(r, 'a', EMPTY_CTX)).toEqual({ ok: true, key: 'b' });
  });

  it('resolves a functional successor from facts and readiness', () => {
    const r = fixture({
      a: {
        kind: 'wait', phase: 'execute',
        next: (ctx) => (ctx.readiness['m365.graph.auto_reply'] ? 'effects' : 'manual_work'),
      },
      effects: { kind: 'effect', phase: 'execute' },
      manual_work: { kind: 'human_work', phase: 'execute' },
    });
    expect(resolveDeterministicNextStep(r, 'a', { ...EMPTY_CTX, readiness: { 'm365.graph.auto_reply': true } }))
      .toEqual({ ok: true, key: 'effects' });
    expect(resolveDeterministicNextStep(r, 'a', EMPTY_CTX)).toEqual({ ok: true, key: 'manual_work' });
  });

  it('refuses when the step declares no `next`', () => {
    const r = fixture({ a: { kind: 'probe', phase: 'plan' } });
    const res = resolveDeterministicNextStep(r, 'a', EMPTY_CTX);
    expect(res).toEqual({ ok: false, reason: 'no_next_declared', detail: expect.stringContaining("'a'") });
  });

  it('refuses on a terminal step even if it somehow declares a next', () => {
    const r = fixture({ a: { kind: 'document', phase: 'document', terminal: true, next: 'b' }, b: { kind: 'probe', phase: 'plan' } });
    expect(resolveDeterministicNextStep(r, 'a', EMPTY_CTX).ok).toBe(false);
    expect((resolveDeterministicNextStep(r, 'a', EMPTY_CTX) as { reason: string }).reason).toBe('terminal_step');
  });

  it('refuses when the resolver names a step the recipe does not declare — never invents one', () => {
    const r = fixture({ a: { kind: 'probe', phase: 'plan', next: () => 'nope' } });
    const res = resolveDeterministicNextStep(r, 'a', EMPTY_CTX) as { ok: false; reason: string; detail: string };
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown_step');
    expect(res.detail).toContain('nope');
  });

  it('refuses when the current step key itself is unknown', () => {
    expect(resolveDeterministicNextStep(fixture({}), 'ghost', EMPTY_CTX))
      .toEqual({ ok: false, reason: 'unknown_step', detail: expect.stringContaining('ghost') });
  });

  it('CONTAINS a throwing resolver instead of propagating it', () => {
    const r = fixture({ a: { kind: 'probe', phase: 'plan', next: () => { throw new Error('boom'); } } });
    const res = resolveDeterministicNextStep(r, 'a', EMPTY_CTX) as { ok: false; reason: string; detail: string };
    expect(res.reason).toBe('resolver_threw');
    expect(res.detail).toContain('boom');
    // A throw out of here would reach advanceTask and leave the BullMQ wake job
    // retrying forever against a row that can never advance.
  });

  it('never consults permittedNextSteps', () => {
    const r = fixture({ a: { kind: 'probe', phase: 'plan' } });
    (r as { permittedNextSteps: Record<string, string[]> }).permittedNextSteps = { a: ['b'] };
    expect(resolveDeterministicNextStep(r, 'a', EMPTY_CTX).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/resolveNextStep.test.ts`
Expected: FAIL — `Cannot find module './resolveNextStep'`.

- [ ] **Step 3a: Add `next` to `types.ts`**

Insert into `StepDefinition` immediately after `terminal?: boolean;`, and the two supporting types immediately above the interface:

```ts
/**
 * What a pure `next` resolver may read (R1).
 *
 * All three are READONLY and all three are server-side facts: the frozen
 * admission input, the deterministic discovery facts, and the computed
 * capability readiness map. Nothing model-authored is in here, which is what
 * keeps a `deterministic` recipe deterministic (spec §9).
 */
export interface NextStepContext {
  readonly input: unknown;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly readiness: Readonly<Record<string, boolean>>;
}

/** Pure. Same context must always yield the same step key. */
export type NextStepResolver = (ctx: NextStepContext) => string;
```

```ts
  /**
   * The step that deterministically follows this one (R1).
   *
   * OPTIONAL AND ADDITIVE. `service_recovery` declares none and is unaffected.
   *
   * This is NOT `permittedNextSteps`. That map is the set the MODEL may
   * propose from a `reason` step, and it stays exactly what it is. `next` is
   * what the COORDINATOR does when a non-`reason` step settles: it resolves
   * this, writes it into the task checkpoint's `resumeStepKey` (E3), and the
   * generic advancers pick it up. A deterministic recipe's spine therefore
   * lives in one file — the recipe — rather than as `if` chains in
   * `taskCoordinator.ts`.
   */
  next?: string | NextStepResolver;
```

- [ ] **Step 3b: Add `CapabilityRequirement.availability` to `types.ts`**

Immediately above `CapabilityRequirement`:

```ts
/**
 * Whether a missing capability is something the TENANT can fix (R1).
 *
 *  - `tenant_fixable` — connect a provider, re-consent Microsoft 365 to the
 *    current profile version, add the recipe's tools to the helpdesk agent's
 *    allowlist. There is an action a technician or a customer can take, so a
 *    recipe missing one is `setup_required` and the card links to the fix.
 *  - `always_manual` — Breeze does not automate this yet. Nothing anyone can
 *    do would make it satisfied, so it must NOT hold a recipe at
 *    `setup_required` forever: a fully-consented org would read "setup
 *    required" permanently, which trains technicians to ignore the badge and
 *    misstates whose problem it is. The recipe reads `ready` and the card says
 *    how many steps are done by hand.
 *
 * Absent means `tenant_fixable`, which is the SAFE default: a capability
 * nobody classified is assumed fixable and therefore blocking, so forgetting
 * the field can only ever over-report setup, never under-report it.
 */
export const CAPABILITY_AVAILABILITIES = Object.freeze(['tenant_fixable', 'always_manual'] as const);
export type CapabilityAvailability = (typeof CAPABILITY_AVAILABILITIES)[number];
```

and into the interface, after `toolNames?`:

```ts
  /** Absent means `tenant_fixable`. See CapabilityAvailability. */
  availability?: CapabilityAvailability;
```

- [ ] **Step 3c: Add `toolName` to `operationKey`'s argument, and pass it through**

An `effect` step's operation identity is **one operation per external effect** (spec §6.3, §6.5, §6.6), so the key's tool segment must be the effect's tool — and E4 already builds it that way. Verified in W04's plan, Task 11 Step 3, quoted verbatim:

> **Build the operation key** with `buildTaskOperationKey({ taskStepKey: stepKey, planRevision: task.revision, toolName: effect.toolName, targetId: effect.targetId, ordinal: effect.ordinal })` — `operationKey.ts:52`, format `step:tool:target:r<rev>:n<ordinal>`.

and W04 Task 8's `planOrdinalFromOperationKey` is the single parser of that same format's trailing `n<N>` segment. E1's `RecipeDefinition.operationKey` argument object has **no** `toolName`, so without this field a recipe could not name the operation E4's dispatcher builds. Add it, optional:

```ts
  /**
   * Delegates to `buildTaskOperationKey`; never formats its own string.
   *
   * `toolName` (R1, optional) is the EFFECT's tool name, giving the
   * one-operation-per-external-effect identity `effectDispatch.ts` already
   * builds (W04 Task 11 Step 3). Absent — the shipped `service_recovery`
   * shape — means the recipe supplies its own.
   */
  operationKey(args: {
    stepKey: string;
    targetId: string | null;
    planRevision: number;
    ordinal: number;
    toolName?: string;
  }): string;
```

`serviceRecovery.ts`'s `operationKey` gains **one line**: `toolName: args.toolName ?? '<its current literal>'`. Read the real literal at its definition site first (`grep -n "buildTaskOperationKey" apps/api/src/services/aiOperator/recipes/serviceRecovery.ts`) and keep the absent-argument output byte-identical — `serviceRecoveryOperationKey`'s exported signature is unchanged and its shipped test pins the string, so any drift fails `serviceRecovery.test.ts` on the next run.

- [ ] **Step 4: Write `resolveNextStep.ts`**

```ts
// apps/api/src/services/aiOperator/recipes/resolveNextStep.ts
/**
 * The single resolver for `StepDefinition.next` (spec §6.3).
 *
 * PURE — this file lives inside `recipes/` and is scanned by `purity.test.ts`.
 * It imports types only.
 *
 * Every outcome is classified. There is deliberately no fallback branch that
 * picks a "reasonable" step: a recipe that forgot a `next` is a recipe bug,
 * and the coordinator's answer to a recipe bug is `settle(fail, unresolved)`
 * with the reason in the detail — never a guess that dispatches an effect
 * nobody wrote down.
 */
import type { NextStepContext, RecipeDefinition } from './types';

export type NextStepResolution =
  | { ok: true; key: string }
  | {
    ok: false;
    reason: 'no_next_declared' | 'terminal_step' | 'unknown_step' | 'resolver_threw';
    detail: string;
  };

export function resolveDeterministicNextStep(
  recipe: RecipeDefinition<never>,
  stepKey: string,
  ctx: NextStepContext,
): NextStepResolution {
  const step = Object.hasOwn(recipe.steps, stepKey) ? recipe.steps[stepKey] : undefined;
  if (!step) {
    return { ok: false, reason: 'unknown_step', detail: `${recipe.key} does not declare a step '${stepKey}'` };
  }
  if (step.terminal) {
    return { ok: false, reason: 'terminal_step', detail: `step '${stepKey}' of ${recipe.key} is terminal` };
  }
  if (step.next === undefined) {
    return { ok: false, reason: 'no_next_declared', detail: `step '${stepKey}' of ${recipe.key} declares no deterministic next step` };
  }

  let candidate: string;
  if (typeof step.next === 'string') {
    candidate = step.next;
  } else {
    try {
      candidate = step.next(ctx);
    } catch (err) {
      return {
        ok: false,
        reason: 'resolver_threw',
        detail: `next resolver for '${stepKey}' of ${recipe.key} threw: ${(err as Error).message}`,
      };
    }
  }

  if (typeof candidate !== 'string' || !Object.hasOwn(recipe.steps, candidate)) {
    return {
      ok: false,
      reason: 'unknown_step',
      detail: `next resolver for '${stepKey}' of ${recipe.key} named '${String(candidate)}', which the recipe does not declare`,
    };
  }
  return { ok: true, key: candidate };
}
```

- [ ] **Step 5: Prove `service_recovery` is untouched**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/serviceRecovery.test.ts src/services/aiOperator/recipes/types.test.ts src/services/aiOperator/recipes/purity.test.ts src/services/aiOperator/recipes/index.test.ts src/services/aiOperator/recipes/resolveNextStep.test.ts`
Expected: PASS — 5 files. `serviceRecovery.test.ts` is **not edited by this wave**; if it needs editing, the field was not additive and the change is wrong.

Then add one case to `types.test.ts`:

```ts
  it('service_recovery declares no deterministic `next` on any step (R1 additive-field proof)', () => {
    for (const [key, step] of Object.entries(serviceRecoveryRecipe.steps)) {
      expect(step.next, `service_recovery.${key} must not declare next`).toBeUndefined();
    }
  });

  it('an unclassified capability defaults to tenant_fixable — the blocking, safe reading', () => {
    // Asserted on the TYPE's default rather than on a recipe, because the
    // consequence of the default is which way an unclassified capability
    // pushes readiness, and getting that backwards would silently mark a
    // fixable setup gap as a permanent product gap.
    expect(CAPABILITY_AVAILABILITIES).toEqual(['tenant_fixable', 'always_manual']);
    for (const cap of serviceRecoveryRecipe.requires) {
      expect(cap.availability ?? 'tenant_fixable').toBe('tenant_fixable');
    }
  });

  it('service_recovery.operationKey is byte-identical with and without the new toolName arg', () => {
    const base = { stepKey: 'execute', targetId: 'device-1', planRevision: 2, ordinal: 0 };
    expect(serviceRecoveryRecipe.operationKey(base))
      .toBe(serviceRecoveryRecipe.operationKey({ ...base, toolName: undefined }));
    // And the new argument, when supplied, actually reaches the key — a
    // pass-through that silently dropped it would let R1's recipe and E4's
    // dispatcher disagree about an operation's identity, which is the one
    // thing the permanent (org_id, task_id, operation_key) index rests on.
    expect(serviceRecoveryRecipe.operationKey({ ...base, toolName: 'zzz_probe' })).toContain('zzz_probe');
  });
```

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/types.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: clean.

```
git add apps/api/src/services/aiOperator/recipes/
git commit -m "$(cat <<'EOF'
feat(api): three additive optional fields on the recipe contract (R1)

- StepDefinition.next: deterministic spine sequencing is recipe data.
  permittedNextSteps keeps its meaning (the model-proposal set); `next` is what
  the coordinator resolves when a non-reason step settles, persisted as E3's
  checkpoint resumeStepKey.
- CapabilityRequirement.availability: tenant_fixable vs always_manual, so a
  product gap cannot hold a fully-consented org at setup_required forever.
  Absent defaults to tenant_fixable, the blocking reading.
- operationKey's optional toolName, so a recipe names the same
  one-operation-per-effect identity effectDispatch.ts already builds.

service_recovery declares none of the first two, its operationKey output is
byte-identical without the third, and its suites are unmodified.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Shared contracts — the offboarding input, the reason-step outputs, and the two generalized schemas

**Files:**
- Create: `packages/shared/src/types/aiOperatorRecipes.ts`
- Create: `packages/shared/src/validators/aiOperatorIdentity.ts`
- Create: `packages/shared/src/validators/aiOperatorIdentity.test.ts`
- Modify: `packages/shared/src/validators/aiOperator.ts`
- Modify: `packages/shared/src/index.ts` (or the barrel that already re-exports `validators/aiOperator`)

**Interfaces:**
- Produces:
  ```ts
  // packages/shared/src/types/aiOperatorRecipes.ts
  export const AI_OPERATOR_RECIPE_READINESS_STATES = ['ready', 'setup_required', 'unavailable'] as const;
  export type AiOperatorRecipeReadinessState = (typeof AI_OPERATOR_RECIPE_READINESS_STATES)[number];
  export const AI_OPERATOR_CAPABILITY_KINDS = ['provider_connection', 'permission_grant', 'tool_source', 'agent_tool'] as const;
  export type AiOperatorCapabilityKind = (typeof AI_OPERATOR_CAPABILITY_KINDS)[number];
  export interface AiOperatorCapabilityActionDto {
    kind: 'reconsent_m365' | 'connect_google' | 'connect_m365' | 'add_agent_tools' | 'none';
    href: string | null;
    toolNames: string[];
    agentId: string | null;
  }
  export const AI_OPERATOR_CAPABILITY_AVAILABILITIES = ['tenant_fixable', 'always_manual'] as const;
  export type AiOperatorCapabilityAvailability = (typeof AI_OPERATOR_CAPABILITY_AVAILABILITIES)[number];
  export interface AiOperatorMissingCapabilityDto {
    key: string;
    kind: AiOperatorCapabilityKind;
    provider: 'breeze' | 'm365' | 'google' | null;
    detail: string;
    /** True when the effects behind it degrade to human work instead of blocking. */
    degradesToHumanWork: boolean;
    /** `always_manual` never contributes to `setup_required`. */
    availability: AiOperatorCapabilityAvailability;
    action: AiOperatorCapabilityActionDto;
  }
  export interface AiOperatorWorkflowDto {
    recipeKey: string;
    recipeVersion: number;
    name: string;
    summary: string;
    gateClass: 'deterministic' | 'model_chooses_effect';
    targetKinds: string[];
    readiness: AiOperatorRecipeReadinessState;
    /** ONLY `tenant_fixable` gaps. This is what drives the setup badge. */
    missingCapabilities: AiOperatorMissingCapabilityDto[];
    /** Product gaps — reported separately so they never read as "setup required". */
    alwaysManualCapabilities: AiOperatorMissingCapabilityDto[];
    /** `alwaysManualCapabilities.length`, for the card's "N steps done by hand". */
    manualStepCount: number;
    /** Effect tool names that will be rendered as human-work for this org. */
    degradedEffects: string[];
    agentId: string | null;
    agentKind: string | null;
  }

  // packages/shared/src/validators/aiOperatorIdentity.ts
  export const IDENTITY_OFFBOARDING_EFFECT_TOGGLES: readonly string[];
  export const identityOffboardingInputSchema: z.ZodType<IdentityOffboardingInput>;
  export type IdentityOffboardingInput = { … };            // see Step 3
  export const identityIntakeOutputSchema: z.ZodType<…>;    // confirm_identity's inputSchema
  export const identityReviewOutputSchema: z.ZodType<…>;    // plan_approval's inputSchema
  export const IDENTITY_REVIEW_FLAGS: readonly [...];
  export const IDENTITY_EXCEPTION_CLASSES = ['retry', 'human_work', 'handoff'] as const;

  // packages/shared/src/validators/aiOperator.ts — MODIFIED
  export const operatorTaskDraftSchema: z.ZodType<…>;
  // taskCheckpointSchema: recipeInput union + discoveryStepId + effectCursor + manualWorkCursor
  // createOperatorTaskSchema: deviceId optional, inputs generic record
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/validators/aiOperatorIdentity.test.ts
/**
 * The offboarding wire contract (Recipe Library spec §6.3, §6.2).
 *
 * Three properties carry this file and each has cases below:
 *
 *  1. A person is named EXACTLY ONE way — a contact id or a free-text hint,
 *     never both and never neither. "Both" is the shape where a UI bug sends a
 *     stale hint beside a corrected id and the server has to guess which one
 *     the technician meant; the answer to that is 400, not a coin toss.
 *  2. Every per-effect toggle has a SAFE DEFAULT, and the safe default for a
 *     destructive effect is ON only where leaving it off is what harms (mail
 *     routing), OFF where doing it is what harms (mobile wipe).
 *  3. `confirm_identity` accepts only ids; `plan_approval` accepts only flags
 *     from a CLOSED enum and exception classes from a three-value union. A
 *     model that returns free text at either step is refused, because a
 *     `deterministic` gate class means model output is "only ids, flags, and
 *     prose, all server-validated" (spec §9).
 */
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_EXCEPTION_CLASSES,
  IDENTITY_REVIEW_FLAGS,
  identityIntakeOutputSchema,
  identityOffboardingInputSchema,
  identityReviewOutputSchema,
} from './aiOperatorIdentity';

const CONTACT = '00000000-0000-4000-8000-000000000001';
const DEVICE = '00000000-0000-4000-8000-0000000000d1';

describe('identityOffboardingInputSchema — who is being offboarded', () => {
  it('accepts a contact id alone', () => {
    const v = identityOffboardingInputSchema.parse({ contactId: CONTACT });
    expect(v.contactId).toBe(CONTACT);
    expect(v.personHint).toBeNull();
  });

  it('accepts a free-text person hint alone', () => {
    const v = identityOffboardingInputSchema.parse({ personHint: 'Dana in accounting' });
    expect(v.contactId).toBeNull();
    expect(v.personHint).toBe('Dana in accounting');
  });

  it('REFUSES both together', () => {
    expect(() => identityOffboardingInputSchema.parse({ contactId: CONTACT, personHint: 'Dana' })).toThrow();
  });

  it('REFUSES neither', () => {
    expect(() => identityOffboardingInputSchema.parse({})).toThrow();
  });
});

describe('identityOffboardingInputSchema — safe defaults (spec §6.3)', () => {
  const base = { contactId: CONTACT };

  it('defaults mail continuity ON: auto-reply and forwarding', () => {
    const v = identityOffboardingInputSchema.parse(base);
    expect(v.effects.autoReply).toBe(true);
    expect(v.effects.forwarding).toBe(true);
  });

  it('defaults access removal ON: groups, licences, sessions, disable', () => {
    const v = identityOffboardingInputSchema.parse(base);
    expect(v.effects.removeGroups).toBe(true);
    expect(v.effects.removeLicenses).toBe(true);
    expect(v.effects.revokeSessions).toBe(true);
    expect(v.effects.disableAccount).toBe(true);
  });

  it('defaults the MOBILE ACCOUNT WIPE OFF — a phone is usually personal property', () => {
    expect(identityOffboardingInputSchema.parse(base).effects.wipeMobile).toBe(false);
  });

  it('defaults mailbox delegation OFF and keepMailbox FALSE', () => {
    const v = identityOffboardingInputSchema.parse(base);
    expect(v.effects.mailDelegate).toBe(false);
    expect(v.keepMailbox).toBe(false);
  });

  it('requires an inheritor when forwarding or delegation is on', () => {
    expect(() => identityOffboardingInputSchema.parse({ ...base, effects: { forwarding: true } })).not.toThrow();
    // forwarding defaults on and is satisfied by forwardTo OR inheritorContactId;
    // with neither, the recipe degrades the effect — it is NOT a schema error,
    // because a technician who does not know the inheritor yet must still be
    // able to start the task and answer at confirm_identity.
    const v = identityOffboardingInputSchema.parse(base);
    expect(v.forwardTo).toBeNull();
    expect(v.inheritorContactId).toBeNull();
  });

  it('REFUSES an inheritor supplied two ways at once', () => {
    expect(() => identityOffboardingInputSchema.parse({
      ...base, inheritorContactId: CONTACT, forwardTo: 'sam@customer.example',
    })).toThrow();
  });

  it('bounds the auto-reply message and refuses an empty one', () => {
    expect(() => identityOffboardingInputSchema.parse({ ...base, autoReplyMessage: '' })).toThrow();
    expect(() => identityOffboardingInputSchema.parse({ ...base, autoReplyMessage: 'x'.repeat(4001) })).toThrow();
    expect(identityOffboardingInputSchema.parse({ ...base, autoReplyMessage: 'Dana has left.' }).autoReplyMessage)
      .toBe('Dana has left.');
  });

  it('accepts an optional ISO cutoff and refuses a non-ISO one', () => {
    expect(identityOffboardingInputSchema.parse({ ...base, cutoffAt: '2026-10-23T17:00:00.000Z' }).cutoffAt)
      .toBe('2026-10-23T17:00:00.000Z');
    expect(() => identityOffboardingInputSchema.parse({ ...base, cutoffAt: 'friday' })).toThrow();
  });

  it('accepts a bounded, explicit device list and defaults it empty', () => {
    expect(identityOffboardingInputSchema.parse(base).deviceIds).toEqual([]);
    expect(identityOffboardingInputSchema.parse({ ...base, deviceIds: [DEVICE] }).deviceIds).toEqual([DEVICE]);
    expect(() => identityOffboardingInputSchema.parse({ ...base, deviceIds: Array(11).fill(DEVICE) })).toThrow();
  });

  it('is strict — an unknown key is a 400, not a silently ignored field', () => {
    expect(() => identityOffboardingInputSchema.parse({ ...base, skipConfirmIdentity: true })).toThrow();
  });
});

describe('identityIntakeOutputSchema — the model returns IDS, never a decision', () => {
  it('accepts a bounded candidate list', () => {
    const v = identityIntakeOutputSchema.parse({
      candidateContactIds: [CONTACT],
      ambiguous: false,
      rationale: 'Exact email match on dana@customer.example.',
    });
    expect(v.candidateContactIds).toEqual([CONTACT]);
  });

  it('refuses more than five candidates — a list that long is an unanswered question', () => {
    expect(() => identityIntakeOutputSchema.parse({
      candidateContactIds: Array(6).fill(CONTACT), ambiguous: true, rationale: 'x',
    })).toThrow();
  });

  it('refuses a non-uuid candidate', () => {
    expect(() => identityIntakeOutputSchema.parse({ candidateContactIds: ['dana'], ambiguous: false, rationale: 'x' })).toThrow();
  });

  it('carries NO chosen contact, NO account ids and NO effect toggles', () => {
    expect(() => identityIntakeOutputSchema.parse({
      candidateContactIds: [CONTACT], ambiguous: false, rationale: 'x', chosenContactId: CONTACT,
    })).toThrow();
    expect(() => identityIntakeOutputSchema.parse({
      candidateContactIds: [CONTACT], ambiguous: false, rationale: 'x', effects: { disableAccount: false },
    })).toThrow();
  });
});

describe('identityReviewOutputSchema — flags from a CLOSED enum, exceptions in three classes', () => {
  it('accepts a known flag with its subject', () => {
    const v = identityReviewOutputSchema.parse({
      flags: [{ code: 'sole_group_owner', subject: 'All Staff', detail: 'Dana is the only owner.' }],
      exceptions: [],
      summary: 'One ownership issue.',
    });
    expect(v.flags[0]!.code).toBe('sole_group_owner');
  });

  it('REFUSES a flag code outside the enum', () => {
    expect(() => identityReviewOutputSchema.parse({
      flags: [{ code: 'looks_fishy', subject: 'x', detail: 'y' }], exceptions: [], summary: 's',
    })).toThrow();
  });

  it('classifies an exception into exactly retry | human_work | handoff', () => {
    expect(IDENTITY_EXCEPTION_CLASSES).toEqual(['retry', 'human_work', 'handoff']);
    for (const klass of IDENTITY_EXCEPTION_CLASSES) {
      expect(identityReviewOutputSchema.parse({
        flags: [], exceptions: [{ toolName: 'google_remove_license', classification: klass, detail: 'd' }], summary: 's',
      }).exceptions[0]!.classification).toBe(klass);
    }
    expect(() => identityReviewOutputSchema.parse({
      flags: [], exceptions: [{ toolName: 'google_remove_license', classification: 'ignore', detail: 'd' }], summary: 's',
    })).toThrow();
  });

  it('carries no effect list — the model never edits the plan', () => {
    expect(() => identityReviewOutputSchema.parse({ flags: [], exceptions: [], summary: 's', effects: [] })).toThrow();
  });

  it('exposes the flag enum for the recipe and the UI to share', () => {
    expect([...IDENTITY_REVIEW_FLAGS]).toEqual([
      'sole_group_owner', 'dynamic_group_membership', 'role_assignable_group',
      'shared_mailbox_risk', 'service_account_suspected', 'license_orphans_mailbox',
      'no_mail_destination', 'unverified_forward_address',
    ]);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd packages/shared && npx vitest run src/validators/aiOperatorIdentity.test.ts`
Expected: FAIL — `Cannot find module './aiOperatorIdentity'`.

- [ ] **Step 3: Write `packages/shared/src/validators/aiOperatorIdentity.ts`**

```ts
import { z } from 'zod';

/**
 * `identity_offboarding`'s wire contracts (Recipe Library spec §6.2, §6.3).
 *
 * This file is in `packages/shared` because three consumers need the same
 * objects: the API's recipe (which freezes the input at admission), the web
 * start form, and the eval corpus. It holds NO logic — the ordering contract,
 * the effect catalog and the degradation rules all live in the recipe, which
 * is the only place that may know them.
 */

const uuid = z.string().uuid();

/**
 * Per-effect toggles.
 *
 * The default of each is the answer to "which way round is the DAMAGE if the
 * technician never looks at this switch?".
 *
 *  - Mail continuity (autoReply, forwarding): default ON. Leaving a departed
 *    person's mail silently unrouted is the failure an MSP gets a complaint
 *    about, and neither effect destroys anything.
 *  - Access removal (removeGroups, removeLicenses, revokeSessions,
 *    disableAccount): default ON. This is the outcome the recipe exists to
 *    prove; a leaver who can still sign in is the failure spec §3 names.
 *  - mailDelegate: default OFF. Granting a second person full read of a
 *    mailbox is a data-access decision with a legal dimension, and it must be
 *    chosen, never inherited from a default.
 *  - wipeMobile: default OFF. The device is very often the person's own
 *    property. Even the SELECTIVE wipe removes their work mail from a phone
 *    they own, and an MSP should say so out loud before doing it.
 */
export const identityOffboardingEffectsSchema = z.object({
  autoReply: z.boolean().default(true),
  forwarding: z.boolean().default(true),
  mailDelegate: z.boolean().default(false),
  removeGroups: z.boolean().default(true),
  removeLicenses: z.boolean().default(true),
  revokeSessions: z.boolean().default(true),
  wipeMobile: z.boolean().default(false),
  disableAccount: z.boolean().default(true),
}).strict();

export const IDENTITY_OFFBOARDING_EFFECT_TOGGLES = Object.freeze([
  'autoReply', 'forwarding', 'mailDelegate', 'removeGroups',
  'removeLicenses', 'revokeSessions', 'wipeMobile', 'disableAccount',
] as const);

export const identityOffboardingInputSchema = z.object({
  /** The resolved person, when the technician already knows who they mean. */
  contactId: uuid.nullable().default(null),
  /** Free text for the `intake` reason step to resolve. Never used as a target. */
  personHint: z.string().min(1).max(200).nullable().default(null),

  /** Who inherits the mail — a contact, or a raw address, never both. */
  inheritorContactId: uuid.nullable().default(null),
  forwardTo: z.string().email().max(320).nullable().default(null),

  autoReplyMessage: z.string().min(1).max(4000).nullable().default(null),
  /** The scheduled last-day cutoff. Absent means "start now". */
  cutoffAt: z.string().datetime().nullable().default(null),

  /**
   * Keep the mailbox after the licence comes off. On M365 this makes licence
   * removal depend on a shared-mailbox conversion that has no Graph API
   * (spec §7.3), so the recipe inserts a mandatory human-work step BEFORE the
   * licence effect. See the recipe's ordering contract.
   */
  keepMailbox: z.boolean().default(false),

  /**
   * Breeze devices the technician explicitly selected. There is no device ↔
   * person link in this schema (`devices.last_user` is an unvalidated OS
   * username string), so this list is never derived — it is chosen.
   */
  deviceIds: z.array(uuid).max(10).default([]),

  effects: identityOffboardingEffectsSchema.default({}),
}).strict()
  .superRefine((v, ctx) => {
    const named = [v.contactId, v.personHint].filter((x) => x !== null).length;
    if (named !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contactId'],
        message: 'Provide exactly one of contactId or personHint.',
      });
    }
    if (v.inheritorContactId !== null && v.forwardTo !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['forwardTo'],
        message: 'Provide at most one of inheritorContactId or forwardTo.',
      });
    }
  });
export type IdentityOffboardingInput = z.infer<typeof identityOffboardingInputSchema>;

/**
 * `intake`'s output — what the model may propose into `confirm_identity`.
 *
 * IDS AND PROSE ONLY. There is deliberately no `chosenContactId`: the model
 * proposes candidates and a HUMAN confirms one (spec §11, risk row 1, and
 * §6.2 "Output is candidate ids; the technician confirms"). `.strict()` is
 * what makes an added field a refusal rather than an ignored one.
 */
export const identityIntakeOutputSchema = z.object({
  candidateContactIds: z.array(uuid).min(0).max(5),
  ambiguous: z.boolean(),
  rationale: z.string().min(1).max(1000),
}).strict();
export type IdentityIntakeOutput = z.infer<typeof identityIntakeOutputSchema>;

/** The CLOSED set of things `review` may flag. Anything else is prose in `summary`. */
export const IDENTITY_REVIEW_FLAGS = Object.freeze([
  'sole_group_owner',
  'dynamic_group_membership',
  'role_assignable_group',
  'shared_mailbox_risk',
  'service_account_suspected',
  'license_orphans_mailbox',
  'no_mail_destination',
  'unverified_forward_address',
] as const);
export type IdentityReviewFlag = (typeof IDENTITY_REVIEW_FLAGS)[number];

export const IDENTITY_EXCEPTION_CLASSES = Object.freeze(['retry', 'human_work', 'handoff'] as const);
export type IdentityExceptionClass = (typeof IDENTITY_EXCEPTION_CLASSES)[number];

/**
 * `review`'s output — what the model may propose into `plan_approval`.
 *
 * Flags come from the closed enum above so the recipe can act on them
 * mechanically (each one maps to a generated human-work item or a plan
 * exclusion, in the recipe, not here). Exceptions are classified into the
 * three dispositions spec §6.2 item 3 permits. There is no effect list, no
 * ordinal and no argument anywhere in this object: the model never edits the
 * plan.
 */
export const identityReviewOutputSchema = z.object({
  flags: z.array(z.object({
    code: z.enum(IDENTITY_REVIEW_FLAGS),
    subject: z.string().min(1).max(320),
    detail: z.string().min(1).max(500),
  }).strict()).max(40),
  exceptions: z.array(z.object({
    toolName: z.string().min(1).max(128),
    classification: z.enum(IDENTITY_EXCEPTION_CLASSES),
    detail: z.string().min(1).max(500),
  }).strict()).max(20),
  summary: z.string().min(1).max(2000),
}).strict();
export type IdentityReviewOutput = z.infer<typeof identityReviewOutputSchema>;
```

- [ ] **Step 4: Run it green**

Run: `cd packages/shared && npx vitest run src/validators/aiOperatorIdentity.test.ts`
Expected: PASS — 1 file, 19 tests.

- [ ] **Step 5: Generalize `taskCheckpointSchema` and `createOperatorTaskSchema`**

Three edits in `packages/shared/src/validators/aiOperator.ts`. Add `import { identityOffboardingInputSchema } from './aiOperatorIdentity';` at the top.

**(a) `recipeInput` (`:187`)** — replace `recipeInput: serviceRecoveryInputSchema,` with:

```ts
  /**
   * The frozen admission input, per recipe (R1).
   *
   * A UNION, not a discriminated union: neither arm carries a recipe key, and
   * adding one would mean re-stamping every shipped checkpoint row. Both arms
   * are `.strict()`, so neither can absorb the other's object and the union is
   * unambiguous. `service_recovery` stays first so the common case parses on
   * the first arm.
   */
  recipeInput: z.union([serviceRecoveryInputSchema, identityOffboardingInputSchema]),
```

**(b) the three new bounded fields** — insert immediately before the closing `}).strict();` at `:205`:

```ts
  /**
   * The `ai_operator_task_steps` row whose `checkpoint` holds this task's
   * `IdentityDiscoveryFacts` (R1). The facts are kilobytes of groups, licences
   * and devices; keeping them off the task checkpoint keeps every coordinator
   * read cheap, and spec §5.5's export rule means the EVIDENCE artifact is the
   * bounded-text completion record, not this working state.
   */
  discoveryStepId: z.string().uuid().nullable().default(null),
  /** Next `PlannedEffect.ordinal` the `effects` step will dispatch (R1). */
  effectCursor: z.number().int().min(0).max(64).default(0),
  /** Next manual-work item index the `manual_work` step will bind a step to (R1). */
  manualWorkCursor: z.number().int().min(0).max(64).default(0),
```

**(c) `createOperatorTaskSchema` (`:234-264`)** — two field replacements; everything else, including `.strict()` and the `sourceKind`/`sourceId` refinement, is unchanged:

```ts
  /**
   * OPTIONAL since R1. `service_recovery` still sends it and the route still
   * folds it into that recipe's input, so the shipped web client is unchanged;
   * a contact-targeted recipe sends none. The route — not this schema —
   * resolves the recipe and parses `inputs` with `recipe.inputSchema`, which
   * is where per-recipe strictness lives now.
   */
  deviceId: z.string().guid().optional(),
  /**
   * Recipe-specific inputs, validated by the RECIPE (R1). Deliberately not a
   * discriminated union on `recipeKey`: that would make an unknown key a
   * generic zod 400 and undo E1's decision 6, whose whole point is a refusal
   * that names `RECIPE_KEYS`. The outer object stays `.strict()`, and every
   * recipe's own `inputSchema` is `.strict()` too, so nothing is loosened —
   * the check simply moves one layer in.
   */
  inputs: z.record(z.string(), z.unknown()),
```

**(d)** append the draft-route body validator at the end of the file:

```ts
/**
 * Body validator for `POST /api/v1/ai/operator/task-drafts` (spec §12:
 * "Interpret/validate objective and scope; returns typed reviewed proposal, no
 * operational execution"). It reuses `createOperatorTaskSchema`'s shape minus
 * the two fields that only make sense once the operator commits.
 */
export const operatorTaskDraftSchema = z.object({
  recipeKey: z.string().min(1).max(128),
  recipeVersion: z.number().int().min(1),
  orgId: z.string().guid(),
  deviceId: z.string().guid().optional(),
  inputs: z.record(z.string(), z.unknown()),
}).strict();
export type OperatorTaskDraftInput = z.infer<typeof operatorTaskDraftSchema>;
```

Add to `packages/shared/src/validators/aiOperator.test.ts` (or create if absent) four cases:

```ts
  it('taskCheckpointSchema still parses a service_recovery checkpoint unchanged', () => {
    const c = taskCheckpointSchema.parse({
      recipeInput: { deviceId: '00000000-0000-4000-8000-000000000001', serviceName: 'spooler' },
    });
    expect((c.recipeInput as { serviceName: string }).serviceName).toBe('spooler');
    expect(c.discoveryStepId).toBeNull();
    expect(c.effectCursor).toBe(0);
    expect(c.manualWorkCursor).toBe(0);
  });

  it('taskCheckpointSchema parses an identity_offboarding checkpoint', () => {
    const c = taskCheckpointSchema.parse({
      recipeInput: { contactId: '00000000-0000-4000-8000-000000000002' },
    });
    expect((c.recipeInput as { contactId: string }).contactId).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('createOperatorTaskSchema still accepts the shipped service_recovery body', () => {
    expect(() => createOperatorTaskSchema.parse({
      mode: 'live', recipeKey: 'service_recovery', recipeVersion: 1,
      orgId: '00000000-0000-4000-8000-00000000000a',
      deviceId: '00000000-0000-4000-8000-00000000000b',
      inputs: { serviceName: 'spooler' },
      clientIdempotencyKey: 'abcdefgh-1',
    })).not.toThrow();
  });

  it('createOperatorTaskSchema accepts a device-less body and STILL rejects an unknown top-level field', () => {
    expect(() => createOperatorTaskSchema.parse({
      mode: 'live', recipeKey: 'identity_offboarding', recipeVersion: 1,
      orgId: '00000000-0000-4000-8000-00000000000a',
      inputs: { contactId: '00000000-0000-4000-8000-00000000000c' },
      clientIdempotencyKey: 'abcdefgh-2',
    })).not.toThrow();
    expect(() => createOperatorTaskSchema.parse({
      mode: 'live', recipeKey: 'identity_offboarding', recipeVersion: 1,
      orgId: '00000000-0000-4000-8000-00000000000a', inputs: {},
      clientIdempotencyKey: 'abcdefgh-3', agentId: '00000000-0000-4000-8000-00000000000d',
    })).toThrow();
  });
```

- [ ] **Step 6: Write `packages/shared/src/types/aiOperatorRecipes.ts`**

Paste the `Produces` block from this task's Interfaces verbatim, with a file header naming spec §4.1 and one comment on `degradesToHumanWork`:

```ts
  /**
   * True when the recipe can still run without this capability, because every
   * effect behind it becomes a ticket checklist item with generated
   * instructions (spec §4.1: "Offboarding degrades by provider, not as a
   * whole"; §6.5). False only for a capability whose absence makes the recipe
   * `unavailable` — today, having no provider connection at all.
   *
   * ORTHOGONAL to `availability`: `degradesToHumanWork` says whether the
   * recipe can still run, `availability` says whether anyone can fix it. Every
   * `always_manual` capability degrades; so do most `tenant_fixable` ones.
   */
```

Export both new modules from the package barrel beside the existing `validators/aiOperator` export.

- [ ] **Step 7: Run green, typecheck, commit**

Run: `cd packages/shared && npx vitest run src/validators/aiOperatorIdentity.test.ts src/validators/aiOperator.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, clean.

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: clean. If `taskService.ts` or `taskCoordinator.ts` now fail on `checkpoint.recipeInput`, that is the union doing its job — narrow at the use site with the recipe key, never with a cast that erases it. Task 11 owns those sites; add a `// eslint-disable-next-line` NOWHERE — if it does not typecheck now, reorder the tasks rather than suppressing.

Run: `cd apps/api && npx vitest run src/routes/aiOperatorTasks.test.ts src/services/aiOperator/`
Expected: PASS, unchanged counts.

```
git add packages/shared/src apps/api/src
git commit -m "$(cat <<'EOF'
feat(shared): identity_offboarding wire contracts; generalize checkpoint and create-task schemas (R1)

recipeInput becomes a two-arm union; deviceId becomes optional and inputs a
record validated by the recipe, so E1's registry keeps ownership of the
unknown-recipe 400. The shipped service_recovery body and checkpoint parse
byte-identically.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `recipes/identityOffboarding.ts` — the pure recipe

**Files:**
- Create: `apps/api/src/services/aiOperator/recipes/identityOffboarding.ts`
- Create: `apps/api/src/services/aiOperator/recipes/identityOffboarding.test.ts`
- Modify: `apps/api/src/services/aiOperator/recipes/index.ts`

**Interfaces:**
- Consumes: `zod`; `identityOffboardingInputSchema`, `identityIntakeOutputSchema`, `identityReviewOutputSchema`, `IdentityOffboardingInput`, `IDENTITY_REVIEW_FLAGS` (`@breeze/shared`); `buildTaskOperationKey` (`../operationKey`); every type in `./types`. **Nothing else** — `purity.test.ts` enforces it.
- Produces:
  ```ts
  export const IDENTITY_OFFBOARDING_WORKFLOW_KEY = 'identity_offboarding' as const;
  export const IDENTITY_OFFBOARDING_WORKFLOW_VERSION = 1 as const;
  export const IDENTITY_OFFBOARDING_PROMPT_VERSION = 'identity_offboarding/v1' as const;

  export const IDENTITY_OFFBOARDING_STEP_KEYS: readonly [
    'intake', 'confirm_identity', 'discover', 'review', 'plan_approval',
    'wait_cutoff', 'effects', 'device_actions', 'manual_work', 'verify_outcome', 'document',
  ];
  export type IdentityOffboardingStepKey = (typeof IDENTITY_OFFBOARDING_STEP_KEYS)[number];

  export const EFFECT_PROVIDER_ORDER: readonly ['google', 'm365'];
  export const IDENTITY_OFFBOARDING_EFFECT_TOOLS: readonly string[];      // the CLOSED effect catalog
  export const IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS: Readonly<Record<string, string>>;
  export const IDENTITY_OFFBOARDING_BOUNDS: RecipeBounds;
  export const IDENTITY_OFFBOARDING_CAPABILITIES: readonly CapabilityRequirement[];
  export const CAPABILITY_FOR_TOOL: Readonly<Record<string, string>>;      // effect tool → capability key

  export interface IdentityManualWorkItem {
    key: string;                 // stable, e.g. 'collect_hardware'
    label: string;               // ≤ 500 chars — the checklist item's label
    detail: string;              // generated instructions
    origin: 'always' | 'capability' | 'flag' | 'discovery';
    /** The capability whose absence generated it, when origin === 'capability'. */
    capabilityKey: string | null;
  }

  export function buildIdentityOffboardingPlan(
    input: IdentityOffboardingInput,
    facts: DiscoveryFacts,
  ): PlannedEffect[];

  export function buildIdentityOffboardingManualWork(
    input: IdentityOffboardingInput,
    facts: DiscoveryFacts,
    readiness: Readonly<Record<string, boolean>>,
    reviewFlags: readonly { code: string; subject: string; detail: string }[],
  ): IdentityManualWorkItem[];

  export const identityOffboardingRecipe: RecipeDefinition<IdentityOffboardingInput>;
  ```

**The ordering contract, stated once** (spec §6.3, lifted from `googleOffboardUserAction`'s comment): within each provider block the order is **auto-reply → forwarding → mailbox delegate → group memberships → licences → mobile → sessions → disable/suspend**, and disable/suspend is last. Mailbox effects must run while the account is still active because suspension blocks Gmail impersonation, and disable/suspend is last so that **a task stopped at any point leaves an account that is more restricted than before, never one that is disabled with mail unrouted**. Provider blocks run in `EFFECT_PROVIDER_ORDER` = `['google', 'm365']` — a fixed order, not a preference, so the digest of a plan is reproducible.

**Three effects are absent from the catalog on purpose:**

| Absent | Why |
|---|---|
| `google_offboard_user` | One tool call with seven effects has one operation key; a replay re-runs all seven and "3/7 OK" has no per-effect result row (spec §6.3). |
| `google_wipe_mobile_device` | Full factory reset (D-R1-1). `google_account_wipe_mobile_device` (Task 4) is the selective effect. |
| M365 forwarding / mailbox delegation / shared-mailbox conversion | No Exchange Online executor exists (spec §7.3). Always human-work in this wave, never a planned effect. |

And `m365_remove_license` is **omitted from the plan entirely when `input.keepMailbox` is true**, replaced by a `shared_mailbox_conversion` manual item. Gating it inside the plan would need a human-work step in the middle of the effect sequence, which the step model does not express; removing the Exchange licence first starts the mailbox's deletion clock, so "not planned" is the only safe reading of the spec's gate.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/recipes/identityOffboarding.test.ts
/**
 * The `identity_offboarding` recipe, exhaustively, at the pure level.
 *
 * Everything asserted here is a property of DATA: the step graph, the closed
 * effect catalog, the argument shapes, the safety ordering, and the three
 * things the recipe must never emit. Nothing here touches a database, a
 * provider or a clock — the recipe owns no I/O (spec §6.1) and this file is
 * the proof that its behaviour is fully determined by (input, facts).
 *
 * The ORDERING PROPERTY lives in the sibling `identityOffboarding.ordering.test.ts`
 * so the two can be reasoned about separately: this file says what the plan
 * contains, that file says what every prefix of it means.
 */
import { describe, expect, it } from 'vitest';
import type { IdentityOffboardingInput } from '@breeze/shared';
import {
  CAPABILITY_FOR_TOOL,
  EFFECT_PROVIDER_ORDER,
  IDENTITY_OFFBOARDING_BOUNDS,
  IDENTITY_OFFBOARDING_CAPABILITIES,
  IDENTITY_OFFBOARDING_EFFECT_TOOLS,
  IDENTITY_OFFBOARDING_PROMPT_VERSION,
  IDENTITY_OFFBOARDING_STEP_KEYS,
  IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS,
  IDENTITY_OFFBOARDING_WORKFLOW_KEY,
  IDENTITY_OFFBOARDING_WORKFLOW_VERSION,
  buildIdentityOffboardingManualWork,
  buildIdentityOffboardingPlan,
  identityOffboardingRecipe,
} from './identityOffboarding';
import { resolveDeterministicNextStep } from './resolveNextStep';

const CONTACT = '00000000-0000-4000-8000-000000000001';
const DEVICE = '00000000-0000-4000-8000-0000000000d1';

function input(over: Partial<IdentityOffboardingInput> = {}): IdentityOffboardingInput {
  return identityOffboardingRecipe.inputSchema.parse({ contactId: CONTACT, ...over });
}

/** Both providers present, two groups each, one licence each, one phone each. */
const FULL_FACTS = Object.freeze({
  google: {
    present: true, externalId: '101', primaryEmail: 'dana@customer.example',
    groups: [
      { id: 'g1', email: 'all@customer.example', name: 'All Staff', ownership: 'shared', dynamic: false, roleAssignable: false },
      { id: 'g2', email: 'fin@customer.example', name: 'Finance', ownership: 'sole', dynamic: false, roleAssignable: false },
    ],
    licenses: [{ productId: 'Google-Apps', skuId: '1010020020', name: 'Workspace Business Standard' }],
    mobileDevices: [{ id: 'md1', model: 'Pixel 8', status: 'APPROVED' }],
  },
  m365: {
    present: true, externalId: 'e5b1…', userPrincipalName: 'dana@customer.example',
    groups: [
      { id: 'mg1', name: 'Marketing', ownership: 'unknown', dynamic: false, roleAssignable: false },
      { id: 'mg2', name: 'Dynamic All', ownership: 'unknown', dynamic: true, roleAssignable: false },
    ],
    licenses: [{ skuId: '18181a46-0d4e-45cd-891e-60aabd171b4e', skuPartNumber: 'STANDARDPACK' }],
    intuneDevices: [{ id: 'id1', deviceName: 'DANA-IPHONE' }],
  },
  breeze: { suggestedDevices: [] },
  flags: [],
} as const);

const ALL_READY: Record<string, boolean> = Object.fromEntries(
  IDENTITY_OFFBOARDING_CAPABILITIES.map((c) => [c.key, true]),
);

describe('recipe identity', () => {
  it('declares its key, version, prompt version and gate class', () => {
    expect(identityOffboardingRecipe.key).toBe('identity_offboarding');
    expect(IDENTITY_OFFBOARDING_WORKFLOW_KEY).toBe('identity_offboarding');
    expect(identityOffboardingRecipe.version).toBe(IDENTITY_OFFBOARDING_WORKFLOW_VERSION);
    expect(identityOffboardingRecipe.promptVersion).toBe(IDENTITY_OFFBOARDING_PROMPT_VERSION);
    expect(identityOffboardingRecipe.gateClass).toBe('deterministic');
  });

  it('targets a contact and a ticket, never a device alone', () => {
    expect([...identityOffboardingRecipe.targetKinds].sort()).toEqual(['contact', 'device', 'ticket']);
  });

  it('carries spec §6.7 bounds — 14 days, 6 reasoning runs, 2 mutation attempts per effect', () => {
    expect(IDENTITY_OFFBOARDING_BOUNDS.deadlineMs).toBe(14 * 24 * 60 * 60 * 1000);
    expect(IDENTITY_OFFBOARDING_BOUNDS.maxReasoningRuns).toBe(6);
    expect(IDENTITY_OFFBOARDING_BOUNDS.maxMutationAttempts).toBe(2);
    expect(identityOffboardingRecipe.bounds).toBe(IDENTITY_OFFBOARDING_BOUNDS);
  });
});

describe('the step graph (spec §6.3)', () => {
  it('declares exactly the eleven spine steps, in order', () => {
    expect([...IDENTITY_OFFBOARDING_STEP_KEYS]).toEqual([
      'intake', 'confirm_identity', 'discover', 'review', 'plan_approval',
      'wait_cutoff', 'effects', 'device_actions', 'manual_work', 'verify_outcome', 'document',
    ]);
    expect(Object.keys(identityOffboardingRecipe.steps).sort())
      .toEqual([...IDENTITY_OFFBOARDING_STEP_KEYS].sort());
  });

  it('assigns each step the kind spec §6.1s table implies', () => {
    const kinds = Object.fromEntries(
      Object.entries(identityOffboardingRecipe.steps).map(([k, s]) => [k, s.kind]),
    );
    expect(kinds).toEqual({
      intake: 'reason',
      confirm_identity: 'human_work',
      discover: 'probe',
      review: 'reason',
      plan_approval: 'probe',
      wait_cutoff: 'wait',
      effects: 'effect',
      device_actions: 'effect',
      manual_work: 'human_work',
      verify_outcome: 'probe',
      document: 'document',
    });
  });

  it('names the plan step with the `plan_` prefix E4s coordinator arm routes on', () => {
    expect(identityOffboardingRecipe.steps.plan_approval!.kind).toBe('probe');
    expect('plan_approval'.startsWith('plan_')).toBe(true);
  });

  it('makes `document` the only terminal step', () => {
    const terminal = Object.entries(identityOffboardingRecipe.steps)
      .filter(([, s]) => s.terminal).map(([k]) => k);
    expect(terminal).toEqual(['document']);
  });

  it('CANNOT REACH `discover` WITHOUT `confirm_identity` — the mandatory human confirmation', () => {
    // Two independent statements of the same rule, because this is spec §11's
    // first risk row and a single assertion is a single point of rot.
    expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'intake', {
      input: input(), facts: FULL_FACTS, readiness: ALL_READY,
    })).toEqual({ ok: true, key: 'confirm_identity' });
    // No step anywhere in the recipe names `discover` as its next EXCEPT
    // confirm_identity, and the model's permitted set never contains it.
    const namesDiscover = Object.entries(identityOffboardingRecipe.steps)
      .filter(([, s]) => s.next === 'discover').map(([k]) => k);
    expect(namesDiscover).toEqual(['confirm_identity']);
    for (const permitted of Object.values(identityOffboardingRecipe.permittedNextSteps)) {
      expect(permitted).not.toContain('discover');
    }
  });

  it('lets the model propose ONLY out of the two reason steps, and only forward', () => {
    expect(identityOffboardingRecipe.permittedNextSteps).toEqual({
      intake: ['confirm_identity'],
      review: ['plan_approval'],
    });
  });

  it('attaches the intake and review output schemas to the steps that CONSUME them', () => {
    // A reason step's output is validated against the NEXT step's inputSchema
    // through E1's validateRecipeNextStep — so the schema lives on the target.
    expect(identityOffboardingRecipe.steps.confirm_identity!.inputSchema).toBeDefined();
    expect(identityOffboardingRecipe.steps.plan_approval!.inputSchema).toBeDefined();
    expect(identityOffboardingRecipe.steps.intake!.inputSchema).toBeUndefined();
    expect(identityOffboardingRecipe.steps.effects!.inputSchema).toBeUndefined();
  });

  it('skips wait_cutoff when no cutoff was given, and takes it when one was', () => {
    const ctxNo = { input: input(), facts: FULL_FACTS, readiness: ALL_READY };
    const ctxYes = { input: input({ cutoffAt: '2026-10-23T17:00:00.000Z' }), facts: FULL_FACTS, readiness: ALL_READY };
    expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'plan_approval', ctxNo))
      .toEqual({ ok: true, key: 'effects' });
    expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'plan_approval', ctxYes))
      .toEqual({ ok: true, key: 'wait_cutoff' });
  });

  it('skips device_actions when the technician selected no devices', () => {
    expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'effects', {
      input: input(), facts: FULL_FACTS, readiness: ALL_READY,
    })).toEqual({ ok: true, key: 'manual_work' });
    expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'effects', {
      input: input({ deviceIds: [DEVICE] }), facts: FULL_FACTS, readiness: ALL_READY,
    })).toEqual({ ok: true, key: 'device_actions' });
  });

  it('never skips manual_work — the hardware step is ALWAYS human work (no device↔person link exists)', () => {
    for (const ready of [ALL_READY, {}]) {
      expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'device_actions', {
        input: input({ deviceIds: [DEVICE] }), facts: FULL_FACTS, readiness: ready,
      })).toEqual({ ok: true, key: 'manual_work' });
    }
    expect(buildIdentityOffboardingManualWork(input(), FULL_FACTS, ALL_READY, []).map((i) => i.key))
      .toContain('collect_hardware');
  });

  it('ends manual_work → verify_outcome → document', () => {
    const ctx = { input: input(), facts: FULL_FACTS, readiness: ALL_READY };
    expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'manual_work', ctx)).toEqual({ ok: true, key: 'verify_outcome' });
    expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'verify_outcome', ctx)).toEqual({ ok: true, key: 'document' });
    expect(resolveDeterministicNextStep(identityOffboardingRecipe as never, 'document', ctx).ok).toBe(false);
  });
});

describe('buildPlan — the closed effect catalog', () => {
  const plan = buildIdentityOffboardingPlan(input(), FULL_FACTS);
  const names = plan.map((e) => e.toolName);

  it('NEVER emits google_offboard_user', () => {
    expect(names).not.toContain('google_offboard_user');
    expect(IDENTITY_OFFBOARDING_EFFECT_TOOLS).not.toContain('google_offboard_user');
  });

  it('NEVER emits google_wipe_mobile_device — that tool is a FULL FACTORY RESET', () => {
    expect(names).not.toContain('google_wipe_mobile_device');
    expect(IDENTITY_OFFBOARDING_EFFECT_TOOLS).not.toContain('google_wipe_mobile_device');
  });

  it('every emitted tool is in the closed catalog', () => {
    for (const n of names) expect(IDENTITY_OFFBOARDING_EFFECT_TOOLS).toContain(n);
  });

  it('numbers ordinals densely from 0 and never repeats one', () => {
    expect(plan.map((e) => e.ordinal)).toEqual(plan.map((_, i) => i));
  });

  it('runs every Google effect before every M365 effect (EFFECT_PROVIDER_ORDER)', () => {
    expect(EFFECT_PROVIDER_ORDER).toEqual(['google', 'm365']);
    const lastGoogle = plan.map((e) => e.provider).lastIndexOf('google');
    const firstM365 = plan.map((e) => e.provider).indexOf('m365');
    expect(lastGoogle).toBeLessThan(firstM365);
  });

  it('fans group removal out to ONE effect per group, per provider', () => {
    expect(names.filter((n) => n === 'google_remove_from_group')).toHaveLength(2);
    expect(names.filter((n) => n === 'm365_remove_from_group')).toHaveLength(2);
  });

  it('fans licence removal and Intune retire out per licence / per device', () => {
    expect(names.filter((n) => n === 'google_remove_license')).toHaveLength(1);
    expect(names.filter((n) => n === 'm365_remove_license')).toHaveLength(1);
    expect(names.filter((n) => n === 'm365_retire_intune_device')).toHaveLength(1);
  });

  it('addresses every provider effect by the IMMUTABLE external id, never the UPN', () => {
    for (const e of plan) {
      if (e.provider === 'google') expect(e.accountExternalId).toBe('101');
      if (e.provider === 'm365') expect(e.accountExternalId).toBe('e5b1…');
    }
  });

  it('pins the contact as targetId on every provider effect', () => {
    for (const e of plan) expect(e.targetId).toBe(CONTACT);
  });

  it('is DETERMINISTIC — same input and facts produce an identical list', () => {
    expect(buildIdentityOffboardingPlan(input(), FULL_FACTS)).toEqual(plan);
  });

  it('emits no mobile wipe by default and one when the toggle is on', () => {
    expect(names).not.toContain('google_account_wipe_mobile_device');
    const wiped = buildIdentityOffboardingPlan(input({ effects: { wipeMobile: true } as never }), FULL_FACTS);
    expect(wiped.map((e) => e.toolName)).toContain('google_account_wipe_mobile_device');
  });

  it('omits an effect whose toggle is off, and renumbers densely', () => {
    const p = buildIdentityOffboardingPlan(input({ effects: { removeGroups: false } as never }), FULL_FACTS);
    expect(p.map((e) => e.toolName)).not.toContain('google_remove_from_group');
    expect(p.map((e) => e.ordinal)).toEqual(p.map((_, i) => i));
  });

  it('skips a whole provider block when discovery found no account there', () => {
    const googleOnly = { ...FULL_FACTS, m365: { ...FULL_FACTS.m365, present: false } };
    const p = buildIdentityOffboardingPlan(input(), googleOnly);
    expect(p.every((e) => e.provider !== 'm365')).toBe(true);
    expect(p.length).toBeGreaterThan(0);
  });

  it('emits NO M365 forwarding or mailbox-delegate effect — no Exchange executor exists (spec §7.3)', () => {
    const withDelegate = buildIdentityOffboardingPlan(
      input({ inheritorContactId: null, forwardTo: 'sam@customer.example', effects: { mailDelegate: true } as never }),
      FULL_FACTS,
    ).map((e) => `${e.provider}:${e.toolName}`);
    expect(withDelegate).toContain('google:google_set_forwarding');
    expect(withDelegate).toContain('google:google_add_mail_delegate');
    expect(withDelegate.filter((n) => n.startsWith('m365:') && /forward|delegate/.test(n))).toEqual([]);
  });

  it('OMITS m365_remove_license entirely when keepMailbox is set, and keeps google_remove_license', () => {
    const p = buildIdentityOffboardingPlan(input({ keepMailbox: true }), FULL_FACTS).map((e) => e.toolName);
    expect(p).not.toContain('m365_remove_license');
    expect(p).toContain('google_remove_license');
  });

  it('carries canonical arguments that match each tools shipped shape', () => {
    const byName = new Map(plan.map((e) => [e.toolName, e.canonicalArguments]));
    expect(byName.get('google_set_vacation')).toMatchObject({ userEmail: 'dana@customer.example', enable: true });
    expect(byName.get('google_remove_from_group')).toMatchObject({ userEmail: 'dana@customer.example', groupEmail: expect.any(String) });
    expect(byName.get('google_remove_license')).toMatchObject({ userEmail: 'dana@customer.example', productId: 'Google-Apps', skuId: '1010020020' });
    expect(byName.get('google_suspend_user')).toMatchObject({ userEmail: 'dana@customer.example' });
    expect(byName.get('m365_remove_from_group')).toMatchObject({ groupId: expect.any(String), userIdentifier: 'e5b1…' });
    expect(byName.get('m365_remove_license')).toMatchObject({ userIdentifier: 'e5b1…', skuIds: ['18181a46-0d4e-45cd-891e-60aabd171b4e'] });
    expect(byName.get('m365_retire_intune_device')).toMatchObject({ managedDeviceId: 'id1' });
    expect(byName.get('m365_disable_user')).toMatchObject({ userIdentifier: 'e5b1…' });
    for (const [, args] of byName) expect((args as { reason?: string }).reason).toBeTruthy();
  });

  it('declares google_signout unobservable and NAMES the criterion that subsumes it (spec §6.6)', () => {
    expect(IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS).toEqual({ google_signout: 'google_suspend_user' });
    const p = buildIdentityOffboardingPlan(input(), FULL_FACTS).map((e) => e.toolName);
    // Every unobservable effect's subsuming effect must itself be in the plan,
    // or the task can never reach verified_resolved (spec §6.6's last rule).
    for (const [effect, subsumer] of Object.entries(IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS)) {
      if (p.includes(effect)) expect(p).toContain(subsumer);
    }
  });
});

describe('required capabilities (spec §4.1)', () => {
  it('names a capability for every tool in the catalog', () => {
    for (const tool of IDENTITY_OFFBOARDING_EFFECT_TOOLS) {
      expect(CAPABILITY_FOR_TOOL[tool], `no capability mapped for ${tool}`).toBeTruthy();
      expect(IDENTITY_OFFBOARDING_CAPABILITIES.map((c) => c.key)).toContain(CAPABILITY_FOR_TOOL[tool]);
    }
  });

  it('declares the three Exchange capabilities as the ONLY always_manual ones', () => {
    const exchange = ['m365.exchange.forwarding', 'm365.exchange.mailbox_delegate', 'm365.exchange.shared_mailbox_conversion'];
    const keys = IDENTITY_OFFBOARDING_CAPABILITIES.map((c) => c.key);
    for (const k of exchange) {
      expect(keys).toContain(k);
      expect(IDENTITY_OFFBOARDING_CAPABILITIES.find((c) => c.key === k)!.kind).toBe('tool_source');
    }
    // Exactly these three, no more: an `always_manual` capability is invisible
    // to readiness, so mis-classifying a FIXABLE gap as always_manual would
    // hide a real "re-consent Microsoft 365" from the technician forever.
    expect(IDENTITY_OFFBOARDING_CAPABILITIES.filter((c) => c.availability === 'always_manual').map((c) => c.key).sort())
      .toEqual([...exchange].sort());
  });

  it('classifies every OTHER capability as tenant_fixable (explicitly or by default)', () => {
    for (const c of IDENTITY_OFFBOARDING_CAPABILITIES) {
      if (c.key.startsWith('m365.exchange.')) continue;
      expect(c.availability ?? 'tenant_fixable', `${c.key}`).toBe('tenant_fixable');
    }
  });

  it('declares the helpdesk agent-allowlist capability naming EVERY effect tool', () => {
    const cap = IDENTITY_OFFBOARDING_CAPABILITIES.find((c) => c.kind === 'agent_tool');
    expect(cap).toBeDefined();
    expect([...cap!.toolNames!].sort()).toEqual([...IDENTITY_OFFBOARDING_EFFECT_TOOLS].sort());
  });
});

describe('buildIdentityOffboardingManualWork (spec §6.5)', () => {
  it('always emits the three fixed items', () => {
    const keys = buildIdentityOffboardingManualWork(input(), FULL_FACTS, ALL_READY, []).map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['collect_hardware', 'transfer_file_ownership', 'update_documentation']));
  });

  it('emits M365 forwarding and delegation as human work whenever the effect was requested', () => {
    const keys = buildIdentityOffboardingManualWork(
      input({ forwardTo: 'sam@customer.example', effects: { mailDelegate: true } as never }),
      FULL_FACTS, ALL_READY, [],
    ).map((i) => i.key);
    expect(keys).toContain('m365_forwarding_manual');
    expect(keys).toContain('m365_mailbox_delegate_manual');
  });

  it('emits shared-mailbox conversion when keepMailbox is set', () => {
    expect(buildIdentityOffboardingManualWork(input({ keepMailbox: true }), FULL_FACTS, ALL_READY, []).map((i) => i.key))
      .toContain('shared_mailbox_conversion');
  });

  it('emits one item per MISSING capability, with generated instructions and the capability key', () => {
    const partial = { ...ALL_READY, 'm365.graph.intune_retire': false };
    const items = buildIdentityOffboardingManualWork(input(), FULL_FACTS, partial, []);
    const degraded = items.find((i) => i.capabilityKey === 'm365.graph.intune_retire');
    expect(degraded).toBeDefined();
    expect(degraded!.origin).toBe('capability');
    expect(degraded!.detail.length).toBeGreaterThan(20);
    expect(degraded!.label.length).toBeLessThanOrEqual(500);
  });

  it('emits an item for every UNKNOWN-ownership M365 group the plan removes (D-R1-7)', () => {
    const items = buildIdentityOffboardingManualWork(input(), FULL_FACTS, ALL_READY, []);
    expect(items.filter((i) => i.key.startsWith('confirm_m365_group_owner:'))).toHaveLength(2);
  });

  it('emits an item for a dynamic or role-assignable group instead of planning its removal', () => {
    expect(buildIdentityOffboardingPlan(input(), FULL_FACTS)
      .filter((e) => e.toolName === 'm365_remove_from_group')
      .map((e) => (e.canonicalArguments as { groupId: string }).groupId))
      .not.toContain('mg2');
    expect(buildIdentityOffboardingManualWork(input(), FULL_FACTS, ALL_READY, []).map((i) => i.key))
      .toContain('manual_group_removal:mg2');
  });

  it('turns a review flag into an item', () => {
    const items = buildIdentityOffboardingManualWork(input(), FULL_FACTS, ALL_READY, [
      { code: 'sole_group_owner', subject: 'Finance', detail: 'Dana is the only owner.' },
    ]);
    const flagged = items.filter((i) => i.origin === 'flag');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.detail).toContain('Dana is the only owner.');
  });

  it('is stable and deduplicated by key', () => {
    const items = buildIdentityOffboardingManualWork(input({ keepMailbox: true }), FULL_FACTS, {}, []);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    expect(items).toEqual(buildIdentityOffboardingManualWork(input({ keepMailbox: true }), FULL_FACTS, {}, []));
  });
});

describe('operationKey — one operation per external effect', () => {
  it('includes step, EFFECT tool, target, revision and ordinal', () => {
    const k = identityOffboardingRecipe.operationKey({
      stepKey: 'effects', targetId: CONTACT, planRevision: 3, ordinal: 4,
      toolName: 'google_suspend_user',
    });
    expect(k).toContain('effects');
    expect(k).toContain('google_suspend_user');
    expect(k).toContain('r3');
    expect(k).toContain('n4');
    expect(k.length).toBeLessThanOrEqual(200);
  });

  it('agrees BYTE FOR BYTE with what effectDispatch builds for the same effect', () => {
    // The permanent (org_id, task_id, operation_key) index is the whole replay
    // guarantee, and E4's planOrdinalFromOperationKey parses this exact format
    // back out at release. Two spellings of one identity would defeat both, so
    // this is asserted against buildTaskOperationKey directly rather than
    // against a literal.
    const effect = buildIdentityOffboardingPlan(input(), FULL_FACTS)
      .find((e) => e.toolName === 'google_suspend_user')!;
    expect(identityOffboardingRecipe.operationKey({
      stepKey: 'effects', targetId: effect.targetId, planRevision: 3,
      ordinal: effect.ordinal, toolName: effect.toolName,
    })).toBe(buildTaskOperationKey({
      taskStepKey: 'effects', planRevision: 3, toolName: effect.toolName,
      targetId: effect.targetId, ordinal: effect.ordinal,
    }));
  });

  it('gives two different effects of one step two different keys', () => {
    const plan = buildIdentityOffboardingPlan(input(), FULL_FACTS);
    const keys = plan.map((e) => identityOffboardingRecipe.operationKey({
      stepKey: 'effects', targetId: e.targetId, planRevision: 1,
      ordinal: e.ordinal, toolName: e.toolName,
    }));
    expect(new Set(keys).size).toBe(plan.length);
  });

  it('falls back to the workflow key for a step with no provider tool', () => {
    expect(identityOffboardingRecipe.operationKey({
      stepKey: 'verify_outcome', targetId: CONTACT, planRevision: 1, ordinal: 0,
    })).toContain('identity_offboarding');
  });
});

describe('registry', () => {
  it('is registered under its own key and resolves at its version', async () => {
    const { RECIPES, RECIPE_KEYS, getRecipe } = await import('./index');
    expect(RECIPE_KEYS).toContain('identity_offboarding');
    expect(RECIPES.identity_offboarding).toBe(identityOffboardingRecipe as never);
    expect(getRecipe('identity_offboarding', 1)).toBe(identityOffboardingRecipe as never);
    expect(getRecipe('identity_offboarding', 2)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/identityOffboarding.test.ts`
Expected: FAIL — `Cannot find module './identityOffboarding'`.

- [ ] **Step 3: Write the recipe**

The file is ~430 lines. Structure it in this order, with the header stating the ordering contract verbatim from the task preamble above:

1. **Imports** — `z` from `zod`; the four schemas and `IdentityOffboardingInput` from `@breeze/shared`; `buildTaskOperationKey` from `../operationKey`; the types from `./types`. Nothing else.
2. **Constants** — key, version, prompt version, `IDENTITY_OFFBOARDING_STEP_KEYS`, `EFFECT_PROVIDER_ORDER`, `IDENTITY_OFFBOARDING_EFFECT_TOOLS`, `IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS`, `IDENTITY_OFFBOARDING_BOUNDS`.
3. **`IDENTITY_OFFBOARDING_CAPABILITIES` and `CAPABILITY_FOR_TOOL`.**
4. **Fact accessors** — narrow, defensive readers over `DiscoveryFacts` (an open record), each returning `[]`/`null` rather than throwing, because facts arrive from a jsonb column and a recipe must not crash the coordinator on a shape it did not expect.
5. **`buildIdentityOffboardingPlan`.**
6. **`buildIdentityOffboardingManualWork`.**
7. **`identityOffboardingRecipe`.**

The constants:

```ts
export const IDENTITY_OFFBOARDING_WORKFLOW_KEY = 'identity_offboarding' as const;
export const IDENTITY_OFFBOARDING_WORKFLOW_VERSION = 1 as const;
/** Bump whenever `taskContextIdentity.ts`'s rendering changes (see serviceRecovery.ts:37-46). */
export const IDENTITY_OFFBOARDING_PROMPT_VERSION = 'identity_offboarding/v1' as const;

export const IDENTITY_OFFBOARDING_STEP_KEYS = Object.freeze([
  'intake', 'confirm_identity', 'discover', 'review', 'plan_approval',
  'wait_cutoff', 'effects', 'device_actions', 'manual_work', 'verify_outcome', 'document',
] as const);
export type IdentityOffboardingStepKey = (typeof IDENTITY_OFFBOARDING_STEP_KEYS)[number];

/**
 * FIXED, not a preference. `effect_set_digest` is a hash over the ordered
 * list, so a provider order that varied by org would make two identical plans
 * hash differently and every approval card unreproducible.
 */
export const EFFECT_PROVIDER_ORDER = Object.freeze(['google', 'm365'] as const);

/**
 * The CLOSED effect catalog. `buildPlan` may emit nothing else, readiness maps
 * every entry to a capability, and the agent-allowlist capability names
 * exactly this list — so widening it in one place without the others is a
 * test failure, not a silent privilege gain.
 */
export const IDENTITY_OFFBOARDING_EFFECT_TOOLS = Object.freeze([
  // Google, in safety order.
  'google_set_vacation',
  'google_set_forwarding',
  'google_add_mail_delegate',
  'google_remove_from_group',
  'google_remove_license',
  'google_account_wipe_mobile_device',
  'google_signout',
  'google_suspend_user',
  // M365, in safety order. No forwarding and no delegate: spec §7.3.
  'm365_set_auto_reply',
  'm365_remove_from_group',
  'm365_remove_license',
  'm365_retire_intune_device',
  'm365_revoke_sessions',
  'm365_disable_user',
  // Breeze device effects, only ever from input.deviceIds (D-R1-8).
  'manage_device_session',
] as const);

/**
 * Effects with no observable end state, each mapped to the effect whose
 * verified success SUBSUMES it (spec §6.6).
 *
 * `google_signout`: the Directory API exposes no session-validity field and
 * `lastLoginTime` is not one. A verified suspend makes live sessions moot, so
 * a plan containing the sign-out and a satisfied suspend may still reach
 * `verified_resolved`; a plan where the suspend is absent or unsatisfied is
 * `partial` with the sign-out listed as "dispatched, not independently
 * verifiable". `m365_revoke_sessions` is NOT here: M1 gives it a real
 * criterion (`signInSessionsValidFromDateTime >= effectRequestedAt`).
 */
export const IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS = Object.freeze({
  google_signout: 'google_suspend_user',
} as const);

/**
 * Spec §6.7. Stricter than the agent policy, never looser.
 *
 * 14 days, not the Operator's 72 h default and not `service_recovery`'s 24 h:
 * an approval can land on Monday, a cutoff can be scheduled for Friday at 5pm,
 * and a technician can be off site for a week before the laptop comes back.
 */
export const IDENTITY_OFFBOARDING_BOUNDS: RecipeBounds = Object.freeze({
  maxReasoningRuns: 6,
  maxMutationAttempts: 2,
  freshnessSeconds: 900,
  observeWakeAfterMs: 60_000,
  verificationWakeAfterMs: 120_000,
  unknownEffectHorizonMs: 60 * 60 * 1000,
  deadlineMs: 14 * 24 * 60 * 60 * 1000,
});
```

`IDENTITY_OFFBOARDING_CAPABILITIES` — fifteen entries. Provider connections first, then one `permission_grant` per M365 Graph role group, then the three Exchange `tool_source` entries, then the one `agent_tool`:

```ts
export const IDENTITY_OFFBOARDING_CAPABILITIES: readonly CapabilityRequirement[] = Object.freeze([
  { key: 'google.workspace.connection', kind: 'provider_connection', provider: 'google',
    detail: 'Connect Google Workspace for this organization.' },
  { key: 'google.tool.mail_settings', kind: 'agent_tool', provider: 'google',
    detail: 'Google mail settings (auto-reply, forwarding, delegation).',
    toolNames: ['google_set_vacation', 'google_set_forwarding', 'google_add_mail_delegate'] },
  { key: 'google.tool.group_membership_write', kind: 'agent_tool', provider: 'google',
    detail: 'Removing Google group memberships.', toolNames: ['google_remove_from_group'] },
  { key: 'google.tool.license_write', kind: 'agent_tool', provider: 'google',
    detail: 'Removing Google Workspace licences.', toolNames: ['google_remove_license'] },
  { key: 'google.tool.mobile_account_wipe', kind: 'agent_tool', provider: 'google',
    detail: 'Removing the work account from enrolled mobile devices.',
    toolNames: ['google_account_wipe_mobile_device'] },
  { key: 'google.tool.session_revoke', kind: 'agent_tool', provider: 'google',
    detail: 'Signing the person out of Google sessions.', toolNames: ['google_signout'] },
  { key: 'google.tool.suspend', kind: 'agent_tool', provider: 'google',
    detail: 'Suspending the Google account.', toolNames: ['google_suspend_user'] },

  { key: 'm365.connection', kind: 'provider_connection', provider: 'm365',
    detail: 'Connect Microsoft 365 for this organization.' },
  { key: 'm365.graph.auto_reply', kind: 'permission_grant', provider: 'm365',
    detail: 'Microsoft 365 mailbox auto-reply (MailboxSettings.ReadWrite). Re-consent Microsoft 365.',
    toolNames: ['m365_set_auto_reply'] },
  { key: 'm365.graph.group_membership_write', kind: 'permission_grant', provider: 'm365',
    detail: 'Removing Microsoft 365 group memberships (GroupMember.ReadWrite.All). Re-consent Microsoft 365.',
    toolNames: ['m365_remove_from_group'] },
  { key: 'm365.graph.license_write', kind: 'permission_grant', provider: 'm365',
    detail: 'Removing Microsoft 365 licences (User.ReadWrite.All).', toolNames: ['m365_remove_license'] },
  { key: 'm365.graph.intune_retire', kind: 'permission_grant', provider: 'm365',
    detail: 'Retiring Intune-managed devices (DeviceManagementManagedDevices.PrivilegedOperations.All). Re-consent Microsoft 365.',
    toolNames: ['m365_retire_intune_device'] },
  { key: 'm365.graph.session_revoke', kind: 'permission_grant', provider: 'm365',
    detail: 'Revoking Microsoft 365 sign-in sessions (User.ReadWrite.All).', toolNames: ['m365_revoke_sessions'] },
  { key: 'm365.graph.user_disable', kind: 'permission_grant', provider: 'm365',
    detail: 'Disabling the Microsoft 365 account (User.ReadWrite.All).', toolNames: ['m365_disable_user'] },

  // Spec §7.3: declared profile, no executor, no code path. These are the ONLY
  // THREE `always_manual` capabilities in the recipe: nothing a tenant or a
  // technician can do makes them satisfied, so they degrade to human work and
  // do NOT hold the recipe at `setup_required`. They are still declared, so
  // the library card can say "3 steps will be done by hand" in plain language
  // instead of the recipe silently omitting work the technician expected.
  //
  // WHEN M2 (the Exchange Online executor) SHIPS: flip these three to
  // `availability: 'tenant_fixable'` and nothing else changes — readiness,
  // the card, and the degradation path all already key off this one field.
  { key: 'm365.exchange.forwarding', kind: 'tool_source', provider: 'm365',
    availability: 'always_manual',
    detail: 'Microsoft 365 mailbox forwarding needs Exchange Online PowerShell, which Breeze does not automate yet. This step is done by hand.' },
  { key: 'm365.exchange.mailbox_delegate', kind: 'tool_source', provider: 'm365',
    availability: 'always_manual',
    detail: 'Microsoft 365 mailbox delegation needs Exchange Online PowerShell, which Breeze does not automate yet. This step is done by hand.' },
  { key: 'm365.exchange.shared_mailbox_conversion', kind: 'tool_source', provider: 'm365',
    availability: 'always_manual',
    detail: 'Converting a mailbox to shared needs Exchange Online PowerShell, which Breeze does not automate yet. This step is done by hand.' },

  { key: 'agent.helpdesk.tool_allowlist', kind: 'agent_tool', provider: null,
    detail: 'The helpdesk agent must be allowed to use the identity tools this recipe dispatches.',
    toolNames: [...IDENTITY_OFFBOARDING_EFFECT_TOOLS] },
]);
```

> The `google.tool.*` entries are `agent_tool` rather than `permission_grant` because Google's authority is domain-wide delegation granted once at connection time — there is no per-effect grant to observe, so the only meaningful per-effect gate is the agent's allowlist. `m365.graph.*` are `permission_grant` because M1's `m365RoleReadiness` gives a real per-role answer.

`CAPABILITY_FOR_TOOL` is derived, not hand-maintained:

```ts
export const CAPABILITY_FOR_TOOL: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    IDENTITY_OFFBOARDING_CAPABILITIES
      .filter((c) => c.key !== 'agent.helpdesk.tool_allowlist')
      .flatMap((c) => (c.toolNames ?? []).map((t) => [t, c.key])),
  ),
);
```

…plus one hand-written entry for `manage_device_session` mapping to a `breeze.device.session` capability, which is always ready when the agent's allowlist contains the tool. Add that capability to the list (kind `agent_tool`, provider `null`, `toolNames: ['manage_device_session']`) so the test's "every tool has a capability" case passes.

`buildIdentityOffboardingPlan` — one `push` helper and two provider blocks, in `EFFECT_PROVIDER_ORDER`:

```ts
export function buildIdentityOffboardingPlan(
  input: IdentityOffboardingInput,
  facts: DiscoveryFacts,
): PlannedEffect[] {
  const out: PlannedEffect[] = [];
  const reason = `Offboarding ${labelFor(input, facts)} (Breeze Operator task).`;

  const push = (
    provider: EffectProvider,
    toolName: string,
    accountExternalId: string | null,
    args: Record<string, unknown>,
  ): void => {
    out.push({
      ordinal: out.length,
      toolName,
      provider,
      targetId: input.contactId,
      accountExternalId,
      canonicalArguments: Object.freeze({ ...args, reason }),
    });
  };

  for (const provider of EFFECT_PROVIDER_ORDER) {
    if (provider === 'google') pushGoogleBlock(push, input, facts, reason);
    else pushM365Block(push, input, facts);
  }
  return out;
}
```

`pushGoogleBlock`, in the ordering contract's order, each guarded by its toggle and by `facts.google.present`:

| # | Condition | Tool | Arguments (shapes verified at `aiAgentSdkTools.ts:1004-1152`) |
|---|---|---|---|
| 1 | `effects.autoReply` | `google_set_vacation` | `{ userEmail, enable: true, subject, message }` — `message` is `input.autoReplyMessage ?? DEFAULT_AUTO_REPLY(label)`, `subject` is `'Out of office'` |
| 2 | `effects.forwarding` **and** a destination resolved | `google_set_forwarding` | `{ userEmail, forwardTo, keepCopy: false }` |
| 3 | `effects.mailDelegate` **and** a destination resolved | `google_add_mail_delegate` | `{ userEmail, delegateEmail }` |
| 4 | `effects.removeGroups`, one per group | `google_remove_from_group` | `{ userEmail, groupEmail }` |
| 5 | `effects.removeLicenses`, one per licence | `google_remove_license` | `{ userEmail, productId, skuId }` |
| 6 | `effects.wipeMobile` **and** ≥ 1 device | `google_account_wipe_mobile_device` | `{ userEmail }` |
| 7 | `effects.revokeSessions` | `google_signout` | `{ userEmail }` |
| 8 | `effects.disableAccount` | `google_suspend_user` | `{ userEmail }` |

`userEmail` is `facts.google.primaryEmail`; `accountExternalId` is `facts.google.externalId` on every one.

`pushM365Block`, guarded by `facts.m365.present`:

| # | Condition | Tool | Arguments (M1 schemas) |
|---|---|---|---|
| 1 | `effects.autoReply` | `m365_set_auto_reply` | `{ userIdentifier, status: 'alwaysEnabled', internalReplyMessage, externalReplyMessage, externalAudience: 'all' }` |
| — | forwarding / delegate | *(none — spec §7.3)* | human-work only |
| 4 | `effects.removeGroups`, per group **that is not `dynamic` and not `roleAssignable`** | `m365_remove_from_group` | `{ groupId, userIdentifier }` |
| 5 | `effects.removeLicenses` **and not `input.keepMailbox`** | `m365_remove_license` | `{ userIdentifier, skuIds: [...all discovered skuIds] }` — ONE effect, because M1's schema takes an array and `assignLicense` is one Graph call |
| 7 | `effects.wipeMobile`, one per Intune device | `m365_retire_intune_device` | `{ managedDeviceId }` |
| 8 | `effects.revokeSessions` | `m365_revoke_sessions` | `{ userIdentifier }` |
| 9 | `effects.disableAccount` | `m365_disable_user` | `{ userIdentifier }` |

`userIdentifier` is `facts.m365.externalId` — the Entra object id, **never** the UPN (spec §5.2: "immutable, never the UPN"), so a rename mid-task cannot retarget an effect.

Device effects are **not** in `buildPlan`'s provider loop: `device_actions` dispatches `manage_device_session` per `input.deviceIds` from its own advancer using the same `PlannedEffect` shape with `provider: 'breeze'` and `accountExternalId: null`. Append them after the M365 block so the ordinals are contiguous and the plan approval covers them too:

```ts
  for (const deviceId of input.deviceIds) {
    out.push({
      ordinal: out.length, toolName: 'manage_device_session', provider: 'breeze',
      targetId: deviceId, accountExternalId: null,
      canonicalArguments: Object.freeze({ deviceId, action: 'logoff', reason }),
    });
  }
```

`buildIdentityOffboardingManualWork` builds a `Map<string, IdentityManualWorkItem>` (so the dedupe and the stability the test asserts are structural) in this order: always-on items, capability degradations, Exchange-specific items, discovery-derived items, review flags. Every `detail` is a generated instruction naming what to do and where — for example:

```ts
  add({
    key: 'shared_mailbox_conversion', origin: 'capability',
    capabilityKey: 'm365.exchange.shared_mailbox_conversion',
    label: `Convert ${label}'s Microsoft 365 mailbox to a shared mailbox`,
    detail:
      'Breeze cannot do this yet — it needs Exchange Online PowerShell. In the '
      + 'Exchange admin centre open Recipients → Mailboxes, select this person, '
      + 'and choose Convert to shared mailbox. Do this BEFORE removing the '
      + 'Microsoft 365 licence: removing the licence first starts the mailbox\'s '
      + '30-day deletion clock. Breeze has deliberately left the licence in '
      + 'place for this reason.',
  });
```

`identityOffboardingRecipe` itself:

```ts
export const identityOffboardingRecipe: RecipeDefinition<IdentityOffboardingInput> = {
  key: IDENTITY_OFFBOARDING_WORKFLOW_KEY,
  version: IDENTITY_OFFBOARDING_WORKFLOW_VERSION,
  promptVersion: IDENTITY_OFFBOARDING_PROMPT_VERSION,
  gateClass: 'deterministic',
  targetKinds: ['contact', 'ticket', 'device'],
  requires: IDENTITY_OFFBOARDING_CAPABILITIES,
  inputSchema: identityOffboardingInputSchema,

  steps: Object.freeze({
    intake:           { kind: 'reason',     phase: 'investigate', next: 'confirm_identity' },
    confirm_identity: { kind: 'human_work', phase: 'investigate', inputSchema: identityIntakeOutputSchema, next: 'discover' },
    discover:         { kind: 'probe',      phase: 'plan',        next: 'review' },
    review:           { kind: 'reason',     phase: 'plan',        next: 'plan_approval' },
    plan_approval:    { kind: 'probe',      phase: 'plan',        inputSchema: identityReviewOutputSchema,
                        next: (ctx) => (hasCutoff(ctx.input) ? 'wait_cutoff' : 'effects') },
    wait_cutoff:      { kind: 'wait',       phase: 'execute',     next: 'effects' },
    effects:          { kind: 'effect',     phase: 'execute',
                        next: (ctx) => (hasDevices(ctx.input) ? 'device_actions' : 'manual_work') },
    device_actions:   { kind: 'effect',     phase: 'execute',     next: 'manual_work' },
    manual_work:      { kind: 'human_work', phase: 'execute',     next: 'verify_outcome' },
    verify_outcome:   { kind: 'probe',      phase: 'verify',      next: 'document' },
    document:         { kind: 'document',   phase: 'document',    terminal: true },
  }),

  /**
   * Sparse ON PURPOSE (E1's contract). The model proposes out of the two
   * `reason` steps and nowhere else; every other transition is
   * `StepDefinition.next`, resolved by the coordinator from server-side facts.
   * `discover` appears in NO permitted set — that is spec §11's first risk row
   * expressed as data.
   */
  permittedNextSteps: Object.freeze({
    intake: ['confirm_identity'],
    review: ['plan_approval'],
  }),

  bounds: IDENTITY_OFFBOARDING_BOUNDS,
  buildPlan: buildIdentityOffboardingPlan,

  /**
   * One operation per external effect (spec §6.3, §6.5, §6.6).
   *
   * `toolName` is the EFFECT's tool name and `ordinal` is the `PlannedEffect`
   * ordinal, so this produces byte-for-byte the key
   * `effectDispatch.dispatchPlannedEffect` builds (W04 Task 11 Step 3:
   * `buildTaskOperationKey({ taskStepKey: stepKey, planRevision: task.revision,
   * toolName: effect.toolName, targetId: effect.targetId, ordinal: effect.ordinal })`).
   * That agreement is load-bearing: the permanent
   * `ai_operator_operations_org_task_op_uq` index on
   * `(org_id, task_id, operation_key)` is the only thing making a replay a
   * no-op, and E4's `planOrdinalFromOperationKey` parses the trailing
   * `n<ordinal>` segment of this exact format back out at release. Two
   * spellings of one operation's identity would defeat both.
   *
   * The fallback to the workflow key covers the non-effect steps (`discover`,
   * `verify_outcome`), which reserve an operation but have no provider tool.
   */
  operationKey: (args) => buildTaskOperationKey({
    taskStepKey: args.stepKey,
    toolName: args.toolName ?? IDENTITY_OFFBOARDING_WORKFLOW_KEY,
    targetId: args.targetId,
    planRevision: args.planRevision,
    ordinal: args.ordinal,
  }),
};
```

Register in `recipes/index.ts`:

```ts
import { identityOffboardingRecipe } from './identityOffboarding';
…
export const RECIPES: Readonly<Record<string, RegisteredRecipe>> = Object.freeze({
  [serviceRecoveryRecipe.key]: serviceRecoveryRecipe as unknown as RegisteredRecipe,
  [identityOffboardingRecipe.key]: identityOffboardingRecipe as unknown as RegisteredRecipe,
});
```

- [ ] **Step 4: Run it green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/identityOffboarding.test.ts`
Expected: PASS — 1 file, ~45 tests.

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/purity.test.ts src/services/aiOperator/recipes/index.test.ts src/services/aiOperator/recipes/serviceRecovery.test.ts`
Expected: PASS. The purity guard now scans two more files; a red here means the recipe imported a service — move whatever it needed into `identityDiscovery.ts` or `recipeReadiness.ts`, never relax the allowlist.

Run: `cd apps/api && npx vitest run src/routes/aiOperatorTasks.test.ts`
Expected: PASS — E1's "unknown recipe names the supported keys" case now lists two keys; update the expected string in that test if it pins the list (it is E1's test, and adding a key to the list is the intended change, not a regression).

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/aiOperator/recipes/
git commit -m "$(cat <<'EOF'
feat(api): identity_offboarding recipe — pure step graph, closed effect catalog, ordered plan (R1)

Granular Google tools and the eight M1 M365 actions only. Never
google_offboard_user (one key for seven effects) and never
google_wipe_mobile_device (full factory reset). M365 forwarding, delegation
and shared-mailbox conversion are human-work: no Exchange executor exists.
google_signout is declared unobservable, subsumed by a verified suspend.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The ORDERING PROPERTY TEST — every prefix of the plan is a safe place to stop

**Files:**
- Create: `apps/api/src/services/aiOperator/recipes/identityOffboarding.ordering.test.ts`

This is spec §9(b) of the deterministic gate, and spec §11's second risk row, expressed as a property over **every prefix** rather than as a spot check on one plan. It is written as a separate file because it is the safety contract, not a behaviour test: a reviewer must be able to read it in one sitting, and a future recipe author must be able to copy it.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/recipes/identityOffboarding.ordering.test.ts
/**
 * THE ORDERING SAFETY CONTRACT (spec §6.3, §9(b), §11 risk row 2).
 *
 * A task can stop at ANY point: a deadline, a cancel, a handoff, a worker that
 * never comes back. The recipe's ordering is what makes every one of those
 * stops safe, and "safe" has a precise meaning:
 *
 *   For every prefix P of the plan, and for every provider p, the state
 *   reached by executing P must NEVER be "p's account is disabled or
 *   suspended while p's mail is unrouted".
 *
 * Equivalently: within each provider, the disable/suspend effect is preceded
 * by every mail-routing effect that provider's plan contains. That is why
 * mailbox effects run while the account is still active (suspension blocks
 * Gmail impersonation) and why disable/suspend is last.
 *
 * The second property is M365-specific: when the plan KEEPS the mailbox,
 * licence removal must never happen before the shared-mailbox conversion is
 * confirmed. Because that conversion has no Graph API (spec §7.3), the recipe
 * satisfies it by not planning the licence removal at all — so the property is
 * stated as "no m365_remove_license effect exists in any prefix", which is the
 * strongest possible form of "never precedes".
 *
 * Both properties are checked over a CROSS-PRODUCT of inputs and facts, not
 * one hand-picked plan, because the ordering bug this guards against is
 * exactly the one that appears only when some effects are toggled off and the
 * dense renumbering shifts everything.
 */
import { describe, expect, it } from 'vitest';
import type { IdentityOffboardingInput } from '@breeze/shared';
import type { PlannedEffect } from './types';
import {
  IDENTITY_OFFBOARDING_EFFECT_TOOLS,
  buildIdentityOffboardingManualWork,
  buildIdentityOffboardingPlan,
  identityOffboardingRecipe,
} from './identityOffboarding';

/** Effects that change where a person's mail GOES or how it is answered. */
const MAIL_ROUTING: Record<'google' | 'm365', readonly string[]> = {
  google: ['google_set_vacation', 'google_set_forwarding', 'google_add_mail_delegate'],
  m365: ['m365_set_auto_reply'],
};
/** The effect after which the account can no longer sign in. */
const LOCKOUT: Record<'google' | 'm365', string> = {
  google: 'google_suspend_user',
  m365: 'm365_disable_user',
};

function facts(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    google: {
      present: true, externalId: '101', primaryEmail: 'dana@customer.example',
      groups: [{ id: 'g1', email: 'all@customer.example', name: 'All', ownership: 'shared', dynamic: false, roleAssignable: false }],
      licenses: [{ productId: 'Google-Apps', skuId: '1010020020', name: 'Business Standard' }],
      mobileDevices: [{ id: 'md1', model: 'Pixel', status: 'APPROVED' }],
    },
    m365: {
      present: true, externalId: 'obj-1', userPrincipalName: 'dana@customer.example',
      groups: [{ id: 'mg1', name: 'Marketing', ownership: 'shared', dynamic: false, roleAssignable: false }],
      licenses: [{ skuId: '18181a46-0d4e-45cd-891e-60aabd171b4e', skuPartNumber: 'STANDARDPACK' }],
      intuneDevices: [{ id: 'id1', deviceName: 'DANA-IPHONE' }],
    },
    breeze: { suggestedDevices: [] },
    flags: [],
    ...over,
  };
}

/** Every combination of the eight toggles would be 256 plans; these 24 cover
 *  the dimensions that can reorder a plan: which provider is present, whether
 *  a mail destination exists, keepMailbox, and each mail/lockout toggle off. */
function cases(): Array<{ name: string; input: IdentityOffboardingInput; facts: Record<string, unknown> }> {
  const parse = (o: Record<string, unknown>): IdentityOffboardingInput =>
    identityOffboardingRecipe.inputSchema.parse({ contactId: '00000000-0000-4000-8000-000000000001', ...o });
  const dest = { forwardTo: 'sam@customer.example' };
  const out: Array<{ name: string; input: IdentityOffboardingInput; facts: Record<string, unknown> }> = [];
  const factSets: Array<[string, Record<string, unknown>]> = [
    ['both providers', facts()],
    ['google only', facts({ m365: { ...(facts().m365 as object), present: false } })],
    ['m365 only', facts({ google: { ...(facts().google as object), present: false } })],
  ];
  const inputSets: Array<[string, Record<string, unknown>]> = [
    ['defaults', {}],
    ['with destination', dest],
    ['with destination + delegate', { ...dest, effects: { mailDelegate: true } }],
    ['keepMailbox', { ...dest, keepMailbox: true }],
    ['no autoReply', { ...dest, effects: { autoReply: false } }],
    ['no forwarding', { ...dest, effects: { forwarding: false } }],
    ['no groups, no licences', { ...dest, effects: { removeGroups: false, removeLicenses: false } }],
    ['wipe mobile on', { ...dest, effects: { wipeMobile: true } }],
  ];
  for (const [fn, f] of factSets) for (const [inName, i] of inputSets) {
    out.push({ name: `${fn} / ${inName}`, input: parse(i), facts: f });
  }
  return out;
}

describe('PROPERTY: no prefix leaves an account locked out with mail unrouted', () => {
  for (const c of cases()) {
    it(`holds for ${c.name}`, () => {
      const plan = buildIdentityOffboardingPlan(c.input, c.facts);
      for (const provider of ['google', 'm365'] as const) {
        const ofProvider = plan.filter((e) => e.provider === provider);
        const plannedMail = ofProvider.filter((e) => MAIL_ROUTING[provider].includes(e.toolName));
        const lockout = ofProvider.find((e) => e.toolName === LOCKOUT[provider]);
        if (!lockout) continue;
        for (const mail of plannedMail) {
          expect(
            mail.ordinal,
            `${provider}: ${mail.toolName} (#${mail.ordinal}) must run BEFORE ${LOCKOUT[provider]} (#${lockout.ordinal})`,
          ).toBeLessThan(lockout.ordinal);
        }
        // Stated the other way round, over every prefix, so the assertion is
        // about REACHABLE STATES and not merely about two indices.
        for (let n = 0; n <= plan.length; n += 1) {
          const prefix: PlannedEffect[] = plan.slice(0, n);
          const lockedOut = prefix.some((e) => e.toolName === LOCKOUT[provider]);
          const mailDone = plannedMail.every((m) => prefix.some((e) => e.ordinal === m.ordinal));
          expect(
            !lockedOut || mailDone,
            `${provider}: prefix of length ${n} disables the account with ${plannedMail.length - prefix.filter((e) => MAIL_ROUTING[provider].includes(e.toolName)).length} mail effect(s) still pending`,
          ).toBe(true);
        }
      }
    });
  }
});

describe('PROPERTY: M365 licence removal never precedes shared-mailbox conversion', () => {
  for (const c of cases().filter((x) => (x.input as { keepMailbox: boolean }).keepMailbox)) {
    it(`holds for ${c.name}`, () => {
      const plan = buildIdentityOffboardingPlan(c.input, c.facts);
      expect(plan.map((e) => e.toolName)).not.toContain('m365_remove_license');
      const manual = buildIdentityOffboardingManualWork(c.input, c.facts, {}, []).map((i) => i.key);
      const m365Present = (c.facts.m365 as { present: boolean }).present;
      if (m365Present) expect(manual).toContain('shared_mailbox_conversion');
    });
  }

  it('DOES plan the licence removal when the mailbox is not being kept', () => {
    const c = cases().find((x) => x.name === 'both providers / with destination')!;
    expect(buildIdentityOffboardingPlan(c.input, c.facts).map((e) => e.toolName)).toContain('m365_remove_license');
  });
});

describe('PROPERTY: the catalog is closed and the ordinals are dense, for every case', () => {
  for (const c of cases()) {
    it(`holds for ${c.name}`, () => {
      const plan = buildIdentityOffboardingPlan(c.input, c.facts);
      expect(plan.map((e) => e.ordinal)).toEqual(plan.map((_, i) => i));
      for (const e of plan) expect(IDENTITY_OFFBOARDING_EFFECT_TOOLS).toContain(e.toolName);
      expect(plan.map((e) => e.toolName)).not.toContain('google_offboard_user');
      expect(plan.map((e) => e.toolName)).not.toContain('google_wipe_mobile_device');
    });
  }
});

describe('the control: the property TEST would catch a broken order', () => {
  it('fails on a deliberately reversed plan', () => {
    const c = cases()[0]!;
    const reversed = [...buildIdentityOffboardingPlan(c.input, c.facts)].reverse()
      .map((e, i) => ({ ...e, ordinal: i }));
    const mail = reversed.find((e) => e.toolName === 'google_set_vacation');
    const lock = reversed.find((e) => e.toolName === 'google_suspend_user');
    // Proves the assertion above is discriminating and not vacuously true —
    // without this, a buildPlan that emitted an empty list would pass every
    // case in this file.
    expect(mail).toBeDefined();
    expect(lock).toBeDefined();
    expect(mail!.ordinal).toBeGreaterThan(lock!.ordinal);
  });
});
```

- [ ] **Step 2: Run it red, then green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipes/identityOffboarding.ordering.test.ts`
Expected on a build where Task 3 is committed: PASS — 1 file, ~50 tests. **This is the one file in the plan whose red is proved by mutation rather than by absence**: before accepting the green, temporarily reverse the two Google blocks inside `buildIdentityOffboardingPlan`, re-run, and confirm the "no prefix leaves an account locked out" cases go red. Revert. A property test that has never failed has never been shown to discriminate.

- [ ] **Step 3: Commit**

```
git add apps/api/src/services/aiOperator/recipes/identityOffboarding.ordering.test.ts
git commit -m "$(cat <<'EOF'
test(api): ordering safety property over every prefix of the offboarding plan (R1)

For every prefix and every provider: never disabled with mail unrouted. With
keepMailbox, m365_remove_license is absent from every plan and the shared-
mailbox conversion is a human-work item. Discrimination proved by mutation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `google_account_wipe_mobile_device` — the selective account wipe as a granular tool

**Files:**
- Modify: `apps/api/src/services/aiToolsGoogle.ts`
- Modify: `apps/api/src/services/aiAgentSdkTools.ts` (`googleToolDefinitions()` + `TOOL_TIERS`)
- Modify: `apps/api/src/services/aiGuardrails.ts` (`TIER3_FOUR_EYES_TOOLS`, `TOOL_PERMISSIONS`)
- Modify: `apps/api/src/services/googleToolsHeadless.ts` (`GOOGLE_HEADLESS_ACTIONS`)
- Modify: `apps/api/src/services/aiOperator/effectProbes/google.ts`
- Modify: `apps/web/src/components/ai-risk/tierConfig.ts`
- Modify: `apps/api/src/services/aiGuardrailsTierConfig.parity.test.ts` if it enumerates
- Create: `apps/api/src/services/aiToolsGoogle.accountWipe.test.ts`

**Why (D-R1-1):** `google_wipe_mobile_device` issues `admin_remote_wipe` — a full factory reset — and its own description says *"This is NOT for offboarding"*. The selective `admin_account_wipe` branch of `wipeMobileDevices` (`aiToolsGoogle.ts:147-172`) is reachable today only through `google_offboard_user`, the composite this recipe is forbidden to call. This task lifts it into its own tool so the recipe has a correct effect to plan.

**Interfaces:**
- Consumes: `resolveWipeTarget`, `wipeMobileDevices`, `resolveContextByOrg`, `getDirectoryClient`, `normalizeGoogleError`, `errorString` — all already in `aiToolsGoogle.ts` / `googleClient.ts`.
- Produces: tool `google_account_wipe_mobile_device`; handler `googleAccountWipeMobileDeviceHandler`; headless action `googleAccountWipeMobileDeviceAction`; probe registration under the new tool name.

- [ ] **Step 1: Read the existing tool end-to-end before changing anything**

Run: `cd apps/api && grep -n "google_wipe_mobile_device\|googleWipeMobileDeviceAction\|googleWipeMobileDeviceHandler\|admin_remote_wipe\|admin_account_wipe" -r src ../web/src ../mobile/src`
Record every hit. The new tool must appear in **exactly the same set of files**, with one exception: `apps/web/src/components/ai-risk/ApprovalHistoryFeed.tsx` and `aiAgentSdk.ts`'s verb map only need an entry if the existing tool has one — check, do not assume.

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/src/services/aiToolsGoogle.accountWipe.test.ts
/**
 * `google_account_wipe_mobile_device` — the SELECTIVE wipe (D-R1-1).
 *
 * Its sibling `google_wipe_mobile_device` factory-resets the whole phone and
 * says so in its own description ("This is NOT for offboarding"). The
 * offboarding recipe needs the corporate-account-only wipe that until now
 * existed solely inside the `google_offboard_user` composite. The single most
 * important assertion in this file is the action string, because getting it
 * wrong erases a leaver's personal device.
 */
import { describe, expect, it, vi } from 'vitest';

describe('google_account_wipe_mobile_device', () => {
  it('issues admin_account_wipe — NEVER admin_remote_wipe', async () => { /* mock DirectoryClient; assert requestBody.action */ });
  it('resolves the target through resolveWipeTarget, so the device set is exact-matched to one user', async () => { /* assert users.get called, non-matching device dropped */ });
  it('reports 0 devices as a successful no-op, not an error', async () => { /* … */ });
  it('is tier 3 and four-eyes, exactly like its sibling', async () => {
    const { googleToolTiers } = await import('./aiToolsGoogle');
    const { TIER3_FOUR_EYES_TOOLS, TOOL_PERMISSIONS } = await import('./aiGuardrails');
    expect(googleToolTiers.google_account_wipe_mobile_device).toBe(3);
    expect(TIER3_FOUR_EYES_TOOLS).toContain('google_account_wipe_mobile_device');
    expect(TOOL_PERMISSIONS.google_account_wipe_mobile_device).toEqual({ resource: 'google', action: 'execute' });
  });
  it('is headless-dispatchable, which the release worker needs for a plan-approved effect', async () => {
    const { GOOGLE_HEADLESS_ACTIONS } = await import('./googleToolsHeadless');
    expect(Object.keys(GOOGLE_HEADLESS_ACTIONS)).toContain('google_account_wipe_mobile_device');
  });
  it('has an effect probe registered under its own name', async () => {
    const { listProbedTools } = await import('./aiOperator/effectProbes');
    expect(listProbedTools()).toContain('google_account_wipe_mobile_device');
  });
  it('its description does not claim to be for stolen devices', async () => { /* grep the registered description */ });
});
```

Also add one case to `googleToolsHeadless.test.ts`'s existing parity assertion — it pins `keys(GOOGLE_HEADLESS_ACTIONS) ∪ keys(GOOGLE_HEADLESS_SECRET_ACTIONS) === tier-3 googleToolTiers`, so adding the tool to `googleToolTiers` without the headless map fails there. That is the guard working; do not weaken it.

- [ ] **Step 3: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiToolsGoogle.accountWipe.test.ts`
Expected: FAIL on every case — the tool does not exist.

- [ ] **Step 4: Implement, in the same shape as the sibling**

In `aiToolsGoogle.ts`, beside `googleWipeMobileDeviceAction`/`Handler`, add the pair with `'admin_account_wipe'` and this header:

```ts
/**
 * Remove the WORK ACCOUNT and its data (mail, Drive) from every mobile device
 * enrolled to a user, leaving the device itself untouched (`admin_account_wipe`).
 *
 * This is the offboarding wipe. Its sibling `google_wipe_mobile_device` issues
 * `admin_remote_wipe`, a full factory reset, and is for a stolen or lost
 * device only. The two differ by one string and by everything that matters:
 * one removes company data from a phone the person owns, the other erases
 * their phone. Keep them separate tools so an approval card can never be
 * ambiguous about which one a technician is authorizing.
 */
```

Register with description: `"Offboarding: remove the work account and its data (mail, Drive) from every mobile device enrolled to a user. The device itself is NOT erased. Requires approval."` and shape `{ userEmail: z.string(), reason: z.string() }` — the same shape as its sibling, which is what the recipe's `canonicalArguments` produce.

In `effectProbes/google.ts`, register the SAME probe body E4 wrote for `google_wipe_mobile_device` under the new name — the observable end state is identical (`mobiledevices.list` reports `status ∈ ('WIPING','WIPED')` for every device `resolveWipeTarget` would return; empty list → `unknown`):

```ts
  registerEffectProbe('google_account_wipe_mobile_device', probeGoogleWipeMobileDevice);
```

- [ ] **Step 5: Run green and sweep**

Run: `cd apps/api && npx vitest run src/services/aiToolsGoogle.accountWipe.test.ts src/services/googleToolsHeadless.test.ts src/services/aiGuardrailsTierConfig.parity.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/aiOperator/effectProbes/`
Expected: PASS, all five. A red in `agentToolCatalog.contract.test.ts` means the tool was registered into the shared `aiTools` map without a `TOOL_CAPABILITY` entry — add the entry; the Google tools ARE agent-reachable (unlike M1's session-only M365 set, M1 Decision 2), so this one does need it.

Run: `cd apps/web && npx vitest run src/components/ai-risk/`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add apps/api/src apps/web/src/components/ai-risk
git commit -m "$(cat <<'EOF'
feat(api): google_account_wipe_mobile_device — the selective offboarding wipe (R1)

google_wipe_mobile_device is admin_remote_wipe, a full factory reset, and its
own description says it is not for offboarding. The selective
admin_account_wipe branch existed only inside the google_offboard_user
composite; the recipe needs it as a granular, individually approvable effect.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `identityDiscovery.ts` — coordinator-issued deterministic reads

**Files:**
- Create: `apps/api/src/services/aiOperator/identityDiscovery.ts`
- Create: `apps/api/src/services/aiOperator/identityDiscovery.test.ts`

**Spec §6.2, sentence 3:** *"Discovery reads are coordinator-issued tool calls, not model-chosen."* Nothing in this module consults a model, and the model never selects what is read. Its output is the `facts` argument to `buildPlan` and to every `next` resolver, so it must be **bounded** (a plan is hashed into an approval digest and rendered on a card) and **total** (a provider that errors yields `present: false` plus a flag, never a throw that fails the task).

**Interfaces:**
- Consumes: `executeM365ReadActionByOrg` (`../m365ControlPlane/readActionService`, M1); `resolveContextByOrg`, `type GoogleToolContext` (`../aiToolsGoogle`); `getDirectoryClient`, `getLicensingClient`, `normalizeGoogleError` (`../googleClient`); `db`, `runOutsideDbContext`, `withSystemDbAccessContext` (`../../db`); `devices` (`../../db/schema/devices`); `m365Connections` (`../../db/schema/m365`); `googleWorkspaceConnections` (`../../db/schema/google`).
- Produces:
  ```ts
  export const DISCOVERY_LIMITS: {
    readonly groups: 100; readonly licenses: 25; readonly mobileDevices: 25;
    readonly intuneDevices: 25; readonly suggestedDevices: 25;
  };
  export type GroupOwnership = 'sole' | 'shared' | 'none' | 'unknown';
  export interface DiscoveredGroup {
    id: string; name: string; email: string | null;
    ownership: GroupOwnership; dynamic: boolean; roleAssignable: boolean;
  }
  export interface DiscoveredLicense { productId: string | null; skuId: string; name: string | null }
  export interface DiscoveredMobileDevice { id: string; model: string | null; status: string | null }
  export interface DiscoveredSuggestedDevice {
    deviceId: string; hostname: string | null; lastUser: string | null;
    matchBasis: 'last_user_ilike';
  }
  export interface GoogleIdentityFacts {
    present: boolean; externalId: string | null; primaryEmail: string | null;
    suspended: boolean | null;
    groups: DiscoveredGroup[]; licenses: DiscoveredLicense[]; mobileDevices: DiscoveredMobileDevice[];
  }
  export interface M365IdentityFacts {
    present: boolean; externalId: string | null; userPrincipalName: string | null;
    accountEnabled: boolean | null;
    groups: DiscoveredGroup[]; licenses: DiscoveredLicense[]; intuneDevices: DiscoveredMobileDevice[];
  }
  export interface DiscoveryFlagRow { code: string; subject: string; detail: string }
  export interface IdentityDiscoveryFacts {
    version: 1;
    observedAt: string;              // ISO
    google: GoogleIdentityFacts;
    m365: M365IdentityFacts;
    breeze: { suggestedDevices: DiscoveredSuggestedDevice[] };
    /** Deterministic flags — provider errors, truncations, unknown ownership. NOT the model's. */
    flags: DiscoveryFlagRow[];
    truncated: string[];             // e.g. ['google.groups']
  }
  export interface DiscoverIdentityFactsInput {
    orgId: string;
    accounts: ReadonlyArray<{ provider: 'm365' | 'google'; externalId: string; principalLabel: string }>;
  }
  export function discoverIdentityFacts(input: DiscoverIdentityFactsInput): Promise<IdentityDiscoveryFacts>;
  ```

**What is read, and from where:**

| Fact | Source | Notes |
|---|---|---|
| M365 user (UPN, `accountEnabled`, assigned SKUs) | `executeM365ReadActionByOrg(orgId, { type: 'm365.user.get', … })` | Live Graph read, not the `m365_users` sync table — sync is stale by design (`is_stale`/`stale_since`) and a plan must be built on what Graph says now. The sync table is used only to fill `name`/`department` in the rendered prompt. |
| M365 group memberships | `m365.group.list` + `m365.group.members.list` per candidate group, capped at `DISCOVERY_LIMITS.groups` | There is no "groups for a user" read action; enumerate the org's groups and test membership. **If the shipped action list gained a `m365.user.memberOf`-style id since M1, use it and delete the enumeration** — grep `M365_INTERACTIVE_READ_ACTION_IDS` first. |
| M365 group ownership | **not available** | `ownership: 'unknown'` for every M365 group, and every unknown-ownership group whose membership the plan removes generates a human-work item (D-R1-7). |
| M365 `dynamic` / `roleAssignable` | `m365.group.get` projection fields | `groupTypes` contains `DynamicMembership`; `isAssignableToRole === true`. Matches M1's own `unsupported_group_type` pre-read, so the recipe never plans an effect the executor would refuse. |
| M365 Intune devices | `m365.intune.device.list` filtered to the user's UPN, capped | |
| M365 licences | the `assignedLicenses[].skuId` array from the user read, joined to `m365_license_skus` for `skuPartNumber` | The join is a display nicety; the plan uses the sku ids from Graph. |
| Google user | `dir.users.get({ userKey: externalId })` | `suspended`, `primaryEmail`. |
| Google groups | `dir.groups.list({ userKey })`, capped | Ownership IS available here — map the member `role` to `'sole' \| 'shared'` by re-reading the group's OWNER members when `role === 'OWNER'`, capped. |
| Google licences | `licensing.licenseAssignments.listForProductAndSku` across the known product ids, as `googleListLicensesHandler` does | |
| Google mobile devices | `dir.mobiledevices.list({ customerId: 'my_customer', query: 'email:' + primaryEmail })` with the same **local exact-match** gate `resolveWipeTarget` applies | The server query is a prefilter; the exact match is the gate. Copying that gate is not optional — without it the plan could name a device belonging to someone else. |
| Breeze devices | `SELECT id, hostname, last_user FROM devices WHERE org_id = $1 AND last_user ILIKE $2` per account local-part, capped | **Suggestions only** (D-R1-8). `matchBasis: 'last_user_ilike'`. |

- [ ] **Step 1: Write the failing test**

`identityDiscovery.test.ts` mocks `executeM365ReadActionByOrg`, the Google clients and the `db` handle, and asserts:

1. `discoverIdentityFacts` with both accounts returns `present: true` on both and populates every array.
2. **A provider read that REJECTS yields `present: false` plus a flag, and does not throw** — `expect(facts.m365.present).toBe(false)` and `facts.flags` contains `{ code: 'm365_read_failed', … }`. Three separate cases: a rejected promise, an `{ ok: false }` service result, and a `consent_upgrade_required` refusal (which gets its OWN flag code, `m365_consent_upgrade_required`, because it means "re-consent", not "broken").
3. **Every array is capped** — feed 500 groups, assert `facts.google.groups.length === 100` and `facts.truncated` contains `'google.groups'`. A plan built on an uncapped read would blow the approval card and the digest.
4. A dynamic-membership M365 group and a role-assignable one are marked and **still returned** (the recipe excludes them from the plan and generates human work; discovery does not hide them).
5. Google group ownership resolves to `'sole'` when the person is the only OWNER and `'shared'` when there is another; every M365 group is `'unknown'`.
6. **A mobile device whose account list does not contain the exact `primaryEmail` is DROPPED** — the `resolveWipeTarget` gate, asserted directly, with a device carrying `dana.smith@…` when the user is `dana@…`.
7. Breeze device suggestions match on `last_user` and carry `matchBasis: 'last_user_ilike'`; **zero matches is a normal, empty result, not a flag.**
8. The result is JSON-serializable and under 64 KiB for the capped worst case (it is stored in a jsonb column and rendered into a prompt):
   ```ts
   expect(JSON.stringify(facts).length).toBeLessThan(64 * 1024);
   ```
9. `observedAt` is an ISO string and `version` is `1`.
10. **No model is consulted** — a grep-style assertion on the module source, mirroring E4's invariant test:
    ```ts
    const src = readFileSync(join(__dirname, 'identityDiscovery.ts'), 'utf8');
    expect(src).not.toMatch(/createAndEnqueueAgentRun|aiAgentSdk|anthropic|submit_task_step/);
    ```

- [ ] **Step 2: Run it red, implement, run green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/identityDiscovery.test.ts`
Expected first: FAIL (module missing). Then PASS — 1 file, ~22 tests.

Implementation notes the executor must not deviate from:
- **Every provider call is wrapped.** The module's shape is `const google = await safely('google', () => readGoogle(...), fallbackGoogleFacts)`; `safely` catches, normalizes with `normalizeGoogleError` / the M365 refusal code, pushes a flag, and returns the fallback. Discovery is a `probe` step — a failed read must degrade the recipe, never fail the task (spec §4.1's whole premise).
- **No write of any kind**, not even an audit row. The M365 reads go through `executeM365ReadActionByOrg`, which does its own auditing.
- DB reads run inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`, matching the coordinator's other reads; the `devices` query is `eq(devices.orgId, orgId)` **plus** `ilike(devices.lastUser, …)`, org-scoped first.
- Caps are applied at the point of collection with a `truncated.push(...)`, never by slicing at the end — an un-truncated read of 5,000 groups costs the Graph round trips this is trying to avoid.

- [ ] **Step 3: Commit**

```
git add apps/api/src/services/aiOperator/identityDiscovery.ts apps/api/src/services/aiOperator/identityDiscovery.test.ts
git commit -m "$(cat <<'EOF'
feat(api): identityDiscovery — bounded, total, coordinator-issued provider reads (R1)

Every array capped and truncation recorded; a failing provider degrades to
present:false plus a flag instead of failing the task. M365 group ownership is
'unknown' (no owners read action exists) and every unknown becomes human work.
Breeze devices are SUGGESTIONS from devices.last_user, never effect targets.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The two reason steps — prompt rendering, prompt version, and server-side output validation

**Files:**
- Create: `apps/api/src/services/aiOperator/taskContextIdentity.ts`
- Create: `apps/api/src/services/aiOperator/taskContextIdentity.test.ts`

**D-R1-9:** prompts here are TypeScript rendering, not files — `services/aiOperator/taskContext.ts` (115 lines) is the shape to follow, and `IDENTITY_OFFBOARDING_PROMPT_VERSION` is bumped whenever this rendering changes, exactly as `SERVICE_RECOVERY_PROMPT_VERSION`'s docstring instructs. **Read `taskContext.ts` in full before writing this file and reuse its section structure and its redaction posture.**

**Interfaces:**
- Produces:
  ```ts
  export function renderIntakeContext(args: {
    objective: string;
    input: IdentityOffboardingInput;
    orgCandidates: ReadonlyArray<{ contactId: string; name: string | null; email: string | null; title: string | null }>;
  }): string;
  export function renderReviewContext(args: {
    objective: string;
    input: IdentityOffboardingInput;
    facts: IdentityDiscoveryFacts;
    plannedEffects: readonly PlannedEffect[];
    degradedCapabilities: readonly string[];
  }): string;

  export type IntakeValidation =
    | { ok: true; candidateContactIds: string[] }
    | { ok: false; reason: 'unknown_contact' | 'schema'; detail: string };
  export function validateIntakeOutput(
    output: unknown,
    orgContactIds: ReadonlySet<string>,
  ): IntakeValidation;

  export type ReviewValidation =
    | { ok: true; flags: IdentityReviewOutput['flags']; exceptions: IdentityReviewOutput['exceptions']; summary: string }
    | { ok: false; reason: 'unknown_tool' | 'schema'; detail: string };
  export function validateReviewOutput(
    output: unknown,
    plannedToolNames: ReadonlySet<string>,
  ): ReviewValidation;
  ```

**The two server-side rules the brief requires, stated exactly:**

- **`intake` may only return candidate contact ids that exist in the org.** `validateIntakeOutput` parses with `identityIntakeOutputSchema`, then rejects with `unknown_contact` if any id is absent from `orgContactIds` (a set the coordinator builds from an org-scoped query in the same pass). A hallucinated uuid must never reach `confirm_identity`'s card, where a technician would tick "yes, that's Dana" against a row that does not exist.
- **`review` may only return flags from the closed enum and exceptions classified into `{retry, human_work, handoff}`** — enforced by `identityReviewOutputSchema` — **and each exception's `toolName` must be one the plan actually contains**, rejected with `unknown_tool` otherwise. An exception about a tool that is not in the plan is either a hallucination or evidence the model is reasoning about a different task; either way it must not become a human-work item that tells a technician to check something that was never attempted.

Both validators run **after** E1's `validateRecipeNextStep` has parsed the payload against the target step's `inputSchema`, so the schema layer and the cross-check layer are separate and each is testable alone — the same two-layer shape `serviceRecovery.validateNextStep` + `crossCheckStepInputs` already has.

- [ ] **Step 1: Write the failing test**

Cases, with the reasons stated in the file header:

1. `renderIntakeContext` includes the objective, the person hint, and every candidate's name/email/title — and includes **no** contact id of a person outside the supplied list.
2. `renderIntakeContext` is bounded: with 200 candidates the string is under 16 KiB and says how many were omitted.
3. `renderReviewContext` lists the planned effects **grouped by provider, in plan order, with ordinals**, and lists the degraded capabilities in plain language.
4. `renderReviewContext` contains **no secret-shaped material** — assert the absence of `clientSecret`, `serviceAccountKey`, `vaultRef`, and any `-----BEGIN`.
5. `validateIntakeOutput` accepts ids present in the set.
6. `validateIntakeOutput` REJECTS an id absent from the set with `unknown_contact` and names the offending id in `detail`.
7. `validateIntakeOutput` REJECTS a payload that fails the schema with `schema`.
8. `validateIntakeOutput` accepts an EMPTY candidate list with `ambiguous: true` — "I could not find them" is a legitimate answer and must reach the technician, not be treated as a malformed response.
9. `validateReviewOutput` accepts flags from the enum.
10. `validateReviewOutput` REJECTS an exception naming a tool absent from the plan, with `unknown_tool`.
11. `validateReviewOutput` REJECTS a flag code outside the enum with `schema`.
12. Neither validator ever returns a value the model supplied verbatim in a field the caller will treat as authoritative — assert that `validateIntakeOutput`'s success shape contains **only** `candidateContactIds` (no rationale passthrough into a decision path; the rationale is recorded as an event, which the coordinator does).

- [ ] **Step 2: Implement, run green, commit**

Run: `cd apps/api && npx vitest run src/services/aiOperator/taskContextIdentity.test.ts`
Expected: PASS — 1 file, 12 tests.

```
git add apps/api/src/services/aiOperator/taskContextIdentity.ts apps/api/src/services/aiOperator/taskContextIdentity.test.ts
git commit -m "$(cat <<'EOF'
feat(api): identity reason-step rendering and server-side output validation (R1)

intake may only name contacts that exist in the org; review may only use flags
from a closed enum, the three exception classes, and tool names the plan
actually contains. Both run after E1's schema layer, never instead of it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `recipeReadiness.ts` — `ready | setup_required | unavailable`, and the degradation map

**Files:**
- Create: `apps/api/src/services/aiOperator/recipeReadiness.ts`
- Create: `apps/api/src/services/aiOperator/recipeReadiness.test.ts`

**Interfaces:**
- Consumes: `m365RoleReadiness`, `M365_PERMISSION_PROFILES` (M1); `M365_WRITE_ACTION_REQUIRED_ROLES` (`@breeze/shared`); `m365Connections`, `googleWorkspaceConnections`, `aiAgents` schemas; `RECIPES`, `getRecipeByKey` (`./recipes`); `IDENTITY_OFFBOARDING_CAPABILITIES`, `CAPABILITY_FOR_TOOL` (`./recipes/identityOffboarding`); `db`, `runOutsideDbContext`, `withSystemDbAccessContext`.
- Produces:
  ```ts
  export interface ReadinessInputs {
    orgId: string;
    m365: { status: string; permissionManifestVersion: number; observedGrants: unknown[]; grantsVerifiedAt: Date | null } | null;
    google: { status: string; lastVerifiedAt: Date | null } | null;
    agent: { id: string; kind: string; toolAllowlist: string[] } | null;
    flagEnabled: boolean;
  }
  export interface RecipeReadiness {
    recipeKey: string;
    recipeVersion: number;
    readiness: AiOperatorRecipeReadinessState;
    /** capability key → satisfied. Every requirement of the recipe appears. */
    capabilityReadiness: Readonly<Record<string, boolean>>;
    /** Unsatisfied `tenant_fixable` capabilities — the ONLY driver of `setup_required`. */
    missing: AiOperatorMissingCapabilityDto[];
    /** Unsatisfied `always_manual` capabilities — reported, never blocking. */
    alwaysManualCapabilities: AiOperatorMissingCapabilityDto[];
    manualStepCount: number;
    degradedEffects: string[];
    agentId: string | null;
    agentKind: string | null;
  }
  /** PURE — the whole rule, testable without a database. */
  export function computeRecipeReadiness(
    recipe: RecipeDefinition<never>,
    inputs: ReadinessInputs,
  ): RecipeReadiness;
  /** The I/O half: load the rows, call the pure half for every registered recipe. */
  export function listWorkflowReadiness(orgId: string, auth: AuthContext): Promise<RecipeReadiness[]>;
  /** Effect tool names that are NOT dispatchable for this org and must become human work. */
  export function degradedEffectTools(readiness: RecipeReadiness): string[];
  ```

**The rule, stated once (spec §4.1):**

| Condition | Result |
|---|---|
| `AI_OPERATOR_TASKS_ENABLED` or the recipe's own flag is off | `unavailable`, `missing: []`, `alwaysManualCapabilities: []` — the capability list is not a hint about an unshipped feature |
| Neither provider connection exists in a usable state | `unavailable`, with both `provider_connection` capabilities in `missing` and `degradesToHumanWork: false` |
| At least one provider usable, and every **`tenant_fixable`** capability satisfied | **`ready`** — even when `always_manual` capabilities are unsatisfied, which is the steady state until M2 |
| At least one provider usable, some **`tenant_fixable`** capability missing | `setup_required`, each named in `missing`, `degradesToHumanWork: true` for everything except a provider connection |

**`setup_required` means "something this tenant can fix".** An unsatisfied capability is partitioned by its `availability`:

- **`tenant_fixable`** → `missing`, and it is what makes the state `setup_required`. There is an action: connect a provider, re-consent Microsoft 365 to profile v2, add the identity tools to the helpdesk agent.
- **`always_manual`** → `alwaysManualCapabilities` and `manualStepCount`, and it **never** changes the state. Nothing anyone can do would satisfy it, so holding a fully-consented org at `setup_required` forever would train technicians to ignore the badge and would misstate whose problem it is. The recipe reads `ready`; the card reads *"Ready · 3 steps will be done by hand"*.

Both partitions still drive degradation identically — a tool behind **either** kind of unsatisfied capability is in `degradedEffects` and becomes a human-work item. The distinction is only about what the badge claims.

When M2 ships, the three Exchange capabilities flip to `availability: 'tenant_fixable'` in the recipe and nothing in this module changes.

Per-capability evaluation:

- `provider_connection` **m365**: `m365.status === 'active'`. `google`: `google.status === 'active'`.
- `permission_grant` (M365 Graph): satisfied iff `m365RoleReadiness(connection, M365_PERMISSION_PROFILES['customer-graph-actions'])` reports `true` for **every** role in `M365_WRITE_ACTION_REQUIRED_ROLES[actionId]` for each tool the capability names. Uses M1's function — this wave does not re-derive role readiness. A connection on `permissionManifestVersion < 2` reports the v2-only roles missing, which is exactly spec §7.2's "a tenant that has not re-consented sees *setup required: re-consent Microsoft 365*, not a failed task"; its `action.kind` is `'reconsent_m365'`.
- `tool_source` (the three Exchange capabilities): **always `false`** in this wave, always `degradesToHumanWork: true`, `availability: 'always_manual'`, `action.kind: 'none'`. No executor exists (spec §7.3) and pretending otherwise would silently drop mailbox work — but because they are `always_manual` they land in `alwaysManualCapabilities`, not `missing`, and the recipe still reads `ready`.
- `agent_tool`: satisfied iff `agent.toolAllowlist` contains **every** name in `toolNames`. The agent is the org's (or its partner's) **`helpdesk`** agent — D3, no new agent kind. `action.kind: 'add_agent_tools'`, `action.toolNames` = the missing subset, `action.agentId` = the agent id, so the library card's "add the identity tools to the helpdesk agent" button is a `PATCH /api/v1/ai/agents/:id` with `toolAllowlist` — the existing agent update route and its existing review, never a new privilege path.
- The `agent.helpdesk.tool_allowlist` umbrella capability is satisfied iff every per-tool `agent_tool` capability is.

`degradedEffectTools` inverts `CAPABILITY_FOR_TOOL`: a tool whose capability is unsatisfied is degraded. The coordinator passes `degradedEffectTools(...)` to `buildIdentityOffboardingManualWork` and **excludes those tools from `buildPlan`'s output before proposing the approval** — a plan must never contain an effect the org cannot dispatch, because the approver would be authorizing something that can only fail.

- [ ] **Step 1: Write the failing test**

`recipeReadiness.test.ts` is a table over `ReadinessInputs`, all against the pure half. Minimum cases:

1. Flag off → `unavailable`, `missing` empty, `alwaysManualCapabilities` empty, `manualStepCount === 0`.
2. No connections at all → `unavailable`, both provider capabilities in `missing`, `degradesToHumanWork: false` on both.
3. Google active, no M365 → `setup_required`; every **`tenant_fixable`** `m365.*` capability in `missing`; **`degradedEffects` contains every `m365_*` tool and no `google_*` tool** (spec §4.1's "degrades by provider, not as a whole").
4. Both active, M365 on manifest v1 → `setup_required`; the v2-only capabilities in `missing`; `m365.graph.user_disable` (User.ReadWrite.All, held in v1) still **satisfied**; the missing ones carry `action.kind === 'reconsent_m365'`.
5. **Both active, v2, full grants, helpdesk allowlist complete → `ready`.** The three Exchange capabilities are unsatisfied and appear in `alwaysManualCapabilities` with `manualStepCount === 3`, `missing` is **empty**, and `degradedEffects` contains no Graph tool. *(This is the honest steady state of the wave: a fully consented org reads "Ready · 3 steps will be done by hand", not "setup required" forever.)*
   ```ts
   expect(r.readiness).toBe('ready');
   expect(r.missing).toEqual([]);
   expect(r.alwaysManualCapabilities.map((c) => c.key).sort()).toEqual([
     'm365.exchange.forwarding', 'm365.exchange.mailbox_delegate', 'm365.exchange.shared_mailbox_conversion',
   ]);
   expect(r.manualStepCount).toBe(3);
   for (const c of r.alwaysManualCapabilities) {
     expect(c.availability).toBe('always_manual');
     expect(c.degradesToHumanWork).toBe(true);
     expect(c.action.kind).toBe('none');
   }
   ```
6. **`always_manual` never contributes to `setup_required`, and `tenant_fixable` always does.** Two assertions on the same inputs: from case 5, flip **one** `tenant_fixable` capability to unsatisfied and assert the state becomes `setup_required`; flip a **fourth** capability's `availability` to `always_manual` in a local recipe fixture and assert the state returns to `ready` while `manualStepCount` becomes 4. This is the discriminating pair — without the second half, a `computeRecipeReadiness` that simply ignored the Exchange keys by name would pass every other case in the file.
7. Helpdesk agent missing one tool → that tool degraded, it is in `missing` (`tenant_fixable`), `action.toolNames` is exactly the missing subset, `action.agentId` set.
8. No helpdesk agent at all → every `agent_tool` capability missing, `action.agentId === null`, `action.kind === 'add_agent_tools'` still (the UI's copy changes, the capability does not).
9. `m365.status === 'degraded'` is NOT usable → treated as no connection for `provider_connection`, and every M365 capability missing.
10. **`capabilityReadiness` contains an entry for EVERY `recipe.requires` key**, always, and `missing ∪ alwaysManualCapabilities` is exactly the unsatisfied subset of it with no overlap — a missing key would make `next` resolvers read `undefined` and silently take the "not ready" branch by accident, and an overlap would double-count a gap on the card.
11. `service_recovery` (no `requires`) computes `ready` whenever its flag is on, with `manualStepCount === 0` — the generic function must not special-case the identity recipe.
12. An unclassified capability (no `availability` field) is treated as `tenant_fixable` and therefore **blocks** — asserted against a local fixture recipe, because the default's direction is the one thing that must not silently invert.

- [ ] **Step 2: Implement, run green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/recipeReadiness.test.ts`
Expected: PASS — 1 file, ~18 tests.

The partition is one function, called once, so the two lists cannot drift:

```ts
const unsatisfied = recipe.requires.filter((c) => !capabilityReadiness[c.key]);
const missing = unsatisfied.filter((c) => (c.availability ?? 'tenant_fixable') === 'tenant_fixable');
const alwaysManual = unsatisfied.filter((c) => c.availability === 'always_manual');
// `unavailable` is decided FIRST and independently: a missing provider
// connection is not a degradation, it is an absent prerequisite.
const readiness = !flagEnabled || noUsableProvider
  ? 'unavailable'
  : missing.length > 0 ? 'setup_required' : 'ready';
```

- [ ] **Step 3: Commit**

```
git add apps/api/src/services/aiOperator/recipeReadiness.ts apps/api/src/services/aiOperator/recipeReadiness.test.ts
git commit -m "$(cat <<'EOF'
feat(api): per-capability recipe readiness with per-provider degradation (R1)

Computed from rows only: connection status, permission_manifest_version via
M1's m365RoleReadiness, Google connection health, and the helpdesk agent's
toolAllowlist.

setup_required means "something this tenant can fix". Unsatisfied capabilities
are partitioned by CapabilityRequirement.availability: tenant_fixable gaps go
to `missing` and drive the badge; always_manual gaps (the three Exchange
capabilities, pre-M2) go to `alwaysManualCapabilities`/`manualStepCount` and
never do. A fully consented org therefore reads ready + "3 steps done by hand"
instead of setup_required forever. Both partitions degrade their effects to
human work identically. Only a missing provider connection makes the recipe
unavailable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `admitTask` — generalize admission, resolve the contact, freeze the accounts, serialize per contact

**Files:**
- Create: `apps/api/src/services/aiOperator/contactResolution.ts`
- Create: `apps/api/src/services/aiOperator/contactResolution.test.ts`
- Modify: `apps/api/src/services/aiOperator/taskService.ts`
- Modify: `apps/api/src/services/aiOperator/taskService.test.ts` *(if one exists; E1 lists its callers)*

**E1 deferred this to R1 explicitly** (decision 7: *"A generic `admitTask` with one recipe in the registry would be speculative and untestable; it arrives with R1, which has a second recipe to prove it against"*). Two shipped test files mock the old name (`routes/aiOperatorTasks.test.ts`, `__tests__/integration/aiOperatorAdmission.integration.test.ts`), so **`admitServiceRecoveryTask` survives as a thin wrapper with its exact current signature and semantics** and those files are not edited.

**Interfaces:**
- Produces:
  ```ts
  // contactResolution.ts
  export interface ResolvedTaskContact {
    contactId: string;
    label: string;                               // frozen display label
    accounts: Array<{ provider: 'm365' | 'google'; externalId: string; principalLabel: string; connectionId: string | null }>;
    created: boolean;
  }
  export type ContactResolutionResult =
    | { ok: true; contact: ResolvedTaskContact }
    | { ok: false; reason: 'contact_not_in_org' | 'no_provider_account' | 'ambiguous'; detail: string };
  export async function resolveOrCreateContactForTask(
    dbh: TargetDbHandle,
    args: { orgId: string; contactId: string | null; personHint: string | null },
  ): Promise<ContactResolutionResult>;
  /** Transaction-scoped. Auto-released on commit or rollback. */
  export async function lockContactForRecipe(orgId: string, recipeKey: string, contactId: string): Promise<void>;
  export async function findLiveTaskForContact(
    orgId: string, recipeKey: string, contactId: string,
  ): Promise<{ taskId: string } | null>;

  // taskService.ts
  export type AdmitTaskRefusal =
    | 'tasks_disabled' | 'recipe_disabled' | 'unknown_recipe' | 'recipe_version_mismatch'
    | 'agent_not_found' | 'device_not_in_org' | 'invalid_input'
    | 'contact_not_in_org' | 'no_provider_account' | 'duplicate_live_task';
  export interface AdmitTaskInput {
    orgId: string; agentId: string; objective: string;
    originKind: 'manual' | 'alert' | 'ticket' | 'schedule' | 'anomaly' | 'sweep' | 'chat';
    requesterUserId: string | null;
    workflowKey: string; workflowVersion: number;
    recipeInput: unknown;
    deadlineMs?: number; now?: Date; clientIdempotencyKey?: string | null;
  }
  export async function admitTask(input: AdmitTaskInput): Promise<AdmitTaskResult>;
  /** UNCHANGED signature and semantics. Delegates to admitTask. */
  export async function admitServiceRecoveryTask(input: AdmitServiceRecoveryTaskInput): Promise<AdmitTaskResult>;
  ```

**The admission sequence** — all inside the **existing** `runOutsideDbContext(() => withSystemDbAccessContext(async () => { … }))` block (`taskService.ts:142-268`), which is one Postgres transaction:

1. Flags: `aiOperatorTasksEnabled()` → `tasks_disabled`; the recipe's own flag → `recipe_disabled`. (Map recipe key → flag accessor in a small frozen `RECIPE_FLAGS` record beside `admitTask`, so a third recipe adds one line.)
2. `resolveAdmissionRecipe(workflowKey, workflowVersion)` → `unknown_recipe` / `recipe_version_mismatch`. E1's refusals, surfaced unchanged.
3. `recipe.inputSchema.parse(recipeInput)` → `invalid_input` on throw.
4. Agent lookup and org check — **unchanged from today**, including the `agent.orgId === null || agent.orgId === input.orgId` rule and the comment at `:144-149` explaining why it is the only thing between a task and an agent in another tenant.
5. **If the recipe's `targetKinds` includes `'contact'`:**
   a. `resolveOrCreateContactForTask` — by id when given (org-scoped read; `contact_not_in_org` if absent), else by `personHint` through `matchContactByEmail` (`services/contacts/crud.ts:439`) when the hint parses as an email, else **create** a contact via `createContact` (`crud.ts:467`) with just the hint as `name`. A hint that matches more than one contact is `ambiguous` — which is **not** a refusal at admission: the task is admitted with the contact unresolved and the `intake` reason step resolves it. Only an explicitly supplied `contactId` that is not in the org is a hard refusal.
   b. **`lockContactForRecipe(orgId, recipeKey, contactId)`** — `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))` with `$1 = 'ai_operator:' + recipeKey + ':' + contactId` (D-R1-6). First statement after the contact is known, before the liveness read.
   c. `findLiveTaskForContact` → `duplicate_live_task` with the existing task id in the detail.
   d. Provider accounts: read the contact's `contact_external_links` for `system ∈ ('m365','google')`; where a link is absent, resolve the account from the provider by email (M365: `executeM365ReadActionByOrg` `m365.user.get`; Google: `dir.users.get`) and **`upsertContactExternalLinks`** (E2) so the next task is cheaper. Zero accounts on both providers → `no_provider_account`.
6. Insert the `ai_operator_tasks` row with `workflowKey`/`workflowVersion` **from the resolved recipe**, not from literals, and the `.onConflictDoNothing({ target: [orgId, clientIdempotencyKey], where: … })` replay path **exactly as today** — including the re-read and the throw on a conflict with no readable row.
7. `createTaskTarget` (E2) for the contact (`targetKind: 'contact'`, `targetOrdinal: 0`, `targetLabel` = the frozen label), then one per selected device (`targetOrdinal: 1..n`). The ticket target is created lazily by E3's `ensureTaskTicket` at the first human-work step.
8. `freezeTargetAccount` (E2) once per resolved provider account.
9. `appendTaskEvent` (E2) `task_admitted` with the recipe key, version and target count.

`admitServiceRecoveryTask` becomes:

```ts
/**
 * The shipped service-recovery entry point, unchanged.
 *
 * Kept as a named export rather than folded into `admitTask` because two
 * shipped suites mock it by name (`routes/aiOperatorTasks.test.ts`,
 * `__tests__/integration/aiOperatorAdmission.integration.test.ts`) and
 * churning them would buy nothing. It is a projection, not a second path:
 * every rule lives in `admitTask`.
 */
export async function admitServiceRecoveryTask(
  input: AdmitServiceRecoveryTaskInput,
): Promise<AdmitTaskResult> {
  return admitTask({
    ...input,
    workflowKey: input.workflowKey ?? SERVICE_RECOVERY_WORKFLOW_KEY,
    workflowVersion: input.workflowVersion ?? SERVICE_RECOVERY_WORKFLOW_VERSION,
  });
}
```

(E1 already added the two optional inputs to `AdmitServiceRecoveryTaskInput`.)

- [ ] **Step 1: Write the failing tests**

`contactResolution.test.ts`:
1. An explicit `contactId` present in the org resolves and `created === false`.
2. An explicit `contactId` in **another** org returns `contact_not_in_org` — asserted with a stubbed handle whose query is checked for the `orgId` predicate, because this is the tenancy boundary.
3. An email-shaped hint matching one contact resolves it.
4. An email-shaped hint matching none **creates** a contact with `email` set and `created === true`.
5. A non-email hint creates a contact with `name` set and no email.
6. A hint matching two contacts returns `ambiguous` **and does not create a third** — assert `insert` was never called.
7. `lockContactForRecipe` issues `pg_advisory_xact_lock` with a key derived from all three components, and **derives a different key for a different recipe on the same contact** (so offboarding and a future onboarding do not block each other).
8. `findLiveTaskForContact` filters to non-terminal states and to the recipe key — feed a completed task and assert `null`.

`taskService.test.ts` (extend, do not rewrite):
9. `admitTask` with an unknown key returns `unknown_recipe`; with a wrong version, `recipe_version_mismatch`.
10. `admitTask` for `identity_offboarding` with the flag off returns `recipe_disabled` **before** any DB call.
11. `admitTask` takes the advisory lock **before** the liveness read — assert call order on the stub.
12. A second admission while one is live returns `duplicate_live_task` naming the existing task id.
13. `admitServiceRecoveryTask` produces a byte-identical insert to today's for the same input — snapshot the values object.
14. A contact with no account on either provider returns `no_provider_account` and **inserts no task row**.
15. Targets and accounts are written in the same transaction as the task row — assert all three inserts happened on the same handle before the outer promise resolved.

- [ ] **Step 2: Run red, implement, run green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/contactResolution.test.ts src/services/aiOperator/taskService.test.ts src/routes/aiOperatorTasks.test.ts`
Expected: PASS. `routes/aiOperatorTasks.test.ts` must pass **unmodified** — if it does not, the wrapper's semantics drifted.

- [ ] **Step 3: Commit**

```
git add apps/api/src/services/aiOperator/
git commit -m "$(cat <<'EOF'
feat(api): generalize admission to admitTask; resolve, lock and freeze the contact (R1)

One live task per (contact, recipe), serialized by a transaction-scoped
advisory lock — not SELECT FOR UPDATE on contacts, which would block every FK
child write for that person, and not a caught 23505, which would abort the
admission transaction. admitServiceRecoveryTask stays as a thin wrapper so the
two suites that mock it by name are untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `manualWork.ts` — create all the items up front, bind steps one at a time

**Files:**
- Create: `apps/api/src/services/aiOperator/manualWork.ts`
- Create: `apps/api/src/services/aiOperator/manualWork.test.ts`

**D-R1-5.** Additive over E3: it reuses `openStep`, `markStepWaiting`, `appendTaskEvent`, `ensureTaskTicket` and `OPERATOR_TASK_ACTOR`, and redefines none of them.

**Interfaces:**
- Produces:
  ```ts
  export interface EnsureManualWorkItemsResult { ticketId: string; itemIds: string[]; created: number }
  export async function ensureManualWorkItems(
    dbh: HumanWorkDbHandle,
    task: { id: string; orgId: string; objective: string },
    items: readonly IdentityManualWorkItem[],
  ): Promise<EnsureManualWorkItemsResult>;

  export interface AttachHumanWorkStepInput {
    task: { id: string; orgId: string; revision: number };
    stepKey: string; attemptOrdinal: number; targetId?: string | null;
    checklistItemId: string; remindAfterMs?: number | null;
  }
  export async function attachHumanWorkStep(
    dbh: HumanWorkDbHandle, input: AttachHumanWorkStepInput,
  ): Promise<{ stepId: string }>;

  /** The next item the cursor should bind to, skipping anything already done. */
  export async function nextOpenManualItem(
    orgId: string, taskId: string, itemIds: readonly string[], fromIndex: number,
  ): Promise<{ index: number; itemId: string } | null>;
  ```

**Rules the tests must pin:**
- **`ensureManualWorkItems` dedupes on STEP IDENTITY, never on `(ticket_id, label)`.** E3 leaves exactly two link columns: the owning FK `ai_operator_task_steps.checklist_item_id` (plain, `ON DELETE SET NULL`) and the provenance pointer `ticket_checklist_items.operator_step_id` (no FK, E3 decision 1). The step row's identity tuple is E2's `(org_id, task_id, step_key, target_id, attempt_ordinal, plan_revision)`, which is what its two partial uniques key on, so the authoritative question "does this manual item already exist?" is answered by:

  ```
  SELECT s.attempt_ordinal, s.checklist_item_id
    FROM ai_operator_task_steps s
   WHERE s.org_id = $1 AND s.task_id = $2 AND s.step_key = 'manual_work'
     AND s.checklist_item_id IS NOT NULL
  ```

  `attempt_ordinal` **is** the manual item's index, so the set of already-created items is the set of ordinals this query returns, and `ensureManualWorkItems` inserts only the ordinals it does not. Re-entering `manual_work` after a wake therefore inserts nothing.

  `(ticket_id, label)` is explicitly **not** the key, for three reasons: two different tasks on one ticket can legitimately generate the same label ("Collect the laptop"); `ticket_checklist_items.org_id` is re-stamped by both ticket org-movers while the step's is immutable, so a label match can span what is now two tenants; and a technician may edit a label, which would silently orphan the dedupe and double-insert on the next wake.

  Ordering consequence, and it is the reason this works at all: items are created in `buildIdentityOffboardingManualWork`'s **stable, deduplicated-by-key** order (Task 3 asserts that order is stable), so index *i* always means the same item across wakes. `attachHumanWorkStep` stamps `operator_step_id` on the item in the same call that opens the step, so the two directions of the link are written together.
- It calls `ensureTaskTicket` first, so a task with no ticket gets one (spec §6.5: "a task with human-work steps requires a ticket").
- `attachHumanWorkStep` **never sets `done_at`** and never sets `done_by_user_id` — E3's Task 10 contract test (`no AI Operator code path ever writes done_at`) covers `services/aiOperator/**` and will catch a violation. Task 15 re-runs it.
- `nextOpenManualItem` skips items already `done_at`, so a technician who ticks out of order advances the cursor faster, and returns `null` when everything is done.
- Every item's `label` is truncated to 500 chars (`ticket_checklist_items.label` is `varchar(500)`) with an ellipsis, never silently.

Three dedupe cases the test must carry, because each is a way the naive key fails:
1. Called twice with the same item list → the second call inserts **zero** rows and returns the same `itemIds` in the same order.
2. Called twice where the first call's items were all created and one was **relabelled** by a technician → still zero inserts (the step identity is unchanged).
3. Two different tasks on **one** ticket, both generating an item with the identical label → **both** items exist, because their step identities differ. A `(ticket_id, label)` dedupe would have silently dropped the second task's work.

- [ ] **Steps 1–3: red, implement, green, commit**

Run: `cd apps/api && npx vitest run src/services/aiOperator/manualWork.test.ts src/services/aiOperator/humanWorkService.test.ts`
Expected: PASS both; E3's file is **not** edited.

---

### Task 11: The coordinator advancers — `RECIPE_ADVANCERS['identity_offboarding']`

**Files:**
- Create: `apps/api/src/services/aiOperator/identityAdvancers.ts`
- Create: `apps/api/src/services/aiOperator/identityAdvancers.test.ts`
- Modify: `apps/api/src/services/aiOperator/taskCoordinator.ts` — **one added table entry and one import. Nothing else.**

E1 put step execution in `RECIPE_ADVANCERS[recipeKey][stepKey]`, consulted **before** E3's `KIND_ADVANCERS` fallback. This recipe registers four advancers and lets the generic ones handle the rest:

| Step | Advancer | Why |
|---|---|---|
| `intake` | `advanceIntake` (R1) | recipe-specific prompt, candidate set, validation |
| `discover` | `advanceDiscover` (R1) | recipe-specific reads, writes the facts onto the step row |
| `review` | `advanceReview` (R1) | recipe-specific prompt over the plan, then proposes the approval |
| `verify_outcome` | `advanceVerifyOutcome` (R1) | the final probe and the `verified_resolved` / `partial` decision |
| `document` | `advanceDocument` (R1) | writes the completion record |
| `confirm_identity`, `manual_work` | E3's `advanceHumanWork` via `KIND_ADVANCERS` — **except** `manual_work`, which R1 overrides to walk the cursor (D-R1-5) | |
| `wait_cutoff` | E3's `advanceWait` | nothing recipe-specific |
| `plan_approval` | E4's `advancePlanApprovalStep` | matched by the `plan_` prefix arm |
| `effects`, `device_actions` | E4's `advanceEffectStep`, **overridden** by R1's `advanceEffects` to walk `checkpoint.effectCursor` one ordinal per wake | |

**Every advancer's transition writes `resumeStepKey`.** After a non-`reason` step settles, the advancer calls `resolveDeterministicNextStep(recipe, stepKey, { input: checkpoint.recipeInput, facts, readiness })` and passes the result into the existing `writeLeasedStep(…, checkpoint)` call with `checkpoint.resumeStepKey` set — which is precisely the field E3 created and the generic advancers read. A `{ ok: false }` resolution is `settle({ event: 'fail', outcome: 'unresolved', detail: resolution.detail })`; it is **never** guessed (E3's decision 11: "Absence is a recipe bug and is settled `fail`/`unresolved` with a named detail").

**Interfaces:**
- Produces:
  ```ts
  export const IDENTITY_OFFBOARDING_ADVANCERS: Readonly<Record<string, StepAdvancer>>;
  export async function advanceIntake(a: StepAdvancerArgs): Promise<string>;
  export async function advanceDiscover(a: StepAdvancerArgs): Promise<string>;
  export async function advanceReview(a: StepAdvancerArgs): Promise<string>;
  export async function advanceEffects(a: StepAdvancerArgs): Promise<string>;
  export async function advanceManualWork(a: StepAdvancerArgs): Promise<string>;
  export async function advanceVerifyOutcome(a: StepAdvancerArgs): Promise<string>;
  export async function advanceDocument(a: StepAdvancerArgs): Promise<string>;
  ```
  `StepAdvancerArgs` is E1's `StepAdvancer` parameter object (`{ task; leaseEpoch; checkpoint; recipe; now }`) re-exported from `taskCoordinator.ts`; **do not redeclare it** — import the type.

**The five advancers, in one paragraph each:**

- **`advanceIntake`** — admits a bounded reasoning run through the same `admitReasoningRun` path `service_recovery` uses, with `recipe.promptVersion` and `renderIntakeContext`. On the run's terminal wake, `validateIntakeOutput(payload, orgContactIds)`; on `{ok:false}` the step settles `fail`/`unresolved` naming the reason (a hallucinated contact id is a hard stop, not a retry). On success, records the candidates as a task event and transitions to `confirm_identity` — whose human-work item's **label names the candidates** so the technician confirms a person, not a uuid.
- **`advanceDiscover`** — `openStep(dbh, { stepKey: 'discover', stepKind: 'probe', … })`, calls `discoverIdentityFacts` with the frozen accounts from `ai_operator_task_target_accounts`, writes the facts into that step row's `checkpoint`, sets `checkpoint.discoveryStepId`, and transitions to `review`. A discovery that returns `present:false` on **both** providers hands off (`hand_off`, `unresolved`) with a summary naming the provider errors — there is nothing to plan.
- **`advanceReview`** — a bounded reasoning run over `renderReviewContext(…, plannedEffects: buildPlan(input, facts) minus degraded tools, degradedCapabilities)`; `validateReviewOutput(payload, plannedToolNames)`; then computes the final plan, calls `splitSecretBearingEffects` (E4 — empty for this recipe, and the test asserts that, because a non-empty `individual` list here would mean a secret-bearing effect slipped into an identity plan) and `proposePlanApproval` (E4). `no_requester` → hand off (E4's rule: "a plan that destroys a person's access needs a named human on both ends").
- **`advanceEffects`** — reads `checkpoint.effectCursor`, calls E4's `dispatchPlannedEffect` for that one ordinal, and on a settled outcome increments the cursor and re-enters; when the cursor passes the last ordinal it resolves `next` and transitions. **One effect per wake**, so the ordering contract is enforced by the runtime and not merely by the plan: a stopped task has completed a prefix, which is exactly what Task 4's property is about. `{ kind: 'refused' }` and `{ kind: 'handoff' }` settle; `{ kind: 'noop' }` and `{ kind: 'dispatching' }` advance or wait.
- **`advanceVerifyOutcome`** — spec §6.6's last rule, stated in code: `verified_resolved` requires this step's own probe to pass **and** a `satisfied` post-probe for every **observable** effect; an `unknown` on an observable effect, or an unsubsumed unobservable one, is `partial` with the unverified effects listed. The subsumption check reads `IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS` and requires the named subsuming effect to be present **and** `satisfied`.
- **`advanceDocument`** — Task 12.

- [ ] **Step 1: Write the failing test**

`identityAdvancers.test.ts` drives each advancer against stubbed E2/E3/E4 modules (`vi.doMock`), following whatever mocking style `taskCoordinator.recipeResolution.test.ts` (E1) established — **read that file first and reuse it; do not introduce a second coordinator test harness.** Cases:

1. Every step key of the recipe resolves to an advancer — either R1's table or E3's `KIND_ADVANCERS` — and **none falls through to "unknown step"**. Assert by iterating `IDENTITY_OFFBOARDING_STEP_KEYS`.
2. `advanceIntake` settles `fail` on `unknown_contact` and does **not** open `confirm_identity`.
3. `advanceDiscover` writes `discoveryStepId` and hands off when both providers are absent.
4. `advanceReview` excludes every degraded tool from the proposed plan — feed a readiness map missing `m365.graph.intune_retire` and assert no `m365_retire_intune_device` reaches `proposePlanApproval`.
5. `advanceReview` asserts `splitSecretBearingEffects(...).individual` is empty and settles `fail` if it is not.
6. `advanceEffects` dispatches exactly ONE ordinal per call and increments the cursor.
7. `advanceEffects` on `{ kind: 'refused' }` settles and **does not** increment the cursor — a refused effect must not be skipped over silently.
8. `advanceVerifyOutcome` returns `partial` when an observable effect probed `unknown`.
9. `advanceVerifyOutcome` returns `verified_resolved` when the only `unknown` is `google_signout` **and** `google_suspend_user` is `satisfied`.
10. `advanceVerifyOutcome` returns `partial` when `google_signout` is `unknown` and the suspend is **absent from the plan**.
11. Every advancer that transitions writes `resumeStepKey`, and a failed `next` resolution settles `fail` with the resolver's detail — asserted for all five.
12. **No advancer throws**: each is driven with a rejecting dependency and asserted to settle.

`taskCoordinator.ts`'s own guard test (E4's `taskCoordinator.planApproval.test.ts`) still asserts the three invariants verbatim and that `revision` has exactly one writer — run it and keep it green.

- [ ] **Step 2: Wire it — the one coordinator edit**

```ts
import { IDENTITY_OFFBOARDING_ADVANCERS } from './identityAdvancers';
…
const RECIPE_ADVANCERS: Readonly<Record<string, Readonly<Record<string, StepAdvancer>>>> = {
  [SERVICE_RECOVERY_WORKFLOW_KEY]: { /* unchanged */ },
  [IDENTITY_OFFBOARDING_WORKFLOW_KEY]: IDENTITY_OFFBOARDING_ADVANCERS,
};
```

Run: `git diff --stat -- apps/api/src/services/aiOperator/taskCoordinator.ts`
Expected: roughly `1 file changed, 3 insertions(+)`. Materially larger means advancer logic moved into the coordinator — move it back.

- [ ] **Step 3: Run green and commit**

Run: `cd apps/api && npx vitest run src/services/aiOperator/ && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: every `aiOperator` unit file passes — check the count, E1–E4's files must all still be there — and `tsc` is clean.

```
git add apps/api/src/services/aiOperator/
git commit -m "$(cat <<'EOF'
feat(api): identity_offboarding coordinator advancers (R1)

Five recipe-specific advancers plus overrides for effects and manual_work;
E3's human_work/wait and E4's plan_approval/effect arms handle the rest. Every
transition resolves StepDefinition.next and persists it as resumeStepKey; an
unresolvable next settles fail/unresolved and is never guessed. One effect
ordinal per wake, so a stopped task has completed a prefix.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: The completion record (spec §6.6)

**Files:**
- Create: `apps/api/src/services/aiOperator/completionRecord.ts`
- Create: `apps/api/src/services/aiOperator/completionRecord.test.ts`

**Interfaces:**
- Consumes: `addTicketComment` (`../ticketService:1533`, with `isPublic: false` → `commentType: 'internal'`); `aiOperatorOperations`, `aiOperatorTaskSteps`, `aiOperatorTaskEvents`, `aiOperatorPlanApprovalEffects`, `ticketChecklistItems`; `OPERATOR_TASK_ACTOR` (E3).
- Produces:
  ```ts
  export const COMPLETION_RECORD_MAX_CHARS = 12_000;
  export interface CompletionRecordInput { orgId: string; taskId: string; recipeKey: string }
  export interface CompletionRecord { text: string; truncated: boolean }
  export async function buildCompletionRecord(input: CompletionRecordInput): Promise<CompletionRecord>;
  export async function postCompletionRecord(
    input: CompletionRecordInput & { ticketId: string },
  ): Promise<{ commentId: string }>;
  ```

**The record is BOUNDED TEXT, never jsonb** (spec §5.5: "the completion record is bounded `text`, not jsonb, so it survives export"). It is assembled from rows — the model's only contribution is the narrative paragraph, and the facts around it are read, not generated. Sections, in order:

1. **Targets** — the frozen `target_label` of every target row, and each frozen `principal_label` per provider. Frozen labels, not live names: a rename after the fact must not rewrite the record of what was done.
2. **Effects** — one line per `ai_operator_plan_approval_effects` row: ordinal, provider, tool, its outcome from the `ai_operator_operations` row (`succeeded` / `succeeded (no-op, already in the desired state)` / `failed` / `refused`), its post-probe verdict, and **the approver's name** (from the plan approval).
3. **Human work** — one line per `operator_task` checklist item: the label, whether it is done, and **who completed it** (`done_by_user_id` → name). Evidence is the completing user and timestamp, never model-graded free text.
4. **Not independently verifiable** — every effect whose probe is `unknown`, each with the reason, and for an unobservable one the subsuming criterion ("`google_signout`: dispatched, not independently verifiable; superseded by the verified Google suspend").
5. **Unresolved** — un-ticked human work, refused effects, discovery flags never addressed.
6. **Cost** — the task's accounting total, read from the accounting root.
7. **Narrative** — the model's prose, last, clearly labelled, and truncated to 2,000 chars.

- [ ] **Step 1: Write the failing test**

1. Every section appears, in order, for a fully-populated task.
2. A no-op effect is rendered as a no-op, not as a plain success — the distinction is the whole value of probe-before-write.
3. An unobservable effect names its subsuming criterion.
4. **No secret-shaped material** — assert the absence of `password`, `-----BEGIN`, `clientSecret`, `vaultRef` even when an operation result contains a sealed field.
5. The record is capped at `COMPLETION_RECORD_MAX_CHARS` with `truncated: true` and a visible "… truncated" marker; the **Unresolved** section is never the part that gets cut (truncate the narrative first, then effects, then the rest — the unresolved list is the one a technician must act on).
6. `postCompletionRecord` posts with `isPublic: false` so the comment is `internal`.
7. It is idempotent — called twice, it does not post a second comment (guard on an existing event, and assert `addTicketComment` was called once).
8. A task with no ticket is a programming error, not a silent skip: `postCompletionRecord` throws a named error (the `document` step only runs after `manual_work`, which guarantees a ticket).

- [ ] **Step 2: Implement, green, commit**

Run: `cd apps/api && npx vitest run src/services/aiOperator/completionRecord.test.ts`
Expected: PASS — 1 file, 8 tests.

```
git add apps/api/src/services/aiOperator/completionRecord.ts apps/api/src/services/aiOperator/completionRecord.test.ts
git commit -m "$(cat <<'EOF'
feat(api): bounded-text completion record posted as an internal ticket comment (R1)

Assembled from rows — effects with result and approver, human work with its
completer, unverifiable effects with the criterion that subsumes them,
unresolved items, cost — with the model's prose last and truncated first. Text,
never jsonb, so it survives a tenant export (spec §5.5).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: The two routes, and the flag

**Files:**
- Modify: `apps/api/src/routes/aiOperatorTasks.ts`
- Modify: `apps/api/src/routes/aiOperatorTasks.test.ts`
- Modify: `apps/api/src/config/env.ts`, `apps/api/src/config/validate.ts`
- Modify: `.env.example`, `docker-compose.yml`, `deploy/.env.example`, `deploy/docker-compose.prod.yml`

**Routes** (spec §8, §12 — no new route family, both under the existing `aiOperatorTasksRoutes` mounted at `/ai/operator` by `index.ts:1035`):

```ts
/**
 * GET /api/v1/ai/operator/workflows — the Library (spec §4.1, §12).
 *
 * Readiness is computed from ROWS on every call. Spec §12: "Recompute
 * readiness on launch and before dispatch. A cached catalog or draft is never
 * authority." There is deliberately no ETag and no cache header.
 */
aiOperatorTasksRoutes.get(
  '/workflows',
  scopes,
  requireAiRead,
  zValidator('query', z.object({ orgId: z.string().guid() }).strict()),
  async (c) => { /* auth.canAccessOrg → 403/404; listWorkflowReadiness(orgId, auth) → AiOperatorWorkflowDto[] */ },
);

/**
 * POST /api/v1/ai/operator/task-drafts — interpret and validate, execute nothing.
 *
 * Spec §12: "returns typed reviewed proposal, no operational execution". It
 * resolves the recipe, parses the inputs, resolves the contact READ-ONLY (it
 * never creates one — a draft that created customer records would not be a
 * draft), computes readiness, and returns the effects the plan WOULD contain
 * plus the human-work items it would generate. It writes nothing.
 */
aiOperatorTasksRoutes.post(
  '/task-drafts',
  scopes,
  requireAiWrite,
  zValidator('json', operatorTaskDraftSchema),
  async (c) => { /* … */ },
);
```

`POST /tasks` changes only where D-R1-3 says: resolve the recipe, compose and parse the recipe input, then call `admitTask`. The refusal → status map is extended: `unknown_recipe` 400, `recipe_version_mismatch` 422, `contact_not_in_org` 404 (non-enumerating), `no_provider_account` 422, `duplicate_live_task` **409** (spec §12: "Use 409 for stale revision/idempotency conflict"), everything else unchanged.

**Flag:**

```ts
// apps/api/src/config/env.ts, beside aiOperatorServiceRecoveryEnabled() at :223
/**
 * Recipe-level gate for `identity_offboarding` (spec §9's `deterministic`
 * class requires its own flag). Nests under AI_OPERATOR_TASKS_ENABLED, which
 * nests under the AI_AGENTS_ENABLED kill switch. Stays OFF until the lab run
 * in R1c passes against a real M365 developer tenant and a real Google
 * Workspace test domain.
 */
export function aiOperatorIdentityOffboardingEnabled(): boolean {
  return envFlag('AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED', false);
}
```

Env parity — **both** pairs, matched, commented out, default false:
- `.env.example`, beside `AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED` at `:1160-1161`
- `docker-compose.yml` `api:` environment, beside `:294-295`
- `deploy/.env.example` — **also add the two existing operator flags there**; they are missing today (verified), and while `envComposeParity.test.ts` only checks *documented → mapped*, a self-hoster reading `deploy/.env.example` currently cannot discover any of them
- `deploy/docker-compose.prod.yml` `api:` environment — all three

- [ ] **Step 1: Write the failing tests** (in `routes/aiOperatorTasks.test.ts`, appended — the existing cases are not edited)

1. `GET /workflows` returns both recipes with a readiness state each.
2. `GET /workflows` for an org the caller cannot access is 403/404 per the file's existing convention — copy whatever `GET /tasks` does.
3. `GET /workflows` sends **no cache header** and re-computes on a second call (assert `listWorkflowReadiness` called twice).
4. `POST /task-drafts` returns the would-be effect list and human-work items and **writes nothing** — assert no `insert` on any stub.
5. `POST /task-drafts` for an unresolvable person returns the candidates, not an error.
6. `POST /tasks` with `recipeKey: 'identity_offboarding'` and no `deviceId` admits.
7. `POST /tasks` with the shipped service-recovery body still admits, byte-identically — the existing case, unmodified.
8. `duplicate_live_task` → 409 with the existing task id in the body.
9. `contact_not_in_org` → 404 and the body **does not** say whether the contact exists elsewhere.
10. An unknown recipe key → 400 whose body names both supported keys.

- [ ] **Step 2: Implement, green, and prove parity**

Run: `cd apps/api && npx vitest run src/routes/aiOperatorTasks.test.ts src/config/envComposeParity.test.ts src/config/validate.test.ts`
Expected: PASS all three.

- [ ] **Step 3: Commit**

```
git add apps/api/src .env.example docker-compose.yml deploy/
git commit -m "$(cat <<'EOF'
feat(api): GET /ai/operator/workflows, POST /task-drafts, and the recipe flag (R1)

Readiness is recomputed from rows on every call — a cached catalog is never
authority (spec §12). Drafts write nothing, not even a contact. The flag ships
OFF in both env pairs and is not enabled anywhere by this PR.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: End-to-end integration against real Postgres with fake provider executors

**Files:**
- Create: `apps/api/src/__tests__/integration/aiOperatorIdentityOffboardingE2E.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/aiOperatorIdentityAdmission.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/aiOperatorRecipeReadiness.integration.test.ts`

**These MUST live under `apps/api/src/__tests__/integration/`** — a wrongly placed one runs ZERO tests and reads green.

Bring the stack up first: `pnpm test-stack up` at the repo root; `pnpm test-stack down` when the task is finished.

**What is faked and what is real.** Real: Postgres (as `breeze_app`, so RLS, the unique indexes and the deferrable FKs are all in force), every `ai_operator_*` table, `contacts`, `contact_external_links`, `tickets`, `ticket_checklist_items`, `action_intents`, the plan-approval tables, the coordinator, the advancers, the release-worker claim path. Faked: the two provider executors and the probe registry, through `registerEffectProbe` (E4's registry is explicitly test-seamed with `__resetEffectProbesForTest`) and a stubbed `executeM365ReadActionByOrg` / Google client. **Nothing about the state machine, the ordering, the tenancy or the approval is faked** — that is the point.

- [ ] **Step 1: `aiOperatorIdentityOffboardingE2E.integration.test.ts` — the happy path, in order**

One test that walks the whole spine and asserts the row state after each transition:

```
admit → contact + accounts frozen, one contact target, task queued
  ↳ assert: ai_operator_task_targets has target_kind='contact'; two
    ai_operator_task_target_accounts rows; UNIQUE (org_id, task_id, provider)
    rejects a third for the same provider (forge it, expect 23505).
intake → reasoning run admitted, prompt_version = 'identity_offboarding/v1'
confirm_identity → a real ticket_checklist_items row with source='operator_task';
  the task is waiting(information) with wait_dependency_kind='user_answer'
  ↳ tick it as a USER (patchChecklistItem) → outbox row → wake
discover → facts land on the discover step row's checkpoint; task.checkpoint
  .discoveryStepId points at it
review → plan proposed: ai_operator_plan_approvals pending + N
  ai_operator_plan_approval_effects rows; exactly ONE operator_plan intent
plan approve → markPlanApproved; task revision unchanged; approval 'approved'
effects → ONE ordinal per wake, IN PLAN ORDER
  ↳ assert after every wake: the set of settled operations is a PREFIX of the
    plan, and `google_suspend_user` / `m365_disable_user` have not settled while
    any mail-routing effect of that provider is unsettled. This is Task 4's
    property re-asserted against REAL ROWS, which is the only place it can be
    proven about the runtime rather than about the plan.
manual_work → every manual item exists on the ticket at once; the step binds to
  the first open one; ticking each advances the cursor
verify_outcome → verified_resolved (all observable probes satisfied; the only
  unknown is google_signout and the suspend is satisfied)
document → one internal ticket comment; its text contains each effect with its
  approver and each human-work item with its completer
```

- [ ] **Step 2: The five adversarial cases the brief requires**

Each is its own `it`, in the same file:

1. **Approval superseded by a discovered group.** After the plan is approved, insert a new group membership into the faked discovery and force a re-discovery; assert `bumpPlanRevision` supersedes the approval, the `operator_plan` intent is cancelled, no effect is dispatched under the stale approval, and `checkPlanEffectMembership` refuses with `revision_moved`. Then assert a **new** approval is proposed for the new revision.
2. **Stop mid-plan leaves a safe state.** Cancel the task after the mail effects and before the suspend; assert the account is **not** suspended, the mail effects **are** settled, the handoff summary lists the remaining ordinals, and nothing dispatches afterwards.
3. **Provider not ready degrades to human-work.** Set the M365 connection to `permission_manifest_version = 1` with no `MailboxSettings.ReadWrite` grant; assert `m365_set_auto_reply` is **absent from the plan** and a checklist item with generated instructions exists in its place, while every Google effect still dispatches. Then assert the task can still reach `verified_resolved` for what it did do — **degradation is not failure** (spec §4.1).
4. **Org-merge detach.** Merge the task's org into another; assert the contact target is **detached** in the merge's resolve phase with `detached_reason = 'org_merged'`, the human-work link is nulled, the task hands off, and **nothing dispatches under the dead tenant**. (E2 and E3 own the fences; this asserts they cover a contact-targeted task.)
5. **Ticket-move detach.** Move the task's ticket to another org; assert `ai_operator_task_steps.checklist_item_id` is nulled (never re-stamped — E3 decision 1), the task hands off with a readable reason, and the ticket move itself does **not** raise 23503.

- [ ] **Step 3: `aiOperatorIdentityAdmission.integration.test.ts`**

1. **Two concurrent admissions for the same contact: exactly one wins.** Fire both against the real advisory lock (two connections), assert one `{ ok: true }` and one `duplicate_live_task`, and assert exactly one task row exists.
2. Two concurrent admissions for **different** contacts both succeed — the lock is per contact, not global.
3. Two concurrent admissions for the same contact under **different recipe keys** both succeed.
4. Replay with the same `clientIdempotencyKey` returns `replayed: true` and the same task id, and creates no second target row.
5. A cross-tenant `contactId` is refused and **no row is written** — forge it as `breeze_app` and assert the RLS-scoped read finds nothing.
6. `upsertContactExternalLinks` is idempotent across two admissions and respects `contact_external_links_uniq (org_id, system, external_id)`.

- [ ] **Step 4: `aiOperatorRecipeReadiness.integration.test.ts`**

1. `GET /workflows` against a real org with a real `m365_connections` row on v1 returns `setup_required`, with the v2 roles named in `missingCapabilities`.
2. The same org after `permission_manifest_version = 2` and full `observed_grants` returns **`ready`**, with `missingCapabilities: []`, the three Exchange capabilities in `alwaysManualCapabilities`, and `manualStepCount: 3`. This is the assertion that proves the whole readiness rule end-to-end through the route's DTO, not just in the pure function.
3. An org with neither connection returns `unavailable`.
4. Readiness is **org-scoped**: a second org's connection does not make the first ready (the cross-tenant case, asserted as `breeze_app`).
5. With the recipe flag off, `unavailable` with `missingCapabilities: []` **and** `alwaysManualCapabilities: []` — a disabled recipe reports no gaps of either kind.

- [ ] **Step 5: Run them**

```
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiOperatorIdentityOffboardingE2E.integration.test.ts \
  src/__tests__/integration/aiOperatorIdentityAdmission.integration.test.ts \
  src/__tests__/integration/aiOperatorRecipeReadiness.integration.test.ts
```
Expected: 3 files, ~22 tests, all passing. **A 0-test run means the files are in the wrong directory** — check the path before anything else.

- [ ] **Step 6: Commit**

```
git add apps/api/src/__tests__/integration/
git commit -m "$(cat <<'EOF'
test(api): identity_offboarding end-to-end and adversarial integration suites (R1)

Real Postgres as breeze_app with faked provider executors: the full spine, the
prefix-safety property asserted against real operation rows, approval
supersession by a discovered group, a safe mid-plan stop, per-provider
degradation to human work, and the org-merge / ticket-move detaches.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Contract suites, registration re-derivation, review, and the R1a PR — then STOP

- [ ] **Step 1: Re-derive the registration claim rather than asserting it**

This wave claims to add no table and no column. Prove it:

```
git diff --stat main -- apps/api/migrations/
grep -rn "pgTable(" apps/api/src/db/schema/ | wc -l     # compare to main
git diff main -- apps/api/src/db/schema/ | grep -E '^\+.*(uuid|text|jsonb|timestamp|boolean|integer)\('
```
Expected: the first is empty, the second is unchanged, the third is empty. If the third prints anything, a column was added and **every** list in CLAUDE.md's cascade-registration table re-fires — stop and add those steps before continuing.

Then run the contract suites anyway, because "no new table" is a claim and these are the five-for-five detectors:

```
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: 5 files, all passing, and — critically — **unchanged counts** versus `main`.

- [ ] **Step 2: The guards other waves left that this wave must not break**

```
cd apps/api && npx vitest run \
  src/services/aiOperator/ \
  src/services/aiToolsGoogle.accountWipe.test.ts \
  src/services/googleToolsHeadless.test.ts \
  src/services/aiGuardrailsTierConfig.parity.test.ts \
  src/services/aiAgents/agentToolCatalog.contract.test.ts \
  src/services/actionIntents/effectDigestCoverage.contract.test.ts \
  src/routes/aiOperatorTasks.test.ts \
  src/config/envComposeParity.test.ts \
  src/db/autoMigrate.test.ts \
  src/db/migrationRlsScope.test.ts
cd packages/shared && npx vitest run src/
cd apps/web && npx vitest run src/components/ai-risk src/components/aiOperator src/lib/i18n
```

Named explicitly because each one has a reason to fire here: `agentToolCatalog.contract.test.ts` (the new Google tool needs its `TOOL_CAPABILITY` entry), `googleToolsHeadless.test.ts` (the tier-3 ↔ headless parity invariant), `effectDigestCoverage.contract.test.ts` (a new four-eyes tool must resolve or be exempted), `envComposeParity.test.ts` (the new flag), `migrationRlsScope.test.ts` and `autoMigrate.test.ts` (both must be **unchanged** — this wave writes no migration, and **never add a file to the frozen 122-offender baseline**), and E3's `no AI Operator code path writes done_at` guard (inside `src/services/aiOperator/`).

- [ ] **Step 3: Full typecheck and lint**

```
cd packages/shared && npx tsc --noEmit -p tsconfig.json
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd apps/web && npx tsc --noEmit -p tsconfig.json
pnpm lint
```

- [ ] **Step 4: One independent code-review round**

Use `/pr-review-toolkit:review-pr` on the branch. Give the reviewer these four questions explicitly, because they are the ones a generic review will miss:

1. Can any code path reach `discover` without `confirm_identity` having been completed by a human?
2. Can any code path emit `google_wipe_mobile_device`, `google_offboard_user`, or an `m365_remove_license` effect while `keepMailbox` is true?
3. Can a degraded effect reach `proposePlanApproval`, i.e. can an approver be asked to authorize something that can only fail?
4. Does any advancer throw rather than settle?

Act on confirmed, consequential findings only. Cap at one round unless a fix touches admission, the plan, or the ordering.

- [ ] **Step 5: Tear the stack down, open the PR, STOP**

```
pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Expected: nothing this session brought up is still listed.

```
gh pr create --title "R1a — identity_offboarding recipe, discovery, readiness and admission" --body "$(cat <<'EOF'
## What

Wave R1a of the Operator Recipe Library: the `identity_offboarding` recipe and
everything server-side it needs. The recipe's flag ships **off** and is not
enabled by this PR.

- `StepDefinition.next` — optional, additive; deterministic spine sequencing is
  recipe data, resolved by the coordinator into E3's `resumeStepKey`.
  `permittedNextSteps` keeps its meaning (the model-proposal set) and
  `service_recovery` is bit-for-bit unchanged.
- `recipes/identityOffboarding.ts` — pure. Granular Google tools and M1's eight
  M365 actions, in the spec §6.3 safety order, disable/suspend last.
- `google_account_wipe_mobile_device` — **new**. `google_wipe_mobile_device` is
  `admin_remote_wipe`, a full factory reset, and its own description says it is
  not for offboarding; the selective wipe existed only inside the
  `google_offboard_user` composite.
- `identityDiscovery.ts` — bounded, total, coordinator-issued provider reads.
- `recipeReadiness.ts` + `GET /ai/operator/workflows` — per-capability
  readiness with per-provider degradation to human work.
  `setup_required` means "something this tenant can fix": unsatisfied
  capabilities are partitioned by a new optional
  `CapabilityRequirement.availability`, so the three pre-M2 Exchange gaps
  report as `manualStepCount` instead of pinning a fully-consented org at
  "setup required" forever. Flipping them when M2 ships is a one-field change.
- `admitTask` — generalized admission; contact resolve-or-create, external-link
  upsert, frozen provider accounts, one live task per (contact, recipe) under a
  transaction-scoped advisory lock. `admitServiceRecoveryTask` survives as a
  thin wrapper so the two suites that mock it by name are untouched.
- The completion record: bounded text, posted as an internal ticket comment.

## Risky

- **Ordering is the safety contract.** `identityOffboarding.ordering.test.ts`
  asserts, over a 24-case cross-product and every prefix of every plan, that no
  reachable state is "disabled with mail unrouted", and that `keepMailbox`
  removes `m365_remove_license` from the plan entirely. Its discrimination was
  proved by mutation, not by absence.
- `admitTask` changes the shipped admission path. `routes/aiOperatorTasks.test.ts`
  and `aiOperatorAdmission.integration.test.ts` pass **unmodified**.
- No migration, no new table, no new column — re-derived, not assumed, and all
  five tenancy contract suites run with unchanged counts.

## Verification

Unit + shared + web suites, three new integration suites against real Postgres
as `breeze_app`, the five tenancy contract suites, `agentToolCatalog`,
`googleToolsHeadless`, `effectDigestCoverage`, `envComposeParity`,
`autoMigrate` and `migrationRlsScope` guards, three typechecks, lint. One
independent review round recorded on the PR.

## Not in this PR

The web surface (R1b) and the deterministic release gate + lab run (R1c). The
flag stays off until R1c's lab run passes.

Closes #<wave sub-issue>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**STOP here.** Do not merge. Do not `--admin`.

---

# PART R1b — the web surface

Cut this branch from R1a's. Because it is a stacked PR, `ci.yml` runs **nothing** on it (`pull_request: branches: [main]`), so `gh pr checks` will read green while no job ran — dispatch `gh workflow run CI --ref <branch>` before asking for a merge, and re-target to `main` once R1a lands.

### Task 16: The API client and the readiness hook

**Files:**
- Create: `apps/web/src/lib/api/aiOperatorWorkflows.ts`
- Create: `apps/web/src/lib/api/aiOperatorWorkflows.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function fetchOperatorWorkflows(orgId: string): Promise<AiOperatorWorkflowDto[]>;
  export async function createOperatorTaskDraft(body: OperatorTaskDraftInput): Promise<OperatorTaskDraftResult>;
  export async function startOperatorTask(body: CreateOperatorTaskInput): Promise<{ taskId: string }>;
  export async function addToolsToAgent(agentId: string, toolNames: string[]): Promise<void>;
  ```

**Rules:**
- Every one of the four goes through `runAction` (`apps/web/src/lib/runAction.ts`) at its **call site**, and the catch pattern is the repo's:
  ```ts
  if (err instanceof ActionError && err.status === 401) return;
  if (!(err instanceof ActionError)) showToast({ type: 'error', … });
  ```
- `addToolsToAgent` is a `PATCH /api/v1/ai/agents/:id` with `{ toolAllowlist: [...existing, ...missing] }` — it **adds**, never replaces, and never removes a tool the partner put there. Read the agent first, union, send. The route (`routes/aiAgents.ts:2153`) requires MFA; the UI must surface a step-up prompt rather than swallowing a 401/403.
- `fetchWithAuth` auto-injects `orgId` (memory: `web_fetchwithauth_autoinjects_orgid`) — pass `orgId` explicitly anyway for the workflows call, because the Library is launched from a ticket whose org may not be the session's current one.

Tests: one per function for the happy path, one asserting the union semantics of `addToolsToAgent`, one asserting a non-2xx surfaces as an `ActionError`.

### Task 17: `RecipeCard` + `RecipeLibrary`

**Files:**
- Create: `apps/web/src/components/aiOperator/RecipeCard.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/components/aiOperator/RecipeLibrary.tsx` (+ `.test.tsx`)

`RecipeCard` renders one `AiOperatorWorkflowDto`:
- Title, one-line summary, and a readiness chip: **Ready** / **Setup required** / **Unavailable**, driven by `readiness` alone.
- **`missingCapabilities` and `alwaysManualCapabilities` are two DIFFERENT blocks, and only the first is "setup".**
  - `missingCapabilities` (tenant-fixable) → a **Setup required** block: each capability as a row with its plain-language `detail` and, where `action.kind` is not `'none'`, a deep link — `reconsent_m365` → the org's M365 integration card; `connect_google` / `connect_m365` → the integrations page; `add_agent_tools` → an inline "Allow these tools for the helpdesk agent" button wired to `addToolsToAgent` through `runAction`.
  - `alwaysManualCapabilities` (product gaps) → a quieter **"{{count}} steps will be done by hand"** line, keyed off `manualStepCount`, expandable to the list with each `detail`. It carries **no action link and no warning styling**: there is nothing for the reader to fix, and dressing it as a problem is how a permanent badge gets ignored. A card may be `ready` **and** show this line — that is the normal state of this wave, and it reads *"Ready · 3 steps will be done by hand"*.
- A separate expandable **"what will be done by hand"** detail listing `degradedEffects`, which is the union of both partitions' tools.
- The primary action is **Offboard a person**, enabled on `ready` **and** on `setup_required` (the recipe runs, degraded — spec §4.1's whole premise), disabled only on `unavailable` with the reason as its tooltip — never a silently dead button.
- `data-testid`: `recipe-card-<recipeKey>`, `recipe-readiness-<recipeKey>`, `recipe-missing-<capabilityKey>`, `recipe-manual-<capabilityKey>`, `recipe-manual-count-<recipeKey>`, `recipe-start-<recipeKey>`, `recipe-degraded-<recipeKey>`.

`RecipeLibrary` fetches, renders the cards, and handles the three non-happy states explicitly: loading skeleton, fetch error with a retry, and an empty list ("no recipes are available for this organization yet") — **never** a blank panel. Selected card lives in `window.location.hash` (`#recipe=identity_offboarding`), never a query param.

Tests: readiness chip per state; a `tenant_fixable` capability renders its action link; the start button is enabled on `setup_required` and disabled only on `unavailable`, with the reason as its tooltip; `addToolsToAgent` is called with only the **missing** tools; the hash round-trips; all three non-happy states render something. Plus the three the readiness change exists for:

- A card with `readiness: 'ready'` and `manualStepCount: 3` renders **both** the Ready chip and the "3 steps will be done by hand" line — the normal state of this wave, asserted as one DOM state rather than two.
- An `alwaysManualCapabilities` row renders **no** action link and is **not** inside the Setup-required block — assert `recipe-manual-<key>` exists, has no anchor or button descendant, and is not a descendant of the setup block's testid.
- A `missingCapabilities` row **does** render its action and **is** inside the Setup-required block, on the same card, so the two blocks are proven distinct rather than merely both present.

### Task 18: MOUNT — `/operator` index page

**Files:**
- Create: `apps/web/src/pages/operator/index.astro`
- Create: `apps/web/src/components/aiOperator/OperatorWorkspace.tsx` (+ `.test.tsx`)

There is **no** `/operator` index page today — `apps/web/src/pages/operator/` contains only `tasks/[taskId].astro`. This task creates the workspace shell with two tabs, **Tasks** and **Library**, tab state in `window.location.hash` (`#tab=library`), and mounts `RecipeLibrary` in the Library tab.

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import OperatorWorkspace from '../../components/aiOperator/OperatorWorkspace';
---
<DashboardLayout title="Operator">
  <OperatorWorkspace client:load />
</DashboardLayout>
```

**The MOUNT proof** (`OperatorWorkspace.test.tsx`), because a previous wave shipped 13 green components that were never wired into a page:
1. Rendering `OperatorWorkspace` with `#tab=library` renders a `recipe-card-identity_offboarding` — i.e. the page really contains the Library, asserted through the component the page mounts, not through `RecipeLibrary` in isolation.
2. `#tab=tasks` (and no hash) renders the task list, not the library.
3. Switching tabs updates the hash and does not remount the other tab's data.
4. A source-level assertion that the Astro page imports the component:
   ```ts
   const page = readFileSync(join(__dirname, '../../pages/operator/index.astro'), 'utf8');
   expect(page).toContain('OperatorWorkspace');
   expect(page).toContain('client:load');
   ```
   A component with no island directive renders nothing at runtime and every DOM test would still pass — this is the one assertion that catches it.

Also add the left-nav entry for `/operator` if the nav is data-driven (grep `breeze_left_nav_gate_inventory`-style config), gated on the same `features.aiOperatorTasks` flag `routes/config.ts:26` already exposes.

### Task 19: `StartRecipeForm`, launched from a ticket and from a contact

**Files:**
- Create: `apps/web/src/components/aiOperator/StartRecipeForm.tsx` (+ `.test.tsx`)

One form, three launch contexts (library, ticket, contact), driven by props rather than by three components:

| Field | Behaviour |
|---|---|
| Person | Pre-filled and read-only when launched from a contact; pre-filled from the ticket requester when launched from a ticket (editable); free-text hint in the library. Sends `contactId` **or** `personHint`, never both. |
| Inheritor | Contact picker **or** a raw address, mutually exclusive in the UI as well as in the schema. |
| Auto-reply message | Textarea with a generated default the technician can edit; the default names the inheritor when one is chosen. |
| Cutoff | Optional date-time; empty means "start now", and the form says that in words. |
| Keep mailbox | Checkbox whose helper text states the consequence: *"Breeze will leave the Microsoft 365 licence in place and add a manual step to convert the mailbox to shared. Removing the licence first would start the mailbox's 30-day deletion clock."* |
| Per-effect toggles | Eight switches, defaults from the schema, each with one line of helper text. The mobile wipe's says *"Removes the work account from enrolled phones. The device itself is not erased."* |
| Devices | The `suggestedDevices` from a draft call, each **unchecked by default**, each labelled with the match basis (*"last signed-in user matched"*) so nobody mistakes a guess for a fact. |

Before submit the form calls `createOperatorTaskDraft` and shows the **preview**: the effects it would dispatch, grouped by provider and in order, and the human-work items it would create. Submit calls `startOperatorTask` through `runAction` and navigates to `/operator/tasks/<id>`.

`data-testid`: `start-recipe-form`, `start-recipe-person`, `start-recipe-inheritor`, `start-recipe-cutoff`, `start-recipe-keep-mailbox`, `start-recipe-effect-<toggle>`, `start-recipe-device-<deviceId>`, `start-recipe-preview`, `start-recipe-submit`.

Tests: mutual exclusion of person fields and of inheritor fields (the UI disables the other, and submitting both is impossible); the device suggestions are unchecked by default and labelled with the basis; the preview renders the draft's effects in order; a 409 `duplicate_live_task` surfaces the existing task with a link to it rather than a generic error; every mutation goes through `runAction` (assert via the `no-silent-mutations` guard — do **not** add an allowlist entry).

### Task 20: MOUNT — the two launch points

**Files:**
- Modify: the ticket detail page's actions area (grep `apps/web/src/components/tickets/` for where `DelegateToOperatorButton` or the ticket action menu lives)
- Modify: the contact panel (grep `apps/web/src/components/organizations/` / `contacts/` for the contact detail surface)
- Create/extend: the page-level tests for **both**

Two MOUNT proofs, each asserting that the real page renders the launcher and that clicking it opens `StartRecipeForm` with the context pre-filled:

1. From a ticket: the form opens with `contactId` = the ticket requester's contact and the ticket id carried through as `sourceKind: 'ticket'` / `sourceId`.
2. From a contact: the form opens with that contact, read-only, and no ticket source.

Both are hidden when `features.aiOperatorTasks` is false **and** when the recipe's readiness is `unavailable` — a launcher that opens a form that cannot submit is worse than no launcher.

### Task 21: The task page — steps, plan, timeline

**Files:**
- Create: `apps/web/src/components/aiOperator/OperatorTaskSteps.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/components/aiOperator/OperatorTaskPlan.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/components/aiOperator/OperatorTaskEvents.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/aiOperator/OperatorTaskDetail.tsx` — **the MOUNT**
- Modify: `apps/web/src/components/aiOperator/OperatorTaskDetail.test.tsx`

`GET /tasks/:id` already gained `steps`, `targets`, `events` (E2 Task 12) and `plan` (E4). This task renders them.

- **`OperatorTaskSteps`** — the spine in order, each with its kind, state, and for a `human_work` step a **link to its ticket checklist item** plus who completed it. The current step is visually distinct. A waiting step says what it is waiting for in words ("waiting for a technician to tick *Collect Dana's laptop*").
- **`OperatorTaskPlan`** — effects **grouped by provider**, in ordinal order, each with the **frozen** target label and principal label (spec §6.4: "the target's frozen labels"), its idempotency class, its result, its probe verdict, and its approver. A superseded revision is shown as superseded, not hidden — the record of what was approved and then changed is the audit story.
- **`OperatorTaskEvents`** — the `ai_operator_task_events` timeline, newest last, with the actor kind. Bounded (paginate or cap at 200 with a "show all" that refetches).
- **The MOUNT**: all three rendered inside `OperatorTaskDetail`, with the selected panel in `window.location.hash` (`#panel=plan`), and `OperatorTaskDetail.test.tsx` extended with one case per panel asserting the child's `data-testid` is present **through the parent**.

`data-testid`: `task-steps`, `task-step-<stepKey>`, `task-plan`, `task-plan-provider-<provider>`, `task-plan-effect-<ordinal>`, `task-events`, `task-event-<seq>`.

### Task 22: i18n ×8, the e2e spec, and the R1b PR — then STOP

- [ ] **Step 1: Real translations in all eight locales**

Every new key goes into `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/aiOperator.json` under a new `recipeLibrary` / `startRecipe` / `taskPanels` namespace. **Real translations, not English copies** — `tr-TR` with English strings fails review and defeats the parity test's intent. Consult `apps/web/src/locales/TERMINOLOGY.md` for the established rendering of "recipe", "task", "approval", "checklist" per locale; if a term is not there, add it.

The readiness strings are the ones to get right, because they are the claim the badge makes. Three separate keys, never one reused:

```
recipeLibrary.readiness.ready            "Ready"
recipeLibrary.readiness.setupRequired    "Setup required"
recipeLibrary.readiness.unavailable      "Not available"
recipeLibrary.setupBlock.title           "Setup required"          // tenant-fixable only
recipeLibrary.manualSteps.count          "{{count}} steps will be done by hand"
recipeLibrary.manualSteps.count_one      "1 step will be done by hand"
recipeLibrary.manualSteps.expand         "See which steps"
recipeLibrary.manualSteps.explainer      "Breeze does not automate these yet. The task will add them to the ticket as checklist items."
```

`manualSteps.*` must **not** be phrased as a warning or as something the reader can fix, in any locale — it is a statement about the product, and a locale that renders it as "action required" reintroduces exactly the permanent-badge problem this change removes. `count` needs the plural forms each locale requires (`_one`/`_other`, and the extra categories `pt-BR` and `tr-TR` use); `localeParity.test.ts` checks key presence, not plural completeness, so check the forms by hand against a sibling key that already pluralizes.

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/locales/`
Expected: PASS. A key present in `en` and missing anywhere else fails here.

- [ ] **Step 2: One e2e spec**

**Files:** `e2e-tests/tests/operator-recipe-library.spec.ts`, `e2e-tests/pages/OperatorLibraryPage.ts`

Page Object + spec, querying **`data-testid` only** (never text, role or CSS — `e2e-tests/README.md`'s convention). One flow, with the flag forced on for the test stack: open `/operator#tab=library`, assert the offboarding card and its readiness chip, open the start form from a contact, fill it, assert the preview lists the effects grouped by provider, submit, land on the task page, assert the step list and the plan panel render.

Run: `cd e2e-tests && pnpm test operator-recipe-library`
Expected: 1 spec passing against a stack with `AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED=true` in the test stack's env **only** — never in a tracked default.

- [ ] **Step 3: Full web verification**

```
cd apps/web && npx vitest run src/components/aiOperator src/lib/api src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts && npx tsc --noEmit -p tsconfig.json
pnpm lint
```
Expected: PASS. `no-silent-mutations` must pass **without** a new `runActionAllowlist.ts` entry.

- [ ] **Step 4: Review round, then the PR, then STOP**

Ask the reviewer specifically: is any mutation in these components not wrapped in `runAction`; is any device suggestion presented as a fact rather than a guess; is `addToolsToAgent` capable of removing a tool; and does any surface render a blank panel on error.

```
gh pr create --title "R1b — Operator Recipe Library web surface" --body "$(cat <<'EOF'
## What

The web half of R1: a Library tab on a new `/operator` workspace page, a start
form launched from the library, a ticket and a contact, and the task page
extended with the step list, the plan grouped by provider with frozen labels,
and the event timeline. Real translations in all eight locales. One Playwright
spec.

## Risky

- Three explicit MOUNT tasks with page-level proofs, including a source-level
  assertion that the Astro page carries `client:load` — a component with no
  island directive renders nothing at runtime while every DOM test still
  passes.
- Device suggestions are labelled with their match basis (`devices.last_user`
  ILIKE) and unchecked by default. They are never effect targets.
- "Allow these tools for the helpdesk agent" reads the agent, unions the
  missing tools and PATCHes — it can never remove a tool a partner set.

## Verification

Web unit suites, `localeParity`, `no-silent-mutations` (no new allowlist
entry), typecheck, lint, one e2e spec. One independent review round.

Stacked on R1a — `ci.yml` does not run on a PR whose base is not `main`, so CI
was dispatched per branch with `gh workflow run CI --ref`.

Closes #<wave sub-issue>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**STOP.**

---

# PART R1c — the deterministic release gate (spec §9)

Spec §9's `deterministic` gate has six clauses. Each is a task here, and the flag stays **off** at the end: the PR ships the gate, not the enablement.

| Clause | Task |
|---|---|
| (a) contract test per effect: pre-probe, write, post-probe, replay-is-noop, against **recorded provider fixtures** | 23, 24 |
| (b) ordering test: stopping after any step leaves no disabled-with-unrouted-mail state | already shipped in R1a Task 4 and re-asserted against real rows in Task 14; Task 25 adds the **dispatch-prefix** form |
| (c) plan-approval membership tests including revision supersede | 25 |
| (d) ≥ 20 evaluated intake/discovery cases with **zero** wrong-person resolutions accepted without human confirmation | 26 |
| (e) zero unauthorized or duplicate effects in a **lab run** against a real M365 developer tenant and a real Google Workspace test domain | 27 |
| (f) own flag | shipped in R1a Task 13; Task 28 records that it is still off |

### Task 23: Record the provider fixtures

**Files:**
- Create: `apps/api/src/services/aiOperator/__fixtures__/providers/README.md`
- Create: `apps/api/src/services/aiOperator/__fixtures__/providers/google-*.json` (11 files)
- Create: `apps/api/src/services/aiOperator/__fixtures__/providers/m365-*.json` (12 files)

**A fixture is a recorded response shape, never a live credential and never real customer data.** The README states the rule and the recording procedure:

- Every fixture is the **shape** of a provider response with every identifier replaced by a stable synthetic value (`dana@customer.example`, `101`, `obj-1`, `mg1`). No real tenant id, no real domain, no token, no key, no email that resolves.
- One fixture per `(effect, probe-phase, outcome)` triple the contract test needs: for each of the 14 effect tools, a pre-probe **already-satisfied** response, a pre-probe **unsatisfied** response, a successful write response, a post-probe **satisfied** response, and — where the action has a typed refusal — that refusal (`unsupported_group_type`, `license_unavailable`, `consent_upgrade_required`, `graph_not_found`).
- Fixtures are **checked in**, because the gate must be reproducible in CI without provider credentials. They are recorded once, during the lab run (Task 27), from the developer tenant and test domain — and the README says which lab run produced them and on what date, so a future reader can tell a recording from a guess.
- **Recording procedure:** run the lab-run checklist with `BREEZE_RECORD_PROVIDER_FIXTURES=1` set, which makes the executor stubs in `effectContracts.test.ts` write what they observed. That env var exists **only** in the test harness and is never read by production code — assert that with a grep case in Task 24.

Until the lab run happens, the fixtures are authored from the Graph and Directory API reference and **marked `"_source": "reference"`** in each file; Task 27 replaces them with `"_source": "lab-run-2026-XX-XX"`. A fixture still marked `reference` when the gate is signed off is a gate failure, and Task 28's checklist says so.

### Task 24: (a) Per-effect contract tests — pre-probe, write, post-probe, replay-is-noop

**Files:**
- Create: `apps/api/src/services/aiOperator/effectContracts.test.ts`

One `describe` per effect tool in `IDENTITY_OFFBOARDING_EFFECT_TOOLS` — **driven off the constant**, so a tool added to the catalog without a contract test fails this file rather than shipping unverified:

```ts
/**
 * Spec §9(a) — the deterministic gate's per-effect contract.
 *
 * For every effect in the recipe's CLOSED catalog, four properties against
 * recorded provider fixtures:
 *
 *   1. PRE-PROBE SHORT-CIRCUITS. When the pre-probe observes the desired end
 *      state, the operation settles `succeeded` with `result.noop = true` and
 *      NO write is dispatched. This is what makes replay safe without an
 *      idempotency key, which neither Graph nor the Directory API offers
 *      (spec §6.6).
 *   2. WRITE IS DISPATCHED when the pre-probe does not observe it.
 *   3. POST-PROBE IS THE VERIFICATION. A successful write call never implies a
 *      successful effect (Operator spec §13).
 *   4. REPLAY IS A NO-OP BY OBSERVATION. Dispatching the same effect twice
 *      performs the write once; the second pass is property 1.
 *
 * The catalog drives the suite, so a fourteenth tool with no fixtures is a red
 * here and not a silent gap.
 */
for (const toolName of IDENTITY_OFFBOARDING_EFFECT_TOOLS) {
  describe(`effect contract: ${toolName}`, () => {
    it('pre-probe satisfied → settles noop and dispatches NO write', async () => { /* … */ });
    it('pre-probe unsatisfied → dispatches the write', async () => { /* … */ });
    it('post-probe unsatisfied → the effect is NOT verified even though the write returned 200', async () => { /* … */ });
    it('post-probe satisfied → verified', async () => { /* … */ });
    it('replay performs the write exactly once', async () => { /* … */ });
    it('declares an idempotency class, and a non_idempotent one is never auto-retried', async () => { /* … */ });
  });
}

describe('the unobservable exceptions are explicit, not accidental', () => {
  it('google_signout probes `unknown` in BOTH phases and names its subsuming criterion', async () => { /* … */ });
  it('every tool in the catalog either has a probe registered or is declared unobservable', async () => {
    const probed = new Set(listProbedTools());
    for (const t of IDENTITY_OFFBOARDING_EFFECT_TOOLS) {
      const declared = Object.hasOwn(IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS, t);
      expect(probed.has(t) || declared, `${t} has neither a probe nor an unobservable declaration`).toBe(true);
    }
  });
});

describe('the recording harness never reaches production', () => {
  it('BREEZE_RECORD_PROVIDER_FIXTURES is read only by test files', () => {
    // grep the api src tree; the only hits may be *.test.ts / __fixtures__.
  });
});

describe('every fixture is a recording, not a guess', () => {
  it('no fixture is still marked _source: "reference"', () => {
    // This case is EXPECTED TO FAIL until Task 27's lab run replaces them, and
    // that failure is the gate. Do not skip it; do not weaken it.
  });
});
```

Run: `cd apps/api && npx vitest run src/services/aiOperator/effectContracts.test.ts`
Expected before the lab run: PASS except the single `_source` case, which fails by design and is the gate's own tripwire. Record that expectation in the commit message so nobody "fixes" it by editing the fixtures' metadata.

### Task 25: (b, c) Dispatch-prefix ordering and plan-approval membership

**Files:**
- Create: `apps/api/src/__tests__/integration/aiOperatorIdentityGate.integration.test.ts`

Task 4 proved the property about the **plan**; Task 14 proved it about a **happy-path run**. This file proves it about **every stopping point of a real dispatch**, and adds the membership cases spec §9(c) names.

Ordering, over real rows:
1. For each `k` in `0..plan.length`, drive the task until exactly `k` effects have settled, then assert the invariant against `ai_operator_operations`: for each provider, if the lockout effect has settled, every mail-routing effect of that provider has settled. Driven as a loop over a freshly admitted task per `k` — slower, but the property is about independent stopping points, not about one run observed repeatedly.
2. A task cancelled at each `k` records the remaining ordinals in its handoff summary, and **no operation settles after the cancel**.

Membership (spec §9(c), against E4's `checkPlanEffectMembership` and `revalidateRelease`'s `plan_approval` arm):
3. An effect whose `(task_id, plan_revision, ordinal, argument_digest)` is in the approved set releases.
4. An effect with a mutated argument is refused `argument_digest_mismatch` — mutate the intent's arguments row directly and assert the refusal happens **at release**, from rows.
5. An effect with an ordinal outside the set is refused `effect_not_in_set`.
6. An effect whose tool is not in the set is refused `tool_not_in_set`.
7. After `bumpPlanRevision`, a child effect minted under the old revision is refused `revision_moved`, and the `operator_plan` intent for the old revision is cancelled.
8. A plan whose effect ROWS are mutated under a live approval fails `digest_mismatch` at `computeEffectDigestForRelease` — **before** membership even runs (E4's D-E4-4's two independent seals).
9. An effect naming a tool absent from the admitting agent's frozen `toolAllowlist` is refused `tool_not_in_agent_allowlist` at mint **and** at release (E4's ceiling, asserted for this recipe's tools specifically).
10. The requester of the plan intent cannot approve it — the four-eyes rule, asserted end-to-end for `operator_plan`.

Run with the stack up:
```
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiOperatorIdentityGate.integration.test.ts
pnpm test-stack down
```
Expected: 1 file, ~20 tests (the ordering loop generates one per `k`).

### Task 26: (d) The eval harness and ≥ 20 intake/discovery cases

**There is no AI eval harness in this repo.** Verified: no `evals/` directory, no `*.eval.ts`, no eval runner script; the only "eval" hits are `agent/internal/peripheral/evaluate*.go`, which grade sensor readings. So R1c builds the first one, deliberately small, and puts it where the next recipe will find it.

**Files:**
- Create: `apps/api/src/services/aiOperator/evals/README.md`
- Create: `apps/api/src/services/aiOperator/evals/identityIntake.cases.json`
- Create: `apps/api/src/services/aiOperator/evals/identityIntake.eval.test.ts`

**Shape:** a JSON corpus plus an ordinary Vitest file, run by the ordinary test command. It is **not** a bespoke runner and **not** a script — a gate that needs its own tooling is a gate that stops being run.

```
apps/api/src/services/aiOperator/evals/
  README.md                      # what an eval is here, how to add a case, how to run it
  identityIntake.cases.json      # the corpus: ≥ 20 cases
  identityIntake.eval.test.ts    # the grader
```

Each case:

```json
{
  "id": "two-danas-same-org",
  "kind": "intake",
  "hint": "Dana in accounting",
  "orgContacts": [
    { "contactId": "…001", "name": "Dana Whitfield", "email": "dana@customer.example", "title": "Accounts Payable" },
    { "contactId": "…002", "name": "Dana Okoro", "email": "d.okoro@customer.example", "title": "Warehouse" }
  ],
  "expect": {
    "ambiguous": true,
    "mustIncludeContactIds": ["…001"],
    "mustNotResolveWithoutHumanConfirmation": true
  }
}
```

**The corpus must cover, at minimum (that is the ≥ 20):** an exact email match; an exact full-name match; a first-name-only match with one candidate; a first-name-only match with two candidates in different departments; a nickname ("Danny" for "Daniel"); a married-name change; two people with the same surname; a hint naming a **department** and no person; a hint naming a person not in the org at all; a hint that is an email at a **different** domain; a hint containing a role rather than a name ("the new bookkeeper"); a contact with no email; a contact with no name (email only — the schema allows it); a service account that looks like a person ("Accounts Payable <ap@…>"); a shared mailbox presented as a person; a person present in M365 but not in `contacts`; a person in `contacts` with no provider account; a hint with a typo; a hint in a non-Latin script; a hint that is empty after trimming.

**The grader asserts three things, and the third is the gate:**

1. Every model output **parses** against `identityIntakeOutputSchema` and passes `validateIntakeOutput` against the case's org contact set — a hallucinated id is a hard fail, not a scored miss.
2. For every case with `mustIncludeContactIds`, the correct contact is **among** the candidates (recall, not precision — proposing two Danas is correct behaviour).
3. **ZERO wrong-person resolutions accepted without human confirmation.** Stated as a property of the *pipeline*, not of the model: for every case, `advanceIntake`'s transition target is `confirm_identity`, the step it opens is `human_work`, and no code path in the recipe or the advancers sets a contact target's state to confirmed without a `done_by_user_id`. Asserted structurally (the step graph and the `done_at` guard) **and** per case (the advancer's output). A case where the model picks the wrong Dana must still be a **pass** for the gate and a **flag** in the report, because the human is the control — the gate fails only if the pipeline would have acted on it.

The grader runs in two modes:
- **Default (CI):** replays **recorded** model outputs stored beside each case (`"recorded": { … }`). Deterministic, no API key, runs in `test-api`.
- **`BREEZE_EVAL_LIVE=1`:** calls the real model through the same run path, rewrites the recordings, and prints the report. Run by hand before the gate is signed off, and after any `IDENTITY_OFFBOARDING_PROMPT_VERSION` bump — the README says that bumping the prompt version without re-running live invalidates the gate.

Run: `cd apps/api && npx vitest run src/services/aiOperator/evals/identityIntake.eval.test.ts`
Expected: 1 file, ≥ 22 tests (20 cases + the three structural properties). **Check the case count in the output** — a corpus file that failed to load reads as a green 1-test run, which is exactly the vacuous pass this gate exists to prevent, so the file's first assertion is `expect(cases.length).toBeGreaterThanOrEqual(20)`.

### Task 27: (e) The lab run

**Files:**
- Create: `docs/superpowers/qa/2026-09-17-identity-offboarding-lab-run.md`

A dated checklist doc, filled in **by hand** against a real Microsoft 365 developer tenant and a real Google Workspace test domain, on a non-production rig. It is the gate's evidence artifact and it is committed.

**The doc's structure:**

1. **Environment** — tenant id and domain **redacted to the last four characters**, the Breeze version, the branch sha, the flag state, the operator's name, the date. Never a real tenant id in the repo (CLAUDE.md: no internal infrastructure details in public code).
2. **Setup** — two synthetic leavers per provider: one plain (licence, two groups, a phone), one awkward (sole owner of a group, dynamic-membership group, role-assignable group, a shared mailbox in their delegates).
3. **Per-effect rows**, one per tool in the catalog × the plain leaver: dispatched? pre-probe verdict? write result? post-probe verdict? **replay → no-op?** Provider audit-log line id. A row is PASS only when the post-probe is `satisfied` **and** the replay observed a no-op **and** the provider's own audit log shows exactly **one** write.
4. **Ordering evidence** — the plan as approved, and the provider audit log timestamps proving the mail effects preceded the suspend/disable **in the provider's own record**, not merely in Breeze's.
5. **The awkward leaver** — evidence that the dynamic and role-assignable groups produced human-work items and **no** membership call (cross-checked against the tenant audit log: zero `Remove member from group` entries for those two), and that the sole-owned group produced a confirmation item.
6. **`keepMailbox`** — evidence that **no** `assignLicense` removal call was made and that the shared-mailbox conversion item appeared.
7. **Zero unauthorized effects** — the full provider audit log for the run window, and a line-by-line reconciliation against `ai_operator_plan_approval_effects`. **Every** write in the log must map to exactly one approved effect row. An unmapped write is a gate failure and a security finding, not a footnote.
8. **Zero duplicate effects** — the same reconciliation, checked for cardinality.
9. **Fixtures recorded** — the list of fixture files replaced, and confirmation that every `_source` is now `lab-run-<date>`.
10. **Sign-off** — PASS/FAIL per §9 clause (a)–(f), the operator's name, and the date. A FAIL lists the follow-up issue.
11. **Teardown** — the synthetic users suspended/deleted, the test devices unenrolled, the stack torn down, and a statement of what was left running.

The doc ships with every row `TODO` and the header saying so in bold; it is filled in when the rig is available. **The flag is not enabled in any environment until every row is PASS**, and Task 28's PR body repeats that.

### Task 28: The gate summary and the R1c PR — then STOP

- [ ] **Step 1: Run the whole gate**

```
cd apps/api && npx vitest run \
  src/services/aiOperator/recipes/identityOffboarding.test.ts \
  src/services/aiOperator/recipes/identityOffboarding.ordering.test.ts \
  src/services/aiOperator/effectContracts.test.ts \
  src/services/aiOperator/evals/identityIntake.eval.test.ts
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiOperatorIdentityGate.integration.test.ts \
  src/__tests__/integration/aiOperatorIdentityOffboardingE2E.integration.test.ts
pnpm test-stack down
```

- [ ] **Step 2: Write the gate summary into the lab-run doc**

A table with one row per §9 clause, its evidence (a test file path, or a lab-run section), and its status. `(e)` is `BLOCKED — lab run not yet performed` until the rig run happens, and `(a)`'s `_source` case is red until then too. **That is the correct state of this PR**: the gate is shipped and unmet, the flag is off, and the doc says which rig run will meet it.

- [ ] **Step 3: Confirm the flag is off everywhere**

```
grep -rn "AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED" .env.example deploy/.env.example docker-compose.yml deploy/docker-compose.prod.yml
```
Expected: commented-out in both `.env.example` files, `${…:-false}` in both compose files, and **no live assignment anywhere**. Also grep the e2e harness to confirm the only place it is `true` is a test-stack-local env, not a tracked file.

- [ ] **Step 4: Open the PR and STOP**

```
gh pr create --title "R1c — identity_offboarding deterministic release gate" --body "$(cat <<'EOF'
## What

Spec §9's `deterministic` gate for `identity_offboarding`, shipped as tests and
a dated lab-run checklist. **The flag stays off.** This PR does not enable the
recipe in any environment.

- (a) Per-effect contract tests — pre-probe short-circuit, write, post-probe,
  replay-is-noop — driven off `IDENTITY_OFFBOARDING_EFFECT_TOOLS`, so a
  fourteenth tool with no fixtures is a red rather than a silent gap. Fixtures
  are recorded response SHAPES with synthetic identifiers, checked in so the
  gate runs in CI without provider credentials.
- (b) Ordering, three ways: over every prefix of every plan (R1a), over a real
  happy-path run (R1a Task 14), and over every independent stopping point of a
  real dispatch (here).
- (c) Plan-approval membership, including argument-digest mismatch, ordinal and
  tool not-in-set, revision supersede, the two independent digest seals, the
  agent-allowlist ceiling, and requester-cannot-self-approve.
- (d) **The repo's first AI eval harness** — there was none. A JSON corpus plus
  an ordinary Vitest grader (no bespoke runner: a gate that needs its own
  tooling stops being run). 20+ intake cases. The gate's third property is
  structural: no code path resolves a person without a human tick, so a model
  that picks the wrong Dana is a flagged miss and a gate PASS, because the
  human is the control.
- (e) `docs/superpowers/qa/2026-09-17-identity-offboarding-lab-run.md` — the
  checklist, shipped with every row TODO. Its core clause is a line-by-line
  reconciliation of the providers' own audit logs against
  `ai_operator_plan_approval_effects`: every write must map to exactly one
  approved effect row.
- (f) The flag shipped in R1a and is still off.

## Gate status

| Clause | Status |
|---|---|
| (a) per-effect contracts | PASS on reference fixtures; the `_source: "reference"` tripwire is RED by design until the lab run replaces them |
| (b) ordering | PASS |
| (c) plan-approval membership | PASS |
| (d) ≥ 20 evaluated cases, zero wrong-person resolutions accepted | PASS |
| (e) lab run | **BLOCKED — not yet performed** |
| (f) own flag | PASS (off) |

**Do not enable the flag until (e) is PASS.**

Stacked on R1b — CI dispatched per branch with `gh workflow run CI --ref`.

Closes #<wave sub-issue>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**STOP.**

---

## Self-review

### Spec coverage

| Spec § | Covered by |
|---|---|
| §1 (the outcome) | the whole plan; the E2E integration test in Task 14 walks exactly the §1 narrative |
| §4 (Recipe, Library, Target, Step, Plan) | Tasks 2, 8, 9, 17 |
| §4.1 (readiness: `ready`/`setup_required`/`unavailable`, named missing capability, per-provider degradation) | Tasks 1 (the `availability` field), 8, 13, 17, 22; integration proof in Task 14 case 3 and Task 14's readiness suite cases 1–2. `setup_required` is reserved for tenant-fixable gaps (D-R1-12) |
| §5.1 (`contact` target class) | Task 9 (consumes E2's `createTaskTarget`) |
| §5.2 (accounts frozen, addressed by immutable `external_id`, never the UPN) | Task 3 (`accountExternalId`), Task 9 (`freezeTargetAccount`); asserted in Task 3's "immutable external id" case |
| §6.1 (registry, step-kind table, step execution is coordinator code) | Tasks 1, 3, 11 |
| §6.2 (where the model is used: intake, discovery synthesis, exception triage, completion narrative; discovery reads are coordinator-issued) | Tasks 6, 7, 11, 12 |
| §6.3 (the spine, the ordering contract, granular tools not the composite) | Tasks 3, 4; Task 14 and Task 25 for the runtime form |
| §6.4 (plan approval; frozen labels on the card) | consumes E4; Tasks 11, 21, 25 |
| §6.5 (human-work steps, degrade-to-human-work, generated instructions, reminders) | Tasks 3, 8, 10, 11 |
| §6.6 (probe→write→probe, idempotency classes, unobservable effects + subsuming criterion, `verified_resolved` vs `partial`, the completion record) | Tasks 3 (`IDENTITY_OFFBOARDING_UNOBSERVABLE_EFFECTS`), 11 (`advanceVerifyOutcome`), 12, 24 |
| §6.7 (bounds: 14 days, ≤ 6 runs, ≤ 2 attempts/effect) | Task 3 (`IDENTITY_OFFBOARDING_BOUNDS`) |
| §6.8 / D3 (no new agent kind; helpdesk `toolAllowlist`; "offer to add the tools" is an agent policy edit) | Tasks 8, 16, 17 |
| §7.1 (the eight M365 actions) | consumed from M1 in Task 3 |
| §7.2 (per-effect degradation on partial consent) | Task 8 case 4 |
| §7.3 (Exchange: no executor → human work) | Tasks 3, 8 (the three `tool_source` capabilities) |
| §8 (`GET /workflows`, `POST /task-drafts`, task detail panels, Library tab, start form, `runAction`, hash state, real translations) | Tasks 13, 16–22 |
| §9 (`deterministic` gate class, clauses a–f) | Tasks 4, 23–28 |
| §10 row R1 | the plan's scope |
| §11 (wrong person; half-offboarded; plan approval as bypass; replay duplication) | Tasks 3, 4, 7, 14, 25, 26 |
| §12 (D2 contact target; D3 helpdesk; D5 Intune retire only) | Tasks 3, 8, 9 — and M1 already enforces retire-only with a `/wipe` grep |

### Placeholder scan

No `TBD`, no `TODO` in implementation instructions, no "similar to", no "add validation". The only literal `TODO`s are the lab-run doc's checklist rows, which are the artifact's designed initial state and are called out as such in Task 27 and in the R1c gate table.

Both former grep-at-execution seams are now **pinned** (orchestrator decision):

- **`operationKey`** — Task 1 Step 3c adds the optional `toolName` to E1's argument object and quotes W04 Task 11 Step 3 verbatim; Task 3 writes the implementation with `toolName` = the **effect's** tool name and `ordinal` = the `PlannedEffect` ordinal, and asserts byte-equality against `buildTaskOperationKey` for the same tuple. W04's plan text does **not** contradict this — it builds the key exactly that way and `planOrdinalFromOperationKey` parses that same format's trailing `n<N>` segment.
- **Manual-item dedupe** — Task 10 dedupes on the step row's identity via `ai_operator_task_steps.checklist_item_id`, with `attempt_ordinal` as the item index, and states the three ways a `(ticket_id, label)` key fails.

One instruction still tells the executor to read before writing, and it is not a placeholder: Task 1 Step 3c says to read `serviceRecovery.ts`'s existing `buildTaskOperationKey` literal so the absent-argument output stays byte-identical. The value belongs to a shipped file and copying it into this plan would be the thing that goes stale.

### Identifier consistency

`StepDefinition.next` / `NextStepContext` / `NextStepResolver` / `resolveDeterministicNextStep` / `CAPABILITY_AVAILABILITIES` / `CapabilityAvailability` / `operationKey`'s `toolName` (Task 1) are used in Tasks 3, 8, 11, 17. `identityOffboardingInputSchema` / `identityIntakeOutputSchema` / `identityReviewOutputSchema` / `IDENTITY_REVIEW_FLAGS` / `IDENTITY_EXCEPTION_CLASSES` (Task 2) in Tasks 3, 7, 19, 26. `IDENTITY_OFFBOARDING_*` constants, `buildIdentityOffboardingPlan`, `buildIdentityOffboardingManualWork`, `identityOffboardingRecipe`, `CAPABILITY_FOR_TOOL`, `IdentityManualWorkItem` (Task 3) in Tasks 4, 8, 10, 11, 24, 25. `google_account_wipe_mobile_device` (Task 5) in Tasks 3, 24, 27. `IdentityDiscoveryFacts` / `discoverIdentityFacts` / `DISCOVERY_LIMITS` (Task 6) in Tasks 3, 7, 11. `renderIntakeContext` / `renderReviewContext` / `validateIntakeOutput` / `validateReviewOutput` (Task 7) in Tasks 11, 26. `computeRecipeReadiness` / `listWorkflowReadiness` / `degradedEffectTools` / `RecipeReadiness` (with `missing`, `alwaysManualCapabilities`, `manualStepCount`) (Task 8) in Tasks 11, 13, 16, 17, 22. `admitTask` / `AdmitTaskInput` / `AdmitTaskRefusal` / `resolveOrCreateContactForTask` / `lockContactForRecipe` (Task 9) in Tasks 13, 14. `ensureManualWorkItems` / `attachHumanWorkStep` / `nextOpenManualItem` (Task 10) in Task 11. `IDENTITY_OFFBOARDING_ADVANCERS` and the seven advancers (Task 11) in Tasks 14, 25. `buildCompletionRecord` / `postCompletionRecord` (Task 12) in Tasks 11, 14. `AiOperatorWorkflowDto` / `AiOperatorMissingCapabilityDto` / `AiOperatorCapabilityActionDto` (Task 2) in Tasks 13, 16, 17. `fetchOperatorWorkflows` / `createOperatorTaskDraft` / `startOperatorTask` / `addToolsToAgent` (Task 16) in Tasks 17, 19. The `data-testid` vocabulary in Tasks 17, 19, 21 is the same set Task 22's e2e spec queries.

Nothing produced by E1–E4 or M1 is redefined anywhere in this plan; every consumed name appears in *Consumed surface* with the wave that ships it.
