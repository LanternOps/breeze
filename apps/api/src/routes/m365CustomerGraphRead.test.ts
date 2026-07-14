import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
const TENANT_ID = '66666666-6666-4666-8666-666666666666';

type AuthState = {
  scope: 'organization' | 'partner' | 'system';
  orgId: string | null;
  partnerOrgAccess: 'all' | 'selected' | 'none' | null;
  accessibleOrgIds: string[] | null;
  permissions: Set<'organizations:read' | 'organizations:write'>;
  mfa: boolean;
};

const { authRef, mocks } = vi.hoisted(() => ({
  authRef: { current: null as AuthState | null },
  mocks: {
    list: vi.fn(),
    initiate: vi.fn(),
    retest: vi.fn(),
    disconnect: vi.fn(),
    onboardingEnabled: vi.fn(() => true),
    buildBindingCookie: vi.fn(() => 'binding-cookie=opaque; HttpOnly; SameSite=Lax'),
    audit: vi.fn(),
    canAccessOrg: vi.fn(),
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    const state = authRef.current;
    if (!state) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', {
      ...state,
      partnerId: state.scope === 'partner' ? '77777777-7777-4777-8777-777777777777' : null,
      user: { id: USER_ID, email: 'admin@example.com', name: 'Admin', isPlatformAdmin: false },
      token: { mfa: state.mfa },
      canAccessOrg: mocks.canAccessOrg,
      orgCondition: () => undefined,
    });
    return next();
  }),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!auth.permissions.has(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!c.get('auth')?.mfa) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'organizations', action: 'read' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
}));

vi.mock('../services/m365ControlPlane/connectionService', async (importActual) => ({
  ...await importActual<typeof import('../services/m365ControlPlane/connectionService')>(),
  listCustomerGraphReadConnections: mocks.list,
  initiateCustomerGraphReadConsent: mocks.initiate,
  retestCustomerGraphReadConnection: mocks.retest,
  disconnectCustomerGraphReadConnection: mocks.disconnect,
}));

vi.mock('../services/m365ControlPlane/runtimeConfig', () => ({
  isM365CustomerGraphReadOnboardingEnabledForOrg: mocks.onboardingEnabled,
}));

vi.mock('../services/m365ControlPlane/browserBinding', () => ({
  buildM365ConsentBindingCookie: mocks.buildBindingCookie,
}));

vi.mock('../services/m365ControlPlane/metrics', () => ({
  M365_CUSTOMER_GRAPH_READ_OUTCOMES: [
    'initiated', 'identity_verification_started', 'active', 'degraded', 'revoked',
    'grant_missing', 'grant_unexpected', 'manifest_stale', 'executor_unavailable',
  ],
  recordM365CustomerGraphReadEvent: mocks.audit,
}));

import { m365CustomerGraphReadRoutes } from './m365CustomerGraphRead';

const requiredGrant = {
  resourceApplicationId: '00000003-0000-0000-c000-000000000000',
  appRoleId: '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30',
  value: 'Application.Read.All',
};

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    orgId: ORG_ID,
    tenantId: TENANT_ID,
    clientId: '88888888-8888-4888-8888-888888888888',
    profile: 'customer-graph-read',
    permissionManifestVersion: 2,
    observedGrants: [requiredGrant],
    consentAttemptId: ATTEMPT_ID,
    grantsVerifiedAt: new Date('2026-07-14T10:00:00.000Z'),
    displayName: 'Contoso',
    status: 'active',
    lastVerifiedAt: new Date('2026-07-14T10:00:00.000Z'),
    lastErrorCode: null,
    grantHealth: {
      state: 'active',
      requiredGrants: [requiredGrant],
      observedGrants: [requiredGrant],
      missingGrants: [],
      unexpectedGrants: [],
    },
    clientSecret: 'must-not-leak',
    vaultRef: 'akv://must-not-leak',
    credentialVersion: 'must-not-leak',
    rawState: 'must-not-leak',
    codeVerifier: 'must-not-leak',
    administratorObjectId: 'must-not-leak',
    ...overrides,
  };
}

function auth(overrides: Partial<AuthState> = {}): AuthState {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    partnerOrgAccess: null,
    accessibleOrgIds: [ORG_ID],
    permissions: new Set(['organizations:read', 'organizations:write']),
    mfa: true,
    ...overrides,
  };
}

function app(): Hono {
  const target = new Hono();
  target.route('/m365', m365CustomerGraphReadRoutes);
  return target;
}

beforeEach(() => {
  vi.clearAllMocks();
  authRef.current = auth();
  mocks.onboardingEnabled.mockReturnValue(true);
  mocks.list.mockResolvedValue([]);
  mocks.initiate.mockResolvedValue({
    connection: connection({ status: 'pending-consent', tenantId: null }),
    rawState: 'one-time-state',
    consentUrl: 'https://login.microsoftonline.com/common/adminconsent?server-built=true',
  });
  mocks.retest.mockResolvedValue(connection());
  mocks.disconnect.mockResolvedValue(connection({
    tenantId: null, clientId: '', displayName: null, status: 'revoked',
    permissionManifestVersion: 2, observedGrants: [], grantsVerifiedAt: null,
    lastVerifiedAt: null, grantHealth: undefined,
  }));
  mocks.buildBindingCookie.mockReturnValue('binding-cookie=opaque; HttpOnly; SameSite=Lax');
  mocks.canAccessOrg.mockImplementation(
    (orgId: string) => authRef.current?.accessibleOrgIds === null
      || authRef.current?.accessibleOrgIds.includes(orgId) === true,
  );
});

describe('GET /m365/connections', () => {
  it('requires authentication and ORGS_READ', async () => {
    authRef.current = null;
    expect((await app().request('/m365/connections')).status).toBe(401);

    authRef.current = auth({ permissions: new Set(['organizations:write']) });
    expect((await app().request('/m365/connections')).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('lets an organization-scoped administrator use its concrete organization', async () => {
    const response = await app().request(`/m365/connections?orgId=${ORG_ID}`);
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(ORG_ID);
    await expect(response.json()).resolves.toMatchObject({
      profile: { id: 'customer-graph-read', displayName: 'Customer Graph Read', manifestVersion: 2 },
      onboardingEnabled: true,
      connection: null,
    });
  });

  it('returns the exact safe envelope and strips every credential/session/admin field', async () => {
    mocks.list.mockResolvedValue([connection()]);
    const response = await app().request(`/m365/connections?orgId=${ORG_ID}`);
    const body = await response.json();
    expect(body.profile.requiredGrants).toContainEqual(requiredGrant);
    expect(body.connection).toEqual({
      id: CONNECTION_ID,
      tenantId: TENANT_ID,
      clientId: '88888888-8888-4888-8888-888888888888',
      displayName: 'Contoso',
      status: 'active',
      manifestVersion: 2,
      observedGrants: [requiredGrant],
      missingGrants: [],
      unexpectedGrants: [],
      grantsVerifiedAt: '2026-07-14T10:00:00.000Z',
      lastVerifiedAt: '2026-07-14T10:00:00.000Z',
      lastErrorCode: null,
    });
    const serialized = JSON.stringify(body);
    for (const secret of ['must-not-leak', 'one-time-state']) expect(serialized).not.toContain(secret);
    for (const forbidden of ['clientSecret', 'vaultRef', 'credentialVersion', 'consentAttemptId', 'rawState', 'codeVerifier', 'administratorObjectId']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('reports onboarding disabled without hiding an existing connection', async () => {
    mocks.onboardingEnabled.mockReturnValue(false);
    mocks.list.mockResolvedValue([connection()]);
    const body = await (await app().request(`/m365/connections?orgId=${ORG_ID}`)).json();
    expect(body.onboardingEnabled).toBe(false);
    expect(body.connection.id).toBe(CONNECTION_ID);
  });

  it('returns no definitive drift when the first verified reconciliation is unavailable', async () => {
    mocks.list.mockResolvedValue([connection({
      status: 'degraded',
      observedGrants: [],
      grantsVerifiedAt: null,
      lastErrorCode: 'grant_reconciliation_unavailable',
      grantHealth: undefined,
    })]);

    const body = await (await app().request(`/m365/connections?orgId=${ORG_ID}`)).json();
    expect(body.connection).toMatchObject({
      status: 'degraded',
      observedGrants: [],
      missingGrants: [],
      unexpectedGrants: [],
      grantsVerifiedAt: null,
      lastErrorCode: 'grant_reconciliation_unavailable',
    });
  });
});

const mutationRequests = [
  ['consent', (orgId = ORG_ID) => app().request(`/m365/connections/customer-graph-read/consent?orgId=${orgId}`, { method: 'POST' })],
  ['retest', (orgId = ORG_ID) => app().request(`/m365/connections/${CONNECTION_ID}/retest?orgId=${orgId}`, { method: 'POST' })],
  ['disconnect', (orgId = ORG_ID) => app().request(`/m365/connections/${CONNECTION_ID}/disconnect?orgId=${orgId}`, { method: 'POST' })],
] as const;

describe.each(mutationRequests)('%s authorization', (_name, request) => {
  it('requires ORGS_WRITE', async () => {
    authRef.current = auth({ permissions: new Set(['organizations:read']) });
    expect((await request()).status).toBe(403);
  });

  it('requires current MFA', async () => {
    authRef.current = auth({ mfa: false });
    expect((await request()).status).toBe(403);
  });

  it('allows an organization-scoped administrator without applying the partner-wide guard', async () => {
    expect((await request()).status).toBe(200);
  });

  it('denies selected partner scope and allows full partner scope for a concrete accessible org', async () => {
    authRef.current = auth({ scope: 'partner', orgId: null, partnerOrgAccess: 'selected' });
    expect((await request(ORG_ID)).status).toBe(403);

    authRef.current = auth({ scope: 'partner', orgId: null, partnerOrgAccess: 'all' });
    expect((await request(ORG_ID)).status).toBe(200);
  });

  it('rejects all-organizations operation without a concrete organization', async () => {
    authRef.current = auth({
      scope: 'partner', orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: [ORG_ID, OTHER_ORG_ID],
    });
    expect((await request('')).status).toBe(400);
  });
});

describe('POST /m365/connections/customer-graph-read/consent', () => {
  it('creates one browser-bound attempt, audits safe identifiers, and returns only the server URL', async () => {
    const response = await app().request(`/m365/connections/customer-graph-read/consent?orgId=${ORG_ID}`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(mocks.initiate).toHaveBeenCalledWith({ orgId: ORG_ID, actorId: USER_ID });
    expect(mocks.buildBindingCookie).toHaveBeenCalledWith({
      phase: 'admin_consent', rawState: 'one-time-state', connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID, tenantHint: null,
    });
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    await expect(response.json()).resolves.toEqual({
      adminConsentUrl: 'https://login.microsoftonline.com/common/adminconsent?server-built=true',
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID,
      event: 'm365.customer_graph_read.consent_initiated',
      connectionId: CONNECTION_ID,
      profile: 'customer-graph-read',
      consentAttemptId: ATTEMPT_ID,
      manifestVersion: 2,
      outcome: 'initiated',
      actorId: USER_ID,
    }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('one-time-state');
  });

  it('is the only lifecycle route gated by onboarding enablement', async () => {
    mocks.onboardingEnabled.mockReturnValue(false);
    expect((await app().request(`/m365/connections/customer-graph-read/consent?orgId=${ORG_ID}`, { method: 'POST' })).status).toBe(404);
    expect(mocks.initiate).not.toHaveBeenCalled();
    expect((await app().request(`/m365/connections/${CONNECTION_ID}/retest?orgId=${ORG_ID}`, { method: 'POST' })).status).toBe(200);
    expect((await app().request(`/m365/connections/${CONNECTION_ID}/disconnect?orgId=${ORG_ID}`, { method: 'POST' })).status).toBe(200);
  });
});

describe('scoped connection mutations', () => {
  it('passes only the scoped stored id to retest and returns a safe DTO', async () => {
    const response = await app().request(`/m365/connections/${CONNECTION_ID}/retest?orgId=${ORG_ID}`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(mocks.retest).toHaveBeenCalledWith(expect.objectContaining({
      id: CONNECTION_ID, orgId: ORG_ID, auth: expect.objectContaining({ scope: 'organization' }),
    }));
    expect((await response.json()).connection.id).toBe(CONNECTION_ID);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'm365.customer_graph_read.retested', connectionId: CONNECTION_ID,
      outcome: 'active', consentAttemptId: ATTEMPT_ID, manifestVersion: 2,
    }));
  });

  it('records grant drift once alongside the retest outcome without unsafe connection fields', async () => {
    mocks.retest.mockResolvedValueOnce(connection({
      status: 'degraded', lastErrorCode: 'grant_unexpected',
      vaultRef: 'akv://must-not-audit', administratorObjectId: 'must-not-audit',
    }));

    const response = await app().request(
      `/m365/connections/${CONNECTION_ID}/retest?orgId=${ORG_ID}`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(mocks.audit.mock.calls.map((call) => call[1].event)).toEqual([
      'm365.customer_graph_read.retested',
      'm365.customer_graph_read.grant_drift_detected',
    ]);
    expect(mocks.audit.mock.calls[1]?.[1]).toMatchObject({ outcome: 'grant_unexpected' });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('must-not-audit');
  });

  it('records disconnect exactly once with the acting user and revoked outcome', async () => {
    const response = await app().request(
      `/m365/connections/${CONNECTION_ID}/disconnect?orgId=${ORG_ID}`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    await expect(response.clone().json()).resolves.toMatchObject({
      connection: {
        id: CONNECTION_ID,
        tenantId: null,
        clientId: null,
        displayName: null,
        status: 'revoked',
        manifestVersion: 2,
        observedGrants: [],
        missingGrants: [],
        unexpectedGrants: [],
        grantsVerifiedAt: null,
        lastVerifiedAt: null,
        lastErrorCode: null,
      },
    });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'm365.customer_graph_read.disconnected', outcome: 'revoked',
      connectionId: CONNECTION_ID, actorId: USER_ID,
    }));
  });

  it('maps both scope misses and ownership conflicts to the same non-oracular response', async () => {
    authRef.current = auth({ scope: 'partner', orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: [ORG_ID] });
    const scopeMiss = await app().request(`/m365/connections/${CONNECTION_ID}/retest?orgId=${OTHER_ORG_ID}`, { method: 'POST' });

    mocks.retest.mockRejectedValueOnce({ code: 'connection_not_found' });
    const conflict = await app().request(`/m365/connections/${CONNECTION_ID}/retest?orgId=${ORG_ID}`, { method: 'POST' });

    expect(scopeMiss.status).toBe(404);
    expect(conflict.status).toBe(404);
    expect(await scopeMiss.json()).toEqual(await conflict.json());
  });
});

const strictOrgQueryRoutes = [
  ['list', 'GET', '/m365/connections'],
  ['consent', 'POST', '/m365/connections/customer-graph-read/consent'],
  ['retest', 'POST', `/m365/connections/${CONNECTION_ID}/retest`],
  ['disconnect', 'POST', `/m365/connections/${CONNECTION_ID}/disconnect`],
] as const;

const invalidOrgQueries = [
  ['missing', ''],
  ['malformed', '?orgId=not-a-uuid'],
  ['uppercase', '?orgId=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'],
  ['duplicate accessible then inaccessible', `?orgId=${ORG_ID}&orgId=${OTHER_ORG_ID}`],
  ['duplicate inaccessible then accessible', `?orgId=${OTHER_ORG_ID}&orgId=${ORG_ID}`],
  ['duplicate same value', `?orgId=${ORG_ID}&orgId=${ORG_ID}`],
] as const;

describe.each(strictOrgQueryRoutes)('%s strict orgId query contract', (_name, method, path) => {
  it('authenticates before parsing orgId', async () => {
    authRef.current = null;
    const response = await app().request(path, { method });
    expect(response.status).toBe(401);
    expect(mocks.canAccessOrg).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.initiate).not.toHaveBeenCalled();
    expect(mocks.retest).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it.each(invalidOrgQueries)('rejects %s before scope, service, or audit work', async (_case, query) => {
    const response = await app().request(`${path}${query}`, { method });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid organization request' });
    expect(mocks.canAccessOrg).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.initiate).not.toHaveBeenCalled();
    expect(mocks.retest).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
