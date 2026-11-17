---
title: Wisp analysis sessions (chained sandbox analysis from chat, reliability datasets)
status: approved by Todd 2026-11-13 (grant daily budget default left unchanged, §8a option a)
date: 2026-11-13
builds_on:
  - docs/superpowers/specs/ai-mcp/2026-09-13-ai-agent-execution-plane-design.md (sandbox, artifacts, analysis profile; decision D-B stands)
  - docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md (grants, specialists, coordinator)
  - docs/superpowers/plans/ai-mcp/2026-11-05-wisp-delegation-and-unattended-reads.md (device_troubleshooting continuation, specialist results on the next turn)
---

# Wisp analysis sessions — design

## 1. Intent

A technician picks one customer and works with Wisp over a long chat to answer fleet questions that need real computation: "what is making this customer's machines unreliable", "which problems are shared across devices", "what changed before the crashes started". Wisp pulls whole datasets, runs Python over them in the sandbox, reports back, and the technician steers the next step. Each step builds on the files the previous step produced.

Today this stops after one step. Wisp can launch a sandbox analysis run, but:

1. **The result never comes back to the chat.** The per-turn result delivery is filtered to the troubleshooting specialist (`services/wisp/specialistResultsTurn.ts:51`, `:100`). The analysis launcher sets no origin session and attaches no stream (`services/wisp/specialistLaunchers.ts:461-483`).
2. **Nothing carries forward.** Analysis admission accepts `stagedHandles`, but the Wisp launcher passes `[]` (`specialistLaunchers.ts:473`). Every run starts from nothing.
3. **The data a reliability question needs is not exportable.** `export_dataset` has seven datasets (`services/aiToolsExportDatasets.ts:62-65`); reliability scores, crash history, alerts, patch results, boot performance and the change log are not among them.

## 2. Goals, non-goals, anti-goals

**Goals**
- G1. A finished analysis run's summary, findings, proposals and output files reach Wisp's chat on the next turn, and stream progress while running.
- G2. Wisp can continue from a prior analysis run. The new run may stage every file the chain has produced or exported so far.
- G3. A chain is bounded in length and in total spend.
- G4. `export_dataset` covers the reliability-relevant data Breeze already stores.
- G5. A whole-customer or whole-site analysis works from chat without listing devices.

**Non-goals**
- A sandbox that persists between runs. Execution-plane decision D-B stands: every run gets a fresh box. Continuity is carried by artifacts and a fenced text seed.
- Wisp chaining runs on its own without a person steering (the "autonomous investigation"). This spec's data model is chosen so that feature can be built on it later; the loop itself is out of scope.
- Cross-organization or partner-wide analysis. One org per run, as today.
- Live device reads (files, commands, scripts) inside an analysis run. Unchanged.
- Raising the validator ceilings on per-run limits. The chain supplies length; per-run ceilings stay.
- Re-enabling `workspace_launch_analysis` (#6086). The Wisp `launch_specialist` path stays the only door.
- New tables.

**Anti-goals** (failure even if it works)
- The chat model choosing which artifact ids get staged. Handles are always derived server-side from the prior run.
- Text from a prior run or a customer file being treated as instructions by the next run or by Wisp.
- A conversation that can spend without a chain-level stop.
- An export dataset that puts secrets or another site's rows into a sandbox.

## 3. Approaches

Chosen in conversation with Todd on 2026-11-13.

- **A. Autonomous investigation.** Wisp plans and chains runs unattended under a total budget, then reports. Needs an investigation record, a stop rule, and unattended re-launch authority. Larger, and it is this spec's mechanism with a loop around it.
- **B. Interactive chaining (chosen).** The technician steers in chat; each turn can launch the next run with the prior outputs available. Smaller, keeps a person choosing each step, and builds every part A needs. (`analysis` stays `chatLaunchTier: 2`; whether a launch shows an approval card follows the session's existing tier-2 rule and is not changed here.)
- **C. Persistent sandbox.** Keep one box alive or remount its disk. Ruled out by D-B ("Never: persistent writable workspaces remounted across runs"): a remounted filesystem lets injected content from a customer log persist into later runs.

Todd picked B.

## 4. Design

### 4.1 Results return to chat (G1)

Follow the troubleshooting specialist's path; do not invent a second one.

- **Origin session.** When `launch_specialist` launches `analysis` from a chat turn, the launcher records the chat session on the run the same way troubleshooting does (`triggerRef.originSessionId`) and registers the run with the chat bridge (`watchRunForOriginSession`, as at `specialistLaunchers.ts:615-637`) so progress events and the run card stream live. Assessment-path launches (no chat session) are unchanged.
- **Next-turn delivery.** `specialistResultsTurn.ts` accepts `analysis` as well as `device_troubleshooting`. Same predicates otherwise: same grant, same origin session, settled status, org inside the live ceiling.
- **What the model sees for an analysis run**, in the existing `[breeze:analysis-results]` block (`workspace/chatRunBridge.ts:412-445`):
  - run id, status, and the run's chain position (§4.2);
  - the `submit_analysis` outcome read from `ai_agent_runs.outcome.analysis`: `summary`, then findings as `severity · title · detail` (first 20, detail cut to 500 characters each), then proposed actions as `tool[:action] · deviceId · rationale` (first 10). When the run did not submit an outcome (failed, cancelled), fall back to the `summary` column;
  - the run's `output`-kind artifacts as `name (bytes, contentType, handle <uuid>)`. Handles stay, because `read_artifact` addresses a file by handle (`aiToolsArtifacts.ts:63-69`). They are harmless for staging: no launch parameter accepts a handle (§4.2). Artifacts of other kinds are not listed.
  - Everything above that originated in the run (summary, findings, proposals, **and file names**) goes inside one `wrapUntrustedData('analysis_run_result', …)` fence. Today file names sit outside the fence (`chatRunBridge.ts:428`); this fixes that for both specialist kinds.
  - Whole block capped at 8 KB per run; cut findings first, then proposals, and say that it was cut.
- **Proposals stay proposals.** Wisp may act on one only by making its own tool call in chat, under the normal tier and approval rules. Nothing in the result block executes.
- **Reading an output file from chat.** `read_artifact` today matches the caller's own run or session, or a thread attachment (`services/artifacts/artifactService.ts:405-433`); analysis outputs have `sessionId: null`, so chat cannot read them. Extend the caller scope with one more branch, all terms required:
  - artifact `kind = 'output'`, not expired;
  - its run has `profile = 'analysis'`;
  - the run was launched from a chat (`triggerRef.originSessionId` is set);
  - the run's `grantId` is the calling session's live grant, resolved from trusted session context (§4.2 "Thread rule"), and the run's org is inside the live ceiling.
  - `input_capture` (raw exports) and `step_*` kinds stay unreadable from chat.
  - **An output file is as sensitive as what the run staged.** A run can copy an export into `/work/out`, and collection labels whatever it finds there `output` (`workspaceService.ts:547`). So a chat read of an output goes through the same redaction and untrusted-data fencing as any other tool result, and keeps `read_artifact`'s existing paging caps. The kind filter is a bulk-data guard, not a sanitization claim.
- **Replay lookup fix.** `launchAnalysis` looks a prior run up by the raw `ctx.requestId` (`specialistLaunchers.ts:464`, `:480`) while the stored key is `specialistDedupeKey(requestId)` (`:474`). Both lookups pass the derived key. Add the regression test first.

### 4.2 Continuation (G2, G3)

**Launch parameter.** `analysisParamsSchema` gains `continueFromRunId: z.uuid().optional()`. There is no handle parameter and none is added.

**Validation** (a sibling of `troubleshootContinuation.ts`'s `continuationOf`; run in the advisory precheck without the grant, and authoritatively in the launcher with it). The prior run must be, checked in this order so nothing leaks across tenants:
1. found, and in the caller's org;
2. `profile = 'analysis'`;
3. under the same `grantId` as this launch (thread rule below);
4. settled: `completed`, `failed` or `cancelled`;
5. within the chain bounds below.

**Thread rule.** A chat session may continue, and read outputs of, analysis runs under its own live grant. There is exactly one Wisp thread per grant (`wisp_threads_grant_uq`), so "same grant" means "the same person's ongoing Wisp thread", across however many chat sessions that thread spans. This is deliberate: chat sessions cap at 24 hours and a Wisp chat cannot be continued into a new session (`routes/aiSessionContinue.ts` refuses it), so a per-session rule would end every investigation after a day. Thread-scoped reads already exist (`wisp_thread_attachments`). **Result delivery stays per session:** a finished run is announced only in the chat that launched it. A later chat in the thread finds a prior run through the existing run-read tools and continues it by id. A continuation run records the launching session as its own origin.

Each failure is a typed refusal with a message Wisp can relay (`specialistRefusalMessages.ts`).

**Lineage columns.** Three new columns on `ai_agent_runs`:

| Column | Meaning |
|---|---|
| `continued_from_run_id uuid` | the immediate prior run |
| `chain_root_run_id uuid` | the first run of the chain; null on a run that continues nothing |
| `chain_depth smallint not null default 0` | 0 on a root or unchained run; prior's depth + 1 on a continuation |

- For a continuation: `chain_root_run_id = prior.chain_root_run_id ?? prior.id`.
- Composite self-FKs `(continued_from_run_id, org_id)` and `(chain_root_run_id, org_id)` → `ai_agent_runs (id, org_id)`, `DEFERRABLE INITIALLY IMMEDIATE`, `ON DELETE SET NULL` on the pointer column only. Partial index on `(org_id, chain_root_run_id) WHERE chain_root_run_id IS NOT NULL`.
- Why columns and not `trigger_ref` JSON (which troubleshooting uses): the chain bounds below and the later autonomous feature both need "all runs under this root" as an indexed query, and the run page needs to show the chain. `requested_by_run_id` cannot be reused; its check constraint pins it to assessment → specialist.
- A run may be continued more than once (branching to try a different angle). Branches share the root and count against the same bounds.
- Admission validates, in code, that the prior run's root and grant agree with what is being written; the FK only proves same-org.
- **Retention must not cut a live chain.** `jobs/historyRetention/aiAgentRuns.ts` has no continuation guard, and `SET NULL` on a deleted root would reset a chain's bounds. The retention job skips a run while any run sharing its root is still inside the retention window.
- Migration ceremony per `apps/api/migrations/README.md` and `docs/agents/tenancy-rls.md`: the new columns need export-policy classification. `ai_agent_runs` is `leave-for-erasure` in `orgMergeRegistry.ts` with an immutable `org_id`, so org merge does not touch these rows and needs no change.

**Chain bounds.** Three new `AiAgentLimits` fields, snapshotted like the other `analysis*` limits:

| Limit | Default | Validator range | Enforced as |
|---|---|---|---|
| `analysisMaxChainDepth` | 8 | 1–20 | prior's `chain_depth` + 1 ≤ limit |
| `analysisMaxChainRuns` | 12 | 1–40 | count of runs with this root (plus the root) < limit |
| `analysisMaxChainBudgetCents` | 600 | 50–5000 | committed chain spend + this run's allowance ≤ limit (below) |

- **Chain budget is a reservation, not an estimate.** Committed spend is, per run in the chain: actual `cost_cents + compute_cents` when the run is settled; its full allowance when it is not. A run's allowance is its snapshotted `analysisMaxBudgetCentsPerRun + analysisMaxComputeCentsPerRun`, which the run loop already enforces as hard caps. So the chain limit cannot be exceeded by siblings running at once. This mirrors how compute admission already counts reservations (`runService.ts:1853`).
- With the default per-run allowance of 175 cents, the default chain budget admits a new step only while committed spend is at or below 425 cents. Typical steps cost far less than their allowance, so the run-count bound usually binds first.
- Enforced at admission **under the existing org-wide analysis admission lock** (`runService.ts:1665`). A transaction alone does not serialize two concurrent continuations.
- Refusals: `analysis_chain_too_long`, `analysis_chain_budget_exceeded`. The message tells the technician the chain is finished and a new analysis can be started fresh.
- Existing limits still apply on top: 10 analysis runs per hour and 2 concurrent per org, 10 `launch_specialist` calls per user per hour, the grant's daily budget.
- **Grant spend must count compute.** Grant spend sums `cost_cents` and ledger lines and omits `compute_cents` (`services/wisp/budget.ts:189-196`). Include `compute_cents` in this work.
- **The grant's daily budget usually binds first.** A new grant defaults to 200 cents a day (`db/schema/wisp.ts:95`) and the analysis pre-check estimate is 100 (`specialistPolicy.ts:100`), so a default grant admits about two analysis launches a day. That is left as is: a grantor who wants investigations raises the grant's daily budget. Each refusal names the limit that stopped it (grant daily budget, chain budget, chain length, hourly rate) so the technician knows which setting to change. Docs and the eval scenario assume a raised grant budget. See Open question 1.

**What a continuation may stage.** Derived server-side at admission and frozen into `staged_inputs.handles`:

```
allowed = prior.staged_inputs.handles
        ∪ { artifacts where run_id = prior.id
            and ( kind = 'output'
               or (kind = 'input_capture' and created_by_tool = 'export_dataset') ) }
minus anything with expires_at <= now()
```

- So the set accumulates down the chain: every dataset exported and every output collected by any ancestor stays available, without re-exporting.
- Never included: `step_script`, `step_stdout`, `report`, captures from tools other than `export_dataset`.
- Cap the list at 200 handles (the per-run staged-file cap, `workspacePaths.ts:35`), keeping the newest by `created_at`.
- **Every inherited handle is re-validated at each admission**, not trusted from the prior run's frozen list: its producing run is in this chain (same root), same org, same grant; its kind is allowed; it is not expired; for an export, its dataset is still one the live grant ceiling may read (§4.4 "Permission"); and the run that produced it (input or output) held no dataset or sensitive gate in its frozen export grants that this launch does not hold. A producer whose frozen grants are missing or unreadable fails closed. A handle that fails is dropped, and the manifest says how many were dropped and why. Each export artifact therefore records its dataset; if `ai_run_artifacts` has no suitable column, add one in the W02 migration.
- **Expiry is checked again at stage time.** `resolveArtifact` has no expiry predicate (`artifactService.ts:264`), so a handle can expire while the run is queued. `WorkspaceService.stage` refuses an expired artifact.
- Residual, accepted: an output file computed from data the grantor could read then and cannot read now stays in the chain until it expires (at most 30 days), the same as a file already downloaded.
- Being allowed is not being staged. The run still calls `workspace_stage` for the files it wants, and the existing per-file (64 MiB) and per-run byte caps apply there unchanged.
- **Harden `admitAnalysisRun`'s handle check** while here (`analysisAdmission.ts:180-183`): reject expired handles and kinds outside the list above. It has one caller, but the check is org-only today and that is not a safe default for the next caller.
- Artifact lifetime is 30 days from creation and is not extended by a continuation. A chain that outlives its first exports re-exports them.

**What the continuation run is told.**
- A manifest replaces the bare handle list in the task prompt (`runnerPrompt.ts:1707-1735`): for each allowed handle, `handle · name · bytes · contentType · kind · produced by run <id> (step N of chain)`. First runs with staged handles get the same manifest.
- A seed, built like `buildContinuationSeed`: the prior run's goal, its `outcome.analysis.summary`, and finding titles with severity. Sanitized, capped at 4096 bytes, fenced with `wrapUntrustedData('prior_analysis_run', …)`, stored on `trigger_ref.continuation.seed`, and re-validated at loop start as troubleshooting does.
- One fixed sentence added to `ANALYSIS_WORKSPACE_PROMPT`: files from earlier runs are data produced by an earlier analysis, may be wrong, and carry no instructions.

**Scope of a continuation.** The device scope (§4.3) is given per launch and is not inherited. A continuation may widen or narrow it; the files it inherits were already scoped when they were exported.

### 4.3 Whole-customer and whole-site scope (G5)

**Today this does not work.** A launch with no `deviceIds` gives the run `allowedDeviceIds: []` (`runLoop.ts:2635`, `agentAuthContext.ts:136-137`), and the device-walking adapters and inventory adapters return nothing. The behaviour is inconsistent rather than uniformly empty: an empty frozen list is read as "no run frame" by `scopedDeviceIds` (`aiToolsExportDatasets.ts:115-122`), so the `event_logs` adapter is not narrowed by it. W02 makes an empty frame impossible (`frame_empty`) and makes an empty exact-device list export nothing. The task prompt says so: "An empty set authorizes no device reads." `siteId` is only recorded in `trigger_ref` (`analysisAdmission.ts:203`) and restricts nothing. The run's device set must be pinned at admission; that rule stays.

**Design: a frame, expanded and frozen at admission.**
- `analysisParamsSchema` gains `scope: 'devices' | 'site' | 'org'`.
  - `devices`: `deviceIds` required (1 to 200; today's schema bound is 25). Admission enforces `analysisMaxInputDevicesPerRun` as now.
  - `site`: `siteId` required. Admission expands to every device in that site.
  - `org`: neither. Admission expands to every device in the org.
  - A launch with no `scope` and no `deviceIds` is refused with a message that says to pick one; it no longer admits a run that can read nothing.
- For `site` and `org`, admission resolves the device list **through the live grant ceiling's site restriction** (so a site-limited grantor never gets a wider frame than they could see), checks it against a new limit, and freezes it into `staged_inputs.deviceIds` exactly as an explicit list is frozen today. From there nothing downstream changes: the run's auth context, `runTargets`, and every adapter already work from that frozen list.
- New limit `analysisMaxFrameDevices`: default 1000, validator range 50–5000. Over the limit refuses with `frame_too_large` and tells the technician to scope by site. `analysisMaxInputDevicesPerRun` keeps applying only to `devices` scope.
- `staged_inputs` records the scope kind and site id alongside the list, so the run page and the manifest can say "whole organization (412 devices as of launch)".
- The task prompt lists device ids only for `devices` scope. For a frame it states the scope and count; the model orients with `query_devices` and exports.
- **Adapter cost at frame size.** The existing `metrics`, `vulnerabilities` and `custom_fields` adapters walk devices four at a time and will hit the export's 120-second clock on a large frame; they already end cleanly with `truncated: true`. That is acceptable in v1 and is stated in the tool description. Every new adapter (§4.4) must be set-based: one keyset query filtered by the device set, never a per-device loop.
- No per-run limit defaults or ceilings change otherwise. Hosted deployments that want longer steps raise the existing per-org `analysis*` limits within today's ceilings.

### 4.4 New export datasets (G4)

Ten datasets, each one adapter in `aiToolsExportDatasets.ts` (split the file by domain if it passes ~800 lines).

| Dataset | Source | Rows | Notes |
|---|---|---|---|
| `reliability_scores` | `device_reliability` | one per device | current score, factor scores, uptime and counts by window, MTBF, trend. Reuse `listReliabilityDevices`. |
| `reliability_history` | `device_reliability_history` | one per collection | `uptime_seconds`, `boot_time`, counts of each event array. No raw arrays. |
| `reliability_events` | same, arrays flattened | one per crash, hang, service failure or hardware error | `event_class`, type, timestamp, process or service name, redacted detail. |
| `alerts` | `alerts` + `alert_rules.name` | one per alert | severity, status, title, redacted message, triggered/acknowledged/resolved times, resolution reason. Device-owned alerts only in v1 (topology-site and backup-workload alerts are skipped). `context` JSON is not exported. |
| `patch_state` | `device_patches` + patch title, KB, severity | one per device-patch | rows with status `missing` are scan tombstones and are excluded. `last_error` redacted. |
| `patch_attempts` | `patch_job_results` + `patch_jobs` | one per attempt | status, times, exit code, reboot flags, redacted `error_message`. **Raw `output` is not exported.** The table has no `org_id`; scope through `patch_jobs.org_id` and the device set. |
| `boot_performance` | `device_boot_metrics` | one per boot | phase timings, startup item count. A second row shape for startup items is not included in v1; `startup_items` is exported as a JSON column with paths redacted. |
| `change_log` | `device_change_log` | one per change | type, action, subject, before/after, redacted. `user_account` changes require `devices:execute`, the same gate as the `security` event-log category; without it they are filtered out and the result says so. |
| `hardware_events` | `device_hardware_events` + component | one per transition | component kind and serial, from/to health and state, detail. |
| `service_checks` | `service_process_check_results` | one per check | watch type, name, status, cpu, memory, auto-restart flags. `details` JSON not exported. |

Left out, with reasons: tickets (customer free text, different permission, no clear need yet), process samples (7-day retention; revisit), battery (snapshot only), online/offline history (no table exists).

**Rules every new adapter follows**
- **Time range.** One shared filter, `filters.timeRange { start, end }` (ISO), default the last 30 days, maximum span 180 days. Existing adapters keep their own filters.
- **Paging.** Keyset on `(time column, id)` descending, 500 rows per page. No offset paging, no single-page loads.
- **Org and site.** Org from `req.orgId`. Site restriction through `scopedDeviceIds(req)`; an empty set returns the empty pager and must never mean unrestricted. None of these tables has `site_id`.
- **Redaction.** Export rows bypass the shared tool-output redaction (`export_dataset` is `captureExempt`). Each adapter redacts its free-text columns explicitly: `redactLogMessage` / `redactLogFields` (`services/logRedaction.ts`) for text, `scrubUrlsInText` (`utils/endpointDisplay`) for alert messages. Free-text cells are cut to 2000 characters.
- **Permission.** `export_dataset` only runs inside an agent run (`aiToolsExport.ts:116-121`), and a run's principal has no role: RBAC checks deny it outright (`aiGuardrails.ts:4150`, `agentAuthContext.ts:101`). So a handler-side permission check cannot work. Instead:
  - Each dataset declares the permission its equivalent human read tool requires (`alerts` ← `manage_alerts:list`, the patch datasets ← `manage_patches:list`, and so on, read from `TOOL_PERMISSIONS`), plus an optional sensitive gate (`devices:execute` for `change_log` `user_account` rows and for the `security` event-log category).
  - **At admission**, the launcher evaluates those against the **live grant ceiling** (the grantor's delegated permissions intersected with what they hold now, as `coordinator.decide` already resolves) and freezes the result into the run: the set of datasets it may export and the sensitive gates it holds.
  - The handler checks only that frozen set. A dataset outside it returns `dataset_not_permitted`; a sensitive gate not held filters those rows and says so in the result.
  - The existing seven datasets get the same treatment so there is one mechanism: `devices:read` for all seven, and `event_logs` `security` moves onto the frozen sensitive gate.
  - The run's task prompt lists the datasets it may export, so the model does not probe.
- **Tier.** All ten are tier 1 (read).

**Registration, and the drift fix.** The dataset list is hard-coded in `EXPORT_DATASETS`, in `aiToolSchemas.ts:2198`, in `aiAgentSdkTools.ts:3718`, and in description prose. Make both Zod enums derive from `EXPORT_DATASETS`, and add a test that fails when a dataset exists in one place and not another. Update the description, the search hint and `apps/docs/.../features/ai-tools.mdx`.

**No analysis allowlist change.** `export_dataset` is already in `ANALYSIS_TOOL_ALLOWLIST`.

### 4.5 What the technician sees

- The chat run card for an analysis run shows `Step N` when the run is part of a chain, and lists its output files with download links (the existing run-detail artifact surface).
- The run page shows the chain: root, each step's goal, status, cost, and a link to each run. Read from `chain_root_run_id`.
- Wisp's guidance (the specialist description in `aiToolsWisp.ts`) says: choose a scope (`org` for a whole customer); to build on an analysis, pass `continueFromRunId`; start fresh when the question changes; a chain has a length and spend limit.

```
Analysis · Step 3 of this investigation          completed · $0.84
Goal: correlate BSODs with driver changes in the last 60 days
Findings: 3 (1 high)   Files: bsod_by_driver.csv (14 KB), timeline.png (88 KB)
[Open run]  [Download files]
```

## 5. Security notes

- **Authority is unchanged.** An analysis run still cannot act; `maxActionsPerRun` is 0 and proposals cannot execute.
- **Handle provenance is structural.** The only way an artifact enters a chain is by having been exported or collected by a run in that chain, under the same grant and org, and it is re-validated at every step. The chat model supplies a run id, never a handle to stage.
- **Chains are thread-scoped.** Continuation and output reads require the same live grant, which is one person's one Wisp thread. Another person's grant, or a revoked grant, cannot reach the chain.
- **Authority is re-derived each step.** Dataset permissions and the device frame come from the live grant ceiling at each admission, not from the prior run.
- **Injection carries less than it could.** A customer log can still influence what a run writes to `/work/out`, and that file reaches the next run. The mitigations are the ones the execution plane already relies on: the sandbox has no network and no credentials, the run cannot act, seeds and results are fenced, and the fixed prompt says inherited files are data. No executable state (installed packages, shell profile, cron) survives, because the box does not.
- **Grant revocation.** Continuation checks the same `grantId` and the coordinator re-resolves the live ceiling on every launch, so a revoked or narrowed grant stops the chain at the next step.
- **`read_artifact` widening** is limited to `output` kind of an `analysis` run, launched from a chat, same live grant, org in ceiling, with normal redaction and fencing on the content.

## 6. Waves

| Wave | Content | Rigor |
|---|---|---|
| W01 | Results return: origin session, bridge registration, next-turn delivery for analysis, outcome rendering inside the fence, `read_artifact` branch, replay lookup fix | high (authz on artifact read) |
| W02 | Continuation: migration (lineage columns, export dataset on artifacts), `continueFromRunId`, validation and session rule, server-derived and re-validated handles, stage-time expiry, chain limits with reservation, retention guard, grant spend counts compute, manifest and seed in the prompt | high (migration, tenancy, spend) |
| W02b | Scope frame: `scope` param, site/org expansion through the grant ceiling, `analysisMaxFrameDevices`, frozen frame on the run, prompt changes; frozen dataset permissions for the existing seven datasets | high (authority, device scope) |
| W03 | Datasets 1: `reliability_scores`, `reliability_history`, `reliability_events`, `boot_performance`, `hardware_events`, `service_checks`; shared time range; enum drift fix | medium |
| W04 | Datasets 2: `alerts`, `patch_state`, `patch_attempts`, `change_log`; their dataset permissions and sensitive gate; redaction | high (sensitive text, permission) |
| W05 | Surfaces: run card step and files, run page chain view, Wisp guidance text, docs, a Wisp eval scenario that runs a three-step org-scope chain on the fake backend | low–medium |

W01 and W03 are independent and can run in parallel. W02 needs W01. W02b is independent of W02 and can follow W01. W04 needs W03's shared pieces and W02b's frozen permissions. W05 needs W02 and W02b.

## 7. Testing contracts

- **Results turn:** an analysis run launched from session S under grant G is delivered to S; not to another session, not under another grant, not once the org leaves the ceiling. File names and findings are inside the fence.
- **`read_artifact`:** `output` readable from the origin session and from another session under the same grant; `input_capture` not; a run with no origin session not; another grant not; expired not; org outside the ceiling not.
- **Continuation validation:** one test per refusal in §4.2, in order, including other-org returning the same answer as not-found, a second session under the same grant being admitted, and a run under another grant being refused.
- **Scope frame:** `org` and `site` expand to the right devices and freeze them; a device added after admission is not readable; a site-restricted ceiling narrows the frame; over `analysisMaxFrameDevices` refuses; a launch with no scope and no devices refuses; `siteId` actually restricts.
- **Dataset permission:** a dataset whose permission the ceiling lacks is refused; a sensitive gate not held filters rows; permissions are re-derived on a continuation and an inherited export for a now-forbidden dataset is dropped.
- **Handle derivation:** accumulates across three runs; excludes step kinds and non-export captures; excludes expired; caps at 200 newest; drops a handle whose producer is outside the chain or under another grant; stage refuses a handle that expired after admission.
- **Stage enforcement:** a continuation can stage an inherited handle and cannot stage any other in-org handle (`staged_handle_not_allowed`).
- **Chain bounds:** depth, run count, and budget each refuse at the limit; two concurrent continuations at the limit admit exactly one; an unsettled sibling counts at its full allowance; retention does not delete a root while a run in its chain is inside the window.
- **Datasets:** for each adapter — org isolation, site restriction through the device set, empty device set returns nothing, keyset paging terminates and does not repeat rows, redaction applied to each free-text column, time range default and maximum. `patch_attempts` org isolation gets its own test because the table has no `org_id`.
- **Registration:** the three dataset lists cannot drift.
- **Contract suites** (Integration Tests job): org cascade and export policy for the new columns.
- **Eval:** one Wisp scenario — export, analyze, continue twice, final answer cites a file from step 1.

## 8. Calls made here (not Todd's decisions; correct any)

1. Chain limits default to depth 8, 12 runs, $6.00 total, with unsettled runs counted at their full allowance.
2. Lineage is real columns, not `trigger_ref` JSON.
3. Branching from the same prior run is allowed.
4. A chain belongs to one Wisp thread (one grant). Any chat in that thread can continue it; results are announced only in the chat that launched the run. (Changed 2026-11-13 after planning found Wisp chats cannot be continued across the 24-hour session cap.)
5. Chat can read `output` files from its own analysis runs, not raw exports.
6. Whole-customer scope is a frame frozen at launch, default limit 1000 devices (range 50–5000). A launch with no scope is refused instead of admitting a run that can read nothing.
7. Dataset permissions come from the grant ceiling, frozen at each launch.
8. `user_account` change-log rows need `devices:execute`.
9. Patch attempt raw output is never exported.
10. Tickets and process samples are left out of v1.
11. No per-run limit defaults or ceilings change.

## 8a. Open question for Todd

1. **Default grant daily budget.** A new Wisp grant allows $2.00 a day, about two analysis launches, so the chain limits above only matter once a grantor raises it. Options: (a) leave the default and have the refusal say to raise the grant budget (this spec's assumption); (b) raise the default; (c) lower the analysis pre-check estimate from $1.00 toward typical actual cost. **Recommend (a)** — spend defaults should stay conservative, and the refusal message makes the fix obvious.

## 8b. Review record

- Builder check (2026-11-13): four questions, four factual corrections; all folded in. The largest: whole-customer scope did not work as first written (§4.3 rewritten), and a run principal has no permissions to check (§4.4 "Permission" rewritten).
- Independent opinion (`codex exec`, xhigh, read-only, 2026-11-13): agreed with lineage columns, server-derived handles and the narrow `read_artifact` branch; disagreed with the first chain-budget formula (now a reservation under the admission lock). Its three reported holes are addressed: cross-session continuation (first a session rule, then relaxed to the thread rule in §4.2 because one grant is one thread; this departs from its advice), stale authority (per-step re-derivation and handle re-validation), and output kind not implying sanitized content (§4.1).

## 9. Left to the builder

- Exact refusal codes and message wording.
- Splitting `aiToolsExportDatasets.ts` and the precise column lists per dataset, within the table in §4.4.
- The permission name for each dataset, read from the equivalent tool's `TOOL_PERMISSIONS` entry.
- Run page layout for the chain view.
