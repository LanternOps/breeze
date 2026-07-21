/**
 * Real-Redis integration coverage for the #2707 approver-device register
 * grant chain (`mfaStepUpGrant.ts`).
 *
 * The unit suites around this feature mock the seam from BOTH sides:
 *   - `mfaStepUpGrant.test.ts` mocks `./redis` entirely (an in-memory Map
 *     stands in for Redis).
 *   - the route-level tests (e.g. `routes/auth/authenticator.test.ts`) mock
 *     `enforceApproverRegisterStepUp` itself, so they never call into the
 *     real mint/validate/consume functions at all.
 *
 * Nothing therefore exercises the REAL chain against a REAL Redis: mint (as
 * `mintLoginRegisterGrant` mints at login, bound to userId/epochs/sid, for
 * operation `register_approver_device`) -> non-consuming `validateStepUpGrant`
 * (the `webauthn/options` phase) -> single-use `consumeStepUpGrant` (getdel,
 * the terminal `webauthn/verify` phase) -> replay rejected -> a grant minted
 * for the OTHER operation (`add_factor`) never validates/consumes against a
 * `register_approver_device` bind, and vice versa. This file drives exactly
 * that chain with only the service under test + a real `ioredis` client — no
 * mocks on `mfaStepUpGrant.ts` or `./redis`.
 *
 * No Postgres fixtures are needed: `bindsMatch` and the grant lifecycle are
 * pure Redis-key semantics, so this is scoped to `getRedis()` from
 * `./redis`, which the shared integration `setup.ts` (auto-applied via this
 * config's `setupFiles`) already points at the real test Redis
 * (`REDIS_URL`, defaulting to `redis://localhost:6380` — see
 * `__tests__/integration/loadEnv.ts`). `setup.ts`'s global `beforeEach` also
 * `flushdb()`s that same Redis before every test in this file, so each test
 * starts from an empty keyspace.
 *
 * `SHOULD_RUN` mirrors the same env-presence skip idiom already used by
 * `oauth-code-flow.integration.test.ts` so this file degrades the same way
 * the rest of the integration suite does when the local rig isn't up
 * (`docker compose -f docker-compose.test.yml up -d` — see setup.ts's own
 * header). Note the shared `setup.ts` beforeAll unconditionally pings BOTH
 * Postgres and Redis for every file in this config (its hard connect-or-throw
 * predates this file), so in practice this suite already requires the whole
 * :5433/:6380 rig up regardless of this flag; it's kept for consistency with
 * the existing convention and as defense-in-depth against a future setup.ts
 * change that makes DB/Redis independently optional.
 *
 * Run:
 *   docker compose -f docker-compose.test.yml up -d
 *   cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
 *     src/services/mfaStepUpGrant.integration.test.ts
 */
import '../__tests__/integration/setup';

import { randomUUID } from 'crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { getRedis, closeRedis } from './redis';
import {
  mintStepUpGrant,
  validateStepUpGrant,
  consumeStepUpGrant,
  type StepUpOperation,
} from './mfaStepUpGrant';

const SHOULD_RUN = Boolean(process.env.REDIS_URL || process.env.DATABASE_URL);

function bind(operation: StepUpOperation) {
  return {
    userId: randomUUID(),
    operation,
    authEpoch: 1,
    mfaEpoch: 2,
    sid: randomUUID(),
  };
}

describe.skipIf(!SHOULD_RUN)('mfaStepUpGrant real-Redis chain (#2707)', () => {
  afterAll(async () => {
    // Quit the shared ioredis singleton so vitest can exit cleanly; the
    // module under test rides this same connection (getRedis() singleton in
    // ./redis). Mirrors quoteSendQueue.integration.test.ts's afterAll.
    await closeRedis();
  });

  it('mint -> non-consuming validate x2 -> single-use consume -> replay rejected, with a <=300s TTL', async () => {
    const registerBind = bind('register_approver_device');

    const id = await mintStepUpGrant(registerBind);
    expect(id).toBeTruthy();

    // Real Redis TTL on the minted key, via the exact key format documented
    // at the top of mfaStepUpGrant.ts (`mfa:stepup:<id>`).
    const redis = getRedis();
    expect(redis).not.toBeNull();
    const ttl = await redis!.ttl(`mfa:stepup:${id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);

    // Non-consuming validate (the webauthn/options phase): can be called
    // repeatedly without burning the grant.
    await expect(validateStepUpGrant(id!, registerBind)).resolves.toBe(true);
    await expect(validateStepUpGrant(id!, registerBind)).resolves.toBe(true);

    // Single-use consume (the webauthn/verify phase, getdel).
    await expect(consumeStepUpGrant(id!, registerBind)).resolves.toBe(true);

    // Replay: the grant is gone. Both consume and (non-consuming) validate
    // now fail — proving consume genuinely deleted the Redis key rather than
    // just returning false for an unrelated reason.
    await expect(consumeStepUpGrant(id!, registerBind)).resolves.toBe(false);
    await expect(validateStepUpGrant(id!, registerBind)).resolves.toBe(false);
  });

  it('a grant minted for one operation never validates/consumes against the other operation\'s bind', async () => {
    // add_factor -> presented against a register_approver_device bind.
    const addFactorBind = bind('add_factor');
    const addFactorId = await mintStepUpGrant(addFactorBind);
    expect(addFactorId).toBeTruthy();

    const crossOpBindForAddFactorGrant = { ...addFactorBind, operation: 'register_approver_device' as const };
    await expect(validateStepUpGrant(addFactorId!, crossOpBindForAddFactorGrant)).resolves.toBe(false);
    await expect(consumeStepUpGrant(addFactorId!, crossOpBindForAddFactorGrant)).resolves.toBe(false);

    // register_approver_device -> presented against an add_factor bind.
    const registerBind = bind('register_approver_device');
    const registerId = await mintStepUpGrant(registerBind);
    expect(registerId).toBeTruthy();

    const crossOpBindForRegisterGrant = { ...registerBind, operation: 'add_factor' as const };
    await expect(validateStepUpGrant(registerId!, crossOpBindForRegisterGrant)).resolves.toBe(false);
    // getdel deletes the record on ANY lookup hit, match or not — pinning the
    // documented behavior from the mocked unit suite (mfaStepUpGrant.test.ts,
    // "operation isolation" describe block): the failed cross-operation
    // consume attempt above still destroys the register grant, so even a
    // subsequent SAME-operation validate below also fails.
    await expect(consumeStepUpGrant(registerId!, crossOpBindForRegisterGrant)).resolves.toBe(false);
    await expect(validateStepUpGrant(registerId!, registerBind)).resolves.toBe(false);
  });
});
