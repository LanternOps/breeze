---
title: Retention windows for high-volume tables (and enforcing the client-AI transcript setting)
issue: 4342
status: draft
date: 2026-11-08
base: main @ ad73e1d888
---

# Retention windows for high-volume tables

Evidence labels: **verified** = read in code at `ad73e1d888`; **inferred** = reasoned from code, not run; **not checked** = an open fact the plan must confirm. Paths are under `apps/api/` unless they start with `apps/`, `packages/` or `docs/`.

## 1. Problem

The 2026-09-01 sweep (#4342) found tables whose rows leave only when a device or tenant is deleted. Two months on, several of them have been fixed, and the rest have not. Re-inventoried at `ad73e1d888`:

**Fixed since the issue was filed (verified; this spec does not touch them):**

| Table | Job | Window |
|---|---|---|
| `ai_screenshots` | `src/jobs/helperScreenshotRetention.ts:44` calls `deleteExpiredScreenshots()` (`src/services/screenshotStorage.ts:249`), 4× daily | per-row `expires_at` |
| `dns_security_events`, `dns_event_aggregations` | `src/jobs/dnsSecurityRetention.ts`; the sync job no longer prunes inline (`dnsSyncJob.noInlineRetention.test.ts`) | integration `retentionDays`, else `DNS_SECURITY_RETENTION_DAYS_DEFAULT` = 90 |
| `webhook_deliveries` | `src/jobs/webhookDeliveryRetention.ts` (terminal rows only, keeps the newest failure per webhook) | `WEBHOOK_DELIVERY_RETENTION_DAYS` = 90 |
| `llm_egress_events` | `src/jobs/llmEgressRetention.ts` (folds into daily rollups) | `LLM_EGRESS_EVENTS_RETENTION_DAYS` = 90 |
| `ai_messages.tool_output`, `ai_tool_executions.tool_output` | `src/jobs/aiToolOutputRetention.ts` tombstones the column; rows stay | `ai_data_policies.tool_output_retention_days`, default 30 |

**Still unbounded (verified: no age-based delete in `src/jobs/` or `src/services/`):**

- **Tier 1, per-device writers.** `device_commands`, `script_executions`, `script_execution_batches`, `alerts` (and its cascade children `alert_notifications`, `alert_correlations`, `alert_correlation_members`), `alert_correlation_groups` (orphaned by `SET NULL` on `root_alert_id`), `network_monitor_results`, `device_sessions`, `device_filesystem_snapshots`. On the larger production deployment at sweep time, `device_commands` was 624 MB (about 67 KB/row in TOAST) and `device_filesystem_snapshots` was 1.1 GB (about 200 KB/row of jsonb). Those sizes are from the issue and were not re-measured.
- **Tier 2, AI.** `ai_sessions`, `ai_messages` (the prose, `content_blocks` and `tool_input` are never touched), `ai_tool_executions` (only `tool_output` is scrubbed), `ai_agent_runs`.
- **Tier 3, snapshots and run history.** `patch_job_results`, `security_posture_snapshots`, `cis_baseline_results`, `automation_runs` with `automation_run_device_results` and `automation_action_results`, `report_runs`, `user_notifications`, `remote_sessions`, `support_sessions`, `sessions` (auth).
- **`network_change_events`: worse than the issue said.** `handlePruneChangeEvents` (`src/jobs/networkBaselineWorker.ts:386-408`) prunes only profiles with alerts enabled. Nothing enqueues `prune-change-events` anyway: the type and the switch case (`:63`, `:96`) are its only appearances, and `scheduleRegistry.ts` has no slot for it. So the table is never pruned (verified by grep).

**Settings that promise retention and do nothing:**

- `client_ai_org_policies.retention_days` (`src/db/schema/clientAi.ts:57`, nullable, "NULL = keep forever"). The UI labels it "Transcript retention (days)" (`apps/web/src/locales/en/ai.json:316`). The API route accepts 1–3650 or null (`src/routes/clientAi/schemas.ts:103`). No job reads it (verified). Per the 2026-11-08 correction on the issue, it governs client-AI **transcripts**, not `client_ai_usage`.
- Code comments claim `device_commands` "keeps its own retention" or is "pruned independently" (`src/db/schema/filesystem.ts:66`, `oemUpdates.ts:45`, `endpointConversations.ts:56`, `endpointMessages.ts:102`). Nothing implements that.

**Excluded from retention work (verified):**

- `unifi_device_telemetry` is an upsert keyed by `(collector_id, unifi_device_id)` (`src/services/unifi/unifiTelemetryService.ts:223`). It is bounded by device count.
- `ai_cost_usage` and `client_ai_usage` are per-period rollups (unique on org/user/period). `client_ai_usage` is the dataset behind the resale CSV (`src/routes/clientAi/adminUsage.ts:125`, pinned headers at `:18`, `:31`). It must never be purged under the transcript setting.
- `patch_compliance_snapshots` has no writer (`src/services/aiAgents/narrativeContext.ts:1058` says so, and grep agrees). Drop it; don't prune it (OD 9).

## 2. Users and scope

| Concern | Level | Who |
|---|---|---|
| Operational telemetry windows (commands, scripts, monitors, sessions, filesystem, Tier 3) | **Operator** (env, per deployment) | Self-hosters and Breeze SaaS ops. No tenant UI (OD 5). |
| Alert history window | **Operator** in v1 (OD 5) | Same. |
| Client-AI transcript retention | **Org**, existing field on `client_ai_org_policies` (copy-on-create from partner defaults, no live inheritance; spec `docs/superpowers/specs/ai-mcp/2026-06-12-breeze-ai-for-office-design.md:69`) | Partner users who administer Client AI for that org. The field exists today; this spec makes it true. |
| Technician-AI transcript retention | **Partner default → org tighten-only**, new field on `ai_data_policies` (OD 4) | Partner admins (partner card), org admins (org card). Same screens and resolver as tool-output retention. |
| Audit trail lifetime | **Org**, existing `audit_retention_policies.retention_days` (default 365, `src/db/schema/audit.ts:82`) | Unchanged. This spec reuses it as the lifetime of AI session stubs (OD 3). |

## 3. Proposed design

### 3.1 One job pattern, reused

Every new pruner follows the shape the newer jobs already use (verified in `webhookDeliveryRetention.ts`, `llmEgressRetention.ts`, `monitorEpisodeRetention.ts`):

- `pruneInCtidBatches({ table, where, batchSize, maxBatches, label })` from `src/jobs/retentionBatch.ts`. Each batch is its own short system transaction. Callers never wrap the loop in a context (the older `deviceMetricsRetention.ts` does, and should not be copied).
- `resolveRetentionDays(env, default, max)` and `parsePositiveIntEnv` for knobs. Names follow `<NAME>_RETENTION_DAYS`, `_BATCH_SIZE`, `_MAX_BATCHES`, plumbed through `deploy/docker-compose.prod.yml`.
- `recordRetentionRun(name, { rowsDeleted, incomplete })` and `warnOnRetentionBacklog` so a backlog that outruns the batch cap reaches Sentry.
- One `JOB_SCHEDULES` slot per job in the daily lane (minute ≡ 3 mod 5, `src/jobs/scheduleRegistry.ts:35`); the contract test rejects collisions. Worker `concurrency: 1`.
- Terminal states only. A row in a non-terminal state is never eligible, whatever its age.
- **Content first, rows later** where the history is user-facing. The heavy content (stdout, payloads, transcripts) goes at the short window, and the metadata row (what ran, when, who, outcome) at the long one. This is the `aiToolOutputRetention` precedent: tombstone, keep the row.
- **Keep-latest guards** where a reader takes "newest row per key", so pruning can never change what a live screen or evaluator shows.

**Indexes.** Most sweep predicates have no supporting index (verified: no plain index on `device_commands.completed_at`, `script_executions.completed_at`, `alerts.resolved_at`, `alert_notifications.created_at`, `device_sessions.logout_at`, `ai_sessions.last_activity_at`, `ai_messages.created_at`). Each wave adds partial indexes that match its predicate, built `CREATE INDEX CONCURRENTLY` under `-- @no-transaction` with the INVALID-index guard used by `migrations/2027-01-19-110300-alerts-rule-device-subject-closed-idx.sql`. The migration name must sort after the newest committed file. Shipped names currently run into 2027, so check rather than use today's date.

**First run.** On an upgraded install, the first run sees months of backlog. `maxBatches` caps each night, so the drain spreads over several nights and `warnOnRetentionBacklog` reports it. Deleted TOAST pages are reused by autovacuum but not returned to the OS. Shrinking the 624 MB and 1.1 GB tables needs a one-time `pg_repack` or `VACUUM FULL`, which is an operator step (OD 9), not code.

### 3.2 Per-table windows

Defaults are a proposal for OD 6. "Env" = operator knob with the default shown and a hard max. "Eligible" lists every condition; all must hold.

| Table | Eligible | Default | Max | Knob | Notes |
|---|---|---|---|---|---|
| `device_commands` | status in (completed, failed, timeout, cancelled) and `COALESCE(completed_at, created_at)` older than the window | 120 d | 365, **min 90** | env `DEVICE_COMMAND_RETENTION_DAYS` | Transport rows. The fleet patch list reads `install_patches` commands as install attempts for 90 d (`DEVICE_INSTALL_LOOKBACK_MS`, `src/services/patchInstallFailures.ts:57`), so the knob may not go below that. The plan links the two constants. No RLS and no `org_id` (system path; `submitted_org_id` is provenance), so a tenant knob would need a device join. FKs in: `backup_storage_sessions.command_id` CASCADE (short-lived leases, meaningless without the command); the rest SET NULL (verified). Status is an unconstrained varchar (`devicePurgeUninstallGate.ts:135`), so the predicate lists terminal values explicitly. |
| `script_executions` | terminal (completed, failed, timeout, cancelled; not `cancelling`) | **scrub** `stdout`/`stderr` at 90 d; **delete** row at 365 d | 1095 | env `SCRIPT_EXECUTION_OUTPUT_RETENTION_DAYS`, `SCRIPT_EXECUTION_RETENTION_DAYS` | The device Scripts tab shows the last 50 with no age cut (`src/routes/devices/scripts.ts:73`). Keep the newest terminal row per `(device_id, script_id)`: `scriptMonitor` reads it as the probe's latest result (`src/services/alertConditions/handlers/scriptMonitor.ts:137`). FKs in are SET NULL. |
| `script_execution_batches` | terminal and `completed_at` past the row window | 365 d | 1095 | same as row window | No FK from executions (the batch id rides in the command payload). |
| `alerts` | status in (resolved, dismissed), `COALESCE(resolved_at, dismissed_at)` past the window, **not** the newest closed alert per `(rule_id, device_id, subject_key)`, **not** linked to a ticket or PSA mapping (OD 7) | 365 d | 1095 | env `ALERT_RETENTION_DAYS` | The newest-closed row is the sweep's frozen evidence cursor (#10538). The index `alerts_rule_device_subject_closed_idx` already serves it. `alert_notifications`, `alert_correlations`, `alert_correlation_members`, `alert_external_refs` and `ai_alert_verdicts` cascade. **FK blockers:** `log_correlations.alert_id` and `network_change_events.alert_id` are NO ACTION (verified: `src/db/schema/eventLogs.ts:128`, `discovery.ts:345`; `migrations/2026-11-01-100000-…` fixed `profile_id` only). This wave changes both to SET NULL. |
| `alert_correlation_groups` | `root_alert_id IS NULL`, no members, `last_seen_at` past the window | 365 d | — | follows `ALERT_RETENTION_DAYS` | Orphaned by alert deletion. |
| `network_monitor_results` | `timestamp` past the window, **not** the newest row per `monitor_id` | 30 d | 365 | env `NETWORK_MONITOR_RESULT_RETENTION_DAYS` | The keep-newest guard means a paused monitor still shows its last verdict. The highest-rate writer (one row per check, `src/jobs/monitorWorker.ts:510`). Readers take the latest 20–100 (`src/routes/monitors.ts:451`, `:607`). The only Tier 1 table with an age index already. Matches `device_metrics` at 30 d. |
| `device_sessions` | `is_active = false` and `logout_at` past the window | 365 d | 1095 | env `DEVICE_SESSION_RETENTION_DAYS` | The UI and AI tool cap `daysBack` at 365 (`src/routes/devices/sessions.ts:208-286`, `src/services/aiToolsPerformance.ts:782`). `userRiskScoring` reads it (window not checked). |
| `device_filesystem_snapshots` | not the newest per `(device_id, scan_path)` and `captured_at` past the window | 7 d | 365 | env `FILESYSTEM_SNAPSHOT_RETENTION_DAYS` | The only readers are `filesystemAnalysis.ts:112` and `:133` (newest per key) and the threshold-scan cooldown at `src/routes/agents/helpers.ts:1813` (verified: those are all the references outside schema and registries). Superseded snapshots have no reader, so the window is short. No FKs in. The biggest byte win. |
| `ai_sessions` / `ai_messages` / `ai_tool_executions` | §3.3 | §3.3 | — | tenant settings (§3.3) | — |
| `ai_agent_runs` | `finished_at` past the window, **not** referenced by any `action_intents.requesting_agent_run_id` | 400 d | 1095 | env `AI_AGENT_RUN_RETENTION_DAYS` | Matches `AI_AGENT_EVIDENCE_RETENTION_DAYS` (400). **FK blocker:** `action_intents` → `(ai_agent_runs.id, org_id)` is ON DELETE RESTRICT (`src/db/schema/actionIntents.ts:526-530`, verified). Whether intents age out first: **not checked**. Other FKs into it: **not checked**. |
| `patch_job_results` | `created_at` past the window, parent `patch_jobs` terminal | 365 d | 1095 | env `PATCH_JOB_RESULT_RETENTION_DAYS` | No `org_id` (scoped via `job_id`). `patchEvidence.ts:28` reads `output`; `patchInstallFailures.ts:224` windows not checked. |
| `security_posture_snapshots` (device) | `captured_at` past the window | 365 d | 1095 | env `SECURITY_POSTURE_SNAPSHOT_RETENTION_DAYS` | Trend and portal readers (`src/services/securityPosture.ts:696`, `:990`; `services/portal/securityReadModel.ts:41`). Their windows are **not checked**; the plan confirms none reads past 365 d. The org-level snapshots (one per org per capture) are small and stay. |
| `cis_baseline_results` | not the newest per `(device_id, baseline_id)` and `checked_at` past the window | 365 d | 1095 | env `CIS_BASELINE_RESULT_RETENTION_DAYS` | Dashboards read the newest per device. `cis_remediation_actions.baseline_result_id` is SET NULL. |
| `automation_runs` (+ children) | status terminal and `completed_at` past the window | 180 d | 1095 | env `AUTOMATION_RUN_RETENTION_DAYS` | Children cascade on `run_id` (`src/db/schema/automations.ts:194`, `:218`). `automation_run_device_results.output` is the heavy part. |
| `report_runs` | terminal and `completed_at` past the window, **not** referenced by `service_deliverables` / `service_deliverable_evidence` / `fleet_design_applied_items` (OD 8) | 365 d | 1095 | env `REPORT_RUN_RETENTION_DAYS` | Those children CASCADE, so deleting the run would delete deliverable evidence. Output files (`artifact_id`, `output_url`): cleanup path **not checked**. |
| `user_notifications` | read and `read_at` past 90 d, or any row past 365 d | 90 / 365 d | 1095 | env `USER_NOTIFICATION_RETENTION_DAYS` | `wisp_thread_posts.notification_id` is SET NULL. Whether an unread notification can carry a still-actionable approval: **not checked**. If one can, it is exempt. |
| `remote_sessions` | ended and `ended_at` past the window | 365 d | 1095 | env `REMOTE_SESSION_RETENTION_DAYS` | **FK blocker:** `file_transfers.session_id` is NO ACTION (`migrations/0001-baseline.sql:12743`). Delete the transfers first, or change the FK to CASCADE (OD 8). Recording files: **not checked**. |
| `support_sessions` | status terminal and `ended_at` past the window | 365 d | 1095 | env `SUPPORT_SESSION_RETENTION_DAYS` | One CASCADE child (`migrations/2026-08-13-a-quick-support-sessions.sql:86`, not identified). |
| `sessions` (auth) | `expires_at` older than 7 d | 7 d | 90 | env `AUTH_SESSION_RETENTION_DAYS` | Whether the live auth flow still writes this table: **not checked**. |
| `network_change_events` | `detected_at` past the profile's `alertSettings.changeRetentionDays`, else 90 d (also for `profile_id IS NULL`) | 90 d | 365 | existing per-profile field; env default | Schedule the existing handler and drop its "alerts enabled" filter. |

### 3.3 AI transcripts: tech and client sessions, one job

**What a transcript is.** It is the conversation content: `ai_messages` (prose, `content_blocks`, `tool_input`, `tool_output`), `ai_tool_executions.tool_input` / `tool_output`, `ai_action_plans`, `ai_screenshots` rows for the session, and the content-bearing columns on the session row (`title`, `workbook_name` and similar). It is **not** the session's accounting and review metadata: type, principal, model, timestamps, `turn_count`, token and cost totals, flag state.

**Purge = stub, not delete (OD 1).** When a session's `last_activity_at` passes its window and the session is `closed` or `expired`, in one statement per batch:

1. Delete its `ai_messages`, `ai_action_plans` and `ai_screenshots` rows. The last two have NO ACTION FKs that would block a session delete (verified: `src/db/schema/ai.ts:410`, `:432`; baseline `:10741`, `:10807`). `ai_tool_executions.message_id` is SET NULL.
2. Tombstone `ai_tool_executions.tool_input` and `tool_output` with the `{"_retention":"scrubbed","at":…}` shape `aiToolOutputRetention` already uses. The row stays: tool name, status, approver, timestamps and `tool_use_id`.
3. On the session row, null `title`, `workbook_name`, `flag_reason` (free text) and `sdk_session_id`, and set a new `transcript_purged_at` timestamp. The admin viewers render "Transcript removed by retention on <date>" instead of an empty conversation. The SDK transcript file is deleted after commit, as `aiToolOutputRetention` does.

Live-session deferral reuses `aiToolOutputRetention`'s quiet-window rule, so a session still in some API process's memory is not cut mid-conversation.

**Windows.**

- **Client sessions** (`type IN CLIENT_SESSION_TYPES`, `client_user_id` set): `client_ai_org_policies.retention_days`. NULL keeps forever, exactly as the UI says. No partner fallback at run time, because the policy is copy-on-create by design.
- **Technician sessions** (everything else): a new `ai_data_policies.transcript_retention_days` resolved by `mergeAiDataPolicies`. The partner row is the ceiling, and an org row may only tighten it. Partner NULL means keep forever. With no partner row, the code default applies: **365 d** (OD 4). Tool-output retention keeps its own field and its 30 d default. It already applies to client sessions too, because `aiToolOutputRetention` has no type filter (`:164-170`, verified), and it stays that way.

**Flagged sessions are held (OD 2).** A session with `flagged_at` set is skipped while flagged, whatever its window. Unflagging releases it on the next run. The admin viewers already filter on the flag (`src/routes/clientAi/adminSessions.ts:103`, `src/routes/ai.ts:439`), so a held session is visible.

**Stub lifetime and the approval trail (OD 3).** A stub, with its scrubbed `ai_tool_executions` rows, is hard-deleted once `last_activity_at` is older than the org's `audit_retention_policies.retention_days` (default 365) **and** its transcript is already purged. Deleting the stub cascades the tool-execution rows (verified, `migrations/2026-12-13-110200-org-erasure-fk-child-actions.sql:102-108`). The durable approval trail is `audit_logs`. Client tool approve/reject/apply write `ai.client_session.tool_execute` and `ai.client_session.tool_reject`, with the portal user as actor and the tool name, `toolUseId` and outcome in `details` (`src/services/clientAiTools.ts:622-650`, verified). They do **not** carry the input values. `audit_logs` is governed by the same per-org window, so the two trails end together.

Two facts keep the scrubbed `ai_tool_executions` rows from being redundant:

- `audit_logs` is written fire-and-forget (`writeAuditEvent`, `src/services/auditEvents.ts:210-213`, verified), so it is not proven complete. The tool rows are the strict record for the same lifetime.
- Keying the stub delete on `last_activity_at` means every audit row about the session is at least as old, so audit retention has already removed them. The topology audit filter joins `ai_sessions` to withhold rows about hidden topology sessions (`src/routes/ai.ts:123-140`). The plan makes it fail closed on a missing session anyway, so a straggler can never become visible.

**What transcript retention does not reach.** Technician-session audit rows (`resource_type = 'ai_session'`) carry the tool input (the comment at `src/routes/ai.ts:123-126`). They live for the audit window, not the transcript window, and `audit_logs` is append-only. The technician settings card says so. Client-session audit rows carry no input values, so the client promise holds as worded.

**Billing is unaffected.** The resale CSV and the usage rollup read only `client_ai_usage`, which has no FK to `ai_sessions` (verified). Cost history lives in `ai_cost_usage`. Chargeback reads `ai_invocations`, which has its own floor (`src/jobs/aiInvocationRetention.ts:43`).

### 3.4 Activation grace for tenant-visible deletion

`client_ai_org_policies.retention_days` has been inert since it shipped. An org that set "30" months ago would lose every older conversation on the first night after W4 deploys. The same applies to the new technician default. So W4 ships in two steps (OD 10):

1. **Preview release.** The job runs in report-only mode (`AI_TRANSCRIPT_RETENTION_ENFORCE=false`, the default in that release). It computes per-org eligible counts and records them through `recordRetentionRun`. Both settings cards show "N conversations are older than this window and will be removed once retention is enforced".
2. **Enforcing release.** The next release flips the default. Release notes for both releases name the setting and the date.

After enforcement, lowering a window shows the same preview count before Save, since the next nightly run acts on it. The operational waves (W1–W3, W5) enforce on deploy: they delete no tenant-configured promise, and the release notes carry the windows.

### 3.5 Settings (Rule 9)

| Concept | Home | Level | Resolver | Places configured before → after |
|---|---|---|---|---|
| Client-AI transcript retention | Client AI policy editor (`apps/web/src/components/clientAi/PolicyEditor.tsx`) | Org (copy-on-create) | new `resolveClientTranscriptRetention(orgId)` reading `client_ai_org_policies` | 1 → 1 (it starts being enforced) |
| Technician-AI transcript retention | AI data policy cards (`PartnerAiDataPolicyCard.tsx`, `OrgAiDataPolicyCard.tsx`) | Partner default → org tighten-only | `mergeAiDataPolicies` (`src/services/aiDataPolicy.ts:22`), extended | 0 → 1 (new concept, not a duplicate) |
| AI tool-output retention | Same cards | Same | Same | 1 → 1 |
| Audit retention (now also AI stub lifetime) | `OrgAuditRetentionSettings.tsx` | Org | `auditRetentionPolicyService` | 1 → 1 |
| Network change-event retention | Discovery profile alert settings | Per profile | existing handler | 1 → 1 |
| Every operational table in §3.2 | none (env) | Operator | `resolveRetentionDays` | 0 → 0 |

Both AI transcript fields say which conversations they govern ("Client AI conversations" vs "Technician AI conversations") and link to each other, so neither reads as the only AI retention knob.

## 4. Tenancy and data model impact

- **No new table.** Columns: `ai_data_policies.transcript_retention_days integer NULL` (CHECK > 0, same semantics as `tool_output_retention_days`) and `ai_sessions.transcript_purged_at timestamptz NULL`.
  - `ai_data_policies` is already registered in cascade, merge and export (`src/services/tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts`, verified by grep). The new integer column needs an export-policy classification.
  - `ai_sessions.transcript_purged_at` needs one too. Neither is json, so neither is `excludedOpen` by rule.
- **FK changes (alerts and remote-session waves):**
  - `log_correlations.alert_id` and `network_change_events.alert_id` NO ACTION → SET NULL.
  - `file_transfers.session_id` NO ACTION → CASCADE or SET NULL (OD 8).
  - `ai_action_plans.session_id` and `ai_screenshots.session_id` NO ACTION → CASCADE, so a stub delete never trips on a straggler.
  - Each change uses the idempotent drop-unless-already-correct pattern of `migrations/2026-11-01-100000-discovery-history-fk-set-null.sql`. None of them names `org_id`, so the DEFERRABLE rule for composite org FKs does not apply.
- **RLS.** Jobs run in system scope (`withSystemDbAccessContext` per batch via `pruneInCtidBatches`). No policy changes. `device_commands` has no RLS today, and this does not change it.
- **Indexes.** Partial, CONCURRENTLY, one migration per wave (§3.1).

## 5. Out of scope

- Tenant-facing knobs for operational tables (OD 5 records the call).
- Legal hold beyond the flag hold in §3.3. A real hold is its own feature.
- Shrinking existing table files on disk (OD 9: an operator runbook step).
- Second-pass candidates the inventory grep flagged but did not verify: `agent_rollback_events`, `audit_baseline_results`, `fleet_remediation_runs`, `deployment_results`, `ticket_import_runs`, `unifi_sync_runs`, `topology_diagnostic_runs`, `recovery_key_access_events`, `ml_feedback_events`, `peripheral_policy_delivery_events`, `ai_budget_alert_events`. Expiry-shaped tables Codex named also belong here: `mobile_sessions`, `sso_sessions`, `c2c_consent_sessions`, `tunnel_sessions`. OAuth already has expiry + 7 d cleanup (`src/oauth/provider.ts:185`). The plan's last wave verifies each or files a follow-up.
- `ai_cost_usage` and `client_ai_usage`. Codex suggested multi-year windows for both. They are per-period rollups (tiny), billing-grade, and outside this issue's growth problem.
- Changing any window that already ships (§1 table).

## 6. Open Decisions

1. **Client-AI transcript purge: stub the session or delete it?**
   - (a) **Stub.** Delete messages, plans and screenshots; tombstone tool input and output; keep the session row's metadata (§3.3).
   - (b) Delete the session row; everything cascades.
   - (c) Delete `ai_messages` only. This leaves `tool_input` (the values written to the workbook) behind, so the "transcript retention" promise would be false.
   - **Recommend (a).** The cost, token and flag columns are accounting and review metadata, not transcript. The admin viewer can say why the conversation is gone. Stub deletion is handled separately in OD 3. The same rule applies to technician sessions.
2. **Flagged sessions past their window?**
   - (a) **Hold while flagged.**
   - (b) Purge anyway.
   - (c) Hold for a fixed extra period.
   - **Recommend (a).** A flag is an open review request, so deleting its evidence defeats it. Unflagging releases the hold, and held sessions are already listed by the flag filter.
3. **How long do the scrubbed `ai_tool_executions` rows and the write-approval trail live?**
   - (a) **Until the org's audit-retention window** (default 365). The stub and its tool rows are hard-deleted together.
   - (b) Forever, as stubs.
   - (c) A new dedicated knob.
   - **Recommend (a).** `audit_logs` already holds the actor, tool, outcome and time of every client approve, reject and apply under that window. Because it is written fire-and-forget, the scrubbed tool rows stay alongside it as the strict copy for exactly the same lifetime. Tying the stub to that window means one concept ("how long audit-grade history is kept") governs both, and adds no new setting. If Todd wants the approval rows to outlive `audit_logs`, the answer is (b), not a third knob.
4. **Technician-AI transcripts: add a tenant knob, and what default?**
   - (a) **New `ai_data_policies.transcript_retention_days`** (partner ceiling, org tighten-only), code default 365 d.
   - (b) Same field, code default "keep forever". This is opt-in and deletes nothing on upgrade.
   - (c) Operator env only.
   - (d) Leave technician transcripts unbounded.
   - **Recommend (a).** AI data policy is already the home for "how long AI data is kept", with the partner-wide-first shape. Prose is the bulk that `tool_output_retention_days` leaves behind. A bounded default is the point of #4342. The 365 d default deletes conversations older than a year once enforced, so it goes through the §3.4 preview release.
   - **Quorum split:** Codex proposed 90 d for transcripts and 365 d for the metadata stub. I chose 365 d because technicians reopen and continue sessions (`continued_from_session_id`), and tool output, the sensitive part, already goes at 30 d. The new field is only a default: a partner can set 90.
5. **Operational tables (commands, scripts, alerts, monitors, sessions, filesystem, Tier 3): tenant-facing windows?**
   - (a) **Operator env only in v1.**
   - (b) A new partner-wide-first `data_retention_policies` table now.
   - (c) Alerts only as a tenant knob.
   - **Recommend (a).** No tenant has asked. This matches the 20+ existing pruners (`device_metrics`, `webhook_deliveries`, `llm_egress_events` and others are all env). It keeps the Rule 9 count at 0. If an MSP needs longer alert history for compliance, (c) is the first knob to add, shaped as `org_id XOR partner_id` per the #2135 playbook.
   - **Quorum disagreement:** Codex recommends (b) now. Its version is a typed, partner-XOR-org `data_retention_policies` with one row per **class** (operational, incident/alerts, compliance snapshots, reports, access history), not per table. Its argument: contractual and access history (alerts, remote sessions, patch evidence) is something an MSP owes its customers.
   - I agree that the class shape is right **if** knobs come. I disagree on timing. Five new tenant settings with no demand raise the Rule 9 count by five. The env windows can be lifted into that table later without a data migration, because nothing tenant-side is stored today.
   - Todd's call: (a), or (b) with the class shape.
6. **Approve the default windows in §3.2?** Headline numbers:
   - commands: 120 d (floor 90 for the patch lookback)
   - script output: 90 d; script rows: 365 d
   - closed alerts: 365 d
   - monitor results: 30 d, keep newest
   - device sessions: 365 d
   - filesystem snapshots: 7 d, keep newest
   - automation runs: 180 d
   - most Tier 3: 365 d

   **Recommend as listed.** Each default sits at or above the longest reader window found (the 365 d `daysBack` cap, the 90 d patch lookback, the latest-N readers) and below the cap. Readers marked "not checked" are confirmed in the plan before their wave ships.
   - Codex differed at the edges: 400 d for alerts, device sessions and Tier 3; 90 d for automation runs. None of these is a principled gap. 365 d keeps one number aligned with the audit default and the session UI cap.
7. **Alert exemptions?**
   - (a) **Keep the newest closed alert per (rule, device, subject), and keep any alert linked to a ticket or PSA mapping.**
   - (b) Keep only the cursor rows; ticket links cascade away.
   - (c) No exemptions.
   - **Recommend (a).** The cursor row prevents a re-fire on stale evidence (#10538). The ticket and PSA link rows cascade on alert delete, so a ticket would silently lose its linked alert. Linked alerts are a small share. Note: the partner API alert feed does not report deletions (`src/routes/partnerApi/alerts.ts:49`), so the docs must say feed consumers keep their own history.
8. **History rows that back other evidence (`report_runs` under deliverables or fleet-design applies; `remote_sessions` with file transfers)?**
   - (a) **Skip report runs that back evidence. Delete file transfers with their session** (FK → CASCADE).
   - (b) Skip both.
   - (c) Prune both and let evidence go.
   - **Recommend (a).** Deliverable evidence is customer-facing proof of work. A file-transfer row is session detail with no meaning after its session ages out.
9. **One-time cleanup outside the jobs:**
   - Drop the writer-less `patch_compliance_snapshots` in its own PR (with cascade, merge and export de-registration).
   - Run `pg_repack` on `device_commands` and `device_filesystem_snapshots` on each production deployment after the first drain.

   **Recommend both**, as follow-ups tracked on #4342. Neither belongs in the retention jobs.
10. **Enforcing a setting that has been inert since it shipped (client `retention_days`, plus the new technician default)?**
    - (a) **One preview release with counts, then enforce** (§3.4).
    - (b) Enforce on deploy, release-noted.
    - (c) Enforce only for policies saved after deploy.
    - **Recommend (a).** Admins who set the field believed it was already working, and the first run is irreversible. (c) leaves the old promise false for everyone who set it before.

## 7. Test and rollout notes

- **Waves** (sketch for the plan; each is independently shippable):
  - W1: `device_commands`, `device_filesystem_snapshots`, `network_monitor_results`, `device_sessions`. These are the biggest bytes and need no FK work.
  - W2: `script_executions` (scrub, then delete) and batches.
  - W3: the alerts family plus the two FK migrations.
  - W4: AI transcripts (§3.3: columns, FK migration, one job, both viewers, both settings cards, locales in all 8). It ships report-only first and enforces in the following release (§3.4).
  - W5: Tier 3 and `network_change_events`.
- **Unit tests per job,** following `webhookDeliveryRetention.test.ts`: mock `pruneInCtidBatches`, render the `where` through `PgDialect`, and assert:
  - the cutoff is correct
  - only terminal states are included
  - every keep-latest and exemption guard is present
  - env clamping works
- **Integration tests (real Postgres)** for each guard that a mocked `where` cannot prove:
  - The newest closed alert survives.
  - Newest-per-key snapshots survive.
  - A flagged AI session survives.
  - A stub keeps cost and flag columns while messages are gone.
  - Deleting an alert with a `log_correlations` row succeeds after the FK change.
- **Contract suites:**
  - Integration Tests run the export-policy suite for the two new columns.
  - `scheduleRegistry.contract.test.ts` checks the new slots.
  - The org-cascade suite checks the FK changes.
- **Rollout:**
  - Every new env knob is plumbed in `deploy/docker-compose.prod.yml` and documented for self-hosters.
  - Release notes list each table, its window and the env var, and flag that the first run deletes history older than the window.
  - W4 also calls out that client transcript retention starts being enforced for orgs that set it.
  - Watch `retention_backlog_remaining` in Sentry for the first nights after each wave.

## 8. Advisor quorum

An independent `codex exec` (gpt-6-astra, `xhigh`, read-only) opinion was taken on the same question, given the issue and the correction but not this draft.

**Agreed:**

- The inventory: what is already covered, the UniFi upsert, and the writer-less `patch_compliance_snapshots`.
- Terminal-state-only eligibility, with windows counted from completion or closure.
- Keep-latest guards and the alert re-arm cursor.
- The `log_correlations` and `network_change_events` NO ACTION blockers.
- Excluding evidence-backed `report_runs`.
- Client transcripts become a **scrubbed stub**, and NULL keeps meaning forever.
- Approval metadata lives under audit retention.
- `client_ai_usage` is never touched by transcript retention.
- Disk is not returned without a repack.

**Folded in from Codex (each re-verified at `ad73e1d888`):**

- The `action_intents` → `ai_agent_runs` RESTRICT FK.
- The 90 d `device_commands` patch lookback, now the knob's floor.
- Fire-and-forget audit writes, which are why the tool rows stay.
- The topology audit filter's dependence on the session row.
- Scrubbing the free-text `flag_reason`.
- Keep-newest for monitor results.
- 7 d for filesystem snapshots.
- A preview before enforcing a previously inert setting (§3.4, OD 10).
- The extra expiry-shaped session tables (§5).

**Disagreed, and surfaced rather than resolved:**

- Tenant-facing class-based retention policies now vs operator env in v1 (OD 5).
- 90 d vs 365 d technician transcript default (OD 4).
- 400 d vs 365 d for several operational tables (OD 6).
