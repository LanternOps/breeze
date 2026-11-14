---
title: Programmatic tool calling for fleet-scale AI work — decision
status: draft (decision document), revised after independent review 2026-11-08 (AGREE WITH CHANGES; all points folded in). Awaiting Todd's call on the Open Decisions in §8. No plan, no code.
date: 2026-11-08
kind: decision
sibling: 2026-11-08-ai-tool-examples-and-discovery-telemetry-spec.md (defines the discovery telemetry this decision depends on)
related: "2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md, 2026-09-17-agent-tool-efficiency-baseline.md, 2026-09-13-ai-agent-execution-plane-design.md, 2026-09-30-ai-model-registry-design.md, 2026-10-19-wisp-orchestrator-design.md, 2026-11-06-small-model-tool-profiles-spec.md"
---

# Programmatic tool calling — decision

**Scope:** whether, and how, Breeze lets a model run *many* tool calls without each intermediate result entering the conversation context. Options: Anthropic's hosted Programmatic Tool Calling (O1), a Breeze-hosted sandbox "code mode" with tool access (O2), a chat-to-analysis-run bridge over the existing sandbox (O3b), and a no-sandbox extension of server-side aggregate and flow tools (O3). This is a decision document, not a build spec: it says what we would need to see to pick, and what we pick absent that evidence.

## 1. Problem

The motivating workload is the fleet-scale question: *"which of our 500 devices have X, and do Y to them."* Today that loop is driven from inside the model's context: `query_devices` (20 rows a page, 100 max) pages the fleet, a per-device read runs for each candidate, the model reasons over the union, then it issues the action. Every page and per-device result lands in context (after compaction), is re-sent on every later turn, and competes with the system prompt and tool index for attention.

- **Tokens.** N devices × (one result + one tool_use block) of input, replayed each turn. Compaction (`compactToolResultForChat`, 8,000-char budget) bounds each result; nothing bounds the count.
- **Latency.** The SDK runs independent calls concurrently (`aiAgentSdkTools.ts` `PreToolUseResult` notes), so one call is not one round trip. What costs turns is *sequential dependency depth*: page → pick → per-device read → aggregate → act. That depth, not the raw call count, is the latency driver and is what E1 must measure.
- **Quality.** The model aggregates by reading, which is where miscounts, dropped rows and "I checked the first 40" answers come from.

Anthropic reports a 37% average token reduction on complex research tasks from moving this loop out of context (§9). The shape matches ours; the magnitude for Breeze is unmeasured (§6).

## 2. What we have today

Verified against the tree on 2026-11-08 (paths under `apps/api/src/`).

| Piece | Where | Relevance |
|---|---|---|
| Chat runs on the Claude Agent SDK `query()` with an in-process MCP server | `services/aiAgentSdkTools.ts` (`createBreezeMcpServer` → `createSdkMcpServer`) | Tools are registered through the SDK's MCP server, not as Messages-API custom tools. |
| **Gating is upstream of the executor.** Guardrails (`checkGuardrails` / flow and tenant variants), RBAC (`checkToolPermission`) and per-tool rate limits run in the SDK pre-tool-use path; `executeTool` then validates input, applies device/data-policy restrictions and calls the handler | `services/aiAgentSdk.ts` (~1528, ~1593, ~1610); `services/aiTools.ts:753` | `executeTool` alone is **not** the approval gate. Any brokered surface (O2/O3b/O3) must enter through the upstream pre-tool-use path, or re-host that path, never call `executeTool` directly. |
| Tiers: 1 auto, 2 audit (includes low-risk **mutations**; `TIER2_READONLY_ACTIONS` is the read subset), 3 approval, blocked. Read-only is a *resolution* over tool + action + input (`isReadOnlyResolution`, `isInputAwareTier3`) | `services/aiGuardrails.ts:300-315, 516, 1256, 3266` | "Tier 3 gates every side effect" is wrong; Tier 2 writes exist. Fidelity means: every brokered call is classified on its resolved action and input, exactly as a direct call would be. |
| Approvals are **durable intents**. Chat waits via `waitForIntentDecision` within the org's interactive budget (5-min product default; partner default → org override, #6475, `aiApprovalTimeout.ts`); ending the wait leaves the intent `pending_approval` for the release worker (`jobs/intentReleaseWorker.ts`) | `services/aiAgentSdk.ts:2473-2492`, `actionIntents/intentService.ts` | Approval is not a 5-minute yes/no inside a request; it is a row with a later execution path. Any script/bulk design inherits this: the frozen target set must live on the intent. |
| Frozen-set approvals exist, and freezing happens at **intent creation**, not in the handler. `run_script { groupId }` resolves to `deviceIds` in `intentService.ts` before guardrail/digest/approver steps; `RUN_SCRIPT_AI_MAX_DEVICES = 10`; partner groups refused | `actionIntents/intentService.ts:1686-1717`, `actionIntents/runScriptGroupTarget.ts:36, 114-133` | Direct precedent for any filter → frozen set → one approval design, and the current ceiling (10) that a "500-device" bulk action would expand by 50×. |
| Fleet aggregates already exist | `services/aiToolsDevice.ts:399-423` `get_fleet_device_stats` (exact counts, org/site/device axes) | O3 should extend this family rather than invent `query_devices` aggregates from scratch. |
| Flows: idempotency keys, sensitive-step approvals, frozen fleet inputs parked for approval | `services/aiToolsFlows.ts:192-199` `run_flow`; `services/flows/fleetStep.ts:42` | A deterministic multi-step orchestration substrate with the approval semantics already designed. |
| Analysis pipeline outside context: `export_dataset` → `workspace_stage` → `workspace_run` (no network, no device reach) → `submit_analysis`, owned by an agent run | `services/aiToolsExport.ts:65,111`; `services/workspace/workspaceTools.ts:60,92`; `services/aiAgents/analysisProfile.ts:81` | A Breeze-hosted sandbox already runs model-written scripts over fleet datasets. What it lacks is a chat entry point and **tool access from inside the script** — the latter is O2's genuinely new risk. |
| Result compaction also **redacts, scrubs error fields and fences untrusted text** in one chokepoint | `services/aiToolOutput.ts:1488-1503` | Any path that hands raw results to a sandbox (O1/O2/O3b) must apply the same scrub/fence/redact contract before the data leaves the handler. |
| Pagination envelopes, offset and keyset; `MAX_OFFSET` 10,000 | `services/aiToolPagination.ts` | Bounds one result; does not address fan-out. |
| Oversized results parked as artifacts, `read_artifact` | `services/aiToolsArtifacts.ts`; `config/env.ts:395-407` | **Not hosted-only**: self-hosters opt in with their own object store (`BREEZE_AI_ARTIFACT_CAPTURE_ENABLED`). |
| Site restriction is app-layer, not RLS | `services/aiToolsDevice.ts:221` | A server-side filter resolver must apply `siteScopeCondition`/`deviceScopeCondition`; RLS is the org floor only. |
| Headless runs, script builder, Wisp | `aiAgents/runLoop.ts` `resolveRunToolExposure`; `2026-10-19-wisp-orchestrator-design.md` | Non-interactive surfaces turn approvals into proposals/outbox; any option must fit that. |
| Model registry with BYO / OpenAI-compatible providers | `2026-09-30-ai-model-registry-design.md`; `2026-11-06-small-model-tool-profiles-spec.md` | Portability is a product criterion, not only a technical one. |
| Efficiency baseline | `2026-09-17-agent-tool-efficiency-baseline.md` | Measured per-result size, cache shape, 90-day hot/cold tools. **No fan-out or dependency-depth measurement exists.** |

The last row is the key gap: we know how big one result is, not how many dependent results a fleet question needs. The sibling telemetry spec (frontmatter) is where that comes from.

## 3. Options

### O1 — Anthropic Programmatic Tool Calling (PTC)

`code_execution_20260120` plus `allowed_callers: ["code_execution_20260120"]` on tools. Claude writes Python in Anthropic's container; when the code calls a tool the API pauses and returns a `tool_use` block tagged with its `caller`; we return the result; only the script's output enters context. The generated code is visible in the response (`server_tool_use`), so it is auditable.

- **Constraints (from the PTC docs, §9).** Not with `strict: true`, forced `tool_choice`, or `disable_parallel_tool_use`; no recursive `$ref` schemas. Tools from Anthropic's **MCP connector** cannot be called programmatically — this is about the connector, not MCP in general. The live question for Breeze is whether the Agent SDK exposes `allowed_callers` for tools registered via `createSdkMcpServer` (E6). A pending programmatic call times out after ~4 minutes with a `TimeoutError` in the script. `allowed_callers` is guidance, not a hard block on direct calls. Available on the Claude API, Claude Platform on AWS and Foundry (hosted on Anthropic).
- **Benefit.** No sandbox to build or secure on our side; the strongest external evidence (37%).
- **Approval fidelity.** A Tier 3 call from inside the script *can* pause (that is the client-tool mechanism), but the 4-minute script-side timeout is shorter than the 5-minute default interactive budget and the durable-intent path assumes the session can move on. So "reads only inside the sandbox; the script returns a proposed frozen set; the action is a normal gated call afterwards" is a **policy** we would adopt, not an impossibility. Tools opted in must also be retry-safe, which excludes non-idempotent writes anyway.
- **Data handling (new risk).** Intermediate tool results go to Anthropic's container and are retained up to 30 days; PTC is **not eligible for ZDR or HIPAA** per the docs. For an RMM carrying device inventories and logs this is a contractual question before a technical one, and any data leaving must still pass the compaction chokepoint's scrub/fence/redact contract.
- **Portability.** Anthropic-dependent, not Breeze-hosted-only: a self-hoster with Anthropic credentials could use it; excluding them would be product policy. Non-Anthropic / BYO models get nothing.
- **Build.** Small if the SDK gap closes; moderate if we open a raw Messages API side-path (a second declaration of ~120 tools, a second pre-tool-use gate, second cost ledger, prompt-cache fragmentation, and the dual-surface drift a prior wave removed).

### O2 — Breeze-hosted code mode with tool access

Generate typed stubs from tool schemas; the model writes JS/TS/Python against them; Breeze runs it in a sandbox; every stub call is brokered **through the upstream pre-tool-use gate** (guardrails, RBAC, rate limit, then `executeTool`) with per-call tier resolution.

- **Preferred substrate.** Not a new runtime: the existing analysis workspace (`workspace_run`: no network, no device reach, run-owned artifacts) plus a chat-to-run bridge. O2 = O3b (below) + brokered tool access from inside the script. That addition is the genuinely new risk.
- **Benefit.** Works for every provider. Full control of approval semantics: approving the script is not blanket approval; each brokered call is tiered on its resolved action/input; a Tier 3 call yields a categorical intent ("restart `Spooler` on these 37 devices") approved once per run per action class, carried as a durable intent so the run can suspend past the interactive budget and resume from the release worker.
- **Cost.** Stub generation, broker, pause/resume protocol across the approval timeout, resource limits (CPU/time/memory/call count), output truncation, and a new audit shape (one run → many executions). Where it runs: in the API process (worst blast radius), in a worker (resumable; the analysis plane already lives here), or a separate container (most ops).
- **Risk.** Model-authored code with tool reach inside our trust boundary — the largest new attack surface the AI stack would take on; recurring security review. Broker must run under the caller's `withDbAccessContext`, apply site/device scope, and re-run every protection a direct call gets.

### O3b — Chat-to-analysis-run bridge (no tool access from the script)

Let chat hand a fleet question to an analysis run: `export_dataset` the relevant datasets, `workspace_run` a model-written script over them, return the aggregate (or a proposed frozen device set) to chat. The script has no tools, no network, no device reach.

- **Benefit.** Reuses an existing, reviewed sandbox and ownership model; works for every provider; the only new surface is the bridge (run creation from chat with the caller's authorization, which #6086 withdrew "until a run can preserve its caller's authorization" — Wisp's delegation ceiling work is the path). Covers open-ended *read* shapes O3's fixed aggregates cannot.
- **Cost.** Dataset coverage (`export_dataset` has a fixed dataset list); run-start latency; the bridge's authorization design. No savings on the *action* half of the workload; that still needs a frozen-set approval tool.
- **Risk.** Low-moderate; the dataset export must apply the same redaction contract as compaction.

### O3 — No sandbox: extend existing aggregate and flow tools

- Extend `get_fleet_device_stats` and siblings with filter and group-by dimensions (software, patch state, agent version, alert state), returning counts and a bounded sample; keyset pagination for the full set.
- Bulk action via **flows**, not a new generic `bulk_action`: a fleet-step flow takes a device filter, freezes membership at intent creation (`intentService.ts`, as `run_script { groupId }` does), shows count + sample + ids hash, and one approval covers exactly that set; the step's action tier applies; `run_flow`'s idempotency key and sensitive-step approvals carry over.
- `summarize_results`: given an execution or run id, return counts/outliers/failures rather than the raw list.

- **Benefit.** Cheapest; deterministic; zero new execution surface; aggregates computed in SQL under RLS + app-layer site/device scope are more trustworthy than model counting; approval flow unchanged in kind.
- **Cost.** Each new question shape is a schema change; the filter/aggregate expression surface costs tool-index bytes on every turn (`ai_tool_index_budget_policy`).
- **Risk.** Low, *provided* the bulk ceiling is not expanded casually (§3.1).

### 3.1 Bulk safety requirements (apply to any option that acts on a set)

Raising today's 10-device, org-only ceiling to hundreds is a large expansion of what one approval can do. Any such design must: freeze membership at intent creation, never in the handler; pin action parameters and the effect digest on the intent; preserve four-eyes/supervised classes (`TIER3_FOUR_EYES_ACTIONS`, `TIER3_SUPERVISED_ACTIONS`); re-validate authority and scope at execution (the release worker may run after the approver's reach changed); apply site/device scope in the resolver (RLS does not); define concurrency, cancellation, per-device retry and partial-completion reporting; keep partner-wide sets refused or supervised.

## 4. Side-by-side

| Criterion | O1 PTC | O2 code mode + tools | O3b analysis bridge | O3 aggregates + flows |
|---|---|---|---|---|
| Token savings on fleet reads | High (external ~37%) | High | High on exportable datasets | Medium–high on covered shapes |
| Savings on the action half | None (acts outside) | High if categorical grants built | None | High (one frozen-set approval) |
| Approval fidelity | Reads-only policy; 4-min script timeout vs durable intents | Strong if durable pause/resume built; most complex | N/A (no side effects) | Strong, unchanged in kind |
| Provider portability | Anthropic only | Full | Full | Full |
| Data residency | Intermediate data in Anthropic container, 30-day retention, no ZDR/HIPAA | In Breeze | In Breeze | In Breeze |
| Blast radius / review | Low on our side; new API surface | Highest | Low-moderate (bridge auth) | Lowest |
| Build cost | Low–moderate (blocked on E6) | High | Moderate | Low–moderate |
| Cache behaviour | Second surface fragments cache | Stubs add prompt bytes | Neutral | A few tool defs |
| Fits headless / Wisp | Awkward | Yes | Yes (already a run) | Yes |
| Determinism / audit | Code visible; results model-summarised | Code auditable; many executions per run | Code auditable | Fully deterministic SQL |

## 5. Evaluation criteria

1. Token savings on the motivating workload, measured (cached and uncached input separately).
2. Approval fidelity: every brokered call is classified on its resolved action and input and, when Tier 3, produces a durable intent — the same path a direct call takes.
3. Provider portability and self-hoster parity.
4. Blast radius and recurring security review cost.
5. Build cost in waves, including follow-on drift of any second surface.
6. Cache behaviour: no option may knock the chat prompt out of cache.
7. Data residency: intermediate fleet data stays in Breeze unless Todd accepts otherwise.

## 6. Evidence needed

From the discovery telemetry defined in `2026-11-08-ai-tool-examples-and-discovery-telemetry-spec.md`; this document asks that spec to emit E1–E4. Attribution is **question-level**: a "question" is a user turn plus every model turn and tool call until the next user turn; fleet-shaped questions are tagged by the shape catalogue (E2). Minimum sample: 200 fleet-shaped questions across ≥10 orgs on managed deployments before any gate is read; report p50/p90/max, not means.

| # | Evidence | Picks between | Source |
|---|---|---|---|
| E1 | Per question: tool-call count, **sequential dependency depth** (longest chain of calls where one's input came from another's output), distinct devices touched. | Is there a problem | Tool ledger + per-turn grouping |
| E2 | Shape catalogue: top fleet shapes (filter fields, aggregate wanted, action taken) in questions with depth ≥3. | O3 sufficient vs O3b/O2 | Discovery events + flagged-chat review |
| E3 | Token share: replayed tool-result input vs system/tool index, cached vs uncached, in high-depth questions. | Savings ceiling | Proxy harness (baseline §1) extended to multi-turn |
| E4 | Approval density: how often a fleet question ends in a Tier 2/3 action, on how many devices, and how often the approver edited the set. | Weight of the action half; bulk-ceiling question | Intent rows + ledger |
| E5 | Provider mix: share of questions on non-Anthropic / BYO models. | Weight of portability | Model registry usage |
| E6 | SDK/MCP gap: does the Agent SDK expose `allowed_callers` for `createSdkMcpServer` tools? | O1 viable in-architecture | SDK changelog each release |
| E7 | Accuracy/completeness: for a sample of fleet questions, compare the model's stated count with the SQL truth. | Quality case for server-side aggregation | Flagged-chat review |
| E8 | Latency: wall time per fleet question vs depth. | Whether depth, not tokens, is the felt cost | Session timings |

Decision rule: E1 p90 depth ≥3 and E2 ≥70% of fleet questions in ≤5 shapes → O3 aggregates first. E2 long tail >30% → O3b. E4 shows frequent multi-device actions with approvers rarely editing the set → design the bulk flow with a raised ceiling (OD4); approvers often editing → keep the small ceiling and a review step. E6 closes → O1 read-only spike.

## 7. Recommendation

**Extend existing aggregates and fleet-step flows now (low risk, no ceiling change); gate any new bulk ceiling on E1/E2/E4; O3b as the open-ended read path when E2 shows a long tail; O1 as a bounded read-only spike only when E6 closes and the data-handling question is settled; O2 only if O3+O3b are measured insufficient.**

- O3's fidelity gain (one countable frozen set) is real but is not a reason to ship a generic 500-device `bulk_action` ahead of evidence: it is a 50× expansion of what one approval does. The reviewer's objection stands and the earlier "start `bulk_action` now" is withdrawn. What can start now is the zero-risk half: richer `get_fleet_device_stats` dimensions and a fleet-step flow that uses the *existing* ceiling.
- O1's incompatibility is narrower than first stated (connector, not MCP), but the in-architecture question (E6) is unchanged, the data-handling posture (no ZDR/HIPAA, 30-day retention of intermediate fleet data) is a new and possibly decisive risk, and a raw-API side-path reopens the drift a prior wave removed. Watch item, not a build.
- O2 should be designed as "O3b plus brokered tools," never as a new runtime. The durable pause/resume it needs is the same protocol Wisp's outbox needs; design it once, there.
- **Triggers.** Start aggregate/flow extension now. Read gates at 200 fleet-shaped questions or 30 days. Open O3b when E2's long tail >30% or the bridge authorization lands with Wisp delegation. Open O1 spike when E6 closes and OD2 is yes. Open O2 when O3+O3b have shipped and two consecutive shape requests cannot be met by either.

## 8. Open decisions for Todd

- **OD1 — What starts before telemetry?** (a) Nothing; wait for E1/E2. (b) Extend `get_fleet_device_stats` dimensions and add a fleet-step flow at the existing 10-device ceiling; gate any new bulk ceiling on E1/E2/E4. **Recommend (b).**
- **OD2 — Is a raw Messages API side-path for O1 acceptable, and is PTC's data handling (Anthropic container, 30-day retention, no ZDR/HIPAA) acceptable for fleet data?** **Recommend no on both** until E6 is known; if yes later, read-only tools, hosted-Anthropic credentials only.
- **OD3 — O3 expression surface.** (a) Fixed named dimensions per aggregate tool. (b) A small typed filter/group-by schema shared across fleet tools. **Recommend (b)**, capped by the tool-index byte budget.
- **OD4 — Bulk ceiling.** Keep `RUN_SCRIPT_AI_MAX_DEVICES = 10` for AI-initiated sets, or raise. **Recommend keep 10 until E4**; any raise is a flow-only path, org-scoped, partner-wide refused, with the §3.1 requirements, and justified by E4 numbers in its PR.
- **OD5 — If O2 opens, where it runs.** **Recommend the worker/analysis plane** (resumable across the approval budget; already isolated). Decide only when O2 opens.
- **OD6 — Portability rule.** Does any AI capability ship Anthropic-only? **Recommend: acceptable for read accelerators with no data-residency change; never for approval semantics or for anything that sends fleet data to a third-party container without consent.**

## 9. Sources

- Anthropic, "Advanced tool use" — https://www.anthropic.com/research/advanced-tool-use (37% average token reduction on complex research tasks)
- Anthropic docs, Programmatic tool calling — https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling (constraints, MCP-connector restriction, ~4-min pending-call timeout, container retention, ZDR/HIPAA eligibility)
- Anthropic docs, Tool search tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- MCP client best practices (2026-07-28), §Programmatic Tool Calling — https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices
- Repo (under `apps/api/src/`): `services/aiAgentSdk.ts`, `services/aiAgentSdkTools.ts`, `services/aiTools.ts`, `services/aiGuardrails.ts`, `services/aiApprovalTimeout.ts`, `services/aiToolOutput.ts`, `services/aiToolPagination.ts`, `services/aiToolsArtifacts.ts`, `services/aiToolsDevice.ts`, `services/aiToolsExport.ts`, `services/aiToolsFlows.ts`, `services/flows/fleetStep.ts`, `services/workspace/workspaceTools.ts`, `services/aiAgents/analysisProfile.ts`, `services/actionIntents/intentService.ts`, `services/actionIntents/runScriptGroupTarget.ts`, `config/env.ts`
- Repo specs: `2026-09-17-agent-tool-efficiency-baseline.md`, `2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md`, `2026-09-13-ai-agent-execution-plane-design.md`, `2026-09-30-ai-model-registry-design.md`, `2026-10-19-wisp-orchestrator-design.md`, `2026-11-06-small-model-tool-profiles-spec.md`, `2026-11-08-ai-tool-examples-and-discovery-telemetry-spec.md`
