import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'crypto';

// The route's signingSecret() falls through APP_ENCRYPTION_KEY/SECRET_ENCRYPTION_KEY/
// SESSION_SECRET to JWT_SECRET, which the api test setup (src/__tests__/setup.ts)
// sets. Mint state with that same ambient secret — do NOT stub env here, or it
// perturbs the shared-worker process.env that secretCrypto reads in sibling tests.
const FIXED_SECRET = 'test-jwt-secret-must-be-at-least-32-characters-long';

function mintState(partnerId: string, userId: string | null, exp = Date.now() + 60_000): { state: string; cookie: string } {
  const payload = { partnerId, userId, nonce: 'test-nonce', exp };
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
      mfa: true,
    },
    mocks: {
      getConnection: vi.fn(),
      upsertConnection: vi.fn(),
      deleteConnection: vi.fn(),
      exchangeCode: vi.fn(),
      fetchRealmSettings: vi.fn(),
      updateHomeCurrency: vi.fn(),
      updateMultiCurrencyEnabled: vi.fn(),
      refreshRealmSettings: vi.fn(),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      writeRouteAudit: vi.fn(),
      buildAuthUrl: vi.fn((state: string) => `https://qbo.example.test/connect?scope=com.intuit.quickbooks.accounting&state=${encodeURIComponent(state)}`),
      // Task 5 review fix: POST /:provider/settings/refresh is self-managed
      // (no ambient request tx), so it now wraps refreshRealmSettings in
      // withAuthDbAccessContext. Runs `fn` through so existing behavior is
      // unchanged; asserted directly in the settings/refresh describe block.
      withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => unknown) => fn()),
    },
    AccountingConnectionErrorClass,
  };
});

vi.mock('../../db', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => []),
        })),
      })),
    })),
  },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));

vi.mock('../../config/env', () => ({
  QBO_CLIENT_ID: 'client-id',
  QBO_CLIENT_SECRET: 'client-secret',
  QBO_REDIRECT_URI: 'https://api.example.test/accounting/quickbooks/callback',
  QBO_ENVIRONMENT: 'production',
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.partnerId,
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
  // The customer routes are permission-gated (organizations:write +
  // sites:write); this suite covers the OAuth/settings routes, so grant it.
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  withAuthDbAccessContext: mocks.withAuthDbAccessContext,
}));

vi.mock('../../services/accounting/accountingConnectionService', () => ({
  getConnection: mocks.getConnection,
  upsertConnection: mocks.upsertConnection,
  deleteConnection: mocks.deleteConnection,
  updateHomeCurrency: mocks.updateHomeCurrency,
  updateMultiCurrencyEnabled: mocks.updateMultiCurrencyEnabled,
  refreshRealmSettings: mocks.refreshRealmSettings,
  AccountingConnectionError: AccountingConnectionErrorClass,
  // Real implementation, not a mock: the route's benign-race branch must key on
  // the error CODE, so the test exercises the real predicate.
  isHomeCurrencyCasAbort: (err: unknown) => typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === 'ACCOUNTING_HOME_CURRENCY_CAS_ABORT',
}));

vi.mock('../../services/sentry', () => ({
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: mocks.writeRouteAudit,
}));

vi.mock('../../services/accounting/providerRegistry', () => ({
  getAccountingProvider: vi.fn(() => ({
    provider: 'quickbooks',
    buildAuthUrl: mocks.buildAuthUrl,
    exchangeCode: mocks.exchangeCode,
    fetchRealmSettings: mocks.fetchRealmSettings,
  })),
}));

import { accountingRoutes } from './index';

const CONNECTION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PERSISTED_AT = new Date('2026-09-04T00:00:00Z');

function exchangedTokens(realmId = 'realm-A') {
  return {
    realmId,
    accessToken: 'at',
    refreshToken: 'rt',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshTokenExpiresAt: new Date(Date.now() + 8_640_000_000),
  };
}

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
    authState.scope = 'partner';
    authState.partnerId = '11111111-1111-1111-1111-111111111111';
    authState.mfa = true;
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
    expect(mocks.updateMultiCurrencyEnabled).toHaveBeenCalledWith(
      expect.anything(),
      CONNECTION_ID,
      authState.partnerId,
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

  it('disconnect requires MFA', async () => {
    authState.mfa = false;

    const res = await app.request('/accounting/quickbooks/disconnect', { method: 'POST' });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'MFA required' });
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
  });

  describe('POST /:provider/settings/refresh', () => {
    it('refreshes and returns the realm settings, and audits the action', async () => {
      mocks.refreshRealmSettings.mockResolvedValueOnce({ homeCurrency: 'CAD', multiCurrencyEnabled: true });

      const res = await app.request('/accounting/quickbooks/settings/refresh', { method: 'POST' });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ homeCurrency: 'CAD', multiCurrencyEnabled: true });
      expect(mocks.refreshRealmSettings).toHaveBeenCalledWith(authState.partnerId, 'quickbooks');
      // Self-managed route (no ambient request tx) — the service call must
      // run inside an explicit withAuthDbAccessContext (Task 5 review fix).
      expect(mocks.withAuthDbAccessContext).toHaveBeenCalledTimes(1);
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
});
