# Durable Browser Authentication Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the response-cookie Cloudflare logout quarantine with a PostgreSQL-authoritative browser-auth transition that orders logout against every user-session issuer and provides a signed one-time cross-site completion.

**Architecture:** A stable server-issued binding selects one durable transition row. Issuers reserve a bounded operation lease, then perform all authority-granting Breeze writes in a final transaction that rechecks an opaque capability. Cloudflare preparation locks the same row, globally revokes verified subjects, exactly revokes any just-issued binding family, and returns a signed one-time completion ticket.

**Tech Stack:** Hono, TypeScript, Drizzle ORM, PostgreSQL row locks/RLS, Vitest, Redis as a non-authoritative cache, Astro/React web client, React Native/SecureStore mobile client.

## Global Constraints

- Fix forward from commit `675f66ac2`; do not amend, rewrite, or delete the baseline commit.
- Use hand-written, idempotent `YYYY-MM-DD-<slug>.sql` migrations. Never use `drizzle-kit generate` or `drizzle-kit push`.
- Every new tenant-correlating table has enabled and forced RLS plus a same-migration policy. Update the RLS coverage contract in the same task.
- Cleanup UPDATE/DELETE statements report row counts through `GET DIAGNOSTICS` and `RAISE WARNING`.
- Request-path database access uses the established context helpers; terminal transition infrastructure uses an explicit outside-to-system transaction.
- PostgreSQL is authoritative. Redis failures cannot reactivate a family, reopen a binding, or validate a stale JTI.
- No database row lock or transaction spans password hashing, email, webhooks, or IdP network calls.
- Every production call to `issueUserSession` requires the guarded capability and transaction. No optional unguarded overload remains.
- Use strict TDD for each task: observe the focused regression fail before changing production code.
- Keep commits reviewable and use the checkpoints named below. Do not push, merge, or deploy from this plan.

---

## File and interface map

### New files

- `apps/api/migrations/2026-07-12-a-auth-browser-transitions.sql` — additive transition, durable current-JTI, SSO binding/grant schema and RLS.
- `apps/api/src/db/schema/authBrowserTransitions.ts` — Drizzle schema for transition state and durable SSO exchange grants.
- `apps/api/src/services/authBrowserTransition.ts` — binding parsing/HMAC, admission lease, finalization capability, rotation, and transition locking.
- `apps/api/src/services/authBrowserTransition.test.ts` — service-level state-machine and capability tests.
- `apps/api/src/services/terminalLogoutTicket.ts` — domain-separated ticket signing and verification.
- `apps/api/src/services/terminalLogoutTicket.test.ts` — signature, expiry, alteration, and audience tests.
- `apps/api/src/__tests__/integration/auth-browser-transition.integration.test.ts` — real-PostgreSQL lock-order and issuer/logout overlap tests.
- `apps/api/src/__tests__/integration/auth-browser-transition-rls.integration.test.ts` — direct system-only RLS probes if the aggregate RLS contract cannot express the table adequately.

### Existing files with central changes

- `apps/api/src/db/schema/index.ts`
- `apps/api/src/db/schema/refreshTokenFamilies.ts`
- `apps/api/src/db/schema/sso.ts`
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- `apps/api/src/services/userSession.ts`
- `apps/api/src/services/userSession.test.ts`
- `apps/api/src/services/refreshTokenFamily.ts`
- `apps/api/src/services/authLifecycle.ts`
- `apps/api/src/services/terminalLogout.ts`
- `apps/api/src/services/terminalLogout.test.ts`
- `apps/api/src/routes/auth/helpers.ts`
- `apps/api/src/routes/auth/helpers.test.ts`
- `apps/api/src/routes/auth/login.ts`
- `apps/api/src/routes/auth/login.test.ts`
- `apps/api/src/services/mfaAssurance.ts`
- `apps/api/src/services/mfaAssurance.test.ts`
- `apps/api/src/services/recoveryCodeAuth.ts`
- `apps/api/src/services/recoveryCodeAuth.test.ts`
- `apps/api/src/routes/auth/mfa.ts`
- `apps/api/src/routes/auth/passkeys.ts`
- `apps/api/src/routes/auth/register.ts`
- `apps/api/src/routes/auth/register.test.ts`
- `apps/api/src/routes/auth/invite.ts`
- `apps/api/src/routes/auth/invite.test.ts` (new focused route suite)
- `apps/api/src/middleware/cfAccessLogin.ts`
- `apps/api/src/middleware/cfAccessLogin.test.ts`
- `apps/api/src/routes/auth/cfAccessRedirectLogin.ts`
- `apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts`
- `apps/api/src/routes/sso.ts`
- `apps/api/src/routes/sso.test.ts`
- `apps/web/src/stores/auth.ts`
- `apps/web/src/stores/auth.test.ts`
- `apps/mobile/src/services/api.ts`
- `apps/mobile/src/services/api.logout.test.ts`
- `apps/mobile/src/store/authSlice.ts`
- `apps/mobile/src/store/authSlice.test.ts`
- `.env.example`
- `apps/api/src/config/env.ts`
- `apps/api/src/config/env.test.ts`
- `apps/api/src/config/validate.ts`
- `apps/api/src/config/validate.test.ts`

### Stable interfaces produced by early tasks

```ts
export type AuthBindingSource =
  | { kind: 'browser'; value: string }
  | { kind: 'native'; value: string };

export type AuthIssuanceCapability = Readonly<{
  transitionId: string;
  generation: number;
  operationId: string;
  expiresAt: Date;
}>;

export async function beginAuthIssuance(
  source: AuthBindingSource,
): Promise<AuthIssuanceCapability>;

export async function finishAuthIssuance<T>(
  capability: AuthIssuanceCapability,
  callback: (tx: AuthLifecycleTransaction) => Promise<T>,
): Promise<T>;

export async function issueUserSession(
  identity: UserSessionIdentity,
  options: {
    tx: AuthLifecycleTransaction;
    capability: AuthIssuanceCapability;
    familyId?: string;
  },
): Promise<TokenPair & { familyId: string }>;
```

The concrete capability carries a private runtime brand. Tests may create it only through the transition test fixture; route code cannot construct it from request data.

---

### Task 1: Freeze the caller and cookie-writer inventory

**Files:**
- Create: `apps/api/src/services/userSession.callers.test.ts`
- Modify: `.superpowers/sdd/progress.md` (ignored tracking only; do not stage)

**Interfaces:**
- Consumes: current `issueUserSession`, `setRefreshTokenCookie`, and SSO exchange source.
- Produces: a source contract that fails when a new unreviewed issuer or cookie writer appears.

- [ ] **Step 1: Write the failing inventory contract**

Add a Vitest source test that scans production TypeScript under `apps/api/src`, excludes tests, and asserts the exact current inventory:

```ts
const expectedIssuers = new Set([
  'services/mfaAssurance.ts',
  'services/recoveryCodeAuth.ts',
  'routes/auth/cfAccessRedirectLogin.ts',
  'routes/auth/register.ts',
  'routes/auth/login.ts',
  'routes/auth/invite.ts',
  'routes/sso.ts',
]);

const expectedCookieWriters = new Set([
  'middleware/cfAccessLogin.ts',
  'routes/auth/passkeys.ts',
  'routes/auth/mfa.ts',
  'routes/auth/invite.ts',
  'routes/auth/login.ts',
  'routes/auth/register.ts',
  'routes/auth/cfAccessRedirectLogin.ts',
  'routes/sso.ts',
]);
```

Assert the nine current `issueUserSession(` call sites, including both registration calls, and all current `setRefreshTokenCookie(` call sites. Also assert that `/sso/exchange` writes a refresh cookie after consuming an exchange grant.

- [ ] **Step 2: Run the contract and record the current inventory**

Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/services/userSession.callers.test.ts
```

Expected: PASS against `675f66ac2`. Save the exact paths/counts in the test description so later tasks deliberately update the contract rather than silently adding exceptions.

- [ ] **Step 3: Add future-state assertions as skipped tests**

Add named `it.skip` assertions describing the end state:

```ts
it.skip('requires a guarded capability at every production issuer');
it.skip('allows refresh cookie installation only from an authorized session result');
it.skip('keeps SSO exchange inside the durable binding generation');
```

These are converted to active tests in Tasks 4, 9, and 12.

- [ ] **Step 4: Commit the inventory**

```bash
git add apps/api/src/services/userSession.callers.test.ts
git commit -m "test(auth): freeze session issuer inventory"
```

---

### Task 2: Add the additive schema, migration, and RLS contract

**Files:**
- Create: `apps/api/migrations/2026-07-12-a-auth-browser-transitions.sql`
- Create: `apps/api/src/db/schema/authBrowserTransitions.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/db/schema/refreshTokenFamilies.ts`
- Modify: `apps/api/src/db/schema/sso.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/auth-browser-transition-rls.integration.test.ts`

**Interfaces:**
- Consumes: `users`, `refresh_token_families`, `sso_sessions`, system DB context helpers.
- Produces: `authBrowserTransitions`, `ssoTokenExchangeGrants`, nullable current-JTI and SSO binding columns.

- [ ] **Step 1: Write failing schema and migration contract tests**

The tests must assert:

- transition state/generation/operation/logout fields exist;
- `binding_digest` is unique;
- `current_refresh_jti_digest` exists and is nullable for rollout;
- SSO sessions carry transition ID/generation;
- SSO grants store only a code digest;
- both new tables have RLS enabled, forced, and system-only policies;
- reapplying the migration is a no-op.

Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/__tests__/integration/auth-browser-transition-rls.integration.test.ts
```

Expected: FAIL because the tables and columns do not exist.

- [ ] **Step 2: Write the idempotent migration**

Create both tables with `CREATE TABLE IF NOT EXISTS`, add nullable columns with `ADD COLUMN IF NOT EXISTS`, add named checks idempotently, enable and force RLS, and create system-only policies after checking `pg_policies`.

Use the established system-scope session setting in the policy, for example:

```sql
USING (current_setting('breeze.scope', true) = 'system')
WITH CHECK (current_setting('breeze.scope', true) = 'system')
```

Do not add inner `BEGIN`/`COMMIT`. No data cleanup is required for nullable additive columns.

- [ ] **Step 3: Add matching Drizzle schemas**

Define the enum/check-compatible state and indexes. Export both schemas from `db/schema/index.ts`. Preserve the legacy nullable rollout representation:

```ts
currentRefreshJtiDigest: varchar('current_refresh_jti_digest', { length: 64 }),
browserTransitionId: uuid('browser_transition_id'),
browserGeneration: bigint('browser_generation', { mode: 'number' }),
```

- [ ] **Step 4: Update aggregate RLS coverage**

Record both tables as explicit system-only security infrastructure. The direct integration test must connect as `breeze_app`, set a non-system request context, and prove SELECT/INSERT/UPDATE are denied; system context succeeds.

- [ ] **Step 5: Run schema gates**

```bash
pnpm --filter=@breeze/api exec vitest run src/__tests__/integration/auth-browser-transition-rls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
pnpm db:check-drift
pnpm --filter=@breeze/api exec vitest run src/db/autoMigrate.test.ts
```

Expected: all tests pass; drift reports no differences; migration reapplication succeeds.

- [ ] **Step 6: Commit the schema**

```bash
git add apps/api/migrations/2026-07-12-a-auth-browser-transitions.sql apps/api/src/db/schema apps/api/src/__tests__/integration/auth-browser-transition-rls.integration.test.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(auth): add durable browser transition schema"
```

---

### Task 3: Implement binding lifecycle, lease admission, and capability finalization

**Files:**
- Create: `apps/api/src/services/authBrowserTransition.ts`
- Create: `apps/api/src/services/authBrowserTransition.test.ts`
- Modify: `apps/api/src/services/index.ts`
- Modify: `apps/api/src/routes/auth/helpers.ts`
- Modify: `apps/api/src/routes/auth/helpers.test.ts`

**Interfaces:**
- Consumes: Task 2 schemas and `withAuthLifecycleSystemTransaction`.
- Produces: `resolveAuthBinding`, `beginAuthIssuance`, `finishAuthIssuance`, `rotateExpiredBinding`, `AuthIssuanceCapability`.

- [ ] **Step 1: Write failing state-machine tests**

Cover:

- HMAC digest is deterministic, domain-separated, and never returns the raw value;
- missing binding produces a fresh 64-hex value and HTTP-428 domain outcome;
- active binding reserves one operation lease;
- second unexpired operation conflicts;
- expired operation is replaced;
- logout-pending and retired bindings reject;
- finalization rejects wrong ID, wrong generation, expired lease, or pending state;
- callback and operation clear commit together;
- callback failure rolls back operation-owned writes;
- expired/retired C1 rotates to C2 and C1 remains inadmissible.

Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/services/authBrowserTransition.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 2: Implement the private branded capability**

Use a module-private symbol and a runtime assertion:

```ts
const AUTH_ISSUANCE_CAPABILITY = Symbol('AuthIssuanceCapability');

export type AuthIssuanceCapability = Readonly<{
  transitionId: string;
  generation: number;
  operationId: string;
  expiresAt: Date;
  [AUTH_ISSUANCE_CAPABILITY]: true;
}>;
```

Do not export a constructor. Provide a test fixture factory only from a test-only export guarded by `NODE_ENV === 'test'`, or test through public admission.

- [ ] **Step 3: Implement short admission and finalization transactions**

Admission locks only the transition row and stores a bounded lease. Finalization locks the same row and invokes its callback only after exact state checks. Use database `now()` semantics for expiry comparisons so replica clock skew does not decide authority.

- [ ] **Step 4: Split cookie clearing and preserve stable CSRF**

In `helpers.ts`, introduce:

```ts
export function clearRefreshCookieOnly(c: Context): void;
export function rotateCsrfBindingCookie(c: Context, value: string): void;
```

`setRefreshTokenCookie` reuses a valid existing 64-hex CSRF cookie; otherwise caller admission must already have established a new binding. Keep ordinary `clearRefreshTokenCookie` behavior for non-terminal logout. Terminal prepare uses `clearRefreshCookieOnly`.

- [ ] **Step 5: Add strict terminal CSRF validation**

Add `validateTerminalCookieCsrfRequest` that never accepts the non-browser header-only compatibility branch. Test missing cookie, missing header, mismatch, disallowed Origin, and cross-site `Sec-Fetch-Site`.

- [ ] **Step 6: Run focused tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/authBrowserTransition.test.ts src/routes/auth/helpers.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the transition primitive**

```bash
git add apps/api/src/services/authBrowserTransition.ts apps/api/src/services/authBrowserTransition.test.ts apps/api/src/services/index.ts apps/api/src/routes/auth/helpers.ts apps/api/src/routes/auth/helpers.test.ts
git commit -m "feat(auth): add guarded browser issuance leases"
```

---

### Task 4: Make refresh-currentness durable and atomic

**Files:**
- Modify: `apps/api/src/services/refreshTokenFamily.ts`
- Modify: `apps/api/src/services/userSession.ts`
- Modify: `apps/api/src/services/userSession.test.ts`
- Modify: `apps/api/src/routes/auth/login.ts`
- Modify: `apps/api/src/routes/auth/login.test.ts`
- Modify: `apps/api/src/services/tokenRevocation.ts`
- Modify: `apps/api/src/services/tokenRevocation.test.ts`
- Modify: `apps/api/src/__tests__/integration/refresh-token-family.integration.test.ts`

**Interfaces:**
- Consumes: Task 3 capability and Task 2 current-JTI column.
- Produces: atomic initial/current JTI writes, `classifyRefreshTokenAuthority`, guarded `issueUserSession` signature.

- [ ] **Step 1: Write failing durable-JTI tests**

Test initial issue, successful compare-and-swap rotation, stale predecessor rejection, wrong owner, revoked/expired family, concurrent rotation with exactly one successor, and legacy null behavior. The real-DB race test must hold the family row to force both orders.

Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/services/userSession.test.ts src/__tests__/integration/refresh-token-family.integration.test.ts
```

Expected: FAIL because family rows do not record current JTI and issuance accepts no capability.

- [ ] **Step 2: Refactor token creation to expose the successor JTI before commit**

Add an internal JWT creation input that accepts a pre-generated refresh JTI, or return token material before the family write while retaining the transaction. The family insert/update and JTI digest write must commit together.

- [ ] **Step 3: Require capability and transaction in `issueUserSession`**

Replace the optional options object with:

```ts
options: {
  tx: AuthLifecycleTransaction;
  capability: AuthIssuanceCapability;
  familyId?: string;
}
```

Assert the capability against the transition in the same transaction. Remove the non-transactional family insert path from production issuance.

- [ ] **Step 4: Implement refresh authority classification**

Return one of:

```ts
type RefreshAuthority =
  | { kind: 'current'; userId: string; familyId: string }
  | { kind: 'legacy_or_stale_family'; familyId: string }
  | { kind: 'invalid' };
```

Only `current` may select a global subject. `legacy_or_stale_family` permits exact-family revocation only.

- [ ] **Step 5: Move `/refresh` into guarded compare-and-swap finalization**

Admission occurs before any old-JTI claim. Finalization locks transition then user then family, validates the durable current digest, creates the successor, updates the digest, and records the binding's current family. Redis rotation markers run after commit.

- [ ] **Step 6: Activate the future inventory assertion for guarded issuance**

Update `userSession.callers.test.ts` so direct call-site options must contain `tx` and `capability`, or calls must occur inside an approved guarded service whose source contains the runtime assertion.

- [ ] **Step 7: Run focused and race tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/userSession.test.ts src/services/tokenRevocation.test.ts src/routes/auth/login.test.ts src/__tests__/integration/refresh-token-family.integration.test.ts
```

Expected: PASS, including exactly one durable refresh successor.

- [ ] **Step 8: Commit durable refresh authority**

```bash
git add apps/api/src/services/refreshTokenFamily.ts apps/api/src/services/userSession.ts apps/api/src/services/userSession.test.ts apps/api/src/services/userSession.callers.test.ts apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/login.test.ts apps/api/src/services/tokenRevocation.ts apps/api/src/services/tokenRevocation.test.ts apps/api/src/__tests__/integration/refresh-token-family.integration.test.ts
git commit -m "feat(auth): make refresh currentness durable"
```

---

### Task 5: Migrate primary login, pending MFA, passkey, and recovery issuers

**Files:**
- Modify: `apps/api/src/services/mfaAssurance.ts`
- Modify: `apps/api/src/services/mfaAssurance.test.ts`
- Modify: `apps/api/src/services/recoveryCodeAuth.ts`
- Modify: `apps/api/src/services/recoveryCodeAuth.test.ts`
- Modify: `apps/api/src/routes/auth/login.ts`
- Modify: `apps/api/src/routes/auth/login.test.ts`
- Modify: `apps/api/src/routes/auth/mfa.ts`
- Create: `apps/api/src/routes/auth/mfa.test.ts`
- Modify: `apps/api/src/routes/auth.test.ts` where existing aggregate MFA fixtures need the new capability.
- Modify: `apps/api/src/routes/auth/passkeys.ts`
- Create: `apps/api/src/routes/auth/passkeys.test.ts`
- Modify: `apps/api/src/routes/auth.passkeys.test.ts` where existing aggregate passkey fixtures need the new capability.
- Modify: `apps/api/src/middleware/cfAccessLogin.ts`
- Modify: `apps/api/src/middleware/cfAccessLogin.test.ts`

**Interfaces:**
- Consumes: guarded issue API from Task 4.
- Produces: guarded issuer groups 1–3; pending records carry transition ID/generation.

- [ ] **Step 1: Write failing terminal-admission tests for each factor**

Create a table-driven matrix for password direct issue, CF XHR direct issue, TOTP, SMS, passkey, and recovery. Force logout-pending after admission but before finalization and assert:

- no family or cookie;
- no passkey counter update;
- no TOTP migration write;
- no SMS success consumption that can authenticate;
- no recovery hash consumption;
- no success audit or last-login update.

Run the focused service and route suites. Expected: FAIL at the first pre-guard side effect or unguarded issuer.

- [ ] **Step 2: Bind pending MFA records to the transition generation**

Extend the validated pending record with transition ID/generation. Creation records the current values. Every completion rejects a different or retired generation before factor consumption.

- [ ] **Step 3: Guard direct primary issuance**

Password and CF XHR login call admission after credential/IdP verification but before the direct-vs-pending authority write. Direct issue occurs in finalization; pending creation records the capability generation.

- [ ] **Step 4: Make recovery consumption and issuance atomic**

Move `consumeRecoveryCode` and `issueUserSession` into one `finishAuthIssuance` callback. Preserve fail-closed post-commit cache binding and existing generic error responses.

- [ ] **Step 5: Move factor database effects behind finalization**

Passkey counter update, TOTP migration, last-login update, and family creation use the guarded transaction. Redis one-time records are read/claimed only after admission; a finalization rejection may burn a one-time challenge but never grants authority.

- [ ] **Step 6: Run focused tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/mfaAssurance.test.ts src/services/recoveryCodeAuth.test.ts src/routes/auth/login.test.ts src/routes/auth/mfa.test.ts src/routes/auth/passkeys.test.ts src/middleware/cfAccessLogin.test.ts
```

Expected: PASS for every factor and both direct primary methods.

- [ ] **Step 7: Commit guarded factor issuers**

```bash
git add apps/api/src/services/mfaAssurance.ts apps/api/src/services/mfaAssurance.test.ts apps/api/src/services/recoveryCodeAuth.ts apps/api/src/services/recoveryCodeAuth.test.ts apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/login.test.ts apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth/mfa.test.ts apps/api/src/routes/auth/passkeys.ts apps/api/src/routes/auth/passkeys.test.ts apps/api/src/middleware/cfAccessLogin.ts apps/api/src/middleware/cfAccessLogin.test.ts
git commit -m "feat(auth): guard primary and MFA session issuance"
```

---

### Task 6: Migrate registration and invite acceptance

**Files:**
- Modify: `apps/api/src/routes/auth/register.ts`
- Modify: `apps/api/src/routes/auth/register.test.ts`
- Modify: `apps/api/src/services/partnerCreate.ts`
- Modify: `apps/api/src/services/partnerCreate.test.ts`
- Modify: `apps/api/src/services/partnerActivation.ts`
- Modify: `apps/api/src/services/partnerActivation.test.ts`
- Modify: `apps/api/src/routes/auth/invite.ts`
- Create: `apps/api/src/routes/auth/invite.test.ts`
- Modify: `apps/api/src/routes/auth.test.ts` where existing aggregate invite fixtures need the new capability.

**Interfaces:**
- Consumes: transition finalization and guarded issuer.
- Produces: guarded issuer groups 5–6 with no pre-guard account/invite writes.

- [ ] **Step 1: Write failing registration overlap tests**

Force logout pending between registration admission and finalization. Assert no partner, organization, admin user, membership, role, family, verification token, hook-status write, cookie, or success audit exists. Add the inverse lock order: registration commits first, logout later sees and revokes its linked current family.

- [ ] **Step 2: Write failing invite overlap tests**

When logout wins, assert invited user status, password hash, epochs, and invite Redis keys are unchanged; no family/cookie/success audit exists. When invite finalization wins first, logout revokes its family.

- [ ] **Step 3: Make partner creation accept the guarded outer transaction**

Move authority-granting partner/user/membership/role writes and the final live session into one finalization callback. Preserve activation epoch behavior. Do not keep the initial pending pair if activation revokes it; issue the response pair only after the activation state in the same authoritative sequence.

- [ ] **Step 4: Move external effects after commit**

Verification email, webhook delivery, and non-authoritative audit delivery run after the guarded database commit. A post-commit delivery failure does not roll back the account and is surfaced through the existing response/audit contract.

- [ ] **Step 5: Make invite activation and issuance atomic**

Password/status/epoch update, family revocation, and new family issue share the final guarded transaction. Delete Redis invite keys only after commit. Preserve the existing safe `tokens: null` response only for post-commit delivery/cache failures, not for an authority transaction failure.

- [ ] **Step 6: Run focused tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/auth/register.test.ts src/routes/auth/invite.test.ts
```

Expected: PASS for both lock orders and failure paths.

- [ ] **Step 7: Commit account/invite guards**

```bash
git add apps/api/src/routes/auth/register.ts apps/api/src/routes/auth/register.test.ts apps/api/src/routes/auth/invite.ts apps/api/src/routes/auth/invite.test.ts apps/api/src/routes/auth.test.ts apps/api/src/services/partnerCreate.ts apps/api/src/services/partnerCreate.test.ts apps/api/src/services/partnerActivation.ts apps/api/src/services/partnerActivation.test.ts
git commit -m "feat(auth): guard registration and invite issuance"
```

---

### Task 7: Implement terminal preparation and authoritative subject classification

**Files:**
- Modify: `apps/api/src/services/terminalLogout.ts`
- Modify: `apps/api/src/services/terminalLogout.test.ts`
- Modify: `apps/api/src/services/authLifecycle.ts`
- Modify: `apps/api/src/services/authLifecycle.test.ts`
- Modify: `apps/api/src/routes/auth/login.ts`
- Modify: `apps/api/src/routes/auth/login.test.ts`
- Create: `apps/api/src/__tests__/integration/auth-browser-transition.integration.test.ts`

**Interfaces:**
- Consumes: transition lock, durable JTI classification, family/epoch invalidation.
- Produces: `prepareTerminalLogout` returning a durable pending record and nonce material.

- [ ] **Step 1: Write failing A/B/C subject tests**

Cover:

- live bearer A plus current refresh B globally invalidates A and B;
- transition-linked just-issued C family is exactly revoked even when C differs;
- stale/rotated B does not globally revoke B;
- legacy-null B causes exact-family revocation only;
- revoked, expired, malformed, wrong-owner B is ignored for global selection;
- database classification failure returns 503 and rolls back transition pending state;
- Redis cleanup failure leaves durable revocation effective.

- [ ] **Step 2: Write real-DB lock-order tests**

Use explicit test barriers:

1. issuer final transaction locks transition first; prepare blocks; issuer commits family C; prepare proceeds and revokes C;
2. prepare locks transition first; issuer finalization resumes and rejects without writes.

Assert both access and refresh tokens fail after the terminal commit. Do not use timing sleeps as the ordering assertion.

- [ ] **Step 3: Implement one transactional terminal primitive**

`prepareTerminalLogout` locks transition, users, then families; marks pending and increments generation; advances verified user auth epochs; revokes all verified-user families; exactly revokes the linked current family; stores logout/nonce digest/expiry; returns counts and raw nonce only to the route layer.

- [ ] **Step 4: Make POST prepare strict-CSRF and fail closed**

Use `validateTerminalCookieCsrfRequest`. Clear only the refresh cookie after successful durable prepare. A 503 emits no navigation ticket and does not clear the binding needed for retry.

- [ ] **Step 5: Run focused and real-DB tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/terminalLogout.test.ts src/services/authLifecycle.test.ts src/routes/auth/login.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/auth-browser-transition.integration.test.ts
```

Expected: PASS for both lock orders and every B classification.

- [ ] **Step 6: Commit authoritative preparation**

```bash
git add apps/api/src/services/terminalLogout.ts apps/api/src/services/terminalLogout.test.ts apps/api/src/services/authLifecycle.ts apps/api/src/services/authLifecycle.test.ts apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/login.test.ts apps/api/src/__tests__/integration/auth-browser-transition.integration.test.ts
git commit -m "feat(auth): make terminal preparation transactional"
```

---

### Task 8: Add signed one-time Cloudflare completion and web navigation

**Files:**
- Create: `apps/api/src/services/terminalLogoutTicket.ts`
- Create: `apps/api/src/services/terminalLogoutTicket.test.ts`
- Modify: `apps/api/src/routes/auth/cfAccessRedirectLogin.ts`
- Modify: `apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts`
- Modify: `apps/api/src/routes/auth/login.ts`
- Modify: `apps/api/src/routes/auth/login.test.ts`
- Modify: `apps/web/src/stores/auth.ts`
- Modify: `apps/web/src/stores/auth.test.ts`
- Modify: `.env.example`
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/config/env.test.ts`
- Modify: `apps/api/src/config/validate.ts`
- Modify: `apps/api/src/config/validate.test.ts`

**Interfaces:**
- Consumes: pending logout record/nonce from Task 7.
- Produces: signed ticket, ticket-only GET navigation, cookie-less one-time completion, C1-to-C2 rotation.

- [ ] **Step 1: Write failing ticket unit tests**

Test valid round trip, 256-bit nonce, altered signature, audience, version, transition ID, logout ID, generation, nonce, and expiry. Assert logs/errors never contain the raw ticket.

- [ ] **Step 2: Implement domain-separated HMAC tickets**

Use a key derived from an existing required production secret with the label `terminal-logout-ticket:v1`. Encode only the specified fields. Verify signature before parsing authority fields and use timing-safe comparison.

- [ ] **Step 3: Write failing route tests**

Cover:

- prepare response supplies a ticket-bearing same-origin navigation URL;
- `/cf-access-logout` with no/invalid ticket performs no global revocation or transition mutation;
- configured origin, never Host, builds the return URL;
- completion succeeds with no Cookie header for SameSite Strict, Lax, and None configurations;
- two concurrent completions yield one mutation and idempotent signed-out redirects;
- old-generation/replayed ticket cannot retire a later binding;
- completion sets no-store/no-referrer, clears refresh/C1, sets C2, and returns 303.

- [ ] **Step 4: Implement ticket-only navigation and completion**

Remove refresh-cookie-derived global revocation from the GET route. Keep the existing Cloudflare app-domain then team-domain chain, but propagate the signed ticket to the completion URL. Completion consumes the nonce under a transition lock and rotates binding C1 to C2.

- [ ] **Step 5: Update the web logout flow**

`apiCfAccessLogout` requires a successful prepare response containing the server-provided navigation URL. It performs immediate local teardown, then navigates to that URL. If prepare fails, it leaves the server binding retryable and navigates only to a local signed-out/error page; it must not call the bare ticketless terminal GET as an authority fallback.

Keep Web Locks/local FIFO as UX serialization, not security authority.

- [ ] **Step 6: Add one-retry binding bootstrap**

The shared web auth request helper recognizes the specific 428 binding-rotation response, accepts C2 through Set-Cookie, and retries the original issuer exactly once. It does not retry an operation whose server callback already began.

- [ ] **Step 7: Run focused API and web tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/terminalLogoutTicket.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts src/routes/auth/login.test.ts
pnpm --filter=@breeze/web exec vitest run src/stores/auth.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit ticketed completion**

```bash
git add apps/api/src/services/terminalLogoutTicket.ts apps/api/src/services/terminalLogoutTicket.test.ts apps/api/src/routes/auth/cfAccessRedirectLogin.ts apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/login.test.ts apps/web/src/stores/auth.ts apps/web/src/stores/auth.test.ts .env.example apps/api/src/config/env.ts apps/api/src/config/env.test.ts apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts
git commit -m "feat(auth): add one-time terminal logout completion"
```

---

### Task 9: Guard CF redirect login and durable SSO callback/exchange

**Files:**
- Modify: `apps/api/src/routes/auth/cfAccessRedirectLogin.ts`
- Modify: `apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts`
- Modify: `apps/api/src/routes/sso.ts`
- Modify: `apps/api/src/routes/sso.test.ts`
- Modify: `apps/api/src/db/schema/sso.ts` only if Task 2 names need a forward-compatible adjustment.
- Modify: SSO integration tests under `apps/api/src/__tests__/integration/`.

**Interfaces:**
- Consumes: guarded issuance, transition-bearing SSO session, durable SSO grant.
- Produces: guarded issuer groups 4 and 8 plus guarded `/sso/exchange`.

- [ ] **Step 1: Write failing CF redirect overlap tests**

When logout pending wins, assert no last-login update, family, cookie, or success audit. When redirect issuance finalizes first, terminal prepare sees and revokes its linked family.

- [ ] **Step 2: Write failing SSO callback tests**

Cover:

- login-start stores transition ID/generation;
- callback after logout pending consumes no state and creates no user/link/encrypted token/family;
- callback finalization first creates one family that logout revokes;
- external IdP exchange may occur under a lease, but local identity/JIT writes happen only in finalization;
- replayed callback cannot replace the operation or state claim.

- [ ] **Step 3: Write failing exchange tests**

Cover exchange-before-logout, logout-before-exchange, concurrent one-time consumption across two app instances, expired grant, wrong binding generation, and revoked family. Only exchange-before-logout may set a usable cookie, and subsequent logout revokes it.

- [ ] **Step 4: Guard CF redirect issuance**

Resolve/admit the binding before final writes. Put last-login update, family creation, and binding current-family update in one finalization transaction. Set response cookies only from the authorized result.

- [ ] **Step 5: Persist SSO binding and operation claim**

Login-start writes transition ID/generation with the existing state/nonce/PKCE record. Callback claims the SSO state and issuance operation without performing identity writes, completes external verification, then finalizes state deletion, identity/JIT writes, last-login update, family issue, and durable grant creation in one transaction.

- [ ] **Step 6: Replace the process-local exchange grant**

Store only a hash of the exchange code. `/sso/exchange` locks transition, validates generation/state and active family, consumes the grant once, then authorizes cookie installation. Remove the in-memory map and its sweep helper.

- [ ] **Step 7: Activate the SSO inventory assertion**

Unskip the Task 1 SSO exchange contract and assert no production cookie writer can install a refresh token from an unguarded raw token pair.

- [ ] **Step 8: Run focused and SSO integration tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/auth/cfAccessRedirectLogin.test.ts src/routes/sso.test.ts src/services/userSession.callers.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ssoPartnerLogin.integration.test.ts src/__tests__/integration/auth-browser-transition.integration.test.ts
```

Expected: PASS across callback/exchange ordering and replay cases.

- [ ] **Step 9: Commit CF/SSO guards**

```bash
git add apps/api/src/routes/auth/cfAccessRedirectLogin.ts apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts apps/api/src/services/userSession.callers.test.ts apps/api/src/__tests__/integration
git commit -m "feat(auth): guard CF and SSO session exchange"
```

Stage only the integration files changed by this task.

---

### Task 10: Add native/mobile binding transport and terminal retries

**Files:**
- Modify: `apps/mobile/src/services/api.ts`
- Modify: `apps/mobile/src/services/api.logout.test.ts`
- Modify: `apps/mobile/src/services/api.mfa.test.ts`
- Modify: `apps/mobile/src/services/sessionGeneration.ts`
- Modify: `apps/mobile/src/services/sessionGeneration.test.ts`
- Modify: `apps/mobile/src/store/authSlice.ts`
- Modify: `apps/mobile/src/store/authSlice.test.ts`
- Modify: API binding resolution in `apps/api/src/services/authBrowserTransition.ts` and tests.

**Interfaces:**
- Consumes: Task 3 binding admission and existing SecureStore/session-generation FIFO.
- Produces: server-issued native binding header persisted in SecureStore; no cookie-omission bypass.

- [ ] **Step 1: Write failing native transport tests**

Test first-use 428 bootstrap, SecureStore persistence of the signed binding, one retry, subsequent issuer header, account switch, terminal generation cancellation, and failure to issue when neither browser nor native binding is present. Assert a raw `x-mobile-device-id` alone is insufficient.

- [ ] **Step 2: Add server-issued native binding**

Use a random server value with an HMAC signature and explicit native-binding audience/version. The API resolves browser cookie or native header into the same `AuthBindingSource`; an invalid or missing source returns 428 with a new signed native value for native requests.

- [ ] **Step 3: Serialize native bootstrap with the existing session FIFO**

Persist the new value in SecureStore inside the existing generation-fenced writer. Retry the original login/MFA/refresh exactly once after the binding write. Logout and terminal reauthentication invalidate queued retries before they can install credentials.

- [ ] **Step 4: Run focused mobile and API tests**

```bash
pnpm --filter=@breeze/mobile test -- --runInBand apps/mobile/src/services/api.logout.test.ts apps/mobile/src/services/api.mfa.test.ts apps/mobile/src/services/sessionGeneration.test.ts apps/mobile/src/store/authSlice.test.ts
pnpm --filter=@breeze/api exec vitest run src/services/authBrowserTransition.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit native binding transport**

```bash
git add apps/mobile/src/services/api.ts apps/mobile/src/services/api.logout.test.ts apps/mobile/src/services/api.mfa.test.ts apps/mobile/src/services/sessionGeneration.ts apps/mobile/src/services/sessionGeneration.test.ts apps/mobile/src/store/authSlice.ts apps/mobile/src/store/authSlice.test.ts apps/api/src/services/authBrowserTransition.ts apps/api/src/services/authBrowserTransition.test.ts
git commit -m "feat(auth): bind native session issuance"
```

---

### Task 11: Expiry recovery, cleanup, rollout flag, and quarantine removal

**Files:**
- Modify: `apps/api/src/services/authBrowserTransition.ts`
- Modify: `apps/api/src/services/authBrowserTransition.test.ts`
- Modify: `apps/api/src/routes/auth/helpers.ts`
- Modify: `apps/api/src/routes/auth/helpers.test.ts`
- Modify: `apps/api/src/routes/auth/cfAccessRedirectLogin.ts`
- Modify: `apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/config/env.test.ts`
- Modify: `apps/api/src/config/validate.ts`
- Modify: `apps/api/src/config/validate.test.ts`
- Modify: `.env.example`
- Create: `docs/operations/auth-browser-transition-rollout.md`

**Interfaces:**
- Consumes: complete durable path.
- Produces: bounded abandoned-flow recovery and removal of `breeze_cf_logout_quarantine` authority.

- [ ] **Step 1: Write failing recovery tests**

Cover:

- abandoned pending logout blocks C1 until expiry;
- first post-expiry issuer receives C2/428 and its one retry succeeds;
- C1 remains retired forever;
- abandoned operation lease is replaceable;
- old capability cannot finalize after replacement;
- replayed completion cannot retire C2;
- cleanup job may delete only retired rows older than the maximum request/family diagnostic retention and never an active/pending row.

- [ ] **Step 2: Add the guarded rollout flag**

Introduce an explicit production-safe flag such as `AUTH_BROWSER_TRANSITIONS_ENFORCED`. Startup must reject enabling terminal ticket preparation while issuer enforcement is disabled. Document the deployment order from the design.

- [ ] **Step 3: Remove boolean quarantine authority**

Delete `CF_ACCESS_LOGOUT_QUARANTINE_COOKIE_NAME`, `hasCfAccessLogoutQuarantine`, setter/clearer, and the `setRefreshTokenCookie` request-cookie check added in `675f66ac2`. The durable transition remains the sole authority. Keep compatibility cookie clearing for one release only if needed, but never consult it for authorization.

- [ ] **Step 4: Add bounded cleanup**

Use a scheduled/system cleanup that marks expired pending rows retired before later deletion. Report affected row counts. Cleanup is not required for correctness; issuer admission handles expiry synchronously.

- [ ] **Step 5: Run focused config/helper/recovery tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/authBrowserTransition.test.ts src/routes/auth/helpers.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts src/config
```

Expected: PASS, with no source reference treating the quarantine cookie as authority.

- [ ] **Step 6: Commit rollout and cleanup**

```bash
git add apps/api/src/services/authBrowserTransition.ts apps/api/src/services/authBrowserTransition.test.ts apps/api/src/routes/auth/helpers.ts apps/api/src/routes/auth/helpers.test.ts apps/api/src/routes/auth/cfAccessRedirectLogin.ts apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts apps/api/src/config/env.ts apps/api/src/config/env.test.ts apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts .env.example docs/operations/auth-browser-transition-rollout.md
git commit -m "fix(auth): retire response-cookie logout quarantine"
```

Stage only the operational documentation changed by this task; do not restage the design or plan commit.

---

### Task 12: Full validation and exact-diff security closure

**Files:**
- Modify: `docs/testing/FEATURE_TEST_LOG.md`
- Modify: `.superpowers/sdd/progress.md` and a task report under `.superpowers/sdd/` (ignored, not staged).
- Modify production/tests only for findings discovered by the closure review, each in a separate fix commit.

**Interfaces:**
- Consumes: Tasks 1–11.
- Produces: verified implementation and an exact-diff review package from `675f66ac2` to final HEAD.

- [ ] **Step 1: Run the complete API unit suite**

```bash
pnpm test --filter=@breeze/api
```

Expected: all API unit tests pass with zero failures.

- [ ] **Step 2: Run authoritative integration gates**

```bash
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/auth-browser-transition.integration.test.ts src/__tests__/integration/refresh-token-family.integration.test.ts src/__tests__/integration/ssoPartnerLogin.integration.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.config.rls.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/auth-browser-transition-rls.integration.test.ts
pnpm db:check-drift
```

Expected: both forced lock orders, RLS, SSO, current-JTI, and drift gates pass.

- [ ] **Step 3: Run web and mobile suites**

```bash
pnpm --filter=@breeze/web test
pnpm --filter=@breeze/mobile test -- --runInBand
```

Expected: all web tests pass; all mobile tests pass with only the repository's documented platform skips.

- [ ] **Step 4: Run type, lint, build, and diff gates**

```bash
pnpm --filter=@breeze/api typecheck
pnpm --filter=@breeze/web typecheck
pnpm --filter=@breeze/mobile typecheck
pnpm --filter=@breeze/api lint
pnpm --filter=@breeze/web lint
pnpm --filter=@breeze/api build
pnpm --filter=@breeze/web build
git diff --check 675f66ac2..HEAD
```

Expected: every command exits 0. Record inherited warnings separately; do not describe them as new failures.

- [ ] **Step 5: Perform the exact-diff security review**

Generate a review package for exactly:

```bash
git diff --find-renames --find-copies 675f66ac2..HEAD
```

Review these threat classes independently:

- row-lock ordering/deadlocks and both linearization orders;
- capability construction/bypass and unguarded issuer/cookie writers;
- stale refresh global-revocation authority;
- CSRF/binding fixation, rotation, and delayed C1 requests;
- ticket forgery, replay, leakage, origin handling, and SameSite independence;
- SSO callback/exchange replay and multi-instance durability;
- native binding spoofing and terminal generation races;
- RLS/system-context scope and migration rollout.

Every Critical, Important, or missing-test finding receives a TDD fix commit and a fresh exact-range re-review. Do not close on reviewer prose alone; rerun the affected focused tests and full gates.

- [ ] **Step 6: Update the feature log**

Document the final architecture, exact integration evidence, any live-browser environment gap, rollout flag state, and the fact that the migration remains additive with legacy-null current-JTI behavior.

- [ ] **Step 7: Final inventory proof**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/userSession.callers.test.ts
rg -n "issueUserSession\(" apps/api/src --glob '!**/*.test.ts'
rg -n "setRefreshTokenCookie\(" apps/api/src --glob '!**/*.test.ts'
rg -n "breeze_cf_logout_quarantine|hasCfAccessLogoutQuarantine" apps/api/src apps/web/src
```

Expected: the source contract passes; every issuer is guarded; every cookie writer consumes an authorized result; the old quarantine authority has no production references.

- [ ] **Step 8: Commit documentation/evidence only after all gates pass**

```bash
git add docs/testing/FEATURE_TEST_LOG.md
git commit -m "docs(testing): record browser transition verification"
```

Do not stage ignored SDD progress/report files.

---

## Deferred fix-forward migration

After at least the maximum 30-day family lifetime has elapsed with all API replicas dual-writing `current_refresh_jti_digest`, create a separate reviewed plan and migration to enforce `NOT NULL`. That later migration must batch/backfill or expire legacy rows with row-count warnings and must not edit `2026-07-12-a-auth-browser-transitions.sql`.

## Plan self-review checklist

- Spec coverage: schema/RLS, CSRF lifecycle, issuer lease/capability, lock order, terminal preparation, current-JTI authority, ticket completion, eight issuers, SSO exchange, native transport, failure consistency, rollout, and closure review each map to at least one task.
- Placeholder scan: the plan contains no deferred implementation placeholder; the only deferred item is an explicitly separate post-lifetime fix-forward migration.
- Type consistency: `AuthBindingSource`, `AuthIssuanceCapability`, `beginAuthIssuance`, `finishAuthIssuance`, and the guarded `issueUserSession` options are defined once and used consistently.
- Task sizing: schema, state machine, JTI authority, factor issuers, account/invite, preparation, completion, SSO, native, cleanup, and closure each have an independent RED/GREEN/review boundary and commit.
