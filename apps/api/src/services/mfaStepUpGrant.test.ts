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

import { mintStepUpGrant, validateStepUpGrant, consumeStepUpGrant, rollbackResourceDigest, maintenanceResourceDigest } from './mfaStepUpGrant';

const bind = (operation: 'add_factor' | 'register_approver_device') => ({
  userId: 'user-1',
  operation,
  authEpoch: 1,
  mfaEpoch: 2,
  sid: 'sid-1',
	resourceDigest: '',
});

describe('rollbackResourceDigest', () => {
  it('hashes canonical rollback identity bytes', () => {
    expect(rollbackResourceDigest({ deviceId: 'device-1', currentVersion: '2.0.0', targetVersion: '1.9.0', reason: 'incident rollback' }))
      .toBe('sha256:2debd6cc76cd6b29a8a60e445bb2241e462a264a2448e2a59b7f9c72e282829f');
  });
});

// RMM-QA-176 D11 (T13): the maintenance digest is the ONE canonicalizer both
// the mint route and the maintenance routes call. Its canonical form is part
// of the security contract — a grant minted for one device set, reason and
// window must never validate for another, and two callers describing the SAME
// operator intent must produce byte-identical input.
describe('maintenanceResourceDigest', () => {
  const base = { deviceIds: ['b-2', 'a-1'], reason: '  scheduled patching  ', durationHours: 4 };

  it('is insensitive to deviceIds order', () => {
    expect(maintenanceResourceDigest({ ...base, deviceIds: ['a-1', 'b-2'] }))
      .toBe(maintenanceResourceDigest({ ...base, deviceIds: ['b-2', 'a-1'] }));
  });

  it('is insensitive to duplicate deviceIds', () => {
    expect(maintenanceResourceDigest({ ...base, deviceIds: ['a-1', 'b-2', 'a-1'] }))
      .toBe(maintenanceResourceDigest({ ...base, deviceIds: ['a-1', 'b-2'] }));
  });

  it('trims reason so the mint route and the maintenance route cannot disagree', () => {
    expect(maintenanceResourceDigest(base))
      .toBe(maintenanceResourceDigest({ ...base, reason: 'scheduled patching' }));
  });

  it('binds durationHours \u2014 a longer window is a different grant', () => {
    expect(maintenanceResourceDigest({ ...base, durationHours: 8 }))
      .not.toBe(maintenanceResourceDigest(base));
  });

  it('binds the device set \u2014 adding a device is a different grant', () => {
    expect(maintenanceResourceDigest({ ...base, deviceIds: ['a-1', 'b-2', 'c-3'] }))
      .not.toBe(maintenanceResourceDigest(base));
  });

  it('binds the reason \u2014 a different justification is a different grant', () => {
    expect(maintenanceResourceDigest({ ...base, reason: 'hardware swap' }))
      .not.toBe(maintenanceResourceDigest(base));
  });

  it('emits the sha256: prefixed shape the grant store compares literally', () => {
    expect(maintenanceResourceDigest(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
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

    it('fails closed when the Redis write rejects', async () => {
      redisMock.setex.mockRejectedValueOnce(new Error('redis write failed'));
      await expect(mintStepUpGrant(bind('add_factor'))).resolves.toBeNull();
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

    it('fails closed after expiry and on a Redis read error', async () => {
      const id = await mintStepUpGrant(bind('add_factor'));
      redisStore.delete(`mfa:stepup:${id}`);
      await expect(validateStepUpGrant(id!, bind('add_factor'))).resolves.toBe(false);
      redisMock.get.mockRejectedValueOnce(new Error('redis read failed'));
      await expect(validateStepUpGrant('any-id', bind('add_factor'))).resolves.toBe(false);
    });
  });

  describe('consumeStepUpGrant', () => {
    it('returns false on a single-field mismatch (sid)', async () => {
      const id = await mintStepUpGrant(bind('add_factor'));
      const ok = await consumeStepUpGrant(id!, { ...bind('add_factor'), sid: 'other-sid' });
      expect(ok).toBe(false);
    });

		it('binds an agent rollback grant to the exact resource and consumes it once under parallel replay', async () => {
			const rollbackBind = { ...bind('add_factor'), operation: 'agent_rollback' as const, resourceDigest: 'sha256:resource-a' };
			const id = await mintStepUpGrant(rollbackBind);
			await expect(validateStepUpGrant(id!, { ...rollbackBind, resourceDigest: 'sha256:resource-b' })).resolves.toBe(false);
			const outcomes = await Promise.all(Array.from({ length: 8 }, () => consumeStepUpGrant(id!, rollbackBind)));
			expect(outcomes.filter(Boolean)).toHaveLength(1);
		});

    it('returns false when Redis is null', async () => {
      const id = await mintStepUpGrant(bind('add_factor'));
      getRedisMock.mockReturnValue(null);
      const ok = await consumeStepUpGrant(id!, bind('add_factor'));
      expect(ok).toBe(false);
    });

    it('fails closed when Redis getdel rejects', async () => {
      redisMock.getdel.mockRejectedValueOnce(new Error('redis consume failed'));
      await expect(consumeStepUpGrant('any-id', bind('add_factor'))).resolves.toBe(false);
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
