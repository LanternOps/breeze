import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

// Portal registration W6 (plan D8): the `self_register` token on the Redis
// backend, against a fake client that runs the GET+DEL script atomically
// (one synchronous step), as Redis does. The real-Redis race is in
// __tests__/integration/portalCapabilityTokens.integration.test.ts.

const { store, setex, evalMock, redisRef } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const setex = vi.fn(async (key: string, _ttl: number, value: string) => { store.set(key, value); return 'OK'; });
  const evalMock = vi.fn(async (_script: string, _n: number, key: string) => {
    const v = store.get(key) ?? null;
    store.delete(key);
    return v;
  });
  return { store, setex, evalMock, redisRef: { current: { setex, eval: evalMock, get: async (k: string) => store.get(k) ?? null } as unknown } };
});

vi.mock('../../services/portal/rateLimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portal/rateLimit')>()),
  PORTAL_USE_REDIS: true,
}));
vi.mock('../../services/redis', () => ({ getRedis: () => redisRef.current }));
vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: <T>(fn: () => T) => fn(),
}));
vi.mock('../../services/tenantStatus', () => ({ getActiveOrgTenant: vi.fn() }));

import { consumePortalSelfRegistrationToken, issuePortalSelfRegistrationToken } from './capabilityTokens';

const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const input = {
  orgId: '7c0a1f7e-1111-4222-8333-444455556666', email: 'pat@contoso.example.com', name: 'Pat Doe',
  domain: 'contoso.example.com', policyFingerprint: 'b'.repeat(64),
};

beforeEach(() => {
  store.clear();
  setex.mockClear();
  evalMock.mockClear();
  redisRef.current = { setex, eval: evalMock, get: async (k: string) => store.get(k) ?? null };
});

describe('self_register token on Redis (W6 D8)', () => {
  it('issues a self_register token stored only by sha256 under portal:self-register:<hash> with a 1800 s TTL', async () => {
    const raw = await issuePortalSelfRegistrationToken(input);
    expect(setex).toHaveBeenCalledTimes(1);
    const [key, ttl, value] = setex.mock.calls[0]!;
    expect(key).toBe(`portal:self-register:${sha(raw!)}`);
    expect(ttl).toBe(1800);
    expect(value).not.toContain(raw!);
    expect(JSON.parse(value)).toEqual({ v: 2, purpose: 'self_register', ...input });
  });

  it('consumes through the atomic GET+DEL script, once', async () => {
    const raw = await issuePortalSelfRegistrationToken(input);
    const results = await Promise.all([consumePortalSelfRegistrationToken(raw!), consumePortalSelfRegistrationToken(raw!)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(evalMock).toHaveBeenCalledWith(expect.stringContaining("redis.call('DEL'"), 1, `portal:self-register:${sha(raw!)}`);
  });

  it('returns null without touching anything when Redis is required but unavailable', async () => {
    redisRef.current = null;
    expect(await issuePortalSelfRegistrationToken(input)).toBeNull();
    expect(await consumePortalSelfRegistrationToken('anything')).toBeNull();
    expect(setex).not.toHaveBeenCalled();
    expect(evalMock).not.toHaveBeenCalled();
  });
});
