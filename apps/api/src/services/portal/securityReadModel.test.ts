import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

const posture = vi.hoisted(() => ({
  trend: vi.fn(),
}));

vi.mock('../securityPosture', () => ({
  getSecurityPostureTrend: posture.trend,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'leftJoin', 'innerJoin', 'where', 'groupBy', 'orderBy', 'limit']) {
        chain[method] = vi.fn((arg: unknown) => {
          if (method === 'where') state.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import { devicesProtectedTile, securityScoreTile } from './securityReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-02T12:00:00Z');
const dialect = new PgDialect();

function compiledWheres() {
  return state.wheres.map((where) => dialect.sqlToQuery(where as SQL));
}

describe('dashboard security tiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.length = 0;
    state.wheres.length = 0;
    posture.trend.mockResolvedValue([]);
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
