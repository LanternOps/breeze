import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Redis from 'ioredis';
import {
  TECH_SESSION_SLIDING_TTL_SECONDS,
  TECH_SESSION_MAX_LIFETIME_MS,
  TECH_SESSION_KEYS,
  mintTechSession,
  getTechSession,
  revokeTechSessionsForUser,
} from './techSession';

function createRedisMock() {
  return {
    setex: vi.fn(() => Promise.resolve('OK')),
    get: vi.fn(),
    del: vi.fn(() => Promise.resolve(1)),
    sadd: vi.fn(() => Promise.resolve(1)),
    expire: vi.fn(() => Promise.resolve(1)),
    smembers: vi.fn(() => Promise.resolve([] as string[])),
  } as unknown as Redis & {
    setex: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    sadd: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    smembers: ReturnType<typeof vi.fn>;
  };
}

describe('techSession', () => {
  let redis: ReturnType<typeof createRedisMock>;

  beforeEach(() => {
    redis = createRedisMock();
  });

  it('mint stores JSON payload under techaddin:session:<48-char token> with the sliding TTL and adds the token to the user set', async () => {
    const { token, expiresInSeconds } = await mintTechSession(redis, {
      userId: 'user-1',
      partnerId: 'partner-1',
      bindingId: 'binding-1',
    });

    expect(token).toHaveLength(48);
    expect(expiresInSeconds).toBe(TECH_SESSION_SLIDING_TTL_SECONDS);

    expect(redis.setex).toHaveBeenCalledTimes(1);
    const call = redis.setex.mock.calls[0] as [string, number, string];
    const [sessionKey, ttl, rawPayload] = call;
    expect(sessionKey).toBe(TECH_SESSION_KEYS.session(token));
    expect(sessionKey.startsWith('techaddin:session:')).toBe(true);
    expect(ttl).toBe(TECH_SESSION_SLIDING_TTL_SECONDS);

    const payload = JSON.parse(rawPayload as string);
    expect(payload).toMatchObject({
      userId: 'user-1',
      partnerId: 'partner-1',
      bindingId: 'binding-1',
    });
    expect(typeof payload.createdAt).toBe('string');

    expect(redis.sadd).toHaveBeenCalledWith(TECH_SESSION_KEYS.userSessions('user-1'), token);
    expect(redis.expire).toHaveBeenCalledWith(
      TECH_SESSION_KEYS.userSessions('user-1'),
      TECH_SESSION_SLIDING_TTL_SECONDS * 2
    );
  });

  it('getTechSession returns the payload and re-EXPIREs the session key (sliding TTL)', async () => {
    const payload = {
      userId: 'user-1',
      partnerId: 'partner-1',
      bindingId: 'binding-1',
      createdAt: new Date().toISOString(),
    };
    redis.get.mockResolvedValue(JSON.stringify(payload));

    const result = await getTechSession(redis, 'some-token');

    expect(result).toEqual(payload);
    expect(redis.expire).toHaveBeenCalledWith(
      TECH_SESSION_KEYS.session('some-token'),
      TECH_SESSION_SLIDING_TTL_SECONDS
    );
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('getTechSession returns null for an unknown token', async () => {
    redis.get.mockResolvedValue(null);

    const result = await getTechSession(redis, 'unknown-token');

    expect(result).toBeNull();
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('getTechSession deletes the key, logs it (never the value) and returns null on unparseable JSON', async () => {
    redis.get.mockResolvedValue('{not json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await getTechSession(redis, 'corrupt-token');

    expect(result).toBeNull();
    expect(redis.del).toHaveBeenCalledWith(TECH_SESSION_KEYS.session('corrupt-token'));
    expect(redis.expire).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0]!.join(' ');
    expect(logged).toContain(TECH_SESSION_KEYS.session('corrupt-token'));
    expect(logged).not.toContain('{not json'); // the untrusted value must never be logged
    errSpy.mockRestore();
  });

  it.each([
    ['non-object JSON', JSON.stringify('a string')],
    ['missing bindingId', JSON.stringify({ userId: 'u', partnerId: 'p', createdAt: new Date().toISOString() })],
    ['empty userId', JSON.stringify({ userId: '', partnerId: 'p', bindingId: 'b', createdAt: new Date().toISOString() })],
    ['non-string createdAt', JSON.stringify({ userId: 'u', partnerId: 'p', bindingId: 'b', createdAt: 123 })],
  ])('getTechSession deletes the key and returns null on a shape-invalid payload (%s)', async (_name, raw) => {
    redis.get.mockResolvedValue(raw);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await getTechSession(redis, 'bad-shape-token');

    expect(result).toBeNull();
    expect(redis.del).toHaveBeenCalledWith(TECH_SESSION_KEYS.session('bad-shape-token'));
    expect(redis.expire).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('getTechSession deletes the key and returns null past the absolute lifetime', async () => {
    const staleCreatedAt = new Date(Date.now() - TECH_SESSION_MAX_LIFETIME_MS - 1000).toISOString();
    const payload = {
      userId: 'user-1',
      partnerId: 'partner-1',
      bindingId: 'binding-1',
      createdAt: staleCreatedAt,
    };
    redis.get.mockResolvedValue(JSON.stringify(payload));

    const result = await getTechSession(redis, 'expired-token');

    expect(result).toBeNull();
    expect(redis.del).toHaveBeenCalledWith(TECH_SESSION_KEYS.session('expired-token'));
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('revokeTechSessionsForUser deletes every token in the user set plus the set itself', async () => {
    redis.smembers.mockResolvedValue(['tok-a', 'tok-b']);

    await revokeTechSessionsForUser(redis, 'user-1');

    expect(redis.smembers).toHaveBeenCalledWith(TECH_SESSION_KEYS.userSessions('user-1'));
    expect(redis.del).toHaveBeenCalledWith(
      TECH_SESSION_KEYS.session('tok-a'),
      TECH_SESSION_KEYS.session('tok-b')
    );
    expect(redis.del).toHaveBeenCalledWith(TECH_SESSION_KEYS.userSessions('user-1'));
  });

  it('revokeTechSessionsForUser deletes only the set when the user has no sessions', async () => {
    redis.smembers.mockResolvedValue([]);

    await revokeTechSessionsForUser(redis, 'user-1');

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(TECH_SESSION_KEYS.userSessions('user-1'));
  });
});
