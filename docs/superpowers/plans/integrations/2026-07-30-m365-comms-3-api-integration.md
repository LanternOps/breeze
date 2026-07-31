# M365 Communications-Delegated — Plan 3: API Integration, Consent, Tools & Release

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the comms executor into the product: the API executor client, the user-axis action service, the `delegated_consent` phase with routes and UI, the four AI tools with MCP suppression, the approval projection that renders what will actually be sent, the Tier-3 send funnel (`releaseCommsSend`) with the durable-release worker branch, the end-to-end integration proof, and the deploy runbook + plumbing deferred from Plan 2.

**Architecture:** Everything API-side mirrors the read/actions siblings at the seams (executor client clone, service ladder, consent phase clone) and diverges on the axis: connections are **user-owned**, tools gate on `principal.kind === 'user_session'` + a user allowlist, and the Tier-3 send is released **only** by the durable worker through `releaseCommsSend(intentId)` — the inline chat path is structurally excluded (shipped guard, #2917). The send's two digests (`effectDigest` = the stored `argument_digest`; `planDigest` = a new immutable column stamped at creation) travel as signed JWT claims and are recomputed inside the executor.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM + Postgres (RLS), jose (EdDSA internal auth), Vitest, React (web UI), `@breeze/shared` (comms catalog, envelope, plan, digests, executor contracts).

## Global Constraints

- **Design spec:** `docs/superpowers/specs/integrations/2026-07-28-breeze-m365-communications-delegated-design.md`. This plan implements §14 tasks **12–18** (including 15b). Sections cited per task.
- **EXECUTION BASELINE — Plans 1 and 2 are merged as *documents* but their code is NOT on main as of 2026-07-30.** This plan's tasks consume their Produces blocks (`docs/superpowers/plans/integrations/2026-07-29-m365-comms-1-api-binding-config.md`, `…-comms-2-executor-service.md`). Before executing ANY task here, verify the prerequisites shipped:
  ```bash
  test -f apps/api/src/services/m365ControlPlane/commsRuntimeConfig.ts        # Plan 1 task 7
  grep -q 'binding' apps/api/src/services/actionIntents/intentService.ts      # Plan 1 task 6
  test -f packages/shared/src/m365/commsExecutorContracts.ts                  # Plan 2 task 8a
  test -d apps/m365-communications-executor                                   # Plan 2 tasks 8b-11
  ```
  If any check fails, stop — execute Plans 1/2 first. Where this plan cites a Plan 1/2 symbol, the Produces blocks in those documents are the authority; if the executed code diverged, reconcile against the code and note the delta in the PR.
- **The digests are claims, never body fields, never recomputed as release-path authority.** `effectDigest` is read from the stored `intent.argumentDigest`; `planDigest` from the new stored `action_intents.plan_digest`. Both are stamped at creation and carried as signed JWT claims (§5.2–§5.3). A value computed at release from the same envelope it authorizes is a self-consistency check that always passes — never write one.
- **One canonicalizer, one plan builder.** Import `buildCommsSendEffect`/`commsSendEffectSchema` from `@breeze/shared/m365`, `computeCommsEnvelopeDigest`/`computeCommsPlanDigest` from `@breeze/shared/m365/commsDigests` (subpath import — deliberately not in the barrel). Never reimplement, wrap, or shadow (§5.2, risk #4).
- **Validate, never transform.** The release path parses the stored envelope with `commsSendEffectSchema` and forwards it verbatim. No construction step may exist between digest stamping and the executor (§5.3(a)).
- **The send releases only through the durable worker.** `DURABLE_RELEASE_ONLY_TOOLS` (shipped empty, `services/actionIntents/durableRelease.ts:36`) gains `m365_send_mail`; `releaseCommsSend(intentId)` takes an intent id and nothing else (§0.a). The inline chat path already diverts members before the CAS (`aiAgentSdk.ts:748-759`).
- **Human identity, not org authority.** Every comms tool requires `principal.kind === 'user_session'` (§6's general rule) — at registration, at intent creation, and at release (reading the persisted `origin_principal_kind`). All four tools are suppressed from MCP `tools/list` AND denied in `tools/call` — absence from a listing is discoverability, not authorization; both halves are required and separately tested.
- **Redaction is stricter than the siblings.** Message bodies, subjects, and recipient lists must never appear in logs, audit `details`, error messages, thrown exceptions, approval/intent *summaries*, or metrics labels. Full content lives exactly once — in `intent.arguments` — and is served only by the RBAC-gated intent read (§5.4, §12 flag 3). Failure envelopes carry enum codes and the fixed one-sentence messages only.
- **User axis, N users from day one.** Allowlists are user-id lists (`isM365CommsToolsEnabledForUser` / `isM365CommsOnboardingEnabledForUser`, Plan 1). Nothing may hardcode a single user (§10). Site-restricted sessions are refused (mirrors `readActionService.ts:109-115`).
- **`m365_connections` user-owned rows have `org_id NULL`** — the org cascade/export contracts cannot see them; the behavioural RLS suite (task 5, shipped #2928) is the tenancy proof. Say so in the PR (§3.4).
- **New columns on org-cascade tables must be classified in `CORE_TENANT_EXPORT_POLICY`** (`services/tenantExportPolicyRegistry.ts`) in the same task that adds them. This plan adds two: `action_intents.plan_digest` (Task 16) and `m365_connections.delegated_user_upn` (Task 14). Both enforcing suites need a live DB — run them explicitly; they cannot fail in the Test API job.
- **Migrations:** idempotent, no inner BEGIN/COMMIT, never edit shipped files. ⚠️ **Naming is a correctness issue here, not style.** The tree already carries future-dated migrations up to `2026-08-06-f-…`, and `2026-08-06-e-action-intents-origin-principal.sql` RE-CREATES `action_intents_block_content_update()`. A comms migration named with today's date would sort before it, and a fresh-DB replay would clobber the plan-digest trigger version (the replay-clobbers-newer trap). This plan's three migrations are therefore named `2026-08-06-g-…`/`-h-`/`-i-` to sort after every shipped definition. **At execution time, run `ls apps/api/migrations | sort | tail` and bump the letters so they still sort last** — Plans 1/2's execution may have added files.
- **Consent sessions FK has NO `ON UPDATE CASCADE`** (Plan 1 correction 3, verified against a real DB): delete the attempt's `m365_user_consent_sessions` rows BEFORE rotating `consent_attempt_id`, in the same locked transaction — exactly as `connectionService.ts:392-397` / `:727-731` do via `deleteConsentSessionsForAttemptInTransaction`.
- **Tests needing a real DB** run against Postgres `:5433` via `vitest.integration.config.ts`. `pnpm test` does NOT run the separate-config contract suites. Co-located integration tests must be dual-listed (include in `vitest.integration.config.ts`, exclude in `vitest.config.ts`) — `intentReleaseWorkerM365Headless.integration.test.ts`'s header comment explains the failure modes.
- **Never commit** real tenant ids, client ids, secrets, or infra hostnames. Fixtures use the all-1s/2s/3s GUID style.

**Baseline:** branch off `main` after Plans 1 and 2 are *executed and merged* (verify block above). Tasks 0–7 context below; do not re-implement them.

---

## Already shipped / planned — do not re-plan

| Task | Where | What this plan consumes |
|---|---|---|
| 0 / 0a / 0b | #2915 / #2917 (shipped) | `auth.principal` 7-kind union; `DURABLE_RELEASE_ONLY_TOOLS` + `requiresDurableRelease` + the inline diversion at `aiAgentSdk.ts:748-759`; immutable `action_intents.origin_principal_kind` (written `intentService.ts:303`, read `actorContext.ts:53-62`) |
| 1–2 | #2921 / #2922 (shipped) | `@breeze/shared/canonicalize`; `commsActions.ts` (caps, folders, tiers, projection lists, 21 failure codes), `commsEffect.ts` (`buildCommsSendEffect`), `commsPlan.ts` (`buildSendPlan`), `commsDigests.ts` |
| 3 | #2924 (shipped) | `communications-delegated` profile **v2**, mail-only delegated scopes + `offline_access` |
| 4 | #2926 (shipped) | Migration `2026-08-06-f-…`: status-aware credential-location constraint, `m365_user_consent_sessions` (system-only RLS), `delegated_user_object_id` / `consent_generation` / `observed_delegated_scopes`, unique index `(id, user_id, profile, consent_attempt_id)` |
| 5 | #2928 (shipped) | `m365CommsUserRls.integration.test.ts` — the user-axis tenancy proof |
| 6–7 | Plan 1, #2934 (**plan only**) | `CreateActionIntentInput.binding?: { connectionId; tenantId }`; release-path digest recompute; `commsRuntimeConfig.ts` (`M365CommsRuntimeConfig`, `loadM365CommsRuntimeConfig`, `isM365CommsOnboardingEnabledForUser`, `isM365CommsToolsEnabledForUser`, `validateM365CommunicationsRuntimeConfigAtBoot`, `CALLBACK_PATH = '/api/v1/m365/comms-consent/callback'`), root `.env.example` comms block |
| 8a–8c, 9–11 | Plan 2, #2935 (**plan only**) | `commsExecutorContracts.ts` (request union: reads carry `action`, sends carry `envelope`; consent/retest/revoke contracts; result `usedCacheGeneration`/`rotated`); executor ops at `POST /v1/execute-action|complete-consent|retest|revoke-connection` on port 3005; JWT claims `effectDigest`/`planDigest`/`consentGeneration`; `commsCompleteConsentResultSchema` success = `{ tenantId, userObjectId, userPrincipalName, mail, grantedScopes, cacheGeneration, verifiedAt }` |

**Facts about shipped code this plan binds to** (verified 2026-07-30):

- The sibling executor-client shape to clone: `graphActionsExecutorClient.ts` — factory + interface, JWT `{operation, correlationId, bodySha256}` + `iss='breeze-api'`/`sub='breeze-control-plane'`/60s expiry/`jti`, `JSON.stringify(input)` as the sole serialization, bounded response reader, every failure collapsing to `executor_unavailable`, fetch injected via config.
- The ladder to clone: `writeActionService.ts` (`executeM365WriteActionByOrg`, `connectionNotReadyState` with the wrong-owner fail-closed check at :64-66, `FAILURE_MESSAGES` fixed-sentence map, Redis budget via `writeActionBudget.ts` failing closed, audit+metrics via `recordM365WriteActionEvent`); `readActionService.ts` for the site-scope refusal (:109-115) and `active|degraded` read statuses.
- Metrics precedent: counter `breeze_m365_graph_actions_total{action,outcome}` registered by `registerM365GraphActionsPrometheusCounter(registry)` installing a recorder; audit event `m365.customer_graph_actions.action_executed` with details allowlisted to `{actionType, outcome}`.
- Consent flow to clone: `connectionService.initiateConsent` (:380-461 — advisory lock `pg_advisory_xact_lock(hashtextextended(...))`, `FOR UPDATE`, sessions deleted before attempt rotation, CAS updates keyed on `(id, owner, profile, consentAttemptId, status)`), `consentSessionService.ts` (rawState 32B base64url stored as sha256 hex, nonce/verifier plaintext in a system-only table, 10-min TTL, single-use by DELETE…RETURNING), `browserBinding.ts` (closed phase union at :10, `validBinding` :39-56, per-profile factory instances with distinct cookie name/path/hmacContext), `m365ConsentCallback.ts` (`createM365ConsentCallbackRoutes` factory, public mount before authed routes, byte-match `expectedCallbackPath`, terminal redirect to a web hash route).
- Tools/release precedent: session-registered M365 tools in `aiAgentSdkTools.m365ToolDefinitions()` (:629, env-gated, `tool(...)` blocks); `m365ToolTiers` (`aiToolsM365.ts:46-52`, type currently `Record<string, 1 | 3>` — must widen); `TOOL_TIERS` + `BREEZE_MCP_TOOL_NAMES` (`aiAgentSdkTools.ts:96-245`); `getToolTier` fallback chain (`aiTools.ts:324-336`); central Tier-3 intent creation in `aiAgentSdk.ts:618-668` (there is NO per-tool intent call site); worker dispatch ternary (`intentReleaseWorker.ts:357-361`), CAS claim :251-257, failure taxonomy :368-385 + :413-434, completed CAS :456-476; MCP tier gates in `routes/mcpServer.ts` (`handleToolsList` :834-877 scope-filters but has NO name denylist; `handleToolsCall` :883+ resolves tiers through the same fallback chain, so an unregistered-but-tier-mapped name currently falls through to `executeTool` → "Unknown tool" — that is a bypass shape, not a control).
- Approvals precedent: routes `/mobile/approvals` (`approvals.ts`), detail serializer serving the **copy** `approval_requests.action_arguments` (:980-1003), decide digest check :500-525, decide RBAC = `canAccessOrg` + `userCanDecideApprovals` (`{resource:'approvals', action:'decide'}`); `routes/actionIntents.ts` exposes ONLY `/:id/reveal-secret` — **the RBAC-gated intent read the spec's §5.4 requires does not exist and Task 15b creates it**; web dialog `AiApprovalDialog.tsx` renders a collapsed `JSON.stringify` of filtered input (:427-436) with **no** hostile-text handling (the only sanitizer in the repo is API-side `aiInputSanitizer.ts`); immutability-trigger pattern to clone: `2026-07-18-action-intents.sql:95-125`.
- Deploy precedent: runbook `docs/deploy/m365-customer-graph-actions-executor.md` (secret-ownership matrix :114-123, egress allowlist :127-137, gotchas :139-147, dark launch :149-157, signals :162-168); compose maps the actions vars in the `api` service env block (`docker-compose.yml:222-235`) + Docker secret `m365_graph_actions_executor_signing_private_jwk`; hardening guard rejects executor compose service blocks (`check-supply-chain-hardening.sh:263,271-277`) and requires the runtime smoke `check-m365-graph-actions-runtime.sh`; `scripts/docs-review/mapping.json` maps SOURCE files to `apps/docs` pages (not to `docs/deploy` runbooks).
- Web i18n: locales are **7** (`en` + `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`) — the spec's "×5 locales" is stale. Parity is enforced by `localeParity.test.ts` (exact key match per locale) and `keyUsage.test.ts` (every literal `t()` key resolves in `en`).

## Decisions this plan makes (each resolves a recorded open item)

1. **`planDigest` is persisted as a new immutable `action_intents.plan_digest` column** (Task 16), stamped at creation from `computeCommsPlanDigest(envelope)`. Recomputing the claim at release would silently survive a `@breeze/shared` upgrade that changed `buildSendPlan` between approval and release — the spec requires exactly the opposite failure ("re-approve under the new shape", §5.3(a)) and says "persisted at creation" twice (§5.3(b)). Nullable; only comms intents write it; added to the immutability trigger and the export policy (`included`, beside `argument_digest`).
2. **The headless entry is `releaseCommsSend(intentId)` — intent id and nothing else** (§0.a). The spec's §8 sketch signature `executeM365CommsToolHeadless(actionName, args, orgId, userId, intentId)` is superseded by §0.a's structural rule: a function that accepts arguments can be invoked with attacker-shaped input; one that loads everything from the intent row cannot. The worker's comms branch closes over `intent.id` only.
3. **Promotion stamps `vault_ref = 'executor-owned:m365-comms-client-cert'` and `credential_version = String(cacheGeneration)`.** The credential-location constraint requires both non-null on active rows, but the API deliberately holds no comms vault config (Plan 1) and `commsCompleteConsentResultSchema` does not echo the executor's vault ref. The sentinel is a truthful *location statement* — the credential is the executor's configured `m365-comms-client-cert` secret — not a resolvable locator; nothing API-side may ever parse it as one. `credential_version` as the cache generation is spec text (§3.2 "What the API still tracks").
4. **The sender UPN is persisted as `m365_connections.delegated_user_upn`** (Task 14), written at promotion from the consent result and refreshed by retest. Both the connection card ("Signed in as <UPN>") and the approval projection (§5.4 point 2) need it server-side; no column exists and deriving it live would put a Graph call on the approval read path.
5. **Tool *registration* gates synchronously on allowlist + principal + site scope; connection ownership is enforced at execution.** The definitions builders are synchronous env-gated functions (the sibling pattern); checking "owns an active connection" at registration would put a DB query in every session build for every user. The refusal at call time carries the Connect-first message, which is better UX than a missing tool anyway. The security property (§3.4 — only the owning human can act) lives in the service ladder and the release checks, which run every time.
6. **MCP suppression rides a dependency-free human-identity tool set** (`services/actionIntents/humanIdentityTools.ts`, cloning `durableRelease.ts`'s shape): `HUMAN_IDENTITY_ONLY_TOOLS` + `requiresHumanIdentity(name)`, containing all four comms tools. `handleToolsCall` denies members before tier resolution; `BREEZE_MCP_TOOL_NAMES` filters them out; `tools/list` cannot serve them (they are session-registered, never in the `aiTools` map) but a test pins the absence anyway. This implements §6's general rule under its own name so the next human-identity tool family lands in one place.
7. **No body preview anywhere outside the intent read.** §5.4 point 2 explicitly drops §8 point 3's "first ~200 chars of body" from `impactSummary`. Summaries carry recipients, subject, counts, lengths, and the digest — never body text. `CreateActionIntentInput` gains an optional `summaries` override (Task 16) because the generic `buildTargetSummary` (`intentService.ts:139-146`) would embed truncated argument values — including the body — into `target_summary`.
8. **Drafts require `status = 'active'`; reads allow `'active' | 'degraded'`.** The spec pins send=active and reads=active|degraded (§14 task 13) and is silent on drafts; a draft is a mutation in the customer's mailbox, so it takes the mutation posture.
9. **The mobile/approval detail serves `intent.arguments` for intent-linked approvals** (Task 15b): `GET /mobile/approvals/:id` swaps the served `actionArguments` to the linked intent's trigger-protected copy. This closes §5.4 point 1 for every intent-backed approval on that surface, not just comms, at the cost of one indexed read.

## Task ordering & dependencies

1. **Task 12** — executor client (needs Plan 2's contracts only)
2. **Task 13** — comms action service + budget + metrics (needs 12)
3. **Task 14** — delegated consent phase + routes + UI + UPN column (needs 12, 13's degraded-writeback helpers)
4. **Task 15** — Tier-1/2 AI tools + MCP suppression (needs 13)
5. **Task 16** — Tier-3 send + `releaseCommsSend` + worker branch + `plan_digest` (needs 13, 15)
6. **Task 15b** — approval projection + intent read endpoint + immutability trigger (needs 16 for the send shape; independent trigger/endpoint parts could land earlier but ship here to test against real comms intents)
7. **Task 17** — integration proof (needs all of the above)
8. **Task 18** — deploy runbook + plumbing (docs/config only; last)

Strictly sequential; do not parallelize. One PR, commit per task (matches Plans 1–2). If it is ever split into stacked PRs: `ci.yml` triggers only on PRs based on `main` — dispatch CI per branch (`gh workflow run CI --ref <branch>`) before trusting `gh pr checks`.

---

### Task 12: API executor client — `commsExecutorClient.ts`

Spec §14 task 12, §5.2 item 3. Clone of `graphActionsExecutorClient.ts` against the comms schemas/audience, extended with the three signed send claims.

**Files:**
- Create: `apps/api/src/services/m365ControlPlane/commsExecutorClient.ts`
- Create: `apps/api/src/services/m365ControlPlane/commsExecutorClient.test.ts`

**Interfaces:**
- Consumes: `M365CommsRuntimeConfig` (Plan 1 — `executorUrl`, `executorAudience`, `executorSigningPrivateJwk`, `executorSigningKid`); all eight schemas from `@breeze/shared/m365` (`commsExecutorContracts` via the barrel): `m365CommsRequestSchema`/`m365CommsResultSchema`, `commsCompleteConsentRequestSchema`/`commsCompleteConsentResultSchema`, `commsRetestRequestSchema`/`commsRetestResultSchema`, `commsRevokeConnectionRequestSchema`/`commsRevokeConnectionResultSchema`.
- Produces (consumed by Tasks 13, 14, 16, 17):
  - `interface CommsSendClaims { effectDigest: string; planDigest: string; consentGeneration: number }`
  - `interface CommsExecutorClient { completeCommsConsent(input: CommsCompleteConsentRequest): Promise<CommsCompleteConsentResult>; retestCommsConnection(input: CommsRetestRequest): Promise<CommsRetestResult>; revokeCommsConnection(input: CommsRevokeConnectionRequest): Promise<CommsRevokeConnectionResult>; executeCommsAction(input: M365CommsRequest, sendClaims?: CommsSendClaims): Promise<M365CommsResult> }`
  - `createCommsExecutorClient(config: CommsExecutorClientConfig): CommsExecutorClient` — **this factory is the seam every test in Tasks 13/16/17 mocks**
  - `class CommsExecutorClientError extends Error { readonly code: 'executor_unavailable' }`

- [ ] **Step 1: Write the failing tests**

Copy `graphActionsExecutorClient.test.ts` as the starting harness (fetch injected via config, real jose keypair, `jwtVerify` against issuer/audience/kid) and adapt. New comms-specific cases beyond the renames:

```ts
it('signs effectDigest, planDigest, and consentGeneration as claims on a send', async () => {
  const claims = { effectDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64), consentGeneration: 3 };
  await client.executeCommsAction(sendRequest(), claims);
  const token = capturedAuthorizationHeader().replace('Bearer ', '');
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: 'breeze-api', audience: 'm365-communications-executor',
  });
  expect(payload.operation).toBe('execute-action');
  expect(payload.effectDigest).toBe(claims.effectDigest);
  expect(payload.planDigest).toBe(claims.planDigest);
  expect(payload.consentGeneration).toBe(3);
});

it('omits the digest claims on a read', async () => {
  await client.executeCommsAction(readRequest());
  const { payload } = await verifyCaptured();
  expect(payload.effectDigest).toBeUndefined();
  expect(payload.planDigest).toBeUndefined();
  expect(payload.consentGeneration).toBeUndefined();
});

it('REFUSES locally to send an envelope request without claims', async () => {
  // A send whose digests are not signed is a self-authorizing request — the
  // executor would have nothing to verify against. Fail before any network.
  await expect(client.executeCommsAction(sendRequest())).rejects.toThrow('executor_unavailable');
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('refuses claims on a read request', async () => {
  await expect(client.executeCommsAction(readRequest(), {
    effectDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64), consentGeneration: 1,
  })).rejects.toThrow('executor_unavailable');
  expect(fetchImpl).not.toHaveBeenCalled();
});
```

Where `sendRequest()` builds a valid `{ ...base, envelope: buildCommsSendEffect(...) }` and `readRequest()` a `{ ...base, action: { type: 'm365.comms.mail.list', folder: 'inbox' } }`, using the all-1s/2s/3s GUID fixtures. Keep the sibling's ported cases: JWT shape (`iss`/`sub`/`jti`/60s), `bodySha256` = sha256(base64url) of the exact serialized body, non-200 → `executor_unavailable`, oversized body abort, zod-invalid response → `executor_unavailable`, provider detail never in the thrown message.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter=@breeze/api exec vitest run src/services/m365ControlPlane/commsExecutorClient.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement — clone with exactly these deltas**

Copy `graphActionsExecutorClient.ts`; do not re-derive the URL-guarding/bounded-read/signing code. Deltas:

1. Rename types/factory per the Produces block; `executorAudience` literal type `'m365-communications-executor'`.
2. Operations and paths:
   ```ts
   type CommsExecutorOperation = 'execute-action' | 'complete-consent' | 'retest' | 'revoke-connection';
   const OPERATION_ENDPOINT_PATHS: Record<CommsExecutorOperation, string> = {
     'execute-action': '/v1/execute-action',
     'complete-consent': '/v1/complete-consent',
     'retest': '/v1/retest',
     'revoke-connection': '/v1/revoke-connection',
   };
   ```
3. `executeCommsAction(input, sendClaims?)` — before schema-parsing the request:
   ```ts
   const isEnvelopeRequest = typeof input === 'object' && input !== null && 'envelope' in input;
   if (isEnvelopeRequest !== (sendClaims !== undefined)) return Promise.reject(unavailable());
   ```
   and spread the claims into the JWT payload beside `operation`/`correlationId`/`bodySha256`:
   ```ts
   const token = await new SignJWT({
     operation, correlationId: input.correlationId, bodySha256,
     ...(sendClaims ?? {}),
   })
   ```
4. `DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024` (a `mail.get` body alone is up to 64 KiB).
5. Each method parses its request with the matching schema and its response with the matching result schema, exactly like the sibling's `invoke(...)`/`parseResponse` shape.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter=@breeze/api exec vitest run src/services/m365ControlPlane/commsExecutorClient.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/m365ControlPlane/commsExecutorClient.ts \
        apps/api/src/services/m365ControlPlane/commsExecutorClient.test.ts
git commit -m "feat(m365): comms executor client with signed digest claims

Task 12 of the M365 communications-delegated executor (design §5.2).

Clone of graphActionsExecutorClient.ts against the comms contracts and the
m365-communications-executor audience. The one structural addition: a send
(envelope-carrying) request signs effectDigest, planDigest, and
consentGeneration as JWT claims — values the caller reads from the STORED
intent, never recomputes — and the client refuses locally to transmit an
envelope without them, or claims without an envelope. The executor treats the
claims as the sole digest authority (Plan 2 task 8b/11)."
```

---

### Task 13: Comms action service — the user-axis ladder

Spec §14 task 13, §3.4 ("Who may act"), §9. The comms analogue of `writeActionService.ts`/`readActionService.ts`, swapped to the user axis.

**Files:**
- Create: `apps/api/src/services/m365ControlPlane/commsActionService.ts`
- Create: `apps/api/src/services/m365ControlPlane/commsActionService.test.ts`
- Create: `apps/api/src/services/m365ControlPlane/commsActionBudget.ts` + `commsActionBudget.test.ts`
- Create: `apps/api/src/services/m365ControlPlane/commsActionMetrics.ts` + `commsActionMetrics.test.ts`

**Interfaces:**
- Consumes: `createCommsExecutorClient` (Task 12); `loadM365CommsRuntimeConfig`, `isM365CommsToolsEnabledForUser` (Plan 1); `m365CommsInlineActionSchema`, `M365CommsFailureCode` (`@breeze/shared/m365`); `dbAccessContextFromAuth` (`middleware/auth.ts:409`), `withDbAccessContext`/`withSystemDbAccessContext` (`db/index.ts`); `m365Connections` schema.
- Produces (consumed by Tasks 14, 15, 16, 17):
  - `type M365CommsRefusalCode = 'tools_disabled' | 'user_actor_required' | 'site_scope_denied' | 'connection_not_ready' | 'comms_rate_limited' | 'executor_unavailable'`
  - `type M365CommsServiceResult = { ok: true; result: M365CommsResult } | { ok: false; code: M365CommsRefusalCode | M365CommsFailureCode; message: string; retryAfterSeconds?: number }`
  - `executeM365CommsInlineAction(auth: AuthContext, action: M365CommsInlineAction, auditRequest?: RequestLike): Promise<M365CommsServiceResult>` — Tier-1/2 path (list/get/draft), caller-RLS connection load
  - `loadOwnCommsConnection(userId: string): Promise<M365ConnectionRow | undefined>` — system-context load by `(userId, profile='communications-delegated')`; used by the release path and consent flows where no live session exists
  - `commsConnectionNotReadyState(connection: M365ConnectionRow | undefined, userId: string, executableStatuses: readonly string[]): 'missing' | 'wrong-user' | 'status' | null` — the fail-closed owner check (`connection.userId !== userId` ⇒ `'wrong-user'`, mirroring `writeActionService.ts:64-66`)
  - `applyCommsSuccessWriteback(connectionId: string, usedCacheGeneration: number | undefined): Promise<void>` — stamps `credential_version = String(usedCacheGeneration)` when present, `last_verified_at = now()`, `expires_at = now() + 90 days` (§3.3 sliding expiry)
  - `markCommsConnectionDegraded(connectionId: string, code: string): Promise<void>` — `status='degraded'`, `last_error_code`
  - `COMMS_FAILURE_MESSAGES: Record<M365CommsFailureCode, string>` — fixed one-sentence map
  - `consumeM365CommsActionBudget(connectionId: string, kind: 'read' | 'mutation'): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }>`
  - `recordM365CommsActionEvent(request: RequestLike | undefined, input: { actionType: string; outcome: string; connectionId: string; orgId: string | null; actorId?: string })` + `registerM365CommsPrometheusCounter(registry): Counter<'action' | 'outcome'>` (counter name `breeze_m365_comms_total`)

- [ ] **Step 1: Budget — write failing tests, then clone**

`commsActionBudget.ts` clones `writeActionBudget.ts` (Redis `multi().incr().expire()`, fail closed on any Redis error) with two windows per kind:

```ts
export const M365_COMMS_READS_PER_MINUTE = 30;
export const M365_COMMS_READS_PER_DAY = 500;
export const M365_COMMS_MUTATIONS_PER_MINUTE = 10;   // sibling write numbers
export const M365_COMMS_MUTATIONS_PER_DAY = 100;
```

Key prefix `m365:comms:<kind>:<connectionId>:<window>`. Tests: clone the sibling budget suite (limit hit → `{ok:false, retryAfterSeconds}`, Redis error → fail closed, per-kind isolation).

- [ ] **Step 2: Metrics — clone the recorder pattern**

`commsActionMetrics.ts` clones `writeActionMetrics.ts`: counter `breeze_m365_comms_total`, labels `['action','outcome']`, `setM365CommsMetricsRecorder` indirection, audit event `action: 'm365.comms.action_executed'` with details **allowlisted to `{ actionType, outcome }`** — a test asserts the details object never carries more keys (the redaction constraint made mechanical). Register the counter at boot beside the actions call — grep `registerM365GraphActionsPrometheusCounter` for the call site and add the comms registration next to it.

- [ ] **Step 3: Service — write the failing tests**

Mock only `./commsExecutorClient` (`vi.mock` of `createCommsExecutorClient` returning a `vi.fn()`-backed client — the same seam the worker integration suite uses) plus the Drizzle select in the file's existing mock style (read `writeActionService.test.ts` first and mirror its harness). Cases:

```ts
describe('executeM365CommsInlineAction', () => {
  it('refuses a non-user_session principal with user_actor_required', async () => {
    const result = await executeM365CommsInlineAction(apiKeyAuth(), listAction());
    expect(result).toMatchObject({ ok: false, code: 'user_actor_required' });
  });
  it('refuses a site-restricted session', async () => {
    const result = await executeM365CommsInlineAction(siteRestrictedAuth(), listAction());
    expect(result).toMatchObject({ ok: false, code: 'site_scope_denied' });
  });
  it('refuses a user outside the tools allowlist with tools_disabled', ...);
  it('refuses when no connection exists with connection_not_ready and a connect-first message', ...);
  it("refuses another user's connection as connection_not_ready, never revealing it exists", ...);
  it('allows reads on a degraded connection but refuses drafts', async () => {
    // reads: active|degraded; drafts (mutations): active only — decision 8
  });
  it('maps delegated_reauth_required to a refusal AND marks the connection degraded', ...);
  it('writes back usedCacheGeneration and slides expires_at on success', ...);
  it('consumes the read budget for list/get and the mutation budget for draft', ...);
  it('never includes subject/recipients/body in any failure message or audit details', async () => {
    // Drive a Graph failure with a draft carrying a canary subject/body; assert
    // the canary appears in NO message, NO audit call argument, NO thrown error.
  });
});
```

- [ ] **Step 4: Implement the ladder**

Order, each rung returning the typed refusal (fixed sentences, one per code — write the map in full):

```ts
export const COMMS_REFUSAL_MESSAGES: Record<M365CommsRefusalCode, string> = {
  tools_disabled: 'Microsoft 365 communications tools are not enabled for this user.',
  user_actor_required: 'Microsoft 365 communications tools require an interactive user session.',
  site_scope_denied: 'Microsoft 365 communications tools are not available to site-restricted sessions.',
  connection_not_ready: 'Connect Microsoft 365 communications for this user before using mail tools.',
  comms_rate_limited: 'Microsoft 365 communications actions are rate limited for this mailbox. Try again shortly.',
  executor_unavailable: 'The Microsoft 365 communications service is unavailable.',
};
```

1. `auth.principal.kind === 'user_session'` else `user_actor_required` (§6 — checked here even though registration also gates: three different trust moments).
2. `auth.allowedSiteIds` set ⇒ `site_scope_denied` (clone `readActionService.ts:109-115`).
3. `isM365CommsToolsEnabledForUser(auth.user.id)` else `tools_disabled` (env-only, no DB).
4. Connection under the **caller's own RLS**: `withDbAccessContext(dbAccessContextFromAuth(auth), () => db.select().from(m365Connections).where(and(eq(userId, auth.user.id), eq(profile, 'communications-delegated'))).limit(1))` — the user-axis policy branch does the isolation; `commsConnectionNotReadyState` re-checks `connection.userId === auth.user.id` fail-closed anyway.
5. Status: `['active','degraded']` for `mail.list`/`mail.get`; `['active']` for `mail.draft.create` (decision 8).
6. Budget by kind (`draft.create` ⇒ `'mutation'`).
7. `createCommsExecutorClient(clientConfigFrom(loadM365CommsRuntimeConfig()))` → `executeCommsAction({ correlationId: randomUUID(), connectionId, tenantId: connection.tenantId, expectedUserObjectId: connection.delegatedUserObjectId, consentGeneration: connection.consentGeneration, action })` — no claims (read path).
8. Failure mapping: `COMMS_FAILURE_MESSAGES[result.errorCode]` (write the full 21-code map with fixed sentences, cloning the sibling's tone — `delegated_reauth_required: 'The Microsoft 365 sign-in for this mailbox has expired. Reconnect Microsoft 365 communications.'` etc.); `delegated_reauth_required` additionally calls `markCommsConnectionDegraded`.
9. Success: `applyCommsSuccessWriteback(connection.id, result.usedCacheGeneration)`; audit+metric every outcome from rung 4 onward (`orgId: resolveWritableToolOrgId(auth).orgId ?? null` — audit anchoring only, never an access gate on this user-owned path).

- [ ] **Step 5: Run the suites, typecheck, commit**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/m365ControlPlane/commsActionService.test.ts \
  src/services/m365ControlPlane/commsActionBudget.test.ts src/services/m365ControlPlane/commsActionMetrics.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/src/services/m365ControlPlane/commsAction*.ts
git commit -m "feat(m365): comms action service — user-axis ladder, budget, metrics

Task 13 of the M365 communications-delegated executor (design §3.4, §9, §14).

The ladder is the write/read sibling swapped to the user axis: principal kind
(user_session, checked at every trust moment) → site-scope refusal → per-USER
allowlist → connection under the caller's own RLS → fail-closed owner check →
status (reads active|degraded, mutations active-only) → Redis budget (fail
closed) → executor call → fixed-sentence failure mapping. delegated_reauth_
required degrades the connection; success writes back the cache generation and
slides the 90-day expiry. Audit details are allowlisted to {actionType,
outcome} — correspondence content never reaches audit, logs, or metrics."
```

---

### Task 14: Delegated consent phase — sessions, routes, promotion, UI card

Spec §4.1–§4.2, §14 task 14. A third consent phase beside `admin_consent`/`identity_verification`, on the user axis, against `/common`, with verify-then-persist delegated to the executor's ephemeral-cache redemption (Plan 2 task 11) and the atomic promotion + supersede-cleanup ordering from §4.1.

**Files:**
- Create: `apps/api/migrations/2026-08-06-g-m365-comms-delegated-upn.sql`
- Modify: `apps/api/src/db/schema/m365.ts` — add `delegatedUserUpn` to `m365Connections`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` — classify the new column
- Modify: `apps/api/src/services/m365ControlPlane/browserBinding.ts` — third phase + third instance
- Modify: `apps/api/src/services/m365ControlPlane/browserBinding.test.ts` — per-phase cases
- Create: `apps/api/src/services/m365ControlPlane/commsConsentSessionService.ts` + test — user-axis sessions over `m365_user_consent_sessions`
- Create: `apps/api/src/services/m365ControlPlane/commsConsentService.ts` + test — initiate/callback/promote/retest/disconnect
- Create: `apps/api/src/routes/m365CommsConsent.ts` + test — authenticated routes
- Create: `apps/api/src/routes/m365CommsConsentCallback.ts` + test — public callback
- Modify: `apps/api/src/index.ts` — mount both (callback BEFORE the authenticated m365 group, beside the existing callback mounts at :982-989)
- Create: `apps/web/src/components/integrations/M365CommunicationsDelegatedCard.tsx`
- Modify: `apps/web/src/components/integrations/IntegrationsPage.tsx` — card slot + `m365/communications-delegated/<result>` hash prefix
- Modify: `apps/web/src/locales/<locale>/integrations.json` ×7 (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`) — `m365CommunicationsDelegated.*` key tree

**Interfaces:**
- Consumes: `createCommsExecutorClient`, `CommsCompleteConsentResult` (Task 12); `loadM365CommsRuntimeConfig` (`callbackUrl`, `clientId`), `isM365CommsOnboardingEnabledForUser` (Plan 1); `getM365PermissionProfile('communications-delegated').delegatedPermissions`; `m365UserConsentSessions` schema (shipped); `markCommsConnectionDegraded` (Task 13).
- Produces (consumed by Task 17 and the web UI):
  - `initiateDelegatedConsent(auth: AuthContext): Promise<{ authorizeUrl: string; bindingCookie: string }>`
  - `handleDelegatedConsentCallback(input: { rawQuery: Record<string, string | undefined>; bindingCookieValue: string | null }): Promise<{ outcome: DelegatedConsentOutcome; clearCookie: string }>` where `type DelegatedConsentOutcome = 'connected' | 'consent_denied' | 'state_invalid' | 'consent_superseded' | 'tenant_mismatch' | 'verification_failed'`
  - `retestDelegatedConnection(auth: AuthContext, connectionId: string)`, `disconnectDelegatedConnection(auth: AuthContext, connectionId: string)`
  - `getOwnDelegatedConnection(auth: AuthContext): Promise<{ enabled: boolean; connection: SerializedCommsConnection | null }>` — `SerializedCommsConnection = { id, status, tenantId, delegatedUserUpn, observedDelegatedScopes, consentGeneration, lastVerifiedAt, expiresAt, lastErrorCode }`
  - Routes: `POST /api/v1/m365/connections/communications-delegated/consent`, `GET …/self`, `POST …/:id/retest`, `POST …/:id/disconnect`; public `GET /api/v1/m365/comms-consent/callback`

- [ ] **Step 1: Migration — the UPN column**

`apps/api/migrations/2026-08-06-g-m365-comms-delegated-upn.sql`:

```sql
-- Sender identity for display: the approval projection ("Signed in as <UPN>",
-- design §5.4) and the connection card need it server-side; deriving it live
-- would put a Graph call on the approval read path. Written at promotion from
-- the consent result, refreshed by retest. Never used for authorization —
-- tid/oid pinning does that.
ALTER TABLE m365_connections ADD COLUMN IF NOT EXISTS delegated_user_upn VARCHAR(320);
```

Schema: add to `m365Connections` beside `delegatedUserObjectId` (m365.ts:56):

```ts
delegatedUserUpn: varchar('delegated_user_upn', { length: 320 }),
```

Export policy: `m365_connections` is org-cascade-registered, so its entry in `CORE_TENANT_EXPORT_POLICY` enumerates every column — add `delegated_user_upn` to the `included` group (a display identifier; no `SUSPICIOUS_NAME_PARTS` match). Run `pnpm db:migrate && pnpm db:check-drift`.

- [ ] **Step 2: Browser binding — third phase, third instance**

In `browserBinding.ts`:

1. `export type M365ConsentBindingPhase = 'admin_consent' | 'identity_verification' | 'delegated_consent';`
2. `validBinding`: accept the new literal; its rule is `tenantHint === null` **always** — Breeze sends no hint into `/common` on first consent *or* reconnect; the reconnect tenant expectation is enforced at completion from the connection row (`expectedTenantId`), not from the cookie. (`identity_verification` keeps its required-GUID rule; the change is additive.)
3. Third instance, cloning the shape at :191-238:
   ```ts
   const COMMS_BINDING_CONFIG: M365ConsentBindingConfig = {
     cookieName: 'breeze_m365_comms_consent',
     cookiePath: '/api/v1/m365/comms-consent/callback',   // byte-matches Plan 1's CALLBACK_PATH
     hmacContext: 'breeze:m365-communications-delegated:browser-binding:v1',
   };
   ```
   Export its four bound helpers with `Comms`-suffixed names, mirroring the actions exports.

Tests (`browserBinding.test.ts`, per-phase — this is a security-critical validator, §4.2's ⚠️): a `delegated_consent` binding with `tenantHint: null` verifies; with a GUID tenantHint is **rejected**; cross-instance cookies fail (comms cookie rejected by the read/actions verifiers and vice versa — distinct `hmacContext` proves it); existing phases unchanged.

- [ ] **Step 3: User-axis consent sessions**

`commsConsentSessionService.ts` clones `consentSessionService.ts` onto `m365_user_consent_sessions` (columns: `stateHash, phase='delegated_consent', connectionId, userId, profile='communications-delegated', consentAttemptId, nonce, codeVerifier, expiresAt` — all NOT NULL; no tenantHintHash, deliberately):

```ts
export function prepareDelegatedConsentSession(): PreparedDelegatedConsentSession;
// rawState 32B base64url; stateHash = sha256Hex(rawState); nonce; codeVerifier
// 32B base64url; codeChallenge = sha256(codeVerifier) base64url; 10-min TTL —
// all cloned from prepareIdentityVerificationSession
export function insertDelegatedConsentSessionInTransaction(owner: { connectionId; userId; consentAttemptId }, prepared): Promise<...>;
export function consumeDelegatedConsentSessionInTransaction(input: { rawState: string }): Promise<M365UserConsentSessionRow | null>;
// DELETE … WHERE state_hash = sha256(rawState) AND phase='delegated_consent' AND expires_at > now() RETURNING — single-use
export function deleteDelegatedConsentSessionsForAttemptInTransaction(input: { connectionId; consentAttemptId }): Promise<void>;
```

Tests: single-use consumption (second consume returns null), expiry refusal, collision-retry on `stateHash` (clone the sibling's `onConflictDoNothing` loop), delete-by-attempt.

- [ ] **Step 4: Consent service — initiate**

`commsConsentService.ts`. `initiateDelegatedConsent(auth)`:

1. Gates: `auth.principal.kind === 'user_session'` else refuse; `isM365CommsOnboardingEnabledForUser(auth.user.id)` else refuse; site-restricted refused.
2. `runOutsideDbContext(() => withSystemDbAccessContext(async () => { … }))` (the connectionService pattern), inside one transaction:
   - `pg_advisory_xact_lock(hashtextextended('user:' || auth.user.id || '/communications-delegated', 0))` — user-axis key, distinct from the org-axis format.
   - `SELECT … FOR UPDATE` the row by `(user_id, profile)`.
   - If a row exists: `deleteDelegatedConsentSessionsForAttemptInTransaction` **first** (the FK blocks attempt rotation otherwise — Plan 1 correction 3), then CAS-update rotating `consentAttemptId` (fresh UUID), `clientId` from config. **Do not demote `status`** — a reconnecting `active`/`degraded` row keeps working credentials until the new consent completes; the credential-location constraint's first branch (`vault_ref`/`credential_version` non-null) holds regardless of status.
   - Else insert: `{ userId: auth.user.id, orgId: null, profile: 'communications-delegated', authMode: 'delegated', status: 'pending-consent', clientId: config.clientId, consentAttemptId: randomUUID() }` — legal since the shipped constraint relaxation.
   - `insertDelegatedConsentSessionInTransaction(...)`.
3. Build the authorize URL — `/common`, auth-code + PKCE, `prompt=select_account`, **no tenant hint** (§4.2 step 1):
   ```ts
   const authorizeUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' +
     new URLSearchParams({
       client_id: config.clientId,
       response_type: 'code',
       response_mode: 'query',
       redirect_uri: config.callbackUrl,          // byte-match trap: origin + CALLBACK_PATH
       scope: getM365PermissionProfile('communications-delegated').delegatedPermissions.join(' '),
       state: prepared.rawState,
       nonce: prepared.nonce,
       code_challenge: prepared.codeChallenge,
       code_challenge_method: 'S256',
       prompt: 'select_account',
     }).toString();
   ```
4. Return the URL + `buildCommsConsentBindingCookie({ connectionId, consentAttemptId, rawState, tenantHint: null, phase: 'delegated_consent' })`.

- [ ] **Step 5: Consent service — callback, completion, promotion**

`handleDelegatedConsentCallback` (clone the `m365ConsentCallback.ts` flow shape, single-phase):

1. Verify the binding cookie (comms instance); parse the query strictly (`code`+`state` on success; `error`/`error_description` from Microsoft ⇒ `consent_denied` — description is discarded, never logged verbatim); constant-time state compare against the cookie's `rawState`.
2. In a system transaction: `consumeDelegatedConsentSessionInTransaction({ rawState })` — null ⇒ `state_invalid`. CAS the row `(id = session.connectionId, consent_attempt_id = session.consentAttemptId)` to `status = 'verifying'`.
3. Load the row; `expectedTenantId = row.tenantId ?? null` (null on first consent; on reconnect the pinned tenant — a different returned `tid` is refused executor-side with `tenant_mismatch` BEFORE anything persists, §4.2 step 4).
4. Call the executor (this is where verify-then-persist actually lives — Plan 2 task 11 redeems under an ephemeral cache, validates the ID token/nonce, probes `GET /me`, reconciles scopes, and only then writes the cache row):
   ```ts
   const result = await createCommsExecutorClient(cfg).completeCommsConsent({
     correlationId: randomUUID(),
     connectionId: session.connectionId,
     consentAttemptId: session.consentAttemptId,
     claimedConsentGeneration: row.consentGeneration + 1,   // the generation this attempt will claim (§4.1 ordering step 1)
     authorizationCode: code,
     codeVerifier: session.codeVerifier,
     nonce: session.nonce,
     redirectUri: cfg.callbackUrl,
     expectedTenantId,
   });
   ```
5. On failure: map `tenant_mismatch` ⇒ outcome `tenant_mismatch`; everything else ⇒ `verification_failed`. Status disposition: a first-consent row (never active: `delegated_user_upn IS NULL`) returns to `'pending-consent'` + `last_error_code`; a reconnect of a previously-active row goes to `'degraded'` + `last_error_code` — conservative, because after a failed executor call the cache state is unknowable from here.
6. On success — **the atomic promotion, one UPDATE, CAS'd on attempt + status** (§4.1 verbatim, plus the two columns this plan owns):
   ```sql
   UPDATE m365_connections
      SET status = 'active',
          vault_ref = 'executor-owned:m365-comms-client-cert',        -- decision 3
          credential_version = $2,                                    -- String(result.cacheGeneration)
          tenant_id = $3, delegated_user_object_id = $4,
          delegated_user_upn = $5,
          consent_generation = consent_generation + 1,
          observed_delegated_scopes = $6,
          last_verified_at = now(), expires_at = now() + interval '90 days',
          last_error_code = NULL
    WHERE id = $1 AND status = 'verifying' AND consent_attempt_id = $7;
   ```
   Zero rows updated ⇒ superseded ⇒ **tombstone the cache row this attempt just wrote** (§4.1 step 3): `revokeCommsConnection({ correlationId, connectionId, consentAttemptId: session.consentAttemptId })` — the attempt-conditioned revoke exists for exactly this — then outcome `consent_superseded`. `tenantId` is lowercased before the UPDATE (`m365_connections.tenant_id` carries a lowercase-GUID CHECK).
7. Return the outcome + clear-cookie header.

Tests (mock the executor-client factory + Drizzle): denial passthrough; state single-use; supersede path calls the attempt-conditioned revoke and reports `consent_superseded`; success stamps UPN/generation/scopes/sentinel vault_ref and CASes `verifying → active`; reconnect passes the pinned `expectedTenantId`; first-consent failure returns the row to `pending-consent` while reconnect failure degrades; **no test asserts on Microsoft error text — it must never be persisted or logged**.

- [ ] **Step 6: Retest + disconnect (delegated-specific lifecycle, §4.1 invariants)**

- `retestDelegatedConnection`: owner-checked load (caller RLS), then `retestCommsConnection({ correlationId, connectionId, tenantId, expectedUserObjectId: delegatedUserObjectId, consentGeneration })`; success ⇒ `applyCommsSuccessWriteback` + `delegated_user_upn = result.userPrincipalName` + status `degraded → active` when applicable; `delegated_reauth_required` ⇒ `markCommsConnectionDegraded`.
- `disconnectDelegatedConnection` — **do NOT reuse `disconnectConnection`** (`connectionService.ts:715-758` sets `'revoked'`, which a never-promoted delegated row cannot legally hold, and nulls `tenantId`, violating nothing but recording less than we want):
  - Locked transaction (`FOR UPDATE`), sessions deleted first.
  - Never-promoted row (`status IN ('pending-consent','verifying')` and `vault_ref IS NULL`): **DELETE the row** (§4.1 invariant 1 — no credential to retain, no audit value in a shell).
  - Promoted row: call `revokeCommsConnection({ correlationId, connectionId, consentAttemptId: null })` (unconditional tombstone — a real code path, not a runbook step, §3.3), then `status = 'revoked'`, `revoked_at = now()`, rotate `consentAttemptId`; keep `vault_ref`/`credential_version`/`tenant_id`/`delegated_user_upn` (the identity check only constrains `active`; the record is the audit trail). Executor unreachable ⇒ **fail the disconnect** (surface the error; a revoke that didn't tombstone is not a revoke).

- [ ] **Step 7: Routes**

`m365CommsConsent.ts` (authenticated, mounted under `/m365`):

| Route | Gates | Behaviour |
|---|---|---|
| `POST /connections/communications-delegated/consent` | `authMiddleware`, `requireMfa()`, service-side principal+allowlist gates | `initiateDelegatedConsent` → set binding cookie → `{ authorizeUrl }` |
| `GET /connections/communications-delegated/self` | `authMiddleware` | `{ enabled: isM365CommsOnboardingEnabledForUser(auth.user.id) && principal is user_session, connection }` — connection loaded under caller RLS; the card hides itself when `enabled` is false |
| `POST /connections/communications-delegated/:id/retest` | `authMiddleware`, `requireMfa()` | owner-checked retest |
| `POST /connections/communications-delegated/:id/disconnect` | `authMiddleware`, `requireMfa()` | owner-checked disconnect |

No `requireOrgsWrite` — the resource is the caller's own mailbox connection; the allowlist + `user_session` + MFA are the gates (org-write permission is about customer orgs, which this row does not belong to).

`m365CommsConsentCallback.ts` (public): `GET /comms-consent/callback` → `handleDelegatedConsentCallback` → redirect to `${redirectBase}#m365/communications-delegated/<outcome>` (the `terminalRedirect` shape from `m365ConsentCallback.ts:431-434`). Mount both in `index.ts` beside the existing pattern — callback before the authenticated group:

```ts
api.route('/m365', m365CommsConsentCallbackRoutes);
api.route('/m365', m365CommsConsentRoutes);
```

Route tests: initiate refuses non-allowlisted / api-key principals / missing MFA; callback route is reachable unauthenticated, passes raw query + cookie through, redirects per outcome, and always clears the binding cookie.

- [ ] **Step 8: Web UI card + i18n**

`M365CommunicationsDelegatedCard.tsx` — clone `M365CustomerGraphReadCard.tsx`'s structure with the axis swapped (no org selector; the card is about *me*):

- On mount + on `callbackRefreshKey` change: `GET /m365/connections/communications-delegated/self`; render nothing when `enabled` is false.
- States: not connected (Connect button → `runAction` POST consent → `navigateTo(authorizeUrl)` — full-page redirect, the sibling pattern); `active` (badge, `Signed in as {delegatedUserUpn}`, granted scopes, expiry, Retest + Disconnect with `window.confirm`); `degraded` (Reconnect CTA + `lastErrorCode`-keyed message); `pending-consent`/`verifying` (in-progress + Reconnect).
- Every mutation through `runAction`; 401s fall through to the auth redirect per the established catch pattern.
- `IntegrationsPage.tsx`: add the `m365/communications-delegated/` hash prefix to `parseHash` and pass `{ callbackResult, callbackRefreshKey }` like the sibling cards; render the card in the m365 sub-tab.
- i18n: `useTranslation('integrations')`, key tree `m365CommunicationsDelegated.*` (title/description/status.*/actions.*/errors.*/callback.* — mirror the sibling's tree). Add to **all 7** locale files; `localeParity.test.ts` fails on any miss. Run `pnpm --filter=@breeze/web exec vitest run src/lib/i18n`.

- [ ] **Step 9: Run everything this task can break, typecheck, commit**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/m365ControlPlane src/routes/m365CommsConsent.test.ts src/routes/m365CommsConsentCallback.test.ts
pnpm --filter=@breeze/web exec vitest run src/components/integrations src/lib/i18n
cd apps/api && DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" \
  npx vitest run --config vitest.integration.config.ts \
    src/__tests__/integration/rls-coverage.integration.test.ts \
    src/__tests__/integration/tenant-export-policy.integration.test.ts \
    src/__tests__/integration/m365CommsUserRls.integration.test.ts
pnpm db:check-drift
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add apps/api/migrations/2026-08-06-g-m365-comms-delegated-upn.sql apps/api/src/db/schema/m365.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts \
        apps/api/src/services/m365ControlPlane/browserBinding.ts apps/api/src/services/m365ControlPlane/browserBinding.test.ts \
        apps/api/src/services/m365ControlPlane/commsConsent*.ts apps/api/src/routes/m365CommsConsent*.ts apps/api/src/index.ts \
        apps/web/src/components/integrations/M365CommunicationsDelegatedCard.tsx \
        apps/web/src/components/integrations/IntegrationsPage.tsx apps/web/src/locales
git commit -m "feat(m365): delegated consent phase — /common PKCE flow, promotion, UI card

Task 14 of the M365 communications-delegated executor (design §4.1-§4.2).

Third consent phase beside admin_consent/identity_verification, on the user
axis: no tenant hint (the tenant is LEARNED from the returned ID token),
sessions in the shipped system-only m365_user_consent_sessions table, sessions
deleted before attempt rotation (the composite FK has no ON UPDATE CASCADE),
and verify-then-persist delegated to the executor's ephemeral-cache redemption.
Promotion is one CAS'd UPDATE; a superseded attempt tombstones its own cache
row via the attempt-conditioned revoke. Reconnect pins the expected tenant —
a different tid is refused before anything persists. Never-promoted rows are
DELETEd, not revoked; promoted rows tombstone the executor cache before the
row records revoked. New delegated_user_upn column (display identity for the
card and the approval projection) is classified in the export policy."
```

---

### Task 15: AI tools (Tier 1/2) + MCP suppression

Spec §14 task 15, §6, §7. Three tools — `m365_list_mail`, `m365_get_mail`, `m365_draft_mail` — registered per-session for allowlisted interactive users, and the human-identity suppression that keeps every comms tool out of MCP.

**Files:**
- Create: `apps/api/src/services/actionIntents/humanIdentityTools.ts` + `humanIdentityTools.test.ts`
- Create: `apps/api/src/services/m365ControlPlane/aiToolsM365Comms.ts` + test — handlers, input schemas, `m365CommsToolTiers`, `M365_COMMS_TOOL_NAMES`
- Modify: `apps/api/src/services/aiAgentSdkTools.ts` — `m365CommsToolDefinitions()` + `TOOL_TIERS` entries + `BREEZE_MCP_TOOL_NAMES` filter
- Modify: `apps/api/src/services/aiTools.ts` — `getToolTier` fallback gains `m365CommsToolTiers`
- Modify: `apps/api/src/services/aiToolsM365.ts` — widen `m365ToolTiers` type `Record<string, 1 | 3>` → `Record<string, 1 | 2 | 3>` (no value changes)
- Modify: `apps/api/src/routes/mcpServer.ts` — deny in `tools/call`; test the listing half
- Modify: `apps/api/src/routes/mcpServer.test.ts` — both suppression halves

**Interfaces:**
- Consumes: `executeM365CommsInlineAction`, `COMMS_REFUSAL_MESSAGES` (Task 13); `m365CommsInlineActionSchema`, caps (`@breeze/shared/m365`); `isM365CommsToolsEnabledForUser` (Plan 1).
- Produces (consumed by Task 16 and the MCP layer):
  - `HUMAN_IDENTITY_ONLY_TOOLS: ReadonlySet<string>` — starts `{'m365_list_mail','m365_get_mail','m365_draft_mail'}`; Task 16 adds `'m365_send_mail'` — and `requiresHumanIdentity(toolName: string): boolean`. Dependency-free module (clone `durableRelease.ts`'s no-imports discipline — `aiAgentSdk` tests partially mock `../db/schema`).
  - `M365_COMMS_TOOL_NAMES = ['m365_list_mail','m365_get_mail','m365_draft_mail','m365_send_mail'] as const` and `m365CommsToolTiers: Record<string, 1 | 2 | 3> = { m365_list_mail: 1, m365_get_mail: 1, m365_draft_mail: 2, m365_send_mail: 3 }` — declared complete here (names are constants; the send *handler* arrives in Task 16)
  - Handlers `(input, auth) => Promise<string>` for the three inline tools

- [ ] **Step 1: `humanIdentityTools.ts` — write test, then module**

Tests first: `requiresHumanIdentity` true for members, false otherwise; a parity case pinning `HUMAN_IDENTITY_ONLY_TOOLS` set-equal to `M365_COMMS_TOOL_NAMES` (§6: comms is the first — and currently only — human-identity family; when a second family lands, this test is edited deliberately). Module mirrors `durableRelease.ts`:

```ts
/**
 * Tools whose effect is attributable to an INDIVIDUAL HUMAN IDENTITY (design
 * §6): they require principal.kind === 'user_session' regardless of transport,
 * and are suppressed from MCP entirely — absent from tools/list AND denied in
 * tools/call. Org-authority tools (device ops, patches, invoices, even
 * m365_reset_password) are deliberately NOT here.
 */
export const HUMAN_IDENTITY_ONLY_TOOLS: ReadonlySet<string> = new Set<string>([
  'm365_list_mail', 'm365_get_mail', 'm365_draft_mail',
]);
export function requiresHumanIdentity(toolName: string): boolean {
  return HUMAN_IDENTITY_ONLY_TOOLS.has(toolName);
}
```

(Write the parity test to compare against the *inline* three now and extend in Task 16 alongside the set — both edits in the same commit as the send tool, so the test never lies.)

- [ ] **Step 2: Tool handlers + tiers**

`aiToolsM365Comms.ts`. Input schemas are plain zod mirroring the shared caps (recipient/subject/body caps come from `@breeze/shared/m365` constants — never re-derive numbers). Handlers map 1:1 into the typed inline action and delegate everything to the service:

```ts
export async function m365ListMailHandler(input: unknown, auth: AuthContext): Promise<string> {
  const parsed = m365CommsInlineActionSchema.safeParse({ type: 'm365.comms.mail.list', ...(input as object) });
  if (!parsed.success) return JSON.stringify({ error: 'Invalid mail list parameters.' });
  const outcome = await executeM365CommsInlineAction(auth, parsed.data);
  return outcome.ok
    ? JSON.stringify(outcome.result)
    : JSON.stringify({ error: outcome.message, code: outcome.code });
}
```

(`get`/`draft` identical in shape; validate-never-transform — the schema's refine already rejects `search`+`sinceHours` together.) Declare `M365_COMMS_TOOL_NAMES` + `m365CommsToolTiers` here as the canonical source. Tests: handler happy path (service mocked), refusal passthrough with the fixed message, invalid input → typed error string with no input echo.

- [ ] **Step 3: Registration + tier plumbing**

1. `aiToolsM365.ts`: widen the `m365ToolTiers` annotation to `Record<string, 1 | 2 | 3>` (values untouched).
2. `aiTools.ts` `getToolTier` (:324-336): add `?? m365CommsToolTiers[toolName]` into the fallback chain beside `m365ToolTiers`/`googleToolTiers`.
3. `aiAgentSdkTools.ts`:
   - `TOOL_TIERS` gains `m365_list_mail: 1, m365_get_mail: 1, m365_draft_mail: 2` (send in Task 16). The `mcpCoverage` source-regex test requires every `tool('name'…)` declared here to be tiered — and vice versa keeps the maps honest.
   - `BREEZE_MCP_TOOL_NAMES` derivation (:243-245): add `.filter((name) => !requiresHumanIdentity(name))`.
   - New `m365CommsToolDefinitions(getAuth, getActiveSession, onPreToolUse?, onPostToolUse?)` cloning `m365ToolDefinitions`'s shape (:629-671) with the comms gates — **synchronous, env-only** (decision 5):
     ```ts
     const auth = getAuth();
     if (auth.principal.kind !== 'user_session') return [];
     if (auth.allowedSiteIds) return [];
     if (!isM365CommsToolsEnabledForUser(auth.user.id)) return [];
     return [ tool('m365_list_mail', 'List mail from your own Microsoft 365 mailbox …', …), … ];
     ```
   - Include it wherever `m365ToolDefinitions()` is spread into the session tool list (grep its call sites; add beside each).
4. Tool descriptions say "your own mailbox" — the model must not be invited to guess other users.

- [ ] **Step 4: MCP suppression — both halves, each tested**

`routes/mcpServer.ts`:

1. `handleToolsCall`: **before** tier resolution (`getToolTier` at :918), deny members:
   ```ts
   if (requiresHumanIdentity(toolName)) {
     return jsonRpcError(id, -32602,
       'This tool acts as an individual person and is only available in an interactive Breeze session.');
   }
   ```
   Without this, the tier fallback chain added in Step 3 makes the names *resolvable* here even though they are never in the `aiTools` map — today that falls through to `executeTool` → "Unknown tool", which is an accident, not a control (and would become auto-execution if anyone ever registers them in the map).
2. `handleToolsList` needs no code change (comms tools are session-registered, never in `getToolDefinitions()`'s sources) — but the *test* pins it so a future registration path can't silently expose them.

`mcpServer.test.ts` (pattern: the existing tier-gating suites at :328-1247):

```ts
it('tools/list never contains a human-identity tool', async () => {
  const listed = await callToolsList(adminApiKeyContext());
  for (const name of ['m365_list_mail','m365_get_mail','m365_draft_mail']) {
    expect(listed.map((t) => t.name)).not.toContain(name);
  }
});
it('tools/call denies a human-identity tool with a typed error, not "Unknown tool"', async () => {
  const res = await callTool('m365_draft_mail', {}, adminApiKeyContext());
  expect(res.error.message).toMatch(/interactive Breeze session/);
  expect(executeToolSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Run the parity/blast-radius suites, typecheck, commit**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/services/actionIntents/humanIdentityTools.test.ts \
  src/services/m365ControlPlane/aiToolsM365Comms.test.ts \
  src/services/aiAgentSdkTools.mcpCoverage.test.ts \
  src/services/aiToolsRegistryParity.test.ts \
  src/services/aiGuardrailsTierConfig.parity.test.ts src/services/aiGuardrailsAiDocs.parity.test.ts \
  src/routes/mcpServer.test.ts src/services/aiToolsM365.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add -A apps/api/src/services apps/api/src/routes/mcpServer.ts apps/api/src/routes/mcpServer.test.ts
git commit -m "feat(ai): m365 comms mail tools (tier 1/2) + human-identity MCP suppression

Task 15 of the M365 communications-delegated executor (design §6, §7).

m365_list_mail / m365_get_mail (tier 1) and m365_draft_mail (tier 2) register
per-session only for allowlisted users with principal.kind === 'user_session'
and no site restriction; the service ladder enforces ownership at every call.
New dependency-free HUMAN_IDENTITY_ONLY_TOOLS set implements §6's general rule:
tools attributable to an individual human are suppressed from MCP entirely —
filtered out of BREEZE_MCP_TOOL_NAMES, absent from tools/list (pinned by test),
and denied in tools/call BEFORE tier resolution with a typed error (previously
the tier fallback would fall through to 'Unknown tool' — an accident, not a
control)."
```

---

### Task 16: Tier-3 send — intent shape, `plan_digest`, `releaseCommsSend`, worker branch

Spec §0.a, §5.2–§5.3, §8, §14 task 16. The send tool creates intents whose `arguments` ARE the envelope; the release funnel is one function taking an intent id; the worker gets a fourth dispatch branch.

**Files:**
- Create: `apps/api/migrations/2026-08-06-h-m365-comms-plan-digest.sql`
- Modify: `apps/api/src/db/schema/actionIntents.ts` — `planDigest` column
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` — classify `plan_digest`
- Modify: `apps/api/src/services/actionIntents/intentService.ts` — `planDigest?` + `summaries?` on `CreateActionIntentInput`
- Modify: `apps/api/src/services/actionIntents/intentService.test.ts`
- Create: `apps/api/src/services/m365CommsToolsHeadless.ts` + `m365CommsToolsHeadless.test.ts` — `M365_COMMS_HEADLESS_ACTIONS`, `isHeadlessM365CommsTool`, `prepareCommsSendIntentInput`, `releaseCommsSend`
- Modify: `apps/api/src/services/m365ControlPlane/aiToolsM365Comms.ts` — the send tool definition (handler is intent-creating via the SDK layer; no direct handler execution path)
- Modify: `apps/api/src/services/aiAgentSdkTools.ts` — register `m365_send_mail` (tier 3) in `m365CommsToolDefinitions` + `TOOL_TIERS`
- Modify: `apps/api/src/services/aiAgentSdk.ts` — comms prep hook before `createActionIntent` (:656-668)
- Modify: `apps/api/src/services/actionIntents/durableRelease.ts` — `DURABLE_RELEASE_ONLY_TOOLS` gains `'m365_send_mail'`
- Modify: `apps/api/src/services/actionIntents/humanIdentityTools.ts` (+ parity test) — set gains `'m365_send_mail'`
- Modify: `apps/api/src/services/durableReleaseOnly.test.ts` — un-vacuous now; keep all three assertions green
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts` — fourth branch + headless exemption in the session_required gate (:319-326)
- Modify: `apps/api/src/jobs/intentReleaseWorker.test.ts` (or the worker's unit suite — read it first) — branch selection cases
- Modify: `apps/web/src/components/ai-risk/ApprovalHistoryFeed.tsx` — `TIER3_TOOLS` gains `m365_send_mail`

**Interfaces:**
- Consumes: Tasks 12/13/15 produces; `CreateActionIntentInput.binding` + the release recompute (Plan 1 task 6); `computeCommsPlanDigest`, `computeCommsEnvelopeDigest` (`@breeze/shared/m365/commsDigests`); `buildCommsSendEffect`, `commsSendEffectSchema`; `requiresDurableRelease` (shipped).
- Produces (consumed by Task 17):
  - `M365_COMMS_HEADLESS_ACTIONS: Record<string, 'm365.comms.mail.send'> = { m365_send_mail: 'm365.comms.mail.send' }` + `isHeadlessM365CommsTool(name: string): boolean`
  - `prepareCommsSendIntentInput(auth: AuthContext, input: unknown): Promise<{ ok: true; arguments: CommsSendEffect; binding: { connectionId: string; tenantId: string }; planDigest: string; summaries: { targetSummary: string; impactSummary: string } } | { ok: false; message: string }>`
  - `releaseCommsSend(intentId: string): Promise<string>` — the ONLY comms-send path to the executor; throws `M365CommsConnectionUnavailableError` (connection-level, no side effect) or returns a JSON tool-result/error string
  - `CreateActionIntentInput.planDigest?: string` (64 lowercase hex, persisted) and `summaries?: { targetSummary: string; impactSummary: string }`

- [ ] **Step 1: Migration — `plan_digest` + trigger**

`apps/api/migrations/2026-08-06-h-m365-comms-plan-digest.sql`:

```sql
-- Second digest of the two-digest send contract (design §5.3(b)): sha256 of
-- the canonical GraphOperationPlan, stamped at intent creation and carried to
-- the executor as a signed claim. Persisted-at-creation is load-bearing: a
-- @breeze/shared upgrade that changes buildSendPlan between approval and
-- release MUST invalidate the intent (executor recompute mismatch), not sail
-- through under a freshly computed claim.
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS plan_digest CHAR(64);

CREATE OR REPLACE FUNCTION action_intents_block_content_update() RETURNS trigger AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     -- …every existing column from 2026-07-18-action-intents.sql:97-115 stays,
     -- copied verbatim (origin_principal columns included per #2917's update)…
     OR NEW.plan_digest IS DISTINCT FROM OLD.plan_digest THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

Copy the function body from `apps/api/migrations/2026-08-06-e-action-intents-origin-principal.sql` — the **latest** shipped definition (it added the `origin_principal_kind`/`origin_principal_id` columns to the immutable list; the original at `2026-07-18-action-intents.sql:95-125` is stale) — plus the one new `plan_digest` line. This file's `-h-` name sorts after `-e-` precisely so a fresh-DB replay applies this version last; re-verify the sort position at execution time (Global Constraints). Schema: `planDigest: char('plan_digest', { length: 64 })` — match `argumentDigest`'s declaration style in `actionIntents.ts` (read it; if it is `varchar(64)`, use `varchar` for both the column and this migration). Export policy: `plan_digest` → `included`, beside `argument_digest`. `pnpm db:migrate && pnpm db:check-drift`.

- [ ] **Step 2: `intentService` extensions — failing tests first**

Append to `intentService.test.ts` (reuse the file's capture helper per Plan 1's Task 6 pattern):

```ts
it('persists planDigest and applies summary overrides', async () => {
  const captured = captureInsertValues();
  await createActionIntent(authFixture(), {
    toolName: 'm365_send_mail', input: envelopeFixture(), source: 'chat',
    binding: { connectionId: G2, tenantId: G3 },
    planDigest: 'c'.repeat(64),
    summaries: { targetSummary: 'to=[a@example.com] subject="s"', impactSummary: '1 recipient, 1 char body' },
  });
  expect(captured.planDigest).toBe('c'.repeat(64));
  expect(captured.targetSummary).toBe('to=[a@example.com] subject="s"');
});
it('rejects a malformed planDigest before INSERT', async () => {
  await expect(createActionIntent(authFixture(), { ...sendInput(), planDigest: 'C'.repeat(64) }))
    .rejects.toThrow(/planDigest must be 64 lowercase hex/);
});
it('leaves plan_digest null and summaries generated for ordinary tools', ...);
```

Implement: validate `/^[0-9a-f]{64}$/`; `.values({ …, planDigest: input.planDigest ?? null })`; when `input.summaries` present use it instead of `buildTargetSummary`/`buildImpactSummary` (decision 7 — the generic builder would embed body text into `target_summary`).

- [ ] **Step 3: `prepareCommsSendIntentInput` — the creation-side ladder**

In `m365CommsToolsHeadless.ts`. Reuses Task 13 helpers; runs under the live session:

1. Principal/site/allowlist gates (same three rungs; refusal returns `{ ok: false, message }` with the fixed sentences).
2. Connection under caller RLS; `commsConnectionNotReadyState(connection, auth.user.id, ['active'])` — send prep requires `active`.
3. Parse the raw tool input `{ to, cc?, bcc?, subject, bodyText }` (zod, shared caps), then:
   ```ts
   const envelope = buildCommsSendEffect({
     actionVersion: 1,
     connectionId: connection.id,
     tenantId: connection.tenantId,
     senderObjectId: connection.delegatedUserObjectId,
     consentGeneration: connection.consentGeneration,
     to, cc, bcc, subject, bodyText,
   });
   const validated = commsSendEffectSchema.parse(envelope);   // validate, never transform
   const planDigest = computeCommsPlanDigest(validated);
   ```
4. Summaries — recipients/subject/counts/digest only, **no body content** (decision 7):
   ```ts
   const recipients = [...validated.to, ...validated.cc, ...validated.bcc];
   const targetSummary = `m365_send_mail to=[${validated.to.join(', ')}]`
     + (validated.cc.length ? ` cc=[${validated.cc.join(', ')}]` : '')
     + (validated.bcc.length ? ` bcc=[${validated.bcc.join(', ')}]` : '')
     + ` subject="${validated.subject}"`;
   const impactSummary = `Sends mail as the connected mailbox owner: ${recipients.length} recipient(s), `
     + `body ${countCodePoints(validated.bodyText)} chars, digest ${computeCommsEnvelopeDigest(validated).slice(0, 12)}`;
   ```
5. Return `{ ok: true, arguments: validated, binding: { connectionId: connection.id, tenantId: connection.tenantId }, planDigest, summaries }`.

Tests: envelope fields come from the connection (not the input); a tampered input cannot set `senderObjectId`/`consentGeneration` (schema `.strict()` rejects extras); summaries never contain `bodyText` (canary assertion); refusals for each gate.

- [ ] **Step 4: Wire the prep hook into the central Tier-3 intent creation**

`aiAgentSdk.ts`, in the `tier >= 3` branch immediately before `createActionIntent` (:656):

```ts
let commsPrep: Awaited<ReturnType<typeof prepareCommsSendIntentInput>> | undefined;
if (isHeadlessM365CommsTool(toolName)) {
  commsPrep = await prepareCommsSendIntentInput(session.auth, input);
  if (!commsPrep.ok) {
    return await failMatchedPlanStep({ allowed: false, error: commsPrep.message });
  }
}
// existing call, extended:
intent = await createActionIntent(session.auth, {
  toolName,
  input: (commsPrep?.arguments ?? input) as Record<string, unknown>,
  source: 'chat',
  reason: riskSummary,
  orgId: session.orgId,
  ...(commsPrep ? { binding: commsPrep.binding, planDigest: commsPrep.planDigest, summaries: commsPrep.summaries } : {}),
});
```

The intent's org anchor stays the requesting session's org context (§3.4 "Intent anchoring") — no change to `orgId` handling. Import `prepareCommsSendIntentInput`/`isHeadlessM365CommsTool` normally; `humanIdentityTools`/`durableRelease` stay dependency-free.

- [ ] **Step 5: `releaseCommsSend(intentId)` — the funnel**

```ts
export class M365CommsConnectionUnavailableError extends Error {
  constructor(public readonly toolResult: string) { super(toolResult); }
}

/**
 * The ONLY path by which a comms send reaches Graph (design §0.a). Takes an
 * intent id and nothing else: everything — action, envelope, user, digests —
 * is loaded from the intent row, so the function cannot be invoked with
 * attacker-shaped input. Called exclusively by the durable release worker
 * after it wins the approved→executing CAS and passes revalidation.
 */
export async function releaseCommsSend(intentId: string): Promise<string> {
  // 1. Load the intent (system context); require status 'executing' (the
  //    worker's claim) — anything else returns a typed error string.
  // 2. intent.originPrincipalKind === 'user_session' else error 'user_actor_required'
  //    (the persisted record, not a reconstruction — §6 checkpoint 3).
  // 3. isM365CommsToolsEnabledForUser(intent.requestedByUserId) else throw
  //    M365CommsConnectionUnavailableError (flag off = no side effect, retryable posture).
  // 4. envelope = commsSendEffectSchema.parse(intent.arguments) — validate,
  //    never transform; parse failure → error 'digest_mismatch' shape.
  // 5. connection = loadOwnCommsConnection(intent.requestedByUserId);
  //    owner check: connection.userId === intent.requestedByUserId (fail closed);
  //    status 'active' only; else throw ConnectionUnavailable('connection_not_ready…').
  // 6. Binding — ALL FOUR, against both the intent columns and the envelope (§5.2):
  //    connection.id === intent.connectionId === envelope.connectionId
  //    connection.tenantId === intent.tenantId === envelope.tenantId
  //    connection.delegatedUserObjectId === envelope.senderObjectId
  //    connection.consentGeneration === envelope.consentGeneration
  //    → mismatch returns error 'binding_stale' (terminal; the intent
  //      terminalizes as tool_returned_error and the user re-requests).
  // 7. intent.planDigest present (64-hex) else error 'binding_stale' — a comms
  //    intent without its second digest must never reach the executor.
  // 8. Budget 'mutation'; then the executor call:
  //    executeCommsAction({ correlationId: randomUUID(), connectionId, tenantId,
  //      expectedUserObjectId: envelope.senderObjectId,
  //      consentGeneration: envelope.consentGeneration,
  //      idempotencyKey: intent.id, envelope },
  //      { effectDigest: intent.argumentDigest, planDigest: intent.planDigest,
  //        consentGeneration: envelope.consentGeneration })
  //    — claims from STORED values only. Never recompute effectDigest here.
  // 9. Success: applyCommsSuccessWriteback + audit/metric; return JSON.stringify(result).
  //    delegated_reauth_required: markCommsConnectionDegraded + error string.
  //    executor_unavailable/rate-limit: throw ConnectionUnavailable (no side effect).
  //    Never internally retry after an ambiguous outcome — a timeout maps to its
  //    fixed failure and the intent terminalizes (§8 duplicate-send defense).
}
```

Write the body from the comments — each numbered rung is one block, using Task 13's helpers and `COMMS_FAILURE_MESSAGES`. Tests (mock executor factory + Drizzle): owner mismatch → `binding_stale`-style refusal string, never a send; stale generation → `binding_stale`; key-actor intent (`originPrincipalKind: 'api_key'`) → `user_actor_required`; missing plan digest → refused; flag-off → throws ConnectionUnavailable; claims assert **stored** digest values (fixture stores a digest ≠ recompute; the claim must equal the stored one — pins "never recompute as authority"); reauth-required degrades; canary body/subject never appear in any thrown/returned/audited string.

- [ ] **Step 6: Worker branch + guards + parity sets**

1. `intentReleaseWorker.ts` dispatch (:357-361) gains the fourth arm — closure over the id only (decision 2):
   ```ts
   const invoke = isHeadlessGoogleTool(intent.actionName)
     ? () => executeGoogleToolHeadless(intent.actionName, intent.arguments, intent.orgId)
     : isHeadlessM365Tool(intent.actionName)
     ? () => executeM365ToolHeadless(intent.actionName, intent.arguments, intent.orgId, intent.id)
     : isHeadlessM365CommsTool(intent.actionName)
     ? () => releaseCommsSend(intent.id)
     : () => executeTool(intent.actionName, intent.arguments, auth);
   ```
2. The `session_required` gate (:319-326) adds `!isHeadlessM365CommsTool(...)` beside the other two headless exemptions.
3. Catch block: `M365CommsConnectionUnavailableError` joins the `connection_unavailable` terminalization arm (:368-385).
4. `DURABLE_RELEASE_ONLY_TOOLS` = `new Set(['m365_send_mail'])`; `HUMAN_IDENTITY_ONLY_TOOLS` gains `'m365_send_mail'` (+ its parity test now compares all four).
5. `m365CommsToolsHeadless.test.ts` parity: `Object.keys(M365_COMMS_HEADLESS_ACTIONS).sort()` equals the tier-3 subset of `m365CommsToolTiers` (the `m365ToolsHeadless.test.ts:33-36` pattern) **and** equals `[...DURABLE_RELEASE_ONLY_TOOLS].sort()` — §0.a's "ineligible set equals the comms Tier-3 set", the test that keeps the funnel closed as the catalog grows.
6. `TOOL_TIERS` gains `m365_send_mail: 3`; the send `tool(...)` definition joins `m365CommsToolDefinitions` (its handler body is never invoked for tier-3 — the SDK layer intercepts at `guardrailCheck.tier >= 3` — so it returns the pending-approval message if ever called directly); `ApprovalHistoryFeed.tsx` `TIER3_TOOLS` gains the name.
7. Worker unit tests: comms branch selected for `m365_send_mail` with **only** the intent id closed over; google/m365/default branches unchanged; ConnectionUnavailable taxonomy.

- [ ] **Step 7: Run the blast radius, typecheck, commit**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/services/actionIntents src/services/m365CommsToolsHeadless.test.ts \
  src/services/durableReleaseOnly.test.ts src/services/aiAgentSdk.test.ts src/services/aiAgentSdk.planMatch.test.ts \
  src/services/aiAgentSdkTools.mcpCoverage.test.ts src/jobs/intentReleaseWorker.test.ts \
  src/routes/mcpServer.test.ts
cd apps/api && DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" \
  npx vitest run --config vitest.integration.config.ts \
    src/__tests__/integration/tenant-export-policy.integration.test.ts \
    src/__tests__/integration/actionIntentBinding.integration.test.ts \
    src/services/actionIntents/createIntentAtomicity.integration.test.ts
pnpm --filter=@breeze/web exec vitest run src/components/ai-risk
pnpm db:check-drift
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add -A apps/api/migrations apps/api/src apps/web/src/components/ai-risk
git commit -m "feat(m365): tier-3 comms send — envelope intents, plan digest, releaseCommsSend

Task 16 of the M365 communications-delegated executor (design §0.a, §5.2-§5.3, §8).

m365_send_mail intents store the canonical CommsSendEffect AS their arguments
(argumentDigest IS the effect digest), pin the connection binding at creation,
and stamp a new immutable plan_digest column — persisted at creation so a
shared-package upgrade that changes buildSendPlan invalidates approved intents
instead of silently reshaping them. Summaries carry recipients/subject/counts/
digest only; body text lives once, in intent.arguments.

releaseCommsSend(intentId) is the single funnel to Graph: it takes an intent id
and nothing else, re-checks the persisted origin principal, the owner, all four
binding fields, and sends the STORED digests as signed claims. The worker's
fourth dispatch branch closes over the id only; DURABLE_RELEASE_ONLY_TOOLS
gains its first member, and the parity test pins that set to the comms tier-3
catalog so the funnel stays closed as tools are added."
```

---

### Task 15b: Approval projection — the gated intent read, the comms renderer, the copy frozen

Spec §5.4, §14 task 15b. The approver must see exactly what will be sent, from the immutable record, with hostile text neutralized — and the mutable display copy stops being trusted anywhere.

**Files:**
- Create: `apps/api/migrations/2026-08-06-i-approval-arguments-immutable.sql`
- Modify: `apps/api/src/routes/actionIntents.ts` — `GET /:id` (the gated read; today the router has only `/:id/reveal-secret`)
- Modify: `apps/api/src/routes/actionIntents.test.ts` (or create beside it — read the reveal route's test first and extend its harness)
- Modify: `apps/api/src/routes/approvals.ts` — detail serves the intent's arguments for intent-linked approvals (decision 9)
- Modify: `apps/api/src/routes/approvals.test.ts`
- Create: `apps/web/src/lib/sanitizeDisplay.ts` + test — bidi/invisible-control neutralization
- Create: `apps/web/src/components/ai/CommsSendApprovalContent.tsx`
- Modify: `apps/web/src/components/ai/AiApprovalDialog.tsx` — comms branch
- Modify: `apps/web/src/lib/intentApprovals.ts` — `fetchIntentDetail(intentId)`
- Modify: `apps/web/src/locales/<locale>/ai.json` ×7 — renderer strings

**Interfaces:**
- Consumes: comms intents (Task 16 — `arguments` = envelope, `plan_digest`, `binding` columns); `delegated_user_upn` (Task 14); `userCanDecideApprovals` + `canAccessOrg` (`services/permissions.ts:226-228`, the decide-path gate at `approvals.ts:541-566`); the reveal route's requester/admin-fallback RBAC shape (`actionIntents.ts:71-91`).
- Produces:
  - `GET /api/v1/action-intents/:id` → `{ id, actionName, arguments, argumentDigest, targetSummary, impactSummary, riskTier, status, requestedByUserId, orgId, createdAt, expiresAt, senderUpn: string | null }` — `senderUpn` joined from `m365_connections.delegated_user_upn` via `intent.connectionId` when set
  - `sanitizeDisplayText(text: string): string` (web)

- [ ] **Step 1: Migration — freeze the displayed copy**

`2026-08-06-i-approval-arguments-immutable.sql`, cloning the `2026-07-18-action-intents.sql:95-125` pattern:

```sql
-- approval_requests.action_arguments is a COPY of intent.arguments that the
-- approval API serves; the intent's copy is trigger-protected, this one was
-- not (design §5.4 — "no current writer" is not an invariant). Freeze the
-- content/identity columns; lifecycle stays mutable.
CREATE OR REPLACE FUNCTION approval_requests_block_content_update() RETURNS trigger AS $$ … $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'approval_requests_immutable_trg') THEN
  CREATE TRIGGER approval_requests_immutable_trg BEFORE UPDATE ON approval_requests
    FOR EACH ROW EXECUTE FUNCTION approval_requests_block_content_update(); END IF; END $$;
```

Frozen column list: read `db/schema/approvals.ts` and freeze everything EXCEPT the lifecycle set `{status, decided_at, decision_reason, decided_assurance_level, decided_via, authenticator_device_id, updated_at}` (confirm the exact mutable names against the schema — the decide handler writes them; grep its `.set({...})` and leave precisely those writable). Add an integration test beside the intent-binding one proving an `action_arguments` UPDATE raises while a `status` UPDATE succeeds.

- [ ] **Step 2: The gated intent read**

In `routes/actionIntents.ts`, clone the reveal route's access shape:

```ts
actionIntentsRoutes.get('/:id', zValidator('param', intentParamSchema), async (c) => {
  // System-context load; 404 on missing.
  // Access: requester (auth.user.id === intent.requestedByUserId) OR the
  // decide gate (canAccessOrg(perms, intent.orgId) && userCanDecideApprovals(perms))
  // — the same live-permission re-resolution the decide path does
  // (approvals.ts:541-566). Everyone else: 404 (not 403 — do not confirm
  // existence across tenants).
  // senderUpn: when intent.connectionId is set, join m365_connections and
  // return delegated_user_upn (system context — the approver is often not the
  // owner, so caller RLS would hide the user-owned row; this read exposes ONE
  // display field, never the row).
});
```

Tests: requester sees own intent; org approver with `approvals:decide` sees it; same-org user *without* decide → 404; cross-org approver → 404; api-key-requested intent readable by the admin fallback (mirror the reveal tests); `senderUpn` populated for a comms intent and null otherwise; response never includes `result` (the reveal path owns secrets).

- [ ] **Step 3: Approval detail serves the immutable copy**

`approvals.ts` `GET /:id` (:137) — when the approval row carries an `intentId`, load the linked intent (the decide path already does) and serialize `actionArguments: linkedIntent.arguments` instead of the row's copy. `/pending` keeps the summary-only shape untouched. Test: seed an approval whose `action_arguments` copy was forged to differ (insert directly, pre-trigger — or in the unit suite, mock the two reads) and assert the served body is the intent's.

- [ ] **Step 4: Web — sanitizer + comms renderer**

1. `sanitizeDisplay.ts`: copy the `DANGEROUS_UNICODE` regex from `apps/api/src/services/aiInputSanitizer.ts` (bidi overrides, zero-width chars/joiners) — `sanitizeDisplayText` strips them so rendered reading order cannot differ from sent bytes (§5.4 point 3). Test with RLO/zero-width fixtures.
2. `intentApprovals.ts`: `fetchIntentDetail(intentId)` against the new endpoint via `fetchWithAuth`.
3. `CommsSendApprovalContent.tsx`: fetches the intent, renders — full `to`/`cc`/`bcc` (BCC prominently labeled, never elided), `subject`, the **entire** body in a `whitespace-pre-wrap` block (scrollable, never truncated — for mail the displayed content IS the effect), `Signed in as {senderUpn}`, and the first 12 chars of `argumentDigest`. Every string through `sanitizeDisplayText`. Loading/error states; on fetch failure the dialog shows an explicit "could not load the full message — do not approve blind" state rather than falling back to the summary.
4. `AiApprovalDialog.tsx`: `toolName === 'm365_send_mail'` → render `CommsSendApprovalContent` in place of the generic `<pre>{JSON.stringify(...)}` block (:427-436). Read the `approval_required` SSE payload construction (`aiAgentSdk.ts:697-717`); if `intentId` is not already in it, add it and thread it through the dialog props.
5. i18n keys in `ai.json` ×7 (`commsApproval.to/cc/bcc/subject/body/signedInAs/digest/loadFailed`); run the i18n suites.

- [ ] **Step 5: Run, typecheck, commit**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/actionIntents.test.ts src/routes/approvals.test.ts
cd apps/api && DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" \
  npx vitest run --config vitest.integration.config.ts src/__tests__/integration/approvalArgumentsImmutable.integration.test.ts \
    src/__tests__/integration/intentSelfApproveGuard.integration.test.ts src/__tests__/integration/intentFanout.integration.test.ts
pnpm --filter=@breeze/web exec vitest run src/components/ai src/lib
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
git add -A apps/api/migrations apps/api/src/routes apps/web/src
git commit -m "feat(approvals): comms approval projection — gated intent read, full-content renderer, frozen copy

Task 15b of the M365 communications-delegated executor (design §5.4).

New GET /action-intents/:id serves the trigger-protected intent.arguments to
the requester or an approvals:decide holder in the intent's org (404 otherwise,
mirroring the reveal route's fallback gate), joined with the sender UPN. The
approval detail now serves the intent's arguments for every intent-linked
approval instead of the mutable approval_requests copy, and that copy is frozen
by trigger as defense-in-depth. The comms renderer shows the complete effect —
all recipients including BCC, subject, entire body, sender identity — with
bidi/invisible-control characters neutralized so reading order cannot differ
from the sent bytes. On load failure it says so; it never falls back to a
summary an attacker could make disagree with the content."
```

---

### Task 17: Integration proof — the whole chain against real Postgres

Spec §14 task 17. Executor HTTP mocked at the client factory seam; everything else real.

**Files:**
- Create: `apps/api/src/services/m365ControlPlane/__testHelpers__/seedCommsConnection.ts` — user-owned row seeder (`orgId: null`, `userId`, `profile: 'communications-delegated'`, `authMode: 'delegated'`, `status`, `tenantId`, `delegatedUserObjectId`, `delegatedUserUpn`, `consentGeneration`, `vaultRef: 'executor-owned:m365-comms-client-cert'`, `credentialVersion: '1'` — clone `seedActionsConnection.ts`'s minimal-valid shape)
- Create: `apps/api/src/jobs/intentReleaseWorkerCommsHeadless.integration.test.ts` — **dual-list it**: include in `vitest.integration.config.ts`, exclude in `vitest.config.ts` (the M365Headless header comment explains both failure modes)
- Create: `apps/api/src/__tests__/integration/m365CommsFlow.integration.test.ts` — auto-globbed, no dual-listing

**Harness** (clone `intentReleaseWorkerM365Headless.integration.test.ts`): `vi.hoisted` spy on `createCommsExecutorClient`; `beforeAll` env — `M365_COMMS_TOOLS_ENABLED`/`M365_COMMS_TOOLS_USER_IDS`/`M365_COMMS_ONBOARDING_*`/`M365_COMMS_CLIENT_ID`/`M365_COMMS_EXECUTOR_URL`/`_AUDIENCE`/`_SIGNING_KID`/`_SIGNING_PRIVATE_JWK_FILE` (tmpdir JWK fixture, 0600); org/user/role seeding from `__tests__/integration/db-utils`; real `AuthContext` via `buildOrgAccessClosures` with `principal: { kind: 'user_session' }`.

- [ ] **Step 1: Worker suite** — seed an approved `m365_send_mail` intent (envelope arguments, binding columns, `plan_digest`, `origin_principal_kind: 'user_session'`), run the worker:
  - happy path: executor spy receives the envelope verbatim + claims equal to the **stored** digests; intent `completed`; connection writeback applied
  - owner mismatch (connection reseeded under another user) → intent fails, executor never called
  - reconnect-bumps-generation: bump `consent_generation` after approval → `binding_stale`, terminal, executor never called (the API-side half; the executor-side TOCTOU re-check is Plan 2's)
  - key-actor intent (`origin_principal_kind: 'api_key'`) → `user_actor_required`, executor never called
  - digest drift: forge `argument_digest` ≠ recompute (raw SQL with the trigger disabled via a superuser-less path is impossible — instead seed via direct INSERT with the mismatched digest) → Plan 1's release recompute refuses with `digest_mismatch`
  - `delegated_reauth_required` from the spy → intent terminalizes, connection `degraded`
  - executor unavailable → `failed:connection_unavailable`, no writeback

- [ ] **Step 2: Flow suite** —
  - consent → active: drive `initiateDelegatedConsent` + `handleDelegatedConsentCallback` with the executor spy returning the consent success shape; assert promotion row state (generation bumped, UPN stamped, sentinel vault_ref) and that a superseded second attempt tombstones via the attempt-conditioned revoke
  - inline ladder against the real row: list (degraded allowed), draft (degraded refused), cross-user refusal
  - **a comms intent is never claimed inline** (§0.a): drive the inline release path (`aiAgentSdk` harness or `requiresDurableRelease` + the diversion test pattern from `aiAgentSdk.test.ts`) against an approved comms intent — the CAS is never attempted
  - the §7 Unicode/wire round-trip: an envelope whose `bodyText` carries non-BMP chars + CRLF (from the shared vector corpus) survives API validation → `jsonb` INSERT → read-back → digest recompute equality; and a `U+0000`-carrying body is rejected at validation, before INSERT

- [ ] **Step 3: Run both suites + the contract sweeps, commit**

```bash
cd apps/api && DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" \
  npx vitest run --config vitest.integration.config.ts \
    src/jobs/intentReleaseWorkerCommsHeadless.integration.test.ts \
    src/__tests__/integration/m365CommsFlow.integration.test.ts \
    src/__tests__/integration/rls-coverage.integration.test.ts \
    src/__tests__/integration/tenantCascade.integration.test.ts \
    src/__tests__/integration/tenant-export-policy.integration.test.ts
git add -A apps/api/src
git commit -m "test(m365): comms end-to-end integration proof

Task 17 of the M365 communications-delegated executor (design §14).

Consent→active→inline tools→intent→approve→release→sent against real Postgres
with the executor mocked at the client-factory seam. Proves the negative space:
owner mismatch, stale generation, key-actor origin, digest drift, and inline
claim are all refused before the executor is ever called; reauth-required
degrades; the Unicode wire round-trip survives jsonb intact."
```

---

### Task 18: Deploy runbook + plumbing deferred from Plan 2

Spec §14 task 18, §10; Plan 2 decision 6's deferred guard entries. Docs and config only — no product code.

**Files:**
- Create: `docs/deploy/m365-communications-executor.md`
- Modify: `deploy/.env.example` — comms block after the actions block
- Modify: `docker-compose.yml` — `M365_COMMS_*` in the `api` service `environment:` block + the signing-JWK Docker secret
- Create: `scripts/security/check-m365-communications-runtime.sh` + `scripts/security/m365-communications-runtime-probe.ts` (clone the actions pair; comms secret name)
- Modify: `.github/workflows/security.yml` — invoke the comms smoke beside the actions one (grep `check-m365-graph-actions-runtime` for the exact step shape)
- Modify: `scripts/security/check-supply-chain-hardening.sh` — the deferred parity blocks
- Modify: `scripts/docs-review/mapping.json` — entries for `commsActionService.ts` and `commsRuntimeConfig.ts` → `["deploy/environment.mdx", "features/ai.mdx"]`

- [ ] **Step 1: The runbook** — clone the actions runbook's section skeleton (`docs/deploy/m365-customer-graph-actions-executor.md`) with the delegated divergences, each already decided upstream; the runbook *records*, it does not re-decide:
  - **Secret-ownership matrix**: `m365-comms-client-cert` + `m365-comms-token-cache-kek` (both immutable, version-pinned, executor-`get`-only — the API's identity can read NEITHER); the comms Ed25519 keypair (never shared with the other two executors); the token-cache DSN.
  - **Token-cache store provisioning**: a dedicated Postgres the executor owns, reachable from the executor only. **The Breeze-Postgres fallback is closed by recorded decision (2026-07-29, spec §3.2)** — reaching for it under deploy pressure requires re-deciding, not improvising. Egress allowlist: Key Vault host, `login.microsoftonline.com`, `graph.microsoft.com`, the store DSN host — the allowlist is what makes an improvised reversal visible in a diff.
  - **Callback byte-match gotcha**: `M365_COMMS_CALLBACK_URL` must strict-equal API origin + `/api/v1/m365/comms-consent/callback`.
  - **Dark launch**: executor dark by digest → healthz → consent exactly one user → allowlist that UUID → list→get→draft→approve→send→verify in Sent Items → stop (there is no "expand gradually" until a second communications user exists, §10).
  - **Rollback** = `M365_COMMS_TOOLS_ENABLED=false` (tools vanish, connections persist).
  - **Known limitations, verbatim residuals**: the §4.2 discarded-grant residual (a refresh token Microsoft issued and Breeze discarded on failed verification — unrevokable with the held scopes, dies of inactivity); the §8 executor-replay residual (jti validated, never consumed — duplicate *delivery* inside the private boundary is possible until the store-backed one-time claim ships); `offline_access` absence surfacing as the first `acquireTokenSilent` failing with `delegated_reauth_required` (Plan 2's reconcile comment).
  - **Signals**: `breeze_m365_comms_total{action,outcome}`, audit `m365.comms.action_executed` (details `{actionType, outcome}` only — correspondence never in audit), `degraded`-status alerting keyed off `expires_at`.
- [ ] **Step 2: Env + compose plumbing** — `deploy/.env.example`: the executor-side block (Plan 2 §10 executor column names) + API-side `M365_COMMS_*` (Plan 1's nine) with `M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_SOURCE_FILE`. `docker-compose.yml` `api` service: the nine vars + `M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE` hardcoded to `/run/secrets/m365_comms_executor_signing_private_jwk`, the service-level `secrets:` entry, and the top-level secret sourced from the `_SOURCE_FILE` var — byte-parallel to the actions plumbing at :222-235/:348-349/:545-546. **No `m365-communications-executor:` service block, ever** (the guard rejects it). Run `pnpm --filter=@breeze/api exec vitest run src/config/composeBindMounts.test.ts`.
- [ ] **Step 3: Smoke + hardening guard** — clone the runtime-smoke pair (secret file uid/gid 1001 + mode assertions; keep the macOS/VirtioFS caveat comment); `chmod +x`; wire into `security.yml` beside the actions invocation. `check-supply-chain-hardening.sh` gains the deferred comms blocks: `reject_grep '^  m365-communications-executor:'` on every tracked compose file, the `/run/secrets/m365_comms…` requirement, the smoke-script-executable requirement, and compose/env-template parity greps mirroring the actions ones. Run the script — green.
- [ ] **Step 4: mapping.json + commit**

```bash
bash scripts/security/check-supply-chain-hardening.sh
git add docs/deploy deploy/.env.example docker-compose.yml scripts .github/workflows/security.yml
git commit -m "docs(deploy): m365 communications executor runbook + deferred guard plumbing

Task 18 of the M365 communications-delegated executor (design §10, §14).

Runbook records the decided posture: executor-owned token-cache store (Breeze-
Postgres fallback CLOSED by decision, not preference), read-only vault with two
immutable secrets, per-executor Ed25519 keypair, one-user dark launch, rollback
by tools flag. Residuals recorded where operators will read them: the
discarded-grant refresh token, the executor replay window, offline_access
surfacing as first-silent-acquisition failure. Compose maps the API-side vars
and the signing-JWK secret; the hardening guard now rejects a comms executor
compose service and requires the comms runtime smoke — the entries Plan 2
deferred because these files did not exist yet."
```

---

## Verification before PR

1. `pnpm --filter=@breeze/api test` and `pnpm --filter=@breeze/web test` — green.
2. The separate-config suites `pnpm test` does NOT run (local green ≠ CI green):
   ```bash
   cd apps/api && DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" \
     npx vitest run --config vitest.integration.config.ts
   ```
   — including `rls-coverage`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, the two comms suites, and the worker headless suites.
3. `pnpm db:migrate && pnpm db:check-drift` — clean.
4. Repo-root typecheck (`NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json`) + `pnpm --filter=@breeze/web exec tsc --noEmit` if the web app has a typecheck script (read `apps/web/package.json`).
5. `bash scripts/security/check-supply-chain-hardening.sh` — green.
6. Web i18n suites (`keyUsage`, `localeParity`) and `no-silent-mutations` — the new card and renderer use `runAction`/typed fetch, so the allowlist should not grow; if the count test fails, fix the handler, don't extend the allowlist.
7. Grep the redaction invariant one last time: `grep -rn 'bodyText\|subject' apps/api/src/services/m365CommsToolsHeadless.ts apps/api/src/services/m365ControlPlane/commsActionService.ts | grep -i 'console\|log\|audit\|summary'` — expect zero hits outside comments/summaries built by decision 7's shape.
8. Verify as `breeze_app` (forge a cross-user comms read via psql — must fail with RLS or return zero rows per the shipped policy).
9. This branch is based on `main`, so PR CI runs normally. If any part is ever stacked, dispatch CI per branch before trusting `gh pr checks`.

## Self-Review

**1. Spec coverage (§14 tasks 12–18).** Task 12: the client clone + claims (§5.2 item 3). Task 13: the full user-axis ladder in the spec's order — principal → allowlist → connection under caller RLS → owner fail-closed → status split → budget → executor → writeback → degraded-on-reauth → metrics (§14 task 13, every clause present). Task 14: §4.2's phase (no hint, `/common`, PKCE, verify-then-persist via the executor's ephemeral redemption), §4.1's promotion UPDATE + supersede-tombstone ordering + both lifecycle invariants (never-promoted DELETE; the identity-bearing active constraint is enforced by the shipped migration and satisfied by the promotion's column set), reconnect tenant-mismatch, browser binding third phase, UI card + i18n + runAction. Task 15: three tools, user_session + allowlist + site refusal, MCP suppression both halves with a test per half (§6). Task 16: arguments-are-the-envelope, summaries split (§12 flag 3), plan_digest persisted (§5.3(b)), releaseCommsSend as the sole funnel (§0.a), worker user-axis branch + user_actor_required + owner/stale-binding/unavailable taxonomy, parity test pinning the ineligible set to the comms tier-3 set. Task 15b: render from `intent.arguments` via the new RBAC-gated endpoint, full recipients incl. BCC + subject + entire body + sender UPN, bidi neutralization, the copy frozen by trigger (§5.4 all four points). Task 17: every scenario the spec's task-17 line lists, minus the executor-side TOCTOU half (Plan 2's suite owns it — noted inline). Task 18: runbook with the §4.2 and §8 residuals, env tables, read-only vault scoping, store provisioning + placement decision, callback gotcha, rollback-by-flag; plus Plan 2's three deferred guard families. Nothing in the 12–18 range is unassigned.

**2. Placeholder scan.** No TBD/TODO. Two steps deliberately instruct reading a shipped file before writing (the approval_requests mutable-column list; the worker unit-test harness) because enumerating them here from memory would be the riskier placeholder — each names the exact file and the decision rule. `releaseCommsSend` ships as a numbered-contract comment block with every rung's inputs, outputs, and error codes specified; the implementer writes statements, not decisions. Claims verified against the tree during planning: the intent read endpoint does NOT exist (only `/:id/reveal-secret`); `DURABLE_RELEASE_ONLY_TOOLS` is empty and its diversion sits at `aiAgentSdk.ts:748-759` before the CAS; the worker dispatch is a ternary at :357-361 passing org (+intent id for M365), never the user; `approval_requests` has no immutability trigger; locales are 7, not the spec's 5; `commsExecutorContracts.ts` and `commsRuntimeConfig.ts` do not exist on main — hence the execution-baseline gate.

**3. Type consistency.** `CommsSendClaims` `{effectDigest, planDigest, consentGeneration}` matches Plan 2's `InternalRequestAuthentication` claim names and its internalAuth tests. `executeCommsAction(input, sendClaims?)` is the name used in Tasks 12 (produces), 13 (rung 7), 16 (rung 8), and 17 (spy assertions). `releaseCommsSend(intentId: string): Promise<string>` is identical in the Produces block, the worker branch, and the parity/behavior tests. `M365_COMMS_HEADLESS_ACTIONS`/`isHeadlessM365CommsTool`/`HUMAN_IDENTITY_ONLY_TOOLS`/`M365_COMMS_TOOL_NAMES`/`m365CommsToolTiers` cross-reference consistently across Tasks 15/16 and both parity tests. `delegated_user_upn`/`delegatedUserUpn` and `plan_digest`/`planDigest` are used consistently in migrations, schema, service, endpoint, and renderer. The sentinel `'executor-owned:m365-comms-client-cert'` appears in decision 3, the promotion UPDATE, and the seeder. `commsCompleteConsentRequestSchema.claimedConsentGeneration` matches Plan 2's field name.

---

## Execution Handoff

Plan complete. **Do not execute until Plans 1 and 2 are executed and merged** (the baseline check block at the top). Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks. Tasks are strictly sequential; do not parallelize.

**2. Inline Execution** — `superpowers:executing-plans`, batch execution with checkpoints.

This is the last plan of the initiative. After it ships: the §8 replay defence (executor-side one-time claim on `intent.id`, cheap once the store exists) and the §12 master-spec amendments (flags 1–3, 7) remain recorded-but-unscheduled; the deploy itself follows the runbook's dark-launch sequence, which ends deliberately at one user.

