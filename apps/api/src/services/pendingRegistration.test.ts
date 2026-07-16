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
  getdel: vi.fn(async (key: string) => {
    const value = store.get(key) ?? null;
    if (value !== null) store.delete(key);
    return value;
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
    fakeRedis.getdel.mockClear();
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
    expect(fakeRedis.setex).toHaveBeenCalledTimes(1);
    const [key, ttl, value] = fakeRedis.setex.mock.calls[0]!;
    expect(key).toBe(`pending-reg:${tokenHash}`);
    expect(ttl).toBe(3600);
    const parsed = JSON.parse(value as string);
    expect(parsed).toMatchObject({ ...baseRecord });
    expect(typeof parsed.createdAt).toBe('number');
    // The raw token lives INSIDE the value (never in the queue job) so the
    // worker can build the verification URL after a peek.
    expect(typeof parsed.rawToken).toBe('string');
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
});
