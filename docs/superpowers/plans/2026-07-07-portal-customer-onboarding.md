# Customer Portal Onboarding & Invite Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make logged-in customer onboarding work end-to-end — a customer can accept an invite and set a password, a tech can invite/manage portal users from the dashboard, and portal emails link to `/portal/*`.

**Architecture:** Reuse the portal's existing redis+in-memory token pattern for a new invite token (7-day TTL). Add a customer-facing `POST /portal/auth/accept-invite` and fix the forgot-password link base via a new `buildPortalUrl` helper. Add an MSP-facing `orgPortalUsers.ts` route module (registered on `orgRoutes`, mirroring `orgPortalSettings.ts` gating) and an `OrgPortalUsersEditor.tsx` in the Org Settings → Portal tab.

**Tech Stack:** Hono + Drizzle + Zod (API), Astro/React + `fetchWithAuth`/`runAction` (web), Vitest.

## Global Constraints

- Zod idioms: email = `z.string().email()`, UUID = `z.string().guid()` (NOT `.uuid()` — repo migrated Zod 3→4).
- New tenant table columns on `portal_users` need no new RLS policy — it already has org-scoped RLS (shape 1, direct `org_id`).
- Migrations: filename `YYYY-MM-DD-<slug>.sql`, idempotent (`IF NOT EXISTS`), **no** inner `BEGIN;/COMMIT;`, never edit a shipped migration.
- `portal_users` timestamp columns use `timestamp` WITHOUT timezone (match `last_login_at`) — do NOT use `timestamptz` (drift).
- Web mutations MUST go through `runAction` (`apps/web/src/lib/runAction.ts`); reads use `fetchWithAuth` directly. Web paths are relative and `/orgs`-prefixed (e.g. `/orgs/organizations/${orgId}/portal-users`).
- MSP route gating (mirror `orgPortalSettings.ts`): `requireScope('partner','system')`, reads `requirePermission(PERMISSIONS.ORGS_READ...)`, writes add `requireMfa()`, all mutations call `writeRouteAudit`.
- Portal auth rejects any `status !== 'active'` (login + middleware already enforce this) — so `invited`/`disabled` block login for free.
- Commit after each task. Do NOT commit `docs/testing/FEATURE_TEST_LOG.md` (unrelated pre-existing WIP).

---

## Task 1: Migration + schema columns (`invited_by`, `invited_at`)

**Files:**
- Create: `apps/api/migrations/2026-07-07-portal-user-invites.sql`
- Modify: `apps/api/src/db/schema/portal.ts:51-53` (add two columns to `portalUsers`)

**Interfaces:**
- Produces: `portalUsers.invitedBy` (uuid, nullable), `portalUsers.invitedAt` (timestamp, nullable).

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-07-07-portal-user-invites.sql`:

```sql
-- Portal customer-onboarding: invite provenance columns on portal_users.
-- Idempotent. portal_users already has org-scoped RLS (shape 1, direct org_id);
-- new nullable columns need no new policy. Timestamps are WITHOUT time zone to
-- match the existing last_login_at/created_at columns (drizzle drift).
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id);
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS invited_at timestamp;
```

- [ ] **Step 2: Add the columns to the Drizzle schema**

In `apps/api/src/db/schema/portal.ts`, inside `portalUsers`, immediately after the `status` column (line 51), add:

```ts
  invitedBy: uuid('invited_by').references(() => users.id),
  invitedAt: timestamp('invited_at'),
```

(`uuid`, `timestamp`, and `users` are already imported in this file.)

- [ ] **Step 3: Verify no schema drift**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift reported (schema matches migrations).

- [ ] **Step 4: Verify migration auto-ordering test still passes**

Run: `pnpm test --filter=@breeze/api -- autoMigrate`
Expected: PASS (new dated migration sorts correctly).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-07-07-portal-user-invites.sql apps/api/src/db/schema/portal.ts
git commit -m "feat(portal): add invited_by/invited_at to portal_users"
```

---

## Task 2: Invite-token infra + `buildPortalUrl` helper

**Files:**
- Modify: `apps/api/src/routes/portal/schemas.ts` (constants, redis key, `acceptInviteSchema`)
- Modify: `apps/api/src/routes/portal/helpers.ts` (in-memory map, sweep, `buildPortalUrl`, store/consume helpers)
- Test: `apps/api/src/routes/portal/helpers.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `INVITE_TTL_MS`, `INVITE_TTL_SECONDS`, `PORTAL_INVITE_TOKEN_CAP` (schemas.ts)
  - `PORTAL_REDIS_KEYS.inviteToken(hash: string): string`
  - `acceptInviteSchema` = `z.object({ token: string(min1), password: string(min8), name?: string(min1,max255) })`
  - `buildPortalUrl(path: string): string` (helpers.ts)
  - `storePortalInviteToken(portalUserId: string): Promise<string>` → raw token
  - `consumePortalInviteToken(rawToken: string): Promise<string | null>` → portalUserId or null

- [ ] **Step 1: Add constants + schema + redis key to `schemas.ts`**

In `apps/api/src/routes/portal/schemas.ts`, add after `RESET_TTL_SECONDS` (line 52):

```ts
export const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
export const INVITE_TTL_SECONDS = Math.floor(INVITE_TTL_MS / 1000);
export const PORTAL_INVITE_TOKEN_CAP = 20000;
```

Add `inviteToken` to `PORTAL_REDIS_KEYS` (after the `resetToken` line, line 60):

```ts
  inviteToken: (hash: string) => `portal:invite:${hash}`,
```

Add `acceptInviteSchema` after `resetPasswordSchema` (line 105):

```ts
export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
  name: z.string().min(1).max(255).optional()
});
```

- [ ] **Step 2: Write the failing test for `buildPortalUrl`**

Create `apps/api/src/routes/portal/helpers.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { buildPortalUrl } from './helpers';

const ENV_KEYS = ['PUBLIC_PORTAL_URL', 'DASHBOARD_URL', 'PUBLIC_APP_URL'] as const;
const saved: Record<string, string | undefined> = {};
function setEnv(vals: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(vals)) process.env[k] = v;
}
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('buildPortalUrl', () => {
  it('uses PUBLIC_PORTAL_URL when set', () => {
    setEnv({ PUBLIC_PORTAL_URL: 'https://us.2breeze.app/portal' });
    expect(buildPortalUrl('/accept-invite?token=abc')).toBe('https://us.2breeze.app/portal/accept-invite?token=abc');
  });
  it('falls back to DASHBOARD_URL + /portal', () => {
    setEnv({ DASHBOARD_URL: 'https://us.2breeze.app' });
    expect(buildPortalUrl('/reset-password?token=x')).toBe('https://us.2breeze.app/portal/reset-password?token=x');
  });
  it('does not double the /portal segment', () => {
    setEnv({ PUBLIC_PORTAL_URL: 'https://us.2breeze.app/portal/' });
    expect(buildPortalUrl('/reset-password')).toBe('https://us.2breeze.app/portal/reset-password');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test --filter=@breeze/api -- portal/helpers.test`
Expected: FAIL — `buildPortalUrl` is not exported.

- [ ] **Step 4: Implement the helper infra in `helpers.ts`**

In `apps/api/src/routes/portal/helpers.ts`:

Add `nanoid` to the imports at the top:

```ts
import { nanoid } from 'nanoid';
```

Add the invite constants to the existing `./schemas` import block (lines 8-22):

```ts
  INVITE_TTL_MS,
  INVITE_TTL_SECONDS,
  PORTAL_INVITE_TOKEN_CAP,
```

Add the in-memory map after `portalResetTokens` (line 29):

```ts
export const portalInviteTokens = new Map<string, { portalUserId: string; expiresAt: Date; createdAt: Date }>();
```

Add invite-token sweeping inside `sweepPortalState`, after the reset-token loop (line 231), and its cap after line 234:

```ts
  for (const [tokenHash, invite] of portalInviteTokens.entries()) {
    if (invite.expiresAt.getTime() <= nowMs) {
      portalInviteTokens.delete(tokenHash);
    }
  }
```
```ts
  capMapByOldest(portalInviteTokens, PORTAL_INVITE_TOKEN_CAP, (token) => token.createdAt.getTime());
```

Append the new exported functions at the end of the file:

```ts
// ============================================
// Portal URL + invite tokens
// ============================================

/**
 * Absolute base for portal-hosted pages in outbound emails (reset, invite).
 * The portal is served under /portal on the main domain, so links MUST include
 * that segment — DASHBOARD_URL/PUBLIC_APP_URL point at the MSP app root.
 */
export function buildPortalUrl(path: string): string {
  const explicit = process.env.PUBLIC_PORTAL_URL?.trim();
  const appRoot = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').trim();
  const base = (explicit && explicit.length > 0 ? explicit : `${appRoot.replace(/\/$/, '')}/portal`).replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

export async function storePortalInviteToken(portalUserId: string): Promise<string> {
  const rawToken = nanoid(48);
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (redis) {
      await redis.setex(PORTAL_REDIS_KEYS.inviteToken(tokenHash), INVITE_TTL_SECONDS, JSON.stringify({ portalUserId }));
    }
  } else {
    portalInviteTokens.set(tokenHash, { portalUserId, expiresAt: new Date(Date.now() + INVITE_TTL_MS), createdAt: new Date() });
    capMapByOldest(portalInviteTokens, PORTAL_INVITE_TOKEN_CAP, (t) => t.createdAt.getTime());
  }
  return rawToken;
}

export async function consumePortalInviteToken(rawToken: string): Promise<string | null> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get(PORTAL_REDIS_KEYS.inviteToken(tokenHash));
    if (!raw) return null;
    await redis.del(PORTAL_REDIS_KEYS.inviteToken(tokenHash));
    try { return JSON.parse(raw).portalUserId ?? null; } catch { return null; }
  }
  const stored = portalInviteTokens.get(tokenHash);
  portalInviteTokens.delete(tokenHash);
  if (stored && stored.expiresAt.getTime() > Date.now()) return stored.portalUserId;
  return null;
}
```

`createHash`, `getRedis`, `PORTAL_USE_REDIS`, `PORTAL_REDIS_KEYS`, `capMapByOldest` are already imported/in-scope in this file.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test --filter=@breeze/api -- portal/helpers.test`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/portal/schemas.ts apps/api/src/routes/portal/helpers.ts apps/api/src/routes/portal/helpers.test.ts
git commit -m "feat(portal): invite-token store + buildPortalUrl helper"
```

---

## Task 3: `accept-invite` endpoint + forgot-password link fix

**Files:**
- Modify: `apps/api/src/routes/portal/auth.ts` (new route; fix `forgot-password` URL)
- Test: `apps/api/src/routes/portal/acceptInvite.test.ts` (create)

**Interfaces:**
- Consumes: `consumePortalInviteToken`, `storePortalInviteToken`, `buildPortalUrl` (Task 2); `acceptInviteSchema`, `INVITE_TTL_*` (Task 2).
- Produces: `POST /portal/auth/accept-invite` → `{ user, accessToken, expiresAt, tokens }` (same shape as `/auth/login`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/portal/acceptInvite.test.ts`. It exercises the real handler with the in-memory token store (NODE_ENV=test ⇒ `PORTAL_USE_REDIS=false`), mocking only the DB layer:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { userRow, updateSpy } = vi.hoisted(() => ({
  userRow: { current: null as any },
  updateSpy: vi.fn()
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(userRow.current ? [userRow.current] : []) }) }) }),
    update: () => ({ set: (v: any) => ({ where: () => { updateSpy(v); return Promise.resolve(); } }) })
  },
  withDbAccessContext: (_ctx: any, fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn()
}));
vi.mock('../../db/schema', () => ({ portalUsers: { id: 'id', orgId: 'orgId', email: 'email', name: 'name', passwordHash: 'passwordHash', receiveNotifications: 'receiveNotifications', status: 'status' } }));
vi.mock('../../services/email', () => ({ getEmailService: () => null }));

import { authRoutes } from './auth';
import { storePortalInviteToken } from './helpers';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const USER_ID = '11111111-2222-4333-8444-555566667777';
const makeApp = () => { const app = new Hono(); app.route('/', authRoutes); return app; };
const post = (body: unknown) => makeApp().request('/auth/accept-invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); userRow.current = null; });

describe('POST /auth/accept-invite', () => {
  it('activates an invited user and issues a session', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, receiveNotifications: true, status: 'invited' };
    const token = await storePortalInviteToken(USER_ID);
    const res = await post({ token, password: 'Str0ngPass!', name: 'Cust Omer' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(USER_ID);
    expect(body.accessToken).toBeTruthy();
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', name: 'Cust Omer' }));
  });

  it('rejects an invalid/expired token', async () => {
    const res = await post({ token: 'nope', password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
  });

  it('rejects when the account is already active with a password', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'cust@acme.example', name: 'X', passwordHash: 'existing-hash', receiveNotifications: true, status: 'active' };
    const token = await storePortalInviteToken(USER_ID);
    const res = await post({ token, password: 'Str0ngPass!' });
    expect(res.status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects a weak password', async () => {
    userRow.current = { id: USER_ID, orgId: ORG_ID, email: 'c@a.example', name: null, passwordHash: null, receiveNotifications: true, status: 'invited' };
    const token = await storePortalInviteToken(USER_ID);
    const res = await post({ token, password: 'short' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter=@breeze/api -- portal/acceptInvite.test`
Expected: FAIL — route returns 404 (not implemented).

- [ ] **Step 3: Implement the endpoint + fix forgot-password**

In `apps/api/src/routes/portal/auth.ts`:

Add to the `./schemas` import (lines 12-28): `acceptInviteSchema`.
Add to the `./helpers` import (lines 29-43): `consumePortalInviteToken`, `buildPortalUrl`.

Fix the forgot-password reset URL — replace lines 392-394 (`const appBaseUrl = ...` through the `resetUrl` assignment) with:

```ts
    const orgQuery = orgId ? `&orgId=${encodeURIComponent(orgId)}` : '';
    const resetUrl = buildPortalUrl(`/reset-password?token=${encodeURIComponent(resetToken)}${orgQuery}`);
```

Add the new route immediately after the `reset-password` handler (after line 503):

```ts
authRoutes.post('/auth/accept-invite', zValidator('json', acceptInviteSchema), async (c) => {
  sweepPortalState();

  const { token, password, name } = c.req.valid('json');
  const clientIp = getClientIp(c);
  const tokenHash = createHash('sha256').update(token).digest('hex');

  for (const rateKey of [`portal:accept:ip:${clientIp}`, `portal:accept:token:${tokenHash}`]) {
    const rate = await checkRateLimit(rateKey, RESET_PASSWORD_RATE_LIMIT);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'Too many attempts. Please try again later.' }, 429);
    }
  }

  const strength = isPasswordStrong(password);
  if (!strength.valid) {
    return c.json({ error: strength.errors[0] }, 400);
  }

  if (PORTAL_USE_REDIS && !getRedis()) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const portalUserId = await consumePortalInviteToken(token);
  if (!portalUserId) {
    return c.json({ error: 'Invalid or expired invite' }, 400);
  }

  const [user] = await withSystemDbAccessContext(() =>
    db
      .select({
        id: portalUsers.id,
        orgId: portalUsers.orgId,
        email: portalUsers.email,
        name: portalUsers.name,
        passwordHash: portalUsers.passwordHash,
        receiveNotifications: portalUsers.receiveNotifications,
        status: portalUsers.status
      })
      .from(portalUsers)
      .where(eq(portalUsers.id, portalUserId))
      .limit(1)
  );

  if (!user) {
    return c.json({ error: 'Invalid or expired invite' }, 400);
  }
  // An invite must never hijack a live account.
  if (user.passwordHash && user.status === 'active') {
    return c.json({ error: 'This account is already set up. Use the login page.' }, 400);
  }

  const now = new Date();
  const passwordHash = await hashPassword(password);
  const resolvedName = user.name ?? (name ?? null);

  await withSystemDbAccessContext(() =>
    db
      .update(portalUsers)
      .set({ passwordHash, name: resolvedName, status: 'active', lastLoginAt: now, updatedAt: now })
      .where(eq(portalUsers.id, user.id))
  );

  const sessionToken = nanoid(48);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (redis) {
      await redis
        .multi()
        .setex(PORTAL_REDIS_KEYS.session(sessionToken), SESSION_TTL_SECONDS, JSON.stringify({ portalUserId: user.id, orgId: user.orgId, createdAt: now.toISOString() }))
        .sadd(PORTAL_REDIS_KEYS.userSessions(user.id), sessionToken)
        .expire(PORTAL_REDIS_KEYS.userSessions(user.id), SESSION_TTL_SECONDS * 2)
        .exec();
    }
  } else {
    portalSessions.set(sessionToken, { token: sessionToken, portalUserId: user.id, orgId: user.orgId, createdAt: now, expiresAt });
    capMapByOldest(portalSessions, PORTAL_SESSION_CAP, (s) => s.createdAt.getTime());
  }

  setPortalSessionCookies(c, sessionToken);

  return c.json({
    user: buildPortalUserPayload({ ...user, name: resolvedName, status: 'active' }),
    accessToken: sessionToken,
    expiresAt,
    tokens: { accessToken: sessionToken, expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000) }
  });
});
```

Add any not-yet-imported names to the existing `./schemas` import: `SESSION_TTL_MS`, `SESSION_TTL_SECONDS`, `PORTAL_SESSION_CAP`, `PORTAL_REDIS_KEYS`, `PORTAL_USE_REDIS`, `RESET_PASSWORD_RATE_LIMIT` (most already imported — add only the missing ones), and to `./helpers`: `portalSessions`, `capMapByOldest`, `setPortalSessionCookies`, `buildPortalUserPayload` (add only missing). `hashPassword`, `isPasswordStrong`, `getRedis`, `createHash`, `nanoid`, `eq`, `db`, `portalUsers`, `withSystemDbAccessContext` are already imported at the top of `auth.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --filter=@breeze/api -- portal/acceptInvite.test`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify the existing portal auth tests still pass**

Run: `pnpm test --filter=@breeze/api -- portal`
Expected: PASS (existing `portal.test.ts` / `portal.compat.test.ts` unaffected).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/portal/auth.ts apps/api/src/routes/portal/acceptInvite.test.ts
git commit -m "feat(portal): accept-invite endpoint + fix forgot-password link base"
```

---

## Task 4: Shared validators (MSP-facing)

**Files:**
- Modify: `packages/shared/src/validators/portal.ts` (3 schemas)
- Modify: `packages/shared/src/validators/index.ts` (ensure `export * from './portal';` present)
- Test: `packages/shared/src/validators/portal.test.ts` (create if absent)

**Interfaces:**
- Produces (all importable from `@breeze/shared`):
  - `invitePortalUserSchema` = `{ email: email, name?: string(max255), message?: string(max1000) }`
  - `bulkInvitePortalUsersSchema` = `{ userIds?: string(guid)[] }`
  - `updatePortalUserSchema` = `{ name?: string(max255), receiveNotifications?: boolean, status?: 'active'|'disabled' }`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/validators/portal.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { invitePortalUserSchema, bulkInvitePortalUsersSchema, updatePortalUserSchema } from './portal';

describe('invitePortalUserSchema', () => {
  it('accepts a valid invite', () => {
    expect(invitePortalUserSchema.safeParse({ email: 'a@b.example', name: 'A', message: 'hi' }).success).toBe(true);
  });
  it('rejects a bad email', () => {
    expect(invitePortalUserSchema.safeParse({ email: 'nope' }).success).toBe(false);
  });
  it('rejects an over-long message', () => {
    expect(invitePortalUserSchema.safeParse({ email: 'a@b.example', message: 'x'.repeat(1001) }).success).toBe(false);
  });
});

describe('updatePortalUserSchema', () => {
  it('accepts active/disabled status', () => {
    expect(updatePortalUserSchema.safeParse({ status: 'disabled' }).success).toBe(true);
  });
  it('rejects an invited status (not settable here)', () => {
    expect(updatePortalUserSchema.safeParse({ status: 'invited' }).success).toBe(false);
  });
});

describe('bulkInvitePortalUsersSchema', () => {
  it('accepts an optional userIds array of GUIDs', () => {
    expect(bulkInvitePortalUsersSchema.safeParse({ userIds: ['7c0a1f7e-1111-4222-8333-444455556666'] }).success).toBe(true);
    expect(bulkInvitePortalUsersSchema.safeParse({}).success).toBe(true);
  });
  it('rejects non-GUID ids', () => {
    expect(bulkInvitePortalUsersSchema.safeParse({ userIds: ['not-a-guid'] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter=@breeze/shared -- validators/portal.test`
Expected: FAIL — schemas not exported.

- [ ] **Step 3: Add the schemas**

Append to `packages/shared/src/validators/portal.ts`:

```ts
export const invitePortalUserSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(255).optional(),
  message: z.string().max(1000).optional()
}).strict();
export type InvitePortalUserInput = z.infer<typeof invitePortalUserSchema>;

export const bulkInvitePortalUsersSchema = z.object({
  userIds: z.array(z.string().guid()).optional()
}).strict();
export type BulkInvitePortalUsersInput = z.infer<typeof bulkInvitePortalUsersSchema>;

export const updatePortalUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  receiveNotifications: z.boolean().optional(),
  status: z.enum(['active', 'disabled']).optional()
}).strict();
export type UpdatePortalUserInput = z.infer<typeof updatePortalUserSchema>;
```

- [ ] **Step 4: Ensure the barrel re-exports `./portal`**

Check `packages/shared/src/validators/index.ts`. If it does not already contain `export * from './portal';`, add it to the export list (top of file, alongside the other `export * from './...'` lines).

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm test --filter=@breeze/shared -- validators/portal.test`
Expected: PASS (7 assertions across 3 describes).
Run: `pnpm --filter=@breeze/shared build` (or the repo's shared typecheck) to confirm the new `@breeze/shared` exports compile.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/portal.ts packages/shared/src/validators/portal.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(portal): shared validators for portal-user invite/manage"
```

---

## Task 5: Email — `sendPortalInvite`

**Files:**
- Modify: `apps/api/src/services/email.ts` (interface, method, template builder)
- Test: `apps/api/src/services/portalInviteEmail.test.ts` (create)

**Interfaces:**
- Produces: `EmailService.sendPortalInvite(params: PortalInviteEmailParams): Promise<void>`; `PortalInviteEmailParams = { to: string|string[]; inviteUrl: string; orgName?: string; inviterName?: string; message?: string; supportEmail?: string }`; and exported `buildPortalInviteTemplate(params): EmailTemplate` for testing.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/portalInviteEmail.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPortalInviteTemplate } from './email';

describe('buildPortalInviteTemplate', () => {
  it('includes the invite URL and org name', () => {
    const t = buildPortalInviteTemplate({ to: 'c@a.example', inviteUrl: 'https://us.2breeze.app/portal/accept-invite?token=abc', orgName: 'Acme Co', inviterName: 'Tess' });
    expect(t.subject).toContain('Acme Co');
    expect(t.html).toContain('https://us.2breeze.app/portal/accept-invite?token=abc');
    expect(t.text).toContain('https://us.2breeze.app/portal/accept-invite?token=abc');
  });
  it('renders a generic subject without an org name', () => {
    const t = buildPortalInviteTemplate({ to: 'c@a.example', inviteUrl: 'https://x/portal/accept-invite?token=1' });
    expect(t.subject.length).toBeGreaterThan(0);
  });
  it('includes an optional custom message', () => {
    const t = buildPortalInviteTemplate({ to: 'c@a.example', inviteUrl: 'https://x/p?t=1', message: 'Welcome aboard!' });
    expect(t.html).toContain('Welcome aboard!');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter=@breeze/api -- portalInviteEmail.test`
Expected: FAIL — `buildPortalInviteTemplate` not exported.

- [ ] **Step 3: Implement**

In `apps/api/src/services/email.ts`, add the params interface near `PasswordResetEmailParams` (~line 44):

```ts
export interface PortalInviteEmailParams {
  to: string | string[];
  inviteUrl: string;
  orgName?: string;
  inviterName?: string;
  message?: string;
  supportEmail?: string;
}
```

Add the method inside `class EmailService` (before it closes at line 309), mirroring `sendPasswordReset`:

```ts
  async sendPortalInvite(params: PortalInviteEmailParams): Promise<void> {
    const template = buildPortalInviteTemplate(params);
    await this.sendEmail({ to: params.to, subject: template.subject, html: template.html, text: template.text });
  }
```

Add the exported template builder near `buildPasswordResetTemplate` (~line 630):

```ts
export function buildPortalInviteTemplate(params: PortalInviteEmailParams): EmailTemplate {
  const orgName = params.orgName?.trim();
  const inviter = params.inviterName?.trim();
  const customMessage = params.message?.trim();
  const subject = orgName ? `You're invited to the ${orgName} support portal` : `You're invited to your support portal`;
  const preheader = 'Set your password to access your support portal.';
  const heading = orgName ? `Join the ${orgName} portal` : 'Join your support portal';
  const invitedBy = inviter ? `${escapeHtml(inviter)} invited you` : 'You have been invited';
  const body = `
      <p style="${BODY_PARA}">${invitedBy} to the${orgName ? ` ${escapeHtml(orgName)}` : ''} support portal, where you can open tickets, view invoices, and track your devices.</p>
      ${customMessage ? `<p style="${BODY_PARA}">${escapeHtml(customMessage)}</p>` : ''}
      ${renderButton('Set your password', params.inviteUrl)}
      <p style="${MUTED_PARA}">This invite link expires in 7 days. If you didn't expect this, you can ignore this email.</p>
  `;
  const html = renderLayout({ title: subject, preheader, heading, body, footer: supportFooter(params.supportEmail, 'Need help? Contact') });
  const support = getSupportEmail(params.supportEmail);
  const text = [
    orgName ? `You're invited to the ${orgName} support portal.` : `You're invited to your support portal.`,
    customMessage || null,
    `Set your password: ${params.inviteUrl}`,
    'This invite link expires in 7 days.',
    support ? `Need help? Contact ${support}.` : null
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}
```

`escapeHtml`, `renderButton`, `renderLayout`, `getSupportEmail` are already imported from `./emailLayout`; `BODY_PARA`, `MUTED_PARA`, `supportFooter`, `EmailTemplate` are already in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter=@breeze/api -- portalInviteEmail.test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/email.ts apps/api/src/services/portalInviteEmail.test.ts
git commit -m "feat(portal): sendPortalInvite email template"
```

---

## Task 6: MSP API — `orgPortalUsers.ts` (list + invite)

**Files:**
- Create: `apps/api/src/routes/orgPortalUsers.ts`
- Modify: `apps/api/src/routes/orgs.ts:29` (import) and `:1331-1334` (register)
- Test: `apps/api/src/routes/orgPortalUsers.test.ts` (create)

**Interfaces:**
- Consumes: `storePortalInviteToken`, `buildPortalUrl` (Task 2); `getEmailService().sendPortalInvite` (Task 5); `invitePortalUserSchema` (Task 4).
- Produces: `registerOrgPortalUsersRoutes(orgRoutes: Hono): void`; `effectivePortalStatus(row): 'active'|'disabled'|'pending_setup'` (module-local); routes `GET /organizations/:id/portal-users`, `POST /organizations/:id/portal-users/invite`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/orgPortalUsers.test.ts` (mirrors `orgPortalSettings.test.ts` mock skeleton):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, selectResult, insertReturning, sendInvite } = vi.hoisted(() => ({
  authRef: { current: { scope: 'partner' as string, user: { id: 'u-1', name: 'Tess', email: 'tess@msp.example' }, partnerId: 'p-1' as string | null, canAccessOrg: (_id: string) => true } },
  selectResult: vi.fn(),
  insertReturning: vi.fn(),
  sendInvite: vi.fn()
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => { c.set('auth', authRef.current); await next(); }),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next()
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => selectResult()), orderBy: vi.fn(() => selectResult()) })) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => insertReturning()) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => insertReturning()) })) })) }))
  }
}));
vi.mock('../db/schema', () => ({
  portalUsers: { id: 'id', orgId: 'orgId', email: 'email', name: 'name', passwordHash: 'passwordHash', receiveNotifications: 'receiveNotifications', status: 'status', invitedBy: 'invitedBy', invitedAt: 'invitedAt', lastLoginAt: 'lastLoginAt', createdAt: 'createdAt' },
  organizations: { id: 'id', name: 'name', deletedAt: 'deletedAt' }
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../routes/portal/helpers', () => ({ storePortalInviteToken: vi.fn(async () => 'raw-token'), buildPortalUrl: (p: string) => `https://x/portal${p}` }));
vi.mock('../services/email', () => ({ getEmailService: () => ({ sendPortalInvite: sendInvite }) }));

import { authMiddleware } from '../middleware/auth';
import { registerOrgPortalUsersRoutes } from './orgPortalUsers';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const makeApp = () => { const app = new Hono(); app.use('*', authMiddleware as any); registerOrgPortalUsersRoutes(app); return app; };
beforeEach(() => { vi.clearAllMocks(); authRef.current = { scope: 'partner', user: { id: 'u-1', name: 'Tess', email: 'tess@msp.example' }, partnerId: 'p-1', canAccessOrg: () => true }; });

describe('GET /organizations/:id/portal-users', () => {
  it('lists users with an effective status', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org existence
      .mockResolvedValueOnce([
        { id: 'pu-1', email: 'a@acme.example', name: 'A', passwordHash: 'h', status: 'active', receiveNotifications: true, lastLoginAt: null, invitedAt: null },
        { id: 'pu-2', email: 'b@acme.example', name: null, passwordHash: null, status: 'active', receiveNotifications: true, lastLoginAt: null, invitedAt: null }
      ]);
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-users`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((u: any) => u.effectiveStatus)).toEqual(['active', 'pending_setup']);
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });
});

describe('POST /organizations/:id/portal-users/invite', () => {
  const invite = (body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('creates an invited user and emails a link', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org existence
      .mockResolvedValueOnce([])               // no existing portal user
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new', email: 'new@acme.example', status: 'invited' }]);
    const res = await invite({ email: 'new@acme.example', name: 'New Cust' });
    expect(res.status).toBe(200);
    expect(sendInvite).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@acme.example', inviteUrl: expect.stringContaining('/portal/accept-invite?token=raw-token') }));
  });

  it('409s when the email is already an active account with a password', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', email: 'live@acme.example', passwordHash: 'h', status: 'active' }]);
    const res = await invite({ email: 'live@acme.example' });
    expect(res.status).toBe(409);
    expect(sendInvite).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter=@breeze/api -- orgPortalUsers.test`
Expected: FAIL — module `./orgPortalUsers` does not exist.

- [ ] **Step 3: Implement the route module**

Create `apps/api/src/routes/orgPortalUsers.ts`:

```ts
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, desc } from 'drizzle-orm';
import { db } from '../db';
import { organizations, portalUsers } from '../db/schema';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { getEmailService } from '../services/email';
import { storePortalInviteToken, buildPortalUrl } from './portal/helpers';
import { invitePortalUserSchema } from '@breeze/shared';

type PortalUserListRow = {
  id: string; email: string; name: string | null; passwordHash: string | null;
  status: string; receiveNotifications: boolean; lastLoginAt: Date | null; invitedAt: Date | null;
};

export function effectivePortalStatus(row: { status: string; passwordHash: string | null }): 'active' | 'disabled' | 'pending_setup' {
  if (row.status === 'disabled') return 'disabled';
  if (!row.passwordHash) return 'pending_setup';
  return 'active';
}

function toListItem(row: PortalUserListRow) {
  return {
    id: row.id, email: row.email, name: row.name, status: row.status,
    effectiveStatus: effectivePortalStatus(row), receiveNotifications: row.receiveNotifications,
    lastLoginAt: row.lastLoginAt, invitedAt: row.invitedAt
  };
}

async function resolveAccessibleOrg(c: any): Promise<{ id: string } | Response> {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id')!;
  if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
    return c.json({ error: 'Organization not found' }, 404);
  }
  const rows = await db.select({ id: organizations.id }).from(organizations)
    .where(and(eq(organizations.id, id), isNull(organizations.deletedAt))).limit(1);
  if (!rows[0]) return c.json({ error: 'Organization not found' }, 404);
  return { id };
}

export function registerOrgPortalUsersRoutes(orgRoutes: Hono) {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  orgRoutes.get('/organizations/:id/portal-users', requireScope('partner', 'system'), requireOrgRead, async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const rows = await db.select({
      id: portalUsers.id, email: portalUsers.email, name: portalUsers.name, passwordHash: portalUsers.passwordHash,
      status: portalUsers.status, receiveNotifications: portalUsers.receiveNotifications,
      lastLoginAt: portalUsers.lastLoginAt, invitedAt: portalUsers.invitedAt
    }).from(portalUsers).where(eq(portalUsers.orgId, org.id)).orderBy(desc(portalUsers.createdAt));
    return c.json({ data: rows.map(toListItem) });
  });

  orgRoutes.post('/organizations/:id/portal-users/invite', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', invitePortalUserSchema), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const auth = c.get('auth') as AuthContext;
    const { email, name, message } = c.req.valid('json');
    const normalizedEmail = email.trim().toLowerCase();

    const [existing] = await db.select({ id: portalUsers.id, email: portalUsers.email, passwordHash: portalUsers.passwordHash, status: portalUsers.status })
      .from(portalUsers).where(and(eq(portalUsers.orgId, org.id), eq(portalUsers.email, normalizedEmail))).limit(1);

    if (existing && existing.passwordHash && existing.status === 'active') {
      return c.json({ error: 'This email already has an active portal account.' }, 409);
    }

    const now = new Date();
    let userId: string;
    if (existing) {
      await db.update(portalUsers).set({ name: name ?? undefined, status: 'invited', invitedBy: auth.user.id, invitedAt: now, updatedAt: now }).where(eq(portalUsers.id, existing.id)).returning({ id: portalUsers.id });
      userId = existing.id;
    } else {
      const [created] = await db.insert(portalUsers).values({ orgId: org.id, email: normalizedEmail, name: name ?? null, passwordHash: null, authMethod: 'password', status: 'invited', invitedBy: auth.user.id, invitedAt: now }).returning({ id: portalUsers.id });
      userId = created!.id;
    }

    const [orgRow] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, org.id)).limit(1);
    const rawToken = await storePortalInviteToken(userId);
    if (!rawToken) return c.json({ error: 'Service temporarily unavailable' }, 503);
    const inviteUrl = buildPortalUrl(`/accept-invite?token=${encodeURIComponent(rawToken)}`);

    let emailSent = false;
    const emailService = getEmailService();
    if (emailService) {
      try {
        await emailService.sendPortalInvite({ to: normalizedEmail, inviteUrl, orgName: orgRow?.name ?? undefined, inviterName: auth.user.name ?? undefined, message });
        emailSent = true;
      } catch (err) {
        console.error('[orgPortalUsers] invite email failed:', err);
      }
    }

    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.invite', resourceType: 'portal_user', resourceId: userId, details: { email: normalizedEmail, emailSent } });
    return c.json({ data: { id: userId, email: normalizedEmail, status: 'invited' }, emailSent });
  });
}
```

- [ ] **Step 4: Register the routes in `orgs.ts`**

In `apps/api/src/routes/orgs.ts`, add next to line 29:

```ts
import { registerOrgPortalUsersRoutes } from './orgPortalUsers';
```

And next to the `registerOrgPortalSettingsRoutes(orgRoutes);` call (line ~1332):

```ts
// Customer-portal users (portal_users invite/manage) — see routes/orgPortalUsers.ts
registerOrgPortalUsersRoutes(orgRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test --filter=@breeze/api -- orgPortalUsers.test`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/orgPortalUsers.ts apps/api/src/routes/orgPortalUsers.test.ts apps/api/src/routes/orgs.ts
git commit -m "feat(portal): MSP org-portal-users list + invite endpoints"
```

---

## Task 7: MSP API — patch, resend, bulk-invite, delete

**Files:**
- Modify: `apps/api/src/routes/orgPortalUsers.ts`
- Modify: `apps/api/src/routes/orgPortalUsers.test.ts`

**Interfaces:**
- Consumes: `bulkInvitePortalUsersSchema`, `updatePortalUserSchema` (Task 4); `ticketComments`, `tickets`, `assetCheckouts` schema tables.
- Produces: `PATCH`, `POST .../resend-invite`, `POST .../bulk-invite`, `DELETE` routes.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/orgPortalUsers.test.ts`:

```ts
describe('PATCH /organizations/:id/portal-users/:userId', () => {
  const patch = (uid: string, body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/${uid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('disables a user', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])                         // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID }]);          // target exists in org
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1', status: 'disabled' }]); // update .returning
    const res = await patch('pu-1', { status: 'disabled' });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /organizations/:id/portal-users/:userId', () => {
  const del = (uid: string) => makeApp().request(`/organizations/${ORG_ID}/portal-users/${uid}`, { method: 'DELETE' });
  it('409s when the user has ticket references', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])            // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID }]) // target
      .mockResolvedValueOnce([{ id: 't-1' }]);            // reference exists (tickets)
    const res = await del('pu-1');
    expect(res.status).toBe(409);
  });
  it('hard-deletes an unreferenced user', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID }])
      .mockResolvedValueOnce([]) // tickets ref
      .mockResolvedValueOnce([]) // comments ref
      .mockResolvedValueOnce([]); // checkouts ref
    // delete().where() resolves (mock deleteChain below)
    const res = await del('pu-1');
    expect(res.status).toBe(200);
  });
});
```

Extend the `../db` mock in the hoisted block to add a `delete` chain — update the `vi.mock('../db', ...)` `db` object to include:

```ts
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --filter=@breeze/api -- orgPortalUsers.test`
Expected: FAIL — new routes not implemented.

- [ ] **Step 3: Implement the remaining routes**

In `apps/api/src/routes/orgPortalUsers.ts`, extend the schema import:

```ts
import { invitePortalUserSchema, bulkInvitePortalUsersSchema, updatePortalUserSchema } from '@breeze/shared';
```
Add table imports for the reference check:
```ts
import { tickets, ticketComments, assetCheckouts } from '../db/schema';
```

Add a shared helper inside the module (above `registerOrgPortalUsersRoutes`):

```ts
async function getOrgScopedPortalUser(orgId: string, userId: string) {
  const [row] = await db.select({ id: portalUsers.id, orgId: portalUsers.orgId, email: portalUsers.email, name: portalUsers.name, passwordHash: portalUsers.passwordHash, status: portalUsers.status })
    .from(portalUsers).where(and(eq(portalUsers.id, userId), eq(portalUsers.orgId, orgId))).limit(1);
  return row ?? null;
}

async function hasPortalUserReferences(userId: string): Promise<boolean> {
  const [t] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.submittedBy, userId)).limit(1);
  if (t) return true;
  const [cm] = await db.select({ id: ticketComments.id }).from(ticketComments).where(eq(ticketComments.portalUserId, userId)).limit(1);
  if (cm) return true;
  const [ck] = await db.select({ id: assetCheckouts.id }).from(assetCheckouts).where(eq(assetCheckouts.checkedOutTo, userId)).limit(1);
  return Boolean(ck);
}

async function issueAndSendInvite(c: any, orgId: string, user: { id: string; email: string }, orgName: string | null, inviterName: string | null | undefined, message?: string): Promise<boolean> {
  const rawToken = await storePortalInviteToken(user.id);
  if (!rawToken) return false; // redis unavailable — do not email a dead invite link
  const inviteUrl = buildPortalUrl(`/accept-invite?token=${encodeURIComponent(rawToken)}`);
  const emailService = getEmailService();
  if (!emailService) return false;
  try {
    await emailService.sendPortalInvite({ to: user.email, inviteUrl, orgName: orgName ?? undefined, inviterName: inviterName ?? undefined, message });
    return true;
  } catch (err) {
    console.error('[orgPortalUsers] invite email failed:', err);
    return false;
  }
}
```

Refactor the existing invite handler's token+email block to call `issueAndSendInvite` (DRY) — replace the inline `storePortalInviteToken`/`getEmailService` block with:

```ts
    const [orgRow] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, org.id)).limit(1);
    const emailSent = await issueAndSendInvite(c, org.id, { id: userId, email: normalizedEmail }, orgRow?.name ?? null, auth.user.name, message);
```

Add these routes inside `registerOrgPortalUsersRoutes` (after the invite route):

```ts
  orgRoutes.patch('/organizations/:id/portal-users/:userId', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', updatePortalUserSchema), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const body = c.req.valid('json');
    if (Object.keys(body).length === 0) return c.json({ error: 'No updates provided' }, 400);
    const target = await getOrgScopedPortalUser(org.id, c.req.param('userId')!);
    if (!target) return c.json({ error: 'Portal user not found' }, 404);
    const [updated] = await db.update(portalUsers).set({ ...body, updatedAt: new Date() }).where(eq(portalUsers.id, target.id)).returning({ id: portalUsers.id, status: portalUsers.status });
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.update', resourceType: 'portal_user', resourceId: target.id, details: { changedFields: Object.keys(body) } });
    return c.json({ data: { id: updated!.id, status: updated!.status } });
  });

  orgRoutes.post('/organizations/:id/portal-users/:userId/resend-invite', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const auth = c.get('auth') as AuthContext;
    const target = await getOrgScopedPortalUser(org.id, c.req.param('userId')!);
    if (!target) return c.json({ error: 'Portal user not found' }, 404);
    if (target.passwordHash && target.status === 'active') return c.json({ error: 'This account is already set up.' }, 409);
    const [orgRow] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, org.id)).limit(1);
    const emailSent = await issueAndSendInvite(c, org.id, { id: target.id, email: target.email }, orgRow?.name ?? null, auth.user.name);
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.resend_invite', resourceType: 'portal_user', resourceId: target.id, details: { emailSent } });
    return c.json({ data: { id: target.id }, emailSent });
  });

  orgRoutes.post('/organizations/:id/portal-users/bulk-invite', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', bulkInvitePortalUsersSchema), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const auth = c.get('auth') as AuthContext;
    const { userIds } = c.req.valid('json');
    // "Pending setup" = no password. Invite selected, or all pending in the org.
    const baseWhere = and(eq(portalUsers.orgId, org.id), isNull(portalUsers.passwordHash));
    const candidates = await db.select({ id: portalUsers.id, email: portalUsers.email }).from(portalUsers).where(baseWhere);
    const targets = userIds && userIds.length > 0 ? candidates.filter((u) => userIds.includes(u.id)) : candidates;
    const [orgRow] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, org.id)).limit(1);
    const now = new Date();
    const results: Array<{ id: string; emailSent: boolean }> = [];
    for (const t of targets) {
      await db.update(portalUsers).set({ status: 'invited', invitedBy: auth.user.id, invitedAt: now, updatedAt: now }).where(eq(portalUsers.id, t.id));
      const emailSent = await issueAndSendInvite(c, org.id, t, orgRow?.name ?? null, auth.user.name);
      results.push({ id: t.id, emailSent });
    }
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.bulk_invite', resourceType: 'organization', resourceId: org.id, details: { invited: results.length } });
    return c.json({ data: results });
  });

  orgRoutes.delete('/organizations/:id/portal-users/:userId', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const target = await getOrgScopedPortalUser(org.id, c.req.param('userId')!);
    if (!target) return c.json({ error: 'Portal user not found' }, 404);
    if (await hasPortalUserReferences(target.id)) {
      return c.json({ error: 'This user has ticket or asset history. Disable them instead of deleting.' }, 409);
    }
    await db.delete(portalUsers).where(eq(portalUsers.id, target.id));
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.delete', resourceType: 'portal_user', resourceId: target.id, details: { email: target.email } });
    return c.json({ data: { id: target.id, deleted: true } });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --filter=@breeze/api -- orgPortalUsers.test`
Expected: PASS (all tests across Tasks 6 + 7).

- [ ] **Step 5: Typecheck the API**

Run: `pnpm --filter=@breeze/api typecheck` (or the repo's API type-check script)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/orgPortalUsers.ts apps/api/src/routes/orgPortalUsers.test.ts
git commit -m "feat(portal): org-portal-users patch/resend/bulk-invite/delete"
```

---

## Task 8: Web UI — `OrgPortalUsersEditor.tsx`

**Files:**
- Create: `apps/web/src/components/settings/OrgPortalUsersEditor.tsx`
- Modify: `apps/web/src/components/settings/OrgSettingsPage.tsx:24` (import) and the `case 'portal'` block (~line 485)
- Test: `apps/web/src/components/settings/OrgPortalUsersEditor.test.tsx` (create)

**Interfaces:**
- Consumes: `fetchWithAuth` (`../../stores/auth`), `runAction`/`ActionError` (`@/lib/runAction`), `navigateTo` (`@/lib/navigation`).
- API paths (relative, `/orgs`-prefixed): `GET/POST /orgs/organizations/${orgId}/portal-users`, `POST .../invite`, `POST .../bulk-invite`, `PATCH .../:userId`, `POST .../:userId/resend-invite`, `DELETE .../:userId`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/settings/OrgPortalUsersEditor.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: any[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import OrgPortalUsersEditor from './OrgPortalUsersEditor';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => (data) });

beforeEach(() => { vi.clearAllMocks(); });

describe('OrgPortalUsersEditor', () => {
  it('renders portal users with status badges', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({ data: [
      { id: 'pu-1', email: 'a@acme.example', name: 'A', status: 'active', effectiveStatus: 'active', lastLoginAt: null, invitedAt: null },
      { id: 'pu-2', email: 'b@acme.example', name: null, status: 'active', effectiveStatus: 'pending_setup', lastLoginAt: null, invitedAt: null }
    ] }));
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByText('a@acme.example')).toBeInTheDocument());
    expect(screen.getByText('b@acme.example')).toBeInTheDocument();
    expect(screen.getByText(/pending setup/i)).toBeInTheDocument();
  });

  it('invites a user through the API', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(ok({ data: [] }))                                  // initial list
      .mockResolvedValueOnce(ok({ data: { id: 'pu-new', status: 'invited' }, emailSent: true })) // invite
      .mockResolvedValueOnce(ok({ data: [] }));                                 // reload
    render(<OrgPortalUsersEditor orgId={ORG_ID} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('portal-users-invite-open'));
    fireEvent.change(screen.getByTestId('portal-users-invite-email'), { target: { value: 'new@acme.example' } });
    fireEvent.click(screen.getByTestId('portal-users-invite-submit'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      `/orgs/organizations/${ORG_ID}/portal-users/invite`,
      expect.objectContaining({ method: 'POST' })
    ));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm test -- OrgPortalUsersEditor.test`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/settings/OrgPortalUsersEditor.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';

type PortalUser = {
  id: string; email: string; name: string | null; status: string;
  effectiveStatus: 'active' | 'disabled' | 'pending_setup';
  lastLoginAt: string | null; invitedAt: string | null;
};

const STATUS_LABEL: Record<PortalUser['effectiveStatus'], string> = {
  active: 'Active', disabled: 'Disabled', pending_setup: 'Pending setup'
};

const base = (orgId: string) => `/orgs/organizations/${orgId}/portal-users`;

export default function OrgPortalUsersEditor({ orgId }: { orgId: string }) {
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth(base(orgId));
      if (res.status === 401) { void navigateTo('/login', { replace: true }); return; }
      if (!res.ok) throw new Error(`portal users load failed: ${res.status}`);
      setUsers((await res.json()).data ?? []);
    } catch (err) {
      console.warn('[OrgPortalUsersEditor] load failed', err);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const invite = async () => {
    try {
      await runAction({
        request: () => fetchWithAuth(`${base(orgId)}/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, name: name || undefined, message: message || undefined })
        }),
        errorFallback: 'Failed to send invite',
        successMessage: 'Invite sent',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      setInviteOpen(false); setEmail(''); setName(''); setMessage('');
      await load();
    } catch (err) { if (!(err instanceof ActionError)) throw err; }
  };

  const mutate = async (path: string, method: string, body?: unknown, successMessage?: string) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`${base(orgId)}${path}`, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined
        }),
        errorFallback: 'Action failed',
        successMessage,
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      await load();
    } catch (err) { if (!(err instanceof ActionError)) throw err; }
  };

  const pendingCount = users.filter((u) => u.effectiveStatus === 'pending_setup').length;

  return (
    <section data-testid="portal-users-editor" className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">Portal users</h3>
        <div className="flex gap-2">
          {pendingCount > 0 && (
            <button type="button" data-testid="portal-users-bulk-invite"
              onClick={() => void mutate('/bulk-invite', 'POST', {}, `Invited ${pendingCount} pending user(s)`)}>
              Invite pending ({pendingCount})
            </button>
          )}
          <button type="button" data-testid="portal-users-invite-open" onClick={() => setInviteOpen(true)}>Invite user</button>
        </div>
      </div>

      {loading ? <p>Loading…</p> : (
        <table className="w-full text-sm">
          <thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Last login</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} data-testid={`portal-user-row-${u.id}`}>
                <td>{u.email}</td>
                <td>{u.name ?? '—'}</td>
                <td><span data-testid={`portal-user-status-${u.id}`}>{STATUS_LABEL[u.effectiveStatus]}</span></td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : '—'}</td>
                <td className="flex gap-2">
                  {u.effectiveStatus !== 'active' && (
                    <button type="button" data-testid={`portal-user-resend-${u.id}`}
                      onClick={() => void mutate(`/${u.id}/resend-invite`, 'POST', undefined, 'Invite resent')}>Resend</button>
                  )}
                  {u.effectiveStatus === 'disabled' ? (
                    <button type="button" data-testid={`portal-user-enable-${u.id}`}
                      onClick={() => void mutate(`/${u.id}`, 'PATCH', { status: 'active' }, 'User reactivated')}>Reactivate</button>
                  ) : (
                    <button type="button" data-testid={`portal-user-disable-${u.id}`}
                      onClick={() => void mutate(`/${u.id}`, 'PATCH', { status: 'disabled' }, 'User disabled')}>Disable</button>
                  )}
                  <button type="button" data-testid={`portal-user-delete-${u.id}`}
                    onClick={() => void mutate(`/${u.id}`, 'DELETE', undefined, 'User removed')}>Remove</button>
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={5}>No portal users yet.</td></tr>}
          </tbody>
        </table>
      )}

      {inviteOpen && (
        <div data-testid="portal-users-invite-modal" className="space-y-2">
          <input data-testid="portal-users-invite-email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input data-testid="portal-users-invite-name" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea data-testid="portal-users-invite-message" placeholder="Message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
          <div className="flex gap-2">
            <button type="button" data-testid="portal-users-invite-submit" onClick={() => void invite()}>Send invite</button>
            <button type="button" onClick={() => setInviteOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
```

(Styling classes are minimal placeholders; match sibling `OrgPortalSettingsEditor` styling conventions when wiring. `data-testid` attributes are required for e2e per the repo convention.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm test -- OrgPortalUsersEditor.test`
Expected: PASS (2 tests).

- [ ] **Step 5: Render it in the Portal tab**

In `apps/web/src/components/settings/OrgSettingsPage.tsx`:
Add next to line 24:
```tsx
import OrgPortalUsersEditor from './OrgPortalUsersEditor';
```
Replace the `case 'portal':` return (around line 484) with:
```tsx
    case 'portal':
      return effectiveOrgId ? (
        <>
          <OrgPortalSettingsEditor orgId={effectiveOrgId} onDirty={handleDirty} onSave={() => handleSave()} />
          <OrgPortalUsersEditor orgId={effectiveOrgId} />
        </>
      ) : null;
```

- [ ] **Step 6: Typecheck web + run the settings tests**

Run: `cd apps/web && pnpm test -- OrgPortalUsersEditor.test OrgPortalSettingsEditor.test`
Expected: PASS.
Run: `cd apps/web && pnpm astro check` (or the repo web typecheck)
Expected: no new type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/settings/OrgPortalUsersEditor.tsx apps/web/src/components/settings/OrgPortalUsersEditor.test.tsx apps/web/src/components/settings/OrgSettingsPage.tsx
git commit -m "feat(portal): Portal Users management UI in Org Settings"
```

---

## Task 9: Integration test — RLS + end-to-end invite→accept (real Postgres)

**Files:**
- Test: `apps/api/src/__tests__/integration/portalUserInvite.integration.test.ts` (create)

**Interfaces:**
- Consumes: everything above, against a real DB (see `vitest.integration.config.ts`, port 5433).

- [ ] **Step 1: Write the integration test**

Create `apps/api/src/__tests__/integration/portalUserInvite.integration.test.ts` following the existing integration harness (see a sibling `*.integration.test.ts` for the DB bootstrap/seed + `withSystemDbAccessContext` helpers). Cover:
  - A partner-scoped tech invites `new@acme.example` → a `portal_users` row exists with `status='invited'`, `invited_by` set.
  - The same tech CANNOT list/invite for an org outside their partner (cross-tenant → 404 / RLS blocks the write).
  - Consuming the stored invite token via `POST /portal/auth/accept-invite` flips the row to `status='active'` with a non-null `password_hash`, and a subsequent `POST /portal/auth/login` with that password succeeds.

Model the DB setup and request harness on the nearest existing integration test in that directory (do not invent a new harness). Assert row state with a `withSystemDbAccessContext` select.

- [ ] **Step 2: Run the integration test**

Run: `pnpm test:integration -- portalUserInvite` (real DB on :5433 must be up per `docs` integration setup)
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/portalUserInvite.integration.test.ts
git commit -m "test(portal): integration coverage for invite→accept + RLS isolation"
```

---

## Final verification

- [ ] Run the full API unit suite: `pnpm test --filter=@breeze/api`
- [ ] Run the shared suite: `pnpm test --filter=@breeze/shared`
- [ ] Run the web suite: `cd apps/web && pnpm test`
- [ ] `pnpm db:check-drift` — no drift.
- [ ] Confirm `docs/testing/FEATURE_TEST_LOG.md` is NOT staged in any commit.
- [ ] Open a PR from `feat/portal-customer-onboarding` → `main`; body notes the deploy tie-in: **setting `PUBLIC_PORTAL_URL` on the API is part of the held portal rollout, tracked separately.**

---

## Spec coverage self-check

| Spec requirement | Task |
|---|---|
| `invited_by`/`invited_at`, status model | 1 |
| Invite token (redis+in-memory, 7d), `buildPortalUrl` | 2 |
| `accept-invite` endpoint | 3 |
| forgot-password link fix | 3 |
| Shared validators (invite/bulk/update) | 4 |
| `sendPortalInvite` email | 5 |
| MSP list + invite | 6 |
| MSP patch/resend/bulk-invite/delete (409-when-referenced) | 7 |
| Effective "Pending setup" status | 6 (`effectivePortalStatus`) |
| Web `OrgPortalUsersEditor` in Portal tab, `runAction` | 8 |
| RLS + e2e invite→accept integration | 9 |
| `acceptInviteSchema` location | 2 (portal/schemas.ts, co-located with `resetPasswordSchema` — deviates from spec's "shared validators" listing; local is consistent with the sibling reset schema) |
