# Authenticator Register-Grant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken `currentPassword` step-up on approver-device registration with single-use re-auth grants (`mfaStepUpGrant`), so mobile registers promptlessly at login and the browser registers with one passkey/TOTP/password gesture.

**Architecture:** Extend the existing Redis-backed `mfaStepUpGrant` service with a `'register_approver_device'` operation. Three mint paths: `/auth/mfa/step-up` (passkey/TOTP, browser), a new `POST /authenticator/register-grant` password endpoint (browser fallback, gated to accounts with no stronger factor), and login-time minting (mobile only, gated on the mobile device-id header). The three register routes swap `currentPassword` → `registerGrantId` with unconditional enforcement (validate at options, consume at verify/mobile-POST).

**Tech Stack:** Hono + Zod + Drizzle (API), Vitest everywhere, Redux Toolkit + Expo SecureStore (mobile), React + `@simplewebauthn/browser` + runAction (web).

**Spec:** `docs/superpowers/specs/2026-07-21-authenticator-register-grant-design.md` — read it before starting; it explains every security decision referenced below.

## Global Constraints

- **No DB migrations in this plan.** Nothing touches schema. If you think you need one, re-read the spec.
- **NEVER mint a grant in the `/auth/refresh` handler** (`login.ts:700-932`). A test pins this (Task 5).
- **Do NOT reuse `enforceExistingFactorStepUp`** for the register routes — its `userIsMfaProtected` early-return would let non-MFA users skip the grant entirely. Task 3 builds the unconditional sibling.
- **Grant enforcement is unconditional for ALL users** on all three register routes.
- New web UI strings: every new `t()` key MUST be added to `apps/web/src/locales/<locale>/settings.json` for ALL FIVE locales (`en`, `de-DE`, `es-419`, `fr-FR`, `pt-BR`) — the locale-parity check reds main otherwise.
- Web mutations stay wrapped in `runAction` (already true for `ApproverDevicesSection`; keep it that way).
- Mobile registration remains fail-open: `ensureApproverDevice` never throws, never blocks login.
- Run commands from the repo root unless a `cd` is shown. Node is pinned (see `.nvmrc` / memory: wrong Node → false test failures).

---

### Task 1: Widen the grant `operation` union

**Files:**
- Modify: `apps/api/src/services/mfaStepUpGrant.ts`
- Test: `apps/api/src/services/mfaStepUpGrant.test.ts` (new)

**Interfaces:**
- Produces: `StepUpOperation = 'add_factor' | 'register_approver_device'` (exported type); `StepUpGrant.operation` widened. `mintStepUpGrant` / `validateStepUpGrant` / `consumeStepUpGrant` signatures unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/mfaStepUpGrant.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock, redisStore } = vi.hoisted(() => {
  const redisStore = new Map<string, string>();
  return {
    redisStore,
    redisMock: {
      setex: vi.fn(async (k: string, _ttl: number, v: string) => { redisStore.set(k, v); }),
      get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
      getdel: vi.fn(async (k: string) => {
        const v = redisStore.get(k) ?? null;
        redisStore.delete(k);
        return v;
      }),
    },
  };
});

vi.mock('./redis', () => ({ getRedis: vi.fn(() => redisMock) }));

import { mintStepUpGrant, validateStepUpGrant, consumeStepUpGrant } from './mfaStepUpGrant';

const bind = (operation: 'add_factor' | 'register_approver_device') => ({
  userId: 'user-1',
  operation,
  authEpoch: 1,
  mfaEpoch: 2,
  sid: 'sid-1',
});

describe('mfaStepUpGrant operation isolation', () => {
  beforeEach(() => {
    redisStore.clear();
    vi.clearAllMocks();
  });

  it('mints and consumes a register_approver_device grant', async () => {
    const id = await mintStepUpGrant(bind('register_approver_device'));
    expect(id).toBeTruthy();
    await expect(validateStepUpGrant(id!, bind('register_approver_device'))).resolves.toBe(true);
    await expect(consumeStepUpGrant(id!, bind('register_approver_device'))).resolves.toBe(true);
    // single-use: second consume fails
    await expect(consumeStepUpGrant(id!, bind('register_approver_device'))).resolves.toBe(false);
  });

  it('an add_factor grant can never validate/consume as register_approver_device (and vice versa)', async () => {
    const addFactor = await mintStepUpGrant(bind('add_factor'));
    const register = await mintStepUpGrant(bind('register_approver_device'));
    await expect(validateStepUpGrant(addFactor!, bind('register_approver_device'))).resolves.toBe(false);
    await expect(consumeStepUpGrant(addFactor!, bind('register_approver_device'))).resolves.toBe(false);
    await expect(validateStepUpGrant(register!, bind('add_factor'))).resolves.toBe(false);
    // cross-operation consume must NOT burn the grant: getdel deletes, so assert
    // the register grant was destroyed by the failed add_factor consume attempt
    // ONLY IF the service deletes on mismatch — current behavior: getdel removes
    // the key regardless. Pin current behavior:
    await expect(consumeStepUpGrant(register!, bind('add_factor'))).resolves.toBe(false);
    await expect(validateStepUpGrant(register!, bind('register_approver_device'))).resolves.toBe(false);
  });

  it('validate is non-consuming', async () => {
    const id = await mintStepUpGrant(bind('register_approver_device'));
    await expect(validateStepUpGrant(id!, bind('register_approver_device'))).resolves.toBe(true);
    await expect(validateStepUpGrant(id!, bind('register_approver_device'))).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/services/mfaStepUpGrant.test.ts`
Expected: FAIL — TypeScript rejects `operation: 'register_approver_device'` (not assignable to `'add_factor'`). If vitest doesn't type-check, the mint succeeds but this task's Step 3 is still required for `tsc`; run `pnpm typecheck` in `apps/api` to see the type error.

- [ ] **Step 3: Widen the union**

In `apps/api/src/services/mfaStepUpGrant.ts` replace lines 18-25 with:

```ts
/** Operations a step-up grant can authorize. A grant minted for one operation
 * can never validate/consume for another (bindsMatch checks equality). */
export type StepUpOperation = 'add_factor' | 'register_approver_device';

export interface StepUpGrant {
  id: string;
  userId: string;
  operation: StepUpOperation;
  authEpoch: number;
  mfaEpoch: number;
  sid: string;
}
```

Also update the doc comment above the interface (lines 4-17) to mention the second operation and its consumers (the `/authenticator` register routes).

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/api && pnpm vitest run src/services/mfaStepUpGrant.test.ts && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/mfaStepUpGrant.ts apps/api/src/services/mfaStepUpGrant.test.ts
git commit -m "feat(auth): add register_approver_device step-up grant operation (#2707)"
```

---

### Task 2: `/auth/mfa/step-up` accepts an `operation` field

**Files:**
- Modify: `apps/api/src/routes/auth/schemas.ts:119-125`
- Modify: `apps/api/src/routes/auth/mfa.ts:721-816` (the `POST /mfa/step-up` handler)
- Test: `apps/api/src/routes/auth/schemas.test.ts` (extend)

**Interfaces:**
- Consumes: `StepUpOperation` from Task 1.
- Produces: `mfaStepUpSchema` branches each carry `operation: z.enum(['add_factor','register_approver_device']).default('add_factor')`. The step-up endpoint mints a grant with the REQUESTED operation and still returns `{ stepUpGrantId }`.

- [ ] **Step 1: Write the failing schema tests**

Append to `apps/api/src/routes/auth/schemas.test.ts` (mirror its existing describe style):

```ts
describe('mfaStepUpSchema operation field', () => {
  it('defaults operation to add_factor on every branch', () => {
    const totp = mfaStepUpSchema.parse({ method: 'totp', code: '123456' });
    expect(totp.operation).toBe('add_factor');
    const passkey = mfaStepUpSchema.parse({ method: 'passkey', credential: { id: 'cred-1' } });
    expect(passkey.operation).toBe('add_factor');
  });

  it('accepts register_approver_device', () => {
    const parsed = mfaStepUpSchema.parse({
      method: 'totp',
      code: '123456',
      operation: 'register_approver_device',
    });
    expect(parsed.operation).toBe('register_approver_device');
  });

  it('rejects unknown operations', () => {
    expect(() =>
      mfaStepUpSchema.parse({ method: 'totp', code: '123456', operation: 'admin_takeover' })
    ).toThrow();
  });
});
```

(Add `mfaStepUpSchema` to the file's imports from `./schemas` if not already imported.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && pnpm vitest run src/routes/auth/schemas.test.ts`
Expected: FAIL — `operation` is `undefined` / unknown key.

- [ ] **Step 3: Extend the schema**

In `apps/api/src/routes/auth/schemas.ts`, replace lines 119-125. **You cannot `.extend()` a `z.discriminatedUnion`** — add the field to each branch:

```ts
const stepUpSixDigit = z.string().refine((v) => /^\d{6}$/.test(v.trim()), { message: 'Invalid code' });
const stepUpAssertion = z.object({ id: z.string().min(1) }).passthrough();
// Which grant the proven factor mints. Defaults to the original add_factor so
// existing clients are untouched; register_approver_device gates the
// /authenticator register routes (#2707).
const stepUpOperation = z
  .enum(['add_factor', 'register_approver_device'])
  .default('add_factor');
export const mfaStepUpSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('totp'), code: stepUpSixDigit, operation: stepUpOperation }),
  z.object({ method: z.literal('sms'), code: stepUpSixDigit, operation: stepUpOperation }),
  z.object({ method: z.literal('passkey'), credential: stepUpAssertion, operation: stepUpOperation }),
]);
```

- [ ] **Step 4: Thread `operation` through the handler**

In `apps/api/src/routes/auth/mfa.ts`, in the `POST /mfa/step-up` handler:

At line 796-802, replace the hardcoded operation:

```ts
  const grantId = await mintStepUpGrant({
    userId: auth.user.id,
    operation: body.operation,
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid: auth.token.sid
  });
```

At line 807-814, the success audit already records `operation: 'add_factor'` — change to `operation: body.operation`. Also update the SR2-20 doc comment above the route (lines 713-720) to mention the second operation.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd apps/api && pnpm vitest run src/routes/auth/schemas.test.ts && pnpm typecheck`
Expected: PASS / clean. (`body.operation` is always defined thanks to the zod default, so no `??` needed — the type is `'add_factor' | 'register_approver_device'`.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/auth/schemas.ts apps/api/src/routes/auth/schemas.test.ts apps/api/src/routes/auth/mfa.ts
git commit -m "feat(auth): mfa step-up mints operation-scoped grants (#2707)"
```

---

### Task 3: Unconditional register-grant enforcement + stronger-factor predicate (helpers)

**Files:**
- Modify: `apps/api/src/routes/auth/helpers.ts` (add two exports next to `enforceExistingFactorStepUp`, ~line 314)
- Test: `apps/api/src/routes/auth/helpers.registerStepUp.test.ts` (new; mirror the mock harness of `apps/api/src/routes/auth/helpers.mfaStepUp.test.ts`)

**Interfaces:**
- Consumes: `validateStepUpGrant`, `consumeStepUpGrant` (Task 1), `getUserEpochs` (from `../../services`).
- Produces:
  - `enforceApproverRegisterStepUp(c: Context, auth: AuthContext, grantId: string | undefined, opts: { consume: boolean }): Promise<Response | null>` — 403 `{ error: 'register_step_up_required' }` on bad/missing grant, 503 on missing sid/epochs, null to proceed. **NO MFA-protected bypass.**
  - `userHasStrongerReauthFactor(userId: string): Promise<boolean>` — true when the account has TOTP MFA or ≥1 active passkey (NOT SMS — SMS users keep the password path, see spec).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/auth/helpers.registerStepUp.test.ts`. Open `helpers.mfaStepUp.test.ts` first and copy its `vi.hoisted`/`vi.mock` harness for `../../db`, `../../services` (getUserEpochs, redis), and `../../services/mfaStepUpGrant` — then add these cases:

```ts
describe('enforceApproverRegisterStepUp', () => {
  it('403s a NON-MFA-protected user with no grant (no bypass — the spec pin)', async () => {
    // arrange: userIsMfaProtected-style state irrelevant — helper must not consult it.
    grantMocks.validateStepUpGrant.mockResolvedValue(false);
    epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
    const res = await enforceApproverRegisterStepUp(ctx(), authCtx({ sid: 'sid-1' }), undefined, { consume: false });
    expect(res?.status).toBe(403);
    expect(await res!.json()).toEqual({ error: 'register_step_up_required' });
  });

  it('503s when sid or epochs are missing', async () => {
    epochsMock.getUserEpochs.mockResolvedValue(null);
    const res = await enforceApproverRegisterStepUp(ctx(), authCtx({ sid: 'sid-1' }), 'g-1', { consume: false });
    expect(res?.status).toBe(503);
  });

  it('validates without consuming at the options phase', async () => {
    epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 2 });
    grantMocks.validateStepUpGrant.mockResolvedValue(true);
    const res = await enforceApproverRegisterStepUp(ctx(), authCtx({ sid: 'sid-1' }), 'g-1', { consume: false });
    expect(res).toBeNull();
    expect(grantMocks.validateStepUpGrant).toHaveBeenCalledWith('g-1', {
      userId: 'user-1',
      operation: 'register_approver_device',
      authEpoch: 1,
      mfaEpoch: 2,
      sid: 'sid-1',
    });
    expect(grantMocks.consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('consumes at the terminal phase', async () => {
    epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 2 });
    grantMocks.consumeStepUpGrant.mockResolvedValue(true);
    const res = await enforceApproverRegisterStepUp(ctx(), authCtx({ sid: 'sid-1' }), 'g-1', { consume: true });
    expect(res).toBeNull();
    expect(grantMocks.consumeStepUpGrant).toHaveBeenCalledTimes(1);
  });
});

describe('userHasStrongerReauthFactor', () => {
  it.each([
    [{ mfaEnabled: true, mfaMethod: 'totp', passkeyCount: 0 }, true],
    [{ mfaEnabled: true, mfaMethod: 'sms', passkeyCount: 0 }, false],  // SMS keeps password path
    [{ mfaEnabled: false, mfaMethod: null, passkeyCount: 1 }, true],
    [{ mfaEnabled: false, mfaMethod: null, passkeyCount: 0 }, false],
  ])('%o → %s', async (row, expected) => {
    dbState.selectQueue.push([row]);
    await expect(userHasStrongerReauthFactor('user-1')).resolves.toBe(expected);
  });
});
```

(`ctx()` / `authCtx()` / `grantMocks` / `epochsMock` / `dbState`: reuse the exact fixture names the sibling `helpers.mfaStepUp.test.ts` harness defines; rename these references to match if they differ.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && pnpm vitest run src/routes/auth/helpers.registerStepUp.test.ts`
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Implement in `helpers.ts`**

Add after `enforceExistingFactorStepUp` (after line 313):

```ts
/**
 * True when the account holds a re-auth factor STRONGER than a password that
 * the browser register UI can actually exercise: TOTP MFA or an active
 * passkey. Deliberately excludes SMS (no authenticated step-up SMS sender
 * exists; SMS-method users use the password path — see the #2707 spec).
 * Gates POST /authenticator/register-grant: password re-auth is refused when
 * this returns true, keeping the server tiering identical to the UI tiering.
 */
export async function userHasStrongerReauthFactor(userId: string): Promise<boolean> {
  const [row] = await runWithSystemDbAccess(() =>
    db
      .select({
        mfaEnabled: users.mfaEnabled,
        mfaMethod: users.mfaMethod,
        passkeyCount: sql<number>`(SELECT COUNT(*)::int FROM user_passkeys WHERE user_id = ${userId} AND disabled_at IS NULL)`,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  );
  return (row?.mfaEnabled === true && row?.mfaMethod === 'totp') || Number(row?.passkeyCount ?? 0) > 0;
}

/**
 * #2707: enforce a register_approver_device grant on the approver-device
 * registration routes. Same two-phase validate/consume contract as
 * `enforceExistingFactorStepUp` above, with one CRITICAL difference: NO
 * `userIsMfaProtected` bypass. Registration is deferred-proof-of-possession —
 * a stolen bearer token must never be able to register an approver key, so
 * the grant is required for EVERY account, MFA-protected or not.
 */
export async function enforceApproverRegisterStepUp(
  c: Context,
  auth: AuthContext,
  grantId: string | undefined,
  opts: { consume: boolean },
): Promise<Response | null> {
  const epochs = await getUserEpochs(auth.user.id);
  if (!epochs || !auth.token.sid) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const bind = {
    userId: auth.user.id,
    operation: 'register_approver_device' as const,
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid: auth.token.sid,
  };

  const ok = grantId
    ? (opts.consume ? await consumeStepUpGrant(grantId, bind) : await validateStepUpGrant(grantId, bind))
    : false;

  if (!ok) {
    return c.json({ error: 'register_step_up_required' }, 403);
  }
  return null;
}
```

All imports (`runWithSystemDbAccess`, `sql`, `users`, `getUserEpochs`, `validateStepUpGrant`, `consumeStepUpGrant`, `Context`, `AuthContext`) already exist in `helpers.ts` for the sibling functions — verify with the file's import block, add any missing.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/api && pnpm vitest run src/routes/auth/helpers.registerStepUp.test.ts && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/helpers.ts apps/api/src/routes/auth/helpers.registerStepUp.test.ts
git commit -m "feat(auth): unconditional approver-register step-up enforcement (#2707)"
```

---

### Task 4: Swap the three register routes to grants + `POST /authenticator/register-grant`

**Files:**
- Modify: `apps/api/src/routes/authenticator.ts:28-270`
- Test: `apps/api/src/routes/authenticator.test.ts` (extend; harness already mocks `./auth/helpers` wholesale — add the two new helper mocks there)

**Interfaces:**
- Consumes: `enforceApproverRegisterStepUp`, `userHasStrongerReauthFactor`, `requireCurrentPasswordStepUp` (helpers); `mintStepUpGrant` (service); `getUserEpochs` (from `../services`).
- Produces (wire contract — web/mobile tasks depend on these exact shapes):
  - `POST /authenticator/register-grant` body `{ currentPassword: string }` → 200 `{ registerGrantId: string }` | 403 `{ error: 'stronger_factor_required' }` | 401/429/503.
  - `POST /authenticator/devices/webauthn/options` body `{ registerGrantId: string }` (validate, non-consuming).
  - `POST /authenticator/devices/webauthn/verify` body `{ registerGrantId: string, response, label? }` (consume).
  - `POST /authenticator/devices` body `{ registerGrantId: string, publicKey: string, label: string }` (consume) — `currentPassword`/`kind`/`isPlatformBound` no longer read.

- [ ] **Step 1: Write the failing route tests**

In `apps/api/src/routes/authenticator.test.ts`: extend the hoisted `helperMocks` (line 52-55) with the new helpers and mock the grant service:

```ts
    helperMocks: {
      requireCurrentPasswordStepUp: vi.fn(),
      writeAuthAudit: vi.fn(),
      enforceApproverRegisterStepUp: vi.fn(),
      userHasStrongerReauthFactor: vi.fn(),
    },
    grantMocks: {
      mintStepUpGrant: vi.fn(),
    },
    epochsMock: {
      getUserEpochs: vi.fn(),
    },
```

Add alongside the existing `vi.mock` calls:

```ts
vi.mock('../services/mfaStepUpGrant', () => ({ ...grantMocks }));
```

and extend the existing `vi.mock('../services', ...)` factory with `getUserEpochs: epochsMock.getUserEpochs` (keep `getRedis`).

New test cases (adapt request-building style from the file's existing tests — it mounts `authenticatorRoutes` on a `Hono` app and fires `app.request(...)`):

```ts
describe('POST /register-grant', () => {
  it('mints a grant after password step-up when no stronger factor exists', async () => {
    helperMocks.userHasStrongerReauthFactor.mockResolvedValue(false);
    helperMocks.requireCurrentPasswordStepUp.mockResolvedValue(null);
    epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 2 });
    grantMocks.mintStepUpGrant.mockResolvedValue('grant-uuid');

    const res = await postJson('/register-grant', { currentPassword: 'hunter2!' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registerGrantId: 'grant-uuid' });
    expect(grantMocks.mintStepUpGrant).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'register_approver_device' })
    );
  });

  it('403 stronger_factor_required when the account has TOTP or a passkey', async () => {
    helperMocks.userHasStrongerReauthFactor.mockResolvedValue(true);
    const res = await postJson('/register-grant', { currentPassword: 'hunter2!' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'stronger_factor_required' });
    expect(helperMocks.requireCurrentPasswordStepUp).not.toHaveBeenCalled();
  });

  it('propagates password step-up failures (401/429/503)', async () => {
    helperMocks.userHasStrongerReauthFactor.mockResolvedValue(false);
    helperMocks.requireCurrentPasswordStepUp.mockImplementation(async (c: any) =>
      c.json({ error: 'Invalid credentials' }, 401)
    );
    const res = await postJson('/register-grant', { currentPassword: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('503 when sid/epochs unavailable', async () => {
    helperMocks.userHasStrongerReauthFactor.mockResolvedValue(false);
    helperMocks.requireCurrentPasswordStepUp.mockResolvedValue(null);
    epochsMock.getUserEpochs.mockResolvedValue(null);
    const res = await postJson('/register-grant', { currentPassword: 'hunter2!' });
    expect(res.status).toBe(503);
  });
});

describe('register routes take registerGrantId', () => {
  it('options validates (consume:false); verify consumes (consume:true)', async () => {
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValue(null);
    approverMocks.generateApproverRegistrationOptions.mockResolvedValue({ challenge: 'c' });
    await postJson('/devices/webauthn/options', { registerGrantId: 'g-1' });
    expect(helperMocks.enforceApproverRegisterStepUp).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), 'g-1', { consume: false }
    );

    approverMocks.verifyApproverRegistration.mockResolvedValue({
      publicKey: 'pk', credentialId: 'cid', counter: 0, aaguid: null, transports: null, isPlatformBound: true,
    });
    dbState.insertReturning = [{ id: 'dev-1', label: 'x', kind: 'webauthn_platform', isPlatformBound: true, transports: [] }];
    await postJson('/devices/webauthn/verify', { registerGrantId: 'g-1', response: { id: 'att' } });
    expect(helperMocks.enforceApproverRegisterStepUp).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), 'g-1', { consume: true }
    );
  });

  it('mobile POST /devices consumes the grant and no longer reads currentPassword', async () => {
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValue(null);
    dbState.insertReturning = [{ id: 'dev-2', label: 'This device', kind: 'mobile_hw_key', isPlatformBound: true, transports: [] }];
    const res = await postJson('/devices', { registerGrantId: 'g-2', publicKey: 'SPKI', label: 'This device' });
    expect(res.status).toBe(200);
    expect(helperMocks.enforceApproverRegisterStepUp).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), 'g-2', { consume: true }
    );
    expect(helperMocks.requireCurrentPasswordStepUp).not.toHaveBeenCalled();
  });

  it('403s all three routes when enforcement rejects — including a missing grant', async () => {
    helperMocks.enforceApproverRegisterStepUp.mockImplementation(async (c: any) =>
      c.json({ error: 'register_step_up_required' }, 403)
    );
    for (const [path, body] of [
      ['/devices/webauthn/options', {}],
      ['/devices/webauthn/verify', { response: { id: 'att' } }],
      ['/devices', { publicKey: 'SPKI', label: 'x' }],
    ] as const) {
      const res = await postJson(path, body);
      expect(res.status, path).toBe(403);
    }
  });
});
```

(`postJson` = whatever request helper the file already uses; reuse it. If the file's existing `currentPassword`-era tests now contradict the new contract, UPDATE them in this step — they encode the old broken behavior.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && pnpm vitest run src/routes/authenticator.test.ts`
Expected: FAIL — routes still demand `currentPassword`, `/register-grant` 404s.

- [ ] **Step 3: Implement the route changes**

In `apps/api/src/routes/authenticator.ts`:

1. Imports: add `enforceApproverRegisterStepUp, userHasStrongerReauthFactor` to the `./auth/helpers` import; add `import { mintStepUpGrant } from '../services/mfaStepUpGrant';` and `import { getUserEpochs } from '../services';`.

2. Replace the schemas (lines 30-58):

```ts
const registerGrantIdSchema = z.string().min(1).max(128);

const registerOptionsSchema = z.object({
  registerGrantId: registerGrantIdSchema,
});
const registerVerifySchema = z.object({
  registerGrantId: registerGrantIdSchema,
  response: attestationResponseSchema,
  label: deviceLabelSchema.optional(),
});
const registerGrantMintSchema = z.object({
  currentPassword: z.string().min(1).max(256),
});
// Mobile hardware-key registration — requires a register_approver_device grant
// (minted at login, returned as authenticatorRegisterGrantId). The old
// client-asserted kind/isPlatformBound discriminators are ignored entirely; the
// server forces kind='mobile_hw_key' and is_platform_bound=true. publicKey +
// label are re-validated through the shared mobileHwKeyRegisterSchema
// (`.strict()`) before insert; registerGrantId is stripped prior to that parse.
const mobileRegisterSchema = z
  .object({
    registerGrantId: registerGrantIdSchema,
  })
  .passthrough();
```

3. New mint endpoint — insert before the `/devices/webauthn/options` route:

```ts
// #2707: password-fallback grant mint for the browser register flow. Gated:
// accounts holding a stronger factor (TOTP or a passkey) must mint via
// POST /auth/mfa/step-up instead — otherwise a stolen session + phished
// password could register an approver key on an MFA-protected account.
authenticatorRoutes.post(
  '/register-grant',
  authMiddleware,
  zValidator('json', registerGrantMintSchema),
  async (c) => {
    const auth = c.get('auth');
    const { currentPassword } = c.req.valid('json');

    if (await userHasStrongerReauthFactor(auth.user.id)) {
      return c.json({ error: 'stronger_factor_required' }, 403);
    }

    const passwordError = await requireCurrentPasswordStepUp(
      c,
      auth.user.id,
      currentPassword,
      'authenticator:pwd'
    );
    if (passwordError) return passwordError;

    const epochs = await getUserEpochs(auth.user.id);
    if (!epochs || !auth.token.sid) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    const registerGrantId = await mintStepUpGrant({
      userId: auth.user.id,
      operation: 'register_approver_device',
      authEpoch: epochs.authEpoch,
      mfaEpoch: epochs.mfaEpoch,
      sid: auth.token.sid,
    });
    if (!registerGrantId) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }

    writeAuthAudit(c, {
      orgId: auth.orgId ?? undefined,
      action: 'auth.authenticator.register_grant.minted',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { method: 'password' },
    });

    return c.json({ registerGrantId });
  }
);
```

4. `/devices/webauthn/options` (lines 113-125): replace the password block with:

```ts
    const auth = c.get('auth');
    const { registerGrantId } = c.req.valid('json');

    // Non-consuming validate — the SAME grant is consumed at /verify. A
    // missing/expired/mismatched grant 403s before any challenge is issued.
    const grantError = await enforceApproverRegisterStepUp(c, auth, registerGrantId, { consume: false });
    if (grantError) return grantError;
```

5. `/devices/webauthn/verify` (line 147-149): after reading the body, consume:

```ts
    const auth = c.get('auth');
    const { registerGrantId, response, label } = c.req.valid('json');

    // Terminal write — consume the grant (single-use, closes the previously
    // unguarded verify step: pre-#2707 this route had NO step-up at all).
    const grantError = await enforceApproverRegisterStepUp(c, auth, registerGrantId, { consume: true });
    if (grantError) return grantError;
```

6. Mobile `POST /devices` (lines 205-233): replace the password block with grant consumption and keep the strict re-parse:

```ts
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const grantError = await enforceApproverRegisterStepUp(c, auth, body.registerGrantId, { consume: true });
    if (grantError) return grantError;

    const parsed = mobileHwKeyRegisterSchema.safeParse({
      publicKey: (body as { publicKey?: unknown }).publicKey,
      label: (body as { label?: unknown }).label,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid_registration', detail: parsed.error.issues }, 400);
    }
    const { publicKey, label } = parsed.data;
```

Update the route doc comments (lines 38-51, 192-200): registration is now grant-gated; the grant is minted at login (mobile) or `/register-grant` / `/auth/mfa/step-up` (browser).

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/api && pnpm vitest run src/routes/authenticator.test.ts && pnpm typecheck`
Expected: PASS / clean. Fix any pre-existing tests still sending `currentPassword`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/authenticator.ts apps/api/src/routes/authenticator.test.ts
git commit -m "feat(auth): approver-device registration takes register grants, adds register-grant mint endpoint (#2707)"
```

---

### Task 5: Login-time mint (mobile only) — login.ts + mfa.ts, never refresh

**Files:**
- Modify: `apps/api/src/routes/auth/helpers.ts` (one small helper)
- Modify: `apps/api/src/routes/auth/login.ts` (no-MFA success, ~line 604-631 — NOT the `/refresh` handler at :700+)
- Modify: `apps/api/src/routes/auth/mfa.ts` (`/mfa/verify` success, ~line 358-379)
- Modify: `apps/api/src/openapi.ts:121` area (document the optional field; note `LoginResponse` is `$ref`'d by `/auth/register` too — add a description saying only login/mfa-verify return it)
- Test: `apps/api/src/routes/auth/login.test.ts` (extend)

**Interfaces:**
- Consumes: `mintStepUpGrant` (Task 1), `readMobileDeviceId` (`../../services/mobileDeviceBinding`), `getUserEpochs`.
- Produces: `mintLoginRegisterGrant(c: Context, userId: string, sid: string): Promise<string | null>` in helpers.ts; login + mfa-verify responses gain optional `authenticatorRegisterGrantId: string` **only when the mobile device-id header is present**.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/routes/auth/login.test.ts`, add (mirror the file's existing successful-login fixture; it already fabricates a login that reaches the 200 response — reuse that setup; the mobile header is `X-Breeze-Mobile-Device-Id`, read via the already-mocked-or-real `readMobileDeviceId`):

```ts
describe('authenticatorRegisterGrantId login mint (#2707)', () => {
  it('successful login WITH the mobile device-id header includes the grant', async () => {
    grantMocks.mintStepUpGrant.mockResolvedValue('login-grant-1');
    const res = await successfulLoginRequest({ headers: { 'X-Breeze-Mobile-Device-Id': 'install-1' } });
    expect(res.status).toBe(200);
    expect((await res.json()).authenticatorRegisterGrantId).toBe('login-grant-1');
    expect(grantMocks.mintStepUpGrant).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'register_approver_device' })
    );
  });

  it('successful login WITHOUT the header omits the field entirely (web never gets a grant)', async () => {
    const res = await successfulLoginRequest();
    const body = await res.json();
    expect(body).not.toHaveProperty('authenticatorRegisterGrantId');
    expect(grantMocks.mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('a mint failure (Redis down) still returns tokens', async () => {
    grantMocks.mintStepUpGrant.mockResolvedValue(null);
    const res = await successfulLoginRequest({ headers: { 'X-Breeze-Mobile-Device-Id': 'install-1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('authenticatorRegisterGrantId');
  });

  it('POST /auth/refresh NEVER includes the field, even with the mobile header', async () => {
    grantMocks.mintStepUpGrant.mockResolvedValue('should-never-appear');
    const res = await successfulRefreshRequest({ headers: { 'X-Breeze-Mobile-Device-Id': 'install-1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('authenticatorRegisterGrantId');
  });
});
```

`successfulLoginRequest` / `successfulRefreshRequest`: build from the file's existing happy-path login and refresh tests (both exist — the refresh handler is tested in this file). Add `grantMocks` via `vi.mock('../../services/mfaStepUpGrant', ...)` in the hoisted block, following the file's existing mock style.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && pnpm vitest run src/routes/auth/login.test.ts`
Expected: New tests FAIL (field absent when expected present).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/auth/helpers.ts`, after `enforceApproverRegisterStepUp` (Task 3):

```ts
/**
 * #2707: best-effort login-time mint of a register_approver_device grant,
 * returned to the MOBILE client as `authenticatorRegisterGrantId` so the app
 * can register its approver key promptlessly right after login.
 *
 * Gated on the mobile device-id header: web logins hit the same endpoints and
 * must NEVER receive a live register grant (300s XSS-readable window for a
 * grant the page can't use). Returns null on any failure — login must not
 * break because Redis is down; the phone simply registers on a later login.
 *
 * NEVER call this from the /auth/refresh handler: a stolen refresh token
 * would then mint a fresh register grant on every rotation, defeating the
 * stolen-session protection the grant exists to provide.
 */
export async function mintLoginRegisterGrant(
  c: Context,
  userId: string,
  sid: string
): Promise<string | null> {
  if (!readMobileDeviceId(c)) return null;
  const epochs = await getUserEpochs(userId);
  if (!epochs) return null;
  return mintStepUpGrant({
    userId,
    operation: 'register_approver_device',
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid,
  });
}
```

Add `readMobileDeviceId` and `mintStepUpGrant` to helpers.ts imports (`../../services/mobileDeviceBinding`, `../../services/mfaStepUpGrant`).

In `apps/api/src/routes/auth/login.ts`, just before the success response (after `await floorPromise;`, line 613):

```ts
  const authenticatorRegisterGrantId = await mintLoginRegisterGrant(c, user.id, familyId);
```

and in the response object (line 614-631) add:

```ts
    ...(authenticatorRegisterGrantId ? { authenticatorRegisterGrantId } : {}),
```

In `apps/api/src/routes/auth/mfa.ts`, before the `/mfa/verify` success response (line 364):

```ts
    const authenticatorRegisterGrantId = await mintLoginRegisterGrant(c, user.id, mfaFamilyId);
```

and add the same spread to the response object (lines 364-379). Import `mintLoginRegisterGrant` from `./helpers` in both files.

**Do NOT touch the `/auth/refresh` handler (`login.ts:700-932`).**

In `apps/api/src/openapi.ts` around line 121, add to the `LoginResponse` schema properties:

```ts
        authenticatorRegisterGrantId: {
          type: 'string',
          description:
            'Single-use 300s grant for registering this device as an approver. Only returned on POST /auth/login and /auth/mfa/verify to clients sending X-Breeze-Mobile-Device-Id; never on /auth/register or /auth/refresh.',
        },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/api && pnpm vitest run src/routes/auth/login.test.ts && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/helpers.ts apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/mfa.ts apps/api/src/openapi.ts apps/api/src/routes/auth/login.test.ts
git commit -m "feat(auth): mint mobile approver register grant at login, never on refresh (#2707)"
```

---

### Task 6: `GET /users/me` exposes `mfaMethod`

**Files:**
- Modify: `apps/api/src/routes/users.ts:313-331`
- Test: whichever sibling test file covers `GET /users/me` (run `grep -rln "'/me'" apps/api/src/routes/users*.test.ts` — extend it; if none covers /me, add the case to `apps/api/src/routes/users.test.ts`)

**Interfaces:**
- Produces: `/users/me` response gains `mfaMethod: 'totp' | 'sms' | 'passkey' | null`. Web Task 9 consumes it.

- [ ] **Step 1: Failing test** — assert the /me payload includes `mfaMethod` when the user row has `mfaMethod: 'totp'` (mirror the existing /me test's row fixture and add the field).

```ts
it('includes mfaMethod so the web can pick the register re-auth tier (#2707)', async () => {
  dbState.selectQueue.push([{ id: 'user-1', email: 't@x.io', name: 'T', mfaEnabled: true, mfaMethod: 'totp' }]);
  const res = await getMe();
  expect((await res.json()).mfaMethod).toBe('totp');
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && pnpm vitest run <that test file>` → FAIL (`mfaMethod` undefined).

- [ ] **Step 3: Implement** — in the `/me` select (users.ts line 314-331) add after `mfaEnabled`:

```ts
      // #2707: lets the profile UI pick the approver-register re-auth tier
      // (passkey → TOTP code → password) without a second endpoint.
      mfaMethod: users.mfaMethod,
```

- [ ] **Step 4: Run tests + typecheck** — PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/users.ts apps/api/src/routes/users*.test.ts
git commit -m "feat(users): expose mfaMethod on GET /users/me (#2707)"
```

---

### Task 7: Mobile — `ensureApproverDevice` takes a grant, `deferred` outcome, single-flight

**Files:**
- Modify: `apps/mobile/src/services/approverDevice.ts:57-112`
- Test: `apps/mobile/src/services/approverDevice.test.ts` (extend; harness shown at its top already mocks SecureStore/fetch/signer)

**Interfaces:**
- Produces:
  - `ApproverRegistrationOutcome` gains `| { status: 'deferred'; reason: 'no_reauth_grant' }`.
  - `ensureApproverDevice(signer?: HardwareSigner, registerGrant?: string): Promise<ApproverRegistrationOutcome>` — POSTs `{ publicKey, label, registerGrantId }` (no `kind`, no `isPlatformBound`), only when a grant is present; module-level single-flight so concurrent calls share one attempt.

- [ ] **Step 1: Write the failing tests**

Extend `approverDevice.test.ts` (reuse `fakeSigner`, `json`, `secureStore`, `fetchMock` fixtures):

```ts
it('returns deferred and does NOT POST when no grant is available', async () => {
  const signer = fakeSigner();
  secureStore.getItemAsync.mockImplementation(async (k: string) =>
    k === 'breeze_approver_credential_id' ? null : 'test-token',
  );
  await expect(ensureApproverDevice(signer)).resolves.toEqual({
    status: 'deferred',
    reason: 'no_reauth_grant',
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(signer.createKeys).not.toHaveBeenCalled();
});

it('POSTs registerGrantId (and neither kind nor isPlatformBound) when a grant is provided', async () => {
  const signer = fakeSigner();
  secureStore.getItemAsync.mockImplementation(async (k: string) =>
    k === 'breeze_approver_credential_id' ? null : 'test-token',
  );
  fetchMock.mockResolvedValueOnce(json({ device: { id: 'dev-1' } }));
  await expect(ensureApproverDevice(signer, 'grant-1')).resolves.toEqual({ status: 'registered' });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toMatchObject({ registerGrantId: 'grant-1', publicKey: 'SPKI-PUBKEY-B64', label: 'This device' });
  expect(body).not.toHaveProperty('kind');
  expect(body).not.toHaveProperty('isPlatformBound');
  expect(body).not.toHaveProperty('currentPassword');
});

it('concurrent calls share one in-flight attempt (single POST, one grant burn)', async () => {
  const signer = fakeSigner();
  secureStore.getItemAsync.mockImplementation(async (k: string) =>
    k === 'breeze_approver_credential_id' ? null : 'test-token',
  );
  let release!: (v: unknown) => void;
  fetchMock.mockReturnValueOnce(new Promise((r) => { release = r; }));
  const first = ensureApproverDevice(signer, 'grant-1');
  const second = ensureApproverDevice(signer, 'grant-1');
  release(json({ device: { id: 'dev-1' } }));
  await expect(first).resolves.toEqual({ status: 'registered' });
  await expect(second).resolves.toEqual({ status: 'registered' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
```

Also UPDATE the existing "mints + registers" test (line 63-80): it currently asserts the old body shape — pass a grant and assert the new shape (its `not.toHaveProperty('currentPassword')` assertion stays).

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mobile && pnpm vitest run src/services/approverDevice.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `approverDevice.ts`, replace the outcome type and `ensureApproverDevice` (lines 57-112):

```ts
export type ApproverRegistrationOutcome =
  | { status: 'registered' }
  | { status: 'already_registered' }
  | { status: 'deferred'; reason: 'no_reauth_grant' }
  | { status: 'unsupported'; reason: 'no_hardware' }
  | { status: 'failed'; reason: string };

// Single-flight: RootNavigator's effect can re-fire while a registration is in
// flight (checkAuth double-dispatches setCredentials on cold start). The grant
// is single-use, so a duplicate attempt would burn a consumed grant into a 403
// and overwrite a successful outcome. Concurrent callers share one attempt.
let inFlight: Promise<ApproverRegistrationOutcome> | null = null;

/**
 * Idempotent: ensure this phone has a registered approver key. Called after
 * auth lands. FAILS OPEN — never throws, never blocks login.
 *
 * #2707: registration requires a `register_approver_device` grant minted at
 * login (`authenticatorRegisterGrantId` in the login/mfa-verify response) —
 * proof of a fresh interactive login, independent of the bearer token. With no
 * grant (cold-start restored session) there is nothing to prove with: return
 * `deferred` WITHOUT touching the network; the device registers on the next
 * real login. The #2683 banner surfaces this state with actionable copy.
 */
export async function ensureApproverDevice(
  signer: HardwareSigner = getHardwareSigner(),
  registerGrant?: string,
): Promise<ApproverRegistrationOutcome> {
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<ApproverRegistrationOutcome> => {
    try {
      if (await SecureStore.getItemAsync(CRED_ID_KEY)) {
        return { status: 'already_registered' };
      }
      if (!(await signer.isAvailable())) {
        return { status: 'unsupported', reason: 'no_hardware' };
      }
      if (!registerGrant) {
        return { status: 'deferred', reason: 'no_reauth_grant' };
      }
      const { publicKey } = await signer.createKeys();              // silent, no biometric
      const res = await authedFetch('/api/v1/authenticator/devices', {
        method: 'POST',
        body: JSON.stringify({
          publicKey,
          label: 'This device',
          registerGrantId: registerGrant,
        }),
      });
      if (!res.ok) {
        return { status: 'failed', reason: `http_${res.status}` };
      }
      const { device } = await res.json();
      if (!device?.id) {
        return { status: 'failed', reason: 'missing_device_id' };
      }
      await SecureStore.setItemAsync(CRED_ID_KEY, device.id);
      return { status: 'registered' };
    } catch {
      return { status: 'failed', reason: 'exception' };
    }
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
```

Update the file-header doc comment (lines 9-14): registration now happens at login **using the login-minted grant**.

- [ ] **Step 4: Run tests**

Run: `cd apps/mobile && pnpm vitest run src/services/approverDevice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/services/approverDevice.ts apps/mobile/src/services/approverDevice.test.ts
git commit -m "feat(mobile): approver registration uses login grant, deferred outcome, single-flight (#2707)"
```

---

### Task 8: Mobile — capture the grant (api.ts → authSlice → RootNavigator → banner)

**Files:**
- Modify: `apps/mobile/src/services/api.ts:91-106, 315-355`
- Modify: `apps/mobile/src/store/authSlice.ts`
- Modify: `apps/mobile/src/navigation/RootNavigator.tsx:96-111`
- Modify: `apps/mobile/src/navigation/ApprovalGate.tsx:71-86` (+ a new banner component in that file, cloned from `ApproverFailedBanner`)
- Test: `apps/mobile/src/store/authSlice.test.ts` (extend)

**Interfaces:**
- Consumes: `ensureApproverDevice(signer?, registerGrant?)` + `'deferred'` outcome (Task 7); `authenticatorRegisterGrantId` in login/mfa-verify responses (Task 5).
- Produces:
  - `LoginResult` success variant and `LoginResponse` gain `registerGrant: string | null`.
  - `AuthState.authenticatorRegisterGrantId: string | null`; action `clearAuthenticatorRegisterGrant()`.
  - `ApproverRegistrationStatus` gains `'deferred'`.

- [ ] **Step 1: Write the failing slice tests**

Extend `apps/mobile/src/store/authSlice.test.ts` (mirror its existing reducer-test style):

```ts
it('loginAsync.fulfilled stores the register grant; clearAuthenticatorRegisterGrant drops it', () => {
  let state = reducer(undefined, loginAsync.fulfilled(
    { token: 't', user: fakeUser, registerGrant: 'grant-1' } as any, '', { email: 'e', password: 'p' }
  ));
  expect(state.authenticatorRegisterGrantId).toBe('grant-1');
  state = reducer(state, clearAuthenticatorRegisterGrant());
  expect(state.authenticatorRegisterGrantId).toBeNull();
});

it('verifyMfaAsync.fulfilled stores the grant; logout clears it', () => {
  let state = reducer(undefined, verifyMfaAsync.fulfilled(
    { token: 't', user: fakeUser, registerGrant: 'grant-2' } as any, '', { code: '123456', tempToken: 'tmp' }
  ));
  expect(state.authenticatorRegisterGrantId).toBe('grant-2');
  state = reducer(state, logout());
  expect(state.authenticatorRegisterGrantId).toBeNull();
});

it('setCredentials (cold-start restore) does NOT set a grant', () => {
  const state = reducer(undefined, setCredentials({ token: 't', user: fakeUser }));
  expect(state.authenticatorRegisterGrantId).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mobile && pnpm vitest run src/store/authSlice.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/mobile/src/services/api.ts`:

```ts
export interface LoginResponse {
  token: string;
  user: User;
  /** #2707: single-use approver-register grant minted at login; memory-only. */
  registerGrant: string | null;
}
// LoginResult success variant:
export type LoginResult =
  | { kind: 'success'; token: string; user: User; registerGrant: string | null }
  | { kind: 'mfaRequired'; challenge: MfaChallenge };
// LoginPayload gains:
  authenticatorRegisterGrantId?: string;
```

`login()` (line 340): `return { kind: 'success', token, user: response.user, registerGrant: response.authenticatorRegisterGrantId ?? null };`
`verifyMfa()` (line 354): `return { token, user: response.user, registerGrant: response.authenticatorRegisterGrantId ?? null };`

`apps/mobile/src/store/authSlice.ts`:
- `ApproverRegistrationStatus` (line 21): add `'deferred'` → `'idle' | 'registered' | 'deferred' | 'failed' | 'unsupported'`.
- `AuthState` + `initialState`: add `authenticatorRegisterGrantId: string | null` (initial `null`).
- `loginAsync` thunk success return (line 60): `return { token: result.token, user: result.user, registerGrant: result.registerGrant };`
- `loginAsync.fulfilled` (line 180-184): add `state.authenticatorRegisterGrantId = action.payload.registerGrant ?? null;` inside the token branch.
- `verifyMfaAsync.fulfilled` (line 194-200): add `state.authenticatorRegisterGrantId = action.payload.registerGrant ?? null;`
- New reducer:

```ts
    // #2707: the grant is single-use — RootNavigator takes it (read-and-clear)
    // BEFORE the registration attempt so a re-fired effect can't replay it.
    clearAuthenticatorRegisterGrant: (state) => {
      state.authenticatorRegisterGrantId = null;
    },
```

- `logout` reducer (line 131-141) and BOTH `logoutAsync.fulfilled`/`.rejected` (lines 208-225): add `state.authenticatorRegisterGrantId = null;`
- Export `clearAuthenticatorRegisterGrant` from the actions destructure.

`apps/mobile/src/navigation/RootNavigator.tsx` (lines 96-111) — read-and-clear BEFORE the async call. Import the app's Redux store instance directly (find the export: `grep -n "export const store" apps/mobile/src/store/index.ts` — adjust the import to match) plus `clearAuthenticatorRegisterGrant`:

```ts
  useEffect(() => {
    if (!token || !user) return;
    let active = true;
    // #2707 read-and-clear: take the login-minted grant OUT of Redux before the
    // async attempt. The grant is deliberately NOT in this effect's deps — the
    // effect re-fires on every `user` identity change (checkAuth double-fires on
    // cold start), and a replayed single-use grant would 403 and overwrite a
    // successful registration with `failed`.
    const registerGrant = store.getState().auth.authenticatorRegisterGrantId;
    if (registerGrant) dispatch(clearAuthenticatorRegisterGrant());
    void ensureApproverDevice(undefined, registerGrant ?? undefined).then((outcome) => {
      if (!active) return;
      dispatch(
        setApproverRegistration({
          status: outcome.status === 'already_registered' ? 'registered' : outcome.status,
          reason: 'reason' in outcome ? outcome.reason : null,
        })
      );
    });
    return () => {
      active = false;
    };
  }, [token, user, dispatch]);
```

(`ensureApproverDevice(undefined, ...)`: `undefined` triggers the signer default parameter. The `outcome.status` mapping already passes `'deferred'` straight through into the widened `ApproverRegistrationStatus`.)

`apps/mobile/src/navigation/ApprovalGate.tsx` — after the `ApproverFailedBanner` slot (line 81-83), add a lower-priority deferred banner:

```tsx
      {!error && pushRegistration !== 'failed' && approverRegistration === 'deferred' ? (
        <ApproverDeferredBanner />
      ) : null}
```

Clone `ApproverFailedBanner` in the same file as `ApproverDeferredBanner`, with informational (non-destructive) styling and the copy:

> **Finish approver setup** — Sign out and back in to let this phone approve requests with Face ID.

(Keep the same safe-area/absolute-slot layout the sibling banners use.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/mobile && pnpm vitest run src/store/authSlice.test.ts src/services/approverDevice.test.ts && pnpm typecheck --filter=@breeze/mobile 2>/dev/null || (cd apps/mobile && pnpm tsc --noEmit)`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/services/api.ts apps/mobile/src/store/authSlice.ts apps/mobile/src/store/authSlice.test.ts apps/mobile/src/navigation/RootNavigator.tsx apps/mobile/src/navigation/ApprovalGate.tsx
git commit -m "feat(mobile): thread login register grant to approver registration, deferred banner (#2707)"
```

---

### Task 9: Web store — `registerApproverDevice(label, reauth)` with three mint paths

**Files:**
- Modify: `apps/web/src/stores/authenticator.ts:36-63`
- Test: `apps/web/src/stores/authenticator.test.ts` (extend; harness mocks `@simplewebauthn/browser` + global fetch)

**Interfaces:**
- Consumes: wire contract from Task 4 (`registerGrantId` on all three register calls; `/authenticator/register-grant`), Task 2 (`/auth/mfa/step-up` + `operation`, returns `{ stepUpGrantId }`), `POST /auth/mfa/step-up/options` (existing, returns `{ options }`).
- Produces (Task 10 consumes):

```ts
export type RegisterReauth =
  | { method: 'passkey' }
  | { method: 'totp'; code: string }
  | { method: 'password'; password: string };
export async function registerApproverDevice(label: string, reauth: RegisterReauth): Promise<void>
```

Thrown errors carry `status?: number` so the component can map 401/403/429.

- [ ] **Step 1: Write the failing tests**

Extend `stores/authenticator.test.ts`:

```ts
describe('registerApproverDevice re-auth mint paths (#2707)', () => {
  const optionsPayload = { options: { challenge: 'reg-challenge', rp: { id: 'x', name: 'x' } } };

  it('password path: mints via /authenticator/register-grant then threads registerGrantId to options+verify', async () => {
    webauthnMocks.startRegistration.mockResolvedValueOnce({ id: 'cred-1', response: {} });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse({ registerGrantId: 'g-pass' }))   // mint
      .mockResolvedValueOnce(makeResponse(optionsPayload))                  // options
      .mockResolvedValueOnce(makeResponse({ success: true }));              // verify
    vi.stubGlobal('fetch', fetchMock);

    await registerApproverDevice('Front desk', { method: 'password', password: 'hunter2!' });

    expect(fetchMock.mock.calls[0][0]).toContain('/authenticator/register-grant');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ currentPassword: 'hunter2!' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ registerGrantId: 'g-pass' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      registerGrantId: 'g-pass', label: 'Front desk',
    });
  });

  it('totp path: mints via /auth/mfa/step-up with operation register_approver_device', async () => {
    webauthnMocks.startRegistration.mockResolvedValueOnce({ id: 'cred-1', response: {} });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse({ stepUpGrantId: 'g-totp' }))
      .mockResolvedValueOnce(makeResponse(optionsPayload))
      .mockResolvedValueOnce(makeResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    await registerApproverDevice('Laptop', { method: 'totp', code: '123456' });

    expect(fetchMock.mock.calls[0][0]).toContain('/auth/mfa/step-up');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      method: 'totp', code: '123456', operation: 'register_approver_device',
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ registerGrantId: 'g-totp' });
  });

  it('passkey path: step-up options → startAuthentication → step-up mint → register', async () => {
    const assertion = { id: 'pk-cred', response: { signature: 's' } };
    webauthnMocks.startAuthentication.mockResolvedValueOnce(assertion);
    webauthnMocks.startRegistration.mockResolvedValueOnce({ id: 'cred-1', response: {} });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse({ options: { challenge: 'auth-challenge' } })) // step-up options
      .mockResolvedValueOnce(makeResponse({ stepUpGrantId: 'g-pk' }))                    // step-up mint
      .mockResolvedValueOnce(makeResponse(optionsPayload))                               // register options
      .mockResolvedValueOnce(makeResponse({ success: true }));                           // verify
    vi.stubGlobal('fetch', fetchMock);

    await registerApproverDevice('Laptop', { method: 'passkey' });

    expect(fetchMock.mock.calls[0][0]).toContain('/auth/mfa/step-up/options');
    expect(webauthnMocks.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: { challenge: 'auth-challenge' },
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      method: 'passkey', credential: assertion, operation: 'register_approver_device',
    });
  });

  it('mint failure rejects with the status attached (so the UI can map 401/403/429)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({ error: 'Invalid credentials' }, false, 401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      registerApproverDevice('x', { method: 'password', password: 'nope' })
    ).rejects.toMatchObject({ status: 401 });
    expect(webauthnMocks.startRegistration).not.toHaveBeenCalled();
  });
});
```

Also UPDATE the pre-existing `registerApproverDevice` test (line 35-70): it calls the old single-argument signature — convert it to the password path or delete it in favor of the new suite.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && pnpm vitest run src/stores/authenticator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Replace `registerApproverDevice` in `stores/authenticator.ts` (lines 36-63):

```ts
export type RegisterReauth =
  | { method: 'passkey' }
  | { method: 'totp'; code: string }
  | { method: 'password'; password: string };

class RegisterStepError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

async function jsonOrThrow(response: Response, fallback: string): Promise<any> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RegisterStepError(data?.error ?? fallback, response.status);
  }
  return data;
}

/**
 * Mint a single-use register_approver_device grant with whichever re-auth
 * factor the caller proved (#2707 — spec: strongest available factor; the
 * password endpoint 403s `stronger_factor_required` if TOTP/passkey exist).
 */
async function mintRegisterGrant(reauth: RegisterReauth): Promise<string> {
  if (reauth.method === 'password') {
    const data = await jsonOrThrow(
      await fetchWithAuth('/authenticator/register-grant', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: reauth.password }),
      }),
      'Verification failed.'
    );
    if (!data?.registerGrantId) throw new RegisterStepError('Verification failed.');
    return data.registerGrantId;
  }

  let stepUpBody: Record<string, unknown>;
  if (reauth.method === 'totp') {
    stepUpBody = { method: 'totp', code: reauth.code, operation: 'register_approver_device' };
  } else {
    // Passkey: fetch an authenticated step-up challenge, run the assertion
    // ceremony, then prove it to /auth/mfa/step-up.
    const challengeData = await jsonOrThrow(
      await fetchWithAuth('/auth/mfa/step-up/options', { method: 'POST' }),
      'Could not start passkey verification.'
    );
    const optionsJSON: PublicKeyCredentialRequestOptionsJSON =
      challengeData.options ?? challengeData.optionsJSON ?? challengeData;
    const credential = await startAuthentication({ optionsJSON });
    stepUpBody = { method: 'passkey', credential, operation: 'register_approver_device' };
  }

  const data = await jsonOrThrow(
    await fetchWithAuth('/auth/mfa/step-up', {
      method: 'POST',
      body: JSON.stringify(stepUpBody),
    }),
    'Verification failed.'
  );
  if (!data?.stepUpGrantId) throw new RegisterStepError('Verification failed.');
  // The step-up endpoint names it stepUpGrantId; the register routes take it
  // as registerGrantId — same value, different field name.
  return data.stepUpGrantId;
}

/**
 * Register the current browser/platform authenticator as an approver device.
 * re-auth mint → options (validates the grant) → Windows Hello / Touch ID
 * registration ceremony → verify (consumes the grant).
 */
export async function registerApproverDevice(label: string, reauth: RegisterReauth): Promise<void> {
  const registerGrantId = await mintRegisterGrant(reauth);

  const optionsData = await jsonOrThrow(
    await fetchWithAuth('/authenticator/devices/webauthn/options', {
      method: 'POST',
      body: JSON.stringify({ registerGrantId }),
    }),
    'Failed to start device registration.'
  );
  const optionsJSON: PublicKeyCredentialCreationOptionsJSON =
    optionsData.options ?? optionsData.optionsJSON ?? optionsData;

  const response = await startRegistration({ optionsJSON });

  await jsonOrThrow(
    await fetchWithAuth('/authenticator/devices/webauthn/verify', {
      method: 'POST',
      body: JSON.stringify({ registerGrantId, label, response }),
    }),
    'Device registration failed.'
  );
}
```

(`startAuthentication` and `PublicKeyCredentialRequestOptionsJSON` are already imported at the top of the file.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/web && pnpm vitest run src/stores/authenticator.test.ts && pnpm tsc --noEmit`
Expected: PASS. The typecheck WILL flag `ApproverDevicesSection.tsx` calling the old one-arg signature — that's Task 10; if you need green now, leave the old call temporarily as `registerApproverDevice(trimmed, { method: 'password', password: '' })` is NOT acceptable — instead do Tasks 9 and 10 in one PR-visible sequence and only require the full `tsc` pass at the end of Task 10.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/stores/authenticator.ts apps/web/src/stores/authenticator.test.ts
git commit -m "feat(web): registerApproverDevice mints re-auth grants (passkey/totp/password) (#2707)"
```

---

### Task 10: Web UI — re-auth step in `ApproverDevicesSection` + ProfilePage plumbing + i18n

**Files:**
- Create: `apps/web/src/components/settings/StepUpPrompt.tsx`
- Modify: `apps/web/src/components/settings/ApproverDevicesSection.tsx`
- Modify: `apps/web/src/components/settings/ProfilePage.tsx:25-32, 914`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-FR,pt-BR}/settings.json`
- Test: `apps/web/src/components/settings/StepUpPrompt.test.tsx` (new)

**Interfaces:**
- Consumes: `registerApproverDevice(label, reauth)` + `RegisterReauth` (Task 9); `mfaMethod` from `/users/me` (Task 6); `passkeys.length` from ProfilePage state.
- Produces: `<StepUpPrompt tier reauthValue onChange />` and `<ApproverDevicesSection passkeyCount={number} mfaMethod={string | null} />`.

- [ ] **Step 1: Write the failing StepUpPrompt test**

Create `apps/web/src/components/settings/StepUpPrompt.test.tsx` (jsdom, mirror the render style of other settings component tests):

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import StepUpPrompt, { pickReauthTier } from './StepUpPrompt';

describe('pickReauthTier', () => {
  it.each([
    [2, 'totp', 'passkey'],     // passkey wins even with TOTP
    [0, 'totp', 'totp'],
    [0, 'sms', 'password'],     // SMS users take the password path (spec)
    [0, null, 'password'],
  ] as const)('passkeys=%s mfaMethod=%s → %s', (passkeyCount, mfaMethod, expected) => {
    expect(pickReauthTier(passkeyCount, mfaMethod)).toBe(expected);
  });
});

describe('StepUpPrompt', () => {
  it('renders a code input for totp tier', () => {
    render(<StepUpPrompt tier="totp" reauthValue="" onChange={vi.fn()} disabled={false} />);
    expect(screen.getByTestId('approver-stepup-code')).toBeTruthy();
  });
  it('renders a password input for password tier', () => {
    render(<StepUpPrompt tier="password" reauthValue="" onChange={vi.fn()} disabled={false} />);
    expect(screen.getByTestId('approver-stepup-password')).toBeTruthy();
  });
  it('renders only the explainer for passkey tier (ceremony happens on submit)', () => {
    render(<StepUpPrompt tier="passkey" reauthValue="" onChange={vi.fn()} disabled={false} />);
    expect(screen.queryByTestId('approver-stepup-code')).toBeNull();
    expect(screen.queryByTestId('approver-stepup-password')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/web && pnpm vitest run src/components/settings/StepUpPrompt.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement StepUpPrompt**

Create `apps/web/src/components/settings/StepUpPrompt.tsx`:

```tsx
import { useTranslation } from 'react-i18next';

export type ReauthTier = 'passkey' | 'totp' | 'password';

/** Strongest-available-factor tiering — mirrors the server gate
 * (`userHasStrongerReauthFactor`): passkey → TOTP → password. SMS-method
 * accounts fall to password (no authenticated step-up SMS sender; spec #2707). */
export function pickReauthTier(passkeyCount: number, mfaMethod: string | null): ReauthTier {
  if (passkeyCount > 0) return 'passkey';
  if (mfaMethod === 'totp') return 'totp';
  return 'password';
}

type Props = {
  tier: ReauthTier;
  reauthValue: string;
  onChange: (value: string) => void;
  disabled: boolean;
};

/**
 * Re-auth input for approver-device registration. Reusable: ProfilePage's
 * add-passkey flow (currently dead-ends for MFA-protected users on
 * existing_factor_step_up_required) is the intended second consumer.
 */
export default function StepUpPrompt({ tier, reauthValue, onChange, disabled }: Props) {
  const { t } = useTranslation('settings');

  if (tier === 'passkey') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="approver-stepup-passkey-note">
        {t('stepUpPrompt.youWillConfirmWithYourPasskey')}
      </p>
    );
  }

  if (tier === 'totp') {
    return (
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="approver-stepup-code">
          {t('stepUpPrompt.authenticatorCode')}
        </label>
        <input
          id="approver-stepup-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={reauthValue}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          disabled={disabled}
          data-testid="approver-stepup-code"
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor="approver-stepup-password">
        {t('stepUpPrompt.confirmYourPassword')}
      </label>
      <input
        id="approver-stepup-password"
        type="password"
        autoComplete="current-password"
        value={reauthValue}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        disabled={disabled}
        data-testid="approver-stepup-password"
      />
    </div>
  );
}
```

- [ ] **Step 4: Wire `ApproverDevicesSection`**

In `ApproverDevicesSection.tsx`:

1. Props: `export default function ApproverDevicesSection({ passkeyCount, mfaMethod }: { passkeyCount: number; mfaMethod: string | null })`.
2. Imports: `StepUpPrompt, { pickReauthTier, type ReauthTier }` and `type RegisterReauth` from `../../stores/authenticator`.
3. State: add `const [reauthValue, setReauthValue] = useState('');` and `const tier: ReauthTier = pickReauthTier(passkeyCount, mfaMethod);`
4. Replace `handleRegister` (lines 71-96):

```tsx
  const buildReauth = (): RegisterReauth | null => {
    if (tier === 'passkey') return { method: 'passkey' };
    if (tier === 'totp') return reauthValue.length === 6 ? { method: 'totp', code: reauthValue } : null;
    return reauthValue.length > 0 ? { method: 'password', password: reauthValue } : null;
  };

  const mapRegisterError = (err: unknown): string => {
    const status = (err as { status?: number })?.status;
    if (status === 401) {
      return tier === 'totp'
        ? t('approverDevicesSection.incorrectCode')
        : t('approverDevicesSection.incorrectPassword');
    }
    if (status === 429) return t('approverDevicesSection.tooManyAttemptsTryAgainInAFewMinutes');
    if (status === 403) return t('approverDevicesSection.verificationExpiredPleaseVerifyAgain');
    return err instanceof Error ? err.message : t('approverDevicesSection.failedToRegisterThisDevice');
  };

  const handleRegister = async () => {
    if (isRegistering) return;
    const reauth = buildReauth();
    if (!reauth) return; // submit disabled anyway
    const trimmed = label.trim() || 'This device';
    setIsRegistering(true);
    try {
      await runAction({
        request: async () => {
          await registerApproverDevice(trimmed, reauth);
          return OK_RESPONSE;
        },
        errorFallback: t('approverDevicesSection.failedToRegisterThisDevice'),
        successMessage: t('approverDevicesSection.thisDeviceCanNowApproveRequests'),
      });
      setLabel('');
      setReauthValue('');
      await load();
    } catch (err) {
      if (err instanceof ActionError) return; // already toasted by runAction
      // 403 = grant expired mid-ceremony (>300s in the WebAuthn prompt): keep
      // the label, clear the proof, and ask the user to verify again.
      if ((err as { status?: number })?.status === 403) setReauthValue('');
      showToast({ type: 'error', message: mapRegisterError(err) });
    } finally {
      setIsRegistering(false);
    }
  };
```

5. In the register form JSX (after the label input, line 293), add `<StepUpPrompt tier={tier} reauthValue={reauthValue} onChange={setReauthValue} disabled={isRegistering} />`, and disable the submit button when `buildReauth() === null`.
6. Pending-state success UI: in the device row, next to the platform-bound badge (line 205-211), when `device.lastUsedAt === null` render:

```tsx
    {device.lastUsedAt === null && (
      <span
        data-testid={`approver-device-pending-${device.id}`}
        className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600"
      >
        {t('approverDevicesSection.pendingActivatesOnFirstApproval')}
      </span>
    )}
```

In `ProfilePage.tsx`:
- `User` type (line 25-32): add `mfaMethod?: string | null;` (populated by Task 6's `/users/me` change — the fetch at line 131 already spreads the payload).
- Line 914: `<ApproverDevicesSection passkeyCount={passkeys.length} mfaMethod={user?.mfaMethod ?? null} />`.

- [ ] **Step 5: Add the i18n keys to ALL FIVE locales**

`apps/web/src/locales/en/settings.json` — add inside the existing `approverDevicesSection` object:

```json
"incorrectCode": "Incorrect code.",
"incorrectPassword": "Incorrect password.",
"tooManyAttemptsTryAgainInAFewMinutes": "Too many attempts — try again in a few minutes.",
"verificationExpiredPleaseVerifyAgain": "Verification expired — please verify again.",
"pendingActivatesOnFirstApproval": "Pending — activates on first approval"
```

and a new top-level `stepUpPrompt` object:

```json
"stepUpPrompt": {
  "youWillConfirmWithYourPasskey": "You'll confirm with your passkey (Touch ID / Windows Hello) when you register.",
  "authenticatorCode": "Authenticator code",
  "confirmYourPassword": "Confirm your password"
}
```

Then add the SAME keys with translated values to `de-DE`, `es-419`, `fr-FR`, `pt-BR` `settings.json` (translate faithfully; the parity check only needs the keys present, but don't ship English into the other locales — match the tone of neighboring keys in each file).

- [ ] **Step 6: Run tests + typecheck + locale parity**

Run: `cd apps/web && pnpm vitest run src/components/settings/StepUpPrompt.test.tsx src/stores/authenticator.test.ts && pnpm vitest run src/lib/__tests__/no-silent-mutations.test.ts && pnpm tsc --noEmit`
Also run whichever test enforces locale key parity (`grep -rln "locale" apps/web/src --include="*.test.ts" | head` to find it) — it must pass.
Expected: all PASS; the full-project `tsc` now passes (Task 9's temporary breakage resolved).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/settings/StepUpPrompt.tsx apps/web/src/components/settings/StepUpPrompt.test.tsx apps/web/src/components/settings/ApproverDevicesSection.tsx apps/web/src/components/settings/ProfilePage.tsx apps/web/src/locales/*/settings.json
git commit -m "feat(web): approver registration re-auth step (passkey/totp/password) with pending badge (#2707)"
```

---

### Task 11: Full verification sweep

**Files:** none new — verification only.

- [ ] **Step 1: Full unit suites**

```bash
pnpm test --filter=@breeze/api
cd apps/web && pnpm vitest run
cd ../mobile && pnpm vitest run
```
Expected: all green. Known flaky suites (memory: durationMs truncation, AutomationTab catalog) may need one retry — a NEW red is yours.

- [ ] **Step 2: Repo-wide contract greps**

```bash
# No register route still reads currentPassword (only /register-grant + unrelated routes may):
grep -n "currentPassword" apps/api/src/routes/authenticator.ts
# Expect exactly the registerGrantMintSchema + /register-grant handler hits.

# The refresh handler never mints:
grep -n "mintLoginRegisterGrant\|authenticatorRegisterGrantId" apps/api/src/routes/auth/login.ts
# Expect hits ONLY in the password-login success block (before line ~632), NONE in /refresh (line 700+).

# Mobile client no longer sends kind/isPlatformBound:
grep -n "isPlatformBound\|'kind'" apps/mobile/src/services/approverDevice.ts
# Expect no hits in the POST body.
```

- [ ] **Step 3: Manual smoke against the worktree stack** (optional but recommended; use the `worktree-stack` skill): login on web → Settings → register this browser with each available tier; confirm the pending badge; forge a POST to `/authenticator/devices` with a bearer token and NO grant → expect 403 `register_step_up_required`.

- [ ] **Step 4: Commit any test-only fixups, then hand off**

```bash
git add -A && git commit -m "test: verification fixups for approver register grants (#2707)" --allow-empty
```

Open the PR per the repo's normal flow (`commit-commands:commit-push-pr` or manual `gh pr create`), body referencing issue #2707 and the spec.

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** operation union (T1), step-up operation (T2), unconditional enforcement + no-bypass pin (T3), route swap + password mint + stronger-factor gate (T4), login mints mobile-gated + refresh-never + OpenAPI (T5), mfaMethod on /me (T6), mobile grant flow + deferred + single-flight + read-and-clear + banner (T7-8), web three mint paths + naming seam (T9), UI tiering + error mapping + pending badge + i18n (T10). Out-of-scope items (SSO-only lockout, ProfilePage passkey dead-end, SMS sender) intentionally have no tasks.
- **Known softness (acceptable):** three test-harness details are discovered at execution time by mirroring named sibling files (`helpers.mfaStepUp.test.ts` fixtures in T3, login.test.ts request builders in T5, the /me test file in T6). The assertions and scenarios are fully specified; only fixture plumbing is inherited.
- **Type consistency:** `RegisterReauth` (T9) ↔ StepUpPrompt tiers (T10); `registerGrant: string | null` (T8 api.ts ↔ authSlice); `enforceApproverRegisterStepUp` signature identical in T3 (definition) and T4 (call sites); wire field names `registerGrantId` / `stepUpGrantId` / `authenticatorRegisterGrantId` used consistently per the spec's naming-seam note.
