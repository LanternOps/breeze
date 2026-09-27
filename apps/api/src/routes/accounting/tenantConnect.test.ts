import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  selection: {
    connectableTenantType: 'ORGANISATION',
    authEventIdOf: vi.fn(),
    listGrantTenants: vi.fn(),
    listAllTenants: vi.fn(),
    removeTenantConnection: vi.fn(),
  },
  finalizeConnection: vi.fn(),
  readPriorRealm: vi.fn(),
  upsertConnection: vi.fn(),
  releaseUnchosenTenants: vi.fn(async () => ({ removed: 0, kept: 0, failed: 0 })),
  captureException: vi.fn(),
}));
vi.mock('../../db', () => ({ db: {}, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../../services/accounting/providerRegistry', () => ({
  getAccountingProvider: () => ({ provider: 'xero', displayName: 'Xero', tenantSelection: m.selection, connectEnvironment: () => 'production' }),
  findAccountingProvider: () => null,
  providerSupports: () => false,
  accountingProviderDisplayName: (id: string) => ({ quickbooks: 'QuickBooks', xero: 'Xero' } as Record<string, string>)[id] ?? id,
}));
vi.mock('./connectFinalize', async (orig) => ({
  ...(await orig<typeof import('./connectFinalize')>()),
  finalizeConnection: m.finalizeConnection, readPriorRealm: m.readPriorRealm,
}));
vi.mock('../../services/accounting/accountingConnectionService', async (orig) => ({
  ...(await orig<typeof import('../../services/accounting/accountingConnectionService')>()),
  upsertConnection: m.upsertConnection,
}));
vi.mock('../../services/accounting/accountingTenantSelection', async (orig) => ({
  ...(await orig<typeof import('../../services/accounting/accountingTenantSelection')>()),
  releaseUnchosenTenants: m.releaseUnchosenTenants,
}));
vi.mock('../../services/sentry', () => ({ captureException: m.captureException, captureMessage: vi.fn() }));

import { completeTenantSelectingCallback } from './tenantConnect';
import { AccountingProviderConflictError } from '../../services/accounting/accountingConnectionService';

const EVT = 'evt-00001';
const tokens = { realmId: '', accessToken: 'at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() + 1_800_000), refreshTokenExpiresAt: new Date(Date.now() + 86_400_000) };
const t = (id: string, type = 'ORGANISATION') => ({ tenantId: `ten-${id}`, connectionRef: `conn-${id}`, name: id, tenantType: type, authEventId: EVT });
const input = { provider: 'xero' as const, tokens, partnerId: 'p1', userId: 'u1' };
const c = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.selection.authEventIdOf.mockReturnValue(EVT);
  m.selection.listGrantTenants.mockReset();
  m.selection.listAllTenants.mockReset();
  m.readPriorRealm.mockResolvedValue({ known: true, realmId: null });
  m.finalizeConnection.mockImplementation(async (_c: unknown, i: { persist: () => Promise<unknown> }) => ({ ok: true, connection: await i.persist() }));
  m.upsertConnection.mockReset();
  m.upsertConnection.mockResolvedValue({ id: 'c1' });
});

describe('completeTenantSelectingCallback', () => {
  it('Review Focus 4: a missing auth-event claim fails closed — no /connections call, no persist, no release', async () => {
    m.selection.authEventIdOf.mockReturnValue(null);
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'auth_event_missing' });
    expect(m.selection.authEventIdOf).toHaveBeenCalledWith('at');
    expect(m.selection.listGrantTenants).not.toHaveBeenCalled();
    expect(m.selection.listAllTenants).not.toHaveBeenCalled();
    expect(m.selection.removeTenantConnection).not.toHaveBeenCalled();
    expect(m.upsertConnection).not.toHaveBeenCalled();
    expect(m.finalizeConnection).not.toHaveBeenCalled();
    expect(m.releaseUnchosenTenants).not.toHaveBeenCalled();
  });

  it('lists ONLY this flow\'s auth event on a first connect', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('A')]);
    await completeTenantSelectingCallback(c, input);
    expect(m.selection.listGrantTenants).toHaveBeenCalledWith('at', EVT);
  });

  it('exactly one organisation auto-selects, stores the connection ref, and releases the other links', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('A'), t('P', 'PRACTICEMANAGER')]);
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'connected' });
    expect(m.upsertConnection).toHaveBeenCalledWith(expect.anything(), 'p1', 'xero', expect.objectContaining({
      realmId: 'ten-A', providerConnectionRef: 'conn-A', status: 'connected', environment: 'production',
      accessToken: 'at', refreshToken: 'rt', connectedBy: 'u1', lastError: null, homeCurrency: null,
    }));
    expect(m.finalizeConnection).toHaveBeenCalledWith(c, expect.objectContaining({ provider: 'xero', partnerId: 'p1', realmId: 'ten-A' }));
    expect(m.releaseUnchosenTenants).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'xero', accessToken: 'at', keepConnectionRef: 'conn-A', tenants: [t('A'), t('P', 'PRACTICEMANAGER')], context: 'callback',
    }));
    expect(m.selection.listAllTenants).not.toHaveBeenCalled(); // no prior realm → no unfiltered read
  });

  it('several organisations park the row as pending_tenant with no realm and release nothing', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('A'), t('B')]);
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'select_tenant' });
    const fields = m.upsertConnection.mock.calls[0]![3];
    expect(fields).toMatchObject({ status: 'pending_tenant', providerConnectionRef: null, accessToken: 'at' });
    expect(fields).not.toHaveProperty('realmId');
    expect(m.finalizeConnection).not.toHaveBeenCalled();
    expect(m.releaseUnchosenTenants).not.toHaveBeenCalled();
  });

  it('zero organisations → no_organisation, and every link from this flow is released', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('P', 'PRACTICEMANAGER')]);
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'no_organisation' });
    expect(m.releaseUnchosenTenants).toHaveBeenCalledWith(expect.objectContaining({ keepConnectionRef: null, tenants: [t('P', 'PRACTICEMANAGER')] }));
    expect(m.upsertConnection).not.toHaveBeenCalled();
  });

  it('refinement 2: a reconnect keeps the partner\'s OWN tenant even when the filtered list is empty', async () => {
    m.readPriorRealm.mockResolvedValue({ known: true, realmId: 'ten-OWN' });
    m.selection.listGrantTenants.mockResolvedValue([]);
    m.selection.listAllTenants.mockResolvedValue([t('OTHER'), { ...t('OWN'), authEventId: 'evt-OLD00' }]);
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'connected' });
    expect(m.upsertConnection).toHaveBeenCalledWith(expect.anything(), 'p1', 'xero', expect.objectContaining({ realmId: 'ten-OWN', providerConnectionRef: 'conn-OWN' }));
    // Only this flow's (empty) links are candidates for removal — never the unfiltered list.
    expect(m.releaseUnchosenTenants).toHaveBeenCalledWith(expect.objectContaining({ tenants: [] }));
  });

  it('refinement 2: the unfiltered list is never a source of a DIFFERENT tenant (own gone → falls back to this grant)', async () => {
    m.readPriorRealm.mockResolvedValue({ known: true, realmId: 'ten-OWN' });
    m.selection.listGrantTenants.mockResolvedValue([]);
    m.selection.listAllTenants.mockResolvedValue([t('OTHER')]);
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'no_organisation' });
    expect(m.upsertConnection).not.toHaveBeenCalled();
  });

  it('refinement 2: the own tenant must still be a connectable type', async () => {
    m.readPriorRealm.mockResolvedValue({ known: true, realmId: 'ten-OWN' });
    m.selection.listGrantTenants.mockResolvedValue([]);
    m.selection.listAllTenants.mockResolvedValue([t('OWN', 'PRACTICEMANAGER')]);
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'no_organisation' });
    expect(m.upsertConnection).not.toHaveBeenCalled();
  });

  it('Review Focus 1/2: a single-org grant whose tenant another partner holds → tenant_held; nothing kept for it', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('HELD')]);
    m.finalizeConnection.mockResolvedValue({ ok: false, error: 'tenant_held' });
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'tenant_held' });
    // keep=null: the held check (system scope) is what spares the other partner's tenant.
    expect(m.releaseUnchosenTenants).toHaveBeenCalledWith(expect.objectContaining({ keepConnectionRef: null, tenants: [t('HELD')] }));
  });

  it('a pending park that hits another provider\'s row → provider_conflict, links released', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('A'), t('B')]);
    m.upsertConnection.mockRejectedValue(new AccountingProviderConflictError('quickbooks', 'xero'));
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'provider_conflict' });
    expect(m.releaseUnchosenTenants).toHaveBeenCalledWith(expect.objectContaining({ keepConnectionRef: null }));
    expect(m.captureException).not.toHaveBeenCalled();
  });

  it('a pending park that fails unexpectedly → persist_failed, reported, links released', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('A'), t('B')]);
    m.upsertConnection.mockRejectedValue(new Error('db'));
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'persist_failed' });
    expect(m.releaseUnchosenTenants).toHaveBeenCalledWith(expect.objectContaining({ keepConnectionRef: null }));
    expect(m.captureException).toHaveBeenCalledTimes(1);
  });

  it('a release that throws never changes a successful connect (best-effort, reported)', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('A'), t('P', 'PRACTICEMANAGER')]);
    m.releaseUnchosenTenants.mockRejectedValueOnce(new Error('ambient context'));
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'connected' });
    expect(m.captureException).toHaveBeenCalledTimes(1);
  });

  it('a /connections failure → tenant_lookup_failed, nothing persisted', async () => {
    m.selection.listGrantTenants.mockRejectedValue(new Error('503'));
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'tenant_lookup_failed' });
    expect(m.upsertConnection).not.toHaveBeenCalled();
    expect(m.releaseUnchosenTenants).not.toHaveBeenCalled();
  });

  it('an unfiltered-lookup failure on reconnect → tenant_lookup_failed, nothing persisted, this flow\'s links released (held-checked)', async () => {
    m.readPriorRealm.mockResolvedValue({ known: true, realmId: 'ten-OWN' });
    m.selection.listGrantTenants.mockResolvedValue([t('NEW')]);
    m.selection.listAllTenants.mockRejectedValue(new Error('503'));
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'tenant_lookup_failed' });
    expect(m.upsertConnection).not.toHaveBeenCalled();
    expect(m.releaseUnchosenTenants).toHaveBeenCalledWith(expect.objectContaining({ keepConnectionRef: null, tenants: [t('NEW')] }));
  });
});
