# Security Best Practices Review: Unpushed OAuth Commits

Date: 2026-04-24
Repository: `/Users/toddhebebrand/breeze`
Reviewed range: `origin/main..HEAD` (`main` ahead by 16 commits)
Scope: committed changes only; existing uncommitted worktree changes were not reviewed.

## Executive Summary

I reviewed the pending OAuth/MCP commits against the available JavaScript/TypeScript web guidance and general secure API/OAuth practices. The committed range materially improves security in several areas: JWT access-token revocation now verifies signatures before cache writes, revocation is client-bound, JWKS publication strips private JWK fields, refresh-token rotation is persisted, grant-wide revocation is checked by bearer auth, and integration test setup now has stronger database wipe guards.

I found two actionable issues before push. Follow-up implementation status: both have been remediated in the current worktree.

- **High, fixed:** `/oauth/token/revocation` buffered the raw request body in a route family that is explicitly skipped by the global body-size middleware.
- **Medium, fixed:** new OAuth RLS policies used broad `NULL`-tenant allow branches for persisted sessions/grants; these are now system-only.

I also noted one low-severity standards/test gap around accepting `400` for well-formed refresh-token revocation responses.

## High Severity

### SBF-2026-04-24-001: JWT revocation pre-handler buffers an uncapped OAuth request body

Rule ID: JS/TS-BACKEND-DOS-001
Status: Fixed in current worktree.

Location:

- `/Users/toddhebebrand/breeze/apps/api/src/index.ts:243`
- `/Users/toddhebebrand/breeze/apps/api/src/index.ts:245`
- `/Users/toddhebebrand/breeze/apps/api/src/routes/oauth.ts:88`
- `/Users/toddhebebrand/breeze/apps/api/src/routes/oauth.ts:93`

Evidence:

```ts
// apps/api/src/index.ts
if (c.req.path === '/oauth' || c.req.path.startsWith('/oauth/')) {
  return next();
}
```

```ts
// apps/api/src/routes/oauth.ts
oauthRoutes.use('/token/revocation', async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const raw = await c.req.raw.clone().text();
```

Impact:

An unauthenticated client can POST a large request body to `/oauth/token/revocation`; the new pre-handler calls `clone().text()`, which buffers the entire body before parsing. Because `/oauth/*` is skipped by the default `1MB` `bodyLimit`, this can create memory pressure or worker starvation. The global per-IP rate limit reduces request count, but it does not cap per-request memory, and the OAuth-specific limiter currently does not cover `/token/revocation`.

Fix:

Add a small explicit cap for `/oauth/token/revocation` before reading the body. Because oidc-provider needs the raw stream later, avoid middleware that consumes the original stream unless it preserves bridge compatibility. A practical minimal fix is:

- Reject requests with `Content-Length` above a small form limit, such as `16KB` or `64KB`.
- Add OAuth-specific route limiting for `POST /oauth/token/revocation`.
- If chunked requests must be accepted, enforce a streaming cap on the cloned request body before concatenating it.

Mitigation:

Keep upstream proxy body-size limits enabled for `/oauth/*`, but do not rely on edge limits as the only app-level control.

False positive notes:

If production ingress already hard-caps `/oauth/*` body size, exploitability is reduced, but that control is not visible in the committed app code. The app-level skip plus `clone().text()` remains a real hardening gap.

## Medium Severity

### SBF-2026-04-24-002: OAuth RLS policies expose `NULL`-tenant rows to non-system scopes

Rule ID: BREEZE-RLS-001
Status: Fixed in current worktree.

Location:

- `/Users/toddhebebrand/breeze/apps/api/migrations/2026-04-24-oauth-sessions-grants.sql:70`
- `/Users/toddhebebrand/breeze/apps/api/migrations/2026-04-24-oauth-sessions-grants.sql:72`
- `/Users/toddhebebrand/breeze/apps/api/migrations/2026-04-24-oauth-sessions-grants.sql:77`
- `/Users/toddhebebrand/breeze/apps/api/migrations/2026-04-24-oauth-sessions-grants.sql:81`
- `/Users/toddhebebrand/breeze/apps/api/migrations/2026-04-24-oauth-z-org-axis-coverage.sql:51`
- `/Users/toddhebebrand/breeze/apps/api/migrations/2026-04-24-oauth-z-org-axis-coverage.sql:55`
- `/Users/toddhebebrand/breeze/apps/api/src/oauth/adapter.ts:265`
- `/Users/toddhebebrand/breeze/apps/api/src/oauth/adapter.ts:269`

Evidence:

```sql
USING (account_id IS NULL OR account_id = breeze_current_user_id() OR breeze_current_scope() = 'system')
```

```sql
USING (
  breeze_current_scope() = 'system'
  OR partner_id IS NULL
  OR breeze_has_partner_access(partner_id)
)
```

```ts
await db.insert(oauthGrants).values({
  id,
  partnerId: null,
  orgId: null,
```

Impact:

The new persisted OAuth rows are high-entropy and not directly exposed by a generic API route, so this is not an immediate cross-tenant read by itself. Still, the policy shape weakens the database isolation boundary: any future user-scoped query against `oauth_sessions` can see anonymous rows, and any future user-scoped query against `oauth_grants` can see rows while `partner_id` is `NULL`. OAuth grant/session payloads are security-sensitive state and should not rely on unguessable IDs as their primary tenant boundary.

Fix:

Tighten `NULL` handling to system scope where the adapter needs it:

- For sessions: use `breeze_current_scope() = 'system' OR account_id = breeze_current_user_id()`.
- For grants: use `breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id) OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))`, and avoid `partner_id IS NULL` as a user-visible branch.
- Keep adapter reads/writes under `withSystemDbAccessContext`, which this implementation already does.

Mitigation:

If the broader RLS contract intentionally permits `NULL` bootstrap rows, document the exception and add tests proving no user-facing route can enumerate or mutate those rows.

False positive notes:

Current adapter paths use system DB context and IDs are high-entropy. This finding is defense-in-depth against future route/query drift, not proof of a current public endpoint leak.

## Low Severity

### SBF-2026-04-24-003: Integration test accepts `400` for well-formed refresh-token revocation

Rule ID: OAUTH-REVOCATION-001

Location:

- `/Users/toddhebebrand/breeze/apps/api/src/__tests__/integration/oauth-code-flow.integration.test.ts:298`
- `/Users/toddhebebrand/breeze/apps/api/src/__tests__/integration/oauth-code-flow.integration.test.ts:303`

Evidence:

```ts
// Both 200 (revoked) and 400 (already gone) prove the revocation chain
// works; assert we don't get 401/500.
expect([200, 400]).toContain(revokeRes.status);
```

Impact:

RFC 7009-style revocation endpoints should return `200` for well-formed revocation requests even when the token is already invalid or unknown, to avoid token probing semantics and simplify client retry behavior. The test currently normalizes `400` as acceptable, which can preserve a standards/interop regression.

Fix:

Normalize well-formed refresh-token revocation responses to `200` after the provider bridge, or update the adapter/bridge path so the provider does not emit `400` for already-revoked or unknown-but-well-formed tokens. Then tighten the integration test to require `200`.

Mitigation:

Because refresh tokens are high entropy, this is lower risk than the body-size issue. Treat it as an interoperability and information-disclosure cleanup.

## Positive Observations

- JWT access-token revocation verifies issuer, audience, algorithm, and signature before cache writes.
- The revocation pre-handler checks `client_id` binding before revoking a JWT access token.
- JWKS publication now strips private JWK fields through a shared helper.
- Bearer middleware checks both per-JTI and per-grant revocation markers.
- Redis read failures in bearer revocation checks fail closed.
- OAuth integration setup now refuses unsafe non-test database targets more aggressively.
