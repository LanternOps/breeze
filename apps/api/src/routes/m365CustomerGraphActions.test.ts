import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
const TENANT_ID = '66666666-6666-4666-8666-666666666666';
const READ_CONNECTION_ID = '99999999-9999-4999-8999-999999999999';
const READ_ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
    buildActionsBindingCookie: vi.fn(() => 'breeze_m365_graph_actions_consent=opaque; Path=/api/v1/m365/actions-consent/callback; HttpOnly; SameSite=Lax'),
    audit: vi.fn(),
    canAccessOrg: vi.fn(),
    // read-surface mocks, used only by the cross-mount regression suite below —
    // both routers mount on `/m365` in index.ts, so the read module has to be
    // mocked too whenever both routers are exercised on one app.
    readList: vi.fn(),
    readInitiate: vi.fn(),
    readRetest: vi.fn(),
    readDisconnect: vi.fn(),
    readOnboardingEnabled: vi.fn(() => true),
    readAudit: vi.fn(),
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

vi.mock('../services/m365ControlPlane/writeActionConnectionService', async (importActual) => ({
  ...await importActual<typeof import('../services/m365ControlPlane/writeActionConnectionService')>(),
  listCustomerGraphActionsConnections: mocks.list,
  initiateCustomerGraphActionsConsent: mocks.initiate,
  retestCustomerGraphActionsConnection: mocks.retest,
  disconnectCustomerGraphActionsConnection: mocks.disconnect,
}));

vi.mock('../services/m365ControlPlane/writeActionRuntimeConfig', () => ({
  isM365CustomerGraphActionsOnboardingEnabledForOrg: mocks.onboardingEnabled,
}));

// Real read module, mocked only in its consent-lifecycle exports — needed so
// the cross-mount regression suite can mount m365CustomerGraphReadRoutes for
// real, exactly as index.ts does, without hitting the database.
vi.mock('../services/m365ControlPlane/connectionService', async (importActual) => ({
  ...await importActual<typeof import('../services/m365ControlPlane/connectionService')>(),
  listCustomerGraphReadConnections: mocks.readList,
  initiateCustomerGraphReadConsent: mocks.readInitiate,
  retestCustomerGraphReadConnection: mocks.readRetest,
  disconnectCustomerGraphReadConnection: mocks.readDisconnect,
}));

vi.mock('../services/m365ControlPlane/runtimeConfig', () => ({
  isM365CustomerGraphReadOnboardingEnabledForOrg: mocks.readOnboardingEnabled,
}));

vi.mock('../services/m365ControlPlane/browserBinding', () => ({
  buildM365ConsentBindingCookie: mocks.buildBindingCookie,
  buildM365ActionsConsentBindingCookie: mocks.buildActionsBindingCookie,
}));

vi.mock('../services/m365ControlPlane/metrics', () => ({
  M365_CUSTOMER_GRAPH_ACTIONS_OUTCOMES: [
    'initiated', 'identity_verification_started', 'active', 'degraded', 'revoked',
    'grant_missing', 'grant_unexpected', 'manifest_stale', 'executor_unavailable',
  ],
  recordM365CustomerGraphActionsEvent: mocks.audit,
  M365_CUSTOMER_GRAPH_READ_OUTCOMES: [
    'initiated', 'identity_verification_started', 'active', 'degraded', 'revoked',
    'grant_missing', 'grant_unexpected', 'manifest_stale', 'executor_unavailable',
  ],
  recordM365CustomerGraphReadEvent: mocks.readAudit,
}));

import { m365CustomerGraphActionsRoutes } from './m365CustomerGraphActions';
import { m365CustomerGraphReadRoutes } from './m365CustomerGraphRead';

const requiredGrant = {
  resourceApplicationId: '00000003-0000-0000-c000-000000000000',
  appRoleId: '204e0828-b5ca-4ad8-b9f3-f32a958e7cc4',
  value: 'User.ReadWrite.All',
};

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    orgId: ORG_ID,
    tenantId: TENANT_ID,
    clientId: '88888888-8888-4888-8888-888888888888',
    profile: 'customer-graph-actions',
    permissionManifestVersion: 1,
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

function readConnection(overrides: Record<string, unknown> = {}) {
  return connection({
    id: READ_CONNECTION_ID,
    profile: 'customer-graph-read',
    consentAttemptId: READ_ATTEMPT_ID,
    ...overrides,
  });
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
  target.route('/m365/customer-graph-actions', m365CustomerGraphActionsRoutes);
  return target;
}

/** Mounts both routers exactly as index.ts does — the shape review flagged as colliding. */
function mountedLikeIndex(): Hono {
  const target = new Hono();
  target.route('/m365', m365CustomerGraphReadRoutes);
  target.route('/m365/customer-graph-actions', m365CustomerGraphActionsRoutes);
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
    permissionManifestVersion: 1, observedGrants: [], grantsVerifiedAt: null,
    lastVerifiedAt: null, grantHealth: undefined,
  }));
  mocks.buildBindingCookie.mockReturnValue('binding-cookie=opaque; HttpOnly; SameSite=Lax');
  mocks.buildActionsBindingCookie.mockReturnValue(
    'breeze_m365_graph_actions_consent=opaque; Path=/api/v1/m365/actions-consent/callback; HttpOnly; SameSite=Lax',
  );
  mocks.canAccessOrg.mockImplementation(
    (orgId: string) => authRef.current?.accessibleOrgIds === null
      || authRef.current?.accessibleOrgIds.includes(orgId) === true,
  );

  mocks.readOnboardingEnabled.mockReturnValue(true);
  mocks.readList.mockResolvedValue([]);
  mocks.readInitiate.mockResolvedValue({
    connection: readConnection({ status: 'pending-consent', tenantId: null }),
    rawState: 'read-one-time-state',
    consentUrl: 'https://login.microsoftonline.com/common/adminconsent?read-built=true',
  });
  mocks.readRetest.mockResolvedValue(readConnection());
  mocks.readDisconnect.mockResolvedValue(readConnection({ status: 'revoked' }));
});

describe('GET /m365/customer-graph-actions/connections', () => {
  it('requires authentication and ORGS_READ', async () => {
    authRef.current = null;
    expect((await app().request('/m365/customer-graph-actions/connections')).status).toBe(401);

    authRef.current = auth({ permissions: new Set(['organizations:write']) });
    expect((await app().request('/m365/customer-graph-actions/connections')).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('lets an organization-scoped administrator use its concrete organization', async () => {
    const response = await app().request(`/m365/customer-graph-actions/connections?orgId=${ORG_ID}`);
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(ORG_ID);
    await expect(response.json()).resolves.toMatchObject({
      profile: { id: 'customer-graph-actions', displayName: 'Customer Graph Actions', manifestVersion: 1 },
      onboardingEnabled: true,
      connection: null,
    });
  });

  it('returns the exact safe envelope and strips every credential/session/admin field', async () => {
    mocks.list.mockResolvedValue([connection()]);
    const response = await app().request(`/m365/customer-graph-actions/connections?orgId=${ORG_ID}`);
    const body = await response.json();
    expect(body.profile.requiredGrants).toContainEqual(requiredGrant);
    expect(body.connection).toEqual({
      id: CONNECTION_ID,
      tenantId: TENANT_ID,
      clientId: '88888888-8888-4888-8888-888888888888',
      displayName: 'Contoso',
      status: 'active',
      manifestVersion: 1,
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
    const body = await (await app().request(`/m365/customer-graph-actions/connections?orgId=${ORG_ID}`)).json();
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

    const body = await (await app().request(`/m365/customer-graph-actions/connections?orgId=${ORG_ID}`)).json();
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
  ['consent', (orgId = ORG_ID) => app().request(`/m365/customer-graph-actions/connections/consent?orgId=${orgId}`, { method: 'POST' })],
  ['retest', (orgId = ORG_ID) => app().request(`/m365/customer-graph-actions/connections/${CONNECTION_ID}/retest?orgId=${orgId}`, { method: 'POST' })],
  ['disconnect', (orgId = ORG_ID) => app().request(`/m365/customer-graph-actions/connections/${CONNECTION_ID}/disconnect?orgId=${orgId}`, { method: 'POST' })],
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

describe('POST /m365/customer-graph-actions/connections/consent', () => {
  it('creates one browser-bound attempt, audits safe identifiers, and returns only the server URL', async () => {
    const response = await app().request(`/m365/customer-graph-actions/connections/consent?orgId=${ORG_ID}`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(mocks.initiate).toHaveBeenCalledWith({ orgId: ORG_ID, actorId: USER_ID });
    // Must set the cookie via the ACTIONS-profile binding, never the read one —
    // the two carry distinct cookie names/paths/HMAC contexts (browserBinding.ts).
    expect(mocks.buildActionsBindingCookie).toHaveBeenCalledWith({
      phase: 'admin_consent', rawState: 'one-time-state', connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID, tenantHint: null,
    });
    expect(mocks.buildBindingCookie).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('breeze_m365_graph_actions_consent=');
    expect(response.headers.get('set-cookie')).toContain('Path=/api/v1/m365/actions-consent/callback');
    await expect(response.json()).resolves.toEqual({
      adminConsentUrl: 'https://login.microsoftonline.com/common/adminconsent?server-built=true',
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID,
      event: 'm365.customer_graph_actions.consent_initiated',
      connectionId: CONNECTION_ID,
      profile: 'customer-graph-actions',
      consentAttemptId: ATTEMPT_ID,
      manifestVersion: 1,
      outcome: 'initiated',
      actorId: USER_ID,
    }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('one-time-state');
  });

  it('is the only lifecycle route gated by onboarding enablement', async () => {
    mocks.onboardingEnabled.mockReturnValue(false);
    expect((await app().request(`/m365/customer-graph-actions/connections/consent?orgId=${ORG_ID}`, { method: 'POST' })).status).toBe(404);
    expect(mocks.initiate).not.toHaveBeenCalled();
    expect((await app().request(`/m365/customer-graph-actions/connections/${CONNECTION_ID}/retest?orgId=${ORG_ID}`, { method: 'POST' })).status).toBe(200);
    expect((await app().request(`/m365/customer-graph-actions/connections/${CONNECTION_ID}/disconnect?orgId=${ORG_ID}`, { method: 'POST' })).status).toBe(200);
  });
});

describe('scoped connection mutations', () => {
  it('passes only the scoped stored id to retest and returns a safe DTO', async () => {
    const response = await app().request(`/m365/customer-graph-actions/connections/${CONNECTION_ID}/retest?orgId=${ORG_ID}`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(mocks.retest).toHaveBeenCalledWith(expect.objectContaining({
      id: CONNECTION_ID, orgId: ORG_ID, auth: expect.objectContaining({ scope: 'organization' }),
    }));
    expect((await response.json()).connection.id).toBe(CONNECTION_ID);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'm365.customer_graph_actions.retested', connectionId: CONNECTION_ID,
      outcome: 'active', consentAttemptId: ATTEMPT_ID, manifestVersion: 1,
    }));
  });

  it('records grant drift once alongside the retest outcome without unsafe connection fields', async () => {
    mocks.retest.mockResolvedValueOnce(connection({
      status: 'degraded', lastErrorCode: 'grant_unexpected',
      vaultRef: 'akv://must-not-audit', administratorObjectId: 'must-not-audit',
    }));

    const response = await app().request(
      `/m365/customer-graph-actions/connections/${CONNECTION_ID}/retest?orgId=${ORG_ID}`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(mocks.audit.mock.calls.map((call) => call[1].event)).toEqual([
      'm365.customer_graph_actions.retested',
      'm365.customer_graph_actions.grant_drift_detected',
    ]);
    expect(mocks.audit.mock.calls[1]?.[1]).toMatchObject({ outcome: 'grant_unexpected' });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('must-not-audit');
  });

  it('records disconnect exactly once with the acting user and revoked outcome', async () => {
    const response = await app().request(
      `/m365/customer-graph-actions/connections/${CONNECTION_ID}/disconnect?orgId=${ORG_ID}`,
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
        manifestVersion: 1,
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
      event: 'm365.customer_graph_actions.disconnected', outcome: 'revoked',
      connectionId: CONNECTION_ID, actorId: USER_ID,
    }));
  });

  it('maps both scope misses and ownership conflicts to the same non-oracular response', async () => {
    authRef.current = auth({ scope: 'partner', orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: [ORG_ID] });
    const scopeMiss = await app().request(`/m365/customer-graph-actions/connections/${CONNECTION_ID}/retest?orgId=${OTHER_ORG_ID}`, { method: 'POST' });

    mocks.retest.mockRejectedValueOnce({ code: 'connection_not_found' });
    const conflict = await app().request(`/m365/customer-graph-actions/connections/${CONNECTION_ID}/retest?orgId=${ORG_ID}`, { method: 'POST' });

    expect(scopeMiss.status).toBe(404);
    expect(conflict.status).toBe(404);
    expect(await scopeMiss.json()).toEqual(await conflict.json());
  });
});

const strictOrgQueryRoutes = [
  ['list', 'GET', '/m365/customer-graph-actions/connections'],
  ['consent', 'POST', '/m365/customer-graph-actions/connections/consent'],
  ['retest', 'POST', `/m365/customer-graph-actions/connections/${CONNECTION_ID}/retest`],
  ['disconnect', 'POST', `/m365/customer-graph-actions/connections/${CONNECTION_ID}/disconnect`],
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

// Regression for the confirmed-critical route-collision bug: both routers
// mount under index.ts exactly like `mountedLikeIndex()` below. Before the
// fix, m365CustomerGraphActionsRoutes was mounted at the SAME `/m365` base
// as m365CustomerGraphReadRoutes with identical literal paths for list,
// retest, and disconnect — Hono resolved all three to the first-mounted
// (read) sub-app, silently killing the actions handlers. This suite would
// have failed on that shape; it must keep passing on any future mount change.
describe('cross-mount route ownership (mounted exactly as index.ts)', () => {
  it('routes GET /m365/connections to READ and GET /m365/customer-graph-actions/connections to ACTIONS', async () => {
    const target = mountedLikeIndex();

    const readResponse = await target.request(`/m365/connections?orgId=${ORG_ID}`);
    expect(readResponse.status).toBe(200);
    expect(mocks.readList).toHaveBeenCalledWith(ORG_ID);
    expect(mocks.list).not.toHaveBeenCalled();
    await expect(readResponse.json()).resolves.toMatchObject({
      profile: { id: 'customer-graph-read' },
    });

    const actionsResponse = await target.request(`/m365/customer-graph-actions/connections?orgId=${ORG_ID}`);
    expect(actionsResponse.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(ORG_ID);
    expect(mocks.readList).toHaveBeenCalledTimes(1);
    await expect(actionsResponse.json()).resolves.toMatchObject({
      profile: { id: 'customer-graph-actions' },
    });
  });

  it('routes consent to the profile-matched service and never cross-calls the other profile', async () => {
    const target = mountedLikeIndex();

    const readConsent = await target.request(`/m365/connections/customer-graph-read/consent?orgId=${ORG_ID}`, { method: 'POST' });
    expect(readConsent.status).toBe(200);
    expect(mocks.readInitiate).toHaveBeenCalledWith({ orgId: ORG_ID, actorId: USER_ID });
    expect(mocks.initiate).not.toHaveBeenCalled();

    const actionsConsent = await target.request(`/m365/customer-graph-actions/connections/consent?orgId=${ORG_ID}`, { method: 'POST' });
    expect(actionsConsent.status).toBe(200);
    expect(mocks.initiate).toHaveBeenCalledWith({ orgId: ORG_ID, actorId: USER_ID });
    expect(mocks.readInitiate).toHaveBeenCalledTimes(1);
  });

  it('routes retest to the profile-matched service for the same connection id shape', async () => {
    const target = mountedLikeIndex();

    const readRetest = await target.request(`/m365/connections/${CONNECTION_ID}/retest?orgId=${ORG_ID}`, { method: 'POST' });
    expect(readRetest.status).toBe(200);
    expect(mocks.readRetest).toHaveBeenCalledWith(expect.objectContaining({ id: CONNECTION_ID, orgId: ORG_ID }));
    expect(mocks.retest).not.toHaveBeenCalled();

    const actionsRetest = await target.request(`/m365/customer-graph-actions/connections/${CONNECTION_ID}/retest?orgId=${ORG_ID}`, { method: 'POST' });
    expect(actionsRetest.status).toBe(200);
    expect(mocks.retest).toHaveBeenCalledWith(expect.objectContaining({ id: CONNECTION_ID, orgId: ORG_ID }));
    expect(mocks.readRetest).toHaveBeenCalledTimes(1);
  });

  it('routes disconnect to the profile-matched service for the same connection id shape', async () => {
    const target = mountedLikeIndex();

    const readDisconnect = await target.request(`/m365/connections/${CONNECTION_ID}/disconnect?orgId=${ORG_ID}`, { method: 'POST' });
    expect(readDisconnect.status).toBe(200);
    expect(mocks.readDisconnect).toHaveBeenCalledWith(expect.objectContaining({ id: CONNECTION_ID, orgId: ORG_ID }));
    expect(mocks.disconnect).not.toHaveBeenCalled();

    const actionsDisconnect = await target.request(`/m365/customer-graph-actions/connections/${CONNECTION_ID}/disconnect?orgId=${ORG_ID}`, { method: 'POST' });
    expect(actionsDisconnect.status).toBe(200);
    expect(mocks.disconnect).toHaveBeenCalledWith(expect.objectContaining({ id: CONNECTION_ID, orgId: ORG_ID }));
    expect(mocks.readDisconnect).toHaveBeenCalledTimes(1);
  });
});
