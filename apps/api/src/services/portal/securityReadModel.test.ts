import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-09-02T12:00:00.000Z');

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
  joins: [] as unknown[],
  orderBys: [] as unknown[][],
  selects: [] as Record<string, unknown>[],
}));

const posture = vi.hoisted(() => ({ trend: vi.fn() }));
const catalog = vi.hoisted(() => ({ lookup: vi.fn() }));
const edrFlag = vi.hoisted(() => ({ enabled: vi.fn() }));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((columns?: Record<string, unknown>) => {
      state.selects.push(columns ?? {});
      const rows = state.rows.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const method of [
        'from',
        'leftJoin',
        'innerJoin',
        'where',
        'groupBy',
        'orderBy',
        'limit',
        'offset',
      ]) {
        chain[method] = vi.fn((...args: unknown[]) => {
          if (method === 'where') state.wheres.push(args[0]);
          if (method === 'leftJoin') state.joins.push(args[1]);
          if (method === 'orderBy') state.orderBys.push(args);
          return chain;
        });
      }
      chain.then = (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject);
      return chain;
    }),
  },
}));

vi.mock('../securityPosture', () => ({
  getSecurityPostureTrend: posture.trend,
}));

vi.mock('./edrVisibility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./edrVisibility')>()),
  isEdrVisibilityEnabled: edrFlag.enabled,
}));

vi.mock('./vulnerabilityCatalog', () => ({
  vulnerabilitySeverityForFindings: catalog.lookup,
}));

import {
  devicesProtectedTile,
  securityDevicesPage,
  securityOverview,
  securityScoreTile,
} from './securityReadModel';

const dialect = new PgDialect();

function compiledWheres() {
  return state.wheres.map((where) => dialect.sqlToQuery(where as SQL));
}

function compiledSelectColumn(selectIndex: number, column: string) {
  const columns = state.selects[selectIndex];
  return dialect.sqlToQuery(columns?.[column] as SQL);
}

describe('dashboard security tiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.length = 0;
    state.wheres.length = 0;
    state.joins.length = 0;
    state.orderBys.length = 0;
    state.selects.length = 0;
    posture.trend.mockResolvedValue([]);
    catalog.lookup.mockResolvedValue(new Map());
    edrFlag.enabled.mockResolvedValue(false);
  });

  it('returns the latest score, PDF band, 30-day delta, and stale status', async () => {
    state.rows.push([
      { overallScore: 82, capturedAt: new Date('2026-09-02T11:00:00Z') },
    ]);
    posture.trend.mockResolvedValue([
      { timestamp: '2026-08-03', overall: 74 },
      { timestamp: '2026-09-02', overall: 82 },
    ]);

    await expect(securityScoreTile(ORG_ID, NOW)).resolves.toEqual({
      status: 'ok',
      score: 82,
      band: 'strong',
      delta30d: 8,
      capturedAt: '2026-09-02T11:00:00.000Z',
    });

    expect(
      compiledWheres().some(({ sql, params }) =>
        sql.includes('"security_posture_org_snapshots"."org_id" =') &&
        params.includes(ORG_ID)),
    ).toBe(true);
  });

  it('classifies devices by protection evidence regardless of status age', async () => {
    state.rows.push([
      {
        id: 'd-protected',
        realTimeProtection: true,
        provider: 'windows_defender',
        avProducts: [{
          displayName: 'Defender',
          provider: 'windows_defender',
        }],
        securityUpdatedAt: new Date('2026-09-02T10:00:00Z'),
        hasS1Agent: false,
        hasHuntressAgent: false,
      },
      {
        id: 'd-unprotected',
        realTimeProtection: false,
        provider: 'windows_defender',
        avProducts: [],
        securityUpdatedAt: new Date('2026-07-01T00:00:00Z'),
        hasS1Agent: false,
        hasHuntressAgent: false,
      },
    ]);

    await expect(devicesProtectedTile(ORG_ID, NOW)).resolves.toEqual({
      status: 'ok',
      protected: 1,
      unprotected: 1,
      unknown: 0,
      total: 2,
      asOf: NOW.toISOString(),
    });

    const compiled = compiledWheres();
    expect(compiled.some(({ params }) => params.includes(ORG_ID))).toBe(true);
    expect(compiled.some(({ sql }) => sql.includes('"devices"."org_id" ='))).toBe(true);

    // The org predicate lives inside the EXISTS subqueries used as SELECT
    // columns, not just in .where()/.leftJoin() — compile them directly so a
    // regression that drops `s1.org_id = ...` / `ha.org_id = ...` is caught.
    const hasS1Agent = compiledSelectColumn(0, 'hasS1Agent');
    expect(hasS1Agent.sql).toContain('s1.org_id = $');
    expect(hasS1Agent.params).toContain(ORG_ID);

    const hasHuntressAgent = compiledSelectColumn(0, 'hasHuntressAgent');
    expect(hasHuntressAgent.sql).toContain('ha.org_id = $');
    expect(hasHuntressAgent.params).toContain(ORG_ID);
  });

  it('returns no_data instead of a fabricated score or count', async () => {
    state.rows.push([]);
    await expect(securityScoreTile(ORG_ID, NOW)).resolves.toEqual({
      status: 'no_data',
      score: null,
      band: null,
      delta30d: null,
      capturedAt: null,
    });
  });

  it('returns a null 30-day delta when no sufficiently old point exists', async () => {
    state.rows.push([
      { overallScore: 82, capturedAt: new Date('2026-09-02T11:00:00Z') },
    ]);
    posture.trend.mockResolvedValue([
      { timestamp: '2026-09-02T11:00:00.000Z', overall: 82 },
    ]);

    await expect(securityScoreTile(ORG_ID, NOW)).resolves.toMatchObject({
      score: 82,
      delta30d: null,
    });
  });
});

describe('securityReadModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.length = 0;
    state.wheres.length = 0;
    state.joins.length = 0;
    state.orderBys.length = 0;
    state.selects.length = 0;
    posture.trend.mockResolvedValue([]);
    catalog.lookup.mockResolvedValue(new Map());
    edrFlag.enabled.mockResolvedValue(false);
  });

  it('returns the canonical score, threat-event, and vulnerability fields', async () => {
    posture.trend.mockResolvedValue([
      { timestamp: '2026-09-01', overall: 81 },
    ]);
    catalog.lookup.mockResolvedValue(new Map([
      ['v-1', { severity: 'critical', isKev: true }],
    ]));
    state.rows.push(
      [{ detectedAt: new Date('2026-08-31T00:00:00Z'), resolvedAt: null }],
      [{ detectedAt: new Date('2026-08-30T00:00:00Z'), resolvedAt: new Date('2026-09-01T00:00:00Z') }],
      [{ detectedAt: new Date('2026-08-29T00:00:00Z'), resolvedAt: null }],
      [
        { vulnerabilityId: 'v-1', detectedAt: new Date('2026-08-28T00:00:00Z') },
        { vulnerabilityId: 'catalog-gap', detectedAt: new Date('2026-08-27T00:00:00Z') },
      ],
    );

    const result = await securityOverview(ORG_ID, {
      days: 30,
      timezone: 'UTC',
      now: NOW,
    });

    expect(result).toMatchObject({
      dataStatus: 'ok',
      score: 81,
      band: 'strong',
      scoreHistory: [{ capturedAt: '2026-09-01', score: 81 }],
      threatEvents: { label: 'Endpoint threat events' },
      vulnerabilities: {
        openBySeverity: {
          critical: 1,
          high: 0,
          medium: 0,
          low: 0,
          unknown: 1,
        },
        kevCount: 1,
        lastDetectedAt: '2026-08-28T00:00:00.000Z',
      },
    });
    expect(result.threatEvents.weeks).toHaveLength(8);

    expect(state.wheres).toHaveLength(4);
    for (const query of compiledWheres()) {
      expect(query.sql).toContain('"org_id" = $');
      expect(query.params).toContain(ORG_ID);
    }
  });

  it('treats a catalog lookup failure as unknown instead of failing the overview', async () => {
    catalog.lookup.mockRejectedValue(new Error('catalog gap'));
    state.rows.push([], [], [], [{
      vulnerabilityId: 'missing',
      detectedAt: new Date('2026-08-28T00:00:00Z'),
    }]);

    await expect(securityOverview(ORG_ID, {
      days: 30,
      timezone: 'UTC',
      now: NOW,
    })).resolves.toMatchObject({
      vulnerabilities: {
        openBySeverity: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          unknown: 1,
        },
        kevCount: 0,
      },
    });
  });

  it('returns honest empty overview fields when no security data exists', async () => {
    state.rows.push([], [], [], []);

    await expect(securityOverview(ORG_ID, {
      days: 30,
      timezone: 'UTC',
      now: NOW,
    })).resolves.toMatchObject({
      dataStatus: 'no_data',
      score: null,
      band: null,
      scoreHistory: [],
      vulnerabilities: {
        kevCount: 0,
        lastDetectedAt: null,
      },
    });
  });

  it('orders unprotected devices in SQL before pagination', async () => {
    state.rows.push(
      [{ count: 2 }],
      [{
        id: 'd-1',
        hostname: 'risk-device',
        displayName: null,
        provider: 'windows_defender',
        avProducts: [{ displayName: 'Windows Defender' }],
        realTimeProtection: false,
        definitionsDate: new Date('2026-08-20T00:00:00Z'),
        encryptionStatus: 'unencrypted',
        firewallEnabled: false,
        securityUpdatedAt: new Date('2026-09-01T00:00:00Z'),
        hasS1Agent: false,
        hasHuntressAgent: false,
        pendingCriticalPatches: 2,
      }],
    );

    await expect(securityDevicesPage(ORG_ID, {
      page: 1,
      limit: 25,
      timezone: 'UTC',
      now: NOW,
    })).resolves.toMatchObject({
      dataStatus: 'ok',
      asOf: NOW.toISOString(),
      timezone: 'UTC',
      data: [{
        id: 'd-1',
        name: 'risk-device',
        protection: 'unprotected',
        avProducts: ['Windows Defender', 'Defender'],
        realTimeProtection: false,
        encryption: 'unencrypted',
        firewall: false,
        pendingCriticalPatches: 2,
      }],
      pagination: { page: 1, limit: 25, total: 2 },
    });

    const order = state.orderBys.at(-1)!
      .map((value) => dialect.sqlToQuery(value as SQL).sql)
      .join(' ');
    expect(order).toContain('case');
    expect(order).toContain('unprotected');
    expect(state.joins.some((join) => {
      const query = dialect.sqlToQuery(join as SQL);
      return query.sql.includes('"security_status"."org_id" =') &&
        query.params.includes(ORG_ID);
    })).toBe(true);

    expect(state.wheres.slice(-2).every((where) => {
      const query = dialect.sqlToQuery(where as SQL);
      return query.sql.includes('"devices"."org_id" =') &&
        query.params.includes(ORG_ID);
    })).toBe(true);

    // select(1) is the paginated device list query (select(0) is the plain
    // count query); its hasS1Agent/hasHuntressAgent EXISTS subqueries and the
    // pendingCriticalPatches subquery are never touched by .where()/.leftJoin()
    // assertions above, so compile them directly to prove the org predicate
    // survives inside each SELECT-column subquery.
    const hasS1Agent = compiledSelectColumn(1, 'hasS1Agent');
    expect(hasS1Agent.sql).toContain('s1.org_id = $');
    expect(hasS1Agent.params).toContain(ORG_ID);

    const hasHuntressAgent = compiledSelectColumn(1, 'hasHuntressAgent');
    expect(hasHuntressAgent.sql).toContain('ha.org_id = $');
    expect(hasHuntressAgent.params).toContain(ORG_ID);

    const pendingCriticalPatches = compiledSelectColumn(1, 'pendingCriticalPatches');
    expect(pendingCriticalPatches.sql).toContain('dp.org_id = $');
    expect(pendingCriticalPatches.params).toContain(ORG_ID);
  });

  it('returns no_data with pagination metadata for an empty device page', async () => {
    state.rows.push([{ count: 0 }], []);

    await expect(securityDevicesPage(ORG_ID, {
      page: 2,
      limit: 10,
      timezone: 'UTC',
      now: NOW,
    })).resolves.toMatchObject({
      dataStatus: 'no_data',
      data: [],
      pagination: { page: 2, limit: 10, total: 0 },
    });
  });

  it('returns ok when an out-of-range page is empty but the org has devices', async () => {
    state.rows.push([{ count: 25 }], []);

    await expect(securityDevicesPage(ORG_ID, {
      page: 2,
      limit: 25,
      timezone: 'UTC',
      now: NOW,
    })).resolves.toMatchObject({
      dataStatus: 'ok',
      data: [],
      pagination: { page: 2, limit: 25, total: 25 },
    });
  });
});

// EDR provider framework W02 (#8166): strict enableEdrVisibility flag, vendor-neutral leg.
describe('EDR leg of the portal security read model', () => {
  const GENERIC_LABEL = 'Managed endpoint protection';
  const overviewArgs = { days: 30, timezone: 'UTC', now: NOW };

  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.length = 0;
    state.wheres.length = 0;
    state.joins.length = 0;
    state.orderBys.length = 0;
    state.selects.length = 0;
    posture.trend.mockResolvedValue([]);
    catalog.lookup.mockResolvedValue(new Map());
    edrFlag.enabled.mockResolvedValue(false);
  });

  const baseOverviewRows = () => [
    [{ detectedAt: new Date('2026-08-31T00:00:00Z'), resolvedAt: null }],
    [{ detectedAt: new Date('2026-08-30T00:00:00Z'), resolvedAt: new Date('2026-09-01T00:00:00Z') }],
    [{ detectedAt: new Date('2026-08-29T00:00:00Z'), resolvedAt: null }],
    [{ vulnerabilityId: 'v-1', detectedAt: new Date('2026-08-28T00:00:00Z') }],
  ];
  const edrDetectionRows = () => [
    { detectedAt: new Date('2026-08-31T00:00:00Z'), resolvedAt: new Date('2026-09-01T00:00:00Z'), provider: 'bitdefender', title: 'GravityZone threat' },
    { detectedAt: new Date('2026-08-31T01:00:00Z'), resolvedAt: null, provider: 'bitdefender', title: 'GravityZone threat' },
  ];

  it('flag off: overview is byte-identical with and without EDR rows, and runs no EDR query', async () => {
    state.rows.push(...baseOverviewRows());
    const without = await securityOverview(ORG_ID, overviewArgs);
    const selectsWithout = state.selects.length;

    state.rows.length = 0;
    state.selects.length = 0;
    state.rows.push(...baseOverviewRows(), edrDetectionRows());
    const withEdrRows = await securityOverview(ORG_ID, overviewArgs);

    expect(JSON.stringify(withEdrRows)).toBe(JSON.stringify(without));
    expect(state.selects.length).toBe(selectsWithout);
    expect(JSON.stringify(withEdrRows)).not.toContain('"edr"');
  });

  it('flag off: an org with ONLY EDR rows is still no_data', async () => {
    state.rows.push([], [], [], [], edrDetectionRows());
    const result = await securityOverview(ORG_ID, overviewArgs);
    expect(result.dataStatus).toBe('no_data');
  });

  it('flag on: counts edr detections per week, keeps the vendor out of the DTO, org-scopes and excludes tombstones', async () => {
    edrFlag.enabled.mockResolvedValue(true);
    state.rows.push(...baseOverviewRows(), edrDetectionRows());

    const result = await securityOverview(ORG_ID, overviewArgs);

    const detected = result.threatEvents.weeks.reduce((n, w) => n + (w.detectedBySource.edr ?? 0), 0);
    const resolved = result.threatEvents.weeks.reduce((n, w) => n + (w.resolvedBySource.edr ?? 0), 0);
    expect(detected).toBe(2);
    expect(resolved).toBe(1);
    for (const week of result.threatEvents.weeks) {
      expect(week.detectedBySource.edr).toBeTypeOf('number');
      expect(week.resolvedBySource.edr).toBeTypeOf('number');
    }
    // totals include the edr events (detected = sum of sources)
    expect(result.threatEvents.weeks.reduce((n, w) => n + w.detected, 0)).toBe(1 + 1 + 1 + 2);

    const json = JSON.stringify(result);
    expect(json).not.toMatch(/bitdefender/i);
    expect(json).not.toMatch(/gravityzone/i);

    const edrWhere = compiledWheres().find(({ sql }) => sql.includes('"edr_detections"'));
    expect(edrWhere).toBeDefined();
    expect(edrWhere!.sql).toContain('"edr_detections"."org_id" = $');
    expect(edrWhere!.params).toContain(ORG_ID);
    expect(edrWhere!.sql).toMatch(/"edr_detections"\."detached_at" is null/i);
  });

  it('flag on: EDR-only data makes the overview dataStatus ok', async () => {
    edrFlag.enabled.mockResolvedValue(true);
    state.rows.push([], [], [], [], edrDetectionRows());
    const result = await securityOverview(ORG_ID, overviewArgs);
    expect(result.dataStatus).toBe('ok');
  });

  it('tile, flag off: no EDR column is selected and a stray hasEdrEndpoint is ignored', async () => {
    state.rows.push([{
      id: 'd-1', realTimeProtection: null, provider: null,
      hasS1Agent: false, hasHuntressAgent: false, hasEdrEndpoint: true,
    }]);
    const tile = await devicesProtectedTile(ORG_ID, NOW);
    expect(tile).toMatchObject({ protected: 0, unprotected: 0, unknown: 1 });
    expect(Object.keys(state.selects[0]!)).not.toContain('hasEdrEndpoint');
  });

  it('tile, flag on: healthy+online linked endpoint is protected; predicate is org-scoped, healthy AND online', async () => {
    edrFlag.enabled.mockResolvedValue(true);
    state.rows.push([
      { id: 'd-edr', realTimeProtection: null, provider: null, hasS1Agent: false, hasHuntressAgent: false, hasEdrEndpoint: true },
      { id: 'd-bad', realTimeProtection: null, provider: null, hasS1Agent: false, hasHuntressAgent: false, hasEdrEndpoint: false },
    ]);

    const tile = await devicesProtectedTile(ORG_ID, NOW);
    expect(tile).toMatchObject({ protected: 1, unknown: 1, unprotected: 0, total: 2 });

    const col = compiledSelectColumn(0, 'hasEdrEndpoint');
    expect(col.sql).toContain('edr_endpoints');
    expect(col.sql).toContain('e.org_id = $');
    expect(col.params).toContain(ORG_ID);
    expect(col.sql).toContain('e.breeze_device_id = "devices"."id"');
    expect(col.sql).toContain("e.health = 'healthy'");
    expect(col.sql).toContain('e.online is true');
  });

  const pageRow = (overrides: Record<string, unknown>) => ({
    id: 'd-1', hostname: 'host-1', displayName: null, provider: null, avProducts: null,
    realTimeProtection: null, definitionsDate: null, encryptionStatus: null, firewallEnabled: null,
    securityUpdatedAt: null, hasS1Agent: false, hasHuntressAgent: false, pendingCriticalPatches: 0,
    ...overrides,
  });

  it('devices page, flag off: no generic label, no EDR protection, no EDR columns', async () => {
    state.rows.push([{ count: 1 }], [pageRow({ hasEdrEndpoint: true, hasEdrLinked: true })]);
    const page = await securityDevicesPage(ORG_ID, { page: 1, limit: 25, timezone: 'UTC', now: NOW });
    expect(page.data[0]).toMatchObject({ protection: 'unknown', avProducts: [] });
    expect(Object.keys(state.selects[1]!)).not.toContain('hasEdrEndpoint');
    expect(JSON.stringify(page)).not.toContain(GENERIC_LABEL);
  });

  it('devices page, flag on: protected + generic label only, never vendor/provider/product names', async () => {
    edrFlag.enabled.mockResolvedValue(true);
    state.rows.push([{ count: 2 }], [
      pageRow({ id: 'd-1', hasEdrEndpoint: true, hasEdrLinked: true, edrProvider: 'bitdefender', edrProduct: 'GravityZone' }),
      pageRow({ id: 'd-2', hasEdrEndpoint: false, hasEdrLinked: true }),
    ]);
    const page = await securityDevicesPage(ORG_ID, { page: 1, limit: 25, timezone: 'UTC', now: NOW });

    expect(page.data[0]).toMatchObject({ id: 'd-1', protection: 'protected', avProducts: [GENERIC_LABEL] });
    // linked but unhealthy/offline: label shown, never upgraded to protected
    expect(page.data[1]).toMatchObject({ id: 'd-2', protection: 'unknown', avProducts: [GENERIC_LABEL] });
    const json = JSON.stringify(page);
    expect(json).not.toMatch(/bitdefender/i);
    expect(json).not.toMatch(/gravityzone/i);

    const col = compiledSelectColumn(1, 'hasEdrEndpoint');
    expect(col.sql).toContain('e.org_id = $');
    expect(col.params).toContain(ORG_ID);
    expect(col.sql).toContain("e.health = 'healthy'");
    expect(col.sql).toContain('e.online is true');
    const linked = compiledSelectColumn(1, 'hasEdrLinked');
    expect(linked.sql).toContain('e.org_id = $');
    expect(linked.params).toContain(ORG_ID);
  });
});
