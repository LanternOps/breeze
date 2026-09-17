---
tracking_issue: LanternOps/breeze#6147
tracking_issue_feature_b: LanternOps/breeze#6154
---
# Agent Tool Efficiency and MCP Modernization — Program Design

**Date:** 2026-09-17 · **Status:** draft for approval · **Source issues:** #6139 #6140 #6141 #6143 #6144 #6145, prior art #4907 #3856 #2550

## Why

One tool registry (`apps/api/src/services/aiTools.ts`, ~206 tools across ~55 `aiTools*.ts` files) feeds two servers:

- **In-process SDK MCP server** (`createSdkMcpServer`, `aiAgentSdkTools.ts:3141`) used by Breeze's own agents through Agent SDK `query()` (`streamingSessionManager.ts:994`): web chat, Helper chat, AI-agent runs.
- **External HTTP MCP server** (`routes/mcpServer.ts`) used by Claude, ChatGPT, Cursor and API-key integrations.

A 2026-09-17 review found the registry has outgrown both. Verified on main `9fa3711df` unless marked *inferred*:

| Finding | Evidence |
|---|---|
| Web chat and Helper register the full registry every session; `allowedTools` only gates permission, it does not remove schemas | `streamingSessionManager.ts:984-1000`, docstring `aiAgentSdkTools.ts:1299-1312` |
| Headless agent profiles already send a true subset via `onlyTools` | `aiAgents/runLoop.ts:1866-1892` |
| Registry has no domain/category metadata; the only taxonomy is prose in the system prompt, which hand-lists ~150 tool names (~12.5 KB prompt) and restates tool descriptions | `aiTools.ts:104-154`, `aiAgentSystemPrompt.ts` |
| Every tool is declared twice (registry + Zod copy for the SDK), synced by a parity contract test | `aiAgentSdkTools.registryParity.contract.test.ts` |
| Agent SDK tool search (deferred schemas, `searchHint`, `alwaysLoad`) exists in the installed SDK (0.3.18x) and is documented as default-on for 4.5+ models; Breeze sets none of it and has never measured whether it is active — notably on BYO `ANTHROPIC_BASE_URL` endpoints, which may reject `tool_reference` blocks | grep: zero `searchHint`/`alwaysLoad`/`ENABLE_TOOL_SEARCH`; *behaviour inferred, must be measured* |
| No explicit prompt-cache breakpoints; per-org BYO-MCP `extraTools` are appended per request and can bust a tools-block cache | `streamingSessionManager.ts:998`, `toolSources/sdkBridge.ts` |
| Tool-output redactor replaces any key containing `session`/`token`/`credential`… with `"[REDACTED]"` — wipes `list_remote_sessions`, `get_active_users`, `query_c2c_connections` | #6140 |
| Per-tool usage telemetry already exists | `ai_tool_executions` (`db/schema/ai.ts:116-131`) |
| External server speaks MCP `2024-11-05`; current is `2026-07-28` | #6143 |
| Many shipped features have no tool surface; several tools write with no read-back | #6141, #6139 |

## Priority

**Breeze's own agents first.** Every wave is ordered by how much it improves tool selection accuracy, latency and credit cost for the in-product agents. External-MCP work reuses the same registry metadata and follows.

## Principles

1. **Measure before and after.** No wave lands without a token/latency/accuracy delta from the harness built in A-W01. "~45k tokens" is a source-text estimate, not a measurement.
2. **One source of truth.** Domain, search hint, always-load, MCP annotations, the system-prompt tool index and the coverage contract are all generated from registry metadata — never a second hand-maintained list.
3. **Use the platform's mechanism before inventing one.** Agent SDK tool search for our agents; authorization-scoped `tools/list` (explicitly allowed by spec `2026-07-28`) for external clients. No `run_tool` proxy.
4. **Tool never weaker than its route** (#6096/#6110). Subsetting is a context optimisation; authorization stays in the handler path.
5. **No write without read-back.** A `manage_*` action must have a read action that returns what it wrote.
6. **Never rename a tool.** Names are in client allowlists, audit rows, approvals and `ai_tool_executions`.

## Feature A — Agent tool efficiency (in-product agents)

| Wave | Scope | Blast radius |
|---|---|---|
| **A-W01 Baseline and harness** | (a) Request-capture harness per surface (web chat, Helper basic/standard/extended, agent `full` profile, script AI, one BYO `ANTHROPIC_BASE_URL` endpoint): tools sent, `input_tokens`, `cache_creation/read_input_tokens`, time-to-first-token, whether `tool_reference`/ToolSearch appears. Answers "is tool search already on, and where does it silently fall back or fail?". (b) Golden tool-selection eval: ~60 real MSP prompts → expected tool(+action), scored on first-call accuracy and calls-to-answer; runs in CI as non-blocking report. (c) Hot/cold tool report from `ai_tool_executions` (90 days, both regions — read-only SQL Todd runs or a platform-admin report endpoint). Output: a baseline doc committed next to this spec. | Low |
| **A-W02 Registry metadata** | Add `domain` (closed union, ~11 values + `core`), `searchHint`, `alwaysLoad` to `AiTool` and the SDK declaration; extend the parity contract test; new contract test: every tool has exactly one domain and a hint ≤ 120 chars. Generate the system prompt's "Available Tools by Domain" block from the registry (delete the hand list). Pass `searchHint`/`alwaysLoad` through `tool()`. | Low–medium (touches all tool files mechanically) |
| **A-W03 Description diet** | Lint in Test API: tool description ≤ 300 chars, param description ≤ 160, no workflow prose. Move long how-to text into `mcpGuidance` prompts + `search_documentation` content; keep disambiguation ("vulnerability vs posture vs patching") once, in the generated index. Frozen baseline of offenders shrinks to zero across the wave. Re-run A-W01 eval — accuracy must not drop. | Low |
| **A-W04 Load policy per surface** | Explicit `ENABLE_TOOL_SEARCH` policy instead of inherited default. `alwaysLoad` core set chosen from A-W01 telemetry (target ≤ 15). Helper switches from permission-only allowlist to real `onlyTools` subset (8–14 tools, no search needed). Web chat: page-context domain boost (device page → `devices`, `scripts`, `patching` always-loaded). BYO endpoints that reject tool search fall back to `onlyTools` by domain picked from page context + a `list_tool_domains`/`load_tool_domain` pair *only on that fallback path*. Tenant `extraTools`: deterministic order, registered last, deferred, so the core tools prefix stays cache-stable. | Medium (agent behaviour; credit cost) |
| **A-W05 Output efficiency** | Fix #6140 redactor first if not already landed (own PR, security-reviewed). Then: per-tool result shaping review for the 20 hottest tools, pagination params where results are truncated by the 8k cap, `resource_link`-style handles for large payloads (exports, logs), structured results. | Medium–high (#6140 loosens a secrets filter) |
| **A-W06 Coverage burn-down, agent-first** | From #6141, only the gaps in-product agents hit: time entries read (#6139), org contacts read, incident list, network asset list/detail, remediation suggestions, AI-agent reads, `list_sites`. Each new tool ships with domain + hint + read-back. Adds the `MCP_COVERAGE` route→tool contract test so the gap stops growing. | Per tool; tenancy-sensitive reads need route parity tests |

#6140 is a live bug and may be fixed ahead of the waves by an issue-fixer; A-W05 only assumes it is done.

## Feature B — External MCP server modernization

| Wave | Scope | Blast radius |
|---|---|---|
| **B-W01 Additive spec catch-up** (#6143 W1) | Version negotiation (`2024-11-05`, `2025-06-18`, `2025-11-25`), annotations + `title` generated from tier/`TIER3_ACTIONS` and A-W02 metadata, real `serverInfo.version`, deterministic order, `tools/list` pagination, `structuredContent` beside text, docs + `ai-agent` skill lead with Streamable HTTP. Per-version conformance contract test. | Low |
| **B-W02 Per-grant tool domains + scope UX** (#6144, #2550) | `mcp_domains` on API keys and OAuth grants (empty = all), consent-screen checkboxes, enforced in `tools/list` **and** `tools/call`. `WWW-Authenticate` gains `scope`; 403 `insufficient_scope` step-up. A `whoami`-style capability read so a client can learn its scopes/domains. | **High** — auth surface, migration, export-policy classification |
| **B-W03 Stateless `2026-07-28` dual-stack** (#6143 W2) | `server/discover`, per-request `_meta` version/capabilities, `resultType`, `ttlMs` + `cacheScope: "private"`, `Mcp-Method`/`Mcp-Name`; keep handshake + `Mcp-Session-Id` for older clients. CIMD beside DCR; confirm `iss` (RFC 9207). | **High** — session-ownership binding is an audit/abuse control |
| **B-W04 Tier-3 over MCP via action intents** (#4907, #3856 — existing plan `plans/open/2026-07-18-action-intents-mcp-cutover.md`) | Hard-deny → `createActionIntent(source: 'mcp_api')`, `get_action_status`/`cancel_action`. Presentation upgrades on the same intent row: URL-mode elicitation for clients that declare it (never form mode), Tasks handle for clients that declare Tasks. | **High** — re-opens remote execution over MCP |
| **B-W05 MCP Apps pilot** (#6145) | One `ui://` app with text fallback: alert triage board or timesheet review. Decide go/no-go for more from usage. | Medium |
| **B-W06 Tasks for long-running tools** (#6145) | Script runs, patch installs, DR executions, exports return task handles when the client declares the extension; existing polling tools stay. | Medium |

## Dependencies

```
A-W01 ─┬─> A-W02 ─┬─> A-W03 ──> A-W04
       │          ├─> B-W01 ──> B-W02 ──> B-W03 ──> B-W04 ──> B-W06
       │          └─> A-W06                          └──────> B-W05
       └─> A-W05 (after #6140)
```

A-W02 is the keystone: both features and the #6141 contract test consume its metadata.

## Open decisions

1. **Domain list.** Proposed: `core, devices, scripts, patching, monitoring, network, security, backup, psa, billing, cloud, admin, ai`. Closed union; adding one is a reviewed change.
2. **Tool search on Haiku surfaces.** If A-W01 shows Haiku 4.5 selects worse through search than from a static subset, Helper and triage profiles stay on `onlyTools`.
3. **Hot/cold telemetry access.** Read-only SQL run by Todd vs a platform-admin report endpoint (the latter is reusable for ongoing pruning).
4. **Advisor quorum.** Codex `xhigh` opinion on B-W02's grant shape and A-W04's BYO fallback is owed before those waves are planned (subscription exhausted until 2026-09-19).

## Success measures (from A-W01 baseline)

- Web chat first-turn input tokens: −60% or better; cache-read share of input ≥ 80% on turn 2+.
- Golden eval first-call accuracy: no regression in any wave; +10 points by end of A-W04.
- System prompt ≤ 6 KB with zero hand-maintained tool names.
- External `tools/list` for a single-domain grant ≤ 25% of today's bytes.
- Zero REST route modules without a `MCP_COVERAGE` entry.

## Out of scope

Renaming tools; a `run_tool` proxy; MCP Sampling/Roots/Logging (deprecated); Skills over MCP until a Claude client supports it; tool-calling on the OpenAI-compatible chat-only path.

## Planning

Per-wave implementation plans are written when the wave is next, because A-W01's measurements decide A-W04's shape and the `alwaysLoad` set. A-W01 and A-W02 plans are written first.
