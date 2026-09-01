---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
---

# S0 Track B Current-Main Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge current `main` into `fix/s0-track-b-fleet-execution-truth` with the deliberate per-file resolutions, contract-closing commits, and proofs defined by the spec, so PR #4064 becomes mergeable without weakening either side.

**Architecture:** One rerere-disabled merge commit carrying all 22 conflict resolutions (mechanical unions, prefer-side calls, the D1 type decision, the 23-key aiTriage hand-merge, and the partnerRls structure), followed by four contract-closing commits: migration dedup/rename, org-merge registry + trigger classification, the #4172 UI re-port (TDD against main's two RED sweep tests), and dead-code cleanup + the D6 Postgres proof.

**Tech Stack:** git, TypeScript/Vitest (`apps/api`, `apps/web`), Go (`agent/`), PostgreSQL via `docker-compose.test.yml` per-worktree ephemeral stacks, repo gate scripts.

**Spec:** `docs/superpowers/specs/2026-08-31-s0-track-b-current-main-port-design.md` — read it first; every resolution below argues from it.

## Global Constraints

- Work ONLY in the worktree `/Users/toddhebebrand/breeze/.worktrees/s0-track-b-fleet-execution-truth` on branch `fix/s0-track-b-fleet-execution-truth`. Base before Task 1: `686e46c9d` (design commit on top of reviewed head `b8d24ed8d`).
- Do not bulk-prefer either side of any conflict. Every file's resolution is specified per hunk below.
- Never touch `SPECIAL.pam_actuations` / `SPECIAL.pam_actuation_results` in `orgMergeRegistry.ts`, and never extend `blocks-merge` to any Track B table (spec §5).
- Never edit a migration that exists on `origin/main`. Only Track B's six unmerged files are deleted/renamed (spec §4).
- The merge commit is the ONLY `--no-verify` commit. Every other commit runs the hooks.
- API typecheck: `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit` (local OOMs at default heap are a known issue; the big-heap retry is the accepted gate).
- Integration tests need the per-worktree Postgres stack: `pnpm --filter @breeze/api test:docker:up`, then targeted `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <file> …`, then `pnpm --filter @breeze/api test:docker:down` when the task ends.
- Focused unit tests: `pnpm --filter @breeze/api exec vitest run <paths>` (unit config); web: `pnpm --filter @breeze/web exec vitest run <paths>`; agent: `cd agent && go build ./... && go test -race ./internal/heartbeat/ ./internal/health/ ./internal/collectors/`.

---

### Task 1: The merge commit

**Files:**
- Modify (conflict resolutions): the 22 files listed in spec §2–§3, §6–§7.
- No new files.

**Interfaces:**
- Consumes: `origin/main` (fetch and pin the SHA at execution time; analysis was performed at `bd7d95f41` — if main has moved, `git diff bd7d95f41..origin/main --stat` and confirm no new overlap with the 22 files or `apps/api/migrations/` before proceeding; if there is new overlap, stop and report rather than improvise).
- Produces: a merged tree where all Task 2–5 REDs are reachable; the merge commit SHA is referenced by every later task.

- [ ] **Step 1: Preconditions**

```bash
cd /Users/toddhebebrand/breeze/.worktrees/s0-track-b-fleet-execution-truth
git status --porcelain          # expect empty
git rev-parse HEAD              # expect 686e46c9d…
git fetch origin main
git rev-parse origin/main       # record; compare vs bd7d95f41 per Interfaces note
```

- [ ] **Step 2: Start the merge with rerere DISABLED**

```bash
git -c rerere.enabled=false merge --no-ff origin/main
```

Expected: conflict list of 22 files (spec §2–§3). CRITICAL check: `git status` must show `apps/api/src/__tests__/integration/automationsPartnerRls.integration.test.ts` as unmerged AND `grep -c '^<<<<<<<' apps/api/src/__tests__/integration/automationsPartnerRls.integration.test.ts` must be ≥ 1. If the merge output contains "using previous resolution" for ANY file, run `git merge --abort` and retry with the `-c rerere.enabled=false` flag actually applied.

- [ ] **Step 3: Take-MAIN-verbatim files (whole-file checkout is correct ONLY for these)**

```bash
git checkout --theirs \
  apps/api/src/__tests__/integration/automationResourceBindings.integration.test.ts \
  apps/api/src/__tests__/integration/recoveryAuthorizationSubjectMigration.integration.test.ts \
  docs/superpowers/plans/2026-08-24-s0-track-a-authorization.md
```

Verify each is now byte-identical to main: `git diff origin/main -- <file>` → empty for all three.

- [ ] **Step 4: site-scope-coverage — main's copy minus three lines**

```bash
git checkout --theirs apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts
```

Then delete exactly these three consecutive lines from `SITE_SCOPE_INPUT_EXEMPT` (they sit between the `PUT /:id/network` and `PUT /:id/warranty-info` entries):

```ts
  // Agent-role token on the route group; the URL id is resolved to the
  // authenticated agent's device by agentAuth, not a user-session site scope.
  'routes/agents/inventory.ts:PUT /:id/software',
```

Rationale (spec §3): Track B's `routes/agents/inventory.ts` rewrite lands unconditionally and no longer matches the scanner's device-data patterns; the shrink-only "no stale entries" ratchet fails if the entry stays. Keep every main-side addition (`pamObservations` exemption, three `aiAgents.ts` runs entries).

- [ ] **Step 5: Take-HEAD-hunks files — edit markers in place. NEVER `git checkout --ours` these (it would discard main's cleanly auto-merged regions)**

For each file, open it, and for every `<<<<<<< HEAD … ======= … >>>>>>>` block keep the HEAD side and delete the other, UNLESS a row below says otherwise:

1. `apps/api/src/services/automationRuntime.ts` — HEAD in all 9 hunks. Then verify the auto-merged main regions survived:
   ```bash
   grep -c "circuit_open\|triage_rate" apps/api/src/services/automationRuntime.ts   # ≥ 2
   grep -n "export { isCronDue, matchesCronField } from './cronDue'" apps/api/src/services/automationRuntime.ts
   grep -c "function getZonedDateParts" apps/api/src/services/automationRuntime.ts  # 0
   grep -n "trigger: triggerContext" apps/api/src/services/automationRuntime.ts     # present (ordinary-run call)
   grep -n "trigger: undefined" apps/api/src/services/automationRuntime.ts          # present (config-policy call)
   ```
2. `apps/api/src/services/automationRuntime.configPolicy.test.ts` — HEAD in all 3 hunks (verified strict superset of main's Track A additions).
3. `apps/web/src/components/scripts/ScriptExecutionModal.tsx` — HEAD in both hunks (`DeviceOptionPicker` shape). Main's #4172 fix is deliberately NOT resolved here; Task 4 re-ports it.

- [ ] **Step 6: Union files — edit markers keeping BOTH sides**

1. `agent/internal/heartbeat/heartbeat.go` hunk 1 (`HeartbeatPayload`): keep B's `HealthStatus *health.AgentHealthObservation` line AND main's `RollbackComponentVersions map[string]string` line; gofmt-align the whole field block. Hunk 2 (`Heartbeat` struct): keep B's `softwareObservationFn func() (collectors.SoftwareInventoryObservationV2, error)` (immediately after `softwareCol`) AND main's `rollbackController rollbackController` (immediately after `backupBinaryPath`). Run `gofmt -w agent/internal/heartbeat/heartbeat.go`.
2. `agent/internal/heartbeat/heartbeat_test.go`: concatenate both appended test blocks (B's 2 `TestHeartbeatPayload*HealthStatus*` funcs, main's 6 `TestSecurityCapabilities*`/`TestPamReconciliationStatus*` funcs); either order.
3. `apps/api/src/routes/agents/heartbeat.ts` hunk 1 (imports): keep all four —
   ```ts
   import { ingestRollbackObservation } from '../../services/agentRollbackResult';
   import {
     editionWithheldDetail,
     type EditionWithheldContext as SharedEditionWithheldContext,
   } from '../../services/agentEditionCompat';
   import { recordAgentHealthObservation } from '../../services/agentHealthObservations';
   ```
   Do NOT re-introduce `desc` into the drizzle import or `agentVersions` into the schema import (main removed both in #4072).
   Hunk 2 (post-commit block): keep BOTH blocks, each with its FULL brace structure (git absorbed the shared trailing braces into the common tail — count braces). Order: B's `if (data.healthStatus) { … }` self-health block first, then main's `let acknowledgedRollbackObservationId … if (data.rollbackObservation) { … }` block (its variable is consumed ~230 lines later in the `c.json` response — do not scope it inside the `if`).
4. `apps/api/src/services/commandResultHandlers.ts` hunk 1: union imports with B's line placed ABOVE the exported type:
   ```ts
   import { applyAutomationActionTerminal } from './automationActionResults';
   import { handlePeripheralPolicyResultV2 } from './peripheralPolicyState';
   import {
     pamAgentResultV2Schema,
     recordPamActuationResult,
     type PamActuationResultClassification,
   } from './pamActuationResult';

   export type CommandResultHandlerOutcome =
     | { kind: 'pam'; classification: PamActuationResultClassification }
     | void;
   ```
   Hunk 2 (D1): take MAIN's `}) => Promise<CommandResultHandlerOutcome>;`. Then apply D1's follow-through in the same file: revert `handleScriptResult`'s signature to `Promise<void>`; delete B's four added return statements (`return effectiveExecution;`, the adjacent `return null;`, and the two `return null;` that replaced bare `return;` in the early-bail and catch arms). KEEP `let effectiveExecution …`, the #3607 recovery reassignment, and the `if (effectiveExecution) { await applyAutomationActionTerminal({ source: 'script_execution', … }) }` block — that call is Track B's actual truth contract.
5. `apps/api/src/routes/agents/commands.test.ts`: keep both mock consts (`applyCommandAutomationTerminalMock` and `consumePamReconciliationRateLimitMock`).
6. `apps/api/src/routes/agentWs.test.ts`: keep both mock declarations verbatim — B's two plain consts AND main's `vi.hoisted` + partial `vi.mock('../services/pamActuationResult', …)`. Do not normalize styles.
7. `apps/api/src/routes/devices/core.ts` (`CORE_DEVICE_ORG_DENORMALIZED_TABLES`): keep main's inserted line verbatim in place and B's suffix:
   ```ts
   'agent_rollback_events', 'agent_rollback_directives',
   'device_reliability', 'device_reliability_history', 'device_sessions', 'device_software_inventory_state',
   ```
8. `apps/api/src/routes/devices/index.ts` (imports):
   ```ts
   import { postureRoutes } from './posture';
   import { optionsRoutes } from './options';
   import { healthRoutes } from './health';
   import { agentRollbackRoutes } from '../agentRollback';
   ```
   The mount body auto-merged; verify `customFieldValuesRoutes` is mounted first, `optionsRoutes`/`healthRoutes` before `coreRoutes`, `agentRollbackRoutes` before `coreRoutes`.
9. `apps/api/src/services/tenantExportPolicyRegistry.ts` hunk 1: main's `action_intents` line (with the 8 new columns) followed by B's `agent_health_observations` line. Hunk 2: MAIN verbatim (B's side is unchanged base context; taking it would revert #4249).
10. `apps/api/src/services/tenantCascade.test.ts`: keep BOTH added `it()` blocks as two complete blocks (main's peripheral audit-admin `it` first, B's health/inventory `it` second). After editing: `grep -c "it(" …` sanity + run the file.
11. `apps/api/src/jobs/automationWorker.eventFanout.test.ts`: main's `#3828` ticket-events describe first, B's `describe('automation execution DB context ownership')` appended after it.
12. `apps/web/src/components/alerts/AlertsPage.tsx`: union imports —
    ```tsx
    import { useDeviceOptions } from '../../hooks/useDeviceOptions';
    import { useHashState } from '@/lib/useHashState';
    ```
    and DELETE the now-dead `type Device = { id: string; name: string };`.

- [ ] **Step 7: The aiTriage hand-merge (neither side)**

In `apps/api/src/services/automationRuntime.aiTriage.test.ts`, replace the conflicted table with B's shape × main's 23-key set. Keep main's per-key comments for the 9 new reasons and B's header comment:

```ts
// Expected terminal action outcome per skip reason. Deliberately total:
// a new AgentRunSkipReason fails to compile until classified here AND in
// the runtime's AI_TRIAGE_SKIP_IS_FAILURE (they must stay exact inverses).
const EXPECTED_OUTCOME: Record<AgentRunSkipReason, 'succeeded' | 'failed'> = {
  kill_switch_off: 'succeeded',
  no_effective_agent: 'succeeded',
  agent_disabled: 'succeeded',
  mode_off: 'succeeded',
  circuit_open: 'succeeded',
  trigger_filter_mismatch: 'succeeded',
  maintenance_window: 'succeeded',
  cooldown: 'succeeded',
  max_concurrent_runs: 'succeeded',
  max_runs_per_hour: 'succeeded',
  org_budget_exceeded: 'succeeded',
  agent_daily_budget_exceeded: 'succeeded',
  duplicate: 'succeeded',
  max_concurrent_verdict_runs: 'succeeded',
  verdict_rate: 'succeeded',
  max_concurrent_sweep_runs: 'succeeded',
  sweep_rate: 'succeeded',
  max_concurrent_narrative_runs: 'succeeded',
  narrative_rate: 'succeeded',
  max_concurrent_triage_runs: 'succeeded',
  triage_rate: 'succeeded',
  ownership_mismatch: 'failed',
  device_not_in_org: 'failed',
};
```

(Copy main's comment lines for the 9 volume-guard reasons from `git show origin/main:apps/api/src/services/automationRuntime.aiTriage.test.ts` and keep them attached to their keys.)

- [ ] **Step 8: db/schema/automations.ts — one hunk each way**

Hunk 1 (import): HEAD — the list ending `…, check, foreignKey`. Hunk 2 (comment): MAIN — `2026-09-25-a-automation-resource-bindings.sql`. Verify B's `automationActionResultStatusEnum`, `automationActionTerminalSourceEnum`, and the `automationActionResults` pgTable survived in the non-conflicted regions.

- [ ] **Step 9: automationsPartnerRls — main wholesale + one assertion edit (D6)**

```bash
git checkout --theirs apps/api/src/__tests__/integration/automationsPartnerRls.integration.test.ts
```

Then change ONE assertion (main line ~634, inside `it('records failed per-device results (status + error) when an action fails on every device (#2023)')`):

```ts
// Under the reconciled action-results model the device row's error is the
// failing action's OUTCOME message, not the dispatch log line. String is
// proven against real Postgres in the D6 step of the cleanup task.
expect(row!.error).toContain('Notification channel type pagerduty is not implemented');
```

Keep everything else from main: the four imports, `createdNotificationChannels` lifecycle, the pagerduty channel fixture, and the admission + `replaceAutomationResourceBindings` transaction block.

- [ ] **Step 10: Post-resolution verification battery (no DB needed)**

```bash
grep -rn "2026-09-11-" apps/ docs/superpowers/plans/2026-08-24-s0-track-a-authorization.md   # expect ONLY hits inside apps/api/migrations/ (deleted in Task 2)
grep -c '<<<<<<<\|=======$\|>>>>>>>' $(git diff --name-only --diff-filter=U 2>/dev/null) 2>/dev/null; git diff --check
cd agent && go build ./... && gofmt -l internal/ && cd ..
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: no markers, agent builds, gofmt clean, typecheck passes.

Then verify the load-bearing AUTO-MERGED regions (these carried no conflict markers but the spec depends on them):

```bash
# moveOrg: B's FK-cascade skip guard survived main's +89-line rewrite
grep -n "DEVICE_ORG_FK_CASCADE_TABLES" apps/api/src/routes/devices/moveOrg.ts        # the includes(...) continue guard inside the UPDATE loop
# agent schemas: BOTH field sets present
grep -c "agentHealthObservationWireV1Schema\|healthStatus" apps/api/src/routes/agents/schemas.ts   # >= 2
grep -c "rollbackObservation\|rollbackComponentVersions" apps/api/src/routes/agents/schemas.ts     # >= 2
# commands.ts ordering: Track E's PAM supplemental block BEFORE the terminal CAS,
# B's terminal-evidence call AFTER the CAS zero-row check
grep -n "isTerminalPamCommand\|applyCommandAutomationTerminal" apps/api/src/routes/agents/commands.ts
# agentWs.ts: B's post-CAS call present and NOT moved after the handler dispatch
grep -n "applyCommandAutomationTerminal" apps/api/src/routes/agentWs.ts
```

Line-number sanity per the spec's ordering constraints; if any ordering looks inverted, STOP and re-check the merge rather than re-ordering code.

- [ ] **Step 11: Focused suites (GREEN set) + recorded REDs**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/routes/agents/heartbeat.test.ts src/routes/agents/schemas.heartbeatTolerance.test.ts \
  src/routes/agents/commands.test.ts src/routes/agentWs.test.ts \
  src/services/commandResultHandlers.test.ts src/services/commandResultHandlers.automation.test.ts \
  src/services/automationRuntime.test.ts src/services/automationRuntime.aiTriage.test.ts \
  src/services/automationRuntime.configPolicy.test.ts src/services/automationActionResults.test.ts \
  src/services/automationTerminalEvidence.test.ts src/jobs/automationWorker.eventFanout.test.ts \
  src/services/tenantCascade.test.ts src/extensions/tenancyRegistry.test.ts \
  src/routes/devices/index.test.ts src/routes/devices/options.test.ts src/routes/devices/options.mountorder.test.ts \
  src/routes/devices/health.test.ts src/routes/devices/health.mountorder.test.ts \
  src/routes/devices/customFieldValues.mountorder.test.ts
cd agent && go test -race ./internal/heartbeat/ ./internal/health/ ./internal/collectors/ && cd ..
pnpm --filter @breeze/web exec vitest run src/components/alerts src/components/filters/DeviceOptionPicker.test.tsx src/hooks/useDeviceOptions.test.tsx
```

Expected: ALL PASS. Then record the deliberate REDs (Task 4's checkpoint):

```bash
pnpm --filter @breeze/web exec vitest run src/components/scripts/ScriptExecutionModal.test.tsx 2>&1 | tail -30
```

Expected: exactly the two `ScriptExecutionModal empty state (2026-08-28 sweep)` tests FAIL (status-filter blame + OS blame); every other test in the file PASSES. Save the failure output verbatim into the commit message body or a note for Task 4. If a DIFFERENT test fails, stop and fix the resolution before committing.

- [ ] **Step 12: Commit the merge (the only --no-verify commit)**

```bash
git add -A
git commit --no-verify -m "merge: port Track B onto current main

Deliberate per-file resolutions per
docs/superpowers/specs/2026-08-31-s0-track-b-current-main-port-design.md
(spec sections 2-3, 6-7; decisions D1, D6-structure). rerere disabled;
the automationsPartnerRls recorded resolution was NOT replayed.
Known deliberate REDs at this commit: the two ScriptExecutionModal
2026-08-28-sweep tests (re-ported in the UI task), and the DB-gated
org-merge registry contracts (closed in the registry task)."
```

---

### Task 2: Migration dedup and rename

**Files:**
- Delete: `apps/api/migrations/2026-09-11-a-automation-resource-bindings.sql`, `…-b-cross-site-restore-permission.sql`, `…-c-recovery-authorization-subject.sql`
- Rename: `apps/api/migrations/2026-09-12-a-agent-health-observations.sql` → `2026-09-28-100000-agent-health-observations.sql`; `2026-09-12-b-automation-action-results.sql` → `2026-09-28-100001-automation-action-results.sql`; `2026-09-12-c-software-inventory-observations.sql` → `2026-09-28-100002-software-inventory-observations.sql`
- Modify: `docs/superpowers/plans/2026-08-24-s0-track-b-fleet-execution-truth.md` (lines 38, 333, 361, 388, 447, 555, 735)

**Interfaces:**
- Consumes: Task 1's merged tree (main's `2026-09-25-a/b/c` files present).
- Produces: a duplicate-free migration set whose three Track B files sort after main's max; Task 3's integration runs apply THESE filenames via `autoMigrate()`.

- [ ] **Step 1: Verify main's max migration is still `2026-09-27-…` and `2026-09-28` is free**

```bash
git ls-tree --name-only HEAD apps/api/migrations/ | sed 's#.*/##' | grep -E '^[0-9]{4}-.*\.sql$' \
  | node -e 'const n=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean); console.log(n.sort((a,b)=>a.localeCompare(b)).pop())'
ls apps/api/migrations/ | grep -c '^2026-09-28'   # expect 0
```

If main moved past `2026-09-27`, pick the next free date and adjust every name below consistently.

- [ ] **Step 2: Delete + rename**

```bash
git rm apps/api/migrations/2026-09-11-a-automation-resource-bindings.sql \
       apps/api/migrations/2026-09-11-b-cross-site-restore-permission.sql \
       apps/api/migrations/2026-09-11-c-recovery-authorization-subject.sql
git mv apps/api/migrations/2026-09-12-a-agent-health-observations.sql      apps/api/migrations/2026-09-28-100000-agent-health-observations.sql
git mv apps/api/migrations/2026-09-12-b-automation-action-results.sql      apps/api/migrations/2026-09-28-100001-automation-action-results.sql
git mv apps/api/migrations/2026-09-12-c-software-inventory-observations.sql apps/api/migrations/2026-09-28-100002-software-inventory-observations.sql
```

No content edits inside the three SQL files (verified: no internal date refs, no `@no-transaction`).

- [ ] **Step 3: Update the Track B plan doc's seven reference lines**

In `docs/superpowers/plans/2026-08-24-s0-track-b-fleet-execution-truth.md`, rewrite every occurrence of the three old names to the new names (lines 38, 333, 388, 447, 555, 735), and on line 361 also replace the stale sequencing claim `after shipped main migrations through \`2026-09-10\`` with `after shipped main migrations through \`2026-09-27-technician-ticket-write-permissions.sql\``. Then:

```bash
grep -rn "2026-09-1[12]-" --include='*.ts' --include='*.md' --include='*.sql' apps/ docs/ | grep -v "2026-09-12-100\|2026-09-11-[d-z]\|2026-09-11-peripheral"   # expect empty
```

(The excluded patterns are main's own unrelated `2026-09-12-100000/100001` and `2026-09-11-*` migrations, which stay.)

- [ ] **Step 4: Run the reference-existence gate and the naming guard**

```bash
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
git add -A && bash scripts/check-migration-naming.sh --staged
```

Expected: autoMigrate suite PASSES (including "resolves every core migration path referenced from apps/api/src"); naming guard prints OK for the three added names.

- [ ] **Step 5: Commit (hooks ON)**

```bash
git commit -m "chore(db): dedupe Track A migrations and resequence Track B trio after current main"
```

---

### Task 3: Org-merge registry and trigger classification (RED → GREEN)

**Files:**
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (five `REPOINT_TABLES` insertions)
- Modify: `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts` (two `ORG_ID_BENIGN_TRIGGERS` entries)

**Interfaces:**
- Consumes: Task 2's migration set (the stack applies Track B's tables under the new filenames).
- Produces: a complete org-merge policy cover; Task 6's full battery relies on these suites being green.

- [ ] **Step 1: Bring up the disposable stack**

```bash
pnpm --filter @breeze/api test:docker:up
```

- [ ] **Step 2: RED — run the contract before touching anything**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts 2>&1 | tail -40
```

Expected TWO failures, capture both verbatim: (a) "every required table has exactly one policy" listing the five Track B tables as missing; (b) the unreviewed-trigger assertion naming `agent_health_observations.agent_health_observations_immutable_trg` and `software_inventory_observations.software_inventory_observations_immutable_trg`. If the failures differ from this prediction, STOP and reconcile with the spec before writing code.

- [ ] **Step 3: Registry — five alphabetical `REPOINT_TABLES` insertions**

In `apps/api/src/services/orgMergeRegistry.ts`, insert into the existing alphabetical list:

```ts
  'agent_health_observations',      // before 'agent_logs'
  'automation_action_results',      // after 'audit_retention_policies', before 'automation_policies'
  'device_agent_health_latest',     // after 'deployments', before 'device_boot_metrics'
  'device_software_inventory_state',// after 'device_sessions', before 'device_vulnerabilities'
  'software_inventory_observations',// after 'software_inventory', before 'software_policies'
```

(Strip the placement comments if the surrounding list carries none — match the file's existing style. Rationale lives in spec §5, not in comments.)

- [ ] **Step 4: Trigger classification — two BENIGN entries**

In `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts`, add to `ORG_ID_BENIGN_TRIGGERS`, placed beside the existing `agent_rollback_events` / `peripheral_policy_delivery_events` pair which carries the identical note:

```ts
  // Track B durable evidence: both immutability guards deliberately omit
  // org_id from their compared set so the device move / merge repoint
  // contract can restamp tenancy; every evidence field stays immutable.
  'agent_health_observations.agent_health_observations_immutable_trg': 'org_id-only device-owner restamp',
  'software_inventory_observations.software_inventory_observations_immutable_trg': 'org_id-only device-owner restamp',
```

Do NOT add anything to `ORG_ID_BLOCKING_TRIGGERS` or `ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS`, and do not touch the PAM discharge entries.

- [ ] **Step 5: GREEN + neighborhood**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/site-scope-coverage.integration.test.ts \
  src/__tests__/integration/automationResourceBindings.integration.test.ts \
  src/__tests__/integration/recoveryAuthorizationSubjectMigration.integration.test.ts
pnpm --filter @breeze/api exec vitest run src/routes/devices/moveOrg.coverage.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/orgMergeRegistry.ts apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts
git commit -m "fix(api): classify Track B durable evidence for org merge

Five repoint policies plus two benign org_id-restamp trigger
classifications; blocks-merge deliberately NOT extended (spec section 5)."
```

Leave the stack up if proceeding straight to Task 5's D6 proof; otherwise `pnpm --filter @breeze/api test:docker:down`.

---

### Task 4: UI re-port of the #4172 empty-state fix (TDD)

**Files:**
- Modify: `apps/web/src/components/scripts/ScriptExecutionModal.tsx`
- Modify: `apps/web/src/components/alerts/AlertsPage.resolveConflict.test.tsx` (stub hygiene)
- Test (already exists, currently RED): `apps/web/src/components/scripts/ScriptExecutionModal.test.tsx` — the two `2026-08-28 sweep` tests

**Interfaces:**
- Consumes: `useDeviceOptions(input)` (Track B hook; returns `{ state, options, page, canSubmit, loadMore, … }` — read `apps/web/src/hooks/useDeviceOptions.ts` for the exact result type), `DeviceOptionPicker` (`result`, `selectedIds`, `onSelectedIdsChange`, `search`, `onSearchChange`, `showSelectAll`), i18n keys already present in all 8 `apps/web/src/locales/*/scripts.json`: `scriptExecutionModal.empty.offlineFiltered_one/_other`, `.empty.showAllDevices`, `.empty.noCompatibleDevices`, `.orSeparator`.
- Produces: nothing consumed by later tasks; this closes the Task 1 recorded RED.

- [ ] **Step 1: RED — re-verify the two failing tests**

```bash
pnpm --filter @breeze/web exec vitest run src/components/scripts/ScriptExecutionModal.test.tsx 2>&1 | tail -20
```

Expected: exactly `blames the status filter, not the OS, when compatible devices are merely offline` and `still blames the OS when no device is OS-compatible at all` FAIL; all other tests PASS.

- [ ] **Step 2: Recover main's original fix for reference**

```bash
git show origin/main:apps/web/src/components/scripts/ScriptExecutionModal.tsx > /tmp/sem-main.tsx
```

Read its `compatibleAfterStatusCount` / `statusFilteredEmptyState` block and the branching empty-state JSX (search for `offlineFiltered`). The re-port must reproduce that behavior, not that code.

- [ ] **Step 3: Implement on the DeviceOptionPicker path**

In `ScriptExecutionModal.tsx`, after the existing `deviceOptions` derivation, add (adapt names to the file's actual locals — `devices` is the legacy prop, `statusFilter`, `setStatusFilter`, `script`, `t` all exist):

```tsx
// #4172 re-port: when the picker is empty ONLY because the status filter
// hid OS-compatible devices, blame the filter and offer a reset instead of
// the misleading OS-mismatch message.
const compatibleDevices = useMemo(
  () => (devices ?? []).filter((d) => script.osTypes.includes(d.os)),
  [devices, script.osTypes],
);
const statusFilterActive = statusFilter !== 'all';
const pickerEmpty = deviceOptions.state === 'empty';
// Exact count for the server-options path: a one-row probe with the status
// filter lifted, enabled only on the empty+filtered path (spec D4 option b).
const unfilteredProbe = useDeviceOptions({
  search: query,
  siteId,
  osType: script.osTypes.length === 1 ? script.osTypes[0] : undefined,
  status: undefined,
  limit: 1,
  enabled: devices === undefined && isOpen && statusFilterActive && pickerEmpty,
});
const hiddenCompatibleCount =
  devices !== undefined ? compatibleAfterStatusGap : (unfilteredProbe.page?.total ?? 0);
const statusFilteredEmptyState =
  pickerEmpty && statusFilterActive && hiddenCompatibleCount > 0;
```

where `compatibleAfterStatusGap` is main's exact legacy-path computation: `compatibleDevices.length - compatibleDevices.filter((d) => d.status === statusFilter).length` collapsed to the count of compatible devices hidden by the filter. Below the `<DeviceOptionPicker …/>`, add:

```tsx
{pickerEmpty && (
  statusFilteredEmptyState ? (
    <div className="p-4 text-center text-sm text-muted-foreground space-y-2">
      <p>
        {t('scriptExecutionModal.empty.offlineFiltered', {
          count: hiddenCompatibleCount,
          status:
            statusFilter === 'maintenance'
              ? t('scriptExecutionModal.status.maintenance')
              : t(`common:states.${statusFilter}`),
        })}
      </p>
      <button type="button" onClick={() => setStatusFilter('all')} className="text-xs text-primary hover:underline">
        {t('scriptExecutionModal.empty.showAllDevices')}
      </button>
    </div>
  ) : (
    <p className="p-4 text-center text-sm text-muted-foreground">
      {t('scriptExecutionModal.empty.noCompatibleDevices', {
        os: script.osTypes.map((os) => t(`scriptExecutionModal.os.${os}`)).join(t('scriptExecutionModal.orSeparator')),
      })}
    </p>
  )
)}
```

Copy the interpolation shapes (`count`/`status`/`os` argument names, the maintenance special-case) from `/tmp/sem-main.tsx` verbatim — the i18n keys must be used exactly as main used them. If `DeviceOptionPicker` renders its own hardcoded `No devices found.` paragraph on empty, suppress the duplicate by checking whether the picker exposes an empty-slot mechanism; if it does not, leave both (the sweep tests assert only main's strings) and note it in the commit message.

- [ ] **Step 4: GREEN + no collateral**

```bash
pnpm --filter @breeze/web exec vitest run src/components/scripts/ScriptExecutionModal.test.tsx \
  src/components/filters/DeviceOptionPicker.test.tsx src/hooks/useDeviceOptions.test.tsx
```

Expected: ALL PASS — the two sweep tests now green, B's `device option paging` and `admission truth` suites (including the singular-checkbox `execute()` helper) still green. If the default fixture now renders extra checkboxes, fix the implementation, not the tests.

- [ ] **Step 5: Stub hygiene**

In `apps/web/src/components/alerts/AlertsPage.resolveConflict.test.tsx`, update the dead `url === '/devices'` stub to match `url.startsWith('/devices/options?')` returning a valid options envelope (copy the envelope shape from `AlertsPage.test.tsx`). Run:

```bash
pnpm --filter @breeze/web exec vitest run src/components/alerts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/scripts/ScriptExecutionModal.tsx apps/web/src/components/alerts/AlertsPage.resolveConflict.test.tsx
git commit -m "fix(web): re-port status-filter empty-state onto server device options

Restores the #4172 offline-vs-OS disambiguation and Show-all-devices
reset on the DeviceOptionPicker path; exact hidden-count via a one-row
unfiltered probe on the empty+filtered path (spec D4)."
```

---

### Task 5: Dead-code cleanup (D5) and the D6 Postgres proof

**Files:**
- Modify: `apps/api/src/services/automationRuntime.ts` (delete two dead functions)
- Possibly modify: `apps/api/src/__tests__/integration/automationsPartnerRls.integration.test.ts` (only if the observed string differs)

**Interfaces:**
- Consumes: Task 1's D1 resolution (which made the two functions caller-less) and Task 3's stack mechanism.
- Produces: the proven D6 assertion string recorded in the commit message.

- [ ] **Step 1: D5 — delete `markDeviceResultRunning` and `finalizeDeviceResult`**

```bash
grep -n "markDeviceResultRunning\|finalizeDeviceResult" apps/api/src/services/automationRuntime.ts
```

Expected: definition sites only. Delete both function definitions entirely. Then:

```bash
grep -rn "markDeviceResultRunning\|finalizeDeviceResult" apps/api/src/ | grep -v '\.test\.'   # expect empty
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/api exec vitest run src/services/automationRuntime.test.ts src/services/automationRuntime.configPolicy.test.ts
```

- [ ] **Step 2: D6 proof — demonstrate the assertion discriminates**

With the stack up (`pnpm --filter @breeze/api test:docker:up` if torn down):

First prove the OLD string is genuinely dead under B's runtime — temporarily change the Task 1 assertion back to `toContain('send_notification action failed')` and run:

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/automationsPartnerRls.integration.test.ts 2>&1 | tail -25
```

Expected: the `#2023` test FAILS, and the failure output prints the ACTUAL row error string. Restore the assertion to match the actual observed string (predicted: `Notification channel type pagerduty is not implemented`; if the observation differs, use the observed string and update the comment). Re-run: expected ALL PASS. Record both runs (fail line + pass line) in the commit message.

- [ ] **Step 3: Commit and tear down**

```bash
git add apps/api/src/services/automationRuntime.ts apps/api/src/__tests__/integration/automationsPartnerRls.integration.test.ts
git commit -m "chore(api): drop caller-less device-result finalizers; prove partner-RLS failure string

D5: markDeviceResultRunning/finalizeDeviceResult behavior lives in
reconcileAutomationRun since the action-result rework; zero callers.
D6: asserted error string proven RED (old dispatch-log string) then
GREEN (observed outcome message) against real PostgreSQL."
pnpm --filter @breeze/api test:docker:down
```

---

### Task 6: Full battery and push

**Files:** none modified (verification only, plus push).

**Interfaces:**
- Consumes: everything above.
- Produces: a pushed head with CI attached — the exact-head evidence for the PR.

- [ ] **Step 1: API focused battery (unit)** — rerun the Task 1 Step 11 unit list PLUS `src/db/autoMigrate.test.ts`; expect ALL PASS.

- [ ] **Step 2: Integration battery (stack up)**

```bash
pnpm --filter @breeze/api test:docker:up
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/site-scope-coverage.integration.test.ts \
  src/__tests__/integration/automationResourceBindings.integration.test.ts \
  src/__tests__/integration/automationsPartnerRls.integration.test.ts \
  src/__tests__/integration/recoveryAuthorizationSubjectMigration.integration.test.ts \
  src/__tests__/integration/automationActionResults.integration.test.ts \
  src/__tests__/integration/automationTerminalReconciliation.integration.test.ts \
  src/__tests__/integration/agentHealthObservations.integration.test.ts \
  src/__tests__/integration/softwareInventoryObservations.integration.test.ts \
  src/__tests__/integration/pamActuationLifecycle.integration.test.ts
pnpm --filter @breeze/api test:rls && pnpm --filter @breeze/api test:rls-coverage && pnpm --filter @breeze/api test:site-scope-coverage
pnpm --filter @breeze/api db:check-drift
pnpm --filter @breeze/api test:docker:down
```

Expected: ALL PASS; drift reports one ledger row per on-disk file (duplicate-free set).

- [ ] **Step 3: Agent + web + types + lint**

```bash
cd agent && go build ./... && go test -race ./... && GOOS=windows GOARCH=amd64 go build ./... && cd ..
pnpm --filter @breeze/web exec vitest run
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/web exec tsc --noEmit
git diff 686e46c9d..HEAD --name-only | grep -E '\.(ts|tsx)$' | xargs pnpm exec eslint 2>/dev/null || true   # review output; fix real findings in touched files only
```

- [ ] **Step 4: Push and confirm CI attached**

```bash
git push origin fix/s0-track-b-fleet-execution-truth
sleep 30 && gh run list --branch fix/s0-track-b-fleet-execution-truth --limit 5
```

Expected: workflow runs exist for the NEW head SHA (known gotcha: a push can silently spawn zero runs). Fallback if zero: `gh workflow run ci.yml --ref fix/s0-track-b-fleet-execution-truth`, then re-check.

---

### Task 7: PR body, tracker, and handoff to review

**Files:** none in-repo (GitHub state).

- [ ] **Step 1:** Update #4064's body: add a "Current-main port" section citing the spec path, the merge commit SHA, decisions D1–D6, the recorded RED→GREEN checkpoints (org-merge registry, sweep tests, D6 string), and the migration dedup/rename. Preserve every existing evidence-boundary statement.
- [ ] **Step 2:** Comment on #4060 (do not edit the table yet — the tracker row updates after CI settles): port pushed at `<head SHA>`, gates run, CI pending.
- [ ] **Step 3:** Hand back to the session for the independent review round (superpowers:requesting-code-review) before any merge action. The review scope is `686e46c9d..HEAD`.
