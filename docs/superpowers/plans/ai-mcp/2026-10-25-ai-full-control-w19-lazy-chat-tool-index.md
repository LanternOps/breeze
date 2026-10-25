---
tracking_issue: LanternOps/breeze#6754
wave: W19 (#10065)
closes: "#10062"
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
branch: feature/6754-ai-full-control/wave-10065
---

# W19 — per-domain lazy chat tool index (#10065, closes #10062)

**Goal.** The in-app chat's always-on prompt lists domains, not tools. A domain's tool list goes into the prompt only when the page the chat opens on touches that domain. **Breeze's index text** then stops growing with the catalog, and W03 (#6757, +19 tools) and W04 (#6758, +19 tools) fit without raising a ceiling.

The total discovery context still grows with the catalog, because every tool name still reaches the model through the CLI (§1). This wave bounds the part Breeze controls.

Base: `origin/main` `dd2556224f` (W02 #9767 merged). Premise check P1–P7: pass (see the result file).

## 1. Evidence: how the model finds a tool today

**Q1/Q2 — index text or schemas, by host class.** Measured on the wire on 2026-10-24: chat surface, `tool-capture --tool-search on` through a proxy that dumps request bodies, prompt "Which backup jobs failed in the last 24 hours?".

- **First-party host with search on (hosted chat; the production default).** The request path is `routes/ai.ts` `toolSearch: true` → `resolveToolSearchPolicy` (`streamingSessionManager.ts:1293`) → `tools: ['ToolSearch']`.
  - `tools[]` carried 17 entries: `ToolSearch`, the 15 alwaysLoad schemas and a `DeferredToolPlaceholder`.
  - **`messages[1]` (role `system`, 8.7 KB) is the CLI's environment block followed by the alphabetical name of every deferred tool** (`mcp__breeze__get_huntress_incidents` … `mcp__breeze__workspace_stage`). This matches baseline §9.2.
  - The model ran ToolSearch and then called `query_backups`.
  - So every deferred tool's **name** already reaches the model outside our index, and `select:<name>` works without it. What the index adds there is domain grouping and inline action enums.
- **Full-list hosts.** These are `AI_TOOL_SEARCH=off`, any non-first-party `ANTHROPIC_BASE_URL` (self-host gateway or BYO provider), and sessions with fewer than 4 turns left (`aiToolSearchPolicy.ts:82`). Every one of the ~221 declared schemas is inline on every turn (`createBreezeMcpServer`, `aiAgentSdkTools.ts:4671`). The index is a routing aid only.
- **A-W04's reason for keeping the index** ("the names let the model `select:` a deferred tool", a04 plan line 36) no longer holds on either host class. The remaining risk is routing and action-selection quality. T3 measures it.

**Where the regression risk falls.** Hosted chat on a first-party host with search on. There the model loses the grouped, action-annotated catalog; it keeps the flat name list and gains vocabulary. On full-list hosts only redundant text is removed.

**Measured today.** `renderToolIndexByDomain(listChatSurfaceToolNames())`: 221 chat tools, 6,917 B. With the 38-tool W03/W04 fixture: 8,199 B. Per-domain line in bytes, including its note where one exists (today → with fixture); without the notes, scripts is 363 B and patching 337 → 423 B: core 91; devices 940 → 1,117; scripts 582; patching 486 → 572; monitoring 731 → 787; network 452 → 508; security 970 → 1,268; backup 433 → 959; tickets 345; billing 282; accounts 343; integrations 562 → 599; admin 260 → 306; ai 198.

**Page-context reach.** `buildSystemPrompt` runs:
- at session create (`aiAgent.ts:283`, stored in `ai_sessions.system_prompt`);
- on page-context turns (`aiAgentSdk.ts:614`).

But `streamingSessionManager` applies `systemPrompt` only when it **creates** the SDK query (`:1301`); a reused live query keeps its prompt. So page-context blocks reach the model at session/query creation, which is the same reach today's page-context lines have.

## 2. Options considered

- **(a) An explicit expansion tool (`list_domain_tools`).** First proposed, then **dropped** after the wire evidence (quorum round 2: AGREE).
  - Names are already visible, so its value is grouping only.
  - It would have to be a hook-bypassing bridge tool. The session `postToolUse` cannot be reused: it reads an unknown tool as tier 4, and its intent-completion block (`aiAgentSdk.ts` 2b-i) and `plan_step_complete` emission take session-wide pending state. So it needs its own persistence path.
  - Prompts stored under `lazy` would name a tool that `AI_TOOL_INDEX=full` no longer declares.
  - It would take the alwaysLoad cap from 15 to 16.
- **(b) Page-context block at `buildSystemPrompt` time.** **Chosen.** It is appended after the static prefix, so the cached prefix is shared unchanged across sessions.
- **(c) Rewriting the stored `session.systemPrompt` mid-session.** Rejected. It churns the cache, gives `resume` a second source of truth, and needs persisted expansion state, which the brief forbids as a column.
- **(d) A user-text → domain keyword table.** Rejected as a mechanism. ToolSearch already keyword-matches names and hints. A hand table duplicates it with false positives and upkeep. The always-on vocabulary is the cheap form: it gives the model search words.

## 3. Decisions

- **W19-D1 Always-on content** (`renderAlwaysOnIndex(names)`). It contains:
  - the standing heading `## Available Tools by Domain`;
  - one sentence, true on every host class and turn budget: "Tool names appear in the tool list or deferred-tool list; call loaded tools directly, or, when ToolSearch is available, load deferred tools by keywords or select:<exact-listed-name>.";
  - one line per domain present in `names`, in `AI_TOOL_DOMAINS` order: `- **<label>**: <vocabulary>`;
  - under each line, that domain's `DOMAIN_NOTES`, using the existing filter that drops sentences naming absent tools.

  The always-on text has no tool lists and no counts. Vocabulary is a closed static table, `DOMAIN_VOCABULARY`: plain words, never a registered tool name. It includes "CVEs" (#2605).
  - **Notes stay always-on** (quorum AGREE). The patching note ("empty report: no correlated findings, not no vulnerabilities") and the scripts note change how a *result* is read, so they must not depend on how the tool was discovered.
  - **alwaysLoad names are not listed.** Their schemas are inline on every host.
- **W19-D2 Per-domain block** (`renderDomainBlock(domain, names)`) is today's renderer line for that domain, byte for byte: no heading, no note.
  - `renderToolIndexByDomain` and `listToolIndex` keep today's output. They are used by the `full` mode, the systemCleanup pin and the restricted-index tests.
  - The union of blocks equals the legacy render's domain lines (B4).
- **W19-D3 Page-context table** (`PAGE_CONTEXT_TOOL_DOMAINS`, closed, in code, ≤ 2 domains):

  | page | domains | why |
  |---|---|---|
  | `device` | `devices`, `scripts` | Deferred device work: `analyze_disk_usage`, `disk_cleanup`, `analyze_boot_performance`, `manage_services`, `get_active_users`. Deferred script work: `run_script`, `get_script_execution`. Hot list (baseline §4): `get_device_details`, `analyze_metrics`, `disk_cleanup`, `execute_command`. `manage_patches` and the patching note are always-on. |
  | `alert` | `monitoring`, `devices` | The alert's tools (`get_incident_timeline`, `find_proven_fixes`, `list_remediation_suggestions`, `manage_alert_rules`) plus the device it fired on. |
  | `topology` | — | The prompt pins "only the topology read tools", and the turn runs its own restricted server (`routes/aiTopologyTurn.ts`). |
  | `dashboard`, `custom` | — | No single domain fits. Client strings (`custom.label`/`data`) never select a domain. |

  It is rendered by `renderPageContextToolBlocks(pageType, names)` as `### Tools for this page` plus the blocks. It is appended at the end of `## Current Page Context` in `buildSystemPrompt`, in lazy mode only. A navigation that reuses a live query does not refresh it (§1). That limitation is documented, not fixed.
- **W19-D4 No expansion tool, no explicit-mention keying** (§2a, §2d). The registry, `TOOL_TIERS`, `BREEZE_MCP_TOOL_NAMES`, the alwaysLoad set and cap, and `listChatSurfaceToolNames` are unchanged.
- **W19-D5 Flag `AI_TOOL_INDEX=lazy|full`.**
  - It is read at prompt-build time (`resolveToolIndexMode(process.env)`), never at module load. Matching is case-insensitive; any other value reads as `lazy`.
  - `full` gives the legacy index byte for byte (`renderToolIndexByDomain`) and no page-context blocks. The declared tool set is identical in both modes.
  - **Recommended default: `lazy`.** The structural goal only holds if the gated contract is the composition that ships.
  - **The default is Todd's call** (it changes chat behaviour). The PR ships `lazy`, with the switch documented in `.env.example`, both compose files and `environment.mdx`.
  - **Rollout limitation:** a flag change does not rewrite prompts already stored in `ai_sessions`. A live query keeps its prompt. A conversation picks up the new mode when its SDK query is next created (API restart, eviction, model switch) on a turn that carries page context, which rebuilds the prompt; otherwise it keeps the stored one. This is harmless in both directions, because no tool reference dangles.
- **W19-D6 Agents, Helper, MCP, script builder, topology are untouched.**
  - No registry, tier, exposure or catalog change.
  - Headless agents build their own prompt (`runnerPrompt.ts`).
  - MCP keeps native `tools/list`, `MCP_SERVER_INSTRUCTIONS`, `MCP_TOOL_COUNT_APPROX`, `FROZEN_GAPS` and the `mcp-server.mdx` tables.
- **W19-D7 The eval harness follows production.** `getCaptureSystemPrompt` → `composeStaticSystemPrompt`, which reads the mode. Scoring is unchanged: ToolSearch is still the only skipped call, and the 3/1 turn caps stay.

## 4. Bounds (contract in `aiToolIndex.test.ts`)

The simulated catalog is `[...listChatSurfaceToolNames(), ...FIXTURE_W03_W04]`. Each of the 38 fixture names is asserted to be registered and not already chat-declared.

| Bound | Statement | Value |
|---|---|---|
| B1 | always-on bytes < `ALWAYS_ON_INDEX_BUDGET_BYTES`, with the default env and with all flags on (M365, Google, script authoring, Flows, Wisp); **and** the lazy always-on render with the simulated catalog is byte-identical to the lazy render with today's catalog (Δ 0 B) | 2,560 B |
| B2 | for every domain, `renderDomainBlock(d, simulated)` < `DOMAIN_BLOCK_BUDGET_BYTES` | 2,048 B |
| B3 | for every page type: always-on + `renderPageContextToolBlocks(page, simulated)` < 7,040 B | 7,040 B |
| B4 | the union of domain blocks equals the legacy domain lines, so every chat-callable tool is listed exactly once; the env drift test (declared = advertised) runs over the union with flags off and on; the always-on text names no registered tool except those mentioned by its rendered notes, and every such name is declared (word-token check, so non-snake names like `recall` count too) | — |
| B5 | `AI_TOOL_INDEX=full` composes byte-identically to the legacy composition **for the same names**. There is **no byte ceiling** on `full`: it is a kill switch whose size grows with the catalog. The legacy 7,040 B ceiling is retired, and growth is governed by B1–B3 (the budget-history comment records this) | — |

## 5. Eval plan (T3)

- **Golden corpus, `origin/main` (detached worktree) vs this branch.** Arms: (i) `--tool-search default` (first-party; assert `toolSearchEnabled`), (ii) `--tool-search off`. Two runs per arm per tree if spend allows; stop at $60.
  - Gate: branch hits ≥ main − 2 in each arm.
  - Report: cases searched, mean API calls to the first real tool, mean context tokens at and through the first call, and every case lost or gained.
  - Deferred-only cases (where every acceptable tool is deferred under search) are reported separately.
- **Authored set** `toolEval/lazyIndexCases.ts` (`--suite lazy-index`). It is separate from `GOLDEN_CASES`, so the count pins hold. Each case runs the production `buildSystemPrompt` with a fixture page context (a non-UUID device id, so no DB read).
  - Cases: 3 device-page; 2 alert-page; 2 dashboard-page in an unexpanded domain (billing, backup); 1 always-on hot tool; 2 action-enum cases (the right action on a deferred multi-action tool).
  - It runs on the branch with `AI_TOOL_INDEX=lazy` against `full`, with equal caps. `full` is main's index plus the same page lines.
- **Capture:** one `tool-capture --surface chat --proxy --tool-search on|off` row per tree, for system bytes and turn-1 tokens.
- **As run (deviation).** The main arm is this branch with `AI_TOOL_INDEX=full`, not a detached main worktree. A scratch test proved its static prompt byte-identical to `origin/main`'s (sha256 `5138161a0739…`), and the declared tool set is unchanged. The eval CLI prices runs from `ai_platform_models` (it needs a migrated DB; the brief's unused `DATABASE_URL` no longer works), so it ran against a throwaway migrated Postgres container, removed afterwards. Results: baseline spec §13.

## 6. Quorum (`codex exec`, gpt-6-astra, xhigh, read-only)

**Round 1** on the expander design: AGREE-WITH-CHANGES. Taken:
- D3: page blocks apply at query creation only. Documented.
- D5: a lazy → full switch would strand a stored prompt naming the expander. Resolved by dropping the expander.
- B1: include the Wisp flags. Done.
- B4: the word-token check covers non-snake tools. Done.
- B5: a permanent `full` ceiling would block W03/W04. Replaced with an equivalence pin.
- Eval: both scorer layers needed changing for an expander (moot now), plus repeat runs and reporting deferred-only cases. Taken.

**Round 2**, after the wire evidence that the CLI lists every deferred name: **AGREE** with dropping the expander. Changes taken:
- the always-on sentence above (179 chars);
- narrowing the goal to Breeze's index cost;
- removing the expander scorer exception and the 4-turn cap;
- adding action-enum cases;
- asserting that search is actually on in arm (i);
- documenting the rollout limitation.

**Dissent for Todd.** None from the quorum. The deviation from the stated design ("or a first `list_<domain>_tools`-style call") is deliberate and evidence-driven (§2a). If Todd still wants the call, it is additive later.
