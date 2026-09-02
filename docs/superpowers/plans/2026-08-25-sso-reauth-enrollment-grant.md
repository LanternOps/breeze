# SSO Re-Authentication Enrollment Grant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a passwordless, SSO-provisioned user prove identity through a fresh IdP round-trip and use that proof — instead of a password — to enroll their first MFA factor or passkey, unblocking `requireMfa()`, the approval-assurance ladder, and L4 re-auth (#4018).

**Architecture:** A third `sso_sessions` mode ("reauth") alongside the existing `login` and `link` modes. `POST /sso/reauth/start` snapshots the caller's `{authEpoch, mfaEpoch, sid}` exactly as `/sso/link/start` does and sends them to their own IdP with `prompt=login&max_age=0`. The callback re-checks that binding against live state, requires the returned `id_token` to carry a **fresh** `auth_time` and a `sub` that already belongs to this user, and mints a single-use `mfa:stepup` grant with a new operation, `enroll_first_factor`. The MFA/passkey enrollment endpoints accept that grant in place of `currentPassword` — and **only** for accounts with `password_hash IS NULL`.

**Tech Stack:** Hono + TypeScript (apps/api), Drizzle ORM, Postgres, Redis (ioredis), Vitest, Astro + React (apps/web), Starlight (apps/docs).

## Global Constraints

- **The re-auth start route MUST NOT be behind `requireMfa()`.** `/sso/link/start` is (`apps/api/src/routes/sso.ts:1680-1683`); copying that would recreate the exact deadlock #4018 describes. It is behind `authMiddleware` only.
- **`auth_time` absent is a REJECT, not a pass.** An IdP that ignores `prompt=login`/`max_age=0` and replays a cached session must not be able to mint an enrollment grant. Fail closed.
- **`auth_time` must be at or after the moment this transaction started** (`sso_sessions.created_at`, minus clock skew) — not merely "recent". A window measured from *now* would accept an IdP authentication that happened before the user ever clicked the button, which is the cached-session replay this whole check exists to stop. Never substitute `iat` for `auth_time`: a fresh token can be minted from an old login.
- **The grant is only honoured for accounts with `password_hash IS NULL`.** An account that has a password uses the existing password step-up; the SSO path must never become a weaker parallel road to factor enrollment.
- **The grant only authorizes a FIRST factor.** `enforceExistingFactorStepUp` (`apps/api/src/routes/auth/helpers.ts:245+`) is untouched: adding a second factor to an already-protected account still requires proving the existing one.
- **Every new `sso_sessions` DB touch runs in system context.** The table is system-scope-only under RLS (2026-07-16 migration). Inside an authenticated request, call `runOutsideDbContext(() => withSystemDbAccessContext(...))` — the pattern at `apps/api/src/routes/sso.ts:1745-1760`.
- **Migration naming:** `apps/api/migrations/2026-08-25-<slug>.sql`. Idempotent (`ADD COLUMN IF NOT EXISTS`, `DO $$ ... EXCEPTION`). **No inner `BEGIN;`/`COMMIT;`** — `autoMigrate` wraps each file. Never add to the closed `2026-08-06-*` block.
- **Reasoning effort for reviewers:** this is auth code. Every task ends with its tests actually run, not assumed.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/services/sso.ts` | `buildAuthorizationUrl` gains `prompt`/`maxAge`; `IDTokenClaims.auth_time`; new `assertFreshIdpAuthentication` | 1 |
| `apps/api/migrations/2026-08-25-sso-sessions-reauth-user-id.sql` | `reauth_user_id` column + XOR check + index | 2 |
| `apps/api/src/db/schema/sso.ts` | `reauthUserId` on `ssoSessions` | 2 |
| `apps/api/src/services/tenantCascade.ts` | comment correction only (provider-keyed SQL unchanged) | 2 |
| `apps/api/src/services/mfaStepUpGrant.ts` | `'enroll_first_factor'` added to `StepUpOperation` | 4 |
| `apps/api/src/routes/sso.ts` | `POST /sso/reauth/start`; callback reauth branch; `SsoCallbackMode` widened | 3, 4 |
| `apps/api/src/routes/auth/mfa.ts` | `/mfa/setup` + `/mfa/enable` accept `ssoReauthGrantId` | 5 |
| `apps/api/src/routes/auth/passkeys.ts` | `/passkeys/register/options` + `/verify` accept `ssoReauthGrantId` | 5 |
| `apps/api/src/routes/auth/helpers.ts` | `resolveEnrollmentStepUp` — the single decision point | 5 |
| `apps/api/src/routes/auth/password.ts` | `/auth/me` returns `hasPassword` | 6 |
| `apps/web/src/components/settings/ProfilePage.tsx` | passwordless branch + `#ssoReauthGrant` fragment handling | 6 |
| `apps/web/src/components/settings/SsoProvidersPage.tsx` | `trustsIdpMfa` toggle | 7 |
| `apps/web/src/components/devices/AddDeviceModal.tsx` | SSO-aware MFA copy | 7 |
| `apps/docs/src/content/docs/reference/sso.mdx` | document both the flag and the re-auth flow | 7 |

---

### Task 1: OIDC re-authentication primitives

The authorization-URL builder cannot currently ask for a forced re-auth, and `auth_time` is untyped. Both are pure functions with no DB — do them first so later tasks can rely on them.

**Files:**
- Modify: `apps/api/src/services/sso.ts:94-111` (`buildAuthorizationUrl`), `:231-246` (`IDTokenClaims`)
- Test: `apps/api/src/services/sso.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `buildAuthorizationUrl(params: AuthorizationUrlParams & { prompt?: string; maxAge?: number }): string`
  - `IDTokenClaims.auth_time?: number`
  - `assertFreshIdpAuthentication(claims: Pick<IDTokenClaims, 'auth_time'>, startedAtMs: number, nowMs?: number): { ok: true } | { ok: false; reason: 'auth_time_missing' | 'auth_time_stale' | 'auth_time_future' }`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/sso.test.ts`:

```ts
import { buildAuthorizationUrl, assertFreshIdpAuthentication } from './sso';

const CONFIG = {
  issuer: 'https://idp.example.com',
  authorizationUrl: 'https://idp.example.com/authorize',
  tokenUrl: 'https://idp.example.com/token',
  jwksUrl: 'https://idp.example.com/jwks',
  clientId: 'client-123',
  clientSecret: 'secret',
  scopes: 'openid email profile',
} as any;

describe('buildAuthorizationUrl re-auth params', () => {
  it('omits prompt and max_age when not requested', () => {
    const url = new URL(buildAuthorizationUrl({
      config: CONFIG, state: 's', nonce: 'n', redirectUri: 'https://app/cb',
    }));
    expect(url.searchParams.has('prompt')).toBe(false);
    expect(url.searchParams.has('max_age')).toBe(false);
  });

  it('sets prompt=login and max_age=0 when requested', () => {
    const url = new URL(buildAuthorizationUrl({
      config: CONFIG, state: 's', nonce: 'n', redirectUri: 'https://app/cb',
      prompt: 'login', maxAge: 0,
    }));
    expect(url.searchParams.get('prompt')).toBe('login');
    // max_age=0 must survive: a falsy-check bug would drop it and silently
    // turn a forced re-auth into an ordinary (cache-satisfiable) login.
    expect(url.searchParams.get('max_age')).toBe('0');
  });
});

describe('assertFreshIdpAuthentication', () => {
  const NOW = 1_800_000_000_000;        // fixed clock, ms
  const STARTED = NOW - 30_000;         // transaction began 30s ago

  it('rejects a missing auth_time (IdP ignored prompt=login)', () => {
    expect(assertFreshIdpAuthentication({}, STARTED, NOW))
      .toEqual({ ok: false, reason: 'auth_time_missing' });
  });

  it('rejects an auth_time from BEFORE the transaction started', () => {
    // The cached-session replay this check exists for: the IdP returns a
    // perfectly recent auth_time that nonetheless predates the user's click.
    const beforeStart = Math.floor(STARTED / 1000) - 121;
    expect(assertFreshIdpAuthentication({ auth_time: beforeStart }, STARTED, NOW))
      .toEqual({ ok: false, reason: 'auth_time_stale' });
  });

  it('rejects an auth_time in the future beyond clock skew', () => {
    const future = Math.floor(NOW / 1000) + 121;
    expect(assertFreshIdpAuthentication({ auth_time: future }, STARTED, NOW))
      .toEqual({ ok: false, reason: 'auth_time_future' });
  });

  it('accepts an auth_time from during the round trip', () => {
    const during = Math.floor(STARTED / 1000) + 5;
    expect(assertFreshIdpAuthentication({ auth_time: during }, STARTED, NOW))
      .toEqual({ ok: true });
  });

  it('accepts an auth_time slightly before the start, inside skew tolerance', () => {
    const justBefore = Math.floor(STARTED / 1000) - 30;
    expect(assertFreshIdpAuthentication({ auth_time: justBefore }, STARTED, NOW))
      .toEqual({ ok: true });
  });

  it('never accepts iat as a substitute for auth_time', () => {
    expect(assertFreshIdpAuthentication({ iat: Math.floor(NOW / 1000) } as any, STARTED, NOW))
      .toEqual({ ok: false, reason: 'auth_time_missing' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @breeze/api test -- --run src/services/sso.test.ts`
Expected: FAIL — `assertFreshIdpAuthentication is not a function`, and the `prompt`/`max_age` assertions fail.

- [ ] **Step 3: Implement**

In `apps/api/src/services/sso.ts`, extend the params interface used by `buildAuthorizationUrl` (find `AuthorizationUrlParams` directly above line 94) with:

```ts
  /** OIDC `prompt`. Pass 'login' to force the IdP to re-authenticate. */
  prompt?: string;
  /** OIDC `max_age` in seconds. 0 demands a fresh authentication. */
  maxAge?: number;
```

and inside the function, after the `nonce` line (`apps/api/src/services/sso.ts:103`):

```ts
  if (params.prompt) {
    url.searchParams.set('prompt', params.prompt);
  }
  // `!= null`, NOT a truthy check: max_age=0 is the value that actually forces
  // a re-authentication, and `if (maxAge)` would silently drop it.
  if (params.maxAge != null) {
    url.searchParams.set('max_age', String(params.maxAge));
  }
```

Add to `IDTokenClaims` (after `acr?: string;`, `apps/api/src/services/sso.ts:244`):

```ts
  /** OIDC Core §2: seconds since epoch of the END-USER's authentication.
   * Required in the id_token whenever the request carried `max_age`. */
  auth_time?: number;
```

Add the new helper next to `idpAssertedMfa` (`apps/api/src/services/sso.ts:255`):

```ts
/** Tolerance for an IdP clock running ahead of ours. */
const AUTH_TIME_SKEW_SECONDS = 120;

/**
 * Verify the IdP actually re-authenticated the user for THIS transaction.
 *
 * Two independent bounds, both required:
 *
 *  - `auth_time` must EXIST. OIDC Core requires the claim whenever the
 *    authorization request carried `max_age`, but real IdPs vary: some ignore
 *    `prompt=login` and replay a cached session, and one that does so while
 *    omitting `auth_time` would otherwise mint an enrollment grant off a
 *    months-old browser session. Absent claim === no proof of freshness.
 *  - `auth_time` must be at or after `startedAtMs` (the sso_sessions row's
 *    created_at), minus skew. A window measured from NOW would happily accept
 *    an authentication that predates the user's click — precisely the cached
 *    session this is meant to reject.
 *
 * `iat` is never a substitute: a fresh token can be minted from an old login.
 */
export function assertFreshIdpAuthentication(
  claims: Pick<IDTokenClaims, 'auth_time'>,
  startedAtMs: number,
  nowMs: number = Date.now(),
): { ok: true } | { ok: false; reason: 'auth_time_missing' | 'auth_time_stale' | 'auth_time_future' } {
  const authTime = claims.auth_time;
  if (typeof authTime !== 'number' || !Number.isFinite(authTime)) {
    return { ok: false, reason: 'auth_time_missing' };
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  const startedAtSeconds = Math.floor(startedAtMs / 1000);
  if (authTime > nowSeconds + AUTH_TIME_SKEW_SECONDS) {
    return { ok: false, reason: 'auth_time_future' };
  }
  if (authTime < startedAtSeconds - AUTH_TIME_SKEW_SECONDS) {
    return { ok: false, reason: 'auth_time_stale' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @breeze/api test -- --run src/services/sso.test.ts`
Expected: PASS, and no other test in that file regresses.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/sso.ts apps/api/src/services/sso.test.ts
git commit -m "feat(api): OIDC forced re-auth params and auth_time freshness check (#4018)"
```

---

### Task 2: `sso_sessions.reauth_user_id` — the third mode

**Files:**
- Create: `apps/api/migrations/2026-08-25-sso-sessions-reauth-user-id.sql`
- Modify: `apps/api/src/db/schema/sso.ts:112-146` (`ssoSessions`), `apps/api/src/services/tenantCascade.ts:434-435` (comment only)
- Test: `apps/api/src/db/autoMigrate.test.ts` (already asserts ordering/naming — just run it)

**Interfaces:**
- Consumes: nothing.
- Produces: `ssoSessions.reauthUserId: uuid | null`, mutually exclusive with `linkUserId`.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-08-25-sso-sessions-reauth-user-id.sql`:

```sql
-- #4018: third sso_sessions mode. A "reauth" transaction proves a passwordless
-- SSO account's identity through a fresh IdP round-trip so the user can enroll
-- a FIRST MFA factor. Mirrors link mode (link_user_id + the three initiating_*
-- binding columns), which this reuses as-is.
--
-- ON DELETE CASCADE for the same reason link_user_id has it: sso_sessions has
-- no org_id/partner_id, so the tenant-erasure sweep never reaches it by tenancy
-- and an abandoned transaction must not block a hard user delete.
ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS reauth_user_id uuid REFERENCES users(id) ON DELETE CASCADE;

-- A session is exactly one of: login (both NULL), link, or reauth. Both set is
-- a programming error that would make the callback's mode discriminator
-- ambiguous, so refuse it in the database rather than ordering the checks.
DO $$
BEGIN
  ALTER TABLE sso_sessions
    ADD CONSTRAINT sso_sessions_single_mode_chk
    CHECK (link_user_id IS NULL OR reauth_user_id IS NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS sso_sessions_reauth_user_id_idx
  ON sso_sessions (reauth_user_id)
  WHERE reauth_user_id IS NOT NULL;
```

- [ ] **Step 2: Verify the migration applies and re-applies cleanly**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
pnpm db:migrate   # second run must be a no-op, not an error
pnpm --filter @breeze/api test -- --run src/db/autoMigrate.test.ts
```
Expected: both migrate runs succeed; `autoMigrate.test.ts` PASSES (it asserts naming + ordering + that every referenced migration path resolves).

- [ ] **Step 3: Add the Drizzle column**

In `apps/api/src/db/schema/sso.ts`, immediately after the `linkUserId` block (line 126):

```ts
  // Reauth-mode marker (#4018): when set, the callback mints a single-use
  // enrollment step-up grant for this user instead of logging in or linking.
  // Same ON DELETE CASCADE rationale as linkUserId above. Mutually exclusive
  // with linkUserId (sso_sessions_single_mode_chk).
  reauthUserId: uuid('reauth_user_id').references(() => users.id, { onDelete: 'cascade' }),
```

Correct the now-stale comment in `apps/api/src/services/tenantCascade.ts:434`:

```ts
  // sso_sessions.link_user_id and .reauth_user_id both cascade on user delete;
  // the provider FK does not — which is what this provider-keyed clear is for.
```

- [ ] **Step 4: Verify no drift and no cascade obligation was missed**

```bash
pnpm db:check-drift
grep -n "sso_sessions" apps/api/src/services/tenantCascade.ts
grep -n "sso_sessions" apps/api/src/services/tenantExportPolicyRegistry.ts
```
Expected: no drift. `tenantCascade.ts` shows the two provider-keyed clears (org + partner axis) — both key on `provider_id`, so **neither statement changes**. `tenantExportPolicyRegistry.ts` shows **no** match, which is correct: `sso_sessions` has no `org_id`, so it is not in `CORE_ORG_CASCADE_DELETE_ORDER` and needs no export-policy entry. Record that you checked — this is the step CLAUDE.md flags as the one that gets missed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-08-25-sso-sessions-reauth-user-id.sql apps/api/src/db/schema/sso.ts apps/api/src/services/tenantCascade.ts
git commit -m "feat(api): sso_sessions reauth mode column (#4018)"
```

---

### Task 3: `POST /sso/reauth/start`

**Files:**
- Modify: `apps/api/src/routes/sso.ts` — add the route immediately after the `/link/start/:providerId` handler (ends `apps/api/src/routes/sso.ts:1816`)
- Modify: `apps/api/src/middleware/auth.ts:192-213` (`isMfaEnrollmentExemptPath`)
- Test: `apps/api/src/routes/sso.reauth.test.ts` (new), `apps/api/src/middleware/auth.test.ts`

**Interfaces:**
- Consumes: `assertFreshIdpAuthentication` is not used here (callback only); uses `ssoSessions.reauthUserId` from Task 2.
- Produces: `POST /api/v1/sso/reauth/start` → `200 { authUrl: string }` | `400 { error: 'Account has a password' }` | `404 { error: 'No linked SSO identity' }` | `429` | `503`.

**Design notes the implementer must not "simplify" away:**
- No client-supplied `providerId`. The provider is resolved from the caller's own `user_sso_identities` row, so a caller can never point the flow at a provider they do not already have an identity with.
- **No `requireMfa()`.** See Global Constraints.
- Refuse when the account HAS a password — those users already have a working step-up.
- **`isMfaEnrollmentExemptPath` must learn about this route, or the whole feature is dead on arrival.** `authMiddleware` 428s an unenrolled user under a policy that requires MFA on every path outside a tight allowlist — currently `/auth/mfa/*`, `/auth/phone/*`, `/auth/passkeys/*`, `/users/me`, `/auth/logout` (`apps/api/src/middleware/auth.ts:205-212`). A policy-required, unenrolled, passwordless SSO user — the exact population this plan serves — would be bounced off `/sso/reauth/start` before the handler ran. Adding the exemption is safe for the same reason the passkey entry is: the route performs no account change of its own, it only starts an IdP round-trip.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/sso.reauth.test.ts`, following the mocking style already used in `apps/api/src/routes/sso.test.ts` (copy its `vi.mock` block for `../db`, `../services`, and `../middleware/auth` verbatim, then add):

```ts
describe('POST /sso/reauth/start', () => {
  it('refuses when the account has a password', async () => {
    mockUserRow({ id: USER_ID, passwordHash: 'argon2id$...' });
    const res = await app.request('/sso/reauth/start', { method: 'POST' }, ENV);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Account has a password' });
  });

  it('404s when the user has no linked SSO identity', async () => {
    mockUserRow({ id: USER_ID, passwordHash: null });
    mockSsoIdentityRows([]);
    const res = await app.request('/sso/reauth/start', { method: 'POST' }, ENV);
    expect(res.status).toBe(404);
  });

  it('inserts a reauth-mode session bound to the caller and returns an authUrl with prompt=login and max_age=0', async () => {
    mockUserRow({ id: USER_ID, passwordHash: null });
    mockSsoIdentityRows([{ providerId: PROVIDER_ID }]);
    mockProviderRow({ id: PROVIDER_ID, status: 'active', type: 'oidc', configVersion: 7 });
    mockUserEpochs({ authEpoch: 3, mfaEpoch: 1 });

    const res = await app.request('/sso/reauth/start', { method: 'POST' }, ENV);
    expect(res.status).toBe(200);

    const { authUrl } = await res.json();
    const url = new URL(authUrl);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');

    expect(insertedSsoSession()).toMatchObject({
      providerId: PROVIDER_ID,
      reauthUserId: USER_ID,
      linkUserId: undefined,
      providerVersion: 7,
      initiatingAuthEpoch: 3,
      initiatingMfaEpoch: 1,
      initiatingSessionId: SID,
    });
  });

  it('503s when the caller has no sid or epochs are unavailable', async () => {
    mockUserRow({ id: USER_ID, passwordHash: null });
    mockSsoIdentityRows([{ providerId: PROVIDER_ID }]);
    mockProviderRow({ id: PROVIDER_ID, status: 'active', type: 'oidc', configVersion: 7 });
    mockUserEpochs(null);
    const res = await app.request('/sso/reauth/start', { method: 'POST' }, ENV);
    expect(res.status).toBe(503);
  });

  it('refuses a provider whose status is inactive', async () => {
    mockUserRow({ id: USER_ID, passwordHash: null });
    mockSsoIdentityRows([{ providerId: PROVIDER_ID }]);
    mockProviderRow({ id: PROVIDER_ID, status: 'inactive', type: 'oidc', configVersion: 7 });
    const res = await app.request('/sso/reauth/start', { method: 'POST' }, ENV);
    expect(res.status).toBe(404);
  });
});
```

Add to `apps/api/src/middleware/auth.test.ts` — this is the test that proves the feature is reachable at all:

```ts
it('exempts /sso/reauth/* from forced MFA enrollment', () => {
  // A policy-required, unenrolled, passwordless SSO user is the entire target
  // population. Without this exemption authMiddleware 428s them before the
  // handler runs and the enrollment flow can never start.
  expect(isMfaEnrollmentExemptPath('/api/v1/sso/reauth/start')).toBe(true);
  expect(isMfaEnrollmentExemptPath('/sso/reauth/start')).toBe(true);
});

it('does not exempt other /sso paths', () => {
  expect(isMfaEnrollmentExemptPath('/api/v1/sso/providers')).toBe(false);
  expect(isMfaEnrollmentExemptPath('/api/v1/sso/link/start/abc')).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @breeze/api test -- --run src/routes/sso.reauth.test.ts`
Expected: FAIL — 404 from Hono for an unregistered route.

- [ ] **Step 3: Implement the route**

Insert into `apps/api/src/routes/sso.ts` directly after the `/link/start/:providerId` handler:

```ts
// Start a REAUTH-mode IdP round-trip (#4018).
//
// Deliberately NOT behind requireMfa(): this route exists precisely because a
// passwordless SSO account cannot satisfy requireMfa() yet — gating it the way
// /link/start is gated would reproduce the deadlock it fixes.
//
// The provider is resolved from the caller's OWN linked identity, never from a
// request parameter, so this can only ever re-authenticate against an IdP the
// user already has a binding with.
ssoRoutes.post('/reauth/start', authMiddleware, async (c) => {
  const auth = c.get('auth') as AuthContext;

  const redis = getRedis();
  const rateCheck = await rateLimiter(redis, `sso:reauth:${auth.user.id}`, 5, 15 * 60);
  if (!rateCheck.allowed) {
    return c.json({
      error: 'Too many attempts. Please try again later.',
      retryAfter: Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)
    }, 429);
  }

  // An account WITH a password uses the existing password step-up. Allowing
  // both would make this a weaker parallel road to factor enrollment.
  const [userRow] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);
  if (!userRow) return c.json({ error: 'User not found' }, 404);
  if (userRow.passwordHash != null) {
    return c.json({ error: 'Account has a password' }, 400);
  }

  const [identity] = await db
    .select({ providerId: userSsoIdentities.providerId })
    .from(userSsoIdentities)
    .where(eq(userSsoIdentities.userId, auth.user.id))
    .orderBy(userSsoIdentities.createdAt, userSsoIdentities.id)
    .limit(1);
  if (!identity) {
    return c.json({ error: 'No linked SSO identity' }, 404);
  }

  const [provider] = await db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.id, identity.providerId))
    .limit(1);
  if (!provider || provider.status === 'inactive') {
    return c.json({ error: 'Provider not found' }, 404);
  }
  if (provider.type !== 'oidc') {
    return c.json({ error: 'Only OIDC re-authentication is currently supported' }, 400);
  }

  let config: OIDCConfig;
  try {
    config = getOIDCConfig(provider);
  } catch (err) {
    console.warn(`[sso] provider ${provider.id} has an invalid configuration:`, err);
    return c.json({ error: 'SSO provider configuration is invalid' }, 400);
  }

  const initiatorEpochs = await getUserEpochs(auth.user.id);
  const initiatingSid = auth.token?.sid;
  if (!initiatorEpochs || !initiatingSid) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const pkce = generatePKCEChallenge();
  const state = generateState();
  const nonce = generateNonce();

  await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () =>
      db.insert(ssoSessions).values({
        providerId: provider.id,
        state,
        nonce,
        codeVerifier: pkce.codeVerifier,
        redirectUrl: '/settings/profile',
        reauthUserId: auth.user.id,
        providerVersion: provider.configVersion,
        initiatingAuthEpoch: initiatorEpochs.authEpoch,
        initiatingMfaEpoch: initiatorEpochs.mfaEpoch,
        initiatingSessionId: initiatingSid,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      })
    )
  );

  const authUrl = buildAuthorizationUrl({
    config,
    state,
    nonce,
    redirectUri: buildSsoCallbackUri(),
    pkce,
    // Force a real re-authentication. max_age=0 is the load-bearing half:
    // prompt=login alone is advisory and several IdPs honour it inconsistently.
    prompt: 'login',
    maxAge: 0,
  });

  const stateCookie = buildSsoStateCookie(state);
  if (!stateCookie) {
    return c.json({ error: 'SSO login binding secret is not configured on this instance' }, 500);
  }
  c.header('Set-Cookie', stateCookie, { append: true });

  writeRouteAudit(c, {
    orgId: provider.orgId,
    action: 'sso.reauth.started',
    resourceType: 'sso_provider',
    resourceId: provider.id,
    resourceName: provider.name,
    details: { partnerId: provider.partnerId, userId: auth.user.id }
  });

  return c.json({ authUrl });
});
```

Add `users` and `userSsoIdentities` to the schema import at the top of the file if they are not already imported.

Then add the exemption in `apps/api/src/middleware/auth.ts`, immediately after the `/auth/passkeys/` line (`:211`):

```ts
  // Starting an IdP re-authentication is an enrollment action for a
  // PASSWORDLESS SSO account (#4018) — it is how such a user proves identity
  // to install a first factor, since they have no password to prove. The route
  // changes no account state on its own; it only begins an OIDC round trip.
  if (rel.startsWith('/sso/reauth/')) return true;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @breeze/api test -- --run src/routes/sso.reauth.test.ts src/routes/sso.test.ts src/middleware/auth.test.ts`
Expected: PASS. Run `sso.test.ts` too — the new route sits in the same Hono instance and route-ordering regressions surface there.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/middleware/auth.ts apps/api/src/routes/sso.reauth.test.ts apps/api/src/middleware/auth.test.ts
git commit -m "feat(api): POST /sso/reauth/start for passwordless SSO accounts (#4018)"
```

---

### Task 4: Callback reauth branch + grant mint

**Files:**
- Modify: `apps/api/src/services/mfaStepUpGrant.ts:33` (`StepUpOperation`)
- Modify: `apps/api/src/routes/sso.ts:592` (`SsoCallbackMode`), `:2119` (mode discriminator), `:665-...` (`validateLinkBinding` generalization), and the callback body just before the link branch at `:2325`
- Test: `apps/api/src/routes/sso.reauth.test.ts` (extend)

**Interfaces:**
- Consumes: `assertFreshIdpAuthentication` (Task 1), `ssoSessions.reauthUserId` (Task 2), the route from Task 3.
- Produces: on success, a redirect to `/settings/profile#ssoReauthGrant=<grantId>`; a `StepUpGrant` in Redis with `operation: 'enroll_first_factor'`.

**Design notes:**
- The reauth binding re-check is the *same* set of conditions as link mode. Generalize `validateLinkBinding` to read whichever user column is set rather than duplicating it.
- Identity match is **stricter than link mode**: link mode compares the asserted email (`apps/api/src/routes/sso.ts:2337`) because it is *creating* the binding. Re-auth requires the `(providerId, sub)` identity row to **already belong to this user** — an email comparison alone would let an IdP that lets users change their own email address re-auth as someone else.
- The grant is bound to `{userId, operation, authEpoch, mfaEpoch, sid}` by `mintStepUpGrant`, so it is already single-use, session-bound, and invalidated by any epoch bump.
- Returning the grant id in the URL fragment mirrors the existing `#ssoCode` exchange the callback already uses for login. Fragments are not sent to the server or logged in access logs.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/sso.reauth.test.ts`:

```ts
describe('GET /sso/callback — reauth mode', () => {
  it('rejects when the id_token has no auth_time', async () => {
    mockReauthSession({ reauthUserId: USER_ID });
    mockIdToken({ sub: EXTERNAL_ID, email: 'tech@acme.example' }); // no auth_time
    const res = await app.request(`/sso/callback?code=c&state=${STATE}`, {}, ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=reauth_not_fresh');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('rejects a stale auth_time (IdP replayed a cached session)', async () => {
    mockReauthSession({ reauthUserId: USER_ID });
    mockIdToken({ sub: EXTERNAL_ID, auth_time: Math.floor(Date.now() / 1000) - 3600 });
    const res = await app.request(`/sso/callback?code=c&state=${STATE}`, {}, ENV);
    expect(res.headers.get('location')).toContain('error=reauth_not_fresh');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('rejects when the asserted sub belongs to a different user', async () => {
    mockReauthSession({ reauthUserId: USER_ID });
    mockIdToken({ sub: EXTERNAL_ID, auth_time: Math.floor(Date.now() / 1000) - 5 });
    mockSsoIdentityOwner(OTHER_USER_ID);
    const res = await app.request(`/sso/callback?code=c&state=${STATE}`, {}, ENV);
    expect(res.headers.get('location')).toContain('error=identity_mismatch');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('rejects when the initiating session was revoked since /reauth/start', async () => {
    mockReauthSession({ reauthUserId: USER_ID, initiatingAuthEpoch: 3 });
    mockUserEpochs({ authEpoch: 4, mfaEpoch: 1 }); // bumped since start
    mockIdToken({ sub: EXTERNAL_ID, auth_time: Math.floor(Date.now() / 1000) - 5 });
    mockSsoIdentityOwner(USER_ID);
    const res = await app.request(`/sso/callback?code=c&state=${STATE}`, {}, ENV);
    expect(res.headers.get('location')).toContain('error=session_invalid');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('mints an enroll_first_factor grant and redirects with it in the fragment', async () => {
    mockReauthSession({ reauthUserId: USER_ID, initiatingAuthEpoch: 3, initiatingMfaEpoch: 1, initiatingSessionId: SID });
    mockUserEpochs({ authEpoch: 3, mfaEpoch: 1 });
    mockIdToken({ sub: EXTERNAL_ID, auth_time: Math.floor(Date.now() / 1000) - 5 });
    mockSsoIdentityOwner(USER_ID);
    mintStepUpGrant.mockResolvedValue('grant-abc');

    const res = await app.request(`/sso/callback?code=c&state=${STATE}`, {}, ENV);

    expect(mintStepUpGrant).toHaveBeenCalledWith({
      userId: USER_ID,
      operation: 'enroll_first_factor',
      authEpoch: 3,
      mfaEpoch: 1,
      sid: SID,
    });
    expect(res.headers.get('location')).toBe('/settings/profile#ssoReauthGrant=grant-abc');
  });

  it('never mints login tokens in reauth mode', async () => {
    mockReauthSession({ reauthUserId: USER_ID });
    mockUserEpochs({ authEpoch: 3, mfaEpoch: 1 });
    mockIdToken({ sub: EXTERNAL_ID, auth_time: Math.floor(Date.now() / 1000) - 5 });
    mockSsoIdentityOwner(USER_ID);
    await app.request(`/sso/callback?code=c&state=${STATE}`, {}, ENV);
    expect(createTokenPair).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @breeze/api test -- --run src/routes/sso.reauth.test.ts`
Expected: FAIL — the callback treats a reauth session as a login and mints tokens.

- [ ] **Step 3: Implement**

`apps/api/src/services/mfaStepUpGrant.ts:33`:

```ts
export type StepUpOperation = 'add_factor' | 'register_approver_device' | 'enroll_first_factor';
```

Update that file's doc comment to add a fourth minting source: *"(4) the SSO re-auth callback (`GET /sso/callback`, reauth mode), the passwordless equivalent of (2) — see #4018."*

`apps/api/src/routes/sso.ts:592`:

```ts
type SsoCallbackMode = 'login' | 'link' | 'reauth';
```

`apps/api/src/routes/sso.ts:2119`:

```ts
  const callbackMode: SsoCallbackMode =
    session.reauthUserId ? 'reauth' : session.linkUserId ? 'link' : 'login';
```

In `checkProviderGeneration` (`apps/api/src/routes/sso.ts:612-632`), reauth follows link's rule — a `testing` provider is acceptable, `inactive` is not — so the existing `mode === 'login'` branch already gives the right behaviour. Leave it, but extend the doc comment above it to say reauth shares link's rule.

Generalize the binding validator. Rename nothing; change its signature to take the bound user id explicitly and update the two call sites:

```ts
async function validateSessionBinding(
  session: typeof ssoSessions.$inferSelect,
  provider: typeof ssoProviders.$inferSelect,
  boundUserId: string,
): Promise<{ ok: true; user: typeof users.$inferSelect } | { ok: false; reason: LinkRejectReason }> {
```

(The body is unchanged apart from using `boundUserId` where it used `session.linkUserId`. Keep the existing `LinkRejectReason` union — the reasons are identical.) The link branch now calls `validateSessionBinding(session, provider, session.linkUserId)`.

Add the reauth branch in the callback **immediately before** the `if (session.linkUserId) {` block (`apps/api/src/routes/sso.ts:2325`), so it sits after the full id_token signature/nonce verification, the atomic session claim, and the userinfo `sub` binding — the same position link mode occupies:

```ts
    // #4018 reauth mode: an already-authenticated, PASSWORDLESS user proving
    // identity through a fresh IdP round-trip so they can enroll a first MFA
    // factor. Mints NO tokens, creates NO users, links NO identities — its only
    // output is a single-use step-up grant.
    if (session.reauthUserId) {
      const reauthUserId = session.reauthUserId;

      // The IdP must have ACTUALLY re-authenticated for THIS transaction.
      // Bounded from the session's own created_at, not from now: an auth_time
      // that predates the user's click is a cached session, however recent it
      // looks. Fails closed on a missing auth_time.
      const freshness = assertFreshIdpAuthentication(idClaims, session.createdAt.getTime());
      if (!freshness.ok) {
        writeRouteAudit(c, {
          orgId: provider.orgId,
          action: 'sso.reauth.rejected',
          resourceType: 'sso_provider',
          resourceId: provider.id,
          resourceName: provider.name,
          result: 'denied',
          details: { mode: 'reauth', reason: freshness.reason, userId: reauthUserId }
        });
        clearStateCookie();
        return c.redirect('/settings/profile?error=reauth_not_fresh');
      }

      const outcome = await withSystemDbAccessContext(async () => {
        const binding = await validateSessionBinding(session, provider, reauthUserId);
        if (!binding.ok) {
          return { error: 'session_invalid' as const, auditReason: binding.reason };
        }

        // STRICTER than link mode's email comparison: the asserted (provider,
        // sub) must ALREADY be this user's identity. An IdP where users can
        // change their own email would otherwise let one user re-auth as
        // another by matching an address.
        const [identity] = await db
          .select({ userId: userSsoIdentities.userId })
          .from(userSsoIdentities)
          .where(and(
            eq(userSsoIdentities.providerId, provider.id),
            // `externalSub` is the verified id_token `sub`, declared at
            // sso.ts:2313 — already cross-checked against userinfo's `sub` at
            // :2220. Insert this branch BELOW that line so it is in scope.
            eq(userSsoIdentities.externalId, externalSub)
          ))
          .limit(1);
        if (!identity || identity.userId !== reauthUserId) {
          return { error: 'identity_mismatch' as const };
        }

        // Belt-and-braces: the account must still be passwordless. A password
        // set between /reauth/start and here means the ordinary step-up applies.
        if (binding.user.passwordHash != null) {
          return { error: 'password_set' as const };
        }

        return {
          ok: true as const,
          authEpoch: session.initiatingAuthEpoch!,
          mfaEpoch: session.initiatingMfaEpoch!,
          sid: session.initiatingSessionId!,
        };
      });

      clearStateCookie();

      if (!('ok' in outcome)) {
        writeRouteAudit(c, {
          orgId: provider.orgId,
          action: 'sso.reauth.rejected',
          resourceType: 'sso_provider',
          resourceId: provider.id,
          resourceName: provider.name,
          result: 'denied',
          details: {
            mode: 'reauth',
            reason: 'auditReason' in outcome ? outcome.auditReason : outcome.error,
            userId: reauthUserId
          }
        });
        return c.redirect(`/settings/profile?error=${outcome.error}`);
      }

      const grantId = await mintStepUpGrant({
        userId: reauthUserId,
        operation: 'enroll_first_factor',
        authEpoch: outcome.authEpoch,
        mfaEpoch: outcome.mfaEpoch,
        sid: outcome.sid,
      });
      if (!grantId) {
        return c.redirect('/settings/profile?error=reauth_unavailable');
      }

      writeRouteAudit(c, {
        orgId: provider.orgId,
        action: 'sso.reauth.completed',
        resourceType: 'sso_provider',
        resourceId: provider.id,
        resourceName: provider.name,
        details: { partnerId: provider.partnerId, userId: reauthUserId }
      });

      // Fragment, not query: never sent to the server, never in an access log.
      // Same channel the login path already uses for #ssoCode.
      return c.redirect(`/settings/profile#ssoReauthGrant=${grantId}`);
    }
```

Import `assertFreshIdpAuthentication` from `../services/sso` and `mintStepUpGrant` from `../services/mfaStepUpGrant`. No new TTL constant is needed: the transaction's own `expiresAt` (10 minutes, set at `/reauth/start`) already bounds how long the round trip may take, and `created_at` supplies the lower bound for `auth_time`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @breeze/api test -- --run src/routes/sso.reauth.test.ts src/routes/sso.test.ts src/services/mfaStepUpGrant.test.ts`
Expected: PASS. The existing link-mode tests in `sso.test.ts` must still pass — they exercise the validator you renamed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/services/mfaStepUpGrant.ts apps/api/src/routes/sso.reauth.test.ts
git commit -m "feat(api): mint enroll_first_factor grant from a fresh SSO re-auth (#4018)"
```

---

### Task 5: Enrollment endpoints accept the grant

**Files:**
- Create: `resolveEnrollmentStepUp` in `apps/api/src/routes/auth/helpers.ts` (next to `requireCurrentPasswordStepUp`, line 148)
- Modify: `apps/api/src/routes/auth/mfa.ts:58-61` (`passwordOnlySchema`), `:75` (`/mfa/setup`), `:613` (`/mfa/enable`)
- Modify: `apps/api/src/routes/auth/passkeys.ts:64,86` (schemas), `:119` (`register/options`), `:555`
- Test: `apps/api/src/routes/auth/helpers.enrollmentStepUp.test.ts` (new), plus additions to `apps/api/src/routes/auth/mfa.test.ts` and `apps/api/src/routes/auth/passkeys.test.ts`

**Interfaces:**
- Consumes: `consumeStepUpGrant` / `validateStepUpGrant` with `operation: 'enroll_first_factor'`.
- Produces:

```ts
export async function resolveEnrollmentStepUp(
  c: Context,
  auth: AuthContext,
  input: { currentPassword?: string; ssoReauthGrantId?: string },
  opts: { keyPrefix: string; consume: boolean },
): Promise<Response | null>
```

Returns `null` when the caller proved identity, or the error `Response` to return.

**Design notes:**
- Password path unchanged and still first. The SSO path is only reachable when `password_hash IS NULL`.
- `consume: false` for `passkeys/register/options`; `consume: true` for every terminal write (`/mfa/setup` confirm, `/mfa/enable`, `passkeys/register/verify`) — the same split `validateStepUpGrant`/`consumeStepUpGrant` already uses.
- Do **not** touch `enforceExistingFactorStepUp`. Adding a second factor still requires the first.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/auth/helpers.enrollmentStepUp.test.ts`:

```ts
describe('resolveEnrollmentStepUp', () => {
  it('takes the password path when a password is supplied', async () => {
    mockUser({ passwordHash: HASH });
    mockVerifyPassword(true);
    const res = await resolveEnrollmentStepUp(ctx, auth, { currentPassword: 'pw' }, { keyPrefix: 'mfa:pwd', consume: true });
    expect(res).toBeNull();
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('rejects an SSO grant when the account HAS a password', async () => {
    mockUser({ passwordHash: HASH });
    const res = await resolveEnrollmentStepUp(ctx, auth, { ssoReauthGrantId: 'g' }, { keyPrefix: 'mfa:pwd', consume: true });
    expect(res?.status).toBe(401);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('accepts a valid SSO grant for a passwordless account and consumes it', async () => {
    mockUser({ passwordHash: null });
    mockUserEpochs({ authEpoch: 3, mfaEpoch: 1 });
    consumeStepUpGrant.mockResolvedValue(true);
    const res = await resolveEnrollmentStepUp(ctx, auth, { ssoReauthGrantId: 'g' }, { keyPrefix: 'mfa:pwd', consume: true });
    expect(res).toBeNull();
    expect(consumeStepUpGrant).toHaveBeenCalledWith('g', {
      userId: auth.user.id, operation: 'enroll_first_factor', authEpoch: 3, mfaEpoch: 1, sid: auth.token.sid,
    });
  });

  it('validates without consuming when consume is false', async () => {
    mockUser({ passwordHash: null });
    mockUserEpochs({ authEpoch: 3, mfaEpoch: 1 });
    validateStepUpGrant.mockResolvedValue(true);
    const res = await resolveEnrollmentStepUp(ctx, auth, { ssoReauthGrantId: 'g' }, { keyPrefix: 'passkey:pwd', consume: false });
    expect(res).toBeNull();
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('401s a grant that fails to validate (wrong session, bumped epoch, replay)', async () => {
    mockUser({ passwordHash: null });
    mockUserEpochs({ authEpoch: 3, mfaEpoch: 1 });
    consumeStepUpGrant.mockResolvedValue(false);
    const res = await resolveEnrollmentStepUp(ctx, auth, { ssoReauthGrantId: 'g' }, { keyPrefix: 'mfa:pwd', consume: true });
    expect(res?.status).toBe(401);
  });

  it('401s when neither proof is supplied', async () => {
    mockUser({ passwordHash: null });
    const res = await resolveEnrollmentStepUp(ctx, auth, {}, { keyPrefix: 'mfa:pwd', consume: true });
    expect(res?.status).toBe(401);
  });
});
```

Add to `apps/api/src/routes/auth/mfa.test.ts`:

```ts
it('POST /auth/mfa/setup accepts ssoReauthGrantId for a passwordless account', async () => {
  mockUser({ passwordHash: null, mfaEnabled: false });
  mockUserEpochs({ authEpoch: 3, mfaEpoch: 1 });
  consumeStepUpGrant.mockResolvedValue(true);
  const res = await app.request('/auth/mfa/setup', {
    method: 'POST',
    body: JSON.stringify({ ssoReauthGrantId: 'grant-abc' }),
    headers: { 'content-type': 'application/json' },
  }, ENV);
  expect(res.status).toBe(200);
  expect((await res.json()).secret).toBeTruthy();
});

it('POST /auth/mfa/setup still 401s a passwordless account with no proof at all', async () => {
  mockUser({ passwordHash: null, mfaEnabled: false });
  const res = await app.request('/auth/mfa/setup', {
    method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' },
  }, ENV);
  expect(res.status).toBe(401);
});
```

Add the mirror test for `POST /auth/passkeys/register/options` in `apps/api/src/routes/auth/passkeys.test.ts`, asserting `validateStepUpGrant` (not `consume`) was called.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @breeze/api test -- --run src/routes/auth/helpers.enrollmentStepUp.test.ts src/routes/auth/mfa.test.ts src/routes/auth/passkeys.test.ts`
Expected: FAIL — `resolveEnrollmentStepUp` is not exported; the routes reject the body because `currentPassword` is required.

- [ ] **Step 3: Implement**

Add to `apps/api/src/routes/auth/helpers.ts` after `requireCurrentPasswordStepUp` (line 183):

```ts
/**
 * The single decision point for "may this caller install a FIRST MFA factor?".
 *
 * Two roads, never both:
 *   - password   — the historical path, unchanged.
 *   - SSO re-auth grant — for accounts with password_hash IS NULL, which have
 *     no password to prove and previously could not enroll at all (#4018).
 *
 * The SSO road is refused outright for an account that HAS a password: two
 * roads of differing strength to the same door is how a step-up gets bypassed.
 */
export async function resolveEnrollmentStepUp(
  c: Context,
  auth: AuthContext,
  input: { currentPassword?: string; ssoReauthGrantId?: string },
  opts: { keyPrefix: string; consume: boolean },
): Promise<Response | null> {
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);
  if (!user) return c.json({ error: 'Invalid credentials' }, 401);

  if (user.passwordHash != null) {
    if (!input.currentPassword) return c.json({ error: 'Invalid credentials' }, 401);
    return requireCurrentPasswordStepUp(c, auth.user.id, input.currentPassword, opts.keyPrefix);
  }

  if (!input.ssoReauthGrantId) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const epochs = await getUserEpochs(auth.user.id);
  const sid = auth.token?.sid;
  if (!epochs || !sid) return c.json({ error: 'Service temporarily unavailable' }, 503);

  const bind = {
    userId: auth.user.id,
    operation: 'enroll_first_factor' as const,
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid,
  };
  const ok = opts.consume
    ? await consumeStepUpGrant(input.ssoReauthGrantId, bind)
    : await validateStepUpGrant(input.ssoReauthGrantId, bind);
  if (!ok) return c.json({ error: 'Invalid credentials' }, 401);

  return null;
}
```

In `apps/api/src/routes/auth/mfa.ts`, replace `passwordOnlySchema` (line 58-61) with:

```ts
// Either proof is acceptable; resolveEnrollmentStepUp decides WHICH is allowed
// for this account. Both absent is a 401 there, not a 400 here — the shape of
// the rejection must not tell an attacker whether the account has a password.
const enrollmentStepUpSchema = z.object({
  currentPassword: z.string().min(1).max(256).optional(),
  ssoReauthGrantId: z.string().uuid().optional(),
});
```

Update `/mfa/setup` (line 75) and `/mfa/enable` (line 613) to validate against the new schema (for `/mfa/enable`, extend rather than replace — it also carries `stepUpGrantId` and the TOTP code) and replace their `requireCurrentPasswordStepUp(...)` call with:

```ts
  const stepUpError = await resolveEnrollmentStepUp(c, auth, body, { keyPrefix: 'mfa:pwd', consume: true });
  if (stepUpError) return stepUpError;
```

Do the same in `apps/api/src/routes/auth/passkeys.ts` at line 119 (`consume: false`, `keyPrefix: 'passkey:pwd'`) and line 561 (`consume: true`). Extend the two schemas at lines 64 and 86 the same way.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @breeze/api test -- --run src/routes/auth/`
Expected: PASS — the whole auth directory, not just the three files, since the schemas changed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/helpers.ts apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth/passkeys.ts apps/api/src/routes/auth/helpers.enrollmentStepUp.test.ts apps/api/src/routes/auth/mfa.test.ts apps/api/src/routes/auth/passkeys.test.ts
git commit -m "feat(api): accept SSO re-auth grant in place of a password for first-factor enrollment (#4018)"
```

---

### Task 6: `/auth/me` exposes `hasPassword`; web offers the SSO path

**Files:**
- Modify: `apps/api/src/routes/auth/password.ts:365-399` (`/auth/me`)
- Modify: `apps/web/src/components/settings/ProfilePage.tsx`
- Test: `apps/api/src/routes/auth/password.test.ts`, `apps/web/src/components/settings/ProfilePage.test.tsx`

**Interfaces:**
- Consumes: `POST /api/v1/sso/reauth/start` (Task 3), the `#ssoReauthGrant=<id>` fragment (Task 4), `ssoReauthGrantId` on the enrollment endpoints (Task 5).
- Produces: `GET /auth/me` → `user.hasPassword: boolean`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/routes/auth/password.test.ts`:

```ts
it('GET /auth/me reports hasPassword false for an SSO-provisioned user', async () => {
  mockUser({ passwordHash: null });
  const res = await app.request('/auth/me', {}, ENV);
  expect((await res.json()).user.hasPassword).toBe(false);
});

it('GET /auth/me reports hasPassword true for a password user and never leaks the hash', async () => {
  mockUser({ passwordHash: 'argon2id$abc' });
  const body = await (await app.request('/auth/me', {}, ENV)).json();
  expect(body.user.hasPassword).toBe(true);
  expect(JSON.stringify(body)).not.toContain('argon2id');
});
```

`apps/web/src/components/settings/ProfilePage.test.tsx`:

```tsx
it('shows the IdP verification button instead of the password prompt for a passwordless account', async () => {
  renderProfile({ user: { hasPassword: false, mfaEnabled: false } });
  await userEvent.click(screen.getByTestId('mfa-setup-start'));
  expect(screen.getByTestId('mfa-sso-reauth')).toBeTruthy();
  expect(screen.queryByTestId('mfa-current-password')).toBeNull();
});

it('shows the password prompt for an account that has a password', async () => {
  renderProfile({ user: { hasPassword: true, mfaEnabled: false } });
  await userEvent.click(screen.getByTestId('mfa-setup-start'));
  expect(screen.getByTestId('mfa-current-password')).toBeTruthy();
  expect(screen.queryByTestId('mfa-sso-reauth')).toBeNull();
});

it('consumes the #ssoReauthGrant fragment and clears it from the URL', async () => {
  window.location.hash = '#ssoReauthGrant=grant-abc';
  renderProfile({ user: { hasPassword: false, mfaEnabled: false } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/auth/mfa/setup'),
    expect.objectContaining({ body: JSON.stringify({ ssoReauthGrantId: 'grant-abc' }) }),
  ));
  // The grant is single-use — leaving it in the address bar invites a
  // confusing second attempt after it has already been consumed.
  expect(window.location.hash).toBe('');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @breeze/api test -- --run src/routes/auth/password.test.ts
pnpm --filter @breeze/web test -- --run src/components/settings/ProfilePage.test.tsx
```
Expected: FAIL — `hasPassword` undefined; no `mfa-sso-reauth` testid.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/auth/password.ts`, add `passwordHash: users.passwordHash` to the select at line 369, then destructure it out of the response exactly as `phoneNumber` already is:

```ts
  const { phoneNumber: rawPhone, passwordHash, ...userWithoutPhone } = user;
  ...
    user: {
      ...userWithoutPhone,
      // Whether a password step-up is even possible for this account. The hash
      // itself is destructured away above and never serialized.
      hasPassword: passwordHash != null,
      mfaEnabled: effectiveMfaEnabled,
```

In `ProfilePage.tsx`: when `user.hasPassword === false`, render a button (`data-testid="mfa-sso-reauth"`) reading *"Verify with your identity provider"* that POSTs to `/api/v1/sso/reauth/start` via `runAction` and sets `window.location.href = authUrl`. On mount, read `window.location.hash`; if it matches `#ssoReauthGrant=<id>`, call the enrollment endpoint with `{ ssoReauthGrantId }` instead of `{ currentPassword }`, then clear the hash with `history.replaceState(null, '', window.location.pathname)`. Handle `?error=` values from the callback (`reauth_not_fresh`, `identity_mismatch`, `session_invalid`, `password_set`, `reauth_unavailable`) with a toast; `reauth_not_fresh` gets specific copy: *"Your identity provider did not re-verify your sign-in. Try again, or ask your administrator to allow re-authentication prompts."*

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @breeze/api test -- --run src/routes/auth/password.test.ts
pnpm --filter @breeze/web test -- --run src/components/settings/ProfilePage.test.tsx
pnpm --filter @breeze/web test -- --run src/lib/__tests__/no-silent-mutations.test.ts
```
Expected: PASS. The `no-silent-mutations` guard is included because Task 6 adds a mutation handler — it must go through `runAction`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/password.ts apps/api/src/routes/auth/password.test.ts apps/web/src/components/settings/ProfilePage.tsx apps/web/src/components/settings/ProfilePage.test.tsx
git commit -m "feat(web): enroll MFA via IdP re-verification on passwordless accounts (#4018)"
```

---

### Task 7: Expose `trustsIdpMfa`, fix the misleading copy, document both

The other half of #4018: the setting that would let an IdP's MFA satisfy `requireMfa()` exists but has no UI and no docs, and the error message sends SSO users somewhere that cannot help them.

**Files:**
- Modify: `apps/web/src/components/settings/SsoProvidersPage.tsx`
- Modify: `apps/web/src/components/devices/AddDeviceModal.tsx:959-1000,1064-1075`
- Modify: `apps/web/src/locales/en/devices.json` (the three `multiFactorAuthenticationIsRequiredTo*` keys)
- Modify: `apps/docs/src/content/docs/reference/sso.mdx` (§ Partner-Wide SSO, and the `sso_providers` field table)
- Test: `apps/web/src/components/settings/SsoProvidersPage.test.tsx`, `apps/web/src/components/devices/AddDeviceModal.test.tsx`

**Interfaces:**
- Consumes: `trustsIdpMfa` already exists on `createProviderSchema`/`updateProviderSchema` (`apps/api/src/routes/sso.ts:180,189`) and is already returned by `GET /sso/providers` (`:872,896`). **No API change is needed** — verify this before writing any.

- [ ] **Step 1: Write the failing tests**

```tsx
// SsoProvidersPage.test.tsx
it('renders the trust-IdP-MFA toggle reflecting the provider value', () => {
  renderPage({ providers: [{ id: P, name: 'Entra', trustsIdpMfa: false }] });
  expect((screen.getByTestId('provider-trusts-idp-mfa') as HTMLInputElement).checked).toBe(false);
});

it('PATCHes trustsIdpMfa when toggled', async () => {
  renderPage({ providers: [{ id: P, name: 'Entra', trustsIdpMfa: false }] });
  await userEvent.click(screen.getByTestId('provider-trusts-idp-mfa'));
  await userEvent.click(screen.getByTestId('provider-save'));
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining(`/sso/providers/${P}`),
    expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('"trustsIdpMfa":true') }),
  );
});

// AddDeviceModal.test.tsx
it('gives SSO sessions provider-specific guidance instead of the profile-settings dead end', () => {
  renderModal({ linkError: 'MFA_REQUIRED', authMethod: 'sso' });
  expect(screen.getByText(/identity provider/i)).toBeTruthy();
  expect(screen.queryByText(/Set up MFA in your profile settings/i)).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @breeze/web test -- --run src/components/settings/SsoProvidersPage.test.tsx src/components/devices/AddDeviceModal.test.tsx
```
Expected: FAIL — no `provider-trusts-idp-mfa` testid; the modal renders the old copy unconditionally.

- [ ] **Step 3: Implement**

Add the toggle to the provider form in `SsoProvidersPage.tsx`, labelled **"Trust this provider's MFA"** with helper text: *"When your identity provider reports that multi-factor authentication was used (`amr: mfa`), treat MFA as satisfied in Breeze. Your IdP must include the `amr` claim in its ID token — most require this to be enabled explicitly. Off by default."*

In `AddDeviceModal.tsx`, branch the three `MFA_REQUIRED` blocks on whether the session came from SSO (read it from the auth store — the token's `method`/`amr` context already available to the web client; if it is not exposed, use `hasPassword === false` from Task 6 as the discriminator and say so in a comment). SSO copy: *"Multi-factor authentication is required to generate links. Your organization signs you in through an identity provider — ask your administrator to enable MFA trust for it, or enroll a factor in your profile settings."* Keep the existing copy for password sessions. Add the new strings to `apps/web/src/locales/en/devices.json`; leave the existing keys in place for the password branch.

In `sso.mdx`, document `trustsIdpMfa` in the provider field table, add a short **"Satisfying Breeze MFA with your IdP"** subsection under Partner-Wide SSO covering the `amr` requirement and the fail-safe default, and add **"Enrolling MFA on a passwordless SSO account"** describing the Task 3-6 flow.

- [ ] **Step 4: Run the tests and the docs build**

```bash
pnpm --filter @breeze/web test -- --run src/components/settings/SsoProvidersPage.test.tsx src/components/devices/AddDeviceModal.test.tsx
pnpm --filter @breeze/web test -- --run src/i18n
pnpm --filter @breeze/docs build
```
Expected: PASS, and the docs build succeeds. The i18n run catches the locale-parity failure a new `en` key causes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/SsoProvidersPage.tsx apps/web/src/components/devices/AddDeviceModal.tsx apps/web/src/locales/en/devices.json apps/docs/src/content/docs/reference/sso.mdx apps/web/src/components/settings/SsoProvidersPage.test.tsx apps/web/src/components/devices/AddDeviceModal.test.tsx
git commit -m "feat(web): expose IdP MFA trust, fix SSO MFA copy, document both (#4018)"
```

---

## Pre-PR verification

Run before opening the PR — not per task:

```bash
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
pnpm lint
pnpm build
# Tenancy/cascade code was touched (schema + tenantCascade comment), so the
# contract suites are mandatory. They need a live database.
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter @breeze/api test:rls
pnpm --filter @breeze/api test:integration
```

Then verify the loop is actually broken, end to end, against a real stack:

1. Create an SSO provider, `trustsIdpMfa` off, and sign in as a JIT-provisioned user.
2. Add Device → Generate Link → confirm the 403 and the new SSO-specific copy.
3. Profile → Set up MFA → confirm the IdP button appears (not a password prompt).
4. Complete the IdP round-trip; confirm you land on `/settings/profile` with the TOTP secret shown and the hash cleared.
5. Enroll, sign out, sign in via SSO again, retry Generate Link. **Expect it to still fail** — the `mfa` claim is a login-time property and `trustsIdpMfa` is still off. That is correct behaviour, and exactly why Task 7 exists.
6. Turn on the new toggle, sign in via SSO again, retry. Confirm success **and** confirm the `user.login` audit row now records `mfa: true`.
7. Negative test: point a provider at an IdP that omits `auth_time`, run the re-auth flow, and confirm `error=reauth_not_fresh` with no grant minted.

Step 5 is the one worth being explicit about with reviewers: enrolling a factor does not retroactively satisfy an existing session's claim, and nothing in this plan changes that.

---

## Deliberately out of scope — file as follow-ups

These surfaced while scoping and are real, but each is its own change. Do not let them grow this PR.

1. **A passkey alone still cannot reach L4.** `requireFreshMfaStepUp` allowlists `mfaMethod === 'totp'` and nothing else (`apps/api/src/routes/auth/helpers.ts:218-223`). After this plan a passwordless SSO user can enroll a passkey and satisfy L2/L3, but critical-tier approvals would still refuse them. If passkey-first onboarding is meant to unlock the full ladder, fresh *passkey* re-authentication for L4 needs its own design.
2. **No client ever sends the L4 re-auth fields.** `reauthPassword` / `reauthMfaCode` have zero references in `apps/web/src` and `apps/mobile/src`; mobile's `approveRequest` sends only a step-up proof (`apps/mobile/src/services/approvals.ts:97`). So `riskTier: 'critical'` approvals are unapprovable from every UI today. AI never hits it (Tier 4 is refused before an intent exists, `apps/api/src/services/actionIntents/intentService.ts:348`), so it currently only affects PAM (`apps/api/src/routes/pam.ts:432`).
3. **Optional `acr` pinning.** A tenant that needs a specific IdP assurance class (phishing-resistant, say) has no way to demand it. `assertFreshIdpAuthentication` proves *freshness*, not *strength*. A per-provider `required_acr` would close that, and would also give `trustsIdpMfa` a sharper meaning than RFC 8176's deliberately context-dependent `amr: mfa`.
4. **Stale comment at `apps/api/src/routes/sso.ts:69`.** It attributes the state-cookie protection to `SameSite=Lax` omitting the cookie on the callback; `Lax` cookies *are* sent on cross-site top-level GET navigations. The real protection is the HMAC binding to the unpredictable single-use state, which is sound — only the explanation is wrong. Worth correcting so nobody "simplifies" the HMAC away on the strength of it.
