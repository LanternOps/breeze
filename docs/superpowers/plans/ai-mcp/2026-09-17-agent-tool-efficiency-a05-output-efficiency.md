---
tracking_issue: LanternOps/breeze#6147
wave_issue: LanternOps/breeze#6152
branch: feature/6147-agent-tool-efficiency/wave-6152
---
# Agent tool efficiency A-W05: output efficiency — result shaping, pagination, large-payload handles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the tokens a tool result costs the in-product agents without losing meaning: every list tool the model reaches for pages honestly (`hasMore`/`nextCursor`), no default page is silently replaced by a digest, a truncated result tells the model the next step it can actually take, and an oversized result becomes a handle the model can read back.

**Architecture:** One shared pagination helper (`aiToolPagination.ts`) produces one additive envelope that every shaped tool emits on top of its existing keys. The compaction chokepoint (`compactToolResultForChat`) stays the safety net but learns, through an injected resolver, whether the tool it is compacting can page, so its sentinel and `_chat.nextStep` never suggest something the tool cannot do. Output-size telemetry is derived from the compacted payload the chat path already persists in `ai_tool_executions.tool_output` (no schema change), which also picks the shaping list from production. Large payloads reuse the execution plane's artifact store: capture now stores the redacted full payload, a new `read_artifact` tool pages it back, and the external MCP server renders a captured result as a version-gated `resource_link`.

**Tech Stack:** TypeScript (Hono API), Drizzle, Zod, Vitest; Postgres jsonb aggregates for the report; the `@anthropic-ai/claude-agent-sdk` `tool()` declarations; S3 `Range` reads through `@aws-sdk/client-s3`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md`, Feature A row **A-W05** ("Fix #6140 redactor first … then: per-tool result shaping review for the 20 hottest tools, pagination params where results are truncated by the 8k cap, `resource_link`-style handles for large payloads (exports, logs), structured results"); principles 1 (measure), 2 (one source of truth), 4 (tool never weaker than its route), 5 (no write without read-back), 6 (never rename). Plan index: `2026-09-17-agent-tool-efficiency-and-mcp-modernization.md` — this plan adds decisions **D10–D16** there.

**Tracking:** `get_feature_status LanternOps/breeze#6147` first; `start_wave` on #6152; one PR with `Closes #6152`. **Prerequisites:** #6324 (the #6140 redactor fix) is on main; **A-W03 (#6468) must be merged before this branch is cut** — its description-budget and Actions-clause contracts judge every description this wave touches, and its `registryDescription()` is the only description surface (see "Merge order" below).

**Verified against `origin/main` `9b8189c1df`** (2026-09-20). Line numbers drift — re-grep before editing.

---

## Merge order and what this wave inherits

- **After A-W03 (#6468).** On main today `aiAgentSdkTools.ts` still carries inline `tool()` descriptions (`'query_devices'` at `aiAgentSdkTools.ts:~1000`); on the A-W03 branch every declaration reads `registryDescription(name)` and two new contracts exist: `aiTools.descriptionBudget.contract.test.ts` (≤ 300-char tool description, ≤ 160-char property description, recursive; no workflow prose; every `action` enum value named in the description) and `aiTools.actionClauses.contract.test.ts` (an `Actions:` clause must list every enum value and end at the first `.`/`;`). Every description or parameter this wave adds must satisfy both. Cut the branch from main only once `#6468` has landed; if it has not, stop and say so.
- **B-W01 (#6406) is merged.** `structuredContent` is derived from the redacted text (`routes/mcpServer.ts:1244-1256`, `structuredFromSafeText`) and is omitted for digests and pure `{error}` objects. Every envelope this wave adds is a plain JSON object, so it flows through unchanged.
- **A-W06 (#6414) is merged.** `MCP_COVERAGE` (`services/mcpCoverage.ts`) and its completeness contract (`src/__tests__/mcp-coverage.test.ts`) exist; `'aiArtifacts.ts'` is a frozen `gap: '#6141'` entry that Task 6 closes.
- **Capture is hosted-only.** `captureLargeToolResult` fires only when `aiWorkspaceEnabled()` (`config/env.ts:248` = `isHosted() && BREEZE_AI_AGENTS_ENABLED && BREEZE_AI_WORKSPACE_ENABLED`) and an anchor exists (`captureContextFrom`, `services/artifacts/toolResultCapture.ts:87`). Pagination and shaping (Tasks 2–5) are universal; handles (Tasks 6–7) work only where capture does (D15).

## Global Constraints

- **Never rename a tool; never remove an action; never remove a top-level result key.** Every envelope change is additive: a tool that returns `{ devices, total, showing }` today returns `{ devices, total, totalMode, showing, limit, offset, hasMore, nextCursor }` afterwards. Row *projections* may drop heavy fields (D14) only where a `get_*` detail tool or an opt-in parameter still exposes them, and the description says what a row carries.
- **Tool never weaker than its route** (#6096/#6110). `read_artifact` (Task 6) is *stronger* than `GET /api/v1/ai/artifacts/:id` and declares that in `aiGuardrails.routeBinding.contract.test.ts` as a `toolOnly` row.
- **Descriptions (A-W03 contract):** tool description ≤ 300 chars, every property description ≤ 160 chars, no workflow prose (`/\b(step \d|first call|then call|after that|workflow:)\b/i`, numbered `1) ` lists, inline JSON), and an `Actions:` clause that names every enum value. Property text for paging is fixed by `pageParamSchema()` (Task 2) so it is identical on every tool.
- **Three input-schema surfaces per tool.** The registry `definition.input_schema` (what the external MCP server lists), `toolInputSchemas` in `services/aiToolSchemas.ts` (what `validateToolInput` enforces), and the Zod shape passed to `tool()` in `services/aiAgentSdkTools.ts` (what the chat model sees; `list_scripts` lives in `services/scriptBuilderTools.ts`). A paging parameter is added to all three or it does not exist; Task 4's contract test enforces it.
- **Redaction key rule** (`services/logRedaction.ts:189-201`, after #6324): a string leaf is wiped when its key matches `password|passwd|pwd|token|secret|api.*key|access.*key|private.*key|client.*secret|authorization|cookie|credential|community|authpassphrase|privacypassphrase|connection.?string|conn.?string|sas.?token|shared.?key` or is a bare session-identifier key. New keys this wave introduces — `nextCursor`, `hasMore`, `showing`, `limit`, `offset`, `total`, `totalMode`, `handle`, `nextOffset`, `stepCount`, `detailsKeys`, `messageTruncated` — are all outside that pattern. Never name a key `*Token`, `*Key`, `cursorToken`.
- **The compactor gains no tool names.** `applyToolSpecificCompaction` (`services/aiToolOutput.ts:528`) and `fleetListTools` (`:559`) stay as they are; shaping happens in handlers (D14).
- **No new tables, no migrations, no new env vars.** Telemetry reads the jsonb the chat path already writes (D10); capture stays behind `aiWorkspaceEnabled()` (D15).
- **Helper allowlists unchanged.** `services/helperToolFilter.ts` is an explicit per-level allowlist; `read_artifact` is not added to it.
- **Measure, do not assert (principle 1).** Every shaped tool's "before" size is the number its own failing fixture test prints in Step 1 (Task 5), its "after" is the passing run; both go in the PR table and the baseline doc (Task 8). The golden eval re-runs and first-call accuracy must not drop, reported per tool for list tools, not only in aggregate.
- **Commands:** `cd apps/api && npx vitest run <path>` (substring match — check the printed file count); `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json`; `pnpm lint`. **Before the PR: `cd apps/api && npx vitest run` (whole unit suite) — three contracts in this wave only red in the full run** (`__tests__/mcp-coverage.test.ts`, `aiGuardrailsTierConfig.parity.test.ts`, `workerEntrypointClosure.contract.test.ts`). Never `pnpm --filter <pkg> test -- --run <path>`.
- **Commit after every task.** Trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Decisions this plan makes (D10–D16)

Fable position formed 2026-09-20; independent review by an Opus reviewer the same day (Codex `xhigh` was over its usage limit until 2026-09-26 — **the Codex pass is owed** and any change it demands is folded into this plan inside the wave's PR, as A-W03 did for D7). The reviewer's four blocking corrections are already applied below.

- **D10 — Output telemetry is derived from the persisted `_chat` envelope; no schema change.** `createSessionPostToolUse` persists the *compacted* payload as `ai_tool_executions.tool_output` (`services/aiAgentSdk.ts:2288`, `:2308`), which carries `_chat.outputCompacted`/`_chat.originalChars` when compacted and `summarized: true` for a digest. When capture fired the persisted value is the envelope `{ artifact, compacted }`, so `_chat` lives under `compacted` — the report reads `COALESCE(tool_output->'_chat', tool_output->'compacted'->'_chat')`. The MCP ledger writes a 500-char summary and the agent-run ledger writes nothing (`services/aiAgents/executionLedger.ts:136`), so the report covers chat and Helper only — the spec's priority — and the baseline doc says so. **Ranking for shaping** = `executions × delivered_chars_p50` (total delivered characters) first, compaction/digest share second; the frozen unbounded-read baseline (D12) is an independent input the ranking cannot outvote. Rejected: new columns (migration, export-policy review, no history).
- **D11 — One additive pagination envelope, produced by a shared helper.** `readPageArgs` + `pageEnvelope` + fingerprint-bound opaque cursors (pattern: `routes/devices/optionsCursor.ts`). Two modes: **offset** (`limit`, `offset`, `cursor`) for stable lists, **keyset** (`limit`, `cursor`, no `offset`) for churn tables (alerts, agent logs, audit log, change log) where an insert between pages would shift every later offset invisibly. `search_logs` (`services/aiToolsEventLogs.ts:150-157`) already emits the target key set and is untouched. A cursor from a different query is refused with a tool error (`CURSOR_MISMATCH`), never silently reset to page 1. `total` is kept wherever a tool already counts; `hasMore` is derived from the count when there is one and from an over-fetch of `limit + 1` otherwise.
- **D12 — Truncation guidance must be something the tool can honour.** The array sentinel `...[truncated: N more items omitted. Use pagination or the REST API]` (`aiToolOutput.ts:111`) is emitted today for tools with no paging at all. The compactor learns the tool's paging shape through an **injected resolver** set by the tool hub (`setToolPaginationHintResolver`, the same inversion `logRedaction.ts:211-213` uses) — never by importing the registry, which would drag Hono+Ajv into every worker that imports `aiToolOutput` for a constant (`workerEntrypointClosure.contract.test.ts`, #4086) and would read an empty map in any process that loads the compactor without the hub. `_chat.nextStep` carries the same hint. A contract test freezes the set of read tools that return arrays with no `limit` (shrink-only) and requires every `limit` property to state "default N, max M".
- **D13 — Handles reuse `ai_run_artifacts`; the wave makes them consumable and safe.** (a) `read_artifact` (tier 1, domain `ai`, capability `workspace`, permission `ai_agents:read`) pages an artifact by **byte offset** through a new `BlobStorage.openRange` (S3 `Range`; a whole-object `openStream` per 6 000-char page would be O(n²) egress on a 64 MiB artifact). It is scoped to the caller's **own** session or agent run (`findArtifactForCaller`), stronger than the org-wide REST download. (b) **Redact-then-capture:** `captureLargeToolResult` stores `redactForCapture(raw)` — the org-downloadable store never holds credential material; the threshold is still measured on the raw string, so the non-capture path is byte-identical. (c) External MCP: a result carrying the capture envelope gains a `{ type: 'resource_link', uri: 'breeze://artifacts/<id>' }` content block **only when the negotiated protocol version is ≥ `2025-06-18`** (`resource_link` did not exist before; the server assumes `2025-03-26` when the header is absent — `services/mcpProtocol.ts:6`), and `resources/read` serves a server-capped byte window of `breeze://artifacts/{id}`. Over MCP this is honest but narrow today: tier-1/2 MCP calls have no `ai_sessions` anchor, so capture never fires for them; anchoring MCP reads is a Feature B follow-up (filed in Task 8), not this wave.
- **D14 — Result shaping is handler-side projection and defaults, not new compactor special cases.** For each of the 20 tools: a default `limit` whose fixture page fits under `MAX_TOOL_RESULT_CHARS` (8 000) without `_chat.outputCompacted`; heavy per-row fields (jsonb `settings`/`details`/`metadata`, script bodies, `stdout`, nested arrays) leave list rows behind an opt-in parameter or the matching detail tool; nested per-row arrays are capped with a `<key>Count`.
- **D15 — Capture gate unchanged this wave.** Decoupling capture from `aiWorkspaceEnabled()` needs a new env var, `config/validate.ts`, compose mapping and sweeper coverage — and a mis-mapped flag would start writing org-downloadable blobs on deployments that never consented (the `IS_HOSTED` failure shape, #570). Filed as a follow-up in Task 8. Where capture is off, `read_artifact` refuses with a typed error rather than returning nothing.
- **D16 — No `outputSchema` on `tools/list` this wave.** Handlers return `Promise<string>` with no declared shape and `structuredFromSafeText` legitimately omits `structuredContent` for digests; advertising a schema the server sometimes omits breaks strict clients. Revisit under Feature B.

## The 20 tools (provisional, replaced by D10's production ranking)

The production hot list (baseline doc §4) has not been run. This list is the union of (i) the chat surface's `alwaysLoad`/golden-eval reads, (ii) every tool the 2026-09-20 survey found returning whole rows, jsonb columns, uncapped sub-arrays or no `limit` at all, ranked by likely traffic. **When Todd runs the D10 SQL (Task 1) on EU + US before Task 5 starts, replace this list with the report's top 20 by `executions × delivered_chars_p50`, keep every unbounded-read tool below regardless of rank, and record the substitution in the PR.** Line numbers are from the survey on `9b8189c1df`.

| # | Tool (action) | Registration / return | Today | Target (Task 5 group) |
|---|---|---|---|---|
| 1 | `query_devices` | `aiToolsDevice.ts:101` / `:184` | `{ devices, total, showing }`, limit 25/100, `COUNT(*)` | offset mode; envelope adds `totalMode, limit, offset, hasMore, nextCursor`; default 25, max 100 (5a) |
| 2 | `manage_tickets` (list) | `aiToolsTicketing.ts:444` / `:642` | `{ tickets, showing }`, 25/100, no total | offset mode, over-fetch; default 25, max 100 (5a) |
| 3 | `manage_patches` (list) | `aiToolsFleet.ts:1016` / `:1117`,`:1131` | `{ patches, showing, scope }`, 25/100 | offset mode, over-fetch; keep `scope`; default 25, max 100 (5a) |
| 4 | `list_scripts` | `aiToolsScripts.ts:912` / `:955` (SDK shape in `scriptBuilderTools.ts`) | `{ scripts, count }`, 20/50 | offset mode; keep `count`; default 20, max 50 (5a) |
| 5 | `get_security_posture` | `aiToolsSecurity.ts:173` / `:275` | `{ summary, worstDevices, devices }`, default 100/500; `worstDevices` duplicates the first 10 | offset mode on `devices`; default 25, max 500; `summary`/`worstDevices` kept (5a) |
| 6 | `list_monitors` | `aiToolsMonitors.ts:206` / `:231` | fetches ALL definitions then `.slice(0, limit)`; `total` = `rows.length` | offset mode over the fetched rows: `total` = true row count, `hasMore` = `offset + showing < total`; default 25, max 100 (5a) |
| 7 | `list_ai_agents` | `aiToolsAiAgentGovernance.ts:109` / `:122` | `{ agents, showing }`, **no limit** | offset mode; default 25, max 100 (5a) |
| 8 | `get_device_vulnerabilities` | `aiToolsVulnerability.ts:278` / `:321` | `{ deviceId, vulnerabilities, count }`, **no limit** | offset mode, over-fetch; keep `count`; default 50, max 200 (5a) |
| 9 | `manage_alerts` (list) | `aiToolsAlerts.ts:88` / `:164`; `orderBy(desc(alerts.triggeredAt))` `:156` | `{ alerts, total, showing }`, 25/100, `COUNT(*)`; `message` unbounded | **keyset** on `(triggeredAt, id)`; keep `total`; `message` cut at 500 chars with `messageTruncated: true`; default 20, max 100 (5b) |
| 10 | `search_agent_logs` | `aiToolsAgentLogs.ts:92` / `:164`; `orderBy(desc(createdAt), desc(timestamp), desc(id))` `:161` | `{ logs, count }`, 100/500, `db.select()` whole row then mapped; `fields` jsonb | **keyset** on `(createdAt, id)`; explicit column map; `fields` only with `includeFields: true`; `message` cut at 1 000 chars with `messageTruncated`; keep `count`; default 50, max 500 (5b) |
| 11 | `query_audit_log` | `aiToolsAudit.ts:78` / `:213`; `orderBy(desc(auditLogs.timestamp))` `:210` | `{ entries, showing }`, 25/100; `details` jsonb per row | **keyset** on `(timestamp, id)`; `details` replaced by `detailsKeys: string[]` unless `includeDetails: true`; default 25, max 100 (5b) |
| 12 | `query_change_log` | `aiToolsAudit.ts:227` / `:316`; `orderBy(desc(deviceChangeLog.timestamp))` `:308` | `{ changes, total, showing, filters }`, 100/500, `COUNT(*)`; `beforeValue`/`afterValue`/`details` jsonb | **keyset** on `(timestamp, id)`; keep `total`, `filters`; the three jsonb fields only with `includeValues: true`, else `changedKeys: string[]`; default 50, max 500 (5b) |
| 13 | `list_organizations` | `aiToolsOrgs.ts:747` → `:163` / `:232` | `{ organizations, showing }`, 25/100; `sites[]` per org uncapped | offset mode, over-fetch; `sites` capped at 20 per org + `siteCount`; default 25, max 100 (5c) |
| 14 | `list_configuration_policies` | `aiToolsConfigPolicy.ts:236` / `:289` | whole rows spread (`{...p}`) incl. `settings` jsonb, 25/100 | offset mode; explicit projection (`id, name, description, orgId, partnerId, isDefault, priority, featureTypes, createdAt, updatedAt`) + `settingsKeys`; detail stays in `get_configuration_policy`; default 25, max 100 (5c) |
| 15 | `get_device_details` | `aiToolsDevice.ts:202` / `:237` | `db.select().from(deviceHardware/deviceNetwork/deviceDisks)` whole rows `:221-224`; `networkInterfaces`, `disks` uncapped | explicit scalar projections (no jsonb column in any row); `networkInterfaces` ≤ 16 + `networkInterfaceCount`; `disks` ≤ 16 + `diskCount` (5c) |
| 16 | `get_script_execution` | `aiToolsScripts.ts:1225` / `:1289` | full `stdout` + `stderr` `:1263-1264` | character windows: `stdoutOffset` (default 0), `stdoutMaxChars` (default 6 000, max 16 000), `stderrMaxChars` (default 2 000, max 8 000); adds `stdoutChars, stdoutNextOffset, stdoutHasMore, stderrChars, stderrTruncated` (5c) |
| 17 | `get_incident_timeline` | `aiToolsIncident.ts:423` / `:465` | `actions[]`, `evidence[]` uncapped `:477,:492`; evidence whole rows + `metadata` jsonb | `actions` ≤ 50 + `actionCount`; `evidence` ≤ 50 + `evidenceCount`, explicit projection, `metadata` only with `includeEvidenceMetadata: true`; `timeline` ≤ 100 + `timelineCount` (5c) |
| 18 | `list_playbooks` | `aiToolsPlaybooks.ts:64` / `:104` | **no limit**; `steps` jsonb per row `:98` | offset mode, default 25, max 100; rows carry `stepCount` + `stepNames` (first 10) instead of `steps` unless `includeSteps: true`; keep `count` (5c) |
| 19 | `get_active_users` | `aiToolsPerformance.ts:508` / `:616` | `limit` caps sessions (100/200); `devices[].sessions[]` uncapped | `limit` = max devices (default 50, max 200); new `maxSessionsPerDevice` (default 10, max 50) + per-device `sessionCount`; adds `deviceCount, showing, hasMore` (5c) |
| 20 | `get_cis_compliance` | `aiToolsCisBenchmark.ts:76` / `:256` | 100/500; per-row `summary` jsonb `:213`; `COUNT(*)` `:187` | offset mode; default 25, max 500; per-row `summary` only with `includeSummary: true`; `totalMatched` doubles as `total` (5c) |

**Frozen unbounded reads (D12b baseline, shrink-only):** `list_deliverables`, `list_deliverable_templates`, `list_org_documents`, `query_custom_fields`, `get_user_risk_detail`, `search_documentation`, `get_effective_configuration`, `get_executive_summary`, `manage_monitors` (get: `alertRules[]`), `manage_tickets` (get: `checklist.items[]`), `get_vulnerability_report`. They stay in the baseline this wave; each removal is a later shaping change.

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `apps/api/src/services/aiToolUsageReport.ts` (+ `.test.ts`) | Hot/cold report gains delivered-size, compaction, digest and capture columns and `hotForShaping` | 1 |
| `docs/superpowers/specs/ai-mcp/sql/2026-09-17-ai-tool-usage-90d.sql` | Operator copy of the report SQL (parity-tested) | 1 |
| `apps/api/src/services/aiToolPagination.ts` (+ `.test.ts`) | `readPageArgs`, `pageEnvelope`, `readKeysetArgs`, `keysetEnvelope`, cursors, `pageParamSchema`, `pageZodShape`, `keysetParamSchema`, `keysetZodShape` | 2 |
| `apps/api/src/services/aiToolOutput.ts` (+ `aiToolOutput.test.ts`) | Injected pagination-hint resolver, registry-aware sentinel, `_chat.nextStep`, `redactForCapture`, `readCaptureHandle` | 3, 6, 7 |
| `apps/api/src/services/aiTools.ts` | Installs the hint resolver after registration; imports `registerArtifactTools` | 3, 6 |
| `apps/api/src/services/aiToolOutputBudget.testkit.ts` | `fixtureRow`, `measureToolPage`, `expectDefaultPageFits` for every shaped tool's test | 4 |
| `apps/api/src/services/aiTools.outputBudget.contract.test.ts` | "default N, max M" lint, three-surface paging parity, frozen unbounded-read baseline | 4 |
| `apps/api/src/services/aiTools*.ts` (20 tools) + `aiToolSchemas.ts` + `aiAgentSdkTools.ts` (+ `scriptBuilderTools.ts` for `list_scripts`) | Shaping per the table above; one `*.outputShape.test.ts` per touched tool file | 5a–5c |
| `apps/api/src/services/artifacts/blobStorage.ts` (+ `.test.ts`) | `openRange(key, start, endInclusive)` on the interface and the S3 backend | 6 |
| `apps/api/src/services/artifacts/artifactService.ts` (+ `.test.ts`) | `findArtifactForCaller`, `readArtifactWindow`, `ARTIFACT_READ_MAX_CHARS` | 6 |
| `apps/api/src/services/artifacts/toolResultCapture.ts` (+ `.test.ts`) | Stores the redacted full payload | 6 |
| `apps/api/src/services/aiToolsArtifacts.ts` (+ `.test.ts`) | `read_artifact` tool | 6 |
| `apps/api/src/services/aiToolSchemas.ts`, `aiAgentSdkTools.ts`, `aiGuardrails.ts`, `aiAgents/agentToolCatalog.ts`, `mcpCoverage.ts`, `aiGuardrails.routeBinding.contract.test.ts`, `src/__tests__/mcp-coverage.test.ts`, `apps/web/src/components/ai-risk/tierConfig.ts` | `read_artifact` registration on every surface the contracts check | 6 |
| `apps/api/src/services/mcpProtocol.ts` (+ `.test.ts`), `apps/api/src/routes/mcpServer.ts` (+ `mcpServer.artifacts.test.ts`) | `supportsResourceLinks`, `resource_link` block, `breeze://artifacts/{id}` resource | 7 |
| `apps/api/src/services/aiAgentSystemPrompt.ts`, `services/mcpGuidance.ts`, `apps/docs/src/content/docs/features/mcp-server.mdx`, `.claude/skills/ai-agent/SKILL.md`, `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md`, plan index | Prompt sentences, docs, measurement rows, follow-up issues, PR | 8 |

---

### Task 1: Output-size telemetry in the hot/cold report (D10)

**Files:**
- Modify: `apps/api/src/services/aiToolUsageReport.ts`
- Modify: `apps/api/src/services/aiToolUsageReport.test.ts`
- Modify: `docs/superpowers/specs/ai-mcp/sql/2026-09-17-ai-tool-usage-90d.sql` (the test at `aiToolUsageReport.test.ts:32` requires the file to contain `toolUsageReportSqlText(90)` modulo whitespace)

**Interfaces produced:** `ToolUsageRow` gains `withOutput, deliveredCharsP50, deliveredCharsP95, compacted, digests, captured, originalCharsP95`; `ToolUsageReport` gains `hotForShaping: string[]` (≤ 20 names). `GET /api/v1/admin/ai/tool-usage` (`routes/admin/aiToolUsage.ts`) is unchanged and returns the wider shape.

- [ ] **Step 1: Extend the tests (red)**

Replace the first two tests in `aiToolUsageReport.test.ts` and add a third:

```ts
  it('maps rows, derives shares, and lists registered tools with zero executions as cold', async () => {
    executeMock.mockResolvedValueOnce([
      { surface: 'chat', tool_name: 'query_devices', executions: '12', completed: '11', failed: '1', rejected: '0', distinct_sessions: '7', avg_duration_ms: '431.2', last_used_at: '2026-09-16T10:00:00Z',
        with_output: '11', delivered_chars_p50: '5120.5', delivered_chars_p95: '7990', compacted: '4', digests: '1', captured: '2', original_chars_p95: '41000' },
      { surface: 'helper', tool_name: 'manage_alerts', executions: '3', completed: '3', failed: '0', rejected: '0', distinct_sessions: '3', avg_duration_ms: null, last_used_at: null,
        with_output: '0', delivered_chars_p50: null, delivered_chars_p95: null, compacted: '0', digests: '0', captured: '0', original_chars_p95: null },
    ]);
    const r = await buildToolUsageReport(90);
    expect(r.rows[0]).toEqual({
      surface: 'chat', toolName: 'query_devices', executions: 12, completed: 11, failed: 1, rejected: 0, distinctSessions: 7, avgDurationMs: 431, lastUsedAt: '2026-09-16T10:00:00.000Z',
      withOutput: 11, deliveredCharsP50: 5121, deliveredCharsP95: 7990, compacted: 4, digests: 1, captured: 2, originalCharsP95: 41000,
    });
    expect(r.rows[1]).toMatchObject({ withOutput: 0, deliveredCharsP50: null, deliveredCharsP95: null, compacted: 0, digests: 0, captured: 0, originalCharsP95: null });
    expect(r.coldTools).toEqual(['never_used_tool']);
    expect(r.registeredToolCount).toBe(3);
  });

  it('reads the size signals from the persisted _chat envelope, including the captured-result nesting', () => {
    const text = toolUsageReportSqlText(90);
    expect(text).toMatch(/device_id IS NOT NULL THEN 'helper'/);
    expect(text).toMatch(/created_at >= now\(\) - make_interval\(days => /);
    expect(text).toMatch(/percentile_cont\(0\.5\) WITHIN GROUP \(ORDER BY octet_length\(e\.tool_output::text\)\)/);
    expect(text).toMatch(/COALESCE\(e\.tool_output->'_chat', e\.tool_output->'compacted'->'_chat'\)/);
    expect(text).toMatch(/COALESCE\(e\.tool_output->>'summarized', e\.tool_output->'compacted'->>'summarized'\) = 'true'/);
    expect(text).toMatch(/jsonb_typeof\(.*'originalChars'\) = 'number'/);
    expect(text).toMatch(/e\.tool_output \? 'compacted'/);
  });

  it('ranks hotForShaping by executions × delivered p50 with compaction as the tiebreak, capped at 20, and only tools that delivered output', async () => {
    const row = (tool: string, executions: number, p50: number | null, compacted = 0, digests = 0) => ({
      surface: 'chat', tool_name: tool, executions: String(executions), completed: String(executions), failed: '0', rejected: '0', distinct_sessions: '1', avg_duration_ms: null, last_used_at: null,
      with_output: p50 == null ? '0' : String(executions), delivered_chars_p50: p50 == null ? null : String(p50), delivered_chars_p95: null, compacted: String(compacted), digests: String(digests), captured: '0', original_chars_p95: null,
    });
    executeMock.mockResolvedValueOnce([
      row('small_but_frequent', 100, 400),          // 40 000
      row('big_and_frequent', 50, 7900),            // 395 000 → first
      row('big_rare', 2, 7900, 2),                  // 15 800
      row('same_score_more_compaction', 10, 4000, 5), // 40 000, ties small_but_frequent, wins on compaction
      row('no_output_written', 500, null),          // excluded: nothing delivered
    ]);
    const r = await buildToolUsageReport(90);
    expect(r.hotForShaping).toEqual(['big_and_frequent', 'same_score_more_compaction', 'small_but_frequent', 'big_rare']);
  });
```

Run: `cd apps/api && npx vitest run src/services/aiToolUsageReport.test.ts` → 3 failures (unknown fields / regex misses / `hotForShaping` undefined).

- [ ] **Step 2: Implement**

In `aiToolUsageReport.ts`:

```ts
export interface ToolUsageRow {
  surface: string;
  toolName: string;
  executions: number;
  completed: number;
  failed: number;
  rejected: number;
  distinctSessions: number;
  avgDurationMs: number | null;
  lastUsedAt: string | null;
  /**
   * A-W05 (D10). Output-size signals read from the COMPACTED payload the chat
   * path persists as `tool_output` (createSessionPostToolUse). The MCP ledger
   * writes a 500-char summary and agent-run ledgers write nothing, so these
   * columns describe the chat and Helper surfaces only.
   */
  withOutput: number;               // rows with a non-null tool_output
  deliveredCharsP50: number | null; // octet_length(tool_output::text): what the model actually received
  deliveredCharsP95: number | null;
  compacted: number;                // _chat.outputCompacted = true (rows survived, something was cut)
  digests: number;                  // summarized = true (rows were REPLACED by a digest — the worst outcome)
  captured: number;                 // an artifact envelope was persisted ({artifact, compacted})
  originalCharsP95: number | null;  // _chat.originalChars — size BEFORE compaction, known only when compacted
}

export interface ToolUsageReport {
  days: number;
  generatedAt: string;
  rows: ToolUsageRow[];
  coldTools: string[];
  registeredToolCount: number;
  /** Top 20 tools by executions × deliveredCharsP50 (ties: compacted + digests), chat + helper, output-bearing only. */
  hotForShaping: string[];
}

export function toolUsageReportSqlText(days: number): string {
  const d = Math.trunc(days);
  // `_chat` and `summarized` sit at the top level of a plain compacted result and under
  // `compacted` when the artifact capture envelope was persisted; COALESCE reads both.
  return `
    SELECT
      CASE WHEN s.type = 'general' AND s.device_id IS NOT NULL THEN 'helper'
           WHEN s.type = 'general' THEN 'chat'
           ELSE s.type END                                   AS surface,
      e.tool_name,
      COUNT(*)                                               AS executions,
      COUNT(*) FILTER (WHERE e.status = 'completed')         AS completed,
      COUNT(*) FILTER (WHERE e.status = 'failed')            AS failed,
      COUNT(*) FILTER (WHERE e.status = 'rejected')          AS rejected,
      COUNT(DISTINCT e.session_id)                           AS distinct_sessions,
      AVG(e.duration_ms) FILTER (WHERE e.status = 'completed') AS avg_duration_ms,
      MAX(e.created_at)                                      AS last_used_at,
      COUNT(*) FILTER (WHERE e.tool_output IS NOT NULL)      AS with_output,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY octet_length(e.tool_output::text))
        FILTER (WHERE e.tool_output IS NOT NULL)             AS delivered_chars_p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY octet_length(e.tool_output::text))
        FILTER (WHERE e.tool_output IS NOT NULL)             AS delivered_chars_p95,
      COUNT(*) FILTER (WHERE COALESCE(e.tool_output->'_chat', e.tool_output->'compacted'->'_chat')->>'outputCompacted' = 'true') AS compacted,
      COUNT(*) FILTER (WHERE COALESCE(e.tool_output->>'summarized', e.tool_output->'compacted'->>'summarized') = 'true') AS digests,
      COUNT(*) FILTER (WHERE e.tool_output ? 'compacted' AND e.tool_output ? 'artifact') AS captured,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY (COALESCE(e.tool_output->'_chat', e.tool_output->'compacted'->'_chat')->>'originalChars')::bigint)
        FILTER (WHERE jsonb_typeof(COALESCE(e.tool_output->'_chat', e.tool_output->'compacted'->'_chat')->'originalChars') = 'number') AS original_chars_p95
    FROM ai_tool_executions e
    JOIN ai_sessions s ON s.id = e.session_id
    WHERE e.created_at >= now() - make_interval(days => ${d})
    GROUP BY 1, 2
    ORDER BY executions DESC, tool_name`;
}
```

In `buildToolUsageReport`, extend the mapping and add the ranking:

```ts
  const num = (v: unknown): number | null => (v == null ? null : Math.round(Number(v)));
  const mapped: ToolUsageRow[] = rows.map((r) => ({
    surface: String(r.surface),
    toolName: String(r.tool_name),
    executions: Number(r.executions),
    completed: Number(r.completed),
    failed: Number(r.failed),
    rejected: Number(r.rejected),
    distinctSessions: Number(r.distinct_sessions),
    avgDurationMs: num(r.avg_duration_ms),
    lastUsedAt: r.last_used_at == null ? null : new Date(String(r.last_used_at)).toISOString(),
    withOutput: Number(r.with_output ?? 0),
    deliveredCharsP50: num(r.delivered_chars_p50),
    deliveredCharsP95: num(r.delivered_chars_p95),
    compacted: Number(r.compacted ?? 0),
    digests: Number(r.digests ?? 0),
    captured: Number(r.captured ?? 0),
    originalCharsP95: num(r.original_chars_p95),
  }));
  const score = new Map<string, { primary: number; secondary: number }>();
  for (const r of mapped) {
    if (r.withOutput === 0 || r.deliveredCharsP50 == null) continue;
    const cur = score.get(r.toolName) ?? { primary: 0, secondary: 0 };
    cur.primary += r.executions * r.deliveredCharsP50;
    cur.secondary += r.compacted + r.digests;
    score.set(r.toolName, cur);
  }
  const hotForShaping = [...score.entries()]
    .sort((a, b) => b[1].primary - a[1].primary || b[1].secondary - a[1].secondary || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([name]) => name);
```

and return `hotForShaping` beside `coldTools`. Copy the new SQL body into `docs/superpowers/specs/ai-mcp/sql/2026-09-17-ai-tool-usage-90d.sql`, keeping the file's `BEGIN; … set_config('breeze.scope','system',true) … ROLLBACK;` wrapper and adding, above the query, the operator note: `-- Detoasts every tool_output in the window; run off-peak with SET statement_timeout = '5min'. Chat + helper surfaces only (MCP persists a summary, agent runs persist nothing).`

- [ ] **Step 3: Run the tests (green)**

`cd apps/api && npx vitest run src/services/aiToolUsageReport.test.ts src/routes/admin/aiToolUsage.test.ts` → all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/aiToolUsageReport.ts apps/api/src/services/aiToolUsageReport.test.ts docs/superpowers/specs/ai-mcp/sql/2026-09-17-ai-tool-usage-90d.sql
git commit -m "feat(ai): output-size signals and hotForShaping in the tool-usage report (A-W05 D10)"
```

---

### Task 2: The shared pagination helper (D11)

**Files:**
- Create: `apps/api/src/services/aiToolPagination.ts`
- Create: `apps/api/src/services/aiToolPagination.test.ts`

**Interfaces produced (used by Tasks 4 and 5):**

```ts
export const PAGE_CONTROL_KEYS: readonly ['limit', 'offset', 'cursor'];
export function pageFingerprint(toolName: string, input: Record<string, unknown>): string;              // 16 hex chars
export function readPageArgs(toolName: string, input: Record<string, unknown>, opts: { defaultLimit: number; maxLimit: number }):
  | { ok: true; limit: number; offset: number; fingerprint: string }
  | { ok: false; error: string; code: 'CURSOR_MISMATCH' | 'CURSOR_INVALID' };
export function pageEnvelope<T>(p: { key: string; items: T[]; limit: number; offset: number; fingerprint: string; total?: number; totalMode?: 'exact' | 'estimated' }): Record<string, unknown>;
export function readKeysetArgs(toolName: string, input: Record<string, unknown>, opts: { defaultLimit: number; maxLimit: number }):
  | { ok: true; limit: number; after: { t: string; i: string } | null; fingerprint: string }
  | { ok: false; error: string; code: 'CURSOR_MISMATCH' | 'CURSOR_INVALID' };
export function keysetEnvelope<T>(p: { key: string; items: T[]; limit: number; fingerprint: string; keyOf: (item: T) => { t: string; i: string }; total?: number; totalMode?: 'exact' | 'estimated' }): Record<string, unknown>;
export function pageParamSchema(defaultLimit: number, maxLimit: number): { limit: {...}; offset: {...}; cursor: {...} };   // registry JSON-schema properties
export function keysetParamSchema(defaultLimit: number, maxLimit: number): { limit: {...}; cursor: {...} };
export function pageZodShape(maxLimit: number): { limit: ZodOptional<ZodNumber>; offset: ZodOptional<ZodNumber>; cursor: ZodOptional<ZodString> };
export function keysetZodShape(maxLimit: number): { limit: ZodOptional<ZodNumber>; cursor: ZodOptional<ZodString> };
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  keysetEnvelope, keysetParamSchema, pageEnvelope, pageFingerprint, pageParamSchema, pageZodShape,
  readKeysetArgs, readPageArgs,
} from './aiToolPagination';

describe('readPageArgs', () => {
  const opts = { defaultLimit: 25, maxLimit: 100 };
  it('applies default and max, floors at 1, ignores junk', () => {
    expect(readPageArgs('t', {}, opts)).toMatchObject({ ok: true, limit: 25, offset: 0 });
    expect(readPageArgs('t', { limit: 999, offset: -4 }, opts)).toMatchObject({ ok: true, limit: 100, offset: 0 });
    expect(readPageArgs('t', { limit: 'abc', offset: 'x' }, opts)).toMatchObject({ ok: true, limit: 25, offset: 0 });
    expect(readPageArgs('t', { limit: 0 }, opts)).toMatchObject({ ok: true, limit: 25 });
  });
  it('fingerprints the filters but not the page controls, order-independently', () => {
    const a = pageFingerprint('t', { status: 'online', tags: ['a', 'b'], limit: 5, offset: 10, cursor: 'zzz' });
    const b = pageFingerprint('t', { tags: ['a', 'b'], status: 'online' });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
    expect(pageFingerprint('t', { status: 'offline' })).not.toBe(a);
    expect(pageFingerprint('other', { status: 'online', tags: ['a', 'b'] })).not.toBe(a);
  });
  it('round-trips a cursor and refuses one from a different query or a garbage one', () => {
    const first = readPageArgs('t', { status: 'online' }, opts);
    if (!first.ok) throw new Error('unexpected');
    const env = pageEnvelope({ key: 'rows', items: Array.from({ length: 26 }, (_, i) => i), limit: 25, offset: 0, fingerprint: first.fingerprint });
    expect(env).toMatchObject({ showing: 25, limit: 25, offset: 0, hasMore: true });
    expect(env.rows).toHaveLength(25);
    const next = readPageArgs('t', { status: 'online', cursor: env.nextCursor }, opts);
    expect(next).toMatchObject({ ok: true, limit: 25, offset: 25 });
    expect(readPageArgs('t', { status: 'offline', cursor: env.nextCursor }, opts)).toMatchObject({ ok: false, code: 'CURSOR_MISMATCH' });
    expect(readPageArgs('t', { status: 'online', cursor: 'not-a-cursor' }, opts)).toMatchObject({ ok: false, code: 'CURSOR_INVALID' });
  });
  it('derives hasMore from total when given, and from the over-fetch otherwise', () => {
    const fp = 'f'.repeat(16);
    expect(pageEnvelope({ key: 'r', items: [1, 2, 3], limit: 3, offset: 6, fingerprint: fp, total: 9 })).toMatchObject({ total: 9, totalMode: 'exact', hasMore: false, nextCursor: null });
    expect(pageEnvelope({ key: 'r', items: [1, 2, 3], limit: 3, offset: 3, fingerprint: fp, total: 9 })).toMatchObject({ hasMore: true });
    expect(pageEnvelope({ key: 'r', items: [1, 2, 3], limit: 3, offset: 0, fingerprint: fp })).toMatchObject({ hasMore: false, nextCursor: null, showing: 3 });
    expect(pageEnvelope({ key: 'r', items: [1, 2, 3], limit: 3, offset: 0, fingerprint: fp })).not.toHaveProperty('total');
  });
});

describe('keyset mode', () => {
  const opts = { defaultLimit: 20, maxLimit: 100 };
  it('has no offset, carries the last row key in the cursor, and refuses a foreign cursor', () => {
    const args = readKeysetArgs('alerts', { severity: 'high' }, opts);
    if (!args.ok) throw new Error('unexpected');
    expect(args).toMatchObject({ limit: 20, after: null });
    const items = Array.from({ length: 21 }, (_, i) => ({ id: `id-${i}`, triggeredAt: `2026-09-20T10:00:${String(59 - i).padStart(2, '0')}Z` }));
    const env = keysetEnvelope({ key: 'alerts', items, limit: 20, fingerprint: args.fingerprint, keyOf: (r) => ({ t: r.triggeredAt, i: r.id }) });
    expect(env).toMatchObject({ showing: 20, limit: 20, hasMore: true });
    expect(env).not.toHaveProperty('offset');
    const next = readKeysetArgs('alerts', { severity: 'high', cursor: env.nextCursor }, opts);
    expect(next).toMatchObject({ ok: true, after: { t: '2026-09-20T10:00:40Z', i: 'id-19' } });
    expect(readKeysetArgs('alerts', { severity: 'low', cursor: env.nextCursor }, opts)).toMatchObject({ ok: false, code: 'CURSOR_MISMATCH' });
  });
});

describe('schema text', () => {
  it('states default and max in ≤160-char descriptions on every surface', () => {
    const s = pageParamSchema(25, 100);
    expect(s.limit.description).toBe('Max results (default 25, max 100)');
    expect(s.offset.description).toBe('Pagination offset (default 0)');
    expect(s.cursor.description).toBe('nextCursor from a previous call with the same filters');
    for (const p of Object.values(s)) expect(p.description.length).toBeLessThanOrEqual(160);
    expect(Object.keys(keysetParamSchema(20, 100))).toEqual(['limit', 'cursor']);
    expect(pageZodShape(100).limit.safeParse(101).success).toBe(false);
    expect(pageZodShape(100).cursor.safeParse('x'.repeat(257)).success).toBe(false);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/aiToolPagination.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement `aiToolPagination.ts`**

```ts
/**
 * A-W05 (D11): the one pagination envelope every list tool emits, ADDITIVELY,
 * on top of its existing keys. Two modes:
 *  - offset: `limit` + `offset` + opaque `cursor` (stable lists);
 *  - keyset: `limit` + opaque `cursor` carrying the last row's sort key
 *    (churn tables — alerts, logs, audit — where an insert between pages would
 *    shift every later offset without the model noticing).
 * A cursor is bound to a fingerprint of the tool name + every non-page filter,
 * so a cursor replayed against a different query is refused with a tool error
 * (never silently reset to page 1 — that re-delivers page 1 forever).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PAGE_CONTROL_KEYS = ['limit', 'offset', 'cursor'] as const;
const CURSOR_MAX_CHARS = 256;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(src).sort().map((k) => [k, canonical(src[k])]));
  }
  return value;
}

export function pageFingerprint(toolName: string, input: Record<string, unknown>): string {
  const filters: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if ((PAGE_CONTROL_KEYS as readonly string[]).includes(k) || v === undefined) continue;
    filters[k] = v;
  }
  return createHash('sha256').update(`${toolName}\n${JSON.stringify(canonical(filters))}`).digest('hex').slice(0, 16);
}

type CursorBody = { f: string; o?: number; t?: string; i?: string };

function encodeCursor(body: CursorBody): string {
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

function decodeCursor(token: unknown, expectedFingerprint: string): { ok: true; body: CursorBody } | { ok: false; code: 'CURSOR_MISMATCH' | 'CURSOR_INVALID'; error: string } {
  if (typeof token !== 'string' || token.length === 0 || token.length > CURSOR_MAX_CHARS) {
    return { ok: false, code: 'CURSOR_INVALID', error: 'cursor is not a nextCursor value from a previous call' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'CURSOR_INVALID', error: 'cursor is not a nextCursor value from a previous call' };
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as CursorBody).f !== 'string') {
    return { ok: false, code: 'CURSOR_INVALID', error: 'cursor is not a nextCursor value from a previous call' };
  }
  if ((parsed as CursorBody).f !== expectedFingerprint) {
    return { ok: false, code: 'CURSOR_MISMATCH', error: 'cursor was issued for a different query; repeat the same filters or drop the cursor' };
  }
  return { ok: true, body: parsed as CursorBody };
}

function clampLimit(raw: unknown, opts: { defaultLimit: number; maxLimit: number }): number {
  const n = Math.trunc(Number(raw));
  const base = Number.isFinite(n) && n > 0 ? n : opts.defaultLimit;
  return Math.min(Math.max(1, base), opts.maxLimit);
}

export function readPageArgs(toolName: string, input: Record<string, unknown>, opts: { defaultLimit: number; maxLimit: number }):
  | { ok: true; limit: number; offset: number; fingerprint: string }
  | { ok: false; error: string; code: 'CURSOR_MISMATCH' | 'CURSOR_INVALID' } {
  const fingerprint = pageFingerprint(toolName, input);
  const limit = clampLimit(input.limit, opts);
  const rawOffset = Math.trunc(Number(input.offset));
  let offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') {
    const decoded = decodeCursor(input.cursor, fingerprint);
    if (!decoded.ok) return decoded;
    if (typeof decoded.body.o !== 'number' || !Number.isInteger(decoded.body.o) || decoded.body.o < 0) {
      return { ok: false, code: 'CURSOR_INVALID', error: 'cursor is not a nextCursor value from a previous call' };
    }
    offset = decoded.body.o;
  }
  return { ok: true, limit, offset, fingerprint };
}

export function pageEnvelope<T>(p: {
  key: string; items: T[]; limit: number; offset: number; fingerprint: string; total?: number; totalMode?: 'exact' | 'estimated';
}): Record<string, unknown> {
  const overFetched = p.total === undefined && p.items.length > p.limit;
  const items = overFetched ? p.items.slice(0, p.limit) : p.items;
  const hasMore = p.total !== undefined ? p.offset + items.length < p.total : overFetched;
  return {
    [p.key]: items,
    showing: items.length,
    limit: p.limit,
    offset: p.offset,
    ...(p.total !== undefined ? { total: p.total, totalMode: p.totalMode ?? 'exact' } : {}),
    hasMore,
    nextCursor: hasMore ? encodeCursor({ f: p.fingerprint, o: p.offset + items.length }) : null,
  };
}

export function readKeysetArgs(toolName: string, input: Record<string, unknown>, opts: { defaultLimit: number; maxLimit: number }):
  | { ok: true; limit: number; after: { t: string; i: string } | null; fingerprint: string }
  | { ok: false; error: string; code: 'CURSOR_MISMATCH' | 'CURSOR_INVALID' } {
  const fingerprint = pageFingerprint(toolName, input);
  const limit = clampLimit(input.limit, opts);
  if (input.cursor === undefined || input.cursor === null || input.cursor === '') return { ok: true, limit, after: null, fingerprint };
  const decoded = decodeCursor(input.cursor, fingerprint);
  if (!decoded.ok) return decoded;
  const { t, i } = decoded.body;
  if (typeof t !== 'string' || typeof i !== 'string' || t.length === 0 || i.length === 0) {
    return { ok: false, code: 'CURSOR_INVALID', error: 'cursor is not a nextCursor value from a previous call' };
  }
  return { ok: true, limit, after: { t, i }, fingerprint };
}

export function keysetEnvelope<T>(p: {
  key: string; items: T[]; limit: number; fingerprint: string; keyOf: (item: T) => { t: string; i: string };
  total?: number; totalMode?: 'exact' | 'estimated';
}): Record<string, unknown> {
  const hasMore = p.items.length > p.limit;
  const items = hasMore ? p.items.slice(0, p.limit) : p.items;
  const last = items[items.length - 1];
  return {
    [p.key]: items,
    showing: items.length,
    limit: p.limit,
    ...(p.total !== undefined ? { total: p.total, totalMode: p.totalMode ?? 'exact' } : {}),
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor({ f: p.fingerprint, ...p.keyOf(last) }) : null,
  };
}

/** Registry JSON-schema properties. Text is fixed so the A-W03 budget lint and Task 4's "default N, max M" lint see one spelling. */
export function pageParamSchema(defaultLimit: number, maxLimit: number) {
  return {
    limit: { type: 'number', description: `Max results (default ${defaultLimit}, max ${maxLimit})` },
    offset: { type: 'number', description: 'Pagination offset (default 0)' },
    cursor: { type: 'string', description: 'nextCursor from a previous call with the same filters' },
  } as const;
}

export function keysetParamSchema(defaultLimit: number, maxLimit: number) {
  const { limit, cursor } = pageParamSchema(defaultLimit, maxLimit);
  return { limit, cursor } as const;
}

/** SDK `tool()` and `toolInputSchemas` Zod shapes — the other two surfaces. */
export function pageZodShape(maxLimit: number) {
  return {
    limit: z.number().int().min(1).max(maxLimit).optional(),
    offset: z.number().int().min(0).optional(),
    cursor: z.string().max(CURSOR_MAX_CHARS).optional(),
  };
}

export function keysetZodShape(maxLimit: number) {
  const { limit, cursor } = pageZodShape(maxLimit);
  return { limit, cursor };
}
```

- [ ] **Step 3: Run the tests (green)**

`cd apps/api && npx vitest run src/services/aiToolPagination.test.ts` → all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/aiToolPagination.ts apps/api/src/services/aiToolPagination.test.ts
git commit -m "feat(ai): shared pagination envelope with fingerprint-bound cursors (A-W05 D11)"
```

---

### Task 3: Registry-aware truncation guidance in the compactor (D12a)

**Files:**
- Modify: `apps/api/src/services/aiToolOutput.ts` (`ARRAY_SENTINEL_RE` `:108`, `arrayTruncationSentinel` `:110`, `priorArrayOmitted` `:115`, `CompactStats`, `appendChatMeta` `:600`, `compactToolResultForChat` `:684`, the digest at `:743`)
- Modify: `apps/api/src/services/aiToolOutput.test.ts` (the hard-coded legacy sentinel fixture at `:570` keeps working because the regex still accepts the legacy text)
- Modify: `apps/api/src/services/aiTools.ts` (install the resolver after the last `register*Tools(...)` call)

**Interfaces produced:**

```ts
export type ToolPaginationHint = 'cursor' | 'limit' | 'none';
export function setToolPaginationHintResolver(resolver: (toolName: string) => ToolPaginationHint): void;
export const SENTINEL_HINTS: Readonly<Record<ToolPaginationHint, string>>;
```

- [ ] **Step 1: Write the failing tests** (append to `aiToolOutput.test.ts`)

```ts
import { SENTINEL_HINTS, setToolPaginationHintResolver } from './aiToolOutput';

describe('registry-aware truncation guidance (A-W05 D12)', () => {
  afterEach(() => setToolPaginationHintResolver(() => 'none'));

  const bigList = (key: string) => JSON.stringify({ [key]: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `row-${i}`, note: 'x'.repeat(60) })) });

  it('tells a cursor-capable tool to continue with nextCursor, in the sentinel and in _chat.nextStep', () => {
    setToolPaginationHintResolver((name) => (name === 'paged_tool' ? 'cursor' : 'none'));
    const out = JSON.parse(compactToolResultForChat('paged_tool', bigList('rows'))) as { rows: unknown[]; _chat: { nextStep: string } };
    expect(out.rows.at(-1)).toMatch(/^\.\.\.\[truncated: \d+ more items omitted\. Call again with the nextCursor value\]$/);
    expect(out._chat.nextStep).toBe(SENTINEL_HINTS.cursor);
  });

  it('tells a limit-only tool to shrink the page, and a tool with neither to narrow with filters', () => {
    setToolPaginationHintResolver((name) => (name === 'limit_tool' ? 'limit' : 'none'));
    const limited = JSON.parse(compactToolResultForChat('limit_tool', bigList('rows'))) as { rows: unknown[] };
    expect(limited.rows.at(-1)).toMatch(/Pass a smaller limit or add filters\]$/);
    const bare = JSON.parse(compactToolResultForChat('bare_tool', bigList('rows'))) as { rows: unknown[]; _chat: { nextStep: string } };
    expect(bare.rows.at(-1)).toMatch(/Narrow the query with filters\]$/);
    expect(bare._chat.nextStep).toBe(SENTINEL_HINTS.none);
  });

  it('still recognises the legacy sentinel on re-compaction (idempotent, no double count)', () => {
    const raw = JSON.stringify({ rows: [...Array.from({ length: 10 }, (_, i) => ({ i })), '...[truncated: 77 more items omitted. Use pagination or the REST API]'] });
    const once = compactToolResultForChat('bare_tool', raw);
    expect(compactToolResultForChat('bare_tool', once)).toBe(once);
  });

  it('puts nextStep on the digest too', () => {
    setToolPaginationHintResolver(() => 'cursor');
    const huge = JSON.stringify({ blob: 'y'.repeat(40_000).split('').map((c, i) => ({ i, c })) });
    const out = JSON.parse(compactToolResultForChat('paged_tool', huge, 400)) as { summarized?: boolean; _chat: { nextStep?: string } };
    expect(out.summarized).toBe(true);
    expect(out._chat.nextStep).toBe(SENTINEL_HINTS.cursor);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/aiToolOutput.test.ts` → the four new tests fail (export missing / legacy text).

- [ ] **Step 2: Implement in `aiToolOutput.ts`**

Replace the sentinel block (`:103-119`) with:

```ts
// A-W05 (D12): the guidance appended to a truncated ARRAY must be something the
// tool can honour. The hub injects the resolver (setToolPaginationHintResolver)
// so this module never imports the registry — importing aiToolNames here would
// pull the extension registry (Hono + Ajv) into every worker that imports this
// file for MAX_TOOL_RESULT_CHARS (#4086, workerEntrypointClosure contract) and
// would read an EMPTY map in any process that loads the compactor without the hub.
export type ToolPaginationHint = 'cursor' | 'limit' | 'none';
export const SENTINEL_HINTS: Readonly<Record<ToolPaginationHint, string>> = {
  cursor: 'Call again with the nextCursor value',
  limit: 'Pass a smaller limit or add filters',
  none: 'Narrow the query with filters',
};
const LEGACY_SENTINEL_HINT = 'Use pagination or the REST API';
let paginationHintResolver: (toolName: string) => ToolPaginationHint = () => 'none';
export function setToolPaginationHintResolver(resolver: (toolName: string) => ToolPaginationHint): void {
  paginationHintResolver = resolver;
}
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// #3521: anchored so a re-compaction pass recognises its own marker (idempotent)
// without misclassifying a legitimate trailing string. Accepts every hint text
// ever emitted, including the pre-A-W05 one, so stored payloads still round-trip.
const ARRAY_SENTINEL_RE = new RegExp(
  `^\\.\\.\\.\\[truncated: (\\d+) more items omitted\\. (?:${[LEGACY_SENTINEL_HINT, ...Object.values(SENTINEL_HINTS)].map(escapeForRegExp).join('|')})\\]$`,
);

function arrayTruncationSentinel(dropped: number, hint: string): string {
  return `...[truncated: ${dropped} more items omitted. ${hint}]`;
}
```

Add `sentinelHint: string` to `CompactStats` (initialised to `SENTINEL_HINTS.none` in `emptyStats()`), and pass `stats.sentinelHint` wherever `arrayTruncationSentinel(dropped)` was called. In `compactToolResultForChat`, right after `const stats = emptyStats();` set `stats.sentinelHint = SENTINEL_HINTS[paginationHintResolver(toolName)];` and make sure the per-tier copies (`{ ...baseStats }`) carry it. In `appendChatMeta`, add `nextStep: stats.sentinelHint` to `meta` when `stats.arraysTruncated > 0 || stats.arrayItemsDropped > 0`. In the two digest returns (`:698` non-JSON and `:743` max-output), add `nextStep: SENTINEL_HINTS[paginationHintResolver(toolName)]` inside `_chat`.

In `aiTools.ts`, after the final `register…Tools(aiTools)` call:

```ts
import { setToolPaginationHintResolver } from './aiToolOutput';
// A-W05 (D12): the compactor's truncation guidance follows the tool's real paging shape.
// Covers extension-contributed tools too — they live in the contribution registry, not this map.
setToolPaginationHintResolver((name) => {
  const core = aiTools.get(name)?.definition.input_schema as { properties?: Record<string, unknown> } | undefined;
  const ext = core ? undefined : (resolveExtensionTool(name, extensionContributionRegistry)?.definition.input_schema as { properties?: Record<string, unknown> } | undefined);
  const props = (core ?? ext)?.properties ?? {};
  return 'cursor' in props ? 'cursor' : 'limit' in props ? 'limit' : 'none';
});
```

(`resolveExtensionTool` and `extensionContributionRegistry` are already imported in `aiTools.ts` — `executeTool` uses both at `:582-584`.)

- [ ] **Step 3: Run the tests (green)**

`cd apps/api && npx vitest run src/services/aiToolOutput src/services/aiTools.test.ts src/__tests__/workerEntrypointClosure` → all pass (the closure contract proves no new import reached the workers).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/aiToolOutput.ts apps/api/src/services/aiToolOutput.test.ts apps/api/src/services/aiTools.ts
git commit -m "feat(ai): truncation guidance follows the tool's paging shape via an injected resolver (A-W05 D12)"
```

---

### Task 4: Output-budget contract and the fixture testkit (D12b, D12c)

**Files:**
- Create: `apps/api/src/services/aiToolOutputBudget.testkit.ts`
- Create: `apps/api/src/services/aiTools.outputBudget.contract.test.ts`

**Interfaces produced (used by every Task 5 test):**

```ts
export type FieldKind = 'id' | 'short' | 'medium' | 'long' | 'ts' | 'num' | 'bool' | 'null';
export function fixtureRow(i: number, shape: Record<string, FieldKind>): Record<string, unknown>;
export function measureToolPage(toolName: string, raw: string): { chars: number; compacted: boolean; digest: boolean };
export function expectDefaultPageFits(toolName: string, raw: string): number;   // returns chars; throws with the size when it does not fit
export const UNBOUNDED_LIST_READS: ReadonlySet<string>;                          // frozen, shrink-only
```

- [ ] **Step 1: Write the testkit**

```ts
// apps/api/src/services/aiToolOutputBudget.testkit.ts
/**
 * A-W05 (D12c/D14): one way to prove "a default page of realistic rows fits the
 * chat budget without compaction". Imported by tests only.
 */
import { expect } from 'vitest';
import { MAX_TOOL_RESULT_CHARS, compactToolResultForChat } from './aiToolOutput';

export type FieldKind = 'id' | 'short' | 'medium' | 'long' | 'ts' | 'num' | 'bool' | 'null';

const WIDTH: Record<Exclude<FieldKind, 'id' | 'ts' | 'num' | 'bool' | 'null'>, number> = { short: 12, medium: 48, long: 200 };

export function fixtureRow(i: number, shape: Record<string, FieldKind>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(shape)) {
    switch (kind) {
      case 'id': row[key] = `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`; break;
      case 'ts': row[key] = new Date(Date.UTC(2026, 8, 20, 10, i % 60, 0)).toISOString(); break;
      case 'num': row[key] = 1000 + i; break;
      case 'bool': row[key] = i % 2 === 0; break;
      case 'null': row[key] = null; break;
      default: row[key] = `${key}-${i}-`.padEnd(WIDTH[kind], 'x');
    }
  }
  return row;
}

export function measureToolPage(toolName: string, raw: string): { chars: number; compacted: boolean; digest: boolean } {
  const out = compactToolResultForChat(toolName, raw);
  const parsed = JSON.parse(out) as { _chat?: { outputCompacted?: boolean }; summarized?: boolean };
  return { chars: out.length, compacted: parsed._chat?.outputCompacted === true, digest: parsed.summarized === true };
}

/** Prints the size (the PR table's before/after column) and fails when the page did not fit uncompacted. */
export function expectDefaultPageFits(toolName: string, raw: string): number {
  const m = measureToolPage(toolName, raw);
  console.info(`[output-budget] ${toolName} default page = ${m.chars} chars (raw ${raw.length}) compacted=${m.compacted} digest=${m.digest}`);
  expect(m.digest, `${toolName}: default page was replaced by a digest`).toBe(false);
  expect(m.compacted, `${toolName}: default page (${raw.length} raw chars) was compacted; lower the default limit or trim the row`).toBe(false);
  expect(m.chars).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  return m.chars;
}

/**
 * Read tools that return an array with NO `limit` property (D12b). Shrink-only:
 * a shaped tool leaves this set in the same PR that adds its `limit`. Adding a
 * name here is never acceptable — give the new tool a page instead.
 */
export const UNBOUNDED_LIST_READS: ReadonlySet<string> = new Set([
  'get_effective_configuration',
  'get_executive_summary',
  'get_user_risk_detail',
  'get_vulnerability_report',
  'list_deliverable_templates',
  'list_deliverables',
  'list_org_documents',
  'query_custom_fields',
  'search_documentation',
]);
```

- [ ] **Step 2: Write the contract test**

```ts
// apps/api/src/services/aiTools.outputBudget.contract.test.ts
/**
 * A-W05 contract: every `limit` states its default and max; every paged tool
 * carries its page parameters on all three input-schema surfaces; the set of
 * read tools returning arrays without a `limit` only shrinks.
 * No vi.mock — this suite needs the real registry (same rule as
 * aiTools.domainMetadata.contract.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import { getAllRegisteredToolNames } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { buildBreezeSdkTools } from './aiAgentSdkTools';
import { UNBOUNDED_LIST_READS } from './aiToolOutputBudget.testkit';

type Props = Record<string, { description?: string }>;
const propsOf = (name: string): Props =>
  ((aiTools.get(name)?.definition.input_schema as { properties?: Props } | undefined)?.properties ?? {});

const LIMIT_TEXT = /^Max(imum)? (results|rows|entries|items|records)[^()]*\(default \d+, max \d+\)$/;

describe('AI tool output budget (A-W05)', () => {
  const names = getAllRegisteredToolNames();

  it('registers enough tools for these assertions to mean something', () => {
    expect(names.length).toBeGreaterThan(150);
  });

  it('every limit property states its default and max', () => {
    const bad = names
      .filter((n) => 'limit' in propsOf(n))
      .filter((n) => !LIMIT_TEXT.test(propsOf(n).limit.description ?? ''))
      .map((n) => `${n}: ${JSON.stringify(propsOf(n).limit.description)}`);
    expect(bad, `limit descriptions without "(default N, max M)": ${bad.join('; ')}`).toEqual([]);
  });

  it('page parameters exist on all three surfaces (registry, toolInputSchemas, SDK tool())', () => {
    // Same construction as aiTools.domainMetadata.contract.test.ts: handlers must never run here.
    const fakeAuth = () => { throw new Error('must not invoke tool handlers'); };
    const sdk = new Map(buildBreezeSdkTools(fakeAuth as never).map((t) => [t.name, t] as const));
    const drift: string[] = [];
    for (const n of names) {
      const registry = propsOf(n);
      const zod = (toolInputSchemas[n] as { shape?: Record<string, unknown> } | undefined)?.shape;
      // `inputSchema` on an SDK tool is the raw Zod shape record that was passed to tool().
      const sdkShape = (sdk.get(n) as { inputSchema?: Record<string, unknown> } | undefined)?.inputSchema;
      for (const key of ['limit', 'offset', 'cursor'] as const) {
        if (!(key in registry)) continue;
        if (zod && !(key in zod)) drift.push(`${n}.${key} missing in toolInputSchemas`);
        if (sdkShape && !(key in sdkShape)) drift.push(`${n}.${key} missing in the SDK tool() shape`);
      }
    }
    expect(drift, drift.join('\n')).toEqual([]);
  });

  it('UNBOUNDED_LIST_READS only shrinks: every entry is still a registered read with no limit, and no other read tool lacks one', () => {
    const stale = [...UNBOUNDED_LIST_READS].filter((n) => !aiTools.has(n) || 'limit' in propsOf(n));
    expect(stale, `remove from UNBOUNDED_LIST_READS (fixed or gone): ${stale.join(', ')}`).toEqual([]);
    const listReads = names.filter((n) => /^(list|search|query)_/.test(n) && aiTools.get(n)?.tier === 1);
    const unbudgeted = listReads.filter((n) => !('limit' in propsOf(n)) && !UNBOUNDED_LIST_READS.has(n));
    expect(unbudgeted, `read tools returning lists with no limit and not in the frozen baseline: ${unbudgeted.join(', ')}`).toEqual([]);
  });
});
```

`buildBreezeSdkTools` (`aiAgentSdkTools.ts:1335`) returns the SDK tool objects with a bare `name` (no `mcp__breeze__` prefix — `aiTools.domainMetadata.contract.test.ts:85` relies on that) and `inputSchema` = the Zod shape record passed to `tool()`. `toolInputSchemas` (`aiToolSchemas.ts:113`) is a `Record<string, z.ZodType>`; every entry this wave touches is a `z.object`, whose `.shape` is the property record.

- [ ] **Step 3: Run and reconcile (red → green)**

`cd apps/api && npx vitest run src/services/aiTools.outputBudget.contract.test.ts`. Expected reds: (a) `limit` descriptions that do not match `(default N, max M)` — on main the survey found `'Max results (default 25)'` ×8 and `'Max results for list (default 25)'` ×4 among others; fix each **in place** by appending the real clamp from the handler (e.g. `'Max results (default 25, max 100)'` where the handler does `Math.min(…, 100)`), touching the registry text only; (b) any tier-1 `list_/search_/query_` tool with no `limit` that is not in the set — add nothing to the set: if the red names a tool from the 20-tool table, leave it red until its Task 5 group lands (note it in the PR), otherwise it is a survey miss — give it a `limit` with `pageParamSchema` in Task 5c's last step. Re-run until green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/aiToolOutputBudget.testkit.ts apps/api/src/services/aiTools.outputBudget.contract.test.ts apps/api/src/services/aiTools*.ts
git commit -m "test(ai): output-budget contract, three-surface paging parity, frozen unbounded-read baseline (A-W05 D12)"
```

---

### Task 5a: Shaping group A — offset-mode envelopes (tools 1–8)

**Files:**
- Modify: `apps/api/src/services/aiToolsDevice.ts` (`query_devices` `:101-200`), `aiToolsTicketing.ts` (`manage_tickets` list `:600-645`), `aiToolsFleet.ts` (`manage_patches` list `:1080-1135`), `aiToolsScripts.ts` (`list_scripts` `:912-960`), `aiToolsSecurity.ts` (`get_security_posture` `:173-280`), `aiToolsMonitors.ts` (`list_monitors` `:206-235`), `aiToolsAiAgentGovernance.ts` (`list_ai_agents` `:109-125`), `aiToolsVulnerability.ts` (`get_device_vulnerabilities` `:278-325`)
- Modify: `apps/api/src/services/aiToolSchemas.ts` (the eight `toolInputSchemas` entries), `apps/api/src/services/aiAgentSdkTools.ts` (the eight `tool()` shapes; `list_scripts`'s shape is in `apps/api/src/services/scriptBuilderTools.ts`)
- Create: one `<file>.outputShape.test.ts` beside each touched `aiTools*.ts` (e.g. `aiToolsDevice.outputShape.test.ts`)

**Interfaces consumed:** `readPageArgs`, `pageEnvelope`, `pageParamSchema`, `pageZodShape` (Task 2); `fixtureRow`, `expectDefaultPageFits` (Task 4).

**The change, per tool** (every row: add `...pageParamSchema(D, M)` to the registry `input_schema.properties` **replacing** the existing `limit` property; add `...pageZodShape(M)` to the `toolInputSchemas` entry and the SDK `tool()` shape replacing their `limit`; read args with `readPageArgs`; return the existing keys **plus** the envelope):

| Tool | D / M | Query change | Return |
|---|---|---|---|
| `query_devices` | 25 / 100 | `.limit(limit).offset(offset)` (COUNT already exists at `:176`) | `{ ...pageEnvelope({ key: 'devices', items, limit, offset, fingerprint, total }), }` — `total` and `showing` keep their values |
| `manage_tickets` list | 25 / 100 | `.limit(limit + 1).offset(offset)` | `pageEnvelope({ key: 'tickets', items, … })` (no total) |
| `manage_patches` list | 25 / 100 | `.limit(limit + 1).offset(offset)` in both the device and org branches | `{ ...pageEnvelope({ key: 'patches', … }), scope }` |
| `list_scripts` | 20 / 50 | `.limit(limit + 1).offset(offset)` | `{ ...pageEnvelope({ key: 'scripts', … }), count: items.length }` (`count` kept) |
| `get_security_posture` | 25 / 500 | the service call that fills `devices` takes `limit + 1` and `offset` (if the service has no offset parameter, slice the returned array: `rows.slice(offset, offset + limit + 1)` and say so in the test) | `{ summary, worstDevices, ...pageEnvelope({ key: 'devices', … }) }` |
| `list_monitors` | 25 / 100 | rows are already all fetched (`:224`); `items = rows.slice(offset, offset + limit)`, `total = rows.length` | `pageEnvelope({ key: 'monitors', items, limit, offset, fingerprint, total })` — `total` is now the true count |
| `list_ai_agents` | 25 / 100 | `.limit(limit + 1).offset(offset)` (add a `limit` property — this tool has none today) | `pageEnvelope({ key: 'agents', … })` |
| `get_device_vulnerabilities` | 50 / 200 | `.limit(limit + 1).offset(offset)` (add `limit`) | `{ deviceId, ...pageEnvelope({ key: 'vulnerabilities', … }), count: items.length }` |

A `readPageArgs` failure is returned as `JSON.stringify({ error: page.error, code: page.code })` before any query.

- [ ] **Step 1: Write the failing tests — exemplar for `query_devices`** (`aiToolsDevice.outputShape.test.ts`; the other seven tests in this group are this file with the table's names substituted and the tool's own fixture shape)

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

const dbMock = vi.hoisted(() => {
  const rows: unknown[] = [];
  let total = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'offset', 'leftJoin', 'innerJoin', 'groupBy']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(rows);
  return { chain, setRows: (r: unknown[]) => { rows.length = 0; rows.push(...r); }, setTotal: (t: number) => { total = t; }, getTotal: () => total };
});
vi.mock('../db', () => ({ db: dbMock.chain }));

import { aiTools } from './aiToolNames';
import './aiTools';

const DEVICE_ROW = { id: 'id', hostname: 'short', displayName: 'medium', osType: 'short', osVersion: 'short', status: 'short', ipAddress: 'short', lastSeenAt: 'ts', siteId: 'id', agentVersion: 'short' } as const;
const auth = () => ({ scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'], orgCondition: () => undefined, allowedSiteIds: null, user: { id: 'u1' } }) as never;

describe('query_devices output shape (A-W05)', () => {
  const tool = aiTools.get('query_devices')!;
  beforeEach(() => { dbMock.setRows([]); });

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit.description).toBe('Max results (default 25, max 100)');
    expect(props.offset.description).toBe('Pagination offset (default 0)');
    expect(props.cursor.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the chat budget uncompacted and carries the envelope', async () => {
    // The handler runs a COUNT query then the row query; the mock resolves both from `rows`, so the count row comes first.
    const rows = Array.from({ length: 25 }, (_, i) => fixtureRow(i, DEVICE_ROW));
    dbMock.setRows(rows);
    const raw = await tool.handler({ status: 'online' }, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['devices', 'total', 'totalMode', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expect(out.limit).toBe(25);
    expect(out.offset).toBe(0);
    expectDefaultPageFits('query_devices', raw);
  });

  it('refuses a cursor minted for different filters', async () => {
    dbMock.setRows(Array.from({ length: 26 }, (_, i) => fixtureRow(i, DEVICE_ROW)));
    const first = JSON.parse(await tool.handler({ status: 'online' }, auth())) as { nextCursor: string | null };
    const second = JSON.parse(await tool.handler({ status: 'offline', cursor: first.nextCursor ?? 'x' }, auth())) as { code?: string };
    expect(second.code).toBe('CURSOR_MISMATCH');
  });
});
```

If the tool's handler resolves the COUNT through a separate `db.execute`/`sql` path, mock that member the same way the tool's existing `*.test.ts` does (copy its `vi.mock('../db', …)` block) — the assertion that matters is the envelope + `expectDefaultPageFits`, not the mock shape.

Run each new file: `cd apps/api && npx vitest run src/services/aiToolsDevice.outputShape.test.ts` → FAIL. **Record the printed `[output-budget] … default page = N chars` line from the failing run as the tool's "before" number** — on main the handler has no envelope yet, so the first red comes from the missing keys; run once more after adding only the envelope keys if the size line did not print.

- [ ] **Step 2: Implement — exemplar `query_devices`** (`aiToolsDevice.ts`):

```ts
import { pageEnvelope, pageParamSchema, readPageArgs } from './aiToolPagination';
// …in the registration:
        properties: {
          status: { … }, osType: { … }, siteId: { … }, search: { … }, tags: { … },
          ...pageParamSchema(25, 100),
        }
// …in the handler, replacing `const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);`:
      const page = readPageArgs('query_devices', input, { defaultLimit: 25, maxLimit: 100 });
      if (!page.ok) return JSON.stringify({ error: page.error, code: page.code });
      const { limit, offset, fingerprint } = page;
// …the row query gains `.offset(offset)` next to `.limit(limit)`; the return becomes:
      return JSON.stringify(pageEnvelope({ key: 'devices', items: results, limit, offset, fingerprint, total: Number(countRow.count) }));
```

The early return for a site-restricted caller with no devices (`:148`) becomes `JSON.stringify(pageEnvelope({ key: 'devices', items: [], limit, offset, fingerprint, total: 0 }))` so the shape is stable. `toolInputSchemas.query_devices` (`aiToolSchemas.ts:129`) and the SDK shape (`aiAgentSdkTools.ts`, the `'query_devices'` declaration) replace `limit: z.number().int().min(1).max(100).optional()` with `...pageZodShape(100)`.

Apply the table to the other seven tools the same way (the `count`/`scope`/`summary`/`worstDevices` keys are spread beside the envelope, never dropped).

- [ ] **Step 3: Run the group (green)**

`cd apps/api && npx vitest run outputShape src/services/aiTools.outputBudget.contract.test.ts src/services/aiToolsDevice src/services/aiToolsTicketing src/services/aiToolsFleet src/services/aiToolsScripts src/services/aiToolsSecurity src/services/aiToolsMonitors src/services/aiToolsAiAgentGovernance src/services/aiToolsVulnerability src/services/aiAgentSdkTools src/services/scriptBuilderTools` → all pass. If `expectDefaultPageFits` fails for a tool, lower **that tool's** default limit in steps of 5 (all three surfaces + the table in this plan) until it passes, and record the final default in the PR.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services
git commit -m "feat(ai): offset-mode pagination envelopes on eight list tools (A-W05 5a)"
```

---

### Task 5b: Shaping group B — keyset mode for churn tables (tools 9–12)

**Files:**
- Modify: `apps/api/src/services/aiToolsAlerts.ts` (`manage_alerts` list `:88-170`), `aiToolsAgentLogs.ts` (`search_agent_logs` `:92-170`), `aiToolsAudit.ts` (`query_audit_log` `:78-215`, `query_change_log` `:227-320`)
- Modify: `aiToolSchemas.ts`, `aiAgentSdkTools.ts` (four entries each)
- Create: `aiToolsAlerts.outputShape.test.ts`, `aiToolsAgentLogs.outputShape.test.ts`, `aiToolsAudit.outputShape.test.ts`

**Interfaces consumed:** `readKeysetArgs`, `keysetEnvelope`, `keysetParamSchema`, `keysetZodShape` (Task 2).

**The change, per tool.** Keyset mode has **no `offset`**: the registry property set becomes `...keysetParamSchema(D, M)` (an existing `offset` property, if any, stays — `query_audit_log`/`query_change_log` have none). The `WHERE` gains the keyset predicate when `after` is set; the query fetches `limit + 1`; the envelope is `keysetEnvelope({ key, items, limit, fingerprint, keyOf, total? })`.

| Tool | D / M | Sort column (already the handler's `orderBy`) | Keyset predicate (Drizzle) | Row trimming |
|---|---|---|---|---|
| `manage_alerts` list | 20 / 100 | `alerts.triggeredAt` desc (`:156`) | `sql\`(${alerts.triggeredAt}, ${alerts.id}) < (${after.t}::timestamptz, ${after.i}::uuid)\`` | `message: row.message.length > 500 ? row.message.slice(0, 500) : row.message`, `messageTruncated: row.message.length > 500`; keep `total` from the existing COUNT |
| `search_agent_logs` | 50 / 500 | `agentLogs.createdAt` desc, then `timestamp`, `id` (`:161`) — key on `(createdAt, id)` and change the `orderBy` to `desc(agentLogs.createdAt), desc(agentLogs.id)` so the key is total | `sql\`(${agentLogs.createdAt}, ${agentLogs.id}) < (${after.t}::timestamptz, ${after.i}::uuid)\`` | replace `db.select()` (whole row, `:153`) with an explicit column map of the fields the mapper at `:164` emits; `fields` only when `input.includeFields === true` (new boolean property, description `'Include the structured fields object per log line (default false)'`); `message` cut at 1 000 chars + `messageTruncated`; keep `count` |
| `query_audit_log` | 25 / 100 | `auditLogs.timestamp` desc (`:210`) | `sql\`(${auditLogs.timestamp}, ${auditLogs.id}) < (${after.t}::timestamptz, ${after.i}::uuid)\`` | `details` → `detailsKeys: Object.keys(details ?? {})` unless `input.includeDetails === true` (new boolean, `'Include the details object per entry (default false)'`) |
| `query_change_log` | 50 / 500 | `deviceChangeLog.timestamp` desc (`:308`) | same shape on `deviceChangeLog` | `beforeValue`, `afterValue`, `details` only when `input.includeValues === true` (`'Include before/after values and details per change (default false)'`); otherwise `changedKeys: string[]` = keys of `afterValue` when it is an object, else `[]`; keep `total` (COUNT at `:311`) and `filters` |

`keyOf` for every row is `(r) => ({ t: <sort timestamp ISO string>, i: r.id })` — the mapper already emits the timestamp as an ISO string; use that field.

- [ ] **Step 1: Write the failing tests — exemplar `manage_alerts` list** (`aiToolsAlerts.outputShape.test.ts`; the two audit tools and the agent-log tool follow the same file with their names, fixture shapes and the `includeDetails`/`includeValues`/`includeFields` assertions)

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

const dbMock = vi.hoisted(() => {
  const rows: unknown[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'offset', 'leftJoin', 'innerJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(rows);
  return { chain, setRows: (r: unknown[]) => { rows.length = 0; rows.push(...r); }, whereSpy: chain.where as ReturnType<typeof vi.fn> };
});
vi.mock('../db', () => ({ db: dbMock.chain }));

import { aiTools } from './aiToolNames';
import './aiTools';

const ALERT_ROW = { id: 'id', deviceId: 'id', hostname: 'short', severity: 'short', status: 'short', title: 'medium', message: 'long', triggeredAt: 'ts', acknowledgedAt: 'null', ruleName: 'medium' } as const;
const auth = () => ({ scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'], orgCondition: () => undefined, allowedSiteIds: null, user: { id: 'u1' } }) as never;

describe('manage_alerts list output shape (A-W05 keyset)', () => {
  const tool = aiTools.get('manage_alerts')!;
  beforeEach(() => dbMock.setRows([]));

  it('declares limit and cursor but NOT offset', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props.limit).toBeDefined();
    expect(props.cursor).toBeDefined();
    expect(props.offset).toBeUndefined();
  });

  it('a default page fits, carries the keyset envelope, and long messages are cut with a flag', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ ...fixtureRow(i, ALERT_ROW), message: 'm'.repeat(900) }));
    dbMock.setRows(rows);
    const raw = await tool.handler({ action: 'list', severity: 'high' }, auth());
    const out = JSON.parse(raw) as { alerts: Array<{ message: string; messageTruncated: boolean }>; showing: number; hasMore: boolean; nextCursor: string | null; offset?: unknown };
    expect(out.showing).toBe(20);
    expect(out.hasMore).toBe(true);
    expect(out.nextCursor).toEqual(expect.any(String));
    expect(out.offset).toBeUndefined();
    expect(out.alerts[0].message).toHaveLength(500);
    expect(out.alerts[0].messageTruncated).toBe(true);
    expectDefaultPageFits('manage_alerts', raw);
  });

  it('a nextCursor turns into a (triggeredAt, id) < (t, i) predicate on the next call', async () => {
    dbMock.setRows(Array.from({ length: 21 }, (_, i) => fixtureRow(i, ALERT_ROW)));
    const first = JSON.parse(await tool.handler({ action: 'list', severity: 'high' }, auth())) as { nextCursor: string };
    dbMock.whereSpy.mockClear();
    dbMock.setRows([]);
    await tool.handler({ action: 'list', severity: 'high', cursor: first.nextCursor }, auth());
    const whereArg = JSON.stringify(dbMock.whereSpy.mock.calls.at(-1)?.[0] ?? {});
    expect(whereArg).toContain('triggered_at');   // the keyset predicate reached the query
  });
});
```

Run: `cd apps/api && npx vitest run src/services/aiToolsAlerts.outputShape.test.ts` → FAIL. Record the printed before-size.

- [ ] **Step 2: Implement — exemplar `manage_alerts` list** (`aiToolsAlerts.ts`, inside the `list` branch):

```ts
import { keysetEnvelope, keysetParamSchema, readKeysetArgs } from './aiToolPagination';
// registry: replace the `limit` property with `...keysetParamSchema(20, 100)`
// handler:
        const page = readKeysetArgs('manage_alerts', input, { defaultLimit: 20, maxLimit: 100 });
        if (!page.ok) return JSON.stringify({ error: page.error, code: page.code });
        const { limit, after, fingerprint } = page;
        if (after) {
          conditions.push(sql`(${alerts.triggeredAt}, ${alerts.id}) < (${after.t}::timestamptz, ${after.i}::uuid)`);
        }
        // …existing COUNT (unchanged, uses `conditions` WITHOUT the keyset predicate — compute it before pushing, so `total` stays the size of the whole filtered set)
        const rows = await db.select({ … })
          .from(alerts)
          .where(and(...conditions))
          .orderBy(desc(alerts.triggeredAt), desc(alerts.id))
          .limit(limit + 1);
        const items = rows.map((row) => ({
          …existing fields…,
          message: row.message && row.message.length > 500 ? row.message.slice(0, 500) : row.message,
          messageTruncated: !!row.message && row.message.length > 500,
          triggeredAt: row.triggeredAt?.toISOString() ?? null,
        }));
        return JSON.stringify(keysetEnvelope({
          key: 'alerts', items, limit, fingerprint, total,
          keyOf: (r) => ({ t: String(r.triggeredAt), i: r.id }),
        }));
```

(`total` is computed from the pre-keyset conditions so a later page still reports the full count — assert that in the test if the COUNT path is mockable.) Zod on both other surfaces: replace `limit` with `...keysetZodShape(100)`.

Apply the table to `search_agent_logs`, `query_audit_log`, `query_change_log`.

- [ ] **Step 3: Run the group (green)**

`cd apps/api && npx vitest run outputShape src/services/aiTools.outputBudget.contract.test.ts src/services/aiToolsAlerts src/services/aiToolsAgentLogs src/services/aiToolsAudit src/services/aiAgentSdkTools` → all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services
git commit -m "feat(ai): keyset pagination and row trimming on alerts, agent logs, audit and change logs (A-W05 5b)"
```

---

### Task 5c: Shaping group C — projections, caps and windows (tools 13–20)

**Files:**
- Modify: `aiToolsOrgs.ts` (`list_organizations` `:163-235`), `aiToolsConfigPolicy.ts` (`list_configuration_policies` `:236-292`), `aiToolsDevice.ts` (`get_device_details` `:202-245`), `aiToolsScripts.ts` (`get_script_execution` `:1225-1292`), `aiToolsIncident.ts` (`get_incident_timeline` `:423-495`), `aiToolsPlaybooks.ts` (`list_playbooks` `:64-108`), `aiToolsPerformance.ts` (`get_active_users` `:508-620`), `aiToolsCisBenchmark.ts` (`get_cis_compliance` `:76-260`)
- Modify: `aiToolSchemas.ts`, `aiAgentSdkTools.ts` for every new property
- Create/extend: `<file>.outputShape.test.ts` beside each

**The change, per tool** (new boolean/number properties are ≤ 160-char descriptions; every new list gets `pageParamSchema`/`pageZodShape` on all three surfaces):

| Tool | Parameters | Handler change | Return |
|---|---|---|---|
| `list_organizations` | `...pageParamSchema(25, 100)` | fetch `limit + 1` orgs; per org `sites: sites.slice(0, 20)`, `siteCount: sites.length` | `pageEnvelope({ key: 'organizations', … })` |
| `list_configuration_policies` | `...pageParamSchema(25, 100)` | replace `db.select()` + `{...p}` spread (`:258-285`) with `db.select({ id, name, description, orgId, partnerId, isDefault, priority, featureTypes, createdAt, updatedAt, settings })` and emit `settingsKeys: Object.keys(p.settings ?? {})` **instead of** `settings` (detail: `get_configuration_policy`) | `pageEnvelope({ key: 'policies', … })` |
| `get_device_details` | none new | replace the three `db.select().from(...)` (`:221-224`) with explicit column maps containing **only scalar columns** (open `db/schema/devices.ts` and list every non-jsonb column of `deviceHardware`, `deviceNetwork`, `deviceDisks`); `networkInterfaces: nics.slice(0, 16)`, `networkInterfaceCount: nics.length`, `disks: disks.slice(0, 16)`, `diskCount: disks.length` | existing keys + the two counts; the test asserts no row value is an object |
| `get_script_execution` | `stdoutOffset` (`'Character offset into stdout (default 0)'`), `stdoutMaxChars` (`'Max stdout chars to return (default 6000, max 16000)'`), `stderrMaxChars` (`'Max stderr chars to return (default 2000, max 8000)'`) | select `sql\`substr(${scriptExecutions.stdout}, ${off + 1}, ${max})\`` as `stdout`, `sql\`length(${scriptExecutions.stdout})\`` as `stdoutChars`, `sql\`left(${scriptExecutions.stderr}, ${errMax})\`` as `stderr`, `sql\`length(${scriptExecutions.stderr})\`` as `stderrChars` (use the column names the existing select at `:1263-1264` uses) | `execution` gains `stdoutChars, stdoutOffset, stdoutNextOffset: off + stdout.length, stdoutHasMore: off + stdout.length < stdoutChars, stderrChars, stderrTruncated: stderr.length < stderrChars` |
| `get_incident_timeline` | `includeEvidenceMetadata` (`'Include the metadata object per evidence row (default false)'`) | `actions: actions.slice(0, 50)`, `actionCount`; evidence query gets an explicit column map (no whole rows) `.limit(51)`, `evidence: rows.slice(0, 50)`, `evidenceCount` (a separate COUNT, or `rows.length` capped — say which in the test); `metadata` only when the flag is true; `timeline: timeline.slice(0, 100)`, `timelineCount` | existing keys + the three counts |
| `list_playbooks` | `...pageParamSchema(25, 100)`, `includeSteps` (`'Include the full steps array per playbook (default false)'`) | fetch `limit + 1`; per row `stepCount: steps.length`, `stepNames: steps.slice(0, 10).map((s) => s.name ?? s.type ?? 'step')`, `steps` only when `includeSteps` | `{ ...pageEnvelope({ key: 'playbooks', … }), count: items.length }` |
| `get_active_users` | `limit` re-described as `'Max devices (default 50, max 200)'`, new `maxSessionsPerDevice` (`'Max sessions listed per device (default 10, max 50)'`) | `limit` now caps **devices** (default 50, max 200); per device `sessions: sessions.slice(0, maxSessions)`, `sessionCount: sessions.length`; `devices` over-fetched by one for `hasMore` | existing keys + `deviceCount` (devices with sessions, from the grouped rows), `showing`, `limit`, `hasMore` |
| `get_cis_compliance` | `...pageParamSchema(25, 500)`, `includeSummary` (`'Include the per-device summary object (default false)'`) | `.limit(limit).offset(offset)`; per-row `summary` only with the flag; `total` = the existing `COUNT(*)` (`:187`) | `{ count, totalMatched, summary, ...pageEnvelope({ key: 'results', items, limit, offset, fingerprint, total: totalMatched }) }` |

- [ ] **Step 1: Write the failing tests — exemplar `get_script_execution`** (`aiToolsScripts.outputShape.test.ts`; `list_organizations`/`list_playbooks`/`get_cis_compliance`/`list_configuration_policies` follow the 5a exemplar plus one assertion per opt-in flag; `get_device_details`/`get_incident_timeline`/`get_active_users` assert the caps and counts)

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits } from './aiToolOutputBudget.testkit';

const dbMock = vi.hoisted(() => {
  const rows: unknown[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'leftJoin', 'innerJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(rows);
  return { chain, setRows: (r: unknown[]) => { rows.length = 0; rows.push(...r); }, selectSpy: chain.select as ReturnType<typeof vi.fn> };
});
vi.mock('../db', () => ({ db: dbMock.chain }));

import { aiTools } from './aiToolNames';
import './aiTools';

const auth = () => ({ scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'], orgCondition: () => undefined, allowedSiteIds: null, allowedDeviceIds: null, user: { id: 'u1' } }) as never;
const EXEC = '11111111-1111-4111-8111-111111111111';

describe('get_script_execution stdout window (A-W05)', () => {
  const tool = aiTools.get('get_script_execution')!;
  beforeEach(() => dbMock.setRows([]));

  it('returns a 6000-char stdout window by default with the continuation fields', async () => {
    dbMock.setRows([{ id: EXEC, status: 'completed', exitCode: 0, stdout: 'o'.repeat(6000), stdoutChars: 25_000, stderr: 'e'.repeat(2000), stderrChars: 9_000, startedAt: new Date('2026-09-20T10:00:00Z'), completedAt: new Date('2026-09-20T10:00:05Z') }]);
    const raw = await tool.handler({ executionId: EXEC }, auth());
    const out = JSON.parse(raw) as { execution: Record<string, unknown> };
    expect(out.execution).toMatchObject({ stdoutChars: 25_000, stdoutOffset: 0, stdoutNextOffset: 6000, stdoutHasMore: true, stderrChars: 9_000, stderrTruncated: true });
    expect((out.execution.stdout as string).length).toBe(6000);
    expectDefaultPageFits('get_script_execution', raw);
  });

  it('honours stdoutOffset/stdoutMaxChars and clamps to 16000', async () => {
    dbMock.setRows([{ id: EXEC, status: 'completed', exitCode: 0, stdout: 'o'.repeat(4000), stdoutChars: 25_000, stderr: '', stderrChars: 0 }]);
    const out = JSON.parse(await tool.handler({ executionId: EXEC, stdoutOffset: 21_000, stdoutMaxChars: 99_999 }, auth())) as { execution: Record<string, unknown> };
    expect(out.execution).toMatchObject({ stdoutOffset: 21_000, stdoutNextOffset: 25_000, stdoutHasMore: false });
    const selectArg = JSON.stringify(dbMock.selectSpy.mock.calls.at(-1)?.[0] ?? {});
    expect(selectArg).toMatch(/substr/);
    expect(selectArg).toMatch(/16000/);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/aiToolsScripts.outputShape.test.ts` → FAIL.

- [ ] **Step 2: Implement — exemplar `get_script_execution`** (`aiToolsScripts.ts` `:1225-1292`):

```ts
// registry properties (beside executionId):
          stdoutOffset: { type: 'number', description: 'Character offset into stdout (default 0)' },
          stdoutMaxChars: { type: 'number', description: 'Max stdout chars to return (default 6000, max 16000)' },
          stderrMaxChars: { type: 'number', description: 'Max stderr chars to return (default 2000, max 8000)' },
// handler:
      const stdoutOffset = Math.max(0, Math.trunc(Number(input.stdoutOffset)) || 0);
      const stdoutMax = Math.min(Math.max(1, Math.trunc(Number(input.stdoutMaxChars)) || 6000), 16000);
      const stderrMax = Math.min(Math.max(1, Math.trunc(Number(input.stderrMaxChars)) || 2000), 8000);
      const [row] = await db.select({
        …every existing column except stdout/stderr…,
        stdout: sql<string>`substr(coalesce(${scriptExecutions.stdout}, ''), ${stdoutOffset + 1}, ${stdoutMax})`,
        stdoutChars: sql<number>`length(coalesce(${scriptExecutions.stdout}, ''))`,
        stderr: sql<string>`left(coalesce(${scriptExecutions.stderr}, ''), ${stderrMax})`,
        stderrChars: sql<number>`length(coalesce(${scriptExecutions.stderr}, ''))`,
      }).from(scriptExecutions).where(…unchanged…).limit(1);
      // …existing not-found / access checks unchanged…
      const stdoutChars = Number(row.stdoutChars);
      const stderrChars = Number(row.stderrChars);
      return JSON.stringify({
        execution: {
          …existing fields…,
          stdout: row.stdout,
          stdoutChars,
          stdoutOffset,
          stdoutNextOffset: stdoutOffset + row.stdout.length,
          stdoutHasMore: stdoutOffset + row.stdout.length < stdoutChars,
          stderr: row.stderr,
          stderrChars,
          stderrTruncated: row.stderr.length < stderrChars,
        },
      });
```

Zod on both other surfaces: `stdoutOffset: z.number().int().min(0).optional(), stdoutMaxChars: z.number().int().min(1).max(16000).optional(), stderrMaxChars: z.number().int().min(1).max(8000).optional()`. Apply the table to the other seven tools. For `get_device_details`, the test builds one hardware row, 20 NIC rows and 20 disk rows with `fixtureRow` and asserts `networkInterfaces.length === 16`, `networkInterfaceCount === 20`, `disks.length === 16`, `diskCount === 20`, and `Object.values(row).every((v) => typeof v !== 'object' || v === null)` for every emitted row.

- [ ] **Step 3: Run the group and the whole budget contract (green)**

`cd apps/api && npx vitest run outputShape src/services/aiTools.outputBudget.contract.test.ts src/services/aiToolsOrgs src/services/aiToolsConfigPolicy src/services/aiToolsDevice src/services/aiToolsScripts src/services/aiToolsIncident src/services/aiToolsPlaybooks src/services/aiToolsPerformance src/services/aiToolsCisBenchmark src/services/aiAgentSdkTools src/services/aiTools.descriptionBudget src/services/aiTools.actionClauses src/services/aiGuardrails.enforcementArming` → all pass. (`aiGuardrails.enforcementArming.contract.test.ts` finds `remediationOptions.autoUninstall` by name inside a property description — none of this wave's edits touch that tool, but the run proves it.) Then remove from `UNBOUNDED_LIST_READS` (Task 4) any tool this group gave a `limit` — the contract's stale-entry check will name it.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services
git commit -m "feat(ai): projections, caps and stdout windows on eight heavy-result tools (A-W05 5c)"
```

---

### Task 6: `read_artifact`, range reads, redact-then-capture (D13a, D13b)

**Files:**
- Modify: `apps/api/src/services/artifacts/blobStorage.ts` (`BlobStorage` interface `:67-74`, the S3 backend `:197+`, every `BlobStorage` fake in `services/artifacts/*.test.ts` and `services/workspace/*.test.ts` — `tsc` names each one)
- Modify: `apps/api/src/services/artifacts/artifactService.ts` (+ `.test.ts`)
- Modify: `apps/api/src/services/artifacts/toolResultCapture.ts` (+ `.test.ts`, the test at `:151` "persists the RAW bytes…")
- Modify: `apps/api/src/services/aiToolOutput.ts` (`redactForCapture`)
- Create: `apps/api/src/services/aiToolsArtifacts.ts`, `apps/api/src/services/aiToolsArtifacts.test.ts`
- Modify: `apps/api/src/services/aiTools.ts` (import + call `registerArtifactTools(aiTools)` beside `registerExportTools` `:94`), `aiToolSchemas.ts`, `aiAgentSdkTools.ts` (`TOOL_TIERS` + a `tool()` declaration), `aiGuardrails.ts` (`TOOL_PERMISSIONS`), `aiAgents/agentToolCatalog.ts` (`TOOL_CAPABILITY`), `mcpCoverage.ts` (`'aiArtifacts.ts'`), `aiGuardrails.routeBinding.contract.test.ts` (`BINDINGS`), `src/__tests__/mcp-coverage.test.ts` (`FROZEN_GAPS`), `apps/web/src/components/ai-risk/tierConfig.ts`

**Interfaces produced:**

```ts
// blobStorage.ts
openRange(key: string, start: number, endInclusive: number): Promise<NodeJS.ReadableStream>;   // on BlobStorage
// artifactService.ts
export const ARTIFACT_READ_MAX_CHARS = 6_000;
export async function findArtifactForCaller(handle: string, auth: AuthContext): Promise<ArtifactRecord | null>;
export async function readArtifactWindow(record: ArtifactRecord, offset: number, maxChars: number): Promise<{ text: string; nextOffset: number; hasMore: boolean }>;
// aiToolOutput.ts
export function redactForCapture(raw: string): string;
```

- [ ] **Step 1: Failing tests**

`blobStorage.test.ts` — add beside the existing S3 tests (use the same mocked `S3Client`/`GetObjectCommand` pattern the file already uses):

```ts
  it('openRange sends an inclusive byte Range header', async () => {
    const send = mockS3Send();   // the file's existing helper that captures the command; if named differently, use that one
    await getBlobStorage().openRange('eu/2026/09/abc', 100, 199);
    const cmd = send.mock.calls.at(-1)?.[0] as { input: { Range?: string } };
    expect(cmd.input.Range).toBe('bytes=100-199');
  });
```

`artifactService.test.ts`:

```ts
describe('readArtifactWindow (A-W05)', () => {
  const record = (bytes: number) => ({ id: 'a', orgId: 'o', runId: null, sessionId: 's', kind: 'input_capture', name: 't.json', contentType: 'application/json', bytes, sha256: '', blobKey: 'k', headPreview: '', tailPreview: '', sourceDeviceId: null, createdByTool: 't', expiresAt: new Date(), createdAt: new Date() }) as never;
  it('never splits a multi-byte character and reports the byte offset actually consumed', async () => {
    // "é" is 2 bytes; a window that ends mid-character must stop before it.
    const body = Buffer.from('ab' + 'é'.repeat(10), 'utf8');   // 22 bytes
    setBlobStorageForTests(fakeRangeStore(body));
    const w = await readArtifactWindow(record(body.length), 0, 3);   // 3 chars → reads up to 12 bytes, returns 3 whole chars
    expect(w.text).toBe('abé');
    expect(w.nextOffset).toBe(4);
    expect(w.hasMore).toBe(true);
    const rest = await readArtifactWindow(record(body.length), w.nextOffset, 6000);
    expect(rest.text).toBe('é'.repeat(9));
    expect(rest.hasMore).toBe(false);
    expect(rest.nextOffset).toBe(22);
  });
  it('clamps maxChars to ARTIFACT_READ_MAX_CHARS and returns an empty window past the end', async () => {
    const body = Buffer.from('x'.repeat(10_000));
    setBlobStorageForTests(fakeRangeStore(body));
    expect((await readArtifactWindow(record(10_000), 0, 99_999)).text).toHaveLength(6000);
    expect(await readArtifactWindow(record(10_000), 10_000, 10)).toEqual({ text: '', nextOffset: 10_000, hasMore: false });
  });
});
```

where `fakeRangeStore(body)` is a `BlobStorage` fake whose `openRange(_, s, e)` returns `Readable.from([body.subarray(s, e + 1)])` (add it to the file's existing fake or beside it).

`toolResultCapture.test.ts` — replace `it('persists the RAW bytes as kind input_capture …')` (`:151`) with:

```ts
  it('persists the REDACTED full payload as kind input_capture (never credential material), and compacted mirrors it', async () => {
    const raw = JSON.stringify({ password: 'hunter2', rows: Array.from({ length: 400 }, (_, i) => ({ i, apiKey: 'sk-live-1', note: 'n'.repeat(20) })) });
    const out = JSON.parse(await captureLargeToolResult(raw, ctx())) as { artifact: { handle: string }; compacted: string };
    const stored = createArtifactMock.mock.calls[0][0] as { body: Buffer; kind: string; createdByTool: string };
    const storedText = stored.body.toString('utf8');
    expect(stored.kind).toBe('input_capture');
    expect(storedText).not.toContain('hunter2');
    expect(storedText).not.toContain('sk-live-1');
    expect(JSON.parse(storedText).rows).toHaveLength(400);
    expect(out.compacted).toBe(storedText);
  });
```

`aiToolsArtifacts.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({ findArtifactForCaller: vi.fn(), readArtifactWindow: vi.fn() }));
vi.mock('./artifacts/artifactService', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...svc }));
const env = vi.hoisted(() => ({ aiWorkspaceEnabled: vi.fn(() => true) }));
vi.mock('../config/env', async (orig) => ({ ...(await orig<Record<string, unknown>>()), aiWorkspaceEnabled: env.aiWorkspaceEnabled }));

import { aiTools } from './aiToolNames';
import './aiTools';

const HANDLE = '22222222-2222-4222-8222-222222222222';
const auth = () => ({ scope: 'organization', orgId: 'o1', partnerId: 'p1', accessibleOrgIds: ['o1'], orgCondition: () => undefined, user: { id: 'u1' } }) as never;
const record = { id: HANDLE, name: 'query_devices.json', contentType: 'application/json', bytes: 40_000 };

describe('read_artifact (A-W05)', () => {
  const tool = aiTools.get('read_artifact')!;
  beforeEach(() => { svc.findArtifactForCaller.mockReset(); svc.readArtifactWindow.mockReset(); env.aiWorkspaceEnabled.mockReturnValue(true); });

  it('is a Tier-1 ai-domain read, capture-exempt, with a budgeted description', () => {
    expect(tool.tier).toBe(1);
    expect(tool.domain).toBe('ai');
    expect(tool.captureExempt).toBe(true);
    expect(tool.definition.description.length).toBeLessThanOrEqual(300);
    expect(tool.searchHint.length).toBeLessThanOrEqual(120);
  });
  it('returns a window with continuation fields and echoes only allow-listed content types', async () => {
    svc.findArtifactForCaller.mockResolvedValue(record);
    svc.readArtifactWindow.mockResolvedValue({ text: '{"devices":[', nextOffset: 12, hasMore: true });
    const out = JSON.parse(await tool.handler({ handle: HANDLE, maxChars: 12 }, auth()));
    expect(out).toEqual({ handle: HANDLE, name: 'query_devices.json', contentType: 'application/json', bytes: 40_000, offset: 0, nextOffset: 12, hasMore: true, text: '{"devices":[' });
    expect(svc.readArtifactWindow).toHaveBeenCalledWith(record, 0, 12);
  });
  it('conceals an artifact that is not the caller\'s own as not found', async () => {
    svc.findArtifactForCaller.mockResolvedValue(null);
    expect(JSON.parse(await tool.handler({ handle: HANDLE }, auth()))).toEqual({ error: 'Artifact not found', code: 'ARTIFACT_NOT_FOUND' });
  });
  it('refuses with a typed error where capture is not enabled', async () => {
    env.aiWorkspaceEnabled.mockReturnValue(false);
    expect(JSON.parse(await tool.handler({ handle: HANDLE }, auth()))).toMatchObject({ error: 'artifact_store_unavailable' });
    expect(svc.findArtifactForCaller).not.toHaveBeenCalled();
  });
  it('rejects a non-uuid handle before any lookup', async () => {
    expect(JSON.parse(await tool.handler({ handle: 'nope' }, auth())).code).toBe('ARTIFACT_NOT_FOUND');
    expect(svc.findArtifactForCaller).not.toHaveBeenCalled();
  });
});
```

Run all four files → FAIL.

- [ ] **Step 2: Implement**

`blobStorage.ts` — interface:

```ts
  /** Inclusive byte range, for paged tool reads (A-W05 D13a). A whole-object read per page is O(n²) on a 64 MiB artifact. */
  openRange(key: string, start: number, endInclusive: number): Promise<NodeJS.ReadableStream>;
```

S3 backend, beside `openStream`:

```ts
  async openRange(key, start, endInclusive) {
    const { region } = regionOfKey(key);   // the same key → region resolution openStream uses
    try {
      const res = await clientFor(region).send(new GetObjectCommand({ Bucket: bucketFor(region), Key: key, Range: `bytes=${start}-${endInclusive}` }));
      if (!res.Body) throw new BlobNotFoundError(key);
      return res.Body as NodeJS.ReadableStream;
    } catch (err) {
      if (isS3NotFound(err)) throw new BlobNotFoundError(key);
      throw classifyS3Failure(err);   // whatever openStream does with a transport fault — mirror it exactly
    }
  }
```

(Use the same helper names `openStream` uses for bucket/client/key parsing; the exact identifiers are at `blobStorage.ts:197-260`.) Add `openRange` to every fake `BlobStorage` the tests construct (`tsc` lists them).

`artifactService.ts`:

```ts
export const ARTIFACT_READ_MAX_CHARS = 6_000;

/** Index of the last byte that ends a complete UTF-8 sequence in `buf`, or 0 when none does. */
function utf8Boundary(buf: Buffer): number {
  const end = buf.length;
  let i = end - 1;
  while (i >= 0 && i >= end - 4 && (buf[i] & 0xc0) === 0x80) i--;
  if (i < 0) return 0;
  const lead = buf[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return end - i >= need ? end : i;
}

async function collect(stream: NodeJS.ReadableStream, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    chunks.push(chunk);
    total += chunk.length;
    if (total >= cap) break;
  }
  return Buffer.concat(chunks, Math.min(total, cap));
}

/**
 * A-W05 (D13a): a character window read through a byte Range. Never splits a
 * UTF-8 sequence; `nextOffset` is the byte offset of the first byte NOT returned.
 */
export async function readArtifactWindow(record: ArtifactRecord, offset: number, maxChars: number): Promise<{ text: string; nextOffset: number; hasMore: boolean }> {
  const start = Math.max(0, Math.trunc(offset));
  const want = Math.min(Math.max(1, Math.trunc(maxChars) || ARTIFACT_READ_MAX_CHARS), ARTIFACT_READ_MAX_CHARS);
  if (start >= record.bytes) return { text: '', nextOffset: record.bytes, hasMore: false };
  const end = Math.min(record.bytes - 1, start + want * 4 - 1);   // 4 bytes per char is the UTF-8 worst case
  const buf = await collect(await getBlobStorage().openRange(record.blobKey, start, end), end - start + 1);
  let cut = utf8Boundary(buf);
  if (cut === 0 && buf.length > 0) cut = buf.length;   // undecodable tail at EOF: emit lossy rather than loop forever
  let text = buf.toString('utf8', 0, cut);
  const chars = Array.from(text);
  if (chars.length > want) text = chars.slice(0, want).join('');
  const used = Buffer.byteLength(text, 'utf8');
  const nextOffset = start + used;
  return { text, nextOffset, hasMore: nextOffset < record.bytes };
}

/**
 * Tool-side resolve: STRONGER than the REST download (`findArtifactForAuth`,
 * org-wide). A model may read only artifacts anchored to its own agent run or
 * to a chat session owned by the calling user — a prompt-injected agent with a
 * guessed uuid must not be able to read a colleague's captured results.
 */
export async function findArtifactForCaller(handle: string, auth: AuthContext): Promise<ArtifactRecord | null> {
  if (!UUID.safeParse(handle).success) return null;
  const principal = auth.principal as AuthContext['principal'] | undefined;
  const runId = principal?.kind === 'ai_agent' ? principal.runId : null;
  const userId = auth.user?.id ?? null;
  if (!runId && !userId) return null;
  const ownership = runId
    ? eq(aiRunArtifacts.runId, runId)
    : inArray(aiRunArtifacts.sessionId, db.select({ id: aiSessions.id }).from(aiSessions).where(eq(aiSessions.userId, userId as string)));
  const [row] = await db
    .select(ARTIFACT_COLUMNS)
    .from(aiRunArtifacts)
    .where(and(eq(aiRunArtifacts.id, handle), auth.orgCondition(aiRunArtifacts.orgId), ownership))
    .limit(1);
  return (row as ArtifactRecord | undefined) ?? null;
}
```

(`aiSessions` is exported from `db/schema/ai.ts:30`; import `inArray` from `drizzle-orm`.)

`aiToolOutput.ts`:

```ts
/** A-W05 (D13b): what the artifact store receives — the FULL payload, secrets already wiped, nothing compacted. */
export function redactForCapture(raw: string): string {
  const parsed = tryParseJson(raw);
  if (parsed === null) return redactAiToolOutputText(raw);
  return safeStringify(redactToolOutputFields(scrubErrorFieldsDeep(parsed), redactAiToolOutputText));
}
```

`toolResultCapture.ts` — inside `captureLargeToolResult`, after the `aiWorkspaceEnabled()` check: `const stored = redactForCapture(raw);` then use `stored` for `looksLikeJson`, `body`, the previews and `compacted: stored`. The threshold stays on `raw.length`.

`aiToolsArtifacts.ts`:

```ts
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import { aiWorkspaceEnabled } from '../config/env';
import { ARTIFACT_READ_MAX_CHARS, findArtifactForCaller, readArtifactWindow } from './artifacts/artifactService';
import { artifactDownloadContentType } from '../routes/aiArtifacts';   // if this import drags the route module's side effects into the hub, move `artifactDownloadContentType` + SAFE_DOWNLOAD_CONTENT_TYPES into artifactService.ts and import from there on both sides
import { sanitizeThrownToolError } from './aiToolErrors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOT_FOUND = JSON.stringify({ error: 'Artifact not found', code: 'ARTIFACT_NOT_FOUND' });

export function registerArtifactTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('read_artifact', {
    tier: 1,
    domain: 'ai',
    searchHint: 'stored tool-result artifacts by handle, paging through oversized output',
    captureExempt: true,
    deviceArgs: [],
    definition: {
      name: 'read_artifact',
      description: 'Read a window of a stored large tool result by its artifact handle (artifact.handle in an earlier result). Returns text from a byte offset with nextOffset and hasMore. Only artifacts from your own session or run.',
      input_schema: {
        type: 'object' as const,
        properties: {
          handle: { type: 'string', description: 'Artifact handle (UUID) from artifact.handle' },
          offset: { type: 'number', description: 'Byte offset to start from; pass nextOffset to continue (default 0)' },
          maxChars: { type: 'number', description: `Max characters to return (default 4000, max ${ARTIFACT_READ_MAX_CHARS})` },
        },
        required: ['handle'],
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext) => {
      if (!aiWorkspaceEnabled()) {
        return JSON.stringify({ error: 'artifact_store_unavailable', message: 'Artifact capture is not enabled on this deployment; narrow the original query instead.' });
      }
      const handle = typeof input.handle === 'string' ? input.handle : '';
      if (!UUID_RE.test(handle)) return NOT_FOUND;
      try {
        const record = await findArtifactForCaller(handle, auth);
        if (!record) return NOT_FOUND;
        const offset = Math.max(0, Math.trunc(Number(input.offset)) || 0);
        const maxChars = Math.min(Math.max(1, Math.trunc(Number(input.maxChars)) || 4000), ARTIFACT_READ_MAX_CHARS);
        const window = await readArtifactWindow(record, offset, maxChars);
        return JSON.stringify({
          handle: record.id,
          name: record.name,
          contentType: artifactDownloadContentType(record.contentType),
          bytes: record.bytes,
          offset,
          nextOffset: window.nextOffset,
          hasMore: window.hasMore,
          text: window.text,
        });
      } catch (err) {
        return JSON.stringify({ error: sanitizeThrownToolError('read_artifact', err) });
      }
    },
  });
}
```

Registration on every contract surface:
- `aiTools.ts`: `import { registerArtifactTools } from './aiToolsArtifacts';` and `registerArtifactTools(aiTools);` next to `registerExportTools(aiTools)`.
- `aiToolSchemas.ts`: `read_artifact: z.object({ handle: uuid, offset: z.number().int().min(0).optional(), maxChars: z.number().int().min(1).max(6000).optional() }),`
- `aiAgentSdkTools.ts`: `read_artifact: 1,` in `TOOL_TIERS`; and beside `export_dataset`'s declaration: `tool('read_artifact', registryDescription('read_artifact'), { handle: z.string().guid(), offset: z.number().int().min(0).optional(), maxChars: z.number().int().min(1).max(6000).optional() }, makeHandler('read_artifact', getAuth, onPreToolUse, onPostToolUse)),`
- `aiGuardrails.ts` `TOOL_PERMISSIONS`: `read_artifact: { resource: 'ai_agents', action: 'read' },` (the route's `PERMISSIONS.AI_AGENTS_READ`, `routes/aiArtifacts.ts:40`).
- `aiAgents/agentToolCatalog.ts` `TOOL_CAPABILITY`: `read_artifact: 'workspace',` (`CAPABILITY_DOMAINS.workspace` includes `ai`, `:84`).
- `mcpCoverage.ts`: `'aiArtifacts.ts': { tools: ['read_artifact'] },` and delete `'aiArtifacts.ts'` from `FROZEN_GAPS` in `src/__tests__/mcp-coverage.test.ts`.
- `aiGuardrails.routeBinding.contract.test.ts` `BINDINGS`: `{ tool: 'read_artifact', routeFile: 'aiArtifacts.ts', method: 'get', path: '/:id', toolOnly: { extra: [], reason: 'Only artifacts anchored to the caller\'s own session or agent run, and only where capture is enabled; the REST download is org-wide.' } },`
- `apps/web/src/components/ai-risk/tierConfig.ts`: `{ name: 'read_artifact', description: 'Read a stored tool-result artifact', category: 'AI Governance' },` in the same block as `list_ai_agents` (`:159`) — the pairs allowlist maps the `workspace` capability to the category `export_dataset` uses; if `export_dataset` sits in a different category, use that one.

- [ ] **Step 3: Run (green)**

`cd apps/api && npx vitest run src/services/artifacts src/services/aiToolsArtifacts src/services/aiTools.domainMetadata src/services/aiAgentSdkTools src/services/aiGuardrails src/services/aiAgents/agentToolCatalog src/__tests__/mcp-coverage src/services/aiToolPermissionsCatalogParity src/services/aiGuardrailsTierConfig.parity src/services/aiAgents` → all pass; `cd apps/web && npx vitest run ai-risk` → pass. If `mcpGuidancePromptTools.test.ts` trips on `MCP_TOOL_COUNT_APPROX` (`services/mcpGuidance.ts:8`), bump the constant to the measured count it prints.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src apps/web/src/components/ai-risk/tierConfig.ts
git commit -m "feat(ai): read_artifact with ranged, own-session artifact reads; capture stores the redacted payload (A-W05 D13a/b)"
```

---

### Task 7: External MCP — version-gated `resource_link` and `breeze://artifacts/{id}` (D13c)

**Files:**
- Modify: `apps/api/src/services/mcpProtocol.ts` (+ `mcpProtocol.test.ts`)
- Modify: `apps/api/src/services/aiToolOutput.ts` (`readCaptureHandle`)
- Modify: `apps/api/src/routes/mcpServer.ts` (`execute` `:1443-1508`, `MCP_RESOURCE_PERMISSIONS` `:2199-2207`, `handleResourcesRead` `:2308`)
- Create: `apps/api/src/routes/mcpServer.artifacts.test.ts`

**Interfaces produced:**

```ts
// mcpProtocol.ts
export function supportsResourceLinks(version: McpProtocolVersion): boolean;          // version >= '2025-06-18'
export function negotiatedVersionFromHeader(header: string | undefined): McpProtocolVersion;   // parsed value or ASSUMED_MCP_PROTOCOL_VERSION
// aiToolOutput.ts
export interface CaptureHandle { handle: string; bytes: number; contentType: string }
export function readCaptureHandle(value: unknown): CaptureHandle | null;   // recognises the {artifact, compacted} envelope AFTER compaction (compacted may be an object)
```

- [ ] **Step 1: Failing tests**

`mcpProtocol.test.ts`:

```ts
  it('resource_link is emitted only to 2025-06-18+ clients; an absent header is the assumed 2025-03-26 and gets none', () => {
    expect(supportsResourceLinks('2025-11-25')).toBe(true);
    expect(supportsResourceLinks('2025-06-18')).toBe(true);
    expect(supportsResourceLinks('2025-03-26')).toBe(false);
    expect(supportsResourceLinks('2024-11-05')).toBe(false);
    expect(negotiatedVersionFromHeader(undefined)).toBe('2025-03-26');
    expect(negotiatedVersionFromHeader('2025-11-25')).toBe('2025-11-25');
  });
```

`mcpServer.artifacts.test.ts` (copy the app/auth/session bootstrap from `mcpServer.streamable.test.ts`'s `'tools/call structuredContent (B-W01)'` suite — same mocks, same `initialize` → `Mcp-Session-Id` dance; mock `executeTool` to return the capture envelope):

```ts
const ENVELOPE = JSON.stringify({ artifact: { handle: '33333333-3333-4333-8333-333333333333', bytes: 123_456, contentType: 'application/json', head: '{"devices":[', tail: ']}' }, compacted: JSON.stringify({ devices: [{ id: 'd1' }], total: 1, showing: 1 }) });

describe('tools/call with a captured result (A-W05 D13c)', () => {
  it('adds a resource_link block for a 2025-06-18 client and keeps the text block first', async () => {
    executeToolMock.mockResolvedValueOnce(ENVELOPE);
    const res = await call('tools/call', { name: 'query_devices', arguments: {} }, { 'MCP-Protocol-Version': '2025-06-18' });
    const content = res.result.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('text');
    expect(content[1]).toEqual({ type: 'resource_link', uri: 'breeze://artifacts/33333333-3333-4333-8333-333333333333', name: 'query_devices.json', mimeType: 'application/json', size: 123_456, description: 'Full tool result (123456 bytes); read with resources/read, paged by ?offset=' });
    expect(res.result.structuredContent).toMatchObject({ artifact: { handle: '33333333-3333-4333-8333-333333333333' } });
  });
  it('sends no resource_link to a 2025-03-26 client or when the header is absent', async () => {
    executeToolMock.mockResolvedValueOnce(ENVELOPE);
    const res = await call('tools/call', { name: 'query_devices', arguments: {} }, {});
    expect((res.result.content as unknown[]).length).toBe(1);
  });
});

describe('resources/read breeze://artifacts/{id} (A-W05 D13c)', () => {
  it('is denied without ai_agents:read and unknown for a malformed id', async () => {
    permissionMock.mockResolvedValueOnce('Permission denied: ai_agents:read');
    const denied = await call('resources/read', { uri: 'breeze://artifacts/33333333-3333-4333-8333-333333333333' });
    expect(denied.error.code).toBe(-32603);
    const unknown = await call('resources/read', { uri: 'breeze://artifacts/not-a-uuid' });
    expect(unknown.error.message).toMatch(/Unknown resource URI/);
  });
  it('serves a server-capped window with continuation in _meta for a 2025-06-18 client, and without _meta for an older one', async () => {
    findArtifactForCallerMock.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333', name: 'query_devices.json', contentType: 'application/json', bytes: 123_456, blobKey: 'k' });
    readArtifactWindowMock.mockResolvedValue({ text: '{"devices":[', nextOffset: 12, hasMore: true });
    const res = await call('resources/read', { uri: 'breeze://artifacts/33333333-3333-4333-8333-333333333333?offset=0&maxChars=99999' }, { 'MCP-Protocol-Version': '2025-06-18' });
    expect(readArtifactWindowMock).toHaveBeenCalledWith(expect.objectContaining({ id: '33333333-3333-4333-8333-333333333333' }), 0, 6000);
    expect(res.result.contents[0]).toEqual({ uri: 'breeze://artifacts/33333333-3333-4333-8333-333333333333?offset=0&maxChars=99999', mimeType: 'application/json', text: '{"devices":[', _meta: { offset: 0, nextOffset: 12, hasMore: true, bytes: 123_456 } });
    const old = await call('resources/read', { uri: 'breeze://artifacts/33333333-3333-4333-8333-333333333333' }, {});
    expect(old.result.contents[0]).not.toHaveProperty('_meta');
  });
  it('conceals an artifact the caller does not own', async () => {
    findArtifactForCallerMock.mockResolvedValue(null);
    const res = await call('resources/read', { uri: 'breeze://artifacts/33333333-3333-4333-8333-333333333333' });
    expect(res.error.message).toMatch(/Artifact not found/);
  });
});
```

Run both files → FAIL.

- [ ] **Step 2: Implement**

`mcpProtocol.ts`:

```ts
/** `resource_link` content and `_meta` on resource contents exist from 2025-06-18; strict older clients decode content[] as a closed union. */
export function supportsResourceLinks(version: McpProtocolVersion): boolean {
  return version >= '2025-06-18';   // ISO dates compare lexicographically
}
export function negotiatedVersionFromHeader(header: string | undefined): McpProtocolVersion {
  const parsed = parseMcpProtocolVersionHeader(header);   // { ok: true, version, assumed } | { ok: false, value } (mcpProtocol.ts:18-27)
  return parsed.ok ? parsed.version : ASSUMED_MCP_PROTOCOL_VERSION;   // an unsupported header never reaches a handler: the dispatcher 400s it first (mcpServer.ts:741-748)
}
```

`aiToolOutput.ts`:

```ts
export interface CaptureHandle { handle: string; bytes: number; contentType: string }
/** The capture envelope as it looks AFTER compactToolResultForChat (`compacted` is then usually an object). */
export function readCaptureHandle(value: unknown): CaptureHandle | null {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !('artifact' in value) || !('compacted' in value)) return null;
  const artifact = (value as Record<string, unknown>).artifact;
  if (!isRecord(artifact) || typeof artifact.handle !== 'string') return null;
  return {
    handle: artifact.handle,
    bytes: Number(artifact.bytes) || 0,
    contentType: typeof artifact.contentType === 'string' ? artifact.contentType : 'application/octet-stream',
  };
}
```

`mcpServer.ts` — in `execute`, after `const structured = structuredFromSafeText(safeResult);`:

```ts
      const version = negotiatedVersionFromHeader(c?.req.header('MCP-Protocol-Version'));
      const captured = supportsResourceLinks(version) ? readCaptureHandle(structured) : null;
      const linkBlocks = captured
        ? [{
            type: 'resource_link' as const,
            uri: `breeze://artifacts/${captured.handle}`,
            name: `${toolName}.${captured.contentType.startsWith('application/json') ? 'json' : 'txt'}`,
            mimeType: artifactDownloadContentType(captured.contentType),
            size: captured.bytes,
            description: `Full tool result (${captured.bytes} bytes); read with resources/read, paged by ?offset=`,
          }]
        : [];
```

and spread `...linkBlocks` after the text block in both `jsonRpcResult` calls that carry `structuredContent` (`:1481-1484`, `:1494-1497`); the image branch is untouched. `handleToolsCall` already receives `c` (`:1264`); thread it into `execute`'s closure (it is in scope).

`MCP_RESOURCE_PERMISSIONS` gains, anchored:

```ts
  { pattern: /^breeze:\/\/artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(\?offset=\d{1,12}(&maxChars=\d{1,6})?)?$/i, permission: { resource: 'ai_agents', action: 'read' } },
```

`handleResourcesRead`, before the existing dynamic-URI handling (`:2438`):

```ts
    const artifactMatch = uri.match(/^breeze:\/\/artifacts\/([0-9a-f-]{36})(?:\?offset=(\d+)(?:&maxChars=(\d+))?)?$/i);
    if (artifactMatch?.[1]) {
      const record = await findArtifactForCaller(artifactMatch[1], auth);
      if (!record) return jsonRpcError(id, -32602, `Artifact not found: ${artifactMatch[1]}`);
      const offset = Math.max(0, Number(artifactMatch[2] ?? 0));
      const maxChars = Math.min(Math.max(1, Number(artifactMatch[3] ?? ARTIFACT_READ_MAX_CHARS)), ARTIFACT_READ_MAX_CHARS);   // server-side cap: resources/read has no compaction
      const window = await readArtifactWindow(record, offset, maxChars);
      const withMeta = supportsResourceLinks(negotiatedVersionFromHeader(headerVersion));
      return jsonRpcResult(id, {
        contents: [{
          uri,
          mimeType: artifactDownloadContentType(record.contentType),
          text: window.text,
          ...(withMeta ? { _meta: { offset, nextOffset: window.nextOffset, hasMore: window.hasMore, bytes: record.bytes } } : {}),
        }],
      });
    }
```

`handleResourcesRead` has no `c`; add a `headerVersion?: string` parameter and pass `c.req.header('MCP-Protocol-Version')` from the dispatcher at `:935`. Import `findArtifactForCaller`, `readArtifactWindow`, `ARTIFACT_READ_MAX_CHARS` from `../services/artifacts/artifactService` and `readCaptureHandle` from `../services/aiToolOutput`.

- [ ] **Step 3: Run (green)**

`cd apps/api && npx vitest run src/services/mcpProtocol src/routes/mcpServer` → all pass, including `mcpServer.conformance.contract.test.ts` (the text block is still first and `structuredContent` is unchanged).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/mcpProtocol.ts apps/api/src/services/mcpProtocol.test.ts apps/api/src/services/aiToolOutput.ts apps/api/src/routes/mcpServer.ts apps/api/src/routes/mcpServer.artifacts.test.ts
git commit -m "feat(mcp): version-gated resource_link for captured results and paged breeze://artifacts reads (A-W05 D13c)"
```

---

### Task 8: Prompts, docs, measurement, follow-ups, PR

**Files:**
- Modify: `apps/api/src/services/aiAgentSystemPrompt.ts` (+ `aiAgentSystemPrompt.test.ts`), `apps/api/src/services/mcpGuidance.ts` (+ `mcpGuidancePromptTools.test.ts`)
- Modify: `apps/docs/src/content/docs/features/mcp-server.mdx` ("Available resources" table `:351`), `.claude/skills/ai-agent/SKILL.md`
- Modify: `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md` (new §7), `docs/superpowers/plans/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization.md` (A-W05 row → **written**, D10–D16 summary lines)

- [ ] **Step 1: Prompt sentences (red → green)**

Test first, in `aiAgentSystemPrompt.test.ts`:

```ts
  it('tells the model how to continue a paged result and how to read a handle (A-W05)', () => {
    expect(AI_SYSTEM_PROMPT_TAIL).toContain('hasMore');
    expect(AI_SYSTEM_PROMPT_TAIL).toContain('nextCursor');
    expect(AI_SYSTEM_PROMPT_TAIL).toContain('read_artifact');
  });
```

Then add to the TAIL (`aiAgentSystemPrompt.ts`, the section that describes tool results) exactly:

`List results carry hasMore and nextCursor. When hasMore is true and you need more, call the same tool again with cursor set to nextCursor and the same filters. A result with artifact.handle means the full output is stored: use read_artifact to page through it instead of re-running the query.`

The same two sentences go into `MCP_SERVER_INSTRUCTIONS` (`mcpGuidance.ts:10`) with `read_artifact` replaced by `read_artifact or the resource_link in the result`, and `mcpGuidancePromptTools.test.ts` gains the matching `toContain` assertions. Confirm `Buffer.byteLength(composeStaticSystemPrompt(...))` printed by `ai:tool-capture` did not grow by more than 400 bytes.

- [ ] **Step 2: Docs**

`mcp-server.mdx` "Available resources" table gains the row `| \`breeze://artifacts/{id}?offset=N&maxChars=M\` | Tool-result artifact | A window of a stored large tool result (your own session or run only); \`_meta\` carries \`nextOffset\`/\`hasMore\` for 2025-06-18+ clients. | 6 000 chars |` and a short paragraph under "Available tools": list tools return `hasMore`/`nextCursor`; a captured result adds a `resource_link` content block for 2025-06-18+ clients. `.claude/skills/ai-agent/SKILL.md` gets a "Result envelopes (A-W05)" subsection: the offset and keyset envelopes, the `_chat.nextStep` hint, `read_artifact`, and the rule that a new list tool uses `pageParamSchema`/`pageZodShape` on all three surfaces. Run `cd apps/docs && pnpm astro check` (or the `docs-check` command `ci.yml` runs) → clean.

- [ ] **Step 3: Measure**

1. `cd apps/api && npx vitest run outputShape 2>&1 | grep '\[output-budget\]'` → paste the 20 lines into the PR table beside the before-sizes recorded in Tasks 5a–5c Step 1.
2. `cd apps/api && pnpm ai:tool-eval --out /tmp/a05-eval.json --summary-md /tmp/a05-eval.md` with `AI_TOOL_EVAL_KEY` set (**gate**: without the secret this step is `not run`, as A-W03 Task 7 is — say so in the PR, do not invent numbers). Compare first-call accuracy with the latest row in the baseline doc; list every list-tool case whose observed tool changed.
3. `cd apps/api && pnpm ai:tool-capture --surface chat --turns 2` → append the row (prompt bytes, turn-1/turn-2 tokens).
4. Append **§7 Output efficiency (A-W05)** to the baseline doc: the 20-row before/after table, the eval delta (or `not run: AI_TOOL_EVAL_KEY absent`), the capture row, and the sentence "Production output-size report: `not run` — needs `docs/superpowers/specs/ai-mcp/sql/2026-09-17-ai-tool-usage-90d.sql` on EU + US (Todd); the 20-tool list above is provisional until then."

- [ ] **Step 4: Follow-up issues** (file with `gh issue create`, label `enhancement`, reference #6152):

1. **Capture gate decoupled from the workspace flag** (D15): `BREEZE_AI_ARTIFACT_CAPTURE_ENABLED` honoured when artifact S3 config exists; `config/validate.ts`, compose mapping, `.env.example`, sweeper coverage; hosted-by-default unchanged.
2. **MCP read anchoring**: tier-1/2 MCP `tools/call` has no `ai_sessions` anchor, so capture never fires and `resource_link` never appears for reads; design a per-transport-session anchor under Feature B (#6154).
3. **Remaining unbounded reads**: the `UNBOUNDED_LIST_READS` set (Task 4) and the detail tools returning whole rows (`manage_alerts` get, `manage_tickets` get, `manage_monitors` get, `get_script_details`), to be shaped from the D10 production ranking.
4. **`list_monitors` pushes `limit`/`offset` into `listMonitorDefinitions`** (today it still loads every definition).

- [ ] **Step 5: Whole suite, typecheck, lint, PR**

```bash
cd apps/api && npx vitest run
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json
cd apps/web && npx vitest run ai-risk
pnpm lint
git add -A -- . ':!.env' ; git commit -m "docs(ai): A-W05 prompts, docs, measurement rows and plan index"   # note: `git add … ':!.env'` exits 1 when .env is ignored — run add and commit as separate commands, confirm with git log
git push -u origin feature/6147-agent-tool-efficiency/wave-6152
```

PR body (the program's skeleton): first line `Closes #6152 (feature #6147, wave A-W05). Plan: docs/superpowers/plans/ai-mcp/2026-09-17-agent-tool-efficiency-a05-output-efficiency.md`; `## What changes` (bold bullets with the measured before/after per tool); `## Independent review folded in (Opus reviewer 2026-09-20; Codex xhigh owed)` listing the D10/D12/D13 corrections; `## Evidence` with **Verified (controller)** lines (exact commands, pass counts, tsc exit 0) and **NOT done** lines (`AI_TOOL_EVAL_KEY`, production SQL); `## Follow-ups` with the four issue numbers; the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` trailer. One `/pr-review-toolkit:review-pr` round; a Sonnet-or-Opus reviewer on Task 6 (artifact ownership, redaction) and Task 5b (keyset predicates), because those are the tenancy-adjacent diffs. Then `gh pr merge <N>` on green, `complete_wave` on #6152.

---

## Self-review against the spec

- **"Fix #6140 redactor first"** — merged as #6324 before this plan; D13(b) tightens the same boundary further (redact-then-capture).
- **"Per-tool result shaping review for the 20 hottest tools"** — Tasks 5a–5c cover 20 tools; D10 (Task 1) makes "hottest" measurable from production and the plan says how the provisional list is replaced. Gap acknowledged: the production ranking is not available at planning time.
- **"Pagination params where results are truncated by the 8k cap"** — D11/Task 2 (helper), Task 5 (applied), D12/Task 4 (the frozen set of tools that still cannot page, shrink-only), Task 3 (the compactor stops suggesting pagination to tools that lack it).
- **"`resource_link`-style handles for large payloads (exports, logs)"** — D13/Tasks 6–7: in-product agents get `read_artifact`; MCP gets a version-gated `resource_link` and a paged resource; `export_dataset` already returns a handle and now has a reader. Honest limit stated: MCP reads have no capture anchor today (follow-up 2).
- **"Structured results"** — the additive envelope is a stable structure on every shaped tool and flows into MCP `structuredContent` unchanged (B-W01); `outputSchema` deliberately deferred (D16).
- **Principle 1 (measure)** — Task 8 Step 3; per-tool before/after comes from the fixture tests' own red/green runs, not estimates.
- **Principle 2 (one source of truth)** — page-parameter text and Zod shapes come from one module; the compactor's hint is derived from the registry through the hub, never typed per tool.
- **Principle 4 (tool never weaker than its route)** — `read_artifact` is stronger and declared so; no shaped tool loses an authorization check (the site/device gates precede every query change).
- **Principle 5 (no write without read-back)** — `export_dataset` (a write of an artifact) now has `read_artifact`.
- **Principle 6 (never rename)** — no tool renamed, no action removed, no top-level result key removed; row-level drops are behind opt-in flags or a detail tool and are named in the table.
- **Type consistency** — `readPageArgs`/`pageEnvelope`/`readKeysetArgs`/`keysetEnvelope`/`pageParamSchema`/`pageZodShape`/`keysetParamSchema`/`keysetZodShape` (Task 2) are the names used in Tasks 4, 5a, 5b, 5c; `findArtifactForCaller`/`readArtifactWindow`/`ARTIFACT_READ_MAX_CHARS` (Task 6) are the names used in Task 7; `SENTINEL_HINTS`/`setToolPaginationHintResolver` (Task 3) are the names used in its tests; `readCaptureHandle`/`redactForCapture` live in `aiToolOutput.ts` and are imported from there.
