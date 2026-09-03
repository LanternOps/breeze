---
issue: LanternOps/breeze#3525
status: draft
authors: Claude (Opus 5), reviewed by Codex gpt-5.6-sol @ xhigh (advisor quorum)
date: 2026-09-02
area: scripts / automations / agent
---

# Cancel a running script or automation — design spec

**Issue:** [#3525](https://github.com/LanternOps/breeze/issues/3525) (p1, `category:scripts`, `effort:l`)
Reported by @tim104979 in discussion #2598; operator-side half of #3445.

> **Quorum note.** This spec went through the CLAUDE.md advisor quorum (Claude
> position → independent read-only Codex `gpt-5.6-sol` @ `xhigh`). Codex found a
> **blocker** in the first draft (the executionId contract, §Problem/6 below) and
> a dozen correctness errors, all independently re-verified against the code
> before folding in. Two of the original recommendations were reversed and two
> new Open Decisions were opened rather than resolved. Where the two positions
> still differ, the difference is recorded in Open Decisions, not smoothed over.

---

## Problem

A tech watching a wedged script execution has no way to stop it. The only exits
are the agent returning a result or the deadline elapsing — the script's own
timeout plus `SCRIPT_GRACE_BUFFER_MS` (5 min, `apps/api/src/services/commandTimeouts.ts:20`).
For a script carrying a 3600 s timeout that is 65 minutes of a row sitting
`running` with no recourse.

### What the issue got wrong, and what that changes

The issue asserts that `apps/api/src/routes/scripts.ts` "registers none" of a
cancel path. **That is not true and has not been true since 2026‑01‑13**
(`b40defc7c`). Verified by code read:

| Layer | Claimed missing | Actually present |
|---|---|---|
| API route | absent | `POST /scripts/executions/:id/cancel` — `apps/api/src/routes/scripts.ts:1174-1212`. `requireMfa()`, `scripts:execute`, org + site access checks, CAS on status, `applyAutomationActionTerminal`, audit `script.execution.cancel`. |
| OpenAPI | — | documented, `operationId: cancelScriptExecution` (`apps/api/src/openapi.ts:2689-2707`) |
| Agent command | "needs new plumbing?" | `script_cancel` + `script_list_running` exist (`agent/internal/remote/tools/types.go:154`), handled at `agent/internal/heartbeat/handlers_script.go:277`, forwarded over IPC to the user-helper for `runAs=user` scripts (`agent/internal/userhelper/client.go:712`). Publicly documented (`apps/docs/src/content/docs/agents/commands.mdx:503`). |
| Agent kill handle | "not established" | `Executor.Cancel(executionID)` — `agent/internal/executor/executor.go:281-298`. Holds `cmd` + `context.CancelFunc` per execution in `e.running`; cancel triggers `cmd.Cancel` → `killProcessGroup`. |
| Trust gating | — | `script_cancel` is already in `LIFECYCLE_COMMAND_TYPES` (`apps/api/src/services/partnerTrust.ts:42`), so a probationed partner can still stop a script. Correct: cancel is a de‑escalation. |

So this is **not** "build cancel". It is **"the cancel we shipped is the UI that
lies the issue warned about, and nothing on the server has ever sent the agent
command that already exists."**

### The defects

1. **Bookkeeping-only cancel.** The route stamps `script_executions.status =
   'cancelled'` immediately (`scripts.ts:1222-1237`), then cancels device
   commands `WHERE status = 'pending'` only (`scripts.ts:1248-1263`). A command
   already `sent` — *the running case, the entire point of the issue* — is
   untouched. The script keeps executing while the UI says "Cancelled".
   `apps/api/src/services/commandResultHandlers.ts` already documents this as a
   known benign race and **deliberately drops the agent's real output**. That
   comment is the design bug written down.
   *(Two sub-facts, corrected from the first draft: an already-terminal
   execution returns **400**, not 409 — 409 only happens when the CAS loses.
   And the command update does not constrain `type = 'script'`, so it can
   collide with an unrelated pending command whose payload happens to carry the
   same `executionId`.)*
2. **Nothing queues `script_cancel`.** `CommandTypes` has `SCRIPT: 'script'` and
   no `SCRIPT_CANCEL` (`commandQueue.ts:100-102`); the result registry only
   registers `script` (`commandResultHandlers.ts:618-640`); the REST/polling
   dispatch allowlist `REGISTRY_DISPATCHED_COMMAND_TYPES`
   (`routes/agents/commands.ts:87-96`) likewise lists only `script`. The agent
   handler and the public docs describe a command the server has never sent.
3. **Windows kills only the shell leader.** `agent/internal/executor/limits_windows.go:12-21`:
   `setProcessGroup` is an explicit no-op ("Job Objects … deferred to a future
   enhancement") and `killProcessGroup` calls `cmd.Process.Kill()`. A PowerShell
   script that starts `msiexec` or `robocopy` leaves that child alive.
   **This is already true for the timeout path today**, so fixing it fixes both.
   Unix is fine (`limits_unix.go:19-28`, `limits_linux.go:20-29`).
4. **No graceful stop.** Unix goes straight to `SIGKILL` on the process group. A
   script mid-transaction gets no chance to unmount, release a lock, or clean up.
5. **Automations have no cancel at all.** `automation_run_status` is
   `running|completed|failed|partial` and `automation_device_result_status` has
   no `cancelled` either (`db/schema/automations.ts:11-20`). No route — the run
   endpoints around `routes/automations.ts:685-752` are GET-only. No cooperative
   check anywhere in the dispatcher.
6. **⚠ BLOCKER — the `executionId` the agent keys on is NOT `script_executions.id`.**
   The agent registers a running script in `e.running[script.ID]` where
   `script.ID = cmd.ID`, i.e. the **`device_commands.id`**
   (`handlers_script.go:79-87`; `executor.go:222-229`; helper:
   `userhelper/client.go:769-776`). The server generates
   `script_executions.id` as an independent UUID and puts it in the payload as
   `executionId` (`scriptDispatch.ts:393-420, 470-503`) — a *different* value.
   A `script_cancel` carrying `{executionId: script_executions.id}` would return
   `notFound` on **every agent in the fleet**. The whole feature would be a
   silent no-op. This is the single most important finding in this spec and it
   dictates the wire contract in §3.

### Bonus: two live UI crashes, already reachable

`apps/web/src/components/scripts/ExecutionHistory.tsx:7,33-39` types
`ExecutionStatus` as five values and `statusConfig` has exactly those five keys;
`ExecutionDetails.tsx:15-21` re-uses the union. Both index it **unguarded**
(`ExecutionHistory.tsx:284-309`, `ExecutionDetails.tsx:171-209`). The DB enum is
`pending|queued|running|completed|failed|timeout|cancelled`. `queued` is written
by the automation runtime for undelivered dispatches
(`automationRuntime.ts:1239-1248`) and `cancelled` by the existing cancel route,
so `undefined.color` / `undefined.icon` is reachable **today**.
`AutomationRunHistory.tsx:99-100` has the same shape (`StatusKey` without
`cancelled`, indexed unguarded at line 352) and will acquire the same crash the
moment `automation_run_status` gains `cancelled`.
*(Verified by code read; not reproduced in a browser.)*

---

## Users & scope

**Primary user:** an MSP technician or engineer watching a script or automation
run go wrong on a customer endpoint, who wants it stopped **now**.

**Partner vs org — the load-bearing distinction.**

| Object | Owner axis | Who may cancel |
|---|---|---|
| `script_executions` row | Shape 1, direct `org_id` (the **device's** org) | `scripts:execute` + org access + **site access** to that device. Partner-scope tokens reach it through `breeze_has_partner_access`. Unchanged from today. |
| `automation_runs` for an **org-owned** automation | run inherits the automation's org | `automations:write` + org access + **site scope over every device the run targets** (`routes/automations.ts:249-275` already establishes that device-acting operations must enforce site access — a site-restricted user must not stop a run spanning sibling sites) |
| `automation_runs` for a **partner-wide** automation (`automations.org_id IS NULL`) | partner | **`canManagePartnerWidePolicies(auth)`** — system, or partner scope with `partnerOrgAccess='all'` (`services/partnerWideAccess.ts:19-29`). An org-scoped operator must NOT stop a run that fans out across sibling tenants. |
| **config-policy** runs (`automation_runs.config_policy_id`) | the policy's owner axis | ⚠ **broken today**: `automation_runs` RLS admits the config-policy arm only via `breeze_has_org_access(cp.org_id)` (`migrations/2026-07-02-automations-partner-ownership.sql:97-149`), but partner-owned policies have `org_id = NULL`, so partner-wide policy runs are invisible (the GET explicitly hides them, `routes/automations.ts:704-721`). A cancel route for these needs the RLS policy corrected **and** owner-axis authorization, or it must be scoped out — see Open Decision 10. |

The asymmetry is deliberate and must be visible in the UI: an org tech **can**
cancel each individual `script_executions` row on **their own** devices that a
partner-wide run produced (those rows carry the device's org), but **cannot**
stop the run itself.

**In scope:** single script execution, automation run (manual, scheduled, event,
webhook; config-policy runs subject to OD10), the agent-side kill on
Windows/macOS/Linux including `runAs=user` helper executions, audit, web UI,
race semantics.

---

## Proposed design

### 1. State machine

`script_executions.status` gains **`cancelling`** (non-terminal).

```
                      ┌──── cancel, original command still `pending` ────┐
                      │            (provably nothing ran)                 │
                      ▼                                                   │
  pending ──▶ queued ──▶ running                                     cancelled
     │           │          │                                     (confirmed=true)
     └───────────┴──────────┴──── cancel, command already `sent` ──▶ cancelling
                                                                         │
   ┌─────────────────────────────────────────────────────────────────────┤
   │ original script result arrives ──────────▶ see Open Decision 9       │
   │ cancel-command result: {cancelled:true} ─▶ cancelled (confirmed)     │
   │ cancel-command result: {notFound:true} ──▶ cancelled (confirmed)     │
   │ cancel-command result: kill FAILED ──────▶ cancel_failed             │
   │ cancel command expired / agent unsupported ▶ cancel_unconfirmed      │
   │ grace deadline, no ack ──────────────────▶ cancel_unconfirmed        │
   └─────────────────────────────────────────────────────────────────────┘
```

**The contract, in one line:** the row must never claim the script stopped
unless the endpoint said so. The *representation* of "we asked but cannot prove
it" is **Open Decision 8** — a `cancelled` row with `cancel_confirmed = false`
(original position) versus a distinct terminal state (`cancel_unconfirmed`, the
quorum's counter-position, used in the diagram above because it makes the extra
transitions legible). Both encode the same information; they differ in how hard
it is for a downstream reader to accidentally treat an unconfirmed cancel as a
confirmed one.

`cancelling` is non-terminal: it does not increment batch counters, does not
close the automation action result, and is not an outcome for reporting.

New columns on `script_executions`:

| Column | Type | Meaning |
|---|---|---|
| `cancel_requested_at` | `timestamptz` | when the operator asked. Also the record that a *losing* cancel request happened (OD9). |
| `cancelled_by` | `uuid` | actor. **Must NOT be a bare `REFERENCES users(id)`** — the AI-agent cancel tool's actor id is not a user id, and `scriptDispatch.ts:380-391` / `commandQueue.ts:505-525` already probe-and-degrade such ids before writing a user FK. Either apply the same degrade, or store `(actor_type, actor_id)` polymorphically. |
| `cancel_confirmed` | `boolean` | NULL while `cancelling`. Subject to OD8. |
| `cancel_command_id` | `uuid` | the `device_commands.id` of the dispatched `script_cancel`, so the closers can find it. |

**Transitions the first draft missed** (all folded in from the quorum):
- **Terminal original command, non-terminal execution.** Result ingestion
  terminalises `device_commands` *before* calling `handleScriptResult`
  (`routes/agentWs.ts:1802-1837, 1933-1942`), so this pairing is reachable. On
  cancel, recover the completion instead of queueing a doomed cancel.
- **Cancel command expired or unsupported by an old agent** → `cancel_unconfirmed`,
  never left dangling.
- **Original result arriving after a cancel ack**, including after a *confirmed*
  cancel — the recovery must not be gated on `cancel_confirmed = false`.
- **Cancellation failure**: agent reachable, but job assignment / signal / hard
  kill failed. This must be distinguishable from "never answered".

Consequently **"exactly two closers" was wrong**. There are five:
original-result completion, cancel-result completion, durable late-result
recovery, delivery-expiry / unsupported-agent, and reaper give-up.

### 2. API

**`POST /scripts/executions/:id/cancel`** (existing route, rewritten body).
Unchanged guards. New behaviour:

1. Load the execution and its paired command **`FOR UPDATE`**, matching on
   `type = 'script' AND payload->>'executionId' = :id` (adding the `type`
   predicate the current code omits).
2. CAS the execution from `('pending','queued','running')`.
   - Already `cancelling`, or already terminal with cancellation metadata →
     **200, idempotent**, returning current state.
   - Otherwise terminal → **409** (changing today's 400; note this in the
     OpenAPI diff and the web error handling).
3. Branch on the command row:
   - **command `pending`** → CAS it to `cancelled` (+ `terminalPayloadErasureSet()`);
     execution → terminal-cancelled, confirmed. Nothing ever ran.
   - **command already terminal** → do not queue a cancel; recover the
     completion (the pairing above).
   - **command `sent`/delivered** → execution → `cancelling`,
     `cancel_requested_at`, `cancelled_by`; `completed_at` stays NULL. Queue a
     `script_cancel`.
   - **command absent** → **fail closed** (500 / invariant alarm). Absence is
     not proof that nothing ran; it is an inconsistency.
4. `applyAutomationActionTerminal(...)` runs **only on a terminal branch**.
5. **Commit, then deliver.** `queueCommand` joins the caller's ambient
   transaction (`commandQueue.ts:636-653`) while the agent's ack lookup uses a
   fresh snapshot (`agentWs.ts:1647-1688`); a fast ack can land before commit
   and be routed as orphaned (`agentWs.ts:1722-1728`). The send must happen
   **after** the transaction commits — a small outbox/post-commit hook, not an
   in-transaction `sendCommandToAgent`.

**`POST /automations/runs/:runId/cancel`** — `automations:write` + `requireMfa()`
+ the partner and site gates above. See §5.

All callers delegate to one service, **`services/scriptCancellation.ts`**
(`cancelScriptExecution`, `cancelExecutionsForRun`), so the state machine has
exactly one implementation. The AI tool (`aiToolsScripts.ts`) uses the same
service at the same tier gate as `run_script`.

### 3. `device_commands` delivery to the agent

**The wire contract (this is the blocker fix).**

```
type:    'script_cancel'
payload: {
  executionId:  <device_commands.id of the ORIGINAL script command>,  // what the agent keys on
  scriptExecutionId: <script_executions.id>,                          // server correlation only
  graceSeconds: <int, clamped 0..30>
}
```

`executionId` keeps its legacy name and carries the **original command id**,
because that is what every deployed agent looks up
(`handlers_script.go:79-87` → `executor.go:222-229`). `scriptExecutionId` is
additive and ignored by current agents. Without this, cancel is a no-op fleet-wide.

Registration checklist — each of these is a separate list and each is easy to miss:

- `CommandTypes.SCRIPT_CANCEL = 'script_cancel'` (`services/commandQueue.ts`)
- `AUDITED_COMMANDS` (`commandQueue.ts:392-418`) — otherwise `queueCommand`
  writes **no** command-dispatch audit for it
- `REGISTRY_DISPATCHED_COMMAND_TYPES` (`routes/agents/commands.ts:87-96`) —
  otherwise the **HTTP-polling** agents never receive it
- result handler registration (`commandResultHandlers.ts:618-640`)
- **not** `SHORT_TIMEOUT_TYPES`. See the trap below.

**Timeout trap.** Putting `script_cancel` in the 5-minute short tier strands
offline executions: the generic reaper scans `pending` and `sent` commands
(`staleCommandReaper.ts:174-191`) and clocks `pending` rows from `createdAt`
(`:299-307`), so after 5 minutes it expires a cancel that was never delivered —
while the cancellation clock (which starts at *delivery*) has not started.
Give `script_cancel` a long queued expiry like `software_install`, and let the
dedicated cancellation sweep own the deadline.

**Dedup:** before queueing, check for a `pending|sent` `script_cancel` on the
same device carrying the same `executionId`.

**Never erase or delete the original `script` command row** — that is how
partial output survives.

### 4. Go agent — process-tree kill

All changes live in `agent/internal/executor`, so the user-helper inherits them.

**Four correctness blockers in the agent, ahead of any kill mechanics:**

1. **Cancellation can starve.** Every command goes through one worker pool
   (`heartbeat.go:5776-5790`), and `MaxConcurrentCommands` clamps to a floor of
   **1** (`config/validate.go:198-205`). A cancel then queues behind the very
   script it must stop. **Lifecycle commands need a bypass lane** — dispatch
   `script_cancel` (and its siblings in `LIFECYCLE_COMMAND_TYPES`) outside the
   pool, or give the pool a reserved slot for them.
2. **Cancel-before-registration.** `Execute` does validation, file write and
   `configureRunAs` *before* inserting into `e.running`
   (`executor.go:98-115, 222-230`), while WebSocket commands are concurrent
   (`websocket/client.go:497-510`). A cancel can return `notFound` and the
   script then starts anyway. Fix: **register the id in `e.running` (as a
   pre-start placeholder) before setup**, or keep a short-lived cancellation
   tombstone that `Execute` consults before starting.
3. **The ack is premature.** `Executor.Cancel` calls the context cancel func and
   immediately returns nil (`executor.go:281-298`); the async `cmd.Cancel`
   failure surfaces to the original `cmd.Run`, not to the cancel caller
   (`executor.go:203-209, 233-271`). A `cancelled: true` ack today proves
   neither termination nor even a successful kill *attempt*. **`Cancel` must
   block on a done/escalation channel** and report the real outcome
   (`terminated` / `kill_failed` / `not_found`), because that ack is what the
   server's `confirmed` flag is built on.
4. **`notFound` from the helper fan-out is not global.** `handleScriptCancel`
   returns on the first helper response marked `completed` without decoding
   whether it was a local miss (`handlers_script.go:284-305`), and an IPC
   reconnect builds a fresh `Client` with an empty executor while the old script
   goroutine may still be alive (`userhelper/client.go:103-112, 407-409`;
   `supervisor.go:130-148, 216-233`). `notFound` must mean "no helper and no
   local executor has it", and the helper IPC timeout (currently **10 s**,
   `handlers_script.go:289-292`) must exceed the maximum grace (30 s).

**Graceful escalation.** `Executor.Cancel(id, grace)`. The escalation runs
**inside `cmd.Cancel`** — `executor.go:288` is explicit that writing `cmd.Process`
while `Wait` runs is a race, and `os/exec` synchronises the `Cancel` callback.
**Correction from the first draft:** `WaitDelay` starts *after* the callback
returns, so a callback that does `SIGTERM → wait grace → SIGKILL` already
consumes the grace. Leave `WaitDelay` at 5 s as an independent post-callback
backstop; do **not** set it to `grace + 5s`.

| OS | Containment | Graceful | Hard kill |
|---|---|---|---|
| Linux | `Setpgid` + `Pdeathsig` (unchanged) | `kill(-pgid, SIGTERM)` | after grace, `kill(-pgid, SIGKILL)` |
| macOS / other Unix | `Setpgid` (unchanged) | `kill(-pgid, SIGTERM)` | after grace, `kill(-pgid, SIGKILL)` |
| Windows | **new: Job Object** | none (see below) | `TerminateJobObject` |

**Unix: capture the PGID once, at start.** Today `killProcessGroup` calls
`syscall.Getpgid(cmd.Process.Pid)` at kill time (`limits_linux.go:20-29`,
`limits_unix.go:19-28`). After SIGTERM the leader may already be gone, the
lookup fails, and the fallback kills a dead leader while surviving children keep
running. Store the pgid in `runningExecution` at `Start`.

**Windows Job Object.** `CreateJobObjectW` →
`SetInformationJobObject(JobObjectExtendedLimitInformation, KILL_ON_JOB_CLOSE)`
→ assign → `TerminateJobObject` on cancel; close the handle when `Wait` returns.
`KILL_ON_JOB_CLOSE` also gives Windows the `Pdeathsig` behaviour Linux has.
In-repo precedent: `agent/internal/pamlifetime/job_windows.go:111-165`
(`CreateSuspended` → `CreateJob` → `SetJobLimits` → `AssignProcess` → `Resume`).
The *ordering* question — suspended-create vs assign-after-`Start` — is
**Open Decision 4**, reversed from the first draft.

**`AssignProcessToJobObject` can be denied** when an enclosing session job
forbids breakaway — this repo already documents exactly that
(`sessionbroker/spawner_windows.go:274-287`), and it is the RDS case. The design
must **fail closed**: if containment could not be established, the execution is
flagged so a later cancel can never report `confirmed`. Silently degrading to
leader-only kill and then claiming confirmation is the original lie in a new place.

**No graceful phase on Windows.** `GenerateConsoleCtrlEvent` needs a shared
console and our children are `CREATE_NO_WINDOW`. Go straight to
`TerminateJobObject` and **say so** in the docs and the UI copy.

**`handleScriptCancel` result shape.** Today an unknown id returns
`tools.NewErrorResult`. Change to a success result carrying an explicit outcome:
`{ executionId, outcome: 'terminated' | 'not_found' | 'kill_failed', cancelled: bool }`.

### 5. Automation-run cancellation fan-out

- `automation_run_status` gains `cancelled`; `automation_device_result_status`
  gains `cancelled`; `automation_runs` gains `devices_cancelled` (OD6).
- `automation_action_results` already has `cancelled` +
  `terminal_source = 'cancellation'` — no enum change.

`cancelRun(runId, actor)`:

1. **Dispatch fence, not a boundary poll.** The dispatcher is *action-major*
   with a five-worker device pool plus a separately batched software-deployment
   path (`automationRuntime.ts:2110-2204`) — `:2500` only seeds result rows.
   A read-at-boundary check is TOCTOU: cancel marks the existing children
   cancelled, then a worker creates a new command row. The run status must act
   as an **atomic fence checked in the same transaction that creates a child
   row**, and both runners must check run status **before seeding/dispatching at
   all** (`:2425-2527`, `:2759-2809` currently don't — a queued job for an
   already-cancelled run still runs).
2. Fan out cancels for every `script_executions` row with
   `automation_run_id = :runId` in `('pending','queued','running')` via
   `cancelScriptExecution`. Keyed on `automation_run_id` **only** — never
   `eq(scriptExecutions.orgId, auth.orgId)`, which would silently no-op most of
   a partner-wide run (CLAUDE.md §Partner-Wide First, rule 5).
3. **Two action types cannot be reached this way.** `execute_command` actions
   deliberately create **no** `script_executions` row
   (`automationRuntime.ts:1296-1321`) and software deployments live in
   `deployment_results` (`:1984-2004`). Either cancel them by command id
   directly, or classify them as uninterruptible — and **the UI must not claim
   the run is stopped** while one is still live.
4. **Contradiction fixed.** The first draft said a `cancelling` script leaves its
   action non-terminal (§1) *and* that cancel marks all non-terminal actions
   cancelled (§5). Resolution: in-flight action rows stay non-terminal until
   their child closes; only *never-dispatched* actions are marked cancelled
   immediately. The run reaches `cancelled` when every child is terminal.
5. **Reconciliation must not downgrade.** `automationActionResults.ts:133-143`
   maps a cancelled action to device `failed`, and `:266-323` rewrites device
   rows before checking whether the run is terminal — so a late reconcile can
   downgrade a device-level `cancelled` even with a sticky run status. Both need
   cancellation-awareness. Emit an `automation.cancelled` event; today
   reconciliation publishes only completed/failed (`:333-347`).
6. **Log array clobber.** Both runners write the whole stale `logs` array
   (`automationRuntime.ts:2539, 2821`), so a concurrent completion can erase the
   cancellation log entry. Append atomically (`jsonb ||`) instead.

### 6. Audit

| Action | When | Notes |
|---|---|---|
| `script.execution.cancel` | operator hits cancel | **exists**, labelled at `routes/devices/events.ts:352`. Extend `details` with `{ commandId, deliveryMode, previousStatus }`. |
| `script.execution.cancel.unconfirmed` | grace give-up, expiry, or `kill_failed` | **new.** System context. The security-relevant one: we told an operator the script stopped and cannot prove it. |
| `automation.run.cancel` | operator cancels a run | **new.** `{ runId, automationId, ownerScope, executionsCancelled, uncancellableActions }`. |

Plus `CommandTypes.SCRIPT_CANCEL` in `AUDITED_COMMANDS` for the dispatch audit.
Every new action string must be added to the label map in
`routes/devices/events.ts` in the same PR.

### 7. Web UI

**Prerequisite fix (its own commit, no API dependency):** widen `ExecutionStatus`
to the full DB enum and add every key to **both** `statusConfig` maps; do the
same for `AutomationRunHistory.tsx`'s `StatusKey`. Also widen the shared
automation status type (`packages/shared/src/types/index.ts:431`) and the
OpenAPI schemas. Add a test that iterates each union and asserts every key
resolves — that is the regression guard for the crashes above.

| Surface | Affordance |
|---|---|
| `ExecutionHistory.tsx` row | "Stop" button on `pending\|queued\|running`; disabled spinner + "Stopping…" while `cancelling`. `data-testid="cancel-execution"`. |
| `ExecutionDetails.tsx` header | same, plus status copy: `cancelling` → *"Stop requested — waiting for the device to confirm."*; unconfirmed → *"Cancelled — the device never confirmed the process stopped."* |
| `AutomationRunHistory.tsx` | "Cancel run" on `running`; hidden when partner-owned and `!canManagePartnerWidePolicies`, with a tooltip explaining why. Must surface uncancellable `execute_command` / deployment actions. |

- All handlers wrap the request in **`runAction`** (CLAUDE.md).
- Lightweight confirm dialog; "Force stop" secondary action sends `graceSeconds: 0`.
- Gate on `scripts:execute` / `automations:write` — **hide**, don't disable.
- **`ScriptExecutionsPage.tsx` has no refresh loop** (`:56-75, 89-93, 140-143` —
  it fetches on mount and after an execution). A `cancelling` row would freeze on
  "Stopping…" forever. Add polling while any row is `cancelling` or `running`.
- New i18n keys in every locale (tr-TR parity is a real CI gate).

### 8. Race semantics

| Race | Resolution |
|---|---|
| Cancel after the execution is already terminal | **409** (today: 400 — a deliberate contract change; update OpenAPI + web handling). |
| Cancel while the original command is still `pending` | Command → `cancelled`, execution → cancelled-confirmed. Nothing ran; no agent round-trip. Requires holding the row lock and the `type='script'` predicate. |
| Original command row **absent** | **Fail closed** — invariant alarm, not a confirmed cancel. Absence ≠ proof nothing ran. |
| Original command already terminal, execution not | Recover the completion; do **not** queue a cancel. Reachable because ingestion terminalises the command before `handleScriptResult` (`agentWs.ts:1802-1837`). |
| **Script finishes naturally microseconds after the cancel request** | **Open Decision 9** — the two positions genuinely differ. Not resolved here. |
| Two operators cancel concurrently | Lock the execution; the second gets **200 idempotent** when the row is already `cancelling` or carries the same cancellation metadata. (The first draft contradicted itself, promising 409 in §2 and 200 here.) |
| Device offline at cancel time | Execution → `cancelling`; command queued and **remains deliverable after reconnect**. *Correction: losing the WS/HTTP connection does NOT kill the agent or its script* — the first draft's "the process died with the disconnect" was wrong. The grace clock starts on **delivery**, and the cancel command must not be expired by the generic 5-minute tier (§3). |
| Agent acks but the process ignores SIGKILL | `WaitDelay` closes pipes and lets `Wait` return; it **cannot** force a leader out of uninterruptible sleep and is **not** proof of termination. The agent must report `kill_failed` rather than a confirmed cancel. |
| Reaper's script deadline fires while `cancelling` | **Do NOT widen `reapStaleScriptExecutions`.** Its candidate predicate and terminal CAS correctly cover only `pending\|queued\|running` (`staleCommandReaper.ts:387-405, 468-480`). Add a **separate** cancellation sweep. *(Reversed from the first draft.)* |
| Closing the `script_cancel` command row | If a sweep stamps it `cancelled`, a late ack is rejected — `commandResultAcceptance.ts:42-77` only reopens `failed` commands carrying the server timeout marker. Close it with a marker the acceptance path will reopen. |
| Late original result after **any** cancellation terminalization | Accept it; fill `stdout`/`stderr`/`exit_code`. **Not** gated on `cancel_confirmed = false`. |
| `#3607` interaction | Do **not** just add `cancelling` to the existing accepted set. The first update maps straight to the real outcome (`commandResultHandlers.ts:357-386`) and the recovery branch only handles swept `timeout\|failed` rows with no output (`:393-434`). Cancellation needs its **own explicit CAS**, ordered before both. |
| Ack arrives before the cancel transaction commits | Prevented by post-commit delivery (§2.5). |
| Cancel a run whose devices are mid-dispatch | The atomic dispatch fence (§5.1) stops new child rows; already-dispatched devices get individual cancels. Bounded, not instant — and `execute_command` / deployment actions are not covered at all. |

### 9. Closers for `cancelling` — five, not two

1. **Original script result** (`commandResultHandlers`, own CAS, ordered first).
2. **`script_cancel` result** — `terminated` / `not_found` → confirmed;
   `kill_failed` → failed-to-cancel.
3. **Late-result recovery** after any cancellation terminalization.
4. **Delivery expiry / unsupported agent** → unconfirmed.
5. **Cancellation sweep** (new, in `jobs/staleCommandReaper.ts`, registered in
   the job table at `:1090`) — `cancelling` past `CANCEL_GRACE_MS` *measured
   from delivery* → unconfirmed + audit event, and close the cancel command with
   a reopenable marker.

---

## Tenancy & data model impact

**No new tables.** No new config/policy table, so *Partner-Wide First* is not
triggered — but the authorization split in §Users & scope and the
`automation_run_id`-keyed fan-out in §5.2 are exactly the partner concerns that
section exists to prevent.

| Object | Shape | Registration |
|---|---|---|
| `script_executions` **+4 columns** | Shape 1, direct `org_id`; auto-discovered. **No RLS policy change needed for new columns.** | Already in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:370-374`), `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts:205-237`), `CORE_DEVICE_CASCADE_DELETE_TABLES` (`core.ts:312-347`), `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts:333`). **⚠ The export-policy row fires on a new COLUMN.** All four columns classified in the same PR or `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts` redden main. All four → `included` (timestamps, tenant identifiers, a boolean, a command id; none is `json`/`jsonb`/`bytea`). |
| `automation_runs` **+enum value +`devices_cancelled`** | Shape 7 (parent-FK join through `automations` / `configuration_policies`; **no `org_id`**) | No cascade/export entry required. **But**: `automation_id` has a non-cascading FK and `config_policy_id` has no FK at all (`db/schema/automations.ts:106-120`), so org erasure can already fail or strand run logs. Adding cancellation data here means defining that parent-based erasure/export behaviour — see Open Decision 10. |
| `automation_device_result_status` **+enum value** | table is Shape 1 (device's org), already registered in all four lists | Enum-only; no new column, export policy untouched. |
| `automation_action_results` | Shape 1, composite FK | **No change.** |
| `device_commands` | intentionally system-scoped | No change; `queueCommand` owns the context. |

**Migration notes** (corrected from the first draft):

- **Three** enum values (`execution_status` gains `cancelling` and possibly
  `cancel_unconfirmed`/`cancel_failed` per OD8; `automation_run_status.cancelled`;
  `automation_device_result_status.cancelled`).
- Normal migrations are transaction-wrapped (`db/autoMigrate.ts:690-696`).
  Postgres **allows** `ALTER TYPE … ADD VALUE` inside that transaction; it only
  forbids *using* the new literal before commit. So: **one migration may add all
  enum values and all columns.** A second file is required **only if migration
  SQL writes those literals.** Splitting is safe and conventional but not
  mandatory. `-- @no-transaction` exists (`autoMigrate.ts:181-205, 670-689`) and
  is unnecessary here.
- Idempotent: `ADD VALUE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`. No inner
  `BEGIN;`/`COMMIT;`.
- **Naming:** the current head is **`2026-10-04-100003-portal-visibility-indexes.sql`**,
  well ahead of real time. New files must sort after the newest *committed*
  migration — check it at authoring time, do not derive it from today's date.
  Re-check against `origin/main` before push.

---

## Out of scope

- Generic cancel for non-script commands (software installs, patch jobs, backups
  each have their own stop path) — except where an automation run's own
  `execute_command` / deployment actions must be classified (§5.3).
- Cancelling a *scheduled* automation before it fires — that is disable/skip.
- Pause / resume of a run.
- Killing processes a script **deliberately detaches** (`nohup`, `systemd-run`,
  a scheduled task the script registers). Job Object + process group cover the
  ordinary tree; the docs must say what we do not promise.
- Remote-desktop / terminal sessions (already in `EXCLUDED_COMMAND_TYPES`).
- Retroactively reconciling historical `cancelled` rows written by the old
  bookkeeping-only route — they keep `cancel_confirmed IS NULL` = "legacy, unknown".
- Batch-level cancel — moved out of scope by Open Decision 5.

---

## Open Decisions

**1. How much new column surface on `script_executions`?**
- **A — four columns** (`cancel_requested_at`, `cancelled_by`, `cancel_confirmed`,
  `cancel_command_id`): pro — the honest/dishonest distinction is queryable and
  testable; the closers can find the cancel command. Con — four export-policy
  classifications.
- **B — one column** (`cancel_requested_at`), actor from audit, confirmation
  derived from `exit_code IS NOT NULL`: pro — minimal. Con — `exit_code IS NOT NULL`
  is not "the agent confirmed" (a `not_found` ack has no exit code), so the UI
  could not distinguish a proven stop from a give-up — exactly the lie being removed.
- **C — zero columns**, encode in `error_message`: unparseable, untestable.

**Recommend A.** *Quorum: agreed, with two riders — `cancel_confirmed` is better
as an enum (see OD8), and `cancelled_by` must not be a bare `users` FK because
the AI-agent actor id is not a user id.*

**2. Grace period before SIGKILL, and where it is configured.**
- **A — fixed 5 s** agent-side constant. Con — a script mid-copy of 4 GB gets 5 s.
- **B — 5 s default, per-request `graceSeconds` clamped 0–30 s**: pro — a "Force
  stop" affordance falls out for free. Con — one more wire field.
- **C — per-script setting**: the canceller is the one in a hurry, not the author.

**Recommend B**, clamped and defaulted. *Quorum: agreed, conditional on the
agent synchronising the grace correctly and on **every** downstream deadline
exceeding the max grace — notably the helper IPC timeout, currently 10 s.*

**3. `cancel_confirmed = false` — how loud?**
- **A — row field + audit event + a metrics counter** (no paging).
- **B — also raise a device alert**: noisy; every device that stays offline past
  the grace window would fire one.
- **C — also `captureException` to Sentry**: it is an operational condition, not
  a code defect.

**Recommend A**, revisit B once a baseline rate exists. *Quorum: agreed.*

**4. Windows: `CREATE_SUSPENDED` + assign + resume, or assign after `cmd.Start()`?**
- **A — assign after `Start()`** (first-draft recommendation): pro — stays inside
  `os/exec`, small diff. Con — the quorum showed the window is not merely "a
  grandchild spawns in microseconds": it also covers **timeout, cancellation,
  leader exit and child creation** occurring before assignment, and on RDS
  `AssignProcessToJobObject` can be **denied outright**
  (`sessionbroker/spawner_windows.go:274-287`). None of those can support a
  truthful `confirmed` contract.
- **B — `CREATE_SUSPENDED` → `AssignProcessToJobObject` → `ResumeThread`**: pro —
  the only ordering that makes containment an invariant; in-repo precedent at
  `pamlifetime/job_windows.go:111-165`. Con — `os/exec` does not expose the
  primary thread handle, so this needs either thread enumeration or a launch
  path outside `os/exec` — and the pamlifetime precedent achieves it via a
  dedicated helper (`pamactuator.LaunchSuspendedV2`), i.e. closer to option C
  than to a two-line `os/exec` tweak. Forfeiting `os/exec`'s `Wait`/pipe/`Cancel`
  synchronisation is exactly what `executor.go`'s comments warn against.
- **C — a small launcher shim** the agent ships that does suspended-create and
  hands back a job handle: pro — airtight without abandoning `os/exec` semantics
  for the script itself. Con — a new signed binary on every endpoint.

**Recommendation REVISED to B** (the first draft said A; the quorum's argument
plus the RDS denial case is decisive — A cannot honestly report `confirmed`).
**The residual disagreement is about cost, not direction:** the quorum treats B
as a drop-in given the pamlifetime precedent; that precedent uses a helper
process, so B may in practice be C. **This needs Todd's call on appetite** — B/C
is a meaningfully larger agent change than A. If A is chosen for scheduling
reasons, containment must be flagged best-effort and cancel must **never** report
`confirmed` on Windows.

**5. Batch cancel — in scope or not?**
- **A — include it** (first-draft recommendation, on the belief it was ~30 lines).
- **B — defer.** The quorum falsified the cost estimate: `script_executions` has
  **no `batch_id` column** (`db/schema/scripts.ts:121-151` — `batchId` exists only
  in the dispatch *payload*), and `script_execution_batches` has no cancelled
  counter (`:153-171`). Batch cancel therefore needs a new correlation column
  (→ another export-policy classification) plus counter accounting.

**Recommendation REVISED to B** — defer to a follow-up issue that lands the
`batch_id` correlation first. *Quorum: agreed.* Noted cost: an operator with a
misbehaving 500-device batch still has to cancel row by row until that ships.

**6. What does `cancelled` mean for automation-run counters?**
- **A — neither succeeded nor failed**; add `devices_cancelled` to
  `automation_runs`. Pro — honest; no `org_id` on that table so no export-policy
  cost. Con — a migration.
- **B — count as `failed`**: poisons automation health reporting and any alerting
  keyed on `devicesFailed`.
- **C — `skipped`**: overloads a value that already means "filtered out of the
  target set", and the counters would silently stop summing to `devicesTargeted`.

**Recommend A.** *Quorum: agreed, and reconciliation must be made
cancellation-aware or it will downgrade device-level `cancelled` to `failed`
(`automationActionResults.ts:133-143, 266-323`).*

**7. May an org-scoped operator cancel a partner-wide run?**
- **A — no.** They may cancel individual executions on their own devices; the run
  requires `canManagePartnerWidePolicies`. Con — an org tech watching a bad
  partner-wide run has to cancel device by device.
- **B — yes, scoped to their org's slice.** Introduces a "partially cancelled
  run" semantic with no precedent, and a run that reports `completed` while one
  tenant's slice was cancelled.

**Recommend A**, with an explanatory tooltip. *Quorum: agreed, and adds that
**site scope** must also be enforced for org-owned runs — a site-restricted user
must not stop a run spanning sibling sites (`routes/automations.ts:249-275`).*

**8. NEW — how is "we asked but cannot prove it" represented?** *(quorum-raised)*
- **A — `status = 'cancelled'` + `cancel_confirmed = false`** (first-draft model):
  pro — one terminal status, simplest for existing readers, filters keep working.
  Con — the status field, which is what every downstream reader and export
  actually looks at, asserts the script stopped precisely when we cannot
  establish that. Every consumer must remember to check a second column.
- **B — distinct terminal statuses** (`cancelled`, `cancel_unconfirmed`,
  `cancel_failed`): pro — the status alone is truthful; impossible to misread.
  Con — three new enum values; every status map, filter, chart and export
  classification widens; more churn in the web/shared/OpenAPI plumbing.
- **C — separate cancellation-lifecycle column** (`none|requested|confirmed|
  unconfirmed|failed`) orthogonal to the execution outcome: pro — cleanly
  separates "what happened to the process" from "what happened to the cancel
  request"; composes well with OD9-A. Con — two fields to reason about; the
  richest model and the most to get wrong.

**Recommend C**, and it composes with OD9-A. **Genuine disagreement:** the
first draft chose A; the quorum rejected A as self-contradictory and proposed
B or C. This is the most consequential unresolved item — it determines the
shape of every status map in the product.

**9. NEW — what status when the script completes naturally right after a cancel request?** *(quorum-raised)*
- **A — preserve the real outcome** (`completed`/`failed`/`timeout`) and record
  only `cancel_requested_at` for the losing request: pro — batch and automation
  success statistics stay true; a script that succeeded is not reported as
  cancelled. Con — the operator pressed Cancel and sees "Completed", which reads
  as the button having failed unless the UI explains it.
- **B — force `cancelled`** (first-draft position): pro — the operator's intent
  is honoured in what they see. Con — falsifies outcome statistics, and we cannot
  actually tell the two apart: current executor results carry no cancellation
  termination reason (`executor.go:257-271`), so "cancelled" would be a guess.
- **C — A, plus surface the losing cancel in the UI** ("Completed — your stop
  request arrived too late").

**Recommend C.** **Genuine disagreement:** the first draft argued for B on the
grounds that the operator's intent is the honest label; the quorum's
counter — that we have no signal distinguishing "killed by us" from "finished on
its own", so B fabricates causality — is stronger, and it is also an argument
*for* eventually adding a termination reason to the agent result. C is the
compromise; **A vs C is a UI-copy decision, B vs (A/C) is the real fork.**

**10. NEW — are config-policy runs in scope?** *(quorum-raised)*
- **A — in scope, fix the RLS first.** `automation_runs`'s config-policy arm is
  reachable only via `breeze_has_org_access(cp.org_id)`
  (`migrations/2026-07-02-…:97-149`), so partner-owned policy runs are invisible
  today. Cancelling them means correcting that policy — a tenancy change with its
  own blast radius. Also `automation_id`'s FK is non-cascading and
  `config_policy_id` has no FK, so org erasure behaviour there is already unclear.
- **B — out of scope for now**; cancel only automation-owned runs, and file the
  RLS gap separately.

**Recommend B** — the RLS correction is a tenancy change that deserves its own
review, and bundling it into a cancel feature is how tenancy bugs ship. *Quorum
raised the gap; it did not take a position on scoping.*

---

## Test & rollout notes

**Go (`go test -race ./...`)**
- Escalation ladder: SIGTERM observed, then SIGKILL after grace; `graceSeconds: 0`
  skips straight to kill; `WaitDelay` remains an independent backstop.
- **Process-tree test per OS**: script → child → grandchild writing a heartbeat
  file; cancel; assert the grandchild is gone. `runtime.GOOS`-guarded.
- Windows Job Object **contract test** in the shape of
  `pamlifetime/job_contract_test.go` (call-order assertion against a fake), plus
  an **assignment-denied** case asserting fail-closed.
- **Cancel-before-registration**: cancel racing `Execute`'s setup must not let
  the script start.
- **Pool saturation**: `MaxConcurrentCommands = 1` + a long script; a cancel must
  still be serviced.
- **`Cancel` blocks** and returns the real outcome (`terminated` / `kill_failed`
  / `not_found`).
- **IPC reconnect** during a `runAs=user` script: `not_found` must not be
  reported while a helper still owns the process.
- **⚠ CI gap:** the Windows job uses an explicit package list that currently
  omits `internal/executor` and `internal/heartbeat`
  (`.github/workflows/ci.yml:1269-1293, 1323-1327`). **These tests will not run
  on Windows until that list is extended** — do that in the same PR or the
  Windows kill path ships untested.

**API unit (Vitest, Drizzle mocks)**
- Cancel-route matrix: every starting execution status × command status →
  resulting state, `confirmed`, and whether a cancel was queued. Includes the
  absent-command fail-closed case and the terminal-command recovery case.
- **Wire contract test:** the queued `script_cancel` payload's `executionId`
  equals the original **`device_commands.id`**, not `script_executions.id`.
  This is the regression guard for the blocker.
- `commandResultHandlers`: cancellation CAS ordered before the `#3607` branch;
  late original result after a **confirmed** cancel still recovers output.
- Cancellation sweep: unconfirmed past grace; grace measured from delivery;
  the existing `reapStaleScriptExecutions` **unchanged**.
- Cancel-command expiry does not strand the execution.
- Idempotency: second concurrent cancel → 200, one command row.
- Registration greps: `SCRIPT_CANCEL` present in `CommandTypes`,
  `AUDITED_COMMANDS`, `REGISTRY_DISPATCHED_COMMAND_TYPES`, the result registry.

**Integration (real Postgres — these catch the registration misses)**
- `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip` —
  fail until the four new columns are classified. **Run locally before PR.**
- `tenantCascade.integration.test.ts`, `rls-coverage.integration.test.ts` —
  no shape change expected; run anyway.
- New `scriptCancellationPartnerRls.integration.test.ts`: org token cancelling a
  partner-wide run → 403; partner token → 200 with fan-out reaching devices in
  **two** orgs; site-restricted user → 403; cross-tenant cancel → 404/403.
- Automation dispatch fence: cancel a run mid-dispatch and assert **zero** new
  child rows are created after the fence commits.
- Migration replay twice → no-op.

**Web (Vitest + jsdom)**
- Iterate each status union and assert every value resolves in
  `ExecutionHistory`, `ExecutionDetails` and `AutomationRunHistory` — the
  regression test for the two live crashes.
- Cancel affordance visibility per status and per permission.
- `runAction` failure path: 409 toasts, no silent no-op.

**E2E (Playwright, `data-testid` only)**
- 120 s sleep script → Cancel → "Stopping…" → "Cancelled" within the grace window.

**Rollout**
- **No server-side feature flag** — cancel is a de-escalation. Backward
  compatibility with the deployed fleet holds **only because** the cancel carries
  the original command id (§3); the agent handler has been in the field since
  2026‑02‑07 (`6a1689e499`). *Verify the oldest supported agent band before
  merge; an older band returns "unknown command" and the sweep correctly records
  unconfirmed — degraded but honest.*
- **The Windows containment change is agent-shipped code.** Canary a small band
  before fleet promote. Watch for scripts that legitimately spawn detached
  children and now die with the parent — this is a **behaviour change on the
  timeout path too**, and it is the one thing here that could break a working
  customer script.
- `CANCEL_GRACE_MS` ships env-tunable.
- Docs: update `apps/docs/src/content/docs/agents/commands.mdx` (`script_cancel`
  gains `graceSeconds` and `scriptExecutionId`; the `executionId` = command-id
  semantics must be written down; Windows has no graceful phase), and add an
  operator page "Stopping a running script".

**Suggested wave split** (`effort:l` — do not land as one PR)

| Wave | Content |
|---|---|
| W01 | Status-union + `statusConfig` widening across web/shared/OpenAPI + regression tests. Fixes two live crashes, ships alone. |
| W02 | Migrations (enums + columns), export-policy classification, `cancelling`, `CommandTypes.SCRIPT_CANCEL` + all four registration lists, `services/scriptCancellation.ts`, rewritten route with post-commit delivery. **Depends on OD8 + OD9.** |
| W03 | The five closers: result-handler CAS, cancellation sweep, expiry, late-result recovery, audit events. |
| W04 | Go agent: bypass lane, pre-start registration, blocking `Cancel` with real outcomes, PGID capture, grace escalation, Windows Job Object (**OD4**), helper `not_found` correctness + IPC timeout, Windows CI package list. Canary before promote. |
| W05 | Automation run cancel: dispatch fence, fan-out, reconciliation/`devices_cancelled`, log append, `automation.cancelled` event, uncancellable-action classification. |
| W06 | Web UI affordances, polling, i18n, E2E. |
