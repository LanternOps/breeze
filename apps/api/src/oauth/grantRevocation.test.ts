import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { oauthGrants, oauthRefreshTokens } from '../db/schema';
import { revokeGrant, revokeJti } from './revocationCache';
import { revokeAllUserOauthArtifacts } from './grantRevocation';

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));

vi.mock('./revocationCache', () => ({
  revokeJti: vi.fn(async () => undefined),
  revokeGrant: vi.fn(async () => undefined),
}));

const selectMock = vi.mocked(db.select);
const updateMock = vi.mocked(db.update);
const revokeJtiMock = vi.mocked(revokeJti);
const revokeGrantMock = vi.mocked(revokeGrant);

function mockSelectRows(rows: unknown[]) {
  const where = vi.fn(async () => rows);
  const from = vi.fn(() => ({ where }));
  selectMock.mockReturnValueOnce({ from } as unknown as ReturnType<typeof db.select>);
}

function mockUpdateChain() {
  const where = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where }));
  updateMock.mockReturnValue({ set } as unknown as ReturnType<typeof db.update>);
  return { set, where };
}

describe('revokeAllUserOauthArtifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('revokes each refresh token (DB + jti + grant) and covers dangling grants', async () => {
    const userId = '11111111-1111-1111-1111-111111111111';
    const futureExpiry = new Date(Date.now() + 7 * 24 * 3600 * 1000);

    // First select: refresh tokens.
    mockSelectRows([
      { id: 'rt-1', payload: { jti: 'jti-1', grantId: 'grant-A' }, expiresAt: futureExpiry },
      { id: 'rt-2', payload: { jti: 'jti-2', grantId: 'grant-A' }, expiresAt: futureExpiry }, // same grant
      { id: 'rt-3', payload: { jti: 'jti-3', grantId: 'grant-B' }, expiresAt: futureExpiry },
    ]);
    // Second select: grants (includes a "dangling" grant-C with no active refresh).
    mockSelectRows([{ id: 'grant-A' }, { id: 'grant-B' }, { id: 'grant-C' }]);

    mockUpdateChain();

    const result = await revokeAllUserOauthArtifacts(userId);

    expect(revokeJtiMock).toHaveBeenCalledWith('jti-1', expect.any(Number));
    expect(revokeJtiMock).toHaveBeenCalledWith('jti-2', expect.any(Number));
    expect(revokeJtiMock).toHaveBeenCalledWith('jti-3', expect.any(Number));
    expect(revokeJtiMock).toHaveBeenCalledTimes(3);

    // grant-A should be written once (dedup), grant-B once, grant-C once from dangling pass.
    const grantCalls = revokeGrantMock.mock.calls.map((c) => c[0]);
    expect(grantCalls.sort()).toEqual(['grant-A', 'grant-B', 'grant-C']);

    expect(updateMock).toHaveBeenCalledWith(oauthRefreshTokens);
    expect(result).toEqual({ grantsRevoked: 3, refreshTokensRevoked: 3, jtisRevoked: 3 });
  });

  it('handles user with no refresh tokens but existing grants', async () => {
    const userId = '22222222-2222-2222-2222-222222222222';
    mockSelectRows([]); // no refresh tokens
    mockSelectRows([{ id: 'grant-X' }]);

    const result = await revokeAllUserOauthArtifacts(userId);

    expect(revokeJtiMock).not.toHaveBeenCalled();
    expect(revokeGrantMock).toHaveBeenCalledWith('grant-X', expect.any(Number));
    expect(result.grantsRevoked).toBe(1);
    expect(result.refreshTokensRevoked).toBe(0);
  });

  it('queries the correct tables', async () => {
    mockSelectRows([]);
    mockSelectRows([]);
    await revokeAllUserOauthArtifacts('33333333-3333-3333-3333-333333333333');
    const fromCalls = selectMock.mock.results.map((r) => {
      const from = (r.value as { from: ReturnType<typeof vi.fn> }).from;
      return from.mock.calls[0]?.[0];
    });
    expect(fromCalls).toContain(oauthRefreshTokens);
    expect(fromCalls).toContain(oauthGrants);
  });

  it('propagates revokeJti cache failures', async () => {
    const userId = '44444444-4444-4444-4444-444444444444';
    mockSelectRows([
      { id: 'rt-1', payload: { jti: 'jti-1', grantId: 'grant-A' }, expiresAt: new Date(Date.now() + 60_000) },
    ]);
    mockUpdateChain();
    revokeJtiMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(revokeAllUserOauthArtifacts(userId)).rejects.toThrow(/redis down/);
  });

  it('propagates revokeGrant cache failures', async () => {
    const userId = '55555555-5555-5555-5555-555555555555';
    mockSelectRows([]);
    mockSelectRows([{ id: 'grant-X' }]);
    revokeGrantMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(revokeAllUserOauthArtifacts(userId)).rejects.toThrow(/redis down/);
  });
});
