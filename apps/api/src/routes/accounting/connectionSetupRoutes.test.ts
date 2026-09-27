import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type MiddlewareHandler } from 'hono';

const m = vi.hoisted(() => ({
  gate: vi.fn((): Response | null => null),
  loadPendingGrant: vi.fn(),
  discard: vi.fn(),
  release: vi.fn(async () => ({ removed: 1, kept: 0, failed: 0 })),
  finalize: vi.fn(),
  claim: vi.fn(),
  options: vi.fn(),
  audit: vi.fn(),
  capture: vi.fn(),
  withAuthDbAccessContext: vi.fn(async (_a: unknown, fn: () => unknown) => fn()),
}));
vi.mock('./providerGate', () => ({ providerGateResponse: m.gate }));
vi.mock('../../middleware/auth', () => ({ withAuthDbAccessContext: m.withAuthDbAccessContext }));
vi.mock('../../db', () => ({
  db: {},
  hasDbAccessContext: () => false,
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));
vi.mock('../../services/accounting/accountingTenantSelection', async (orig) => ({
  ...(await orig<typeof import('../../services/accounting/accountingTenantSelection')>()),
  loadPendingGrant: m.loadPendingGrant,
  discardPendingTenantSelection: m.discard,
  releaseUnchosenTenants: m.release,
}));
vi.mock('../../services/accounting/accountingTenantSelectionStore', () => ({ claimPendingTenant: m.claim }));
vi.mock('./connectFinalize', async (orig) => ({
  ...(await orig<typeof import('./connectFinalize')>()),
  finalizeConnection: m.finalize,
}));
vi.mock('../../services/accounting/accountingSettingsOptions', () => ({ listProviderSettingsOptions: m.options }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: m.audit }));
vi.mock('../../services/sentry', () => ({ captureException: m.capture, captureMessage: vi.fn() }));

import { registerConnectionSetupRoutes } from './connectionSetupRoutes';
import {
  AccountingTenantSelectionError, TENANT_PICK_TOKEN_MARGIN_MS,
} from '../../services/accounting/accountingTenantSelection';
import { AccountingProviderError } from '../../services/accounting/accountingProviderError';
import { AccountingMappingError } from '../../services/accounting/accountingMappingService';

const AUTH = { scope: 'partner', partnerId: 'p1', user: { id: 'u1' } };
const EVT = 'evt-00001';
const TOKEN_EXPIRES_AT = new Date('2030-01-01T00:30:00Z');

let mfaPasses = true;
const pass: MiddlewareHandler = async (_c, next) => next();
const mfa: MiddlewareHandler = async (c, next) => (mfaPasses ? next() : c.json({ error: 'MFA required' }, 403));

function app() {
  const router = new Hono();
  router.use('*', async (c, next) => { c.set('auth' as never, AUTH as never); await next(); });
  registerConnectionSetupRoutes(router, { auth: [pass, pass], mfa, resolvePartnerId: () => ({ partnerId: 'p1' }) });
  return router;
}
const t = (id: string, type = 'ORGANISATION') => ({ tenantId: `ten-${id}`, connectionRef: `conn-${id}`, name: id, tenantType: type, authEventId: EVT });
const grant = (realmId: string | null = null) => ({
  row: { id: 'row-1', realmId, accessTokenExpiresAt: TOKEN_EXPIRES_AT },
  selection: { connectableTenantType: 'ORGANISATION' },
  accessToken: 'at', authEventId: EVT, tenants: [t('A'), t('B'), t('P', 'PRACTICEMANAGER')], grantFingerprint: 'fp-A',
});
const post = (path: string, body?: unknown) => app().request(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const finalizeRunsPersist = () => m.finalize.mockImplementation(
  async (_c: unknown, i: { persist: () => Promise<{ id: string }> }) => ({ ok: true, connection: await i.persist() }),
);

beforeEach(() => {
  vi.clearAllMocks();
  mfaPasses = true;
  m.gate.mockReturnValue(null);
  m.loadPendingGrant.mockResolvedValue(grant());
  m.release.mockResolvedValue({ removed: 1, kept: 0, failed: 0 });
});

describe('GET /:provider/tenants', () => {
  it('lists only connectable organisations from this auth event, with the pick deadline', async () => {
    const res = await app().request('/xero/tenants');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ tenantId: 'ten-A', name: 'A' }, { tenantId: 'ten-B', name: 'B' }],
      // The pick must land inside the ORIGINAL token's life minus the margin loadPendingGrant enforces.
      expiresAt: new Date(TOKEN_EXPIRES_AT.getTime() - TENANT_PICK_TOKEN_MARGIN_MS).toISOString(),
    });
    expect(m.loadPendingGrant).toHaveBeenCalledWith('p1', 'xero', expect.any(Function));
  });

  it('reads the pending row through the request\'s own auth runner (self-managed route)', async () => {
    await app().request('/xero/tenants');
    const runner = m.loadPendingGrant.mock.calls[0]![2] as <T>(fn: () => Promise<T>) => Promise<T>;
    await runner(async () => 'x');
    expect(m.withAuthDbAccessContext).toHaveBeenCalledWith(AUTH, expect.any(Function));
  });

  it('maps selection errors to their status and code', async () => {
    m.loadPendingGrant.mockRejectedValueOnce(new AccountingTenantSelectionError('tenant_selection_expired', 409, 'expired'));
    const res = await app().request('/xero/tenants');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'expired', code: 'tenant_selection_expired' });
  });

  it('a throttled organisation lookup answers 429 with Retry-After (shared mapper), not a 500', async () => {
    m.loadPendingGrant.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'rate_limited', provider: 'xero', operation: 'Xero connections list', message: 'x', retryAfterMs: 9000,
    }));
    const res = await app().request('/xero/tenants');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('9');
    expect(await res.json()).toMatchObject({ code: 'rate_limited' });
    expect(m.capture).not.toHaveBeenCalled();
  });

  it('any other provider failure is a 502 provider_error that leaks no upstream text', async () => {
    m.loadPendingGrant.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'transient', provider: 'xero', operation: 'Xero connections list', message: 'upstream body secret',
    }));
    const res = await app().request('/xero/tenants');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('provider_error');
    expect(JSON.stringify(body)).not.toContain('upstream body secret');
    expect(m.capture).toHaveBeenCalledTimes(1);
  });

  it('the provider gate runs first (unregistered / no connect capability → its response)', async () => {
    m.gate.mockReturnValueOnce(new Response(JSON.stringify({ code: 'capability_unavailable' }), { status: 409 }));
    expect((await app().request('/xero/tenants')).status).toBe(409);
    expect(m.gate).toHaveBeenCalledWith(expect.anything(), 'xero', 'connect');
    expect(m.loadPendingGrant).not.toHaveBeenCalled();
  });
});

describe('POST /:provider/tenants/select', () => {
  it('claims the chosen tenant in the request runner, then releases the rest of THIS auth event\'s links keeping the chosen one', async () => {
    finalizeRunsPersist();
    m.claim.mockResolvedValue({ kind: 'claimed', connection: { id: 'row-1' } });
    const res = await post('/xero/tenants/select', { tenantId: 'ten-B' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(m.finalize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: 'xero', partnerId: 'p1', realmId: 'ten-B', prior: { known: true, realmId: null },
    }));
    expect(m.claim).toHaveBeenCalledWith(expect.anything(), {
      connectionId: 'row-1', partnerId: 'p1', provider: 'xero',
      realmId: 'ten-B', providerConnectionRef: 'conn-B', resetRealmFacts: true, grantFingerprint: 'fp-A',
    });
    expect(m.withAuthDbAccessContext).toHaveBeenCalledWith(AUTH, expect.any(Function));
    expect(m.release).toHaveBeenCalledWith({
      provider: 'xero', accessToken: 'at', tenants: grant().tenants, keepConnectionRef: 'conn-B', context: 'select',
    });
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'accounting.connection.tenant_selected', resourceId: 'row-1',
    }));
  });

  it('a reconnect picking its OWN prior tenant keeps the realm facts', async () => {
    m.loadPendingGrant.mockResolvedValue(grant('ten-A'));
    finalizeRunsPersist();
    m.claim.mockResolvedValue({ kind: 'claimed', connection: { id: 'row-1' } });
    await post('/xero/tenants/select', { tenantId: 'ten-A' });
    expect(m.finalize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prior: { known: true, realmId: 'ten-A' } }));
    expect(m.claim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resetRealmFacts: false }));
  });

  it('refuses a tenant outside the grant, and a non-organisation tenant (400 tenant_not_in_grant)', async () => {
    const outside = await post('/xero/tenants/select', { tenantId: 'ten-ELSEWHERE' });
    expect(outside.status).toBe(400);
    expect((await outside.json()).code).toBe('tenant_not_in_grant');
    expect((await post('/xero/tenants/select', { tenantId: 'ten-P' })).status).toBe(400);
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.release).not.toHaveBeenCalled();
  });

  it('requires MFA', async () => {
    mfaPasses = false;
    expect((await post('/xero/tenants/select', { tenantId: 'ten-A' })).status).toBe(403);
    expect(m.loadPendingGrant).not.toHaveBeenCalled();
  });

  it('rejects a body without tenantId (400)', async () => {
    expect((await post('/xero/tenants/select', {})).status).toBe(400);
    expect(m.loadPendingGrant).not.toHaveBeenCalled();
  });

  it('Review Focus 1: a tenant another partner holds → 409 accounting_tenant_held, no release, row stays pending', async () => {
    m.finalize.mockResolvedValue({ ok: false, error: 'tenant_held' });
    const res = await post('/xero/tenants/select', { tenantId: 'ten-A' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This Xero organisation is connected to another Breeze account', code: 'accounting_tenant_held' });
    expect(m.release).not.toHaveBeenCalled();
    expect(m.discard).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('a persist failure is a 500 persist_failed, nothing released', async () => {
    m.finalize.mockResolvedValue({ ok: false, error: 'persist_failed' });
    const res = await post('/xero/tenants/select', { tenantId: 'ten-A' });
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('persist_failed');
    expect(m.release).not.toHaveBeenCalled();
  });

  it('a claim that lost the race (row no longer pending) → 409 no_pending_selection', async () => {
    finalizeRunsPersist();
    m.claim.mockResolvedValue({ kind: 'not_pending' });
    const res = await post('/xero/tenants/select', { tenantId: 'ten-A' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_pending_selection');
    expect(m.release).not.toHaveBeenCalled();
  });

  it('a newer callback replaced the grant between load and claim → 409 grant_superseded, nothing released', async () => {
    finalizeRunsPersist();
    m.claim.mockResolvedValue({ kind: 'grant_superseded' });
    const res = await post('/xero/tenants/select', { tenantId: 'ten-A' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('grant_superseded');
    // Grant A's token must not be used to delete links once B owns the row.
    expect(m.release).not.toHaveBeenCalled();
  });

  it('a failed release after a successful claim still answers connected (best-effort)', async () => {
    finalizeRunsPersist();
    m.claim.mockResolvedValue({ kind: 'claimed', connection: { id: 'row-1' } });
    m.release.mockRejectedValueOnce(new Error('held check blew up'));
    const res = await post('/xero/tenants/select', { tenantId: 'ten-B' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(m.capture).toHaveBeenCalledTimes(1);
  });
});

describe('POST /:provider/tenants/cancel', () => {
  it('discards the pending selection and audits it', async () => {
    m.discard.mockResolvedValue({ discarded: true });
    const res = await post('/xero/tenants/cancel');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(m.discard).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'p1', provider: 'xero', reason: 'cancel', runInDbContext: expect.any(Function) }));
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'accounting.connection.tenant_selection_cancelled' }));
  });

  it('F13: gates WITHOUT requiring configuration, so a pending row is never stranded on an unconfigured instance', async () => {
    m.discard.mockResolvedValue({ discarded: true });
    await post('/xero/tenants/cancel');
    expect(m.gate).toHaveBeenCalledWith(expect.anything(), 'xero', 'connect', { requireConfigured: false });
  });

  it('404 no_pending_selection when nothing is pending, and no audit', async () => {
    m.discard.mockResolvedValue({ discarded: false });
    const res = await post('/xero/tenants/cancel');
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('no_pending_selection');
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('requires MFA', async () => {
    mfaPasses = false;
    expect((await post('/xero/tenants/cancel')).status).toBe(403);
    expect(m.discard).not.toHaveBeenCalled();
  });
});

describe('GET /:provider/settings/options', () => {
  it('returns the provider options', async () => {
    const options = { organisation: { name: 'Demo', isDemoCompany: true }, incomeAccounts: [], taxRates: [], bankAccounts: [] };
    m.options.mockResolvedValueOnce(options);
    const res = await app().request('/xero/settings/options');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: options });
    expect(m.options).toHaveBeenCalledWith({ partnerId: 'p1', provider: 'xero' }, expect.any(Function));
  });

  it('rate_limited becomes 429 with a Retry-After header (shared mapper)', async () => {
    m.options.mockRejectedValueOnce(new AccountingMappingError('rate_limited', 429, 'Xero is rate limiting requests; try again shortly', { retryAfterMs: 9000 }));
    const res = await app().request('/xero/settings/options');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('9');
    expect(await res.json()).toEqual({ error: 'Xero is rate limiting requests; try again shortly', code: 'rate_limited' });
  });

  it('typed mapping errors keep their status and code', async () => {
    m.options.mockRejectedValueOnce(new AccountingMappingError('not_connected', 404, 'Xero is not connected'));
    const res = await app().request('/xero/settings/options');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Xero is not connected', code: 'not_connected' });
  });
});
