import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'crypto';
import { m365AuthRoutes, m365CallbackRoute } from './m365Auth';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONNECTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const insertMock = vi.fn(() => chainMock([]));
const selectMock = vi.fn(() => chainMock([]));
const deleteMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));

let authState = {
  user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
};

vi.mock('../../db', () => ({
  db: {
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    select: (...args: unknown[]) => selectMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
}));

vi.mock('../../db/schema', () => ({
  c2cConnections: {
    id: 'c2c_connections.id',
    orgId: 'c2c_connections.org_id',
    provider: 'c2c_connections.provider',
    authMethod: 'c2c_connections.auth_method',
    displayName: 'c2c_connections.display_name',
    tenantId: 'c2c_connections.tenant_id',
    clientId: 'c2c_connections.client_id',
    clientSecret: 'c2c_connections.client_secret',
    accessToken: 'c2c_connections.access_token',
    tokenExpiresAt: 'c2c_connections.token_expires_at',
    scopes: 'c2c_connections.scopes',
    status: 'c2c_connections.status',
    createdAt: 'c2c_connections.created_at',
    updatedAt: 'c2c_connections.updated_at',
  },
  c2cConsentSessions: {
    orgId: 'c2c_consent_sessions.org_id',
    userId: 'c2c_consent_sessions.user_id',
    state: 'c2c_consent_sessions.state',
    provider: 'c2c_consent_sessions.provider',
    displayName: 'c2c_consent_sessions.display_name',
    scopes: 'c2c_consent_sessions.scopes',
    expiresAt: 'c2c_consent_sessions.expires_at',
  },
}));

const writeAuditEventMock = vi.fn();
vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: (...args: unknown[]) => writeAuditEventMock(...(args as [])),
}));

const captureExceptionMock = vi.fn();
vi.mock('../../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
}));

const encryptSecretMock = vi.fn((value: string) => `enc:${value}`);
vi.mock('../../services/secretCrypto', () => ({
  encryptSecret: (...args: unknown[]) => encryptSecretMock(...(args as [])),
}));

const getPlatformConfigMock = vi.fn();
const buildAdminConsentUrlMock = vi.fn();
const getCallbackUriMock = vi.fn();
const getFrontendBaseUrlMock = vi.fn();
const acquireClientCredentialsTokenMock = vi.fn();
const testGraphAccessMock = vi.fn();

vi.mock('../../services/c2cM365', () => ({
  getPlatformConfig: (...args: unknown[]) => getPlatformConfigMock(...(args as [])),
  buildAdminConsentUrl: (...args: unknown[]) => buildAdminConsentUrlMock(...(args as [])),
  getCallbackUri: (...args: unknown[]) => getCallbackUriMock(...(args as [])),
  getFrontendBaseUrl: (...args: unknown[]) => getFrontendBaseUrlMock(...(args as [])),
  acquireClientCredentialsToken: (...args: unknown[]) => acquireClientCredentialsTokenMock(...(args as [])),
  testGraphAccess: (...args: unknown[]) => testGraphAccessMock(...(args as [])),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
}));

vi.mock('../auth/helpers', () => ({
  getCookieValue: (cookieHeader: string | undefined, name: string) => {
    if (!cookieHeader) return null;
    const target = `${name}=`;
    for (const part of cookieHeader.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith(target)) {
        return decodeURIComponent(trimmed.slice(target.length));
      }
    }
    return null;
  },
}));

import { authMiddleware } from '../../middleware/auth';

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    orgId: ORG_ID,
    provider: 'microsoft_365',
    authMethod: 'platform_app',
    displayName: 'Microsoft 365 - Contoso',
    tenantId: 'tenant-1',
    clientId: null,
    clientSecret: null,
    accessToken: 'enc:old-token',
    tokenExpiresAt: new Date('2026-04-01T00:00:00.000Z'),
    scopes: 'Mail.Read',
    status: 'active',
    createdAt: new Date('2026-03-31T00:00:00.000Z'),
    updatedAt: new Date('2026-03-31T00:00:00.000Z'),
    ...overrides,
  };
}

describe('m365 auth routes', () => {
  let authApp: Hono;
  let callbackApp: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'jwt-secret-for-test';
    authState = {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    });

    getPlatformConfigMock.mockReturnValue({
      clientId: 'client-id',
      clientSecret: 'platform-secret',
    });
    buildAdminConsentUrlMock.mockReturnValue('https://login.microsoftonline.com/common/adminconsent?...');
    getCallbackUriMock.mockReturnValue('http://localhost:3000/api/v1/c2c/m365/callback');
    getFrontendBaseUrlMock.mockReturnValue('http://localhost:4321');
    testGraphAccessMock.mockResolvedValue({ ok: true, orgDisplayName: 'Contoso' });

    authApp = new Hono();
    authApp.use('*', authMiddleware);
    authApp.route('/c2c', m365AuthRoutes);

    callbackApp = new Hono();
    callbackApp.route('/api/v1', m365CallbackRoute);
  });

  it('issues a consent url and callback binding cookie', async () => {
    insertMock.mockReturnValueOnce(chainMock([]));

    const res = await authApp.request('/c2c/m365/consent-url?displayName=Contoso', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain('login.microsoftonline.com');
    expect(buildAdminConsentUrlMock).toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toContain('breeze_c2c_m365_consent=');
  });

  it('rejects callback requests without the binding cookie', async () => {
    const res = await callbackApp.request('/api/v1/c2c/m365/callback?state=test-state&tenant=tenant-1&admin_consent=True');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('c2c_error=Invalid%20or%20expired%20consent%20session');
  });

  it('reuses an existing active platform-app connection for the same org and tenant', async () => {
    const consentState = 'state-123';
    const cookieValue = createHmac('sha256', 'platform-secret')
      .update(`c2c-m365-consent:${consentState}`)
      .digest('hex');
    const cookie = `breeze_c2c_m365_consent=${encodeURIComponent(cookieValue)}`;

    deleteMock.mockReturnValueOnce(chainMock([{
      orgId: ORG_ID,
      userId: 'user-123',
      state: consentState,
      provider: 'microsoft_365',
      displayName: 'Contoso',
      scopes: 'Mail.Read',
      expiresAt: new Date(Date.now() + 60_000),
    }]));
    selectMock.mockReturnValueOnce(chainMock([
      makeConnection(),
    ]));
    updateMock.mockReturnValueOnce(chainMock([makeConnection()]));
    acquireClientCredentialsTokenMock.mockResolvedValueOnce({
      accessToken: 'fresh-access-token',
      expiresIn: 3600,
    });

    const callbackRes = await callbackApp.request(`/api/v1/c2c/m365/callback?state=${consentState}&tenant=tenant-1&admin_consent=True`, {
      method: 'GET',
      headers: { Cookie: cookie ?? '' },
    });

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('location')).toContain(`c2c_connected=true&connectionId=${CONNECTION_ID}`);
    expect(updateMock).toHaveBeenCalled();
  });
});
