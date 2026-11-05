/**
 * #10962 — the per-user budget end to end: real signed JWTs, the real
 * authMiddleware reading real Postgres, and the real rateLimiter on real Redis.
 * The unit suite (middleware/userRateBudget.test.ts) covers the bucket matrix
 * against stubs; this one proves the pieces actually meet.
 *
 * Run:
 *   pnpm test-stack up   # worktree root
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/userRateBudget.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware } from '../../middleware/auth';
import { globalRateLimit } from '../../middleware/globalRateLimit';
import { createAccessToken, createRefreshToken } from '../../services/jwt';
import { httpExceptionResponse } from '../../middleware/httpExceptionResponse';
import { createPartner, createUser } from './db-utils';
import { getTestRedis } from './setup';

const BUDGET = 3;

function buildApp() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HTTPException) return httpExceptionResponse(err, c);
    throw err;
  });
  app.use('*', globalRateLimit({ limit: 2, windowSeconds: 60 }));
  const api = new Hono();
  // Mounted through a sub-app, as index.ts does: the eligibility flag the front
  // door sets has to survive that hop.
  api.use('*', authMiddleware);
  api.get('/devices', (c) => c.json({ user: c.get('auth').user.id }));
  app.route('/api/v1', api);
  app.get('/public/thing', (c) => c.json({ ok: true }));
  return app;
}

async function sessionFor(partnerId: string) {
  const user = await createUser({
    partnerId,
    email: `budget-${randomUUID()}@example.test`,
    withMembership: true,
  });
  const claims = {
    sub: user.id,
    email: user.email,
    roleId: null,
    orgId: null,
    partnerId,
    scope: 'partner' as const,
    mfa: true,
    aep: user.authEpoch,
    mep: user.mfaEpoch,
    sid: randomUUID(),
  };
  return {
    userId: user.id,
    access: { headers: { Authorization: `Bearer ${await createAccessToken(claims)}` } },
    refresh: { headers: { Authorization: `Bearer ${await createRefreshToken(claims)}` } },
  };
}

describe('per-user rate budget on real Redis (#10962)', () => {
  beforeEach(() => {
    vi.stubEnv('USER_RATE_LIMIT_PER_MINUTE', String(BUDGET));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('isolates users behind one IP, and refuses only the one over budget', async () => {
    const partner = await createPartner();
    const alice = await sessionFor(partner.id);
    const bob = await sessionFor(partner.id);
    const app = buildApp();

    // The shared anonymous bucket is 2; three each would trip it if they shared.
    for (let i = 0; i < BUDGET; i += 1) {
      const res = await app.request('/api/v1/devices', alice.access);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ user: alice.userId });
    }

    const throttled = await app.request('/api/v1/devices', alice.access);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('Retry-After')).toBe('60');
    expect(throttled.headers.get('X-RateLimit-Limit')).toBe(String(BUDGET));
    expect(((await throttled.json()) as { error: string }).error).toBe('Too many requests');

    expect((await app.request('/api/v1/devices', bob.access)).status).toBe(200);
  });

  it('keys the budget on the user id, and a rejected attempt does not spend it', async () => {
    const partner = await createPartner();
    const alice = await sessionFor(partner.id);
    const app = buildApp();

    for (let i = 0; i < BUDGET + 4; i += 1) {
      await app.request('/api/v1/devices', alice.access);
    }

    // Four rejected attempts were refunded: only the admitted three remain, so
    // the window recovers on schedule for a client honouring Retry-After.
    expect(await getTestRedis().zcard(`rl:session:${alice.userId}`)).toBe(BUDGET);
  });

  // The dashboard's real traffic shape: a device page fans out in parallel.
  it('admits exactly the budget from a parallel burst', async () => {
    const partner = await createPartner();
    const alice = await sessionFor(partner.id);
    const app = buildApp();

    const results = await Promise.all(
      Array.from({ length: BUDGET + 5 }, () => app.request('/api/v1/devices', alice.access)),
    );
    const statuses = results.map((res) => res.status);

    expect(statuses.filter((status) => status === 200)).toHaveLength(BUDGET);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });

  it('meters a refresh token used as a bearer as anonymous, not as a session', async () => {
    const partner = await createPartner();
    const alice = await sessionFor(partner.id);
    const app = buildApp();

    expect((await app.request('/public/thing', alice.refresh)).status).toBe(200);
    expect((await app.request('/public/thing', alice.refresh)).status).toBe(200);
    expect((await app.request('/public/thing', alice.refresh)).status).toBe(429);
  });

  it('a session is not caught by an exhausted anonymous bucket on the same IP', async () => {
    const partner = await createPartner();
    const alice = await sessionFor(partner.id);
    const app = buildApp();

    await app.request('/public/thing');
    await app.request('/public/thing');
    expect((await app.request('/public/thing')).status).toBe(429);

    expect((await app.request('/api/v1/devices', alice.access)).status).toBe(200);
  });
});
