import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock, redisStore, ttls, getRedisMock } = vi.hoisted(() => {
  const redisStore = new Map<string, string>();
  const ttls = new Map<string, number>();
  const redisMock = {
    setex: vi.fn(async (k: string, ttl: number, v: string) => {
      redisStore.set(k, v);
      ttls.set(k, ttl);
    }),
    get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
    getdel: vi.fn(async (k: string) => {
      const v = redisStore.get(k) ?? null;
      redisStore.delete(k);
      ttls.delete(k);
      return v;
    }),
  };
  const getRedisMock = vi.fn<() => typeof redisMock | null>(() => redisMock);
  return { redisMock, redisStore, ttls, getRedisMock };
});

vi.mock('./redis', () => ({ getRedis: getRedisMock }));

import { mintStepUpGrant, validateStepUpGrant, consumeStepUpGrant } from './mfaStepUpGrant';

const bind = (operation: 'add_factor' | 'register_approver_device') => ({
  userId: 'user-1',
  operation,
  authEpoch: 1,
  mfaEpoch: 2,
  sid: 'sid-1',
});

describe('mfaStepUpGrant', () => {
  beforeEach(() => {
    redisStore.clear();
    ttls.clear();
    vi.clearAllMocks();
    getRedisMock.mockReturnValue(redisMock);
  });

  describe('mintStepUpGrant', () => {
    it('writes mfa:stepup:<id> with a 300s TTL and returns the id', async () => {
      const b = bind('add_factor');
      const id = await mintStepUpGrant(b);
      expect(id).toBeTruthy();
      const key = `mfa:stepup:${id}`;
      expect(redisStore.has(key)).toBe(true);
      expect(ttls.get(key)).toBe(300);
      expect(JSON.parse(redisStore.get(key)!)).toEqual(b);
    });

    it('returns null when Redis is down', async () => {
      getRedisMock.mockReturnValue(null);
      const id = await mintStepUpGrant(bind('add_factor'));
      expect(id).toBeNull();
    });
  });

  describe('validateStepUpGrant', () => {
    it('returns false when the id does not exist', async () => {
      const ok = await validateStepUpGrant('nonexistent-id', bind('add_factor'));
      expect(ok).toBe(false);
    });

    it.each([
      ['userId', { ...bind('add_factor'), userId: 'other-user' }],
      ['authEpoch', { ...bind('add_factor'), authEpoch: 999 }],
      ['mfaEpoch', { ...bind('add_factor'), mfaEpoch: 999 }],
      ['sid', { ...bind('add_factor'), sid: 'other-sid' }],
    ])('returns false on a %s mismatch', async (_field, mismatchedBind) => {
      const id = await mintStepUpGrant(bind('add_factor'));
      const ok = await validateStepUpGrant(id!, mismatchedBind);
      expect(ok).toBe(false);
    });

    it('returns false when Redis is null', async () => {
      const id = await mintStepUpGrant(bind('add_factor'));
      getRedisMock.mockReturnValue(null);
      const ok = await validateStepUpGrant(id!, bind('add_factor'));
      expect(ok).toBe(false);
    });
  });

  describe('consumeStepUpGrant', () => {
    it('returns false on a single-field mismatch (sid)', async () => {
      const id = await mintStepUpGrant(bind('add_factor'));
      const ok = await consumeStepUpGrant(id!, { ...bind('add_factor'), sid: 'other-sid' });
      expect(ok).toBe(false);
    });

    it('returns false when Redis is null', async () => {
      const id = await mintStepUpGrant(bind('add_factor'));
      getRedisMock.mockReturnValue(null);
      const ok = await consumeStepUpGrant(id!, bind('add_factor'));
      expect(ok).toBe(false);
    });
  });
});

describe('mfaStepUpGrant operation isolation', () => {
  beforeEach(() => {
    redisStore.clear();
    ttls.clear();
    vi.clearAllMocks();
    getRedisMock.mockReturnValue(redisMock);
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
    // getdel deletes on mismatch — pinning current behavior: the failed
    // cross-operation consume attempt above still destroys the register
    // grant, so even a subsequent same-operation validate below also fails.
    await expect(consumeStepUpGrant(register!, bind('add_factor'))).resolves.toBe(false);
    await expect(validateStepUpGrant(register!, bind('register_approver_device'))).resolves.toBe(false);
  });

  it('validate is non-consuming', async () => {
    const id = await mintStepUpGrant(bind('register_approver_device'));
    await expect(validateStepUpGrant(id!, bind('register_approver_device'))).resolves.toBe(true);
    await expect(validateStepUpGrant(id!, bind('register_approver_device'))).resolves.toBe(true);
    // Non-consuming: the record is still present afterward.
    expect(redisStore.has(`mfa:stepup:${id}`)).toBe(true);
  });
});
