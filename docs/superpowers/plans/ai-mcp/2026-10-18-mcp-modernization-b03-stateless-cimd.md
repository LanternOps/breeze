---
tracking_issue: LanternOps/breeze#6154
wave_issue: LanternOps/breeze#6157
branch: feature/6154-mcp-modernization/wave-6157
---
# MCP server modernization B-W03: stateless `2026-07-28` dual-era + CIMD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The external MCP server speaks protocol `2026-07-28` statelessly on its existing Streamable HTTP endpoint, alongside the legacy `initialize` + `Mcp-Session-Id` path for clients that negotiate `2024-11-05` through `2025-11-25`. The OAuth authorization server accepts Client ID Metadata Documents (CIMD) next to Dynamic Client Registration and advertises RFC 9207 `iss` support. Both new surfaces are behind default-off flags.

**Architecture:** One classifier decides each POST's era before dispatch: `initialize` means legacy, a body carrying `_meta["io.modelcontextprotocol/protocolVersion"]` means modern, and contradictory envelopes are rejected. The modern path runs the same middleware, preflight, checked auth (`buildCheckedAuthFromApiKey`) and audited dispatch (`dispatchAndAudit` → `handleJsonRpc`) as legacy. It never reads, mints or echoes `Mcp-Session-Id`. Its pre-dispatch checks and result decoration live in two pure leaf modules (`mcpModernEnvelope.ts`, `mcpModernResult.ts`), so the 3,188-line route file only gains call sites. Audit correlation moves from the session id to a server-minted per-request UUID plus the authenticated principal. CIMD uses oidc-provider 9.12.2's built-in `features.clientIdMetadataDocument`, wrapped by a Breeze trust policy in `oauth/cimdPolicy.ts`. Every outbound provider fetch goes through `safeFetch`, and each resolved CIMD client is materialised as an `oauth_clients` row, because every OAuth artifact table FKs to it.

**Tech Stack:** TypeScript, Hono, oidc-provider 9.12.2 (`pnpm-lock.yaml`), Drizzle (queries only), Redis (`rateLimiter`), Zod, React (Astro island `ConsentForm.tsx`), react-i18next (8 locales), Vitest.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md` ("Feature B → B-W03"). The wire contract is #6143 W2 plus the published `2026-07-28` revision, checked on 2026-10-18:
- changelog: SEP-2567, SEP-2575, SEP-2243, SEP-2549, SEP-2322, SEP-2468, PR #2858;
- `basic/versioning`, `basic/transports/streamable-http`, `server/discover`, `server/utilities/caching`;
- `basic/authorization/client-registration`, `…/security-considerations`, `deprecated`.

**Tracking:** `get_feature_status LanternOps/breeze#6154`, then `start_wave` on #6157. Implementation ships as **two PRs on the wave branch**:
- **PR A** covers stateless dual-era, Tasks 1–7. Its body says `Refs #6157 #6143`.
- **PR B** covers CIMD + `iss`, Tasks 8–11. Its body says `Closes #6157` and `Refs #6143`.

#6143 stays open for Todd, because its W1 half shipped in B-W01 and its gap table also covers B-W04 to B-W06 items.

**Depends on:** B-W02 (#6156, merged as #9135, 2026-10-18 06:06Z). That provides `mcpDomains.ts`, `mcpAuthChallenge.ts`, the `domain_not_granted` denial and the `insufficient_scope` step-up this wave must keep identical across eras.

**Verified against `origin/main` `692c66e88e`** (2026-10-18), with every path and symbol re-checked by a read-only survey. Line numbers drift, so re-grep before editing.

**Migration:** none. No table or column is added. The orchestrator-reserved slot `2026-12-31-130000` is **not used**. Tenancy registries do not change (see "Tenancy").

---

## Advisor quorum, 2026-10-18

**Procedure.** I formed a written position first (P1–P3, D1–D4), and Codex `gpt-6-astra` at `xhigh`, read-only, critiqued it against `692c66e88e` and the unpacked oidc-provider 9.12.2 source.

**Verdicts.**
- P2 (modern request handling): **disagree**.
- P1, P3 and D1–D4: **agree-with-changes**.
- Codex required ten changes. **All ten are adopted** and folded into the decisions below.
- No item is still disputed between the two advisors.
- What remains for Todd are rollout and product choices (see "Open Decisions"), not design disagreements.

One quorum finding concerns pre-existing code outside this wave's scope. It is reported to Todd privately, not in this public plan.

## Decisions

- **D-B13 — Era classification is one pure function, evaluated once per request.** *Adopted, with quorum changes.*
  - The function is `classifyMcpRequest` (Task 2). It reads the flag once per request and uses that snapshot for both classification and advertised versions.
  - Its decision table is the authority. It is below, in Task 2.
  - `initialize` is always legacy. An `initialize` carrying modern `_meta` is **rejected**, not silently served as legacy.
  - Modern envelopes are served only on `POST /sse`. On `POST /message` (legacy HTTP+SSE) they are **rejected**, where today they would dispatch unvalidated.
  - When the flag is off, a modern envelope is rejected **before** legacy processing. The rejection is a non-modern `-32600` at HTTP 400, so dual-era clients fall back to `initialize`. It never falls through to the session check.
- **D-B14 — The legacy handshake never negotiates a modern version.**
  - `negotiateMcpProtocolVersion` picks only from `LEGACY_MCP_PROTOCOL_VERSIONS`, so B-W01's pin `negotiateMcpProtocolVersion('2026-07-28') === '2025-11-25'` stays true.
  - `SUPPORTED_MCP_PROTOCOL_VERSIONS` becomes `['2026-07-28', …legacy]`. That replaces B-W01's "not yet" assertion.
  - A modern envelope naming a *legacy* version gets the non-modern `-32600`, which tells the client to use `initialize`. Answering `-32022` there would loop, because `supported` lists that legacy version.
- **D-B15 — The modern path enforces the full envelope before any `_meta` access.** *Adopted from the quorum, replacing P2.*
  - Envelope validation runs for **both** eras, and the parse runs before any field is dereferenced. A JSON-RPC envelope needs an object body, `jsonrpc === '2.0'`, a non-empty string `method`, an `id` that is a string, a number or absent, and `params` that is an object or absent. Today JSON `null` is dereferenced and truthy non-string methods are accepted (`mcpServer.ts:605`).
  - A missing or non-object `clientCapabilities` → HTTP 400 `-32602`. Breeze requires no client capability, so `-32021` is never emitted.
  - The header checks follow SEP-2243:
    - `MCP-Protocol-Version` must be present and equal the `_meta` version.
    - `Mcp-Method` must equal `method`.
    - `Mcp-Name` must equal `params.name` (for `tools/call` and `prompts/get`) or `params.uri` (for `resources/read`). Its value is decoded from the `=?base64?…?=` sentinel first.
    - A header value is invalid if it has a character outside visible ASCII, space or tab.
    - Any failure → HTTP 400 `-32020`.
  - No tool designates `x-mcp-header`, so no `Mcp-Param-*` header is "recognized" this wave.
- **D-B16 — Same gates, same dispatcher, explicit status precedence (decision 4).** *Adopted, with quorum changes.*
  - The modern path runs `buildCheckedAuthFromApiKey` (creator authority, partner IP allowlist) **and** `dispatchAndAudit`, not just `handleJsonRpc`.
  - `domain_not_granted`, approval, MFA, RBAC, scope and rate-limit denials therefore yield byte-identical JSON-RPC errors in both eras.
  - HTTP status is composed by `resolveMcpHttpStatus` (Task 4). Precedence:
    1. A pre-dispatch rejection returns its own 400, 403 or 404.
    2. A modern `-32601` → 404.
    3. Otherwise, the result of `applyInsufficientScopeChallenge` is used (200, or 403 with the flag on).
  - The step-up therefore can never overwrite a modern 400 or 404.
  - Parity is defined against **legacy Streamable HTTP** (`POST /sse`). Legacy HTTP+SSE's owned-session 202 is out of the comparison.
- **D-B17 — Methods per era.**
  - Modern accepts: `server/discover`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`.
  - In modern, `initialize`, `notifications/initialized`, `ping`, `logging/setLevel` and `resources/subscribe` answer 404 `-32601`. The audit row is still written, through the same dispatcher.
  - `subscriptions/listen` is new optional `2026-07-28` functionality. It is *not implemented* this wave (404 `-32601`), and capabilities advertise no `listChanged`.
  - A modern notification (no `id`) → 202, not dispatched.
  - `resources/templates/list` is new in **both** eras (additive). It lists `breeze://devices/{id}`, filtered by the B-W02 domain predicate, so a listed template is readable.
  - `server/discover` requires authentication like every MCP request, so no anonymous surface is added.
- **D-B18 — Result decoration is modern-only and uniform.**
  - Every modern success result gets `resultType: 'complete'` and `_meta["io.modelcontextprotocol/serverInfo"]`.
  - The six cacheable methods get `ttlMs` and `cacheScope: 'private'`.
    - `ttlMs` values: `server/discover` 300 000, `prompts/list` 300 000, `tools/list` / `resources/list` / `resources/templates/list` 60 000 (they are permission-filtered and domain edits are live), `resources/read` 0.
    - **Every** Breeze cacheable result is `private`, and a contract test enumerates this.
  - Breeze adds **no server-side result cache**. `cacheScope` is a client hint only. A future server cache would have to key on scopes, domains, tenant/site access, version and parameters, not on principal id alone (quorum wording).
  - Legacy results are byte-identical to `main`, pinned by the per-version conformance suite.
- **D-B19 — Audit and abuse correlation without sessions: the key is the principal plus a server-minted request id. No handle is echoed by the client (decision 1).** *Adopted, with quorum changes.*
  - **Why not a client-echoed handle.**
    - The Redis session-ownership check (`mcpServer.ts:958-1028`) was never an authorization control: auth middleware authenticates every request independently.
    - Its value was audit integrity. It stopped a caller from stamping arbitrary ids into `audit_logs` and the ledger (MED-1).
    - Stateless mode closes MED-1 by construction, because no client-supplied correlation value is ever written.
    - Clients would not echo a handle. SEP-2567 handles are tool arguments for application state.
    - Accepting one would reopen the forgery surface and need HMAC plus principal binding, for no authorization value.
  - **The correlation record, carried per request** (`McpRequestCorrelation`, Task 3):
    - `requestId`: `crypto.randomUUID()`. It becomes the audit `resourceId`, a real UUID column. Today the `mcp-<hex>` session id is diverted to `details.rawResourceId`.
    - `principalKey`, from the existing `mcpPrincipalKey`.
    - `tokenJti`: the OAuth access-token `jti`. This is an unforgeable ≤ access-token-TTL window minted by the authorization server. It is **nullable**, because a bearer without `jti` is admitted as `oauth:no-jti` (`bearerTokenAuth.ts:530`).
    - `era`, `protocolVersion` and `transport`.
    - `sessionId`: the verified-owned legacy session, or `null`.
    - `clientInfo`: self-reported, at most 64 characters per field, flagged `self_reported`.
  - **Where it goes.** One `McpRequestCorrelation` object is threaded through the request audit, the tool audit, tenant-tool execution and **both** ledger representations (`toolInput.transport` and `ai_sessions.context_snapshot`).
  - **Abuse tripwires.**
    - Legacy keeps its two tripwires: unknown-session rate and principal mismatch.
    - Modern adds a once-per-window `mcp_header_mismatch_rate_high` Sentry event. It has the same shape as `recordUnknownMcpSession`, and its intent is to detect gateway or request smuggling.
    - Rate limits are already keyed per principal (`mcp:msg:<principalKey>`) and do not change.
- **D-B20 — CIMD trust policy (decision 2).** *Adopted, with quorum changes.*
  - **No new table and no migration.** A CIMD client is an `oauth_clients` row:
    - `id` is the URL, `partner_id` is NULL, and `metadata` is the validated document.
    - Codes, grants, refresh tokens, partner grants, client blocks and approval requests all FK `oauth_clients.id`. Sessions and interactions do not.
    - The kind is derived from the id shape (`isCimdClientId`). A DCR id is never an `https:` URL.
  - **Lookup.** `adapter.find('Client', url)` returns `undefined` for a CIMD id. oidc-provider then re-resolves through CIMD (its cache plus our `allowClient`) instead of serving stored metadata forever (`client.js:593` consults the adapter first).
  - **`allowFetch`** is called on a cache miss. It requires all of the following:
    - The flag is on.
    - The URL passes `isCimdClientId`: https, a host that is not an IP literal, a path that is not `/`, no userinfo, no fragment, no dot segments. oidc-provider 9.12.2 dropped its own path check.
    - It passes `checkSsrfSafe(url, { mode: 'strict-https' })`.
    - It passes the optional host allowlist `OAUTH_CIMD_ALLOWED_HOSTS`. That is a CSV with `.suffix` semantics, and unset means any public https host.
    - It is within the per-host budget (10 fetches/min) and the **global** budget (120 fetches/min).
    - Redis is available. In production a missing Redis means **deny**.
  - **`allowClient`** runs on **every** use, including cache hits, which skip `allowFetch`. It re-evaluates the flag and host policy live. It then validates the metadata:
    - `client_name` is required, 1–128 characters.
    - `token_endpoint_auth_method` is `none`, which keeps public clients only.
    - `redirect_uris` pass `validateRedirectUris`.
    - None of the DCR-rejected fields (`routes/oauth.ts:33`) is present.
  - **Materialisation** (`materializeCimdClient`).
    - It inserts only when the row is absent and the global creation budget (200/hour) allows.
    - It rewrites `metadata` only when its hash changed. A write is throttled to once per 60 s per client.
    - A row with `disabled_at` set refuses the client.
  - **Secondary fetches.** The provider-level `fetch` is replaced with a wrapper.
    - The wrapper **only** permits a URL that `allowFetch` approved within the last 30 s, and it consumes the approval.
    - It routes through `safeFetch` (DNS-pinned, private ranges refused, no redirects) with `maxBytes` 5 KiB.
    - It sets a **hard** deadline: the library's `AbortSignal` combined with `AbortSignal.timeout(5000)`. `safeFetch.timeoutMs` is an inactivity timeout, so it is not enough on its own.
    - A `sector_identifier_uri` or `jwks_uri` fetch that `addClient` would trigger before `allowClient` therefore fails closed.
  - **Cache.** The library's in-process LRU applies, bounded `{ min: 300, max: 86400 }` seconds.
    - `Cache-Control: no-store` / `no-cache` are **not** honoured below 300 s. This is deliberate: it bounds fetch amplification.
  - **Cleanup and tombstones.** `cleanupStaleOauthClients` excludes three kinds of row, for every client kind:
    - rows with `disabled_at` set;
    - rows that have `oauth_client_blocks`;
    - rows referenced by `approval_requests.requesting_client_id`. That FK has no `ON DELETE` (`db/schema/approvals.ts:35`), so a single such row would fail the whole delete. A stable CIMD URL therefore cannot erase its own disable or org blocks by ageing out and re-materialising.
  - **Disable.** Disabling goes through the existing family revocation: `revokeClientFamilies(id, { kind: 'global' })` sets `disabled_at` last, after grants and tokens die. An operator UI for it is deferred.
  - **Consent.**
    - The payload gains `registration: 'metadata_document' | 'dynamic'`, `client_id_host`, `redirect_host` and `localhost_redirect`.
    - The display name stays `verification: 'unverified'`. A CIMD host proves who hosts the metadata, not the application's identity.
    - The requested callback hostname is shown prominently.
    - A warning appears when a CIMD client redirects to loopback. This addresses the spec's localhost impersonation risk.
  - **AS metadata.**
    - It gains `client_id_metadata_document_supported: true`, only when the flag is on.
    - It gains `authorization_response_iss_parameter_supported: true`, always. oidc-provider already sets `iss` on code-flow success and error redirects (`respond.js:40`, `authorization_error_handler.js:25`).
    - DCR (`registration_endpoint`) stays. The spec deprecates it, with earliest removal ≥ 2027-07-28.
- **D-B21 — RFC 9207 needs no client-side change.**
  - Breeze's outbound MCP client (`services/toolSources/authHeaders.ts:55-140`) uses only `client_credentials`. It never redeems an authorization code, so it has no `iss` to validate.
  - The server side is pinned by config tests. No JARM / `jwtResponseModes` is enabled, and `response_types` is `['code']`, so `iss` is always emitted.
- **D-B22 — Legacy HTTP+SSE is announced for removal but not removed (decision 3).** *Adopted, with quorum changes.*
  - **Deprecation headers.** `GET /sse` (the stream) and `POST /message` answer with these headers:
    - `Deprecation: @1742947200` (RFC 9745). The transport has been deprecated since protocol `2025-03-26`.
    - `Sunset: <MCP_HTTP_SSE_SUNSET>` (RFC 8594).
  - **Usage counting.** Usage is counted at **stream establishment** with a `mcp.transport.http_sse.open` audit row. Counting only at dispatch would miss idle legacy clients. Per-request rows also carry `correlation.transport = 'http_sse'`.
  - **Sunset date.** It is provisional: **2027-01-31**, or later, as the latest of three dates:
    - B-W03's release date plus 90 days.
    - The date SEP-2596 reaches Final plus three months (the spec's earliest-removal rule). The registry does not establish this date, so do not assume one.
    - 2027-01-31.
  - **Removal** is a filed follow-up. It is gated on 30 consecutive days of zero `http_sse.open` rows on both regions, or on named principals having been notified.
  - Legacy *Streamable HTTP* (`2025-03-26` to `2025-11-25`) is not deprecated by the spec and gets no date.
- **D-B23 — Origin and CORS (quorum addition).** The spec requires an invalid `Origin` to get HTTP 403.
  - **Modern era:** a present `Origin` that the app's CORS resolver rejects → 403 with an id-less JSON-RPC error `-32600`.
  - **Legacy era:** log-only this wave. Enforcing it is a follow-up, so that existing browser-hosted clients are not broken without a usage count.
  - The global CORS config gains `MCP-Protocol-Version`, `Mcp-Session-Id`, `Mcp-Method` and `Mcp-Name` in `allowHeaders`, and `Mcp-Session-Id` and `WWW-Authenticate` in `exposeHeaders`. The header lists move to `services/corsPolicy.ts` so they are testable.
- **D-B24 — Two kill switches, default off for the first release.**
  - `MCP_STATELESS_ENABLED` and `OAUTH_CIMD_ENABLED` are boot-time `envFlag`s in `config/env.ts`.
  - `OAUTH_CIMD_ALLOWED_HOSTS` is an optional CSV that `config/validate.ts` checks at boot.
  - The flip order and timing are Open Decision 1.

## Open Decisions (for Todd)

1. **Rollout of the two flags.**
   - **(A) Plan default:** both stay off in the release that ships B-W03. Turn on `MCP_STATELESS_ENABLED` on EU first after the lab run (Task 11), then US. Turn on `OAUTH_CIMD_ENABLED` after one modern client (Claude or the MCP Inspector) completes a CIMD sign-in on EU.
   - **(B)** Both on by default from the first release.
   - **Recommend A.** Both surfaces are new auth-adjacent code. A dual-era client loses nothing while the flag is off, because it falls back to `initialize`.
2. **The HTTP+SSE sunset date.**
   - **(A)** Provisional 2027-01-31, recomputed at release time per D-B22.
   - **(B)** Hold the header until telemetry exists, with no date.
   - **Recommend A.** A date is what makes a `Sunset` header actionable, and D-B22 already makes it conditional.
3. **CIMD host policy default.**
   - **(A) Plan default:** open. Any public https host passes, bounded by budgets and the consent display. Self-hosters can set `OAUTH_CIMD_ALLOWED_HOSTS`.
   - **(B)** Closed by default, admitting only listed hosts.
   - **Recommend A.** It is the spec's no-prior-relationship case, it matches today's anonymous-DCR posture, and B makes CIMD useless until someone curates a list.
4. **Legacy-era `Origin` enforcement.**
   - **(A) Plan default:** log-only now, then enforce in a follow-up after 30 days of counts.
   - **(B)** Enforce in both eras now.
   - **Recommend A.** It avoids breaking unknown browser-hosted legacy clients without data.

---

## Global Constraints

- **Commands.**
  - API unit tests: `cd apps/api && npx vitest run <path>`. The path is a substring match, so check the file count in the output. Never use `pnpm --filter <pkg> test -- --run <path>`.
  - Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"`. Read the exit code and never pipe it to `tail`. Do the same for `apps/web`.
  - Web tests: `cd apps/web && npx vitest run <path>`.
- **Never weaker than today.**
  - Every legacy request behaves byte-identically to `main`. This is pinned by the per-version conformance suite, which runs over `LEGACY_MCP_PROTOCOL_VERSIONS`.
  - The documented exceptions are:
    1. **Envelope validation.** Any body failing `validateJsonRpcEnvelope` gets 400 `-32600` instead of today's thrown 500 or lax acceptance. That covers JSON `null`, arrays, a non-string or empty `method`, an object or `null` `id`, and non-object `params`.
    2. **New rejections.** An `initialize` carrying modern `_meta` is rejected (row 1). Modern `_meta`, or a modern header, on `/message` is rejected (row 3). With the flag on, a modern header without `_meta` gets `-32020` (row 4).
    3. **`resources/templates/list`**, which is additive.
    4. **HTTP+SSE deprecation.** `Deprecation` and `Sunset` headers are added, and a `mcp.transport.http_sse.open` audit row is written per stream.
    5. **Audit `resourceId`.** It now carries the request UUID. The session id stays in `details.sessionId`, and `details.correlation` is added.
    6. **CORS.** The new allow and expose headers are added, and a log-only Origin counter runs on legacy requests.
- **Modern ≡ legacy for authorization.** Every gate (scope tier, approval, MFA, production allowlist, RBAC, domain, rate limit, creator authority, partner IP allowlist) runs on both eras through the same functions. The parity contract (Task 5) enforces this.
- **No client-supplied value is ever written as an identifier** to `audit_logs`, the tool audit or the ledger. `clientInfo` is stored only under `correlation.clientInfo`, bounded, with `clientInfoTrust: 'self_reported'`.
- **No outbound fetch inside a held DB context.** CIMD fetches happen in the oidc-provider Koa layer. The adapter's `asSystem` is a held transaction, so `adapter.find` must never fetch. `materializeCimdClient` runs its Redis budget check before `asSystem`.
- **Public repo.** No customer names, hostnames or IPs in code, tests, docs or PR text. Test CIMD URLs use `https://client.example.com/…` and `https://evil.example.net/…`.
- **Commit after every task.** Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Tenancy (read `docs/agents/tenancy-rls.md` first)

| Change | Table | Registration impact |
|---|---|---|
| CIMD rows | `oauth_clients` (existing, partner-scoped, nullable `partner_id`, RLS forced, listed in `rls-coverage.integration.test.ts:238`) | None. The table is in none of `CORE_TENANT_EXPORT_POLICY`, `CORE_ORG_CASCADE_DELETE_ORDER` or `orgMergeRegistry.ts`, and B-W03 adds no column. `metadata` is already an open container (`tenantExportPolicy.ts:69`). |
| Correlation fields | `audit_logs.details`, `ai_sessions.context_snapshot`, `ai_tool_executions.tool_input` (all `jsonb`, existing) | None, because no column is added. |

Run `rls-coverage`, `tenant-export-policy` and `tenantCascade` once on the wave stack anyway. They confirm "no change", which is cheaper than arguing it.

## Review Focus

1. **A modern request carrying a legacy-owned `Mcp-Session-Id`.** The header is ignored and never echoed, the request is served statelessly, and the audit row has `correlation.sessionId: null`. `modern path ignores and never echoes Mcp-Session-Id` (Task 4).
2. **A modern request whose `Mcp-Name` differs from the body only after base64 decoding.** A correctly encoded match is accepted. Bad base64, or a decoded mismatch, → 400 `-32020`. `decodes the base64 sentinel before comparing` (Task 2).
3. **A CIMD document served from cache after the operator disables the client, or after `OAUTH_CIMD_ALLOWED_HOSTS` is narrowed.** The client is refused without a refetch. `allowClient re-evaluates disable and host policy on cache hits` (Task 9).
4. **A CIMD document that names a `sector_identifier_uri` or `jwks_uri` pointing at an internal host.** No request leaves the process. `provider fetch refuses any URL allowFetch did not approve` (Task 8).
5. **Two principals calling `tools/list` back to back on one process, in the modern era.** Each gets its own filtered list, both are marked `private`, and nothing is shared. `cacheable results are per-principal and private` (Task 5).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/mcpProtocol.ts` (modify) | Splits versions into modern and legacy, with legacy-only negotiation and flag-aware `supportedMcpProtocolVersions`. |
| `apps/api/src/services/mcpModernEnvelope.ts` (new) | Pure functions: envelope validation, the era decision table, SEP-2243 header validation (sentinel decode) and modern error builders. |
| `apps/api/src/services/mcpModernResult.ts` (new) | Pure functions: `resultType`, `serverInfo`, `ttlMs`/`cacheScope` decoration, the `server/discover` result, `resolveMcpHttpStatus` and the header-mismatch tripwire. |
| `apps/api/src/services/mcpRequestCorrelation.ts` (new) | The `McpRequestCorrelation` type, its builder and `sanitizeMcpClientInfo`. |
| `apps/api/src/routes/mcpServer.ts` (modify) | Era branch on `POST /sse`, modern rejection on `/message`, correlation threading, `resources/templates/list`, HTTP+SSE deprecation headers and open audit, Origin check. |
| `apps/api/src/services/mcpToolExecutionLedger.ts` (modify) | `transportRequestId` and `era` in both ledger representations. |
| `apps/api/src/services/corsPolicy.ts` (new) | `resolveCorsOrigin` plus `CORS_ALLOW_HEADERS` and `CORS_EXPOSE_HEADERS`. These move out of `index.ts:467,555-565`. |
| `apps/api/src/config/env.ts`, `config/validate.ts`, root `.env.example` (modify) | `MCP_STATELESS_ENABLED`, `OAUTH_CIMD_ENABLED`, `OAUTH_CIMD_ALLOWED_HOSTS`. |
| `apps/api/src/oauth/cimdPolicy.ts` (new) | `isCimdClientId`, `cimdAllowFetch`, `cimdAllowClient`, `validateCimdMetadata`, the approved-fetch registry, `createOidcProviderFetch` and budgets. |
| `apps/api/src/oauth/cimdClients.ts` (new) | `materializeCimdClient`. |
| `apps/api/src/oauth/provider.ts` (modify) | Extracts `buildOidcProviderConfiguration` (pure), adds the CIMD feature and `fetch`, and the cleanup exclusions. |
| `apps/api/src/oauth/adapter.ts` (modify) | `find('Client')` returns undefined for a CIMD id, and `upsert('Client')` refuses one. |
| `apps/api/src/routes/oauthWellKnown.ts` (modify) | The two metadata fields. |
| `apps/api/src/routes/oauthInteraction.ts` (modify) | The consent payload fields. |
| `apps/web/src/components/oauth/ConsentForm.tsx` and `apps/web/src/locales/*/common.json` (modify) | The metadata-host line and the loopback warning, in 8 locales. |
| `apps/docs/src/content/docs/features/mcp-server.mdx` (modify) | Transport section (modern, legacy, deprecation), OAuth section (CIMD, `iss`) and env table. |

---

### Task 1: Version vocabulary split

**Files:**
- Modify `apps/api/src/services/mcpProtocol.ts`
- Test `apps/api/src/services/mcpProtocol.test.ts`
- Modify `apps/api/src/routes/mcpServer.conformance.contract.test.ts`. It imports `SUPPORTED_*` and `LATEST_*` at `:174`, and `describe.each` runs at `:212`.

**Interfaces — Produces:**
- `MODERN_MCP_PROTOCOL_VERSIONS = ['2026-07-28'] as const`
- `LEGACY_MCP_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05'] as const`
- `SUPPORTED_MCP_PROTOCOL_VERSIONS = [...MODERN, ...LEGACY]`
- Types `ModernMcpProtocolVersion`, `LegacyMcpProtocolVersion` and `McpProtocolVersion` (the union)
- `LATEST_LEGACY_MCP_PROTOCOL_VERSION = '2025-11-25'`. This **replaces** `LATEST_MCP_PROTOCOL_VERSION`, which has no non-test importers.
- `isLegacyMcpProtocolVersion(v: unknown): v is LegacyMcpProtocolVersion`
- `isModernMcpProtocolVersion(v: unknown): v is ModernMcpProtocolVersion`
- `supportedMcpProtocolVersions(statelessEnabled: boolean): readonly McpProtocolVersion[]`
- `negotiateMcpProtocolVersion(requested: unknown): LegacyMcpProtocolVersion` (legacy only)
- `parseMcpProtocolVersionHeader`, unchanged and legacy-only. It is used only by the legacy path.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  it('lists 2026-07-28 first, then the four legacy revisions', () => {
    expect([...SUPPORTED_MCP_PROTOCOL_VERSIONS]).toEqual(['2026-07-28','2025-11-25','2025-06-18','2025-03-26','2024-11-05']);
    expect(LATEST_LEGACY_MCP_PROTOCOL_VERSION).toBe('2025-11-25');
  });
  it('initialize never negotiates a modern version', () => {
    expect(negotiateMcpProtocolVersion('2026-07-28')).toBe('2025-11-25'); // B-W01 pin, still true
  });
  it('advertises the modern version only when stateless is enabled', () => {
    expect(supportedMcpProtocolVersions(false)).toEqual(['2025-11-25','2025-06-18','2025-03-26','2024-11-05']);
    expect(supportedMcpProtocolVersions(true)[0]).toBe('2026-07-28');
  });
  it('the legacy header parser rejects the modern version', () => {
    expect(parseMcpProtocolVersionHeader('2026-07-28')).toEqual({ ok: false, value: '2026-07-28' });
  });
  ```
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/mcpProtocol.test.ts`. Expected: FAIL (missing exports).
- [ ] **Step 3: Implement.**
  - `isSupportedMcpProtocolVersion` becomes an alias of `isLegacyMcpProtocolVersion`. Today it derives from `SUPPORTED_*` (`mcpProtocol.ts:9-11`), so without the alias the header parser and `negotiateMcpProtocolVersion` would start accepting `2026-07-28`.
  - Narrow `ASSUMED_MCP_PROTOCOL_VERSION`, the `version` returned by `parseMcpProtocolVersionHeader`, and the return type of `negotiateMcpProtocolVersion` to `LegacyMcpProtocolVersion`.
  - In the conformance contract, iterate `LEGACY_MCP_PROTOCOL_VERSIONS` for the session suite, and replace `LATEST_*` with `LATEST_LEGACY_*`.
- [ ] **Step 4:** Run both files and expect PASS. The conformance file count must still be 4 versions × its cases.
- [ ] **Step 5:** Commit `feat(mcp): split modern and legacy protocol versions (B-W03 #6157)`.

### Task 2: `mcpModernEnvelope.ts` — envelope, era decision and header validation

**Files:**
- Create `apps/api/src/services/mcpModernEnvelope.ts`
- Test `apps/api/src/services/mcpModernEnvelope.test.ts`

**Interfaces:**
- Consumes the Task 1 exports.
- Produces:
  ```ts
  export type JsonRpcEnvelope = { jsonrpc: '2.0'; id?: string | number; method: string; params?: Record<string, unknown> };
  export function validateJsonRpcEnvelope(body: unknown): { ok: true; body: JsonRpcEnvelope } | { ok: false; id: string | number | null };
  export type ModernRequestMeta = { protocolVersion: ModernMcpProtocolVersion; clientCapabilities: Record<string, unknown>; clientInfo: unknown };
  export type McpRejection = { status: 400 | 403 | 404; error: { code: number; message: string; data?: unknown }; reason: McpRejectReason };
  export type McpRejectReason = 'contradictory_initialize' | 'modern_on_legacy_endpoint' | 'modern_disabled' | 'legacy_version_in_modern_envelope'
    | 'unsupported_version' | 'missing_client_capabilities' | 'header_mismatch' | 'header_modern_without_meta';
  export type McpEraDecision = { era: 'legacy' } | { era: 'modern'; meta: ModernRequestMeta } | { era: 'reject'; rejection: McpRejection };
  export type McpRequestHeaders = { protocolVersion?: string; method?: string; name?: string };
  export function classifyMcpRequest(input: { body: JsonRpcEnvelope; headers: McpRequestHeaders; statelessEnabled: boolean; endpoint: 'streamable' | 'legacy_message' }): McpEraDecision;
  export function decodeMcpHeaderValue(raw: string): { ok: true; value: string } | { ok: false };
  export const MCP_HEADER_MISMATCH = -32020, MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;
  ```

**Decision table** (`classifyMcpRequest`). Evaluate the rows in order; the first match wins. Here `metaV` is `params._meta['io.modelcontextprotocol/protocolVersion']` and `hdrV` is the `MCP-Protocol-Version` header.

| # | Condition | Result |
|---|---|---|
| 1 | `method === 'initialize'` and `metaV !== undefined` | reject 400 `-32600` `contradictory_initialize`, `data: { supported: supportedMcpProtocolVersions(statelessEnabled) }` |
| 2 | `method === 'initialize'` | legacy |
| 3 | `endpoint === 'legacy_message'` and (`metaV !== undefined` or `isModern(hdrV)`) | reject 400 `-32600` `modern_on_legacy_endpoint` |
| 4 | `metaV === undefined`, `isModern(hdrV)` and `statelessEnabled` | reject 400 `-32020` `header_modern_without_meta`. When the flag is off this row does not fire: row 5 routes the request to legacy, which keeps today's `-32600 "Unsupported MCP-Protocol-Version"` (`mcpServer.ts:911-918`). |
| 5 | `metaV === undefined` | legacy |
| 6 | `!statelessEnabled` | reject 400 `-32600` `modern_disabled`. This must not be a recognised modern error, so that the client falls back. |
| 7 | `metaV` is not a string, or `hdrV !== metaV` | reject 400 `-32020` `header_mismatch` |
| 8 | `isLegacy(metaV)` | reject 400 `-32600` `legacy_version_in_modern_envelope` ("initialize to use protocol X") |
| 9 | `!isModern(metaV)` | reject 400 `-32022` `unsupported_version`, `data: { supported: supportedMcpProtocolVersions(true), requested: metaV }` |
| 10 | `clientCapabilities` is not a plain object | reject 400 `-32602` `missing_client_capabilities` |
| 11 | `Mcp-Method` is absent or `!== method`. Or, for `tools/call`, `prompts/get` and `resources/read`, `Mcp-Name` is absent, fails to decode, or does not equal `params.name` / `params.uri`. Or a header has a character outside `0x20-0x7E` / tab. | reject 400 `-32020` `header_mismatch` |
| 12 | otherwise | modern, with `meta` |

`decodeMcpHeaderValue`:
- A value matching `^=\?base64\?(.*)\?=$` (case-sensitive) is strict-base64 decoded as fatal UTF-8. A decode failure → `{ ok: false }`.
- Any other value is used as-is, after the character check.

- [ ] **Step 1: Write the failing tests.** Write one `it` per table row, named `row N: …`, asserting the exact `{ era }` or `{ status, error.code, reason }`. Then add these:
  ```ts
  it('validateJsonRpcEnvelope rejects null, arrays, non-string methods and object ids', () => {
    for (const b of [null, [], { jsonrpc: '2.0', method: 7 }, { jsonrpc: '2.0', method: 'x', id: {} }, { jsonrpc: '2.0', method: '' }])
      expect(validateJsonRpcEnvelope(b).ok).toBe(false);
  });
  it('decodes the base64 sentinel before comparing', () => {
    const name = 'résumé_tool';
    const hdr = `=?base64?${Buffer.from(name).toString('base64')}?=`;
    expect(classify({ method: 'tools/call', name }, { name: hdr }).era).toBe('modern');
    expect(classify({ method: 'tools/call', name }, { name: '=?base64?!!!?=' })).toMatchObject({ era: 'reject', rejection: { error: { code: -32020 } } });
  });
  it('compares header values case-sensitively', () => {
    expect(classify({ method: 'tools/list' }, { method: 'Tools/List' })).toMatchObject({ era: 'reject', rejection: { error: { code: -32020 } } });
  });
  it.each([
    ['Mcp-Method absent', { method: undefined }],
    ['Mcp-Name absent on tools/call', { name: undefined }],
    ['Mcp-Name with a control character', { name: 'get_weather\u0001' }],
    ['MCP-Protocol-Version differs from _meta', { protocolVersion: '2025-11-25' }],
  ])('row 11/7: %s → 400 -32020', (_label, headerPatch) => {
    expect(classify({ method: 'tools/call', name: 'get_weather' }, headerPatch)).toMatchObject({ era: 'reject', rejection: { status: 400, error: { code: -32020 } } });
  });
  it('row 4 is inert when the flag is off (legacy keeps its own -32600)', () => {
    expect(classifyMcpRequest({ body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { protocolVersion: '2026-07-28' }, statelessEnabled: false, endpoint: 'streamable' }))
      .toEqual({ era: 'legacy' });
  });
  ```
  The `classify(bodyPatch, headerPatch)` test helper builds a valid modern `tools/call` envelope with matching headers, applies both patches, and calls `classifyMcpRequest` with `statelessEnabled: true` and `endpoint: 'streamable'`.
- [ ] **Step 2:** Run `npx vitest run src/services/mcpModernEnvelope.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The module has no imports beyond `mcpProtocol.ts` and `node:buffer`.
- [ ] **Step 4:** Expect PASS.
- [ ] **Step 5:** Commit.

### Task 3: Correlation record and result decoration

**Files:**
- Create `apps/api/src/services/mcpRequestCorrelation.ts` and `apps/api/src/services/mcpModernResult.ts`
- Tests: `*.test.ts` beside each

**Interfaces — Produces:**
```ts
// mcpRequestCorrelation.ts
export type McpRequestCorrelation = {
  requestId: string; era: 'legacy' | 'modern'; protocolVersion: McpProtocolVersion;
  transport: 'streamable_http' | 'http_sse'; sessionId: string | null; principalKey: string;
  tokenJti: string | null; clientInfo: { name: string; version: string | null } | null;
};
export function buildMcpRequestCorrelation(input: Omit<McpRequestCorrelation, 'requestId' | 'tokenJti' | 'clientInfo'>
  & { apiKeyId: string; rawClientInfo?: unknown }): McpRequestCorrelation;   // requestId = crypto.randomUUID()
export function sanitizeMcpClientInfo(raw: unknown): McpRequestCorrelation['clientInfo'];
export function correlationAuditDetails(c: McpRequestCorrelation): Record<string, unknown>;  // { correlation: {...}, clientInfoTrust: 'self_reported' }
// mcpModernResult.ts
export const MCP_CACHE_TTL_MS: Readonly<Record<McpCacheableMethod, number>>;  // values per D-B18
export type McpCacheableMethod = 'server/discover'|'tools/list'|'prompts/list'|'resources/list'|'resources/templates/list'|'resources/read';
export function decorateModernResult(method: string, result: Record<string, unknown>): Record<string, unknown>;
export function buildDiscoverResult(): Record<string, unknown>;
export function resolveMcpHttpStatus(era: 'legacy' | 'modern', response: { error?: { code: number } }, stepUpStatus: 200 | 403): 200 | 403 | 404;
export function recordMcpHeaderMismatch(): void;   // once-per-60s Sentry 'mcp_header_mismatch_rate_high', threshold env MCP_HEADER_MISMATCH_ALERT_THRESHOLD default 50
```
`tokenJti` comes from `apiKeyId`: it is `oauth:<jti>` → `<jti>`, while `oauth:no-jti` and non-OAuth ids → `null`.

`buildDiscoverResult()` returns these fields:
- `resultType: 'complete'`
- `supportedVersions: supportedMcpProtocolVersions(true)`
- `capabilities: { tools: {}, resources: {}, prompts: {} }`
- `instructions: MCP_SERVER_INSTRUCTIONS`
- `_meta: { 'io.modelcontextprotocol/serverInfo': { name: 'breeze-rmm', title: 'Breeze RMM', version: API_VERSION } }`
- `ttlMs: 300000` and `cacheScope: 'private'`

`decorateModernResult` merges into any existing `result._meta` and never drops keys.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  it('sanitizeMcpClientInfo keeps two bounded strings and drops everything else', () => {
    expect(sanitizeMcpClientInfo({ name: 'x'.repeat(200) + '\u0007', version: 3, evil: 1 }))
      .toEqual({ name: 'x'.repeat(64), version: null });
    expect(sanitizeMcpClientInfo('nope')).toBeNull();
  });
  it('jti is null for no-jti and API keys', () => { /* 'oauth:abc'→'abc', 'oauth:no-jti'→null, uuid→null */ });
  it('every cacheable method is private with a non-negative ttl', () => {
    for (const m of Object.keys(MCP_CACHE_TTL_MS)) {
      const r = decorateModernResult(m, {});
      expect(r).toMatchObject({ resultType: 'complete', cacheScope: 'private' });
      expect(r.ttlMs).toBeGreaterThanOrEqual(0);
    }
    expect(decorateModernResult('tools/call', { content: [] })).not.toHaveProperty('ttlMs');
  });
  it('status precedence: -32601 is 404 only in modern; step-up 403 never overrides 404', () => {
    expect(resolveMcpHttpStatus('legacy', { error: { code: -32601 } }, 200)).toBe(200);
    expect(resolveMcpHttpStatus('modern', { error: { code: -32601 } }, 403)).toBe(404);
    expect(resolveMcpHttpStatus('modern', { error: { code: -32003 } }, 403)).toBe(403);
  });
  ```
- [ ] **Steps 2–5:** Run red, implement, run green, commit.

### Task 4: Route wiring — modern branch on `POST /sse`, rejection on `/message`

**Files:**
- Modify `apps/api/src/routes/mcpServer.ts`: preflight `:575-621`, `dispatchAndAudit` `:692`, `POST /message` `:730`, `POST /sse` `:893-1051`, `handleJsonRpc` `:1079`, `writeMcpToolAuditEvent` `:2150`, the tier-3 lifecycle `:2275`, tenant tool `:1966` and resources `:2595`.
- Modify `apps/api/src/services/mcpToolExecutionLedger.ts`, `config/env.ts`, `config/validate.ts` and `.env.example`.
- Create the test `apps/api/src/routes/mcpServer.modern.test.ts`. Copy the harness from `mcpServer.streamable.test.ts`: the `vi.hoisted` mocks, the in-memory Redis `__sessionStore`, `setApiKeyContext` and `appWithMcpRoutes`.

**Interfaces:**
- Consumes Tasks 1–3.
- Produces these signatures:
  - `handleJsonRpc(req, auth, scopes, apiKey, c, ctx: McpDispatchContext)`, where `type McpDispatchContext = { era: 'legacy' | 'modern'; correlation: McpRequestCorrelation }`. It replaces the `sessionId?: string` parameter.
  - `dispatchAndAudit(c, body, ctx, auth, apiKey)`.
  - `writeMcpToolAuditEvent`'s `event.sessionId` becomes `event.correlation`.
  - Ledger input gains `transportRequestId: string` and `era`.

- [ ] **Step 1: Write the failing route tests.** Use `MCP_STATELESS_ENABLED=true` unless a test name says otherwise. Each test asserts status, body and headers.
  - `server/discover returns supportedVersions, private cache hints and serverInfo`
  - `modern tools/list carries resultType, ttlMs 60000 and cacheScope private, and no Mcp-Session-Id header`
  - `modern path ignores and never echoes Mcp-Session-Id`. Send a legacy-minted owned id; expect no `Mcp-Session-Id` response header, and the audit `details.correlation.sessionId === null`.
  - `modern request never touches the session store`. The `redisState` get/setex spies are not called for `mcp-session:*`.
  - `flag off: modern envelope gets 400 -32600, not a modern error, and the session store is not consulted`
  - `initialize with modern _meta is rejected 400 -32600`
  - `modern envelope on /message is rejected 400 -32600`
  - `Mcp-Name mismatch → 400 -32020 and recordMcpHeaderMismatch called`
  - `unsupported _meta version → 400 -32022 with data.supported and data.requested`
  - `legacy version inside a modern envelope → 400 -32600 (client falls back to initialize)`
  - `modern ping, notifications/initialized, logging/setLevel, resources/subscribe and subscriptions/listen → 404 -32601, audited` (`it.each`)
  - `legacy server/discover → 200 -32601` (discover is modern-only)
  - `POST /message audit row carries correlation.transport === 'http_sse' and the verified sessionId`
  - `recordMcpHeaderMismatch raises one Sentry event at the threshold within 60 s and none below it`
  - `modern notification (no id) → 202, handleJsonRpc not called`
  - `JSON null body → 400 -32600 on both endpoints` (legacy fix)
  - `buildCheckedAuthFromApiKey denial (creator has no access) is identical in both eras` (403 body)
  - `request audit resourceId is a UUID and details.correlation carries principalKey, era, protocolVersion, tokenJti`
  - `tool audit and both ledger representations carry the same requestId` (tier-3 path and tenant-tool path)
  - `resources/templates/list lists breeze://devices/{id} only when the devices domain is granted (both eras)`
- [ ] **Step 2:** Run `npx vitest run src/routes/mcpServer.modern.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Preflight:** `preflightMcpRequest` calls `validateJsonRpcEnvelope` first.
  - **`POST /sse`:** Read `MCP_STATELESS_ENABLED` once, then call `classifyMcpRequest` immediately after preflight. Each decision is handled as follows:
    - `reject`: return `c.json({ jsonrpc: '2.0', id, error }, status)`, and call `recordMcpHeaderMismatch()` for the `-32020` reasons.
    - `modern`: build the correlation, run `buildCheckedAuthFromApiKey`, return 202 for notifications, call `dispatchAndAudit` with `{ era: 'modern' }`, decorate success results, then status = `resolveMcpHttpStatus('modern', response, applyInsufficientScopeChallenge(c, apiKey, response))`.
    - `legacy`: today's code path, unchanged except that the correlation replaces `sessionId`.
  - **`/message`:** classify with `endpoint: 'legacy_message'`.
  - **`handleJsonRpc`:**
    - `server/discover` is served only when `era === 'modern'`.
    - `initialize` and `notifications/initialized` are served only in legacy. In modern they fall through to `-32601`.
    - `ping`, `logging/setLevel` and `resources/subscribe` were never implemented, so they already give `-32601`.
    - `resources/templates/list` is added in both eras via `MCP_RESOURCE_TEMPLATE_LIST` (`[{ uriTemplate: 'breeze://devices/{id}', name: 'Device Detail', mimeType: 'application/json', domain: 'devices' }]`), filtered with `isDomainGranted`.
  - **Audit `resourceId`:** set to `correlation.requestId`. Keep `details.sessionId` and `details.hasSession` for legacy triage queries, and add `correlationAuditDetails(...)`.
  - **Env:** add `MCP_STATELESS_ENABLED` via `envFlag('MCP_STATELESS_ENABLED', false)` (`env.ts:12` pattern) and `z.string().optional()` in `validate.ts`. Also add `MCP_HEADER_MISMATCH_ALERT_THRESHOLD` and document both in `.env.example` near the other `MCP_*` entries (`:690-715`).
- [ ] **Step 4:** Run green. Then rerun `mcpServer.streamable.test.ts`, `mcpServer.test.ts`, `mcpServer.bootstrapLifecycle.test.ts`, `mcpServer.approvalGate.test.ts`, `mcpServer.domains.test.ts`, `mcpServer.stepUp.test.ts`, `mcpServer.conformance.contract.test.ts`, `mcpServer.returnedError.test.ts`, `mcpServer.tenantToolAmbientContext.test.ts` and `mcpToolExecutionLedger.test.ts`, one or two files per invocation. All must stay green. Update only assertions that read `resourceId: <sessionId>`, and list each such edit in the commit message.
- [ ] **Step 5:** Typecheck (12 GB heap, read the exit code), then commit `feat(mcp): stateless 2026-07-28 dual-era on POST /sse (B-W03 #6157)`.

### Task 5: Parity and per-version conformance contracts

**Files:**
- Create `apps/api/src/routes/mcpServer.statelessParity.contract.test.ts`
- Modify `apps/api/src/routes/mcpServer.conformance.contract.test.ts`

**Interfaces:** Consumes the Task 4 route behaviour. Produces no code.

- [ ] **Step 1: Write the parity contract.** It is a table-driven `describe.each` over these principals:
  - API key with all scopes
  - API key with `ai:read` only
  - OAuth bearer with all scopes
  - OAuth bearer with a `['monitoring']` domain grant
  - partner service principal key

  Each principal runs these cases:
  - `tools/list` names
  - `tools/call` of a tier-1 tool in a granted domain
  - `tools/call` of a tool outside the domain grant (`domain_not_granted`, `-32003`)
  - `tools/call` of a tier-2 tool with `ai:read` only. Run it with `MCP_INSUFFICIENT_SCOPE_HTTP_403` both `false` and `true`.
  - `tools/call` of a tier-3 tool (`MCP_APPROVAL_REQUIRED`)
  - `resources/read` outside the grant
  - an unknown tool

  For each pair, send the legacy request (initialize, then `POST /sse` with the owned session) and the modern request. Assert:
  ```ts
  expect(modern.body.error ?? null).toEqual(legacy.body.error ?? null);
  expect(stripModernDecoration(modern.body.result)).toEqual(legacy.body.result);
  expect(modern.status).toBe(legacy.status);
  expect(modern.headers.get('www-authenticate')).toBe(legacy.headers.get('www-authenticate'));
  expect(omitCorrelation(modernAudit.details)).toEqual(omitCorrelation(legacyAudit.details));
  ```
  Modern audit rows write `hasSession: false` and no `sessionId`. `omitCorrelation` strips `correlation`, `clientInfoTrust`, `sessionId`, `hasSession` and `rawResourceId`. Compare the row's `resourceId` separately, as a UUID in both eras.
  `stripModernDecoration` removes `resultType`, `ttlMs`, `cacheScope` and `_meta['io.modelcontextprotocol/serverInfo']`, and only those keys. The documented exception row is unknown method → modern 404 vs legacy 200.
- [ ] **Step 2:** Add `cacheable results are per-principal and private`. In modern, two principals call `tools/list` back to back; their lists differ by the domain grant, and both are `private`.
- [ ] **Step 3:** In the conformance contract, add a `describe('2026-07-28 (stateless)')` covering `server/discover` → `tools/list` → `tools/call`. It asserts the `resultType`, `supportedVersions` containing every `SUPPORTED_MCP_PROTOCOL_VERSIONS` entry, and the absence of `Mcp-Session-Id`.
- [ ] **Step 4:** Run both files and expect them green. Mutation check: temporarily skip `buildCheckedAuthFromApiKey` on the modern branch and confirm the parity contract goes red. Revert.
- [ ] **Step 5:** Commit.

### Task 6: HTTP+SSE deprecation headers, open audit, Origin and CORS

**Files:**
- Modify `apps/api/src/routes/mcpServer.ts`: `GET /sse` `:441` and `POST /message` `:730`.
- Create `apps/api/src/services/corsPolicy.ts` and `corsPolicy.test.ts`.
- Modify `apps/api/src/index.ts` `:467,555-565`.
- Extend `apps/api/src/routes/mcpServer.modern.test.ts`.

**Interfaces — Produces:**
- `MCP_HTTP_SSE_DEPRECATION = '@1742947200'`
- `MCP_HTTP_SSE_SUNSET = 'Sun, 31 Jan 2027 23:59:59 GMT'`. This value is provisional; see Open Decision 2.
- `resolveCorsOrigin: (origin?: string) => string | null`. This moves the `createCorsOriginResolver({...})` factory call verbatim from `index.ts:467` into `corsPolicy.ts`; `index.ts` then imports the instance.
- `CORS_ALLOW_HEADERS: readonly string[]` and `CORS_EXPOSE_HEADERS: readonly string[]`.
- `checkMcpOrigin(c: Context, era: 'legacy' | 'modern'): Response | null`.

- [ ] **Step 1: Write the failing tests.**
  - `GET /sse sets Deprecation and Sunset and writes one mcp.transport.http_sse.open audit row`
  - `POST /message sets Deprecation and Sunset`
  - `POST /sse (Streamable, either era) sets neither`
  - `modern request with a disallowed Origin → 403 with id-less -32600`
  - `modern request with no Origin passes`
  - `legacy request with a disallowed Origin passes and is counted (log-only)`
  - `CORS_ALLOW_HEADERS includes MCP-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name`
  - `CORS_EXPOSE_HEADERS includes Mcp-Session-Id and WWW-Authenticate`
  - Through the full `app` (`index.ts`): `OPTIONS /api/v1/mcp/sse preflight allows Mcp-Method`
- [ ] **Steps 2–5:** Run red, implement, run green, commit.

### Task 7: PR A — docs, verification, review

**Files:**
- Modify `apps/docs/src/content/docs/features/mcp-server.mdx`. Its `## Transport` section is at `:30-43`; add a "Protocol 2026-07-28 (stateless)" subsection and a deprecation notice for `GET /sse` + `/message` with the Sunset date. Add the env table rows.
- Modify the plan index `docs/superpowers/plans/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization.md`: set the B-W03 row to "PR A open".

- [ ] **Step 1:** Run the whole API unit suite: `cd apps/api && npx vitest run src/routes/mcpServer src/services/mcp`, in small batches on a loaded host. Then run the full `npx vitest run`. Record the pass and fail counts from real output.
- [ ] **Step 2:** Typecheck `apps/api` and read the exit code.
- [ ] **Step 3: Lab.** Run on a per-worktree stack (`pnpm wt-stack`; copy the root `.env`, blank the AI keys, set `BREEZE_WORKSPACE_ENABLED=false` and a free `BREEZE_DOCKER_SUBNET`), with `MCP_STATELESS_ENABLED=true`.
  - Drive `server/discover`, `tools/list` and `tools/call` with the MCP Inspector, or with raw `curl` carrying the SEP-2243 headers.
  - Drive one legacy client (`claude mcp add --transport http …/api/v1/mcp/sse`) and confirm it still initialises.
  - Tear the stack down.
- [ ] **Step 4:** Open PR A against `main`.
  - Title: `feat(mcp): B-W03 stateless 2026-07-28 dual-era transport (#6154)`.
  - Body: `Refs #6157 #6143`, with no closing keyword. Include gate counts, the D-B13–D-B19, D-B22 and D-B23 summary, and the Open Decisions with the defaults taken.
- [ ] **Step 5:** Run one `/pr-review-toolkit:review-pr` round (auth surface).

### Task 8: CIMD policy module and provider `fetch`

**Files:**
- Create `apps/api/src/oauth/cimdPolicy.ts` and `cimdPolicy.test.ts`.
- Modify `config/env.ts` (next to `OAUTH_DCR_*` at `:683`), `config/validate.ts` (schema next to `:841`; the boot check for the CSV goes in the superRefine, next to the DCR posture check at `:1782`) and the root `.env.example` (next to `OAUTH_DCR_*` at `:1693-1705`).
- `checkSsrfSafe` is imported from `services/ssrfGuard.ts` (`:91`), and `safeFetch` from `services/urlSafety.ts` (`:536`).

**Interfaces — Produces:**
```ts
export function isCimdClientId(id: unknown): id is string;
export function cimdHostAllowed(host: string, allowlist: readonly string[]): boolean;   // '.suffix' semantics, same as edrProviders/guardedFetch.ts hostAllowed
export async function cimdAllowFetch(ctx: unknown, clientId: string): Promise<boolean>;
export async function cimdAllowClient(ctx: unknown, client: { clientId: string; metadata(): Record<string, unknown> }): Promise<boolean>;
export function validateCimdMetadata(clientId: string, metadata: Record<string, unknown>): { ok: true } | { ok: false; reason: string };
export function createOidcProviderFetch(deps?: { fetchImpl?: typeof safeFetch; now?: () => number }): (url: string | URL, init?: RequestInit) => Promise<Response>;
export const CIMD_FETCH_BUDGET = { perHostPerMinute: 10, globalPerMinute: 120, createsPerHour: 200 } as const;
export const CIMD_FETCH_TIMEOUT_MS = 5000, CIMD_MAX_BYTES = 5 * 1024, CIMD_APPROVAL_TTL_MS = 30_000;
```
The env flags are `OAUTH_CIMD_ENABLED = envFlag('OAUTH_CIMD_ENABLED', false)` and `OAUTH_CIMD_ALLOWED_HOSTS`, a CSV parsed once. Boot rejects an entry that is not a hostname or a `.suffix`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  it('isCimdClientId: https + real path only', () => {
    expect(isCimdClientId('https://client.example.com/oauth/metadata.json')).toBe(true);
    for (const bad of ['http://client.example.com/x', 'https://client.example.com/', 'https://client.example.com',
      'https://u:p@client.example.com/x', 'https://client.example.com/x#f', 'https://client.example.com/a/../x',
      'https://client.example.com/%2e%2e/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'Ab3dDcrStyleId'])
      expect(isCimdClientId(bad)).toBe(false);
  });
  it.each([
    ['flag off', { enabled: false }],
    ['host not in OAUTH_CIMD_ALLOWED_HOSTS', { allowlist: ['.trusted.example.org'] }],
    ['per-host budget spent', { hostBudgetLeft: 0 }],
    ['global budget spent', { globalBudgetLeft: 0 }],
    ['production without redis', { nodeEnv: 'production', redis: null }],
  ])('allowFetch refuses: %s', async (_l, env) => {
    expect(await withCimdEnv(env, () => cimdAllowFetch({}, 'https://client.example.com/oauth/metadata.json'))).toBe(false);
  });
  it('allowFetch admits a suffix match and registers a single approval', ...); // allowlist ['.example.com'] → true; the approval map has exactly that URL
  it('validateCimdMetadata requires client_name, public auth, policy-valid redirect_uris, no DCR-rejected fields', () => {
    const ok = { client_id: ID, client_name: 'Example', redirect_uris: ['http://127.0.0.1:3000/cb'], token_endpoint_auth_method: 'none' };
    expect(validateCimdMetadata(ID, ok).ok).toBe(true);
    for (const patch of [{ client_name: undefined }, { client_name: 'x'.repeat(129) }, { token_endpoint_auth_method: 'private_key_jwt' },
      { redirect_uris: ['http://10.0.0.5/cb'] }, { sector_identifier_uri: 'https://evil.example.net/s' }, { jwks_uri: 'https://evil.example.net/j' }])
      expect(validateCimdMetadata(ID, { ...ok, ...patch }).ok).toBe(false);
  });
  it('provider fetch refuses any URL allowFetch did not approve', async () => {
    const f = createOidcProviderFetch({ fetchImpl: spy });
    await expect(f('https://evil.example.net/sector')).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
  it('an approval is single-use and expires after 30 s', async () => {
    // approve URL at t=0; the first fetch calls spy once; a second fetch of the same URL rejects;
    // re-approve, advance now() by 30_001 → the fetch rejects and the spy is not called again
  });
  it('passes a hard deadline signal and maxBytes 5120 to safeFetch', async () => {
    // spy receives init.maxBytes === 5120 and an init.signal that aborts within 5000 ms even when the library passed none
  });
  ```
  `withCimdEnv` is a test helper. It sets the env flags and the allowlist, stubs `rateLimiter` with the given budgets, stubs `getRedis`, and restores everything afterwards. Also add `validate.ts` tests: `boot rejects a malformed OAUTH_CIMD_ALLOWED_HOSTS entry (scheme, path, wildcard, empty item)` and `accepts example.com,.example.org`.
- [ ] **Steps 2–5:** Run red, implement, run green, commit. `allowFetch` registers the approval in a bounded `Map` (≤ 1 000 entries, oldest evicted).

### Task 9: Provider configuration, adapter, materialisation and cleanup

**Files:**
- Modify `apps/api/src/oauth/provider.ts` (`:96-139` cleanup, `:440-617` the `new Provider` config).
- Create `apps/api/src/oauth/cimdClients.ts` and `cimdClients.test.ts`.
- Modify `apps/api/src/oauth/adapter.ts` (`:257` upsert, `:368` find).
- Tests: `oauth/provider.test.ts`, `oauth/adapter.test.ts` and `oauth/provider.cleanup.test.ts`.

**Interfaces — Produces:**
- `buildOidcProviderConfiguration(jwks): Configuration`, a pure function extracted verbatim from the `new Provider(OAUTH_ISSUER, {...})` literal. It adds the following:
  - `features.clientIdMetadataDocument = { enabled: OAUTH_CIMD_ENABLED, ack: 'draft-02', allowFetch: cimdAllowFetch, allowClient: cimdAllowClient, cacheDuration: { min: 300, max: 86400 } }`
  - top-level `fetch: createOidcProviderFetch()`. This is the top-level `fetch` option (`lib/helpers/defaults.js` ~3879 in 9.12.2).
- `materializeCimdClient(clientId: string, metadata: Record<string, unknown>): Promise<'created' | 'updated' | 'unchanged' | 'disabled' | 'budget_exceeded'>`.

- [ ] **Step 1: Write the failing tests.**
  - `buildOidcProviderConfiguration enables CIMD with ack draft-02 only when OAUTH_CIMD_ENABLED`
  - `iss is always emitted: no jwtResponseModes, response types are code only` (D-B21 pin)
  - `adapter.find(Client) returns undefined for a CIMD id even when a row exists`
  - `adapter.upsert(Client) refuses a CIMD id`
  - `materializeCimdClient creates once, is unchanged on the same metadata, updates on a metadata hash change after 60 s, returns disabled for a disabled row, and returns budget_exceeded without writing when the create budget is spent`
  - `allowClient re-evaluates disable and host policy on cache hits`. Resolve once, then disable the row or narrow the allowlist; the second resolution with no fetch → false.
  - `cleanup never deletes a disabled client, one with org blocks, or one referenced by an approval request` (`provider.cleanup.test.ts`)
  - `a CIMD client honours an org block`. This test goes in `middleware/bearerTokenAuth.test.ts`: a bearer whose `client_id` claim is the URL loses an org that blocked that URL. `filterBlockedOAuthClientOrgIds` (`bearerTokenAuth.ts:370`) is module-private, so drive it through the middleware.
- [ ] **Step 2:** Run each file red.
- [ ] **Step 3: Implement.** `cimdAllowClient` calls `materializeCimdClient` last, and only after every check passes. Any result other than `created`, `updated` or `unchanged` → `false`. Every refusal logs through `logOauthWarn` with a new `ERROR_IDS.OAUTH_CIMD_REFUSED` and a bounded `reason`.
- [ ] **Step 4:** Run green: the four files plus `oauth/*.test.ts` in batches.
- [ ] **Step 5:** Commit `feat(oauth): Client ID Metadata Documents behind OAUTH_CIMD_ENABLED (B-W03 #6157)`.

### Task 10: AS metadata, consent payload and consent UI

**Files:**
- Modify `apps/api/src/routes/oauthWellKnown.ts` and its test (`:25-44` uses `toMatchObject`, so add explicit assertions).
- Modify `apps/api/src/routes/oauthInteraction.ts` (`:141-232`) and its test.
- Modify `apps/web/src/components/oauth/ConsentForm.tsx` and `ConsentForm.test.tsx`.
- Modify `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/common.json`, under `longTail.oauth.ConsentForm.*` (`en/common.json:2334`).

**Interfaces — Produces:** The consent `client` object gains these fields:
- `registration: 'metadata_document' | 'dynamic'`
- `client_id_host: string | null`
- `redirect_host: string` (`''` when unparseable)
- `localhost_redirect: boolean` (true when the redirect host is in the `redirectUriPolicy.ts` loopback set)

The new locale keys are `metadataHostedAt` ("App details published by {{host}}") and `localhostRedirectWarning` ("This app will receive access on this computer. Continue only if you started this connection yourself.").

- [ ] **Step 1: Write the failing tests.**
  - `AS metadata includes authorization_response_iss_parameter_supported: true`
  - `AS metadata includes client_id_metadata_document_supported only when OAUTH_CIMD_ENABLED`
  - `consent payload marks a URL client_id as metadata_document with its host and keeps verification unverified`
  - `consent payload flags a loopback redirect`
  - `ConsentForm shows the metadata host line only for metadata_document`
  - `ConsentForm shows the localhost warning only for metadata_document + localhost_redirect`
  - `ConsentForm still renders the redirect host prominently`
- [ ] **Step 2:** Run red. Then implement, adding the keys to **all 8 locales**. Run `apps/web/src/lib/i18n/localeParity.test.ts` green.
- [ ] **Step 3:** Typecheck `apps/api` and `apps/web`, reading the exit codes.
- [ ] **Step 4:** Commit.

### Task 11: PR B — docs, contracts, lab, review

- [ ] **Step 1: Docs.** Update `mcp-server.mdx`:
  - In `### OAuth 2.1` (`:92`), document CIMD next to DCR: preference order, `OAUTH_CIMD_ENABLED`, `OAUTH_CIMD_ALLOWED_HOSTS`, budgets, the consent display, and how to disable a client.
  - Document the `iss` parameter.
  - Add rows to the env table (`:703-705`).

  Then set the index row to "implemented".
- [ ] **Step 2: Contracts on the stack.** Run these: `rls-coverage`, `tenant-export-policy`, `tenantCascade`, `aiAgentSdkTools.mcpCoverage.test.ts`, the MCP conformance and parity contracts, and the oauth well-known suite. Record the counts from real output.
- [ ] **Step 3: Lab.**
  1. On the wave stack, set `OAUTH_CIMD_ENABLED=true` and serve a metadata document from a public https URL you control. A tunnel is fine; never commit its hostname.
  2. Complete an authorization-code + PKCE flow with that URL as `client_id` and confirm the redirect carries `iss`.
  3. Confirm the `oauth_clients` row exists with `id` = the URL.
  4. Disable the client through `revokeClientFamilies` and confirm the next authorization is refused.
  5. Tear the stack down.
- [ ] **Step 4:** Open PR B.
  - Title: `feat(oauth): B-W03 Client ID Metadata Documents + RFC 9207 iss metadata (#6154)`.
  - Body: `Closes #6157`, `Refs #6143`. Include the Settings rule 9 line:
    - home: the server env (operator setting);
    - level: deployment;
    - places configured: 0 → 2 flags.
- [ ] **Step 5:** Run one `/pr-review-toolkit:review-pr` round (auth surface).

---

## CI traps

- `pnpm test` does not run the RLS or integration suites. Run them on the stack (Tasks 7 and 11). CI's 16-shard `integration-test` job is what blocks merge.
- PR B is stacked on PR A until A merges. Base B on the wave branch, and once A merges to `main` retarget B to `main`. A PR whose base is not `main` runs no CI, so use `gh workflow run CI --ref <branch>`.
- `tsc` must never be piped to `tail`, because a heap OOM reads as green. Use the 12 GB heap and `echo exit=$?`.
- `localeParity` lives in `apps/web/src/lib/i18n`. A key added to `en` alone fails it. There are 8 locales.
- The conformance contract's `describe.each` must iterate `LEGACY_MCP_PROTOCOL_VERSIONS`. Iterating `SUPPORTED` would run an `initialize` session for `2026-07-28` and fail on negotiation.
- Vitest path filters are substring matches. `src/routes/mcpServer` matches about 20 files, so batch them on a loaded host.

## Exit checklist

- [ ] There is no migration, and the reserved slot `2026-12-31-130000` is unused. `rls-coverage`, `tenant-export-policy` and `tenantCascade` are green and unchanged.
- [ ] Legacy behaviour is byte-identical except for the six documented exceptions (Global Constraints). The per-version conformance suite is green for all 4 legacy versions.
- [ ] The modern era passes the parity contract: same errors, same status (bar `-32601` → 404), same `WWW-Authenticate`, and same audit details minus correlation.
- [ ] No `Mcp-Session-Id` is read, minted or echoed on a modern request, and the session store is untouched.
- [ ] A single `requestId` is present in the request audit, the tool audit, and both ledger representations.
- [ ] Every cacheable modern result is `private` with `ttlMs ≥ 0`, and there is no server-side cache.
- [ ] Both flags default off. Flag-off modern requests get a non-modern 400 before legacy processing.
- [ ] CIMD meets all of the following:
  - The fetch is gated and budgeted, and goes through `safeFetch` with a hard deadline.
  - Secondary fetches are impossible.
  - `allowClient` is live on cache hits.
  - Rows are materialised without per-use writes.
  - Tombstones and blocks survive cleanup.
- [ ] AS metadata advertises `iss` (always) and CIMD (when on). The iss config pin is green.
- [ ] The consent screen shows the metadata host and the loopback warning, and all 8 locales are in parity.
- [ ] `GET /sse` and `/message` carry `Deprecation` and `Sunset`, and stream opens are audited.
- [ ] Open Decisions 1–4 are resolved by Todd, or the defaults (A, A, A, A) are recorded in the PR bodies.
- [ ] Docs are updated and the index row is updated. PR B closes only #6157, and #6143 is left for Todd.
- [ ] The stack is torn down.

## Deferred (file as follow-ups when PR B merges)

- **Remove legacy HTTP+SSE** (`GET /sse`, `POST /message`). Removal is gated on the D-B22 telemetry and the Sunset date.
- **Enforce `Origin` on legacy-era requests** after 30 days of counts (Open Decision 4).
- **Platform-admin UI** to globally disable an OAuth client (DCR or CIMD) via `revokeClientFamilies`.
- **`subscriptions/listen`** and `listChanged` notifications. These need a live list-change source first.
- **`x-mcp-header` designations** for routing-relevant tool parameters (e.g. `orgId`). Header validation for `Mcp-Param-*` comes with them.
- **MRTR (`InputRequiredResult`) and the Tasks extension**, which belong to B-W04 and B-W06.
- **Flip `MCP_STATELESS_ENABLED` and `OAUTH_CIMD_ENABLED`** on by default once both regions have run them for a release.
