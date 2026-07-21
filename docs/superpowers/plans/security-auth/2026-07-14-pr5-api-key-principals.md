# PR 5 — API-Key Principals: Live Creator Authorization + Service Principals (SR2-15)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope:** SR2-15 from `docs/superpowers/specs/security-auth/2026-07-11-core-authentication-hardening-design.md` — "Human-delegated API keys cannot outlive the creator's authority. Non-human automation uses an explicit service principal."

**Goal:** A human-delegated API key must (a) stop working the moment its creator loses the tenant MEMBERSHIP its authority derives from, and (b) never grant MORE than the creator CURRENTLY holds — its effective authority is re-clamped to the creator's live permissions on every request, not the permissions frozen at mint time. Then: introduce explicit, opt-in **service principals** so legitimate automation owned by an off-boarded human can be migrated to a first-class non-human identity rather than silently surviving on a dead human's authority.

**Architecture:**
- **Live authorization (the security core, Tasks 1-3).** Both API-key entry points — the REST middleware `apiKeyAuth.ts` and the MCP/AI path `mcpServer.ts buildAuthFromApiKey` — resolve the creator's CURRENT permissions on every request via the existing, already-cache-invalidated `getUserPermissions(createdBy, { orgId, partnerId })`. A `null` result means "creator has no live membership/role on either axis for this key's tenant" and **denies the request** (this simultaneously enforces the membership gate AND fails closed). A non-null result is then re-clamped: the key's stored `scopes` are re-run through the existing mint-time ceiling check `validateApiKeyScopeDelegation(scopes, currentPermissions)`; if the creator's permissions have dropped below any stored scope, the request is denied. The creator's live `allowedSiteIds` (site-axis restriction) is applied to the request the same way the JWT path applies it.
- **Recommendation on the design fork (live re-resolution vs. epoch invalidation): LIVE RE-RESOLUTION.** `getUserPermissions` is already Redis-version-cached with a 5-minute TTL and is already invalidated (`clearPermissionCache` / version bump) by every membership/role mutation site (`routes/users.ts`, `routes/accessReviews.ts`, `routes/roles.ts`). Live re-resolution therefore costs at most one cached read on the hot path yet is always correct, catches out-of-band SQL changes a new epoch column would miss, and adds no schema. See Open Question Q1 — flagged for the controller.
- **Service principals (Tasks 4-5).** A new `service_principals` table (org-owned, RLS shape-1) plus `principal_type` / `principal_id` columns on `api_keys`. Service-principal keys carry their own independently-assigned scope ceiling and are authorized against the *principal's* lifecycle (active/disabled) and scopes, NOT against a human creator's live membership. Existing keys are all `principal_type='human'` and remain governed by the live-creator resolver. No human key is silently converted.

**Tech Stack:** Hono (TypeScript), Drizzle ORM, PostgreSQL (RLS via `breeze_app`), Redis (ioredis), Vitest.

---

## Open Questions / Plan Conflicts — ADJUDICATE BEFORE EXECUTION

**Q1 — Live re-resolution vs. epoch/invalidation (the real design fork). PLAN DEFAULT: live re-resolution. RECOMMENDED.**
The design says "re-clamp to the creator's CURRENT permissions" without specifying mechanism.
- *Live re-resolution* (this plan): every API-key request calls `getUserPermissions(createdBy, …)` and re-clamps. Pros: always correct (including out-of-band `DELETE FROM organization_users` / role edits done in SQL that never call an app service — the design explicitly wants these caught, invariant §4/§5); reuses machinery already built and already cache-invalidated; **zero new schema**; a permission reduction takes effect within the 5-minute permission-cache TTL at worst, immediately once `clearPermissionCache` fires. Cons: one extra cached read on the hot path (bounded; see the per-request cost note in Task 2).
- *Epoch/invalidation* (rejected default): add a `principal_epoch` (or reuse `users.auth_epoch`) and stamp the key at mint; bump on membership/permission change; reject on mismatch. Pros: a single integer compare on the hot path. Cons: needs a NEW advance-site at every membership/role/permission mutation (org_users, partner_users, role_permissions edits — many sites, easy to miss one → fail-OPEN); `users.auth_epoch` (PR 1) advances on password/status/email changes that should NOT necessarily kill an API key, and does NOT advance on a pure role/site-scope reduction, so it is the wrong signal; an out-of-band SQL change bumps no epoch at all. An epoch is strictly worse for *this* invariant.
**RECOMMENDATION: ship live re-resolution.** If the overseer wants the epoch approach for hot-path cost reasons, STOP — Tasks 1-3 change shape and a new migration + a fan-out of advance-sites is required.

**Q2 — `services/roleAssignment.ts` does NOT exist in this worktree.** The task brief asserted "PR 3 extracted the permission-ceiling logic into `services/roleAssignment.ts`." Verified false: `find apps/api/src -iname '*roleAssign*'` → nothing; PR 3 in this repo was the SSO/email work (commits `1021001ec`, `633bd4a75`, …), not a role-assignment extraction. **The permission-ceiling machinery this PR reuses actually lives in `apps/api/src/services/apiKeyScopes.ts`** (`validateApiKeyScopeDelegation(requestedScopes, creatorPermissions)`), already used at mint time in `routes/apiKeys.ts:84`. This plan builds on `apiKeyScopes.ts`. No `roleAssignment.ts` is created or referenced.

**Q3 — What exactly did PR 1 already ship (do NOT redo).** PR 1 (#2378) shipped the **creator-STATUS** half of SR2-15 only, in `apps/api/src/middleware/apiKeyAuth.ts:148-163`: after the key lookup and the `getActiveOrgTenant` owner check, it reloads `users.status` for `apiKey.createdBy` under `withSystemDbAccessContext` and throws `401 "API key creator is not active"` when the creator is missing or not `active`. Its guard-biting tests already exist in `apps/api/src/middleware/apiKeyAuth.test.ts` ("rejects when API key creator is disabled", "rejects when API key creator lookup returns no row", and the fail-closed-on-throw case "fails closed (rejects, does not call next) when the creator-status lookup throws"). **Do NOT re-plan the status check.** This PR ADDS the membership + permission-ceiling gates alongside it (Task 2 extends this same block) and fixes the MCP fail-open (Task 3).

**Q4 — The MCP/AI path is the prime fail-OPEN, and it is DIFFERENT code from the REST middleware.** `mcpServer.ts buildAuthFromApiKey` (`:1852-1867`) already calls `getUserPermissions(apiKey.createdBy, …)` but does `const allowedSiteIds = creatorPerms?.allowedSiteIds;` — when `creatorPerms` is `null` (creator off-boarded → no membership row → `getUserPermissions` returns `null`), `allowedSiteIds` becomes `undefined`, and `siteAccessCheck(undefined)` returns `true` for EVERY site (`middleware/auth.ts:112` `if (!allowedSiteIds) return true;`). So a key whose creator has lost all authority is currently treated as **unrestricted** on the MCP path. Task 3 fixes this: `null` perms must DENY. The design calls this out by name ("`getUserPermissions` returning null leading to `allowedSiteIds = undefined` … is a fail-open bug that this PR fixes").

**Q5 — Which axis does each key type derive authority from? Both must be checked.**
- **Manual (user-minted) keys** carry `org_id` (org axis) but `apiKeyAuth` deliberately withholds partner-axis RLS visibility from them. Their creator's role, however, may live on the PARTNER axis (a Partner Admin has NO `organization_users` row for the key's org). Therefore the resolver MUST pass BOTH `orgId` AND the org's owning `partnerId` to `getUserPermissions`, which resolves org-axis first then partner-axis. Checking only the org axis would silently break every partner-admin-minted key (false deny) — and worse, a naive "no org_users row ⇒ deny" without the partner axis is asymmetric with the current MCP code which already resolves the partner via `getActiveOrgTenant`.
- **`mcp_provisioning` keys** derive from the PARTNER axis (partner-admin role); `apiKeyAuth` already resolves `ownerTenant.partnerId` for them.
The org's owning partner is already in hand as `ownerTenant.partnerId` (from the existing `getActiveOrgTenant(apiKey.orgId)` call at `apiKeyAuth.ts:143`). Task 1's resolver takes both ids.

**Q6 — Service-principal ownership axis.** Per the "partner-wide-first" policy and the design's "declare ownership axis explicitly with justification": this plan makes `service_principals` **org-owned** (single `org_id` FK, RLS shape-1) to exactly mirror the existing `api_keys` tenancy (`api_keys.org_id`), so a service-principal key reuses the identical org-scoped RLS context the middleware already establishes. Partner-wide service principals are OUT OF SCOPE for this PR (a partner-wide principal would need dual-axis RLS and a partner-scoped issuance UI). If the overseer wants dual-axis service principals now, say so — Task 4's schema + RLS shape change and it must be added to `DUAL_AXIS_TENANT_TABLES` instead of relying on org_id auto-discovery.

**Q7 — Does a permission reduction *revoke* the key or just *clamp* it?** The design says "re-clamped to the creator's CURRENT permissions." Plan default: **clamp at request time, do not mutate the row.** A creator whose permissions are later restored gets the key working again automatically. The key is only durably set to `status='revoked'` by an explicit admin action or by service-principal migration (Task 5), never by the auth path. This matches the existing expiry-flip precedent (`apiKeyAuth.ts:131-141` flips to `expired` only on a hard expiry, an irreversible condition) — a permission dip is reversible, so we do not persist it. Confirm.

---

## Global Constraints

- **Node 22.20.0.** Prefix every `pnpm`/`node` command with `export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"` (no version manager is installed; the pinned binary lives there).
- **The API connects to Postgres as unprivileged `breeze_app`.** `withSystemDbAccessContext` inside a request WITHOUT `runOutsideDbContext()` first is a SILENT NO-OP (`withDbAccessContext` early-returns when a context is already active); a contextless / wrong-connection read of a FORCE-RLS table returns 0 rows. **Any security decision derived from "0 rows → no membership / no permissions → allow" is a FAIL-OPEN.** The API-key auth path is the prime spot for this: the creator membership/permission re-resolution MUST run in the correct context and MUST fail CLOSED on an empty/errored read. Every new gate in this PR FAILS CLOSED — each task states its fail-closed rule explicitly. (Concretely: `apiKeyAuth` runs the creator reads inside `withSystemDbAccessContext` BEFORE it opens the org-scoped request context — correct; `getUserPermissions` internally escalates blind axes via `runOutsideDbContext` → `withSystemDbAccessContext`, so it is safe to call from either the pre-context middleware or the MCP path; a thrown error or a `null` result DENIES.)
- **Dual-axis tenancy.** A principal reaches resources via `organization_users` (org axis) OR `partner_users` (partner axis); partner admins typically have NO org row. Every membership check in this PR passes BOTH the key's `orgId` and the org's owning `partnerId` to `getUserPermissions`. A gate that only consults the org axis silently breaks partner-scoped keys (see Q5). State the axis per task.
- **Migrations are hand-written idempotent SQL only**, in `apps/api/migrations/`, named `YYYY-MM-DD-<slug>.sql`, applied in `localeCompare` order. The latest shipped file is `2026-07-18-pending-email-and-verification-purpose.sql`, so this PR's migration MUST sort after it (use `2026-07-19-*` or later). `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` / `DO $$ … END $$` guards; re-applying must be a no-op. **No inner `BEGIN;`/`COMMIT;`** — the runner wraps each file in a transaction. **Never edit a shipped migration.** Never `drizzle-kit generate`/`push`. Run `pnpm db:check-drift` (with `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"`) after schema edits.
- **RLS / tenant isolation.** The new `service_principals` table (Task 4) carries an `org_id` column, so the coverage contract-test auto-discovers it as a shape-1 org-tenant table (exactly like `api_keys`, which carries no explicit allowlist entry). Its creating migration MUST enable + FORCE RLS and ship a `breeze_has_org_access(org_id)` policy in the same file. If — and only if — you make it dual-axis (Q6), add it to `DUAL_AXIS_TENANT_TABLES` in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`. The `api_keys` `principal_type`/`principal_id` columns (Task 4) add no table and change no policy.
- **Every security gate needs a GUARD-BITING test** — a test that provably goes RED if the protection is deleted. A test that would still pass with the guard gone is vacuous and does not count. Each task names its guard-bite test.
- **Test-mock hazard.** `apps/api/src/middleware/apiKeyAuth.test.ts` uses hand-rolled Drizzle mocks. It ALREADY primes an ordered TWO-select queue via `buildSequentialSelectMock([...])` because PR 1 added the creator-status `db.select`. Task 2 does NOT add a third `db.select` to the middleware (it calls `getUserPermissions`, which this test mocks at the module boundary) — but if any task adds a `db.select`, re-prime the queue; NEVER delete assertions to make it pass. `mcpServer.*.test.ts` suites mock `getUserPermissions` from `../services/permissions` — Task 3 flips a mocked return to `null` to drive the fail-closed case.
- **Reuse existing machinery, do not reinvent.** `services/apiKeyScopes.ts` `validateApiKeyScopeDelegation` is the permission-ceiling check (used at mint in `routes/apiKeys.ts:84`); `services/permissions.ts` `getUserPermissions` is the cached, version-invalidated live-permission resolver; `services/tenantStatus.ts` `getActiveOrgTenant` already yields the org's `partnerId`. There is NO `roleAssignment.ts` (Q2). PR 1's `authLifecycle.ts` epoch machinery is NOT used here (Q1: epochs are the wrong signal for a role/site reduction).
- **Audit events never contain raw API keys, tokens, or credential material.** Service-principal audit records the principal id + actor, never a key hash or raw key.
- **Commit after each green task.** TDD: write the failing test, observe the reviewed failure, then implement.

---

## File Structure

**Create**
- `apps/api/src/services/apiKeyAuthorization.ts` — the shared live-creator authorization resolver (Task 1).
- `apps/api/src/services/apiKeyAuthorization.test.ts` (Task 1).
- `apps/api/migrations/2026-07-19-service-principals.sql` — `service_principals` table + RLS + `api_keys.principal_type`/`principal_id` (Task 4).
- `apps/api/src/db/schema/servicePrincipals.ts` (Task 4).
- `apps/api/src/services/servicePrincipals.ts` + `.test.ts` — create / rotate / disable / authorize (Task 5).
- `apps/api/src/routes/servicePrincipals.ts` + `.test.ts` — issuance/rotation/disablement/migration routes (Task 5).
- `apps/api/src/__tests__/integration/apiKeyPrincipals.integration.test.ts` — real-DB membership-removal + permission-reduction + partner-axis + fail-closed coverage (Task 6).

**Modify**
- `apps/api/src/middleware/apiKeyAuth.ts` — call the resolver after the creator-status check; carry clamped scopes + `allowedSiteIds` into `ApiKeyContext` (Task 2).
- `apps/api/src/routes/mcpServer.ts` — `buildAuthFromApiKey` denies on `null` perms and re-clamps scopes (Task 3).
- `apps/api/src/db/schema/apiKeys.ts` — `principalType`, `principalId` columns (Task 4).
- `apps/api/src/db/schema/index.ts` / `apps/api/src/services/index.ts` — export the new schema/service.
- `apps/api/src/index.ts` — mount the service-principals route (Task 5).

---

### Task 1: Shared live-creator authorization resolver

**Files:**
- Create: `apps/api/src/services/apiKeyAuthorization.ts`
- Test: `apps/api/src/services/apiKeyAuthorization.test.ts`

**Interfaces:**
- Consumes: `getUserPermissions` (`services/permissions.ts:87`), `validateApiKeyScopeDelegation` (`services/apiKeyScopes.ts:73`), `UserPermissions`.
- Produces:
  ```ts
  export type ApiKeyAuthorizationResult =
    | { ok: true; permissions: UserPermissions; allowedSiteIds: string[] | undefined; clampedScopes: string[] }
    | { ok: false; reason: 'no_membership' | 'scope_exceeds_current_permissions'; detail?: Record<string, unknown> };

  export async function authorizeHumanApiKeyCreator(input: {
    createdBy: string;
    orgId: string;
    partnerId: string | null;   // the org's owning partner, for partner-axis role resolution (Q5)
    scopes: string[];
  }): Promise<ApiKeyAuthorizationResult>;
  ```
- **Fail-closed rule:** `getUserPermissions` returning `null` (no live membership/role on EITHER axis → the off-boarding gate) OR throwing (DB/RLS error) DENIES with `reason:'no_membership'`. A stored scope the creator no longer holds DENIES with `reason:'scope_exceeds_current_permissions'`. There is no code path where an empty/errored read yields `ok:true`.
- **Axis (Q5):** passes BOTH `orgId` and `partnerId` so `getUserPermissions` resolves org-axis first, then partner-axis (partner-admin keys with no org row).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/apiKeyAuthorization.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./permissions', () => ({
  getUserPermissions: vi.fn(),
}));

import { authorizeHumanApiKeyCreator } from './apiKeyAuthorization';
import { getUserPermissions } from './permissions';
import type { UserPermissions } from './permissions';

// A creator who holds devices:read + devices:write on the org axis.
const fullPerms: UserPermissions = {
  permissions: [
    { resource: 'devices', action: 'read' },
    { resource: 'devices', action: 'write' },
  ],
  partnerId: null,
  orgId: 'org-1',
  roleId: 'role-1',
  scope: 'organization',
  allowedSiteIds: ['site-a'],
} as UserPermissions;

describe('authorizeHumanApiKeyCreator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('authorizes when the creator still holds every stored scope, returning live allowedSiteIds', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(fullPerms);
    const res = await authorizeHumanApiKeyCreator({
      createdBy: 'user-1', orgId: 'org-1', partnerId: 'partner-1', scopes: ['devices:read', 'devices:write'],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.allowedSiteIds).toEqual(['site-a']);
      expect(res.clampedScopes).toEqual(['devices:read', 'devices:write']);
    }
    // Both axes offered so a partner-admin creator (no org row) still resolves.
    expect(getUserPermissions).toHaveBeenCalledWith('user-1', { orgId: 'org-1', partnerId: 'partner-1' });
  });

  it('DENIES (no_membership) when the creator has no live membership on either axis (null perms) — the off-boarding gate and the fail-closed rule', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(null);
    const res = await authorizeHumanApiKeyCreator({
      createdBy: 'user-1', orgId: 'org-1', partnerId: 'partner-1', scopes: ['devices:read'],
    });
    expect(res).toEqual({ ok: false, reason: 'no_membership' });
  });

  it('DENIES (scope_exceeds_current_permissions) when the creator no longer holds a stored scope (permission reduction re-clamp)', async () => {
    const reduced = { ...fullPerms, permissions: [{ resource: 'devices', action: 'read' }] } as UserPermissions;
    vi.mocked(getUserPermissions).mockResolvedValue(reduced);
    const res = await authorizeHumanApiKeyCreator({
      createdBy: 'user-1', orgId: 'org-1', partnerId: 'partner-1', scopes: ['devices:read', 'devices:write'],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('scope_exceeds_current_permissions');
  });

  it('FAILS CLOSED (no_membership) when the permission read THROWS (DB/RLS error), never authorizing', async () => {
    vi.mocked(getUserPermissions).mockRejectedValue(new Error('RLS/DB down'));
    const res = await authorizeHumanApiKeyCreator({
      createdBy: 'user-1', orgId: 'org-1', partnerId: 'partner-1', scopes: ['devices:read'],
    });
    expect(res).toEqual({ ok: false, reason: 'no_membership' });
  });
});
```

Guard-bite: the third test goes RED if the scope re-clamp is removed; the second + fourth go RED if `null`/throw is ever treated as authorize. **All four are required** — dropping any one leaves a fail-open reachable.

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/apiKeyAuthorization.test.ts
```
Expected: FAIL — cannot find module `./apiKeyAuthorization`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/apiKeyAuthorization.ts`:

```ts
import { getUserPermissions, type UserPermissions } from './permissions';
import { validateApiKeyScopeDelegation } from './apiKeyScopes';

/**
 * SR2-15 live authorization for HUMAN-delegated API keys.
 *
 * A human key's authority is DELEGATED from its creating user and must never
 * outlive that user's authority. On every request we re-resolve the creator's
 * CURRENT permissions and:
 *   1. DENY if the creator has no live membership/role on the key's tenant
 *      (getUserPermissions returns null when neither the org nor the partner
 *      axis yields a role row) — this is both the off-boarding/membership gate
 *      and the fail-closed rule for a contextless/errored read.
 *   2. RE-CLAMP the key's stored scopes against those live permissions; a scope
 *      the creator no longer holds DENIES (a permission reduction after mint
 *      cannot be out-run by a key minted while the creator was more powerful).
 *
 * We resolve LIVE rather than trusting a mint-time snapshot or an epoch: the
 * design requires catching out-of-band membership/role SQL changes that call no
 * app service, and getUserPermissions is already Redis-version-cached and
 * invalidated by every in-app membership/role mutation, so this is cheap and
 * always correct. See the PR 5 plan Q1.
 *
 * Axis (Q5): BOTH orgId and the org's owning partnerId are offered so a
 * Partner-Admin creator (who has NO organization_users row for the key's org,
 * only a partner_users row) still resolves.
 */
export type ApiKeyAuthorizationResult =
  | { ok: true; permissions: UserPermissions; allowedSiteIds: string[] | undefined; clampedScopes: string[] }
  | { ok: false; reason: 'no_membership' | 'scope_exceeds_current_permissions'; detail?: Record<string, unknown> };

export async function authorizeHumanApiKeyCreator(input: {
  createdBy: string;
  orgId: string;
  partnerId: string | null;
  scopes: string[];
}): Promise<ApiKeyAuthorizationResult> {
  let permissions: UserPermissions | null;
  try {
    permissions = await getUserPermissions(input.createdBy, {
      orgId: input.orgId,
      partnerId: input.partnerId ?? undefined,
    });
  } catch {
    // FAIL CLOSED: a DB/RLS error is indistinguishable from "no access" and
    // must never be read as "unrestricted".
    return { ok: false, reason: 'no_membership' };
  }

  if (!permissions) {
    return { ok: false, reason: 'no_membership' };
  }

  // Re-clamp: the stored scopes must still be fully backed by the creator's
  // CURRENT permissions. validateApiKeyScopeDelegation returns ok:false (403)
  // for any scope whose required permission the creator no longer holds.
  const delegation = validateApiKeyScopeDelegation(input.scopes, permissions);
  if (!delegation.ok) {
    return {
      ok: false,
      reason: 'scope_exceeds_current_permissions',
      detail: { error: delegation.error, ...(delegation.details ?? {}) },
    };
  }

  return {
    ok: true,
    permissions,
    allowedSiteIds: permissions.allowedSiteIds,
    clampedScopes: delegation.scopes,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/apiKeyAuthorization.test.ts
```
Expected: PASS.

- [ ] **Step 5: Export + commit**

Add `export { authorizeHumanApiKeyCreator } from './apiKeyAuthorization';` and the `ApiKeyAuthorizationResult` type to `apps/api/src/services/index.ts`.

```bash
git add apps/api/src/services/apiKeyAuthorization.ts apps/api/src/services/apiKeyAuthorization.test.ts apps/api/src/services/index.ts
git commit -m "feat(api-keys): live creator membership + permission-ceiling resolver (SR2-15)"
```

---

### Task 2: Enforce live creator authorization in the REST middleware

**Files:**
- Modify: `apps/api/src/middleware/apiKeyAuth.ts` (after the creator-status block at `:148-163`; context set at `:219-229`)
- Test: `apps/api/src/middleware/apiKeyAuth.test.ts`

**Interfaces:**
- Consumes: `authorizeHumanApiKeyCreator` (Task 1), `ownerTenant.partnerId` (already resolved at `apiKeyAuth.ts:143`).
- Produces: after the existing creator-status check, the middleware calls the resolver with `{ createdBy: apiKey.createdBy, orgId: apiKey.orgId, partnerId: ownerTenant.partnerId, scopes: apiKey.scopes ?? [] }`. On `ok:false` it throws `401 { message: 'API key creator is no longer authorized' }`. On `ok:true` it sets `c.set('apiKey', { … scopes: result.clampedScopes, allowedSiteIds: result.allowedSiteIds })` — the request now carries the LIVE-clamped scopes + site restriction, not the frozen row values. Add `allowedSiteIds?: string[]` to `ApiKeyContext['apiKey']`.
- **Fail-closed rule:** the resolver already fails closed; the middleware treats every `ok:false` (and never swallows a throw) as a 401 BEFORE calling `next()` / opening the org context. **Axis:** org + org's-partner via `ownerTenant.partnerId` (Q5).
- **Per-request cost note (embed as a comment):** this adds one `getUserPermissions` call to the hot API-key path. That call is Redis-version-cached (5-min TTL) and, on a cache hit, is a single Redis `mget` + in-process lookup — no Postgres round-trip. On a cache miss it does the same membership/role reads the JWT request path already does. Correctness/fail-closed first (Q1); if profiling later shows this is hot, a short per-`(keyId, permissionVersion)` memo is the follow-up, NOT an epoch.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/middleware/apiKeyAuth.test.ts`, add `vi.mock('../services/apiKeyAuthorization', () => ({ authorizeHumanApiKeyCreator: vi.fn() }));` at the top with the other mocks, import the mocked fn, and in `beforeEach` default it to authorize: `vi.mocked(authorizeHumanApiKeyCreator).mockResolvedValue({ ok: true, permissions: {} as any, allowedSiteIds: undefined, clampedScopes: ['devices:read'] });`. Then add:

```ts
describe('SR2-15: live creator membership + permission-ceiling', () => {
  it('rejects with 401 when the creator has lost tenant membership', async () => {
    buildSequentialSelectMock([
      [{ id: 'key-1', orgId: 'org-1', name: 'k', keyPrefix: 'brz_x', keyHash: 'h', scopes: ['devices:read'], expiresAt: null, rateLimit: 1000, usageCount: 0, status: 'active', createdBy: 'user-1', source: 'manual' }],
      [{ status: 'active' }],   // creator status still active (PR1 check passes)…
    ]);
    vi.mocked(authorizeHumanApiKeyCreator).mockResolvedValue({ ok: false, reason: 'no_membership' });
    const c = createContext({ 'X-API-Key': 'brz_membership_gone' });
    const next = vi.fn();
    await expect(apiKeyAuthMiddleware(c, next)).rejects.toMatchObject({ status: 401 });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the creator no longer holds a stored scope (permission reduction)', async () => {
    buildSequentialSelectMock([
      [{ id: 'key-1', orgId: 'org-1', name: 'k', keyPrefix: 'brz_x', keyHash: 'h', scopes: ['devices:read', 'devices:write'], expiresAt: null, rateLimit: 1000, usageCount: 0, status: 'active', createdBy: 'user-1', source: 'manual' }],
      [{ status: 'active' }],
    ]);
    vi.mocked(authorizeHumanApiKeyCreator).mockResolvedValue({ ok: false, reason: 'scope_exceeds_current_permissions' });
    const c = createContext({ 'X-API-Key': 'brz_perm_reduced' });
    await expect(apiKeyAuthMiddleware(c, vi.fn())).rejects.toMatchObject({ status: 401 });
  });

  it('passes the org AND the org-owning partner to the resolver (partner-axis keys)', async () => {
    buildSequentialSelectMock([
      [{ id: 'key-1', orgId: 'org-1', name: 'k', keyPrefix: 'brz_x', keyHash: 'h', scopes: ['devices:read'], expiresAt: null, rateLimit: 1000, usageCount: 0, status: 'active', createdBy: 'user-1', source: 'manual' }],
      [{ status: 'active' }],
    ]);
    const next = vi.fn();
    await apiKeyAuthMiddleware(createContext({ 'X-API-Key': 'brz_ok' }), next);
    expect(authorizeHumanApiKeyCreator).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'user-1', orgId: 'org-1', partnerId: 'partner-1', scopes: ['devices:read'] }),
    );
    expect(next).toHaveBeenCalled();
  });

  it('carries the LIVE-clamped scopes and allowedSiteIds into the request context', async () => {
    buildSequentialSelectMock([
      [{ id: 'key-1', orgId: 'org-1', name: 'k', keyPrefix: 'brz_x', keyHash: 'h', scopes: ['devices:read', 'devices:write'], expiresAt: null, rateLimit: 1000, usageCount: 0, status: 'active', createdBy: 'user-1', source: 'manual' }],
      [{ status: 'active' }],
    ]);
    vi.mocked(authorizeHumanApiKeyCreator).mockResolvedValue({ ok: true, permissions: {} as any, allowedSiteIds: ['site-a'], clampedScopes: ['devices:read'] });
    const c = createContext({ 'X-API-Key': 'brz_ok' });
    await apiKeyAuthMiddleware(c, vi.fn());
    const ctxKey = c.get('apiKey') as any;
    expect(ctxKey.scopes).toEqual(['devices:read']);       // clamped, not the stored two
    expect(ctxKey.allowedSiteIds).toEqual(['site-a']);
  });
});
```

Guard-bite: delete the `if (!authz.ok) throw` block and tests 1+2 go RED (a membership-gone / permission-reduced key reaches `next()`).

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/middleware/apiKeyAuth.test.ts -t 'SR2-15'
```
Expected: FAIL — the resolver is never called; membership-gone keys reach `next()`.

- [ ] **Step 3: Implement**

In `apps/api/src/middleware/apiKeyAuth.ts`, add the import `import { authorizeHumanApiKeyCreator } from '../services/apiKeyAuthorization';`. Immediately AFTER the existing creator-status block (`:161-163`, the `if (!creator || creator.status !== 'active')` throw) and BEFORE the rate-limit check (`:165`), insert:

```ts
  // SR2-15 (PR 5): a human-delegated key's authority is LIVE-bound to its
  // creator. Beyond the status check above, the creator must (a) still hold a
  // membership/role on this key's tenant (off-boarding gate) and (b) not have
  // had their permissions reduced below the key's stored scopes since mint.
  // We resolve the creator's CURRENT permissions on BOTH axes (org + the org's
  // owning partner, since a Partner Admin has no organization_users row) and
  // re-clamp. FAIL CLOSED: the resolver returns ok:false for a null/errored
  // permission read, and we reject before opening the org context. This adds one
  // getUserPermissions call (Redis-version-cached, 5-min TTL — a cache hit is an
  // mget + in-proc lookup, no Postgres round-trip) to the hot path; correctness
  // over cost per the PR 5 plan (Q1: live re-resolution, not an epoch).
  const authz = await authorizeHumanApiKeyCreator({
    createdBy: apiKey.createdBy,
    orgId: apiKey.orgId,
    partnerId: ownerTenant.partnerId,
    scopes: apiKey.scopes ?? [],
  });
  if (!authz.ok) {
    throw new HTTPException(401, { message: 'API key creator is no longer authorized' });
  }
```

Then, in the `c.set('apiKey', { … })` block (`:219-228`), change `scopes: apiKey.scopes || []` to `scopes: authz.clampedScopes,` and add `allowedSiteIds: authz.allowedSiteIds,`. Add `allowedSiteIds?: string[];` to the `ApiKeyContext['apiKey']` interface (`:12-21`) and to the `declare module 'hono'` `apiKey` type (`:27`).

- [ ] **Step 4: Run to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/middleware/apiKeyAuth.test.ts && pnpm typecheck
```
Expected: PASS, no type errors. (The pre-existing PR 1 creator-status tests still pass — the new block runs only after them and they mock the resolver to authorize by default via `beforeEach`.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/apiKeyAuth.ts apps/api/src/middleware/apiKeyAuth.test.ts
git commit -m "feat(api-keys): REST middleware enforces live creator membership + scope ceiling (SR2-15)"
```

---

### Task 3: Fix the MCP/AI fail-open and enforce the same live authorization

**Files:**
- Modify: `apps/api/src/routes/mcpServer.ts` (`buildAuthFromApiKey` `:1820-1889`, specifically the org-scope branch `:1834-1868`)
- Test: `apps/api/src/routes/mcpServer.resourceRbac.test.ts` (site-gate suite) or a new focused suite `apps/api/src/routes/mcpServer.creatorAuthz.test.ts`

**Interfaces:**
- Consumes: `authorizeHumanApiKeyCreator` (Task 1).
- Produces: `buildAuthFromApiKey` becomes able to return a denial. The org-scope branch resolves the creator's live authorization; on `ok:false` it must cause the MCP request to be rejected (not build an unrestricted `AuthContext`). On `ok:true` it uses `authz.allowedSiteIds` for the site gate.
- **The fail-open being fixed (Q4):** today `const allowedSiteIds = creatorPerms?.allowedSiteIds;` yields `undefined` when `creatorPerms` is `null`, and `siteAccessCheck(undefined)` treats the key as unrestricted. After this task, `null`/denied perms DENY. **Fail-closed rule:** a `null` or errored permission read denies; it is never coerced to "unrestricted".

- [ ] **Step 1: Write the failing test**

Add `apps/api/src/routes/mcpServer.creatorAuthz.test.ts` (mirror an existing `mcpServer.*.test.ts` harness — they mock `../services/permissions` `getUserPermissions` and drive `tools/call`). Drive an org-scoped manual key whose creator's `getUserPermissions` resolves to `null` (off-boarded) and assert the request is DENIED, not served with unrestricted site access:

```ts
it('SR2-15: a manual key whose creator lost membership is DENIED, not treated as unrestricted (fail-open fix)', async () => {
  vi.mocked(getUserPermissions).mockResolvedValue(null);   // creator off-boarded
  const res = await callMcpToolsCall('devices_list', { /* … */ });   // file's driver
  // Before the fix: null perms → allowedSiteIds undefined → siteAccessCheck true → served.
  expect(res.status).not.toBe(200);
  // or, for the JSON-RPC envelope, assert an auth error rather than a device list:
  const body = await res.json();
  expect(body.error ?? body.result).toBeDefined();
  expect(body.result?.devices).toBeUndefined();
});

it('SR2-15: a permission-reduced creator cannot use a scope above their current permissions', async () => {
  vi.mocked(getUserPermissions).mockResolvedValue({
    permissions: [{ resource: 'devices', action: 'read' }],   // write revoked
    partnerId: null, orgId: 'org-1', roleId: 'r', scope: 'organization',
  } as any);
  const res = await callMcpToolsCall('devices_execute_script', { /* ai:execute scope */ });
  const body = await res.json();
  expect(body.result).toBeUndefined();   // denied — creator no longer holds the backing permission
});
```

Guard-bite: revert `buildAuthFromApiKey` to `const allowedSiteIds = creatorPerms?.allowedSiteIds;` with no null-deny and test 1 goes RED (the off-boarded key is served).

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/mcpServer.creatorAuthz.test.ts
```
Expected: FAIL — the off-boarded-creator request is currently served with unrestricted site access.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/mcpServer.ts`, change `buildAuthFromApiKey`'s return type to `Promise<AuthContext | { denied: true }>` (or reuse the file's existing denial idiom — read how `buildCheckedAuthFromApiKey` returns a `Response`; the cleaner fit is to move the authorization INTO `buildCheckedAuthFromApiKey`, which already returns `AuthContext | Response`, so the two `buildCheckedAuthFromApiKey` call sites at `:573` and `:714` already handle a `Response`). Concretely, in the org-scope branch (`:1850-1867`) replace:

```ts
    const partnerId =
      apiKey.partnerId ?? (await getActiveOrgTenant(apiKey.orgId))?.partnerId ?? null;
    const creatorPerms = await getUserPermissions(apiKey.createdBy, {
      partnerId: partnerId || undefined,
      orgId: apiKey.orgId,
    });
    const allowedSiteIds = creatorPerms?.allowedSiteIds;
    return { user, token: {} as AuthContext['token'], partnerId, orgId: apiKey.orgId,
      scope: 'organization', accessibleOrgIds: [apiKey.orgId],
      orgCondition: (orgIdColumn) => eq(orgIdColumn, apiKey.orgId!),
      canAccessOrg: (checkOrgId) => checkOrgId === apiKey.orgId,
      allowedSiteIds, canAccessSite: siteAccessCheck(allowedSiteIds) };
```

with a version that fails closed via the shared resolver (human keys) — resolve `partnerId` first, then:

```ts
    const partnerId =
      apiKey.partnerId ?? (await getActiveOrgTenant(apiKey.orgId))?.partnerId ?? null;
    // SR2-15: LIVE-authorize the human creator. A null/denied permission read
    // must DENY — the previous `creatorPerms?.allowedSiteIds` coerced null to
    // undefined, which siteAccessCheck(undefined) treated as UNRESTRICTED, so an
    // off-boarded creator's key had full site access on the MCP path. Fail closed.
    const authz = await authorizeHumanApiKeyCreator({
      createdBy: apiKey.createdBy,
      orgId: apiKey.orgId,
      partnerId,
      scopes: apiKey.scopes ?? [],
    });
    if (!authz.ok) {
      return { denied: true } as const;   // caller maps to a JSON-RPC auth error / 401
    }
    const allowedSiteIds = authz.allowedSiteIds;
    return { user, token: {} as AuthContext['token'], partnerId, orgId: apiKey.orgId,
      scope: 'organization', accessibleOrgIds: [apiKey.orgId],
      orgCondition: (orgIdColumn) => eq(orgIdColumn, apiKey.orgId!),
      canAccessOrg: (checkOrgId) => checkOrgId === apiKey.orgId,
      allowedSiteIds, canAccessSite: siteAccessCheck(allowedSiteIds) };
```

Note: `apiKey.scopes` is available on the MCP `McpApiKeyWithAuthFields` context (`:417-419` shows `scopes: string[]`). Thread it into `buildAuthFromApiKey`'s parameter object (add `scopes: string[]` to its signature and pass `apiKey.scopes` at the `:460-466` call site). In `buildCheckedAuthFromApiKey` (`:456-489`), after `const auth = await buildAuthFromApiKey({...})`, add `if ('denied' in auth) return c.json({ code: 'creator_unauthorized', error: 'API key creator is no longer authorized' }, 401);`. The partner-scope branch (`:1871-1889`, OAuth bearer / `mcp_provisioning`) derives from the partner axis via `resolvePartnerAccessibleOrgIds`; apply the same `authorizeHumanApiKeyCreator` gate there with `orgId = apiKey.orgId ?? <default>` OR, if that branch has no single org, gate on `getUserPermissions(createdBy,{partnerId})` non-null directly — read the branch and keep its existing `accessibleOrgIds` empty-means-deny pattern, but ADD the null-perms deny so an off-boarded partner admin's bearer key is rejected.

- [ ] **Step 4: Run to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/mcpServer.creatorAuthz.test.ts src/routes/mcpServer.resourceRbac.test.ts src/routes/mcpServer.test.ts src/routes/mcpServer.orgKeyPartnerRole.test.ts && pnpm typecheck
```
Expected: PASS. Re-prime any `mcpServer.*.test.ts` that drove a happy-path `tools/call` with a creator whose `getUserPermissions` returned `null` implicitly — those now need a non-null perms mock (a legit creator). Fix by priming the mock, never by loosening the assertion.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/mcpServer.ts apps/api/src/routes/mcpServer.creatorAuthz.test.ts
git commit -m "fix(mcp): API-key creator null-perms now DENY (fail-open fix) + live scope ceiling (SR2-15)"
```

---

### Task 4: Service-principals schema, migration, RLS, and `api_keys` principal columns

**Files:**
- Create: `apps/api/migrations/2026-07-19-service-principals.sql`
- Create: `apps/api/src/db/schema/servicePrincipals.ts`
- Modify: `apps/api/src/db/schema/apiKeys.ts` (add `principalType`, `principalId`), `apps/api/src/db/schema/index.ts` (export)
- Test: `apps/api/src/db/schema/servicePrincipals.test.ts` (drift/shape smoke) + real-DB RLS coverage picks it up in Task 6

**Interfaces:**
- Produces `service_principals` (org-owned, RLS shape-1): `id uuid pk`, `org_id uuid NOT NULL REFERENCES organizations(id)`, `name varchar(255) NOT NULL`, `status` enum-like `varchar` in `('active','disabled')` default `'active'`, `scopes jsonb NOT NULL DEFAULT '[]'`, `created_by uuid NOT NULL REFERENCES users(id)` (audit only), `last_updated_by uuid REFERENCES users(id)`, `created_at`/`updated_at timestamptz`.
- Produces `api_keys.principal_type varchar NOT NULL DEFAULT 'human'` (`'human' | 'service'`) and `api_keys.principal_id uuid NULL REFERENCES service_principals(id)` (NULL for human keys). **Existing rows backfill to `'human'` via the DEFAULT — no silent conversion (design non-goal honored).**
- **RLS:** `service_principals` carries `org_id`, so the coverage contract-test auto-discovers it as shape-1 (like `api_keys`, which has no explicit allowlist entry — Q6). The migration MUST `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` and ship a `USING (breeze_has_org_access(org_id))` policy for all four commands, mirroring `api_keys` in `0001-baseline.sql`.

- [ ] **Step 1: Write the failing test** — a shape/drift smoke test asserting the Drizzle schema exports `servicePrincipals` with `orgId`, `status`, `scopes`, and that `apiKeys` now exposes `principalType`/`principalId`. (Full RLS enforcement is proven in Task 6 against real Postgres.)

- [ ] **Step 2: Write the migration** `apps/api/migrations/2026-07-19-service-principals.sql`:

```sql
-- Core auth hardening PR 5 (SR2-15): explicit, opt-in service principals so
-- automation owned by an off-boarded human can be migrated to a first-class
-- non-human identity instead of silently surviving on a dead human's authority.
-- Idempotent. No inner BEGIN/COMMIT (runner wraps the file in a transaction).

CREATE TABLE IF NOT EXISTS service_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name varchar(255) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  last_updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_principals_status_chk CHECK (status IN ('active','disabled'))
);

ALTER TABLE service_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_principals FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'service_principals'
      AND policyname = 'service_principals_org_access'
  ) THEN
    CREATE POLICY service_principals_org_access ON service_principals
      USING (breeze_has_org_access(org_id))
      WITH CHECK (breeze_has_org_access(org_id));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON service_principals TO breeze_app;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS principal_type varchar(16) NOT NULL DEFAULT 'human';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS principal_id uuid REFERENCES service_principals(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_principal_type_chk'
  ) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_principal_type_chk
      CHECK (principal_type IN ('human','service'));
  END IF;
END $$;
```

- [ ] **Step 3: Add the Drizzle schema + columns**, apply the migration ad-hoc (per PR 1 Task 1 Step 3 recipe: `pnpm exec tsx -e "import('./src/db/autoMigrate.ts').then(m => m.autoMigrate())…"`), then:

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm db:check-drift
```
Expected: no drift.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-07-19-service-principals.sql apps/api/src/db/schema/servicePrincipals.ts apps/api/src/db/schema/apiKeys.ts apps/api/src/db/schema/index.ts apps/api/src/db/schema/servicePrincipals.test.ts
git commit -m "feat(service-principals): schema + RLS + api_keys principal columns (SR2-15)"
```

---

### Task 5: Service-principal lifecycle service + routes (create / rotate / disable / migrate a human key)

**Files:**
- Create: `apps/api/src/services/servicePrincipals.ts` + `.test.ts`
- Create: `apps/api/src/routes/servicePrincipals.ts` + `.test.ts`
- Modify: `apps/api/src/index.ts` (mount route), `apps/api/src/services/apiKeyAuthorization.ts` (add `authorizeServicePrincipalKey`)

**Interfaces:**
- `services/servicePrincipals.ts`: `createServicePrincipal({ orgId, name, scopes, createdBy })`, `rotateServicePrincipalKey(principalId, actorId)` (mints a new `api_keys` row with `principal_type='service'`, `principal_id`, revokes prior), `disableServicePrincipal(principalId, actorId)` (sets `status='disabled'` and cascades `api_keys.status='revoked'` for its keys), `migrateHumanKeyToServicePrincipal(keyId, principalId, actorId)` (re-points an existing human key — the design's "administrator creates and migrates it to an explicit service principal" path; the ONLY way a human key becomes a service key, never silent).
- `authorizeServicePrincipalKey(principalId, scopes)` in `apiKeyAuthorization.ts`: reloads the principal, DENIES if `status !== 'active'`, re-clamps `scopes` against the principal's OWN `scopes` ceiling (NOT a human's live permissions). **Fail-closed:** a missing/errored principal read denies. Scopes stored on the key must be a subset of the principal's current `scopes`.
- Wiring: `apiKeyAuth.ts` (Task 2) and `mcpServer.ts` (Task 3) branch on `apiKey.principalType`: `'service'` → `authorizeServicePrincipalKey`, else → `authorizeHumanApiKeyCreator`. (Add `principalType`/`principalId` to the middleware's `db.select` column list; re-prime the test queue per the mock hazard.)
- Route authorization: service-principal management requires an admin permission on the owning org (reuse `requirePermission`); a service-principal key itself has NO interactive-login / password / MFA / recovery surface (design) — the routes are JWT-user-only, never reachable by an API key.

- [ ] Steps mirror Tasks 1-2 (TDD): failing test → run RED → implement → run GREEN → commit. Guard-bite tests: (a) a disabled principal's key is rejected; (b) a service key whose stored scope exceeds the principal's current `scopes` is rejected; (c) `migrateHumanKeyToServicePrincipal` is the only mutation that flips `principal_type` and it requires org-admin permission (a non-admin actor 403s). Fail-closed: principal read null/error → deny. Commit message: `feat(service-principals): lifecycle service + management routes; key auth branches on principal type (SR2-15)`.

---

### Task 6: Real-DB integration — membership removal, permission reduction, dual-axis, fail-closed

**Files:**
- Create: `apps/api/src/__tests__/integration/apiKeyPrincipals.integration.test.ts`

**Interfaces / coverage (all against a PRIVATE Postgres, see the constraint below):**
1. **Membership removal kills the key.** Seed org + partner + a creator with an `organization_users` row + an active human `api_keys` row scoped `devices:read`. Auth succeeds. `DELETE FROM organization_users` for the creator. Auth now DENIES (401). GUARD-BITE: this is the core SR2-15 property — it goes RED if Task 2's resolver call is removed.
2. **Partner-axis creator (no org row).** Creator has ONLY a `partner_users` admin row (no `organization_users`). Their manual key (org-scoped) authorizes via the partner axis; removing the `partner_users` row DENIES. Proves the dual-axis pass (Q5) — a plan that only checked the org axis would falsely DENY step-1 here.
3. **Permission reduction re-clamps.** Creator's role downgraded (role loses `devices:write`) between mint and request; a key scoped `devices:write` (or `ai:write`) DENIES while a `devices:read` key still works.
4. **Fail-closed on a contextless read.** Assert the resolver runs under system context and a creator with no visible row (RLS) DENIES rather than authorizing — a read that returns 0 rows must never be "unrestricted".
5. **Service principal lifecycle (Task 5).** A `service`-type key authorizes while the principal is `active` and its scopes cover the key; DENIES once the principal is `disabled`; is unaffected by its `created_by` human being off-boarded (the whole point of service principals).

- **Real-DB harness (embed verbatim):** the shared `:5433` Postgres is contaminated and `docker-compose.test.yml` has an unsized tmpfs that fabricates failures. Stand up a PRIVATE `postgres:16-alpine` with a SIZED tmpfs. Create the `breeze_app` role (`LOGIN PASSWORD 'breeze'`) BEFORE running migrations (many GRANTs target it, and the audit-append-only REVOKEs no-op otherwise). Name the DB to match `/^breeze_test(_[a-z0-9]+)?$/` (the integration setup guard rejects other names). Set BOTH `DATABASE_URL` (superuser) and `DATABASE_URL_APP` (breeze_app) plus `REDIS_URL`. VERIFY `breeze_app` is NON-superuser first — RLS is vacuous under a superuser, so tests 1/2/4 would pass for the WRONG reason (false green).

- [ ] Steps: stand up the private DB → run the migrations (including `2026-07-19-service-principals.sql`) → write the five scenarios → observe each new DENY assertion RED against the pre-Task-2 middleware (cherry-check by temporarily reverting the resolver call) → GREEN with it in place → commit `test(api-keys): real-DB membership-removal, dual-axis, permission-reduction, service-principal lifecycle (SR2-15)`.

---

## Whole-PR verification gate

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm typecheck && pnpm vitest run src/services/apiKeyAuthorization.test.ts src/middleware/apiKeyAuth.test.ts src/routes/mcpServer.creatorAuthz.test.ts src/routes/apiKeys.test.ts src/routes/servicePrincipals.test.ts
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift
# then the private-DB integration + rls-coverage runs (Task 6 harness)
```
Expected: all green, no drift, `service_principals` auto-discovered by `rls-coverage.integration.test.ts` with RLS enabled + forced.
