---
title: Set-based, on-ingest alert evaluation (10k-agent scaling)
issue: 10866
builds_on: [10859, 10864]
status: draft
date: 2026-11-01
base: main @ 08868e663b; PR #10864 @ f631c6834b
---

# Set-based, on-ingest alert evaluation

Evidence labels: **verified** means read in code at the base SHA; **inferred** means reasoned or estimated, not run. Line numbers are at `main @ 08868e663b` unless they name #10864, which this design assumes has merged.

## 1. Problem

Alert evaluation is one BullMQ job per device per minute, and each job re-derives everything from scratch.

**The loop (verified).** `evaluate-all` runs every 60 s (`jobs/alertWorker.ts:425-436`). It pages every online device seen in the last 5 minutes and enqueues one `evaluate-device` job each (`:211-266`). After #10864, each job runs `evaluateDeviceAlertsInMode`. That function opens one short system context for the prelude, one per rule (`evaluateRuleForDevice`) and one for the detach scan. The worker then drains the subject outbox for that device.

**What one device costs, per job (steps verified; statement counts inferred from reading, not traced):**

| Step | Statements | Where |
|---|---|---|
| Maintenance resolution | 2–4 | `featureConfigResolver.ts:1057` |
| `getApplicableRules`: device, groups, monitor resolution (device, org, groups, assignments, attachments, replace links), ownership, rules, templates, monitor definitions | ~12 | `alertService.ts:1084-1260`, `monitors/monitorResolver.ts:260-374` |
| Every rule: the handler's read(s), plus a `getLatestMetric` that `evaluateConditions` runs on **every** call for template context | 2–4 | `alertConditions/index.ts:260` |
| Every monitor rule: `recordMonitorEvaluation`, a transaction (upsert, `SELECT … FOR UPDATE`, `UPDATE`) that runs on **every** evaluation, changed or not | ~5 | `monitors/episodeService.ts:136-370` |
| Every subject rule (hardware, time sync, container image): savepoint, advisory lock, a second full evaluation, 1–2 open-alert reads, then `recordMonitorEvaluation` | ~15 | `alertService.ts:1358-1390`, `alertSubjects.ts:70-87` |
| Detach scan | ~3 | `alertService.ts:1536-1563` |
| `drainSubjectAlertOutbox(deviceId)`: retirement outbox, escalation staging, two claim statements. This runs every minute, even when nothing is pending. | ~12 | `subjectAlertOutbox.ts:52-81,179-242` |

**Where the ~13 rules per device come from (verified).** They are the 13 partner-wide built-in monitors (`monitors/builtInMonitors.ts:92-270`):

- 3 metric thresholds: CPU over 15 min, memory over 15 min, disk over 30 min.
- 1 patch-compliance rule.
- 4 hardware-health rules, 4 time-sync rules and 1 container-image rule. These 9 are **subject kinds**. They take the most expensive path, yet their evidence is a set of streak counters that the ingest path maintains. Those counters change only when a new snapshot lands or a freshness window expires. Evaluating them every 60 s mostly re-confirms an unchanged answer.

**Totals (inferred).** About 4 × 11 (non-subject) + 9 × 18 (subject) + ~35 of overhead comes to **~230–240 statements per device per minute**. At 10–25 ms per round trip that is 2.5–6 s, which matches the measured 2–6 s of pooled connection time per device per minute. With #10864's default concurrency (`DB_POOL_MAX / 4` = 7 on a 30-connection pool), one process finishes about 70–210 devices a minute. That already falls short at 1,000 devices. At 10,000 devices the same work needs 330–1,000 connections held continuously.

**The auto-resolve sweep has the same shape (verified).** Every 2 minutes, `checkAllAutoResolve` loads every active alert. For each one it runs three reads and a full condition evaluation (`alertService.ts:1569-1597`, `checkAutoResolve` `:559-650`).

**Finding: auto-resolve ignores per-attachment overrides (verified by reading, impact inferred).** `checkAutoResolve` evaluates `overrides.conditions ?? template.conditions` (`:625`). The per-attachment monitor override that `getApplicableRules` applies (`:1199-1222`) never reaches it. So a device whose attachment raises its CPU threshold to 95 is alerted at 95, but auto-resolved against the base 90. Not reproduced.

**`triggerDeviceEvaluation` has no production caller (verified by grep).** The seam the issue names exists (`alertWorker.ts:458`), but nothing calls it.

## 2. Users and scope

| Who | What changes for them |
|---|---|
| MSP technicians (org and partner users) | Nothing they configure. They see the same alerts, episodes, recurrence escalations and notifications. Detection latency is unchanged under the recommended OD4(b). One exception: a snapshot-family change whose dirty mark is lost waits for the 300 s backstop (§3.8). |
| Self-hosting operators | New engine flags and tunables (§3.13). No migration in the recommended design. |
| On-call / platform | Alert evaluation stops scaling with devices × rules and starts scaling with devices / batch size, plus real alert churn. |

**In scope:**
- The per-device sweep (`evaluate-device`).
- The auto-resolve sweep.
- The per-device subject-outbox drain.
- On-ingest triggering.
- The network-check sweep's alert-device resolution, in a late wave.

**Out of scope:** listed in §5. The main exclusions are the offline detector's breach path and the alert producers that bypass this evaluator.

## 3. Proposed design

### 3.0 Shape

```
 cadence tick (per family bucket) ─┐
 ingest dirty mark (Redis hint) ───┼─► planner ─► evaluate-batch job: ≤500 eligible devices of one partner
 due-boundary sweep (per batch) ───┘                 1. scope     rules × devices, batch resolvers, pure TS ranking
                                                     2. load      one statement per condition family
                                                     3. evaluate  the SAME pure handler functions as today
                                                     4. diff      verdict vs stored state (monitor_device_state, open alerts)
                                                     5. act       today's per-(rule, device) pipeline, only for the delta
```

**SQL batches the reads. TypeScript keeps the semantics.** Every handler splits into a batch loader and a pure evaluator over the loaded data. The legacy per-device `evaluate(condition, deviceId)` becomes "load a batch of one, then evaluate". So there is **one** implementation of each condition, and shadow parity (§3.13) tests scope and data loading, not two copies of 20 handlers. Pushing the comparison itself into SQL (`HAVING avg(cpu) > 90`) was rejected (OD1). Conditions are AND/OR trees, thresholds vary per attachment, subject kinds return evidence per component, and templates read `actualValue`, `description` and context from the handler. A SQL rewrite of all that would drift. The one exception is aggregate pushdown where the aggregate is exactly what the handler computes, such as the threshold average.

### 3.1 The batch unit

- **A batch is one partition of one partner, about `ALERT_EVAL_BATCH_SIZE` (default 500) eligible devices.** A partition is a stable hash bucket of `devices.id` (the FNV-1a hash #10864 uses for its stagger), with `ceil(devices / 500)` buckets per partner. A bucket that hash skew pushes past 2× the target size is split by keyset at load time. A batch may span several of the partner's orgs. An org with no partner is its own partition set. The cadence, dirty and due paths (§3.8–3.10) all form batches from the **same** partitions, which makes the per-partition lease in §3.5 possible.
- **Why partner, not org or rule (OD3).** Partner-wide rules dominate (all 13 built-ins are partner-wide). The partner's rules and policies load once per batch, and small orgs share a batch. Statements then scale with devices / 500, not with org count. A per-rule unit would re-resolve scope and re-load shared tables 13 times.
- **Eligibility is unchanged from today (verified, `alertWorker.ts:193-236`):**
  - The org is active, not `quick_support`, and not the holding org.
  - The device is non-ephemeral, not parked, `online`, and was seen within the last 5 minutes.

  Two families also read offline devices: offline-monitor recovery, and the network-check alert device (§3.7).
- **Contexts follow #10864's discipline.** Each step runs in its own short system context: the scope load, the family loads, the state load, and one context per act pair. The load contexts do no Redis I/O (the #1105 rule). The act path keeps #10864's shape exactly, and that shape **does** call Redis inside the rule context: `createAlert`'s cooldown and flapping checks (`alertService.ts:253,283`) and the legacy publish. This design does not make that worse, and it now happens only for work pairs instead of every pair. Moving those calls out of the context is not in scope. Every BullMQ slot still holds at most one pooled connection at a time, so `resolveAlertWorkerConcurrency()` still bounds pool occupancy.

### 3.2 Scope: which rules reach which devices

New `resolveApplicableRulesForDevices(deviceIds)` returns the same `RuleWithTemplate` per device that `getApplicableRules` returns today. It follows the existing batch-resolver precedent: `resolvePatchPolicyWinnersForDevices` (`featureConfigResolver.ts:743`) is pinned to its per-device twin by `patchSchedulerClosestWins.integration.test.ts`.

1. **Hierarchy.** One statement for devices (org, site, role, OS, `last_seen_at`, `status`, `mtls_cert_expires_at`), one for group memberships and one for orgs (partner, type).
2. **Rules.** One statement loads the candidate rules with their templates and monitor definitions. It uses `org_id = ANY(batch orgs) OR (org_id IS NULL AND partner_id = P)`, the many-org form of `alertRuleOwnershipConditionForOrg` (`:1070`), and filters `is_active AND retired_at IS NULL`. **That statement only fetches candidates. It does not establish ownership.** In memory, every (rule, device) match re-applies ownership **per device**: `rule.org_id = device.org_id`, or `rule.org_id IS NULL AND rule.partner_id = device's org's partner`. Only then does the target (`all`, `org`, `site`, `group`, `device`) match. Without this, org A's `target_type = 'all'` rule would reach org B's devices in the same batch, and the system context would not stop it. The same per-device ownership applies to policy candidates in step 3. A cross-org test pins it (§7).
3. **Monitors.** New `resolveMonitorsForDevices(deviceIds)`. One statement loads the candidate assignments for the batch's targets: device ids, site ids, org ids, group ids and the partner. The partner target is withheld for quick-support and unassigned-pool orgs (`MONITOR_APPLICABILITY`, `monitorResolver.ts:176`). A second statement loads attachments and replace links. Then, per device and in memory, the resolver runs the role/OS filter and the existing pure `selectContributingAttachments` and `pickWinner` (`:140-173,93`). The per-attachment override block (`alertService.ts:1199-1222`) moves into a shared function that both paths call.
4. **`device_missing` is not zero.** A device that vanishes mid-batch drops out of scope and out of detach, as #5677 requires.

The output is, per rule, the devices it reaches and each device's effective condition and severity. Devices are grouped by distinct effective condition so the loaders can share parameters.

### 3.3 Load and evaluate: one statement per condition family (deliverable a)

The handler interface grows a batch half. `evaluate` stays for single-device callers.

```ts
interface ConditionHandler {
  type: string; aliases?: string[];
  validate(condition: unknown, path: string): string[];
  evaluate(condition: unknown, deviceId: string): Promise<ConditionResult>; // = evaluateLoaded(load([id]))
  family: ConditionFamilyId;
  // pure; `flipsAt` = earliest time this verdict could change with NO new data (§3.9), or null
  evaluateLoaded(condition: unknown, data: FamilyRows, deviceId: string, now: Date): ConditionResult & { flipsAt?: Date | null };
}
interface ConditionFamily {
  id: ConditionFamilyId;
  sources: IngestSource[];        // which ingest writes mark it dirty (§3.8)
  timeSensitive: boolean;         // can a verdict flip with no new data?
  load(requests: Array<{ deviceId: string; leafKey: string }>, leaves: Map<string, unknown>, now: Date): Promise<Map<string, FamilyRows>>;
}
```

- `evaluateConditions` gets a loaded twin, `evaluateConditionsLoaded(tree, deviceId, rowsByFamily, now)`. It keeps the same tree walk and the same tree-order `pickPrimaryActualValue` (`alertConditions/index.ts:144-154`). Its `latestMetric` context fallback comes from the metrics family instead of a separate `getLatestMetric` per call.
- **Per-leaf parameters.** Loaders take a list of (device, leaf parameter set) pairs and run **one** statement per family per batch. The parameters ride in an `unnest($device_ids::uuid[], $leaf_idx::int[])` joined `LATERAL` to the source table. That still holds when attachment overrides give 500 devices 3 different thresholds.

**Every registered handler (verified, `alertConditions/index.ts:37-56`), classified:**

| Handler | Reads (verified) | Batch statement | Time-sensitive | Dirty source | Classification |
|---|---|---|---|---|---|
| `threshold` (alias `metric`) | `device_metrics` window average (`handlers/threshold.ts`) | `GROUP BY device_id`, `avg(col) FILTER (WHERE timestamp >= now() - w)` per distinct (metric, window), plus `count` and the latest row | yes (window) | none, cadence | **set-based, exact aggregate pushdown** |
| `bandwidth_high` | `device_metrics`, every sample must compare | `bool_and(expr op v)`, `count` and latest, per distinct (direction, op, value, window) | yes | none, cadence | **set-based, pushdown** |
| `disk_io_high` | same | same | yes | none, cadence | **set-based, pushdown** |
| `network_errors` | `device_metrics.interface_stats` counter deltas over 2× window | raw rows for only the devices whose rules contain it; deltas in TS | yes | none, cadence | **set-based load, evaluated per row** |
| `offline` (alias `status`) | `devices.last_seen_at` against the rule's own `durationMinutes` (`handlers/offline.ts:32-42`). This can breach while `status` is still `online` when the duration is under the detector's 5 minutes. | none extra; from the batch hierarchy | yes | heartbeat offline→online transition | **set-based, fully evaluated (breach and ok), exactly as today.** The offline detector's separate alert path is unchanged (§3.9). |
| `cert_expiry` | `devices.mtls_cert_expires_at` | none extra; from the hierarchy | yes (boundary) | none | **set-based** |
| `event_log` | `device_event_logs` count in window by category, level, `ILIKE` source and message | `LATERAL count(*)` per (device, leaf) | yes (window) | `routes/agents/eventlogs.ts:356` | **set-based** |
| `service_stopped` | `service_process_check_results`, latest N | `LATERAL … ORDER BY timestamp DESC LIMIT n` | no | heartbeat check results (`heartbeat.ts:3235`) | **set-based** |
| `process_stopped` | same | same | no | same | **set-based** |
| `process_cpu_high`, `process_memory_high` | same table, window, all samples | `LATERAL` window `bool_and` | yes | same, plus cadence | **set-based** |
| `patch_compliance` | `security_posture_snapshots` latest, 24 h staleness, `dataGap` | `DISTINCT ON (device_id) … ORDER BY device_id, captured_at DESC` | yes (24 h) | posture snapshot writer (`securityPosture.ts`) | **set-based** |
| `antivirus` | `security_status` row | `WHERE device_id = ANY` | yes (`definitions_stale`) | `routes/agents/helpers.ts:565` | **set-based** |
| `software_presence` | `software_inventory` by lower(name) and vendor, latest | `LATERAL` per (device, name, vendor) | no | `softwareInventoryObservations.ts` | **set-based** |
| `backup_continuity` | `backup_jobs`, latest max(failureCount, 20) | `LATERAL … LIMIT` | yes (age of the last success) | none: ≥9 writers, no single seam | **set-based, cadence only** |
| `script_monitor` | `script_executions` latest for (monitor, device), 3× interval staleness | `LATERAL` latest | yes | none: ≥9 writers | **set-based, cadence only** |
| `network_check` | managed `network_monitors`, alert device, `network_monitor_results` | per org, not per device | — | `monitorWorker` result insert | **stays on its own per-org sweep** (§3.7) |
| `hardware_health` (subject) | `device_hardware_health`, components (streaks, freshness at 3× the poll interval; the poll interval can be as short as 5 min, so freshness can expire after 15 min: `packages/shared/src/validators/hardwareHealth.ts:19`, `hardwareHealth/freshness.ts`) | 2 statements `WHERE device_id = ANY` | yes (freshness) | `hardwareHealth/ingest.ts` | **set-based load; act stays per device under the lock** |
| `time_sync` (subject) | `device_time_status` row, streaks, staleness | 1 statement | yes (staleness) | `timeSync/ingest.ts` | **set-based load; act per device** |
| `container_image_currency` (subject) | `device_workloads` containers, `upstream_status`, `behind_since` | 1 statement | yes (`minDaysBehind`) | `workloads/ingest.ts` **and** the server-side image-currency pass, which writes `upstream_status` and `behind_since` (`imageCurrency/pass.ts:206-215`) | **set-based load; act per device** |

**Where a per-device fallback remains:**
1. **The subject act path.** The re-read of evidence under the advisory lock is part of the contract (§3.12), so it stays per device. The batch decides only *whether* to enter it.
2. **`network_check`.** It has one verdict per org, on its own sweep.
3. **A handler without `evaluateLoaded`.** The engine calls `handler.evaluate(condition, deviceId)` once per in-scope device. That is correct but slow. A contract test fails if a registered handler lacks a family, unless it sits in an explicit allowlist.
4. **Types with no handler.** These are `dns_threat` and the template editor's `event` (`alertConditions/index.ts:419-445`). Today they evaluate to "Unknown condition type", `passed: false`, and the engine keeps that.

**Composite monitors are AND/OR trees over these leaves.** A pass never evaluates a partial tree. A dirty or due signal for family F selects the **rules** whose trees reference F. The pass then loads **every** family those rules' trees reference. Partial evidence for a composite is not a verdict.

**Golden fixtures come first.** Before W1 splits the handlers, it records each handler's output from the pre-refactor code over a fixture corpus. That corpus covers boundary samples, nulls, empty windows, stale snapshots and every operator. The refactored `evaluate` and `evaluateLoaded` must both reproduce those outputs. Otherwise the parity tests would compare the refactor only against itself.

### 3.4 Diff: only changed verdicts do work

Two statements per batch load the prior state:
- `monitor_device_state` for **every** monitor on the batch's devices (`device_id = ANY(batch)`, via `monitor_device_state_device_idx`), not only the monitors in this pass's scope. Detach needs the rows that have left scope. Columns: `last_state`, `current_episode_id`, `escalated_at`, `escalation_alert_id`, `last_evaluated_at`.
- Open alerts: `rule_id, device_id, subject_key, status, requires_human` where `rule_id = ANY`, `device_id = ANY` and the status is open. This is backed by `alerts_open_rule_device_subject_uidx`.

**Two classifications, copied exactly from today's code. They are not the same thing:**
- **Subject reconciliation** is keyed on the **evaluation result**, `result.subjects !== undefined` (`alertService.ts:1358`), not on the monitor kind. `evaluateConditions` surfaces subjects only when the root is a single leaf (`alertConditions/index.ts:331`). A composite or array that contains a hardware leaf therefore takes the non-subject path today, and keeps doing so.
- **Maintenance pass-through** is keyed on the **monitor kind**, `isSubjectMonitorKind(monitor.kind)` (`alertService.ts:1327`).

**Open-alert identity follows `createAlert`'s dedupe** (`subject_key IS NOT DISTINCT FROM`, `alertService.ts:271`). A non-subject pair's "has an open alert" check requires `subject_key IS NULL`. A subject pair's open set excludes NULL-subject alerts, matching `alertSubjects.ts:70-73`.

**A pair needs work when the observation would change any non-timestamp column that `recordMonitorEvaluation` writes, or when today's every-minute pass would attempt a side effect:**

| Rule kind | Work predicate |
|---|---|
| Monitor, non-subject | No state row; **or** the observation (`breach`/`ok`/`unknown`, the mapping at `alertService.ts:1407-1411`) differs from `last_state`; **or** `breach` with `current_episode_id` null. That last case is the re-attach after a detach: `detachMonitorFromDevice` clears the episode but leaves `last_state = 'breach'` (`episodeService.ts:398-406`), and today's next breach opens a new episode. **Or** `ok` with `current_episode_id` set, a defensive repair; **or** `breach` with no open alert, which retries the create exactly as today's every-minute attempt does when an earlier attempt lost to cooldown, flapping, dedupe or publish rollback; **or** `breach` while `escalated_at` is set and `escalation_alert_id` is null, which is the latch retry (`episodeService.ts:258,333`). |
| Standalone (non-monitor) | `triggered` with no open alert for (rule, device) |
| Subject (result carries `subjects`) | A breaching subject has no open alert for its `subject_key`; **or** `autoResolve` holds and an open, non-requires-human subject alert reports `recovered`; **or** the predicted final observation differs from `last_state`; **or** the predicted observation is `breach` and `current_episode_id` is null (the same re-attach case). The prediction uses `evaluateSubjectAlerts`' rule (`alertSubjects.ts:85-87`) over the unchanged open set. |

Any other pair costs nothing: no write, no Redis call. That is the change that ends O(devices × rules) bookkeeping. `last_evaluated_at` freshness is OD5. The work predicate is a pure function. W3's shadow (§3.13) checks it against the legacy path's actual writes, so a missing row in this table shows up as a mismatch, not as silence.

**Maintenance.** New `resolveMaintenanceConfigForDevices(deviceIds)` is parity-tested against `resolveMaintenanceConfigForDevice` (`featureConfigResolver.ts:1057`) and feeds the same `isInMaintenanceWindow` (`:2942`). For a device in a suppressing window:
- **Non-subject rules are skipped entirely:** no episode write and no alert, matching `alertService.ts:1327`.
- **Subject rules drop their breaching subjects before the work predicate, but recovery work still runs,** with no `recordMonitorEvaluation`.
- **Detach is skipped for that device.**
- **The window's end is a deadline.** The pass records the suppressing window's end (and a pending window's start) as a `flipsAt` for the device (§3.9). Suppressed work then resumes on the next tick after the window closes, as it does today, and does not wait for a backstop.

### 3.5 Act: today's pipeline, unchanged

- **Each work pair runs `evaluateRuleForDevice`** (#10864) in its own system context. A new optional `preEvaluated: EvaluationResult` lets the non-subject path skip re-reading.
  - **Unchanged order inside a pair:** episode seam, latch, `createAlert`, `linkEpisodeAlert`.
  - **Failure isolation from #10864 holds:** the catch sits outside the context, so a failure costs one pair.
  - **The subject path ignores `preEvaluated`.** It takes the advisory lock and the savepoint, and re-reads that one device's evidence under the lock, exactly as today (`alertService.ts:1358-1390`).
  - **The act context re-reads the device row** (one indexed read), the way the per-device prelude does today. A device moved to another org between the batch load and the act therefore writes its alert and episode under its current org, not a stale one. Act pairs are rare, so this costs almost nothing.
- **Execution fencing.** Row locks serialize writes, but they do not stop an **older** verdict from landing after a newer one. Example: a batch loads `breach`, a second batch loads `ok` and closes the episode, then the first batch commits `breach` and re-opens it. Two fences prevent this:
  1. **Partition lease, for efficiency.** Every batch for (partner, partition) runs under a Redis lease: `SET alert:lease:{partnerId}:{partition} <token> NX PX <ttl>`, renewed between act pairs. A dirty, due or cadence job that cannot take the lease re-enqueues itself with a short delay. Normally, then, only one batch works a device at a time.
  2. **Evidence-time fence, for correctness.** The lease can expire under a stalled worker, so it is not the guarantee. Each verdict carries the `evaluatedAt` of its load. `recordMonitorEvaluation` gains an optional `observedAt`. Under its existing `SELECT … FOR UPDATE` (`episodeService.ts:154-163`) it **drops the observation when `state.last_evaluated_at > observedAt`**, because a newer verdict has already been applied, and the caller then skips `createAlert` for that pair. For this to work, every applied or touched pair must stamp `last_evaluated_at` with its evidence time, not wall-clock time (OD5). Standalone rules have no state row. For them a stale `breach` can at worst create an alert that auto-resolve clears on its next run, which is today's behaviour when an on-demand evaluation races the sweep. The subject path needs no extra fence: its re-read under the advisory lock already is one.
- **Engine ownership is checked when a job runs, not only when it is enqueued** (§3.13). A legacy `evaluate-device` job that was delayed by the stagger, and starts after its partner has moved to the set engine, does nothing. The reverse holds too.
- **Detach is set-based and scope-based.** From the state rows already loaded, any (monitor, device) with `current_episode_id IS NOT NULL` that is outside this pass's resolved scope gets `detachMonitorFromDevice`, with three guards:
  - The device's scope resolved (not `device_missing`).
  - The device is not in maintenance.
  - `network_check` monitors count as in-scope here, as they do today (`alertService.ts:1334-1340`), because the network sweep owns their detach.

  Every pass resolves scope in full and only *loading* is limited to due families, so detach is correct on any pass. It also gives #10864's "counted as evaluated before its rule runs" semantics by construction: a failed evaluation of an in-scope monitor never detaches it.
- **Outbox.** After a batch's act contexts have committed, the batch job runs `drainSubjectAlertOutbox({ deviceIds })` with no ambient context, and only when subject work happened. The function still refuses an ambient context (`subjectAlertOutbox.ts:53`), and its signature grows from one `deviceId` to a list. The fleet-wide drain on the minute tick stays as the safety net (`alertWorker.ts:173-178`). This removes about 12 statements per device per minute.

### 3.6 Auto-resolve, set-based

`checkAllAutoResolve` becomes a paged job of its own. It pages active, non-subject, non-requires-human alerts that have a `rule_id`, by device. It groups them into batches, loads the families their auto-resolve trees need (the trigger tree when `autoResolveConditions` is null), evaluates them with the shared evaluator, and calls `resolveAlert` per alert. The compare-and-swap is unchanged.

It stays a separate job rather than folding into the main pass, because it must also cover devices the main pass does not visit. A threshold alert on a device that has gone offline resolves today once its window empties, and the new job keeps that. Pairs the main pass did evaluate reuse that verdict instead of re-loading (OD7). Which condition auto-resolve uses, base or effective, is OD6.

**Every gate in `checkAutoResolve` (`alertService.ts:559-650`) carries over unchanged:**
- **Which alerts qualify:** `status = 'active'` only, no `subject_key`, not `requires_human`, and a `rule_id`.
- **The rule can be inactive or retired.** The rule is read by id with no `is_active` or `retired_at` filter (`:591-596`), so an alert whose rule was deactivated still auto-resolves. The new job keeps this, so its rule set differs from the main pass's.
- **The `autoResolve` flag must be on** (override, else template; `:613-617`).
- **An explicit `autoResolveConditions` tree resolves when it triggers.** With no explicit tree, the alert resolves when the trigger tree does **not** trigger, and that includes evidence that came back `unknown` or empty. Today an alert whose window has emptied resolves. That inverse behaviour stays even though it looks odd.
- **A reused verdict must match exactly:** the same condition tree (after OD6), and an `evaluatedAt` within the same tick. Anything else is re-loaded.

The one deliberate change is OD6.

### 3.7 Network checks (#6353)

`evaluate-network-checks` stays one job per org (`alertWorker.ts:315-355`, `monitors/networkCheckAlertSweep.ts`). It keeps one verdict per org on the alert device, and still evaluates that device when it is offline. The device sweep keeps excluding `network_check` from evaluation while counting it as in scope for detach. The network sweep keeps owning its own detach (`networkCheckAlertSweep.ts:212-239`).

A late wave changes two things:
1. **Alert-device choice reads a batch scope map.** Today it can cost up to 101 `resolveMonitorsForDevice` calls (`networkCheckAlertDevice.ts:106-126`, `NETWORK_CHECK_ALERT_DEVICE_FALLBACK_SCAN = 100`). The new version builds one `resolveMonitorsForDevices` map over the legacy pick plus the same 100 most recently seen non-ephemeral devices, offline ones included. The selection is **identical**: the legacy pick if the monitor resolves to it, otherwise the first of those 100, ordered by `last_seen_at DESC, enrolled_at DESC`, that it resolves to, otherwise none. Widening the scan to the whole org would change which device carries the alert, and that would be a separate product decision. The handler gate and the sweep keep calling the same function, so they cannot disagree.
2. **One statement reads the latest N results for all of the org's managed checks.**

A `network_monitor_results` insert in `monitorWorker` marks the org dirty, which enqueues its job early (deduped by job id). The 60 s cadence stays.

### 3.8 On-ingest triggering, change cursor and dedupe (deliverable b)

- **`markAlertDirty({ deviceId, partnerId, family })` runs through `runAfterDbContextCommit`** (`db/index.ts:862`). It runs only after the ingest transaction commits, and never inside a held context. It touches Redis only, never awaits in the request, and never throws, like `requestDeviceGroupReevaluation` (`heartbeat.ts:1803`).
- **Seams (verified single writers):**
  - `hardwareHealth/ingest.ts`, `timeSync/ingest.ts`, `workloads/ingest.ts`
  - The server-side image-currency pass (`imageCurrency/pass.ts`), which writes `upstream_status` and `behind_since` without any agent ingest
  - The `securityPosture.ts` snapshot write
  - `routes/agents/helpers.ts` (`security_status`)
  - The heartbeat's service/process check insert
  - `routes/agents/eventlogs.ts`
  - `softwareInventoryObservations.ts`
  - The heartbeat's offline→online transition
  - `monitorWorker`'s network results
- **Not dirty-marked:**
  - **`device_metrics`.** Every online device writes a row every 60 s (`heartbeat.ts:1857-1888`), so a mark would only duplicate the cadence pass.
  - **`backup_jobs` and `script_executions`.** Each has at least nine writers. They stay cadence-only until each has a single terminal seam.
- **Store and dedupe.** Per partner there is a ZSET `alert:dirty:{partnerId}` with member `{family}:{deviceId}` and score = the **latest** change time in epoch ms, written with `ZADD … GT` (Redis ≥ 6.2; the shipped stack runs 7). There is one entry per (device, family) however many writes land, and its score only ever moves forward. `SADD alert:dirty-partners {partnerId}` records which partners have pending marks.
- **When marks are claimed.** By default they ride the partition's **60 s pass** (§3.10). That pass already runs for the windowed families, and it loads the snapshot families only for the partition's dirty, due or backstop-due devices. Marks therefore add no statements, and a snapshot change is seen within 60 s, as it is today.
  - **For lower latency, or under OD4(a)** where the minute pass slows down, `ALERT_EVAL_DIRTY_FLUSH_MS` > 0 (default 0, off) turns on a repeatable `alert-dirty-flush` job. It enqueues one `evaluate-dirty` job per dirty partner with `jobId = alert-dirty:{partnerId}`. BullMQ ignores the duplicate while one is pending, the same trick #10864 uses with device-keyed job ids.
- **Claim and acknowledgement**, whichever job claims:
  - **Reading the marks.** It reads members with `score ≤ claimTs` (`ZRANGEBYSCORE`), where `claimTs` is taken **before** its family loads. It groups them by partition, takes each partition's lease, and runs scope plus the rules that reference the dirty families (§3.3) for the dirty devices.
  - **Acknowledging.** Only after a partition's act contexts commit does a Lua script remove each member, and only **if its score is still the score that was read**. A write that landed during the run raised the score, so its member survives and is evaluated on the next pass.
  - **Why not timestamps.** A plain "drop anything older than the last cadence pass" rule would lose a change made after that pass read its data. The compare-on-acknowledge closes that gap.
- **The change cursor.** The member's score is the per-device change cursor: "unevaluated change as of T". A device with no new data since its last evaluation has no member and is skipped. A durable table is the alternative (OD2).
- **Loss model.** Marks are **hints**. The due sweep (§3.9) and the cadence backstop (§3.10) are complete and authoritative. A mark can be lost to a Redis flush, or to a crash between the commit and the `ZADD`. Either way the evaluation is delayed until the next backstop pass, at most `ALERT_EVAL_SNAPSHOT_BACKSTOP_MS` (default 300 s).
  - **A transient breach can be missed outright.** If its mark is lost and it starts and clears entirely between two backstop passes, nothing sees it. Today's sweep would have caught any breach lasting a minute or more.
  - **Why accept this.** It is the price of keeping ingest free of an extra DB write. Codex disagrees with that price (OD2).
- **Config-change invalidation.** Some writes change *scope* rather than evidence:
  - alert rules and templates;
  - monitor definitions and attachments;
  - configuration-policy assignments and maintenance settings;
  - device-group membership;
  - a device's site, role or org.

  Every pass resolves scope in full, so the windowed families pick these up within 60 s on their own. The snapshot families, however, load only for dirty or due devices. These writes therefore call `markAlertScopeDirty(partnerId)` after commit, which sets a partner-wide "all families" flag that the next pass of each partition consumes. A newly attached hardware monitor, or an alert a technician resolved by hand on a still-breaching pair, is then evaluated within 60 s, not after a backstop.
- **Overlapping runs.** Dirty, due and cadence work for the same partition is serialized by the partition lease (§3.5). If a lease expires, the evidence-time fence still keeps an older verdict from overwriting a newer one. Beneath both, the existing guards hold:
  - `recordMonitorEvaluation`'s row lock;
  - `createAlert`'s `ON CONFLICT … DO NOTHING` on the open-identity index;
  - the subject advisory lock.

### 3.9 The time-based sweep as one query (deliverable c)

Some verdicts flip with no new data:
- **Windows:** metrics, event logs, process resources.
- **Freshness:** hardware at 3× the poll interval, time-sync staleness, the patch snapshot's 24 h, scripts at 3× their interval.
- **Ages:** antivirus definitions, last successful backup, days a container image is behind, certificate expiry.
- **Liveness:** offline.

None of these gets a per-device timer, and none needs a per-device query. Two mechanisms cover them:

1. **Deadlines.** `evaluateLoaded` returns `flipsAt`: the earliest moment its verdict could change with no new data.
   - **Hardware:** component `last_seen_at` + 3× the poll interval.
   - **Time sync:** `received_at` + the staleness window.
   - **Patch:** `captured_at` + 24 h.
   - **Container:** `behind_since` + `minDaysBehind`.
   - **Certificate:** `mtls_cert_expires_at` − `withinDays`.
   - **Antivirus:** `definitions_date` + `staleAfterDays`.
   - **Backup:** last success + `maxAgeHours`.
   - **Script:** completion + 3× its interval.
   - **Offline:** `last_seen_at` + `durationMinutes`.
   - **Maintenance:** the window's end (§3.4).

   The batch writes each partition's minimum into `alert:due:{partnerId}` (member = partition). A pass that covered the whole partition replaces the score; a partial pass merges with `ZADD LT`. On every 60 s tick, **one** `ZRANGEBYSCORE … now` per partner returns the partitions that are due. Each due partition's batch re-evaluates the rules whose deadlines passed. So a staleness or age transition is seen within a minute, as it is today.
2. **The backstop.** The cadence pass (§3.10) re-evaluates the whole scope set-based. That is exact for every family, at O(batches) cost. It is the authority behind both the deadlines and the dirty hints.

Sliding windows on the metric families need no deadline, because those families run every 60 s anyway (§3.10).

**The query is the family loader over a batch.** Boundary families read columns the batch hierarchy already has: `mtls_cert_expires_at`, and `last_seen_at` for offline. They cost no extra statement.

**The offline detector is unchanged.** `offlineDetector.processDetectOffline` is already one query over `last_seen_at` every 30 s, and it feeds a durable effects store that raises the offline alerts (`jobs/offlineDetector.ts:278-330`, `services/offlineAlertEffects.ts`). Separately, today's sweep evaluates `offline` leaves on **online** devices. They come out `ok` (which closes an offline monitor's episode on reconnect) or, with a rule duration under 5 minutes, `breach`. This engine evaluates those leaves the same way. The online-transition mark brings the `ok` forward to the next flush.

### 3.10 Per-rule cadence (deliverable d)

A leaf's cadence comes from its family. Detection latency for windowed rules is OD4.

| Leaf | Trigger | Backstop |
|---|---|---|
| Windowed (`threshold`, `bandwidth_high`, `disk_io_high`, `network_errors`, `event_log`, `process_*_high`) | **60 s, today's latency** (OD4(b), recommended). A tunable, `ALERT_EVAL_WINDOW_CADENCE`, can switch to `clamp(window / 5, 60 s, 300 s)` (15 min → 180 s, 30 min → 300 s), but it is off by default. | — |
| `service_stopped`, `process_stopped` | Dirty: heartbeat check results | 300 s |
| Snapshot families (hardware, time sync, container, patch, antivirus, software) | Dirty, plus deadlines (§3.9) | 300 s (`ALERT_EVAL_SNAPSHOT_BACKSTOP_MS`) |
| `backup_continuity`, `script_monitor`, `cert_expiry` | Deadlines | 300 s |
| `offline` leaves | 60 s, with the metrics families, plus the dirty online transition | — |

- **A rule's cadence is the minimum over its leaves.** Rules fall into a few cadence buckets. Every pass resolves scope in full, so detach stays correct on any pass (§3.5).
- **The 60 s `evaluate-all` tick stays the clock.** Each tick fans out:
  - the 60 s bucket's partitions;
  - the due partitions (§3.9);
  - every fifth tick, the backstop bucket.

  Batch start offsets reuse #10864's stable-hash stagger (`evaluateDeviceStaggerDelayMs`).
- **The cadence mechanism is what the issue's point 4 asks for.** Per-rule cadence buys little on the metric families once evaluation is set-based. A 60 s metrics pass at 10k devices is roughly one aggregate statement per partition (§3.14). The real savings come from the snapshot families, which drop from 60 s polling to "dirty, plus deadline, plus a 300 s backstop". That is 9 of the 13 built-ins.

### 3.11 Horizontal scaling

Batch jobs are independent and idempotent. BullMQ spreads them across worker containers, and each one holds one pooled connection at a time. The planner pages the eligible devices (id, org, partner) by keyset, one read per 500 devices, and assigns them to partitions in memory. On top of that it makes O(partners) Redis calls: the due set, the dirty partners and the ownership records. With per-device cost close to zero, workers scale the remainder linearly, which is the issue's point 5.

### 3.12 Contracts that must survive, and the exact seam (deliverable e)

| Contract | Seam in this design |
|---|---|
| Cooldown and flapping gate the alert, never the episode (#5290) | The act path is unchanged: `recordMonitorEvaluation` runs before `createAlert`, which holds cooldown and flapping (`alertService.ts:253-296`), inside `evaluateRuleForDevice`. The diff never skips a pair whose observation changed. |
| A non-triggering evaluation closes the open episode | `ok ≠ last_state(breach)` is a work pair, so `recordMonitorEvaluation('ok')` closes the episode (`episodeService.ts:202-234`). `unknown` stays observe-only (`:177-199`). |
| The detach scan closes `monitor_detached` | Scope-based detach (§3.5) calls the same `detachMonitorFromDevice`, with #10864's "in scope means not detached" semantics. |
| Recurrence latch and its retry | Work predicate row 1 (`escalated_at` set, `escalation_alert_id` null). The subject kinds keep `stagePendingSubjectEscalations` in the outbox drain. |
| Subject alerts: advisory lock + savepoint; outbox drains only after commit | The batch only gates *entry*. Inside, the lock, savepoint, re-read, `evaluateSubjectAlerts` and `recordMonitorEvaluation` are unchanged. The drain runs after the batch's contexts commit, with no ambient context. |
| Network checks: one verdict per org on the alert device (#6353) | §3.7. The device sweep excludes `network_check` from evaluation and includes it in detach scope. The network sweep owns its evaluation and its detach. |
| Maintenance suppresses new breaches but still evaluates recovery | §3.4. Non-subject rules are skipped. For subject kinds (by monitor kind, as `:1327`), breaches are filtered out while recovery runs. Detach is skipped. The window's end is a deadline, so suppressed work resumes on the next tick. Legacy alerts keep recovering through the auto-resolve job, which does not check maintenance today (§3.6). |
| No older verdict overwrites a newer one | §3.5. The partition lease prevents overlap. The evidence-time fence (`observedAt` against `last_evaluated_at`, under the existing row lock) guarantees order when a lease expires. The subject path re-reads under its lock. |
| Partner-wide rules reach devices through the partner, org rules through the org (#2128) | The ownership predicate in §3.2 step 2 and the partner target in step 3, fanned out by the **device org's** partner. Alerts and episodes always take the **device's** org (`alertService.ts` `createAlert` `orgId: device.orgId`; `episodeService.ts` header). |
| RLS / system context (`docs/agents/tenancy-rls.md`) | Workers only, under `withSystemDbAccessContext`, as today. A batch never crosses partners. Inside a batch, ownership is re-applied **per device** (§3.2 step 2), because the system context will not catch a rule leaking across orgs. Request-path code is unchanged. No new table needs a policy. |
| Quick Support, holding and unassigned-pool exclusions | Org-level and device-level eligibility (§3.1). The partner target is withheld (`MONITOR_APPLICABILITY`). |
| An inactive rule raises nothing (#7626); publish or roll back (#5241) | Both are inside `createAlert`, unchanged. |
| #10864 context scoping | One context per unit, failures contained per pair, no context across Redis, concurrency sized from the pool. |

### 3.13 Shadow mode and rollout (deliverable f)

- **Flags:**
  - `ALERT_EVAL_ENGINE` = `legacy` (default) | `shadow` | `set`.
  - `ALERT_EVAL_SET_PARTNERS` is a partner-id allowlist for staged `set`.

  Both are registered in `system/connections/internalEnvVars.ts`.
- **Ownership is exclusive, and checked when each job runs.** The env flags set the *desired* engine. The *runtime* owner is a Redis record, `alert:engine:{partnerId} = {engine, generation}`, which the planner writes when the desired engine changes. Every legacy `evaluate-device` job and every set-engine batch reads the record **when it starts**, and does nothing if it is not the owner. A flip:
  1. writes the record with generation + 1;
  2. waits one stagger window (≤59 s, the longest a delayed legacy job can be pending, per #10864's clamp) plus the partition lease TTL;
  3. only then lets the new owner act.

  So jobs that were pending before the flip, and replicas running mixed versions during a rolling restart, cannot both act on one device. A replica that predates the record is the one gap: it treats the record as absent, and absent means legacy. The cutover therefore ships the record-reading code first and flips only after every replica runs it.
- **The shadow has two comparators (OD8):**
  1. **In-job parity, deterministic, on the same before-state.** A sampled fraction of legacy `evaluate-device` jobs (`ALERT_EVAL_SHADOW_SAMPLE`, default 0.05) first runs the set engine read-only for that one device: scope, then load, then evaluate, then the diff against the **current** state and open alerts, which produces a predicted plan. Then the legacy pass runs with its writes instrumented. Comparing a plan against state that legacy has already changed is meaningless, so the plan is always computed **before** the legacy pass writes. The comparator checks:
     - **Scope:** rule ids, effective condition and severity.
     - **Verdicts:** `triggered`, `dataState`, subject keys and statuses.
     - **Predicted plan vs legacy's actual writes:** create, resolve, open or close an episode, detach, latch.

     The two reads are milliseconds apart. A mismatch is a bug, except near a window or freshness boundary, which is tagged `boundary`. Real multi-device batches are covered by the second comparator and by §7's integration tests, not by this batch of one.
  2. **Pass-level reconciliation.** The set engine runs its real batches read-only on its own cadence. It records predicted actions to a capped Redis stream (`alert:shadow`, `MAXLEN ~ 100k`). A reconciler job matches them against what legacy actually wrote (alerts created or resolved, episodes opened or closed) within ±(cadence + 60 s). It reports counts by family and diff class to logs and metrics, plus throttled Sentry samples.

  **Known-difference classes do not count against the gate.** There are two: the auto-resolve override fix, if OD6(a) lands in the set engine before the legacy fix ships, and latency on snapshot families between the dirty hint and the deadline (§3.9–3.10). With OD4(b) and OD5(c) as recommended, windowed latency and `last_evaluated_at` are **not** known differences. They must match.
- **Cutover gate.** Shadow runs fleet-wide for ≥7 days and must show:
  - scope parity at 100% on sampled devices;
  - unexplained verdict mismatches below 0.01%;
  - every mismatch class triaged.

  Then `set` rolls out partner by partner through the allowlist, starting with an internal test partner. Then `set` becomes the default. Legacy stays for one release, then it is removed.
- **Rollback is `ALERT_EVAL_ENGINE=legacy`, through the same fenced flip.** The set engine writes only the rows legacy writes, with the same semantics. Its new state is all advisory: dirty marks, deadlines, leases and the shadow stream. Legacy needs none of it. The flip is not instantaneous: it takes one fence interval, about 1–2 minutes.

### 3.14 Cost model (deliverable g, inferred)

**Assumptions:**
- The 13 built-ins.
- 10–25 ms per round trip.
- Windowed families at 60 s (OD4(b)). Snapshot families dirty, due, or on the 300 s backstop.
- **Batches B = Σ over partners of ⌈devices_p / 500⌉.** One large partner gives fleet / 500. A long tail of small partners gives roughly one batch per partner. Both ends are shown.
- A minute pass costs ~25 statements per batch:
  - scope ~11;
  - the metrics aggregate 1;
  - state 2;
  - the `last_evaluated_at` touch 1 (OD5(c));
  - snapshot loaders for dirty or due devices ~2 on average;
  - context overhead ~8.
- The backstop adds ~6 snapshot loaders per batch every 5 minutes.
- Delta rate: 0.1% of (rule, device) pairs need work per minute, at ~12 statements each. That covers new breaches, recoveries, create retries and latch retries. Shadow measures it (§3.13), and it is a gating metric.

| | Today, 1k devices | Today, 10k devices | Set-based, 1k (B = 2–20) | Set-based, 10k (B = 20–300) |
|---|---|---|---|---|
| Read statements per minute | ~235k | ~2.35M | ~50–520 | ~520–7.8k |
| Act statements per minute | in the line above | in the line above | ~160 (13 pairs) | ~1.6k (130 pairs) |
| Row writes per minute from the `last_evaluated_at` touch | ~13k, as per-pair transactions | ~130k, as per-pair transactions | ~13k, in B statements | ~130k, in B statements (HOT; OD5) |
| Outbox drain | ~12k statements per minute | ~120k | the fleet-wide minute drain, plus drains after subject work only | same |
| Pooled connection time per minute | 2,000–6,000 s | 20,000–60,000 s | ~0.1–6 s, plus ~2–4 s of acts | ~1–45 s, plus ~16–40 s of acts |
| Connections held continuously | 33–100 | 330–1,000 | ≈0.03–0.2 | ≈0.3–1.5 |
| Dominant data read | n/a (latency-bound) | n/a | ~30k `device_metrics` index tuples per minute | ~300k per minute (PK `(device_id, timestamp)` range scans over the 30-min disk window) |

**Batch cost.** A batch costs about 60–300 ms of connection time: scope ~30–80 ms, the metrics aggregate over up to 500 devices × 30 rows ~20–60 ms, the touch ~20–50 ms, and each snapshot loader ~10–30 ms. Small-partner batches sit at the low end.

**Not bounded by the statement count.** That count is constant per batch, but the work behind it is not:
- **Subject cardinality.** Up to 2,000 components per hardware snapshot (`packages/shared/src/validators/hardwareHealth.ts:20`).
- **Raw-window rows** for `network_errors`, which cannot be pushed down.
- **The auto-resolve job**, which scales with open alerts.
- **Retry storms.** A pair held off by cooldown attempts a create on every pass, as it does today. A Redis `MGET` prefilter on cooldown keys can cut that if it shows up.

W3's shadow and the W-late load test measure all four. Loaders also cap their parameter lists at `ALERT_EVAL_MAX_LEAF_REQUESTS` (default 5,000 device × leaf pairs per statement) and split above that.

**What remains scales with alert churn and partner count, not fleet × rules.** At 10k devices with a long tail of partners, the per-batch fixed cost and the act term are the same order of magnitude. Both are a small fraction of a pool.

## 4. Tenancy and data model impact

**Recommended design: no new table, no new column, no migration.**

- **Reads.** Batch reads cross orgs **within one partner**, only inside worker `withSystemDbAccessContext`, and only to compute scope. That is the same trust boundary today's per-device worker already runs under. Nothing changes on the request path.
- **Writes.** Writes land in the same rows and the same tables as today (`alerts`, `monitor_device_state`, `monitor_episodes`), always with the **device's** org. Their cascade, merge and export registrations are untouched.
- **Redis keys.** The new keys hold only ids (partner, device, partition, family), timestamps and engine names. They hold no customer content:
  - `alert:dirty:{partnerId}` and `alert:dirty-partners`;
  - the partner-wide scope flag;
  - `alert:due:{partnerId}`;
  - `alert:lease:{partnerId}:{partition}`;
  - `alert:engine:{partnerId}`;
  - the capped `alert:shadow` stream.
  - **Erasure.** A deleted device's member is dropped at claim time, because scope reports it missing. The stream is capped and has a TTL.
  - **Org move or merge.** Marks are keyed by partner. A device that moves partner leaves a stale member behind, which is dropped at claim. The new partner's cadence pass covers the device.
- **Indexes.** The loaders use the per-device handlers' own predicates over `= ANY` / `LATERAL`. They therefore need the same leading-`device_id` indexes that already back today's queries, for example `security_posture_snapshots_device_captured_idx` and the `device_metrics` PK. W1 runs EXPLAIN probes for each, following the `agentHotPathQueryBudget.integration.test.ts` pattern, and adds an index only if a probe shows a sequential scan.

**If an Open Decision lands on a schema option:**
- **OD2(b), a durable cursor table `device_alert_eval_cursors`.**
  - It is per-device state, not config, so partner-wide-first does not apply (same as `monitor_device_state`).
  - Shape 1 (direct `org_id`), with columns (`device_id` PK, `org_id NOT NULL`, `data_changed_at`, `evaluated_at`, `families_dirty int`).
  - Composite FK `(device_id, org_id) → devices(id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`.
  - RLS enabled and forced with `breeze_has_org_access(org_id)`, in the creating migration.
  - Registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` (`repoint`), `CORE_TENANT_EXPORT_POLICY` (every column `included`; a jsonb family map would be `excludedOpen`), `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES` and `DEVICE_ORG_FK_CASCADE_TABLES` (the database restamps).
  - Written on every evaluation, so it reintroduces per-device writes. Codex's variant also writes it inside every ingest transaction that changes evidence, alongside a durable pending-work row (§8).
- **OD4(c), a cadence override `monitor_definitions.evaluation_interval_seconds integer NULL`.**
  - The column goes on an existing partner-wide-first config table (`org_id` XOR `partner_id`, `monitor_definitions_one_owner_chk`). That table is in the org cascade, so the column needs an export-policy classification (`included`).
  - Writes go through the existing monitor routes and the `canManagePartnerWidePolicies` gate.
  - Setting home: the monitor editor, with the monitor as the single level (settings rule 9: one place before, one after).

## 5. Out of scope

- **The offline detector's breach path.** It is already set-based and durable (`jobs/offlineDetector.ts`, `services/offlineAlertEffects.ts`).
- **Alert producers that never go through `evaluateDeviceAlerts`:** `createSourcedAlert` callers, patch and policy/config-compliance bridges, `dns_threat`, topology, metric anomaly, backup workload.
- **Incremental or streaming aggregates, and using `metric_rollups` for long windows.** An average of rollup averages is not the handler's average, so parity would break.
- **Evaluating offline devices' snapshot monitors.** Eligibility stays exactly as today. This would be a product change.
- **Cooldown, flapping and state-transition storage (Redis) and their semantics.** Notification dispatch and correlation are also out.
- **Agent changes.** There are none.
- **UI changes.** Only the OD5 wording, if (b) is picked.

## 6. Open Decisions

**OD1 — Where condition semantics live.**
- (a) Batch loaders plus the existing handler logic, refactored into pure `evaluateLoaded` functions. Both engines share one implementation, and SQL pushdown is used only for exact aggregates (§3.3).
- (b) One SQL query per condition kind that returns the breaching devices, as the issue words it.

**Recommend (a).** Composite trees, attachment overrides, subject evidence and template context make (b) a second implementation of 20 handlers that would drift. (a) also makes shadow parity meaningful.

**OD2 — The per-device change cursor.**
- (a) The Redis dirty ZSET as a hint, with the complete deadline and backstop passes as the authority. Each mark's score is the latest change, and acknowledgement is compare-on-ack. No schema change.
- (b) A durable `device_alert_eval_cursors` table (§4), or durable evidence revisions with pending-work rows written in the ingest transaction, with leased claims and conditional acknowledgement. This is codex's position.
- (c) Two timestamp columns on `devices`.

**Recommend (a). Still open: codex recommends (b).**
- **The case for (a).** It keeps every ingest path free of an extra DB write. The 300 s backstop bounds a lost mark's delay. Redis is already the BullMQ store: losing it loses queued jobs anyway.
- **The case for (b).** It is exact. It cannot miss a transient breach whose mark was lost (§3.8), and it does not depend on Redis for correctness.
- **What (b) costs.** One upsert per snapshot ingest, cheap at snapshot rates, and one per heartbeat that carries service or process check results. It also needs a new tenant table with every registration in §4.
- **(c)** widens the hottest row in the schema and adds export-policy columns. It is not recommended by either side.

**OD3 — The batch unit.**
- (a) One partition of one partner: about 500 devices in a stable hash bucket, spanning the partner's orgs, with ownership re-applied per device.
- (b) One org, chunked.
- (c) One rule (or one rule × condition variant) across every device it reaches.

**Recommend (a).** Partner-wide rules dominate. (b) costs a fixed scope load per org, and most orgs are small. (c) repeats scope and shared loads once per rule. Codex agrees, and adds that rows and parameter cardinality must also be bounded (`ALERT_EVAL_MAX_LEAF_REQUESTS`, §3.14).

**OD4 — The latency budget for windowed rules.**
- (a) Derived from the window, `clamp(window / 5, 60 s, 300 s)`. A 15-min average is checked every 180 s.
- (b) Keep 60 s for every windowed rule. Per-rule cadence then applies to the snapshot families, which become dirty, plus deadline, plus a 300 s backstop. Option (a) ships behind a tunable that is off by default.
- (c) (a) plus a per-monitor `evaluation_interval_seconds` override.

**Recommend (b). Changed from (a) after the quorum.** Codex: the window's length alone does not justify slower detection. Once evaluation is set-based, a 60 s metrics pass costs about one aggregate statement per partition, so (a) saves little. (a) is also a visible latency change that would need its own known-difference class in shadow. The issue's direction ("a 15-minute-average rule does not need a 60 s tick") favours (a), so **Todd should confirm**. (c) adds a setting nobody has asked for.

**OD5 — `monitor_device_state.last_evaluated_at`**, which the UI shows as "last checked" (`MonitorActivityTab.tsx`, `DeviceMonitoringTab.tsx`).
- (a) Touch it in one batched `UPDATE … FROM unnest` per batch, only where it is older than 10 minutes. "Last checked" becomes accurate to within 10 minutes.
- (b) Write it only on a change, and relabel the UI "In this state since".
- (c) Stamp every evaluated pair with its evidence time on every pass, batched into one statement per batch.

**Recommend (c). Changed from (a) after the quorum.**
- **Accuracy.** It keeps the field truthful, so shadow can compare it exactly.
- **Fencing.** It gives the evidence-time fence (§3.5) a monotonic stamp on every pair.
- **Cost.** The cost is row churn (~130k HOT updates a minute at 10k devices), not connection time, since it is one statement per batch.

The W-late load test measures the WAL and vacuum cost. If that is material, switch to (a) and accept a fence that is coarser by up to 10 minutes.

**OD6 — Which condition auto-resolve evaluates.**
- (a) The effective condition, with attachment overrides applied. This fixes the drift found in §1.
- (b) Keep today's `rule.overrideSettings.conditions ?? template.conditions`, for strict parity.

**Recommend (a), landed first as a small legacy-path fix.** Then the shadow gate does not need a known-difference class for it.
- **When nothing resolves.** If the alert's monitor no longer resolves to the device (it was detached, or the attachment was disabled), there is no effective override. Auto-resolve then uses the compiled base condition, which is exactly today's behaviour.
- **The quorum agreed (a)** and asked for that fallback to be specified, as it is above.

**OD7 — Where auto-resolve runs.**
- (a) A separate set-based job covering alerts on any device, which reuses the main pass's verdict for pairs evaluated this pass.
- (b) Fold it into the main pass only.

**Recommend (a).** The main pass does not visit offline devices, and today's sweep resolves their alerts.

**OD8 — The shadow comparator.**
- (a) Both: in-job sampled parity plus pass-level action reconciliation.
- (b) Pass-level only.
- (c) In-job only.

**Recommend (a).** In-job parity is deterministic and catches scope and loader bugs. Pass-level catches diff, deadline and dirty-path bugs that a batch of one cannot show. The quorum agreed. Its condition, now part of §3.13: the in-job plan is computed against the **before**-state, prior to any legacy write.

**OD9 — How rollout is controlled.**
- (a) Env flags for the desired engine and a partner allowlist, enforced at runtime by a fenced Redis ownership record (`alert:engine:{partnerId}` with a generation, checked when each job starts; §3.13).
- (b) A per-partner setting in the database, toggled from the admin UI.

**Recommend (a).** This is an engine cutover, not a product setting. The quorum agreed, on the condition that a flag alone is not enough: delayed jobs and mixed-version replicas need the execution fence. The draft lacked it, and §3.13 now has it.

**OD10 — Moving network-check alert-device resolution onto the batch scope map.**
- (a) Yes, in a late wave, after scope parity is proven.
- (b) Leave `networkCheckAlertDevice.ts` as is.

**Recommend (a).** Its fallback scan is the one remaining O(devices) resolver loop in alerting. The selection keeps today's 100-candidate window exactly (§3.7). The quorum agreed, provided the selection is preserved or any change is approved explicitly.

## 7. Test and rollout notes

**Tests:**
- **Handler parity (unit).** Every existing handler suite runs against both `evaluate` and `evaluateLoaded(load([id]))`, parametrized. Both must match the golden fixtures recorded from the **pre-refactor** handlers (§3.3). A contract test asserts every registered handler declares a family and an `evaluateLoaded`, or sits in an explicit fallback allowlist. Each loader's aggregate pushdown (threshold `avg`, `bool_and` for the every-sample kinds) is tested on its own against the row-level evaluator, including nulls and empty windows.
- **Resolver parity (integration, real Postgres).** These cover cumulative and replace inheritance, parents, disabled winners, overrides, role/OS filters, the quick-support partner exclusion, and partner-wide rules over two orgs:
  - `resolveMonitorsForDevices` vs `resolveMonitorsForDevice`;
  - `resolveApplicableRulesForDevices` vs `getApplicableRules`;
  - `resolveMaintenanceConfigForDevices` vs the per-device resolver.

  Pattern: `patchSchedulerClosestWins.integration.test.ts`.
- **Engine contracts (integration):**
  - Episodes: opened on breach, closed on `ok`, untouched on `unknown`, detached on scope removal, never on evaluation failure.
  - Cooldown gates the alert, not the episode.
  - Latch retry.
  - Subject: lock + savepoint, outbox only after commit, and no duplicates when a dirty batch and a cadence batch run concurrently.
  - Maintenance: suppressed breach, evaluated recovery.
  - Partner-wide fan-out, plus cross-partner isolation: partner B's rule never reaches partner A's device.
  - **Cross-org isolation within one partner:** org A's `target_type = 'all'` rule and org A's policy attachments never reach org B's device in the same batch (§3.2).
  - **Re-attach:** detach, then re-attach a monitor while it is breaching, and a new episode opens (§3.4).
  - **Fencing:** two batches over one device, interleaved so the older `breach` commits after a newer `ok`, leave the episode closed (§3.5). A delayed legacy job that starts after a flip does nothing (§3.13).
  - **Dirty-mark loss and races:** a write between a pass's read and its acknowledgement survives (§3.8). A dropped mark is picked up by the backstop.
  - **Deadlines:** a hardware component crossing its freshness, and a maintenance window ending, are each re-evaluated on the next tick.
  - **Composite trees:** a dirty leaf family loads the whole tree.
  - **Real multi-device batches,** not only batches of one, with mixed overrides, mixed orgs and mixed maintenance.
  - `networkCheckSingleAlertDevice.integration.test.ts` and `alertSubjects.integration.test.ts` pass on both engines.
- **Statement budget.** A batch of N devices under the 13 built-ins issues at most K read statements, independent of N. The test asserts O(1) in N.
- **Heartbeat budget.** `agentHotPathQueryBudget.integration.test.ts` is unchanged: `markAlertDirty` adds zero DB statements and runs after commit.
- **Load test.** A late wave runs 10k synthetic devices and records pool occupancy and pass duration in the plan.

**Rough waves (the plan follows approval):**
1. **W1:** golden fixtures from the pre-refactor handlers, then the handler split (`evaluateLoaded`, `flipsAt` and the family loaders), with no behaviour change.
2. **W2:** batch scope resolvers with per-device ownership, plus the parity suites; the OD6 legacy fix.
3. **W3:** the engine's read path and the before-state in-job shadow, behind `shadow`; the runtime engine-ownership record (read by legacy jobs from this wave on).
4. **W4:** diff, act, detach, the outbox drain, the partition lease and the evidence-time fence, behind `set` for allowlisted partners; pass-level reconciliation.
5. **W5:** dirty marks with compare-on-ack, deadlines, cadence buckets and the backstop.
6. **W6:** set-based auto-resolve.
7. **W7:** the network-check scope map.
8. **W8:** legacy removed, one release after `set` becomes the default.

**Operations:**
- New metrics: batch count and duration, the would-act rate, dirty backlog and age, shadow mismatches by class.
- The `pendingFromPreviousTick` warning from #10864 stays for the legacy path.

**Dependency:** #10864 (`evaluateRuleForDevice`, per-unit contexts, pool-sized concurrency) lands first. This design calls into it and does not replace it.

## 8. Advisor quorum

Independent review: `codex exec`, model `gpt-6-astra`, effort xhigh, read-only, against the first draft. Codex first recorded its own architecture, before reading the draft, then reviewed the draft. Its verdict: "Revise before implementation. The batching direction is sound; the work predicate and concurrency guarantees are incomplete." Every claim below that it labelled verified was re-checked in code before it was accepted.

**Independent position, before reading the draft (inferred):**
- Bounded batches for reading evidence, with short per-pair transactions for state changes.
- Semantics stay in the handler registry: shared pure evaluators plus batch loaders, with SQL only for indexed selection and proven-equivalent aggregates.
- Bulk reach resolution that reuses the existing inheritance and ranking.
- Durable evidence revisions and pending work in Postgres, written atomically with ingest, with Redis only for wake-ups.
- Indexed deadlines scanned every minute.
- Windowed latency preserved.
- Network checks keep their own per-org unit.

This matches the draft on the unit, on where semantics live, on bulk reach and on network checks. It differs on durable state and on latency.

**Agreed, and accepted into this revision:**
- **Factual corrections (verified):**
  - Hardware freshness can expire after 15 min, not ≥30: the poll interval minimum is 5 (`hardwareHealth.ts:19`).
  - The image-currency pass writes `upstream_status` and `behind_since`, so it is a dirty seam (`imageCurrency/pass.ts:206-215`).
  - The `offline` handler can breach while a device is `online`, so the engine evaluates it fully, not as "recovery only" (`handlers/offline.ts:32-42`).
  - The act path does call Redis inside the rule context (`alertService.ts:253,283`). The draft's "no context spans Redis" was wrong.
  - Network-check selection must keep the 100-candidate window.
- **Work predicate:**
  - Re-attach while breaching (`current_episode_id` null, `last_state` breach) is now a work row. This was found independently in self-review of the same draft, too.
  - Subject classification follows `result.subjects`, not the monitor kind.
  - The non-subject open-alert check requires `subject_key IS NULL`.
  - The state preload covers all of a device's monitors.
- **Concurrency:** older verdicts can overtake newer ones under row locks alone. Added the partition lease and the evidence-time fence (§3.5).
- **Dirty store:** `ZADD NX` with a last-pass timestamp could drop a change made after the cadence read. Replaced by latest-score marks with compare-on-acknowledge (§3.8). Dirty signals now select **rules**, and whole composite trees load (§3.3).
- **Invalidation:** config, membership, maintenance-boundary and manual-alert changes now have explicit triggers: `markAlertScopeDirty` and maintenance deadlines (§3.4, §3.8).
- **Time-based conditions:** per-device `flipsAt` deadlines and a due set scanned on every tick, instead of relying only on a backstop (§3.9).
- **Auto-resolve:** every `checkAutoResolve` gate is now listed (the `autoResolve` flag, inactive or retired rules, inverse-on-unknown, explicit trees) and is preserved (§3.6).
- **Tenancy:** batch-level candidate fetch does not establish per-device ownership. Per-device ownership and a cross-org test were added (§3.2, §7).
- **Cost:** batches are Σ per partner of ⌈devices / 500⌉, not fleet / 500. Subject cardinality, raw windows, auto-resolve, the outbox, timestamp writes and retry storms were added (§3.14).
- **Shadow and rollout:**
  - The in-job plan is computed against the **before**-state.
  - Golden fixtures come from the pre-refactor handlers.
  - Real multi-device batch tests.
  - A runtime engine-ownership record with a generation fences delayed jobs and mixed-version replicas. Rollback is fenced rather than instantaneous (§3.13).

**Disagreed: recommendation changed after the quorum:**
- **OD4, from (a) to (b).** Windowed rules stay at 60 s. Set-based evaluation makes the saving from a slower cadence small. The issue's direction favoured (a), so Todd should confirm.
- **OD5, from (a) to (c), batched.** The field stays truthful, which the evidence-time fence relies on. The load test measures the cost.

**Disagreed: still open.** OD2. Codex recommends durable revisions and pending work in Postgres, written atomically with ingest. This spec keeps Redis hints, with deadlines and a 300 s backstop as the authority. The trade:
- **Ingest write cost and a new tenant table** (which Redis hints avoid);
- **against** exactness, including transient breaches whose mark was lost, and correctness that does not depend on Redis (which durable revisions give).

**Agreed as drafted:** OD1(a), OD3(a), OD6(a), OD7(a), OD8(a). Also OD9(a) and OD10(a), with the conditions now written into §3.13 and §3.7.
