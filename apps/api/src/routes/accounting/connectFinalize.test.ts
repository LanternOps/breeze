import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getConnection: vi.fn(),
  resetConnectionForRealmChange: vi.fn(async () => ({ mappingsDeleted: 3, owedPaymentDeletes: { count: 0, remoteEntityIds: [] as string[] } })),
  updateHomeCurrency: vi.fn(async () => new Date()),
  updateMultiCurrencyEnabled: vi.fn(async () => undefined),
  fetchRealmSettings: vi.fn(async (): Promise<{ homeCurrency: string | null; multiCurrencyEnabled: boolean | null }> => ({ homeCurrency: 'NZD', multiCurrencyEnabled: false })),
  writeRouteAudit: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock('../../db', () => ({ db: {}, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../../services/accounting/accountingConnectionService', async (orig) => ({
  ...(await orig<typeof import('../../services/accounting/accountingConnectionService')>()),
  getConnection: m.getConnection, resetConnectionForRealmChange: m.resetConnectionForRealmChange,
  updateHomeCurrency: m.updateHomeCurrency, updateMultiCurrencyEnabled: m.updateMultiCurrencyEnabled,
}));
vi.mock('../../services/accounting/providerRegistry', () => ({
  getAccountingProvider: () => ({ displayName: 'Xero', fetchRealmSettings: m.fetchRealmSettings }),
  findAccountingProvider: () => null,
  providerSupports: () => false,
  accountingProviderDisplayName: (id: string) => ({ quickbooks: 'QuickBooks', xero: 'Xero' } as Record<string, string>)[id] ?? id,
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: m.writeRouteAudit }));
vi.mock('../../services/sentry', () => ({ captureException: m.captureException, captureMessage: m.captureMessage }));

import { connectRedirectPath, finalizeConnection, homeCurrencyField, readPriorRealm } from './connectFinalize';
import { AccountingProviderConflictError, AccountingTenantHeldError } from '../../services/accounting/accountingConnectionService';
import { AccountingProviderError } from '../../services/accounting/accountingProviderError';
import { AccountingTenantSelectionError } from '../../services/accounting/accountingTenantSelection';

const c = {} as any;
const conn = { id: 'c1', partnerId: 'p1', provider: 'xero', updatedAt: new Date() } as any;
beforeEach(() => {
  vi.clearAllMocks();
  m.fetchRealmSettings.mockResolvedValue({ homeCurrency: 'NZD', multiCurrencyEnabled: false });
});

describe('connectRedirectPath (QuickBooks strings byte-identical)', () => {
  it.each([
    [{ kind: 'connected' }, '/integrations?accounting=quickbooks&connected=1#accounting'],
    [{ kind: 'error', error: 'exchange_failed' }, '/integrations?accounting=quickbooks&error=exchange_failed#accounting'],
    [{ kind: 'error', error: 'persist_failed' }, '/integrations?accounting=quickbooks&error=persist_failed#accounting'],
    [{ kind: 'error', error: 'provider_conflict' }, '/integrations?accounting=quickbooks&error=provider_conflict#accounting'],
  ] as const)('%j', (outcome, path) => { expect(connectRedirectPath('quickbooks', outcome)).toBe(path); });
  it('select_tenant for Xero', () => {
    expect(connectRedirectPath('xero', { kind: 'select_tenant' })).toBe('/integrations?accounting=xero&select_tenant=1#accounting');
  });
});

describe('homeCurrencyField', () => {
  it('keeps (undefined) on a known same-realm reconnect, clears (null) otherwise', () => {
    expect(homeCurrencyField({ known: true, realmId: 't1' }, 't1')).toBeUndefined();
    expect(homeCurrencyField({ known: true, realmId: 't1' }, 't2')).toBeNull();
    expect(homeCurrencyField({ known: false, realmId: null }, 't1')).toBeNull();
  });
});

describe('readPriorRealm', () => {
  it('reads the partner row\'s realm; a failed read is "unknown" (fail closed) and reported', async () => {
    m.getConnection.mockResolvedValueOnce({ realmId: 't1' });
    await expect(readPriorRealm(c, 'p1', 'xero')).resolves.toEqual({ known: true, realmId: 't1' });
    m.getConnection.mockResolvedValueOnce(null);
    await expect(readPriorRealm(c, 'p1', 'xero')).resolves.toEqual({ known: true, realmId: null });
    m.getConnection.mockRejectedValueOnce(new Error('db down'));
    await expect(readPriorRealm(c, 'p1', 'xero')).resolves.toEqual({ known: false, realmId: null });
    expect(m.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('finalizeConnection', () => {
  it.each([
    [new AccountingProviderConflictError('quickbooks', 'xero'), 'provider_conflict'],
    [new AccountingTenantHeldError('xero'), 'tenant_held'],
    [new Error('db'), 'persist_failed'],
  ])('maps a persist failure %s → %s and runs no capture', async (err, code) => {
    await expect(finalizeConnection(c, { provider: 'xero', partnerId: 'p1', realmId: 't1', prior: { known: true, realmId: null }, persist: async () => { throw err; } }))
      .resolves.toEqual({ ok: false, error: code });
    expect(m.fetchRealmSettings).not.toHaveBeenCalled();
    expect(m.resetConnectionForRealmChange).not.toHaveBeenCalled();
  });

  it('only an unexpected persist failure is Sentry-captured (conflict / held are user outcomes)', async () => {
    const run = (err: Error) => finalizeConnection(c, { provider: 'xero', partnerId: 'p1', realmId: 't1', prior: { known: true, realmId: null }, persist: async () => { throw err; } });
    await run(new AccountingTenantHeldError('xero'));
    await run(new AccountingProviderConflictError('quickbooks', 'xero'));
    expect(m.captureException).not.toHaveBeenCalled();
    await run(new Error('db'));
    expect(m.captureException).toHaveBeenCalledTimes(1);
  });

  it('a known realm change resets mappings and audits it; then captures settings', async () => {
    const result = await finalizeConnection(c, { provider: 'xero', partnerId: 'p1', realmId: 't2', prior: { known: true, realmId: 't1' }, persist: async () => conn });
    expect(result).toEqual({ ok: true, connection: conn });
    expect(m.resetConnectionForRealmChange).toHaveBeenCalledWith(expect.anything(), 'c1', 'p1');
    expect(m.writeRouteAudit).toHaveBeenCalledWith(c, expect.objectContaining({ action: 'accounting.connection.realm_changed' }));
    expect(m.updateHomeCurrency).toHaveBeenCalledWith(expect.anything(), 'c1', 'p1', expect.objectContaining({ realmId: 't2' }), 'NZD');
  });

  it('a picker claim error (AccountingTenantSelectionError) is RETHROWN, never flattened to persist_failed (review O)', async () => {
    const err = new AccountingTenantSelectionError('grant_superseded', 409, 'superseded');
    await expect(finalizeConnection(c, { provider: 'xero', partnerId: 'p1', realmId: 't1', prior: { known: true, realmId: null }, persist: async () => { throw err; } }))
      .rejects.toBe(err);
    expect(m.captureException).not.toHaveBeenCalled();
    expect(m.resetConnectionForRealmChange).not.toHaveBeenCalled();
  });

  it('a SAME-tenant reconnect never resets (mappings, cursor and default refs survive) (review J)', async () => {
    await finalizeConnection(c, { provider: 'xero', partnerId: 'p1', realmId: 't1', prior: { known: true, realmId: 't1' }, persist: async () => conn });
    expect(m.resetConnectionForRealmChange).not.toHaveBeenCalled();
    expect(m.writeRouteAudit).not.toHaveBeenCalledWith(c, expect.objectContaining({ action: 'accounting.connection.realm_changed' }));
  });

  it('a pending→connected first pick (prior realm null) does not reset', async () => {
    await finalizeConnection(c, { provider: 'xero', partnerId: 'p1', realmId: 't1', prior: { known: true, realmId: null }, persist: async () => conn });
    expect(m.resetConnectionForRealmChange).not.toHaveBeenCalled();
  });

  it('an unknown prior realm never resets (never destroy mappings on a guess)', async () => {
    await finalizeConnection(c, { provider: 'xero', partnerId: 'p1', realmId: 't1', prior: { known: false, realmId: null }, persist: async () => conn });
    expect(m.resetConnectionForRealmChange).not.toHaveBeenCalled();
  });

  it('a settings capture that fails on a plain provider Error (e.g. missing tenant id) is non-fatal and reported', async () => {
    m.fetchRealmSettings.mockRejectedValueOnce(new Error('Xero connection is missing a tenant id'));
    await expect(finalizeConnection(c, { provider: 'xero', partnerId: 'p1', realmId: 't1', prior: { known: true, realmId: null }, persist: async () => conn }))
      .resolves.toEqual({ ok: true, connection: conn });
    expect(m.captureException).toHaveBeenCalledTimes(1);
    expect(m.updateHomeCurrency).not.toHaveBeenCalled();
  });

  it('a THROTTLED settings capture is not Sentry-captured (W01c F7 guard moved with the tail)', async () => {
    m.fetchRealmSettings.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'rate_limited', provider: 'xero', operation: 'fetchRealmSettings', retryAfterMs: 5_000, throttleSource: 'provider',
    }));
    await expect(finalizeConnection(c, { provider: 'xero', partnerId: 'p1', realmId: 't1', prior: { known: true, realmId: null }, persist: async () => conn }))
      .resolves.toEqual({ ok: true, connection: conn });
    expect(m.captureException).not.toHaveBeenCalled();
  });
});
