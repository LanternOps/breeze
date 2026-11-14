---
title: Built-in alert sources — recovery signals, resolvers and the lifecycle contract
status: draft (awaiting owner Gate A); quorum done 2026-11-07 (§11)
date: 2026-11-07
origin: "Owner observation 2026-10-27: two alerts on a lab device ('Patch job failed', 'Metric anomaly promoted') sat Active for a month although both conditions had cleared; follow-up §14 of 2026-10-29-alert-rearm-lifecycle-design.md ('recovery conditions for other kinds where a distinct recovery signal exists')"
related: "#10401 (compliance alert stayed active 19 days), #10538 / #10765 (alert re-arm lifecycle), 2026-09-21-metric-anomaly-episodes-design.md, 2026-09-26-ai-suggested-fixes-fix-memory-design.md, #10499 (alert → PSA ticket close-on-resolve)"
tracking_issue: (assigned by feature-lifecycle after plan approval)
effort: M (3 waves)
---

# Built-in alert sources: recovery signals and resolvers

## 1. Problem

The monitor engine owns the lifecycle of monitor-managed alerts: trigger, auto-resolve, re-arm,
cooldown, resolved partner → org → monitor (re-arm spec, #10765). Every other alert producer in
the API was excluded from that spec's *inheritance* by design (§3 non-goals, §6.7) and left with
whatever lifecycle it had written for itself. A code inventory (§2) finds 22 such producers. Ten
never resolve the alerts they create. Three more resolve them with a NULL `resolution_reason`,
which the fix-memory outcome watcher treats as "not a recovery" (fail closed), so a technician's
remediation is never credited. Two bypass `resolveAlert` with a direct UPDATE.

The user-visible symptom is an alert list that lies. "Patch job failed on KIT" stays Active and
high after the next patch job succeeds; "Metric anomaly promoted: process runaway" stays
critical weeks after the process exited. A technician cannot tell a stale alert from a live one
without opening the device, which is the failure mode the re-arm spec set out to end for
monitors.

There is also no contract. Nothing forces a new producer to say how its alerts close. The re-arm
spec's hardest-won rules (`requiresHuman` never auto-resolves, unknown data never resolves,
recovery evidence must be newer than the trigger evidence, one reason per close) apply to
monitors because the engine enforces them; a built-in producer can violate any of them silently.

## 2. Current state (verified by code read 2026-11-07; paths under `apps/api/src/`)

| # | Source · emitter | Recovery observable? | Resolve path today | Gap |
|---|---|---|---|---|
| 1 | `patch-job-finalizer` · patchAlerts.ts:256 | Yes: the device's next terminal `result` with `countsAsCompleted` (patchJobFinalizer.ts:390) | **None** | One open alert per device; a later failure dedupes onto it and is dropped (alertService.ts:279) |
| 2 | `maintenance-reboot-sweep` · patchAlerts.ts:394 | Yes: `devices.pending_reboot = false` | `resolveClearedRebootPendingAlerts` :439, `condition_cleared` | None material (suppressed-forever skipped on purpose) |
| 3 | `policy-evaluation` · policyAlertBridge.ts:237 | Yes: `policy.compliant` | :152 `condition_cleared`; reconcile `source_retired` | Rule found by name only |
| 4 | `config-policy-compliance` · configComplianceAlertBridge.ts:384 | Yes: `policy.compliant` (persisted `compliant` row, or no persisted row, :421) | `resolveOpenAlerts` :333; Monitor-Only downgrade :355 | **NULL reason**; downgrade is really retirement; empty inventory = "not installed" (#10401) |
| 5 | `oem-updates` · oemUpdates/alerts.ts:170 (5 rules) | Yes | `resolveOemAlert` :301, `condition_cleared` | Device-left-management closes as `condition_cleared`; BitLocker-suspended has no settler |
| 6 | `metric_anomaly` · metricAnomalyPromotion.ts:255 (raw insert, no rule) | Yes: episode closes | metricAnomalyEpisodeAlerts.ts:64, `condition_cleared`/`expired` | Reads `metric_anomaly_episodes.linked_alert_id` only; route promotion (routes/devices/anomalies.ts:116) sets `metric_anomalies.linked_alert_id` only; 24 h catch-up; `active` only; `detection_off` excluded; handler runs only when a pass closed an episode (metricAnomalyEpisodes.ts:710); one alert can be reused across episodes (promotion.ts:144 vs episodeKeys.ts:108) |
| 7 | `script_exit_code` · scriptExitCodeAlerts.ts:144 | Yes: a later clean run | :187 `condition_cleared` | Mapping cleared (:104) or script soft-deleted (routes/scripts.ts:1242) strands the alert |
| 8 | `warranty_evaluator` · warrantyAlertEvaluator.ts:254 | Yes | Direct UPDATE :427 | **NULL reason**, bypasses `resolveAlert`; "alerting disabled" is really retirement |
| 9 | `edr_provider` detection · edrProviders/alerts.ts:258 | Yes | :191 `condition_cleared` | Dedupe per (detection, severity): escalation opens a second alert |
| 10 | `edr_provider` endpoint_health · :399 | Yes | :435 `condition_cleared` | Endpoint gone closes as cleared, not retired |
| 11 | `backup_provider` · backupProviders/alerts.ts:432 | Yes | :377 `source_retired` / :378 `condition_cleared` | None material |
| 12 | `security_agent_coverage` · securityAgents/coverageAlerts.ts:90 | Yes | :122 `condition_cleared` | Policy stops requiring vendor closes as cleared, not retired |
| 13 | `network_baseline` · networkBaseline.ts:644 | **By subtype**: `device_disappeared` is an ongoing absence (:944) that a newer identity-checked sighting ends (:305); new/changed are one-off | **None** | — |
| 14 | `network_isolation` expiring · jobs/networkIsolationSweeper.ts:111 | Yes: extend or release (stateMachine.ts:158) | **None** | Shares a source string with #15 |
| 15 | `network_isolation` outcome · networkIsolation/outcome.ts:74 | No (human review by design) | **None** | — |
| 16 | identity collision · deviceIdentityCollisionAlert.ts:126 | No | **None** | — |
| 17 | `topology_monitoring` · topology/monitoringAlerts.ts:57 (site-owned) | Yes: healthy streak | Direct UPDATE :101 through a transactional outbox (:107, :155) with stable event identity | **NULL reason**; otherwise the most careful resolver in the list |
| 18 | log correlation · logSearch.ts:1157 (no source, no rule) | No | **None** | No `alert.triggered` published |
| 19 | `dns_threat_evaluator` · dnsThreatAlerts.ts:129 | No (one-off) | **None** | No `alert.triggered` published |
| 20 | `ai_agent_fix_watch` / `ai_agent_act_verify` · aiAgents/fixWatch.ts:932, actVerify.ts:460 | No | **None** | No `alert.triggered` published |
| 21 | automation / flow `create_alert` · alertCreation.ts:121 | No | **None** | Fresh subjectKey per alert, no dedupe |
| 22 | `network_monitor` · jobs/monitorWorker.ts:410 (legacy, outside the engine directories) | Yes | :383 `condition_cleared` | Suppressed alerts never clear (:370) |

Facts the design leans on:

- C1 `resolveAlert` (alertService.ts:989) is a CAS on `(id, status ∈ open set)` (:1017);
  `reason = resolutionReason ?? ((resolvedBy || resolvedByPrincipalId) ? 'manual' : null)`
  (:1001). Cooldown is written only when `ruleId` is set (:1082). It publishes `alert.resolved`
  after the UPDATE (:1101), so a crash between the two leaves a closed alert whose event never
  went out; only the subject path has a durable dispatch (`context._subjectResolutionDispatch`,
  :1045). Verified.
- C2 The 2-minute sweep `checkAllAutoResolve` (:1782) skips alerts with a `subjectKey`,
  `requiresHuman`, or no `ruleId` (:609-620). For rule-backed built-ins it reads the lifecycle
  snapshot or legacy values (alertLifecycle/resolve.ts:76, 310); every built-in template ships
  `autoResolve: false`, so in practice the sweep closes none of them, though a rule override
  could enable it. Verified.
- C3 Resolution reasons: `condition_cleared | source_retired | expired | manual`
  (`packages/shared/src/constants/fixMemory.ts:48`). The outcome watcher treats NULL as not a
  recovery and reads `resolved_at` as the recovery time (fixMemory/outcomeWatcher.ts:84). Verified.
- C4 No producer sets `requiresHuman`. Verified.
- C5 The only contract over `BUILT_IN_ALERT_RULE_SOURCES` is the unique-index predicate test
  (builtInAlertRuleUniqueness.integration.test.ts:386). Nothing asserts a resolver per source.
- C6 Re-arm spec §5.5 rejects `alerts.triggered_at` as a recovery anchor: recovery evidence is
  compared with the trigger *evidence*, never with a server timestamp. §6.7 (OD8): legacy rules
  keep explicit cooldown/auto-resolve values and do not inherit partner/org defaults.
- C7 Software inventory observations already carry completeness (`softwareInventoryObservations.ts:177`):
  a complete empty inventory proves absence; legacy-empty, failed and partial do not. Persisted
  compliance state is `compliant | non_compliant | pending | error` (automations.ts:41);
  per-device aggregation is boolean (policyEvaluationService.ts:980).

## 3. Goals and non-goals

**Goals**

- G1 Every alert producer outside the monitor engine declares how each of its alert *kinds*
  closes, in one registry, and a contract test fails on an undeclared producer or source.
- G2 Every producer whose condition is observable to recover has a resolver that closes the
  alert with a non-null reason through one guarded path, honouring the re-arm rules
  (`requiresHuman` never; unknown never; recovery evidence newer than the latest trigger evidence).
- G3 The two owner-reported cases close automatically: patch-job failure on the device's next
  clean job; promoted metric anomaly when every condition it represents has settled, regardless
  of which surface promoted it.
- G4 Alerts already stranded in both regions are closed once by a reviewed, dry-run-first backfill
  that carries the real recovery time into fix memory.

**Non-goals**

- Partner/org lifecycle inheritance for built-in sources (re-arm spec OD8 stands).
- Changing what triggers any built-in alert, except the compliance `unknown` rule (D6).
- Auto-expiring event-class alerts on a timer (OD1).
- Publishing `alert.triggered` for producers #18–#20, the EDR escalation dedupe (#9) and the
  `network_monitor` suppressed gap (#22). Filed separately; notification bugs, not lifecycle.
- A UI for per-source lifecycle settings. There is nothing to configure.

## 4. Decisions

| ID | Decision | Basis |
|---|---|---|
| D1 | Every non-monitor producer is registered in `services/alertLifecycle/sourceRegistry.ts`, one entry per **(source, subtype)** where a source has kinds with different lifecycles (`network_baseline`, `network_isolation`, `oem-updates`, `edr_provider`). Entry is a discriminated union: `observed` (must name a resolver and the evidence it compares), `event` (one-off, human closes), `manual` (human decision by design). A scan-based contract test enforces it (§5). | Own position; quorum Q1 agreed and added subtype identity and resolver wiring. Mirrors `parkedFanout.contract.test.ts` and the tool-subject contract (#10834). |
| D2 | `resolveAlert` takes a typed options object: `{ reason } | { actor }`; a system call with neither returns `false`, reports `alert-resolve-missing-reason` to Sentry, and is distinguishable in telemetry from a lost CAS. Never defaults to `condition_cleared`. Same behaviour in test and production. | Quorum Q2 agreed: an invented reason falsely credits remediation; `false` already means "refused transition". |
| D3 | One shared helper `resolveSourcedAlerts({ orgId, ownerRef, source, subtype, match, reason, note, recoveryEvidence })`. `match` (entity id / generation) is **required** for multi-subtype sources. It closes `active`, `acknowledged` and `suppressed` (not suppressed-forever), never `requiresHuman`, and only when `recoveryEvidence` orders after `context.lifecycle.lastTriggerEvidence`. These guards are in the UPDATE predicate, not a pre-read, so a concurrent manual resolve or a newer trigger wins and the loser emits nothing. | Re-arm D9 and §5.5 applied uniformly; quorum: guards must enter the CAS, and source-only matching can close unrelated alerts (`network_isolation` shares a string across #14/#15). |
| D3a | Producers that dedupe a repeat trigger onto an open alert must advance `context.lifecycle.lastTriggerEvidence` in that same write (`refreshOpenSourcedAlert`). The dedupe at alertService.ts:279 currently drops the occurrence. | Closes the finalizer race (quorum): clean result → newer failure refreshes → delayed clean resolver must lose because the evidence moved. |
| D3b | Sourced resolution uses a durable dispatch: the UPDATE writes the `alert.resolved` payload into `context._resolutionDispatch` (generalising the subject path at :1045) and a drain publishes it, so a crash after the CAS cannot lose the event. Topology keeps its own outbox (D7a). | C1; quorum: CAS does not guarantee delivery. |
| D3c | `resolveAlert` accepts `observedRecoveryAt`; stored in `context.lifecycle.recoveredAt` and read by the outcome watcher in preference to `resolved_at`. | C3; quorum: a backfill stamping `now` would credit a remediation that came *after* the real recovery. |
| D4 | **Patch job failed** resolves inside `patchJobFinalizer` when the device's terminal is `kind === 'result'` and `writes.countsAsCompleted` and at least one per-patch row was attempted (no `resultUnparsable` fallback success, :544). `recoveryEvidence = (job completed_at, job id)`. Cancelled/expired/superseded never count. Partial success refreshes the open alert (D3a) instead of being dropped. Never throws. | The finalizer is the one place that observes the outcome; a sweep would re-derive it. Quorum: fallback success and all-skipped jobs are not recovery. |
| D5 | **Metric anomaly**: the alert's `context.lifecycle.represents` lists every (episode id | anomaly id) it stands for; promotion appends to it. Route promotion delegates to the episode action when the anomaly's episode is open; otherwise it keeps today's path and records the anomaly id. The resolver closes the alert only when **every** represented condition has settled, mapping close reasons individually: `cleared` → `condition_cleared`, `expired_*` → `expired`, `detection_off` → `source_retired`, a human `dismissed` with `resolveAlert:false` → **not** a recovery (alert stays). Reconciliation runs on its own schedule with deterministic pagination and per-row error isolation; no 24 h window. | §2 row 6 and quorum Q3: nullable `episodeId`, closed episodes reject actions, one alert can span episodes, the handler is skipped when nothing closed, humans can keep the alert. |
| D6 | **Compliance (#10401)**: the software-presence evaluator consumes observation completeness (C7). Complete-empty = absent (triggers). Legacy-empty, failed or partial = `unknown` per rule, persisted as `pending` with `evidence: { kind: 'inventory_incomplete', observedAt }` (no enum migration). `unknown` neither triggers nor resolves; a known violation on rule A survives an unknown on rule B (per-rule, not boolean, at the aggregation point). An inventory observation becoming complete re-queues the evaluation. `resolveOpenAlerts` passes `condition_cleared`; the Monitor-Only downgrade passes `source_retired`. | Quorum Q4 disagreed with blanket "empty = unknown" and was right: the metadata to tell them apart exists. No first-enrolment exception. |
| D7 | Retirement is `source_retired`, not `condition_cleared`: OEM device left management, EDR endpoint gone, coverage policy no longer requires the vendor, warranty alerting disabled, script soft-deleted or mapping cleared (run from the delete/mapping-change transitions in `routes/scripts.ts`, not from the evaluator's early return), anomaly detection turned off, compliance Monitor-Only downgrade. | C3 semantics: fix memory must not credit a fix when the thing being watched went away. Quorum: script deletion is soft. |
| D7a | **Topology** keeps its transactional outbox, stable event identity, site attribution and suppressed-forever recovery; the only change is writing a reason through a thin adapter that calls `resolveAlert` with `{ reason }` inside the existing transaction. **Warranty** converts fully to `resolveSourcedAlerts`. | Quorum: generic conversion would lose guarantees topology already has; two publishers would duplicate events. |
| D8 | **Backfill** is a one-shot system script (`scripts/ops/backfill-stranded-builtin-alerts.ts`), dry-run by default, run once per region after W2, over the **reviewed alert ids** from the dry run (not a re-run of the predicate), revalidating each row's evidence inside the resolving transaction. Per-source predicates in §7. Reason as the resolver would have written; `observedRecoveryAt` = the evidence time. No migration writes rows. | README rule against clever migrations; quorum: predicate re-runs can pick up intervening changes; recovery time must be real. |
| D9 | `event`/`manual` alerts get `context.lifecycle.resolution` at creation so alert surfaces can say "Closes when you resolve it". Copy only. | §1's honesty problem is partly display for these classes. |

## 5. Registry and contract (W1)

```ts
// services/alertLifecycle/sourceRegistry.ts
type Evidence = 'job_completed_at' | 'episode_close' | 'observation_at' | 'run_completed_at' | 'sighting_at' | 'state_transition';
export type AlertSourceEntry =
  | { source: string; subtype?: string; emitters: readonly string[]; resolution: 'observed';
      resolver: { module: string; export: string }; evidence: Evidence; retiresOn: readonly string[] }
  | { source: string; subtype?: string; emitters: readonly string[]; resolution: 'event' | 'manual'; why: string };
export const ALERT_SOURCE_REGISTRY: readonly AlertSourceEntry[] = [ /* 22 sources, ~27 entries */ ];
```

`sourceRegistry.contract.test.ts` (unit, Test API job):

1. **File scan.** Every file under `apps/api/src` containing `createAlert(`, `createSourcedAlert(`,
   `.insert(alerts)` or `INSERT INTO alerts` outside the engine allow-list (`alertConditions/`,
   `monitors/`, `subjectAlertOutbox.ts`, `alertService.ts`, tests, seeds, `researchEval/`) must
   appear in some entry's `emitters`, and every listed path must exist.
2. **Source scan.** Every string literal assigned to `source:` or passed as the first argument of
   `createSourcedAlert(` in a registered emitter must be a registered `source`; a producer that
   adds a subtype discriminator (`kind:`, `eventType:`) inside a multi-subtype source must have
   that subtype registered. The failure message names file:line and says to classify it.
3. **Wiring.** Every `observed` entry's `resolver.module` imports and `resolver.export` is a
   function; and a test file named `<module>.resolve.test.ts` exists (resolver behaviour is
   tested, not just importable).
4. `BUILT_IN_ALERT_RULE_SOURCES` ⊆ registry sources. `event`/`manual` entries have a non-empty `why`.

`resolveSourcedAlerts` and `refreshOpenSourcedAlert` live beside the registry and are the only
paths producers use (topology excepted, D7a). Each row goes through `resolveAlert`'s CAS with the
D3 guards folded into the predicate.

## 6. Per-source changes (W2)

| Source | Change |
|---|---|
| `patch-job-finalizer` | D4 + D3a (refresh `failedCount`, `latestJobId`, `lastTriggerEvidence` on a repeat failure). |
| `metric_anomaly` | D5. Fix the `'metric-anomaly'` vs `'metric_anomaly'` event/row mismatch (promotion.ts:331 vs :266) in favour of the row value. |
| `config-policy-compliance` | D6 + reasons. |
| `warranty_evaluator` | Convert to `resolveSourcedAlerts`; "alerting disabled" → `source_retired`. |
| `topology_monitoring` | D7a adapter: reason only. |
| `script_exit_code` | D7 retirement from delete/mapping transitions. Timeout already evaluates as unknown (:61); unchanged. |
| `oem-updates`, `edr_provider`, `security_agent_coverage` | D7 reason corrections only. |
| `network_baseline` | Register `device_disappeared` as `observed` (sighting after the disappearance, identity-checked); `new`/`changed` as `event`. |
| `network_isolation` | `expiring` → `observed` (release or extend, matched on isolation id); `outcome` → `manual`. |
| `network_monitor` | Register as `observed` with its existing resolver; suppressed gap stays a filed follow-up. |
| Event/manual classes | D9 tag only. |

## 7. Backfill (W3)

Predicates the owner can read in the dry-run output; each row is then resolved by id with the
same evidence re-checked in the transaction:

- **Patch.** Open `patch-job-finalizer` alert on device D. The **newest** job J for D with any
  terminal row has, for D: ≥1 `patch_job_results` row with `patch_id IS NOT NULL AND status =
  'completed'`, zero rows with `status IN ('failed','pending','running')`, no `error_message`
  marking a parser fallback, and `MAX(completed_at)` after the alert's `lastTriggerEvidence`
  (or `triggered_at` for legacy rows with no evidence, documented as the one place a server
  timestamp is used because nothing better exists for them). Reason `condition_cleared`.
- **Anomaly.** Open `metric_anomaly` alert whose every linked episode (either link column) and
  linked anomaly is non-open **and** whose close reasons map to a recovery (`cleared` →
  `condition_cleared`, `expired_*` → `expired`, `detection_off` → `source_retired`). Any member
  closed by a human `dismiss`/`resolve` with `resolveAlert:false` excludes the alert.
- **Script.** Open `script_exit_code` alert with a later `script_executions` row for the same
  (device, script): `status = 'completed'`, finite non-null `exit_code`, not superseded, that maps
  to no severity under the script's **current** mapping (documented: historical mappings are not
  reconstructed). Reason `condition_cleared`.

`--apply` is required to write and takes the dry-run's id list. Counts per region are reviewed
by the owner before `--apply`.

## 8. Test plan (red first)

- Registry contract: §5 items 1–4, plus `an unregistered producer file fails with its path`,
  `an unregistered source literal in a registered file fails with file:line`.
- `resolveAlert`: `system caller without reason returns false and reports missing-reason`;
  `actor without reason records manual` (unchanged); `observedRecoveryAt lands in context`.
- `resolveSourcedAlerts`: `closes active, acknowledged and suppressed`; `skips suppressed-forever`;
  `skips requiresHuman`; `loses to newer trigger evidence in the same UPDATE`; `loses to a
  concurrent manual resolve and emits nothing`; `required match for multi-subtype sources`;
  `dispatch survives a crash between CAS and publish` (drain replays).
- Patch: `clean result resolves with condition_cleared and job evidence`; `partial failure
  refreshes evidence and stays open`; `clean result older than the refreshed evidence does not
  resolve`; `cancelled/expired/unparsable never resolve`; `resolve failure never breaks the finalizer`.
- Anomaly: `route promotion on an open episode links the episode`; `alert spanning two episodes
  stays open until both settle`; `detection_off → source_retired`; `human dismiss with
  resolveAlert:false keeps the alert`; `reconciliation runs with no newly closed episode`.
- Compliance: `legacy-empty inventory is unknown and neither triggers nor resolves`;
  `complete-empty inventory is absent and triggers`; `rule A violation survives rule B unknown`;
  `complete observation re-queues evaluation`; `resolveOpenAlerts writes condition_cleared`;
  `Monitor-Only downgrade writes source_retired` (#10401 regression).
- Warranty/topology: `reason written`; topology `outbox event identity unchanged`.
- Backfill: `dry-run writes nothing`; `apply resolves exactly the reviewed ids`; `a row whose
  evidence changed since dry-run is skipped and reported`; `rerun is a no-op`.
- Integration: `builtInAlertRuleUniqueness`, `complianceAlertReconcile`, `fixOutcomeLifecycle`
  stay green; `fixOutcomeLifecycle` gains `a finalizer-resolved patch alert counts as a recovery
  at observedRecoveryAt`.

## 9. Waves

| Wave | Content | Risk |
|---|---|---|
| W1 | Registry + contract test, `resolveSourcedAlerts`/`refreshOpenSourcedAlert`, typed reason guard, durable dispatch (D3b), `observedRecoveryAt` (D3c), convert warranty + compliance reasons + topology adapter, D9 tag | Medium: `resolveAlert` signature change (compile-checked, mechanical); dispatch generalisation touches the subject path |
| W2 | D4 patch, D5 anomaly, D6 compliance (#10401), D7 retirement reasons, baseline/isolation/network_monitor registration | Medium: behaviour change for every customer; release note |
| W3 | Backfill script + per-region owner-approved run, docs (`docs/agents/` alert-source rule; user guide "when alerts clear"), release note | Low |

Each wave one PR from fresh `origin/main`, merged in order. No migration: D6 uses the existing
`pending` state plus evidence metadata; OD3 (a `CHECK` on reasons) is recommended **no**.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Backfill closes an alert whose condition is still true | §7 predicates require the newest job, attempted work, no non-terminal siblings; ids reviewed; evidence re-checked at apply |
| `resolveAlert` signature change breaks an untested caller | Compile error; W1 otherwise mechanical |
| D6 hides a real "EDR missing" on a device whose inventory never completes | Inventory staleness is a connection-health concern (#9127); surfaced there, not solved here |
| Durable dispatch (D3b) double-publishes against the existing subject path | One drain, one context key; the subject path migrates to it in W1 under its existing tests |
| D5 "every represented condition settled" never fires for an alert spanning a condition that stays open forever | That is the correct outcome; the alert is still true for that condition |

## 11. Advisor quorum (done 2026-11-07)

`codex exec -m gpt-6-astra -c model_reasoning_effort=xhigh -s read-only` on the first draft.

| Question | Codex | Outcome |
|---|---|---|
| Q1 Registry+scan vs typed `createAlert` arg | **Agree** on registry: a typed arg misses raw inserts (promotion.ts:255). File membership alone misses a new source inside a registered file; make `observed` a discriminated union requiring a resolver; test wiring not importability. | **Adopted**: §5 item 2 source/subtype scan; union type; item 3 test-file requirement. |
| Q2 Reason guard | **Agree**: return false and report; fallback must include `resolvedByPrincipalId` (:1001); separate missing-reason from lost-CAS in telemetry; same behaviour test/prod. | **Adopted** (D2). |
| Q3 Route promote → episode action | **Agree** on canonical linkage, but `episodeId` nullable, closed/promoted episodes reject actions, existing links must reconcile, one alert spans episodes. | **Adopted** as D5 `represents` list + all-settled rule + per-reason mapping. |
| Q4 Empty inventory = unknown | **Disagree**: completeness metadata exists (C7); complete-empty proves absence; per-rule unknown; boolean aggregation must change; persisted enum lacks `unknown`. | **Adopted** (D6): completeness-driven, `pending` + evidence, per-rule, no enum migration. |
| Q5 Misclassified event/manual | **Disagree** on blanket `network_baseline`: `device_disappeared` is observed; isolation release is an explicit closure signal. | **Adopted**: subtype entries (§6). |
| Factual corrections | `triggered_at` anchoring contradicts re-arm §5.5; no `failed_count`; compliance resolves without a persisted row and downgrade is retirement; script delete is soft; C2 overstated; `network_monitor` missing; C1 "always publishes" false. | **All adopted** (C1, C2, C6, D3, D6, D7, D7a, §2 row 22, §7). |
| Missing failure modes | Finalizer/new-failure race; guards outside the CAS; alert spanning episodes; sweep skipped when nothing closed; topology guarantees; backfill false positives (patch fallback success, anomaly human dismiss, script null exit codes); backfill credits a later fix; source-only matching; CAS ≠ delivery. | **All adopted**: D3, D3a, D3b, D3c, D5, D7a, D8, §7. |

## 12. Open decisions for the owner

| ID | Question | Recommendation |
|---|---|---|
| OD1 | Event-class alerts (baseline new/changed, DNS threat, AI fix watch, automation `create_alert`, log correlation): keep manual-only, or auto-expire after N days with reason `expired`? | **Manual-only**, with the D9 copy. A TTL hides information a human asked for. |
| OD2 | Backfill scope: the three §7 predicates only, or also OEM/EDR/warranty alerts whose resolvers exist but may have missed? | **Three only.** Anything stranded under a running resolver is a bug to find, not paper over. |
| OD3 | DB `CHECK (resolution_reason IS NOT NULL OR resolved_by IS NOT NULL)` for new rows? | **No.** D2 plus the contract test cover it without a migration or a legacy backfill. |
| OD4 | Patch recovery: newest job clean (latest-job health), or specifically the previously failed patches now installed? | **Newest job clean, attempted ≥1.** It is what the alert text claims ("patch job failed"); per-patch tracking is a different alert. |
| OD5 | D3b durable dispatch in W1, or defer and accept a rare lost `alert.resolved` until #10499 (PSA close-on-resolve) needs it? | **W1.** #10499 will need it anyway and the subject path already has the shape. |
