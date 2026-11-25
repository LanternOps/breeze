import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

const m = vi.hoisted(() => ({
  statusRows: [
    { status: 'online', count: '2', migrationRequiredCount: '1', logShippingFailingCount: '1' },
    { status: 'offline', count: '1', migrationRequiredCount: '0', logShippingFailingCount: '0' },
  ],
  where: vi.fn(),
  select: vi.fn(),
  leftJoin: vi.fn(),
  groupBy: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
  offset: vi.fn(),
  // Awaited at groupBy: the status count. Awaited at limit: the breakdown.
  groupRows: [] as unknown[],
  pageRows: [] as unknown[],
  // The bounded transaction withFilterStatementTimeout hands out; its own spy
  // proves which executor a statement ran on.
  txSelect: vi.fn(),
  tx: undefined as any,
}));
vi.mock('../db', () => {
  const chain: any = {};
  chain.from = () => chain;
  chain.leftJoin = (...args: unknown[]) => {
    m.leftJoin(...args);
    return chain;
  };
  chain.where = (w: unknown) => {
    m.where(w);
    return chain;
  };
  // Offline rows can never carry a log-shipping-failing count (the predicate
  // requires status = 'online'); the fixture mirrors what Postgres returns.
  chain.groupBy = (...args: unknown[]) => {
    m.groupBy(...args);
    return { orderBy: chain.orderBy, then: (ok: any, fail: any) => Promise.resolve(m.statusRows).then(ok, fail) };
  };
  chain.orderBy = (...args: unknown[]) => {
    m.orderBy(...args);
    return chain;
  };
  chain.limit = (n: unknown) => {
    m.limit(n);
    return { offset: chain.offset, then: (ok: any, fail: any) => Promise.resolve(m.groupRows).then(ok, fail) };
  };
  chain.offset = async (n: unknown) => {
    m.offset(n);
    return m.pageRows;
  };
  m.tx = {
    select: (fields: unknown) => {
      m.txSelect(fields);
      return chain;
    },
  };
  return {
    db: {
      select: (fields: unknown) => {
        m.select(fields);
        return chain;
      },
    },
  };
});

import { fleetConditions, fleetFilterWhere, pageFleetDevices, queryDeviceStats, queryFleetDeviceStats, techFacingDeviceConditions } from './deviceStats';
import { FLEET_FILTER_GROUP_BY } from '@breeze/shared';
import { devices, sites } from '../db/schema';

const render = (w: unknown) => new PgDialect().sqlToQuery(w as any);

describe('queryDeviceStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.groupRows = [];
    m.pageRows = [];
  });

  it('always excludes decommissioned and ephemeral devices, even unscoped', async () => {
    await queryDeviceStats(undefined);
    const { sql } = render(m.where.mock.calls[0]![0]);
    expect(sql).toContain("!= 'decommissioned'");
    expect(sql).toContain('"is_ephemeral"');
  });

  it('adds the caller scope on top of the exclusions', async () => {
    await queryDeviceStats(eq(devices.siteId, 'site-x'));
    expect(render(m.where.mock.calls[0]![0]).params).toContain('site-x');
  });

  it('aggregates counts, offline complement, migration and log-shipping-failing totals', async () => {
    expect(await queryDeviceStats(undefined)).toEqual({
      total: 3,
      online: 2,
      offline: 1,
      byStatus: { online: 2, offline: 1 },
      migrationRequiredCount: 1,
      logShippingFailingCount: 1,
    });
  });

  // #8611: the count uses the SAME predicate as the logShippingFailing filter,
  // so it excludes offline devices and episodes younger than 30 minutes.
  it('counts log-shipping-failing devices with the shared sustained-failure predicate', async () => {
    await queryDeviceStats(undefined);
    const fields = m.select.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields.logShippingFailingCount).toBeDefined();
    const s = render(fields.logShippingFailingCount).sql.replace(/"/g, '');
    expect(s).toMatch(/^count\(\*\) filter \(where /);
    expect(s).toContain("devices.status = 'online'");
    expect(s).toContain("devices.log_shipping_state = 'failing'");
    expect(s).toContain('devices.log_shipping_failure_started_at IS NOT NULL');
    expect(s).toContain("NOW() - (1800000 * interval '1 millisecond')");
  });
});

const ORG = '11111111-1111-4111-8111-111111111111';

describe('fleetConditions / fleetFilterWhere', () => {
  it('fleetConditions drops an undefined scope and an undefined filter', () => {
    const base = techFacingDeviceConditions().length;
    expect(fleetConditions(undefined, undefined)).toHaveLength(base);
    expect(fleetConditions(eq(devices.orgId, ORG), undefined)).toHaveLength(base + 1);
    expect(fleetConditions(undefined, { osType: 'linux' })).toHaveLength(base + 1);
    expect(fleetConditions(eq(devices.orgId, ORG), { osType: 'linux' })).toHaveLength(base + 2);
  });

  it('the compiled filter is one parenthesised term, so no engine condition can escape the scope', () => {
    const where = render(fleetFilterWhere({ osType: 'linux', pendingPatches: true, softwareInstalled: '7-Zip' }));
    expect(where.sql.startsWith('(')).toBe(true);
    expect(where.sql.endsWith(')')).toBe(true);
    // Balanced: the leading paren closes only at the very end.
    let depth = 0;
    for (let i = 0; i < where.sql.length; i++) {
      if (where.sql[i] === '(') depth++;
      if (where.sql[i] === ')') depth--;
      if (depth === 0) expect(i).toBe(where.sql.length - 1);
    }
  });

  it('fleetFilterWhere is undefined for no filter and for an empty filter', () => {
    expect(fleetFilterWhere(undefined)).toBeUndefined();
    expect(fleetFilterWhere({})).toBeUndefined();
    expect(render(fleetFilterWhere({ osType: 'linux' })).params).toContain('linux');
  });

  it('the scope precedes the filter, after the tech-facing exclusions', () => {
    const conds = fleetConditions(eq(devices.orgId, ORG), { osType: 'linux' });
    const base = techFacingDeviceConditions().length;
    expect(conds.slice(0, base).map((c) => render(c))).toEqual(techFacingDeviceConditions().map((c) => render(c)));
    expect(render(conds[base]).params).toEqual([ORG]);
    expect(render(conds[base + 1]).params).toEqual(['linux']);
  });
});

describe('queryFleetDeviceStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.groupRows = [];
    m.pageRows = [];
  });

  it('with no filter sends the same WHERE as queryDeviceStats and returns the same counts', async () => {
    const scope = eq(devices.orgId, ORG);
    const plain = await queryDeviceStats(scope);
    const fleet = await queryFleetDeviceStats(m.tx, { scope });
    expect(m.where).toHaveBeenCalledTimes(2);
    expect(render(m.where.mock.calls[1]![0])).toEqual(render(m.where.mock.calls[0]![0]));
    expect(fleet).toEqual(plain);
    expect(fleet).not.toHaveProperty('groups');
  });

  it('runs the count and the breakdown on the bounded tx, never on the ambient db (#12655)', async () => {
    await queryFleetDeviceStats(m.tx, { scope: undefined, filter: { softwareInstalled: '7-Zip' }, groupBy: 'osType' });
    expect(m.txSelect).toHaveBeenCalledTimes(2);
    expect(m.select).not.toHaveBeenCalled();
  });

  it('the unfiltered queryDeviceStats stays on the ambient db', async () => {
    await queryDeviceStats(undefined);
    expect(m.select).toHaveBeenCalledTimes(1);
    expect(m.txSelect).not.toHaveBeenCalled();
  });

  it('a filter adds the compiled condition after the tech-facing exclusions and the scope', async () => {
    await queryFleetDeviceStats(m.tx, { scope: eq(devices.orgId, ORG), filter: { osType: 'linux' } });
    const q = render(m.where.mock.calls[0]![0]);
    expect(q.sql).toContain('"is_ephemeral"');
    expect(q.sql).toContain("!= 'decommissioned'");
    expect(q.params).toContain(ORG);
    expect(q.params).toContain('linux');
    expect(q.params.indexOf(ORG)).toBeLessThan(q.params.indexOf('linux'));
  });

  // Ranking, merging and tie order are SQL: the integration suite holds them.
  // Here: the statement is bounded, and its rows are read correctly.
  it('groupBy loads at most 50 groups, largest first, and takes the total before the limit', async () => {
    m.groupRows = [{ key: 'windows', count: '9', total: '30' }, { key: 'linux', count: '7', total: '30' }];
    const out = await queryFleetDeviceStats(m.tx, { scope: undefined, filter: { status: 'online' }, groupBy: 'osType' });
    expect(m.limit.mock.calls).toEqual([[50]]);
    expect(m.leftJoin).not.toHaveBeenCalled();
    // The grouped query carries the same WHERE as the counts.
    expect(render(m.where.mock.calls[1]![0])).toEqual(render(m.where.mock.calls[0]![0]));
    const fields = m.txSelect.mock.calls[1]![0] as Record<string, unknown>;
    expect(render(fields.total).sql).toBe('sum(count(*)) over ()');
    const key = render(fields.key).sql;
    expect(m.groupBy.mock.calls[1]!.map((g) => render(g).sql)).toEqual([key]);
    expect(m.orderBy.mock.calls[0]!.map((o) => render(o).sql)).toEqual(['count(*) desc', `${key} collate "C"`]);
    expect(out.groups).toEqual({ by: 'osType', rows: [{ key: 'windows', count: 9 }, { key: 'linux', count: 7 }], otherCount: 14 });
    expect(out.total).toBe(3);
  });

  it('no matching device is an empty breakdown', async () => {
    const out = await queryFleetDeviceStats(m.tx, { scope: undefined, groupBy: 'deviceRole' });
    expect(out.groups).toEqual({ by: 'deviceRole', rows: [], otherCount: 0 });
  });

  it.each(FLEET_FILTER_GROUP_BY)('groupBy %s groups on its own device column, empty and NULL as unknown, with no bind parameter', async (by) => {
    await queryFleetDeviceStats(m.tx, { scope: undefined, groupBy: by });
    const column = {
      status: devices.status, osType: devices.osType, osVersion: devices.osVersion, siteId: devices.siteId,
      agentVersion: devices.agentVersion, deviceRole: devices.deviceRole, architecture: devices.architecture,
    }[by];
    // A parameter would be numbered differently in SELECT and GROUP BY, which Postgres reads as two expressions.
    expect(render(m.groupBy.mock.calls[1]![0])).toMatchObject({
      sql: `coalesce(nullif("devices"."${column.name}"::text, ''), 'unknown')`, params: [],
    });
  });

  it('groupBy siteId left-joins sites and fills label with the site name', async () => {
    m.groupRows = [{ key: 'site-1', label: 'Site 1', count: '2', total: '3' }, { key: 'site-2', label: null, count: '1', total: '3' }];
    const out = await queryFleetDeviceStats(m.tx, { scope: undefined, groupBy: 'siteId' });
    expect(m.leftJoin).toHaveBeenCalledTimes(1);
    expect(m.leftJoin.mock.calls[0]![0]).toBe(sites);
    expect(m.limit.mock.calls).toEqual([[50]]);
    expect(out.groups).toEqual({ by: 'siteId', rows: [{ key: 'site-1', label: 'Site 1', count: 2 }, { key: 'site-2', count: 1 }], otherCount: 0 });
  });
});

describe('pageFleetDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.pageRows = [{ id: 'd1', hostname: 'a' }];
  });

  it('orders by hostname then id and applies limit/offset over the shared conditions', async () => {
    const rows = await pageFleetDevices(m.tx, { scope: eq(devices.orgId, ORG), filter: { osType: 'linux' }, limit: 10, offset: 20 });
    expect(rows).toEqual([{ id: 'd1', hostname: 'a' }]);
    expect(m.orderBy.mock.calls[0]!.map((c) => render(c).sql)).toEqual(['"devices"."hostname" asc', '"devices"."id" asc']);
    expect(m.limit).toHaveBeenCalledWith(10);
    expect(m.offset).toHaveBeenCalledWith(20);
    const q = render(m.where.mock.calls[0]![0]);
    expect(q.sql).toContain('"is_ephemeral"');
    expect(q.params).toEqual(expect.arrayContaining([ORG, 'linux']));
    expect(Object.keys(m.txSelect.mock.calls[0]![0] as object)).toEqual(['id', 'hostname', 'displayName', 'status', 'osType', 'siteId', 'lastSeenAt']);
  });
});
