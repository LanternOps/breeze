import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { dbState, dbAccessContexts, networkOverviewMock, networkAssetsMock } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
    where: undefined as unknown,
    contextDepth: 0,
  },
  dbAccessContexts: [] as unknown[],
  networkOverviewMock: vi.fn(),
  networkAssetsMock: vi.fn(),
}));

vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};

  for (const method of ['from', 'limit']) {
    chain[method] = vi.fn(() => chain);
  }

  chain.select = vi.fn(() => chain);
  chain.where = vi.fn((predicate: unknown) => {
    dbState.where = predicate;
    return chain;
  });

  (chain as { then: unknown }).then = (
    resolve: (value: unknown) => unknown,
  ) => Promise.resolve(dbState.rows).then(resolve);

  return {
    db: chain,
    withDbAccessContext: async <T>(
      context: unknown,
      fn: () => Promise<T> | T,
    ): Promise<T> => {
      if (dbState.contextDepth !== 0) {
        throw new Error('nested withDbAccessContext detected');
      }

      dbAccessContexts.push(context);
      dbState.contextDepth += 1;

      try {
        return await fn();
      } finally {
        dbState.contextDepth -= 1;
      }
    },
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(
      fn: () => Promise<T>,
    ): Promise<T> => fn(),
  };
});

vi.mock('../../services/portal/networkVisibilityReadModel', () => ({
  networkOverview: networkOverviewMock,
  networkAssets: networkAssetsMock,
}));

import { portalNetworkRoutes } from './network';

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';

const OK_OVERVIEW = {
  dataStatus: 'ok' as const,
  totalAssets: 4,
  onlineAssets: 2,
  offlineAssets: 1,
  snmpDevicesPolling: 2,
  monitorsDown: 1,
};

const NOT_ENABLED = {
  dataStatus: 'not_enabled',
  totalAssets: null,
  onlineAssets: null,
  offlineAssets: null,
  snmpDevicesPolling: null,
  monitorsDown: null,
};

function makeApp(withAuth = true) {
  const app = new Hono();

  if (withAuth) {
    app.use('*', async (c, next) => {
      c.set('portalAuth', {
        user: {
          id: 'pu1',
          orgId: ORG_ID,
          email: 'customer@example.test',
          name: 'Customer',
          contactId: null,
          receiveNotifications: true,
          status: 'active',
        },
        token: 't',
        authMethod: 'bearer',
        partnerId: PARTNER_ID,
        timezone: 'UTC',
      });
      await next();
    });
  }

  app.route('/', portalNetworkRoutes);
  return app;
}

describe('GET /network/overview (#5861)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.rows = [];
    dbState.where = undefined;
    dbState.contextDepth = 0;
    dbAccessContexts.length = 0;
    networkOverviewMock.mockResolvedValue(OK_OVERVIEW);
  });

  it('returns not_enabled with null metrics when the flag is false', async () => {
    dbState.rows = [{
      enableNetworkVisibility: false,
      partnerId: PARTNER_ID,
    }];

    const response = await makeApp().request('/network/overview');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(NOT_ENABLED);
    expect(networkOverviewMock).not.toHaveBeenCalled();
  });

  it('fails closed to not_enabled when portal_branding does not exist', async () => {
    dbState.rows = [];

    const response = await makeApp().request('/network/overview');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(NOT_ENABLED);
    expect(networkOverviewMock).not.toHaveBeenCalled();
  });

  it('returns the org-scoped overview when the flag is true', async () => {
    dbState.rows = [{
      enableNetworkVisibility: true,
      partnerId: PARTNER_ID,
    }];

    const response = await makeApp().request('/network/overview');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OK_OVERVIEW);
    expect(networkOverviewMock).toHaveBeenCalledTimes(1);
    expect(networkOverviewMock).toHaveBeenCalledWith(ORG_ID);

    expect(dbAccessContexts).toEqual([
      {
        scope: 'organization',
        orgId: ORG_ID,
        accessibleOrgIds: [ORG_ID],
        accessiblePartnerIds: [],
        userId: null,
        currentPartnerId: PARTNER_ID,
      },
    ]);

    const query = new PgDialect().sqlToQuery(dbState.where as SQL);
    expect(query.sql).toContain('"portal_branding"."org_id" = $1');
    expect(query.params).toEqual([ORG_ID]);
  });

  it('passes no_data through unchanged when visibility is enabled', async () => {
    dbState.rows = [{
      enableNetworkVisibility: true,
      partnerId: PARTNER_ID,
    }];
    networkOverviewMock.mockResolvedValue({
      dataStatus: 'no_data',
      totalAssets: null,
      onlineAssets: null,
      offlineAssets: null,
      snmpDevicesPolling: null,
      monitorsDown: null,
    });

    const response = await makeApp().request('/network/overview');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dataStatus: 'no_data',
      totalAssets: null,
    });
  });

  it('rejects an unauthenticated request before reading settings', async () => {
    const response = await makeApp(false).request('/network/overview');

    expect(response.status).toBe(401);
    expect(dbState.where).toBeUndefined();
    expect(networkOverviewMock).not.toHaveBeenCalled();
  });
});

describe('GET /network/assets (#5861, PR 2)', () => {
  const OK_ASSETS = {
    dataStatus: 'ok' as const,
    data: [
      {
        id: 'a1',
        hostname: 'core-switch-01',
        ipAddress: '10.0.0.1',
        macAddress: 'AA:BB:CC:00:00:01',
        assetType: 'switch',
        onlineState: 'online' as const,
        lastSeenAt: '2026-09-17T11:59:00.000Z',
        firstSeenAt: '2026-09-01T09:00:00.000Z',
        manufacturer: 'Cisco',
        model: null,
        siteName: 'HQ',
      },
    ],
    pagination: { page: 1, limit: 50, total: 1 },
  };

  const NOT_ENABLED_ASSETS = {
    dataStatus: 'not_enabled',
    data: [],
    pagination: { page: 1, limit: 50, total: 0 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.rows = [];
    dbState.where = undefined;
    dbState.contextDepth = 0;
    dbAccessContexts.length = 0;
    networkAssetsMock.mockResolvedValue(OK_ASSETS);
  });

  it('returns not_enabled with an empty list when the flag is false', async () => {
    dbState.rows = [{ enableNetworkVisibility: false, partnerId: PARTNER_ID }];

    const response = await makeApp().request('/network/assets');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(NOT_ENABLED_ASSETS);
    expect(networkAssetsMock).not.toHaveBeenCalled();
  });

  it('returns the org-scoped asset list when the flag is true', async () => {
    dbState.rows = [{ enableNetworkVisibility: true, partnerId: PARTNER_ID }];

    const response = await makeApp().request('/network/assets');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OK_ASSETS);
    expect(networkAssetsMock).toHaveBeenCalledTimes(1);
    expect(networkAssetsMock).toHaveBeenCalledWith(ORG_ID, {
      siteId: undefined,
      assetType: undefined,
      status: undefined,
      page: undefined,
      limit: undefined,
    });
  });

  it('forwards siteId, assetType, status, page and limit query params', async () => {
    dbState.rows = [{ enableNetworkVisibility: true, partnerId: PARTNER_ID }];

    const response = await makeApp().request(
      '/network/assets?siteId=11111111-1111-1111-1111-111111111111&assetType=switch&status=online&page=2&limit=10',
    );

    expect(response.status).toBe(200);
    expect(networkAssetsMock).toHaveBeenCalledWith(ORG_ID, {
      siteId: '11111111-1111-1111-1111-111111111111',
      assetType: 'switch',
      status: 'online',
      page: 2,
      limit: 10,
    });
  });

  it('rejects an invalid status value with 400', async () => {
    dbState.rows = [{ enableNetworkVisibility: true, partnerId: PARTNER_ID }];

    const response = await makeApp().request('/network/assets?status=bogus');

    expect(response.status).toBe(400);
    expect(networkAssetsMock).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID siteId with 400', async () => {
    dbState.rows = [{ enableNetworkVisibility: true, partnerId: PARTNER_ID }];

    const response = await makeApp().request('/network/assets?siteId=not-a-uuid');

    expect(response.status).toBe(400);
    expect(networkAssetsMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid assetType with 400', async () => {
    dbState.rows = [{ enableNetworkVisibility: true, partnerId: PARTNER_ID }];

    const response = await makeApp().request('/network/assets?assetType=toaster');

    expect(response.status).toBe(400);
    expect(networkAssetsMock).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric page with 400', async () => {
    dbState.rows = [{ enableNetworkVisibility: true, partnerId: PARTNER_ID }];

    const response = await makeApp().request('/network/assets?page=abc');

    expect(response.status).toBe(400);
    expect(networkAssetsMock).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request before reading settings', async () => {
    const response = await makeApp(false).request('/network/assets');

    expect(response.status).toBe(401);
    expect(dbState.where).toBeUndefined();
    expect(networkAssetsMock).not.toHaveBeenCalled();
  });
});
