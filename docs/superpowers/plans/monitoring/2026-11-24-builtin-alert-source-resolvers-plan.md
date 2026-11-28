---
spec: docs/superpowers/specs/monitoring/2026-11-07-builtin-alert-source-resolvers-design.md
covers: "Every alert producer outside the monitor engine declares how its alerts close (registry + contract test), observable ones resolve through one guarded, durably announced path, and alerts already left open are closed once by a reviewed backfill"
waves: W01 registry, guarded helper, typed reason, durable `alert.resolved`, `observedRecoveryAt`, warranty / compliance / topology reasons, display tag · W02 patch, metric anomaly, compliance inventory, retirement reasons, baseline + isolation resolvers · W03 report-first backfill script, docs, release note
depends_on: "W01 → W02 → W03. Each wave is one PR off fresh `main`, never stacked. W03's per-region run is an operator step after its PR ships."
status: draft (awaiting owner Gate B)
---
# Built-in alert sources: recovery signals and resolvers — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an alert raised by a built-in producer closes by itself when its condition is seen to recover, says why it closed, announces the close even across a crash, and a new producer cannot merge without declaring how its alerts close.

**Architecture:** a leaf registry (`services/alertLifecycle/sourceRegistry.ts`) lists every producer by (source, subtype) as `observed`, `event` or `manual`, and an AST-based contract test ties it to the code. `resolveAlert` takes a typed cause and stages `alert.resolved` in the **existing** alert outbox in the same UPDATE that closes the row; `resolveSourcedAlert(s)` adds the recovery guards to that UPDATE's predicate, and `refreshOpenSourcedAlert` moves the trigger evidence forward on a repeat. W02 puts the patch, anomaly, compliance, baseline and isolation sources on it; W03 is a dry-run-first script over reviewed ids using the same predicates.

**Tech Stack:** TypeScript, Hono, Drizzle (SQL only), BullMQ, Vitest (unit + real-Postgres integration), the TypeScript compiler API (contract test only), Astro + React islands, Expo mobile. No new dependency, table, column, index, migration, setting or AI tool.

**Spec:** `docs/superpowers/specs/monitoring/2026-11-07-builtin-alert-source-resolvers-design.md` (Gate A approved 2026-11-24, §12 settled). The plan argues from the spec; executors read both. Where they differ, the Decisions section says so and this plan governs.

**Verified against** `origin/main` `9db6f1111d` (2026-11-25 UTC), by reading; nothing was run. Paths are under `apps/api/src/` unless stated. Line numbers drift: re-grep before editing.

## Global Constraints

- **Three classes (D1):** `observed` (names a resolver and its evidence), `event` (one-off, a human closes), `manual` (human decision by design). One entry per (source, subtype) where kinds differ.
- **Guards live in the UPDATE (D3):** never `requiresHuman`; never suppressed-forever (`status = 'suppressed' AND suppressed_until IS NULL`); only when recovery evidence orders **strictly after** the latest trigger evidence. A pre-read is a hint, never a guard. The loser of the CAS emits nothing.
- **Unknown never resolves and never triggers (D6).** Cancelled, expired, superseded, skipped, unparsable and missing data are not recovery (D4).
- **A system resolve states a reason (D2).** `condition_cleared` only for an observed recovery; `source_retired` when the thing being watched went away (D7); `expired` when an episode or window ran out. No default.
- **No timer expiry (OD1). No database CHECK (OD3).** Event and manual alerts close by a person only.
- **Triggers do not change**, except the compliance `unknown` rule (D6). In particular no resolve may newly suppress a later trigger (Decision 6).
- **No migration, no schema change.** Everything new lives in `alerts.context` (already `excludedOpen` in `CORE_TENANT_EXPORT_POLICY`, `services/tenantExportPolicyRegistry.ts:220`), so there is no cascade, org-merge or export registration to add. **If a task finds it needs a table, column or index, stop and report.** Should the owner then approve one: state the tenancy shape and why; RLS enabled, forced and with policies in the same migration; every composite FK on `org_id` `DEFERRABLE INITIALLY IMMEDIATE`; registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` and `CORE_TENANT_EXPORT_POLICY` (a new column is classified too; `json`/`jsonb`/`bytea` is `excludedOpen`); idempotent; no inner `BEGIN`/`COMMIT`; `SELECT set_config('breeze.scope', 'system', true);` first if it writes rows; named at PR time to sort after the newest name printed by `git fetch origin main && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -5`, checked with `scripts/check-migration-naming.sh --against-ref origin/main` and `pnpm db:check-drift`.
- **DB context:** background resolvers run in `withSystemDbAccessContext` (after `runOutsideDbContext` if inside a request). A catch around a query wraps that query in `withDbTransaction` (or `withDbTransactionIfHeld` / `withSystemDbAccessContextIsolated` where no context may be held) **with the catch outside**. Never start one beside siblings in a `Promise.all`. No bare pool. No network or Redis call inside a transaction that did not have one before.
- **Settings:** no setting is added (places the concept is configured: 0 before, 0 after). The one new env var (`BUILTIN_ALERT_BACKFILL_ENFORCE`, W03) is an operator switch read by a script.
- **Web / mobile:** copy in all 8 web locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`), never `t(cond ? 'a' : 'b')` (`keyUsage.test.ts`), `data-testid` on every new element, `window.location.hash` for transient state, `runAction` for mutations. This plan adds **no** mutation and **no** transient UI state; if a task finds it needs one, those rules apply.
- **Public repo:** producers and their resolve behaviour are described neutrally; no customer, host or lab names, no infra details.
- **Commits and PRs:** each wave PR closes **its own wave sub-issue only**; every other reference is `Refs`, and no commit message or body carries a closing keyword for another issue, even negated.
- **Testing:** red first; a test that cannot fail is not written. Integration tests skip silently without a database: run them on `pnpm test-stack up`, read the **executed** count, then `pnpm test-stack down`.

## Review Focus

1. **A delayed clean result closes an alert for a newer failure** (job A waits while a device is offline, job B fails, A reports clean last; or the newer failure fell in a maintenance window). → T11 `a clean result from an older job does not resolve`, `a repeat failure during a maintenance window still advances the evidence`, integration `clean and failure racing on two connections`.
2. **A close that never reaches anyone**: crash or publish failure after the row is closed, or a failing envelope that starves the queue. → T1 `an unpublished resolution is replayed by the minute drain with the same event id`, `100 failing resolutions do not block the 101st, also after their backoff has lapsed`.
3. **An alert created before this ships**, with no stored evidence: it must neither close on old data nor stay open forever. → T3 `legacy row: triggered_at anchors`, `legacy row: a caller-supplied anchor wins`; the T11 and T12 legacy cases; T20 uses the same builder.
4. **A technician's mute or close loses to the machine** (muted forever, or resolved by hand, between the resolver's read and its write). → T3 `mute-forever landing after the read wins`, `a concurrent manual resolve wins: exactly one manual envelope and no sourced one` (two real connections).
5. **A producer added next month slips past the contract** because its source is an imported constant, it calls through an injected dependency, or it has no source at all. → T4 fixture cases for each, plus the mutation step.

## Premises re-verified (2026-11-25, `9db6f1111d`)

The design holds; nothing below changes a D-decision's intent. Where a mechanism named by the spec has moved or does not exist, the nearest existing one is used and recorded under Decisions.

| # | Spec claim | Now |
|---|---|---|
| P1 | 22 producers (§2) | **24.** Two more: `management-posture` (`services/remoteToolAlerts/alerts.ts:208`, source const `:36`, subtype `toolCategory`; added 2026-11-08, #11331) and reinstall-suspected (`services/reinstallCandidates/notify.ts:165`, no `source`, `eventType: 'device.reinstall_suspected'` `:29`; added 2026-11-11, #10918). Both rule-backed; neither resolves today (Decision 3, owner question 2) |
| P2 | #18 log correlation has no source, no rule; #18–#20 do not publish `alert.triggered` | All four now use `createSourcedAlert` (#11346): `log_correlation` `services/logSearch.ts:1162`, `dns_threat_evaluator` `services/dnsThreatAlerts.ts:137`, `ai_agent_fix_watch` `services/aiAgents/fixWatch.ts:935`, `ai_agent_act_verify` `services/aiAgents/actVerify.ts:487`. #11328 item 1 shipped; items 2 and 3 stay open and out of scope |
| P3 | #6 metric anomaly is a raw insert; event and row `source` differ (§6) | `createSourcedAlert` (`services/metricAnomalyPromotion.ts:265`); the payload takes `context.source` (`services/alertService.ts:436`). **The §6 "fix the mismatch" item is already in place and dropped** |
| P4 | #21 publishes inline | `services/alertCreation.ts:154` stages the outbox envelope (#11348). Still no `source` |
| P5 | Producer file scan to be written | `__tests__/alertTriggeredWriters.contract.test.ts` already scans raw writers with comment stripping; T4 shares its walker |
| P6 | C1: `resolveAlert` :989, CAS :1017, reason :1001, cooldown :1082, publish :1101, subject dispatch :1045 | `services/alertService.ts:930` (7 positional parameters incl. `recoveryCursor`), CAS `:969`, reason `:942`, cooldown `:1022-1027`, publish `:1040-1056` (inline), subject path `:986-1006`. `buildResolveAlertCas` `:708` |
| P7 | D3b: generalise the subject path into a new `context._resolutionDispatch` | The outbox was generalised for triggers (#10926): `services/alertDispatchEnvelope.ts`, `services/subjectAlertOutbox.ts`, slots `_subjectDispatch` / `_subjectResolutionDispatch` (`:125`), after-commit kick `scheduleStagedAlertDispatch`, per-device and minute-tick drains (`jobs/alertWorker.ts:181,241`). Only subject rows use the resolution slot (Decision 1) |
| P8 | C2 sweep :1782, skips :609-620 | `checkAllAutoResolve` `:1723`, skips `:550-562`. Unchanged in substance |
| P9 | Dedupe at :279 drops a repeat | `createAlert`: cooldown `:196`, dedupe `:206-223`, flap `:226`. **The cooldown returns before the dedupe**, so D3a must refresh before calling `createAlert` |
| P10 | C5: uniqueness test :386 | `builtInAlertRuleUniqueness.integration.test.ts:428` (membership `:163`). `BUILT_IN_ALERT_RULE_SOURCES` `services/builtInAlertRules.ts:23-34`: `patch-job-finalizer`, `maintenance-reboot-sweep`, `policy-evaluation`, `config-policy-compliance`, `oem-updates`, `management-posture` |
| P11 | D4 evidence is `(job completed_at, job id)` | `patch_jobs.completed_at` is written only when the whole job drains (`services/patchJobFinalizer.ts:797-808`), so it does not exist at the device's terminal. `patch_jobs.started_at` is written once at claim (`jobs/patchJobExecutor.ts:596-599`) (Decision 4) |
| P12 | D4 `countsAsCompleted`, unparsable `:544` | `:554-557,:624`; also **true** for cancelled and superseded (`:528`), so `kind === 'result'` is required too. Empty stdout, and a patch with no entry in `results[]`, also fall back to the batch outcome without `resultUnparsable` (`:544-575`): "attempted" must mean a matched per-patch entry |
| P13 | §7: fallback rows carry an `error_message` | They do not (`:598-603`: `completed`, `patch_id` set, `error_message` NULL). §7 also omits the `queued` status. No unique key on (job, device, patch) (Decision 8, owner question 3) |
| P14 | Row 6: `linked_alert_id` split, 24 h window, `active` only, `detection_off` excluded, handler only after a close | All still true: `services/metricAnomalyEpisodeAlerts.ts:29,30,41-54`, `services/metricAnomalyEpisodes.ts:710`, `routes/devices/anomalies.ts:116`. There is no `closed_at`; the close time is `metric_anomaly_episodes.resolved_at` |
| P15 | D5: each represented condition settles | A `promoted` anomaly row is never auto-cleared, and assembly takes only `open` rows, so an anomaly promoted before its episode was assembled has **no settle signal** (Decision 5, owner question 1). `resolveAlert: false` is not stored on the episode: `close_reason = 'user'` covers both answers |
| P16 | C7: aggregation is boolean (`policyEvaluationService.ts:980`) | Three-state since #12184: `RuleEvaluationDetail.passed: boolean \| null` `:245`, `evaluateDeviceRules` `:1013`, `statusOf` `:1083` (`pending` = not assessed), remediation skips `null` `:1094`. What remains of D6 is making inventory-dependent rules return `null`. **#10401 was closed 2026-11-08** by #10648 (a scan-freeze fix); neither of D6's behaviours shipped, so D6 stands as `Refs #10401` |
| P17 | C7: legacy-empty vs complete-empty from `completeness` | **`completeness` is not the key:** a legacy report is stored `completeness = 'complete'` (`services/softwareInventoryObservations.ts:505-508`). Use `absence_resolution_eligible` / `reason_code` (only `accepted_complete` is eligible, `:204`) |
| P18 | Row 4 resolve :333, downgrade :355, compliant :421 | `services/configComplianceAlertBridge.ts:333` (the one caller with no reason and no actor), downgrade `:359`, compliant guard `:427` |
| P19 | Row 5: five OEM rules | Six (`services/oemUpdates/alerts.ts:24-30`); resolves `:343`, `:372`; left-management verdicts `services/oemUpdates/overdueSweep.ts:180,188,193,198` |
| P20 | Row 9/10 EDR resolve :191, :435; row 11 "none material" | `services/edrProviders/alerts.ts:212`, `:435`. Row 11 (`services/backupProviders/alerts.ts:377-378`): a row that vanished or was unlinked closes as `condition_cleared`, so D7's principle applies there too (Decision 10) |
| P21 | Row 13: an identity-checked sighting ends the absence (:305) | `mergeKnownDevices` (`services/networkBaseline.ts:290-329`) matches by **IP only**; the identity check is new code (Decision 9). A fourth subtype `rogue_device` exists |
| P22 | Row 14 extend/release at `stateMachine.ts:158` | Extend `services/networkIsolation/stateMachine.ts:230`, `service.ts:232`; `:158` is `acknowledge`. `policy_changed` also bumps the generation, so a generation change alone is not an extension |
| P23 | Rows 8, 17 direct UPDATEs `:427`, `:101` | `services/warrantyAlertEvaluator.ts:428-436` (three exits `:123,:155,:197` share one note; muted-forever skipped in the pre-read only, `:413-416`); `services/topology/monitoringAlerts.ts:102-105` |
| P24 | Row 7 mapping :104, delete `routes/scripts.ts:1242` | `services/scriptExitCodeAlerts.ts:105`; delete `routes/scripts.ts:1240-1244`; mapping writes `routes/scripts.ts:1035` **and** `services/scriptBundle/index.ts:829-839`. §7's "not superseded" has no column on `script_executions`; dropped |
| P25 | C3 outcome watcher :84; reasons `fixMemory.ts:48` | `services/fixMemory/outcomeWatcher.ts:76-86`. **Two** readers: the row (`services/outcomeProbes.ts:33`) and the event payload (`outcomeWatcher.ts:507-526`); both must change. Reasons `packages/shared/src/constants/fixMemory.ts:49` |
| P26 | D7a: topology adapter calls `resolveAlert` | `resolveAlert` announces on its own, and its CAS lacks the org/site predicate; calling it would announce twice (Decision 2) |
| P27 | D8: `scripts/ops/backfill-….ts` | `scripts/ops/` holds only shell and SQL; a TS script must sit in `apps/api/scripts/` and have a `tsup.config.ts` entry to exist in the production image (Decision 7) |
| P28 | D9 surfaces | Web page line `apps/web/src/components/alerts/AlertDetailPage.tsx:388`, drawer `AlertDetails.tsx:192`; mobile parsers rebuild rows and drop `context` (`apps/mobile/src/services/api.ts:633`, `screens/chat/blocks/alertLike.ts:28`), so mobile needs a scalar. No portal alert-detail surface exists |
| P29 | C4: no producer sets `requiresHuman` | Still true for built-ins (the engine escalations do) |
| P30 | OD5 rests on #10499 needing it | #10499 shipped 2026-11-16 (`services/psaAlertTicketing/subscriber.ts`), so `alert.resolved` now drives ticket closure |

### Producer inventory and resolve behaviour (registry content)

| Source (subtype) | Emitter | Class | Today → this plan |
|---|---|---|---|
| `patch-job-finalizer` | `services/patchAlerts.ts:262` | observed | none → clean newer job (T11) |
| `maintenance-reboot-sweep` | `services/patchAlerts.ts:400` | observed | `:467` unchanged |
| `policy-evaluation` | `services/policyAlertBridge.ts:237` | observed | `:152` unchanged |
| `config-policy-compliance` | `services/configComplianceAlertBridge.ts:384` | observed | `:333` → reasons (T6) |
| `oem-updates` (6 rules, one lifecycle) | `services/oemUpdates/alerts.ts:180` | observed | `:343,:372` → retirement reasons (T16) |
| `metric_anomaly` | `services/metricAnomalyPromotion.ts:265` | observed | episode link only → all represented settled (T12) |
| `script_exit_code` | `services/scriptExitCodeAlerts.ts:144` | observed | `:187` + retirement (T15) |
| `warranty_evaluator` | `services/warrantyAlertEvaluator.ts:254` | observed | direct UPDATE → helper (T6) |
| `edr_provider` (`detection`, `endpoint_health`) | `services/edrProviders/alerts.ts:258,399` | observed ×2 | `:212,:435` → retirement reasons (T16) |
| `backup_provider` | `services/backupProviders/alerts.ts:432` | observed | `:377,:378`, `alertsResolve.ts:32` → reason correction (T16) |
| `security_agent_coverage` (`gap`, `mismatched_org`) | `services/securityAgents/coverageAlerts.ts:90` | observed ×2 | `:124` → retirement reasons (T16) |
| `network_baseline` (`device_disappeared`) | `services/networkBaseline.ts:650` | observed | none → matched sighting (T17) |
| `network_baseline` (`new_device`, `device_changed`, `rogue_device`) | same | event ×3 | a person closes |
| `network_isolation` (`expiring`) | `jobs/networkIsolationSweeper.ts:111` | observed | none → extend or release (T18) |
| `network_isolation` (`outcome`) | `services/networkIsolation/outcome.ts:74` | manual | a person closes |
| identity collision (no source; `eventType: device.identity_collision`) | `services/deviceIdentityCollisionAlert.ts:126` | manual | a person closes |
| reinstall suspected (no source; `eventType: device.reinstall_suspected`) | `services/reinstallCandidates/notify.ts:165` | manual (Decision 3) | a person closes |
| `management-posture` | `services/remoteToolAlerts/alerts.ts:208` | event (Decision 3) | a person closes |
| `topology_monitoring` | `services/topology/monitoringAlerts.ts:57` | observed | `:102` + reason (T6) |
| `log_correlation` | `services/logSearch.ts:1162` | event | a person closes |
| `dns_threat_evaluator` | `services/dnsThreatAlerts.ts:137` | event | a person closes |
| `ai_agent_fix_watch`, `ai_agent_act_verify` | `services/aiAgents/fixWatch.ts:935`, `actVerify.ts:487` | event ×2 | a person closes |
| automation / flow `create_alert` (no source; `automationId` or `flowRunId`) | `services/alertCreation.ts:154` | event | a person closes |
| `network_monitor` | `jobs/monitorWorker.ts:410` | observed | `:383` unchanged |

**Engine (allow-listed, not registered):** `services/alertService.ts:1632`, `services/alertSubjects.ts:64`, `services/offlineAlertEffects.ts:189`, `services/monitors/escalationLatch.ts:94`, `services/subjectAlertOutbox.ts:380`. **Fixtures:** `db/seedE2eFixtures.ts`, `services/llm/researchEval/runCase.ts`.

## Decisions

**DECIDED by the owner, 2026-11-24 (PR #11327, Gate A):**

| ID | Decision | Alternative not taken |
|---|---|---|
| OD1 | Event-class alerts resolve manually only; no auto-expire | Expire after N days |
| OD2 | The backfill covers the three §7 predicates only (patch, anomaly, script) | Also OEM / EDR / warranty |
| OD3 | No database `CHECK` constraint | `CHECK (resolution_reason IS NOT NULL OR resolved_by IS NOT NULL)` |
| OD4 | Patch recovery means the newest job is clean | Each failed patch now installed |
| OD5 | Durable `alert.resolved` dispatch is part of wave 1 | Defer until a consumer needs it |

**Taken while planning (each with the alternative):**

1. **OD5 uses the outbox that already exists: slot `context._subjectResolutionDispatch`, drain `dispatchStagedAlerts` (`services/subjectAlertOutbox.ts:115`), after-commit kick `scheduleStagedAlertDispatch`.** The key keeps its old name, as `_subjectDispatch` did, because in-flight rows and `hardwareHealth/retirementOutbox.ts:33` read it. *Alternative:* the spec's new key `_resolutionDispatch`: a third slot, a second drain branch and a rolling-deploy window with two names.
   - **Idempotency key:** the envelope's `eventId` (a v4 UUID written once, in the CAS that closed the row), published as the event id on every retry with the staged `occurredAt`. Delivery is at-least-once with a stable identity; webhook delivery already dedupes on `(webhook_id, event_id)` (`services/webhookDeliveryRecord.ts:142`). It is not derived from the alert id, because a reopened alert can be resolved again.
   - **Scope:** every non-deferred `resolveAlert` call, not only sourced ones: one behaviour, one drain. *Alternative:* the sourced helper only, leaving two announce paths in one function. Human routes that UPDATE directly, and topology's own outbox, are unchanged.
   - **Atomicity:** the envelope is built in SQL from the row's own columns in the **same UPDATE** as the status change, so it holds with or without an ambient transaction. The payload is today's payload, field for field, plus `observedRecoveryAt` when given.
   - **Cooldown and flap writes stay where they are today** (inline in `resolveAlert`, rule-backed only) and the envelope carries `noiseControls: false`, so the drain adds none. A closed row no longer dedupes, so moving the cooldown behind the publish would open a re-trigger window. *Alternative:* run them in the drain, as the subject path does.
2. **Topology sets `resolutionReason: 'condition_cleared'` in its own UPDATE and adds `resolutionReason` to its own payload.** Same transaction, org/site predicate, muted-forever recovery and event identity as today. *Alternative:* D7a's adapter over `resolveAlert`; it now stages an announcement of its own, so the close would go out twice, and it drops the site predicate.
3. **The two producers added after the spec are registered as human-closed** (`management-posture` `event`: each alert asks for a review of a tool that appeared; reinstall-suspected `manual`: a merge-or-keep decision). No resolver is designed here, because the spec did not approve one. *Alternative:* design resolvers now; owner question 2.
4. **Patch evidence is `(COALESCE(patch_jobs.started_at, created_at), patch_jobs.id)`**, for trigger and recovery alike. It is fixed for the job, set by the server, and orders jobs the way OD4 speaks of them ("newest job"); a late result from an older job therefore never outranks a newer job. The device's terminal time is kept as `observedRecoveryAt`. *Alternatives:* `patch_jobs.completed_at` (not written yet, P11); the device's `completedAt` (an older job reporting late would look newer); `created_at` alone (a job scheduled for next week would look older than an ad-hoc job run tomorrow). The resolver also refuses while a job with later evidence has **any terminal row** on the device (`NOT EXISTS`, in the UPDATE): the newest job decides, a newer cancelled, superseded or unproven job is not clean (D4), and alerts with no stored evidence are covered. The backfill uses the same function. *Alternative:* only a newer `failed` row blocks; looser than §7's predicate.
5. **An anomaly with no episode is `unknown`: its alert stays open, counted and reported** (cause `no_episode`). Its settle signal is the episode named by `metric_anomalies.episode_id` when set; a row closed `cleared` counts as cleared. *Alternative:* a "clean buckets" signal; a new detection rule needs the owner (question 1). A close by a person (`close_reason` `user` or `snoozed`, episode `dismissed`, or a row `dismissed` / `resolved`) is never recovery: the alert stays until a person closes it. Mixed machine closes: all `cleared` → `condition_cleared`; otherwise any `detection_off` → `source_retired`; otherwise `expired`. A represented row that retention removed is `unknown`.
6. **The patch auto-resolve writes no close cooldown** (`closeCooldown: 'none'`). The rule's cooldown is 240 minutes; writing it on recovery would suppress a genuine failure up to four hours later, which is a trigger change (non-goal). The trigger-time cooldown is untouched. Every other resolve keeps `closeCooldown: 'lifecycle'` (today's behaviour). *Alternative:* keep it; a failure soon after a recovery then raises nothing.
7. **The backfill lives in `apps/api/scripts/backfill-stranded-builtin-alerts.ts` (+ `.lib.ts`), with a named `tsup` entry**, and needs **two** gates to write: `--apply --ids-file <reviewed.json>` **and** `BUILTIN_ALERT_BACKFILL_ENFORCE=true`. Default is report-only; an unrecognised value warns and reports only (`retentionEnforceFromEnv` semantics, `jobs/retentionBatch.ts:174`; precedents `AI_TRANSCRIPT_RETENTION_ENFORCE`, `AI_TOOL_DISCOVERY_RETENTION_ENFORCE`). One predicate builder per source, shared by report and apply (the transcript pattern, `services/aiTranscriptRetentionPredicates.ts`, not the discovery job's two hand-kept copies); apply narrows it by id. *Alternative:* D8's `--apply` alone.
8. **Backfilled patch rows must be provable.** A row counts as attempted only when its stored `output` is whole JSON with a successful entry matching the patch id or external id. Truncated, empty or unmatched output is reported as `ambiguous` and never written (owner question 3). *Alternative:* trust `completed`; per P13 a fallback looks the same.
9. **A baseline sighting matches on the same baseline, the same IP and the same normalised MAC, where the MAC was reported by that scan.** The MAC the comparison fills in from discovered assets (`services/networkBaseline.ts:807`) is cached data and does not count. No MAC on either side, or another IP: no match, stays open. One sighting closes every open `device_disappeared` alert for that pair. *Alternatives:* IP only (a reassigned address would close another machine's alert); MAC at any IP (the known entry stays at its old address, so the alert would be raised and closed every day).
10. **D7's principle is applied to three sites its list omits**, reason only: backup rows that vanished or were unlinked, EDR detections whose row was detached, and coverage pairs missing from the final state → `source_retired`. *Alternative:* leave them `condition_cleared`, which credits a fix when the subject went away. Other retirement paths already say `source_retired`.
11. **`unknown` reuses #12184's shape:** `passed: null`, `data: { reason: 'inventory_incomplete', observedAt }`, so persistence, events and remediation need no change. *Alternative:* D6's `evidence: { kind }`, a second spelling. `policy.not_assessed` is **not** published for it (that notice is keyed on `probe_cap`). **Absence is provable** iff `device_software_inventory_state` exists and its **latest** observation is `accepted_complete`. No state row (including after an install boundary, which keeps `software_inventory` rows) → unknown. Latest observation `rejected_partial | rejected_failed | rejected_truncated | rejected_count_collapse`, or legacy-empty → unknown. `accepted_legacy` with at least one item keeps today's behaviour (the spec names only legacy-**empty**). `rejected_out_of_order` is ignored in favour of the previous observation. While a state row exists, **presence in the accepted inventory is evidence whatever the latest scan's completeness**: a found package satisfies a required rule and fails a prohibited one, as today. It cannot clear a violation on old data, because a violation was itself read from the accepted inventory, so a package found there now was accepted after it. Only a **not found** result becomes `null` when absence is not provable. With no state row (the projection may belong to an earlier install) every software rule is `null`. *Alternative:* judge the last accepted projection only, which lets a month of failed scans keep proving absence.
12. **The contract names each resolver's test file** (`resolver.test`) instead of §5.3's `<module>.resolve.test.ts` naming rule; existing suites (`edrProviders/alerts.test.ts`, …) would otherwise be renamed for nothing.
13. **W01/W02 seam:** the three observed sources whose resolver lands in W02 carry `resolver: { pendingWave: 'W02' }`; the contract pins that set exactly and T19 deletes the variant from the type. *Alternative:* register them as `event` in W01, a false statement that passes.
14. **Offline and other engine emitters stay out**, per the spec's non-goal; they are allow-listed by path with a reason and a stale check.
15. **Producers not named in §6 keep calling `resolveAlert`** (with a typed cause) rather than moving to `resolveSourcedAlerts`. §5 says the helpers are "the only paths producers use", §6 says "reason corrections only" for OEM, EDR and coverage; §6 is the per-source list, so it governs. *Alternative:* convert all; larger behaviour change (evidence guards on sources whose trigger evidence is not stored).
16. **D3a applies where the resolver compares stored evidence: patch (T11), script (T15) and anomaly (T12, by appending).** Resolvers that re-read current state on every run (EDR, OEM, coverage, backup, isolation, warranty, compliance) need no stored occurrence. *Alternative:* refresh on every deduped trigger of every producer.
17. **A promotion whose linked alert has closed creates a new alert** (T12). Today it links the live anomaly to the closed alert, which D5 cannot represent: a closed alert can neither stand for nor settle a new condition. This is trigger-side, so it is called out here and in the W02 PR body. *Alternatives:* keep linking to the closed alert (the anomaly then has no open alert); reopen it (a lifecycle the spec does not have).
18. **A compliance close with no persisted row records `source_retired`** (T6). The close itself is today's behaviour; the row is gone because the rule or device record is, so nothing recovered. *Alternatives:* `condition_cleared` (credits a fix with no evidence); stop closing (strands alerts of deleted rules).
19. **The resolution envelope pins the closing org** (`orgId`, T1). Today's inline publish goes to the org that held the alert at the close; pinning keeps that when publishing moves after commit. Consumers that act on the payload (notification cancel, fix memory, webhooks) are unaffected by a device that changes org in between; a consumer that re-reads the alert row under the pinned org finds nothing and skips, exactly as after an inline publish today. *Alternative:* publish to the row's current org.

## Wiring

| File | Change | Wave · task |
|---|---|---|
| `services/alertDispatchEnvelope.ts`, `services/subjectAlertOutbox.ts` | `stagedResolutionDispatchSql`, retry/backoff on the resolution slot, flow frame | W01 T1 |
| `services/alertService.ts:930` + callers | `resolveAlert(alertId, cause, options)`; envelope in the CAS | W01 T2 |
| `services/alertLifecycle/evidence.ts`, `sourcedAlerts.ts` (new) | evidence type, guard builder, `resolveSourcedAlert(s)`, `refreshOpenSourcedAlert` | W01 T3 |
| `services/alertLifecycle/sourceRegistry.ts`, `sourceRegistry.contract.test.ts`, `__tests__/support/sourceScan.ts` (new) | registry (T3), AST scan (T4) | W01 T3–T4 |
| `services/outcomeProbes.ts`, `services/fixMemory/outcomeWatcher.ts` | `observedRecoveryAt` | W01 T5 |
| `services/warrantyAlertEvaluator.ts`, `services/configComplianceAlertBridge.ts`, `services/topology/monitoringAlerts.ts` | reasons / helper | W01 T6 |
| `services/alertService.ts`, `services/alertCreation.ts`, `services/networkIsolation/outcome.ts`, `routes/alerts/alerts.ts:105`, `routes/mobile.ts:1078` | D9 tag + scalar | W01 T7 |
| `apps/web/src/components/alerts/{AlertDetailPage,AlertDetails}.tsx`, `alertResolutionLine.ts`, 8 × `locales/*/alerts.json` | copy | W01 T8 |
| `apps/mobile/src/services/api.ts`, `screens/chat/blocks/alertLike.ts`, `screens/alerts/AlertDetailScreen.tsx` | scalar + copy | W01 T9 |
| `services/patchJobFinalizer.ts`, `services/patchAlerts.ts`, `services/patchRecovery.ts` (new) | D4 | W02 T11 |
| `services/metricAnomalyPromotion.ts`, `metricAnomalyEpisodeActions.ts`, `metricAnomalyEpisodeAlerts.ts`, `metricAnomalyAlertSettlement.ts` (new), `jobs/metricAnomalies.ts`, `routes/devices/anomalies.ts` | D5 | W02 T12 |
| `services/policyEvaluationService.ts`, `services/softwareInventoryEvidence.ts` (new) | D6 rules | W02 T13 |
| `services/softwareInventoryObservations.ts`, `jobs/policyEvaluationWorker.ts`, 2 web tabs, `apps/web/src/lib/complianceInventory.ts` (new), 2 × 8 locale files | D6 re-queue + copy | W02 T14 |
| `services/scriptExitCodeAlerts.ts`, `routes/scripts.ts`, `services/scriptBundle/index.ts` | D7 | W02 T15 |
| `services/oemUpdates/*`, `services/edrProviders/alerts.ts`, `services/securityAgents/*`, `services/backupProviders/alerts.ts` | D7 | W02 T16 |
| `services/networkBaseline.ts`, `services/networkBaselineRecovery.ts` (new) | sighting | W02 T17 |
| `jobs/networkIsolationSweeper.ts`, `services/networkIsolation/outcome.ts` | `kind` discriminator | W01 T4 |
| `jobs/networkIsolationSweeper.ts`, `services/networkIsolation/expiringAlerts.ts` (new) | expiring | W02 T18 |
| `services/alertLifecycle/sourceRegistry.ts` | pending set emptied | W02 T19 |
| `apps/api/scripts/backfill-stranded-builtin-alerts{,.lib}.ts`, `tsup.config.ts`, `package.json` | backfill | W03 T20–T21 |
| `docs/agents/alert-sources.md` (new), `CLAUDE.md` trigger row, `apps/docs/src/content/docs/features/alerts.mdx`, `deploy/environment.mdx`, `docs/release-notes/next-release-draft.md` | docs | W03 T22 |

## Execution split and parallelism

Opus for anything that resolves, refreshes or re-arms an alert, or touches tenancy or DB context. Sonnet-eligible tasks are marked. Within a parallel group, tasks share no file.

**W01** (API + web + mobile)
- **Group A, serial, Opus:** T1 → T2 → T3 (all three meet in `alertService.ts` / the outbox).
- **Group B, after T3, parallel, Opus:** T5 (fix memory) · T6 (three producers). Then **T4** (registry contract; runs against T6's result, owns every allow-list and the isolation discriminators).
- **Group C, after T4:** T7 (Opus; stamps the tag in the creators). Then **parallel:** T8 (web, **Sonnet**; locales included) · T9 (mobile, **Sonnet**). Seam: the scalar `resolutionClass: 'event' | 'manual' | null` from T7's Interfaces.
- T10 wave gate (orchestrator).

**W02** (API + two web tabs). `sourceRegistry.ts` is edited only by T19.
- **Group D, parallel, Opus, file-disjoint:** T11 patch · T12 anomaly · T13 compliance rules · T17 baseline · T18 isolation.
- **Group E, after Group D's T13, parallel:** T14 (API Opus, web copy **Sonnet**) · T15 (Opus) · T16 (**Sonnet**; an Opus reviewer reads the diff).
- T19 then the wave gate.

**W03**
- T20 → T21 serial, Opus. T22 **Sonnet**, parallel with T21. The region runs are an operator step, not a task.

**Test commands** (`docs/agents/testing.md`). From `apps/api`: `npx vitest run <file> [<file>…]` (never `pnpm --filter <pkg> test -- --run <path>`; the path filter is a substring match, so read the file count). Integration: `pnpm test-stack up` → `npx vitest run -c vitest.integration.config.ts <file>` → `pnpm test-stack down`. RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. Web: from `apps/web`, `npx vitest run <file>`. Mobile: from `apps/mobile`, `npx vitest run <file>`. Types: `NODE_OPTIONS=--max-old-space-size=20480 npx tsc --build apps/api/tsconfig.tests.json; echo $?` (never piped to `tail`). Every task's "Run" step uses these with the test files in its Files list.

---

# Wave W01 — registry, guarded helper, durable dispatch

**Outcome:** no behaviour change for a technician except the "closes when you resolve it" line; every close carries a reason and is announced durably; an undeclared producer fails CI. The PR closes the W01 sub-issue only.

### Task 1: the resolution slot carries every close

**Files:** Modify `services/alertDispatchEnvelope.ts`, `services/subjectAlertOutbox.ts`. Create `services/subjectAlertOutbox.resolution.test.ts` (no unit suite exists today). Test: `__tests__/integration/alertPublishAfterCommit.integration.test.ts`.

**Interfaces — Produces:**
```ts
/** SQL for the new `context` of a row being closed: drops `_subjectDispatch` and sets
 *  `_subjectResolutionDispatch` from the row's own columns (+ devices.site_id). */
export function stagedResolutionDispatchSql(opts: {
  eventId: string; resolvedAt: Date; resolvedBy: string | null; resolvedByPrincipalId: string | null;
  resolutionNote: string | null; resolutionReason: AlertResolutionReason | null; observedRecoveryAt?: Date;
  baseContext: SQL;              // the context expression to merge into (carries cursor / recoveredAt)
}): SQL;
```
The envelope: `{ eventId, eventType: 'alert.resolved', publisher: 'alert-service', siteId, cooldownMinutes: 0, occurredAt, retryOnPublishFailure: true, noiseControls: false, payload, flow? }`. `payload` keys and value formats equal today's (`alertService.ts:1043-1053`): ISO-8601 millisecond `Z` timestamps, `resolvedByPrincipalId` only when non-null; `observedRecoveryAt` only when given. `siteId` is `COALESCE(alerts.topology_site_id, (SELECT site_id FROM devices WHERE id = alerts.device_id))`, null with neither. The envelope also pins `orgId` (the row's org at the close); the drain publishes to `pending.orgId ?? row.orgId`, so a device that changes org between the close and the publish does not change who hears about it.

- [ ] **Step 1: failing tests.** Unit: `a failed resolution publish keeps the envelope, backs off 1, 2, 4 … 60 minutes and counts the attempt` (today the lease is dropped and it is retried first on every drain); `noiseControls false on a resolved rule-backed row records no transition and no cooldown`; `a subject resolution (no retryOnPublishFailure) keeps its current retry`; `a failed trigger keeps its one-minute retry and order`; `the resolution event carries the staged flow frame`. Integration: `an unpublished resolution is replayed by the minute drain with the same event id` (stage, throw in publish, drain again; both publishes carry one `eventId` and `occurredAt`); `100 failing resolutions do not block the 101st, also after their backoff has lapsed`; `a resolved alert dismissed before dispatch is still announced`; `a device moved to another org before dispatch is announced to the org that closed it`; `an envelope without orgId (staged by an older build) uses the row's org`; `a topology-owned row closed by a person carries its own site`; `a rolled-back close publishes nothing`.
- [ ] **Step 2:** run → FAIL on the new cases only.
- [ ] **Step 3:** implement: a **resolution** envelope with `retryOnPublishFailure` backs off `least(2 ^ failedAttempts, 60)` minutes and the resolution slot's candidates order by `failedAttempts` (0 when absent), then `created_at, id`, so envelopes never tried go first. **The trigger slot is unchanged** (one minute flat, oldest first): paging must not slow down after an event-bus outage. The resolution slot is claimed and renewed for `resolved` **and** `dismissed` rows (a resolved alert may be dismissed, `alertService.ts:767`). `SubjectAlertDispatch` gains `orgId?`. Update the module header.
- [ ] **Step 4:** both files pass; `npx vitest run src/services/hardwareHealth/retire src/services/workloads/retire` (their slot contract is unchanged).
- [ ] **Step 5:** commit `feat(alerts): resolution envelopes retry with backoff on the alert outbox`.

### Task 2: `resolveAlert` takes a cause and stages its event in the CAS

**Files:** Modify `services/alertService.ts:930-1060` and every caller: `jobs/monitorWorker.ts:383`, `services/patchAlerts.ts:467`, `services/alertService.ts:614,647`, `services/policyAlertBridge.ts:152`, `services/scriptExitCodeAlerts.ts:187`, `services/securityAgents/coverageAlerts.ts:124`, `services/edrProviders/alerts.ts:212,435`, `services/backupProviders/alerts.ts:377,378`, `services/backupProviders/alertsResolve.ts:32`, `services/oemUpdates/alerts.ts:343,372`, `services/metricAnomalyEpisodeAlerts.ts:64`, `services/metricAnomalyEpisodeActions.ts:214`, `services/complianceAlertReconcile.ts:164`, `services/configComplianceAlertBridge.ts:333` (temporarily `{ reason: 'condition_cleared' }`; T6 splits it), `services/alertSubjects.ts:86`, `services/hardwareHealth/retire.ts:28`, `services/workloads/retire.ts:33`, `routes/partnerApi/alertWrites.ts:128`. Tests: Step 4.

**Interfaces — Produces:**
```ts
export type SystemResolutionReason = Exclude<AlertResolutionReason, 'manual'>;
export type ResolveAlertCause =
  | { reason: SystemResolutionReason; actor?: never }
  | { actor: { userId: string } | { principalId: string }; reason?: never };   // recorded as 'manual'
export interface ResolveAlertOptions {
  note?: string;
  observedRecoveryAt?: Date;              // → context.lifecycle.recoveredAt and the payload
  recoveryCursor?: LeafCursors;
  deferSubjectEffects?: boolean;          // the subject path, unchanged
  closeCooldown?: 'lifecycle' | 'none';   // default 'lifecycle'
  guard?: SQL;                            // ANDed into the CAS predicate
}
export function resolveAlert(alertId: string, cause: ResolveAlertCause, options?: ResolveAlertOptions): Promise<boolean>;
```

- [ ] **Step 1: failing tests** (`services/alertService.resolutionReason.test.ts` unless said): `a system call with neither reason nor actor writes nothing, returns false and reports alert-resolve-missing-reason` (call through `as never`; assert no UPDATE); `a lost CAS returns false and reports nothing`; `a user actor records manual and resolvedBy`; `a principal actor records manual and resolvedByPrincipalId`; `the close, the reason and the envelope are one UPDATE`; `observedRecoveryAt lands in context.lifecycle.recoveredAt and keeps the cursor and snapshot`; `closeCooldown none records the transition but no cooldown`; `a guard that is false closes nothing and stages nothing`; `resolveAlert does not call publishEvent`. Integration (`alertPublishAfterCommit`): `a close inside a transaction is announced only after commit, once`; `a partner API close announces once`; `a crash between the CAS and publish is replayed by the drain`; `the payload of a system close equals the payload before this change`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement. Order: validate the cause → one UPDATE (`status`, `resolvedAt` …, `context` from `stagedResolutionDispatchSql`) with `and(buildResolveAlertCas(alertId), options.guard)` `.returning()` → the deferred subject branch (it must not leave the generic envelope on its row: choose the base context by a pre-decided flag, and keep W03's two-statement stage as is) → inline transition + cooldown as today → `scheduleStagedAlertDispatch(alertId)`. Update the JSDoc that lists what the RETURNING row may be read for.
- [ ] **Step 4:** convert callers and tests. Mocks: `jobs/{monitorQueue,monitorWorker.dbcontext,monitorWorker}.test.ts`; `routes/{partnerApi/alertExternalTickets,partnerApi/alertWrites,topology/investigation}.test.ts`; `services/{alertSubjects,complianceAlertReconcile,metricAnomalyEpisodeActions,metricAnomalyEpisodeAlerts,patchAlerts,policyAlertBridge,scriptExitCodeAlerts}.test.ts`; `services/{backupProviders/alerts.evaluate,backupProviders/alertsResolve,edrProviders/alerts,hardwareHealth/retire,oemUpdates/alerts,oemUpdates/overdueSweep}.test.ts`. Bare calls that now return `false` without a cause: `alertService.resolveCas.test.ts:85,92,100`, `alertService.resolveCasSql.test.ts:78,88`, `alertCooldownFallback.contract.test.ts:81`, `offlineTransitionEffects.integration.test.ts:366`, `alertPublishAfterCommit.integration.test.ts:533`. Prove none was missed: `grep -rnE "resolveAlert\(" apps/api/src "--include=*.ts"` and tsc exit 0.
- [ ] **Step 5:** run every file above plus `npx vitest run src/services/alertService src/services/aiAgents/alertVerdictSubscriber src/services/psaAlertTicketing`; the integration files; tsc.
- [ ] **Step 6:** commit `feat(alerts): typed close cause and durable alert.resolved in one UPDATE`.

### Task 3: evidence, guards and the sourced helpers

**Files:** Create `services/alertLifecycle/sourceRegistry.ts` (types and the full entry list from the inventory table; T4 adds the contract), `services/alertLifecycle/evidence.ts`, `services/alertLifecycle/sourcedAlerts.ts`, `sourcedAlerts.test.ts`, `__tests__/integration/sourcedAlertResolution.integration.test.ts`. Modify `services/alertService.ts` (`CreateAlertParams` / `CreateSourcedAlertParams` gain `triggerEvidence?: AlertEvidence`, merged into `context.lifecycle`).

**Interfaces — Produces:**
```ts
// sourceRegistry.ts: one entry per (source, subtype), content = the inventory table above
export type AlertEvidenceKind = 'job_started_at' | 'episode_close' | 'observation_at' | 'run_completed_at' | 'sighting_at' | 'state_transition';
type Identity = { source: string; subtype?: { key: string; value: string } } | { source: null; contextKeys: readonly string[]; contextValue?: string };
export type AlertSourceEntry = Identity & { emitters: readonly string[] } & (
  | { resolution: 'observed'; evidence: AlertEvidenceKind; retiresOn: readonly string[];
      resolver: { module: string; export: string; test: string } | { pendingWave: 'W02' } }
  | { resolution: 'event' | 'manual'; why: string });
export const ALERT_SOURCE_REGISTRY: readonly AlertSourceEntry[];
export function resolutionClassOf(context: Record<string, unknown>): 'observed' | 'event' | 'manual' | null;

// evidence.ts, sourcedAlerts.ts
export interface AlertEvidence { at: Date; id?: string | null }
/** stored: context.lifecycle.lastTriggerEvidence = { at: ISO-8601 ms Z, id: string | null } */
export interface SourcedAlertSelector {
  orgId: string;
  owner: { kind: 'device'; deviceId: string } | { kind: 'backup_workload'; ref: string } | { kind: 'org' };
  source: string; subtype?: string;
  match?: Record<string, string>;           // context keys; REQUIRED (throws) when the source has >1 subtype, or owner is 'org'
}
export interface SourcedResolution {
  reason: SystemResolutionReason; note: string;
  recoveryEvidence: AlertEvidence; observedRecoveryAt?: Date;
  legacyTriggerEvidence?: AlertEvidence;    // used only when the row stores none
  guard?: SQL; closeCooldown?: 'lifecycle' | 'none';
}
export function buildSourcedResolveGuard(recovery: AlertEvidence, legacy?: AlertEvidence): SQL;   // W03 reuses it
export function resolveSourcedAlert(alertId: string, r: SourcedResolution): Promise<boolean>;     // the per-row primitive
export function resolveSourcedAlerts(s: SourcedAlertSelector, r: SourcedResolution): Promise<{ resolved: string[]; failed: number }>;
export type RefreshOutcome = { kind: 'advanced' | 'newer_exists'; alertId: string } | { kind: 'none_open' };
export function refreshOpenSourcedAlert(s: SourcedAlertSelector, e: { evidence: AlertEvidence; contextPatch?: Record<string, unknown> }): Promise<RefreshOutcome>;
```
Guard (the decided algorithm):
```sql
requires_human = false
AND NOT (status = 'suppressed' AND suppressed_until IS NULL)
AND CASE
  WHEN jsonb_typeof(context #> '{lifecycle,lastTriggerEvidence,at}') = 'string'
    THEN ((context #>> '{lifecycle,lastTriggerEvidence,at}')::timestamptz,
          COALESCE(context #>> '{lifecycle,lastTriggerEvidence,id}', '') COLLATE "C") < ($at, COALESCE($id, '') COLLATE "C")
  WHEN $legacyAt IS NOT NULL THEN ($legacyAt, COALESCE($legacyId, '') COLLATE "C") < ($at, COALESCE($id, '') COLLATE "C")
  ELSE (triggered_at AT TIME ZONE 'UTC') < $at
END
```
`triggered_at` is tz-less UTC, as `alertLifecycle/cursor.ts` documents for `resolved_at`. Equal evidence does not resolve.

Rules: selection is ordered by `(created_at, id)`, 200 per call; each row runs in `withDbTransactionIfHeld` with the catch outside (a bad row is counted in `failed` and sent to Sentry, and never strands the rest). `refreshOpenSourcedAlert` is one UPDATE over the open statuses with the evidence-is-newer predicate; it merges `lifecycle.lastTriggerEvidence` and the patch keys in SQL (siblings kept), and publishes nothing. Zero rows updated is followed, in the same transaction, by a `SELECT … FOR UPDATE` of the open alert: found → `newer_exists` (the caller must not create), not found → `none_open`. Both statements block on the resolver's row lock, so a repeat that arrives during a close sees the closed row and raises a new alert. A malformed stored `at` throws inside the row's savepoint and is counted in `failed`. `contextPatch` may not contain `lifecycle`, `source`, or a key starting `_`.

- [ ] **Step 1: failing tests.** Unit (compiled SQL through `PgDialect`): `guard excludes requiresHuman, suppressed-forever and not-newer evidence`; `match is required for a multi-subtype source`; `org owner without match throws`; `contextPatch may not carry lifecycle, source or an underscore key`. Integration: `closes active, acknowledged and timed-suppressed`; `skips suppressed-forever`; `skips requiresHuman`; `equal evidence stays open`; `same instant, larger id closes`; `legacy row: triggered_at anchors`; `legacy row: a caller-supplied anchor wins`; `stored evidence beats the caller anchor`; `refresh between read and close wins` (two connections: hold the resolver after its select, refresh, release); `mute-forever landing after the read wins`; `a concurrent manual resolve wins: exactly one manual envelope and no sourced one`; `a missing id on either side still compares`; `a JSON-null at uses the legacy anchor`; `a repeat that waits on a close in progress reports none_open`; `one throwing row does not strand the next`; `refresh keeps the cursor and snapshot`; `refresh with older evidence reports newer_exists and writes nothing`; `an org-scoped context cannot close another org's alert with the same source and match`.
- [ ] **Steps 2–4:** FAIL (module not found) → implement → pass, plus `npx vitest run src/services/alertLifecycle src/__tests__/parkedFanout.contract.test.ts src/__tests__/alertInsertOwnerKind.contract.test.ts` (classify only if flagged).
- [ ] **Step 5:** commit `feat(alerts): guarded sourced-alert resolution and evidence refresh`.

### Task 4: the registry contract

**Files:** Modify `services/alertLifecycle/sourceRegistry.ts` (from T3; a leaf: string data and types, imports nothing that imports `alertService`), `jobs/networkIsolationSweeper.ts` and `services/networkIsolation/outcome.ts` (the `kind: 'expiring'` / `'outcome'` discriminator on new alerts, so both subtypes are statically known). Create `services/alertLifecycle/sourceRegistry.contract.test.ts`, `__tests__/support/sourceScan.ts` (`productionFiles`, `stripComments`, AST helpers). Modify `__tests__/alertTriggeredWriters.contract.test.ts` to import the first two.

**Interfaces — Consumes:** `AlertSourceEntry`, `ALERT_SOURCE_REGISTRY`, `resolutionClassOf` (T3).

**How the scan works, and why it cannot pass vacuously:**
1. Parse every production `.ts` under `apps/api/src` and `ee/*/src` with the TypeScript compiler API, so comments and unrelated strings cannot match. A **call site** is a call whose callee's final identifier is `createAlert` or `createSourcedAlert`, or `.insert(alerts)` / `.insert(x.alerts)`, or a string or tagged template matching `INSERT INTO alerts`. Import aliases (`import { createAlert as x }`) are followed; a wrapper (`createAlert: (p) => system(() => createSourcedAlert(p))`) is found through its inner call, and `deps.createAlert(` counts in its own file too.
2. Every file with a call site is in some entry's `emitters` **or** in `ENGINE_ALLOW_LIST` / `FIXTURE_ALLOW_LIST` (exact paths, each with a reason). Every listed path exists and still contains a call site (stale check).
3. Every `source` property in an emitter's `context` is resolved: a literal, an `as const`, a same-file `const`, or an imported `const` (one hop). The value must be registered **for that file**. An expression that cannot be resolved fails with `file:line: source is not statically known; use a constant`. A `source`-less call site must match a source-less entry's `contextKeys`. Where `context` is not an object literal the scan follows, within the file: an identifier to its declaration, a spread to the spread expression, and a call to the returned object literal of a same-file function (`reinstallCandidates/notify.ts`). A wrapper that forwards its parameter (`deps.createAlert = (params) => … createSourcedAlert(params)`, EDR and coverage) is not itself a source site; the calls **to** it are, and the file must contain at least one that resolves.
4. A source with more than one subtype: the discriminator's value at each call site, when statically known, must be registered; when it is a variable, every registered subtype value for that source must appear in the file as a literal or imported constant, and no unregistered member of the variable's type union may exist (checked against the registry set exported for that source).
5. Every `observed` entry: `await import(resolver.module)` has `resolver.export` as a function; in the AST of that module, the export's body, or a same-module function it calls, contains a call to `resolveAlert`, `resolveSourcedAlert(s)` or an injected close dependency whose default implementation in that module does (so a pure decision helper does not qualify; topology is the one named exception, its own UPDATE); and `resolver.test` exists, calls the export by name, and holds a `describe('alert source: <source>[:<subtype>]')` with at least one `it(`. Suites that lack that block get one in this task. The `pendingWave` set equals **exactly** `network_baseline:device_disappeared`, `network_isolation:expiring`, `patch-job-finalizer`.
6. `BUILT_IN_ALERT_RULE_SOURCES` ⊆ registry sources. `event` / `manual` have a `why` of at least 20 characters.
7. No file outside `CLOSE_ALLOW_LIST` sets `status: 'resolved'` in an `.update(alerts)`: `services/alertService.ts`, `services/topology/monitoringAlerts.ts`, the human paths `routes/alerts/alerts.ts`, `routes/alerts/correlations.ts`, `routes/mobile.ts`, `services/aiToolsAlerts.ts`, and any `services/monitors/conversion/*` file the first run finds (listed with its reason, stale-checked).
8. **Floors:** at least 23 emitter files **and** at least 28 registry entries, and the scan must itself find `services/edrProviders/alerts.ts` (injected dependency), `services/oemUpdates/alerts.ts` (constant source), `services/networkIsolation/outcome.ts` (raw insert) and `services/reinstallCandidates/notify.ts` (no source). An empty or mis-rooted walk therefore fails.
9. **Fixtures:** the same `scan(files)` function runs over in-memory sources: `an unregistered producer file fails with its path`; `an unregistered source literal in a registered file fails with file:line`; `an imported-constant source is resolved`; `an aliased import is seen`; `deps.createAlert is seen`; `a template source fails as not statically known`; `a source-less call outside a source-less entry fails`; `an unregistered subtype in a multi-subtype source fails`; `a forwarding wrapper with a resolved caller passes and without one fails`; `context built by a same-file function through a spread is resolved`; `a resolver export that never closes fails`; `a call inside a comment or string is ignored`; `a stale emitter fails`.

- [ ] **Step 1:** write the contract and fixtures; run `npx vitest run src/services/alertLifecycle/sourceRegistry.contract.test.ts` with the registry import stubbed to `[]` → FAIL listing all 23 emitter files.
- [ ] **Step 2:** use the real registry; correct entries and add the missing `describe` blocks until green. This task owns `CLOSE_ALLOW_LIST`; `services/warrantyAlertEvaluator.ts` is already absent from it because T6 lands first.
- [ ] **Step 3: mutation.** Delete the `dns_threat_evaluator` entry → FAIL naming `services/dnsThreatAlerts.ts` and a line; change the source constant in `services/oemUpdates/alerts.ts` → FAIL; point the walker at an empty directory → FAIL on the floor; remove the close call from `resolveClearedRebootPendingAlerts` → FAIL. Revert each; put the four outputs in the PR body.
- [ ] **Step 4:** `npx vitest run src/__tests__/alertTriggeredWriters.contract.test.ts` still green.
- [ ] **Step 5:** commit `feat(alerts): source registry and contract test`.

### Task 5: fix memory reads the observed recovery time

**Files:** Modify `services/outcomeProbes.ts:25-45`, `services/fixMemory/outcomeWatcher.ts:76-86,507-526`. Tests: `outcomeProbes.test.ts` (create if absent), `fixMemory/outcomeWatcher.test.ts`, `__tests__/integration/fixOutcomeLifecycle.integration.test.ts`.

**Interfaces:** `AlertRecoveryReading` gains `observedRecoveryAt: Date | null` (row: `context #>> '{lifecycle,recoveredAt}'`; event: `payload.observedRecoveryAt`). `readingFromAlert` returns `at: observedRecoveryAt ?? resolvedAt`. Only this reader changes; retention, re-arm, reports and PSA keep `resolved_at`.

- [ ] **Step 1: failing tests:** `condition_cleared uses the observed recovery time when present`; `falls back to resolvedAt`; `an invalid observed time falls back`; `source_retired and expired are never recoveries`; `the event fast path and the row sweeper give the same reading` (one fixture through both); integration `an alert whose recovery was before the fix started is cleared_before_fix even when the row closed later`.
- [ ] **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run src/services/outcomeProbes.test.ts src/services/fixMemory`; `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/fixOutcomeLifecycle.integration.test.ts`. **Step 5:** commit `feat(fix-memory): recovery time from alert evidence`.

### Task 6: warranty, compliance and topology state their reasons

**Files:** Modify `services/warrantyAlertEvaluator.ts:100-200,396-470`, `services/configComplianceAlertBridge.ts:313-334,359,430`, `services/topology/monitoringAlerts.ts:102-105,160`. Create `services/configComplianceAlertBridge.resolve.test.ts`. Tests: `warrantyAlertEvaluator*.test.ts`, `topology/monitoringAlerts*.test.ts`, integration `configComplianceAlerts`.

- **Warranty:** export `resolveWarrantyAlerts(deviceId: string, exit: 'subscription' | 'disabled' | 'not_expiring', now: Date): Promise<number>`. It keeps its own selection by `config_item_name = 'warranty_expiry'` (older rows have no `context.source`) and closes each row with `resolveSourcedAlert`, `recoveryEvidence: { at: now }`. `subscription` and `not_expiring` → `condition_cleared`; `disabled` → `source_retired`. Keep the aggregate "0 of N" warning.
- **Compliance:** `resolveOpenAlerts(..., note, cause)`: a persisted `compliant` row → `condition_cleared`, with `options.guard` = `EXISTS` (a `compliant` row for that key and device) so a violation committed after the handler's read wins; **no persisted row** → `source_retired` (the rule or device record is gone: today's close is kept, its reason is honest); Monitor-Only downgrade → `source_retired`. It stays on `resolveAlert` (rule-keyed lookup).
- **Topology:** Decision 2.

- [ ] **Step 1: failing tests:** `not expiring writes condition_cleared`; `alerting disabled writes source_retired`; `a warranty alert muted forever after the read stays muted` (integration); `a legacy warranty row without a source still closes`; `a warranty close is announced once, through the outbox`; `a persisted compliant row writes condition_cleared`; `no persisted row writes source_retired`; `a violation committed between the read and the close keeps the alert open` (integration, two connections); `Monitor-Only downgrade writes source_retired`; `topology recovery writes condition_cleared with the same outbox row, idempotency key and event id`; `topology still closes a muted alert`.
- [ ] **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run src/services/warrantyAlertEvaluator src/services/configComplianceAlertBridge.resolve.test.ts src/services/topology/monitoringAlerts`; `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/configComplianceAlerts.integration.test.ts src/services/warrantyAlertEvaluator.integration.test.ts`. **Step 5:** commit `feat(alerts): warranty, compliance and topology closes state a reason`.

### Task 7: the display tag (API)

**Files:** Modify `services/alertService.ts` (`createAlert`, `createSourcedAlert`), `services/alertCreation.ts:154`, `services/networkIsolation/outcome.ts:74` (stamp), `routes/alerts/alerts.ts:105` (`withMlAlertContext`), `routes/mobile.ts:1078` and the file's other alert select (`:1978`). Tests beside each.

**Interfaces — Produces:** `context.lifecycle.resolution: 'event' | 'manual'` written at creation from `resolutionClassOf(context)` (not written for `observed` or unregistered). API rows gain `resolutionClass: 'event' | 'manual' | null`, read from that tag only (an alert created before this ships reads `null` and shows nothing).

- [ ] **Step 1: failing tests:** `a dns_threat_evaluator alert is tagged event`; `a network_isolation outcome is tagged manual`; `a flow create_alert alert is tagged event`; `an observed source and a monitor alert carry no tag`; `the tag does not disturb the snapshot or cursor`; `alert detail and list return resolutionClass`; `the mobile inbox returns resolutionClass and no other context key`.
- [ ] **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run src/services/alertService src/services/alertCreation src/services/networkIsolation/outcome.test.ts src/routes/alerts/alerts.test.ts src/routes/mobile.test.ts`. **Step 5:** commit `feat(alerts): tag alerts that a person closes`.

### Task 8: web copy (Sonnet)

**Files:** Create `apps/web/src/components/alerts/alertResolutionLine.ts` + test. Modify `AlertDetailPage.tsx` (after `:390`), `AlertDetails.tsx` (header, after `:195`), `AlertList.tsx:43` (type), 8 × `apps/web/src/locales/*/alerts.json` (`alertDetailPage.resolutionLine`, English "Closes when you resolve it"). `alertLifecycleLine` is untouched (it returns null for alerts without re-arm values).

- [ ] **Step 1: failing tests:** `renders alert-resolution-line for event and manual while open`; `renders nothing for null, resolved or dismissed`; `an alert with both lines shows both`; a **parser** test per path: `fetchAlert keeps resolutionClass`, `normalizeAlertRows keeps resolutionClass`.
- [ ] **Steps 2–4:** `npx vitest run src/components/alerts src/lib/i18n`. **Step 5:** commit `feat(web): say when an alert closes only by hand`.

### Task 9: mobile copy (Sonnet)

**Files:** Modify `apps/mobile/src/services/api.ts` (`mapAlert` `:633`, type `:70`), `screens/chat/blocks/alertLike.ts:28`, `screens/alerts/AlertDetailScreen.tsx`. Same English string (the app has no i18n).

- [ ] **Step 1: failing tests:** `mapAlert keeps resolutionClass`; `toAlert keeps resolutionClass`; `an unknown value maps to null`. **Steps 2–4:** `npx vitest run src/services src/screens`; `npx tsc --noEmit`. **Step 5:** commit `feat(mobile): say when an alert closes only by hand`.

### Task 10: wave gate

- [ ] Full API, web and mobile unit suites; tsc exit 0. Contract suites: `alertTriggeredWriters`, `alertInsertOwnerKind`, `parkedFanout`, `singleReader`, `sourceRegistry`. Integration (read the executed counts): `alertPublishAfterCommit`, `sourcedAlertResolution`, `builtInAlertRuleUniqueness`, `builtinAlertProducersPublish`, `complianceAlertReconcile`, `configComplianceAlerts`, `fixOutcomeLifecycle`, `offlineTransitionEffects`, and the hardware-retirement suites. RLS coverage. One independent review round (high blast radius).
- [ ] Release-notes draft entry: `alert.resolved` is announced after commit and retried; no operator action.
- [ ] PR `feat(alerts): built-in alert source contract, guarded resolve path, durable alert.resolved (W01)`. Merge Danger: two-way door; every `alert.resolved` consumer (notifications, PSA, webhooks, fix memory, verdicts, Wisp) now hears it after commit and at least once.

---

# Wave W02 — resolvers

**Outcome:** patch, anomaly, baseline-absence and isolation-expiry alerts close on recovery; incomplete inventory is "not assessed"; a subject that went away closes as retired. Customer-visible: release note. The PR closes the W02 sub-issue only and says `Refs #10401`.

### Task 11: patch job failed (D4, D3a)

**Files:** Create `services/patchRecovery.ts`, `patchRecovery.test.ts`, `__tests__/integration/patchJobAlertRecovery.integration.test.ts`. Modify `services/patchJobFinalizer.ts:281-300,302-400,530-625`, `services/patchAlerts.ts:232-288`.

**Interfaces — Produces:**
```ts
export function patchJobEvidence(job: { id: string; startedAt: Date | null; createdAt: Date }): AlertEvidence;      // Decision 4
export function noNewerPatchJobTerminal(deviceId: SQLWrapper | string, e: AlertEvidence): SQL;   // NOT EXISTS any completed|failed|skipped row of a newer job; shared with W03
export function verifiedPatchSuccess(summary: ParsedAgentSummary | null, patch: { patchId: string; externalId: string | null }): boolean;   // shared with W03
export function resolvePatchJobFailure(input: { orgId: string; deviceId: string; patchJobId: string; completedAt: Date }): Promise<number>;  // never throws
```
`PendingRecovery` joins `PendingFailureAlert` on the transition outcome, set only when: `terminal.kind === 'result'` ∧ `countsAsCompleted` ∧ `!resultUnparsable` ∧ `parsed.success === true` ∧ no row written `failed` ∧ **at least one patch with `verifiedPatchSuccess`**: a matched `results[]` entry that itself says `success: true` or a success status. An entry with neither, a skipped entry, a batch fallback, or per-patch successes inside a failed batch do not count.

Order in `finalizePatchJobDevice`: apply → **recovery** → reboot evaluation → failure alert (recovery and failure are mutually exclusive, so no call holds the alert row while the emitter waits for it on its second connection). Recovery runs in `withDbTransaction` (a savepoint of the held context, so it commits with the result rows and its envelope), with the catch outside. Every door that can carry `kind: 'result'` (the polled executor `jobs/patchJobExecutor.ts:1762`, and `handleInstallPatchesResult` `services/patchJobFinalizer.ts:868-881` from both transports) holds a context and passes no foreign executor; T11 pins that with a test per door, and with no context held recovery is skipped and reported to Sentry (`patch-recovery-no-context`) rather than run on a second transaction. Not `runAfterDbContextCommit` (a crash would lose it).

Emitter: `emitPatchJobFailureAlert` calls `refreshOpenSourcedAlert` **first, before the maintenance gate and before `createAlert`** (P9), patching `{ patchJobId, failedCount }`; `advanced` or `newer_exists` returns that id and creates nothing. On `none_open` the maintenance gate and `createAlert` run as today with `triggerEvidence`; when `createAlert` returns null, refresh once more (a concurrent insert may have won). Refresh is evidence only: no event, no notification, no severity change. The refresh **never** moves `context.patchJobId` back (it is written only when the evidence advances).

Resolve: `source: 'patch-job-finalizer'`, `reason: 'condition_cleared'`, note `Auto-resolved: the device's newest patch job finished clean`, `observedRecoveryAt: completedAt`, `closeCooldown: 'none'` (Decision 6), `guard: noNewerPatchJobTerminal(...)`, `legacyTriggerEvidence` = evidence of the job in the row's `context.patchJobId` when that job still exists. Match on device and source, not on the rule (a rule can be renamed).

- [ ] **Step 1: failing tests.** Unit: `clean result resolves with condition_cleared and job evidence`; `partial failure refreshes evidence and stays open`; it.each `cancelled | expired | timeout | superseded | unparsable stdout | empty stdout | result with no matching entry | matched entry with no verdict | per-patch successes in a failed batch | all skipped → never resolves`; `recovery runs before the reboot evaluation`; `no held context skips and reports`; `a repeat failure during the cooldown refreshes instead of being dropped`; `a repeat failure during a maintenance window still advances the evidence and raises nothing`; `resolve failure never breaks the finalizer and leaves the outer transaction usable`; `patchJobEvidence falls back to created_at`. Integration (real finalizer, both executor paths): `fail then clean closes once and stages one event`; `a clean result from an older job does not resolve`; `a clean result does not resolve while a newer job ended skipped`; `each result door commits the close with its rows`; `a clean result older than the refreshed evidence does not resolve`; `clean and failure racing on two connections: the newer job decides in both orders`; `a rolled-back result closes nothing`; `a legacy alert with no evidence closes on a newer clean job and not on an older one`; `a genuine failure right after recovery raises a new alert when the trigger cooldown has lapsed`; `an org-scoped agent context closes only its own org's alert`.
- [ ] **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run src/services/patchRecovery.test.ts src/services/patchJobFinalizer.test.ts src/services/patchAlerts.test.ts`; `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/patchJobAlertRecovery.integration.test.ts src/__tests__/integration/aiAgentPatchReactive.integration.test.ts src/__tests__/integration/caughtQueryPatchPaths.integration.test.ts`. **Step 5:** commit `feat(alerts): patch job failure alerts close on the next clean job`.

### Task 12: metric anomaly (D5)

**Files:** Create `services/metricAnomalyAlertSettlement.ts` + test, `__tests__/integration/metricAnomalyAlertSettlement.integration.test.ts`. Modify `services/metricAnomalyPromotion.ts:167-330`, `services/metricAnomalyEpisodeActions.ts:255-320`, `services/metricAnomalyEpisodeAlerts.ts`, `routes/devices/anomalies.ts`, `jobs/metricAnomalies.ts`. Update the existing tests that pin the old behaviour: `metricAnomalyEpisodeAlerts` integration `:59` and `:88`, unit `:31`.

**Interfaces — Produces:**
```ts
export type Represented = { type: 'episode' | 'anomaly'; id: string };          // context.lifecycle.represents
export function appendRepresented(alertId: string, add: Represented[], evidence: AlertEvidence): Promise<boolean>;   // false when the alert is no longer open; set union in one UPDATE
export type Settlement = { settled: true; reason: SystemResolutionReason; at: Date } | { settled: false; cause: 'open' | 'human' | 'no_episode' | 'missing' };
export function settlementOf(rows: SettlementRow[]): Settlement;                // pure; Decision 5
export function reconcileMetricAnomalyAlerts(opts: { orgId?: string; after?: string; limit?: number }): Promise<{ examined: number; resolved: number; unsettled: Record<string, number>; failed: number; next: string | null }>;
```
- The represented set is `represents` ∪ `context.anomalyId` / `context.episodeId` ∪ episodes and anomalies whose `linked_alert_id` is this alert (so alerts created before this ships are covered). A named member whose row is gone is `missing`, never ignored.
- **Promotion is serialized per incident identity** with `pg_advisory_xact_lock` on (org, device, anomaly type, bucket seconds, window start), taken before the sibling lookup. Lock order everywhere: episode row → incident lock → alert row; sibling updates in id order; nothing takes an episode lock after the incident lock. An already-linked row or a promoted sibling is reused only when `appendRepresented` returns true; when that alert is closed, promotion creates a new alert and links it.
- Trigger evidence: `{ at: max(window_end) of the promoted rows }`, never the promotion clock (the resolve stage backdates `resolved_at` to the clean time). Recovery evidence and `observedRecoveryAt`: `max(resolved_at)`. Legacy anchor: `max(window_end)` of the linked anomalies.
- The close re-checks the settlement inside its transaction under a row lock on the alert (`SELECT … FOR UPDATE`, then `settlementOf`, then `resolveSourcedAlert`), and `appendRepresented` takes the same lock, so an append cannot fall between check and close.
- The route and the AI tool share `applyAnomalyStatus`: promoting a row whose episode is **open** delegates to `applyEpisodeAction('promote')` after the route's own access checks, with the route's response shape unchanged; `already_promoted` reuses the linked alert and appends; `episode_closed` or no episode keeps today's path and records the anomaly id.
- Reconciliation is its own repeatable job `reconcile-anomaly-alerts` on the `metric-anomalies` queue (`5-59/10 * * * *`), fleet-wide in system scope, **driven from the link columns** (`metric_anomaly_episodes_linked_alert_idx` and the anomalies' linked-alert index) to open alerts, keyset by alert id, 200 per page, at most 10 pages per run with the cursor carried to the next run, each page its own system context and each row isolated (T3). No 24 h window; `active`, `acknowledged` and timed-suppressed. `handleEpisodesClosed` calls it for its org for latency. Unsettled counts are logged once per run and exported as a gauge by cause.

- [ ] **Step 1: failing tests.** Unit table for `settlementOf`: all cleared; cleared + expired; any detection_off; user-closed; snoozed; dismissed; anomaly with no episode; missing row; empty set (never settled). Integration: `route promotion on an open episode links the episode`; `route promotion keeps its response shape and permission result`; `alert spanning two episodes stays open until both settle`; `detection_off closes source_retired`; `human dismiss with resolveAlert:false keeps the alert`; `reconciliation runs with no newly closed episode`; `an episode closed 30 days ago is reconciled`; `an org with no live device is reconciled`; `an acknowledged alert closes`; `an anomaly promoted before assembly stays open and is counted no_episode`; `a failing row does not stop the page`; `450 alerts are each visited once across runs`; `a promotion landing between read and close keeps the alert open`; `a promotion after the close creates a new alert instead of linking the closed one`; `two simultaneous first promotions of one incident create one alert`; `a legacy alert whose second member was removed by retention stays open and is counted missing`; `the reconcile query uses the link indexes` (EXPLAIN on a seeded table, no sequential scan on `alerts`).
- [ ] **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run src/services/metricAnomaly src/routes/devices/anomalies src/jobs/metricAnomalies`; `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/metricAnomaly`. If the EXPLAIN case cannot pass without an index, stop and report. **Step 5:** commit `feat(alerts): promoted anomaly alerts close when every condition they stand for settles`.

### Task 13: inventory-dependent compliance rules (D6)

**Files:** Create `services/softwareInventoryEvidence.ts` + test. Modify `services/policyEvaluationService.ts` (`DeviceEvaluationContext`, evaluators `:638`, `:707`, the two inventory loaders `:1877-1890`, `:2192-2205`). Tests: `policyEvaluationService.test.ts`, `.configPolicy.test.ts`, integration `configComplianceAlerts`.

**Interfaces — Produces:**
```ts
export type InventoryAbsence = { provable: true; observedAt: Date } | { provable: false; observedAt: Date | null };
export function loadInventoryAbsence(deviceIds: string[]): Promise<Map<string, InventoryAbsence>>;   // a device with no state row is absent from the map → not provable
```
Decision 11 is the rule. The map is loaded beside the inventory, in the same context, one query. `__evaluateRulesForDevice` (`:1135`) and any caller that omits the map keep today's behaviour, as `collectedProbes` does.

- [ ] **Step 1: failing tests:** `legacy-empty inventory is unknown: a required-software rule neither fails nor passes`; `and a prohibited-software rule neither fails nor passes`; `complete-empty inventory is absent: required fails, prohibited passes`; it.each `rejected_partial | rejected_failed | rejected_truncated | rejected_count_collapse → unknown when not found`; `rejected_out_of_order defers to the previous observation`; `accepted_legacy with items keeps today's result`; `no state row but software rows present → unknown` (install boundary); `a rejected latest scan: a required package in the accepted inventory still passes`; `a rejected latest scan: a prohibited package in the accepted inventory still fails`; `a rejected latest scan after a violation does not clear it`; `no state row: every software rule is null`; `rule A violation survives rule B unknown → non_compliant`; `A passes, B unknown → pending`; `unknown never queues remediation`; `unknown publishes no policy.violation, policy.compliant or policy.not_assessed`; integration `an open compliance alert neither closes nor re-raises on unknown`.
- [ ] **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run src/services/softwareInventoryEvidence.test.ts src/services/policyEvaluationService`; `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/configComplianceAlerts.integration.test.ts`. **Step 5:** commit `fix(compliance): incomplete software inventory is not assessed (Refs #10401)`.

### Task 14: re-evaluate when inventory completes; say why a rule is pending

**Files:** API (Opus): `services/softwareInventoryObservations.ts:555-570`, `jobs/policyEvaluationWorker.ts`, `services/policyEvaluationService.ts` (`evaluatePolicy` gains `deviceIds?: string[]`). Web (Sonnet): create `apps/web/src/lib/complianceInventory.ts` (mirror of `complianceProbeLimit.ts`); modify `components/devices/DeviceComplianceTab.tsx`, `components/configurationPolicies/ComplianceStatusTab.tsx`, 8 × `devices.json`, 8 × `policies.json`.

After an ingest whose observation became `absence_resolution_eligible` when the previous latest was not (an unchanged-empty inventory included, which the device-group hook's gate misses), `runAfterDbContextCommit` enqueues `evaluate-device-compliance { deviceId }`, `jobId: device-compliance-<deviceId>`, `removeOnComplete: true`, `removeOnFail: true` (a retained job would block the next add). The processor uses `commitThenEnqueue` (`:143`): config-policy rules, then standalone policies filtered to the device. It skips a parked device (`notParkedDeviceCondition`). A device-filtered `evaluatePolicy` does **not** advance the policy's `last_evaluated_at` (`:2012`), which drives the due scan for every other device. A lost enqueue is repaired by that scan.

- [ ] **Step 1: failing tests:** `incomplete then complete enqueues once`; `complete then complete does not`; `an exact retry does not`; `a rolled-back ingest does not`; `unchanged-empty becoming complete enqueues`; `the job evaluates only that device` (spy on both paths); `repeated targeted jobs for one device do not postpone the full evaluation of another`; `a parked device is skipped`; `events are published after commit`. Web: `inventory_incomplete renders compliance-inventory-incomplete copy, not plain Pending`; parser keeps `data.reason`.
- [ ] **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run src/services/softwareInventoryObservations.test.ts src/jobs/policyEvaluationWorker src/services/policyEvaluationService src/__tests__/parkedFanout.contract.test.ts`; from `apps/web`: `npx vitest run src/lib/complianceInventory src/components/devices/DeviceComplianceTab src/components/configurationPolicies/ComplianceStatusTab src/lib/i18n`. **Step 5:** commit `feat(compliance): re-evaluate a device when its inventory completes`.

### Task 15: script exit code retirement (D7)

**Files:** `services/scriptExitCodeAlerts.ts` (new export, D3a refresh at the dedupe `:121-135`), `routes/scripts.ts:1035-1130,1240-1245`, `services/scriptBundle/index.ts:829-839`. Tests beside, integration `scriptExitCodeRetirement.integration.test.ts`.

**Interfaces — Produces:** `retireScriptExitCodeAlerts(input: { scriptId: string; why: 'deleted' | 'mapping_changed'; now: Date }): Promise<number>`: re-reads the script's committed mapping and `deleted_at`, then closes its open alerts whose stored `context.exitCode` maps to no severity (all of them when deleted or the mapping is empty) as `source_retired`, evidence `{ at: now }`, restricted to orgs the script's owner reaches (its org, or its partner's orgs). Called with `runAfterDbContextCommit` in a fresh `withSystemDbAccessContext`, because a partner-wide script's alerts live in orgs the request may not see. At-most-once by design: the next save or delete repeats it.

D3a: a mapped failure that finds the script's alert open calls `refreshOpenSourcedAlert` (evidence `{ at: run completed_at, id: executionId }`, patch `{ exitCode, executionId }`) instead of being dropped, so retirement and the backfill read the **latest** failing code; on `none_open` it creates as today. A clean run closes through `resolveSourcedAlert` with the same evidence shape. Muted-forever and dismissed behaviour is unchanged.

- [ ] **Step 1: failing tests:** `a repeat with another mapped code refreshes the stored code`; `removing the mapping of an earlier code keeps the alert when the latest code still maps`; `an older run reported late does not move the evidence back`; `soft delete closes every open alert of that script, in each org of the owning partner`; `clearing the mapping closes all`; `a mapping change closes only codes that no longer map`; `a bundle import that replaces the mapping does the same`; `an unrelated script or another partner's org is untouched`; `muted-forever stays`; `a rolled-back save closes nothing`; `saving with an unchanged mapping closes nothing`.
- [ ] **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run src/services/scriptExitCodeAlerts src/services/scriptBundle src/routes/scripts src/services/commandResultHandlers.exitCodeAlerts`; `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/scriptExitCodeRetirement.integration.test.ts`. **Step 5:** commit `feat(alerts): script exit-code alerts retire with the script or its mapping`.

### Task 16: retirement reasons (Sonnet, Opus reads the diff)

**Files:** `services/oemUpdates/{alerts,overdueSweep}.ts`, `services/edrProviders/alerts.ts`, `services/securityAgents/{coverageAlerts,coverageReconcileRun}.ts`, `services/backupProviders/alerts.ts`, their tests.

| Site | Now | Becomes |
|---|---|---|
| OEM verdicts with `LEFT_MANAGEMENT` (`overdueSweep.ts:180,188,193,198`); `resolveOemAlert` gains a `reason` | `condition_cleared` | `source_retired` |
| EDR endpoint row gone (`alerts.ts:428`); detection detached or deleted (`:191-215`) | `condition_cleared` | `source_retired`; a detection with a closed status stays `condition_cleared` |
| Coverage: vendor no longer required, or pair missing from final state (`coverageReconcileRun.ts:313-320`); `resolve(alertId, reason)` | `condition_cleared` | `source_retired`; a present pair whose kind cleared stays `condition_cleared` |
| Backup row vanished, unlinked or moved (`backupProviders/alerts.ts:378`) | `condition_cleared` | `source_retired`; a present row in good state stays `condition_cleared` |

- [ ] **Step 1:** one failing test per cell: the retired case and the still-cleared case. **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run src/services/oemUpdates src/services/edrProviders/alerts.test.ts src/services/securityAgents src/services/backupProviders/alerts`. **Step 5:** commit `fix(alerts): retirement closes say source_retired`.

### Task 17: baseline device disappeared

**Files:** Create `services/networkBaselineRecovery.ts` + test. Modify `services/networkBaseline.ts` (`createNetworkChangeAlert` passes `triggerEvidence: { at: the discovery job's completed_at, else detectedAt; id: changeEvent.id }`; the call sits after the baseline update). Integration: `networkBaselineRecovery.integration.test.ts`.

**Interfaces — Produces:** `resolveReappearedDevices(input: { orgId: string; baselineId: string; hosts: Array<{ mac: string | null; ip: string }>; seenAt: Date }): Promise<number>`. One query lists the baseline's open `device_disappeared` alerts (`context.baselineId`, `context.eventType`), their `context.ipAddress` and `context.macAddress` (normalised with `normalizeMac`) are matched in memory against the **raw** `scannedHosts` (before enrichment), and each match closes by id with `resolveSourcedAlert`: `condition_cleared`, evidence `{ at: seenAt }`, where `seenAt` is the discovery job's `completed_at` (or `started_at`), never the processing clock; with neither, nothing closes. It runs under the baseline row lock the comparison already holds, sequentially in the scan's transaction, each row in `withDbTransaction` with the catch outside, so an alert failure never loses the scan. Alerts may sit on a fallback device or be re-homed (`routes/networkChanges.ts:369`), so device id is never part of the match.

- [ ] **Step 1: failing tests:** `same MAC, same IP closes`; `same MAC, another IP stays`; `a MAC filled in from cached assets does not close`; `a delayed older scan does not close a newer disappearance`; `a differently formatted MAC closes`; `same IP, different MAC stays`; `no MAC on either side stays`; `one sighting closes three daily alerts`; `another baseline or org is untouched`; `new_device, device_changed and rogue_device are never closed`; `a sighting no newer than the disappearance does not close`; `a resolve failure keeps the scan's writes`.
- [ ] **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run src/services/networkBaseline`; `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/networkBaselineRecovery.integration.test.ts`. **Step 5:** commit `feat(alerts): a device seen again closes its disappeared alert`.

### Task 18: isolation expiring

**Files:** Create `services/networkIsolation/expiringAlerts.ts` + test. Modify `jobs/networkIsolationSweeper.ts` (a settle pass after the warn pass; the `kind` discriminator shipped in T4). Integration: create `__tests__/integration/networkIsolationExpiringAlerts.integration.test.ts`.

**Interfaces — Produces:** `settleExpiringIsolationAlerts(now: Date): Promise<number>`: open `network_isolation` alerts with `kind = 'expiring'`, or older rows with `expiresAt` and no `state` in context; keyset pages of 200; matched on `isolationId`. Candidates are read in system scope; a missing isolation row is handled before the lock (`withEpisodeLock` skips its callback then) → `source_retired`. Under the episode lock, in this order: state `expired` → `expired`; released or `desired_state = 'released'` → `condition_cleared`; `expires_at` later than the alert's `expiresAt` **and** outside the 12-hour warning window → `condition_cleared`; an extension still inside the window → nothing (the warning is still true); a generation bump alone → nothing. Evidence `{ at: now }` read under the lock; a second warning for the same isolation is a new alert with its own evidence. Each row: `withSystemDbAccessContext` → `withDbTransaction`, catch outside.

- [ ] **Step 1: failing tests:** one per branch above, plus `a natural expiry records expired, not condition_cleared`, `a short extension inside the warning window keeps the alert`, `an outcome alert for the same isolation is never closed` (the shared source string), `a policy change that bumps the generation closes nothing`, `older rows without kind are matched`, `muted-forever stays`, `one failing row does not stop the page`.
- [ ] **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run src/services/networkIsolation src/jobs/networkIsolationSweeper.test.ts`; `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/networkIsolationExpiringAlerts.integration.test.ts`. **Step 5:** commit `feat(alerts): isolation-expiring alerts close on extend or release`.

### Task 19: empty the pending set; wave gate

**Files:** `services/alertLifecycle/sourceRegistry.ts` (three resolvers named, `pendingWave` variant deleted from the type), `sourceRegistry.contract.test.ts` (assertion becomes "no pending"), `docs/release-notes/next-release-draft.md`, `apps/docs/src/content/docs/features/alerts.mdx` (one paragraph; T22 completes it).

- [ ] Contract red first: delete the variant → tsc and the contract fail until all three resolvers are named. Mutation: rename `resolvePatchJobFailure` → the contract fails on the import.
- [ ] Gate as T10, plus `patchJobAlertRecovery`, `metricAnomalyAlertSettlement`, `scriptExitCodeRetirement`, `networkBaselineRecovery`, the isolation suites, `policyComplianceAlertDelivery`, `deviceComplianceLiveRules`, `softwareInventoryObservations`; `fixOutcomeLifecycle` gains `a finalizer-resolved patch alert counts as a recovery at observedRecoveryAt`.
- [ ] Live leg on a worktree stack (synthetic devices): fail a patch job, run a clean one, see the alert close with its reason and one notification; promote an anomaly, let the episode clear, see it close; send an incomplete inventory, see the "not assessed" copy. Tear the stack down.
- [ ] PR `feat(alerts): built-in alert resolvers (W02)`. Merge Danger: alerts now close by themselves for every customer; revert is two-way, but a closed alert stays closed.

---

# Wave W03 — backfill and docs

**Outcome:** alerts already left open in the three OD2 classes can be closed once per region from a reviewed list. Nothing runs on deploy. The PR closes the W03 sub-issue only.

### Task 20: shared predicates

**Files:** Create `apps/api/scripts/backfill-stranded-builtin-alerts.lib.ts`, `.lib.test.ts`, `apps/api/src/__tests__/integration/builtinAlertBackfill.integration.test.ts`.

**Interfaces — Produces:**
```ts
export type BackfillSource = 'patch-job-finalizer' | 'metric_anomaly' | 'script_exit_code';
export interface BackfillCandidate { alertId: string; orgId: string; source: BackfillSource; evidence: { at: string; id: string | null }; reason: SystemResolutionReason; observedRecoveryAt: string; verdict: 'verified' | 'ambiguous'; fingerprint: string }
export function loadBackfillCandidates(source: BackfillSource, scope: { ids?: readonly string[]; after?: string; limit: number }): Promise<BackfillCandidate[]>;   // THE predicate: report passes no ids, apply passes ids
export function backfillEnforced(env?: NodeJS.ProcessEnv): boolean;     // true/1 only; else report-only, a typo warns
```
- **Patch:** newest job for D by Decision 4's order having **any** terminal row; ≥ 1 `completed` with `patch_id`, zero `failed | pending | running | queued`, every `exit_code` NULL or 0, `completed_at` not NULL, evidence after the alert's (T3's guard; legacy anchor = the job in `context.patchJobId`, else `triggered_at`); `noNewerPatchJobTerminal` from T11. `verified` = `verifiedPatchSuccess` over the whole-JSON `output` for at least one patch and `success: true` on the summary (Decision 8).
- **Anomaly:** T12's `settlementOf` over the same rows; only `settled`.
- **Script:** later `script_executions` row for the same (device, script), `status = 'completed'`, `exit_code` not NULL, completed after the alert's evidence, whose code maps to no severity under the script's **current** mapping, and no later run that does map; script not deleted.
- All: open statuses, not muted forever, not `requiresHuman`; device-owned; parked devices excluded; keyset by alert id, `limit` ≤ 200.
- `fingerprint` = SHA-256 over (org, owner, device, source, status, stored trigger evidence, recovery evidence, reason, `observedRecoveryAt`).

- [ ] **Step 1: failing tests** (integration, per predicate): positive case; newest job has a failed / queued row; skipped-only newest job; truncated output → `ambiguous`; missing `results[]` entry → `ambiguous`; late older job; human-dismissed episode excluded; no-episode anomaly excluded; mapped later run excludes; NULL exit code excludes; muted-forever and requiresHuman excluded; `report and apply render the same WHERE` (compile both, strip the id clause, compare). `backfillEnforced`: unset, `''`, `yes`, `TRUE`, `1`, `false`.
- [ ] **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run scripts/backfill-stranded-builtin-alerts`; `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/builtinAlertBackfill.integration.test.ts`. **Step 5:** commit `feat(alerts): backfill predicates for alerts left open`.

### Task 21: the script

**Files:** Create `apps/api/scripts/backfill-stranded-builtin-alerts.ts` + test. Modify `apps/api/tsup.config.ts` (named entry `scripts/backfill-stranded-builtin-alerts`), `apps/api/package.json` (`alerts:backfill-stranded`), `apps/api/src/system/connections/internalEnvVars.ts`, `.env.example`, `apps/docs/src/content/docs/deploy/environment.mdx`.

Usage: `node dist/scripts/backfill-stranded-builtin-alerts.cjs [--source <s>] [--org-id <uuid>] --out <file>` writes the report (JSON of candidates plus counts by source, verdict and unsettled cause; ids only, no titles or host names). `BUILTIN_ALERT_BACKFILL_ENFORCE=true … --apply --ids-file <reviewed.json>` writes. Either gate missing → report-only, exit 0, and it says which. `ambiguous` entries in an ids file are refused.

Apply: pages of 50 ids; each id in its own `withSystemDbAccessContext` (short transaction) with the catch outside; lock the alert row (`SELECT … FOR UPDATE`, the lock every D3a refresh and `appendRepresented` also takes), then re-select through `loadBackfillCandidates({ ids: [id] })`; a missing row or a changed `fingerprint` is **skipped and reported** (`already_closed | evidence_changed | no_longer_matches`); then `resolveSourcedAlert` with the **freshly computed** reason, evidence and `observedRecoveryAt` (equal to the reviewed ones by fingerprint) and a `guard` that pins org, device and source, and for patch `noNewerPatchJobTerminal`, note `Closed by a one-time correction: the condition had already recovered`, `closeCooldown: 'none'`. One second between pages. Exit 1 if any row failed. A rerun is a no-op. `closeDb()` in `finally`.

- [ ] **Step 1: failing tests:** `dry-run writes nothing` (row digests before and after); `--apply without the env flag writes nothing`; `the env flag without --apply writes nothing`; `apply closes exactly the reviewed ids`; `a row whose evidence changed since the report is skipped and reported`; `a candidate that appeared after the report is not touched`; `a script failure committed between the re-select and the close either keeps the alert open or raises a new one` (two connections); `a device moved to another org after review is skipped`; `rerun is a no-op`; `one failing row does not stop the rest and exits 1`; `an ambiguous id is refused`; `each close stages one alert.resolved envelope`; `a fix that started after the real recovery is not credited` (through `fixOutcomeLifecycle`). Build check: `pnpm --filter @breeze/api build && node apps/api/dist/scripts/backfill-stranded-builtin-alerts.cjs --help`.
- [ ] **Steps 2–4:** FAIL → implement → pass. Run: `npx vitest run scripts/backfill-stranded-builtin-alerts src/system/connections/envInventory.test.ts`; **Step 5:** commit `feat(alerts): report-first backfill script for alerts left open`.

### Task 22: docs (Sonnet)

**Files:** Create `docs/agents/alert-sources.md` (adding a producer: registry entry, class, evidence, resolver, test; the guard rules; the outbox; what the contract prints). Modify `CLAUDE.md` (one trigger row: "Adding or changing code that creates or closes alerts → `docs/agents/alert-sources.md`"), `apps/docs/src/content/docs/features/alerts.mdx` ("When alerts clear": a table of source → what closes it), `docs/release-notes/next-release-draft.md`, `apps/api/src/data/docsIndex.json` (regenerate with `scripts/build-docs-index.ts`).

- [ ] Docs build; docs-index test; commit `docs(alerts): when built-in alerts clear`.

### Wave gate and the operator run

- [ ] Gate as T10. PR `feat(alerts): backfill for alerts left open, docs (W03)`.
- [ ] **After the release is deployed, per region, each step with the owner's go:** (1) report-only run; (2) the owner reviews counts by source and verdict and the id list; (3) apply `--source patch-job-finalizer`, read the skip report, then the other two; (4) unset the env flag; (5) record counts. Closing publishes `alert.resolved`, so notifications, PSA closes and webhooks fire for each (owner question 4).

---

## Open questions for the owner

1. **Should a promoted anomaly that never joined an episode be able to close by itself?** (Decision 5: today it has no settle signal, so its alert stays open until a person closes it. If the originally reported alert is of this kind, G3 is not met for it.)
   - A. Leave it open and count it (this plan). Pro: no new detection rule. Con: that class stays manual.
   - B. Let assembly adopt promoted rows that have no episode, so the normal episode close applies. Pro: one signal for all. Con: changes the episode pipeline; needs a spec addendum.
   - C. A "no matching anomaly for N hours with fresh telemetry" rule. Pro: no pipeline change. Con: a second recovery signal to keep in step.
   - **Recommend A now, B as a follow-up if T12's `no_episode` counter shows more than a handful** — it answers with data.
2. **Do the two producers added after the spec get resolvers in this feature?** (remote-access-tool alerts; reinstall-suspected.)
   - A. Register as human-closed (this plan). Pro: no unreviewed design. Con: they stay open until someone closes them.
   - B. Add resolvers in W02. Pro: complete. Con: both need a design (tool absence needs a full-scan signal; a cleared reinstall flag may mean "kept" or "merged").
   - **Recommend A**, with a follow-up issue — neither design has been reviewed.
3. **May the backfill close patch alerts whose stored result cannot be proven?** (Truncated or empty output; a fallback success looks the same as a real one.)
   - A. No: report as ambiguous, wait for the next clean job (this plan). Pro: no wrong close. Con: some stay open a little longer.
   - B. Yes, after a manual review of that list. Pro: cleans more at once. Con: a person cannot tell either from stored data.
   - **Recommend A** — once W02 is live, the next clean job closes them.
4. **Should the backfill's closes notify?** (They publish `alert.resolved` like any close: notifications, PSA ticket closes, webhooks.)
   - A. Yes, normally (this plan). Pro: PSA tickets close, integrations stay in step. Con: one burst per region.
   - B. Silent close. Pro: quiet. Con: tickets and integrations keep showing them open; needs a second code path.
   - **Recommend A**, off-hours, source by source — a silent close leaves other systems wrong.

## Review round

One round, 2026-11-24: `codex exec -m gpt-6.2-astra`, effort `xhigh`, read-only, stdin closed, foreground, on the first draft (`2aabdbddb7`). 18 findings (15 high, 3 medium); its recommendation was to hold Gate B until they were addressed. Findings 1, 9, 10, 11, 12, 13 and 15 were checked against the code before folding; 2, 3, 4, 5, 6, 7, 8, 14, 16, 17 and 18 were folded or declined on the reviewer's citations and the planner's earlier reading. Finding 7's first fold (a stale projection may not satisfy a required rule) was withdrawn after review, because it would have turned compliant devices to "not assessed" whenever one scan was rejected; Decision 11 has the final rule.

**Folded**

| # | Finding (short) | Where |
|---|---|---|
| 1 | Pin the owner org and site in the resolution envelope | T1 |
| 2 | Apply: lock first, compare a full fingerprint, use fresh values, pin ownership in the CAS | T20, T21 |
| 3 (second half) | One "newest job" classifier for close and backfill | Decision 4, T11, T20 |
| 4 | Recovery inside the result's own transaction, before the reboot step; no second transaction | T11 |
| 5 | Serialize promotion; never link to a closed alert | T12 |
| 6 (first half) | Legacy `context.anomalyId` / `episodeId` count as represented; a missing member is unknown | T12 |
| 7 (main point) | Inventory kept from an earlier install (no state row) proves nothing, present or absent | Decision 11, T13 |
| 8 | Compliance close is guarded by the persisted row; no row → `source_retired` | T6 |
| 9 (dismissal, fairness) | Dispatch survives a later dismissal; exponential backoff, untried first | T1 |
| 10 | Explicit per-patch success inside a successful batch, one shared function | T11, T20 |
| 11 (first half) | Script repeats refresh the stored code | T15, Decision 16 |
| 12 | Baseline: scan-reported MAC, same IP, scan time | Decision 9, T17 |
| 13 | Isolation: expiry first, short extension keeps the warning, missing row outside the lock | T18 |
| 15 | A targeted evaluation does not move the policy clock | T14 |
| 16 | Guard and refresh defined at their edge cases | T3 |
| 17 | Contract covers forwarding wrappers and built contexts; a resolver must close something | T4 |
| 18 | Task order and the discriminators fixed; the manual-resolve assertion corrected | Execution split, T3, T4 |

**Declined, with reasons**

| # | Finding | Reason |
|---|---|---|
| 3 (first half) | Suppress a late failure from an older job when a newer job already finished clean | It changes a trigger (non-goal): a failure the device really reported would raise nothing. The alert closes on the next clean job, and no cooldown is written against it |
| 6 (second half) | Retire old single-episode closers before enabling the new promotion | Only a rolling-deploy overlap of one worker generation; an old worker then behaves exactly as today. A two-step release costs more than the window |
| 7 (rest) | Load package membership and completeness from one observation | The evaluator reads a projection table by design; replacing its inventory source is a redesign of compliance evaluation, outside D6. While a state row exists, a package in the accepted inventory was accepted after any violation read from it, so an old copy cannot clear one; completeness is read first in the same transaction, so a race delays a verdict by one evaluation. Items of a rejected scan stay unread, as today |
| 9 (deletion) | Copy the envelope to an outbox that outlives the device | Trigger envelopes already share the row's fate; the window is seconds, and the alert itself is deleted with the device. It would need a table (no-migration constraint) |
| 11 (second half) | Backfill runs whose nonzero exit code maps to no alert | §7's predicate is `status = 'completed'` and OD2 fixes the three predicates; being stricter only leaves an alert for the live resolver |
| 14 | Persist cooldown and flap writes and order them with the event | Existing behaviour of every rule-backed alert, unchanged here. Decision 1 keeps it on purpose; a transactional noise-control store is a separate design |
