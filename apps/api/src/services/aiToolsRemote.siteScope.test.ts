import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(),
  queueCommandForExecution: vi.fn(),
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '../db';
import { registerRemoteTools } from './aiToolsRemote';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const dialect = new PgDialect();

/** Render a captured Drizzle SQL `where` clause to text + bound params for assertions. */
function renderWhere(where: unknown): { sql: string; params: unknown[] } {
  if (where == null) return { sql: '', params: [] };
  const q = dialect.sqlToQuery(where as SQL);
  return { sql: q.sql, params: q.params };
}

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerRemoteTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(opts: {
  scope?: AuthContext['scope'];
  allowedSiteIds?: string[];
  orgId?: string | null;
} = {}): AuthContext {
  const { scope = 'organization', allowedSiteIds, orgId = 'org-1' } = opts;
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId,
    scope,
    accessibleOrgIds: orgId ? [orgId] : null,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as AuthContext;
}

/**
 * The list query is `.select(cols).from(remoteSessions).innerJoin(...).where(...)
 * .orderBy(...).limit(...)`. We capture the `where` argument so we can assert which
 * filters were applied, and separately stub the device-resolution `.select({id,siteId})
 * .from().where()` call used by resolveSiteAllowedDeviceIds.
 */
function mockListDb(opts: {
  orgDevices?: { id: string; siteId: string | null }[];
  sessions?: unknown[];
}) {
  const { orgDevices = [], sessions = [] } = opts;
  let capturedWhere: unknown;
  let sessionsRead = false;
  mockDb.select.mockImplementation((cols?: unknown) => {
    // resolveSiteAllowedDeviceIds: .select({ id, siteId }).from(devices).where(...)
    if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object)) {
      return { from: () => ({ where: () => Promise.resolve(orgDevices) }) };
    }
    // The list query.
    return {
      from: () => ({
        innerJoin: () => ({
          where: (w: unknown) => {
            capturedWhere = w;
            sessionsRead = true;
            return {
              orderBy: () => ({ limit: () => Promise.resolve(sessions) }),
            };
          },
        }),
      }),
    };
  });
  return {
    get where() {
      return capturedWhere;
    },
    get sessionsRead() {
      return sessionsRead;
    },
  };
}

describe('list_remote_sessions — site narrowing (list)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns sessions only for in-scope devices for a site-restricted caller', async () => {
    const probe = mockListDb({
      orgDevices: [
        { id: 'd-allowed', siteId: 'site-A' },
        { id: 'd-forbidden', siteId: 'site-B' },
      ],
      sessions: [{ id: 's1', deviceHostname: 'host-a', type: 'terminal', status: 'active' }],
    });
    const r = await handlerFor('list_remote_sessions')({}, makeAuth({ allowedSiteIds: ['site-A'] }));
    const parsed = JSON.parse(r);
    expect(parsed.total).toBe(1);
    expect(probe.sessionsRead).toBe(true);
    // The inArray filter must have been built against ONLY the in-scope device id.
    const { params } = renderWhere(probe.where);
    expect(params).toContain('d-allowed');
    expect(params).not.toContain('d-forbidden');
  });

  it('returns empty (no DB session read) when a site-restricted caller has zero in-scope devices', async () => {
    const probe = mockListDb({
      orgDevices: [{ id: 'd-forbidden', siteId: 'site-FORBIDDEN' }],
      sessions: [{ id: 's1' }],
    });
    const r = await handlerFor('list_remote_sessions')({}, makeAuth({ allowedSiteIds: ['site-A'] }));
    const parsed = JSON.parse(r);
    expect(parsed.total).toBe(0);
    expect(parsed.sessions).toEqual([]);
    expect(probe.sessionsRead).toBe(false);
  });

  it('fails closed to empty when a site-restricted caller has no orgId', async () => {
    const probe = mockListDb({ orgDevices: [{ id: 'd1', siteId: 'site-A' }], sessions: [{ id: 's1' }] });
    const r = await handlerFor('list_remote_sessions')({}, makeAuth({ allowedSiteIds: ['site-A'], orgId: null }));
    const parsed = JSON.parse(r);
    expect(parsed.total).toBe(0);
    expect(parsed.sessions).toEqual([]);
    expect(probe.sessionsRead).toBe(false);
  });
});

describe('list_remote_sessions — per-user ownership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('non-system caller filters to their own userId', async () => {
    const probe = mockListDb({ sessions: [{ id: 's1' }] });
    await handlerFor('list_remote_sessions')({}, makeAuth({ scope: 'organization' }));
    // The userId equality filter against the caller (u1) must be present.
    expect(renderWhere(probe.where).params).toContain('u1');
  });

  it('system caller does NOT add a userId filter or site narrowing', async () => {
    let resolveSiteCalled = false;
    let captured: unknown;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object)) {
        resolveSiteCalled = true;
        return { from: () => ({ where: () => Promise.resolve([]) }) };
      }
      return {
        from: () => ({
          innerJoin: () => ({
            where: (w: unknown) => {
              captured = w;
              return { orderBy: () => ({ limit: () => Promise.resolve([{ id: 's1' }]) }) };
            },
          }),
        }),
      };
    });
    const r = await handlerFor('list_remote_sessions')({}, makeAuth({ scope: 'system', allowedSiteIds: undefined }));
    const parsed = JSON.parse(r);
    expect(parsed.total).toBe(1);
    expect(resolveSiteCalled).toBe(false);
    // No userId filter for system scope.
    expect(renderWhere(captured).params).not.toContain('u1');
  });
});
