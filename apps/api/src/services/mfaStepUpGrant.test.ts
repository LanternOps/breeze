import { describe, it, expect, beforeEach, vi } from 'vitest';

const redisStore = new Map<string, string>();
const ttls = new Map<string, number>();
let redisDown = false;

vi.mock('./redis', () => ({
  getRedis: () => {
    if (redisDown) return null;
    return {
      setex: vi.fn(async (k: string, ttl: number, v: string) => {
        redisStore.set(k, v);
        ttls.set(k, ttl);
        return 'OK';
      }),
      get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
      getdel: vi.fn(async (k: string) => {
        const v = redisStore.get(k) ?? null;
        redisStore.delete(k);
        ttls.delete(k);
        return v;
      }),
    };
  },
}));

import { mintStepUpGrant, validateStepUpGrant, consumeStepUpGrant } from './mfaStepUpGrant';

const BIND = {
  userId: 'user-1',
  operation: 'add_factor' as const,
  authEpoch: 1,
  mfaEpoch: 2,
  sid: 'family-1',
};

describe('mfaStepUpGrant', () => {
  beforeEach(() => {
    redisStore.clear();
    ttls.clear();
    redisDown = false;
  });

  describe('mintStepUpGrant', () => {
    it('writes mfa:stepup:<id> with a 300s TTL and returns the id', async () => {
      const id = await mintStepUpGrant(BIND);
      expect(id).toBeTruthy();
      const key = `mfa:stepup:${id}`;
      expect(redisStore.has(key)).toBe(true);
      expect(ttls.get(key)).toBe(300);
      expect(JSON.parse(redisStore.get(key)!)).toEqual(BIND);
    });

    it('returns null when Redis is down', async () => {
      redisDown = true;
      const id = await mintStepUpGrant(BIND);
      expect(id).toBeNull();
    });
  });

  describe('validateStepUpGrant', () => {
    it('returns true when the id exists and every bind field matches', async () => {
      const id = await mintStepUpGrant(BIND);
      const ok = await validateStepUpGrant(id!, BIND);
      expect(ok).toBe(true);
      // Non-consuming: the record is still present afterward.
      expect(redisStore.has(`mfa:stepup:${id}`)).toBe(true);
    });

    it('returns false when the id does not exist', async () => {
      const ok = await validateStepUpGrant('nonexistent-id', BIND);
      expect(ok).toBe(false);
    });

    it.each([
      ['userId', { ...BIND, userId: 'other-user' }],
      ['operation', { ...BIND, operation: 'other_op' as unknown as 'add_factor' }],
      ['authEpoch', { ...BIND, authEpoch: 999 }],
      ['mfaEpoch', { ...BIND, mfaEpoch: 999 }],
      ['sid', { ...BIND, sid: 'other-sid' }],
    ])('returns false on a %s mismatch', async (_field, mismatchedBind) => {
      const id = await mintStepUpGrant(BIND);
      const ok = await validateStepUpGrant(id!, mismatchedBind);
      expect(ok).toBe(false);
    });

    it('returns false when Redis is null', async () => {
      const id = await mintStepUpGrant(BIND);
      redisDown = true;
      const ok = await validateStepUpGrant(id!, BIND);
      expect(ok).toBe(false);
    });
  });

  describe('consumeStepUpGrant', () => {
    it('uses getdel and is single-use: a second consume of the same id returns false', async () => {
      const id = await mintStepUpGrant(BIND);
      const first = await consumeStepUpGrant(id!, BIND);
      expect(first).toBe(true);
      const second = await consumeStepUpGrant(id!, BIND);
      expect(second).toBe(false);
    });

    it('returns false on a bind mismatch (and still consumes the record)', async () => {
      const id = await mintStepUpGrant(BIND);
      const ok = await consumeStepUpGrant(id!, { ...BIND, sid: 'other-sid' });
      expect(ok).toBe(false);
    });

    it('returns false when Redis is null', async () => {
      const id = await mintStepUpGrant(BIND);
      redisDown = true;
      const ok = await consumeStepUpGrant(id!, BIND);
      expect(ok).toBe(false);
    });
  });
});
