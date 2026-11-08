---
status: draft (spec-drafted, revised after one independent review: AGREE WITH CHANGES on full default, alwaysLoad core and call_tool re-entering the auth path; the reviewer's blocker on approval continuation is now §3.4). Awaiting Todd's Gate A on the Open Decisions in §7.
date: 2026-11-08
tracking_issue: (none yet; file under the AI/MCP epic when Gate A passes)
covers: "External MCP server tools/list size: progressive disclosure (search / inspect / execute) for API-key and OAuth clients that have no tool search of their own"
related: "#6151 (A-W04 tool search in chat), #10065 (W19 lazy tool index), #6156 (per-grant MCP domains), #6157 (stateless 2026-07-28 era), #6158 (Tier 3 intents over MCP), #6159 (MCP Apps), #6160 (Tasks), #6407 (tools/list pagination), #7429 (per-endpoint tool-search capability), #9596 (small-model profiles, sibling spec 2026-11-06)"
---

# Progressive disclosure for the external MCP server

**Scope:** the external MCP server (`apps/api/src/routes/mcpServer.ts`, Streamable HTTP and legacy HTTP+SSE under `/api/v1/mcp/*`; API-key, OAuth and partner-service-principal principals), the registry metadata it already has (`aiTools.ts` `searchHint` / `alwaysLoad` / domain, `aiToolIndex.ts`), the server instructions (`mcpGuidance.ts`), credential UI in `apps/web`, and the external-client docs page (`apps/docs/src/content/docs/features/mcp-server.mdx`). In-app chat is out of scope: it already defers through the Agent SDK's `ToolSearch`. This document records intent and decisions. It contains no plan and no code.

**Evidence:** "verified" means the author re-read the code on `origin/main` at `127bb8b543` (2026-11-08). "Measured" means a number produced by the throwaway script in §3.8 on a local `main` checkout (`8329045244`) with no enable flags set. "Inferred" means it follows from the code or from the chat measurements in `2026-09-17-agent-tool-efficiency-baseline.md` (§8–§10, in this directory) but was not exercised over MCP. External sources are linked in §9; claims drawn from them are marked "(source)" and were not re-verified against a live client.

## 1. Problem

The external MCP server returns every tool this principal may call, with its full description and JSON Schema, on every `tools/list`. Nothing is deferred and no tool search is offered. A client such as Claude Desktop or Cursor puts the whole response into the model's context on every turn.

Verified facts that shape the design:

1. **The list is large and complete.** `handleToolsList` filters `getToolDefinitions()` through `isToolListedForCaller` (scope tier, production execute allowlist, MFA gate, wholly-gated Tier 3, partner-wide gates, per-grant domain) and emits `title`, `annotations`, `_meta['app.breeze/domain']` (plus `_meta.ui` for an eligible MCP Apps client, `:1957`), a description that may carry approval suffixes, and `inputSchema` for each (`mcpServer.ts:1905-1965`). `MCP_TOOL_COUNT_APPROX = 372` (`mcpGuidance.ts:8`), pinned to the live registry within ±10 by `mcpGuidancePromptTools.test.ts`. The server advertises `tools: { listChanged: false }` (`:1361`).
2. **Pagination exists but does not shrink context.** `MCP_TOOLS_LIST_PAGE_SIZE` (#6407, off by default) splits the same list into fingerprinted pages (`:2046-2075`). A client follows `nextCursor` to the end and still holds every schema.
3. **Chat solved the same problem a different way.** The registry marks a small `alwaysLoad` core (14 declarations on `main`; `getToolAlwaysLoad`, `aiTools.ts:684`) and gives every tool a ≤ 120-char `searchHint` ("synonyms, not workflow", `:197`). `attachRegistryMeta` (`aiAgentSdkTools.ts:5989`) forwards both as `_meta['anthropic/searchHint']` / `_meta['anthropic/alwaysLoad']`, and `resolveToolSearchPolicy` (`aiToolSearchPolicy.ts`) turns the SDK's `ToolSearch` on for first-party hosts. The lazy index (`aiToolIndex.ts`, `AI_TOOL_INDEX=lazy`, W19) renders one line per domain from `DOMAIN_VOCABULARY` plus `DOMAIN_NOTES`, under 2.5 KB. In chat this took first-call context from about 73.5k to 14.3k tokens with a 1.5-case loss on the 67-case golden eval (baseline §8–§9, local harness, first-party API).
4. **None of that reaches MCP.** `_meta['anthropic/*']` is an Agent SDK convention; MCP clients ignore it. The MCP response carries `app.breeze/domain` and, for eligible clients, `_meta.ui`.
5. **Clients are uneven (source).** Claude Code auto-defers MCP tools once their definitions pass roughly 10% of context (`ENABLE_TOOL_SEARCH` auto). Claude Desktop, Cursor and most other clients load everything. Via the Anthropic MCP connector, deferral is set on the `mcp_toolset` entry's `default_config` or per-tool `configs` by the API caller, never by the server. These are to-measure claims for Breeze (§3.8.3), not verified here.
6. **Authority lives in `tools/call`, by real name.** The call path resolves aliases, applies the domain gate, Tier 3 approval or intent filing, guardrails for the effective tier, scope tiers, the production allowlist, RBAC, rate limits, then dispatches `executeTool` (`mcpServer.ts:2160-2420`). Tier 3 calls run inside `runMcpTier3Lifecycle` (ledger, then the uniform `mcp.tool.<name>` audit); lower tiers skip the ledger but still emit that audit; refusals before dispatch (domain, approval, guardrail, scope, MFA, partner-wide) return before either (`mcpTier3Lifecycle.ts:250-262`, `mcpServer.ts:2413`). `dispatchAndAudit` (`:791`) writes one request-level audit row per JSON-RPC request, classifying `result` only from a JSON-RPC error, not from `result.isError` (`:838`), and `domainDenialAuditDetails` (`:730`) reads the denied tool from the outer `params.name`.
7. **Existence is already partly disclosed.** A known tool outside the grant answers `-32003 domain_not_granted` naming its domain (`mcpDomains.ts:112`, `mcpServer.ts:2250`); an unknown name answers `-32602 Unknown tool`. So direct calls distinguish "exists, not granted" from "does not exist" by design (the hint tells the caller to widen the grant). The guarantee the design must keep is narrower: discovery reveals no *schema or description* of an ungranted tool.
8. **Approval continuations are name-bound.** The modern-era MRTR retry (`handleToolsCallContinuation`, `:2780`) opens a sealed `requestState` and rejects it unless `payload.t` equals the tool name on the retry and `payload.d` equals the digest of the retry's `arguments` (`:2802-2806`). The elicitation text names the real tool and says nothing about rewriting the request (`mcpActionStatus.ts:173`). Tasks (#6160) are modern-only; legacy HTTP+SSE never negotiates Apps (`:945`) and Tasks are declared per modern request (`:1409`).
9. **`read_artifact` has no anchor over MCP.** Listed for forward compatibility, it refuses with `no_capture_anchor` (`aiToolsArtifacts.ts:39`).
10. **Cache hints exist only in the stateless era.** `decorateModernResult` adds `ttlMs: 60000, cacheScope: 'private'` to `tools/list` (`mcpModernResult.ts`); legacy results carry none. The MCP 2026-07-28 client best practices (source) describe the same three-layer discovery (catalog → inspect → execute), a 1–5%-of-context budget for definitions, and warn that swapping the tool array per turn invalidates prompt caches; GitHub's MCP team reported the same before moving to curated surfaces (source).

**Size (measured).** `getToolDefinitions()` registered 244 tools: 202,750 bytes of `{name, description, input_schema}` JSON (146.8 KB schemas, 40.4 KB descriptions), about 830 bytes per tool before the MCP presentation fields (`title`, `annotations`, `_meta`, approval suffixes: roughly +150 bytes each, inferred). The 14 `alwaysLoad` tools (`query_devices`, `get_device_details`, `resolve_device_context`, `list_organizations`, `get_fleet_health`, `manage_alerts`, `manage_patches`, `search_logs`, `analyze_metrics`, `get_security_posture`, `query_change_log`, `list_scripts`, `search_documentation`, `execute_command`) are 16,955 bytes. A `{name, domain, searchHint}` catalog of all 244 is 32,903 bytes. Scaled to the ~372 tools a fully flagged deployment registers, `tools/list` is about 310 KB before presentation fields and about 360 KB after (inferred); at 3–3.5 bytes per token that is 90–120k tokens, roughly half of a 200k window before the user types anything, and an order of magnitude above the 30–50 tool range where Anthropic reports selection accuracy degrading (source).

## 2. Goals and non-goals

**Goals**

- A client with no tool search of its own gets a `tools/list` in the low tens of tools and reaches any of the ~370 through search → inspect → execute, with the same authority checks and equivalent audit events as a direct call.
- Reuse what the registry already has: `alwaysLoad`, `searchHint`, domain, `DOMAIN_VOCABULARY`, `DOMAIN_NOTES`. No second catalog to maintain.
- Existing integrations keep working unchanged until they opt in; a later default flip cannot silently change a credential that was created before it.
- Clients that do their own deferral (Claude Code, the Anthropic MCP connector) can keep the full list.

**Non-goals**

- Changing in-app chat, Helper, agents or the OpenAI-compatible gateway.
- Embedding-based search. Keyword or BM25 over `name + searchHint + description + domain` is enough for a few hundred tools.
- Session state on the server. The stateless era has none by design (D-B16); the design must not need it.
- Fixing `read_artifact` anchoring over MCP (separate design, as the docs page already says).
- Per-turn dynamic tool sets, rejected on cache grounds (§4).

## 3. Design (recommended: server-side progressive disclosure over the existing domain grouping)

### 3.1 Two list modes, resolved once per request and reported everywhere

`tools/list` has a **disclosure mode**: `full` (today's behaviour, byte-identical) or `progressive`. The mode is resolved per request, in this order, and the resolved value is attached to the request context so `initialize` / `server/discover` instructions, `tools/list`, `whoami` and the meta-tools all see the same answer within a request:

1. **Request override.** The header `Mcp-Tool-List: full|progressive` (either transport) and, in the stateless era, `_meta['app.breeze/toolList']` on the request. When both are present and disagree the request is refused with `-32602` (`reason: 'tool_list_mode_conflict'`), the same posture the stateless era takes on header/body disagreement (`-32020`). The override applies to the request that carries it, so a client that wants `progressive` instructions must send it on `initialize` / `server/discover` as well as on `tools/list`; the docs say so.
2. **The credential's stored mode** (§3.6). `null` means "use the deployment default *as of when this credential was created*", see §3.7.
3. **The deployment default** `MCP_TOOL_LIST_DEFAULT=full|progressive`, shipping as `full` (OD-1).

`whoami` and `server/discover` report `{ toolListMode, source: 'request' | 'credential' | 'deployment_default' }`.

### 3.2 What `progressive` lists

- **The core.** The registry's 14 `alwaysLoad` tools (§1) that pass `isToolListedForCaller` for this principal (so `execute_command` drops out for a caller it is wholly gated for, exactly as today), plus the intrinsics already listed today: `whoami`; `get_action_status` when the caller owns intents; `cancel_action` when the caller owns intents **and** has write authority (`:1976`). Target: about 15 tools, about 17 KB of definitions. An MCP-specific core is not introduced in v1; if §3.8 shows the chat core is wrong for MCP traffic, a `mcpAlwaysLoad` flag on the registry entry is the follow-up, not a parallel list.
- **Three server-intrinsic meta-tools**, domain `core`, listed for every principal that passes the `ai:read` preflight. Their names are reserved in `aiToolNames.ts` through `registerReservedAiToolNamePredicate`, the way `whoami` is (`aiToolNames.ts:63-70`), so no extension can register a colliding tool. They are intrinsics, not registry tools: `MCP_TOOL_COUNT_APPROX`, `TOOL_TIERS`, Wisp subject classification and the chat tool-index budget are untouched.
  - `search_tools({ query, domain?, limit? })` → `[{ name, title, domain, hint, tier, readOnly, approvalNote? }]`. Ranking is BM25 over `name`, `searchHint`, the first sentence of `description`, and `DOMAIN_VOCABULARY[domain]`, with an exact-name match pinned first. Default `limit` 8, max 20. The catalog is exactly the set `isToolListedForCaller` would list (tenant and flow tools included, with no `searchHint`, ranked on name and description), so nothing outside the grant, the scope tier, the MFA gate or the wholly-gated Tier 3 set is ever ranked.
  - `get_tool_details({ names: string[] })` → the same objects `tools/list` would emit for those names (title, annotations, `_meta` including `ui` when eligible, the suffixed description, `inputSchema`), max 10 per call. A name that is not in the caller's listable set answers `Unknown tool: <name>` uniformly, whether the tool does not exist, is wholly gated, or is outside the grant. This is *stricter* than a direct `tools/call`, which already says `domain_not_granted` for a known ungranted tool (§1.7). The non-disclosure guarantee is therefore: discovery (list, search, details, instructions) never reveals the name, description or schema of a tool the caller could not list; it does not change what a direct call reveals.
  - `call_tool({ name, arguments })` → §3.3.
- **Server instructions.** `buildMcpServerInstructions` takes the resolved mode. In `progressive` it replaces "exposes ~372 tools" with the W19 domain index for the caller's granted domains (label + `DOMAIN_VOCABULARY`) and a three-line recipe (search, inspect, call). `DOMAIN_NOTES` are filtered by the caller's **listable tool names**, not by granted domain, reusing `renderDomainNote`'s sentence filter (`aiToolIndex.ts:109`), so a note never names a tool the caller cannot list. The index is bounded under 2.5 KB and byte-stable when tools are added to an existing domain (W19 bound B1). In `full` the instructions are unchanged.
- **Direct calls still work.** A client that knows a real name may call it via `tools/call` in either mode. Listed ⇒ callable holds; its converse holds for the meta-tools: nothing becomes callable in `progressive` that was not callable in `full`.

### 3.3 `call_tool`: a dispatcher, not a tool

`call_tool` re-enters `handleToolsCall` with the **inner** name and arguments and the **outer** request's `auth`, `scopes`, `apiKey`, Hono context, correlation, client capabilities and `tasksDeclared`. Rules:

- **Canonicalize first, then refuse recursion.** The inner name goes through `resolveDeprecatedToolAlias`; if the canonical name is `call_tool`, `search_tools` or `get_tool_details`, the call is refused with `-32602` (`reason: 'meta_tool_target'`). The existing alias warning fires for the inner name.
- **Every gate runs on the inner name**, including the domain gate (`-32003` for a known ungranted tool, same as a direct call), approval / intent filing, guardrails on the effective tier, scope tiers, production allowlist, RBAC, rate limits (keyed on the inner name, so a multiplexer cannot dodge a per-tool limit), and the Tier 3 ledger. Discovery visibility and authorization stay separate: a tool that `search_tools` surfaced can still be refused by RBAC on call, exactly as a listed tool can today.
- **Annotations tell the truth.** `call_tool` is advertised with `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`, and its description says it runs whatever the inner tool is classified as. The dispatcher itself has no tier; the inner tool's effective tier governs. Clients that keep their own allowlists or per-tool approval prompts therefore see one multiplexer; the docs say this and point such clients at `full` mode or direct calls.
- **Results pass through unchanged**, including `isError`, `input_required` and `task` envelopes.
- **Outer dispatch changes** (required, see §3.5 for the audit side): `noteMcpAppToolCall` (`:1408`) and `domainDenialAuditDetails` (`:730`) must read the *inner* name when the outer is `call_tool`; `handleJsonRpc` unwraps once, before either, so neither sees `call_tool` as the tool.

### 3.4 Approval continuations and Tasks through the wrapper (required)

The reviewer's blocker: a Tier 3 action called through `call_tool` yields an `input_required` result whose sealed `requestState` binds `payload.t` to the real tool and `payload.d` to the digest of the real arguments (§1.8). A client that retries the wrapper exactly as it sent it (`name: 'call_tool'`, `arguments: { name, arguments }`) fails both checks. The elicitation does not tell the client to rewrite anything, and clients will not. The design must accept the wrapper retry as-is.

- **Binding stays on the real call.** The state keeps `t = <real tool>` and `d = digest(real arguments)`; nothing about the intent, the ledger row or the approval page changes.
- **The continuation unwraps the same way the first call did.** When `tools/call` carries `requestState` and `name === 'call_tool'`, `handleToolsCallContinuation` receives the canonicalized inner name and the inner arguments. The existing checks then hold: `payload.t` matches the inner name, `payload.d` matches the inner digest, the credential binding `payload.p` is unchanged. A wrapper retry that changes the inner name or arguments fails exactly as a direct retry would.
- **Wrapper mismatch is also a failure.** A state issued to a direct call is accepted on a direct retry only, and a state issued through `call_tool` is accepted through `call_tool` only. This is one extra byte in the sealed payload (`w: 0|1`), checked before `payload.a` is exposed, so a client cannot move a state between the two surfaces. (Builder's choice: accept either surface. The author prefers the strict form; the review decides.)
- **Elicitation text** stays as it is: it names the real tool, which is what the user approving in Breeze needs to see.
- **Tasks (#6160).** A `task` result created through `call_tool` is owned, polled and cancelled through `tasks/get|update|cancel` by task id, which is unaffected by the wrapper. `ctx.auditExtras.taskResult` is set from the pass-through result as today.
- **`get_action_status` / `cancel_action`** are keyed on action id and unaffected.

### 3.5 Audit fidelity

What "equivalent audit" means, event by event:

- **Request-level row** (`dispatchAndAudit`): one row per JSON-RPC request, as today. For `call_tool` it gains `metaTool: 'call_tool'`, `toolName: <canonical inner name>`, and `requestedToolName: <inner name as sent>` when an alias was used. `result` keeps its JSON-RPC-error meaning; because the inner handler's `isError` results are not JSON-RPC errors, the row also gains `toolIsError: true` when the pass-through result sets it, for direct and wrapped calls alike (a small, additive change to today's row).
- **Domain denial attribution** (`domainDenialAuditDetails`): `canonicalTool` is the inner canonical name.
- **Uniform execution audit** (`mcp.tool.<name>`) and the **Tier 3 ledger**: produced inside the handler on the real name; identical for direct and wrapped calls. Early refusals (domain, approval, guardrail, scope, MFA, partner-wide) produce no execution audit today and still do not; they are visible only on the request row, as now. No event is written twice: the dispatcher adds fields to the one request row, it does not write a second.
- **MCP Apps go/no-go counter** (`noteMcpAppToolCall`): counts the inner name.

### 3.6 The stored mode: data model and settings (rule 9)

Three credential paths carry an MCP principal, and each gets an explicit policy:

| Credential | Where `mcp_domains` lives | Mode column | Edit home |
|---|---|---|---|
| API key | `api_keys.mcp_domains` (`db/schema/apiKeys.ts:40`) | `api_keys.mcp_tool_list_mode` | Settings → API Keys, key drawer (`ApiKeysPage.tsx`), new "Tool list" field in the `create` and `view` modes; `rotate` carries the value to the new key |
| OAuth grant | `oauth_grants.mcp_domains` (`oauth.ts:140`), chosen on the consent form (`ConsentForm.tsx:311`) | `oauth_grants.mcp_tool_list_mode` | The consent form (next to the domain picker) at authorization time. Settings → Connected Apps today offers revoke only (`ConnectedAppsList.tsx:157`); it gains a per-grant "Tool list" control in the same row. One home per level: consent sets, Connected Apps edits |
| Partner service principal key | none: `mcpDomains: null`, unrestricted by design (`partnerServicePrincipalMcpAuth.ts:243`) | none in v1 | Not editable. These keys are scripted integrations; they resolve to `full` regardless of deployment default (grandfathered by construction, §3.7). Opt-in is the `Mcp-Tool-List` header |

- **Level and inheritance.** This is a credential-level setting and a documented exception to rule 3's partner → org → document chain: there is no org override and nothing is snapshotted. "Blank = inherit" (rule 4) is kept: a `null` column inherits the deployment default *frozen at credential creation* (§3.7), and the UI shows the effective value and its source ("Full (deployment default when this key was created)"). A credential with several grants (a user who authorized the same OAuth client twice) sees one row per grant, as Connected Apps already lists grants.
- **Resolver:** `resolveMcpToolListMode({ requestOverride, credential, deploymentDefault })`, one implementation, called by `initialize`/`server/discover`, `tools/list`, `whoami` and the meta-tools.
- **Count of places configured:** before 0; after 2 UI homes (API key drawer; consent form + Connected Apps row, which are the two moments one OAuth grant is edited) plus 1 deployment env default, which is an operator switch, not a setting.
- **Write paths.** The API-key PATCH route and the OAuth grant update route already exist for domains; each gains the mode field with the same authorization (key owner or partner admin; grant owner). Both are tenant rows under existing RLS; no new tenancy shape, no new table. The scalar text column is classified `included` in `CORE_TENANT_EXPORT_POLICY` wherever `api_keys` and `oauth_grants` are registered today (grep, don't judge). Migration: one hand-written idempotent file, `ADD COLUMN IF NOT EXISTS` plus a guarded CHECK, writes no rows, then `pnpm db:check-drift`.

### 3.7 Compatibility and the default flip

A nullable column that means "current deployment default" would let a future flip change every existing integration at once, which the ecosystem compatibility rule forbids. So:

- **Grandfathering is stored, not implied.** The migration backfills `mcp_tool_list_mode = 'full'` on every existing `api_keys` and `oauth_grants` row. New rows get `null` (= deployment default at creation; the resolver reads `MCP_TOOL_LIST_DEFAULT` and the UI shows the result). A later flip of the env default therefore affects only credentials created after the flip.
- **Rotation** copies the value. **OAuth re-consent** shows the current value pre-selected; the user may change it. **Revoke + recreate** is a new credential and gets the new default.
- **Partner service principal keys** are always `full` unless the request overrides, in v1.
- **The flip itself** (OD-1) is a release-note item plus, for one release before it, a `Mcp-Tool-List-Default-Change: <version>` response header on `full` responses from credentials that will be affected (only `null`-mode rows, which after the backfill means none of today's).

### 3.8 Token and byte estimate, and measurement plan

| Surface | Tools on the wire | Bytes (JSON) | Tokens (bytes ÷ 3–3.5) |
|---|---|---|---|
| `full`, measured (244 tools, flags off) | 244 + intrinsics | 203 KB + ~37 KB presentation (inferred) | ~70–80k |
| `full`, fully flagged (inferred) | ~372 + intrinsics | ~360 KB | ~90–120k |
| `progressive`, first list | 14 core + 3 meta + intrinsics | ~17 KB + ~4 KB | ~6–7k |
| one `search_tools` result (8 rows) | — | ~1.2 KB | ~350 |
| one `get_tool_details` (1 tool) | — | ~1 KB | ~300 |

A task that searches once, inspects two tools and calls one should cost about 8k tokens of tool context instead of 70–120k, and the client's prompt-cache prefix no longer changes when Breeze ships a tool. The 1–5% budget from the MCP best practices (source) is met at a 200k window. **Per-client savings are to-measure**, not claimed: how Claude Desktop, Cursor or Claude Code actually place MCP tool definitions in the prompt is not observable from the server.

Measurement, before the first PR and again on it:

1. **Bytes and tokens of `tools/list`.** A script under `apps/api/scripts/` (next to `ai:tool-capture`) builds the real `handleToolsList` output for a synthetic unrestricted `ai:read`+`ai:write`+`ai:execute` principal and for a `core`+`devices` restricted grant, every enable flag on, both modes, and prints bytes, tool count and a token count from the Anthropic count-tokens endpoint when a key is present (bytes ÷ 3.5 otherwise). It replaces the §1 throwaway numbers in a new baseline-doc section. No tenant data is involved; synthetic principals only.
2. **Search quality.** The chat golden eval's 67 cases, re-expressed as `search_tools` queries: is an acceptable first tool in the top 3, top 8? Target ≥ 90% top-8. Pure unit test over the ranker, runs in CI.
3. **Live client check.** Claude Desktop, Cursor and Claude Code against a wt-stack in `progressive` mode with a lab API key: list size as the client reports it, the client's own token/usage display where it has one, and three scripted tasks (fleet triage prompt, one device investigation, one ticket read) completing with the expected real tool on the audit row. Results go into the baseline doc as "lab, synthetic data"; no production or customer capture is used.

### 3.9 Cache hints, `list_changed`, transport parity

- `tools/list` in `progressive` keeps `ttlMs: 60000` in the stateless era. It is a hint only; a client that ignores it simply re-lists. Legacy results carry no hints, as today.
- `search_tools` / `get_tool_details` are `tools/call` results and carry no cache hints, as today.
- `listChanged` stays `false`. Emitting `notifications/tools/list_changed` on the legacy SSE stream is a follow-up (OD-6).
- **Parity claims are limited to shared capabilities.** Legacy HTTP+SSE and stateless `POST /sse` produce the same `progressive` list, the same meta-tool behaviour and the same `call_tool` dispatch; Apps `_meta.ui` (never negotiated on HTTP+SSE), Tasks (modern-only) and cache hints differ exactly as they do today and are excluded from the parity assertion.
- **`full` is byte-identical to today**, including no `_meta['anthropic/*']`. OD-7 (adding those keys) applies to `progressive` only, where there is no byte-identical promise.

### 3.10 Docs

`features/mcp-server.mdx` gets: the two modes and how each is picked (header and `_meta`, their conflict rule, the per-credential value and where it is edited, the deployment default and grandfathering); the three meta-tools with one example each; the `call_tool` annotation note for clients that keep their own allowlists; that approval retries through `call_tool` work unchanged; that the audit log carries the real tool name for wrapped calls; and that Claude Code already defers and may prefer `full`. The "Available tools" section stays, since it documents what `search_tools` can find.

## 4. Alternatives considered

1. **Do nothing server-side; rely on clients.** Zero risk to existing integrations, but it helps only Claude Code and connector callers (source). Kept as the `full` mode, not as the answer.
2. **Domain toolsets as grouped tools.** One `patching_tools({ tool, arguments })` multiplexer per domain, 14 listed. It hides every schema until the model guesses right, pushes argument validation to prose, duplicates the action-enum pattern at a second level, and still needs `get_tool_details` to be usable. At that point it is the recommended design with a worse `call_tool`. Rejected; the domain grouping survives as the search filter and the instructions index.
3. **Per-turn dynamic tool sets** (list changes with recent calls or a `load_domain` call). Rejected: the server is stateless, and both the MCP best practices and GitHub's MCP team (source) report the prompt-cache invalidation cost. A stable `call_tool` meta-tool is the recommended shape for exactly this reason.
4. **Make `progressive` the default now.** Rejected for v1 on the compatibility rule for partner integrations: scripted integrations call tools by name without listing; some read `tools/list` to build menus. The default flips only versioned, announced and with stored grandfathering (§3.7, OD-1).
5. **Ship `_meta['anthropic/searchHint']` / `alwaysLoad` on MCP `tools/list` and stop there.** Cheap, and a connector caller could map them into per-tool `configs`. But the connector sets deferral client-side regardless and no other client reads them. Kept as OD-7, for `progressive` only.
6. **Nullable mode = live deployment default.** Rejected: a flip would silently change existing integrations. Replaced by the backfilled `'full'` in §3.7.

## 5. Tenancy and data model impact

- No new table, no new tenancy shape. One nullable text column, CHECK in (`full`, `progressive`), on `api_keys` and `oauth_grants`, backfilled to `'full'` for existing rows. Both are existing tenant rows under existing RLS; the writes go through the existing authorized credential-update routes (§3.6). Export classification `included`. Live RLS and export-policy contract suites run under Integration Tests, plus `pnpm db:check-drift`.
- The backfill writes rows, so the migration elects system scope first (`SELECT set_config('breeze.scope', 'system', true);`), per `migrationRlsScope.test.ts`.
- Partner service principal keys get no column in v1.

## 6. Testing

- **Red first, pure:** `mcpToolListMode.test.ts`: resolution order (request > credential > deployment default), header/`_meta` conflict refusal, grandfathered `'full'` ignores a flipped default, `null` follows it, partner service principal keys resolve `full`.
- **Regression guard:** `full` output of `handleToolsList` and of `buildInitializeResult` / `buildDiscoverResult` is byte-identical to today's for the same principal and the same client capabilities.
- **`progressive` list:** exactly the filtered core + meta-tools + intrinsics, `cancel_action` only with write authority, `_meta.ui` present only for an eligible Apps client on the stateless transport.
- **Ranker:** the golden-case top-k test (§3.8.2); exact name pinned first; a restricted grant never surfaces an ungranted tool in search, details or instructions; `DOMAIN_NOTES` sentences naming an unlistable tool are dropped.
- **Dispatch parity (contract):** for every registry, tenant and flow tool and a fixed input set, `call_tool` and `tools/call` produce the same JSON-RPC response (including `-32003` for ungranted, `MCP_APPROVAL_REQUIRED`, intent filing, MFA and partner-wide refusals, alias resolution) and the same *applicable* events: identical `mcp.tool.<name>` and ledger rows where the direct call produces them, none where it does not. Recursion refused after canonicalization. Rate limits keyed on the inner name.
- **Continuation:** a `requestState` issued through `call_tool` is accepted on a wrapper retry with the same inner name and arguments, rejected on a changed inner name or arguments, and rejected on a direct retry (and the reverse); Tasks created through `call_tool` are reachable by id.
- **Audit:** request row carries `metaTool`, `toolName`, `requestedToolName` when aliased, `toolIsError` when set; domain-denial attribution and the Apps counter use the inner name; no duplicate execution events.
- **Transport parity:** legacy `/message` and stateless `POST /sse` produce the same `progressive` list and dispatch, asserted over the shared capability set only.
- **Instructions:** `progressive` instructions ≤ 4 KB and byte-stable when a tool is added to an existing domain (extend the W19 B1 test); unchanged in `full`.
- **UI and docs:** `settingsPageRegistry.test.ts` for the edited homes; a grep test that `mcp-server.mdx` names both modes and all three meta-tools; the no-silent-mutations guard on the new mutation handlers.
- **Integration Tests:** RLS on the new column via the credential-update routes, export classification, migration scope election.
- **Lab leg (§3.8.3).**

## 7. Open decisions (Gate A)

1. **OD-1: Default mode.** A: `full` by default, `progressive` opt-in per credential, header, or `MCP_TOOL_LIST_DEFAULT`; flip in a later minor release with notice, affecting only credentials created after the flip (§3.7). B: `progressive` now. C: `progressive` for new credentials only, now. **Recommend A**, with C as the natural second step once the lab leg is in. B breaks scripted integrations that read `tools/list`.
2. **OD-2: Where the stored mode lives.** A: credential rows beside `mcp_domains`, edited at the key drawer and at consent / Connected Apps (§3.6). B: partner-wide only. C: header/`_meta` only, no stored setting. **Recommend A.** One partner can have a Claude Code user on `full` and a Desktop user on `progressive`; C excludes clients whose config cannot add headers. A is real UI scope (two homes, grant rows, inheritance display) and is costed as Wave 2.
3. **OD-3: Ranking engine.** A: BM25 (small in-process implementation or a vetted dependency). B: token-overlap scoring. **Recommend A**; builder's choice within the ≥ 90% top-8 gate.
4. **OD-4: Core set for MCP.** A: the chat `alwaysLoad` set, filtered per caller. B: an `mcpAlwaysLoad` flag from day one. **Recommend A** and let §3.8 decide.
5. **OD-5: Direct calls in `progressive`.** A: allowed alongside `call_tool` (listed ⇒ callable holds; unlisted real names callable by name, as today). B: refuse direct calls to unlisted names. **Recommend A.** B adds a refusal path with no security gain and breaks clients that cache names across mode changes.
6. **OD-6: `notifications/tools/list_changed` on legacy SSE** when a grant or mode edit lands. A: not in v1. B: v1. **Recommend A**; the transport is deprecated with a sunset date.
7. **OD-7: Add `_meta['anthropic/searchHint']` / `_meta['anthropic/alwaysLoad']` to `progressive` lists only.** **Recommend yes** (about 100 bytes per tool, gives connector callers something to map); `full` stays byte-identical. Builder's choice if the measured cost matters.
8. **OD-8: Continuation surface binding (§3.4).** A: strict, a state is valid only on the surface (direct or wrapped) that issued it. B: either surface. **Recommend A**; one byte in the sealed payload, and it keeps the wrapper from becoming a way to replay a direct call's state.

## 8. Rollout

- **Wave 1:** mode resolution (header, `_meta`, env default), `progressive` list and instructions, the three meta-tools with the outer-dispatch and continuation changes (§3.3–§3.5), dispatch-parity, continuation and audit tests, measurement script, baseline-doc section. Ships dark behind `full`; `MCP_TOOL_LIST_DEFAULT=progressive` on a lab stack for §3.8.3.
- **Wave 2:** the column + backfill migration, resolver reads the stored mode, API-key drawer, consent form and Connected Apps controls (8 locales), credential-update routes, docs page, release notes for self-hosters.
- **Wave 3 (after measurement):** OD-1 flip decision, OD-4 MCP core, optional `mcpAlwaysLoad`, `list_changed` only if a client needs it.
- **Risk to watch:** a client that cannot follow the three-step recipe "sees fewer tools" and reports Breeze as broken. Mitigations: the instructions, `whoami`'s mode report, the docs, and the per-credential `full`.

## 9. Sources

- Anthropic, "Tool search tool" (platform docs, `agents-and-tools/tool-use/tool-search-tool`): regex and BM25 variants, `defer_loading`, keep 3–5 core tools non-deferred, accuracy degradation above 30–50 tools, MCP-connector deferral via `mcp_toolset` `default_config` / per-tool `configs`, custom client-side search returning `tool_reference` blocks.
- Model Context Protocol, "Client best practices", spec revision 2026-07-28 (`modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices`): three-layer progressive discovery, 1–5% context threshold, keyword/embedding/subagent/hybrid search, `ttlMs`/`cacheScope`, `notifications/tools/list_changed`, grouping by server, stable `call_tool` meta-tool to avoid prompt-cache invalidation.
- Claude Code `ENABLE_TOOL_SEARCH` auto-deferral of MCP tools above roughly 10% of context (Claude Code docs); Claude Desktop / Cursor load the full list. To be confirmed in §3.8.3.
- GitHub MCP server team write-up on dynamic per-turn toolset swapping invalidating caches and the move to curated surfaces (GitHub blog, 2026). Summary supplied with the task; re-read before Gate A.
- In-repo: `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md` §8–§10 (chat tool-search measurements, local harness, first-party API, no customer data).
