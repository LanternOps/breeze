---
tracking_issue: LanternOps/breeze#5215
wave: W06 (#5221)
---

# Tool Catalog — Wave 6: Legacy Automations Conversion and Standalone-Admission Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MSP moves each user-authored legacy automation ("Job") onto a flow that does the same work. A pure converter reports what it carries exactly, what needs review and what it cannot carry yet. A shadow period compares the flow with live legacy decisions without running anything twice. A switch hands every future occurrence to the flow. It guarantees that no occurrence is admitted twice and that conversion itself drops none. A revert hands occurrences back. Two later, release-gated PRs freeze and then stop standalone admission on each installation.

**Architecture:**
- **Converter.** `services/flows/conversion/convertAutomation.ts` is a pure function from an `automations` row plus a loaded context to a `FlowDocumentV1`, a fidelity class and coded findings.
- **Three new flow built-ins.**
  - `resolve_targets` (Tier 1) wraps the legacy target resolver.
  - `create_alert` (Tier 2) wraps the extracted legacy alert writer.
  - `run_script_on_targets` (Tier 3) is one step that dispatches one script to a resolved device set with the legacy dispatch guarantees: queue-on-offline with a delivery deadline, dispatch counts as success, device locks, cancellation fences, and a durable per-device outcome row. It returns the succeeded and failed device sets, so later steps keep legacy's action-major, per-device-stop order.
- **Fleet pre-approval lane.** W04's act-asset lane gains a second shape: a fleet lane for `run_script_on_targets`. It binds the script snapshot, the effective run context, the offline policy, a literal selector and a user-confirmed `maxTargets`. It is never used under `forEach`.
- **Exactly-once across engines.** Cross-engine idempotency is an automation-wide occurrence-claim table, `automation_occurrence_claims`. The claim is written atomically with run admission on whichever engine admits first. The keys are the event id, the UTC schedule slot, and the webhook signature-digest and delivery-id aliases. Admission history that predates the claims is read from the legacy `automation_runs.occurrence_key`.
- **Who attempts an occurrence.** The conversion ledger (`flow_automation_conversions`, append-only generations, the automation's XOR owner axis) decides which engine attempts admission. The claims decide which engine wins.
- **Revert.** A revert closes the flow's admission at once and keeps its execution authority until its admitted runs are terminal.
- **Retirement.** It follows the monitors W05d shape, but per installation:
  - **R2** makes standalone Jobs read-only and pre-creates shadow conversions.
  - **R3** stops admitting unswitched standalone rows only when that installation has none left, or when its operator accepts the listed exceptions.
  - The legacy engine core stays and keeps running monitor responses, AI-agent triage, config-policy automations, policy workflows and compliance remediation.
  - Deleting the worker and dropping its tables belongs to a follow-up feature (Decision 1).

**Tech Stack:** TypeScript, Zod 4, Hono, Drizzle (queries only), hand-written SQL migration, Postgres forced RLS, BullMQ, Redis, Vitest, React + Astro + react-i18next (8 locales).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md`. This plan amends the following sections:
- §7: legacy conversion and its quorum amendment.
- §3: the transition statement.
- §6.1: built-ins.
- §6.3 rule 4 and its W4 amendments.
- §6.5 and its W4/W5 amendments.
- §10: the W6 row.

**Related documents:**
- Roadmap row W06: `docs/superpowers/plans/ai-mcp/2026-09-07-tool-catalog-flows-roadmap.md`.
- W05 plan, the as-built base: `2026-10-26-tool-catalog-w5-webhook-tools-budgets.md`, in particular its "W06 handoff". The W05 PR bodies are #10270, #10284, #10285 and #10313.
- Retirement precedent: `docs/superpowers/plans/monitoring/2026-09-19-alerting-consolidation-w05d-retirement.md` and `services/monitors/conversion/*`.
- **Task A0 amends the spec.** Each amendment is marked **Amendment (W6 plan, 2026-10-27)**.

**Dependencies:**
- W05 (#5220) is closed. All four PRs are on main at `757d0c4667`.
- The newest migration on main is `2027-01-08-140000-flow-ai-step-egress-surface.sql`.
- **The orchestrator assigns the migration slot.**
  - Slots held by open PRs: `2027-01-02-140000` (#9445), `2027-01-08-100000`/`100100` (#10064) and `2027-01-08-120000` (#10287).
  - Candidates: `2027-01-09-100000-flow-automation-conversions.sql`, else `2027-01-09-140000-flow-automation-conversions.sql`.
  - This plan refers to it as `<slot>-flow-automation-conversions.sql`.
- PRs D (R2) and E (R3) need no migration at the defaults.

## Global Constraints

- **Rigor: high.** This wave converts customer automations, adds a cross-engine idempotency contract and a fleet pre-approval lane, and stops a live admission path. Each risks a double-fired or dropped automation, or authority that exceeds what was approved.
  - Red test first in every task. A test written after its code does not count.
  - Tasks A5, A6, A7, B2, B3, B5, B6 and E1 get an Opus reviewer. The rest get Sonnet.
- **Tests:**
  - API: `cd apps/api && npx vitest run <file …>` with exact paths. Never `pnpm --filter … test -- --run <path>`. Path filters are substring matches, so list dotted siblings explicitly.
  - Shared: `cd packages/shared && npx vitest run <file>`.
  - Web: `cd apps/web && npx vitest run <file>`.
  - A run that reports 0 tests is a stall, not a pass.
  - On a loaded host, add `--pool=threads --maxWorkers=2` and run at most 8 files per batch.
- **Typecheck:**
  - API: `cd apps/api && NODE_OPTIONS=--max-old-space-size=20480 npx tsc --build tsconfig.tests.json; echo "exit=$?"`. Read `exit=`. Never pipe tsc to `tail`.
  - Shared: `cd packages/shared && npx tsc --noEmit; echo "exit=$?"`.
  - Web: `cd apps/web && npx astro check`, then `pnpm lint`.
- **Integration suites run only under CI "Integration Tests".**
  - Locally: run `pnpm test-stack up` once per worktree, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <file>`.
  - RLS coverage: `cd apps/api && DB_CONTEXTLESS_WRITE_STRICT=true pnpm test:rls-coverage`.
  - Run `pnpm test-stack down` afterwards and say so.
- **Migration (PR A only).** Exactly one file: `apps/api/migrations/<slot>-flow-automation-conversions.sql`.
  - Idempotent: `IF NOT EXISTS`, guarded `DO $$`, and `DROP … IF EXISTS` + `ADD` for every CHECK swap.
  - No inner `BEGIN;`/`COMMIT;`.
  - An explicit `ON DELETE` on every FK.
  - **Every `org_id` FK, and every composite FK that references an `org_id` column, is `DEFERRABLE INITIALLY IMMEDIATE`.**
  - RLS and its policies go in the same file as the table.
  - **No DML.** There is no backfill, so there is no `set_config` line.
  - Run `ls apps/api/migrations | sort | tail -3` before committing, then `pnpm db:check-drift`.
  - **Never edit a shipped migration.** W04/W05 CHECKs that this wave widens are swapped by name in the new file.
  - Executors must not touch any other file under `apps/api/migrations/`.
  - If a later PR needs a migration (only if Todd overrules Decision 8), any row write in it elects system scope first: `SELECT set_config('breeze.scope', 'system', true);`.
- **Registries (grep, don't judge):**
  - `flow_automation_conversions` and `automation_occurrence_claims`:
    - `DUAL_AXIS_TENANT_TABLES` **and** `XOR_OWNERSHIP_DUAL_AXIS_TABLES`. These have the `automations`/`flows` shape: org XOR partner, with a partner-wide read branch.
    - `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`).
    - `CORE_TENANT_EXPORT_POLICY`, every column. Each jsonb column is `excludedOpen`.
    - `orgMergeRegistry.ts`: `REPOINT_TABLES`, beside `automations`.
  - `automations.converted_to_flow_id` needs an export classification (`included`).
  - Neither new table has a `device_id`, `site_id` or `ticket_id` column.
- **Names and values (verbatim):**
  - Conversion states: `shadow | switched | reverted`.
  - Fidelity: `exact | needs_review | unconvertible`.
  - Finding severities: `info | review | blocker`.
  - Claim engines: `legacy | flow`.
  - Occurrence keys: `event:<eventId>`, `schedule:<UTC ISO minute, e.g. 2027-01-09T03:00Z>`, `webhook:sig:<signatureDigest>`, `webhook:dlv:<deliveryId>`.
  - Built-ins: `resolve_targets` (Tier 1), `create_alert` (Tier 2), `run_script_on_targets` (Tier 3).
  - New step error codes: `targets_over_cap`, `targets_unresolvable`, `alert_create_failed`, `script_dispatch_failed`.
  - `automations.retired_reason` values written by this wave: `converted_to_flow` and `legacy_engine_retired`.
  - Constants:
    - `CONVERSION_MIN_SHADOW_MS = 600_000` (10 min). This exceeds the 300 s HMAC window and the 5 min legacy Redis replay TTL.
    - `CONVERSION_SHADOW_MIN_RUNS = 3`
    - `CONVERSION_SHADOW_MIN_MS = 604_800_000` (7 days)
    - `CONVERSION_TARGET_HEADROOM = 400`
    - `FLEET_MAX_TARGETS = 500` (= `FLOW_LIMITS.maxForEachItems`)
    - `SWITCH_LEAD_MS = 60_000`
    - `LEGACY_DRAIN_MIN_MS = 2_592_000_000` (30 days)
- **Feature flag:** conversion requires `FLOWS_ENABLED`. Its default becomes `true` in R1 (Decision 11); the flag is not removed in W06. When it is off:
  - the conversion routes return 404;
  - the converter returns `flows_disabled`;
  - writes to Jobs stay open on that installation (Decision 8).
- **Permissions:**
  - Preview: `automations.read`.
  - Create, switch and revert: `automations.write` + `requireMfa()` + an interactive user session. A partner-wide owner also needs `canManagePartnerWidePolicies(auth)`.
  - Switch additionally runs everything `enableFlow` runs.
  - `run_script_on_targets` uses the `run_script` permission set (rule 7).
  - No new permission rows.
- **AI-tool rules (CLAUDE.md, memory):**
  - No `z.undefined()` in any tool schema.
  - `SAFE_WRITE_SITES` and the route-binding contracts are keyed by line. Re-key them; never delete entries.
  - Classify each new `services/*` file in `parkedFanout.contract.test.ts`.
  - New route files fall under area-gating (Lint) and `site-scope-coverage`.
  - **The three new built-ins are not AI tools.** `MCP_TOOL_COUNT_APPROX`, `mcp-coverage` `FROZEN_GAPS` and the W19 tool-index budgets must not change. Task C5 asserts each one.
- **Public repo:** no customer names, hostnames, IPs or real webhook URLs. Census output never enters the repo (Task A8).
- **Branches and PRs:**
  - PR A: `feature/5215-tool-catalog-flows/wave-5221`, branched off fresh `origin/main`.
  - PR B: `…/wave-5221-cutover`, after A merges.
  - PR C: `…/wave-5221-web`, after B merges.
  - PR D: `…/wave-5221-freeze` (R2). PR E: `…/wave-5221-retire` (R3). Each is dispatched by the orchestrator when its release gate holds.
  - No stacked PRs. If the orchestrator stacks one anyway, run `gh workflow run CI --ref <branch>`.
  - Merge with a bare `gh pr merge <N>`. Never use `--admin`.
  - Feature-lifecycle: `start_wave` before A0; `complete_wave` per Decision 8.

## Legacy inventory (origin/main `757d0c4667`)

**Who runs on the legacy engine.** The spec's §7 maps `ai_triage → ai`, but on main every `ai_triage` action sits on an agent-managed row, and monitors (2026-09-08) now compile into automations. Classes are assigned in this order; the first match wins. Monitor compilation can set **both** managed ids (`monitorCompiler.ts:~219`), so M is tested before A.

| Class | Predicate (first match) | Writer | Runs through | W06 |
|---|---|---|---|---|
| **M** monitor-compiled | `managed_by_monitor_id IS NOT NULL` | `services/monitors/monitorCompiler.ts` | `trigger-event` (response-owner CAS, episodes, `subjectResponseOutbox.ts`; `scan-schedules` also drains that outbox, `automationWorker.ts:~1328`) | stays |
| **A** AI-agent triage | `managed_by_agent_id IS NOT NULL` | `services/aiAgents/managedAutomation.ts` | `trigger-event`, child agent run, `automation-agent-run-terminal` | stays |
| **P** policy workflow | `trigger->'filter' ? '_policyWorkflow'` | `services/monitors/conversion/workflows.ts` | `trigger-event` + `policyWorkflowApplies` | stays |
| **S** standalone Job | everything else with `retired_at IS NULL` | `routes/automations.ts`; `manage_automations` (enable/disable/run) | schedule scan → `trigger-schedule`; event fan-out → `trigger-event`; `POST /automations/webhooks/:id`; `POST /:id/trigger\|run` → `execute-run` | **converted** |
| **C** config-policy automation | rows of `config_policy_automations` (feature type `automation`, still live in `CONFIG_FEATURE_TYPES`) | `manage_policy_feature_link`, policy `AutomationTab` | `trigger-config-policy-schedule`, `execute-config-policy-run` | stays (not an `automations` row) |

**R is a dependency, not a class.** Two remediation consumers in `services/policyEvaluationService.ts` pick an S row:
- Compliance policies, `resolvePolicyRemediationAutomationIdForOrg` (~L1204). It takes an explicit `rules.remediationAutomationId`, **or any** enabled non-retired row of the org whose `run_script` uses the policy's `remediationScriptId`.
- Config-policy compliance, around L2128, using the same script match.

Both insert `automation_runs` directly (~L1455, ~L2178) instead of calling `createAutomationRunRecord`. An S row that is such a target is "S+R" (Decision 16).

**The S surfaces:**
- **Tables:** `automations`, `automation_runs`, `automation_run_device_results`, `automation_action_results`, `automation_resource_bindings` (`db/schema/automations.ts`).
- **Queue:** `automations` (`automationWorker.ts:88`).
- **Jobs:** `scan-schedules` (60 s repeat, not in `scheduleRegistry`), `trigger-schedule`, `trigger-event`, `execute-run`.
- **Event subscribers:** `automation-worker` (`'*'`) and `automation-agent-run-terminal`.
- **Worker:** `services/workerRegistry.ts:437` `automationWorker` (`socket-owner`).
- **Routes** in `routes/automations.ts`: GET `/`, `/runs/:runId`, `/:id`, `/:id/runs`; POST `/`, `/runs/:runId/cancel`, `/:id/trigger`, `/:id/run`; PUT/PATCH/DELETE `/:id`.
- **Public webhook:** POST `/automations/webhooks/:id`. It uses HMAC with `x-breeze-signature`/`x-breeze-timestamp` and delivery id `x-breeze-event-id`/`x-breeze-nonce`. Plain-secret headers are gated by `AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET`. The Redis replay key is `automation-webhook-replay:<automationId>:<digest>` with a 5-minute TTL.
- **Partner API:** GET `/partner-api/automations`.
- **MCP resource:** `breeze://automations`.
- **AI:** `manage_automations` (`aiToolsFleet.ts:~2269`). Tier 1 list/get/history; Tier 2 enable/disable; Tier 3 run.
- **Web:** `/jobs` (`components/automations/*`); `/automations*` returns 301 to `/jobs`; strings live in the `scripts` locale namespace.
- **Env:** `AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET`, `AUTOMATION_WEBHOOK_ALLOW_LOCAL_REPLAY_FALLBACK`.
- **Encrypted column:** `automations.trigger` (the webhook secret, `encryptedColumnRegistry.ts:79`).

**Shared code that stays for every class:**
- `execute-run`, `createAutomationRunRecord`, `executeAutomationActionsInOrder`.
- The action-result ledger and its terminal writers (`applyAutomationActionTerminal`, `applyCommandAutomationTerminal`), called from the command, script, deployment and cancel paths.
- Episode outcome updates (`automationActionResults.ts:~600`).
- Run cancellation, and the resume path that deliberately does not recheck `enabled` (`automationRuntime.ts:~4195`) and re-reads source actions (~L4228).
- `scan-schedules` (outbox drain).
- `script_executions.automation_run_id`.

## Conversion map (legacy → flow)

Legacy executes **action-major**. All active devices run action 0, then action 1, and so on. A device whose action fails under `stop`/`notify` is dropped from later actions; the run continues for the others. A `deploy_software` batch runs at its own action index (`automationRuntime.ts:~3569`). Spec §7's "deployment after the for-each" is stale.

| Legacy element | Flow equivalent | Fidelity, and what happens when there is none |
|---|---|---|
| trigger `schedule {cron, timezone}` | trigger `schedule {cron, timezone}`. A converted flow's tick uses **UTC occurrence keys** (Decision 6) | Exact when `isStructurallyValidCron` accepts the expression and the next 400 occurrences (over a span that crosses both DST transitions) match between legacy `isCronDue` and the flow scheduler. Otherwise a `cron_semantics_differ` **blocker**. Flow "latest occurrence within 24 h" fires the newest missed occurrence after an outage; legacy fires nothing. Info finding `schedule_outage_catch_up`. |
| trigger `event {event, filter}` | trigger `event {event, filter}` | Number and boolean expectations are exact: legacy compares them strictly too. A **string** expectation is `event_filter_string_coercion` **review**: legacy compares `String(actual ?? '')`, flows compare strictly, and only the operator can say whether the field is always a string. A `null` expectation is `event_filter_null` **blocker**: legacy separates null from missing, flows do not. Arrays, objects, more than 20 keys, or a key outside `EVENT_FILTER_KEY_RE` are `event_filter_not_strict` **blocker**. |
| `event.durationMinutes` | none | The runtime ignores it today. Dropped, with info `duration_minutes_ignored`. |
| event trigger without durable dispatch | none | `event_dispatch_not_durable` **blocker** (W04 Decision 10 unchanged). |
| trigger `webhook {secret}` | trigger `webhook {auth: 'hmac'}` + the carried secret | The secret is decrypted with the automations column spec and re-encrypted under the flow row AAD in the switch transaction, before enable. That binds it to the switched publication; a later rotation or re-publish follows the W05 rules. The legacy URL forwards into flow ingest. Legacy `x-breeze-event-id`/`x-breeze-nonce` become `X-Breeze-Delivery-Id`. Flows accept only JSON-object bodies, so `webhook_body_shape` **review** is raised. Plain-secret senders raise `legacy_secret_header_possible` **review** while `AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET` is on. Info `webhook_url_changes`. |
| trigger `manual` | trigger `manual` | Exact. Pre-approvals are honoured for UI runs only (W04 Decision 4). |
| conditions as a target config `all\|devices\|groups\|filter`, or the legacy array `[{type: site\|os\|group\|tag, operator, value}]` (empty array = every device) | the `target` or `conditions` input of `run_script_on_targets`, or a `resolve_targets` step when no script action comes first | Exact: the same resolver (`resolveAutomationTargetsDetailed`) runs in the run org, once per execution, deduplicated, with diagnostics kept. A legacy condition of unknown `type` (legacy treats it as `true`) is `condition_unknown_type` **blocker**. |
| event automation whose payload carries `deviceId` | `deviceIds: ['{{trigger.device.id}}']` | Exact. `trigger.device` exists only for a device in the run org (`triggerScope.ts`). |
| more than 400 current targets | none | `targets_over_cap` **blocker** at conversion. Above 500 at run time the step fails `targets_over_cap`; it never truncates. |
| partner-wide automation | partner-wide flow, one run per live org (≤ 500) per occurrence | Legacy spans every owner org in one run. Flows skip suspended/deleted orgs, the holding org and orgs beyond the first 500. `partner_wide_org_set_differs` **review**, or **blocker** when the partner has more than 500 orgs. A `groups` target is already broken in legacy (`PARTNER_WIDE_GROUP_TARGET_PROBLEM`): `partner_wide_group_target` **blocker**. |
| action `run_script {scriptId, parameters, runAs, whenOffline}` | step `a<i>_run_script`, built-in `run_script_on_targets` with the same fields and the action's selector | Exact dispatch semantics. The built-in reuses the legacy dispatch guarantees (Task A5). An **effective** `elevated` run context is `run_as_elevated` **blocker**. That covers both an explicit `runAs` and inheriting the saved script's value. Pre-approval uses the fleet lane (Decision 5). A webhook trigger never honours pre-approval: `approval_each_run` **review**. |
| action `execute_command {command, shell}` | a generated owner-scoped library script + `run_script_on_targets` | `command_becomes_script` **review**. No shell plus a mixed-OS target set is `command_mixed_os` **blocker**, because legacy picks a shell per device OS (`chooseShellForDevice`). |
| action `execute_command {kind: 'restart_service'}` | none | `restart_service_monitor_only` **blocker**. |
| action `send_notification` | step `notify` under `forEach` over the active device set | Legacy sends one notice per device. The defaults are title `<name> notification` and message `Automation <name> executed on <hostname>` (`automationRuntime.ts:~2136`); the converter writes the same text using `{{item.hostname}}`. Severity mapping: critical→critical; high and medium→warning; low and info→info (info `severity_mapped`). Active devices × notify actions over 20 (W05 per-run cap) is `notify_per_run_cap` **blocker**. `webhook`/`pagerduty` channels convert via Decision 15. |
| action `create_alert` | `create_alert` under `forEach` over the active device set | Exact. The extracted legacy writer is used. |
| action `deploy_software` | none in W06 | Legacy calls `createSoftwareDeployment`, a different model from `manage_deployments`, at its own action index. `deploy_software_unmapped` **blocker** (Decision 18). |
| action `ai_triage` | none | Only class A rows carry it. |
| the active-device set between actions | the next step's selector/items is the previous fleet step's `succeededDeviceIds` (under `stop`/`notify`) or its `dispatchedDeviceIds` (under `continue`) | Exact: action-major with per-device stop, as in legacy. |
| `onFailure: notify` + `notificationTargets.channelIds` | device steps run `continue`; after each device action, a `notify` step per channel runs under `forEach` over that step's `failedDeviceIds` (title `<name> action failed`, severity `warning`, `when: length(steps.<id>.output.failedDeviceIds) > 0`). The active set narrows exactly as under `stop` | Exact up to the per-run cap. Failed devices × channels over 20 is `failure_notice_cap` **review**: the excess notices fail visibly. `notificationTargets.emails` is unused by the legacy runtime and is dropped with info `notification_emails_unused`. |
| dispatch is success (`automationRuntime.ts:1075`) | the same: `run_script_on_targets` reports dispatched/queued | Info `queued_is_success`. Spec §7's `awaitCompletion: false` is unnecessary. |
| creator's site ceiling, re-derived each run (`automationWorker.ts:~524,~744`) | none. A flow delegator is unrestricted by construction | When the creator now has a site ceiling, `site_ceiling_removed` **review**. The switch dialog shows it as a widened scope that the switching user must accept. |
| monthly volume | W05 caps | The converter estimates runs per month: from the cron for schedules, from the last 30 days of `automation_runs` otherwise. Above `resolveFlowLimits(owner).monthlyRunsPerFlow` is `monthly_cap_exceeded` **blocker**. Above 80 % of the owner cap is `owner_cap_pressure` **review**. |
| `managed_by_*`, `_policyWorkflow`, `retired_at`, a live `monitor_conversions` row | none | `managed_row` / `policy_workflow` / `already_retired` **blocker**. |
| an S+R row | none | `compliance_remediation_target` **blocker** (Decision 16). |
| `name`, `description` | `name` ≤ 120 (`name_truncated` **review**); `description` + "Moved from Job <name>"; slug via `takenFlowSlugs` | — |

## Open Decisions (Gate B)

Each decision lists the plan's default in **[brackets]**. The tasks are written to that default. Todd may overrule any decision before execution; the affected tasks are named. Quorum positions are in § Quorum.

1. **Scope: "standalone admission retirement", not worker retirement.** **[W06 converts class S only. Classes M, A, P and C, and the R dependency, stay on the engine core. W06 stops admission for standalone rows: their scan and fan-out branches, the public legacy webhook route for unswitched rows, and the manual-run routes. Every shared execution path (inventory) stays. A follow-up feature, "Managed responses on flows", re-targets M, A, P, C and R onto flows. Only that feature deletes `automationWorker`, the `automations` queue, `scan-schedules` and the tables.]**
   - Each managed class depends on behaviour that flows do not have yet: the response-owner CAS and outbox (M), agent-run correlation (A), fire-time config-policy assignment (P, C), and implicit script-match remediation (R).
   - Alternative: hold W06 until every class moves. That makes it a five-wave feature.
   - Affects every task and the close-out list.
2. **Conversion mode.** **[Opt-in, per automation and in bulk per owner. "Convert" or "Convert all convertible" creates shadow conversions only. Switching is always a separate interactive step: per row, or a bulk switch of selected `exact` rows by one user. R2 pre-creates shadow conversions; it never switches. No automatic switch at any release.]**
   - `enableFlow` requires an interactive session before it looks up anything (`versions.ts:229`). An auto-switch would need a separately designed migration grant, explicitly authorized by a human and bound to the reviewed content. That is out of scope.
   - Affects B1, B3, C2, D2.
3. **Shadow period and parity measurement.**
   - **What shadow evaluates.** Creating a conversion starts its shadow. Shadow never executes anything twice and creates no flow runs. Legacy-side hooks evaluate the converted document and record counters plus the last divergence:
     - trigger match in **both** directions, for every event of the trigger's type in the fan-out;
     - the target set against the legacy resolution;
     - would-park: Tier-3 steps that would park under the honour rule and the switch defaults (no pre-approval until the user ticks it);
     - over-cap.
   - **Reset.** The counters reset whenever the source digest or the draft document digest changes.
   - **[The switch is offered when all three hold: `shadow_runs ≥ 3`, zero divergences, and the shadow is at least 7 days old. Idle days never count. Otherwise the switch requires `acknowledgeDivergence: true`, which is recorded and shown. In every case the shadow must be at least `CONVERSION_MIN_SHADOW_MS` (10 min) old, because claims must cover the HMAC and replay windows (Decision 6).]**
   - **Effect parity is proven in CI.** `automationFlowParity.integration.test.ts` (Task B7) is the spec §7 parity test. It diffs effect traces from both engines, including positive and negative trigger cases and injected per-device failures.
   - Affects A8, B4, C2.
4. **Owner and delegator.** **[The owner is exactly the automation's owner axis (Partner-Wide First). The delegator is the interactive user who clicks Switch, recorded as `flows.enabled_by_user_id`, under every `enableFlow` check. `created_by` is never a delegator. In the switch dialog the user must affirmatively accept:]**
   - each pre-approval (unticked by default);
   - each widened scope (`site_ceiling_removed`);
   - the delegator lifecycle: a deactivated or narrowed delegator pauses the flow (W04 Decision 7), whereas a legacy row did not stop in that case;
   - each generated script, shown with its body.
   - `requireMfa` satisfies the tenant MFA policy; it is not a fresh second factor (quorum Q5). That is acceptable for the same reason `enableFlow` accepts it.
   - Affects B3, C2.
5. **Tier class and the fleet pre-approval lane.** **[Tiers are never lowered for converted flows. `run_script_on_targets` is Tier 3; its approval scope is derived from the script, not hard-coded. A converted script step runs unattended only through a new **fleet lane** of W04 rule 4.]**
   - **Eligibility:**
     - the step has no `forEach`;
     - `scriptId` is literal;
     - `parameters` are literal;
     - the script snapshot has no tenant-variable reference in its content or parameter bindings (`runScriptSnapshot.ts:~172`);
     - the effective run context is not `elevated`;
     - the scope is supervised;
     - the selector is a literal `target`/`conditions`, a `fromStep` reference to an earlier eligible fleet step, or exactly `['{{trigger.device.id}}']`;
     - the enabling user enters a `maxTargets` between 1 and 500.
   - **The versioned binding** (`kind: 'fleet_v1'`) covers:
     - publication, step, tool and owner scope;
     - the executable snapshot material;
     - canonical parameters and the effective run context;
     - the offline policy and delivery deadline;
     - the selector kind, its canonical definition and, for a dynamic (filter) group, the group's definition digest;
     - `maxTargets`.
   - **Revalidation before the first dispatch.** Any change is `binding_drift`, which pauses the flow. A resolved count above `maxTargets` is also `binding_drift`. So are lost delegation, a foreign reference, or a device the run org does not own.
   - **Where the cap applies, and what is live.** The cap applies **per step, per run, per execution org**. The card states that a partner-wide flow multiplies it by the org count. Membership resolves live, once per execution, then is deduplicated and checked, and only that set is dispatched. The card discloses that whoever can edit a static group's membership can retarget it.
   - **Honour rule unchanged:** schedule, event and UI runs only; never webhook or tool runs (W05 Decision 4).
   - **When the step parks without pre-approval.** The intent **freezes the device id list** at creation. The approver sees the exact devices, and release dispatches exactly those.
   - **Release plumbing.** Release must carry the verified snapshot and the checked device set through `executeReleasedFlowBuiltin` into dispatch. Today's W05 branch drops it (`intentReleaseWorker.ts:~1589`), which reopens the TOCTOU window. Task A6 fixes this for every built-in.
   - **Alternative, for Todd:** honour pre-approval on webhook runs when the selector is literal, so the sender cannot choose devices. Deferred: it reopens W05 Decision 4.
   - Affects A1, A5, A6, B3, C2.
6. **Idempotency across the cutover.**
   - **[Durable claims decide who wins.** `automation_occurrence_claims` (automation-wide, independent of engine and generation) has a unique key `(automation_id, occurrence_key)`. A claim is inserted **in the same transaction as the run admission** on each engine:
     - legacy admission (`admitTriggerSchedule`, `admitTriggerEvent`, the webhook route, the manual routes);
     - flow `createFlowRun` through its W05 `onCreated(tx)` hook.
     - A conflict returns `duplicate` with the existing run linkage.
     - Webhooks insert both aliases, `webhook:sig:<digest>` and `webhook:dlv:<id>`. Either conflict is a duplicate.
     - Admission history from before the claims exists in `automation_runs (automation_id, occurrence_key)` (`event:<id>`, `schedule:<slot>`). The flow side checks it in the same transaction. Pre-conversion legacy webhook history lives only in Redis for 5 minutes, so the minimum 10-minute shadow guarantees that every legacy webhook admission an identical redelivery could still reach was claimed. Legacy writes claims for any row that has a conversion in any state. It reads the conversion state with `FOR SHARE` on the automation row; creating a conversion takes `FOR UPDATE`.
   - **Preference decides who attempts.** It is a function of the generation state that the attempting engine observes, plus the occurrence's stored instant:
     - **Legacy attempts:** every job its fan-out or scan enqueued while the row was not switched, and, for a switched row, any occurrence whose instant is before `switch_at`.
     - **The flow attempts:** everything it sees while its generation is `switched`.
     - **After a revert:** legacy attempts everything it sees, and the reverted flow attempts nothing new.
   - **The legacy engine keeps loading switched rows** in the scan, fan-out and admission until standalone admission retirement on that installation (Decision 8). There is no time window.
   - **Instants:**
     - Event: `metadata.timestamp`. A missing or invalid timestamp prefers legacy on both sides (deterministic, with a Sentry report).
     - Schedule: the occurrence's UTC minute.
     - Webhook: the signed `X-Breeze-Timestamp`.
   - **`switch_at` is `now() + SWITCH_LEAD_MS`, written in the same transaction that enables the flow.**
   - **Schedules:**
     - A converted flow's tick uses **UTC occurrence keys**, so a DST repeated hour fires twice, as in legacy.
     - The tick writes the **parent** claim `schedule:<utc>` before fanning out per org; children use W04's per-org dedupe and retry and never reassign ownership.
     - Enable stamps only occurrences at or before the commit. Those are earlier than `switch_at`, and legacy prefers them.
     - The tick never consumes an occurrence at or after `switch_at` without attempting it.]**
   - **Guarantee, stated exactly:** conversion adds no duplicate admission and no dropped occurrence, with these residuals:
     - (a) a webhook sender that **re-signs** a retry with a fresh timestamp **and no delivery id**. Legacy today has the same exposure.
     - (b) an event published before the switch commits, carrying a publisher-supplied `occurredAt` later than `switch_at`, and delivered to the flow subscriber before the commit. `publishEvent` reports `occurredAt > now + 60 s` to Sentry.
     - (c) occurrences that W05 caps or the flow queue refuse. Those are a flow behaviour, not a conversion artefact.
   - Quorum Q2 and Q7 shaped this decision (§ Quorum).
   - Affects A2, B2, B5, B6.
7. **Rollback.** **[`POST /api/v1/flows/conversions/:id/revert`, available until the R3 gate closes it on that installation. In one transaction it:]**
   - re-enables the legacy row (clears `retired_*` and `converted_to_flow_id`);
   - marks the generation `reverted` with `revert_at`;
   - closes the flow's **admission** at once (the flow attempts nothing new; claims dedupe everything).
   - **[It does not disable or cancel the flow's work.]** The pinned publication keeps its **execution** authority, so admitted, parked and approved runs finish. Approval TTL can reach 7 days.
   - The reconciler sets the flow `disabled` (cancelling nothing) only when the generation has been reverted for longer than `LEGACY_DRAIN_MIN_MS` **and** the flow has no non-terminal run or open intent.
   - The legacy row cannot be edited while switched, so revert returns it as it was. A reverted generation is terminal; converting again creates a new generation and a new flow. A switched flow cannot be deleted (`flow_converted_from_automation`).
   - Affects B4, E1.
8. **Retirement sequence and table drops.**
   - **[R1 = PRs A–C.** Converter, built-ins, fleet lane, claims, shadow, switch/revert, forwarding and UI. `POST /automations` returns `410 automations_moved_to_flows` **only when flows are enabled on the installation**.
   - **R2 = PR D, at least one release after R1:**
     - Standalone writes return 410 except disable, delete, preview and convert: PUT, PATCH, `/:id/trigger`, `/:id/run`, and `manage_automations` enable/run. The exception is a row blocked by its environment (`flows_disabled`, `event_dispatch_not_durable`), which stays writable.
     - A boot sweep (W05d precedent; opt-out `FLOW_CONVERSION_SWEEP_DISABLED`) pre-creates shadow conversions.
     - A startup count check reports at error level and to Sentry.
     - The Jobs banner lists pending rows.
   - **R3 = PR E, per installation.** At boot the census decides:
     - When this installation has zero enabled unswitched S rows, **or** its operator set `LEGACY_JOBS_RETIREMENT_ACCEPTED=true`, standalone admission for **unswitched** rows stops.
     - With the flag, a sweep disables each listed row with `retired_reason = 'legacy_engine_retired'`, an audit event and one in-app notice per owner. S+R rows are kept.
     - With neither condition met, nothing changes and the startup error repeats.
     - Admission for **switched** rows' legacy-preferred occurrences continues until the operator's acceptance also covers abandoned historical occurrences, or the switched generations are older than `LEGACY_DRAIN_MIN_MS`. Both conditions are logged.
     - Revert closes. The legacy webhook URL returns `410` for unswitched rows and keeps forwarding for switched ones.
     - **No code is deleted in W06.** The S branches become dead behind the gate and are deleted with the worker by the follow-up feature.
   - **No `automation_*` table or column is dropped in #5215.]**
   - **Drop sequence recorded for the follow-up feature**, each step needing its own Gate B and its export-policy, cascade, merge and `rls-coverage` removals in the same PR:
     1. Clear the content of retired rows (`trigger/conditions/actions/notification_targets`).
     2. Drop `automation_occurrence_claims` after drainage.
     3. Drop the tables.
     4. Drop the `automation_*` enums.
   - **When #5221 closes:** W06's "one engine" is met for user-authored automations when R3 holds on hosted. Todd decides whether #5221 closes at PR C (D and E tracked as `wave` sub-issues) or at PR E.
   - **Alternative:** hosted-only gating with forced disable everywhere (rejected by quorum Q4). A hosted count cannot establish local facts.
   - Affects C5, D, E.
9. **API, routes and AI tools.** **[R1:]**
   - GET `/automations`, `/automations/:id`, `breeze://automations` and `GET /partner-api/automations` gain an additive field, `conversion: { id, state, flowId } | null`. The Partner API compat rule allows additive fields only.
   - A switched row is frozen. PUT/PATCH/DELETE/trigger/run return `409 automation_converted { flowId }`. DELETE is refused because in-flight legacy runs re-read the source on resume.
   - Editing a shadow row changes its digest and resets the shadow.
   - `manage_automations`: list/get/history show the conversion; enable/run on a converted row return `automation_converted`; one sentence in its description points to flows.
   - **R2:** the writes in Decision 8 return `410`.
   - **R3:** see Decision 8. Reads stay. A 410 body is `{ error, flowsUrl }`. There are no API redirects.
   - Affects B1, B7, C5, D1, E1.
10. **UI migration and copy.** **[The Jobs page (`/jobs`) gains:]**
    - a "Move to Flows" column with fidelity badges: **Exact**, **Needs review**, **Can't move yet** (with the blocker in words);
    - a per-row conversion panel (hash `#convert-<automationId>`) with the step list (`FlowStepList`), findings, shadow counters and Switch;
    - the switch dialog (Decision 4), including the per-step `maxTargets` field and the frozen-device wording;
    - Revert;
    - a banner per release:
      - R1: "Jobs are moving to Flows."
      - R2: "Jobs can't be changed any more. Move them to Flows."
      - R3: "N jobs were turned off" or "Jobs still run here until they are moved."
    - "New job" opens Flows. The flow detail shows "Moved from Job <name>".
    - Every string is in all 8 locales.
    - Affects C1–C4.
11. **Self-hoster release notes (required content).** **[R1:]**
    - `FLOWS_ENABLED` defaults to `true`. Setting it to `false` keeps flows off, and Jobs stay writable.
    - Event-triggered Jobs convert only with `EVENT_DISPATCH_MODE=enforce` and `flow-event-trigger` in `EVENT_DISPATCH_QUEUE_SUBSCRIBERS`. Give the exact lines.
    - Webhook senders keep the old URL until R3. The new URL accepts JSON objects only. Plain-secret senders move to `X-Breeze-Webhook-Token`.
    - List the blockers.
    - **R2:** Jobs become read-only. The pre-create sweep and its opt-out. The startup error.
    - **R3:** the per-installation gate, `LEGACY_JOBS_RETIREMENT_ACCEPTED` and what it disables, the S+R rows that are kept, the 410 for unswitched webhook URLs. No data is deleted.
    - **[Each note goes under its own heading in `docs/release-notes/next-release-draft.md` (append only), and into the GitHub Release body via the `release` skill.]**
    - Affects C4, D3, E3.
12. **PR split.** **[Five PRs, three releases:]**
    - **PR A** (A0–A8): spec, shared, migration + registries, built-ins, fleet lane, converter, shadow evaluator, census.
    - **PR B** (B1–B7): service/routes, claims on both engines, switch, revert, schedule UTC mode, webhook forwarding, frozen rows + integration + parity.
    - **PR C** (C1–C5): web, docs, default, R1 create refusal.
    - **PR D:** R2.
    - **PR E:** R3.
    - Each PR keeps CI green on its own: B and C only add callers of earlier seams.
13. **Built-ins instead of new core tools.**
    - **[`resolve_targets` (Tier 1, `devices.read`), `create_alert` (Tier 2, `alerts.write`) and `run_script_on_targets` (Tier 3, the `run_script` permission set) are flow built-ins in `FLOW_BUILTIN_STEPS`, not `aiTools` entries.]**
    - Built-ins never reach chat, MCP or the tool index (W03 amendment). W05 B2 already gives them rule 7, revalidation and Tier-3 parking.
    - Spec §7 calls for "a `create_alert` core tool". **Quorum Q3 disagreed** and wants the spec followed unless amended for a behavioural reason. The author's behavioural reason: a chat/MCP alert-creation surface would let models raise alerts that the alert inbox and escalation policies treat as monitoring signal, which is a product decision of its own. Conversion does not need it. Recorded for Todd.
    - Every new built-in gets explicit owned-reference checks: the generic rendered-reference checks cover core tools only (`flowValidator.ts:~537`).
    - Affects A1, A3, A4, A5.
14. **`execute_command`.** **[It becomes a generated owner-scoped library script, created in the switch transaction by the switching user through the normal script-create path, then `run_script_on_targets`.]**
    - Name: `Moved from Job "<name>" — command <n>`. Language from the legacy shell.
    - With no shell, a single-OS target set uses that OS's legacy default; a mixed-OS set is a blocker.
    - Alternative: a Tier-3 `run_command` built-in. It would be a second device-effect path.
    - Affects A7, B3.
15. **`notify` gains `webhook` and `pagerduty` channels.** **[Yes. This narrowly reopens W05 Decision 14. `sendChannelMessage` adapts the existing alert-shaped senders. A PagerDuty send triggers with dedup key `flow:<runId>:<stepId>:<itemIndex>`. The channel holds the credentials; the document never does.]**
    - Quorum Q3 notes that the W05 handoff said otherwise and that this needs its own decision. This is that decision.
    - Alternative: keep the refusal. Every Job that pages someone then stays on legacy indefinitely.
    - Affects A3.
16. **S+R rows (compliance remediation targets).** **[Blocked from conversion: `compliance_remediation_target`. The classifier covers both consumers and the script-match rule. R2 still freezes the rows. R3 never disables them. The follow-up feature points remediation at flows.]** Affects A7, D2, E2.
17. **Event-filter semantics.** **[String expectations are `review`, so the operator confirms. `null`, arrays and objects are blockers. W06 does no `when` rewrite.]** The census (Task A8) measures the impact before any coercing filter mode is considered. Affects A7.
18. **Fleet size, deployment and caps.** **[W06 raises no limit. The converter refuses more than 400 current targets; above 500 fails at run time. `deploy_software` is a blocker in W06.]**
    - The deployment model differs (`createSoftwareDeployment` against `manage_deployments`), and there is no deployment pre-approval lane.
    - Monthly-cap blockers use W05 limits.
    - Affects A7.
19. **Deferred, named and not silently dropped.** **[Not in W06:]**
    - classes M, A, P and C, and the R dependency (Decision 1);
    - the deployment conversion and a deployment lane;
    - webhook pre-approval for literal selectors;
    - coercing event filters;
    - raising the for-each and fleet cap;
    - an automatic-switch migration grant.
    - Carried from W05 Decision 17: the policy-decidable lane, live variable pinning, a per-publication site ceiling, event-origin attribution, act-asset kind `flow` and agent Tier ≥ 2 calls, a credential grant for `http_request`, and third-party webhook loops.
    - Carried from the W05 PR bodies:
      - the webhook-secret minter residual (#10270);
      - tenant Tier-3 steps without an `externalTool` binding (#10284);
      - agent exposure failures not noted on the run, and MCP flow-tool refusals not audited (#10285).
    - Carried from W04: approver names on the timeline, a `flow.run.*` outbox, intents pending at run end, survivor-org erasure, the `previewOrgMerge` run count, and the `runSlice.ts`/`runService.ts` splits.
    - All of these are in the close-out list.

## Quorum

Two Codex rounds were run at `xhigh` (gpt-6-astra, read-only, prompt via stdin, 2026-10-27). Each round stated the author's positions. Every citation the plan relies on was re-read in source before acceptance:
- `preApproval.ts:79`: a `forEach` step is never eligible.
- `automationRuntime.ts:~3569`: legacy runs action-major with per-device stop, and deploys at the action index.
- `aiToolsScripts.ts:~695,~737`: core `run_script` rejects offline devices, waits up to 60 s per command, and ignores `runAs` for unattended dispatch.
- `notices.ts`: notices cover pause, unknown-outcome and cap only.
- `eventBus.ts:~382`: publishers can supply `occurredAt`.
- `automationWorker.ts:~1328`: `scan-schedules` drains the monitor outbox.
- `policyEvaluationService.ts:~2128`: a second remediation consumer.
- `intentReleaseWorker.ts:~1589`: the built-in release drops the verified context.
- `flowScheduleTick.ts`: local wall-clock keys and latest-only.

The full outputs stay outside the repo. This section is recorded again in Task A0's §11 row and in each PR body.

| # | Author position | Codex | Outcome |
|---|---|---|---|
| Q1 scope | Convert S only; M/A/P/C stay; retire the S branches; follow-up feature for full retirement; no drops | **Agree with conditions:** M and A overlap, and P matches a null-managed predicate; R is a dependency of S with **two** consumers that insert runs directly; `scan-schedules`, outbox drain, result handlers and the resume path must stay; §7 does mention `ai_triage`; call it "standalone admission retirement" | All adopted: ordered classifier, R as a dependency, retained paths listed, renamed (Decision 1, inventory) |
| Q2 cutover v1 | Timestamp partition + a ±5 min claim table + 24 h legacy visibility + webhook byte forwarding | **Disagree:** timestamps can be supplied and redelivered late; a claim must commit with the run; schedule identities differ; partner-wide needs a parent occurrence; forwarding needs compatibility admission; revert is asymmetric | Replaced by v2 (Q7) |
| Q3 fidelity | Converter map with a `forEach` + `run_script` pre-approval, deploy after the loop, `notices` for failures, strict scalar filters "exact", shadow as the parity signal, `create_alert` built-in | **Disagree:** `forEach` is never pre-approvable; legacy is action-major with per-device stop; deploy model differs; core `run_script` rejects offline devices and ignores `runAs`; notices miss failures; string and null filter semantics differ; shadow alone is insufficient and idle days must not qualify; follow the spec on `create_alert` | Adopted, except one item: new `run_script_on_targets` with legacy dispatch semantics and active-set chaining; deploy is a blocker; failure notices as explicit `notify` steps; string filters review, null blocker; shadow reset on digests, idle never qualifies, CI effect-trace parity with failure injection; monthly-cap findings. **Not adopted:** `create_alert` stays a built-in, with a stated behavioural reason (Decision 13) and **the disagreement recorded for Todd** |
| Q4 retirement | R2 auto-switch of exact Tier ≤ 2 rows using `created_by`; R3 hosted-gated forced disable; `FLOWS_ENABLED` default flip as a prerequisite | **Disagree:** `created_by` is not an enable authorization; exact ≠ operating parity (caps, dispatch); gate R3 per installation and on drainage; freeze switched sources; flipping the default is a rollout choice; writes must stay open where flows or durable events are unavailable | All adopted: no auto-switch ever (Decision 2); R3 per installation with explicit operator acceptance covering historical occurrences; switched rows frozen including DELETE; writes stay open when blocked by environment (Decision 8). The default flip is kept as a rollout choice (Decision 11) |
| Q5 authority | Owner axis kept; switching user as delegator; pre-approvals default ON where legacy ran unattended | **Agree with conditions:** affirmative acceptance of each pre-approval and widened scope; disclose the delegator lifecycle; bind the carried secret to the switched publication; no `forEach` pre-approval | All adopted (Decision 4, the conversion map webhook row, Decision 5) |
| Q6 fleet lane | `run_script_on_targets` + fleet pre-approval with `maxTargets` | **Agree with conditions:** keep the `forEach` prohibition; cap per step/run/org, disclosed multiplication; refuse **effective** elevated; a new binding helper covering the full execution contract including snapshot material and variable references; explicit ownership checks with the run org; live membership with disclosure, a pinned dynamic-group definition, resolve once and dispatch the checked set; freeze devices for parked approvals; mandatory effect digest and coverage; derive the approval scope; **carry the verified snapshot through built-in release**; extract device locks, fences and durable per-device outcomes (64 KiB result truncation) | All adopted (Decision 5; Tasks A5, A6) |
| Q7 cutover v2 | Append-only generations, interval routing, unbounded legacy loading, revert flow admitting 8 days, routing webhooks by signed time, per-installation retirement | **Disagree as stated:** an unchanged occurrence can change owner after executing (future timestamps, identical signed webhook); a stable delivery id still double-fires across namespaces; DST and latest-only lose occurrences; partner-wide needs a parent claim; 8 days is not a horizon, and disabling breaks parked approvals; timestamps can change on republish; **a durable automation-wide claim is required**; zero rows ≠ drainage | All adopted (Decision 6, Decision 7, Decision 8): an automation-wide claim table written atomically with admission on both engines, aliases for webhooks, legacy history read from `automation_runs`; UTC keys + parent claims + a cutover-aware cursor; revert closes admission and keeps execution authority; drainage gate. **Residuals stated, not resolved:** (a) a re-signed webhook retry with no delivery id; (b) a pre-commit, future-`occurredAt` event delivered only to the flow subscriber; (c) cap/queue refusals |

Codex's top risks, each now owned by a task:
- duplicate or missing execution at cutover (B2, B5, B6, B7's 300-event suite);
- fleet authority exceeding the approval (A5, A6);
- false "exact" conversions (A7 fixtures + B7 parity);
- unreviewed authority expansion (B3 dialog acceptance).

**Disagreements recorded, not silently resolved:**
- `create_alert` as a built-in, against the spec's core tool (Q3). Todd decides.
- Flipping the `FLOWS_ENABLED` default (Q4 calls it a rollout choice, not a prerequisite). Kept as a choice.
- The three residuals of Decision 6.

## Review Focus

- **A switch during an event burst.** 300 `alert.triggered` events arrive in a ±2-minute window around a switch, across two API nodes, with one publisher clock 20 s behind. Some events are redelivered after the switch and some carry future `occurredAt`. Expected: every event is admitted exactly once by one engine; a redelivered event that legacy already admitted is a duplicate on the flow side. (Task B7 `three hundred events across the switch produce three hundred admissions`; Task B2 `redelivery of a legacy-admitted event is a flow duplicate`, `pre-claim legacy run history is honoured`.)
- **A webhook sender retrying across the switch.** A delivery with `x-breeze-event-id: evt_1` is accepted by legacy 30 s before the switch. Its retry is re-signed with a fresh timestamp, keeps the same event id, and arrives at the old URL after the switch. Expected: it collides on `webhook:dlv:evt_1` and answers `duplicate`. Without an id, it is residual (a). (Task B6 `re-signed retry with a stable delivery id is a duplicate`, `forwarded delivery maps the legacy event id header`.)
- **Fleet authority wider than approved.** A pre-approved `run_script_on_targets` step has `maxTargets: 40`. Its static group grows to 60. In a second case, the step's script is edited to inherit `elevated`. In a third, a parked approval created for 12 devices is released after the group grows. Expected: the first two fail `binding_drift` before the first dispatch; the parked release dispatches exactly the 12 frozen devices. (Task A6 `count above maxTargets is binding_drift before dispatch`, `inherited elevated is refused`, `parked release dispatches the frozen list`.)
- **A converted Job quietly doing less.** A Job of `run_script` then `send_notification` under `stop` sees a dispatch failure on 3 of 30 devices. In another Job a filter expected `"5"` against a numeric payload. Expected: notices go to exactly the 27 that succeeded, as in legacy; the string filter shows "Needs review" and is never silently exact. (Task A7 `stop narrows later actions to succeeded devices`, `string filter is review`; Task B7 parity `per-device stop`.)
- **Retirement on a self-hosted install.** The R3 build boots with 12 enabled unswitched Jobs, 3 of them S+R, and no acceptance flag. Expected: nothing is disabled, standalone admission continues, and the startup error lists 12 (3 kept for remediation). With the flag set, the 9 are disabled with an audit event each and one notice per owner. (Task E2 `without acceptance nothing changes`, `S+R rows survive`, `one notice per owner`.)

---

## File Structure

**packages/shared**
- Create `src/validators/flowConversions.ts` (+ test). It holds the states, fidelities, finding codes and severities, the occurrence-key builders, the constants, the DTOs, and `conversionSwitchRequestSchema`.
- Modify `src/flows/builtins.ts` (+ test) to add the three built-ins.
- Modify `src/validators/flowRuns.ts` (+ test) to add the four error codes.
- Modify `src/validators/flows.ts` to add the `notify` channel types.
- Modify `src/validators/index.ts` to export the new module.

**apps/api — data (PR A)**
- Create `migrations/<slot>-flow-automation-conversions.sql`, `src/db/schema/flowConversions.ts` (`flowAutomationConversions`, `automationOccurrenceClaims`) and `flowConversions.schema.test.ts`.
- Modify `src/db/schema/automations.ts`, `index.ts` and `flowRuns.checkPins.test.ts`.
- Registries: `services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts`, `__tests__/integration/rls-coverage.integration.test.ts`, `orgMergeRegistry.integration.test.ts`.

**apps/api — built-ins, fleet lane, converter (PR A)**
- Create `services/flows/builtins/{resolveTargets,createAlert,runScriptOnTargets}.ts`, `services/alertCreation.ts` and `services/scriptFleetDispatch.ts`. The last holds the legacy run-script dispatch guarantees, extracted from `automationRuntime.ts` and shared by both engines.
- Create `services/flows/fleetPreApproval.ts`, `services/actionIntents/fleetEffectDigest.ts` and `services/flows/conversion/{convertAutomation,findings,context,classify,shadowEvaluate,census}.ts`, each with a test. Add the `apps/api/scripts/automationConversionCensus.ts` CLI.
- Modify `services/flows/builtins/{index,permissions}.ts`, `validateBuiltins.ts`, `preApproval.ts` (dispatch to the fleet lane), `versions.ts` (the fleet binding at enable), `runSlice.ts`/`stepExecutor.ts` (built-in dispatch and per-device rows), `services/actionIntents/intentService.ts` (built-in intent: derived scope, frozen devices, mandatory digest), `effectDigest.ts`, `effectDigestCoverage.contract.test.ts`, `jobs/intentReleaseWorker.ts` (carry the verified context into `executeReleasedFlowBuiltin`), `services/notificationSenders/channelMessage.ts` + `channelMessageTypes.ts`, `services/automationRuntime.ts` (calls the extracted modules), and `services/policyEvaluationService.ts` (exports the remediation-target predicate used by `classify.ts`).

**apps/api — cutover (PR B)**
- Create `services/flows/conversion/{service,claims,switch,revert,shadow,legacyWebhookForward,generatedScripts}.ts` and `routes/flowConversions.ts`, each with a test.
- Modify:
  - `jobs/automationWorker.ts`: scan, fan-out and admission load switched rows, use preference + claims, and run the shadow hook.
  - `routes/automations.ts`: webhook forwarding and claims, frozen rows, the conversion field, the manual routes.
  - `services/flows/runService.ts`: `createFlowRun` takes a conversion-claim `onCreated`.
  - `services/flows/eventTrigger.ts`.
  - `jobs/flowScheduleTick.ts`: UTC keys, the parent claim, the cutover cursor.
  - `services/flows/webhook/ingest.ts`: claims and aliases.
  - `services/flows/versions.ts`: `enableFlow` `onPublished`, the delete refusal.
  - `services/flows/service.ts`: `convertedFrom`.
  - `services/aiToolsFleet.ts`, `routes/mcpServer.ts`, `routes/partnerApi/configuration.ts`.
  - The W04 reconciler (grep `reconcil` under `services/flows` and `jobs`).
  - `services/eventBus.ts`: the Sentry report for future `occurredAt`.
  - `services/mcpCoverage.ts`.
- Integration suites: `automationConversionRls`, `automationConversionCutover`, `automationFlowParity`, `fleetPreApproval`.

**apps/web (PR C)**
- Create `components/automations/conversion/{conversionApi,FidelityBadge,ConversionPanel,SwitchDialog,JobsMigrationBanner}` (+ tests).
- Modify `AutomationsPage.tsx`, `AutomationList.tsx`, `AutomationEditPage.tsx`, `components/flows/{FlowDetailPage.tsx,api.ts,FlowStepList.tsx}` (rendering for the three built-ins).
- Locales ×8 (`scripts.json`, `flows.json`).
- Docs: `apps/docs/.../features/{automations,flows}.mdx`.

**PR D (R2):** `routes/automations.ts`, `aiToolsFleet.ts`, `services/flows/conversion/precreateSweep.ts` (+ test), `src/index.ts`, env plumbing for `FLOW_CONVERSION_SWEEP_DISABLED`, banner.

**PR E (R3):** `services/flows/conversion/retirementGate.ts` (+ test), `jobs/automationWorker.ts`, `routes/automations.ts`, `revert.ts`, env plumbing for `LEGACY_JOBS_RETIREMENT_ACCEPTED`, banner, docs.

---

## PR A — Shared, data, built-ins, fleet lane, converter

### Task A0: Spec amendments

**Files:** Modify `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md` (§3, §6.1, §6.3, §6.4, §6.5, §7, §10 W6 row, §11).

- [ ] **Step 1:** Write one **Amendment (W6 plan, 2026-10-27)** call-out per Open Decision as finally adopted:
  - **§7:**
    - the classes, and scope as standalone admission retirement (Decisions 1, 16);
    - opt-in and never auto-switch (2);
    - shadow + CI parity (3);
    - owner/delegator and acceptance (4);
    - claims + preference (6);
    - revert (7);
    - the R1–R3 sequence, no drop (8);
    - the conversion map's corrections to §7: action-major order, deploy unmapped, `awaitCompletion` unnecessary, `ai_triage` excluded, `create_alert` as a built-in with the recorded disagreement.
  - **§6.1:** the three built-ins and the `notify` channel types (13, 15).
  - **§6.3 rule 4:** the fleet lane (5).
  - **§6.4:** both tables and the new column.
  - **§6.5:** the flow side of claims, UTC schedule keys for converted flows, and revert's admission/execution split.
  - **§3:** "Two engines is a transition" now names the follow-up feature.
  - **§11:** a "Plan amendments (W6)" row with the quorum outcome and the deferred list (19).
- [ ] **Step 2: Commit** — `git commit -m "docs(specs): W6 amendments — legacy automation conversion, fleet pre-approval lane, cutover claims, retirement sequence"`

### Task A1: Shared types

**Files:**
- Create: `packages/shared/src/validators/flowConversions.ts`, `flowConversions.test.ts`
- Modify: `packages/shared/src/flows/builtins.ts`, `builtins.test.ts`, `src/validators/flowRuns.ts`, `flowRuns.test.ts`, `src/validators/flows.ts`, `src/validators/index.ts`

**Interfaces (Produces):**
```ts
export const FLOW_CONVERSION_STATES = ['shadow', 'switched', 'reverted'] as const;
export const FLOW_CONVERSION_FIDELITIES = ['exact', 'needs_review', 'unconvertible'] as const;
export const FLOW_CONVERSION_FINDING_SEVERITIES = ['info', 'review', 'blocker'] as const;
export const OCCURRENCE_CLAIM_ENGINES = ['legacy', 'flow'] as const;
export const FLOW_CONVERSION_FINDING_CODES = [
  // blocker
  'flows_disabled', 'managed_row', 'policy_workflow', 'already_retired', 'compliance_remediation_target',
  'event_dispatch_not_durable', 'event_filter_not_strict', 'event_filter_null', 'cron_semantics_differ',
  'condition_unknown_type', 'targets_over_cap', 'partner_wide_group_target', 'run_as_elevated',
  'restart_service_monitor_only', 'command_mixed_os', 'notify_per_run_cap', 'channel_type_not_supported',
  'deploy_software_unmapped', 'monthly_cap_exceeded', 'reference_not_owned',
  // review
  'event_filter_string_coercion', 'approval_each_run', 'command_becomes_script', 'partner_wide_org_set_differs',
  'failure_notice_cap', 'owner_cap_pressure', 'site_ceiling_removed', 'webhook_body_shape',
  'legacy_secret_header_possible', 'name_truncated',
  // info
  'duration_minutes_ignored', 'schedule_outage_catch_up', 'queued_is_success', 'severity_mapped',
  'notification_emails_unused', 'webhook_url_changes', 'delegator_pause',
] as const;
export const FLOW_CONVERSION_FINDING_SEVERITY: Record<FlowConversionFindingCode, FlowConversionFindingSeverity>;
export interface FlowConversionFinding { code: FlowConversionFindingCode; severity: FlowConversionFindingSeverity;
  actionIndex: number | null; detail: string /* ≤ 500, ids and field names only */ }
export function fidelityOf(findings: readonly FlowConversionFinding[]): FlowConversionFidelity;
export const occurrenceKey: {
  event(eventId: string): string;                 // 'event:<id>'
  schedule(instant: Date): string;                // 'schedule:2027-01-09T03:00Z' (UTC, minute precision)
  webhookSig(digest: string): string;             // 'webhook:sig:<digest>'
  webhookDelivery(id: string): string;            // 'webhook:dlv:<id>' (FLOW_WEBHOOK_DELIVERY_ID_RE)
};
export const CONVERSION_MIN_SHADOW_MS = 600_000; export const CONVERSION_SHADOW_MIN_RUNS = 3;
export const CONVERSION_SHADOW_MIN_MS = 604_800_000; export const CONVERSION_TARGET_HEADROOM = 400;
export const FLEET_MAX_TARGETS = 500; export const SWITCH_LEAD_MS = 60_000; export const LEGACY_DRAIN_MIN_MS = 2_592_000_000;
export interface FlowConversionPreviewDto { automationId: string; fidelity: FlowConversionFidelity; findings: FlowConversionFinding[];
  document: FlowDocumentV1 | null; preApprovalCandidates: { stepId: string; currentTargetCount: number | null }[];
  generatedScripts: { stepId: string; name: string; language: 'bash' | 'powershell' | 'cmd'; body: string }[];
  sourceDigest: string; documentDigest: string | null; targetCount: number | null; estimatedMonthlyRuns: number | null }
export interface FlowConversionDto { id: string; automationId: string; flowId: string; state: FlowConversionState;
  fidelity: FlowConversionFidelity; findings: FlowConversionFinding[]; createdAt: string; switchAt: string | null; revertAt: string | null;
  shadow: { runs: number; divergences: number; startedAt: string; lastAt: string | null;
    lastDivergence: { kind: 'trigger_mismatch' | 'target_set_mismatch' | 'would_park' | 'over_cap'; at: string; detail: string } | null };
  switchBlockedBy: 'shadow_too_new' | 'shadow_too_short' | 'shadow_divergent' | 'source_changed' | 'unconvertible' | null }
export const conversionSwitchRequestSchema; // { expectedFlowVersion: int, preApprovals: { stepId, maxTargets: 1..500 }[] ≤ 50,
                                             //   acceptScopeWidening: boolean default false, acceptDelegatorLifecycle: literal(true),
                                             //   acknowledgeDivergence: boolean default false }.strict()
export interface AutomationConversionSummaryDto { id: string; state: FlowConversionState; flowId: string; fidelity: FlowConversionFidelity }
// flows/builtins.ts:
//   resolve_targets  { target?: deploymentTargetConfigSchema, conditions?: legacyConditionSchema[] ≤ 50 } exactly one; tier 1
//   create_alert     { deviceId, severity: ALERT_SEVERITIES, title?: 1..200, message: 1..4000 }; tier 2
//   run_script_on_targets { scriptId, parameters?, runAs?: 'system'|'user', whenOffline: 'queue'|'skip' default 'queue',
//                    exactly one of target | conditions | deviceIds (array ≤ 500) | fromStep: { stepId, set: 'succeeded'|'dispatched' } };
//                    maxTier 3, tierFor ⇒ 3
//   legacyConditionSchema = { type: 'site'|'os'|'group'|'tag', operator: 'is'|'is_not'|'contains'|'not_contains' default 'is', value: 1..200 }.strict()
//   fleet step output: { dispatchedDeviceIds, succeededDeviceIds, failedDeviceIds, skippedOfflineDeviceIds: string[];
//                        devices: { id, hostname }[]; count: number; warnings: string[] }
// flowRuns.ts FLOW_STEP_ERROR_CODES += 'targets_over_cap','targets_unresolvable','alert_create_failed','script_dispatch_failed' (appended)
// flows.ts: notify channel types += 'webhook','pagerduty'
```

- [ ] **Step 1: Failing tests.**
  - `flowConversions.test.ts`:
    - `schedule key is UTC minute precision`
    - `delivery key refuses an id failing the delivery-id regex`
    - `fidelity: any blocker ⇒ unconvertible, any review ⇒ needs_review, else exact`
    - `every finding code has a severity`
    - `switch request requires acceptDelegatorLifecycle true`
    - `maxTargets above 500 is invalid`
  - `builtins.test.ts`:
    - `run_script_on_targets requires exactly one selector`
    - `run_script_on_targets refuses runAs elevated`
    - `fromStep set must be succeeded or dispatched`
    - `resolve_targets is tier 1, create_alert tier 2, run_script_on_targets tier 3`
    - `unknown legacy condition type is invalid`
  - `flowRuns.test.ts`: `W6 error codes are step and run codes`.
  - Run `cd packages/shared && npx vitest run src/validators/flowConversions.test.ts src/flows/builtins.test.ts src/validators/flowRuns.test.ts` → FAIL.
- [ ] **Step 2: Implement.** Use the browser-safe barrel. No `z.undefined()`.
- [ ] **Step 3: Run** the three files + `src/browserSafeBarrel.test.ts` → PASS. Shared tsc `exit=0`.
- [ ] **Step 4: Commit** — `git commit -m "feat(shared): flow conversion types, occurrence keys, fleet built-ins (#5221)"`

### Task A2: Migration + Drizzle schema

**Files:**
- Create: `apps/api/migrations/<slot>-flow-automation-conversions.sql`, `apps/api/src/db/schema/flowConversions.ts`, `flowConversions.schema.test.ts`
- Modify: `apps/api/src/db/schema/automations.ts`, `index.ts`, `flowRuns.checkPins.test.ts`

**Interfaces (Produces):**
- Drizzle `flowAutomationConversions` and `automationOccurrenceClaims`.
- `automations.convertedToFlowId`.

- [ ] **Step 1: Failing schema test.**
  - Every column listed in Step 2 is present. Both `orgId` and `partnerId` are nullable (the XOR is enforced in SQL). No `deviceId`, `siteId` or `ticketId`.
  - PINS:
    - both error-code CHECKs equal the widened `FLOW_STEP_ERROR_CODES`, read from the **new** file;
    - `_state_chk` equals `FLOW_CONVERSION_STATES`;
    - `_fidelity_chk` equals `FLOW_CONVERSION_FIDELITIES`;
    - `automation_occurrence_claims_engine_chk` equals `OCCURRENCE_CLAIM_ENGINES`.
  - Run → FAIL.
- [ ] **Step 2: Write the migration.**
  1. **`flow_automation_conversions`**
     - Identity and owner:
       - `id uuid pk`, `org_id uuid`, `partner_id uuid`;
       - `_one_owner_chk ((org_id IS NULL) <> (partner_id IS NULL))`;
       - `_org_fk (org_id) → organizations ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`;
       - `_partner_fk → partners ON DELETE CASCADE`.
     - References: `automation_id uuid NOT NULL → automations ON DELETE CASCADE`, `flow_id uuid NOT NULL → flows ON DELETE CASCADE`.
     - State and digests: `state text NOT NULL DEFAULT 'shadow'`, `fidelity text NOT NULL`, `findings jsonb NOT NULL DEFAULT '[]'`, `source_digest text NOT NULL`, `source_snapshot jsonb NOT NULL` (trigger without the secret, conditions, actions, on_failure, notification_targets), `document_digest text NOT NULL`.
     - Shadow counters: `shadow_runs int NOT NULL DEFAULT 0`, `shadow_divergences int NOT NULL DEFAULT 0`, `shadow_started_at timestamptz NOT NULL DEFAULT now()`, `shadow_last_at`, `shadow_last_divergence jsonb`.
     - Timestamps: `switch_at`, `switched_at` (transaction time), `revert_at`.
     - Actors: `converted_by`, `switched_by`, `reverted_by` (each `→ users ON DELETE SET NULL`).
     - Flags: `divergence_acknowledged boolean NOT NULL DEFAULT false`, `scope_widening_accepted boolean NOT NULL DEFAULT false`, `created_at`, `updated_at`.
     - CHECKs:
       - `_state_chk`, `_fidelity_chk`;
       - `_fidelity_row_chk (fidelity <> 'unconvertible')`;
       - `_switch_chk ((state = 'shadow') = (switch_at IS NULL))`;
       - `_revert_chk ((state = 'reverted') = (revert_at IS NOT NULL))`;
       - `_counters_chk (0 <= shadow_divergences AND shadow_divergences <= shadow_runs)`.
     - Indexes:
       - partial unique `_live_uq (automation_id) WHERE state <> 'reverted'`;
       - unique `_flow_uq (flow_id)`;
       - owner indexes;
       - `(automation_id, created_at)`.
     - Triggers:
       - BEFORE INSERT owner-guard (SECURITY DEFINER, pinned `search_path`, the W05 delivery guard model): the owner axes must equal the automation's **and** the flow's.
       - BEFORE UPDATE immutability on the owner axes, `automation_id`, `flow_id`, `source_digest`, `source_snapshot`, `converted_by`, `created_at`; on `switch_at`/`switched_at` once set; on `revert_at` once set; and on any state transition other than `shadow→switched` and `switched→reverted`.
  2. **`automation_occurrence_claims`**
     - Identity and owner: `id uuid pk`, `org_id`, `partner_id`, the XOR CHECK, and the org/partner FKs as above.
     - `automation_id uuid NOT NULL → automations ON DELETE CASCADE`.
     - `occurrence_key text NOT NULL` (`_key_chk (occurrence_key ~ '^(event:[0-9a-f-]{36}|schedule:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z|webhook:sig:[0-9a-f]{64}|webhook:dlv:[A-Za-z0-9._:-]{1,128})$')`).
     - `engine text NOT NULL`, `conversion_id uuid` (plain uuid, provenance), `legacy_run_id uuid` (plain), `flow_run_id uuid` (plain; NULL for a partner-wide parent claim), `occurrence_at timestamptz`, `claimed_at timestamptz NOT NULL DEFAULT now()`.
     - CHECKs: `_engine_chk`; `_run_chk (engine = 'flow' OR legacy_run_id IS NOT NULL)`.
     - Indexes: unique `(automation_id, occurrence_key)`; `(claimed_at)`; owner indexes.
     - Triggers: an owner-guard trigger (axes equal the automation's) and full-row immutability (claims are append-only).
  3. **RLS** on both tables:
     - ENABLE + FORCE.
     - Copy the `flows` table's newest policies verbatim, renamed (`rg -n "CREATE POLICY.*flows" apps/api/migrations | sort | tail`): dual-axis isolation plus the partner-wide SELECT branch.
     - `GRANT SELECT, INSERT, UPDATE, DELETE … TO breeze_app`. Claims additionally `REVOKE UPDATE, TRUNCATE`, following the append-only model in `ensureAppRole.ts`. Add the table to `ensureAppRole.appendOnlyCoverage.test.ts`.
  4. **`automations.converted_to_flow_id uuid REFERENCES flows(id) ON DELETE SET NULL`**, with `automations_converted_flow_chk (converted_to_flow_id IS NULL OR (retired_at IS NOT NULL AND retired_reason = 'converted_to_flow'))` and a partial index.
  5. **CHECK swaps** `flow_runs_error_code_chk` and `flow_run_steps_error_code_chk`. Find the newest definitions with `rg -n "<name>" apps/api/migrations`.
- [ ] **Step 3: Drizzle.** Use the toolSources style and export from `index.ts`.
- [ ] **Step 4: Run.**
  - The schema test + `flowRuns.checkPins.test.ts` + `src/db/autoMigrate.test.ts` + `src/db/migrationRlsScope.test.ts` + `src/db/migrationPartnerExportLocks.test.ts` → PASS.
  - Test stack: apply twice. `pnpm db:check-drift` is clean. `\d+` shows the DEFERRABLE org FKs.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): conversion ledger, automation-wide occurrence claims, automations.converted_to_flow_id (#5221)"`

### Task A3: Registrations and `notify` widening

**Files:**
- Modify: `services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts`, `__tests__/integration/rls-coverage.integration.test.ts`, `orgMergeRegistry.integration.test.ts`, `db/ensureAppRole.ts`, `services/flows/builtins/{index,permissions}.ts`, `services/flows/validateBuiltins.ts` (+ test), `services/flows/builtinNames.contract.test.ts`, `services/notificationSenders/channelMessage.ts`, `channelMessageTypes.ts` (+ tests)

- [ ] **Step 1: Failing unit tests.**
  - `validateBuiltins.test.ts`:
    - `notify to a pagerduty channel validates`
    - `notify to a webhook channel validates`
    - `resolve_targets or run_script_on_targets naming a group the owner does not own is reference_not_owned`
    - `run_script_on_targets scriptId of another owner is refused`
    - `create_alert literal device of another org is refused`
  - `channelMessage.test.ts`:
    - `pagerduty dedup key is flow:<runId>:<stepId>:<item>`
    - `webhook send uses the channel's signing`
  - Built-in names contract: the new names are disjoint from core and contain no `__`.
  - Run → FAIL.
- [ ] **Step 2: Red the contract suites** with the migration applied and nothing registered: strict `pnpm test:rls-coverage`, `orgCascadeFkOnDelete`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry` integration, and `src/services/orgMerge.test.ts` (full file). Record the failures for the PR body.
- [ ] **Step 3: Register.**
  - Cascade: both tables, alphabetical.
  - Export:
    - conversions: `findings`, `source_snapshot`, `shadow_last_divergence` → `excludedOpen`; the digests → `reviewedIncluded`; the rest → `included`;
    - claims: all `included`, with `occurrence_key` → `reviewedIncluded`;
    - `automations.converted_to_flow_id` → `included`.
    - Follow the erasure roundtrip if it pushes a column to `reviewedIncluded`.
  - Merge: `REPOINT_TABLES` gets both tables. Classify the new triggers in the merge integration test: owner guards are insert-only, so benign. The immutability triggers block an `org_id` change, so the merge must repoint through the same session setting that the `automations` repoint uses (asserted in B7). If it cannot, classify the table `custom` beside `automation_resource_bindings`.
  - `rls-coverage`: both tables go in `DUAL_AXIS_TENANT_TABLES` + `XOR_OWNERSHIP_DUAL_AXIS_TABLES`.
  - Built-in permissions:
    - `resolve_targets: ['devices.read']`
    - `create_alert: ['alerts.write']`
    - `run_script_on_targets`: the exact set that `TOOL_PERMISSIONS.run_script` names.
- [ ] **Step 4: Implement** the `notify` widening.
- [ ] **Step 5: Run.** Unit tests + `tenantCascade.test.ts` + `orgMerge.test.ts` + `ensureAppRole.appendOnlyCoverage.test.ts` → PASS. Contract suites + `orgLifecycleFoundations` → PASS, each with more than 0 tests.
- [ ] **Step 6: Commit** — `git commit -m "feat(api): register conversion tables; notify reaches webhook and PagerDuty channels (#5221)"`

### Task A4: `resolve_targets` and `create_alert`

**Files:**
- Create: `services/flows/builtins/resolveTargets.ts`, `createAlert.ts`, `services/alertCreation.ts` (+ tests)
- Modify: `services/automationRuntime.ts`, `services/flows/builtins/index.ts`, `__tests__/parkedFanoutModules.ts`

**Interfaces:**
- `executeResolveTargets(input, frame)` returns the fleet-output shape. Its `dispatched`, `succeeded` and `failed` sets all equal the resolved set.
- `executeCreateAlert(input, frame): Promise<BuiltinResult<{ alertId: string }>>`.
- `createAutomationStyleAlert(tx, { orgId, deviceId, severity, title, message, provenance: { kind: 'automation'; automationId } | { kind: 'flow'; flowRunId } })`. The body moves verbatim from `executeCreateAlertAction`. The legacy payload keeps `automationId`, so the class-A loop guard is unchanged.
- `resolveTargetsOnce(orgId, selector): Promise<{ deviceIds: string[]; devices: { id: string; hostname: string }[]; warnings: string[]; problems: string[] }>`. It wraps `resolveAutomationTargetsDetailed` and `resolveLegacyConditionTargets` with `orgIds: [orgId]`, resolves once and deduplicates.

- [ ] **Step 1: Failing tests.**
  - `resolveTargets.test.ts`:
    - `groups target returns only run-org members`
    - `legacy tag condition matches by substring like legacy` (fixture shared with `automationRuntime.trigger.test.ts`)
    - `empty conditions return every run-org device`
    - `deleted group fails targets_unresolvable with the legacy problem text`
    - `over 500 fails targets_over_cap, never truncates`
    - `partner-wide flow resolves in the run org only`
    - `reads run under the flow principal's org context` (mutation check: system context turns it red)
    - `warnings are preserved in the output`
  - `createAlert.test.ts`:
    - `creates one alert on the device`
    - `another org's device is refused before any write`
    - `payload carries flowRunId, no automationId`
    - `failure is alert_create_failed`
  - `alertCreation.test.ts`: `legacy output is identical after extraction` (row and event snapshot captured red-first from the current function).
  - Run → FAIL.
- [ ] **Step 2: Implement.** Classify both files in `parkedFanoutModules.ts` (the legacy resolver already excludes parked devices).
- [ ] **Step 3: Run** these + `stepExecutor.test.ts`, `automationRuntime.test.ts`, `automationRuntime.trigger.test.ts`, `parkedFanout.contract.test.ts` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(flows): resolve_targets and create_alert built-ins (#5221)"`

### Task A5: `run_script_on_targets` with legacy dispatch guarantees

**Files:**
- Create: `apps/api/src/services/scriptFleetDispatch.ts`, `scriptFleetDispatch.test.ts`, `services/flows/builtins/runScriptOnTargets.ts`, `runScriptOnTargets.test.ts`
- Modify: `services/automationRuntime.ts` (`executeAutomationActionsInOrder` run_script arm calls `scriptFleetDispatch`), `services/flows/runSlice.ts`/`stepExecutor.ts` (per-device rows), `__tests__/parkedFanoutModules.ts`

**Interfaces:**
- Produces:
  - `dispatchScriptToDevices(args: { lane: { kind: 'automation'; runId: string; actionIndex: number } | { kind: 'flow'; runId: string; stepId: string; leaseToken: string }; orgId: string; script: VerifiedScriptSnapshot; parameters: Record<string, unknown>; runAs: 'system' | 'user' | null; offlinePolicy: 'queue' | 'skip'; deviceIds: readonly string[]; aiOrigin?: AiOrigin }): Promise<{ perDevice: { deviceId: string; outcome: 'dispatched' | 'queued' | 'skipped_offline' | 'failed'; executionId: string | null; error: string | null }[] }>`
    - This is extracted from the legacy caller of `executeRunScriptAction` (~L3674):
      - per-device lock;
      - cancellation fence (legacy run cancel or flow run cancel / lease);
      - a durable per-device claim before dispatch;
      - commit before delivery;
      - queue-on-offline with the legacy delivery deadline;
      - attribution: `ai_initiator_kind 'flow'` for the flow lane, as W04 Decision 16 requires.
  - `executeRunScriptOnTargets(input, frame, verified?: { snapshot: VerifiedScriptSnapshot; deviceIds: string[] }): Promise<BuiltinResult<FleetOutput>>`
    - It resolves the selector once (or takes `verified.deviceIds` on release), checks `≤ FLEET_MAX_TARGETS` and then calls `dispatchScriptToDevices`.
    - Each device writes one `flow_run_steps` row (`item_index` = position in the sorted set, W05 unique key) **before** dispatch. Its outcome is written after.
    - The step output carries only the id sets and counts. Detail lives in the per-device rows, so the release worker's 64 KiB truncation never loses outcomes.
    - Zero targets with no problems ⇒ the step completes with `count: 0`.
    - `failedDeviceIds` non-empty ⇒ the step is `failed` (W05 `onFailure` applies). The output always carries the sets, so later steps can chain.
- Consumes: `resolveTargetsOnce` (A4) and the run-org principal (W04).

- [ ] **Step 1: Failing tests.**
  - `scriptFleetDispatch.test.ts`:
    - `legacy lane output is identical to today's run_script arm` (snapshot of the dispatch calls and ledger writes, captured red-first)
    - `offline device with queue gets a delivery deadline, with skip is skipped_offline`
    - `cancelled run stops before the next device`
    - `flow lane writes the per-device row before dispatch`
    - `crash after claim and before dispatch resumes without a second dispatch`
    - `flow lane stamps ai_initiator_kind flow`
  - `runScriptOnTargets.test.ts`:
    - `resolves once and dispatches exactly the checked set`
    - `fromStep succeeded chains only the succeeded devices`
    - `trigger.device.id selector dispatches one device`
    - `inherited elevated run context is refused` (script saved `elevated`, no `runAs` given)
    - `device of another org is refused at dispatch`
    - `step output stays under 64 KiB at 500 devices`
  - Run → FAIL.
- [ ] **Step 2: Implement.** The legacy arm must keep passing every `automationRuntime.*.test.ts` sibling. List them explicitly: `runScript`, `whenOffline`, `cancelFence`, `commitBeforeSend`, `replayIdempotency`, `boundTargets`, `occurrence`, `partnerFanout`, `siteScope`.
- [ ] **Step 3: Run** both new files + those siblings + `runSlice.test.ts` + `stepExecutor.test.ts` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(flows): run_script_on_targets over the extracted legacy fleet dispatch (#5221)"`

### Task A6: The fleet pre-approval lane, intents, effect digest, release plumbing

**Files:**
- Create: `services/flows/fleetPreApproval.ts`, `fleetPreApproval.test.ts`, `services/actionIntents/fleetEffectDigest.ts`, `fleetEffectDigest.test.ts`, `__tests__/integration/fleetPreApproval.integration.test.ts`
- Modify: `services/flows/preApproval.ts` (route `run_script_on_targets` to the fleet lane; the `forEach` prohibition applies to both lanes), `services/flows/versions.ts` (`FlowEnableRequest.preApprovals[].maxTargets`, binding stored on the publication), `runSlice.ts`/`stepExecutor.ts` (revalidate the binding before the first dispatch), `services/actionIntents/intentService.ts` (built-in intent: approval scope derived from the script, device list frozen at creation, mandatory effect digest), `effectDigest.ts` (resolver key `run_script_on_targets`), `effectDigestCoverage.contract.test.ts` (asserts the built-in is pinned and required), `jobs/intentReleaseWorker.ts` (carry `verifiedContext` into `executeReleasedFlowBuiltin`; the built-in branch takes `(intent, auth, verified)`), the shared `flowEnableRequestSchema`

**Interfaces (Produces):**
```ts
export interface FleetBindingV1 { kind: 'fleet_v1'; publicationId: string; stepId: string; tool: 'run_script_on_targets';
  owner: { orgId: string | null; partnerId: string | null }; scriptMaterialSha256: string; parametersSha256: string;
  effectiveRunAs: 'system' | 'user'; offlinePolicy: 'queue' | 'skip'; deliveryDeadlineSec: number;
  selector: { kind: 'target' | 'conditions' | 'trigger_device' | 'from_step'; canonicalSha256: string; dynamicGroupDefinitions: Record<string, string> };
  maxTargets: number }
export function fleetPreApprovalEligibility(step: FlowStep, pin: FlowStepPin, snapshot: RunScriptSnapshot): PreApprovalEligibility;
export function buildFleetBinding(i: { publicationId: string; step: FlowStep; owner: ToolOwnerRef; snapshot: RunScriptSnapshot; maxTargets: number; groupDefinitions: Record<string, string> }): FleetBindingV1;
export async function revalidateFleetBinding(b: FleetBindingV1, live: { snapshot: RunScriptSnapshot; step: FlowStep; groupDefinitions: Record<string, string>; resolvedCount: number }): Promise<{ ok: true } | { ok: false; code: 'binding_drift'; detail: string }>;
export function fleetEffectDigest(i: { snapshot: RunScriptSnapshot; parameters: unknown; runAs: string; offlinePolicy: string; deviceIds: readonly string[] }): string;
```

- [ ] **Step 1: Failing tests.**
  - `fleetPreApproval.test.ts`:
    - `forEach step is never eligible`
    - `templated parameters are ineligible`
    - `variable reference in script content is ineligible`
    - `four_eyes script is ineligible`
    - `inherited elevated is refused`
    - `trigger.device.id selector is eligible`
    - `fromStep to an eligible step is eligible`
    - `count above maxTargets is binding_drift before dispatch`
    - `edited script is binding_drift`
    - `dynamic group definition change is binding_drift`
    - `static group membership growth within maxTargets is allowed`
    - `webhook run never honours the fleet pre-approval`
  - `fleetEffectDigest.test.ts`:
    - `digest changes with any device id`
    - `zero devices has a defined digest`
  - `intentService` cases:
    - `parked fleet intent freezes the device list`
    - `approval scope follows the script`
    - `missing digest refuses intent creation`
  - `intentReleaseWorker` cases:
    - `parked release dispatches the frozen list`
    - `built-in release receives the verified snapshot` (mutation check: drop the argument → red)
  - Integration `fleetPreApproval.integration.test.ts` (real DB): enable with `maxTargets` 2 on a 3-device group fails the run `binding_drift` with zero dispatches; a parked approval for 2 devices releases exactly 2 after a third joins.
  - Run → FAIL.
- [ ] **Step 2: Implement.** The W04 binding helper is not reused, because it excludes `runAs` (`preApproval.ts:~88`). `FLOW_IGNORED_RUN_SCRIPT_KEYS` stays for core `run_script`.
- [ ] **Step 3: Run** these + `preApproval.test.ts`, `versions.test.ts`, `intentService*.test.ts` (each sibling listed explicitly), `intentReleaseWorker*.test.ts` (listed), `effectDigest*.test.ts`, `effectDigestCoverage.contract.test.ts`, the integration file → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(flows): fleet pre-approval lane with full execution binding; built-in release carries the verified context (#5221)"`

### Task A7: Classifier and converter

**Files:**
- Create: `services/flows/conversion/classify.ts`, `convertAutomation.ts`, `context.ts`, `findings.ts`, `__fixtures__/automations.ts` (+ tests)
- Modify: `services/policyEvaluationService.ts` (export `isComplianceRemediationTarget(tx, automation): Promise<boolean>` covering both consumers and the script-match rule; the existing functions call the same predicate)

**Interfaces (Produces):**
```ts
export type AutomationClass = 'M' | 'A' | 'P' | 'S';
export function classifyAutomation(row: Pick<AutomationRow, 'managedByMonitorId' | 'managedByAgentId' | 'trigger' | 'retiredAt'>): AutomationClass | 'retired';
export interface ConversionContext {
  owner: ToolOwnerRef; flowsEnabled: boolean; eventDispatchDurable: boolean; legacySecretHeaderAllowed: boolean;
  currentTargets: { count: number; osTypes: ReadonlySet<'windows' | 'macos' | 'linux'> } | null;   // null = event-bound
  channels: Map<string, { type: string; ownedByOwner: boolean }>;
  scripts: Map<string, { ownedByOwner: boolean; effectiveRunAs: 'system' | 'user' | 'elevated'; preApprovable: boolean }>;
  isRemediationTarget: boolean; liveMonitorConversion: boolean; creatorHasSiteCeiling: boolean;
  partnerOrgs: { live: number; total: number } | null;
  limits: { monthlyRunsPerFlow: number; monthlyRunsPerOwner: number; ownerRunsThisMonth: number };
  observedMonthlyRuns: number | null;
}
export interface ConversionResult { fidelity: FlowConversionFidelity; findings: FlowConversionFinding[]; document: FlowDocumentV1 | null;
  preApprovalCandidates: { stepId: string; currentTargetCount: number | null }[]; generatedScripts: GeneratedScriptSpec[];
  sourceDigest: string; sourceSnapshot: Record<string, unknown>; documentDigest: string | null; estimatedMonthlyRuns: number | null }
export function convertAutomation(row: AutomationRow, ctx: ConversionContext): ConversionResult;   // pure, total, deterministic
export function automationSourceDigest(row: AutomationRow): string;
export async function loadConversionContext(tx: DbExecutor, row: AutomationRow): Promise<ConversionContext>; // system read, explicit owner predicates
```
**Step ids:** `targets` (only when no script action comes first), then `a<i>_<kind>`, then `a<i>_failnotice_<n>`. The chaining selector follows the conversion map.

- [ ] **Step 1: Failing tests.** One fixture per conversion-map row.
  - Converter:
    - `scheduled run_script on a groups target is exact with one fleet candidate`
    - `event automation binds trigger.device.id`
    - `stop narrows later actions to succeeded devices`
    - `continue chains dispatched devices`
    - `onFailure notify adds per-channel failure notices over failed devices`
    - `string filter is review`, `null filter is a blocker`, `array filter is a blocker`
    - `cron differing across DST is a blocker` (if the two implementations agree on every fixture, assert equality over a 400-occurrence span crossing both transitions)
    - `deploy_software is a blocker`
    - `mixed-OS shell-less command is a blocker`
    - `inherited elevated is a blocker`
    - `estimated runs above the flow cap is a blocker`
    - `partner with 600 orgs is a blocker`
    - `creator site ceiling adds site_ceiling_removed`
    - `webhook adds body-shape and url findings`
    - `S+R row is a blocker for both consumers`
    - `unknown legacy condition type is a blocker`
    - `every exact or needs_review document validates for the owner`
    - `output is deterministic`
    - `source digest ignores the secret`
  - `classify.test.ts`:
    - `monitor row with an agent id is M`
    - `null-managed row with _policyWorkflow is P`
  - `context.test.ts`:
    - `owner predicates are explicit`
    - `partner-wide owner never treats an org script as owned`
  - Run → FAIL.
- [ ] **Step 2: Implement.** `detail` strings carry ids and field names only, never a script body, a command or a secret.
- [ ] **Step 3: Run** these + `policyEvaluationService*.test.ts` (listed) + `retiredSourceReaders.contract.test.ts` + `flowValidator.test.ts` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(flows): automation classifier and pure converter with coded findings (#5221)"`

### Task A8: Shadow evaluator, census, PR A wrap-up

**Files:**
- Create: `services/flows/conversion/shadowEvaluate.ts`, `census.ts` (+ tests), `apps/api/scripts/automationConversionCensus.ts`

**Interfaces (Produces):**
- `evaluateShadow({ document, legacyMatched, flowMatched, legacyTargetIds, flowTargetIds, wouldParkStepIds }): { divergent: boolean; kind: ShadowDivergenceKind | null; detail: string }`. Precedence: `trigger_mismatch > over_cap > target_set_mismatch > would_park`.
- `wouldParkSteps(document, triggerKind, acceptedPreApprovalStepIds): string[]`. It applies the W04/W05 honour rule.
- `conversionCensus(): Promise<{ byClass: Record<AutomationClass, { total: number; enabled: number }>; remediationTargets: number; byFidelity: Record<FlowConversionFidelity, number>; byFinding: Record<FlowConversionFindingCode, number>; switched: number; enabledUnswitchedS: number; oldestSwitchAgeMs: number | null }>`. It runs under system context, returns aggregates only, and never ids or names.

- [ ] **Step 1: Failing tests.**
  - `flow-only match is trigger_mismatch`
  - `set order is ignored`
  - `webhook script step would park`
  - `census output contains no uuid`
  - `R rows counted separately`
- [ ] **Step 2: Implement.** The CLI (`cd apps/api && npx tsx scripts/automationConversionCensus.ts`) prints the JSON. Todd runs it on US and EU. Only the aggregate numbers ever leave the host.
- [ ] **Step 3: Full PR A checks.** API tsc `exit=0`, lint, every touched unit file, the contract batch (`parkedFanout`, `builtinNames`, `effectDigestCoverage`, `mcp-coverage`, `routerAuthGate`), and the A3/A6 integration suites. Then `pnpm test-stack down`.
- [ ] **Step 4: Commit and open PR A** — `feat(flows): Tool Catalog W06 PR A — conversion ledger, fleet built-in and lane, converter (#5221)`.
  - Body: `Part of #5221` · `Part of #5215`. Regex-check it for closing keywords.
  - One review round, Opus on A5–A7. Post the summary comment.
  - Append the release-notes block under "Flows W06 PR A".

---

## PR B — Service, claims, switch, revert, schedule mode, forwarding

### Task B1: Conversion service and routes

**Files:**
- Create: `services/flows/conversion/service.ts`, `routes/flowConversions.ts` (+ tests)
- Modify: `routes/flows.ts` (register before `/:id`), `routes/automations.ts` (GET field), `services/aiToolsFleet.ts`, `routes/mcpServer.ts`, `routes/partnerApi/configuration.ts`, `services/mcpCoverage.ts`

**Interfaces (Produces):**
- `previewConversion(auth, automationId)`
- `createConversion(auth, automationId, { expectedSourceDigest })`
  - Errors: `unconvertible | source_changed | conversion_exists | partner_wide_forbidden | automation_not_found`.
  - It locks the automation `FOR UPDATE`, creates the draft through `saveDraftFlow` with the owner axis, and inserts the ledger row in one transaction.
- `createConversionsForOwner(auth, { ownerScope, orgId? }): Promise<{ created: number; skipped: Record<string, number> }>`
- `getConversion`, `listConversions`
- `resetShadowIfChanged(tx, automationId | flowId)`: called from the automation PUT/PATCH and the flow draft save.
- Routes:
  - `GET /api/v1/flows/conversions/preview/:automationId`
  - `POST /api/v1/flows/conversions`
  - `POST /api/v1/flows/conversions/bulk`
  - `GET /api/v1/flows/conversions[?state=]`
  - `GET /api/v1/flows/conversions/:id`
  - Permissions per Global Constraints.

- [ ] **Step 1: Failing tests.**
  - `class M preview is managed_row`
  - `create refuses a changed digest`
  - `draft is on the automation's axis`
  - `partner-wide needs canManagePartnerWidePolicies`
  - `second live conversion is conversion_exists`
  - `bulk skips and counts reasons`
  - `org token cannot preview a sibling org's automation`
  - `editing the automation resets shadow counters`
  - `editing the draft resets shadow counters`
  - Routes: `no MFA is 403`, `API key session is 403 interactive_session_required`, `flag off is 404`
  - `manage_automations get reports the conversion`
  - `GET /automations/:id has conversion null`
  - Run → FAIL.
- [ ] **Step 2: Implement.** Re-key `SAFE_WRITE_SITES` and the route-binding contract. Add the `mcpCoverage` entry `flowConversions.ts` as `tool_in_later_wave`.
- [ ] **Step 3: Run** these + `writeRoutePermissionGate`, `routerAuthGate`, `mcp-coverage`, `aiGuardrails.routeBinding.contract` → PASS.
- [ ] **Step 4: Commit.**

### Task B2: Occurrence claims on both engines

**Files:**
- Create: `services/flows/conversion/claims.ts`, `claims.test.ts`
- Modify: `jobs/automationWorker.ts` (`admitTriggerSchedule`, `admitTriggerEvent`), `routes/automations.ts` (manual routes, webhook route), `services/flows/runService.ts` (`createFlowRun` composes the conversion claim into `onCreated`), `services/flows/eventTrigger.ts`, `services/eventBus.ts`

**Interfaces (Produces):**
```ts
export type ClaimResult = { ok: true } | { ok: false; existing: { engine: 'legacy' | 'flow'; legacyRunId: string | null; flowRunId: string | null } };
/** Inside the admission transaction. Checks automation_runs (automation_id, occurrence_key) for pre-claim legacy history first. */
export async function claimOccurrence(tx: DbExecutor, i: { automationId: string; owner: OwnerAxis; keys: readonly string[];
  engine: 'legacy' | 'flow'; conversionId: string | null; legacyRunId?: string; flowRunId?: string; occurrenceAt: Date | null }): Promise<ClaimResult>;
export async function liveConversionForAutomation(tx: DbExecutor, automationId: string): Promise<{ id: string; state: FlowConversionState; switchAt: Date | null } | null>; // FOR SHARE on the automation row
export function legacyPrefers(c: { state: FlowConversionState; switchAt: Date | null } | null, instant: Date | null, enqueuedWhileUnswitched: boolean): boolean;
export function flowPrefers(c: { state: FlowConversionState } | null): boolean; // true iff switched
```
- **Legacy.** For a row with any conversion, admission calls `claimOccurrence` in its transaction before `createAutomationRunRecord` commits.
  - A conflict returns `{ skipped: 'occurrence_claimed' }`.
  - Event and schedule jobs carry `enqueuedWhileUnswitched`, set by the fan-out or scan from the state it read.
- **Flow.** `createFlowRun` for a flow with a live conversion adds the claim to its `onCreated(tx)`. A conflict rolls back and returns `duplicate` with the existing linkage.
- **Missing timestamp.** A missing or invalid `metadata.timestamp` gives `instant: null`. Legacy prefers it; the flow attempts it only if it is switched (claims dedupe). It is reported to Sentry once per event.
- **`publishEvent`** sends a Sentry message when `occurredAt > now + 60 s`.

- [ ] **Step 1: Failing tests.**
  - `claims.test.ts`:
    - `second engine gets the existing linkage`
    - `pre-claim automation_runs history counts as a claim`
    - `webhook aliases conflict on either key`
    - `claim and run commit together` (a forced failure after the claim leaves no claim)
  - `automationWorker.test.ts`:
    - `job enqueued while unswitched is admitted after the switch when unclaimed`
    - `post-switch event fanned out after the switch is not attempted by legacy`
    - `legacy skips an occurrence the flow claimed`
  - `eventTrigger.test.ts`:
    - `redelivery of a legacy-admitted event is a flow duplicate`
    - `pre-claim legacy run history is honoured`
  - `eventBus.test.ts`: `future occurredAt is reported`.
  - Run → FAIL.
- [ ] **Step 2: Implement.** Classify `claims.ts` in `parkedFanoutModules.ts`.
- [ ] **Step 3: Run** these + every `automationWorker.*.test.ts` sibling (listed: `boundTargets`, `commitBeforeEnqueue`, `eventFanout`, `executionIdentity`, `handleEvent`, `monitorBinding`, `monitorPause`, `resolveAssignment`, `scheduleSiteCeiling`, `scriptEventLoopGuard`, `subjects`) + `runService.test.ts` → PASS. Classes M, A and P are unaffected.
- [ ] **Step 4: Commit** — `git commit -m "feat(flows): automation-wide occurrence claims, atomic with admission on both engines (#5221)"`

### Task B3: Switch transaction

**Files:**
- Create: `services/flows/conversion/switch.ts`, `generatedScripts.ts` (+ tests)
- Modify: `services/flows/versions.ts` (`enableFlow(auth, id, req, opts?: { onPublished?(tx, pub): Promise<void> })`; delete refusal), `routes/flowConversions.ts`, `services/flows/webhook/secret.ts` (`setFlowWebhookSecretFromLegacy(tx, flowId, plaintext)`)

**Interfaces (Produces):**
- `switchConversion(auth, id, req: ConversionSwitchRequest)`.
- Errors: `source_changed | shadow_too_new | shadow_too_short | shadow_divergent | not_shadow | scope_widening_not_accepted | version_conflict | EnableFlowError`.
- Route: `POST /api/v1/flows/conversions/:id/switch`.

**Order, in one transaction as the user:**
1. Lock the ledger row, then the automation row `FOR UPDATE`.
2. Check the state, the source digest against the live row, the document digest against the draft, the 10-minute minimum, the shadow gate or acknowledgement, and `acceptScopeWidening` when `site_ceiling_removed` is present.
3. Create the generated scripts through the normal script-create service as the user, and rewrite their ids into the draft (one draft save).
4. For a webhook trigger, decrypt the legacy secret and call `setFlowWebhookSecretFromLegacy`. It stamps `webhook_secret_rotated_at = flows.updated_at`, so `webhookSecretSurvivesEnable` holds for exactly this publication.
5. `enableFlow(auth, flowId, { expectedVersion, preApprovals }, { onPublished })` runs every W04/W05/A6 check, including the fleet bindings.
6. `onPublished`:
   - ledger: `switched`, `switch_at = now() + SWITCH_LEAD_MS`, `switched_at = now()`, `switched_by`, the acceptance flags;
   - automation: `enabled = false`, `retired_at`, `retired_reason = 'converted_to_flow'`, `converted_to_flow_id`;
   - audit `flow.conversion.switched`.
   - The schedule cursor is stamped as W04 does. Stamped occurrences are ≤ commit < `switch_at`.

- [ ] **Step 1: Failing tests.**
  - `switch is one transaction and switch_at is 60 s ahead`
  - `enable refusal rolls back scripts, secret and ledger`
  - `site-limited user cannot switch`
  - `owner axis is the automation's`
  - `edited source refuses switch`
  - `shadow younger than 10 min refuses even with acknowledgement`
  - `scope widening needs acceptance`
  - `pre-approvals are unticked unless sent`
  - `generated script body equals the command`
  - `fleet pre-approval binds the generated script's digest`
  - `carried secret verifies the old signature and survives enable`
  - `deleting a switched flow is flow_converted_from_automation`
  - Run → FAIL.
- [ ] **Step 2: Implement.** The full `versions.test.ts` must stay green: `onPublished` is optional.
- [ ] **Step 3: Run** these + `versions.test.ts`, `secret.test.ts`, `flowConversions.test.ts` → PASS.
- [ ] **Step 4: Commit.**

### Task B4: Revert, the admission/execution split, and shadow hooks

**Files:**
- Create: `services/flows/conversion/revert.ts`, `shadow.ts` (+ tests)
- Modify: `routes/flowConversions.ts`, `jobs/automationWorker.ts` (shadow hooks in fan-out and after run creation), the W04 reconciler

**Interfaces (Produces):**
- `revertConversion(auth, id)`. Errors: `not_switched | revert_closed`.
  - In one transaction: ledger `reverted` with `revert_at = now()`; automation `enabled = true`, the `retired_*` fields NULL, `converted_to_flow_id` NULL; audit.
  - The flow is **not** disabled. `flowPrefers` now returns false, so it admits nothing new. Its runs and intents continue.
- `recordShadow(conversionId, outcome)`: a best-effort conditional increment under system context. Errors go to Sentry and are never thrown into the legacy path.
- **Reconciler:** a reverted generation's flow becomes `disabled`, with **no run cancellation**, when `now() − revert_at > LEGACY_DRAIN_MIN_MS` and the flow has no non-terminal run and no open intent.
- `REVERT_CLOSED` is a module constant that PR E sets.

- [ ] **Step 1: Failing tests.**
  - `revert re-enables legacy and closes flow admission at once`
  - `parked flow run approved after revert still executes`
  - `reconciler disables only drained, aged reverted flows and cancels nothing`
  - `revert of a shadow conversion is not_switched`
  - `shadow fan-out records a flow-only match`
  - `shadow hook failure never fails the legacy run`
  - `counters increment atomically`
  - Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run → PASS. Step 4: Commit.**

### Task B5: Converted-flow schedule mode

**Files:** Modify `jobs/flowScheduleTick.ts` (+ test).

**Behaviour.** For a flow with a live conversion (switched or reverted):
- The occurrence key is the UTC minute (`occurrenceKey.schedule`), not the local wall clock.
- Before fan-out, the tick claims the parent occurrence (`engine 'flow'`, `flow_run_id` NULL) with `claimOccurrence`.
- A conflict consumes the occurrence without running it.
- Per-org children keep W04's `schedule:<key>` dedupe and its retry-unfinished-orgs behaviour, never re-claiming.
- An occurrence at or after `switch_at` is never consumed without an attempt.
- A reverted generation's flow attempts nothing.

All other flows are unchanged.

- [ ] **Step 1: Failing tests.**
  - `DST repeated hour fires twice for a converted flow and once for a plain flow`
  - `occurrence claimed by legacy is consumed without a run`
  - `partner-wide parent claim lets every org's child run`
  - `a failed child org retries without a second parent claim`
  - `enable stamping never consumes an occurrence at or after switch_at`
  - Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run** + `sweepOccurrence` callers' tests → PASS. **Step 4: Commit.**

### Task B6: Legacy webhook forwarding

**Files:**
- Create: `services/flows/conversion/legacyWebhookForward.ts` (+ test)
- Modify: `routes/automations.ts` (webhook handler ~L1898), `services/flows/webhook/ingest.ts` (+ test)

**Interfaces (Produces):** `forwardLegacyWebhook(c, automationId): Promise<Response | null>`. It returns `null` when the row has no switched conversion; legacy then continues and writes claims if any conversion exists. For a switched row, it runs before any legacy verification or Redis write:
- map `x-breeze-event-id`/`x-breeze-nonce` to `X-Breeze-Delivery-Id` when the value matches `FLOW_WEBHOOK_DELIVERY_ID_RE`;
- call `ingestFlowWebhook` with the conversion's flow and the unchanged raw body and other headers;
- return its response.

Flow ingest for a converted flow adds both alias claims inside its `createFlowRun` transaction through B2. A legacy plain-secret header to a switched row gets the uniform 401.

- [ ] **Step 1: Failing tests.**
  - `re-signed retry with a stable delivery id is a duplicate`
  - `identical signed redelivery of a legacy-admitted delivery is a duplicate`
  - `forwarded delivery maps the legacy event id header`
  - `non-object body after the switch is 415`
  - `unconverted row falls through to legacy unchanged`
  - `shadow row falls through to legacy and writes claims`
  - `plain-secret header to a switched row is 401`
  - Run → FAIL.
- [ ] **Step 2: Implement.** Assert `selfManagedDbContextRoutes`, `routerAuthGate` and `writeRoutePermissionGate` are unchanged. **Step 3: Run → PASS. Step 4: Commit.**

### Task B7: Frozen rows, integration, parity, PR B wrap-up

**Files:**
- Modify: `routes/automations.ts` (switched rows refuse PUT/PATCH/DELETE/trigger/run with `409 automation_converted { flowId }`), `services/aiToolsFleet.ts` (`manage_automations` enable/run refuse)
- Create integration suites: `automationConversionRls`, `automationConversionCutover`, `automationFlowParity`

- [ ] **Step 1: Failing route and tool tests.**
  - `PUT, DELETE and trigger on a switched row are 409 with flowId`
  - `manage_automations run on a switched row is automation_converted`
- [ ] **Step 2: Integration suites.**
  - **`automationConversionRls`.**
    - An org token cannot read a sibling org's conversions or claims.
    - It reads its partner's partner-wide conversions but cannot update them.
    - The owner guards raise. Claims reject UPDATE.
    - Repoint on org merge.
    - Guard-flip control: with `USING (true)` the isolation cases go red.
  - **`automationConversionCutover`.** Uses a real DB and Redis, with dispatch and device boundaries mocked.
    - `three hundred events across the switch produce three hundred admissions`: timestamps from −120 s to +120 s, shuffled delivery to both engines, one publisher −20 s, 30 redeliveries after the switch, 5 future `occurredAt`.
    - A schedule across a switch, a revert and a DST fall-back.
    - Partner-wide schedule fan-out.
    - Webhook retries with and without a delivery id.
    - A revert hands later events back once.
    - A parked flow run released after the revert executes.
  - **`automationFlowParity`** (spec §7). Fixtures:
    - schedule + `run_script` on a groups target;
    - the same with an injected per-device dispatch failure under `stop`, under `continue` and under `notify`;
    - event + `send_notification` with a filter, as a positive and a negative case;
    - webhook + `create_alert`;
    - manual + `execute_command` → generated script;
    - an offline device under `queue` and under `skip`.
    - Each fixture runs on the legacy engine and on the switched flow (pre-approvals accepted where eligible, approvals auto-decided otherwise). Compare the effect traces:
      - device dispatches as `(deviceId, script sha256, parameters, effective runAs, offline policy)`;
      - notices as `(channelId, title, message, severity)`;
      - alerts as `(deviceId, severity, title, message)`;
      - per-device action order.
- [ ] **Step 3: Full checks.**
  - tsc `exit=0`, lint.
  - Every touched unit file, the contract and AI-tool contract batches.
  - The new suites + `flowTriggers`, `flowRunnerEndToEnd`, `flowWebhooksRls`, `flowBuiltinsEndToEnd`, `automationsPartnerRls`, `automationReplayIdempotency`, `automationWebhookDbContext`, `automationWorkerPartnerResolution`, `monitorConversionRoundtrip`, `configPolicyAutomationRunRls`, strict `rls-coverage` → PASS, each with more than 0 tests.
  - `pnpm test-stack down`.
- [ ] **Step 4: Open PR B** — `feat(flows): Tool Catalog W06 PR B — conversion switch, occurrence claims, webhook forwarding (#5221)`. Body `Part of #5221` · `Part of #5215`. One review round, Opus on B2, B3, B5, B6. Post the summary comment and append the release notes.

---

## PR C — Web, docs, defaults (completes R1)

### Task C1: API client and locales

**Files:** Create `components/automations/conversion/conversionApi.ts` (+ test). Update locales ×8. Tests: `localeParity`, `translationCoverage`, `no-silent-mutations`.

**Produces:**
- Reads: `previewConversion`, `listConversions`, `getConversion`.
- Mutations, each through `runAction` with the CLAUDE.md catch pattern: `createConversion`, `createConversionsBulk`, `switchConversion`, `revertConversion`.
- Keys:
  - `conversion.fidelity.*`;
  - `conversion.finding.<every code>` (title + one line);
  - `conversion.shadow.*`;
  - `conversion.switch.*`: pre-approvals with `maxTargets`, the frozen-device and live-membership wording, the per-org multiplication, generated scripts, scope widening, delegator lifecycle, webhook URL and body change;
  - `conversion.revert.*`;
  - `jobs.migration.banner.{r1,r2,r3Retired,r3Pending}`;
  - `jobs.migration.newJobOpensFlows`;
  - `flows.detail.movedFromJob`;
  - step rendering for the three built-ins.
- The finding keys are asserted against the shared array.

- [ ] **Step 1: Failing tests.**
  - Mutations use `runAction`.
  - A switch 422 renders inline.
  - Parity fails until all 8 locales are present.
- [ ] **Steps 2–4:** Implement. Run → PASS. Commit.

### Task C2: Jobs page — fidelity, panel, switch dialog, revert

**Files:**
- Create: `FidelityBadge`, `ConversionPanel`, `SwitchDialog`, `JobsMigrationBanner` (+ tests)
- Modify: `AutomationList.tsx`, `AutomationsPage.tsx` (hash `#convert-<id>`), `AutomationEditPage.tsx`
- Modify: `components/flows/FlowStepList.tsx` (rendering for `run_script_on_targets`, `resolve_targets` and `create_alert`)

- [ ] **Step 1: Failing tests.**
  - `badge shows the blocker in words`
  - `panel follows #convert-<id>`
  - `switch disabled until the gate or acknowledgement, never before 10 min`
  - `pre-approvals are unticked by default and need maxTargets`
  - `scope widening checkbox appears with site_ceiling_removed`
  - `delegator lifecycle acknowledgement is required`
  - `revert confirms`
  - `switched row is read-only with a flow link`
  - `no write permission hides actions`
  - **No `react-hooks/*` eslint-disable comments.** The web config has no react-hooks plugin (W05 PR D CI red).
- [ ] **Steps 2–4:** Implement. Run + `no-hash-in-usestate.test.ts` + `pnpm lint` → PASS. Commit.

### Task C3: Flow detail "Moved from Job"

- [ ] API: `getFlow` adds `convertedFrom: { automationId, name, conversionId, state } | null` (shared `FlowDetailDto`). Web: show it on the detail page and hide Delete for a switched flow.
- [ ] **Tests:** `detail shows moved-from`, `delete hidden for switched`. Red first, then implement, run and commit.

### Task C4: Docs, default, release notes

**Files:** `features/automations.mdx`, `features/flows.mdx` (via `update-breeze-docs`); `config/env.ts` (`FLOWS_ENABLED` default `true`); `validate.ts`; compose ×2; `.env.example` ×2; `deploy/environment.mdx`; `docs/release-notes/next-release-draft.md` (append "Flows W06 (R1)" with Decision 11's list).

- [ ] **Step 1: Failing tests:** `FLOWS_ENABLED unset is true`, `=false is false`. `envReadComposeCoverage` and `.env.example` parity must stay green.
- [ ] **Steps 2–4:** Implement. Docs `astro check` reports 0 errors. Commit.

### Task C5: R1 create refusal, contracts, live check, PR C

- [ ] **Step 1: Failing tests.**
  - `POST /automations is 410 with flowsUrl when flows are enabled`.
  - `POST /automations still creates when FLOWS_ENABLED=false`.
  - `managed triage seeding still inserts` (`managedAutomation.test.ts`) and `monitor compile still upserts` (`monitorCompiler.test.ts`) — these pass already.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Contracts, all unchanged and passing:**
  - `MCP_TOOL_COUNT_APPROX`: read the literal; it does not move.
  - `mcp-coverage`/`FROZEN_GAPS`: no new gap.
  - W19 index: always-on ≤ 2,560 B, worst turn < 7,040 B, cap 7,680 B.
  - `effectDigestCoverage`: now includes the fleet built-in, from A6.
  - `orgSettingsWriters`, `featureLinkReaders` (the pinned `automationWorker`/`automationRuntime` config-policy names have not moved), `integrationOrgTargetHoldingOrg` (pinned count), `agentRouteClasses`, `scheduleRegistry.contract`, `parkedFanout`.
- [ ] **Step 4: Live check.**
  - Stack: a wt-stack with `FLOWS_ENABLED=true`, `EVENT_DISPATCH_MODE=enforce` and `flow-event-trigger` in the queue subscribers. AI keys blanked.
  - Seed one Job per conversion-map row and convert all of them. Check the badges.
  - Switch the scheduled script Job with a fleet pre-approval (`maxTargets` set). The pre-switch slot runs on legacy and the next slot as the flow. Add devices beyond `maxTargets`: `binding_drift`.
  - Switch the webhook Job, then `curl` the **old** URL (`openssl dgst -sha256 -hmac`):
    - before the switch;
    - after it, replaying the pre-switch body;
    - after it, re-signed with the same `x-breeze-event-id`. Both post-switch requests return duplicate.
  - Revert. The next delivery runs on legacy.
  - The PagerDuty Job converts. The S+R Job shows "Can't move yet". `POST /automations` returns 410.
  - Screenshots stay local. Tear the stack down and say so.
- [ ] **Step 5: Open PR C** — `feat(web): Tool Catalog W06 PR C — move Jobs to Flows (#5221)`. Body `Closes #5221` or `Part of #5221` per Decision 8, regex-checked. One review round and a summary comment. Merge order A → B → C.

---

## PR D — R2 freeze (release-gated, ≥ 1 release after R1)

### Task D1: Standalone writes return 410

- [ ] **Failing tests.**
  - `PUT/PATCH/trigger/run on an unswitched S row is 410` when flows are enabled.
  - `an S row blocked by event_dispatch_not_durable stays writable`.
  - `FLOWS_ENABLED=false leaves writes open`.
  - `disable and delete work`.
  - `M/A/P rows unaffected`.
  - `manage_automations enable/run on S is automations_moved_to_flows`.
- [ ] Implement, re-key `SAFE_WRITE_SITES`, run, commit. The web edit page is read-only for frozen rows.

### Task D2: Pre-create sweep and startup check

**Files:** Create `services/flows/conversion/precreateSweep.ts` (+ test). Modify `src/index.ts` (detached after `serve()`, the W05d built-in-monitors backfill pattern) and the env plumbing for `FLOW_CONVERSION_SWEEP_DISABLED` (`env.ts`, `validate.ts`, `internalEnvVars.ts`, compose ×2, `.env.example`, docs).

**Produces:** `runConversionPrecreateSweep(): Promise<{ partners: number; created: number; unconvertible: Record<FlowConversionFindingCode, number> }>`.
- One `runOutsideDbContext + withSystemDbAccessContext` transaction per partner.
- It creates shadow conversions through B1's internal entry with `converted_by = NULL` and audit actor `system`, and never switches.
- The outcome goes in `partners.settings.flowConversionSweep`. Classify that write if `orgSettingsWriters` covers partner settings.
- Then `conversionCensus()`. If `enabledUnswitchedS > 0`, log once at error level with the counts and send one Sentry message.

- [ ] **Failing tests.**
  - `creates shadow conversions for convertible S only`
  - `rerun is a no-op`
  - `opt-out skips`
  - `one partner's failure does not stop others`
  - `count check runs after the sweep`
  - Integration `automationConversionSweep` passes on a real DB.
- [ ] Implement, run, commit.

### Task D3: R2 banner, docs, release notes, PR D

- [ ] Banner `r2` with the pending count. Update the docs timeline. Add the "R2" release-notes block (Decision 11).
- [ ] Open PR D (`Part of #5221`). One review round.

---

## PR E — R3 standalone admission retirement (release-gated per installation)

### Task E1: The gate

**Files:** Create `services/flows/conversion/retirementGate.ts` (+ test). Modify `jobs/automationWorker.ts`, `routes/automations.ts`, `revert.ts` (`REVERT_CLOSED = true`), the env plumbing for `LEGACY_JOBS_RETIREMENT_ACCEPTED`.

**Produces:** `resolveRetirementGate(): Promise<{ unswitchedAdmissionOpen: boolean; switchedHistoricalAdmissionOpen: boolean; reason: string }>`. It is computed at boot and refreshed on every scan tick from `conversionCensus()` and the env:
- `unswitchedAdmissionOpen = !(enabledUnswitchedS === 0 || accepted)`.
- `switchedHistoricalAdmissionOpen = !(accepted || oldestSwitchAgeMs > LEGACY_DRAIN_MIN_MS)`.

When the respective flag is closed, the S scan and fan-out branches and the manual routes skip S rows. Unswitched S webhook URLs return `410 automations_retired`. Switched rows keep forwarding.

- [ ] **Failing tests.**
  - `without acceptance and with pending rows nothing changes`
  - `zero pending closes unswitched admission`
  - `acceptance closes both`
  - `M/A/P fan-out unaffected`
  - `config-policy schedule still enqueues`
  - `execute-run still runs an S+R remediation run`
  - `revert is revert_closed`
- [ ] Implement. Update `parkedFanoutModules` guard counts if they move. No file is deleted. Run every `automationWorker.*` and `automationRuntime.*` sibling plus the integration suites from B7, then commit.

### Task E2: Retirement sweep under acceptance

**Produces:** `runLegacyAutomationRetirementSweep(): Promise<{ disabled: number; keptForRemediation: number }>`. It runs only when `LEGACY_JOBS_RETIREMENT_ACCEPTED=true`, chained after D2. For each enabled unswitched S row that is not S+R:
- `enabled = false`, `retired_at = now()`, `retired_reason = 'legacy_engine_retired'`;
- audit `automation.retired_legacy_engine` (actor system);
- one in-app notice per owner, sent to the partner admins.

- [ ] **Failing tests.**
  - `without acceptance nothing changes`
  - `S+R rows survive`
  - `one notice per owner`
  - `each disabled row has an audit event`
  - `rerun disables nothing new`
  - `switched rows untouched`
  - Integration `automationRetirementSweep` → PASS.
- [ ] Implement, run, commit.

### Task E3: Docs, release notes, PR E

- [ ] Banner `r3Retired` or `r3Pending`. Docs. Add the "R3" release-notes block.
- [ ] Open PR E — `feat(flows): Tool Catalog W06 PR E — per-installation standalone admission retirement (#5221)`. Body `Closes #5221` if it was not closed at PR C.
- [ ] One review round, then the close-out below.

---

## Exit checklist (wave done when every box is true)

- [ ] **Migration.**
  - It sorts last at merge, re-runs cleanly, and `pnpm db:check-drift` is clean.
  - No shipped migration was touched.
  - The org FKs are DEFERRABLE.
  - The CHECKs are pinned to the shared arrays.
  - Claims are append-only, including the `ensureAppRole` coverage.
- [ ] **Registries.** Both tables are in `DUAL_AXIS_TENANT_TABLES` + `XOR_OWNERSHIP_DUAL_AXIS_TABLES`, the cascade order, the export policy and the merge registry. `converted_to_flow_id` is classified. The contract suites are green on a real DB, with red-first evidence.
- [ ] **Built-ins and `notify`.** Run-org-only resolution, never truncated, diagnostics preserved. The legacy alert writer and the fleet dispatch were extracted with identical legacy behaviour. `notify` reaches `webhook` and `pagerduty`.
- [ ] **Fleet lane.**
  - No `forEach`.
  - The full `fleet_v1` binding.
  - `maxTargets` applies per step, run and org.
  - Effective elevated is refused.
  - Parked approvals freeze devices.
  - The effect digest is mandatory and covered.
  - Release carries the verified context.
  - Per-device durable rows.
- [ ] **Converter.** Classifier order M > A > P > S. R covers both consumers. Every map row has a fixture. Output is deterministic. Every `exact`/`needs_review` document validates.
- [ ] **Shadow.** Two-way trigger evaluation, digest resets, idle never qualifies, 10-minute minimum.
- [ ] **Claims.** Atomic with admission on both engines. Pre-claim history is honoured. Webhook aliases. UTC keys, parent claims and the cursor rule for converted schedules. The 300-event suite and the parity suite are green.
- [ ] **Switch and revert.** The switch is one transaction with affirmative acceptances. A switched row is frozen, including DELETE. Revert closes admission and keeps execution authority. The reconciler disables only drained, aged reverted flows.
- [ ] **R1.** `POST /automations` returns 410 when flows are enabled. `FLOWS_ENABLED` defaults on. UI, docs and release notes are done. The C5 contracts are unchanged.
- [ ] **R2 (PR D).** Writes are frozen (except rows blocked by their environment). The pre-create sweep and the startup check run. The banner shows.
- [ ] **R3 (PR E).** The per-installation gate. The acceptance-only sweep keeps S+R rows. Revert is closed. Unswitched webhook URLs return 410. No code is deleted.
- [ ] **Spec amended** (Task A0).

## CI traps

- **`effectDigestCoverage` contract.** It enumerates four-eyes and input-aware core surfaces. A supervised built-in escapes it unless A6 adds explicit coverage and makes the digest mandatory, as the supervised `diagnose_connectivity` precedent does.
- **`mcp-coverage` `FROZEN_GAPS`.** A new route file (`flowConversions.ts`) needs a coverage entry (`tool_in_later_wave`, the `flowLimits.ts` precedent), never a new frozen gap.
- **`MCP_TOOL_COUNT_APPROX` pin.** W06 adds no AI tool. Main bumped the pin to 310 during W05, so read it rather than assume.
- **`scheduleRegistry` cron rule.** Every coarse (≥ hourly) repeatable needs a minute-lane slot. W06 adds none: shadow is inline, the post-revert disable and the retirement gate ride existing ticks, and the sweeps run at boot. The legacy `scan-schedules` (60 s) is not in the registry.
- **`parkedFanout`.** Classify every new `services/*` file. Guard counts for `automationWorker.ts` move in B2, B4 and E1.
- **`orgSettingsWriters`.** D2 writes `partners.settings.flowConversionSweep`. Classify it if the contract covers partner settings.
- **`featureLinkReaders`.** It pins `processTriggerConfigPolicySchedule` and `resolveConfigPolicyAutomationContext`. Never rename or move them.
- **`integrationOrgTargetHoldingOrg` pinned count.** New suites must not change it. If one does, explain why in the PR body; never re-pin blindly.
- **`agentRouteClasses`.** W06 adds no agent route. Classify anything under `routes/agents*` that is touched.
- **The web eslint config has no react-hooks plugin.** A `react-hooks/*` disable comment fails `pnpm lint` (W05 PR D).
- **The release-notes draft is a merge-queue hot spot.** Append under a per-PR "Flows W06" heading. Never rewrite it. Enqueue behind a queued PR that touches it.
- **Integration only in CI.** The RLS-coverage, cascade, export, erasure and org-merge suites and the `orgLifecycleFoundations` DEFERRABLE check run only under Integration Tests. `orgMerge.test.ts` goes red only in a full unit run.
- **The pin test reads CHECK text from migrations.** It must read the **new** file for the two error-code CHECKs.
- **Checksum of an edited draft migration.** Re-migrate the test stack after any edit.
- **tsc OOM under a pipe reads as green.** Always run `echo "exit=$?"`. CI uses `tsc --build tsconfig.tests.json`.
- **Line-keyed AI-tool allowlists.** Edits in `aiToolsFleet.ts`, `routes/automations.ts`, `intentService.ts` and `intentReleaseWorker.ts` shift them. Re-key; never delete.
- **BullMQ job ids must not contain `:`.** Claim keys and Redis keys may.
- **New locale keys need all 8 locales.** Keep `humanizedKeyBaseline.json` consistent.
- **Asia/Tokyo host-timezone tests.** `designEvidence`, `patchEvidence`, `sweepEvidence` and `sweepSubjectProbe` fail under `--pool=threads` and pass under `--pool=forks`. This is environmental.
- **`agentIntentConstraints.integration` replays older migrations.** It must re-apply the W06 file if it rewinds the flow CHECKs (the W05 precedent).

## Feature close-out list (#5215 ends with this wave)

- [ ] Run `complete_wave` for #5221 when the PR carrying `Closes #5221` merges. If #5221 closes at PR C, track PRs D and E as `wave` sub-issues.
- [ ] Run `close_feature` for #5215 once every wave sub-issue is closed and R3 has shipped. Post a summary listing the W01–W06 PRs, the spec amendments by wave, and the deferred list.
- [ ] **Open the follow-up feature issue "Managed responses on flows"** (`feature` label; `register_feature` once planned). It covers:
  - classes M, A, P and C, and the R dependency;
  - deleting `automationWorker`, the `automations` queue, `scan-schedules` and the dead S branches;
  - Decision 8's drop sequence;
  - the deployment conversion.
- [ ] File one issue per remaining deferred item:
  - the deployment pre-approval lane;
  - webhook pre-approval for literal selectors;
  - coercing event filters;
  - the for-each and fleet cap;
  - an auto-switch migration grant;
  - the webhook-secret minter residual (#10270);
  - tenant Tier-3 steps without an `externalTool` binding (#10284);
  - agent exposure failures and MCP refusal audit (#10285);
  - the W05 Decision 17 list;
  - the W04 follow-ups;
  - the platform event route-enqueue drop (`eventDispatchQueue.ts`);
  - Decision 6's residuals (a) and (b).
- [ ] Docs: at R3, `features/automations.mdx` becomes a history page that points to Flows.
- [ ] Run the release skill for R1, R2 and R3 with Decision 11's notes. Deploy per `docs/agents/merge-and-deploy.md`.
- [ ] Memory: move the closed-feature entry to the newest archive.

## Self-review (done at authoring)

- **Spec coverage (§7 and the W6 row).** Each §7 element has an owner:
  - trigger → trigger;
  - conditions/target → `resolve_targets` or the fleet selector (no `find_devices` tool exists);
  - actions → steps, with `onFailure` (A7);
  - the `create_alert` gap (A4, Decision 13, disagreement recorded);
  - "queued is success" (the fleet built-in keeps it);
  - "deploy after fan-out" — corrected, deploy is a blocker (Decision 18);
  - opt-in conversion that creates a draft alongside and disables the automation only on enable (B1, B3);
  - the parity test (B7);
  - the retirement gate (D2, E1, E2);
  - "tables frozen, not dropped" (Decision 8).
  - Beyond §7: the class inventory, the fleet lane, claims and per-installation retirement.
- **Placeholders.**
  - The migration slot is assigned by the orchestrator by design.
  - The W04 reconciler file is found by grep: a lookup, not a decision.
  - The cron-equivalence fixture is decided by reading both implementations in A7, with the assertion pinned either way.
- **Type consistency.** These names are the same in every task: `classifyAutomation`, `convertAutomation`, `ConversionContext`, `ConversionResult`, `automationSourceDigest`, `loadConversionContext`, `isComplianceRemediationTarget`, `resolveTargetsOnce`, `executeResolveTargets`, `executeCreateAlert`, `createAutomationStyleAlert`, `dispatchScriptToDevices`, `executeRunScriptOnTargets`, `FleetBindingV1`, `fleetPreApprovalEligibility`, `buildFleetBinding`, `revalidateFleetBinding`, `fleetEffectDigest`, `occurrenceKey`, `claimOccurrence`, `liveConversionForAutomation`, `legacyPrefers`, `flowPrefers`, `evaluateShadow`, `wouldParkSteps`, `recordShadow`, `conversionCensus`, `previewConversion`, `createConversion`, `createConversionsForOwner`, `switchConversion`, `revertConversion`, `setFlowWebhookSecretFromLegacy`, `forwardLegacyWebhook`, `runConversionPrecreateSweep`, `resolveRetirementGate`, `runLegacyAutomationRetirementSweep`.
- **Proportion.** The plan pins signatures, values, codes and test names. Bodies appear only for the switch order, the DDL list, the claim/preference rules and the fleet binding fields, which the signatures do not determine.
