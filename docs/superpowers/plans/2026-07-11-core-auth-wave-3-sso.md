# Core Authentication Wave 3 SSO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce SSO role-delegation ceilings, bind pending callbacks to live provider/user sessions, require positively verified email, and route all OIDC/JWKS traffic through SSRF-safe transport.

**Architecture:** Provider configuration versions invalidate stale sessions. Link transactions bind Wave 1 auth epoch/session ID. A shared role-assignment service validates both save-time and JIT-time authority. OIDC discovery/token/UserInfo/JWKS use one bounded safe transport; JWKS bytes feed a local JOSE resolver so JOSE never performs direct network fetches.

**Tech Stack:** TypeScript, Hono, Drizzle/PostgreSQL, JOSE, Redis, Vitest.

## Global Constraints

- Require Wave 1 epochs/session-family liveness and Wave 2 AMR/IdP-MFA interfaces.
- Persist the admin who approved `defaultRoleId`; callback revalidates that admin's live delegable permissions.
- Delete existing pending SSO sessions in migration; no compatibility window.
- Remove `createRemoteJWKSet` from the SSO path.
- Generic OIDC requires explicit positive email verification.
- OIDC network work never occurs inside a held database transaction.
- HTTPS/public-network policy intentionally supersedes current self-host private-IdP fallback.
- Never log codes, tokens, assertions, client secrets, full discovery/JWKS bodies, or query strings.

---

### Task 1: Extract and pin shared role-assignment validation

**Files:**
- Create: `apps/api/src/services/roleAssignment.ts`
- Create: `apps/api/src/services/roleAssignment.test.ts`
- Modify: `apps/api/src/routes/users.ts`
- Modify: `apps/api/src/routes/users.test.ts`

**Interfaces:**
- Produces `assertRoleAssignable({ actorUserId, targetRoleId, axis })`.

- [ ] Write failing service tests for partner/org axis, cross-axis role, permission subset, disabled/offboarded actor, and valid delegation.
- [ ] Run RED: `corepack pnpm --dir apps/api exec vitest run src/services/roleAssignment.test.ts src/routes/users.test.ts --maxWorkers=1 --fileParallelism=false`.
- [ ] Move `getScopedRole`, effective-permission comparison, and `validateAssignableRole` behavior into the service without changing user-route outcomes.
- [ ] Run GREEN and commit with `refactor(auth): share role delegation validation`.

### Task 2: Add provider/session versions and approver binding

**Files:**
- Create: `apps/api/migrations/2026-07-11-c-core-auth-sso-hardening.sql`
- Modify: `apps/api/src/db/schema/sso.ts`
- Modify: `apps/api/src/routes/sso.test.ts`
- Test: `apps/api/src/db/autoMigrate.test.ts`

**Interfaces:**
- Adds `ssoProviders.configVersion`, `defaultRoleApprovedBy`.
- Adds `ssoSessions.providerVersion`, `linkAuthEpoch`, `linkSessionId`.

- [ ] Write failing schema/route fixture tests for required version and all-or-none link fields.
- [ ] Run RED on `src/routes/sso.test.ts` filtered to provider/session schema cases.
- [ ] Add idempotent SQL columns/FKs/check. Delete outstanding `sso_sessions` in a counted `DO $$` cleanup block. Add indexes for provider/version and link family lookup.
- [ ] Map Drizzle fields and update fixtures.
- [ ] Run GREEN, `corepack pnpm db:check-drift`, migration tests, and RLS coverage.
- [ ] Commit with `fix(sso): bind providers and pending sessions to versions`.

### Task 3: Enforce provider/link lifecycle and role authority

**Files:**
- Modify: `apps/api/src/routes/sso.ts`
- Modify: `apps/api/src/routes/sso.test.ts`
- Modify: `apps/api/src/services/authLifecycle.ts` only for reusable family-liveness read
- Modify: `apps/api/src/__tests__/integration/ssoPartnerLogin.integration.test.ts`

**Interfaces:**
- All SSO start paths persist provider version.
- Link starts persist user auth epoch and access `sid`.

- [ ] Add failing tests for inactive provider, changed version, link auth-epoch mismatch, revoked/expired/wrong-user family, changed tenant axis, approver downgrade/offboarding, and concurrent callback claim.
- [ ] Run RED on SSO route and integration files.
- [ ] On provider security/status/default-role updates, increment version and delete pending sessions transactionally; persist `defaultRoleApprovedBy` after `assertRoleAssignable`.
- [ ] On callback, atomically delete/return session, then recheck active provider/version before outbound HTTP. In link mode recheck user epoch, family, and tenant authority. Before JIT re-run assignability against the persisted live approver.
- [ ] Run GREEN and commit with `fix(sso): revalidate pending transactions and JIT roles`.

### Task 4: Require a positively verified OIDC identity

**Files:**
- Modify: `apps/api/src/services/sso.ts`
- Modify: `apps/api/src/services/sso.test.ts`
- Modify: `apps/api/src/routes/sso.ts`

**Interfaces:**
- Produces `resolveVerifiedOidcIdentity(idTokenClaims, userInfo, adapter)` returning only `emailVerified:true`.

- [ ] Write failing matrix tests: ID-token true/false/missing; UserInfo true/false/missing; source disagreement; subject mismatch; explicit string `"false"`; adapter-guaranteed provider; verified-domain/passwordless auto-link.
- [ ] Run RED: `corepack pnpm --dir apps/api exec vitest run src/services/sso.test.ts src/routes/sso.test.ts --maxWorkers=1 --fileParallelism=false`.
- [ ] Implement one email-source selector. Generic OIDC accepts only boolean true from the selected trusted source; preserve issuer/subject equality and domain gates.
- [ ] Run GREEN and commit with `fix(sso): require verified OIDC email identities`.

### Task 5: Introduce bounded SSRF-safe OIDC transport

**Files:**
- Create: `apps/api/src/services/oidcTransport.ts`
- Create: `apps/api/src/services/oidcTransport.test.ts`
- Modify: `apps/api/src/services/urlSafety.ts`
- Modify: `apps/api/src/services/urlSafety.test.ts`
- Modify: `apps/api/src/services/sso.ts`
- Modify: `apps/api/src/services/sso.test.ts`

**Interfaces:**
- Produces `fetchOidcJson(url, { endpointKind, maxBytes, timeoutMs, redirectLimit })`.
- Produces a cached local JOSE JWK resolver whose every refresh uses `fetchOidcJson`.

- [ ] Write failing transport tests for HTTP, credentials, non-443 port, private/reserved/literal/mapped IP, redirect to private IP, redirect loop/limit, DNS answer change, timeout, content type, oversized/invalid JSON.
- [ ] Write failing JWKS tests proving initial and unknown-`kid` refresh use the guarded transport and that `createRemoteJWKSet` is absent.
- [ ] Run RED on transport/urlSafety/SSO service suites.
- [ ] Implement the wrapper over `safeFetch` with manual revalidated redirects and bounded body reading. Fetch/validate JWKS JSON, pass bytes to `createLocalJWKSet`, cache by canonical URL/TTL, and refresh through the same wrapper.
- [ ] Migrate discovery, token exchange, UserInfo, and JWKS calls. Validate discovered endpoint origins before persistence and runtime use.
- [ ] Run GREEN and commit with `fix(sso): route OIDC traffic through SSRF-safe transport`.

### Task 6: Complete integration, UI errors, and Wave 3 verification

**Files:**
- Modify: `apps/api/src/__tests__/integration/ssoIdentityDedupeMigration.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/ssoProvidersPartnerRls.integration.test.ts`
- Modify: `apps/web/src/components/settings/SsoProviderForm.tsx` and tests only if stale-approval remediation is surfaced
- Modify: `apps/web/src/locales/en/settings.json`, `pt-BR/settings.json` as needed
- Modify: `CHANGELOG.md`

- [ ] Add real-DB callback/provider/version/family cases and ensure JIT/link writes remain atomic.
- [ ] Add UI handling for a role mapping that must be re-approved; do not expose internal rejection detail at public callback.
- [ ] Run focused gates:

```bash
corepack pnpm --dir apps/api exec vitest run src/services/roleAssignment.test.ts src/services/sso.test.ts src/services/urlSafety.test.ts src/services/oidcTransport.test.ts src/routes/sso.test.ts --maxWorkers=1 --fileParallelism=false
corepack pnpm --filter @breeze/api build
corepack pnpm db:check-drift
corepack pnpm --dir apps/api run test:rls-coverage
corepack pnpm --filter @breeze/web build
```

- [ ] Independently review callback claim ordering, approver semantics, all network callsites, JWKS cache refresh, secret redaction, and system/RLS contexts.
- [ ] Commit final tests/UI/release note with `docs(sso): document hardened identity lifecycle`.
