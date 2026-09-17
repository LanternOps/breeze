import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { dbState, networkOverviewMock } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
    where: undefined as unknown,
  },
  networkOverviewMock: vi.fn(),
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
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(
      fn: () => Promise<T>,
    ): Promise<T> => fn(),
  };
});

vi.mock('../../services/portal/networkVisibilityReadModel', () => ({
  networkOverview: networkOverviewMock,
}));

import { portalNetworkRoutes } from './network';

const ORG_ID = '22222222-2222-2222-2222-222222222222';

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
    networkOverviewMock.mockResolvedValue(OK_OVERVIEW);
  });

  it('returns not_enabled with null metrics when the flag is false', async () => {
    dbState.rows = [{ enableNetworkVisibility: false }];

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
    dbState.rows = [{ enableNetworkVisibility: true }];

    const response = await makeApp().request('/network/overview');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OK_OVERVIEW);
    expect(networkOverviewMock).toHaveBeenCalledTimes(1);
    expect(networkOverviewMock).toHaveBeenCalledWith(ORG_ID);

    const query = new PgDialect().sqlToQuery(dbState.where as SQL);
    expect(query.sql).toContain('"portal_branding"."org_id" = $1');
    expect(query.params).toEqual([ORG_ID]);
  });

  it('passes no_data through unchanged when visibility is enabled', async () => {
    dbState.rows = [{ enableNetworkVisibility: true }];
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
