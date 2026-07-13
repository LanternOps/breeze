import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthGrants, oauthRefreshTokens } from '../db/schema';
import { revokeGrant, revokeJti } from './revocationCache';
import { revokeAllOrgOauthArtifacts, revokeAllPartnerOauthArtifacts, revokeAllUserOauthArtifacts } from './grantRevocation';

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./revocationCache', () => ({
  revokeJti: vi.fn(async () => undefined),
  revokeGrant: vi.fn(async () => undefined),
}));

const selectMock = vi.mocked(db.select);
const updateMock = vi.mocked(db.update);
const runOutsideDbContextMock = vi.mocked(runOutsideDbContext);
const withSystemDbAccessContextMock = vi.mocked(withSystemDbAccessContext);
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

    // First select: refresh tokens. Grant discovery no longer reads payload —
    // jti markers key on the token ROW id (Task 3 removes payload.jti), and
    // grants come from the authoritative oauth_grants select below.
    mockSelectRows([
      { id: 'rt-1', expiresAt: futureExpiry },
      { id: 'rt-2', expiresAt: futureExpiry },
      { id: 'rt-3', expiresAt: futureExpiry },
    ]);
    // Second select: grants (authoritative inventory, incl. a code-only grant-C
    // with no active refresh row).
    mockSelectRows([{ id: 'grant-A' }, { id: 'grant-B' }, { id: 'grant-C' }]);

    mockUpdateChain();

    const result = await revokeAllUserOauthArtifacts(userId);

    // jti markers keyed on the token row id, not payload.jti.
    expect(revokeJtiMock).toHaveBeenCalledWith('rt-1', expect.any(Number));
    expect(revokeJtiMock).toHaveBeenCalledWith('rt-2', expect.any(Number));
    expect(revokeJtiMock).toHaveBeenCalledWith('rt-3', expect.any(Number));
    expect(revokeJtiMock).toHaveBeenCalledTimes(3);

    // Every grant from the authoritative oauth_grants select gets a marker,
    // including the code-only grant-C with no refresh row.
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

  it('runs exported revocation helpers in explicit system DB context', async () => {
    mockSelectRows([]);
    mockSelectRows([]);

    await revokeAllUserOauthArtifacts('33333333-3333-3333-3333-333333333333');

    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
  });

  it('revokes partner-wide OAuth artifacts for tenant lifecycle changes', async () => {
    mockSelectRows([
      { id: 'rt-partner', expiresAt: new Date(Date.now() + 60_000) },
    ]);
    mockSelectRows([{ id: 'grant-partner' }]);
    mockUpdateChain();

    const result = await revokeAllPartnerOauthArtifacts('66666666-6666-6666-8666-666666666666');

    expect(revokeJtiMock).toHaveBeenCalledWith('rt-partner', expect.any(Number));
    expect(revokeGrantMock).toHaveBeenCalledWith('grant-partner', expect.any(Number));
    expect(result.refreshTokensRevoked).toBe(1);
  });

  it('revokes org-wide OAuth artifacts for tenant lifecycle changes', async () => {
    mockSelectRows([
      { id: 'rt-org', expiresAt: new Date(Date.now() + 60_000) },
    ]);
    mockSelectRows([{ id: 'grant-org' }]);
    mockUpdateChain();

    const result = await revokeAllOrgOauthArtifacts('77777777-7777-7777-8777-777777777777');

    expect(revokeJtiMock).toHaveBeenCalledWith('rt-org', expect.any(Number));
    expect(revokeGrantMock).toHaveBeenCalledWith('grant-org', expect.any(Number));
    expect(result.refreshTokensRevoked).toBe(1);
  });

  it('propagates revokeJti cache failures', async () => {
    const userId = '44444444-4444-4444-4444-444444444444';
    mockSelectRows([
      { id: 'rt-1', expiresAt: new Date(Date.now() + 60_000) },
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
