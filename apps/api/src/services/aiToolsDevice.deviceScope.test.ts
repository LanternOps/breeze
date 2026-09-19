/**
 * Exact-device axis (#6086 finding 13b) for `manage_tags` (list).
 *
 * Tag enumeration was narrowed only under `if (auth.allowedSiteIds && …)`, so a
 * device-LESS analysis run enumerated the tag vocabulary of the whole org.
 * `query_devices` in the same file already applies the frozen-device narrowing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
}));
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(), getAllDeviceContext: vi.fn(),
  createDeviceContext: vi.fn(), resolveDeviceContext: vi.fn(),
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { registerDeviceTools } from './aiToolsDevice';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
};
const dialect = new PgDialect();

function renderSql(frag: unknown): { sql: string; params: unknown[] } {
  if (!frag) return { sql: '', params: [] };
  const q = dialect.sqlToQuery(frag as any);
  return { sql: q.sql, params: q.params as unknown[] };
}

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerDeviceTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(opts: { allowedDeviceIds?: string[]; allowedSiteIds?: string[] }): AuthContext {
  const { allowedDeviceIds, allowedSiteIds } = opts;
  return {
    principal: { kind: 'user_session' },
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

function mockTagList(orgDevices: Array<{ id: string; siteId: string }>) {
  mockDb.select.mockImplementation((cols?: unknown) => {
    if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object)
      && Object.keys(cols as object).length === 2) {
      return { from: () => ({ where: () => Promise.resolve(orgDevices) }) };
    }
    return { from: () => ({ where: () => Promise.resolve([]) }) };
  });
  mockDb.execute.mockResolvedValue([{ tag: 'finance' }]);
}

describe('manage_tags list — exact-device narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('device-bound caller (site axis present) does not enumerate a sibling device at the same site', async () => {
    mockTagList([{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-1' }]);
    await handlerFor('manage_tags')({ action: 'list' }, makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }));
    const { params } = renderSql(mockDb.execute.mock.calls[0]?.[0]);
    expect(params).toContain('dev-1');
    expect(params).not.toContain('dev-2');
  });

  it('device-LESS analysis run (no site axis at all) is narrowed to its frozen device set', async () => {
    mockTagList([]);
    await handlerFor('manage_tags')({ action: 'list' }, makeAuth({ allowedDeviceIds: ['dev-1'] }));
    const { sql, params } = renderSql(mockDb.execute.mock.calls[0]?.[0]);
    expect(sql).toMatch(/"id" in/i);
    expect(params).toContain('dev-1');
  });

  it('device-bound caller still gets its own tags back (no over-blocking)', async () => {
    mockTagList([{ id: 'dev-1', siteId: 'site-1' }]);
    const r = await handlerFor('manage_tags')({ action: 'list' }, makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }));
    expect(JSON.parse(r).tags).toEqual(['finance']);
  });

  it('unrestricted caller enumerates with NO device narrowing (no regression)', async () => {
    mockTagList([]);
    const r = await handlerFor('manage_tags')({ action: 'list' }, makeAuth({}));
    const { sql } = renderSql(mockDb.execute.mock.calls[0]?.[0]);
    expect(sql).not.toMatch(/"id" in/i);
    expect(JSON.parse(r).tags).toEqual(['finance']);
  });
});
