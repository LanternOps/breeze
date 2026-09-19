---
title: AI patch agent — autonomous launch, patch planning lane, failure chase
date: 2026-09-13
status: draft (Codex `gpt-6-astra` xhigh quorum run 2026-09-13 — agree-with-changes, all changes adopted; awaiting Todd)
issues: LanternOps/breeze#4174 (anchor), #5382
scope: apps/api (aiAgents, patch services, jobs), apps/web (Settings → AI agents), packages/shared
baseline_commit: e000e329f
---

# AI patch agent

## 1. Problem

`AI_AGENT_KINDS` has declared `'patch'` since phase 1 (`packages/shared/src/types/aiAgents.ts:1`), and the tool catalog ships a `patch` preset (`apps/api/src/services/aiAgents/agentToolCatalog.ts:320-325`), but **no code anywhere branches on `kind === 'patch'`**. The kind's entire behaviour is a one-line runner prompt (`services/aiAgents/runnerPrompt.ts:325`).

Consequences, both filed:

- **#5382 — it never launches.** Every autonomous admission path hard-wires `kind: 'triage'`: `alertVerdictSubscriber.ts:196,252`, `automationRuntime.ts:1931`, `metricAnomalySubscriber.ts:188`, and the sweep scheduler's `buildAdmission` switch (`jobs/aiAgentSweepScheduler.ts:619,641`). `scheduleService.assertPartnerWideScheduledAgent` (`:347-376`) rejects anything but `triage` (or `designer` for a `design` schedule) with `agent_kind_not_triage`. The schedules UI is not even rendered for a patch agent (`apps/web/src/components/settings/AiAgentForm.tsx:466`), and there is **no "run now" caller anywhere in `apps/web`** for the one manual endpoint that exists (`routes/aiAgents.ts:1769`, requires `deviceId`). Todd enabled Patching in shadow on US prod on 2026-09-09; it has produced zero runs and structurally cannot.
- **#4174 — there is no runner.** No patch run profile, no patch evidence loader, no failure-chase state, no escalation emitter.

This spec covers the part of #4174 that is deliverable on the agent rails **now**. The act-mode, multi-device, canary-gated patch *execution* workflow is already owned by AI Operator wave **P4-3** (`docs/superpowers/plans/ai-mcp/2026-09-07-ai-operator-completion.md:240-255`, decision D1 at `:355`), behind P3-2…P3-5, P4-0, P4-1 and T3's instrumentation subset. Nothing here duplicates or pre-empts that.

## 2. Users & scope

- **Partner (MSP) technicians and patch admins** are the primary users: they own update rings (`patch_policies` is `partner_id NOT NULL`, `db/schema/patches.ts:148-150`), manual approvals (`patch_approvals`, also partner-only, `:176-196`) and patch config policies.
- **Org-scoped technicians** consume the output: per-device findings, install proposals and escalations land in their org's run trace and approvals inbox.
- **Ownership**: the patch agent itself is an `ai_agents` row (dual-owner already). Its schedule follows the Partner-Wide First playbook unchanged — a partner baseline plus tighten-only org overrides (`db/schema/aiAgentSchedules.ts:9-16`, `scheduleService.effectiveSchedule:88`).

**Out of scope** (§7) — act-mode execution, reboot dispatch, fleet canary, tickets, `deadlineDays`/`gracePeriodHours` enforcement.

## 3. Proposed design

### 3.1 The lane: a `patch` schedule kind and a `patch` run profile

Follow the Fleet Designer precedent exactly (`2026-09-11-fleet-designer-agent-design.md` §4.1); it is the only pattern in the codebase for "an existing agent kind gets its own autonomous lane".

| Piece | Change |
|---|---|
| `AI_AGENT_SCHEDULE_KINDS` | append `'patch'` (`packages/shared/src/types/aiAgentSchedules.ts:48`) |
| `AI_AGENT_RUN_PROFILES` | append `'patch'` (`packages/shared/src/types/aiAgents.ts:800`) |
| `assertPartnerWideScheduledAgent` | the `required` ternary (`scheduleService.ts:369`) becomes a map: `design → designer`, `patch → patch`, else `triage`; new code `agent_kind_not_patch` |
| org-facing baseline listing | `scheduleService.ts:695` hard-filters `eq(aiAgents.kind, 'triage')` — widen, or a patch baseline is invisible to org tokens (Codex finding) |
| `assertValidCron` | `kind === 'patch'` keeps the hourly floor; add a **daily floor** (`isDailyOrRarerLiteralCron`) — a patch plan is not an hourly loop |
| `assertPartnerKindsForScheduleKind` | `'patch'` joins `narrative`/`design`: `sweep_kinds` must be empty |
| `buildAdmission` (`aiAgentSweepScheduler.ts:562-653`) | new `case 'patch'` → `kind: 'patch'`, `profile: 'patch'`, `deviceId: null`, `dedupeKey patch-<scheduleId>-<orgId>-<occurrenceKey>`. The `default: never` makes omission a compile error. |
| `profileCaps` (`runService.ts:718-798`) | new `patch` arm — `maxConcurrentPatchRuns` (1), `maxPatchRunsPerDay` (2, `windowMs: 86_400_000`), `patchBudgetCentsPerRun` (60), `patchMaxTurns` (20). Circuit-**neutral on success**, like sweep/design — stated explicitly, since an unlisted profile inherits full-run behaviour (`agentCircuit.ts:194`). |
| `AiAgentLimits` | snapshot version bump (currently 1..10, `types/aiAgents.ts:475`) |

**Why not #5382's item 1 as written** (a patch agent on a `sweep` schedule restricted to `unpatched_critical` + `pending_reboots`): those two loaders answer a different question. `loadUnpatchedCritical` (`sweepEvidence.ts:417-465`) reads `device_vulnerabilities` — CVE findings, not patch eligibility, not rings, not failed jobs — and `SweepProposedAction` is a closed two-member union (`types/aiAgentSchedules.ts:62-64`) with no patch member. A patch run needs ring bounds, maintenance windows and patch-job failures in evidence and needs install/retry proposals out. Codex agreed, with the caveat that reuse would not *itself* leak authority — the argument is fit, not safety.

### 3.2 Evidence — system-executed, never model-assembled

New `services/aiAgents/patchEvidence.ts`, same three properties as `sweepEvidence.ts:1-60` (display scalars only, bounded twice, org-pinned) but **aggregate-first**, because 25 rows/kind at 12 KiB (`sweepEvidence.ts:75,79`) silently truncates a real fleet. Sections:

1. **Compliance rollup** per org: devices total / compliant / non-compliant, oldest outstanding patch age, counts by severity — from `device_patches` (`org_id NOT NULL`) and `patch_compliance_snapshots`.
2. **Ring posture** for the org's effective rings: `ringOrder`, `deferralDays`, categories/excludeCategories, `autoApprove` summary, count of outstanding patches *held by deferral* vs *blocked by category/app rule* vs *awaiting manual approval*. Uses `resolveApprovedPatchesForDevice`'s helpers, never a re-implementation.
3. **Top non-compliant devices** (capped, ordered by severity-weighted outstanding count): hostname, os, outstanding counts, `pending_reboot`, last seen, whether a maintenance window resolves for it.
4. **Failed patch work** (new): `patch_job_results` rows in `failed` grouped by `(device, patch, errorMessage-class)` with attempt counts and last attempt time — the input the chase loop needs, which no sweep kind provides. `patch_job_results` has **no `org_id` and no `partner_id`** (`db/schema/patches.ts:255-273`); every query over it must reach org through `patch_jobs.org_id` **and** re-pin `devices.org_id` — a `device_id`-only join is a cross-tenant read under the evidence loader's system context.
5. **Reboot backlog**: `devices.pending_reboot = true` plus the device's resolved reboot policy and whether a maintenance window resolves for it **right now** (`maintenanceService.isDeviceInMaintenance` / `featureConfigResolver.checkDeviceMaintenanceWindow`) — **never a next-window time**. No projector for a future window exists under the current config-policy maintenance model: `deploymentEngine.getNextMaintenanceWindow` (`:138-193`) reads only the legacy standalone `maintenance_windows` table and omits `groupIds` from its target predicate. W04 builds the real next-occurrence projector this section needs for `once|daily|weekly|monthly` recurrences.

Evidence runs under system context like the sweeper (`sweepEvidence.ts:49`) — **every join pins `org_id` explicitly**; nothing relies on RLS for scoping in that path.

### 3.3 Outcome — `submit_patch_plan`

The only mutating-shaped tool the profile can reach; it mutates nothing but `ai_agent_runs.outcome`. Tool floor is a small read-only drill-down set (`get_device_details`, `get_device_context`, `get_compliance_status`, `get_device_vulnerabilities`, `manage_patches:list|compliance`, `manage_maintenance_windows:list|active_now` — all tier-1/readOnly-tier-2), plus the outcome tool, as a **floor, not an intersection** (`sweepProfile.ts:74-98`). `maxActionsPerRun: 0` in W01.

```
{ summary,
  posture: { compliancePct, devicesAtRisk, oldestOutstandingDays },
  items: [ { class: 'install' | 'approval_advisory' | 'reboot_plan' | 'chase' | 'escalation',
             severity, deviceId | null, patchIds?, jobResultIds?, windowId?,
             title, detail, evidenceRef } ] }
```

**Every reference is validated server-side against the assembled evidence before anything is persisted** — the `sweepFindings.ts:235-270` membership gate, generalised: a `deviceId` not in `run.evidenceDeviceIds`, a `patchId` not in that device's evidence rows, a `windowId` not in the resolved windows, is refused with a recorded disposition. Vendor patch titles are bounded untrusted text; no authority, eligibility or retryability is ever derived from model prose.

### 3.4 What the agent may actually *do* — the op contract

This is where the issue's framing has to bend to the code.

| #4174 verb | Reality on main | This program |
|---|---|---|
| "approve safe updates within ring/policy bounds" | A manual approval is a `patch_approvals` row keyed `(partner_id, patch_id, COALESCE(ring_id, nil))` (`patches.ts:176-196`) — **partner-wide or ring-wide, never device- or org-scoped**. The MCP handler writes `ringId: null` (`aiToolsFleet.ts:834`) and gates on `canManagePartnerWidePolicies` (`:697-702`), which an org-scoped agent principal cannot pass. | **Advisory only.** An `approval_advisory` item names the updates and the ring, and is surfaced in the digest and run trace to a partner admin. It mints **no intent**. A device-labelled card that actually writes a partner-wide approval would be a blast-radius lie, and one that fails authorization would re-ship the inertness of #5382. |
| "install" | `manage_patches:install` is tier 3 / `supervised` (`aiGuardrails.ts:213,451`); device-scoped. | **The one actionable op.** Device-scoped Tier-3 supervised intent (`scope_kind: 'device'`), i.e. an approvals-inbox card, exactly like a sweep proposal. `hasScope → human_required` (`intentService.ts:679`) keeps it out of policy-decide, per #4442. |
| "sequence reboots against maintenance windows" | No AI tool can reboot. `manage_maintenance_windows` is read-only by design (`aiToolsFleet.ts:1374-1377`); reboots are device commands issued by `patchRebootHandler.executeReboot` or the 10-minute `maintenance-reboot` sweep. | **Plan only** (§3.5). |
| "chase and retry failures" | Nothing retries. `device_patches.failure_count` is read in two routes and **written by nothing**; the patch orchestration queues set no BullMQ `attempts` (`patchJobExecutor.ts:526-527`). | A `chase` item proposes a bounded re-install of the same `(device, patch)` — the same Tier-3 install intent, carrying the attempt history in its reason. |
| "escalate the rest" | No patch alert, notification or ticket emitter exists; `patch_policies.notifyOnComplete` has no consumer. | Escalation = a run-digest section + an inbox card where an op exists. No tickets (§7). |

`manage_deployments:start` is dropped from the patch agent's effective preset: `deployments` is the *software* rollout engine, not patch jobs, and the Operator spec's readiness audit (`2026-09-07-…-design.md:62`) says not to reuse it.

**Eligibility is re-resolved, never trusted.** Codex is right that `evaluatePatchApproval` is not a universal gate: it is private, and the per-device manual install route deliberately bypasses the full ring evaluation (`routes/devices/patches.ts:180-185`; the evaluator's own header says "Manual per-device installs do NOT pass through this evaluator"). So the install proposal path must (a) intersect the proposed `patchIds` with `resolveApprovedPatchesForDevice(deviceId, orgId, ringConfig)` at intent-creation time, and (b) re-run that intersection at release (`revalidateApprovedIntentForRelease`), dropping updates that were superseded, blocked or newly deferred in between. Extracting a shared, exported eligibility resolver is a W02 deliverable — the same extraction P4-0 needs (`plan §5:203`).

**`revalidateApprovedIntentForRelease` already exists — this program does not add a second hook.** It lives at `apps/api/src/services/actionIntents/revalidateRelease.ts:140-316`, is called from `jobs/intentReleaseWorker.ts:923`, and is **tool-agnostic** (approval-row binding, argument digest, tier-not-escalated, actor still active, org still active, RBAC re-check). The **per-tool** drift mechanism it dispatches through is `EFFECT_DIGEST_RESOLVERS` (`services/actionIntents/effectDigest.ts:157`), keyed `tool` or `tool:action`. `manage_patches` has no entry there today (`manage_patches:rollback` sits on the `DELIBERATELY_UNPINNED` allowlist in `effectDigestCoverage.contract.test.ts:74-75`, because `patches` is a global vendor catalog whose `updated_at` churns on routine sync). W02's re-intersection therefore lands as a new `'manage_patches:install'` entry in that map — **not** a new call site, and **not** a `patches.updated_at` hash (that is exactly the failure mode the rollback allowlist entry documents) — hashing the *eligibility verdict* for `(deviceId, patchId)` from the extracted resolver instead.

### 3.5 Reboot sequencing

The agent never invents a reboot time and never dispatches one. It produces `reboot_plan` items that:

- assign each pending-reboot device to **an existing resolved maintenance window** (`maintenanceService.isDeviceInMaintenance` / `featureConfigResolver.checkDeviceMaintenanceWindow`), never a synthesised time;
- order devices so that redundancy-sensitive roles do not land in the same window, sourced from device function assessments (Fleet Designer W02, `device_function_assessments`) where present, else role tags;
- **escalate rather than plan** when a device has no window, when the resolved reboot policy is `if_required`/`always` (which reboot with no window at all, `patchRebootHandler.ts:295-330`), or when redundancy topology is unknown.

This is deliberately *stricter* than what the system enforces today, and the spec says so rather than implying parity. Actually issuing the ordered reboots is P4-3.

### 3.6 Chase / retry and escalation

Failure classes derived from `patch_job_results` (never from model prose):

`transient` (agent offline/timeout — note the stale reaper writes "Server-side timeout: no response from agent", `staleCommandReaper.ts:966`), `needs_reboot`, `disk_space`, `store_corrupt`, `permanent`, **`unknown`**. Rules:

- reboot-required is **not** a failure class outcome — it can accompany a successful install (`patchJobFinalizer.ts:649`) and is routed to the reboot plan.
- a device whose command is still `queued` because it is offline is **never** retried (`patchSchedulerWorker.ts:825` already skips these); it is a coverage note, not a chase.
- retries are bounded per `(device, patch)` episode (§3.7) — default 2, then `permanent` → escalation.
- escalation delivery reuses `runFinishedNotify` with a `patch` template, to the **effective policy snapshot's** recipients, not the raw `ai_agents.recipients` (`runFinishedNotify.ts:465`).

### 3.7 Episode identity — the duplicate-card problem

Codex's "single most likely production failure", and I agree it is the sharpest risk: a daily occurrence re-proposing the same install every night. Sweep proposal keys are `sweep:<runId>:<index>` (`sweepFindings.ts:332`), which deliberately makes each run distinct, and `action_intents_org_idem_uniq` covers **live statuses only** — a rejected or expired card frees the key.

Contract: an install/chase proposal's idempotency key is derived from the **problem**, not the run — `patch:<orgId>:<deviceId>:<patchId>` — so a live card is reused rather than duplicated; and before minting, the persister reads recent intents for that key and suppresses when one was `rejected`/`cancelled` inside a suppression window (default 14 days) or `completed` with the patch still outstanding fewer than N days ago. Attempt history is read back from the same keyed intents. **No such lookup exists today**: grepping `ByIdempotency|byIdempotencyKey|findIntent|lookupIntent` across `apps/api/src` finds nothing exported — the only existing read is inline inside `createActionIntent`'s `onConflictDoNothing` replay branch (`intentService.ts:1823-1833`). W02 adds the lookup-by-idempotency-key helper this suppression read needs. Whether that is enough or whether a durable `ai_patch_episodes` row is required is **Open Decision 4**.

### 3.8 Default cadence, backfill and enablement

On enabling a **partner-wide** patch agent with no `patch` schedule, create a baseline `0 2 * * *` in the partner's timezone, `sweep_kinds: '{}'`, visible and editable on the agent card. Because agents are already enabled in production, a one-shot idempotent **backfill** creates the baseline for existing enabled partner-wide patch agents — an enable-transition hook alone misses exactly the case that produced #5382. Org-owned patch agents are not schedulable (unchanged partner-only rule, `AiAgentSchedulesSection.tsx:447-449`) and show the existing `partnerOnly` note.

### 3.9 Reactive routing (#5382 item 3)

**`alerts` really has no `category` column — confirmed, and the routing path this forces is named.** `alerts` (`db/schema/alerts.ts:103-139`) has `rule_id`, `monitor_id`, `severity`, `title`, `message`, `context` and no category; `category varchar(100)` lives on `alert_templates` (`:44-74`, at `:50`). A "is this alert patch work?" classifier must therefore reach category by join — `alerts.rule_id → alert_rules.template_id → alert_templates.category` (index `alert_rules_template_id_idx` exists) or `alerts.monitor_id → monitor_definitions.kind = 'patch_compliance'` — and **both legs are nullable**, so the classifier must fail closed: unclassified ⇒ not patch work ⇒ triage keeps it. `AiAgentTriggers` (`types/aiAgents.ts:196-215`) today has `alertRuleIds`, `siteIds`, `deviceGroupIds`, `deviceTags`, `ticketCategories`, `ticketPriorities` — no alert-category filter; W04 adds `alertCategories`.

**The `patch_compliance` alert source already exists end to end — narrower than "author it first."** `monitorKindEnum` includes `'patch_compliance'` (`db/schema/monitorDefinitions.ts:39`), the kind spec is complete (`services/monitors/kinds/patchCompliance.ts:8-17`), and the alert-condition handler evaluates it against `security_posture_snapshots.patch_compliance_score` (`services/alertConditions/handlers/patchCompliance.ts:8-48`). No patch code path emits an alert today — confirmed by grep across `services/patch*`, `jobs/patch*`, `routes/patches/`: zero `createAlert` / `insert(alerts)` — so there is still nothing to route. What item 3 genuinely requires authoring first is narrower: a **built-in** `patch_compliance` monitor (`services/monitors/builtInMonitors.ts` ships only `cpu_high`, `memory_high`, `disk_full`), plus new alert sources for **patch-job failure** and **reboot-pending-over-threshold**, for which nothing exists at all.

When it exists: **patch-work ownership is exclusive** (the patch agent owns the remediation lane for a patch-classified alert; triage is the fallback when no patch agent is enabled, with the fallback reason recorded), while the **verdict lane is unchanged** — `alertVerdictSubscriber` mints `profile: 'verdict'` runs and phase 2 deliberately runs verdict and triage lanes together (`phase2 design:65`). A fallback must not bypass an org's opt-out or an open circuit.

### 3.10 UI (#5382 item 4)

- Render `AiAgentSchedulesSection` for `kind === 'patch'` (`AiAgentForm.tsx:466`), with the patch kind's daily-floor cron rule and no sweep-kind chips.
- Agent card gains **next occurrence** next to the existing `lastRunCell` (`AiAgentsPage.tsx:270-306`); `nextRunLine()` already exists (`AiAgentSchedulesSection.tsx:786`).
- **Run now**, shipping in **W01** (not W02 — a shadow lane that cannot be triggered by hand is exactly the #5382 complaint, and W01 mints zero intents so the button is harmless) — a dedicated `POST /ai/patch-plan/runs` route (device-less, `{ orgId }`), copied from `routes/fleetDesign.ts:148-207`: `requireAiWrite` + `requireMfa()`, 404 on `!auth.canAccessOrg`, `resolveEffectiveAgent(auth, orgId, 'patch')`, `dedupeKey: patch-manual-<uuid>`, `writeRouteAudit`, HTTP-200 `{ success: false, skipped }` on a declined admission so `runAction` reads it as a failure, 202 `{ runId }` on success. This is **not** `POST /ai/agents/:id/runs`: that route's `triggerAgentRunSchema` is `{ deviceId }`-only and `.strict()`, and it explicitly 400s `kind_not_device_triggerable` for a device-less kind (`routes/aiAgents.ts:1802-1809`) — its existing device-scoped body and behaviour are untouched. "Run now *on device*" is not a thing a `patch`-profile run supports: it is device-less by construction (`buildAdmission` sets `deviceId: null`), so the card's control is an org-scoped "Run now", not a device picker. First web caller of the new route; `runAction` wrapped.
- Run trace renders the patch plan through a safe projection (`projectPatch`, mirroring `projectSweep`), display values only.
- i18n: `settings` namespace, `aiAgentsPage.*`; real translations in all 8 locales.

### 3.11 Observability

`ai_agent_runs` carries everything: `profile`, `scheduleId`, `triggerRef.occurrenceKey`, `costCents`, `outcome`, `intentIds`. Schedule bookkeeping reuses `last_run_summary` (`orgsTotal / runsAdmitted / runsSkipped / skipReasons`), which must surface the `org_cap` gap — one occurrence only reaches the first `MAX_ORGS_PER_OCCURRENCE = 500` orgs, ordered by id (`aiAgentSweepScheduler.ts:401-421`). Skip reasons for the new profile pair (`max_concurrent_patch_runs`, `patch_rate`) follow the existing non-published convention (`runService.ts:535`).

## 4. Tenancy & data model impact

**No new tables.** One idempotent migration, `apps/api/migrations/2026-10-16-182700-ai-agents-patch-profile.sql` (the `2026-10-16-181300` slot originally reserved for this migration was taken by monitors W03, PR #5770; re-check `ls apps/api/migrations/*.sql | sort | tail -1` and rename upward again if `main` has moved further by implementation time). `ai_agents_kind_chk` already admits `'patch'` in the DB (widened in `2026-10-16-170500-ai-agents-fleet-designer.sql:5-7`), so this migration widens only the three CHECKs below. DDL only, no DML, so no `breeze.scope` election:

```
ai_agent_runs_profile_chk       → + 'patch'
ai_agent_schedules_kind_chk     → + 'patch'
ai_agent_schedules_kind_kinds_chk → 'patch' joins the zero-cardinality arm
```

Registration lists: **nothing new to register.** No new table → no `CORE_ORG_CASCADE_DELETE_ORDER`, no device-cascade lists, no org-merge entry. No new **column** → no `CORE_TENANT_EXPORT_POLICY` entry (the export-policy row fires on new columns; a CHECK widening is not one). Noted consequence: the patch plan lives in `ai_agent_runs.outcome`, a jsonb column already classified `excludedOpen`, so **plans are not part of a tenant export** — acceptable (they are derived, reproducible advice), but stated rather than discovered.

RLS: `ai_agent_schedules` is already `DUAL_AXIS_TENANT_TABLES` with the partner-wide SELECT branch; a new `kind` value changes nothing. The evidence loader runs under system context and must pin `org_id` on every join (§3.2). `patch_policies`/`patch_approvals` are partner-axis and are only ever **read** by this program.

If Open Decision 4 lands on a durable episode table, it is a shape-1 `org_id` table and inherits the full four-list ceremony plus the org-merge registry — which is precisely why the derived-key option is the recommendation.

## 5. Out of scope

Act-mode / unattended patch execution and reboot dispatch (Operator P4-3); fleet canary→widen (#4173); auto-execution of scoped proposals (#4442); automatic ticket creation (P2-4/T1 territory, and ticket writes carry their own loop guards); enforcing `deadlineDays` / `gracePeriodHours` / `ringOrder`, which are stored on rings and read by nothing today (a separate bug, worth filing); writing `device_patches.failure_count`; a patch Operator recipe (needs a targets table, a patch execution adapter, a patch verification adapter and a recipe registry, none of which exist).

## 6. Open Decisions

**OD-1 — Program boundary against Operator P4-3.**
- **A (recommend)** — ship a propose-only patch planning lane on the agent rails now; P4-3 keeps act-mode execution and consumes this spec's op set, evidence and episode contract.
- B — wait for P4-3 and fix only #5382's launch plumbing.
- C — build patch execution here.
**Recommend A** — B leaves a visibly enabled agent producing nothing for months; C forks the execution engine the Operator program exists to own.

**OD-2 — Separate `patch` profile vs a sweep-kind subset.**
- **A (recommend)** — own schedule kind + run profile (Fleet Designer precedent).
- B — `sweep` schedule restricted to `unpatched_critical` + `pending_reboots` (#5382 as written).
**Recommend A**, quorum agreed: those loaders read CVEs, not patch eligibility, and `SweepProposedAction` has no patch member. B is cheaper but answers the wrong question.

**OD-3 — Partner-scoped approvals.**
- **A (recommend)** — `approval_advisory` findings only; no intent.
- B — a partner-scope patch run that may mint approval intents (needs a partner-scoped run, which `ai_agent_runs.org_id NOT NULL` does not support).
- C — widen the agent principal to pass `canManagePartnerWidePolicies`.
**Recommend A.** C is a real authority widening for a card that would be labelled per-device and act partner-wide; B is a rails change out of proportion to the value.

**OD-4 — Episode identity for cross-occurrence duplicate suppression.**
- **A (recommend)** — problem-derived idempotency key + a suppression read over recently decided intents (§3.7). No new table.
- B — a durable `ai_patch_episodes` table (org_id shape 1) carrying attempt history, suppression and acknowledgement.
**Recommend A first**, with B as the explicit fallback if A cannot express acknowledgement or retry accounting. This is the highest-risk decision in the spec — Codex named it the most likely production failure.

**OD-5 — Install-eligibility gate.**
- **A (recommend)** — extract a shared exported eligibility resolver from `patchApprovalEvaluator`, intersect at intent creation **and** re-intersect at release.
- B — trust the existing per-device install route.
**Recommend A**; B is the route that already bypasses ring evaluation (`routes/devices/patches.ts:180-185`).

**OD-6 — Reboot planning authority.**
- **A (recommend)** — assign to existing resolved windows only; escalate no-window, non-`maintenance_window` policy, or unknown redundancy.
- B — also propose window creation.
**Recommend A**; the AI maintenance-window tool is read-only by design and B would let an agent widen its own reboot envelope.

**OD-7 — Escalation channel.**
- **A (recommend)** — run digest + inbox card where an op exists; notification to effective-snapshot recipients.
- B — also open a ticket. C — also raise an alert.
**Recommend A**; B/C need the patch alert sources of OD-8 and the ticket loop guards first.

**OD-8 — Reactive routing prerequisite.**
- **A (recommend)** — defer to W04 and author the alert sources that are actually missing — a **built-in** `patch_compliance` monitor (`builtInMonitors.ts` ships only `cpu_high`/`memory_high`/`disk_full`; the `patch_compliance` monitor kind and its alert-condition handler already exist end to end) plus new patch-job-failure and reboot-pending-over-threshold templates — then route with exclusive patch-work ownership and recorded fallback.
- B — ship routing now on `alertRuleIds` the partner authors by hand.
**Recommend A**; no patch code path emits an alert today (confirmed by grep — zero `createAlert`/`insert(alerts)` across `services/patch*`, `jobs/patch*`, `routes/patches/`), so there is still nothing to route.

**OD-9 — Default cadence and backfill.**
- **A (recommend)** — `0 2 * * *` partner tz on enable **plus** a one-shot idempotent backfill for already-enabled partner-wide patch agents.
- B — enable-hook only. C — no default; require explicit creation.
**Recommend A**; B misses exactly the production agents that motivated #5382, and C means "enable" still does not mean "starts working".

**OD-10 — Cost and coverage posture.**
- **A (recommend)** — daily cron floor, own profile caps, circuit-neutral on success, and surface the 500-org occurrence cap in `last_run_summary.skipReasons.org_cap`.
- B — hourly floor like sweeps.
**Recommend A**; one occurrence is one LLM run per live org under the partner.

**OD-11 — Where the plan lives for tenant export.**
- **A (recommend)** — accept that `ai_agent_runs.outcome` is `excludedOpen` and patch plans are therefore outside tenant export.
- B — project a bounded copy into an exportable column/table.
**Recommend A**; the plan is derived, reproducible advice, and B is a new column or table for no user-visible gain.

## 7. Test & rollout notes

- **Contract**: `patch` profile's reachable tool set contains no mutating tool but `submit_patch_plan` (source-scan, mirroring the designer's assertion); outcome safe-projection Zod test; no `profile === 'patch'` bypass exists in any guardrail/ledger/admission path; `buildAdmission` and `profileCaps` exhaustiveness (both `default: never`).
- **Integration (real Postgres, `pnpm test-stack up`)**: a `patch` baseline fans out one run per live org and none for a `triage` agent; `agent_kind_not_patch` on a mismatched agent; org token can see a patch baseline (the `scheduleService.ts:695` fix); evidence is org-pinned under system context (forge a second org, assert zero cross-org rows); an install proposal for a device absent from evidence is refused; the same `(device, patch)` on two consecutive occurrences yields **one** live intent; a rejected card is suppressed on the next occurrence; release revalidation drops a patch that became blocked; circuit-open skips the org and is counted.
- **RLS/cascade**: `rls-coverage`, `tenantCascade`, `tenant-export-policy` and the erasure roundtrip must be run even though nothing is registered — a CHECK widening should be provably inert there.
- **Web**: schedules section renders for a patch agent; next-occurrence cell; Run now through `runAction`; `localeParity` for 8 locales.
- **CI traps**: integration/RLS/export suites do not run under `pnpm test`; a stacked PR gets no CI at all (`gh workflow run CI --ref <branch>`); `vitest run <path>` is substring matching — list dotted siblings explicitly.
- **Rollout**: no new env flag. The lane activates under `BREEZE_AI_AGENTS_ENABLED` for any patch agent at `mode ≥ shadow`. W01 mints zero intents, so the first release cannot execute anything by construction; W02's install proposals are Tier-3 supervised cards under the existing kill switch, circuit breaker, budget and `maxActionsPerRun`.

## 8. Waves sketch

Codex objected to a W01 that only fixes the launch plumbing ("scheduling alone fixes an activity counter, not Todd's experience"), and Fleet Designer W01 shipped an end-to-end useful lane. Adopted:

| Wave | Contents | Blast radius |
|---|---|---|
| **W01 — the lane, end to end** | schedule kind + run profile + kind-gate map + org-listing fix + `patchEvidence.ts` + `submit_patch_plan` + safe projection + digest + default cadence **with backfill** + schedules UI for patch agents + next-occurrence on the card + **Run now** (`POST /ai/patch-plan/runs`). **Findings only, zero intents.** | medium (new autonomous LLM lane; no mutations) |
| **W02 — actionable installs** | shared eligibility resolver extraction, device-scoped Tier-3 install proposals, episode-derived idempotency + suppression, release revalidation. | **high** — approvals, tenancy, unattended-adjacent. Full rigor. |
| **W03 — chase, retry, escalate** | failed-patch evidence section, failure classification, bounded retry proposals, escalation items + `patch` notify template. | medium-high |
| **W04 — reactive + reboot planning** | patch alert sources, exclusive patch-work routing with recorded fallback, reboot-plan items with window assignment and redundancy ordering. | medium |
| **(handoff)** | act-mode execution, canary widening, reboot dispatch → Operator **P4-3** (#4174 closes there). | — |

W02 depends on W01; W03 on W02; W04 on W01 (routing) and W03 (escalation shape).

## 9. Review log

**Author position (Fable, 2026-09-13)** — P0 defer execution to P4-3 and ship a propose-only lane now; P1 own profile, not a sweep subset; P2 the ring evaluator is the single gate; P3 plan reboots against existing windows only; P4 install Tier-3 / approve Tier-2 cards; P5 bounded chase, inbox+notify escalation, no tickets; P6 exclusive reactive routing; P7 no new tables; P8 launch-first waves.

**Codex `gpt-6-astra`, xhigh, read-only, 2026-09-13** — *agree-with-changes overall*. Agreed P1 outright. Changes adopted in full:

- **P2 disagreed as stated** — `evaluatePatchApproval` is a private approval-priority function, not a universal execution gate; manual device installs bypass it and a manual approval overrides deferral/category eligibility. → §3.4 rewritten around a shared resolver plus release revalidation (OD-5).
- **P4 disagreed as a complete contract** — `patch_approvals` is partner/ring-scoped with no device or org axis, and `manage_patches:approve` requires partner administration an org-scoped agent principal cannot pass; a device-labelled approval card would be a lie and an unauthorized one would re-ship inertness. → approvals became advisory-only (OD-3).
- **P3, P5, P6, P7** agree-with-changes: reboot restriction is stronger than current enforcement and must be an explicit contract with escalation on unknown topology; add an `unknown` failure class, treat reboot-required independently of failure, never retry a queued-offline command, use effective-snapshot recipients; make patch-*work* ownership exclusive while leaving the verdict lane alone; also widen `ai_agent_schedules_kind_kinds_chk`.
- **P8 disagreed as release boundaries** — W01 must ship evidence, a validated outcome, a digest and visible cadence/results, and must backfill already-enabled agents. → §8 rewritten.
- **Named the top production risk** — daily duplicate cards for unchanged work, because sweep proposal keys are run-scoped and the intent unique index covers live statuses only. → §3.7 and OD-4.
- Also flagged: the org-facing schedule listing's `triage` filter (`scheduleService.ts:695`); the 500-org occurrence cap; making the new profile explicitly circuit-neutral; freezing reviewed update versions against live eligibility; and treating bounded vendor text as untrusted. All incorporated.

No unresolved disagreement. Every remaining fork is an Open Decision above.

**Resolved during plan verification against `main` `92172e64a`** (previously flagged "not verified" for the plan author):

- `requireMfa()` is **route middleware only** — present on `routes/devices/patches.ts:497` (install) and `:619` (rollback), and on `routes/aiAgents.ts:1774` / `routes/fleetDesign.ts:154` — with **zero hits** in `aiGuardrails.ts`, `aiToolsFleet.ts` or `aiAgentSdkTools.ts`, so the AI-tool path (`manage_patches:install`/`:rollback`) has no MFA gate at all today. That asymmetry against the human REST path is **pre-existing and out of scope** — this program neither relies on nor widens it — and the new `POST /ai/patch-plan/runs` carries `requireMfa()` like its siblings.
- `deadlineDays`, `gracePeriodHours`, `ringOrder` and `patch_policies.notifyOnComplete` have **no runtime consumer anywhere**: `notify_on_complete` (`patches.ts:162`) has exactly one repo-wide hit — its own schema declaration; `deadline_days` (`:166`) and `grace_period_hours` (`:167`) appear only in the update-ring CRUD route and web forms; `ring_order` (`:164`) is read only as an `ORDER BY` for listing; all four are absent from `patchJobExecutor.ts`, `patchSchedulerWorker.ts`, `patchJobFinalizer.ts`, `patchRebootHandler.ts` and `staleCommandReaper.ts`. §5 stands: enforcing them is out of scope, filed as its own bug rather than quietly starting to enforce a stored-but-dead field.
- **Nothing writes `device_patches.failure_count`, anywhere** — confirmed across the API *and* the Go `agent/` tree (only hits: the schema declaration, two read-only SELECTs, and the export-policy registry). The column is permanently `0`, so any attempt-history evidence must come from `patch_job_results`, never this column, and this program does not start writing it.
- The four-eyes entry for `manage_patches:rollback` is in **`TIER3_FOUR_EYES_ACTIONS`** (`apps/api/src/services/aiGuardrails.ts`, declared `:335`, entry `:357`) — not `services/ai/aiGuardrails.ts`. Its sibling `TIER3_SUPERVISED_ACTIONS` (`:451`) carries `manage_patches: ['install', 'setup_auto_approval']`: `install` is Tier 3/supervised (one human) and `rollback` is Tier 3/four-eyes (two humans), consistent with this program proposing only `install`.

- 2026-09-13 — **Gate A approved by the product owner: all eleven recommendations (OD-1…OD-11, option A each).** `spec-approved` applied to #4174 and #5382. Plan authoring follows; migration slot reserved `2026-10-16-182700` (superseding the originally reserved `181300`, taken by monitors W03 PR #5770).
