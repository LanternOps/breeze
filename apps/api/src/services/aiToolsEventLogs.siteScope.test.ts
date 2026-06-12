import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

// Wrap drizzle's `inArray` with a spy that still delegates to the real impl, so
// the non-empty narrowing tests can prove the site filter targets the correct
// column (deviceEventLogs.deviceId) with the correct in-scope ids. The
// empty-set short-circuit tests above never exercise this — a mis-wired column
// or id list would otherwise pass green.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, inArray: vi.fn(actual.inArray) };
});

import { db } from '../db';
import { inArray } from 'drizzle-orm';
import { deviceEventLogs } from '../db/schema';
import { registerEventLogTools } from './aiToolsEventLogs';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
const inArraySpy = vi.mocked(inArray);

/** The inArray call (if any) that constrains deviceEventLogs.deviceId. */
function deviceIdNarrowingArg(): unknown[] | undefined {
  const call = inArraySpy.mock.calls.find(([col]) => col === deviceEventLogs.deviceId);
  return call?.[1] as unknown[] | undefined;
}

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerEventLogTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    // org-scoped condition returns undefined (no SQL) like the real org owner path
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}

/**
 * `resolveSiteAllowedDeviceIds` issues a `select({ id, siteId }).from(devices).where(...)`.
 * Detect that shape so the device-set resolver returns a device that lives in a
 * FORBIDDEN site for a [site-A]-restricted caller (→ empty allowed set).
 */
function isDeviceResolverSelect(cols: unknown): boolean {
  return (
    !!cols &&
    typeof cols === 'object' &&
    'id' in (cols as object) &&
    'siteId' in (cols as object) &&
    Object.keys(cols as object).length === 2
  );
}

describe('search_logs — site narrowing (cross-site enumeration)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive logs from a device in a forbidden site', async () => {
    // The only device in the org lives in site-B; the caller may only access
    // site-A. The data layer is wired to return a site-B log row if asked — the
    // fix must short-circuit so that row never reaches the caller.
    const siteBLogRow = {
      log: {
        id: 'leak',
        timestamp: new Date('2026-01-01T01:00:00Z'),
        level: 'error',
        category: 'system',
        source: 'svc',
        eventId: '1',
        message: 'SECRET cross-site message body',
        deviceId: 'd-siteB',
      },
      device: { id: 'd-siteB', hostname: 'forbidden-host', displayName: 'F', siteId: 'site-B' },
      site: { id: 'site-B', name: 'B' },
    };
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      if (cols && typeof cols === 'object' && 'count' in (cols as object)) {
        return { from: () => ({ leftJoin: () => ({ where: () => Promise.resolve([{ count: 1 }]) }) }) };
      }
      const limitResult: any = Promise.resolve([siteBLogRow]);
      limitResult.offset = () => Promise.resolve([siteBLogRow]);
      return {
        from: () => ({
          leftJoin: () => ({
            leftJoin: () => ({
              where: () => ({ orderBy: () => ({ limit: () => limitResult }) }),
            }),
          }),
        }),
      };
    });

    const r = await handlerFor('search_logs')(
      { timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' }, countMode: 'none' },
      makeAuth(['site-A']),
    );
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.showing).toBe(0);
    expect(parsed.logs).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain('SECRET cross-site message body');
  });

  it('unrestricted caller enumerates normally (no regression)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'count' in (cols as object)) {
        return {
          from: () => ({ leftJoin: () => ({ where: () => Promise.resolve([{ count: 1 }]) }) }),
        };
      }
      // rows query
      const rowsQuery: any = {
        offset: () =>
          Promise.resolve([
            {
              log: {
                id: 'l1',
                timestamp: new Date('2026-01-01T01:00:00Z'),
                level: 'error',
                category: 'system',
                source: 'svc',
                eventId: '1',
                message: 'boom',
                deviceId: 'd1',
              },
              device: { id: 'd1', hostname: 'h1', displayName: 'H1', siteId: 'site-Z' },
              site: { id: 'site-Z', name: 'Z' },
            },
          ]),
      };
      // limit() returns a thenable that also has .offset()
      const limitResult: any = Promise.resolve([
        {
          log: {
            id: 'l1',
            timestamp: new Date('2026-01-01T01:00:00Z'),
            level: 'error',
            category: 'system',
            source: 'svc',
            eventId: '1',
            message: 'boom',
            deviceId: 'd1',
          },
          device: { id: 'd1', hostname: 'h1', displayName: 'H1', siteId: 'site-Z' },
          site: { id: 'site-Z', name: 'Z' },
        },
      ]);
      limitResult.offset = rowsQuery.offset;
      return {
        from: () => ({
          leftJoin: () => ({
            leftJoin: () => ({
              where: () => ({ orderBy: () => ({ limit: () => limitResult }) }),
            }),
          }),
        }),
      };
    });

    const r = await handlerFor('search_logs')(
      { timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' }, countMode: 'none' },
      makeAuth(undefined),
    );
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.showing).toBe(1);
  });

  it('constrains the query to the in-scope device id(s) (non-empty narrowing wired correctly)', async () => {
    // Org has d-A (site-A, allowed) and d-B (site-B, forbidden) → allowed = [d-A].
    // The query must carry inArray(deviceEventLogs.deviceId, ['d-A']) — not d-B,
    // not the wrong column. (Empty-set tests can't catch a mis-wired inArray.)
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return {
          from: () => ({
            where: () =>
              Promise.resolve([
                { id: 'd-A', siteId: 'site-A' },
                { id: 'd-B', siteId: 'site-B' },
              ]),
          }),
        };
      }
      if (cols && typeof cols === 'object' && 'count' in (cols as object)) {
        return { from: () => ({ leftJoin: () => ({ where: () => Promise.resolve([{ count: 0 }]) }) }) };
      }
      const limitResult: any = Promise.resolve([]);
      limitResult.offset = () => Promise.resolve([]);
      return {
        from: () => ({
          leftJoin: () => ({
            leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => limitResult }) }) }),
          }),
        }),
      };
    });

    const r = await handlerFor('search_logs')(
      { timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' }, countMode: 'none' },
      makeAuth(['site-A']),
    );
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();

    const narrowed = deviceIdNarrowingArg();
    expect(narrowed, 'expected inArray(deviceEventLogs.deviceId, [...]) to be applied').toBeTruthy();
    expect(narrowed).toEqual(['d-A']);
    expect(narrowed).not.toContain('d-B');
  });
});

describe('get_log_trends — site narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive trend rows for a device in a forbidden site', async () => {
    // Data layer is wired to expose a site-B device's error counts. The fix must
    // short-circuit (caller only has access to site-A) so nothing leaks.
    const forbiddenTopDevice = {
      deviceId: 'd-siteB',
      hostname: 'forbidden-host',
      count: 99,
      errorCount: 50,
      criticalCount: 9,
    };
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      return {
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              groupBy: () => ({
                orderBy: () => {
                  const r: any = Promise.resolve([forbiddenTopDevice]);
                  r.limit = () => Promise.resolve([forbiddenTopDevice]);
                  return r;
                },
              }),
            }),
          }),
        }),
      };
    });

    const r = await handlerFor('get_log_trends')(
      { timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' } },
      makeAuth(['site-A']),
    );
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.trends.topDevices).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain('forbidden-host');
  });

  it('unrestricted caller reads trends normally (no regression)', async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            groupBy: () => ({
              orderBy: () => {
                const r: any = Promise.resolve([]);
                r.limit = () => Promise.resolve([]);
                return r;
              },
            }),
          }),
        }),
      }),
    }));
    const r = await handlerFor('get_log_trends')(
      { timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' } },
      makeAuth(undefined),
    );
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.trends).toBeDefined();
  });

  it('constrains trend queries to the in-scope device id(s) (non-empty narrowing wired correctly)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return {
          from: () => ({
            where: () =>
              Promise.resolve([
                { id: 'd-A', siteId: 'site-A' },
                { id: 'd-B', siteId: 'site-B' },
              ]),
          }),
        };
      }
      return {
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              groupBy: () => ({
                orderBy: () => {
                  const r: any = Promise.resolve([]);
                  r.limit = () => Promise.resolve([]);
                  return r;
                },
              }),
            }),
          }),
        }),
      };
    });

    const r = await handlerFor('get_log_trends')(
      { timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' } },
      makeAuth(['site-A']),
    );
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();

    const narrowed = deviceIdNarrowingArg();
    expect(narrowed, 'expected inArray(deviceEventLogs.deviceId, [...]) to be applied').toBeTruthy();
    expect(narrowed).toEqual(['d-A']);
    expect(narrowed).not.toContain('d-B');
  });
});

describe('detect_log_correlations — site narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller with no in-scope devices detects no correlation without scanning event logs', async () => {
    let eventLogScanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      eventLogScanRan = true;
      return {
        from: () => ({
          where: () => ({
            groupBy: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }),
            orderBy: () => ({ limit: () => Promise.resolve([]) }),
          }),
          leftJoin: () => ({ where: () => ({ groupBy: () => ({ orderBy: () => Promise.resolve([]) }) }) }),
        }),
      };
    });

    const r = await handlerFor('detect_log_correlations')(
      { pattern: 'kernel panic' },
      makeAuth(['site-A']),
    );
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.detected).toBe(false);
    // The empty-allowed-set short-circuit means we never touch deviceEventLogs.
    expect(eventLogScanRan).toBe(false);
  });

  it('unrestricted caller runs correlation detection normally (no regression)', async () => {
    let eventLogScanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-Z' }]) }) };
      }
      eventLogScanRan = true;
      // summary / sample selects: .from().where()[.orderBy().limit()]
      // affected-device select: .from().leftJoin().where().groupBy().orderBy()
      return {
        from: () => ({
          where: () => {
            const base: any = Promise.resolve([{ firstSeen: null, lastSeen: null, occurrences: 0 }]);
            base.orderBy = () => ({ limit: () => Promise.resolve([]) });
            base.groupBy = () => ({ orderBy: () => Promise.resolve([]) });
            return base;
          },
          leftJoin: () => ({ where: () => ({ groupBy: () => ({ orderBy: () => Promise.resolve([]) }) }) }),
        }),
      };
    });
    const r = await handlerFor('detect_log_correlations')(
      { pattern: 'kernel panic' },
      makeAuth(undefined),
    );
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    // Unrestricted caller: resolver NOT consulted (allowedSiteIds undefined),
    // correlation scan runs and finds nothing (0 occurrences).
    expect(parsed.detected).toBe(false);
    expect(eventLogScanRan).toBe(true);
  });
});
