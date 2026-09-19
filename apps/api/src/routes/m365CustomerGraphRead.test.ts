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
  /** A defined value (including []) is a SITE CEILING — services/siteCeilingAccess.ts. */
  allowedSiteIds?: string[];
};

const { authRef, mocks } = vi.hoisted(() => ({
  authRef: { current: null as AuthState | null },
  mocks: {
    list: vi.fn(),
    initiate: vi.fn(),
    upgrade: vi.fn(),
    retest: vi.fn(),
    disconnect: vi.fn(),
    onboardingEnabled: vi.fn(() => true),
    buildBindingCookie: vi.fn(() => 'binding-cookie=opaque; HttpOnly; SameSite=Lax'),
    audit: vi.fn(),
    canAccessOrg: vi.fn(),
    syncFlag: vi.fn(() => true),
    slot: vi.fn(async (_orgId: string): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> => ({ allowed: true })),
    releaseSlot: vi.fn(async (_orgId: string) => {}),
    requestSync: vi.fn(async (_input: unknown) => {}),
    summary: vi.fn(async (_orgId: string, _tenantId: string | null): Promise<unknown> => null),
  },
}));

vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isM365TenantSyncEnabled: mocks.syncFlag,
}));
vi.mock('../services/m365Sync/onDemandLimiter', () => ({
  ON_DEMAND_SYNC_WINDOW_SECONDS: 900,
  consumeOnDemandSyncSlot: mocks.slot,
  releaseOnDemandSyncSlot: mocks.releaseSlot,
}));
vi.mock('../services/m365Sync/lifecycle', () => ({
  ON_DEMAND_SYNC_DOMAINS: ['users', 'intune_devices', 'ca_policies', 'skus', 'secure_score'],
  requestOnDemandSync: mocks.requestSync,
}));
vi.mock('../services/m365Sync/summary', () => ({ loadSyncSummary: mocks.summary }));

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
  initiateCustomerGraphReadUpgradeConsent: mocks.upgrade,
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
import { SITE_CEILING_WRITE_DENIED_MESSAGE } from '../services/siteCeilingAccess';

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
    permissionManifestVersion: 3,
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
    permissionManifestVersion: 3, observedGrants: [], grantsVerifiedAt: null,
    lastVerifiedAt: null, grantHealth: undefined,
  }));
  mocks.buildBindingCookie.mockReturnValue('binding-cookie=opaque; HttpOnly; SameSite=Lax');
  mocks.syncFlag.mockReturnValue(true);
  mocks.slot.mockResolvedValue({ allowed: true });
  mocks.requestSync.mockResolvedValue(undefined);
  mocks.summary.mockResolvedValue(null);
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
      profile: { id: 'customer-graph-read', displayName: 'Customer Graph Read', manifestVersion: 3 },
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
      grantHealth: 'active',
      manifestVersion: 3,
      currentManifestVersion: 3,
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
      manifestVersion: 3,
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
      outcome: 'active', consentAttemptId: ATTEMPT_ID, manifestVersion: 3,
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
        manifestVersion: 3,
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

describe('connection DTO grant health', () => {
  it('exposes the derived health, the stored version, and the current version', async () => {
    // deriveGrantHealth already returns manifest-stale for a lagging row;
    // before this change the DTO forwarded stored status only, so the web card
    // could not tell a stale manifest from a healthy one (spec §2.2).
    mocks.list.mockResolvedValue([connection({
      permissionManifestVersion: 2,
      grantHealth: undefined,
    })]);

    const response = await app().request(`/m365/connections?orgId=${ORG_ID}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.connection.grantHealth).toBe('manifest-stale');
    expect(body.connection.manifestVersion).toBe(2);
    expect(body.connection.currentManifestVersion).toBe(3);
  });

  it('reports active health for a current, fully granted connection', async () => {
    mocks.list.mockResolvedValue([connection()]);

    const body = await (await app().request(`/m365/connections?orgId=${ORG_ID}`)).json();

    expect(body.connection.grantHealth).toBe('active');
    expect(body.connection.manifestVersion).toBe(3);
    expect(body.connection.currentManifestVersion).toBe(3);
  });
});

describe('POST /m365/connections/:id/upgrade-consent', () => {
  beforeEach(() => {
    mocks.upgrade.mockResolvedValue({
      connection: connection(),
      rawState: 'raw-state',
      consentUrl: 'https://login.microsoftonline.com/common/adminconsent?state=raw-state',
    });
  });

  it('requires MFA exactly like retest', async () => {
    authRef.current = auth({ mfa: false });

    const response = await app().request(
      `/m365/connections/${CONNECTION_ID}/upgrade-consent?orgId=${ORG_ID}`,
      { method: 'POST' },
    );

    expect(response.status).toBe(403);
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it('requires organizations:write', async () => {
    authRef.current = auth({ permissions: new Set(['organizations:read']) });

    const response = await app().request(
      `/m365/connections/${CONNECTION_ID}/upgrade-consent?orgId=${ORG_ID}`,
      { method: 'POST' },
    );

    expect(response.status).toBe(403);
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it('returns the Microsoft admin-consent URL and sets the browser binding', async () => {
    const response = await app().request(
      `/m365/connections/${CONNECTION_ID}/upgrade-consent?orgId=${ORG_ID}`,
      { method: 'POST' },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      adminConsentUrl: 'https://login.microsoftonline.com/common/adminconsent?state=raw-state',
    });
    expect(response.headers.get('set-cookie')).toContain('binding-cookie=');
    expect(mocks.upgrade).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'm365.customer_graph_read.upgrade_consent_initiated',
      outcome: 'initiated',
    }));
  });

  it('404s a connection in another organization', async () => {
    const response = await app().request(
      `/m365/connections/${CONNECTION_ID}/upgrade-consent?orgId=${OTHER_ORG_ID}`,
      { method: 'POST' },
    );

    expect(response.status).toBe(404);
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it('409s when the stored manifest is already current', async () => {
    mocks.upgrade.mockRejectedValue(
      Object.assign(new Error('manifest_current'), { code: 'manifest_current' }),
    );

    const response = await app().request(
      `/m365/connections/${CONNECTION_ID}/upgrade-consent?orgId=${ORG_ID}`,
      { method: 'POST' },
    );

    expect(response.status).toBe(409);
  });
});

describe('POST /m365/connections/:id/sync (W05, spec §5.2)', () => {
  const postSync = (orgId = ORG_ID) => app().request(
    `/m365/connections/${CONNECTION_ID}/sync?orgId=${orgId}`,
    { method: 'POST' },
  );

  beforeEach(() => {
    mocks.list.mockResolvedValue([connection()]);
  });

  it('requests the five non-sign-in domains and echoes them', async () => {
    const response = await postSync();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      requested: true,
      domains: ['users', 'intune_devices', 'ca_policies', 'skus', 'secure_score'],
    });
    expect(mocks.slot).toHaveBeenCalledWith(ORG_ID);
    expect(mocks.requestSync).toHaveBeenCalledWith({ orgId: ORG_ID, connectionId: CONNECTION_ID });
  });

  it('is MFA-gated exactly like retest', async () => {
    authRef.current = auth({ mfa: false });
    expect((await postSync()).status).toBe(403);
    expect(mocks.slot).not.toHaveBeenCalled();
    expect(mocks.requestSync).not.toHaveBeenCalled();
  });

  it('requires organizations:write', async () => {
    authRef.current = auth({ permissions: new Set(['organizations:read']) });
    expect((await postSync()).status).toBe(403);
    expect(mocks.requestSync).not.toHaveBeenCalled();
  });

  it('returns 404 when the tenant-sync flag is off, WITHOUT burning a slot', async () => {
    mocks.syncFlag.mockReturnValue(false);
    expect((await postSync()).status).toBe(404);
    expect(mocks.slot).not.toHaveBeenCalled();
    expect(mocks.requestSync).not.toHaveBeenCalled();
  });

  it('returns 429 with retryAfter and a Retry-After header when limited', async () => {
    mocks.slot.mockResolvedValue({ allowed: false, retryAfterSeconds: 412 });
    const response = await postSync();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('412');
    await expect(response.json()).resolves.toMatchObject({ retryAfter: 412 });
    expect(mocks.requestSync).not.toHaveBeenCalled();
  });

  it('404s an unknown connection id BEFORE consuming a slot', async () => {
    mocks.list.mockResolvedValue([]);
    expect((await postSync()).status).toBe(404);
    expect(mocks.slot).not.toHaveBeenCalled();
  });

  it('404s a connection that is not executable', async () => {
    mocks.list.mockResolvedValue([connection({ status: 'revoked' })]);
    expect((await postSync()).status).toBe(404);
    expect(mocks.slot).not.toHaveBeenCalled();
  });

  it('404s a connection in another organization', async () => {
    const response = await postSync(OTHER_ORG_ID);
    expect(response.status).toBe(404);
    expect(mocks.requestSync).not.toHaveBeenCalled();
  });

  it('accepts a degraded connection — a missing optional grant still syncs the rest', async () => {
    mocks.list.mockResolvedValue([connection({ status: 'degraded' })]);
    expect((await postSync()).status).toBe(200);
  });

  it('records the sync_requested audit event', async () => {
    await postSync();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'm365.customer_graph_read.sync_requested',
      orgId: ORG_ID,
      connectionId: CONNECTION_ID,
      outcome: 'initiated',
      actorId: USER_ID,
    }));
  });

  it('releases the slot and answers 409 when the claim/enqueue fails, recording no event', async () => {
    mocks.requestSync.mockRejectedValue(new Error('redis down'));
    const response = await postSync();
    expect(response.status).toBe(409);
    expect(mocks.releaseSlot).toHaveBeenCalledWith(ORG_ID);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('GET /m365/connections exposes the sync block on the ENVELOPE (W05)', () => {
  const SUMMARY = { lastSuccessAt: '2026-09-08T09:00:00.000Z', users: 128, devices: 96, domains: [] };

  it('carries syncEnabled true and the summary, read for the connection tenant', async () => {
    mocks.list.mockResolvedValue([connection()]);
    mocks.summary.mockResolvedValue(SUMMARY);
    const body = await (await app().request(`/m365/connections?orgId=${ORG_ID}`)).json();
    expect(body.syncEnabled).toBe(true);
    expect(body.sync).toEqual(SUMMARY);
    expect(mocks.summary).toHaveBeenCalledWith(ORG_ID, TENANT_ID);
  });

  it('carries syncEnabled false and a null sync block when the flag is off', async () => {
    mocks.syncFlag.mockReturnValue(false);
    const body = await (await app().request(`/m365/connections?orgId=${ORG_ID}`)).json();
    expect(body.syncEnabled).toBe(false);
    expect(body.sync).toBeNull();
    expect(mocks.summary).not.toHaveBeenCalled();
  });

  it('keeps the envelope key set exact and never puts sync fields on the connection DTO', async () => {
    mocks.list.mockResolvedValue([connection()]);
    const body = await (await app().request(`/m365/connections?orgId=${ORG_ID}`)).json();
    expect(Object.keys(body).sort()).toEqual(['connection', 'onboardingEnabled', 'profile', 'sync', 'syncEnabled']);
    expect(body.connection).not.toHaveProperty('sync');
    expect(body.connection).not.toHaveProperty('syncEnabled');
    expect(body.connection).toMatchObject({
      grantHealth: expect.any(String), manifestVersion: 3, currentManifestVersion: expect.any(Number),
    });
  });

  it('passes a null tenant when there is no connection', async () => {
    await app().request(`/m365/connections?orgId=${ORG_ID}`);
    expect(mocks.summary).toHaveBeenCalledWith(ORG_ID, null);
  });
});

/**
 * Establishing, retesting or severing the customer Graph READ credential is
 * still an org-wide governance act: the connection covers the org's whole
 * Entra tenant and has no per-site slice. Same class — and same gap — as the
 * Actions surface and the legacy /m365/connection routes.
 */
describe('customer-graph-read mutations — org-wide governance site ceiling', () => {
  it.each(mutationRequests)('%s is 403 for a site-restricted caller', async (_name, request) => {
    authRef.current = auth({ allowedSiteIds: ['site-1'] });
    const response = await request();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: SITE_CEILING_WRITE_DENIED_MESSAGE });
  });

  it.each(mutationRequests)('%s is 403 when the ceiling is the EMPTY site list', async (_name, request) => {
    authRef.current = auth({ allowedSiteIds: [] });
    expect((await request()).status).toBe(403);
  });

  it.each(mutationRequests)('%s still succeeds for an UNRESTRICTED caller', async (_name, request) => {
    expect((await request()).status).toBe(200);
  });
});
