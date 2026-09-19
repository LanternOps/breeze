# Durable Browser Authentication Transition Current-Main Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary and Cloudflare logout PostgreSQL-terminal against every browser and native session issuer, with durable refresh currentness, SSO exchange, and one-time cross-site completion.

**Architecture:** A dedicated server-signed binding selects one forced-RLS transition row. Issuers reserve a bounded operation lease, perform verification outside long transactions, then finalize every authority-granting write under the transition lock and an opaque capability. Ordinary logout retires the binding synchronously; Cloudflare logout records a pending generation and completes through a signed one-time ticket. Redis remains post-commit acceleration only.

**Tech Stack:** Hono, TypeScript, Drizzle ORM, PostgreSQL row locks/RLS, Vitest, BullMQ/Redis, Astro/React, React Native/Expo SecureStore, Playwright.

## Global Constraints

- Start each slice from `origin/main` at or after `dfe02c5e6`; do not merge or copy `fix/core-mfa-policy-assurance` wholesale.
- The approved 2026-07-12 design remains normative except for `docs/superpowers/specs/security-auth/2026-08-23-auth-browser-transition-current-main-delta.md`.
- Preserve current-main epoch, MFA, SSO, email-first registration, trusted-client-IP, origin-validation, and cookie-transport behavior.
- Use the new idempotent migration `apps/api/migrations/2026-08-23-z-auth-browser-transitions.sql`; never reuse the preserved branch's July migrations.
- Enable and force RLS on both new tables in the creation migration. Exactly one system-only `ALL` policy must protect each table.
- PostgreSQL decides binding state, family state, refresh currentness, security epochs, SSO grant consumption, and logout ordering. Redis cannot grant authority.
- No transaction or row lock spans password hashing, email, webhooks, OIDC discovery, IdP token exchange, or another network call.
- Global lock order is transition, users sorted by UUID, refresh families sorted by UUID, then route-specific rows in stable key order.
- The browser binding cookie is `breeze_auth_binding`, host-only, path `/`, HttpOnly, and uses the same trusted-transport `Secure` and configured `SameSite` decisions as the refresh cookie. It is not the CSRF cookie.
- The native header is `x-breeze-native-auth-binding`; `x-breeze-mobile-device-id` is metadata only.
- Terminal Cloudflare preparation remains disabled until every issuer is guarded and every API replica runs the compatible build.
- During W07-B through the native-capable W07-F rollout, a source-contract-frozen `issueUserSessionLegacyDuringTransition` seam preserves clients that do not advertise transition-v1 while enforcement is false. W07-F deletes it only after the documented mobile release/telemetry gate, then activates the zero-bypass contract.
- Use deterministic database barriers for race tests; do not use sleeps as ordering assertions.
- Strict TDD applies to each slice: observe the focused failure, implement, pass focused tests, then commit the slice. Do not push, merge, deploy, or enable production flags from this plan.

---

## File and interface map

### New files

- `apps/api/migrations/2026-08-23-z-auth-browser-transitions.sql` — additive transition/grant/current-JTI/SSO-binding schema and forced RLS.
- `apps/api/src/db/schema/authBrowserTransitions.ts` — transition and SSO grant Drizzle schemas.
- `apps/api/src/services/authBrowserTransition.ts` — signed binding, lease, capability, successor, retirement, and cleanup state machine.
- `apps/api/src/services/authBrowserTransition.test.ts` — state-machine and key-rotation tests.
- `apps/api/src/services/userSession.ts` — sole guarded user-session issuer and temporary rollout seam.
- `apps/api/src/services/userSession.test.ts` — transaction/capability/current-JTI unit tests.
- `apps/api/src/services/userSession.callers.test.ts` — compiler/source inventory contract.
- `apps/api/src/services/recoveryCodeAuth.ts` — atomic recovery-code consumption plus guarded issuance.
- `apps/api/src/services/recoveryCodeAuth.test.ts` — recovery concurrency and rollback tests.
- `apps/api/src/services/ssoBrowserTransition.ts` — stored-transition callback claim and durable exchange grant.
- `apps/api/src/services/ssoBrowserTransition.test.ts` — sealed-code and grant tests.
- `apps/api/src/services/terminalLogout.ts` — ordinary and CF terminal primitives.
- `apps/api/src/services/terminalLogout.test.ts` — subject classification and durable failure tests.
- `apps/api/src/services/terminalLogoutTicket.ts` — signed completion ticket.
- `apps/api/src/services/terminalLogoutTicket.test.ts` — ticket integrity/replay inputs.
- `apps/api/src/routes/auth/binding.ts` — browser-binding bootstrap endpoint and request transport helpers.
- `apps/api/src/routes/auth/binding.test.ts` — bootstrap, origin, cookie, and retry response tests.
- `apps/api/src/jobs/authBrowserTransitionCleanup.ts` and `.test.ts` — bounded expired-pending retirement worker.
- `apps/api/src/__tests__/integration/auth-browser-transition-rls.integration.test.ts` — tenant-denial/system-success RLS forge.
- `apps/api/src/__tests__/integration/auth-browser-transition.integration.test.ts` — issuer/logout and refresh CAS barriers.
- `apps/api/src/__tests__/integration/sso-browser-transition.integration.test.ts` — cross-replica callback/exchange ordering.
- `apps/mobile/src/services/sessionGeneration.ts` and `.test.ts` — generation-fenced native binding/token writes.
- `apps/mobile/src/services/api.logout.test.ts` — native logout/binding retry regressions.
- `apps/mobile/src/services/api.mfa.test.ts` — native MFA binding and stale-completion regressions.
- `apps/web/src/components/layout/Header.test.tsx` — ordinary/Cloudflare logout failure UX regressions.
- `e2e-tests/browser-contracts/auth-browser-transition.spec.ts` — live Chromium logout/late-response contract.
- `e2e-tests/playwright.auth-browser-transition.config.ts` — isolated browser contract configuration.
- `docs/operations/auth-browser-transition-rollout.md` — fleet rollout and rollback runbook.

### Existing files with central changes

- `apps/api/src/db/schema/{index,refreshTokenFamilies,sso}.ts`
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- `apps/api/src/services/{index,refreshTokenFamily,authLifecycle,tokenRevocation}.ts`
- `apps/api/src/routes/auth/{index,helpers,login,mfa,passkeys,verifyEmail,invite,cfAccessRedirectLogin}.ts`
- `apps/api/src/middleware/cfAccessLogin.ts`
- `apps/api/src/routes/sso.ts`
- `apps/api/src/config/{env,env.test,validate,validate.test}.ts`
- `apps/api/src/index.ts`
- `apps/web/src/stores/{auth,auth.test}.ts`
- `apps/web/src/components/auth/{LoginPage,LoginPage.test}.tsx`
- `apps/web/src/components/layout/Header.tsx`
- `apps/mobile/src/services/api.ts`
- `apps/mobile/src/store/{authSlice,authSlice.test}.ts`
- `.env.example`, `.github/workflows/ci.yml`, `docs/testing/FEATURE_TEST_LOG.md`

### Stable interfaces

```ts
import type { Context } from 'hono';
import type { Tx } from './authLifecycle';

declare const authIssuanceCapabilityBrand: unique symbol;
declare const authorizedUserSessionBrand: unique symbol;

export type AuthBindingSource =
  | Readonly<{ kind: 'browser'; value: string }>
  | Readonly<{ kind: 'native'; value: string }>;

export type AuthIssuanceCapability = Readonly<{
  transitionId: string;
  generation: number;
  operationId: string;
  expiresAt: Date;
  readonly [authIssuanceCapabilityBrand]: true;
}>;

export type AuthorizedUserSession = Readonly<TokenPair & {
  familyId: string;
  transitionId: string;
  generation: number;
  readonly [authorizedUserSessionBrand]: true;
}>;

export async function beginAuthIssuance(
  source: AuthBindingSource,
): Promise<AuthIssuanceCapability>;

export async function beginAuthIssuanceForStoredTransition(
  input: Readonly<{ transitionId: string; generation: number }>,
  claim: (tx: Tx) => Promise<typeof ssoSessions.$inferSelect>,
): Promise<Readonly<{ capability: AuthIssuanceCapability; claimed: typeof ssoSessions.$inferSelect }>>;

export async function finishAuthIssuance<T>(
  capability: AuthIssuanceCapability,
  callback: (tx: Tx) => Promise<T>,
): Promise<T>;

export async function cancelAuthIssuance(
  capability: AuthIssuanceCapability,
): Promise<void>;

export async function issueUserSession(
  identity: UserSessionIdentity,
  options: {
    tx: Tx;
    capability: AuthIssuanceCapability;
    familyId?: string;
    refreshRotation?: {
      presentedJti: string;
      authEpoch: number;
      mfaEpoch: number;
    };
  },
): Promise<AuthorizedUserSession>;

export function installAuthorizedUserSessionCookies(
  c: Context,
  issued: AuthorizedUserSession,
): void;

export type RefreshAuthority =
  | Readonly<{ kind: 'current'; userId: string; familyId: string }>
  | Readonly<{ kind: 'legacy_or_stale_family'; familyId: string }>
  | Readonly<{ kind: 'invalid' }>;
```

The capability and authorized-session result use module-private runtime symbols. The declarations above document the brands; route code cannot construct either value from request data or pass an unguarded raw token pair to the cookie installer.

---

### Task 1 (W07-A): Add schema, binding state machine, durable currentness, and inventory

**Files:**
- Create: `apps/api/migrations/2026-08-23-z-auth-browser-transitions.sql`
- Create: `apps/api/src/db/schema/authBrowserTransitions.ts`
- Create: `apps/api/src/services/authBrowserTransition.ts`
- Create: `apps/api/src/services/authBrowserTransition.test.ts`
- Create: `apps/api/src/services/userSession.callers.test.ts`
- Create: `apps/api/src/routes/auth/binding.ts`
- Create: `apps/api/src/routes/auth/binding.test.ts`
- Create: `apps/api/src/__tests__/integration/auth-browser-transition-rls.integration.test.ts`
- Modify: `apps/api/src/db/schema/{index,refreshTokenFamilies,sso}.ts`
- Modify: `apps/api/src/services/{index,refreshTokenFamily}.ts`
- Modify: `apps/api/src/services/secretCrypto.ts` and `.test.ts`
- Modify: `apps/api/src/routes/auth/index.ts`
- Modify: `apps/api/src/routes/auth/helpers.ts`
- Modify: `apps/api/src/routes/auth/helpers.test.ts`
- Modify: `apps/api/vitest.config.rls.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

**Interfaces:**
- Consumes: current `withSystemDbAccessContext`, `runOutsideDbContext`, trusted cookie transport helpers, the active/retained `APP_ENCRYPTION_KEY` keyring, refresh-family schema, and existing SSO session schema.
- Produces: the stable binding/capability interfaces above; `AUTH_BINDING_COOKIE_NAME`, `NATIVE_AUTH_BINDING_HEADER`, `requestAuthBinding`, `installAuthBindingReplacement`; durable family currentness helpers.

- [ ] **Step 1: Freeze the current issuer and cookie-writer inventory**

Write `userSession.callers.test.ts` so a source scan asserts exactly these token issuers:

```ts
const expectedCreateTokenPairFiles = new Set([
  'middleware/cfAccessLogin.ts',
  'routes/auth/cfAccessRedirectLogin.ts',
  'routes/auth/invite.ts',
  'routes/auth/login.ts',
  'routes/auth/mfa.ts',
  'routes/auth/passkeys.ts',
  'routes/auth/verifyEmail.ts',
  'routes/sso.ts',
]);

const expectedCookieWriterFiles = new Set([
  'middleware/cfAccessLogin.ts',
  'routes/auth/cfAccessRedirectLogin.ts',
  'routes/auth/invite.ts',
  'routes/auth/login.ts',
  'routes/auth/mfa.ts',
  'routes/auth/passkeys.ts',
  'routes/auth/verifyEmail.ts',
  'routes/sso.ts',
]);
```

Assert nine production `createTokenPair(` calls and nine `setRefreshTokenCookie(` calls, including the second `login.ts` call and `/sso/exchange`. Add skipped final-state assertions named `requires guarded capability at every issuer`, `has no legacy session issuer export`, and `has no process-local SSO exchange grant`.

- [ ] **Step 2: Write failing migration/RLS/state tests**

The RLS test must connect as `breeze_app` and forge a normal org context. For both new system-only tables, assert SELECT returns zero rows, UPDATE affects zero rows, and INSERT fails its `WITH CHECK` policy. The system branch inserts, reads, and updates one row. State tests cover deterministic HMAC, invalid/missing binding bootstrap, one active lease, competing lease conflict, expired lease replacement, retired/pending rejection, wrong capability/generation rejection, callback rollback, successor creation, and permanent predecessor denial.

As test plumbing, extend `vitest.config.rls.ts` to include the existing `rls.integration.test.ts` and the new forge test explicitly before running the red test. Keep `rls-coverage.integration.test.ts` on its dedicated no-truncate `vitest.config.rls-coverage.ts` runner.

Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/services/userSession.callers.test.ts src/services/authBrowserTransition.test.ts src/routes/auth/binding.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.config.rls.ts src/__tests__/integration/auth-browser-transition-rls.integration.test.ts
```

Expected: inventory passes; new service/schema tests fail because their modules and tables do not exist.

- [ ] **Step 3: Add the additive migration and matching schemas**

Use this table shape and named constraints in the migration:

```sql
CREATE TABLE IF NOT EXISTS auth_browser_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_digest varchar(64) NOT NULL,
  binding_key_id varchar(128),
  generation bigint NOT NULL DEFAULT 1,
  state varchar(24) NOT NULL DEFAULT 'active',
  active_operation_id uuid,
  active_operation_expires_at timestamptz,
  current_user_id uuid,
  current_family_id uuid,
  logout_id uuid,
  completion_nonce_digest varchar(64),
  logout_expires_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE refresh_token_families
  ADD COLUMN IF NOT EXISTS current_refresh_jti_digest varchar(64);
ALTER TABLE sso_sessions ADD COLUMN IF NOT EXISTS browser_transition_id uuid;
ALTER TABLE sso_sessions ADD COLUMN IF NOT EXISTS browser_generation bigint;

CREATE TABLE IF NOT EXISTS sso_token_exchange_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_digest varchar(64) NOT NULL,
  browser_transition_id uuid NOT NULL,
  browser_generation bigint NOT NULL,
  user_id uuid NOT NULL,
  family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Add idempotent `DO $$` blocks for unique binding/code digests, `(family_id,user_id)`, composite family ownership, SSO transition foreign keys, generation/digest/pair/state checks, and indexes on logout expiry, current family, retired state, grant expiry, and grant transition/generation. Enable and force RLS, then create one `ALL` policy per new table with:

```sql
USING (current_setting('breeze.scope', true) = 'system')
WITH CHECK (current_setting('breeze.scope', true) = 'system')
```

Register both tables in `INTENTIONAL_UNSCOPED`. Add matching Drizzle definitions; retain all new rollout columns as nullable where specified by the delta.

- [ ] **Step 4: Implement the dedicated binding transport and bootstrap route**

Keep CSRF untouched. Add helpers with the current connection-security input:

```ts
export const AUTH_BINDING_COOKIE_NAME = 'breeze_auth_binding';
export const NATIVE_AUTH_BINDING_HEADER = 'x-breeze-native-auth-binding';

export function buildAuthBindingCookie(value: string, connectionSecure: boolean): string;
export function buildClearAuthBindingCookie(connectionSecure: boolean): string;
export function requestAuthBinding(c: Context): AuthBindingSource;
export function installAuthBindingReplacement(c: Context, source: AuthBindingSource): void;
```

`POST /browser-binding/bootstrap` requires an allowed `Origin` when present and rejects `Sec-Fetch-Site: cross-site`. It creates or validates one browser binding, installs the HttpOnly cookie, returns `204`, and never creates account/session authority. Binding-aware clients with missing or invalid bindings receive `428` with the replacement cookie/header. Until enforcement, clients that do not advertise transition-v1 remain on the frozen legacy issuer path; after enforcement they receive `426` with `reason: auth_client_upgrade_required`, never a security downgrade.

- [ ] **Step 5: Implement the lease/capability and durable current-JTI helpers**

Use database `now()` for lease decisions. Add a tested `getSecretDerivedKeyMaterials(domain)` boundary in `secretCrypto.ts` that derives domain-separated HMAC keys from the active and retained `APP_ENCRYPTION_KEY` keyring without exposing the master material; record its key ID in `binding_key_id`. Store only HMAC digests, use every retained derived key for verification, never reopen a retired row, and make the successor deterministic per predecessor/generation so concurrent bootstrap retries converge.

Add these refresh helpers:

```ts
// W07-A rollout overload for the frozen pre-guard issuer inventory only.
export async function mintRefreshTokenFamily(userId: string): Promise<string>;
export async function mintRefreshTokenFamily(
  userId: string,
  currentRefreshJti: string,
  options?: { tx?: Tx },
): Promise<string>;

export async function rotateRefreshTokenFamilyCurrentJti(
  tx: Tx,
  input: { familyId: string; userId: string; presentedJti: string; successorJti: string },
): Promise<void>;

export async function classifyRefreshTokenAuthority(
  tx: Tx,
  token: string,
): Promise<RefreshAuthority>;
```

Hash JTIs with a domain-separated SHA-256/HMAC helper. The one-argument rollout overload writes a null digest and is permitted only for the exact frozen legacy callers from Step 1; W07-B's guarded issuer must use the JTI-bearing overload, and W07-F deletes the rollout overload after the caller contract proves zero one-argument calls. Only an exact current digest with live owner/epochs/family returns `current`; null or mismatched digest returns `legacy_or_stale_family`; malformed, wrong-owner, revoked, or expired input returns `invalid`.

- [ ] **Step 6: Run schema and focused gates**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/userSession.callers.test.ts src/services/authBrowserTransition.test.ts src/routes/auth/binding.test.ts src/services/refreshTokenFamily.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.config.rls.ts src/__tests__/integration/auth-browser-transition-rls.integration.test.ts
pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter=@breeze/api exec vitest run src/db/autoMigrate.test.ts
pnpm db:check-drift
pnpm --filter=@breeze/api exec tsc --noEmit
pnpm --filter=@breeze/api build
```

Expected: all pass; migration reapplication is a no-op and tenant forges are denied.

- [ ] **Step 7: Commit W07-A**

```bash
git add apps/api/migrations/2026-08-23-z-auth-browser-transitions.sql apps/api/src/db/schema apps/api/src/services/authBrowserTransition.ts apps/api/src/services/authBrowserTransition.test.ts apps/api/src/services/userSession.callers.test.ts apps/api/src/services/refreshTokenFamily.ts apps/api/src/services/refreshTokenFamily.test.ts apps/api/src/services/secretCrypto.ts apps/api/src/services/secretCrypto.test.ts apps/api/src/routes/auth/binding.ts apps/api/src/routes/auth/binding.test.ts apps/api/src/routes/auth/index.ts apps/api/src/routes/auth/helpers.ts apps/api/src/routes/auth/helpers.test.ts apps/api/vitest.config.rls.ts apps/api/src/__tests__/integration/auth-browser-transition-rls.integration.test.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(auth): add durable browser transition foundation"
```

Deployment state: schema and bootstrap are safe; no terminal endpoint is enabled and existing issuance behavior remains available.

---

### Task 2 (W07-B): Guard password, refresh, MFA, passkey, and recovery issuance

**Files:**
- Create: `apps/api/src/services/userSession.ts`
- Create: `apps/api/src/services/userSession.test.ts`
- Create: `apps/api/src/services/recoveryCodeAuth.ts`
- Create: `apps/api/src/services/recoveryCodeAuth.test.ts`
- Create: `apps/api/src/__tests__/integration/auth-browser-transition.integration.test.ts`
- Modify: `apps/api/src/services/index.ts`
- Modify: `apps/api/src/services/userSession.callers.test.ts`
- Modify: `apps/api/src/routes/auth/{helpers,login,mfa,passkeys}.ts`
- Modify: `apps/api/src/routes/auth/{helpers,login}.test.ts`
- Modify: `apps/api/src/routes/auth.test.ts` and `apps/api/src/routes/auth.passkeys.test.ts`
- Modify: `apps/api/src/middleware/cfAccessLogin.ts` and `.test.ts`
- Modify: `apps/web/src/stores/auth.ts` and `.test.ts`

**Interfaces:**
- Consumes: W07-A capabilities and current-JTI helpers; current-main MFA policy/epoch logic.
- Produces: guarded `issueUserSession`, branded `AuthorizedUserSession`, `installAuthorizedUserSessionCookies`, pending-MFA transition binding, and a temporary explicitly named rollout seam whose exact callers are frozen.

- [ ] **Step 1: Write failing guarded-issuer and race tests**

Add a table-driven matrix for password direct issue, CF XHR direct issue, TOTP, SMS, recovery code, passkey, and refresh. For each, force logout-pending after admission and before finalization. Assert no usable family/cookie, no recovery hash consumption, no passkey counter update, no TOTP migration, no last-login update, and no success audit. Add real-DB barriers proving exactly one concurrent refresh successor and both transition/logout lock orders.

Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/services/userSession.test.ts src/services/recoveryCodeAuth.test.ts src/routes/auth/login.test.ts src/routes/auth.test.ts src/routes/auth.passkeys.test.ts src/middleware/cfAccessLogin.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/auth-browser-transition.integration.test.ts src/__tests__/integration/refresh-token-family.integration.test.ts
```

Expected: fail at the first unguarded issuer or pre-finalization side effect.

- [ ] **Step 2: Implement the sole guarded issuer**

`issueUserSession` first asserts the capability under the already-locked transition, locks the user, validates live epochs, pre-generates the successor JTI, inserts or compare-and-swaps the family JTI, creates the pair, and records `current_user_id/current_family_id` before commit. It returns the branded `AuthorizedUserSession`; routes install its cookies only through `installAuthorizedUserSessionCookies`, which rejects ordinary `TokenPair` values at compile time.

The temporary seam is explicit and unavailable when enforcement is true:

```ts
export async function issueUserSessionLegacyDuringTransition(
  identity: UserSessionIdentity,
): Promise<TokenPair & { familyId: string }> {
  if (authBrowserTransitionsEnforced()) {
    throw new Error('Legacy user-session issuance is disabled');
  }
  // Preserve the pre-W07 family + token behavior only for frozen rollout callers.
}
```

The caller contract fails if this export gains a caller not listed by the current slice. It also proves that `setRefreshTokenCookie` is reachable from ordinary issuer routes only through `installAuthorizedUserSessionCookies`; the SSO exchange remains the sole separately authorized installation boundary.

- [ ] **Step 3: Bind pending MFA and move factor effects into finalization**

Extend `PendingMfaRecord` with:

```ts
transitionId: string;
browserGeneration: number;
```

Password/CF primary verification admits the binding after credential verification. Pending creation records the generation in a short finalization. Factor completion starts a new lease and rejects a different generation before consuming local authority. Recovery hash deletion, passkey counter update, TOTP secret migration, last-login update, and family issue occur in the final callback. External SMS verification may precede finalization; a rejected finalization never grants a session.

- [ ] **Step 4: Move refresh rotation to the guarded compare-and-swap**

After signature/type/rate checks and context resolution, begin issuance and call:

```ts
const issued = await finishAuthIssuance(capability, (tx) =>
  issueUserSession(identity, {
    tx,
    capability,
    familyId: payload.fam,
    refreshRotation: {
      presentedJti: payload.jti,
      authEpoch: user.authEpoch,
      mfaEpoch: user.mfaEpoch,
    },
  }),
);
```

Redis rotated/revoked markers and `bindRefreshJtiToFamily` run only after commit. A compare-and-swap loser returns `reason: refresh_raced` without clearing a winning sibling's cookie.

- [ ] **Step 5: Add the browser one-retry behavior**

In the web auth store, wrap only pre-authority issuer requests:

```ts
async function fetchAuthIssuerWithBindingRetry(input: RequestInfo, init: RequestInit): Promise<Response> {
  const first = await fetch(input, init);
  if (first.status !== 428) return first;
  return fetch(input, init);
}
```

The retry occurs once because the 428 response has already installed the HttpOnly binding cookie. Do not retry 409, 401, or a response indicating finalization began. Cover login, MFA, passkey, and refresh.

At each converted route, dispatch explicitly: valid binding uses guarded issuance; a binding-aware client with a missing/invalid binding gets 428; a client with no transition-v1 capability uses only the frozen legacy seam while enforcement is false; and any legacy client gets 426 once enforcement is true. Freeze this matrix and the exact legacy callers in `userSession.callers.test.ts`. Web served by this API release is binding-aware; native advertises `x-breeze-auth-transition: v1` only after W07-F persists the native binding.

Increment `auth_transition_legacy_issuer_total` by issuer and client class on every seam use so the W07-F retirement gate has auditable evidence.

- [ ] **Step 6: Pass focused and race gates**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/userSession.test.ts src/services/recoveryCodeAuth.test.ts src/services/userSession.callers.test.ts src/routes/auth/login.test.ts src/routes/auth.test.ts src/routes/auth.passkeys.test.ts src/middleware/cfAccessLogin.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/auth-browser-transition.integration.test.ts src/__tests__/integration/refresh-token-family.integration.test.ts
pnpm --filter=@breeze/web exec vitest run src/stores/auth.test.ts
```

Expected: every listed primary/factor issuer is guarded for transition-v1 clients, while enforcement-false legacy clients remain functional only through the frozen seam.

- [ ] **Step 7: Commit W07-B**

```bash
git add apps/api/src/services/userSession.ts apps/api/src/services/userSession.test.ts apps/api/src/services/recoveryCodeAuth.ts apps/api/src/services/recoveryCodeAuth.test.ts apps/api/src/services/userSession.callers.test.ts apps/api/src/routes/auth apps/api/src/routes/auth.test.ts apps/api/src/routes/auth.passkeys.test.ts apps/api/src/middleware/cfAccessLogin.ts apps/api/src/middleware/cfAccessLogin.test.ts apps/api/src/__tests__/integration/auth-browser-transition.integration.test.ts apps/api/src/__tests__/integration/refresh-token-family.integration.test.ts apps/web/src/stores/auth.ts apps/web/src/stores/auth.test.ts
git commit -m "feat(auth): guard primary and MFA session issuance"
```

Deployment state: new web clients use guarded issuance; enforcement false preserves old clients and unconverted issuers.

---

### Task 3 (W07-C): Guard email verification, invite acceptance, and CF redirect issuance

**Files:**
- Modify: `apps/api/src/routes/auth/{verifyEmail,invite,cfAccessRedirectLogin}.ts`
- Modify: `apps/api/src/routes/auth/{verifyEmail,cfAccessRedirectLogin}.test.ts`
- Create: `apps/api/src/routes/auth/invite.test.ts`
- Modify: `apps/api/src/services/{partnerCreate,partnerCreate.test,partnerActivation,partnerActivation.test}.ts`
- Modify: `apps/api/src/services/userSession.callers.test.ts`

**Interfaces:**
- Consumes: guarded issuer and binding replacement helpers.
- Produces: guarded account/invite/CF redirect issuer groups with no pre-finalization account authority writes.

- [ ] **Step 1: Write failing overlap tests**

For `verifyEmail`, force logout after binding admission and assert no partner, organization, admin user, membership, role, activation, family, cookie, or success audit commits. For invite, assert password/status/epoch/family and Redis invite state remain unchanged when logout wins. For CF redirect, assert no last-login/family/cookie when logout wins. Add inverse-order tests proving logout revokes the just-issued family.

Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/auth/verifyEmail.test.ts src/routes/auth/invite.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts
```

Expected: fail because current-main writes occur outside transition finalization.

- [ ] **Step 2: Guard email-first registration finalization**

Do not add token issuance back to `register.ts`. In `verifyEmail.ts`, admit before consuming the pending verification authority, then use one finalization transaction for pending-token claim, partner/user/org/membership creation, activation epochs, family issuance, and response state. Email/webhook work runs after commit.

If a direct verification GET has no binding, install C1 and return `303` to the same sanitized verification path without claiming the token. The second request carries C1 and may finalize. Never include a binding value in the URL.

- [ ] **Step 3: Guard invite and CF redirect finalization**

Invite password/status/epoch changes, old-family revocation, new family issue, and pending invite claim share one finalization. Delete Redis invite keys after commit. CF redirect performs last-login update and family issuance in one finalization after Access-JWT verification.

Both routes use this failure mapping:

```ts
if (error instanceof AuthBindingRotationRequiredError) {
  installAuthBindingReplacement(c, error.replacement);
  return c.json({ error: 'Authentication binding refresh required', reason: 'binding_refresh' }, 428);
}
if (error instanceof AuthBindingUnavailableError || error instanceof AuthIssuanceConflictError) {
  return c.json({ error: 'Authentication temporarily unavailable' }, 409);
}
```

- [ ] **Step 4: Update and activate inventory assertions for these callers**

Remove direct `createTokenPair` expectations for `verifyEmail.ts`, `invite.ts`, and `cfAccessRedirectLogin.ts`. Assert each calls `issueUserSession` only inside `finishAuthIssuance`. Keep SSO and final legacy-removal assertions pending until W07-D/F.

- [ ] **Step 5: Run focused tests and commit W07-C**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/auth/verifyEmail.test.ts src/routes/auth/invite.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts src/services/userSession.callers.test.ts
git add apps/api/src/routes/auth/verifyEmail.ts apps/api/src/routes/auth/verifyEmail.test.ts apps/api/src/routes/auth/invite.ts apps/api/src/routes/auth/invite.test.ts apps/api/src/routes/auth/cfAccessRedirectLogin.ts apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts apps/api/src/services/userSession.callers.test.ts apps/api/src/services/partnerCreate.ts apps/api/src/services/partnerCreate.test.ts apps/api/src/services/partnerActivation.ts apps/api/src/services/partnerActivation.test.ts
git commit -m "feat(auth): guard account and redirect session issuance"
```

Expected: focused tests and inventory pass.

Deployment state: all non-SSO browser issuers are guarded for upgraded clients; terminal preparation remains disabled.

---

### Task 4 (W07-D): Bind SSO initiation/callback and replace the process-local exchange

**Files:**
- Create: `apps/api/src/services/ssoBrowserTransition.ts`
- Create: `apps/api/src/services/ssoBrowserTransition.test.ts`
- Create: `apps/api/src/__tests__/integration/sso-browser-transition.integration.test.ts`
- Modify: `apps/api/src/routes/sso.ts` and `.test.ts`
- Modify: `apps/api/src/db/schema/sso.ts`
- Modify: `apps/api/src/services/userSession.callers.test.ts`
- Modify: `apps/web/src/components/auth/LoginPage.tsx` and `.test.tsx`
- Modify: `UPGRADING.md`
- Modify: `docs/security/SECURITY_PRACTICES.md`
- Modify: `docs/release-notes/security-hardening-template.md`

**Interfaces:**
- Consumes: W07-A stored-transition admission and W07-B guarded issuer.
- Produces: `claimSsoCallbackIssuance`, `createDurableSsoExchangeGrant`, `consumeDurableSsoExchangeGrant`; no process-local grant map or refresh-token JSON compatibility path.

- [ ] **Step 1: Write failing SSO bootstrap/callback/exchange tests**

Cover login-page bootstrap before partner SSO navigation and CF redirect-login navigation; login-start persisting transition/generation; provider-version drift; callback after logout; callback-first then logout; replayed callback; two-replica exchange; expired/wrong-generation/revoked-family grants; and no `refreshToken` JSON field under any environment value.

Run:

```bash
pnpm --filter=@breeze/web exec vitest run src/components/auth/LoginPage.test.tsx
pnpm --filter=@breeze/api exec vitest run src/services/ssoBrowserTransition.test.ts src/routes/sso.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/sso-browser-transition.integration.test.ts src/__tests__/integration/ssoPartnerLogin.integration.test.ts
```

Expected: fail on missing stored binding and process-local exchange behavior.

- [ ] **Step 2: Bootstrap before full-page SSO/CF navigation**

Replace the raw partner SSO anchor and CF automatic redirect with a shared action:

```ts
async function bootstrapThenNavigate(url: string): Promise<void> {
  const response = await fetch(buildApiUrl('/auth/browser-binding/bootstrap'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error('Authentication bootstrap failed');
  window.location.assign(url);
}
```

Disable the button while bootstrapping and show the existing login error surface on failure. SSO initiation refuses to create `sso_sessions` without a valid C1.

- [ ] **Step 3: Persist callback binding and claim under the stored generation**

SSO login-start stores `browserTransitionId/browserGeneration` alongside existing `providerVersion`. `claimSsoCallbackIssuance(state)` reserves that exact generation and deletes the state in the admission transaction before external IdP work. Finalization performs JIT/membership/identity/token/last-login/grant writes under transition → user → family → identity/grant order. Link-mode keeps its existing initiating epoch/session checks and mints no session.

- [ ] **Step 4: Implement the durable encrypted-code exchange**

Use authenticated encryption with AAD `sso-token-exchange-grant.code:v1` for this client-carried payload:

```ts
export type SsoExchangeTokenHandoff = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}>;
```

Store only `SHA-256(code)` and transition/user/family metadata in PostgreSQL. Consumption verifies/decrypts the code, then locks transition, user, family, and grant; it sets `consumed_at` once and returns the handoff only if generation/current-family/live-family checks pass.

Delete the direct `SSO_EXCHANGE_RETURN_REFRESH_TOKEN` `envFlag` branch from route code/tests and active operator/security documentation. Current `main` has no typed config or `.env.example` declaration for this flag. Replace current upgrade guidance with a concise note that W07 removed the expired compatibility response; preserve historical dated reports unchanged. `/sso/exchange` returns only `{ accessToken, expiresInSeconds }` and installs the refresh token via `setRefreshTokenCookie` after authorized consumption.

- [ ] **Step 5: Activate the SSO inventory assertions**

Assert no process-local `Map` grant, no `createTokenPair` call in `sso.ts`, and no refresh cookie write from an unconsumed raw token pair. Assert callback calls `issueUserSession` inside finalization and exchange consumes the durable grant before cookie installation.

- [ ] **Step 6: Run SSO gates and commit W07-D**

```bash
pnpm --filter=@breeze/web exec vitest run src/components/auth/LoginPage.test.tsx
pnpm --filter=@breeze/api exec vitest run src/services/ssoBrowserTransition.test.ts src/routes/sso.test.ts src/services/userSession.callers.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/sso-browser-transition.integration.test.ts src/__tests__/integration/ssoPartnerLogin.integration.test.ts
git add apps/api/src/services/ssoBrowserTransition.ts apps/api/src/services/ssoBrowserTransition.test.ts apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts apps/api/src/db/schema/sso.ts apps/api/src/services/userSession.callers.test.ts apps/api/src/__tests__/integration/sso-browser-transition.integration.test.ts apps/api/src/__tests__/integration/ssoPartnerLogin.integration.test.ts UPGRADING.md docs/security/SECURITY_PRACTICES.md docs/release-notes/security-hardening-template.md apps/web/src/components/auth/LoginPage.tsx apps/web/src/components/auth/LoginPage.test.tsx
git commit -m "feat(auth): bind SSO callback and exchange durably"
```

Deployment state: SSO is cross-replica durable; terminal preparation remains disabled until native/final enforcement lands.

---

### Task 5 (W07-E): Make ordinary and Cloudflare logout terminal and ticketed

**Files:**
- Create: `apps/api/src/services/terminalLogout.ts`
- Create: `apps/api/src/services/terminalLogout.test.ts`
- Create: `apps/api/src/services/terminalLogoutTicket.ts`
- Create: `apps/api/src/services/terminalLogoutTicket.test.ts`
- Create: `apps/web/src/components/layout/Header.test.tsx`
- Modify: `apps/api/src/routes/auth/login.ts` and `.test.ts`
- Modify: `apps/api/src/routes/auth/cfAccessRedirectLogin.ts` and `.test.ts`
- Modify: `apps/web/src/stores/auth.ts` and `.test.ts`
- Modify: `apps/web/src/components/layout/Header.tsx`
- Modify: `apps/api/src/config/{env,env.test,validate,validate.test}.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: transition lock, durable refresh classifier, epoch/family revocation, dedicated binding cookie.
- Produces: `performOrdinaryTerminalLogout`, `prepareCfTerminalLogout`, `completeCfTerminalLogout`, ticket issue/verify, and server-issued CF navigation URL.

- [ ] **Step 1: Write failing ordinary/CF subject and lock-order tests**

Cover live bearer A plus current refresh B, stale/legacy/invalid B, transition-linked C, ordinary logout vs every issuer, CF prepare vs every issuer, Redis cleanup failure, PostgreSQL rollback, two concurrent completions, replay/old-generation ticket, cookie-less completion, and delayed C1 response. PostgreSQL failures must return 503/500 with no ticket or bare CF navigation.

Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/services/terminalLogout.test.ts src/services/terminalLogoutTicket.test.ts src/routes/auth/login.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/auth-browser-transition.integration.test.ts
```

Expected: fail because current ordinary logout does not lock the transition and current CF logout trusts a refresh cookie on GET.

- [ ] **Step 2: Implement the shared durable revoke primitive**

Both modes require authenticated access authority and strict cookie/header CSRF. Under one system transaction: lock C1; invalidate its operation; lock sorted users/families; revalidate bearer A; classify B; globally advance/revoke only live A and current B; exactly revoke legacy/stale B's family and C; commit before Redis cleanup.

Ordinary mode then retires C1, creates active C2, clears refresh/C1, installs C2, and returns success. CF mode increments the generation, records `logout_pending`, logout ID, nonce digest, and expiry, then returns nonce material to the route.

- [ ] **Step 3: Implement signed one-time completion**

Ticket claims are exact and canonical:

```ts
type TerminalLogoutTicketClaims = Readonly<{
  version: 1;
  audience: 'terminal-logout-completion';
  transitionId: string;
  logoutId: string;
  generation: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}>;
```

Verify HMAC signature against retained keys before parsing authority fields. GET navigation accepts only a valid pending ticket and builds app/team Cloudflare logout URLs from configured public origin/team domain. Completion needs no cookies; it consumes the nonce under lock, retires C1, installs C2, and returns `303 /login?signedOut=1` with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Replay returns the same redirect without mutation.

- [ ] **Step 4: Replace the web logout flow and fail closed**

For CF-enabled logout, call authenticated strict-CSRF `POST /auth/cf-access-logout/prepare`, clear local stores, validate that `navigationUrl` is same-origin and exactly `/api/v1/auth/cf-access-logout?ticket=...`, then navigate. On any prepare failure, remain on a signed-out error/retry screen and never call the ticketless GET.

For ordinary logout, keep bounded local eviction but call the new terminal `POST /auth/logout`; a server failure is surfaced as partial sign-out instead of claiming durable completion.

- [ ] **Step 5: Add rollout configuration invariants**

Expose:

```ts
export function authBrowserTransitionsEnforced(): boolean;
export function authBrowserTerminalPreparationEnabled(): boolean;
```

Validation rejects `AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED=true` unless `AUTH_BROWSER_TRANSITIONS_ENFORCED=true`. Keep both false in `.env.example`. Route registration exists while disabled, but CF prepare returns 503 and no ticket.

- [ ] **Step 6: Run terminal/web gates and commit W07-E**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/terminalLogout.test.ts src/services/terminalLogoutTicket.test.ts src/routes/auth/login.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts src/config/env.test.ts src/config/validate.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/auth-browser-transition.integration.test.ts
pnpm --filter=@breeze/web exec vitest run src/stores/auth.test.ts src/components/layout/Header.test.tsx
git add apps/api/src/services/terminalLogout.ts apps/api/src/services/terminalLogout.test.ts apps/api/src/services/terminalLogoutTicket.ts apps/api/src/services/terminalLogoutTicket.test.ts apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/login.test.ts apps/api/src/routes/auth/cfAccessRedirectLogin.ts apps/api/src/routes/auth/cfAccessRedirectLogin.test.ts apps/api/src/config .env.example apps/api/src/__tests__/integration/auth-browser-transition.integration.test.ts apps/web/src/stores/auth.ts apps/web/src/stores/auth.test.ts apps/web/src/components/layout/Header.tsx apps/web/src/components/layout/Header.test.tsx
git commit -m "feat(auth): make browser logout terminal"
```

Deployment state: code is deployable with both flags false. Do not enable terminal preparation before W07-F removes the legacy seam and ships native transport.

---

### Task 6 (W07-F): Ship native binding, cleanup, enforcement, and closure gates

**Files:**
- Create: `apps/mobile/src/services/sessionGeneration.ts`
- Create: `apps/mobile/src/services/sessionGeneration.test.ts`
- Create: `apps/mobile/src/services/api.logout.test.ts`
- Create: `apps/mobile/src/services/api.mfa.test.ts`
- Create: `apps/api/src/jobs/authBrowserTransitionCleanup.ts`
- Create: `apps/api/src/jobs/authBrowserTransitionCleanup.test.ts`
- Create: `e2e-tests/browser-contracts/auth-browser-transition.spec.ts`
- Create: `e2e-tests/playwright.auth-browser-transition.config.ts`
- Create: `docs/operations/auth-browser-transition-rollout.md`
- Modify: `apps/mobile/src/services/api.ts`
- Modify: `apps/mobile/src/store/{authSlice,authSlice.test}.ts`
- Modify: `apps/api/src/services/{authBrowserTransition,userSession}.ts` and tests
- Modify: `apps/api/src/services/userSession.callers.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/testing/FEATURE_TEST_LOG.md`

**Interfaces:**
- Consumes: complete guarded issuer/terminal/SSO implementation.
- Produces: signed native transport, bounded cleanup, zero legacy issuer surface, startup compatibility gate, browser CI contract, rollout evidence.

- [ ] **Step 1: Write failing native generation and cleanup tests**

Cover native transition-v1 capability signaling, missing/invalid binding 428, SecureStore persistence, one retry, subsequent header use, account switch, reinstall/cookie mismatch, logout cancellation of queued writes, raw mobile-device-ID rejection, enforcement-false legacy fallback accounting, enforcement-true legacy 426, abandoned lease replacement, expired-pending retirement, permanent tombstone retention, and unknown cleanup job rejection.

Run:

```bash
pnpm --filter=breeze-mobile exec vitest run src/services/api.logout.test.ts src/services/api.mfa.test.ts src/services/sessionGeneration.test.ts src/store/authSlice.test.ts
pnpm --filter=@breeze/api exec vitest run src/services/authBrowserTransition.test.ts src/jobs/authBrowserTransitionCleanup.test.ts
```

Expected: fail because native binding/session generation and the worker do not exist.

- [ ] **Step 2: Implement signed native bootstrap and one retry**

Persist `x-breeze-native-auth-binding` under SecureStore key `breeze_native_auth_binding_v1`. After that support ships, every native auth issuer request sends both the binding and `x-breeze-auth-transition: v1`. On 428, read the replacement response header, write it only if the captured session generation is still current, then retry once. Logout increments the generation before network work and deletes token, CSRF mirror, and native binding so a delayed login/MFA/refresh cannot reinstall them.

Use this generation API:

```ts
export function currentSessionGeneration(): number;
export function advanceSessionGeneration(): number;
export async function commitIfCurrent<T>(
  generation: number,
  write: () => Promise<T>,
): Promise<T | undefined>;
```

The server selects native transport when the mobile-device header is present, but accepts authority only from a valid signed native-binding header. The capability header selects protocol behavior, not identity or authority, and cannot substitute for the signed binding.

- [ ] **Step 3: Pass the native rollout gate, then delete the legacy issuer**

First deploy the native-capable app and API with enforcement false and the frozen seam retained. Emit `auth_transition_legacy_issuer_total` by issuer and client class. The rollout runbook must record the released minimum mobile version, app-store availability, and a full configured maximum refresh-family lifetime with zero supported-client legacy issuer events. Dormant clients below that minimum are an explicit unsupported-version case and receive 426 with upgrade UX when they return. Do not delete the seam or enable enforcement from telemetry covering a shorter interval.

After that external rollout checkpoint, delete `issueUserSessionLegacyDuringTransition` and the one-argument `mintRefreshTokenFamily(userId)` overload. Unskip the Task 1 final assertions and require:

```ts
expect(findProductionCalls('createTokenPair')).toEqual(['services/userSession.ts']);
expect(findProductionCalls('setRefreshTokenCookie')).toEqual([
  'routes/auth/helpers.ts',
  'routes/sso.ts',
]);
expect(sourceTree).not.toContain('issueUserSessionLegacyDuringTransition');
```

The second allowed file means the helper definition and the already-authorized durable SSO exchange installation; the contract must inspect symbol identity/call context rather than raw filenames alone.

Export a build-owned `AUTH_BROWSER_TRANSITION_GUARD_COMPLETE = true` marker only after the rollout gate is recorded, the legacy seam is deleted, and the source contract is active. Startup refuses enforcement unless that marker is true, and refuses terminal preparation unless enforcement is enabled. The source contract—not runtime reflection—proves the legacy export no longer exists.

- [ ] **Step 4: Add bounded cleanup without tombstone deletion**

The daily BullMQ worker processes at most 500 expired `logout_pending` rows using `FOR UPDATE SKIP LOCKED`, marks them retired, clears operation fields, sets `retired_at`, and logs `retiredPending`. It never deletes retired rows; `deletedRetired` remains zero until a separate fleet-authoritative key-retirement design exists. Admission remains the synchronous correctness path.

- [ ] **Step 5: Add Chromium and CI contracts**

The browser spec must prove:

```ts
test('late pre-logout issuer response cannot restore authority', async ({ context, page }) => {
  // Hold issuer finalization, complete logout in a second page, release issuer,
  // then prove /auth/refresh and an authenticated probe reject C1/family state.
});

test('CF completion succeeds without cookies and replay is inert', async ({ context, page }) => {
  // Prepare with cookies, clear the cookie jar before completion, follow ticket,
  // replay the same completion URL, and assert one successor generation.
});
```

Add a required CI job running `playwright.auth-browser-transition.config.ts`. Record exact unit/integration/RLS/browser evidence in `FEATURE_TEST_LOG.md`.

- [ ] **Step 6: Run complete closure gates**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/userSession.callers.test.ts src/services/authBrowserTransition.test.ts src/services/userSession.test.ts src/services/recoveryCodeAuth.test.ts src/services/ssoBrowserTransition.test.ts src/services/terminalLogout.test.ts src/services/terminalLogoutTicket.test.ts src/jobs/authBrowserTransitionCleanup.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/auth-browser-transition.integration.test.ts src/__tests__/integration/refresh-token-family.integration.test.ts src/__tests__/integration/sso-browser-transition.integration.test.ts src/__tests__/integration/ssoPartnerLogin.integration.test.ts
pnpm --filter=@breeze/api exec vitest run --config vitest.config.rls.ts src/__tests__/integration/auth-browser-transition-rls.integration.test.ts
pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter=@breeze/web exec vitest run
pnpm --filter=breeze-mobile test
pnpm db:check-drift
pnpm --filter=@breeze/api exec tsc --noEmit
pnpm --filter=@breeze/web exec astro check
pnpm --filter=breeze-mobile typecheck
pnpm --filter=@breeze/api lint
pnpm --filter=@breeze/web lint
pnpm --filter=@breeze/api build
pnpm --filter=@breeze/web build
pnpm --dir e2e-tests exec playwright test --config=playwright.auth-browser-transition.config.ts
git diff --check origin/main...HEAD
```

Expected: every command exits 0; all issuers are guarded; RLS forges are denied; both lock orders and native/browser paths pass.

- [ ] **Step 7: Perform the exact-diff security review**

Review `git diff --find-renames --find-copies origin/main...HEAD` for lock inversion/deadlock, capability forgery/bypass, stale refresh subject authority, binding fixation/rotation, ordinary/CF logout late responses, ticket forgery/replay/leakage, SSO multi-replica replay, native spoofing/generation races, RLS/system-context scope, and rollout compatibility. Fix every Critical, Important, or missing-test finding with a focused failing test and fix commit, then rerun the affected gates.

- [ ] **Step 8: Commit W07-F and documentation**

```bash
git add apps/mobile/src/services/api.ts apps/mobile/src/services/api.logout.test.ts apps/mobile/src/services/api.mfa.test.ts apps/mobile/src/services/sessionGeneration.ts apps/mobile/src/services/sessionGeneration.test.ts apps/mobile/src/store/authSlice.ts apps/mobile/src/store/authSlice.test.ts apps/api/src/services/authBrowserTransition.ts apps/api/src/services/authBrowserTransition.test.ts apps/api/src/services/userSession.ts apps/api/src/services/userSession.test.ts apps/api/src/services/userSession.callers.test.ts apps/api/src/jobs/authBrowserTransitionCleanup.ts apps/api/src/jobs/authBrowserTransitionCleanup.test.ts apps/api/src/index.ts e2e-tests/browser-contracts/auth-browser-transition.spec.ts e2e-tests/playwright.auth-browser-transition.config.ts .github/workflows/ci.yml docs/operations/auth-browser-transition-rollout.md docs/testing/FEATURE_TEST_LOG.md
git commit -m "feat(auth): enforce durable browser and native session authority"
```

Deployment state: guarded code is complete. Operators still perform the documented schema-first/fleet-first rollout; this commit does not change production flags.

---

## Rollout sequence

1. Deploy W07-A schema to all databases. Verify RLS and drift.
2. Deploy W07-B through W07-E with both enforcement and terminal preparation false; transition-v1 clients use guarded issuance and other clients use only the frozen seam.
3. Deploy the first W07-F mobile/web/API build with native binding and capability signaling but retain the seam. Confirm current-JTI population, binding bootstrap success, 428 retry rate, lease conflicts, SSO exchange success, and legacy-issuer metrics across every API replica.
4. Keep enforcement false for a full configured maximum refresh-family lifetime after the minimum native version is available. Record zero supported-client legacy issuer events and the explicit unsupported-version/426 policy in the runbook.
5. Delete the seam and one-argument family-mint overload, activate the source/build contracts, deploy that final W07-F API build everywhere, then enable `AUTH_BROWSER_TRANSITIONS_ENFORCED=true` in one controlled rollout. Roll back the flag, not the schema, if upgrade/bootstrap failures exceed the runbook threshold.
6. After all replicas enforce guarded issuance, enable `AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED=true`.
7. Keep nullable legacy current-JTI classification until the same lifetime gate has elapsed. Plan the `NOT NULL` migration separately with row-count warnings.

## Plan self-review

- **Spec coverage:** W07-A covers schema/RLS/binding/currentness; W07-B covers primary/MFA/refresh; W07-C covers verify-email/invite/CF redirect; W07-D covers bootstrap/SSO/durable exchange/compatibility removal; W07-E covers ordinary and CF terminal logout; W07-F covers native, cleanup, final enforcement, browser CI, and rollout.
- **Placeholder scan:** The plan contains no deferred implementation placeholder. The later current-JTI `NOT NULL` migration and fleet-authoritative tombstone deletion are explicitly out of scope, not incomplete W07 steps.
- **Type consistency:** `AuthBindingSource`, `AuthIssuanceCapability`, `AuthorizedUserSession`, `installAuthorizedUserSessionCookies`, stored-transition admission, `issueUserSession`, and `RefreshAuthority` are defined once and used with the same field names in every slice.
- **Current-main reconciliation:** The plan guards `verifyEmail.ts`, preserves current MFA/epoch/SSO/cookie transport, and does not reintroduce session issuance in email-first `register.ts`.
