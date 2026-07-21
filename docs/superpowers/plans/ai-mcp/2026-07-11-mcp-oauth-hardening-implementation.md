# MCP & OAuth Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close findings MCP-OAUTH-01..12 per the approved design `docs/superpowers/specs/ai-mcp/2026-07-11-mcp-oauth-security-hardening-design.md` (read the matching section before each task).

**Architecture:** Centralized security helpers (effective-scope resolver, grant-family revocation service, refresh-token digest storage, MCP resource RBAC map, execution-org resolver, shared Tier 3 lifecycle wrapper) replacing today's duplicated inline paths. Everything fails closed on security-state uncertainty.

**Tech Stack:** Hono + TypeScript (apps/api), Drizzle/Postgres + hand-written SQL migrations, Redis revocation markers, oidc-provider, React (apps/web consent form), Vitest.

## Global Constraints

- Branch: `fix/mcp-oauth-security-hardening` in worktree `/Users/toddhebebrand/breeze/.worktrees/security-review-mcp-oauth-20260711`. NEVER `git stash`, never switch branches, never touch other worktrees. Commit only your own task's files.
- TDD (red-green) per step. Test files live alongside sources (`foo.ts` → `foo.test.ts`); real-DB tests go in `apps/api/src/__tests__/integration/*.integration.test.ts` and run via `corepack pnpm@10.33.4 --filter @breeze/api test:integration <file>` (test DB on :5433; default vitest config EXCLUDES integration dir).
- Fail-closed rules (design §Error Handling) are binding: missing durable grant tenancy blocks minting; policy lookup failure blocks scope issuance; unknown resource permission denies; revocation cache failure aborts disconnect/deletion; invalid DCR redirects reject the whole registration; ambiguous/mixed execution orgs reject before mutation; ledger-creation failure prevents Tier 3 execution.
- Migrations: `YYYY-MM-DD-<slug>.sql`, idempotent (`IF NOT EXISTS` / `DO $$` / pg_policies checks), NO inner `BEGIN;/COMMIT;`, cleanup UPDATE/DELETEs must `GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING` counts (even 0 matters — forensic trail). Never edit a shipped migration.
- User-facing OAuth/JSON-RPC errors stay generic; never log raw bearer tokens, auth codes, or callback credentials.
- Unit verification per task: `corepack pnpm@10.33.4 --filter @breeze/api test` (and `--filter @breeze/web test` for Task 8). TYPECHECK — there is NO `typecheck` npm script; use the exact CI commands: API = `corepack pnpm@10.33.4 exec tsc --noEmit --project apps/api/tsconfig.json`; web = `corepack pnpm@10.33.4 exec astro check` (run from repo root). Migration tasks also run `corepack pnpm@10.33.4 db:check-drift`.
- NOTE on the full API suite: `--filter @breeze/api test` has a documented pre-existing parallel-flakiness issue (`oauthInteraction.test.ts` 404/timeout cascade) that reproduces on the pristine tree under concurrent CPU load. When it flakes, re-run the FOCUSED covering test files for your task in isolation as the authoritative signal; do not attribute pre-existing flakes to your change, but never dismiss a failure in a file YOU modified without isolating it.
- Scope hygiene: do not refactor unrelated code; design §Non-Goals is binding.

**Ground-truth anchors (verified 2026-07-11, commit 61d8c6886):** adapter `apps/api/src/oauth/adapter.ts` (class line 185; refresh upsert ~219, find ~335-398, consume ~422, destroy ~445, Client destroy → `disabledAt` ~459, grant-meta cache ~39-114, `revokeByGrantId` ~539); provider `apps/api/src/oauth/provider.ts` (`ALL_MCP_SCOPES` ~229, `resolvePartnerIdForResourceServerInfo` ~239 [sync — the -02 bug], `resolveAllowedMcpScopes` ~271 [null partner → ALL scopes — the -01/-02 bug], `buildExtraTokenClaims` ~173, `getResourceServerInfo` ~409-454); consent `apps/api/src/routes/oauthInteraction.ts` (GET ~109, client meta ~144-170, POST ~173, displayed∩requested ~288-331, `prompt=login` fallback seeds displayed set from request params ~312-314, `setGrantBreezeMeta` ~345); partner policy `apps/api/src/oauth/partnerScopePolicy.ts` (~102, DB-error fails closed ~129); revocation cache `apps/api/src/oauth/revocationCache.ts` (jti + grant marker spaces, fail closed when Redis down); bearer middleware `apps/api/src/middleware/bearerTokenAuth.ts` (jti check ~239, grant check ~245, org-scoped ctx ~322-332 with `accessiblePartnerIds: [payload.partner_id]` — the -06 bug); disconnect `apps/api/src/routes/connectedApps.ts` (~54-146, refresh-row-driven — misses code-only grants, the -07 bug); other revocation call sites: `apps/api/src/oauth/grantRevocation.ts` (~30-85), `apps/api/src/oauth/lifecycle.ts` (`revokeUserOauthClient` ~316, ~340-386), `apps/api/src/routes/admin/abuse.ts` (~257), `apps/api/src/services/tenantLifecycle.ts` (~137,180) — ALL currently read `payload.jti`/`payload.grantId` from refresh rows; MCP server `apps/api/src/routes/mcpServer.ts` (dispatch ~763-791, bootstrap branch ~868-883, tools/call RBAC ~947, `executionOrgId` ~970, Tier-3 ledger ~972-995, audit ~1001-1058, bootstrap dispatch ~1143-1256, `resources/list` ~1262-1291, `dualAxisResourceCondition` ~1377-1390, `handleResourcesRead` ~1392-1526, `resolveDefaultOrgId` ~1551); guardrails `apps/api/src/services/aiGuardrails.ts` (`checkToolPermission` ~697-759, `TOOL_PERMISSIONS` ~712); exec-org `apps/api/src/routes/mcpExecutionOrg.ts` (`resolveMcpExecutionOrgId` ~36-51, `accessibleOrgIds[0]` fallback line 50 — the -05 bug); ledger `apps/api/src/services/mcpToolExecutionLedger.ts` (tenancy re-check ~64-69); invite funnel `apps/api/src/services/aiToolsFleetStatus.ts` (`computeInviteFunnel` ~44-110, partner-only filter line 58 — the -06 leak); DCR pre-handler `apps/api/src/routes/oauth.ts` (~94-224; redirect_uris validated by COUNT ONLY ~152-158 — the -08/-09 gap); consent form `apps/web/src/components/oauth/ConsentForm.tsx` (~230); refresh schema `apps/api/src/db/schema/oauth.ts` (~57-72), grants schema (~114-136).

---

### Task 1: Authoritative grant context + effective MCP scope policy (MCP-OAUTH-01, -02)

Design section: "1. Authoritative OAuth grant context and scope policy".

**Files:**
- Create: `apps/api/src/oauth/effectiveScopes.ts`, `apps/api/src/oauth/effectiveScopes.test.ts`
- Modify: `apps/api/src/oauth/provider.ts`, `apps/api/src/routes/oauthInteraction.ts` (+ their existing test files)

**Interfaces (Produces):**
```ts
// effectiveScopes.ts
export interface OAuthGrantContext { grantId: string; partnerId: string; orgId: string | null }
// Cache fast path via existing getGrantBreezeMetaAsync; cache miss loads oauth_grants row.
// Returns null when the grant row does not exist. Throws GrantTenancyError when the
// grant exists but has no durable partnerId (fail closed — token minting must abort).
export async function resolveGrantContext(grantId: string): Promise<OAuthGrantContext | null>
// Intersection of: ALL_MCP_SCOPES ∩ requested ∩ (displayed ?? requested-from-params NOT trusted:
// when displayed is undefined the caller must pass the server-side authoritative set) ∩ partner
// policy (getPartnerScopePolicy). partnerId null + grant present → throw. partnerId null +
// grantless client-only flow → documented legacy behavior (all provider-supported scopes).
export async function computeEffectiveMcpScopes(args: {
  requested: string[]; displayed?: string[]; partnerId: string | null; hasGrant: boolean;
}): Promise<string[]>
```

- [ ] **Step 1 (red):** Tests in `effectiveScopes.test.ts`: read-only partner policy reduces `['mcp:read','mcp:write','mcp:execute']` → `['mcp:read']`; `hasGrant: true` + `partnerId: null` throws; grantless client-only keeps all scopes; policy lookup DB error propagates (fail closed, no scope fallback); displayed set further intersects. Run — FAIL (module missing).
- [ ] **Step 2 (green):** Implement `effectiveScopes.ts` reusing `getPartnerScopePolicy` and `ALL_MCP_SCOPES` (export it from provider.ts if not already). Tests pass.
- [ ] **Step 3 (red):** Provider tests: after simulated restart (cleared grant-meta cache), resource-server scope calc resolves partner from `oauth_grants` (async) and applies current policy — narrowed policy cannot be escaped by refresh; grant with NULL partnerId in DB → token request rejected (structured OAuth error, generic client message).
- [ ] **Step 4 (green):** Make the resource-server scope path async: replace the sync `resolvePartnerIdForResourceServerInfo` fallback-to-null with `resolveGrantContext`; route `resolveAllowedMcpScopes` through `computeEffectiveMcpScopes`. `oidc-provider`'s `features.resourceIndicators.getResourceServerInfo` supports async — verify and use it. Remove the "null partner → all scopes" path for grant-bearing requests.
- [ ] **Step 5 (red):** Interaction tests: GET attaches per-partner effective scopes to each partner option; consent POST recomputes the intersection server-side — a POST claiming broader scopes than the selected partner's policy persists only the policy-allowed set, INCLUDING on the `prompt=login` single-step path (~312-314) where the displayed set currently equals the request's own scope param.
- [ ] **Step 6 (green):** Update `oauthInteraction.ts` GET/POST to call `computeEffectiveMcpScopes` with the selected partner; persist only the effective set in the grant.
- [ ] **Step 7:** Full `--filter @breeze/api test` + typecheck. Commit: `fix(oauth): authoritative grant tenancy + partner scope-policy intersection (MCP-OAUTH-01/02)`.

### Task 2: Central grant-family revocation service + call-site sweep (MCP-OAUTH-07, -10)

Design section: "3. Central grant-family and client revocation". **Must land BEFORE Task 3** — this task moves grant discovery off refresh-row `payload.jti`/`payload.grantId`, which Task 3 then stops persisting (jti) entirely.

**Files:**
- Create: `apps/api/src/oauth/revocationService.ts`, `apps/api/src/oauth/revocationService.test.ts`
- Modify: `apps/api/src/routes/connectedApps.ts`, `apps/api/src/oauth/adapter.ts` (Client `destroy`), `apps/api/src/oauth/lifecycle.ts`, `apps/api/src/oauth/grantRevocation.ts`, `apps/api/src/routes/admin/abuse.ts`, `apps/api/src/services/tenantLifecycle.ts`

**Interfaces (Produces):**
```ts
export type OAuthRevocationScope =
  | { kind: 'global' }
  | { kind: 'partner'; partnerId: string }
  | { kind: 'user'; userId: string; partnerId?: string };
// Discovery is oauth_grants-driven (refresh rows are supplemental). Ordering (fail closed):
// 1 resolve grants + active refresh rows; 2 write grant + jti Redis markers (throw on failure —
// caller returns 503, does NOT proceed); 3 transactionally stamp oauth_grants.revokedAt/
// revokedByUserId/revokedReason + refresh revokedAt; 4 partner scope: delete only that
// partner's oauth_client_partner_grants join row; 5 global scope only: set clients.disabledAt
// LAST, after all families revoked.
export async function revokeClientFamilies(clientId: string, scope: OAuthRevocationScope, opts?: { revokedByUserId?: string; reason?: string }): Promise<{ grants: number; refreshTokens: number }>
```

- [ ] **Step 1 (red):** Service tests: code-only grant (no refresh row) IS revoked under partner scope; partner-scope revoke leaves another partner's grants on the same shared DCR client untouched and its join row intact; Redis marker write failure aborts before any DB mutation; global scope revokes every family then disables the client; repeat call is a safe no-op (idempotent).
- [ ] **Step 2 (green):** Implement service (reuse `revocationCache.ts` `revokeGrant`/`revokeJti`; keep marker TTL ≥ access-token lifetime as existing cache does).
- [ ] **Step 3 (sweep):** Route ALL existing revocation paths through the service or grants-driven discovery — `connectedApps.ts` DELETE (partner scope), adapter Client `destroy` (global scope — this is registration-management DELETE), `lifecycle.revokeUserOauthClient` (user scope), `grantRevocation.ts` partner/org/user-wide helpers (used by `admin/abuse.ts`, `tenantLifecycle.ts`, user suspension, password change). After this task NOTHING reads `payload.jti` for discovery. `adapter.revokeByGrantId` may keep `payload->>'grantId'` matching (Task 3 preserves grantId in payload).
- [ ] **Step 4 (red→green):** Bearer-path test: already-minted access JWT with `grant_id` claim is rejected by grant marker immediately after global client deletion (existing checks at bearerTokenAuth ~239/245 — no new client-table query per request).
- [ ] **Step 5:** Full API test + typecheck. Commit: `fix(oauth): grants-driven revocation service; close code-only-grant and client-deletion gaps (MCP-OAUTH-07/10)`.

### Task 3: Hashed refresh-token storage + forced legacy revocation migration (MCP-OAUTH-04)

Design section: "2. Hashed refresh-token persistence and forced legacy revocation".

**Files:**
- Modify: `apps/api/src/oauth/adapter.ts` (+ `adapter.test.ts`)
- Create: `apps/api/migrations/2026-07-11-refresh-token-storage-hardening.sql`

**Interfaces (Produces, in adapter.ts):**
```ts
export function refreshTokenStorageId(rawId: string): string // sha256 hex lowercase of raw model id
export function sanitizeRefreshTokenPayload(payload: OidcPayload): OidcPayload // deep-copy minus jti; keeps grantId/exp/accountId/clientId/tenant fields
export function restoreRefreshTokenPayload(rawId: string, stored: OidcPayload): OidcPayload // re-adds jti: rawId in memory
```

- [ ] **Step 1 (red):** Adapter tests: upsert('RefreshToken', rawId, …) persists row id = 64-hex digest and payload WITHOUT `jti`; `find`/`consume`/`destroy` with the raw id resolve through the digest; `find` returns payload with `jti` restored to rawId; reuse detection (find on revoked row → `revokeGrant`) still fires through the digest; revocation-cache jti lookups for refresh tokens key on the digest.
- [ ] **Step 2 (green):** Implement the three helpers + transform raw IDs in every RefreshToken adapter op (upsert/find/consume/destroy/revocation-cache). Node `crypto.createHash('sha256')` — unkeyed is deliberate (high-entropy input; no key-rotation dependency).
- [ ] **Step 3 (migration):** Write `2026-07-11-refresh-token-storage-hardening.sql`, idempotent, no inner BEGIN/COMMIT:
```sql
-- Legacy plaintext refresh-token rows: revoke their grant families, then delete the rows.
-- NOTE: bearer auth checks Redis markers, not DB revokedAt — access JWTs minted just before
-- deploy remain valid up to their ~10-minute TTL. Accepted residual window (design §Rollout).
DO $$
DECLARE n_grants integer; n_tokens integer;
BEGIN
  UPDATE oauth_grants g SET revoked_at = now(), revoked_reason = 'refresh_token_storage_hardening'
  WHERE g.revoked_at IS NULL
    AND g.id IN (SELECT rt.payload->>'grantId' FROM oauth_refresh_tokens rt WHERE rt.id !~ '^[0-9a-f]{64}$');
  GET DIAGNOSTICS n_grants = ROW_COUNT;
  RAISE WARNING 'refresh-token hardening: revoked % legacy grant(s)', n_grants;
  DELETE FROM oauth_refresh_tokens WHERE id !~ '^[0-9a-f]{64}$';
  GET DIAGNOSTICS n_tokens = ROW_COUNT;
  RAISE WARNING 'refresh-token hardening: deleted % legacy refresh-token row(s)', n_tokens;
END $$;
ALTER TABLE oauth_refresh_tokens DROP CONSTRAINT IF EXISTS oauth_refresh_tokens_id_digest_chk;
ALTER TABLE oauth_refresh_tokens ADD CONSTRAINT oauth_refresh_tokens_id_digest_chk CHECK (id ~ '^[0-9a-f]{64}$');
ALTER TABLE oauth_refresh_tokens DROP CONSTRAINT IF EXISTS oauth_refresh_tokens_no_jti_chk;
ALTER TABLE oauth_refresh_tokens ADD CONSTRAINT oauth_refresh_tokens_no_jti_chk CHECK (NOT (payload ? 'jti'));
```
(Adjust column names to the actual schema — check `apps/api/src/db/schema/oauth.ts` for snake_case names; grants revocation columns are `revoked_at`/`revoked_by_user_id`/`revoked_reason`.)
- [ ] **Step 4:** Integration test (real DB): apply migration twice (idempotent no-op second time); plaintext-id insert now fails with CHECK violation; payload containing `jti` fails.
- [ ] **Step 5:** Full API test + typecheck + `db:check-drift`. Commit: `fix(oauth): digest refresh-token storage + legacy revocation migration (MCP-OAUTH-04)`.

### Task 4: Resource-specific MCP RBAC (MCP-OAUTH-03)

Design section: "4. Resource-specific MCP RBAC".

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts`, `apps/api/src/routes/mcpServer.ts` (+ their tests)

**Interfaces (Produces):**
```ts
// aiGuardrails.ts — extracted core reused by checkToolPermission:
export async function checkPermissionRequirement(auth: McpAuthContext, requirement: { resource: string; action: string }): Promise<string | null> // null = allowed, string = denial reason
// mcpServer.ts:
const MCP_RESOURCE_PERMISSIONS: Array<{ pattern: RegExp; permission: { resource: string; action: 'read' } }>
// breeze://devices, breeze://devices/{id} → devices.read; breeze://alerts → alerts.read;
// breeze://scripts → scripts.read; breeze://automations → automations.read
```

- [ ] **Step 1 (red):** Tests: for each of the five URIs, a role lacking the mapped `*.read` permission gets a JSON-RPC error and NO db query executes (spy on db); a role holding it succeeds; unknown URI family (`breeze://nonsense`) denied without a query; helper-session/`roleId === null` short-circuits preserved exactly as `checkToolPermission` does today (~706-710).
- [ ] **Step 2 (green):** Extract `checkPermissionRequirement` from `checkToolPermission` (~697-759) without behavior change to tools/call; wire it into `handleResourcesRead` (~1392) BEFORE site resolution or any query. `resources/list` may filter unreadable resources but `resources/read` is the enforcement boundary.
- [ ] **Step 3:** Full API test + typecheck. Commit: `fix(mcp): fail-closed resource RBAC for resources/read (MCP-OAUTH-03)`.

### Task 5: Organization/partner axis separation (MCP-OAUTH-06)

Design section: "5. Organization and partner axis separation".

**Files:**
- Modify: `apps/api/src/middleware/bearerTokenAuth.ts`, `apps/api/src/services/aiToolsFleetStatus.ts`, `apps/api/src/routes/mcpServer.ts` (`dualAxisResourceCondition` ~1377-1390) (+ tests)

**Key decisions (already adjudicated — implement as stated):**
- Org-scoped bearer db context (~322-332) becomes `accessiblePartnerIds: []`, keeping `currentPartnerId: payload.partner_id`. RLS ground truth: `breeze_has_partner_access` reads ONLY `accessible_partner_ids`; `currentPartnerId` feeds the separate read-only catalog SELECT branch (`breeze_current_partner_id()`) that exists ONLY on `scripts`, `alert_templates`, `script_categories`, `script_tags`.
- Consequence: partner-wide AUTOMATIONS rows become invisible to org-scoped bearers (no RLS read branch). This is INTENTIONAL — it aligns MCP with the REST route (`routes/automations.ts` ~496 gates the partner-wide branch to `auth.scope === 'partner'`). Gate `dualAxisResourceCondition`'s partner-wide branch on `auth.scope === 'partner'` for automations; scripts keep the dual branch for both scopes (REST `routes/scripts.ts` ~237-243 + RLS read branch support it). Add a code comment explaining the asymmetry.
- `computeInviteFunnel` gains the full auth context: org scope filters `deployment_invites` by the caller's `org_id`; partner scope keeps partner aggregation; malformed/ambiguous scope → reject (throw), not RLS-reliance.

- [ ] **Step 1 (red):** Tests: org-scoped bearer context has empty partner allowlist; Org A invite funnel excludes Org B rows (sibling-org regression per review); partner scope still aggregates partner-wide; org bearer still reads partner-wide scripts via catalog branch; org bearer no longer sees partner-wide automations resource rows.
- [ ] **Step 2 (green):** Implement the three modifications.
- [ ] **Step 3:** Full API test + typecheck. Commit: `fix(mcp): drop partner-axis allowlist from org-scoped bearers; org-filter invite funnel (MCP-OAUTH-06)`.

### Task 6: Authoritative MCP execution organization (MCP-OAUTH-05)

Design section: "7. Authoritative MCP execution organization".

**Files:**
- Modify: `apps/api/src/routes/mcpExecutionOrg.ts` (+ test), `apps/api/src/routes/mcpServer.ts` (tools/call integration ~970)

**Interfaces (Produces):**
```ts
// Replaces the sync accessibleOrgIds[0] fallback for device-targeted tools.
export async function resolveMcpExecutionContext(args: {
  auth: McpAuthContext; apiKey: ApiKeyContext | null; toolName: string; toolInput: Record<string, unknown>;
}): Promise<{ orgId: string } /* authoritative */ >
// throws McpExecutionOrgError (→ generic JSON-RPC invalid_params) when: devices span >1 distinct
// org; explicit toolInput.orgId conflicts with the devices' org; any device fails the existing
// org/site access gate. Org-scoped api key / bearer stays pinned to its org (input conflicting →
// reject). Non-device tools: keep existing behavior (explicit access-checked orgId, else current
// fallback) — attribution-only, unchanged by design.
```

- [ ] **Step 1 (red):** Tests: partner caller + device in Org B → context org = Org B (not `accessibleOrgIds[0]`); mixed-org device array rejected BEFORE ledger creation and handler execution; explicit `orgId` ≠ device org rejected; inaccessible device/site rejected; org-scoped bearer targeting a device outside its org rejected; single-device happy path.
- [ ] **Step 2 (green):** Implement using existing `deviceArgs` metadata (direct + array forms) and the existing device org/site access gate that downstream execution already uses (`aiToolsCisBenchmark.ts` pattern); wire into `handleToolsCall` so ledger (~977), audit (~1011), and handler all receive the same resolved org. Downstream re-checks remain (defense in depth).
- [ ] **Step 3:** Full API test + typecheck. Commit: `fix(mcp): authoritative device-org resolution for execution, ledger, audit (MCP-OAUTH-05)`.

### Task 7: Bootstrap RBAC + shared Tier 3 ledger/audit wrapper (MCP-OAUTH-11, -12)

Design section: "8. Bootstrap RBAC and shared Tier 3 ledger/audit lifecycle".

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts` (TOOL_PERMISSIONS entries), `apps/api/src/routes/mcpServer.ts` (extract wrapper from ~970-1069; bootstrap dispatch ~1143-1256), `apps/api/src/services/mcpToolExecutionLedger.ts` (if principal generalization needed) (+ tests)

**Pre-step investigation (do FIRST, report in your report file):** `beginMcpToolExecutionLedger` is today only called with an API-key principal (`mcpServer.ts` ~973 errors without `apiKey`). Bootstrap tools are reachable by OAuth bearers. Determine what ordinary Tier 3 tools do for OAuth bearers today and whether the ledger schema supports a non-apiKey principal; extend the ledger principal minimally if required (nullable apiKey + user/bearer attribution), or document why bootstrap-via-OAuth already carries an apiKey. Fail-closed: the wrapper must NEVER skip the ledger because the principal is inconvenient.

**Permission mappings (design-fixed):** `send_deployment_invites` → `devices.write`; `configure_defaults` → primary `organizations.write` plus `devices.write` and `alerts.write` (use `TOOL_EXTRA_PERMISSIONS` for the extras). Checks apply REGARDLESS of `MCP_REQUIRE_EXECUTE_ADMIN` (that setting stays as an additional gate).

- [ ] **Step 1 (red):** Tests: low-privilege member denied on both bootstrap tools with `MCP_REQUIRE_EXECUTE_ADMIN=false` + tool allowlisted; authorized role succeeds; registry parity test — every tool in `authTools` (see `apps/api/src/modules/mcpInvites/index.ts`) must have a `TOOL_PERMISSIONS` entry (fails if a future bootstrap tool omits one).
- [ ] **Step 2 (green):** Add mappings; call the permission check inside `dispatchBootstrapAuthTool` (~1143) before handler dispatch.
- [ ] **Step 3 (red):** Wrapper tests: ledger row created BEFORE handler runs (both bootstrap tools); ledger-creation failure prevents handler execution; success / thrown failure / partial-failure result (e.g. `sendDeploymentInvites` per-invite failures) complete the ledger with correct status + duration; uniform `mcp.tool.<name>` audit event on both outcomes; handler-specific business audits (configureDefaults ~255-275, per-invite events) still emitted; NO test asserts idempotency (design non-goal).
- [ ] **Step 4 (green):** Extract `runTier3ToolLifecycle(ctx, executeFn)` from the ordinary path (~970-1069); use it for ordinary AND bootstrap tools; classify bootstrap partial-failure results explicitly rather than treating any non-throw as success.
- [ ] **Step 5:** Full API test + typecheck. Commit: `fix(mcp): bootstrap tool RBAC + shared Tier 3 ledger/audit lifecycle (MCP-OAUTH-11/12)`.

### Task 8: DCR redirect validation + consent identity hardening (MCP-OAUTH-08, -09)

Design section: "6. DCR identity and redirect hardening".

**Files:**
- Create: `apps/api/src/oauth/redirectUriPolicy.ts`, `apps/api/src/oauth/redirectUriPolicy.test.ts`
- Modify: `apps/api/src/routes/oauth.ts` (~94-224), `apps/api/src/routes/oauthInteraction.ts` (client block ~144-170), `apps/web/src/components/oauth/ConsentForm.tsx` (~230) (+ web tests)

**Interfaces (Produces):**
```ts
// Pure — no I/O. Policy: HTTPS without credentials/fragments; HTTP only for literal 127.0.0.1
// or [::1] (any port); REJECT `localhost`, private-range hosts, public HTTP, protocol-relative,
// malformed, credentials, fragments, custom schemes. One invalid URI rejects the whole set.
export function validateRedirectUris(uris: unknown): { ok: true } | { ok: false; reason: string }
// Consent contract addition:
client: { client_id: string; display_name: string; verification: 'unverified'; redirect_uri: string; redirect_origin: string }
```

- [ ] **Step 1 (red):** Unit tests over the full design matrix: https ok; `http://127.0.0.1:49152/cb` ok; `http://[::1]:8080/cb` ok; `http://localhost/cb` rejected; `http://192.168.1.10/cb` rejected; `http://example.com/cb` rejected; `https://user:pw@x.com/cb` rejected; `https://x.com/cb#frag` rejected; `//x.com/cb` rejected; `not a url` rejected; `myapp://cb` rejected; mixed array (one bad) rejects all.
- [ ] **Step 2 (green):** Implement validator; apply in the DCR pre-handler for BOTH registration creation and registration-management update (verify how oidc-provider's PUT `/oauth/reg/:id` flows through `routes/oauth.ts` — if the pre-handler only covers POST, extend it to the management route).
- [ ] **Step 3 (red):** Integration test (real listener): remote-HTTP registration rejected; HTTPS registration succeeds (this is the live confirmation the review asked for on -09).
- [ ] **Step 4 (red→green, consent):** GET `/interaction/:uid` returns the `client` block above (redirect_origin = `new URL(redirect_uri).origin`); `ConsentForm.tsx` renders "Unverified integration" label, the exact callback origin, client_id — all client-controlled strings as ordinary escaped React text (test with a `<script>`-bearing display name). Fail-closed render if redirect metadata is missing.
- [ ] **Step 5:** API + WEB tests + both typechecks. Commit: `fix(oauth): DCR redirect-uri policy + unverified-client consent warning (MCP-OAUTH-08/09)`.

**Rollout caveat (record in PR body, not code):** rejecting `localhost` (while keeping loopback IPs) follows RFC 8252 §7.3 but has broken real MCP clients before (#2193). Before deploy, verify Claude (hosted callback is HTTPS) and mcp-remote (loopback IP) against a staging registration.

### Task 9: Full verification pass

- [ ] Run, in the worktree root: `corepack pnpm@10.33.4 --filter @breeze/api test`, `--filter @breeze/web test`, `--filter @breeze/api typecheck`, `--filter @breeze/web typecheck`, `corepack pnpm@10.33.4 db:check-drift`.
- [ ] Run integration suites against the :5433 test DB: OAuth integration tests, the new migration idempotency test, live DCR registration regression, and the RLS coverage contract (`corepack pnpm@10.33.4 --filter @breeze/api test:integration`).
- [ ] Fix anything red (each fix red-green, committed). No commit of unrelated changes.
