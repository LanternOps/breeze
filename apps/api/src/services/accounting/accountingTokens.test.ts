import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    updateTokens: vi.fn(),
    markStatus: vi.fn(),
    provider: { refresh: vi.fn() },
  },
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: <T>(fn: () => T) => fn(),
}));

vi.mock('./accountingConnectionService', () => ({
  updateTokens: mocks.updateTokens,
  markStatus: mocks.markStatus,
}));

vi.mock('./providerRegistry', () => ({
  getAccountingProvider: vi.fn(() => mocks.provider),
}));

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    partnerId: '11111111-1111-1111-1111-111111111111',
    provider: 'quickbooks',
    realmId: 'realm-1',
    accessToken: 'OLD-at',
    refreshToken: 'OLD-rt',
    accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000),
    refreshTokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
    environment: 'production',
    homeCurrency: null,
    defaultIncomeAccountRef: null,
    defaultTaxCodeRef: null,
    pushMode: 'auto',
    status: 'connected',
    createdAt: new Date(),
    updatedAt: new Date(),
    lastError: null,
    ...overrides,
  } as any;
}

describe('accountingTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the existing access token when it is outside the refresh buffer', async () => {
    const { getValidAccessToken } = await import('./accountingTokens');

    const token = await getValidAccessToken({}, connection());

    expect(token).toBe('OLD-at');
    expect(mocks.provider.refresh).not.toHaveBeenCalled();
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  it('persists the rotated refresh token on refresh', async () => {
    const db = {};
    const conn = connection({
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    mocks.provider.refresh.mockResolvedValueOnce({
      realmId: 'realm-1',
      accessToken: 'NEW-at',
      refreshToken: 'NEW-rt',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 8640000_000),
    });

    const { getValidAccessToken } = await import('./accountingTokens');
    const token = await getValidAccessToken(db, conn);

    expect(token).toBe('NEW-at');
    expect(mocks.updateTokens).toHaveBeenCalledWith(
      db,
      conn.id,
      conn.partnerId,
      expect.objectContaining({ refreshToken: 'NEW-rt', accessToken: 'NEW-at' })
    );
  });

  it('marks reauth_required when the refresh token is expired', async () => {
    const conn = connection({
      refreshTokenExpiresAt: new Date(Date.now() - 1000),
    });

    const { getValidAccessToken, ReauthRequiredError } = await import('./accountingTokens');

    await expect(getValidAccessToken({}, conn)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(mocks.markStatus).toHaveBeenCalledWith(
      {},
      conn.id,
      conn.partnerId,
      'reauth_required',
      expect.any(String)
    );
    expect(mocks.provider.refresh).not.toHaveBeenCalled();
  });
});
