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
}));

const posture = vi.hoisted(() => ({ trend: vi.fn() }));
const catalog = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
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
  securityDevicesPage,
  securityOverview,
} from './securityReadModel';

const dialect = new PgDialect();

function compiledWheres() {
  return state.wheres.map((where) => dialect.sqlToQuery(where as SQL));
}

describe('securityReadModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.length = 0;
    state.wheres.length = 0;
    state.joins.length = 0;
    state.orderBys.length = 0;
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
});
