import { beforeEach, describe, expect, it, vi } from 'vitest';

const PARTNER_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const SITE_ID = '33333333-3333-3333-3333-333333333333';
const CONN_ID = '44444444-4444-4444-4444-444444444444';

const { authState } = vi.hoisted(() => {
  const authState = {
    partnerId: '11111111-1111-1111-1111-111111111111' as string | null,
    scope: 'partner' as 'partner' | 'organization' | 'system',
  };
  return { authState };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.partnerId,
      orgId: null,
      canAccessOrg: vi.fn(() => true),
      user: { id: '55555555-5555-5555-5555-555555555555', email: 'admin@example.com' },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    BILLING_MANAGE: { resource: 'billing', action: 'manage' },
  },
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  unifiSiteMappings: {
    integrationId: 'unifi_site_mappings.integration_id',
    orgId: 'unifi_site_mappings.org_id',
    siteId: 'unifi_site_mappings.site_id',
    unifiHostId: 'unifi_site_mappings.unifi_host_id',
    unifiSiteId: 'unifi_site_mappings.unifi_site_id',
    unifiHostName: 'unifi_site_mappings.unifi_host_name',
    unifiSiteName: 'unifi_site_mappings.unifi_site_name',
    wanMetricsAt: 'unifi_site_mappings.wan_metrics_at',
    updatedAt: 'unifi_site_mappings.updated_at',
  },
  unifiSyncRuns: {
    integrationId: 'unifi_sync_runs.integration_id',
    startedAt: 'unifi_sync_runs.started_at',
  },
  sites: {
    id: 'sites.id',
    orgId: 'sites.org_id',
  },
}));

vi.mock('../../services/unifi/unifiConnectionService', () => ({
  getConnection: vi.fn(),
  getDecryptedApiKey: vi.fn(),
  upsertConnection: vi.fn(),
  deleteConnection: vi.fn(),
  markStatus: vi.fn(),
}));

vi.mock('../../services/unifi/unifiClient', () => ({
  createUnifiClient: vi.fn(() => ({
    listHosts: vi.fn(async () => []),
    listSites: vi.fn(async () => []),
  })),
}));

vi.mock('../../jobs/unifiWorker', () => ({
  enqueueUnifiSync: vi.fn(async () => undefined),
}));

import { unifiRoutes } from './index';
import * as svc from '../../services/unifi/unifiConnectionService';
import { db } from '../../db';

describe('unifi routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset db mock queues so a previous test's mockReturnValueOnce doesn't leak
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    // Reset service mock implementations so mockResolvedValue from a previous
    // test doesn't persist (clearAllMocks only clears call history, not impls)
    vi.mocked(svc.getConnection).mockReset();
    vi.mocked(svc.getDecryptedApiKey).mockReset();
    vi.mocked(svc.upsertConnection).mockReset();
    vi.mocked(svc.deleteConnection).mockReset();
    authState.scope = 'partner';
    authState.partnerId = PARTNER_ID;
  });

  it('GET / returns {connected:false} when no connection', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue(null);
    const res = await unifiRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ connected: false });
  });

  it('GET / returns {connected:true,...} when connection exists', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue({
      id: CONN_ID,
      partnerId: PARTNER_ID,
      baseUrl: 'https://api.ui.com',
      accountLabel: 'My UniFi',
      isActive: true,
      status: 'connected',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    });
    const res = await unifiRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ connected: true, status: 'connected' });
  });

  it('POST /disconnect calls deleteConnection and returns success', async () => {
    vi.mocked(svc.deleteConnection).mockResolvedValue(true);
    const res = await unifiRoutes.request('/disconnect', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(svc.deleteConnection).toHaveBeenCalledWith(db, PARTNER_ID);
    await expect(res.json()).resolves.toMatchObject({ success: true });
  });

  it('POST /disconnect returns success:false when no connection was active', async () => {
    vi.mocked(svc.deleteConnection).mockResolvedValue(false);
    const res = await unifiRoutes.request('/disconnect', { method: 'POST' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: false });
  });

  it('POST /connect returns 400 when apiKey is missing', async () => {
    const res = await unifiRoutes.request('/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://api.ui.com' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /connect returns 400 when API key validation fails', async () => {
    const { createUnifiClient } = await import('../../services/unifi/unifiClient');
    vi.mocked(createUnifiClient).mockReturnValueOnce({
      listHosts: vi.fn(async () => { throw new Error('Invalid API key'); }),
      listSites: vi.fn(async () => []),
      listDevices: vi.fn(async () => []),
      getIspMetrics: vi.fn(async () => null),
    });
    const res = await unifiRoutes.request('/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'bad-key' }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ success: false });
  });

  it('POST /connect stores connection when API key validates', async () => {
    vi.mocked(svc.upsertConnection).mockResolvedValue({
      id: CONN_ID,
      partnerId: PARTNER_ID,
      baseUrl: 'https://api.ui.com',
      accountLabel: null,
      isActive: true,
      status: 'connected',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    });
    const res = await unifiRoutes.request('/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'valid-key' }),
    });
    expect(res.status).toBe(200);
    expect(svc.upsertConnection).toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({ connected: true, status: 'connected' });
  });

  it('PUT /mappings returns 400 when not connected', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue(null);
    const res = await unifiRoutes.request('/mappings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mappings: [] }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ success: false, message: 'Not connected' });
  });

  it('PUT /mappings derives orgId from Breeze site and upserts', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue({
      id: CONN_ID,
      partnerId: PARTNER_ID,
      baseUrl: 'https://api.ui.com',
      accountLabel: null,
      isActive: true,
      status: 'connected',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    });
    // Mock the site lookup (select({id, orgId}).from(sites).where(...).limit(1))
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ id: SITE_ID, orgId: ORG_ID }]),
        })),
      })),
    } as any);
    // Mock the insert — capture valuesMock to assert orgId was passed through
    const valuesMock = vi.fn(() => ({
      onConflictDoUpdate: vi.fn(async () => undefined),
    }));
    vi.mocked(db.insert).mockReturnValueOnce({
      values: valuesMock,
    } as any);

    const res = await unifiRoutes.request('/mappings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mappings: [{
          unifiHostId: 'host-1',
          unifiSiteId: 'site-1',
          siteId: SITE_ID,
          unifiHostName: 'My Host',
          unifiSiteName: 'My Site',
        }],
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true });
    expect(db.insert).toHaveBeenCalled();
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID }));
  });

  it('POST /sync returns 400 when not connected', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue(null);
    const res = await unifiRoutes.request('/sync', { method: 'POST' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ success: false, message: 'Not connected' });
  });

  it('GET /sync-runs returns empty array when not connected', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue(null);
    const res = await unifiRoutes.request('/sync-runs', { method: 'GET' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ runs: [] });
  });

  it('GET / rejects organization-scope callers', async () => {
    authState.scope = 'organization';
    const res = await unifiRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('partner scope') });
  });

  it('GET / requires partnerId for system-scope callers', async () => {
    authState.scope = 'system';
    authState.partnerId = null;
    const res = await unifiRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('partnerId is required') });
  });

  // POST /test
  it('POST /test returns 400 when not connected', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue(null);
    const res = await unifiRoutes.request('/test', { method: 'POST' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ success: false, message: 'Not connected' });
  });

  it('POST /test returns 502 when live client.listHosts() throws', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue({
      id: CONN_ID,
      partnerId: PARTNER_ID,
      baseUrl: 'https://api.ui.com',
      accountLabel: null,
      isActive: true,
      status: 'connected',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    });
    vi.mocked(svc.getDecryptedApiKey).mockResolvedValue('some-key');
    const { createUnifiClient } = await import('../../services/unifi/unifiClient');
    vi.mocked(createUnifiClient).mockReturnValueOnce({
      listHosts: vi.fn(async () => { throw new Error('connection refused'); }),
      listSites: vi.fn(async () => []),
      listDevices: vi.fn(async () => []),
      getIspMetrics: vi.fn(async () => null),
    });
    const res = await unifiRoutes.request('/test', { method: 'POST' });
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ success: false });
  });

  // GET /hosts
  it('GET /hosts returns 400 when not connected', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue(null);
    const res = await unifiRoutes.request('/hosts', { method: 'GET' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ success: false, message: 'Not connected' });
  });

  it('GET /hosts returns host list with nested sites', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue({
      id: CONN_ID,
      partnerId: PARTNER_ID,
      baseUrl: 'https://api.ui.com',
      accountLabel: null,
      isActive: true,
      status: 'connected',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    });
    vi.mocked(svc.getDecryptedApiKey).mockResolvedValue('some-key');
    const { createUnifiClient } = await import('../../services/unifi/unifiClient');
    vi.mocked(createUnifiClient).mockReturnValueOnce({
      listHosts: vi.fn(async () => [{ id: 'host-1', name: 'My Host' }]),
      listSites: vi.fn(async () => [{ id: 'usite-1', name: 'My Site', hostId: 'host-1' }]),
      listDevices: vi.fn(async () => []),
      getIspMetrics: vi.fn(async () => null),
    });
    const res = await unifiRoutes.request('/hosts', { method: 'GET' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      hosts: [{ id: 'host-1', name: 'My Host', sites: [{ id: 'usite-1', name: 'My Site' }] }],
    });
  });

  // PUT /mappings — cross-org security
  it('PUT /mappings returns 403 when canAccessOrg returns false for site org', async () => {
    const { authMiddleware } = await import('../../middleware/auth');
    vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
      c.set('auth', {
        scope: 'partner' as const,
        partnerId: PARTNER_ID,
        orgId: null,
        canAccessOrg: vi.fn(() => false),
        user: { id: '55555555-5555-5555-5555-555555555555', email: 'admin@example.com' },
      });
      return next();
    });
    vi.mocked(svc.getConnection).mockResolvedValue({
      id: CONN_ID,
      partnerId: PARTNER_ID,
      baseUrl: 'https://api.ui.com',
      accountLabel: null,
      isActive: true,
      status: 'connected',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    });
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ id: SITE_ID, orgId: ORG_ID }]),
        })),
      })),
    } as any);

    const res = await unifiRoutes.request('/mappings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mappings: [{ unifiHostId: 'host-1', unifiSiteId: 'site-1', siteId: SITE_ID }],
      }),
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ success: false });
    expect(db.insert).not.toHaveBeenCalled();
  });

  // GET /mappings
  it('GET /mappings returns empty array when not connected', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue(null);
    const res = await unifiRoutes.request('/mappings', { method: 'GET' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ mappings: [] });
  });

  it('GET /mappings returns saved mappings when connected', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue({
      id: CONN_ID,
      partnerId: PARTNER_ID,
      baseUrl: 'https://api.ui.com',
      accountLabel: null,
      isActive: true,
      status: 'connected',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    });
    const mockMappings = [{
      id: 'map-1', orgId: ORG_ID, siteId: SITE_ID,
      unifiHostId: 'host-1', unifiSiteId: 'usite-1',
      unifiHostName: 'My Host', unifiSiteName: 'My Site',
      wanMetricsAt: null, updatedAt: '2026-06-28T00:00:00.000Z',
    }];
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(async () => mockMappings),
      })),
    } as any);
    const res = await unifiRoutes.request('/mappings', { method: 'GET' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ mappings: mockMappings });
  });

  // GET /sync-runs — happy path
  it('GET /sync-runs returns runs when connected', async () => {
    vi.mocked(svc.getConnection).mockResolvedValue({
      id: CONN_ID,
      partnerId: PARTNER_ID,
      baseUrl: 'https://api.ui.com',
      accountLabel: null,
      isActive: true,
      status: 'connected',
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    });
    const mockRuns = [{ id: 'run-1', integrationId: CONN_ID, startedAt: '2026-06-28T00:00:00.000Z' }];
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => mockRuns),
          })),
        })),
      })),
    } as any);
    const res = await unifiRoutes.request('/sync-runs', { method: 'GET' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ runs: mockRuns });
  });
});
