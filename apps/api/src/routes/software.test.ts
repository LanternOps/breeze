import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { softwareRoutes, computeSoftwareDeploymentAggregateStatus } from './software';
import { db } from '../db';
import {
  uploadBinary,
  isS3Configured,
  S3ConfigError,
  S3OperationError,
} from '../services/s3Storage';
import { captureException, captureMessage } from '../services/sentry';
import { parseStreamingMultipart } from '../services/streamingUpload';
import { createHash } from 'node:crypto';
import { authMiddleware } from '../middleware/auth';
import { inArray, eq, isNull } from 'drizzle-orm';
import { resolveDeploymentTargets } from '../services/deploymentTargetResolver';
import { createSoftwareDeployment } from '../services/softwareDeployment';
import { writeRouteAudit } from '../services/auditEvents';
import {
  getOrganizationSoftwareDownloadPolicy,
  setOrganizationSoftwareDownloadPolicy,
  setSiteSoftwareDownloadPolicy,
} from '../services/softwareDownloadPolicy';

// Hoist the softwareDeployment service mock factories so the references are
// available both inside the vi.mock factory and in the test body.
const { createDeploymentMock, buildDispatchMock, applyAutomationActionTerminalMock } = vi.hoisted(() => ({
  createDeploymentMock: vi.fn(),
  buildDispatchMock: vi.fn(),
  applyAutomationActionTerminalMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services', () => ({}));

vi.mock('../services/softwareDeployment', () => ({
  createSoftwareDeployment: createDeploymentMock,
  buildAndDispatchSoftwareInstalls: buildDispatchMock,
}));

vi.mock('../services/automationActionResults', () => ({
  applyAutomationActionTerminal: (...args: unknown[]) =>
    applyAutomationActionTerminalMock(...(args as [])),
}));

// Wrap drizzle's condition builders in spies (behavior preserved) so tests can
// assert the actual org-scoping WHERE condition, not just that a query ran.
// `vi.clearAllMocks()` clears call records but keeps these implementations.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, inArray: vi.fn(actual.inArray), eq: vi.fn(actual.eq), isNull: vi.fn(actual.isNull) };
});

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
  softwareCatalog: { id: 'id', orgId: 'org_id', partnerId: 'partner_id', integrationProvider: 'integration_provider', name: 'name', vendor: 'vendor', description: 'description', category: 'category' },
  softwareVersions: { id: 'id', catalogId: 'catalog_id', isLatest: 'is_latest' },
  softwareDeployments: { id: 'id', orgId: 'org_id', softwareVersionId: 'software_version_id', createdAt: 'created_at', dispatchedAt: 'dispatched_at' },
  deploymentResults: { id: 'dr_id', deploymentId: 'deployment_id', deviceId: 'device_id', status: 'status', startedAt: 'started_at', completedAt: 'completed_at', exitCode: 'exit_code', output: 'output', errorMessage: 'error_message', retryCount: 'retry_count', deviceCommandId: 'device_command_id' },
  softwareInventory: { deviceId: 'device_id', name: 'name' },
  devices: {
    id: 'id',
    orgId: 'org_id',
    agentId: 'agent_id',
    siteId: 'site_id',
    hostname: 'hostname',
    customFields: 'custom_fields',
    osType: 'os_type',
    outboundNetworkPolicyVersion: 'outbound_network_policy_version',
  },
  softwareInstallMethods: {
    id: 'sim_id',
    catalogId: 'sim_catalog_id',
    platform: 'sim_platform',
    kind: 'sim_kind',
    packageId: 'sim_package_id',
    enabled: 'sim_enabled',
  },
  // Distinct literals so cancel-purge assertions are unambiguous vs the other tables.
  deviceCommands: { id: 'dc_id', deviceId: 'dc_device_id', status: 'dc_status', completedAt: 'dc_completed_at', result: 'dc_result' },
  organizations: { id: 'id', name: 'name' },
  sites: { id: 'id', orgId: 'org_id', name: 'name' },
}));

// Hoisted, mutable gate objects so individual tests can flip a gate to
// "deny" for one request without needing to re-invoke the outer
// requirePermission(...)/requireMfa() factory calls — those run once at
// route-registration time (module import), so their RETURNED inner
// middleware is what's actually wired into the router. The inner middleware
// below reads these gates live on every call, matching the pattern used by
// routes/alerts.test.ts.
const { permissionGate, mfaGate, siteAccessGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false },
  siteAccessGate: { deny: false },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      userId: 'user-123',
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      canAccessOrg: (orgId: string) => orgId === 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
  requireSiteAccess: vi.fn((_siteIdParam?: string) => async (c: any, next: any) => {
    if (siteAccessGate.deny) return c.json({ error: 'Access to this site denied' }, 403);
    return next();
  }),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/softwareDownloadPolicy', () => ({
  getEffectiveSoftwareDownloadPolicy: vi.fn(async () => ({
    version: 1,
    approvedPrivateOrigins: [] as string[],
  })),
  getOrganizationSoftwareDownloadPolicy: vi.fn(),
  setOrganizationSoftwareDownloadPolicy: vi.fn(),
  setSiteSoftwareDownloadPolicy: vi.fn(),
}));

vi.mock('../services/deploymentTargetResolver', () => ({
  resolveDeploymentTargets: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/s3Storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/s3Storage')>();
  return {
    uploadBinary: vi.fn(),
    getPresignedUrl: vi.fn(() => Promise.resolve('https://s3.example.com/presigned')),
    isS3Configured: vi.fn(() => false),
    // Real classes, not stubs: the upload route branches on `instanceof` to
    // pick 502 vs 503 (#2794), and a stubbed/undefined export would make that
    // check throw at runtime instead of mapping the error.
    S3ConfigError: actual.S3ConfigError,
    S3OperationError: actual.S3OperationError,
  };
});

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true)
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn()
}));

// Keep the real streaming parser by default; individual tests can override
// `parseStreamingMultipart` (e.g. to simulate a disk failure).
vi.mock('../services/streamingUpload', async () => {
  const actual = await vi.importActual<typeof import('../services/streamingUpload')>(
    '../services/streamingUpload'
  );
  return { ...actual, parseStreamingMultipart: vi.fn(actual.parseStreamingMultipart) };
});

describe('software routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    permissionGate.deny = false;
    mfaGate.deny = false;
    siteAccessGate.deny = false;
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

    it('projects enabled install-method aggregates for manager badges', async () => {
      const res = await app.request('/software/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      // The catalog list is the only feed the UI has for "is this package
      // deployable" — a winget/brew item ships zero versions, so the card would
      // read "0 versions" without these two aggregates.
      const projection = vi.mocked(db.select).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(projection).toHaveProperty('versionCount');
      expect(projection).toHaveProperty('methodCount');
      expect(projection).toHaveProperty('methodKinds');
    });

    it('lists catalog items across accessible orgs in partner All-Orgs scope', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-123',
          accessibleOrgIds: ['org-a', 'org-b']
        });
        return next();
      });

      const res = await app.request('/software/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
      expect(db.select).toHaveBeenCalledTimes(2);
      // The catalog query must be org-scoped to the partner's accessible orgs via
      // `inArray(softwareCatalog.orgId, accessibleOrgIds)`. (Schema is mocked so
      // `softwareCatalog.orgId` is the literal column name 'org_id'.) A refactor
      // that drops the inArray scoping — leaking every org's catalog — fails here.
      expect(inArray).toHaveBeenCalledWith('org_id', ['org-a', 'org-b']);
    });

    it('denies explicit orgId outside partner accessible orgs', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-123',
          accessibleOrgIds: ['11111111-1111-4111-8111-111111111111']
        });
        return next();
      });

      const res = await app.request('/software/catalog?orgId=22222222-2222-4222-8222-222222222222', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Access to this organization denied' });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('adds the partner-wide branch for partner scope and only for partner scope (#2135)', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-123',
          accessibleOrgIds: ['org-a', 'org-b'],
        });
        return next();
      });

      let res = await app.request('/software/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });
      expect(res.status).toBe(200);
      // Partner scope: the widened WHERE must include the caller's own
      // partner-wide custom rows — `org_id IS NULL AND partner_id = <own>`.
      expect(isNull).toHaveBeenCalledWith('org_id');
      expect(eq).toHaveBeenCalledWith('partner_id', 'partner-123');

      // Org scope (the default auth mock): the branch must be ABSENT — org
      // tokens never pass breeze_has_partner_access, so an app-layer partner
      // condition would promise rows RLS won't return.
      vi.mocked(isNull).mockClear();
      res = await app.request('/software/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });
      expect(res.status).toBe(200);
      expect(isNull).not.toHaveBeenCalledWith('org_id');
    });

    it('allows system scope to list a requested orgId', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'system',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: null
        });
        return next();
      });

      const res = await app.request('/software/catalog?orgId=22222222-2222-4222-8222-222222222222', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
      expect(db.select).toHaveBeenCalledTimes(2);
    });

    it('allows system scope to list the all-org catalog without orgId', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'system',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: null
        });
        return next();
      });

      const res = await app.request('/software/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
      expect(db.select).toHaveBeenCalledTimes(2);
    });

    it('returns an empty page without querying when partner All-Orgs has no accessible orgs', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-123',
          accessibleOrgIds: []
        });
        return next();
      });

      const res = await app.request('/software/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: [],
        pagination: { page: 1, limit: 50, total: 0 }
      });
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('POST /software/catalog (create)', () => {
    const setPartnerAuth = (partnerOrgAccess: 'all' | 'selected' | 'none') => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-123',
          partnerOrgAccess,
          accessibleOrgIds: ['org-a', 'org-b'],
        });
        return next();
      });
    };

    it('creates an org-owned package by default (org scope)', async () => {
      const row = { id: 'cat-1', name: 'Chrome', vendor: null, orgId: 'org-123', partnerId: null };
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn(() => ({ returning: vi.fn(async () => [row]) })),
      } as any);

      const res = await app.request('/software/catalog', {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Chrome' }),
      });

      expect(res.status).toBe(201);
      expect((await res.json()).data.orgId).toBe('org-123');
    });

    it('creates a partner-wide package for a full-partner admin (#2135)', async () => {
      setPartnerAuth('all');
      const row = { id: 'cat-2', name: 'Chrome', vendor: null, orgId: null, partnerId: 'partner-123' };
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn(() => ({ returning: vi.fn(async () => [row]) })),
      } as any);

      const res = await app.request('/software/catalog', {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Chrome', ownerScope: 'partner' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.orgId).toBeNull();
      expect(body.data.partnerId).toBe('partner-123');
    });

    it('rejects partner-wide creation without full partner org access', async () => {
      setPartnerAuth('selected');

      const res = await app.request('/software/catalog', {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Chrome', ownerScope: 'partner' }),
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/full partner org access/);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('still requires an org for org-owned creation in All-orgs scope', async () => {
      setPartnerAuth('all');

      const res = await app.request('/software/catalog', {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Chrome' }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('orgId is required for this scope');
    });
  });

  describe('PATCH /software/catalog/:id/versions/:versionId', () => {
    const CAT_ID = '33333333-3333-4333-8333-333333333333';
    const VER_ID = '44444444-4444-4444-8444-444444444444';
    const catalogRow = { id: CAT_ID, orgId: 'org-123', partnerId: null, integrationProvider: null, name: 'Chrome' };

    const mockSelects = (versionRow: unknown) => {
      vi.mocked(db.select)
        .mockReturnValueOnce({ from: () => ({ where: async () => [catalogRow] }) } as any)
        .mockReturnValueOnce({ from: () => ({ where: async () => (versionRow ? [versionRow] : []) }) } as any);
    };

    const patchReq = (body: unknown) =>
      app.request(`/software/catalog/${CAT_ID}/versions/${VER_ID}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('updates only the provided metadata fields', async () => {
      mockSelects({ id: VER_ID, catalogId: CAT_ID, version: '1.0.0', s3Key: null });
      const setSpy = vi.fn(() => ({
        where: () => ({ returning: async () => [{ id: VER_ID, version: '1.0.1', silentInstallArgs: '/S' }] }),
      }));
      vi.mocked(db.update).mockReturnValueOnce({ set: setSpy } as any);

      const res = await patchReq({ version: '1.0.1', silentInstallArgs: '/S' });

      expect(res.status).toBe(200);
      expect((await res.json()).data.version).toBe('1.0.1');
      expect(setSpy).toHaveBeenCalledWith({ version: '1.0.1', silentInstallArgs: '/S' });
    });

    it('404s for a version that does not belong to the catalog item', async () => {
      mockSelects(null);
      const res = await patchReq({ version: '2.0.0' });
      expect(res.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('refuses to clear the download URL of a URL-only version', async () => {
      mockSelects({ id: VER_ID, catalogId: CAT_ID, version: '1.0.0', s3Key: null });
      const res = await patchReq({ downloadUrl: null });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/needs a download URL/);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('400s an empty update', async () => {
      mockSelects({ id: VER_ID, catalogId: CAT_ID, version: '1.0.0', s3Key: null });
      const res = await patchReq({});
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('No fields to update');
    });
  });

  // The eq(orgId) WHERE filter that used to make cross-tenant writes
  // structurally impossible is gone from these routes; authorizeCatalogItemWrite
  // is the only app-layer guard left. These tests pin its deny outcomes on each
  // route so dropping the call from any one of them fails loudly.
  describe('catalog dual-axis write authorization (deny paths)', () => {
    const CAT_ID = '55555555-5555-4555-8555-555555555555';
    const VER_ID = '66666666-6666-4666-8666-666666666666';
    const partnerRow = { id: CAT_ID, orgId: null, partnerId: 'partner-123', integrationProvider: null, name: 'Shared Pkg' };
    const builtinRow = { ...partnerRow, integrationProvider: 'huntress', name: 'Huntress Agent' };
    const foreignOrgRow = { id: CAT_ID, orgId: 'other-org', partnerId: null, integrationProvider: null, name: 'Foreign Pkg' };

    const setAuth = (overrides: Record<string, unknown>) => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-123',
          accessibleOrgIds: ['org-a'],
          canAccessOrg: (orgId: string) => orgId === 'org-a',
          ...overrides,
        });
        return next();
      });
    };
    const selectOnce = (rows: unknown[]) =>
      vi.mocked(db.select).mockReturnValueOnce({ from: () => ({ where: async () => rows }) } as any);

    it('403s a limited partner admin editing a partner-wide package', async () => {
      setAuth({ partnerOrgAccess: 'selected' });
      selectOnce([partnerRow]);
      const res = await app.request(`/software/catalog/${CAT_ID}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/full partner org access/);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('403s editing/deleting a built-in integration package even for a full partner admin', async () => {
      setAuth({ partnerOrgAccess: 'all' });
      selectOnce([builtinRow]);
      const patch = await app.request(`/software/catalog/${CAT_ID}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(patch.status).toBe(403);
      expect((await patch.json()).error).toMatch(/Built-in integration packages/);

      setAuth({ partnerOrgAccess: 'all' });
      selectOnce([builtinRow]);
      const del = await app.request(`/software/catalog/${CAT_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });
      expect(del.status).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('403s a limited partner admin on version create/PATCH/promote against a partner-wide package', async () => {
      setAuth({ partnerOrgAccess: 'selected' });
      selectOnce([partnerRow]);
      const create = await app.request(`/software/catalog/${CAT_ID}/versions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '2.0.0' }),
      });
      expect(create.status).toBe(403);

      setAuth({ partnerOrgAccess: 'selected' });
      selectOnce([partnerRow]);
      const patch = await app.request(`/software/catalog/${CAT_ID}/versions/${VER_ID}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '2.0.0' }),
      });
      expect(patch.status).toBe(403);

      setAuth({ partnerOrgAccess: 'selected' });
      selectOnce([partnerRow]);
      const promote = await app.request(`/software/catalog/${CAT_ID}/versions/${VER_ID}/promote`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });
      expect(promote.status).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('404s a version PATCH against an org row outside the caller orgs', async () => {
      // Default org-scope auth (org-123) fetches a visible row owned by another
      // org — must 404, not edit.
      selectOnce([foreignOrgRow]);
      const res = await app.request(`/software/catalog/${CAT_ID}/versions/${VER_ID}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '2.0.0' }),
      });
      expect(res.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('allows a full partner admin to PATCH a built-in package VERSION (S1 installer flow)', async () => {
      // Version-level writes on built-ins are intentionally allowed: the
      // documented SentinelOne flow has partner admins uploading the installer
      // via the Versions tab, and the 2026-07-02 RLS migration grants exactly
      // this. Only the catalog row itself is immutable.
      setAuth({ partnerOrgAccess: 'all' });
      selectOnce([builtinRow]);
      selectOnce([{ id: VER_ID, catalogId: CAT_ID, version: '23.1.0', s3Key: 's3/some-key' }]);
      vi.mocked(db.update).mockReturnValueOnce({
        set: () => ({ where: () => ({ returning: async () => [{ id: VER_ID, version: '23.2.0' }] }) }),
      } as any);
      const res = await app.request(`/software/catalog/${CAT_ID}/versions/${VER_ID}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '23.2.0' }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).data.version).toBe('23.2.0');
    });

    it('allows system scope to PATCH a built-in catalog row', async () => {
      setAuth({ scope: 'system', partnerId: null, partnerOrgAccess: undefined, canAccessOrg: () => true });
      selectOnce([builtinRow]);
      vi.mocked(db.update).mockReturnValueOnce({
        set: () => ({ where: () => ({ returning: async () => [{ ...builtinRow, name: 'Renamed' }] }) }),
      } as any);
      const res = await app.request(`/software/catalog/${CAT_ID}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(res.status).toBe(200);
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

    it('lets system scope pass an explicit orgId and scopes inventory to it', async () => {
      // Regression for the resolveScopedOrgId change: system scope used to 403 when
      // passing an explicit orgId; it must now succeed and scope to that org.
      const requestedOrgId = '33333333-3333-4333-8333-333333333333';
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'system',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: null
        });
        return next();
      });

      const res = await app.request(`/software/inventory?orgId=${requestedOrgId}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      // Must NOT 403 — and the device lookup must be scoped to the requested org
      // (`eq(devices.orgId, requestedOrgId)`; devices.orgId mocks to 'org_id').
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
      expect(eq).toHaveBeenCalledWith('org_id', requestedOrgId);
    });

    it('denies an org-scoped token requesting a different orgId', async () => {
      // Negative analog: the default mock auth is org scope on org-123. Passing an
      // arbitrary other orgId must 403 before any DB query runs.
      const res = await app.request('/software/inventory?orgId=44444444-4444-4444-8444-444444444444', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Access to this organization denied' });
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('POST /software/catalog/:id/versions/upload', () => {
    const catalogId = '11111111-1111-1111-1111-111111111111';

    // Thenable that resolves to `rows` regardless of Drizzle chain shape.
    const selectResult = (rows: any): any => {
      const p: any = new Proxy(() => p, {
        get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve(rows) : () => p),
      });
      return p;
    };

    it('streams the file to disk and hashes it incrementally (issue #1408)', async () => {
      const content = 'hello-breeze-package-payload';
      const expectedChecksum = createHash('sha256').update(content).digest('hex');

      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      // catalog lookup
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );
      // insertLatestSoftwareVersion wraps everything in a transaction
      vi.mocked(db.transaction).mockResolvedValueOnce({
        id: 'ver-1', catalogId, version: '1.0.0', isLatest: true,
      } as any);

      const fd = new FormData();
      fd.append('version', '1.0.0');
      fd.append('file', new File([content], 'pkg.msi', { type: 'application/octet-stream' }));

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(201);
      // The streamed path must produce the correct checksum and hand the temp
      // file (not an in-memory buffer) to S3.
      expect(uploadBinary).toHaveBeenCalledTimes(1);
      const call = vi.mocked(uploadBinary).mock.calls[0]!;
      expect(call[2]).toBe(expectedChecksum); // checksum from the streamed hash
      expect(typeof call[0]).toBe('string');  // temp file path, not an in-memory buffer
    });

    // #2794: object-storage faults used to reach the global error handler as an
    // opaque `500 {error:'Internal Server Error'}`, so a self-hoster had no path
    // from "Failed to upload version" to a cause.
    describe('object storage failure mapping', () => {
      const uploadOnce = async () => {
        vi.mocked(isS3Configured).mockReturnValueOnce(true);
        vi.mocked(db.select).mockReturnValueOnce(
          selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
        );
        const fd = new FormData();
        fd.append('version', '1.0.0');
        fd.append('file', new File(['payload'], 'pkg.msi', { type: 'application/octet-stream' }));
        return app.request(`/software/catalog/${catalogId}/versions/upload`, {
          method: 'POST',
          headers: { Authorization: 'Bearer token' },
          body: fd,
        });
      };

      it('maps an S3OperationError to 502 with the actionable hint and failure code', async () => {
        vi.mocked(uploadBinary).mockRejectedValueOnce(
          new S3OperationError(
            'uploadBinary',
            {
              code: 'bucket_missing',
              message: 'The configured bucket does not exist. Check S3_BUCKET.',
            },
            new Error('NoSuchBucket')
          )
        );

        const res = await uploadOnce();
        const body = await res.json();

        expect(res.status).toBe(502);
        expect(body.error).toMatch(/S3_BUCKET/);
        expect(body.storageFailure).toBe('bucket_missing');
      });

      it('maps an S3ConfigError to 503, matching the isS3Configured() gate', async () => {
        vi.mocked(uploadBinary).mockRejectedValueOnce(
          new S3ConfigError('Invalid S3_ENDPOINT env var: Invalid URL')
        );

        const res = await uploadOnce();
        const body = await res.json();

        expect(res.status).toBe(503);
        expect(body.error).toMatch(/S3_ENDPOINT/);
      });

      // `message` quotes the offending S3_ENDPOINT value (redacted at the
      // source, but still server config). The 503 body must use
      // `clientMessage`, which drops the value entirely — belt and braces, so
      // a future S3ConfigError thrower can't leak through this route (#2794).
      it('does not echo inline endpoint credentials in the 503 body', async () => {
        vi.mocked(uploadBinary).mockRejectedValueOnce(
          new S3ConfigError(
            'Invalid S3_ENDPOINT env var: S3 endpoint "s3://AKIAIOSFODNN7EXAMPLE:sUp3r-s3cr3t@host" is not a valid URL.',
            'The S3_ENDPOINT env var is not a valid URL.'
          )
        );

        const res = await uploadOnce();
        const body = await res.json();

        expect(res.status).toBe(503);
        expect(JSON.stringify(body)).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
        expect(JSON.stringify(body)).not.toMatch(/sUp3r-s3cr3t/);
        expect(body.error).toMatch(/S3_ENDPOINT/);
      });

      it('maps an unrecognized throw to 502 without echoing the raw error', async () => {
        vi.mocked(uploadBinary).mockRejectedValueOnce(
          new Error('ENOENT: open /tmp/breeze-uploads/secret-path.upload')
        );

        const res = await uploadOnce();
        const body = await res.json();

        expect(res.status).toBe(502);
        expect(body.error).not.toMatch(/ENOENT|secret-path/);
        expect(body.error).toMatch(/object storage/i);
      });
    });

    it('rejects a disallowed file extension during streaming (400)', async () => {
      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );

      const fd = new FormData();
      fd.append('version', '1.0.0');
      fd.append('file', new File(['payload'], 'evil.sh', { type: 'application/octet-stream' }));

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(400);
      expect(uploadBinary).not.toHaveBeenCalled();
    });

    it('returns 400 when no file part is sent', async () => {
      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );

      const fd = new FormData();
      fd.append('version', '1.0.0');

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(400);
      expect(uploadBinary).not.toHaveBeenCalled();
    });

    it('rejects malformed detectionRules JSON with a 400 (no silent drop)', async () => {
      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );

      const fd = new FormData();
      fd.append('version', '1.0.0');
      fd.append('detectionRules', '{not json');
      fd.append('file', new File(['payload'], 'pkg.exe', { type: 'application/octet-stream' }));

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(400);
      expect(uploadBinary).not.toHaveBeenCalled();
    });

    it('rejects schema-invalid detectionRules with a 400', async () => {
      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );

      const fd = new FormData();
      fd.append('version', '1.0.0');
      // Valid JSON but a bad clause (non-GUID product code).
      fd.append('detectionRules', JSON.stringify([{ type: 'msi_product_code', productCode: 'nope' }]));
      fd.append('file', new File(['payload'], 'pkg.exe', { type: 'application/octet-stream' }));

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(400);
      expect(uploadBinary).not.toHaveBeenCalled();
    });

    it('accepts a valid detectionRules array on upload (201)', async () => {
      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );
      vi.mocked(db.transaction).mockResolvedValueOnce({
        id: 'ver-det', catalogId, version: '1.0.0', isLatest: true,
      } as any);

      const fd = new FormData();
      fd.append('version', '1.0.0');
      fd.append(
        'detectionRules',
        JSON.stringify([
          { type: 'registry', path: 'SOFTWARE\\Acme\\App' },
          { type: 'file_exists', path: 'C:\\Program Files\\Acme\\app.exe' },
        ]),
      );
      fd.append('file', new File(['payload'], 'pkg.exe', { type: 'application/octet-stream' }));

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(201);
      expect(uploadBinary).toHaveBeenCalledTimes(1);
    });

    it('maps a non-MultipartError parse failure to a 500 (not a blank crash)', async () => {
      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );
      // Simulate an infrastructure failure (e.g. disk full) inside the parser.
      vi.mocked(parseStreamingMultipart).mockRejectedValueOnce(new Error('ENOSPC: no space left'));

      const fd = new FormData();
      fd.append('version', '1.0.0');
      fd.append('file', new File(['payload'], 'pkg.msi'));

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(500);
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(uploadBinary).not.toHaveBeenCalled();
    });
  });

  // A URL-created version never recorded a fileType, so softwareDeployment.ts
  // fell back to `fileType: 'exe'` / `fileName: 'package.exe'`. The agent's EXE
  // branch execs the downloaded file DIRECTLY, so an MSI died at CreateProcess
  // with ERROR_BAD_EXE_FORMAT and the operator's msiexec command was discarded
  // unused. These assert the recorded fileType, not just that the insert ran.
  describe('POST /software/catalog/:id/versions (URL source) installer type', () => {
    const catalogId = '11111111-1111-1111-1111-111111111111';

    const selectResult = (rows: any): any => {
      const p: any = new Proxy(() => p, {
        get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve(rows) : () => p),
      });
      return p;
    };

    /** Runs insertLatestSoftwareVersion's real transaction body against a tx
     *  that captures the inserted row, so the assertions below read the values
     *  actually written rather than merely confirming a call happened. */
    const captureInsert = () => {
      const captured: { values?: Record<string, any> } = {};
      vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) =>
        fn({
          insert: () => ({
            values: (v: Record<string, any>) => {
              captured.values = v;
              return { returning: async () => [{ id: 'ver-1', ...v }] };
            },
          }),
          update: () => ({
            set: () => ({
              where: () => {
                const res: any = {
                  then: (resolve: any) => resolve(undefined),
                  returning: async () => [{ id: 'ver-1', ...captured.values }],
                };
                return res;
              },
            }),
          }),
        }),
      );
      return captured;
    };

    const createVersion = async (body: Record<string, unknown>) => {
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }]),
      );
      const captured = captureInsert();
      const res = await app.request(`/software/catalog/${catalogId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ version: '1.0.0', ...body }),
      });
      return { res, captured };
    };

    it('records fileType msi from the URL extension and prefills msiexec args', async () => {
      const { res, captured } = await createVersion({
        downloadUrl: 'https://cdn.example.com/acme-agent-1.0.0.msi',
      });

      expect(res.status).toBe(201);
      expect(captured.values?.fileType).toBe('msi');
      expect(captured.values?.silentInstallArgs).toBe('msiexec /i "{file}" /qn /norestart');
      expect(captured.values?.silentUninstallArgs).toBe('msiexec /x "{file}" /qn /norestart');
    });

    it('derives the type through a presigned query string', async () => {
      const { captured } = await createVersion({
        downloadUrl: 'https://cdn.example.com/acme.msi?X-Amz-Signature=deadbeef',
      });
      expect(captured.values?.fileType).toBe('msi');
    });

    it('honours an explicit fileType over the URL extension', async () => {
      // A vendor URL whose path lies about the payload — the operator's choice wins.
      const { captured } = await createVersion({
        downloadUrl: 'https://cdn.example.com/download.exe',
        fileType: 'msi',
      });
      expect(captured.values?.fileType).toBe('msi');
    });

    it('never overwrites an operator-supplied install command', async () => {
      const { captured } = await createVersion({
        downloadUrl: 'https://cdn.example.com/acme.msi',
        silentInstallArgs: 'msiexec /i "{file}" /qn REBOOT=ReallySuppress',
      });
      expect(captured.values?.fileType).toBe('msi');
      expect(captured.values?.silentInstallArgs).toBe(
        'msiexec /i "{file}" /qn REBOOT=ReallySuppress',
      );
    });

    it('leaves fileType null when the URL has no recognizable extension', async () => {
      // Guessing here would just invert the bug; null preserves prior behavior.
      const { captured } = await createVersion({
        downloadUrl: 'https://vendor.example.com/download.php?product=acme',
      });
      expect(captured.values?.fileType).toBeNull();
      expect(captured.values?.silentInstallArgs).toBeNull();
    });

    it('does not prefill msiexec args for a non-MSI installer', async () => {
      const { captured } = await createVersion({
        downloadUrl: 'https://cdn.example.com/acme-setup.exe',
      });
      expect(captured.values?.fileType).toBe('exe');
      expect(captured.values?.silentInstallArgs).toBeNull();
    });

    it('treats an explicitly-empty install command as absent, not as a value', async () => {
      // `||` rather than `??`: a cleared form field posts '', and storing that
      // literal empty string would suppress the MSI default for no reason.
      const { captured } = await createVersion({
        downloadUrl: 'https://cdn.example.com/acme.msi',
        silentInstallArgs: '',
      });
      expect(captured.values?.silentInstallArgs).toBe('msiexec /i "{file}" /qn /norestart');
    });

    it('records the resolved type on the audit event', async () => {
      // The only durable server-side trace of what was decided at write time.
      await createVersion({ downloadUrl: 'https://cdn.example.com/acme.msi' });
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'software.catalog.version.create',
          details: expect.objectContaining({ fileType: 'msi' }),
        }),
      );
    });

    it('flags an undetermined installer type for non-web clients', async () => {
      // The web forms warn in the UI, but an API/MCP/script client gets no
      // prompt — without this nobody can count how often it happens.
      await createVersion({
        downloadUrl: 'https://vendor.example.com/download.php?product=acme',
      });
      expect(captureMessage).toHaveBeenCalledWith(
        'software version created with undetermined installer type',
        expect.objectContaining({
          eventCode: 'software_version_installer_type_unknown',
        }),
      );
    });

    it('does not log the presigned query string of a download URL', async () => {
      // Managed-software URLs carry capability query strings that must never
      // reach a log — host only.
      await createVersion({
        downloadUrl: 'https://vendor.example.com/get?token=SECRET-CAPABILITY',
      });
      // captureMessage no longer accepts an `extra` bag at all (BREEZE-18: it
      // was never attached to the event and scrubEvent deleted it anyway), so
      // assert the whole options object carries no capability string.
      const logged = vi.mocked(captureMessage).mock.calls.at(-1)?.[1];
      expect(JSON.stringify(logged)).not.toContain('SECRET-CAPABILITY');
    });

    it('rejects an unsupported explicit fileType with 400', async () => {
      const res = await app.request(`/software/catalog/${catalogId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          version: '1.0.0',
          downloadUrl: 'https://cdn.example.com/acme.zip',
          fileType: 'zip',
        }),
      });
      expect(res.status).toBe(400);
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

    it('rejects non-immediate scheduleType with 400 (never runs on this endpoint)', async () => {
      // The legacy route has no scheduledAt/maintenanceWindowId fields, so a
      // 'scheduled' or 'maintenance_window' deployment created here would sit
      // pending forever (#1.4 reject-what-never-runs).
      for (const scheduleType of ['scheduled', 'maintenance_window']) {
        const res = await app.request('/software/deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({
            softwareId: '11111111-1111-4111-8111-111111111111',
            version: '1.0.0',
            targets: { deviceIds: ['22222222-2222-4222-8222-222222222222'] },
            configuration: { scheduleType },
          })
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/not supported/i);
      }
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Managed software destination policy (Wave 6 Task 5, security remediation)
  //
  // Historically POST /software/deploy re-implemented dispatch inline as a
  // SECOND copy of this gate, independent of the canonical
  // services/softwareDeployment.ts path — exactly the kind of drift that let
  // a gate applied to only one path become the whole vulnerability. This
  // merge (retry-race command-id fix branch × Wave 6) resolves that: the
  // route below now fully delegates to createSoftwareDeployment (see 'POST
  // /software/deploy delegation'), so there is only ONE dispatch
  // implementation and the policy gate is exercised once, for real, in
  // services/softwareDeployment.test.ts's 'managed software destination
  // policy gate (Wave 6 Task 5)' suite — which covers compat/enforce mode,
  // capability gating, the downloadPolicy payload, and per-site allowlists
  // through the same createSoftwareDeployment entrypoint this route calls.
  // -------------------------------------------------------------------------

  describe('POST /software/deployments', () => {
    // Shared fixture UUIDs
    const VERSION_ID = '11111111-1111-4111-8111-111111111111';
    const DEVICE_ID  = '22222222-2222-4222-8222-222222222222';
    const MW_ID      = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const versionRow = {
      id: VERSION_ID,
      catalogId: 'cat-1',
      version: '1.0.0',
      s3Key: null,
      downloadUrl: 'https://example.com/pkg.exe',
    };
    const catalogRow = {
      id: 'cat-1',
      orgId: 'org-123',
      name: 'TestApp',
      integrationProvider: null,
    };

    // Helper that resolves like the Drizzle chain regardless of chain depth.
    const selectResult = (rows: any): any => {
      const p: any = new Proxy(() => p, {
        get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve(rows) : () => p),
      });
      return p;
    };

    it('returns 201 with the full deployment object on a successful immediate install', async () => {
      // The route does two db.select() calls before handing off to the service.
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([versionRow]))   // version lookup
        .mockReturnValueOnce(selectResult([catalogRow]));  // catalog lookup

      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([DEVICE_ID]);

      const mockDeployment = {
        id: 'dep-1',
        orgId: 'org-123',
        name: 'Test Deploy',
        softwareVersionId: VERSION_ID,
        deploymentType: 'install',
        targetType: 'devices',
        targetIds: [DEVICE_ID],
        scheduleType: 'immediate',
        maintenanceWindowId: null,
        createdBy: 'user-123',
        createdAt: new Date().toISOString(),
        scheduledAt: null,
        options: null,
      };
      createDeploymentMock.mockResolvedValueOnce({
        deploymentId: mockDeployment.id,
        deployment: mockDeployment,
        status: 'pending',
        dispatchedDeviceIds: [DEVICE_ID],
      });

      const res = await app.request('/software/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Test Deploy',
          softwareVersionId: VERSION_ID,
          deploymentType: 'install',
          targetType: 'devices',
          targetIds: [DEVICE_ID],
          scheduleType: 'immediate',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data).toEqual(mockDeployment);
    });

    it('passes maintenanceWindowId through to the service when supplied', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([versionRow]))
        .mockReturnValueOnce(selectResult([catalogRow]));

      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([DEVICE_ID]);

      createDeploymentMock.mockResolvedValueOnce({
        deploymentId: 'dep-2',
        deployment: { id: 'dep-2' },
        status: 'pending',
        dispatchedDeviceIds: [],
      });

      await app.request('/software/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'MW Deploy',
          softwareVersionId: VERSION_ID,
          deploymentType: 'install',
          targetType: 'devices',
          targetIds: [DEVICE_ID],
          scheduleType: 'maintenance',
          maintenanceWindowId: MW_ID,
        }),
      });

      expect(createDeploymentMock).toHaveBeenCalledWith(
        expect.objectContaining({ maintenanceWindowId: MW_ID })
      );
    });

    it('stores non-devices targetType as given (not coerced to "devices")', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([versionRow]))
        .mockReturnValueOnce(selectResult([catalogRow]));

      // targetType:'all' resolves to a list of all org devices
      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([DEVICE_ID]);

      createDeploymentMock.mockResolvedValueOnce({
        deploymentId: 'dep-3',
        deployment: { id: 'dep-3', targetType: 'all', targetIds: null },
        status: 'pending',
        dispatchedDeviceIds: [DEVICE_ID],
      });

      const res = await app.request('/software/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'All-Devices Deploy',
          softwareVersionId: VERSION_ID,
          deploymentType: 'install',
          targetType: 'all',
          scheduleType: 'immediate',
        }),
      });

      expect(res.status).toBe(201);
      // The service must receive the original targetType, not a hardcoded 'devices'.
      expect(createDeploymentMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: 'all' })
      );
    });

    // §1.4 Reject what never runs — create-time validation.
    describe('create validation', () => {
      const baseBody = {
        name: 'Test Deploy',
        softwareVersionId: VERSION_ID,
        deploymentType: 'install',
        targetType: 'devices',
        targetIds: [DEVICE_ID],
        scheduleType: 'immediate',
      };

      const post = (overrides: Record<string, unknown>) =>
        app.request('/software/deployments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ ...baseBody, ...overrides }),
        });

      it.each(['uninstall', 'update'])(
        'rejects deploymentType %s with 400 (not yet supported)',
        async (deploymentType) => {
          const res = await post({ deploymentType });
          expect(res.status).toBe(400);
          const body = await res.json();
          expect(body.error).toMatch(/not yet supported/i);
          expect(createDeploymentMock).not.toHaveBeenCalled();
          expect(db.select).not.toHaveBeenCalled();
        },
      );

      it('rejects maintenance scheduleType without maintenanceWindowId', async () => {
        const res = await post({ scheduleType: 'maintenance' });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/maintenanceWindowId/);
        expect(createDeploymentMock).not.toHaveBeenCalled();
      });

      it('rejects scheduled scheduleType without scheduledAt', async () => {
        const res = await post({ scheduleType: 'scheduled' });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/scheduledAt/);
        expect(createDeploymentMock).not.toHaveBeenCalled();
      });

      it('rejects scheduled scheduleType with a past scheduledAt', async () => {
        const res = await post({
          scheduleType: 'scheduled',
          scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/future/i);
        expect(createDeploymentMock).not.toHaveBeenCalled();
      });

      it('accepts scheduled scheduleType with a future scheduledAt', async () => {
        vi.mocked(db.select)
          .mockReturnValueOnce(selectResult([versionRow]))
          .mockReturnValueOnce(selectResult([catalogRow]));
        vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([DEVICE_ID]);
        createDeploymentMock.mockResolvedValueOnce({
          deploymentId: 'dep-sched',
          deployment: { id: 'dep-sched' },
          status: 'pending',
          dispatchedDeviceIds: [],
        });

        const res = await post({
          scheduleType: 'scheduled',
          scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
        expect(res.status).toBe(201);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Package-manager deployments (Task 4): the request names a catalog item
  // instead of an uploaded version, and the route resolves that item's enabled
  // install methods. A cross-platform item targeted at a mixed device set
  // becomes ONE deployment per platform, each carrying its own
  // install_method_id, so the 1:1 column stays honest and result rows are
  // unambiguous.
  // -------------------------------------------------------------------------
  describe('POST /software/deployments (package-manager install methods)', () => {
    const CATALOG_ID = '44444444-4444-4444-8444-444444444444';
    const VERSION_ID = '11111111-1111-4111-8111-111111111111';
    const WIN_DEVICE = '22222222-2222-4222-8222-222222222222';
    const MAC_DEVICE = '33333333-3333-4333-8333-333333333333';
    const LINUX_DEVICE = '55555555-5555-4555-8555-555555555555';

    const catalogRow = { id: CATALOG_ID, orgId: 'org-123', name: 'Firefox', integrationProvider: null };
    const wingetMethod = { id: 'method-win', catalogId: CATALOG_ID, platform: 'windows', kind: 'winget', packageId: 'Mozilla.Firefox', enabled: true };
    const brewMethod = { id: 'method-mac', catalogId: CATALOG_ID, platform: 'macos', kind: 'homebrew_cask', packageId: 'firefox', enabled: true };

    const selectResult = (rows: any): any => {
      const p: any = new Proxy(() => p, {
        get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve(rows) : () => p),
      });
      return p;
    };

    const baseBody = {
      name: 'Firefox rollout',
      catalogId: CATALOG_ID,
      deploymentType: 'install',
      targetType: 'devices',
      targetIds: [WIN_DEVICE],
      scheduleType: 'immediate',
    };
    const post = (overrides: Record<string, unknown> = {}) =>
      app.request('/software/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ ...baseBody, ...overrides }),
      });

    /** selects, in route order: catalog item -> enabled install methods -> device osTypes */
    const primeSelects = (methods: any[], deviceRows: any[]) => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([catalogRow]))
        .mockReturnValueOnce(selectResult(methods))
        .mockReturnValueOnce(selectResult(deviceRows));
    };

    const deploymentResult = (id: string) => ({
      deploymentId: id,
      deployment: { id },
      status: 'pending' as const,
      dispatchedDeviceIds: [],
    });

    it('rejects a body carrying both softwareVersionId and catalogId', async () => {
      const res = await post({ softwareVersionId: VERSION_ID });
      expect(res.status).toBe(400);
      expect(createDeploymentMock).not.toHaveBeenCalled();
    });

    it('rejects a body carrying neither softwareVersionId nor catalogId', async () => {
      const res = await post({ catalogId: undefined });
      expect(res.status).toBe(400);
      expect(createDeploymentMock).not.toHaveBeenCalled();
    });

    it('rejects requestedVersion without versionMode exact', async () => {
      const res = await post({ requestedVersion: '128.0.1' });
      expect(res.status).toBe(400);
      expect(createDeploymentMock).not.toHaveBeenCalled();
    });

    it('rejects versionMode exact without requestedVersion', async () => {
      const res = await post({ versionMode: 'exact' });
      expect(res.status).toBe(400);
      expect(createDeploymentMock).not.toHaveBeenCalled();
    });

    it('rejects versionMode exact when the item has no winget install method', async () => {
      // Rejected before target resolution: only the catalog + methods selects run.
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([catalogRow]))
        .mockReturnValueOnce(selectResult([brewMethod]));

      const res = await post({
        targetIds: [MAC_DEVICE],
        versionMode: 'exact',
        requestedVersion: '128.0.1',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/winget/i);
      expect(createDeploymentMock).not.toHaveBeenCalled();
    });

    it('404s when the catalog item belongs to another org', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectResult([{ ...catalogRow, orgId: 'other-org' }]));
      const res = await post();
      expect(res.status).toBe(404);
      expect(createDeploymentMock).not.toHaveBeenCalled();
    });

    it('400s when the catalog item has no enabled install methods', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([catalogRow]))
        .mockReturnValueOnce(selectResult([]));
      const res = await post();
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/install method/i);
      expect(createDeploymentMock).not.toHaveBeenCalled();
    });

    it('creates ONE deployment with the matching install method for a single-platform target set', async () => {
      primeSelects([wingetMethod, brewMethod], [{ id: WIN_DEVICE, osType: 'windows' }]);
      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([WIN_DEVICE]);
      createDeploymentMock.mockResolvedValueOnce(deploymentResult('dep-win'));

      const res = await post();
      expect(res.status).toBe(201);
      expect(createDeploymentMock).toHaveBeenCalledTimes(1);
      expect(createDeploymentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          installMethodId: 'method-win',
          deviceIds: [WIN_DEVICE],
          versionMode: 'latest',
          // Single deployment keeps the caller's name verbatim.
          name: 'Firefox rollout',
        }),
      );
      // No version target on a manager deployment.
      expect(createDeploymentMock.mock.calls[0]![0].softwareVersionId).toBeUndefined();
    });

    it('splits a cross-platform target set into one deployment per platform', async () => {
      primeSelects(
        [wingetMethod, brewMethod],
        [
          { id: WIN_DEVICE, osType: 'windows' },
          { id: MAC_DEVICE, osType: 'macos' },
        ],
      );
      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([WIN_DEVICE, MAC_DEVICE]);
      createDeploymentMock
        .mockResolvedValueOnce(deploymentResult('dep-win'))
        .mockResolvedValueOnce(deploymentResult('dep-mac'));

      const res = await post({ targetIds: [WIN_DEVICE, MAC_DEVICE] });
      expect(res.status).toBe(201);
      expect(createDeploymentMock).toHaveBeenCalledTimes(2);
      expect(createDeploymentMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
        installMethodId: 'method-win',
        deviceIds: [WIN_DEVICE],
        name: 'Firefox rollout (Windows)',
      }));
      expect(createDeploymentMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
        installMethodId: 'method-mac',
        deviceIds: [MAC_DEVICE],
        name: 'Firefox rollout (macOS)',
      }));
      const body = await res.json();
      expect(body.deployments.map((d: any) => d.id)).toEqual(['dep-win', 'dep-mac']);
    });

    it('attaches devices with no matching platform to the first deployment so they get a failed result row', async () => {
      primeSelects(
        [wingetMethod],
        [
          { id: WIN_DEVICE, osType: 'windows' },
          { id: LINUX_DEVICE, osType: 'linux' },
        ],
      );
      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([WIN_DEVICE, LINUX_DEVICE]);
      createDeploymentMock.mockResolvedValueOnce(deploymentResult('dep-win'));

      const res = await post({ targetIds: [WIN_DEVICE, LINUX_DEVICE] });
      expect(res.status).toBe(201);
      expect(createDeploymentMock).toHaveBeenCalledTimes(1);
      expect(createDeploymentMock.mock.calls[0]![0].deviceIds).toEqual([WIN_DEVICE, LINUX_DEVICE]);
    });

    it('fails every target when the item cannot serve any target platform (winget-only item, macOS targets)', async () => {
      // No group is servable, but the devices must still get result rows —
      // a 201 covering zero devices would silently ignore the Macs.
      primeSelects([wingetMethod], [{ id: MAC_DEVICE, osType: 'macos' }]);
      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([MAC_DEVICE]);
      createDeploymentMock.mockResolvedValueOnce({
        deploymentId: 'dep-none',
        deployment: { id: 'dep-none' },
        status: 'failed',
        message: 'No install method for this device OS on any target device',
        dispatchedDeviceIds: [],
      });

      const res = await post({ targetIds: [MAC_DEVICE] });
      expect(res.status).toBe(200);
      expect(createDeploymentMock).toHaveBeenCalledTimes(1);
      // The Mac is carried into the deployment so the fan-out pre-fails it.
      expect(createDeploymentMock.mock.calls[0]![0].deviceIds).toEqual([MAC_DEVICE]);
      const body = await res.json();
      expect(body.data.status).toBe('failed');
    });

    it('carries devices on an unservable platform into the deployment that does exist', async () => {
      // winget-only item, mixed target set: the Macs must not be dropped —
      // they ride on the Windows deployment and get failed result rows.
      primeSelects([wingetMethod], [
        { id: WIN_DEVICE, osType: 'windows' },
        { id: MAC_DEVICE, osType: 'macos' },
      ]);
      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([WIN_DEVICE, MAC_DEVICE]);
      createDeploymentMock.mockResolvedValueOnce(deploymentResult('dep-win'));

      const res = await post({ targetIds: [WIN_DEVICE, MAC_DEVICE] });
      expect(res.status).toBe(201);
      expect(createDeploymentMock).toHaveBeenCalledTimes(1);
      expect(createDeploymentMock.mock.calls[0]![0].deviceIds).toEqual([WIN_DEVICE, MAC_DEVICE]);
    });

    it('keeps an exact pin on the winget half of a split and forces the Homebrew half to latest', async () => {
      primeSelects([wingetMethod, brewMethod], [
        { id: WIN_DEVICE, osType: 'windows' },
        { id: MAC_DEVICE, osType: 'macos' },
      ]);
      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([WIN_DEVICE, MAC_DEVICE]);
      createDeploymentMock
        .mockResolvedValueOnce(deploymentResult('dep-win'))
        .mockResolvedValueOnce(deploymentResult('dep-mac'));

      const res = await post({
        targetIds: [WIN_DEVICE, MAC_DEVICE],
        versionMode: 'exact',
        requestedVersion: '128.0.1',
      });
      expect(res.status).toBe(201);
      expect(createDeploymentMock.mock.calls[0]![0]).toMatchObject({
        installMethodId: 'method-win',
        versionMode: 'exact',
        requestedVersion: '128.0.1',
      });
      // Homebrew is latest-only in phase 1 — never ship it a pin.
      expect(createDeploymentMock.mock.calls[1]![0]).toMatchObject({
        installMethodId: 'method-mac',
        versionMode: 'latest',
      });
      expect(createDeploymentMock.mock.calls[1]![0].requestedVersion).toBeUndefined();
    });

    it('prefers homebrew_cask over homebrew_formula when the item carries both', async () => {
      const formulaMethod = { id: 'method-formula', catalogId: CATALOG_ID, platform: 'macos', kind: 'homebrew_formula', packageId: 'firefox', enabled: true };
      // Formula listed FIRST: the pick must not depend on row order.
      primeSelects([formulaMethod, brewMethod], [{ id: MAC_DEVICE, osType: 'macos' }]);
      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([MAC_DEVICE]);
      createDeploymentMock.mockResolvedValueOnce(deploymentResult('dep-mac'));

      const res = await post({ targetIds: [MAC_DEVICE] });
      expect(res.status).toBe(201);
      expect(createDeploymentMock).toHaveBeenCalledWith(
        expect.objectContaining({ installMethodId: 'method-mac' }),
      );
    });

    it('passes an exact version pin through to the service', async () => {
      primeSelects([wingetMethod], [{ id: WIN_DEVICE, osType: 'windows' }]);
      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([WIN_DEVICE]);
      createDeploymentMock.mockResolvedValueOnce(deploymentResult('dep-win'));

      const res = await post({ versionMode: 'exact', requestedVersion: '128.0.1' });
      expect(res.status).toBe(201);
      expect(createDeploymentMock).toHaveBeenCalledWith(
        expect.objectContaining({ versionMode: 'exact', requestedVersion: '128.0.1' }),
      );
    });
  });

  describe('POST /software/deployments/:id/retry', () => {
    const DEP_ID    = '99999999-9999-4999-8999-999999999999';
    const VERSION_ID = '11111111-1111-4111-8111-111111111111';
    const DEVICE_A  = '22222222-2222-4222-8222-222222222222';
    const DEVICE_B  = '33333333-3333-4333-8333-333333333333';

    const deploymentRow = {
      id: DEP_ID,
      orgId: 'org-123',
      name: 'Retry Deploy',
      softwareVersionId: VERSION_ID,
      deploymentType: 'install',
      scheduleType: 'immediate',
      dispatchedAt: new Date('2026-07-27T00:00:00Z'),
      options: null,
    };
    const versionRow = {
      id: VERSION_ID,
      catalogId: 'cat-1',
      version: '1.0.0',
      s3Key: null,
      downloadUrl: 'https://example.com/pkg.exe',
      checksum: 'abc123',
      originalFileName: 'pkg.exe',
      fileType: 'exe',
      silentInstallArgs: '/S',
      detectionRules: null,
    };
    const catalogRow = {
      id: 'cat-1',
      orgId: 'org-123',
      name: 'TestApp',
      integrationProvider: null,
    };

    const selectResult = (rows: any): any => {
      const p: any = new Proxy(() => p, {
        get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve(rows) : () => p),
      });
      return p;
    };

    // Introspectable update chain so tests can assert the .set() payload.
    const updateChain = (rows: any) => {
      const returning = vi.fn().mockResolvedValue(rows);
      const where = vi.fn(() => ({ returning }));
      const set = vi.fn(() => ({ where }));
      return { set, where, returning };
    };

    const retry = (body?: unknown) =>
      app.request(`/software/deployments/${DEP_ID}/retry`, {
        method: 'POST',
        headers: body !== undefined
          ? { 'Content-Type': 'application/json', Authorization: 'Bearer token' }
          : { Authorization: 'Bearer token' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

    beforeEach(() => {
      buildDispatchMock.mockResolvedValue({ status: 'pending', dispatchedDeviceIds: [DEVICE_A] });
    });

    it('flips failed rows to pending with incremented retryCount, cleared fields, and re-dispatches (no body)', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([deploymentRow]))  // deployment lookup
        .mockReturnValueOnce(selectResult([versionRow]))     // version lookup
        .mockReturnValueOnce(selectResult([catalogRow]));    // catalog lookup
      // retryCount:1 — the row's SQL-incremented value the UPDATE's
      // .returning() reports back after this retry bumped it from 0.
      const flip = updateChain([{ deviceId: DEVICE_A, retryCount: 1 }]);
      vi.mocked(db.update).mockReturnValueOnce({ set: flip.set } as any);

      const res = await retry(); // no JSON body at all — defaults to all failed rows

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        retriedDeviceIds: [DEVICE_A],
        skippedDeviceIds: [],
      });

      // Reset semantics: pending, retryCount incremented via SQL, prior-attempt
      // fields nulled including the queued-command link.
      expect(flip.set).toHaveBeenCalledWith(expect.objectContaining({
        status: 'pending',
        retryCount: expect.anything(),
        startedAt: null,
        completedAt: null,
        exitCode: null,
        output: null,
        errorMessage: null,
        deviceCommandId: null,
      }));

      // Re-dispatch goes through the shared fan-out, scoped to the flipped
      // rows so its failure pre-writes can never clobber completed rows, and
      // without re-stamping the deployment's dispatched_at claim. The
      // post-bump retryCount (from .returning()) rides along keyed by
      // deviceId (retry race guard — this fix) so the fan-out bakes the NEW
      // attempt number into the re-dispatched WS command id.
      expect(buildDispatchMock).toHaveBeenCalledTimes(1);
      expect(buildDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
        deploymentId: DEP_ID,
        orgId: 'org-123',
        versionRecord: expect.objectContaining({
          downloadUrl: 'https://example.com/pkg.exe',
          silentInstallArgs: '/S',
          version: '1.0.0',
        }),
        catalogItem: expect.objectContaining({ name: 'TestApp' }),
        deviceIds: [DEVICE_A],
        scopeToDeviceIds: [DEVICE_A],
        createdBy: 'user-123',
        markDispatched: false,
        deviceRetryCounts: { [DEVICE_A]: 1 },
      }));
    });

    it('narrows the retry to the caller\'s site-allowed devices; out-of-scope devices are skipped', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'organization',
          orgId: 'org-123',
          partnerId: null,
        });
        c.set('permissions', { allowedSiteIds: ['site-1'] });
        return next();
      });

      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([deploymentRow]))  // deployment lookup
        .mockReturnValueOnce(selectResult([                  // org devices for site narrowing
          { id: DEVICE_A, siteId: 'site-1' },
          { id: DEVICE_B, siteId: 'site-2' },
        ]))
        .mockReturnValueOnce(selectResult([versionRow]))     // version lookup
        .mockReturnValueOnce(selectResult([catalogRow]));    // catalog lookup
      const flip = updateChain([{ deviceId: DEVICE_A }]);    // only in-scope row flips
      vi.mocked(db.update).mockReturnValueOnce({ set: flip.set } as any);

      const res = await retry({ deviceIds: [DEVICE_A, DEVICE_B] });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        retriedDeviceIds: [DEVICE_A],
        skippedDeviceIds: [DEVICE_B],
      });
    });

    it('short-circuits with nothing retried when the caller has zero in-scope devices', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'organization',
          orgId: 'org-123',
          partnerId: null,
        });
        c.set('permissions', { allowedSiteIds: ['site-9'] });
        return next();
      });

      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([deploymentRow]))
        .mockReturnValueOnce(selectResult([{ id: DEVICE_A, siteId: 'site-1' }]));

      const res = await retry({ deviceIds: [DEVICE_A] });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        retriedDeviceIds: [],
        skippedDeviceIds: [DEVICE_A],
      });
      // No rows flipped, nothing re-dispatched.
      expect(db.update).not.toHaveBeenCalled();
      expect(buildDispatchMock).not.toHaveBeenCalled();
    });

    it('audits the retry as software.deployment.retry', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([deploymentRow]))
        .mockReturnValueOnce(selectResult([versionRow]))
        .mockReturnValueOnce(selectResult([catalogRow]));
      const flip = updateChain([{ deviceId: DEVICE_A }]);
      vi.mocked(db.update).mockReturnValueOnce({ set: flip.set } as any);

      const res = await retry({});
      expect(res.status).toBe(200);

      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        orgId: 'org-123',
        action: 'software.deployment.retry',
        resourceType: 'software_deployment',
        resourceId: DEP_ID,
        resourceName: 'Retry Deploy',
        details: expect.objectContaining({ retriedCount: 1, skippedCount: 0 }),
      }));
    });

    it('scopes the flip to the requested deviceIds subset', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([deploymentRow]))
        .mockReturnValueOnce(selectResult([versionRow]))
        .mockReturnValueOnce(selectResult([catalogRow]));
      const flip = updateChain([{ deviceId: DEVICE_A }]);
      vi.mocked(db.update).mockReturnValueOnce({ set: flip.set } as any);

      const res = await retry({ deviceIds: [DEVICE_A] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        retriedDeviceIds: [DEVICE_A],
        skippedDeviceIds: [],
      });

      // The UPDATE's WHERE must include the deviceIds subset filter
      // (deploymentResults.deviceId mocks to the literal 'device_id').
      expect(inArray).toHaveBeenCalledWith('device_id', [DEVICE_A]);
      // ... and the shared fan-out is scoped to the same subset.
      expect(buildDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
        deviceIds: [DEVICE_A],
        scopeToDeviceIds: [DEVICE_A],
      }));
    });

    it('reports requested devices that did not flip (non-failed / not part of deployment) as skipped', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([deploymentRow]))
        .mockReturnValueOnce(selectResult([versionRow]))
        .mockReturnValueOnce(selectResult([catalogRow]));
      // Only DEVICE_A was actually in failed status.
      const flip = updateChain([{ deviceId: DEVICE_A }]);
      vi.mocked(db.update).mockReturnValueOnce({ set: flip.set } as any);

      const res = await retry({ deviceIds: [DEVICE_A, DEVICE_B] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        retriedDeviceIds: [DEVICE_A],
        skippedDeviceIds: [DEVICE_B],
      });

      // Only the flipped row is re-dispatched — DEVICE_B never reaches the
      // fan-out, not even in the scope list.
      expect(buildDispatchMock).toHaveBeenCalledTimes(1);
      expect(buildDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
        deviceIds: [DEVICE_A],
        scopeToDeviceIds: [DEVICE_A],
        createdBy: 'user-123',
      }));
    });

    it('surfaces the shared fan-out failure message in the response', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([deploymentRow]))
        .mockReturnValueOnce(selectResult([versionRow]))
        .mockReturnValueOnce(selectResult([catalogRow]));
      const flip = updateChain([{ deviceId: DEVICE_A }]);
      vi.mocked(db.update).mockReturnValueOnce({ set: flip.set } as any);
      buildDispatchMock.mockResolvedValueOnce({
        status: 'failed',
        message: 'Organization not mapped to Huntress',
        dispatchedDeviceIds: [],
      });

      const res = await retry({});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        retriedDeviceIds: [DEVICE_A],
        skippedDeviceIds: [],
        message: 'Organization not mapped to Huntress',
      });
    });

    it('returns 409 when the deployment was never dispatched', async () => {
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ ...deploymentRow, dispatchedAt: null }])
      );

      const res = await retry({});
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/not been dispatched/i);
      expect(db.update).not.toHaveBeenCalled();
      expect(buildDispatchMock).not.toHaveBeenCalled();
    });

    it('returns 404 when the deployment belongs to another org', async () => {
      // Org-scoped lookup (eq(softwareDeployments.orgId, 'org-123')) finds nothing.
      vi.mocked(db.select).mockReturnValueOnce(selectResult([]));

      const res = await retry({});
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Deployment not found' });
      expect(eq).toHaveBeenCalledWith('org_id', 'org-123');
      expect(db.update).not.toHaveBeenCalled();
      expect(buildDispatchMock).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID deviceIds entry with 400', async () => {
      const res = await retry({ deviceIds: ['not-a-uuid'] });
      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PR 2 — API polish (list pagination/counts, summary, results enrichment,
  // honest cancel, legacy-route delegation)
  // -------------------------------------------------------------------------

  // Thenable that resolves to `rows` regardless of Drizzle chain shape.
  const selectResult = (rows: any): any => {
    const p: any = new Proxy(() => p, {
      get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve(rows) : () => p),
    });
    return p;
  };

  // Like selectResult, but records every chained method call so tests can
  // assert SQL-side pagination (`.limit(n)`, `.offset(n)`).
  const selectCapture = (rows: any) => {
    const calls: Record<string, any[][]> = {};
    const p: any = new Proxy(() => p, {
      get: (_t, prop) => {
        if (prop === 'then') return (resolve: any) => resolve(rows);
        return (...args: any[]) => {
          (calls[String(prop)] ??= []).push(args);
          return p;
        };
      },
    });
    return { chain: p, calls };
  };

  // Introspectable update chain so tests can assert the .set() payload.
  const updateChain = (rows: any) => {
    const returning = vi.fn().mockResolvedValue(rows);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    return { set, where, returning };
  };

  describe('GET /software/deployments (list)', () => {
    const DEP_ID = '99999999-9999-4999-8999-999999999999';

    it('paginates in SQL and enriches each row with aggregate status and per-status counts', async () => {
      const deploymentRow = { id: DEP_ID, orgId: 'org-123', name: 'List Deploy' };
      const page = selectCapture([deploymentRow]);
      vi.mocked(db.select)
        .mockReturnValueOnce(page.chain)                       // page of deployments
        .mockReturnValueOnce(selectResult([{ count: 42 }]))    // total count
        .mockReturnValueOnce(selectResult([                    // grouped status rows
          { deploymentId: DEP_ID, status: 'pending', count: 2 },
          { deploymentId: DEP_ID, status: 'downloading', count: 1 },
          { deploymentId: DEP_ID, status: 'completed', count: 1 },
          { deploymentId: DEP_ID, status: 'failed', count: 1 },
        ]));

      const res = await app.request('/software/deployments?page=2&limit=10', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // total comes from the SQL count, not the page length
      expect(body.pagination).toEqual({ page: 2, limit: 10, total: 42 });
      expect(body.data).toHaveLength(1);
      expect(body.data[0].status).toBe('in_progress');
      expect(body.data[0].counts).toEqual({
        pending: 2,
        inProgress: 1,
        completed: 1,
        failed: 1,
        cancelled: 0,
        total: 5,
      });
      // Pagination pushed into SQL — no full-org fetch + JS slice.
      expect(page.calls.limit).toEqual([[10]]);
      expect(page.calls.offset).toEqual([[10]]);
      // 3 queries total for the page: items, count, grouped statuses (no N+1).
      expect(db.select).toHaveBeenCalledTimes(3);
    });

    it('returns zeroed counts for a deployment with no result rows', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([{ id: DEP_ID, orgId: 'org-123', name: 'Empty' }]))
        .mockReturnValueOnce(selectResult([{ count: 1 }]))
        .mockReturnValueOnce(selectResult([]));

      const res = await app.request('/software/deployments', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].status).toBe('pending');
      expect(body.data[0].counts).toEqual({
        pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0, total: 0,
      });
    });
  });

  describe('GET /software/deployments/summary', () => {
    it('is served by the summary route, not captured as :id (which would 400 on uuid validation)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectResult([]));

      const res = await app.request('/software/deployments/summary', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      // The :id route would reject 'summary' as a non-UUID param with 400 (or
      // 404 on the deployment lookup). 200 with the summary shape proves the
      // static route won.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: { active: 0, scheduled: 0, completedLast7d: 0, failedLast7d: 0 },
      });
    });

    it('buckets deployments into active / scheduled / completedLast7d / failedLast7d', async () => {
      const now = Date.now();
      const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
      const old = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

      vi.mocked(db.select).mockReturnValueOnce(selectResult([
        // active: dispatched, still has pending rows
        { deploymentId: 'dep-active', dispatchedAt: recent, createdAt: recent, status: 'pending', count: 2, lastCompletedAt: null },
        // scheduled: not dispatched yet
        { deploymentId: 'dep-sched', dispatchedAt: null, createdAt: recent, status: 'pending', count: 1, lastCompletedAt: null },
        // scheduled: no result rows at all (LEFT JOIN null status)
        { deploymentId: 'dep-empty', dispatchedAt: null, createdAt: recent, status: null, count: 0, lastCompletedAt: null },
        // cancelled before dispatch: terminal, must NOT count as scheduled forever
        { deploymentId: 'dep-cancelled', dispatchedAt: null, createdAt: recent, status: 'cancelled', count: 2, lastCompletedAt: recent },
        // completed within the last 7 days
        { deploymentId: 'dep-done', dispatchedAt: old, createdAt: old, status: 'completed', count: 3, lastCompletedAt: recent },
        // failed within the last 7 days
        { deploymentId: 'dep-fail', dispatchedAt: old, createdAt: old, status: 'failed', count: 1, lastCompletedAt: recent },
        // completed outside the 7-day window: excluded
        { deploymentId: 'dep-old', dispatchedAt: old, createdAt: old, status: 'completed', count: 1, lastCompletedAt: old },
      ]));

      const res = await app.request('/software/deployments/summary', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: { active: 1, scheduled: 2, completedLast7d: 1, failedLast7d: 1 },
      });
      // One grouped query — no per-deployment fan-out.
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('denies an org-scoped token requesting a different orgId', async () => {
      const res = await app.request('/software/deployments/summary?orgId=44444444-4444-4444-8444-444444444444', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('GET /software/deployments/:id', () => {
    const DEP_ID = '99999999-9999-4999-8999-999999999999';

    it('carries aggregate status and per-status counts', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([{ id: DEP_ID, orgId: 'org-123', name: 'One Deploy' }]))
        .mockReturnValueOnce(selectResult([
          { deploymentId: DEP_ID, status: 'completed', count: 2 },
          { deploymentId: DEP_ID, status: 'failed', count: 1 },
        ]));

      const res = await app.request(`/software/deployments/${DEP_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('completed_with_errors');
      expect(body.data.counts).toEqual({
        pending: 0, inProgress: 0, completed: 2, failed: 1, cancelled: 0, total: 3,
      });
    });
  });

  describe('GET /software/deployments/:id/results', () => {
    const DEP_ID = '99999999-9999-4999-8999-999999999999';
    const DEVICE_A = '22222222-2222-4222-8222-222222222222';

    const deploymentRow = { id: DEP_ID, orgId: 'org-123', name: 'Results Deploy' };

    it('returns hostname-joined rows with queuedOffline and a total, paginated in SQL', async () => {
      const resultRow = {
        id: 'res-1',
        deploymentId: DEP_ID,
        deviceId: DEVICE_A,
        status: 'pending',
        startedAt: null,
        completedAt: null,
        exitCode: null,
        output: null,
        errorMessage: null,
        retryCount: 0,
        deviceCommandId: 'cmd-1',
        hostname: 'WS-01',
        queuedOffline: true,
      };
      const page = selectCapture([resultRow]);
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([deploymentRow]))   // deployment lookup
        .mockReturnValueOnce(page.chain)                      // joined page query
        .mockReturnValueOnce(selectResult([{ count: 7 }]));   // filtered total

      const res = await app.request(
        `/software/deployments/${DEP_ID}/results?limit=1000&offset=5`,
        { method: 'GET', headers: { Authorization: 'Bearer token' } },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(7);
      expect(body.data).toEqual([resultRow]);
      // hostname join + derived flag are part of the row shape
      expect(body.data[0].hostname).toBe('WS-01');
      expect(body.data[0].queuedOffline).toBe(true);
      // limit capped at 500; offset passed through — all in SQL
      expect(page.calls.limit).toEqual([[500]]);
      expect(page.calls.offset).toEqual([[5]]);
      // one joined page query + one count — never a per-row device fetch
      expect(db.select).toHaveBeenCalledTimes(3);
    });

    it('applies the ?status= filter to the results WHERE clause', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([deploymentRow]))
        .mockReturnValueOnce(selectResult([]))
        .mockReturnValueOnce(selectResult([{ count: 0 }]));

      const res = await app.request(
        `/software/deployments/${DEP_ID}/results?status=failed`,
        { method: 'GET', headers: { Authorization: 'Bearer token' } },
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [], total: 0 });
      // deploymentResults.status mocks to the literal 'status'
      expect(eq).toHaveBeenCalledWith('status', 'failed');
    });

    it('rejects an unknown status filter with 400', async () => {
      const res = await app.request(
        `/software/deployments/${DEP_ID}/results?status=exploded`,
        { method: 'GET', headers: { Authorization: 'Bearer token' } },
      );

      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns 404 for a deployment outside the caller org', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectResult([]));

      const res = await app.request(`/software/deployments/${DEP_ID}/results`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Deployment not found' });
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('short-circuits to empty results for a caller with zero in-scope devices (site scope)', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'organization',
          orgId: 'org-123',
          partnerId: null,
        });
        c.set('permissions', { allowedSiteIds: ['site-9'] });
        return next();
      });

      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([deploymentRow]))                       // deployment lookup
        .mockReturnValueOnce(selectResult([{ id: DEVICE_A, siteId: 'site-1' }])); // org devices, all out of scope

      const res = await app.request(`/software/deployments/${DEP_ID}/results`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [], total: 0 });
      // Never reached the joined page/count queries — per-device rows
      // (hostname, exit code, output) stay invisible to out-of-scope callers.
      expect(db.select).toHaveBeenCalledTimes(2);
    });
  });

  describe('POST /software/deployments/:id/cancel', () => {
    const DEP_ID = '99999999-9999-4999-8999-999999999999';
    const deploymentRow = { id: DEP_ID, orgId: 'org-123', name: 'Cancel Deploy' };

    const cancel = () =>
      app.request(`/software/deployments/${DEP_ID}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      });

    it('purges still-queued commands, leaves delivered ones alone, and reports the count', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([deploymentRow]))   // deployment lookup
        .mockReturnValueOnce(selectResult([                   // post-cancel status map
          { deploymentId: DEP_ID, status: 'cancelled', count: 3 },
        ]));
      // Flip returns three cancelled results: two queued-offline links, one
      // WS-dispatched row without a linked command.
      const flip = updateChain([
        { id: 'result-1', deviceCommandId: 'cmd-1' },
        { id: 'result-2', deviceCommandId: 'cmd-2' },
        { id: 'result-3', deviceCommandId: null },
      ]);
      // The guarded purge only matches cmd-1 — cmd-2 was already claimed
      // ('sent'), so the status='pending' guard skips it.
      const purge = updateChain([{ id: 'cmd-1' }]);
      vi.mocked(db.update)
        .mockReturnValueOnce({ set: flip.set } as any)
        .mockReturnValueOnce({ set: purge.set } as any);

      const res = await cancel();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cancelledQueuedCommands).toBe(1);
      expect(body.data.status).toBe('cancelled');
      expect(body.data.counts).toEqual({
        pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 3, total: 3,
      });

      // Purge targets exactly the linked command ids, guarded on still-pending
      // (deviceCommands mocks to dc_* literals).
      expect(inArray).toHaveBeenCalledWith('dc_id', ['cmd-1', 'cmd-2']);
      expect(eq).toHaveBeenCalledWith('dc_status', 'pending');
      // Same result payload shape as the stale reaper's tier-2 cancel.
      expect(purge.set).toHaveBeenCalledWith(expect.objectContaining({
        status: 'cancelled',
        result: expect.objectContaining({
          status: 'cancelled',
          cancelledBy: 'user-123',
        }),
      }));

      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'software.deployment.cancel',
        details: expect.objectContaining({
          cancelledResultCount: 3,
          cancelledQueuedCommands: 1,
        }),
      }));
      expect(applyAutomationActionTerminalMock).toHaveBeenCalledTimes(3);
      expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
        source: 'cancellation',
        deploymentResultId: 'result-1',
        terminalStatus: 'cancelled',
      }));
    });

    it('skips the command purge entirely when no flipped row was queued', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([deploymentRow]))
        .mockReturnValueOnce(selectResult([
          { deploymentId: DEP_ID, status: 'cancelled', count: 1 },
        ]));
      const flip = updateChain([{ id: 'result-1', deviceCommandId: null }]);
      vi.mocked(db.update).mockReturnValueOnce({ set: flip.set } as any);

      const res = await cancel();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cancelledQueuedCommands).toBe(0);
      // Only the results flip ran — no device_commands UPDATE was issued.
      expect(db.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /software/deploy delegation', () => {
    const SOFTWARE_ID = '11111111-1111-4111-8111-111111111111';
    const VERSION_ID = '55555555-5555-4555-8555-555555555555';
    const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

    const catalogRow = { id: SOFTWARE_ID, orgId: 'org-123', name: 'TestApp', integrationProvider: null };
    const versionRow = { id: VERSION_ID, catalogId: SOFTWARE_ID, version: '1.2.3' };

    const deploy = () =>
      app.request('/software/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          softwareId: SOFTWARE_ID,
          version: '1.2.3',
          targets: { deviceIds: [DEVICE_ID] },
        }),
      });

    it('delegates to createSoftwareDeployment with equivalent args and preserves the legacy response shape', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([catalogRow]))   // catalog lookup
        .mockReturnValueOnce(selectResult([versionRow]));  // version-by-name lookup
      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([DEVICE_ID]);

      const deploymentRow = {
        id: 'dep-legacy',
        orgId: 'org-123',
        name: 'Deploy TestApp v1.2.3',
        scheduleType: 'immediate',
      };
      createDeploymentMock.mockResolvedValueOnce({
        deploymentId: 'dep-legacy',
        deployment: deploymentRow,
        status: 'pending',
        dispatchedDeviceIds: [DEVICE_ID],
      });

      const res = await deploy();

      expect(res.status).toBe(201);
      // Legacy shape: full row under `data` plus a top-level `id`.
      expect(await res.json()).toEqual({ data: deploymentRow, id: 'dep-legacy' });

      expect(createDeploymentMock).toHaveBeenCalledTimes(1);
      expect(createDeploymentMock).toHaveBeenCalledWith({
        orgId: 'org-123',
        softwareVersionId: VERSION_ID,
        deploymentType: 'install',
        deviceIds: [DEVICE_ID],
        scheduleType: 'immediate',
        createdBy: 'user-123',
        name: 'Deploy TestApp v1.2.3',
        targetType: 'devices',
        targetIds: [DEVICE_ID],
      });

      // The route no longer re-implements insert/results/dispatch inline.
      expect(db.insert).not.toHaveBeenCalled();

      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'software.deployment.create',
        resourceId: 'dep-legacy',
        details: expect.objectContaining({ version: '1.2.3', deviceCount: 1, deprecated: true }),
      }));
    });

    it('preserves the legacy 200 failed-status body when the service reports failure', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([catalogRow]))
        .mockReturnValueOnce(selectResult([versionRow]));
      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([DEVICE_ID]);

      createDeploymentMock.mockResolvedValueOnce({
        deploymentId: 'dep-failed',
        deployment: { id: 'dep-failed' },
        status: 'failed',
        message: 'No installer available for this version',
        dispatchedDeviceIds: [],
      });

      const res = await deploy();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: { id: 'dep-failed', status: 'failed', message: 'No installer available for this version' },
      });
      // Failure path never audits (matches the pre-dedupe behavior).
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('still 404s when the catalog item belongs to another org', async () => {
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ ...catalogRow, orgId: 'other-org' }]),
      );

      const res = await deploy();

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Catalog item not found' });
      expect(createDeploymentMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Private software download origin policy (Wave 6 Task 4, security remediation)
  // -------------------------------------------------------------------------
  describe('download-policy routes', () => {
    const VALID_POLICY = { version: 1 as const, approvedPrivateOrigins: ['https://files.corp.internal'] };
    const SITE_ID = '11111111-1111-4111-8111-111111111111';

    describe('GET /software/download-policy', () => {
      it('returns the organization policy', async () => {
        vi.mocked(getOrganizationSoftwareDownloadPolicy).mockResolvedValueOnce(VALID_POLICY);

        const res = await app.request('/software/download-policy', {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: VALID_POLICY });
        expect(getOrganizationSoftwareDownloadPolicy).toHaveBeenCalledWith('org-123');
      });

      it('denies a cross-organization request before touching the service', async () => {
        const res = await app.request('/software/download-policy?orgId=99999999-9999-4999-8999-999999999999', {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(403);
        expect(getOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('403s when devices:write is missing', async () => {
        permissionGate.deny = true;

        const res = await app.request('/software/download-policy', {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(403);
        expect(getOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('403s when MFA has not been satisfied', async () => {
        mfaGate.deny = true;

        const res = await app.request('/software/download-policy', {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(403);
        expect(getOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });
    });

    describe('PUT /software/download-policy', () => {
      it('updates the organization policy and audits without URL query data', async () => {
        vi.mocked(setOrganizationSoftwareDownloadPolicy).mockResolvedValueOnce({
          ok: true,
          policy: VALID_POLICY,
        });

        const res = await app.request('/software/download-policy?orgId=org-123', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: VALID_POLICY });
        expect(setOrganizationSoftwareDownloadPolicy).toHaveBeenCalledWith('org-123', VALID_POLICY);

        expect(writeRouteAudit).toHaveBeenCalledTimes(1);
        const auditArg = vi.mocked(writeRouteAudit).mock.calls[0]?.[1] as unknown as Record<string, unknown>;
        expect(auditArg.action).toBe('software.downloadPolicy.update');
        expect(auditArg.details).toEqual({ version: 1, approvedOriginCount: 1 });
        // No raw URL / query string anywhere in the audit payload — the query
        // param above (`?orgId=org-123`) must never leak into audit metadata.
        const serialized = JSON.stringify(auditArg);
        expect(serialized).not.toContain('?');
        expect(serialized).not.toContain('orgId=org-123');
        expect(auditArg).not.toHaveProperty('url');
        expect(auditArg).not.toHaveProperty('query');
      });

      it('rejects an invalid policy body (bad origin) with 400 before touching the service', async () => {
        const res = await app.request('/software/download-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ version: 1, approvedPrivateOrigins: ['https://127.0.0.1'] }),
        });

        expect(res.status).toBe(400);
        expect(setOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('rejects an unknown top-level key with 400 (.strict())', async () => {
        const res = await app.request('/software/download-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ ...VALID_POLICY, extra: 'nope' }),
        });

        expect(res.status).toBe(400);
        expect(setOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('403s when devices:write is missing', async () => {
        permissionGate.deny = true;

        const res = await app.request('/software/download-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(403);
        expect(setOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('403s when MFA has not been satisfied', async () => {
        mfaGate.deny = true;

        const res = await app.request('/software/download-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(403);
        expect(setOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('404s and audits nothing when the organization is missing / the write affected 0 rows', async () => {
        vi.mocked(setOrganizationSoftwareDownloadPolicy).mockResolvedValueOnce({
          ok: false,
          error: 'organization_not_found',
        });

        const res = await app.request('/software/download-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(404);
        expect(writeRouteAudit).not.toHaveBeenCalled();
      });
    });

    describe('PUT /software/download-policy/sites/:siteId', () => {
      it('updates the site policy and returns the effective org∪site union', async () => {
        const effective = {
          version: 1 as const,
          approvedPrivateOrigins: ['https://files.corp.internal', 'https://site.corp.internal'],
        };
        vi.mocked(setSiteSoftwareDownloadPolicy).mockResolvedValueOnce({
          ok: true,
          policy: VALID_POLICY,
          effective,
        });

        const res = await app.request(`/software/download-policy/sites/${SITE_ID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: effective });
        expect(setSiteSoftwareDownloadPolicy).toHaveBeenCalledWith('org-123', SITE_ID, VALID_POLICY);
      });

      it('404s when the site does not belong to the resolved organization (wrong organization)', async () => {
        vi.mocked(setSiteSoftwareDownloadPolicy).mockResolvedValueOnce({
          ok: false,
          error: 'site_not_found',
        });

        const res = await app.request(`/software/download-policy/sites/${SITE_ID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(404);
      });

      it('403s when the caller is denied access to the site', async () => {
        siteAccessGate.deny = true;

        const res = await app.request(`/software/download-policy/sites/${SITE_ID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(403);
        expect(setSiteSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('403s when devices:write is missing', async () => {
        permissionGate.deny = true;

        const res = await app.request(`/software/download-policy/sites/${SITE_ID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(403);
        expect(setSiteSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('403s when MFA has not been satisfied', async () => {
        mfaGate.deny = true;

        const res = await app.request(`/software/download-policy/sites/${SITE_ID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(403);
        expect(setSiteSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('audits the site update without URL query data', async () => {
        vi.mocked(setSiteSoftwareDownloadPolicy).mockResolvedValueOnce({
          ok: true,
          policy: VALID_POLICY,
          effective: VALID_POLICY,
        });

        await app.request(`/software/download-policy/sites/${SITE_ID}?orgId=org-123`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(writeRouteAudit).toHaveBeenCalledTimes(1);
        const auditArg = vi.mocked(writeRouteAudit).mock.calls[0]?.[1] as unknown as Record<string, unknown>;
        expect(auditArg.action).toBe('software.downloadPolicy.site.update');
        expect(auditArg.details).toEqual({ version: 1, approvedOriginCount: 1 });
        const serialized = JSON.stringify(auditArg);
        expect(serialized).not.toContain('?');
        expect(serialized).not.toContain('orgId=org-123');
        expect(auditArg).not.toHaveProperty('url');
        expect(auditArg).not.toHaveProperty('query');
      });
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
