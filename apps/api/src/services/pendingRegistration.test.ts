import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory Redis stand-in. `getdel` deletes-on-read synchronously inside the
// callback body (no interleaving await before the delete), so two concurrent
// consumes resolve to exactly one winner — the property under test.
const store = new Map<string, string>();
const fakeRedis = {
  setex: vi.fn(async (key: string, _ttl: number, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  del: vi.fn(async (key: string) => {
    const existed = store.delete(key);
    return existed ? 1 : 0;
  }),
  getdel: vi.fn(async (key: string) => {
    const value = store.get(key) ?? null;
    if (value !== null) store.delete(key);
    return value;
  }),
  // Models real Redis Lua-script semantics: the whole callback body runs as
  // one uninterrupted step (no internal await), same as the server executing
  // a script atomically — this is what lets the concurrency test below
  // actually exercise interleaving-vs-not, rather than just asserting on
  // call counts.
  eval: vi.fn(async (_script: string, numKeys: number, ...rest: string[]) => {
    const keys = rest.slice(0, numKeys);
    const argv = rest.slice(numKeys);
    const [emailIndexKey, newPendingKey] = keys as [string, string];
    const [prefix, , jsonValue, tokenHash] = argv as [string, string, string, string];
    const prevHash = store.get(emailIndexKey) ?? null;
    if (prevHash) {
      store.delete(`${prefix}${prevHash}`);
    }
    store.set(newPendingKey, jsonValue);
    store.set(emailIndexKey, tokenHash);
    return prevHash;
  }),
};

const getRedisMock = vi.fn(() => fakeRedis as never);
vi.mock('./redis', () => ({
  getRedis: () => getRedisMock(),
}));

import {
  createPendingRegistration,
  consumePendingRegistration,
  peekPendingRegistration,
} from './pendingRegistration';

const baseRecord = {
  email: 'new@corp.com',
  companyName: 'Acme',
  name: 'Admin',
  passwordHash: 'argon2-hash',
  acceptTerms: true,
  termsVersion: 'v1',
  hostedExpectation: true,
  signupIp: '203.0.113.7',
  signupUserAgent: 'Mozilla/5.0 (signup)',
};

describe('pendingRegistration service', () => {
  beforeEach(() => {
    store.clear();
    fakeRedis.setex.mockClear();
    fakeRedis.get.mockClear();
    fakeRedis.del.mockClear();
    fakeRedis.getdel.mockClear();
    fakeRedis.eval.mockClear();
    getRedisMock.mockReturnValue(fakeRedis as never);
  });

  it('mints a >=256-bit raw token and a 64-hex sha256 hash', async () => {
    const { rawToken, tokenHash } = await createPendingRegistration(baseRecord);
    // base64url of 32 random bytes decodes back to exactly 32 bytes.
    expect(Buffer.from(rawToken, 'base64url').length).toBe(32);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores the record at pending-reg:<sha256> with a 3600s TTL', async () => {
    const { tokenHash } = await createPendingRegistration(baseRecord);
    // The record write + the email→token supersession index write happen
    // inside the single atomic eval call (see SUPERSEDE_AND_STORE_SCRIPT).
    expect(fakeRedis.eval).toHaveBeenCalledTimes(1);
    const evalCall = fakeRedis.eval.mock.calls[0]!;
    expect(evalCall[5]).toBe('3600');
    const stored = await peekPendingRegistration(tokenHash);
    expect(stored).toMatchObject({ ...baseRecord });
    expect(typeof stored?.createdAt).toBe('number');
    // The raw token lives INSIDE the value (never in the queue job) so the
    // worker can build the verification URL after a peek.
    expect(typeof stored?.rawToken).toBe('string');
  });

  it('peek is non-consuming and exposes rawToken; a subsequent consume still wins', async () => {
    const { rawToken, tokenHash } = await createPendingRegistration(baseRecord);
    const peeked = await peekPendingRegistration(tokenHash);
    expect(peeked?.email).toBe('new@corp.com');
    expect(peeked?.rawToken).toBe(rawToken);
    // Still present after peek.
    const consumed = await consumePendingRegistration(tokenHash);
    expect(consumed?.email).toBe('new@corp.com');
  });

  it('consume is single-winner under concurrency: one record, one null', async () => {
    const { tokenHash } = await createPendingRegistration(baseRecord);
    const [a, b] = await Promise.all([
      consumePendingRegistration(tokenHash),
      consumePendingRegistration(tokenHash),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    const losers = [a, b].filter((r) => r === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });

  it('createPendingRegistration throws (fails closed) when Redis is unavailable', async () => {
    getRedisMock.mockReturnValueOnce(null as never);
    await expect(createPendingRegistration(baseRecord)).rejects.toThrow();
  });

  // As the recommended default: a second step-1 call for the SAME normalized email must supersede the
  // first — only the latest requester's record (and password hash) may ever
  // be confirmed by a click.
  describe('per-email supersession', () => {
    it('invalidates an OLDER pending registration for the same normalized email', async () => {
      const first = await createPendingRegistration({ ...baseRecord, passwordHash: 'first-requester-hash' });
      const second = await createPendingRegistration({ ...baseRecord, passwordHash: 'real-requester-hash' });

      expect(await consumePendingRegistration(first.tokenHash)).toBeNull();
      const winner = await consumePendingRegistration(second.tokenHash);
      expect(winner?.passwordHash).toBe('real-requester-hash');
    });

    it('is case/whitespace-insensitive on the email (matches the route\'s own normalization)', async () => {
      const first = await createPendingRegistration({ ...baseRecord, email: 'Person@Corp.com ', passwordHash: 'first-hash' });
      const second = await createPendingRegistration({ ...baseRecord, email: ' person@corp.com', passwordHash: 'second-hash' });

      expect(await consumePendingRegistration(first.tokenHash)).toBeNull();
      const winner = await consumePendingRegistration(second.tokenHash);
      expect(winner?.passwordHash).toBe('second-hash');
    });

    it('does not affect a pending registration for a DIFFERENT email', async () => {
      const other = await createPendingRegistration({ ...baseRecord, email: 'someone-else@corp.com', passwordHash: 'other-hash' });
      await createPendingRegistration({ ...baseRecord, email: 'new@corp.com', passwordHash: 'unrelated-hash' });

      const stillGood = await consumePendingRegistration(other.tokenHash);
      expect(stillGood?.passwordHash).toBe('other-hash');
    });

    it('three registrations in a row: only the third (latest) confirms', async () => {
      const a = await createPendingRegistration({ ...baseRecord, passwordHash: 'a' });
      const b = await createPendingRegistration({ ...baseRecord, passwordHash: 'b' });
      const c = await createPendingRegistration({ ...baseRecord, passwordHash: 'c' });

      expect(await consumePendingRegistration(a.tokenHash)).toBeNull();
      expect(await consumePendingRegistration(b.tokenHash)).toBeNull();
      expect((await consumePendingRegistration(c.tokenHash))?.passwordHash).toBe('c');
    });

    // Two step-1 calls for the SAME normalized email, issued close enough
    // together to race: with a non-atomic supersession (separate GET, DEL,
    // SETEX, SETEX round-trips), both calls can read "no previous token"
    // before either writes the email index, so neither ever deletes the
    // other's record and both stay independently live/confirmable — the
    // exact two-live-tokens shape supersession exists to prevent. Concurrent
    // Promise.all with a mock that resolves each redis call in its own
    // microtask reproduces the interleaving deterministically.
    it('a race between two concurrent step-1 calls for the same email never leaves more than one token confirmable', async () => {
      const [a, b] = await Promise.all([
        createPendingRegistration({ ...baseRecord, passwordHash: 'racer-a' }),
        createPendingRegistration({ ...baseRecord, passwordHash: 'racer-b' }),
      ]);

      const [peekA, peekB] = await Promise.all([
        peekPendingRegistration(a.tokenHash),
        peekPendingRegistration(b.tokenHash),
      ]);

      const liveCount = [peekA, peekB].filter((record) => record !== null).length;
      expect(liveCount).toBeLessThanOrEqual(1);
    });
  });
});
