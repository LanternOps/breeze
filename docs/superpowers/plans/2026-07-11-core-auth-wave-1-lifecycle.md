# Core Authentication Wave 1 Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add database-backed authentication epochs and durable refresh-family revocation so stale sessions cannot survive user, membership, privilege, or logout lifecycle changes.

**Architecture:** A new transaction-scoped lifecycle service advances user epochs and revokes refresh families in PostgreSQL. A central session issuer owns family creation and epoch/session JWT claims. Request middleware validates live epochs and authority before establishing RLS context; Redis remains cache/reuse-defense rather than the only revocation authority.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL/RLS, Redis, JOSE, Vitest.

## Global Constraints

- Use Node `>=22.19.0` and repository-pinned pnpm `10.33.4`.
- Global sign-out is intentional: reject every access/refresh JWT missing `ae`, `me`, and `sid`/`fam`.
- Never edit a shipped migration; new migrations are idempotent and contain no inner `BEGIN`/`COMMIT`.
- All request-path database work uses `withDbAccessContext`; pre-auth/system lifecycle work uses the established system-context helpers.
- Redis cleanup may fail without reviving a PostgreSQL-revoked family.
- Follow red-green-refactor TDD and record the expected failing assertion before production changes.
- Preserve unrelated worktree/user changes and do not expose internal infrastructure values.

---

### Task 1: Add epoch and absolute-family schema

**Files:**
- Create: `apps/api/migrations/2026-07-11-a-auth-security-epochs.sql`
- Modify: `apps/api/src/db/schema/users.ts`
- Modify: `apps/api/src/db/schema/refreshTokenFamilies.ts`
- Create: `apps/api/src/db/schema/authSecurityEpochs.test.ts`
- Test: `apps/api/src/db/autoMigrate.test.ts`
- Test: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

**Interfaces:**
- Produces `users.authEpoch`, `users.mfaEpoch`, `users.emailEpoch`, `users.passwordResetEpoch` as non-null numbers.
- Produces `refreshTokenFamilies.absoluteExpiresAt` as a non-null timestamp.

- [ ] **Step 1: Write the failing schema test**

```ts
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { users } from './users';
import { refreshTokenFamilies } from './refreshTokenFamilies';

describe('authentication security schema', () => {
  it('maps durable user epochs and an absolute refresh-family expiry', () => {
    const userColumns = getTableColumns(users);
    expect(userColumns.authEpoch.notNull).toBe(true);
    expect(userColumns.mfaEpoch.notNull).toBe(true);
    expect(userColumns.emailEpoch.notNull).toBe(true);
    expect(userColumns.passwordResetEpoch.notNull).toBe(true);
    expect(getTableColumns(refreshTokenFamilies).absoluteExpiresAt.notNull).toBe(true);
  });
});
```

- [ ] **Step 2: Run RED**

Run: `corepack pnpm --dir apps/api exec vitest run src/db/schema/authSecurityEpochs.test.ts --maxWorkers=1 --fileParallelism=false`
Expected: FAIL because the five mapped properties do not exist.

- [ ] **Step 3: Add the idempotent migration**

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_epoch integer NOT NULL DEFAULT 1;

ALTER TABLE refresh_token_families
  ADD COLUMN IF NOT EXISTS absolute_expires_at timestamptz;

UPDATE refresh_token_families
SET absolute_expires_at = created_at + interval '30 days'
WHERE absolute_expires_at IS NULL;

ALTER TABLE refresh_token_families
  ALTER COLUMN absolute_expires_at SET NOT NULL;
```

Wrap the backfill in the repository-required `DO $$ ... GET DIAGNOSTICS ... RAISE WARNING` row-count block. Add an index on active absolute expiry only if the refresh lookup query plan uses it.

- [ ] **Step 4: Map Drizzle columns**

Use `integer(...).notNull().default(1)` for all epochs and `timestamp('absolute_expires_at', { withTimezone: true }).notNull()` for the family expiry.

- [ ] **Step 5: Run GREEN and migration contracts**

Run:

```bash
corepack pnpm --dir apps/api exec vitest run src/db/schema/authSecurityEpochs.test.ts src/db/autoMigrate.test.ts --maxWorkers=1 --fileParallelism=false
corepack pnpm db:check-drift
corepack pnpm --dir apps/api run test:rls-coverage
```

Expected: all commands exit 0; no RLS allowlist change is required because no new table exists.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-07-11-a-auth-security-epochs.sql apps/api/src/db/schema/users.ts apps/api/src/db/schema/refreshTokenFamilies.ts apps/api/src/db/schema/authSecurityEpochs.test.ts
git commit -m "fix(auth): add durable session security epochs"
```

### Task 2: Centralize first-party session issuance

**Files:**
- Create: `apps/api/src/services/userSession.ts`
- Create: `apps/api/src/services/userSession.test.ts`
- Modify: `apps/api/src/services/jwt.ts`
- Modify: `apps/api/src/services/jwt.test.ts`
- Modify: `apps/api/src/services/refreshTokenFamily.ts`
- Modify: `apps/api/src/services/tokenRevocation.ts`
- Modify: `apps/api/src/services/index.ts`

**Interfaces:**
- Produces `issueUserSession(identity, { familyId? })` returning tokens plus family ID.
- Requires JWT `ae`, `me`, access `sid`, and refresh `fam`.
- Produces `getActiveRefreshTokenFamily(familyId, userId)` with durable revoked/absolute-expiry checks.

- [ ] **Step 1: Write failing JWT claim tests**

Add cases proving access verification rejects missing `ae`, `me`, or `sid`; refresh verification rejects missing `ae`, `me`, or `fam`; and a valid pair carries identical epochs/session IDs.

```ts
expect(accessPayload).toMatchObject({ ae: 3, me: 7, sid: familyId, type: 'access' });
expect(refreshPayload).toMatchObject({ ae: 3, me: 7, fam: familyId, type: 'refresh' });
```

- [ ] **Step 2: Write failing `issueUserSession` tests**

Cover new-family issuance, existing-family rotation, revoked family, absolute expiry, user mismatch, and epoch loading from the database rather than caller input.

- [ ] **Step 3: Run RED**

Run: `corepack pnpm --dir apps/api exec vitest run src/services/jwt.test.ts src/services/userSession.test.ts --maxWorkers=1 --fileParallelism=false`
Expected: FAIL on missing claims/module.

- [ ] **Step 4: Implement required JWT types and issuer**

```ts
export type UserSessionIdentity = {
  userId: string;
  email: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
  mfa: boolean;
  mobileDeviceId?: string;
};

export async function issueUserSession(
  identity: UserSessionIdentity,
  options: { familyId?: string } = {},
): Promise<TokenPair & { familyId: string }>;
```

Load epochs under system context; insert a family with `absoluteExpiresAt = now + 30 days` when absent; validate an existing family; sign both tokens; bind the refresh JTI. Keep low-level signing functions internal to `jwt.ts` tests/callers that do not represent user sessions.

- [ ] **Step 5: Run GREEN**

Run the Step 3 command and `src/services/tokenRevocation.test.ts`; expected all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/userSession.ts apps/api/src/services/userSession.test.ts apps/api/src/services/jwt.ts apps/api/src/services/jwt.test.ts apps/api/src/services/refreshTokenFamily.ts apps/api/src/services/tokenRevocation.ts apps/api/src/services/index.ts
git commit -m "fix(auth): centralize epoch-bound session issuance"
```

### Task 3: Enforce live epochs and authority before RLS

**Files:**
- Modify: `apps/api/src/middleware/auth.ts`
- Modify: `apps/api/src/middleware/auth.test.ts`
- Modify: `apps/api/src/middleware/auth.siteAccess.test.ts`
- Modify: `apps/api/src/routes/auth/loginContext.ts`
- Modify: `apps/api/src/routes/auth/loginContext.test.ts`

**Interfaces:**
- Produces a live-authority resolver for system/partner/organization axes.
- Consumes `ae`, `me`, `sid` from verified access payload.

- [ ] **Step 1: Add failing middleware cases**

Test auth-epoch mismatch, MFA-epoch mismatch, missing live platform-admin flag for system scope, removed organization membership, removed partner membership, and a valid matching membership. Assert `next` and request DB context are never reached for denied cases.

- [ ] **Step 2: Run RED**

Run: `corepack pnpm --dir apps/api exec vitest run src/middleware/auth.test.ts src/middleware/auth.siteAccess.test.ts --maxWorkers=1 --fileParallelism=false`
Expected: stale tokens are currently accepted in at least the epoch/system/membership cases.

- [ ] **Step 3: Implement fail-closed ordering**

After token verification, select user status/password/epochs/platform flag under system context. Compare claims before tenant lookup. Query exact live partner/org membership for the token axis and reject missing/mismatched rows before `computeAccessibleOrgIds` and `withDbAccessContext`.

- [ ] **Step 4: Run GREEN and route regression tests**

Run Step 2 plus `src/routes/auth/loginContext.test.ts`; expected all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/middleware/auth.test.ts apps/api/src/middleware/auth.siteAccess.test.ts apps/api/src/routes/auth/loginContext.ts apps/api/src/routes/auth/loginContext.test.ts
git commit -m "fix(auth): bind request scope to live authority"
```

### Task 4: Migrate every user-session mint and refresh path

**Files:**
- Modify: `apps/api/src/routes/auth/login.ts`
- Modify: `apps/api/src/routes/auth/mfa.ts`
- Modify: `apps/api/src/routes/auth/passkeys.ts`
- Modify: `apps/api/src/routes/auth/register.ts`
- Modify: `apps/api/src/routes/auth/invite.ts`
- Modify: `apps/api/src/routes/auth/cfAccessRedirectLogin.ts`
- Modify: `apps/api/src/middleware/cfAccessLogin.ts`
- Modify: `apps/api/src/routes/sso.ts`
- Test: corresponding colocated `*.test.ts` files and `apps/api/src/routes/auth.passkeys.test.ts`

**Interfaces:**
- Consumes `issueUserSession` exclusively for first-party access/refresh pairs.
- Refresh reuses verified `fam` and rejects durable/absolute expiry before rotation.

- [ ] **Step 1: Add a static regression test for issuer coverage**

Create `apps/api/src/services/userSessionCallsites.test.ts` that scans production TypeScript and fails when a route/middleware imports `createTokenPair`, `mintRefreshTokenFamily`, or `bindRefreshJtiToFamily` outside the approved session service.

- [ ] **Step 2: Run RED**

Run the static test; expected FAIL listing the eight current issuer modules.

- [ ] **Step 3: Replace each issuance sequence**

For each path, build `UserSessionIdentity`, preserve mobile-device binding and MFA outcome, call `issueUserSession`, set the returned refresh cookie, and keep existing response shape. Refresh passes the existing family ID and uses live epochs; registration remains behaviorally unchanged until Wave 4.

- [ ] **Step 4: Run focused issuer suites**

```bash
corepack pnpm --dir apps/api exec vitest run src/services/userSessionCallsites.test.ts src/routes/auth/login.test.ts src/routes/auth.test.ts src/routes/auth.passkeys.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts src/routes/sso.test.ts --maxWorkers=1 --fileParallelism=false
```

Expected: all files pass and the static test reports no direct production callsites.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth apps/api/src/routes/auth.passkeys.test.ts apps/api/src/middleware/cfAccessLogin.ts apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts apps/api/src/services/userSessionCallsites.test.ts
git commit -m "fix(auth): migrate all user session issuers"
```

### Task 5: Add transactional lifecycle revocation

**Files:**
- Create: `apps/api/src/services/authLifecycle.ts`
- Create: `apps/api/src/services/authLifecycle.test.ts`
- Modify: `apps/api/src/routes/users.ts`
- Modify: `apps/api/src/routes/users.test.ts`
- Modify: `apps/api/src/routes/auth/password.ts`
- Modify: `apps/api/src/routes/auth/password.test.ts`
- Modify: `apps/api/src/routes/accessReviews.ts`
- Modify: `apps/api/src/routes/admin/abuse.ts`
- Modify: membership-removal services/routes discovered by `trace_path` from partner/org user deletes
- Modify: `apps/api/src/services/userSuspension.ts`
- Modify: `apps/api/src/services/tenantLifecycle.ts`
- Modify: `apps/api/src/services/platformAdminBootstrap.ts`

**Interfaces:**
- Produces `advanceUserSecurityState`, `revokeAllUserSessionFamilies`, and `revokeUserSessionFamily` accepting the active transaction.

- [ ] **Step 1: Write failing service transaction tests**

Test atomic epoch increment plus family revocation, reason/timestamp, rollback on either update failure, no-op user/family mismatch, and repeat invocation idempotency.

- [ ] **Step 2: Write failing route tests**

Test active→disabled, disabled→active non-revival, password change/reset auth invalidation, role/scope change, partner and organization membership removal (including access-review bulk revocation), partner suspend/reactivate, platform privilege change, and database revocation failure rolling back the business mutation.

- [ ] **Step 3: Run RED**

Run: `corepack pnpm --dir apps/api exec vitest run src/services/authLifecycle.test.ts src/routes/users.test.ts --maxWorkers=1 --fileParallelism=false`.

- [ ] **Step 4: Implement lifecycle service and route transactions**

Use Drizzle transaction objects already supplied by request context. Update `users` with SQL `auth_epoch + 1`, update all unrevoked family rows with `revokedAt/revokedReason`, and return row counts. Move status/membership mutation into the same transaction. Run OAuth/Redis/permission/remote cleanup only after commit.

- [ ] **Step 5: Run GREEN**

Run Step 3 and suspension-related tests; expected all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/authLifecycle.ts apps/api/src/services/authLifecycle.test.ts apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts apps/api/src/services/userSuspension.ts
git commit -m "fix(auth): revoke sessions atomically on lifecycle changes"
```

### Task 6: Make logout durable and race-safe

**Files:**
- Modify: `apps/api/src/routes/auth/login.ts`
- Modify: `apps/api/src/routes/auth/login.test.ts`
- Modify: `apps/api/src/routes/auth/helpers.ts`
- Modify: `apps/api/src/__tests__/integration/refresh-token-family.integration.test.ts`

**Interfaces:**
- Consumes access `sid`, optional refresh-cookie `fam`, and `revokeUserSessionFamily`.

- [ ] **Step 1: Add failing logout cases**

Cover cookie absent with valid `sid`, cookie/family mismatch, PostgreSQL failure returning 503 + failure audit + cleared cookie, Redis cleanup failure after durable success returning success, and no false success audit.

- [ ] **Step 2: Add a failing real-DB refresh/logout race**

Use concurrent requests and assert no token issued after the family revocation commit can refresh or mint a descendant.

- [ ] **Step 3: Run RED**

Run login route tests and the dedicated integration file; expected current catch-and-success behavior to fail assertions.

- [ ] **Step 4: Implement logout order**

Resolve family, reject mismatch, durably revoke, clear cookie in every branch, perform cache cleanup, and write result-accurate audit. Do not globally revoke sibling sessions.

- [ ] **Step 5: Run GREEN**

Run the Step 3 commands; expected all pass with one race winner.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/login.test.ts apps/api/src/routes/auth/helpers.ts apps/api/src/__tests__/integration/refresh-token-family.integration.test.ts
git commit -m "fix(auth): durably revoke the current session on logout"
```

### Task 7: Verify Wave 1 and document rollout

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/PROJECT_STATUS.md` only if it tracks active auth architecture

- [ ] **Step 1: Add release-note copy**

Document mandatory global sign-in after upgrade, fixed absolute session lifetime, and immediate offboarding/session invalidation without disclosing exploit detail.

- [ ] **Step 2: Run complete focused verification**

```bash
corepack pnpm --dir apps/api exec vitest run src/services/jwt.test.ts src/services/userSession.test.ts src/services/tokenRevocation.test.ts src/services/authLifecycle.test.ts src/middleware/auth.test.ts src/middleware/auth.siteAccess.test.ts src/routes/auth/login.test.ts src/routes/auth.test.ts src/routes/auth.passkeys.test.ts src/routes/users.test.ts src/routes/sso.test.ts --maxWorkers=1 --fileParallelism=false
corepack pnpm --filter @breeze/api build
corepack pnpm db:check-drift
corepack pnpm --dir apps/api run test:rls-coverage
```

Expected: zero failures and zero type/build errors.

- [ ] **Step 3: Run independent review**

Review specifically for missing token issuers, mutation paths outside the lifecycle service, transaction boundary mistakes, RLS/system-context misuse, and logs containing tokens.

- [ ] **Step 4: Commit documentation**

```bash
git add CHANGELOG.md docs/PROJECT_STATUS.md
git commit -m "docs(auth): announce durable session lifecycle"
```
