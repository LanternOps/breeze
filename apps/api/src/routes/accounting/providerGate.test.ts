import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const reg = vi.hoisted(() => ({
  qbo: { provider: 'quickbooks', displayName: 'QuickBooks', configError: vi.fn((): string | null => null),
    capabilities: { connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true } },
  resolveActiveConnectionRef: vi.fn(),
}));
vi.mock('../../services/accounting/providerRegistry', () => ({
  findAccountingProvider: (id: string) => (id === 'quickbooks' ? reg.qbo : null),
  providerSupports: (id: string, cap: string) => id === 'quickbooks' && (reg.qbo.capabilities as any)[cap] === true,
  accountingProviderDisplayName: (id: string) => (id === 'xero' ? 'Xero' : 'QuickBooks'),
  listRegisteredAccountingProviders: () => [reg.qbo],
}));
vi.mock('../../db', () => ({ db: { marker: 'ambient-db' } }));
vi.mock('../../services/accounting/accountingConnectionService', () => ({
  resolveActiveConnectionRef: reg.resolveActiveConnectionRef,
}));
import { listProvidersHandler, providerGateResponse } from './providerGate';

// clearMocks is false project-wide, so a queued mockReturnValueOnce that a test
// never actually consumes (e.g. requireConfigured:false short-circuits before
// calling configError()) would otherwise leak into a later test. Reset to the
// configured-by-default baseline before every test.
beforeEach(() => {
  reg.qbo.configError.mockReset().mockReturnValue(null);
});

function run(provider: 'quickbooks' | 'xero', cap: 'connect' | 'invoicePush', opts?: { requireConfigured?: boolean }) {
  const app = new Hono();
  app.get('/', (c) => providerGateResponse(c, provider, cap, opts) ?? c.json({ ok: true }));
  return app.request('/');
}

describe('providerGateResponse', () => {
  it('lets a registered, capable, configured provider through', async () => {
    expect((await run('quickbooks', 'connect')).status).toBe(200);
  });
  it('refuses an unregistered provider with 409 capability_unavailable', async () => {
    const res = await run('xero', 'connect');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Xero is not available on this instance yet', code: 'capability_unavailable' });
  });
  it('refuses a missing capability with 409 capability_unavailable', async () => {
    (reg.qbo.capabilities as any).invoicePush = false;
    const res = await run('quickbooks', 'invoicePush');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('capability_unavailable');
    (reg.qbo.capabilities as any).invoicePush = true;
  });
  it('returns the provider\'s own explicit config error as 400', async () => {
    reg.qbo.configError.mockReturnValueOnce('QuickBooks OAuth is not configured on this instance');
    const res = await run('quickbooks', 'connect');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'QuickBooks OAuth is not configured on this instance', code: 'provider_not_configured' });
  });
  it('requireConfigured:false lets an unconfigured provider through (DB-only routes)', async () => {
    // requireConfigured:false short-circuits before configError() is ever called,
    // so this is never consumed — mockReturnValue (not -Once) makes that explicit.
    reg.qbo.configError.mockReturnValue('QuickBooks OAuth is not configured on this instance');
    expect((await run('quickbooks', 'connect', { requireConfigured: false })).status).toBe(200);
  });
  it('requireConfigured:false still refuses an unregistered provider', async () => {
    expect((await run('xero', 'connect', { requireConfigured: false })).status).toBe(409);
  });
});

describe('listProvidersHandler', () => {
  function list(partnerId = 'p1') {
    const app = new Hono();
    app.get('/', (c) => listProvidersHandler(c, partnerId));
    return app.request('/');
  }

  it('reads the active connection through the NON-decrypting ref on the ambient db', async () => {
    reg.resolveActiveConnectionRef.mockResolvedValueOnce({ id: 'c1', provider: 'quickbooks', status: 'reauth_required' });
    const res = await list('p1');
    expect(res.status).toBe(200);
    expect(reg.resolveActiveConnectionRef).toHaveBeenCalledWith({ marker: 'ambient-db' }, 'p1');
    expect((await res.json()).activeConnection).toEqual({ provider: 'quickbooks', status: 'reauth_required' });
  });

  it('reports an unconfigured provider as configured:false and no connection as null', async () => {
    reg.resolveActiveConnectionRef.mockResolvedValueOnce(null);
    reg.qbo.configError.mockReturnValueOnce('QuickBooks OAuth is not configured on this instance');
    const res = await list();
    expect(await res.json()).toEqual({
      data: [{ id: 'quickbooks', displayName: 'QuickBooks', configured: false, capabilities: reg.qbo.capabilities }],
      activeConnection: null,
    });
  });
});
