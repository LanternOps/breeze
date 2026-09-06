import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

const redisMock = {
  setex: vi.fn().mockResolvedValue('OK'),
  get: vi.fn().mockResolvedValue(null),
  getdel: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
};

vi.mock('./redis', () => ({
  getRedis: vi.fn(() => redisMock),
}));

import { getRedis } from './redis';
import {
  createSsoPendingLink,
  peekSsoPendingLink,
  consumeSsoPendingLink,
  restoreConsumedSsoPendingLink,
  deleteSsoPendingLink,
  hashSsoPendingLinkToken,
  SSO_PENDING_LINK_TTL_SECONDS,
  type SsoPendingLink,
} from './ssoPendingLink';

const RECORD: Omit<SsoPendingLink, 'createdAt'> = {
  userId: 'user-1',
  userEmail: 'v@example.com',
  authEpoch: 3,
  mfaEpoch: 2,
  browserTransitionId: '00000000-0000-4000-8000-0000000000b1',
  browserGeneration: 7,
  providerId: 'provider-1',
  providerOrgId: 'org-1',
  providerPartnerId: null,
  providerConfigVersion: 5,
  externalSub: 'external-sub-v',
  email: 'v@example.com',
  name: 'V Tech',
  profile: { sub: 'external-sub-v' },
  encryptedAccessToken: 'enc:a',
  encryptedRefreshToken: 'enc:r',
  tokenExpiresAt: '2026-08-26T00:00:00.000Z',
  idpMfaAsserted: false,
  emailVerifiedClaim: 'true',
  redirectUrl: '/dashboard',
};

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.setex.mockResolvedValue('OK');
  redisMock.get.mockResolvedValue(null);
  redisMock.getdel.mockResolvedValue(null);
  redisMock.del.mockResolvedValue(1);
  vi.mocked(getRedis).mockReturnValue(redisMock as any);
});

describe('createSsoPendingLink', () => {
  it('parks the record under the sha256 of a fresh high-entropy token with a 5-minute TTL', async () => {
    const { rawToken } = await createSsoPendingLink(RECORD);

    // >= 256 bits of entropy, URL-safe.
    expect(rawToken.length).toBeGreaterThanOrEqual(43);
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(redisMock.setex).toHaveBeenCalledTimes(1);
    const [key, ttl, value] = redisMock.setex.mock.calls[0]!;
    const expectedHash = createHash('sha256').update(rawToken).digest('hex');
    expect(key).toBe(`sso:pendinglink:${expectedHash}`);
    expect(ttl).toBe(SSO_PENDING_LINK_TTL_SECONDS);
    expect(SSO_PENDING_LINK_TTL_SECONDS).toBe(300);

    const stored = JSON.parse(value);
    expect(stored.userId).toBe('user-1');
    expect(stored.createdAt).toEqual(expect.any(Number));
    // The raw token must NEVER be stored inside the record value.
    expect(value).not.toContain(rawToken);
  });

  it('fails closed when Redis is unavailable', async () => {
    vi.mocked(getRedis).mockReturnValue(null as any);
    await expect(createSsoPendingLink(RECORD)).rejects.toThrow();
  });

  it('mints a distinct token per call', async () => {
    const a = await createSsoPendingLink(RECORD);
    const b = await createSsoPendingLink(RECORD);
    expect(a.rawToken).not.toBe(b.rawToken);
  });
});

describe('peekSsoPendingLink', () => {
  it('returns the parsed record without consuming it', async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({ ...RECORD, createdAt: 1 }));
    const rec = await peekSsoPendingLink('somehash');
    expect(rec?.userId).toBe('user-1');
    expect(redisMock.get).toHaveBeenCalledWith('sso:pendinglink:somehash');
    expect(redisMock.getdel).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('returns null on missing record, unparseable record, or no Redis', async () => {
    expect(await peekSsoPendingLink('missing')).toBeNull();
    redisMock.get.mockResolvedValue('not-json');
    expect(await peekSsoPendingLink('bad')).toBeNull();
    vi.mocked(getRedis).mockReturnValue(null as any);
    expect(await peekSsoPendingLink('nored')).toBeNull();
  });

  it('fails closed on shape drift: a record missing a security binding parses as absent', async () => {
    const { userId: _dropped, ...rest } = { ...RECORD, createdAt: 1 } as Record<string, unknown> & { userId?: string };
    redisMock.get.mockResolvedValue(JSON.stringify(rest));
    expect(await peekSsoPendingLink('drifted')).toBeNull();
  });

  it('normalizes any drifted emailVerifiedClaim to the CONSERVATIVE side (absent → domain re-proof)', async () => {
    // The one field whose drift would otherwise fail OPEN: only the exact
    // literal 'true' may skip the completion-time domain-ownership re-check.
    for (const drifted of [true, 'TRUE', 'false', undefined, 1]) {
      redisMock.get.mockResolvedValue(JSON.stringify({ ...RECORD, createdAt: 1, emailVerifiedClaim: drifted }));
      const rec = await peekSsoPendingLink('h');
      expect(rec?.emailVerifiedClaim).toBe('absent');
    }
    redisMock.get.mockResolvedValue(JSON.stringify({ ...RECORD, createdAt: 1, emailVerifiedClaim: 'true' }));
    expect((await peekSsoPendingLink('h'))?.emailVerifiedClaim).toBe('true');
  });
});

describe('consumeSsoPendingLink', () => {
  it('consumes atomically via GETDEL — exactly one winner', async () => {
    redisMock.getdel.mockResolvedValueOnce(JSON.stringify({ ...RECORD, createdAt: 1 }));
    const winner = await consumeSsoPendingLink('h');
    const loser = await consumeSsoPendingLink('h');
    expect(winner?.userId).toBe('user-1');
    expect(loser).toBeNull();
    expect(redisMock.getdel).toHaveBeenCalledWith('sso:pendinglink:h');
  });
});

describe('restoreConsumedSsoPendingLink', () => {
  it('restores a retryable record only for the unexpired remainder of its window', async () => {
    const record = { ...RECORD, createdAt: Date.now() - 60_000 };
    await expect(restoreConsumedSsoPendingLink('h', record)).resolves.toBe(true);
    expect(redisMock.setex).toHaveBeenCalledWith(
      'sso:pendinglink:h',
      expect.any(Number),
      JSON.stringify(record),
    );
    expect(redisMock.setex.mock.calls.at(-1)?.[1]).toBeLessThanOrEqual(240);
  });

  it('does not revive an expired record', async () => {
    const record = { ...RECORD, createdAt: Date.now() - 301_000 };
    await expect(restoreConsumedSsoPendingLink('h', record)).resolves.toBe(false);
    expect(redisMock.setex).not.toHaveBeenCalled();
  });
});

describe('deleteSsoPendingLink', () => {
  it('removes the record', async () => {
    await deleteSsoPendingLink('h');
    expect(redisMock.del).toHaveBeenCalledWith('sso:pendinglink:h');
  });
});

describe('hashSsoPendingLinkToken', () => {
  it('is a plain sha256 hex digest', () => {
    expect(hashSsoPendingLinkToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });
});
