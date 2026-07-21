# PR 1 — Authentication Lifecycle Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make durable database state — user epochs + refresh-family lifetime — the authority for session validity, so a credential issued before a security-state change cannot be replayed afterward, and logout/reset/membership-removal revoke sessions truthfully.

**Architecture:** Add four monotonic integer epoch columns to `users` (`auth_epoch`, `mfa_epoch`, `email_epoch`, `password_reset_epoch`) and an `absolute_expires_at` cap to `refresh_token_families`. Access/refresh JWTs gain `aep` (auth_epoch), `mep` (mfa_epoch), and `sid` (refresh-family id) claims minted from the live DB row. `authMiddleware` — which already loads the live user row — additionally rejects tokens whose epochs are stale or whose claims are missing, binds `scope='system'` to the live `is_platform_admin` flag, and binds `scope='partner'` to a live `partner_users` membership (riding the `partner_users` query `computeAccessibleOrgIds` already performs — zero extra queries). The `/refresh` handler applies the same epoch gate itself (it runs outside the middleware). A new transaction-oriented `authLifecycle` service advances epochs and revokes refresh families inside the same DB transaction as the business mutation (status change, password change/reset, membership removal), with Redis + OAuth-grant cleanup running after the durable commit. This is a deliberate global sign-out: every legacy token lacking the new claims is rejected on first use.

**Tech Stack:** Hono (TypeScript), Drizzle ORM, PostgreSQL (RLS via `breeze_app`), Redis (ioredis), `jose` (HS256 JWT keyring), Vitest.

## Global Constraints

- **Node 22.20.0.** Prefix every `pnpm`/`node` command with `export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"` (no version manager is installed; the pinned binary lives there).
- **Migrations are hand-written idempotent SQL only.** `ADD COLUMN IF NOT EXISTS`, `DO $$ … END $$` guards. Never `drizzle-kit generate`/`push`. Never edit a shipped migration. No inner `BEGIN;`/`COMMIT;` (the runner wraps each file in a transaction). File name `YYYY-MM-DD-<slug>.sql`, lexicographically after the latest existing migration (`2026-07-14-backup-feature-link-cascade.sql`).
- **`pnpm db:check-drift` must pass** after schema edits (`export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"` first).
- **Epoch enforcement is scoped to `aud=breeze-api` user tokens only.** Do not touch the agent (`agentAuth`), Helper (`helperAuth` — it builds a *synthetic* `AuthContext.token` with no epoch claims, so enforcement must live where real JWTs are verified in `verifyToken`/`authMiddleware`, never on downstream `AuthContext` consumers), portal, viewer (`breeze-viewer` audience), MCP OAuth EdDSA bearer, or installer-bootstrap paths.
- **Audit events never contain raw JWTs, tokens, or credential material.**
- **Commit after each green task.** TDD: write the failing test, observe the reviewed failure, then implement.
- **Never widen a narrower ambient DB context by calling `withSystemDbAccessContext` alone** — `withDbAccessContext` no-ops when a context is already active. Use `runOutsideDbContext` first if you must escalate from inside a request context (not expected in PR 1 mint paths, which run pre-context).

## File Structure

- **Create** `apps/api/migrations/2026-07-15-auth-epochs-and-family-expiry.sql` — epoch columns + `absolute_expires_at`. (Dated `-15`, not `-11`: the latest shipped migration is `2026-07-14-backup-feature-link-cascade.sql` and the runner applies files in lexicographic order — a `2026-07-11-*` name would sort BEFORE already-shipped files. The runner tracks applied files by name so nothing re-applies, but keep the order clean.)
- **Modify** `apps/api/src/db/schema/users.ts` — four epoch columns.
- **Modify** `apps/api/src/db/schema/refreshTokenFamilies.ts` — `absoluteExpiresAt`.
- **Modify** `apps/api/src/services/jwt.ts` — `aep`/`mep`/`sid` on `TokenPayload`, mint + verify.
- **Create** `apps/api/src/services/authEpochs.ts` — read current epochs for a user (mint-side helper).
- **Create** `apps/api/src/services/authLifecycle.ts` — transaction primitives + post-commit cleanup.
- **Create** `apps/api/src/services/authLifecycle.test.ts`, `authEpochs.test.ts`.
- **Modify** mint sites: `routes/auth/login.ts` (login + refresh + logout), `routes/auth/mfa.ts`, `routes/auth/register.ts`, `routes/auth/invite.ts`, `routes/auth/passkeys.ts`, `routes/sso.ts`, `middleware/cfAccessLogin.ts`, `routes/auth/cfAccessRedirectLogin.ts`.
- **Modify** `apps/api/src/middleware/auth.ts` — epoch + live `is_platform_admin` enforcement.
- **Modify** `apps/api/src/services/refreshTokenFamily.ts` — set `absoluteExpiresAt` on mint; expose lookup.
- **Modify** `apps/api/src/routes/auth/password.ts` — reset-generation binding (SR2-08).
- **Modify** `apps/api/src/middleware/apiKeyAuth.ts` — disabled-creator rejection (cheap SR2-15 half).
- **Modify** test builders `apps/api/src/__tests__/helpers.ts`, `apps/api/src/__tests__/integration/db-utils.ts`.
- **Modify** callers that mutate security state to route through `authLifecycle`: `routes/users.ts`, `routes/admin/abuse.ts`, `routes/accessReviews.ts`.

Epoch columns are added to `users` and `refresh_token_families`, both already RLS-enabled — **no new tables and no new RLS policies in PR 1**, so no `rls-coverage.integration.test.ts` allowlist changes are needed. The migration adds columns only.

---

### Task 1: Epoch + absolute-expiry migration and schema

**Files:**
- Create: `apps/api/migrations/2026-07-15-auth-epochs-and-family-expiry.sql`
- Modify: `apps/api/src/db/schema/users.ts:62` (after `isPlatformAdmin`)
- Modify: `apps/api/src/db/schema/refreshTokenFamilies.ts:38` (after `revokedReason`)

**Interfaces:**
- Produces: `users.authEpoch`, `users.mfaEpoch`, `users.emailEpoch`, `users.passwordResetEpoch` (all `integer NOT NULL DEFAULT 1`); `refreshTokenFamilies.absoluteExpiresAt` (`timestamp withTimezone`, not null).

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-07-15-auth-epochs-and-family-expiry.sql`:

```sql
-- Core authentication hardening PR 1: durable security-state epochs on users
-- and an absolute lifetime cap on refresh-token families. Idempotent.
--
-- Epochs are monotonic counters advanced by the auth-lifecycle service inside
-- the same transaction as the security mutation that invalidates prior
-- credentials (status/password/membership/MFA/email changes). Access & refresh
-- JWTs carry auth_epoch/mfa_epoch; a mismatch on the live row rejects the token.

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_epoch integer NOT NULL DEFAULT 1;

-- Absolute family lifetime: a refresh chain may rotate freely but the family
-- cannot outlive this wall-clock cap regardless of rotation. Existing families
-- get created_at + 30d so no live session is force-killed by the backfill
-- earlier than the new default would have; new rows are stamped by the app at
-- mint time (services/refreshTokenFamily.ts).
ALTER TABLE refresh_token_families
  ADD COLUMN IF NOT EXISTS absolute_expires_at timestamptz;

DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE refresh_token_families
     SET absolute_expires_at = created_at + interval '30 days'
   WHERE absolute_expires_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled absolute_expires_at on % refresh_token_families rows', n;
  END IF;
END $$;

ALTER TABLE refresh_token_families ALTER COLUMN absolute_expires_at SET NOT NULL;
```

- [ ] **Step 2: Add the Drizzle columns**

In `apps/api/src/db/schema/users.ts`, immediately after the `isPlatformAdmin` line (`:62`):

```ts
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  // Durable authentication-state epochs (core-auth hardening PR 1). Advanced by
  // services/authLifecycle.ts inside the same transaction as the mutation that
  // invalidates prior credentials. Access/refresh JWTs carry auth_epoch +
  // mfa_epoch; a stale claim is rejected in authMiddleware / on /refresh.
  authEpoch: integer('auth_epoch').notNull().default(1),
  mfaEpoch: integer('mfa_epoch').notNull().default(1),
  emailEpoch: integer('email_epoch').notNull().default(1),
  passwordResetEpoch: integer('password_reset_epoch').notNull().default(1),
```

Add `integer` to the `drizzle-orm/pg-core` import on line 1 (append `, integer`).

In `apps/api/src/db/schema/refreshTokenFamilies.ts`, after `revokedReason` (`:38`):

```ts
    revokedReason: varchar('revoked_reason', { length: 64 }),
    // Absolute wall-clock cap on the family. Rotation never extends this;
    // /refresh rejects a family past it. Set at mint time.
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
```

- [ ] **Step 3: Apply migration and verify no drift**

**`pnpm db:migrate` is a NO-OP** — `src/db/autoMigrate.ts` only *exports* `autoMigrate()`; the call sites are server boot (`src/index.ts`) and the integration-test setup. Apply ad-hoc with a throwaway tsx eval:

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm exec tsx -e "import('./src/db/autoMigrate.ts').then(m => m.autoMigrate()).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })" && pnpm db:check-drift
```
Expected: migration applies; `db:check-drift` reports **no drift**. (The integration DB on `:5433` is migrated automatically by `__tests__/integration/setup.ts` when Task 13 runs — no manual step. The RLS runner has no setupFiles, but PR 1 adds no tables/policies so the RLS suite needs no fresh migration.)

- [ ] **Step 4: Run the migration-ordering regression test**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/db/autoMigrate.test.ts
```
Expected: PASS (confirms the new filename sorts correctly and the file is idempotent-parseable).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-07-15-auth-epochs-and-family-expiry.sql apps/api/src/db/schema/users.ts apps/api/src/db/schema/refreshTokenFamilies.ts
git commit -m "feat(auth): add user auth-state epochs and refresh-family absolute expiry"
```

---

### Task 2: Epoch claims in the JWT service

**Files:**
- Modify: `apps/api/src/services/jwt.ts` (`TokenPayload` `:179`, `createTokenPair` `:350`, `verifyToken` `:257`)
- Test: `apps/api/src/services/jwt.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TokenPayload` gains `aep?: number`, `mep?: number`, `sid?: string`. `createTokenPair(payload, { refreshFam })` puts `sid = refreshFam` on the **access** token and keeps `fam = refreshFam` on the refresh token; both carry `aep`/`mep` from `payload`. `verifyToken` surfaces `aep`/`mep`/`sid` (numbers/strings or `undefined`).

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/jwt.test.ts`. The file already exists — **reuse/extend its existing imports** (add `createTokenPair`/`verifyToken`/`beforeAll` to them only if not already imported; do NOT add a second `import { … } from 'vitest'` line, that's a redeclaration error):

```ts
describe('epoch + sid claims', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-at-least-32-chars-long-xxxxx';
  });

  it('carries aep/mep on both tokens and sid on the access token', async () => {
    const pair = await createTokenPair(
      {
        sub: '11111111-1111-1111-1111-111111111111',
        email: 'a@b.com',
        roleId: null,
        orgId: null,
        partnerId: null,
        scope: 'system',
        mfa: true,
        aep: 4,
        mep: 2,
      },
      { refreshFam: '22222222-2222-2222-2222-222222222222' }
    );

    const access = await verifyToken(pair.accessToken);
    const refresh = await verifyToken(pair.refreshToken);
    expect(access?.aep).toBe(4);
    expect(access?.mep).toBe(2);
    expect(access?.sid).toBe('22222222-2222-2222-2222-222222222222');
    expect(access?.fam).toBeUndefined();
    expect(refresh?.aep).toBe(4);
    expect(refresh?.mep).toBe(2);
    expect(refresh?.fam).toBe('22222222-2222-2222-2222-222222222222');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/jwt.test.ts -t 'epoch'
```
Expected: FAIL — `access?.aep` is `undefined` / `sid` is `undefined`.

- [ ] **Step 3: Implement the claims**

In `TokenPayload` (`:179`), after the `fam?: string;` block add:

```ts
  fam?: string;
  // Durable auth-state epochs (core-auth hardening PR 1). Minted from the live
  // user row. authMiddleware / /refresh reject a token whose aep/mep is behind
  // the current row. Legacy tokens predating the rollout have neither and are
  // rejected on first use (deliberate global sign-out).
  aep?: number;
  mep?: number;
  // Stable session id = the refresh-token family id. Carried on ACCESS tokens
  // (refresh tokens keep `fam`). Lets logout resolve the family from an access
  // token and lets audit correlate a session across rotations.
  sid?: string;
  iat?: number;
  jti?: string;
```

In `createTokenPair` (`:357`), replace the `fam`-stripping block so the access token gets `sid` and never `fam`:

```ts
  // Access token carries `sid` (the family id) but never `fam`; refresh token
  // carries `fam`. `aep`/`mep` ride both. Strip `fam` from the access payload
  // defensively and promote the family id to `sid`.
  const { fam: _famIgnored, ...accessBase } = payload;
  void _famIgnored;
  const accessPayload: Omit<TokenPayload, 'type'> = options.refreshFam
    ? { ...accessBase, sid: options.refreshFam }
    : accessBase;
  const refreshPayload: Omit<TokenPayload, 'type'> = options.refreshFam
    ? { ...payload, fam: options.refreshFam }
    : payload;
```

In `verifyToken` (`:265`), add to the returned object (after the `fam:` line):

```ts
      fam: typeof payload.fam === 'string' && payload.fam.length > 0 ? payload.fam : undefined,
      aep: typeof payload.aep === 'number' ? payload.aep : undefined,
      mep: typeof payload.mep === 'number' ? payload.mep : undefined,
      sid: typeof payload.sid === 'string' && payload.sid.length > 0 ? payload.sid : undefined,
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/jwt.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/jwt.ts apps/api/src/services/jwt.test.ts
git commit -m "feat(auth): add aep/mep/sid claims to token pair"
```

---

### Task 3: Epoch-reader helper (mint side)

**Files:**
- Create: `apps/api/src/services/authEpochs.ts`
- Test: `apps/api/src/services/authEpochs.test.ts`

**Interfaces:**
- Consumes: `users` schema (Task 1).
- Produces: `getUserEpochs(userId, executor?): Promise<{ authEpoch: number; mfaEpoch: number } | null>` — reads the live row. `executor` defaults to the ambient `db`; pass a `tx` to read inside a transaction. Returns `null` if the user does not exist. This is the ONLY source of epoch values for mint paths — no caller passes epochs in by hand.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/authEpochs.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => {
  const rows = [{ authEpoch: 3, mfaEpoch: 7 }];
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return {
    db: { select: () => chain },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { getUserEpochs } from './authEpochs';

describe('getUserEpochs', () => {
  it('returns the live epoch pair', async () => {
    const result = await getUserEpochs('11111111-1111-1111-1111-111111111111');
    expect(result).toEqual({ authEpoch: 3, mfaEpoch: 7 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/authEpochs.test.ts
```
Expected: FAIL — cannot find module `./authEpochs`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/authEpochs.ts`:

```ts
import { eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { users } from '../db/schema';

type Executor = Pick<typeof dbModule.db, 'select'>;

/**
 * Read a user's live auth-state epochs. This is the single source of the
 * `aep`/`mep` claim values for EVERY token-mint path — mint code must never
 * accept caller-provided epochs (a stale/forged epoch would defeat the whole
 * scheme). Pass a `tx` executor to read inside the mutation transaction so the
 * minted token reflects the just-advanced epoch atomically; otherwise the
 * ambient system context is used (mint paths run pre-request-context).
 */
export async function getUserEpochs(
  userId: string,
  executor?: Executor,
): Promise<{ authEpoch: number; mfaEpoch: number } | null> {
  const run = async (db: Executor) => {
    const rows = await db
      .select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    return row ? { authEpoch: row.authEpoch, mfaEpoch: row.mfaEpoch } : null;
  };
  if (executor) return run(executor);
  return dbModule.withSystemDbAccessContext(() => run(dbModule.db));
}
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/authEpochs.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/authEpochs.ts apps/api/src/services/authEpochs.test.ts
git commit -m "feat(auth): add getUserEpochs mint-side reader"
```

---

### Task 4: Stamp `absolute_expires_at` on family mint

**Files:**
- Modify: `apps/api/src/services/refreshTokenFamily.ts:39`
- Test: `apps/api/src/services/refreshTokenFamily.test.ts` (create if absent)

**Interfaces:**
- Consumes: `refreshTokenFamilies.absoluteExpiresAt` (Task 1).
- Produces: `mintRefreshTokenFamily(userId)` unchanged signature, but the inserted row now has `absoluteExpiresAt = now + REFRESH_FAMILY_ABSOLUTE_TTL_DAYS` (default 30). Adds `getRefreshFamily(familyId): Promise<{ revokedAt: Date | null; absoluteExpiresAt: Date } | null>` for the /refresh gate (Task 6).
- **Decision (overseer, 2026-07-11): absolute refresh-family lifetime = 30 days, env-overridable via `REFRESH_FAMILY_ABSOLUTE_TTL_DAYS`.** The migration backfill uses a fixed `created_at + 30 days` (the env override applies to newly minted families only — acceptable for a one-time backfill).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/refreshTokenFamily.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const inserted: Record<string, unknown>[] = [];
vi.mock('../db', () => {
  const chain = { values: (v: Record<string, unknown>) => { inserted.push(v); return Promise.resolve(); } };
  return {
    db: { insert: () => chain },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('./tokenRevocation', () => ({ rememberJtiFamily: vi.fn() }));

import { mintRefreshTokenFamily } from './refreshTokenFamily';

describe('mintRefreshTokenFamily', () => {
  it('stamps an absolute expiry ~30d out', async () => {
    await mintRefreshTokenFamily('11111111-1111-1111-1111-111111111111');
    const row = inserted[0];
    expect(row.absoluteExpiresAt).toBeInstanceOf(Date);
    const ms = (row.absoluteExpiresAt as Date).getTime() - Date.now();
    expect(ms).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect(ms).toBeLessThan(31 * 24 * 3600 * 1000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/refreshTokenFamily.test.ts
```
Expected: FAIL — `row.absoluteExpiresAt` is `undefined`.

- [ ] **Step 3: Implement**

In `apps/api/src/services/refreshTokenFamily.ts`, add near the top after imports:

```ts
function absoluteTtlDays(): number {
  const raw = Number.parseInt(process.env.REFRESH_FAMILY_ABSOLUTE_TTL_DAYS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}
```

In `mintRefreshTokenFamily`, set the expiry on insert:

```ts
export async function mintRefreshTokenFamily(userId: string): Promise<string> {
  const familyId = randomUUID();
  const absoluteExpiresAt = new Date(Date.now() + absoluteTtlDays() * 24 * 60 * 60 * 1000);
  await dbModule.withSystemDbAccessContext(async () => {
    await dbModule.db.insert(refreshTokenFamilies).values({
      familyId,
      userId,
      absoluteExpiresAt,
    });
  });
  return familyId;
}
```

Add the lookup helper at the end of the file (put the `import { eq } from 'drizzle-orm';` with the other imports at the TOP of the file, not mid-file):

```ts
/**
 * Fetch a family's revocation + absolute-expiry state for the /refresh gate.
 * System-scoped: /refresh runs pre-request-context. Returns null when no row.
 */
export async function getRefreshFamily(
  familyId: string,
): Promise<{ revokedAt: Date | null; absoluteExpiresAt: Date } | null> {
  return dbModule.withSystemDbAccessContext(async () => {
    const rows = await dbModule.db
      .select({
        revokedAt: refreshTokenFamilies.revokedAt,
        absoluteExpiresAt: refreshTokenFamilies.absoluteExpiresAt,
      })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId))
      .limit(1);
    return rows[0] ?? null;
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/refreshTokenFamily.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/refreshTokenFamily.ts apps/api/src/services/refreshTokenFamily.test.ts
git commit -m "feat(auth): stamp absolute expiry on refresh families + add lookup"
```

---

### Task 5: Durable auth-lifecycle service

**Files:**
- Create: `apps/api/src/services/authLifecycle.ts`
- Test: `apps/api/src/services/authLifecycle.test.ts`

**Interfaces:**
- Consumes: `users` epoch columns (Task 1), `refreshTokenFamilies` (Task 1), `revokeAllUserOauthArtifacts` (`oauth/grantRevocation.ts:139`), `revokeAllUserTokens` (`services/tokenRevocation.ts:118`), `clearPermissionCache` (`services/permissions.ts:252`).
- Produces:
  - `type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];`
  - `advanceUserEpochs(tx, userId, fields: { auth?: boolean; mfa?: boolean; email?: boolean; passwordReset?: boolean }): Promise<{ authEpoch: number; mfaEpoch: number; emailEpoch: number; passwordResetEpoch: number }>` — `UPDATE … SET auth_epoch = auth_epoch + 1, …` for each requested field, `RETURNING` all four; the DB row is the source of the post-mutation values.
  - `revokeAllRefreshFamilies(tx, userId, reason): Promise<void>` — durable `revokedAt`/`revokedReason` stamp inside `tx`.
  - `revokeRefreshFamilyById(tx, familyId, reason): Promise<void>`.
  - `runPostCommitCleanup(userId): Promise<PostCommitCleanupResult>` — Redis cutoff (`revokeAllUserTokens`), permission-cache clear, and MCP OAuth grant sweep (`revokeAllUserOauthArtifacts`); each wrapped so one failure is logged without short-circuiting the others. **Never throws**; returns `{ redisOk: boolean; permissionCacheOk: boolean; oauthOk: boolean; oauthResult?: UserOauthRevocationResult }` so callers that must surface partial failure (the users.ts suspension path returns 503 today when the OAuth sweep fails) can preserve those semantics and audit details. The durable effect is already committed either way.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/authLifecycle.test.ts`. `authLifecycle.ts` imports `../db`, `./tokenRevocation`, `./permissions`, and `../oauth/grantRevocation` at module level — all four MUST be mocked or the import pulls real DB/Redis wiring into the unit test:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { transaction: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./tokenRevocation', () => ({ revokeAllUserTokens: vi.fn(async () => undefined) }));
vi.mock('./permissions', () => ({ clearPermissionCache: vi.fn(async () => undefined) }));
vi.mock('../oauth/grantRevocation', () => ({
  revokeAllUserOauthArtifacts: vi.fn(async () => ({ grantsRevoked: 1, refreshTokensRevoked: 2, jtisRevoked: 3 })),
}));

import { advanceUserEpochs, runPostCommitCleanup } from './authLifecycle';
import { revokeAllUserTokens } from './tokenRevocation';
import { clearPermissionCache } from './permissions';
import { revokeAllUserOauthArtifacts } from '../oauth/grantRevocation';

const setCalls: Record<string, unknown>[] = [];
function makeTx() {
  const updateChain = {
    set: (v: Record<string, unknown>) => { setCalls.push(v); return updateChain; },
    where: () => updateChain,
    returning: () => Promise.resolve([
      { authEpoch: 2, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 1 },
    ]),
  };
  return { update: () => updateChain };
}

describe('advanceUserEpochs', () => {
  it('increments only requested epochs and returns the new row', async () => {
    const tx = makeTx() as never;
    const result = await advanceUserEpochs(tx, 'u1', { auth: true });
    expect(result.authEpoch).toBe(2);
    // the SET payload used SQL increments for auth only
    expect(setCalls.length).toBe(1);
    const set = setCalls[0];
    expect(set.authEpoch).toBeDefined();
    expect(set.mfaEpoch).toBeUndefined();
    expect(set.emailEpoch).toBeUndefined();
    expect(set.passwordResetEpoch).toBeUndefined();
  });
});

describe('runPostCommitCleanup', () => {
  it('runs all three cleanups and reports success', async () => {
    const result = await runPostCommitCleanup('u1');
    expect(result).toMatchObject({ redisOk: true, permissionCacheOk: true, oauthOk: true });
    expect(result.oauthResult).toMatchObject({ grantsRevoked: 1 });
  });

  it('a Redis failure does not short-circuit the OAuth sweep and is reported, not thrown', async () => {
    vi.mocked(revokeAllUserTokens).mockRejectedValueOnce(new Error('redis down'));
    const result = await runPostCommitCleanup('u1');
    expect(result.redisOk).toBe(false);
    expect(result.oauthOk).toBe(true);
    expect(clearPermissionCache).toHaveBeenCalled();
    expect(revokeAllUserOauthArtifacts).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/authLifecycle.test.ts
```
Expected: FAIL — cannot find module `./authLifecycle`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/authLifecycle.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { users } from '../db/schema';
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';
import { revokeAllUserTokens } from './tokenRevocation';
import { clearPermissionCache } from './permissions';
import { revokeAllUserOauthArtifacts } from '../oauth/grantRevocation';

export type Tx = Parameters<Parameters<typeof dbModule.db.transaction>[0]>[0];

interface EpochRow {
  authEpoch: number;
  mfaEpoch: number;
  emailEpoch: number;
  passwordResetEpoch: number;
}

/**
 * Advance the requested epoch counters for a user INSIDE the caller's
 * transaction and return the post-mutation values. Because the increment and
 * the RETURNING happen in one statement, the value the caller mints into a new
 * token is exactly the committed one — no read-after-write race. Callers pass
 * the SAME `tx` that carries their business mutation so a rollback undoes the
 * epoch bump too (invariant 3: atomic or nothing).
 */
export async function advanceUserEpochs(
  tx: Tx,
  userId: string,
  fields: { auth?: boolean; mfa?: boolean; email?: boolean; passwordReset?: boolean },
): Promise<EpochRow> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (fields.auth) set.authEpoch = sql`${users.authEpoch} + 1`;
  if (fields.mfa) set.mfaEpoch = sql`${users.mfaEpoch} + 1`;
  if (fields.email) set.emailEpoch = sql`${users.emailEpoch} + 1`;
  if (fields.passwordReset) set.passwordResetEpoch = sql`${users.passwordResetEpoch} + 1`;

  const [row] = await tx
    .update(users)
    .set(set)
    .where(eq(users.id, userId))
    .returning({
      authEpoch: users.authEpoch,
      mfaEpoch: users.mfaEpoch,
      emailEpoch: users.emailEpoch,
      passwordResetEpoch: users.passwordResetEpoch,
    });
  if (!row) throw new Error(`advanceUserEpochs: user ${userId} not found`);
  return row;
}

function truncateReason(reason: string): string {
  return reason.length > 64 ? reason.slice(0, 64) : reason;
}

/** Durably revoke every active refresh family for a user inside `tx`. */
export async function revokeAllRefreshFamilies(tx: Tx, userId: string, reason: string): Promise<void> {
  const r = truncateReason(reason);
  await tx
    .update(refreshTokenFamilies)
    .set({
      revokedAt: sql`COALESCE(revoked_at, now())`,
      revokedReason: sql`COALESCE(revoked_reason, ${r})`,
    })
    .where(eq(refreshTokenFamilies.userId, userId));
}

/** Durably revoke one family (logout) inside `tx`. */
export async function revokeRefreshFamilyById(tx: Tx, familyId: string, reason: string): Promise<void> {
  const r = truncateReason(reason);
  await tx
    .update(refreshTokenFamilies)
    .set({
      revokedAt: sql`COALESCE(revoked_at, now())`,
      revokedReason: sql`COALESCE(revoked_reason, ${r})`,
    })
    .where(eq(refreshTokenFamilies.familyId, familyId));
}

export interface PostCommitCleanupResult {
  redisOk: boolean;
  permissionCacheOk: boolean;
  oauthOk: boolean;
  oauthResult?: Awaited<ReturnType<typeof revokeAllUserOauthArtifacts>>;
}

/**
 * Hot-path cleanup that runs AFTER the durable commit. Each step is best-effort
 * and independent: a failure is logged (observable/retryable) but never undoes
 * the committed revocation and never short-circuits the others. Redis cutoff +
 * permission-cache clear + MCP OAuth grant sweep (the EdDSA bearer path never
 * sees user-JWT epochs, so grants must be revoked out-of-band — invariant 1).
 * Never throws — returns a per-step outcome so callers that must surface a
 * partial failure (users.ts suspension returns 503 today when the OAuth sweep
 * fails) can keep doing so with the durable revocation already committed.
 */
export async function runPostCommitCleanup(userId: string): Promise<PostCommitCleanupResult> {
  const result: PostCommitCleanupResult = { redisOk: true, permissionCacheOk: true, oauthOk: true };
  try {
    await revokeAllUserTokens(userId);
  } catch (err) {
    result.redisOk = false;
    console.error('[auth-lifecycle] Redis token cutoff failed (durable revocation already committed):', err);
  }
  try {
    await clearPermissionCache(userId);
  } catch (err) {
    result.permissionCacheOk = false;
    console.error('[auth-lifecycle] permission-cache clear failed:', err);
  }
  try {
    result.oauthResult = await revokeAllUserOauthArtifacts(userId);
  } catch (err) {
    result.oauthOk = false;
    console.error('[auth-lifecycle] OAuth grant revocation failed:', err);
  }
  return result;
}
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/authLifecycle.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/authLifecycle.ts apps/api/src/services/authLifecycle.test.ts
git commit -m "feat(auth): add durable auth-lifecycle service (epochs + family revocation)"
```

---

### Task 6: Mint epochs at every token-mint site

**Files:**
- Modify: `apps/api/src/routes/auth/login.ts:491` (login), `:779` (refresh)
- Modify: `apps/api/src/routes/auth/mfa.ts:228`
- Modify: `apps/api/src/routes/auth/register.ts:248`
- Modify: `apps/api/src/routes/auth/invite.ts:202`
- Modify: `apps/api/src/routes/auth/passkeys.ts:363`
- Modify: `apps/api/src/routes/sso.ts:2000` (and the `tokenPayload` built at `:1791`)
- Modify: `apps/api/src/middleware/cfAccessLogin.ts:185`
- Modify: `apps/api/src/routes/auth/cfAccessRedirectLogin.ts:177`
- Test: `apps/api/src/routes/auth/login.test.ts` (add a mint-carries-epochs assertion)

**Interfaces:**
- Consumes: `getUserEpochs` (Task 3), `createTokenPair` (Task 2).
- Produces: every `createTokenPair(payload, …)` call passes `aep`/`mep` resolved from `getUserEpochs(userId)`. The refresh path (`login.ts:779`) resolves epochs from the freshly-loaded user row rather than trusting the inbound refresh claims.

For EACH mint site, the change is the same shape. Immediately before the `createTokenPair({ … })` call, resolve epochs and spread them into the payload. Example for **login** (`login.ts`, before `:491`):

- [ ] **Step 1: Write the failing test**

`login.test.ts` mocks `createTokenPair` at the module boundary (`vi.mock('../../services', …)` at the top of the file returns a static token pair), so you CANNOT decode a real JWT here — assert on the **payload passed to the mocked `createTokenPair`** instead. There is no `loginSuccess()` helper; the file has a `postLogin` helper and the `#1375` describe block (`POST /login — last_login_at write runs under system DB context`) already drives a full successful login with a mocked user row — copy its `beforeEach` setup.

Two mock-factory updates are REQUIRED first (without them every existing test in the file breaks once `login.ts` imports the new helpers):
1. Add to the `vi.mock('../../services', …)` factory: `getUserEpochs: vi.fn(async () => ({ authEpoch: 1, mfaEpoch: 1 }))` and `getRefreshFamily: vi.fn(async () => ({ revokedAt: null, absoluteExpiresAt: new Date(Date.now() + 86_400_000) }))`.
2. Add `authEpoch: 'users.authEpoch', mfaEpoch: 'users.mfaEpoch'` to the `users` object in the `vi.mock('../../db/schema', …)` factory (the /refresh pre-auth select references those columns).

Then add a new describe:

```ts
describe('POST /login — mints aep/mep/sid from the live user row', () => {
  beforeEach(() => {
    // copy the #1375 describe's beforeEach (enforceIpAllowlist allow +
    // selectChain user row + E2E_MODE), plus:
    vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 4, mfaEpoch: 2 });
  });

  it('passes the live epochs and the family id to createTokenPair', async () => {
    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });
    expect(res.status).toBe(200);
    expect(getUserEpochs).toHaveBeenCalledWith('user-1');
    expect(createTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({ aep: 4, mep: 2 }),
      { refreshFam: 'family-id' }
    );
  });

  it('fails closed with a generic 401 when the epoch read returns null', async () => {
    vi.mocked(getUserEpochs).mockResolvedValue(null);
    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });
    expect(res.status).toBe(401);
    expect(createTokenPair).not.toHaveBeenCalled();
  });
});
```

(Import `getUserEpochs` and `createTokenPair` from `'../../services'` in the test's existing import block — they are the mocked versions.)

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/login.test.ts -t 'aep'
```
Expected: FAIL — `createTokenPair` was called without `aep`/`mep` in the payload.

- [ ] **Step 3: Implement at every mint site**

**Do Step 3b (the `services/index.ts` re-exports) FIRST.** In `login.ts`, import `getUserEpochs` and `getRefreshFamily` from the existing `'../../services'` import block — NOT directly from `services/authEpochs`/`services/refreshTokenFamily` — because `login.test.ts` mocks the `'../../services'` module boundary and a direct import would bypass the mock. Before `:491`:

```ts
  const epochs = await getUserEpochs(user.id);
  if (!epochs) {
    await floorPromise;
    return c.json(genericAuthError(), 401);
  }
  const tokens = await createTokenPair({
    sub: user.id,
    email: user.email,
    roleId,
    orgId,
    partnerId,
    scope,
    mfa: mfaSatisfied,
    aep: epochs.authEpoch,
    mep: epochs.mfaEpoch,
    mdid: readMobileDeviceId(c) ?? undefined
  }, { refreshFam: familyId });
```

**login.ts /refresh** — the epochs come from the freshly-loaded `user` row. Extend the pre-auth user select at `:713` to include the epoch columns:

```ts
      .select({
        id: users.id,
        email: users.email,
        status: users.status,
        passwordChangedAt: users.passwordChangedAt,
        authEpoch: users.authEpoch,
        mfaEpoch: users.mfaEpoch,
      })
```

Then add the epoch gate immediately AFTER the `isTokenIssuedBeforePasswordChange` check (`:731-734`) — i.e. before `resolveCurrentUserTokenContext` and, critically, before the jti rotation-claim dance at `:757-775`, so a denied refresh never burns the rotation state:

```ts
  // Epoch gate: a refresh token minted before an auth/mfa state change must not
  // rotate into a fresh access token (deliberate global sign-out). Legacy tokens
  // lack aep/mep entirely → undefined !== number → rejected.
  if (payload.aep !== user.authEpoch || payload.mep !== user.mfaEpoch) {
    recordFailedLogin('refresh_epoch_mismatch');
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }
```

and add `aep: user.authEpoch, mep: user.mfaEpoch,` to the `createTokenPair({ … })` payload at `:779`.

Also add the absolute-expiry gate (depends on Task 4's `getRefreshFamily`). After the `isFamilyRevoked(familyId)` check (`:702`) — belt-and-braces: also reject on a durably-revoked row, since this reads the authoritative Postgres row anyway while `isFamilyRevoked` may be answered from its Redis sentinel:

```ts
  const familyRow = await getRefreshFamily(familyId);
  if (!familyRow || familyRow.revokedAt !== null || familyRow.absoluteExpiresAt.getTime() <= Date.now()) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }
```

Import `getRefreshFamily` from `'../../services'` (re-export it — see Step 3b; same mock-boundary reason as `getUserEpochs`).

**mfa.ts / register.ts / invite.ts / passkeys.ts / cfAccessLogin.ts / cfAccessRedirectLogin.ts** — each already computes a `userId` and mints a family. In each, immediately before its `createTokenPair` call, add:

```ts
  const epochs = await getUserEpochs(<userId>);
  if (!epochs) throw new Error('user epochs unavailable at token mint');
```

and add `aep: epochs.authEpoch, mep: epochs.mfaEpoch,` to the payload object. Use the file's existing `userId` variable (`user.id` / `newUser.id`). For the two CF Access files return the file's existing failure response instead of throwing if that matches local style (both currently `next()` on failure — prefer `throw` here since a mint with no epoch would be a server bug, not an auth failure).

**sso.ts** — `tokenPayload` is declared at `:1791` (`let tokenPayload: Parameters<typeof createTokenPair>[0];`) and assigned inside the partner/org membership branches. Do NOT edit both branches; after the branch completes and before the mint at `:1999`, add:

```ts
    const epochs = await getUserEpochs(user.id);
    if (!epochs) {
      clearStateCookie();
      return ssoError(c, 'sso_failed'); // ← use the file's actual generic-failure helper/redirect at that point; read the surrounding code
    }
    tokenPayload = { ...tokenPayload, aep: epochs.authEpoch, mep: epochs.mfaEpoch };
```

- [ ] **Step 3b: Re-export `getUserEpochs` and `getRefreshFamily`**

In `apps/api/src/services/index.ts`, add:

```ts
export { getUserEpochs } from './authEpochs';
export { getRefreshFamily } from './refreshTokenFamily';
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/login.test.ts src/routes/auth/register.test.ts src/routes/auth/cfAccessRedirectLogin.test.ts src/routes/auth.passkeys.test.ts src/middleware/cfAccessLogin.test.ts
```
Expected: PASS (fix any mocked user rows / mocked-services factories that now need `authEpoch`/`mfaEpoch`/`getUserEpochs`). Note the real file set: there is **no** `routes/auth/mfa.test.ts`, `routes/auth/invite.test.ts`, or `routes/auth/passkeys.test.ts` — the passkey route suite lives at `src/routes/auth.passkeys.test.ts`, and the mfa/invite route files have no sibling suites (their mint-path change is still covered by the Task 13 integration tests and the typecheck gate).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/*.ts apps/api/src/routes/sso.ts apps/api/src/middleware/cfAccessLogin.ts apps/api/src/services/index.ts
git commit -m "feat(auth): mint aep/mep at every token-mint site; epoch gate on /refresh"
```

---

### Task 7: Update test token builders to mint epoch-valid tokens

**Files:**
- Modify: `apps/api/src/__tests__/helpers.ts:63-75`
- Modify: `apps/api/src/__tests__/integration/db-utils.ts:376-385`

**Interfaces:**
- Consumes: `TokenPayload` (Task 2).
- Produces: `createTestToken` and the integration seed default `aep: 1, mep: 1` **and a non-empty default `sid`** — Task 8's middleware rejects any access token missing `sid`, so a sid-less builder default would fail every route/integration test that goes through the real `authMiddleware`. (For db-utils) the seeded fixture user rows keep the DB default `auth_epoch = 1`, so the minted token matches the live row. `TestTokenOptions` gains optional `aep?: number; mep?: number; sid?: string` so mismatch tests can forge a stale epoch or a missing claim (`sid: ''` is stripped by `verifyToken`'s length check, yielding a claimless token).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/__tests__/helpers.test.ts` (create if absent):

```ts
import { describe, it, expect } from 'vitest';
import { createTestToken } from './helpers';
import { verifyToken } from '../services/jwt';

describe('createTestToken', () => {
  it('mints aep/mep so authMiddleware epoch checks pass by default', async () => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
    const decoded = await verifyToken(await createTestToken());
    expect(decoded?.aep).toBe(1);
    expect(decoded?.mep).toBe(1);
    expect(decoded?.sid).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/__tests__/helpers.test.ts
```
Expected: FAIL — `decoded?.aep` is `undefined`.

- [ ] **Step 3: Implement**

In `helpers.ts`, extend `TestTokenOptions` and the payload:

```ts
export interface TestTokenOptions {
  userId?: string;
  email?: string;
  roleId?: string | null;
  orgId?: string | null;
  partnerId?: string | null;
  scope?: 'system' | 'partner' | 'organization';
  mfa?: boolean;
  aep?: number;
  mep?: number;
  sid?: string;
}

export async function createTestToken(options: TestTokenOptions = {}): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: options.userId ?? 'test-user-id',
    email: options.email ?? 'test@example.com',
    roleId: options.roleId ?? 'test-role-id',
    orgId: options.orgId ?? 'test-org-id',
    partnerId: options.partnerId ?? 'test-partner-id',
    scope: options.scope ?? 'organization',
    mfa: options.mfa ?? false,
    aep: options.aep ?? 1,
    mep: options.mep ?? 1,
    // Default sid: Task 8 rejects sid-less access tokens. `sid: ''` lets a
    // test forge the missing-claim case (verifyToken strips empty strings).
    sid: options.sid ?? 'test-session-id',
  };
  return createAccessToken(payload);
}
```

In `db-utils.ts` (`:376`), add `aep: 1, mep: 1, sid: randomUUID(),` to the `tokenPayload` object (import `randomUUID` from `'crypto'`; the seeded users have `auth_epoch = 1` from the column default, so this matches the live row).

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/__tests__/helpers.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/helpers.ts apps/api/src/__tests__/integration/db-utils.ts apps/api/src/__tests__/helpers.test.ts
git commit -m "test(auth): test token builders mint epoch-valid tokens"
```

---

### Task 8: Epoch + live-platform-admin enforcement in authMiddleware

**Files:**
- Modify: `apps/api/src/middleware/auth.ts:390-416` (user select + epoch/system checks) and `:467-472` (partner-membership binding after `computeAccessibleOrgIds`)
- Test: create `apps/api/src/middleware/auth.epoch.test.ts` (the existing `auth.test.ts` provides the mock shape)

**Interfaces:**
- Consumes: token `aep`/`mep`/`sid` (Task 2), `users` epoch columns (Task 1).
- Produces: `authMiddleware` rejects (401) any access token missing `aep`/`mep`/`sid`, or whose `aep`/`mep` differ from the live row; rejects (403) `scope='system'` when the live row's `isPlatformAdmin` is not `true`; and **rejects (401) `scope='partner'` when no live `partner_users` row exists for the token's `partnerId`** (overseer decision, 2026-07-11 — spec invariant 4). Uses the SAME queries already present: the user select gains `authEpoch`/`mfaEpoch` columns (`isPlatformAdmin` is already selected), and the partner-membership fact rides `computeAccessibleOrgIds`'s existing `partner_users` query via its returned `partnerOrgAccess` field (`null` for a partner-scope token ⇔ no membership row) — **zero additional per-request queries**.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/middleware/auth.epoch.test.ts`. Copy the mock block from the top of the existing `apps/api/src/middleware/auth.test.ts` VERBATIM (it mocks `../services/jwt`, `../services/permissions`, `../services/tokenRevocation`, `../services/tenantStatus`, `../services/auditEvents`, `./ipAllowlistGuard`, `../db`, `../db/schema` — read it first; add `authEpoch`/`mfaEpoch` keys to its mocked `users` schema object), and reuse its `basePayload`/`activeUser`/select-chain conventions. Skeleton with the required cases:

```ts
// …auth.test.ts mock block here (users schema mock gains authEpoch/mfaEpoch)…
import { Hono } from 'hono';
import { authMiddleware, requirePermission } from './auth';
import { verifyToken } from '../services/jwt';
import { getUserPermissions } from '../services/permissions';
import { db } from '../db';

const epochPayload = {
  sub: 'user-123', email: 'test@example.com', roleId: 'role-123',
  orgId: 'org-123', partnerId: 'partner-123', scope: 'organization' as const,
  type: 'access' as const, mfa: true, iat: 1_700_000_000,
  aep: 1, mep: 1, sid: 'fam-123',
};
const liveUser = {
  id: 'user-123', email: 'test@example.com', name: 'T', status: 'active',
  passwordChangedAt: null, mfaEnabled: true, isPlatformAdmin: false,
  authEpoch: 1, mfaEpoch: 1,
};
// selectChain(rows): thenable/limit-terminated chain — reuse auth.test.ts's helper shape.

function appWith(middlewarePayload: unknown, userRow: unknown, extraSelects: unknown[][] = []) {
  vi.mocked(verifyToken).mockResolvedValue(middlewarePayload as never);
  const selects = [ [userRow], ...extraSelects ];
  vi.mocked(db.select).mockImplementation((() => selectChain(selects.shift() ?? [])) as never);
  const app = new Hono();
  app.get('/t', authMiddleware, (c) => c.json({ ok: true }));
  return app;
}

describe('authMiddleware epoch + live-binding gate', () => {
  it('401s a token whose aep is behind the live row', async () => {
    const app = appWith({ ...epochPayload, aep: 1 }, { ...liveUser, authEpoch: 2 });
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(401);
  });

  it('401s a token missing sid (legacy token, deliberate global sign-out)', async () => {
    const app = appWith({ ...epochPayload, sid: undefined }, liveUser);
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(401);
  });

  it("403s scope='system' when the live row is no longer a platform admin", async () => {
    const app = appWith(
      { ...epochPayload, scope: 'system', orgId: null, partnerId: null },
      { ...liveUser, isPlatformAdmin: false }
    );
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(403);
  });

  it("401s scope='partner' when the live partner_users membership row is gone", async () => {
    // 2nd select = computeAccessibleOrgIds' partner_users lookup → no row.
    const app = appWith(
      { ...epochPayload, scope: 'partner', orgId: null },
      liveUser,
      [ [] ] // partnerUsers select returns no membership
    );
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(401);
  });

  it('passes through with matching epochs, sid, and live membership', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ permissions: [], allowedSiteIds: undefined } as never);
    const app = appWith(epochPayload, liveUser);
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(200);
  });
});

describe('org-scope live membership (overseer decision: explicit fail-closed proof)', () => {
  it('requirePermission 403s when the org membership is gone (getUserPermissions → null)', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(null);
    vi.mocked(verifyToken).mockResolvedValue(epochPayload as never);
    vi.mocked(db.select).mockImplementation((() => selectChain([liveUser])) as never);
    const app = new Hono();
    app.get('/t', authMiddleware, requirePermission('devices', 'read'), (c) => c.json({ ok: true }));
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(403); // 'No permissions found' — fail closed on null
  });
});
```

(Exact select-chain plumbing must follow `auth.test.ts` — the count and order of `db.select` calls in `authMiddleware` matters; adjust the `extraSelects` wiring to the real call order once you've read the file. The org-scope case is REQUIRED by the overseer decision: it makes the existing fail-closed-on-null behavior an explicit contract, not an accident.)

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/middleware/auth.epoch.test.ts
```
Expected: FAIL — no epoch/platform-admin gate yet (all four cases fall through).

- [ ] **Step 3: Implement**

In `auth.ts`, add the epoch columns to the pre-auth user select (`:392`):

```ts
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        passwordChangedAt: users.passwordChangedAt,
        mfaEnabled: users.mfaEnabled,
        isPlatformAdmin: users.isPlatformAdmin,
        authEpoch: users.authEpoch,
        mfaEpoch: users.mfaEpoch,
      })
```

After the `user.status !== 'active'` check (`:412`) and before the `isTokenIssuedBeforePasswordChange` check, add:

```ts
  // Epoch gate (core-auth hardening PR 1). Scoped to the user-JWT path — this
  // middleware only ever runs on aud='breeze-api' access tokens (agent/helper/
  // portal/viewer/MCP-bearer paths use separate verifiers and never reach here).
  // A token missing any epoch/session claim predates the rollout: reject it
  // (deliberate global sign-out). A stale aep/mep means a security-state change
  // happened after the token was minted: reject.
  if (
    typeof payload.aep !== 'number' ||
    typeof payload.mep !== 'number' ||
    !payload.sid
  ) {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }
  if (payload.aep !== user.authEpoch || payload.mep !== user.mfaEpoch) {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  // Live system binding: scope='system' is only legitimate for a current
  // platform admin. A demoted admin's signed scope claim must not survive an
  // out-of-band is_platform_admin=false (SR2-02).
  if (payload.scope === 'system' && user.isPlatformAdmin !== true) {
    throw new HTTPException(403, { message: 'Insufficient permissions' });
  }
```

Then, immediately AFTER the existing `computeAccessibleOrgIds` call (`:467-472`), add the REQUIRED live partner-membership binding (overseer decision, 2026-07-11):

```ts
  // REQUIRED live partner-membership binding (spec invariant 4). An empty org
  // allowlist is NOT sufficient denial for a partner token: partner-axis RLS
  // policies key on the token's partnerId claim (breeze_has_partner_access),
  // so a partner user whose partner_users row was removed OUT-OF-BAND (no
  // auth_epoch advance) could still read partner-axis tables with orgIds=[].
  // computeAccessibleOrgIds already queried partner_users — partnerOrgAccess
  // is null for a partner-scope token ⇔ no live membership row (an existing
  // row with org_access='none' yields 'none', not null). Zero extra queries.
  if (payload.scope === 'partner' && partnerOrgAccess === null) {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }
```

For `scope='organization'`, no new middleware check is added: `getUserPermissions` resolves the live `organization_users` membership and returns `null` when it is gone, and `requirePermission` fails closed on `null` (403 `'No permissions found'`, `middleware/auth.ts:606-627`) — the org-scope test case above makes that fail-closed behavior an explicit, pinned contract. Application-driven membership removal additionally advances `auth_epoch` (Task 9), which the epoch gate catches on the very next request.

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/middleware/auth.epoch.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/middleware/auth.epoch.test.ts
git commit -m "feat(auth): enforce epoch + live platform-admin binding in authMiddleware"
```

---

### Task 9: Wire security mutations through the lifecycle service

**Files:**
- Modify: `apps/api/src/routes/users.ts:1397` (status PATCH), `:1541` (membership removal `removeMembershipForScope` + its two callers at `:1578`/`:1607` and their post-hoc revokes at `:1595-1624`)
- Modify: `apps/api/src/routes/admin/abuse.ts` — suspend handler `:92` (its `db.transaction` at `:109`, `disablePartnerUsersForSuspension(tx, partnerId)` at `:186` returning the affected user ids, post-commit `revokeAllUserTokens` fan-out at `:230`); unsuspend handler `:373` (tx `:383`, `reEnableSuspensionDisabledUsers` `:411`)
- Modify: `apps/api/src/routes/accessReviews.ts:462-484` (the apply-decisions `db.transaction` deleting memberships for MULTIPLE users)
- Test: extend the respective `*.test.ts` files

**RLS caveat that shapes every wiring below:** `refresh_token_families` is user-id-scoped RLS (self OR system — see the schema file's header comment). An ADMIN's request-scope DB context cannot see another user's family rows, so `revokeAllRefreshFamilies` under the ambient request context would silently update 0 rows — a no-op revocation with no error (the classic RLS silent-zero-row-write trap). Every transaction that revokes ANOTHER user's families MUST run under a system-scope context: `runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => { … })))` (the `runOutsideDbContext` is required because these handlers run inside the request's ambient context — see Global Constraints). Authorization is already resolved by the route before this point; the ids passed into the transaction were validated under the caller's scope.

**Interfaces:**
- Consumes: `advanceUserEpochs`, `revokeAllRefreshFamilies`, `runPostCommitCleanup`, `Tx` (Task 5).
- Produces: each of these mutations now runs its `users`/membership write AND `advanceUserEpochs(tx, userId, { auth: true })` + `revokeAllRefreshFamilies(tx, userId, reason)` in ONE `db.transaction`, then calls `runPostCommitCleanup(userId)` after commit. A DB failure rolls back both the mutation and the epoch bump.

The key change pattern (status PATCH in `users.ts`) — replace the standalone `db.update(users)…` with a transaction:

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/users.test.ts` a test asserting that after a status→disabled PATCH, the mocked transaction received an `advanceUserEpochs`-shaped `users` update (auth_epoch increment) AND a `refresh_token_families` revoke. Follow the file's existing Drizzle-mock chain conventions (read the top of the file first). Assert `runPostCommitCleanup` (mock the module) was called once with the user id.

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/users.test.ts -t 'epoch'
```
Expected: FAIL — no epoch advance / family revoke on the current code path.

- [ ] **Step 3: Implement**

In `users.ts` status PATCH, wrap the mutation (import `advanceUserEpochs`, `revokeAllRefreshFamilies`, `runPostCommitCleanup` from `'../services/authLifecycle'`; import `runOutsideDbContext` from `'../db'` — the handler runs inside the request DB context, which cannot see another user's `refresh_token_families` rows, per the RLS caveat above):

```ts
  const [updated] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .update(users)
          .set(updates)
          .where(eq(users.id, userId))
          .returning({ id: users.id, email: users.email, name: users.name, status: users.status });
        if (row) {
          // Any admin status change invalidates prior sessions: advance auth_epoch
          // and durably revoke refresh families in the SAME transaction.
          await advanceUserEpochs(tx, userId, { auth: true });
          await revokeAllRefreshFamilies(tx, userId, `status:${row.status ?? 'changed'}`);
        }
        return [row];
      })
    )
  );
  if (!updated) {
    return c.json({ error: 'Failed to update user' }, 500);
  }
  const cleanup = await runPostCommitCleanup(userId);
```

(Note `row.status`, not `updated.status` — `updated` is not yet assigned inside the transaction callback; referencing it there is a TDZ ReferenceError at runtime.)

Then in the existing `becameInactive` block (`:1417-1451`):
- **KEEP** `terminateUserRemoteSessions` + its `TEARDOWN_FAILED` 503 exactly as-is (viewer/WebRTC teardown is NOT covered by the lifecycle service).
- **DROP** the standalone `revokeUserAccess(updated.id)` call (it is a thin alias for `revokeAllUserOauthArtifacts` — see `services/userSuspension.ts:19-20` — now covered by `runPostCommitCleanup`), and **preserve its hard-failure semantics** using the cleanup outcome: `if (becameInactive && !cleanup.oauthOk) return c.json({ error: 'Failed to revoke active sessions; suspension is partial. Retry.' }, 503);` and feed `cleanup.oauthResult` into the existing audit `details` in place of `oauthRevocation`.
- **DROP** the standalone `clearPermissionCache(updated.id)` at `:1452` (covered by `runPostCommitCleanup`).

Apply the epoch-advance + family-revoke + post-commit pattern to the remaining sites:
- **`admin/abuse.ts` partner suspend (`:92`)** — this is a MULTI-user mutation: `disablePartnerUsersForSuspension(tx, partnerId)` (`:186`) already runs inside the handler's `db.transaction` (`:109`, platform-admin/system context) and returns the affected user ids. Inside that SAME `tx`, loop the returned ids: `for (const { id } of disableResult) { await advanceUserEpochs(tx, id, { auth: true }); await revokeAllRefreshFamilies(tx, id, 'suspended'); }`. After commit, replace the `revokeAllUserTokens` fan-out at `:230` with `await Promise.all(result.affectedUserIds.map((id) => runPostCommitCleanup(id)))`. Unsuspend (`:373`) does NOT advance epochs (reactivation must not revive old tokens, but there are none to revive; leave sessions dead).
- **`accessReviews.ts` apply-decisions (`:462-484`)** — also multi-user: inside the existing transaction that deletes the memberships, loop `revokedUserIds` with `advanceUserEpochs(tx, id, { auth: true })` + `revokeAllRefreshFamilies(tx, id, 'membership-removed')`; after commit, `runPostCommitCleanup` per id. Check what context that transaction runs under — if it is the caller's request context (partner/org admin), the family revokes will silently 0-row (RLS caveat above): move the whole apply transaction under `runOutsideDbContext(() => withSystemDbAccessContext(...))`, exactly like the status-PATCH snippet. `advanceUserEpochs` throwing `user not found` on an RLS-filtered update is the fail-closed tell that the context is wrong — the Task 13 integration test must exercise this path against real Postgres.
- **`users.ts` `removeMembershipForScope` (`:1541`) callers (`:1578`, `:1607`)** — the orphan-neutralization already runs under `withSystemDbAccessContext` (`:1546`); wrap the membership delete + `advanceUserEpochs` + `revokeAllRefreshFamilies` in one `db.transaction` inside that system context (reason `'membership-removed'`), then replace the post-hoc `revokeAllUserTokens`/`revokeUserAccess` calls at `:1595-1624` with `runPostCommitCleanup(userId)`.

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/users.test.ts src/routes/admin/abuse.test.ts src/routes/accessReviews.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/users.ts apps/api/src/routes/admin/abuse.ts apps/api/src/routes/accessReviews.ts apps/api/src/routes/users.test.ts
git commit -m "feat(auth): advance epochs + revoke families atomically on status/membership changes"
```

---

### Task 10: Truthful logout

**Files:**
- Modify: `apps/api/src/routes/auth/login.ts:567-592` (`/logout`)
- Test: `apps/api/src/routes/auth/login.test.ts`

**Interfaces:**
- Consumes: `revokeRefreshFamilyById` (Task 5); `auth.token.sid` (Task 2); `resolveRefreshToken` (`routes/auth/helpers.ts:288`); the existing `revokeAllUserTokens`/`revokeCurrentRefreshTokenJti` Redis cleanup already called by today's logout.
- Produces: `/logout` resolves the current family id from the access token's `sid` (or the refresh cookie's `fam`), durably revokes it in a transaction, then runs the SAME Redis cleanup logout does today. On durable-revocation failure it returns **500** with a failure audit event; the cookie is ALWAYS cleared regardless of outcome. **Deliberately NOT `runPostCommitCleanup`:** its MCP OAuth grant sweep would revoke every connected OAuth/MCP client on an ordinary single-session web logout — an overreach today's logout doesn't do and the spec doesn't ask for (spec: logout "durably revokes it, then performs Redis cleanup").

- [ ] **Step 1: Write the failing test**

Add two cases to `login.test.ts`: (a) successful logout durably revokes the `sid` family and returns 200; (b) when the durable revoke throws, logout returns 500, writes a `result: 'failure'` (or `'denied'`) audit, and still clears the cookie. Mock `authLifecycle`.

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/login.test.ts -t 'logout'
```
Expected: FAIL — current logout always returns 200 and never touches the family durably.

- [ ] **Step 3: Implement**

Replace the `/logout` handler body:

```ts
loginRoutes.post('/logout', authMiddleware, async (c) => {
  const auth = c.get('auth');
  // Resolve the family: access-token `sid` is authoritative; fall back to the
  // refresh cookie's verified `fam` when present.
  let familyId: string | null = auth.token.sid ?? null;
  if (!familyId) {
    const refreshToken = resolveRefreshToken(c);
    if (refreshToken) {
      const rp = await verifyToken(refreshToken);
      familyId = rp?.type === 'refresh' ? (rp.fam ?? null) : null;
    }
  }

  let durableOk = true;
  if (familyId) {
    try {
      // Self-revocation: the request context's userId IS this user, so the
      // user-id-scoped refresh_token_families RLS policy admits the write —
      // the ambient db.transaction is fine here (unlike Task 9's admin paths).
      await db.transaction(async (tx) => {
        await revokeRefreshFamilyById(tx, familyId!, 'logout');
      });
    } catch (error) {
      durableOk = false;
      console.error('[auth] Durable logout revocation failed:', error);
    }
  }

  // Post-commit best-effort Redis cleanup — same scope as today's logout
  // (user-wide access-token cutoff + current refresh jti). Deliberately NOT
  // runPostCommitCleanup: logout must not sweep the user's MCP OAuth grants.
  try {
    await revokeAllUserTokens(auth.user.id);
    await revokeCurrentRefreshTokenJti(c, auth.user.id);
  } catch (error) {
    console.error('[auth] Logout Redis cleanup failed (durable revocation state above):', error);
  }

  createAuditLogAsync({
    orgId: auth.orgId ?? undefined,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: 'user.logout',
    resourceType: 'user',
    resourceId: auth.user.id,
    resourceName: auth.user.name,
    ipAddress: getClientIP(c),
    userAgent: c.req.header('user-agent'),
    result: durableOk ? 'success' : 'failure',
    details: durableOk ? undefined : { reason: 'durable_revocation_failed', familyId },
  });

  // Always clear the local cookie — even on durable failure the client should
  // drop its credential; the durable revoke is retried by ops via the audit.
  clearRefreshTokenCookie(c);

  if (!durableOk) {
    return c.json({ error: 'Logout could not be fully completed. Please try again.' }, 500);
  }
  return c.json({ success: true });
});
```

Import `revokeRefreshFamilyById` from `'../../services/authLifecycle'`; `db`, `verifyToken`, `revokeAllUserTokens`, and `revokeCurrentRefreshTokenJti` are already imported/available in this file (verify at the import block).

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/login.test.ts -t 'logout'
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/login.test.ts
git commit -m "feat(auth): logout durably revokes the session family and reports failure truthfully"
```

---

### Task 11: SR2-08 — password-reset generation binding

**Files:**
- Modify: `apps/api/src/routes/auth/password.ts` (forgot `:71`, reset `:160`, change `:265`)
- Test: `apps/api/src/routes/auth/password.test.ts`

**Interfaces:**
- Consumes: `advanceUserEpochs`, `runPostCommitCleanup`, `Tx` (Task 5); the existing `reset:<hash>` Redis convention.
- Produces: the reset token's Redis value becomes a JSON envelope `{ userId, passwordResetEpoch, email }` instead of a bare userId. Issuance advances `password_reset_epoch` (in a transaction) and embeds the new value + normalized current email. Redemption re-reads the live `password_reset_epoch` and the live email and rejects unless BOTH match (only the newest generation, bound to the address the token was issued for, can succeed). Successful reset advances `password_reset_epoch` AND `auth_epoch` and revokes all families via `revokeAllRefreshFamilies`. The account-locked reset link minted in `login.ts:151` uses the same envelope.

- [ ] **Step 1: Write the failing test**

Add to `password.test.ts`: (a) issuing a second reset token invalidates the first (older `passwordResetEpoch` → redemption 400); (b) a token whose embedded email no longer matches the live email → 400; (c) successful reset advances both epochs and revokes families. Follow the file's existing Redis + Drizzle mock setup.

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/password.test.ts -t 'generation'
```
Expected: FAIL — current tokens store a bare userId with no generation/email binding.

- [ ] **Step 3: Implement**

Define an envelope helper at the top of `password.ts`:

```ts
interface ResetTokenEnvelope {
  userId: string;
  passwordResetEpoch: number;
  email: string;
}
```

**Issuance** (`/forgot-password`, inside the `eligibility.allowed` branch at `:100`): advance the epoch in a transaction and store the envelope. `/forgot-password` is pre-auth — there is NO ambient DB context, so a bare `db.transaction` would hit `users` as `breeze_app` with no GUCs and the UPDATE would be RLS-filtered to 0 rows (`advanceUserEpochs` then throws `user not found`). Wrap in the system context. Replace the `redis.setex('reset:…', 3600, eligibility.userId)` (`:106`) with:

```ts
    const gen = await withSystemDbAccessContext(() =>
      db.transaction(async (tx) =>
        advanceUserEpochs(tx, eligibility.userId!, { passwordReset: true })
      )
    );
    const envelope: ResetTokenEnvelope = {
      userId: eligibility.userId,
      passwordResetEpoch: gen.passwordResetEpoch,
      email: normalizedEmail,
    };
    await redis.setex(`reset:${tokenHash}`, 3600, JSON.stringify(envelope));
```

Apply the same envelope shape to the account-locked reset link in `login.ts:151-155` (advance `password_reset_epoch`, store the envelope; same `withSystemDbAccessContext` wrap — this path is pre-auth too, inside `recordAccountFailureAndMaybeNotify`). Import `advanceUserEpochs` there. Note the envelope's `email` field here is the user's live email (the lockout path has `user.email`, not a request-supplied address).

**Redemption** (`/reset-password` at `:174`): `consumePasswordResetToken` now returns the raw envelope JSON string. Parse it, then validate generation + email against the live row:

```ts
  const raw = await consumePasswordResetToken(redis, tokenHash);
  if (!raw) return c.json({ error: 'Invalid or expired reset token' }, 400);
  let envelope: ResetTokenEnvelope;
  try { envelope = JSON.parse(raw); } catch { return c.json({ error: 'Invalid or expired reset token' }, 400); }
  const userId = envelope.userId;

  const [live] = await withSystemDbAccessContext(async () =>
    db.select({ passwordResetEpoch: users.passwordResetEpoch, email: users.email })
      .from(users).where(eq(users.id, userId)).limit(1)
  );
  if (!live ||
      live.passwordResetEpoch !== envelope.passwordResetEpoch ||
      live.email.toLowerCase() !== envelope.email.toLowerCase()) {
    // A newer reset was issued, the password already changed, or the address
    // moved — only the newest generation bound to the current address wins.
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }
```

Then, in the password-write path (`:225`), do the write + both epoch advances + family revoke in one transaction:

```ts
  await withSystemDbAccessContext(async () =>
    db.transaction(async (tx) => {
      await tx.update(users)
        .set({ passwordHash, passwordChangedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, userId));
      await advanceUserEpochs(tx, userId, { auth: true, passwordReset: true });
      await revokeAllRefreshFamilies(tx, userId, 'password-reset');
    })
  );
  await runPostCommitCleanup(userId);
```

Remove the now-redundant standalone `revokeAllUserTokens`/`revokeAllRefreshTokenFamiliesForUser`/`revokeAllUserOauthArtifacts` calls (`:242-250`) — `runPostCommitCleanup` covers Redis + OAuth, and `revokeAllRefreshFamilies` inside the tx covers families durably. **KEEP the `invalidateAllUserSessions` call (`:237`) exactly as-is** — overseer decision (2026-07-11): the `sessions` table is a deliberately separate legacy mechanism; the lifecycle service does NOT absorb it, and all existing `invalidateAllUserSessions` call sites keep working unchanged.

Apply the same in-transaction epoch advance (`{ auth: true, passwordReset: true }`) + `revokeAllRefreshFamilies` + `runPostCommitCleanup` to `/change-password` (write at `:307-314`, standalone revokes at `:316-332`), replacing its `revokeAllUserTokens`/`revokeAllRefreshTokenFamiliesForUser`/`revokeAllUserOauthArtifacts` calls but KEEPING `invalidateAllUserSessions` (`:316`, same decision) and `revokeCurrentRefreshTokenJti` (`:327`, cheap hot-path marker for the caller's own cookie). `/change-password` runs authenticated as the user themselves, so the user-id-scoped `refresh_token_families` RLS policy admits the write — the ambient `db.transaction` is fine there (no system-context wrap needed, unlike the two pre-auth paths above; the `users` self-update also passes the self policy, matching the existing `:307` update that works today).

`consumePasswordResetToken` needs no change (it already returns the stored string atomically via GETDEL) — only its callers reinterpret the value.

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/password.test.ts src/routes/auth/login.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/password.ts apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/password.test.ts
git commit -m "feat(auth): bind password-reset tokens to generation + current email (SR2-08)"
```

---

### Task 12: SR2-15 (cheap half) — reject API keys whose creator is not active

**Files:**
- Modify: `apps/api/src/middleware/apiKeyAuth.ts:143` (after the owner-tenant check)
- Test: `apps/api/src/middleware/apiKeyAuth.test.ts`

**Interfaces:**
- Consumes: `apiKey.createdBy` (already selected, `:112`); `users` status.
- Produces: after loading the key, the middleware loads `createdBy`'s live `status` and rejects (401) when it is not `active` OR when the lookup returns no row. Fail closed — a lookup error rejects.

- [ ] **Step 1: Write the failing test**

Add to `apiKeyAuth.test.ts`: a key whose `createdBy` user has `status: 'disabled'` → 401; a key whose creator lookup returns no row → 401; an active creator → passes. Follow the file's existing mock chain.

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/middleware/apiKeyAuth.test.ts -t 'creator'
```
Expected: FAIL — no creator check today; disabled-creator key authenticates.

- [ ] **Step 3: Implement**

Add `users` to the import (`apps/api/src/db/schema`) and after the `ownerTenant` check (`:146`):

```ts
  // SR2-15 (PR 1 subset): a delegated human API key must not outlive its
  // creator's active status. The full membership/permission-ceiling resolver
  // and service principals land in PR 5; here we fail closed on a
  // disabled/absent creator. (The MCP path's fail-OPEN null-perms bug is fixed
  // in PR 5 — do not build on that behavior.)
  const creator = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, apiKey.createdBy))
      .limit(1);
    return row ?? null;
  });
  if (!creator || creator.status !== 'active') {
    throw new HTTPException(401, { message: 'API key creator is not active' });
  }
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/middleware/apiKeyAuth.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/apiKeyAuth.ts apps/api/src/middleware/apiKeyAuth.test.ts
git commit -m "feat(auth): reject API keys whose creator is no longer active (SR2-15 subset)"
```

---

### Task 13: Real-DB integration tests — atomicity + concurrency

**Files:**
- Create: `apps/api/src/__tests__/integration/authLifecycle.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/refreshEpoch.integration.test.ts`

**Interfaces:**
- Consumes: everything above; the integration harness (`db-utils.ts`) and real Postgres on `:5433`.

- [ ] **Step 1: Write the failing tests**

`authLifecycle.integration.test.ts`:
- Seed a user + a refresh family. Call `advanceUserEpochs(tx, …, { auth: true })` + `revokeAllRefreshFamilies` in a transaction that then THROWS → assert the user's `auth_epoch` is unchanged and the family is NOT revoked (rollback atomicity).
- Same but committing → assert `auth_epoch` incremented and the family `revoked_at` set.
- **RLS-context proof (guards the Task 9 silent-zero-row trap):** run `revokeAllRefreshFamilies` for user B inside a *request-scope* context for admin user A (via `withDbAccessContext`) → assert the family row is NOT revoked (0-row write); then run it under `withSystemDbAccessContext` → assert it IS revoked. This pins the reason Task 9 wraps admin-driven revocations in the system context.
- Membership-removal fan-out: drive the `accessReviews` apply (or `removeMembershipForScope`) path against seeded memberships → assert the membership row is gone AND `auth_epoch` advanced AND families revoked, atomically.

`refreshEpoch.integration.test.ts`:
- Mint a login session (real family + tokens carrying `aep=1`). Advance `auth_epoch` to 2 via a committed lifecycle call. Assert a `/refresh` with the old refresh token returns 401 (`refresh_epoch_mismatch`) and does not mint a descendant.
- Concurrency: fire two `/refresh` calls on the same valid cookie; assert exactly one succeeds (existing reuse-detection) AND that after a `revokeAllRefreshFamilies`, neither can mint.

Follow `docs`/existing integration tests for the app-bootstrap + seeding pattern; use `createSeededTenant`-style helpers from `db-utils.ts`.

- [ ] **Step 2: Run to verify they fail**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/authLifecycle.integration.test.ts src/__tests__/integration/refreshEpoch.integration.test.ts
```
Expected: FAIL for the reviewed reason (before wiring is complete in a fresh checkout) — if all prior tasks are merged they should PASS; observe at least one meaningful assertion failing when a piece is intentionally reverted, per TDD discipline. Requires the integration Postgres on `:5433` (single-fork).

- [ ] **Step 3: (Implementation already exists from prior tasks.)**

No new production code — these tests exercise Tasks 5/6/8/9/10. If a test surfaces a real gap, fix it in the relevant task's file and note it.

- [ ] **Step 4: Run to verify they pass**

Run the same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/authLifecycle.integration.test.ts apps/api/src/__tests__/integration/refreshEpoch.integration.test.ts
git commit -m "test(auth): integration coverage for epoch atomicity + refresh epoch gate"
```

---

### Task 14: Full-suite verification gate

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + build**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm typecheck && pnpm build
```
Expected: no type errors; build succeeds. (Type Check includes tests — the new test files must typecheck too.)

- [ ] **Step 2: Focused serial unit/route suites**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/jwt.test.ts src/services/authEpochs.test.ts src/services/authLifecycle.test.ts src/services/refreshTokenFamily.test.ts src/routes/auth src/middleware
```
Expected: PASS. (API suite is flaky in parallel — run serially / single-fork if the config doesn't already.)

- [ ] **Step 3: Migration drift**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm db:check-drift
```
Expected: no drift.

- [ ] **Step 4: RLS + integration**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run --config vitest.config.rls.ts && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/authLifecycle.integration.test.ts src/__tests__/integration/refreshEpoch.integration.test.ts
```
Expected: PASS. RLS coverage unchanged (no new tables).

- [ ] **Step 5: Open the PR**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
git push -u origin core-auth-1-lifecycle-foundation
gh pr create --title "feat(auth): authentication lifecycle foundation (SR2-01..04, +SR2-08, +SR2-15 creator check)" --body "$(cat <<'EOF'
Implements PR 1 of the core-authentication hardening design (docs/superpowers/specs/security-auth/2026-07-11-core-authentication-hardening-design.md).

## What
- Durable `auth_epoch`/`mfa_epoch`/`email_epoch`/`password_reset_epoch` on `users`; `absolute_expires_at` on `refresh_token_families`.
- `aep`/`mep`/`sid` JWT claims minted from the live user row at every mint site (login, refresh, MFA, register, invite, passkey, SSO, CF Access ×2, test builders).
- `authMiddleware` rejects legacy/stale-epoch tokens, binds `scope='system'` to the live `is_platform_admin` flag, and binds `scope='partner'` to a live `partner_users` membership (zero extra queries — rides the existing org-reach lookup); `/refresh` applies the same epoch gate + absolute-family-expiry.
- `authLifecycle` service: transaction-atomic epoch advance + family revocation, with post-commit Redis + permission-cache + **MCP OAuth grant** cleanup. Wired into status change, suspend, membership removal, password reset/change.
- Truthful logout (durable-revoke → 500 on failure, cookie always cleared; Redis cleanup scope unchanged — logout does NOT sweep MCP OAuth grants).
- SR2-08: password-reset tokens bound to generation + current email.
- SR2-15 (subset): reject API keys whose creator is not active.

## Deliberate global sign-out
Every token minted before this rollout lacks `aep`/`mep`/`sid` and is rejected on first use — web AND mobile re-authenticate. Viewer tokens (≤2h) expire on their own. MCP OAuth grants are swept on `auth_epoch` advance.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR opens against `main`.

---

## Self-Review

**Spec coverage (PR 1 scope):**
- SR2-01 (reactivation replay) → Task 9 advances `auth_epoch` + revokes families on status change; Task 8 rejects stale epochs. ✓
- SR2-02 (demoted admin system scope) → Task 8 live `is_platform_admin`. ✓
- SR2-03 (membership removal stale RLS) → Task 9 (membership deletes advance epoch); Task 8 epoch reject + REQUIRED explicit partner-membership binding (out-of-band removal) + pinned org-scope fail-closed test. ✓
- SR2-04 (logout swallows failure) → Task 10. ✓
- Epoch schema/claims/mint → Tasks 1, 2, 3, 6, 7. ✓
- `/refresh` epoch gate + absolute family lifetime → Tasks 4, 6. ✓
- Durable revocation service + MCP OAuth sweep → Task 5. ✓
- SR2-08 pulled into PR 1 → Task 11. ✓
- SR2-15 disabled-creator subset → Task 12. ✓
- Integration atomicity/concurrency → Task 13. ✓

**Placeholder scan:** every code step contains concrete code; test steps that defer to "follow the file's existing mock shape" name the exact file to read first and the exact assertions required — acceptable because the Drizzle-mock chain must match the specific source chain (breeze-testing rule) and cannot be written blind. No TBD/TODO.

**Type consistency:** `advanceUserEpochs`/`revokeAllRefreshFamilies`/`revokeRefreshFamilyById`/`runPostCommitCleanup`/`Tx` names are used identically in Tasks 5, 9, 11 (`runPostCommitCleanup` returns `PostCommitCleanupResult`; Task 9's users.ts consumes `cleanup.oauthOk`/`cleanup.oauthResult`; Task 10 logout deliberately does not call it). `getUserEpochs` returns `{ authEpoch, mfaEpoch }` (Task 3) and is consumed as such in Task 6. `getRefreshFamily` returns `{ revokedAt, absoluteExpiresAt }` (Task 4) consumed in Task 6. `aep`/`mep`/`sid` claim names consistent across Tasks 2, 6, 7, 8. ✓

**Independent-review amendments (2026-07-11, second reviewer):** migration renamed `2026-07-11-*` → `2026-07-15-*` (must sort after shipped `2026-07-14-backup-feature-link-cascade.sql`); Task 1 apply-step fixed (`pnpm db:migrate` is a no-op — autoMigrate only exports); Task 5 unit test now mocks authLifecycle's four module-level deps and `runPostCommitCleanup` returns a per-step outcome (preserves users.ts 503 partial-suspension semantics); Task 6 login test rewritten to the file's real mocked-`createTokenPair` convention (no `loginSuccess` helper exists), services-mock factories extended, refresh epoch-gate moved before the jti rotation claim, absolute-expiry gate also checks `revokedAt`, Step 4 command fixed to the test files that actually exist; Task 7 defaults `sid` in both builders (middleware would otherwise reject every test token); Task 9 fixed a TDZ bug (`updated` referenced inside its own initializer's transaction), corrected abuse.ts/accessReviews.ts to their real multi-user shapes and line numbers, and moved admin-driven revocations under a system-context transaction (user-id-scoped `refresh_token_families` RLS would silently 0-row them under a request context — integration-pinned in Task 13); Task 10 logout keeps today's Redis cleanup scope instead of the OAuth-sweeping `runPostCommitCleanup`; Task 11 wraps the two pre-auth epoch advances in `withSystemDbAccessContext`.

## Resolved overseer decisions (2026-07-11) — applied in place above

1. **Absolute family TTL = 30 days**, env-overridable via `REFRESH_FAMILY_ABSOLUTE_TTL_DAYS`. Applied consistently in the migration backfill (fixed 30d), Task 4 mint default, and tests.
2. **REQUIRED explicit partner-membership binding in `authMiddleware`** (Task 8): `scope='partner'` tokens are rejected (generic 401) when `computeAccessibleOrgIds`'s returned `partnerOrgAccess` is `null` (⇔ no live `partner_users` row for the token's `partnerId`) — riding the existing query's returned data, zero extra per-request queries. Rationale: partner-axis RLS policies key on the token's partnerId claim, so an empty org allowlist is NOT sufficient denial for out-of-band membership removal (spec invariant 4). For `scope='org'`, the existing `getUserPermissions`-null → `requirePermission` 403 fail-closed path is pinned by an explicit test.
3. **`sessions` / `invalidateAllUserSessions` stays legacy.** The lifecycle service does NOT absorb it; every existing call site keeps working unchanged (Tasks 10/11 explicitly keep those calls).
