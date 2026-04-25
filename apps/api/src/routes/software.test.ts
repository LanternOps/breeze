import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { softwareRoutes, computeSoftwareDeploymentAggregateStatus } from './software';

vi.mock('../services', () => ({}));

// Chain-friendly mock builder for Drizzle query builder patterns
function chainMock(terminalValue: any) {
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop === 'then') return undefined; // not a thenable
      return (..._args: any[]) => new Proxy(
        () => Promise.resolve(terminalValue),
        {
          get(_t, p) {
            if (p === 'then') {
              // Allow awaiting the terminal mock
              return (resolve: any) => resolve(terminalValue);
            }
            return (..._a: any[]) => new Proxy(() => Promise.resolve(terminalValue), handler);
          },
          apply() {
            return Promise.resolve(terminalValue);
          }
        }
      );
    }
  };
  return new Proxy({}, handler);
}

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => chainMock([])),
    insert: vi.fn(() => chainMock([])),
    update: vi.fn(() => chainMock(undefined)),
    delete: vi.fn(() => chainMock(undefined)),
    transaction: vi.fn(async (fn) => fn({
      update: vi.fn(() => chainMock([])),
      insert: vi.fn(() => chainMock([])),
    })),
  }
}));

vi.mock('../db/schema', () => ({
  softwareCatalog: { id: 'id', orgId: 'org_id', name: 'name', vendor: 'vendor', description: 'description', category: 'category' },
  softwareVersions: { id: 'id', catalogId: 'catalog_id', isLatest: 'is_latest' },
  softwareDeployments: { id: 'id', orgId: 'org_id' },
  deploymentResults: { deploymentId: 'deployment_id', status: 'status' },
  softwareInventory: { deviceId: 'device_id', name: 'name' },
  devices: { id: 'id', orgId: 'org_id', agentId: 'agent_id' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      userId: 'user-123',
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/deploymentTargetResolver', () => ({
  resolveDeploymentTargets: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/s3Storage', () => ({
  uploadBinary: vi.fn(),
  getPresignedUrl: vi.fn(() => Promise.resolve('https://s3.example.com/presigned')),
  isS3Configured: vi.fn(() => false)
}));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true)
}));

describe('software routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/software', softwareRoutes);
  });

  describe('GET /software/catalog', () => {
    it('should return 200 with paginated data', async () => {
      const res = await app.request('/software/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
    });
  });

  describe('GET /software/inventory', () => {
    it('should return 200 with inventory list', async () => {
      const res = await app.request('/software/inventory', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
    });
  });

  describe('POST /software/deploy validation', () => {
    it('rejects empty body with 400 (missing softwareId)', async () => {
      const res = await app.request('/software/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(400);
    });

    it('rejects non-UUID softwareId with 400', async () => {
      const res = await app.request('/software/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ softwareId: 'not-a-uuid', version: '1.0.0' })
      });
      expect(res.status).toBe(400);
    });

    it('rejects missing version with 400', async () => {
      const res = await app.request('/software/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ softwareId: '11111111-1111-1111-1111-111111111111' })
      });
      expect(res.status).toBe(400);
    });
  });

});

describe('computeSoftwareDeploymentAggregateStatus', () => {
  it('returns pending when all results are pending', () => {
    expect(computeSoftwareDeploymentAggregateStatus([{ status: 'pending', count: 4 }])).toBe('pending');
  });

  it('returns in_progress when running statuses are present', () => {
    expect(computeSoftwareDeploymentAggregateStatus([
      { status: 'pending', count: 2 },
      { status: 'running', count: 1 },
    ])).toBe('in_progress');
  });

  it('returns completed when all results completed', () => {
    expect(computeSoftwareDeploymentAggregateStatus([{ status: 'completed', count: 3 }])).toBe('completed');
  });

  it('returns failed when failures exist without completed results', () => {
    expect(computeSoftwareDeploymentAggregateStatus([{ status: 'failed', count: 2 }])).toBe('failed');
  });

  it('returns completed_with_errors when failures and completed results coexist', () => {
    expect(computeSoftwareDeploymentAggregateStatus([
      { status: 'completed', count: 2 },
      { status: 'failed', count: 1 },
    ])).toBe('completed_with_errors');
  });

  it('returns cancelled when all results are cancelled', () => {
    expect(computeSoftwareDeploymentAggregateStatus([{ status: 'cancelled', count: 5 }])).toBe('cancelled');
  });

  it('returns in_progress for mixed pending and completed results', () => {
    expect(computeSoftwareDeploymentAggregateStatus([
      { status: 'pending', count: 1 },
      { status: 'completed', count: 1 },
    ])).toBe('in_progress');
  });
});
