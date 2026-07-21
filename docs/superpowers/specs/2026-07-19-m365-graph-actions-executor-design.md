# M365 customer-graph-actions Executor + Headless Dispatch — Design

**Status:** Approved design, pre-implementation
**Date:** 2026-07-19
**Branch:** `ToddHebebrand/action-intents-durability` (PR #2628 base main)
**Related:**
- `docs/superpowers/specs/2026-07-13-breeze-m365-control-plane-design.md` (control-plane architecture; this is stage 5 "Mutation executors")
- `docs/superpowers/specs/2026-07-19-action-intents-phase2-google-headless-design.md` (Phase 2 Google headless — the worker-wiring template this mirrors)
- Memory: `action_intents_durable_approval_review`, `project_m365_control_plane_state`

---

## 1. Goal

Make the M365 Tier-3 mutation tools (`m365_disable_user`, `m365_reset_password`) executable **headless** by the durable release worker — the M365 equivalent of what Phase 2 did for Google — so an approved M365 action runs after the requesting tech's chat session ends.

Google fell out immediately because its connection model is already org-keyed and stable. M365 does not: the mutation path is being re-architected onto the control-plane model, and the replacement mutation executor (`customer-graph-actions`) **does not exist yet** — only the `customer-graph-read` executor and profile have shipped. Therefore this phase **builds the `customer-graph-actions` executor + org-keyed mutation seam** (the large piece), ending in the small worker-wiring edit that mirrors Google exactly.

### What is already on the ground (verified)

- **Read side shipped:** `apps/m365-graph-read-executor/` is a complete Hono sidecar — Ed25519-JWT internal auth (≤60s, body-hash-bound, per-operation claim), Azure Key Vault pinned-cert provider, two-layer Graph budgets (executor per-request + API per-connection Redis windows), API-side authz ladder (`readActionService.ts`), audit + Prometheus, typed read catalog (`packages/shared/src/m365/readActions.ts`), API client (`graphReadExecutorClient.ts`).
- **Actions side is a stub:** `customer-graph-actions` in `packages/shared/src/m365/profiles.ts` is v1, `executor:'graph-actions'`, declares 6 ReadWrite app permissions, has **no `applicationPermissionAssignments`**, and there is **no executor, no client, no service, no write catalog**. `executor:'graph-actions'` resolves to nothing.
- **Durable intent captures the raw tool input:** `createActionIntent` (via `aiAgentSdk.ts:556`) stores `arguments = { userIdentifier, reason }` (the LLM tool input) plus the pinned `orgId = session.orgId`, and an `argumentDigest` bound to that. The digest binds the **identifier string**, not a resolved object id. So headless execution receives `{ userIdentifier, reason }` and must resolve `userIdentifier`→object id itself — the actions app's `User.ReadWrite.All` covers that read. This mirrors inline behavior, where `resolveUserId` resolves fresh at execution.
- **Worker already fails these closed:** `intentReleaseWorker.ts:255` does `if (!isHeadlessGoogleTool(name) && requiresLiveSession(name)) failIntent('session_required')`. Because the two M365 Tier-3 tools are registered as session-aware handlers (not in the core `aiTools` map), `requiresLiveSession` is `true` and they fail `session_required` today. That is correct and safe until this phase lands.

---

## 2. Scope decisions (locked)

| # | Decision | Choice |
|---|---|---|
| a | Phase scope | **Build the executor this phase** (executor + org-keyed seam). Worker-wiring is the small terminal component, includable here or splittable to a follow-up PR. |
| b | First-cut actions | **Only the two existing tools:** `m365.user.disable`, `m365.user.reset_password`. Smallest write catalog; scopes limited to `User.ReadWrite.All` + `User-PasswordProfile.ReadWrite.All`. |
| c | Inline path + Delegant | **Headless-only executor; leave inline + Delegant untouched.** Delegant decommission stays stage 8 (after consumer migration). Inline chat keeps its current `resolveContext` (direct/Delegant). |
| d | Connection onboarding | **Execution spine only; provision connections minimally** (seed/thin extension sufficient to test end-to-end). Polished consent UI + grant reconciliation deferred. |
| e | Reset-password headless delivery | Executor sets `forceChangePasswordNextSignIn=true` and returns the temp password; stored in the RLS-protected `intent.result`; **revealed once** to the authorized requesting tech in the approvals UI. |

### Out of scope (explicit)

- The `customer-graph-actions` consent/onboarding lifecycle (complete-consent/retest operations, tenant-binding, grant reconciliation, consent UI) beyond the minimal provisioning needed to test.
- Any Delegant reauthorize/rotate/cutover/decommission work.
- Migrating the inline chat mutation path onto the executor (that is control-plane stage 7 "Consumer migration").
- Additional mutation actions (group membership, Intune retire, Exchange runbooks).
- Executor-side idempotency dedup store (see §5).
- **Production enablement.** The executor ships behind `isM365GraphActionsEnabledForOrg` **disabled by default**. Per the control-plane doc, mutation profiles remain disabled in production until read ops/approval/audit/idempotency/revocation are proven; enablement is a separate ops gate, not part of this build.

---

## 3. Approach

Mirror the shipped `customer-graph-read` executor for the mutation domain — same sidecar shape, internal auth, credential provider, budget, authz ladder, and audit surfaces. The one genuine alternative — folding mutations into the read executor to avoid a second consent flow — is **rejected** by the locked credential-domain-separation invariant (control-plane doc line 128: separate application identity per domain; combining requires explicit security review). Separate read/write blast-radius isolation is a security requirement, not an optimization.

The build is a vertical slice (components A–G) ending in the worker edit so the slice is end-to-end integration-testable.

---

## 4. Components

### A. Shared write-action catalog — `packages/shared/src/m365/writeActions.ts`

Mirrors `readActions.ts`.

- `M365_WRITE_ACTION_IDS = ['m365.user.disable', 'm365.user.reset_password']`
- `m365WriteActionSchema`: `z.discriminatedUnion('type', …)` with `.strict()` per variant; each variant `{ type, userIdentifier, reason }`. `userIdentifier` constrained (UPN or object-id shape, no quotes/backslashes as in `searchTermSchema`); `reason` length-bounded and required.
- `writeActionRequestSchema = { correlationId, tenantId, idempotencyKey, action }` — **`idempotencyKey` (= intent id) is new vs the read request**.
- `writeActionResultSchema` (typed union, no field-projection needed):
  - disable → `{ success: true, outcome: 'disabled', userId }`
  - reset → `{ success: true, outcome: 'password_reset', userId, temporaryPassword, forceChangeNextSignIn: true }`
  - failure → `{ success: false, errorCode, retryAfterSeconds? }`
- `writeActionFailureCodeSchema`: enum — `user_not_found`, `user_ambiguous`, `tenant_mismatch`, `graph_throttled`, `graph_error`, `invalid_action`, `budget_exceeded`.

### B. Executor sidecar — `apps/m365-graph-actions-executor/`

Structural copy of `apps/m365-graph-read-executor/`, with fully separate identity/keys/vault:

- **Env namespace** `M365_GRAPH_ACTIONS_EXECUTOR_*`: URL, signing public JWK + kid, issuer (`breeze-api`), audience (`m365-graph-actions-executor`), AKV vault URL + secret name `m365-customer-graph-actions` + pinned version, azure credential mode, app/client id, autostart flag.
- **Routes:** `GET /healthz`, `POST /v1/execute-action`.
- `src/internalAuth.ts` — copy of the read executor's EdDSA verifier: `algorithms:['EdDSA']`, `iss:'breeze-api'`, `aud:'m365-graph-actions-executor'`, `sub:'breeze-control-plane'`, required claims incl. `jti`; extra checks: kid match, ≤60s lifetime, not future/stale, `operation === 'execute-action'`, `correlationId` UUID, `bodySha256` timing-safe match over raw body.
- `src/credentials/azureKeyVaultProvider.ts` — pinned cert, secret name `m365-customer-graph-actions`, envelope `domain:'customer-graph-actions'`, `akv://…/m365-customer-graph-actions/<32-hex-version>` reference validation.
- `src/microsoft/`:
  - `tokenClient.ts` + `clientAssertion.ts` — app-only Graph token for the request `tenantId` via JWT client-assertion (same as read).
  - `graphClient.ts` — read executor's client **plus write methods**: `PATCH /users/{id}` `{ accountEnabled: false }`; `PATCH /users/{id}` `{ passwordProfile: { forceChangePasswordNextSignIn: true, password: <generated> } }`. Retains the `RequestBudget` shape and 429→`graph_throttled` mapping.
  - `writeActions.ts` — `executeGraphWriteAction(action, ctx)`: exhaustive `switch (action.type)`; resolves `userIdentifier`→object id via a bounded read (`user_not_found`/`user_ambiguous` on miss), then performs the mutation. Generates the temp password for reset (cryptographically random, policy-satisfying).
- `src/operations.ts` — `executeActionOperation`: validate `tenantId` + `idempotencyKey`, fetch cert from vault, mint token, run `executeGraphWriteAction`, **zero cert material in `finally`**, zod-validate result before returning.
- **Graph write budget** — tighter than read (e.g. `maxRequestCount` small, `maxItemCount` tiny; a mutation touches one user).
- `Dockerfile` (node:24-alpine, `USER node`, distinct `EXPOSE` port, `/healthz` healthcheck), `package.json` (`@breeze/shared`, `hono`, `jose`, `zod`, `@azure/identity`, `@azure/keyvault-secrets`), tsup/tsx/vitest config.

### C. Idempotency (stated decision, not hidden)

**No executor-side dedup store in the first cut.** At-most-once dispatch is provided by the worker's existing CAS claim (`approved → executing`, `intentReleaseWorker.ts:190`). `disable_user` is naturally idempotent (setting `accountEnabled:false` twice is a no-op). `reset_password` is **not** idempotent (a second reset invalidates the first temp password); the only double-execution window is a crash between Graph success and the `executing → completed` CAS. The fail-safe is the durable layer's **no-auto-replay policy**: an intent stuck in `executing` is surfaced for manual resolution, never automatically re-dispatched — matching the control-plane doc's "partial completion stops for explicit resolution; Breeze does not blindly roll back or replay." The `idempotencyKey` (intent id) is carried on every request for audit correlation and as the natural key for a future executor-side dedup store (follow-up).

### D. API-side — `apps/api/src/services/m365ControlPlane/`

- `graphActionsExecutorClient.ts` — mirrors `graphReadExecutorClient.ts`: serialize request once, sign EdDSA JWT (own private JWK file + kid, `aud:'m365-graph-actions-executor'`, `iat`, `exp=iat+60`, `jti`, `operation:'execute-action'`, `correlationId`, `bodySha256` over the exact serialized bytes), POST `/v1/execute-action`, bounded + zod-parsed response, `GraphActionsExecutorClientError('executor_unavailable')` on any non-ok/wrong-content-type/oversize.
- `writeActionService.ts` — authz ladder mirroring `readActionService.ts`, in order:
  1. **Site-scope check** — site-restricted sessions refused (`site_scope_denied`).
  2. **Org resolution** — for the request path; headless passes `intent.orgId` directly.
  3. **Feature flag** — `isM365GraphActionsEnabledForOrg(orgId)`; off → `tools_disabled`. **Disabled by default.**
  4. **Connection load under active RLS** — select `m365Connections` row for `(orgId, profile='customer-graph-actions')` via `withDbAccessContext(dbAccessContextFromAuth(auth), …)`. For headless, the worker already establishes this org-scoped context, so the SELECT runs under the intent actor's org RLS.
  5. **Readiness / authorize gate (fail-closed)** — `!conn → fail`; `conn.orgId !== orgId → fail` (defense-in-depth over RLS, mirrors `authorizeGoogleConnection`); status in executable set (`active`/`degraded`) and `tenantId` non-null else `connection_not_ready`.
  6. **Write budget** — `consumeM365WriteActionBudget(connectionId)`; fail-closed on Redis error.
  7. **Executor call** — `executor_unavailable` on client error.
  8. **Audit every outcome** — `m365.customer_graph_actions.action_executed`, `resourceType:'m365_connection'`, allowlisted `details` (`actionType`, `outcome`) — **never** the temp password or Graph payloads.
- `writeActionBudget.ts` — mirrors `readActionBudget.ts` with **tighter** per-connection Redis windows (e.g. per-minute and per-day mutation caps); fails closed on Redis unavailability.
- `writeActionMetrics.ts` — audit + Prometheus counter `breeze_m365_graph_actions_total{action,outcome}`.
- `isM365GraphActionsEnabledForOrg` — new feature flag helper, default off.

### E. Org-keyed headless seam — `apps/api/src/services/m365ToolsHeadless.ts`

The M365 mirror of `googleToolsHeadless.ts`:

- `M365_HEADLESS_ACTIONS` — map of the 2 Tier-3 tool names → their typed write-action id / builder: `m365_disable_user → m365.user.disable`, `m365_reset_password → m365.user.reset_password`. **This map is the headless allowlist.**
- `isHeadlessM365Tool(name)` — `hasOwnProperty` on the map.
- `executeM365ToolHeadless(actionName, args, orgId)` — builds the typed `m365WriteAction` from `{ userIdentifier, reason }`, calls `writeActionService` **keyed by `orgId`** (connection resolved under the worker's org-scoped RLS), and converts any readiness/authorization failure into a thrown `M365ConnectionUnavailableError(errorCode)` so the worker maps it to `connection_unavailable`. Returns the executor result (for reset, including `temporaryPassword`) as the intent result payload.
- `M365ConnectionUnavailableError` — new error type (mirror `GoogleConnectionUnavailableError`).
- **Parity contract test** — `m365ToolsHeadless.test.ts` asserts `keys(M365_HEADLESS_ACTIONS) === { name | m365ToolTiers[name] === 3 }`, so a new M365 Tier-3 tool cannot silently regress to `session_required`. Today that set is exactly `{ m365_disable_user, m365_reset_password }`.

**The inline chat path is untouched.** The existing session-aware handlers keep using `resolveContext` (direct/Delegant); `executeM365ToolHeadless` is reached **only** via the headless worker — an exact mirror of how Google left its inline path alone. Accepted consequence, made explicit: inline and headless are two backends for the same logical mutation (in-process direct/Delegant vs the isolated executor). **Effect-equivalence** (same Graph outcome) is a tested invariant; the executor's isolation/budget/audit controls apply to the headless path only for now (inline migration is control-plane stage 7).

### F. Worker wiring — `apps/api/src/jobs/intentReleaseWorker.ts` (the small piece)

Two edits mirroring Google exactly:
- `:255` guard → `if (!isHeadlessGoogleTool(name) && !isHeadlessM365Tool(name) && requiresLiveSession(name)) failIntent('session_required')`.
- `:265` invoke selector → add `isHeadlessM365Tool(name) ? () => executeM365ToolHeadless(name, args, intent.orgId) : …`.
- Error categorization `:279` → map `M365ConnectionUnavailableError` to `failIntent('connection_unavailable')` (no side effect), alongside the Google case.

Reuses unchanged: `revalidateApprovedIntentForRelease`, the `withToolTimeout(runOutsideDbContext(withDbAccessContext(dbAccessContextFromAuth(auth), invoke)))` wrapper, the CAS lifecycle, the 64 KiB result cap, and the success-CAS path that stores `result` (carrying `temporaryPassword` for reset).

May ship as a separate small PR after A–E land; included here so the integration test in §7 can exercise the full slice.

### G. Web — reveal temp password

The approvals/intents detail view reveals `result.temporaryPassword` **once** to the authorized requesting tech (RLS-protected result; exposure bounded because `forceChangePasswordNextSignIn` is set). Exact component located during planning. Must route through `runAction` per repo convention and never log the value.

---

## 5. Security contract (preserved — proven for Google, must hold for M365)

The executed org can never diverge from the approved/revalidated org:

1. `revalidateApprovedIntentForRelease(intent, winningApproval)` runs **first, unchanged** — digest bound, tier not escalated, actor rebuilt, org active, RBAC re-checked.
2. Connection resolved by the **immutable `intent.orgId`** under org-scoped RLS (never a session, never captured connection state).
3. **Org-match + active re-checked at execution** — `conn.orgId === orgId` (defense-in-depth over RLS) and status executable; fail-closed.
4. **Every branch fails closed** — readiness/authorize/budget/executor failures → `connection_unavailable` (no Graph call) or the appropriate `failIntent` code; `session_required` stays gated on `!isHeadlessM365Tool`.
5. **Executor credential isolation** — the actions executor is the sole holder of the `customer-graph-actions` cert; separate app identity, keypair/kid, audience, and vault secret from the read domain.
6. **Internal auth** — ≤60s EdDSA JWT bound to the request body hash, with `operation`/`correlationId` claims.
7. **Tighter Graph write budget** than read.
8. **Audit correlation chain** — MCP request → intent → approval → executor job → Microsoft request → result; no reusable secrets, never the temp password.

---

## 6. File plan

**New:**
- `packages/shared/src/m365/writeActions.ts` (+ test)
- `apps/m365-graph-actions-executor/` (full sidecar, mirrors read executor; + tests)
- `apps/api/src/services/m365ControlPlane/graphActionsExecutorClient.ts`
- `apps/api/src/services/m365ControlPlane/writeActionService.ts`
- `apps/api/src/services/m365ControlPlane/writeActionBudget.ts`
- `apps/api/src/services/m365ControlPlane/writeActionMetrics.ts`
- `apps/api/src/services/m365ToolsHeadless.ts` (+ parity test)
- `apps/api/src/jobs/intentReleaseWorkerM365Headless.integration.test.ts`

**Modified:**
- `packages/shared/src/m365/profiles.ts` — add `applicationPermissionAssignments` for the two first-cut permissions (optional; only needed once grant reconciliation is built — may defer).
- `apps/api/src/jobs/intentReleaseWorker.ts` — the two-edit wiring (component F).
- Web approvals/intents detail component — temp-password reveal (component G).
- Feature-flag registry — `isM365GraphActionsEnabledForOrg` (default off).
- Deployment/compose + `.env.example` — the new executor service and its `M365_GRAPH_ACTIONS_EXECUTOR_*` vars (generic placeholders only; no real infra values).

---

## 7. Testing

- **Executor unit** (mirror read executor): `writeActions` dispatch (each variant + `user_not_found`/`user_ambiguous`/`tenant_mismatch`), internal-auth verifier (kid/lifetime/body-hash/operation-claim), write budget caps, credential provider (pinned-ref validation + envelope), cert-zeroing in `finally`.
- **Shared** — `writeActions.ts` schema tests (`.strict()` rejection, discriminated union, identifier/reason constraints).
- **API** — `writeActionService` authz-ladder ordering (each rung short-circuits with the right code; audit emitted only from the connection-loaded rungs), `writeActionBudget` windows + fail-closed, `m365ToolsHeadless` parity contract test.
- **Integration** — `intentReleaseWorkerM365Headless.integration.test.ts` (real Postgres, Graph mocked at the client boundary): happy-path disable + reset (reset stores `temporaryPassword` in `intent.result`); revoked/inactive connection → `connection_unavailable` with no side effect; **wrong-org connection → fail-closed**; tenant-mismatch → fail-closed; the two tools no longer hit `session_required`; `revalidateApprovedIntentForRelease` runs before any dispatch.
- **Security** — assertions that executed org == `intent.orgId`, that a connection whose `orgId` differs from `intent.orgId` never executes, and that every failure branch makes no Graph call.

---

## 8. Sequencing within the phase

1. Shared write-action catalog (A) — unblocks both executor and API.
2. Executor sidecar (B) with its unit tests — the isolated piece; can be built/tested standalone against a mocked Graph.
3. API client + write service + budget + metrics + feature flag (D) — with authz-ladder tests.
4. Org-keyed headless seam (E) + parity test.
5. Worker wiring (F) + the integration test (§7) — completes the slice.
6. Web temp-password reveal (G).

Minimal connection provisioning (a seed helper creating a `(orgId, 'customer-graph-actions')` row bound to a test tenant) is added alongside step 5 so the integration test can run end-to-end.
