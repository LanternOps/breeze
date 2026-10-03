vi.mock('../../services/accounting/accountingFeeAbandonment',()=>({abandonAccountingFees:vi.fn().mockResolvedValue(undefined)}));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'crypto';

// The route's signingSecret() falls through APP_ENCRYPTION_KEY/SECRET_ENCRYPTION_KEY/
// SESSION_SECRET to JWT_SECRET, which the api test setup (src/__tests__/setup.ts)
// sets. Mint state with that same ambient secret — do NOT stub env here, or it
// perturbs the shared-worker process.env that secretCrypto reads in sibling tests.
const FIXED_SECRET = 'test-jwt-secret-must-be-at-least-32-characters-long';

// `provider` omitted = a state minted by the pre-W01 image (no provider field).
function mintState(partnerId: string, userId: string | null, exp = Date.now() + 60_000, provider?: string): { state: string; cookie: string } {
  const payload = { partnerId, userId, ...(provider ? { provider } : {}), nonce: 'test-nonce', exp };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', FIXED_SECRET).update(`accounting-oauth:${encoded}`).digest('base64url');
  const state = `${encoded}.${sig}`;
  const cookie = createHmac('sha256', FIXED_SECRET).update(`accounting-oauth-cookie:${state}`).digest('base64url');
  return { state, cookie };
}

const { authState, mocks, AccountingConnectionErrorClass } = vi.hoisted(() => {
  class AccountingConnectionErrorClass extends Error {
    constructor(
      public readonly code: 'not_connected' | 'reauth_required',
      public readonly status: 404 | 409,
      message: string,
    ) {
      super(message);
      this.name = 'AccountingConnectionError';
    }
  }
  return {
    authState: {
      scope: 'partner' as 'partner' | 'system' | 'organization',
      partnerId: '11111111-1111-1111-1111-111111111111' as string | null,
      partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
      mfa: true,
      // Finding D: PATCH /settings must gate pullPayments/pushMode on the same
      // invoices:write the push routes use, so the suite needs a REVOCABLE
      // permission rather than a blanket allow.
      invoicesWrite: true,
    },
    mocks: {
      systemContext:vi.fn(async (fn:()=>unknown,_label?:string)=>fn()),
      autopayEnabled: vi.fn(async () => true),
      dbFeeErrorWhere: vi.fn(async () => [{n:0}]),
      getConnection: vi.fn(),
      resolveActiveConnectionRef: vi.fn(),
      getPartnerConnectionRef: vi.fn(),
      configError: vi.fn((): string | null => null),
      // A vi.fn so the per-route capability table can assert the exact
      // capability each route gates on; the registry mock's default
      // implementation honours the capability argument.
      providerSupports: vi.fn(),
      upsertConnection: vi.fn(),
      deleteConnection: vi.fn(async () => ({
        removed: true,
        connectionId: null as string | null,
        owedPaymentDeletes: { count: 0, remoteEntityIds: [] as string[] },
      })),
      exchangeCode: vi.fn(),
      fetchRealmSettings: vi.fn(),
      updateHomeCurrency: vi.fn(async () => HOME_CURRENCY_WRITTEN_AT),
      updateMultiCurrencyEnabled: vi.fn(),
      refreshRealmSettings: vi.fn(),
      resetConnectionForRealmChange: vi.fn(async () => ({
        mappingsDeleted: 0,
        owedPaymentDeletes: { count: 0, remoteEntityIds: [] as string[] },
      })),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      writeRouteAudit: vi.fn(),
      buildAuthUrl: vi.fn((state: string) => `https://qbo.example.test/connect?scope=com.intuit.quickbooks.accounting&state=${encodeURIComponent(state)}`),
      // Task 5 review fix: POST /:provider/settings/refresh is self-managed
      // (no ambient request tx), so it now wraps refreshRealmSettings in
      // withAuthDbAccessContext. Runs `fn` through so existing behavior is
      // unchanged; asserted directly in the settings/refresh describe block.
      withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => unknown) => fn()),
      // Task 6 — the PATCH /:provider/settings `.returning({...})` row. A
      // separate controllable mock (rather than an inline arrow in the `db`
      // factory below) so individual tests can set what the "update" reports
      // back, same idiom as `updateHomeCurrency` above.
      dbUpdateReturning: vi.fn(async () => [] as Record<string, unknown>[]),
      // Captures the UPDATE's `set` payload so a test can assert what the route
      // actually writes, not just what it echoes back.
      dbUpdateSet: vi.fn(),
      // Xero W02 (Task 7) — a registered tenant-selecting provider stub, so the
      // callback's tenant-selection branch runs through the real route.
      xeroExchangeCode: vi.fn(),
      xeroFetchRealmSettings: vi.fn(),
      xeroListSettingsOptions: vi.fn(),
      xeroReleaseConnection: vi.fn(),
      // Xero W02 (Task 8) — disconnect's provider-side release and the
      // pending_tenant cancel path.
      releaseProviderConnection: vi.fn(),
      discardPendingTenantSelection: vi.fn(),
      xeroSelection: {
        connectableTenantType: 'ORGANISATION',
        authEventIdOf: vi.fn(),
        listGrantTenants: vi.fn(),
        listAllTenants: vi.fn(),
        removeTenantConnection: vi.fn(),
      },
    },
    AccountingConnectionErrorClass,
  };
});

vi.mock('../../services/autopay/autopayGate',()=>({isAutopayEnabledForPartner:mocks.autopayEnabled}));
vi.mock('../../db', () => ({
  db: {
    select:vi.fn(()=>({from:vi.fn(()=>({innerJoin:vi.fn(()=>({where:mocks.dbFeeErrorWhere}))}))})),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        mocks.dbUpdateSet(patch);
        return {
          where: vi.fn(() => ({
            returning: mocks.dbUpdateReturning,
          })),
        };
      }),
    })),
  },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: mocks.systemContext,
  // The callback holds no request DB context (no authMiddleware); the tenant
  // release path asserts exactly that (dbContextGuard).
  hasDbAccessContext: () => false,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.partnerId,
      partnerOrgAccess: authState.partnerOrgAccess,
      orgId: null,
      accessibleOrgIds: [],
      canAccessOrg: vi.fn(() => true),
      user: { id: '33333333-3333-3333-3333-333333333333', email: 'admin@example.com', name: 'Admin' },
      token: { mfa: authState.mfa },
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(authState.scope)) return c.json({ error: 'Insufficient permissions' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!authState.mfa) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
  // The customer import route is permission-gated (organizations:write +
  // sites:write); the read-only customer list instead uses the full-partner
  // capability without those write permissions. This suite covers the
  // OAuth/settings routes, so grant the import permissions here.
  // `invoices:write` is separately revocable — see authState.invoicesWrite.
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (resource === 'invoices' && action === 'write' && !authState.invoicesWrite) {
      return c.json({ error: 'Insufficient permissions' }, 403);
    }
    return next();
  }),
  withAuthDbAccessContext: mocks.withAuthDbAccessContext,
}));

vi.mock('../../services/accounting/accountingConnectionService', async (importOriginal) => ({
  // The REAL conflict / held classes, so their messages are the ones the route returns
  // and connectFinalize's instanceof checks see the same constructors.
  AccountingProviderConflictError: (await importOriginal<typeof import('../../services/accounting/accountingConnectionService')>())
    .AccountingProviderConflictError,
  AccountingTenantHeldError: (await importOriginal<typeof import('../../services/accounting/accountingConnectionService')>())
    .AccountingTenantHeldError,
  PENDING_TENANT_STATUS: 'pending_tenant',
  getConnection: mocks.getConnection,
  resolveActiveConnectionRef: mocks.resolveActiveConnectionRef,
  getPartnerConnectionRef: mocks.getPartnerConnectionRef,
  upsertConnection: mocks.upsertConnection,
  deleteConnection: mocks.deleteConnection,
  updateHomeCurrency: mocks.updateHomeCurrency,
  updateMultiCurrencyEnabled: mocks.updateMultiCurrencyEnabled,
  refreshRealmSettings: mocks.refreshRealmSettings,
  resetConnectionForRealmChange: mocks.resetConnectionForRealmChange,
  AccountingConnectionError: AccountingConnectionErrorClass,
  // Real implementation, not a mock: the route's benign-race branch must key on
  // the error CODE, so the test exercises the real predicate.
  isHomeCurrencyCasAbort: (err: unknown) => typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === 'ACCOUNTING_HOME_CURRENCY_CAS_ABORT',
}));

vi.mock('../../services/accounting/accountingProviderRelease', () => ({
  releaseProviderConnection: mocks.releaseProviderConnection,
}));

// Real error classes (F4): connectFinalize's instanceof checks must see the same constructors.
vi.mock('../../services/accounting/accountingTenantSelection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/accounting/accountingTenantSelection')>()),
  discardPendingTenantSelection: mocks.discardPendingTenantSelection,
}));

vi.mock('../../services/sentry', () => ({
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: mocks.writeRouteAudit,
}));

vi.mock('../../services/accounting/providerRegistry', () => {
  // Only QuickBooks is registered (Xero has no implementation until W02).
  const qbo = {
    provider: 'quickbooks',
    displayName: 'QuickBooks',
    capabilities: { connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true },
    configError: mocks.configError,
    connectEnvironment: () => 'production',
    buildAuthUrl: mocks.buildAuthUrl,
    exchangeCode: mocks.exchangeCode,
    fetchRealmSettings: mocks.fetchRealmSettings,
  };
  // Xero W02 (Task 7): registered for the tenant-selecting callback branch. Its
  // capabilities still come from `mocks.providerSupports` (QuickBooks-only by
  // default), so every existing "xero is refused" assertion is unchanged.
  const xero = {
    provider: 'xero',
    displayName: 'Xero',
    capabilities: { connect: true, mapping: false, customerImport: false, invoicePush: false, paymentPull: false, paymentPush: false },
    configError: () => null,
    connectEnvironment: () => 'production',
    buildAuthUrl: mocks.buildAuthUrl,
    exchangeCode: mocks.xeroExchangeCode,
    fetchRealmSettings: mocks.xeroFetchRealmSettings,
    tenantSelection: mocks.xeroSelection,
    listSettingsOptions: mocks.xeroListSettingsOptions,
    releaseConnection: mocks.xeroReleaseConnection,
  };
  return {
    getAccountingProvider: vi.fn((id: string) => (id === 'xero' ? xero : qbo)),
    findAccountingProvider: (id: string) => (id === 'quickbooks' ? qbo : id === 'xero' ? xero : null),
    providerSupports: (id: string, cap: string) => mocks.providerSupports(id, cap),
    accountingProviderDisplayName: (id: string) => ({ quickbooks: 'QuickBooks', xero: 'Xero' } as Record<string, string>)[id] ?? id,
    listRegisteredAccountingProviders: () => [qbo],
    LEGACY_UNTARGETED_JOB_PROVIDER: 'quickbooks',
  };
});

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { accountingRoutes } from './index';
import { AccountingProviderError } from '../../services/accounting/accountingProviderError';
import { AccountingProviderConflictError, AccountingTenantHeldError } from '../../services/accounting/accountingConnectionService';

const CONNECTION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PERSISTED_AT = new Date('2026-09-04T00:00:00Z');
/**
 * The generation `updateHomeCurrency` reports back after ITS write (it bumps
 * `updated_at`). The multi-currency compare-and-set must chain onto this, not
 * onto `PERSISTED_AT` — deliberately a DIFFERENT instant so a regression back
 * to the pre-write generation fails here instead of passing by coincidence.
 */
const HOME_CURRENCY_WRITTEN_AT = new Date('2026-09-04T00:05:00Z');

function exchangedTokens(realmId = 'realm-A') {
  return {
    realmId,
    accessToken: 'at',
    refreshToken: 'rt',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshTokenExpiresAt: new Date(Date.now() + 8_640_000_000),
  };
}

const QBO_CAPABILITIES: Record<string, boolean> = {
  connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true,
};
const defaultProviderSupports = (id: string, cap: string) => id === 'quickbooks' && QBO_CAPABILITIES[cap] === true;

async function runCallback(app: Hono, realmId = 'realm-A') {
  const { state, cookie } = mintState(authState.partnerId!, '33333333-3333-3333-3333-333333333333');
  return app.request(
    `/accounting/quickbooks/callback?code=abc&realmId=${realmId}&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` } },
  );
}

describe('accounting routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.autopayEnabled.mockResolvedValue(true);
    mocks.dbFeeErrorWhere.mockResolvedValue([{n:0}]);
    authState.scope = 'partner';
    authState.partnerId = '11111111-1111-1111-1111-111111111111';
    authState.partnerOrgAccess = 'all';
    authState.mfa = true;
    authState.invoicesWrite = true;
    app = new Hono();
    app.route('/accounting', accountingRoutes);
    // The callback now reads the persisted row back (multi-currency §11), so the
    // upsert must resolve a real connection for every callback case.
    mocks.upsertConnection.mockResolvedValue({
      id: CONNECTION_ID,
      partnerId: authState.partnerId,
      provider: 'quickbooks',
      realmId: 'realm-A',
      updatedAt: PERSISTED_AT,
      homeCurrency: null,
    });
    mocks.fetchRealmSettings.mockResolvedValue({ homeCurrency: 'CAD', multiCurrencyEnabled: null });
    mocks.resolveActiveConnectionRef.mockResolvedValue(null);
    mocks.getPartnerConnectionRef.mockResolvedValue(null);
    mocks.configError.mockReturnValue(null);
    mocks.providerSupports.mockImplementation(defaultProviderSupports);
    mocks.releaseProviderConnection.mockResolvedValue('skipped');
    mocks.discardPendingTenantSelection.mockResolvedValue({ discarded: false });
  });

  it('connect returns an authUrl containing the QuickBooks accounting scope', async () => {
    const res = await app.request('/accounting/quickbooks/connect');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authUrl).toContain('com.intuit.quickbooks.accounting');
    expect(mocks.buildAuthUrl).toHaveBeenCalledWith(expect.any(String));
  });

  it('status returns connection status without token fields', async () => {
    mocks.getConnection.mockResolvedValueOnce({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      partnerId: authState.partnerId,
      provider: 'quickbooks',
      realmId: 'realm-1',
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh-token',
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
      environment: 'production',
      homeCurrency: null,
      multiCurrencyEnabled: true,
      defaultIncomeAccountRef: null,
      defaultTaxCodeRef: null,
      pushMode: 'auto',
      status: 'connected',
      createdAt: new Date('2026-06-23T00:00:00Z'),
      updatedAt: new Date(),
      lastError: null,
    });

    const res = await app.request('/accounting/quickbooks');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('connected');
    // Captured realm fact (Phase C): exposed on status so the web card need not
    // wait for a settings refresh to render the multi-currency line.
    expect(body.multiCurrencyEnabled).toBe(true);
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('secret-access-token');
  });

  it('callback with a bad state returns 400', async () => {
    const res = await app.request('/accounting/quickbooks/callback?code=abc&realmId=realm-1&state=bad-state');

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('OAuth state') });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
  });

  it('callback is NOT behind authMiddleware (signed state + cookie authenticate it)', async () => {
    mocks.exchangeCode.mockResolvedValueOnce({
      realmId: 'realm-1',
      accessToken: 'at',
      refreshToken: 'rt',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 8_640_000_000),
    });
    const { state, cookie } = mintState(authState.partnerId!, '33333333-3333-3333-3333-333333333333');

    const res = await app.request(
      `/accounting/quickbooks/callback?code=abc&realmId=realm-1&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(mocks.exchangeCode).toHaveBeenCalledWith('abc', 'realm-1');
    expect(mocks.upsertConnection).toHaveBeenCalledWith(
      expect.anything(),
      authState.partnerId,
      'quickbooks',
      expect.objectContaining({
        accessToken: 'at',
        refreshToken: 'rt',
        connectedBy: '33333333-3333-3333-3333-333333333333',
        // Explicit null, never omission: upsertConnection strips undefined from
        // its conflict set, so omitting this carries a PREVIOUS realm's home
        // currency across a reconnect (multi-currency §11).
        homeCurrency: null,
      }),
    );
  });

  it('callback with a valid state but MISSING binding cookie is rejected (CSRF)', async () => {
    const { state } = mintState(authState.partnerId!, null);

    const res = await app.request(
      `/accounting/quickbooks/callback?code=abc&realmId=realm-1&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('binding') });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
  });

  it('callback with a PRESENT but MISMATCHED binding cookie is rejected (CSRF)', async () => {
    const { state } = mintState(authState.partnerId!, null);
    const other = mintState(authState.partnerId!, null, Date.now() + 120_000); // a DIFFERENT state's cookie

    const res = await app.request(
      `/accounting/quickbooks/callback?code=abc&realmId=realm-1&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `breeze_accounting_oauth_state=${other.cookie}` } },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('binding') });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it('callback with an EXPIRED state is rejected', async () => {
    const { state, cookie } = mintState(authState.partnerId!, null, Date.now() - 1000);

    const res = await app.request(
      `/accounting/quickbooks/callback?code=abc&realmId=realm-1&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` } },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('OAuth state') });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it('callback redirects to error=exchange_failed when token exchange throws (no connection persisted)', async () => {
    mocks.exchangeCode.mockRejectedValueOnce(new Error('intuit 400 invalid_grant'));
    const { state, cookie } = mintState(authState.partnerId!, '33333333-3333-3333-3333-333333333333');

    const res = await app.request(
      `/accounting/quickbooks/callback?code=bad&realmId=realm-1&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=exchange_failed');
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it('callback redirects to error=exchange_failed WITHOUT a Sentry capture when the code exchange is throttled', async () => {
    mocks.exchangeCode.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'rate_limited', provider: 'quickbooks', operation: 'exchangeCode', retryAfterMs: 5_000,
    }));
    const { state, cookie } = mintState(authState.partnerId!, '33333333-3333-3333-3333-333333333333');

    const res = await app.request(
      `/accounting/quickbooks/callback?code=bad&realmId=realm-1&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=exchange_failed');
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('callback captures the realm home currency and persists it against the row it just wrote', async () => {
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-A'));

    const res = await runCallback(app, 'realm-A');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(mocks.fetchRealmSettings).toHaveBeenCalledWith(expect.objectContaining({ id: CONNECTION_ID, realmId: 'realm-A' }));
    expect(mocks.updateHomeCurrency).toHaveBeenCalledWith(
      expect.anything(),
      CONNECTION_ID,
      authState.partnerId,
      // The generation this capture belongs to: the row as we just wrote it AND
      // the realm we just exchanged for.
      { updatedAt: PERSISTED_AT, realmId: 'realm-A' },
      'CAD',
    );
  });

  it('callback persists the realm multi-currency flag alongside the home currency', async () => {
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-A'));
    mocks.fetchRealmSettings.mockResolvedValueOnce({ homeCurrency: 'CAD', multiCurrencyEnabled: true });

    const res = await runCallback(app, 'realm-A');

    expect(res.status).toBe(302);
    // Same realm+generation compare-and-set as the home currency, chained onto
    // the generation THAT write returned (both bump updated_at) — a reconnect
    // to a different realm must not be stamped with the old realm's flag.
    expect(mocks.updateMultiCurrencyEnabled).toHaveBeenCalledWith(
      expect.anything(),
      CONNECTION_ID,
      authState.partnerId,
      { updatedAt: HOME_CURRENCY_WRITTEN_AT, realmId: 'realm-A' },
      true,
    );
  });

  it('callback never blanks a previously-captured multi-currency flag when the realm reports null', async () => {
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-A'));
    mocks.fetchRealmSettings.mockResolvedValueOnce({ homeCurrency: 'CAD', multiCurrencyEnabled: null });

    const res = await runCallback(app, 'realm-A');

    expect(res.status).toBe(302);
    expect(mocks.updateMultiCurrencyEnabled).not.toHaveBeenCalled();
  });

  it('same-realm reconnect RETAINS the prior captured currency when the capture then fails', async () => {
    // Reconnecting to the SAME realm must not blank a currency that was already
    // captured: there is no retry, no refresh route and no job, so a transient
    // Intuit failure would strand the connection at NULL forever.
    mocks.getConnection.mockResolvedValueOnce({ id: CONNECTION_ID, realmId: 'realm-A', homeCurrency: 'CAD' });
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-A'));
    mocks.fetchRealmSettings.mockRejectedValueOnce(new Error('qbo 503'));

    const res = await runCallback(app, 'realm-A');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('connected=1');
    const fields = mocks.upsertConnection.mock.calls[0]![3] as Record<string, unknown>;
    // undefined, not null: upsertConnection strips undefined from its conflict
    // set, so the stored currency survives untouched.
    expect(fields.homeCurrency).toBeUndefined();
  });

  it('different-realm reconnect NULLS the prior captured currency', async () => {
    mocks.getConnection.mockResolvedValueOnce({ id: CONNECTION_ID, realmId: 'realm-A', homeCurrency: 'CAD' });
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-B'));

    const res = await runCallback(app, 'realm-B');

    expect(res.status).toBe(302);
    const fields = mocks.upsertConnection.mock.calls[0]![3] as Record<string, unknown>;
    expect(fields.homeCurrency).toBeNull();
  });

  it('different-realm reconnect wipes the mappings and the CDC watermark, and audits it (finding C)', async () => {
    // The upsert keys on (partner, provider), so re-authorising against another
    // QuickBooks company REUSES this row — every mapping under it still points
    // at the OLD realm's entity ids and the stored cursor is a watermark in the
    // old realm's change stream.
    mocks.getConnection.mockResolvedValueOnce({ id: CONNECTION_ID, realmId: 'realm-A', homeCurrency: 'CAD' });
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-B'));
    mocks.resetConnectionForRealmChange.mockResolvedValueOnce({
      mappingsDeleted: 7,
      owedPaymentDeletes: { count: 0, remoteEntityIds: [] },
    });

    const res = await runCallback(app, 'realm-B');

    expect(res.status).toBe(302);
    expect(mocks.resetConnectionForRealmChange).toHaveBeenCalledWith(
      expect.anything(), CONNECTION_ID, authState.partnerId,
    );
    const audit = mocks.writeRouteAudit.mock.calls
      .map(([, event]) => event as Record<string, unknown>)
      .find((event) => event.action === 'accounting.connection.realm_changed');
    expect(audit).toMatchObject({ details: expect.objectContaining({ mappingsDeleted: 7 }) });
  });

  it('same-realm reconnect keeps the mappings and the CDC watermark', async () => {
    mocks.getConnection.mockResolvedValueOnce({ id: CONNECTION_ID, realmId: 'realm-A', homeCurrency: 'CAD' });
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-A'));

    await runCallback(app, 'realm-A');

    expect(mocks.resetConnectionForRealmChange).not.toHaveBeenCalled();
  });

  it('a FIRST connect (no prior realm) wipes nothing', async () => {
    mocks.getConnection.mockResolvedValueOnce(null);
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-A'));

    await runCallback(app, 'realm-A');

    expect(mocks.resetConnectionForRealmChange).not.toHaveBeenCalled();
  });

  it('an unreadable prior realm wipes nothing (never destroy a healthy mapping set on a guess)', async () => {
    mocks.getConnection.mockRejectedValueOnce(new Error('db down'));
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-B'));

    await runCallback(app, 'realm-B');

    expect(mocks.resetConnectionForRealmChange).not.toHaveBeenCalled();
  });

  it('nulls the currency when the pre-upsert realm read fails (fail closed, still connects)', async () => {
    mocks.getConnection.mockRejectedValueOnce(new Error('db down'));
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-A'));

    const res = await runCallback(app, 'realm-A');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('connected=1');
    const fields = mocks.upsertConnection.mock.calls[0]![3] as Record<string, unknown>;
    expect(fields.homeCurrency).toBeNull();
  });

  it('callback still connects when the QBO Preferences fetch fails (non-fatal capture)', async () => {
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens());
    mocks.fetchRealmSettings.mockRejectedValueOnce(new Error('qbo 403'));

    const res = await runCallback(app);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(mocks.updateHomeCurrency).not.toHaveBeenCalled();
  });

  it('callback still connects when the Preferences fetch is refused by the accounting rate limiter (Xero W01)', async () => {
    // fetchRealmSettings takes the connection's call slot; a refusal is a
    // rate_limited AccountingProviderError, which the non-fatal capture must
    // absorb exactly like any other failed capture.
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens());
    mocks.fetchRealmSettings.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'rate_limited', provider: 'quickbooks', operation: 'accounting call slot (per connection)', retryAfterMs: 5_000,
    }));

    const res = await runCallback(app);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(mocks.updateHomeCurrency).not.toHaveBeenCalled();
    // F7: a throttle is not an incident. A limiter-store outage is reported
    // once, centrally, by the limiter itself — never again here.
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it.each(['provider', 'local', 'limiter_unavailable'] as const)(
    'callback does not Sentry-capture a %s-throttled Preferences fetch (F7)',
    async (throttleSource) => {
      mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens());
      mocks.fetchRealmSettings.mockRejectedValueOnce(new AccountingProviderError({
        kind: 'rate_limited', provider: 'quickbooks', operation: 'fetchRealmSettings', retryAfterMs: 5_000, throttleSource,
      }));

      const res = await runCallback(app);

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('connected=1');
      expect(mocks.captureException).not.toHaveBeenCalled();
    },
  );

  it('callback still Sentry-captures a NON-throttle Preferences failure (F7 control)', async () => {
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens());
    mocks.fetchRealmSettings.mockRejectedValueOnce(new AccountingProviderError({
      kind: 'transient', provider: 'quickbooks', operation: 'fetchRealmSettings', httpStatus: 503,
    }));

    const res = await runCallback(app);

    expect(res.status).toBe(302);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it('callback still connects when the Preferences fetch is ABORTED by its timeout', async () => {
    // The capture is awaited before deleteCookie + redirect, so it carries an
    // abort budget; a hung Intuit must surface as a plain connected redirect,
    // never as a stalled /callback or a connect error.
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens());
    mocks.fetchRealmSettings.mockRejectedValueOnce(Object.assign(
      new Error('QuickBooks preferences request timed out'),
      { operation: 'fetchRealmSettings' },
    ));

    const res = await runCallback(app);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(mocks.updateHomeCurrency).not.toHaveBeenCalled();
  });

  it('callback still connects when the realm reports no home currency', async () => {
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens());
    mocks.fetchRealmSettings.mockResolvedValueOnce({ homeCurrency: null, multiCurrencyEnabled: null });

    const res = await runCallback(app);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(mocks.updateHomeCurrency).not.toHaveBeenCalled();
  });

  it('a successful capture with no updatedAt on the persisted row is reported, not logged as "unavailable"', async () => {
    // Distinct from "the realm reported no currency": a good capture that cannot
    // be written because the upsert returned an unexpected row shape is a defect,
    // and silently discarding it under an "unavailable" warning hides it.
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens());
    mocks.upsertConnection.mockResolvedValueOnce({
      id: CONNECTION_ID,
      partnerId: authState.partnerId,
      provider: 'quickbooks',
      realmId: 'realm-A',
      updatedAt: null,
      homeCurrency: null,
    });

    const res = await runCallback(app);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(mocks.updateHomeCurrency).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('a realm that reports NO currency is a warning, never an exception', async () => {
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens());
    mocks.fetchRealmSettings.mockResolvedValueOnce({ homeCurrency: null, multiCurrencyEnabled: null });

    const res = await runCallback(app);

    expect(res.status).toBe(302);
    expect(mocks.updateHomeCurrency).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('callback still connects when the compare-and-set loses the race, WITHOUT reporting an exception', async () => {
    // A lost CAS is an expected race on a normal user action (double connect),
    // so it must not reach Sentry at error level.
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens());
    mocks.updateHomeCurrency.mockRejectedValueOnce(Object.assign(
      new Error('updateHomeCurrency matched no accounting_connections row at the expected generation'),
      { code: 'ACCOUNTING_HOME_CURRENCY_CAS_ABORT' },
    ));

    const res = await runCallback(app);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('home currency'),
      expect.objectContaining({ eventCode: 'accounting_home_currency_cas_lost' }),
    );
  });

  it('a GENUINE home-currency write failure still reports an exception', async () => {
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens());
    mocks.updateHomeCurrency.mockRejectedValueOnce(new Error('deadlock detected'));

    const res = await runCallback(app);

    expect(res.status).toBe(302);
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('callback short-circuits to error=persist_failed when the credential upsert throws', async () => {
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens());
    mocks.upsertConnection.mockRejectedValueOnce(new Error('boom'));

    const res = await runCallback(app);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=persist_failed');
    expect(mocks.fetchRealmSettings).not.toHaveBeenCalled();
    expect(mocks.updateHomeCurrency).not.toHaveBeenCalled();
  });

  it('captured home-currency telemetry carries no QBO body, realm id, token or auth code', async () => {
    mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-A'));
    mocks.fetchRealmSettings.mockRejectedValueOnce(Object.assign(
      new Error('QuickBooks preferences request failed with 403'),
      { status: 403, operation: 'fetchRealmSettings' },
    ));

    const res = await runCallback(app, 'realm-A');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(mocks.captureException).toHaveBeenCalled();
    const captured = mocks.captureException.mock.calls[0]![0] as Error & Record<string, unknown>;
    expect(Object.keys(captured)).not.toContain('body');
    const serialized = JSON.stringify({ ...captured, message: captured.message });
    for (const secret of ['realm-A', 'at', 'rt', 'abc']) {
      // Whole-token match: 'at'/'rt'/'abc' as substrings would false-positive on
      // ordinary prose, so look for them as delimited words.
      expect(serialized).not.toMatch(new RegExp(`(^|[^A-Za-z0-9-])${secret}([^A-Za-z0-9-]|$)`));
    }
    expect(serialized).toContain('403');
  });

  it('status exposes the captured home currency, and null when disconnected', async () => {
    mocks.getConnection.mockResolvedValueOnce({
      id: CONNECTION_ID,
      partnerId: authState.partnerId,
      provider: 'quickbooks',
      realmId: 'realm-1',
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh-token',
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
      environment: 'production',
      homeCurrency: 'CAD',
      defaultIncomeAccountRef: null,
      defaultTaxCodeRef: null,
      pushMode: 'auto',
      status: 'connected',
      createdAt: new Date('2026-06-23T00:00:00Z'),
      updatedAt: new Date(),
      lastError: null,
    });

    const connected = await app.request('/accounting/quickbooks');
    expect(connected.status).toBe(200);
    await expect(connected.json()).resolves.toMatchObject({ homeCurrency: 'CAD' });

    mocks.getConnection.mockResolvedValueOnce(null);
    const disconnected = await app.request('/accounting/quickbooks');
    expect(disconnected.status).toBe(200);
    await expect(disconnected.json()).resolves.toMatchObject({ status: 'disconnected', homeCurrency: null });
  });

  // Phase D, Task 6 — the "Sync now" card needs both fields to render whether
  // pull is on and when it last ran, on the SAME shape whether or not a
  // connection exists yet (mirrors the homeCurrency/multiCurrencyEnabled
  // precedent above).
  it('returns pullPayments and lastReconcileAt for a connected partner and for the disconnected branch', async () => {
    const lastReconcileAt = new Date('2026-09-02T12:00:00Z');
    mocks.getConnection.mockResolvedValueOnce({
      id: CONNECTION_ID,
      partnerId: authState.partnerId,
      provider: 'quickbooks',
      realmId: 'realm-1',
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh-token',
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
      environment: 'production',
      homeCurrency: 'CAD',
      defaultIncomeAccountRef: null,
      defaultTaxCodeRef: null,
      pushMode: 'auto',
      status: 'connected',
      createdAt: new Date('2026-06-23T00:00:00Z'),
      updatedAt: new Date(),
      lastError: null,
      pullPayments: false,
      lastReconcileAt,
    });

    const connected = await app.request('/accounting/quickbooks');
    expect(connected.status).toBe(200);
    await expect(connected.json()).resolves.toMatchObject({
      pullPayments: false,
      lastReconcileAt: lastReconcileAt.toISOString(),
    });

    mocks.getConnection.mockResolvedValueOnce(null);
    const disconnected = await app.request('/accounting/quickbooks');
    expect(disconnected.status).toBe(200);
    await expect(disconnected.json()).resolves.toMatchObject({
      status: 'disconnected',
      pullPayments: true,
      lastReconcileAt: null,
    });
  });

  // Phase D2, Task 7 — same shape story as pullPayments above: GET answers
  // pushPayments on BOTH branches, defaulting `true` when disconnected (the
  // column's own `.default(true)`, accounting.ts schema).
  it('returns pushPayments for a connected partner, and defaults it true when no connection exists', async () => {
    mocks.getConnection.mockResolvedValueOnce({
      id: CONNECTION_ID,
      partnerId: authState.partnerId,
      provider: 'quickbooks',
      realmId: 'realm-1',
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh-token',
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
      environment: 'production',
      homeCurrency: 'CAD',
      defaultIncomeAccountRef: null,
      defaultTaxCodeRef: null,
      pushMode: 'auto',
      status: 'connected',
      createdAt: new Date('2026-06-23T00:00:00Z'),
      updatedAt: new Date(),
      lastError: null,
      pushPayments: false,
    });

    const connected = await app.request('/accounting/quickbooks');
    expect(connected.status).toBe(200);
    await expect(connected.json()).resolves.toMatchObject({ pushPayments: false });

    mocks.getConnection.mockResolvedValueOnce(null);
    const disconnected = await app.request('/accounting/quickbooks');
    expect(disconnected.status).toBe(200);
    await expect(disconnected.json()).resolves.toMatchObject({ pushPayments: true });
  });

  it('disconnect requires MFA', async () => {
    authState.mfa = false;

    const res = await app.request('/accounting/quickbooks/disconnect', { method: 'POST' });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'MFA required' });
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
  });

it('writes only the supplied fee mapping and refuses the wrong provider field',async()=>{
  mocks.providerSupports.mockImplementation((id: string, cap: string) => defaultProviderSupports(id, cap) || (id === 'xero' && cap === 'connect'));
  mocks.dbUpdateReturning.mockResolvedValueOnce([{status:'connected',feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null}]);
  const request=(provider:string,body:unknown)=>app.request(`/accounting/${provider}/settings`,{
    method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  expect((await request('quickbooks',{feeIncomeItemRef:'fee-item'})).status).toBe(200);
  expect(mocks.dbUpdateSet).toHaveBeenCalledWith(expect.objectContaining({feeIncomeItemRef:'fee-item'}));
  expect(mocks.dbUpdateSet.mock.calls.at(-1)![0]).not.toHaveProperty('pushPayments');
  expect((await request('xero',{feeIncomeItemRef:'wrong-kind'})).status).toBe(400);
  expect((await request('quickbooks',{feeIncomeAccountRef:'200'})).status).toBe(400);
  expect((await request('quickbooks',{feeIncomeItemRef:'x'.repeat(65)})).status).toBe(400);
  authState.scope='organization';
  expect((await request('quickbooks',{feeIncomeItemRef:'fee-item'})).status).toBe(403);
});

it.each([
  ['quickbooks',{feeIncomeItemRef:'fee-item'}],
  ['quickbooks',{feeIncomeItemRef:null}],
  ['xero',{feeIncomeAccountRef:'200'}],
  ['xero',{feeIncomeAccountRef:null}],
  ['quickbooks',{feeIncomeAccountRef:null,pushPayments:false}],
  ['xero',{feeIncomeItemRef:null,pushMode:'manual'}],
] as const)('refuses fee fields for %s with rollout off, including clears and mixed writes',async(provider,body)=>{
  mocks.providerSupports.mockImplementation((id: string, cap: string) => defaultProviderSupports(id, cap) || (id === 'xero' && cap === 'connect'));
  mocks.autopayEnabled.mockResolvedValue(false);
  const res=await app.request(`/accounting/${provider}/settings`,{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({code:'autopay_not_enabled'});
  expect(mocks.autopayEnabled).toHaveBeenCalledWith(expect.anything(),authState.partnerId);
  expect(mocks.dbUpdateSet).not.toHaveBeenCalled();
});
it('preserves ordinary accounting settings with rollout off',async()=>{
  mocks.autopayEnabled.mockResolvedValue(false);
  mocks.dbUpdateReturning.mockResolvedValueOnce([{status:'connected',pushMode:'manual'}]);
  const res=await app.request('/accounting/quickbooks/settings',{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({pushMode:'manual'})});
  expect(res.status).toBe(200);
  expect(mocks.dbUpdateSet).toHaveBeenCalledWith(expect.objectContaining({pushMode:'manual'}));
  expect(mocks.dbUpdateSet.mock.calls.at(-1)![0]).not.toHaveProperty('feeIncomeItemRef');
  expect(mocks.dbUpdateSet.mock.calls.at(-1)![0]).not.toHaveProperty('feeIncomeAccountRef');
});
it.each([true,false])('projects the existing partner rollout flag %s on accounting status',async enabled=>{
  mocks.autopayEnabled.mockResolvedValue(enabled);
  const res=await app.request('/accounting/quickbooks');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({autopayEnabled:enabled});
  expect(mocks.autopayEnabled).toHaveBeenCalledWith(expect.anything(),authState.partnerId);
});

it('reports only the partner fee-error count even with no surviving connection',async()=>{
  mocks.autopayEnabled.mockResolvedValue(false);
  mocks.getConnection.mockResolvedValueOnce(null);
  mocks.dbFeeErrorWhere.mockResolvedValueOnce([{n:2}]);
  const res=await app.request('/accounting/quickbooks');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({status:'disconnected',autopayEnabled:false,feeAccountingErrorCount:2});
});
it('denies selected-org callers before reading the fee-error aggregate',async()=>{
  authState.partnerOrgAccess='selected';
  expect((await app.request('/accounting/quickbooks')).status).toBe(403);
  expect(mocks.dbFeeErrorWhere).not.toHaveBeenCalled();
});

  describe('POST /:provider/settings/refresh', () => {
    it('refreshes and returns the realm settings, and audits the action', async () => {
      mocks.refreshRealmSettings.mockResolvedValueOnce({ homeCurrency: 'CAD', multiCurrencyEnabled: true });

      const res = await app.request('/accounting/quickbooks/settings/refresh', { method: 'POST' });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ homeCurrency: 'CAD', multiCurrencyEnabled: true });
      // The route no longer WRAPS the service call in withAuthDbAccessContext
      // (that held the request transaction across the QuickBooks call); it
      // hands the service a runner it re-enters per phase.
      expect(mocks.refreshRealmSettings).toHaveBeenCalledWith(authState.partnerId, 'quickbooks', expect.any(Function));
      const runner = mocks.refreshRealmSettings.mock.calls[0]![2] as <T>(fn: () => Promise<T>) => Promise<T>;
      mocks.withAuthDbAccessContext.mockClear();
      await runner(async () => 'phase');
      expect(mocks.withAuthDbAccessContext).toHaveBeenCalledTimes(1);
      expect(mocks.withAuthDbAccessContext).toHaveBeenCalledWith(
        expect.objectContaining({ partnerId: authState.partnerId }),
        expect.any(Function),
      );
      expect(mocks.writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'accounting.settings.refresh' }),
      );
    });

    it('requires MFA', async () => {
      authState.mfa = false;

      const res = await app.request('/accounting/quickbooks/settings/refresh', { method: 'POST' });

      expect(res.status).toBe(403);
      expect(mocks.refreshRealmSettings).not.toHaveBeenCalled();
    });

    it('maps not_connected to 404', async () => {
      mocks.refreshRealmSettings.mockRejectedValueOnce(
        new AccountingConnectionErrorClass('not_connected', 404, 'QuickBooks is not connected for this partner'),
      );

      const res = await app.request('/accounting/quickbooks/settings/refresh', { method: 'POST' });

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({ code: 'not_connected' });
    });

    it('maps reauth_required to 409', async () => {
      mocks.refreshRealmSettings.mockRejectedValueOnce(
        new AccountingConnectionErrorClass('reauth_required', 409, 'QuickBooks needs to be reconnected'),
      );

      const res = await app.request('/accounting/quickbooks/settings/refresh', { method: 'POST' });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ code: 'reauth_required' });
    });
  });

  // Phase D, Task 6.
  describe('PATCH /:provider/settings', () => {
    function patchSettings(body: Record<string, unknown>) {
      return app.request('/accounting/quickbooks/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('persists and echoes pullPayments', async () => {
      mocks.dbUpdateReturning.mockResolvedValueOnce([{
        status: 'connected',
        environment: 'production',
        pushMode: 'auto',
        defaultIncomeAccountRef: null,
        defaultTaxCodeRef: null,
        lastError: null,
        pullPayments: false,
      }]);

      const res = await patchSettings({ pullPayments: false });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ pullPayments: false });
    });

    it('still rejects an empty body (400)', async () => {
      const res = await patchSettings({});
      expect(res.status).toBe(400);
      expect(mocks.dbUpdateReturning).not.toHaveBeenCalled();
    });

    it('still rejects homeCurrency as read-only — a captured fact, not a setting (400)', async () => {
      const res = await patchSettings({ homeCurrency: 'CAD' });
      expect(res.status).toBe(400);
      expect(mocks.dbUpdateReturning).not.toHaveBeenCalled();
    });

    it('still rejects multiCurrencyEnabled as read-only — a captured fact, not a setting (400)', async () => {
      const res = await patchSettings({ multiCurrencyEnabled: true });
      expect(res.status).toBe(400);
      expect(mocks.dbUpdateReturning).not.toHaveBeenCalled();
    });

    it('rejects flipping pullPayments without invoices:write (403, finding D)', async () => {
      authState.invoicesWrite = false;

      const res = await patchSettings({ pullPayments: false });

      expect(res.status).toBe(403);
      expect(mocks.dbUpdateReturning).not.toHaveBeenCalled();
    });

    // Phase D2, Task 7 — pushPayments is the outbound half of the same
    // authority story as pullPayments/pushMode: switching it off silently
    // stops every Breeze payment from reaching the books, the same class of
    // harm the manual/bulk push routes already gate on invoices:write.
    it('persists and echoes pushPayments', async () => {
      mocks.dbUpdateReturning.mockResolvedValueOnce([{
        status: 'connected',
        environment: 'production',
        pushMode: 'auto',
        defaultIncomeAccountRef: null,
        defaultTaxCodeRef: null,
        lastError: null,
        pushPayments: false,
      }]);

      const res = await patchSettings({ pushPayments: false });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ pushPayments: false });
      // Asserting the ECHO alone proved only that the route returns what the
      // mocked UPDATE was told to return — it would pass with the column never
      // written. Assert what the route actually SET.
      expect(mocks.dbUpdateSet.mock.calls.at(-1)![0]).toMatchObject({ pushPayments: false });
    });

    it('persists pullPayments too, not just the echo', async () => {
      mocks.dbUpdateReturning.mockResolvedValueOnce([{
        status: 'connected', environment: 'production', pushMode: 'auto',
        defaultIncomeAccountRef: null, defaultTaxCodeRef: null, lastError: null, pullPayments: false,
      }]);

      await patchSettings({ pullPayments: false });

      expect(mocks.dbUpdateSet.mock.calls.at(-1)![0]).toMatchObject({ pullPayments: false });
    });

    it('writes ONLY the keys the body carried, so a partial PATCH cannot reset a sibling switch', async () => {
      mocks.dbUpdateReturning.mockResolvedValueOnce([{
        status: 'connected', environment: 'production', pushMode: 'auto',
        defaultIncomeAccountRef: null, defaultTaxCodeRef: null, lastError: null, pullPayments: true,
      }]);

      await patchSettings({ pullPayments: true });

      const patch = mocks.dbUpdateSet.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('pushPayments');
      expect(patch).not.toHaveProperty('pushMode');
    });

    it('RESTARTS the push horizon when pushPayments is switched back ON', async () => {
      // Review wave 2, finding 2: a deliberate pause must not later flush a
      // backlog. Decided in the UPDATE, so the SET list reads the row's OLD
      // `push_payments` and the flip is detected without a read-modify-write.
      mocks.dbUpdateReturning.mockResolvedValueOnce([{
        status: 'connected', environment: 'production', pushMode: 'auto',
        defaultIncomeAccountRef: null, defaultTaxCodeRef: null, lastError: null, pushPayments: true,
      }]);

      const res = await patchSettings({ pushPayments: true });

      expect(res.status).toBe(200);
      const patch = mocks.dbUpdateSet.mock.calls.at(-1)![0] as Record<string, unknown>;
      const compiled = new PgDialect().sqlToQuery(patch.pushPaymentsSince as SQL).sql;
      expect(compiled.toLowerCase()).toContain('"push_payments" = false then now()');
      // ...and it must be a no-op when the switch was already on.
      expect(compiled.toLowerCase()).toContain('else "accounting_connections"."push_payments_since"');
    });

    it('leaves the push horizon ALONE when pushPayments is switched OFF', async () => {
      mocks.dbUpdateReturning.mockResolvedValueOnce([{
        status: 'connected', environment: 'production', pushMode: 'auto',
        defaultIncomeAccountRef: null, defaultTaxCodeRef: null, lastError: null, pushPayments: false,
      }]);

      await patchSettings({ pushPayments: false });

      const patch = mocks.dbUpdateSet.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('pushPaymentsSince');
    });

    it('rejects flipping pushPayments without invoices:write, like pushMode and pullPayments (403, finding D)', async () => {
      authState.invoicesWrite = false;

      const res = await patchSettings({ pushPayments: false });

      expect(res.status).toBe(403);
      expect(mocks.dbUpdateReturning).not.toHaveBeenCalled();
    });

    it('rejects changing pushMode without invoices:write (403, finding D)', async () => {
      authState.invoicesWrite = false;

      const res = await patchSettings({ pushMode: 'manual' });

      expect(res.status).toBe(403);
      expect(mocks.dbUpdateReturning).not.toHaveBeenCalled();
    });

    it('still allows the account-ref settings without invoices:write', async () => {
      authState.invoicesWrite = false;
      mocks.dbUpdateReturning.mockResolvedValueOnce([{
        status: 'connected', environment: 'production', pushMode: 'auto',
        defaultIncomeAccountRef: '79', defaultTaxCodeRef: null, lastError: null, pullPayments: true,
      }]);

      const res = await patchSettings({ defaultIncomeAccountRef: '79' });

      expect(res.status).toBe(200);
    });

    it('lets a SYSTEM-scope token flip pullPayments (scope bypass, like the push routes)', async () => {
      authState.scope = 'system';
      authState.invoicesWrite = false;
      mocks.dbUpdateReturning.mockResolvedValueOnce([{
        status: 'connected', environment: 'production', pushMode: 'auto',
        defaultIncomeAccountRef: null, defaultTaxCodeRef: null, lastError: null, pullPayments: false,
      }]);

      const res = await app.request(
        `/accounting/quickbooks/settings?partnerId=${authState.partnerId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pullPayments: false }),
        },
      );

      expect(res.status).toBe(200);
    });

    it('404s when there is no connection to update', async () => {
      mocks.dbUpdateReturning.mockResolvedValueOnce([]);
      const res = await patchSettings({ pullPayments: true });
      expect(res.status).toBe(404);
    });
  });
  describe('owed QuickBooks payment deletes discarded (review wave 2, finding 3)', () => {
    it('POST /:provider/disconnect audits the owed deletes it cascades away, and still disconnects', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: CONNECTION_ID, provider: 'quickbooks', status: 'connected' });
      // The disconnect must NOT be blocked — but the remote ids are the only
      // thing that lets a human find those Payments in QuickBooks afterwards.
      mocks.deleteConnection.mockResolvedValueOnce({
        removed: true,
        connectionId: CONNECTION_ID,
        owedPaymentDeletes: { count: 2, remoteEntityIds: ['181/145', '182/146'] as string[] },
      });

      const res = await app.request('/accounting/quickbooks/disconnect', { method: 'POST' });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ disconnected: true });
      const event = mocks.writeRouteAudit.mock.calls
        .map((call) => call[1] as Record<string, unknown>)
        .find((e) => e.action === 'accounting.connection.owed_deletes_discarded');
      expect(event).toMatchObject({
        // The CONNECTION id, matching the realm-change twin — the audit trail
        // must not identify the same subject two different ways.
        resourceType: 'accounting_connection',
        resourceId: CONNECTION_ID,
        result: 'failure',
        details: expect.objectContaining({
          reason: 'disconnect', count: 2, remoteEntityIds: ['181/145', '182/146'],
        }),
      });
    });

    it('POST /:provider/disconnect writes no such audit when nothing is owed', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: CONNECTION_ID, provider: 'quickbooks', status: 'connected' });
      mocks.deleteConnection.mockResolvedValueOnce({
        removed: true,
        connectionId: CONNECTION_ID,
        owedPaymentDeletes: { count: 0, remoteEntityIds: [] },
      });

      await app.request('/accounting/quickbooks/disconnect', { method: 'POST' });

      expect(mocks.writeRouteAudit.mock.calls
        .map((call) => call[1] as Record<string, unknown>)
        .some((e) => e.action === 'accounting.connection.owed_deletes_discarded')).toBe(false);
    });
  });
  // Xero W01 review: pin the capability EACH route gates on (plan Task 15,
  // "Route -> capability map"). The provider is registered and configured but
  // lacks exactly that capability, so the route must answer 409
  // capability_unavailable and must have asked the registry for that exact
  // capability — a route gated on the wrong capability goes red here.
  describe('per-route capability gate (Xero W01)', () => {
    const jsonInit = (method: string, body: unknown) => ({
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    it.each([
      ['GET /:provider (status)', 'connect', '/accounting/quickbooks', undefined],
      ['GET /:provider/connect', 'connect', '/accounting/quickbooks/connect', undefined],
      ['GET /:provider/callback', 'connect', '/accounting/quickbooks/callback?code=abc&realmId=realm-A&state=s', undefined],
      ['POST /:provider/disconnect', 'connect', '/accounting/quickbooks/disconnect', { method: 'POST' }],
      ['PATCH /:provider/settings', 'connect', '/accounting/quickbooks/settings', jsonInit('PATCH', { pushMode: 'manual' })],
      ['POST /:provider/settings/refresh', 'connect', '/accounting/quickbooks/settings/refresh', { method: 'POST' }],
    ] as const)('%s answers 409 capability_unavailable without %s', async (_route, capability, url, init) => {
      mocks.providerSupports.mockImplementation((id: string, cap: string) => defaultProviderSupports(id, cap) && cap !== capability);
      const res = await app.request(url, init);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'capability_unavailable' });
      expect(mocks.providerSupports).toHaveBeenCalledWith('quickbooks', capability);
    // The route's gate is the FIRST capability check (push-bulk re-checks
    // invoicePush on the connection afterwards, which must not mask the gate).
    expect(mocks.providerSupports).toHaveBeenNthCalledWith(1, 'quickbooks', capability);
      expect(mocks.deleteConnection).not.toHaveBeenCalled();
      expect(mocks.exchangeCode).not.toHaveBeenCalled();
      expect(mocks.refreshRealmSettings).not.toHaveBeenCalled();
      expect(mocks.buildAuthUrl).not.toHaveBeenCalled();
    });
  });

  describe('provider generalisation (Xero W01)', () => {
    async function startConnect(provider: 'quickbooks') {
      const res = await app.request(`/accounting/${provider}/connect`);
      expect(res.status).toBe(200);
      const { authUrl } = await res.json() as { authUrl: string };
      const state = new URL(authUrl).searchParams.get('state')!;
      const cookie = /breeze_accounting_oauth_state=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
      return { state, cookie };
    }

    it('accepts xero in the URL but refuses it via the registry (409 capability_unavailable)', async () => {
      const res = await app.request('/accounting/xero/connect');
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('capability_unavailable');
      expect(mocks.buildAuthUrl).not.toHaveBeenCalled();
    });

    it('refuses connect with 409 accounting_provider_conflict when another provider is active', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: 'c1', provider: 'xero', status: 'disconnected' });
      const res = await app.request('/accounting/quickbooks/connect');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'accounting_provider_conflict', error: 'Disconnect Xero before connecting QuickBooks' });
      expect(mocks.getPartnerConnectionRef).toHaveBeenCalledWith(expect.anything(), authState.partnerId);
      expect(mocks.buildAuthUrl).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('/connect refuses QuickBooks while a Xero pending_tenant row exists (409, pending wording)', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: 'c1', provider: 'xero', status: 'pending_tenant' });
      const res = await app.request('/accounting/quickbooks/connect');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'accounting_provider_conflict',
        error: 'Finish or cancel the Xero connection before connecting QuickBooks',
      });
    });

    it('lets a reconnect to the SAME provider start OAuth', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: 'c1', provider: 'quickbooks', status: 'reauth_required' });
      const res = await app.request('/accounting/quickbooks/connect');
      expect(res.status).toBe(200);
      expect(mocks.buildAuthUrl).toHaveBeenCalledTimes(1);
    });

    it('records the provider in the OAuth state and rejects a state minted for another provider', async () => {
      const { state, cookie } = await startConnect('quickbooks');
      const payload = JSON.parse(Buffer.from(state.split('.')[0]!, 'base64url').toString('utf8'));
      expect(payload.provider).toBe('quickbooks');
      const res = await app.request(`/accounting/xero/callback?code=c&realmId=r&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` },
      });
      expect(res.status).toBe(409); // xero is refused by the registry gate before state checks run
      expect(mocks.exchangeCode).not.toHaveBeenCalled();
    });

    it('a state minted for a different provider never reaches the code exchange', async () => {
      const { state, cookie } = mintState(authState.partnerId!, null, Date.now() + 60_000, 'xero');
      const res = await app.request(`/accounting/quickbooks/callback?code=c&realmId=r&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'OAuth state was issued for a different provider' });
      expect(mocks.exchangeCode).not.toHaveBeenCalled();
    });

    it('a pre-W01 state (no provider) is honoured as a QuickBooks flow', async () => {
      mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-A'));
      const res = await runCallback(app, 'realm-A'); // mintState without provider
      expect(res.headers.get('location')).toBe('/integrations?accounting=quickbooks&connected=1#accounting');
    });

    it('a state round-tripped through /connect completes the QuickBooks callback', async () => {
      const { state, cookie } = await startConnect('quickbooks');
      mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-A'));
      const res = await app.request(`/accounting/quickbooks/callback?code=c&realmId=realm-A&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` },
      });
      expect(res.headers.get('location')).toBe('/integrations?accounting=quickbooks&connected=1#accounting');
      expect(mocks.upsertConnection).toHaveBeenCalledWith(
        expect.anything(), authState.partnerId, 'quickbooks', expect.objectContaining({ environment: 'production' }),
      );
    });

    it('a callback that hits a provider conflict redirects with error=provider_conflict', async () => {
      mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-A'));
      mocks.upsertConnection.mockRejectedValueOnce(new AccountingProviderConflictError('xero', 'quickbooks'));
      const res = await runCallback(app, 'realm-A');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/integrations?accounting=quickbooks&error=provider_conflict#accounting');
      expect(res.headers.get('set-cookie')).toContain('breeze_accounting_oauth_state=;');
    });

    // R8: only routes that validated config before W01 answer provider_not_configured.
    it('connect still answers 400 provider_not_configured when the provider is unconfigured', async () => {
      mocks.configError.mockReturnValue('QuickBooks OAuth is not configured on this instance');
      const res = await app.request('/accounting/quickbooks/connect');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'QuickBooks OAuth is not configured on this instance', code: 'provider_not_configured' });
      expect(mocks.buildAuthUrl).not.toHaveBeenCalled();
    });

    it('status does NOT answer provider_not_configured on an unconfigured instance (DB-only, unchanged)', async () => {
      mocks.configError.mockReturnValue('QuickBooks OAuth is not configured on this instance');
      mocks.getConnection.mockResolvedValueOnce(null);
      const res = await app.request('/accounting/quickbooks');
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe('disconnected');
    });

    it('disconnect still works on an unconfigured instance, so a stale row can never be stranded', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: CONNECTION_ID, provider: 'quickbooks', status: 'connected' });
      mocks.configError.mockReturnValue('QuickBooks OAuth is not configured on this instance');
      const res = await app.request('/accounting/quickbooks/disconnect', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(mocks.deleteConnection).toHaveBeenCalledWith(expect.anything(), authState.partnerId, 'quickbooks');
    });

    it('GET /accounting/providers lists registered providers with configuration and capabilities', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: 'c1', provider: 'quickbooks', status: 'connected' });
      const res = await app.request('/accounting/providers');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: [{ id: 'quickbooks', displayName: 'QuickBooks', configured: true,
          capabilities: { connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true } }],
        activeConnection: { provider: 'quickbooks', status: 'connected' },
      });
      expect(mocks.getConnection).not.toHaveBeenCalled();
    });
  });

  describe('callback generalisation (Xero W02)', () => {
    const USER_ID = '33333333-3333-3333-3333-333333333333';
    const EVT = 'evt-00001';
    const tenant = (id: string, type = 'ORGANISATION') => ({ tenantId: `ten-${id}`, connectionRef: `conn-${id}`, name: id, tenantType: type, authEventId: EVT });
    const allowXeroConnect = () => mocks.providerSupports.mockImplementation(
      (id: string, cap: string) => defaultProviderSupports(id, cap) || (id === 'xero' && cap === 'connect'),
    );
    async function xeroCallback(query = 'code=xc') {
      const { state, cookie } = mintState(authState.partnerId!, USER_ID, Date.now() + 60_000, 'xero');
      return app.request(`/accounting/xero/callback?${query}&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` },
      });
    }

    beforeEach(() => {
      mocks.xeroExchangeCode.mockResolvedValue(exchangedTokens(''));
      mocks.xeroFetchRealmSettings.mockResolvedValue({ homeCurrency: 'NZD', multiCurrencyEnabled: false });
      mocks.xeroSelection.authEventIdOf.mockReset();
      mocks.xeroSelection.authEventIdOf.mockReturnValue(EVT);
      mocks.xeroSelection.listGrantTenants.mockReset();
      mocks.xeroSelection.listAllTenants.mockReset();
      mocks.getConnection.mockResolvedValue(null);
    });

    it('consent cancelled at the provider redirects cleanly, with no state work', async () => {
      const res = await app.request('/accounting/quickbooks/callback?error=access_denied&state=anything');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/integrations?accounting=quickbooks&error=consent_denied#accounting');
      expect(mocks.exchangeCode).not.toHaveBeenCalled();
      expect(mocks.upsertConnection).not.toHaveBeenCalled();
      // An unverified state never clears the browser's in-flight binding cookie.
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('consent cancelled with the flow\'s own verified state clears the binding cookie', async () => {
      const { state, cookie } = mintState(authState.partnerId!, USER_ID);
      const res = await app.request(`/accounting/quickbooks/callback?error=access_denied&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` },
      });
      expect(res.headers.get('location')).toBe('/integrations?accounting=quickbooks&error=consent_denied#accounting');
      expect(res.headers.get('set-cookie')).toContain('breeze_accounting_oauth_state=;');
      expect(mocks.exchangeCode).not.toHaveBeenCalled();
    });

    it('an over-long provider error value still redirects consent_denied (never a JSON 400, never reflected) (review E)', async () => {
      const long = 'x'.repeat(150);
      const res = await app.request(`/accounting/quickbooks/callback?error=${long}&state=anything`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/integrations?accounting=quickbooks&error=consent_denied#accounting');
      expect(res.headers.get('location')).not.toContain(long);
    });

    it('consent cancelled on one provider\'s callback with a state issued for ANOTHER provider does not clear the binding cookie (review G)', async () => {
      allowXeroConnect();
      const { state, cookie } = mintState(authState.partnerId!, USER_ID, Date.now() + 60_000, 'quickbooks');
      const res = await app.request(`/accounting/xero/callback?error=access_denied&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` },
      });
      expect(res.headers.get('location')).toBe('/integrations?accounting=xero&error=consent_denied#accounting');
      expect(res.headers.get('set-cookie')).toBeNull();
      // Control: the same state on its own provider's callback does clear it.
      const own = await app.request(`/accounting/quickbooks/callback?error=access_denied&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` },
      });
      expect(own.headers.get('set-cookie')).toContain('breeze_accounting_oauth_state=;');
    });

    it('a callback with neither code nor error is still a 400', async () => {
      const { state, cookie } = mintState(authState.partnerId!, USER_ID);
      const res = await app.request(`/accounting/quickbooks/callback?realmId=realm-A&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Missing code or state' });
      expect(mocks.exchangeCode).not.toHaveBeenCalled();
    });

    it('QuickBooks still requires realmId (400)', async () => {
      const { state, cookie } = mintState(authState.partnerId!, USER_ID);
      const res = await app.request(`/accounting/quickbooks/callback?code=c&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `breeze_accounting_oauth_state=${cookie}` },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Missing realmId' });
      expect(mocks.exchangeCode).not.toHaveBeenCalled();
    });

    it('a QuickBooks realm held by another partner now redirects with error=tenant_held', async () => {
      mocks.exchangeCode.mockResolvedValueOnce(exchangedTokens('realm-A'));
      mocks.upsertConnection.mockRejectedValueOnce(new AccountingTenantHeldError('quickbooks'));
      const res = await runCallback(app, 'realm-A');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/integrations?accounting=quickbooks&error=tenant_held#accounting');
      expect(res.headers.get('set-cookie')).toContain('breeze_accounting_oauth_state=;');
      expect(mocks.fetchRealmSettings).not.toHaveBeenCalled();
      expect(mocks.captureException).not.toHaveBeenCalled();
    });

    it('Xero: no realmId is fine; a token with no auth-event claim fails closed (auth_event_missing, nothing listed or persisted)', async () => {
      allowXeroConnect();
      mocks.xeroSelection.authEventIdOf.mockReturnValue(null);
      const res = await xeroCallback();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/integrations?accounting=xero&error=auth_event_missing#accounting');
      expect(mocks.xeroExchangeCode).toHaveBeenCalledWith('xc', '');
      expect(mocks.xeroSelection.listGrantTenants).not.toHaveBeenCalled();
      expect(mocks.xeroSelection.listAllTenants).not.toHaveBeenCalled();
      expect(mocks.xeroSelection.removeTenantConnection).not.toHaveBeenCalled();
      expect(mocks.upsertConnection).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie')).toContain('breeze_accounting_oauth_state=;');
    });

    it('Xero: one organisation connects it (tenant id + connection ref) and captures its settings', async () => {
      allowXeroConnect();
      mocks.xeroSelection.listGrantTenants.mockResolvedValue([tenant('A')]);
      mocks.upsertConnection.mockResolvedValueOnce({ id: CONNECTION_ID, partnerId: authState.partnerId, provider: 'xero', realmId: 'ten-A', updatedAt: PERSISTED_AT });
      const res = await xeroCallback();
      expect(res.headers.get('location')).toBe('/integrations?accounting=xero&connected=1#accounting');
      expect(mocks.xeroSelection.listGrantTenants).toHaveBeenCalledWith('at', EVT);
      expect(mocks.upsertConnection).toHaveBeenCalledWith(expect.anything(), authState.partnerId, 'xero', expect.objectContaining({
        realmId: 'ten-A', providerConnectionRef: 'conn-A', status: 'connected', connectedBy: USER_ID, homeCurrency: null,
      }));
      expect(mocks.xeroFetchRealmSettings).toHaveBeenCalledTimes(1);
      expect(mocks.updateHomeCurrency).toHaveBeenCalledWith(expect.anything(), CONNECTION_ID, authState.partnerId, { updatedAt: PERSISTED_AT, realmId: 'ten-A' }, 'NZD');
    });

    it('Xero: several organisations park the row and send the browser to the picker', async () => {
      allowXeroConnect();
      mocks.xeroSelection.listGrantTenants.mockResolvedValue([tenant('A'), tenant('B')]);
      const res = await xeroCallback();
      expect(res.headers.get('location')).toBe('/integrations?accounting=xero&select_tenant=1#accounting');
      expect(mocks.upsertConnection).toHaveBeenCalledWith(expect.anything(), authState.partnerId, 'xero', expect.objectContaining({ status: 'pending_tenant' }));
      expect(mocks.xeroFetchRealmSettings).not.toHaveBeenCalled();
    });

    it('Xero: a failed organisation lookup redirects with error=tenant_lookup_failed', async () => {
      allowXeroConnect();
      mocks.xeroSelection.listGrantTenants.mockRejectedValue(new Error('xero 503'));
      const res = await xeroCallback();
      expect(res.headers.get('location')).toBe('/integrations?accounting=xero&error=tenant_lookup_failed#accounting');
      expect(mocks.upsertConnection).not.toHaveBeenCalled();
    });
  });

  describe('disconnect, settings and status (Xero W02)', () => {
    const allowXeroConnect = () => mocks.providerSupports.mockImplementation(
      (id: string, cap: string) => defaultProviderSupports(id, cap) || (id === 'xero' && cap === 'connect'),
    );
    const xeroConnection = (over: Record<string, unknown> = {}) => ({
      id: CONNECTION_ID, partnerId: authState.partnerId, provider: 'xero', realmId: 'ten-A', providerConnectionRef: 'conn-A',
      accessToken: 'at', refreshToken: 'rt', accessTokenExpiresAt: new Date(), refreshTokenExpiresAt: new Date(),
      environment: 'production', homeCurrency: 'NZD', multiCurrencyEnabled: false,
      defaultIncomeAccountRef: '200', defaultTaxCodeRef: 'OUTPUT2', defaultExemptTaxCodeRef: 'NONE', defaultPaymentAccountRef: 'bank-1',
      pushMode: 'auto', status: 'connected', createdAt: new Date('2026-09-20T00:00:00Z'), updatedAt: new Date(), lastError: null,
      pullPayments: true, lastReconcileAt: null, pushPayments: true, ...over,
    });
    const auditActions = () => mocks.writeRouteAudit.mock.calls.map((call) => call[1] as Record<string, unknown>);
    const disconnect = (provider = 'xero') => app.request(`/accounting/${provider}/disconnect`, { method: 'POST' });

    beforeEach(() => {
      allowXeroConnect();
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: CONNECTION_ID, provider: 'xero', status: 'connected' });
      mocks.getConnection.mockResolvedValue(xeroConnection());
      mocks.deleteConnection.mockResolvedValue({ removed: true, connectionId: CONNECTION_ID, owedPaymentDeletes: { count: 0, remoteEntityIds: [] } });
    });

    it('disconnect releases the provider link BEFORE deleting, and never blocks on a release failure', async () => {
      const order: string[] = [];
      mocks.releaseProviderConnection.mockImplementation(async () => { order.push('release'); return 'failed'; });
      mocks.deleteConnection.mockImplementation(async () => {
        order.push('delete');
        return { removed: true, connectionId: CONNECTION_ID, owedPaymentDeletes: { count: 0, remoteEntityIds: [] } };
      });
      const res = await disconnect();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ disconnected: true });
      expect(order).toEqual(['release', 'delete']);
      expect(mocks.releaseProviderConnection).toHaveBeenCalledWith(expect.objectContaining({ id: CONNECTION_ID, providerConnectionRef: 'conn-A' }));
      expect(mocks.deleteConnection).toHaveBeenCalledWith(expect.anything(), authState.partnerId, 'xero');
    });

    it('disconnect scopes reads and uses a separate system transaction for authorized staff fanout', async () => {
      await disconnect();
      // Scoped reads and system delete/fanout; no context spans provider I/O.
      expect(mocks.withAuthDbAccessContext).toHaveBeenCalledTimes(2);
      expect(mocks.systemContext).toHaveBeenCalledWith(expect.any(Function),'accounting.disconnect');
      expect(mocks.withAuthDbAccessContext).toHaveBeenCalledWith(expect.objectContaining({ partnerId: authState.partnerId }), expect.any(Function));
    });

    it('disconnect audits the disconnect with the release outcome', async () => {
      mocks.releaseProviderConnection.mockResolvedValue('released');
      await disconnect();
      expect(auditActions().find((e) => e.action === 'accounting.connection.disconnected')).toMatchObject({
        resourceType: 'accounting_connection', resourceId: CONNECTION_ID,
        details: { provider: 'xero', status: 'connected', providerRelease: 'released' },
      });
    });

    it('404 when the partner has no connection, or one to a DIFFERENT provider (nothing released or deleted)', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValueOnce(null);
      expect((await disconnect()).status).toBe(404);
      mocks.getPartnerConnectionRef.mockResolvedValueOnce({ id: CONNECTION_ID, provider: 'quickbooks', status: 'connected' });
      expect((await disconnect()).status).toBe(404);
      expect(mocks.releaseProviderConnection).not.toHaveBeenCalled();
      expect(mocks.deleteConnection).not.toHaveBeenCalled();
    });

    it('disconnect of a pending_tenant row is a cancel (no release, no plain delete), audited like any disconnect (F19)', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: CONNECTION_ID, provider: 'xero', status: 'pending_tenant' });
      mocks.discardPendingTenantSelection.mockResolvedValue({ discarded: true, connectionId: CONNECTION_ID, owedPaymentDeletes: { count: 0, remoteEntityIds: [] } });
      const res = await disconnect();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ disconnected: true });
      expect(mocks.discardPendingTenantSelection).toHaveBeenCalledWith(expect.objectContaining({
        partnerId: authState.partnerId, provider: 'xero', reason: 'cancel', runInDbContext: expect.any(Function),
      }));
      expect(mocks.releaseProviderConnection).not.toHaveBeenCalled();
      expect(mocks.deleteConnection).not.toHaveBeenCalled();
      expect(auditActions().find((e) => e.action === 'accounting.connection.disconnected')).toMatchObject({
        resourceId: CONNECTION_ID, details: { provider: 'xero', status: 'pending_tenant' },
      });
    });

    it('#7289: disconnect of a re-parked row that owed payment deletes still disconnects and audits the discarded debt', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: CONNECTION_ID, provider: 'xero', status: 'pending_tenant' });
      mocks.discardPendingTenantSelection.mockResolvedValue({
        discarded: true, connectionId: CONNECTION_ID, owedPaymentDeletes: { count: 2, remoteEntityIds: ['P-181/INV-145', 'P-182/INV-146'] },
      });
      const res = await disconnect();
      expect(res.status).toBe(200);
      expect(auditActions().find((e) => e.action === 'accounting.connection.owed_deletes_discarded')).toEqual({
        orgId: null,
        action: 'accounting.connection.owed_deletes_discarded',
        resourceType: 'accounting_connection',
        resourceId: CONNECTION_ID,
        result: 'failure',
        details: { provider: 'xero', reason: 'disconnect', count: 2, remoteEntityIds: ['P-181/INV-145', 'P-182/INV-146'] },
      });
    });

    it('#7289: the same audit on the re-read path (row re-parked after the first read)', async () => {
      mocks.getConnection.mockResolvedValue(xeroConnection({ status: 'pending_tenant', providerConnectionRef: null }));
      mocks.discardPendingTenantSelection.mockResolvedValue({
        discarded: true, connectionId: CONNECTION_ID, owedPaymentDeletes: { count: 1, remoteEntityIds: ['P-181/INV-145'] },
      });
      const res = await disconnect();
      expect(res.status).toBe(200);
      expect(auditActions().find((e) => e.action === 'accounting.connection.owed_deletes_discarded')).toMatchObject({
        resourceId: CONNECTION_ID, result: 'failure', details: { provider: 'xero', reason: 'disconnect', count: 1 },
      });
    });

    it('#7289: a pending row that owed nothing writes no owed-deletes audit', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: CONNECTION_ID, provider: 'xero', status: 'pending_tenant' });
      mocks.discardPendingTenantSelection.mockResolvedValue({ discarded: true, connectionId: CONNECTION_ID, owedPaymentDeletes: { count: 0, remoteEntityIds: [] } });
      await disconnect();
      expect(auditActions().some((e) => e.action === 'accounting.connection.owed_deletes_discarded')).toBe(false);
    });

    it('a pending row that was claimed in the meantime still disconnects through the normal path', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: CONNECTION_ID, provider: 'xero', status: 'pending_tenant' });
      mocks.discardPendingTenantSelection.mockResolvedValue({ discarded: false });
      const res = await disconnect();
      expect(res.status).toBe(200);
      expect(mocks.releaseProviderConnection).toHaveBeenCalledTimes(1);
      expect(mocks.deleteConnection).toHaveBeenCalledTimes(1);
    });

    it('a connected row RE-PARKED to pending_tenant before the full read goes through the held-checked discard, not release + plain delete (review H)', async () => {
      mocks.getConnection.mockResolvedValue(xeroConnection({ status: 'pending_tenant', providerConnectionRef: null }));
      mocks.discardPendingTenantSelection.mockResolvedValue({ discarded: true, connectionId: CONNECTION_ID, owedPaymentDeletes: { count: 0, remoteEntityIds: [] } });
      const res = await disconnect();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ disconnected: true });
      expect(mocks.discardPendingTenantSelection).toHaveBeenCalledWith(expect.objectContaining({
        partnerId: authState.partnerId, provider: 'xero', reason: 'cancel',
      }));
      expect(mocks.releaseProviderConnection).not.toHaveBeenCalled();
      expect(mocks.deleteConnection).not.toHaveBeenCalled();
      expect(auditActions().find((e) => e.action === 'accounting.connection.disconnected')).toMatchObject({
        details: { provider: 'xero', status: 'pending_tenant' },
      });
    });

    it('the audit names the re-read status, not the first read\'s: a pending row claimed meanwhile is audited as connected (review I)', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: CONNECTION_ID, provider: 'xero', status: 'pending_tenant' });
      mocks.discardPendingTenantSelection.mockResolvedValue({ discarded: false });
      mocks.releaseProviderConnection.mockResolvedValue('released');
      await disconnect();
      expect(auditActions().find((e) => e.action === 'accounting.connection.disconnected')).toMatchObject({
        details: { provider: 'xero', status: 'connected', providerRelease: 'released' },
      });
    });

    it('a provider with no release hook (QuickBooks) skips the decrypting full read: two DB contexts, not three (review K)', async () => {
      mocks.getPartnerConnectionRef.mockResolvedValue({ id: CONNECTION_ID, provider: 'quickbooks', status: 'connected' });
      const res = await disconnect('quickbooks');
      expect(res.status).toBe(200);
      expect(mocks.getConnection).not.toHaveBeenCalled();
      expect(mocks.releaseProviderConnection).not.toHaveBeenCalled();
      expect(mocks.withAuthDbAccessContext).toHaveBeenCalledTimes(1);
      expect(mocks.systemContext).toHaveBeenCalledWith(expect.any(Function),'accounting.disconnect');
      expect(mocks.deleteConnection).toHaveBeenCalledWith(expect.anything(), authState.partnerId, 'quickbooks');
      expect(auditActions().find((e) => e.action === 'accounting.connection.disconnected')).toMatchObject({
        details: { provider: 'quickbooks', status: 'connected', providerRelease: 'skipped' },
      });
    });

    it('a token that cannot be decrypted still disconnects (release skipped), and the failure is Sentry-captured', async () => {
      mocks.getConnection.mockRejectedValue(new Error('decrypt failed'));
      const res = await disconnect();
      expect(res.status).toBe(200);
      expect(mocks.releaseProviderConnection).not.toHaveBeenCalled();
      expect(mocks.deleteConnection).toHaveBeenCalledTimes(1);
      expect(auditActions().find((e) => e.action === 'accounting.connection.disconnected')).toMatchObject({
        details: { providerRelease: 'skipped' },
      });
      expect(mocks.captureException).toHaveBeenCalledTimes(1);
    });

    it('PATCH settings writes and returns the two new refs (F18)', async () => {
      mocks.dbUpdateReturning.mockResolvedValueOnce([{
        status: 'connected', environment: 'production', pushMode: 'auto', defaultIncomeAccountRef: '200', defaultTaxCodeRef: 'OUTPUT2',
        defaultExemptTaxCodeRef: 'NONE', defaultPaymentAccountRef: 'bank-1', lastError: null, pullPayments: true, pushPayments: true,
      }]);
      const res = await app.request('/accounting/xero/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultExemptTaxCodeRef: 'NONE', defaultPaymentAccountRef: 'bank-1' }),
      });
      expect(res.status).toBe(200);
      expect(mocks.dbUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ defaultExemptTaxCodeRef: 'NONE', defaultPaymentAccountRef: 'bank-1' }));
      expect(await res.json()).toMatchObject({ defaultExemptTaxCodeRef: 'NONE', defaultPaymentAccountRef: 'bank-1' });
    });

    it('PATCH settings clears a ref with null, and leaves the other untouched', async () => {
      mocks.dbUpdateReturning.mockResolvedValueOnce([{ status: 'connected' }]);
      const res = await app.request('/accounting/xero/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultPaymentAccountRef: null }),
      });
      expect(res.status).toBe(200);
      const patch = mocks.dbUpdateSet.mock.calls[0]![0] as Record<string, unknown>;
      expect(patch).toHaveProperty('defaultPaymentAccountRef', null);
      expect('defaultExemptTaxCodeRef' in patch).toBe(false);
    });

    it('PATCH settings rejects a ref longer than the 64-char column (400)', async () => {
      const res = await app.request('/accounting/xero/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultExemptTaxCodeRef: 'x'.repeat(65), pushMode: 'auto' }),
      });
      expect(res.status).toBe(400);
      expect(mocks.dbUpdateSet).not.toHaveBeenCalled();
    });

    it('GET /:provider exposes capabilities and features on both branches, and the new refs when connected', async () => {
      const connected = await (await app.request('/accounting/xero')).json();
      expect(connected).toMatchObject({
        status: 'connected',
        defaultExemptTaxCodeRef: 'NONE',
        defaultPaymentAccountRef: 'bank-1',
        capabilities: { connect: true, mapping: false, customerImport: false, invoicePush: false, paymentPull: false, paymentPush: false },
        features: { tenantSelection: true, settingsOptions: true },
      });
      mocks.getConnection.mockResolvedValueOnce(null);
      const disconnected = await (await app.request('/accounting/xero')).json();
      expect(disconnected.status).toBe('disconnected');
      expect(disconnected.capabilities).toEqual(connected.capabilities);
      expect(disconnected.features).toEqual({ tenantSelection: true, settingsOptions: true });
      // DB-only: the status route never calls the provider.
      expect(mocks.xeroListSettingsOptions).not.toHaveBeenCalled();
    });

    it('GET /:provider reports QuickBooks features off (no picker, no settings options)', async () => {
      mocks.getConnection.mockResolvedValueOnce(null);
      const body = await (await app.request('/accounting/quickbooks')).json();
      expect(body.features).toEqual({ tenantSelection: false, settingsOptions: false });
      expect(body.capabilities).toMatchObject({ connect: true, invoicePush: true });
    });

    it('the connection-setup routes are mounted behind the accounting chain (MFA on select)', async () => {
      authState.mfa = false;
      const res = await app.request('/accounting/xero/tenants/select', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: 'ten-A' }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'MFA required' });
    });

    it('cancel is mounted and discards the partner\'s pending row', async () => {
      mocks.discardPendingTenantSelection.mockResolvedValue({ discarded: true, connectionId: CONNECTION_ID, owedPaymentDeletes: { count: 0, remoteEntityIds: [] } });
      const res = await app.request('/accounting/xero/tenants/cancel', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cancelled: true });
      expect(mocks.discardPendingTenantSelection).toHaveBeenCalledWith(expect.objectContaining({ partnerId: authState.partnerId, provider: 'xero' }));
    });
  });

it('disconnect runs its authorized fee abandonment and staff fanout in a system transaction',async()=>{
  mocks.getPartnerConnectionRef.mockResolvedValue({id:CONNECTION_ID,provider:'quickbooks',status:'connected'});
  const res=await app.request('/accounting/quickbooks/disconnect',{method:'POST'});
  expect(res.status).toBe(200);
  expect(mocks.systemContext).toHaveBeenCalledWith(expect.any(Function),'accounting.disconnect');
});

});
