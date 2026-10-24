---
tracking_issue: LanternOps/breeze#6154
wave_issue: LanternOps/breeze#6159
branch: feature/6154-mcp-modernization/wave-6159
---
# MCP server modernization B-W05: MCP Apps pilot (one `ui://` app with text fallback) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client that declares the MCP Apps extension (`io.modelcontextprotocol/ui`) sees `get_fleet_health` rendered as an interactive-looking fleet reliability card (score bands, degrading count, worst devices) instead of a JSON blob. Every other client, and every client while the flag is off, gets exactly today's bytes. A usage query decides whether a second app is worth building.

**Architecture:** One static, self-contained HTML view served as the resource `ui://breeze/fleet-health/v1`. The `get_fleet_health` `tools/list` entry points at it through `_meta.ui.resourceUri`, but only for clients that declared the extension. The view renders the `structuredContent` the server already returns today (B-W01) and never touches the network. The tool call path does not change, so the text fallback is the current result byte for byte. Capability negotiation is a pure parser over the client's declared capabilities: per request in the `2026-07-28` era, and from `initialize` (kept in a Redis side key beside the session) in the legacy streamable era.

**Tech Stack:** TypeScript, Hono, Redis (`getRedis`), vanilla JS/CSS inlined in one HTML string (no framework, no bundler), Vitest (+ `jsdom` environment for the view test).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md` (Feature B → B-W05: "One `ui://` app with text fallback … Decide go/no-go for more from usage"). Source issue #6145 §3. Hand-off seam: B-W04 plan D-B36 (`docs/superpowers/plans/ai-mcp/2026-10-20-mcp-modernization-b04-tier3-intents.md`). Wire contract checked 2026-10-23 against the MCP Apps specification (SEP-1865, `modelcontextprotocol/ext-apps` `specification/2026-01-26/apps.mdx`): client capability `capabilities.extensions["io.modelcontextprotocol/ui"] = { mimeTypes: ["text/html;profile=mcp-app"] }`; tool `_meta.ui = { resourceUri, visibility? }` (default `["model","app"]`); resource mimeType MUST be `text/html;profile=mcp-app`, fetched by `resources/read`, MAY be omitted from `resources/list`; resource `_meta.ui = { csp?, permissions?, domain?, prefersBorder? }`; host default CSP `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'`; view ↔ host JSON-RPC over `postMessage` (`ui/initialize`, `ui/notifications/initialized`, `ui/notifications/tool-input`, `ui/notifications/tool-result`, `ui/notifications/tool-cancelled`, `ui/notifications/size-changed`).

**Tracking:** `get_feature_status LanternOps/breeze#6154`, then `start_wave` on #6159. One PR on the wave branch, body `Closes #6159`, `Refs #6145`.

## Depends on B-W03 and B-W04 — start from a `main` that contains both

Verified on `origin/main` `afcb08c2d4` (2026-10-23). Re-grep every symbol before editing; line numbers drift.

| Seam (as built) | Where | What B-W05 does with it |
|---|---|---|
| `McpDispatchContext = { era, correlation, clientCapabilities? }`; built at `:863` (`/message`, era `legacy`), `:1155` (legacy streamable), `:1201` (modern) | `routes/mcpServer.ts:708-715` | Adds `transport`, `resolveClientExtensions` (thunk) and `auditExtras` |
| `ModernRequestMeta.clientCapabilities` (required in the modern era) | `services/mcpModernEnvelope.ts:41` | Parsed per request |
| Legacy session mint/verify: Redis `MCP_SESSION_REDIS_PREFIX + sid → principalKey`, `MCP_SESSION_TTL_SECONDS` | `routes/mcpServer.ts:1026-1135` | Side key `mcp:session-ext:<sid>` written on `initialize`, read lazily |
| `buildInitializeResult(requestedProtocolVersion)` — capabilities `{tools, resources, prompts}`; client `params.capabilities` ignored | `routes/mcpServer.ts:1218` | Gains `extensions` when the flag is on |
| `buildDiscoverResult()` | `services/mcpModernResult.ts:68` | Gains `extensions` when the flag is on |
| `handleToolsList(id, scopes, auth, params?, apiKey?)`; entry = `{...buildMcpToolPresentation(...), name, description, inputSchema}` | `routes/mcpServer.ts:1547`, `:1655` | Gains a `clientExtensions` parameter; `_meta.ui` merged into one entry |
| `buildMcpToolPresentation` → `_meta: { 'app.breeze/domain': domain }` | `services/mcpToolPresentation.ts:32` | Unchanged; the merge happens in `handleToolsList` |
| `handleResourcesRead(id, params, auth, domainGrant)`; unknown URI → `-32602 "Unknown resource URI: <uri>"` | `routes/mcpServer.ts:3142`, `:3159` | `ui://` branch before the unknown-URI check |
| `MCP_RESOURCE_PERMISSIONS` / `MCP_RESOURCE_DOMAINS` | `routes/mcpServer.ts:3022`, `services/mcpDomains.ts:78` | No permissions row (the app branch runs first, D-B43); one exact `MCP_RESOURCE_DOMAINS` row |
| Tier-1 listing has no RBAC check (`if (tier <= 1) return true`) | `routes/mcpServer.ts:1606` | Why D-B43 adds an explicit `devices.read` check |
| `structuredFromSafeText` (undefined for arrays, `summarized:true` digests, pure returned errors) | `routes/mcpServer.ts:1785` | Read only — it is what the view renders |
| Per-request audit row in `dispatchAndAudit` | `routes/mcpServer.ts:717` | `details.uiExtension: true` when declared |
| Per-call flag reader pattern (kept out of `config/env.ts`, which mcpServer suites mock narrowly) | `services/mcpIntentConfig.ts` | `services/mcpAppsConfig.ts` copies it |
| `get_fleet_health` (tier 1, domain `devices`, `alwaysLoad`, RBAC `devices.read`) | `services/aiToolsUserRisk.ts:63`, `aiGuardrails.ts:1466` | The pilot tool. Untouched. |

**Migration:** none. **New table / column:** none (D-B41).

---

## Advisor quorum, 2026-10-23

**Procedure.** I wrote a position first (P1–P11 for this wave, S1–S11 for B-W06, nine questions) against `afcb08c2d4`. Codex `gpt-6-astra` at `xhigh`, read-only, critiqued it. Both waves went to one run so the shared seams were judged together.

**Verdicts (B-W05).** P2, P7 and P8: **agree**. P1, P3, P4, P5, P6, P9, P10 and P11: **agree-with-changes**. Nothing was disagreed.

**One blocking finding, adopted and verified by reading the code.** P6 assumed that "the tool is listed" implies the caller passes `devices.read`. It does not. `handleToolsList` returns `true` for any tier-1 tool once the domain is granted, with no RBAC check (`mcpServer.ts:1606`). And `handleResourcesRead`'s permission → domain → RBAC chain answers each failure with a different body (`:3157-3173`), so routing the app URI through it would not give the promised uniform denial. → D-B43 now defines one explicit predicate, `isMcpAppAvailable` (flag, declared extension, listed, `devices.read`), shared by `tools/list` and `resources/read`. For a registered app URI, every failure of that predicate answers the exact unknown-URI body.

**Other adopted changes:**
- **Labels (P1).** The summary is labelled "matching devices" and the table "this page". "Worst first" is claimed only at offset 0. The record also states that the spec's two candidates and B-W04's approval-card idea are deferred.
- **Exact URIs (P2).** App URIs resolve by exact string match against the registry, never by a version-wildcard regex.
- **View input checks (P3).** The view validates message source, JSON-RPC shape and handshake order. It buffers a result that arrives before initialization. It renders non-finite numbers as "—". It treats the compactor's in-band truncation marker strings and `_chat` stats as partial data and shows a warning instead of dropping them (`aiToolOutput.ts:301`).
- **No advertisement on the deprecated transport (P4).** `buildInitializeResult` is shared with HTTP+SSE `/message` (`:1249`), so it never advertises Apps there.
- **Legacy-era handling (P5).** The legacy declaration is resolved on `tools/call` too, or the go/no-go audit (P9) could never see it. The side key is read only after session ownership is verified, and it shares the session's absolute, non-refreshing lifetime.
- **Audit detail (P9).** Successful audit rows carry neither tool name nor URI today (`:695`, `:740`). The app requests now record a bounded `mcpApp` identifier. The thresholds have explicit denominators. View fetches are not renders.
- **Tier check (P10).** The registry contract checks the **effective** tier of every action, using the presentation's logic (`mcpToolPresentation.ts:38`). The static scan is a guardrail, not an XSS proof.
- **Extra tests (P11).** Added: partial structured results, malformed messages, an RBAC denial, Redis expiry and a foreign session, a result before initialization. Jsdom cannot prove CSP or host behaviour, so a real-host lab leg is required (Task 7).

**Q2 (which era Apps hosts speak).** The public client matrix lists Apps support in Claude web/Desktop, ChatGPT and VS Code. It does not establish their core protocol versions, and the Apps specification negotiates through `initialize`, which Breeze classifies as legacy. Both reviewers keep legacy streamable support. Task 7 captures real handshakes before anyone claims host versions.

**Disagreements left open:** none.

## Decisions

Numbering continues B-W04's D-B25…D-B37.

- **D-B38 — The pilot tool is `get_fleet_health`.**
  - Read-only by construction: one action, tier 1, `readOnlyHint: true`, RBAC `devices.read`. An app attached to a mixed tool would also render that tool's write results; `_meta.ui` is per tool, not per action.
  - Hot: one of the 14 `alwaysLoad: true` registry tools (A-W04's 15-tool set adds `propose_action_plan`, `services/aiTools.ts:513`) and in A-W01's hot list (baseline doc §7.4).
  - Visual payoff: it already returns `{ devices: [...], showing, limit, offset, total, totalMode, hasMore, nextCursor, summary: { criticalDevices, poorDevices, fairDevices, goodDevices, degradingDevices, … } }` (`aiToolsUserRisk.ts:131-148`) — a score-band bar plus a worst-first table reads far better than JSON.
  - Rejected: `manage_alerts` (the spec's "alert triage board"; mixed tier 1/2, and a triage board implies acknowledge/resolve buttons, i.e. writes from the view — out of scope for a pilot, Gate B 1); `list_time_entries` (the spec's "timesheet review"; not hot, and review implies approve writes); `query_devices` (plain table, little gain); `get_device_details` (single device, large shaped payload).
  - This **replaces** the spec's two named candidates and defers B-W04 D-B36's "approval card renders `McpActionStatus`" idea: an approval card is a Tier-3 surface whose view would want to act, and it belongs after the go/no-go (D-B44), not in the pilot.
  - Honest labels: the summary counts every **matching** device (the handler's filters apply to it, `aiToolsUserRisk.ts:127-131`); the table is **the returned page**. "Worst first" is printed only when `offset === 0`.
- **D-B39 — The view is static, self-contained and display-only.**
  - URI `ui://breeze/fleet-health/v1`. The version segment is bumped on any change a cached older host could misrender (hosts MAY cache). Name `Breeze fleet health`, mimeType `text/html;profile=mcp-app`.
  - Source: `apps/api/src/services/mcpApps/fleetHealthView.ts` exports `FLEET_HEALTH_VIEW_HTML: string` — one HTML5 document, inline `<style>` and one inline `<script>`, no `src`/`href` to any origin, ≤ 64 KiB. A TS string avoids a build copy step for a `.html` asset in the API image.
  - Resource `_meta.ui = { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true }`. Empty lists mean the host's restrictive default: no network, no remote scripts, fonts or images. No `domain`, no `permissions`.
  - Behaviour: sends `ui/initialize` (`protocolVersion: "2026-01-26"`), then `ui/notifications/initialized`; renders on `ui/notifications/tool-result`; ignores `tool-input`/`tool-input-partial`; shows a cancelled line on `tool-cancelled`; posts `ui/notifications/size-changed` after each render. Messages are accepted only when `event.source === window.parent`, `event.data` is a plain object with `jsonrpc === '2.0'`, and `method` (or a response `id` matching its own `ui/initialize`) is one it knows; anything else is dropped silently. A `tool-result` that arrives before the `ui/initialize` response is buffered (latest wins) and rendered once the handshake completes.
  - Rendering rule: build the DOM with `document.createElement` + `textContent` only. Never `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `Function`, `setTimeout(string)`. Hostnames and every other value are tenant-controlled input. Numbers render only when `Number.isFinite`; anything else renders `—`.
  - Partial data is shown, not hidden: a non-object element in `devices` (the compactor's in-band truncation marker string, `services/aiToolOutput.ts:301-330`) or a `_chat` key on the payload renders a "Partial result — the server shortened this output" banner; marker strings are never rendered as rows.
  - Fallback inside the view: if `structuredContent` is absent or lacks a `devices` array and a `summary` object (an 8 k-cap digest, a returned error, a future shape), render `content[0].text` verbatim in a `<pre>` via `textContent`. The view never fails blank.
  - Display-only: the view sends no `tools/call`, `resources/read`, `ui/message`, `ui/open-link` or `ui/update-model-context`. Tool `_meta.ui.visibility = ["model"]`, so a host also rejects any app-initiated call (defence in depth). Paging stays with the model (`nextCursor` is shown as "N more — ask for the next page"). Gate B 2.
  - English only (no i18n framework in a 64 KiB static view). Gate B 3.
- **D-B40 — The text fallback is the current result, byte for byte.**
  - `tools/call` for `get_fleet_health` is not touched: same `content[0].text`, same `structuredContent`, no `_meta` on the result, whatever the client declared and whatever the flag. A parity test deep-equals the result for a declaring and a non-declaring client (Task 5).
  - The only per-client differences when the flag is on and the client declared: the one `tools/list` entry gains `_meta.ui`, and `resources/read` of the app URI succeeds. With the flag on, streamable `initialize` and `server/discover` advertise `capabilities.extensions["io.modelcontextprotocol/ui"] = {}` to every client on those transports (a server capability; old clients ignore unknown keys). `buildInitializeResult` is also used by the deprecated HTTP+SSE `/message` transport (`mcpServer.ts:1249`), which never gets Apps, so it takes `{ advertiseApps: boolean }` and `/message` passes `false`.
  - Parity is per era: a legacy and a modern call return the same tool result modulo B-W03's documented decoration, exactly as today.
  - Flag off: every response is byte-identical to today (snapshot tests).
- **D-B41 — No table, no column, no migration.** Negotiated extensions are request state (modern) or session state in an ephemeral Redis key (legacy). Nothing tenant-scoped is stored. `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` and `CORE_TENANT_EXPORT_POLICY` are untouched; nothing to register.
- **D-B42 — Capability negotiation.**
  - `parseMcpClientExtensions(caps: unknown): McpClientExtensions` (pure, `services/mcpClientExtensions.ts`) → `{ ui: boolean }`. `ui` is true only when `caps.extensions["io.modelcontextprotocol/ui"].mimeTypes` is an array containing the exact string `text/html;profile=mcp-app`. Anything else — missing, `{}`, wrong type, other mime types only — is false. B-W06 adds `tasks` to the same type.
  - Modern era: parsed from the request's `clientCapabilities` on every request.
  - Legacy streamable era: on `initialize`, parse `params.capabilities`; when `ui` is true write `mcp:session-ext:<sid>` = `'{"ui":true}'` with `MCP_SESSION_TTL_SECONDS` immediately after the existing `setex` (same absolute, never-refreshed lifetime as the ownership key, `mcpServer.ts:1033`, `:1077`). It is read only after the session's ownership check has passed, and only when `mcpAppsEnabled()` and the method is `tools/list`, `resources/read` or `tools/call` (the last so D-B44 can count app calls); a miss, a parse failure or any Redis error → `{ ui: false }`. Every failure degrades to the text-only experience, never to an error. With the flag off no side key is ever read or written. Cost: one extra Redis GET on those three legacy methods while the flag is on (the request already does one GET for session ownership); folding the flag into the ownership value instead would change a security-critical key's format, which is why it is a side key.
  - Deprecated HTTP+SSE (`/message`): always `{ ui: false }`.
  - Re-`initialize` mints a new session id, so a client that stops declaring the extension simply has no side key.
- **D-B43 — Gating: one predicate, `isMcpAppAvailable`.** (Quorum blocking fix.) Tier-1 listing does **not** check RBAC (`mcpServer.ts:1606`), so "the tool is listed" is not enough. The predicate, in `services/mcpApps/registry.ts`, is all of:
  - `mcpAppsEnabled()`;
  - `clientExtensions.ui`;
  - the tool passes `handleToolsList`'s existing filters for this caller (scope, domain grant, wholly-gated/MFA suppression). Those filters are extracted into `isToolListedForCaller(tool, listingContext)` without behaviour change, so the predicate calls the same code;
  - `checkPermissionRequirement(auth, { resource: 'devices', action: 'read' })` passes. The permission is the app's registered `permission`, the same one `TOOL_PERMISSIONS.get_fleet_health` names (`aiGuardrails.ts:945`, entry `:1466`; checked by `checkPermissionRequirement`, `:2787`), and the contract asserts they are equal.

  How each surface uses it:
  - **`tools/list`.** If the predicate holds, `_meta.ui = { resourceUri: 'ui://breeze/fleet-health/v1', visibility: ['model'] }` is merged into the existing `_meta`, keeping `app.breeze/domain`. If not, the entry is today's.
  - **`resources/read`.** A URI that matches a registered app **exactly** (`findMcpAppByUri`) is handled in a branch **before** `findMcpResourcePermission`. Any predicate failure (flag, declaration, scope, domain or RBAC) answers the exact unknown-URI error, `-32602` `Unknown resource URI: <uri>`, the same as before W05. There is no oracle and no differing domain/RBAC bodies, because a caller who fails the predicate was never shown the URI. On success the result is `contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: FLEET_HEALTH_VIEW_HTML, _meta: { ui: {...} } }]`, with no DB read.
  - **Non-matching URIs.** Any other `ui://` URI, including `ui://breeze/fleet-health/v2`, falls through to today's unknown-URI path.
  - **Domain contract.** `MCP_RESOURCE_PERMISSIONS` gets no row. `MCP_RESOURCE_DOMAINS` gets one exact-match row, `devices`, so `mcpResourceDomain` stays truthful for audit and the domain contract.
  - `resources/list` and `resources/templates/list` do not list the app (spec MAY). Both stay byte-identical for every client.
  - The resource carries no tenant data, so the gate is about not advertising an app a caller cannot use, not about confidentiality.
- **D-B44 — Go/no-go measurement, no new storage.** Successful MCP audit rows carry no tool name or URI today; only domain denials do (`mcpServer.ts:695`, `:740`). The fix is two `details` keys in `dispatchAndAudit`, both absent unless set, so existing rows and queries are unchanged:
  - `uiExtension: true` when the request's client declared the extension (resolved per D-B42);
  - `mcpApp: 'fleet-health/v1'` (the app's registry key, bounded, never caller text) on a `resources/read` of the app URI and on a `tools/call` of the app's tool. `result` stays the row's existing success/failure.

  A view **fetch** is not a **render**, because hosts may prefetch and cache, so the numbers are a ceiling on use. Todd runs the decision query on EU and US 30 days after the flag goes on. `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md` gets a dated section with the output.
  ```sql
  SELECT count(DISTINCT actor_id) FILTER (WHERE details->>'uiExtension' = 'true')                                  AS ui_capable_principals,
         count(DISTINCT actor_id) FILTER (WHERE action = 'mcp.resources.read' AND details->>'mcpApp' = 'fleet-health/v1' AND result = 'success') AS view_fetchers,
         count(DISTINCT actor_id) FILTER (WHERE action = 'mcp.tools.call'     AND details->>'mcpApp' = 'fleet-health/v1' AND details->>'uiExtension' = 'true') AS ui_tool_callers,
         count(*)                 FILTER (WHERE action = 'mcp.tools.call'     AND details->>'mcpApp' = 'fleet-health/v1' AND details->>'uiExtension' = 'true') AS ui_tool_calls
  FROM audit_logs
  WHERE resource_type = 'mcp_request' AND "timestamp" > now() - interval '30 days';
  ```
  **Go** for a second app when, summed over both regions, `ui_tool_callers ≥ 5` **and** `ui_tool_calls ≥ 50` (the denominator is `ui_capable_principals`, reported alongside). Otherwise **stop**: leave the pilot on and build nothing more (Gate B 5).
- **D-B45 — Kill switch.** `MCP_APPS_ENABLED` (`mcpAppsEnabled()` in `services/mcpAppsConfig.ts`, the `mcpIntentConfig.ts` reader pattern, read per call), default **off**. Boot validation in `config/validate.ts` like the B-W04 flags. Works in both eras; independent of `MCP_STATELESS_ENABLED` and `MCP_TIER3_INTENTS_ENABLED`.
- **D-B46 — An app registry of one.** `services/mcpApps/registry.ts` exports `MCP_APPS: readonly McpAppDefinition[]`, which holds the single fleet-health entry. A contract test holds every entry to the pilot's rules:
  - **Effective tier 1 and read-only for every action**, judged by the same per-action logic `buildMcpToolPresentation` uses for `readOnlyHint` (`mcpToolPresentation.ts:38`). The tool also must not be in `MCP_APPROVAL_REQUIRED_EXTRA_TOOLS`, which feeds the MCP tier floor.
  - **Matching domain:** the resource domain equals the tool domain.
  - **Matching permission:** the registered permission equals the tool's guardrail permission.
  - **Static-safety scan.**
  - **Size cap.**

  The scan is a guardrail against obvious regressions, not a proof against XSS. That proof is the jsdom hostile-input tests plus the real-host lab. A second app is one row plus its own view, and the contract decides whether it is allowed.

## Open Decisions (Gate B — for Todd)

The plan's default is in brackets and is what the tasks implement.

1. **Pilot tool.** [`get_fleet_health`.] Alternative: the spec's alert triage board on `manage_alerts` — mixed tier, and only useful with acknowledge/resolve buttons, i.e. writes from inside the view.
2. **View interactivity.** [Display-only, `visibility: ["model"]`; paging stays with the model.] Alternative: `visibility: ["model","app"]` and a "next page"/"refresh" button that calls `get_fleet_health` back through the host (no new authority — the host uses the same connection — but the view then needs request/response plumbing and error states).
3. **Locale.** [English only.] Alternative: ship the 8 locales' strings inline and pick from the host context's `locale` (adds ~6 KiB and a second parity test).
4. **Legacy era.** [Supported through the Redis side key, because today's Apps hosts mostly connect with `initialize`.] Alternative: modern era only, like URL elicitation — no Redis key, but most hosts would never see the app until they adopt `2026-07-28`.
5. **Go/no-go threshold** (the D-B44 query, over the first 30 days the flag is on in each region, summed): [`ui_tool_callers ≥ 5` **and** `ui_tool_calls ≥ 50` → plan a second app; otherwise leave the pilot on and stop. View fetches are reported but are only a ceiling.]
6. **Rollout.** [Off in the release that ships it; on in EU after the lab run (Task 7), then US.]

---

## Global Constraints

- **Commands.** API unit tests: `cd apps/api && npx vitest run <path>` — a substring match, so check the file count. Never `pnpm --filter <pkg> test -- --run <path>`. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` — read the exit code, never pipe to `tail`. CI also runs `tsc --build tsconfig.tests.json` (strict index access in tests).
- **Byte-identity.** Flag off → `initialize`, `server/discover`, `tools/list`, `resources/list`, `resources/templates/list`, `resources/read` and `tools/call` responses are unchanged. Flag on → `tools/call` is unchanged for every client.
- **No new authority.** The app is listed only where the tool is listed, readable only where a known resource of its domain is readable, and the view calls nothing.
- **Tenant data is hostile input in the view.** DOM + `textContent` only (D-B39).
- **No network from the view.** No absolute URL (`http:`, `https:`, `//`) anywhere in the HTML; CSP lists empty.
- **Never rename a tool; never change `get_fleet_health`'s output.** The view adapts to the tool, not the reverse.
- **Public repo.** No customer names, hostnames or IPs in fixtures; hostnames in tests are `ws-01.example.test`-style.
- **New services file trap.** A new file under `apps/api/src/services/` must be classified in `parkedFanout.contract.test.ts` (Lint job) — Tasks 1, 2 and 3 each add one.
- **Commit after every task.** Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage explicitly, never `git add -A`.

## Tenancy

No table, no column, no RLS change (D-B41). `audit_logs.details` gains one optional boolean key inside an existing `jsonb` column (already `excludedOpen`); no export-policy row changes. No contract suite needs to run for tenancy reasons; the integration shard still runs in CI.

## Review Focus

1. **A hostname like `<img src=x onerror=…>` or `</script><script>…`** reaches the view through `structuredContent.devices[].hostname`. It renders as literal text; no element is created from it. `renders hostile hostnames as text` (Task 3).
2. **The tool result is an 8 k-cap digest (`summarized: true`) or a returned error**, so `structuredContent` is absent. The view shows the text verbatim instead of a blank frame. `falls back to the text content when structuredContent is absent` (Task 3).
3. **A domain-restricted key without `devices`, or a role without `devices.read`,** declares the extension. It gets no `_meta.ui`, and `resources/read` of the app answers the exact unknown-URI body, never the HTML and never a domain/RBAC body that would confirm the app exists. `restricted grant or missing devices.read: no _meta.ui and no view` (Tasks 4, 5).
4. **Redis is down or the side key expired** while the legacy session itself is still accepted (the session key is checked on a different code path). The client gets the plain text experience; no 5xx. `side-key miss or Redis error degrades to text-only` (Task 2).
5. **A client sends `extensions: { "io.modelcontextprotocol/ui": {} }` or `mimeTypes: ["text/html"]`.** Not declared; nothing changes for it. `parser rejects every non-exact declaration` (Task 1).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/mcpClientExtensions.ts` (new) | `McpClientExtensions`, `parseMcpClientExtensions`, `MCP_UI_EXTENSION_ID`, `MCP_APP_MIME_TYPE`, legacy side-key helpers. Pure except the two Redis helpers (Redis injected). |
| `apps/api/src/services/mcpAppsConfig.ts` (new) | `mcpAppsEnabled()`. |
| `apps/api/src/services/mcpApps/fleetHealthView.ts` (new) | `FLEET_HEALTH_VIEW_HTML`. |
| `apps/api/src/services/mcpApps/registry.ts` (new) | `McpAppDefinition`, `MCP_APPS`, `findMcpAppByUri`, `findMcpAppByTool`, `isMcpAppAvailable`, `mcpAppToolMeta`, `mcpAppResourceContents`. |
| `apps/api/src/routes/mcpServer.ts` (modify) | Dispatch-context resolver, legacy side key on `initialize`, transport-aware `extensions` in `buildInitializeResult`, `isToolListedForCaller` extracted from `handleToolsList`, `_meta.ui` merge, exact-URI app branch in `handleResourcesRead`, audit details. |
| `apps/api/src/services/mcpModernResult.ts` (modify) | `buildDiscoverResult` advertises the extension when the flag is on. |
| `apps/api/src/services/mcpDomains.ts` (modify) | `MCP_RESOURCE_DOMAINS` row. |
| `apps/api/src/config/validate.ts`, root `.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`, `apps/api/src/system/connections/internalEnvVars.ts` (modify) | `MCP_APPS_ENABLED` validated, documented and passed into the container. |
| `apps/api/package.json` (modify) | devDependency `jsdom` at the version `apps/web` uses (`^30.0.1`) for the view test. |
| `apps/docs/src/content/docs/features/mcp-server.mdx` (modify) | "MCP Apps (preview)" section. |

---

### Task 1: `mcpClientExtensions.ts` and `mcpAppsConfig.ts` — the negotiation parser and the flag

**Files:** Create `services/mcpClientExtensions.ts` + `.test.ts`, `services/mcpAppsConfig.ts` + `.test.ts`. Modify `config/validate.ts` (accept `MCP_APPS_ENABLED` with the boolean vocabulary, as the B-W04 flags), root `.env.example` (after `MCP_APPROVAL_WAITS_PER_PRINCIPAL`), `parkedFanout.contract.test.ts` (classify both files), and the **container passthrough** — without it the flag can never be turned on in a deployed stack or the lab: `docker-compose.yml` (next to `MCP_TIER3_INTENTS_ENABLED`, `:626`) and `deploy/docker-compose.prod.yml` (next to `:595`) get `MCP_APPS_ENABLED: ${MCP_APPS_ENABLED:-}`, and `apps/api/src/system/connections/internalEnvVars.ts` (`:319-322`) gets `MCP_APPS_ENABLED: 'MCP rollout flag'`. The guards are `src/config/envReadComposeCoverage.test.ts` and `src/system/connections/envInventory.test.ts` — run both in Step 4.

**Interfaces — Produces:**
```ts
export const MCP_UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export type McpClientExtensions = { readonly ui: boolean };
export const NO_MCP_CLIENT_EXTENSIONS: McpClientExtensions;            // { ui: false }, frozen
export function parseMcpClientExtensions(caps: unknown): McpClientExtensions;
export const MCP_SESSION_EXT_REDIS_PREFIX = 'mcp:session-ext:';
export function writeLegacySessionExtensions(redis: Redis | null, sessionId: string, ext: McpClientExtensions, ttlSeconds: number): Promise<void>; // no-op unless ext.ui; swallows + logs errors
export function readLegacySessionExtensions(redis: Redis | null, sessionId: string | undefined): Promise<McpClientExtensions>;           // never throws
// mcpAppsConfig.ts
export function mcpAppsEnabled(): boolean;   // MCP_APPS_ENABLED, default false
```
- [ ] **Step 1: Write the failing tests.**
  ```ts
  it('declared only with the exact mime type', () => {
    expect(parseMcpClientExtensions({ extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } } })).toEqual({ ui: true });
  });
  it.each([undefined, null, {}, { extensions: {} }, { extensions: { [MCP_UI_EXTENSION_ID]: {} } },
    { extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: 'text/html;profile=mcp-app' } } },
    { extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: ['text/html'] } } },
    { extensions: [] }])('parser rejects every non-exact declaration: %j', (caps) => expect(parseMcpClientExtensions(caps)).toEqual({ ui: false }));
  it('side key round-trips with the session TTL', async () => { /* fake redis: setex called with ('mcp:session-ext:<sid>', ttl, '{"ui":true}') */ });
  it('writes nothing when ui is false', ...);
  it('side-key miss or Redis error degrades to text-only', async () => {
    expect(await readLegacySessionExtensions(null, 'sid')).toEqual({ ui: false });
    expect(await readLegacySessionExtensions(throwingRedis, 'sid')).toEqual({ ui: false });
    expect(await readLegacySessionExtensions(redisReturning('not json'), 'sid')).toEqual({ ui: false });
    expect(await readLegacySessionExtensions(redisReturning(null), undefined)).toEqual({ ui: false });
  });
  it.each([['true', true], ['1', true], ['', false], [undefined, false], ['off', false]])('MCP_APPS_ENABLED=%s → %s', ...);
  ```
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/mcpClientExtensions.test.ts src/services/mcpAppsConfig.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement.** The stored value is parsed back through `parseMcpClientExtensions`-equivalent strict checking (`JSON.parse` then `=== true`), never trusted as an object.
- [ ] **Step 4:** Same command → PASS. Also `npx vitest run src/config/validate.test.ts src/config/envReadComposeCoverage.test.ts src/system/connections/envInventory.test.ts`.
- [ ] **Step 5:** Commit `feat(mcp): client-extension negotiation parser and MCP_APPS_ENABLED (B-W05 #6159)`.

### Task 2: Thread negotiated extensions through dispatch (both eras) and advertise the extension

**Files:** Modify `routes/mcpServer.ts`:
- **`McpDispatchContext` (`:708-715`).** It gains `resolveClientExtensions`. The modern handler (`:1170-1204`) wraps the value it parses from `meta.clientCapabilities`.
- **Legacy streamable handler.** It parses `initialize` `params.capabilities` and calls `writeLegacySessionExtensions` right after the existing `setex` (`:1033`), only when `mcpAppsEnabled()`. For non-initialize requests its resolver calls `readLegacySessionExtensions(redis, trustedSessionId)` lazily: only after the ownership check, only when the flag is on, and only for `tools/list`, `resources/read` and `tools/call`.
- **`/message`.** Its resolver returns `NO_MCP_CLIENT_EXTENSIONS`.
- **`buildInitializeResult` (`:1218`, exported; one dispatch call site at `:1250`).** It gains an optional `opts?: { advertiseApps?: boolean }` (default `false`, so existing one-argument callers are unchanged) and adds `extensions: { [MCP_UI_EXTENSION_ID]: {} }` inside `capabilities` only when `opts.advertiseApps && mcpAppsEnabled()`. Both transports reach `:1250` with `era: 'legacy'`, so `McpDispatchContext` gains `transport: 'http_sse' | 'streamable'` (set at `:863` and `:1155`; modern is always `streamable`) and the call passes `advertiseApps: ctx.transport === 'streamable'`.
- **`dispatchAndAudit` (`:717`).** It writes `uiExtension: true` in `details` when the request resolved `ui`, plus `mcpApp` per D-B44 (set by Task 4's branches through a small per-request audit-extras object on the context).

Also modify `services/mcpModernResult.ts` (`buildDiscoverResult` advertises the same key when the flag is on). Tests: create `routes/mcpServer.apps.test.ts` (copy the harness from `mcpServer.modern.test.ts` for the modern era and `mcpServer.initialize.test.ts` for legacy) and extend `services/mcpModernResult.test.ts`.

**Interfaces:**
- Consumes Task 1.
- Produces:
  - `McpDispatchContext.transport: 'http_sse' | 'streamable'`.
  - `McpDispatchContext.resolveClientExtensions: () => Promise<McpClientExtensions>`, memoised per request and never throwing.
  - `McpDispatchContext.auditExtras: { mcpApp?: string }` — a mutable per-request object; handlers write it and `dispatchAndAudit` reads it **after** `handleJsonRpc` returns (it already writes the audit row after dispatch, `:723-724`).
  - `handleToolsList`, `handleResourcesRead` and `handleToolsCall` receive the resolved `McpClientExtensions` value. They never receive the thunk.

- [ ] **Step 1: Write the failing tests.**
  - `flag on: streamable initialize and server/discover advertise extensions["io.modelcontextprotocol/ui"] = {}`; `flag off: both deep-equal today's snapshot` (store today's bodies as inline snapshots before implementing); `HTTP+SSE /message initialize never advertises it, flag on or off`.
  - `legacy initialize declaring ui writes the side key with MCP_SESSION_TTL_SECONDS right after the ownership key; not declaring, or flag off, writes nothing`.
  - `legacy tools/list, resources/read and tools/call read the side key at most once per request; prompts/list never does; flag off never does` (spy on `redis.get` for the `mcp:session-ext:` prefix).
  - `a session presented by a foreign principal is rejected before any side-key read` (existing 404 path; spy asserts no `mcp:session-ext:` read).
  - `modern request declaring ui resolves ui` (asserted through the audit row).
  - `audit details carry uiExtension: true only when declared; key absent otherwise`.
  - `/message (HTTP+SSE) never resolves ui`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/mcpServer.apps.test.ts src/services/mcpModernResult.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Green; rerun `src/routes/mcpServer.initialize.test.ts src/routes/mcpServer.modern.test.ts src/routes/mcpServer.streamable.test.ts src/routes/mcpServer.statelessParity.contract.test.ts src/routes/mcpServer.conformance.contract.test.ts` (flag unset there → unchanged).
- [ ] **Step 5:** Typecheck; commit `feat(mcp): negotiate the MCP Apps extension in both eras (B-W05 #6159)`.

### Task 3: The fleet-health view and the app registry

**Files:** Create `services/mcpApps/fleetHealthView.ts`, `services/mcpApps/registry.ts`, `services/mcpApps/fleetHealthView.test.ts` (first line `// @vitest-environment jsdom`), `services/mcpApps/registry.contract.test.ts`. Modify `apps/api/package.json` (devDependency `jsdom`, then `pnpm install`), `parkedFanout.contract.test.ts`.

**Interfaces — Produces:**
```ts
// registry.ts
export type McpAppDefinition = { readonly key: string; readonly toolName: string; readonly resourceUri: `ui://breeze/${string}`;
  readonly name: string; readonly html: string; readonly permission: { resource: string; action: 'read' } };
export const MCP_APPS: readonly McpAppDefinition[];   // exactly one: { key: 'fleet-health/v1', toolName: 'get_fleet_health', resourceUri: 'ui://breeze/fleet-health/v1', name: 'Breeze fleet health', html: FLEET_HEALTH_VIEW_HTML, permission: { resource: 'devices', action: 'read' } }
export const MCP_APP_RESOURCE_UI_META: { readonly csp: { connectDomains: []; resourceDomains: [] }; readonly prefersBorder: true };
export const MCP_APP_MAX_HTML_BYTES = 65_536;
export function findMcpAppByTool(toolName: string): McpAppDefinition | undefined;
export function findMcpAppByUri(uri: string): McpAppDefinition | undefined;   // exact string equality, never a pattern
export function isMcpAppAvailable(i: { flagOn: boolean; declared: boolean; listedForCaller: boolean; permissionGranted: boolean }): boolean; // pure AND; D-B43
export function mcpAppToolMeta(app: McpAppDefinition): { ui: { resourceUri: string; visibility: ['model'] } };
export function mcpAppResourceContents(app: McpAppDefinition): { contents: [{ uri: string; mimeType: typeof MCP_APP_MIME_TYPE; text: string; _meta: { ui: typeof MCP_APP_RESOURCE_UI_META } }] };
```
- [ ] **Step 1: Write the failing tests.**
  - View (`jsdom`; load `FLEET_HEALTH_VIEW_HTML` into a `JSDOM` with `runScripts: 'dangerously'`, stub `window.parent.postMessage`, dispatch `MessageEvent`s with `source: window.parent`):
    ```ts
    it('initializes, then renders summary bands and the worst-first table from structuredContent', () => {
      // after ui/initialize response + tool-result with FIXTURE (3 devices, summary {criticalDevices:1,…})
      expect(q('[data-testid="fh-band-critical"]').textContent).toContain('1');
      expect(qa('[data-testid="fh-row"]').map(r => r.querySelector('[data-testid="fh-host"]')!.textContent)).toEqual(['ws-01.example.test','ws-02.example.test','ws-03.example.test']);
    });
    // Inject the hostile strings into EVERY string field the view renders (hostname, trendDirection, osType, status, computedAt), not only hostname.
    it('renders hostile hostnames as text', () => {
      // hostname '<img src=x onerror="window.__pwned=1">' and '</script><script>window.__pwned=1</script>'
      expect(dom.window.document.querySelectorAll('img, script:not([data-view])').length).toBe(0);
      expect((dom.window as any).__pwned).toBeUndefined();
      expect(q('[data-testid="fh-host"]').textContent).toBe('<img src=x onerror="window.__pwned=1">');
    });
    it('falls back to the text content when structuredContent is absent', () => {
      // tool-result { content:[{type:'text', text:'{"summarized":true,…}'}] }
      expect(q('[data-testid="fh-fallback"]').textContent).toBe('{"summarized":true,…}');
    });
    it('shows "N more" when hasMore, never fetches', ...);   // spies: fetch/XMLHttpRequest/WebSocket never called
    it('labels the summary "matching devices" and says "worst first" only at offset 0', ...);
    it('shows a partial-result banner for truncation marker strings and _chat, never a marker row', ...); // fixture: devices: [row, row, '...[truncated 12 items]'], _chat: {...}
    it('renders non-finite numbers as —', ...);           // reliabilityScore: null / 'NaN' / Infinity
    it.each(['not an object', { jsonrpc: '1.0' }, { jsonrpc: '2.0', method: 'ui/unknown' }, { jsonrpc: '2.0', id: 999, result: {} }])('ignores malformed message %j', ...);
    it('ignores messages not from window.parent', ...);
    it('buffers a tool-result that arrives before the initialize response and renders it after', ...);
    it('posts size-changed after render', ...);
    it('sends no tools/call, resources/read, ui/message or ui/open-link', () => { /* every postMessage method ∈ {ui/initialize, ui/notifications/initialized, ui/notifications/size-changed} */ });
    ```
    The inline `<script>` carries `data-view` so the hostile-input assertion can exclude it.
  - Registry contract:
    ```ts
    it.each(MCP_APPS)('$toolName is effective tier 1 and read-only for every action', (app) => { /* getToolTier === 1; not in TIER3_ACTIONS / TIER2_ACTIONS for any action; buildMcpToolPresentation(...).annotations.readOnlyHint === true. mcpTierFloor and MCP_APPROVAL_REQUIRED_EXTRA_TOOLS (:1332) are private to mcpServer.ts — this task exports MCP_APPROVAL_REQUIRED_EXTRA_TOOLS (read-only) and asserts the app tool is absent from it */ });
    it.each(MCP_APPS)('$resourceUri domain equals the tool domain', (app) => expect(mcpResourceDomain(app.resourceUri)).toBe(mcpToolDomain(app.toolName)));
    it.each(MCP_APPS)('$key permission equals the tool guardrail permission', (app) => expect(app.permission).toEqual(TOOL_PERMISSIONS[app.toolName]));   // aiGuardrails.ts:945; a flat {resource, action} entry, never a per-action map
    it('isMcpAppAvailable is a strict AND', () => { /* 16-row truth table, only all-true → true */ });
    it('findMcpAppByUri is exact', () => { expect(findMcpAppByUri('ui://breeze/fleet-health/v2')).toBeUndefined(); expect(findMcpAppByUri('ui://breeze/fleet-health/v1?x')).toBeUndefined(); });
    it.each(MCP_APPS)('$name html passes the static-safety scan', (app) => {
      expect(Buffer.byteLength(app.html)).toBeLessThanOrEqual(MCP_APP_MAX_HTML_BYTES);
      expect(app.html.startsWith('<!doctype html>')).toBe(true);
      for (const banned of [/https?:/i, /["'(]\/\//, /\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /\bFunction\s*\(/, /<script[^>]*\ssrc=/i, /<link\b/i, /<iframe\b/i, /@import/i, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /\bset(Timeout|Interval)\s*\(\s*["'`]/, /javascript:/i, /\bsrcdoc\b/i]) expect(app.html).not.toMatch(banned);
    });
    it('resource URIs are unique and versioned', () => MCP_APPS.forEach(a => expect(a.resourceUri).toMatch(/^ui:\/\/breeze\/[a-z-]+\/v\d+$/)));
    ```
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/mcpApps` → FAIL.
- [ ] **Step 3: Implement the view.**
  - **Header.** `Fleet reliability · <total> matching devices`, plus `showing <showing> (offset <offset>)` when `offset > 0`.
  - **Band bar.** A stacked bar for critical ≤ 50, poor 51–70, fair 71–85 and good ≥ 86, with counts. These are the bands `summarizeReliabilityDevices` uses (`reliabilityScoring.ts:1942-1945`).
  - **Degrading chip.**
  - **Table.** Captioned "This page" (or "Worst first" at offset 0), with columns from the real row keys (`aiToolsUserRisk.ts:44-52`, `reliabilityScoring.ts:187-212`): `hostname`, `reliabilityScore`, `trendDirection`, `uptime30d`, `crashCount30d`, `hangCount30d`, `serviceFailureCount30d`, `hardwareErrorCount30d`, `topIssueCount`; rows with `provisional: true` are marked. The header's total is the top-level `total` (the `summary` object has no `total`; its `averageScore` is shown beside the bands).
  - **Colours.** CSS variables, with a `prefers-color-scheme: dark` block.

  Add the exact `MCP_RESOURCE_DOMAINS` row (`{ pattern: /^ui:\/\/breeze\/fleet-health\/v1$/, domain: 'devices' }`, `services/mcpDomains.ts:78`) in this task, so every commit is green.
- [ ] **Step 4:** `cd apps/api && npx vitest run src/services/mcpApps src/services/mcpDomains.test.ts` → all PASS.
- [ ] **Step 5:** Commit `feat(mcp): fleet-health MCP App view and app registry (B-W05 #6159)`.

### Task 4: `tools/list` `_meta.ui` and the gated `resources/read`

**Files:** Modify `routes/mcpServer.ts`:
- **`isToolListedForCaller`.** Extract the per-tool filter body of `handleToolsList` (`:1590-1625`) into `isToolListedForCaller(tool, ctx: McpListingContext): boolean` with no behaviour change. The existing listing suites are the guard.
- **`handleToolsList`.** For the app's tool, call `isMcpAppAvailable({ flagOn: mcpAppsEnabled(), declared: ext.ui, listedForCaller: true, permissionGranted: !(await checkPermissionRequirement(auth, app.permission)) })` and, when it holds, merge `mcpAppToolMeta(app)` into the entry's `_meta`. Run the RBAC check only when the first two conditions hold, so flag-off and non-declaring callers pay nothing.
- **`handleResourcesRead`** (today `(id, params, auth, domainGrant)`, `:3142`) widens to `(id, params, auth, scopes, apiKey, ext)` — the inputs `isToolListedForCaller` needs; its call site (`:1274`) already has them. Its `McpListingContext` comes from the same `buildMcpListingContext(scopes, auth, apiKey)` that `handleToolsList` uses after the extraction above. Its first branch: when `findMcpAppByUri(uri)` matches, evaluate the same predicate, with `listedForCaller` from `isToolListedForCaller` on the app's tool. Any failure returns the **existing** unknown-URI error expression. Success sets `auditExtras.mcpApp` and returns `mcpAppResourceContents(app)` before any DB or site code. `MCP_RESOURCE_PERMISSIONS` gets **no** row.
- **`handleToolsCall`.** Sets `auditExtras.mcpApp = app.key` when the called tool has an app.

(The `MCP_RESOURCE_DOMAINS` row already landed in Task 3.) Tests: extend `routes/mcpServer.apps.test.ts`, `routes/mcpServer.resourceRbac.test.ts`, `services/mcpDomains.test.ts`.

**Interfaces:** Consumes Tasks 1–3. The merge is `{ ...presentation._meta, ...mcpAppToolMeta(app) }`, which preserves `app.breeze/domain`; `McpToolPresentation._meta` (`services/mcpToolPresentation.ts:6`, typed `{ 'app.breeze/domain': string }`) widens to `{ 'app.breeze/domain': string; ui?: { resourceUri: string; visibility: ['model'] } }`. Produces `isToolListedForCaller` and `McpListingContext` (the inputs `handleToolsList` already computes: scopes, domain grant, MFA state, unattended flag, `requireExecuteAdmin`, intent eligibility).

- [ ] **Step 1: Write the failing tests.**
  - `declaring client, flag on: get_fleet_health has _meta.ui {resourceUri, visibility:['model']} and keeps app.breeze/domain; no other entry changes` (deep-equal every other entry against the non-declaring list).
  - `non-declaring client or flag off: tools/list deep-equals today's; checkPermissionRequirement not called for the app`.
  - `restricted grant or missing devices.read: no _meta.ui and no view` — a key with `mcp_domains = ['core']`, and separately a role without `devices.read`, both declaring ui: no `_meta.ui`; `resources/read` of the app URI deep-equals the unknown-URI body for `ui://breeze/nope`.
  - `resources/read gate matrix` (`it.each` over the four predicate inputs): every failing row deep-equals the unknown-URI body; the all-true row → one `contents` entry, mimeType `text/html;profile=mcp-app`, `text === FLEET_HEALTH_VIEW_HTML`, `_meta.ui.csp` lists empty; no DB call (db mock untouched). `ui://breeze/fleet-health/v2` → unknown-URI even when everything else holds.
  - `audit: resources/read of the app and tools/call of get_fleet_health carry mcpApp 'fleet-health/v1'; other calls do not`.
  - `resources/list and resources/templates/list are unchanged for a declaring client`.
  - Modern era: `resources/read` result decorated with `resultType: 'complete'`, `ttlMs: 0`, `cacheScope: 'private'` (B-W03 `MCP_CACHE_TTL_MS['resources/read']`).
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/mcpServer.apps.test.ts src/routes/mcpServer.resourceRbac.test.ts src/services/mcpDomains.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Green, plus `npx vitest run src/services/mcpApps src/routes/mcpServer.domains.test.ts src/routes/mcpServer.test.ts src/__tests__/mcp-coverage.test.ts src/services/mcpToolPresentation.guardrailParity.contract.test.ts`.
- [ ] **Step 5:** Typecheck; commit `feat(mcp): get_fleet_health advertises its ui:// view to Apps-capable clients (B-W05 #6159)`.

### Task 5: Conformance, parity and text-fallback contracts

**Files:** Modify `routes/mcpServer.conformance.contract.test.ts`, `routes/mcpServer.statelessParity.contract.test.ts`. No production code — this task pins the cross-era contract; a red here is a bug in Tasks 2–4.

- [ ] **Step 1: Add the cases** (each must fail if Task 4's gate is removed — verify by temporarily disabling the `clientExtensions.ui` check and watching them go red, then restore):
  - Conformance, per negotiated version, flag on: a declaring client's `get_fleet_health` entry carries `_meta.ui.resourceUri`; a non-declaring client's list equals the flag-off list; `tools/call get_fleet_health` returns identical `content` and `structuredContent` for declaring and non-declaring clients (**text parity**); `resources/read` of the app URI returns the HTML for the declaring client only.
  - Stateless parity: a legacy client declaring ui (via `initialize`) and a modern client declaring ui (per request) get the same `get_fleet_health` entry and the same `resources/read` body modulo the existing documented decoration (`resultType`, `ttlMs`, `cacheScope`, `_meta` server info). Add a documented-exception note only if one is genuinely needed; none is expected.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/mcpServer.conformance.contract.test.ts src/routes/mcpServer.statelessParity.contract.test.ts` → PASS with Tasks 2–4 in place; record the gate-removal red in the commit message.
- [ ] **Step 3:** Commit `test(mcp): Apps negotiation and text-fallback parity contracts (B-W05 #6159)`.

### Task 6: Docs

**Files:** `apps/docs/src/content/docs/features/mcp-server.mdx` (new "MCP Apps (preview)" section: what Apps-capable hosts see, that every other client gets the same text/structured result, `MCP_APPS_ENABLED` env row, that the view makes no network requests and contains no data until the tool runs), plan index row.

- [ ] **Step 1:** Write the section; add `MCP_APPS_ENABLED` to the env table.
- [ ] **Step 2:** `cd apps/docs && npx astro check; echo "exit=$?"` if the docs package has it, else the docs build used in CI (`pnpm --filter=@breeze/docs build`).
- [ ] **Step 3:** Commit `docs(mcp): MCP Apps preview (B-W05 #6159)`.

### Task 7: Gates, lab, PR

- [ ] **Step 1: Gates.** Whole API unit suite in small batches (`cd apps/api && npx vitest run src/routes src/services/mcp*` etc.; record pass/fail counts from real output); `tsc --noEmit` and `tsc --build tsconfig.tests.json` in `apps/api` (exit codes). No integration suite is touched; CI's integration shard still runs.
- [ ] **Step 2: Lab.** Per-worktree stack (`pnpm wt-stack up`; root `.env` copied with AI keys blanked, `BREEZE_WORKSPACE_ENABLED=false`, free `BREEZE_DOCKER_SUBNET=172.31.N.0/24` + `BREEZE_CADDY_IP`), `MCP_APPS_ENABLED=true`. (a) An Apps-capable host — the `ext-apps` reference `basic-host` or MCP Inspector's Apps tab — connects with an API key, calls `get_fleet_health`, and renders the card; screenshot into the PR. (b) Claude Code (`claude mcp add --transport http …/api/v1/mcp/sse`) — no Apps capability — gets today's text. (c) With `MCP_STATELESS_ENABLED=true`, a raw `curl` modern request declaring the extension sees `_meta.ui`; one without does not. Then `pnpm wt-stack down`; say what was left running.
- [ ] **Step 3: PR.** Title `feat(mcp): B-W05 MCP Apps pilot — fleet-health view with text fallback (#6154)`; body `Closes #6159`, `Refs #6145`, D-B38…D-B46 summary, Gate B decisions with the defaults taken, lab screenshots, the go/no-go SQL. A PR whose base is not `main` gets no CI: `gh workflow run CI --ref <branch>`.
- [ ] **Step 4:** One `/pr-review-toolkit:review-pr` round. Update the plan index row.

---

## Exit checklist

- [ ] Flag off: `initialize`, `server/discover`, `tools/list`, `resources/*`, `tools/call` byte-identical (snapshot tests).
- [ ] Flag on: `tools/call get_fleet_health` identical for declaring and non-declaring clients (text parity contract).
- [ ] `_meta.ui` only on `get_fleet_health`, only for declaring clients, only where the tool is listed.
- [ ] View: hostile input renders as text; digest falls back to text; no network; only the three allowed outbound methods.
- [ ] `mcpServer.conformance.contract`, `mcpServer.statelessParity.contract`, `mcpServer.modern`, `mcp-coverage`, `mcpToolPresentation.guardrailParity.contract`, `parkedFanout.contract` green.
- [ ] Lab (a)–(c) recorded; stack torn down.

## CI traps

- `pnpm test` runs no integration suite; this wave touches none, but the CI integration shard must still be green.
- A new `services/` file without a `parkedFanout.contract.test.ts` classification fails the **Lint** job, not Test API.
- Local `tsc` on `apps/api` needs the 12 GB heap; `tsc | tail` masks an OOM — always `echo "exit=$?"`. CI's `tsc --build tsconfig.tests.json` catches strict-index errors in test files that `--noEmit -p tsconfig.json` does not.
- `mcp-coverage.test.ts` keys by route file; no route file is added, so it must stay green unchanged.
- A stacked PR (base ≠ `main`) runs no CI until `gh workflow run CI --ref <branch>`.
