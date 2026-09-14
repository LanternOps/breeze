---
tracking_issue: LanternOps/breeze#5746
wave_issues: W01 LanternOps/breeze#5747, W02 LanternOps/breeze#5748, W03 LanternOps/breeze#5749, W04 LanternOps/breeze#5750
branch: feature/5746-ai-patch-agent/wave-<sub-issue>
---
# AI patch agent — Plan Index

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-patch-agent-design.md` (Gate A approved 2026-09-13 — every recommendation OD-1…OD-11 = option A). The spec is not on `main`; it lives on `origin/docs/feature-pipeline-2026-09-13-specs-plans`.

**Issues:** `LanternOps/breeze#4174` (anchor, "AI patch agent"), `#5382` ("the patch agent never launches").

**Verified against `origin/main` `92172e64a`** (Fleet Designer W05, 2026-09-13).

One plan document per wave. Each wave is one PR on its own branch
`feature/<parent#>-ai-patch-agent/wave-<sub-issue#>` with `Closes #<sub-issue#>`
in the PR body. State lives on GitHub (feature-lifecycle); the wave issue is the
source of truth for status, never this index.

| Wave | Plan | Blast radius | Depends on |
|---|---|---|---|
| W01 | [The patch lane, end to end: `patch` schedule kind + `patch` run profile, kind-gate map, org-listing fix, `patchEvidence.ts`, `submit_patch_plan`, safe projection, digest, default 02:00 cadence + backfill, schedules UI, next-occurrence, Run now. **Findings only, zero intents.**](2026-09-13-ai-patch-agent-01-patch-lane.md) | medium | — |
| W02 | [Actionable installs: shared eligibility resolver extracted from `patchApprovalEvaluator`, device-scoped Tier-3 `manage_patches:install` cards, problem-derived idempotency + suppression window, release re-intersection](2026-09-13-ai-patch-agent-02-actionable-installs.md) | **high** — approvals, tenancy, unattended-adjacent | W01 |
| W03 | [Chase, retry, escalate: failed `patch_job_results` evidence section, failure classification, bounded retry proposals, escalation items + `patch` notify template. No tickets.](2026-09-13-ai-patch-agent-03-chase-and-escalate.md) | medium-high | W02 |
| W04 | [Reactive routing + reboot planning: patch alert sources (built-in `patch_compliance` monitor, patch-job-failure and reboot-pending templates), `alertCategories` trigger filter with exclusive patch-work ownership and recorded fallback, `reboot_plan` items against existing resolved windows](2026-09-13-ai-patch-agent-04-reactive-and-reboot.md) | medium | W01 (routing), W03 (escalation shape) |
| (handoff) | Act-mode execution, canary widening, reboot dispatch → **AI Operator P4-3** (`docs/superpowers/plans/ai-mcp/2026-09-07-ai-operator-completion.md:240-255`). #4174 closes there, not here. | — | P4-0, P4-1, T3 |

W02 starts when W01 merges. W03 after W02. W04 after W03 (its escalation items reuse W03's classification), though its alert-source tasks only need W01.

## Handoff contract to Operator P4-3 (state, do not plan)

P4-3 owns execution. This program hands it four artefacts and consumes nothing from it:

1. **The op set** — `submit_patch_plan`'s `items[].class` union (`install | approval_advisory | reboot_plan | chase | escalation`) and the fields each class carries. P4-3's recipe steps map onto the same classes; it must not invent a parallel vocabulary.
2. **The eligibility resolver** — `resolvePatchInstallEligibility()` (W02, extracted from `patchApprovalEvaluator.ts`). P4-3's "exclude updates published/superseded after review" bullet (`…-ai-operator-completion.md:245`) and P4-0's "intersect with current eligibility inside the actual device executor" bullet (`:203`) are the **same** function. W02 extracts it exported so P4-0 does not extract a second one.
3. **The episode identity** — `patch:<orgId>:<deviceId>:<patchId>` as the `action_intents.idempotency_key` (OD-4 A) plus the suppression read. P4-3's per-target results and retry accounting key on the same string. If P4-3 needs acknowledgement state the derived key cannot express, that is the OD-4 B fallback (`ai_patch_episodes`, org_id shape 1, full four-list ceremony) and it is P4-3's call, not a W02 change.
4. **The reboot plan** — `reboot_plan` items name an **existing resolved maintenance window id**; they never synthesise a time. P4-3 dispatches them; this program never issues a reboot command.

What P4-3 must NOT assume from here: that a plan implies authority to act (every W02+ install is a Tier-3 supervised card a human approved), that `approval_advisory` ever wrote a `patch_approvals` row (it never does — OD-3 A), or that a `patch`-profile run has an action budget (`maxActionsPerRun` is 0 in W01 and the run loop still executes nothing in W02+; intents are minted by the finalizer, not the loop).

## Global constraints (all waves)

Repeated in each wave doc's own Global Constraints; kept here so a reader of one wave sees the whole contract.

### Tenancy — **no new tables in any wave** (verified)

The spec's §4 claim holds against `main`. Verified:

- `ai_agent_runs` — already in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:260`) and `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts:70`), `profile` in the `included` bucket, `outcome`/`trigger_ref`/`policy_snapshot` in `excludedOpen`.
- `ai_agent_schedules` — cascade `:266`, export policy `:77`, `kind` in `included`, `last_run_summary` `excludedOpen`; already a `DUAL_AXIS_TENANT_TABLES` entry in `rls-coverage.integration.test.ts` with the partner-wide SELECT branch.
- Every wave adds **CHECK values and code only**. No `ADD COLUMN` on any org-cascade table, so `CORE_TENANT_EXPORT_POLICY` — the one list that fires on a new *column* — is untouched. No new table, so no `CORE_ORG_CASCADE_DELETE_ORDER`, no `CORE_DEVICE_CASCADE_DELETE_TABLES`, no `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, no `AUDIT_ADMIN_REQUIRED_TABLES`, and no org-merge `REPOINT_TABLES` / trigger-classification entry.
- **This inertness is asserted, not assumed.** Each wave's last task runs `rls-coverage`, `tenantCascade`, `tenant-export-policy` and `tenantExportErasureRoundtrip` and must see them green *without* a registry edit. If any wave finds it needs a table (only OD-4's `ai_patch_episodes` fallback would), it is a shape-1 `org_id` table and inherits **all four** lists plus the org-merge registry — and it becomes its own task with its own migration.
- Tables this program only ever **reads**: `patch_policies` (partner-axis, `partner_id NOT NULL`, no `org_id` — `db/schema/patches.ts:148-150`), `patch_approvals` (partner-axis, `:176-178`), `patches` (a **global** catalog with no tenant column at all — `:116`; its `title`/`description`/`vendor` are untrusted vendor text), `device_patches` (`org_id NOT NULL`, `:201`), `patch_jobs` (`org_id NOT NULL`, `:231`), `patch_job_results` (**no `org_id` and no `partner_id`** — `:255-273`; org must be reached through `patch_jobs.org_id` *and* `devices.org_id`, both pinned), `patch_compliance_snapshots` (`org_id NOT NULL`, `:300`), `devices`, `maintenance_windows`.
- Evidence loaders run inside the run loop's existing **system** DB context (`runLoop.ts:440-485` — the sweep/narrative/design loads do the same). System context is a full RLS bypass, so **the `org_id` predicate in every statement is the only tenant boundary**. Every statement pins `org_id` on the primary table *and* on every tenant-bearing join, and excludes `devices.is_ephemeral = true` (Quick Support) exactly as `sweepEvidence.ts` does.

### Migrations

- One migration for the whole program: **`apps/api/migrations/2026-10-16-181300-ai-agents-patch-profile.sql`** (W01). DDL only, no DML, therefore **no `breeze.scope` election needed** — but if a later wave adds any `UPDATE`/`INSERT`/`DELETE` to a migration it MUST open with `SELECT set_config('breeze.scope', 'system', true);` (`migrationRlsScope.test.ts`, and never add a file to its frozen baseline).
- The spec's example slot `180700` is **taken** by monitors W03. `180300` already collided twice on unmerged branches (`…-ai-run-workspaces-compute.sql` and `…-portal-lifecycle-flag.sql`), `180500`, `180900`, `181100` are in flight. `181300` is free and sorts after `main`'s newest (`2026-10-16-180200-monitor-definitions-builtin-key.sql`).
- **Re-check before every commit:** `ls apps/api/migrations/*.sql | sort | tail -1`; rename upward if `main` moved past. The pre-push hook re-checks against `origin/main` (`check-migration-naming.sh --against-ref origin/main`), so a name that passed at commit time can fail at push time.
- Idempotent: `DO $$ … EXCEPTION` / `pg_policies` existence checks / `DROP CONSTRAINT IF EXISTS` then re-add. No inner `BEGIN;`/`COMMIT;`. Never edit a shipped migration.

### The three CHECK widenings (W01, one file)

`ai_agent_runs_profile_chk` gains `'patch'`; `ai_agent_schedules_kind_chk` gains `'patch'`; `ai_agent_schedules_kind_kinds_chk` gains `'patch'` to the **zero-cardinality** arm (a patch schedule sweeps nothing, like `narrative`/`design`). The composite self-FK `ai_agent_schedules_baseline_kind_fk (baseline_schedule_id, kind) → (id, kind)` needs no change — a new `kind` value flows through it unmodified.

### AI-agent rails invariants (all waves)

- **`patch` is a shipped `ai_agents` kind with an existing device lane.** Unlike `designer`, `AGENT_KIND_PRESETS.patch` already exists (`agentToolCatalog.ts:320-325`) and `POST /ai/agents/:id/runs` already admits a patch agent on the `full` profile against a device. **Do not add the designer-style two-way kind↔profile pin.** Only the forward half is added: a `profile: 'patch'` run must be a `kind: 'patch'` agent with `deviceId === null` (mirror of rule 8a, `runService.ts:1154`). The reverse pin (`kind === 'patch' ⇒ profile must be 'patch'`, mirror of rule 2a at `:890`) would delete the existing device lane, which the spec does not ask for and which is the only thing a patch agent can do today.
- No `'patch'` / `isPatchProfile` / `PATCH_` literal inside `aiGuardrails.ts`, `executionLedger.ts`, `policyDecide.ts`, `actRevalidation.ts` — the new profile must not carry a bypass. `verdictProfile.contract.test.ts` is extended to assert it (same posture the design profile took).
- `STREAK_NEUTRAL_PROFILES` (`agentCircuit.ts:128`) has **no compile-time exhaustiveness guard** — its own docstring at `:194-201` says a new profile silently inherits `full`'s reset/increment behaviour. W01 adds `'patch'` by hand *and* a per-profile row in `agentCircuit.test.ts`.
- `profileCaps` (`runService.ts:718-798`) and `outcomeToolsForProfile` (`outcomeTools.ts:119-146`) and `buildAdmission` (`aiAgentSweepScheduler.ts:614-651`) all carry `default: { const exhaustive: never = … }`. Adding `'patch'` to `AI_AGENT_RUN_PROFILES` / `AI_AGENT_SCHEDULE_KINDS` makes omission a **compile error** in those three. Rely on it; do not add a runtime guard instead.
- Policy snapshot `AI_AGENT_POLICY_SNAPSHOT_VERSION` **10 → 11** (`types/aiAgents.ts:472`) for `maxConcurrentPatchRuns`, `maxPatchRunsPerDay`, `patchBudgetCentsPerRun`, `patchMaxTurns`. Every read site tolerates v1–v11 via `?? AI_AGENT_LIMIT_DEFAULTS.x`. Every new limit gets a 4-line entry in the `runService.ts:43-131` enforcement inventory ("an unenforced cap is an unbounded agent").
- The tool floor is a **floor, not an intersection** with the agent's own `toolAllowlist` (`sweepProfile.ts:74-98`, `designProfile.ts:40-49`).
- Findings that a human must read are counted by `FINDINGS_TO_REVIEW_OUTCOME_PATHS` (`runFindings.ts:60-63`), used on BOTH the detail DTO and the two list routes' SQL. A new outcome array that nobody registers there badges as "No action" over unread work — W01 registers `['patchPlan','items']`.

### Evidence discipline (all waves)

Copied from `sweepEvidence.ts:1-60` and `designEvidence.ts`, and **aggregate-first** because 25 rows/kind at 12 KiB truncates a real fleet:

- Display scalars only, off named columns. Never `jsonb`/`bytea`/free text: `patch_policies.targets`/`auto_approve`/`schedule`/`reboot_policy`/`category_rules`, `patch_jobs.patches`/`targets`, `patch_job_results.output`, `patch_compliance_snapshots.details_by_category` are all forbidden in a SELECT list.
- **`patches.title` / `patches.vendor` are untrusted vendor text**, not operator text — bound them with the `sanitizeSweepText` idiom (≤ 256 chars, `\p{C}` stripped) and never derive authority, eligibility or retryability from them.
- Bounded twice (per-section row cap *and* a UTF-8 byte ceiling that drops whole rows), and truncation is observable: ask for `MAX + 1` and carry a `COUNT(*) OVER ()` total, never a bare `LIMIT MAX` (the `anomalyContext.ts` #3828 bug).
- Per-section failure isolation via the `settled()` idiom: a broken table degrades to an `unavailable` entry the prompt renders as "(not measured)", it does not throw. **Exception**, mirroring `runLoop.ts:471-476`: if the compliance rollup itself is unavailable there is nothing to plan for and the run fails with a dedicated error code.

### Model-output discipline (all waves)

Every reference in `submit_patch_plan` is validated **server-side against the assembled evidence before anything is persisted** — the `sweepFindings.ts:235-270` membership gate generalised (`refusals` map + a recorded `disposition`, never a silent drop). `deviceId ∉ run.evidenceDeviceIds` → refused; `patchId ∉ that device's evidence rows` → refused; `windowId ∉ the resolved windows` → refused; `jobResultId ∉ the failure section` → refused. The gate runs **before any DB work**, so a refused id is never named in a query. Validation lives inside the outcome tool where it can (so the model retries within its turn budget, `outcomeTools.ts` `submit_fleet_design` precedent) and in the persister where it needs run state.

### CI traps (all waves)

- `pnpm test` does **not** run RLS/integration/export-policy suites. `pnpm test-stack up` for a per-worktree Postgres+Redis; `pnpm test-stack down` when finished — nothing does it for you.
- The org-cascade and both export-policy suites only fail under **Integration Tests**, so a PR on a stale base can go green and redden `main`.
- A **stacked** PR (based on a sibling branch, not `main`) gets **no CI at all** — `gh pr checks` reads green. Each wave targets `main`; if one is ever stacked, dispatch per branch: `gh workflow run CI --ref <branch>`.
- `vitest run <path>` is a plain **substring** match, not a glob and not a directory prefix. `src/services/aiAgents/patchEvidence` also matches nothing else here, but `src/routes/devices/patches` matches both `patches.ts`'s test and `patches.*.test.ts` siblings — always check the reported file count, and list dotted siblings explicitly.
- Never `pnpm --filter <pkg> test -- --run <path>` (the `--` is forwarded and vitest silently runs the whole suite in watch mode). Use `cd apps/api && npx vitest run <path>`.
- Add `--pool=threads --maxWorkers=2` when a dev stack is running (the forks pool hangs under `wt-stack`).

### Commands

```bash
# API unit
cd apps/api && npx vitest run src/services/aiAgents/patchProfile.test.ts
# shared
cd packages/shared && npx vitest run src/validators/aiPatchPlan.test.ts
# web
cd apps/web && npx vitest run src/components/settings/AiAgentSchedulesSection.test.tsx
cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/no-silent-mutations.test.ts
# typecheck / lint
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd apps/web && npx astro check
pnpm lint
# live DB (last task of every wave)
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<suite>.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.rls.ts
pnpm test-stack down
# whole unit suite before the PR — a touched-file sweep misses Test API contracts
cd apps/api && npx vitest run
```

## Spec corrections these plans apply (verified against `main` `92172e64a`)

Each is a spec claim that does not survive contact with `main`, or a "Not verified" item the spec flagged. Fold them back into the spec in W01 Task 0.

1. **`alerts` really has no `category` column — confirmed, and the routing path this forces is named.** `alerts` (`db/schema/alerts.ts:103-139`) has `rule_id`, `monitor_id`, `severity`, `title`, `message`, `context` and no category. `category varchar(100)` is on `alert_templates` (`:44-74`, at `:50`). So a W04 "is this alert patch work?" classifier must reach category by join — `alerts.rule_id → alert_rules.template_id → alert_templates.category` (index `alert_rules_template_id_idx` exists) or `alerts.monitor_id → monitor_definitions.kind = 'patch_compliance'` — and **both legs are nullable**, so the classifier must fail closed (unclassified ⇒ not patch work ⇒ triage keeps it). `AiAgentTriggers` (`types/aiAgents.ts:196-215`) has `alertRuleIds`, `siteIds`, `deviceGroupIds`, `deviceTags`, `ticketCategories`, `ticketPriorities` — **no alert-category filter**; W04 adds `alertCategories`.
2. **The `patch_compliance` alert source already exists end to end.** Spec §3.9 / OD-8 says patch alert sources must be authored first. Verified on `main`: `monitorKindEnum` includes `'patch_compliance'` (`db/schema/monitorDefinitions.ts:39`), the kind spec is complete (`services/monitors/kinds/patchCompliance.ts:8-17`), and the alert-condition handler evaluates it against `security_posture_snapshots.patch_compliance_score` (`services/alertConditions/handlers/patchCompliance.ts:8-48`). What is genuinely missing, and what W04 authors: a **built-in** `patch_compliance` monitor (`services/monitors/builtInMonitors.ts` ships only `cpu_high`, `memory_high`, `disk_full`), and alert sources for **patch-job failure** and **reboot-pending-over-threshold**, for which nothing exists.
3. **No patch code path emits an alert.** Verified by grep across `services/patch*`, `jobs/patch*`, `routes/patches/` — zero `createAlert` / `insert(alerts)`. §3.9's premise holds for those two sources.
4. **`patch_job_results` has no `org_id` and no `partner_id`** (`db/schema/patches.ts:255-273`). Every W03 query over it must reach org through `patch_jobs.org_id` **and** re-pin `devices.org_id`; a `device_id`-only join is a cross-tenant read under system context.
5. **`patch_job_results.status` includes `'queued'`** (`:78-89`) — "the `install_patches` command is persisted with a `deliver_by` and is waiting for the device's next heartbeat", owned by the delivery clock. §3.6's "never retry a queued-offline command" is therefore a status check, not an inference.
6. **`device_patches.status = 'missing'` is a TOMBSTONE, not "the device is missing this patch"** (`:53-68`, `OUTSTANDING_DEVICE_PATCH_STATUSES = ['pending']`). Counting `'missing'` made a fully-patched Linux box report ~960 outstanding patches. Every evidence and eligibility query uses `OUTSTANDING_DEVICE_PATCH_STATUSES`, never a hand-written status list.
7. **Run-now route.** Spec §3.10 says `POST /ai/agents/:id/runs` with `{ profile: 'patch', orgId }` *and* "mirroring `POST /ai/fleet-design/runs`" — those are incompatible on `main`. `triggerAgentRunSchema` is `{ deviceId }` only and `.strict()`, and the route is explicitly **the device lane**: it 400s `kind_not_device_triggerable` for a device-less kind (`routes/aiAgents.ts:1802-1809`). The plan follows the second half — a dedicated `POST /ai/patch-plan/runs` with `{ orgId }`, copied from `routes/fleetDesign.ts:148-207` (`requireAiWrite` + `requireMfa()`, 404 on `!auth.canAccessOrg`, `resolveEffectiveAgent(auth, orgId, 'patch')`, `dedupeKey: patch-manual-<uuid>`, `writeRouteAudit`, HTTP-200 `{ success: false, skipped }` on a declined admission so `runAction` reads it as a failure, 202 `{ runId }` on success). The device lane keeps its existing body and behaviour.
8. **Wave placement of "Run now".** The spec's §8 table puts it in W02; the approved wave brief puts it in W01. **W01** — a shadow lane that cannot be triggered by hand is exactly the #5382 complaint, and W01 mints zero intents so the button is harmless.
9. **"Run now *on device*" is not a thing.** A `patch`-profile run is device-less by construction (`buildAdmission` sets `deviceId: null`; rule 8a's mirror refuses a device). The card's control is an org-scoped "Run now", not a device picker.
10. **`requireMfa` — resolved (spec "Not verified" #1).** `requireMfa()` is **route middleware only**: `routes/devices/patches.ts:497` (install) and `:619` (rollback) both have it; `routes/aiAgents.ts:1774` and `routes/fleetDesign.ts:154` have it. Grepping `aiGuardrails.ts`, `aiToolsFleet.ts` and `aiAgentSdkTools.ts` for `requireMfa`/`mfa` returns **zero hits** — the AI-tool path has no MFA gate at all for `manage_patches:install` or `:rollback`. That asymmetry (human REST install needs MFA, an approved Tier-3 intent release does not) is **pre-existing and out of scope**; the plan neither relies on nor widens it, and W02 records it on the parent issue as a separate finding. The new `POST /ai/patch-plan/runs` carries `requireMfa()` like its siblings.
11. **`deadlineDays` / `gracePeriodHours` / `ringOrder` / `notifyOnComplete` — resolved (spec "Not verified" #2). No runtime consumer, confirmed.** `notify_on_complete` (`patches.ts:162`) has **exactly one** hit repo-wide: the schema declaration. `deadline_days` (`:166`) and `grace_period_hours` (`:167`) appear only in the update-ring CRUD route (`routes/updateRings.ts`), the `manage_update_rings` AI tool CRUD, and web forms — zero hits in `patchJobExecutor.ts`, `patchSchedulerWorker.ts`, `patchJobFinalizer.ts`, `patchRebootHandler.ts`, `staleCommandReaper.ts`. `ring_order` (`:164`) is read only as an `ORDER BY` for listing (`routes/updateRings.ts:213`, `aiToolsPolicyPrereqs.ts:238`). Spec §5 stands: enforcing them is **out of scope** and W01 Task 0 files it as its own bug rather than quietly starting to enforce a stored-but-dead field.
12. **`device_patches.failure_count` — resolved (spec "Not verified" #3). Nothing writes it, anywhere.** Repo-wide (API **and** `agent/`): the only hits are the schema declaration (`patches.ts:209`), two read-only SELECTs (`routes/devices/patches.ts:315,454`) and the export-policy registry. Zero `agent/` hits for `failure_count`/`FailureCount`. The column is permanently `0`, so **W03's attempt history must come from `patch_job_results`, never from `failure_count`** — and W03 does not start writing it (spec §5 excludes that).
13. **Four-eyes entry for `manage_patches:rollback` — resolved (spec "Not verified" #4).** Enclosing constant is **`TIER3_FOUR_EYES_ACTIONS`** (`apps/api/src/services/aiGuardrails.ts`, declared `:335`, the `manage_patches: ['rollback']` entry at `:357`). Its sibling `TIER3_SUPERVISED_ACTIONS` (`:451`) carries `manage_patches: ['install', 'setup_auto_approval']`. So `install` is **Tier 3 / supervised** (one human) and `rollback` is **Tier 3 / four-eyes** (two humans) — the plan proposes only `install`, never `rollback`. Note the file path: `apps/api/src/services/aiGuardrails.ts`, **not** `services/ai/aiGuardrails.ts`.
14. **`revalidateApprovedIntentForRelease` already exists — do not add a second hook.** Spec §3.4 names it as if it were new. It is at `apps/api/src/services/actionIntents/revalidateRelease.ts:140-316`, called from `jobs/intentReleaseWorker.ts:923`, and it is **tool-agnostic** (approval-row binding, argument digest, tier-not-escalated, actor still active, org still active, RBAC re-check). The **per-tool** drift mechanism is `EFFECT_DIGEST_RESOLVERS` (`services/actionIntents/effectDigest.ts:157`), keyed `tool` or `tool:action`, dispatched by the worker at `:986-1033` via `hasPinnedDigest`. **`manage_patches` has no entry** (`manage_patches:rollback` is on the `DELIBERATELY_UNPINNED` allowlist in `effectDigestCoverage.contract.test.ts:74-75`, because `patches` is a global vendor catalog whose `updated_at` churns on routine sync). W02's re-intersection therefore lands as a new `'manage_patches:install'` entry in that map — **not** a new call site, and **not** a `patches.updated_at` hash (that is exactly the failure the rollback allowlist entry documents); it hashes the *eligibility verdict* for `(deviceId, patchId)` from `resolvePatchInstallEligibility`.
15. **There is no way to look up an intent by idempotency key today.** Grep for `ByIdempotency|byIdempotencyKey|findIntent|lookupIntent` across `apps/api/src` finds nothing exported; the only read is inline inside `createActionIntent`'s `onConflictDoNothing` replay branch (`intentService.ts:1823-1833`). W02 adds the helper the OD-4 A suppression read needs.
16. **A device-scoped intent can never be policy-auto-executed** — `resolvePolicyDecisionState` returns `human_required` on `hasScope` before anything else (`intentService.ts:663-679`), so `attemptPolicyDecision` is never reached. Every W02 install card is a human decision by construction; #4442 is the roadmap item that would change that. Do not add a `patch` exception.
17. **`SweepProposedAction` gains no patch member.** It is a closed two-member union (`types/aiAgentSchedules.ts:62-64`) consumed by `sweepFindings.ts`'s `proposedActionName`/`proposalToolInput`. The patch plan has its own outcome shape and its own persister (`patchPlan.ts`); W02 does **not** widen the sweep union.
18. **There is no "next maintenance window" projector for the current (config-policy) maintenance model.** `deploymentEngine.getNextMaintenanceWindow(deviceId)` (`:138-193`) exists but reads **only the legacy standalone `maintenance_windows` table** and omits `groupIds` from its target predicate. The config-policy path everything patch-related uses (`featureConfigResolver.checkDeviceMaintenanceWindow` `:2234-2240` → `isInMaintenanceWindow` `:2089-2228`, and `maintenanceService.isDeviceInMaintenance` `:42-83`) answers **"is `now` inside a window"** and never computes a future start. Consequences: **W01 evidence may only report "a maintenance window resolves for this device / it is in maintenance now", never a next-window time**; **W04's `reboot_plan` items need a real next-occurrence projector** for `once|daily|weekly|monthly` recurrences, and that is a W04 task, not an assumption.
19. **`manage_patches:scan` is a no-op stub.** Its handler (`aiToolsFleet.ts:829-832`) returns a canned success and dispatches nothing. It is Tier 2 (`TIER2_ACTIONS` `:118`), so it looks harmless and reachable — it is simply inert. Keep it **out** of the patch profile's tool floor so the model is not told it can trigger a scan.
20. **`ai_agents.kind` already admits `'patch'` in the DB** (`ai_agents_kind_chk`, widened in `2026-10-16-170500-ai-agents-fleet-designer.sql:5-7`). Only `ai_agent_runs_profile_chk` and the two schedule CHECKs need widening.

## Cross-wave names that must not drift

Defined in **W01** and consumed verbatim later:
`AI_AGENT_RUN_PROFILES` gains `'patch'`; `AI_AGENT_SCHEDULE_KINDS` gains `'patch'`; `ScheduleValidationCode` gains `'agent_kind_not_patch'`; limits `maxConcurrentPatchRuns`, `maxPatchRunsPerDay`, `patchBudgetCentsPerRun`, `patchMaxTurns` (snapshot **v11**); skip reasons `max_concurrent_patch_runs`, `patch_rate` (non-published, like every other scheduled-profile pair); `isDailyOrRarerLiteralCron` (`packages/shared/src/validators/aiAgentSchedules.ts`); `PATCH_TOOL_ALLOWLIST`, `isPatchProfile`, `patchLimits`, `patchToolAllowlist`, `PATCH_OUTCOME_TOOL_NAME = 'submit_patch_plan'` (`apps/api/src/services/aiAgents/patchProfile.ts`); `loadPatchEvidence`, `assemblePatchEvidence`, `PatchEvidence`, `PATCH_EVIDENCE_*` bounds (`patchEvidence.ts`); `PatchPlanSubmission`, `PatchPlanOutcome`, `PatchPlanItem`, `PATCH_PLAN_ITEM_CLASSES`, `patchPlanSubmissionSchema`, `PATCH_PLAN_SCHEMA_VERSION` (`packages/shared/src/types/aiPatchPlan.ts` + `validators/aiPatchPlan.ts`); `persistPatchPlan`, `projectPatch` (`apps/api/src/services/aiAgents/patchPlan.ts`); `finalizePatchPlan` (`runFinalizers.ts`); `ensureDefaultPatchSchedule` (`scheduleService.ts`); routes under `/ai/patch-plan`.

Defined in **W02**: `resolvePatchInstallEligibility`, `PatchInstallEligibility` (`apps/api/src/services/patchEligibility.ts`); `patchEpisodeIdempotencyKey(orgId, deviceId, patchId)`; `PATCH_EPISODE_SUPPRESSION_DAYS`; the intent-release revalidator registration for `manage_patches:install`.

Defined in **W03**: `PATCH_FAILURE_CLASSES` (`transient | needs_reboot | disk_space | store_corrupt | permanent | unknown`); `classifyPatchFailure`; `PATCH_CHASE_MAX_ATTEMPTS`; the `patch` arm of `runFinishedNotify`.

Defined in **W04**: `alertCategories` on `AiAgentTriggers`; `PATCH_ALERT_CATEGORY`; `patchWorkOwnershipFallbackReason`.

## Deferred (record on the parent issue when the feature is registered)

Act-mode / unattended patch execution and reboot dispatch (Operator P4-3); fleet canary→widen (#4173); auto-execution of scoped proposals (#4442); automatic ticket creation; enforcing `deadlineDays` / `gracePeriodHours` / `ringOrder` (file as its own bug — stored on rings, read by nothing); writing `device_patches.failure_count`; a patch Operator recipe; partner-scoped approval intents (OD-3 B/C); a durable `ai_patch_episodes` table (OD-4 B); projecting a bounded exportable copy of the patch plan (OD-11 B); lifting the 500-org `MAX_ORGS_PER_OCCURRENCE` cap (`aiAgentSweepScheduler.ts:386`).
