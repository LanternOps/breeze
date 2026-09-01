---
tracking_issue: LanternOps/breeze#4187
---

# AI Agents Phase 2 — Intelligence Layer: Program Design

**Date:** 2026-08-28
**Status:** Approved in dialogue (Todd, 2026-08-28). Codex `xhigh` quorum run 2026-08-28 — 2 agree, 1 disagree (accepted), 5 gaps (all verified against code, all incorporated; see §9 and the **Amendment** call-outs). Awaiting written-spec review.
**Tracking:** LanternOps/breeze#4187 (waves #4188–#4193, registered 2026-08-28). Phase 1 is LanternOps/breeze#3821, which closes after wave 6.3 (ticket shadow) lands; "anomaly sources" from the wave-6 title is folded into P2-1 here (decision A, 2026-08-28).
**Extends:** `2026-08-22-ai-agents-program-and-wave1-design.md` (phase 1 contracts: `ai_agents`, `ai_agent_runs`, `ai_agent` principal, effective policy), `2026-08-05-tier3-supervised-four-eyes-split-design.md`, `2026-07-18-action-intents-approval-layer-design.md`, the wave-6 plans (`2026-08-28-ai-agents-wave6-{1,2,3}-*.md`).

## 1. Where phase 1 leaves us

Phase 1 (#3821, ten waves) built the operator's **safety and supervision machinery**: dual-owner agent policy with tighten-only org override, a headless runner under the `ai_agent` principal, requester-less action intents flowing through the existing approvals system, an act manifest of five rule-equivalent ops with post-execution verification, a policy-satisfied authorization path for a closed set of Tier-3 ops behind an exposure ledger and blast caps, a kill switch, a per-(org, agent) circuit breaker, a fix-held watch, and an execution-trace UI.

What it does **not** yet do is the work an MSP buys "AI agents" for. Assessed 2026-08-28:

| Dimension | Phase 1 |
|---|---|
| Safety & control architecture | 5/5 |
| Autonomy actually delivered | 2/5 — five single-device ops, both flags dark in prod |
| Breadth of work | 2/5 — alert-triggered triage only; `patch`/`schedule`/`helpdesk` are declared literals with no consumer (helpdesk shadow in flight) |
| Ticketing intelligence | 1/5 |
| Learning / memory | 1/5 — `findings: []` never populated; no prior-run context; fix-watch verdicts consumed by nothing |
| Observability | 4/5 — runs list, trace, exposure readout; no fleet-level impact view |

Phase 2 fills the payload without adding new safety machinery: every capability is a new trigger/outcome on the **existing runner**, every mutation is an **action intent**, and nothing here raises autonomy without a human decision.

## 2. Decisions locked in dialogue (2026-08-28)

| # | Decision | Choice |
|---|---|---|
| D1 | Phase-1 close-out | Finish 6.3 (ticket shadow); drop "anomaly sources" as its own wave — alert-verdict lane subsumes it. **Superseded 2026-08-29:** wave 6.4 (#4203) shipped metric anomalies as a first-class `anomaly` trigger kind (forced-shadow, opt-in per agent) while P2-1 was being built; anomaly runs are therefore a phase-1 lane, and P2-1's verdict lane stays alert/correlation-group scoped. Roadmap item #4178 is closed by 6.4. |
| D2 | Program optimizes for | **Visible value to every customer with no flag flips** — read-only intelligence first, autonomy grows on the data it generates. |
| D3 | Ticket-lane autonomy ceiling | **Metadata + private notes autonomously** (category, priority, queue, device link, one private note attributed to the `ai_agent` principal). Customer-facing text is always a draft a technician sends under their own identity. |
| D4 | Feedback loop authority | **Recommend-only promotion + automatic demotion.** Stats never raise autonomy on their own; a failure drops an (org, op) back to propose-only automatically. |
| D5 | Autonomy expansion (patch agent, fleet fan-out) | **Separate program later**, designed against real graduation data. Recorded as roadmap items (§11). |
| D6 | Program shape | **Four lanes, one runner.** New `profile: 'verdict' \| 'full'` on runs so high-volume alert judgement fits the budget model without a second AI path. **Amendment (quorum):** structured outcomes are produced by **outcome tools** (`submit_alert_verdict`, `submit_sweep_findings`, `submit_narrative`, `submit_ticket_proposal`) — Tier-1 tools whose Zod-validated input *is* the outcome and which execute nothing; the runner today only captures assistant text (`runLoop.ts:891`, `:1100`). **Amendment (P2-1 review):** SDK `extraTools` handlers do NOT pass through the runner's `onPreToolUse`/`onPostToolUse` (only registry tools do, via `makeHandler`), so `createBreezeMcpServer` wraps every extra tool's handler in the same pre/post-hook contract; outcome capture happens in the post-hook, and the kill switch is consulted inside the outcome-tool branch of the pre-hook. Proposals inside those outcomes are converted to intents **by the system after the run**, with an explicit scope, never by agent tool calls — which also sidesteps the device-less-mutation deny (`aiGuardrails.ts:1625`) for sweep and ticket runs. |
| D7 | Approvals | Every mutation rides `action_intents`. **Amendment (quorum):** intents are Tier-3-only today (`intentService.ts:660` throws `tool_not_tier3`; `runLoop.ts:461` records Tier-2 proposals with no approval object). P2-1 therefore adds a **Tier-2 intent lifecycle** (`approvalScope: 'single'`, one approver, no four-eyes, no policy-decide) so shadow-mode suggestions are one-click in `/approvals`; in act mode a Tier-2 op executes only if it is in the act manifest, otherwise it is a single-approver intent. "Promote to act" is a four-eyes intent. |

## 3. Program shape

Six waves, each its own spec-section + plan + PR set, in value order. Waves P2-1..3 and P2-6 ship on `BREEZE_AI_AGENTS_ENABLED` alone.

| Wave | Lane | Trigger → outcome | Claim it makes true |
|---|---|---|---|
| **P2-1** Alert verdicts | `triage`, `profile: 'verdict'` | `alert_correlation_groups` created / alert auto-resolved → `alertVerdict` | "The operator looked at every alert"; fewer emails |
| **P2-2** Scheduled sweeps | `triage`, `triggerKind: 'schedule'` | partner-wide cron per org → `sweepFindings[]` + proposed intents; batch approve in inbox | "Does work while I sleep" |
| **P2-3** Weekly org narrative | `triage`, schedule, `profile: 'full'` | weekly per-org run → `narrative` → a row in `reports` | Managed AI Ops deliverable |
| **P2-4** Ticket triage (act) | `helpdesk`, `triggerKind: 'ticket'` | on create / first human comment → autonomous Tier-2 metadata intents + private note + stored drafts | "Tickets arrive pre-triaged" |
| **P2-5** Feedback + graduation | cross-cutting | run + fix-watch verdicts → `ai_agent_op_stats` → promote suggestion (four-eyes intent) / auto-demote | "Autonomy that earns itself" |
| **P2-6** Value accounting | cross-cutting | daily rollup → `/ai-agents/impact` | The dashboard that sells the tier |

P2-6 may be pulled forward if a sales surface is needed sooner; it only depends on P2-1's rollup fields existing.

## 4. Lane designs

### 4.1 P2-1 Alert verdicts

**Trigger.** Two durable `eventSubscriberRegistry` subscribers (wave-3.5c pattern):
- `alert.correlation_group.created` (published by `jobs/alertCorrelation.ts` when it persists a group via `persistAlertCorrelationGroupsForAlerts`; today it publishes nothing — this wave adds the `publishEvent` call) → one verdict run per group.
- `alert.auto_resolved` (alert resolved by the rule engine, not a human, within `AUTO_RESOLVE_VERDICT_WINDOW_MINUTES = 30` of trigger) → one verdict run per alert, dedupe key `alert-verdict:<alertId>`. **Amendment (P2-1 review):** there is no separate `alert.auto_resolved` type — the subscriber listens to `alert.resolved` and gates on the **published payload** (`resolvedBy === null`, `resolvedAt − triggeredAt ≤ 30 min`), never on a re-read of the alert row: the auto-resolve sweep publishes inside its own transaction, so a re-read sees the pre-update row. Rule for every phase-2 subscriber: never re-read a row the publishing transaction wrote.
- Uncorrelated alerts that stay open for `UNGROUPED_VERDICT_DELAY_MINUTES = 10` get a verdict run too (delayed BullMQ job, stable jobId `alert-verdict-<alertId>`), so every alert **that matches the agent's trigger filters (outside maintenance windows)** eventually carries a verdict — verdict runs go through the same admission as any agent run, and the no-bypass contract (§7) forbids a profile-keyed exception. Existing alert-triggered `triage` runs (phase 1) are unchanged; an alert can have both.

**Profile `'verdict'`.** New `ai_agent_runs.profile` column, `'full'` default. A verdict run:
- has a fixed read-only tool set — **Amendment (P2-1 review, 2026-08-28):** the pinned set is `manage_alerts:list`, `manage_alerts:get`, `get_device_details`, `analyze_metrics`, `query_monitors` (the real tool names; there is no standalone `get_alert`), and it is a **floor, not an intersection** with the agent's `toolAllowlist`: every entry is a read-only tool that already bypasses the allowlist on full runs, so exposing it widens nothing, whereas intersecting against an empty default allowlist produced evidence-free verdicts. Mutations are excluded at three layers — exposure (only the pinned MCP names), the guardrail allowlist (built from the pinned list, so a bare `manage_alerts` never admits `suppress`/`resolve`), and a verdict-profile deny of any non-`allow` disposition in the pre-hook;
- is capped at `maxTurnsPerRun = 4`, `verdictBudgetCentsPerRun` (default 5), `maxVerdictRunsPerHour` (default 200) — new `AiAgentLimits` fields, snapshot v4 → v5, tolerant reads 1–5 (tuned from 3 turns/2¢ after the P2-1 live check: 3 of 4 Sonnet runs ran out before submitting);
- never touches the unattended-exposure ledger — not by exemption but structurally: the ledger is written only when a policy intent is authorized (`policyDecide.ts:288`) and a verdict run can neither call a mutating tool nor create an intent itself (**Amendment**: the earlier "ledger-exempt by profile" wording is withdrawn; no profile-keyed bypass exists anywhere);
- **has its own admission counters** (**Amendment**): `maxVerdictRunsPerHour` and a new `maxConcurrentVerdictRuns` (default 4) — verdict runs are excluded from `maxRunsPerHour`, `maxConcurrentRuns` and the device-less cooldown bucket (`runService.ts:445-470` groups every device-less run together today), so verdict volume can never starve or suppress remediation runs;
- **circuit breaker** (**Amendment**): `classifyTerminal` gains the run profile; a verdict run's clean `completed` is `neutral` (today it would `reset` the full runner's failure streak — `agentCircuit.ts:128`), `needs_attention` is `neutral`, runner failures on the increment allowlist still `increment`.

**Outcome.** `AgentRunOutcome.alertVerdict`:
```ts
interface AlertVerdictOutcome {
  classification: 'actionable' | 'transient_self_healed' | 'recurring_pattern' | 'duplicate_of_group' | 'needs_human';
  confidence: number;            // 0..1
  rationale: string;             // ≤ 400 chars, rendered on the alert row
  pattern?: { kind: 'daily' | 'weekly' | 'after_event'; evidenceAlertIds: string[] };
  suggestedAction?:              // becomes an intent, never applied directly
    | { tool: 'manage_alerts'; action: 'suppress'; alertId: string; suppressDuration: number /* hours, 1–720 */ }
    | { tool: 'manage_alerts'; action: 'resolve'; alertId: string };
}
```
Produced via the `submit_alert_verdict` outcome tool and persisted to `ai_alert_verdicts` (§5) — one row per (alert | group) per run; a newer verdict marks the older `superseded_by`. `suggestedAction` becomes a **Tier-2 single-approver intent** created by `finishRun` with scope `{ alertId + the alert's deviceId }`: in act mode with `manage_alerts` in the act manifest it executes (with a `verifySpec: alert_state`); otherwise it is a one-click card in `/approvals`. Nothing in this lane mutates alerts without an intent. A suggestion becomes an intent only when the agent's effective `toolAllowlist` admits `manage_alerts` (or `manage_alerts:<action>`) and the alert is on the run's device — the same authority the release path re-checks.

**Trigger plumbing (Amendment):** the correlator worker runs `runAlertCorrelationForDevice` inside one `withSystemDbAccessContext` transaction, so the event is published by the **worker after the context resolves** (the function returns the created-group payloads) — publishing inside the function delivered the event before the group row was committed (FK violation on the run insert, found in the live check). `upsertGroup` returns only an id and `persistAlertCorrelationGroupsForAlerts` returns only counts, discarded by the job (`alertCorrelationGroups.ts:147`, `:237`; `alertCorrelation.ts:527`). P2-1 changes `upsertGroup` to `RETURNING id, (xmax = 0) AS created`, bubbles `createdGroupIds` up, and the job publishes `alert.correlation_group.created` per new id **after** the persistence transaction commits.

**UI.** Verdict badge + rationale on the alert list row, alert detail (routed page and inline modal), and correlation group (**group-detail badge deferred to a follow-up; the API returns it**); a group verdict applies to every member alert — `latestVerdictsForAlerts` and the `hideAiNoise` filter resolve an alert's verdict as its own alert-level verdict, else its group's via `alert_correlation_members`; 👍/👎 on the badge writes `ai_alert_verdicts.feedback` (a supervision signal, not training). Filter "hide transient/recurring" on the alerts page reads the latest verdict.

**Not in scope.** No automatic suppression without an intent; no changes to the deterministic correlator's grouping rules; no cross-org pattern mining.

### 4.2 P2-2 Scheduled sweeps

**Config.** New dual-owner table `ai_agent_schedules` (§5): partner defines `(agent_id, cron, timezone, sweep_kind[], enabled)`; an org row may only **disable** or **remove kinds** from what the partner enabled (tighten-only, same resolver shape as `effectivePolicy`). **Amendment:** an org row carries `baseline_schedule_id` (FK to the partner row, `NOT NULL` when `org_id` is set — CHECK) because one agent may have several partner schedules and `agent_id` alone cannot say which one the org is tightening. Sweep kinds v1: `disk_pressure`, `stale_agents`, `pending_reboots`, `failed_backups`, `unpatched_critical`, `expiring_certs`, `service_down`. Each kind is a fixed read-only tool recipe in `services/aiAgents/sweepKinds.ts`, not free prompting.

**Trigger.** One BullMQ repeatable per partner schedule (`ai-agent-sweep-<scheduleId>`, worker-role placement per the wave-3.5d registry). On fire it fans out one **full-profile** `triage` run per org the partner schedule covers (org-scoped run, device-less: `deviceId NULL`, `triggerKind: 'schedule'`, `triggerRef: scheduleId`, dedupe `sweep:<scheduleId>:<orgId>:<fireIso>`). Fan-out respects `maxConcurrentRuns` per org and the circuit breaker; a skipped org is recorded on the schedule's `last_run_summary`.

**Amendment (P2-2 plan, 2026-08-29):** `scheduleRegistry.contract.test.ts` resolves every `repeat` option statically and fails closed on a dynamic one, so "one BullMQ repeatable per partner schedule" is not implementable. The trigger is a **fixed 5-minute singleton tick** (`jobs/aiAgentSweepScheduler.ts`, `every: SWEEP_TICK_INTERVAL_MS` — a fine-grained tick, no `JOB_SCHEDULES` slot) that, per enabled partner schedule, computes the latest cron occurrence ≤ now in the schedule's timezone (`latestCronOccurrence`, local wall-clock key → one fire per wall-clock occurrence across DST; latest-only misfire policy, 24 h lookback), enqueues a `jobId`-deduped occurrence job, and only then CASes `last_enqueued_at`/`last_occurrence_key`. The occurrence job re-reads effective config and admits one run per org with `dedupeKey sweep-<scheduleId>-<orgId>-<occurrenceKey>`.

**Outcome.** Via `submit_sweep_findings`: `AgentRunOutcome.sweepFindings: SweepFinding[]` — `{ kind, severity, deviceId?, title, detail, evidence: {...display fields only}, proposedAction?: { opKey, deviceId, args }, proposedIntentId? }`. A sweep run is **device-less and read-only** — it never calls a mutating tool (the guardrail would deny it, `aiGuardrails.ts:1625`). `finishRun` converts each `proposedAction` into a **device-bound intent** (Tier-2 single-approver, or Tier-3 → inbox / policy-decide), capped by `maxActionsPerRun`; act-mode execution of a manifest op then happens through the existing act pipeline (revalidate → reserve → execute → verify → fix-watch) as a **child run** bound to that device, so blast caps and the circuit apply per device exactly as for alert-triggered runs.

**Amendment (P2-2 plan):** the sweep run is admitted on its own `profile: 'sweep'` (own counters, no cooldown, circuit-neutral on success). Evidence for each sweep kind is **system-executed** before the model runs (`sweepEvidence.ts`, bounded rows + byte cap, display fields only) and rendered into the task prompt; the model gets a small read-only drill-down floor plus `submit_sweep_findings`. `expiring_certs` is **deferred** (no SSL-monitoring data path exists; only agent mTLS certificates) — roadmap item to be filed. v1 proposable actions: `manage_services:restart {deviceId, serviceName}` and `remediate_vulnerability {deviceId, deviceVulnerabilityIds}` (both Tier-3 `supervised` for the agent principal → one-click cards); `disk_cleanup:execute` needs preview-pinned `paths` and is finding-only in v1. Proposals become **device-bound intents through an intent-level target scope** (`action_intents.scope_kind = 'device'`, `scope_device_id`), not through a child run. **Act-mode auto-execution of sweep proposals (the "child run") is roadmap #4442, NOT P2-5** — in this wave a sweep proposal is always a supervised inbox card, exactly as P2-1 ruled for `manage_alerts`.

**Digest.** `runFinishedNotify` gains a `sweep` template: one notification per org per sweep with the ranked findings and a link to the run trace. Recipients from `ai_agents.recipients`.

**Inbox.** `/approvals` gains **batch approve/decline** for cards sharing `(orgId, tool, action)` — sweep proposals are where cards pile up. Batch decisions are per-card intents decided in one request; four-eyes cards are excluded from batch (each needs its own second approver).

### 4.3 P2-3 Weekly org narrative

**Trigger.** A `narrative` schedule kind on `ai_agent_schedules` (weekly), `profile: 'narrative'`, one run per org (originally drafted as a sweep kind on the full profile — superseded by the amendment below).

**Amendment (P2-3 plan, 2026-08-29):** `narrative` is a schedule **kind** (`ai_agent_schedules.kind IN ('sweep','narrative')`; a narrative schedule is its own row with `sweep_kinds = '{}'`; org rows inherit the baseline's kind via a composite self-FK and expose only `enabled`; weekly default `0 7 * * 1`; **the cron must be weekly** — minute/hour literal, day-of-month and month `*`, a single day-of-week — so the report definition's `schedule = 'weekly'` is truthful), not an `AiSweepKind` — every sweep kind must own an evidence loader. The occurrence job admits one `profile: 'narrative'` run per live org (`dedupeKey narrative-<schedule>-<org>-<occurrence>`).

**Inputs (bounded).** Previous 7 days: alert counts by rule + verdict classifications, sweep findings, executed/held/recurred fixes, tickets opened/closed by category, patch compliance delta, backup success rate, device online/offline delta. Assembled by `services/aiAgents/narrativeContext.ts` as **structured numbers and short labels** — no free-text ticket bodies, no alert messages beyond rule names — 16 KiB ceiling.

**Amendment (P2-3 plan):** three inputs are reported as "not measured" rather than derived: alerts *suppressed in the window* (no `suppressed_at`; only a current-state count exists), the device *online/offline delta* (no status history; current state + enrolled-in-window + mean `uptime_7d` instead), and the patch-compliance delta (taken from `security_posture_org_snapshots.patch_compliance_score` day-buckets over 14 days; `patch_compliance_snapshots` has no writer). Every context field carries an explicit availability flag the prompt renders honestly; the 16-KiB ceiling applies to the whole serialized context.

**Outcome.** The run is `profile: 'narrative'` (a `full`-profile run cannot reach an outcome tool) with an EMPTY tool floor + `submit_narrative`; the model submits `{ headline, sections: [{ key ∈ NARRATIVE_SECTION_KEYS (all eight, exactly once), bullets }] }` — titles and markdown are server-owned. Stored in one transaction as a system-authored `reports` DEFINITION row per (org, schedule) (`type 'ai_org_narrative'`, `schedule 'weekly'`, `format 'pdf'`, `source_ai_agent_schedule_id` = the schedule, execution scope `unrestricted` with `execution_scope_principal_kind = 'system'` and no user) plus one `report_runs` row per narrative carrying `result.summary.narrative`; `ai_agent_runs.report_run_id` links the artifact (CAS on `IS NULL`). The report worker never runs the AI type (`findDueReports` and `processRunScheduledReport` exclude it; `generateReport('ai_org_narrative')` throws `StoredArtifactOnlyReportError`; create/ad-hoc schemas reject the type). Rendered from `sections[]` by the jsPDF renderer (no markdown-to-PDF). Delivery v1 = in-app notification to the agent's recipients + the protected download route; email is deferred until recipients can be filtered through `resolveLiveReportAuthority(userId, orgId, 'export')` requiring `unrestricted`. Partner branding via `reportBranding` as for every other report type.

**UI.** Appears in the reports list like any other scheduled report; the run trace links to it. Partner-brandable, exportable (protected download); email delivery deferred (see Outcome).

### 4.4 P2-4 Ticket triage (act)

Builds on wave 6.3 (`ticket_outbox`, durable subscriber, forced-shadow runs, `ticketProposal`, bounded hostile context, origin-based loop guard). This wave lifts the shadow force **only** when both gates are open: agent `mode = 'act'` **and** a new per-agent toggle `triggers.ticket.autonomousWrites` (default `false`). Otherwise 6.3 behaviour is unchanged.

**Amendment (P2-4 plan, 2026-08-30, quorum):** As built, P2-1 has no `'single'` approval scope — agent-minted Tier-2 intents receive `approvalScope: 'supervised'` via `createActionIntent`'s agent-Tier-2 path (`intentService.ts` `agentTier2`), and that is the P2-4 lifecycle. Autonomy ("act + `autonomousWrites`") is decided INSIDE the intent-creation transaction, before human approval fan-out (`decidedVia: 'ticket_autonomy'`, no approver rows, released through the normal durable pipeline with release-time revalidation) — a post-create decider would race the `human_required` state and already-sent approval notifications. The toggle is the flat `triggers.ticketAutonomousWrites` with `anomalyEnabled`'s org-row-only opt-in merge (a partner baseline can never blanket-enable autonomous writes; default false; consulted in BOTH live policy and the run's start-of-run snapshot). Ticket runs move to a fifth profile `'triage'` (empty tool floor + `submit_ticket_proposal`; a `full` run cannot reach an outcome tool); limits v8. `assignedTeam` is DEFERRED (dead column: no FK, no writer, no reader — roadmap). The human-set-field authority is a new transactional `tickets.field_provenance` jsonb stamped by `updateTicketFields` in the same transaction as every human field write, plus value-CAS predicates at execution — NOT `audit_logs`, which is asynchronous, drop-on-retry-exhaustion, and records synthesized user actors for AI calls. Resolution-note drafts are consumed through the existing resolve operation (prefill + consume), never posted as comments. The `status_changed → resolved` trigger is in scope; create/first-human-comment share one dedupe identity (one triage run per ticket, first event wins; re-triage is roadmap).

**Autonomous writes** — produced as structured fields on `ticketProposal` (via `submit_ticket_proposal`), converted by `finishRun` into Tier-2 single-approver `manage_tickets` intents scoped `{ ticketId }`, auto-executed in act mode + `autonomousWrites`, otherwise inbox cards:
- `update_fields`: `categoryId`, `priority`, `assignedTeam` (queue) — only when `ticketProposal.confidence ≥ 0.7` per field; never overwrites a value a human already set (checked against `ticket` audit trail at execution time — the revalidation step).
- `link_device`: sets `tickets.deviceId` when the proposal identifies a device by hostname/serial **that belongs to the ticket's org** with a single match; ambiguous → no write, mention in the note.
- `comment` with `isPublic: false`, `originPrincipalKind: 'ai_agent'`, `agentRunId` set — the triage summary. Exactly one per run; the loop guard (6.3) guarantees it never re-triggers a run.

**Drafts (never sent by the agent).** **Amendment (quorum, accepted):** drafts live in a dedicated `ticket_drafts` table (§5), not columns on `tickets` — a draft has identity, kind, provenance, lifecycle and history; columns cannot hold a reply and a resolution draft from different runs, supersession, or the send/discard evidence P2-6 counts. One active draft per `(ticket_id, kind)` (partial unique on `state = 'active'`); a newer run supersedes the older (`state = 'superseded'`). Written by `finishRun` from `ticketProposal.draftReply` / `draftResolutionNote` as a Tier-2 single-approver intent `manage_tickets:draft` with scope `{ ticketId }` (auto-executes in act mode + `autonomousWrites`; otherwise the inbox card's approve action creates the draft). The ticket UI shows "AI draft" with **Send as me** / **Discard**; sending posts a normal public comment under the technician's identity and marks the draft `consumed` with `consumed_by`/`consumed_at`; discard marks `discarded`. Resolution-note draft is produced on `ticket.status_changed → resolved` when no `resolutionNote` exists; the tech accepts or edits at close.

**Scope (Amendment):** the guardrail policy object gains a non-device scope `{ ticketId }` so ticket-bound Tier-2 intents can be revalidated (ticket still open, same org, field not human-set) without a device; `buildAgentAuthContext` pins the ticket's org and site (via linked device if any) exactly as it pins `allowedSiteIds` for device runs.

**Context additions over 6.3.** Linked device's last 24h alerts + verdicts, open sweep findings for that device, last 3 resolved tickets in the same category for the org (titles + resolution notes only, HTML-stripped, same 12 KiB ceiling). Still no requester PII, no attachments, no custom fields.

**Not in scope.** Public replies without a click; auto-close; time-entry creation (roadmap); reading email threads beyond what 6.3 already exposes.

### 4.5 P2-5 Feedback + graduation

**Amendment (P2-5 plan, 2026-09-01, quorum):** `ai_agent_op_stats_daily` is DROPPED and replaced by `ai_agent_op_evidence` — one immutable row per outcome, UNIQUE `(source_kind, source_id, metric)`, inserted `ON CONFLICT DO NOTHING` inside the transaction that terminalizes the outcome. Daily counter buckets cannot be incremented exactly-once under BullMQ redelivery (`count = count + excluded.count` is not idempotent) and a `date` bucket cannot distinguish evidence before and after a same-day `demoted_at`; every aggregate is a GROUP BY over the ledger instead, and a 400-day retention job prunes it. Outcome-evidence vocabulary (namespace `policy_key` / `act_op`) is four metrics, not "success/failure": `executed` (attempted AND the executor reported success), `verified` (`executed` AND a fix-watch reached `held_qualified`, or no eligible watch existed for that source), `failed` (**ATTEMPTED** failure only — the terminal write stamps `executed_at`; revalidation refusals, `session_required`, `connection_unavailable` and pre-execution digest stops are NOT failures), `recurred` (fix-watch `recurred`). Verdict feedback (namespace `alert_verdict`, `source_kind: 'verdict_feedback'`) adds two more — `feedback_up` / `feedback_down` — for six `metric` CHECK values total (`AI_AGENT_EVIDENCE_METRICS`). Fix watches become **intent-anchored** as well as run-anchored (`intent_id` + partial UNIQUE, `source_kind`, `op_keys[]`) so N independently released intents from one run each get their own verification episode — the run-unique watch mis-attributed them (closes #4206). `ai_agent_graduation` gains a fourth state `tracking`. **Partner `supervisedActionKeys` become a CEILING, not inherited authority**: with no org row the effective key set is `[]` (today `mergeAgentPolicies` returns the partner policy verbatim, `effectivePolicy.ts:135-159`), so an org-level promote is the only thing that makes a key live and an auto-demote actually revokes one. `promoteThreshold` is a new v9 limit merged with `max`, not `min`. Promotion is human-only: `manage_ai_agents` is denied to the `ai_agent` principal in `checkAgentGuardrails`. Four-eyes here means requester + one DIFFERENT approver, first eligible approval wins (`decideApprovalRequest.ts:964-1009`), and the sole-operator WebAuthn self-approval exception (`intentService.ts:574-586`) applies unchanged. Eligibility, promotion and negative evidence all serialize on `pg_advisory_xact_lock` over `(org_id, agent_id, op_key)`.

**Stats.** `ai_agent_op_stats_daily` (§5; **Amendment** — daily buckets, not rolling counters: a true 30-day window cannot be maintained from aggregate counters, and the eligibility query sums buckets at read time), upserted by `finishRun` and by `fixWatch` verdict writes. **Fix-watch attribution (Amendment):** a watch is unique per run and stores no op key (`fixWatch.ts:128`, `:164`) while a run may execute up to `maxActionsPerRun` ops — P2-5 adds `op_keys text[]` snapshotted onto the watch at creation; a `recurred` verdict counts as a failure for **every** op in the snapshot and `held_qualified` as a success for every op (conservative: shared credit, shared blame).
- **success** for (org, agent, op_key, rule_id?) = execution `verification: 'passed'` **and** (fix-watch `held_qualified`, or the op had no eligible watch);
- **failure** = verify-fail, or fix-watch `recurred`;
- `inconclusive` watches count as neither.
30-day rolling window (`window_start` advanced by a daily repeatable that also prunes).

**Promote suggestion.** Surfaces when `verified_count ≥ promoteThreshold` (partner-tunable on `ai_agents.limits`, default 20), `failed_count = 0`, `recurred_count = 0`, and `now - first_verified_at ≥ 14 days`, **and** the op key is in `POLICY_DECIDABLE_TIER3`. Two surfaces:
1. Settings → agent → "Graduation" panel listing eligible (org, op) pairs with the stats.
2. An **"Approve and always allow"** secondary action on the matching `/approvals` card.

Both create a **four-eyes action intent** (`tool: 'manage_ai_agents', action: 'authorize_supervised_key'`, new Tier-3 four-eyes entry in `aiGuardrails`). Approval appends the op key to the **org-level** `ai_agents.actAssets.supervisedActionKeys` (wave-5's existing authorization list) — never the partner baseline. Gated by `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` because that is the path it feeds.

**Amendments (quorum, all three accepted):**
- Effective keys are the **intersection** of partner and org (`effectivePolicy.ts:199`), so an org-only append does nothing unless the partner baseline already holds the key. Eligibility therefore additionally requires the key in the **partner** row's `supervisedActionKeys`; the graduation panel shows "needs partner baseline" otherwise, and the partner-settings UI gets a matching hint.
- An org override row may not exist, and creating one from schema defaults would disable the agent and empty its allowlists (`aiAgents.ts:45`). The handler **clones the effective policy** into a new org row (same mode/allowlists/limits as currently effective, then adds the key) inside one transaction with `SELECT … FOR UPDATE` on the partner row; every write to `actAssets` (promote, demote, settings) takes `FOR UPDATE` on the target row — no read-modify-write of the jsonb outside a row lock.
- "Approve and always allow" **does not** authorize the current intent via policy: policy-decide requires the key in both the live policy and the run's immutable snapshot (`policyDecide.ts:512`). The card's approve still follows the normal approval; graduation affects **future runs only** (stated on the card).

**Auto-demote.** On the first failure for a key present in the org row's `supervisedActionKeys`: remove the key (system write under `withSystemDbAccessContext`, audited with `reason`, `runId`, `watchId`), notify `recipients` at high priority, stamp `ai_agent_op_stats.demoted_at`. Never touches `ai_agents.enabled`, `mode`, or the partner row. Re-promotion requires the stats to re-qualify from `demoted_at`.

**Verdict precision.** P2-1's 👍/👎 rolls into `ai_agent_op_stats` rows keyed `op_key = 'alert_verdict'` + `rule_id`, reported in P2-6. No prompt adaptation from feedback in this program (roadmap).

### 4.6 P2-6 Value accounting

**Rollup.** `ai_agent_impact_daily` (§5), rebuilt idempotently per (org, day) by a nightly repeatable from `ai_agent_runs`, `ai_alert_verdicts`, `action_intents`, `ai_agent_fix_watches`, `ticket_drafts` (`drafts_sent` = `consumed` rows), `ai_cost_usage`. Columns: `alerts_judged`, `noise_flagged` (transient/recurring/duplicate verdicts), `suppressions_applied` (executed suppress intents), `tickets_triaged`, `drafts_sent`, `fixes_proposed`, `fixes_executed`, `fixes_held`, `fixes_recurred`, `est_seconds_saved`, `llm_cents`.

**Estimate model.** `est_seconds_saved` = Σ per-outcome constants, partner-overridable on a new `ai_agents.impactWeights` jsonb (defaults: alert judged 90 s, noise flagged 240 s, ticket triaged 360 s, draft sent 300 s, fix executed 900 s, narrative 1800 s). Always rendered as **"estimated"** beside actual LLM spend; no claim of measured time. Measured time-saved (ticket time entries, MTTR deltas) is a roadmap item.

**UI.** `/ai-agents/impact`: partner-wide and per-org, 7/30/90-day, the counters above, verdict precision, promote-eligible count, spend. Reuses the reports renderer for a PDF export.

## 5. Data model

All tables: RLS ceremony per CLAUDE.md, org cascade + export policy + org-merge registry (`leave-for-erasure` unless noted), Drizzle barrel export, one idempotent migration per wave named to sort after the newest committed file (`2026-09-19-…` at spec time — re-check at plan time).

| Table / change | Shape | Tenancy | Wave |
|---|---|---|---|
| `ai_agent_runs.profile` `text NOT NULL DEFAULT 'full'` CHECK `IN ('full','verdict')`; `correlation_group_id uuid NULL` FK `alert_correlation_groups` SET NULL; `report_run_id uuid NULL` FK `report_runs` SET NULL (P2-3); `schedule_id uuid NULL` FK `ai_agent_schedules` SET NULL | column adds → export `included` | existing | P2-1/2/3 |
| `ai_agent_runs.schedule_id uuid NULL` FK `ai_agent_schedules` SET NULL | column add → `included` | existing | P2-2 |
| `ai_alert_verdicts` | `id, org_id, run_id FK ai_agent_runs CASCADE, alert_id NULL FK alerts CASCADE, correlation_group_id NULL FK CASCADE, classification, confidence numeric(3,2), rationale text, pattern jsonb NULL, suggested_intent_id NULL FK action_intents SET NULL, feedback text NULL CHECK IN ('up','down'), feedback_by NULL FK users SET NULL, feedback_at, superseded_by NULL FK self SET NULL, created_at`; CHECK exactly one of `alert_id`/`correlation_group_id`; index `(org_id, alert_id)`, `(org_id, correlation_group_id)`, partial on `superseded_by IS NULL` | shape 1; `pattern` jsonb → export `excludedOpen` | P2-1 |
| `ai_agent_schedules` | `id, partner_id NULL, org_id NULL, one_owner_chk, agent_id FK ai_agents CASCADE, baseline_schedule_id NULL FK self CASCADE (CHECK: NOT NULL iff org_id set), cron text, timezone text, sweep_kinds text[], enabled bool, last_enqueued_at, last_run_summary jsonb NULL, created_by, created_at, updated_at`, last_occurrence_key text NULL`; kind text NOT NULL DEFAULT 'sweep' CHECK IN ('sweep','narrative'); CHECK ((kind='narrative' AND cardinality(sweep_kinds)=0) OR (kind='sweep' AND (org_id IS NOT NULL OR cardinality(sweep_kinds)>0))); FK (baseline_schedule_id, kind) → (id, kind)`; unique (org_id, baseline_schedule_id) WHERE org_id IS NOT NULL; org override = leave-for-erasure on merge; dual-axis RLS policy | dual-owner config (§Partner-Wide First); `DUAL_AXIS_TENANT_TABLES`; `last_run_summary` → `excludedOpen` | P2-2 |
| `reports.report_type` gains `'ai_org_narrative'` | enum add | existing | P2-3 |
| `reports.source_ai_agent_schedule_id uuid NULL` FK `ai_agent_schedules` SET NULL, partial UNIQUE `(org_id, source_ai_agent_schedule_id)`; `reports.execution_scope_principal_kind text NULL` CHECK `IN ('user','system')` | column adds → export `included` | existing | P2-3 |
| `report_runs.execution_scope_principal_kind text NULL` CHECK `IN ('user','system')` (same) | column add → export `included` | existing | P2-3 |
| `ticket_drafts` | `id, org_id, ticket_id FK tickets CASCADE, run_id FK ai_agent_runs SET NULL, intent_id NULL FK action_intents SET NULL, kind CHECK IN ('reply','resolution_note'), content text, state CHECK IN ('active','consumed','discarded','superseded'), created_at, consumed_by NULL FK users SET NULL, consumed_at, superseded_by NULL FK self`; partial unique `(ticket_id, kind) WHERE state = 'active'` | shape 1; org cascade + export (`content` → `included`; reviewed: draft text is customer data, not a secret) + org-merge | P2-4 — Amendment: composite (parent_id, org_id) FKs to tickets/ai_agent_runs/action_intents; forced RLS; supersession serialized FOR UPDATE. |
| `ai_agents.triggers.ticketAutonomousWrites` | jsonb key on existing column; validator + no snapshot bump (triggers rule); limits v8 | existing | P2-4 |
| `ai_agent_op_evidence` | `id, org_id, agent_id FK ai_agents CASCADE, namespace CHECK IN ('policy_key','act_op','alert_verdict'), op_key text, rule_id uuid NULL (no FK — historical), source_kind CHECK IN ('intent','watch','act_execution','verdict_feedback'), source_id text, metric CHECK IN ('executed','verified','failed','recurred','feedback_up','feedback_down'), run_id NULL composite FK (run_id, org_id) → ai_agent_runs(id, org_id) SET NULL, occurred_at, created_at`; UNIQUE `(source_kind, source_id, metric)`; partial UNIQUE `(source_id) WHERE source_kind = 'verdict_feedback'`; index `(org_id, agent_id, namespace, op_key, occurred_at DESC)` | shape 1; every column `included` | P2-5 |
| `ai_agent_graduation` | `id, org_id, agent_id FK CASCADE, op_key, state CHECK IN ('tracking','eligible','promoted','demoted'), first_verified_at, promoted_at, promoted_intent_id NULL, composite FK (promoted_intent_id, org_id) → action_intents(id, org_id) ON DELETE SET NULL, demoted_at, demote_reason, demote_run_id NULL, demote_watch_id NULL, updated_at`; unique `(org_id, agent_id, op_key)` — transition **history and eligibility state only**; the authority stays `ai_agents.actAssets.supervisedActionKeys` | shape 1 | P2-5 |
| `ai_agent_fix_watches`: `op_keys text[] NOT NULL DEFAULT '{}'`, `intent_id uuid NULL` (composite FK `(intent_id, org_id) → action_intents(id, org_id)`, partial UNIQUE `(intent_id) WHERE intent_id IS NOT NULL`), `source_kind text NOT NULL DEFAULT 'act_run' CHECK IN ('act_run','intent')`; the existing `run_id` UNIQUE becomes partial `WHERE source_kind = 'act_run'` | column adds → `included` | existing | P2-5 |
| `ai_agent_impact_daily` | `id, org_id, day date, …counters int, est_seconds_saved int, llm_cents int, rebuilt_at`; unique `(org_id, day)` | shape 1 | P2-6 |
| `ai_agents.impactWeights jsonb NULL` | column add → `excludedOpen` | existing | P2-6 |
| `AiAgentLimits` v5: `maxVerdictRunsPerHour` (200, 1–2000), `maxConcurrentVerdictRuns` (4, 1–20), `verdictBudgetCentsPerRun` (5, 1–50), `promoteThreshold` (20, 5–200, merged with **max**) | snapshot v8 → v9 (promoteThreshold only) | shared | P2-1/5 |
| `action_intents` Tier-2 lifecycle | `approvalScope` gains `'single'`; `tier` column admits 2; typed target scope: scope_kind text NULL CHECK IN ('device'), scope_device_id uuid NULL FK devices SET NULL (P2-2; P2-4 adds scope_ticket_id); `intentReleaseWorker` executes a decided Tier-2 intent through the normal tool path with the intent's scope pinned | existing table, column CHECK relaxations + validators | P2-1 |

`AgentRunOutcome` gains `alertVerdict?`, `sweepFindings?`, `narrative?`; the reserved `findings: unknown[]` is removed in P2-1 (nothing reads it; safe projection in `runTrace.ts` enumerates the new fields by hand, display values only, per the wave-6.1 DTO rule).

## 6. Approvals integration (D7)

| Mutation | Tool:action | Tier | Path |
|---|---|---|---|
| Suppress / resolve alert (P2-1) | `manage_alerts:suppress` / `resolve` | 2 (`single`) | act + act-manifest entry → execute + verify; else inbox card |
| Sweep remediation (P2-2) | per act manifest | 2 / 3 | existing `recordProposal` → supervised inbox card; auto-execution is roadmap #4442 |
| Ticket field, device link, private note (P2-4) | `manage_tickets:update_fields` / `link_device` (new) / `comment` | 2 (agent-minted, `supervised`), scope `{ ticketId }` | act + `autonomousWrites` → execute; else inbox |
| Ticket draft (P2-4) | `manage_tickets:draft` (new) | 2 (agent-minted, `supervised`), scope `{ ticketId }` | as above; the **send** is a human UI action |
| Promote (P2-5) | `manage_ai_agents:authorize_supervised_key` (new) | 3 four-eyes | inbox; requester + one different approver (first eligible approval wins), human-only principal |
| Auto-demote (P2-5) | system write | — | audited + notified, no approval |

New inbox affordances: batch approve/decline for same-(org, tool, action) Tier-2 cards (P2-2); "Approve and always allow" → creates the P2-5 promote intent for **future** runs (P2-5).

**Tier-2 intent lifecycle (P2-1 foundation, Amendment):** `createActionIntent` accepts tier 2 from the `ai_agent` principal only (chat-originated Tier-2 keeps `auto_approve` semantics unchanged); `approvalScope: 'single'` needs one approver with `ai:write` on the org; no policy-decide, no exposure ledger, no four-eyes; decided intents release through `intentReleaseWorker` with the intent's scope pinned and the same revalidation hook shape as act ops (`actRevalidation.ts`). Existing `runLoop.ts:461` proposal recording becomes "create Tier-2 intent" only for proposals that come out of outcome tools; free-form Tier-2 tool calls in shadow stay recorded-only, as today.

## 7. Rollout, flags, safety

- **No new env flags.** P2-1..3, P2-6 activate under `BREEZE_AI_AGENTS_ENABLED` for any agent with `mode ≥ shadow`. P2-4 autonomous writes need `mode = act` + `autonomousWrites`. P2-5 promotion needs `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`; auto-demote is always on.
- Kill switch, circuit breaker, exposure ledger, `maxActionsPerRun`, cooldowns apply unchanged to every act-mode mutation. Verdict runs never touch the ledger — structurally (§4.1), not by a profile exemption.
- Verdict volume guard: `maxVerdictRunsPerHour` + `maxConcurrentVerdictRuns` per agent on their own counters; overflow is `skip('verdict_rate')` / `skip('max_concurrent_verdict_runs')` on admission, visible in the runs list, never queued.
- Every prompt input in this program is **display fields only** (rule names, counters, hostnames, sanitized titles); no raw alert messages, ticket bodies beyond 6.3's bounded context, or tool outputs.
- Sentry: no ticket/alert text in tags or breadcrumbs (scrubber allowlist).
- Each wave: partner-wide-first tests (`<table>PartnerRls.integration.test.ts` for `ai_agent_schedules`), RLS coverage allowlists, org-cascade + export-policy + roundtrip suites, 8-locale i18n, `pnpm lint`.

## 8. Testing (per wave, minimum)

- Contract: outcome safe-projection Zod test per new outcome type (raw tool I/O never serialized); terminalization contract (no new terminal writers); registry snapshot updates for every new repeatable/worker; **outcome tools are Tier-1 and execute nothing** (source-scan + tier assertion); **no `profile === 'verdict'` branch exists in any guardrail, ledger or admission bypass** (source-scan); `classifyTerminal` verdict-profile table test.
- Integration (real Postgres): `alert.correlation_group.created` fires once per NEW group (not on member upserts) and the subscriber admits exactly one verdict run per group; verdict admission never consumes full-profile concurrency/cooldown; sweep fan-out fires per org and respects circuit-open; sweep proposals become device-bound intents and never a device-less mutation; promote intent clones-from-effective when no org row exists, writes the **org** row's `supervisedActionKeys` under `FOR UPDATE`, never the partner, and is refused when the partner baseline lacks the key; auto-demote removes the key on first failure and re-qualification waits for `demoted_at`; Tier-2 `single` intents release with scope pinned and never touch the exposure ledger; batch approve excludes four-eyes cards; one active `ticket_drafts` row per (ticket, kind).
- Unit: sweep-kind recipes are read-only (tool tier assertion); ticket field writes refuse to overwrite human-set values; draft send clears drafts and posts under the technician's identity; impact rollup is idempotent per (org, day).
- Web: verdict badge/feedback, batch approve, draft send/discard, impact page — Vitest + `localeParity`.

## 9. Consequential decisions for the Codex quorum

1. **Verdict profile on the same runner** vs a separate classifier path (D6) — cost model, ledger exemption, circuit-breaker semantics.
2. **Promotion as a four-eyes intent writing `supervisedActionKeys` on the org row** — vs a dedicated graduation table.
3. **Ticket drafts as columns on `tickets` written via a Tier-2 `manage_tickets:draft` intent** — vs a `ticket_drafts` table / vs private comments flagged as drafts.

**Quorum outcome (Codex `gpt-5.6-sol` xhigh, read-only, 2026-08-28; every cited defect verified in-session against the files):**

| # | Verdict | Resolution |
|---|---|---|
| 1 Verdict profile | **AGREE**, with conditions | Accepted all three: no profile-keyed ledger bypass (ledger is already mutation-specific); separate verdict admission counters (`maxConcurrentVerdictRuns`, own rate, own cooldown bucket); `classifyTerminal` takes the profile so a verdict completion is `neutral`, never `reset`. |
| 2 Promotion as four-eyes intent on `supervisedActionKeys` | **AGREE** | Accepted all three defects: partner-baseline prerequisite (intersection semantics), clone-from-effective when no org row exists + `FOR UPDATE` on every `actAssets` write, graduation is future-runs-only. Added `ai_agent_graduation` for transition **history** only — authority stays on the policy row (Codex's split-brain warning). |
| 3 Drafts as `tickets` columns | **DISAGREE → accepted** | `ticket_drafts` table with kind/state/provenance and a partial unique per (ticket, kind). Draft-flagged comments rejected by both sides. |
| Gap: no structured-output path | accepted | Outcome tools (`submit_*`, Tier-1, Zod-validated, execute nothing); system converts proposals to intents post-run. |
| Gap: Tier-2 intents don't exist | accepted | Tier-2 `single` lifecycle is a P2-1 foundation deliverable (§6). |
| Gap: device-less mutations denied | accepted | Sweep/ticket runs are read-only; intents are system-created with explicit `{ deviceId }` / `{ ticketId }` scope; act execution of sweep ops runs as a device-bound child run. |
| Gap: group-created event not emittable | accepted | `upsertGroup` → `RETURNING (xmax = 0) AS created`; publish after commit. |
| Gap: rolling window from counters; nullable `rule_id` in unique | accepted | Daily buckets; `NULLS NOT DISTINCT`. |
| Gap: fix-watch has no op key | accepted | `op_keys[]` snapshot on the watch; shared credit/blame. |
| Gap: schedule override has no baseline link | accepted | `baseline_schedule_id`. |
| P2-2 D1 typed intent scope (vs jsonb / proposal-run / relaxed deny) | **AGREE** | Adopted five additions: immutable `scope_kind` discriminator so a SET-NULL tombstone is distinguishable from "never scoped" (release fails closed); immutability trigger admits only the `non-null → NULL` tombstone transition; scope is part of idempotency identity; tool-argument `deviceId`/`deviceIds` must equal the scope; all run-derived readers (`intentApprovers.ts:202,381`, `intentService.ts:1317`, actor context, release authority, policy path) share one resolver. |
| P2-2 D2 `sweep` profile | **DISAGREE → adopted** | Success is circuit-neutral (a clean sweep must not reset an org's failure streak); evidence is system-executed (`onlyTools` filters names, not actions/args); admission uses an exhaustive profile switch; notify and fix-watch gating split. |
| P2-2 D3 fixed-tick sweeper | **DISAGREE → adopted** | No `JOB_SCHEDULES` entry for a sub-hourly tick; latest-occurrence with explicit misfire policy; jobId-deduped occurrence job BEFORE the CAS; occurrence job re-reads config; DST keyed by local wall-clock. |
| P2-2 D4 kinds + proposals | **DISAGREE → adopted** | Six kinds, `expiring_certs` deferred; `disk_cleanup:execute` finding-only; `remediate_vulnerability` (device-verified finding ids) instead of `manage_patches:install`; supervised-only wave is an explicit spec amendment, not silent non-compliance. |
| P2-3 D1 schedule shape | **DISAGREE → adopted** | Fable: `kind` column + XOR-with-empty-kinds CHECK. Codex: the XOR rejects valid sweep org overrides holding `'{}'`; use the two-arm CHECK, composite self-FK on `(baseline_schedule_id, kind)`, weekly-only narrative cron. |
| P2-3 D2 narrative profile | **AGREE** | Both: `profile:'narrative'`, empty floor, limits v7, circuit-neutral success, notify after persistence, no watch. |
| P2-3 D3 storage + linkage | **DISAGREE → adopted** | Fable: `unrestricted` scope stamped from `ai_agents.created_by`; app-level find-or-create. Codex: forged attribution; add a system principal (`principal_kind`); `report_runs` lacks `org_id`; find-or-create races. Adopted system principal, typed `reports.source_ai_agent_schedule_id` + partial unique, single-transaction CAS finalizer; the `report_runs.org_id` retrofit is pre-existing and filed as a roadmap item (not this wave). Only `report_run_id` stored on the run. |
| P2-3 D4 rendering + delivery | **AGREE** (rendering); **DISAGREE → adopted** (delivery) | Rendering: jsPDF arm, server-owned titles/order, derived markdown. Delivery: Codex — `resolveRecipientUserIds` does not verify `reports:export` or unrestricted site authority; email attaches full-org data. Adopted: v1 = in-app notification + protected download; email deferred (roadmap). |
| P2-3 D5 report-worker interplay | **DISAGREE → adopted** | Fable: `generateReport` re-serves the latest snapshot. Codex: the Generate route inserts a new `report_runs` row and advances `last_generated_at` (false provenance); exclude the type in `findDueReports` AND `processRunScheduledReport`, throw `StoredArtifactOnlyReportError`, reject the type in create/ad-hoc schemas, UI shows "Open latest". |
| P2-3 D6 context | **AGREE** | Tenancy invariants now in the plan's Global Constraints: org pin on every joined table, posture trend `{orgId}`, rule owner admission rule, category join on `partner_id`, per-loader isolation, whole-context byte ceiling. |

Disagreement resolved on the merits; nothing surfaced to the user as unresolved.

## 10. Lifecycle

- Parent `feature` issue **#4187** with six `wave` sub-issues **#4188–#4193** (P2-1..6). Branch pattern `feature/4187-ai-agents-p2/wave-<sub#>`.
- #3821 closes when 6.3 merges; its wave-7 title's "anomaly sources" is satisfied by P2-1 (note on the issue).
- PR bodies `Closes #<sub>` on the wave's final PR; `Part of #<sub>` on earlier PRs of a multi-PR wave.

## 11. Deferred — recorded on the roadmap (GitHub `roadmap` issues #4173–#4183, created 2026-08-28)

| Item | Why deferred | Revisit when |
|---|---|---|
| Fleet fan-out (canary → widen) for multi-device remediation — **#4173** | most consequential remaining blast-radius design; needs its own quorum | P2-5 stats exist for ≥ 1 real partner |
| `patch` agent runner (approve safe updates, sequence reboots, chase failures) — **#4174** | closed op set but big surface; deserves a program | after fleet fan-out shape is decided |
| Auto-promote shadow → act within partner-set bounds — **#4175** | D4: humans flip autonomy | if promote suggestions prove consistently accepted |
| Customer-facing ticket replies / auto-close without a click — **#4176** | D3 | after draft-send acceptance rate is known |
| Time-entry creation from AI-triaged tickets — **#4177** | billing-adjacent | with the patch/ticket follow-on |
| Anomaly-source trigger (metric baselines → agent run) — **#4178** | subsumed by verdicts on correlator output | if the correlator can't express a needed signal |
| Slack/Teams approval surface; mobile inbox parity for batch — **#4179** | separate integration work | after P2-2 batch approve lands |
| Few-shot / prompt adaptation from verdict feedback — **#4180** | learning loop, needs eval harness | after P2-6 shows verdict precision |
| `/admin/tool-executions` raw-input redaction contract — **#4181** | pre-existing, admin-gated | standalone security follow-up |
| Measured (not estimated) time saved — MTTR deltas, time entries — **#4182** | needs P2-4 time-entry item | after P2-6 |
| Prior-run / org runbook memory in the prompt ("never restart SQL in business hours") — **#4183** | needs a memory model + tenancy design | own spec |
