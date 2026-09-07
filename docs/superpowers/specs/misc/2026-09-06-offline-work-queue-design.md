# Offline Work Queue — Design

**Date:** 2026-09-06
**Status:** Approved 2026-09-06 (Todd). All nine Open Decisions resolved per their stated recommendation; OD-4 staged as written (claim-time org/lifecycle/trust/requester checks now, full permission rehydration as W6 after Track B #3985). Quorum: Codex gpt-6 xhigh, read-only, against `02e8e5b29d`.
**Issue:** LanternOps/breeze#5128 (predecessor #4981 second half, same reporter; #4226 item 7 raises the patch-side case).
**Ask (Discord, MSP technician):** "Every action in Breeze should not depend on the machine being online. Software updates, patches, scripts, software deployment should not just fail when you click on them — they should switch to pending, then run once the machine is online."

## Problem

Whether an action against an offline device *queues and waits* or *fails fast* depends today on which of six code paths handles the route, not on any product decision:

| # | Path | Offline behaviour today | Used by |
|---|---|---|---|
| 1 | `queueCommandForExecution` / `executeCommand` (`apps/api/src/services/commandQueue.ts` ~841, ~1113) | Hard reject: `Device is ${status}, cannot execute command` | Patch scan/rollback/install (`patchJobExecutor.ts` → `markDeviceSkipped(...'device_offline')`, counted toward `devicesCompleted`), backups (409), fleet findings, vuln remediation, DR, ~15 AI tools |
| 2 | `dispatchScriptToDevice` (`services/scriptDispatch.ts` ~193) | `requireOnline` flag. Manual Run Script passes `false` ⇒ queues; UI copy says "the run will wait until it reconnects". Automations pass `true` ⇒ step fails | Scripts, automations `run_script` / `execute_command` |
| 3 | `dispatchSoftwareInstallToDevice` (`services/softwareDeployment.ts` ~113) | WS push first (**no `device_commands` row when the push succeeds**), fallback `queueCommand`; UI "Queued — device offline"; 7-day expiry | Software deployments (manual + automation `deploy_software`) |
| 4 | `routes/devices/commands.ts` (bulk, single, `set_auto_update`) | Raw `db.insert(deviceCommands)`, bypasses every helper; only `decommissioned` is rejected; queues with the 30-min reaper default | Reboot, shutdown, lock, refresh inventory, etc. |
| 5 | Live-session routes (terminal, remote desktop, tunnels, file browser, system tools, boot metrics) | `Device is not online` 400/503 | Correct — these need a live socket |
| 6 | Wake-on-LAN | Separate relay path | n/a |

Further defects make even the "queues" paths unreliable:

- **The reaper conflates two clocks.** `reapStaleDeviceCommands` (`apps/api/src/jobs/staleCommandReaper.ts`, every 2 min) judges a `pending` row by `createdAt + getCommandTimeoutMs(type, payload)` — the *execution* timeout reused as the *delivery* deadline. A script with the default 300 s timeout queued for an offline laptop is reaped after ~10 min as "Command expired: agent never received the command". Only `software_install` gets `SEVEN_DAYS` (`commandTimeouts.ts`), a per-type special case. So path 2 promises "will wait until it reconnects" and then silently fails.
- **The per-feature reapers have the same defect independently.** The `script_executions` reaper (`staleCommandReaper.ts` ~418) expires a not-yet-running execution from `createdAt` using the execution timeout, so even a surviving command row would have its execution row failed under it. The software `deployment_results` reaper (~990) measures its 55-min "delivered but silent" tier from the *deployment's* `dispatchedAt`, so an install delivered three days after dispatch is timed out on the reaper's next pass.
- **Payloads are built for immediate delivery.** Uploaded installers are handed to the agent as a one-hour presigned URL (`softwareDeployment.ts` ~494); a `software_install` claimed six hours later downloads nothing.
- **Docs contradict each other.** `features/patch-management.mdx` and `features/scripts.mdx` promise waiting; `features/deployments.mdx` and `features/fleet-hygiene.mdx` promise "offline devices are skipped, not retried". `apps/web/src/components/devices/bulkActionGating.ts` records "gate on online" as an anti-pattern fixed three times (#2078, #2426, #2465).

What already works, and this design leans on: delivery to a reconnecting agent is **pull-based and proven**. Every HTTP heartbeat calls `claimPendingCommandsForDevice` (`services/commandDispatch.ts`), which selects `status='pending'` rows `FOR UPDATE SKIP LOCKED` (10 per heartbeat, `createdAt` order) and flips them to `sent`. The Go agent heartbeats on startup (jittered, unless restarting after self-update) and every `HeartbeatIntervalSeconds` (default 60 s), and dedups on command UUID (`markCommandSeen`). WS `onOpen` deliberately does *not* drain (#2407). Nothing agent-side needs to change.

## Users & scope

- **Who:** partner (MSP) technicians and org admins issuing device-targeted, fire-and-forget work. Not a config/policy table — queued work is per device, so the partner-wide-first contract does not apply to the queue itself. Any *defaults* that become configurable (patch offline behaviour) live inside existing config records (`patch_policies.schedule`, automation action config) and inherit their ownership model.
- **In scope:** scripts, patch installs, software deployments, generic device commands (reboot/shutdown/lock/inventory/etc.), automation actions that target devices, and the AI tools that wrap them.
- **Not in scope (v1):** backups/restores, live sessions, wake-on-LAN, the maintenance-window-by-device-filter half of #4981, agent changes. See "Out of scope".

## Approaches considered

- **A (chosen, both advisors): deferred delivery as a first-class property of every `device_commands` row**, delivered by the existing heartbeat claim. One nullable deadline column, one enqueue seam with an explicit policy, a reaper that separates the delivery clock from the execution clock, and claim-time eligibility checks.
- **B: a new org-scoped `device_work_queue` intent table (RLS shape 1)** with a drainer that materialises `device_commands` on reconnect. Pick B only if an intent must survive multiple command attempts, approvals, dependencies, or heavy materialisation at execution time — none of which offline waiting needs. It would add a second queue, two-phase state, an idempotent drainer, and four registration lists for no user-visible gain.
- **C: per-feature scheduler ticks** (copy `softwareDeploymentScheduler` for scripts and patches). Rejected — this is exactly the sprawl that produced six behaviours.

## Proposed design

### A. Contract: every device command carries an explicit offline policy

```ts
type OfflinePolicy =
  | { kind: 'reject' }                                  // needs a live socket now
  | { kind: 'queue'; deliverWithinMs: number };         // wait for the device, up to a deadline
```

- Replaces the `requireOnline` boolean on `dispatchScriptToDevice`, the inline `device.status !== 'online'` checks in `queueCommandForExecution` / `executeCommand`, the WS-first-no-row branch in `dispatchSoftwareInstallToDevice`, and the three raw inserts in `routes/devices/commands.ts`. After this change there is **one** seam through which a device command is enqueued, it always persists the row **before** either transport, and it always states its offline policy.
- A **per-command-type registry** (`services/commandOfflinePolicy.ts`, beside `commandTimeouts.ts`) is the source of defaults and is **fail-closed**: every `CommandTypes` value must appear with a policy and a TTL class; an unregistered type throws at enqueue (and a unit test asserts full coverage of `CommandTypes`). Live/interactive types (terminal, desktop, tunnel, file browser, process/service/registry/event-log reads, screenshot, computer action, boot metrics) → `reject`; deferred-capable types → `queue` with a TTL class (OD-1). Callers may override in either direction (an AI tool that promised a synchronous answer passes `reject`; a background remediation passes a longer deadline).
- `reject` keeps today's error text and codes so Track B's `excluded / device_offline` admission mapping (§I) is untouched for callers that stay `reject`.
- `waitForCommandResult` (`commandQueue.ts` ~758) terminalises the row when the caller stops waiting; it is **never** combined with `queue`. Deferred callers return `accepted/queued` immediately.

### B. Schema: additive columns on `device_commands`

```sql
ALTER TABLE device_commands
  ADD COLUMN IF NOT EXISTS deliver_by        timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_org_id  uuid REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_device_commands_deliver_by
  ON device_commands (deliver_by) WHERE status = 'pending' AND deliver_by IS NOT NULL;
```

- `deliver_by` = the instant by which an agent must have *claimed* the row. NULL = legacy rule (§C), so the migration is a pure `ADD COLUMN`, existing pending rows behave exactly as before, and no backfill is needed. Every new enqueue sets it: `now() + deliverWithinMs` for `queue`; for `reject` (row created only when the device is online) `now() + 5 min` so a row that raced a disconnect cannot linger.
- `submitted_org_id` = the device's org at enqueue, compared at claim to detect an org move (§G). It is an immutable provenance value, not a tenancy column: `device_commands` stays intentionally system-scoped (no RLS, agent path), and `ON DELETE SET NULL` keeps old-org erasure from tripping on rows for devices that moved away. Named deliberately not `org_id` so the RLS/cascade auto-discovery does not classify the table as tenant-scoped.
- Deferred to Track B: an `authorization_subject` (the shape of `recoveryAuthorizationSubject.ts` on #3985) for full principal rehydration at claim — OD-4.

### C. Reaper: split the delivery clock from the execution clock

In `reapStaleDeviceCommands`:

| Row state | Deadline | Terminal result |
|---|---|---|
| `pending`, `deliver_by IS NOT NULL` | `deliver_by` | `status='failed'`, `result: { status: 'expired', reason: 'not_delivered_before_deadline', timedOutBy: 'server' }` |
| `pending`, `deliver_by IS NULL` (legacy rows) | `createdAt + getCommandTimeoutMs` (today's rule) | unchanged |
| `sent` | `executedAt + getCommandTimeoutMs` (today's rule) | unchanged (`timeout`) |

- The reason is `not_delivered_before_deadline`, not "never reconnected": protocol-capability exclusions (`claimPendingCommandsForDevice` skips `peripheral_policy_sync_v2` etc. for agents that don't advertise them) can leave a row undelivered on a connected device.
- **CAS on observed state.** The terminal UPDATE must key on the row's *observed* `(status, executedAt)`, not `status IN ('pending','sent')` as today (~311): a row observed `pending` and claimed between the SELECT and the UPDATE would otherwise be failed the instant it was delivered. Mirror the `(id, status='sent', executedAt=<claim ts>)` fence `releaseClaimedCommandDelivery` already uses.
- The SQL pre-filter gains an OR arm on `deliver_by < now()` and keeps the `SHORTEST_TIMEOUT_MS` arm for legacy/`sent` rows, so genuinely due rows are selected before the per-run cap is applied and 7-day rows are not rescanned every 2 minutes.
- **Single owner of the delivery clock.** The per-feature reapers stop independently expiring *undelivered* work: the `script_executions` reaper only expires `running` rows (from `startedAt`); the software `deployment_results` reaper's "delivered but silent" tier measures from the command's `executedAt` (claim time), not the deployment's `dispatchedAt`; both learn about delivery expiry only through `propagateTimedOutDeviceCommand`, which maps `expired` to "device did not reconnect before <deadline>" on the owning row. `SOFTWARE_QUEUED_EXPIRY_MS` and the `software_install = SEVEN_DAYS` special case are removed in favour of `deliver_by`.
- The self_uninstall drain exemptions are untouched (they carry their own deadline column and predicate).

### D. Single seam and call-site migration

One function owns enqueue: `dispatchDeviceCommand(input: DispatchDeviceCommandInput)`, a single options object with `{ deviceId, type, payload?, userId?, offlinePolicy?, previouslyRejected?, expectedOrgId?, preferHeartbeat? }`. There is no `targetRole`: watchdog-targeted commands stay on `executeCommand`. In order: device lookup + `expectedOrgId` check → device lifecycle → `assertDeviceExecuteAllowed` (partner trust) → if the device is not online and the policy is `reject`, return the existing `device_offline` error → `queueCommand` with `deliver_by` + `submitted_org_id` → if the agent socket is live, the existing claim → prepare → push → release-on-failure loop. Return value gains `delivery: 'delivered' | 'queued_offline' | 'queued_live'` (`queued_live` = the device is online but the push did not happen, so the next heartbeat claims it).

**Late-binding payload preparation.** A single `prepareCommandForDelivery(row)` runs on *both* claim paths (WS push and heartbeat batch) and owns everything that must be fresh at delivery: the existing `decryptCommandForDelivery`, plus re-minting presigned download URLs for `software_install` from the stored `s3Key`. Payloads store stable references, never time-limited URLs. Rows whose preparation fails are released back to `pending` (existing fence) and counted.

Call sites and their intended disposition (the plan enumerates every caller; this is the contract):

| Call site | Policy | Notes |
|---|---|---|
| Manual Run Script (`routes/scripts.ts` → `dispatchScriptToDevice`) | `queue`, scripts TTL | Already queues; now survives and reports `queued_offline` |
| Automations `run_script` / `execute_command` (`automationRuntime.ts`) | per-action `whenOffline: 'queue' \| 'skip'`, default `queue` | Step status `queued`; terminal via `applyAutomationActionTerminal` |
| Software install (`softwareDeployment.ts`) | `queue`, software TTL | Row persisted before the WS push; URL re-minted at delivery |
| Patch install (`patchJobExecutor.ts`) | `queue`, TTL per §F | Stops skipping offline devices |
| Patch scan / rollback (`routes/patches/operations.ts`) | `queue`, standard TTL (7 d) | Reported as `queuedOffline` in the response |
| Bulk + single generic commands (`routes/devices/commands.ts`) | registry default; power-state types per OD-3 | Existing `ALREADY_PENDING` dedup kept and made atomic inside the seam; response adds `queuedOffline` |
| Vuln remediation, fleet-findings dispatch, patch reboot handler, sensitive-data jobs | `queue`, standard TTL (7 d) | Background work; nothing is waiting on it |
| DR execution (`drExecutionService.ts`) | `reject` | Time-critical, own orchestration |
| Backups / restores / verification | `reject` (unchanged) | See "Out of scope" |
| AI tools that `waitForCommandResult` (`aiTools*.ts`) | `reject` (unchanged) | They promise a synchronous answer; tool text points at the async path |
| AI tools that create deployments / patch jobs | follow the underlying feature | e.g. `deploy_software` queues |
| Live-session routes | `reject` (unchanged) | Never pass through the seam's queue arm |

### E. Delivery on reconnect

- **v1 = heartbeat claim, unchanged transport.** The promise to users is "on the device's next successful heartbeat" (startup is jittered and the interval is configurable), not a fixed number of seconds. No new drainer, no event subscription, no agent change.
- **Claim predicates** (shared by `claimPendingCommandForDelivery` and `claimPendingCommandsForDevice`, evaluated atomically inside the claim transaction):
  1. `deliver_by IS NULL OR deliver_by > now()` — never deliver a row the reaper is about to expire.
  2. Eligibility (§G) — org unchanged, device lifecycle, tenant/partner eligibility, requesting user active.
  3. `install_patches` rows are held while the device is inside an active `suppressPatching` maintenance window (§F).
  4. **Power-state barrier:** `reboot` / `shutdown` rows are claimed only when the device has no other row in `sent`, and are claimed alone (batch of one). The agent runs non-interactive commands concurrently (`heartbeat.go` worker pool; `client.go` per-command goroutines), so FIFO order alone cannot stop a queued reboot from landing mid-script. The barrier cannot fence a live WS-pushed command that arrives in the same second; that residual is accepted and documented (OD-3).
- **Optional follow-up (OD-5):** on WS `onOpen`, after `updateDeviceStatus(...'online')`, run the *per-command* claim → prepare → push → release loop over claimable pending rows. This is the push path every shipped agent already handles; the #2407 failure was embedding a batch in the welcome frame, which no agent parsed.

### F. Higher-level records per work type

- **Scripts** — `script_executions.status` already has `queued`. Manual runs whose command was `queued_offline` sit in `queued`; delivery expiry maps to `failed` with `errorMessage = 'Device did not reconnect before <deadline>'`. The existing UI copy becomes true.
- **Software deployments** — `deployment_results` keeps its `pending` + `deviceCommandId` model, now always populated (row persisted before the push). The "Queued — device offline" chip switches to the seam's `delivery` value.
- **Patches** — today's flow is fully synchronous: `processExecuteDevice` polls up to 30 min (`pollForPatchCommandResult`) and then `recordDeviceExecution`; `routes/agents/patches.ts` handles *inventory*, not install results; and the job completion checker forcibly fails whatever is still pending at timeout (~714). Deferred installs therefore need:
  1. `patch_job_result_status` gains `queued`; `patch_jobs` gains `devices_queued`. An offline device's BullMQ task enqueues `install_patches` with `deliver_by`, marks the result `queued`, decrements `devicesPending`, increments `devicesQueued`, and **completes the task** — no multi-day poll.
  2. **One idempotent finalizer** (`services/patchJobFinalizer.ts`) keyed on `(patchJobId, deviceId, commandId)` handles every terminal path for a queued device — agent result (via the command-result handler chain), delivery expiry, cancel, supersession — recording the result, adjusting counters, and running the existing reboot evaluation. `recordDeviceExecution` is refactored to call it so the synchronous path and the deferred path share one writer.
  3. **Job status stays non-terminal while `devicesQueued > 0`** (UI: "Running — N devices waiting to reconnect"); the completion checker treats `queued` as neither pending nor failed and only terminalises when both counters are zero. Unfinished patching is never reported as completed (OD-9 covers whether a distinct job status is warranted).
  4. Scheduling semantics: Breeze maintenance windows are **suppression** windows (`checkDeviceMaintenanceWindow(...).suppressPatching`, checked per device at dispatch in `patchSchedulerWorker.ts` ~596); run *time* comes from the policy schedule occurrence. So: a new `offline_behavior` column on `config_policy_patch_settings` — the table that actually holds the patch schedule (`scheduleFrequency`/`scheduleTime`/…; `patch_policies` is the partner ring table and has no schedule) — exposed as `offlineBehavior` in `patchInlineSettingsSchema` (`'skip'` = status quo, `'queue'` = default); TTL for a scheduled job = `min(patch TTL, next schedule occurrence)`; when the next occurrence creates a job for the same device, any still-pending `install_patches` row from the previous job is cancelled `superseded_by_next_occurrence` and its result marked `skipped`, so a device that reconnects at the next occurrence installs once from the fresh approved set; and delivery is held while a `suppressPatching` window is active (§E predicate 3). Manual "install now" uses the patch TTL.
  5. `deliver_by` bounds *dispatch*, not start or finish — the agent may hold a command in its local pool. Strict "must finish inside the window" semantics would need an agent-enforced start deadline and are out of scope. Related existing gap, filed separately: `patchRebootHandler.ts` `if_required` reboots do not consult the maintenance window (~295).
- **Automations** — action config gains `whenOffline` (default `queue`). A queued action's `automation_action_results` row (Track B) sits in `queued`; the run is not failed by it. Reaper expiry → `timed_out` with the reconnect reason. Explicit organisational automations carry organisational authority; a human's deferred command does not silently become system work (OD-4).
- **Generic commands** — no higher-level record; visibility comes from §H.

### G. Eligibility at claim, cancellation, invalidation

- **Eligibility service** (`services/commandClaimEligibility.ts`), one function beneath both claim paths, evaluated inside the claim transaction. v1 checks: (1) `deliver_by` (above); (2) `submitted_org_id = devices.org_id` — else cancel `device_moved_org`; (3) device lifecycle not `decommissioned`/`quarantined` — else cancel `device_lifecycle`, preserving the uninstall-drain type allowlist path; (4) tenant eligibility + partner trust via the existing `assertDeviceExecuteAllowed` — else cancel `trust_denied`; (5) requesting user (`created_by`) still active when present — else cancel `requester_inactive`. Failing rows are terminalised in the same transaction (`cancelled`, payload erased via `terminalPayloadErasureSet()`), never delivered. Ownership changes and claims serialise through the device row lock the claim already takes (`FOR UPDATE`), so an org move committed mid-claim is seen by the next claim, not this one.
- **Not re-checked in v1:** full org/site/action permission rehydration of the requester, and script edit/delete (the payload is an immutable snapshot at request time; editing must never substitute code). Both become possible once Track B's authorization-subject shape lands (OD-4).
- **Cancel-on-event (cleanup, in addition to claim checks):** device decommission (`routes/devices/core.ts` ~1813, same transaction as the status write) and org move (`routes/devices/moveOrg.ts` ~297) cancel that device's ordinary pending rows with the matching reason. Partner suspension keeps its existing socket/token handling and queued-uninstall path (`tenantLifecycle.ts`).
- **User cancel:** `POST /devices/:id/commands/:commandId/cancel` flips `pending → cancelled` (CAS on `status='pending'`), erases the payload, and propagates to the owning record (script execution `cancelled`, patch result `skipped`, deployment result `cancelled`). Same permission as issuing the command.
- **Claim-time cancellations propagate to the owning record inside the claim transaction, exactly like cancel-on-event.**

### H. Visibility

- **Click time:** the action's existing confirmation/toast surface says "Runs when the device is online — expires <date>" (some generic commands already toast "queued" for offline devices, `DevicesPage.tsx` ~930 / #2630; this makes the copy uniform and adds the expiry). No new modal (OD-7).
- **Device page → "Queued actions" section** (new): type, requested by, requested at, expires at, Cancel. Reads the device's `pending` rows behind the existing device-access check. Hidden when empty.
- **Status chips:** script executions, patch job device list, deployment progress, automation run steps render `queued` as "Queued — device offline"; running patch jobs show "N waiting to reconnect".
- **Bulk responses** add `queuedOffline: string[]` beside `succeeded`/`failed`/`skipped`; the bulk bar reports "N sent, M queued for offline devices".
- **Fleet-wide "Pending work" page:** v2.

### I. Track B interplay (#3985, draft, owned by another agent)

**Status check during planning (2026-09-06, main `02e8e5b29d`):** the script-admission contract (`packages/shared/src/types/scriptAdmission.ts`, `executeScriptOnDevices` returning `admission`) and `automation_action_results` + `applyAutomationActionTerminal` are **already on main**. Only the recovery-authorization-subject shape (W6) still lives on the #3985 branch. OD-6's sequencing constraint therefore applies to W6 alone; W1–W5 have no dependency on #3985.

- `ScriptTargetAdmission` maps `device_offline → excluded`; that remains correct for `reject` callers. For `queue` callers the target is `admitted` and gains `delivery: 'delivered' | 'queued_offline'` (optional, additive). `admitted` continues to mean "accepted for delivery", never "executed".
- Track B's `applyAutomationActionTerminal` / `automation_action_results` are the terminal sink for §F automations; its `recoveryAuthorizationSubject` shape is the intended carrier for OD-4's full rehydration.
- Sequencing (OD-6): W1 (schema, reaper, seam, registry, generic commands, eligibility) touches none of Track B's files except `scriptDispatch.ts`'s `requireOnline` parameter and can land first behind the flag; the scripts/automations UX waves land after #3985 or coordinate with its owner.

### J. Agent

No change. Delivery, dedup (`markCommandSeen`), and result submission are unchanged. A queued command delivered days later is indistinguishable to the agent from one delivered immediately; `prepareCommandForDelivery` guarantees its payload is as fresh as an immediate one.

## Tenancy & data model impact

- `device_commands`: add `deliver_by`, `submitted_org_id` (FK, `ON DELETE SET NULL`), one partial index. Table stays intentionally system-scoped (CLAUDE.md "Intentionally system-scoped"): no RLS policy, no `CORE_ORG_CASCADE_DELETE_ORDER` entry, no export-policy entry. Already in `CORE_DEVICE_CASCADE_DELETE_TABLES`. The RLS coverage test auto-discovers `org_id` columns only; `submitted_org_id` is provenance and must be documented as such in the migration header so a future reader does not "fix" it into a tenancy column.
- `patch_job_result_status` enum: `ADD VALUE IF NOT EXISTS 'queued'`. `patch_jobs.devices_queued integer NOT NULL DEFAULT 0`: `patch_jobs` is an org-cascade table, so the new column needs a `CORE_TENANT_EXPORT_POLICY` classification (`included`).
- `config_policy_patch_settings.offline_behavior` (varchar + CHECK, default `queue`): the table has no `org_id`/`partner_id` — tenancy is transitive via `feature_link_id` → `config_policy_feature_links` → `configuration_policies` (dual-axis) — so no RLS change, no cascade entry, no export-policy entry; same shape as the reboot-deferral columns (#3207). `patchInlineSettingsSchema` gains `offlineBehavior` with its default. (Corrected 2026-09-06 during planning: an earlier draft placed this in `patch_policies.schedule`, which does not exist.)
- Automations `whenOffline`: inside the existing action config jsonb (`excludedOpen`); shared validator gains the field with default.
- Migration naming: must sort **after** `2026-10-12-100000-config-policy-inheritance.sql` (the current ceiling is five weeks ahead of real time); one migration per wave, idempotent, no inner transaction. No backfill; no row-count cleanup statements.

## Out of scope

- Backups, restores, verification: stay hard-gated in v1 (own scheduler and per-device execution slot from #4923). Revisit with production history.
- Live-session routes and wake-on-LAN: correct as they are.
- Maintenance windows by device filter and richer recurrence (#4981 first half): separate spec.
- Coalescing beyond the existing `ALREADY_PENDING` dedup; general execution ordering beyond the power-state barrier (OD-3).
- Agent-side start deadlines / strict in-window execution; any agent change.
- Partner-configurable TTLs (OD-1), fleet-wide "Pending work" page, notifications when deferred work finally runs.
- Fixing `if_required` reboots ignoring maintenance windows (filed as its own issue).

## Open Decisions (resolved 2026-09-06 — the bolded recommendation in each is the decision)

1. **TTL classes.** (a) one 7-day constant; (b) per-class constants, env-tunable: scripts and software 7 d, patch installs 7 d capped by next occurrence, inventory/config syncs 24 h, power-state 24 h, `reject`-raced rows 5 min; (c) partner-configurable. **Recommend (b)** (Codex; Fable initially preferred (a) — conceded that a 7-day `refresh_inventory` or reboot has no user value). (c) later, once (b) has data.
2. **Scheduled patch installs for offline devices.** (a) `offlineBehavior: 'queue'` default; TTL = min(patch TTL, next occurrence); next occurrence supersedes; delivery held during `suppressPatching` windows; (b) flat TTL, no supersession — can double-install on a device that reconnects at the next occurrence; (c) keep skipping. **Recommend (a)**.
3. **Disruptive-command conflicts on reconnect.** (a) power-state barrier at claim (§E.4) + 24 h TTL, accept the live-WS residual; (b) require reboot/shutdown to go through explicit scheduled-restart flows only (no queueing); (c) nothing in v1. **Recommend (a)** (both advisors reject (c)); (b) if the residual is judged unacceptable.
4. **Re-authorisation at claim — the one quorum split.** Fable: (a) v1 = org unchanged + lifecycle + partner trust + requester active, cancel-on-event as cleanup, snapshot payload. Codex: (b) additionally rehydrate the requester's current org/site/action permissions and resource permission at claim, carried by a Track B-style authorization subject; historical authorization should not substitute for current permission. **Recommend (a) now, (b) as a named W6 once #3985 lands** — (b)'s carrier does not exist on main yet, and (a) closes every drift class that can be checked without it. Todd to confirm this staging is acceptable for an RMM that executes code on customer machines.
5. **WS-open push drain.** (a) not in v1 — next heartbeat is fine; (b) include the per-command push loop in W1. **Recommend (a)**.
6. **Sequencing against Track B (#3985).** (a) W1 first behind a flag, UX waves after Track B merges; (b) wait entirely; (c) proceed and let Track B rebase. **Recommend (a)**. *Resolved differently by the facts:* the admission and automation-result pieces are already on main (§I), so W1–W5 proceed without waiting; only W6 waits for #3985.
7. **Click-time affordance.** (a) uniform copy in existing toasts/confirmations + chip + cancel; (b) a dedicated confirm modal per action. **Recommend (a)** (both advisors).
8. **Software payloads with time-limited URLs.** (a) late-binding `prepareCommandForDelivery` re-mints URLs at claim (§D); (b) store long-lived URLs. **Recommend (a)**; (b) widens the exposure window of every installer object.
9. **Patch job status while devices wait.** (a) keep `running` + `devicesQueued` counter and UI copy; (b) add a `waiting_for_devices` job status. **Recommend (a)** for v1 — no enum change, and the counter already tells the story; (b) if reporting needs the distinction.

## Test & rollout notes

- **Unit:** reaper matrix (pending+deliver_by, pending legacy, sent; CAS on observed state); registry full-coverage test over `CommandTypes`; each migrated call site asserts the policy it passes; eligibility service per failure class; power-state barrier; `prepareCommandForDelivery` URL re-mint; bulk response shape; cancel CAS; patch finalizer idempotency (same terminal twice → one write).
- **Integration (real Postgres):** a `queue` row survives past its execution timeout and expires exactly at `deliver_by` with `expired/not_delivered_before_deadline`, and the linked `script_executions` row is failed only by propagation; a heartbeat after simulated offline claims and delivers; a `reject` enqueue against an offline device creates no row; org move, decommission, disabled requester each cancel at claim and via event; reboot is not claimed while a script is `sent`; patch executor leaves an offline device `queued`, the job stays non-terminal, and the finalizer completes it from a late result and from expiry; `install_patches` is not claimed inside a `suppressPatching` window; next occurrence supersedes; enum add is idempotent.
- **Contract suites:** `rls-coverage` (unchanged allowlists, run anyway), `tenantCascade` (unchanged), `tenant-export-policy` + roundtrip (new `patch_jobs` column), `autoMigrate` naming, `migrationRlsScope` (no DML, should be a no-op).
- **Feature flag:** `DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED` gates the `queue` arm for callers that used to `reject` (patches, automations, scan/rollback); scripts and software keep queueing regardless. Defaults on once W3/W4 ship; removed the release after.
- **Docs sweep (same PR as each wave):** the five `features/*.mdx` pages must say one thing; release notes call out that patch jobs no longer skip offline devices and that jobs stay open while devices wait.
- **Waves for `writing-plans`:** W1 schema + reaper + seam + registry + eligibility + `prepareCommandForDelivery` + generic-command route + cancel endpoint; W2 scripts UX (chip, device-page queued list, toast, admission `delivery` field); W3 patches (enum, counter, finalizer, executor, `offlineBehavior`, UI); W4 automations (`whenOffline`, step status); W5 AI-tool text, docs, flag removal; W6 (post Track B) authorization-subject rehydration.
