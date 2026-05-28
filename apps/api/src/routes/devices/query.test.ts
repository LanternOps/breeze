import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    status: 'devices.status',
    hostname: 'devices.hostname',
    osType: 'devices.osType',
    lastSeenAt: 'devices.lastSeenAt',
  },
  deviceHardware: {
    deviceId: 'deviceHardware.deviceId',
    cpuModel: 'deviceHardware.cpuModel',
    cpuCores: 'deviceHardware.cpuCores',
    ramTotalMb: 'deviceHardware.ramTotalMb',
    diskTotalGb: 'deviceHardware.diskTotalGb',
  },
  deviceMetrics: { device_id: 'device_id', timestamp: 'timestamp' },
}));

vi.mock('../../services/filterEngine', () => ({
  // The endpoint imports buildGroupSQL to AND the filter into the WHERE.
  // For unit tests we return a stub SQL fragment; behavior is the same
  // (the conditions array gets one more entry) regardless of what's inside.
  buildGroupSQL: vi.fn(() => ({ __isFakeSQL: true })),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1' },
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
      orgCondition: vi.fn(() => ({ __orgCond: true })),
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { db } from '../../db';
import { buildGroupSQL } from '../../services/filterEngine';
import { queryRoutes } from './query';

function mockCountQuery(total: number) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ count: total }]),
    }),
  };
}

function mockListQuery(rows: Array<Record<string, unknown>>) {
  return {
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      }),
    }),
  };
}

function mockMatchingIdsQuery(rows: Array<{ id: string; hostname: string }>) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  };
}

describe('POST /devices/query', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', queryRoutes);
    vi.mocked(db.execute).mockResolvedValue([] as any);
  });

  it('returns devices + pagination without invoking buildGroupSQL when no filter is provided', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockCountQuery(2) as any)
      .mockReturnValueOnce(mockListQuery([
        { id: 'd1', hostname: 'h1', status: 'online' },
        { id: 'd2', hostname: 'h2', status: 'offline' },
      ]) as any);

    const res = await app.request('/devices/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
    expect(body.matchingIds).toBeUndefined();
    expect(buildGroupSQL).not.toHaveBeenCalled();
  });

  it('invokes buildGroupSQL when filter has at least one valid leaf condition', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockCountQuery(1) as any)
      .mockReturnValueOnce(mockListQuery([
        { id: 'd1', hostname: 'h1', status: 'offline' },
      ]) as any);

    const res = await app.request('/devices/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: {
          operator: 'AND',
          conditions: [{ field: 'status', operator: 'equals', value: 'offline' }],
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(buildGroupSQL).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].status).toBe('offline');
  });

  it('skips buildGroupSQL when filter has only empty-value leaf conditions', async () => {
    // hasValidFilterConditions in query.ts must reject filters whose leaf
    // values are all '' / null / undefined — those represent a partially-
    // built advanced filter that the user hasn't filled in yet. Treating
    // them as active would WHERE-match nothing and look like a 0-row bug.
    vi.mocked(db.select)
      .mockReturnValueOnce(mockCountQuery(5) as any)
      .mockReturnValueOnce(mockListQuery([]) as any);

    const res = await app.request('/devices/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: {
          operator: 'AND',
          conditions: [{ field: 'status', operator: 'equals', value: '' }],
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(buildGroupSQL).not.toHaveBeenCalled();
  });

  it('returns matchingIds as {id, hostname} pairs when includeMatchingIds=true', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(mockCountQuery(3) as any)
      .mockReturnValueOnce(mockListQuery([{ id: 'd1', hostname: 'h1' }]) as any)
      .mockReturnValueOnce(mockMatchingIdsQuery([
        { id: 'd1', hostname: 'h1' },
        { id: 'd2', hostname: 'h2' },
        { id: 'd3', hostname: 'h3' },
      ]) as any);

    const res = await app.request('/devices/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: {
          operator: 'AND',
          conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }],
        },
        includeMatchingIds: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matchingIds).toEqual([
      { id: 'd1', hostname: 'h1' },
      { id: 'd2', hostname: 'h2' },
      { id: 'd3', hostname: 'h3' },
    ]);
  });

  it('returns 400 when buildGroupSQL throws (e.g. unsupported field)', async () => {
    vi.mocked(buildGroupSQL).mockImplementationOnce(() => {
      throw new Error('Unsupported table: metrics');
    });

    const res = await app.request('/devices/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Zod-passable shape: valid field/operator enum values. The throw
        // comes from buildGroupSQL when it encounters an unimplemented
        // column resolution (e.g. metrics.* — the table handler is a
        // pre-existing gap; this test verifies the 400 surfaces cleanly
        // rather than crashing the endpoint).
        filter: {
          operator: 'AND',
          conditions: [{ field: 'status', operator: 'equals', value: 'online' }],
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Unsupported');
  });
});
