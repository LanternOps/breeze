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
      threatEvents: { label: 'endpoint threat events' },
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
