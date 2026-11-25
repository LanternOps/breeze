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
  // Each grouped query shifts one fixture; an empty queue answers statusRows.
  groupRows: [] as unknown[][],
  pageRows: [] as unknown[],
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
  chain.groupBy = async (...args: unknown[]) => {
    m.groupBy(...args);
    return m.groupRows.shift() ?? m.statusRows;
  };
  chain.orderBy = (...args: unknown[]) => {
    m.orderBy(...args);
    return chain;
  };
  chain.limit = (n: unknown) => {
    m.limit(n);
    return chain;
  };
  chain.offset = async (n: unknown) => {
    m.offset(n);
    return m.pageRows;
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
    const fleet = await queryFleetDeviceStats({ scope });
    expect(m.where).toHaveBeenCalledTimes(2);
    expect(render(m.where.mock.calls[1]![0])).toEqual(render(m.where.mock.calls[0]![0]));
    expect(fleet).toEqual(plain);
    expect(fleet).not.toHaveProperty('groups');
  });

  it('a filter adds the compiled condition after the tech-facing exclusions and the scope', async () => {
    await queryFleetDeviceStats({ scope: eq(devices.orgId, ORG), filter: { osType: 'linux' } });
    const q = render(m.where.mock.calls[0]![0]);
    expect(q.sql).toContain('"is_ephemeral"');
    expect(q.sql).toContain("!= 'decommissioned'");
    expect(q.params).toContain(ORG);
    expect(q.params).toContain('linux');
    expect(q.params.indexOf(ORG)).toBeLessThan(q.params.indexOf('linux'));
  });

  it('groupBy osType runs a grouped query, keeps 50 rows, sums the rest into otherCount, renders NULL as unknown', async () => {
    // 52 grouped rows in arbitrary order: one NULL key, 51 named keys.
    const grouped = [
      { key: null, count: '7' },
      ...Array.from({ length: 51 }, (_, i) => ({ key: `v${String(i).padStart(2, '0')}`, count: String(100 - i) })),
    ].reverse();
    m.groupRows = [m.statusRows, grouped];
    const out = await queryFleetDeviceStats({ scope: undefined, filter: { status: 'online' }, groupBy: 'osType' });
    expect(m.groupBy).toHaveBeenCalledTimes(2);
    expect(m.groupBy.mock.calls[1]).toHaveLength(1);
    expect(m.groupBy.mock.calls[1]![0]).toBe(devices.osType);
    expect(m.leftJoin).not.toHaveBeenCalled();
    // The grouped query carries the same WHERE as the counts.
    expect(render(m.where.mock.calls[1]![0])).toEqual(render(m.where.mock.calls[0]![0]));
    expect(out.groups!.by).toBe('osType');
    expect(out.groups!.rows).toHaveLength(50);
    expect(out.groups!.rows[0]).toEqual({ key: 'v00', count: 100 });
    expect(out.groups!.rows[49]).toEqual({ key: 'v49', count: 51 });
    // Left over: v50 (50) and the NULL key (7).
    expect(out.groups!.otherCount).toBe(57);
    expect(out.total).toBe(3);
  });

  it('a NULL key that sorts into the top rows renders as unknown and merges with a literal unknown', async () => {
    m.groupRows = [m.statusRows, [{ key: 'workstation', count: '3' }, { key: null, count: '2' }, { key: 'unknown', count: '2' }]];
    const out = await queryFleetDeviceStats({ scope: undefined, groupBy: 'deviceRole' });
    expect(out.groups).toEqual({ by: 'deviceRole', rows: [{ key: 'unknown', count: 4 }, { key: 'workstation', count: 3 }], otherCount: 0 });
  });

  it('ties are ordered by key ascending', async () => {
    m.groupRows = [m.statusRows, [{ key: 'b', count: '2' }, { key: 'a', count: '2' }]];
    const out = await queryFleetDeviceStats({ scope: undefined, groupBy: 'agentVersion' });
    expect(out.groups!.rows.map((r) => r.key)).toEqual(['a', 'b']);
  });

  it.each(FLEET_FILTER_GROUP_BY)('groupBy %s groups on its own device column', async (by) => {
    m.groupRows = [m.statusRows, []];
    await queryFleetDeviceStats({ scope: undefined, groupBy: by });
    const expected = {
      status: devices.status, osType: devices.osType, osVersion: devices.osVersion, siteId: devices.siteId,
      agentVersion: devices.agentVersion, deviceRole: devices.deviceRole, architecture: devices.architecture,
    }[by];
    expect(m.groupBy.mock.calls[1]![0]).toBe(expected);
  });

  it('groupBy siteId left-joins sites and fills label with the site name', async () => {
    m.groupRows = [m.statusRows, [{ key: 'site-1', label: 'Site 1', count: '2' }, { key: 'site-2', label: null, count: '1' }]];
    const out = await queryFleetDeviceStats({ scope: undefined, groupBy: 'siteId' });
    expect(m.leftJoin).toHaveBeenCalledTimes(1);
    expect(m.groupBy.mock.calls[1]![0]).toBe(devices.siteId);
    expect(m.groupBy.mock.calls[1]![1]).toBe(sites.name);
    expect(m.leftJoin.mock.calls[0]![0]).toBe(sites);
    expect(out.groups!.rows).toEqual([
      { key: 'site-1', label: 'Site 1', count: 2 },
      { key: 'site-2', count: 1 },
    ]);
  });
});

describe('pageFleetDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.pageRows = [{ id: 'd1', hostname: 'a' }];
  });

  it('orders by hostname then id and applies limit/offset over the shared conditions', async () => {
    const rows = await pageFleetDevices({ scope: eq(devices.orgId, ORG), filter: { osType: 'linux' }, limit: 10, offset: 20 });
    expect(rows).toEqual([{ id: 'd1', hostname: 'a' }]);
    expect(m.orderBy.mock.calls[0]!.map((c) => render(c).sql)).toEqual(['"devices"."hostname" asc', '"devices"."id" asc']);
    expect(m.limit).toHaveBeenCalledWith(10);
    expect(m.offset).toHaveBeenCalledWith(20);
    const q = render(m.where.mock.calls[0]![0]);
    expect(q.sql).toContain('"is_ephemeral"');
    expect(q.params).toEqual(expect.arrayContaining([ORG, 'linux']));
    expect(Object.keys(m.select.mock.calls[0]![0] as object)).toEqual(['id', 'hostname', 'displayName', 'status', 'osType', 'siteId', 'lastSeenAt']);
  });
});
