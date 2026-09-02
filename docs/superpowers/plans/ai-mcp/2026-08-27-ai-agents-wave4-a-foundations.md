---
tracking_issue: LanternOps/breeze#3821
wave: W05 (#3826) — Part A (inert foundations)
---

# Wave 4 Part A — Act-Mode Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The inert groundwork act mode (Part B) will stand on: a real execution ledger for agent runs (ai_sessions + ai_tool_executions rows instead of the `'(inline)'` placeholder), agent attribution that survives users-FK columns, durable run-finished notifications, the `maxActionsPerRun` cap + policy snapshot v2, and device-exact pinning of the agent principal. **Zero behavior change for what agents may DO** — modes stay `off|shadow`; every change here is ledger/attribution/plumbing that shadow runs exercise immediately.

**Architecture:** Each agent run gets one `ai_sessions` row (`type: 'agent'` — the schema shipped this in wave 1: `ai_sessions.agent_id`, `ai_sessions_agent_type_check`, single-principal CHECK, `ai_agent_runs.session_id` FK) created at run start; the run-loop pre-hook inserts a real `ai_tool_executions` row (UUID, status `executing`) per allowed call and the post-hook completes it (per-tool FIFO correlation — same ordering assumption as today's `Map<toolName, count>`, now with durable rows); run finish reconciles any row left `executing`. Script/playbook writers stop writing synthetic agent ids into users-FK columns (probe-and-degrade, the `commandQueue.ts:855-889` precedent) while preserving agent attribution in metadata. `notifyRunFinished` failures enqueue a BullMQ retry (safe: `createNotification` is dedupe-idempotent). `maxActionsPerRun` joins `AiAgentLimits`; snapshot version bumps 1→2 with read-side tolerance for 1. `AuthContext` gains optional `allowedDeviceIds`; the agent context pins device-bound runs to THE device, not its whole site.

**Tech Stack:** TypeScript, Drizzle, BullMQ, Vitest. **No DB migrations** (all new state fits existing columns; `maxActionsPerRun` lives inside the `limits` jsonb; ledger rows use existing tables).

**Design authority:** Program spec `docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md` + wave-4 advisor quorum 2026-08-27 (Fable position + codex xhigh — codex amendments adopted; full decision record in the run memory + PR body). **Do not relitigate:** no blanket Tier-2 execution ever (Part B uses a closed operation manifest); this PR changes no guardrail dispositions; `execute_command` stays excluded from any act path; attribution for agent commands lives on the run/intent linkage, never on users-FK columns.

## Global Constraints

- **Inertness is the safety story**: `SUPPORTED_AGENT_MODES` stays `['off','shadow']` in this PR. A shadow run behaves identically except: it now has a session row, real tool-execution rows, device-exact pinning (a *tightening*), and durable notifications. Nothing new executes.
- Run single test files as `cd apps/api && npx vitest run <path>`; typecheck `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`.
- No new env vars, no compose changes, NO migrations. If you believe you need a migration, stop and re-read the schema — `ai_sessions.agent_id`/`type` and `ai_agent_runs.session_id` shipped in `2026-09-02-ai-agents.sql`.
- New columns are NOT being added, so the tenant-export-policy registry needs no edits. If any task drifts into adding a column, that's a plan violation — stop.
- BullMQ queues via `createInstrumentedQueue` only; enqueues outside held DB contexts (#1105); jobIds hyphen-only.
- `ai_tool_executions` has no `org_id` (tenancy via `session_id → ai_sessions`, registered as derived in rls-coverage `:562-563`). Writing rows requires the run's system DB context (same context the loop already holds for outcome writes — verify with the existing patterns in `runLoop.ts`).
- Shared-package edits (`packages/shared`) ripple: run `pnpm --filter @breeze/shared test` AND the api suite after Task 4.
- Commit after every task with trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_012o7QB15EFjEvetDAXMxmae`

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/aiAgents/executionLedger.ts` (new) | Session-per-run + tool-execution row lifecycle + crash reconcile. |
| `apps/api/src/services/aiAgents/runLoop.ts` (modify) | Create session at start; hooks write/complete ledger rows; reconcile in finish; notify retry enqueue. |
| `apps/api/src/jobs/agentNotifyRetryWorker.ts` (new) | Tiny BullMQ retry lane for failed run-finished notifications. |
| `apps/api/src/services/scriptDispatch.ts` + `services/aiToolsScripts.ts` + `services/aiToolsPlaybooks.ts` (modify) | Users-FK probe-and-degrade + agent attribution metadata. |
| `packages/shared/src/types/aiAgents.ts` + `validators/aiAgents.ts` (modify) | `maxActionsPerRun`, snapshot v2. |
| `apps/api/src/services/aiAgents/agentAuthContext.ts` + the shared `AuthContext` type + device-access helper (modify) | `allowedDeviceIds` device-exact pinning. |
| `apps/api/src/services/workerRegistry.ts` + `index.ts`/`worker.ts` shutdown (modify) | Register the notify-retry worker (global placement). |

---

### Task 1: Execution ledger service

**Files:**
- Create: `apps/api/src/services/aiAgents/executionLedger.ts`, `executionLedger.test.ts`

**Interfaces (produced):**
- `createAgentRunSession(args: { runId: string; agentId: string; orgId: string; deviceId: string | null; model: string }): Promise<string>` — inserts `ai_sessions` (`type: 'agent'`, `agentId`, `orgId`, `deviceId`, `model`, `status: 'active'`, `maxTurns` from caller) and CAS-updates `ai_agent_runs.session_id` WHERE `session_id IS NULL` (re-run of a crashed run must not orphan a second session: on CAS miss, mark the just-created session `status: 'completed'` and return the run's existing sessionId).
- `startToolExecution(args: { sessionId: string; toolName: string; toolInput: Record<string, unknown> }): Promise<string>` — inserts `ai_tool_executions` (status `'executing'`... check the `aiToolStatusEnum` values first and use the correct in-flight value; if only `pending|approved|executing|completed|failed|denied`-style values exist, pick the in-flight one) and returns the row id.
- `completeToolExecution(args: { executionId: string; isError: boolean; durationMs: number }): Promise<void>` — sets terminal status + `durationMs` + `completedAt`. Tool OUTPUT is deliberately NOT stored in this PR (redaction rules land with Part B's manifest; storing raw outputs now would leak command results into an exportable table — `toolOutput` stays null).
- `reconcileHungExecutions(sessionId: string): Promise<number>` — terminal-marks (status failed, errorMessage `'run finished with execution unresolved'`) every row still in-flight for the session; returns count.
- `closeAgentRunSession(sessionId: string, status: 'completed' | 'failed'): Promise<void>`.

- [x] **Step 1: failing unit tests** (Drizzle mock pattern per `breeze-testing`): session insert carries `type:'agent'` + agentId + no userId; CAS second-session behavior; start/complete round-trip; reconcile only touches in-flight rows of THAT session; all writes run under the provided db handle (no ambient pool).
- [x] **Step 2: verify fail → Step 3: implement → Step 4: green + typecheck. Commit:** `feat(api): agent run execution ledger — session per run + real tool-execution rows (#3826)`

---

### Task 2: Wire the ledger into the run loop

**Files:**
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` (`executeAgentRun` ~:836-929; `createAgentRunPreToolUse` :320-401; `createAgentRunPostToolUse` :414-435; `finishRun` :937-975)
- Test: extend `runLoop`'s existing test files

**Contract:**
- After the CAS `queued→running`, create the session (Task 1) with the run's policy-snapshot model + maxTurns; store `sessionId` in the RunContext.
- Pre-hook: for an ALLOWED call, `startToolExecution` and push the returned id into a per-toolName FIFO (replacing nothing — the `allowedPending` count map stays for the post-hook gate). A ledger-write failure must NOT block the tool call (log + push a sentinel `null`): the ledger is observability, not authorization — authorization stays entirely in `checkAgentGuardrails`.
- Post-hook: shift the FIFO; when an id is present, `completeToolExecution`; `outcome.executedActions[].executionId` becomes the real UUID (falls back to `'(inline)'` on sentinel). Same-ordering caveat documented: per-tool FIFO correlation matches today's count-map assumption; genuine per-invocation ids need SDK hook support (out of scope).
- `finishRun`: after the status CAS succeeds, `reconcileHungExecutions` + `closeAgentRunSession` (completed for `completed|awaiting_approval`, failed otherwise) — both best-effort (log, never change the run's terminal status).
- Denied/proposed calls create NO ledger rows (they never execute).

- [x] **Step 1: failing tests** — session created once per run with the snapshot's model; executedActions carry real UUIDs; ledger failure doesn't block the call (tool still executes, executionId `'(inline)'`); reconcile invoked on finish; proposals produce no rows.
- [x] **Step 2-4: red → implement → green + typecheck. Commit:** `feat(api): run loop writes the execution ledger (#3826)`

---

### Task 3: Agent attribution — users-FK probe-and-degrade

**Files:**
- Modify: `apps/api/src/services/scriptDispatch.ts` (`dispatchScriptToDevice` — find where `triggeredBy`/`createdBy` land in `script_executions.triggered_by` (FK → users, `schema/scripts.ts:126`)), `apps/api/src/services/aiToolsScripts.ts` (:445-454 passes `auth.user.id` verbatim), `apps/api/src/services/aiToolsPlaybooks.ts` (:180-193 `triggeredByUserId: auth.user.id`)
- Test: extend the three services' test files

**Contract (mirror `commandQueue.ts:855-889` — the shipped precedent):**
- `dispatchScriptToDevice` gains an internal users-row probe for its `triggeredBy`/`createdBy` values (single probe, both columns): a value that is not a real `users.id` degrades to `null` before insert, and the dispatch metadata/details JSON records `{ actorType: 'ai_agent', actorId: <original id> }` so attribution survives. Callers unchanged.
- `aiToolsPlaybooks`: same probe for `triggeredByUserId`; the existing `triggeredBy: 'ai'` varchar tag stays.
- Audit: where these paths call `createAuditLog`, pass `actorType: 'ai_agent'` when the auth principal kind is `ai_agent` (`auth.principal.kind` — verify the field shape in `agentAuthContext.ts:71-105`), instead of the default `'user'` derivation.
- Do NOT touch `routes/remediationSuggestions.ts` (human-only route; agents can't reach it — Part B builds the agent-safe service).

- [x] **Step 1: failing tests** — agent-shaped id (not a users row) → columns written null + metadata carries actorType/actorId; real user id → unchanged behavior byte-for-byte; audit actorType asserted via mock.
- [x] **Step 2-4: red → implement → green + typecheck. Commit:** `fix(api): agent principals no longer write synthetic ids into users-FK attribution columns (#3826)`

---

### Task 4: `maxActionsPerRun` + policy snapshot v2

**Files:**
- Modify: `packages/shared/src/types/aiAgents.ts` (`AiAgentLimits` + `AI_AGENT_LIMIT_DEFAULTS` :22-42; `AI_AGENT_POLICY_SNAPSHOT_VERSION` :93), `packages/shared/src/validators/aiAgents.ts` (`limitsFields` :31-45)
- Modify: every snapshot-version consumer — `grep -rn "AI_AGENT_POLICY_SNAPSHOT_VERSION\|schemaVersion" apps/api/src packages/shared/src` and make every read-side check accept `1 | 2` (an in-flight run enqueued before deploy carries v1; it must still execute — write-side always stamps 2)
- Test: shared validator tests + effectivePolicy merge tests

**Contract:** `maxActionsPerRun: number` — default **3**, validator `int().min(1).max(10)`. The `mergeLimits` loop (`effectivePolicy.ts:67-97`) handles new numeric fields generically (min-wins) — add a merge test proving partner 5 + org 2 → 2. NOTHING enforces the cap in this PR (Part B's loop does); the field exists so partners can pre-configure and snapshots carry it.

- [x] **Steps: red → implement → `pnpm --filter @breeze/shared test` + api effectivePolicy/runService tests + typecheck → green. Commit:** `feat(shared,api): maxActionsPerRun limit + agent policy snapshot v2 (#3826)`

---

### Task 5: Device-exact pinning of the agent principal

**Files:**
- Modify: the `AuthContext` type (find it: `grep -rn "interface AuthContext" apps/api/src packages/shared/src` — add OPTIONAL `allowedDeviceIds?: readonly string[]`), `apps/api/src/services/aiAgents/agentAuthContext.ts` (:71-105 — set `allowedDeviceIds: [run.deviceId]` for device-bound runs alongside the existing site pinning)
- Modify: the device-access resolution helper the AI tools use (find the single chokepoint: grep how `aiTools*` resolve `access.device` — likely a `resolveDeviceAccess`/`requireDeviceAccess` in a shared aiTools helper; enforce `allowedDeviceIds` there when present: a device not in the list → the same "not found/no access" error shape the helper already returns)
- Test: agentAuthContext tests + the device-access helper's tests

**Contract:** device-bound agent run + sibling device in the SAME site → denied (today it passes — the site-level pin is the verified gap, `agentAuthContext.ts:71`). Interactive/user AuthContexts never set the field → zero behavior change. Non-device-bound agent runs (org-wide triage) don't set it either — their scoping stays org+site rules.

- [x] **Steps: red (the sibling-device test MUST fail against current code — that's the proof the gap is real) → implement → green + typecheck. Commit:** `fix(api): device-bound agent runs are pinned to the exact device, not the site (#3826)`

---

### Task 6: Durable run-finished notifications

**Files:**
- Create: `apps/api/src/jobs/agentNotifyRetryWorker.ts` (+ test)
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` (`notifyRunFinished` :527-579), `apps/api/src/services/workerRegistry.ts` (+ its two snapshot lists in `workerRegistry.test.ts` / `workerEntrypointClosure.contract.test.ts` — registry entry `agentNotifyRetry`, placement will be verdicted by the closure contract test; expect `global`)
- Test: extend runLoop notify tests

**Contract:**
- `notifyRunFinished` structure unchanged (recipients from the immutable snapshot, re-resolved at notify time), but: (a) the notification `metadata` gains the structured shape Part B will fill — `{ runId, agentId, intentIds, status, executedActionCount: outcome.toolExecutionCount, verdict: null }` (verdict stays null until Part B); (b) on ANY failure (resolve or create), enqueue ONE `agent-notify-retry` job carrying `{ runId }` — job options `attempts: 5`, exponential backoff starting 30s, `jobId: 'agent-notify-<runId>'` (hyphen-only).
- The worker re-loads the run + agent + snapshot from the DB and re-runs the same notify logic (extract the body into an exported `deliverRunFinishedNotifications(runId)` both paths call). Idempotent by construction: `createNotification`'s `(userId, dedupeKey)` conflict-ignore (`userNotifications.ts:78-94`) makes duplicate delivery a no-op.
- Zero-recipients stays a silent return here (act-activation prerequisites are Part B) — but now logged at warn with the runId.

- [x] **Steps: red → implement → green (incl. registry snapshot updates: 105 → 106 names — update BOTH literals + counts, run the closure contract test for the placement verdict) + typecheck. Commit:** `feat(api): durable agent run-finished notifications via retry lane (#3826)`

---

### Task 7: Verification + PR

- [x] Full api unit suite (exact totals) + `pnpm --filter @breeze/shared test` + typecheck (heap bump).
- [x] Contract tests explicitly: workerEntrypointClosure + workerRegistry + agentDispatchBoundary + envComposeParity — green.
- [x] Repo-wide grep: no remaining `'(inline)'` writes outside the documented ledger-failure fallback; no new `auth.user.id` writes into users-FK columns in the three touched services.
- [ ] Tick plan checkboxes. **Open the PR**: branch `feature/3821-ai-agents/wave-3826` → main, title `feat(api): wave 4 part A — act-mode foundations (execution ledger, attribution, durable notify, caps v2, device pinning)`, body: inertness statement (modes still off|shadow), the quorum pointer, per-task summary, and "Part A of #3826 — do NOT close the issue". **Stop after opening the PR.**

## Self-Review Notes

- Inertness check per task: T1/T2 add rows shadow runs write anyway; T3 tightens attribution (agent ids stop hitting users FKs — strictly fewer 23503 risks); T4 adds an unenforced field; T5 is a pure tightening; T6 retries something that previously just failed. No guardrail disposition changes anywhere.
- Type consistency: ledger fn names (T1) consumed in T2; `deliverRunFinishedNotifications` (T6) shared by loop + worker; `allowedDeviceIds` optional so no other AuthContext construction site changes.
- Known deferred (Part B): manifest + executors + act guardrail branch + revalidation + verification verdicts + notification verdict content + act-activation prerequisites + UI + `maxActionsPerRun` enforcement + agent-safe remediation-suggestion service + deterministic playbook executor.
