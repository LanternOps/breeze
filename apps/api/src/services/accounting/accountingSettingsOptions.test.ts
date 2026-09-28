import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ resolve: vi.fn(), options: vi.fn(), capture: vi.fn(), impl: null as unknown }));
vi.mock('./accountingMappingService', async (orig) => ({
  ...(await orig<typeof import('./accountingMappingService')>()),
  resolveConnectionAndToken: m.resolve,
}));
vi.mock('./providerRegistry', () => ({
  getAccountingProvider: () => m.impl,
  accountingProviderDisplayName: () => 'Xero',
}));
vi.mock('../sentry', () => ({ captureException: m.capture, captureMessage: vi.fn() }));

import { listProviderSettingsOptions } from './accountingSettingsOptions';
import { AccountingProviderError } from './accountingProviderError';
import { AccountingMappingError } from './accountingMappingService';

const runner = async <T>(fn: () => Promise<T>) => fn();
const OPTIONS = { organisation: { name: 'Demo', isDemoCompany: true }, incomeAccounts: [], taxRates: [], bankAccounts: [] };

beforeEach(() => {
  vi.clearAllMocks();
  m.impl = { listSettingsOptions: m.options };
  m.resolve.mockResolvedValue({ conn: { provider: 'xero' }, liveConn: { provider: 'xero', accessToken: 'at' } });
});

describe('listProviderSettingsOptions', () => {
  it('returns the provider options, read with the LIVE connection resolved through the caller\'s runner', async () => {
    m.options.mockResolvedValue(OPTIONS);
    await expect(listProviderSettingsOptions({ partnerId: 'p1', provider: 'xero' }, runner))
      .resolves.toMatchObject({ organisation: { isDemoCompany: true } });
    expect(m.resolve).toHaveBeenCalledWith('p1', { provider: 'xero' }, runner);
    expect(m.options).toHaveBeenCalledWith({ provider: 'xero', accessToken: 'at' });
  });

  it('a provider without options is 409 capability_unavailable, before any connection work', async () => {
    m.impl = {};
    await expect(listProviderSettingsOptions({ partnerId: 'p1', provider: 'xero' }, runner))
      .rejects.toMatchObject({ status: 409, code: 'capability_unavailable' });
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it('connection errors (not connected / reauth / token throttle) pass through as typed mapping errors', async () => {
    const notConnected = new AccountingMappingError('not_connected', 404, 'Xero is not connected');
    m.resolve.mockRejectedValueOnce(notConnected);
    await expect(listProviderSettingsOptions({ partnerId: 'p1', provider: 'xero' }, runner)).rejects.toBe(notConnected);
    expect(m.options).not.toHaveBeenCalled();
  });

  it('a provider throttle becomes a 429 rate_limited AccountingMappingError carrying retryAfterMs (callProviderOrThrow), no Sentry', async () => {
    m.options.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'rate_limited', provider: 'xero', operation: 'Xero account list', message: 'x', retryAfterMs: 5000,
    }));
    const err = await listProviderSettingsOptions({ partnerId: 'p1', provider: 'xero' }, runner).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountingMappingError);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfterMs: 5000 });
    expect(m.capture).not.toHaveBeenCalled();
  });

  it('anything else (incl. a plain Error) is a 502 provider_error that leaks no upstream text', async () => {
    m.options.mockRejectedValueOnce(new Error('Xero connection is missing a tenant id'));
    const err = await listProviderSettingsOptions({ partnerId: 'p1', provider: 'xero' }, runner).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'provider_error' });
    expect((err as Error).message).not.toContain('tenant id');
    expect(m.capture).toHaveBeenCalledTimes(1);
  });

  it('a typed Xero validation error (missing tenant id) is also a 502 provider_error that leaks no upstream text', async () => {
    m.options.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'validation', provider: 'xero', operation: 'call context', message: 'Xero connection is missing a tenant id',
    }));
    const err = await listProviderSettingsOptions({ partnerId: 'p1', provider: 'xero' }, runner).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'provider_error' });
    expect((err as Error).message).not.toContain('tenant id');
    expect(m.capture).toHaveBeenCalledTimes(1);
  });
});
