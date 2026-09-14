---
title: AI Agent Execution Plane — sandboxed workspaces, artifacts, and compute metering
status: approved by Todd 2026-09-13 — feature #5711, waves #5712–#5716
date: 2026-09-13
supersedes_in_part: 2026-08-22-ai-agents-program-and-wave1-design.md §2 (see §2 below)
spike: ../../spikes/2026-09-13-ai-agent-execution-plane-backend.md
tracking_issue: LanternOps/breeze#5711
---

# AI Agent Execution Plane — design

## 1. Problem

Breeze AI agents can act on a fleet safely and cannot do work. Every tool result must fit in the model's context (one result is capped near 25 k tokens by the Agent SDK, roughly 100 KB); nothing can compute (no shell, no interpreter; aggregation across devices is the model reading text); nothing persists between tool calls except the transcript; nothing produced can be handed to a technician (`ai_tool_executions.toolOutput` is deliberately null and there is no artifact store); scripts cannot be tested before touching a live device; and autonomous runs are bounded to one device, three actions, 25 turns, 50 ¢, and 600 s. A technician cannot ask "pull yesterday's security logs from the finance servers and tell me which accounts failed logon from outside the office, with the list attached", and cannot get a spreadsheet of out-of-policy software across a site.

This spec adds the missing layer: a **sandboxed per-run workspace** where model-written code runs, an **artifact store** that lets data flow in and out of runs without transiting the model's context, **workspace capabilities** the loop can use under the existing guards, an **`analysis` run profile** with the bounds that workload needs, and **compute metering** so the new cost is capped, recorded, and billed.

The spike (`docs/superpowers/spikes/2026-09-13-ai-agent-execution-plane-backend.md`) evaluated fourteen backends and reached an advisor quorum. v1 rents **Vercel Sandbox** behind a private adapter; a self-hosted gVisor pool on our droplets, or AWS AgentCore, are later backends behind the same adapter. Todd's stated preference is to consolidate onto one place later; the adapter is what makes that a configuration change.

## 2. Decisions and amendments

### 2.1 Amendment to the AI agents program spec (2026-08-22), §2

That section says: *runtime is BullMQ, process-agnostic; **never per-run containers**; the Agent SDK child process is the isolation unit*, and *this is not an agent platform: no user-authored prompts, tools, or memory.* For the **workspace lane only**, the first clause is reversed:

- The Agent SDK child process remains the isolation unit for the **loop** (trusted code we wrote: tools, tiers, intents, kill switch, metering).
- A **per-run sandbox** becomes the isolation unit for **model-written code**. It has no secrets, no route to the fleet, and — in v1 — no network at all.

The second clause stands. Users still do not author prompts or tools; the model writes code inside a box that can only read what the run staged and can only produce files. Authority stays structural in `policy_snapshot` (§5.3 of the program spec); `instructions` remain non-authoritative.

### 2.2 Decisions taken in brainstorming and the spike (2026-09-13)

| # | Decision | Rationale |
|---|---|---|
| D-A | Keep our loop; buy or build only the box | Hosted loops (Claude Managed Agents, OpenAI Agents API, DO ADK) replace tiering, model choice, and — for Managed Agents — ZDR eligibility. Ours is already the Agent SDK harness |
| D-B | Ephemeral compute per run; a run-scoped **read/write** filesystem; no writable filesystem that persists across runs | A remounted writable FS is a persistence vector for injected instructions. Cross-run knowledge already has homes (device notes, EE memory blocks) |
| D-C | v1 sandbox has **no network** (deny-all incl. DNS). Inputs and outputs move through the vendor control plane from the worker | Removes the SNI / DNS / raw-IP bypass class and the need for a broker service in v1. Cost: staged bytes transit the worker, so v1 caps them (§7). A presigned-URL ingest path is the upgrade when the cap bites; that is where a broker gets built |
| D-D | All fleet actions still go through the loop's tier-gated MCP tools; the sandbox mints no intents and holds no credentials | One gate. The sandbox can compute anything; it can *do* nothing to a customer machine except by handing a proposal back to the loop |
| D-E | **All agent execution runs on the worker role**; the API serves HTTP and SSE only. v1: chat launches a workspace run on the worker and receives results. Follow-on wave: move chat session execution itself to the worker | Sandbox lifecycle cannot live in a request pinned to one API process; the same fact is why chat sessions are lost on deploy today |
| D-F | Compute is metered, capped, and billed in v1 | Recording and capping is required for safety; pricing into credits is a small step that closes the "compute is free" gap |
| D-G | Private **E2B-shaped adapter** underneath; loop-facing **workspace operations** on top (stage / run / collect / cancel) | Portability to E2B, AWS AgentCore, DO's announced Managed Sandboxes, and a self-hosted pool; the loop never sees shell strings or provider ids |
| D-H | Driver workload: **cross-device analysis** | Exercises the hardest boundary (device → workspace data). Script authoring and report generation fall out of the same primitives |
| D-I | Hosted only | This is the paid channel. `IS_HOSTED` gate; self-hosters see the capability absent, not broken |

## 3. Scope

**In v1 (this spec):**
- `SandboxBackend` adapter interface, Vercel implementation, in-memory fake.
- Artifact store: shared blob helper (S3-compatible or DB backend), `ai_run_artifacts` table, large-tool-result capture with handles.
- Workspace MCP capabilities: `workspace_stage`, `workspace_run`, `workspace_collect`, `workspace_cancel`; one `workspace` catalog capability. `export_dataset` (§5.7) for full-fidelity server-side data into artifacts. Step transcript + progress events (§5.8).
- `analysis` run profile and its limits; a chat tool that launches an analysis run and returns its result.
- Compute metering: usage capture, per-run and per-org caps, `compute_cents` on runs and rollups, credit deduction on every billing source. Per-org external-processing switch (§8).
- Artifact surfaces: run detail (list, preview, download), ticket attachment, report attachment.
- Adversarial and cleanup test suites against the fake (PR) and real Vercel (nightly).
- Migrations with full tenancy ceremony; wave1 §2 amendment recorded in that doc.

**Out of v1 (named follow-on waves, §13):** presigned-URL bulk ingest and the artifact broker; chat sessions executing on the worker; self-hosted gVisor backend; AWS AgentCore backend; script-authoring fixtures lane; multi-device *action* fan-out (#4173) and partner-level spend ceiling; document generation templates.

**Never:** sandbox network access to Breeze APIs or devices; sandbox-held credentials; persistent writable workspaces remounted across runs; user-authored tools inside the sandbox.

## 4. Architecture

```
 technician ── chat (API, SSE) ──┐
                                 │  workspace_launch_analysis (tool)
 event/cron/operator ────────────┤
                                 ▼
                      ai_agent_runs (profile = analysis)          Postgres
                                 │  BullMQ `ai-agent`
                                 ▼
 ┌──────────────── worker role ────────────────────────────────────────┐
 │  runLoop (Agent SDK child, tools: [] + Breeze MCP tools)           │
 │     │  Breeze tools (tiered)            workspace tools            │
 │     ├──► export_dataset / read tools ──► artifact capture ──► blob │
 │     └──► workspace_stage/run/collect ─► WorkspaceService          │
 │                                            │  SandboxBackend      │
 │                                            ▼                      │
 │                                   Vercel Sandbox (deny-all net,   │
 │                                   persistence off, region=org)    │
 │                                            │ usage after stop     │
 │                                            ▼                      │
 │                                   compute metering → credits      │
 └────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
             outcome { summary, artifactHandles[] } → run page / ticket / report
```

The sandbox has exactly two connections to the world, both initiated by the worker through the vendor control plane: files written in before and during the run, files read out at collect. Nothing inside the sandbox can open a socket.

## 5. Components

### 5.1 `SandboxBackend` (private adapter) — `apps/api/src/services/workspace/sandboxBackend.ts`

```ts
interface SandboxBackend {
  create(spec: {
    runId: string; orgId: string; region: 'eu' | 'us';
    cpu: 1; memoryMb: 2048;                 // v1 fixed shape
    deadlineSeconds: number;                // provider-side hard stop
    image: 'breeze-analysis@<digest>';      // v1: vendor default runtime + pinned bootstrap; custom image later
  }): Promise<SandboxHandle>;
  exec(h, cmd: string[], opts: { cwd?: string; timeoutMs: number; stdinBytes?: Buffer; maxStdoutBytes: number }): Promise<ExecResult>;
  writeFiles(h, files: Array<{ path: string; bytes: Buffer }>): Promise<void>;
  readFile(h, path: string, maxBytes: number): Promise<Buffer>;
  listFiles(h, dir: string): Promise<FileStat[]>;
  destroy(h): Promise<void>;                // idempotent; must also purge snapshots
  usage(h): Promise<{ cpuMs: number; wallMs: number; memAllocatedMb: number; peakMemMb?: number }>;
}
```

Rules: `exec` never takes a shell string from the model — the model's script is written to a file and executed by path (the Codex/Docker Sandboxes lesson). Every method is bounded by a caller-supplied cap. `destroy` is called from a `finally` and from the reaper. Vercel-specific option names (region ids, the persistence flag, network policy `deny-all`, usage fields `activeCpuUsageMs` / `totalDurationMs`) are resolved in the implementation plan against the SDK docs; the spike records the semantics.

Implementations: `vercelSandboxBackend.ts` (v1), `fakeSandboxBackend.ts` (tests; in-process temp dir, enforces the same caps, records calls). Later: `gvisorPoolBackend.ts`, `agentCoreBackend.ts`.

### 5.2 Artifact store — `apps/api/src/services/artifacts/`

- **Blob helper** `blobStorage.ts`: extracted from `ticketAttachmentStorage.ts`; backend `s3 | db` chosen by env (hosted = S3-compatible object storage per region); keys are opaque (`<region>/<yyyy>/<mm>/<uuid>`), **carrying no tenant identifier**; server-side encryption at rest; erasure pre-clears blobs before rows (mirrors the `org_documents` design in the service-deliverables spec §4.4, which will consume the same helper).
- **`ai_run_artifacts`** (Shape 1, `org_id`): see §6.
- **Capture — where it hooks.** Today every tool result is a JSON string that passes through one input dispatch point, `executeTool` (`aiTools.ts`), and is then **lossily compacted to `MAX_TOOL_RESULT_CHARS = 8 000`** by `compactToolResultForChat` (`aiToolOutput.ts`) at five output call sites (chat, session-aware, MCP server, script builder, agent SDK). The capture wrapper goes **inside `executeTool`, before any compaction**: when the raw serialized result exceeds `MAX_TOOL_RESULT_CHARS`, the raw bytes are written to the blob store and the result becomes `{ artifact: { handle, bytes, contentType, head, tail }, compacted: <the existing compacted view> }`. The model keeps exactly the view it gets today **plus** a handle it can stage; the five compaction call sites are untouched. `head`/`tail` are each ≤ 2 KiB of the **raw** bytes (never a rendered form — the Claude Code "doubled formatting" lesson). A new optional `AiTool.captureExempt: true` flag (there is no result-shaping flag today) lets structured tools stay inline; default is capture.
- **Handles** are opaque ids scoped to `(org_id, run_id)`; resolving one requires the caller's org and either run ownership or an explicit share (ticket/report attachment row). No handle is a URL. Download is a short-lived signed redirect minted per request.

### 5.3 Workspace capabilities — `apps/api/src/services/workspace/workspaceTools.ts`

**Registration (four places, per how the registry actually works):** (1) the `aiTools` map via a `registerWorkspaceTools()` call in `aiTools.ts` (the hub with 51 such calls, ~190 tools today); (2) `TOOL_TIERS` in `aiAgentSdkTools.ts` — a tool absent there is invisible to chat and every run profile even if registered; (3) `TOOL_CAPABILITY` in `agentToolCatalog.ts` under a new capability id `workspace` appended to `AGENT_CAPABILITIES` (tone `standard`) — the catalog *classifies* names that are already in both maps, it registers nothing, and its contract test fails on any unmapped tool; (4) `tool()` declarations in `createBreezeMcpServer`. Tier 1 (they execute nothing on the fleet), `readOnly: false`, `policyDecidable: false`, `actEligible: false`.

**Gating is by tool-ref allowlist, not by a capability field.** `policy_snapshot` carries `toolAllowlist`; `capabilities` exists only in the picker DTO. A run reaches the workspace tools iff its effective allowlist (partner baseline ∩ org tighten, `effectivePolicy.ts` / `intersectToolRefs`) contains the `workspace_*` refs, and the `analysis` profile floor includes them. Absent refs are stripped **at registration** via `createBreezeMcpServer`'s `onlyTools` (which throws outside production on an unknown name — the double registration above is what keeps it from throwing). `buildAgentToolCatalog` is memoized process-wide, so the env flag gates it process-wide; the **per-org "no external processing" switch (§8) is enforced at admission**, not in the catalog.

| Tool | Input | Effect |
|---|---|---|
| `workspace_stage` | `{ handles: string[], into?: string }` | Resolves each handle (must belong to this run's org **and** be listed in the run's `staged_inputs` allowlist or produced earlier in this run), streams bytes into `/work/in/<name>`. Caps: total staged bytes, file count |
| `workspace_run` | `{ script: string, language: 'bash'\|'python'\|'node', timeoutSeconds?: number, stdinHandle?: string }` | Writes `script` to `/work/step-<n>.<ext>`, executes by path, returns `{ exitCode, stdoutHead, stderrHead, stdoutHandle?, durationMs }`. Stdout over the capture threshold becomes an artifact. `timeoutSeconds` ≤ remaining run compute budget |
| `workspace_collect` | `{ paths: string[], labels?: Record<string,string> }` | Reads files from `/work/out/**` only (paths normalised; symlinks and `..` rejected), stores each as an artifact, returns handles. Caps: file count, total bytes, per-file bytes |
| `workspace_cancel` | `{}` | Destroys the sandbox early; the run continues without a workspace (further workspace tools return a typed error) |

Lifecycle is implicit: the first `workspace_*` call in a run creates the sandbox; run completion, failure, cancellation, the wall-clock deadline, or the compute cap destroys it. The loop never holds a provider handle.

**Sandbox contents at create:** `/work/in` (inputs), `/work/out` (outputs), `/work/tmp`; a pinned bootstrap that installs nothing at run time (Python 3 + Node LTS from the vendor base runtime; `jq`, `ripgrep`, `sqlite3`, `pandas`, `openpyxl`, `python-docx` in the pinned bootstrap). Bootstrap is content-hashed; the hash is recorded on the run.

### 5.4 `analysis` run profile

Added to `AI_AGENT_RUN_PROFILES` and `AI_AGENT_LIMIT_DEFAULTS` (`packages/shared/src/types/aiAgents.ts`), with its own admission counters (`runService.ts` rules 5–7), mirroring how `verdict`/`sweep`/`narrative` were added.

| Limit | v1 default | Bound |
|---|---|---|
| `analysisMaxInputDevicesPerRun` | 50 | ≤ 200 |
| `analysisMaxTurnsPerRun` | 40 | ≤ 80 |
| `analysisWallClockSeconds` | 900 | ≤ 1800 |
| `analysisMaxComputeSeconds` | 600 | ≤ 3600 (sandbox CPU-seconds, enforced by the adapter across steps; the provider-side wall deadline is set to the run's remaining wall clock + 60 s at create) |
| `analysisMaxComputeCentsPerRun` | 25 | ≤ 200 |
| `analysisMaxStagedBytesPerRun` | 256 MiB | ≤ 1 GiB |
| `analysisMaxArtifactBytesPerRun` | 128 MiB | ≤ 512 MiB |
| `analysisMaxBudgetCentsPerRun` (tokens) | 150 | ≤ 500 |
| `analysisMaxRunsPerHour` / `analysisMaxConcurrentRuns` | 10 / 2 | — |
| `maxComputeCentsPerDay` (org, all profiles) | 500 | ≤ 5000 |

**Where inputs come from — the registry decides this, not the profile.** Two kinds of gathering exist today and they have different tiers:

- **Server-side datasets (Tier 1/2, already multi-device, RLS-scoped):** the ingested `event_logs` store (`search_logs`, `get_log_trends`, `detect_log_correlations`; max 500 rows per page with a keyset cursor), inventory and metrics (`query_devices`, `get_device_details`, `analyze_metrics`, `analyze_fleet_metrics`, `get_software_compliance`, `get_device_vulnerabilities`, `query_custom_fields`, `search_agent_logs`), and `generate_report` (device/software inventory as CSV/PDF/Excel via `report_runs` — the one artifact-shaped path that already exists). These are what an **unattended** `analysis` run gathers. v1 adds one tool, `export_dataset` (§5.7), that runs any of these queries to completion — every page, no 8 000-char compaction — straight into an artifact.
- **Live device reads (Tier 3 by design, SR5-01):** `file_operations:read`, `execute_command` (incl. `event_logs_query`; only `event_logs_list`, `file_list`, `list_processes` are Tier-2 read-only), `run_script`. Reads run as root/LocalSystem on the endpoint, so approval stays. An unattended run has no approval surface, so **v1 does not let the `analysis` profile perform live reads**. A technician who needs live files gathers them in chat under normal approval (each read becomes an artifact) and passes the handles into `workspace_launch_analysis({ inputHandles })`. A single batch intent covering N reads ("read `C:\logs\app.log` on these 12 devices", one approval) is follow-on **W-batch-reads** (§13). There is **no EVTX export tool today**; §13 W-batch-reads adds `execute_command:event_logs_export` (Tier 3) producing CSV/JSON artifacts, and the bootstrap carries an EVTX parser for files staged by a technician.

`analysisMaxInputDevicesPerRun` bounds the device set that dataset queries may span; the run's `targets` are frozen at admission as that set; dataset queries fan out server-side and are paced (≤ 4 concurrent device-scoped queries per run) so one analysis cannot saturate the API or, for live reads staged from chat, the agent WebSockets. **Actions remain single-device and intent-gated** exactly as today (`maxDevicesPerRun = 1` for act; `POLICY_DECIDABLE_TIER3.maxTargetCardinality = 1`). Multi-device *action* fan-out is #4173, not this spec.

### 5.5 Chat integration (D-E)

New Tier-1 tool `workspace_launch_analysis({ goal, deviceIds?, siteId?, inputHandles? })` available in chat sessions whose org has the `workspace` capability. It admits an `analysis` run (owner = the chat user, `session_id` = the chat session), returns the run id immediately, and the chat shows a run card. On completion, the worker publishes `ai.run.completed` (existing event bus); the chat's SSE stream delivers `{ type: 'run_result', runId, summary, artifacts: [{ handle, name, bytes }] }` and the assistant's next turn receives the summary as a tool result. The chat process never touches a sandbox.

### 5.6 Compute metering (D-F)

- After `destroy`, `usage()` is read and recorded: `ai_agent_runs.compute_cpu_ms`, `compute_wall_ms`, `compute_cents`; `ai_cost_usage` gains `compute_cents` (daily/monthly); `ai_sessions.total_compute_cents` for chat-launched runs.
- Pricing: `COMPUTE_PRICING[backend] = { cpuCentsPerHour, memCentsPerGbHour, minChargeCents }` in `aiCostTracker.ts`, set from the vendor list price with a configurable multiplier (`AI_COMPUTE_PRICE_MULTIPLIER`, default 1.0; product decides margin later). Unknown backend → refuse to create, never $0.
- **Every billing source pays for compute.** Token cost follows `billing_source` (a BYOK partner pays Anthropic), but the sandbox is ours: `compute_cents` is charged and deducted for `platform` **and** `partner_key` runs alike; catalog-provider sessions likewise.
- **Reservation:** at admission the run reserves `analysisMaxComputeCentsPerRun` against the org's daily compute budget and, for `billing_source = 'platform'`, against credits (the existing `checkBillingCredits` path, extended with a compute leg). Settlement replaces the reservation with actual on completion. This is the fix for the "credits are enforced after the fact" gap for this lane.
- Enforcement during a step: `workspace_run` passes `timeoutSeconds`; the adapter enforces it; the provider-side deadline is the backstop. A busy loop is killed mid-step, not between model turns.

### 5.7 `export_dataset` (new Tier-1/2 tool)

`export_dataset({ dataset, filters, deviceIds?, siteId?, format: 'jsonl'|'csv' })` where `dataset ∈ { event_logs, agent_logs, device_inventory, software_inventory, metrics, vulnerabilities, custom_fields }`. It reuses the exact query builders behind the corresponding existing tools (same RLS context, same `deviceArgs` enforcement, same tier as the underlying tool: `event_logs`/`agent_logs`/inventory Tier 1, anything the source tool makes Tier 2 stays Tier 2), pages to completion with the existing keyset cursors, and streams rows to a blob as an `input_capture` artifact. Caps: rows (default 200 k, ≤ 1 M), bytes (`analysisMaxStagedBytesPerRun`), wall time 120 s. Returns `{ artifact: { handle, bytes, rows, head, tail } }`. It is the bridge between "we have this data" and "the sandbox can compute on it", and it is what makes the driver workload run unattended.

### 5.8 Step transcript and progress

Every `workspace_run` step records `{ ordinal, language, scriptArtifactHandle, exitCode, durationMs, stdoutHandle? }` on `ai_run_workspaces.steps` (jsonb, `excludedOpen`) and as `step_script`/`step_stdout` artifacts, so the run page shows **exactly what code ran and what it printed** — the audit trail a technician needs to trust a finding. Scripts are subject to the same retention and secret-redaction pass as other artifacts. The worker publishes `ai.run.progress { runId, step, label }` on the existing event bus after admission, after each dataset export, after each step, and at collect; the chat run card and the run page render it. Completion still publishes `ai.run.completed`.

## 6. Data model

All tables Shape 1 (`org_id`), RLS enabled + forced + `breeze_has_org_access(org_id)` in the **creating** migration; registered in `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, FK children first), `CORE_TENANT_EXPORT_POLICY` (every column classified; all `jsonb` → `excludedOpen`), and `orgMergeRegistry` (any `BEFORE UPDATE` trigger classified). Composite FKs to `ai_agent_runs(id, org_id)` are `DEFERRABLE INITIALLY IMMEDIATE`. Migration filename sorts after the newest committed file at implementation time (as of 2026-09-13 that is `2026-10-15-160010-…`; today's date will **not** sort last — see CLAUDE.md).

### 6.1 `ai_run_artifacts`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | the **handle** |
| `org_id` | uuid fk organizations | RLS axis |
| `run_id` | uuid | composite FK `(run_id, org_id) → ai_agent_runs(id, org_id)` deferrable; `ON DELETE CASCADE` |
| `session_id` | uuid null | chat session that launched the run |
| `kind` | enum `input_capture \| step_stdout \| output \| report` | |
| `name` | text | display name, sanitised, ≤ 200 chars |
| `content_type` | text | sniffed + declared; never trusted for rendering (download only, `Content-Disposition: attachment`) |
| `bytes` | bigint | |
| `sha256` | text | integrity + dedupe within a run |
| `blob_key` | text | opaque, no tenant id |
| `head_preview`, `tail_preview` | text | ≤ 2 KiB each, raw |
| `source_device_id` | uuid null | for input captures; FK `devices(id)` `ON DELETE SET NULL`. Deliberately **not** named `device_id`: artifacts outlive the device and must not join the device cascade or move-org lists (both key on a `device_id` column) |
| `created_by_tool` | text | tool name that produced it |
| `expires_at` | timestamptz | default `now() + 30 days`; sweeper deletes blob then row |
| `created_at` | timestamptz | |

Indexes: `(org_id, run_id)`, `(org_id, expires_at)`, `(org_id, source_device_id)`.

### 6.2 `ai_run_workspaces`

One row per sandbox instance (a run has at most one live; `workspace_cancel` then a later `workspace_*` call is refused, so ≤ 1 per run).

| column | notes |
|---|---|
| `id`, `org_id`, `run_id` (composite deferrable FK) | |
| `backend` enum `vercel \| gvisor_pool \| agentcore \| fake` | |
| `provider_ref` text | vendor sandbox id; needed by the reaper |
| `region` enum `eu \| us` | asserted equal to the org's region at create |
| `bootstrap_hash` text | |
| `status` enum `creating \| ready \| destroying \| destroyed \| destroy_failed` | `destroy_failed` is paged |
| `created_at`, `ready_at`, `destroyed_at` | |
| `cpu_ms`, `wall_ms`, `mem_allocated_mb`, `compute_cents` | filled at settlement |
| `deadline_at` | provider-side deadline; reaper key |
| `staged_bytes`, `artifact_bytes`, `step_count` | running counters for caps |

### 6.3 Existing tables

- `ai_agent_runs`: add `compute_cpu_ms`, `compute_wall_ms`, `compute_cents int`, `compute_reserved_cents int`, `staged_inputs jsonb` (the frozen input allowlist: handles + device ids — `excludedOpen`), `workspace_id uuid null`. `policy_snapshot` bumps a version; `AI_AGENT_RUN_DTO_SCHEMA_VERSION` bumps (#4214 is the standing note).
- `ai_cost_usage`: add `compute_cents real`. `ai_sessions`: add `total_compute_cents real`. `ai_budgets`: add `max_compute_cents_per_day int`.
- `ai_agents.limits` jsonb: the §5.4 keys (Zod in `packages/shared/src/validators/aiAgents.ts`).
- Ticket attachments and `report_runs`: an `artifact_id` reference (nullable FK, `ON DELETE SET NULL`) so a handle can be attached without copying bytes.

## 7. Data flow (analysis run)

1. **Admission** (`runService.ts`): profile `analysis`; capability `workspace` present in the effective policy; org region resolved; compute reservation taken (§5.6); `targets` frozen as the input device set; `dedupe_key` as today.
2. **Loop start** (`runLoop.ts`): Breeze tools + workspace tools registered per the snapshot; system prompt gains a fixed workspace section (paths, caps, "your code cannot reach the network or any device; propose actions, do not attempt them").
3. **Gathering**: the model calls `export_dataset` (§5.7) for the datasets it needs, plus ordinary Tier-1/2 read tools whose results, when over `MAX_TOOL_RESULT_CHARS`, become `input_capture` artifacts automatically (§5.2). Any technician-supplied `inputHandles` from chat (live reads approved there) are already artifacts. The model sees handles with previews, never the bulk.
4. **Workspace**: first `workspace_stage` creates the sandbox (region = org region, deny-all, persistence off, provider deadline = remaining run wall clock + 60 s), records `ai_run_workspaces`, writes the staged files. `workspace_run` steps execute by path with per-step timeouts; stdout beyond the threshold becomes `step_stdout` artifacts. `workspace_collect` reads `/work/out/**` into `output` artifacts.
5. **Outcome**: the profile's outcome tool `submit_analysis({ summary, findings[], artifactHandles[], proposedActions[] })` (Tier 1, executes nothing). `proposedActions` are rendered as proposals a technician can turn into intents via the existing approval UI; the run never executes them.
6. **Teardown** (`finally`): destroy; read usage; settle compute; update run; publish `ai.run.completed`. The reaper (`jobs/workspaceReaper.ts`, every minute) destroys any `ai_run_workspaces` row past `deadline_at + 120 s` not yet `destroyed`, and pages on `destroy_failed`.
7. **Delivery**: run page lists artifacts (name, size, preview, download); chat receives `run_result`; ticket/report attach by handle.

## 8. Security model

- **Isolation boundary:** vendor microVM (Vercel: Firecracker). The sandbox holds no credentials, no env secrets, no Breeze token; its only inputs are the staged files. Nothing in it can open a network connection (deny-all incl. DNS). Persistence disabled; `destroy` purges snapshots; the nightly suite proves it.
- **Authority:** unchanged. Tier gate, intents, four-eyes, kill switch, agent principal (`userId: null`, never system scope) apply to every Breeze tool the run calls. Workspace tools are Tier 1 because they cannot touch the fleet. `execute_command` and `run_script` remain exactly as gated today; the sandbox is not a path around them.
- **Data minimisation:** `workspace_stage` accepts only handles in the run's frozen `staged_inputs` or produced by this run; "the org's data" is never mounted wholesale. Device file reads stay Tier 3 (approval) where they are today; approval is the human check on *what* enters the box.
- **Injection containment:** anything a staged log says is data inside the box; the model's only channel back is text and files, and files are inert (downloaded as attachments, never rendered or executed by Breeze). `proposedActions` are proposals, structurally unable to execute.
- **Metadata and rendering:** artifacts download with `Content-Disposition: attachment` and a fixed safe content-type map; previews are text-escaped. No HTML artifact is ever served inline.
- **Caps everywhere** (§5.4): staged bytes, artifact bytes, per-file bytes, file count, stdout bytes, step timeout, compute seconds, compute cents, turns, wall clock. Each cap failure is a typed tool error the model can read, and a counter.
- **Residency:** sandbox region equals org region, asserted at create and recorded. Customer-facing claim in v1: "analysis code executes in <region>"; **not** "all data stays in the EU" until the Vercel DPA/subprocessor review (spike §H.1) is complete. Blob store buckets are per region.
- **Region of the blob store and the worker** are already regional; the artifact key carries no tenant id; erasure (`tenantCascade.ts`) deletes blobs via the helper before the rows cascade.
- **Per-org external-processing switch:** `organizations.ai_external_processing` (default follows the partner setting; default off until the DPA review) is checked at **admission** of any `analysis` run and by `workspace_launch_analysis`; when off, the run is refused with `external_processing_disabled` and the capability is hidden in that org's picker. Enforced in `runService.ts`, not the (process-memoized) catalog.
- **Do not rely on Tier 4.** `BLOCKED_TOOLS` is empty today; nothing in this design depends on blocking. Isolation comes from the sandbox having no network and no credentials, and from the workspace tools being unable to reach the fleet.
- **Hosted only:** `IS_HOSTED=true` and `BREEZE_AI_WORKSPACE_ENABLED=true` (sub-flag of `BREEZE_AI_AGENTS_ENABLED`) or the capability is absent from the catalog and the profile is not admissible.

## 9. Error handling

| Failure | Behaviour |
|---|---|
| Vendor create fails / quota | Run fails `workspace_unavailable`; reservation released; circuit breaker per backend (5 consecutive → 10 min open, paged) |
| Step timeout | Step returns `{ exitCode: null, timedOut: true, stdoutHead }`; run continues; counts against compute |
| Compute cap reached | Sandbox destroyed; further workspace tools return `compute_cap_reached`; the model must conclude with what it has |
| Provider deadline fires | Sandbox gone; next tool call returns `workspace_expired`; usage read from provider if available else estimated from `deadline − ready_at` and flagged `usage_estimated` |
| `destroy` fails | Row `destroy_failed`, paged; reaper retries with backoff; billing uses last known usage |
| Usage unavailable after stop | Settle at the **reservation** (worst case), flag `usage_estimated`; never $0 |
| Blob write fails | Tool error `artifact_store_unavailable`; result **not** returned inline (no fallback that bypasses the cap) |
| Worker crash mid-run | Existing run lease/reconcile path marks the run `failed`; reaper destroys the sandbox by `provider_ref` |
| Handle resolve denied | `artifact_forbidden`; audited |

## 10. Observability

Metrics: `ai_workspace_create_seconds`, `ai_workspace_steps_total{exit}`, `ai_workspace_compute_seconds_total{backend,region}`, `ai_workspace_cap_hits_total{cap}`, `ai_workspace_destroy_failed_total`, `ai_artifacts_bytes_total{kind}`. Run page shows compute cents beside token cents. `llm_egress_events`-style table is **not** needed in v1 (no network); the nightly suite's blocked-egress assertions are the evidence.

## 11. Rollout

1. Flags off; migrations ship; adapter + fake + unit suites.
2. Nightly real-Vercel suite green for a week (egress, cleanup, caps, deadline, usage).
3. Enable for LanternOps' own partner in EU and US; run the driver workload against the lab rigs.
4. Enable per partner on request (capability in partner baseline). Default remains off.
5. Vercel DPA/subprocessor review complete → residency wording upgraded, or not.

## 12. Testing contracts

- `sandboxBackend.contract.test.ts`: every backend passes the same suite (caps, idempotent destroy, exec-by-path only, usage shape).
- Registry contracts (existing suites must stay green): `agentToolCatalog.contract.test.ts` (every tool mapped to a capability), `TOOL_TIERS` ↔ `aiTools` parity, `createBreezeMcpServer` `onlyTools` unknown-name guard, `registryDescription` rename guard. Fix first: `get_backup_health`, `run_backup_verification`, `get_recovery_readiness` are declared and tiered but have **no handler** in `aiTools` (every call throws `Unknown tool`) — file an issue and add a test that every `tool()` declaration has a registered handler, so the four-place registration in §5.3 cannot regress.
- `exportDataset.test.ts`: pages to completion, respects `deviceArgs` gating and RLS context, row/byte/time caps, jsonl/csv fidelity.
- `workspaceTools.test.ts`: stage rejects handles outside `staged_inputs`; collect rejects `..`/symlinks/paths outside `/work/out`; script never reaches a shell string.
- `artifactCapture.test.ts`: raw bytes persisted, previews raw, threshold boundary, opt-out honoured.
- `analysisProfile.admission.test.ts`: reservation, daily compute budget, concurrency, capability gate, region assertion.
- `computeMetering.test.ts`: settlement replaces reservation; unknown backend refuses; estimated-usage flag.
- Integration (live DB): RLS forge on both tables (42501), cascade + export-policy + org-merge registrations, erasure deletes blobs then rows, ticket/report attach by handle.
- **Nightly `workspace.vercel.e2e.test.ts`** (env-gated, not on PRs): DNS/raw-IP/IPv6 egress blocked; `curl` to a public host fails; nothing survives destroy (list sandboxes/snapshots → none for the run); deadline fires; usage fields present; 256 MiB stage succeeds; over-cap stage refused.
- Red-team fixture: a staged log containing instructions to exfiltrate; assert no network attempt and no action intent minted.

## 13. Follow-on waves (not in v1)

- **W-chat-on-worker:** move chat session execution to the worker role (SSE relayed via Redis); fixes process pinning and lost sessions on deploy.
- **W-bulk-ingest:** presigned-URL staging for inputs above the worker-transit cap; introduces the artifact broker (single hostname, run-scoped expiring grants, rate limits) and the adversarial egress suite for an allowlist.
- **W-gvisor-pool:** self-hosted backend on regional droplets (spike §C); reviewed as a security-boundary change on its own merits.
- **W-agentcore:** AWS AgentCore backend (spike §J) if residency/metering demands it.
- **W-authoring-fixtures:** script authoring lane runs candidate scripts against fixtures in the workspace before proposing them.
- **W-fanout / partner ceiling:** #4173 and a partner-level compute + token ceiling.
- **W-batch-reads:** one action intent covering N live reads across devices (one approval, N executions, per-device outcome), `execute_command:event_logs_export` (Tier 3) to CSV/JSON artifacts, EVTX parser in the bootstrap. Lets an `analysis` run be launched with live files without N separate approvals.
- **W-memory (per-agent knowledge):** an org- or partner-scoped **memory store** for each `ai_agents` row: versioned Markdown documents held as artifacts (immutable versions, rollback, redact — the Managed Agents memory-store model; never credentials), staged **read-only** into every run of that agent at `/work/memory/`, and updated only through a `memory_write` tool that the loop calls with size caps, diff audit, and optional technician review — never by the sandbox writing to a remounted filesystem (D-B stands: persistence goes through a gated tool, not the box). Retrieval beyond what fits in context reuses the EE workspace hybrid search (pgvector + lexical) over the same documents. This is how "one agent per client that comes to know its estate" is built on this plane; #4183 (prior-run and runbook memory in the prompt) folds into it.

## 14. Open questions

1. **Vercel option names and limits** (persistence flag, region ids, per-file write limits, usage field semantics) — resolved in the implementation plan by reading the SDK docs; semantics fixed here.
2. **Compute price multiplier** — product decision; default 1.0 (pass-through) until set.
3. **Artifact retention** — 30 days default; partner-configurable later?
4. **Vercel DPA / subprocessor review** — owner Todd; gates residency wording only, not v1.
