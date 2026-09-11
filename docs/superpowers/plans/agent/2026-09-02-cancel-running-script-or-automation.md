---
issue: LanternOps/breeze#3525
tracking_issue: LanternOps/breeze#4761
spec: docs/superpowers/specs/agent/2026-09-02-cancel-running-script-or-automation-spec.md
status: draft
date: 2026-09-02
area: scripts / automations / agent
---

# Cancel a Running Script or Automation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /scripts/executions/:id/cancel` actually stop the process on the endpoint, add an equivalent for automation runs, and never let a row claim the script stopped unless the device proved it.

**Architecture:** The API gains a transient `cancelling` execution state plus a separate `cancel_state` lifecycle column (spec OD8-C), queues a real `script_cancel` `device_commands` row keyed on the **original command id** (the spec's blocker fix), and closes the state through five distinct closers. The Go agent gains a blocking `Executor.Cancel` that reports a real outcome, SIGTERM→SIGKILL grace escalation on Unix, and a Windows Job Object for process-tree containment. Automation runs cancel by fanning out over `script_executions.automation_run_id` behind an atomic dispatch fence.

**Tech Stack:** Hono + Drizzle + PostgreSQL (hand-written SQL migrations), BullMQ reaper jobs, Go 1.x agent (`os/exec`, `golang.org/x/sys/windows`), Astro + React web, Vitest / `go test -race` / Playwright.

**Spec:** `docs/superpowers/specs/agent/2026-09-02-cancel-running-script-or-automation-spec.md` (approved Gate A 2026-09-02; all ten Open Decisions resolved as recommended).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Wire contract (the blocker).** A `script_cancel` payload's `executionId` field MUST carry the **`device_commands.id` of the original `script` command**, NOT `script_executions.id`. The deployed agent keys `e.running` on `cmd.ID` (`agent/internal/heartbeat/handlers_script.go:82` → `agent/internal/executor/executor.go:224`). `script_executions.id` travels as the additive field `scriptExecutionId`, which current agents ignore. Getting this wrong makes the whole feature a fleet-wide silent no-op.
- **Honesty contract.** `script_executions.status` becomes `'cancelled'` **only** when the stop is proven: either the server atomically retracted a still-`pending` command, or the device reported `terminated`, or the original script result carried the cancellation marker. Every other cancellation outcome leaves `status` describing the process and records the failure in `cancel_state`.
- **Grace:** default **5 s**, per-request `graceSeconds` clamped to **0–30 s** (OD2-B). Every downstream deadline must exceed 30 s — notably the agent's helper IPC timeout, today 10 s (`handlers_script.go:289`).
- **`script_cancel` timeout tier:** `LONG_TIMEOUT_TYPES` (2 h). NEVER `SHORT_TIMEOUT_TYPES` — the generic reaper clocks `pending` rows from `createdAt` (`staleCommandReaper.ts:292-307`) and a 5-minute tier would expire an undelivered cancel while the device is merely offline. 2 h strictly exceeds the longest possible script lifetime (`MaxTimeout` 3600 s + `SCRIPT_GRACE_BUFFER_MS` 5 min = 65 min).
- **Migration naming:** the newest **committed** migration is `apps/api/migrations/2026-10-06-100000-script-custom-field-writeback.sql`. New files use `2026-10-07-1000NN-<slug>.sql`. `2026-08-06` is a CLOSED date block. Re-check `git diff --name-only origin/main -- apps/api/migrations/` immediately before every push; rename if `origin/main` gained a later-sorting file.
- **Migrations are idempotent** (`ADD VALUE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then re-add, `pg_policies` checks) and carry **no inner `BEGIN;`/`COMMIT;`** (`autoMigrate` wraps each file). Postgres permits `ALTER TYPE … ADD VALUE` inside the wrapping transaction; it only forbids *using* the new literal before commit — so enum-adding and literal-using SQL must be in **separate files**.
- **`script_executions` is Shape 1 (direct `org_id`)** and is already registered in all four lists: `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts:371`), `CORE_DEVICE_CASCADE_DELETE_TABLES` and `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`), and `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:333`). **No new table is created, so no cascade-list edit is needed — but the export-policy row fires on a new COLUMN.** All five new `script_executions` columns must be classified in the same PR or `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts` redden main.
- **`automation_runs` has NO `org_id` column** and is deliberately absent from both `CORE_ORG_CASCADE_DELETE_ORDER` and `CORE_TENANT_EXPORT_POLICY`. **Do not add an `org_id` (or any `*_org_id`) column to it** — that would silently require entries in both lists. `devices_cancelled integer` is safe.
- **Partner-Wide First does not apply** — no new config/policy table is created. But the authorization split does: an org-scoped operator may cancel individual `script_executions` on their own devices, and may NOT cancel a run of a partner-wide automation. That gate is `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts:25`), and site scope is enforced on top for org-owned runs.
- **Fan-out never filters by the caller's org.** The automation cancel sweep keys on `script_executions.automation_run_id` alone. `eq(scriptExecutions.orgId, auth.orgId)` would silently no-op most of a partner-wide run (CLAUDE.md §Partner-Wide First rule 5).
- **Config-policy runs are OUT OF SCOPE** (OD10-B). `automation_runs`' config-policy RLS arm only admits `breeze_has_org_access(cp.org_id)` (`migrations/2026-07-02-automations-partner-ownership.sql:97-149`), so partner-owned policy runs are invisible today. The cancel route returns 404 for `automationId IS NULL` runs, matching the existing GET at `routes/automations.ts:705-730`. File the RLS gap as a separate issue.
- **Batch cancel is OUT OF SCOPE** (OD5-B). `script_executions` has no `batch_id` column.
- **Web mutation handlers use `runAction`** (`apps/web/src/lib/runAction.ts`). Guarded by `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`.
- **i18n parity is a hard CI gate.** `apps/web/src/lib/i18n/localeParity.test.ts` asserts **all 7 non-`en` locales** (`de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) match `en` file-for-file and key-for-key, and `translationCoverage.test.ts` flags English-identical values. New keys need real translations in all 8 locales, not English copies.
- **Test-run traps.** Never write `pnpm --filter <pkg> test -- --run <path>` (the `--` makes vitest run the whole suite in watch mode). Use `cd apps/api && npx vitest run <path>`. Vitest path filters are plain substrings, not globs — `vitest run src/routes/scripts` also matches `scripts.*.test.ts` siblings; check the reported file count.
- **`pnpm test` does NOT run the RLS/integration suites.** Touching tenancy or export-policy code means running `vitest.integration.config.ts` explicitly against a real Postgres before opening the PR.

---

## Resolved design gap: the OD8-C state table

The spec approved OD8 option **C** (a separate cancellation-lifecycle column orthogonal to the execution outcome) but never drew C's state diagram — the diagram in spec §1 was drawn under the rejected option B and uses terminal statuses (`cancel_unconfirmed`, `cancel_failed`) that option C does not have. This plan fills that gap. It went through the CLAUDE.md advisor quorum (position formed in-session, independent read-only Codex `gpt-5.6-sol` @ `xhigh`); Codex rejected the first derivation on two points and both objections are adopted below.

**`cancel_state`** (new pgEnum `script_cancel_state`): `requested | confirmed | unconfirmed | failed`. `NULL` means no cancel was ever requested — this avoids a `none` value and needs no backfill on a large table. Invariant: `CHECK ((cancel_state IS NULL) = (cancel_requested_at IS NULL))`.

**`cancelling` is transient, and only a proven stop terminalizes as `cancelled`.** When a cancel resolves without proof, `status` is **reverted** to the value it held when the cancel was requested (stored in `cancel_prev_status`) and the normal closers — the agent's own result, or the untouched `reapStaleScriptExecutions` — close the row honestly.

| Closing evidence | `status` | `cancel_state` |
|---|---|---|
| Original command still `pending`; server atomically retracted it | `cancelled` | `confirmed` |
| `script_cancel` result `outcome: 'terminated'` | `cancelled` | `confirmed` |
| Original script result carries `cancelled: true` + matching `cancelledByCommandId` | `cancelled` | `confirmed` |
| `script_cancel` result `outcome: 'kill_failed'` | revert to `cancel_prev_status` | `failed` |
| `script_cancel` result `outcome: 'not_found'` | revert to `cancel_prev_status` | `unconfirmed` |
| Cancel command expired / agent returned "unknown command" | revert to `cancel_prev_status` | `unconfirmed` |
| Cancellation sweep gives up past `CANCEL_GRACE_MS` from delivery | revert to `cancel_prev_status` | `unconfirmed` |
| Original result wins the race (OD9-C loser) | real outcome (`completed`/`failed`/`timeout`) | `unconfirmed` |

**Why `revert`, not a terminal `failed`.** Codex's decisive counterexample: cancel dispatch expires, the script then succeeds, and a sweep that had stamped `failed` either lies permanently or has to overwrite a supposedly terminal outcome. Reverting resolves it — a failed cancel request does not change what happens to the process. Reverting also keeps the row inside `reapStaleScriptExecutions`' existing `pending|queued|running` predicate, so nothing is stranded and the spec's "do NOT widen the script reaper" constraint holds exactly.

**Why `not_found` is not confirmation.** An agent that restarted has an empty `e.running` map, and on macOS/BSD there is no `Pdeathsig`, so the orphaned process may survive. `not_found` is far more often "the script finished a moment ago and its result is in flight" — which must resolve to the real outcome, not to `cancelled`.

**Consequence (deviation to flag in the PR):** OD1-A specified four columns; this model needs **five** — `cancel_prev_status` is added to make the revert deterministic. All five are timestamps / uuid / enum, none is `json`/`jsonb`/`bytea`, so all five classify as `included` in the export policy.

**`cancel_state` never distinguishes "arrived too late" from "we gave up" on its own** — the pair does. `(completed, unconfirmed)` is the OD9-C loser; `(timeout, unconfirmed)` is a give-up. `cancel_requested_at` and the audit trail carry the rest.

---

## File Structure

**New files**

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-07-100000-cancellation-enums.sql` | Adds every new enum **value** only (`execution_status.cancelling`, new type `script_cancel_state`, `automation_run_status.cancelled`, `automation_device_result_status.cancelled`). Separate file because the next migration writes those literals. |
| `apps/api/migrations/2026-10-07-100100-cancellation-columns.sql` | `script_executions` +5 columns + CHECK + partial index; `automation_runs.devices_cancelled`. |
| `apps/api/src/services/scriptCancellation.ts` | The single implementation of the cancel state machine: `cancelScriptExecution`, `cancelExecutionsForRun`, `resolveCancelOutcome`. Every caller (route, automation fan-out, AI tool) goes through it. |
| `apps/api/src/services/scriptCancellation.test.ts` | The status × command-status matrix and the wire-contract regression test. |
| `apps/api/src/services/automationRunCancellation.ts` | `cancelAutomationRun` — authorization-free core: fence, fan-out, uncancellable-action classification. |
| `apps/api/src/services/automationRunCancellation.test.ts` | Fence and fan-out unit tests. |
| `apps/api/src/services/scriptCancellationPartnerRls.integration.test.ts` | Partner/org/site authorization against real Postgres. |
| `apps/api/src/services/automationRunCancelFence.integration.test.ts` | Proves zero child rows are created after the fence commits. |
| `agent/internal/executor/job_windows.go` | Windows Job Object containment (create → limit → assign → terminate) behind the `windowsJobPrimitives` interface. |
| `agent/internal/executor/job_contract_test.go` | Fake-backed call-order contract test, no build tag, modelled on `agent/internal/pamlifetime/job_contract_test.go`. |
| `agent/internal/executor/cancel_test.go` | Escalation ladder, pre-start registration, blocking `Cancel`, process-tree kill. |
| `apps/web/src/components/scripts/executionStatus.ts` | Shared status maps + `CancelState` copy resolution for both scripts components. |
| `apps/web/src/components/scripts/executionStatus.test.tsx` | Union-exhaustiveness regression test (the guard for the two live crashes). |
| `e2e-tests/pages/ScriptsPage.ts` | Page object (testid-only). |
| `e2e-tests/tests/script-cancel.spec.ts` | 120 s sleep script → Stop → Cancelled. |
| `apps/docs/src/content/docs/scripts/stopping-a-running-script.mdx` | Operator doc. |

**Modified files** (responsibility of each change is stated in its task): `apps/api/src/db/schema/scripts.ts`, `apps/api/src/db/schema/automations.ts`, `apps/api/src/services/commandQueue.ts`, `apps/api/src/services/commandTimeouts.ts`, `apps/api/src/routes/agents/commands.ts`, `apps/api/src/services/commandResultHandlers.ts`, `apps/api/src/jobs/staleCommandReaper.ts`, `apps/api/src/routes/scripts.ts`, `apps/api/src/routes/automations.ts`, `apps/api/src/routes/devices/events.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/services/automationRuntime.ts`, `apps/api/src/services/automationActionResults.ts`, `apps/api/src/services/aiToolsScripts.ts`, `apps/api/src/openapi.ts`, `packages/shared/src/types/index.ts`, `apps/web/src/components/scripts/{ExecutionHistory,ExecutionDetails,ScriptExecutionsPage}.tsx`, `apps/web/src/components/automations/AutomationRunHistory.tsx`, `apps/web/src/locales/*/scripts.json`, `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, `agent/internal/executor/{executor,limits_unix,limits_linux,limits_windows}.go`, `agent/internal/heartbeat/handlers_script.go`, `agent/internal/heartbeat/heartbeat.go`, `agent/internal/userhelper/client.go`, `.github/workflows/ci.yml`, `apps/docs/src/content/docs/agents/commands.mdx`.

---

## Waves

Each wave is an independently shippable PR. Dependencies: **W01** and **W04** stand alone. **W03**, **W05**, **W06** each depend on **W02**. **W06** also depends on **W01**.

| Wave | Content | Depends on |
|---|---|---|
| W01 | Status-union widening across web/shared/OpenAPI + exhaustiveness tests. Fixes two live UI crashes; ships alone with no API change. | — |
| W02 | Migrations, export-policy classification, `CommandTypes.SCRIPT_CANCEL` + all four registration lists, `services/scriptCancellation.ts`, rewritten route with post-commit delivery, AI tool. | — |
| W03 | The five closers: result-handler CAS, cancellation sweep, cancel-command expiry, late-result recovery, audit events. | W02 |
| W04 | Go agent: bypass lane, pre-start registration, blocking `Cancel` with real outcomes, PGID capture, grace escalation, Windows Job Object, helper `not_found` correctness, Windows CI package list. Canary before fleet promote. | — |
| W05 | Automation run cancel: enum values, dispatch fence, fan-out, `devices_cancelled`, reconciliation awareness, log append, `automation.cancelled` event. | W02 |
| W06 | Web UI affordances, polling, i18n, docs, E2E. | W01, W02 |

---

# Wave 01 — Status-union widening (fixes two live crashes)

Ships alone. No API dependency. `ExecutionHistory.tsx:284` does `statusConfig[execution.status].icon` unguarded against a 5-member map, while the DB enum has 7 values — `queued` (written by `automationRuntime.ts:1239-1248`) and `cancelled` (written by the existing cancel route) both crash the render today.

### Task 1.1: Shared + OpenAPI status types

**Files:**
- Modify: `packages/shared/src/types/index.ts:431`
- Modify: `apps/api/src/openapi.ts:538`
- Test: `packages/shared/src/types/executionStatus.test.ts` (create)

**Interfaces:**
- Produces: `ExecutionStatus` (unchanged 7 values, already correct at `index.ts:383`), `AutomationRunStatus` widened to include `'cancelled'`, and two new exported const arrays `EXECUTION_STATUSES` / `AUTOMATION_RUN_STATUSES` that later waves iterate in tests.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/types/executionStatus.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  EXECUTION_STATUSES,
  AUTOMATION_RUN_STATUSES,
  type ExecutionStatus,
  type AutomationRunStatus,
} from './index';

describe('status unions are enumerable', () => {
  it('EXECUTION_STATUSES matches the execution_status pgEnum', () => {
    expect([...EXECUTION_STATUSES].sort()).toEqual(
      ['cancelled', 'cancelling', 'completed', 'failed', 'pending', 'queued', 'running', 'timeout'].sort(),
    );
  });

  it('AUTOMATION_RUN_STATUSES matches the automation_run_status pgEnum', () => {
    expect([...AUTOMATION_RUN_STATUSES].sort()).toEqual(
      ['cancelled', 'completed', 'failed', 'partial', 'running'].sort(),
    );
  });

  it('the arrays are assignable to their unions', () => {
    const e: readonly ExecutionStatus[] = EXECUTION_STATUSES;
    const a: readonly AutomationRunStatus[] = AUTOMATION_RUN_STATUSES;
    expect(e.length).toBe(8);
    expect(a.length).toBe(5);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && npx vitest run src/types/executionStatus.test.ts`
Expected: FAIL — `EXECUTION_STATUSES` and `AUTOMATION_RUN_STATUSES` are not exported.

- [ ] **Step 3: Widen the shared types**

In `packages/shared/src/types/index.ts`, replace the type alias at line 383 and line 431 with array-derived unions:

```ts
export const EXECUTION_STATUSES = [
  'pending', 'queued', 'running', 'cancelling',
  'completed', 'failed', 'timeout', 'cancelled',
] as const;
export type ExecutionStatus = typeof EXECUTION_STATUSES[number];

export const CANCEL_STATES = ['requested', 'confirmed', 'unconfirmed', 'failed'] as const;
export type CancelState = typeof CANCEL_STATES[number];

export const AUTOMATION_RUN_STATUSES = [
  'running', 'completed', 'failed', 'partial', 'cancelled',
] as const;
export type AutomationRunStatus = typeof AUTOMATION_RUN_STATUSES[number];
```

Then extend the `ScriptExecution` interface (which uses `ExecutionStatus` at line 415) with the four read-only cancellation fields the API will return from W02:

```ts
  cancelRequestedAt?: string | null;
  cancelState?: CancelState | null;
  cancelledBy?: string | null;
  cancelCommandId?: string | null;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd packages/shared && npx vitest run src/types/executionStatus.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Widen the OpenAPI schemas**

In `apps/api/src/openapi.ts`, change the `ScriptExecution` schema's status enum (line 374) to:

```ts
        status: { type: 'string', enum: ['pending', 'queued', 'running', 'cancelling', 'completed', 'failed', 'timeout', 'cancelled'] },
        cancelState: { type: 'string', nullable: true, enum: ['requested', 'confirmed', 'unconfirmed', 'failed'] },
        cancelRequestedAt: { type: 'string', format: 'date-time', nullable: true },
        cancelCommandId: { type: 'string', format: 'uuid', nullable: true },
```

and the `AutomationRun` schema's status enum (line 538) to:

```ts
        status: { type: 'string', enum: ['running', 'completed', 'failed', 'partial', 'cancelled'] },
        devicesCancelled: { type: 'integer' },
```

Also correct the stale `cancelScriptExecution` response documentation at line 2689 — it currently advertises only `Success` and `400`, while the route already answers 403/404/409:

```ts
    responses: {
      '200': {
        description: 'Cancellation accepted (idempotent when already cancelling or already cancelled)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } }
      },
      '403': { $ref: '#/components/responses/Forbidden' },
      '404': { $ref: '#/components/responses/NotFound' },
      '409': { description: 'Execution is no longer cancellable' }
    }
```

- [ ] **Step 6: Typecheck and commit**

```bash
cd packages/shared && npx tsc --noEmit && cd ../../apps/api && npx tsc --noEmit
cd ../.. && git add packages/shared/src/types/index.ts packages/shared/src/types/executionStatus.test.ts apps/api/src/openapi.ts
git commit -m "fix(shared): enumerate execution and automation-run status unions

Adds the missing 'cancelling'/'cancelled' members and exports the unions
as const arrays so status maps can be tested for exhaustiveness. #3525"
```

---

### Task 1.2: Script execution status maps — one source, exhaustively tested

**Files:**
- Create: `apps/web/src/components/scripts/executionStatus.ts`
- Create: `apps/web/src/components/scripts/executionStatus.test.tsx`
- Modify: `apps/web/src/components/scripts/ExecutionHistory.tsx:7,33-39,203-208,284,303,309`
- Modify: `apps/web/src/components/scripts/ExecutionDetails.tsx:6,15-21,171,196,201,207,209,212-220`

**Interfaces:**
- Consumes: `ExecutionStatus`, `EXECUTION_STATUSES`, `CancelState` from `@breeze/shared` (Task 1.1).
- Produces: `executionRowStatusConfig`, `executionDetailStatusConfig`, `resolveExecutionStatusLabel(status, cancelState)` — all consumed by W06.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/scripts/executionStatus.test.tsx`. This is the regression guard for the two live crashes — it iterates the union rather than a hand-written list, so a future enum value fails here instead of at render time:

```tsx
import { describe, it, expect } from 'vitest';
import { EXECUTION_STATUSES, CANCEL_STATES } from '@breeze/shared';
import {
  executionRowStatusConfig,
  executionDetailStatusConfig,
  resolveExecutionStatusLabel,
} from './executionStatus';

describe('every execution status resolves in both status maps', () => {
  it.each(EXECUTION_STATUSES)('row config has label, color and icon for %s', (status) => {
    const entry = executionRowStatusConfig[status];
    expect(entry).toBeDefined();
    expect(entry.label).toBeTruthy();
    expect(entry.color).toBeTruthy();
    expect(entry.icon).toBeTruthy();
  });

  it.each(EXECUTION_STATUSES)('detail config has label, color, bgColor and icon for %s', (status) => {
    const entry = executionDetailStatusConfig[status];
    expect(entry).toBeDefined();
    expect(entry.label).toBeTruthy();
    expect(entry.color).toBeTruthy();
    expect(entry.bgColor).toBeTruthy();
    expect(entry.icon).toBeTruthy();
  });

  it.each(EXECUTION_STATUSES)('label resolution never returns empty for %s with no cancel state', (status) => {
    expect(resolveExecutionStatusLabel(status, null)).toBeTruthy();
  });

  it('an unconfirmed cancel gets its own label, distinct from a confirmed one', () => {
    expect(resolveExecutionStatusLabel('cancelled', 'confirmed'))
      .not.toBe(resolveExecutionStatusLabel('completed', 'unconfirmed'));
    expect(resolveExecutionStatusLabel('completed', 'unconfirmed'))
      .toBe('status.completedCancelTooLate');
  });

  it.each(CANCEL_STATES)('every cancel state resolves a label against a terminal status: %s', (cancelState) => {
    expect(resolveExecutionStatusLabel('completed', cancelState)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/scripts/executionStatus.test.tsx`
Expected: FAIL — `Failed to resolve import "./executionStatus"`.

- [ ] **Step 3: Create the shared status module**

Create `apps/web/src/components/scripts/executionStatus.ts`:

```ts
/**
 * Single source of truth for script-execution status presentation.
 *
 * Both ExecutionHistory and ExecutionDetails previously kept private 5-member
 * maps keyed on a private 5-member union, while the DB enum has 8 values. Both
 * indexed the map unguarded, so a `queued` or `cancelled` row crashed the whole
 * list render (#3525). Keying these maps on the SHARED union makes a missing
 * member a `tsc --noEmit` error, and executionStatus.test.tsx makes it a
 * runtime assertion too.
 */
import { AlertTriangle, Ban, CheckCircle, Clock, Loader2, XCircle } from 'lucide-react';
import type { ExecutionStatus, CancelState } from '@breeze/shared';

type RowEntry = { label: string; color: string; icon: typeof CheckCircle };
type DetailEntry = { label: string; color: string; bgColor: string; icon: typeof CheckCircle };

export const executionRowStatusConfig: Record<ExecutionStatus, RowEntry> = {
  pending: { label: 'status.pending', color: 'bg-muted text-muted-foreground border-border', icon: Clock },
  queued: { label: 'status.queued', color: 'bg-muted text-muted-foreground border-border', icon: Clock },
  running: { label: 'status.running', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: Loader2 },
  cancelling: { label: 'status.cancelling', color: 'bg-warning/15 text-warning border-warning/30', icon: Loader2 },
  completed: { label: 'status.completed', color: 'bg-success/15 text-success border-success/30', icon: CheckCircle },
  failed: { label: 'status.failed', color: 'bg-destructive/15 text-destructive border-destructive/30', icon: XCircle },
  timeout: { label: 'status.timeout', color: 'bg-warning/15 text-warning border-warning/30', icon: AlertTriangle },
  cancelled: { label: 'status.cancelled', color: 'bg-muted text-muted-foreground border-border', icon: Ban },
};

export const executionDetailStatusConfig: Record<ExecutionStatus, DetailEntry> = {
  pending: { label: 'status.pending', color: 'text-muted-foreground', bgColor: 'bg-muted', icon: Clock },
  queued: { label: 'status.queued', color: 'text-muted-foreground', bgColor: 'bg-muted', icon: Clock },
  running: { label: 'status.running', color: 'text-blue-700 dark:text-blue-400', bgColor: 'bg-blue-500/10', icon: Loader2 },
  cancelling: { label: 'status.cancelling', color: 'text-warning', bgColor: 'bg-warning/10', icon: Loader2 },
  completed: { label: 'status.completed', color: 'text-success', bgColor: 'bg-success/10', icon: CheckCircle },
  failed: { label: 'status.failed', color: 'text-destructive', bgColor: 'bg-destructive/10', icon: XCircle },
  timeout: { label: 'status.timeout', color: 'text-warning', bgColor: 'bg-warning/10', icon: AlertTriangle },
  cancelled: { label: 'status.cancelled', color: 'text-muted-foreground', bgColor: 'bg-muted', icon: Ban },
};

/**
 * The status alone is not the whole truth once a cancel was requested. See the
 * OD8-C state table in the plan: (completed, unconfirmed) is "your stop request
 * arrived too late", (cancelled, confirmed) is a proven stop, and a terminal
 * status with cancel_state 'failed' means the device could not kill it.
 */
export function resolveExecutionStatusLabel(
  status: ExecutionStatus,
  cancelState: CancelState | null | undefined,
): string {
  if (!cancelState || cancelState === 'requested') {
    return executionRowStatusConfig[status].label;
  }
  if (status === 'cancelled') return 'status.cancelled';
  if (cancelState === 'failed') return 'status.cancelFailed';
  return `status.${status}CancelTooLate`;
}
```

> **Note for the implementer.** `resolveExecutionStatusLabel` returns `status.${status}CancelTooLate` for a non-`cancelled` terminal status. Only three terminal statuses can reach that branch (`completed`, `failed`, `timeout`), so W06 adds exactly `status.completedCancelTooLate`, `status.failedCancelTooLate`, `status.timeoutCancelTooLate` and `status.cancelFailed` to the i18n catalogs. Do not template a key for `pending`/`queued`/`running`/`cancelling` — a non-terminal status always has `cancelState === 'requested'` and short-circuits above.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/web && npx vitest run src/components/scripts/executionStatus.test.tsx`
Expected: PASS.

- [ ] **Step 5: Point both components at the shared module**

In `apps/web/src/components/scripts/ExecutionHistory.tsx`:
- Delete the local `export type ExecutionStatus = ...` at line 7 and re-export the shared one so `ExecutionDetails.tsx`'s existing import keeps working:
  ```ts
  export type { ExecutionStatus } from '@breeze/shared';
  ```
- Delete the local `statusConfig` (lines 33-39) and import `executionRowStatusConfig as statusConfig` from `./executionStatus`.
- Add the missing filter options after line 208 so the new statuses are selectable:
  ```tsx
  <option value="queued">{t('executionHistory.status.queued')}</option>
  <option value="cancelling">{t('executionHistory.status.cancelling')}</option>
  <option value="cancelled">{t('executionHistory.status.cancelled')}</option>
  ```

In `apps/web/src/components/scripts/ExecutionDetails.tsx`:
- Delete the local `statusConfig` (lines 15-21) and import `executionDetailStatusConfig as statusConfig` from `./executionStatus`.
- Replace the if/else-if chain at lines 212-220 — whose final `else` silently falls through to the `pending` copy — with a total map lookup:
  ```tsx
  <p className="text-sm text-muted-foreground">
    {t(/* i18n-dynamic */ `executionDetails.statusDescription.${execution.status}`)}
  </p>
  ```

- [ ] **Step 6: Run the scripts component tests and typecheck**

Run: `cd apps/web && npx vitest run src/components/scripts && npx tsc --noEmit`
Expected: PASS. Note the substring filter also pulls in `ScriptTestRunner` and any other `src/components/scripts/*` specs — check the reported file count and that none regressed.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/scripts/
git commit -m "fix(web): script execution status maps cover every DB enum value

ExecutionHistory and ExecutionDetails each kept a private 5-member
statusConfig and indexed it unguarded, so a 'queued' or 'cancelled' row
crashed the render. Both now key on the shared 8-member union, with an
exhaustiveness test. #3525"
```

---

### Task 1.3: Automation run status map

**Files:**
- Modify: `apps/web/src/components/automations/AutomationRunHistory.tsx:73-86,99-100,352,370,377,378,381,184,207`
- Test: `apps/web/src/components/automations/AutomationRunHistory.statusMaps.test.tsx` (create)

**Interfaces:**
- Consumes: `AUTOMATION_RUN_STATUSES` from `@breeze/shared` (Task 1.1).
- Produces: exported `statusConfig` and `AutomationRunHistoryStatusKey` for the test.

> `AutomationRunHistory` renders the API's *presentation* status, which `routes/automations.ts:400` maps `completed → success`. So the component's key set is `AUTOMATION_RUN_STATUSES` with `completed` renamed to `success`, plus the device-level values `pending`/`skipped`. The test asserts that mapping explicitly rather than assuming the two unions are the same.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/automations/AutomationRunHistory.statusMaps.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { AUTOMATION_RUN_STATUSES } from '@breeze/shared';
import { statusConfig } from './AutomationRunHistory';

/** routes/automations.ts:400 `toRunStatus` renames completed -> success on the wire. */
const toPresentation = (s: string) => (s === 'completed' ? 'success' : s);

describe('automation run status map covers every run status', () => {
  it.each(AUTOMATION_RUN_STATUSES)('has label, color, bgColor and icon for %s', (status) => {
    const entry = statusConfig[toPresentation(status) as keyof typeof statusConfig];
    expect(entry, `missing statusConfig entry for ${status}`).toBeDefined();
    expect(entry.label).toBeTruthy();
    expect(entry.icon).toBeTruthy();
  });

  it.each(['pending', 'running', 'success', 'failed', 'skipped', 'cancelled'] as const)(
    'has an entry for device-result status %s',
    (status) => {
      expect(statusConfig[status]).toBeDefined();
    },
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/automations/AutomationRunHistory.statusMaps.test.tsx`
Expected: FAIL — `statusConfig` is not exported, and once exported, `cancelled` is missing.

- [ ] **Step 3: Widen and export the map**

In `apps/web/src/components/automations/AutomationRunHistory.tsx`:
- Line 73-86: add `'cancelled'` to `AutomationRun['status']` and add `devicesCancelled?: number`.
- Line 99: widen and export:
  ```ts
  export type AutomationRunHistoryStatusKey =
    'running' | 'success' | 'failed' | 'partial' | 'skipped' | 'pending' | 'cancelled';

  export const statusConfig: Record<AutomationRunHistoryStatusKey, { label: string; color: string; bgColor: string; icon: typeof CheckCircle }> = {
  ```
- Add the new entry alongside the existing five:
  ```ts
    cancelled: { label: 'status.cancelled', color: 'text-muted-foreground', bgColor: 'bg-muted', icon: Ban },
  ```
  (import `Ban` from `lucide-react`).
- Add `'cancelled'` to `DeviceRunResult['status']`.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/web && npx vitest run src/components/automations/AutomationRunHistory && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/automations/
git commit -m "fix(web): automation run status map gains cancelled

StatusKey omitted 'cancelled' and was indexed unguarded at line 352, so
it would crash the moment automation_run_status gains that value. #3525"
```

---

### Task 1.4: i18n keys for the widened maps

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/scripts.json`

- [ ] **Step 1: Run the parity gate and watch it fail**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts`
Expected: currently PASS. It will FAIL after step 2 for every locale except the one you edit first — that failure is the point; it proves the gate is live before you rely on it.

- [ ] **Step 2: Add the keys to `en` first**

In `apps/web/src/locales/en/scripts.json`, extend `executionHistory.status`, `executionDetails.status` and `executionDetails.statusDescription`. New keys, all three blocks:

```json
"queued": "Queued",
"cancelling": "Stopping…",
"cancelled": "Cancelled"
```

and in `executionDetails.statusDescription`, one entry per execution status (the chain being replaced had no total mapping):

```json
"statusDescription": {
  "pending": "Script is waiting to be executed",
  "queued": "Script is queued for delivery to the device",
  "running": "Script is running on the device",
  "cancelling": "Stop requested — waiting for the device to confirm.",
  "completed": "Script finished successfully",
  "failed": "Script finished with an error",
  "timeout": "Script exceeded its time limit",
  "cancelled": "Script was stopped on the device"
}
```

Also add the cancel-state labels used by `resolveExecutionStatusLabel` to `executionHistory.status` and `executionDetails.status`:

```json
"completedCancelTooLate": "Completed — your stop request arrived too late",
"failedCancelTooLate": "Failed — your stop request arrived too late",
"timeoutCancelTooLate": "Timed out — your stop request arrived too late",
"cancelFailed": "Stop failed — the device could not stop the process"
```

And to `automationRunHistory.status`: `"cancelled": "Cancelled"`.

- [ ] **Step 3: Translate into the other seven locales**

Add the same key paths to `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`. **Real translations, not English copies** — `translationCoverage.test.ts` flags English-identical values against a documented allowlist and will fail otherwise. Consult `apps/web/src/locales/TERMINOLOGY.md` for the established rendering of "script", "device" and "run" in each locale.

- [ ] **Step 4: Run every i18n gate**

Run: `cd apps/web && npx vitest run src/lib/i18n/`
Expected: PASS for `localeParity`, `translationCoverage`, `terminologyQuality` and `extractionQuality`.

- [ ] **Step 5: Commit and open the W01 PR**

```bash
git add apps/web/src/locales/
git commit -m "i18n(web): status keys for queued, cancelling and cancelled

Covers all 8 locales for the widened execution and automation-run status
maps. #3525"
git push -u origin HEAD
gh pr create --title "fix(web): status maps cover every execution and run status (#3525 W01)" \
  --body "Fixes two live unguarded-index crashes and prepares the unions for cancellation. Closes nothing on its own.

Wave 1 of 6 for #3525."
```

---

# Wave 02 — Cancellation state machine and real `script_cancel` delivery

This is the wave that stops the UI lying. Depends on nothing; ship after W01 only for a cleaner UI story.

### Task 2.1: Migrations — enum values, then columns

**Files:**
- Create: `apps/api/migrations/2026-10-07-100000-cancellation-enums.sql`
- Create: `apps/api/migrations/2026-10-07-100100-cancellation-columns.sql`
- Modify: `apps/api/src/db/schema/scripts.ts:10,130-162`
- Test: `apps/api/src/db/autoMigrate.test.ts` (already asserts ordering; no edit expected — run it)

**Interfaces:**
- Produces: `script_executions.{cancel_requested_at, cancelled_by, cancel_state, cancel_command_id, cancel_prev_status}`, pgEnum `script_cancel_state`, `execution_status.cancelling`. Drizzle exports `scriptCancelStateEnum` and the widened `executionStatusEnum`.

Two files because Postgres forbids *using* a new enum literal in the same transaction that adds it, and `autoMigrate` wraps each file in one transaction (`db/autoMigrate.ts:690-696`). File 1 adds values only; file 2 writes the `cancelling` literal into a partial index predicate.

- [ ] **Step 1: Write the failing schema test**

Add to `apps/api/src/db/schema/scripts.test.ts` (create the file if absent):

```ts
import { describe, it, expect } from 'vitest';
import { scriptExecutions, executionStatusEnum, scriptCancelStateEnum } from './scripts';

describe('script_executions cancellation columns', () => {
  it('execution_status carries the transient cancelling value', () => {
    expect(executionStatusEnum.enumValues).toContain('cancelling');
  });

  it('script_cancel_state has exactly the four lifecycle values', () => {
    expect([...scriptCancelStateEnum.enumValues].sort())
      .toEqual(['confirmed', 'failed', 'requested', 'unconfirmed']);
  });

  it('exposes all five cancellation columns', () => {
    const cols = Object.keys(scriptExecutions);
    for (const c of ['cancelRequestedAt', 'cancelledBy', 'cancelState', 'cancelCommandId', 'cancelPrevStatus']) {
      expect(cols, `missing ${c}`).toContain(c);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/db/schema/scripts.test.ts`
Expected: FAIL — `scriptCancelStateEnum` is not exported.

- [ ] **Step 3: Write migration file 1 (enum values only)**

Create `apps/api/migrations/2026-10-07-100000-cancellation-enums.sql`:

```sql
-- #3525 W02 — cancellation enum values.
--
-- Split from the column migration because Postgres forbids USING a new enum
-- literal in the transaction that ADDs it, and autoMigrate wraps each file in
-- one transaction. The literals are used in 2026-10-07-100100's index predicate.
--
-- 'cancelling' is TRANSIENT. Only a proven stop terminalises as 'cancelled';
-- an unconfirmed or failed cancel reverts status to cancel_prev_status and
-- records the failure in cancel_state (plan OD8-C state table).

ALTER TYPE execution_status ADD VALUE IF NOT EXISTS 'cancelling';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'script_cancel_state') THEN
    CREATE TYPE script_cancel_state AS ENUM ('requested', 'confirmed', 'unconfirmed', 'failed');
  END IF;
END $$;
```

- [ ] **Step 4: Write migration file 2 (columns)**

Create `apps/api/migrations/2026-10-07-100100-cancellation-columns.sql`:

```sql
-- #3525 W02 — cancellation columns on script_executions.
--
-- cancelled_by is deliberately NOT a bare REFERENCES users(id): the AI-agent
-- actor id is an ai_agents id, not a user id. The service probes-and-degrades
-- exactly as services/scriptDispatch.ts:374-391 already does for triggered_by,
-- so an FK is safe only for ids that survived the probe. ON DELETE SET NULL
-- keeps org erasure from tripping on it.
--
-- All five columns classify as `included` in CORE_TENANT_EXPORT_POLICY: four
-- timestamps/uuids/enums and no json, jsonb or bytea among them.

ALTER TABLE script_executions
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_state script_cancel_state,
  ADD COLUMN IF NOT EXISTS cancel_command_id uuid,
  ADD COLUMN IF NOT EXISTS cancel_prev_status execution_status;

-- The lifecycle either started or it did not; a state with no request time (or
-- vice versa) is unreadable. Legacy 'cancelled' rows written by the old
-- bookkeeping-only route have both NULL = "legacy, unknown", which is correct
-- and deliberately not backfilled (spec: Out of scope).
ALTER TABLE script_executions DROP CONSTRAINT IF EXISTS script_executions_cancel_state_chk;
ALTER TABLE script_executions
  ADD CONSTRAINT script_executions_cancel_state_chk
  CHECK ((cancel_state IS NULL) = (cancel_requested_at IS NULL));

-- The cancellation sweep scans only in-flight cancels. Partial index keeps it
-- off the hot path of a table that grows with every script run.
CREATE INDEX IF NOT EXISTS script_executions_cancelling_idx
  ON script_executions (cancel_requested_at)
  WHERE status = 'cancelling';

-- Closers look the execution up from the cancel command's id.
CREATE INDEX IF NOT EXISTS script_executions_cancel_command_idx
  ON script_executions (cancel_command_id)
  WHERE cancel_command_id IS NOT NULL;
```

- [ ] **Step 5: Mirror the columns in Drizzle**

In `apps/api/src/db/schema/scripts.ts`, line 10 becomes:

```ts
export const executionStatusEnum = pgEnum('execution_status', ['pending', 'queued', 'running', 'cancelling', 'completed', 'failed', 'timeout', 'cancelled']);
export const scriptCancelStateEnum = pgEnum('script_cancel_state', ['requested', 'confirmed', 'unconfirmed', 'failed']);
```

and add to the `scriptExecutions` table body, after `customFieldResult`:

```ts
  // #3525 cancellation lifecycle, orthogonal to `status` (spec OD8-C).
  // `status` says what happened to the PROCESS; these say what happened to the
  // CANCEL REQUEST. NULL cancel_state = no cancel was ever requested.
  cancelRequestedAt: timestamp('cancel_requested_at'),
  cancelledBy: uuid('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
  cancelState: scriptCancelStateEnum('cancel_state'),
  cancelCommandId: uuid('cancel_command_id'),
  // The status held when the cancel was requested. An unconfirmed or failed
  // cancel reverts to it, so the row never claims an outcome we cannot prove
  // and reapStaleScriptExecutions keeps ownership of the deadline.
  cancelPrevStatus: executionStatusEnum('cancel_prev_status'),
```

and extend the index block:

```ts
  cancellingIdx: index('script_executions_cancelling_idx')
    .on(table.cancelRequestedAt)
    .where(sql`status = 'cancelling'`),
  cancelCommandIdx: index('script_executions_cancel_command_idx')
    .on(table.cancelCommandId)
    .where(sql`cancel_command_id IS NOT NULL`),
```

- [ ] **Step 6: Run the schema test, the migration-order test and the naming guard**

```bash
cd apps/api && npx vitest run src/db/schema/scripts.test.ts src/db/autoMigrate.test.ts
cd ../.. && ./scripts/check-migration-naming.sh --against-ref origin/main
```
Expected: PASS on all three. If the naming guard fails because `origin/main` gained a later-sorting migration, rename both files to sort after it and re-run.

- [ ] **Step 7: Apply and verify idempotency against a real database**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:migrate && pnpm db:check-drift
```
Expected: the second `db:migrate` is a no-op and `db:check-drift` reports no drift.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-10-07-1000*.sql apps/api/src/db/schema/scripts.ts apps/api/src/db/schema/scripts.test.ts
git commit -m "feat(db): script_executions cancellation lifecycle columns

Adds execution_status.cancelling, the script_cancel_state enum and five
columns. cancel_state is orthogonal to status: status describes the
process, cancel_state describes the cancel request. #3525"
```

---

### Task 2.2: Export-policy classification (the contract that fires on a new COLUMN)

**Files:**
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:333`

> This is the step that has reddened main five times. `script_executions` is already registered, so no cascade-list edit is needed — but every column of every org-cascade table must be classified, so `ADD COLUMN` alone breaks `tenant-export-policy.integration.test.ts`. Treat it as a mechanical edit, not a judgement call.

- [ ] **Step 1: Run the contract test and watch it fail**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`
Expected: FAIL — five unclassified columns on `script_executions`. Needs a live Postgres with Task 2.1's migrations applied.

- [ ] **Step 2: Classify all five**

Replace line 333 of `apps/api/src/services/tenantExportPolicyRegistry.ts` with:

```ts
  "script_executions": tablePolicy("org_id", {"included":["id","script_id","device_id","org_id","triggered_by","trigger_type","automation_run_id","status","started_at","completed_at","exit_code","stdout","stderr","error_message","created_at","cancel_requested_at","cancelled_by","cancel_state","cancel_command_id","cancel_prev_status"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["parameters","custom_field_result"]}),
```

All five go in `included`: two timestamps, two uuids that are tenant identifiers, one status enum. None is `json`, `jsonb` or `bytea`, so none is forced into `excludedOpen`. `cancelled_by` matches no entry in `SUSPICIOUS_NAME_PARTS`, so it does not need `reviewedIncluded`.

- [ ] **Step 3: Run both export-policy suites and watch them pass**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```
Expected: PASS. The roundtrip suite is the one that catches a classification that type-checks but does not round-trip.

- [ ] **Step 4: Run the two cascade/RLS contracts for good measure**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS with no change — `script_executions` is Shape 1 and already registered, and no table was created.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "chore(api): classify the five new script_executions columns

CORE_TENANT_EXPORT_POLICY fires on a new COLUMN, not only a new table. #3525"
```

---

### Task 2.3: Register `script_cancel` in all four command lists

**Files:**
- Modify: `apps/api/src/services/commandQueue.ts:138-147,392-479`
- Modify: `apps/api/src/services/commandTimeouts.ts:107-120`
- Modify: `apps/api/src/routes/agents/commands.ts:87-96`
- Modify: `apps/api/src/services/commandResultHandlers.ts:656-681`
- Test: `apps/api/src/services/scriptCancellation.registration.test.ts` (create)

**Interfaces:**
- Produces: `CommandTypes.SCRIPT_CANCEL = 'script_cancel'`, consumed by every later task in W02/W03/W05.

Four separate lists, each easy to miss, each with a different failure mode: no `CommandTypes` key means no type safety; missing from `AUDITED_COMMANDS` means `queueCommand` writes no dispatch audit; missing from `REGISTRY_DISPATCHED_COMMAND_TYPES` means **HTTP-polling agents never receive the result path**; missing from the result registry means the ack is dropped.

- [ ] **Step 1: Write the failing registration test**

Create `apps/api/src/services/scriptCancellation.registration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandTypes } from './commandQueue';
import { getCommandTimeoutMs } from './commandTimeouts';
import { LIFECYCLE_COMMAND_TYPES } from './partnerTrust';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

describe('script_cancel is registered in every list that matters', () => {
  it('has a CommandTypes key', () => {
    expect(CommandTypes.SCRIPT_CANCEL).toBe('script_cancel');
  });

  it('is in AUDITED_COMMANDS so queueCommand writes a dispatch audit', () => {
    const src = read('./commandQueue.ts');
    const audited = src.slice(src.indexOf('const AUDITED_COMMANDS'), src.indexOf('INTERACTIVE_COMMAND_TYPES'));
    expect(audited).toContain('SCRIPT_CANCEL');
  });

  it('is in REGISTRY_DISPATCHED_COMMAND_TYPES so HTTP-polling agents get the result path', () => {
    const src = read('../routes/agents/commands.ts');
    const set = src.slice(src.indexOf('REGISTRY_DISPATCHED_COMMAND_TYPES'), src.indexOf('PAM_COMMAND_TYPES'));
    expect(set).toContain("'script_cancel'");
  });

  it('has a result handler registered', async () => {
    const { commandResultHandlers } = await import('./commandResultHandlers');
    expect(commandResultHandlers['script_cancel']).toBeTypeOf('function');
  });

  it('gets the long timeout tier, NOT the 5-minute one', () => {
    // The generic reaper clocks `pending` rows from createdAt, so a 5-minute
    // tier would expire a cancel that was merely never delivered, while the
    // cancellation clock (which starts at DELIVERY) has not started.
    expect(getCommandTimeoutMs('script_cancel')).toBe(2 * 60 * 60 * 1000);
  });

  it('stays a lifecycle command so a probationed partner can still stop a script', () => {
    expect(LIFECYCLE_COMMAND_TYPES).toContain('script_cancel');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/scriptCancellation.registration.test.ts`
Expected: FAIL on the first five assertions; the sixth already passes (`partnerTrust.ts:42`).

- [ ] **Step 3: Add the `CommandTypes` key**

In `apps/api/src/services/commandQueue.ts`, after `SCRIPT: 'script',` (line 143):

```ts
  // Script execution
  SCRIPT: 'script',
  // #3525. Payload.executionId carries the ORIGINAL script command's id — the
  // agent keys e.running on cmd.ID (handlers_script.go:82), not on
  // script_executions.id. `scriptExecutionId` is the additive server-correlation
  // field and is ignored by deployed agents.
  SCRIPT_CANCEL: 'script_cancel',
```

- [ ] **Step 4: Add it to `AUDITED_COMMANDS`**

In the same file, inside the `AUDITED_COMMANDS` set (near `CommandTypes.SCRIPT`):

```ts
  CommandTypes.SCRIPT,
  CommandTypes.SCRIPT_CANCEL,
```

- [ ] **Step 5: Give it the long timeout tier**

In `apps/api/src/services/commandTimeouts.ts`, add to `LONG_TIMEOUT_TYPES`:

```ts
  // #3525: deliberately NOT SHORT_TIMEOUT_TYPES. The generic reaper clocks
  // `pending` rows from createdAt (staleCommandReaper.ts:299-307), so a
  // 5-minute tier expires a cancel that a merely-offline device never received.
  // Two hours strictly exceeds the longest possible script lifetime
  // (MaxTimeout 3600s + SCRIPT_GRACE_BUFFER_MS), so nothing outlives it.
  CommandTypes.SCRIPT_CANCEL,
```

- [ ] **Step 6: Add it to the REST dispatch allowlist**

In `apps/api/src/routes/agents/commands.ts`, inside `REGISTRY_DISPATCHED_COMMAND_TYPES`:

```ts
  'script',
  'script_cancel',
```

- [ ] **Step 7: Register a result handler stub**

In `apps/api/src/services/commandResultHandlers.ts`, add to the registry object:

```ts
  script: handleScriptResult,
  script_cancel: handleScriptCancelResult,
```

and add the handler above the registry. The full closer logic lands in W03 Task 3.1; this wave only needs it to exist and to be inert on an unmatched row:

```ts
/**
 * #3525 closer 2 of 5. The agent's script_cancel ack is the ONLY evidence that
 * lets an execution terminalise as `cancelled`. Full state transitions land in
 * W03; this wave only routes the ack so it is never silently dropped.
 */
async function handleScriptCancelResult({ command, result }: Parameters<CommandResultHandler>[0]): Promise<void> {
  const { applyScriptCancelAck } = await import('./scriptCancellation');
  await applyScriptCancelAck({
    cancelCommandId: command.id,
    result: result as Record<string, unknown> | null,
  });
}
```

- [ ] **Step 8: Run the registration test and watch it pass**

Run: `cd apps/api && npx vitest run src/services/scriptCancellation.registration.test.ts`
Expected: PASS (6 tests). It will still fail on the dynamic import until Task 2.4 creates `scriptCancellation.ts` — run it again at the end of Task 2.4.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/commandQueue.ts apps/api/src/services/commandTimeouts.ts \
  apps/api/src/routes/agents/commands.ts apps/api/src/services/commandResultHandlers.ts \
  apps/api/src/services/scriptCancellation.registration.test.ts
git commit -m "feat(api): register script_cancel in all four command lists

CommandTypes, AUDITED_COMMANDS, REGISTRY_DISPATCHED_COMMAND_TYPES and the
result registry, plus the long timeout tier. #3525"
```

---

### Task 2.4: `services/scriptCancellation.ts` — the one implementation

**Files:**
- Create: `apps/api/src/services/scriptCancellation.ts`
- Create: `apps/api/src/services/scriptCancellation.test.ts`

**Interfaces:**
- Consumes: `CommandTypes.SCRIPT_CANCEL` (2.3), the five columns (2.1), `insertQueuedCommandInTransaction` (`commandQueue.ts:248`), `assertDeviceExecuteAllowed` (`commandQueue.ts`), `sendCommandToAgent` (`routes/agentWs.ts`), `applyAutomationActionTerminal` (`automationActionResults.ts:426`), `terminalPayloadErasureSet`.
- Produces:
  ```ts
  export type CancelOutcome =
    | { kind: 'already_terminal' }                                    // -> 409
    | { kind: 'idempotent'; status: ExecutionStatus }                 // -> 200
    | { kind: 'retracted' }                                           // proven; status cancelled/confirmed
    | { kind: 'recovered' }                                           // command already terminal; completion recovered
    | { kind: 'cancelling'; cancelCommandId: string; deviceId: string } // caller must deliver post-commit
    | { kind: 'inconsistent' };                                       // fail closed -> 500

  export async function cancelScriptExecution(input: {
    executionId: string;
    actorId: string | null;
    actorLabel: string;
    graceSeconds?: number;
  }): Promise<CancelOutcome>;

  export async function cancelExecutionsForRun(input: {
    runId: string;
    actorId: string | null;
    actorLabel: string;
    graceSeconds?: number;
  }): Promise<{ requested: number; retracted: number; alreadyTerminal: number }>;

  export async function applyScriptCancelAck(input: {
    cancelCommandId: string;
    result: Record<string, unknown> | null;
  }): Promise<void>;

  export const CANCEL_GRACE_MS: number;   // env-tunable, default 90_000
  export const MAX_GRACE_SECONDS = 30;
  export const DEFAULT_GRACE_SECONDS = 5;
  ```

- [ ] **Step 1: Write the failing wire-contract test — the single most important assertion in this plan**

Create `apps/api/src/services/scriptCancellation.test.ts` starting with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertInTx = vi.fn();
vi.mock('./commandQueue', () => ({
  CommandTypes: { SCRIPT: 'script', SCRIPT_CANCEL: 'script_cancel' },
  insertQueuedCommandInTransaction: insertInTx,
  assertDeviceExecuteAllowed: vi.fn().mockResolvedValue(undefined),
  resolveCommandCreatedBy: vi.fn(async (_d: string, u?: string | null) => u ?? null),
}));

describe('script_cancel wire contract (#3525 blocker)', () => {
  beforeEach(() => { insertInTx.mockReset(); insertInTx.mockResolvedValue({ id: 'cancel-cmd-id' }); });

  it('payload.executionId carries the ORIGINAL device_commands.id, not script_executions.id', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    // fixture: execution 'exec-uuid' paired with a SENT script command 'cmd-uuid'
    await withFixture({ executionId: 'exec-uuid', commandId: 'cmd-uuid', commandStatus: 'sent', executionStatus: 'running' }, () =>
      cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech@msp.example' }),
    );

    expect(insertInTx).toHaveBeenCalledTimes(1);
    const { type, payload } = insertInTx.mock.calls[0][1];
    expect(type).toBe('script_cancel');
    // The agent keys e.running on cmd.ID. Sending script_executions.id here
    // makes the whole feature a silent no-op on every agent in the fleet.
    expect(payload.executionId).toBe('cmd-uuid');
    expect(payload.executionId).not.toBe('exec-uuid');
    expect(payload.scriptExecutionId).toBe('exec-uuid');
    expect(payload.graceSeconds).toBe(5);
  });

  it('clamps graceSeconds into 0..30', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    await withFixture({ executionId: 'e', commandId: 'c', commandStatus: 'sent', executionStatus: 'running' }, () =>
      cancelScriptExecution({ executionId: 'e', actorId: null, actorLabel: 'ai', graceSeconds: 999 }),
    );
    expect(insertInTx.mock.calls[0][1].payload.graceSeconds).toBe(30);
  });
});
```

> `withFixture` is the repo's standard Drizzle-mock harness — model it on `apps/api/src/services/aiToolsScripts.runScript.orgEquality.test.ts`, which already stubs `db.select`/`db.update`/`db.transaction` chains for this table pair. Follow the `breeze-testing` skill for the mock shape.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/scriptCancellation.test.ts`
Expected: FAIL — `Failed to resolve import "./scriptCancellation"`.

- [ ] **Step 3: Write the branch matrix test before the implementation**

Append to the same file. Every row of the OD8-C state table gets an assertion:

```ts
describe('cancel branch matrix', () => {
  it('command still pending -> retract it, execution cancelled/confirmed, no agent round-trip', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    const out = await withFixture({ commandStatus: 'pending', executionStatus: 'running' },
      () => cancelScriptExecution({ executionId: 'e', actorId: 'u', actorLabel: 'tech' }));
    expect(out).toEqual({ kind: 'retracted' });
    expect(insertInTx).not.toHaveBeenCalled();
    expect(lastExecutionUpdate()).toMatchObject({ status: 'cancelled', cancelState: 'confirmed' });
  });

  it('command already terminal -> recover the completion, do NOT queue a cancel', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    const out = await withFixture({ commandStatus: 'completed', executionStatus: 'running' },
      () => cancelScriptExecution({ executionId: 'e', actorId: 'u', actorLabel: 'tech' }));
    expect(out).toEqual({ kind: 'recovered' });
    expect(insertInTx).not.toHaveBeenCalled();
  });

  it('command sent -> cancelling, prev status recorded, completed_at stays NULL', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    const out = await withFixture({ commandStatus: 'sent', executionStatus: 'running' },
      () => cancelScriptExecution({ executionId: 'e', actorId: 'u', actorLabel: 'tech' }));
    expect(out.kind).toBe('cancelling');
    expect(lastExecutionUpdate()).toMatchObject({
      status: 'cancelling', cancelState: 'requested', cancelPrevStatus: 'running',
    });
    expect(lastExecutionUpdate().completedAt).toBeUndefined();
  });

  it('command row ABSENT -> fail closed, never a confirmed cancel', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    const out = await withFixture({ commandStatus: null, executionStatus: 'running' },
      () => cancelScriptExecution({ executionId: 'e', actorId: 'u', actorLabel: 'tech' }));
    // Absence is not proof that nothing ran; it is an inconsistency.
    expect(out).toEqual({ kind: 'inconsistent' });
  });

  it('execution already terminal -> already_terminal (409, changed from today 400)', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    const out = await withFixture({ commandStatus: 'completed', executionStatus: 'completed' },
      () => cancelScriptExecution({ executionId: 'e', actorId: 'u', actorLabel: 'tech' }));
    expect(out).toEqual({ kind: 'already_terminal' });
  });

  it('execution already cancelling -> idempotent 200, exactly one command row', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    const out = await withFixture({ commandStatus: 'sent', executionStatus: 'cancelling' },
      () => cancelScriptExecution({ executionId: 'e', actorId: 'u', actorLabel: 'tech' }));
    expect(out).toEqual({ kind: 'idempotent', status: 'cancelling' });
    expect(insertInTx).not.toHaveBeenCalled();
  });

  it('the paired-command lookup constrains type=script', async () => {
    // Today's route omits it, so an unrelated pending command whose payload
    // happens to carry the same executionId can be collided with.
    const { cancelScriptExecution } = await import('./scriptCancellation');
    await withFixture({ commandStatus: 'sent', executionStatus: 'running' },
      () => cancelScriptExecution({ executionId: 'e', actorId: 'u', actorLabel: 'tech' }));
    expect(lastCommandLookupSql()).toContain("type");
    expect(lastCommandLookupSql()).toContain("script");
  });

  it('an actor id that is not a users row degrades to NULL rather than raising 23503', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    await withFixture({ commandStatus: 'sent', executionStatus: 'running', actorIsUser: false },
      () => cancelScriptExecution({ executionId: 'e', actorId: 'ai-agent-uuid', actorLabel: 'ai_agent' }));
    expect(lastExecutionUpdate().cancelledBy).toBeNull();
  });
});

describe('applyScriptCancelAck maps every agent outcome (OD8-C state table)', () => {
  it.each([
    ['terminated', { status: 'cancelled', cancelState: 'confirmed' }],
    ['not_found',  { status: 'running',   cancelState: 'unconfirmed' }],
    ['kill_failed',{ status: 'running',   cancelState: 'failed' }],
  ] as const)('outcome %s', async (outcome, expected) => {
    const { applyScriptCancelAck } = await import('./scriptCancellation');
    await withFixture({ executionStatus: 'cancelling', cancelPrevStatus: 'running' }, () =>
      applyScriptCancelAck({ cancelCommandId: 'cancel-cmd-id', result: { outcome } }));
    expect(lastExecutionUpdate()).toMatchObject(expected);
  });

  it('an unknown-command reply from an old agent is unconfirmed, not confirmed', async () => {
    const { applyScriptCancelAck } = await import('./scriptCancellation');
    await withFixture({ executionStatus: 'cancelling', cancelPrevStatus: 'queued' }, () =>
      applyScriptCancelAck({ cancelCommandId: 'cancel-cmd-id', result: { status: 'failed', error: 'unknown command type' } }));
    expect(lastExecutionUpdate()).toMatchObject({ status: 'queued', cancelState: 'unconfirmed' });
  });
});
```

- [ ] **Step 4: Run and watch every branch fail**

Run: `cd apps/api && npx vitest run src/services/scriptCancellation.test.ts`
Expected: FAIL on all branches.

- [ ] **Step 5: Implement the service**

Create `apps/api/src/services/scriptCancellation.ts`. Structure (each numbered comment corresponds to a spec §2 requirement):

```ts
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { deviceCommands } from '../db/schema/devices';
import { scriptExecutions } from '../db/schema/scripts';
import { users } from '../db/schema/users';
import { withSystemDbAccessContext, runOutsideDbContext } from '../db';
import {
  CommandTypes, assertDeviceExecuteAllowed, insertQueuedCommandInTransaction,
} from './commandQueue';
import { applyAutomationActionTerminal } from './automationActionResults';
import { terminalPayloadErasureSet } from './commandPayloadErasure';
import { SERVER_TIMEOUT_RESULT_STATUS } from './commandResultAcceptance';

export const DEFAULT_GRACE_SECONDS = 5;
export const MAX_GRACE_SECONDS = 30;
/** Grace deadline measured from DELIVERY, not from the request. Env-tunable. */
export const CANCEL_GRACE_MS = Number(process.env.CANCEL_GRACE_MS ?? 90_000);

const CANCELLABLE = ['pending', 'queued', 'running'] as const;

function clampGrace(seconds?: number): number {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return DEFAULT_GRACE_SECONDS;
  return Math.min(MAX_GRACE_SECONDS, Math.max(0, Math.floor(seconds)));
}

/**
 * Probe-and-degrade, mirroring services/scriptDispatch.ts:374-391. The AI-agent
 * actor id is an `ai_agents` id, so a bare users FK would raise 23503. The true
 * actor always survives in the audit log regardless.
 */
async function resolveCancelledBy(actorId: string | null): Promise<string | null> {
  if (!actorId) return null;
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, actorId)).limit(1);
    return row ? actorId : null;
  }));
}

export async function cancelScriptExecution(input: {
  executionId: string; actorId: string | null; actorLabel: string; graceSeconds?: number;
}): Promise<CancelOutcome> {
  const grace = clampGrace(input.graceSeconds);
  const cancelledBy = await resolveCancelledBy(input.actorId);

  const outcome = await db.transaction(async (tx) => {
    // (1) Load the execution and its paired command FOR UPDATE. The type
    // predicate is the fix for today's collision with an unrelated pending
    // command whose payload happens to carry the same executionId.
    const [execution] = await tx.select().from(scriptExecutions)
      .where(eq(scriptExecutions.id, input.executionId)).limit(1).for('update');
    if (!execution) return { kind: 'already_terminal' as const };

    // (2) Idempotency BEFORE the CAS: a second concurrent cancel gets 200, not 409.
    if (execution.status === 'cancelling') {
      return { kind: 'idempotent' as const, status: execution.status };
    }
    if (!CANCELLABLE.includes(execution.status as typeof CANCELLABLE[number])) {
      return execution.cancelState
        ? { kind: 'idempotent' as const, status: execution.status }
        : { kind: 'already_terminal' as const };
    }

    const [command] = await tx.select().from(deviceCommands).where(and(
      eq(deviceCommands.deviceId, execution.deviceId),
      eq(deviceCommands.type, CommandTypes.SCRIPT),
      sql`${deviceCommands.payload}->>'executionId' = ${input.executionId}`,
    )).limit(1).for('update');

    // (3d) Absence is NOT proof that nothing ran. Fail closed.
    if (!command) return { kind: 'inconsistent' as const };

    const now = new Date();
    const cancelMeta = { cancelRequestedAt: now, cancelledBy, cancelPrevStatus: execution.status };

    // (3a) Nothing ever ran — retract atomically, the only server-side proof.
    if (command.status === 'pending') {
      await tx.update(deviceCommands).set({
        status: 'cancelled', completedAt: now,
        // Marker so a late ack can still reopen the row
        // (commandResultAcceptance.ts:55 only reopens `failed` + result.status='timeout').
        result: { status: SERVER_TIMEOUT_RESULT_STATUS, cancelled: true, cancelledBy: input.actorLabel },
        ...terminalPayloadErasureSet(),
      }).where(and(eq(deviceCommands.id, command.id), eq(deviceCommands.status, 'pending')));

      await tx.update(scriptExecutions).set({
        ...cancelMeta, status: 'cancelled', cancelState: 'confirmed',
        completedAt: now, errorMessage: `Cancelled by ${input.actorLabel} before the device received it`,
      }).where(and(eq(scriptExecutions.id, execution.id), inArray(scriptExecutions.status, [...CANCELLABLE])));
      return { kind: 'retracted' as const, executionId: execution.id, completedAt: now };
    }

    // (3b) Reachable: ingestion terminalises device_commands BEFORE calling
    // handleScriptResult (agentWs.ts:1802-1837). Recover, don't queue a doomed cancel.
    if (command.status === 'completed' || command.status === 'failed' || command.status === 'cancelled') {
      await tx.update(scriptExecutions).set({ ...cancelMeta, cancelState: 'unconfirmed' })
        .where(eq(scriptExecutions.id, execution.id));
      return { kind: 'recovered' as const, executionId: execution.id, commandId: command.id };
    }

    // (3c) The running case. Transient `cancelling`; completedAt stays NULL so
    // no batch counter and no automation action result closes yet.
    const cancelCommandId = randomUUID();
    await tx.update(scriptExecutions).set({
      ...cancelMeta, status: 'cancelling', cancelState: 'requested', cancelCommandId,
    }).where(and(eq(scriptExecutions.id, execution.id), inArray(scriptExecutions.status, [...CANCELLABLE])));

    // Dedup: never two live cancels for the same original command.
    const [existing] = await tx.select({ id: deviceCommands.id }).from(deviceCommands).where(and(
      eq(deviceCommands.deviceId, execution.deviceId),
      eq(deviceCommands.type, CommandTypes.SCRIPT_CANCEL),
      inArray(deviceCommands.status, ['pending', 'sent']),
      sql`${deviceCommands.payload}->>'executionId' = ${command.id}`,
    )).limit(1);
    if (existing) {
      return { kind: 'cancelling' as const, cancelCommandId: existing.id, deviceId: execution.deviceId, alreadyQueued: true };
    }

    await insertQueuedCommandInTransaction(tx, {
      id: cancelCommandId,
      deviceId: execution.deviceId,
      type: CommandTypes.SCRIPT_CANCEL,
      payload: {
        // THE WIRE CONTRACT. The agent keys e.running on cmd.ID.
        executionId: command.id,
        scriptExecutionId: execution.id,
        graceSeconds: grace,
      },
      createdBy: cancelledBy ?? '',
    });
    return { kind: 'cancelling' as const, cancelCommandId, deviceId: execution.deviceId, alreadyQueued: false };
  });

  // (4) applyAutomationActionTerminal runs ONLY on a terminal branch, and only
  // AFTER commit — it opens its own system context and takes its own FOR UPDATE.
  if (outcome.kind === 'retracted') {
    await applyAutomationActionTerminal({
      source: 'cancellation', scriptExecutionId: outcome.executionId,
      terminalStatus: 'cancelled', error: null, completedAt: outcome.completedAt,
    });
  }
  return outcome;
}
```

Then `deliverCancelCommand(cancelCommandId, deviceId)` — called by the route **after** the transaction commits (spec §2.5): `assertDeviceExecuteAllowed` is called before the transaction, and delivery uses the existing `sendCommandToAgent` path. Do **not** call it inside `db.transaction` — `queueCommand` joins the ambient transaction while the agent's ack lookup uses a fresh snapshot (`agentWs.ts:1647-1688`), so a fast ack can land before commit and be routed as orphaned (`agentWs.ts:1722-1728`).

Finally `applyScriptCancelAck` implements the OD8-C table:

```ts
export async function applyScriptCancelAck(input: {
  cancelCommandId: string; result: Record<string, unknown> | null;
}): Promise<void> {
  const outcome = String(input.result?.outcome ?? '');
  // An old agent answers "unknown command type" with no outcome field. That is
  // a definite non-answer about the process: unconfirmed, never confirmed.
  const next: { cancelState: 'confirmed' | 'unconfirmed' | 'failed'; confirmed: boolean } =
    outcome === 'terminated' ? { cancelState: 'confirmed', confirmed: true }
    : outcome === 'kill_failed' ? { cancelState: 'failed', confirmed: false }
    : { cancelState: 'unconfirmed', confirmed: false };

  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.transaction(async (tx) => {
      const [execution] = await tx.select().from(scriptExecutions)
        .where(and(eq(scriptExecutions.cancelCommandId, input.cancelCommandId),
                   eq(scriptExecutions.status, 'cancelling')))
        .limit(1).for('update');
      if (!execution) return;   // already closed by another closer; nothing to do

      if (next.confirmed) {
        const completedAt = new Date();
        await tx.update(scriptExecutions).set({
          status: 'cancelled', cancelState: 'confirmed', completedAt,
          errorMessage: 'Stopped on the device',
        }).where(and(eq(scriptExecutions.id, execution.id), eq(scriptExecutions.status, 'cancelling')));
        return;
      }
      // REVERT. A failed cancel request does not change what happened to the
      // process. Reverting also returns the row to reapStaleScriptExecutions'
      // pending|queued|running predicate, so nothing is stranded and that
      // reaper stays untouched (spec §8).
      await tx.update(scriptExecutions).set({
        status: execution.cancelPrevStatus ?? 'running',
        cancelState: next.cancelState,
      }).where(and(eq(scriptExecutions.id, execution.id), eq(scriptExecutions.status, 'cancelling')));
    });
  }));
}
```

`cancelExecutionsForRun` iterates `WHERE automation_run_id = :runId AND status IN ('pending','queued','running')` — **keyed on the run id only**, never on the caller's org — and calls `cancelScriptExecution` per row, tallying the outcome kinds. It uses the partial index `script_executions_automation_run_id_idx`.

- [ ] **Step 6: Run the whole file and watch it pass**

Run: `cd apps/api && npx vitest run src/services/scriptCancellation.test.ts src/services/scriptCancellation.registration.test.ts`
Expected: PASS on every test, including the registration test's dynamic import.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/scriptCancellation.ts apps/api/src/services/scriptCancellation.test.ts
git commit -m "feat(api): scriptCancellation service — the one cancel state machine

Queues a real script_cancel keyed on the ORIGINAL command id (the agent
keys e.running on cmd.ID, not script_executions.id), and never terminalises
as cancelled without proof. #3525"
```

---

### Task 2.5: Rewrite the route on top of the service

**Files:**
- Modify: `apps/api/src/routes/scripts.ts:1178-1285`
- Modify: `apps/api/src/routes/devices/events.ts:352,358`
- Modify: `apps/api/src/services/aiToolsScripts.ts` (add `cancel_script_execution` at tier 3, beside `run_script` at line 269)
- Test: `apps/api/src/routes/scripts.test.ts:1258-1400` (extend)

**Interfaces:**
- Consumes: `cancelScriptExecution`, `deliverCancelCommand`, `CancelOutcome` (2.4).

- [ ] **Step 1: Write the failing route tests**

Extend `apps/api/src/routes/scripts.test.ts` beside the existing cancel tests at 1258-1400:

```ts
describe('POST /scripts/executions/:id/cancel', () => {
  it('returns 409 (not 400) when the execution is already terminal', async () => {
    const res = await app.request('/scripts/executions/exec-completed/cancel', { method: 'POST', headers: authHeaders });
    expect(res.status).toBe(409);
  });

  it('returns 200 and does not queue a second command when already cancelling', async () => {
    const res = await app.request('/scripts/executions/exec-cancelling/cancel', { method: 'POST', headers: authHeaders });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, execution: { status: 'cancelling' } });
  });

  it('delivers the cancel command AFTER the transaction commits', async () => {
    await app.request('/scripts/executions/exec-running/cancel', { method: 'POST', headers: authHeaders });
    // A send inside the transaction lets a fast ack land before commit and be
    // routed as orphaned (agentWs.ts:1722-1728).
    expect(commitOrder()).toEqual(['commit', 'sendCommandToAgent']);
  });

  it('returns 500 and does not mark the row cancelled when the paired command is absent', async () => {
    const res = await app.request('/scripts/executions/exec-orphan/cancel', { method: 'POST', headers: authHeaders });
    expect(res.status).toBe(500);
    expect(lastExecutionUpdate()).toBeUndefined();
  });

  it('still enforces org access, site access and MFA', async () => {
    expect((await app.request('/scripts/executions/exec-other-org/cancel', { method: 'POST', headers: authHeaders })).status).toBe(403);
    expect((await app.request('/scripts/executions/exec-other-site/cancel', { method: 'POST', headers: authHeaders })).status).toBe(403);
    expect((await app.request('/scripts/executions/exec-running/cancel', { method: 'POST', headers: noMfaHeaders })).status).toBe(403);
  });

  it('accepts and clamps a graceSeconds body field', async () => {
    await app.request('/scripts/executions/exec-running/cancel', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ graceSeconds: 0 }),
    });
    expect(lastQueuedCancelPayload().graceSeconds).toBe(0);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/routes/scripts.test.ts`
Expected: FAIL — today the terminal case returns 400 and no command is ever queued.

- [ ] **Step 3: Rewrite the route body**

Replace `apps/api/src/routes/scripts.ts:1218-1284` (everything after the existing org/site checks, which stay verbatim) with a thin delegation. Add a body validator first:

```ts
const cancelExecutionBodySchema = z.object({
  graceSeconds: z.number().int().min(0).max(30).optional(),
}).optional();
```

and the handler tail:

```ts
    const body = await c.req.json().catch(() => ({}));
    const parsed = cancelExecutionBodySchema.safeParse(body);
    const graceSeconds = parsed.success ? parsed.data?.graceSeconds : undefined;

    const outcome = await cancelScriptExecution({
      executionId,
      actorId: auth.user.id,
      actorLabel: auth.user.email,
      graceSeconds,
    });

    if (outcome.kind === 'already_terminal') {
      // Deliberate contract change from today's 400 — documented in openapi.ts
      // and handled by the web `friendly` mapper.
      return c.json({ error: 'Execution is no longer cancellable' }, 409);
    }
    if (outcome.kind === 'inconsistent') {
      // Absence of the paired command is not proof that nothing ran. Fail closed
      // rather than stamping a confirmed cancel we cannot justify.
      captureException(new Error('Cancel requested for an execution with no paired script command'),
        undefined, { executionId, deviceId: execution.deviceId });
      return c.json({ error: 'Execution state is inconsistent; cancellation refused' }, 500);
    }

    // POST-COMMIT DELIVERY (spec §2.5).
    if (outcome.kind === 'cancelling' && !outcome.alreadyQueued) {
      await deliverCancelCommand(outcome.cancelCommandId, outcome.deviceId);
    }

    writeRouteAudit(c, {
      orgId: resolveScriptAuditOrgId(auth, null, execution.deviceOrgId ?? null),
      action: 'script.execution.cancel',
      resourceType: 'script_execution',
      resourceId: executionId,
      details: {
        scriptExecutionId: executionId,
        deviceId: execution.deviceId,
        previousStatus: execution.status,
        outcome: outcome.kind,
        ...(outcome.kind === 'cancelling' ? { commandId: outcome.cancelCommandId, graceSeconds } : {}),
      },
    });

    const [current] = await db.select({ id: scriptExecutions.id, status: scriptExecutions.status,
      cancelState: scriptExecutions.cancelState, completedAt: scriptExecutions.completedAt })
      .from(scriptExecutions).where(eq(scriptExecutions.id, executionId)).limit(1);
    return c.json({ success: true, execution: current });
```

- [ ] **Step 4: Add the two new audit labels**

In `apps/api/src/routes/devices/events.ts`, beside line 352:

```ts
  'script.execution.cancel': 'Script execution cancelled',
  'script.execution.cancel.unconfirmed': 'Script stop could not be confirmed',
```

and beside line 358 (the `agent.command.*` block, kept in command-sent tense):

```ts
  'agent.command.script_cancel': 'Stop script command sent',
```

- [ ] **Step 5: Add the AI tool**

In `apps/api/src/services/aiToolsScripts.ts`, register beside `run_script` (line 265) at the **same tier 3 gate**, delegating to the same service so the state machine has one implementation:

```ts
  registerTool({
    tier: 3,
    deviceArgs: [],
    definition: {
      name: 'cancel_script_execution',
      description: 'Stop a running script execution on a device. Cancellation is a de-escalation: it never starts work.',
      input_schema: {
        type: 'object' as const,
        properties: {
          executionId: { type: 'string', description: 'UUID of the script_executions row to stop' },
          graceSeconds: { type: 'number', description: 'Seconds to wait after SIGTERM before SIGKILL (0-30, default 5). No graceful phase on Windows.' },
        },
        required: ['executionId'],
      },
    },
    handler: async (input, auth) => {
      const { cancelScriptExecution, deliverCancelCommand } = await import('./scriptCancellation');
      const outcome = await cancelScriptExecution({
        executionId: input.executionId as string,
        actorId: auth.user.id,          // may be an ai_agents id; the service probes-and-degrades
        actorLabel: `ai_agent:${auth.user.id}`,
        graceSeconds: input.graceSeconds as number | undefined,
      });
      if (outcome.kind === 'cancelling' && !outcome.alreadyQueued) {
        await deliverCancelCommand(outcome.cancelCommandId, outcome.deviceId);
      }
      return JSON.stringify({ outcome: outcome.kind });
    },
  });
```

- [ ] **Step 6: Run the route, tool and registry-parity tests**

Run: `cd apps/api && npx vitest run src/routes/scripts.test.ts src/services/aiToolsScripts src/services/aiToolsRegistryParity.test.ts`
Expected: PASS. `aiToolsRegistryParity.test.ts` will fail if the new tool is not mirrored wherever the registry is duplicated — follow its error message.

- [ ] **Step 7: Typecheck, lint and open the W02 PR**

```bash
cd apps/api && npx tsc --noEmit && cd ../.. && pnpm lint
git add -A && git commit -m "feat(api): cancel actually stops the script

Rewrites POST /scripts/executions/:id/cancel on services/scriptCancellation,
queues a real script_cancel with post-commit delivery, adds the AI tool, and
changes the already-terminal response from 400 to 409. #3525"
git push -u origin HEAD
gh pr create --title "feat(api): cancel a running script for real (#3525 W02)" --body "Wave 2 of 6 for #3525. See docs/superpowers/plans/agent/2026-09-02-cancel-running-script-or-automation.md"
```

---

# Wave 03 — The five closers

`cancelling` must never be reachable-and-permanent. Depends on W02.

### Task 3.1: Closer 1 & 3 — original result and late-result recovery

**Files:**
- Modify: `apps/api/src/services/commandResultHandlers.ts:334,417-431,465-480,511-522`
- Test: `apps/api/src/services/commandResultHandlers.cancellation.test.ts` (create)

**Interfaces:**
- Consumes: `applyScriptCancelAck` (2.4).
- Produces: the cancellation CAS, ordered **before** both the primary CAS and the #3607 recovery branch.

Three defects to fix here, all verified in the current code:
1. The primary CAS (`:417-431`) matches `status IN ('pending','queued','running')` — a `cancelling` row matches neither it nor the #3607 branch, so the result falls through to the "drop the output" path at `:511-522`.
2. The #3607 recovery branch (`:465-480`) is discriminated on `status IN ('timeout','failed') AND exit_code IS NULL AND stdout IS NULL`. A **reverted** execution (`cancel_state = 'unconfirmed'`, `status` back to `running`) hits the primary CAS normally — good — but a *confirmed-cancelled* row must accept a late result's output **without** overwriting the status.
3. `applyScriptCustomFieldWrites` runs at `:334` **before** any execution-status guard. A late result for a confirmed-cancelled execution would still write custom fields. That is arguably correct (the script really did run and really did produce those values), so keep it — but assert it deliberately rather than inheriting it by accident.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/commandResultHandlers.cancellation.test.ts`:

```ts
describe('script result closes a cancelling execution (#3525 closer 1)', () => {
  it('a result carrying the cancellation marker confirms the cancel', async () => {
    await handleResult({ executionStatus: 'cancelling', cancelCommandId: 'cc-1',
      result: { status: 'failed', exitCode: -1, cancelled: true, cancelledByCommandId: 'cc-1' } });
    expect(lastExecutionUpdate()).toMatchObject({ status: 'cancelled', cancelState: 'confirmed' });
  });

  it('a marker naming a DIFFERENT cancel command does not confirm', async () => {
    // A stale or retried cancel must not be credited with a kill it did not do.
    await handleResult({ executionStatus: 'cancelling', cancelCommandId: 'cc-2',
      result: { status: 'failed', exitCode: -1, cancelled: true, cancelledByCommandId: 'cc-1' } });
    expect(lastExecutionUpdate()).toMatchObject({ cancelState: 'unconfirmed' });
    expect(lastExecutionUpdate().status).not.toBe('cancelled');
  });

  it('an UNMARKED result preserves the real outcome (OD9-C) and records the losing cancel', async () => {
    await handleResult({ executionStatus: 'cancelling', cancelCommandId: 'cc-1',
      result: { status: 'completed', exitCode: 0, stdout: 'done' } });
    expect(lastExecutionUpdate()).toMatchObject({ status: 'completed', cancelState: 'unconfirmed', exitCode: 0 });
  });

  it('the cancellation CAS is ordered BEFORE the #3607 recovery branch', async () => {
    await handleResult({ executionStatus: 'cancelling', cancelCommandId: 'cc-1',
      result: { status: 'completed', exitCode: 0 } });
    expect(casOrder()[0]).toBe('cancellation');
  });
});

describe('late original result after a terminal cancel (#3525 closer 3)', () => {
  it('fills stdout/stderr/exit_code but does NOT change status', async () => {
    await handleResult({ executionStatus: 'cancelled', cancelState: 'confirmed',
      result: { status: 'completed', exitCode: 0, stdout: 'partial output' } });
    const patch = lastExecutionUpdate();
    expect(patch).toMatchObject({ stdout: 'partial output', exitCode: 0 });
    expect(patch.status).toBeUndefined();
    expect(patch.cancelState).toBeUndefined();
  });

  it('is NOT gated on cancel_state — a confirmed cancel still recovers output', async () => {
    await handleResult({ executionStatus: 'cancelled', cancelState: 'confirmed', result: { stdout: 'x' } });
    expect(lastExecutionUpdate().stdout).toBe('x');
    // and no captureException: the old code alerted on every non-cancelled miss
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it('does not re-run batch accounting or applyAutomationActionTerminal', async () => {
    await handleResult({ executionStatus: 'cancelled', cancelState: 'confirmed', result: { stdout: 'x' } });
    expect(applyAutomationActionTerminalSpy).not.toHaveBeenCalled();
  });

  it('still applies script custom-field writes (the script really did run)', async () => {
    await handleResult({ executionStatus: 'cancelled', cancelState: 'confirmed',
      result: { stdout: 'x', customFields: { 'asset.tag': 'A1' } } });
    expect(applyScriptCustomFieldWritesSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/api && npx vitest run src/services/commandResultHandlers.cancellation.test.ts`
Expected: FAIL — no cancellation branch exists.

- [ ] **Step 3: Add the cancellation CAS ahead of both existing branches**

In `handleScriptResult`, immediately before the primary CAS at line 417:

```ts
      // #3525 closer 1. MUST run before the primary CAS and the #3607 branch:
      // the primary maps straight to the real outcome and the #3607 branch only
      // handles swept timeout|failed rows with no output, so a `cancelling` row
      // would fall through to the "drop the output" path below.
      const cancelledMarker = result?.cancelled === true;
      const markerCommandId = typeof result?.cancelledByCommandId === 'string' ? result.cancelledByCommandId : null;
      const cancelClosed = await db.update(scriptExecutions).set(
        (() => {
          const base = { ...executionValues };
          return cancelledMarker
            // The agent proved it: it killed this process on OUR cancel command.
            ? { ...base, status: 'cancelled' as const, cancelState: 'confirmed' as const }
            // OD9-C: preserve the real outcome, record the losing cancel request.
            : { ...base, cancelState: 'unconfirmed' as const };
        })(),
      ).where(and(
        eq(scriptExecutions.id, executionId),
        eq(scriptExecutions.deviceId, resolvedDeviceId),
        eq(scriptExecutions.status, 'cancelling'),
        // A stale or retried cancel must not be credited with a kill it did not do.
        ...(cancelledMarker && markerCommandId ? [eq(scriptExecutions.cancelCommandId, markerCommandId)] : []),
      )).returning({ id: scriptExecutions.id, scriptId: scriptExecutions.scriptId });
      if (cancelClosed.length > 0) { effectiveExecution = cancelClosed[0]; }
```

Guard the primary CAS and the #3607 branch with `if (cancelClosed.length === 0)`.

- [ ] **Step 4: Replace the "drop the output" path with output recovery**

Replace the block at `:511-522` — the comment there ("Dropping the output is the CORRECT outcome") is the design bug written down. A cancelled execution's partial output is exactly what the operator needs:

```ts
        // #3525 closer 3. A late original result after ANY cancellation
        // terminalisation fills the output fields and NOTHING else: no status
        // change, no cancel_state change, no batch accounting, no automation
        // action closure — those already consumed the terminal outcome.
        // Deliberately NOT gated on cancel_state: a confirmed cancel still has
        // partial output worth keeping.
        if (currentStatus === 'cancelled') {
          await db.update(scriptExecutions).set({
            stdout: executionValues.stdout, stderr: executionValues.stderr, exitCode: executionValues.exitCode,
          }).where(and(
            eq(scriptExecutions.id, executionId),
            eq(scriptExecutions.status, 'cancelled'),
            isNull(scriptExecutions.exitCode),
          ));
          console.warn('[AgentWs] #3525 recovered late output onto a cancelled execution',
            { executionId, commandId: command.id });
          return;   // no captureException: this is expected, not a defect
        }
```

- [ ] **Step 5: Run and watch them pass**

Run: `cd apps/api && npx vitest run src/services/commandResultHandlers`
Expected: PASS, including the pre-existing `commandResultHandlers` specs — check the file count, the substring pulls in siblings.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/commandResultHandlers.ts apps/api/src/services/commandResultHandlers.cancellation.test.ts
git commit -m "fix(api): script results close cancelling executions and recover late output

Cancellation gets its own CAS ordered before the primary and #3607 branches,
and a late result for a cancelled execution now fills stdout/stderr/exit_code
instead of being deliberately dropped. #3525"
```

---

### Task 3.2: Closers 4 & 5 — cancel-command expiry and the cancellation sweep

**Files:**
- Modify: `apps/api/src/jobs/staleCommandReaper.ts:1088-1096` (job table), plus a new `reapStaleCancellations` beside `reapStaleScriptExecutions:368`
- Test: `apps/api/src/jobs/staleCommandReaper.cancellation.test.ts` (create)

**Interfaces:**
- Consumes: `CANCEL_GRACE_MS`, `applyScriptCancelAck` (2.4).
- Produces: `reapStaleCancellations(): Promise<number>`, registered as an eighth domain.

**`reapStaleScriptExecutions` must NOT be widened.** Its predicate (`status IN ('pending','queued','running')`) and its terminal CAS are correct as they stand, and `cancelling` rows are deliberately invisible to it — the revert model hands ownership back to it the moment a cancel fails.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/jobs/staleCommandReaper.cancellation.test.ts`:

```ts
describe('reapStaleCancellations (#3525 closer 5)', () => {
  it('gives up on a cancelling execution past CANCEL_GRACE_MS FROM DELIVERY', async () => {
    // grace is measured from device_commands.executed_at, not from
    // cancel_requested_at: the clock starts when the device receives the cancel.
    seed({ status: 'cancelling', cancelPrevStatus: 'running', cancelCommandExecutedAt: minutesAgo(5) });
    expect(await reapStaleCancellations()).toBe(1);
    expect(lastExecutionUpdate()).toMatchObject({ status: 'running', cancelState: 'unconfirmed' });
  });

  it('does NOT give up while the cancel command is still merely pending', async () => {
    // Undelivered means the grace clock has not started. The command's own
    // 2-hour expiry owns that case (closer 4).
    seed({ status: 'cancelling', cancelCommandStatus: 'pending', cancelCommandCreatedAt: minutesAgo(30) });
    expect(await reapStaleCancellations()).toBe(0);
  });

  it('closes the cancel command with a marker the acceptance path will reopen', async () => {
    seed({ status: 'cancelling', cancelPrevStatus: 'running', cancelCommandExecutedAt: minutesAgo(5) });
    await reapStaleCancellations();
    // commandResultAcceptance.ts:55 only reopens `failed` rows whose
    // result->>'status' = 'timeout'. Any other marker loses a late ack forever.
    expect(lastCommandUpdate()).toMatchObject({ status: 'failed', result: { status: 'timeout' } });
  });

  it('writes the script.execution.cancel.unconfirmed audit event', async () => {
    seed({ status: 'cancelling', cancelPrevStatus: 'running', cancelCommandExecutedAt: minutesAgo(5) });
    await reapStaleCancellations();
    expect(lastAudit()).toMatchObject({ action: 'script.execution.cancel.unconfirmed' });
  });

  it('leaves reapStaleScriptExecutions unchanged — a cancelling row is invisible to it', async () => {
    seed({ status: 'cancelling', createdAt: hoursAgo(3) });
    expect(await reapStaleScriptExecutions()).toBe(0);
  });

  it('is registered as a reaper domain', () => {
    expect(reaperDomainNames()).toContain('scriptCancellations');
  });
});

describe('cancel-command expiry (#3525 closer 4)', () => {
  it('an expired script_cancel reverts the execution to unconfirmed, never strands it', async () => {
    seed({ status: 'cancelling', cancelPrevStatus: 'queued', cancelCommandStatus: 'failed',
           cancelCommandResult: { status: 'timeout' } });
    await reapStaleCancellations();
    expect(lastExecutionUpdate()).toMatchObject({ status: 'queued', cancelState: 'unconfirmed' });
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/api && npx vitest run src/jobs/staleCommandReaper.cancellation.test.ts`
Expected: FAIL — `reapStaleCancellations` is not exported.

- [ ] **Step 3: Implement the sweep**

Add to `apps/api/src/jobs/staleCommandReaper.ts`, beside `reapStaleScriptExecutions`:

```ts
/**
 * #3525 closers 4 and 5. Owns the `cancelling` state exclusively —
 * reapStaleScriptExecutions deliberately does not see it.
 *
 * The grace clock starts at DELIVERY (device_commands.executed_at), not at the
 * request: losing the WS connection does not kill the agent or its script, so a
 * cancel queued against an offline device is still deliverable on reconnect and
 * must not be given up on early.
 */
export async function reapStaleCancellations(): Promise<number> {
  const rows = await db
    .select({
      executionId: scriptExecutions.id,
      deviceId: scriptExecutions.deviceId,
      orgId: scriptExecutions.orgId,
      prevStatus: scriptExecutions.cancelPrevStatus,
      cancelCommandId: scriptExecutions.cancelCommandId,
      cmdStatus: deviceCommands.status,
      cmdExecutedAt: deviceCommands.executedAt,
      cmdResult: deviceCommands.result,
    })
    .from(scriptExecutions)
    .leftJoin(deviceCommands, eq(deviceCommands.id, scriptExecutions.cancelCommandId))
    .where(eq(scriptExecutions.status, 'cancelling'))
    .limit(MAX_REAP_PER_RUN);

  let reaped = 0;
  for (const row of rows) {
    const cmdTerminal = row.cmdStatus === 'failed' || row.cmdStatus === 'completed' || row.cmdStatus === 'cancelled';
    const deliveredLongAgo = row.cmdExecutedAt !== null
      && Date.now() - row.cmdExecutedAt.getTime() >= CANCEL_GRACE_MS;
    // An undelivered `pending` cancel has not started its clock. Its own
    // 2-hour tier will expire it, and that arrives here as cmdTerminal.
    if (!cmdTerminal && !deliveredLongAgo) continue;

    const updated = await db.update(scriptExecutions).set({
      status: row.prevStatus ?? 'running',
      cancelState: 'unconfirmed',
    }).where(and(
      eq(scriptExecutions.id, row.executionId),
      eq(scriptExecutions.status, 'cancelling'),
    )).returning({ id: scriptExecutions.id });
    if (updated.length === 0) continue;
    reaped++;

    if (row.cancelCommandId && !cmdTerminal) {
      // Close the cancel command with the ONLY marker commandResultAcceptance
      // reopens (`failed` + result.status='timeout'), so a late ack still lands.
      await db.update(deviceCommands).set({
        status: 'failed', completedAt: new Date(),
        result: { status: SERVER_TIMEOUT_RESULT_STATUS, error: 'Cancellation not acknowledged within the grace window', timedOutBy: 'server' },
        ...terminalPayloadErasureSet(),
      }).where(and(eq(deviceCommands.id, row.cancelCommandId), inArray(deviceCommands.status, ['pending', 'sent'])));
    }

    // OD3-A: row field + audit event + metric. Deliberately no device alert and
    // no captureException — this is an operational condition, not a code defect.
    await writeSystemAudit({
      orgId: row.orgId,
      action: 'script.execution.cancel.unconfirmed',
      resourceType: 'script_execution',
      resourceId: row.executionId,
      details: { deviceId: row.deviceId, cancelCommandId: row.cancelCommandId, revertedTo: row.prevStatus },
    });
    recordCancelUnconfirmed();
  }
  return reaped;
}
```

Register it as an eighth domain at line 1088:

```ts
        ['scriptExecutions', reapStaleScriptExecutions],
        ['scriptCancellations', reapStaleCancellations],
```

- [ ] **Step 4: Run and watch them pass**

Run: `cd apps/api && npx vitest run src/jobs/staleCommandReaper`
Expected: PASS, including the pre-existing reaper specs.

- [ ] **Step 5: Commit and open the W03 PR**

```bash
git add apps/api/src/jobs/staleCommandReaper.ts apps/api/src/jobs/staleCommandReaper.cancellation.test.ts
git commit -m "feat(api): cancellation sweep and cancel-command expiry closers

A cancelling execution can never be permanent: past the grace window
(measured from DELIVERY) it reverts to its pre-cancel status with
cancel_state 'unconfirmed' and an audit event. #3525"
git push && gh pr create --title "feat(api): close every cancelling execution (#3525 W03)" --body "Wave 3 of 6 for #3525."
```

---

# Wave 04 — Go agent: honest, blocking, process-tree cancellation

Independent of W02/W03 — the agent change is backward-compatible in both directions. **This is agent-shipped code: canary a small band before fleet promote.**

Four correctness blockers come before any kill mechanics. All four are verified in the current agent:

1. **Cancellation can starve.** Every command goes through one `workerpool` (`heartbeat.go:5777`), `MaxConcurrentCommands` clamps to a floor of 1 (`config/validate.go:198-206`), and submit failure returns `"command rejected, worker pool full"`. A cancel queues behind the very script it must stop.
2. **Cancel-before-registration.** `Execute` does validation, file write, `setProcessGroup` and `configureRunAs` before inserting into `e.running` at `executor.go:224`, and WebSocket commands are concurrent. A cancel returns "not found" and the script then starts anyway.
3. **The ack is premature.** `Executor.Cancel` (`executor.go:281-299`) calls `running.cancel()` and immediately returns nil. The async `cmd.Cancel` failure surfaces to the original `cmd.Run`, not to the cancel caller. A `cancelled: true` ack proves neither termination nor a successful kill attempt.
4. **`notFound` is not global.** `handleScriptCancel` (`handlers_script.go:276-316`) has no structured not-found — the only signal is the error string from `Executor.Cancel`, and it fans out to every `run_as_user` helper at 15 s each, serially, on one pool goroutine. And `userhelper.NewWithOptions` builds a fresh `executor.New(nil)` on **every** reconnect (`client.go:110`, `supervisor.go:216`), so a script from the previous Client is structurally unreachable.

### Task 4.1: Structured cancel outcome and a blocking `Cancel`

**Files:**
- Modify: `agent/internal/executor/executor.go:50-77,95-240,281-299`
- Create: `agent/internal/executor/cancel_test.go`

**Interfaces:**
- Produces:
  ```go
  type CancelOutcome string
  const (
      CancelTerminated CancelOutcome = "terminated"
      CancelNotFound   CancelOutcome = "not_found"
      CancelKillFailed CancelOutcome = "kill_failed"
  )
  func (e *Executor) Cancel(executionID string, graceSeconds int) (CancelOutcome, error)
  ```
  `ScriptResult` gains `Cancelled bool \`json:"cancelled,omitempty"\`` and `CancelledByCommandID string \`json:"cancelledByCommandId,omitempty"\``.

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/executor/cancel_test.go`:

```go
func TestCancelBlocksUntilTheProcessIsGone(t *testing.T) {
	e := New(testConfig(t))
	done := make(chan *ScriptResult, 1)
	go func() { r, _ := e.Execute(sleepScript("id-1", 60)); done <- r }()
	waitForRunning(t, e, "id-1")

	start := time.Now()
	outcome, err := e.Cancel("id-1", 0)
	if err != nil { t.Fatalf("Cancel: %v", err) }
	if outcome != CancelTerminated { t.Fatalf("outcome = %q, want terminated", outcome) }
	// Cancel must not return before the kill is observed: the server's
	// `confirmed` flag is built on this ack.
	if len(done) == 0 {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("Cancel returned terminated while the process was still running")
		}
	}
	_ = start
}

func TestCancelReportsNotFoundForAnUnknownID(t *testing.T) {
	e := New(testConfig(t))
	outcome, err := e.Cancel("nope", 5)
	if err != nil { t.Fatalf("Cancel: %v", err) }
	if outcome != CancelNotFound { t.Fatalf("outcome = %q, want not_found", outcome) }
}

func TestCancelledResultCarriesTheCancellationMarker(t *testing.T) {
	e := New(testConfig(t))
	done := make(chan *ScriptResult, 1)
	go func() { r, _ := e.Execute(sleepScript("id-2", 60)); done <- r }()
	waitForRunning(t, e, "id-2")
	e.SetCancelCommandID("id-2", "cancel-cmd-7")
	if _, err := e.Cancel("id-2", 0); err != nil { t.Fatal(err) }
	res := <-done
	// Without this the server cannot tell "we killed it" from "it finished on
	// its own", and OD9-C forces it to preserve the natural outcome.
	if !res.Cancelled { t.Fatal("result.Cancelled = false, want true") }
	if res.CancelledByCommandID != "cancel-cmd-7" {
		t.Fatalf("CancelledByCommandID = %q, want cancel-cmd-7", res.CancelledByCommandID)
	}
}

func TestGracefulEscalationSendsSIGTERMBeforeSIGKILL(t *testing.T) {
	if runtime.GOOS == "windows" { t.Skip("no graceful phase on Windows: GenerateConsoleCtrlEvent needs a shared console and children are CREATE_NO_WINDOW") }
	e := New(testConfig(t))
	// script traps SIGTERM, writes a marker file, then exits
	go func() { _, _ = e.Execute(sigtermTrapScript(t, "id-3", 60)) }()
	waitForRunning(t, e, "id-3")
	if _, err := e.Cancel("id-3", 5); err != nil { t.Fatal(err) }
	assertMarkerWritten(t)   // proves SIGTERM was delivered, not just SIGKILL
}

func TestZeroGraceSkipsStraightToKill(t *testing.T) { /* graceSeconds: 0 -> no SIGTERM wait */ }

func TestCancelBeforeRegistrationPreventsTheScriptFromStarting(t *testing.T) {
	// Execute validates, writes the script file and calls configureRunAs BEFORE
	// inserting into e.running (executor.go:98-224). A cancel in that window
	// must not return not_found and let the script start anyway.
	e := New(testConfig(t))
	e.reserve("id-4")                    // pre-start placeholder, inserted first
	outcome, _ := e.Cancel("id-4", 0)
	if outcome == CancelNotFound { t.Fatal("cancel raced Execute's setup and reported not_found") }
	res, _ := e.Execute(sleepScript("id-4", 60))
	if !res.Cancelled { t.Fatal("script started despite a cancel that arrived first") }
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd agent && go test -race ./internal/executor/ -run 'TestCancel|TestGraceful|TestZeroGrace'`
Expected: FAIL — `Cancel` takes one argument and returns only `error`.

- [ ] **Step 3: Implement**

In `agent/internal/executor/executor.go`:

```go
// runningExecution tracks a running script execution.
type runningExecution struct {
	cmd        *exec.Cmd
	cancel     context.CancelFunc
	startedAt  time.Time
	scriptType string

	// #3525. Captured once at Start: after SIGTERM the leader may already be
	// gone, so a kill-time syscall.Getpgid fails and the fallback kills a dead
	// leader while surviving children keep running.
	pgid int
	// Windows containment handle; nil on Unix. If containment could NOT be
	// established (an enclosing RDS session job forbids breakaway —
	// sessionbroker/spawner_windows.go:274-287), `contained` stays false and a
	// cancel can never report `terminated`.
	job       windowsJob
	contained bool

	graceSeconds   int
	cancelCommandID string
	cancelRequested bool
	// Closed by the Execute goroutine once cmd.Run has returned, so Cancel can
	// block on real termination instead of acking the moment it asks.
	done chan struct{}
	// Set by cmd.Cancel so Cancel can distinguish a failed kill from a
	// successful one. The async cmd.Cancel error otherwise surfaces only to
	// cmd.Run, never to the cancel caller.
	killErr error
}
```

`Execute` gains a **pre-start reservation** as its very first action, before any validation:

```go
func (e *Executor) Execute(script ScriptExecution) (*ScriptResult, error) {
	// Reserve the id BEFORE validation, file write and configureRunAs. A cancel
	// racing that setup previously returned not_found and the script started
	// anyway (WebSocket commands are concurrent: websocket/client.go:497-510).
	running, alreadyCancelled := e.reserve(script.ID)
	defer e.release(script.ID)
	if alreadyCancelled {
		return &ScriptResult{ExecutionID: script.ID, ExitCode: -1, Cancelled: true,
			CancelledByCommandID: running.cancelCommandID,
			Error: "cancelled before execution started"}, nil
	}
	...
```

`cmd.Cancel` performs the escalation **inside the callback** — `os/exec` synchronises it against `Start`/`Wait`, which is why `executor.go:288` refuses to touch `cmd.Process` from `Cancel`:

```go
	cmd.Cancel = func() error {
		err := terminateProcessTree(running, running.graceSeconds)
		running.killErr = err
		return err
	}
	// WaitDelay stays 5s. CORRECTION from the first spec draft: WaitDelay starts
	// AFTER the callback returns, and the callback already consumed the grace —
	// so do NOT set it to grace+5s. It is an independent post-callback backstop
	// that closes the pipes; it is NOT proof of termination.
	cmd.WaitDelay = 5 * time.Second
```

and `Cancel` blocks:

```go
func (e *Executor) Cancel(executionID string, graceSeconds int) (CancelOutcome, error) {
	e.mu.Lock()
	running, exists := e.running[executionID]
	if exists {
		running.graceSeconds = clampGrace(graceSeconds)
		running.cancelRequested = true
	}
	e.mu.Unlock()
	if !exists {
		return CancelNotFound, nil
	}
	running.cancel()

	// Block on real termination. The ack is what the server's `confirmed` flag
	// is built on, so returning before the process is gone is a lie.
	select {
	case <-running.done:
	case <-time.After(time.Duration(running.graceSeconds)*time.Second + hardKillBackstop):
		return CancelKillFailed, nil
	}
	if running.killErr != nil || !running.contained {
		// Containment was never established (RDS breakaway denial) or the kill
		// itself failed: children may survive. Never report `terminated`.
		return CancelKillFailed, nil
	}
	return CancelTerminated, nil
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `cd agent && go test -race ./internal/executor/`
Expected: PASS on Linux and macOS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/executor/executor.go agent/internal/executor/cancel_test.go
git commit -m "fix(agent): Cancel blocks and reports a real outcome

Cancel returned nil the instant it asked, so a 'cancelled: true' ack proved
neither termination nor a successful kill attempt. It now blocks on the
execution's done channel and returns terminated/not_found/kill_failed, and
the script result carries a cancellation marker. #3525"
```

---

### Task 4.2: Unix PGID capture and SIGTERM → SIGKILL escalation

**Files:**
- Modify: `agent/internal/executor/limits_unix.go`, `agent/internal/executor/limits_linux.go`
- Test: `agent/internal/executor/tree_kill_test.go` (create)

- [ ] **Step 1: Write the failing process-tree test**

Create `agent/internal/executor/tree_kill_test.go`:

```go
//go:build !windows

func TestCancelKillsTheWholeProcessTree(t *testing.T) {
	// script -> child -> grandchild, grandchild writes a heartbeat file every 100ms
	dir := t.TempDir()
	beat := filepath.Join(dir, "beat")
	e := New(testConfig(t))
	go func() { _, _ = e.Execute(grandchildHeartbeatScript("id-t", beat)) }()
	waitForFile(t, beat)

	if _, err := e.Cancel("id-t", 0); err != nil { t.Fatal(err) }

	before := statMtime(t, beat)
	time.Sleep(500 * time.Millisecond)
	if statMtime(t, beat) != before {
		t.Fatal("grandchild survived the cancel: process-group kill did not reach it")
	}
}

func TestPgidIsCapturedAtStartNotAtKillTime(t *testing.T) {
	// After SIGTERM the leader may already be gone; a kill-time Getpgid then
	// fails and the fallback kills a dead leader while children keep running.
	e := New(testConfig(t))
	go func() { _, _ = e.Execute(sleepScript("id-p", 60)) }()
	r := waitForRunning(t, e, "id-p")
	if r.pgid == 0 { t.Fatal("pgid was not captured at Start") }
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd agent && go test -race ./internal/executor/ -run 'TestCancelKillsTheWhole|TestPgidIsCaptured'`
Expected: FAIL — `runningExecution` has no `pgid`, and the current `killProcessGroup` goes straight to SIGKILL.

- [ ] **Step 3: Implement the ladder**

Replace `killProcessGroup` in both `limits_unix.go` and `limits_linux.go` with a graceful variant that takes the captured pgid. Keep `setProcessGroup` (`Setpgid: true, Pgid: 0`, plus `Pdeathsig: syscall.SIGKILL` on Linux) unchanged, and add `capturePgid(cmd) int` called from `Execute` right after `cmd.Start`:

```go
// terminateProcessTreeUnix escalates SIGTERM -> grace -> SIGKILL against the
// process GROUP, using the pgid captured at Start. Looking the pgid up at kill
// time (the old behaviour) fails once the leader is gone, and the fallback then
// kills a corpse while the surviving children keep running.
func terminateProcessTreeUnix(pgid int, cmd *exec.Cmd, graceSeconds int) error {
	if pgid <= 0 {
		if cmd.Process == nil { return nil }
		return cmd.Process.Kill()
	}
	if graceSeconds > 0 {
		_ = syscall.Kill(-pgid, syscall.SIGTERM)
		deadline := time.After(time.Duration(graceSeconds) * time.Second)
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-deadline:
				return syscall.Kill(-pgid, syscall.SIGKILL)
			case <-tick.C:
				// ESRCH == the whole group is gone; nothing left to escalate to.
				if err := syscall.Kill(-pgid, 0); err == syscall.ESRCH { return nil }
			}
		}
	}
	return syscall.Kill(-pgid, syscall.SIGKILL)
}
```

> `configureRunAs` rewrites `cmd.Path`/`cmd.Args` to `/usr/bin/sudo` (`executor.go:368`), so the signal lands on sudo's group — `sudo -n` children inherit the pgid set by `setProcessGroup`, so the group kill still reaches them. Assert that in the `runAs` variant of the tree test.

- [ ] **Step 4: Run and watch it pass**

Run: `cd agent && go test -race ./internal/executor/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/executor/limits_unix.go agent/internal/executor/limits_linux.go agent/internal/executor/tree_kill_test.go
git commit -m "fix(agent): capture the pgid at Start and escalate SIGTERM before SIGKILL

A kill-time Getpgid fails once the leader is gone, and the fallback then kills
a dead leader while children survive. #3525"
```

---

### Task 4.3: Windows Job Object containment (OD4-B), fail-closed

**Files:**
- Create: `agent/internal/executor/job_windows.go`
- Create: `agent/internal/executor/job_contract_test.go` (no build tag — runs on Linux CI too)
- Modify: `agent/internal/executor/limits_windows.go`

`limits_windows.go:12-21` today: `setProcessGroup` is an explicit no-op ("Job Objects … deferred to a future enhancement") and `killProcessGroup` calls `cmd.Process.Kill()`. A PowerShell script that starts `msiexec` or `robocopy` leaves that child alive — **already true on the timeout path**, so this fixes both.

OD4 was resolved to **B**: `CREATE_SUSPENDED` → `AssignProcessToJobObject` → `ResumeThread`, because assignment after `Start()` cannot support a truthful `confirmed` (the window covers timeout, cancellation, leader exit and child creation, and on RDS assignment can be denied outright). In-repo precedent: `agent/internal/pamlifetime/job_windows.go:111-165` and `agent/internal/pamactuator/tokenlaunch_windows.go:159` (`LaunchSuspendedV2`).

- [ ] **Step 1: Write the failing contract test**

Create `agent/internal/executor/job_contract_test.go`, modelled exactly on `agent/internal/pamlifetime/job_contract_test.go` (fake primitives appending Win32 API names to a shared order slice, asserted with `reflect.DeepEqual`). **No build tag**, so it runs in the Linux `test-agent` job as well:

```go
func TestScriptIsOwnedByANonEscapableJobBeforeResume(t *testing.T) {
	var order []string
	fake := &fakeJobPrimitives{order: &order}
	running, err := launchContained(fake, launchSpec{Path: "powershell.exe"})
	if err != nil { t.Fatal(err) }
	want := []string{
		"CreateProcess(CREATE_SUSPENDED|CREATE_NO_WINDOW)",
		"CreateJobObjectW",
		"SetInformationJobObject(KILL_ON_JOB_CLOSE)",
		"AssignProcessToJobObject",
		"ResumeThread",
	}
	if !reflect.DeepEqual(order, want) { t.Fatalf("order = %v, want %v", order, want) }
	if !running.contained { t.Fatal("contained = false after a successful assignment") }
	if fake.limitFlags != jobObjectLimitKillOnJobClose {
		t.Fatalf("limitFlags = %#x, want KILL_ON_JOB_CLOSE", fake.limitFlags)
	}
}

func TestAssignmentDenialFailsClosed(t *testing.T) {
	// On an RD Session Host the enclosing session job forbids joining a second
	// job and AssignProcessToJobObject is DENIED
	// (sessionbroker/spawner_windows.go:274-287). Following that precedent we
	// still run the script — refusing would break RDS entirely — but we mark it
	// uncontained so a later cancel can NEVER report `terminated`.
	var order []string
	fake := &fakeJobPrimitives{order: &order, assignErr: windows.ERROR_ACCESS_DENIED}
	running, err := launchContained(fake, launchSpec{Path: "powershell.exe"})
	if err != nil { t.Fatalf("launch must degrade, not fail: %v", err) }
	if running.contained { t.Fatal("contained = true after a denied assignment") }
}

func TestTerminateJobObjectIsUsedForTheHardKill(t *testing.T) {
	var order []string
	fake := &fakeJobPrimitives{order: &order}
	running, _ := launchContained(fake, launchSpec{Path: "powershell.exe"})
	if err := terminateProcessTreeWindows(running, 30); err != nil { t.Fatal(err) }
	// No graceful phase on Windows: GenerateConsoleCtrlEvent needs a shared
	// console and our children are CREATE_NO_WINDOW. graceSeconds is ignored.
	if last(order) != "TerminateJobObject" { t.Fatalf("order = %v", order) }
	if contains(order, "GenerateConsoleCtrlEvent") { t.Fatal("attempted a graceful phase on Windows") }
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd agent && go test -race ./internal/executor/ -run 'TestScriptIsOwned|TestAssignmentDenial|TestTerminateJobObject'`
Expected: FAIL — `launchContained` does not exist.

- [ ] **Step 3: Implement**

Create `agent/internal/executor/job_windows.go` with a `windowsJobPrimitives` interface (`CreateProcessSuspended`, `CreateJob`, `SetJobLimits`, `AssignProcess`, `Resume`, `TerminateJob`) plus a `nativeWindowsJobPrimitives` implementation copying the bodies from `pamlifetime/job_windows.go:125-165`. `CreationFlags` must **OR** `CREATE_SUSPENDED` into the existing flags — `hideWindow` (`limits_windows.go:28-37`) already sets `CREATE_NO_WINDOW`, and overwriting it would pop a console window on every script.

Replace `limits_windows.go`'s two no-ops so `setProcessGroup`/`killProcessGroup` delegate to the job path, and add a portable no-op `windowsJob`/`launchContained` in a `//go:build !windows` file so the contract test compiles everywhere.

- [ ] **Step 4: Run and watch them pass**

```bash
cd agent && go test -race ./internal/executor/
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./internal/executor/
```
Expected: PASS and a clean vet.

- [ ] **Step 5: Add `internal/executor` to the Windows CI package lists**

`.github/workflows/ci.yml:1327` and `:1390` use explicit package lists, and **`./internal/executor` is in neither** — `limits_windows_test.go` has never executed in CI. The comment at `:1293` states the rule ("When adding a package with //go:build windows tests, add it here"). `./internal/heartbeat` is on the known-red exclusion list (#2523) and must NOT be added, which is why the Job Object contract test lives in `internal/executor` and carries no build tag.

```yaml
        run: go test ./internal/sessionbroker ./internal/eventlog ./internal/ipc ./internal/logging ./internal/state ./internal/watchdog ./internal/backup/vss ./internal/executor ./cmd/breeze-watchdog
```
and the race step at `:1390`:
```yaml
        run: go test -race ./internal/sessionbroker ./internal/eventlog ./internal/ipc ./internal/state ./internal/watchdog ./internal/executor ./cmd/breeze-watchdog
```

- [ ] **Step 6: Commit**

```bash
git add agent/internal/executor/ .github/workflows/ci.yml
git commit -m "feat(agent): Windows Job Object containment for script execution

killProcessGroup killed only the shell leader, so a PowerShell script that
started msiexec left it running - already true on the timeout path. Adds
CREATE_SUSPENDED -> assign -> resume with KILL_ON_JOB_CLOSE, fails closed on
RDS assignment denial, and puts internal/executor in the Windows CI lists. #3525"
```

---

### Task 4.4: Handler, helper fan-out and the bypass lane

**Files:**
- Modify: `agent/internal/heartbeat/handlers_script.go:276-316,469-479`
- Modify: `agent/internal/heartbeat/heartbeat.go:5744-5790`
- Modify: `agent/internal/userhelper/client.go:701-748`
- Test: `agent/internal/heartbeat/handlers_script_test.go:316` (extend)

- [ ] **Step 1: Write the failing tests**

```go
func TestScriptCancelBypassesTheWorkerPool(t *testing.T) {
	// MaxConcurrentCommands clamps to a floor of 1 (config/validate.go:198-206),
	// so a cancel otherwise queues behind the very script it must stop.
	h := newTestHeartbeat(t, withMaxConcurrentCommands(1))
	go h.HandleCommand(longScriptCommand("cmd-1", 60))
	waitForRunning(t, h, "cmd-1")
	res := mustCompleteWithin(t, 2*time.Second, func() tools.CommandResult {
		return h.HandleCommand(scriptCancelCommand("cmd-1"))
	})
	if res.Status != "completed" { t.Fatalf("cancel starved behind the script: %+v", res) }
}

func TestScriptCancelResultCarriesAStructuredOutcome(t *testing.T) {
	for _, tc := range []struct{ name string; setup func(*Heartbeat); want string }{
		{"terminated", seedRunning, "terminated"},
		{"not_found", func(*Heartbeat) {}, "not_found"},
		{"kill_failed", seedUnkillable, "kill_failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newTestHeartbeat(t); tc.setup(h)
			res := h.dispatchOrFail(scriptCancelCommand("x"))
			// Today an unknown id returns tools.NewErrorResult, which the server
			// cannot distinguish from a failed kill.
			if res.Status != "completed" { t.Fatalf("want a success result carrying the outcome, got %+v", res) }
			if outcomeOf(res) != tc.want { t.Fatalf("outcome = %q, want %q", outcomeOf(res), tc.want) }
		})
	}
}

func TestNotFoundMeansNoHelperAndNoLocalExecutorHasIt(t *testing.T) {
	h := newTestHeartbeat(t, withHelperSession("s1", helperOwning("cmd-9")))
	res := h.dispatchOrFail(scriptCancelCommand("cmd-9"))
	if outcomeOf(res) == "not_found" { t.Fatal("reported not_found while a helper still owned the process") }
}

func TestHelperIPCTimeoutExceedsTheMaximumGrace(t *testing.T) {
	// Max grace is 30s; the helper IPC wait is currently 10s+5s = 15s, so a
	// 30s grace would time out the IPC before the helper finished escalating.
	if got := helperCommandTimeout(scriptCancelHelperTimeoutSeconds); got <= 30*time.Second {
		t.Fatalf("helper cancel IPC timeout %v must exceed the 30s max grace", got)
	}
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd agent && go test -race ./internal/heartbeat/ -run 'TestScriptCancel|TestNotFound|TestHelperIPC'`
Expected: FAIL on all four.

- [ ] **Step 3: Implement**

- **Bypass lane** — in `heartbeat.go`, route `LIFECYCLE_COMMAND_TYPES`-shaped commands (at minimum `script_cancel`, `script_list_running`) around `executeCommandViaPool` straight to `runTrackedCommand` in their own goroutine. They never spawn long work, so they cannot exhaust the host.
- **Structured outcome** — rewrite `handleScriptCancel` to read `graceSeconds` from the payload (clamped 0–30), call `h.executor.Cancel(executionID, grace)`, and return a **success** result carrying `{executionId, outcome, cancelled}` for all three outcomes. Only a genuinely malformed payload keeps `tools.NewErrorResult`.
- **Helper fan-out** — only fan out on a local `CancelNotFound`; decode each helper response's `outcome` rather than returning on the first `completed`; report `not_found` **only** when every helper also said `not_found`. Raise the helper IPC timeout constant from `10` so `helperCommandTimeout` exceeds 30 s (e.g. `scriptCancelHelperTimeoutSeconds = 40` → 45 s).
- **Helper side** — mirror the structured outcome in `client.go:712`.

> **Known residual, document it in the PR body:** `userhelper.NewWithOptions` builds a fresh `executor.New(nil)` on every reconnect (`client.go:110`, `supervisor.go:216`), so a `runAs=user` script that survived an IPC reconnect is unreachable and will correctly report `not_found` → the server records `unconfirmed`. Degraded but honest. Fixing helper executor persistence across reconnects is out of scope for #3525; file it separately.

- [ ] **Step 4: Run, vet for Windows, and commit**

```bash
cd agent && go test -race ./internal/heartbeat/ ./internal/userhelper/ ./internal/executor/
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./...
git add agent/internal/ && git commit -m "fix(agent): script_cancel bypasses the pool and reports a real outcome

A cancel could queue behind the very script it must stop, and an unknown id
was indistinguishable from a failed kill. #3525"
git push && gh pr create --title "fix(agent): honest, process-tree script cancellation (#3525 W04)" \
  --body "Wave 4 of 6 for #3525. AGENT-SHIPPED: canary a small band before fleet promote. The Windows containment change also alters the TIMEOUT path — watch for customer scripts that legitimately spawn detached children and now die with the parent."
```

---

# Wave 05 — Automation run cancellation

Depends on W02. Automations have no cancel at all today: `automation_run_status` is `running|completed|failed|partial`, `automation_device_result_status` has no `cancelled`, and the run endpoints at `routes/automations.ts:685-853` are GET-only.

### Task 5.1: Enum values, `devices_cancelled`, and cancellation-aware reconciliation

**Files:**
- Create: `apps/api/migrations/2026-10-07-100200-automation-run-cancellation.sql`
- Modify: `apps/api/src/db/schema/automations.ts:11,17,106-123`
- Modify: `apps/api/src/services/automationActionResults.ts:133-159,267-345`
- Modify: `apps/api/src/routes/automations.ts:400-403`
- Test: `apps/api/src/services/automationActionResults.cancellation.test.ts` (create)

**Interfaces:**
- Produces: `automation_run_status.cancelled`, `automation_device_result_status.cancelled`, `automation_runs.devices_cancelled`, and a third `Publication` type `'automation.cancelled'`.

> `automation_runs` has **no `org_id`**, is absent from `CORE_ORG_CASCADE_DELETE_ORDER` and has no `CORE_TENANT_EXPORT_POLICY` entry — correctly. `devices_cancelled integer` keeps it that way. **Do not add an org column here.** `automation_run_device_results` *is* in the export registry with an exhaustive column list, but this task adds only an enum value to it, not a column, so that registry is untouched. Confirm with `grep -n 'automation_run_device_results' apps/api/src/services/tenantExportPolicyRegistry.ts` before and after.

- [ ] **Step 1: Write the failing reconciliation tests**

Create `apps/api/src/services/automationActionResults.cancellation.test.ts`:

```ts
describe('cancellation-aware aggregation (#3525 OD6-A)', () => {
  it('a cancelled action maps the device to cancelled, not failed', () => {
    // automationActionResults.ts:139 currently lumps cancelled in with
    // failed/timed_out, which poisons automation health reporting and any
    // alerting keyed on devicesFailed.
    expect(aggregateActionStatuses(['cancelled', 'succeeded'])).toEqual({ status: 'cancelled' });
  });

  it('a mix of failed and cancelled still reports failed — a real failure outranks a stop', () => {
    expect(aggregateActionStatuses(['cancelled', 'failed'])).toEqual({ status: 'failed' });
  });

  it('a run whose devices all cancelled is cancelled, and counts in devicesCancelled', () => {
    expect(aggregateDeviceStatuses(['cancelled', 'cancelled']))
      .toEqual({ status: 'cancelled', devicesSucceeded: 0, devicesFailed: 0, devicesCancelled: 2 });
  });

  it('counters still sum to devicesTargeted', () => {
    const a = aggregateDeviceStatuses(['success', 'failed', 'cancelled']);
    expect(a.devicesSucceeded + a.devicesFailed + a.devicesCancelled).toBe(3);
  });

  it('reconcile does not DOWNGRADE a device-level cancelled to failed', async () => {
    // :266-323 rewrites device rows unconditionally before checking whether the
    // run is terminal, so a late reconcile could clobber the cancellation.
    seed({ deviceStatus: 'cancelled', actions: ['cancelled'] });
    await reconcileAutomationRun('run-1');
    expect(lastDeviceUpdate().status).toBe('cancelled');
  });

  it('publishes automation.cancelled', async () => {
    seed({ actions: ['cancelled'] });
    const pubs = await reconcileAutomationRun('run-1');
    expect(pubs[0]).toMatchObject({ type: 'automation.cancelled' });
  });

  it('toRunStatus passes cancelled through unchanged', () => {
    expect(toRunStatus('cancelled')).toBe('cancelled');
    expect(toRunStatus('completed')).toBe('success');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/api && npx vitest run src/services/automationActionResults`
Expected: FAIL — `cancelled` currently aggregates to `failed`.

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-10-07-100200-automation-run-cancellation.sql`:

```sql
-- #3525 W05 — automation run cancellation.
-- Enum values only in this file (see 2026-10-07-100000 for why literals and
-- ADD VALUE cannot share a transaction); devices_cancelled needs no literal.
ALTER TYPE automation_run_status ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TYPE automation_device_result_status ADD VALUE IF NOT EXISTS 'cancelled';

-- OD6-A: cancelled is neither a success nor a failure. Counting it as failed
-- would poison automation health reporting and any alerting keyed on
-- devices_failed; counting it as skipped would overload a value that means
-- "filtered out of the target set" and break the sum to devices_targeted.
--
-- automation_runs has NO org_id and is deliberately absent from
-- CORE_ORG_CASCADE_DELETE_ORDER and CORE_TENANT_EXPORT_POLICY. An integer
-- counter keeps it that way; do not add an org column here.
ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS devices_cancelled integer NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Implement the aggregation and publication changes**

- `automations.ts` schema: add `'cancelled'` to both pgEnums and `devicesCancelled: integer('devices_cancelled').notNull().default(0)` to `automationRuns`.
- `aggregateActionStatuses` (`:133`): insert a cancelled lane **after** the failed check, so a real failure outranks a stop.
- `aggregateDeviceStatuses` (`:146`): return `devicesCancelled`, and add `if (devicesFailed === 0 && devicesCancelled > 0) return { status: 'cancelled', ... }` before the completed branch.
- `reconcileInCurrentContext` (`:267-286`): the device-row rewrite must not downgrade — add `status = 'cancelled'` to the set of statuses it will not overwrite with a lesser one.
- `Publication` (`:212`): add `'automation.cancelled'`, emitted when `aggregate.status === 'cancelled'`.
- `applyAutomationActionTerminal`'s `terminalStatus` union already accepts `'cancelled'` and `terminal_source` already has `'cancellation'` — no enum change there.
- `routes/automations.ts:400` `toRunStatus`: `cancelled` passes through (only `completed → success` is renamed).

- [ ] **Step 5: Run, migrate twice, commit**

```bash
cd apps/api && npx vitest run src/services/automationActionResults src/routes/automations.test.ts
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:migrate && pnpm db:migrate && pnpm db:check-drift
grep -n 'automation_run_device_results' src/services/tenantExportPolicyRegistry.ts   # column list must be unchanged
git add -A && git commit -m "feat(api): automation runs can be cancelled

Adds the cancelled enum values and devices_cancelled, and stops reconciliation
downgrading a device-level cancelled to failed. #3525"
```

---

### Task 5.2: The dispatch fence and the fan-out route

**Files:**
- Create: `apps/api/src/services/automationRunCancellation.ts`
- Create: `apps/api/src/services/automationRunCancellation.test.ts`
- Create: `apps/api/src/services/automationRunCancelFence.integration.test.ts`
- Modify: `apps/api/src/services/automationRuntime.ts:2110-2212,2416-2548,2739-2830`
- Modify: `apps/api/src/routes/automations.ts` (new `POST /runs/:runId/cancel`)
- Modify: `apps/api/src/openapi.ts`, `apps/api/src/routes/devices/events.ts`

**Interfaces:**
- Consumes: `cancelExecutionsForRun` (2.4), `canManagePartnerWidePolicies` (`partnerWideAccess.ts:25`), `enforceAutomationSiteScope` (`routes/automations.ts:261`).
- Produces:
  ```ts
  export async function cancelAutomationRun(input: { runId: string; actorId: string | null; actorLabel: string }):
    Promise<{ executionsCancelled: number; uncancellableActions: Array<{ actionIndex: number; actionType: string; reason: string }> }>;
  export class RunCancelledError extends Error {}
  export async function assertRunNotCancelled(tx: CommandQueueTx, runId: string): Promise<void>;
  ```

**A read-at-boundary check is TOCTOU.** The dispatcher is action-major with a five-worker device pool (`automationRuntime.ts:2161`) plus a separately batched deployment path (`:2119-2157`), and neither runner checks run status before seeding or dispatching (`:2497-2502`, `:2759-2761`) — a queued job for an already-cancelled run runs to completion today.

- [ ] **Step 1: Write the failing fence tests**

Create `apps/api/src/services/automationRunCancellation.test.ts`:

```ts
describe('dispatch fence', () => {
  it('assertRunNotCancelled takes FOR SHARE on the run row inside the caller tx', async () => {
    await withTx((tx) => assertRunNotCancelled(tx, 'run-1'));
    expect(lastSelectSql()).toContain('for share');
  });

  it('throws RunCancelledError once the run is cancelled', async () => {
    seedRun({ status: 'cancelled' });
    await expect(withTx((tx) => assertRunNotCancelled(tx, 'run-1'))).rejects.toBeInstanceOf(RunCancelledError);
  });

  it('both runners refuse to seed at all for an already-cancelled run', async () => {
    seedRun({ status: 'cancelled' });
    await executeAutomationRun({ runId: 'run-1', ... });
    expect(seedAutomationDeviceResultsSpy).not.toHaveBeenCalled();
  });
});

describe('fan-out', () => {
  it('keys on automation_run_id ONLY, never on the caller org', async () => {
    // eq(scriptExecutions.orgId, auth.orgId) would silently no-op most of a
    // partner-wide run (CLAUDE.md Partner-Wide First rule 5).
    await cancelAutomationRun({ runId: 'run-1', actorId: 'u', actorLabel: 'tech' });
    expect(lastExecutionQuerySql()).toContain('automation_run_id');
    expect(lastExecutionQuerySql()).not.toContain('org_id');
  });

  it('reports execute_command and deployment actions as uncancellable', async () => {
    // execute_command deliberately creates NO script_executions row
    // (automationRuntime.ts:1305-1310) and deployments live in
    // deployment_results (:1993-2012). The UI must not claim the run stopped
    // while one of these is still live.
    seedRun({ actions: [{ index: 0, type: 'execute_command' }, { index: 1, type: 'deploy_software' }] });
    const out = await cancelAutomationRun({ runId: 'run-1', actorId: 'u', actorLabel: 'tech' });
    expect(out.uncancellableActions).toHaveLength(2);
  });

  it('marks NEVER-DISPATCHED actions cancelled but leaves in-flight ones non-terminal', async () => {
    // Resolves the spec's own contradiction: an in-flight action closes when
    // its child closes; the run reaches cancelled when every child is terminal.
    seedRun({ actions: [{ index: 0, status: 'running' }, { index: 1, status: 'pending' }] });
    await cancelAutomationRun({ runId: 'run-1', actorId: 'u', actorLabel: 'tech' });
    expect(actionStatus(0)).toBe('running');
    expect(actionStatus(1)).toBe('cancelled');
  });

  it('appends the cancellation log entry atomically with jsonb ||', async () => {
    // Both runners write the whole stale logs array (:2539, :2821), so a
    // concurrent completion would erase a plain set({ logs }).
    await cancelAutomationRun({ runId: 'run-1', actorId: 'u', actorLabel: 'tech' });
    expect(lastRunUpdateSql()).toContain('||');
  });
});
```

Create `apps/api/src/services/automationRunCancelFence.integration.test.ts` — the one test that must run against real Postgres:

```ts
it('creates ZERO new child rows after the fence commits', async () => {
  const runId = await startRunAgainst(20 /* devices */);
  await waitForFirstDispatch(runId);
  const before = await countChildRows(runId);
  await cancelAutomationRun({ runId, actorId: user.id, actorLabel: user.email });
  await settle(5_000);
  const after = await countChildRows(runId);
  // Bounded, not instant: rows created microseconds before the fence are
  // caught by it and cancelled, but none is created after it.
  expect(await countRowsCreatedAfter(runId, fenceCommittedAt)).toBe(0);
  expect(after).toBeGreaterThanOrEqual(before);
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/services/automationRunCancellation.test.ts
npx vitest run --config vitest.integration.config.ts src/services/automationRunCancelFence.integration.test.ts
```
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the fence and the service**

`assertRunNotCancelled(tx, runId)` does `SELECT status FROM automation_runs WHERE id = $1 FOR SHARE` and throws `RunCancelledError` on `'cancelled'`. Call it:
- at the top of both runners, before `seedAutomationDeviceResults` (`:2497`, `:2759`);
- inside `recordAutomationRuntimeActionDispatch`'s transaction, which is the function that creates the child `automation_action_results` row — this is the atomic fence;
- once per action in the dispatcher loop at `:2115`, so a long run stops between actions rather than only between devices.

`cancelAutomationRun` then: sets the run `cancelled` under `FOR UPDATE` (the same lock `reconcileInCurrentContext:242` takes); marks never-dispatched action rows `cancelled` with `terminal_source = 'cancellation'`; calls `cancelExecutionsForRun({ runId })`; classifies `execute_command` and `deploy_software` actions as uncancellable; and appends the log entry with `logs = COALESCE(logs, '[]'::jsonb) || $entry::jsonb`.

- [ ] **Step 4: Add the route**

In `apps/api/src/routes/automations.ts`, mirroring the existing mutating-route quartet (`requireScope`, `requireAutomationWrite`, `requireMfa()`, `requireValidRunId`):

```ts
automationRoutes.post('/runs/:runId/cancel',
  requireScope('organization', 'partner', 'system'),
  requireAutomationWrite,
  requireMfa(),
  requireValidRunId,
  async (c) => {
    const auth = c.get('auth');
    const runId = c.req.param('runId');
    const [run] = await db.select().from(automationRuns).where(eq(automationRuns.id, runId)).limit(1);
    if (!run) return c.json({ error: 'Automation run not found' }, 404);

    // OD10-B: config-policy runs are out of scope. automation_runs' RLS admits
    // that arm only via breeze_has_org_access(cp.org_id), so partner-owned
    // policy runs are invisible today. 404 matches the GET at :705-730.
    if (!run.automationId) return c.json({ error: 'Automation run not found' }, 404);

    const automation = await getAutomationWithOrgCheck(run.automationId, auth);
    if (!automation) return c.json({ error: 'Automation run not found' }, 404);

    // OD7-A: an org-scoped operator may cancel individual executions on THEIR
    // OWN devices (those rows carry the device's org), but must not stop a run
    // that fans out across sibling tenants.
    if (automation.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }
    // Site scope on top: a site-restricted user must not stop a run spanning
    // sibling sites.
    const siteDenied = await enforceAutomationSiteScope(c, automation);
    if (siteDenied) return siteDenied;

    const out = await cancelAutomationRun({ runId, actorId: auth.user.id, actorLabel: auth.user.email });

    writeRouteAudit(c, {
      orgId: automation.orgId, action: 'automation.run.cancel',
      resourceType: 'automation_run', resourceId: runId,
      details: { runId, automationId: run.automationId,
        ownerScope: automation.orgId === null ? 'partner' : 'organization',
        executionsCancelled: out.executionsCancelled,
        uncancellableActions: out.uncancellableActions },
    });
    return c.json({ success: true, ...out });
  });
```

Add `'automation.run.cancel': 'Automation run cancelled'` to `routes/devices/events.ts`'s label map, and an OpenAPI path entry with `operationId: cancelAutomationRun` and 200/403/404 responses.

- [ ] **Step 5: Write the partner/site RLS integration suite**

Create `apps/api/src/services/scriptCancellationPartnerRls.integration.test.ts` asserting, against real Postgres: an org token cancelling a **partner-wide** run gets 403; a partner token gets 200 with the fan-out reaching devices in **two different orgs**; a site-restricted user gets 403; a cross-tenant cancel gets 404; and a forged cross-partner `script_executions` update raises 42501.

- [ ] **Step 6: Run everything and commit**

```bash
cd apps/api && npx vitest run src/services/automationRunCancellation src/routes/automations
npx vitest run --config vitest.integration.config.ts \
  src/services/automationRunCancelFence.integration.test.ts \
  src/services/scriptCancellationPartnerRls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts
git add -A && git commit -m "feat(api): POST /automations/runs/:runId/cancel

Atomic dispatch fence plus fan-out keyed on automation_run_id only, so a
partner-wide run stops across every tenant it targets. execute_command and
deployment actions are reported as uncancellable rather than claimed stopped. #3525"
git push && gh pr create --title "feat(api): cancel an automation run (#3525 W05)" --body "Wave 5 of 6 for #3525."
```

---

# Wave 06 — Web affordances, polling, docs and E2E

Depends on W01 and W02. **There is no cancel call site in the web app today** — the endpoint has been MFA-guarded on the API since 2026-01-13 and has never been wired to any UI.

### Task 6.1: Stop button on the execution row and detail pane

**Files:**
- Modify: `apps/web/src/components/scripts/ExecutionHistory.tsx` (props + row action)
- Modify: `apps/web/src/components/scripts/ExecutionDetails.tsx` (header action + cancel-state copy)
- Modify: `apps/web/src/components/scripts/ScriptExecutionsPage.tsx:56-145`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (add `src/components/scripts/` to `TARGET_GLOBS`)
- Test: `apps/web/src/components/scripts/ExecutionHistory.cancel.test.tsx` (create)

**Interfaces:**
- Consumes: `executionRowStatusConfig`, `resolveExecutionStatusLabel` (1.2), `runAction`/`ActionError` (`lib/runAction.ts`), `ConfirmDialog` (`components/shared/ConfirmDialog.tsx`).
- Produces: `ExecutionHistoryProps.onCancel?: (execution: ScriptExecution, graceSeconds: number) => Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/scripts/ExecutionHistory.cancel.test.tsx`:

```tsx
describe('Stop affordance', () => {
  it.each(['pending', 'queued', 'running'] as const)('is offered on %s', (status) => {
    render(<ExecutionHistory executions={[exec({ status })]} onCancel={vi.fn()} permissions={withScriptsExecute} />);
    expect(screen.getByTestId('cancel-execution')).toBeInTheDocument();
  });

  it.each(['completed', 'failed', 'timeout', 'cancelled'] as const)('is absent on %s', (status) => {
    render(<ExecutionHistory executions={[exec({ status })]} onCancel={vi.fn()} permissions={withScriptsExecute} />);
    expect(screen.queryByTestId('cancel-execution')).toBeNull();
  });

  it('shows a disabled Stopping… spinner while cancelling', () => {
    render(<ExecutionHistory executions={[exec({ status: 'cancelling' })]} onCancel={vi.fn()} permissions={withScriptsExecute} />);
    expect(screen.getByTestId('cancel-execution')).toBeDisabled();
  });

  it('is HIDDEN, not disabled, without scripts:execute', () => {
    render(<ExecutionHistory executions={[exec({ status: 'running' })]} onCancel={vi.fn()} permissions={withoutScriptsExecute} />);
    expect(screen.queryByTestId('cancel-execution')).toBeNull();
  });

  it('Force stop sends graceSeconds 0', async () => {
    const onCancel = vi.fn();
    render(<ExecutionHistory executions={[exec({ status: 'running' })]} onCancel={onCancel} permissions={withScriptsExecute} />);
    await userEvent.click(screen.getByTestId('cancel-execution'));
    await userEvent.click(screen.getByTestId('confirm-force-stop'));
    expect(onCancel).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('a 409 surfaces a toast rather than a silent no-op', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Execution is no longer cancellable' }), { status: 409 }));
    await handleCancel(exec({ status: 'running' }), 5);
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('an OD9-C loser renders the too-late copy, not a bare Completed', () => {
    render(<ExecutionHistory executions={[exec({ status: 'completed', cancelState: 'unconfirmed' })]} permissions={withScriptsExecute} />);
    expect(screen.getByText(/too late/i)).toBeInTheDocument();
  });
});

describe('ScriptExecutionsPage polling', () => {
  it('polls while any row is running or cancelling', async () => {
    // The page fetches on mount and after an execution only (:89-93), so a
    // cancelling row would freeze on "Stopping…" forever.
    renderPage({ executions: [exec({ status: 'cancelling' })] });
    await advance(POLL_INTERVAL_MS + 50);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops polling once every row is terminal', async () => {
    renderPage({ executions: [exec({ status: 'completed' })] });
    await advance(POLL_INTERVAL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/web && npx vitest run src/components/scripts/ExecutionHistory.cancel.test.tsx`
Expected: FAIL — `ExecutionHistory` has no `onCancel` prop.

- [ ] **Step 3: Implement**

- `ExecutionHistory.tsx`: add `onCancel?` and `permissions?` props; render a `data-testid="cancel-execution"` button on `pending|queued|running` gated on `scripts:execute` (**hide**, don't disable); render a disabled spinner labelled `executionHistory.status.cancelling` while `cancelling`; render `resolveExecutionStatusLabel(status, cancelState)` instead of the raw status label.
- Use `ConfirmDialog` (`variant="warning"`, `confirmTestId="confirm-stop"`) with a secondary "Force stop" (`data-testid="confirm-force-stop"`) that passes `graceSeconds: 0`. The call site **must** either close the dialog or drive `isLoading` — `ConfirmDialog` emits a DEV `console.warn` otherwise.
- `ScriptExecutionsPage.tsx`: wrap the mutation in `runAction`, with `friendly` mapping 409 → `executionHistory.errors.noLongerCancellable`; on `ActionError` with `status === 401` return and let the auth redirect handle it. Add a poll driven by `executions.some(e => e.status === 'running' || e.status === 'cancelling')`, following the `ScriptTestRunner.tsx:47,262` `POLL_INTERVAL_MS = 2000` loop pattern (or `AutomationRunHistory.tsx:335-350`'s `SCRIPT_RESULT_POLL_MS` interval — either is on-pattern; pick one and match its cleanup).
- `no-silent-mutations.test.ts`: add `src/components/scripts/` to `TARGET_GLOBS`. No `src/components/scripts/*` file is in it today, so the new mutation would otherwise be unguarded.

- [ ] **Step 4: Run and commit**

```bash
cd apps/web && npx vitest run src/components/scripts src/lib/__tests__/no-silent-mutations.test.ts && npx tsc --noEmit
git add -A && git commit -m "feat(web): Stop a running script execution

Wires the long-existing cancel endpoint to the UI for the first time, with a
Force stop secondary action, polling while any row is running or cancelling,
and honest copy for an unconfirmed or too-late stop. #3525"
```

---

### Task 6.2: Cancel run in the automation run panel

**Files:**
- Modify: `apps/web/src/components/automations/AutomationRunHistory.tsx`
- Test: `apps/web/src/components/automations/AutomationRunHistory.cancel.test.tsx` (create)

- [ ] **Step 1: Write the failing tests**

```tsx
it('offers Cancel run on a running run', () => { /* data-testid="cancel-run" present */ });

it('is hidden for a partner-owned run without partner-wide management', () => {
  // OD7-A. The asymmetry must be visible: an org tech can still cancel each
  // individual execution on their own devices.
  render(<AutomationRunHistory run={run({ status: 'running', ownerScope: 'partner' })} permissions={orgScoped} />);
  expect(screen.queryByTestId('cancel-run')).toBeNull();
  expect(screen.getByTestId('cancel-run-partner-tooltip')).toBeInTheDocument();
});

it('surfaces uncancellable actions rather than claiming the run stopped', async () => {
  fetchMock.mockResolvedValue(json({ success: true, executionsCancelled: 3,
    uncancellableActions: [{ actionIndex: 0, actionType: 'execute_command', reason: 'no_execution_row' }] }));
  await clickCancelRun();
  expect(screen.getByText(/could not be stopped/i)).toBeInTheDocument();
});

it('renders devicesCancelled separately from succeeded and failed', () => { /* ... */ });
```

- [ ] **Step 2–4: Run (fail), implement, run (pass), commit**

```bash
cd apps/web && npx vitest run src/components/automations/AutomationRunHistory
git add -A && git commit -m "feat(web): cancel an automation run, with the partner-scope asymmetry visible #3525"
```

---

### Task 6.3: i18n, docs and E2E

**Files:**
- Modify: `apps/web/src/locales/*/scripts.json` (8 locales)
- Modify: `apps/docs/src/content/docs/agents/commands.mdx:503`
- Create: `apps/docs/src/content/docs/scripts/stopping-a-running-script.mdx`
- Create: `e2e-tests/pages/ScriptsPage.ts`, `e2e-tests/tests/script-cancel.spec.ts`

- [ ] **Step 1: Add and translate the new keys in all 8 locales**

`executionHistory.actions.stop`, `.forceStop`, `.confirmStopTitle`, `.confirmStopMessage`, `executionHistory.errors.noLongerCancellable`, `automationRunHistory.actions.cancelRun`, `.partnerScopeTooltip`, `.uncancellableActions`. Real translations — `translationCoverage.test.ts` fails on English-identical values.

- [ ] **Step 2: Run every i18n gate**

Run: `cd apps/web && npx vitest run src/lib/i18n/`
Expected: PASS on `localeParity`, `translationCoverage`, `terminologyQuality`, `extractionQuality`.

- [ ] **Step 3: Update the agent command reference**

In `apps/docs/src/content/docs/agents/commands.mdx:503`, document for `script_cancel`: the new `graceSeconds` (0–30, default 5) and `scriptExecutionId` fields; that **`executionId` is the original script command's id, not the execution row's id**; the `{executionId, outcome, cancelled}` result shape; and that **Windows has no graceful phase** — it goes straight to `TerminateJobObject`, because `GenerateConsoleCtrlEvent` needs a shared console and script children are `CREATE_NO_WINDOW`.

- [ ] **Step 4: Write the operator page**

Create `apps/docs/src/content/docs/scripts/stopping-a-running-script.mdx` covering: where the Stop button is; what "Stopping…" means; what an unconfirmed stop means and why the row still shows the script's own outcome; that Force stop skips the grace period; and **what is not promised** — processes the script deliberately detaches (`nohup`, `systemd-run`, a scheduled task the script registers) survive, because Job Object and process-group containment cover only the ordinary tree.

- [ ] **Step 5: Write the E2E spec**

Create `e2e-tests/pages/ScriptsPage.ts` extending `BasePage` (testid-only; there is no scripts page object today) and `e2e-tests/tests/script-cancel.spec.ts`:

```ts
test('a running script can be stopped from the executions list', async ({ page }) => {
  const scripts = new ScriptsPage(page);
  await scripts.gotoScript(SLEEP_120_SCRIPT_ID);
  await scripts.runOn(SEEDED_DEVICE_ID);
  await expect(scripts.executionStatus(0)).toHaveText(/running/i);

  await scripts.cancelExecution(0);
  await expect(scripts.executionStatus(0)).toHaveText(/stopping/i);
  // The grace window is 5s and CANCEL_GRACE_MS is 90s; 30s is comfortably
  // inside both while still failing fast if the agent never acks.
  await expect(scripts.executionStatus(0)).toHaveText(/cancelled/i, { timeout: 30_000 });
});
```

- [ ] **Step 6: Run and open the final PR**

```bash
cd e2e-tests && pnpm test -- script-cancel
cd .. && pnpm lint
git add -A && git commit -m "docs(web): i18n, operator guide and E2E for stopping a script #3525"
git push && gh pr create --title "feat(web): stop a running script or automation from the UI (#3525 W06)" \
  --body "Wave 6 of 6 for #3525. Closes #3525."
```

---

## Rollout notes

- **No server-side feature flag.** Cancel is a de-escalation and `script_cancel` is already in `LIFECYCLE_COMMAND_TYPES` (`partnerTrust.ts:42`), so a probationed partner can still stop a script. Backward compatibility with the deployed fleet holds **only because** the cancel carries the original command id; the agent handler has been in the field since 2026-02-07 (`6a1689e499`). **Verify the oldest supported agent band before merging W02** — an older band answers "unknown command", which W03's sweep correctly records as `unconfirmed`: degraded, but honest.
- **W04 is agent-shipped code.** Canary a small band before fleet promote. The Windows containment change is a **behaviour change on the timeout path too**, and it is the one thing here that could break a working customer script — watch for scripts that legitimately spawn detached children and now die with the parent.
- `CANCEL_GRACE_MS` ships env-tunable (default 90 s).
- **Historical `cancelled` rows are not reconciled.** Rows written by the old bookkeeping-only route keep `cancel_state IS NULL` = "legacy, unknown". Do not backfill.
- **Follow-up issues to file** (do not bundle):
  1. `automation_runs` config-policy RLS gap — partner-owned policy runs are invisible (OD10).
  2. Batch cancel — needs a `batch_id` correlation column on `script_executions` first (OD5).
  3. Helper executor persistence across IPC reconnects — a `runAs=user` script that survives a reconnect is unreachable (W04 Task 4.4 residual).
  4. `automation_runs.automation_id` has a non-cascading FK and `config_policy_id` has no FK, so org erasure can strand run logs.

---

## Self-review

**Spec coverage.** §1 state machine → 2.1, 2.4, 3.1, 3.2 (with the OD8-C gap filled and the derivation recorded above). §2 API → 2.4, 2.5, 5.2. §3 delivery + all four registration lists + the timeout trap + dedup → 2.3, 2.4. §4 agent (four blockers, escalation, PGID, Job Object, helper `not_found`, IPC timeout) → 4.1–4.4. §5 automation fan-out (fence, uncancellable actions, non-terminal contradiction, reconciliation, log clobber) → 5.1, 5.2. §6 audit (three actions + `AUDITED_COMMANDS` + the label map) → 2.3, 2.5, 3.2, 5.2. §7 web → 1.2, 1.3, 6.1, 6.2. §8 race table → every row has a test in 2.4, 3.1 or 3.2. §9 five closers → 2.4 (closer 2 routing), 3.1 (closers 1, 3), 3.2 (closers 4, 5). Tenancy → 2.2 plus the global constraints. Test & rollout notes → each wave's test steps plus the rollout section.

**Deviations from the spec, all deliberate and flagged in the PR bodies:**
1. **Five columns, not four** (OD1-A said four). `cancel_prev_status` makes the revert deterministic; `cancel_confirmed` became `cancel_state` per OD8-C's own rider.
2. **`not_found` is `unconfirmed`, not `confirmed`** (spec §1 diagram said confirmed). An agent that restarted has an empty `e.running` and on macOS/BSD there is no `Pdeathsig`, so the process may survive; far more often the script simply finished and its result is in flight.
3. **No new terminal statuses.** The spec's §1 diagram used `cancel_unconfirmed`/`cancel_failed`, but those belong to OD8 option **B**, which was not the approved option. Under the approved option C an unproven cancel reverts instead.
4. **The agent's script result gains a cancellation marker.** The spec identified the absence of a termination reason as the reason OD9-B would "fabricate causality"; adding it is cheap in W04 and removes the guess.
5. **`script_cancel` gets the 2-hour tier**, a value the spec did not name (it said "long, like `software_install`"). Seven days is absurd for a cancel; two hours strictly exceeds the longest possible script lifetime.

