# Core Authentication Wave 5 API Principals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make human API keys obey their creator's live authority and add explicit organization-owned service principals for durable automation.

**Architecture:** API keys identify exactly one human or service principal while retaining `created_by` for audit. One uncached authority resolver validates key/org/principal/role/scope state before RLS. MCP, dev-push, and custom-field consumers use the same resolved principal rather than fabricating a user for service identities.

**Tech Stack:** TypeScript, Hono, Drizzle/PostgreSQL/RLS, Redis rate limiting, React, Vitest.

## Global Constraints

- Backfill every existing key as human-delegated; never infer service identity from key source/use.
- `source` remains issuance provenance, not principal type.
- Human authorization bypasses the five-minute permission cache and observes live membership/role state.
- Service principals use an organization-scoped role ceiling; per-key scopes remain a subset.
- `created_by` remains immutable audit provenance and is not runtime authority for service keys.
- All three API-key consumers—MCP, dev push, custom-field values—must share the resolver.
- Service principals have no login/password/MFA/SSO/recovery behavior.
- New tenant table gets enabled+forced RLS in its creating migration and real cross-org tests.

---

### Task 1: Add principal schema and RLS

**Files:**
- Create: `apps/api/migrations/2026-07-11-e-service-principals.sql`
- Create: `apps/api/src/db/schema/servicePrincipals.ts`
- Modify: `apps/api/src/db/schema/apiKeys.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/src/db/schema/servicePrincipals.test.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` only if required by auto-discovery contract
- Create: `apps/api/src/__tests__/integration/service-principals-rls.integration.test.ts`

**Interfaces:**
- Adds service principal org/name/status/role/audit timestamps.
- Adds key `principalType`, `principalUserId`, `servicePrincipalId` with exactly-one constraint.

- [ ] Write failing schema and real-RLS tests for cross-org select/insert/update/delete, role/org ownership, zero/two principals, and existing-key backfill.
- [ ] Run RED.
- [ ] Add idempotent migration: create direct-org table; enable/force RLS with `breeze_has_org_access(org_id)` policies; add human/service columns; backfill human from `created_by`; add FKs/check after backfill; report changed rows.
- [ ] Map/export Drizzle schema and run GREEN, migration reapply, drift, and RLS coverage.
- [ ] Commit with `fix(api-keys): add explicit human and service principals`.

### Task 2: Resolve live principal authority without cache

**Files:**
- Create: `apps/api/src/services/apiKeyPrincipal.ts`
- Create: `apps/api/src/services/apiKeyPrincipal.test.ts`
- Modify: `apps/api/src/services/apiKeyScopes.ts`
- Consolidate/remove: `apps/api/src/services/apiKeys.ts`
- Modify: `apps/api/src/services/index.ts`

**Interfaces:**
- Produces `resolveEffectiveApiKeyAuthority({ keyId, principal, requestedScopes })` with principal, org/partner, permissions/site limits, and allowed scopes.

- [ ] Write failing human tests: active success; disabled/invited/missing; org/partner membership removal; selected partner excludes org; tenant mismatch; unsupported scope; permission downgrade observed with warm cache/Redis unavailable; reactivation only when current authority is valid.
- [ ] Write failing service tests: active role success; disabled/missing; cross-org/wrong-scope role; role permission reduction; key scopes exceed role; creator offboarding does not affect service identity.
- [ ] Run RED.
- [ ] Implement fresh system-context joins for user/membership/role permissions and direct service-principal/role reads. Reuse `API_KEY_SCOPE_POLICIES` mapping but never `getUserPermissions` cached result as the security decision.
- [ ] Run GREEN and commit with `fix(api-keys): resolve live principal scope ceilings`.

### Task 3: Make middleware and every consumer principal-aware

**Files:**
- Modify: `apps/api/src/middleware/apiKeyAuth.ts`
- Modify: `apps/api/src/middleware/apiKeyAuth.test.ts`
- Modify: `apps/api/src/routes/mcpServer.ts`
- Modify: `apps/api/src/routes/mcpServer.test.ts`
- Modify: `apps/api/src/routes/mcpServer.orgKeyPartnerRole.test.ts`
- Modify: `apps/api/src/routes/mcpServer.effectiveTier.test.ts`
- Modify: `apps/api/src/routes/devPush.test.ts`
- Modify: `apps/api/src/routes/devices/customFieldValues.test.ts`
- Modify: `apps/api/src/services/mcpToolExecutionLedger.ts` and tests
- Modify: `apps/api/src/services/aiGuardrails.ts` only where it assumes user identity

**Interfaces:**
- `ApiKeyContext` carries discriminated `{type:'human',userId}|{type:'service',servicePrincipalId}` plus resolved permissions/site limits.

- [ ] Write failing shared-consumer tests proving the same offboarded human key fails MCP/dev-push/custom fields and a service principal is not treated as a fake user.
- [ ] Write failing MCP tests for API-key scope + live role ceiling + tool RBAC, site restrictions, and audit/ledger service identity.
- [ ] Run RED.
- [ ] Call the resolver once in middleware before RLS; build context from its result. Remove MCP's synthetic-user/current cached permission dependency and pass resolved authority through tool gates/audit ledger.
- [ ] Run GREEN and commit with `fix(api-keys): enforce principal authority across consumers`.

### Task 4: Add service-principal administration APIs

**Files:**
- Create: `apps/api/src/routes/servicePrincipals.ts`
- Create: `apps/api/src/routes/servicePrincipals.test.ts`
- Modify: `apps/api/src/routes/apiKeys.ts`
- Modify: `apps/api/src/routes/apiKeys.test.ts`
- Modify: `packages/shared/src/constants/permissions.ts`
- Modify: `apps/api/src/routes/permissionsCatalog.ts`
- Modify: `apps/api/src/routes/permissionsCatalog.test.ts`
- Modify: `apps/api/src/db/seed.ts`
- Modify: `apps/api/src/services/permissions.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Routes list/create/update/disable principals and issue/list/rotate/revoke child keys.
- Requires `api_keys:read|write`, org access, human auth, and MFA for mutations.

- [ ] Write failing route tests for unauthenticated, permission, MFA, wrong org/role, delegation subset, validation, conflict/not-found/error, cross-tenant, scope ceiling, one-time secret, rotation, disable-all-keys, and audit redaction.
- [ ] Run RED.
- [ ] Implement role validation with Wave 3 `assertRoleAssignable`; use `runAction`-compatible response shapes; make principal disable durable gate and child-key rotation/revocation transactional.
- [ ] Keep `/api-keys` human-only and expose principal type/owner; remove or route the unused duplicate mint helper through the canonical service.
- [ ] Run GREEN and commit with `feat(api-keys): add service principal administration`.

### Task 5: Add service-principal UI and migration guidance

**Files:**
- Modify: `apps/web/src/pages/settings/api-keys.astro`
- Modify: `apps/web/src/components/settings/ApiKeysPage.tsx`
- Modify: `apps/web/src/components/settings/ApiKeyForm.tsx`
- Modify: `apps/web/src/components/settings/ApiKeyList.tsx`
- Create: `apps/web/src/components/settings/ServicePrincipalForm.tsx`
- Create: `apps/web/src/components/settings/ServicePrincipalList.tsx`
- Create: focused component tests
- Modify: `apps/web/src/locales/en/settings.json`, `pt-BR/settings.json`

- [ ] Write failing UI tests for human/service labels, current backend scope catalog including `devices:execute` and `ai:execute_admin`, create/disable/rotate, one-time key display, permission gating, and `runAction` mutation feedback.
- [ ] Run RED.
- [ ] Implement components and update API-key form scope catalog from shared/server contract rather than stale hard-coded subset.
- [ ] Add guidance: offboarded human automation must be recreated as a least-privilege service principal; no automatic conversion.
- [ ] Run GREEN and commit with `feat(api-keys): manage explicit service principals`.

### Task 6: Verify Wave 5

- [ ] Run focused gates:

```bash
corepack pnpm --dir apps/api exec vitest run src/middleware/apiKeyAuth.test.ts src/services/apiKeyPrincipal.test.ts src/services/apiKeys.test.ts src/routes/apiKeys.test.ts src/routes/servicePrincipals.test.ts src/routes/devPush.test.ts src/routes/devices/customFieldValues.test.ts src/routes/mcpServer.orgKeyPartnerRole.test.ts src/routes/mcpServer.effectiveTier.test.ts --maxWorkers=1 --fileParallelism=false
corepack pnpm --filter @breeze/api build
corepack pnpm --filter @breeze/web build
corepack pnpm db:check-drift
corepack pnpm --dir apps/api run test:rls-coverage
```

- [ ] Run real-DB service-principal RLS/lifecycle tests and migration reapplication.
- [ ] Independently review uncached live authority, selected-org/site semantics, all consumers, service audit identity, scope/role intersections, creator deletion, and secret redaction.
- [ ] Update `CHANGELOG.md` with human-key enforcement and service-principal migration instructions; commit with `docs(api-keys): document principal lifecycle changes`.
