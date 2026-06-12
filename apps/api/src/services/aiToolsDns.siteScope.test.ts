import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('../jobs/dnsSyncJob', () => ({ schedulePolicySync: vi.fn() }));

import { db } from '../db';
import { registerDnsTools } from './aiToolsDns';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerDnsTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}
function isDeviceResolverSelect(cols: unknown): boolean {
  return (
    !!cols && typeof cols === 'object' &&
    'id' in (cols as object) && 'siteId' in (cols as object) &&
    Object.keys(cols as object).length === 2
  );
}
/** Generic chainable query mock that resolves to `result`. */
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset']) {
    p[m] = () => p;
  }
  return p;
}

// 1-day window keeps the handler on the raw-events path (no aggregation).
const RAW_RANGE = { timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' } };

describe('get_dns_security — site narrowing (cross-site enumeration)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive DNS stats/hostnames for a device in a forbidden site', async () => {
    let eventScanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      eventScanRan = true;
      if (cols && typeof cols === 'object' && 'hostname' in (cols as object)) {
        return chain([{ deviceId: 'd-siteB', hostname: 'forbidden-host', blockedCount: 9 }]);
      }
      if (cols && typeof cols === 'object' && 'totalQueries' in (cols as object)) {
        return chain([{ totalQueries: 9, blockedQueries: 9, allowedQueries: 0, redirectedQueries: 0 }]);
      }
      return chain([{ domain: 'secret-blocked-domain.example', category: 'malware', count: 9 }]);
    });

    const r = await handlerFor('get_dns_security')(RAW_RANGE, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.summary.totalQueries).toBe(0);
    expect(parsed.topDevices).toEqual([]);
    expect(parsed.topBlockedDomains).toEqual([]);
    expect(eventScanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('forbidden-host');
    expect(JSON.stringify(parsed)).not.toContain('secret-blocked-domain.example');
  });

  it('unrestricted caller reads DNS security stats normally (no regression)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'totalQueries' in (cols as object)) {
        return chain([{ totalQueries: 10, blockedQueries: 4, allowedQueries: 6, redirectedQueries: 0 }]);
      }
      if (cols && typeof cols === 'object' && 'hostname' in (cols as object)) {
        return chain([{ deviceId: 'd1', hostname: 'h1', blockedCount: 4 }]);
      }
      if (cols && typeof cols === 'object' && 'domain' in (cols as object)) {
        return chain([{ domain: 'bad.example', category: 'malware', count: 4 }]);
      }
      return chain([{ category: 'malware', count: 4 }]);
    });

    const r = await handlerFor('get_dns_security')(RAW_RANGE, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.summary.totalQueries).toBe(10);
    expect(parsed.topDevices).toHaveLength(1);
    expect(parsed.source).toBe('raw');
  });
});
