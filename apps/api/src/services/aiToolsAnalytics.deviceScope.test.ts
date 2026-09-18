/**
 * Exact-device axis (#6086 finding 11) for the analytics tools.
 *
 * A device-bound preconfigured run carries `auth.allowedDeviceIds`; a
 * device-LESS analysis run carries that allowlist with NO `allowedSiteIds` at
 * all. Narrowing written `if (auth.allowedSiteIds && …)` silently no-ops for
 * that second shape, which is what these tests pin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { registerAnalyticsTools } from './aiToolsAnalytics';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
const dialect = new PgDialect();

function renderWhere(cond: unknown): { sql: string; params: unknown[] } {
  if (!cond) return { sql: '', params: [] };
  const q = dialect.sqlToQuery(cond as any);
  return { sql: q.sql, params: q.params as unknown[] };
}

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerAnalyticsTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(opts: { allowedDeviceIds?: string[]; allowedSiteIds?: string[] }): AuthContext {
  const { allowedDeviceIds, allowedSiteIds } = opts;
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedDeviceIds,
    allowedSiteIds,
    canAccessSite: allowedSiteIds
      ? (s: string | null | undefined) => !!s && allowedSiteIds.includes(s)
      : undefined,
  } as unknown as AuthContext;
}

function isDeviceResolverSelect(cols: unknown): boolean {
  return (
    !!cols && typeof cols === 'object' &&
    'id' in (cols as object) && 'siteId' in (cols as object) &&
    Object.keys(cols as object).length === 2
  );
}

/** Capture the WHERE of the capacity_predictions scan; return no rows so the
 *  rollup fallback runs and its WHERE is captured too. */
function mockCapacityScans(orgDevices: Array<{ id: string; siteId: string }>) {
  const captured: { predictions?: unknown; rollups?: unknown } = {};
  mockDb.select.mockImplementation((cols?: unknown) => {
    if (isDeviceResolverSelect(cols)) {
      return { from: () => ({ where: () => Promise.resolve(orgDevices) }) };
    }
    if (cols && typeof cols === 'object' && 'timestamp' in (cols as object)) {
      return {
        from: () => ({
          where: (c: unknown) => {
            captured.rollups = c;
            return { groupBy: () => ({ orderBy: () => Promise.resolve([]) }) };
          },
        }),
      };
    }
    return {
      from: () => ({
        where: (c: unknown) => {
          captured.predictions = c;
          return { orderBy: () => ({ limit: () => Promise.resolve([]) }) };
        },
      }),
    };
  });
  return captured;
}

describe('query_analytics capacity_predictions — exact-device narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('device-bound caller (site axis present) cannot reach a sibling device at the same site', async () => {
    const captured = mockCapacityScans([
      { id: 'dev-1', siteId: 'site-1' },
      { id: 'dev-2', siteId: 'site-1' },
    ]);

    await handlerFor('query_analytics')(
      { action: 'capacity_predictions' },
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );

    for (const key of ['predictions', 'rollups'] as const) {
      const { params } = renderWhere(captured[key]);
      expect(params, `${key} WHERE params`).toContain('dev-1');
      expect(params, `${key} WHERE params`).not.toContain('dev-2');
    }
  });

  it('device-LESS analysis run (no site axis at all) still cannot reach a sibling device', async () => {
    const captured = mockCapacityScans([]);

    await handlerFor('query_analytics')(
      { action: 'capacity_predictions' },
      makeAuth({ allowedDeviceIds: ['dev-1'] }),
    );

    for (const key of ['predictions', 'rollups'] as const) {
      const { sql, params } = renderWhere(captured[key]);
      expect(sql, `${key} WHERE sql`).toMatch(/device_id/);
      expect(params, `${key} WHERE params`).toContain('dev-1');
    }
  });

  it('device-bound caller still reads its OWN device (no over-blocking)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'dev-1', siteId: 'site-1' }]) }) };
      }
      return {
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'p1', deviceId: 'dev-1', metricType: 'disk' }]) }) }),
        }),
      };
    });

    const r = await handlerFor('query_analytics')(
      { action: 'capacity_predictions' },
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    const parsed = JSON.parse(r);
    expect(parsed.showing).toBe(1);
    expect(parsed.capacityPredictions[0].deviceId).toBe('dev-1');
  });

  it('unrestricted caller gets NO device narrowing (no regression)', async () => {
    const captured = mockCapacityScans([]);

    await handlerFor('query_analytics')({ action: 'capacity_predictions' }, makeAuth({}));

    for (const key of ['predictions', 'rollups'] as const) {
      const { sql } = renderWhere(captured[key]);
      expect(sql, `${key} WHERE sql`).not.toMatch(/device_id/);
    }
  });
});

describe('get_executive_summary — org-wide aggregate is denied to device-scoped runs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses for a device-bound caller without reading the summary', async () => {
    let summaryRead = false;
    mockDb.select.mockImplementation(() => {
      summaryRead = true;
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 's1' }]) }) }) }) };
    });

    const r = await handlerFor('get_executive_summary')({}, makeAuth({ allowedDeviceIds: ['dev-1'] }));
    const parsed = JSON.parse(r);
    expect(parsed.summary).toBeUndefined();
    expect(String(parsed.error)).toMatch(/org/i);
    expect(summaryRead).toBe(false);
  });

  it('refuses for a device-LESS analysis run too', async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 's1' }]) }) }) }),
    }));
    const r = await handlerFor('get_executive_summary')({}, makeAuth({ allowedDeviceIds: ['dev-1'] }));
    expect(JSON.parse(r).error).toBeDefined();
  });

  it('unrestricted caller still gets the summary (no regression)', async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 's1', periodType: 'weekly' }]) }) }) }),
    }));
    const r = await handlerFor('get_executive_summary')({}, makeAuth({}));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.summary.id).toBe('s1');
  });
});
