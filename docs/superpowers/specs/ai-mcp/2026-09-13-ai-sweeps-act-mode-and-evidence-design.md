# AI scheduled sweeps — act mode, certificate evidence, and fix-by-trigger provenance

**Date:** 2026-09-13
**Status:** Draft. Advisor quorum run (Codex `gpt-6-astra`, `xhigh`, read-only, 2026-09-13) — see Review log. Awaiting written-spec review.
**Anchor issue:** LanternOps/breeze#4442 (act-mode auto-execution of scheduled-sweep proposals)
**Cluster:** #4442 · #4230 (`expiring_certs` evidence source) · one unfiled item, *fix-by-trigger tagging* (issue text proposed in §8)
**Context:** #4173 (fleet fan-out, canary → widen) and #4175 (auto-promote) are adjacent and stay deferred; this spec deliberately does not pre-empt either.
**Extends:** `2026-08-28-ai-agents-phase2-intelligence-layer-design.md` §4.2 / §4.5 / §7, the P2-2 plan (`plans/ai-mcp/2026-08-29-ai-agents-p2-2-scheduled-sweeps.md`) and the P2-5 plan (`plans/ai-mcp/2026-09-01-ai-agents-p2-5-graduation.md`).

Every code claim below is labelled **verified** (read on `origin/main` at the cited line), **inferred**, or **not-checked**.

---

## 1. Problem

Scheduled sweeps ship and work: a cron occurrence fans out one device-less `sweep`-profile run per org, system-executed evidence loaders feed the model bounded rows, and each `proposedAction` becomes a **device-scoped supervised action intent** — a card a human clicks. Three gaps sit on top of that.

**(A) Act mode is hard-wired off for sweeps.** `resolvePolicyDecisionState` returns `'human_required'` the moment an intent carries an explicit scope (`intentService.ts:679`, **verified**), and every sweep proposal carries one (`sweepFindings.ts:335`, **verified**). So the whole policy-decide lane — pre-authorized op keys, the exposure ledger, graduation — is structurally unreachable from sweeps. The comment on that line names #4442 as the thing that replaces it (**verified**, `intentService.ts:660-678`).

**(B) The `expiring_certs` sweep kind has no evidence source** (#4230). It was cut from the v1 kind list because the product had no SSL data path.

**(C) Nothing records *why* a remediation fired.** A tech looking at a device's Activities feed sees "service restarted" and cannot tell whether a human, an alert, a policy or Tuesday's 06:00 sweep caused it. `script_executions.trigger_type` has an `'alert'` member but no `alert_id` column, so the alert that triggered a script run is **unrecoverable today** (**verified**, `scripts.ts:220`). Reports cannot group by cause, and recurrence ("we keep fixing this") cannot be counted at all.

### 1.1 The blocker nobody had written down

The quorum surfaced a defect that changes the ordering of all of this, and it is **verified**:

`watchReleasedIntent` (`intentReleaseWorker.ts:544-570`) grades a released intent three ways. When **no fix watch is possible — "the run has no triggering alert"** — it credits `verified` immediately, in the same transaction, on the grounds that "an operation no watch will ever look at must not sit un-gradeable forever" (C4). A sweep run is `triggerKind: 'schedule'` with `alert_id NULL`, and `createIntentFixWatchRow` requires `anchor.alertId` (`fixWatch.ts:291`, `IntentForWatch.alertId: string`, **verified**).

Therefore: **every sweep-minted intent that executes is credited `verified` with zero verification.** P2-5's graduation ladder (≥ `promoteThreshold` verified, 0 failed/recurred, ≥14 days) is, for the sweep lane, a click-counter. Turning act mode on before fixing this would auto-promote op keys on evidence that proves only "the button was pressed 20 times".

So #4442's real prerequisite is not "graduation stats exist for one partner" — it is **sweep-condition fix watches**. That becomes W02, ahead of the act-mode gate.

---

## 2. Users & scope

- **Partner (MSP) techs** are the actors. Act mode is armed per **partner baseline schedule** and can only be *tightened* per org, matching how `enabled`/`sweepKinds` already resolve on `ai_agent_schedules` (dual-owner, org XOR partner — **verified**, `types/aiAgentSchedules.ts:100-119`).
- **Org-scoped users** see the outcome (Activities chip, run detail, approvals cards) but never arm autonomy: `manage_ai_agents` is denied to the `ai_agent` principal, and key promotion is a four-eyes human intent (P2-5, **verified** via `supervisedKeyGrant.ts`).
- **Fix-by-trigger tagging is partner- and org-neutral** — it is provenance on rows that already exist, in whatever org those rows already live.
- **Certificate evidence is org-scoped** in v1: `network_monitors` is org-only, no `partner_id` (**verified**, `db/schema/monitors.ts:9-31`). Sweep evidence loaders are org-pinned by construction (`loadX(orgId)`), so this costs nothing today; partner-wide network monitors arrive with monitors W4 (#5241) and are out of scope here.

---

## 3. Proposed design — act mode for sweep proposals (#4442)

### 3.1 The execution unit is the intent, not a child run

The phase-2 spec called act-mode sweep execution a **"child run"** (§4.2). That phrasing predates `action_intents.scope_kind`/`scope_device_id` (P2-2 Task A3). **We do not introduce a child `ai_agent_runs` row.** The device-scoped intent already *is* the per-device unit, and every piece the child run was invented to carry already exists on it:

| Child-run job | Where it already lives (**verified**) |
|---|---|
| device-exact pinning | `action_intents.scope_device_id` + `intentTargetScope.ts` (tombstone on delete/org-move → `agent_scope_lost`) |
| live policy + guardrail re-run | `policyDecide.ts:593-608` at decide time with the **scoped** device; `agentReleaseAuthority.ts:278-306` again at release, against both the snapshot and the current policy |
| reserve | `runAuthorizeTransaction` → `ai_unattended_exposure` under a per-org advisory lock (`policyDecide.ts:298-346`) |
| execute | `intentReleaseWorker` |
| verify / fix-watch | `ai_agent_fix_watches` is already **intent-anchored** (`intent_id`, `source_kind`, `op_keys[]`) — P2-5 built this precisely so N intents from one run get N episodes |
| impact rollup | `impactRollup.ts:241` already counts executed intents directly |

A second run row would duplicate budget, circuit and trace accounting for a step that spends no LLM tokens. **Cost of this choice (quorum, accepted):** the run-detail page today loads only *pending* intent ids (`routes/aiAgents.ts:1306`) and the sweep card links generically to `/approvals` (`RunDetailPage.tsx:788`). Act mode makes the interesting outcomes *non-pending*, so W05 must add live per-intent outcomes and a per-device roll-up to the sweep view. That is UI work, not a data-model argument for a child run.

### 3.2 What replaces the `hasScope` line

`resolvePolicyDecisionState`'s `if (args.hasScope) return 'human_required'` becomes a narrow allowance. A scoped intent is `'unattempted'` **only if all of** the following hold; anything unresolved fails closed to `human_required`, as every other branch in that function does:

1. `BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED` (new env sub-flag, default off) **and** the existing `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`. Two flags, because the sweep lane widens autonomy to targets the run never established for itself and must be revocable without disarming alert-triggered policy-decide.
2. The scope was minted by a **sweep proposal**, identified by the new `action_intents.trigger_kind = 'sweep_finding'` from §5 — not by "has a scope" (a ticket scope or a future scope kind must not inherit this allowance).
3. The producing schedule is act-armed: `ai_agent_schedules.act_mode = true` on the **effective** (baseline ∧ override) schedule.
4. The intent's **subject** matches a persisted, system-collected observation for that device (§3.3).
5. Freshness: `now() - run.finished_at ≤ SWEEP_ACT_TTL` (default 30 min, ≤ the schedule's own cadence). A proposal that has sat is stale evidence.

Everything downstream is unchanged: tier 3, `supervised`, `mode === 'act'`, key in **both** the live effective policy and the run's immutable snapshot, kill state, guardrail re-run, caps. Constraint 3 of #4442 ("present in BOTH the partner baseline and the org row") needs **no new code** — `mergeAgentPolicies` intersects the two (`effectivePolicy.ts:294-299`) and a missing org row resolves to `[]` (`:191-193`), both **verified**. It needs a *contract test* on the sweep path, which is what has been missing.

**Op-key reality check (verified):** of the two proposable actions, only `manage_services:restart` is in `POLICY_DECIDABLE_TIER3`; `remediate_vulnerability` is not. Act mode for sweeps v1 therefore covers **exactly one op key**. That is the right size for a first cut and should be stated on the UI, not discovered.

### 3.3 Subject pinning — the anti-substitution control

The quorum falsified a premise in the first draft: **`evidenceDeviceIds` is not persisted.** The run outcome stores `sweepProposals[]` and a `sweepEvidenceTruncated` boolean, and its docstring says outright "the evidence itself is never stored on the run" (**verified**, `runLoopTypes.ts:210-217`). Device ids are assembled in memory during `persistSweepFindings` and discarded.

Worse, device identity is not enough. A `service_down` observation is about `(device, service name)`. If the act-mode gate only re-checks "this device was in the evidence", model-authored evidence about service *A* can authorize a restart of service *B* on the same box.

So `SweepProposalRecord` (already persisted on the run outcome, already scalars-only) gains a **trusted subject**, written by the system from the loader row it matched — never from model text:

```
subject: { kind: AiSweepKind; key: string; observedAt: string }
```

with `key` derived per kind by a pure, tested function (`service_down` → the service name from the evidence row; `disk_pressure` → the mount point; `unpatched_critical` → the sorted device-vulnerability ids). The act gate requires the intent's arguments to match that subject exactly (reusing `assertArgsMatchScope`'s shape from `intentTargetScope.ts:198`), and the freshness re-evaluation below is *subject-pinned*, not device-pinned.

### 3.4 Condition re-evaluation at decide time

Before authorizing, re-evaluate the single subject against live state. Three outcomes, not two (quorum finding — a predicate aging out of a 24-hour window is not proof of recovery, and `failed_backups` selects the latest *failed* job so a later success never clears it; **verified** at `sweepEvidence.ts:343`, `:396`):

- **present** → proceed to `runAuthorizeTransaction`.
- **cleared** → `degradeToHumanRequired(intentId, 'sweep_condition_cleared')`. The intent becomes an ordinary supervised card; **no evidence row is written**, so no auto-demote. (There is no `superseded` intent status and we are not adding one — **verified**, `db/schema/actionIntents.ts:50`.)
- **unknown** (device offline, query inconclusive) → `degradeToHumanRequired(intentId, 'sweep_condition_unknown')`. Fail closed.

This needs a **second loader shape** — the existing kind loaders are fleet-wide, threshold-bearing, MAX+1 sampling queries and are not verification APIs. Add `sweepSubjectProbe.ts`: one `probe<Kind>(orgId, deviceId, subjectKey) → 'present' | 'cleared' | 'unknown'` per act-eligible kind. v1 needs exactly one (`service_down`), so this is small; the module exists so the next kind cannot skip it.

### 3.5 Fan-out accounting against the exposure ledger

The ledger's real arithmetic (**verified**, `exposureBudget.ts:84-108`): the fleet cap is over the **set union** of distinct devices in a rolling 24 h window projected with the candidate — not a running sum — and the day cap counts `source='policy_intent'` **rows** per `(org, agent)`, i.e. actions, so two intents on one device consume one device slot but two day slots.

At `persistSweepFindings`, after the existing gates and before minting intents, compute a **deterministic canary cohort** under the same per-org advisory lock the authorize path uses, read-only:

1. Order act-eligible proposals by `(severity desc, kind asc, deviceId asc, subjectKey asc)` — fully documented, never iteration order.
2. Walk that order accumulating distinct devices; stop at the first proposal that would breach **either** `|existing ∪ cohortDevices| ≤ allowance` **or** `policyDecisionsToday + cohortActions ≤ maxPolicyDecisionsPerDay` **or** a new hard per-occurrence cap `maxUnattendedDevicesPerSweep` (new `AiAgentLimits` field, default **3**, merged with `min`).
3. Cohort members are minted with `trigger_kind = 'sweep_finding'` and are act-eligible. **Every other proposal is minted exactly as today** — a supervised card. Nothing is dropped.

The first draft proposed **all-or-nothing** (the whole occurrence acts or none of it does). The quorum killed it on starvation: a 40-device fleet at the 5% default allows 2 devices, so an org with 3 persistent eligible targets would never act, forever, with no signal. A documented deterministic prefix gets the same "not an arbitrary subset" property without that failure mode. (Recorded as Open Decision 2 because it is a genuine product judgement, not only a mechanical one.)

**No pre-reservation.** The first draft reserved M exposure rows in one transaction at fan-out with a new `source: 'sweep_fanout'`. The quorum proved this breaks the authorize path: `sweep_fanout` rows would be excluded from the day count (which filters `source='policy_intent'`), `runAuthorizeTransaction` would still insert its own reservation and attach *that* id, and its rollback cannot undo a prior transaction's rows (**verified**, `policyDecide.ts:334`, `:373`). The cohort computation stays a **readiness check**; each intent's own `attemptPolicyDecision` performs the real, single, idempotent reservation exactly as today. The cohort cap is what bounds over-subscription; a member that loses the race degrades to `human_required` normally, and the design must not promise atomic execution of a cohort whose members can still individually fail revalidation.

### 3.6 Kill, brake, and auto-halt

- **Ordinary brake:** flip `ai_agent_schedules.act_mode` off (partner) or set the org override off (org). This must be re-checked **at release**, not only at creation — replacing the creation gate cannot revoke intents already authorized, and the existing release checks cover the policy flag and key authorization but know nothing of schedules (**verified**, `revalidateRelease.ts:84`). Add the schedule-armed check to `revalidateApprovedIntentForRelease`, terminal `agent_policy_denied`.
- **Emergency:** the existing global kill switch plus the kill-epoch comparison at release (`agentReleaseAuthority.ts:352-364`), unchanged.
- **Automatic halt:** P2-5's auto-demote already removes the op key from the org row on the first ATTEMPTED `failed` or a fix-watch `recurred`, which makes every subsequent sweep proposal for that key fall back to a human card. That is the auto-halt; it needs a test on the sweep path, not new machinery.

### 3.7 What gates graduation for the sweep lane

Beyond P2-5's existing ladder, act mode for a `(org, op)` pair additionally requires **≥ `sweepPromoteThreshold` (default 10) `verified` evidence rows whose intent was sweep-minted** — verified evidence from alert-triggered, run-bound intents demonstrates the *op* is safe, not that sweep **target selection** is right, and target selection is the entire new risk.

The first draft implemented this as a new `sweep_intent` value in `AI_AGENT_EVIDENCE_SOURCE_KINDS`. Quorum rejected it (correctly): that column records *what terminal event produced the row*, not *what caused the action*; conflating them would make `watch` vs `sweep_intent` mutually exclusive when a sweep-triggered watch is both. Instead the graduation query joins to `action_intents.trigger_kind = 'sweep_finding'` from §5 — which is why fix-by-trigger tagging is **W01**, a prerequisite, not a nice-to-have.

And none of it counts until W02 makes `verified` mean something for a sweep (§1.1).

### 3.8 Sweep-condition fix watches (W02)

`ai_agent_fix_watches` gains an alert-less shape: `subject_kind` (the `AiSweepKind`), `subject_key`, and `subject_device_id`, with the existing `alert_id` nullable for these rows. Grading at the watch deadline calls the same `sweepSubjectProbe` from §3.4: `cleared` → `held_qualified` → `verified`; `present` again after an observed clear → `recurred`; `unknown` → no evidence row (never a `failed`). `watchReleasedIntent`'s "no watch is POSSIBLE" branch must stop firing for sweep-minted intents — it is the exact line that makes today's `verified` vacuous.

---

## 4. Proposed design — `expiring_certs` evidence (#4230)

### 4.1 The finding that reframes the issue

Both of the issue's candidate paths are further along than the issue believed (**verified**):

- The Go agent's `http_check` handler **already reads** `resp.TLS.PeerCertificates[0].NotAfter` and emits `sslExpiry` / `sslDaysRemaining` (`agent/internal/heartbeat/handlers_monitor.go:270-275`), and `agentWs.ts:1242-1250` **already persists the whole result map** into `network_monitor_results.details` (jsonb). Grep finds **no reader anywhere in the repo**. This is a *read* problem, not a *collect* problem.
- The monitors framework already ships a `cert_expiry` **kind** — but its handler reads `devices.mtls_cert_expires_at`, i.e. Breeze's own agent mTLS certificate (`services/alertConditions/handlers/certExpiry.ts:16`). Those are auto-renewed at 2/3 of life with a 24 h agent-side self-renewal backstop, so a finding sourced there fires only when Breeze's own renewal machinery is broken. That is a Breeze incident, not customer hygiene — and the kind's name is actively misleading. Renaming it is out of scope; §8's issue text should note it.

### 4.2 Decision: typed TLS observation columns on `network_monitors`

Promote the already-collected value out of the untyped blob into typed columns on `network_monitors`, written in `recordMonitorCheckResult` beside the existing `lastStatus` / `lastResponseMs` writeback:

| column | why |
|---|---|
| `tls_not_after timestamptz` | the actual expiry |
| `tls_observed_host varchar(255)` | **the endpoint the certificate actually belongs to.** Redirects follow by default and the certificate comes from the *final* response, so a monitor on `http://a.example` can report `b.example`'s cert (quorum, **verified** at `handlers_monitor.go:188`, `:221`, `:270`). Without this the finding lies. |
| `tls_issuer varchar(255)` | not collected today — a ~2-line Go addition alongside the existing block |
| `tls_observed_at timestamptz` | staleness bound |
| `tls_state varchar(16)` | `observed` \| `handshake_failed` \| `not_tls`. A TLS failure returns *before* certificate extraction, so an already-expired or untrusted endpoint yields **no** cert data today; a null `tls_not_after` must not read as "fine". |

The sweep loader is then a plain org-pinned SELECT in the established shape (`WHERE nm.org_id = $1 AND nm.is_active AND nm.tls_state = 'observed' AND nm.tls_observed_at > now() - interval '7 days' AND nm.tls_not_after <= now() + interval '45 days' ORDER BY tls_not_after ASC LIMIT MAX+1` with `COUNT(*) OVER ()`). Lifecycle rules the quorum required: exclude inactive monitors, bound staleness, and **invalidate the observation when `target` or `config` changes** (a delayed result from a previous configuration must not be attributed to the new one — the worker currently overwrites state unconditionally, **verified** `monitorWorker.ts:496`).

**Rejected: a standalone `ssl_check` monitor kind (v1).** Not because it needs a new scheduler — the quorum correctly notes the dispatcher is type-independent (`monitorWorker.ts:560`) — but because the monitor-definitions model is device-scoped (episodes and state key on `(monitor_id, device_id)`) and a certificate on a customer's public endpoint has no natural device. Monitors W4 explicitly builds its `network_check` adapter **over `networkMonitors`** (monitoring design `:379`), so these columns are on the table W4 adopts, not orphaned by it.

**Rejected: agent mTLS as MSP-facing evidence** (§4.1).

**Deferred, not rejected: TLS on `tcp_port` monitors.** A ~15-line Go change would widen coverage to any 443 target, but a TCP check's contract today is connect + optional plaintext banner (`handlers_monitor.go:133`); changing it implicitly would alter existing monitors' behaviour. It is an explicit opt-in flag in a later increment.

### 4.3 Sweep-kind wiring (mechanical, per #4230's own list)

`expiring_certs` into `AI_SWEEP_KINDS`; the `ai_agent_schedules_kinds_chk` CHECK in a new migration; a loader in `sweepEvidence.ts` (the map is exhaustive over the enum, so this is a **compile error until written** — good); **bump `.max(6)` → `.max(7)` in `validators/aiAgentSchedules.ts:161`**, which is hardcoded to the enum size and is the one step easy to miss; kind labels in all 8 locales (`aiAgentsPage.schedules.kindLabels.*`, `aiAgentsPage.runs.sweep.kinds.*`); the kinds-equality case in `aiAgentSchedulesPartnerRls.integration.test.ts`.

**Finding-only.** `SweepProposedAction` is a closed two-member union and there is no safe automated certificate renewal, so `expiring_certs` proposes nothing and is act-mode-irrelevant by construction.

---

## 5. Proposed design — fix-by-trigger tagging (unfiled)

### 5.1 The envelope

One shared three-column envelope, stamped **at creation** on the execution rows reports group by. Text + SQL CHECK, never `pgEnum`, matching `action_intents`' deliberate convention (`db/schema/actionIntents.ts:40-48`, **verified**):

| column | meaning |
|---|---|
| `trigger_kind text` | new shared const `REMEDIATION_TRIGGER_KINDS` = `manual`, `schedule`, `sweep_finding`, `alert`, `monitor`, `fleet_finding`, `policy`, `automation`, `ticket`, `anomaly`, `api`. Superset-compatible with `AI_AGENT_TRIGGER_KINDS` and `initiated_by`; neither is replaced. |
| `trigger_ref_id uuid NULL` | the **occurrence** row (no FK — the referenced row may be pruned or live in a table the writer cannot import). Per kind: `sweep_finding` → the sweep `ai_agent_runs.id`; `alert` → `alerts.id`; `monitor` → `monitor_definitions.id`; `fleet_finding` → `fleet_findings.id`. Sweep findings have no id of their own (they are `(runId, findingIndex)`, **verified** `sweepFindings.ts:332`), which is why the run id is the occurrence and the index lives in `trigger_key`. |
| `trigger_key varchar(200) NULL` | a **stable semantic key**, mirroring `fleet_findings.semantic_key`: `sweep:service_down:MSSQLSERVER`, `alert:disk_low:C`, `monitor:<builtin_key>`. This is the join key across occurrences and the thing a chip can render without a lookup. |

All three are scalars → all `included` in `CORE_TENANT_EXPORT_POLICY`.

### 5.2 Where it is stamped

`action_intents`, `script_executions`, and — the quorum caught both of these — **`automation_action_results`** (the per-action, org-pinned row that identifies the individual script/command execution; `automation_run_device_results` is an aggregate, and `automation_runs` has no `org_id` at all and is correctly absent from the export registry), plus **direct agent act-mode executions**, which bypass intents entirely and live in `outcome.executedActions` (`impactRollup.ts:251`). A canonical remediation identity across those four representations must be defined in W01 or the reports will both omit and double-count.

`audit_logs` gets **no new columns** — it is append-only, hot, and carries a checksum chain. The writer copies the same envelope into the existing `details` jsonb (already `excludedOpen`, so no new classification), and the device Activities feed renders a second chip beside the existing initiator chip (`DeviceActivityFeed.tsx:459-480`, **verified**), reading `details->>'triggerKind'` / `details->>'triggerKey'`. Caveat the quorum raised and this spec accepts: audit writes commit independently and async retries can drop them (`auditService.ts:49`, `:90`), so the feed is a *convenience view*, not the reporting source of truth — reports read the typed columns. Open Decision 4 records the alternative.

### 5.3 Recurrence is episodes, not executions

The first draft counted `GROUP BY device_id, trigger_kind, trigger_key`. The quorum is right that **execution frequency is not recurrence**: several attempts can address one continuously failing condition. The existing recurrence semantics require an observed recovery followed by a *new* matching signal (`fixWatch.ts:800`, **verified**), and monitors W3 encodes the same idea as episodes.

So: `trigger_key` is the **identity** a recurrence counter groups by, and the **counter** is episodes with recovery boundaries — the sweep-condition watches from §3.8 for the sweep lane, `fix_watches`/alerts elsewhere. Reports read "3 recurrence episodes of `sweep:service_down:MSSQLSERVER` on this device in 30 days", never "7 restarts".

---

## 6. Tenancy & data model impact

**No new tables.** Every change is a column on an already-registered table, which means the org-cascade and device-cascade lists are untouched and the **export-policy registry fires on every single one** (the row in CLAUDE.md that triggers on a new *column*). All five targets are already registered (**verified**, `tenantExportPolicyRegistry.ts` lines 53, 77, 124, 370, 487).

| Table | New columns | Shape | Export bucket |
|---|---|---|---|
| `ai_agent_schedules` | `act_mode boolean NOT NULL DEFAULT false` | dual-owner (org XOR partner) — the one-owner CHECK, dual-axis policy and partner-wide `FOR SELECT` branch already exist and are unchanged | `included` |
| `action_intents` | `trigger_kind`, `trigger_ref_id`, `trigger_key` | shape 1 (`org_id`) | `included` ×3 — and each must be added to the `action_intents_immutable_trg` allowlist decision explicitly (creation-time only, never updated) |
| `script_executions` | same three | shape 1 | `included` ×3 |
| `automation_action_results` | same three | shape 1, `org_id` pinned to the **device's** org | `included` ×3 |
| `ai_agent_fix_watches` | `subject_kind`, `subject_key`, `subject_device_id`; `alert_id` becomes nullable | shape 1 | `included` ×3 |
| `network_monitors` | `tls_not_after`, `tls_observed_host`, `tls_issuer`, `tls_observed_at`, `tls_state` | shape 1, org-only | `included` ×5 |

Notes that bind implementation:

- Every migration is hand-written, idempotent, no inner `BEGIN`/`COMMIT`, and **must `SELECT set_config('breeze.scope','system',true)` before any DML** (backfilling `act_mode`, defaulting `tls_state`) — 425 of 442 tables force RLS and bind the owner, so an unelevated backfill silently matches zero rows.
- Filenames must sort **after main's newest committed migration** (`2026-10-16-180200-…` at the time of writing; slots `180300` and `180500` are claimed by in-flight PRs). Do not name for today's date.
- `network_monitors` has **no `partner_id`**. Nothing here adds one; that is monitors W4 / #5241.
- Making `ai_agent_fix_watches.alert_id` nullable relaxes a constraint on a table with a partial UNIQUE on `intent_id` — the partial index is unaffected, but the existing "one watch per intent" invariant must be re-asserted in the same PR.
- No composite FK to `organizations(id, org_id)` is added, so no new `DEFERRABLE INITIALLY IMMEDIATE` obligation arises. `automation_action_results` and `action_intents` already carry theirs.

---

## 7. Out of scope

- **Fleet fan-out canary → widen (#4173).** `maxUnattendedDevicesPerSweep` is a per-occurrence *cap*, not a widening ladder. No auto-widening here.
- **Auto-promote (#4175).** Humans still flip autonomy; this spec only adds a *stricter* gate to a human-initiated promotion.
- **`remediate_vulnerability` as a policy-decidable key.** Adding it to `POLICY_DECIDABLE_TIER3` is its own review with its own effect-pin design.
- **Renaming the `cert_expiry` monitor kind**, adding partner-wide ownership to `network_monitors`, or shipping monitors W3/W4.
- **TLS handshake on `tcp_port` monitors** (§4.2, deferred increment).
- **Backfilling trigger provenance onto historical rows.** New columns are nullable and stamped going forward; `NULL` reads as "unknown trigger" in the UI.
- **Adding `org_id` to `automation_runs`.**

---

## 8. Proposed GitHub issue — fix-by-trigger tagging (do not file from this spec; text for review)

**Title:** `Fix-by-trigger tagging: stamp remediation provenance (sweep kind / finding / alert / schedule) on every execution row`

**Body:**

> Today nothing records *why* a remediation fired. A tech on a device's Activities feed sees "service restarted" and cannot tell whether a human, an alert, a configuration policy, or Tuesday's 06:00 AI sweep caused it. Reports cannot group by cause, and recurrence ("we keep fixing this every week") cannot be counted at all.
>
> Concrete gap, verified on `main`: `script_executions.trigger_type` has an `'alert'` member but **no `alert_id` column** (`apps/api/src/db/schema/scripts.ts:220`), so the alert that triggered a script run is unrecoverable. `automation_runs.triggered_by` is a free-text `varchar(255)` on a table with no `org_id`. `action_intents` reaches provenance only through the single hop `requesting_agent_run_id → ai_agent_runs.trigger_kind`.
>
> **Proposal.** One shared three-column envelope, stamped at creation, text + SQL CHECK (matching `action_intents`' no-`pgEnum` convention):
> - `trigger_kind text` — new shared `REMEDIATION_TRIGGER_KINDS` (`manual`, `schedule`, `sweep_finding`, `alert`, `monitor`, `fleet_finding`, `policy`, `automation`, `ticket`, `anomaly`, `api`), superset-compatible with `AI_AGENT_TRIGGER_KINDS` and `audit_logs.initiated_by`; neither is replaced.
> - `trigger_ref_id uuid NULL` — the occurrence row, no FK.
> - `trigger_key varchar(200) NULL` — a **stable semantic key** (`sweep:service_down:MSSQLSERVER`), mirroring `fleet_findings.semantic_key`. This is what makes cross-occurrence grouping possible; the occurrence id alone cannot.
>
> Stamped on `action_intents`, `script_executions`, `automation_action_results` (the per-action org-pinned row — `automation_run_device_results` is an aggregate and `automation_runs` has no `org_id`), and direct agent act-mode executions in `ai_agent_runs.outcome.executedActions`. A canonical remediation identity across those four representations must be defined first or reports will both omit and double-count.
>
> `audit_logs` gets **no new columns** (append-only, hot, checksum chain) — the same envelope goes into the existing `details` jsonb, and the device Activities feed renders a chip beside the existing initiator chip (`apps/web/src/components/devices/DeviceActivityFeed.tsx:459-480`). Audit writes commit independently and can be dropped on retry, so the feed is a convenience view; reports read the typed columns.
>
> **Recurrence is episodes, not executions.** Several attempts can address one continuously failing condition. `trigger_key` is the identity to group by; the counter is episodes with recovery boundaries (fix watches / alerts / monitor episodes), never a count of execution rows.
>
> **Tenancy:** no new tables. All five target tables are already in `CORE_TENANT_EXPORT_POLICY`, and the export-policy contract fires on a new **column** — every new column is a scalar and classifies as `included`. Migrations must elect `breeze.scope = 'system'` before any DML.
>
> Blocks the graduation gate in #4442, which needs to distinguish sweep-minted intents from alert-triggered ones. Related: #4230.
>
> Design spec: `docs/superpowers/specs/ai-mcp/2026-09-13-ai-sweeps-act-mode-and-evidence-design.md` §5.

**Labels:** `category:ai`, `priority:p1`, `roadmap`, `track:spec`.

---

## 9. Open Decisions

**OD-1. Is the execution unit the device-scoped intent, or a real child `ai_agent_runs` row?**
- **A — intent only (recommended).** Everything the child run was for already exists on the intent (§3.1); cost is UI work on the run-detail page. Both advisors agree no child row is *necessary*.
- **B — child run per device.** Gives a first-class per-device trace object and a natural home for a future multi-step remediation, at the price of duplicated budget/circuit/trace accounting and a second admission surface.
- **Recommend A** — and rewrite §4.2 of the phase-2 spec, whose "child run" wording is what makes B look pre-decided.

**OD-2. Fan-out shape when the cohort does not fit the allowance: deterministic prefix or all-or-nothing?**
- **A — deterministic canary prefix (recommended).** Ordered `(severity desc, kind asc, deviceId asc, subjectKey asc)`, capped by `maxUnattendedDevicesPerSweep` (default 3); the remainder become ordinary supervised cards.
- **B — all-or-nothing per occurrence.** Cleaner operator mental model ("the sweep either acted or it didn't"), but starves: a 40-device fleet at the 5% default permits 2 devices, so an org with 3 persistent eligible targets never acts, silently and forever.
- **Recommend A** — the starvation mode is worse than the partial-subset mode, and determinism recovers most of B's reviewability.

**OD-3. Default for `maxUnattendedDevicesPerSweep`.**
- **A — 3, merged with `min`** (recommended): a genuine canary; a partner must deliberately raise it.
- **B — equal to `maxActionsPerRun` (default 3)**: one fewer knob, but conflates "how many cards may a sweep raise" with "how many machines may it touch unattended", which is exactly the distinction #4442 is about.
- **Recommend A**, as a new `AiAgentLimits` field.

**OD-4. Where trigger provenance lives for the Activities feed: `audit_logs.details` jsonb, or typed columns on `audit_logs`?**
- **A — `details` jsonb (recommended).** No schema change on a hot append-only table with a checksum chain, no new export classification, and the feed's existing `details ? 'deviceId'` arm already proves this filter shape works.
- **B — two typed columns + a partial index.** Indexable and queryable, but the feed's RLS index note says only `org_id`/`resource_id` are index-promotable, so a `trigger_kind` filter would be a post-policy filter anyway — and the checksum-chain interaction needs its own review.
- **Recommend A**, with reports reading the typed columns on the execution tables rather than the feed.

**OD-5. Does the sweep-lane graduation gate (`sweepPromoteThreshold`, default 10 sweep-minted `verified` rows) belong in this spec, or should sweeps simply inherit P2-5's existing threshold?**
- **A — separate sweep threshold (recommended).** Verified evidence from run-bound, alert-triggered intents proves the *op* is safe; it says nothing about whether the sweep picked the right target, which is the entire new risk surface.
- **B — inherit `promoteThreshold`.** One knob, faster to reach act mode.
- **Recommend A.** Note that under either option W02 (sweep-condition fix watches) is mandatory first — without it `verified` is credited unconditionally on release (§1.1) and both thresholds are click-counters.

**OD-6. Certificate evidence source for `expiring_certs`.**
- **A — typed TLS observation columns on `network_monitors` (recommended).** The data is already collected by the agent and already persisted, unread, in `network_monitor_results.details`; monitors W4 builds its adapter over this same table, so the columns are not orphaned. Coverage is limited to HTTPS `http_check` monitors an MSP configured.
- **B — a standalone `ssl_check` monitor kind.** Fits the strategic monitors direction, but the monitor-definitions model is device-scoped and a public endpoint's certificate has no natural device; also needs a new kind spec, an `ALTER TYPE monitor_kind`, and a condition handler.
- **C — agent mTLS expiry as a customer-facing finding.** Rejected: platform-auto-renewed at 2/3 life with a 24 h agent backstop, and already covered (confusingly) by the shipped `cert_expiry` monitor kind.
- **Recommend A**, finding-only, with `tls_observed_host` mandatory because redirects mean the observed certificate may belong to a different endpoint than the monitor's target.

---

## 10. Test & rollout notes

- **Flags.** `BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED` default off, on top of `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`. With the new flag off, `resolvePolicyDecisionState` must be **byte-identical** to today for every scoped intent — the same property P2-5 asserted for its own flag, and the cheapest possible regression test.
- **Unit (Test API job).** The `hasScope` replacement, gate by gate, each failing closed. Subject-key derivation per kind. Cohort ordering determinism. `sweepSubjectProbe` three-outcome mapping. `REMEDIATION_TRIGGER_KINDS` CHECK-vs-const parity (the `action_intents.test.ts` pattern). The `.max(7)` bump. `composeBindMounts`-style contract test asserting every new column appears exactly once in `CORE_TENANT_EXPORT_POLICY`.
- **Integration (real Postgres, Integration Tests job only — these never run under `pnpm test`).** Export-policy + roundtrip suites for all six tables. `aiAgentSchedulesPartnerRls.integration.test.ts` gains `act_mode` tighten-only cases (partner enables, org override disables, org override cannot enable). Exposure fan-out: an occurrence proposing more devices than the allowance mints exactly the cohort as act-eligible and the remainder as cards, and a second occurrence in the same 24 h window sees the union, not a fresh budget. Auto-demote on a sweep-minted failure revokes the key and the *next* occurrence produces cards. Op-key intersection: a key present in the org row but absent from the partner baseline never authorizes.
- **The one that actually protects us:** an integration test proving a released sweep intent is **not** credited `verified` without a watch. Write it red against `main` first — it will pass today for the wrong reason, so the control must be shown to fail before W02's fix (`intentReleaseWorker.ts:544-570`).
- **Web.** 8-locale keys for the new kind labels, `act_mode` toggle, trigger chip, and the sweep act readout; `runAction` for the toggle mutation.
- **CI traps to restate in the plans.** A PR based on a sibling branch runs **no** CI (`ci.yml` triggers on `pull_request: branches: [main]`) — dispatch per branch before merging. `pnpm test` runs neither the RLS nor the integration configs; use `pnpm test-stack up`/`down`. `vitest run <path>` is a substring filter, not a glob — list dotted siblings explicitly.
- **Rollout.** W01–W03 ship dark (provenance columns, watches, cert evidence are all independently useful with act mode off). W04–W05 ship behind the new flag; enable for one internal partner, one org, one op key (`manage_services:restart`), `maxUnattendedDevicesPerSweep = 1`, and read the graduation panel for two weeks before widening.

---

## 11. Waves sketch

| Wave | Scope | Independently shippable? |
|---|---|---|
| **W01 — trigger provenance** | `REMEDIATION_TRIGGER_KINDS`; three columns on `action_intents` / `script_executions` / `automation_action_results`; the canonical remediation identity across those plus `outcome.executedActions`; `audit_logs.details` envelope; device Activities chip; export-policy registrations. | Yes — pure provenance, no behaviour change. Prerequisite for W05's graduation gate. |
| **W02 — sweep-condition fix watches** | `sweepSubjectProbe.ts`; subject columns on `ai_agent_fix_watches` with `alert_id` nullable; stop `watchReleasedIntent` crediting `verified` for sweep-minted intents; grading → `verified` / `recurred` / nothing. | Yes, and **must land before any act-mode wave** — it is what makes P2-5's ladder non-vacuous for sweeps. |
| **W03 — `expiring_certs`** | Agent issuer capture; typed TLS columns on `network_monitors` + writeback + config-change invalidation; the loader; kind enum + CHECK + `.max(7)`; 8 locales; partner-RLS kinds case. | Yes — independent of everything above. |
| **W04 — the act gate** | `act_mode` on `ai_agent_schedules` (tighten-only) + UI; `BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED`; the `hasScope` replacement; trusted subject on `SweepProposalRecord`; decide-time condition re-evaluation; release-time schedule-brake re-check. | Only after W01 + W02. |
| **W05 — fan-out, budget, graduation, visibility** | Deterministic cohort + `maxUnattendedDevicesPerSweep`; set-union exposure readiness check; `sweepPromoteThreshold` and the sweep-lane graduation query; run-detail per-intent outcomes and per-device roll-up. | After W04. |

---

## 12. Review log

**Author position (Claude Opus 5, 2026-09-13).** As drafted in §3–§5, with four positions later revised (below).

**Codex `gpt-6-astra`, `model_reasoning_effort=xhigh`, read-only, 2026-09-13.** Verdicts: **Q1 DISAGREE as specified** (agrees intents replace child runs); **Q2 AGREE** with typed observations and finding-only v1, disagrees with parts of the justification; **Q3 DISAGREE** on the recurrence/coverage contract, agrees on columns + audit JSON.

Findings raised, each re-read against the code before adoption:

| # | Finding | Status |
|---|---|---|
| 1 | Sweep intents are credited `verified` with **no verification** — `watchReleasedIntent`'s "no watch is POSSIBLE" branch fires because a sweep run has no alert, so the graduation ladder is a click-counter. | **Verified** (`intentReleaseWorker.ts:544-570`, `fixWatch.ts:291`). **Adopted** — became §1.1 and wave W02, and reordered the whole spec. |
| 2 | `evidenceDeviceIds` is never persisted; and device identity alone lets evidence about service A authorize an action on service B. | **Verified** (`runLoopTypes.ts:210-217`). **Adopted** — §3.3 trusted subject. |
| 3 | Exposure math wrong in two directions: the fleet cap is a **set union**, not `distinctDevices + M`; the day cap counts **actions**, so two intents on one device need two slots. | **Verified** (`exposureBudget.ts:84-108`). **Adopted** — §3.5. |
| 4 | All-or-nothing fan-out starves: a 40-device fleet at 5% permits 2 devices, so 3 persistent targets never fit. | **Adopted** — replaced with a deterministic canary prefix; the original is preserved as OD-2 B. |
| 5 | Pre-reserving `sweep_fanout` rows breaks `runAuthorizeTransaction` (excluded from the day count; authorize inserts its own row anyway; rollback cannot undo a prior transaction). | **Verified** (`policyDecide.ts:334`, `:373`). **Adopted** — pre-reservation dropped; the cohort is a readiness check only. |
| 6 | Freshness needs three outcomes and subject-pinned queries; the existing loaders are not verification APIs (`failed_backups` selects the latest *failed* job, so a later success never clears the predicate). | **Verified** (`sweepEvidence.ts:343`, `:396`). **Adopted** — §3.4 `sweepSubjectProbe`. |
| 7 | The schedule brake must be re-checked **at release**; `superseded` is not an intent status. | **Verified** (`revalidateRelease.ts:84`, `actionIntents.ts:50`). **Adopted** — §3.6, and `degradeToHumanRequired` replaces the invented status. |
| 8 | A `sweep_intent` value in `AI_AGENT_EVIDENCE_SOURCE_KINDS` conflates trigger provenance with terminal-event source. | **Adopted** — the graduation gate joins on `action_intents.trigger_kind` instead, which makes W01 a prerequisite of W05. |
| 9 | The certificate may belong to a **different endpoint** (redirects follow by default; expiry comes from the final response). TLS failures return before extraction; issuer is not collected. | **Verified** (`handlers_monitor.go:188`, `:221`, `:270`). **Adopted** — `tls_observed_host`, `tls_state`, `tls_issuer`. |
| 10 | The TLS observation needs lifecycle rules — exclude inactive/stale, invalidate on target/config change; the worker overwrites state unconditionally. | **Verified** (`monitorWorker.ts:496`). **Adopted** — §4.2. |
| 11 | W4 does not orphan the columns (its adapter builds over `networkMonitors`); a TLS subtype would not need a new scheduler; do not implicitly change TCP/443 behaviour. | **Adopted** — §4.2 rationale corrected; TCP TLS becomes an explicit later opt-in. |
| 12 | Execution frequency is not recurrence — count episodes with recovery boundaries. | **Verified** (`fixWatch.ts:800`). **Adopted** — §5.3. |
| 13 | Missing coverage: `automation_action_results` (not `automation_run_device_results`) and direct agent act executions in `outcome.executedActions`. | **Verified** (`automations.ts:173`, `impactRollup.ts:251`). **Adopted** — §5.2. |
| 14 | Audit-vs-report parity is a delivery-guarantee problem, not a column problem; audit writes commit independently and can be dropped on retry. | **Verified** (`auditService.ts:49`, `:90`). **Adopted** — §5.2 states the feed is a convenience view; recorded as OD-4. |
| 15 | Sweep findings have no UUID — they are `(runId, findingIndex)`; the `trigger_ref_id` derivation must be explicit. Also, alert provenance is not *universally* lost: `remediation_suggestions` links alert → script execution. | **Verified** (`sweepFindings.ts:332`, `remediationSuggestions.ts:31`). **Adopted** — §5.1 derivation table; the issue text says "unrecoverable" only of `script_executions`. |
| 16 | Prefers columns over a polymorphic `remediation_triggers` table for single-cause v1 (subject-integrity and retention problems; introduce one only when multiple causes or a canonical execution ledger justify it). | **Agrees with the author position** — columns retained. |

**Net:** the two advisors agree on the shape (intents not child runs; typed cert observations; columns not a join table) and disagree on five mechanics, all resolved in the code's favour above. No disagreement remains unresolved; the two genuine product judgements are surfaced as OD-2 and OD-5.

- 2026-09-13 — **Gate A approved by the product owner: all six recommendations (OD-1 A, OD-2 A, OD-3 A, OD-4 A, OD-5 A, OD-6 A).** The §8 issue was filed as #5744 (fix-by-trigger tagging; ships as W01). `spec-approved` applied to #4442, #4230, #5744. Migration slot reserved `2026-10-16-181500`.
