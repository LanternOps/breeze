/**
 * Exact-device + org axis (#6086 finding 12) for `get_script_details`'s
 * execution-stats aggregate. The stats query keyed only on `scriptId`, so a
 * device-bound run (and any cross-org caller) aggregated executions from every
 * device that ever ran the script.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { scriptExecutions } from '../db/schema';
import { registerScriptTools } from './aiToolsScripts';
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
  registerScriptTools(reg as any);
  return reg.get(name)!.handler;
}

function makeAuth(opts: { allowedDeviceIds?: string[]; allowedSiteIds?: string[] }): AuthContext {
  const { allowedDeviceIds, allowedSiteIds } = opts;
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: (col: any) => eq(col, 'org-1'),
    canAccessOrg: () => true,
    allowedDeviceIds,
    allowedSiteIds,
    canAccessSite: allowedSiteIds
      ? (s: string | null | undefined) => !!s && allowedSiteIds.includes(s)
      : undefined,
  } as unknown as AuthContext;
}

/** script lookup → one row; stats aggregate → capture its WHERE. */
function mockScriptDetails() {
  const captured: { stats?: unknown } = {};
  mockDb.select.mockImplementation((cols?: unknown) => {
    if (cols && typeof cols === 'object' && 'totalExecutions' in (cols as object)) {
      return {
        from: () => ({
          where: (c: unknown) => {
            captured.stats = c;
            return Promise.resolve([{ totalExecutions: 7 }]);
          },
        }),
      };
    }
    return {
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ id: 'script-1', name: 'S', orgId: 'org-1' }]) }),
      }),
    };
  });
  return captured;
}

describe('get_script_details includeExecutionStats — org + exact-device narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('device-bound caller (site axis present) aggregates only its own device', async () => {
    const captured = mockScriptDetails();
    await handlerFor('get_script_details')(
      { scriptId: 'script-1', includeExecutionStats: true },
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    const { sql, params } = renderWhere(captured.stats);
    expect(sql).toMatch(/device_id/);
    expect(params).toContain('dev-1');
    expect(params).not.toContain('dev-2');
    expect(params).toContain('org-1');
  });

  it('device-LESS analysis run (no site axis at all) is narrowed too', async () => {
    const captured = mockScriptDetails();
    await handlerFor('get_script_details')(
      { scriptId: 'script-1', includeExecutionStats: true },
      makeAuth({ allowedDeviceIds: ['dev-1'] }),
    );
    const { sql, params } = renderWhere(captured.stats);
    expect(sql).toMatch(/device_id/);
    expect(params).toContain('dev-1');
  });

  it('device-bound caller still gets its own stats back (no over-blocking)', async () => {
    mockScriptDetails();
    const r = await handlerFor('get_script_details')(
      { scriptId: 'script-1', includeExecutionStats: true },
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    expect(JSON.parse(r).executionStats).toEqual({ totalExecutions: 7 });
  });

  it('unrestricted caller gets org scoping but NO device narrowing (no regression)', async () => {
    const captured = mockScriptDetails();
    const r = await handlerFor('get_script_details')(
      { scriptId: 'script-1', includeExecutionStats: true },
      makeAuth({}),
    );
    const { sql, params } = renderWhere(captured.stats);
    expect(sql).not.toMatch(/device_id/);
    expect(params).toContain('org-1');
    expect(JSON.parse(r).executionStats).toEqual({ totalExecutions: 7 });
  });
});
