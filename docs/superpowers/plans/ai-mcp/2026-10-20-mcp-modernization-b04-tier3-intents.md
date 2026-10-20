---
tracking_issue: LanternOps/breeze#6154
wave_issue: LanternOps/breeze#6158
branch: feature/6154-mcp-modernization/wave-6158
---
# MCP server modernization B-W04: Tier-3 over MCP via action intents + URL-mode elicitation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tier-3 `tools/call` over MCP stops failing closed with `MCP_APPROVAL_REQUIRED`. It files a durable `action_intents` row that a human approves in the Breeze mobile or web app, and the existing release worker executes it under the **live authority of the MCP credential that asked**. Every client gets a `pending_approval` result plus two tools, `get_action_status` and `cancel_action`. A `2026-07-28` client that declares URL-mode elicitation additionally gets `resultType: "input_required"` pointing at the Breeze approval page, and its retry carries a signed `requestState` bound to the intent.

**Architecture:** No second execution path. The MCP request only *creates* the intent (after every gate a direct Tier-3 call passes today). The decide path, fan-out and approver ceilings do not change. Execution happens only in `jobs/intentReleaseWorker.ts`. For `source = 'mcp_api'` intents the worker rebuilds the caller's `AuthContext` from the **live origin credential** (API key or OAuth grant) instead of the requester user, and wraps the tool dispatch in the same Tier-3 lifecycle (ledger fail-closed → handler → uniform `mcp.tool.<name>` audit) that the direct MCP path uses, extracted into a transport-neutral service. Wire presentation (pending result, status tools, URL elicitation) is a pure projection over the one intent row.

**Tech Stack:** TypeScript, Hono, Drizzle (queries only), BullMQ (existing `action-intents` queue), Redis (`rateLimiter`), Node `crypto` (HMAC/HKDF), React (Astro island `ApprovalsInbox.tsx`), react-i18next (8 locales), Vitest.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md` ("Feature B → B-W04": hard-deny → `createActionIntent(source: 'mcp_api')`, `get_action_status`/`cancel_action`; URL-mode elicitation for clients that declare it, **never form mode**; Tasks handle on the same intent row). Requirements and guardrails: issue #4907 (proposal + 2026-09-17 cross-link comment) and #3856. Wire contract checked 2026-10-20 against the published `2026-07-28` revision: `basic/patterns/mrtr` (SEP-2322), `client/elicitation`, `schema` (`CallToolRequestParams` inherits `inputResponses?` + `requestState?`; `ElicitRequestURLParams {mode:'url', message, url}`; `ElicitResult.action ∈ accept|decline|cancel`; `ClientCapabilities.elicitation {form?, url?}`).

**Prior plan (superseded):** `docs/superpowers/plans/open/2026-07-18-action-intents-mcp-cutover.md` assumed MCP *auto-executed* Tier 3; today it fails closed. Mined only for the status mapping and the non-oracle rule; this planning PR prepends a "Superseded" note to it.

**Tracking:** `get_feature_status LanternOps/breeze#6154`, then `start_wave` on #6158. Ships as **two PRs** on the wave branch:
- **PR A** — Tasks 1–8, 10–12 (intents over MCP for every client). Body `Refs #6158 #4907 #3856`.
- **PR B** — Task 9 (URL elicitation, modern era). Body `Closes #6158`, `Refs #4907 #3856`.

#4907 and #3856 stay open for Todd to close after the lab run (Task 12).

## Depends on B-W03 — start from a `main` that contains it

**B-W04 tasks start from a `main` that already contains B-W03 (#6157) PR A.** PR B (Task 9) needs nothing more from B-W03's code (the modern era ships in its PR A); its tests and lab only need `MCP_STATELESS_ENABLED=true`. B-W03 is being implemented on `feature/6154-mcp-modernization/wave-6157` (plan `docs/superpowers/plans/ai-mcp/2026-10-18-mcp-modernization-b03-stateless-cimd.md`). Before Task 1, `git fetch origin && git log origin/main --oneline | grep -i "B-W03"` and confirm each seam below exists on `main`; if one is missing, **stop** — do not re-implement B-W03 here.

| B-W03 seam (B-W03 plan task) | What B-W04 uses it for |
|---|---|
| `McpDispatchContext = { era, correlation }` threaded into `handleJsonRpc`/`handleToolsCall` (Task 4) | `era` decides whether URL elicitation is even possible; B-W04 **adds** `clientCapabilities: Record<string, unknown> \| null` (modern only, from `ModernRequestMeta.clientCapabilities`) |
| `McpRequestCorrelation.requestId` (server-minted UUID, audit `resourceId`) and `principalKey` (Task 3) | `requestId` → the intent's existing `correlation_id`, linking the creation audit row to the intent; `principalKey` is **not** the binding key (see D-B27) |
| `decorateModernResult(method, result)` in `services/mcpModernResult.ts` (Task 3) — stamps `resultType: 'complete'` | B-W04 changes it to **keep** a result's own `resultType: 'input_required'` (Task 9) |
| `validateJsonRpcEnvelope` + `classifyMcpRequest` (Task 2) | `params` is a plain object, so `params.requestState` / `params.inputResponses` can be read without re-validating the envelope |
| `writeMcpToolAuditEvent` takes `event.correlation` instead of `event.sessionId` (Task 4) | Task 6 moves it into a transport-neutral service; `event.correlation` widens to `McpRequestCorrelation \| McpReleaseCorrelation` (D-B29) and the Hono context becomes an injected sink |
| Ledger input gains `transportRequestId` and `era` (Task 4) | Task 6 widens `era` with `'release'` and passes `transportRequestId = intent.correlation_id` on worker-side ledger rows |
| B-W03 parity contract `mcpServer.statelessParity.contract.test.ts` (Task 5) — errors byte-identical across eras | Its fixtures never declare `elicitation.url`; Task 9 adds one documented exception row (Tier-3 call by a URL-capable modern client → `input_required`) |

Line numbers below are from `main` `f05560b9d0` (pre-B-W03). B-W03 shifts `mcpServer.ts` substantially — **re-grep every symbol before editing**.

**Verified against `origin/main` `f05560b9d0`** (2026-10-20). Every path and symbol was re-checked by a read-only survey; anything marked *(B-W03)* exists only after B-W03 merges.

**Migration:** one index, slot `apps/api/migrations/2027-01-02-140000-action-intents-live-origin-idx.sql` (Task 4). No column is added.

---

## Advisor quorum, 2026-10-20

**Procedure.** I wrote a position first (P1–P7, eight questions), and Codex `gpt-6-astra` at `xhigh`, read-only, critiqued it against `f05560b9d0`.

**Verdicts.**
- P1 (creation), P2 (execution), P3 (guardrails), P4 (wire), P6 (listing/instructions), P7 (seams): **agree-with-changes**.
- P5 (no migration at all): **disagree** — the per-principal cap needs an origin index, and the cap's concurrency needs serialisation. Adopted: one index migration, still no column.
- **Two blocking security findings, both adopted and verified by reading the code:**
  1. My P2 kept the user-owned release rebuild and added a boolean "credential still live" check. That rebuild (`buildUserOwnedAuthContext`, `services/actionIntents/actorContext.ts:347-358`) widens `accessibleOrgIds` to a `targetOrgId` using the **creator's** partner permissions, beyond an org-pinned API key's boundary.
  2. The same rebuild synthesises `mfa: true` (`actorContext.ts:379`), while MCP callers carry `token: {}` and are refused by `mfaGateRefusesCaller` (`services/aiToolMfaGate.ts:58-61`). A released MCP intent would have passed an MFA gate the call itself could not.
  → D-B26: release for `mcp_api` rebuilds from the live origin credential, never from the requester user.
- Other adopted corrections: reject org service-principal keys too (`mcpServer.ts:3080-3085`); validate tool input and resolve the execution org before inserting; compare origin kind/id **and** requester in **both** replay branches (`intentService.ts:1943` already compares requester in the caller-verification branch; `2448-2463` does not); the audit action is `mcp.tool.<name>`, not `mcp.tool.call`; the worker also dispatches Google/M365 secret-aware executors (`intentReleaseWorker.ts:1395`), so the lifecycle wraps the dispatch, not only `executeTool`; populate the existing `ai_tool_executions.intent_id` (`db/schema/ai.ts:188`); terminal outbox delivery is at-least-once, so the terminal audit dedupes; `waitForIntentTerminalOutcome` (`intentService.ts:3407`) reads by id with no ownership check, so ownership is asserted first; decline returns the **actual** cancel CAS outcome; the four-eyes requester has no approval row, so the deep link needs a requester-visible status card; "failed" means "failed or outcome uncertain"; Tasks get a shared projection, not a literal `tasks/get = get_action_status` promise.
- As-built corrections to my brief, all verified: an OAuth bearer without `grant_id` is already a 401 (`middleware/bearerTokenAuth.ts:468-470`), so no grantless branch exists; OAuth never receives `ai:execute_admin` (`bearerTokenAuth.ts:209`), so with `MCP_REQUIRE_EXECUTE_ADMIN` on (production default, `mcpServer.ts:120-122`) OAuth callers cannot create intents in production — Gate B decision 2; `collect_evidence` is floored to Tier 3 by MCP but `createActionIntent` refuses its registry Tier 2 (`intentService.ts:1458-1465`), so it stays fail-closed.
- **Disagreements left open:** report-suspicious revocation authority (Codex: "approval-row ownership must not silently become permission to revoke somebody else's partner-wide credential") — my default narrows revocation to the credential owner; the wider incident-response privilege is Gate B decision 5.

## Decisions

Numbering continues B-W03's D-B13…D-B24.

- **D-B25 — Who asks, and what is refused.**
  - Requester = the human behind the credential (`auth.user.id`: the API key's creator or the OAuth consenting user) → `requested_by_user_id`. `requesting_api_key_id` stays NULL: OAuth has no `api_keys` row, and keeping a user requester keeps the one-actor check, the four-eyes exclusion and the supervised "requester decides" rule exactly as in-app.
  - The origin is recorded as fact at insert (existing columns): `source = 'mcp_api'`, `origin_principal_kind` (`api_key` | `oauth_grant`), `origin_principal_id` (api key UUID | grant id), `requesting_client_label = "MCP · <key name | OAuth client name>"` (≤ 255), `correlation_id` = B-W03 `correlation.requestId`. The access-token `jti` stays in the creation audit row's correlation; it is not an authorization record.
  - Refused before anything is written, with today's `MCP_APPROVAL_REQUIRED` tool result (`{content:[{text: JSON.stringify({error, code})}], isError: true}`, `mcpServer.ts:1168-1171`). When the flag is **on**, the JSON in that text gains a third key `reason` (a `McpIntentIneligibleReason`); when it is **off** the body is byte-identical to today. Refused cases: partner service principal (`brz_sp_`, already refused by `createActionIntent`), org service-principal key (`principalType === 'service'`), tenant (BYO) tools, bootstrap tools, `MCP_APPROVAL_REQUIRED_EXTRA_TOOLS` (`collect_evidence`), any tool/action whose MFA gate refuses the caller, and any call when `MCP_TIER3_INTENTS_ENABLED` is off.
  - Before insert: `validateToolInput(toolName, input)` (`services/aiToolSchemas.ts:2274`) and `resolveMcpExecutionContext` (the org passed as `input.orgId` — partner-scope OAuth has `auth.orgId = null`).
- **D-B26 — Release runs under the live origin credential (quorum blocking fix).**
  - `buildAuthFromApiKey` (`mcpServer.ts:3015-3188`) moves verbatim to `services/mcpPrincipalAuth.ts` and is exported. The MCP request path and the release worker build the caller's `AuthContext` with the **same function**, so release can never be wider than the call: same org pin, same `token: {}` (no synthetic MFA), same creator re-authorisation (`authorizeHumanApiKeyCreator`), same site set.
  - **All three production callers of `buildAuthContextForIntent` (`actorContext.ts:105`, return type unchanged `AuthContext | null`) get the origin context for `mcp_api`**, because the function gains a first branch `intent.source === 'mcp_api'` → `(await rebuildMcpOriginAuthContext(intent))` mapped to `.auth` or `null`:
    - `revalidateRelease.ts:485` (release) — for `mcp_api` it calls `rebuildMcpOriginAuthContext` directly instead, to keep the specific errorCode, then `checkMcpOriginReleaseAuthority`;
    - `services/m365ToolsHeadless.ts:238` (the worker's M365 secret-aware dispatch via `executeM365ToolHeadless`, `intentReleaseWorker.ts:1429`) — gets the origin context through the shared branch, so the M365 path cannot fall back to the widened user rebuild;
    - `services/approvals/decideApprovalRequest.ts:825` (supervised approve-time RBAC re-check) — evaluates the origin-constrained context. This is the one decide-path behaviour change: for `mcp_api` it can only be stricter.
  - `rebuildMcpOriginAuthContext` loads the live credential:
    - **api_key:** row exists, `status = 'active'`, unexpired, creator `users.status === 'active'` (the middleware check at `apiKeyAuth.ts:203`, which `buildAuthFromApiKey` does not repeat), credential/MFA epoch unchanged (today inline in `apiKeyAuthMiddleware`, `middleware/apiKeyAuth.ts:222-227`; Task 3 extracts it), scope delegation still backed (`validateApiKeyScopeDelegation`, `services/apiKeyScopes.ts:90`), `createdBy === intent.requested_by_user_id`.
    - **oauth_grant:** `activeGrantCondition` (`oauth/grantStatus.ts:16`) holds; grant user (`oauth_grants.account_id`) `=== intent.requested_by_user_id` and passes the same live-user check as `assertLiveOAuthUser` (`users.status === 'active'`, `bearerTokenAuth.ts:144-150`); the grant's partner is active (`assertActiveTenantContext` with `strictForOauth`, as the bearer path); scopes = the grant's requested scopes re-resolved by `computeEffectiveMcpScopes` (`oauth/effectiveScopes.ts:117`, returns `mcp:*`) **then** `expandOAuthScopes` (`bearerTokenAuth.ts:527`) to `ai:*` before any `ai:execute` check; the key input is built from the grant row, not a token: `{ id: 'oauth:grant:<grantId>', orgId: grant.org_id, partnerId: grant.partner_id, createdBy: grant.account_id, name: 'OAuth bearer', scopes, oauthGrantId: grant.id, oauthClientId: grant.client_id, mcpDomains: grant.mcp_domains }` (the request-path shape at `bearerTokenAuth.ts:529-543`, with `oauth:grant:` replacing the per-token `oauth:<jti>`); client not disabled (`oauth_clients.disabled_at`), and the intent's org not blocked for the client (`filterBlockedOAuthClientOrgIds`, `middleware/bearerTokenAuth.ts:370`, over `oauth_client_blocks` — not exported today; Task 3 exports it).
  - Then `checkMcpOriginReleaseAuthority(intent, rebuilt)` re-runs the creation gates against the live state: `ai:execute` (+ `ai:execute_admin` when `shouldRequireExecuteAdminInProd()`), production allowlist, `mcp_domains` grants the tool's domain, `intent.org_id` within the rebuilt `accessibleOrgIds`, MFA gate does not refuse, and `MCP_TIER3_INTENTS_ENABLED` is on. Failure → terminal `failed` with errorCode `mcp_origin_revoked | mcp_scope_lost | mcp_domain_lost | mcp_org_out_of_scope | mcp_tool_not_allowed | mcp_mfa_required | mcp_intents_disabled`. RBAC (`checkToolPermission`) and the governance site ceiling still run afterwards in `revalidateApprovedIntentCore`, unchanged.
  - `buildApiKeyOwnedAuthContext` stays defensive and unreachable (no MCP intent sets `requesting_api_key_id`).
- **D-B27 — Idempotency, flood control and the cap.**
  - Binding key = `mcpOriginRef = "<origin_principal_kind>:<origin_principal_id>"`. Not B-W03's `principalKey`, not `canonicalPrincipalRef` — the stored origin columns are what release and ownership checks read, so the binding must equal them.
  - The MCP layer passes an explicit `idempotencyKey = "mcp:v1:" + sha256(mcpOriginRef + ":" + toolName + ":" + argumentDigest)`. Same input from the same credential while the intent is live → the same intent (current status mapped). No caller-supplied key, no argument stripping. After terminalisation a repeat call is a new request (it needs a new approval).
  - Both replay branches in `createActionIntent` (`intentService.ts:1943-1947` and `2448-2463`) additionally compare `originPrincipalKind`, `originPrincipalId` and `requestedByUserId` → `idempotency_conflict` on mismatch.
  - Order inside the insert transaction, for `mcp_api` only: (1) `pg_advisory_xact_lock(hashtext('mcp-intent-cap:' || mcpOriginRef))`; (2) **replay lookup first** — a live row with this `(org_id, idempotency_key)` is returned as the replay (no cap, no churn charge); (3) cap — count live `mcp_api` intents for this origin on the new partial index `action_intents_live_origin_idx`; at or over `MCP_INTENT_MAX_LIVE_PER_PRINCIPAL` (default 20, across orgs) → `too_many_pending_actions`, nothing inserted or notified; (4) churn guards, check-and-increment immediately before the insert: `MCP_INTENT_CREATES_PER_HOUR` (default 60) per origin **and** `MCP_INTENT_CREATES_PER_USER_PER_HOUR` (default 60) per requester human across all their credentials (Redis, `rateLimiter`, `services/rate-limit.ts:107`; called outside any held DB context per its warning, so steps 1–3 and 5 run in one transaction and step 4 runs just before it, re-checked by the cap under the lock); (5) insert. A failed insert after step 4 over-charges by one — accepted. A row filed and immediately cancelled with `no_eligible_approvers[_site_ceiling]` stays charged.
  - These bound pushes per approver to 60/h per requesting human, not per credential; a create→cancel loop cannot exceed it.
  - The per-tool rate limit (`checkToolRateLimit`) is charged once per creation attempt. That is new for Tier 3 (today Tier-3 calls are refused before the limiter, `mcpServer.ts:1713-1767`) and applies only with the flag on. Status reads and `requestState` continuations do not charge it.
- **D-B28 — TTL and notifications.**
  - TTL: the existing `MCP_EXPIRY_MS` (24 h, `intentService.ts:374`), the same window headless agent intents get. Chat's 5/60-minute windows assume a watched chat pane; MCP has none. (Brief said "in-app default" — the in-app default *for this source* is already 24 h.)
  - Notify gate (`intentService.ts:2701-2705`) widens to `source === 'mcp_api'` at every scope, and the requester outcome notice (`jobs/intentReleaseWorker.ts:1939-1951`) likewise — the comment there anticipated exactly this.
- **D-B29 — One Tier-3 lifecycle.**
  - `runTier3ToolLifecycle` (renamed `runMcpTier3Lifecycle`), `finalizeTier3ToolLifecycle` (stays private in the new module) and `writeMcpToolAuditEvent` move to `services/mcpTier3Lifecycle.ts`. Two changes, nothing else: the Hono context becomes an injected `McpAuditSink`, and the context's identity fields become explicit — `principal: { apiKeyId, oauthGrantId, partnerId, partnerServicePrincipalId, actorUserId }` (today read off `ctx.apiKey`, `mcpServer.ts:2281-2295`) and `correlation: McpRequestCorrelation | McpReleaseCorrelation`, where `McpReleaseCorrelation = { kind: 'intent_release'; requestId: string /* randomUUID per release */; intentId: string; creationRequestId: string /* intent.correlation_id */; principalKey: McpOriginRef }`. The worker fills `principal` from the rebuilt key input (`apiKeyId` = api key UUID or `oauth:grant:<id>`). The sinks: request sink wraps `writeAuditEvent(c, …)`; worker sink calls `createAuditLogAsync` with `ipAddress`/`userAgent` null. Today the audit silently skips without a Hono context (`mcpServer.ts:2170`); the worker sink removes that hole.
  - The direct MCP path (unattended principals, bootstrap tools) calls the extracted function with a request sink and its B-W03 correlation — behaviour unchanged, existing tests are the guard.
  - The release worker, for `mcp_api` only, wraps its existing dispatch (`executeTool` **and** the secret-aware executor branches) in the same lifecycle: ledger begin fail-closed (failure → terminalise `failed` / `mcp_ledger_unavailable`, nothing dispatched) → dispatch → ledger complete + `mcp.tool.<name>` audit. The ledger row carries `ai_tool_executions.intent_id` and the ledger's `aiOrigin` is the auth's `aiOrigin` (as on the direct path).
  - Topology tools get `{ topologyBinding: { kind: 'mcp_site_key' } }` on release exactly as the direct path passes it (`mcpServer.ts:1826-1828`).
  - Terminal non-executions (`rejected|expired|cancelled`, worker branch `intentReleaseWorker.ts:2026-2032`) and pre-dispatch release failures write the same `mcp.tool.<name>` audit with `result: 'failure'` and `details.intentOutcome`. Outbox delivery is at-least-once, so the write first checks for an existing row `(resource_type 'action_intent', resource_id intentId, action, details->>'intentOutcome')`.
  - `reapStaleExecutingIntents` (`jobs/intentExpiryReaper.ts:305`) also fails the linked `executing` ledger row.
- **D-B30 — Guardrails kept.**
  - The decision model is unchanged: four-eyes deciders need `approvals:decide` + org access + site/governance ceilings + strict-script `scripts:write` + fresh-factor exceptions; supervised decider is the requester, whose tool RBAC is re-checked on approve; requester RBAC re-checked at release. I am **not** adding "four-eyes approver must hold the tool's own permission" — #4907 lists it, but the decide path is shared with in-app and Todd's 2026-09-17 comment says it does not change. Gate B decision 4.
  - The MCP principal is never an approver: `decideApprovalRequest` refuses any non-interactive principal (`services/approvals/decideApprovalRequest.ts:527-532`), and MCP bearers/keys are not accepted on `/approvals`. Pinned by a test.
  - Four-eyes still excludes the requester human, so an MCP call by Alice can never be approved by Alice unless she is the sole operator at ≥ L3 (existing rule).
  - Scopes unchanged: creation needs everything a direct Tier-3 call needs today (`ai:execute`, `ai:execute_admin` in production, `MCP_EXECUTE_TOOL_ALLOWLIST` in production).
  - Gate order: with the flag **off**, the approval gate stays exactly where it is (`mcpServer.ts:1713-1719`, before the scope checks), so a caller without `ai:execute` still gets `MCP_APPROVAL_REQUIRED` and no rate-limit charge. Only with the flag **on** does an effective Tier-3, non-unattended call continue past scope, allowlist, MFA, RBAC, rate limit and execution-org resolution into the intent branch.
  - `MCP_UNATTENDED_TIER3_PRINCIPALS` unchanged: those principals still execute directly. Tier 4 never.
- **D-B31 — Wire shape for every client.**
  - A created (or replayed live) intent returns a **normal** `CallToolResult` (`isError` omitted, i.e. false; not a JSON-RPC error):
    ```json
    { "content": [{ "type": "text", "text": "<one-line human sentence>" }],
      "structuredContent": { "status": "pending_approval", "actionId": "<intent uuid>", "toolName": "manage_quotes",
        "approvalScope": "four_eyes", "expiresAt": "<iso>", "approvalUrl": "<APP>/approvals#intent-<uuid>",
        "next": "Call get_action_status with this actionId; do not re-issue the call." } }
    ```
  - `actionId` is the intent id. (#4907's draft said `approvalId`; `actionId` matches `get_action_status`/`cancel_action` and is not confused with `approval_requests.id`.) Gate B decision 3.
  - `get_action_status({ actionId })` — tier 1, `ai:read`, domain `core`. `cancel_action({ actionId })` — tier 2, `ai:write`, domain `core` (it writes; annotations stay truthful). Both are server-intrinsic like `whoami` (`services/mcpWhoami.ts`) and both are listed for every principal that has an `mcpOriginRef` (human API key or OAuth grant), **including when the flag is off** (queued intents can still be read and cancelled). Partner service principals and org service keys can never own an `mcp_api` intent and do not see them.
  - Ownership: the intent must have `source = 'mcp_api'` and `(origin_principal_kind, origin_principal_id)` equal to the caller's `mcpOriginRef`, read under the caller's DB access context. Anything else — unknown id, other principal, same human via a different key — → JSON-RPC `-32602` `not_found`. No existence oracle.
  - Status mapping (from the 2026-07-18 plan, unchanged): `pending_approval`→`pending_approval`; `approved|executing`→`in_progress`; `completed`→`completed` + `result`; `failed`→`failed` + `errorCode` + `outcomeUncertain: true` when the worker recorded an unknown outcome; `rejected`, `expired`, `cancelled` as-is.
  - `result` is `compactToolResultForChat(intent.actionName, JSON.stringify(intent.result))` (the stored result is already normalised by the worker, so it is re-serialised, not passed through as the direct path's raw string) — the original action name, the same redaction the direct path applies. A secret-bearing result is never returned: when `isSecretBearingTool(intent.actionName)` (`services/actionIntents/secretBearingTools.ts:60`) or `hasSealedTemporaryPassword(result)` (`services/actionIntents/resultSecrets.ts:65`) → `resultWithheld: 'secret_bearing'` + the approval URL (reveal stays web-only). Keyed on the tool name too, because a burned or expired secret no longer carries the result marker.
  - `cancel_action` calls `cancelActionIntent` (`intentService.ts:3087`, CAS from `pending_approval|approved`) and returns the **actual** outcome: `cancelled`, or `not_cancellable` with the current mapped status.
- **D-B32 — URL-mode elicitation (modern era, PR B).**
  - Only when `era === 'modern'` **and** `clientCapabilities.elicitation.url` is an object. Never form mode. An empty `elicitation: {}` means form-only → no elicitation. Legacy clients (≤ `2025-11-25`) get D-B31 only; no `-32042 URLElicitationRequiredError` this wave (Gate B decision 7).
  - First call (new or replayed live intent) returns:
    ```json
    { "resultType": "input_required",
      "inputRequests": { "breeze_approval": { "method": "elicitation/create",
        "params": { "mode": "url", "message": "<who must approve, what, and that this opens Breeze>", "url": "<APP>/approvals#intent-<uuid>" } } },
      "requestState": "<sealed>" }
    ```
    `<APP>` = `DASHBOARD_URL || PUBLIC_APP_URL` (the pattern in `services/reportDelivery.ts:83`). The URL carries only the intent UUID; it is not pre-authenticated; the page requires a Breeze login and shows the request only to its fanned-out approvers or its requester, so "verify the identity of whoever opens the URL" holds by construction.
  - `requestState` = `base64url(payload) + "." + base64url(HMAC-SHA256)`, key `hkdfSync('sha256', APP_ENCRYPTION_KEY || SECRET_ENCRYPTION_KEY, 'breeze-mcp-request-state', 'breeze-mcp-request-state-v1', 32)` (the `services/emailUnsubscribeToken.ts` pattern; its own salt and `info`, never `'breeze-email-unsubscribe'`). `argumentDigest` everywhere in this plan = `computeArgumentDigest(canonicalizeArguments(toolInput))` (`intentService.ts:1764-1765`) over the exact `toolInput` passed to `createActionIntent` — the input as sent, after `validateToolInput` succeeded but without its parsed defaults, so the MCP digest and the stored `argument_digest` are the same value. Payload `{ v: 1, a: intentId, p: mcpOriginRef, m: 'tools/call', t: toolName, d: argumentDigest, e: expUnixSeconds }`, TTL 600 s, ≤ 1 KiB.
  - A retry with `params.requestState` never creates an intent. Minimum gates first: `ai:read` (preflight) and the `core` domain, the same as `get_action_status`; `decline` additionally needs `ai:write`, as `cancel_action`. It is verified in order: size/shape, signature (`timingSafeEqual`), `p` = caller's `mcpOriginRef`, `m`/`t` = this request, `d` = digest of the retried `arguments`, not expired. Any failure → `-32602` with `data.reason ∈ {invalid_request_state, request_state_expired}`; an expired-but-authentic state whose `p` equals the caller's `mcpOriginRef` also returns `data.actionId` so the model can fall back to `get_action_status` (`openMcpRequestState` returns the payload on expiry; the route checks `p` before exposing `a`).
  - Then ownership (D-B31) on the intent, then `inputResponses.breeze_approval`:
    - malformed (not an object, `action` not one of the three) → `-32602`;
    - `accept` → wait for a terminal outcome up to `MCP_APPROVAL_WAIT_MS` (default 20 000) via `waitForIntentTerminalOutcome`, aborted by the request's `AbortSignal`, no DB transaction held, at most `MCP_APPROVAL_WAITS_PER_PRINCIPAL` (default 2) concurrent waits per origin (excess skips the wait). Terminal → rendered **only** through `toMcpActionStatus` (D-B36): `completed` returns its `result` text as the content (or `resultWithheld: 'secret_bearing'`, never the stored secret); `failed`/`rejected`/`expired`/`cancelled` → `isError: true` with the D-B31 status. The raw `waitForIntentTerminalOutcome` snapshot is never returned. Not terminal → the D-B31 `pending_approval` result with `resultType: 'complete'` — the MRTR cycle ends and the model polls. No second URL prompt.
    - `decline` → `cancelActionIntent`, returning its actual outcome (the elicitation `message` states that declining cancels the request).
    - `cancel` (dismissed) or absent → current status as a complete result, intent untouched.
  - `decorateModernResult` *(B-W03)* keeps an existing `resultType: 'input_required'` and never adds `ttlMs`/`cacheScope` to a `tools/call` result.
- **D-B33 — Data model: one index, no column.**
  - Every fact fits existing columns (D-B25). `action_intents` is already registered in `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts:260`), `orgMergeRegistry.ts:271` and `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:76`, `arguments`/`result` already `excludedOpen`, `origin_principal_*` reviewed-included). An index changes none of them.
  - Migration `2027-01-02-140000-action-intents-live-origin-idx.sql`: `-- @no-transaction`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS action_intents_live_origin_idx ON action_intents (origin_principal_kind, origin_principal_id) WHERE source = 'mcp_api' AND status IN ('pending_approval','approved','executing');`. Declared in SQL only, like `action_intents_org_idem_uniq` (`db/schema/actionIntents.ts:457-462` explains the precedent).
  - Revoking one OAuth access token (`jti`) does not stop already-queued work; revoking the **grant** does (D-B26 re-checks it). Token-level stop would need a durable token/epoch column — Gate B decision 6.
- **D-B34 — Listing, `whoami` and instructions.**
  - `isMcpIntentEligible(input: McpIntentEligibilityInput)` (pure, `services/mcpIntentEligibility.ts`, Task 2) is the one predicate used by `tools/list`, `tools/call` and `whoami`: flag on; principal is a human API key or OAuth grant; effective tier exactly 3; not an `MCP_APPROVAL_REQUIRED_EXTRA_TOOLS` entry (checked before the tier test, so `collect_evidence` reports `approval_extra`, not `not_tier3`); not tenant/bootstrap; MFA gate does not refuse; `ai:execute` (+ admin in prod) and prod allowlist.
  - Eligible Tier-3 tools become **listed**. A flat Tier-3 tool gets the suffix ` (Requires approval in the Breeze mobile or web app: the call returns a pending action — use get_action_status.)`; a mixed tool keeps today's per-action form (`mcpServer.ts:1422-1426`) with the new wording: ` (Actions "a", "b" require approval in the Breeze mobile or web app: the call returns a pending action — use get_action_status.)`, and actions that are still ineligible keep today's sentence; ineligible ones keep today's behaviour (listed ⇒ callable). Tier 4 stays unlisted.
  - `whoami`'s `approvalGate` becomes `{ tier3: 'approval_intent' | 'web_app_only' | 'unattended', unattendedPrincipal }`; `tier3RequiresWebApp` stays for one release as a deprecated mirror.
  - Instructions follow the flag. Today `MCP_APPROVAL_RULES` (`services/aiAgentSystemPrompt.ts:44-47`) is a constant baked into `BREEZE_MCP_GUARDRAILS_CORE` and `MCP_SERVER_INSTRUCTIONS`. Task 10 adds `MCP_APPROVAL_RULES_INTENTS` beside it (exact copy in Task 10) and replaces the constant exports with `buildMcpGuardrailsCore(intentsEnabled)` / `buildMcpServerInstructions(intentsEnabled)`; every reader (`initialize`, B-W03 `server/discover`) passes the flag. Flag off → today's text byte-identical. Flag on → a Tier-3 call returns a pending approval in the Breeze mobile or web app unless the connection is configured for unattended execution; it is NOT done; poll `get_action_status`, never re-issue; `completed` is the only success; `failed` means failed **or outcome uncertain — effects may have occurred**.
- **D-B35 — Report-suspicious on an MCP-originated approval targets the origin, within the reporter's authority.**
  - Today the route revokes the *reporter's own* grants for `approval_requests.requesting_client_id`, which intent rows never set (`routes/approvals.ts:1419-1440`). For an `mcp_api` intent that is the wrong target.
  - New behaviour when the linked intent has `source = 'mcp_api'`: reject the intent (existing CAS), then revoke the origin credential **only when the reporter is its owner** (`requested_by_user_id === reporter`): OAuth → `revokeGrantsDurablyInCurrentDbContext({ grantIds: [id], reason, revokedByUserId, cascadeRefreshTokens: true })` (`oauth/grantStatus.ts:71`) plus the Redis marker `revokeGrant(grantId, ttl)` (`oauth/revocationCache.ts:74`); API key → a new `revokeApiKey(keyId, actorUserId, reason)` in `services/apiKeyRevocation.ts`, extracted from the inline `DELETE /api-keys/:id` handler (`routes/apiKeys.ts:682-727`, incl. its `api_key.revoke` audit) so both callers share it. Otherwise no revocation; the credential owner and the org's `approvals:decide` holders get a `security` notification naming the credential.
  - The response says what happened: `{ reported: true, credentialRevoked: boolean, revocationError?: string }`. A revocation failure is `captureException` + `credentialRevoked: false` — never a silent 204.
- **D-B36 — Handoff seams (B-W05, B-W06 build on these; B-W04 ships neither).**
  - `services/mcpActionStatus.ts` exports `toMcpActionStatus(intent, appBaseUrl): McpActionStatus` — the one safe projection (status mapping, sanitised result, withheld secrets, `outcomeUncertain`).
  - B-W06 Tasks: an intent-backed tool call may be represented as a task whose id is the intent id and whose status maps from `toMcpActionStatus` (`pending_approval` ↔ Tasks `input_required`). Tasks keep their own envelopes, TTL, `tasks/update` semantics; operations that never create intents are B-W06's own problem.
  - B-W05 MCP Apps: an approval card renders `McpActionStatus` as `structuredContent`. Text fallback is the D-B31 sentence.
- **D-B37 — Kill switch.** `MCP_TIER3_INTENTS_ENABLED` (`envFlag`, default **false** in the first release). Off: no Tier-3 listing, no creation (today's `MCP_APPROVAL_REQUIRED`, byte-identical), and the release recheck refuses queued `mcp_api` intents with `mcp_intents_disabled`; `get_action_status`/`cancel_action` keep working. URL elicitation additionally requires B-W03's `MCP_STATELESS_ENABLED`.

## Open Decisions (Gate B — for Todd)

Numbered; the plan's default is in brackets and is what Tasks implement.

1. **Rollout of `MCP_TIER3_INTENTS_ENABLED`.** [Off in the release that ships B-W04; on in EU after the Task 12 lab run, then US.] Alternative: on by default.
2. **OAuth clients in production.** OAuth never carries `ai:execute_admin` (`bearerTokenAuth.ts:209`) and `MCP_REQUIRE_EXECUTE_ADMIN` defaults on in production, so Claude.ai/ChatGPT-style OAuth clients **cannot** file Tier-3 intents in production under the plan. [Keep: creation needs exactly what a direct Tier-3 call needs, per #4907.] Alternative: for the intent path only, accept `ai:execute` without `ai:execute_admin`, since a human approves every call — a scope-policy change that deserves its own line in the release notes. The same question applies to `MCP_EXECUTE_TOOL_ALLOWLIST` (empty = no Tier-3 in production).
3. **Identifier name in the pending result.** [`actionId`.] Alternative: `approvalId` (#4907 wording).
4. **Four-eyes approver must also hold the tool's own permission?** [No — decide path unchanged; the requester's RBAC is re-checked at release; approver needs `approvals:decide` + ceilings, same as in-app.] Alternative: add a tool-permission check for `mcp_api` four-eyes deciders only (diverges the decide path by source).
5. **Report-suspicious authority.** [Revoke the origin credential only when the reporter owns it; otherwise reject + notify owner and approvers.] Alternative: any eligible approver's report quarantines (revokes) the credential — faster incident response, larger blast radius (Codex flagged this as needing an explicit incident-response privilege).
6. **Token-level stop.** [Grant revocation stops queued OAuth work; revoking one access token does not.] Alternative: persist the creating token's `jti`/epoch on the intent (a new column → export-policy row) and refuse release when it is revoked.
7. **Legacy URL elicitation.** [None — legacy clients get `pending_approval` + status tools.] Alternative: answer `2025-11-25` clients that declared `elicitation.url` with `-32042 URLElicitationRequiredError` carrying the approval URL.
8. **Decline semantics.** [Elicitation `decline` cancels the intent; `cancel`/dismiss leaves it pending.] Alternative: both leave it pending (an auto-declining client then cannot cancel by accident).
9. **Caps.** [20 live intents per credential; 60 creations per credential per hour and 60 per requesting human per hour; 20 s bounded wait; 2 concurrent waits.]

---

## Global Constraints

- **Commands.** API unit tests: `cd apps/api && npx vitest run <path>` — a substring match, so check the file count. Never `pnpm --filter <pkg> test -- --run <path>`. Integration: `cd apps/api && npx vitest run --config vitest.integration.config.ts <file>` on a per-worktree stack. Typecheck: `cd apps/<pkg> && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` — read the exit code, never pipe to `tail`. Web tests: `cd apps/web && npx vitest run <path>`.
- **Never weaker than the direct call.** An `mcp_api` intent is created only past every gate a direct Tier-3 call passes today (domain, scope, admin, allowlist, MFA, RBAC, execution-org resolution, rate limit) and released only under a context rebuilt from the same credential by the same function (`buildAuthFromApiKey`).
- **No second execution path.** Nothing executes in the MCP request or the decide request. The release worker is the only executor.
- **Never form mode.** No `elicitation/create` with `mode` other than `url`, and none to a client that did not declare `elicitation.url`.
- **No client-supplied value becomes an identifier or authority.** `requestState` is verified before use; `inputResponses` only selects among accept/decline/cancel; `clientInfo` stays where B-W03 put it.
- **No existence oracle.** Unknown and foreign `actionId` answer identically.
- **Decide path untouched** except (a) the report-suspicious origin branch (D-B35) and (b) the supervised approve-time RBAC re-check, which for `mcp_api` evaluates the origin-constrained context (D-B26; stricter only).
- **Migration** (Task 4 only): keep `2027-01-02-140000`; `scripts/check-migration-naming.sh` runs pre-commit — if it rejects, take the next free `HHMMSS` and say so in the PR. No row writes, so no `breeze.scope` line. Then `pnpm db:check-drift`.
- **ai-tools contract trap.** `apps/api/src/services/aiTools.userOwnedRelease.contract.test.ts:145` keys `SAFE_WRITE_SITES` by **line number**. It scans `aiTools*.ts` and `jobs/intentReleaseWorker.ts` — Tasks 4 and 6 edit the worker, so any line shift there turns it red for a reason unrelated to safety; re-pin the line numbers in the same commit and say why in the message.
- **Locales.** Every new en key goes into all 8 locale dirs under `apps/web/src/locales` (`de-DE en es-419 fr-CA fr-FR it-IT pt-BR tr-TR`); `localeParity` in `apps/web/src/lib/i18n` enforces it.
- **Web.** Hash state via `useHashState`; reads only (no new web mutation), so `runAction` is not needed.
- **Public repo.** No customer names, hostnames or IPs. Test URLs use `https://app.example.com`.
- **Commit after every task.** Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage explicitly, never `git add -A`.

## Tenancy (read `docs/agents/tenancy-rls.md` first)

| Change | Table | Registration impact |
|---|---|---|
| New `mcp_api` rows | `action_intents` (existing; RLS forced; cascade/merge/export registered) | None — no column added. |
| Partial index `action_intents_live_origin_idx` | `action_intents` | None (index only). |
| Ledger `intent_id` populated | `ai_tool_executions` (existing column) | None. |
| Audit rows | `audit_logs` | None. |

Run `rls-coverage` (`DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`, per `docs/agents/testing.md:52`), `tenant-export-policy` and `tenantCascade` on the wave stack anyway (Task 12) — cheaper than arguing "no change".

## Review Focus

1. **An org-pinned API key whose creator is partner-wide files `manage_tickets:move_org` to another org of the same partner.** Release refuses (`mcp_org_out_of_scope`); no `targetOrgId` widening. `release never widens an org-pinned key to targetOrgId` (Task 3).
2. **The key is revoked, its `ai:execute` scope removed, or its domain grant narrowed while the intent waits for approval.** The approved intent fails at release with the matching errorCode; nothing executes. `release refuses when the origin credential changed after creation` (Task 3).
3. **Two credentials of the same human, same tool and arguments.** Two intents; neither can read or cancel the other's (`not_found`). `same user, different credential: separate intents and no cross-read` (Tasks 5, 8).
4. **Twenty-one concurrent creations from one credential.** Exactly 20 intents; one `too_many_pending_actions`; at most 20 pushes. `cap holds under concurrency` (Task 4, integration).
5. **A `requestState` replayed by a different credential, on a different tool, with edited arguments, or after 10 minutes.** Each → `-32602`, none creates an intent; the expired one returns `data.actionId`. `requestState is bound to principal, tool, arguments and time` (Task 9).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/mcpActionStatus.ts` (new) | `toMcpActionStatus`, `buildPendingApprovalResult`, intrinsic tool definitions + list entries for `get_action_status`/`cancel_action`. Pure. |
| `apps/api/src/services/mcpRequestState.ts` (new) | `sealMcpRequestState` / `openMcpRequestState`. Pure (key injected). |
| `apps/api/src/services/mcpIntentEligibility.ts` (new) | `isMcpIntentEligible`, `mcpOriginRef`, `mcpIntentIdempotencyKey`. Pure. |
| `apps/api/src/services/mcpPrincipalAuth.ts` (new) | `buildAuthFromApiKey` (moved), `loadLiveMcpOriginCredential`, `rebuildMcpOriginAuthContext`, `checkMcpOriginReleaseAuthority`. |
| `apps/api/src/services/mcpTier3Lifecycle.ts` (new) | `runMcpTier3Lifecycle`, `writeMcpToolAuditEvent`, `McpAuditSink`, `requestAuditSink`, `systemAuditSink`, `writeMcpIntentOutcomeAudit`. |
| `apps/api/src/services/mcpIntentCreation.ts` (new) | `createMcpActionIntent` — the MCP-side orchestration (refusals, validation, org, cap, churn, label, correlation). |
| `apps/api/src/routes/mcpServer.ts` (modify) | Gate reorder, intent branch, listing, intrinsic tools, continuation branch, `whoami` field. |
| `apps/api/src/services/actionIntents/intentService.ts` (modify) | `correlationId` input, replay origin checks, cap lock + count, notify gate. |
| `apps/api/src/services/actionIntents/actorContext.ts` (modify) | `mcp_api` branch in `buildAuthContextForIntent`. |
| `apps/api/src/services/actionIntents/revalidateRelease.ts` (modify) | Call `checkMcpOriginReleaseAuthority`. |
| `apps/api/src/jobs/intentReleaseWorker.ts`, `jobs/intentExpiryReaper.ts` (modify) | Lifecycle wrap, terminal audit, outcome notice gate, stale ledger. |
| `apps/api/src/routes/approvals.ts` (modify) | D-B35 origin branch in report-suspicious. |
| `apps/api/src/services/apiKeyRevocation.ts` (new), `routes/apiKeys.ts`, `middleware/apiKeyAuth.ts` (modify) | `revokeApiKey` extracted from the DELETE handler; `isApiKeyCreatorEpochStale` extracted from the middleware. |
| `apps/api/src/routes/actionIntents.ts` (modify) | `GET /:id/status` for requester or approver. |
| `apps/api/src/services/aiAgentSystemPrompt.ts`, `services/mcpWhoami.ts`, `services/mcpDomains.ts` (modify) | Rules text, `approvalGate`, `core` for the two intrinsics. |
| `apps/api/src/config/env.ts`, `config/validate.ts`, root `.env.example` (modify) | `MCP_TIER3_INTENTS_ENABLED`, caps, wait. |
| `apps/api/migrations/2027-01-02-140000-action-intents-live-origin-idx.sql` (new) | The partial index. |
| `apps/web/src/components/approvals/ApprovalsInbox.tsx`, `apps/web/src/locales/*/approvals.json` (modify) | Requester status card for `#intent-<id>` not in the loaded rows; re-resolve after load. |
| `apps/docs/src/content/docs/features/mcp-server.mdx` (modify) | "Approvals over MCP" section, env rows. |

---

### Task 1: `mcpActionStatus.ts` — status projection and the two intrinsic tools

**Files:** Create `apps/api/src/services/mcpActionStatus.ts` + `mcpActionStatus.test.ts`. Modify `services/mcpDomains.ts` (`mcpToolDomain`, `:63`) so both names are `core`.

**Interfaces — Produces:**
```ts
export const MCP_GET_ACTION_STATUS_TOOL_NAME = 'get_action_status';
export const MCP_CANCEL_ACTION_TOOL_NAME = 'cancel_action';
export const MCP_GET_ACTION_STATUS_TOOL_LIST_ENTRY: Record<string, unknown>;  // whoami pattern: name, title, description, inputSchema {actionId: uuid}, annotations readOnly
export const MCP_CANCEL_ACTION_TOOL_LIST_ENTRY: Record<string, unknown>;      // annotations: readOnly false, destructive false, idempotent true
export type McpActionPublicStatus = 'pending_approval'|'in_progress'|'completed'|'failed'|'rejected'|'expired'|'cancelled';
export type McpActionStatus = { actionId: string; status: McpActionPublicStatus; toolName: string; approvalScope: 'four_eyes'|'supervised';
  expiresAt: string; approvalUrl: string; result?: string; resultWithheld?: 'secret_bearing'; errorCode?: string; outcomeUncertain?: true };
export function mapIntentStatus(s: ActionIntentStatus): McpActionPublicStatus;
export function toMcpActionStatus(intent: Pick<ActionIntent,'id'|'status'|'actionName'|'approvalScope'|'expiresAt'|'result'|'errorCode'|'executedAt'>, appBaseUrl: string): McpActionStatus;
export function isIntentOutcomeUncertain(intent: Pick<ActionIntent,'status'|'errorCode'|'executedAt'>): boolean;
export function buildPendingApprovalResult(status: McpActionStatus): { content: Array<{type:'text';text:string}>; structuredContent: McpActionStatus & { next: string } };
export function mcpApprovalUrl(appBaseUrl: string, intentId: string): string;   // `${base}/approvals#intent-${id}`, base trailing slashes stripped
```
- [ ] **Step 1: Write the failing tests.**
  ```ts
  it.each([['pending_approval','pending_approval'],['approved','in_progress'],['executing','in_progress'],['completed','completed'],
    ['failed','failed'],['rejected','rejected'],['expired','expired'],['cancelled','cancelled']])('maps %s → %s', (s, e) => expect(mapIntentStatus(s as never)).toBe(e));
  it('completed carries the result compacted under the ORIGINAL action name', () => { /* spy compactToolResultForChat, assert called with intent.actionName */ });
  it.each(['tool in SECRET_BEARING_TOOLS (even after burn)', 'result has a sealed temporary password'])('withholds a secret-bearing result: %s', ...);
  it('pending result is a normal result: isError absent, structuredContent.next names get_action_status', () => { ... });
  it('approval URL carries only the intent id', () => expect(mcpApprovalUrl('https://app.example.com/', ID)).toBe(`https://app.example.com/approvals#intent-${ID}`));
  it('both intrinsics are core', () => { expect(mcpToolDomain('get_action_status')).toBe('core'); expect(mcpToolDomain('cancel_action')).toBe('core'); });
  ```
  "Secret-bearing" = `isSecretBearingTool(actionName)` OR `hasSealedTemporaryPassword(result)` — the markers the reveal-secret route (`routes/actionIntents.ts:56`) already uses; do not invent one.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/mcpActionStatus.test.ts src/services/mcpDomains.test.ts` → FAIL.
- [ ] **Step 3: Implement.** No unknown-outcome errorCode set exists today. `failed` gets `outcomeUncertain: true` when `intent.executedAt` is set (the worker's `failIntent(…, { executed: true })`, `jobs/intentReleaseWorker.ts:927-959`, stamps it — covers `execution_error` incl. tool timeouts and the secret-seal invariant) or `errorCode === 'execution_lost'` (the stale-executing reaper, `jobs/intentExpiryReaper.ts:382`). That is `isIntentOutcomeUncertain` above.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(mcp): action-status projection and intrinsic tool definitions (B-W04 #6158)`.

### Task 2: `mcpRequestState.ts` and `mcpIntentEligibility.ts` — pure helpers

**Files:** Create both + `*.test.ts`.

**Interfaces — Produces:**
```ts
// mcpRequestState.ts
export type McpRequestStatePayload = { v: 1; a: string; p: string; m: 'tools/call'; t: string; d: string; e: number };
export const MCP_REQUEST_STATE_TTL_S = 600, MCP_REQUEST_STATE_MAX_BYTES = 1024;
export function mcpRequestStateKey(): Buffer;   // hkdfSync per D-B32; throws in production when no secret; test-only fallback mirrors emailUnsubscribeToken.ts
export function sealMcpRequestState(p: Omit<McpRequestStatePayload,'v'|'e'>, key: Buffer, nowS: number): string;
export function openMcpRequestState(raw: unknown, key: Buffer, nowS: number):
  | { ok: true; payload: McpRequestStatePayload } | { ok: false; reason: 'invalid_request_state' } | { ok: false; reason: 'request_state_expired'; payload: McpRequestStatePayload };
// mcpIntentEligibility.ts
export type McpOriginRef = `api_key:${string}` | `oauth_grant:${string}`;
export function mcpOriginRef(principal: AuthContext['principal']): McpOriginRef | null;   // null for partner SP / anything else
export function mcpIntentIdempotencyKey(ref: McpOriginRef, toolName: string, argumentDigest: string): string; // 'mcp:v1:' + sha256 hex
export type McpIntentEligibilityInput = { flagOn: boolean; ref: McpOriginRef | null; isServiceKey: boolean; toolName: string;
  registryTier: number | undefined; effectiveTier: number; isTenantTool: boolean; isBootstrapTool: boolean; isApprovalExtra: boolean;
  mfaRefused: boolean; scopes: readonly string[]; requireExecuteAdmin: boolean; allowedInProd: boolean; isProduction: boolean };
export type McpIntentIneligibleReason = 'flag_off'|'principal_not_supported'|'not_tier3'|'tenant_tool'|'bootstrap_tool'|'approval_extra'|'mfa_required'|'scope'|'not_allowlisted';
export function isMcpIntentEligible(i: McpIntentEligibilityInput): { ok: true } | { ok: false; reason: McpIntentIneligibleReason };
```
- [ ] **Step 1: Write the failing tests.**
  ```ts
  it('round-trips and rejects a flipped byte', () => { const s = seal(...); expect(open(s).ok).toBe(true); expect(open(flip(s)).ok).toBe(false); });
  it('expired authentic state returns its payload so the caller can check p before exposing a', () => expect(open(seal(..., 0), key, 601)).toEqual({ ok: false, reason: 'request_state_expired', payload: expect.objectContaining({ a: ID, p: REF }) }));
  it('rejects oversize, non-string, wrong key, v != 1', ...);
  it('idempotency key differs per origin and is stable per input', ...);
  it.each(eligibilityMatrix)('%s', ...);   // one row per McpIntentIneligibleReason + the ok row; collect_evidence (registry 2, effective 3) → 'approval_extra' (approval-extra is checked before the tier test)
  it('partner service principal has no origin ref', () => expect(mcpOriginRef({ kind: 'api_key', apiKeyId: 'k', partnerServicePrincipalId: 'sp' })).toBeNull());
  ```
- [ ] **Steps 2–5:** red (`npx vitest run src/services/mcpRequestState.test.ts src/services/mcpIntentEligibility.test.ts`), implement, green, commit.

### Task 3: `mcpPrincipalAuth.ts` — one auth builder for the call and for release

**Files:** Create `apps/api/src/services/mcpPrincipalAuth.ts` + `mcpPrincipalAuth.test.ts`. Modify `middleware/apiKeyAuth.ts` (extract `isApiKeyCreatorEpochStale`), `routes/mcpServer.ts` (delete `buildAuthFromApiKey` `:3015-3188` and the `McpApiKeyContext` type `:370`, import both), `middleware/bearerTokenAuth.ts` (export `filterBlockedOAuthClientOrgIds` `:370`), `services/actionIntents/actorContext.ts` (`buildAuthContextForIntent` `:105` — the `mcp_api` branch serves all three callers, D-B26), `services/actionIntents/revalidateRelease.ts` (`:485` call site inside `revalidateApprovedIntentCore` `:314`, before the RBAC block `:555`).

**Interfaces:**
- Consumes Task 2 (`mcpOriginRef`, `isMcpIntentEligible`).
- Produces:
  ```ts
  export async function buildAuthFromApiKey(apiKey: McpAuthKeyInput): Promise<AuthContext | null>;  // moved verbatim; McpAuthKeyInput = its current parameter type, exported
  export type McpApiKeyContext = /* moved verbatim from mcpServer.ts:370 (route-local today); mcpServer.ts re-imports it */;
  export type LiveMcpOriginCredential = { kind: 'api_key' | 'oauth_grant'; keyInput: McpAuthKeyInput; scopes: string[]; domainGrant: McpDomainGrant; humanUserId: string };
  export type McpOriginReleaseErrorCode = 'mcp_origin_revoked'|'mcp_scope_lost'|'mcp_domain_lost'|'mcp_org_out_of_scope'|'mcp_tool_not_allowed'|'mcp_mfa_required'|'mcp_intents_disabled';
  export async function loadLiveMcpOriginCredential(intent: ActionIntent): Promise<LiveMcpOriginCredential | { error: 'mcp_origin_revoked' }>;
  export async function rebuildMcpOriginAuthContext(intent: ActionIntent): Promise<{ auth: AuthContext; credential: LiveMcpOriginCredential } | { error: McpOriginReleaseErrorCode }>;
  export function checkMcpOriginReleaseAuthority(intent: ActionIntent, rebuilt: { auth: AuthContext; credential: LiveMcpOriginCredential }): { ok: true } | { ok: false; errorCode: McpOriginReleaseErrorCode };
  ```
  `buildAuthContextForIntent` keeps its `AuthContext | null` contract: for `mcp_api` it returns `rebuilt.auth` or `null`, so `decideApprovalRequest.ts:825` and `m365ToolsHeadless.ts:238` need no edit and can never see the user-owned context. `revalidateApprovedIntentCore` (`:485`) calls `rebuildMcpOriginAuthContext` directly for `mcp_api` to keep the specific errorCode, then `checkMcpOriginReleaseAuthority`.
- [ ] **Step 1: Write the failing tests** (`mcpPrincipalAuth.test.ts`, Drizzle mocks per `breeze-testing`):
  - `release never widens an org-pinned key to targetOrgId` — org key, partner-wide creator, `manage_tickets:move_org` intent → `mcp_org_out_of_scope`, and the user-owned path is not called.
  - `release auth carries no synthetic MFA` — rebuilt `auth.token` has no `mfa`; an MFA-gated action → `mcp_mfa_required`.
  - `release refuses when the origin credential changed after creation` — `it.each`: key revoked / expired / credential epoch bumped / MFA epoch bumped → `mcp_origin_revoked`; `ai:execute` removed → `mcp_scope_lost`; delegation no longer backed → `mcp_scope_lost`; `mcp_domains` narrowed → `mcp_domain_lost`; production allowlist drops tool → `mcp_tool_not_allowed`; flag off → `mcp_intents_disabled`.
  - `OAuth: revoked or expired grant → mcp_origin_revoked; grant user ≠ requester → mcp_origin_revoked; client blocked for the org → mcp_origin_revoked; partner inactive → mcp_origin_revoked`.
  - `OAuth key input is built from the grant row and scopes are expanded mcp:* → ai:* before the ai:execute check` (a grant with `mcp:execute` passes; without it → `mcp_scope_lost`).
  - `api key creator ≠ requested_by_user_id → mcp_origin_revoked`.
  - `creator / grant user disabled after creation → mcp_origin_revoked` (`it.each` over API key incl. a pre-epoch key with NULL snapshots, and OAuth).
  - `all three buildAuthContextForIntent callers get the origin context for mcp_api` — decide-time supervised RBAC re-check, release revalidation, and an M365 secret-aware release (`executeM365ToolHeadless` → `m365ToolsHeadless.ts:238`) of an `mcp_api` intent each receive `token: {}` and the key's org pin, never the user-owned rebuild.
  - `non-mcp_api intents never reach rebuildMcpOriginAuthContext` (chat and agent fixtures).
  - In `mcpServer.creatorAuthz.test.ts` / `mcpServer.orgKeyPartnerRole.test.ts`: unchanged and green (the move is verbatim).
- [ ] **Step 2:** `npx vitest run src/services/mcpPrincipalAuth.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Credential checks reuse, never re-spell: `activeGrantCondition`, `computeEffectiveMcpScopes`, `validateApiKeyScopeDelegation`, the epoch comparison (inline in `apiKeyAuthMiddleware`, `middleware/apiKeyAuth.ts:222-227` — extract it to an exported `isApiKeyCreatorEpochStale(apiKey, creator): boolean` in the same file and call it from both places; the creator epoch select is at `:189-201`), `parseStoredMcpDomains` + `isDomainGranted` + `mcpToolDomain`. All reads under `withSystemDbAccessContext`, no outbound I/O.
- [ ] **Step 4:** Green, then rerun `mcpServer.creatorAuthz`, `mcpServer.creatorPermsNull`, `mcpServer.partnerCreatorPermsNull`, `mcpServer.orgKeyPartnerRole`, `mcpServer.bearer`, `jobs/intentReleaseWorker.test.ts` (one or two files per invocation). Re-pin `SAFE_WRITE_SITES` if `aiTools.userOwnedRelease.contract.test.ts` goes red on line drift only.
- [ ] **Step 5:** Typecheck `apps/api` (read exit), commit `feat(intents): release mcp_api intents under the live origin credential (B-W04 #6158)`.

### Task 4: `intentService` — origin replay checks, cap, notify gate, migration

**Files:** Modify `services/actionIntents/intentService.ts` (`CreateActionIntentInput` `:178-317`; replay `:1943-1947`, `:2448-2463`; insert `:2268-2331`; notify `:2701-2705`), `jobs/intentReleaseWorker.ts` (`:1951`). Create `apps/api/migrations/2027-01-02-140000-action-intents-live-origin-idx.sql`. Tests: `services/actionIntents/intentService.test.ts`; create `apps/api/src/__tests__/integration/mcpIntentCap.integration.test.ts`.

**Interfaces — Produces:** `CreateActionIntentInput` gains `correlationId?: string` (uuid; used only when `source === 'mcp_api'`, else `randomUUID()`) and `maxLiveForOrigin?: number` (cap, `mcp_api` only). New `ActionIntentError` code `too_many_pending_actions`. Churn charging lives in Task 5 (Redis, outside the DB context) but runs between the replay lookup and the insert: `createActionIntent` accepts `beforeInsert?: () => Promise<void>` (throws `ActionIntentError('rate_limited')`), invoked only when a new row is about to be inserted.

- [ ] **Step 1: Write the failing tests.**
  - `mcp_api replay with a different origin principal → idempotency_conflict` (both branches; caller-verification fixture for `:1943`).
  - `mcp_api replay with same origin returns the live intent and does not re-notify`.
  - `correlationId is stored for mcp_api and ignored for chat`.
  - `supervised mcp_api intent notifies its requester` (push + in-app) and `four_eyes still notifies` (regression).
  - Worker: `supervised mcp_api outcome notifies the requester; supervised chat still does not`.
  - Integration (`mcpIntentCap.integration.test.ts`): `cap holds under concurrency` — 21 parallel `createActionIntent` with one origin, `maxLiveForOrigin: 20` → 20 rows, 1 `too_many_pending_actions`; a second origin is unaffected; a terminal intent frees a slot; `at the cap, a replay of a live intent returns that intent, not too_many_pending_actions`.
  - Integration skeleton of Task 12's round trip (`mcpIntentRoundTrip.integration.test.ts`, scenario 1 only: Tier-3 `tools/call` → `pending_approval` + intent row). It stays red until Task 7 lands, which is the point.
- [ ] **Step 2:** `npx vitest run src/services/actionIntents/intentService.test.ts` → FAIL. Bring up the wave stack now (recipe in Task 12 Step 2) and keep it up through Task 12; run `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/mcpIntentCap.integration.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Write the migration exactly as D-B33 (header comment: why, no tenancy change, `CONCURRENTLY` reason). For `mcp_api` only, follow D-B27's five-step order exactly (lock → replay lookup → cap → churn → insert). Run `pnpm db:check-drift`.
- [ ] **Step 4:** Green. `bash scripts/check-migration-naming.sh` passes.
- [ ] **Step 5:** Commit `feat(intents): per-origin replay binding and live cap for mcp_api (B-W04 #6158)`.

### Task 5: `createMcpActionIntent` — the MCP-side creation orchestration

**Files:** Create `apps/api/src/services/mcpIntentCreation.ts` + `mcpIntentCreation.test.ts`. Modify `config/env.ts`, `config/validate.ts`, root `.env.example` (next to the `MCP_*` block, `.env.example:690-715`).

**Interfaces:**
- Consumes Tasks 1, 2, 4.
- Produces:
  ```ts
  export type CreateMcpActionIntentInput = { auth: AuthContext; apiKey: McpApiKeyContext; toolName: string; toolInput: Record<string, unknown>;
    executionOrgId: string; correlationRequestId: string; clientLabel: string };
  export type CreateMcpActionIntentOutcome =
    | { kind: 'pending'; status: McpActionStatus; isNew: boolean }
    | { kind: 'terminal_replay'; status: McpActionStatus }
    | { kind: 'refused'; code: 'too_many_pending_actions' | 'rate_limited' | 'no_eligible_approvers' | 'no_eligible_approvers_site_ceiling' | 'invalid_params' | 'principal_not_supported'; message: string };
  export async function createMcpActionIntent(input: CreateMcpActionIntentInput): Promise<CreateMcpActionIntentOutcome>;
  ```
  Env: `MCP_TIER3_INTENTS_ENABLED` (`envFlag`, false), `MCP_INTENT_MAX_LIVE_PER_PRINCIPAL` (20), `MCP_INTENT_CREATES_PER_HOUR` (60), `MCP_INTENT_CREATES_PER_USER_PER_HOUR` (60), `MCP_APPROVAL_WAIT_MS` (20000), `MCP_APPROVAL_WAITS_PER_PRINCIPAL` (2); integer validation in `validate.ts`.
- [ ] **Step 1: Write the failing tests.**
  - `invalid tool input is refused before insert` (`validateToolInput` fails → `invalid_params`, `createActionIntent` not called).
  - `org service-principal key → principal_not_supported`; `partner SP → principal_not_supported`.
  - `passes executionOrgId, source mcp_api, the mcp:v1 idempotency key, correlationId, label "MCP · <name>"`.
  - `same user, different credential: separate intents` — two `apiKey` ids, same tool/args → two different idempotency keys.
  - `churn guard: the 61st creation in an hour → rate_limited; a replay of a live intent is not charged`.
  - `per-user guard: one human across two credentials hits rate_limited at 61 creations/hour`.
  - `no_eligible_approvers and no_eligible_approvers_site_ceiling map to refusals, not pending results, and stay charged`.
  - `the argument digest equals the stored argument_digest` (computed with `computeArgumentDigest(canonicalizeArguments(toolInput))`).
- [ ] **Steps 2–5:** red, implement, green, commit `feat(mcp): create mcp_api action intents (B-W04 #6158)`.

### Task 6: `mcpTier3Lifecycle.ts` — one lifecycle for the call and for release

**Files:** Create `apps/api/src/services/mcpTier3Lifecycle.ts` + test. Modify `routes/mcpServer.ts` (move `writeMcpToolAuditEvent` `:2150`, `Tier3LifecycleContext`/`Tier3ExecutionOutcome` `:2217-2260`, `runTier3ToolLifecycle` `:2275` → `runMcpTier3Lifecycle`, `finalizeTier3ToolLifecycle` `:2331` → private helper of the new module), `services/mcpRequestCorrelation.ts` *(B-W03)* (export `McpReleaseCorrelation` beside `McpRequestCorrelation`), `services/mcpToolExecutionLedger.ts` (begin input gains `intentId?: string`; `era` widens with `'release'`), `jobs/intentReleaseWorker.ts` (dispatch block `:1390-1475`; terminal branch `:2026-2032`), `jobs/intentExpiryReaper.ts` (`reapStaleExecutingIntents` `:305`).

**Interfaces — Produces:**
```ts
export type McpAuditSink = (event: AuditEventInput) => void | Promise<void>;
export function requestAuditSink(c: Context): McpAuditSink;     // wraps writeAuditEvent(c, …)
export const systemAuditSink: McpAuditSink;                      // createAuditLogAsync, ip/userAgent null
export type McpLifecyclePrincipal = { apiKeyId: string; oauthGrantId: string | null; partnerId: string | null; partnerServicePrincipalId: string | null; actorUserId: string | null };
export type McpReleaseCorrelation = { kind: 'intent_release'; requestId: string; intentId: string; creationRequestId: string; principalKey: McpOriginRef };
export type McpTier3LifecycleContext = Omit<Tier3LifecycleContext, 'c' | 'apiKey' | 'sessionId'> & { audit: McpAuditSink; principal: McpLifecyclePrincipal;
  correlation: McpRequestCorrelation | McpReleaseCorrelation; intentId?: string };   // ledger era: 'legacy' | 'modern' | 'release'
export async function runMcpTier3Lifecycle<R>(ctx: McpTier3LifecycleContext,
  execute: (ledger: McpToolExecutionLedgerHandle | null) => Promise<{ status: 'success'|'failure'; ledgerResult?: string; error?: unknown; response: R }>,
  onLedgerUnavailable: () => R): Promise<R>;
export async function writeMcpIntentOutcomeAudit(intent: ActionIntent, outcome: 'rejected'|'expired'|'cancelled'|'release_refused', errorCode?: string): Promise<void>;  // deduped
```
The route keeps its JSON-RPC response type by passing `R = JsonRpcResponse`; the worker passes its own outcome type.

- [ ] **Step 1: Write the failing tests.**
  - `the request sink and the system sink receive identical audit details for the same outcome, except ip/userAgent and details.correlation`.
  - Worker (`intentReleaseWorker.test.ts`): `mcp_api release writes ledger with intent_id, then mcp.tool.<name> audit`; `ledger begin failure → failed mcp_ledger_unavailable and the tool is never dispatched`; `a Google secret-aware branch is wrapped too` (fixture with `secretAction`); `chat intents are not wrapped` (no ledger row, unchanged audit).
  - `terminal audit is written once under redelivery` (call the terminal branch twice).
  - `release-refused mcp_api intent writes a failure audit with errorCode`.
  - Reaper: `stale executing mcp_api intent also fails its ledger row`.
  - Route regressions unchanged and green: `mcpServer.approvalGate.test.ts` (unattended describe), `mcpServer.bootstrapLifecycle.test.ts`, `mcpServer.returnedError.test.ts`, `mcpToolExecutionLedger.test.ts`.
- [ ] **Steps 2–5:** red, implement (move first, then the worker wrap), green, typecheck, commit `refactor(mcp): transport-neutral Tier-3 lifecycle; release worker uses it for mcp_api (B-W04 #6158)`.

### Task 7: Route — gate reorder, intent branch, listing, `whoami`

**Files:** Modify `routes/mcpServer.ts` (`handleToolsCall` gate `:1713-1719` → after rate limit `:1771` and execution-org resolution `:1790`; `tools/list` filter `:1384`, suffix `:1422-1424`; `handleWhoamiCall` `:1921`), `services/mcpWhoami.ts`. **Rewrite** `routes/mcpServer.approvalGate.test.ts` (today asserts fail-closed — keep the file, flip its first describe).

**Interfaces:** Consumes Tasks 1, 2, 5. Flag **off**: the gate at `:1713-1719` is untouched (same position, same body). Flag **on**, effective Tier-3, non-unattended call: domain → guardrail tier → scope/admin → prod allowlist → MFA gate → RBAC → per-tool rate limit → `resolveMcpExecutionContext` → `isMcpIntentEligible` → `createMcpActionIntent` → `buildPendingApprovalResult`. Ineligible with the flag on → today's `MCP_APPROVAL_REQUIRED` tool result whose JSON text also carries `reason` (D-B25).

- [ ] **Step 1: Write the failing tests** (`mcpServer.approvalGate.test.ts`, flag on unless named):
  - `flat Tier 3 (execute_command) is listed with the approval suffix and returns pending_approval without executing` (`executeTool` spy not called; `createActionIntent` called once with `source: 'mcp_api'`).
  - `mixed tool: registry_operations set_value → pending; get_value executes`.
  - `manage_invoices issue → pending; create_draft executes`; `manage_tickets comment isPublic → pending`.
  - `scope gates run BEFORE intent creation`: no `ai:execute` → `-32603 requires ai:execute`, no intent; prod without admin → refused, no intent; prod not allowlisted → refused, no intent; RBAC denial → refused, no intent.
  - `domain-denied call never creates an intent`.
  - `MFA-gated action for a caller without MFA → MCP_APPROVAL_REQUIRED reason mfa_required`.
  - `mixed tool listing uses per-action wording; flat tool uses the suffix` (D-B34).
  - `collect_evidence stays MCP_APPROVAL_REQUIRED (approval_extra)`; `Tier 4 unlisted and denied`; `tenant tier-3 tool unlisted`; `bootstrap tool unlisted`.
  - `flag off: Tier-3 tools/call and listing are today's fail-closed behaviour, byte-identical` (snapshot of the current bodies) — fixtures include a caller **without** `ai:execute` (still `MCP_APPROVAL_REQUIRED`, not `requires ai:execute`) and assert the per-tool rate limiter is not called; `tools/list` differs only by the two intrinsics (D-B31).
  - `replayed call returns the same actionId and charges no creation quota`.
  - `whoami reports approvalGate.tier3 = approval_intent | web_app_only | unattended`.
  - Keep the whole `MCP_UNATTENDED_TIER3_PRINCIPALS` describe unchanged and green.
  - `mcpServer.conformance.contract.test.ts`: per version, a Tier-3 call yields a `pending_approval` `structuredContent` (flag on).
- [ ] **Step 2:** `npx vitest run src/routes/mcpServer.approvalGate.test.ts` → FAIL.
- [ ] **Step 3: Implement.** The direct-execution block below keeps running only for unattended principals.
- [ ] **Step 4:** Green; rerun `mcpServer.test.ts`, `mcpServer.domains.test.ts`, `mcpServer.effectiveTier.test.ts`, `mcpServer.stepUp.test.ts`, `mcpServer.conformance.contract.test.ts`, `src/__tests__/mcp-coverage.test.ts`, `services/mcpToolPresentation.guardrailParity.contract.test.ts`.
- [ ] **Step 5:** Typecheck, commit `feat(mcp)!: Tier-3 tools/call files an approval intent instead of failing closed (B-W04 #6158)`.

### Task 8: Route — `get_action_status` and `cancel_action`

**Files:** Modify `routes/mcpServer.ts` (list next to `MCP_WHOAMI_TOOL_LIST_ENTRY` `:1440`; dispatch next to the `whoami` branch `:1615`). Create `routes/mcpServer.actionStatus.test.ts` (harness copied from `mcpServer.domains.test.ts`).

**Interfaces:** Consumes Task 1. Produces `handleActionStatusCall(id, auth, scopes, apiKey, args)` and `handleCancelActionCall(...)`; ownership via one helper `loadOwnedMcpIntent(auth, apiKey, actionId): Promise<ActionIntent | null>` (DB access context from `auth`, `source = 'mcp_api'`, origin match).

- [ ] **Step 1: Write the failing tests.**
  - `listed for human API keys and OAuth grants, not for partner service principals or org service keys; get is readOnly, cancel is not`.
  - `table-driven status mapping across all 8 intent statuses`.
  - `not_found is identical for unknown id, another key's intent, another org's intent, a chat intent and the same user's other credential` (assert equal error bodies).
  - `get_action_status needs only ai:read; cancel_action needs ai:write`.
  - `cancel pending → cancelled; cancel executing → not_cancellable with status in_progress; cancel loses the CAS race → reports the winner's status`.
  - `completed result is compacted under the original action name; secret-bearing result withheld`.
  - `both keep working with MCP_TIER3_INTENTS_ENABLED off`.
- [ ] **Steps 2–5:** red, implement, green, commit `feat(mcp): get_action_status and cancel_action tools (B-W04 #6158)`.

### Task 9 (PR B): URL-mode elicitation and `requestState` continuation

**Files:** Modify `routes/mcpServer.ts` (`McpDispatchContext` *(B-W03)* gains `clientCapabilities`; `tools/call` continuation branch when `params.requestState` is present — after the `ai:read` preflight and the `core` domain check, before the Tier-3 scope gates; `decline` additionally requires `ai:write`), `services/mcpModernResult.ts` *(B-W03)* (`decorateModernResult` keeps `input_required`). Create `routes/mcpServer.urlElicitation.test.ts` (harness from `mcpServer.modern.test.ts` *(B-W03)*).

**Interfaces:** Consumes Tasks 1, 2, 5, 8 and B-W03's `classifyMcpRequest`/`decorateModernResult`. Produces `buildApprovalInputRequiredResult(status, requestState): Record<string, unknown>` (in `mcpActionStatus.ts`) and `handleToolsCallContinuation(...)`.

- [ ] **Step 1: Write the failing tests** (`MCP_STATELESS_ENABLED=true`, `MCP_TIER3_INTENTS_ENABLED=true`):
  - `modern client declaring elicitation.url gets input_required with one url elicitation and a requestState`; the result has `resultType: 'input_required'` and **no** `ttlMs`/`cacheScope`.
  - `elicitation: {} (form only), no elicitation, or legacy era → plain pending_approval`; `no response ever contains mode "form"` (scan every response in the suite).
  - `requestState is bound to principal, tool, arguments and time` — `it.each`: other credential, other tool name, edited arguments, flipped byte, 601 s later → `-32602` with the right `reason`; expired carries `data.actionId`; **none** calls `createActionIntent`.
  - `accept + approved within the wait → the tool's real result, rendered through toMcpActionStatus`; `accept + completed m365_reset_password → resultWithheld secret_bearing, no ciphertext in the response`; `accept + still pending after MCP_APPROVAL_WAIT_MS → complete pending_approval, no second elicitation`; `wait aborts when the client disconnects`; `third concurrent wait for one principal skips the wait`.
  - `decline → cancelActionIntent; reports cancelled, or the winner's status when the worker already claimed it`.
  - `cancel/absent inputResponses → current status, intent untouched`; `malformed inputResponses → -32602`.
  - `continuation never charges the per-tool rate limit`.
  - `HTTP status for input_required is 200` (B-W03 `resolveMcpHttpStatus`).
  - `expired state presented by another credential → -32602 without data.actionId`.
  - B-W03 `mcpServer.statelessParity.contract.test.ts`: add the documented exception row (Tier-3 call by a URL-capable modern client → `input_required` vs legacy `pending_approval`); confirm its other fixtures declare no `elicitation.url`.
  - Pinning guard (passes before and after, not a red step): `no response ever contains mode "form"` above.
- [ ] **Steps 2–5:** red, implement, green, typecheck, commit `feat(mcp): URL-mode elicitation for Tier-3 approvals on 2026-07-28 (B-W04 #6158)`.
- [ ] **Step 6: PR B docs + lab.** Add the "URL elicitation (2026-07-28 clients)" subsection to `apps/docs/src/content/docs/features/mcp-server.mdx`. Lab on the wave stack with `MCP_STATELESS_ENABLED=true` and the flag on: the MCP Inspector (or raw `curl` with SEP-2243 headers and `elicitation: { url: {} }`) gets `input_required`, opens the URL, approves, retries with `accept` → real result. Record it in PR B. Open PR B per Task 12 Step 4 and run one `/pr-review-toolkit:review-pr` round.

### Task 10: Instructions, `whoami` copy and report-suspicious origin branch

**Files:** Modify `services/aiAgentSystemPrompt.ts:43-56` (add `MCP_APPROVAL_RULES_INTENTS`, `buildMcpGuardrailsCore(intentsEnabled)`), `services/mcpGuidance.ts` (`buildMcpServerInstructions(intentsEnabled)`; `MCP_SERVER_INSTRUCTIONS` kept as the flag-off value for existing importers), `routes/mcpServer.ts` (`initialize` `:1075` and B-W03 `buildDiscoverResult` pass the flag), `services/mcpGuidance.test.ts`, `routes/approvals.ts:1089-1440` (report-suspicious), `routes/apiKeys.ts:682-727` (call the extracted revoker). Create `services/apiKeyRevocation.ts` + test (`revokeApiKey(keyId, actorUserId, reason): Promise<{ revoked: boolean }>`, idempotent, writes `api_key.revoke`; `DELETE /api-keys/:id` behaviour unchanged, its existing tests are the guard). Tests: `routes/approvals.test.ts`, `routes/approvalsReportSuspiciousPartnerScope.integration.test.ts`.

**Exact copy** for the new `MCP_APPROVAL_RULES_INTENTS` (rule numbers kept; today's `MCP_APPROVAL_RULES` stays byte-identical and is used when the flag is off):
```
3. Destructive operations (service restart, file delete, script/command execution, patch install, registry edits, elevation changes) require approval by a person in the Breeze mobile or web app, unless this connection is configured for unattended execution. Calling such a tool does NOT perform it: the call returns status "pending_approval" with an actionId, and nothing runs until someone approves.
3a. Creating or updating a policy that ARMS unattended action (software policies, update rings, peripheral policies) is approval-gated the same way. Reading them (list/get) is not.
3b. After a pending_approval result, tell the user it is waiting for approval in the Breeze app and has NOT happened yet. To learn the outcome, call get_action_status with the actionId; do not re-issue the original call and do not reach for another tool to get the same effect. Use cancel_action if the user no longer wants it.
3c. Report success only when get_action_status (or the call) returns status "completed". "rejected", "expired" and "cancelled" mean it did not happen. "failed" means it failed or its outcome is uncertain — effects may have occurred; repeat the reason given and do not claim it succeeded. A call refused with MCP_APPROVAL_REQUIRED was not filed for approval: tell the user to run it from the Breeze web app AI assistant.
```
- [ ] **Step 1: Write the failing tests.**
  - `mcpGuidance.test.ts`: `buildMcpServerInstructions(true)` contains `get_action_status`, `pending_approval`, `outcome is uncertain`, `unattended execution`, and not `this connection has no approval prompt`; `buildMcpServerInstructions(false)` equals today's `MCP_SERVER_INSTRUCTIONS` byte-for-byte.
  - `initialize` and `server/discover` serve the flag's variant.
  - Report-suspicious: `mcp_api oauth intent reported by its requester revokes that grant family and returns credentialRevoked true`; `mcp_api api-key intent reported by its requester sets the key revoked`; `reported by a non-owner approver → no revocation, owner + approvers notified, credentialRevoked false`; `revocation failure → captureException and credentialRevoked false with revocationError`; `non-mcp intents keep today's behaviour` (existing assertions unchanged); partner-scope integration test gains one `source: 'mcp_api'` row.
  - Pinning guard (passes today; not a red step): `MCP principal cannot decide` — `decideApprovalRequest` with an `api_key` and an `oauth_grant` principal → `human_decision_required` (`:532`).
- [ ] **Steps 2–5:** red, implement, green, commit `feat(approvals): MCP-origin report-suspicious and approval-aware MCP instructions (B-W04 #6158)`.

### Task 11: Web — requester-visible status for `/approvals#intent-<id>`

**Files:** Modify `apps/api/src/routes/actionIntents.ts` (add `GET /:id/status`), `apps/api/src/routes/actionIntents.test.ts`, `apps/api/src/services/mcpCoverage.ts` (`'actionIntents.ts'` note: the status read is human-only UI, still `exempt: 'identity'`), `apps/web/src/components/approvals/ApprovalsInbox.tsx` (`intentIdFromHash` `:261-264`, `useHashState` read `:278`, single-pass resolver `:523-545`, `intentGoneNotice` card `:1317-1335`), its test, `apps/web/src/locales/*/approvals.json` (8 dirs; the component uses `useTranslation('approvals')`, `:286`).

**Interfaces:** `GET /api/v1/action-intents/:id/status` → `{ id, status (mapped), actionLabel, targetSummary, approvalScope, requestingClientLabel, expiresAt, createdAt }` for the requester or a user with an `approval_requests` row on it; otherwise 404 (no oracle). JWT-session only (`authMiddleware`), not API keys.

- [ ] **Step 1: Write the failing tests.**
  - API: `requester sees status; fanned-out approver sees status; other org member → 404; unknown id → 404 (same body)`; `an API key / MCP bearer cannot call it`.
  - Web: `#intent-<id> matching a loaded row selects it (regression)`; `#intent-<id> not in the loaded rows shows the status card from GET /status`; `hash is re-resolved after the list loads` (fixes the single-pass `hashIntentHandledRef` lookup at `:528-529`); `404 keeps today's approval-intent-gone-notice card, no error toast`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/actionIntents.test.ts` and `cd apps/web && npx vitest run src/components/approvals` → FAIL.
- [ ] **Step 3: Implement.** New en keys in `approvals.json` (the component's `useTranslation('approvals')`, so keys are `intentStatus.title`, `intentStatus.waitingForApprovers`, `intentStatus.notFound`, `intentStatus.status.<mapped>` ×7), then the other 7 locales.
- [ ] **Step 4:** Green, plus `cd apps/web && npx vitest run src/lib/i18n` (localeParity) and `npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`. Typecheck `apps/web`.
- [ ] **Step 5:** Commit `feat(approvals): requester status card for intent deep links (B-W04 #6158)`.

### Task 12: Docs, contract suites, lab, PRs

**Files:** `apps/docs/src/content/docs/features/mcp-server.mdx` (new "Approvals over MCP" section: pending result, status tools, env table, OAuth-in-production note; URL elicitation is documented by Task 9 in PR B), root `.env.example` already done in Task 5, plan index row. (The 2026-07-18 plan already carries a "Superseded" note from the planning PR.) Extend `apps/api/src/__tests__/integration/mcpIntentRoundTrip.integration.test.ts` (skeleton from Task 4).

- [ ] **Step 1: Round-trip integration test** (real Postgres; seed org, approver, API key with `ai:execute`, flag on): Tier-3 `tools/call` → `pending_approval` + intent + approval rows + outbox; decide as approver → `approved`; invoke `processIntentReleaseJob` directly → `completed`, ledger row with `intent_id`, one `mcp.tool.<name>` audit; `get_action_status` → `completed` + result; replaying the call creates a **new** intent (terminal frees the key). Second scenario: revoke the key between approve and release → `failed mcp_origin_revoked`, tool never dispatched. Third: deny → `rejected` + failure audit once.
- [ ] **Step 2: Gates.** Whole API unit suite (`cd apps/api && npx vitest run`, small batches on a loaded host; record pass/fail counts from real output); web suite for touched dirs; typecheck `apps/api` and `apps/web` (exit codes). On a per-worktree stack (`pnpm wt-stack up`; root `.env` copied with AI keys blanked, `BREEZE_WORKSPACE_ENABLED=false`, free `BREEZE_DOCKER_SUBNET=172.31.N.0/24` + `BREEZE_CADDY_IP`): `--config vitest.integration.config.ts` for `mcpIntentRoundTrip`, `mcpIntentCap`, `approvalsReportSuspiciousPartnerScope`, `approvalsDecideSupervised`, `intentFanout`, `intentSupervisedFourEyes`, `tenant-export-policy`, and `tenantCascade.integration.test.ts` (+ its `tenantCascade*` siblings); `rls-coverage` is excluded from that config (`vitest.integration.config.ts:372`) — run it with `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. Then `pnpm wt-stack down` and say what was left running.
- [ ] **Step 3: Lab (PR A).** Same stack, flag on: (a) Claude Code (`claude mcp add --transport http …/api/v1/mcp/sse`, legacy era) calls a Tier-3 tool → pending; approve in the web inbox; `get_action_status` → completed. (b) Mobile app against the stack: the request appears in `/pending` with the `MCP · <name>` label and push arrives. (c) Requester opens `/approvals#intent-<id>` for a four-eyes intent → status card. Record each outcome in the PR. (URL elicitation is lab-checked in Task 9 Step 6.)
- [ ] **Step 4: PRs.** PR A (Tasks 1–8, 10–12): title `feat(mcp)!: B-W04 Tier-3 over MCP via action intents (#6154)`, body `Refs #6158 #4907 #3856`, gate counts, D-B25…D-B37 summary, Gate B decisions with defaults taken, breaking-change note (Tier-3 calls now return `pending_approval` when the flag is on). PR B (Task 9): `feat(mcp): B-W04 URL-mode elicitation for Tier-3 approvals (#6154)`, body `Closes #6158`, `Refs #4907 #3856`. A PR whose base is not `main` gets no CI: `gh workflow run CI --ref <branch>`.
- [ ] **Step 5:** One `/pr-review-toolkit:review-pr` round per PR (auth + approvals + migration surface). Update the plan index row to "PR A open".

---

## Exit checklist

- [ ] B-W03 seams confirmed on `main` before Task 1 (table above).
- [ ] `mcpServer.approvalGate.test.ts` flipped from fail-closed to pending-intent; the unattended describe untouched and green.
- [ ] `mcpServer.conformance.contract.test.ts` green for every version; `mcp-coverage.test.ts` green; `mcpToolPresentation.guardrailParity.contract.test.ts` green.
- [ ] `aiTools.userOwnedRelease.contract.test.ts` green (any `SAFE_WRITE_SITES` re-pin explained in its commit).
- [ ] Migration name accepted by `scripts/check-migration-naming.sh`; `pnpm db:check-drift` clean.
- [ ] Integration: round-trip, cap, report-suspicious, decide-supervised, fan-out, four-eyes, `rls-coverage`, `tenant-export-policy`, cascade — all on the wave stack, counts recorded.
- [ ] Flag off reproduces today's Tier-3 behaviour byte-for-byte (snapshot test; `tools/list` gains only the two intrinsics) and refuses queued `mcp_api` releases.
- [ ] No response anywhere contains `"mode":"form"`.
- [ ] Lab (a)–(c) recorded in PR A; URL-elicitation lab recorded in PR B.
- [ ] Stack torn down.

## CI traps

- `pnpm test` runs none of the integration suites; the cap, round-trip, report-suspicious, RLS and export-policy suites fail only under **Integration Tests**.
- `SAFE_WRITE_SITES` is line-keyed (above).
- `localeParity` lives in `apps/web/src/lib/i18n`, not beside the locale files.
- `mcp-coverage.test.ts` keys by route **file**; a new route in `actionIntents.ts` keeps its `exempt` entry but update the note.
- `tsc | tail` can mask a heap OOM as green — always `echo "exit=$?"`.
- A stacked PR B (base = PR A's branch) runs no CI until `gh workflow run CI --ref <branch>`.
