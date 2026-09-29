---
tracking_issue: LanternOps/breeze#6147
wave_issue: LanternOps/breeze#6151
branch: feature/6147-agent-tool-efficiency/wave-6151
---
# Agent tool efficiency A-W04: load policy per surface — plan and as-built record

**Status:** implemented 2026-09-28 in one PR (`Closes #6151`). This wave was replanned from a measured finding, so this doc records the decisions and the evidence rather than a task list.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md`, A-W04 row. Plan index: `2026-09-17-agent-tool-efficiency-and-mcp-modernization.md` (decisions D17–D22 below are mirrored there). Measurements: baseline doc §8.

## The finding that reshaped the wave

A-W01 measured that tool search "never activated, even when forced", and the 2026-09-20 quorum replanned A-W04 around per-surface `onlyTools` subsets plus a hand-built load mechanism (`list_tool_domains`/`load_tool_domain`). The cause was in Breeze, not the SDK. Every `query()` passed `tools: []` (`streamingSessionManager.ts`, `aiAgents/runLoop.ts`, `toolCapture/runSurface.ts`). That removes **all** CLI built-ins, including `ToolSearch`. The CLI (0.3.282) then logs `Tool search disabled: ToolSearchTool is not available` and sends every MCP tool non-deferred. With `tools: ['ToolSearch']`, a chat request carries only `ToolSearch` plus the `alwaysLoad` tools; the other ~190 are deferred and loaded on demand via `tool_reference`.

That makes the SDK's own mechanism usable again (spec principle 3), so the wave uses it for web chat. The hand-built domain loader and the page-context boost are not built.

## Decisions

- **D17 — One per-session policy decides tool search, written explicitly into the child env** (`services/aiToolSearchPolicy.ts`). `resolveToolSearchPolicy({ surfaceSearch, childEnv, remainingTurns, override })` returns `{ enabled, reason, tools, env }`. `query()` uses `tools: policy.tools` and `env: { ...childEnv, ...policy.env }`, so `ENABLE_TOOL_SEARCH` is always `true`/`false` and never inherited from the CLI's default. Rules, in order:
  1. A surface that did not opt in (`surface_static`) never searches, even when the operator forces it on.
  2. `AI_TOOL_SEARCH=off` means off (`operator_off`).
  3. If fewer than 4 turns remain, search is off (`low_turn_budget`), so a search can't spend a session's last turn.
  4. A first-party host searches (`first_party_host`). That means no `ANTHROPIC_BASE_URL` in the child env, or `api.anthropic.com`. It is judged on the env the child actually gets, so every `buildClaudeSdkChildEnv` branch (platform, direct partner key, catalog, self-host gateway) is covered.
  5. Any other host keeps today's full list (`non_first_party_host`), unless `AI_TOOL_SEARCH=on` (`operator_forced`) for a gateway known to forward `tool_reference`.
- **D18 — Only web chat opts in.** `getOrCreate(..., { toolSearch: true })` is passed only by the non-topology chat turn (`routes/ai.ts`). Helper, script builder, client AI, topology turns and headless agents all run static subsets and are unchanged or narrowed (D20, D21).
- **D19 — `alwaysLoad` = the `core` domain + the 10 production-hot tools + `propose_action_plan` (15).** The hot 10 come from the §4 90-day EU+US list (by call volume × size): `get_device_details`, `execute_command`, `search_logs`, `manage_patches`, `query_change_log`, `analyze_metrics`, `get_fleet_health`, `manage_alerts`, `get_security_posture`, `list_scripts`. `propose_action_plan` is always loaded because the approval-mode prompts tell the model to call it by name. Hot tools keep their semantic domain; `alwaysLoad` is a load decision, not a relabel. `aiTools.domainMetadata.contract.test.ts` pins the exact set, keeps every `core` tool always-loaded, and caps the total at 15. A change needs a golden-eval rerun, not just an edit.
- **D20 — Helper registers only its permission level's tools** (`onlyTools`, 9/15/21) through a `helperMcpServerFactory` in `routes/helper/index.ts`, the same pattern as topology turns. It resolves no tenant tools (none are in Helper's allowlist). Helper already recreates its SDK session every turn, so a level change applies on the next message. Tool search stays off (spec open decision 2 resolved: Helper stays on a static subset).
- **D21 — Headless agents unchanged.** They already register a profile subset, and they run on turn budgets with no eval. Enabling search there needs a representative agent eval first (follow-up). Measured 2026-09-28 (#7428, baseline doc §10): search cut a `full` run's context by ~45k tokens per turn but lost 1 of 19 agent golden tasks on average, all on deferred-domain tasks, so D21 stands.
- **D22 — `ToolSearch` stays out of Breeze's tool bookkeeping.** A `ToolSearch` `tool_use` never reaches the MCP pre/post hooks. If it entered `toolUseIdQueue`, it would misattribute the next `postToolUse` (FIFO), and its result would be recorded as a #3094 "rejected before execution" drop, which flags the session. `isSdkBuiltinToolUse` keeps it out of the queue, the `tool_use` transcript rows and the live tool cards. It remains in the assistant row's `contentBlocks`, which the web history renderer ignores except for topology blocks.

Not built, with reasons:
- **Page-context domain boost.** It is superseded by search. The SDK tool set is fixed for a session's life (2 h idle timeout, 24 h hard cap), so a creation-time boost goes stale after navigation. There is also no ticket page context.
- **BYO `list_tool_domains`/`load_tool_domain` fallback.** Non-first-party hosts keep today's full list (no regression), and operators can opt in with `AI_TOOL_SEARCH=on`. Whether a constrained proxy still needs domain loading is **deferred pending a BYO measurement**, not ruled out.
- **Tenant `extraTools` cache work.** They are already ordered by `qualifiedName`, appended last, and never `alwaysLoad`, so under search they are always deferred. A test pins this (`sdkBridge.test.ts`). Measuring the second-turn cache across differing tenant tool sets is a follow-up.
- **System-prompt tool index.** Kept, because the names let the model `select:` a deferred tool directly.

## Harness changes (so the eval measures production)

- `CaptureSurface.toolSearch` mirrors the production opt-in, and `runSurface` resolves `tools`/`ENABLE_TOOL_SEARCH` through the same `resolveToolSearchPolicy`. `--tool-search default|on|off` now stands in for the `AI_TOOL_SEARCH` override. A proxy run is a non-first-party host, so it needs `on` to search — the same rule a self-host gateway follows.
- Helper surfaces carry the real `onlyTools`. `agent-full` uses `fullRunToolExposure([])` (a read-only agent). It registers exposure ∩ declared, which is what production effectively registers (see follow-ups).
- The eval gives a searching run 3 turns: a 1-turn cap scored every searched case as "no tool call" (7.5% in the first probe). `ToolSearch` is never scored. The report adds `apiCallsToFirstTool`, `contextTokensToFirstTool` and `toolSearchEnabled`. The stream observer counts a response once per API message id (the CLI emits one assistant message per content block).

## Quorum

Opus position → Codex `gpt-6-astra` `xhigh` (2026-09-28): **CONFIRM WITH CHANGES** overall. D21, the page-boost drop and the kept index were confirmed as is. Changes folded in:
- The `ToolSearch` correlation blocker (D22).
- Policy derived from effective routing on every env branch, with surface exclusions surviving the override (D17).
- The final 15 evaluated rather than 14, with exact-membership plus ceiling assertions (D19).
- Bare `onlyTools` names for Helper, with the client-declared factory preserved (D20).
- The BYO drop reworded as deferred.
- Cumulative tokens to the first real tool reported.
- The low-turn-budget guard.

## Measurements (baseline doc §8)

Chat surface, `claude-sonnet-4-6`, 67 golden cases, three runs per arm on the final code:

| arm | first-call accuracy | context tokens, first call | context tokens through first real tool | mean TTFT |
|---|---|---|---|---|
| search off (today) | 25, 24, 25 / 67 | 82,707 | 82,707 | 2.25 s |
| search on (this wave) | 23, 23, 23 / 67 | 23,811 | ~31,000 | 1.86 s |

Helper first-turn context: 14.2k / 16.1k / 18.8k tokens (basic / standard / extended), against ~112k before.

**Accuracy is −1.5 cases (≈ −2 points).** Per-case diffing puts the whole loss on three org- or device-named prompts (g59, g60, g62). There, the model first resolves the named org or device through an always-loaded context tool (`list_organizations`, `query_devices`) before the domain tool. That is one extra call, not a wrong tool. The spec's "+10 points by end of A-W04" target is **not met**, and first-call accuracy did not improve in this wave.

## Follow-ups filed

- #7427: `fullRunToolExposure` names 7 undeclared tools, so every production `full` agent run logs a `createBreezeMcpServer` error (found while fixing the harness).
- #7428: measure tool search for headless agents before enabling it (D21).
- #7429: tool search on BYO/catalog endpoints (per-endpoint capability instead of the global switch), the deferred domain-loader question, and turn-2 cache behaviour with tenant tools.
