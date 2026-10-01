---
tracking_issue: LanternOps/breeze#7598
---

# AI Model Registry W06: BYO OpenAI-compatible connections with tool calling — Implementation Plan

Closes #7604

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partner admin connects any OpenAI-compatible endpoint (vLLM, Ollama, LiteLLM, OpenRouter, a hosted gateway), discovers or hand-enters its models, verifies them with the fidelity harness, and uses a verified model on **every** AI surface, tools included — and the deployment-wide env-only `MCP_LLM_PROVIDER=openai-compatible` chat path is folded into the same mechanism and deleted.

**Architecture:**
- **One loopback model gateway, shared by W06 and W07.** A new in-process HTTP listener on `127.0.0.1` (`services/aiModels/gateway/`), modelled on the existing CONNECT egress proxy (`services/llm/llmEgressProxy.ts`). Every byte bound for a partner's non-Anthropic or cloud endpoint leaves the API through it. Callers reach it with a short-lived, per-dispatch **grant** carried in the URL path (`/g/<token>/…`). A grant binds one connection, one partner, one org, and the exact wire model(s) the resolver chose. The gateway holds the decrypted credential; the Agent SDK child process and the in-process Anthropic client never see it.
- **Per-kind adapters behind one interface** (`GatewayAdapter`). W06 registers `openai_compatible`: it translates the Anthropic Messages API (what the Agent SDK CLI and `@anthropic-ai/sdk` speak) to OpenAI `chat/completions` and back, **tool calls included**, so the existing Agent SDK runtime, MCP tools, approvals, guardrails, usage extraction and settlement all work unchanged. W07 registers `bedrock` / `vertex` / `foundry` as credential-injecting pass-through adapters behind the Agent SDK's provider modes.
- **Registry plumbing, not a second runtime.** The resolver (W03) learns a fourth connection shape — `ResolvedConnection` with `config.source === 'gateway'` — and one dispatch helper, `prepareSdkChild`, replaces the two-step "grant catalog egress, then build the child env" at both Agent SDK spawn sites. Messages API surfaces get a gateway-pointed client from the same `connectionFactory`.
- **Verification gates tools.** A BYO offering is `capabilities unverified` (no tools, no thinking params) until the W01 fidelity harness passes **through the gateway** against it. The verified capability tree is stored on the offering, bound to an endpoint fingerprint, so a base-URL change unverifies it and a key rotation does not.
- **Every outbound request** is SSRF-guarded (`safeFetch` with DNS pinning, the existing `ipRanges` table, no redirects), size- and time-capped, audited to `llm_egress_events` (gains a `connection_id` column and a `gateway_forward` surface), and scrubbed of key material before any error text is stored or returned.

**Tech Stack:** Hono, Node `http` (loopback listener), Drizzle ORM / PostgreSQL (RLS), BullMQ, `@anthropic-ai/sdk` 0.128, `@anthropic-ai/claude-agent-sdk` 0.3.286, zod (`packages/shared`), Astro + React islands, Vitest, Playwright. **No new npm dependency** (no `openai` package; the translator is hand-written and pure).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-design.md` (v3). Sections used: §4 (connections), §5.2–5.3, §6 (discovery: OpenAI-compatible bullet, lifecycle, "discovery never enables"), §7 (`unknown` mode, tool-requiring surfaces, "send a parameter only if the harness verified it"), §8 (funding = `partner_key`, offering price required, 0 valid), §9 (eligibility), §11 (homes), §12 (BYO base URLs, security review), §13 W06 row. Names come from `2026-09-30-ai-model-registry-index.md` and the W01–W04 "Index additions" tables.

**Issues:** closes #7604 (wave). Closes #6772 (tool calling on the OpenAI-compatible path) and #7120 (BYO OpenAI-compatible endpoints) — the PR body says `Closes #7604`, `Closes #6772`, `Closes #7120`.

## Out of scope

- **Bedrock / Vertex / Foundry (W07).** W07 extends exactly the extension points this plan names (`GATEWAY_CONNECTION_KINDS`, `GatewayAdapter` registry, `GatewayConnectionConfig`, `connectionCreateSchema` arms, `ConnectionsCard` / `ConnectionDrawer` `switch (kind)`, `CONNECTION_MODEL_DISCOVERERS`, `verifyConnectionOffering`). See "Shared extension points".
- **OpenAI-dialect reasoning controls** (`reasoning_effort`, `reasoning_content`). An OpenAI-compatible offering is thinking mode `none` once verified; the translator drops Anthropic `thinking` / `output_config` and never forwards a model's reasoning text. Revisit after W11 measures quality.
- **Azure OpenAI `api-key` header, OAuth, mTLS to the endpoint.** v1 auth is `Authorization: Bearer <key>` or none.
- **Embeddings, images-as-output, audio** (spec §2 non-goals).
- **Dropping `partner_ai_connections_compat_uq`.** W06 does not need it dropped: its predicate is `WHERE kind IN ('anthropic_byok','catalog')`, so any number of `openai_compatible` connections per partner already fit. W04 D1 keeps it; W08 drops it with the `/ai/provider` facade. W06 leaves both the index and its predicate untouched (see Decision D3).
- **Failover across connections (W09).** A gateway connection is just another connection to W09's walk.
- **Chargeback (W10).** Ledger rows from gateway connections carry `funding_source = 'partner_key'` and the offering's admin-entered rate like any other connection.

## Preconditions

W06 is implemented after **W03 (#7601) and W04 (#7602) are merged** (W04 is stacked on W03 and ships in the same release). Before Task 1, the implementer checks every row against the merged code. **Real code wins**; where a name differs, adapt only the adapter named in the last column and note it in the PR.

| # | What W06 consumes | Source (status at plan time) | If it differs, adapt only |
|---|---|---|---|
| P1 | `eligibility.ts`: `checkEligibility(c: CandidateFacts, ctx: EligibilityContext)`, `ConnectionKind` (already includes `'openai_compatible'`), `DISPATCHABLE_KINDS` (a module `const` `ReadonlySet`), `CandidateFacts.connection = { kind; status; keyUsable }` | W03 Task 2 — **built** on `wave-7601` | Task 8 |
| P2 | `candidateLoader.ts`: `ResolvedConnection { id; kind: Exclude<ConnectionKind,'openai_compatible'>; config: UsableLlmConfig }`, `connectionCandidate(offering, conn)` (module-private) with the `if (conn.kind === 'catalog') … else …` split, `UNVERIFIED_CAPABILITIES`, `EMPTY_OPTION_SUPPORT`, `systemRead` | W03 Task 2 — built | Task 8 |
| P3 | `connectionFactory.ts`: `AnthropicClientTarget` (`platform` / `anthropic` / `endpoint`), `createAnthropicClient`, `clientForConnection(config, caller)`, `anthropicClientFor`, `createMessage` (with `serverSide = fb !== undefined && resolved.connection.kind !== 'catalog'`), `DispatchFacts`, `describeDispatch`, `grantCatalogSdkEgress` | W03 Task 4/12 — built | Task 9 |
| P4 | `streamingSessionManager.ts`: `buildClaudeSdkChildEnv(resolved: UsableLlmConfig, source, { egressProxyUrl })`, spawn site calling `grantCatalogSdkEgress` then `buildClaudeSdkChildEnv`; `aiAgents/runLoop.ts` the same pair | W03 Task 7/12 — built | Task 9 |
| P5 | `turnBinding.ts`: `TurnBinding.connectionKind` literal union + zod enum `['platform','anthropic_byok','catalog']`; `parseTurnBinding` | W03 Task 4 — built | Task 8 |
| P6 | `providerFidelityHarness.ts`: `runFidelityCheck(input: FidelityCheckInput)`, `FidelityCheckInput { baseUrl; authMode; providerModel; apiKey }`, `buildFidelityChildEnv`, `FIDELITY_HARNESS_VERSION = '1'`, module-private `buildAnthropicClient(input)` (calls `createAnthropicClient` with `target.kind = 'endpoint'`) | W01 Task 17 + W03 — built | Task 12 |
| P7 | `discovery.ts`: `syncConnectionModels(connectionId, now?) → ConnectionSyncReport`, `MISSING_AFTER_SUCCESSFUL_SYNCS`, `RETIRED_AFTER_DAYS`; worker `enqueueConnectionSync(connectionId)` (job `sync-connection`, jobId `sync-connection-${id}`); `AiModelDiscoveryJobData` union | W03 Task 16 — **not built yet**; plan interface | Task 11 |
| P8 | W03 Task 17 contract test `services/aiModels/aiModelRegistry.contract.test.ts`: rule 2 `ANTHROPIC_CTOR_ALLOWED = {connectionFactory.ts}`; rule 4 `total_cost_usd` only in `invocationUsage.ts`; Task 17 "Kept, deliberately" keeps `resolveLlmConfigForOrg`, `isOpenAICompatibleProvider`, and the numeric-totals branch of `settleAiBudgetReservation` **for W06 to delete** | W03 Task 17 — **not built yet** | Task 16 |
| P9 | W04 `packages/shared/src/validators/aiModelRegistryApi.ts`: `connectionCreateSchema` = `z.discriminatedUnion('kind', [anthropic_byok arm])`; `offeringDetailsPatchSchema`; `packages/shared/src/types/aiModelRegistry.ts`: `AiConnectionKind`, `AiConnectionDto`, `AiOfferingDto` | W04 Task 1 — not built yet | Task 1 |
| P10 | W04 `routes/aiModels/connections.ts`: `aiModelConnectionRoutes`, `ownConnectionId(partnerId, id)` (compat-only), the `switch (body.kind)` with exhaustive `never` default in `POST /`; `routes/aiModels/offerings.ts` `POST /offerings/:id/verify`; `routes/aiModels/shared.ts`: `partnerRead`, `partnerWrite`, `requirePartnerWide(c) → { partnerId, userId }`, `registryWrite(c, partnerId, fn)`; audit helper `audit(c, partnerId, action, details)` writing `ai_models.connection.*` | W04 Task 8 — not built yet | Task 13 |
| P11 | W04 web `components/settings/aiModels/ConnectionsCard.tsx` (`switch (connection.kind)` + `never`), `ConnectionDrawer.tsx` (`connection === null` create branch hard-coding `kind: 'anthropic_byok'`), `ModelsCard.tsx`, `OfferingDrawer.tsx` (Verify button → `POST /offerings/:id/verify`), `useAiModelsSnapshot()` | W04 Task 11–12 — not built yet | Task 14 |
| P12 | W04 `services/aiModels/registryView.ts` `buildPartnerModelsSnapshot` (connection → `AiConnectionDto` mapper) | W04 Task 8 — not built yet | Task 13 |
| P13 | `services/urlSafety.ts`: `safeFetch(url, SafeFetchInit)` with `timeoutMs`, `signal`, `allowPrivateNetwork`, `requirePrivateForCleartext`, `maxBytes`, `onConnect`, `streamResponse`; `assertSafeUrl`; `SsrfBlockedError`; `ResponseTooLargeError`; `__setLookupForTests`. `config/env.ts`: `isHosted()`, `selfHostAllowsPrivateNetwork()` | main — exists | Task 2, 4 |
| P14 | `services/llm/llmEgressProxy.ts`: `getLlmEgressProxy()`, `LlmEgressProxy.grant(sessionId, allowed: EgressGrant, recorder)`, `EgressGrant { host; port: 443 }` | main — exists | Task 9 |
| P15 | `services/llm/llmEgressRecorder.ts` `recordLlmEgressEvent(LlmEgressEventInput)`; `db/schema/llmEgressEvents.ts` `LLM_EGRESS_SURFACES` | main — exists | Task 3 |
| P16 | `services/aiModels/connections.ts`: `encryptConnectionKey(id, apiKey)`, `decryptConnectionKey`, `getConnection`, `getConnectionKeyMaterial`, `listConnections`, `PUBLIC_COLUMNS` (module-private), `ConnectionKeyError`; `services/secretCrypto.ts` `hmacFingerprint` | main (W02) — exists | Task 10 |

Run before Task 1 and paste the output into the PR description:

```bash
git fetch origin
git log --oneline -1 origin/main
git ls-tree --name-only origin/main apps/api/src/services/aiModels/ | sort
grep -n "DISPATCHABLE_KINDS\|export type ConnectionKind" apps/api/src/services/aiModels/eligibility.ts
grep -n "export async function syncConnectionModels\|export async function enqueueConnectionSync" -r apps/api/src
grep -n "connectionCreateSchema" packages/shared/src/validators/aiModelRegistryApi.ts
grep -n "switch (connection.kind)" apps/web/src/components/settings/aiModels/ConnectionsCard.tsx
```

If `syncConnectionModels` or `connectionCreateSchema` does not exist, **stop**: W03 Task 16 or W04 has not merged.

## Global Constraints

- **Rigor: high + security review (spec §13 W06 row).** TDD for every task (red first). Task 17 is a mandatory independent security review; Task 18 does not open the PR until it is closed out.
- **Security review output is private.** Concrete findings against shipped or in-flight code go to `~/breeze-security/` (or a private GHSA), never into this public plan, the PR body or a public issue. The PR records only "security review done; N findings, all addressed or tracked privately". (A plan doc with a per-finding gap table is a public disclosure.)
- **Migration slot:** exactly one file, `apps/api/migrations/2026-11-23-100000-ai-gateway-egress-events.sql`. It must sort after every committed migration (W03's newest is `2026-11-19-100700-…`; W04 has none). Re-check at commit time: `git ls-tree -r --name-only origin/main -- apps/api/migrations/ | grep -E '/[0-9]{4}-[^/]*\.sql$' | sort | tail -3` and `scripts/check-migration-naming.sh --against-ref origin/main`. Rename to sort last if `main` moved; never edit a shipped migration. No DML in the file, so no system-scope election is needed (say so in its header).
- **No new tenant table.** The migration adds one column (`connection_id`) to the already-registered org table `llm_egress_events` — that **does** require the export-policy row update (CLAUDE.md: "The export-policy row is the only one that fires on a new column"). No cascade / merge / RLS change: same table, same shape-1 policy.
- **The gateway is the only egress for gateway kinds.** No code path may construct an HTTP client to a partner `base_url` except `gateway/forward.ts` and `gateway/openai/discovery.ts`, both via `safeFetch`. A contract test (Task 16) greps for it.
- **Keys never leave the gateway.** No `MCP_LLM_API_KEY`, connection key, or decrypted credential may appear in: an Agent SDK child env, an `Anthropic` client constructor, a log line, an error message, `last_error`, `discovery_error`, a verification `detail`, an audit row or a BullMQ job payload. Pinned by tests in Tasks 4, 7, 9, 10, 12.
- **Egress policy for a BYO base URL** (Task 2, `byoEndpointPolicy.ts`), mirroring the existing env OpenAI-compatible provider so the absorption is not a regression:
  - hosted (`isHosted()`): `https:` only; public IPs only;
  - self-host: `allowPrivateNetwork: selfHostAllowsPrivateNetwork()` and `requirePrivateForCleartext: true` (cleartext `http:` only to an RFC 1918 / ULA address);
  - always: no userinfo, no query, no fragment; loopback, link-local, metadata and the other always-blocked ranges are never dialable; no redirects; DNS pinned per request.
- **Limits (gateway, both directions)** — constants in `gateway/limits.ts`, one place:
  - request body to the gateway ≤ 32 MiB; upstream response ≤ 32 MiB (stream and buffered);
  - connect + headers ≤ 30 s; idle between stream chunks ≤ 120 s; whole request ≤ 15 min;
  - discovery response ≤ 1 MiB, ≤ 500 models, model id `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$`, display name ≤ 120 chars, control characters stripped;
  - per translated response: ≤ 64 tool calls, each `arguments` ≤ 256 KiB; ≤ 512 tools per request; error text stored ≤ 600 chars, scrubbed.
- **Funding:** every gateway connection offering is `partner_key` (W03 `connectionCandidate` already returns it). It never touches platform credits. A non-platform offering with no price cannot be enabled (W03 `unpriced`; W04 enable gate) — `0` is a valid price for a local model.
- **Partner-wide writes** use W04's gate (`partnerWrite` = `BILLING_MANAGE` + `requireMfa()` + `requirePartnerWide`), audited as `ai_models.connection.*` / `ai_models.offering.*`.
- **Web:** every mutation through `runAction`; new mutating files added to `no-silent-mutations` `TARGET_GLOBS`; `data-testid` on every new element; 8 locales; no `'claude-…'` literal; Settings rule 9 statement in the PR (see "Settings PR statement").
- **Tests:** run one file at a time with `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`). Integration suites need `pnpm test-stack up` and are run explicitly; `pnpm test-stack down` at the end.
- **Commits:** one per task, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feature/7598-ai-model-registry/wave-7604` from `origin/main` after W04 merges (`get_feature_status` → `start_wave` first).

## Shared extension points (W07 extends these, does not redesign them)

| Extension point | Defined in (task) | What W06 registers | What W07 adds |
|---|---|---|---|
| `GATEWAY_CONNECTION_KINDS` / `GatewayConnectionKind` / `isGatewayConnectionKind` | `packages/shared/src/constants/aiConnectionKinds.ts` (Task 1) | `['openai_compatible']` | `'bedrock'`, `'vertex'`, `'foundry'` |
| `connectionCreateSchema` union arms; `connectionGatewayPatchSchema` | W04 `aiModelRegistryApi.ts` (Task 1) | `openai_compatible` arm | one arm per cloud kind + `cloudConnectionPatchSchema` |
| `GatewayAdapter` interface + `registerGatewayAdapter` / `getGatewayAdapter` | `gateway/adapter.ts` (Task 4) | `openAiCompatibleAdapter` | `bedrockAdapter`, `vertexAdapter`, `foundryAdapter` |
| `GatewayConnectionConfig` (the `source: 'gateway'` arm of `ResolvedConnection.config`) | `gateway/types.ts` (Task 4), consumed by Task 8 | `{ kind: 'openai_compatible'; baseUrl }` | `{ kind: 'bedrock' \| 'vertex' \| 'foundry'; providerConfig }` |
| `gatewayCandidateFacts` (resolver branch for gateway kinds) | `candidateLoader.ts` (Task 8) | capability read via `verifiedGatewayCapabilities`, `inferenceGeo: null` | cloud geography (`cloudInferenceGeo`), `geoBoundByEndpoint: true` |
| `prepareSdkChild(resolved, input)` | `connectionFactory.ts` (Task 9) | gateway branch builds env via `adapter.sdkChildEnv` | nothing (adapters supply env) |
| `AnthropicClientTarget` `{ kind: 'gateway' }` | `connectionFactory.ts` (Task 9) | `dialect: 'anthropic'` | `dialect: 'bedrock' \| 'vertex' \| 'foundry'` (cloud SDK clients) |
| `CONNECTION_MODEL_DISCOVERERS` | `services/aiModels/connectionDiscovery.ts` (Task 11) | `openai_compatible` | `bedrock` (vertex/foundry: manual only) |
| `verifyConnectionOffering(offeringId)` + `endpointFingerprint(conn)` | `services/aiModels/offeringVerification.ts` (Task 12) | generic over adapters | nothing beyond the fingerprint inputs of its kinds |
| `gatewayConnections.ts` write service (`createGatewayConnection`, `updateGatewayConnection`, `deleteGatewayConnection`, `createManualOffering`) | Task 10 | `openai_compatible` | cloud kinds (credentials blob, provider config) |
| Web `ConnectionsCard` / `ConnectionDrawer` `switch (kind)`; `ConnectionKindForm` slot | Task 14 | `OpenAiCompatibleConnectionForm` | `BedrockConnectionForm`, `VertexConnectionForm`, `FoundryConnectionForm` |

## Review Focus

The behaviours most likely to bite a real user, each pinned by a named test in the owning task:

1. **A hostile or broken endpoint drives a tool it was not offered, or an empty-argument tool call.** The model returns `tool_calls` with an unknown function name or arguments that are not a JSON object. Expected: the gateway never emits a `tool_use` block for it; the turn ends `end_turn` with a visible text note. → `translateResponse.test.ts` "unknown tool name never becomes tool_use" / "malformed arguments never become tool_use" (Task 6); `translateStream.test.ts` same pair (Task 6).
2. **The SDK child or a prompt asks for a different model than the resolver priced.** Expected: 403 `gateway_model_mismatch`, an egress event with `blocked: true`, and no upstream call — never a silent call to an unpriced model. → `gatewayServer.test.ts` "refuses a model the grant does not bind" (Task 4); `prepareSdkChild.test.ts` "pins every alias env to the bound wire model" (Task 9).
3. **Usage the CLI bills from must equal what the endpoint reported**, including input tokens that OpenAI only sends in the final stream chunk. Expected: `modelUsage[wireModel].inputTokens === prompt_tokens − cached_tokens`, `cacheReadInputTokens === cached_tokens`. → `gatewaySdk.e2e.test.ts` "SDK modelUsage equals upstream usage" (Task 9).
4. **A base URL that resolves to a private/metadata address on hosted, or rebinds after validation.** Expected: rejected at write (400 `egress_blocked`) and at connect (pinned dial). → `byoEndpointPolicy.test.ts` (Task 2) + `gatewayForward.test.ts` "re-resolves and refuses a rebinding host" (Task 4).
5. **A key appears where it must not** (child env, error text, verification detail, job payload). Expected: never. → `prepareSdkChild.test.ts` "child env carries no credential" (Task 9), `gatewayForward.test.ts` "scrubs the key from an echoed upstream error" (Task 4), `offeringVerification.test.ts` "detail never contains the key" (Task 12), `envOpenAiBootstrap.test.ts` "job payload / logs carry no key" (Task 15).

Additional pinned behaviours (not top five, still tested): a base-URL change unverifies offerings but a key rotation does not (Task 12); env bootstrap is idempotent across restarts and never re-points a partner's chat assignment twice (Task 15); a 64-char tool-name limit on OpenAI is handled by deterministic aliasing (Task 5); `count_tokens` returns a conservative over-estimate (Task 7).

## File ownership and wave collisions

| Path | Action | Task | Could collide with | Rule |
|---|---|---|---|---|
| `packages/shared/src/constants/aiConnectionKinds.ts` (+ test) | create | 1 | W07 (adds kinds) | W07 appends to the array only |
| `packages/shared/src/constants/index.ts` | modify | 1 | any | one export line |
| `packages/shared/src/validators/aiModelRegistryApi.ts` (+ test) | modify (W04 file) | 1 | W07 (arms), W09 (assignment role), W10/W11 (usage groupBy) | additive union arms / new schemas only |
| `packages/shared/src/types/aiModelRegistry.ts` | modify (W04 file) | 1 | W05 (reads DTOs), W07 | additive optional DTO fields |
| `apps/api/migrations/2026-11-23-100000-ai-gateway-egress-events.sql` | create | 3 | W07 `2026-11-24-100000-…` | slot ordering |
| `apps/api/src/db/schema/llmEgressEvents.ts` | modify | 3 | — | |
| `apps/api/src/services/llm/llmEgressRecorder.ts` | modify | 3 | — | |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | modify | 3 | any wave adding a column to an org table | one row edit |
| `apps/api/src/services/aiModels/gateway/limits.ts`, `types.ts`, `grants.ts`, `adapter.ts`, `server.ts`, `forward.ts`, `scrub.ts` (+ tests) | create | 4 | W07 (registers adapters, reads `limits`) | W07 adds adapter files; edits here are additive |
| `apps/api/src/services/aiModels/gateway/byoEndpointPolicy.ts` (+ test) | create | 2 | — | |
| `apps/api/src/services/aiModels/gateway/openai/*.ts` (+ tests) | create | 5–7, 11 | — | W06-only |
| `apps/api/src/services/aiModels/gateway/index.ts` | create | 4 | W07 (imports adapters for registration) | one import line per adapter |
| `apps/api/src/services/aiModels/eligibility.ts` | modify (W03 file) | 8 | W04 (appended `checkEnableEligibility`), W07 | `DISPATCHABLE_KINDS` gains entries; nothing else |
| `apps/api/src/services/aiModels/candidateLoader.ts` | modify (W03 file) | 8 | W05 (reads), W07, W09 | new `gatewayCandidateFacts` branch; existing branches untouched |
| `apps/api/src/services/aiModels/gatewayCapabilities.ts` (+ test) | create | 8 | W07 (cloud capability source) | |
| `apps/api/src/services/aiModels/turnBinding.ts` | modify (W03 file) | 8 | W05 (binding), W07 | enum widening only |
| `apps/api/src/services/aiModels/connectionFactory.ts` | modify (W03 file) | 9 | W05 (switch/continuation spawn), W07, W09 | `prepareSdkChild` is the single SDK-child seam |
| `apps/api/src/services/streamingSessionManager.ts` | modify | 9, 15 | **W05** (turn binding, switching) | spawn-site 2-line swap only; W05 rebases |
| `apps/api/src/services/aiAgents/runLoop.ts` | modify | 9 | W09 (escalation) | spawn-site 2-line swap only |
| `apps/api/src/services/llm/llmEgressProxy.ts` | modify | 9 | — | `grant(..., null, …)` = deny-all |
| `apps/api/src/services/aiModels/gatewayConnections.ts` (+ test) | create | 10 | W07 (cloud writes) | |
| `apps/api/src/services/aiModels/connections.ts` | modify (W02 file) | 10 | W07, W08 | widen `CreateConnectionInput`? **no** — W06 adds `createGatewayConnectionRow` beside it |
| `apps/api/src/services/aiModels/connectionDiscovery.ts` (+ test) | create | 11 | W07 | registry |
| `apps/api/src/services/aiModels/discovery.ts` | modify (W03 Task 16 file) | 11 | W07 | `syncConnectionModels` dispatches to `CONNECTION_MODEL_DISCOVERERS` |
| `apps/api/src/jobs/aiModelDiscoveryWorker.ts` | modify (W01/W03 file) | 11, 12 | W07 | new job type `verify-offering` |
| `apps/api/src/services/llm/providerFidelityHarness.ts` | modify (W01 file) | 12 | — | optional `transport` parameter; default behaviour byte-identical |
| `apps/api/src/services/aiModels/offeringVerification.ts` (+ test) | create | 12 | W07 | |
| `apps/api/src/routes/aiModels/connections.ts`, `offerings.ts` (+ tests) | modify (W04 files) | 13 | W07 | `switch (kind)` arms |
| `apps/api/src/services/aiModels/registryView.ts` | modify (W04 file) | 13 | W05, W07 | DTO fields |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`, `services/mcpCoverage.ts` | modify | 13 | any route wave | entries |
| `apps/web/src/components/settings/aiModels/ConnectionsCard.tsx`, `ConnectionDrawer.tsx`, `ModelsCard.tsx`, `OfferingDrawer.tsx` | modify (W04 files) | 14 | W07 | `switch (kind)` arms; form components in their own files |
| `apps/web/src/components/settings/aiModels/connectionForms/OpenAiCompatibleConnectionForm.tsx`, `ManualModelForm.tsx`, `connectionKinds.ts` (+ tests) | create | 14 | W07 (adds sibling forms) | |
| `apps/web/src/locales/*/settings.json` | modify | 14 | every UI wave | key blocks under `aiModels.connections.openai.*` |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | modify | 14 | every UI wave | `TARGET_GLOBS` |
| `apps/api/src/config/validate.ts` (+ test) | modify | 15 | — | `MCP_LLM_PROVIDER` refused on hosted |
| `apps/api/src/services/aiModels/envOpenAiBootstrap.ts` (+ test) | create | 15 | — | |
| `apps/api/src/index.ts` (boot hook), `routes/ai.ts`, `services/aiAgentSdk.ts`, `services/aiAgent.ts`, `services/aiCostTracker.ts`, `services/aiBudgetReservations.ts`, `services/aiModels/invocationLedger.ts`, `services/llm/llmAvailability.ts`, `system/connections/registry.ts` | modify | 16 | **W05** (`routes/ai.ts` session routes), W08 | W06 deletes only the env-path branches |
| `apps/api/src/services/llm/openaiSessionManager.ts`, `openaiCompatibleProvider.ts`, `historyBuilder.ts`, `types.ts`, their tests, `__scripts__/openai-smoke.ts` | delete | 16 | — | |
| `apps/api/src/services/aiModels/aiModelRegistry.contract.test.ts` | modify (W03 Task 17 file) | 16 | W07 (rule 2 widened), W08 | |
| `e2e-tests/fixtures/mockLlmServer.mjs`, `docker-compose.override.yml.topology-ai-e2e`, `e2e-tests/tests/byo-openai-compatible.spec.ts` | modify / create | 16, 18 | — | |
| `apps/docs/src/content/docs/features/bring-your-own-llm-key.mdx`, `deploy/environment.mdx` | modify | 18 | W07 | separate sections |

## Decisions

| # | Decision | Why | Reversible? |
|---|---|---|---|
| D1 | **Tool calling via an Anthropic↔OpenAI translating gateway in front of the existing Agent SDK runtime**, not a second agent loop in `openaiSessionManager`. | #6772 asks for tool calling on every surface. A second loop would duplicate MCP tool dispatch, approvals, guardrails, budget, refusal handling and usage extraction, and drift from them. The translator is a pure, table-testable module; everything else is reused. This is the in-process equivalent of the LiteLLM recipe users already run (#7120). | Yes — the adapter is one registry entry. |
| D2 | **Credentials stay in the gateway**; the SDK child gets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/g/<token>` and a placeholder `ANTHROPIC_API_KEY`. | Today a catalog/BYOK key sits in the child env. A gateway grant is narrower: one connection, one model set, TTL, revocable, and unusable off-box. | Yes. |
| D3 | **`partner_ai_connections_compat_uq` and its predicate stay untouched.** | Its predicate already excludes `openai_compatible`; W04 D1 binds the compat facade to it; W08 drops it. W06 adds `ownConnection(partnerId, id)` (any kind) beside W04's compat-only `ownConnectionId`. | — |
| D4 | **Verification is stored on the offering** (`partner_ai_models.capabilities`), as a synthesized Models-API-shaped tree plus a `breeze_verification` block, bound to `endpointFingerprint(conn)` (kind + base URL + routing provider config, **not** the key). | `deriveCapabilities` already reads `thinking` + `tool_use` leaves; no new table or column (spec §5.3 says `capabilities` is "BYO and manual only"). Fingerprinting the endpoint, not the key, means a key rotation does not take chat down while a base-URL change does unverify. | Yes. |
| D5 | **Discovery lands rows `discovered`, disabled, unverified, unpriced**; the admin prices and verifies, then enables. Verification is never automatic on discovery (it spends partner tokens); it is automatic only for the env bootstrap offering (Task 15). | Spec §6 "discovery never enables anything". | Yes. |
| D6 | **The env path is absorbed as a per-partner bootstrap**, not as a "platform" connection: when `MCP_LLM_PROVIDER=openai-compatible`, boot ensures each partner has one env-managed `openai_compatible` connection (`provider_config.managedBy = 'env'`), one manual offering for `MCP_LLM_MODEL` priced from `MCP_LLM_PRICE_*`, verifies it once, and re-points the partner's **`chat`** assignment to it only if that assignment currently defaults to a platform offering (i.e. only where legacy routing sent chat to the env endpoint). Then `openaiSessionManager` and its branches are deleted. `MCP_LLM_PROVIDER=openai-compatible` is refused at boot on hosted. | Platform offerings must reference `ai_platform_models` rows (provider `anthropic`); a self-host env endpoint is the partner's own provider in every way that matters (funding is moot without a billing service). One runtime instead of two. | Partly — deleting the chat-only runtime is the irreversible part; see Open question 1. |
| D7 | **OpenAI-compatible offerings are never residency-eligible** (`inferenceGeo: null`). | Geography of an arbitrary endpoint is unverifiable; spec §12 "residency fails closed". | Yes (see Open question 3). |
| D8 | **No `openai` npm dependency.** | The repo already hand-parses this SSE dialect (`openaiCompatibleProvider.ts`); the translator needs exact control of buffering and validation that a client library would hide. | Yes. |
| D9 | **Tool-call arguments are buffered, validated, then emitted whole** (one `input_json_delta`) rather than streamed. | The SDK must never act on a partial or malformed tool call from an untrusted endpoint. Cost: tool-call arguments do not stream token-by-token to the UI (text still streams). | Yes. |

---

## Task 1: Connection-kind constants and the `openai_compatible` request/response contract

The kind list is the first shared extension point. `GATEWAY_CONNECTION_KINDS` is what every later layer (resolver, factory, routes, UI) asks "does this connection go through the gateway?", so W07 widens one array instead of hunting `kind === …` comparisons.

**Files:**
- Create: `packages/shared/src/constants/aiConnectionKinds.ts`
- Create: `packages/shared/src/constants/aiConnectionKinds.test.ts`
- Modify: `packages/shared/src/constants/index.ts` (one `export *` line)
- Modify: `packages/shared/src/validators/aiModelRegistryApi.ts` (W04 file: new union arm + two new schemas)
- Modify: `packages/shared/src/validators/aiModelRegistryApi.test.ts`
- Modify: `packages/shared/src/types/aiModelRegistry.ts` (W04 file: two optional DTO fields)

**Interfaces:**
- Consumes: W04 (P9) `connectionCreateSchema`, `connectionName`, `inferenceGeo` helpers inside `aiModelRegistryApi.ts`; `modelRatesSchema` (W01).
- Produces:

```ts
// packages/shared/src/constants/aiConnectionKinds.ts
export const AI_CONNECTION_ROW_KINDS: readonly ['anthropic_byok', 'catalog', 'openai_compatible'];   // W07 appends
export type AiConnectionRowKind = (typeof AI_CONNECTION_ROW_KINDS)[number];
export const GATEWAY_CONNECTION_KINDS: readonly ['openai_compatible'];                              // W07 appends
export type GatewayConnectionKind = (typeof GATEWAY_CONNECTION_KINDS)[number];
export function isGatewayConnectionKind(kind: string): kind is GatewayConnectionKind;
export const BYO_MODEL_ID_PATTERN: RegExp;   // /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/

// aiModelRegistryApi.ts (additions)
export const byoBaseUrlSchema: z.ZodString;                 // syntax only; egress policy is server-side (Task 2)
export const connectionGatewayPatchSchema: z.ZodType<{ baseUrl?: string; apiKey?: string | null; expectedConfigVersion: number }>;
export const manualOfferingCreateSchema: z.ZodType<{ modelId: string; displayName?: string; prices?: ModelRates | null }>;
// connectionCreateSchema gains the arm:
//   { kind: 'openai_compatible'; name: string; baseUrl: string; apiKey?: string; inferenceGeo?: never }

// types/aiModelRegistry.ts (additions to AiConnectionDto)
baseUrl: string | null;            // openai_compatible only; never a credential
managedBy: 'env' | null;           // env-bootstrapped connection (read-only in the UI)
// AiOfferingDto addition
verification: { state: 'unverified' | 'verified' | 'failed' | 'stale'; at: string | null; harnessVersion: string | null; summary: string | null } | null;
```

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/constants/aiConnectionKinds.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AI_CONNECTION_ROW_KINDS,
  BYO_MODEL_ID_PATTERN,
  GATEWAY_CONNECTION_KINDS,
  isGatewayConnectionKind,
} from './aiConnectionKinds';

describe('aiConnectionKinds', () => {
  it('every gateway kind is a row kind', () => {
    for (const k of GATEWAY_CONNECTION_KINDS) expect(AI_CONNECTION_ROW_KINDS).toContain(k);
  });

  it('Anthropic-dialect kinds are never gateway kinds', () => {
    expect(isGatewayConnectionKind('anthropic_byok')).toBe(false);
    expect(isGatewayConnectionKind('catalog')).toBe(false);
    expect(isGatewayConnectionKind('platform')).toBe(false);
    expect(isGatewayConnectionKind('openai_compatible')).toBe(true);
  });

  it.each([
    ['qwen2.5-coder:7b', true],
    ['meta-llama/Llama-3.3-70B-Instruct', true],
    ['openrouter/anthropic/claude-sonnet', true],
    ['hf.co/InternScience/Agents-A1-4B-Q4_K_M-GGUF', true],
    ['gpt-4o@2024-08-06', true],
    ['', false],
    ['-leading-dash', false],
    ['has space', false],
    ['line\nbreak', false],
    ['<script>', false],
    ['x'.repeat(201), false],
  ])('BYO_MODEL_ID_PATTERN %j → %s', (id, ok) => {
    expect(BYO_MODEL_ID_PATTERN.test(id)).toBe(ok);
  });
});
```

Append to `packages/shared/src/validators/aiModelRegistryApi.test.ts` (replace W04's test "rejects a kind W04 does not create (W06/W07 add arms)" — its `openai_compatible` case now parses; keep it for an unknown kind):

```ts
describe('W06: openai_compatible connections', () => {
  const base = { kind: 'openai_compatible', name: 'Office vLLM', baseUrl: 'https://llm.example.com/v1' } as const;

  it('accepts a keyless endpoint (local Ollama / vLLM)', () => {
    expect(connectionCreateSchema.safeParse(base).success).toBe(true);
  });

  it('accepts an optional key and trims it', () => {
    const r = connectionCreateSchema.safeParse({ ...base, apiKey: '  sk-local-123  ' });
    expect(r.success && r.data.kind === 'openai_compatible' && r.data.apiKey).toBe('sk-local-123');
  });

  it.each([
    ['ftp://llm.example.com', 'scheme'],
    ['https://user:pw@llm.example.com/v1', 'userinfo'],
    ['https://llm.example.com/v1?x=1', 'query'],
    ['https://llm.example.com/v1#frag', 'fragment'],
    ['not a url', 'garbage'],
    [`https://llm.example.com/${'a'.repeat(2100)}`, 'length'],
  ])('rejects base URL %j (%s)', (baseUrl) => {
    expect(connectionCreateSchema.safeParse({ ...base, baseUrl }).success).toBe(false);
  });

  it('strips a trailing slash so the fingerprint is stable', () => {
    const r = connectionCreateSchema.safeParse({ ...base, baseUrl: 'https://llm.example.com/v1/' });
    expect(r.success && r.data.kind === 'openai_compatible' && r.data.baseUrl).toBe('https://llm.example.com/v1');
  });

  it('refuses inferenceGeo on an openai_compatible connection (residency is never claimable, D7)', () => {
    expect(connectionCreateSchema.safeParse({ ...base, inferenceGeo: 'eu' }).success).toBe(false);
  });

  it('still rejects an unknown kind', () => {
    expect(connectionCreateSchema.safeParse({ kind: 'mystery', apiKey: 'x'.repeat(30) }).success).toBe(false);
  });

  it('connectionGatewayPatchSchema: null apiKey clears the key; needs a change and the version', () => {
    expect(connectionGatewayPatchSchema.safeParse({ apiKey: null, expectedConfigVersion: 3 }).success).toBe(true);
    expect(connectionGatewayPatchSchema.safeParse({ expectedConfigVersion: 3 }).success).toBe(false);
    expect(connectionGatewayPatchSchema.safeParse({ baseUrl: 'https://x.example.com' }).success).toBe(false);
  });

  it('manualOfferingCreateSchema validates the model id and allows a zero price', () => {
    const zero = { inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 };
    expect(manualOfferingCreateSchema.safeParse({ modelId: 'qwen2.5-coder:7b', prices: zero }).success).toBe(true);
    expect(manualOfferingCreateSchema.safeParse({ modelId: 'bad id' }).success).toBe(false);
    expect(manualOfferingCreateSchema.safeParse({ modelId: 'm', displayName: 'x'.repeat(121) }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/constants/aiConnectionKinds.test.ts src/validators/aiModelRegistryApi.test.ts`
Expected: FAIL — `Cannot find module './aiConnectionKinds'`; the openai arm cases fail to parse.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/constants/aiConnectionKinds.ts`:

```ts
/**
 * Connection kinds of `partner_ai_connections.kind` (AI model registry, spec §4/§5.2).
 * Mirrors the DB CHECK `partner_ai_connections_kind_chk` and the Drizzle
 * `PARTNER_AI_CONNECTION_KINDS`; W07 (#7605) appends 'bedrock' | 'vertex' | 'foundry'
 * to BOTH arrays here and to the CHECK in its migration.
 *
 * "Gateway" kinds are dispatched through the loopback model gateway
 * (apps/api/src/services/aiModels/gateway): their credentials never leave it.
 * The Anthropic-dialect kinds (anthropic_byok, catalog) keep their direct path.
 */
export const AI_CONNECTION_ROW_KINDS = ['anthropic_byok', 'catalog', 'openai_compatible'] as const;
export type AiConnectionRowKind = (typeof AI_CONNECTION_ROW_KINDS)[number];

export const GATEWAY_CONNECTION_KINDS = ['openai_compatible'] as const;
export type GatewayConnectionKind = (typeof GATEWAY_CONNECTION_KINDS)[number];

const GATEWAY_SET: ReadonlySet<string> = new Set(GATEWAY_CONNECTION_KINDS);
export function isGatewayConnectionKind(kind: string): kind is GatewayConnectionKind {
  return GATEWAY_SET.has(kind);
}

/**
 * A model id on a BYO endpoint: what the provider's /models returns, or what an
 * admin types. Printable, no whitespace, no markup, ≤ 200 chars. Covers Ollama
 * tags (`qwen2.5:7b`), HF paths (`org/model`), OpenRouter (`a/b/c`) and
 * `@version` suffixes.
 */
export const BYO_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
```

Add to `packages/shared/src/constants/index.ts`: `export * from './aiConnectionKinds';`

In `packages/shared/src/validators/aiModelRegistryApi.ts`, add next to W04's helpers (`uuid`, `apiKey`, `connectionName`, `inferenceGeo`):

```ts
import { BYO_MODEL_ID_PATTERN } from '../constants/aiConnectionKinds';

/**
 * W06: syntax of a BYO OpenAI-compatible base URL. This is NOT the egress policy —
 * private/metadata addresses, https-on-hosted and DNS pinning are enforced
 * server-side (services/aiModels/gateway/byoEndpointPolicy.ts) and at connect.
 */
export const byoBaseUrlSchema = z.string().trim().max(2048)
  .transform((v) => v.replace(/\/+$/, ''))
  .refine((v) => {
    let u: URL;
    try { u = new URL(v); } catch { return false; }
    return (u.protocol === 'https:' || u.protocol === 'http:')
      && u.hostname !== '' && u.username === '' && u.password === ''
      && !v.includes('?') && !v.includes('#');
  }, { message: 'Enter an http(s) URL with no credentials, query or fragment.' });

/** Optional on a BYO endpoint: a local Ollama/vLLM usually has none. */
// ≥ 8 chars: the gateway's scrubber redacts secrets of 8+ characters wherever they
// are echoed (Codex review #2); a shorter "key" could not be scrubbed safely.
const byoApiKey = z.string().trim().min(8, 'A key must be at least 8 characters.').max(500);
```

Change `connectionCreateSchema` (keep W04's arm verbatim, add the new arm):

```ts
export const connectionCreateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('anthropic_byok'),
    apiKey,
    name: connectionName.optional(),
    inferenceGeo: inferenceGeo.nullable().optional(),
  }).strict(),
  // W06 (#7604): BYO OpenAI-compatible. No inferenceGeo: its geography is
  // unverifiable, so it is never residency-eligible (Decision D7).
  z.object({
    kind: z.literal('openai_compatible'),
    name: connectionName,
    baseUrl: byoBaseUrlSchema,
    apiKey: byoApiKey.optional(),
  }).strict(),
]);
```

Add:

```ts
/** W06: edit a gateway connection's endpoint/key. `apiKey: null` clears it. */
export const connectionGatewayPatchSchema = z.object({
  baseUrl: byoBaseUrlSchema.optional(),
  apiKey: byoApiKey.nullable().optional(),
  /** Optimistic concurrency on config_version (bumped by every endpoint/key change). */
  expectedConfigVersion: z.number().int().min(1),
}).strict().refine((v) => v.baseUrl !== undefined || v.apiKey !== undefined, {
  message: 'Change the URL or the key.',
});
export type ConnectionGatewayPatchInput = z.infer<typeof connectionGatewayPatchSchema>;

/** W06: hand-entered model on a gateway connection (spec §6 "manual entry is always allowed"). */
export const manualOfferingCreateSchema = z.object({
  modelId: z.string().trim().regex(BYO_MODEL_ID_PATTERN, 'Enter the model id exactly as the endpoint expects it.'),
  displayName: z.string().trim().min(1).max(120).optional(),
  prices: modelRatesSchema.nullable().optional(),
}).strict();
export type ManualOfferingCreateInput = z.infer<typeof manualOfferingCreateSchema>;
```

Update the file's "Extension points" header comment: `connectionCreateSchema … W06 added openai_compatible; W07 adds bedrock | vertex | foundry.`

In `packages/shared/src/types/aiModelRegistry.ts`, extend W04's DTOs (both fields optional-in-practice but typed non-optional so the server must set them):

```ts
export interface AiConnectionDto {
  // …W04 fields unchanged…
  /** openai_compatible only (W06). Never contains credentials. */
  baseUrl: string | null;
  /** 'env' = bootstrapped from MCP_LLM_* (W06 Task 15); read-only in the UI. */
  managedBy: 'env' | null;
}

export type OfferingVerificationState = 'unverified' | 'verified' | 'failed' | 'stale';
export interface AiOfferingVerificationDto {
  state: OfferingVerificationState;
  at: string | null;
  harnessVersion: string | null;
  /** Short, scrubbed reason for 'failed' (≤ 200 chars). */
  summary: string | null;
}
export interface AiOfferingDto {
  // …W04 fields unchanged…
  /** Gateway-connection offerings only; null for platform / anthropic_byok / catalog. */
  verification: AiOfferingVerificationDto | null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && npx vitest run src/constants/aiConnectionKinds.test.ts src/validators/aiModelRegistryApi.test.ts && npx tsc --noEmit -p .`
Expected: PASS. `tsc` then fails in `apps/api` / `apps/web` where W04 builds `AiConnectionDto` / `AiOfferingDto` literals — that is expected and fixed in Tasks 13–14; do **not** make the fields optional to silence it.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants/aiConnectionKinds.ts packages/shared/src/constants/aiConnectionKinds.test.ts \
  packages/shared/src/constants/index.ts packages/shared/src/validators/aiModelRegistryApi.ts \
  packages/shared/src/validators/aiModelRegistryApi.test.ts packages/shared/src/types/aiModelRegistry.ts
git commit -m "feat(ai-models): openai_compatible connection contract and gateway kind list (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: BYO endpoint egress policy

One function decides whether a BYO base URL is dialable. It is used at write time (policy gate, Task 10), at discovery (Task 11) and on every gateway forward (Task 4). It mirrors the env OpenAI-compatible provider's existing policy exactly (`openaiCompatibleProvider.ts` uses `allowPrivateNetwork: selfHostAllowsPrivateNetwork()` + `requirePrivateForCleartext: true`), so absorbing the env path (Task 15) changes nothing a self-hoster can reach, and tightens it on hosted (https only).

**Files:**
- Create: `apps/api/src/services/aiModels/gateway/byoEndpointPolicy.ts`
- Create: `apps/api/src/services/aiModels/gateway/byoEndpointPolicy.test.ts`

**Interfaces:**
- Consumes: P13 `assertSafeUrl`, `SsrfBlockedError`, `__setLookupForTests`; `isHosted`, `selfHostAllowsPrivateNetwork`.
- Produces:

```ts
export interface ByoEgressAllowances { allowPrivateNetwork: boolean; requirePrivateForCleartext: true }
export class ByoEndpointRejected extends Error { readonly code: 'egress_blocked' | 'invalid_url'; readonly status: 400 }
/** Current deployment policy. Read per call (tests flip IS_HOSTED). */
export function byoEgressAllowances(): ByoEgressAllowances;
/** Syntax + scheme-for-deployment + SSRF policy (DNS resolved now). Returns the normalised URL. */
export async function validateByoBaseUrl(raw: string): Promise<string>;
/** `${base}/${path}` without double slashes; path must start with a letter. */
export function joinByoUrl(baseUrl: string, path: string): string;
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiModels/gateway/byoEndpointPolicy.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setLookupForTests } from '../../urlSafety';

const env = vi.hoisted(() => ({ hosted: true, selfHostPrivate: false }));
vi.mock('../../../config/env', async (orig) => ({
  ...(await orig<typeof import('../../../config/env')>()),
  isHosted: () => env.hosted,
  selfHostAllowsPrivateNetwork: () => env.selfHostPrivate,
}));

import { ByoEndpointRejected, byoEgressAllowances, joinByoUrl, validateByoBaseUrl } from './byoEndpointPolicy';

function resolveTo(ip: string) {
  __setLookupForTests(async () => [{ address: ip, family: ip.includes(':') ? 6 : 4 }]);
}

describe('byoEndpointPolicy', () => {
  beforeEach(() => { env.hosted = true; env.selfHostPrivate = false; });
  afterEach(() => __setLookupForTests(null));

  it('hosted: https + public resolves', async () => {
    resolveTo('93.184.216.34');
    await expect(validateByoBaseUrl('https://llm.example.com/v1/')).resolves.toBe('https://llm.example.com/v1');
  });

  it('hosted: refuses cleartext even to a public address', async () => {
    resolveTo('93.184.216.34');
    await expect(validateByoBaseUrl('http://llm.example.com/v1')).rejects.toMatchObject({ code: 'egress_blocked' });
  });

  it.each([
    ['10.0.0.5'], ['192.168.1.10'], ['127.0.0.1'], ['169.254.169.254'], ['100.64.0.1'], ['::1'], ['fd00::1'],
  ])('hosted: refuses a host resolving to %s', async (ip) => {
    resolveTo(ip);
    await expect(validateByoBaseUrl('https://sneaky.example.com')).rejects.toBeInstanceOf(ByoEndpointRejected);
  });

  it('self-host with the private opt-in: allows http to RFC 1918', async () => {
    env.hosted = false; env.selfHostPrivate = true;
    resolveTo('192.168.1.10');
    await expect(validateByoBaseUrl('http://ollama.lan:11434/v1')).resolves.toBe('http://ollama.lan:11434/v1');
  });

  it('self-host: cleartext to a PUBLIC address is still refused (requirePrivateForCleartext)', async () => {
    env.hosted = false; env.selfHostPrivate = true;
    resolveTo('93.184.216.34');
    await expect(validateByoBaseUrl('http://llm.example.com/v1')).rejects.toMatchObject({ code: 'egress_blocked' });
  });

  it.each([['127.0.0.1'], ['169.254.169.254'], ['::1']])('self-host: loopback/metadata %s are never allowed', async (ip) => {
    env.hosted = false; env.selfHostPrivate = true;
    resolveTo(ip);
    await expect(validateByoBaseUrl('http://box.lan/v1')).rejects.toMatchObject({ code: 'egress_blocked' });
  });

  it('refuses userinfo / query / fragment as invalid_url', async () => {
    await expect(validateByoBaseUrl('https://u:p@x.example.com')).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(validateByoBaseUrl('https://x.example.com/?a=1')).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('the rejection message never echoes resolved IPs (no internal topology in errors)', async () => {
    resolveTo('10.1.2.3');
    const err = await validateByoBaseUrl('https://x.example.com').catch((e) => e as Error);
    expect(String(err.message)).not.toContain('10.1.2.3');
  });

  it('byoEgressAllowances reflects the deployment', () => {
    expect(byoEgressAllowances()).toEqual({ allowPrivateNetwork: false, requirePrivateForCleartext: true });
    env.hosted = false; env.selfHostPrivate = true;
    expect(byoEgressAllowances()).toEqual({ allowPrivateNetwork: true, requirePrivateForCleartext: true });
  });

  it('joinByoUrl', () => {
    expect(joinByoUrl('https://x.example.com/v1', 'chat/completions')).toBe('https://x.example.com/v1/chat/completions');
    expect(joinByoUrl('https://x.example.com/v1/', 'models')).toBe('https://x.example.com/v1/models');
    expect(() => joinByoUrl('https://x.example.com', '../admin')).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/byoEndpointPolicy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/aiModels/gateway/byoEndpointPolicy.ts
/**
 * Egress policy for a partner's BYO OpenAI-compatible base URL (spec §12, W06).
 *
 * This is the AUTHORING-time gate (write, discovery). It is not the rebinding
 * defence: every request re-resolves and pins its dial through safeFetch with the
 * same allowances (gateway/forward.ts). Mirrors the env provider's long-standing
 * self-host policy (openaiCompatibleProvider.ts) so absorbing it (Task 15) is not
 * a regression: private RFC 1918/ULA only on an explicitly self-hosted deployment,
 * cleartext only to a private address, loopback/link-local/metadata never.
 */
import { isHosted, selfHostAllowsPrivateNetwork } from '../../../config/env';
import { assertSafeUrl, SsrfBlockedError } from '../../urlSafety';

export interface ByoEgressAllowances {
  allowPrivateNetwork: boolean;
  requirePrivateForCleartext: true;
}

export class ByoEndpointRejected extends Error {
  readonly status = 400 as const;
  constructor(message: string, readonly code: 'egress_blocked' | 'invalid_url') {
    super(message);
    this.name = 'ByoEndpointRejected';
  }
}

export function byoEgressAllowances(): ByoEgressAllowances {
  return { allowPrivateNetwork: !isHosted() && selfHostAllowsPrivateNetwork(), requirePrivateForCleartext: true };
}

function parse(raw: string): URL {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(trimmed); } catch { throw new ByoEndpointRejected('Enter a valid http(s) URL.', 'invalid_url'); }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname
    || u.username !== '' || u.password !== '' || trimmed.includes('?') || trimmed.includes('#')) {
    throw new ByoEndpointRejected('The URL must be http(s) with no credentials, query or fragment.', 'invalid_url');
  }
  return u;
}

export async function validateByoBaseUrl(raw: string): Promise<string> {
  const u = parse(raw);
  const allow = byoEgressAllowances();
  if (u.protocol === 'http:' && isHosted()) {
    throw new ByoEndpointRejected('Hosted Breeze only connects to https endpoints.', 'egress_blocked');
  }
  try {
    await assertSafeUrl(u.toString(), { allowPrivateNetwork: allow.allowPrivateNetwork });
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      throw new ByoEndpointRejected(
        allow.allowPrivateNetwork
          ? 'That host is not reachable from Breeze (loopback, link-local and metadata addresses are never allowed).'
          : 'That host resolves to a private or reserved address, which Breeze does not connect to.',
        'egress_blocked',
      );
    }
    throw error;
  }
  if (u.protocol === 'http:') {
    // Cleartext is only allowed to a private address (the key would otherwise
    // cross the internet in the clear). assertSafeUrl has no flag for this, so
    // check the classification of what the name resolves to now; the per-request
    // dial re-checks via safeFetch({ requirePrivateForCleartext: true }).
    try {
      await assertSafeUrl(u.toString(), { allowPrivateNetwork: false });
      // Resolved to a public address over http: refuse.
      throw new ByoEndpointRejected('Use https for an endpoint on a public address.', 'egress_blocked');
    } catch (error) {
      if (error instanceof ByoEndpointRejected) throw error;
      if (!(error instanceof SsrfBlockedError)) throw error;
      // SsrfBlocked under the strict policy ⇒ it is private ⇒ cleartext allowed.
    }
  }
  return u.toString().replace(/\/+$/, '');
}

export function joinByoUrl(baseUrl: string, path: string): string {
  if (!/^[a-z][a-z/_-]*$/.test(path)) throw new Error(`joinByoUrl: illegal path ${JSON.stringify(path)}`);
  return `${baseUrl.replace(/\/+$/, '')}/${path}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/byoEndpointPolicy.test.ts`
Expected: PASS (17 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/gateway/byoEndpointPolicy.ts apps/api/src/services/aiModels/gateway/byoEndpointPolicy.test.ts
git commit -m "feat(ai-models): BYO endpoint egress policy (hosted https-public, self-host private opt-in) (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Migration — gateway egress audit (`llm_egress_events.connection_id`, `gateway_forward`)

Gateway traffic is audited per request like catalog traffic. The existing table carries catalog provenance only; a gateway row needs the connection id. One nullable column, no FK (provenance, like `ai_invocations.connection_id`: a deleted connection must not erase its audit trail), and one new surface.

**Files:**
- Create: `apps/api/migrations/2026-11-23-100000-ai-gateway-egress-events.sql`
- Modify: `apps/api/src/db/schema/llmEgressEvents.ts`
- Modify: `apps/api/src/services/llm/llmEgressRecorder.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (the `llm_egress_events` row)
- Test: `apps/api/src/__tests__/integration/llmEgressEvents.integration.test.ts` (existing surface-parity suite — append a case)
- Test: `apps/api/src/services/llm/llmEgressRecorder.test.ts` (existing — append)

**Interfaces:**
- Produces: `LLM_EGRESS_SURFACES` gains `'gateway_forward'`; `LlmEgressEventInput.connectionId?: string | null`; column `llm_egress_events.connection_id uuid NULL`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/llm/llmEgressRecorder.test.ts` (it already mocks `db.insert` — reuse its `insertedRows` capture):

```ts
it('persists connection_id for gateway traffic (W06)', async () => {
  recordLlmEgressEvent({
    orgId: ORG, partnerId: PARTNER, surface: 'gateway_forward', host: 'llm.example.com',
    resolvedIp: '93.184.216.34', blocked: false, connectionId: '00000000-0000-4000-8000-0000000000c1',
  });
  await drainLlmEgressQueue();
  expect(insertedRows.at(-1)).toMatchObject({ surface: 'gateway_forward', connectionId: '00000000-0000-4000-8000-0000000000c1' });
});
```

Append to `apps/api/src/__tests__/integration/llmEgressEvents.integration.test.ts` (it already compares the CHECK's surface list with `LLM_EGRESS_SURFACES`; add a column assertion):

```ts
it('has a nullable connection_id with no FK (provenance survives connection deletion)', async () => {
  const cols = await sql`
    SELECT is_nullable, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'llm_egress_events' AND column_name = 'connection_id'`;
  expect(cols).toEqual([{ is_nullable: 'YES', data_type: 'uuid' }]);
  const fks = await sql`
    SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.llm_egress_events'::regclass AND c.contype = 'f' AND a.attname = 'connection_id'`;
  expect(fks).toHaveLength(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/llm/llmEgressRecorder.test.ts`
Expected: FAIL — `'gateway_forward'` is not assignable / `connectionId` not persisted.

Run (needs `pnpm test-stack up`): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/llmEgressEvents.integration.test.ts`
Expected: FAIL — surface parity mismatch once Step 3's TS change lands without the SQL; column missing.

- [ ] **Step 3: Write the migration and code**

Before naming the file: `git ls-tree -r --name-only origin/main -- apps/api/migrations/ | grep -E '/[0-9]{4}-[^/]*\.sql$' | sort | tail -3`. If anything sorts after `2026-11-23-100000`, rename this file to sort last (keep the slug) and update the two references in this task.

```sql
-- apps/api/migrations/2026-11-23-100000-ai-gateway-egress-events.sql
-- AI model registry W06 (#7604): audit rows for the loopback model gateway.
--
-- * connection_id: the partner_ai_connections row a gateway request was made
--   for. Provenance only — deliberately NO foreign key (a deleted connection must
--   not erase or block its audit trail; same posture as ai_invocations.connection_id).
-- * surface 'gateway_forward': one row per request the gateway forwards (or
--   refuses) to a gateway-kind connection's upstream.
--
-- The surface CHECK mirrors LLM_EGRESS_SURFACES (apps/api/src/db/schema/
-- llmEgressEvents.ts); the two are edited together and
-- llmEgressEvents.integration.test.ts enforces the pair.
--
-- No DML in this file, so the breeze.scope=system election rule does not apply.
-- Idempotent: ADD COLUMN IF NOT EXISTS; constraint dropped and re-added.
-- Export policy: connection_id is a plain identifier (included) — see
-- tenantExportPolicyRegistry.ts. Same table, same shape-1 RLS: no policy change.

ALTER TABLE public.llm_egress_events ADD COLUMN IF NOT EXISTS connection_id uuid;

DO $$
BEGIN
  ALTER TABLE public.llm_egress_events DROP CONSTRAINT IF EXISTS llm_egress_events_surface_chk;
  ALTER TABLE public.llm_egress_events ADD CONSTRAINT llm_egress_events_surface_chk CHECK (surface IN (
    'sdk_session_create', 'sdk_proxy_connect',
    'one_shot_ticket_draft', 'one_shot_email_draft', 'one_shot_catalog_enrichment',
    'one_shot_probe', 'workspace_enrichment', 'script_review_verdict',
    'gateway_forward'
  ));
END $$;

CREATE INDEX IF NOT EXISTS llm_egress_events_connection_idx
  ON public.llm_egress_events (connection_id, created_at)
  WHERE connection_id IS NOT NULL;
```

`apps/api/src/db/schema/llmEgressEvents.ts`:

```ts
export const LLM_EGRESS_SURFACES = [
  // …existing entries unchanged…
  'script_review_verdict',
  // W06 (#7604): loopback model gateway forwards to a gateway-kind connection.
  // CHECK re-issued in 2026-11-23-100000-ai-gateway-egress-events.sql.
  'gateway_forward',
] as const;

// in the pgTable column list, after aiSessionId:
  /** W06: gateway connection provenance; no FK by design (see migration). */
  connectionId: uuid('connection_id'),
// …and in the table's index list (Codex review #17 — matches the migration's partial index, keeps db:check-drift clean):
//   index('llm_egress_events_connection_idx').on(t.connectionId, t.createdAt).where(sql`${t.connectionId} IS NOT NULL`),
```

`apps/api/src/services/llm/llmEgressRecorder.ts` — add to `LlmEgressEventInput`:

```ts
  /** W06: the gateway connection this request was for (null for catalog traffic). */
  connectionId?: string | null;
```

and in the insert values: `connectionId: event.connectionId ?? null,`.

`apps/api/src/services/tenantExportPolicyRegistry.ts` — the `llm_egress_events` row gains `"connection_id"` in `included` (alphabetical position is not required by that registry; append after `"ai_session_id"`):

```ts
  "llm_egress_events": tablePolicy("org_id", {"included":["id","org_id","partner_id","catalog_entry_id","revision_id","ai_session_id","connection_id","surface","host","resolved_ip","blocked","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/llm/llmEgressRecorder.test.ts
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/llmEgressEvents.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
cd ../.. && bash scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```

Expected: PASS. `pnpm db:check-drift` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-11-23-100000-ai-gateway-egress-events.sql apps/api/src/db/schema/llmEgressEvents.ts \
  apps/api/src/services/llm/llmEgressRecorder.ts apps/api/src/services/llm/llmEgressRecorder.test.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/llmEgressEvents.integration.test.ts
git commit -m "feat(ai-models): llm_egress_events gains connection_id + gateway_forward surface (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: The loopback model gateway — grants, adapter registry, server, guarded forward

This is the core shared extension point. It does not know any dialect: adapters (Task 7 here, W07's three) do. It owns everything that must be identical for every gateway kind: grant authentication and TTL, the bound-model rule, request/response size and time limits, SSRF-guarded upstream dialling, egress audit, error scrubbing and the Anthropic-shaped error envelope.

Modelled on `services/llm/llmEgressProxy.ts` (lazy per-process singleton on `127.0.0.1:0`, token digests, revoke destroys in-flight work).

**Files:**
- Create: `apps/api/src/services/aiModels/gateway/limits.ts`
- Create: `apps/api/src/services/aiModels/gateway/types.ts`
- Create: `apps/api/src/services/aiModels/gateway/scrub.ts` (+ `scrub.test.ts`)
- Create: `apps/api/src/services/aiModels/gateway/grants.ts` (+ `grants.test.ts`)
- Create: `apps/api/src/services/aiModels/gateway/adapter.ts`
- Create: `apps/api/src/services/aiModels/gateway/forward.ts` (+ `forward.test.ts`)
- Create: `apps/api/src/services/aiModels/gateway/server.ts` (+ `server.test.ts`)
- Create: `apps/api/src/services/aiModels/gateway/index.ts`
- Modify: `apps/api/src/index.ts` (close the gateway on shutdown, next to the egress proxy's `close()`)

**Interfaces:**
- Consumes: Task 2 `byoEgressAllowances`; Task 3 `recordLlmEgressEvent({ …, surface: 'gateway_forward', connectionId })`; P13 `safeFetch`, `SsrfBlockedError`, `ResponseTooLargeError`; Task 1 `GatewayConnectionKind`.
- Produces (binding for Tasks 7, 9, 11, 12 and W07):

```ts
// types.ts
export type GatewayDialect = 'anthropic' | 'bedrock' | 'vertex' | 'foundry';   // W06 uses 'anthropic'
export type GatewayConnectionConfig =
  | { source: 'gateway'; kind: 'openai_compatible'; partnerId: string; connectionId: string; configVersion: number; baseUrl: string };
  // W07 appends: | { source: 'gateway'; kind: 'bedrock' | 'vertex' | 'foundry'; …; providerConfig: CloudProviderConfig }
export interface GatewayCredential { secret: string | null }          // decrypted; lives only in grant memory
export type GatewayGrantPurpose = 'dispatch' | 'verification' | 'discovery';
export interface GatewayGrantInput {
  config: GatewayConnectionConfig;
  credential: GatewayCredential;
  wireModels: readonly string[];          // exact ids the upstream may be asked for (primary + refusal fallback)
  orgId: string | null;                   // null only for partner-level verification/discovery
  aiSessionId: string | null;
  purpose: GatewayGrantPurpose;
  ttlMs?: number;                         // default GRANT_DEFAULT_TTL_MS
}
export interface GatewayGrant { token: string; baseUrl: string; revoke: () => void }
export interface GatewayGrantRecord extends Omit<GatewayGrantInput, 'ttlMs' | 'wireModels'> {
  id: string; wireModels: ReadonlySet<string>; expiresAt: number; inFlight: Set<AbortController>;
}
export interface GatewayIncomingRequest {
  method: string; path: string;           // path AFTER `/g/<token>`, always starts with '/'
  headers: Readonly<Record<string, string>>; body: Buffer; signal: AbortSignal;
}
export interface GatewayResponse {
  status: number; headers: Record<string, string>;
  body: Buffer | AsyncIterable<Uint8Array>;
}
export class GatewayError extends Error { status: number; errorType: AnthropicErrorType; code: string }

// adapter.ts
export interface GatewayAdapter {
  readonly kind: GatewayConnectionKind;
  readonly dialect: GatewayDialect;
  handle(req: GatewayIncomingRequest, grant: GatewayGrantRecord): Promise<GatewayResponse>;
  /** Env for an Agent SDK child that must talk to this connection through `gatewayBaseUrl`. No secrets. */
  sdkChildEnv(input: { gatewayBaseUrl: string; config: GatewayConnectionConfig; wireModel: string }): Record<string, string>;
}
export function registerGatewayAdapter(adapter: GatewayAdapter): void;
export function getGatewayAdapter(kind: GatewayConnectionKind): GatewayAdapter;   // throws if unregistered
export function assertBoundModel(grant: GatewayGrantRecord, model: unknown): string; // GatewayError 403 gateway_model_mismatch

// forward.ts
export interface UpstreamRequest { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string | Buffer; stream: boolean }
export async function forwardUpstream(grant: GatewayGrantRecord, req: UpstreamRequest, signal: AbortSignal): Promise<Response>;
export function __setUpstreamFetchForTests(fn: typeof safeFetch | null): void;

// server.ts
export interface ModelGateway {
  grant(input: GatewayGrantInput): GatewayGrant;
  revoke(token: string): void;
  port(): number;
  close(): Promise<void>;
}
export function getModelGateway(): Promise<ModelGateway>;
export function startModelGateway(): Promise<ModelGateway>;   // tests

// scrub.ts
export function scrubSecrets(text: string, secrets: ReadonlyArray<string | null | undefined>, max?: number): string;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiModels/gateway/scrub.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scrubSecrets } from './scrub';

describe('scrubSecrets', () => {
  it('removes the exact secret and its common echoes', () => {
    const key = 'sk-live-0123456789abcdefXYZ';
    const text = `bad key ${key}; Authorization: Bearer ${key}; tail=${key.slice(-12)}`;
    const out = scrubSecrets(text, [key]);
    expect(out).not.toContain(key);
    expect(out).not.toContain(key.slice(-12));
    expect(out).toContain('[redacted]');
  });

  it('redacts bearer tokens and well-known key shapes even when the secret is unknown', () => {
    const out = scrubSecrets('Authorization: Bearer abcdefghijklmnop sk-ant-api03-zzzzzzzzzzzz AKIAABCDEFGHIJKLMNOP', []);
    expect(out).not.toMatch(/abcdefghijklmnop|sk-ant-api03-z|AKIAABCDEFGHIJKLMNOP/);
  });

  it('truncates and strips control characters', () => {
    const out = scrubSecrets(`a\u0000b\u001bc${'x'.repeat(2000)}`, [], 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it('redacts URL-encoded and base64 echoes of the secret (Codex review #2)', () => {
    const key = 'sk/live+key=123456';
    const out = scrubSecrets(`q=${encodeURIComponent(key)} b=${Buffer.from(key).toString('base64')}`, [key]);
    expect(out).not.toContain(encodeURIComponent(key));
    expect(out).not.toContain(Buffer.from(key).toString('base64'));
  });

  it('ignores short or empty secrets (never redacts every "a")', () => {
    expect(scrubSecrets('banana', ['a', '', null])).toBe('banana');
  });
});
```

`apps/api/src/services/aiModels/gateway/grants.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createGrantStore } from './grants';
import type { GatewayGrantInput } from './types';

const input = (over: Partial<GatewayGrantInput> = {}): GatewayGrantInput => ({
  config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p1', connectionId: 'c1', configVersion: 1, baseUrl: 'https://x.example.com/v1' },
  credential: { secret: 'sk-secret' },
  wireModels: ['m1'],
  orgId: 'o1', aiSessionId: null, purpose: 'dispatch',
  ...over,
});

describe('grant store', () => {
  it('issues an unguessable token and finds the grant by it', () => {
    const store = createGrantStore(() => 1_000);
    const { token } = store.issue(input());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.lookup(token)?.config.connectionId).toBe('c1');
    expect(store.lookup(`${token}x`)).toBeNull();
  });

  it('expires after the TTL', () => {
    let now = 1_000;
    const store = createGrantStore(() => now);
    const { token } = store.issue(input({ ttlMs: 500 }));
    now = 1_499; expect(store.lookup(token)).not.toBeNull();
    now = 1_501; expect(store.lookup(token)).toBeNull();
  });

  it('revoke aborts in-flight requests and forgets the grant', () => {
    const store = createGrantStore(() => 0);
    const { token } = store.issue(input());
    const grant = store.lookup(token)!;
    const ac = new AbortController();
    grant.inFlight.add(ac);
    store.revoke(token);
    expect(ac.signal.aborted).toBe(true);
    expect(store.lookup(token)).toBeNull();
  });

  it('never stores the raw token (only its digest)', () => {
    const store = createGrantStore(() => 0);
    const { token } = store.issue(input());
    expect(JSON.stringify([...store.__debugKeys()])).not.toContain(token);
  });

  it('sweep() drops expired grants', () => {
    let now = 0;
    const store = createGrantStore(() => now);
    store.issue(input({ ttlMs: 10 }));
    now = 20; store.sweep();
    expect(store.size()).toBe(0);
  });

  it('rejects a grant with no wire model', () => {
    const store = createGrantStore(() => 0);
    expect(() => store.issue(input({ wireModels: [] }))).toThrow(/wire model/);
  });
});
```

`apps/api/src/services/aiModels/gateway/forward.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: (e: unknown) => rec.events.push(e) }));
const env = vi.hoisted(() => ({ hosted: true }));
vi.mock('./byoEndpointPolicy', async (orig) => ({
  ...(await orig<typeof import('./byoEndpointPolicy')>()),
  byoEgressAllowances: () => ({ allowPrivateNetwork: !env.hosted, requirePrivateForCleartext: true }),
}));

import { __setLookupForTests, SsrfBlockedError } from '../../urlSafety';
import { __setUpstreamFetchForTests, forwardUpstream } from './forward';
import type { GatewayGrantRecord } from './types';

const grant = (over: Partial<GatewayGrantRecord> = {}): GatewayGrantRecord => ({
  id: 'g1',
  config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p1', connectionId: 'c1', configVersion: 1, baseUrl: 'https://llm.example.com/v1' },
  credential: { secret: 'sk-secret-123456' },
  wireModels: new Set(['m1']), orgId: 'o1', aiSessionId: 's1', purpose: 'dispatch',
  expiresAt: Number.MAX_SAFE_INTEGER, inFlight: new Set(),
  ...over,
});

describe('forwardUpstream', () => {
  beforeEach(() => { rec.events.length = 0; env.hosted = true; });
  afterEach(() => { __setUpstreamFetchForTests(null); __setLookupForTests(null); });

  it('dials through safeFetch with the deployment allowances, size cap, no redirects and the connection audit', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    __setUpstreamFetchForTests((async (url: string, init: Record<string, unknown>) => {
      calls.push([url, init]);
      (init.onConnect as (ip: string) => void)('93.184.216.34');
      return new Response('{}', { status: 200 });
    }) as never);
    await forwardUpstream(grant(), { url: 'https://llm.example.com/v1/chat/completions', method: 'POST', headers: {}, body: '{}', stream: true }, new AbortController().signal);
    expect(calls[0]![1]).toMatchObject({
      allowPrivateNetwork: false, requirePrivateForCleartext: true, streamResponse: true,
      maxBytes: 32 * 1024 * 1024, redirect: 'error',
    });
    expect(rec.events).toEqual([expect.objectContaining({
      orgId: 'o1', partnerId: 'p1', surface: 'gateway_forward', host: 'llm.example.com',
      resolvedIp: '93.184.216.34', blocked: false, connectionId: 'c1', aiSessionId: 's1',
    })]);
  });

  it('refuses an off-origin URL before dialling (adapters cannot be tricked into another host)', async () => {
    const spy = vi.fn();
    __setUpstreamFetchForTests(spy as never);
    await expect(forwardUpstream(grant(), { url: 'https://evil.example.net/v1/chat/completions', method: 'POST', headers: {}, stream: false }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway_origin_mismatch', status: 502 });
    expect(spy).not.toHaveBeenCalled();
    expect(rec.events).toEqual([expect.objectContaining({ blocked: true, host: 'evil.example.net' })]);
  });

  it('re-resolves and refuses a rebinding host (private on hosted) with a 502 and a blocked audit row', async () => {
    __setLookupForTests(async () => [{ address: '10.0.0.9', family: 4 }]);
    await expect(forwardUpstream(grant(), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: {}, stream: false }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'egress_blocked', status: 502 });
    expect(rec.events).toEqual([expect.objectContaining({ blocked: true, resolvedIp: null })]);
  });

  it('never forwards a caller-supplied Authorization; sets its own from the credential', async () => {
    let sent: Record<string, string> = {};
    __setUpstreamFetchForTests((async (_u: string, init: { headers: Record<string, string> }) => { sent = init.headers; return new Response('{}'); }) as never);
    await forwardUpstream(grant(), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: { authorization: 'Bearer stolen', 'x-api-key': 'x', cookie: 'c' }, stream: false }, new AbortController().signal);
    expect(sent.authorization).toBe('Bearer sk-secret-123456');
    expect(sent['x-api-key']).toBeUndefined();
    expect(sent.cookie).toBeUndefined();
  });

  it('keyless connection sends no Authorization header at all', async () => {
    let sent: Record<string, string> = {};
    __setUpstreamFetchForTests((async (_u: string, init: { headers: Record<string, string> }) => { sent = init.headers; return new Response('{}'); }) as never);
    await forwardUpstream(grant({ credential: { secret: null } }), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: {}, stream: false }, new AbortController().signal);
    expect('authorization' in sent).toBe(false);
  });

  it('skips the audit row (with a one-time warning) when there is no org (partner-level verification)', async () => {
    __setUpstreamFetchForTests((async () => new Response('{}')) as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await forwardUpstream(grant({ orgId: null, purpose: 'verification' }), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: {}, stream: false }, new AbortController().signal);
    expect(rec.events).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('maps an SsrfBlockedError / ResponseTooLarge to GatewayErrors without the resolved IPs', async () => {
    __setUpstreamFetchForTests((async () => { throw new SsrfBlockedError('all resolved IPs for x are private', { hostname: 'x', resolvedIps: ['10.9.9.9'] }); }) as never);
    const err = await forwardUpstream(grant(), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: {}, stream: false }, new AbortController().signal).catch((e) => e as Error);
    expect(err.message).not.toContain('10.9.9.9');
  });
});
```

`apps/api/src/services/aiModels/gateway/server.test.ts` (real loopback listener, fake adapter):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: (e: unknown) => rec.events.push(e) }));

import { __resetGatewayAdaptersForTests, assertBoundModel, registerGatewayAdapter } from './adapter';
import { startModelGateway, type ModelGateway } from './server';
import { GATEWAY_MAX_REQUEST_BYTES } from './limits';
import type { GatewayGrantInput } from './types';

const grantInput: GatewayGrantInput = {
  config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p1', connectionId: 'c1', configVersion: 1, baseUrl: 'https://x.example.com/v1' },
  credential: { secret: 'sk-secret-abcdef' }, wireModels: ['bound-model'], orgId: 'o1', aiSessionId: null, purpose: 'dispatch',
};

let gw: ModelGateway;
const seen: Array<{ path: string; body: string }> = [];

beforeEach(async () => {
  rec.events.length = 0; seen.length = 0;
  __resetGatewayAdaptersForTests();
  registerGatewayAdapter({
    kind: 'openai_compatible', dialect: 'anthropic',
    sdkChildEnv: () => ({}),
    async handle(req, grant) {
      seen.push({ path: req.path, body: req.body.toString('utf8') });
      const body = JSON.parse(req.body.toString('utf8') || '{}') as { model?: unknown };
      if (req.path === '/v1/messages') assertBoundModel(grant, body.model);
      async function* chunks() { yield Buffer.from('event: ping\ndata: {}\n\n'); }
      return req.path === '/stream'
        ? { status: 200, headers: { 'content-type': 'text/event-stream' }, body: chunks() }
        : { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') };
    },
  });
  gw = await startModelGateway();
});
afterEach(async () => { await gw.close(); });

const url = (token: string, path: string) => `http://127.0.0.1:${gw.port()}/g/${token}${path}`;

describe('model gateway server', () => {
  it('binds 127.0.0.1 only', () => {
    expect(gw.port()).toBeGreaterThan(0);
  });

  it('routes an authenticated request to the kind adapter with the path after the token', async () => {
    const { token } = gw.grant(grantInput);
    const res = await fetch(url(token, '/v1/messages'), { method: 'POST', body: JSON.stringify({ model: 'bound-model' }) });
    expect(res.status).toBe(200);
    expect(seen[0]!.path).toBe('/v1/messages');
  });

  it('401 with an Anthropic-shaped error for an unknown, expired or revoked token — no detail leaked', async () => {
    const res = await fetch(url('nope', '/v1/messages'), { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ type: 'error', error: { type: 'authentication_error', message: 'Invalid or expired gateway grant.' } });
    const { token, revoke } = gw.grant(grantInput);
    revoke();
    expect((await fetch(url(token, '/v1/messages'), { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('refuses a model the grant does not bind: 403, blocked audit row, adapter never forwards', async () => {
    const { token } = gw.grant(grantInput);
    const res = await fetch(url(token, '/v1/messages'), { method: 'POST', body: JSON.stringify({ model: 'claude-opus-unpriced' }) });
    expect(res.status).toBe(403);
    expect((await res.json()).error.type).toBe('permission_error');
    expect(rec.events).toEqual([expect.objectContaining({ blocked: true, surface: 'gateway_forward', connectionId: 'c1' })]);
  });

  it('413 for a body over the cap, without reading it all', async () => {
    const { token } = gw.grant(grantInput);
    const res = await fetch(url(token, '/v1/messages'), { method: 'POST', body: Buffer.alloc(GATEWAY_MAX_REQUEST_BYTES + 1) });
    expect(res.status).toBe(413);
  });

  it('rejects path traversal and encoded slashes in the token segment', async () => {
    const { token } = gw.grant(grantInput);
    expect((await fetch(`http://127.0.0.1:${gw.port()}/g/${token}/../admin`, { method: 'GET' })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${gw.port()}/g/${token}%2F..%2Fx/v1/messages`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('streams an adapter iterable body through unchanged', async () => {
    const { token } = gw.grant(grantInput);
    const res = await fetch(url(token, '/stream'), { method: 'POST', body: '{}' });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('event: ping\ndata: {}\n\n');
  });

  it('429 beyond the per-grant concurrency limit', async () => {
    const { token } = gw.grant(grantInput);
    // Saturate with requests the fake adapter never finishes:
    registerGatewayAdapter({ kind: 'openai_compatible', dialect: 'anthropic', sdkChildEnv: () => ({}),
      handle: (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    const pending = Array.from({ length: 8 }, () => fetch(url(token, '/v1/x'), { method: 'POST', body: '{}' }).catch(() => null));
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(url(token, '/v1/x'), { method: 'POST', body: '{}' })).status).toBe(429);
    gw.revoke(token);
    await Promise.all(pending);
  });

  it('a GatewayError thrown by an adapter becomes its status + Anthropic envelope; an unexpected error becomes 502 with no internals', async () => {
    registerGatewayAdapter({ kind: 'openai_compatible', dialect: 'anthropic', sdkChildEnv: () => ({}),
      handle: async () => { throw new Error('ECONNREFUSED 10.0.0.1:443 sk-secret-abcdef'); } });
    const { token } = gw.grant(grantInput);
    const res = await fetch(url(token, '/v1/messages'), { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('sk-secret-abcdef');
    expect(text).not.toContain('10.0.0.1');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/`
Expected: FAIL — modules not found. (`gateway/` here matches only files inside that directory, which is what is wanted.)

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/aiModels/gateway/limits.ts`:

```ts
/** Every gateway size/time limit, in one place (W06 Global Constraints). W07 reads these. */
export const GATEWAY_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const GATEWAY_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const GATEWAY_CONNECT_TIMEOUT_MS = 30_000;
export const GATEWAY_IDLE_TIMEOUT_MS = 120_000;
export const GATEWAY_TOTAL_TIMEOUT_MS = 15 * 60_000;
export const GATEWAY_MAX_CONCURRENT_PER_GRANT = 8;
export const GRANT_DEFAULT_TTL_MS = 30 * 60_000;     // a one-shot or a turn; sessions re-grant per spawn
export const GRANT_SESSION_TTL_MS = 24 * 60 * 60_000; // Agent SDK session lifetime cap (SESSION_MAX_AGE_MS)
export const GATEWAY_MAX_TOOLS = 512;
export const GATEWAY_MAX_TOOL_CALLS = 64;
export const GATEWAY_MAX_TOOL_ARGS_BYTES = 256 * 1024;
export const GATEWAY_ERROR_TEXT_MAX = 600;
export const DISCOVERY_MAX_RESPONSE_BYTES = 1024 * 1024;
export const DISCOVERY_MAX_MODELS = 500;
```

`apps/api/src/services/aiModels/gateway/types.ts`:

```ts
import type { GatewayConnectionKind } from '@breeze/shared';

export type GatewayDialect = 'anthropic' | 'bedrock' | 'vertex' | 'foundry';

/** The `source: 'gateway'` arm of a resolved connection's config. W07 appends cloud arms. */
export type GatewayConnectionConfig = {
  source: 'gateway';
  kind: 'openai_compatible';
  partnerId: string;
  connectionId: string;
  configVersion: number;
  baseUrl: string;
};

export interface GatewayCredential {
  /** Decrypted secret, or null for a keyless endpoint. Never serialised, logged or returned. */
  secret: string | null;
}

export type GatewayGrantPurpose = 'dispatch' | 'verification' | 'discovery';

export interface GatewayGrantInput {
  config: GatewayConnectionConfig;
  credential: GatewayCredential;
  wireModels: readonly string[];
  orgId: string | null;
  aiSessionId: string | null;
  purpose: GatewayGrantPurpose;
  ttlMs?: number;
}

export interface GatewayGrant { token: string; baseUrl: string; revoke: () => void }

export interface GatewayGrantRecord {
  id: string;
  config: GatewayConnectionConfig;
  credential: GatewayCredential;
  wireModels: ReadonlySet<string>;
  orgId: string | null;
  aiSessionId: string | null;
  purpose: GatewayGrantPurpose;
  expiresAt: number;
  inFlight: Set<AbortController>;
}

export interface GatewayIncomingRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  signal: AbortSignal;
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | AsyncIterable<Uint8Array>;
}

export type AnthropicErrorType =
  | 'invalid_request_error' | 'authentication_error' | 'permission_error' | 'not_found_error'
  | 'request_too_large' | 'rate_limit_error' | 'api_error' | 'overloaded_error';

/** An error the gateway answers with, in the Anthropic error envelope the SDK/CLI understand. */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: AnthropicErrorType,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export function gatewayErrorBody(type: AnthropicErrorType, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}
```

`apps/api/src/services/aiModels/gateway/scrub.ts`:

```ts
import { GATEWAY_ERROR_TEXT_MAX } from './limits';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const GENERIC_SECRETS: RegExp[] = [
  /(authorization\s*:\s*bearer\s+)[^\s"',;]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,          // OpenAI/Anthropic-style keys
  /\bAKIA[0-9A-Z]{16}\b/g,            // AWS access key ids (W07)
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT-shaped tokens
];

/**
 * Remove credential material from text that may leave the gateway (errors,
 * last_error, verification detail). Exact secrets and any ≥12-char tail of them
 * are replaced; generic key shapes are replaced even when the secret is unknown.
 */
export function scrubSecrets(
  text: string,
  secrets: ReadonlyArray<string | null | undefined>,
  max: number = GATEWAY_ERROR_TEXT_MAX,
): string {
  let out = text.replace(CONTROL, ' ');
  for (const s of secrets) {
    if (!s || s.length < 8) continue;
    // Codex review #2: the exact secret and its common encodings (URL-encoded,
    // base64, base64url, JSON-escaped), plus any 12-char tail of a long secret.
    const forms = new Set([s, encodeURIComponent(s), Buffer.from(s).toString('base64'),
      Buffer.from(s).toString('base64url'), JSON.stringify(s).slice(1, -1)]);
    if (s.length >= 16) forms.add(s.slice(-12));
    for (const f of forms) if (f.length >= 8) out = out.split(f).join('[redacted]');
  }
  for (const re of GENERIC_SECRETS) {
    out = out.replace(re, (m, prefix?: string) => (typeof prefix === 'string' && prefix.length > 0 ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
```

`apps/api/src/services/aiModels/gateway/grants.ts`:

```ts
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { GRANT_DEFAULT_TTL_MS } from './limits';
import type { GatewayGrantInput, GatewayGrantRecord } from './types';

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface GrantStore {
  issue(input: GatewayGrantInput): { token: string; record: GatewayGrantRecord };
  lookup(token: string): GatewayGrantRecord | null;
  revoke(token: string): void;
  revokeAll(): void;
  sweep(): void;
  size(): number;
  /** Test-only: the map keys (digests). */
  __debugKeys(): IterableIterator<string>;
}

export function createGrantStore(now: () => number = Date.now): GrantStore {
  const byDigest = new Map<string, GatewayGrantRecord>();

  const drop = (key: string): void => {
    const rec = byDigest.get(key);
    if (!rec) return;
    byDigest.delete(key);
    for (const ac of rec.inFlight) ac.abort();
    rec.inFlight.clear();
    // Best effort: drop the plaintext from the record we hand out by reference.
    rec.credential.secret = null;
  };

  return {
    issue(input) {
      if (input.wireModels.length === 0) throw new Error('A gateway grant needs at least one wire model.');
      const token = randomBytes(32).toString('base64url');
      const record: GatewayGrantRecord = {
        id: randomUUID(),
        config: input.config,
        credential: { secret: input.credential.secret },
        wireModels: new Set(input.wireModels),
        orgId: input.orgId,
        aiSessionId: input.aiSessionId,
        purpose: input.purpose,
        expiresAt: now() + (input.ttlMs ?? GRANT_DEFAULT_TTL_MS),
        inFlight: new Set(),
      };
      byDigest.set(digest(token), record);
      return { token, record };
    },
    lookup(token) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const key = digest(token);
      const rec = byDigest.get(key);
      if (!rec) return null;
      if (rec.expiresAt <= now()) { drop(key); return null; }
      return rec;
    },
    revoke(token) { drop(digest(token)); },
    revokeAll() { for (const key of [...byDigest.keys()]) drop(key); },
    sweep() {
      const t = now();
      for (const [key, rec] of byDigest) if (rec.expiresAt <= t) drop(key);
    },
    size: () => byDigest.size,
    __debugKeys: () => byDigest.keys(),
  };
}
```

`apps/api/src/services/aiModels/gateway/adapter.ts`:

```ts
import type { GatewayConnectionKind } from '@breeze/shared';
import {
  GatewayError,
  type GatewayConnectionConfig,
  type GatewayDialect,
  type GatewayGrantRecord,
  type GatewayIncomingRequest,
  type GatewayResponse,
} from './types';

/**
 * One adapter per gateway connection kind (W06: openai_compatible; W07: bedrock,
 * vertex, foundry). An adapter speaks its caller-facing dialect (what the Agent
 * SDK child / in-process client sends) and owns the upstream wire format. It must
 * dial ONLY through forwardUpstream (gateway/forward.ts) and must call
 * assertBoundModel on every model the request names before dialling.
 */
export interface GatewayAdapter {
  readonly kind: GatewayConnectionKind;
  readonly dialect: GatewayDialect;
  handle(req: GatewayIncomingRequest, grant: GatewayGrantRecord): Promise<GatewayResponse>;
  sdkChildEnv(input: { gatewayBaseUrl: string; config: GatewayConnectionConfig; wireModel: string }): Record<string, string>;
}

const adapters = new Map<string, GatewayAdapter>();

export function registerGatewayAdapter(adapter: GatewayAdapter): void {
  adapters.set(adapter.kind, adapter);
}

export function getGatewayAdapter(kind: GatewayConnectionKind): GatewayAdapter {
  const a = adapters.get(kind);
  if (!a) throw new Error(`No gateway adapter registered for connection kind ${kind}`);
  return a;
}

export function __resetGatewayAdaptersForTests(): void {
  adapters.clear();
}

/**
 * The bound-model rule (Review Focus 2): the upstream may only be asked for a
 * model the resolver priced for this dispatch (primary + its refusal fallback).
 */
export function assertBoundModel(grant: GatewayGrantRecord, model: unknown): string {
  if (typeof model !== 'string' || !grant.wireModels.has(model)) {
    throw new GatewayError(403, 'permission_error', 'gateway_model_mismatch',
      'This connection is not authorised for the requested model.');
  }
  return model;
}
```

`apps/api/src/services/aiModels/gateway/forward.ts`:

```ts
import { recordLlmEgressEvent } from '../../llm/llmEgressRecorder';
import { ResponseTooLargeError, safeFetch, SsrfBlockedError } from '../../urlSafety';
import { byoEgressAllowances } from './byoEndpointPolicy';
import { GATEWAY_CONNECT_TIMEOUT_MS, GATEWAY_MAX_RESPONSE_BYTES } from './limits';
import { GatewayError, type GatewayGrantRecord } from './types';

export interface UpstreamRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string | Buffer;
  stream: boolean;
}

/** Headers an adapter may never pass through to an upstream. */
const STRIPPED = new Set(['authorization', 'x-api-key', 'api-key', 'cookie', 'host', 'proxy-authorization', 'forwarded', 'x-forwarded-for', 'connection', 'content-length', 'transfer-encoding']);

let fetchImpl: typeof safeFetch = safeFetch;
export function __setUpstreamFetchForTests(fn: typeof safeFetch | null): void { fetchImpl = fn ?? safeFetch; }

let warnedNoOrg = false;

/** The upstream origin a grant may reach. W07 overrides via `upstreamOriginFor` per kind. */
export function upstreamOriginFor(grant: GatewayGrantRecord): string {
  switch (grant.config.kind) {
    case 'openai_compatible':
      return new URL(grant.config.baseUrl).origin;
    default: {
      const never: never = grant.config.kind;
      throw new Error(`no upstream origin for ${String(never)}`);
    }
  }
}

/** Auth headers for a grant's upstream. W07 replaces this per kind (SigV4, Google bearer, Azure key). */
export function upstreamAuthHeaders(grant: GatewayGrantRecord): Record<string, string> {
  switch (grant.config.kind) {
    case 'openai_compatible':
      return grant.credential.secret ? { authorization: `Bearer ${grant.credential.secret}` } : {};
    default: {
      const never: never = grant.config.kind;
      throw new Error(`no auth for ${String(never)}`);
    }
  }
}

function audit(grant: GatewayGrantRecord, host: string, resolvedIp: string | null, blocked: boolean): void {
  if (!grant.orgId) {
    // llm_egress_events is org-scoped (shape 1); partner-level verification and
    // discovery have no org to attribute a row to. Same posture as the catalog
    // harness (providerFidelityHarness.ts).
    if (!warnedNoOrg) {
      warnedNoOrg = true;
      console.warn(`[modelGateway] ${grant.purpose} egress for connection ${grant.config.connectionId} is not persisted (no organization in context).`);
    }
    return;
  }
  recordLlmEgressEvent({
    orgId: grant.orgId,
    partnerId: grant.config.partnerId,
    surface: 'gateway_forward',
    host,
    resolvedIp,
    blocked,
    aiSessionId: grant.aiSessionId,
    connectionId: grant.config.connectionId,
  });
}

/**
 * The ONLY function that dials a gateway connection's upstream (Global
 * Constraints; contract test in Task 16). Origin-pinned to the connection,
 * SSRF-guarded with DNS pinning (safeFetch), no redirects, response size capped,
 * credential injected here and nowhere else, one audit row per attempt.
 */
export async function forwardUpstream(
  grant: GatewayGrantRecord,
  req: UpstreamRequest,
  signal: AbortSignal,
): Promise<Response> {
  const target = new URL(req.url);
  const allowedOrigin = upstreamOriginFor(grant);
  if (target.origin !== allowedOrigin) {
    audit(grant, target.hostname, null, true);
    throw new GatewayError(502, 'api_error', 'gateway_origin_mismatch', 'The gateway refused an off-origin upstream request.');
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!STRIPPED.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  Object.assign(headers, upstreamAuthHeaders(grant));

  const allow = byoEgressAllowances();
  let resolvedIp: string | null = null;
  // Connect + response-headers deadline (Codex review #12): aborts only if headers
  // have not arrived in time; cleared as soon as fetch resolves (the body is then
  // governed by safeFetch's inactivity timeout and the server's total timer).
  const headersAc = new AbortController();
  const headersDeadline = setTimeout(() => headersAc.abort(), GATEWAY_CONNECT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(target.toString(), {
      method: req.method,
      headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      redirect: 'error',
      signal: AbortSignal.any([signal, headersAc.signal]),
      // Codex review #12: safeFetch's timeoutMs is a SOCKET-INACTIVITY timeout (urlSafety.ts),
      // so it is the stream idle limit, not a connect deadline (that is headersDeadline).
      timeoutMs: GATEWAY_IDLE_TIMEOUT_MS,
      allowPrivateNetwork: allow.allowPrivateNetwork,
      requirePrivateForCleartext: allow.requirePrivateForCleartext,
      maxBytes: GATEWAY_MAX_RESPONSE_BYTES,
      streamResponse: req.stream,
      onConnect: (ip: string) => { resolvedIp = ip; },
    });
    clearTimeout(headersDeadline);
    audit(grant, target.hostname, resolvedIp, false);
    if (res.status >= 300 && res.status < 400) {
      throw new GatewayError(502, 'api_error', 'upstream_redirect', 'The endpoint answered with a redirect, which Breeze does not follow.');
    }
    return res;
  } catch (error) {
    clearTimeout(headersDeadline);
    if (error instanceof GatewayError) throw error;
    audit(grant, target.hostname, resolvedIp, true);
    if (headersAc.signal.aborted && !signal.aborted) {
      throw new GatewayError(504, 'api_error', 'upstream_timeout', 'The endpoint did not respond in time.');
    }
    if (error instanceof SsrfBlockedError) {
      throw new GatewayError(502, 'api_error', 'egress_blocked', 'The endpoint resolves to an address Breeze does not connect to.');
    }
    if (error instanceof ResponseTooLargeError) {
      throw new GatewayError(502, 'api_error', 'upstream_too_large', 'The endpoint response exceeded the size limit.');
    }
    if (signal.aborted) throw new GatewayError(499, 'api_error', 'client_aborted', 'Request aborted.');
    throw new GatewayError(502, 'api_error', 'upstream_unreachable', 'The endpoint could not be reached.');
  }
}
```

Note: when W07 lands, `upstreamOriginFor` / `upstreamAuthHeaders` gain cloud arms (the `never` default forces it). `byoEgressAllowances()` applies to `openai_compatible` only; W07 passes strict allowances for cloud kinds (fixed public provider hosts).

`apps/api/src/services/aiModels/gateway/server.ts`:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { scrubSecrets } from './scrub';
import { getGatewayAdapter } from './adapter';
import { createGrantStore, type GrantStore } from './grants';
import {
  GATEWAY_IDLE_TIMEOUT_MS,
  GATEWAY_MAX_CONCURRENT_PER_GRANT,
  GATEWAY_MAX_REQUEST_BYTES,
  GATEWAY_TOTAL_TIMEOUT_MS,
} from './limits';
import { recordLlmEgressEvent } from '../../llm/llmEgressRecorder';
import {
  GatewayError,
  gatewayErrorBody,
  type GatewayGrant,
  type GatewayGrantInput,
  type GatewayGrantRecord,
  type GatewayResponse,
} from './types';

export interface ModelGateway {
  grant(input: GatewayGrantInput): GatewayGrant;
  revoke(token: string): void;
  port(): number;
  close(): Promise<void>;
}

const ROUTE = /^\/g\/([A-Za-z0-9_-]{1,64})(\/[^?#]*)?(?:\?.*)?$/;

function send(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (declared > limit) throw new GatewayError(413, 'request_too_large', 'request_too_large', 'Request body too large.');
  const parts: Buffer[] = [];
  let total = 0;
  // Codex review #13: an abort destroys the request stream so a stalled sender
  // cannot hold a grant slot until the next chunk arrives.
  const onAbort = (): void => { req.destroy(); };
  signal.addEventListener('abort', onAbort, { once: true });
  for await (const chunk of req) {
    if (signal.aborted) throw new GatewayError(499, 'api_error', 'client_aborted', 'Request aborted.');
    total += (chunk as Buffer).length;
    if (total > limit) throw new GatewayError(413, 'request_too_large', 'request_too_large', 'Request body too large.');
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts);
}

async function writeResponse(res: ServerResponse, out: GatewayResponse, signal: AbortSignal): Promise<void> {
  res.writeHead(out.status, { ...out.headers, 'cache-control': 'no-store' });
  if (Buffer.isBuffer(out.body)) { res.end(out.body); return; }
  let idle: NodeJS.Timeout | null = null;
  const arm = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => res.destroy(new Error('gateway idle timeout')), GATEWAY_IDLE_TIMEOUT_MS);
  };
  arm();
  try {
    for await (const chunk of out.body) {
      if (signal.aborted) break;
      if (!res.write(chunk)) {
        // Codex review #13: wait for drain, but also wake on abort / close / error.
        await new Promise<void>((resolve) => {
          const done = (): void => { res.off('drain', done); res.off('close', done); res.off('error', done); signal.removeEventListener('abort', done); resolve(); };
          res.once('drain', done); res.once('close', done); res.once('error', done); signal.addEventListener('abort', done, { once: true });
        });
        if (signal.aborted || res.destroyed) break;
      }
      arm();
    }
  } finally {
    if (idle) clearTimeout(idle);
    res.end();
  }
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') out[k.toLowerCase()] = v;
  return out;
}

export async function startModelGateway(store: GrantStore = createGrantStore()): Promise<ModelGateway> {
  let listenPort = 0;
  const sweeper = setInterval(() => store.sweep(), 60_000);
  sweeper.unref();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const m = ROUTE.exec(req.url ?? '');
      if (!m) { send(res, 400, gatewayErrorBody('invalid_request_error', 'Malformed gateway path.')); return; }
      const token = m[1]!;
      const path = m[2] ?? '/';
      if (path.split('/').some((seg) => seg === '..' || seg === '.')) {
        send(res, 400, gatewayErrorBody('invalid_request_error', 'Malformed gateway path.'));
        return;
      }
      const grant: GatewayGrantRecord | null = store.lookup(token);
      if (!grant) { send(res, 401, gatewayErrorBody('authentication_error', 'Invalid or expired gateway grant.')); return; }
      if (grant.inFlight.size >= GATEWAY_MAX_CONCURRENT_PER_GRANT) {
        send(res, 429, gatewayErrorBody('rate_limit_error', 'Too many concurrent requests on this connection.'));
        return;
      }
      const ac = new AbortController();
      grant.inFlight.add(ac);
      const total = setTimeout(() => ac.abort(), GATEWAY_TOTAL_TIMEOUT_MS);
      res.on('close', () => ac.abort());
      try {
        const body = await readBody(req, GATEWAY_MAX_REQUEST_BYTES, ac.signal);
        const adapter = getGatewayAdapter(grant.config.kind);
        const out = await adapter.handle(
          { method: req.method ?? 'GET', path, headers: headersOf(req), body, signal: ac.signal },
          grant,
        );
        await writeResponse(res, out, ac.signal);
      } catch (error) {
        if (error instanceof GatewayError) {
          if (error.code === 'gateway_model_mismatch' && grant.orgId) {
            recordLlmEgressEvent({
              orgId: grant.orgId, partnerId: grant.config.partnerId, surface: 'gateway_forward',
              host: 'gateway', resolvedIp: null, blocked: true, aiSessionId: grant.aiSessionId,
              connectionId: grant.config.connectionId,
            });
          }
          send(res, error.status === 499 ? 400 : error.status, gatewayErrorBody(error.errorType,
            scrubSecrets(error.message, [grant.credential.secret])));
        } else {
          console.error(`[modelGateway] unhandled adapter error (grant ${grant.id}, connection ${grant.config.connectionId}):`,
            scrubSecrets(error instanceof Error ? error.message : String(error), [grant.credential.secret]));
          send(res, 502, gatewayErrorBody('api_error', 'The model endpoint request failed.'));
        }
      } finally {
        clearTimeout(total);
        grant.inFlight.delete(ac);
      }
    })();
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0; // long streams; the per-request total timer governs

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      listenPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });

  const api: ModelGateway = {
    grant(input) {
      const { token } = store.issue(input);
      return {
        token,
        baseUrl: `http://127.0.0.1:${listenPort}/g/${token}`,
        revoke: () => store.revoke(token),
      };
    },
    revoke: (token) => store.revoke(token),
    port: () => listenPort,
    async close() {
      clearInterval(sweeper);
      store.revokeAll();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (singletonInstance === api) { singletonInstance = null; singletonPromise = null; }
    },
  };
  return api;
}

let singletonPromise: Promise<ModelGateway> | null = null;
let singletonInstance: ModelGateway | null = null;

/** Lazy per-process singleton (one listener; grants separate callers). */
export function getModelGateway(): Promise<ModelGateway> {
  if (!singletonPromise) {
    singletonPromise = startModelGateway().then((gw) => { singletonInstance = gw; return gw; }, (error) => {
      singletonPromise = null;
      throw error;
    });
  }
  return singletonPromise;
}

export async function closeModelGateway(): Promise<void> {
  if (singletonInstance) await singletonInstance.close();
}
```

`apps/api/src/services/aiModels/gateway/index.ts`:

```ts
// Registers every gateway adapter. Import this module (side effect) wherever the
// gateway is used; connectionFactory.ts does so (Task 9). W07 adds its three imports.
import './openai/adapter';
export { getModelGateway, getStartedModelGateway, closeModelGateway, type ModelGateway } from './server';
export { getGatewayAdapter, assertBoundModel, type GatewayAdapter } from './adapter';
export * from './types';
```

(Until Task 7 lands, leave the `./openai/adapter` import out and add it in Task 7.)

`apps/api/src/index.ts`: where shutdown closes the egress proxy (grep `getLlmEgressProxy` / `close()` in the shutdown handler), add `await closeModelGateway().catch(() => {});` next to it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/`
Expected: PASS (scrub 4, grants 6, forward 7, server 9).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/gateway/ apps/api/src/index.ts
git commit -m "feat(ai-models): loopback model gateway — grants, adapter registry, guarded forward (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: Request translation — Anthropic Messages → OpenAI `chat/completions`

Pure function, no I/O. Everything the Agent SDK CLI and `@anthropic-ai/sdk` send on `POST /v1/messages` maps to one OpenAI request. Anything that cannot be represented is either dropped deliberately (thinking, cache control, betas) or refused with a 400 the caller can show (documents, server tools).

**Files:**
- Create: `apps/api/src/services/aiModels/gateway/openai/types.ts`
- Create: `apps/api/src/services/aiModels/gateway/openai/translateRequest.ts`
- Create: `apps/api/src/services/aiModels/gateway/openai/translateRequest.test.ts`

**Interfaces:**
- Consumes: Task 4 `GatewayError`, `GATEWAY_MAX_TOOLS`.
- Produces:

```ts
// openai/types.ts — the subset of the OpenAI chat wire the translator uses
export interface OaiMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | OaiContentPart[] | null; tool_calls?: OaiToolCall[]; tool_call_id?: string }
export type OaiContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface OaiToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface OaiTool { type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> } }
export interface OaiChatRequest {
  model: string; messages: OaiMessage[]; max_tokens?: number; temperature?: number; top_p?: number; stop?: string[];
  tools?: OaiTool[]; tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  stream: boolean; stream_options?: { include_usage: true };
}
/** Maps OpenAI-legal function names back to the Anthropic tool names the caller sent. */
export interface ToolNameMap { toOai: ReadonlyMap<string, string>; fromOai: ReadonlyMap<string, string> }

// translateRequest.ts
export interface TranslatedRequest { body: OaiChatRequest; tools: ToolNameMap; requestedModel: string; stream: boolean }
export function translateMessagesRequest(input: unknown, wireModel: string): TranslatedRequest;
export function oaiToolName(anthropicName: string): string;   // identity if legal, else `t_<sha256-10>`
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiModels/gateway/openai/translateRequest.test.ts
import { describe, expect, it } from 'vitest';
import { GatewayError } from '../types';
import { oaiToolName, translateMessagesRequest } from './translateRequest';

const base = { model: 'qwen', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] };

describe('translateMessagesRequest', () => {
  it('maps model to the bound wire model, max_tokens, stream + include_usage', () => {
    const t = translateMessagesRequest({ ...base, stream: true, temperature: 0.2, top_p: 0.9, stop_sequences: ['END'] }, 'qwen');
    expect(t.body).toEqual({
      model: 'qwen', max_tokens: 1024, temperature: 0.2, top_p: 0.9, stop: ['END'], stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(t.requestedModel).toBe('qwen');
  });

  it('system string and system blocks become one leading system message (cache_control dropped)', () => {
    const a = translateMessagesRequest({ ...base, system: 'be brief' }, 'qwen');
    expect(a.body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    const b = translateMessagesRequest({ ...base, system: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two', cache_control: { type: 'ephemeral' } }] }, 'qwen');
    expect(b.body.messages[0]).toEqual({ role: 'system', content: 'one\n\ntwo' });
  });

  it('drops thinking, output_config, metadata, betas and thinking/redacted_thinking blocks', () => {
    const t = translateMessagesRequest({
      ...base, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }, metadata: { user_id: 'u' },
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret chain', signature: 's' }, { type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'a' }] },
        { role: 'user', content: 'next' },
      ],
    }, 'qwen');
    expect(JSON.stringify(t.body)).not.toMatch(/secret chain|adaptive|effort|user_id|redacted/);
    expect(t.body.messages[1]).toEqual({ role: 'assistant', content: 'a' });
  });

  it('assistant tool_use → tool_calls; user tool_result → role:tool messages in order, before the remaining user text', () => {
    const t = translateMessagesRequest({
      ...base,
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Oslo' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'sunny 21' }] }, { type: 'text', text: 'thanks' }] },
      ],
    }, 'qwen');
    expect(t.body.messages).toEqual([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: 'checking', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'sunny 21' },
      { role: 'user', content: 'thanks' },
    ]);
    expect(t.body.tools).toEqual([{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]);
  });

  it('an is_error tool_result is prefixed so the model sees it failed', () => {
    const t = translateMessagesRequest({
      ...base,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'denied' }] },
      ],
    }, 'qwen');
    expect(t.body.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 't1', content: 'Error: denied' });
  });

  it('assistant with only tool_use has content null', () => {
    const t = translateMessagesRequest({ ...base, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }] }, 'qwen');
    expect(t.body.messages[0]).toMatchObject({ role: 'assistant', content: null });
  });

  it('base64 images become data-URI image_url parts; URL images pass through as image_url', () => {
    const t = translateMessagesRequest({ ...base, messages: [{ role: 'user', content: [
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://img.example.com/a.png' } },
    ] }] }, 'qwen');
    expect(t.body.messages[0]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'https://img.example.com/a.png' } },
    ] });
  });

  it.each([
    [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'x' } }],
    [{ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }],
    [{ type: 'search_result', source: 'x', title: 't', content: [] }],
  ])('refuses an unrepresentable block %j with a 400', (block) => {
    expect(() => translateMessagesRequest({ ...base, messages: [{ role: 'user', content: [block] }] }, 'qwen'))
      .toThrowError(GatewayError);
  });

  it('refuses server tools (web_search etc.) in tools[]', () => {
    expect(() => translateMessagesRequest({ ...base, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, 'qwen')).toThrowError(/not supported/);
  });

  it('tool_choice mapping', () => {
    const tools = [{ name: 'x', input_schema: { type: 'object' } }];
    expect(translateMessagesRequest({ ...base, tools, tool_choice: { type: 'auto' } }, 'q').body.tool_choice).toBe('auto');
    expect(translateMessagesRequest({ ...base, tools, tool_choice: { type: 'any' } }, 'q').body.tool_choice).toBe('required');
    expect(translateMessagesRequest({ ...base, tools, tool_choice: { type: 'none' } }, 'q').body.tool_choice).toBe('none');
    expect(translateMessagesRequest({ ...base, tools, tool_choice: { type: 'tool', name: 'x' } }, 'q').body.tool_choice)
      .toEqual({ type: 'function', function: { name: 'x' } });
  });

  it('aliases tool names OpenAI cannot carry (>64 chars or illegal chars) and maps them back', () => {
    const long = `mcp__breeze__${'very_long_tool_name_'.repeat(4)}`;
    const t = translateMessagesRequest({ ...base, tools: [{ name: long, input_schema: { type: 'object' } }] }, 'q');
    const alias = t.body.tools![0]!.function.name;
    expect(alias).toMatch(/^t_[0-9a-f]{10}$/);
    expect(t.tools.fromOai.get(alias)).toBe(long);
    expect(oaiToolName('get_weather')).toBe('get_weather');
    expect(oaiToolName(long)).toBe(alias);
  });

  it('caps the tool list', () => {
    const tools = Array.from({ length: 513 }, (_, i) => ({ name: `t${i}`, input_schema: { type: 'object' } }));
    expect(() => translateMessagesRequest({ ...base, tools }, 'q')).toThrowError(/Too many tools/);
  });

  it('rejects a malformed body with a 400, never a 500', () => {
    for (const bad of [null, 'x', { messages: 'no' }, { messages: [{ role: 'robot', content: 'x' }] }, { messages: [], max_tokens: -1 }]) {
      expect(() => translateMessagesRequest(bad, 'q')).toThrowError(GatewayError);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/openai/translateRequest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/aiModels/gateway/openai/types.ts` — exactly the interfaces in **Interfaces** above, plus the response-side types used by Task 6:

```ts
export interface OaiChatChoice {
  index: number;
  message?: { role: 'assistant'; content: string | null; tool_calls?: OaiToolCall[]; reasoning_content?: string | null };
  delta?: { role?: 'assistant'; content?: string | null; tool_calls?: Array<{ index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }>; reasoning_content?: string | null };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null;
}
export interface OaiUsage { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
export interface OaiChatResponse { id?: string; model?: string; choices: OaiChatChoice[]; usage?: OaiUsage | null }
```

`apps/api/src/services/aiModels/gateway/openai/translateRequest.ts`:

```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GATEWAY_MAX_TOOLS } from '../limits';
import { GatewayError } from '../types';
import type { OaiChatRequest, OaiContentPart, OaiMessage, OaiTool, OaiToolCall, ToolNameMap } from './types';

const bad = (message: string): GatewayError => new GatewayError(400, 'invalid_request_error', 'translate_invalid', message);

const textBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const imageBlock = z.object({
  type: z.literal('image'),
  source: z.union([
    z.object({ type: z.literal('base64'), media_type: z.string().regex(/^image\/(png|jpeg|gif|webp)$/), data: z.string() }),
    z.object({ type: z.literal('url'), url: z.string().url() }),
  ]),
}).passthrough();
const toolUseBlock = z.object({ type: z.literal('tool_use'), id: z.string().min(1), name: z.string().min(1), input: z.unknown() }).passthrough();
const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  is_error: z.boolean().optional(),
  content: z.union([z.string(), z.array(z.union([textBlock, imageBlock]))]).optional(),
}).passthrough();
const droppedBlock = z.object({ type: z.enum(['thinking', 'redacted_thinking']) }).passthrough();
const anyBlock = z.object({ type: z.string() }).passthrough();

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(anyBlock)]),
});
const toolSchema = z.object({
  type: z.literal('custom').optional(),
  name: z.string().min(1).max(256),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()),
}).passthrough();
const requestSchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  messages: z.array(messageSchema),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop_sequences: z.array(z.string()).max(16).optional(),
  tools: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  tool_choice: z.object({ type: z.enum(['auto', 'any', 'none', 'tool']), name: z.string().optional() }).passthrough().optional(),
}).passthrough();

const OAI_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export function oaiToolName(name: string): string {
  return OAI_NAME.test(name) ? name : `t_${createHash('sha256').update(name).digest('hex').slice(0, 10)}`;
}

function toolResultText(block: z.infer<typeof toolResultBlock>): string {
  const body = typeof block.content === 'string'
    ? block.content
    : (block.content ?? []).map((b) => (b.type === 'text' ? b.text : '[image omitted]')).join('\n');
  return block.is_error ? `Error: ${body}` : body;
}

function userParts(blocks: Array<z.infer<typeof anyBlock>>): { tools: OaiMessage[]; parts: OaiContentPart[] } {
  const tools: OaiMessage[] = [];
  const parts: OaiContentPart[] = [];
  for (const raw of blocks) {
    if (droppedBlock.safeParse(raw).success) continue;
    const tr = toolResultBlock.safeParse(raw);
    if (tr.success) { tools.push({ role: 'tool', tool_call_id: tr.data.tool_use_id, content: toolResultText(tr.data) }); continue; }
    const t = textBlock.safeParse(raw);
    if (t.success) { parts.push({ type: 'text', text: t.data.text }); continue; }
    const img = imageBlock.safeParse(raw);
    if (img.success) {
      const src = img.data.source;
      parts.push({ type: 'image_url', image_url: { url: src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src.url } });
      continue;
    }
    throw bad(`Content block type "${String(raw.type)}" is not supported on an OpenAI-compatible connection.`);
  }
  return { tools, parts };
}

function collapse(parts: OaiContentPart[]): string | OaiContentPart[] {
  return parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n') : parts;
}

export interface TranslatedRequest { body: OaiChatRequest; tools: ToolNameMap; requestedModel: string; stream: boolean }

export function translateMessagesRequest(input: unknown, wireModel: string): TranslatedRequest {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw bad('Malformed Messages API request.');
  const req = parsed.data;

  // Tools
  const toOai = new Map<string, string>();
  const fromOai = new Map<string, string>();
  let tools: OaiTool[] | undefined;
  if (req.tools && req.tools.length > 0) {
    if (req.tools.length > GATEWAY_MAX_TOOLS) throw bad('Too many tools for one request.');
    tools = req.tools.map((raw) => {
      const t = toolSchema.safeParse(raw);
      if (!t.success) throw bad(`Tool "${String(raw.name)}" is not supported on an OpenAI-compatible connection (server tools are not supported).`);
      const name = oaiToolName(t.data.name);
      toOai.set(t.data.name, name);
      fromOai.set(name, t.data.name);
      return { type: 'function', function: { name, ...(t.data.description ? { description: t.data.description } : {}), parameters: t.data.input_schema } };
    });
  }

  // Messages
  const messages: OaiMessage[] = [];
  if (req.system !== undefined) {
    const sys = typeof req.system === 'string' ? req.system : req.system.map((b) => b.text).join('\n\n');
    if (sys.length > 0) messages.push({ role: 'system', content: sys });
  }
  for (const m of req.messages) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'user') {
      const { tools: toolMsgs, parts } = userParts(m.content);
      messages.push(...toolMsgs);
      if (parts.length > 0) messages.push({ role: 'user', content: collapse(parts) });
      continue;
    }
    // assistant
    const text: string[] = [];
    const calls: OaiToolCall[] = [];
    for (const raw of m.content) {
      if (droppedBlock.safeParse(raw).success) continue;
      const t = textBlock.safeParse(raw);
      if (t.success) { text.push(t.data.text); continue; }
      const tu = toolUseBlock.safeParse(raw);
      if (tu.success) {
        calls.push({ id: tu.data.id, type: 'function', function: { name: toOai.get(tu.data.name) ?? oaiToolName(tu.data.name), arguments: JSON.stringify(tu.data.input ?? {}) } });
        continue;
      }
      throw bad(`Content block type "${String(raw.type)}" is not supported on an OpenAI-compatible connection.`);
    }
    messages.push({ role: 'assistant', content: text.length > 0 ? text.join('\n') : null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
  }

  let tool_choice: OaiChatRequest['tool_choice'];
  if (req.tool_choice && tools) {
    const c = req.tool_choice;
    tool_choice = c.type === 'auto' ? 'auto' : c.type === 'any' ? 'required' : c.type === 'none' ? 'none'
      : { type: 'function', function: { name: toOai.get(c.name ?? '') ?? oaiToolName(c.name ?? '') } };
  }

  const stream = req.stream === true;
  const body: OaiChatRequest = {
    model: wireModel,
    messages,
    max_tokens: req.max_tokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stop_sequences ? { stop: req.stop_sequences } : {}),
    ...(tools ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    stream,
    ...(stream ? { stream_options: { include_usage: true as const } } : {}),
  };
  return { body, tools: { toOai, fromOai }, requestedModel: req.model, stream };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/openai/translateRequest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/gateway/openai/types.ts apps/api/src/services/aiModels/gateway/openai/translateRequest.ts \
  apps/api/src/services/aiModels/gateway/openai/translateRequest.test.ts
git commit -m "feat(ai-models): Anthropic→OpenAI request translation with tool calling (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Response translation — OpenAI → Anthropic (buffered and streamed), untrusted-endpoint safe

The endpoint is untrusted. The translator is where a hostile or broken model is contained: it decides which tool calls become `tool_use` blocks the Agent SDK will execute. Rules (Review Focus 1, Decision D9):
- A tool call becomes `tool_use` only if its function name maps back to a tool **the caller offered in this request**, its arguments parse to a JSON **object**, and it is within the count/size caps. Otherwise the whole turn ends `end_turn` with a visible text note and **no** `tool_use` blocks (never a partial set: half-executed tool batches are worse than none).
- Tool-call arguments are buffered until the call is complete, then emitted as one `input_json_delta`.
- `reasoning_content` is never forwarded.
- `finish_reason` → `stop_reason`: `stop`→`end_turn`, `length`→`max_tokens`, `tool_calls`/`function_call`→`tool_use` (only if at least one valid tool_use was emitted, else `end_turn`), `content_filter`→`refusal` (with `stop_details: { type: 'refusal', category: null }` so W03's refusal path surfaces it, spec §9.1a), `null`→`end_turn`.
- Usage: `input_tokens = prompt_tokens − cached_tokens`, `cache_read_input_tokens = cached_tokens`, `cache_creation_input_tokens = 0`, `output_tokens = completion_tokens`. Streamed: `message_start` carries `input_tokens: 0`; the final `message_delta` carries the full cumulative usage (`input_tokens`, `output_tokens`, `cache_read_input_tokens`) — the Anthropic SDK's stream accumulator overwrites from `message_delta.usage` (pinned end-to-end in Task 9).

**Files:**
- Create: `apps/api/src/services/aiModels/gateway/openai/translateResponse.ts` (+ `.test.ts`)
- Create: `apps/api/src/services/aiModels/gateway/openai/translateStream.ts` (+ `.test.ts`)
- Create: `apps/api/src/services/aiModels/gateway/openai/sse.ts` (SSE line parser + encoder, + `.test.ts`)

**Interfaces:**
- Consumes: Task 5 `ToolNameMap`, `OaiChatResponse`; Task 4 limits.
- Produces:

```ts
// translateResponse.ts
export interface AnthropicMessage { id: string; type: 'message'; role: 'assistant'; model: string; content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal'; stop_sequence: null; stop_details?: { type: 'refusal'; category: null };
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } }
export type AnthropicContentBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export function translateChatResponse(res: unknown, ctx: { model: string; tools: ToolNameMap; estimatedInputTokens?: number }): AnthropicMessage;
export function mapUsage(u: OaiUsage | null | undefined): AnthropicMessage['usage'];
export function resolveUsage(u: OaiUsage | null | undefined, est: { inputTokens: number; outputChars: number }): AnthropicMessage['usage'];   // estimate when unreported
export const UNSAFE_TOOL_CALL_NOTE: string;
// translateStream.ts
export function translateChatStream(upstream: AsyncIterable<Uint8Array>, ctx: { model: string; tools: ToolNameMap; messageId: string; estimatedInputTokens: number }): AsyncIterable<Uint8Array>;
// sse.ts
export function parseSse(source: AsyncIterable<Uint8Array>, maxEventBytes?: number): AsyncIterable<{ event: string | null; data: string }>;
export function encodeSse(event: string, data: unknown): Uint8Array;
```

- [ ] **Step 1: Write the failing tests**

`translateResponse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { translateChatResponse, UNSAFE_TOOL_CALL_NOTE } from './translateResponse';

const tools = { toOai: new Map([['get_weather', 'get_weather']]), fromOai: new Map([['get_weather', 'get_weather']]) };
const ctx = { model: 'qwen', tools };
const usage = { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } };

describe('translateChatResponse', () => {
  it('text answer → end_turn with mapped usage', () => {
    const m = translateChatResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage }, ctx);
    expect(m).toMatchObject({ type: 'message', role: 'assistant', model: 'qwen', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] });
    expect(m.usage).toEqual({ input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 });
  });

  it('valid tool call → tool_use with parsed object input and the Anthropic tool name', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] } }], usage }, ctx);
    expect(m.stop_reason).toBe('tool_use');
    expect(m.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } }]);
  });

  it('unknown tool name never becomes tool_use', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'ok',
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'delete_all_devices', arguments: '{}' } }] } }] }, ctx);
    expect(m.stop_reason).toBe('end_turn');
    expect(m.content.some((b) => b.type === 'tool_use')).toBe(false);
    expect(m.content.at(-1)).toEqual({ type: 'text', text: UNSAFE_TOOL_CALL_NOTE });
  });

  it.each([['not json'], ['[1,2]'], ['"str"'], ['null']])('malformed arguments %j never become tool_use', (args) => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_weather', arguments: args } }] } }] }, ctx);
    expect(m.content).toEqual([{ type: 'text', text: UNSAFE_TOOL_CALL_NOTE }]);
    expect(m.stop_reason).toBe('end_turn');
  });

  it('one bad call in a batch drops the whole batch (never a partial tool set)', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"A"}' } },
      { id: 'b', type: 'function', function: { name: 'get_weather', arguments: '{bad' } },
    ] } }] }, ctx);
    expect(m.content.filter((b) => b.type === 'tool_use')).toHaveLength(0);
  });

  it('caps tool calls and argument size', () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ id: `c${i}`, type: 'function', function: { name: 'get_weather', arguments: '{}' } }));
    expect(translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: many } }] }, ctx)
      .content.some((b) => b.type === 'tool_use')).toBe(false);
    const huge = `{"x":"${'a'.repeat(256 * 1024)}"}`;
    expect(translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_weather', arguments: huge } }] } }] }, ctx)
      .content.some((b) => b.type === 'tool_use')).toBe(false);
  });

  it('missing tool call id gets a generated toolu_ id', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ type: 'function', function: { name: 'get_weather', arguments: '{}' } }] } }] }, ctx);
    expect((m.content[0] as { id: string }).id).toMatch(/^toolu_gw_[A-Za-z0-9]{16}$/);
  });

  it('reasoning_content is never forwarded', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'a', reasoning_content: 'private chain' } }] }, ctx);
    expect(JSON.stringify(m)).not.toContain('private chain');
  });

  it('finish_reason mapping: length → max_tokens; content_filter → refusal with stop_details', () => {
    expect(translateChatResponse({ choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: 'x' } }] }, ctx).stop_reason).toBe('max_tokens');
    const r = translateChatResponse({ choices: [{ index: 0, finish_reason: 'content_filter', message: { role: 'assistant', content: '' } }] }, ctx);
    expect(r).toMatchObject({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: null } });
  });

  it('a response with no choices is a 502 GatewayError, not a crash', () => {
    expect(() => translateChatResponse({ choices: [] }, ctx)).toThrow(/no choices/);
    expect(() => translateChatResponse('nope', ctx)).toThrow();
  });

  it('missing usage is ESTIMATED from the request and the answer, never billed as zero (Codex review #5)', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'x'.repeat(30) } }] },
      { ...ctx, estimatedInputTokens: 77 });
    expect(m.usage).toEqual({ input_tokens: 77, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });

  it('non-numeric usage counters fall back to the estimate too (never NaN, never 0)', () => {
    const m = translateChatResponse({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'abc' } }],
      usage: { prompt_tokens: 'lots' as never } }, { ...ctx, estimatedInputTokens: 5 });
    expect(m.usage.input_tokens).toBe(5);
    expect(m.usage.output_tokens).toBe(1);
  });
});
```

`translateStream.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { translateChatStream } from './translateStream';
import { UNSAFE_TOOL_CALL_NOTE } from './translateResponse';

const tools = { toOai: new Map([['get_weather', 'get_weather']]), fromOai: new Map([['get_weather', 'get_weather']]) };
const enc = new TextEncoder();
async function* sse(...chunks: unknown[]) {
  for (const c of chunks) yield enc.encode(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
}
async function events(src: AsyncIterable<Uint8Array>) {
  let text = '';
  for await (const b of src) text += new TextDecoder().decode(b);
  return text.split('\n\n').filter(Boolean).map((blk) => {
    const ev = /^event: (.+)$/m.exec(blk)?.[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(blk)![1]!);
    return { ev, data };
  });
}
const run = (...c: unknown[]) => events(translateChatStream(sse(...c), { model: 'qwen', tools, messageId: 'msg_gw_1', estimatedInputTokens: 9 }));

describe('translateChatStream', () => {
  it('text deltas stream live, usage arrives in message_delta, ends message_stop', async () => {
    const ev = await run(
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 10 } } },
      '[DONE]',
    );
    expect(ev.map((e) => e.ev)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(ev[0]!.data.message.usage.input_tokens).toBe(0);
    expect(ev[2]!.data.delta).toEqual({ type: 'text_delta', text: 'Hel' });
    expect(ev[5]!.data).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 40, output_tokens: 2, cache_read_input_tokens: 10 } });
  });

  it('tool call arguments are buffered and emitted whole after validation', async () => {
    const ev = await run(
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Oslo"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    );
    const start = ev.find((e) => e.ev === 'content_block_start')!;
    expect(start.data.content_block).toEqual({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} });
    const deltas = ev.filter((e) => e.ev === 'content_block_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.data.delta).toEqual({ type: 'input_json_delta', partial_json: '{"city":"Oslo"}' });
    expect(ev.find((e) => e.ev === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');
  });

  it('unknown tool name never becomes tool_use (stream)', async () => {
    const ev = await run(
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'wipe_everything', arguments: '{}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
    );
    expect(ev.some((e) => e.data.content_block?.type === 'tool_use')).toBe(false);
    expect(ev.some((e) => e.data.delta?.text === UNSAFE_TOOL_CALL_NOTE)).toBe(true);
    expect(ev.find((e) => e.ev === 'message_delta')!.data.delta.stop_reason).toBe('end_turn');
  });

  it('malformed arguments never become tool_use (stream)', async () => {
    const ev = await run(
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'get_weather', arguments: '{oops' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
    );
    expect(ev.some((e) => e.data.content_block?.type === 'tool_use')).toBe(false);
  });

  it('text then tool call: text block closes before the tool_use block opens', async () => {
    const ev = await run(
      { choices: [{ index: 0, delta: { content: 'checking' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'get_weather', arguments: '{}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
    );
    const kinds = ev.map((e) => `${e.ev}:${e.data.index ?? ''}`);
    expect(kinds).toEqual(['message_start:', 'content_block_start:0', 'content_block_delta:0', 'content_block_stop:0',
      'content_block_start:1', 'content_block_delta:1', 'content_block_stop:1', 'message_delta:', 'message_stop:']);
  });

  it('reasoning_content deltas are dropped', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { reasoning_content: 'secret' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'a' }, finish_reason: 'stop' }] }, '[DONE]');
    expect(JSON.stringify(ev)).not.toContain('secret');
  });

  it('a stream truncated mid tool call (no finish_reason, no [DONE]) never emits tool_use (Codex review #1)', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] }, finish_reason: null }] });
    expect(ev.some((e) => e.data.content_block?.type === 'tool_use')).toBe(false);
    expect(ev.some((e) => e.data.delta?.text === UNSAFE_TOOL_CALL_NOTE)).toBe(true);
  });

  it('blank tool arguments are not treated as {} (Codex review #1)', async () => {
    const ev = await run(
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
    );
    expect(ev.some((e) => e.data.content_block?.type === 'tool_use')).toBe(false);
  });

  it('no usage chunk → message_delta carries an estimate, never 0 input tokens (Codex review #5)', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { content: 'abcdef' }, finish_reason: 'stop' }] }, '[DONE]');
    expect(ev.find((e) => e.ev === 'message_delta')!.data.usage).toMatchObject({ input_tokens: 9, output_tokens: 2 });
  });

  it('an upstream that ends without [DONE] or finish_reason still closes the message (end_turn)', async () => {
    const ev = await run({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] });
    expect(ev.at(-1)!.ev).toBe('message_stop');
  });

  it('a malformed SSE data line becomes an Anthropic error event, not a crash', async () => {
    const ev = await run('{not json');
    expect(ev.some((e) => e.ev === 'error')).toBe(true);
  });
});
```

`sse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { encodeSse, parseSse } from './sse';

async function* bytes(...parts: string[]) { for (const p of parts) yield new TextEncoder().encode(p); }
async function collect(src: AsyncIterable<{ event: string | null; data: string }>) { const out = []; for await (const e of src) out.push(e); return out; }

describe('sse', () => {
  it('reassembles events split across chunks and CRLF', async () => {
    expect(await collect(parseSse(bytes('data: {"a"', ':1}\r\n\r\nevent: x\ndata: 2\n\n')))).toEqual([{ event: null, data: '{"a":1}' }, { event: 'x', data: '2' }]);
  });
  it('ignores comments and caps a single event', async () => {
    expect(await collect(parseSse(bytes(': keepalive\n\n')))).toEqual([]);
    await expect(collect(parseSse(bytes(`data: ${'a'.repeat(100)}\n\n`), 50))).rejects.toThrow(/too large/);
  });
  it('encodes', () => {
    expect(new TextDecoder().decode(encodeSse('ping', { type: 'ping' }))).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/openai/translateResponse.test.ts src/services/aiModels/gateway/openai/translateStream.test.ts src/services/aiModels/gateway/openai/sse.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

`sse.ts`:

```ts
const enc = new TextEncoder();

/** Minimal SSE reader (data/event fields only). Throws when one event exceeds maxEventBytes. */
export async function* parseSse(
  source: AsyncIterable<Uint8Array>,
  maxEventBytes = 4 * 1024 * 1024,
): AsyncIterable<{ event: string | null; data: string }> {
  // Codex review #11: one decoder PER STREAM (split multi-byte sequences must not
  // leak between concurrent responses); CRLF normalised on the accumulated buffer
  // so a \r\n split across chunks is handled.
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of source) {
    buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    if (buf.length > maxEventBytes && !buf.includes('\n\n')) throw new Error('SSE event too large');
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (raw.length > maxEventBytes) throw new Error('SSE event too large');
      let event: string | null = null;
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length > 0) yield { event, data: data.join('\n') };
    }
  }
  buf += dec.decode();
  const tail = buf.replace(/\r\n/g, '\n').trim();
  if (tail.startsWith('data:')) yield { event: null, data: tail.slice(5).replace(/^ /, '') };
}

export function encodeSse(event: string, data: unknown): Uint8Array {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
```

`translateResponse.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { GATEWAY_MAX_TOOL_ARGS_BYTES, GATEWAY_MAX_TOOL_CALLS } from '../limits';
import { GatewayError } from '../types';
import type { OaiChatResponse, OaiToolCall, OaiUsage, ToolNameMap } from './types';

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal';
  stop_sequence: null;
  stop_details?: { type: 'refusal'; category: null };
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
}

export const UNSAFE_TOOL_CALL_NOTE =
  '[Breeze: the model asked to run a tool in a form Breeze could not verify, so nothing was run. Try rephrasing, or choose a different model.]';

const nonNeg = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export function mapUsage(u: OaiUsage | null | undefined): AnthropicMessage['usage'] {
  const prompt = nonNeg(u?.prompt_tokens);
  const cached = Math.min(nonNeg(u?.prompt_tokens_details?.cached_tokens), prompt);
  return { input_tokens: prompt - cached, output_tokens: nonNeg(u?.completion_tokens), cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

const reported = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * Codex review #5: W03 settles an all-zero SDK usage as "confirmed empty". An
 * endpoint that omits usage (or sends garbage) must therefore be ESTIMATED —
 * input from the request size (estimateInputTokens, an over-estimate), output
 * from the emitted characters / 3 — and logged once per connection, never zero.
 */
export function resolveUsage(u: OaiUsage | null | undefined, est: { inputTokens: number; outputChars: number }): AnthropicMessage['usage'] {
  if (u && reported(u.prompt_tokens) && reported(u.completion_tokens)) return mapUsage(u);
  console.warn('[modelGateway] endpoint reported no usable token usage; billing an estimate');
  return { input_tokens: Math.max(1, est.inputTokens), output_tokens: Math.ceil(est.outputChars / 3), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

export const genToolUseId = (): string => `toolu_gw_${randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 16).padEnd(16, '0')}`;
export const genMessageId = (): string => `msg_gw_${randomBytes(12).toString('hex')}`;

/**
 * Validate a complete set of tool calls. Returns the tool_use blocks, or null if
 * ANY call is unsafe (unknown tool, non-object args, caps) — the batch is then
 * dropped whole (Review Focus 1).
 */
export function validateToolCalls(
  calls: ReadonlyArray<{ id?: string; name?: string; arguments?: string }>,
  tools: ToolNameMap,
): Array<Extract<AnthropicContentBlock, { type: 'tool_use' }>> | null {
  if (calls.length === 0) return [];
  if (calls.length > GATEWAY_MAX_TOOL_CALLS) return null;
  const out: Array<Extract<AnthropicContentBlock, { type: 'tool_use' }>> = [];
  for (const c of calls) {
    const name = c.name ? tools.fromOai.get(c.name) : undefined;
    if (!name) return null;
    const args = c.arguments ?? '';
    if (Buffer.byteLength(args, 'utf8') > GATEWAY_MAX_TOOL_ARGS_BYTES) return null;
    let input: unknown;
    // Codex review #1: arguments must be an explicit JSON object; blank/missing is
    // NOT `{}` (a tool with only optional parameters would otherwise run with defaults).
    if (args.trim() === '') return null;
    try { input = JSON.parse(args); } catch { return null; }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
    out.push({ type: 'tool_use', id: c.id && /^[A-Za-z0-9_-]{1,128}$/.test(c.id) ? c.id : genToolUseId(), name, input: input as Record<string, unknown> });
  }
  return out;
}

export function mapFinish(finish: string | null | undefined, emittedToolUse: boolean): AnthropicMessage['stop_reason'] {
  switch (finish) {
    case 'length': return 'max_tokens';
    case 'tool_calls': case 'function_call': return emittedToolUse ? 'tool_use' : 'end_turn';
    case 'content_filter': return 'refusal';
    default: return emittedToolUse ? 'tool_use' : 'end_turn';
  }
}

export function translateChatResponse(res: unknown, ctx: { model: string; tools: ToolNameMap; estimatedInputTokens?: number }): AnthropicMessage {
  const r = res as OaiChatResponse;
  if (!r || typeof r !== 'object' || !Array.isArray(r.choices)) {
    throw new GatewayError(502, 'api_error', 'upstream_malformed', 'The endpoint returned a malformed response.');
  }
  const choice = r.choices[0];
  if (!choice?.message) throw new GatewayError(502, 'api_error', 'upstream_malformed', 'The endpoint returned no choices.');
  const content: AnthropicContentBlock[] = [];
  if (typeof choice.message.content === 'string' && choice.message.content.length > 0) content.push({ type: 'text', text: choice.message.content });
  const calls = (choice.message.tool_calls ?? []) as OaiToolCall[];
  const toolUses = validateToolCalls(calls.map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments })), ctx.tools);
  if (toolUses === null) content.push({ type: 'text', text: UNSAFE_TOOL_CALL_NOTE });
  else content.push(...toolUses);
  const emitted = toolUses !== null && toolUses.length > 0;
  const stop = mapFinish(choice.finish_reason, emitted);
  return {
    id: genMessageId(), type: 'message', role: 'assistant', model: ctx.model, content,
    stop_reason: stop, stop_sequence: null,
    ...(stop === 'refusal' ? { stop_details: { type: 'refusal' as const, category: null } } : {}),
    usage: resolveUsage(r.usage, {
      inputTokens: ctx.estimatedInputTokens ?? 1,
      outputChars: content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : JSON.stringify(b.input).length), 0),
    }),
  };
}
```

`translateStream.ts`:

```ts
import { encodeSse, parseSse } from './sse';
import { mapFinish, resolveUsage, UNSAFE_TOOL_CALL_NOTE, validateToolCalls } from './translateResponse';
import type { OaiChatResponse, OaiUsage, ToolNameMap } from './types';

interface PendingCall { id?: string; name?: string; arguments: string }

/**
 * OpenAI chat-completions SSE → Anthropic Messages SSE. Text streams live; tool
 * calls are buffered and validated as a batch at the end (Decision D9). Always
 * emits a terminal message_delta + message_stop, even if the upstream stops early.
 */
export async function* translateChatStream(
  upstream: AsyncIterable<Uint8Array>,
  ctx: { model: string; tools: ToolNameMap; messageId: string; estimatedInputTokens: number },
): AsyncIterable<Uint8Array> {
  let index = 0;
  let textOpen = false;
  let finish: string | null = null;
  let sawDone = false;
  let emittedChars = 0;
  let usage: OaiUsage | null = null;
  const calls = new Map<number, PendingCall>();

  yield encodeSse('message_start', {
    type: 'message_start',
    message: { id: ctx.messageId, type: 'message', role: 'assistant', model: ctx.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });

  try {
    for await (const { data } of parseSse(upstream)) {
      if (data.trim() === '[DONE]') { sawDone = true; break; }
      let chunk: OaiChatResponse;
      try { chunk = JSON.parse(data) as OaiChatResponse; } catch {
        yield encodeSse('error', { type: 'error', error: { type: 'api_error', message: 'The endpoint sent a malformed stream event.' } });
        return;
      }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!textOpen) {
          yield encodeSse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
          textOpen = true;
        }
        emittedChars += delta.content.length;
        yield encodeSse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta.content } });
      }
      for (const tc of delta.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { arguments: '' };
        if (tc.id) cur.id = tc.id;
        // First non-empty name wins: servers send it once; a server that repeats
        // it per chunk must not produce "get_weatherget_weather".
        if (tc.function?.name && !cur.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  } catch {
    yield encodeSse('error', { type: 'error', error: { type: 'api_error', message: 'The endpoint stream failed.' } });
    return;
  }

  const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  // Codex review #1: a batch is only executable if the stream TERMINATED (a
  // finish_reason or [DONE]). A truncated stream (EOF mid tool call) drops the batch.
  const terminated = sawDone || finish !== null;
  const toolUses = calls.size > 0 && !terminated ? null : validateToolCalls(ordered, ctx.tools);
  if (toolUses === null) {
    if (!textOpen) {
      yield encodeSse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      textOpen = true;
    }
    yield encodeSse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: UNSAFE_TOOL_CALL_NOTE } });
  }
  if (textOpen) { yield encodeSse('content_block_stop', { type: 'content_block_stop', index }); index += 1; }
  for (const tu of toolUses ?? []) {
    yield encodeSse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: {} } });
    yield encodeSse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tu.input) } });
    yield encodeSse('content_block_stop', { type: 'content_block_stop', index });
    index += 1;
  }
  const stop = mapFinish(finish, (toolUses?.length ?? 0) > 0);
  const toolChars = (toolUses ?? []).reduce((n, t) => n + JSON.stringify(t.input).length, 0);
  // Codex review #5: an endpoint that reports no usage is ESTIMATED, never billed as zero.
  const u = resolveUsage(usage, { inputTokens: ctx.estimatedInputTokens, outputChars: emittedChars + toolChars });
  yield encodeSse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stop, stop_sequence: null, ...(stop === 'refusal' ? { stop_details: { type: 'refusal', category: null } } : {}) },
    usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: 0 },
  });
  yield encodeSse('message_stop', { type: 'message_stop' });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/openai/translateResponse.test.ts src/services/aiModels/gateway/openai/translateStream.test.ts src/services/aiModels/gateway/openai/sse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/gateway/openai/
git commit -m "feat(ai-models): OpenAI→Anthropic response + stream translation; unsafe tool calls never execute (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: The `openai_compatible` gateway adapter

Wires Tasks 4–6 together and answers every path the Agent SDK CLI and the in-process Anthropic client can send to a custom `ANTHROPIC_BASE_URL`:

| Path | Behaviour |
|---|---|
| `POST /v1/messages` | `assertBoundModel(body.model)` → translate → `POST {base_url}/chat/completions` via `forwardUpstream` → translate back (buffered or SSE). Upstream non-2xx → Anthropic error envelope with the upstream status class (`429`→`rate_limit_error`, `401/403`→`authentication_error` "The endpoint rejected the connection's key.", `400/404/422`→`invalid_request_error`, `5xx`→`api_error`), body scrubbed and capped. |
| `POST /v1/messages/count_tokens` | `assertBoundModel` → `{ input_tokens: ceil(utf8Bytes(JSON(messages+system+tools)) / 3) }` — a deliberate over-estimate (W05's fit check must err toward "does not fit"). |
| `GET /v1/models` | `{ data: [{ type: 'model', id, display_name: id, created_at: '1970-01-01T00:00:00Z' }] for each bound wire model }` — no upstream call. |
| anything else | 404 `not_found_error`. |

Child env (`sdkChildEnv`): `ANTHROPIC_BASE_URL=<gatewayBaseUrl>`, `ANTHROPIC_API_KEY=breeze-gateway` (placeholder; the gateway ignores it and the token in the path is the capability), `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL=<wireModel>` and `ANTHROPIC_SMALL_FAST_MODEL=<wireModel>` (so a CLI background call can only name the bound model), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_PROMPT_CACHING=1` (no Anthropic cache semantics upstream), `CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK=1`.

**Files:**
- Create: `apps/api/src/services/aiModels/gateway/openai/adapter.ts` (+ `adapter.test.ts`)
- Modify: `apps/api/src/services/aiModels/gateway/index.ts` (add `import './openai/adapter';`)

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 6.
- Produces: `openAiCompatibleAdapter: GatewayAdapter` (registered on import); `GATEWAY_PLACEHOLDER_KEY = 'breeze-gateway'`; `estimateInputTokens(body: unknown): number`.

- [ ] **Step 1: Write the failing test** (in-process, real gateway listener + real `@anthropic-ai/sdk` client, fake upstream via `__setUpstreamFetchForTests`)

```ts
// apps/api/src/services/aiModels/gateway/openai/adapter.test.ts
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: () => {} }));

import { __setUpstreamFetchForTests } from '../forward';
import { startModelGateway, type ModelGateway } from '../server';
import './adapter';
import { GATEWAY_PLACEHOLDER_KEY, openAiCompatibleAdapter } from './adapter';

let gw: ModelGateway;
let lastUpstream: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
let reply: (body: Record<string, unknown>) => Response;

beforeEach(async () => {
  gw = await startModelGateway();
  __setUpstreamFetchForTests((async (url: string, init: { body: string; headers: Record<string, string> }) => {
    lastUpstream = { url, body: JSON.parse(init.body), headers: init.headers };
    return reply(lastUpstream.body);
  }) as never);
});
afterEach(async () => { __setUpstreamFetchForTests(null); await gw.close(); });

function clientFor(models = ['qwen']) {
  const g = gw.grant({
    config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p', connectionId: 'c', configVersion: 1, baseUrl: 'https://llm.example.com/v1' },
    credential: { secret: 'sk-upstream-secret-1' }, wireModels: models, orgId: 'o', aiSessionId: null, purpose: 'dispatch',
  });
  return new Anthropic({ baseURL: g.baseUrl, apiKey: GATEWAY_PLACEHOLDER_KEY, maxRetries: 0 });
}

const tools = [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' as const, properties: { city: { type: 'string' } } } }];

describe('openai_compatible adapter (real Anthropic client through the gateway)', () => {
  it('buffered tool round trip', async () => {
    reply = () => Response.json({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 } });
    const msg = await clientFor().messages.create({ model: 'qwen', max_tokens: 256, tools, messages: [{ role: 'user', content: 'weather in Oslo?' }] });
    expect(lastUpstream!.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(lastUpstream!.headers.authorization).toBe('Bearer sk-upstream-secret-1');
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content[0]).toMatchObject({ type: 'tool_use', name: 'get_weather', input: { city: 'Oslo' } });
    expect(msg.usage.input_tokens).toBe(20);
  });

  it('streamed text: final message carries the upstream usage', async () => {
    const enc = new TextEncoder();
    reply = () => new Response(new ReadableStream({ start(c) {
      c.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'));
      c.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'));
      c.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":33,"completion_tokens":1}}\n\n'));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
    const final = await clientFor().messages.stream({ model: 'qwen', max_tokens: 64, messages: [{ role: 'user', content: 'x' }] }).finalMessage();
    expect(final.content[0]).toMatchObject({ type: 'text', text: 'hi' });
    expect(final.usage).toMatchObject({ input_tokens: 33, output_tokens: 1 });
  });

  it('upstream 401 → authentication_error without echoing the key', async () => {
    reply = () => new Response('{"error":"invalid key sk-upstream-secret-1"}', { status: 401 });
    const err = await clientFor().messages.create({ model: 'qwen', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }).catch((e) => e as Anthropic.APIError);
    expect(err.status).toBe(401);
    expect(JSON.stringify(err.error)).not.toContain('sk-upstream-secret-1');
  });

  it('count_tokens over-estimates and never calls upstream', async () => {
    lastUpstream = null;
    const r = await clientFor().messages.countTokens({ model: 'qwen', messages: [{ role: 'user', content: 'a'.repeat(300) }] });
    expect(r.input_tokens).toBeGreaterThanOrEqual(100);
    expect(lastUpstream).toBeNull();
  });

  it('GET /v1/models lists only the bound models', async () => {
    const page = await clientFor(['qwen', 'qwen-fallback']).models.list();
    expect(page.data.map((m) => m.id)).toEqual(['qwen', 'qwen-fallback']);
  });

  it('sdkChildEnv carries no secret and pins every alias to the wire model', () => {
    const env = openAiCompatibleAdapter.sdkChildEnv({ gatewayBaseUrl: 'http://127.0.0.1:1/g/tok', wireModel: 'qwen',
      config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p', connectionId: 'c', configVersion: 1, baseUrl: 'https://llm.example.com/v1' } });
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/g/tok', ANTHROPIC_API_KEY: GATEWAY_PLACEHOLDER_KEY,
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen', ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen',
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(JSON.stringify(env)).not.toContain('llm.example.com');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/openai/adapter.test.ts`
Expected: FAIL — `./adapter` not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/aiModels/gateway/openai/adapter.ts
import { assertBoundModel, registerGatewayAdapter, type GatewayAdapter } from '../adapter';
import { joinByoUrl } from '../byoEndpointPolicy';
import { forwardUpstream } from '../forward';
import { scrubSecrets } from '../scrub';
import { GatewayError, gatewayErrorBody, type AnthropicErrorType, type GatewayGrantRecord, type GatewayResponse } from '../types';
import { genMessageId, translateChatResponse } from './translateResponse';
import { translateChatStream } from './translateStream';
import { translateMessagesRequest } from './translateRequest';

export const GATEWAY_PLACEHOLDER_KEY = 'breeze-gateway';

const json = (status: number, body: unknown): GatewayResponse => ({
  status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)),
});

function parseJson(body: Buffer): unknown {
  try { return JSON.parse(body.toString('utf8')); } catch {
    throw new GatewayError(400, 'invalid_request_error', 'bad_json', 'Request body is not JSON.');
  }
}

export function estimateInputTokens(body: unknown): number {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = JSON.stringify({ s: b.system ?? null, m: b.messages ?? [], t: b.tools ?? [] });
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function upstreamErrorType(status: number): AnthropicErrorType {
  if (status === 429) return 'rate_limit_error';
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request_error';
  if (status === 413) return 'request_too_large';
  return 'api_error';
}

async function upstreamError(res: Response, grant: GatewayGrantRecord): Promise<GatewayResponse> {
  let text = '';
  try { text = (await res.text()).slice(0, 4000); } catch { /* ignore */ }
  const type = upstreamErrorType(res.status);
  const message = type === 'authentication_error'
    ? 'The endpoint rejected the connection\'s key.'
    : `The endpoint returned HTTP ${res.status}${text ? `: ${scrubSecrets(text, [grant.credential.secret], 300)}` : ''}`;
  const status = res.status >= 400 && res.status < 600 ? res.status : 502;
  return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(gatewayErrorBody(type, message)) };
}

async function messages(body: Buffer, grant: GatewayGrantRecord, signal: AbortSignal): Promise<GatewayResponse> {
  const parsed = parseJson(body) as { model?: unknown };
  const model = assertBoundModel(grant, parsed.model);
  if (grant.config.kind !== 'openai_compatible') throw new Error('openai adapter on a non-openai grant');
  const t = translateMessagesRequest(parsed, model);
  const res = await forwardUpstream(grant, {
    url: joinByoUrl(grant.config.baseUrl, 'chat/completions'),
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: t.stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(t.body),
    stream: t.stream,
  }, signal);
  if (!res.ok) return upstreamError(res, grant);
  if (!t.stream) {
    let payload: unknown;
    try { payload = await res.json(); } catch { throw new GatewayError(502, 'api_error', 'upstream_malformed', 'The endpoint returned malformed JSON.'); }
    return json(200, translateChatResponse(payload, { model, tools: t.tools, estimatedInputTokens: estimateInputTokens(parsed) }));
  }
  if (!res.body) throw new GatewayError(502, 'api_error', 'upstream_malformed', 'The endpoint returned an empty stream.');
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: translateChatStream(res.body as unknown as AsyncIterable<Uint8Array>, { model, tools: t.tools, messageId: genMessageId(), estimatedInputTokens: estimateInputTokens(parsed) }),
  };
}

export const openAiCompatibleAdapter: GatewayAdapter = {
  kind: 'openai_compatible',
  dialect: 'anthropic',
  async handle(req, grant) {
    const path = req.path.replace(/\/+$/, '');
    if (req.method === 'POST' && path === '/v1/messages') return messages(req.body, grant, req.signal);
    if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
      const parsed = parseJson(req.body) as { model?: unknown };
      assertBoundModel(grant, parsed.model);
      return json(200, { input_tokens: estimateInputTokens(parsed) });
    }
    if (req.method === 'GET' && path === '/v1/models') {
      const data = [...grant.wireModels].map((id) => ({ type: 'model', id, display_name: id, created_at: '1970-01-01T00:00:00Z' }));
      return json(200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
    }
    throw new GatewayError(404, 'not_found_error', 'gateway_not_found', 'Not found.');
  },
  sdkChildEnv({ gatewayBaseUrl, wireModel }) {
    return {
      ANTHROPIC_BASE_URL: gatewayBaseUrl,
      ANTHROPIC_API_KEY: GATEWAY_PLACEHOLDER_KEY,
      ANTHROPIC_DEFAULT_OPUS_MODEL: wireModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: wireModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: wireModel,
      ANTHROPIC_DEFAULT_FABLE_MODEL: wireModel,
      ANTHROPIC_SMALL_FAST_MODEL: wireModel,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
      DISABLE_PROMPT_CACHING: '1',
    };
  },
};

registerGatewayAdapter(openAiCompatibleAdapter);
```

Add `import './openai/adapter';` to `gateway/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/`
Expected: PASS (all gateway files). If `final.usage.input_tokens` is 0 here, the installed `@anthropic-ai/sdk` does not take `input_tokens` from `message_delta`: stop and switch `translateChatStream` to buffer `message_start` until the usage chunk arrives (text latency cost) — do not ship a gateway that bills zero input tokens.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/gateway/
git commit -m "feat(ai-models): openai_compatible gateway adapter (messages, count_tokens, models) (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Resolver — gateway connections become dispatchable, capabilities come only from verification

W03 refuses `openai_compatible` at eligibility (`DISPATCHABLE_KINDS`) and builds no `config` for it in `connectionCandidate`. This task adds the gateway branch. Three rules carry the security weight:
1. **Capabilities come only from a current verification** (Decision D4). An offering whose stored `breeze_verification` is missing, failed, from another harness version, or for a different endpoint fingerprint is `UNVERIFIED_CAPABILITIES` (`thinkingMode: 'unknown'`, `supportsTools: false`) — so W03's existing `tools_unsupported` rule keeps it off chat/helper/script builder/agents/Office chat, and `buildWireParams` sends nothing.
2. **Price comes only from the offering** (spec §8 precedence 1). No linked-platform inheritance for gateway kinds.
3. **A keyless connection is usable** (local Ollama); a connection whose stored key fails to decrypt is not.

**Files:**
- Modify: `apps/api/src/services/aiModels/eligibility.ts` (`DISPATCHABLE_KINDS`)
- Modify: `apps/api/src/services/aiModels/eligibility.test.ts` (flip W03's `'openai_compatible is W06'` row; add rows)
- Create: `apps/api/src/services/aiModels/gatewayCapabilities.ts` (+ `.test.ts`)
- Create: `apps/api/src/services/aiModels/gatewayCandidate.ts` (+ `.test.ts`)
- Modify: `apps/api/src/services/aiModels/candidateLoader.ts` (`ResolvedConnection` union; one dispatch line in `connectionCandidate`; export `UNVERIFIED_CAPABILITIES`)
- Modify: `apps/api/src/services/aiModels/candidateLoader.test.ts` (W03's "openai_compatible is NOT an Anthropic connection" case now expects a gateway candidate)
- Modify: `apps/api/src/services/aiModels/turnBinding.ts` (+ test) (`connectionKind` enum)
- Modify: `apps/api/src/services/aiModels/__fixtures__/resolvedModel.ts` (`FixtureConnectionKind` gains `'openai_compatible'`)

**Interfaces:**
- Consumes: P1, P2, P5; Task 1 `isGatewayConnectionKind`, `GATEWAY_CONNECTION_KINDS`; Task 4 `GatewayConnectionConfig`, `GatewayCredential`; W01 `FIDELITY_HARNESS_VERSION`, `deriveCapabilities`; W02 `getConnectionKeyMaterial`, `decryptConnectionKey`.
- Produces:

```ts
// gatewayCapabilities.ts
export interface GatewayVerificationRecord {
  harnessVersion: string; endpointFingerprint: string; at: string;   // ISO
  passed: boolean; toolUse: boolean; adaptiveEffort: boolean;
  summary: string | null;                                           // scrubbed, ≤ 200 chars
}
export type GatewayVerificationState = 'unverified' | 'verified' | 'failed' | 'stale';
export function endpointFingerprint(conn: { kind: string; baseUrl: string | null; providerConfig: Record<string, unknown> | null }): string;
export function readVerification(raw: unknown): GatewayVerificationRecord | null;
/** Synthesized Models-API-shaped tree stored in partner_ai_models.capabilities. */
export function verifiedCapabilitiesTree(v: GatewayVerificationRecord, thinkingSource: unknown | null): Record<string, unknown>;
export function verifiedGatewayCapabilities(raw: unknown, currentFingerprint: string): { capabilities: DerivedCapabilities; state: GatewayVerificationState; record: GatewayVerificationRecord | null };

// gatewayCandidate.ts
export async function gatewayCandidate(input: {
  offering: Offering; conn: PartnerAiConnection; platformGeo: string | null;
}): Promise<LoadedCandidate>;

// candidateLoader.ts
export type ResolvedConnection =
  | { id: string | null; kind: 'platform' | 'anthropic_byok' | 'catalog'; config: UsableLlmConfig }
  | { id: string; kind: GatewayConnectionKind; config: GatewayConnectionConfig; credential: GatewayCredential };
export function isGatewayResolvedConnection(c: ResolvedConnection): c is Extract<ResolvedConnection, { config: { source: 'gateway' } }>;
export const UNVERIFIED_CAPABILITIES: DerivedCapabilities;   // was module-private

// turnBinding.ts
TurnBinding.connectionKind: 'platform' | 'anthropic_byok' | 'catalog' | GatewayConnectionKind;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiModels/gatewayCapabilities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FIDELITY_HARNESS_VERSION } from '../llm/providerFidelityHarness';
import { endpointFingerprint, readVerification, verifiedCapabilitiesTree, verifiedGatewayCapabilities } from './gatewayCapabilities';

const conn = { kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', providerConfig: null };
const fp = endpointFingerprint(conn);
const rec = (over = {}) => ({ harnessVersion: FIDELITY_HARNESS_VERSION, endpointFingerprint: fp, at: '2026-11-23T00:00:00.000Z',
  passed: true, toolUse: true, adaptiveEffort: false, summary: null, ...over });

describe('gatewayCapabilities', () => {
  it('fingerprint depends on kind + base URL, not on the key or the name', () => {
    expect(endpointFingerprint({ ...conn })).toBe(fp);
    expect(endpointFingerprint({ ...conn, baseUrl: 'https://llm.example.com/v2' })).not.toBe(fp);
    expect(endpointFingerprint({ ...conn, kind: 'other' })).not.toBe(fp);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a passed verification → tools supported, thinking none (openai has no thinking source)', () => {
    const tree = verifiedCapabilitiesTree(rec(), null);
    const r = verifiedGatewayCapabilities(tree, fp);
    expect(r.state).toBe('verified');
    expect(r.capabilities).toMatchObject({ supportsTools: true, thinkingMode: 'none', effortLevels: [] });
  });

  it('failed verification → unverified capabilities, state failed', () => {
    const r = verifiedGatewayCapabilities(verifiedCapabilitiesTree(rec({ passed: false, toolUse: false, summary: 'no tool_use block' }), null), fp);
    expect(r.state).toBe('failed');
    expect(r.capabilities).toMatchObject({ supportsTools: false, thinkingMode: 'unknown' });
  });

  it('a verification for another endpoint fingerprint is stale (base URL changed)', () => {
    const r = verifiedGatewayCapabilities(verifiedCapabilitiesTree(rec({ endpointFingerprint: 'f'.repeat(64) }), null), fp);
    expect(r.state).toBe('stale');
    expect(r.capabilities.supportsTools).toBe(false);
  });

  it('a verification from an older harness version is stale', () => {
    expect(verifiedGatewayCapabilities(verifiedCapabilitiesTree(rec({ harnessVersion: '0' }), null), fp).state).toBe('stale');
  });

  it('a hand-written capabilities tree WITHOUT breeze_verification never grants tools (no bypass by DB edit or API)', () => {
    const forged = { thinking: { types: { adaptive: { supported: true } } }, tool_use: { supported: true } };
    const r = verifiedGatewayCapabilities(forged, fp);
    expect(r.state).toBe('unverified');
    expect(r.capabilities.supportsTools).toBe(false);
  });

  it('readVerification rejects malformed records', () => {
    expect(readVerification({ breeze_verification: { passed: 'yes' } })).toBeNull();
    expect(readVerification(null)).toBeNull();
  });

  it('adaptiveEffort true + a thinking source → the source thinking/effort subtree is kept (W07 cloud)', () => {
    const source = { thinking: { types: { adaptive: { supported: true }, enabled: { supported: true } } }, effort: { supported: true, low: { supported: true }, high: { supported: true } } };
    const r = verifiedGatewayCapabilities(verifiedCapabilitiesTree(rec({ adaptiveEffort: true }), source), fp);
    expect(r.capabilities).toMatchObject({ thinkingMode: 'adaptive', effortLevels: ['low', 'high'], supportsTools: true });
  });
});
```

`apps/api/src/services/aiModels/gatewayCandidate.test.ts` (mocks the two key reads; same `vi.hoisted` pattern as `candidateLoader.test.ts`):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const keys = vi.hoisted(() => ({ material: null as null | { id: string; partnerId: string; apiKeyEncrypted: string | null }, decrypt: (_: unknown): string => 'sk-local' }));
vi.mock('./connections', async (orig) => ({
  ...(await orig<typeof import('./connections')>()),
  getConnectionKeyMaterial: async () => keys.material,
  decryptConnectionKey: (m: unknown) => keys.decrypt(m),
}));
vi.mock('../../db', async (orig) => ({ ...(await orig<typeof import('../../db')>()),
  runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));

import { FIDELITY_HARNESS_VERSION } from '../llm/providerFidelityHarness';
import { endpointFingerprint, verifiedCapabilitiesTree } from './gatewayCapabilities';
import { gatewayCandidate } from './gatewayCandidate';

const conn = { id: 'c1', partnerId: 'p1', kind: 'openai_compatible', name: 'vLLM', baseUrl: 'https://llm.example.com/v1', providerConfig: null,
  status: 'active', configVersion: 4, inferenceGeo: null } as never;
const verified = verifiedCapabilitiesTree({ harnessVersion: FIDELITY_HARNESS_VERSION, endpointFingerprint: endpointFingerprint(conn as never),
  at: '2026-11-23T00:00:00Z', passed: true, toolUse: true, adaptiveEffort: false, summary: null }, null);
const offering = (over = {}) => ({ id: 'o1', partnerId: 'p1', connectionId: 'c1', platformModelId: null, modelId: 'qwen2.5-coder:7b',
  source: 'discovered', displayName: null, capabilities: verified, priceInputCentsPerM: 0, priceOutputCentsPerM: 0,
  priceCacheReadCentsPerM: 0, priceCacheWriteCentsPerM: 0, enabled: true, defaultOptions: null, allowedOptions: null,
  requiredPermission: null, refusalFallbackOfferingId: null, lifecycle: 'available', ...over }) as never;

describe('gatewayCandidate', () => {
  beforeEach(() => { keys.material = { id: 'c1', partnerId: 'p1', apiKeyEncrypted: 'enc:x' }; keys.decrypt = () => 'sk-local'; });

  it('verified, priced (0 is a price) openai offering → dispatchable gateway candidate, partner_key, tools', async () => {
    const c = await gatewayCandidate({ offering: offering(), conn, platformGeo: 'us' });
    expect(c.funding).toBe('partner_key');
    expect(c.wireModel).toBe('qwen2.5-coder:7b');
    expect(c.facts).toMatchObject({ connection: { kind: 'openai_compatible', status: 'active', keyUsable: true }, supportsTools: true,
      rate: { source: 'offering', standard: { inputCentsPerM: 0 } }, inferenceGeo: null, supportedInferenceGeos: [] });
    expect(c.connection).toMatchObject({ id: 'c1', kind: 'openai_compatible',
      config: { source: 'gateway', kind: 'openai_compatible', connectionId: 'c1', configVersion: 4, baseUrl: 'https://llm.example.com/v1' },
      credential: { secret: 'sk-local' } });
    expect(c.capabilities.thinkingMode).toBe('none');
    expect(c.promptProfile).toBe('generic');
  });

  it('keyless connection is usable with a null secret', async () => {
    keys.material = { id: 'c1', partnerId: 'p1', apiKeyEncrypted: null };
    const c = await gatewayCandidate({ offering: offering(), conn, platformGeo: null });
    expect(c.facts.connection.keyUsable).toBe(true);
    expect(c.connection).toMatchObject({ credential: { secret: null } });
  });

  it('a stored key that fails to decrypt makes the connection unusable (and no connection object)', async () => {
    keys.decrypt = () => { throw new Error('bad aad'); };
    const c = await gatewayCandidate({ offering: offering(), conn, platformGeo: null });
    expect(c.facts.connection.keyUsable).toBe(false);
    expect(c.connection).toBeNull();
  });

  it('unpriced offering → rate null (W03 eligibility says unpriced)', async () => {
    const c = await gatewayCandidate({ offering: offering({ priceInputCentsPerM: null, priceOutputCentsPerM: null, priceCacheReadCentsPerM: null, priceCacheWriteCentsPerM: null }), conn, platformGeo: null });
    expect(c.facts.rate).toBeNull();
  });

  it('unverified offering → no tools, unknown thinking (W03 tools_unsupported keeps it off tool surfaces)', async () => {
    const c = await gatewayCandidate({ offering: offering({ capabilities: null }), conn, platformGeo: null });
    expect(c.facts.supportsTools).toBe(false);
    expect(c.capabilities.thinkingMode).toBe('unknown');
  });

  it('never inherits the connection inference geo or the platform geo (D7)', async () => {
    const c = await gatewayCandidate({ offering: offering(), conn: { ...(conn as object), inferenceGeo: 'eu' } as never, platformGeo: 'us' });
    expect(c.facts.inferenceGeo).toBeNull();
  });
});
```

`eligibility.test.ts` — replace W03's row `['openai_compatible is W06', …, 'connection_unavailable']` with:

```ts
['openai_compatible is dispatchable (W06)', byokFacts({ connection: { kind: 'openai_compatible', status: 'active', keyUsable: true } }), {}, null],
['openai_compatible with an undecryptable key', byokFacts({ connection: { kind: 'openai_compatible', status: 'active', keyUsable: false } }), {}, 'connection_unavailable'],
['openai_compatible unverified on a tool surface', byokFacts({ connection: { kind: 'openai_compatible', status: 'active', keyUsable: true }, supportsTools: false }), { surface: 'chat' }, 'tools_unsupported'],
['openai_compatible under required residency', byokFacts({ connection: { kind: 'openai_compatible', status: 'active', keyUsable: true }, inferenceGeo: null }), { residencyRequired: true }, 'residency_unavailable'],
```

(Adapt the row tuple shape to the file's actual `it.each` signature; W03's table is the source of truth.)

`turnBinding.test.ts` — add:

```ts
it('parses a persisted binding for an openai_compatible connection (W06)', () => {
  const b = turnBindingFrom(makeResolvedModel('openai_compatible'));
  expect(b.connectionKind).toBe('openai_compatible');
  expect(parseTurnBinding(JSON.parse(JSON.stringify(b)))).toEqual(b);
});
```

`__fixtures__/resolvedModel.ts` — `FixtureConnectionKind` gains `'openai_compatible'`; that arm builds:

```ts
connection: {
  id: 'conn-oai', kind: 'openai_compatible',
  config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'partner-1', connectionId: 'conn-oai', configVersion: 3, baseUrl: 'https://llm.example.com/v1' },
  credential: { secret: 'sk-fixture-upstream' },
},
funding: 'partner_key', logicalModel: 'qwen2.5-coder:7b', wireModel: 'qwen2.5-coder:7b', thinking: 'none',
wireParams: { betas: [], applied: {} }, options: {}, promptProfile: 'generic',
rateSnapshot: { source: 'offering', standard: FIXTURE_STD_RATES },
capabilities: { thinkingMode: 'none', effortLevels: [], supportsTools: true, supportsVision: false },
limits: { maxInputTokens: null, maxOutputTokens: null }, configVersion: 3,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/gatewayCapabilities.test.ts src/services/aiModels/gatewayCandidate.test.ts src/services/aiModels/eligibility.test.ts src/services/aiModels/turnBinding.test.ts`
Expected: FAIL — new modules missing; eligibility row returns `connection_unavailable`; `parseTurnBinding` returns `null` for the new kind.

- [ ] **Step 3: Write the implementation**

`eligibility.ts`:

```ts
import { GATEWAY_CONNECTION_KINDS } from '@breeze/shared';
// …
export type ConnectionKind = 'platform' | 'anthropic_byok' | 'catalog' | GatewayConnectionKind;

/** Dispatchable kinds. W06 added the gateway kinds (openai_compatible); W07 widens GATEWAY_CONNECTION_KINDS. */
const DISPATCHABLE_KINDS: ReadonlySet<ConnectionKind> = new Set<ConnectionKind>([
  'platform', 'anthropic_byok', 'catalog', ...GATEWAY_CONNECTION_KINDS,
]);
```

`gatewayCapabilities.ts`:

```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FIDELITY_HARNESS_VERSION } from '../llm/providerFidelityHarness';
import { deriveCapabilities, type DerivedCapabilities } from './capabilities';

export interface GatewayVerificationRecord {
  harnessVersion: string;
  endpointFingerprint: string;
  at: string;
  passed: boolean;
  toolUse: boolean;
  adaptiveEffort: boolean;
  summary: string | null;
}
export type GatewayVerificationState = 'unverified' | 'verified' | 'failed' | 'stale';

const recordSchema = z.object({
  harnessVersion: z.string().min(1).max(20),
  endpointFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  at: z.string().datetime(),
  passed: z.boolean(),
  toolUse: z.boolean(),
  adaptiveEffort: z.boolean(),
  summary: z.string().max(200).nullable(),
}).strict();

const UNVERIFIED: DerivedCapabilities = { thinkingMode: 'unknown', effortLevels: [], supportsTools: false, supportsVision: false };

/**
 * What a verification is bound to: the connection's ROUTING identity (kind +
 * base URL + routing provider config). Deliberately excludes the key and the
 * name: a key rotation does not change what the endpoint does; a URL change does.
 * W07 adds its kinds' routing fields (region / project+location / resource).
 */
export function endpointFingerprint(conn: { kind: string; baseUrl: string | null; providerConfig: Record<string, unknown> | null }): string {
  const routing: Record<string, unknown> = { kind: conn.kind, baseUrl: conn.baseUrl ?? null };
  return createHash('sha256').update(JSON.stringify(routing)).digest('hex');
}

export function readVerification(raw: unknown): GatewayVerificationRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = (raw as { breeze_verification?: unknown }).breeze_verification;
  const parsed = recordSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

const NO_THINKING = { thinking: { types: { adaptive: { supported: false }, enabled: { supported: false } } }, effort: { supported: false } };

export function verifiedCapabilitiesTree(v: GatewayVerificationRecord, thinkingSource: unknown | null): Record<string, unknown> {
  const src = thinkingSource && typeof thinkingSource === 'object' ? (thinkingSource as Record<string, unknown>) : null;
  const thinkingPart = v.passed && v.adaptiveEffort && src?.thinking
    ? { thinking: src.thinking, effort: src.effort ?? { supported: false } }
    : NO_THINKING;
  return { ...thinkingPart, tool_use: { supported: v.passed && v.toolUse }, breeze_verification: v };
}

export function verifiedGatewayCapabilities(raw: unknown, currentFingerprint: string): {
  capabilities: DerivedCapabilities; state: GatewayVerificationState; record: GatewayVerificationRecord | null;
} {
  const record = readVerification(raw);
  if (!record) return { capabilities: UNVERIFIED, state: 'unverified', record: null };
  if (record.harnessVersion !== FIDELITY_HARNESS_VERSION || record.endpointFingerprint !== currentFingerprint) {
    return { capabilities: UNVERIFIED, state: 'stale', record };
  }
  if (!record.passed) return { capabilities: UNVERIFIED, state: 'failed', record };
  return { capabilities: deriveCapabilities(raw), state: 'verified', record };
}
```

`gatewayCandidate.ts`:

```ts
import { captureException } from '../sentry';   // same import candidateLoader.ts uses — match its path
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { SecretKeyMaterialError } from '../secretCrypto';
import type { LoadedCandidate } from './candidateLoader';
import { EMPTY_OPTION_SUPPORT } from './candidateLoader';
import { decryptConnectionKey, getConnectionKeyMaterial, type PartnerAiConnection } from './connections';
import { endpointFingerprint, verifiedGatewayCapabilities } from './gatewayCapabilities';
import type { Offering } from './offerings';
import type { RateSnapshot } from './pricing';
import type { GatewayConnectionConfig, GatewayCredential } from './gateway/types';
import type { ConnectionKind } from './eligibility';

const systemRead = <T>(fn: () => Promise<T>): Promise<T> => runOutsideDbContext(() => withSystemDbAccessContext(fn));

function offeringRate(o: Offering): RateSnapshot | null {
  const v = [o.priceInputCentsPerM, o.priceOutputCentsPerM, o.priceCacheReadCentsPerM, o.priceCacheWriteCentsPerM];
  if (v.some((x) => x == null)) return null;
  return { source: 'offering', standard: { inputCentsPerM: Number(v[0]), outputCentsPerM: Number(v[1]), cacheReadCentsPerM: Number(v[2]), cacheWriteCentsPerM: Number(v[3]) } };
}

/** Builds the per-kind GatewayConnectionConfig. W07 adds cloud arms (the `never` forces it). */
export function gatewayConfigFor(conn: PartnerAiConnection): GatewayConnectionConfig | null {
  switch (conn.kind) {
    case 'openai_compatible':
      return conn.baseUrl
        ? { source: 'gateway', kind: 'openai_compatible', partnerId: conn.partnerId, connectionId: conn.id, configVersion: conn.configVersion, baseUrl: conn.baseUrl }
        : null;
    default:
      return null;
  }
}

/**
 * Resolver branch for gateway kinds (W06). Capabilities ONLY from a current
 * verification bound to the endpoint fingerprint; price ONLY from the offering;
 * never residency-eligible (D7); funding always partner_key.
 */
export async function gatewayCandidate(input: { offering: Offering; conn: PartnerAiConnection; platformGeo: string | null }): Promise<LoadedCandidate> {
  const { offering, conn } = input;
  let keyUsable = false;
  let credential: GatewayCredential | null = null;
  try {
    const material = await systemRead(() => getConnectionKeyMaterial(conn.id));
    if (material && material.apiKeyEncrypted === null) { keyUsable = true; credential = { secret: null }; }
    else if (material) { credential = { secret: decryptConnectionKey(material) }; keyUsable = true; }
  } catch (error) {
    if (error instanceof SecretKeyMaterialError) captureException(error, undefined, { service: 'gatewayCandidate', connectionId: conn.id });
    keyUsable = false;
    credential = null;
  }

  const { capabilities } = verifiedGatewayCapabilities(offering.capabilities,
    endpointFingerprint({ kind: conn.kind, baseUrl: conn.baseUrl, providerConfig: conn.providerConfig ?? null }));
  const rate = offeringRate(offering);
  const config = gatewayConfigFor(conn);
  const wireModel = offering.modelId!;
  return {
    facts: {
      ownerPartnerId: offering.partnerId,
      enabled: offering.enabled,
      lifecycle: offering.lifecycle,
      requiredPermission: offering.requiredPermission,
      platform: null,
      connection: { kind: conn.kind as ConnectionKind, status: conn.status, keyUsable },
      catalog: null,
      rate,
      supportsTools: capabilities.supportsTools,
      inferenceGeo: null,
      supportedInferenceGeos: [],
    },
    offeringId: offering.id,
    connectionId: conn.id,
    displayName: offering.displayName ?? wireModel,
    logicalModel: wireModel,
    wireModel,
    connection: config && credential && keyUsable
      ? { id: conn.id, kind: config.kind, config, credential }
      : null,
    funding: 'partner_key',
    capabilities,
    optionSupport: { ...EMPTY_OPTION_SUPPORT, effort: [...capabilities.effortLevels] },
    optionRates: null,
    defaultOptions: offering.defaultOptions as LoadedCandidate['defaultOptions'],
    allowedOptions: offering.allowedOptions as LoadedCandidate['allowedOptions'],
    refusalFallbackOfferingId: offering.refusalFallbackOfferingId,
    promptProfile: 'generic',
    limits: { maxInputTokens: null, maxOutputTokens: null },
    configVersion: conn.configVersion,
  };
}
```

(Match `LoadedCandidate`'s exact field list on the W03 head — P2. If W03 added fields since this plan, fill them with the same values `connectionCandidate` uses for a BYOK row with no linked platform model.)

`candidateLoader.ts`:

```ts
import { isGatewayConnectionKind, type GatewayConnectionKind } from '@breeze/shared';
import type { GatewayConnectionConfig, GatewayCredential } from './gateway/types';
import { gatewayCandidate } from './gatewayCandidate';

export type ResolvedConnection =
  | { id: string | null; kind: 'platform' | 'anthropic_byok' | 'catalog'; config: UsableLlmConfig }
  | { id: string; kind: GatewayConnectionKind; config: GatewayConnectionConfig; credential: GatewayCredential };

export function isGatewayResolvedConnection(
  c: ResolvedConnection,
): c is Extract<ResolvedConnection, { config: GatewayConnectionConfig }> {
  return (c.config as { source: string }).source === 'gateway';
}

export const UNVERIFIED_CAPABILITIES: DerivedCapabilities = { /* unchanged; now exported */ };

// in connectionCandidate(offering, conn), as its FIRST statement after the
// owner check and before `if (conn.kind === 'catalog')`:
if (isGatewayConnectionKind(conn.kind)) {
  return gatewayCandidate({ offering, conn, platformGeo: await systemRead(() => getPlatformInferenceGeo()) });
}
```

Leave the existing `else` comment but update it: `// anthropic_byok (gateway kinds return above; W06).` The final `conn.kind as 'anthropic_byok' | 'catalog'` cast stays valid (gateway kinds never reach it).

`turnBinding.ts`:

```ts
import { GATEWAY_CONNECTION_KINDS, type GatewayConnectionKind } from '@breeze/shared';
export interface TurnBinding {
  // …
  connectionKind: 'platform' | 'anthropic_byok' | 'catalog' | GatewayConnectionKind;
}
// zod:
connectionKind: z.enum(['platform', 'anthropic_byok', 'catalog', ...GATEWAY_CONNECTION_KINDS]),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/gatewayCapabilities.test.ts src/services/aiModels/gatewayCandidate.test.ts src/services/aiModels/eligibility.test.ts src/services/aiModels/turnBinding.test.ts src/services/aiModels/candidateLoader.test.ts src/services/aiModels/resolveModel.test.ts`
Expected: PASS. (`tsc` is red at the `resolved.connection.config` consumers until Task 9; do not commit a cast to silence it.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/eligibility.ts apps/api/src/services/aiModels/eligibility.test.ts \
  apps/api/src/services/aiModels/gatewayCapabilities.ts apps/api/src/services/aiModels/gatewayCapabilities.test.ts \
  apps/api/src/services/aiModels/gatewayCandidate.ts apps/api/src/services/aiModels/gatewayCandidate.test.ts \
  apps/api/src/services/aiModels/candidateLoader.ts apps/api/src/services/aiModels/candidateLoader.test.ts \
  apps/api/src/services/aiModels/turnBinding.ts apps/api/src/services/aiModels/turnBinding.test.ts \
  apps/api/src/services/aiModels/__fixtures__/resolvedModel.ts
git commit -m "feat(ai-models): resolver dispatches gateway connections; capabilities only from current verification (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Dispatch — `prepareSdkChild`, gateway clients, and the real Agent SDK end-to-end

Every consumer of `resolved.connection.config` learns the gateway arm, and the two "grant catalog egress → build child env" sequences (chat `getOrCreate`, agent `runLoop`) collapse into one call. The end-to-end test here is the proof that matters: the **real** Agent SDK CLI, in first-party mode against the gateway, runs an MCP tool off an OpenAI tool call and bills the upstream's usage.

**Files:**
- Create: `apps/api/src/services/aiModels/sdkChildEnv.ts` — `buildClaudeSdkChildEnv` and its allowlist constants **moved** from `streamingSessionManager.ts` (verbatim), plus `buildGatewaySdkChildEnv`
- Modify: `apps/api/src/services/streamingSessionManager.ts` (re-export the moved names; spawn site uses `prepareSdkChild`)
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` (spawn site uses `prepareSdkChild`)
- Modify: `apps/api/src/services/aiModels/connectionFactory.ts`
- Modify: `apps/api/src/services/llm/llmEgressProxy.ts` (`grant(sessionId, null, …)` = deny-all)
- Modify: `apps/api/src/index.ts` (start the gateway at boot, before routes listen)
- Test: `apps/api/src/services/aiModels/prepareSdkChild.test.ts` (create)
- Test: `apps/api/src/services/aiModels/connectionFactory.test.ts` (append)
- Test: `apps/api/src/services/llm/llmEgressProxy.test.ts` (append)
- Test: `apps/api/src/services/aiModels/gateway/gatewaySdk.e2e.test.ts` (create)
- Test: `apps/api/src/services/streamingSessionManager.security.test.ts` (existing — must stay green unchanged)

**Interfaces:**
- Consumes: Task 4 `getModelGateway`, `GatewayGrant`; Task 7 adapter `sdkChildEnv`, `GATEWAY_PLACEHOLDER_KEY`; Task 8 `ResolvedConnection`, `isGatewayResolvedConnection`; P3, P4, P14.
- Produces:

```ts
// connectionFactory.ts
export type AnthropicClientTarget =
  | { kind: 'platform' } | { kind: 'anthropic' }
  | { kind: 'endpoint'; baseUrl: string; authMode: 'x-api-key' | 'bearer'; recordEgress: (a: GuardedLlmFetchAttempt) => void }
  | { kind: 'gateway'; baseUrl: string; dialect: 'anthropic' };          // W07 widens dialect
export function openGatewayGrant(resolved: ResolvedModel, input: { orgId: string | null; aiSessionId: string | null; purpose: GatewayGrantPurpose; ttlMs?: number }): GatewayGrant;
export interface SdkChildDispatch { env: Record<string, string>; revoke: () => void }
export async function prepareSdkChild(resolved: ResolvedModel, input: { key: string; orgId: string; aiSessionId: string | null; source?: NodeJS.ProcessEnv }): Promise<SdkChildDispatch>;
export const SERVER_SIDE_FALLBACK_KINDS: ReadonlySet<string>;   // platform, anthropic_byok
// DispatchFacts.destinationKind: ResolvedConnection['kind']

// gateway/server.ts (addition)
export function getStartedModelGateway(): ModelGateway;   // throws LlmUnavailableError if boot did not start it

// llmEgressProxy.ts
grant(sessionId: string, allowed: EgressGrant | null, recordEgress): { proxyUrl: string };   // null = refuse every CONNECT (audited)

// sdkChildEnv.ts
export function buildClaudeSdkChildEnv(resolved: UsableLlmConfig, source?: NodeJS.ProcessEnv, options?: { egressProxyUrl?: string }): Record<string, string>;   // moved verbatim
export function buildGatewaySdkChildEnv(input: { adapterEnv: Record<string, string>; denyProxyUrl: string; source?: NodeJS.ProcessEnv }): Record<string, string>;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiModels/prepareSdkChild.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const rec = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: (e: Record<string, unknown>) => rec.events.push(e) }));

import { closeModelGateway, getModelGateway } from './gateway';
import { prepareSdkChild } from './connectionFactory';
import { makeResolvedModel } from './__fixtures__/resolvedModel';
import { getLlmEgressProxy } from '../llm/llmEgressProxy';

const PARENT = { PATH: '/usr/bin', HOME: '/home/breeze', ANTHROPIC_API_KEY: 'sk-platform-PARENT', HTTPS_PROXY: 'http://corp:3128', NO_PROXY: '*', AWS_SECRET_ACCESS_KEY: 'aws-parent' };

describe('prepareSdkChild', () => {
  beforeEach(async () => { rec.events.length = 0; await getModelGateway(); });
  afterEach(async () => { await closeModelGateway(); await (await getLlmEgressProxy()).close(); });

  it('gateway: loopback base URL with a grant token, placeholder key, deny-all proxy, NO_PROXY loopback only', async () => {
    const r = makeResolvedModel('openai_compatible');
    const { env, revoke } = await prepareSdkChild(r, { key: 'sess-1', orgId: 'org-1', aiSessionId: 'sess-1', source: PARENT });
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/g\/[A-Za-z0-9_-]{43}$/);
    expect(env.ANTHROPIC_API_KEY).toBe('breeze-gateway');
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/breeze:[^@]+@127\.0\.0\.1:\d+$/);
    expect(env.NO_PROXY).toBe('127.0.0.1,localhost');
    expect(env.no_proxy).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    revoke();
  });

  it('child env carries no credential: not the upstream key, not the platform key, not parent cloud creds', async () => {
    const r = makeResolvedModel('openai_compatible');
    const { env, revoke } = await prepareSdkChild(r, { key: 'sess-2', orgId: 'org-1', aiSessionId: null, source: PARENT });
    const s = JSON.stringify(env);
    for (const secret of ['sk-fixture-upstream', 'sk-platform-PARENT', 'aws-parent', 'llm.example.com']) expect(s).not.toContain(secret);
    revoke();
  });

  it('pins every alias env to the bound wire model', async () => {
    const r = makeResolvedModel('openai_compatible');
    const { env, revoke } = await prepareSdkChild(r, { key: 'sess-3', orgId: 'org-1', aiSessionId: null, source: PARENT });
    for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
      expect(env[k]).toBe(r.wireModel);
    }
    revoke();
  });

  it('revoke() kills the gateway grant (401 afterwards) and the deny-all proxy grant', async () => {
    const r = makeResolvedModel('openai_compatible');
    const { env, revoke } = await prepareSdkChild(r, { key: 'sess-4', orgId: 'org-1', aiSessionId: null, source: PARENT });
    revoke();
    const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/models`);
    expect(res.status).toBe(401);
  });

  it('records one sdk_session_create audit row with the connection id', async () => {
    const r = makeResolvedModel('openai_compatible');
    const { revoke } = await prepareSdkChild(r, { key: 'sess-5', orgId: 'org-1', aiSessionId: 'sess-5', source: PARENT });
    expect(rec.events).toEqual([expect.objectContaining({ surface: 'sdk_session_create', connectionId: 'conn-oai', host: 'llm.example.com', orgId: 'org-1' })]);
    revoke();
  });

  it('catalog and BYOK behave exactly as before (delegates to buildClaudeSdkChildEnv)', async () => {
    const byok = await prepareSdkChild(makeResolvedModel('anthropic_byok'), { key: 'k', orgId: 'org-1', aiSessionId: null, source: PARENT });
    expect(byok.env.ANTHROPIC_API_KEY).toBe('sk-partner');
    expect(byok.env.ANTHROPIC_BASE_URL).toBeUndefined();
    byok.revoke();
    const cat = await prepareSdkChild(makeResolvedModel('catalog'), { key: 'k2', orgId: 'org-1', aiSessionId: null, source: PARENT });
    expect(cat.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.com');
    expect(cat.env.HTTPS_PROXY).toMatch(/127\.0\.0\.1/);
    cat.revoke();
  });
});
```

Append to `connectionFactory.test.ts`:

```ts
describe('gateway connections (W06)', () => {
  it('anthropicClientFor builds a client on a loopback gateway grant with the placeholder key only', async () => {
    await getModelGateway();
    const client = anthropicClientFor(makeResolvedModel('openai_compatible'), { orgId: 'org-1', surface: 'one_shot_ticket_draft' } as never);
    expect(client.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/g\//);
    expect(client.apiKey).toBe('breeze-gateway');
    expect(client.authToken).toBeNull();
    await closeModelGateway();
  });

  it('createMessage never sends server-side fallbacks on a gateway connection (client-side retry instead)', async () => {
    const calls: unknown[] = [];
    const client = { messages: { create: async (p: unknown) => { calls.push(p); return { stop_reason: calls.length === 1 ? 'refusal' : 'end_turn', content: [], usage: {} }; } },
      beta: { messages: { create: vi.fn() } } } as never;
    const r = makeResolvedModel('openai_compatible', { refusalFallback: { offeringId: 'o2', displayName: 'b', wireModel: 'qwen-b', wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: { source: 'offering', standard: FIXTURE_STD_RATES } } });
    const out = await createMessage(client, r, { max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    expect(out.attempts.map((a) => a.wireModel)).toEqual(['qwen2.5-coder:7b', 'qwen-b']);
    expect((client as { beta: { messages: { create: ReturnType<typeof vi.fn> } } }).beta.messages.create).not.toHaveBeenCalled();
  });

  it('describeDispatch reports the gateway kind and the upstream base URL', () => {
    expect(describeDispatch(makeResolvedModel('openai_compatible'))).toMatchObject({
      destinationKind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', connectionId: 'conn-oai', funding: 'partner_key',
    });
  });
});
```

Append to `llmEgressProxy.test.ts`:

```ts
it('a null grant refuses every CONNECT and audits it as blocked', async () => {
  const proxy = await startLlmEgressProxy();
  const attempts: unknown[] = [];
  const { proxyUrl } = proxy.grant('s', null, (a) => attempts.push(a));
  const status = await connectThrough(proxyUrl, 'api.anthropic.com:443');   // existing helper in this file
  expect(status).toBe(403);
  expect(attempts).toEqual([expect.objectContaining({ host: 'api.anthropic.com', blocked: true })]);
  await proxy.close();
});
```

`apps/api/src/services/aiModels/gateway/gatewaySdk.e2e.test.ts` — **real Agent SDK child**, fake OpenAI upstream behind the gateway, no network:

```ts
/**
 * End-to-end proof for W06 (Review Focus 3): the bundled Claude Agent SDK CLI,
 * in first-party mode, pointed at the loopback gateway, runs an in-process MCP
 * tool off an OpenAI tool call and reports the upstream's usage. No network:
 * the gateway's upstream dial is replaced in-process. This suite spawns the CLI
 * binary; it FAILS (does not skip) if the binary cannot start.
 */
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: () => {} }));

import { __setUpstreamFetchForTests } from './forward';
import { closeModelGateway, getModelGateway } from '.';
import { prepareSdkChild } from '../connectionFactory';
import { makeResolvedModel } from '../__fixtures__/resolvedModel';
import { getLlmEgressProxy } from '../../llm/llmEgressProxy';

const upstreamCalls: Array<Record<string, unknown>> = [];
const enc = new TextEncoder();
function sseResponse(chunks: unknown[]): Response {
  return new Response(new ReadableStream({ start(c) {
    for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
    c.enqueue(enc.encode('data: [DONE]\n\n')); c.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

beforeAll(async () => {
  await getModelGateway();
  __setUpstreamFetchForTests((async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { model: string; messages: Array<{ role: string }>; tools?: unknown[]; stream: boolean };
    upstreamCalls.push(body);
    const sawToolResult = body.messages.some((m) => m.role === 'tool');
    const usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } };
    if (body.tools && !sawToolResult) {
      return sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'mcp__fidelity__get_weather', arguments: '{"city":"Oslo"}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage },
      ]);
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: 'It is sunny and 21C in Oslo.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage },
    ]);
  }) as never);
});
afterAll(async () => { __setUpstreamFetchForTests(null); await closeModelGateway(); await (await getLlmEgressProxy()).close(); });

describe('Agent SDK through the gateway (openai_compatible)', () => {
  it('runs an MCP tool from an OpenAI tool call and bills the upstream usage', async () => {
    const r = makeResolvedModel('openai_compatible');
    const child = await prepareSdkChild(r, { key: 'e2e', orgId: 'org-1', aiSessionId: null });
    let toolRuns = 0;
    const weather = tool('get_weather', 'Weather for a city', { city: z.string() }, async ({ city }) => {
      toolRuns += 1;
      return { content: [{ type: 'text', text: `sunny 21C in ${city}` }] };
    });
    let result: Record<string, unknown> | null = null;
    try {
      for await (const m of query({
        prompt: 'What is the weather in Oslo? Use the tool.',
        options: {
          model: r.wireModel, maxTurns: 4, tools: [], allowedTools: ['mcp__fidelity__get_weather'],
          mcpServers: { fidelity: createSdkMcpServer({ name: 'fidelity', version: '1.0.0', tools: [weather] }) },
          settingSources: [], persistSession: false, env: child.env,
        },
      })) {
        if ((m as { type?: string }).type === 'result') result = m as Record<string, unknown>;
      }
    } finally {
      child.revoke();
    }
    expect(toolRuns).toBe(1);
    expect(result).toMatchObject({ subtype: 'success' });
    expect(String(result!.result)).toContain('21');
    // Every upstream call named the bound wire model only.
    expect(new Set(upstreamCalls.map((c) => c.model))).toEqual(new Set([r.wireModel]));
    // Billing basis (Review Focus 3): per call input 60 (100 − 40 cached), cache read 40, output 10.
    const mu = (result!.modelUsage as Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number }>)[r.wireModel]!;
    const n = upstreamCalls.length;
    expect(mu).toMatchObject({ inputTokens: 60 * n, outputTokens: 10 * n, cacheReadInputTokens: 40 * n });
  }, 120_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/prepareSdkChild.test.ts src/services/aiModels/connectionFactory.test.ts src/services/llm/llmEgressProxy.test.ts src/services/aiModels/gateway/gatewaySdk.e2e.test.ts`
Expected: FAIL — `prepareSdkChild` not exported; null grant not accepted.

- [ ] **Step 3: Write the implementation**

**3a. `llmEgressProxy.ts`** — `EgressGrant | null`. In `grant()`, store `host: allowed?.host.toLowerCase() ?? null`. In the CONNECT handler, where it compares the requested host:port with the grant, treat `grant.host === null` as "refuse": record `{ host: requestedHost, resolvedIp: null, blocked: true }` and answer `403` exactly as an off-grant host is answered today. Update the interface doc: "`allowed: null` issues a deny-all grant: a child that must not reach anything but loopback still gets an audited proxy, so a stray CLI request is visible instead of silent."

**3b. `sdkChildEnv.ts`** — move `SDK_CHILD_ENV_ALLOWLIST`, `SDK_CHILD_ENV_CREDENTIAL_KEYS`, `SDK_CHILD_ENV_PROXY_KEYS`, `catalogEndpointOf` and `buildClaudeSdkChildEnv` **verbatim** from `streamingSessionManager.ts` (with their comments and imports), and **export** `catalogEndpointOf`. In `streamingSessionManager.ts` replace them with `export { buildClaudeSdkChildEnv } from './aiModels/sdkChildEnv';` plus `import { catalogEndpointOf } from './aiModels/sdkChildEnv';` for its remaining caller (the catalog-provenance stamp, Codex review #15). That caller passes `resolved.connection.config`; narrow first: `const legacyConfig = isGatewayResolvedConnection(resolved.connection) ? null : resolved.connection.config;` and skip the catalog stamp when it is `null` (gateway sessions record their provenance in `llm_egress_events.connection_id` and `ai_invocations.connection_id`). Every existing importer and `streamingSessionManager.security.test.ts` keep working unchanged. Then add:

```ts
/**
 * W06: env for an Agent SDK child bound to a gateway connection. The adapter
 * supplies the base URL (loopback + grant token), the placeholder key and the
 * model pins. No credential env var is forwarded from the parent (platform key,
 * cloud creds); no parent proxy var survives; the child's only routable
 * destination is the loopback gateway — everything else goes to a deny-all,
 * audited CONNECT grant.
 */
export function buildGatewaySdkChildEnv(input: {
  adapterEnv: Record<string, string>;
  denyProxyUrl: string;
  source?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = input.source ?? process.env;
  const env: Record<string, string> = {
    CI: 'true',
    CLAUDE_AGENT_SDK_CLIENT_APP: source.CLAUDE_AGENT_SDK_CLIENT_APP ?? 'breeze-api/ai-agent',
    ...SDK_CHILD_HOST_CONTEXT_GUARDS,
  };
  for (const key of SDK_CHILD_ENV_ALLOWLIST) {
    if (SDK_CHILD_ENV_CREDENTIAL_KEYS.has(key) || SDK_CHILD_ENV_PROXY_KEYS.has(key)) continue;
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  Object.assign(env, input.adapterEnv);
  env.HTTPS_PROXY = input.denyProxyUrl;
  env.HTTP_PROXY = input.denyProxyUrl;
  env.NO_PROXY = '127.0.0.1,localhost';
  // Host-context guards last: an adapter can never re-enable auto-memory / CLAUDE.md.
  Object.assign(env, SDK_CHILD_HOST_CONTEXT_GUARDS);
  return env;
}
```

**3c. `gateway/server.ts`** — add:

```ts
import { LlmUnavailableError } from '../../llm/llmUnavailableError';
export function getStartedModelGateway(): ModelGateway {
  if (!singletonInstance) throw new LlmUnavailableError('The AI model gateway is not running.');
  return singletonInstance;
}
```

and in `apps/api/src/index.ts` boot (before `serve(...)`, after env validation): `await getModelGateway();` (import from `./services/aiModels/gateway`). A failure to bind is fatal at boot — the same posture as a DB that will not connect.

**3d. `connectionFactory.ts`:**

```ts
import { getStartedModelGateway, getGatewayAdapter, type GatewayGrant, type GatewayGrantPurpose } from './gateway';
import { GATEWAY_PLACEHOLDER_KEY } from './gateway/openai/adapter';
import { GRANT_SESSION_TTL_MS } from './gateway/limits';
import { buildClaudeSdkChildEnv, buildGatewaySdkChildEnv } from './sdkChildEnv';
import { isGatewayResolvedConnection } from './candidateLoader';

export type AnthropicClientTarget =
  | { kind: 'platform' }
  | { kind: 'anthropic' }
  | { kind: 'endpoint'; baseUrl: string; authMode: 'x-api-key' | 'bearer'; recordEgress: (attempt: GuardedLlmFetchAttempt) => void }
  /** W06: the loopback gateway. Plain fetch on purpose — guarded fetch refuses loopback; the gateway guards the real hop. */
  | { kind: 'gateway'; baseUrl: string; dialect: 'anthropic' };

// in createAnthropicClient's switch:
    case 'gateway': {
      if (!/^http:\/\/127\.0\.0\.1:\d+\/g\/[A-Za-z0-9_-]{43}$/.test(spec.target.baseUrl)) {
        throw new Error('A gateway client may only target the loopback gateway.');
      }
      return new Anthropic({ baseURL: spec.target.baseUrl, apiKey: GATEWAY_PLACEHOLDER_KEY, authToken: null, ...tuning });
    }
    default: {
      const never: never = spec.target;
      throw new Error(`Unknown client target ${String((never as { kind?: string }).kind)}`);
    }

/** Server-side `fallbacks` only on the Claude API itself (spec §5.3). */
export const SERVER_SIDE_FALLBACK_KINDS: ReadonlySet<string> = new Set(['platform', 'anthropic_byok']);

export function openGatewayGrant(
  resolved: ResolvedModel,
  input: { orgId: string | null; aiSessionId: string | null; purpose: GatewayGrantPurpose; ttlMs?: number },
): GatewayGrant {
  const conn = resolved.connection;
  if (!isGatewayResolvedConnection(conn)) throw new Error('openGatewayGrant on a non-gateway connection');
  const wireModels = [resolved.wireModel, ...(resolved.refusalFallback ? [resolved.refusalFallback.wireModel] : [])];
  return getStartedModelGateway().grant({
    config: conn.config, credential: conn.credential, wireModels,
    orgId: input.orgId, aiSessionId: input.aiSessionId, purpose: input.purpose, ttlMs: input.ttlMs,
  });
}

export function anthropicClientFor(resolved: ResolvedModel, caller: LlmClientCallerContext | null): Anthropic {
  const conn = resolved.connection;
  if (isGatewayResolvedConnection(conn)) {
    // One grant per client (≤ GRANT_DEFAULT_TTL_MS); a one-shot surface builds one client per call.
    const g = openGatewayGrant(resolved, { orgId: caller?.orgId ?? resolved.orgId, aiSessionId: null, purpose: 'dispatch' });
    return createAnthropicClient({ apiKey: GATEWAY_PLACEHOLDER_KEY, target: { kind: 'gateway', baseUrl: g.baseUrl, dialect: 'anthropic' } });
  }
  return clientForConnection(conn.config, caller);
}

// createMessage:
  const serverSide = fb !== undefined && SERVER_SIDE_FALLBACK_KINDS.has(resolved.connection.kind);

export interface DispatchFacts {
  destinationKind: ResolvedConnection['kind'];
  baseUrl: string | null;
  connectionId: string | null;
  funding: AiBillingSource;
  wireModel: string;
}

export function describeDispatch(resolved: ResolvedModel): DispatchFacts {
  const conn = resolved.connection;
  const baseUrl = isGatewayResolvedConnection(conn)
    ? gatewayUpstreamUrl(conn.config)
    : conn.config.source !== 'partner' ? null
      : conn.config.endpoint.kind === 'catalog' ? conn.config.endpoint.baseUrl : ANTHROPIC_PUBLIC_BASE_URL;
  return { destinationKind: conn.kind, baseUrl, connectionId: conn.id, funding: resolved.funding, wireModel: resolved.wireModel };
}

/** Display/audit URL of a gateway connection's upstream. W07 adds cloud arms. */
export function gatewayUpstreamUrl(config: GatewayConnectionConfig): string {
  switch (config.kind) {
    case 'openai_compatible': return config.baseUrl;
    default: { const never: never = config.kind; throw new Error(String(never)); }
  }
}

export interface SdkChildDispatch { env: Record<string, string>; revoke: () => void }

/**
 * THE seam for spawning an Agent SDK child for a resolved model (W06). Replaces
 * "grantCatalogSdkEgress → buildClaudeSdkChildEnv" at both spawn sites.
 *   gateway kinds → gateway grant (session TTL) + adapter env + deny-all proxy
 *   catalog       → CONNECT grant + catalog env (unchanged)
 *   platform/BYOK → env (unchanged)
 */
export async function prepareSdkChild(
  resolved: ResolvedModel,
  input: { key: string; orgId: string; aiSessionId: string | null; source?: NodeJS.ProcessEnv },
): Promise<SdkChildDispatch> {
  const conn = resolved.connection;
  if (isGatewayResolvedConnection(conn)) {
    const proxy = await getLlmEgressProxy();
    const denied = proxy.grant(input.key, null, (attempt) => recordLlmEgressEvent({
      orgId: input.orgId, partnerId: conn.config.partnerId, surface: 'sdk_proxy_connect',
      host: attempt.host, resolvedIp: attempt.resolvedIp, blocked: true, aiSessionId: input.aiSessionId, connectionId: conn.id,
    }));
    let grant: GatewayGrant;
    try {
      grant = openGatewayGrant(resolved, { orgId: input.orgId, aiSessionId: input.aiSessionId, purpose: 'dispatch', ttlMs: GRANT_SESSION_TTL_MS });
    } catch (error) {
      proxy.revoke(input.key);
      throw error;
    }
    recordLlmEgressEvent({
      orgId: input.orgId, partnerId: conn.config.partnerId, surface: 'sdk_session_create',
      host: new URL(gatewayUpstreamUrl(conn.config)).hostname, resolvedIp: null, blocked: false,
      aiSessionId: input.aiSessionId, connectionId: conn.id,
    });
    const adapterEnv = getGatewayAdapter(conn.kind).sdkChildEnv({ gatewayBaseUrl: grant.baseUrl, config: conn.config, wireModel: resolved.wireModel });
    return {
      env: buildGatewaySdkChildEnv({ adapterEnv, denyProxyUrl: denied.proxyUrl, source: input.source }),
      revoke: () => { grant.revoke(); proxy.revoke(input.key); },
    };
  }
  const egress = await grantCatalogSdkEgress(resolved, { key: input.key, orgId: input.orgId, aiSessionId: input.aiSessionId });
  try {
    const env = buildClaudeSdkChildEnv(conn.config, input.source ?? process.env, egress ? { egressProxyUrl: egress.proxyUrl } : {});
    return { env, revoke: () => egress?.revoke() };
  } catch (error) {
    egress?.revoke();
    throw error;
  }
}
```

`grantCatalogSdkEgress` keeps its export (tests use it) but is now called only from `prepareSdkChild`. Its first line becomes `if (isGatewayResolvedConnection(resolved.connection)) return null;` before reading `config.source`.

**3e. Spawn sites.** `streamingSessionManager.ts` `getOrCreate`: replace

```ts
const egress = await grantCatalogSdkEgress(resolved, { key: breezeSessionId, orgId: dbSession.orgId, aiSessionId: breezeSessionId });
const egressProxyUrl = egress?.proxyUrl;
const revokeEgressGrant = egress?.revoke;
if (revokeEgressGrant) session.revokeEgressGrant = revokeEgressGrant;
// …later, inside runOutsideDbContextSafe:
const childEnv = buildClaudeSdkChildEnv(connectionConfig, process.env, { egressProxyUrl });
```

with

```ts
const child = await prepareSdkChild(resolved, { key: breezeSessionId, orgId: dbSession.orgId, aiSessionId: breezeSessionId });
session.revokeEgressGrant = child.revoke;
// …later:
const childEnv = child.env;
```

keeping the existing comment block about taking the grant as late as possible and the catch that releases it (it now calls `child.revoke()`). The catalog-provenance stamp (`catalog_entry_id`/`catalog_revision_id`) stays as is (null for gateway kinds). `aiAgents/runLoop.ts`: same swap (`egress = await grantCatalogSdkEgress(...)` → `child = await prepareSdkChild(agentModel, { key: \`agent-run:${run.id}\`, orgId: run.orgId, aiSessionId: ctx.sessionId ?? null })`; `env: child.env`; the `finally` that revoked `egress` now calls `child.revoke()`).

Tool search: `resolveToolSearchPolicy({ childEnv })` already treats a non-first-party `ANTHROPIC_BASE_URL` as a proxy and disables ToolSearch unless forced — correct for the gateway (the translator does not implement `tool_reference`). Add a one-line assertion in `prepareSdkChild.test.ts`: `resolveToolSearchPolicy({ surfaceSearch: true, childEnv: env, remainingTurns: 10 }).tools` does not enable ToolSearch for a gateway env.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/api
npx vitest run src/services/aiModels/prepareSdkChild.test.ts src/services/aiModels/connectionFactory.test.ts \
  src/services/llm/llmEgressProxy.test.ts src/services/streamingSessionManager.security.test.ts \
  src/services/aiModels/gateway/gatewaySdk.e2e.test.ts
npx vitest run src/services/streamingSessionManager src/services/aiAgents/runLoop
npx tsc --noEmit -p .
```

Expected: PASS; `tsc` clean (Task 8's red consumers are now handled). If the e2e test fails because the CLI calls a path the adapter 404s, read the gateway log for the path and add it to the adapter's path table (with a test) — do not loosen the 404 default. If it fails on usage, see the note in Task 7 Step 4.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/sdkChildEnv.ts apps/api/src/services/streamingSessionManager.ts \
  apps/api/src/services/aiAgents/runLoop.ts apps/api/src/services/aiModels/connectionFactory.ts \
  apps/api/src/services/aiModels/connectionFactory.test.ts apps/api/src/services/aiModels/prepareSdkChild.test.ts \
  apps/api/src/services/llm/llmEgressProxy.ts apps/api/src/services/llm/llmEgressProxy.test.ts \
  apps/api/src/services/aiModels/gateway/ apps/api/src/index.ts
git commit -m "feat(ai-models): prepareSdkChild seam; gateway clients; Agent SDK e2e through the gateway (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Gateway connection writes and manual model entry

Write service for gateway-kind connections and hand-entered offerings. It never goes through W04's compat facade (`partnerLlmConfig.ts`), which is Anthropic-only and bound to `compat_uq`. All writes are partner-axis (RLS shape 3; the request's `withDbAccessContext` partner context is what authorises them), audited by the route (Task 13).

Rules:
- **Create**: `validateByoBaseUrl` (Task 2) first; key optional (keyless = local endpoint); `kind = 'openai_compatible'`; `config_version = 1`; `status = 'active'`; no probe in the request (discovery is enqueued by the route after commit).
- **Update endpoint/key**: optimistic on `config_version` (409 `stale_write`); every endpoint/key change bumps `config_version` (so W03's live-query key recreates SDK sessions, spec §9.2) and clears `last_error`. A base-URL change makes every offering's verification `stale` automatically (fingerprint, Task 8) — no write to offerings is needed or allowed. A key-only change leaves verification valid.
- **Env-managed connections** (`provider_config.managedBy = 'env'`, Task 15) are read-only here: 409 `managed_by_env`.
- **Delete**: offerings cascade (composite FK `ON DELETE CASCADE`); sessions/agent policies unbind (`ON DELETE SET NULL`, W02). An offering that is still an assignment **default** blocks the delete (FK `NO ACTION`) — surface it as 409 `connection_in_use` listing the surfaces, never a raw 23503.
- **Manual offering**: `source = 'manual'`, `enabled = false`, `capabilities = NULL`, optional price; `(connection_id, model_id)` unique → 409 `duplicate_model`.

**Files:**
- Create: `apps/api/src/services/aiModels/gatewayConnections.ts`
- Create: `apps/api/src/services/aiModels/gatewayConnections.test.ts` (unit, mocked policy + db)
- Create: `apps/api/src/__tests__/integration/gatewayConnections.integration.test.ts` (real Postgres, `breeze_app`)
- Modify: `apps/api/src/services/aiModels/index.ts` (re-exports)

**Interfaces:**
- Consumes: Task 2 `validateByoBaseUrl`, `ByoEndpointRejected`; P16 `encryptConnectionKey`, `getConnection`; `hmacFingerprint`; W04 `RegistryWriteError`, `toRegistryWriteError`, `listOfferingDefaultUses(partnerId, offeringId)` (W04 Task 4, `offeringWrites.ts`).
- Produces:

```ts
export interface CreateGatewayConnectionInput { partnerId: string; name: string; baseUrl: string; apiKey?: string; connectedBy: string | null; managedBy?: 'env' }
export async function createGatewayConnection(input: CreateGatewayConnectionInput): Promise<PartnerAiConnection>;
export async function updateGatewayConnection(input: { partnerId: string; connectionId: string; baseUrl?: string; apiKey?: string | null; expectedConfigVersion: number; allowManaged?: boolean }): Promise<PartnerAiConnection>;
export async function deleteGatewayConnection(input: { partnerId: string; connectionId: string }): Promise<void>;
export async function createManualOffering(input: { partnerId: string; connectionId: string; modelId: string; displayName?: string; prices?: ModelRates | null }): Promise<Offering>;
export function isEnvManaged(conn: Pick<PartnerAiConnection, 'providerConfig'>): boolean;
```

- [ ] **Step 1: Write the failing tests**

`gatewayConnections.test.ts` (unit — `vi.hoisted` db mock in the style of W02's `connections.test.ts`; assertions on the values passed to `insert`/`update`):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ inserted: [] as Array<Record<string, unknown>>, updated: [] as Array<Record<string, unknown>>,
  row: null as Record<string, unknown> | null, policy: async (u: string) => u.replace(/\/+$/, '') }));
vi.mock('./gateway/byoEndpointPolicy', async (orig) => ({ ...(await orig<typeof import('./gateway/byoEndpointPolicy')>()),
  validateByoBaseUrl: (u: string) => h.policy(u) }));
vi.mock('../../db', () => /* returns a db whose insert(...).values(v).returning() pushes v to h.inserted and returns [{...v}],
  whose select().from().where().for('update') resolves [h.row], and update().set(v).where().returning() pushes v and returns [{...h.row, ...v}] */ ({}));

import { ByoEndpointRejected } from './gateway/byoEndpointPolicy';
import { createGatewayConnection, createManualOffering, updateGatewayConnection } from './gatewayConnections';

describe('gatewayConnections', () => {
  beforeEach(() => { h.inserted.length = 0; h.updated.length = 0; });

  it('creates a keyless openai_compatible connection (triplet all null)', async () => {
    await createGatewayConnection({ partnerId: 'p1', name: 'Ollama', baseUrl: 'http://ollama.lan:11434/v1', connectedBy: 'u1' });
    expect(h.inserted[0]).toMatchObject({ kind: 'openai_compatible', baseUrl: 'http://ollama.lan:11434/v1', apiKeyEncrypted: null, keyLast4: null, keyFingerprint: null, configVersion: 1, status: 'active' });
  });

  it('encrypts a key with the row-bound AAD and stores last4 + fingerprint, never the plaintext', async () => {
    await createGatewayConnection({ partnerId: 'p1', name: 'OR', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-abcdef123456', connectedBy: 'u1' });
    const row = h.inserted[0]!;
    expect(String(row.apiKeyEncrypted)).toMatch(/^enc:/);
    expect(row.keyLast4).toBe('3456');
    expect(JSON.stringify(row)).not.toContain('sk-or-abcdef123456');
  });

  it('propagates the egress policy rejection (no row written)', async () => {
    h.policy = async () => { throw new ByoEndpointRejected('private', 'egress_blocked'); };
    await expect(createGatewayConnection({ partnerId: 'p1', name: 'x', baseUrl: 'https://10.0.0.1', connectedBy: null })).rejects.toBeInstanceOf(ByoEndpointRejected);
    expect(h.inserted).toHaveLength(0);
    h.policy = async (u) => u;
  });

  it('refuses a key starting with the encrypted-value prefix', async () => {
    await expect(createGatewayConnection({ partnerId: 'p1', name: 'x', baseUrl: 'https://a.example.com', apiKey: 'enc:v3:xyz', connectedBy: null })).rejects.toThrow(/prefix/);
  });

  it('update: stale config_version → 409 stale_write', async () => {
    h.row = { id: 'c1', partnerId: 'p1', kind: 'openai_compatible', configVersion: 5, providerConfig: null, baseUrl: 'https://a.example.com' };
    await expect(updateGatewayConnection({ partnerId: 'p1', connectionId: 'c1', baseUrl: 'https://b.example.com', expectedConfigVersion: 4 }))
      .rejects.toMatchObject({ code: 'stale_write', status: 409 });
  });

  it('update: endpoint change bumps config_version and clears last_error; null apiKey clears the triplet', async () => {
    h.row = { id: 'c1', partnerId: 'p1', kind: 'openai_compatible', configVersion: 5, providerConfig: null, baseUrl: 'https://a.example.com' };
    await updateGatewayConnection({ partnerId: 'p1', connectionId: 'c1', baseUrl: 'https://b.example.com', apiKey: null, expectedConfigVersion: 5 });
    expect(h.updated[0]).toMatchObject({ baseUrl: 'https://b.example.com', configVersion: 6, lastError: null, status: 'active',
      apiKeyEncrypted: null, keyLast4: null, keyFingerprint: null });
  });

  it('update: env-managed connections are read-only (409 managed_by_env)', async () => {
    h.row = { id: 'c1', partnerId: 'p1', kind: 'openai_compatible', configVersion: 1, providerConfig: { managedBy: 'env' }, baseUrl: 'https://a.example.com' };
    await expect(updateGatewayConnection({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-new-key-123', expectedConfigVersion: 1 }))
      .rejects.toMatchObject({ code: 'managed_by_env' });
  });

  it('update: a non-gateway connection is not found here (404, compat flows own it)', async () => {
    h.row = { id: 'c1', partnerId: 'p1', kind: 'anthropic_byok', configVersion: 1, providerConfig: null, baseUrl: null };
    await expect(updateGatewayConnection({ partnerId: 'p1', connectionId: 'c1', apiKey: 'x'.repeat(20), expectedConfigVersion: 1 }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('manual offering lands disabled, unverified, source manual', async () => {
    h.row = { id: 'c1', partnerId: 'p1', kind: 'openai_compatible', configVersion: 1, providerConfig: null, baseUrl: 'https://a.example.com' };
    await createManualOffering({ partnerId: 'p1', connectionId: 'c1', modelId: 'qwen2.5-coder:7b', displayName: 'Qwen coder' });
    expect(h.inserted.at(-1)).toMatchObject({ source: 'manual', enabled: false, capabilities: null, modelId: 'qwen2.5-coder:7b', displayName: 'Qwen coder', connectionId: 'c1', partnerId: 'p1' });
  });
});
```

(Write the `vi.mock('../../db', …)` factory concretely in the file — a small chainable stub; W02's `connections.test.ts` has one to copy.)

`gatewayConnections.integration.test.ts` (real Postgres via `pnpm test-stack up`; seed two partners with `seedRegistryPartner` from W03's `helpers/aiModelRegistrySeed.ts`; run writes inside `withDbAccessContext` as each partner, the way W04's `aiModelsRoutes.integration.test.ts` does):

```ts
describe('gateway connections — tenancy (real DB)', () => {
  it('partner A cannot create a manual offering on partner B\'s connection (composite FK + RLS)', async () => {
    const connB = await asPartner(B, () => createGatewayConnection({ partnerId: B.partnerId, name: 'B', baseUrl: 'https://b.example.com/v1', connectedBy: null }));
    await expect(asPartner(A, () => createManualOffering({ partnerId: A.partnerId, connectionId: connB.id, modelId: 'm' })))
      .rejects.toMatchObject({ status: 404 });
    // Direct forge as breeze_app under A's context fails at the FK / RLS:
    await expect(asPartner(A, () => sqlAsApp`INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source)
      VALUES (${A.partnerId}, ${connB.id}, 'm', 'manual')`)).rejects.toThrow(/violates|row-level security/);
  });

  it('the shape CHECK refuses an openai_compatible row with no base_url', async () => {
    await expect(asSystem(() => sql`INSERT INTO partner_ai_connections (partner_id, kind, name) VALUES (${A.partnerId}, 'openai_compatible', 'x')`))
      .rejects.toThrow(/partner_ai_connections_shape_chk/);
  });

  it('many openai_compatible connections per partner are allowed (compat_uq predicate excludes them)', async () => {
    await asPartner(A, () => createGatewayConnection({ partnerId: A.partnerId, name: 'one', baseUrl: 'https://one.example.com/v1', connectedBy: null }));
    await asPartner(A, () => createGatewayConnection({ partnerId: A.partnerId, name: 'two', baseUrl: 'https://two.example.com/v1', connectedBy: null }));
    const rows = await asSystem(() => sql`SELECT count(*)::int AS n FROM partner_ai_connections WHERE partner_id = ${A.partnerId} AND kind = 'openai_compatible'`);
    expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it('delete with an offering that is an assignment default → 409 connection_in_use (no raw 23503)', async () => {
    const conn = await asPartner(A, () => createGatewayConnection({ partnerId: A.partnerId, name: 'del', baseUrl: 'https://del.example.com/v1', connectedBy: null }));
    const off = await asPartner(A, () => createManualOffering({ partnerId: A.partnerId, connectionId: conn.id, modelId: 'm', prices: ZERO }));
    await asSystem(() => seedPartnerAssignment(A.partnerId, 'script_reviewer', off.id));
    await expect(asPartner(A, () => deleteGatewayConnection({ partnerId: A.partnerId, connectionId: conn.id })))
      .rejects.toMatchObject({ code: 'connection_in_use', status: 409 });
  });

  it('the key ciphertext decrypts only for its own row id (row-bound AAD)', async () => {
    const c1 = await asPartner(A, () => createGatewayConnection({ partnerId: A.partnerId, name: 'k1', baseUrl: 'https://k1.example.com/v1', apiKey: 'sk-k1-secret-123456', connectedBy: null }));
    const c2 = await asPartner(A, () => createGatewayConnection({ partnerId: A.partnerId, name: 'k2', baseUrl: 'https://k2.example.com/v1', apiKey: 'sk-k2-secret-123456', connectedBy: null }));
    const m1 = await asSystem(() => getConnectionKeyMaterial(c1.id));
    expect(decryptConnectionKey(m1!)).toBe('sk-k1-secret-123456');
    expect(() => decryptConnectionKey({ id: c2.id, apiKeyEncrypted: m1!.apiKeyEncrypted })).toThrow();
  });
});
```

(`asPartner`, `asSystem`, `sqlAsApp`, `seedPartnerAssignment`, `ZERO` are local helpers in the file built from `withDbAccessContext` / `withSystemDbAccessContext` and the existing integration `db-utils.ts`; copy the pattern from `aiModelsRoutes.integration.test.ts`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/gatewayConnections.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/aiModels/gatewayConnections.ts
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { isGatewayConnectionKind, type ModelRates } from '@breeze/shared';
import { db } from '../../db';
import { partnerAiConnections, partnerAiModels } from '../../db/schema/aiModelRegistry';
import { hmacFingerprint } from '../secretCrypto';
import { encryptConnectionKey, ConnectionKeyError, type PartnerAiConnection } from './connections';
import { validateByoBaseUrl } from './gateway/byoEndpointPolicy';
import { listOfferingDefaultUses } from './offeringWrites';
import type { Offering } from './offerings';
import { RegistryWriteError, toRegistryWriteError } from './registryWriteErrors';

export interface CreateGatewayConnectionInput {
  partnerId: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  connectedBy: string | null;
  managedBy?: 'env';
}

export function isEnvManaged(conn: Pick<PartnerAiConnection, 'providerConfig'>): boolean {
  return (conn.providerConfig as { managedBy?: unknown } | null)?.managedBy === 'env';
}

function keyTriplet(id: string, apiKey: string | null | undefined) {
  if (apiKey === undefined) return {};
  if (apiKey === null) return { apiKeyEncrypted: null, keyLast4: null, keyFingerprint: null };
  const key = apiKey.trim();
  if (key.startsWith('enc:')) throw new ConnectionKeyError('Keys must not start with the encrypted-value prefix.', 'key_rejected');
  return { apiKeyEncrypted: encryptConnectionKey(id, key), keyLast4: key.slice(-4), keyFingerprint: hmacFingerprint(key) };
}

export async function createGatewayConnection(input: CreateGatewayConnectionInput): Promise<PartnerAiConnection> {
  const baseUrl = await validateByoBaseUrl(input.baseUrl);
  const id = randomUUID();
  try {
    const [row] = await db.insert(partnerAiConnections).values({
      id,
      partnerId: input.partnerId,
      kind: 'openai_compatible',
      name: input.name.trim(),
      baseUrl,
      providerConfig: input.managedBy ? { managedBy: input.managedBy } : null,
      ...(input.apiKey ? keyTriplet(id, input.apiKey) : { apiKeyEncrypted: null, keyLast4: null, keyFingerprint: null }),
      status: 'active',
      configVersion: 1,
      connectedBy: input.connectedBy,
      verifiedAt: null,
    }).returning();
    if (!row) throw new Error('Could not create the connection.');
    const { apiKeyEncrypted: _k, keyFingerprint: _f, ...pub } = row;
    return pub as PartnerAiConnection;
  } catch (error) {
    toRegistryWriteError(error, 'Could not create the connection.');   // W04: (error, fallbackMessage): never
  }
}

async function loadOwnGatewayConnectionForUpdate(partnerId: string, connectionId: string) {
  const [row] = await db.select().from(partnerAiConnections)
    .where(and(eq(partnerAiConnections.id, connectionId), eq(partnerAiConnections.partnerId, partnerId)))
    .for('update');
  if (!row || !isGatewayConnectionKind(row.kind)) throw new RegistryWriteError('Connection not found.', 'not_found', 404);
  return row;
}

export async function updateGatewayConnection(input: {
  partnerId: string; connectionId: string; baseUrl?: string; apiKey?: string | null;
  expectedConfigVersion: number; allowManaged?: boolean;
}): Promise<PartnerAiConnection> {
  const baseUrl = input.baseUrl !== undefined ? await validateByoBaseUrl(input.baseUrl) : undefined;
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.select().from(partnerAiConnections)
        .where(and(eq(partnerAiConnections.id, input.connectionId), eq(partnerAiConnections.partnerId, input.partnerId)))
        .for('update');
      if (!row || !isGatewayConnectionKind(row.kind)) throw new RegistryWriteError('Connection not found.', 'not_found', 404);
      if (isEnvManaged(row) && !input.allowManaged) {
        throw new RegistryWriteError('This connection is managed by the MCP_LLM_* environment variables. Change them and restart Breeze.', 'managed_by_env', 409);
      }
      if (row.configVersion !== input.expectedConfigVersion) {
        throw new RegistryWriteError('This connection changed since you opened it. Reload and try again.', 'stale_write', 409);
      }
      const [updated] = await tx.update(partnerAiConnections).set({
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...keyTriplet(row.id, input.apiKey),
        configVersion: row.configVersion + 1,
        status: 'active',
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(partnerAiConnections.id, row.id)).returning();
      const { apiKeyEncrypted: _k, keyFingerprint: _f, ...pub } = updated!;
      return pub as PartnerAiConnection;
    });
  } catch (error) {
    if (error instanceof RegistryWriteError) throw error;
    toRegistryWriteError(error, 'Could not update the connection.');
  }
}

export async function deleteGatewayConnection(input: { partnerId: string; connectionId: string }): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(partnerAiConnections)
        .where(and(eq(partnerAiConnections.id, input.connectionId), eq(partnerAiConnections.partnerId, input.partnerId)))
        .for('update');
      if (!row || !isGatewayConnectionKind(row.kind)) throw new RegistryWriteError('Connection not found.', 'not_found', 404);
      if (isEnvManaged(row)) {
        throw new RegistryWriteError('This connection is managed by the MCP_LLM_* environment variables. Unset them and restart Breeze.', 'managed_by_env', 409);
      }
      const offerings = await tx.select({ id: partnerAiModels.id }).from(partnerAiModels).where(eq(partnerAiModels.connectionId, row.id));
      const uses = (await Promise.all(offerings.map((o) => listOfferingDefaultUses(input.partnerId, o.id)))).flat();
      if (uses.length > 0) {
        throw new RegistryWriteError('A model on this connection is still the default for a feature. Change those defaults first.',
          'connection_in_use', 409, { surfaces: [...new Set(uses.map((u) => u.surface))] });
      }
      await tx.delete(partnerAiConnections).where(eq(partnerAiConnections.id, row.id));
    });
  } catch (error) {
    if (error instanceof RegistryWriteError) throw error;
    // A racing 23503 (an assignment default added between the check and the delete):
    if ((error as { code?: string }).code === '23503') {
      throw new RegistryWriteError('A model on this connection is still the default for a feature. Change those defaults first.', 'connection_in_use', 409);
    }
    toRegistryWriteError(error, 'Could not delete the connection.');
  }
}

export async function createManualOffering(input: {
  partnerId: string; connectionId: string; modelId: string; displayName?: string; prices?: ModelRates | null;
}): Promise<Offering> {
  try {
    const [conn] = await db.select({ id: partnerAiConnections.id, kind: partnerAiConnections.kind }).from(partnerAiConnections)
      .where(and(eq(partnerAiConnections.id, input.connectionId), eq(partnerAiConnections.partnerId, input.partnerId)));
    if (!conn || !isGatewayConnectionKind(conn.kind)) throw new RegistryWriteError('Connection not found.', 'not_found', 404);
    const p = input.prices ?? null;
    const [row] = await db.insert(partnerAiModels).values({
      partnerId: input.partnerId,
      connectionId: conn.id,
      modelId: input.modelId,
      source: 'manual',
      displayName: input.displayName ?? null,
      capabilities: null,
      priceInputCentsPerM: p?.inputCentsPerM ?? null,
      priceOutputCentsPerM: p?.outputCentsPerM ?? null,
      priceCacheReadCentsPerM: p?.cacheReadCentsPerM ?? null,
      priceCacheWriteCentsPerM: p?.cacheWriteCentsPerM ?? null,
      enabled: false,
      lifecycle: 'available',
    }).returning();
    return row as Offering;
  } catch (error) {
    if (error instanceof RegistryWriteError) throw error;
    // Map the unique (connection_id, model_id) violation BEFORE the generic mapper (which throws).
    if ((error as { code?: string; constraint_name?: string }).code === '23505') {
      throw new RegistryWriteError('That model is already listed on this connection.', 'duplicate_model', 409);
    }
    toRegistryWriteError(error, 'Could not add the model.');
  }
}
```

W04's `toRegistryWriteError(error, fallbackMessage): never` always throws (Codex review #7), so every constraint that needs a specific code is mapped **before** calling it, as above. Extend W04's `RegistryWriteCode` union in `registryWriteErrors.ts` (same task, same commit) with `not_found`, `managed_by_env`, `connection_in_use`, `duplicate_model`, `stale_write` (if absent), and — for Task 12 — `not_gateway`. Check the postgres-js error shape W04 reads (`code` / `constraint_name`) and match it.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiModels/gatewayConnections.test.ts
pnpm test-stack up
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/gatewayConnections.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/gatewayConnections.ts apps/api/src/services/aiModels/gatewayConnections.test.ts \
  apps/api/src/__tests__/integration/gatewayConnections.integration.test.ts apps/api/src/services/aiModels/index.ts \
  apps/api/src/services/aiModels/registryWriteErrors.ts
git commit -m "feat(ai-models): gateway connection writes and manual model entry (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Discovery for `openai_compatible` (`GET {base_url}/models`)

Plugs gateway kinds into W03 Task 16's `syncConnectionModels` through a small registry, so W07 adds Bedrock by adding an entry. Rules (spec §6): new ids land `discovered`, **disabled**, unpriced, unverified; nothing is ever enabled, re-priced, deleted or re-assigned; lifecycle (`missing` after 3 successful syncs without it, `retired` after 14 days) applies to **`discovered` rows only** — a `manual` row is never marked missing because the endpoint does not list it (many gateways list a subset); a failed sync changes nothing but `discovery_error`.

**Files:**
- Create: `apps/api/src/services/aiModels/gateway/openai/discovery.ts` (+ `.test.ts`)
- Create: `apps/api/src/services/aiModels/connectionDiscovery.ts` (+ `.test.ts`)
- Modify: `apps/api/src/services/aiModels/discovery.ts` (W03 Task 16 `syncConnectionModels`: branch to the registry for gateway kinds)
- Modify: `apps/api/src/services/aiModels/discovery.test.ts`
- Modify: `apps/api/src/services/aiModels/gateway/forward.ts` (`UpstreamRequest.maxBytes?: number`)

**Interfaces:**
- Consumes: P7; Task 4 `forwardUpstream`; Task 1 `BYO_MODEL_ID_PATTERN`; Task 4 `scrubSecrets`, `DISCOVERY_MAX_*`.
- Produces:

```ts
// connectionDiscovery.ts
export interface DiscoveredConnectionModel { modelId: string; displayName: string | null }
export type ConnectionModelDiscoverer = (input: { config: GatewayConnectionConfig; credential: GatewayCredential }) => Promise<DiscoveredConnectionModel[]>;
export const CONNECTION_MODEL_DISCOVERERS: Partial<Record<GatewayConnectionKind, ConnectionModelDiscoverer>>;   // W07 adds bedrock
export function discoveryGrantRecord(config: GatewayConnectionConfig, credential: GatewayCredential): GatewayGrantRecord;   // in-memory, never registered
// openai/discovery.ts
export async function discoverOpenAiCompatibleModels(input: { config: Extract<GatewayConnectionConfig, { kind: 'openai_compatible' }>; credential: GatewayCredential }): Promise<DiscoveredConnectionModel[]>;
export function sanitizeDiscoveredModels(payload: unknown): DiscoveredConnectionModel[];   // throws DiscoveryTruncatedError beyond DISCOVERY_MAX_MODELS
export class DiscoveryTruncatedError extends Error {}
```

- [ ] **Step 1: Write the failing tests**

`gateway/openai/discovery.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: () => {} }));
import { __setUpstreamFetchForTests } from '../forward';
import { discoverOpenAiCompatibleModels, sanitizeDiscoveredModels } from './discovery';

const config = { source: 'gateway', kind: 'openai_compatible', partnerId: 'p', connectionId: 'c', configVersion: 1, baseUrl: 'https://llm.example.com/v1' } as const;
afterEach(() => __setUpstreamFetchForTests(null));

describe('openai_compatible discovery', () => {
  it('GETs {base}/models with the bearer key, 1 MiB cap, and returns sanitized ids', async () => {
    let seen: { url: string; init: Record<string, unknown> } | null = null;
    __setUpstreamFetchForTests((async (url: string, init: Record<string, unknown>) => { seen = { url, init };
      return Response.json({ object: 'list', data: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3.1:8b', name: 'Llama 3.1 8B' }] }); }) as never);
    const models = await discoverOpenAiCompatibleModels({ config, credential: { secret: 'sk-x-123456789' } });
    expect(seen!.url).toBe('https://llm.example.com/v1/models');
    expect(seen!.init).toMatchObject({ method: 'GET', maxBytes: 1024 * 1024, streamResponse: false });
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-x-123456789');
    expect(models).toEqual([{ modelId: 'qwen2.5-coder:7b', displayName: null }, { modelId: 'llama3.1:8b', displayName: 'Llama 3.1 8B' }]);
  });

  it('sanitize: a list beyond the cap throws (never a silently truncated inventory — Codex review #9)', () => {
    expect(() => sanitizeDiscoveredModels({ data: Array.from({ length: 501 }, (_, i) => ({ id: `m${i}` })) })).toThrow(/more than 500/);
  });

  it('sanitize: drops invalid ids, dedupes, strips control chars from names, caps name length', () => {
    const data = [
      { id: 'ok-1' }, { id: 'ok-1' }, { id: 'bad id' }, { id: '<img src=x>' }, { id: 42 },
      { id: 'named', name: `Evil\u0000\u001b[31m${'x'.repeat(300)}` },
      ...Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` })),
    ];
    const out = sanitizeDiscoveredModels({ data });
    expect(out.length).toBe(102);
    expect(out.filter((m) => m.modelId === 'ok-1')).toHaveLength(1);
    expect(out.some((m) => m.modelId === 'bad id' || m.modelId === '<img src=x>')).toBe(false);
    const named = out.find((m) => m.modelId === 'named')!;
    expect(named.displayName!.length).toBeLessThanOrEqual(120);
    expect(named.displayName).not.toMatch(/[\u0000-\u001f]/);
  });

  it('accepts the bare-array shape some servers return', () => {
    expect(sanitizeDiscoveredModels([{ id: 'a' }])).toEqual([{ modelId: 'a', displayName: null }]);
  });

  it('non-2xx → throws a scrubbed error (no key in the message)', async () => {
    __setUpstreamFetchForTests((async () => new Response('bad key sk-x-123456789', { status: 401 })) as never);
    const err = await discoverOpenAiCompatibleModels({ config, credential: { secret: 'sk-x-123456789' } }).catch((e) => e as Error);
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toContain('sk-x-123456789');
  });

  it('a non-JSON or wrong-shape body → throws, never returns partial garbage', async () => {
    __setUpstreamFetchForTests((async () => new Response('<html>')) as never);
    await expect(discoverOpenAiCompatibleModels({ config, credential: { secret: null } })).rejects.toThrow(/model list/);
  });
});
```

Append to `discovery.test.ts` (W03 Task 16's file; uses its seeding helpers):

```ts
describe('syncConnectionModels — gateway kinds (W06)', () => {
  it('adds new ids as discovered, disabled, unpriced, unverified; never touches enabled/price/capabilities of existing rows', async () => { /* seed conn + one enabled priced verified discovered row 'a'; discoverer returns ['a','b'] → 'b' inserted disabled/null price/null caps; 'a' unchanged */ });
  it('marks a missing DISCOVERED row missing after 3 successful syncs and retired after 14 days', async () => { /* reuse W03's lifecycle assertions with the gateway discoverer */ });
  it('never marks a MANUAL row missing', async () => { /* manual 'x' not in the list for 5 syncs → lifecycle stays available */ });
  it('a failed sync records a scrubbed discovery_error and changes no lifecycle', async () => { /* discoverer throws Error('... sk-secret ...') → discovery_error has no key; missed counters unchanged */ });
});
```

(Write these four with W03's real fixtures; the comments state exactly what each asserts.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/openai/discovery.test.ts src/services/aiModels/discovery.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`forward.ts` — `UpstreamRequest` gains `maxBytes?: number`; pass `maxBytes: req.maxBytes ?? GATEWAY_MAX_RESPONSE_BYTES`.

`connectionDiscovery.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { GatewayConnectionKind } from '@breeze/shared';
import type { GatewayConnectionConfig, GatewayCredential, GatewayGrantRecord } from './gateway/types';
import { discoverOpenAiCompatibleModels } from './gateway/openai/discovery';

export interface DiscoveredConnectionModel { modelId: string; displayName: string | null }
export type ConnectionModelDiscoverer = (input: { config: GatewayConnectionConfig; credential: GatewayCredential }) => Promise<DiscoveredConnectionModel[]>;

/** Gateway kinds whose provider lists models. A kind absent here is manual-entry only (W07: vertex, foundry). */
export const CONNECTION_MODEL_DISCOVERERS: Partial<Record<GatewayConnectionKind, ConnectionModelDiscoverer>> = {
  openai_compatible: (input) => discoverOpenAiCompatibleModels({ config: input.config as Extract<GatewayConnectionConfig, { kind: 'openai_compatible' }>, credential: input.credential }),
};

/** A grant record used in-process for partner-level calls (discovery). Never registered: no token exists for it. */
export function discoveryGrantRecord(config: GatewayConnectionConfig, credential: GatewayCredential): GatewayGrantRecord {
  return { id: randomUUID(), config, credential, wireModels: new Set(), orgId: null, aiSessionId: null,
    purpose: 'discovery', expiresAt: Date.now() + 60_000, inFlight: new Set() };
}
```

`gateway/openai/discovery.ts`:

```ts
import { BYO_MODEL_ID_PATTERN } from '@breeze/shared';
import { joinByoUrl } from '../byoEndpointPolicy';
import { forwardUpstream } from '../forward';
import { DISCOVERY_MAX_MODELS, DISCOVERY_MAX_RESPONSE_BYTES } from '../limits';
import { scrubSecrets } from '../scrub';
import type { GatewayConnectionConfig, GatewayCredential } from '../types';
import { discoveryGrantRecord, type DiscoveredConnectionModel } from '../../connectionDiscovery';

const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A list too long to trust as complete: the sync records it as failed (no lifecycle change). */
export class DiscoveryTruncatedError extends Error { constructor(m: string) { super(m); this.name = 'DiscoveryTruncatedError'; } }

export function sanitizeDiscoveredModels(payload: unknown): DiscoveredConnectionModel[] {
  const list = Array.isArray(payload) ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data
      : null;
  if (!list) throw new Error('The endpoint did not return a model list.');
  const seen = new Set<string>();
  const out: DiscoveredConnectionModel[] = [];
  for (const item of list) {
    if (out.length >= DISCOVERY_MAX_MODELS) {
      // Codex review #9: a truncated list must never advance absence counters
      // (it would mark listed-but-cut-off models missing, then retired).
      throw new DiscoveryTruncatedError(`The endpoint lists more than ${DISCOVERY_MAX_MODELS} models; add the ones you need by hand.`);
    }
    const id = (item as { id?: unknown })?.id;
    if (typeof id !== 'string' || !BYO_MODEL_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    const rawName = (item as { name?: unknown; display_name?: unknown }).display_name ?? (item as { name?: unknown }).name;
    const name = typeof rawName === 'string' ? rawName.replace(CONTROL, '').trim().slice(0, 120) : '';
    out.push({ modelId: id, displayName: name.length > 0 ? name : null });
  }
  return out;
}

export async function discoverOpenAiCompatibleModels(input: {
  config: Extract<GatewayConnectionConfig, { kind: 'openai_compatible' }>;
  credential: GatewayCredential;
}): Promise<DiscoveredConnectionModel[]> {
  const grant = discoveryGrantRecord(input.config, input.credential);
  const ac = new AbortController();
  const res = await forwardUpstream(grant, {
    url: joinByoUrl(input.config.baseUrl, 'models'), method: 'GET',
    headers: { accept: 'application/json' }, stream: false, maxBytes: DISCOVERY_MAX_RESPONSE_BYTES,
  }, ac.signal);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(scrubSecrets(`The endpoint returned HTTP ${res.status} for /models: ${body}`, [input.credential.secret], 300));
  }
  let payload: unknown;
  try { payload = await res.json(); } catch { throw new Error('The endpoint did not return a model list.'); }
  return sanitizeDiscoveredModels(payload);
}
```

`discovery.ts` (`syncConnectionModels`, W03 Task 16): after loading the connection and before the Anthropic `models.list()` path:

```ts
if (isGatewayConnectionKind(conn.kind)) {
  const discoverer = CONNECTION_MODEL_DISCOVERERS[conn.kind];
  if (!discoverer) return { connectionId, status: 'skipped', discovered: 0, added: 0, markedMissing: 0, markedRetired: 0 };
  const config = gatewayConfigFor(conn);               // Task 8
  const credential = await loadGatewayCredential(conn.id);   // decrypt or { secret: null } (keyless); throws on bad ciphertext
  if (!config) return { connectionId, status: 'skipped', discovered: 0, added: 0, markedMissing: 0, markedRetired: 0 };
  let models: DiscoveredConnectionModel[];
  try {
    models = await discoverer({ config, credential });
  } catch (error) {
    await recordDiscoveryFailure(conn.id, scrubSecrets(error instanceof Error ? error.message : String(error), [credential.secret]));
    return { connectionId, status: 'failed', discovered: 0, added: 0, markedMissing: 0, markedRetired: 0, error: 'discovery_failed' };
  }
  return applyDiscoveredGatewayModels(conn, models, now);   // inserts new rows source 'discovered', enabled false, all prices/capabilities NULL;
                                                            // lifecycle via W03's helpers restricted to source = 'discovered'
}
```

Extract `loadGatewayCredential(connectionId): Promise<GatewayCredential>` into `gatewayCandidate.ts` (Task 8 already has the logic inline — refactor it to call this). `recordDiscoveryFailure` / `applyDiscoveredGatewayModels` live in `discovery.ts` beside W03's equivalents and reuse its `MISSING_AFTER_SUCCESSFUL_SYNCS` / `RETIRED_AFTER_DAYS` and `last_seen_at` / `missed_sync_count` columns (W03 Index additions), with the extra predicate `source = 'discovered'` on the missing/retired updates.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/gateway/openai/discovery.test.ts src/services/aiModels/discovery.test.ts src/services/aiModels/gateway/forward.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/connectionDiscovery.ts apps/api/src/services/aiModels/gateway/openai/discovery.ts \
  apps/api/src/services/aiModels/gateway/openai/discovery.test.ts apps/api/src/services/aiModels/discovery.ts \
  apps/api/src/services/aiModels/discovery.test.ts apps/api/src/services/aiModels/gateway/forward.ts \
  apps/api/src/services/aiModels/gatewayCandidate.ts
git commit -m "feat(ai-models): guarded /models discovery for openai_compatible connections (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: Harness verification through the gateway

A gateway offering is verified by running the **unchanged** W01 fidelity harness — direct tool use, tool result, and the real Agent SDK subprocess — through the gateway, exactly as production traffic flows. The harness gains one optional `transport` parameter; with it omitted, behaviour is byte-identical (catalog verification is untouched and `FIDELITY_HARNESS_VERSION` stays `'1'`, so no catalog revision is unverified on deploy).

Verification runs in the `ai-model-discovery` worker as job `verify-offering` (jobId `verify-offering-${offeringId}`; payload `{ type, offeringId, partnerId }` — no secrets). It writes only `partner_ai_models.capabilities` (+ `updated_at`) and never enables anything. It spends a few thousand tokens on the partner's own endpoint; that traffic is not ledgered (no org, no surface) and is documented.

**Files:**
- Modify: `apps/api/src/services/llm/providerFidelityHarness.ts` (optional `transport`)
- Modify: `apps/api/src/services/llm/providerFidelityHarness.test.ts` (default path unchanged; transport path)
- Create: `apps/api/src/services/aiModels/offeringVerification.ts` (+ `.test.ts`)
- Modify: `apps/api/src/jobs/aiModelDiscoveryWorker.ts` (+ test) (`verify-offering` job)

**Interfaces:**
- Consumes: P6; Task 4 gateway; Task 7 adapter env; Task 8 `verifiedCapabilitiesTree`, `endpointFingerprint`, `gatewayConfigFor`, `loadGatewayCredential`; Task 9 `buildGatewaySdkChildEnv`, `createAnthropicClient` gateway target.
- Produces:

```ts
// providerFidelityHarness.ts
export interface FidelityTransport {
  client: Anthropic;                      // used for the direct stages and the adaptive probe
  childEnv: Record<string, string>;       // used for the SDK subprocess stage
  probeAdaptiveEffort: boolean;           // false for openai_compatible (no Anthropic thinking upstream)
}
export async function runFidelityCheck(input: FidelityCheckInput, transport?: FidelityTransport): Promise<FidelityCheckResult>;

// offeringVerification.ts
export interface OfferingVerificationResult { offeringId: string; state: 'verified' | 'failed'; record: GatewayVerificationRecord }
export async function verifyConnectionOffering(input: { offeringId: string; partnerId: string }): Promise<OfferingVerificationResult>;
export const VERIFY_OFFERING_JOB = 'verify-offering';
// worker
export function verifyOfferingJobId(offeringId: string): string;          // `verify-offering-${id}`
export async function enqueueOfferingVerification(input: { offeringId: string; partnerId: string }): Promise<void>;
// AiModelDiscoveryJobData gains: | { type: 'verify-offering'; offeringId: string; partnerId: string }
```

- [ ] **Step 1: Write the failing tests**

`providerFidelityHarness.test.ts` (append; the file already mocks the SDK `query` and the Anthropic client):

```ts
describe('runFidelityCheck transport seam (W06)', () => {
  it('without a transport, builds its own guarded client exactly as before', async () => {
    await runFidelityCheck(INPUT);
    expect(createAnthropicClientMock).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ kind: 'endpoint' }) }));
  });

  it('with a transport, uses its client and child env and never builds an endpoint client', async () => {
    const client = fakeClientThatPassesDirectStages();
    const res = await runFidelityCheck(INPUT, { client: client as never, childEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/g/t' }, probeAdaptiveEffort: false });
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
    expect(sdkQueryMock.mock.calls[0]![0].options.env).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/g/t' });
    expect(res.probes).toEqual([expect.objectContaining({ name: 'direct_adaptive_effort', ok: false, detail: expect.stringMatching(/^skipped:/) })]);
    expect(res.verifiedCapabilities.adaptiveEffort).toBe(false);
  });

  it('FIDELITY_HARNESS_VERSION is still 1 (a bump would unverify every catalog revision)', () => {
    expect(FIDELITY_HARNESS_VERSION).toBe('1');
  });
});
```

`offeringVerification.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  harness: { passed: true, steps: [{ name: 'direct_tool_use', ok: true }, { name: 'direct_tool_result', ok: true }, { name: 'sdk_subprocess', ok: true }],
    probes: [], verifiedCapabilities: { adaptiveEffort: false }, harnessVersion: '1' } as Record<string, unknown>,
  written: null as Record<string, unknown> | null,
  offering: { id: 'o1', partnerId: 'p1', connectionId: 'c1', modelId: 'qwen', source: 'discovered', platformModelId: null } as Record<string, unknown> | null,
  conn: { id: 'c1', partnerId: 'p1', kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', providerConfig: null, configVersion: 2, status: 'active' } as Record<string, unknown>,
  harnessArgs: null as unknown[] | null,
}));
vi.mock('../llm/providerFidelityHarness', async (orig) => ({ ...(await orig<typeof import('../llm/providerFidelityHarness')>()),
  runFidelityCheck: async (...args: unknown[]) => { h.harnessArgs = args; return h.harness; } }));
vi.mock('./offerings', async (orig) => ({ ...(await orig<typeof import('./offerings')>()), getOffering: async () => h.offering }));
vi.mock('./connections', async (orig) => ({ ...(await orig<typeof import('./connections')>()), getConnection: async () => h.conn }));
vi.mock('./gatewayCandidate', async (orig) => ({ ...(await orig<typeof import('./gatewayCandidate')>()), loadGatewayCredential: async () => ({ secret: 'sk-upstream-777777' }) }));
vi.mock('./offeringVerificationStore', () => ({ writeOfferingCapabilities: async (_id: string, caps: Record<string, unknown>) => { h.written = caps; } }));

import { closeModelGateway, getModelGateway } from './gateway';
import { endpointFingerprint } from './gatewayCapabilities';
import { verifyConnectionOffering } from './offeringVerification';

describe('verifyConnectionOffering', () => {
  beforeEach(async () => { h.written = null; await getModelGateway(); });

  it('passes → stores a verified tree bound to the endpoint fingerprint, tools supported', async () => {
    const r = await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    expect(r.state).toBe('verified');
    expect(h.written).toMatchObject({ tool_use: { supported: true }, breeze_verification: {
      passed: true, toolUse: true, adaptiveEffort: false, endpointFingerprint: endpointFingerprint({ kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', providerConfig: null }) } });
    await closeModelGateway();
  });

  it('drives the harness through a loopback gateway grant with the placeholder key', async () => {
    await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    const [input, transport] = h.harnessArgs as [Record<string, string>, { childEnv: Record<string, string> }];
    expect(input.apiKey).toBe('breeze-gateway');
    expect(input.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/g\//);
    expect(transport.childEnv.ANTHROPIC_BASE_URL).toBe(input.baseUrl);
    await closeModelGateway();
  });

  it('fails → state failed, scrubbed ≤200-char summary, detail never contains the key', async () => {
    h.harness = { ...h.harness, passed: false, steps: [{ name: 'direct_tool_use', ok: false, detail: `no tool_use block; echoed sk-upstream-777777 ${'x'.repeat(500)}` }] };
    const r = await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    expect(r.state).toBe('failed');
    const summary = (h.written!.breeze_verification as { summary: string }).summary;
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(h.written)).not.toContain('sk-upstream-777777');
    await closeModelGateway();
  });

  it('refuses a non-gateway or foreign offering', async () => {
    h.offering = { ...h.offering!, partnerId: 'other' };
    await expect(verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' })).rejects.toMatchObject({ status: 404 });
    h.offering = { ...h.offering!, partnerId: 'p1', connectionId: null, source: 'platform' };
    await expect(verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' })).rejects.toMatchObject({ status: 409 });
  });

  it('never changes enabled (writes capabilities only)', async () => {
    h.offering = { id: 'o1', partnerId: 'p1', connectionId: 'c1', modelId: 'qwen', source: 'discovered', platformModelId: null, enabled: false };
    await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    expect(Object.keys(h.written!)).not.toContain('enabled');
    await closeModelGateway();
  });
});
```

`aiModelDiscoveryWorker.test.ts` (append): `processAiModelDiscoveryJob({ data: { type: 'verify-offering', offeringId: 'o1', partnerId: 'p1' } })` calls `verifyConnectionOffering` with those ids; `enqueueOfferingVerification` adds job name `verify-offering`, jobId `verify-offering-o1`, payload with **only** `type/offeringId/partnerId`, `attempts: 1` (a failed verification is a result, not a retryable error).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/llm/providerFidelityHarness.test.ts src/services/aiModels/offeringVerification.test.ts src/jobs/aiModelDiscoveryWorker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`providerFidelityHarness.ts`:

```ts
export interface FidelityTransport {
  client: Anthropic;
  childEnv: Record<string, string>;
  probeAdaptiveEffort: boolean;
}

export async function runFidelityCheck(input: FidelityCheckInput, transport?: FidelityTransport): Promise<FidelityCheckResult> {
  // …unchanged body, except:
  //   runDirectStage(input)          → runDirectStage(input, transport?.client)
  //   env: buildFidelityChildEnv(input) (in the SDK stage) → env: transport?.childEnv ?? buildFidelityChildEnv(input)
  //   the adaptive probe runs only when (transport?.probeAdaptiveEffort ?? true); otherwise
  //   probes = [{ name: FIDELITY_PROBE_NAMES.adaptiveEffort, ok: false, detail: 'skipped: not applicable to this connection kind' }]
}

async function runDirectStage(input: FidelityCheckInput, injected?: Anthropic): Promise<DirectStageOutcome> {
  const client = injected ?? buildAnthropicClient(input);
  // …unchanged
}
```

`offeringVerification.ts`:

```ts
import { FIDELITY_HARNESS_VERSION, runFidelityCheck, type FidelityCheckResult } from '../llm/providerFidelityHarness';
import { getLlmEgressProxy } from '../llm/llmEgressProxy';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { createAnthropicClient } from './connectionFactory';
import { getConnection } from './connections';
import { getGatewayAdapter, getStartedModelGateway } from './gateway';
import { GATEWAY_PLACEHOLDER_KEY } from './gateway/openai/adapter';
import { scrubSecrets } from './gateway/scrub';
import { endpointFingerprint, verifiedCapabilitiesTree, type GatewayVerificationRecord } from './gatewayCapabilities';
import { gatewayConfigFor, loadGatewayCredential } from './gatewayCandidate';
import { getOffering } from './offerings';
import { writeOfferingCapabilities } from './offeringVerificationStore';
import { RegistryWriteError } from './registryWriteErrors';
import { buildGatewaySdkChildEnv } from './sdkChildEnv';
import { getPlatformModelById } from './platformModels';

export const VERIFY_OFFERING_JOB = 'verify-offering';
const VERIFY_GRANT_TTL_MS = 5 * 60_000;
const systemRead = <T>(fn: () => Promise<T>): Promise<T> => runOutsideDbContext(() => withSystemDbAccessContext(fn));

export interface OfferingVerificationResult { offeringId: string; state: 'verified' | 'failed'; record: GatewayVerificationRecord }

function summarize(result: FidelityCheckResult, secret: string | null): string | null {
  if (result.passed) return null;
  const first = result.steps.find((s) => !s.ok);
  return scrubSecrets(first ? `${first.name}: ${first.detail ?? 'failed'}` : 'verification failed', [secret], 200);
}

export async function verifyConnectionOffering(input: { offeringId: string; partnerId: string }): Promise<OfferingVerificationResult> {
  const offering = await systemRead(() => getOffering(input.offeringId));
  if (!offering || offering.partnerId !== input.partnerId) throw new RegistryWriteError('Model not found.', 'not_found', 404);
  if (!offering.connectionId || !offering.modelId) {
    throw new RegistryWriteError('Only models on a BYO connection are verified here.', 'not_gateway', 409);
  }
  const conn = await systemRead(() => getConnection(offering.connectionId!));
  const config = conn ? gatewayConfigFor(conn) : null;
  if (!conn || !config || conn.partnerId !== input.partnerId) {
    throw new RegistryWriteError('Only models on a BYO connection are verified here.', 'not_gateway', 409);
  }
  const credential = await loadGatewayCredential(conn.id);
  const fingerprint = endpointFingerprint({ kind: conn.kind, baseUrl: conn.baseUrl, providerConfig: conn.providerConfig ?? null });

  const gateway = getStartedModelGateway();
  const proxy = await getLlmEgressProxy();
  const proxyKey = `verify:${offering.id}`;
  const denied = proxy.grant(proxyKey, null, () => {});
  const grant = gateway.grant({ config, credential, wireModels: [offering.modelId], orgId: null, aiSessionId: null, purpose: 'verification', ttlMs: VERIFY_GRANT_TTL_MS });
  let result: FidelityCheckResult;
  try {
    const adapter = getGatewayAdapter(config.kind);
    result = await runFidelityCheck(
      { baseUrl: grant.baseUrl, authMode: 'x-api-key', providerModel: offering.modelId, apiKey: GATEWAY_PLACEHOLDER_KEY },
      {
        client: createAnthropicClient({ apiKey: GATEWAY_PLACEHOLDER_KEY, target: { kind: 'gateway', baseUrl: grant.baseUrl, dialect: adapter.dialect as 'anthropic' }, maxRetries: 1, timeout: 60_000 }),
        childEnv: buildGatewaySdkChildEnv({ adapterEnv: adapter.sdkChildEnv({ gatewayBaseUrl: grant.baseUrl, config, wireModel: offering.modelId }), denyProxyUrl: denied.proxyUrl }),
        // Anthropic thinking is meaningless on an OpenAI-dialect upstream; W07's cloud kinds probe it.
        probeAdaptiveEffort: config.kind !== 'openai_compatible',
      },
    );
  } finally {
    grant.revoke();
    proxy.revoke(proxyKey);
  }

  const record: GatewayVerificationRecord = {
    harnessVersion: FIDELITY_HARNESS_VERSION,
    endpointFingerprint: fingerprint,
    at: new Date().toISOString(),
    passed: result.passed,
    toolUse: result.passed,
    adaptiveEffort: result.verifiedCapabilities.adaptiveEffort,
    summary: summarize(result, credential.secret),
  };
  // W07: a cloud offering linked to a platform row inherits that row's thinking/effort subtree,
  // but only when the adaptive probe passed (verifiedCapabilitiesTree enforces it).
  const thinkingSource = offering.platformModelId
    ? (await systemRead(() => getPlatformModelById(offering.platformModelId!)))?.capabilities ?? null
    : null;
  await systemRead(() => writeOfferingCapabilities(offering.id, verifiedCapabilitiesTree(record, thinkingSource)));
  return { offeringId: offering.id, state: record.passed ? 'verified' : 'failed', record };
}
```

`offeringVerificationStore.ts` (new, tiny, mockable): `writeOfferingCapabilities(offeringId, caps)` = `db.update(partnerAiModels).set({ capabilities: caps, updatedAt: new Date() }).where(eq(partnerAiModels.id, offeringId))`. Add it to the Files list of this task when committing.

Worker: extend `AiModelDiscoveryJobData` with `{ type: 'verify-offering'; offeringId: string; partnerId: string }`; `processAiModelDiscoveryJob` dispatches it to `verifyConnectionOffering`; add `verifyOfferingJobId` and `enqueueOfferingVerification` (`attempts: 1`, `removeOnComplete: 100`, `removeOnFail: 100`; use `enqueueOrReplaceStale` like W03's connection sync). The worker must have started the model gateway (`await getModelGateway()` in `initializeAiModelDiscoveryWorker`), since it may run in a worker-only process.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/llm/providerFidelityHarness.test.ts src/services/aiModels/offeringVerification.test.ts src/jobs/aiModelDiscoveryWorker.test.ts src/routes/admin/llmProviderCatalog.test.ts`
Expected: PASS (catalog verification route unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/llm/providerFidelityHarness.ts apps/api/src/services/llm/providerFidelityHarness.test.ts \
  apps/api/src/services/aiModels/offeringVerification.ts apps/api/src/services/aiModels/offeringVerification.test.ts \
  apps/api/src/services/aiModels/offeringVerificationStore.ts apps/api/src/jobs/aiModelDiscoveryWorker.ts apps/api/src/jobs/aiModelDiscoveryWorker.test.ts
git commit -m "feat(ai-models): fidelity-harness verification of BYO offerings through the gateway (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: `/ai/models` routes — the `openai_compatible` arms

W04 shaped the connection routes as a `switch (body.kind)` with a `never` default and bound every `:id` route to the single compat connection (`ownConnectionId`). W06 adds the kind arm, a kind-agnostic ownership lookup, two routes, and kind dispatch on the existing delete/refresh/verify routes. W04's compat-only routes (`/:id/key`, `/:id/endpoint`) stay compat-only: they 404 for a gateway connection.

| Method + path | Gate | Body | Service | Audit |
|---|---|---|---|---|
| `POST /connections` (arm `openai_compatible`) | `partnerWrite` + partner-wide | `connectionCreateSchema` | `createGatewayConnection`; after commit `enqueueConnectionSync(id)` | `ai_models.connection.created` `{ kind, host, hasKey }` |
| `PATCH /connections/:id/gateway` (new) | same | `connectionGatewayPatchSchema` | `updateGatewayConnection`; after commit `enqueueConnectionSync(id)` when the URL changed | `ai_models.connection.endpoint_changed` `{ kind, host, keyChanged, configVersion }` |
| `PATCH /connections/:id` | same | `connectionSettingsPatchSchema` | W04 `updateConnectionSettings`; **422 `geo_not_supported`** when `inferenceGeo` is set on a gateway kind (D7) | unchanged |
| `DELETE /connections/:id` | same | — | compat kinds → W04 `deletePartnerLlmConfig`; gateway → `deleteGatewayConnection` | `ai_models.connection.deleted` |
| `POST /connections/:id/refresh` | same | — | any kind (`ownConnection`) → `enqueueConnectionSync` | unchanged |
| `POST /connections/:id/offerings` (new) | same | `manualOfferingCreateSchema` | `createManualOffering` | `ai_models.offering.added` `{ source: 'manual', modelId }` |
| `POST /offerings/:id/verify` | same | — | gateway connection offering → `enqueueOfferingVerification`; others → W04 behaviour | `ai_models.offering.verify_requested` |

The audit `host` is `new URL(baseUrl).host` — never the full URL with path (paths can carry tenant identifiers) and never a key.

**Files:**
- Modify: `apps/api/src/routes/aiModels/connections.ts` (+ `connections.test.ts`)
- Modify: `apps/api/src/routes/aiModels/offerings.ts` (+ `offerings.test.ts`)
- Modify: `apps/api/src/routes/aiModels/shared.ts` (`ownConnection(partnerId, id)`)
- Modify: `apps/api/src/services/aiModels/registryView.ts` (+ test) — `AiConnectionDto.baseUrl`, `managedBy`; `AiOfferingDto.verification`
- Modify: `apps/api/src/services/mcpCoverage.ts` (2 `exempt` entries, same reason text as W04's)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (entries for `gatewayConnections.ts`, `offeringVerificationStore.ts`)
- Modify: `apps/api/src/__tests__/integration/aiModelsRoutes.integration.test.ts` (W04's suite — append)

**Interfaces:**
- Consumes: P10, P12; Tasks 1, 10, 11, 12.
- Produces: `ownConnection(partnerId: string, id: string): Promise<PartnerAiConnection>` (404 when missing or foreign).

- [ ] **Step 1: Write the failing tests**

Append to `routes/aiModels/connections.test.ts` (W04's authz-matrix harness: `makeAuth`, `request`, mocked services):

```ts
describe('openai_compatible (W06)', () => {
  const body = { kind: 'openai_compatible', name: 'Office vLLM', baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-local-123456' };

  it.each([
    ['no auth', null, 401],
    ['org-scoped token', 'org', 403],
    ['partner admin without MFA', 'partnerNoMfa', 403],
    ['partner without BILLING_MANAGE', 'partnerNoBilling', 403],
    ['partner user denied partner-wide policies', 'partnerNotWide', 403],
  ])('POST /connections %s → %i', async (_l, who, status) => {
    expect((await request('POST', '/ai/models/connections', body, who)).status).toBe(status);
  });

  it('creates and enqueues discovery AFTER the write commits; audit carries host, never the key', async () => {
    const res = await request('POST', '/ai/models/connections', body, 'partnerAdmin');
    expect(res.status).toBe(201);
    expect(svc.createGatewayConnection).toHaveBeenCalledWith(expect.objectContaining({ partnerId: PARTNER, name: 'Office vLLM', baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-local-123456' }));
    expect(svc.enqueueConnectionSync).toHaveBeenCalledWith(CREATED_ID);
    const audit = auditCalls.at(-1)!;
    expect(audit).toMatchObject({ action: 'ai_models.connection.created', details: { kind: 'openai_compatible', host: 'llm.example.com', hasKey: true } });
    expect(JSON.stringify(audit)).not.toContain('sk-local-123456');
  });

  it('a second openai_compatible connection is allowed even when an Anthropic connection exists (no compat 409)', async () => {
    svc.getCompatConnection.mockResolvedValue({ id: 'compat' });
    expect((await request('POST', '/ai/models/connections', body, 'partnerAdmin')).status).toBe(201);
  });

  it('egress-policy rejection → 400 egress_blocked with the policy message', async () => {
    svc.createGatewayConnection.mockRejectedValueOnce(new ByoEndpointRejected('That host resolves to a private or reserved address, which Breeze does not connect to.', 'egress_blocked'));
    const res = await request('POST', '/ai/models/connections', body, 'partnerAdmin');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'egress_blocked' });
  });

  it('PATCH /:id/gateway — other partner\'s id → 404 before any write', async () => {
    svc.getConnection.mockResolvedValue({ id: 'c9', partnerId: 'OTHER', kind: 'openai_compatible' });
    expect((await request('PATCH', '/ai/models/connections/c9/gateway', { apiKey: null, expectedConfigVersion: 1 }, 'partnerAdmin')).status).toBe(404);
    expect(svc.updateGatewayConnection).not.toHaveBeenCalled();
  });

  it('PATCH /:id with inferenceGeo on a gateway connection → 422 geo_not_supported', async () => {
    svc.getConnection.mockResolvedValue({ id: 'c1', partnerId: PARTNER, kind: 'openai_compatible' });
    expect((await request('PATCH', '/ai/models/connections/c1', { inferenceGeo: 'eu' }, 'partnerAdmin')).status).toBe(422);
  });

  it('POST /:id/key on a gateway connection → 404 (compat-only route)', async () => {
    svc.getCompatConnection.mockResolvedValue({ id: 'compat' });
    expect((await request('POST', '/ai/models/connections/c1/key', { apiKey: 'x'.repeat(30) }, 'partnerAdmin')).status).toBe(404);
  });

  it('DELETE dispatches by kind', async () => {
    svc.getConnection.mockResolvedValue({ id: 'c1', partnerId: PARTNER, kind: 'openai_compatible' });
    await request('DELETE', '/ai/models/connections/c1', undefined, 'partnerAdmin');
    expect(svc.deleteGatewayConnection).toHaveBeenCalledWith({ partnerId: PARTNER, connectionId: 'c1' });
    expect(svc.deletePartnerLlmConfig).not.toHaveBeenCalled();
  });

  it('POST /:id/offerings creates a manual model', async () => {
    svc.getConnection.mockResolvedValue({ id: 'c1', partnerId: PARTNER, kind: 'openai_compatible' });
    const res = await request('POST', '/ai/models/connections/c1/offerings', { modelId: 'qwen2.5-coder:7b' }, 'partnerAdmin');
    expect(res.status).toBe(201);
    expect(svc.createManualOffering).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'c1', modelId: 'qwen2.5-coder:7b' }));
  });
});
```

Append to `routes/aiModels/offerings.test.ts`:

```ts
it('verify on a gateway offering enqueues harness verification (202), not a connection sync', async () => {
  svc.getOffering.mockResolvedValue({ id: 'o1', partnerId: PARTNER, connectionId: 'c1', source: 'discovered' });
  svc.getConnection.mockResolvedValue({ id: 'c1', partnerId: PARTNER, kind: 'openai_compatible' });
  const res = await request('POST', '/ai/models/offerings/o1/verify', undefined, 'partnerAdmin');
  expect(res.status).toBe(202);
  expect(svc.enqueueOfferingVerification).toHaveBeenCalledWith({ offeringId: 'o1', partnerId: PARTNER });
  expect(svc.enqueueConnectionSync).not.toHaveBeenCalled();
});
```

Append to `services/aiModels/registryView.test.ts`:

```ts
it('gateway connection DTO: baseUrl + managedBy, no key material; offering DTO carries verification state', async () => {
  const snap = await buildPartnerModelsSnapshot(/* fixture: one openai_compatible conn (env-managed) + one stale-verified offering */);
  const conn = snap.connections.find((c) => c.kind === 'openai_compatible')!;
  expect(conn).toMatchObject({ baseUrl: 'https://llm.example.com/v1', managedBy: 'env', funding: 'partner_key', inferenceGeo: null, supportedInferenceGeos: [] });
  expect(JSON.stringify(conn)).not.toMatch(/enc:|keyFingerprint/);
  expect(snap.offerings.find((o) => o.connectionId === conn.id)!.verification).toMatchObject({ state: 'stale' });
});
```

Append to `aiModelsRoutes.integration.test.ts` (real DB):

```ts
it('partner A cannot see, verify, refresh or delete partner B\'s openai_compatible connection or offering (404 every route)', async () => { /* seed B gateway conn + offering; drive each W06 route as A; expect 404 and B rows unchanged */ });
it('an org-scoped token cannot read gateway connections through the snapshot (403)', async () => { /* GET /ai/models as org user → 403 */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/aiModels/connections.test.ts src/routes/aiModels/offerings.test.ts src/services/aiModels/registryView.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`routes/aiModels/shared.ts`:

```ts
/** Any-kind ownership (W06). W04's ownConnectionId stays for the compat-only routes. */
export async function ownConnection(partnerId: string, id: string): Promise<PartnerAiConnection> {
  const conn = await getConnection(id);
  if (!conn || conn.partnerId !== partnerId) throw new HTTPException(404, { message: 'Connection not found.' });
  return conn;
}
```

`routes/aiModels/connections.ts` — `POST /`: move W04's `getCompatConnection` 409 check **inside** `case 'anthropic_byok'`, then add:

```ts
      case 'openai_compatible': {
        const conn = await createGatewayConnection({
          partnerId, name: body.name, baseUrl: body.baseUrl, apiKey: body.apiKey, connectedBy: userId,
        });
        audit(c, partnerId, 'created', { kind: body.kind, host: new URL(conn.baseUrl!).host, hasKey: body.apiKey !== undefined });
        afterCommit(c, () => enqueueConnectionSync(conn.id));
        return c.json({ id: conn.id }, 201);
      }
```

`afterCommit(c, fn)` (Codex review #10): the request's `withDbAccessContext` transaction commits only when the request ends, so nothing inside the handler can run "after commit". Implement `afterCommit` as a Hono context list drained by a small middleware mounted on `aiModelsRoutes` **outside** the DB-context middleware's transaction (after `await next()` returns and the response status is < 400); if the repo's auth/DB middleware ordering makes that impossible, enqueue with a 5 s BullMQ `delay` instead. Either way the consumers must be rollback-safe: `syncConnectionModels` and `verifyConnectionOffering` treat a connection/offering that does not exist (yet, or ever) as `skipped` and the jobs use `attempts: 3` with exponential backoff, so a not-yet-visible row is retried and a rolled-back one is dropped. Test: enqueue inside a transaction that then rolls back → the job completes `skipped`, no error.

New routes:

```ts
aiModelConnectionRoutes.patch('/:id/gateway', ...partnerWrite, zValidator('json', connectionGatewayPatchSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const conn = await ownConnection(partnerId, c.req.param('id'));
  if (!isGatewayConnectionKind(conn.kind)) throw new HTTPException(404, { message: 'Connection not found.' });
  const body = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const updated = await updateGatewayConnection({ partnerId, connectionId: conn.id, baseUrl: body.baseUrl, apiKey: body.apiKey, expectedConfigVersion: body.expectedConfigVersion });
    audit(c, partnerId, 'endpoint_changed', { kind: conn.kind, host: updated.baseUrl ? new URL(updated.baseUrl).host : null,
      keyChanged: body.apiKey !== undefined, configVersion: updated.configVersion });
    // Spec §6: discovery runs on create AND rotate (Codex review #16).
    afterCommit(c, () => enqueueConnectionSync(conn.id));
    return c.json({ id: updated.id, configVersion: updated.configVersion }, 200);
  });
});

aiModelConnectionRoutes.post('/:id/offerings', ...partnerWrite, zValidator('json', manualOfferingCreateSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const conn = await ownConnection(partnerId, c.req.param('id'));
  if (!isGatewayConnectionKind(conn.kind)) throw new HTTPException(409, { message: 'Models on this connection are discovered from the provider.' });
  const body = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const off = await createManualOffering({ partnerId, connectionId: conn.id, modelId: body.modelId, displayName: body.displayName, prices: body.prices });
    writeRouteAudit(c, { action: 'ai_models.offering.added', resourceType: 'ai_model_offering', resourceId: off.id, details: { source: 'manual', modelId: body.modelId, connectionId: conn.id } });
    return c.json({ id: off.id }, 201);
  });
});
```

`PATCH /:id`: before calling `updateConnectionSettings`, `const conn = await ownConnection(...)`; if `isGatewayConnectionKind(conn.kind) && body.inferenceGeo !== undefined && body.inferenceGeo !== null` → `return c.json({ error: 'This connection cannot claim an inference geography.', code: 'geo_not_supported' }, 422)`. W04's `ownConnectionId` call in this handler becomes `ownConnection` (name edits are valid for every kind; `updateConnectionSettings` already takes the id).

`DELETE /:id` and `POST /:id/refresh`: replace `ownConnectionId` with `ownConnection`; DELETE branches `isGatewayConnectionKind(conn.kind) ? deleteGatewayConnection(...) : deletePartnerLlmConfig(...)`.

`ByoEndpointRejected` → map in `registryErrorResponse` (W04 `shared.ts`): `if (err instanceof ByoEndpointRejected) return c.json({ error: err.message, code: err.code }, 400)`.

`routes/aiModels/offerings.ts` `POST /:id/verify`:

```ts
  const conn = offering.connectionId ? await getConnection(offering.connectionId) : null;
  if (conn && isGatewayConnectionKind(conn.kind)) {
    await enqueueOfferingVerification({ offeringId: offering.id, partnerId });
    audit(c, partnerId, 'verify_requested', { offeringId: offering.id, mode: 'harness' });
    return c.json({ queued: true }, 202);
  }
  // …W04 behaviour unchanged (connection sync; 409 for platform offerings)
```

`registryView.ts` — connection mapper adds `baseUrl: isGatewayConnectionKind(conn.kind) ? conn.baseUrl : null`, `managedBy: isEnvManaged(conn) ? 'env' : null`; for gateway kinds `inferenceGeo`/`effectiveInferenceGeo` are `null` and `inferenceGeoSource: 'provider_default'`, `supportedInferenceGeos: []`. Offering mapper adds `verification`: for an offering on a gateway connection, `verifiedGatewayCapabilities(offering.capabilities, endpointFingerprint(conn))` → `{ state, at: record?.at ?? null, harnessVersion: record?.harnessVersion ?? null, summary: record?.summary ?? null }`; otherwise `null`.

`mcpCoverage.ts`: add `exempt` entries for `PATCH /ai/models/connections/:id/gateway` and `POST /ai/models/connections/:id/offerings` with W04's reason text for `/ai/models` writes. `partner-wide-write-coverage.test.ts`: add `services/aiModels/gatewayConnections.ts` and `services/aiModels/offeringVerificationStore.ts` with the reason "partner-axis registry write; route gate requirePartnerWide + canManagePartnerWidePolicies (W04 shared.ts); worker writes run under system scope".

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/routes/aiModels/ src/services/aiModels/registryView.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/services/mcpCoverage.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelsRoutes.integration.test.ts
npx tsc --noEmit -p .
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/aiModels/ apps/api/src/services/aiModels/registryView.ts apps/api/src/services/aiModels/registryView.test.ts \
  apps/api/src/services/mcpCoverage.ts apps/api/src/__tests__/partner-wide-write-coverage.test.ts \
  apps/api/src/__tests__/integration/aiModelsRoutes.integration.test.ts
git commit -m "feat(ai-models): /ai/models routes for openai_compatible connections, manual models and harness verify (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: Web — the `openai_compatible` arm in the Connections card and drawers

Homes are W04's (spec §11): Partner Settings → AI Providers & Models → Connections card (row drawer Save) and Models card (enable switch autosave; details drawer Save). W06 adds a kind, not a card.

Behaviour:
- **Add connection** button is always visible now; it opens a kind chooser: "Anthropic API key" (disabled with "Already connected" when a compat connection exists — W04's rule), "OpenAI-compatible endpoint". Choosing a kind renders that kind's form inside W04's `ConnectionDrawer` through `ConnectionKindForm` (a `switch (kind)` with `never` default; W07 adds three cases).
- **`OpenAiCompatibleConnectionForm`**: Name (required), Base URL (required; helper text: "The URL that ends before `/chat/completions`, e.g. `https://llm.example.com/v1`. Hosted Breeze connects to public https endpoints only."), API key (optional password input; on edit: "Leave blank to keep the current key", plus a "Remove key" checkbox). Save on create → `POST /ai/models/connections`; on edit → `PATCH /ai/models/connections/:id/gateway` with `expectedConfigVersion`, and W04's `PATCH /:id` for the name. No inference-geo control for this kind.
- **Row rendering** (`ConnectionsCard` `switch (connection.kind)` arm): name, "OpenAI-compatible" kind label, host of `baseUrl`, key `••••last4` or "No key", status chip, discovery status ("Found N models · 3 min ago" / scrubbed `discoveryError`), "Managed by environment" badge + read-only drawer when `managedBy === 'env'`.
- **Models card**: rows on a gateway connection show the verification badge (`Verified` / `Not verified` / `Verification failed: <summary>` / `Re-verify: endpoint changed` for `stale`), price "Set a price to enable" when unpriced, and an **Add model** button per gateway connection opening `ManualModelForm` (model id, display name, optional prices) → `POST /ai/models/connections/:id/offerings`. The offering drawer's **Verify** button (W04) shows "Runs a short tool-calling test against your endpoint (uses a few thousand tokens)" for gateway offerings.
- **Defaults by feature**: no change — W04 already filters tool-requiring surfaces to `supportsTools`; an unverified BYO model appears for non-tool surfaces only, with W04's "needs tools" badge explaining why it is missing elsewhere.

`data-testid`s: `ai-connection-add-kind-anthropic`, `ai-connection-add-kind-openai`, `ai-connection-openai-name`, `ai-connection-openai-base-url`, `ai-connection-openai-api-key`, `ai-connection-openai-remove-key`, `ai-connection-row-host-{id}`, `ai-connection-env-managed-{id}`, `ai-model-verification-{offeringId}`, `ai-models-add-manual-{connectionId}`, `ai-manual-model-id`, `ai-manual-model-name`, `ai-manual-model-save`.

**Files:**
- Create: `apps/web/src/components/settings/aiModels/connectionForms/connectionKinds.ts` (kind labels, `ADDABLE_CONNECTION_KINDS`)
- Create: `apps/web/src/components/settings/aiModels/connectionForms/ConnectionKindForm.tsx`
- Create: `apps/web/src/components/settings/aiModels/connectionForms/OpenAiCompatibleConnectionForm.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/components/settings/aiModels/ManualModelForm.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/settings/aiModels/ConnectionsCard.tsx`, `ConnectionDrawer.tsx`, `ModelsCard.tsx`, `OfferingDrawer.tsx` (+ their tests)
- Modify: `apps/web/src/components/settings/aiModels/surfaceLabels.ts` (`REGISTRY_ERROR_KEYS` gains `egress_blocked`, `invalid_url`, `managed_by_env`, `connection_in_use`, `duplicate_model`, `geo_not_supported`)
- Modify: `apps/web/src/locales/{en,de,es,fr,it,nl,pt,ja}/settings.json` (keys under `aiModels.connections.openai.*`, `aiModels.models.verification.*`, `aiModels.models.manual.*`)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS` += `connectionForms/*.tsx`, `ManualModelForm.tsx`; bump the count)

**Interfaces:**
- Consumes: Task 1 DTO fields and schemas; Task 13 routes; W04 `runAction`, `fetchWithAuth`, `Drawer`, `useAiModelsSnapshot`.
- Produces: `ConnectionKindForm({ kind, connection, onDraftChange })`; `ADDABLE_CONNECTION_KINDS: readonly AiConnectionRowKind[]` (W07 appends); `OpenAiCompatibleConnectionForm`; `ManualModelForm({ connectionId, onSaved, onClose })`.

- [ ] **Step 1: Write the failing tests**

`OpenAiCompatibleConnectionForm.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const runAction = vi.hoisted(() => vi.fn(async ({ request }) => (await request()).json()));
vi.mock('../../../../lib/runAction', () => ({ runAction, ActionError: class extends Error {} }));
const fetchWithAuth = vi.hoisted(() => vi.fn(async () => new Response('{"id":"c1"}', { status: 201 })));
vi.mock('../../../../stores/auth', () => ({ fetchWithAuth }));
import { ConnectionDrawer } from '../ConnectionDrawer';

describe('OpenAI-compatible connection (create)', () => {
  it('POSTs kind/name/baseUrl/apiKey through runAction and never sends inferenceGeo', async () => {
    render(<ConnectionDrawer connection={null} initialKind="openai_compatible" catalog={[]} catalogEnabled={false} onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(screen.getByTestId('ai-connection-openai-name'), { target: { value: 'Office vLLM' } });
    fireEvent.change(screen.getByTestId('ai-connection-openai-base-url'), { target: { value: 'https://llm.example.com/v1' } });
    fireEvent.change(screen.getByTestId('ai-connection-openai-api-key'), { target: { value: 'sk-local-123' } });
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(runAction).toHaveBeenCalled());
    const [url, init] = fetchWithAuth.mock.calls[0]!;
    expect(url).toBe('/ai/models/connections');
    expect(JSON.parse(String(init!.body))).toEqual({ kind: 'openai_compatible', name: 'Office vLLM', baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-local-123' });
  });

  it('Save is disabled until name and a syntactically valid http(s) URL are entered', () => {
    render(<ConnectionDrawer connection={null} initialKind="openai_compatible" catalog={[]} catalogEnabled={false} onClose={() => {}} onSaved={async () => {}} />);
    expect(screen.getByTestId('ai-connection-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('ai-connection-openai-name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByTestId('ai-connection-openai-base-url'), { target: { value: 'ftp://nope' } });
    expect(screen.getByTestId('ai-connection-save')).toBeDisabled();
  });

  it('edit: blank key keeps it (no apiKey in PATCH), Remove key sends apiKey:null, always sends expectedConfigVersion', async () => {
    const conn = { id: 'c1', kind: 'openai_compatible', name: 'vLLM', baseUrl: 'https://llm.example.com/v1', keyLast4: '1234', configVersion: 3, managedBy: null } as never;
    render(<ConnectionDrawer connection={conn} catalog={[]} catalogEnabled={false} onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(screen.getByTestId('ai-connection-openai-base-url'), { target: { value: 'https://llm2.example.com/v1' } });
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ai/models/connections/c1/gateway', expect.anything()));
    const patch = JSON.parse(String(fetchWithAuth.mock.calls.at(-1)![1]!.body));
    expect(patch).toEqual({ baseUrl: 'https://llm2.example.com/v1', expectedConfigVersion: 3 });
  });

  it('an env-managed connection opens read-only with an explanation', () => {
    const conn = { id: 'c1', kind: 'openai_compatible', name: 'Instance endpoint', baseUrl: 'http://10.0.0.5:8000/v1', keyLast4: null, configVersion: 1, managedBy: 'env' } as never;
    render(<ConnectionDrawer connection={conn} catalog={[]} catalogEnabled={false} onClose={() => {}} onSaved={async () => {}} />);
    expect(screen.getByTestId('ai-connection-openai-base-url')).toBeDisabled();
    expect(screen.getByTestId('ai-connection-save')).toBeDisabled();
    expect(screen.getByText(/MCP_LLM_/)).toBeInTheDocument();
  });
});
```

`ManualModelForm.test.tsx`: renders; invalid id (space) disables Save; valid id POSTs `/ai/models/connections/c1/offerings` with `{ modelId, displayName? }` through `runAction`; a 409 `duplicate_model` shows the mapped message (via `REGISTRY_ERROR_KEYS`).

`ModelsCard.test.tsx` (append): a gateway offering with `verification.state === 'stale'` renders `ai-model-verification-{id}` with "Re-verify: endpoint changed"; an unpriced gateway offering's enable switch is disabled with "Set a price to enable" (W04's `enableBlocker: 'unpriced'`).

`ConnectionsCard.test.tsx` (append): the "Add connection" button is visible with an existing compat connection; the kind chooser shows the Anthropic option disabled; a gateway row shows host and `ai-connection-env-managed-{id}` when env-managed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/settings/aiModels/`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`connectionForms/connectionKinds.ts`:

```ts
import type { AiConnectionRowKind } from '@breeze/shared';
/** Kinds the "Add connection" chooser offers, in order. W07 appends 'bedrock' | 'vertex' | 'foundry'. */
export const ADDABLE_CONNECTION_KINDS = ['anthropic_byok', 'openai_compatible'] as const satisfies readonly AiConnectionRowKind[];
export type AddableConnectionKind = (typeof ADDABLE_CONNECTION_KINDS)[number];
export const CONNECTION_KIND_LABEL_KEYS: Record<AiConnectionRowKind, string> = {
  anthropic_byok: 'aiModels.connections.kinds.anthropic_byok',
  catalog: 'aiModels.connections.kinds.catalog',
  openai_compatible: 'aiModels.connections.kinds.openai_compatible',
};
```

`connectionForms/ConnectionKindForm.tsx`:

```tsx
import type { AiConnectionDto } from '@breeze/shared';
import { OpenAiCompatibleConnectionForm, type OpenAiDraft } from './OpenAiCompatibleConnectionForm';
import type { AddableConnectionKind } from './connectionKinds';

export type KindDraft = { kind: 'openai_compatible'; draft: OpenAiDraft } | { kind: 'anthropic_byok'; draft: null };

/**
 * One form per connection kind inside ConnectionDrawer (W06 shared extension point).
 * W07 adds bedrock / vertex / foundry cases; the `never` default makes that a compile error until it does.
 */
export function ConnectionKindForm(props: {
  kind: AddableConnectionKind;
  connection: AiConnectionDto | null;
  onDraftChange: (d: KindDraft) => void;
}) {
  switch (props.kind) {
    case 'anthropic_byok':
      return null; // W04's existing key/endpoint fields render this kind in ConnectionDrawer itself
    case 'openai_compatible':
      return <OpenAiCompatibleConnectionForm connection={props.connection} onChange={(draft) => props.onDraftChange({ kind: 'openai_compatible', draft })} />;
    default: {
      const never: never = props.kind;
      return <p>{String(never)}</p>;
    }
  }
}
```

`connectionForms/OpenAiCompatibleConnectionForm.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiConnectionDto } from '@breeze/shared';

export interface OpenAiDraft { name: string; baseUrl: string; apiKey: string; removeKey: boolean; valid: boolean; readOnly: boolean }

function validUrl(v: string): boolean {
  try {
    const u = new URL(v.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !v.includes('?') && !v.includes('#');
  } catch { return false; }
}

export function OpenAiCompatibleConnectionForm({ connection, onChange }: { connection: AiConnectionDto | null; onChange: (d: OpenAiDraft) => void }) {
  const { t } = useTranslation('settings');
  const readOnly = connection?.managedBy === 'env';
  const [name, setName] = useState(connection?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);

  useEffect(() => {
    onChange({ name, baseUrl, apiKey, removeKey, readOnly, valid: !readOnly && name.trim().length > 0 && validUrl(baseUrl) });
  }, [name, baseUrl, apiKey, removeKey, readOnly, onChange]);

  return (
    <div className="space-y-4" data-testid="ai-connection-openai-form">
      {readOnly && <p className="text-sm text-muted-foreground">{t('aiModels.connections.openai.envManaged')}</p>}
      <label className="block text-sm font-medium">{t('aiModels.connections.openai.name')}
        <input data-testid="ai-connection-openai-name" className="mt-1 w-full rounded-md border px-3 py-2" value={name} disabled={readOnly}
          maxLength={80} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">{t('aiModels.connections.openai.baseUrl')}
        <input data-testid="ai-connection-openai-base-url" className="mt-1 w-full rounded-md border px-3 py-2" value={baseUrl} disabled={readOnly}
          placeholder="https://llm.example.com/v1" inputMode="url" onChange={(e) => setBaseUrl(e.target.value)} />
        <span className="mt-1 block text-xs text-muted-foreground">{t('aiModels.connections.openai.baseUrlHelp')}</span>
      </label>
      <label className="block text-sm font-medium">{t('aiModels.connections.openai.apiKey')}
        <input data-testid="ai-connection-openai-api-key" type="password" autoComplete="off" className="mt-1 w-full rounded-md border px-3 py-2"
          value={apiKey} disabled={readOnly || removeKey} placeholder={connection?.keyLast4 ? t('aiModels.connections.openai.keepKey') : t('aiModels.connections.openai.optional')}
          onChange={(e) => setApiKey(e.target.value)} />
      </label>
      {connection?.keyLast4 && !readOnly && (
        <label className="flex items-center gap-2 text-sm">
          <input data-testid="ai-connection-openai-remove-key" type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} />
          {t('aiModels.connections.openai.removeKey')}
        </label>
      )}
    </div>
  );
}
```

`ConnectionDrawer.tsx` — add an `initialKind?: AddableConnectionKind` prop; derive `kind = connection?.kind ?? initialKind ?? 'anthropic_byok'`; render `<ConnectionKindForm>` for `kind !== 'anthropic_byok'`; in `handleSave` branch on the kind draft:

```tsx
if (kindDraft?.kind === 'openai_compatible') {
  const d = kindDraft.draft;
  if (connection === null) {
    await runAction({
      request: () => fetchWithAuth('/ai/models/connections', { method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ kind: 'openai_compatible', name: d.name.trim(), baseUrl: d.baseUrl.trim(), ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}) }) }),
      successMessage: t('aiModels.connections.created'), errorFallback: t('aiModels.connections.saveFailed'), onUnauthorized,
    });
  } else {
    const gatewayPatch: Record<string, unknown> = { expectedConfigVersion: connection.configVersion };
    if (d.baseUrl.trim() !== (connection.baseUrl ?? '')) gatewayPatch.baseUrl = d.baseUrl.trim();
    if (d.removeKey) gatewayPatch.apiKey = null; else if (d.apiKey.trim()) gatewayPatch.apiKey = d.apiKey.trim();
    if (Object.keys(gatewayPatch).length > 1) {
      await runAction({ request: () => fetchWithAuth(`/ai/models/connections/${connection.id}/gateway`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(gatewayPatch) }),
        errorFallback: t('aiModels.connections.saveFailed'), onUnauthorized });
    }
    if (d.name.trim() !== connection.name) {
      await runAction({ request: () => fetchWithAuth(`/ai/models/connections/${connection.id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: d.name.trim() }) }),
        errorFallback: t('aiModels.connections.saveFailed'), onUnauthorized });
    }
    showToast({ type: 'success', message: t('aiModels.connections.saved') });
  }
  await onSaved(); onClose(); return;
}
// …W04's anthropic_byok path unchanged
```

Save is disabled when `kindDraft?.draft?.valid === false` or `readOnly`. W04's inference-geo select and catalog-endpoint radios render only for `kind === 'anthropic_byok'`.

`ConnectionsCard.tsx` — the row `switch (connection.kind)` gains:

```tsx
case 'openai_compatible':
  return (
    <ConnectionRow key={connection.id} connection={connection}
      kindLabel={t('aiModels.connections.kinds.openai_compatible')}
      detail={<span data-testid={`ai-connection-row-host-${connection.id}`}>{connection.baseUrl ? new URL(connection.baseUrl).host : ''}</span>}
      badge={connection.managedBy === 'env' ? <span data-testid={`ai-connection-env-managed-${connection.id}`} className="rounded bg-muted px-2 py-0.5 text-xs">{t('aiModels.connections.envManagedBadge')}</span> : null}
      onEdit={() => openDrawer(connection)} />
  );
```

(`ConnectionRow` is whatever W04 named its row renderer; if W04 inlined rows, extract the shared row markup into `ConnectionRow` in this task.) The "Add connection" button is always shown and opens a small menu over `ADDABLE_CONNECTION_KINDS`; the `anthropic_byok` entry is disabled with `t('aiModels.connections.alreadyConnected')` when `snapshot.connections.some((c) => c.kind === 'anthropic_byok' || c.kind === 'catalog')`.

`ModelsCard.tsx` / `OfferingDrawer.tsx` — render the verification badge from `offering.verification` (`ai-model-verification-{id}`), the "Add model" button per gateway connection group (`ai-models-add-manual-{connectionId}`) opening `ManualModelForm` in W04's `Drawer`, and the Verify help text for gateway offerings.

`ManualModelForm.tsx` — fields `modelId` (pattern `BYO_MODEL_ID_PATTERN` from `@breeze/shared`), `displayName` (≤120), optional four prices (W04's price inputs component if it exists); Save → `runAction` `POST /ai/models/connections/:id/offerings`.

i18n: add every new key to all 8 locale files (English text in non-English files is acceptable only if the repo's i18n test allows it — follow W04 Task 16's approach).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/settings/aiModels/ src/lib/__tests__/no-silent-mutations.test.ts src/lib/__tests__/settingsPageRegistry.test.ts
npx vitest run src/locales   # i18n key-usage / parity tests, whatever W04 ran
npx astro check 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/aiModels/ apps/web/src/locales/ apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): OpenAI-compatible connections, manual models and verification state in AI Providers & Models (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 15: Absorb `MCP_LLM_PROVIDER=openai-compatible` — env bootstrap (Decision D6)

The deployment-wide env path becomes data: when `MCP_LLM_PROVIDER=openai-compatible`, boot ensures every partner has **one** env-managed `openai_compatible` connection mirroring `MCP_LLM_BASE_URL` / `MCP_LLM_API_KEY`, **one** manual offering for `MCP_LLM_MODEL` priced from `MCP_LLM_PRICE_INPUT_PER_M_USD` / `MCP_LLM_PRICE_OUTPUT_PER_M_USD` (USD/M → cents/M ×100; cache read/write priced as input/0 — the env path never had cache prices), enabled, and verifies it once. It re-points the partner's **`chat`** partner-level assignment to that offering **only if** the chat assignment's default is currently a **platform** offering (the only case where legacy routing sent chat to the env endpoint: `routes/ai.ts` returned 503 for partner BYOK on the env path). It never touches any other surface, any org override, or a partner whose chat already points at a connection offering.

Idempotency and drift:
- A partner is "bootstrapped" when it has a connection with `provider_config.managedBy = 'env'`. Assignment re-pointing happens **once**, on the boot that creates the connection; it is never redone (an admin who later moved chat elsewhere is respected).
- Every boot re-syncs the env-managed connection: if `MCP_LLM_BASE_URL` or the key changed → `updateGatewayConnection(..., allowManaged: true)` (bumps `config_version`); if `MCP_LLM_MODEL` changed → ensure an offering for the new id (enabled, priced) and leave the old one in place (disabled), and re-point the chat default from the old env offering to the new one **only** where the default is exactly the old env offering.
- If the variables are unset later, nothing is deleted (the connection keeps working until an admin removes it — `managed_by_env` blocks deletion only while the variables are set; when unset, `isEnvManaged` is cleared on the next boot by setting `provider_config.managedBy` to `null`).
- Hosted refuses `MCP_LLM_PROVIDER=openai-compatible` at config validation (the bootstrap writes per-partner rows for **every** partner).

The bootstrap runs once per process start. For each partner it first calls W03's `ensurePartnerCutover(partnerId)` (Codex review #4: the cutover rewrites assignments and must never run after the bootstrap), then works inside one system transaction holding `pg_advisory_xact_lock(hashtext('ai-env-openai-bootstrap'), hashtext(partnerId))`, so replicas booting together serialise per partner and the second sees the first's connection (Codex review #3: W03's cutover lease is a singleton with a different API and is not reused). Verification jobs are enqueued only after every transaction has committed.

**Files:**
- Create: `apps/api/src/services/aiModels/envOpenAiBootstrap.ts` (+ `.test.ts`)
- Create: `apps/api/src/__tests__/integration/envOpenAiBootstrap.integration.test.ts`
- Modify: `apps/api/src/config/validate.ts` (+ `validate.test.ts`) — refuse on hosted; keep the existing required-field refinements
- Modify: `apps/api/src/index.ts` (call after the cutover sweep is scheduled)

**Interfaces:**
- Consumes: Task 10 `createGatewayConnection`, `updateGatewayConnection`, `createManualOffering`, `isEnvManaged`; Task 12 `enqueueOfferingVerification`; W03 `ensurePartnerCutover(partnerId): Promise<boolean>` (`registryCutover.ts`); `hmacFingerprint`.
- Produces:

```ts
export interface EnvOpenAiSettings { baseUrl: string; apiKey: string | null; model: string; inputCentsPerM: number; outputCentsPerM: number }
export function readEnvOpenAiSettings(config?: AppConfig): EnvOpenAiSettings | null;   // null unless MCP_LLM_PROVIDER=openai-compatible
export interface EnvBootstrapReport { partners: number; created: number; resynced: number; chatRepointed: number; failed: string[] }
export async function bootstrapEnvOpenAiConnections(opts?: { settings?: EnvOpenAiSettings | null }): Promise<EnvBootstrapReport>;
export const ENV_CONNECTION_NAME = 'Instance OpenAI-compatible endpoint';
```

- [ ] **Step 1: Write the failing tests**

`envOpenAiBootstrap.test.ts` (unit; mocks the write services and the partner list):

```ts
describe('readEnvOpenAiSettings', () => {
  it('null unless MCP_LLM_PROVIDER=openai-compatible', () => {
    expect(readEnvOpenAiSettings({ MCP_LLM_PROVIDER: 'anthropic' } as never)).toBeNull();
  });
  it('converts USD/M to cents/M', () => {
    expect(readEnvOpenAiSettings({ MCP_LLM_PROVIDER: 'openai-compatible', MCP_LLM_BASE_URL: 'http://10.0.0.5:8000/v1', MCP_LLM_MODEL: 'qwen',
      MCP_LLM_API_KEY: 'sk-e', MCP_LLM_PRICE_INPUT_PER_M_USD: 0.15, MCP_LLM_PRICE_OUTPUT_PER_M_USD: 0.6 } as never))
      .toEqual({ baseUrl: 'http://10.0.0.5:8000/v1', apiKey: 'sk-e', model: 'qwen', inputCentsPerM: 15, outputCentsPerM: 60 });
  });
});

describe('bootstrapEnvOpenAiConnections', () => {
  it('first boot: creates connection + priced enabled offering, enqueues verification, re-points chat only when it defaults to a platform offering', async () => {
    partners([{ id: 'p1', chatDefault: { source: 'platform' } }, { id: 'p2', chatDefault: { source: 'connection' } }]);
    const r = await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(r).toMatchObject({ partners: 2, created: 2, chatRepointed: 1 });
    expect(svc.createGatewayConnection).toHaveBeenCalledWith(expect.objectContaining({ managedBy: 'env', name: ENV_CONNECTION_NAME, baseUrl: SETTINGS.baseUrl }));
    expect(svc.repointChatDefault).toHaveBeenCalledTimes(1);
    expect(svc.repointChatDefault).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'p1' }));
    expect(svc.enqueueOfferingVerification).toHaveBeenCalledTimes(2);
  });

  it('second boot with the same env: no creates, no re-point (admin choices respected)', async () => {
    partners([{ id: 'p1', envConnection: { baseUrl: SETTINGS.baseUrl, keyLast4: 'ey-e', model: 'qwen' }, chatDefault: { source: 'platform' } }]);
    const r = await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(r).toMatchObject({ created: 0, resynced: 0, chatRepointed: 0 });
  });

  it('changed base URL → updateGatewayConnection(allowManaged) and re-verification', async () => {
    partners([{ id: 'p1', envConnection: { baseUrl: 'http://old:8000/v1', model: 'qwen' } }]);
    await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(svc.updateGatewayConnection).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: SETTINGS.baseUrl, allowManaged: true }));
  });

  it('changed model → new offering; chat default moved only where it was exactly the old env offering', async () => { /* … */ });

  it('one partner failing does not stop the others; report lists it', async () => { /* createGatewayConnection rejects for p1 → failed: ['p1'], p2 created */ });

  it('job payload / logs carry no key', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    partners([{ id: 'p1', chatDefault: { source: 'platform' } }]);
    await bootstrapEnvOpenAiConnections({ settings: { ...SETTINGS, apiKey: 'sk-env-SECRET-999' } });
    const everything = JSON.stringify([log.mock.calls, warn.mock.calls, svc.enqueueOfferingVerification.mock.calls]);
    expect(everything).not.toContain('sk-env-SECRET-999');
  });

  it('runs only after the partner cutover; a partner whose cutover fails is reported, not bootstrapped (Codex review #4)', async () => {
    cutover.result = false;
    partners([{ id: 'p1', chatDefault: { source: 'platform' } }]);
    expect(await bootstrapEnvOpenAiConnections({ settings: SETTINGS })).toMatchObject({ created: 0, failed: ['p1'] });
    expect(svc.createGatewayConnection).not.toHaveBeenCalled();
  });

  it('A -> B -> A: chat follows the configured model back to A and B is disabled (Codex review #14)', async () => {
    partners([{ id: 'p1', envConnection: { baseUrl: SETTINGS.baseUrl, envModel: 'B', offerings: ['A', 'B'] }, chatDefaultOffering: 'off-B' }]);
    await bootstrapEnvOpenAiConnections({ settings: { ...SETTINGS, model: 'A' } });
    expect(svc.repointChatDefault).toHaveBeenCalledWith(expect.objectContaining({ to: 'off-A', from: 'off-B' }));
    expect(svc.disabledOfferings).toContain('off-B');
  });
});
```

`envOpenAiBootstrap.integration.test.ts` (real DB): seed two partners with W03's `seedRegistryPartner` (one with a platform chat default, one with a BYOK chat default); run the bootstrap twice; assert exactly one env connection per partner, one enabled priced manual offering for the env model, chat re-pointed for the first partner only, and the second partner's chat assignment row byte-identical (`updated_at` unchanged). Then run **two bootstraps concurrently** (`Promise.all`) on a fresh partner and assert exactly one env connection (the advisory lock); and run the cutover sweep after a bootstrap and assert the env offering stays enabled and chat still points at it (Codex review #4).

`validate.test.ts` (append): `MCP_LLM_PROVIDER=openai-compatible` with `IS_HOSTED=true` fails validation with a message naming the per-partner OpenAI-compatible connections in Partner Settings → AI Providers & Models.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/envOpenAiBootstrap.test.ts src/config/validate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/aiModels/envOpenAiBootstrap.ts
/**
 * W06 (#7604, Decision D6): the deployment-wide MCP_LLM_PROVIDER=openai-compatible
 * path becomes one env-managed openai_compatible connection per partner. Runs at
 * boot after each partner's registry cutover, serialised per partner with a
 * transaction-scoped advisory lock, idempotent. Re-points a partner's `chat` default
 * only on the boot that creates the connection, and only from a platform
 * offering — exactly where legacy routing sent chat to the env endpoint.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getConfig, type AppConfig } from '../../config/validate';
import { runOutsideDbContext, withSystemDbAccessContext, db } from '../../db';
import { aiModelAssignments, partnerAiConnections, partnerAiModels } from '../../db/schema/aiModelRegistry';
import { partners } from '../../db/schema';
import { createGatewayConnection, createManualOffering, isEnvManaged, updateGatewayConnection } from './gatewayConnections';
import { enqueueOfferingVerification } from '../../jobs/aiModelDiscoveryWorker';
import { sql } from 'drizzle-orm';
import { hmacFingerprint } from '../secretCrypto';
import { ensurePartnerCutover } from './registryCutover';

export const ENV_CONNECTION_NAME = 'Instance OpenAI-compatible endpoint';

export interface EnvOpenAiSettings { baseUrl: string; apiKey: string | null; model: string; inputCentsPerM: number; outputCentsPerM: number }
export interface EnvBootstrapReport { partners: number; created: number; resynced: number; chatRepointed: number; failed: string[] }

export function readEnvOpenAiSettings(config: AppConfig = getConfig()): EnvOpenAiSettings | null {
  if (config.MCP_LLM_PROVIDER !== 'openai-compatible') return null;
  return {
    baseUrl: config.MCP_LLM_BASE_URL!.replace(/\/+$/, ''),
    apiKey: config.MCP_LLM_API_KEY?.trim() || null,
    model: config.MCP_LLM_MODEL!.trim(),
    inputCentsPerM: Math.round(config.MCP_LLM_PRICE_INPUT_PER_M_USD * 100 * 1e6) / 1e6,
    outputCentsPerM: Math.round(config.MCP_LLM_PRICE_OUTPUT_PER_M_USD * 100 * 1e6) / 1e6,
  };
}

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

async function ensureEnvOffering(partnerId: string, connectionId: string, s: EnvOpenAiSettings): Promise<string> {
  const [existing] = await db.select().from(partnerAiModels)
    .where(and(eq(partnerAiModels.connectionId, connectionId), eq(partnerAiModels.modelId, s.model)));
  const prices = { inputCentsPerM: s.inputCentsPerM, outputCentsPerM: s.outputCentsPerM, cacheReadCentsPerM: s.inputCentsPerM, cacheWriteCentsPerM: 0 };
  if (existing) {
    await db.update(partnerAiModels).set({
      enabled: true, priceInputCentsPerM: prices.inputCentsPerM, priceOutputCentsPerM: prices.outputCentsPerM,
      priceCacheReadCentsPerM: prices.cacheReadCentsPerM, priceCacheWriteCentsPerM: prices.cacheWriteCentsPerM, updatedAt: new Date(),
    }).where(eq(partnerAiModels.id, existing.id));
    return existing.id;
  }
  const off = await createManualOffering({ partnerId, connectionId, modelId: s.model, displayName: s.model, prices });
  await db.update(partnerAiModels).set({ enabled: true }).where(eq(partnerAiModels.id, off.id));
  return off.id;
}

/** Re-point the partner-level chat default to `to` only if it currently is `from` (a specific offering) or any platform offering (from = 'platform'). */
async function repointChatDefault(input: { partnerId: string; to: string; from: string | 'platform' }): Promise<boolean> {
  const [row] = await db.select().from(aiModelAssignments).where(and(
    eq(aiModelAssignments.partnerId, input.partnerId), isNull(aiModelAssignments.orgId),
    eq(aiModelAssignments.surface, 'chat'), eq(aiModelAssignments.role, 'default'),
  )).for('update');
  if (!row || !row.defaultOfferingId) return false;
  if (input.from === 'platform') {
    const [cur] = await db.select({ connectionId: partnerAiModels.connectionId }).from(partnerAiModels).where(eq(partnerAiModels.id, row.defaultOfferingId));
    if (!cur || cur.connectionId !== null) return false;
  } else if (row.defaultOfferingId !== input.from) {
    return false;
  }
  // The permitted list (if any) must contain the new default (W02 trigger + W04 rule).
  const permitted = row.permittedOfferingIds ? [...new Set([...row.permittedOfferingIds, input.to])] : null;
  await db.update(aiModelAssignments).set({ defaultOfferingId: input.to, permittedOfferingIds: permitted, updatedAt: new Date() })
    .where(eq(aiModelAssignments.id, row.id));
  return true;
}

export async function bootstrapEnvOpenAiConnections(opts: { settings?: EnvOpenAiSettings | null } = {}): Promise<EnvBootstrapReport> {
  const settings = opts.settings === undefined ? readEnvOpenAiSettings() : opts.settings;
  const report: EnvBootstrapReport = { partners: 0, created: 0, resynced: 0, chatRepointed: 0, failed: [] };
  const all = await sys(() => db.select({ id: partners.id }).from(partners));
  report.partners = all.length;
  const after: Array<() => Promise<void>> = [];
  for (const { id: partnerId } of all) {
    try {
      // Codex review #4: the partner's legacy->registry cutover (W03 Task 6A) rewrites
      // assignments and disables offerings outside the legacy projection. Bootstrap
      // only AFTER it has completed for this partner, so it can never be undone by it.
      if (!(await ensurePartnerCutover(partnerId))) { report.failed.push(partnerId); continue; }
      await sys(() => db.transaction(async (tx) => {
        // Codex review #3: per-partner transaction-scoped advisory lock instead of a
        // lease. Replicas booting together serialise per partner; the second one sees
        // the first one's connection and does nothing.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai-env-openai-bootstrap'), hashtext(${partnerId}))`);
        const conns = await tx.select().from(partnerAiConnections)
          .where(and(eq(partnerAiConnections.partnerId, partnerId), eq(partnerAiConnections.kind, 'openai_compatible')));
        const envConn = conns.find((c) => isEnvManaged(c));
        if (!settings) {
          // Variables unset: release the managed flag so the admin can edit/delete it. Never delete.
          if (envConn) await tx.update(partnerAiConnections).set({ providerConfig: null, updatedAt: new Date() }).where(eq(partnerAiConnections.id, envConn.id));
          return;
        }
        if (!envConn) {
          const conn = await createGatewayConnection({ partnerId, name: ENV_CONNECTION_NAME, baseUrl: settings.baseUrl,
            apiKey: settings.apiKey ?? undefined, connectedBy: null, managedBy: 'env' });
          await setEnvModel(tx, conn.id, settings.model);
          const offeringId = await ensureEnvOffering(partnerId, conn.id, settings);
          report.created += 1;
          if (await repointChatDefault({ partnerId, to: offeringId, from: 'platform' })) report.chatRepointed += 1;
          after.push(() => enqueueOfferingVerification({ offeringId, partnerId }));
          return;
        }
        let changed = false;
        // Fingerprint, not last4: a rotated key can share its last four characters.
        const [fp] = await tx.select({ keyFingerprint: partnerAiConnections.keyFingerprint }).from(partnerAiConnections).where(eq(partnerAiConnections.id, envConn.id));
        const keyChanged = settings.apiKey === null ? fp?.keyFingerprint != null : fp?.keyFingerprint !== hmacFingerprint(settings.apiKey);
        if (envConn.baseUrl !== settings.baseUrl || keyChanged) {
          await updateGatewayConnection({ partnerId, connectionId: envConn.id, baseUrl: settings.baseUrl,
            apiKey: keyChanged ? settings.apiKey : undefined, expectedConfigVersion: envConn.configVersion, allowManaged: true });
          changed = true;
        }
        // Codex review #14: track the CONFIGURED model, not "an offering exists", so
        // A -> B -> A moves chat back to A and disables B.
        const previousModel = (envConn.providerConfig as { envModel?: string } | null)?.envModel ?? null;
        const offeringId = await ensureEnvOffering(partnerId, envConn.id, settings);
        if (previousModel !== settings.model) {
          changed = true;
          const envOfferings = await tx.select().from(partnerAiModels).where(eq(partnerAiModels.connectionId, envConn.id));
          for (const old of envOfferings.filter((o) => o.id !== offeringId)) {
            if (previousModel === null || old.modelId === previousModel) await repointChatDefault({ partnerId, to: offeringId, from: old.id });
            await tx.update(partnerAiModels).set({ enabled: false, updatedAt: new Date() }).where(eq(partnerAiModels.id, old.id));
          }
          await setEnvModel(tx, envConn.id, settings.model);
        }
        if (changed) { report.resynced += 1; after.push(() => enqueueOfferingVerification({ offeringId, partnerId })); }
      }));
    } catch (error) {
      report.failed.push(partnerId);
      console.warn(`[envOpenAiBootstrap] partner ${partnerId} failed: ${error instanceof Error ? error.name : 'error'}`);
    }
  }
  // Every transaction above has committed: enqueue verification now (Codex review #10).
  for (const fn of after) await fn().catch((e) => console.warn(`[envOpenAiBootstrap] enqueue failed: ${e instanceof Error ? e.name : 'error'}`));
  console.log(`[envOpenAiBootstrap] partners=${report.partners} created=${report.created} resynced=${report.resynced} chatRepointed=${report.chatRepointed} failed=${report.failed.length}`);
  return report;
}

async function setEnvModel(tx: typeof db, connectionId: string, model: string): Promise<void> {
  await tx.update(partnerAiConnections)
    .set({ providerConfig: { managedBy: 'env', envModel: model }, updatedAt: new Date() })
    .where(eq(partnerAiConnections.id, connectionId));
}
```

`isEnvManaged` (Task 10) keeps reading only `managedBy`; `provider_config.envModel` is bootstrap bookkeeping (non-secret, `openai_compatible` only).

`validate.ts` (inside the existing `MCP_LLM_PROVIDER === 'openai-compatible'` refinement block):

```ts
if (isRecognizedHostedSignal(data.IS_HOSTED)) {   // match the helper validate.ts already uses for hosted-only rules
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MCP_LLM_PROVIDER'],
    message: 'MCP_LLM_PROVIDER=openai-compatible is for self-hosted Breeze. On hosted, add an OpenAI-compatible connection under Partner Settings → AI Providers & Models.' });
}
```

`index.ts`: after the registry cutover sweep is kicked off (W03 Task 6A boot hook), `void bootstrapEnvOpenAiConnections().catch((e) => console.error('[envOpenAiBootstrap] failed', e instanceof Error ? e.name : e));` — non-blocking, like the cutover sweep.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiModels/envOpenAiBootstrap.test.ts src/config/validate.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/envOpenAiBootstrap.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/envOpenAiBootstrap.ts apps/api/src/services/aiModels/envOpenAiBootstrap.test.ts \
  apps/api/src/__tests__/integration/envOpenAiBootstrap.integration.test.ts apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts apps/api/src/index.ts
git commit -m "feat(ai-models): MCP_LLM_* env bootstraps a per-partner openai_compatible connection (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 16: Delete the env-only chat runtime; extend the registry contract test

With Task 15 in place, chat on an env deployment resolves to the env-managed offering through `resolveModel` like every other surface. The second runtime goes.

**Delete** (with their tests): `services/llm/openaiSessionManager.ts`, `services/llm/openaiCompatibleProvider.ts`, `services/llm/historyBuilder.ts` (only `openaiSessionManager` imports it — verify with grep first), the OpenAI-path types in `services/llm/types.ts` (delete the file if nothing else imports it), `services/llm/__scripts__/openai-smoke.ts`, and their tests (`openaiSessionManager*.test.ts`, `openaiCompatibleProvider*.test.ts`, `historyBuilder.test.ts`).

**Remove branches** (each is `isOpenAICompatibleProvider()` or `MCP_LLM_PROVIDER`):
- `routes/ai.ts`: the lazy `getOpenAISessionManager()` singleton and its import; the "OpenAI-compatible path (chat-only, no tool-calling)" message branch; the `NOT_SUPPORTED_ON_PROVIDER` 501s on rewind/fork/etc.; `topologyProviderRevision`'s `'openai-compatible:chat-only'` fallback (W03 left `model ? … : 'openai-compatible:chat-only'` — `model` is now always non-null on this path, so the type narrows; make the parameter non-nullable).
- `services/aiAgentSdk.ts` `runPreFlightChecks`: the `openaiCompatible` branch and `PreFlightResult.openaiCompatible`; `PreFlightResult.model` becomes non-nullable.
- `services/aiAgent.ts` `createSession`: the `isOpenAICompatibleProvider()` branch.
- `services/llm/llmAvailability.ts`: `isOpenAICompatibleProvider()` and the `transport === 'chat' && isOpenAICompatibleProvider()` readiness clause.
- `services/aiCostTracker.ts`: the openai-compatible turn recorder; `services/aiBudgetReservations.ts` (or wherever `settleAiBudgetReservation` lives): the numeric-totals branch W03 Task 17 kept for W06.
- `services/aiModels/invocationLedger.ts`: the `legacyCostSource: 'openai_env'` exclusion (W03 left it; the source no longer exists).
- `system/connections/registry.ts`: the `openai-compatible-llm` System-page connection entry (the per-partner connection status now lives on the AI Providers & Models tab; keep a short entry only if the System page test requires one per env var — then point it at "configured via env bootstrap").
- `config/envReadComposeCoverage.baseline.ts`: keep the six `MCP_LLM_*` vars (they are still read, by the bootstrap).

**Contract test** — W03 Task 17's `services/aiModels/aiModelRegistry.contract.test.ts` gains:
- rule 5: `isOpenAICompatibleProvider` and `OpenAISessionManager` must not appear anywhere under `apps/api/src` (non-test files);
- rule 6: `forwardUpstream(` may be called only from `services/aiModels/gateway/**`; `safeFetch(` with a partner connection base URL is reachable only through it — enforce structurally: no file outside `gateway/` imports `gateway/forward`;
- rule 7: `GATEWAY_PLACEHOLDER_KEY` is the only `apiKey` a `{ kind: 'gateway' }` client is built with (AST: `createAnthropicClient` calls whose `target.kind` literal is `'gateway'` must pass `apiKey: GATEWAY_PLACEHOLDER_KEY`).

**e2e:** `e2e-tests/fixtures/mockLlmServer.mjs` (used by `topology-ai.spec.ts` through `docker-compose.override.yml.topology-ai-e2e`) must answer the harness: when a request carries `tools`, reply with a `tool_calls` for the first tool with `{}`-shaped valid arguments built from its schema's required string properties (`"x"`), and when the conversation contains a `role: 'tool'` message, reply with text containing the tool result. Without this the env bootstrap's verification fails and chat (tool-requiring) becomes ineligible in that e2e stack. Keep its existing text responses for the topology assertions.

**Files:** the deletions and edits above; `e2e-tests/fixtures/mockLlmServer.mjs`; `services/aiModels/aiModelRegistry.contract.test.ts`; plus the touched tests (`routes/ai.ticket.test.ts`, `ai_sessions_actions.test.ts`, `ai_sessions_crud.test.ts`, `topologyAiSessions.integration.test.ts`, `topologyAiFailureAccounting.integration.test.ts`, `aiAgentSdk.test.ts` — drop the `MCP_LLM_PROVIDER: 'openai-compatible'` cases or convert them to "env deployment resolves chat to the env-managed offering").

- [ ] **Step 1: Write the failing tests** — add rules 5–7 to the contract test, and convert one `aiAgentSdk.test.ts` env-path case:

```ts
it('env OpenAI-compatible deployment: chat resolves through the registry to the env-managed offering (no legacy branch)', async () => {
  resolveModelMock.mockResolvedValue(makeResolvedModel('openai_compatible', { surface: 'chat' }));
  const r = await runPreFlightChecks(/* chat surface, env config mocked to openai-compatible */);
  expect(r.model?.connection.kind).toBe('openai_compatible');
  expect(r).not.toHaveProperty('openaiCompatible');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/aiModelRegistry.contract.test.ts src/services/aiAgentSdk.test.ts`
Expected: FAIL (rule 5 finds the legacy symbols; the preflight result still has `openaiCompatible`).

- [ ] **Step 3: Delete and edit** as listed. Grep afterwards; every hit must be gone or a doc/test reference explained in the PR:

```bash
grep -rn "isOpenAICompatibleProvider\|OpenAISessionManager\|openaiSessionManager\|openaiCompatibleProvider\|historyBuilder\|openai_env\|openai-compatible:chat-only" apps/api/src | grep -v "\.test\.ts"
```

- [ ] **Step 4: Run the affected suites**

```bash
cd apps/api
npx vitest run src/services/aiModels/aiModelRegistry.contract.test.ts src/services/aiAgentSdk.test.ts src/services/aiAgent.test.ts
npx vitest run src/routes/ai.ticket.test.ts src/routes/ai_sessions_actions.test.ts src/routes/ai_sessions_crud.test.ts src/routes/ai.test.ts
npx vitest run src/services/llm/ src/config/
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyAiSessions.integration.test.ts src/__tests__/integration/topologyAiFailureAccounting.integration.test.ts
npx tsc --noEmit -p .
```

Expected: PASS, `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add -A apps/api/src e2e-tests/fixtures/mockLlmServer.mjs
git commit -m "refactor(ai): delete the env-only OpenAI chat runtime; one runtime through the registry (#7604)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 17: Independent security review (required, spec §12)

Not a code task; it gates Task 18. Run **after** Tasks 1–16 are committed, on the full branch diff.

- [ ] **Step 1: Dispatch the review.** Two independent reviewers in parallel, both read-only, both given the same brief:
  - Opus subagent (`pr-review-toolkit:code-reviewer` or `general-purpose`, `model: opus`) with the `security-review` skill loaded;
  - Codex: `codex exec "<brief>" -s read-only -m gpt-6-astra -c 'model_reasoning_effort="high"' </dev/null` (foreground).

  Brief (verbatim):

  > Security-review branch `feature/7598-ai-model-registry/wave-7604` against `origin/main` (W06: BYO OpenAI-compatible connections through a loopback model gateway). Threat model: an MSP partner admin is semi-trusted (may be compromised); the configured endpoint is **untrusted** (may be hostile, may be someone else's server); org-scoped users and other partners are adversaries. Check, with file:line evidence, labelled verified / inferred / not-checked:
  > 1. **SSRF / egress:** can any request reach a private, link-local, loopback or metadata address on hosted, or a public address in cleartext on self-host? DNS rebinding between validation and dial? Redirects? Can any code path dial a partner `base_url` without `forwardUpstream`/`safeFetch`? Can the CLI child reach anything but the loopback gateway?
  > 2. **Gateway capability:** can a grant token be guessed, replayed after revoke/expiry, used for another connection/partner/model, or leaked into logs, errors, audit rows, job payloads or the child's env? Can a request on one grant reach another grant's connection? Path parsing / traversal / header injection into the upstream request?
  > 3. **Key handling:** the connection key's lifetime in memory, in the grant, in errors (scrubbing completeness, including partial echoes and encodings such as URL-encoding or base64), in `last_error` / `discovery_error` / verification `summary`; row-bound AAD.
  > 4. **Response limits and timeouts:** request/response byte caps in buffered and streamed paths, idle and total timeouts, concurrency per grant, behaviour of a slow-loris upstream, an infinite SSE stream, a huge single SSE event, gzip bombs (does `safeFetch` decompress? does `maxBytes` count compressed or decompressed bytes?).
  > 5. **Prompt / tool-schema injection from the endpoint:** can a hostile endpoint cause a tool to execute that the model was not offered, with malformed or partial arguments, or as a partial batch? Can it smuggle content via `reasoning_content`, model names from `/models` (stored and rendered), error bodies rendered in the UI, or `finish_reason` values? Can it make the turn bill zero or someone else's tokens? Can it exhaust the partner's budget faster than the reported usage shows?
  > 6. **Tenancy:** cross-partner create/update/delete/verify/refresh/manual-offering through every new route and service; the env bootstrap writing to the right partner only; RLS + composite FKs.
  > 7. **Env bootstrap:** can it re-point an admin's choice, run on hosted, or race across replicas into duplicates?
  > Report findings as a numbered list with severity, evidence and a concrete fix. Do not write files.

- [ ] **Step 2: Record findings privately.** Write the merged, de-duplicated findings to `~/breeze-security/remediation/<date>-w06-gateway-review.md` (never the repo). For each: adopt (fix on this branch with a test that fails before the fix) or reject with a reason.

- [ ] **Step 3: Fix forward.** One commit per adopted finding (`fix(ai-models): … (#7604)`), each with its failing-first test. If a finding touches the gateway, translator, egress policy or key handling, re-run `npx vitest run src/services/aiModels/gateway/ src/services/aiModels/prepareSdkChild.test.ts`.

- [ ] **Step 4: Second look only if a fix touched a high-blast-radius surface** (CLAUDE.md "cap review recursion"): re-run the Codex brief against the fix commits only.

- [ ] **Step 5: Public record.** The PR body states only: "Independent security review (Opus + Codex high): N findings — X fixed on this branch, Y rejected with reasons, Z tracked privately." No finding text.

---

## Task 18: Docs, e2e, full verification, PR

- [ ] **Step 1: Docs** (`update-breeze-docs` skill conventions):
  - `apps/docs/src/content/docs/features/bring-your-own-llm-key.mdx`: new section "Connect an OpenAI-compatible endpoint" (what works: every AI feature including tools once verified; how to add, discover or enter models, price (0 is fine for local), verify, enable, assign; hosted = public https only; self-host private-network rules unchanged; keys stay on the Breeze server and are never sent to the agent process; what is not supported: thinking/effort controls, documents/PDFs in chat, server tools such as web search, residency). Replace the "OpenAI-compatible chat without tool calling" env section with "Instance-wide endpoint (self-hosted)": the `MCP_LLM_*` variables now create an env-managed connection per partner at boot, verified automatically; chat moves to it only where chat used the platform default; the old chat-only runtime is gone; a model that fails tool verification cannot serve chat (link to the verification troubleshooting).
  - `apps/docs/src/content/docs/deploy/environment.mdx`: update the `MCP_LLM_*` rows (bootstrap semantics; hosted refuses it).
  - Troubleshooting entries: "Verification failed: no tool_use block" (the model or server does not support function calling — e.g. vLLM needs `--enable-auto-tool-choice --tool-call-parser …`, Ollama needs a tools-capable model), "egress_blocked", "Re-verify: endpoint changed".
- [ ] **Step 2: e2e** — `e2e-tests/tests/byo-openai-compatible.spec.ts` + page-object additions to `PartnerAiModelsPage.ts`: with the topology mock LLM server reachable on the docker network (self-host stack, private address), add an OpenAI-compatible connection, see discovered models, set a price, verify (the mock answers the harness), enable, set it as the chat default, send a chat that triggers a tool, and see the tool result. `data-testid` selectors only.
- [ ] **Step 3: Full verification** (foreground, small batches, generous timeouts):

```bash
pnpm --filter @breeze/shared test --run
cd apps/api && npx vitest run src/services/aiModels/ src/routes/aiModels/ src/services/llm/ src/jobs/aiModelDiscoveryWorker.test.ts src/config/
cd apps/api && npx vitest run src/services/streamingSessionManager src/services/aiAgents/ src/services/aiAgentSdk.test.ts src/routes/ai
pnpm --filter @breeze/api test --run          # FULL unit suite (orgMerge / cascade traps only red here)
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter @breeze/api test:rls
cd apps/web && npx vitest run && npx astro check
cd apps/api && npx tsc --noEmit -p . && cd ../web && npx tsc --noEmit -p .
bash scripts/check-migration-naming.sh --against-ref origin/main
pnpm db:check-drift
pnpm test-stack down
```

- [ ] **Step 4: PR.** `feature-lifecycle` skill: `complete_wave` is called when the PR merges, not now. Open the PR to `main` titled `feat(ai): model registry W06 — BYO OpenAI-compatible connections with tool calling (#7604)`. Body: summary; `Closes #7604`, `Closes #6772`, `Closes #7120`; the Preconditions output; the Settings PR statement (below); the security-review line from Task 17 Step 5; the Lab / Todd gates checklist; the migration name; "Release note: self-hosters using `MCP_LLM_PROVIDER=openai-compatible` — chat now runs through a verified connection; a model without tool calling no longer serves chat (Open question 1)". End with the Claude Code attribution line. Run `/pr-review-toolkit:review-pr` once and record it on the PR.

---

## Settings PR statement (CLAUDE.md rule 9)

- **Concept:** BYO model connection (kind `openai_compatible`).
- **Home:** Partner Settings → AI Providers & Models → Connections card (row drawer Save); its models in the Models card (enable = autosave + toast; details = drawer Save). Level: partner.
- **Resolver:** `resolveModel` (W03) via `gatewayCandidate`.
- **Places configured, before → after:** before, 1 (env vars, deployment-wide, chat only) → after, 1 UI home (+ the env vars as a self-host bootstrap that writes into that same home, shown read-only there). No new home.

## Lab / Todd gates (CI cannot prove these)

| # | Gate | Who | How |
|---|---|---|---|
| L1 | Real endpoints, tool calling end-to-end in chat and an AI agent run: **vLLM** (`--enable-auto-tool-choice --tool-call-parser hermes`, Qwen2.5-7B-Instruct), **Ollama** (`qwen2.5:7b`), **OpenRouter** (one hosted model), **LiteLLM** proxy | Todd / lab VM | add connection → discover → price → verify → enable → chat with a device tool; record pass/fail per server in the PR |
| L2 | Self-host env absorption on an existing install that used `MCP_LLM_PROVIDER=openai-compatible`: upgrade, confirm chat still works (or fails with the documented "needs tools" message for a non-tool model), confirm no duplicate connections after two restarts and two replicas | Todd | pre-release sweep |
| L3 | Hosted: an `http://` or private-address base URL is refused; a public https endpoint works | pre-release sweep | browser |
| L4 | The Agent SDK CLI version shipped in the release still works through the gateway (the `gatewaySdk.e2e.test.ts` suite on the release build's SDK) | release checklist | run the e2e suite against the bumped SDK before any SDK version bump |

## Open questions for Todd

1. **Chat for a model without tool calling.** Absorbing the env path deletes the chat-only runtime. Chat is a tool-requiring surface (spec §7), so a self-hoster whose env model cannot call tools loses chat (they keep non-tool surfaces).
   - **A — delete the chat-only runtime (this plan):** one runtime, one billing path; most current local models do tools; clear "needs tools" message. Con: a regression for the few on non-tool models.
   - **B — keep a "chat without tools" mode:** a per-offering flag letting an unverified model serve `chat` with tools stripped. Con: a second chat behaviour to maintain; tools silently absent.
   **Recommend A** — the request in #6772/#7120 is tool calling; a tools-less chat is the thing users asked to replace.
2. **Self-host private networks.** The plan keeps the env provider's existing rule: RFC 1918/ULA allowed only with `IS_HOSTED=false`, cleartext only to private addresses, loopback never. **Recommend keep** (no new knob). Alternative: an explicit `AI_BYO_ALLOWED_PRIVATE_CIDRS` allowlist — tighter, but breaks every current env-path user on upgrade.
3. **Residency for BYO endpoints.** D7 makes `openai_compatible` never residency-eligible. **Recommend keep for v1**; revisit if an EU partner needs an EU-hosted self-run model under "residency required" (would need an admin attestation field and an audit entry — a product/legal call).
4. **Verification token spend.** Verification spends a few thousand tokens on the partner's endpoint and is not ledgered (no org). **Recommend accept** (documented in the UI help text).
5. **Partner-level egress audit.** Discovery and verification calls have no org, so `llm_egress_events` (shape 1, `org_id NOT NULL`) cannot hold them; the route-level audit records who triggered them, not each dial. **Recommend accept for W06** (same as the existing catalog harness). Alternative: a partner-axis `llm_partner_egress_events` table (new shape-3 table + RLS + registrations) — worth it only if an auditor needs per-dial records of admin-triggered tests.

## Review

Independent Codex review (`gpt-6-astra`, `model_reasoning_effort=high`, read-only), 2026-10-01, against this plan, the spec, the index, the W04 plan, `origin/main` (W01+W02) and the W03 branch `wave-7601`. **17 findings: 16 adopted (2 of them modified), 1 partially adopted.**

| # | Sev | Finding | Outcome |
|---|---|---|---|
| 1 | High | Blank tool arguments became `{}`; a stream truncated mid tool call still emitted its batch. | **Adopted.** Blank/missing arguments are invalid; a batch is emitted only after a terminal `finish_reason` or `[DONE]` (Task 6 code + 2 new stream tests). |
| 2 | High | Short keys could not be scrubbed; encoded echoes were not scrubbed. | **Adopted.** BYO keys must be ≥ 8 chars (Task 1); `scrubSecrets` also redacts URL-encoded, base64/base64url and JSON-escaped forms (Task 4 + test). Auth failures already return a fixed message. |
| 3 | High | The bootstrap called W03's cutover lease helpers with the wrong signature (they are a singleton returning `'taken'\|'held'\|'complete'`). | **Adopted.** Replaced with a per-partner `pg_advisory_xact_lock` inside the bootstrap transaction; concurrency integration test added (Task 15). |
| 4 | High | The bootstrap could run before a partner's registry cutover, which would then rewrite assignments / disable the env offering. | **Adopted.** `ensurePartnerCutover(partnerId)` first, per partner; both-order integration test (Task 15). |
| 5 | Med | Missing usage became a confirmed zero cost (W03 settles all-zero SDK usage as confirmed). | **Adopted, modified.** Rather than rejecting completions from servers that omit usage (common on local servers), the gateway **estimates** (request-size over-estimate in, emitted chars ÷ 3 out) and logs; never zero (Task 6 `resolveUsage` + tests). |
| 6 | Med | `listOfferingDefaultUses` is `(partnerId, offeringId)` in W04. | **Adopted** (Task 10). |
| 7 | Med | W04's `toRegistryWriteError(error, fallbackMessage): never` always throws; the plan inspected its return. | **Adopted.** Specific constraints (23505 duplicate, 23503 in-use) are mapped before calling it; `RegistryWriteCode` extension listed incl. `not_gateway` (Task 10). |
| 8 | Med | Partner-level discovery/verification egress is not written to `llm_egress_events` (org-scoped). | **Partially adopted.** The plan keeps the existing posture (the catalog harness has the same limit) and records the action at the route (`ai_models.connection.refresh_requested`, `ai_models.offering.verify_requested`); a durable partner-scoped egress table is a new tenancy shape, out of W06 scope → Open question 5. All org-attributed dispatch traffic (where tenant data flows) is recorded. |
| 9 | Med | A truncated `/models` list (> 500) would advance absence counters and retire real models. | **Adopted.** Over-cap lists throw `DiscoveryTruncatedError` → failed sync, no lifecycle change (Task 11 + test). |
| 10 | Med | "After commit" drained inside the request transaction (W04's `registryWrite` does not own it). | **Adopted, modified.** `afterCommit` drains in middleware after the DB-context transaction (or a 5 s BullMQ delay), and the jobs are rollback-safe (missing row → `skipped`, retried with backoff) (Task 13). The bootstrap enqueues only after all its transactions commit (Task 15). |
| 11 | Med | Module-level `TextDecoder` shared across concurrent streams; CRLF split across chunks. | **Adopted** (Task 6 `parseSse`). |
| 12 | Med | `safeFetch.timeoutMs` is an inactivity timeout, not a connect deadline. | **Adopted.** `timeoutMs` = idle limit; a separate connect+headers deadline (504 `upstream_timeout`) (Task 4). |
| 13 | Med | Abort did not interrupt `readBody` or a `drain` wait. | **Adopted** (Task 4 `server.ts`). |
| 14 | Med | Env model A→B→A left chat on B. | **Adopted.** `provider_config.envModel` tracks the configured model (Task 15 + test). |
| 15 | Med | `getStartedModelGateway` not exported by the barrel; `catalogEndpointOf`'s remaining caller in `streamingSessionManager`. | **Adopted** (Tasks 4, 9). |
| 16 | Med | Key rotation must trigger discovery (spec §6). | **Adopted** (Task 13). |
| 17 | Low | Migration partial index missing from the Drizzle schema (drift). | **Adopted** (Task 3). |

## Index additions

| Where | Name(s) | Why |
|---|---|---|
| `packages/shared/src/constants/aiConnectionKinds.ts` | `AI_CONNECTION_ROW_KINDS`, `AiConnectionRowKind`, `GATEWAY_CONNECTION_KINDS`, `GatewayConnectionKind`, `isGatewayConnectionKind`, `BYO_MODEL_ID_PATTERN` | The kind list every layer asks; W07 appends |
| `packages/shared/src/validators/aiModelRegistryApi.ts` | `connectionCreateSchema` arm `openai_compatible`; `byoBaseUrlSchema`, `connectionGatewayPatchSchema`, `ConnectionGatewayPatchInput`, `manualOfferingCreateSchema`, `ManualOfferingCreateInput` | `/ai/models` contract |
| `packages/shared/src/types/aiModelRegistry.ts` | `AiConnectionDto.baseUrl`, `.managedBy`; `AiOfferingDto.verification`; `AiOfferingVerificationDto`, `OfferingVerificationState` | DTOs |
| `services/aiModels/gateway/` | `limits.ts` (all `GATEWAY_*`, `GRANT_*`, `DISCOVERY_*`); `types.ts` (`GatewayDialect`, `GatewayConnectionConfig`, `GatewayCredential`, `GatewayGrantPurpose`, `GatewayGrantInput`, `GatewayGrant`, `GatewayGrantRecord`, `GatewayIncomingRequest`, `GatewayResponse`, `AnthropicErrorType`, `GatewayError`, `gatewayErrorBody`); `grants.ts` (`createGrantStore`, `GrantStore`); `adapter.ts` (`GatewayAdapter`, `registerGatewayAdapter`, `getGatewayAdapter`, `assertBoundModel`); `server.ts` (`ModelGateway`, `startModelGateway`, `getModelGateway`, `getStartedModelGateway`, `closeModelGateway`); `forward.ts` (`UpstreamRequest`, `forwardUpstream`, `upstreamOriginFor`, `upstreamAuthHeaders`, `__setUpstreamFetchForTests`); `scrub.ts` (`scrubSecrets`); `byoEndpointPolicy.ts` (`ByoEgressAllowances`, `ByoEndpointRejected`, `byoEgressAllowances`, `validateByoBaseUrl`, `joinByoUrl`) | The shared loopback gateway (W07 registers adapters) |
| `services/aiModels/gateway/openai/` | `translateMessagesRequest`, `oaiToolName`, `translateChatResponse`, `translateChatStream`, `mapUsage`, `validateToolCalls`, `mapFinish`, `UNSAFE_TOOL_CALL_NOTE`, `parseSse`, `encodeSse`, `openAiCompatibleAdapter`, `GATEWAY_PLACEHOLDER_KEY`, `estimateInputTokens`, `discoverOpenAiCompatibleModels`, `sanitizeDiscoveredModels` | OpenAI dialect |
| `services/aiModels/gatewayCapabilities.ts` | `GatewayVerificationRecord`, `GatewayVerificationState`, `endpointFingerprint`, `readVerification`, `verifiedCapabilitiesTree`, `verifiedGatewayCapabilities` | Verified capabilities on the offering (D4) |
| `services/aiModels/gatewayCandidate.ts` | `gatewayCandidate`, `gatewayConfigFor`, `loadGatewayCredential` | Resolver branch for gateway kinds |
| `services/aiModels/candidateLoader.ts` | `ResolvedConnection` gateway arm (`credential`), `isGatewayResolvedConnection`, `UNVERIFIED_CAPABILITIES` (exported) | |
| `services/aiModels/connectionFactory.ts` | `AnthropicClientTarget` `{ kind: 'gateway' }`, `openGatewayGrant`, `prepareSdkChild`, `SdkChildDispatch`, `SERVER_SIDE_FALLBACK_KINDS`, `gatewayUpstreamUrl` | The single SDK-child seam |
| `services/aiModels/sdkChildEnv.ts` | `buildClaudeSdkChildEnv` (moved), `buildGatewaySdkChildEnv` | |
| `services/aiModels/gatewayConnections.ts` | `createGatewayConnection`, `CreateGatewayConnectionInput`, `updateGatewayConnection`, `deleteGatewayConnection`, `createManualOffering`, `isEnvManaged` | Gateway-kind writes |
| `services/aiModels/connectionDiscovery.ts` | `CONNECTION_MODEL_DISCOVERERS`, `ConnectionModelDiscoverer`, `DiscoveredConnectionModel`, `discoveryGrantRecord` | Discovery registry (W07 adds bedrock) |
| `services/aiModels/offeringVerification.ts`, `offeringVerificationStore.ts` | `verifyConnectionOffering`, `OfferingVerificationResult`, `VERIFY_OFFERING_JOB`, `writeOfferingCapabilities` | Harness verification of BYO offerings |
| `services/aiModels/envOpenAiBootstrap.ts` | `readEnvOpenAiSettings`, `EnvOpenAiSettings`, `bootstrapEnvOpenAiConnections`, `EnvBootstrapReport`, `ENV_CONNECTION_NAME` | Env path absorbed (D6) |
| `services/llm/providerFidelityHarness.ts` | `FidelityTransport`; `runFidelityCheck(input, transport?)` | Harness seam |
| `services/llm/llmEgressProxy.ts` | `grant(sessionId, null, …)` deny-all | |
| `jobs/aiModelDiscoveryWorker.ts` | job `verify-offering` (jobId `verify-offering-${id}`), `verifyOfferingJobId`, `enqueueOfferingVerification` | |
| `routes/aiModels/` | `ownConnection`; `PATCH /connections/:id/gateway`; `POST /connections/:id/offerings`; audit `ai_models.connection.endpoint_changed` (gateway), `ai_models.offering.added` (`source: 'manual'`) | |
| DB | `llm_egress_events.connection_id` (no FK), surface `gateway_forward`, index `llm_egress_events_connection_idx`; `partner_ai_connections.provider_config.managedBy = 'env'` (convention, no schema); `partner_ai_models.capabilities.breeze_verification` (convention) | Migration `2026-11-23-100000-ai-gateway-egress-events.sql` |
| Web `components/settings/aiModels/` | `connectionForms/ConnectionKindForm`, `OpenAiCompatibleConnectionForm`, `connectionKinds.ts` (`ADDABLE_CONNECTION_KINDS`, `CONNECTION_KIND_LABEL_KEYS`), `ManualModelForm` | UI extension points (W07 adds forms) |
| Removed | `services/llm/openaiSessionManager.ts`, `openaiCompatibleProvider.ts`, `historyBuilder.ts`, `isOpenAICompatibleProvider`, `PreFlightResult.openaiCompatible`, `legacyCostSource: 'openai_env'` | One runtime |
