/**
 * Regression: partner-scope users with >1 accessible org must be able to scope
 * requests via the `?orgId=` query string (or `body.orgId` for POST/JSON
 * handlers). See issue #620.
 *
 * Each affected route file is exercised: the resolver should accept the
 * user-supplied orgId, validate it against `accessibleOrgIds`, and forward it
 * through. Foreign orgIds must 403; missing orgId must still 400 with the
 * existing "orgId is required..." message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authState, ORG_A, ORG_B, FOREIGN_ORG } = vi.hoisted(() => {
  const ORG_A = '11111111-1111-1111-1111-111111111111';
  const ORG_B = '22222222-2222-2222-2222-222222222222';
  const FOREIGN_ORG = '33333333-3333-3333-3333-333333333333';
  return {
    ORG_A,
    ORG_B,
    FOREIGN_ORG,
    authState: {
      scope: 'partner' as 'partner' | 'organization' | 'system',
      orgId: null as string | null,
      partnerId: 'partner-1' as string | null,
      accessibleOrgIds: [ORG_A, ORG_B] as string[] | null,
    },
  };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test' },
      userId: 'user-1',
      scope: authState.scope,
      orgId: authState.orgId,
      partnerId: authState.partnerId,
      accessibleOrgIds: authState.accessibleOrgIds,
      canAccessOrg: (id: string) => Array.isArray(authState.accessibleOrgIds)
        && authState.accessibleOrgIds.includes(id),
      orgCondition: () => undefined,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

// ---------------------------------------------------------------------------
// db / chain mocks shared across all four route imports
// ---------------------------------------------------------------------------
function chainMock(terminalValue: any) {
  const handler: ProxyHandler<any> = {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      return (..._args: any[]) => new Proxy(
        () => Promise.resolve(terminalValue),
        {
          get(_t2, p) {
            if (p === 'then') return (resolve: any) => resolve(terminalValue);
            return (..._a: any[]) => new Proxy(() => Promise.resolve(terminalValue), handler);
          },
          apply() { return Promise.resolve(terminalValue); },
        }
      );
    },
  };
  return new Proxy({}, handler);
}

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null },
  db: {
    select: vi.fn(() => chainMock([{ count: 0 }])),
    insert: vi.fn(() => chainMock([])),
    update: vi.fn(() => chainMock(undefined)),
    delete: vi.fn(() => chainMock(undefined)),
    transaction: vi.fn(async (fn: any) => fn({
      select: vi.fn(() => chainMock([])),
      insert: vi.fn(() => chainMock([])),
      update: vi.fn(() => chainMock([])),
    })),
  },
}));

vi.mock('../db/schema', () => ({
  softwareCatalog: { id: 'id', orgId: 'orgId', name: 'name', vendor: 'vendor', description: 'description', category: 'category' },
  softwareVersions: { id: 'id', catalogId: 'catalogId', isLatest: 'isLatest' },
  softwareDeployments: { id: 'id', orgId: 'orgId' },
  deploymentResults: { deploymentId: 'deploymentId', status: 'status' },
  softwareInventory: {
    deviceId: 'deviceId',
    name: 'name',
    vendor: 'vendor',
    version: 'version',
    lastSeen: 'lastSeen',
  },
  softwarePolicies: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    mode: 'mode',
    isActive: 'isActive',
    rules: 'rules',
  },
  configurationPolicies: { id: 'id', orgId: 'orgId', name: 'name', status: 'status' },
  configPolicyFeatureLinks: {
    configPolicyId: 'configPolicyId',
    featureType: 'featureType',
    featurePolicyId: 'featurePolicyId',
    updatedAt: 'updatedAt',
  },
  configPolicyAssignments: {
    configPolicyId: 'configPolicyId',
    level: 'level',
    targetId: 'targetId',
    priority: 'priority',
    assignedBy: 'assignedBy',
  },
  devices: { id: 'id', orgId: 'orgId', agentId: 'agentId', siteId: 'siteId', status: 'status' },
  discoveryProfiles: { id: 'id', orgId: 'orgId', siteId: 'siteId' },
  discoveryJobs: { id: 'id', status: 'status', completedAt: 'completedAt', errors: 'errors', updatedAt: 'updatedAt' },
  discoveredAssets: { id: 'id', orgId: 'orgId' },
  huntressIntegrations: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    accountId: 'accountId',
    apiBaseUrl: 'apiBaseUrl',
    apiKeyEncrypted: 'apiKeyEncrypted',
    webhookSecretEncrypted: 'webhookSecretEncrypted',
    isActive: 'isActive',
    lastSyncAt: 'lastSyncAt',
    lastSyncStatus: 'lastSyncStatus',
    lastSyncError: 'lastSyncError',
    createdBy: 'createdBy',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  huntressAgents: { integrationId: 'integrationId', deviceId: 'deviceId', status: 'status' },
  huntressIncidents: {
    id: 'id', orgId: 'orgId', integrationId: 'integrationId', deviceId: 'deviceId',
    huntressIncidentId: 'huntressIncidentId', severity: 'severity', category: 'category',
    title: 'title', description: 'description', recommendation: 'recommendation',
    status: 'status', reportedAt: 'reportedAt', resolvedAt: 'resolvedAt', details: 'details',
    createdAt: 'createdAt', updatedAt: 'updatedAt',
  },
}));

// External services pulled in by these route files
vi.mock('../services', () => ({}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn(), writeAuditEvent: vi.fn() }));
vi.mock('../services/deploymentTargetResolver', () => ({ resolveDeploymentTargets: vi.fn().mockResolvedValue([]) }));
vi.mock('../services/s3Storage', () => ({
  uploadBinary: vi.fn(),
  getPresignedUrl: vi.fn(() => Promise.resolve('https://s3.example.com/presigned')),
  isS3Configured: vi.fn(() => false),
}));
vi.mock('../services/redis', () => ({
  isRedisAvailable: vi.fn(() => false),
  getRedisConnection: vi.fn(),
}));
vi.mock('../jobs/discoveryWorker', () => ({
  enqueueDiscoveryScan: vi.fn(async () => {}),
  getDiscoveryQueue: vi.fn(() => null),
}));
vi.mock('../services/discoveryJobCreation', () => ({
  createDiscoveryJobIfIdle: vi.fn(async ({ profileId }: any) => ({
    job: { id: 'job-1', profileId, status: 'scheduled' },
    created: true,
  })),
}));
vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true),
}));
vi.mock('../jobs/huntressSync', () => ({
  scheduleHuntressSync: vi.fn(async () => 'job-1'),
  ingestHuntressWebhookPayload: vi.fn(),
  findHuntressIntegrationByAccount: vi.fn(async () => ({ status: 'none' as const })),
}));
vi.mock('../services/huntressClient', () => ({}));
vi.mock('../services/huntressConstants', () => ({
  offlineStatusSqlList: [],
  resolvedStatusSqlList: [],
}));
vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((v: string | undefined) => `enc:${v ?? ''}`),
  decryptSecret: vi.fn(() => 'secret'),
  isEncryptedSecret: vi.fn(() => false),
}));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: new Proxy(
    {},
    {
      get: () => ({ resource: 'res', action: 'act' }),
    }
  ),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: partner-scope user with TWO accessible orgs.
  authState.scope = 'partner';
  authState.orgId = null;
  authState.partnerId = 'partner-1';
  authState.accessibleOrgIds = [ORG_A, ORG_B];
});

async function expectNotOrgIdRequired400(res: Response) {
  if (res.status === 400) {
    const body = await res.clone().json().catch(() => ({}));
    expect(String((body as { error?: string }).error ?? '')).not.toMatch(/orgId is required/i);
    expect(String((body as { error?: string }).error ?? '')).not.toMatch(/Organization context required/i);
  }
}

describe('issue #620: partner-multi-org orgId pass-through', () => {
  describe('software catalog routes', () => {
    it('GET /software/catalog accepts ?orgId= for partner-multi-org user', async () => {
      const { softwareRoutes } = await import('./software');
      const app = new Hono().route('/software', softwareRoutes);

      const res = await app.request(`/software/catalog?orgId=${ORG_A}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      });

      await expectNotOrgIdRequired400(res);
    });

    it('GET /software/catalog 400s when orgId is missing', async () => {
      const { softwareRoutes } = await import('./software');
      const app = new Hono().route('/software', softwareRoutes);

      const res = await app.request('/software/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(String(body.error)).toMatch(/orgId is required/i);
    });

    it('GET /software/catalog 403s when ?orgId= points outside accessibleOrgIds', async () => {
      const { softwareRoutes } = await import('./software');
      const app = new Hono().route('/software', softwareRoutes);

      const res = await app.request(`/software/catalog?orgId=${FOREIGN_ORG}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(403);
    });

    it('GET /software/catalog/search accepts ?orgId=', async () => {
      const { softwareRoutes } = await import('./software');
      const app = new Hono().route('/software', softwareRoutes);

      const res = await app.request(`/software/catalog/search?q=foo&orgId=${ORG_A}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      });

      await expectNotOrgIdRequired400(res);
    });

    it('POST /software/catalog accepts orgId in body', async () => {
      const { softwareRoutes } = await import('./software');
      const app = new Hono().route('/software', softwareRoutes);

      const res = await app.request('/software/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ name: 'Acme', orgId: ORG_A }),
      });

      await expectNotOrgIdRequired400(res);
    });
  });

  describe('software inventory routes', () => {
    it('GET /software-inventory accepts ?orgId=', async () => {
      const { softwareInventoryRoutes } = await import('./softwareInventory');
      const app = new Hono().route('/software-inventory', softwareInventoryRoutes);

      const res = await app.request(`/software-inventory?orgId=${ORG_A}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      });

      await expectNotOrgIdRequired400(res);
    });

    it('GET /software-inventory 400s when orgId is missing', async () => {
      const { softwareInventoryRoutes } = await import('./softwareInventory');
      const app = new Hono().route('/software-inventory', softwareInventoryRoutes);

      const res = await app.request('/software-inventory', {
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(400);
    });

    it('GET /software-inventory 403s when ?orgId= is foreign', async () => {
      const { softwareInventoryRoutes } = await import('./softwareInventory');
      const app = new Hono().route('/software-inventory', softwareInventoryRoutes);

      const res = await app.request(`/software-inventory?orgId=${FOREIGN_ORG}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(403);
    });
  });

  describe('discovery scan route', () => {
    it('POST /discovery/scan accepts orgId in body', async () => {
      const { discoveryRoutes } = await import('./discovery');
      const app = new Hono().route('/discovery', discoveryRoutes);

      const res = await app.request('/discovery/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({
          profileId: '99999999-9999-9999-9999-999999999999',
          orgId: ORG_A,
        }),
      });

      await expectNotOrgIdRequired400(res);
    });

    it('POST /discovery/scan 400s when orgId is missing for partner-multi-org user', async () => {
      const { discoveryRoutes } = await import('./discovery');
      const app = new Hono().route('/discovery', discoveryRoutes);

      const res = await app.request('/discovery/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ profileId: '99999999-9999-9999-9999-999999999999' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(String(body.error)).toMatch(/orgId is required/i);
    });
  });

  describe('huntress integration save', () => {
    it('POST /huntress/integration accepts ?orgId= as a fallback for body.orgId', async () => {
      const { huntressRoutes } = await import('./huntress');
      const app = new Hono().route('/huntress', huntressRoutes);

      const res = await app.request(`/huntress/integration?orgId=${ORG_A}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ name: 'Primary', apiKey: 'k' }),
      });

      await expectNotOrgIdRequired400(res);
    });
  });
});
