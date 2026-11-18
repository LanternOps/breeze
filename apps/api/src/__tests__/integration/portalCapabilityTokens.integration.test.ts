/**
 * Portal registration W2 (#11379): capability tokens are consumed ATOMICALLY
 * on real Redis (Review Focus 4 — the invite link double-clicked or opened in
 * two tabs gives exactly one activation).
 *
 * Before W2 the invite token was read and deleted in two round trips, so two
 * concurrent consumers could both read it. The Lua GET+DEL runs as one
 * server-side step.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalCapabilityTokens.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { __testOnly } from '../../routes/portal/capabilityTokens';
import { closeRedis, getRedis } from '../../services/redis';

const RUN = !!process.env.REDIS_URL;

describe.skipIf(!RUN)('portal capability token consume against real Redis', () => {
  afterAll(async () => { await closeRedis(); });

  it('two concurrent consumes of one token: exactly one wins', async () => {
    const redis = getRedis()!;
    const key = `portal:invite:${randomUUID()}`;
    await redis.set(key, '{"v":2}', 'EX', 60);
    const [a, b] = await Promise.all([
      __testOnly.consumeFromRedis(redis, key),
      __testOnly.consumeFromRedis(redis, key),
    ]);
    expect([a, b].filter(Boolean)).toEqual(['{"v":2}']);
    expect(await redis.exists(key)).toBe(0);
  });

  it('many concurrent consumes still yield exactly one value', async () => {
    const redis = getRedis()!;
    const key = `portal:reset:${randomUUID()}`;
    await redis.set(key, 'payload', 'EX', 60);
    const results = await Promise.all(Array.from({ length: 20 }, () => __testOnly.consumeFromRedis(redis, key)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('a missing key consumes to null', async () => {
    expect(await __testOnly.consumeFromRedis(getRedis()!, `portal:invite:${randomUUID()}`)).toBeNull();
  });
});

/**
 * Self-registration links (portal registration W6 #11383, plan D8; Review
 * Focus 4) through the PUBLIC issue/consume functions on the Redis backend.
 * `PORTAL_USE_REDIS` is read once at module load, so the portal modules are
 * re-imported fresh with `PORTAL_STATE_BACKEND=redis` for this block.
 */
describe.skipIf(!RUN)('portal self-registration link tokens against real Redis', () => {
  type Tokens = typeof import('../../routes/portal/capabilityTokens');
  type Schemas = typeof import('../../routes/portal/schemas');
  type RedisMod = typeof import('../../services/redis');
  let tokens: Tokens;
  let schemas: Schemas;
  let redisMod: RedisMod;
  const savedBackend = process.env.PORTAL_STATE_BACKEND;

  beforeAll(async () => {
    process.env.PORTAL_STATE_BACKEND = 'redis';
    vi.resetModules();
    tokens = await import('../../routes/portal/capabilityTokens');
    schemas = await import('../../routes/portal/schemas');
    redisMod = await import('../../services/redis');
    // The block is worthless unless the fresh modules really took the Redis backend.
    expect(schemas.PORTAL_USE_REDIS).toBe(true);
  });

  afterAll(async () => {
    await redisMod?.closeRedis();
    if (savedBackend === undefined) delete process.env.PORTAL_STATE_BACKEND;
    else process.env.PORTAL_STATE_BACKEND = savedBackend;
    vi.resetModules();
  });

  const selfRegisterFields = () => ({
    orgId: randomUUID(),
    email: `Pat-${randomUUID().slice(0, 8)}@Selfreg.Example.com`,
    name: 'Pat Person',
    domain: 'Selfreg.Example.com',
    policyFingerprint: 'f'.repeat(64),
  });

  const selfRegisterKey = (raw: string) => schemas.PORTAL_REDIS_KEYS.selfRegisterToken(tokens.hashPortalCapabilityToken(raw));

  it('self_register: concurrent consumes against real Redis — exactly one wins', async () => {
    const redis = redisMod.getRedis()!;
    const fields = selfRegisterFields();
    const raw = (await tokens.issuePortalSelfRegistrationToken(fields))!;
    expect(raw).toEqual(expect.any(String));

    // Stored in Redis under its own key family, hashed, with the 30-minute TTL.
    const key = selfRegisterKey(raw);
    expect(key.startsWith('portal:self-register:')).toBe(true);
    expect(await redis.exists(key)).toBe(1);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(schemas.SELF_REGISTER_TTL_SECONDS - 60);
    expect(ttl).toBeLessThanOrEqual(schemas.SELF_REGISTER_TTL_SECONDS);
    expect(await redis.get(key)).not.toContain(raw);

    const results = await Promise.all(Array.from({ length: 20 }, () => tokens.consumePortalSelfRegistrationToken(raw)));
    const winners = results.filter((r) => r !== null);
    expect(winners).toEqual([{
      v: 2,
      purpose: 'self_register',
      orgId: fields.orgId,
      email: fields.email.toLowerCase(),
      name: 'Pat Person',
      domain: 'selfreg.example.com',
      policyFingerprint: fields.policyFingerprint,
    }]);
    expect(await redis.exists(key)).toBe(0);
    expect(await tokens.consumePortalSelfRegistrationToken(raw)).toBeNull();
  });

  it('a self_register token is not found by the invite/reset consumers (real Redis)', async () => {
    const redis = redisMod.getRedis()!;
    const raw = (await tokens.issuePortalSelfRegistrationToken(selfRegisterFields()))!;
    const key = selfRegisterKey(raw);

    expect(await tokens.peekPortalCapabilityToken('invite', raw)).toBeNull();
    expect(await tokens.consumePortalCapabilityToken('invite', raw)).toBeNull();
    expect(await tokens.consumePortalCapabilityToken('reset', raw)).toBeNull();
    expect(await tokens.consumePortalCapabilityTokenByHash('invite', tokens.hashPortalCapabilityToken(raw))).toBeNull();
    // They looked in their own key families, so the link is neither found nor burned.
    expect(await redis.exists(key)).toBe(1);
    expect(await tokens.consumePortalSelfRegistrationToken(raw)).toMatchObject({ purpose: 'self_register' });

    // And the other way: an invite token is not a self-registration link.
    const invite = (await tokens.issuePortalCapabilityToken({
      purpose: 'invite', portalUserId: randomUUID(), orgId: randomUUID(), email: 'pat@selfreg.example.com', authEpoch: 1,
    }))!;
    expect(await tokens.consumePortalSelfRegistrationToken(invite)).toBeNull();
    expect(await redis.exists(schemas.PORTAL_REDIS_KEYS.inviteToken(tokens.hashPortalCapabilityToken(invite)))).toBe(1);
    expect(await tokens.consumePortalCapabilityToken('invite', invite)).toMatchObject({ format: 'v2', payload: { purpose: 'invite' } });
  });

  it('a payload planted under the other family\'s key is refused by purpose (and burned)', async () => {
    const redis = redisMod.getRedis()!;
    const raw = `planted-${randomUUID()}`;
    const hash = tokens.hashPortalCapabilityToken(raw);
    const selfPayload = JSON.stringify({ v: 2, purpose: 'self_register', ...selfRegisterFields() });
    const invitePayload = JSON.stringify({
      v: 2, purpose: 'invite', portalUserId: randomUUID(), orgId: randomUUID(), email: 'pat@selfreg.example.com', authEpoch: 1,
    });

    await redis.set(schemas.PORTAL_REDIS_KEYS.inviteToken(hash), selfPayload, 'EX', 60);
    await redis.set(schemas.PORTAL_REDIS_KEYS.resetToken(hash), selfPayload, 'EX', 60);
    await redis.set(schemas.PORTAL_REDIS_KEYS.selfRegisterToken(hash), invitePayload, 'EX', 60);

    expect(await tokens.consumePortalCapabilityToken('invite', raw)).toBeNull();
    expect(await tokens.consumePortalCapabilityToken('reset', raw)).toBeNull();
    expect(await tokens.consumePortalSelfRegistrationToken(raw)).toBeNull();
    expect(await redis.exists(
      schemas.PORTAL_REDIS_KEYS.inviteToken(hash),
      schemas.PORTAL_REDIS_KEYS.resetToken(hash),
      schemas.PORTAL_REDIS_KEYS.selfRegisterToken(hash),
    )).toBe(0);
  });
});
