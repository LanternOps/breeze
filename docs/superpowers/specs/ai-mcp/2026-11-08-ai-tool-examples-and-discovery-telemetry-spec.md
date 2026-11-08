---
status: draft (spec-drafted, one independent review round applied 2026-11-08 — AGREE WITH CHANGES on the AI_TOOL_EXAMPLES bridge and the session-keyed table; 14 corrections folded into §1, §3, §4, §7, §8). Awaiting Todd's Gate A on the Open Decisions in §6. Quorum: the independent review round was a Codex gpt-6-astra xhigh read-only pass covering OD1/OD2/OD3.
date: 2026-11-08
tracking_issue: TBD (register after Gate A)
covers: "tool-use input examples on the Breeze AI tool registry; tool-discovery telemetry (ToolSearch queries, results, calls, outcomes) that measures them and feeds description/searchHint tuning and the eval harness"
sibling: 2026-11-08-programmatic-tool-calling-decision.md (asks this spec for its E1 fan-out and E2 shape-catalogue numbers)
related: "2026-09-17-agent-tool-efficiency-baseline.md (§10 search cost/accuracy on headless agents), 2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md (A-W02 searchHint, A-W04 ToolSearch), 2026-11-06-small-model-tool-profiles-spec.md (compactSchemas strips advisory keywords; exposure fingerprint), #6151, #10400, #10411, #10065 (W19 lazy index), #7429 (tool search on BYO endpoints), #3094 (dropped -32602 calls)"
---

# Tool-use input examples and tool-discovery telemetry

**Scope:** the AI tool registry (`apps/api/src/services/aiTools*.ts`, `aiToolSchemas*.ts`, `aiAgentSdkTools.ts`), the chat stream (`streamingSessionManager.ts`), the tool ledger (`ai_tool_executions`), the eval harness (`services/llm/toolCapture/**`, `services/llm/toolEval/**`, `ai:tool-eval`) and one admin read surface. Two coupled parts: (1) examples attached to tool definitions, (2) telemetry that shows whether tools are found and called correctly, so (1) and the existing `searchHint`/description text can be tuned on evidence. This document records intent and decisions. It contains no plan and no code.

**Evidence:** "verified" means re-read on `origin/main` at `127bb8b543` (2026-11-08), or in the installed packages of the main checkout (`@anthropic-ai/claude-agent-sdk` 0.3.288, `@anthropic-ai/sdk` 0.131.0; `apps/api/package.json` pins `^0.3.296` / `^0.133.0`, not installed here). "Inferred" follows from the code but was not exercised. "Reported" is a number from Anthropic's published material, not measured by us.

## 1. Problem

Web chat registers ~360 tools through an in-process MCP server (`createBreezeMcpServer`, `aiAgentSdkTools.ts:6039`) and, on a first-party host, defers all but a small `alwaysLoad` core behind the Agent SDK's `ToolSearch` built-in (`aiToolSearchPolicy.ts`). Two things are unmeasured and one is unused:

1. **Parameter accuracy is unmeasured.** Action-enum tools (`manage_alerts`, `manage_ticket_checklist`, `file_operations`, `manage_services`, …) and tools with many optionals or nested arrays (`run_script`, `query_devices` filters, `propose_script`) fail at the input boundary in two ways we only see indirectly: a Zod refusal from `validateToolInput` (`aiToolSchemas.ts:2774`, recorded since #10411 as `status = 'refused'` with the message in `error_message`), or an SDK `-32602` rejection that never reaches our hooks and is only reconstructed as a dropped tool_result (`streamingSessionManager.ts:1994-2020`, #3094). Nothing counts either per tool.
2. **Discovery is unmeasured in production.** The ToolSearch `tool_use` block and its `tool_reference` results are visible in the SDK stream (the eval harness already folds them: `llm/toolCapture/streamObserver.ts`), but the chat path deliberately drops them from the tool rows and cards (`streamingSessionManager.ts:1798-1801`, `:1949-1951`, A-W04) and keeps only a per-turn work/search tally for the turn budget (`RoundTripTally`, #10400). We do not know which queries users' words produce, which tools surface, which of those are then called, or how often a search returns nothing. Baseline §10 showed search can shift the model from a domain-first call to "generic read + search" (verified on captures, headless agents); we have no equivalent number for chat.
3. **Tool-use examples are unused.** Anthropic reports that `input_examples` on a tool definition raised complex-parameter accuracy from 72% to 90% internally (reported; "Advanced tool use", https://www.anthropic.com/research/advanced-tool-use). The guidance: 1–5 realistic examples per tool, varying minimal/partial/full, only where correct usage is not obvious from the schema; with deferred tools the examples arrive on discovery, so they cost nothing until the tool is loaded. The installed `@anthropic-ai/sdk` 0.131.0 types `input_examples` on the Messages tool definition (`resources/messages/messages.d.ts:1913`, verified). The Agent SDK 0.3.288's tool-search-relevant MCP `_meta` keys are `anthropic/searchHint`, `anthropic/alwaysLoad`, `anthropic/maxResultSizeChars` and `anthropic/requiresUserInteraction` (it also reads `anthropic/permissionDisplay` for permission prompts, `sdk.d.ts:731`, unrelated here), and it contains no `input_examples` plumbing anywhere in its JS or native binary (verified by grep/strings). **Examples cannot reach the model through our MCP server today.** That gap is OD1.

Verified facts that shape the design:

- The registry entry is the single source for tool metadata: `AiTool { definition: Anthropic.Tool; tier; domain; searchHint (≤120 chars, "synonyms, not workflow"); alwaysLoad? }` (`aiTools.ts:192-200`). `attachRegistryMeta` re-declares each SDK tool with `searchHint`/`alwaysLoad` via `tool()`'s extras (`aiAgentSdkTools.ts:5989`); `aiAgentSdkTools.serverMeta.test.ts` pins the `searchHint` passthrough only (`:43`), not `alwaysLoad`.
- Three schema surfaces exist per tool: the JSON `input_schema` on `definition`, the Zod schema in `toolInputSchemas` (enforcement), and the Zod shape passed to `tool()` in `aiAgentSdkTools.ts` (what the SDK advertises). `aiAgentSdkTools.registryParity.contract.test.ts` keeps names/tiers aligned.
- The SDK's ToolSearch takes `{ query: string, max_results?: number = 5 }` (also `select:<tool_name>` for direct loads) and returns `{ matches, query, total_deferred_tools, pending_mcp_servers }`; the model sees the loaded definitions as `tool_reference` blocks in the next user message (verified in the 0.3.288 binary and `streamObserver.ts`). It matches names, descriptions and argument names/descriptions (Anthropic tool-search docs, https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).
- `ai_tool_executions` has no `org_id`; it is an FK-child of `ai_sessions` with `EXISTS`-join RLS policies (`migrations/2026-05-30-fk-child-tables-rls.sql:97-118`), `status` ∈ pending/approved/executing/completed/failed/rejected/refused, and it is deleted explicitly by the topology session deleter (`topology/siteTopologySessions.ts:56`) and scrubbed by `jobs/aiToolOutputRetention.ts` (tombstone, rows kept).
- Chat tool-index byte budget (W15–W19): always-on index `B1 < 2,560 B` (currently 2,551), each domain block `< 2,048 B`, per-turn total `< 7,040 B` with a 7,680 B hard cap and `+128 B` per wave if exceeded (`aiToolIndex.w16-budget.test.ts`, `w15`, `w18`). Examples are not rendered in the index, so they do not count against it (§3.3).
- The eval harness scores first-call tool selection (`ai:tool-eval`, suites chat/agent/lazy-index; `scoreFirstCall`), and `ai:tool-capture` records real surfaces. Neither scores input validity.
- `prom-client` is already a dependency (`extensions/metrics.ts`); PostHog is not in `apps/api` (verified).

## 2. Goals and non-goals

**Goals**

- G1. One declared source of input examples per tool, generated into every surface that can carry them, validated by contract against the enforcement schema.
- G2. Examples only where they pay: action-enum tools, many-optional/nested tools, look-alike pairs. Zero bytes added to the always-on prompt index; a pinned, small budget for the `alwaysLoad` core.
- G3. Production telemetry for discovery: per search — query, results, which results were called, empty results; per turn — searches before the first real call; per call — how it was discovered and how it ended (completed / failed / rejected by a human / refused by a gate / schema-invalid).
- G4. A store that respects the tenancy contract with the least new surface, a retention rule, and an operator-readable view plus a periodic report.
- G5. A closed loop: the report names tools whose descriptions/`searchHint` miss users' words, produces golden-case candidates for the eval harness, and the harness gains a schema-validity score so examples are evaluated before and after.
- G6. Give the sibling decision its E1 (calls and distinct devices per session) and E2 (shapes of ≥10-call sessions) numbers from the same data.

**Non-goals**

- Changing the tool set, renaming tools, or merging look-alikes (the telemetry may recommend it; a separate PR does it).
- Re-ranking or replacing the SDK's search (BM25/regex is Anthropic's; our lever is the text it indexes).
- Tool search on OpenAI-compatible gateways (#7429) or `tool_reference` translation.
- Examples for tenant/extension tools and headless outcome tools (`extraTools`); they are outside `aiTools`.
- Any third-party analytics egress.

## 3. Design

### 3.1 Examples live on the registry entry

Add to `AiTool`:

```
inputExamples?: readonly ToolInputExample[]   // 1–5 entries, Anthropic's guidance
ToolInputExample = { shape?: 'minimal' | 'partial' | 'full'; note?: string /* ≤ 80 chars */; input: Record<string, unknown> }
```

Declared beside `searchHint` in the domain file that registers the tool (`aiToolsDevices.ts`, `aiToolsScripts.ts`, …), never in `aiAgentSdkTools.ts` and never in `aiToolSchemas*.ts`. The `note` is the one-line "when" (e.g. "restart by display name on one device"); the `input` is the literal call. `shape` is advisory (it is not required to be distinct; an action-enum tool may carry five `full` examples). Placeholder identifiers use a fixed documented form (`00000000-0000-4000-8000-00000000000N`, hostnames `ws-01`, `site-a`); real tenant values, customer names and internal hostnames are forbidden and a contract test rejects any UUID outside the placeholder range.

**Selection criteria.** The cap of five cannot cover every escalated action: `TIER3_ACTIONS` has 76 tool entries and 219 actions (verified, `aiGuardrails.ts:516-770`); seven tools have more than five (`manage_ticket_config` 12, `manage_billing_profiles` 9, four with 7, `manage_ticket_checklist_templates` 6, `file_operations` 5). So the contract is **one example per distinct required-field shape** (actions whose required fields coincide share one example), capped at five, with the remaining slots given to the actions the telemetry shows failing most. The plan lists the wave-1 set explicitly and a test pins it; the rule for later waves is:

1. Tools with an `action` enum whose actions have different required fields, prioritising actions that `aiGuardrails` escalates (`TIER3_ACTIONS`), because those are the calls a human reviews and a malformed one wastes an approval.
2. Tools with ≥ 4 optional fields, or any nested object/array field (`run_script` with `deviceIds` vs `groupId`, `query_devices` filters, `propose_script`, `analyze_metrics`).
3. Look-alike pairs: one example each that shows the distinguishing field (`query_devices` vs `get_device_details`; `manage_alerts list` vs `get_*`).
4. Tools with a known production failure mode: `set_device_context` (#3094 parenthesised `details`), and any tool the telemetry (§3.4) shows with a schema-invalid rate above the fleet median for two consecutive weeks.

Excluded: single-argument tools (`{ deviceId }`), tools whose schema is one enum, and `HUMAN_ONLY_TOOLS`.

**Wave 1 (explicit, 10 tools):** the endpoint-execution action tools in `TIER3_ACTIONS` — `file_operations` (5 escalated actions), `manage_services` (3), `manage_scheduled_tasks` (3), `system_cleanup` (2), `browse_device_event_log` (2), `manage_processes` (1) — plus `run_script` and `execute_command` (base tier 3, nested/optional-heavy), `manage_alerts` (look-alike with the `get_*` reads) and `set_device_context` (#3094). At most 50 examples, ≤ 15 KB of definition bytes in total, all on deferred tools except `set_device_context`. Later waves are chosen by the §3.4 schema-invalid rate, not by walking the remaining 66 `TIER3_ACTIONS` tools in order.

### 3.2 One source, generated into every surface

| Surface | How examples ride | Status |
|---|---|---|
| `definition` (Anthropic.Tool JSON) | `definition.input_examples` set at registration from `inputExamples` | Direct: the Messages type already carries it (verified). Used by any path that sends raw `Anthropic.Tool` definitions. |
| Agent SDK MCP tools (`attachRegistryMeta`) | `tool(..., { searchHint, alwaysLoad, ...examplesExtra })` | **Blocked**: no `_meta` key or extra is read by 0.3.288 (verified). OD1 decides the bridge. |
| Zod schemas (`toolInputSchemas`, SDK shapes) | Not generated into; used as the **oracle** | The contract test (§7) parses every example with `toolInputSchemas[name]` and with `z.object(sdkShape)`, and asserts example keys ⊆ shape keys. |
| Breeze's external MCP server (`mcpToolExecutionLedger.ts` path) | `tools/list` `_meta['anthropic/inputExamples']` or `input_examples` passthrough | Follow-up; the registry field makes it a one-line change. Not in v1. |
| OpenAI-compatible gateway | no equivalent field in function schemas | Dropped by the translator. Constrained profiles already strip advisory keywords (sibling spec §3.4); `full` profile may use the description suffix of OD1-B. OD8. |

**Bridge while the SDK lacks plumbing (OD1).** The fallback is a bounded, generated suffix on the advertised description: `\n\nExamples:\n- <note>: <compact JSON>` for each example, applied in `attachRegistryMeta` only (the registry `definition.description` is untouched, so the prompt index and `searchHint` are unaffected). It is gated by `AI_TOOL_EXAMPLES` (`auto` | `off`; `auto` = native when the SDK supports it, suffix otherwise), and it is removed when a native path exists. A spike (plan task 0) confirms on `^0.3.296` whether `tool()` or `_meta` now carries examples; if not, we file the request upstream and ship the suffix. The suffix is never applied under a constrained profile (`compactSchemas`, sibling spec), where every advisory byte is stripped.

### 3.3 Byte impact and the index budget

- **Prompt index:** unchanged by construction. Examples are not rendered by `renderAlwaysOnIndex`, `renderDomainBlock` or `renderPageContextToolBlocks`; the W15–W19 tests stay byte-identical (`B1 = 2,551`) and are the regression guard. The 7,680 B cap is a cap on the index, and examples ride on tool definitions, not on the index.
- **Deferred tools (the ~95% that are not `alwaysLoad`), when search is on:** examples cost nothing until a search loads the tool; then they arrive once with the definition, in that turn's `tool_reference` content. This is the case Anthropic's guidance targets.
- **When search is off, every example is in the prefix.** `resolveToolSearchPolicy` returns `tools: []` for static surfaces, `AI_TOOL_SEARCH=off`, a low turn budget and non-first-party hosts (`aiToolSearchPolicy.ts:82-88`), and the CLI then sends every registered definition non-deferred. In those modes the "deferred" saving does not exist and wave-1's ≤ 15 KB lands in every turn's cached prefix. Mitigation: the description suffix (OD1-C) is applied only when the resolved policy has search enabled, or when the tool is in the OD6 list and the surface is `chat` with `full` profile; helper, script builder, headless runs and gateway hosts get no suffix in v1 (they run their own `onlyTools` subsets and the bytes are proportionally larger there). Native `input_examples`, once available, follow the same rule.
- **`alwaysLoad` core:** every example byte enters the static tool prefix of every turn. It is written to the cache once per prefix change and read at cache-read rates afterwards, but it moves the prefix for every session on every deploy that edits an example. Trade-off stated: a core example earns its place only for a known failure mode (§3.1 rule 4; `set_device_context`). Budget: **≤ 1,024 B total** across core tools, pinned by a test (OD7). Each example ≤ 300 B; each tool's examples ≤ 900 B.
- **Template cache identity.** The per-process declaration template is keyed by `toolSurfaceGateKey()` (`aiAgentSdkTools.ts:1623`), and `attachRegistryMeta` results are memoised per declaration. The examples mode (`AI_TOOL_EXAMPLES`) and the search-enabled bit must join that key, and the memo must be keyed on (declaration, mode), or a flipped switch keeps serving the old descriptions until restart. `aiAgentSdkTools.templateCache.test.ts` flips each gate; the new inputs are added there.
- **Fingerprint:** the registry exposes `TOOL_SURFACE_FINGERPRINT` = hash of (names, advertised schemas, descriptions-as-advertised including any suffix, examples, examples mode, search policy). It is recorded on every discovery event (§3.4) so before/after comparisons are keyed to what the model actually saw. It aligns with the sibling spec's exposure fingerprint and should be the same function when both land.

### 3.4 Telemetry: what is captured

All capture is in the chat stream, where the SDK messages already flow (`streamingSessionManager.ts`). A pure module `aiToolDiscoveryObserver.ts` is built from `streamObserver.ts`'s content walk so production and the eval harness share one definition of "a search", "a result" and "a call". The existing walk is **not sufficient on its own** (verified, `streamObserver.ts:60-80`): it counts `ToolSearch` uses and `tool_search_tool_result` blocks and collects `tool_reference.tool_name`, but it keeps no query text, no `tool_use_id` correlation and no totals. The observer therefore also reads the `ToolSearch` tool_use `input` (`{ query, max_results }`, verified in the 0.3.288 binary) and pairs it with the `tool_result` by `tool_use_id`. Whether `total_deferred_tools` / `pending_mcp_servers` are observable at all is open: the structured output lives in the CLI's internal result and may only surface via `SDKUserMessage.tool_use_result` (`sdk.d.ts:6235`, typed `unknown`). **Plan task 0b captures real fixtures with `ai:tool-capture`** and fixes the field list from what is actually present; totals are best-effort columns that stay NULL when absent. Nothing is added to the hot MCP handler path.

**Per search** (one event per `ToolSearch` tool_use, matched to its tool_result by `tool_use_id`): `query`, `max_results`, `select_mode` (query began with `select:`), result tool names, `total_deferred_tools` (nullable), `empty` (no matches), the API round-trip id (`message.id`), a durable **turn id** (the turn's `ai_messages` user row id, which exists before the SDK query starts), the surface (`chat` / `office_chat` / Wisp grant present), `TOOL_SURFACE_FINGERPRINT`, and `called_within_turn`: the subset of results called before the turn's `result` message.

**Per turn** (stored, one row per turn including zero-search turns, so denominators exist): `searches`, `search_only_round_trips`, `work_round_trips` from `RoundTripTally` (#10400; persisted at `result` instead of discarded), `first_call_after_searches`, and the turn id. Stored on the same table with `kind = 'turn'` rather than a second table (§3.5).

**Per tool call** (`ai_tool_executions`, existing row): a new scalar `discovery` ∈ `always_loaded` | `searched_this_turn` | `loaded_earlier` | `unknown`, set by the post-tool hook from the observer's per-session set of loaded names. `loaded_earlier` is the SDK's session-sticky load; `unknown` is a non-chat surface. **Outcome** stays in `status` (`completed`, `failed`, `rejected` = human denied/expired, `refused` = platform gate, #10411).

**Reconciliation by tool-use id.** The MCP handler can finish before the stream's `content_block_start` arrives (`streamingSessionManager.ts:1808`, #7931), so `discovery` cannot be read from stream order. The observer keeps a per-session map `tool_use_id → { loadedBy: 'core' | searchEventId | 'earlier' }` populated from `tool_reference` results as they arrive; the post-tool hook stamps `discovery` from it, and a late result reconciles by `tool_use_id` (the same key `aiChatRefusalLedger.ts` pairs on). Rules: a session **resume** replays user messages — replayed `tool_reference` blocks predate this process and only seed the "loaded earlier" set, never new events (keyed by `message.id` already seen, as `RoundTripTally` does); an **aborted** turn still flushes its turn row with `aborted = true`; events are written once per turn, after `result`, so a crash mid-turn loses that turn's events and nothing else.

**Schema-invalid** has two sources with two homes, so it is derived at report time with explicit joins, not stored:

| Source | Where it lives | Join and dedup |
|---|---|---|
| Pre-hook Zod refusal (`validateToolInput`) | `ai_tool_executions` row, `status = 'refused'`, `error_message` begins `Invalid input:` — written by the pre hook (#10411); the post hook leaves it untouched (`aiAgentSdk.ts:3588`) | One row per call; counted once. |
| SDK `-32602` rejection before dispatch (#3094) | **no** `ai_tool_executions` row; an error tool_result is persisted into `ai_messages` (`streamingSessionManager.ts:2522`) | Joined by `tool_use_id` inside the message's `content_blocks`; the report scans the turn's `ai_messages` rows. A `-32602` with a matching execution row (should not happen) is counted once, under the execution row. |

Denominator: all tool calls the model emitted in the window = execution rows (any status) + dropped-call results with no execution row. Per-tool rate = (Zod refusals + `-32602` drops) / that denominator. Attribution to `discovery` for a `-32602` drop uses the observer map by `tool_use_id`. If the `ai_messages` scan is too slow or lossy in practice, a `failure_class` column on a new execution row for dropped calls is the follow-up (OD5).

**Sibling numbers:** E1 (calls per session, distinct `deviceId` values across inputs) and E2 (filter fields, action, aggregate in ≥10-call sessions) are computed from `ai_tool_executions` by the report (§3.6); the only new input they need is the per-call `discovery` attribution.

What is **not** captured: tool outputs (already ledgered and retention-scrubbed), the user's message text, the model's prose.

### 3.5 Store

Options evaluated against `docs/agents/tenancy-rls.md`:

| Option | Tenancy | Verdict |
|---|---|---|
| A. New table `ai_tool_search_events` (session-keyed FK-child, like `ai_tool_executions`) + prom counters | No `org_id`; the generalised parent-FK-join shape: RLS by `EXISTS` join to `ai_sessions` for **all four** commands **in the creating migration** (precedent `2026-05-30-fk-child-tables-rls.sql:97-118`), registered in `PARENT_FK_JOIN_POLICY_TABLES` (`__tests__/integration/rls-coverage.integration.test.ts:1254` lists `ai_tool_executions → ai_sessions`); cascades via `session_id ON DELETE CASCADE`; org erasure and merge reach it through `ai_sessions`, which is registered, so no direct `CORE_ORG_CASCADE_DELETE_ORDER` / `orgMergeRegistry` / export entry. Must be added to the retention job. | **Recommended (OD2).** Queries are users' words and can name customers or hosts, so they are tenant data and need RLS and retention. |
| B. Columns only on `ai_tool_executions` | Cheapest, but a search that yields no call has no row to hang on, and misses are the point. | Rejected alone; the `discovery` column is kept. |
| C. prom-client + Redis daily counters only | No tenancy, no retention, cross-replica OK. No query text, so nothing to tune descriptions with. Cardinality: ~360 tools × 5 statuses × 4 discovery ≈ 7k series; too many for the default registry. | Kept as a **small** ops layer: `breeze_ai_tool_search_total{outcome=hit\|empty}`, `breeze_ai_tool_call_total{status}`, no per-tool label. |
| D. PostHog events | New dependency; query text leaves the instance; self-hosters opt out by default. | Rejected. |
| E. Denormalised `org_id` on the new table (shape 1) | Simpler policies, but it is a cold table and every `org_id` table must join the three registries. | Rejected for v1; revisit if the EXISTS join shows in query plans. |

**Table (A):** `id`, `session_id` (FK, cascade), `turn_message_id` (FK to the turn's `ai_messages` user row, set null), `kind` (`search` | `turn`), `tool_use_id`, `round_trip_id`, `surface` (text), `surface_fingerprint`, `query` (text, ≤ 1,024 B, truncated with a marker), `max_results`, `select_mode`, `result_tool_names` (text[]), `called_tool_names` (text[]), `total_deferred` (nullable), `empty` (bool), per-turn tallies for `kind = 'turn'` (`searches`, `search_only_round_trips`, `work_round_trips`, `first_call_after_searches`, `aborted`), `created_at`. Indexes on `session_id`, `created_at`, and a GIN on `result_tool_names`. Arrays are scalars for export purposes; no `jsonb`. A trigger-free integrity rule: the INSERT policy's `EXISTS` also requires that `turn_message_id` is NULL or belongs to the same `session_id`, so a forged row cannot attach a query to another session's message.

**Writes** go once per turn, after `result`, through `withDbAccessContext` with the session's auth. The ledger insert runs in its own awaited `withDbTransaction`, sequentially after the turn's other writes, with the `catch` **outside** the transaction: a failed statement inside a held context poisons every later statement (25P02) even when caught (`docs/agents/tenancy-rls.md`, #11203), so context-plus-catch is not isolation. A write error is captured and never fails the turn.

**Migration:** hand-written, idempotent, no `BEGIN/COMMIT`, RLS enabled + forced + four `EXISTS` policies in the same file, named to sort after the newest committed migration (currently `2027-01-22-210300-…`; check at PR time), then `pnpm db:check-drift`. It writes no rows, so no `breeze.scope` election.

**Retention (OD3):** rows are **deleted** (not tombstoned) when older than the org's effective `tool_output_retention_days` (`aiToolOutputRetention.ts` policy merge; code default 30 days), by a sibling pass in the same nightly job and batch rules. Two divergences from the tool-output pass, both deliberate: the 180-day ceiling is enforced **independently of policy** (the existing pass skips "keep forever" orgs, `aiToolOutputRetention.ts:75`), and the live-session deferral (`:44-49`, `LIVE_SESSION_QUIET_MS`) does not apply, because nothing in memory depends on these rows. Aggregates survive in prom and in the report. **Disposal of copies:** the ToolSearch block also survives in the assistant row's `contentBlocks` (`ai_messages`, excluded from the tool-output pass) — the search pass clears `ToolSearch` tool_use inputs from `content_blocks` for the same aged sessions; report outputs and `toolEval/candidates/*.json` are scratch files under `.gitignore`d paths with a 30-day local lifetime; captured transcripts from `ai:tool-capture` already follow the harness's own disposal rule.

**Query sensitivity (OD3).** `redactAiToolOutputText` strips bare secret patterns (`aiToolOutput.ts:238`); it does not anonymise customer names, hostnames, e-mail addresses or a pasted credential that misses the patterns, and a model-generated search can restate the whole user message. So: the query is bounded to 1,024 B; rows sit under RLS and the retention window; the report and the admin endpoint require `requireAiSessionsReadAll` (the same gate as reading tool executions); the report prints queries only in the per-org mode, and the cross-org mode prints tool names and counts with the top-miss list reduced to the words that match no `searchHint` (a word list, not sentences).

### 3.6 Admin view and periodic report

- **Report (first):** `pnpm --filter @breeze/api ai:discovery-report --days 7 [--org <id>]` runs in system context after `runOutsideDbContext`, and prints Markdown: searches/turn p50/p90, empty-search rate, top 25 queries with no hit, tools never discovered in the window, tools discovered but not called (description promises what the tool does not do), per-tool call outcomes with schema-invalid rate, `searchHint` candidates (the words from empty queries that match no hint), and the sibling's E1/E2 tables. It also writes `toolEval/candidates/<date>.json` (gitignored): `{ query, expectedTool? }` pairs for review. **Production queries, report output and candidate files never go into commits, issues, PR bodies or published examples** — the repo is public and a query can carry a tenant's words. What is committed is a synthetic paraphrase written by the reviewer, and aggregates (counts, rates, tool names).
- **Admin view (second):** `GET /ai/admin/tool-discovery?since&until&orgId` beside `/admin/tool-executions` (`routes/ai.ts:1759`), same `requireAiSessionsReadAll` gate and org-scoping rules, returning the report's summary tables. Rendered as a "Tool discovery" section of the existing AI risk dashboard page that already reads tool executions — not Settings (it is a report, not a setting; `docs/agents/settings.md` rule 9 does not apply). OD4.

### 3.7 Feedback loop

1. **Text tuning.** Each week the report's miss list is triaged into `searchHint`/description edits ("use the words users use" is the tool-search guidance). Every edit runs under the existing byte-budget tests; a `searchHint` stays ≤ 120 chars and remains "synonyms, not workflow".
2. **Eval harness.** `ai:tool-eval` gains `schema_valid` in `score.ts`: today it scores only the first non-ToolSearch call (`score.ts:30`), which misses a later malformed action in a multi-call turn, so the new metric runs **every** captured `toolUses[]` input through `validateToolInput` and reports first-call hit rate plus all-call schema-valid rate per case. Candidate pairs from the report are **not** promoted into `goldenPrompts.ts` (`:31`; the frozen held-out set): a model-generated query can contain the answer ("manage_services restart"), which would inflate hit rate. They go to a separate `toolEval/tuningPrompts.ts` used for description/searchHint tuning only, and the golden set stays as written. `ai:tool-eval --examples off|on` runs the same suite under `AI_TOOL_EXAMPLES`, so an example's effect is an A/B on the same prompts before production sees it.
3. **Examples.** Rule 4 of §3.1 admits new examples from telemetry; the same report shows whether a shipped example moved the schema-invalid rate, keyed by `surface_fingerprint`.
4. **Sibling decision.** E1/E2 go to `2026-11-08-programmatic-tool-calling-decision.md` after 30 days of data.

## 4. Tenancy and data model impact

- **New table:** `ai_tool_search_events`, the generalised parent-FK-join shape (no `org_id`): RLS enabled, forced, `EXISTS` join to `ai_sessions` on SELECT/INSERT/UPDATE/DELETE in the creating migration, and registered in `PARENT_FK_JOIN_POLICY_TABLES` so `rls-coverage.integration.test.ts` exercises it. Org erasure and merge reach it through `ai_sessions` (registered) and the `ON DELETE CASCADE` FK; adding it to `siteTopologySessions.ts`'s explicit child deletes is optional with the cascade FK and is done only for symmetry with `ai_tool_executions`. It is added to `aiToolOutputRetention.ts` (§3.5).
- **Export omission, deliberate.** Tenant export walks `getOrgCascadeDeleteOrder()` (`tenantExport.ts:71`), so FK-child tables without `org_id` are **absent from exports** (`tenancy-rls.md`: "a table with no `org_id` needs no entry"). `ai_tool_executions` is already absent on the same grounds. Search events are therefore not in a tenant's export in v1; this is recorded here as the intended behaviour, and revisited only if a data-subject request needs the model's search queries (the user's own messages, which are exported, are the source those queries paraphrase).
- **New column:** `ai_tool_executions.discovery` (text, nullable, CHECK on the four values). The table has no export-policy entry (same omission as above), so no classification is needed; the Integration suite confirms.
- **No `org_id` columns, no `jsonb`.** Partner-wide-first (#2135) does not apply: this is a ledger, not config.
- **Shared types:** none in `packages/shared` for v1 (admin endpoint types live with the route, like `/admin/tool-executions`); locale strings for the dashboard section in all 8 locales.

## 5. Alternatives considered

- **Examples in description prose only (permanent).** Loses structure, costs prefix bytes on every tool, cannot be switched off per profile. Acceptable only as the OD1 bridge.
- **JSON Schema `examples` keyword on `input_schema`.** The API does not treat it as `input_examples`, and the sibling spec strips it for constrained profiles. Rejected.
- **LLM-generated examples from schemas.** Unverified inputs would be shipped to the model as truth; the contract test would catch invalid ones but not misleading ones. Rejected; hand-written and reviewed.
- **Parse the CLI's stderr for ToolSearch lines** (`stderrToolSearchLines`). Brittle, unversioned text. Rejected; the typed stream blocks are the source.
- **Sentry breadcrumbs / logs only.** No aggregation, no tenancy posture, retention outside our control. Rejected.
- **Record on `ai_messages`.** The assistant row already keeps the ToolSearch block in `contentBlocks`; mining it per report means parsing jsonb per message, with no index. Rejected for queries; kept as the forensic fallback.

## 6. Open Decisions (Gate A)

1. **OD1: How examples reach the model through the Agent SDK.**
   - A: wait for native support (`tool({ inputExamples })` or `_meta['anthropic/inputExamples']`), file upstream, ship only the registry field and the oracle test.
   - B: generated description suffix in `attachRegistryMeta` now, permanent.
   - C: B behind `AI_TOOL_EXAMPLES=auto`, native when available, suffix removed once the spike on `^0.3.296` (or a later release) shows plumbing.

   **Recommend C.** A ships nothing measurable; B hard-codes the worst form. The spike is plan task 0 and its finding is recorded like the model-registry spike notes.

2. **OD2: Store for discovery events.** A: new session-keyed table + minimal prom counters. B: columns on `ai_tool_executions` only. C: prom/Redis counters only. D: PostHog.
   **Recommend A.** Misses need rows of their own, and query text is tenant data that needs RLS and retention.

3. **OD3: Query text.** A: stored plain (after the existing output redaction) under RLS, deleted by the tool-output retention window with a 180-day ceiling. B: hash only, plus a top-N word list per day. C: fixed 7-day window.
   **Recommend A.** Tuning needs the words. B cannot produce `searchHint` candidates; C makes weekly triage race the deleter.

4. **OD4: Operator surface.** A: report script only. B: admin endpoint + dashboard section only. C: script first, dashboard the wave after.
   **Recommend C.** The report shapes what the dashboard should show.

5. **OD5: Attribution on `ai_tool_executions`.** A: add `discovery` now and derive schema-invalid from `error_message`. B: add both `discovery` and `failure_class`. C: no column; join to search events at report time.
   **Recommend A.** One scalar column; the derivation is testable; a second column waits for evidence it is needed.

6. **OD6: Wave-1 example scope.** A: the explicit 10-tool endpoint-execution list in §3.1 (≤ 50 examples). B: every `TIER3_ACTIONS` tool (76 tools, 219 actions; ≤ 380 examples under the cap). C: all tools.
   **Recommend A, then telemetry-ranked waves**, each with the eval A/B of §3.7. B in one wave is ~70 KB of hand-written examples nobody has evidence for.

7. **OD7: `alwaysLoad` example budget.** A: 0 B (no examples on core). B: ≤ 1,024 B, known failure modes only. C: no cap.
   **Recommend B.** `set_device_context` alone justifies it; the cap keeps the cached prefix stable.

8. **OD8: Gateway (OpenAI-compatible) path.** A: drop examples. B: description suffix for `full` profile, dropped for constrained. C: suffix always.
   **Recommend B**, consistent with the sibling spec's compaction rule.

## 7. Testing

- **Red first, pure:** `aiToolExamples.contract.test.ts` — every `inputExamples` entry validates against **all three** surfaces: `toolInputSchemas[name].safeParse` (enforcement, including action-dependent refinements such as "install requires patchIds"), `z.object(sdkShape).strict()` (advertised SDK shape, nested unknown keys rejected), and the JSON `input_schema` via a strict validator (`additionalProperties: false` applied recursively for the test only); 1–5 per tool; ≤ 300 B each, ≤ 900 B per tool; placeholder-UUID range only, no `@`-addresses, no dotted hostnames; no example on a `HUMAN_ONLY_TOOLS` entry; for an action-enum tool, the example set covers every distinct required-field shape of its escalated actions up to the cap of five (the rule in §3.1), and the wave-1 list is pinned name by name; core (`alwaysLoad`) example bytes ≤ 1,024 in total. A drift guard fails when a tool gains an action or a required field and its examples no longer cover the new shape.
- **Index regression:** W15/W16/W18 budget tests and `aiAgent.toolIndexPrompt.test.ts` unchanged and green (`B1 = 2,551`).
- **Server meta:** `aiAgentSdkTools.serverMeta.test.ts` extended to assert `alwaysLoad` passthrough as well (today it checks `searchHint` only); with `AI_TOOL_EXAMPLES=auto`, search enabled and no native path, the advertised description ends with the generated suffix for exactly the wave-1 tools; with `off`, or with search disabled, descriptions are byte-identical to today. `aiAgentSdkTools.templateCache.test.ts` flips the examples mode and the search bit and expects a rebuilt template.
- **Observer:** `aiToolDiscoveryObserver.test.ts` on captured fixtures (plan task 0b) — a ToolSearch tool_use + tool_result pair yields one event with query, `max_results` and matched names; an empty result sets `empty`; `select:` sets `select_mode`; a later call to a result name lands in `called_tool_names`; a `tool_reference` seen before the call's stream event still attributes by `tool_use_id`; replayed messages (seen `message.id`) seed the loaded set and emit no event; the harness's `streamObserver` numbers are unchanged.
- **Stream:** `streamingSessionManager.toolSearch.test.ts` — a searching turn inserts one `search` row per search plus one `turn` row; a zero-search turn still inserts its `turn` row; a non-searching surface inserts nothing; an aborted turn flushes `aborted = true`; the ledger insert runs in its own `withDbTransaction` and a failure there is captured after the transaction with the turn completing and later statements succeeding; the post-tool hook sets `discovery` for a searched, a core and a session-sticky call; a #3094 dropped `-32602` result and a pre-hook `Invalid input:` refusal are both counted once by the report's derivation, with the correct denominator.
- **Integration (RLS, runs only under Integration Tests):** `rls-coverage` covers the table through `PARENT_FK_JOIN_POLICY_TABLES`; a foreign-org token gets zero rows on SELECT **and** is refused on INSERT, UPDATE and DELETE (forged `session_id`, and a `turn_message_id` from another session); org erasure deletes the rows through `ai_sessions`; org merge moves them with their session; the `discovery` column needs no export classification (suite stays green).
- **Retention:** the search pass deletes aged rows, enforces the 180-day ceiling for a "keep forever" org, ignores the live-session deferral, and clears `ToolSearch` inputs from aged `ai_messages.content_blocks`; migration naming and `migrationRlsScope` tests pass.
- **Harness:** `score.test.ts` for `schema_valid`; `ai:tool-eval --examples off|on` on the chat suite for the wave-1 tools, numbers recorded in the plan.
- **Report:** unit tests on the aggregation (empty rate, never-discovered, discovered-not-called, E1/E2) over a fixture ledger.

## 8. Rollout

1. **Telemetry first, dark.** Migration + observer + `discovery` column + report script ship with no example declared. Two weeks of baseline on the hosted instances give the per-tool schema-invalid and discovery rates examples will be judged against. Reports stay local; only aggregates are quoted in issues or PRs.
2. **Spikes** (plan task 0): 0a — OD1 on the pinned SDK, record the finding, set `AI_TOOL_EXAMPLES` default accordingly; 0b — capture ToolSearch fixtures with `ai:tool-capture` and fix the observable field list (§3.4). Fixtures committed to the repo are synthesised from the captured shape, never raw.
3. **Wave 1 examples** (OD6-A), gated by the contract test and the eval A/B; deploy; compare against the baseline by `surface_fingerprint`.
4. **Dashboard section** once the report has stabilised what to show.
5. **Kill switch:** `AI_TOOL_EXAMPLES=off` removes every advertised example without a deploy of registry code; telemetry has no switch (it is passive and failure-isolated) beyond the existing `AI_TOOL_SEARCH=off`, which removes searches and therefore events.
6. **Release notes for self-hosters:** the new table and its retention, the admin endpoint, and that OpenAI-compatible endpoints receive no examples under constrained profiles.
7. **Lab leg:** none required; the eval harness and hosted telemetry are the measurement.
