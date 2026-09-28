import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  release: vi.fn(),
  getValidAccessToken: vi.fn(),
  capture: vi.fn(),
  ambient: false,
  impl: null as unknown,
}));
vi.mock('../../db', () => ({ db: {}, hasDbAccessContext: () => m.ambient }));
vi.mock('./accountingTokens', async (orig) => ({
  ...(await orig<typeof import('./accountingTokens')>()),
  getValidAccessToken: m.getValidAccessToken,
}));
vi.mock('./providerRegistry', () => ({ findAccountingProvider: () => m.impl }));
vi.mock('../sentry', () => ({ captureException: m.capture }));

import { releaseProviderConnection } from './accountingProviderRelease';
import { ReauthRequiredError } from './accountingTokens';
import { AccountingProviderError } from './accountingProviderError';

const conn = (over: Record<string, unknown> = {}) => ({
  id: 'c1', partnerId: 'p1', provider: 'xero', providerConnectionRef: 'conn-A', accessToken: 'old', ...over,
}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.ambient = false;
  m.impl = { releaseConnection: m.release };
  m.getValidAccessToken.mockResolvedValue('fresh');
  m.release.mockResolvedValue(undefined);
});

describe('releaseProviderConnection', () => {
  it('releases with a live (refreshed-if-needed) token and the stored connection ref', async () => {
    await expect(releaseProviderConnection(conn())).resolves.toBe('released');
    expect(m.release).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh', providerConnectionRef: 'conn-A' }));
  });

  it('skips a provider with no release hook (QuickBooks) or no stored ref, without touching the token', async () => {
    m.impl = {};
    await expect(releaseProviderConnection(conn())).resolves.toBe('skipped');
    m.impl = null;
    await expect(releaseProviderConnection(conn())).resolves.toBe('skipped');
    m.impl = { releaseConnection: m.release };
    await expect(releaseProviderConnection(conn({ providerConnectionRef: null }))).resolves.toBe('skipped');
    expect(m.getValidAccessToken).not.toHaveBeenCalled();
    expect(m.release).not.toHaveBeenCalled();
  });

  it('never throws: a token or HTTP failure is "failed" and reported', async () => {
    m.getValidAccessToken.mockRejectedValueOnce(new Error('token endpoint 500'));
    await expect(releaseProviderConnection(conn())).resolves.toBe('failed');
    m.release.mockRejectedValueOnce(new Error('503'));
    await expect(releaseProviderConnection(conn())).resolves.toBe('failed');
    expect(m.capture).toHaveBeenCalledTimes(2);
  });

  it('a revoked grant or a throttle is "failed" but not an incident (no Sentry)', async () => {
    m.getValidAccessToken.mockRejectedValueOnce(new ReauthRequiredError());
    await expect(releaseProviderConnection(conn())).resolves.toBe('failed');
    m.release.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'rate_limited', provider: 'xero', operation: 'Xero connection delete', message: 'x', retryAfterMs: 5000,
    }));
    await expect(releaseProviderConnection(conn())).resolves.toBe('failed');
    expect(m.capture).not.toHaveBeenCalled();
  });

  it('refuses to run inside an ambient DB context (it makes an outbound call)', async () => {
    m.ambient = true;
    await expect(releaseProviderConnection(conn())).rejects.toThrow(/NO ambient DB access context/);
    expect(m.release).not.toHaveBeenCalled();
  });
});
