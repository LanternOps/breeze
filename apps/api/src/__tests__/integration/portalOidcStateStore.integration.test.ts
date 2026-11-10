/**
 * Portal registration W4 (#11381): the portal OIDC state is consumed
 * ATOMICALLY on real Redis (Review Focus 3 — a replayed or double-delivered
 * callback). Two callbacks racing on one `state` must yield exactly one
 * consumer; the Lua GET+DEL (`luaGetDel`, shared with the W2 capability
 * tokens) runs as one server-side step.
 *
 * Runs the production backend: PORTAL_USE_REDIS is read at module load, so
 * PORTAL_STATE_BACKEND is set before any portal module is imported.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalOidcStateStore.integration.test.ts
 */
import './setup';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.PORTAL_STATE_BACKEND = 'redis';
});

import { createHash } from 'node:crypto';
import { consumePortalOidcState, createPortalOidcState } from '../../services/portalOidc/stateStore';
import { PORTAL_REDIS_KEYS, PORTAL_USE_REDIS } from '../../routes/portal/schemas';
import { closeRedis, getRedis } from '../../services/redis';

const RUN = !!process.env.REDIS_URL;
const sha256Hex = (raw: string) => createHash('sha256').update(raw).digest('hex');

describe.skipIf(!RUN)('portal OIDC state against real Redis', () => {
  afterAll(async () => { await closeRedis(); });

  it('runs the Redis backend', () => {
    expect(PORTAL_USE_REDIS).toBe(true);
  });

  it('two concurrent consumes on real Redis: exactly one wins', async () => {
    const minted = await createPortalOidcState({ provider: 'entra', purpose: { kind: 'login' }, hostOrgId: null, authority: 'organizations' });
    const key = PORTAL_REDIS_KEYS.oidcState(sha256Hex(minted.state));
    expect(await getRedis()!.exists(key)).toBe(1);

    const results = await Promise.all([
      consumePortalOidcState(minted.state, minted.bindingCookie),
      consumePortalOidcState(minted.state, minted.bindingCookie),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await getRedis()!.exists(key)).toBe(0);
  });

  it('many concurrent consumes still yield exactly one state', async () => {
    const minted = await createPortalOidcState({ provider: 'entra', purpose: { kind: 'login' }, hostOrgId: null, authority: 'organizations' });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumePortalOidcState(minted.state, minted.bindingCookie)),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('stores the record under sha256(state) with the 600 s TTL, and a wrong cookie still burns it', async () => {
    const minted = await createPortalOidcState({ provider: 'entra', purpose: { kind: 'login' }, hostOrgId: null, authority: 'organizations' });
    const key = PORTAL_REDIS_KEYS.oidcState(sha256Hex(minted.state));
    const ttl = await getRedis()!.ttl(key);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
    const stored = (await getRedis()!.get(key))!;
    expect(stored).not.toContain(minted.state);
    expect(stored).not.toContain(minted.bindingCookie);

    expect(await consumePortalOidcState(minted.state, 'another-browser')).toBeNull();
    expect(await getRedis()!.exists(key)).toBe(0);
    expect(await consumePortalOidcState(minted.state, minted.bindingCookie)).toBeNull();
  });
});
