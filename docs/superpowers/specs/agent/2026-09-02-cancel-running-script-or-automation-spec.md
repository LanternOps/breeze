---
issue: LanternOps/breeze#3525
status: draft
author: Claude (Opus 5) + Codex gpt-5.6-sol advisor quorum
date: 2026-09-02
area: scripts / automations / agent
---

# Cancel a running script or automation — design spec

**Issue:** [#3525](https://github.com/LanternOps/breeze/issues/3525) (p1, `category:scripts`, `effort:l`)
Reported by @tim104979 in discussion #2598; operator-side half of #3445.

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
| API route | absent | `POST /scripts/executions/:id/cancel` — `apps/api/src/routes/scripts.ts:1175`. `requireMfa()`, `scripts:execute`, org + site access checks, CAS on status, `applyAutomationActionTerminal`, audit `script.execution.cancel`. |
| OpenAPI | — | documented, `operationId: cancelScriptExecution` (`apps/api/src/openapi.ts:2691`) |
| Agent command | "needs new plumbing?" | `script_cancel` + `script_list_running` exist (`agent/internal/remote/tools/types.go:154`), handled at `agent/internal/heartbeat/handlers_script.go:277`, forwarded over IPC to the user-helper for `runAs=user` scripts (`agent/internal/userhelper/client.go:712`). Publicly documented (`apps/docs/src/content/docs/agents/commands.mdx:503`). |
| Agent kill handle | "not established" | `Executor.Cancel(executionID)` — `agent/internal/executor/executor.go:283`. Holds `cmd` + `context.CancelFunc` per execution in `e.running`; cancel triggers `cmd.Cancel` → `killProcessGroup`. |
| Trust gating | — | `script_cancel` is already in `LIFECYCLE_COMMAND_TYPES` (`apps/api/src/services/partnerTrust.ts:42`), so a probationed partner can still stop a script. Correct: cancel is a de‑escalation. |

So this is **not** "build cancel". It is **"the cancel we shipped is the UI that
lies the issue warned about, and nothing on the server has ever sent the agent
command that already exists."**

### The five real defects

1. **Bookkeeping-only cancel.** The route stamps `script_executions.status =
   'cancelled'` immediately, then cancels device commands `WHERE status =
   'pending'` only (`routes/scripts.ts:1248-1263`). A command already `sent` —
   i.e. *the running case, the entire point of the issue* — is untouched. The
   script keeps executing on the endpoint while the UI says "Cancelled".
   `apps/api/src/services/commandResultHandlers.ts` already documents this as a
   known benign race and **deliberately drops the agent's real output** when it
   arrives. That comment is the design bug written down.
2. **Nothing queues `script_cancel`.** `CommandTypes` in
   `apps/api/src/services/commandQueue.ts` has `SCRIPT: 'script'` and no
   `SCRIPT_CANCEL`. The agent handler and the public docs describe a command the
   server has never sent.
3. **Windows kills only the shell leader.** `agent/internal/executor/limits_windows.go`:
   `setProcessGroup` is an explicit no-op ("Job Objects … deferred to a future
   enhancement") and `killProcessGroup` calls `cmd.Process.Kill()`. A
   PowerShell script that starts `msiexec`, `robocopy`, or any child leaves that
   child alive. **This is already true for the timeout path today**, so fixing it
   fixes both. Unix is fine (`setpgid` + `kill(-pgid)`).
4. **No graceful stop.** Unix goes straight to `SIGKILL` on the process group.
   A script mid-transaction gets no chance to unmount, release a lock, or clean
   a temp dir.
5. **Automations have no cancel at all.** `automation_run_status` is
   `running|completed|failed|partial` — no `cancelled`. No route. No cooperative
   check in `executeAutomationRunInner`'s per-device loop
   (`apps/api/src/services/automationRuntime.ts:2500`).

### Bonus: a live UI crash, already reachable

`apps/web/src/components/scripts/ExecutionHistory.tsx:7` types
`ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout'`
and `statusConfig` (line 33) has exactly those five keys.
`ExecutionDetails.tsx:15` re-uses the same union. Both index it **unguarded**:
`statusConfig[execution.status].color` (`ExecutionHistory.tsx:303`),
`statusConfig[execution.status].icon` (`ExecutionDetails.tsx:171`).

The DB enum is `pending|queued|running|completed|failed|timeout|cancelled`.
`queued` and `cancelled` are both real, reachable values (the existing cancel
route writes `cancelled`; `scriptDispatch` writes `queued`). Either renders
`undefined.color` → TypeError. *(Verified by code read; not reproduced in a
browser.)* Fixing the union is a prerequisite of this work, not a nice-to-have.

---

## Users & scope

**Primary user:** an MSP technician or engineer watching a script or automation
run go wrong on a customer endpoint, who wants it stopped **now**.

**Partner vs org — the load-bearing distinction.**

| Object | Owner axis | Who may cancel |
|---|---|---|
| `script_executions` row | Shape 1, direct `org_id` (the **device's** org) | Anyone with `scripts:execute` + org access + site access to that device. Partner-scope tokens reach it through `breeze_has_partner_access` on the org. Unchanged from today. |
| `script_execution_batches` | direct `org_id` | same, per batch |
| `automation_runs` for an **org-owned** automation (`automations.org_id` set) | run inherits the automation's org | `automations:write` + org access |
| `automation_runs` for a **partner-wide** automation (`automations.org_id IS NULL`, `partner_id` set — #2133/#2135) | partner | **`canManagePartnerWidePolicies(auth)` required.** An org-scoped operator must NOT be able to cancel a partner-wide run: it fans out across sibling tenants' devices. |

The asymmetry is deliberate and must be stated in the UI: an org tech **can**
cancel each individual `script_executions` row on **their own** devices that a
partner-wide run produced (those rows carry the device's org), but **cannot**
stop the run itself. This is the same "worker-created child rows take the
DEVICE's org" rule the repo already applies to `automation_action_results` and
`automation_run_device_results`.

**In scope:** single script execution, script execution batch, automation run
(manual, scheduled, event, webhook, config-policy-driven), the agent-side kill
on Windows/macOS/Linux including `runAs=user` helper executions, audit, web UI,
race semantics.

---

## Proposed design

### 1. State machine

`script_executions.status` gains one value: **`cancelling`**.

```
                      ┌──────────── cancel, command still `pending` ─────────────┐
                      │              (provably nothing ran)                       │
                      ▼                                                           │
  pending ──▶ queued ──▶ running                                              cancelled
     │           │          │                                              (confirmed=true)
     └───────────┴──────────┴──── cancel, command already `sent` ──▶ cancelling ──┐
                                                                        │         │
       agent result arrives (any outcome) ──────────────────────────────┘         │
       agent acks {cancelled:true} ─────────────────────────────────────┘         │
       agent acks {notFound:true} ──────────────────────────────────────┘         ▼
       grace deadline, no ack ─────────────────────────────────────────────▶ cancelled
                                                                          (confirmed=false)
```

**The contract, in one line:** `cancelled` means *we believe nothing is running
on the endpoint*; `cancelling` means *we asked, and we cannot yet prove it
stopped*. The UI must never render `cancelling` as "Cancelled".

`cancelling` is **non-terminal**: it does not increment batch counters, does not
close the automation action result, and is not exported as an outcome.

New columns on `script_executions`:

| Column | Type | Meaning |
|---|---|---|
| `cancel_requested_at` | `timestamptz` | when the operator asked |
| `cancelled_by` | `uuid REFERENCES users(id)` | NULL = system (run fan-out, reaper) |
| `cancel_confirmed` | `boolean` | NULL while `cancelling`; `true` if the agent acked or any result landed; `false` if we gave up at the grace deadline |

`cancel_confirmed = false` is the honest "we told you it stopped and cannot
prove it" marker. It is what makes the UI able to stop lying.

### 2. API

**`POST /scripts/executions/:id/cancel`** (existing route, rewritten body).
Unchanged guards: `requireScope('organization','partner','system')`,
`scripts:execute`, `requireMfa()`, org + site access. New behaviour, one
transaction:

1. Load the execution **and its paired `device_commands` row**
   (`payload->>'executionId' = :id`, `type = 'script'`) `FOR UPDATE`.
2. CAS the execution from `('pending','queued','running')`. No match → **409**
   `Execution is no longer cancellable` (existing behaviour, keep it).
3. Branch on the command row:
   - **command `pending` or absent** → command CAS to `cancelled` (+
     `terminalPayloadErasureSet()`, as today); execution → `cancelled`,
     `cancel_confirmed = true`, `completed_at = now()`. Nothing ever ran.
     Response `{ success: true, execution: { status: 'cancelled' } }`.
   - **command `sent`/delivered** → execution → `cancelling`,
     `cancel_requested_at = now()`, `cancelled_by = auth.user.id`,
     `completed_at` **stays NULL**. Queue a `script_cancel` command. Response
     `{ success: true, execution: { status: 'cancelling' } }`.
4. `applyAutomationActionTerminal(...)` is called **only on the terminal
   branch**. On the `cancelling` branch the action result stays non-terminal
   until the execution actually terminalises — otherwise the automation run
   reconciles as finished while a process is still live.

**`POST /scripts/batches/:id/cancel`** — fan out over every
`script_executions` row in the batch that is non-terminal, reusing the service
below. Returns per-row counts.

**`POST /automations/runs/:runId/cancel`** — `automations:write` + `requireMfa()`
+ the partner gate above. See §5.

**`POST /automations/policy-runs/:runId/cancel`** — the config-policy run
equivalent (`createConfigPolicyAutomationRun` /
`executeConfigPolicyAutomationRun`), same service.

All of the above delegate to one service, **`services/scriptCancellation.ts`**,
exporting `cancelScriptExecution(executionId, actor)` and
`cancelExecutionsForRun(runId, actor)`. Every caller (route, batch, run
fan-out, AI tool) goes through it so the state machine has exactly one
implementation. `aiToolsScripts.ts` gets a `cancel_script_execution` tool
wired to the same service, at the same tier gating as `run_script`.

### 3. `device_commands` delivery to the agent

- Add `SCRIPT_CANCEL: 'script_cancel'` to `CommandTypes`
  (`services/commandQueue.ts`). Payload: `{ executionId, graceSeconds }`.
- Queue via the normal `queueCommand(deviceId, 'script_cancel', payload,
  actorUserId)` path — `device_commands` is intentionally system-scoped
  (CLAUDE.md), and `queueCommand` already owns that context, the audit write,
  and the trust chokepoint. `script_cancel` is already allowlisted in
  `LIFECYCLE_COMMAND_TYPES`, so it survives partner probation.
- Immediately attempt `sendCommandToAgent(device.agentId, frame)` when the
  device is online, mirroring `scriptDispatch.ts:591`. Offline → the row stays
  `pending` and delivers on reconnect.
- **Timeout tier:** `script_cancel` is a short command. Add it to
  `SHORT_TIMEOUT_TYPES` in `commandTimeouts.ts` (5 min).
- **Dedup:** before queueing, `SELECT ... WHERE device_id = :d AND type =
  'script_cancel' AND status IN ('pending','sent') AND payload->>'executionId'
  = :id`. Two operators hitting Cancel must not produce two commands.
- **Never erase or delete the original `script` command row.** Let its own
  result path close it; that is how partial output survives.

### 4. Go agent — process-tree kill

All changes are in `agent/internal/executor`, so the user-helper
(`runAs=user`) inherits them for free — it runs the same `Executor`.

**Graceful escalation.** `Executor.Cancel(id)` becomes
`Cancel(id, grace time.Duration)`. The escalation runs **inside `cmd.Cancel`**,
not from a separate goroutine: the existing comment on `executor.go:288` is
explicit that writing to `cmd.Process` while `Wait` is running is a race, and
`os/exec` synchronises the `Cancel` callback for us. `cmd.WaitDelay` stays 5 s
as the pipe-closing backstop, and must be raised to `grace + 5s` so it does not
fire during the grace window.

| OS | Containment | Graceful phase | Hard kill |
|---|---|---|---|
| Linux | `Setpgid` + `Pdeathsig: SIGKILL` (unchanged) | `kill(-pgid, SIGTERM)` | after `grace`, `kill(-pgid, SIGKILL)` |
| macOS / other Unix | `Setpgid` (unchanged) | `kill(-pgid, SIGTERM)` | after `grace`, `kill(-pgid, SIGKILL)` |
| Windows | **new: Job Object** | **none — see below** | `TerminateJobObject(job, 1)` |

**Windows Job Object.** Replace the no-op `setProcessGroup` with
`setProcessContainment(cmd)`:

1. `CreateJobObjectW(nil, nil)` (anonymous).
2. `SetInformationJobObject(job, JobObjectExtendedLimitInformation, {LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE})` — the whole tree dies if the agent
   itself dies, matching Linux's `Pdeathsig`.
3. Start the child with `CREATE_SUSPENDED | CREATE_NO_WINDOW` (the existing
   `hideWindow` flag is preserved).
4. `AssignProcessToJobObject(job, hProcess)`, then `ResumeThread(hThread)`.
5. `killProcessGroup` → `TerminateJobObject`. Close the job handle when `Wait`
   returns.

There is **in-repo precedent to copy**: `agent/internal/pamlifetime` already
does `CreateJobObjectW` → `SetInformationJobObject(KILL_ON_JOB_CLOSE)` →
`AssignProcessToJobObject` → `TerminateJobObject`, with a contract test
(`job_contract_test.go`) asserting the call order. Reuse the pattern and the
test shape.

*Getting the suspended handle:* `os/exec` does not expose the primary thread
handle. Either set `SysProcAttr.CreationFlags |= CREATE_SUSPENDED` and recover
the thread via `Thread32First` on the process, or drop to
`windows.CreateProcess` for the script path. **Recommend the narrower option:**
assign to the job **after** `cmd.Start()` without `CREATE_SUSPENDED`, accepting
a microseconds-wide window in which a grandchild could be spawned outside the
job. Nested jobs (Windows 8+) mean a child that creates its own job still stays
in ours. Full `CREATE_SUSPENDED` correctness is Open Decision 4.

**No graceful phase on Windows.** `GenerateConsoleCtrlEvent` requires a shared
console, and our children are `CREATE_NO_WINDOW`. Rather than fake parity we go
straight to `TerminateJobObject` and **say so in the docs and the UI copy**.

**`handleScriptCancel` result shape.** Today, cancelling an execution the agent
no longer has returns `tools.NewErrorResult` — the server would read a real
"already finished" as a failed cancel. Change it to a **success** result:
`{ executionId, cancelled: false, notFound: true }`. The server treats
`notFound` as proof nothing is running → terminalise `cancelled`,
`cancel_confirmed = true`.

`Cancel` stays idempotent; concurrent cancels of the same id collapse.

### 5. Automation-run cancellation fan-out

- `automation_run_status` gains `cancelled`.
- `automation_device_result_status` gains `cancelled` (it currently has
  `pending|running|success|failed|skipped`; `skipped` already means "filtered
  out of the target set" and must not be overloaded).
- `automation_action_results` **already** has `cancelled` +
  `terminal_source = 'cancellation'`, and `applyAutomationActionTerminal` is
  already wired from the script cancel route. No enum change needed there.

`cancelRun(runId, actor)`:

1. CAS `automation_runs` `running → cancelled`, `completed_at = now()`, append
   a log entry. 409 if already terminal.
2. **Stop dispatching.** `executeAutomationRunInner`'s device loop
   (`automationRuntime.ts:2500`) and `executeAutomationActionsInOrder`'s worker
   pool re-read the run status at each **device boundary** and each **action
   boundary** and break out. **This is cooperative and bounded, not
   instantaneous** — an in-flight `await` on one device cannot be interrupted;
   the loop stops at the next boundary. State this in the UI copy and the docs;
   do not claim otherwise.
3. **Fan out `script_cancel`** for every `script_executions` row with
   `automation_run_id = :runId` and status in `('pending','queued','running')`,
   via `cancelScriptExecution`. Partner-wide runs span orgs, so the query is
   keyed on `automation_run_id` only — **never** `eq(scriptExecutions.orgId,
   auth.orgId)`, which would silently no-op most of a partner-wide run
   (CLAUDE.md §Partner-Wide First, rule 5).
4. Mark every non-terminal `automation_action_results` row `cancelled` /
   `terminal_source = 'cancellation'`; mark `automation_run_device_results`
   rows `cancelled` where `pending`/`running`.
5. `reconcileAutomationRun` learns `cancelled` and **must not downgrade it** to
   `partial`/`failed` when late child results arrive. `cancelled` is sticky.

### 6. Audit

| Action | When | Notes |
|---|---|---|
| `script.execution.cancel` | operator hits cancel | **already exists**, already labelled in `routes/devices/events.ts:352`. Extend `details` with `{ commandId, deliveryMode: 'command-cancelled' \| 'agent-requested', previousStatus }`. |
| `script.execution.cancel.unconfirmed` | reaper gives up at the grace deadline | **new.** Written under a system context by the reaper. This is the security-relevant event: we told an operator the script stopped and cannot prove it. |
| `automation.run.cancel` | operator cancels a run | **new.** `details: { runId, automationId, ownerScope: 'organization'\|'partner', executionsCancelled, devicesAffected }`. |
| `script.batch.cancel` | operator cancels a batch | **new.** |

Every new action string must be added to the label map in
`apps/api/src/routes/devices/events.ts` in the same PR — mechanical, and the
kind of registration that gets missed.

### 7. Web UI

**Prerequisite fix (its own commit):** widen `ExecutionStatus` to the full DB
enum (`pending|queued|running|cancelling|completed|failed|timeout|cancelled`)
and add every key to both `statusConfig` maps. This closes the latent
`undefined.color` / `undefined.icon` crash for `queued` and `cancelled` rows.
Add a unit test that iterates the union and asserts every key resolves.

| Surface | Affordance |
|---|---|
| `ExecutionHistory.tsx` row | `Square` ("Stop") icon button on `pending\|queued\|running`. While `cancelling`: disabled spinner + "Stopping…". `data-testid="cancel-execution"`. |
| `ExecutionDetails.tsx` header | same button; the status banner gets `cancelling` copy: *"Stop requested — waiting for the device to confirm."* and `cancelled` + `cancel_confirmed === false` copy: *"Cancelled — the device never confirmed the process stopped."* |
| `AutomationRunHistory.tsx` | "Cancel run" on `run.status === 'running'`. Hidden entirely when the run's automation is partner-owned and `!canManagePartnerWidePolicies`. |
| Batch view | "Cancel remaining" |

- All handlers wrap the request in **`runAction`** (`apps/web/src/lib/runAction.ts`),
  per CLAUDE.md — the endpoints return `{success:true}` and a 409 must toast.
- Lightweight confirm dialog (this stops work on a customer endpoint); not a
  typed-name modal.
- Gate on `scripts:execute` / `automations:write` — **hide**, don't disable.
- Polling: the existing refresh loop keys on `running`; it must also keep
  polling while `cancelling`, or the row freezes on "Stopping…" forever.
- New i18n keys in every locale (the tr-TR parity check is a real CI gate).

### 8. Race semantics

| Race | Resolution |
|---|---|
| Cancel after the execution is already terminal | 409 `Execution is no longer cancellable`. No command queued. (Existing CAS already yields this.) |
| Cancel while the command is still `pending` | Command → `cancelled`, execution → `cancelled`, `cancel_confirmed = true`. Nothing ever ran; no agent round-trip. |
| Cancel, and the agent finishes microseconds later | Execution → `cancelling`; the real result lands, terminalises to **`cancelled`** with the true `exit_code`, `stdout`, `stderr` preserved and `cancel_confirmed = true`. **Do not resurrect `completed`** — the operator asked for it to stop and it is stopped; `cancelled` is the honest label, and the output is still there to read. This reverses today's deliberate output drop in `commandResultHandlers.ts`. |
| Two operators cancel concurrently | Execution CAS makes the second a no-op; the `pending\|sent` dedup suppresses the duplicate command. Both get 200 with the current state. |
| Device offline when cancel is requested | Execution → `cancelling`, command queued `pending`. **The grace clock starts on command DELIVERY, not on request** — otherwise every offline device produces a false `cancel_confirmed = false`. On reconnect the agent finds nothing running (the process died with the disconnect) → `notFound` → `cancelled`, confirmed. |
| Agent acks but the process ignores SIGKILL (uninterruptible I/O) | `cmd.WaitDelay` closes the pipes and `Wait` returns; the agent reports. On Windows `TerminateJobObject` is unconditional. Residual risk: a Linux process in `D` state. `cancel_confirmed = true` is then *optimistic*; accepted, and noted here so nobody claims a stronger guarantee than we have. |
| Reaper's script deadline fires while `cancelling` | **Cancel wins.** `reapStaleScriptExecutions` must exclude `cancelling` from its `timeout` stamping, and its `inArray(status, ['pending','queued','running'])` pre-filter (`jobs/staleCommandReaper.ts:400`) must be widened so a `cancelling` row is not orphaned from the deadline path entirely. |
| Late result after `cancelled` with `cancel_confirmed = false` | Accept it: fill `stdout`/`stderr`/`exit_code` and flip `cancel_confirmed` to `true`. An extension of the existing #3607 recovery branch (`commandResultHandlers.ts:426`). **Status stays `cancelled`.** |
| Ordering in `handleScriptResult` | The `cancelling` acceptance must be checked **before** the #3607 recovery branch, which keys on `status IN ('timeout','failed') AND exit_code IS NULL AND stdout IS NULL`. |
| Cancel a run whose devices are mid-dispatch | The run flips `cancelled` immediately; the dispatch loop stops at the next device/action boundary; already-dispatched devices get individual `script_cancel` commands. Bounded, not instant. |

**Closers for `cancelling` — exactly two:**
1. `commandResultHandlers.handleScriptResult` — widen the accepted set to
   include `cancelling`; an inbound result (of any agent status) maps to
   `cancelled`, `cancel_confirmed = true`, output preserved. Also handle the
   `script_cancel` command's own result (`notFound: true` → same).
2. `jobs/staleCommandReaper.ts` — new `reapCancellingExecutions` sweep:
   `cancelling` older than `CANCEL_GRACE_MS` **measured from command delivery**
   → `cancelled`, `cancel_confirmed = false`, `error_message` explaining, plus
   the `script.execution.cancel.unconfirmed` audit event. Close the
   `script_cancel` command row too. Register in the reaper's job table
   (`staleCommandReaper.ts:1090`).

---

## Tenancy & data model impact

**No new tables.** No new config/policy table, so the *Partner-Wide First*
rule (CLAUDE.md §epic #2135) is **not triggered** — but the partner-vs-org
authorization split in §Users & scope and the `automation_run_id`-keyed (never
`org_id`-keyed) fan-out in §5.3 are the partner concerns that section exists to
prevent, and both are load-bearing.

| Object | Shape | Registration required |
|---|---|---|
| `script_executions` **+3 columns** | Shape 1, direct `org_id`; RLS auto-discovered | Already in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:372`), `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts:237`), `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`core.ts:343`), and `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts:333`). **⚠ The export-policy row fires on a new COLUMN, not just a new table.** All three new columns must be classified in the same PR or `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts` redden main. Classification: `cancel_requested_at` → `included`; `cancelled_by` → `included` (tenant identifier, same bucket as the existing `triggered_by`); `cancel_confirmed` → `included`. None is `json`/`jsonb`/`bytea`, so no `excludedOpen`. |
| `automation_runs` **+enum value** | Shape 7 (parent-FK join policy through `automations`; **no `org_id`**) | Enum-only change. No cascade or export-policy entry needed — the table has no `org_id`. |
| `automation_run_device_results` **+enum value** | Shape 1, `org_id` = **device's** org | Already registered in all four lists. Enum-only; no new column, so export policy is untouched. |
| `automation_action_results` | Shape 1, composite FK `(device_id, org_id) → devices` | **No change** — `cancelled` and `terminal_source='cancellation'` already exist. |
| `device_commands` | intentionally system-scoped (agent WS path) | No change; `queueCommand` owns the context. |

**Migration traps.**

- Two enum values (`execution_status.cancelling`,
  `automation_run_status.cancelled`, `automation_device_result_status.cancelled`)
  and three `ADD COLUMN`s. `autoMigrate` wraps **each file** in
  `client.begin(...)`, and PostgreSQL forbids *using* a value added by
  `ALTER TYPE ... ADD VALUE` in the same transaction that added it. **Split into
  two migration files:** one that only adds enum values + columns, a later one
  for anything that writes them. Never add an inner `BEGIN;`/`COMMIT;`.
- Idempotent: `ALTER TYPE ... ADD VALUE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`.
- **Naming:** `2026-08-06` is a closed date block. As of 2026‑08‑26 the newest
  committed migration was named `2026-09-10-…`, i.e. ahead of real time — the
  new files **must** be named to sort after the newest committed migration at
  authoring time, checked then, not assumed from today's date. Use
  `YYYY-MM-DD-HHMMSS-<slug>.sql`. Re-check against `origin/main` before push
  (the pre-push hook re-runs `check-migration-naming.sh --against-ref origin/main`).
- Backfill (there is none required here) would need `breeze.scope = system` or
  it silently no-ops on managed Postgres.

---

## Out of scope

- Generic cancel for non-script commands (software installs, patch jobs,
  backups — each already has its own stop path).
- Cancelling a *scheduled* automation before it fires — that is disable/skip,
  a different control.
- Pause / resume of a run.
- Killing processes a script **deliberately detaches** (`Start-Process` outside
  the job on pre-Win8 nesting, `nohup`, `systemd-run`, a scheduled task the
  script registers). Job Object + process group cover the ordinary tree; a
  script that intentionally escapes containment is not something we promise to
  stop, and the docs must say so.
- Cancelling a remote-desktop / terminal session (`EXCLUDED_COMMAND_TYPES`
  already carves those out; they have their own stop commands).
- Retroactively reconciling historical `cancelled` rows written by the old
  bookkeeping-only route — they stay as-is, with `cancel_confirmed IS NULL`
  meaning "legacy, unknown".

---

## Open Decisions

**1. How much new column surface on `script_executions`?**
- **A — three columns** (`cancel_requested_at`, `cancelled_by`, `cancel_confirmed`):
  pro — the honest/dishonest distinction is queryable, reportable, and testable;
  `cancelled_by` matches the existing `triggered_by` idiom. Con — three
  export-policy classifications, three chances to redden the contract test.
- **B — one column** (`cancel_requested_at`), deriving actor from the audit log
  and confirmation from `exit_code IS NOT NULL`: pro — minimal surface. Con —
  `exit_code IS NOT NULL` is *not* equivalent to "the agent confirmed" (a
  `notFound` ack has no exit code), so the UI could not distinguish a proven
  stop from a give-up. That is precisely the lie this spec exists to remove.
- **C — zero columns**, encode everything in `error_message`: pro — no
  migration. Con — unparseable, unqueryable, untestable.

**Recommend A** — the whole point is being able to prove the difference between
"stopped" and "we asked". Losing that to save two columns defeats the feature.

**2. Grace period before SIGKILL, and where it is configured.**
- **A — fixed 5 s**, agent-side constant: pro — no surface, no policy. Con — a
  script mid-`Copy-Item` of a 4 GB file gets 5 s.
- **B — 5 s default, overridable per request** via `graceSeconds` in the
  `script_cancel` payload, clamped 0–30 s: pro — a "force stop now" affordance
  (`graceSeconds: 0`) falls out for free; the operator who knows the script is
  wedged doesn't wait. Con — one more field on the wire and in the UI.
- **C — per-script setting** on the `scripts` row: pro — the script author knows
  best. Con — a new column on a config-ish table, and it is the *canceller* who
  is in a hurry, not the author.

**Recommend B** — clamped, defaulted, with a "Force stop" secondary action in
the UI that sends `graceSeconds: 0`.

**3. `cancel_confirmed = false` — how loud?**
- **A — row field + audit event only** (as specced): pro — quiet, durable, and
  the UI can surface it inline. Con — nobody looks until they look.
- **B — also raise an alert** on the device: pro — a script that survived a kill
  is a genuine anomaly. Con — noisy on a fleet with flaky connectivity; every
  offline device that never reconnects within the grace window would fire one.
- **C — also `captureException` to Sentry**: pro — engineering sees the rate.
  Con — it is an *operational* condition, not a code defect; Sentry is the wrong
  channel and it would drown the real signal.

**Recommend A**, plus a counter on the existing metrics path so the rate is
visible without paging anyone. Revisit B once we have a baseline rate.

**4. Windows: `CREATE_SUSPENDED` correctness vs. a narrow assignment window.**
- **A — assign to the job after `cmd.Start()`** (no `CREATE_SUSPENDED`): pro —
  stays entirely inside `os/exec`, small diff, no manual handle management. Con
  — a microseconds-wide window where a grandchild spawned before assignment
  escapes the job. On Win8+ nested jobs, a child that creates its own job still
  stays inside ours, so the practical exposure is a process that forks
  *instantly* at start.
- **B — `CREATE_SUSPENDED` + recover the primary thread + `ResumeThread`**:
  pro — airtight, no window. Con — `os/exec` does not expose the thread handle;
  needs `Thread32First` enumeration or a hand-rolled `windows.CreateProcess`
  for the script path, which forfeits `os/exec`'s `Wait`/pipe/`Cancel`
  synchronisation — the exact machinery the current code's comments say must
  not be hand-rolled.
- **C — `CREATE_SUSPENDED` via a tiny launcher shim** the agent ships: pro —
  airtight without abandoning `os/exec`. Con — a new signed binary on every
  endpoint, for a microseconds-wide window.

**Recommend A** for this feature, with the residual window written into the
code comment and a follow-up issue for B. It is a strict, large improvement over
today's "kill only the shell leader", and it fixes the timeout path too.

**5. Should batch cancel be in this scope, or deferred?**
- **A — include it** (`POST /scripts/batches/:id/cancel`): pro — once
  `cancelScriptExecution` exists the fan-out is ~30 lines and reuses the run
  fan-out shape; a 500-device batch gone wrong is the single most expensive
  version of this problem. Con — widens the PR.
- **B — defer to a follow-up**: pro — smaller first landing. Con — the operator
  whose 500-device batch is misbehaving is exactly the person filing #3525
  again next month, and they'd be clicking Cancel 500 times.

**Recommend A**.

**6. What does `cancelled` mean for automation-run success counters?**
- **A — cancelled devices count as neither succeeded nor failed**; the run shows
  `cancelled` with `devicesTargeted` intact and a separate `devicesCancelled`.
  Pro — honest. Con — a fourth counter on `automation_runs`, and a new column on
  a table that today has no `org_id` (so no export-policy cost, but still a
  migration).
- **B — count them as `failed`**: pro — no schema change. Con — a deliberate
  operator stop is not a failure; it would poison automation health reporting
  and any alerting keyed on `devicesFailed`.
- **C — count them as `skipped`** in `automation_run_device_results` and leave
  the run counters alone: pro — no new column at all. Con — overloads `skipped`,
  which already means "filtered out of the target set"; the run's
  `devicesSucceeded + devicesFailed` would then silently not sum to
  `devicesTargeted` with no field explaining the gap.

**Recommend A** — one integer column on `automation_runs` (no `org_id`, so no
export-policy registration) buys correct reporting.

**7. Should an org-scoped operator be able to cancel a partner-wide run?**
- **A — no** (as specced): they may cancel the individual executions on their
  own devices, but the run itself requires `canManagePartnerWidePolicies`. Pro —
  no cross-tenant blast radius; consistent with every other partner-wide write.
  Con — an org tech watching a bad partner-wide run hit their fleet has to
  cancel device-by-device or call the MSP.
- **B — yes, scoped**: cancelling a partner-wide run as an org user cancels only
  *their org's* slice and leaves the run `running` for others. Pro — the org
  tech gets relief. Con — a genuinely new semantic ("partially cancelled run")
  with no precedent in the codebase, new state to model, and a run that reports
  `completed` while one tenant's slice was cancelled.

**Recommend A**, and make the "Cancel run" button's absence explicable in the
UI (tooltip: *"This automation is managed for all organizations — ask your
provider to stop the run, or cancel the affected devices individually."*).

---

## Test & rollout notes

**Go (`go test -race ./...`)**
- Table-driven `executor` tests for the escalation ladder: SIGTERM observed,
  then SIGKILL after grace; `graceSeconds: 0` skips straight to kill.
- **Process-tree test on each OS**: spawn a script whose child spawns a
  grandchild that writes a heartbeat file; cancel; assert the grandchild's PID
  is gone. `runtime.GOOS`-guarded so Windows only runs in the Windows CI leg.
- Windows Job Object **contract test** in the shape of
  `pamlifetime/job_contract_test.go` — assert the
  `CreateJobObjectW → SetInformationJobObject(KILL_ON_JOB_CLOSE) →
  AssignProcessToJobObject → TerminateJobObject` call order against a fake.
- `handleScriptCancel` returns success + `notFound: true` for an unknown id.
- User-helper IPC round-trip for `runAs=user` cancel.

**API unit (Vitest, Drizzle mocks)**
- Cancel-route CAS matrix: one case per starting status × command status,
  asserting the resulting execution status, `cancel_confirmed`, and whether a
  `script_cancel` command was queued.
- `commandResultHandlers`: `cancelling` + result → `cancelled` with output
  preserved; ordering vs the #3607 branch; `script_cancel` `notFound` result.
- Reaper: `cancelling` past grace → `cancelled`/`unconfirmed`; `cancelling`
  **not** stamped `timeout`; grace measured from delivery not request.
- Dedup: two concurrent cancels → one command row.
- Run fan-out: partner-wide run cancels executions across **two** orgs.

**Integration (real Postgres — these are the ones that catch the registration misses)**
- `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip` —
  will fail until the three new columns are classified. **Run locally before PR**;
  they cannot fail in the Test API job.
- `tenantCascade.integration.test.ts` — no new tables, so this should stay green;
  run it anyway.
- `rls-coverage.integration.test.ts` — no shape change; confirm.
- New `scriptCancellationPartnerRls.integration.test.ts`: org token cancelling a
  partner-wide run → 403; partner token → 200 and the fan-out reaches devices in
  both orgs; cross-tenant cancel of another org's execution → 404/403.
- Migration replay: apply the two new migration files twice, assert no-op.

**Web (Vitest + jsdom)**
- Iterate the `ExecutionStatus` union and assert every value resolves in both
  `statusConfig` maps (the regression test for the crash above).
- Cancel button visibility per status and per permission.
- `runAction` failure path: 409 toasts, no silent no-op
  (`no-silent-mutations.test.ts` covers the adopted set).

**E2E (Playwright, `data-testid` only)**
- Run a 120 s sleep script → click Cancel → assert "Stopping…" → assert
  "Cancelled" within the grace window.

**Rollout**
- **No feature flag on the server side.** Cancel is a de-escalation, and the
  agent command has been in the field since 2026‑02‑07 (`6a1689e499`), so an
  older agent already understands `script_cancel` — the server change is
  backward-compatible with the deployed fleet. *(Verify the oldest supported
  agent band before merge; if any band predates that commit it will return
  "unknown command" and the grace deadline will correctly mark the cancel
  unconfirmed — degraded but honest.)*
- **The Windows Job Object change is agent-shipped code.** Canary a small org
  band before fleet promote, per the repo's fleet-promote discipline. Watch for
  scripts that legitimately spawn detached children and now die with the parent —
  that is a *behaviour change on the timeout path too*, and it is the one thing
  in this spec that could break a working customer script.
- `CANCEL_GRACE_MS` ships as an env-tunable constant so the unconfirmed rate can
  be tuned without a deploy.
- Docs: update `apps/docs/src/content/docs/agents/commands.mdx` (`script_cancel`
  now has `graceSeconds`, and the Windows-has-no-graceful-phase caveat), and add
  an operator-facing "Stopping a running script" page.

**Suggested wave split** (this is `effort:l`; do not land it as one PR)

| Wave | Content |
|---|---|
| W01 | Web `ExecutionStatus`/`statusConfig` widening + regression test (fixes the live crash, ships alone, no API dependency) |
| W02 | Migrations (enum values + columns), export-policy classification, `cancelling` state, `CommandTypes.SCRIPT_CANCEL`, `services/scriptCancellation.ts`, rewritten cancel route |
| W03 | Result-handler + reaper closers, audit events, `cancel_confirmed` |
| W04 | Go agent: grace escalation + Windows Job Object + `notFound` ack (canary before promote) |
| W05 | Automation-run + batch cancel fan-out, partner gate, run counters |
| W06 | Web UI affordances (execution row, details, run history, batch), i18n, E2E |
